/**
 * perchance.js: drives the free Perchance web image generator inside the app's
 * embedded browser (webview).
 *
 * Perchance has no API, so the driver operates the page like a person would: fill
 * the description, set the style/shape/count dropdowns, press Generate, wait for
 * the result frames, and extract the finished images. Frame access goes through
 * the main process (webFrameMain.executeJavaScript) because the generator runs in
 * cross-origin iframes. Every page call has a hard timeout so a hung page can
 * never freeze the pipeline.
 */
(function () {
  const GENERATORS = {
    classic: {
      id: 'classic',
      label: 'AI Character Generator',
      short: 'Classic',
      slug: 'ai-character-generator',
      url: 'https://perchance.org/ai-character-generator',
      advanced: false,
    },
    advanced: {
      id: 'advanced',
      label: 'Advanced Character Generator',
      short: 'Advanced',
      slug: 'ai-character-generator',
      url: 'https://perchance.org/ai-character-generator',
      advanced: true,
    },
  };

  const ADV_RESERVED = new Set(['description', 'scratchpad', 'negative', 'fullSize', 'numImages', 'shape', 'gScale']);

  const ADV_NO_RESET = new Set(['description', 'scratchpad', 'negative', 'fullSize', 'numImages', 'shape', 'artStyle', 'gScale']);

  const JS_DISMISS_GATES = `(() => {
    const cand = [...document.querySelectorAll('button, input[type=button], input[type=submit], a, [role=button]')];
    const re = /^(continue|enter|proceed|agree|accept|got it|✅ got it|ok|okay|close|dismiss|yes)\\b/i;
    for (const el of cand) {
      const txt = ((el.innerText || el.value || '') + '').trim();
      if (!txt || txt.length > 40) continue;
      if (!re.test(txt)) continue;
      if (el.offsetParent) { el.click(); return txt; }
    }
    return null;
  })()`;

  const JS_READY = (advanced) => (advanced ? `(() => {
    const ta = document.querySelector('textarea[data-name="description"]');
    const btn = document.getElementById('generateButtonEl');
    return !!(ta && btn);
  })()` : `(() => {
    const ta = [...document.querySelectorAll('textarea')].find(t =>
      !!t.offsetParent && !(t.placeholder || '').startsWith('Use this box to store prompts'));
    const btn = document.getElementById('generateButtonEl');
    return !!(ta && btn);
  })()`);

  const JS_SET_PROMPT = (text, advanced) => `(() => {
    const ta = ${advanced
    ? `document.querySelector('textarea[data-name="description"]')`
    : `[...document.querySelectorAll('textarea')].find(t =>
      !!t.offsetParent && !(t.placeholder || '').startsWith('Use this box to store prompts'))`};
    if (!ta) return { ok: false, reason: 'description textarea not found' };
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    ta.blur();
    return { ok: true };
  })()`;

  const JS_SET_SELECT = (kind, wantedText) => `(() => {
    const sels = [...document.querySelectorAll('select')];
    let target = null;
    if (${JSON.stringify(kind)} === 'shape') {
      target = sels.find(s => [...s.options].some(o => /portrait/i.test(o.text)) && [...s.options].some(o => /landscape/i.test(o.text)));
    } else if (${JSON.stringify(kind)} === 'count') {
      target = sels.find(s => s.options.length <= 6 && [...s.options].every(o => /^[0-9]+$/.test(o.text.trim())));
    } else {
      target = sels.find(s => s.options.length > 10);
    }
    if (!target) return { ok: false, reason: 'select not found' };
    const opt = [...target.options].find(o => o.text.trim().toLowerCase() === ${JSON.stringify(wantedText.toLowerCase())});
    if (!opt) return { ok: false, reason: 'option not found: ' + ${JSON.stringify(wantedText)} };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(target, opt.value);
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: opt.text };
  })()`;

  const JS_READ_COUNT = (advanced) => (advanced ? `(() => {
    const s = document.querySelector('select[data-name="numImages"]');
    const n = s ? parseInt(s.options[s.selectedIndex].text, 10) : 0;
    return n >= 1 && n <= 30 ? n : 6;
  })()` : `(() => {
    const s = [...document.querySelectorAll('select')].find(s =>
      s.options.length <= 6 && [...s.options].every(o => /^[0-9]+$/.test(o.text.trim())));
    const n = s ? parseInt(s.options[s.selectedIndex].text, 10) : 0;
    return n >= 1 && n <= 12 ? n : 6;
  })()`);

  const JS_ADV_CATALOG = `(() => {
    const out = [];
    for (const el of document.querySelectorAll('[data-name]')) {
      const tag = el.tagName.toLowerCase();
      if (tag !== 'select' && tag !== 'input' && tag !== 'textarea') continue;
      const ctn = el.closest('.input-ctn');
      const lab = ctn && ctn.querySelector('.input-label span');
      const e = {
        name: el.dataset.name,
        tag,
        label: lab ? lab.textContent.trim() : el.dataset.name,
      };
      if (tag === 'select') e.options = [...el.options].map(o => (o.text || '').trim()).filter(Boolean);
      out.push(e);
    }
    return out;
  })()`;

  /** Reset a set of dropdowns to their first option, then apply a map of exact values. */
  const JS_ADV_APPLY = (pairs, resetNames) => `(() => {
    const selSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    const out = { reset: 0, set: {}, missed: [] };
    for (const name of ${JSON.stringify(resetNames)}) {
      const el = document.querySelector('select[data-name="' + name + '"]');
      if (!el || !el.options.length || el.selectedIndex === 0) continue;
      selSetter.call(el, el.options[0].value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      out.reset++;
    }
    for (const [name, wanted] of Object.entries(${JSON.stringify(pairs)})) {
      const el = document.querySelector('[data-name="' + name + '"]');
      if (!el) { out.missed.push(name + ' (no such control)'); continue; }
      const tag = el.tagName.toLowerCase();
      if (tag === 'select') {
        const opts = [...el.options];
        const want = String(wanted).trim();
        const opt = opts.find(o => (o.text || '').trim() === want)
          || opts.find(o => (o.text || '').trim().toLowerCase() === want.toLowerCase());
        if (!opt) { out.missed.push(name + ' → ' + want); continue; }
        selSetter.call(el, opt.value);
        el.dispatchEvent(new Event('change', { bubbles: true }));
        out.set[name] = (opt.text || '').trim();
      } else {
        const proto = tag === 'textarea' ? window.HTMLTextAreaElement : window.HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
        el.focus();
        setter.call(el, String(wanted));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
        out.set[name] = String(wanted).slice(0, 60);
      }
    }
    return out;
  })()`;

  const JS_HANDLE_TERMS_DIALOG = `(() => {
    const out = { checked: [], clicked: [] };
    const labelOf = (cb) => {
      const byFor = cb.id && document.querySelector('label[for="' + cb.id + '"]');
      return ((byFor && byFor.innerText) || (cb.closest('label') && cb.closest('label').innerText) ||
        (cb.parentElement && cb.parentElement.innerText) || '').trim();
    };
    for (const cb of document.querySelectorAll('input[type=checkbox]')) {
      if (cb.checked) continue;
      const label = labelOf(cb);
      if (/(terms of service|i agree to the terms)/i.test(label)) {
        cb.click();
        out.checked.push(label.slice(0, 70));
      }
    }
    for (const el of document.querySelectorAll('button, input[type=submit], input[type=button], a, [role=button]')) {
      const txt = ((el.innerText || el.value || '') + '').trim();
      if (!txt || txt.length > 60 || /generate/i.test(txt)) continue;
      if (/(i am (over )?18|i'?m (over )?18|over 18|confirm|proceed|yes, i understand|i understand|enter|got it|understood|okay|ok|dismiss|close)/i.test(txt)) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { el.click(); out.clicked.push(txt.slice(0, 50)); }
      }
    }
    return out;
  })()`;

  const JS_CLICK_GENERATE = `(() => {
    const btn = document.getElementById('generateButtonEl');
    if (!btn) return { ok: false, reason: 'no #generateButtonEl' };
    if (btn.disabled) return { ok: false, reason: 'button disabled (busy)' };
    btn.click();
    return { ok: true };
  })()`;

  const JS_GET_FRAME_IDS = `[...document.querySelectorAll('iframe.text-to-image-plugin-image-iframe')].map(f => (f.className.match(/\\bid[0-9]{6,}\\b/) || [''])[0]).filter(Boolean)`;

  const JS_FORCE_LOAD_BY_IDS = (ids) => `(() => {
    const wanted = new Set(${JSON.stringify(ids)});
    const loaded = [];
    for (const f of document.querySelectorAll('iframe.text-to-image-plugin-image-iframe')) {
      const cid = (f.className.match(/\\bid[0-9]{6,}\\b/) || [''])[0];
      if (!wanted.has(cid)) continue;
      if (f.dataset && f.dataset.src && !f.src) {
        f.removeAttribute('srcdoc');
        f.src = f.dataset.src;
        loaded.push(cid);
      }
    }
    return loaded;
  })()`;

  const JS_SERVER_STATE = `(() => {
    const img = document.querySelector('img');
    const err = (document.body?.innerText || '').match(/(error|failed|rate.?limit|try again later|disallowed)/i);
    if (img && img.complete && img.naturalWidth >= 200) {
      return { ready: true, w: img.naturalWidth, h: img.naturalHeight };
    }
    return { ready: false, error: err ? err[0] : null, text: (document.body?.innerText || '').trim().slice(0, 60) };
  })()`;

  const JS_SERVER_EXTRACT = `(() => {
    const img = document.querySelector('img');
    if (!img || !img.src || !img.src.startsWith('data:image')) return { ok: false, reason: 'no data-url image' };
    const m = /^data:([^;]+);base64,(.+)$/.exec(img.src);
    return m ? { ok: true, mime: m[1], base64: m[2], w: img.naturalWidth, h: img.naturalHeight } : { ok: false, reason: 'parse fail' };
  })()`;

  const JS_PROBE = `(() => {
    const pick = (el) => ({
      tag: el.tagName.toLowerCase(), id: el.id || null,
      name: (el.dataset && el.dataset.name) || null,
      placeholder: el.placeholder ? el.placeholder.slice(0, 50) : null,
      text: ((el.innerText || el.value || '') + '').trim().slice(0, 50),
      visible: !!el.offsetParent,
    });
    const out = { url: location.href, textareas: [], buttons: [], selects: [], iframes: [], imgs: [] };
    document.querySelectorAll('textarea').forEach(e => out.textareas.push(pick(e)));
    document.querySelectorAll('button, [role=button]').forEach(e => out.buttons.push(pick(e)));
    document.querySelectorAll('select').forEach(e => { const p = pick(e); p.options = [...e.options].map(o => o.text).slice(0, 12); p.count = e.options.length; out.selects.push(p); });
    document.querySelectorAll('iframe.text-to-image-plugin-image-iframe').forEach(e => out.iframes.push({ cls: e.className.slice(0, 60), loaded: !!e.src }));
    document.querySelectorAll('img').forEach(e => out.imgs.push({ w: e.naturalWidth, h: e.naturalHeight, data: (e.src || '').startsWith('data:') }));
    return out;
  })()`;

  const JS_FAIL_STATE = `(() => {
    const btn = document.getElementById('generateButtonEl');
    const cbs = [...document.querySelectorAll('input[type=checkbox]')].map(cb => {
      const byFor = cb.id && document.querySelector('label[for="' + cb.id + '"]');
      return { checked: cb.checked, label: (((byFor && byFor.innerText) || (cb.closest('label') && cb.closest('label').innerText) || (cb.parentElement && cb.parentElement.innerText) || '') + '').trim().slice(0, 50) };
    });
    const text = (document.body?.innerText || '').replace(/\\s+/g, ' ');
    const flaggy = text.match(/.{0,80}(flag|verify|wait|rate|limit|error).{0,80}/i);
    return 'btn=' + (btn ? (btn.disabled ? 'disabled' : 'enabled') + '/' + btn.innerText.trim().slice(0, 20) : 'missing')
      + '; checkboxes=' + JSON.stringify(cbs).slice(0, 200)
      + (flaggy ? '; notice: "' + flaggy[0].trim().slice(0, 160) + '"' : '; no flag text found');
  })()`;

  const norm = (s) => String(s || '')
    .toLowerCase()
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}️]/gu, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  /** Resolve what the writer asked for to an option that actually exists. */
  function resolveOption(options, wanted) {
    if (!options || !options.length) return null;
    const w = String(wanted || '').trim();
    if (!w) return null;
    const exact = options.find((o) => o === w);
    if (exact) return exact;
    const nw = norm(w);
    if (!nw) return null;
    const ci = options.find((o) => norm(o) === nw);
    if (ci) return ci;
    if (/^(default|none|no|any|unset|n a|null|nothing)$/.test(nw)) return null;
    const squash = (x) => norm(x).replace(/ /g, '');
    const sw = squash(w);
    const sq = options.find((o) => squash(o) === sw);
    if (sq) return sq;
    const pre = options.find((o) => norm(o).startsWith(nw) || nw.startsWith(norm(o)));
    if (pre) return pre;
    const wt = new Set(nw.split(' ').filter((t) => t.length > 2));
    if (!wt.size) return null;
    let best = null;
    let bestScore = 0;
    for (const o of options) {
      const ot = norm(o).split(' ').filter((t) => t.length > 2);
      if (!ot.length) continue;
      const hits = ot.filter((t) => wt.has(t)).length;
      if (!hits) continue;
      const score = hits / (ot.length + wt.size - hits);
      if (score > bestScore) { bestScore = score; best = o; }
    }
    return bestScore >= 0.34 ? best : null;
  }

  const RENDER_STALL_MS = 120_000;

  class PerchanceDriver {
    constructor(wv) {
      this.wv = wv;
      this.wcId = null;
      this.busy = false;
      this._unsettled = [];
      this._catalog = {};
      this._catalogAt = {};
      this._catalogLoaded = false;
    }

    id() {
      if (!this.wcId) this.wcId = this.wv.getWebContentsId();
      return this.wcId;
    }

    /** Which generator the app is set to right now. */
    modeId() {
      const want = (window.State?.settings?.gen || {}).generator;
      return GENERATORS[want] ? want : 'classic';
    }

    gen() { return GENERATORS[this.modeId()]; }

    isAdvanced() { return this.gen().advanced; }

    /** Frame exec with hard timeout — a busy/hung frame must never freeze the pipeline. */
    async gexec(js, timeoutMs = 15000) {
      return Promise.race([
        window.ala.pch.execGenerator(this.id(), js),
        new Promise((_, rej) => setTimeout(() => rej(new Error('gexec timeout')), timeoutMs)),
      ]);
    }

    /** Server-frame exec with hard timeout. */
    async sexec(frameId, js, timeoutMs = 15000) {
      return Promise.race([
        window.ala.pch.execServer(this.id(), frameId, js),
        new Promise((_, rej) => setTimeout(() => rej(new Error('sexec timeout')), timeoutMs)),
      ]);
    }

    /** Load — or switch to — the generator the settings currently name. */
    async ensureLoaded(log = () => {}) {
      const g = this.gen();
      const current = this.wv.getURL() || '';
      const onPerchance = /perchance\.org/.test(current);
      if (!onPerchance || !current.includes('/' + g.slug)) {
        log(onPerchance ? `Switching to the ${g.short} generator…` : `Loading Perchance (${g.short})…`);
        await new Promise((resolve) => {
          let timer = null;
          const done = () => { clearTimeout(timer); this.wv.removeEventListener('did-stop-loading', done); resolve(); };
          timer = setTimeout(done, 90000);
          this.wv.addEventListener('did-stop-loading', done);
          this.wv.loadURL(g.url).catch(() => done());
        });
      }
      const t0 = Date.now();
      const ready = JS_READY(g.advanced);
      while (Date.now() - t0 < 90000) {
        try {
          if (await window.ala.pch.hasGenerator(this.id())) {
            try { await this.gexec(JS_DISMISS_GATES); } catch { }
            if (await this.gexec(ready)) { log(`Generator ready (${g.short}).`); return; }
          }
        } catch { }
        await U.sleep(900);
      }
      throw new Error(`Perchance generator UI did not load (${g.label})`);
    }

    async probe() {
      await this.ensureLoaded(() => {});
      const p = await this.gexec(JS_PROBE);
      p.generator = this.gen().id;
      return p;
    }

    /**
     * The catalog is what makes advanced mode legible to a language model: forty control names,
     * their human labels, and every option each one offers.
     */
    catalog(genId = null) {
      return this._catalog[genId || this.modeId()] || null;
    }

    catalogAt(genId = null) {
      return this._catalogAt[genId || this.modeId()] || null;
    }

    async loadCatalogCache() {
      if (this._catalogLoaded) return;
      this._catalogLoaded = true;
      try {
        const d = await window.ala.db.getPchCatalog();
        for (const [k, v] of Object.entries((d && d.generators) || {})) {
          if (v && Array.isArray(v.inputs) && v.inputs.length) {
            this._catalog[k] = v.inputs;
            this._catalogAt[k] = v.at || null;
          }
        }
      } catch { }
    }

    /** Re-read the live page and persist what it offers. */
    async refreshCatalog(log = () => {}) {
      const g = this.gen();
      if (!g.advanced) throw new Error('the classic generator has no named controls to read');
      await this.ensureLoaded(log);
      const inputs = await this.gexec(JS_ADV_CATALOG, 30000);
      if (!Array.isArray(inputs) || !inputs.length) throw new Error('no named controls found on the page');
      const at = Date.now();
      this._catalog[g.id] = inputs;
      this._catalogAt[g.id] = at;
      const total = inputs.reduce((n, i) => n + (i.options ? i.options.length : 0), 0);
      try {
        await this.loadCatalogCache();
        const d = (await window.ala.db.getPchCatalog()) || { generators: {}, version: 1 };
        d.generators = d.generators || {};
        d.generators[g.id] = { at, url: g.url, inputs };
        await window.ala.db.setPchCatalog(d);
      } catch (e) {
        log(`Read the controls but could not save them: ${e.message}`, 'err');
      }
      log(`Read ${inputs.length} control(s) and ${total} option(s) from ${g.label}.`, 'ok');
      return inputs;
    }

    /** Cached if we have it, read from the page if we do not. */
    async ensureCatalog(log = () => {}) {
      if (!this.isAdvanced()) return null;
      await this.loadCatalogCache();
      const have = this.catalog();
      if (have) return have;
      try { return await this.refreshCatalog(log); } catch { return null; }
    }

    /** The dropdowns a writer may choose from: named controls, minus the ones the app owns. */
    filterableInputs() {
      const cat = this.catalog();
      if (!cat) return [];
      return cat.filter((i) => i.tag === 'select' && i.options && i.options.length > 1
        && !ADV_RESERVED.has(i.name));
    }

    /** Turn whatever the writer asked for into exact option text. */
    resolveFilters(filters) {
      const out = { pairs: {}, matched: [], unmatched: [] };
      if (!filters || typeof filters !== 'object') return out;
      const cat = this.catalog();
      const byName = new Map((cat || []).map((i) => [i.name, i]));
      const byLabel = new Map((cat || []).map((i) => [norm(i.label), i]));
      const byNormName = new Map((cat || []).map((i) => [norm(i.name), i]));
      for (const [rawKey, rawVal] of Object.entries(filters)) {
        const key = String(rawKey || '').trim();
        if (!key || rawVal == null || rawVal === '') continue;
        const input = byName.get(key) || byLabel.get(norm(key)) || byNormName.get(norm(key));
        if (!input) { out.unmatched.push(`${key} (no such control)`); continue; }
        if (ADV_RESERVED.has(input.name)) continue;
        if (input.tag !== 'select') { out.pairs[input.name] = String(rawVal); continue; }
        const hit = resolveOption(input.options, rawVal);
        if (!hit) { out.unmatched.push(`${input.name} → "${String(rawVal).slice(0, 40)}"`); continue; }
        out.pairs[input.name] = hit;
        out.matched.push(norm(hit) === norm(rawVal) ? hit : `${hit} (asked "${String(rawVal).slice(0, 30)}")`);
      }
      return out;
    }

    /** Poll until `expected` NEW result frames (by classId, not position) appear. */
    async waitForFrames(markerIds, expected, timeoutMs) {
      const t0 = Date.now();
      const marker = new Set(markerIds);
      while (Date.now() - t0 < timeoutMs) {
        await U.sleep(1000);
        const ids = await this.gexec(JS_GET_FRAME_IDS).catch(() => []);
        const newIds = (ids || []).filter((id) => !marker.has(id));
        if (newIds.length >= expected) {
          await this.gexec(JS_FORCE_LOAD_BY_IDS(newIds)).catch(() => []);
          return newIds;
        }
      }
      const ids = await this.gexec(JS_GET_FRAME_IDS).catch(() => []);
      const newIds = (ids || []).filter((id) => !marker.has(id));
      if (newIds.length > 0) {
        await this.gexec(JS_FORCE_LOAD_BY_IDS(newIds)).catch(() => []);
        return newIds;
      }
      return [];
    }

    /** Wait out renders left over from the previous batch before starting a new one. */
    async settlePrevious(log = () => {}) {
      const leftover = new Set(this._unsettled || []);
      this._unsettled = [];
      if (!leftover.size) return;
      const t0 = Date.now();
      let told = false;
      while (leftover.size && Date.now() - t0 < RENDER_STALL_MS) {
        for (const fid of [...leftover]) {
          let st = null;
          try { st = await this.sexec(fid, JS_SERVER_STATE); } catch { leftover.delete(fid); continue; }
          if (!st || st.ready || st.error) leftover.delete(fid);
        }
        if (!leftover.size) break;
        if (!told) {
          told = true;
          log(`Previous batch still rendering ${leftover.size} image(s) — letting it finish before starting this one.`);
        }
        await U.sleep(2000);
      }
      if (leftover.size) log(`${leftover.size} leftover render(s) never settled — starting anyway.`, 'err');
    }

    /** Accept the generator's terms-of-service dialog when it appears. */
    async handleTermsDialog(log = () => {}, alwaysReport = false) {
      try {
        const res = await this.gexec(JS_HANDLE_TERMS_DIALOG);
        if (res && (res.checked.length || res.clicked.length)) {
          log(`Terms dialog handled: ticked [${res.checked.join(' | ')}]${res.clicked.length ? ' clicked [' + res.clicked.join(' | ') + ']' : ''}`);
        } else if (alwaysReport) {
          log('No terms dialog found on the page.');
        }
      } catch { }
    }

    /** Classic mode: the three heuristic levers, exactly as before. */
    async applyClassicControls({ count, shape, artStyle }, log) {
      const settings = window.State?.settings?.gen || {};
      const wantStyle = artStyle || settings.artStyle;
      const wantShape = shape || settings.shape;
      if (wantStyle) {
        const r = await this.gexec(JS_SET_SELECT('style', wantStyle)).catch(() => null);
        if (r && r.ok) log(`Style: ${r.value}`);
      }
      if (wantShape) {
        await this.gexec(JS_SET_SELECT('shape', wantShape)).catch(() => null);
      }
      if (count > 0) {
        await this.gexec(JS_SET_SELECT('count', String(count))).catch(() => null);
      }
    }

    /**
     * Advanced mode: reset the trait dropdowns, then set the app's defaults and this job's own
     * choices, in that order of precedence.
     */
    async applyAdvancedControls({ count, shape, artStyle, filters }, log) {
      await this.ensureCatalog(log);
      const settings = window.State?.settings?.gen || {};
      const resolved = this.resolveFilters(filters);
      const pairs = { ...resolved.pairs };

      const cat = this.catalog() || [];
      const optionsOf = (name) => (cat.find((i) => i.name === name) || {}).options || null;
      const put = (name, wanted) => {
        if (!wanted || pairs[name]) return;
        const opts = optionsOf(name);
        if (!opts) { pairs[name] = String(wanted); return; }
        const hit = resolveOption(opts, wanted);
        if (hit) pairs[name] = hit;
        else log(`Perchance settings ask for ${name} "${wanted}", which the page no longer offers.`, 'err');
      };
      put('artStyle', artStyle || settings.artStyle);
      put('shape', shape || settings.shape);
      const pin = settings.artStylePin ? String(settings.artStyle || '').trim() : '';
      if (pin) {
        const hit = resolveOption(optionsOf('artStyle') || [], pin);
        if (hit) {
          if (pairs.artStyle && pairs.artStyle !== hit) {
            log(`Art style is pinned to "${hit}" — ignoring "${pairs.artStyle}" for this job.`);
          }
          pairs.artStyle = hit;
        } else {
          log(`Art style is pinned to "${pin}", which the page no longer offers — letting the job choose.`, 'err');
        }
      }
      if (!pairs.artStyle) {
        log('No art style for this job — the page will use whatever it is currently set to.'
          + ' Set one in Settings → Perchance if this keeps producing the wrong look.', 'err');
      }
      put('gScale', settings.advGuidance);
      if (count > 0) put('numImages', String(count));

      const resetNames = settings.advResetFilters === false ? [] : this.filterableInputs()
        .map((i) => i.name)
        .filter((n) => !ADV_NO_RESET.has(n) && !(n in pairs));

      const res = await this.gexec(JS_ADV_APPLY(pairs, resetNames), 30000).catch((e) => ({ error: e.message }));
      if (!res || res.error) {
        log(`Could not set the generator's controls: ${(res && res.error) || 'no response'}`, 'err');
        return;
      }
      const set = Object.entries(res.set || {});
      if (set.length) log(`Controls: ${set.map(([k, v]) => `${k}=${v}`).join(' · ')}`);
      if (resolved.unmatched.length) {
        log(`Skipped ${resolved.unmatched.length} control(s) the page does not offer: ${resolved.unmatched.slice(0, 6).join(', ')}`, 'err');
      }
      if (res.missed && res.missed.length) {
        log(`The page rejected: ${res.missed.slice(0, 6).join(', ')}`, 'err');
      }
    }

    /** Generate images for a prompt. */
    async generate(promptText, { timeoutMs = 240000, count = 0, shape = '', artStyle = '', filters = null } = {}, log = () => {}) {
      if (this.busy) throw new Error('driver busy');
      this.busy = true;
      const t0 = Date.now();
      try {
        await this.ensureLoaded(log);
        await this.settlePrevious(log);
        const advanced = this.isAdvanced();

        if (advanced) await this.applyAdvancedControls({ count, shape, artStyle, filters }, log);
        else await this.applyClassicControls({ count, shape, artStyle }, log);

        const expected = await this.gexec(JS_READ_COUNT(advanced)).catch(() => 6) || 6;

        const setRes = await this.gexec(JS_SET_PROMPT(promptText, advanced));
        if (!setRes || !setRes.ok) throw new Error('could not set prompt: ' + (setRes && setRes.reason));
        await U.sleep(900);

        const markerIds = await this.gexec(JS_GET_FRAME_IDS).catch(() => []);

        const clickRes = await this.gexec(JS_CLICK_GENERATE);
        if (!clickRes || !clickRes.ok) throw new Error('could not click generate: ' + (clickRes && clickRes.reason));
        log(`Generating ${expected} image(s)…`);

        let frameIds = [];
        for (let attempt = 0; attempt < 3 && !frameIds.length; attempt++) {
          if (attempt > 0) {
            const retry = await this.gexec(JS_CLICK_GENERATE).catch(() => null);
            if (retry && retry.ok) log(`Re-clicked generate (attempt ${attempt + 1}).`);
          }
          await U.sleep(1500);
          await this.handleTermsDialog(log);
          frameIds = await this.waitForFrames(markerIds, expected, attempt === 0 ? 25000 : 40000);
          if (!frameIds.length && attempt < 2) log('Click did not register — probing for a dialog and re-clicking…');
        }
        if (!frameIds.length) {
          const state = await this.gexec(JS_FAIL_STATE).catch(() => null);
          throw new Error('no result frames appeared after clicking generate' + (state ? ` — page state: ${state}` : ''));
        }
        log(`${frameIds.length} result slot(s) — waiting for renders…`);

        const images = [];
        const pending = new Set(frameIds);
        let lastLanded = Date.now();
        while (pending.size) {
          const now = Date.now();
          if (now > Math.max(t0 + timeoutMs, lastLanded + RENDER_STALL_MS)
            || now > t0 + timeoutMs * 2) break;
          await U.sleep(2000);
          for (const fid of [...pending]) {
            let st;
            try { st = await this.sexec(fid, JS_SERVER_STATE); } catch { continue; }
            if (st && st.ready) {
              const ext = await this.sexec(fid, JS_SERVER_EXTRACT).catch(() => null);
              if (ext && ext.ok && ext.base64.length > 2000) {
                images.push({ base64: ext.base64, mime: ext.mime || 'image/jpeg', w: ext.w, h: ext.h });
              }
              pending.delete(fid);
              lastLanded = Date.now();
            } else if (st && st.error) {
              log(`Render slot error: ${st.error}`, 'err');
              pending.delete(fid);
              lastLanded = Date.now();
            }
          }
        }
        if (pending.size) {
          this._unsettled = [...pending];
          log(`${pending.size} slot(s) still rendering after the wait — giving up on them; `
            + `the next job will let them settle before it starts.`, 'err');
        }
        return { images, count: expected };
      } finally {
        this.busy = false;
        try { if (this.wv) this.wv.blur(); window.focus(); } catch { }
      }
    }
  }

  window.PerchanceDriver = PerchanceDriver;
  window.PERCHANCE_GENERATORS = GENERATORS;
  window.PERCHANCE_MAIN_URL = GENERATORS.classic.url;
  window.PERCHANCE_RESOLVE_OPTION = resolveOption;
  window.PERCHANCE_ADV_RESERVED = ADV_RESERVED;
})();
