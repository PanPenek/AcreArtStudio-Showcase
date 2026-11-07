/**
 * overseerui.js: the Overseer tab: transcript, composer (with image
 * attachments), and the switches that decide what the assistant may do on its own.
 *
 * Design rule: every tool call is shown, collapsed but always visible. An agent
 * you cannot audit is an agent you cannot trust with a schedule, and "it said it
 * queued ten images" is not the same as "queue_art returned queued: 10".
 */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => U.escapeHtml(s);
  const num = (n) => Number(n || 0).toLocaleString();
  const O = () => window.Overseer;
  const cfg = () => (State.settings && State.settings.overseer) || {};

  const TOOL_VERB = {
    read_state: 'Checked the app',
    read_stats: 'Read the numbers',
    read_playbook: 'Read the playbook',
    web_research: 'Researched the web',
    write_research_prompts: 'Wrote researched prompts',
    queue_research_prompts: 'Queued researched prompts',
    list_cards: 'Listed cards',
    sync_stats: 'Refreshed DeviantArt (free)',
    learn: 'Rebuilt the playbook',
    queue_art: 'Queued art',
    reorder_queue: 'Reordered the queue',
    cancel_queued: 'Cancelled queued jobs',
    worker: 'Worker',
    auto_mode: 'Auto mode',
    wait_for_worker: 'Waited for the worker',
    write_metadata: 'Wrote metadata',
    approve: 'Approved',
    discard: 'Discarded',
    submit: 'Upload result',
    remember: 'Updated the standing brief',
    set_model: 'Switched model',
    set_workflow: 'Switched workflow',
  };

  const THINK_HTTP = [['auto', 'default'], ['none', 'off'], ['minimal', 'minimal'], ['low', 'low'], ['medium', 'medium'], ['high', 'high']];
  const THINK_CLI = [['auto', 'default'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max']];
  const kTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 2 : 0).replace(/\.?0+$/, '')}M`
    : n >= 1000 ? `${(n / 1000).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '')}k` : String(n));
  const parseTok = (s) => {
    const m = String(s || '').trim().toLowerCase().replace(/[\s,_]/g, '').match(/^(\d+(?:\.\d+)?)([km]?)$/);
    if (!m) return null;
    return Math.round(Number(m[1]) * (m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1000 : 1));
  };

  const OverseerUI = {
    _wired: false,
    _previewCache: new Map(),
    _previewPending: new Map(),

    wire() {
      if (this._wired) return;
      this._wired = true;

      $('#btn-ov-send').addEventListener('click', () => this.send());
      this.wireAttachments();
      $('#ov-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.repeat) { e.preventDefault(); this.send(); }
      });

      $('#ov-strip').addEventListener('click', (e) => this.onStripClick(e));
      $('#ov-modes').addEventListener('click', (e) => this.onStripClick(e));
      $('#ov-thread').addEventListener('click', (e) => {
        const open = e.target.closest('[data-web-url]');
        if (open) {
          const url = open.dataset.webUrl || '';
          if (/^https?:\/\//i.test(url)) window.ala.app.openExternal(url);
          return;
        }
        const copy = e.target.closest('[data-copy-prompt]');
        if (copy) {
          const found = O()?.promptSet(copy.dataset.copyPrompt, copy.dataset.researchId || '');
          const prompt = found?.set?.prompts?.[Number(copy.dataset.promptIndex)];
          if (prompt) window.ala.clip.text(prompt).then(() => window.toast?.('Prompt copied.', 'ok'));
          return;
        }
        const choice = e.target.closest('[data-ov-choice]');
        if (choice) {
          choice.closest('.ov-choice')?.querySelectorAll('button').forEach((b) => { b.disabled = true; });
          O()?.answerChoice(choice.dataset.ovChoice);
          return;
        }
        const att = e.target.closest('[data-ov-att]');
        if (att) { att.classList.toggle('big'); return; }
        const think = e.target.closest('.ov-think-head');
        if (think) { think.parentElement.classList.toggle('open'); return; }
        const head = e.target.closest('.ov-tool-head');
        if (head) { head.parentElement.classList.toggle('open'); return; }
        if (e.target.closest('[data-ov]')) this.onStripClick(e);
      });

      const eng = $('#ov-engine');
      if (eng) {
        eng.addEventListener('click', (e) => this.onEngineClick(e));
        eng.addEventListener('change', (e) => this.onEngineChange(e));
      }
      State.on('llm', () => this.renderEngine());
      this.wireChats();
      document.addEventListener('mousedown', (e) => {
        if (this._statusOpen && !e.target.closest('#ov-strip')) { this._statusOpen = false; this.renderStrip(); }
      });

      State.on('overseer', () => this.render());
      State.on('queue', () => this.renderStrip());
      State.on('library', () => {
        this.renderStrip();
        if (!((O() && O().messages) || []).length) this.renderThread();
      });
      this.render();
    },

    focusInput() {
      const el = $('#ov-input');
      if (el) el.focus();
      this.refreshVision();
      this.maybeRefreshEngines(true);
    },

    /** Can the Overseer's chain read pictures at all? */
    async refreshVision() {
      try {
        const r = await window.ala.llm.route('overseer');
        this._vision = !!(r && r.vision);
        this._visionNames = (r && r.visionProviders) || [];
        this._describedBy = (r && r.describedBy) || [];
      } catch {
        this._describedBy = [];
        this._vision = false;
        this._visionNames = [];
      }
      const btn = $('#btn-ov-attach');
      if (btn) {
        btn.disabled = !this._vision;
        btn.title = this._vision
          ? `Attach images — paste or drop works too. Read by ${this._visionNames.join(' → ') || '—'}${this._describedBy.length ? `; text-only models get a description from ${this._describedBy.join(' → ')}` : ''}.`
          : 'No vision-capable model is routed to the Overseer. In Settings → Providers, tick "can see images" on a provider that can, and put it in the Overseer route.';
      }
      return this._vision;
    },

    /** Files from the picker, a paste or a drop → saved to disk → chips above the composer. */
    async addFiles(fileList) {
      const files = [...(fileList || [])].filter((f) => f && /^image\/(png|jpeg|webp|gif)$/.test(f.type));
      if (!files.length) return;
      if (!(await this.refreshVision())) {
        window.toast?.('The Overseer has no vision-capable model routed, so it could not see an attached image. See Settings → Providers.', 'err');
        return;
      }
      const room = 6 - this._attach.length;
      if (room <= 0) { window.toast?.('Six images per message is the limit.', 'err'); return; }
      if (files.length > room) window.toast?.(`Only the first ${room} image(s) were attached (six per message).`, 'err');
      for (const f of files.slice(0, room)) {
        const chip = { key: U.uid(), name: f.name || 'pasted image', busy: true };
        this._attach.push(chip);
        this.renderAttachStrip();
        try {
          if (f.size > 20 * 1024 * 1024) throw new Error('larger than 20 MB');
          const base64 = await new Promise((resolve, reject) => {
            const rd = new FileReader();
            rd.onload = () => resolve(String(rd.result).split(',')[1] || '');
            rd.onerror = () => reject(new Error('could not read the file'));
            rd.readAsDataURL(f);
          });
          const dims = await new Promise((resolve) => {
            const im = new Image();
            im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
            im.onerror = () => resolve({ w: null, h: null });
            im.src = `data:${f.type};base64,${base64}`;
          });
          const saved = await window.ala.files.saveAttachment(base64, f.type, chip.name);
          Object.assign(chip, { busy: false, fname: saved.fname, mime: saved.mime, url: saved.url, ...dims });
        } catch (e) {
          this._attach = this._attach.filter((c) => c !== chip);
          window.toast?.(`Could not attach ${chip.name}: ${String(e.message || e).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')}`, 'err');
        }
        this.renderAttachStrip();
      }
    },

    removeAttachment(key) {
      const chip = this._attach.find((c) => c.key === key);
      if (!chip || chip.busy) return;
      this._attach = this._attach.filter((c) => c !== chip);
      if (chip.fname) window.ala.files.deleteAttachment(chip.fname).catch(() => {});
      this.renderAttachStrip();
    },

    renderAttachStrip() {
      const strip = $('#ov-attach-strip');
      if (!strip) return;
      strip.hidden = !this._attach.length;
      strip.innerHTML = this._attach.map((c) => (c.busy
        ? `<div class="ov-chip busy" title="${esc(c.name)}">saving…</div>`
        : `<div class="ov-chip" title="${esc(c.name)}${c.w ? ` · ${c.w}×${c.h}` : ''}">
            <img src="ala://ovr/${encodeURIComponent(c.fname)}" alt="" />
            <button class="ov-chip-x" data-remove-att="${esc(c.key)}" title="Remove">×</button>
          </div>`)).join('');
    },

    wireAttachments() {
      this._attach = [];
      const file = $('#ov-file');
      const btn = $('#btn-ov-attach');
      if (!file || !btn) return;
      btn.addEventListener('click', () => { if (!btn.disabled) file.click(); });
      file.addEventListener('change', () => { this.addFiles(file.files); file.value = ''; });
      $('#ov-attach-strip').addEventListener('click', (e) => {
        const x = e.target.closest('[data-remove-att]');
        if (x) this.removeAttachment(x.dataset.removeAtt);
      });
      $('#ov-input').addEventListener('paste', (e) => {
        const imgs = [...((e.clipboardData && e.clipboardData.files) || [])].filter((f) => /^image\//.test(f.type));
        if (!imgs.length) return;
        e.preventDefault();
        this.addFiles(imgs);
      });
      const pane = $('#pane-overseer');
      const composer = $('#ov-composer');
      const hasFiles = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
      pane.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); composer.classList.add('drop'); });
      pane.addEventListener('dragleave', (e) => { if (e.target === pane || !pane.contains(e.relatedTarget)) composer.classList.remove('drop'); });
      pane.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        composer.classList.remove('drop');
        this.addFiles(e.dataTransfer.files);
      });
      this.refreshVision();
    },

    /** Send the composer's message. */
    async send() {
      const el = $('#ov-input');
      const text = el.value.trim();
      if (!O()) return;
      if ((this._attach || []).some((c) => c.busy)) { window.toast?.('Still saving an attached image — one moment.', 'err'); return; }
      const attachments = (this._attach || []).map(({ fname, mime, name, w, h }) => ({ fname, mime, name, w, h }));
      if (!text && !attachments.length) return;
      el.value = '';
      this._attach = [];
      this.renderAttachStrip();
      await O().ask(text, attachments);
    },

    async onStripClick(e) {
      const btn = e.target.closest('[data-ov]');
      if (!btn) return;
      const act = btn.dataset.ov;
      const ov = O();
      if (act === 'status') { this._statusOpen = !this._statusOpen; return this.renderStrip(); }
      if (act === 'stop') return ov.ask('stop');
      if (act === 'agent-on') return ov.start();
      if (act === 'agent-off') return ov.stop();
      if (act === 'run-now') {
        if (ov.busy) return;
        return ov.runCycle('by hand');
      }
      if (act === 'clear') {
        if (ov.busy) return;
        if (!confirm('Clear the conversation? The Overseer\'s memory of what you have asked for goes with it — your settings and the standing brief stay.')) return;
        return ov.clear();
      }
      if (act === 'brief') {
        const next = await askText('Standing brief — what should it work on when nobody has asked it anything?',
          cfg().brief || '', { multiline: true });
        if (next == null) return;
        return ov.patch({ brief: String(next).trim().slice(0, 1200) });
      }
      if (act === 'settings') {
        document.querySelector('.nav-btn[data-tab="settings"]').click();
        const nav = document.querySelector('.set-nav-btn[data-sec="overseer"]');
        if (nav) nav.click();
      }
      if (act === 'show-work') {
        document.querySelector('.nav-btn[data-tab="review"]').click();
        const chip = document.querySelector('#review-filters .chip[data-filter="agent"]');
        if (chip) chip.click();
      }
    },

    render() {
      const busy = !!(O() && O().busy);
      if (busy) this.startTick(); else this.stopTick();
      if (!$('#pane-overseer')) return;
      this.renderModes();
      this.renderStrip();
      this.renderChats();
      this.renderEngine();
      this.maybeRefreshEngines();
      this.renderThread();
    },

    engineSig() {
      const s = State.settings || {};
      const lm = s.lmStudio || {};
      return JSON.stringify([
        (s.routing || {}).overseer, (s.routing || {}).vision, (s.routing || {}).fallbackLocal,
        (s.providers || []).map((p) => [p.id, p.name, p.enabled, p.vision, p.models, p.model, p.reasoningEffort, p.args, p.contextWindows, p.roles]),
        lm.models, lm.model, lm.reasoningEffort, lm.contextWindows, lm.baseUrl,
      ]);
    },

    async maybeRefreshEngines(force = false) {
      const ov = O();
      if (!ov || !ov.refreshEngines || this._engBusy) return;
      const sig = this.engineSig();
      const stale = !ov._engines || Date.now() - ov._engines.at > 5 * 60_000;
      if (!force && sig === this._engSig && !stale) return;
      this._engSig = sig;
      this._engBusy = true;
      try { await ov.refreshEngines(); } catch {  }
      this._engBusy = false;
      this.renderEngine();
    },

    renderEngine() {
      const root = $('#ov-engine');
      if (!root) return;
      const ov = O();
      const e = (ov && ov._engines) || null;
      const m = e && e.main;
      const v = e && e.vision;
      const shortModel = (s) => String(s || 'its default').split('/').pop().replace(/:.*$/, '');
      const chip = (role, x, label) => {
        const what = !x ? 'reading…'
          : x.none ? '<em>nothing can answer</em>'
            : `<b>${esc(shortModel(x.model))}</b>`;
        const tip = !x ? '' : x.none ? `Nothing in the route can answer: ${x.reason || ''}`
          : `${label}: ${x.provider} · ${x.model || 'its default'}${x.fallbacks && x.fallbacks.length ? `\nIf it fails: ${x.fallbacks.join(' → ')}` : ''}\n${role === 'vision'
            ? 'The vision model inspects every render (QC) and reads attached pictures for a text-only main model.'
            : 'The model the Overseer itself runs on.'}\nClick to switch.`;
        return `<button class="ov-eng-chip" data-ov-eng="${role}" title="${esc(tip)}"><span class="ov-eng-ico" aria-label="${label}">${role === 'vision' ? '👁' : '✦'}</span><span class="ov-eng-v">${what}</span><span class="ov-eng-caret">▾</span></button>`;
      };
      const kind = m && !m.none ? m.effortKind : 'none';
      const opts = kind === 'cli' ? THINK_CLI : THINK_HTTP;
      const cur = m && !m.none ? (m.effort || 'auto') : 'auto';
      const think = `<label class="ov-eng-think" title="${esc(kind === 'none' ? 'This engine has no thinking switch the app can set.'
        : 'Thinking — how hard the main model may think before it answers. Thinking tokens are billed as output and add wait.')}"><span class="ov-eng-ico" aria-label="Thinking">🧠</span>
        <select data-ov-think ${kind === 'none' || !m || m.none ? 'disabled' : ''}>${opts.map(([val, t]) => `<option value="${val}" ${cur === val ? 'selected' : ''}>${t}</option>`).join('')}
          ${opts.some(([val]) => val === cur) ? '' : `<option value="${esc(cur)}" selected>${esc(cur)}</option>`}</select></label>`;

      const win = m && !m.none ? m.contextWindow : null;
      const msgs = (ov && ov.messages) || [];
      const used = msgs.length && ov && ov.contextUsed ? ov.contextUsed() : (msgs.length ? null : 0);
      const pct = win && used != null ? Math.min(100, (used / win) * 100) : null;
      const level = pct == null ? '' : pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '';
      const ctxTip = `${used != null ? `${num(used)} tokens in the last step (the provider's own count: system prompt + conversation + state block + reply).` : 'Fills in after the first reply this session.'}\n`
        + `${win ? `Window: ${num(win)} tokens — ${m.contextSource}.` : `Window: unknown — ${(m && m.contextSource) || 'no engine'}.`}\nClick to set the window by hand.`;
      const ctx = `<button class="ov-ctx ${level}" data-ov-ctx title="${esc(`Context window\n${ctxTip}`)}">
        <span class="ov-ctx-bar"><i style="width:${pct == null ? 0 : Math.max(pct, used ? 1.5 : 0).toFixed(1)}%"></i></span>
        <span class="ov-ctx-n">${used != null ? kTok(used) : '—'} / ${win ? kTok(win) : '?'}${pct != null ? ` · ${pct < 1 && used ? '<1' : Math.round(pct)}%` : ''}</span></button>`;

      const html = `${chip('main', m, 'Model')}${think}${chip('vision', v, 'Vision')}${ctx}`;
      if (html !== this._engHtml) { root.innerHTML = html; this._engHtml = html; }
    },

    async onEngineChange(e) {
      const sel = e.target.closest('[data-ov-think]');
      if (sel) {
        const r = await O().setModel({ role: 'main', thinking: sel.value }, { fromUi: true });
        this.engineToast(r, 'Thinking');
        return;
      }
    },

    async onEngineClick(e) {
      const role = e.target.closest('[data-ov-eng]');
      if (role) { this.openEnginePop(role.dataset.ovEng); return; }
      if (e.target.closest('[data-ov-ctx]')) { this.editContext(); return; }
    },

    engineToast(r, what) {
      if (!r) return;
      if (r.ok) {
        window.toast?.(r.changed ? `${what}: ${r.to}${r.notes ? ` (${r.notes.join('; ')})` : ''}` : `${what}: already ${r.to}`, 'ok');
      } else {
        window.toast?.(`${r.error || 'Could not switch.'}${r.candidates ? ` — ${r.candidates.slice(0, 4).join(', ')}…` : ''}`, 'err');
      }
    },

    closeEnginePop() {
      const pop = $('#ov-engine-pop');
      if (pop) pop.remove();
      this._engPop = null;
    },

    async openEnginePop(role) {
      if (this._engPop && this._engPop.role === role) { this.closeEnginePop(); return; }
      this.closeEnginePop();
      const ov = O();
      const composer = $('#ov-composer');
      const chip = document.querySelector(`[data-ov-eng="${role}"]`);
      if (!composer) return;
      const route = await window.ala.llm.route(role === 'vision' ? 'vision' : 'overseer').catch(() => null);
      const rows = ((route && route.order) || []).map((r) => ({
        ...r, pickable: r.eligible || r.reason === 'no model set for this role',
      }));
      if (!this._catCache) this._catCache = new Map();
      const st = { role, rows, cur: ov._engines && ov._engines[role === 'vision' ? 'vision' : 'main'] };
      this._engPop = st;
      const pop = document.createElement('div');
      pop.id = 'ov-engine-pop';
      pop.className = 'ov-mp';
      pop.innerHTML = `<input type="search" id="ov-mp-q" placeholder="Search models" spellcheck="false" autocomplete="off" />
        <div class="ov-mp-list" id="ov-mp-list"></div>
        <div class="ov-mp-foot" id="ov-mp-msg">${role === 'vision' ? 'Vision — checks renders, reads pictures for a text-only model' : 'Main model — the Overseer runs on it'} · the rest of the route stays as fallback</div>`;
      composer.appendChild(pop);
      if (chip) {
        const left = chip.getBoundingClientRect().left - composer.getBoundingClientRect().left;
        pop.style.left = `${Math.max(0, Math.min(left, composer.clientWidth - pop.offsetWidth))}px`;
      }
      const q = $('#ov-mp-q');
      q.addEventListener('input', () => this.renderModelList());
      pop.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); this.closeEnginePop(); }
        if (e.key === 'Enter') { e.preventDefault(); const first = pop.querySelector('[data-mp-p]'); if (first) first.click(); }
      });
      pop.addEventListener('click', (e) => {
        const r = e.target.closest('[data-mp-p]');
        if (r) this.pickModel(r.dataset.mpP, r.dataset.mpM);
      });
      if (!this._mpOutside) {
        this._mpOutside = true;
        document.addEventListener('mousedown', (e) => {
          if (this._engPop && !e.target.closest('#ov-engine-pop') && !e.target.closest('[data-ov-eng]')) this.closeEnginePop();
        });
      }
      this.renderModelList();
      q.focus();
      for (const r of rows) {
        const p = (State.settings.providers || []).find((x) => x.id === r.id);
        if (!r.pickable || (p && p.kind === 'cli')) continue;
        const hit = this._catCache.get(r.id);
        if (hit && Date.now() - hit.at < 600_000) continue;
        window.ala.llm.catalog(r.id)
          .then((cat) => ({ cat }), (e) => ({ error: String(e.message || e).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '') }))
          .then((res) => { this._catCache.set(r.id, { at: Date.now(), ...res }); if (this._engPop === st) this.renderModelList(); });
      }
    },

    modelFor(providerId, role) {
      const s = State.settings || {};
      const r = role === 'vision' ? 'vision' : 'overseer';
      if (providerId === 'local') { const lm = s.lmStudio || {}; return (lm.models || {})[r] || lm.model || ''; }
      const p = (s.providers || []).find((x) => x.id === providerId);
      return (p && ((p.models || {})[r] || p.model)) || '';
    },

    recentModels() {
      try { return JSON.parse(localStorage.getItem('ala.ovRecentModels') || '[]'); } catch { return []; }
    },

    /**
     * The model picker: provider sections with the current model, recent picks and search over
     * each provider's model list, with a live price line per model.
     */
    renderModelList() {
      const st = this._engPop;
      const box = $('#ov-mp-list');
      if (!st || !box) return;
      const q = (($('#ov-mp-q') || {}).value || '').trim().toLowerCase();
      const recent = this.recentModels();
      const cur = st.cur && !st.cur.none ? st.cur : null;
      const short = (id) => String(id || '').split('/').pop();
      const usd = (v) => (v == null ? 'n/a' : v === 0 ? '$0' : `$${v < 0.1 ? +v.toFixed(3) : +v.toFixed(2)}`);
      const priceOf = (c, local) => {
        if (local) return '<span class="ov-mp-price">free · local</span>';
        const pr = c && c.price;
        if (!pr) return '<span class="ov-mp-price na" title="This provider\'s model list does not report prices">cost n/a</span>';
        return `<span class="ov-mp-price" title="USD per 1M tokens, read live from the provider's model list">in ${usd(pr.in)} · hit ${usd(pr.cacheHit)} · out ${usd(pr.out)} <em>/1M</em></span>`;
      };
      const item = (pid, id, meta = '', extra = '', price = '') => {
        const on = cur && cur.providerId === pid && String(cur.model || '') === String(id || '');
        return `<div class="ov-mp-row ${on ? 'on' : ''} ${extra}" data-mp-p="${esc(pid)}" data-mp-m="${esc(id)}" title="${esc(id || 'its default')}">
          <span class="nm">${esc(short(id) || 'its default')}</span><span class="meta">${meta}</span><span class="ck">${on ? '✓' : ''}</span>${price}</div>`;
      };
      const metaOf = (c) => `${c && c.contextWindow ? kTok(c.contextWindow) : ''}${c && c.vision ? ' 👁' : ''}`;
      let html = '';
      let shown = 0;
      for (const r of st.rows) {
        const p = (State.settings.providers || []).find((x) => x.id === r.id);
        const isCli = !!(p && p.kind === 'cli');
        if (!r.pickable) {
          if (!q) html += `<div class="ov-mp-h dis" title="${esc(r.reason || '')}">${esc(r.name)} <em>— ${esc(r.reason || 'unavailable')}</em></div>`;
          continue;
        }
        const c = this._catCache && this._catCache.get(r.id);
        const list = c && Array.isArray(c.cat) ? (st.role === 'vision' ? c.cat.filter((x) => x.vision !== false) : c.cat) : null;
        const byId = new Map((list || []).map((x) => [x.id, x]));
        let ids;
        if (q) {
          ids = (list || []).filter((x) => String(x.id).toLowerCase().includes(q)).slice(0, 30).map((x) => x.id);
        } else {
          const set = this.modelFor(r.id, st.role);
          ids = [set, ...recent.filter((x) => x.p === r.id && x.r === st.role).map((x) => x.m)];
          if (list && list.length <= 8) ids.push(...list.map((x) => x.id));
          ids = [...new Set(ids.filter((x) => x !== undefined && x !== null && (x !== '' || isCli)))];
          if (!ids.length && isCli) ids = [''];
        }
        const local = r.id === 'local' || !!(list && list[0] && list[0].local);
        const rowsHtml = ids.map((id) => item(r.id, id, metaOf(byId.get(id)), '', isCli ? '<span class="ov-mp-price na">cost n/a · subscription CLI</span>' : priceOf(byId.get(id), local))).join('');
        const typed = q && !ids.some((id) => String(id).toLowerCase() === q) && (isCli || (list && !ids.length) || (c && c.error))
          ? item(r.id, ($('#ov-mp-q') || {}).value.trim(), 'use this id', 'typed') : '';
        if (q && !rowsHtml && !typed) continue;
        const count = list ? `${list.length}` : c && c.error ? 'list unavailable' : isCli ? 'CLI' : '…';
        html += `<div class="ov-mp-h">${esc(r.name)} <em>${esc(count)}</em></div>${rowsHtml}${typed}`;
        if (list) shown += list.length;
      }
      const qi = $('#ov-mp-q');
      if (qi && shown) qi.placeholder = `Search ${num(shown)} models`;
      box.innerHTML = html || `<div class="ov-mp-more">${q ? 'No model matches.' : 'No provider can serve this role — Settings → Providers.'}</div>`;
    },

    async pickModel(provider, model) {
      const st = this._engPop;
      if (!st) return;
      const msg = $('#ov-mp-msg');
      if (msg) msg.textContent = 'Switching…';
      const r = await O().setModel({ role: st.role, provider, model }, { fromUi: true })
        .catch((e) => ({ ok: false, error: e.message }));
      this.engineToast(r, st.role === 'vision' ? 'Vision' : 'Model');
      if (r && r.ok) {
        const rec = [{ p: provider, m: model, r: st.role }, ...this.recentModels().filter((x) => !(x.p === provider && x.m === model && x.r === st.role))].slice(0, 12);
        try { localStorage.setItem('ala.ovRecentModels', JSON.stringify(rec)); } catch {  }
        this.closeEnginePop();
        this._engSig = this.engineSig();
        this.renderEngine();
      } else if (msg) msg.textContent = (r && r.error) || 'Could not switch.';
    },

    async editContext() {
      const ov = O();
      const m = ov._engines && ov._engines.main;
      if (!m || m.none) return;
      const next = await askText(`Context window of ${m.model || m.provider}, in tokens (e.g. 128k, 1M). Leave blank to read it from the provider again.\nNow: ${m.contextWindow ? num(m.contextWindow) : 'unknown'} — ${m.contextSource}.`,
        m.contextSource === 'set by you' && m.contextWindow ? String(m.contextWindow) : '');
      if (next == null) return;
      const n = String(next).trim() ? parseTok(next) : 0;
      if (n == null || (n && n < 512)) { window.toast?.('That is not a token count — try 128k, 1M or 131072.', 'err'); return; }
      await ov.setContextWindow(n);
      this._engSig = this.engineSig();
      this.renderEngine();
    },

    renderModes() {
      const o = cfg();
      const agent = !!o.enabled && o.mode === 'agent';
      $('#ov-modes').innerHTML = `
        <div class="ov-mode-row">
          <span class="ov-mode ${agent ? '' : 'on'}">Helper</span>
          <button class="ov-switch ${agent ? 'on' : ''}" data-ov="${agent ? 'agent-off' : 'agent-on'}"
            title="${agent ? 'Stop waking on a schedule' : 'Wake on a schedule and work to the standing brief until switched off'}"><span></span></button>
          <span class="ov-mode ${agent ? 'on' : ''}">Agent</span>
        </div>`;
    },

    renderStrip() {
      const strip = $('#ov-strip');
      if (!strip) return;
      const o = cfg();
      const ov = O();
      const agent = !!o.enabled && o.mode === 'agent';
      const sched = o.schedule || {};
      const gate = o.approval === 'auto';
      const lib = State.library || [];
      const mine = lib.filter((c) => c.promptSource === 'overseer');
      const waiting = mine.filter((c) => c.status === 'review').length;
      const queued = (State.queue || []).filter((j) => j.status === 'queued').length;
      const nextAt = sched.nextAt ? new Date(sched.nextAt) : null;
      const spend = this.spentToday();

      const open = !!this._statusOpen;
      const label = waiting ? `${num(waiting)} in Review` : agent ? 'Agent on' : 'Status';
      strip.innerHTML = `
      <button class="ov-status-btn ${open ? 'on' : ''}" data-ov="status" type="button" title="Standing brief, schedule, publishing, its work, tokens today">ⓘ ${esc(label)} ▾</button>
      ${ov && ov.busy ? `<button class="btn small" data-ov="stop" ${ov._abort ? 'disabled' : ''}>${ov._abort ? 'Stopping…' : 'Stop'}</button>` : ''}
      ${agent ? `<button class="btn ghost small" data-ov="run-now" ${ov && ov.busy ? 'disabled' : ''}>Run now</button>` : ''}
      <div class="ov-status-pop" ${open ? '' : 'hidden'}>
      <div class="ov-cells">
        <div class="ov-cell">
          <span class="ov-k">Standing brief</span>
          <button class="ov-v link" data-ov="brief" title="Click to edit">${o.brief ? esc(o.brief.slice(0, 160)) + (o.brief.length > 160 ? '…' : '') : '<em>not set — click to write one</em>'}</button>
        </div>
        <div class="ov-cell">
          <span class="ov-k">Next run</span>
          <span class="ov-v">${agent
            ? (nextAt ? esc(nextAt.toLocaleString()) + (sched.jitter ? ' <em>· jittered</em>' : '') : 'working it out…')
            : '<em>helper mode — only when you ask</em>'}</span>
        </div>
        <div class="ov-cell">
          <span class="ov-k">Publishing</span>
          <span class="ov-v ${gate ? 'warn' : ''}">${gate
            ? 'automatic, through the gate'
            : 'waits for you'} <button class="ov-v link tiny" data-ov="settings">change</button></span>
        </div>
        <div class="ov-cell">
          <span class="ov-k">Its work</span>
          <span class="ov-v">${mine.length} card(s) · ${waiting
            ? `<button class="ov-v link" data-ov="show-work">${waiting} waiting in Review →</button>`
            : 'none waiting'}${queued ? ` · ${queued} queued` : ''}</span>
        </div>
        <div class="ov-cell">
          <span class="ov-k">Tokens today</span>
          <span class="ov-v" title="Read from each provider's own usage block, not estimated. Cached input is billed at a fraction of fresh input.">${spend.runs
            ? `${num(spend.in)} in · ${num(spend.out)} out${spend.cached ? ` · ${Math.round((spend.cached / spend.in) * 100)}% cached` : ''} <em>over ${spend.runs} turn(s)</em>`
            : '<em>nothing spent today</em>'}</span>
        </div>
      </div>
      <div class="ov-actions"><span class="hint">${this.engineLine()}</span></div>
      </div>`;
    },


    /** The chat bar: current chat name (click to rename), Chats ▾ with search, + New chat. */
    wireChats() {
      const bar = $('#ov-chats');
      if (!bar) return;
      bar.innerHTML = `
        <button class="ov-chat-cur" id="ov-chat-cur" type="button" title="Click to rename this chat"></button>
        <button class="btn ghost small" id="ov-chat-list" type="button" title="Earlier chats — search and reopen">Chats ▾</button>
        <button class="btn ghost small" id="ov-chat-new" type="button" title="Start a new chat. This one is kept under Chats ▾.">+ New chat</button>
        <div class="ov-chat-pop" id="ov-chat-pop" hidden>
          <input type="search" id="ov-chat-q" placeholder="Search chats by name…" spellcheck="false" />
          <div class="ov-chat-rows" id="ov-chat-rows"></div>
        </div>`;
      const pop = $('#ov-chat-pop');
      const q = $('#ov-chat-q');
      const busyToast = () => window.toast && window.toast('Wait for the Overseer to finish (or press Stop) before switching chats.', 'warn');
      $('#ov-chat-cur').addEventListener('click', () => this.renameChatPrompt(O() && O().chatId));
      $('#ov-chat-new').addEventListener('click', async () => {
        const ov = O();
        if (!ov) return;
        if (ov.busy) return busyToast();
        await ov.newChat();
        this.closeChats();
        $('#ov-input') && $('#ov-input').focus();
      });
      $('#ov-chat-list').addEventListener('click', () => {
        if (!pop.hidden) return this.closeChats();
        pop.hidden = false;
        q.value = '';
        this.renderChatRows();
        q.focus();
      });
      q.addEventListener('input', () => this.renderChatRows());
      q.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); this.closeChats(); }
        if (e.key === 'Enter') { const first = $('#ov-chat-rows [data-chat-open]'); if (first) first.click(); }
      });
      $('#ov-chat-rows').addEventListener('click', async (e) => {
        const ov = O();
        if (!ov) return;
        const ren = e.target.closest('[data-chat-ren]');
        if (ren) { e.stopPropagation(); await this.renameChatPrompt(ren.dataset.chatRen); this.renderChatRows(); return; }
        const del = e.target.closest('[data-chat-del]');
        if (del) {
          e.stopPropagation();
          const id = del.dataset.chatDel;
          const cur = id === ov.chatId;
          if (cur && ov.busy) return busyToast();
          if (!confirm(cur ? 'Delete this chat for good? (+ New chat keeps it instead.)' : 'Delete this chat for good?')) return;
          await ov.deleteChat(id);
          this.renderChatRows();
          return;
        }
        const open = e.target.closest('[data-chat-open]');
        if (!open) return;
        const id = open.dataset.chatOpen;
        if (id === ov.chatId) return this.closeChats();
        if (ov.busy) return busyToast();
        await ov.openChat(id);
        this.closeChats();
        const th = $('#ov-thread');
        if (th) th.scrollTop = th.scrollHeight;
      });
      document.addEventListener('mousedown', (e) => {
        if (!pop.hidden && !e.target.closest('#ov-chats')) this.closeChats();
      });
      this.renderChats();
    },

    closeChats() {
      const pop = $('#ov-chat-pop');
      if (pop) pop.hidden = true;
    },

    async renameChatPrompt(id) {
      const ov = O();
      if (!ov) return;
      const row = ov.listChats().find((c) => c.id === id);
      const next = await askText('Name this chat', row ? row.name : ov.currentChatName());
      if (next == null) return;
      await ov.renameChat(id, next);
    },

    renderChats() {
      const ov = O();
      const cur = $('#ov-chat-cur');
      if (!ov || !cur) return;
      const name = ov.currentChatName();
      cur.innerHTML = `💬 <span>${esc(name)}</span> <em>✎</em>`;
      cur.title = `${name}\nClick to rename this chat`;
      const n = (ov.chats || []).length;
      const list = $('#ov-chat-list');
      if (list) list.textContent = n ? `Chats (${n}) ▾` : 'Chats ▾';
      const nw = $('#ov-chat-new');
      if (nw) nw.disabled = !!ov.busy;
      const pop = $('#ov-chat-pop');
      if (pop && !pop.hidden) this.renderChatRows();
    },

    renderChatRows() {
      const ov = O();
      const box = $('#ov-chat-rows');
      if (!ov || !box) return;
      const q = ($('#ov-chat-q') || {}).value || '';
      const rows = ov.listChats(q);
      const when = (t) => {
        if (!t) return '';
        const d = new Date(t);
        const today = new Date(); today.setHours(0, 0, 0, 0);
        return d >= today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      };
      box.innerHTML = rows.length ? rows.map((c) => `<div class="ov-chat-row ${c.current ? 'on' : ''}" data-chat-open="${esc(c.id)}" title="${esc(c.name)}">
          <div class="nm">${esc(c.name)}</div>
          <div class="meta">${c.current ? '<b>open now</b> · ' : ''}${esc(when(c.updatedAt))} · ${c.count || 0} msg${c.inText ? ' · <em>found in the messages</em>' : ''}</div>
          <button class="btn ghost small" data-chat-ren="${esc(c.id)}" title="Rename">✎</button>
          <button class="btn ghost small" data-chat-del="${esc(c.id)}" title="Delete for good">🗑</button>
        </div>`).join('')
        : `<div class="hint" style="padding:8px">${q ? 'No chat matches.' : 'No earlier chats yet. + New chat keeps this one here.'}</div>`;
    },

    engineLine() {
      const last = (State.llmLast || {}).overseer;
      if (!last) return 'No Overseer call has run yet this session.';
      if (!last.ok) return `<span class="c-bad">Last call failed: ${esc(last.error || 'unknown')}</span>`;
      const t = last.promptTokens
        ? ` · ${num(last.promptTokens)} in / ${num(last.completionTokens)} out${
          last.cachedTokens ? ` · <b>${Math.round((last.cachedTokens / last.promptTokens) * 100)}% of the input came from cache</b>` : ''}`
        : '';
      return `Answered by ${esc(last.provider || 'local')}${last.model ? ` · ${esc(last.model)}` : ''} in ${(last.ms / 1000).toFixed(1)}s${t}`;
    },

    /** Everything the Overseer has spent today, from the providers' own usage numbers. */
    spentToday() {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const runs = ((O() && O().runs) || []).filter((r) => r.at >= start.getTime() && r.tokens);
      return runs.reduce((a, r) => ({
        runs: a.runs + 1,
        in: a.in + (r.tokens.in || 0),
        out: a.out + (r.tokens.out || 0),
        cached: a.cached + (r.tokens.cached || 0),
      }), { runs: 0, in: 0, out: 0, cached: 0 });
    },

    renderThread() {
      const root = $('#ov-thread');
      if (!root) return;
      const ov = O();
      const msgs = (ov && ov.messages) || [];
      const near = root.scrollHeight - root.scrollTop - root.clientHeight < 120;

      if (!msgs.length && !(ov && ov.pendingChoice)) {
        const waiting = (State.library || [])
          .filter((c) => c.promptSource === 'overseer' && c.status === 'review').length;
        root.innerHTML = `<div class="ov-empty">
          <h2>Nothing asked yet.</h2>
          ${waiting ? `<p class="ov-waiting"><b>${waiting} card(s)</b> it made earlier are still waiting for you
             — that is what the badge is counting, and they are in Review, not here.
             <button class="btn small" data-ov="show-work">Show them</button></p>` : ''}
          <p>Try <b>“look up Frieren online, find image references, and write 6 faithful prompts”</b>,
             <b>“research dark-academia laboratories and give me reference ideas”</b>, or
             <b>“check what performed this week, then make 8 images of whatever is working”</b>.</p>
          <p class="hint">Web research saves its sources, shows the reference candidates here, and has the vision model reject bad image hits before it writes. Writing prompts does not queue pictures unless you ask it to make or queue them.</p>
          <p class="hint">It writes prompts, queues them, waits for the images, writes their metadata and
             parks them in Review under <b>Agent generated</b>. It does not publish unless your message
             asks it to — and even then only work that scores ${(cfg().autoSubmit || {}).minScore || 8}+ with no defects gets through.</p>
        </div>`;
        return;
      }

      root.innerHTML = msgs.map((m) => this.msgHtml(m)).join('')
        + this.choiceHtml(ov)
        + (ov && ov.busy ? `<div class="ov-msg agent thinking"><div class="ov-bubble" id="ov-working">${esc(this.workingLabel())}</div></div>` : '');
      this.hydrateResearchPreviews(root);
      if (near) root.scrollTop = root.scrollHeight;
    },

    choiceHtml(ov) {
      const c = ov && ov.pendingChoice;
      if (!c) return '';
      const mins = Math.max(1, Math.round((c.until - Date.now()) / 60000));
      return `<div class="ov-msg agent ov-choice" data-choice-id="${esc(c.id)}"><div class="ov-bubble">${esc(c.text)}
        <div class="ov-actions">${(c.buttons || []).map((b) =>
          `<button class="btn small ${b.primary ? 'primary' : b.key === 'always' ? 'ghost' : ''}" data-ov-choice="${esc(b.key)}">${esc(b.label)}</button>`).join('')}
          <span class="hint">No answer in ${mins} min → ${esc((c.buttons && c.buttons[0] && c.buttons[0].label) || 'the first option')}</span></div>
      </div></div>`;
    },

    /** What the thinking bubble says while a turn is in flight. */
    workingLabel() {
      const ov = O();
      const ms = ov && ov._busyAt ? Date.now() - ov._busyAt : 0;
      const secs = Math.max(0, Math.round(ms / 1000));
      const t = secs >= 60 ? `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s` : `${secs}s`;
      const chain = this.chainLabel();
      return ov && ov._abort ? `Stopping… ${t} · waiting for the in-flight request; no further actions will start` : `Working… ${t}${chain ? ` · ${chain}` : ''}`;
    },

    /** The engines this role will try, in the order Settings has them. */
    chainLabel() {
      const s = State.settings || {};
      const routing = s.routing || {};
      const byId = new Map((s.providers || []).map((p) => [p.id, p.name]));
      const names = (routing.overseer || [])
        .map((id) => (id === 'local' ? 'LM Studio (local)' : byId.get(id)))
        .filter(Boolean);
      if (!names.includes('LM Studio (local)') && routing.fallbackLocal !== false) {
        names.push('LM Studio (local)');
      }
      return names.length ? `trying ${names.join(' → ')}` : '';
    },

    /** Repaint just the elapsed time, not the transcript. */
    startTick() {
      if (this._tick) return;
      this._tick = setInterval(() => {
        const el = document.getElementById('ov-working');
        if (!el) { this.stopTick(); return; }
        el.textContent = this.workingLabel();
      }, 1000);
    },

    stopTick() {
      if (this._tick) clearInterval(this._tick);
      this._tick = null;
    },

    /** Fetch research thumbnails through the bounded main-process bridge. */
    hydrateResearchPreviews(root) {
      for (const img of root.querySelectorAll('img[data-research-preview]')) {
        const researchId = img.dataset.researchId || '';
        const imageId = img.dataset.imageId || '';
        const key = `${researchId}:${imageId}`;
        if (this._previewCache.has(key)) {
          const src = this._previewCache.get(key);
          if (src) img.src = src;
          else img.classList.add('unavailable');
          continue;
        }
        let pending = this._previewPending.get(key);
        if (!pending) {
          const pack = O()?.researchPack(researchId);
          const ref = (pack?.images || []).find((row) => String(row.id) === imageId);
          if (!ref || !window.ala?.research?.preview) {
            this._previewCache.set(key, '');
            img.classList.add('unavailable');
            continue;
          }
          pending = window.ala.research.preview({
            imageUrl: ref.imageUrl, thumbnailUrl: ref.thumbnailUrl, sourceUrl: ref.sourceUrl,
          }).then((res) => (res?.ok && res.base64 && /^image\//.test(res.mime || '')
            ? `data:${res.mime};base64,${res.base64}` : '')).catch(() => '')
            .then((src) => {
              this._previewCache.set(key, src);
              while (this._previewCache.size > 24) this._previewCache.delete(this._previewCache.keys().next().value);
              return src;
            }).finally(() => this._previewPending.delete(key));
          this._previewPending.set(key, pending);
        }
        pending.then((src) => {
          if (!img.isConnected) return;
          if (src) img.src = src;
          else img.classList.add('unavailable');
        });
      }
    },

    msgHtml(m) {
      const time = U.fmtTime(m.at);
      if (m.role === 'user') {
        if (m.hidden) return '';
        const atts = Array.isArray(m.attachments) ? m.attachments : [];
        const pics = atts.length ? `<div class="ov-msg-atts">${atts.map((a) => `<button data-ov-att title="${esc(a.id)} · ${esc(a.name)}${a.w ? ` · ${a.w}×${a.h}` : ''}">
            <img src="ala://ovr/${encodeURIComponent(a.fname)}" alt="${esc(a.name)}" loading="lazy" /><span>${esc(a.id)}</span></button>`).join('')}</div>` : '';
        return `<div class="ov-msg user">${pics}<div class="ov-bubble">${esc(m.text)}</div><span class="ov-time">${time}</span></div>`;
      }
      if (m.role === 'agent') {
        return `<div class="ov-msg agent">${this.thinkHtml(m)}<div class="ov-bubble">${esc(m.text).replace(/\n/g, '<br>')}</div><span class="ov-time">${time}</span></div>`;
      }
      if (m.role === 'note') {
        return `<div class="ov-note ${m.kind === 'err' ? 'err' : ''} ${m.marker ? 'marker' : ''}">${esc(m.text)}</div>`;
      }
      if (m.role === 'tool') {
        let parsed = null;
        try { parsed = JSON.parse(m.text); } catch {  }
        return `<div class="ov-tool-wrap">${this.thinkHtml(m)}<div class="ov-tool">
          <div class="ov-tool-head" title="Click to see exactly what it got back">
            <span class="ov-tool-ico">${this.toolIcon(parsed)}</span>
            <span class="ov-tool-name">${esc(TOOL_VERB[m.tool] || m.tool)}</span>
            <span class="ov-tool-sum">${esc(this.toolSummary(m.tool, parsed))}</span>
          </div>
          ${this.researchHtml(m.tool, parsed)}
          <pre class="ov-tool-body">${esc(m.text)}</pre>
        </div></div>`;
      }
      return '';
    },

    thinkHtml(m) {
      const t = String((m && m.thinking) || '').trim();
      if (!t) return '';
      const words = t.split(/\s+/).filter(Boolean).length;
      return `<div class="ov-think">
        <div class="ov-think-head" title="What the model reasoned before answering — click to show or hide">
          <span class="ov-think-ico">&#128173;</span><span class="ov-think-name">Thought</span>
          <span class="ov-think-sum">${words} word${words === 1 ? '' : 's'}</span>
          <span class="ov-think-toggle">show</span>
        </div>
        <pre class="ov-think-body">${esc(t)}</pre>
      </div>`;
    },

    researchHtml(tool, result) {
      if (!result || !['web_research', 'write_research_prompts'].includes(tool)) return '';
      const pack = O()?.researchPack(result.researchId || '');
      if (!pack) return '';
      if (tool === 'web_research') {
        const images = (pack.images || []).slice(0, 8);
        const sources = (pack.sources || []).slice(0, 8);
        return `<div class="ov-research-card">
          <div class="ov-research-title"><b>${esc(pack.query)}</b><span>${esc(pack.kind)} · ${sources.length} source(s) · ${images.length} image reference(s)</span></div>
          ${images.length ? `<div class="ov-research-images">${images.map((im) => {
            const open = im.sourceUrl || im.imageUrl || im.thumbnailUrl;
            return `<button class="ov-research-image" data-web-url="${esc(open)}" title="Open source: ${esc(im.title)}">
              <img data-research-preview data-research-id="${esc(pack.id)}" data-image-id="${esc(im.id)}" alt="" />
              <span><b>${esc(im.id)}</b> ${esc(im.title)}</span>
            </button>`;
          }).join('')}</div>` : '<div class="hint">No downloadable image reference was found; text sources are still usable.</div>'}
          ${sources.length ? `<div class="ov-research-sources">${sources.map((s) =>
            `<button data-web-url="${esc(s.url)}" title="${esc(s.snippet || s.url)}"><b>${esc(s.id)}</b> ${esc(s.title)} <span>↗</span></button>`).join('')}</div>` : ''}
        </div>`;
      }
      const found = O()?.promptSet(result.promptSetId, result.researchId || '');
      const set = found?.set;
      if (!set) return '';
      return `<div class="ov-research-card ov-prompt-set">
        <div class="ov-research-title"><b>${set.prompts.length} saved prompt(s)</b><span>${esc(set.mode)} · ${esc(pack.query)}</span></div>
        ${set.prompts.map((prompt, i) => `<div class="ov-research-prompt">
          <span class="ov-prompt-n">${i + 1}</span><p>${esc(prompt)}</p>
          <button class="btn ghost small" data-copy-prompt="${esc(set.id)}" data-research-id="${esc(pack.id)}" data-prompt-index="${i}">Copy</button>
        </div>`).join('')}
      </div>`;
    },

    toolIcon(r) {
      if (!r) return '·';
      if (r.refused) return '⊘';
      if (r.cancelled) return '■';
      if (r.error || r.ok === false) return '✕';
      if (r.failed || r.blocked?.length || r.drafts?.some((d) => d.publishError)) return '⚠';
      return '✓';
    },

    /** One line saying what actually happened — the claim the bubble above should match. */
    toolSummary(tool, r) {
      if (!r) return '';
      if (r.cancelled) return r.note || r.error || 'Stopped; no further actions started';
      if (r.refused) return r.refused;
      if (r.error) return r.error;
      switch (tool) {
        case 'web_research': return `${r.sourceCount || 0} source(s), ${r.imageCount || 0} image reference(s)`;
        case 'write_research_prompts': return `${r.written || 0} prompt(s) from ${r.referenceCount || 0} verified image reference(s)`;
        case 'queue_research_prompts': return `${r.queued || 0} queued${r.referenceCount ? ` with ${r.referenceCount} image reference(s) each` : ''}${r.skipped ? `, ${r.skipped} already queued` : ''}`;
        case 'queue_art': return r.queued ? `${r.queued} prompt(s) for “${r.theme}”${r.referenceImages ? ` with reference image(s) ${r.referenceImages.join(', ')}` : ''}${r.position === 'front' ? ' · at the front of the queue' : r.jobsAhead ? ` · ${r.jobsAhead} job(s) ahead` : ''}` : '';
        case 'cancel_queued': return r.cancelled ? `${r.cancelled} job(s) removed, ${r.stillQueued} still queued${r.stillRendering ? ' · the one rendering finishes' : ''}` : '';
        case 'reorder_queue': return r.position === 'order'
          ? `new order: ${(r.queueOrder || []).filter((g) => g.group).map((g) => `${g.jobs}× ${String(g.theme).split(/[,;]/)[0].slice(0, 30)}`).join(' → ')}`
          : r.moved ? `${r.moved} job(s) moved to the ${r.position}${r.position === 'front' ? ' — they run next' : ''}` : '';
        case 'sync_stats': return r.read != null ? `${r.read} deviation(s) re-read` : '';
        case 'list_cards': return `${r.matched} matched`;
        case 'write_metadata': return `${r.written} written${r.failed ? `, ${r.failed} failed${r.firstError ? `: ${r.firstError}` : ''}` : ''}`;
        case 'approve': return `${r.approved} card(s)`;
        case 'discard': return `${r.discarded} card(s)`;
        case 'submit': return `${(r.published || []).length} published, ${(r.drafts || []).length} draft(s)${(r.blocked || []).length ? `, ${r.blocked.length} held back: ${r.blocked[0].why}` : ''}${r.drafts?.find((d) => d.publishError) ? ` · ${r.drafts.find((d) => d.publishError).publishError}` : ''}`;
        case 'wait_for_worker': return r.idle ? `idle after ${r.waitedSeconds}s` : `gave up after ${r.waitedSeconds}s`;
        case 'read_stats': return `${num(r.published)} published, ${num(r.views)} views`;
        case 'learn': return r.summary || '';
        case 'remember': return r.brief || '';
        case 'set_model': return r.changed ? `${r.role}: ${r.from} → ${r.to}` : r.current ? `${r.role}: ${r.current}` : (r.to ? `${r.role}: ${r.to}` : '');
        case 'set_workflow': return r.changed ? `${r.kind}: ${r.from} → ${r.to}` : r.current ? `${r.kind}: ${r.current}` : '';
        default: return '';
      }
    },
  };

  window.OverseerUI = OverseerUI;
})();
