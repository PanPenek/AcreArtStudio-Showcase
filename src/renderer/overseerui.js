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
        const att = e.target.closest('[data-ov-att]');
        if (att) { att.classList.toggle('big'); return; }
        const head = e.target.closest('.ov-tool-head');
        if (head) { head.parentElement.classList.toggle('open'); return; }
        if (e.target.closest('[data-ov]')) this.onStripClick(e);
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
    },

    /** Can the Overseer's chain read pictures at all? */
    async refreshVision() {
      try {
        const r = await window.ala.llm.route('overseer');
        this._vision = !!(r && r.vision);
        this._visionNames = (r && r.visionProviders) || [];
      } catch {
        this._vision = false;
        this._visionNames = [];
      }
      const btn = $('#btn-ov-attach');
      if (btn) {
        btn.disabled = !this._vision;
        btn.title = this._vision
          ? `Attach images — paste or drop works too. Read by ${this._visionNames.join(' → ')}.`
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
      this.renderThread();
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

      strip.innerHTML = `
      <div class="ov-cells">
        <div class="ov-cell">
          <span class="ov-k">Standing brief</span>
          <button class="ov-v link" data-ov="brief" title="Click to edit">${o.brief ? esc(o.brief.slice(0, 90)) + (o.brief.length > 90 ? '…' : '') : '<em>not set — click to write one</em>'}</button>
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
      <div class="ov-actions">
        ${agent ? `<button class="btn small" data-ov="run-now" ${ov && ov.busy ? 'disabled' : ''}>Run now</button>` : ''}
        ${ov && ov.busy ? `<button class="btn small" data-ov="stop" ${ov._abort ? 'disabled' : ''}>${ov._abort ? 'Stopping…' : 'Stop'}</button>` : ''}
        <button class="btn ghost small" data-ov="clear" ${ov && ov.busy ? 'disabled' : ''}>Clear conversation</button>
        <span class="hint">${this.engineLine()}</span>
      </div>`;
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

      if (!msgs.length) {
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
        + (ov && ov.busy ? `<div class="ov-msg agent thinking"><div class="ov-bubble" id="ov-working">${esc(this.workingLabel())}</div></div>` : '');
      this.hydrateResearchPreviews(root);
      if (near) root.scrollTop = root.scrollHeight;
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
        return `<div class="ov-msg agent"><div class="ov-bubble">${esc(m.text).replace(/\n/g, '<br>')}</div><span class="ov-time">${time}</span></div>`;
      }
      if (m.role === 'note') {
        return `<div class="ov-note ${m.kind === 'err' ? 'err' : ''} ${m.marker ? 'marker' : ''}">${esc(m.text)}</div>`;
      }
      if (m.role === 'tool') {
        let parsed = null;
        try { parsed = JSON.parse(m.text); } catch { }
        return `<div class="ov-tool">
          <div class="ov-tool-head" title="Click to see exactly what it got back">
            <span class="ov-tool-ico">${this.toolIcon(parsed)}</span>
            <span class="ov-tool-name">${esc(TOOL_VERB[m.tool] || m.tool)}</span>
            <span class="ov-tool-sum">${esc(this.toolSummary(m.tool, parsed))}</span>
          </div>
          ${this.researchHtml(m.tool, parsed)}
          <pre class="ov-tool-body">${esc(m.text)}</pre>
        </div>`;
      }
      return '';
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
        default: return '';
      }
    },
  };

  window.OverseerUI = OverseerUI;
})();
