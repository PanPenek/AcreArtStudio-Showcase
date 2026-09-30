/**
 * triageui.js: the "Pick keepers" full-screen overlay. Keyboard first:
 *   1-9, 0   toggle a tile as keeper        Enter   keep selected, discard rest
 *   Shift+#  view a tile full size          X/Del   discard the whole batch
 *   S / P    skip / back                    G / A   ask the AI / take its pick
 *   U        undo the last batch            Esc     close
 * Repaints are split so toggling a keeper never re-decodes the images.
 */
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => U.escapeHtml(s);

  const PREFS_DEFAULT = { keepTo: 'review', meta: 'none', order: 'newest' };
  const AHEAD = 3;

  let open = false;
  let status = 'review';
  let list = [];
  let idx = 0;
  let sel = new Set();
  let selFor = null;
  let selSource = null;
  let touched = false;
  let zoom = -1;
  let undoStack = [];
  let session = null;
  const busy = new Set();
  let aheadRunning = false;
  let metaChain = Promise.resolve();
  let metaPending = 0;
  let bodySig = '';
  const remembered = new Map();

  const prefs = () => ({ ...PREFS_DEFAULT, ...((State.settings.ui && State.settings.ui.triage) || {}) });
  async function setPref(patch) {
    State.settings = await window.ala.settings.patch({ ui: { triage: { ...prefs(), ...patch } } });
  }
  const aiOn = () => !!(State.settings.gen && State.settings.gen.autoPick);

  function refreshList(keepKey) {
    list = Triage.batches({ status, order: prefs().order });
    if (keepKey) {
      const at = list.findIndex((b) => b.key === keepKey);
      if (at >= 0) { idx = at; return; }
    }
    idx = Math.max(0, Math.min(idx, list.length - 1));
  }

  const current = () => list[idx] || null;

  function syncSelection() {
    const b = current();
    if (!b) { sel = new Set(); selFor = null; return; }
    if (selFor === b.key) return;
    if (selFor && touched) remembered.set(selFor, { ids: [...sel], source: selSource });
    const kept = remembered.get(b.key);
    const pre = kept ? null : Triage.preselect(b);
    sel = new Set(kept ? kept.ids.filter((id) => b.cards.some((c) => c.id === id)) : pre.ids);
    selSource = kept ? kept.source : pre.source;
    touched = !!kept;
    selFor = b.key;
    zoom = -1;
  }

  /** How many columns make the biggest tiles on this screen for n roughly-square images. */
  function bestCols(n, w, h) {
    let best = 1, size = 0;
    for (let c = 1; c <= n; c++) {
      const s = Math.min(w / c, h / Math.ceil(n / c));
      if (s > size) { size = s; best = c; }
    }
    return best;
  }

  function openTriage(opts = {}) {
    status = opts.status || 'review';
    open = true;
    if (!session || Date.now() - session.last > 30 * 60000) {
      session = { started: Date.now(), last: Date.now(), batches: 0, kept: 0, discarded: 0 };
    }
    selFor = null;
    bodySig = '';
    idx = 0;
    refreshList();
    const root = $('#triage-root');
    root.hidden = false;
    document.body.classList.add('triage-open');
    root.innerHTML = '<div class="tri-backdrop"><div class="tri-head" id="tri-head"></div><div class="tri-body" id="tri-body"></div></div>';
    document.addEventListener('keydown', onKey, true);
    render();
    pumpAhead();
  }

  function close() {
    open = false;
    zoom = -1;
    const root = $('#triage-root');
    root.hidden = true;
    root.innerHTML = '';
    document.body.classList.remove('triage-open');
    document.removeEventListener('keydown', onKey, true);
    State.emit('library', State.library);
  }

  function headHtml() {
    const p = prefs();
    const total = list.length;
    const cardsLeft = list.reduce((n, x) => n + x.cards.length, 0);
    const pace = session && session.batches
      ? `${Math.round((Date.now() - session.started) / 1000 / session.batches)} s per batch` : '';
    return `
      <div class="tri-title">▦ Pick keepers
        <span class="tri-count">${total ? `batch ${idx + 1} of ${total} · ${cardsLeft} card(s) still to judge` : 'nothing left to judge'}</span>
      </div>
      <div class="tri-session hint">${session && session.batches
        ? `this sitting: ${session.batches} batch(es) · ${session.kept} kept · ${session.discarded} discarded${pace ? ' · ' + pace : ''}`
        : 'one batch = one prompt’s renders, side by side'}${metaPending ? ` · ✎ writing titles for ${metaPending} batch(es)…` : ''}</div>
      <span style="flex:1"></span>
      <label class="tri-opt" title="Which end of the pile to start from">Order
        <select data-pref="order">
          <option value="newest" ${p.order === 'newest' ? 'selected' : ''}>Newest first</option>
          <option value="oldest" ${p.order === 'oldest' ? 'selected' : ''}>Oldest first</option>
        </select></label>
      <label class="tri-opt tri-ai" title="One vision call per batch looks at all the renders side by side and marks the clean ones. Runs a few batches ahead of you here, and on every new batch the worker makes. Only ever a suggestion — nothing is kept or discarded until you press a key.">
        <input type="checkbox" data-ai ${aiOn() ? 'checked' : ''} /> ✨ AI pre-pick</label>
      <button class="btn ghost small" data-act="close" title="Close (Esc)">✕</button>`;
  }

  function srcNote(b) {
    if (busy.has(b.key)) return '✨ the AI is looking at this batch…';
    if (touched) {
      const ai = b.cards.map((c, i) => (c.pick && c.pick.keep ? i + 1 : 0)).filter(Boolean);
      const mine = b.cards.map((c, i) => (sel.has(c.id) ? i + 1 : 0)).filter(Boolean);
      if (!b.cards.some((c) => c.pick) || ai.join() === mine.join()) return '';
      return ai.length ? `✨ The AI would keep #${ai.join(', #')} · A takes its pick` : '✨ The AI thinks every render is broken';
    }
    if (selSource === 'ai') {
      const nums = b.cards.map((c, i) => (sel.has(c.id) ? i + 1 : 0)).filter(Boolean);
      return nums.length ? `✨ AI picked #${nums.join(', #')} · Enter accepts` : '✨ The AI thinks every render is broken · X discards them';
    }
    if (selSource === 'qc') return 'Preselected by QC score · Enter accepts';
    return '';
  }

  function commitLabel(b) {
    const n = b.cards.length;
    return sel.size ? `Keep ${sel.size}, discard ${n - sel.size} ⏎` : `Pick a keeper (1–${Math.min(n, 9)}) · X discards all`;
  }

  function tileHtml(c, i) {
    const keep = sel.has(c.id);
    const pk = c.pick;
    const qc = c.qc && typeof c.qc.score === 'number'
      ? `<span class="tri-qc ${c.qc.verdict === 'PASS' ? 'ok' : 'bad'}">QC ${c.qc.score}</span>` : '';
    const mark = pk ? (pk.best ? '✨ best · ' : pk.keep ? '✨ keep · ' : pk.verdict === 'broken' ? '⚠ ' : '') : '';
    const ai = pk ? `<div class="tri-ai-note ${esc(pk.verdict)}" title="${esc(`${pk.verdict}${pk.issue ? ': ' + pk.issue : ''}${pk.engine ? ` — ${pk.engine}${pk.model ? ' · ' + pk.model : ''}` : ''}`)}">${
      mark}${esc(pk.issue || pk.verdict)}</div>` : '';
    return `<div class="tri-tile ${keep ? 'keep' : ''} ${Triage.isKept(c) ? 'was-kept' : ''}" data-i="${i}">
      <img src="${esc(c.url)}" alt="" draggable="false" />
      <span class="tri-num">${i + 1}</span>
      <span class="tri-badge">${keep ? '✓ KEEP' : ''}</span>
      <button class="tri-zoom" data-zoom="${i}" title="Full size (Shift+${i + 1})">⤢</button>
      ${qc}${ai}
    </div>`;
  }

  function zoomHtml(b, i) {
    const c = b.cards[i];
    const keep = sel.has(c.id);
    const pk = c.pick;
    return `<div class="tri-zoomview">
      <button class="modal-nav prev" data-znav="-1" title="Previous sibling (←)">‹</button>
      <div class="tri-zoomstage">
        <img class="tri-zoom-img ${keep ? 'keep' : ''}" src="${esc(c.url)}" alt="" title="Click to toggle keep" />
        <div class="modal-caption"><b>#${i + 1} of ${b.cards.length}</b> · ${keep ? '<span class="ok">✓ keeper</span>' : 'not kept'}
          ${pk ? ` · ✨ ${esc(pk.verdict)}${pk.issue ? ': ' + esc(pk.issue) : ''}` : ''}
          · <kbd>Space</kbd> toggle · <kbd>←</kbd>/<kbd>→</kbd> siblings · <kbd>Esc</kbd> back to the batch</div>
      </div>
      <button class="modal-nav next" data-znav="1" title="Next sibling (→)">›</button>
    </div>`;
  }

  function bodyHtml(b) {
    const p = prefs();
    if (!b) {
      return `<div class="tri-empty">
        <div class="tri-empty-big">All caught up.</div>
        <div class="hint">Every batch in Review has been judged. Keepers stay in Review marked ★ — the <b>Keepers</b> chip lists them${p.keepTo === 'approved' ? ', or they wait in Approved' : ''}. Discarded cards can be restored from the Discarded chip.</div>
        ${undoStack.length ? '<button class="btn" data-act="undo">↶ Undo the last batch</button>' : ''}
      </div>`;
    }
    const n = b.cards.length;
    const cols = bestCols(n, window.innerWidth - 48, window.innerHeight - 250);
    const hasPick = b.cards.some((c) => c.pick);
    const date = new Date(b.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    const middle = zoom >= 0 && b.cards[zoom]
      ? zoomHtml(b, zoom)
      : `<div class="tri-grid" style="grid-template-columns:repeat(${cols}, 1fr)">${b.cards.map(tileHtml).join('')}</div>`;
    return `
      <div class="tri-prompt" title="${esc(b.prompt)}">
        <span class="pill review">${n} render${n === 1 ? '' : 's'}</span>
        ${b.theme ? `<b>${esc(b.theme)}</b>` : ''}<span class="hint">${esc(date)}${b.promptSource ? ' · ' + esc(b.promptSource) : ''}</span>
        <span class="tri-prompt-text">${esc(b.prompt)}</span>
        <button class="btn ghost small" data-act="copyprompt" title="Copy the prompt">⧉</button>
      </div>
      ${middle}
      <div class="tri-foot">
        <div class="tri-keys keyhint">
          <kbd>1</kbd>–<kbd>9</kbd> keep · <kbd>Enter</kbd> keep selected, discard rest · <kbd>X</kbd> discard all ·
          <kbd>→</kbd> skip · <kbd>←</kbd> back · <kbd>Shift</kbd>+<kbd>1</kbd> full size · <kbd>G</kbd> ask AI${hasPick ? ' · <kbd>A</kbd> take AI pick' : ''} · <kbd>U</kbd> undo · <kbd>Esc</kbd> close
        </div>
        <div class="tri-actions">
          <span class="tri-src hint">${esc(srcNote(b))}</span>
          <span style="flex:1"></span>
          <label class="tri-opt" title="Where the pictures you keep go. Review keeps them in your reserve, marked ★; Approved puts them in line for the Drafts tab's upload button.">Keepers
            <select data-pref="keepTo">
              <option value="review" ${p.keepTo === 'review' ? 'selected' : ''}>stay in Review ★</option>
              <option value="approved" ${p.keepTo === 'approved' ? 'selected' : ''}>go to Approved</option>
            </select></label>
          <label class="tri-opt" title="Write titles, descriptions and tags for keepers in the background. From the prompt is one text call per batch; from the image is one vision call per keeper.">Titles
            <select data-pref="meta">
              <option value="none" ${p.meta === 'none' ? 'selected' : ''}>later, by hand</option>
              <option value="prompt" ${p.meta === 'prompt' ? 'selected' : ''}>write from prompt</option>
              <option value="image" ${p.meta === 'image' ? 'selected' : ''}>✨ write from image</option>
            </select></label>
          <button class="btn small" data-act="ask" ${busy.has(b.key) ? 'disabled' : ''} title="Ask the vision model which renders are clean (G)">✨ Ask AI</button>
          <button class="btn ghost small" data-act="undo" ${undoStack.length ? '' : 'disabled'} title="Put the last batch back as it was (U)">↶ Undo</button>
          <button class="btn small" data-act="skip" title="Leave this batch for later (→)">Skip →</button>
          <button class="btn danger small" data-act="discardall" title="Discard every render of this prompt (X)">Discard all</button>
          <button class="btn primary" data-act="commit" ${sel.size ? '' : 'disabled'} title="Keep the selected, discard the rest (Enter)">${commitLabel(b)}</button>
        </div>
      </div>`;
  }

  /** What the body's markup depends on, apart from the selection (painted in place). */
  function signature(b) {
    return JSON.stringify([
      b && b.key, b && b.cards.map((c) => [c.id, c.pick && c.pick.at, Triage.isKept(c)]),
      zoom, zoom >= 0 ? [...sel] : null, b && busy.has(b.key), undoStack.length,
      prefs(), window.innerWidth, window.innerHeight,
    ]);
  }

  function render() {
    if (!open) return;
    syncSelection();
    const head = $('#tri-head');
    const body = $('#tri-body');
    if (!head || !body) return;
    head.innerHTML = headHtml();
    wireControls(head);
    const b = current();
    const sig = signature(b);
    if (sig !== bodySig) {
      bodySig = sig;
      body.innerHTML = bodyHtml(b);
      wireControls(body);
      body.querySelectorAll('.tri-tile').forEach((el) => {
        el.addEventListener('click', (e) => {
          if (e.target.closest('[data-zoom]')) return;
          toggle(Number(el.dataset.i));
        });
        el.addEventListener('dblclick', () => { zoom = Number(el.dataset.i); render(); });
      });
      body.querySelectorAll('[data-zoom]').forEach((z) =>
        z.addEventListener('click', () => { zoom = Number(z.dataset.zoom); render(); }));
      const zimg = body.querySelector('.tri-zoom-img');
      if (zimg) zimg.addEventListener('click', () => toggle(zoom));
    } else if (b) {
      paintSelection(b);
    }
  }

  /** The selection, painted onto tiles that are already on screen. */
  function paintSelection(b) {
    const body = $('#tri-body');
    body.querySelectorAll('.tri-tile').forEach((el) => {
      const c = b.cards[Number(el.dataset.i)];
      const keep = !!c && sel.has(c.id);
      el.classList.toggle('keep', keep);
      const badge = el.querySelector('.tri-badge');
      if (badge) badge.textContent = keep ? '✓ KEEP' : '';
    });
    const btn = body.querySelector('[data-act="commit"]');
    if (btn) { btn.textContent = commitLabel(b); btn.disabled = !sel.size; }
    const note = body.querySelector('.tri-src');
    if (note) note.textContent = srcNote(b);
  }

  function wireControls(root) {
    root.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', () => act(btn.dataset.act)));
    root.querySelectorAll('[data-pref]').forEach((s) => s.addEventListener('change', async () => {
      const key = s.dataset.pref;
      await setPref({ [key]: s.value });
      if (key === 'order') refreshList(current() && current().key);
      s.blur();
      render();
    }));
    root.querySelectorAll('[data-znav]').forEach((b) => b.addEventListener('click', () => moveZoom(Number(b.dataset.znav))));
    const ai = root.querySelector('[data-ai]');
    if (ai) ai.addEventListener('change', async () => {
      State.settings = await window.ala.settings.patch({ gen: { autoPick: ai.checked } });
      ai.blur();
      if (ai.checked) {
        toast('AI pre-pick on — new batches get a suggestion as they are made, and here it works a few batches ahead of you.', 'ok');
        pumpAhead();
      }
      render();
    });
  }

  function toggle(i) {
    const b = current();
    if (!b || !b.cards[i]) return;
    const id = b.cards[i].id;
    if (sel.has(id)) sel.delete(id); else sel.add(id);
    touched = true;
    render();
  }

  function moveZoom(d) {
    const b = current();
    if (!b) return;
    zoom = (zoom + d + b.cards.length) % b.cards.length;
    render();
  }

  function commit(keepIds) {
    const b = current();
    if (!b) return;
    const nextKey = list[idx + 1] ? list[idx + 1].key : null;
    const rec = Triage.commit(b, keepIds, { keepTo: prefs().keepTo, aiSource: touched ? 'edited' : selSource });
    remembered.delete(b.key);
    touched = false;
    const kept = b.cards.filter((c) => keepIds.includes(c.id));
    undoStack.push({ rec, kept: kept.length, discarded: b.cards.length - kept.length });
    if (undoStack.length > 30) undoStack.shift();
    session.batches += 1;
    session.kept += kept.length;
    session.discarded += b.cards.length - kept.length;
    session.last = Date.now();
    writeTitles(kept);
    refreshList(nextKey);
    selFor = null;
    render();
    pumpAhead();
  }

  /** Background metadata for keepers, one batch at a time so a long sitting never piles calls up. */
  function writeTitles(cards) {
    const mode = prefs().meta;
    const need = cards.filter((c) => mode === 'image' || !Pipeline.hasMetadata(c));
    if (mode === 'none' || !need.length) return;
    metaPending += 1;
    metaChain = metaChain.then(async () => {
      try {
        const res = mode === 'image'
          ? await Pipeline.enhanceMetadataForCards(need)
          : await Pipeline.writeMetadataForCards(need);
        if (res && res.failed) State.addLog(`Pick keepers: metadata failed for ${res.failed} keeper(s).`, 'err');
      } catch (e) {
        State.addLog(`Pick keepers: could not write metadata (${e.message}).`, 'err');
      } finally {
        metaPending -= 1;
        if (open) render();
      }
    });
  }

  function undo() {
    const last = undoStack.pop();
    if (!last) { toast('Nothing to undo.', 'ok'); return; }
    const n = Triage.undo(last.rec);
    if (session) {
      session.batches = Math.max(0, session.batches - 1);
      session.kept = Math.max(0, session.kept - last.kept);
      session.discarded = Math.max(0, session.discarded - last.discarded);
    }
    refreshList(last.rec.key);
    selFor = null;
    render();
    toast(`Put ${n} card(s) back as they were.`, 'ok');
  }

  async function askAi(b = current(), { quiet = false } = {}) {
    if (!b || busy.has(b.key)) return;
    busy.add(b.key);
    if (current() && current().key === b.key) render();
    try {
      await Triage.suggest(b);
      if (!quiet) toast('✨ Suggestion ready.', 'ok');
    } catch (e) {
      if (!quiet) toast('The AI could not pick: ' + e.message, 'err');
      else State.addLog(`AI pre-pick skipped a batch: ${e.message}`, 'err');
    } finally {
      busy.delete(b.key);
      if (open && current() && current().key === b.key && !touched) selFor = null;
      if (open) render();
    }
  }

  /** Keep suggestions a few batches ahead of the artist, one call at a time. */
  async function pumpAhead() {
    if (aheadRunning || !open || !aiOn()) return;
    aheadRunning = true;
    try {
      const tried = new Set();
      while (open && aiOn()) {
        const next = list.slice(idx, idx + AHEAD).find((b) => b.cards.length > 1
          && !b.cards.some((c) => c.pick) && !busy.has(b.key) && !tried.has(b.key));
        if (!next) break;
        tried.add(next.key);
        await askAi(next, { quiet: true });
      }
    } finally {
      aheadRunning = false;
    }
  }

  function act(what) {
    const b = current();
    switch (what) {
      case 'close': close(); return;
      case 'undo': undo(); return;
      case 'skip':
        if (!b) return;
        idx = Math.min(list.length - 1, idx + 1); render(); pumpAhead(); return;
      case 'back':
        idx = Math.max(0, idx - 1); render(); return;
      case 'commit':
        if (!b) return;
        if (!sel.size) { toast('Nothing picked yet — press a tile’s number to keep it, or X to discard the whole batch.', 'err'); return; }
        commit([...sel]);
        return;
      case 'discardall': if (b) commit([]); return;
      case 'ask': askAi(); return;
      case 'takeai':
        if (!b || !b.cards.some((c) => c.pick)) return;
        sel = new Set(b.cards.filter((c) => c.pick && c.pick.keep).map((c) => c.id));
        selSource = 'ai'; touched = false; render(); return;
      case 'copyprompt':
        if (b) window.ala.clip.text(b.prompt).then(() => toast('Prompt copied.', 'ok')).catch(() => {});
        return;
      default:
    }
  }

  function onKey(ev) {
    if (!open) return;
    if ($('#modal-root') && $('#modal-root').innerHTML) return;
    const t = ev.target;
    if (t && (t.tagName === 'SELECT' || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && ev.key !== 'Escape') return;
    const k = ev.key;
    const handled = () => { ev.preventDefault(); ev.stopPropagation(); };

    if ((ev.ctrlKey || ev.metaKey) && (k === 'z' || k === 'Z')) { handled(); undo(); return; }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.repeat && (k === 'Enter' || k === 'x' || k === 'X' || k === 'Delete')) { handled(); return; }

    if (zoom >= 0) {
      if (k === 'Escape' || k === 'z') { handled(); zoom = -1; render(); return; }
      if (k === 'ArrowRight' || k === 'ArrowDown') { handled(); moveZoom(1); return; }
      if (k === 'ArrowLeft' || k === 'ArrowUp') { handled(); moveZoom(-1); return; }
      if (k === ' ') { handled(); toggle(zoom); return; }
    }

    const m = /^(?:Digit|Numpad)(\d)$/.exec(ev.code || '');
    if (m) {
      handled();
      const i = m[1] === '0' ? 9 : Number(m[1]) - 1;
      if (ev.shiftKey) { if (current() && current().cards[i]) { zoom = i; render(); } return; }
      toggle(i);
      return;
    }
    switch (k) {
      case 'Escape': handled(); close(); return;
      case 'Enter': handled(); act('commit'); return;
      case 'x': case 'X': case 'Delete': handled(); act('discardall'); return;
      case 'ArrowRight': case 's': case 'S': handled(); act('skip'); return;
      case 'ArrowLeft': case 'p': case 'P': handled(); act('back'); return;
      case 'g': case 'G': handled(); act('ask'); return;
      case 'a': case 'A': handled(); act('takeai'); return;
      case 'u': case 'U': handled(); undo(); return;
      default:
        if (k.length === 1) handled();
    }
  }

  const onLibrary = U.debounce(() => {
    if (!open) return;
    refreshList(current() && current().key);
    render();
  }, 400);

  window.TriageUI = {
    open: openTriage,
    close,
    isOpen: () => open,
    wire() {
      State.on('library', () => onLibrary());
      window.addEventListener('resize', U.debounce(() => { if (open) render(); }, 150));
    },
    /** For the Review toolbar button: how many open batches, and how many cards in them. */
    count(st = 'review') {
      const b = Triage.batches({ status: st });
      return { batches: b.length, cards: b.reduce((n, x) => n + x.cards.length, 0) };
    },
  };
})();
