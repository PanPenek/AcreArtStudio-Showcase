/**
 * state.js: shared renderer state + utilities used by every module.
 *
 * `State` holds the live settings, queue and library mirrored from the main
 * process. `U` holds helpers: robust JSON extraction from LLM answers (models wrap
 * JSON in prose, or almost-close it), prompt normalisation, debounce, a
 * concurrency-limited map, and `llmChat`/`llmVision`, which every AI call in the UI
 * goes through so a provider fallback is never silent.
 */
(function () {
  const listeners = {};

  /** Is this string an image prompt, or a sentence about one? */
  function looksLikePrompt(s, { min = 40, max = 1200 } = {}) {
    const t = String(s || '').trim().replace(/[,;\s]+$/, '');
    if (t.length < min || t.length > max) return false;
    const META = /\b(the (original|prompt|request|artist|audience|user|instruction|scene descri)|artist'?s direction|i (should|need|must|will|can)|we (need|should|must)|let me|wait\b|however\b|but the\b|conflicts?\b|maybe best|respond only|json|array|output format|panel \d|step \d|rule[s]?:)/i;
    const TRAILS_OFF = /(\\|:|\b(and|but|or|however|because|so|with|the|a|an|of|to)\s*)$/i;
    const prose = t.replace(/["“][^"”]*["”]/g, '');
    if (META.test(prose)) return false;
    if (prose.includes('?')) return false;
    if (TRAILS_OFF.test(t)) return false;
    const commas = (t.match(/,/g) || []).length;
    const words = t.split(/\s+/).filter(Boolean).length;
    return commas >= 2 || words >= 12;
  }

  /** Every balanced JSON value in a response, parsed, in the order they appear. */
  function jsonCandidates(text) {
    const cleaned = String(text || '').replace(/```(?:json)?/gi, '');
    const out = [];
    for (let start = 0; start < cleaned.length; start++) {
      const open = cleaned[start];
      if (open !== '{' && open !== '[') continue;
      const close = open === '{' ? '}' : ']';
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < cleaned.length; i++) {
        const c = cleaned[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === open) depth++;
        else if (c === close) {
          depth--;
          if (depth === 0) {
            try { out.push({ at: start, value: JSON.parse(cleaned.slice(start, i + 1)) }); } catch { }
            break;
          }
        }
      }
    }
    return out;
  }

  const QUOTED_RUN = /["“]((?:\\.|[^"”\\\n])*)["”]/g;

  const JSON_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };

  /** Undo JSON string escaping on text scraped out of raw JSON, so `\"` reads as `"`. */
  function unescapeJsonish(s) {
    return String(s || '').replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, g) => {
      if (g[0] === 'u' && g.length === 5) return String.fromCharCode(parseInt(g.slice(1), 16));
      return JSON_ESCAPES[g] !== undefined ? JSON_ESCAPES[g] : g;
    });
  }

  /** Re-close a JSON value that the model very nearly wrote. */
  function repairFrom(s, start) {
    const closers = [];
    let out = '';
    let inStr = false;
    let esc = false;
    let safeLen = -1;
    let closed = false;
    const dropTrailingComma = () => { out = out.replace(/,\s*$/, ''); };

    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) { out += c; esc = false; continue; }
        if (c === '\\') { out += c; esc = true; continue; }
        if (c === '"') {
          inStr = false;
          out += c;
          if (closers.length === 1 && closers[0] === ']') safeLen = out.length;
          continue;
        }
        if (c === '\n') { out += '\\n'; continue; }
        if (c === '\r') { out += '\\r'; continue; }
        if (c === '\t') { out += '\\t'; continue; }
        out += c < ' ' ? ' ' : c;
        continue;
      }
      if (c === '"') { inStr = true; out += c; continue; }
      if (c === '[' || c === '{') { closers.push(c === '[' ? ']' : '}'); out += c; continue; }
      if (c === ']' || c === '}') {
        if (!closers.length) break;
        closers.pop();
        dropTrailingComma();
        out += c;
        if (!closers.length) { closed = true; break; }
        if (closers.length === 1) safeLen = out.length;
        continue;
      }
      if (c === ',' && closers.length === 1) { out += c; safeLen = out.length; continue; }
      out += c;
    }

    let repaired;
    if (closed) {
      repaired = out;
    } else {
      if (safeLen < 0 || !closers.length) return null;
      repaired = out.slice(0, safeLen).replace(/,\s*$/, '') + closers[0];
    }
    try {
      const value = JSON.parse(repaired);
      return value && typeof value === 'object' ? value : null;
    } catch { return null; }
  }

  /** `jsonCandidates`, but for the near-misses. */
  function repairedCandidates(text, { limit = 8, tries = 60 } = {}) {
    const cleaned = String(text || '').replace(/```(?:json)?/gi, '');
    const out = [];
    let attempts = 0;
    for (let i = 0; i < cleaned.length && out.length < limit && attempts < tries; i++) {
      const c = cleaned[i];
      if (c !== '[' && c !== '{') continue;
      attempts++;
      const value = repairFrom(cleaned, i);
      if (value) out.push({ at: i, value });
    }
    return out;
  }

  /** Pull image prompts out of a response that did not come back as clean JSON. */
  function salvagePrompts(text, { min = 40, max = 1200, limit = 16 } = {}) {
    const quoted = [...String(text || '').matchAll(QUOTED_RUN)]
      .map((m) => unescapeJsonish(m[1]).trim())
      .filter((s) => s.length >= min && s.length <= max);
    const out = [];
    for (const s of [...new Set(quoted)]) {
      if (!looksLikePrompt(s, { min, max })) continue;
      out.push(housePrompt(s));
      if (out.length >= limit) break;
    }
    return out;
  }

  const MEDIUM_QUALIFIER = String.raw`(?:anime|manga|japanese|digital|2d|3d|cg|fan|concept|character)`;
  const MEDIUM_NOUN = String.raw`(?:illustration|artwork|drawing|painting|render(?:ing)?|image|picture|photo(?:graph)?|portrait)`;
  const MEDIUM_OF = String.raw`(?:of|showing|depicting|featuring)`;
  const MEDIUM_LEAD_RE = new RegExp(
    String.raw`^\s*(?:an?|the)?\s*(?:`
    + String.raw`(?:${MEDIUM_QUALIFIER}\s+)+(?:${MEDIUM_NOUN}|art)(?:\s*${MEDIUM_OF}\s+|\s*[,:;.\-\u2013\u2014]\s*|\s+)`
    + String.raw`|${MEDIUM_NOUN}\s+${MEDIUM_OF}\s+`
    + String.raw`)`,
    'i');

  const LABEL_LEAD_RE = /^\s*(?:image\s+|generation\s+)?prompt\s*(?:\d+)?\s*[:\-\u2013\u2014]\s+/i;

  /** Normalise one generated prompt into the house form, in code rather than by asking. */
  function housePrompt(text) {
    let s = String(text == null ? '' : text).trim();
    if (!s) return s;
    s = s.replace(LABEL_LEAD_RE, '');
    const stripped = s.replace(MEDIUM_LEAD_RE, '');
    if (stripped !== s && stripped.trim().length >= 20) {
      s = stripped.replace(/^(?:of|showing|depicting|featuring)\s+/i, '').trimStart();
      const first = s.split(/\s+/, 1)[0] || '';
      if (!(first.length > 1 && first === first.toUpperCase())) s = s.charAt(0).toLowerCase() + s.slice(1);
    }
    return s
      .replace(/\s+/g, ' ')
      .replace(/\s+,/g, ',')
      .replace(/,(\s*,)+/g, ',')
      .replace(/^[,\s]+/, '')
      .replace(/[,;\s]+$/, '')
      .trim();
  }

  /** Get image prompts out of an LLM result, whatever shape it came back in. */
  function promptsFrom(res, { count = 8, min = 40, max = 900 } = {}) {
    const text = typeof res === 'string' ? res : String((res && res.text) || '');
    const thinking = !!(res && typeof res === 'object' && (res.truncated || res.fromReasoning));
    const clean = (v) => {
      const list = Array.isArray(v) ? v : (v && Array.isArray(v.prompts) ? v.prompts : null);
      if (!list) return [];
      return list.map((s) => housePrompt(s)).filter((s) => looksLikePrompt(s, { min, max }));
    };

    const scored = jsonCandidates(text)
      .map((c) => ({ at: c.at, list: clean(c.value) }))
      .filter((c) => c.list.length);
    if (scored.length) {
      scored.sort((a, b) => b.list.length - a.list.length || b.at - a.at);
      return scored[0].list.slice(0, count);
    }
    const mended = repairedCandidates(text)
      .map((c) => ({ at: c.at, list: clean(c.value) }))
      .filter((c) => c.list.length);
    if (mended.length) {
      mended.sort((a, b) => b.list.length - a.list.length || b.at - a.at);
      return mended[0].list.slice(0, count);
    }
    return thinking ? [] : salvagePrompts(text, { min, max, limit: count });
  }

  /**
   * The same job as `promptsFrom`, for the answer shape advanced mode asks for: `[{ prompt,
   * controls: { name: option } }]`.
   */
  function ideasFrom(res, { count = 8, min = 40, max = 900 } = {}) {
    const text = typeof res === 'string' ? res : String((res && res.text) || '');
    const clean = (v) => {
      const list = Array.isArray(v) ? v : (v && Array.isArray(v.prompts) ? v.prompts : null);
      if (!list) return [];
      const out = [];
      for (const item of list) {
        const prompt = typeof item === 'string' ? item : String((item && (item.prompt || item.description)) || '').trim();
        if (!looksLikePrompt(prompt, { min, max })) continue;
        const src = (item && typeof item === 'object' && (item.controls || item.filters || item.options)) || null;
        const controls = {};
        if (src && typeof src === 'object' && !Array.isArray(src)) {
          for (const [k, v2] of Object.entries(src)) {
            if (v2 == null) continue;
            const val = String(v2).trim();
            if (val) controls[String(k).trim()] = val;
          }
        }
        out.push({ prompt: housePrompt(prompt), controls });
      }
      return out;
    };

    const scored = jsonCandidates(text)
      .map((c) => ({ at: c.at, list: clean(c.value) }))
      .filter((c) => c.list.length);
    if (scored.length) {
      scored.sort((a, b) => b.list.length - a.list.length || b.at - a.at);
      return scored[0].list.slice(0, count);
    }
    const mended = repairedCandidates(text)
      .map((c) => ({ at: c.at, list: clean(c.value) }))
      .filter((c) => c.list.length);
    if (mended.length) {
      mended.sort((a, b) => b.list.length - a.list.length || b.at - a.at);
      return mended[0].list.slice(0, count);
    }
    return promptsFrom(res, { count, min, max }).map((p) => ({ prompt: p, controls: {} }));
  }

  window.U = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    uid: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
    escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[c]));
    },
    fmtTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); },
    extFromMime(mime) {
      if (/png/.test(mime)) return 'png';
      if (/webp/.test(mime)) return 'webp';
      if (/gif/.test(mime)) return 'gif';
      return 'jpg';
    },
    jsonCandidates,
    repairedCandidates,
    unescapeJsonish,
    ideasFrom,
    /** Extract first balanced JSON value from an LLM response. */
    extractJson(text) {
      if (!text) throw new Error('empty LLM response');
      const found = jsonCandidates(text);
      if (!found.length) throw new Error('no JSON found in LLM response');
      return found[0].value;
    },
    /** Every LLM call in the renderer goes through these two, so a fallback is never silent. */
    async llmChat(messages, opts, label = 'An LLM call') {
      return record((opts || {}).role, label, () => window.ala.llm.chat(messages, opts));
    },
    async llmVision(base64, mime, prompt, opts, label = 'A vision call') {
      return record((opts || {}).role || 'vision', label, () => window.ala.llm.vision(base64, mime, prompt, opts));
    },
    /** Trailing-edge debounce with a `flush()` that runs a pending call now. */
    debounce(fn, ms) {
      let t = null;
      let pending = null;
      const run = () => { t = null; const args = pending; pending = null; if (args) fn(...args); };
      const d = (...args) => { pending = args; clearTimeout(t); t = setTimeout(run, ms); };
      d.flush = () => { if (!t) return; clearTimeout(t); run(); };
      return d;
    },

    looksLikePrompt,
    salvagePrompts,
    promptsFrom,
    housePrompt,
    MEDIUM_LEAD_RE,
    /** Map with a concurrency ceiling. */
    async mapLimit(items, limit, fn) {
      const out = new Array(items.length);
      const n = Math.max(1, Math.min(limit | 0 || 1, items.length));
      let next = 0;
      await Promise.all(Array.from({ length: n }, async () => {
        while (true) {
          const i = next++;
          if (i >= items.length) return;
          out[i] = await fn(items[i], i);
        }
      }));
      return out;
    },
  };

  /** Run one LLM call and remember what actually happened to it. */
  async function record(role, label, run) {
    const key = role || 'chat';
    const t0 = Date.now();
    try {
      const r = await run();
      const notes = (r && r.notes) || [];
      State.llmLast[key] = {
        ok: true, at: Date.now(), ms: Date.now() - t0, label,
        provider: r.provider || r.engine, tier: r.tier || '', model: r.model || '',
        fellBack: notes.length > 0, notes,
        promptTokens: r.promptTokens || 0,
        completionTokens: r.completionTokens || 0,
        cachedTokens: r.cachedTokens || 0,
      };
      if (notes.length) {
        State.addLog(`${label} was answered by ${r.provider || r.engine} `
          + `after ${notes.join(', ')} — check Settings → Providers if that keeps happening.`, 'err');
      }
      State.emit('llm', State.llmLast);
      return r;
    } catch (e) {
      State.llmLast[key] = { ok: false, at: Date.now(), ms: Date.now() - t0, label, error: e.message };
      State.emit('llm', State.llmLast);
      throw e;
    }
  }

  const persistQueueDebounced = U.debounce((items) => window.ala.db.setQueue({ items }), 500);
  const persistLibraryDebounced = U.debounce((items) => window.ala.db.setLibrary({ items }), 500);

  window.State = {
    settings: null,
    queue: [],
    library: [],
    stats: {},
    worker: { running: false, currentJobId: null, statusText: 'Idle', qcLane: 0 },
    log: [],
    llmLast: {},

    on(event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
      return () => { listeners[event] = (listeners[event] || []).filter((f) => f !== cb); };
    },
    emit(event, data) { (listeners[event] || []).forEach((cb) => { try { cb(data); } catch (e) { console.error(e); } }); },

    async init() {
      this.settings = await window.ala.settings.get();
      this.queue = (await window.ala.db.getQueue()).items || [];
      this.library = (await window.ala.db.getLibrary()).items || [];
      this.stats = await window.ala.db.getStats();
      for (const j of this.queue) {
        if (j.status === 'generating') { j.status = 'queued'; }
        else if (j.status === 'qc') {
          j.status = 'done';
          j.error = j.error || 'app restarted mid-inspection — the images are in Review, retryable';
        }
      }
      const qcOff = !!(this.settings && this.settings.gen && this.settings.gen.skipQc);
      for (const c of this.library) {
        if (c.status === 'qc' && qcOff) { c.status = 'review'; c.qcSkipped = true; c.qc = null; c.error = null; }
        if (c.status === 'qc') { c.status = 'qc_error'; c.error = c.error || 'QC interrupted — app restarted'; }
        if (c.status === 'metadata') c.status = 'review';
        if (c.status === 'uploading') c.status = 'approved';
      }
      this.persistQueue();
      this.persistLibrary();
    },

    persistQueue() { persistQueueDebounced(this.queue); this.emit('queue', this.queue); },
    /** `{ quiet: true }` writes to disk WITHOUT emitting. */
    persistLibrary(opts = {}) {
      persistLibraryDebounced(this.library);
      if (!opts.quiet) this.emit('library', this.library);
    },

    /** Send any save still waiting on its debounce. */
    flushPersists() {
      persistQueueDebounced.flush();
      persistLibraryDebounced.flush();
    },

    async bumpStats(deltas) {
      this.stats = await window.ala.db.bumpStats(deltas);
      this.emit('stats', this.stats);
    },

    addLog(msg, kind = '') {
      this.log.push({ ts: Date.now(), msg, kind });
      if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
      this.emit('log');
    },

    setWorker(patch) {
      Object.assign(this.worker, patch);
      this.emit('worker', this.worker);
    },
  };
})();
