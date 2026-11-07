/**
 * seriesui.js: the Series panel in the Comics tab.
 *
 * Create a series (name, what it is about, its DeviantArt folder, panels, page layout),
 * start the next part with one button, and follow each part from "being made" to Review,
 * upload and posting.
 */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STATUS = { making: 'being made', review: 'in Review', uploaded: 'uploaded', posted: 'posted', failed: 'failed', dropped: 'dropped', gone: 'project deleted' };
  const open = new Set();
  let formOpen = false;
  let starting = null;

  function galleries() {
    return ((State.settings.da && State.settings.da.galleryCache) || []).filter((g) => g.special !== 'featured');
  }

  function folderSelect(id, current = '') {
    return `<select id="${id}"><option value="">No folder (Featured)</option>${galleries().map((g) => `<option value="${esc(g.id)}" ${String(g.id) === String(current) ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>`;
  }

  function formHtml() {
    return `<div class="series-form">
      <div class="fld-row" style="flex-wrap:wrap">
        <label class="fld" style="min-width:200px;flex:1"><span>Series name</span><input id="sr-name" maxlength="40" placeholder="The Lighthouse Letters" /></label>
        <label class="fld" style="min-width:200px"><span>DeviantArt folder</span>${folderSelect('sr-folder')}</label>
        <label class="fld slim"><span>Panels</span><input id="sr-panels" type="number" min="3" max="6" value="4" /></label>
        <label class="fld" style="min-width:150px"><span>Page</span><select id="sr-layout"><option value="auto">Picked from the shots</option><option value="grid">2 × 2 grid (4 panels)</option></select></label>
      </div>
      <label class="fld"><span>What the series is about <em>(the recurring story or theme)</em></span>
        <textarea id="sr-about" rows="2" maxlength="600" placeholder="A lighthouse keeper finds a new message in a bottle every week, and each one sends her somewhere unexpected."></textarea></label>
      <label class="fld"><span>World <em>(optional)</em></span><input id="sr-world" maxlength="400" placeholder="A windy island village; the letters seem to know her." /></label>
      <div class="checkbox-row" title="Every panel is the next stage of one change, in the same framing (the comic's sequence mode)"><input type="checkbox" id="sr-sequence" /><span>Each part is a change sequence</span></div>
      <div class="btn-row"><button class="btn primary small" id="btn-sr-create">Create series</button><button class="btn ghost small" id="btn-sr-cancel">Cancel</button></div>
    </div>`;
  }

  function partRow(s, p) {
    const card = window.Series.cardOf(p);
    const url = card && card.da && card.da.url;
    const title = (p.plan && p.plan.title && !/^part\s*\d+$/i.test(p.plan.title)) ? p.plan.title : '';
    return `<div class="series-part">
      <b>Part ${p.n}</b>${title ? ` — ${esc(title)}` : ''}
      <span class="p-tag">${esc(STATUS[p.status] || p.status)}</span>
      ${p.planned === 'fallback' ? '<span class="hint warn" title="The writer failed twice; this part uses the plain plan.">plain plan</span>' : ''}
      ${url ? `<a href="#" data-act="sr-open" data-url="${esc(url)}">open on DeviantArt</a>` : ''}
      <div class="hint">${esc(p.plan ? p.plan.logline : '')}</div>
    </div>`;
  }

  function seriesRow(s) {
    const last = s.parts[s.parts.length - 1];
    const folder = s.folderName || (galleries().find((g) => String(g.id) === String(s.folderId)) || {}).name || '';
    return `<div class="series-row" data-id="${esc(s.id)}">
      <div class="series-line">
        <b>${esc(s.name)}</b>
        <span class="hint">${s.parts.length} part(s)${folder ? ` · folder: ${esc(folder)}` : ' · no folder'}${last ? ` · last: Part ${last.n} ${esc(STATUS[last.status] || last.status)}` : ''}</span>
        <div class="btn-row" style="margin-left:auto">
          <button class="btn primary small" data-act="sr-next" ${starting ? 'disabled' : ''}>${starting === s.id ? 'Planning…' : `Make Part ${(last ? last.n : 0) + 1}`}</button>
          <button class="btn ghost small" data-act="sr-toggle">${open.has(s.id) ? 'Hide parts' : 'Parts'}</button>
          <button class="btn ghost small" data-act="sr-delete" title="Removes the series list entry. Its comic pages and Review cards stay.">✕</button>
        </div>
      </div>
      <div class="hint">${esc(s.about || s.mechanic || '')}</div>
      ${open.has(s.id) ? `<div class="series-parts">${s.parts.length ? s.parts.slice().reverse().map((p) => partRow(s, p)).join('') : '<div class="hint">No parts yet.</div>'}</div>` : ''}
    </div>`;
  }

  function render() {
    const root = $('#series-list');
    if (!root || !window.Series) return;
    Series.refresh();
    const list = Series.list();
    root.innerHTML = (formOpen ? formHtml() : '')
      + (list.length ? list.map(seriesRow).join('') : (formOpen ? '' : '<div class="hint">No series yet. A series is a named recurring story or theme; each part is a comic page with balloons, titled "Name — Part N" and filed in its own DeviantArt folder.</div>'));
  }

  async function create() {
    try {
      const sel = $('#sr-folder');
      const s = Series.create({
        name: $('#sr-name').value, about: $('#sr-about').value, world: $('#sr-world').value, sequence: !!($('#sr-sequence') || {}).checked,
        folderId: sel.value, folderName: sel.value ? sel.selectedOptions[0].textContent : '',
        panels: Number($('#sr-panels').value) || 4, layout: $('#sr-layout').value,
      });
      formOpen = false;
      open.add(s.id);
      window.toast(`Series "${s.name}" created.`, 'ok');
      render();
    } catch (e) { window.toast(e.message, 'err'); }
  }

  async function next(id) {
    if (starting) return;
    starting = id;
    render();
    try {
      const { part } = await Series.nextPart(id);
      open.add(id);
      window.toast(`Part ${part.n} is planned and queued. Its page lands in Review when the panels are drawn.`, 'ok');
      State.addLog(`Series: Part ${part.n} started (${part.planned === 'fallback' ? 'plain plan, the writer failed' : 'writer plan'}): ${part.plan.logline}`, 'ok');
    } catch (e) {
      window.toast(`Could not start the part: ${e.message}`, 'err');
    } finally {
      starting = null;
      render();
    }
  }

  function init() {
    const root = $('#series-list');
    if (!root) return;
    const add = $('#btn-series-new');
    if (add) add.addEventListener('click', () => { formOpen = !formOpen; render(); });
    root.addEventListener('click', (ev) => {
      const el = ev.target.closest('[data-act]');
      if (!el) return;
      const row = el.closest('.series-row');
      const id = row && row.dataset.id;
      const act = el.dataset.act;
      if (act === 'sr-next') next(id);
      else if (act === 'sr-toggle') { open.has(id) ? open.delete(id) : open.add(id); render(); }
      else if (act === 'sr-delete') {
        const s = Series.get(id);
        if (s && window.confirm(`Remove the series "${s.name}" from this list? Its comic pages and Review cards stay.`)) { Series.remove(id); render(); }
      } else if (act === 'sr-open') { ev.preventDefault(); window.ala.app && window.ala.app.openExternal ? window.ala.app.openExternal(el.dataset.url) : window.open(el.dataset.url); }
    });
    root.addEventListener('click', (ev) => {
      if (ev.target.id === 'btn-sr-create') create();
      if (ev.target.id === 'btn-sr-cancel') { formOpen = false; render(); }
    });
    const tab = document.querySelector('[data-tab="comics"]');
    if (tab) tab.addEventListener('click', () => setTimeout(render, 60));
    if (window.State && State.on) State.on('library', () => { if (document.querySelector('#pane-comics.active')) render(); });
    render();
  }

  window.SeriesUI = { init, render };
})();
