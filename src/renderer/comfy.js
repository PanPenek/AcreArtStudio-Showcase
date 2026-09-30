/**
 * comfy.js: local image and video generation through a ComfyUI server.
 *
 * The second generation engine, with the same contract as the Perchance driver:
 * `generate(prompt, opts, log)` returns `{ images: [{ base64, mime, w, h }] }`, so
 * everything downstream does not care which engine made the pixels.
 *
 * The key idea: THE WORKFLOW FILE IS THE CONFIG. Any ComfyUI graph can be used.
 * On every job the driver re-reads the file and works out what to touch: it traces
 * the prompt nodes back from the sampler, randomises the seed per image, and
 * collects whatever the save nodes produce. Both of ComfyUI's file formats (API and
 * editor, including subgraphs) are supported. If the server is not running, the
 * driver starts it from Settings and waits for it.
 */
(() => {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randSeed = () => Math.floor(Math.random() * 0xffffffff);
  const MAX_PER_PROMPT = 12;
  const perPrompt = (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 1 ? Math.min(n, MAX_PER_PROMPT) : 1;
  };

  /** Balanced-brace JSON object extractor — LLMs wrap their answers in prose. */
  function extractJson(text) {
    if (!text || typeof text !== 'string') return null;
    const start = text.indexOf('{');
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
        }
      }
    }
    return null;
  }

  /** Image dimensions from base64 header bytes (PNG IHDR / JPEG SOF). */
  function sniffSize(base64, mime) {
    try {
      const bin = atob(String(base64 || '').slice(0, 349528));
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const rd16 = (o) => (u8[o] << 8) | u8[o + 1];
      const rd32 = (o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
      if (mime && mime.includes('jpeg') && u8[0] === 0xFF && u8[1] === 0xD8) {
        let i = 2;
        while (i + 9 < u8.length) {
          if (u8[i] !== 0xFF) { i++; continue; }
          const m = u8[i + 1];
          if (m === 0xFF) { i++; continue; }
          if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
          if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
            return { w: rd16(i + 7), h: rd16(i + 5) };
          }
          i += 2 + rd16(i + 2);
        }
      }
      if (u8.length > 24 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) {
        return { w: rd32(16), h: rd32(20) };
      }
    } catch { }
    return { w: 0, h: 0 };
  }

  /** "The engine is not there", as distinct from "the engine refused this job". */
  function engineDown(message) {
    const e = new Error(message);
    e.engineDown = true;
    return e;
  }

  /** The options of a DynamicCombo input (`COMFY_DYNAMICCOMBO_V3`), or null for a plain input. */
  function dynamicCombo(config) {
    if (!Array.isArray(config)) return null;
    const meta = config[1];
    if (!meta || !Array.isArray(meta.options)) return null;
    if (typeof config[0] === 'string' && !/DYNAMICCOMBO/i.test(config[0])) return null;
    if (typeof config[0] !== 'string') return null;
    return meta.options;
  }

  /** A DynamicCombo's option keys — the only values its own widget can hold. */
  const comboKeys = (config) => {
    const options = dynamicCombo(config);
    return options ? options.map((o) => o && o.key).filter((k) => typeof k === 'string') : null;
  };

  /** Every input id a node class declares, dynamic sub-inputs flattened to `<parent>.<child>`. */
  function inputIds(def) {
    const ids = [];
    const addMap = (map, prefix) => {
      for (const [name, cfg] of Object.entries(map || {})) {
        const id = `${prefix}${name}`;
        if (ids.includes(id)) continue;
        ids.push(id);
        const options = dynamicCombo(cfg);
        if (!options) continue;
        for (const opt of options) {
          const sub = (opt && opt.inputs) || {};
          addMap(sub.required, `${id}.`);
          addMap(sub.optional, `${id}.`);
        }
      }
    };
    const d = def && def.input;
    addMap(d && d.required, '');
    addMap(d && d.optional, '');
    return ids;
  }

  /**
   * Declared config for an input id, resolving `<parent>.<child>` through the parent DynamicCombo's
   * selected option when the chosen value is known (png and exr both declare `bit_depth`, with
   * different option lists), else…
   */
  function inputConfig(def, name, chosen = {}) {
    const maps = [def && def.input && def.input.required, def && def.input && def.input.optional];
    const dot = name.lastIndexOf('.');
    if (dot < 0) {
      for (const m of maps) if (m && m[name]) return m[name];
      return null;
    }
    const parent = name.slice(0, dot), child = name.slice(dot + 1);
    let parentCfg = null;
    for (const m of maps) if (m && m[parent]) { parentCfg = m[parent]; break; }
    const childOf = (opt) => {
      const sub = (opt && opt.inputs) || {};
      return (sub.required && sub.required[child]) || (sub.optional && sub.optional[child]) || null;
    };
    const options = dynamicCombo(parentCfg);
    if (!options) return null;
    const byKey = options.find((o) => o && o.key === chosen[parent]);
    if (byKey && childOf(byKey)) return childOf(byKey);
    for (const o of options) { const c = childOf(o); if (c) return c; }
    return null;
  }

  /** Can this widget value be placed on an input declared by this config? */
  function acceptsValue(val, config) {
    const keys = comboKeys(config);
    if (keys) return typeof val === 'string' && keys.includes(val);
    const conf = Array.isArray(config) ? config[0] : config;
    if (typeof val === 'number') return conf === 'INT' || conf === 'FLOAT' || conf === 'NUMBER';
    if (typeof val === 'boolean') return conf === 'BOOLEAN';
    if (typeof val === 'string') {
      if (Array.isArray(conf)) return conf.includes(val);
      return conf === 'STRING' || conf === 'COMBO';
    }
    return false;
  }

  /** Widget-backed inputs of an editor-format node, as name → value. */
  function widgetInputs(n, def, already = {}) {
    const out = {};
    const named = n.widgets_values_named;
    if (named && typeof named === 'object' && !Array.isArray(named)) {
      const chosen = Object.assign({}, already, named);
      for (const [k, v] of Object.entries(named)) {
        if (v === null || v === undefined) continue;
        if (already[k] !== undefined || out[k] !== undefined) continue;
        if (!inputConfig(def, k, chosen)) continue;
        out[k] = v;
      }
      return out;
    }
    const ordered = inputIds(def);
    const wv = (Array.isArray(n.widgets_values) ? n.widgets_values : []).slice();
    const CONTROL = /^(randomize|fixed|increment|decrement)$/;
    for (const val of wv) {
      if (typeof val === 'string' && CONTROL.test(val)) continue;
      for (const name of ordered) {
        if (already[name] !== undefined || out[name] !== undefined) continue;
        const config = inputConfig(def, name, Object.assign({}, already, out));
        if (!config) continue;
        if (acceptsValue(val, config)) { out[name] = val; break; }
      }
    }
    return out;
  }

  /** Inline subgraph instances into a flat class_type graph. */
  function expandSubgraphs(raw, defs) {
    const subs = {};
    for (const s of (raw.definitions && raw.definitions.subgraphs) || []) subs[s.id] = s;
    if (!Object.keys(subs).length) return raw;
    const kept = (n) => !!n && n.mode !== 2 && n.mode !== 4 && !!defs[n.type];
    const rootById = {};
    for (const n of raw.nodes) rootById[String(n.id)] = n;
    const linksById = {};
    for (const l of raw.links || []) linksById[l[0]] = l;
    const out = {};
    const wires = {};
    const wire = (toId, name, from) => { if (toId && name) wires[`${toId}\u0000${name}`] = from; };
    const inputNameAt = (node, slot) => {
      const e = (node.inputs || [])[slot];
      return e ? e.name : null;
    };

    for (const n of raw.nodes) {
      const sub = subs[n.type];
      if (sub) {
        for (const inner of sub.nodes) {
          if (!kept(inner)) continue;
          out[`${n.id}:${inner.id}`] = { class_type: inner.type, inputs: widgetInputs(inner, defs[inner.type]) };
        }
      } else if (kept(n)) {
        out[String(n.id)] = { class_type: n.type, inputs: widgetInputs(n, defs[n.type]) };
      }
    }

    for (const l of raw.links || []) {
      const to = rootById[String(l[3])];
      const from = rootById[String(l[1])];
      if (!to || !from || subs[to.type] || subs[from.type]) continue;
      wire(String(l[3]), inputNameAt(to, l[4]), [String(l[1]), l[2]]);
    }

    for (const n of raw.nodes) {
      const sub = subs[n.type];
      if (!sub) continue;
      const iid = String(n.id);
      const innerById = {};
      for (const inner of sub.nodes) innerById[inner.id] = inner;
      for (const l of sub.links || []) {
        const target = innerById[l.target_id];
        if (l.origin_id >= 0 && l.target_id >= 0) {
          if (out[`${iid}:${l.target_id}`]) wire(`${iid}:${l.target_id}`, inputNameAt(target, l.target_slot), [`${iid}:${l.origin_id}`, l.origin_slot]);
          continue;
        }
        if (l.origin_id === -10) {
          const si = (sub.inputs || [])[l.origin_slot];
          if (!si || !target || !out[`${iid}:${l.target_id}`]) continue;
          const entry = (target.inputs || [])[l.target_slot] || {};
          const ext = (n.inputs || []).find((i) => i.name === si.name);
          const extLink = ext && ext.link != null ? linksById[ext.link] : null;
          if (extLink) {
            wire(`${iid}:${l.target_id}`, entry.name, [String(extLink[1]), extLink[2]]);
          } else {
            const wname = (entry.widget || {}).name;
            const wv = n.widgets_values_named || {};
            const val = (si.name in wv) ? wv[si.name] : (wname && wname in wv ? wv[wname] : undefined);
            if (wname && val !== undefined) out[`${iid}:${l.target_id}`].inputs[wname] = val;
          }
          continue;
        }
        if (l.target_id === -20) {
          for (const rl of raw.links || []) {
            if (String(rl[1]) !== iid || rl[2] !== l.target_slot) continue;
            const to = rootById[String(rl[3])];
            if (!to) continue;
            wire(String(rl[3]), inputNameAt(to, rl[4]), [`${iid}:${l.origin_id}`, l.origin_slot]);
          }
        }
      }
    }

    for (const [id, node] of Object.entries(out)) {
      const prefix = id + '\u0000';
      for (const [k, from] of Object.entries(wires)) {
        if (k.startsWith(prefix)) node.inputs[k.slice(prefix.length)] = from;
      }
    }
    return out;
  }

  /**
   * Normalize a ComfyUI workflow file into an internal shape: `{ nodes: { id: { classType, inputs,
   * widgets } }, links: { id: [fromId, fromSlot] } }` where every `inputs[name]` is either
   * `[nodeId, slot]` (a wire) or a…
   */
  function normalizeWorkflow(raw, defs = null) {
    if (!raw || typeof raw !== 'object') throw new Error('workflow file is not a JSON object');
    if (Array.isArray(raw)) throw new Error('unexpected workflow shape (array)');

    const looksApi = Object.values(raw).every((v) => v && typeof v === 'object' && v.class_type);
    if (looksApi) {
      const nodes = {};
      for (const [id, n] of Object.entries(raw)) {
        nodes[id] = { classType: n.class_type, inputs: Object.assign({}, n.inputs || {}) };
      }
      return { nodes, links: {} };
    }

    if (!Array.isArray(raw.nodes)) throw new Error('not an API- or editor-format workflow');
    const linkMap = {};
    for (const l of raw.links || []) linkMap[l[0]] = [String(l[1]), l[2]];

    const nodes = {};
    const dangling = [];
    for (const n of raw.nodes) {
      if (!n || n.mode === 2 || n.mode === 4) continue;
      const id = String(n.id);
      const wired = {};
      for (const inp of n.inputs || []) {
        if (inp.link == null) continue;
        const src = linkMap[inp.link];
        if (!src) { dangling.push(`${n.type}#${n.id}.${inp.name}`); continue; }
        wired[inp.name] = [src[0], src[1]];
      }
      if (/^(LoadImage|ImageUpload)$/i.test(n.type)) {
        const wv = Array.isArray(n.widgets_values) ? n.widgets_values : [];
        const inputs = { image: wv[0] };
        for (const [k, v] of Object.entries(wired)) if (k !== 'image') inputs[k] = v;
        nodes[id] = { classType: n.type, inputs };
        continue;
      }
      if (defs) {
        const inputs = Object.assign({}, wired);
        const def = defs[n.type];
        if (!def) continue;
        {
          const ordered = inputIds(def);
          const wv = (Array.isArray(n.widgets_values) ? n.widgets_values : []).slice();
          const CONTROL = /^(randomize|fixed|increment|decrement)$/;
          for (const val of wv) {
            if (typeof val === 'string' && CONTROL.test(val)) continue;
            let placed = false;
            for (const name of ordered) {
              if (inputs[name] !== undefined) continue;
              const config = inputConfig(def, name, inputs);
              if (!config) continue;
              if (acceptsValue(val, config)) { inputs[name] = val; placed = true; break; }
            }
            if (!placed) {
            }
          }
        }
        nodes[id] = { classType: n.type, inputs };
      } else {
        nodes[id] = { classType: n.type, inputs: Object.assign({}, wired) };
      }
    }
    return { nodes, links: linkMap, needsDefs: !defs, dangling };
  }

  const isWire = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string';

  const SAMPLER_RE = /^(KSampler|KSamplerAdvanced|S3Sampler|SamplerCustomAdvanced)$/;
  const ENCODE_RE = /CLIPTextEncode/;

  const PROMPT_FIELD_RE = /^(raw_)?(prompt|text)$|^(positive|negative)_prompt$/i;

  /**
   * The text input a node takes its prompt on, when it takes one itself. i2v models
   * (MiniMaxH3ImageToVideo, WanImageToVideo, …) have no CLIPTextEncode at all: the prompt is one of
   * their own widget inputs and CLIP is a…
   */
  function promptFieldOf(node) {
    for (const [k, v] of Object.entries((node && node.inputs) || {})) {
      if (typeof v === 'string' && PROMPT_FIELD_RE.test(k)) return k;
    }
    return null;
  }

  function detectPromptSlots(wf) {
    const samplers = Object.entries(wf.nodes).filter(([, n]) => SAMPLER_RE.test(n.classType));
    if (samplers.length) {
      const s = samplers[0][0];
      const encOf = (name) => {
        const cur = wf.nodes[s].inputs[name];
        if (!isWire(cur)) return null;
        const src = wf.nodes[cur[0]];
        return src && ENCODE_RE.test(src.classType) ? cur[0] : null;
      };
      const positive = encOf('positive');
      const negative = encOf('negative');
      if (positive || negative) return { positive, negative, traced: true };
      const seen = new Set([s]);
      const found = [];
      const queue = Object.keys(wf.nodes[s].inputs)
        .map((k) => wf.nodes[s].inputs[k]).filter(isWire).map((w) => w[0]);
      while (queue.length && found.length < 2) {
        const cur = queue.shift();
        if (seen.has(cur)) continue;
        seen.add(cur);
        const node = wf.nodes[cur];
        if (!node) continue;
        if (ENCODE_RE.test(node.classType)) { found.push(cur); continue; }
        for (const v of Object.values(node.inputs)) {
          if (isWire(v)) queue.push(v[0]);
        }
      }
      if (found.length) return { positive: found[0], negative: found[1] || null, traced: true };
      const pseen = new Set([s]);
      const pqueue = Object.keys(wf.nodes[s].inputs)
        .map((k) => wf.nodes[s].inputs[k]).filter(isWire).map((w) => w[0]);
      while (pqueue.length) {
        const cur = pqueue.shift();
        if (pseen.has(cur)) continue;
        pseen.add(cur);
        const node = wf.nodes[cur];
        if (!node) continue;
        const field = promptFieldOf(node);
        if (field) return { positive: cur, negative: null, field, traced: true };
        for (const v of Object.values(node.inputs)) {
          if (isWire(v)) pqueue.push(v[0]);
        }
      }
    }
    const encs = Object.entries(wf.nodes).filter(([, n]) => ENCODE_RE.test(n.classType)).map(([id]) => id);
    if (!encs.length) {
      for (const [id, n] of Object.entries(wf.nodes)) {
        const field = promptFieldOf(n);
        if (field) return { positive: id, negative: null, field, traced: false };
      }
      return null;
    }
    return { positive: encs[0], negative: encs[1] || null, traced: false };
  }

  /** Where the prompt text actually gets written. */
  function resolvePromptTarget(wf, slots) {
    if (!slots || !slots.positive) return null;
    let cur = slots.positive;
    let field = slots.field || 'text';
    for (let hop = 0; hop < 4; hop++) {
      const node = wf.nodes[cur];
      if (!node) return null;
      const val = node.inputs[field];
      if (typeof val === 'string') return { id: cur, field };
      if (!isWire(val)) return null;
      const src = wf.nodes[val[0]];
      const next = src ? promptFieldOf(src) : null;
      if (!next) return null;
      cur = val[0];
      field = next;
    }
    return null;
  }

  /** The seed field of the first node that has one. */
  function detectSeedSlot(wf) {
    for (const [id, n] of Object.entries(wf.nodes)) {
      if (SAMPLER_RE.test(n.classType) && 'seed' in n.inputs) return { id, field: 'seed' };
    }
    for (const [id, n] of Object.entries(wf.nodes)) {
      if (/^RandomNoise$/i.test(n.classType) && 'noise_seed' in n.inputs) return { id, field: 'noise_seed' };
    }
    return null;
  }

  /** Image-to-video input node: a LoadImage the graph actually consumes. */
  function detectI2vInput(wf) {
    for (const [id, n] of Object.entries(wf.nodes)) {
      if (/^(LoadImage|ImageUpload)$/i.test(n.classType)) return id;
    }
    return null;
  }

  const MIN_VIDEO_SECONDS = 1;
  const MAX_VIDEO_SECONDS = 150;
  function detectDurationSlot(wf) {
    const nodes = wf.nodes || {};
    const floatBehind = (wire, depth) => {
      if (!isWire(wire) || depth > 3) return null;
      const src = nodes[wire[0]];
      if (!src) return null;
      if (/^PrimitiveFloat$/i.test(src.classType) && 'value' in src.inputs) return { id: String(wire[0]), field: 'value' };
      for (const v of Object.values(src.inputs || {})) {
        const hit = floatBehind(v, depth + 1);
        if (hit) return hit;
      }
      return null;
    };
    for (const n of Object.values(nodes)) {
      if (n && n.inputs && isWire(n.inputs.length)) {
        const hit = floatBehind(n.inputs.length, 0);
        if (hit) return hit;
      }
    }
    return null;
  }

  const MAX_REFERENCE_IMAGES = 16;
  const DEFAULT_MAX_REFERENCES = 4;
  const referenceLimit = (cfg) => {
    const n = Math.floor(Number((cfg || {}).maxReferences));
    return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_REFERENCE_IMAGES) : DEFAULT_MAX_REFERENCES;
  };
  const qwenReferenceTarget = (nodes) => Object.entries(nodes || {})
    .find(([, n]) => n && n.classType === 'TextEncodeQwenImage21');

  function clearQwenReferences(nodes, targetId) {
    const target = nodes[targetId];
    const old = [];
    for (const [name, value] of Object.entries(target.inputs || {})) {
      if (!/^images\.image_\d+$/i.test(name)) continue;
      if (isWire(value)) old.push(value[0]);
      delete target.inputs[name];
    }
    for (const sourceId of old) {
      const source = nodes[sourceId];
      if (!source || !/^(LoadImage|ImageUpload)$/i.test(source.classType)) continue;
      const stillUsed = Object.values(nodes).some((n) => Object.values((n && n.inputs) || {})
        .some((v) => isWire(v) && v[0] === sourceId));
      if (!stillUsed) delete nodes[sourceId];
    }
  }

  function injectQwenReferences(nodes, filenames, limit = DEFAULT_MAX_REFERENCES) {
    const found = qwenReferenceTarget(nodes);
    if (!found) return { ok: false, error: 'the selected image workflow has no TextEncodeQwenImage21 reference input' };
    const [targetId, target] = found;
    clearQwenReferences(nodes, targetId);

    if (!isWire(target.inputs.vae)) {
      const vae = Object.entries(nodes).find(([, n]) => n && n.classType === 'VAELoader');
      if (vae) target.inputs.vae = [vae[0], 0];
    }
    if (!isWire(target.inputs.vae)) {
      return { ok: false, error: 'the Qwen reference encoder is not connected to a VAE loader' };
    }

    const wanted = (Array.isArray(filenames) ? filenames : []).map(String).filter(Boolean);
    const capped = Math.max(1, Math.min(Math.floor(Number(limit)) || DEFAULT_MAX_REFERENCES, MAX_REFERENCE_IMAGES));
    const inserted = [];
    wanted.slice(0, capped).forEach((fname, index) => {
      let id = `ala-ref-${index + 1}`;
      while (nodes[id]) id += '-x';
      nodes[id] = { classType: 'LoadImage', inputs: { image: String(fname) } };
      target.inputs[`images.image_${index + 1}`] = [id, 0];
      inserted.push({ id, fname: String(fname), slot: `images.image_${index + 1}` });
    });
    const skipped = wanted.slice(capped);
    return { ok: true, targetId, inserted, skipped, limit: capped };
  }

  class ComfyDriver {
    constructor(settings) { this.settings = settings || {}; }

    /** Re-read live settings each call — the panel writes them, we don't cache. */
    get cfg() {
      const s = (typeof State !== 'undefined' && State.settings) || this.settings;
      return Object.assign({
        serverUrl: 'http://127.0.0.1:8188',
        workflowsDir: '',
        imageWorkflow: '',
        videoWorkflow: '',
        launchCommand: '',
        autoGif: false,
        imagesPerPrompt: 1,
        maxReferences: DEFAULT_MAX_REFERENCES,
      }, s.comfy || {});
    }

    /** All ComfyUI HTTP goes through the main process, not the renderer's own fetch. */
    async http({ url, method = 'GET', json = null, upload = null, timeoutMs = 0 }) {
      return window.ala.comfy.http({ url, method, json, upload, timeoutMs });
    }

    url(p) { return String(this.cfg.serverUrl).replace(/\/+$/, '') + p; }

    async status() {
      try {
        const r = await this.http({ url: this.url('/system_stats'), timeoutMs: 10000 });
        if (!r.ok) return { up: false, error: `HTTP ${r.status}` };
        const j = r.json || {};
        return { up: true, name: (j.system && j.system.name) || 'ComfyUI', version: j.comfyui_version || null };
      } catch (e) {
        return { up: false, error: String(e.message || e).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '') };
      }
    }

    /** Spawn the configured launch command and wait until system_stats answers. */
    async ensureServer({ timeoutMs = 180000, log = () => {} } = {}) {
      const st = await this.status();
      if (st.up) return st;
      const cmd = String(this.cfg.launchCommand || '').trim();
      if (!cmd) throw engineDown(`ComfyUI is not answering at ${this.cfg.serverUrl} and no launch command is set (Settings → Generator)`);
      log(`ComfyUI not answering at ${this.cfg.serverUrl} — starting it: ${cmd}`);
      const started = await window.ala.comfy.startServer(cmd);
      if (!started.ok) throw engineDown('could not start ComfyUI: ' + started.error);
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        await sleep(3000);
        const s2 = await this.status();
        if (s2.up) { log(`ComfyUI is up (${s2.name}).`); return s2; }
      }
      throw engineDown(`ComfyUI did not come up within ${Math.round(timeoutMs / 1000)}s`);
    }

    /** Upload bytes into the server's input/ folder. */
    async uploadImage({ base64, ext = 'png', nameHint = 'ala' }) {
      const fname = `${String(nameHint).replace(/[^a-z0-9._-]/gi, '_').slice(0, 40)}-${Date.now()}.${ext}`;
      const r = await this.http({ url: this.url('/upload/image'), method: 'POST', upload: { base64, ext, fname } });
      if (!r.ok || !r.json || !r.json.name) throw new Error(`upload failed: HTTP ${r.status}`);
      return r.json.name;
    }

    /** Upload verified reference bytes and wire them into Qwen's temporary job graph. */
    async stageReferenceImages(nodes, references, log = () => {}) {
      const limit = referenceLimit(this.cfg);
      const all = (Array.isArray(references) ? references : []);
      const requested = all.slice(0, limit);
      if (!requested.length) return null;
      if (!qwenReferenceTarget(nodes)) {
        throw new Error('this researched job has image references, but the selected workflow has no TextEncodeQwenImage21 reference input');
      }

      const uploaded = [];
      const failed = [];
      for (let index = 0; index < requested.length; index++) {
        const ref = requested[index] || {};
        const id = String(ref.id || `reference-${index + 1}`);
        if (!ref.base64) { failed.push({ id, error: 'reference bytes are empty' }); continue; }
        const mime = String(ref.mime || 'image/png').toLowerCase();
        const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg'
          : mime.includes('webp') ? 'webp' : 'png';
        try {
          const fname = await this.uploadImage({ base64: ref.base64, ext, nameHint: `ala-ref-${id}` });
          uploaded.push({ id, fname });
        } catch (e) {
          failed.push({ id, error: e.message });
        }
      }

      const wired = injectQwenReferences(nodes, uploaded.map((r) => r.fname), limit);
      if (!wired.ok) throw new Error(wired.error);
      if (!uploaded.length) {
        throw new Error('none of the selected reference images could be uploaded to ComfyUI'
          + (failed[0] ? ` (${failed[0].error})` : ''));
      }
      const skipped = all.slice(limit).map((ref, index) => ({
        id: String((ref && ref.id) || `reference-${limit + index + 1}`),
        error: `not attached — past the ${limit}-reference ceiling (Settings → Generator)`,
      }));
      log(`Attached ${uploaded.length}/${requested.length} researched reference image(s) to Qwen-Image 2.1.`
        + (failed.length ? ` ${failed.length} could not be uploaded.` : '')
        + (skipped.length ? ` ${skipped.length} left out by the ${limit}-reference ceiling.` : ''));
      return { requested: requested.length, attached: uploaded.map((r) => r.id), failed, skipped, limit };
    }

    /** Load + normalize a workflow file from the configured directory (fresh every job). */
    async loadWorkflow(file) {
      const f = String(file || '').trim();
      if (!f) throw new Error('no workflow selected (Settings → Generator)');
      let raw = await window.ala.comfy.readWorkflow({ dir: this.cfg.workflowsDir, file: f });
      const subgraphs = (raw && raw.definitions && raw.definitions.subgraphs) || [];
      if (subgraphs.length) raw = expandSubgraphs(raw, await this.nodeDefs());
      const looksApi = raw && !Array.isArray(raw) && Object.values(raw).length > 0
        && Object.values(raw).every((v) => v && typeof v === 'object' && v.class_type);
      if (looksApi) return normalizeWorkflow(raw);
      const defs = await this.nodeDefs();
      const wf = normalizeWorkflow(raw, defs);
      if (wf.needsDefs) throw new Error('editor-format workflow needs the ComfyUI node definitions, but the server did not provide them');
      return wf;
    }

    /** Fetch /object_info once per driver — the class schemas are server-fixed. */
    async nodeDefs() {
      if (this._defs) return this._defs;
      const r = await this.http({ url: this.url('/object_info') });
      if (!r.ok || !r.json) throw new Error('could not read node definitions from ComfyUI (HTTP ' + r.status + ')');
      this._defs = r.json;
      return this._defs;
    }

    /** Generate images from a prompt through the configured image workflow. */
    async generate(promptText, { count = 0, references = [], shouldStop = null } = {}, log = () => {}) {
      const cfg = this.cfg;
      await this.ensureServer({ log });

      let wf;
      try {
        wf = await this.loadWorkflow(cfg.imageWorkflow);
      } catch (e) {
        throw new Error('workflow: ' + e.message);
      }
      const slots = detectPromptSlots(wf);
      if (!slots || !slots.positive) {
        throw new Error('no prompt input found in the workflow — nothing to put the prompt into');
      }
      const target = resolvePromptTarget(wf, slots);
      if (!target) throw new Error('the positive prompt slot is not text and does not lead to text');

      const base = JSON.parse(JSON.stringify(wf.nodes));
      base[target.id].inputs[target.field] = String(promptText);
      const referenceResult = await this.stageReferenceImages(base, references, log);
      if (slots.negative && typeof base[slots.negative].inputs.text !== 'string') {
        log('negative prompt slot is not plain text — leaving it alone', 'warn');
      }
      const seed = detectSeedSlot(wf);

      const n = perPrompt(count || cfg.imagesPerPrompt);
      const used = new Set();
      const images = [];
      for (let i = 1; i <= n; i++) {
        if (i > 1 && typeof shouldStop === 'function' && shouldStop()) {
          log(`Paused after ${i - 1} of ${n} picture(s) — keeping the ${images.length} already rendered.`);
          break;
        }
        const graph = JSON.parse(JSON.stringify(base));
        if (seed) {
          let s = randSeed();
          while (used.has(s)) s = randSeed();
          used.add(s);
          graph[seed.id].inputs[seed.field] = s;
        }

        const clientId = `ala-${Date.now()}-${randSeed().toString(16)}`;
        log(`Submitting to ComfyUI${n > 1 ? ` (${i}/${n})` : ''} — workflow ${cfg.imageWorkflow}, seed ${seed ? graph[seed.id].inputs[seed.field] : '(n/a)'}${slots.traced ? '' : ' (prompt slot: fallback, no sampler traced)'}`);
        try {
          const sub = await this.submit(graph, clientId);
          if (!sub.ok) throw new Error(sub.error || 'ComfyUI rejected the workflow');
          const hist = await this.pollHistory(sub.promptId, log);
          images.push(...await this.collectImages(hist));
        } catch (e) {
          if (!images.length) throw e;
          log(`Pass ${i}/${n} failed (${e.message}) — keeping the ${images.length} image(s) already rendered.`, 'warn');
          if (e.engineDown) break;
        }
      }
      log(`ComfyUI returned ${images.length} image(s).`);
      return { images, referenceResult };
    }

    /** The output images of ONE finished job, fetched as bytes. */
    async collectImages(hist) {
      const outs = (hist && hist.outputs) || {};
      const files = [];
      for (const o of Object.values(outs)) {
        if (!o || !Array.isArray(o.images)) continue;
        for (const im of o.images) {
          if (im.type === 'output') files.push(im);
        }
      }
      if (!files.length) throw new Error('ComfyUI finished but reported no output images');

      const images = [];
      for (const f of files) {
        const q = `?type=${f.type}&subfolder=${encodeURIComponent(f.subfolder || '')}&filename=${encodeURIComponent(f.filename)}`;
        const r = await this.http({ url: this.url('/view' + q) });
        if (!r.ok || !r.base64) throw new Error(`fetching output ${f.filename}: HTTP ${r.status}`);
        const fn = String(f.filename || '').toLowerCase();
        const mime = fn.endsWith('.jpg') || fn.endsWith('.jpeg') ? 'image/jpeg'
          : fn.endsWith('.webp') ? 'image/webp'
          : fn.endsWith('.png') ? 'image/png' : 'image/png';
        const { w, h } = sniffSize(r.base64, mime);
        images.push({ base64: r.base64, mime, w, h });
      }
      return images;
    }

    /** POST /prompt. */
    async submit(graph, clientId) {
      const api = {};
      for (const [id, n] of Object.entries(graph)) {
        api[id] = { class_type: n.classType, inputs: n.inputs || {} };
      }
      const r = await this.http({ url: this.url('/prompt'), method: 'POST', json: { client_id: clientId, prompt: api } });
      if (!r.ok || !r.json || !r.json.prompt_id) {
        const j = r.json || {};
        let msg = '';
        if (j.error) {
          const e = j.error;
          msg = (typeof e === 'string' ? e
            : [e.type, e.message, e.details, (e.extra_info && e.extra_info.errors) || '']
              .filter((x) => typeof x === 'string' && x).join(': '));
        } else if (Array.isArray(j.errors)) msg = j.errors.join('; ');
        return { ok: false, error: msg || `HTTP ${r.status}` };
      }
      return { ok: true, promptId: r.json.prompt_id };
    }

    /** Poll /history/<promptId> until the job lands (done or error). */
    async pollHistory(promptId, log = () => {}) {
      const t0 = Date.now();
      let lastLog = 0;
      let downSince = 0;
      let lastQueueCheck = Date.now();
      let missing = 0;
      const history = async () => {
        const r = await this.http({ url: this.url(`/history/${promptId}`), timeoutMs: 30000 });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (r.json || {})[promptId] || null;
      };
      const settle = (entry) => {
        if (entry.status && entry.status.completed === false && entry.status.status_str === 'error') {
          throw new Error('ComfyUI job errored: ' + JSON.stringify(entry.status.messages || entry.status).slice(0, 400));
        }
        return entry;
      };
      for (;;) {
        if (Date.now() - t0 > 4 * 3600 * 1000) throw new Error('ComfyUI job still running after 4h — giving up');
        await sleep(2500);
        let entry;
        try {
          entry = await history();
          downSince = 0;
        } catch (e) {
          if (!downSince) downSince = Date.now();
          if (Date.now() - downSince > 180000) {
            throw engineDown(`ComfyUI stopped answering in the middle of a render (${e.message}) — the job goes back in the queue`);
          }
          continue;
        }
        if (entry) return settle(entry);

        if (Date.now() - lastQueueCheck > 30000) {
          lastQueueCheck = Date.now();
          const queued = await this.inQueue(promptId).catch(() => null);
          if (queued === false) {
            const late = await history().catch(() => null);
            if (late) return settle(late);
            missing += 1;
            if (missing >= 2) {
              throw new Error('ComfyUI no longer has this job — it was cancelled there, or the server restarted and lost its queue');
            }
          } else if (queued === true) {
            missing = 0;
          }
        }
        if (Date.now() - lastLog > 60000) {
          log('still waiting on ComfyUI…');
          lastLog = Date.now();
        }
      }
    }

    /** Is this prompt running or waiting on the server? null when the queue cannot be read. */
    async inQueue(promptId) {
      const r = await this.http({ url: this.url('/queue'), timeoutMs: 15000 });
      if (!r.ok || !r.json) return null;
      const rows = [
        ...(Array.isArray(r.json.queue_running) ? r.json.queue_running : []),
        ...(Array.isArray(r.json.queue_pending) ? r.json.queue_pending : []),
      ];
      return rows.some((row) => Array.isArray(row) && String(row[1]) === String(promptId));
    }

    /** Image → video through the configured i2v workflow. */
    async convertToVideo({ base64, mime = 'image/png', prompt, workflow, seconds, log = () => {} }) {
      const cfg = this.cfg;
      await this.ensureServer({ log });

      let wf;
      try {
        wf = await this.loadWorkflow(workflow || cfg.videoWorkflow);
      } catch (e) {
        throw new Error('workflow: ' + e.message);
      }
      const slots = detectPromptSlots(wf);
      if (!slots || !slots.positive) {
        throw new Error('no prompt input found in the video workflow — it needs a CLIPTextEncode or an i2v node that takes a prompt itself');
      }
      const target = resolvePromptTarget(wf, slots);
      if (!target) throw new Error('the video workflow has no text prompt input');
      const imgNode = detectI2vInput(wf);
      if (!imgNode) throw new Error('no LoadImage node found — this is not an image-to-video workflow');

      const ext = (mime || '').includes('jpeg') ? 'jpg' : 'png';
      const fname = await this.uploadImage({ base64, ext, nameHint: 'i2v' });
      log(`Input image uploaded as ${fname}.`);

      const graph = JSON.parse(JSON.stringify(wf.nodes));
      if (typeof prompt === 'string' && prompt.trim()) {
        graph[target.id].inputs[target.field] = prompt.trim();
      }
      graph[imgNode].inputs.image = fname;
      const dur = detectDurationSlot(wf);
      if (seconds != null && seconds !== '') {
        const s = Number(seconds);
        if (!Number.isFinite(s) || s <= 0) throw new Error(`video length must be a number of seconds, got "${seconds}"`);
        if (!dur) throw new Error('this video workflow has no duration input — set the length in the workflow itself');
        graph[dur.id].inputs[dur.field] = Math.min(MAX_VIDEO_SECONDS, Math.max(MIN_VIDEO_SECONDS, s));
        log(`Video length set to ${graph[dur.id].inputs[dur.field]} s.`);
      }
      const seed = detectSeedSlot(wf);
      if (seed) graph[seed.id].inputs[seed.field] = randSeed();

      const clientId = `ala-i2v-${Date.now()}-${randSeed().toString(16)}`;
      log(`Submitting i2v job — workflow ${workflow || cfg.videoWorkflow}, seed ${seed ? graph[seed.id].inputs[seed.field] : '(n/a)'}`);
      const sub = await this.submit(graph, clientId);
      if (!sub.ok) throw new Error(sub.error || 'ComfyUI rejected the video workflow');

      const hist = await this.pollHistory(sub.promptId, log);
      const outs = (hist && hist.outputs) || {};
      let file = null;
      for (const o of Object.values(outs)) {
        if (!o) continue;
        const entries = [].concat(
          Array.isArray(o.images) ? o.images : [],
          Array.isArray(o.gifs) ? o.gifs : [],
          Array.isArray(o.videos) ? o.videos : [],
        );
        for (const g of entries) {
          if (g.type !== 'output') continue;
          const name = String(g.filename || '').toLowerCase();
          const isVideo = /\.(webm|mp4|mkv)$/.test(name);
          const isAnimated = /\.(webp|gif)$/.test(name) && (o.animated === true || g.animated === true);
          if (!isVideo && !isAnimated) continue;
          const fileIsVideo = file && /\.(webm|mp4|mkv)$/.test(String(file.filename || '').toLowerCase());
          if (!file || (isVideo && !fileIsVideo)) file = g;
        }
      }
      if (!file) throw new Error('ComfyUI finished but reported no video output');

      const viewUrl = this.url(`/view?type=${file.type}&subfolder=${encodeURIComponent(file.subfolder || '')}&filename=${encodeURIComponent(file.filename)}`);
      const saved = await window.ala.comfy.downloadVideo({ url: viewUrl, nameHint: 'i2v' });
      log(`Video ready: ${saved.fname} (${(saved.size / 1048576).toFixed(1)} MB)`);
      let gif = null;
      if (cfg.autoGif) {
        try {
          gif = await window.ala.comfy.videoToGif({ fname: saved.fname, nameHint: 'i2v' });
          log(`GIF ready: ${gif.fname} (${(gif.size / 1048576).toFixed(1)} MB)`);
        } catch (e) {
          log(`GIF conversion failed (the video is still saved): ${e.message}`);
        }
      }
      return { path: saved.path, url: saved.url, fname: saved.fname, size: saved.size, gif };
    }

    isAdvanced() { return false; }
    filterableInputs() { return []; }
  }

  /** Write a video prompt for one image. mode: 'auto' | 'hybrid'. */
  async function writeVideoPrompt({ base64, mime, userText = '', mode = 'auto', seconds = null }) {
    userText = String(userText || '').trim();
    if (mode === 'hybrid' && !userText) throw new Error('enter your extra instructions for Hybrid mode, or choose Auto');
    if (mode === 'hybrid' && userText.length > 2000) throw new Error('Hybrid instructions must fit within 2000 characters');
    const describe = await U.llmVision(
      base64, mime,
      'Describe this image in a few concrete sentences: the visual style (e.g. 2D anime illustration, 3D CG, photo), '
      + 'the subject(s) and their appearance and clothing, pose and expression, the framing (wide/medium/close-up, '
      + 'camera angle), the setting, the lighting and the palette. Plain description only — no video terms.',
      { role: 'vision' }, 'Describing the image for the video prompt');

    const len = Number(seconds) > 0 ? `${Number(seconds)}-second` : 'short';
    const rules = `You write prompts for MiniMax H3, an image-to-video model that generates video WITH sound. It is CFG-distilled: there is NO negative prompt, and every word you write is read as something to show or hear. Follow this format exactly:

Line 1, verbatim: For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.
Then one blank line, then three fields:
integrated_multimodal_description: [Shot 1] <visual style taken from the image>, <shot size>. Anchor the first frame (same character, clothing, colours, composition, setting as the picture), then the action onset, its continuous development over the ${len} clip, and the result. Exactly one camera move, written as a sentence: "The camera holds a static shot" when the camera must not move, or e.g. "The camera pushes in with small amplitude at slow speed". Use a single shot unless cuts are explicitly asked for.
overall_soundscape: 1-3 sentences of ambient, action and non-verbal human sounds (footsteps, wind, birdsong, rustling leaves). Write N/A only if total silence is asked for.
non_diegetic_music: instruments and tempo, or N/A.

Rules:
- NEVER write negations such as "no zoom", "no voice", "no music", "no text", "without dialogue". Say what IS there instead: a static shot, N/A music, a soundscape with only ambient sound.
- Spoken words appear ONLY if the artist asked for speech. Then give the speaker an ID and a voice, and wrap the exact words with a language tag: The young knight with a bright, cheerful voice (S1) says: <d>[English] exact words</d>. Default the language to English unless another one is asked for. If nobody should speak, write no dialogue and describe only non-verbal sounds.
- Put visible text on screen only if asked, in double quotes.
- Keep the artist's requested action, camera and audio choices exactly; add concrete detail, never replace them.`;
    const sys = mode === 'hybrid'
      ? `${rules}\n\nThe artist's words below are the required direction — every instruction in them must appear in the prompt, rephrased positively where needed.\n\nIMAGE DESCRIPTION:\n${describe.text}\n\nARTIST'S WORDS:\n${userText}`
      : `${rules}\n\nBring the picture to life with plausible motion and atmosphere — no new characters, no scene change, no dialogue.\n\nIMAGE DESCRIPTION:\n${describe.text}`;

    const r = await U.llmChat(
      [
        { role: 'user', content: sys + '\n\nRespond with ONLY the final prompt text, nothing else.' },
      ],
      { temperature: 0.7, maxTokens: 1200, role: 'ideation' }, 'Writing the video prompt');

    let text = String(r.text || '').trim();
    const j = extractJson(text);
    if (j && typeof (j.prompt || j.text) === 'string') text = (j.prompt || j.text).trim();
    text = text.replace(/^(final\s+prompt|prompt)\s*[:\-]\s*/i, '').trim();
    if (!text) throw new Error('the model returned an empty prompt');
    if (!text.startsWith(H3_FIRST_FRAME_LINE)) text = `${H3_FIRST_FRAME_LINE}\n\n${text.replace(/^For the target video[^\n]*\n*/i, '')}`;
    if (mode === 'hybrid' && !text.includes(userText) && !NEGATION_RE.test(userText)) {
      text = `${H3_FIRST_FRAME_LINE}\n\n${userText}\n\n${text.slice(H3_FIRST_FRAME_LINE.length).trim()}`;
    }
    return { prompt: text.slice(0, MAX_VIDEO_PROMPT), described: String(describe.text || '').slice(0, 1500) };
  }
  const MAX_VIDEO_PROMPT = 4000;
  const H3_FIRST_FRAME_LINE = 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.';
  const NEGATION_RE = /\b(no|not|don['’]?t|do not|never|without|avoid|stop)\b/i;

  window.ComfyDriver = ComfyDriver;
  window.ComfyUI = {
    normalizeWorkflow, detectPromptSlots, detectSeedSlot, detectI2vInput, detectDurationSlot, extractJson, writeVideoPrompt,
    expandSubgraphs, promptFieldOf, widgetInputs, resolvePromptTarget, qwenReferenceTarget,
    clearQwenReferences, injectQwenReferences, referenceLimit, MAX_REFERENCE_IMAGES, ComfyDriver,
    sniffSize, engineDown,
  };
})();
