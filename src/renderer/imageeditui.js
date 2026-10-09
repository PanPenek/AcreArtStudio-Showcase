/* imageeditui.js — the Image Edit tab and the 🩹 Fix menu on cards.
 *
 * Layout: the picture on the left, the HISTORY on the
 * right, the whole-picture prompt underneath. Every finished edit is a checkpoint (checkpoint
 * 0 = the original). Clicking a checkpoint shows it and makes it the picture the next edit
 * starts from — going back is the undo, and nothing is ever deleted. Per checkpoint:
 *   ↻ Redo  — same instruction, same starting checkpoint, new seed; both results are kept
 *   ✎ Reuse — the instruction back in the prompt box, its starting checkpoint selected
 *   ✕       — move the card to Discarded (restorable from "Show discarded")
 * Editing from an older checkpoint starts a branch. The tree is rebuilt from the library and
 * the queue every time (ImageEdit.historyTree), so it survives restarts.
 *
 * Brushing: brush over a part of the picture → a popup asks what to change there → the
 * brushed area becomes words in the instruction (ImageEdit.regionInstruction). No pixels are
 * masked or pasted: Qwen re-renders the whole frame, which is its strength.
 */
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => U.escapeHtml(String(s == null ? '' : s));
  const toast = (m, k) => (window.toast ? window.toast(m, k) : console.log(m));
  const SESSION_KEY = 'ala.imageEdit.session';

  // The session: one root picture and the checkpoint currently shown.
  let rootKey = null;       // 'card-<id>' or an upload row id
  let rootRow = null;       // the uploaded root's row (null for a card root)
  let currentKey = null;    // the checkpoint shown and edited from
  let tree = null;          // last ImageEdit.historyTree
  let view = null;          // { url, w, h } of the shown checkpoint
  let showDiscarded = false;
  const awaiting = new Map(); // jobId → parent key: auto-select the result if still on its parent

  let box = null;           // brushed bbox in source pixels {x,y,w,h}
  let drawing = false;
  let brush = 48;           // px in source pixels
  let native = null;        // workflow render size (cached per session)
  let nativeAt = 0;
  let peeking = false;

  const ui = {
    wire() {
      const pane = $('#pane-imageedit');
      if (!pane) return;
      $('#ie-upload').addEventListener('click', () => $('#ie-file').click());
      $('#ie-file').addEventListener('change', (e) => { this.loadFile(e.target.files && e.target.files[0]); e.target.value = ''; });
      $('#ie-brush').addEventListener('input', (e) => { brush = Number(e.target.value) || 48; $('#ie-brush-out').textContent = brush; });
      $('#ie-clear').addEventListener('click', () => this.clearMask());
      $('#ie-go').addEventListener('click', () => this.submitWhole());
      $('#ie-prompt').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || !e.shiftKey)) { e.preventDefault(); this.submitWhole(); }
      });
      $('#ie-pop-go').addEventListener('click', () => this.submitRegion());
      $('#ie-pop-cancel').addEventListener('click', () => this.closePop());
      $('#ie-pop-text').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.submitRegion(); }
        if (e.key === 'Escape') { e.preventDefault(); this.closePop(); }
      });
      $('#ie-undo').addEventListener('click', () => this.undo());
      $('#ie-fix').addEventListener('click', (e) => this.fixCurrent(e.currentTarget));
      $('#ie-show-off').addEventListener('click', () => { showDiscarded = !showDiscarded; this.renderHistory(); });
      $('#ie-hist-list').addEventListener('click', (e) => this.onHistoryClick(e));
      // Drop / paste a picture anywhere on the tab.
      pane.addEventListener('dragover', (e) => { e.preventDefault(); });
      pane.addEventListener('drop', (e) => {
        e.preventDefault();
        const f = [...(e.dataTransfer && e.dataTransfer.files || [])].find((x) => /^image\//.test(x.type));
        if (f) this.loadFile(f);
      });
      const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      document.addEventListener('paste', (e) => {
        if (!pane.classList.contains('active') || typing(e.target)) return;
        const item = [...(e.clipboardData && e.clipboardData.items || [])].find((x) => /^image\//.test(x.type));
        if (item) { e.preventDefault(); this.loadFile(item.getAsFile()); }
      });
      // Hold Space: show the checkpoint this one was made from (before/after at a glance).
      document.addEventListener('keydown', (e) => {
        if (e.code !== 'Space' || e.repeat || !pane.classList.contains('active') || typing(e.target)) return;
        e.preventDefault();
        this.peek(true);
      });
      document.addEventListener('keyup', (e) => { if (e.code === 'Space') this.peek(false); });
      window.addEventListener('blur', () => this.peek(false));
      const cv = $('#ie-mask');
      cv.addEventListener('pointerdown', (e) => this.down(e));
      cv.addEventListener('pointermove', (e) => this.move(e));
      cv.addEventListener('pointerup', (e) => this.up(e));
      cv.addEventListener('pointercancel', () => { drawing = false; });
      State.on('library', () => this.onData());
      State.on('queue', () => this.onData());
      this.restore();
      this.render();
    },

    /** Called by switchTab on arrival. */
    render() {
      const on = ImageEdit.comfyOn();
      $('#ie-engine').hidden = on;
      $('#ie-empty').hidden = !!rootKey;
      $('#ie-stage').hidden = !rootKey;
      for (const id of ['#ie-go', '#ie-pop-go']) $(id).disabled = !on || !rootKey;
      this.renderHistory();
    },

    // ---------- session ----------
    save() {
      try {
        if (!rootKey) localStorage.removeItem(SESSION_KEY);
        else localStorage.setItem(SESSION_KEY, JSON.stringify({ rootKey, rootRow, currentKey }));
      } catch { /* storage full or off: the session just is not remembered */ }
    },
    restore() {
      try {
        const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
        if (!s || !s.rootKey) return;
        const t = ImageEdit.historyTree(s.rootKey, State.library, State.queue, { rootRow: s.rootRow });
        if (!t || !t.root.url) return;
        rootKey = s.rootKey; rootRow = s.rootRow || null;
        this.select(t.nodes.has(s.currentKey) ? s.currentKey : rootKey, { quiet: true });
      } catch { /* a stale session is simply dropped */ }
    },

    /** Start a session on a library card (✎ Edit on a card). Its own session if it has one. */
    async open({ cardId } = {}) {
      if (cardId) await this.openCard(cardId);
    },
    async openCard(cardId) {
      const card = (State.library || []).find((c) => c && c.id === cardId);
      if (!card || !card.fname) { toast('That card has no picture.', 'err'); return; }
      rootKey = card.editRoot || `card-${card.id}`;
      rootRow = null;
      this.select(`card-${card.id}`);
    },

    async loadFile(f) {
      if (!f) return;
      if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { toast('PNG, JPEG or WebP only.', 'err'); return; }
      if (f.size > 20 * 1024 * 1024) { toast('That picture is larger than 20 MB.', 'err'); return; }
      try {
        const base64 = await new Promise((resolve, reject) => {
          const rd = new FileReader();
          rd.onload = () => resolve(String(rd.result).split(',')[1] || '');
          rd.onerror = () => reject(new Error('could not read the file'));
          rd.readAsDataURL(f);
        });
        const saved = await window.ala.files.saveAttachment(base64, f.type, `edit-${f.name || 'upload'}`);
        rootRow = { id: `upload-${U.uid()}`, fname: saved.fname, mime: saved.mime || f.type, name: f.name || 'uploaded picture' };
        rootKey = rootRow.id;
        this.select(rootKey);
      } catch (e) {
        toast('Could not load the picture: ' + String(e.message || e).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ''), 'err');
      }
    },

    dims(url) {
      return new Promise((resolve) => {
        const im = new Image();
        im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
        im.onerror = () => resolve({ w: 0, h: 0 });
        im.src = url;
      });
    },

    buildTree() {
      tree = rootKey ? ImageEdit.historyTree(rootKey, State.library, State.queue, { rootRow, showDiscarded }) : null;
      return tree;
    },
    node(key = currentKey) {
      return tree && tree.nodes.get(key);
    },

    /** Show a checkpoint and make it the one the next edit starts from. */
    async select(key, { quiet = false } = {}) {
      this.buildTree();
      const n = this.node(key) || (tree && tree.root);
      if (!n || n.kind === 'pending') return;
      currentKey = n.key;
      const card = n.card;
      const url = n.url;
      const d = card && card.width && card.height ? { w: card.width, h: card.height } : await this.dims(url);
      if (currentKey !== n.key) return; // a newer click won
      view = { url, w: d.w || 1024, h: d.h || 1024 };
      const img = $('#ie-img');
      img.src = url;
      const cv = $('#ie-mask');
      if (cv.width !== view.w || cv.height !== view.h) {
        cv.width = view.w; cv.height = view.h;
        brush = Math.max(8, Math.round(Math.max(view.w, view.h) * 0.05));
        $('#ie-brush').max = String(Math.max(64, Math.round(Math.max(view.w, view.h) / 4)));
        $('#ie-brush').value = String(brush);
        $('#ie-brush-out').textContent = brush;
      }
      this.clearMask();
      this.save();
      this.render();
      if (!quiet) $('#ie-prompt').focus({ preventScroll: true });
    },

    undo() {
      const n = this.node();
      if (n && n.parent) this.select(n.parent.key);
    },

    peek(on) {
      if (on === peeking) return;
      const n = this.node();
      const prev = n && n.parent;
      if (on && !prev) return;
      peeking = on;
      $('#ie-img').src = on ? prev.url : (view && view.url) || '';
      $('#ie-mask').style.visibility = on ? 'hidden' : '';
      $('#ie-peek').hidden = !on;
      if (on) $('#ie-peek').textContent = `Showing #${prev.n}${prev.kind === 'root' ? ' (Original)' : ''} — release Space to return`;
    },

    /** Library/queue changed: redraw, and follow a finished edit if still on its parent. */
    onData() {
      if (!rootKey) return;
      for (const [jobId, parentKey] of awaiting) {
        const done = (State.library || []).find((c) => c && c.jobId === jobId && c.fname);
        if (done) {
          awaiting.delete(jobId);
          if (currentKey === parentKey && $('#pane-imageedit').classList.contains('active')) { this.select(`card-${done.id}`, { quiet: true }); return; }
        } else if (!(State.queue || []).some((j) => j && j.id === jobId && ['queued', 'generating'].includes(j.status))) {
          awaiting.delete(jobId); // failed or cancelled
        }
      }
      if ($('#pane-imageedit').classList.contains('active')) this.renderHistory();
    },

    // ---------- history panel ----------
    renderHistory() {
      const list = $('#ie-hist-list');
      if (!list) return;
      if (!rootKey) { list.innerHTML = ''; $('#ie-src').textContent = 'no picture loaded'; $('#ie-status').textContent = ''; return; }
      this.buildTree();
      if (!this.node()) currentKey = rootKey;
      const rows = ImageEdit.historyRows(tree, currentKey);
      const cur = this.node();
      const pend = rows.filter((r) => r.node.kind === 'pending');
      const running = pend.some((r) => r.node.job.status === 'generating');
      list.innerHTML = rows.map((r) => this.rowHtml(r)).join('');
      $('#ie-undo').disabled = !(cur && cur.parent);
      $('#ie-undo').title = cur && cur.parent ? `Back to #${cur.parent.n}${cur.parent.kind === 'root' ? ' (Original)' : ''}` : 'This is the original';
      $('#ie-fix').disabled = !(cur && cur.card && cur.card.fname) || !ImageEdit.comfyOn();
      $('#ie-fix').title = cur && cur.card ? 'Repair this checkpoint (fingers, mushed detail, proportions, face, or from QC)' : 'An uploaded original cannot be fixed directly — edit it once, or use the prompt';
      const off = tree ? tree.discarded : 0;
      $('#ie-show-off').hidden = !off;
      $('#ie-show-off').textContent = showDiscarded ? `Hide discarded (${off})` : `Show discarded (${off})`;
      const name = cur && cur.kind === 'root'
        ? (cur.card ? `card ${cur.card.id}` : (cur.row && cur.row.name) || 'uploaded picture')
        : cur && cur.card ? `card ${cur.card.id}` : '';
      $('#ie-src').textContent = view ? `${name} · ${view.w}×${view.h}` : name;
      $('#ie-from').textContent = cur ? `Editing from #${cur.n}${cur.kind === 'root' ? ' (Original)' : ''}` : '';
      $('#ie-status').textContent = pend.length
        ? ` · ${running ? 'rendering' : 'waiting'} — ${pend.length} edit${pend.length > 1 ? 's' : ''} in the queue${Pipeline.running ? '' : ' (worker paused — press Start on the Dashboard)'}`
        : '';
      // keep the selected row in view
      const on = list.querySelector('.ie-row.on');
      if (on && typeof on.scrollIntoView === 'function') on.scrollIntoView({ block: 'nearest' });
    },

    rowHtml({ node, depth, branchFrom, on, lineage }) {
      const pad = `style="--depth:${depth}"`;
      if (node.kind === 'pending') {
        const j = node.job;
        const gen = j.status === 'generating';
        const parent = node.parent;
        return `<div class="ie-row pending ${gen ? 'gen' : ''}" ${pad} data-key="${esc(node.key)}">
          <div class="ie-row-thumb"><span class="ie-dot"></span></div>
          <div class="ie-row-body">
            <div class="ie-row-title">${esc(j.fixOf ? '🩹 ' : '')}${esc(String(j.editLabel || 'edit').slice(0, 120))}</div>
            <div class="ie-row-meta">${gen ? 'rendering…' : 'queued'}${parent ? ` · from #${parent.n}` : ''}${j.redoOf ? ' · redo' : ''}</div>
          </div>
          ${gen ? '' : `<div class="ie-row-acts"><button class="ie-act" data-act="cancel" title="Cancel this edit">✕</button></div>`}
        </div>`;
      }
      const c = node.card;
      const isRoot = node.kind === 'root';
      const title = isRoot ? 'Original' : (c && c.editLabel) || 'edit';
      const meta = [];
      if (branchFrom) meta.push(`↳ from #${branchFrom.n}`);
      if (c && c.redoOf) { const src = tree.nodes.get(`card-${c.redoOf}`); meta.push(`redo${src && src.n != null ? ` of #${src.n}` : ''}`); }
      if (c && c.qc && c.qc.score != null) meta.push(`QC ${c.qc.score}/10`);
      if (c && c.fixDelta && c.fixDelta.from != null && c.fixDelta.to != null) meta.push(`${c.fixDelta.from}→${c.fixDelta.to}`);
      if (node.discarded) meta.push('discarded');
      else if (c && !isRoot && c.status && c.status !== 'review') meta.push(c.status);
      const acts = isRoot ? '' : node.discarded
        ? `<button class="ie-act" data-act="restore" title="Restore to Review">↺</button>`
        : `<button class="ie-act" data-act="redo" title="Redo: same instruction from #${node.parent ? node.parent.n : 0}, new seed — both results are kept">↻</button>
           ${ImageEdit.reuseText(c) ? `<button class="ie-act" data-act="reuse" title="Reuse: put this instruction back in the prompt box, starting from #${node.parent ? node.parent.n : 0}">✎</button>` : ''}
           <button class="ie-act" data-act="discard" title="Move this result to Discarded">✕</button>`;
      return `<div class="ie-row ${on ? 'on' : ''} ${lineage ? 'lineage' : ''} ${node.discarded ? 'off' : ''}" ${pad} data-key="${esc(node.key)}" title="${esc(title)}">
        <div class="ie-row-thumb"><img src="${esc(node.url)}" alt="" loading="lazy" /><span class="ie-n">#${node.n}</span></div>
        <div class="ie-row-body">
          <div class="ie-row-title">${esc(c && c.fixOf ? '🩹 ' : '')}${esc(String(title).slice(0, 160))}</div>
          <div class="ie-row-meta">${esc(meta.join(' · '))}${on ? '<span class="ie-on">◀ editing</span>' : ''}</div>
        </div>
        <div class="ie-row-acts">${acts}</div>
      </div>`;
    },

    async onHistoryClick(e) {
      const row = e.target.closest('.ie-row');
      if (!row) return;
      const key = row.dataset.key;
      const btn = e.target.closest('[data-act]');
      if (!btn) { if (!row.classList.contains('pending')) this.select(key); return; }
      e.stopPropagation();
      const n = this.node(key);
      if (!n) return;
      const act = btn.dataset.act;
      if (act === 'cancel' && n.kind === 'pending') {
        if (n.job.status !== 'queued') { toast('That edit is already rendering.', 'err'); return; }
        State.queue = (State.queue || []).filter((j) => j.id !== n.job.id);
        awaiting.delete(n.job.id);
        State.persistQueue();
        this.renderHistory();
        toast('Edit cancelled.', 'ok');
      } else if (act === 'redo') {
        await this.redo(n);
      } else if (act === 'reuse') {
        const text = ImageEdit.reuseText(n.card);
        if (!text) return;
        if (n.parent) await this.select(n.parent.key, { quiet: true });
        $('#ie-prompt').value = text;
        $('#ie-prompt').focus();
      } else if (act === 'discard') {
        n.card.status = 'discarded';
        n.card.updatedAt = Date.now();
        if (currentKey === key) currentKey = n.parent ? n.parent.key : rootKey;
        State.persistLibrary();
        this.select(currentKey, { quiet: true });
        toast(`#${n.n} moved to Discarded — "Show discarded" in the history brings it back.`, 'ok');
      } else if (act === 'restore') {
        n.card.status = 'review';
        n.card.updatedAt = Date.now();
        State.persistLibrary();
        this.renderHistory();
      }
    },

    async redo(n) {
      if (!ImageEdit.comfyOn()) { toast('Image edits need the ComfyUI engine (Settings → Generation).', 'err'); return; }
      const spec = ImageEdit.redoSpec(n, tree);
      if (!spec) { toast('This checkpoint cannot be redone (its instruction or source is missing).', 'err'); return; }
      try {
        const { job } = await ImageEdit.queueEdit({ ...spec, count: 1 });
        awaiting.set(job.id, spec.parentKey);
        toast(`Redo of #${n.n} queued — same instruction, new seed. Both results are kept.`, 'ok');
        this.renderHistory();
      } catch (e) { toast('Could not queue the redo: ' + e.message, 'err'); }
    },

    fixCurrent(anchor) {
      const n = this.node();
      if (!n || !n.card) return;
      this.openFixMenu(n.card, anchor, { onQueued: (job) => { awaiting.set(job.id, n.key); this.renderHistory(); } });
    },

    // ---------- brushing ----------
    toPx(e) {
      const cv = $('#ie-mask');
      const r = cv.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) };
    },
    stamp(p) {
      const ctx = $('#ie-mask').getContext('2d');
      ctx.fillStyle = 'rgba(239, 68, 68, 0.45)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, brush / 2, 0, Math.PI * 2);
      ctx.fill();
      const r = brush / 2;
      const x0 = Math.max(0, p.x - r), y0 = Math.max(0, p.y - r);
      const x1 = Math.min(view.w, p.x + r), y1 = Math.min(view.h, p.y + r);
      if (!box) box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      else {
        const bx1 = Math.max(box.x + box.w, x1), by1 = Math.max(box.y + box.h, y1);
        box.x = Math.min(box.x, x0); box.y = Math.min(box.y, y0);
        box.w = bx1 - box.x; box.h = by1 - box.y;
      }
    },
    down(e) {
      if (!view || e.button !== 0 || peeking) return;
      this.closePop(false);
      drawing = true;
      try { e.target.setPointerCapture(e.pointerId); } catch { /* pen/synthetic pointer without capture */ }
      this.last = this.toPx(e);
      this.stamp(this.last);
    },
    move(e) {
      if (!drawing) return;
      const p = this.toPx(e);
      // Fill the gap between pointer events so a fast stroke stays continuous.
      const d = Math.hypot(p.x - this.last.x, p.y - this.last.y);
      const step = Math.max(1, brush / 4);
      for (let t = step; t < d; t += step) {
        this.stamp({ x: this.last.x + (p.x - this.last.x) * (t / d), y: this.last.y + (p.y - this.last.y) * (t / d) });
      }
      this.stamp(p);
      this.last = p;
    },
    up() {
      if (!drawing) return;
      drawing = false;
      if (box) this.openPop();
    },
    clearMask() {
      const cv = $('#ie-mask');
      cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
      box = null;
      this.closePop(false);
    },

    // ---------- popup ----------
    openPop() {
      const pop = $('#ie-pop');
      const cv = $('#ie-mask');
      const r = cv.getBoundingClientRect();
      const host = $('#ie-canvas-wrap').getBoundingClientRect();
      const sx = r.width / cv.width, sy = r.height / cv.height;
      const left = r.left - host.left + (box.x + box.w) * sx + 10;
      const top = r.top - host.top + box.y * sy;
      pop.hidden = false;
      const pw = pop.offsetWidth || 300, ph = pop.offsetHeight || 150;
      pop.style.left = `${Math.max(6, Math.min(left, host.width - pw - 6))}px`;
      pop.style.top = `${Math.max(6, Math.min(top, host.height - ph - 6))}px`;
      $('#ie-pop-where').textContent = `Area: ${ImageEdit.locationPhrase(box, view.w, view.h)}`;
      $('#ie-pop-text').value = '';
      $('#ie-pop-text').focus();
    },
    closePop(clear = true) {
      $('#ie-pop').hidden = true;
      if (clear && box) this.clearMask();
    },

    // ---------- submit ----------
    async sizeOk() {
      // Settings → Generation → "Warn before editing a different-sized picture" (on by default).
      if (((window.State && State.settings && State.settings.gen) || {}).editSizeWarning === false) return true;
      if (!native || Date.now() - nativeAt > 60000) { native = await ImageEdit.nativeSize(); nativeAt = Date.now(); }
      const warn = ImageEdit.sizeWarning({ w: view.w, h: view.h }, native);
      if (!warn) return true;
      return confirm(`${warn}\n\nOK = edit anyway · Cancel = stop`);
    },

    editSource() {
      const n = this.node();
      if (!n) return null;
      if (n.card) return { card: n.card };
      return n.row ? { row: n.row } : null;
    },

    async submit(instruction, label) {
      if (!rootKey || !view) return false;
      if (!ImageEdit.comfyOn()) { toast('Image edits need the ComfyUI engine (Settings → Generation).', 'err'); return false; }
      if (!instruction) { toast('Describe what should change.', 'err'); return false; }
      if (!(await this.sizeOk())) return false;
      try {
        const count = Number($('#ie-count').value) || 1;
        const src = this.editSource();
        if (!src) throw new Error('no picture to edit');
        const from = currentKey;
        const { job } = await ImageEdit.queueEdit({ source: src, prompt: ImageEdit.editPrompt(instruction), label, count, root: rootKey, instruction });
        awaiting.set(job.id, from);
        toast(`Edit queued at the front (${count} picture${count > 1 ? 's' : ''}, about a minute each).`, 'ok');
        this.renderHistory();
        return true;
      } catch (e) {
        toast('Could not queue the edit: ' + e.message, 'err');
        return false;
      }
    },

    async submitWhole() {
      const text = String($('#ie-prompt').value || '').trim();
      if (await this.submit(text, text)) $('#ie-prompt').value = '';
    },

    async submitRegion() {
      const text = String($('#ie-pop-text').value || '').trim();
      if (!text) { this.closePop(); return; }
      const instruction = ImageEdit.regionInstruction(text, box, view.w, view.h);
      if (await this.submit(instruction, `${ImageEdit.locationPhrase(box, view.w, view.h)}: ${text}`)) this.closePop();
    },

    // ---------- 🩹 Fix menu (cards in Review, and the current checkpoint here) ----------
    openFixMenu(card, anchor, { onQueued = null } = {}) {
      document.querySelector('.ie-fixmenu')?.remove();
      if (!ImageEdit.comfyOn()) { toast('Fixes need the ComfyUI engine (Settings → Generation).', 'err'); return; }
      const hasQc = !!ImageEdit.fixInstruction('auto', card);
      const m = document.createElement('div');
      m.className = 'ie-fixmenu';
      m.innerHTML = `
        ${Object.entries(ImageEdit.FIX_PRESETS).map(([k, p]) => `<button class="btn ghost small" data-fix="${k}" title="${esc(p.text)}">${esc(p.label)}</button>`).join('')}
        <button class="btn ghost small" data-fix="auto" title="${esc(hasQc ? ImageEdit.fixInstruction('auto', card) : 'No QC findings yet — runs QC on this picture first, then fixes what it finds')}">Auto (from QC)</button>
        <div class="ie-fixfree"><input type="text" placeholder="…or describe the fix" maxlength="600" /><button class="btn small" data-fix="free">Fix</button></div>`;
      document.body.appendChild(m);
      const r = anchor.getBoundingClientRect();
      m.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8))}px`;
      m.style.top = `${Math.min(r.bottom + 4, window.innerHeight - m.offsetHeight - 8)}px`;
      const close = () => { m.remove(); document.removeEventListener('pointerdown', outside, true); };
      const outside = (e) => { if (!m.contains(e.target)) close(); };
      setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
      const input = m.querySelector('input');
      const go = async (preset) => {
        const key = preset === 'free' ? String(input.value || '').trim() : preset;
        if (!key) { input.focus(); return; }
        close();
        toast(key === 'auto' && !hasQc ? 'Running QC on this picture, then writing the fix…' : 'Looking at the picture to write the fix…', 'ok');
        try {
          const { job, planned } = await ImageEdit.queueFix(card, key);
          if (onQueued) onQueued(job);
          toast(`Fix queued at the front${planned ? ' (the vision model described the corrected picture)' : ' (no vision model — plain repair instruction)'} — the repaired copy is a new card; this one is kept.`, 'ok');
        } catch (e) { toast('Could not queue the fix: ' + e.message, 'err'); }
      };
      m.addEventListener('click', (e) => { const b = e.target.closest('[data-fix]'); if (b && !b.disabled) go(b.dataset.fix); });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go('free'); } if (e.key === 'Escape') close(); });
    },
  };

  window.ImageEditUI = ui;
})();
