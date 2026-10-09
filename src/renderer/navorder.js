/* navorder.js — the sidebar tabs in the artist's own order.
 *
 * Hold a tab for 1 s and it lifts; drag it up or down and the other tabs slide out of its way
 * (the Android launcher "shove"); let go and it settles into the gap. Esc puts it back.
 *
 * The order is saved as `settings.ui.tabOrder` (an array of data-tab ids). Settings are the
 * authority, but they arrive over IPC after the first paint, so — like theme.js — a
 * localStorage mirror is applied the moment this script runs (the <nav> is already parsed by
 * then) and app.js re-applies from settings once they load. Ctrl+1…9 are pinned to tab NAMES
 * (NUM_TABS in app.js), so moving a tab never moves a shortcut.
 *
 * A tab that is missing from a saved order (a new tab from an update) is put back after the
 * tab it follows in the shipped order, so updates never hide or misplace a new tab.
 */
window.NavOrder = (function () {
  const KEY = 'ala.tabOrder';
  const HOLD_MS = 1000;
  const MOVE_CANCEL_PX = 8;        // moving further than this before the hold ends = not a hold
  const SHOVE_MS = 200;
  const SETTLE_MS = 220;
  const nav = () => document.getElementById('nav');
  const buttons = () => Array.from((nav() || document).querySelectorAll('.nav-btn'));
  const ids = () => buttons().map((b) => b.dataset.tab);
  let shipped = null;              // the order index.html ships with, captured before any reorder
  let onChange = null;

  /**
   * Pure: the saved order applied to the tabs that exist. Unknown ids are dropped, duplicates
   * ignored, and a tab the saved order does not know lands after its shipped predecessor.
   */
  function merge(defaults, saved) {
    const known = new Set(defaults);
    const out = [];
    for (const id of Array.isArray(saved) ? saved : []) {
      if (known.has(id) && !out.includes(id)) out.push(id);
    }
    defaults.forEach((id, i) => {
      if (out.includes(id)) return;
      let at = 0;
      for (let j = i - 1; j >= 0; j--) {
        const k = out.indexOf(defaults[j]);
        if (k >= 0) { at = k + 1; break; }
      }
      out.splice(at, 0, id);
    });
    return out;
  }

  function readMirror() {
    try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); return Array.isArray(v) ? v : null; } catch { return null; }
  }
  function writeMirror(order) {
    try { if (order) localStorage.setItem(KEY, JSON.stringify(order)); else localStorage.removeItem(KEY); } catch { /* private mode */ }
  }

  /** Put the buttons in `saved` order (null/empty = the shipped order). */
  function apply(saved) {
    const n = nav();
    if (!n) return;
    if (!shipped) shipped = ids();
    const order = merge(shipped, saved);
    const byId = new Map(buttons().map((b) => [b.dataset.tab, b]));
    for (const id of order) { const b = byId.get(id); if (b) n.appendChild(b); }
    writeMirror(saved && saved.length ? order : null);
  }

  const isDefault = () => !shipped || ids().join() === shipped.join();

  function reset() {
    apply(null);
    if (onChange) onChange(null);
  }

  // ---------------------------------------------------------------- drag
  const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let press = null;                // { btn, id, x, y, timer }
  let drag = null;                 // { btn, list, from, to, rects, startY, step, minDy, maxDy }
  let swallowClick = false;

  function clearPress() {
    if (!press) return;
    clearTimeout(press.timer);
    press.btn.classList.remove('nav-pressing');
    press = null;
  }

  function startDrag() {
    const btn = press.btn;
    const pointerId = press.id;
    const startY = press.y;
    clearPress();
    // Only tabs that are on screen take part (hidden ones — Pixiv off, etc. — have no box).
    const list = buttons().filter((b) => b.offsetParent !== null);
    const from = list.indexOf(btn);
    if (from < 0) return;
    const rects = list.map((b) => b.getBoundingClientRect());
    const gap = list.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 0;
    drag = {
      btn, list, from, to: from, rects, startY,
      step: rects[from].height + gap,
      minDy: rects[0].top - rects[from].top,
      maxDy: rects[rects.length - 1].bottom - rects[from].bottom,
    };
    try { btn.setPointerCapture(pointerId); } catch { /* pointer already gone */ }
    nav().classList.add('nav-dragging');
    btn.classList.add('nav-lifted');
    for (const b of list) if (b !== btn) b.style.transition = reduced() ? 'none' : `transform ${SHOVE_MS}ms cubic-bezier(.2,.8,.2,1)`;
    swallowClick = true;
  }

  function moveDrag(y) {
    const d = drag;
    const raw = y - d.startY;
    const dy = Math.max(d.minDy, Math.min(d.maxDy, raw));
    d.btn.style.transform = `translateY(${dy}px) scale(1.04)`;
    // Where the pointer has taken the tab's centre, against the other tabs' original centres.
    // Unclamped, so pushing past the first/last tab always reaches the end slot.
    const centre = d.rects[d.from].top + d.rects[d.from].height / 2 + raw;
    let to = d.from;
    for (let i = d.from + 1; i < d.list.length; i++) if (centre >= d.rects[i].top + d.rects[i].height / 2) to = i;
    for (let i = d.from - 1; i >= 0; i--) if (centre <= d.rects[i].top + d.rects[i].height / 2) to = i;
    d.to = to;
    d.list.forEach((b, i) => {
      if (b === d.btn) return;
      const shift = d.from < to && i > d.from && i <= to ? -d.step
        : to < d.from && i >= to && i < d.from ? d.step : 0;
      b.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  }

  function endDrag(cancel) {
    const d = drag;
    drag = null;
    if (cancel) d.to = d.from;
    const finalDy = d.to > d.from ? d.rects[d.to].bottom - d.rects[d.from].bottom
      : d.to < d.from ? d.rects[d.to].top - d.rects[d.from].top : 0;
    if (cancel) d.list.forEach((b) => { if (b !== d.btn) b.style.transform = ''; });
    const settle = reduced() ? 0 : SETTLE_MS;
    d.btn.style.transition = settle ? `transform ${settle}ms cubic-bezier(.2,.8,.2,1), box-shadow ${settle}ms ease` : 'none';
    d.btn.style.transform = `translateY(${finalDy}px) scale(1)`;
    d.btn.classList.add('nav-settling');
    setTimeout(() => {
      // Reorder for real, then drop every transform in the same frame: the new layout is
      // exactly where the transforms had put each tab, so nothing jumps.
      if (d.to !== d.from) {
        const anchor = d.list[d.to];
        anchor.parentNode.insertBefore(d.btn, d.to > d.from ? anchor.nextSibling : anchor);
      }
      for (const b of d.list) { b.style.transition = 'none'; b.style.transform = ''; }
      d.btn.classList.remove('nav-lifted', 'nav-settling');
      nav().classList.remove('nav-dragging');
      // Re-enable the hover transitions on the next frame, after the reset has painted.
      requestAnimationFrame(() => { for (const b of d.list) b.style.transition = ''; });
      if (d.to !== d.from) {
        const order = ids();
        writeMirror(order);
        if (onChange) onChange(order);
      }
    }, settle + 20);
  }

  function wire({ changed } = {}) {
    onChange = changed || null;
    const n = nav();
    if (!n || n.dataset.reorderWired) return;
    n.dataset.reorderWired = '1';
    if (!shipped) shipped = ids();

    n.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || drag) return;
      const btn = e.target.closest('.nav-btn');
      if (!btn) return;
      clearPress();
      press = { btn, id: e.pointerId, x: e.clientX, y: e.clientY, timer: setTimeout(startDrag, HOLD_MS) };
      btn.classList.add('nav-pressing');
    });
    n.addEventListener('pointermove', (e) => {
      if (drag) { e.preventDefault(); moveDrag(e.clientY); return; }
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_CANCEL_PX) clearPress();
    });
    const up = (e) => {
      if (drag) { e.preventDefault(); endDrag(e.type === 'pointercancel'); return; }
      clearPress();
    };
    n.addEventListener('pointerup', up);
    n.addEventListener('pointercancel', up);
    n.addEventListener('pointerleave', () => { if (!drag) clearPress(); });
    // The click that ends a drag (or a 1 s hold) must not also switch tabs.
    n.addEventListener('click', (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation(); e.preventDefault();
    }, true);
    n.addEventListener('contextmenu', (e) => { if (drag || press) e.preventDefault(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && drag) { e.preventDefault(); endDrag(true); }
    });
    // A drag that ends with the click landing elsewhere must not swallow a later real click.
    document.addEventListener('pointerdown', () => { if (!drag) swallowClick = false; }, true);
  }

  // The <nav> is parsed before this script runs: put the remembered order on it before the
  // first paint, the way theme.js does for the palette.
  apply(readMirror());

  return { merge, apply, wire, reset, isDefault, current: ids, shipped: () => (shipped || ids()).slice(), HOLD_MS };
})();
