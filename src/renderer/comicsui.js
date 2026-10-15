/**
 * comicsui.js: the Comics tab.
 *
 * Brief (premise, cast pictures, format, panels, page style) and one Make button;
 * then a live preview of the REAL page composer next to an inspector for the
 * selected panel: takes, reroll, edit in words, and its balloons. Balloons are
 * dragged, resized and their tails aimed directly on the canvas.
 */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const esc = U.escapeHtml;

  let activeId = null;
  let selectedPanel = null;
  let previewScale = 1;
  let drag = null;
  let selItem = null;
  let lastSig = '';
  let paintQueued = false;

  const ui = () => ({ C: window.Comics, P: window.ComicPrompts, L: window.ComicLayout });

  const PHASE_LABEL = {
    draft: 'Not started', 'reading the cast': 'Reading your picture', storyboard: 'Writing the storyboard',
    cast: 'Drawing the cast', 'cast-review': 'Approve the cast', panels: 'Drawing panels', picking: 'Choosing takes',
    lettering: 'Lettering', composing: 'Composing', done: 'Done', stopped: 'Stopped', 'needs attention': 'Needs attention',
  };

  const ComicsUI = {
    wire() {
      $('#btn-comic-new').addEventListener('click', () => this.create());
      State.on('comics', () => this.onData());
      State.on('queue', () => this.onData());
    },

    render() {
      this.renderRail();
      this.renderWork();
    },

    active() { return activeId ? Comics.get(activeId) : null; },

    create(seed = {}) {
      const p = Comics.create({ panels: 4, ...seed });
      activeId = p.id;
      selectedPanel = null;
      selItem = null;
      this.render();
      const box = $('#cx-premise');
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
      return p;
    },

    onData() {
      if (!$('#pane-comics') || !$('#pane-comics').classList.contains('active')) { this.renderRail(); return; }
      this.renderRail();
      const p = this.active();
      if (!p) return;
      const sig = this.signature(p);
      const typing = document.activeElement && $('#comic-work') && $('#comic-work').contains(document.activeElement)
        && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (sig !== lastSig && !typing) { this.renderWork(); return; }
      this.renderStatus(p);
      this.schedulePaint();
    },

    signature(p) {
      const sel = p.panels.find((x) => x.id === selectedPanel) || p.panels[0];
      return JSON.stringify([
        p.id, p.storyboarded, p.panels.length, p.run.active, p.run.phase === 'cast-review', p.format,
        p.cast.map((m) => [m.id, m.name, m.sheet && m.sheet.fname, m.afterSheet && m.afterSheet.fname, !!m.sheetJobId, !!m.afterJobId, (m.refs || []).length, m.sheetCheck && m.sheetCheck.identity]),
        (p.locations || []).map((l) => [l.id, l.name, l.plate && l.plate.fname, !!l.plateJobId, l.plateFailed]),
        sel ? [sel.id, sel.takes.length, sel.chosen, sel.status, sel.lines.length, !!sel.pick, sel.caption, sel.sfx,
          sel.lines.map((l) => `${l.text}/${l.kind}/${l.speaker}`).join('|'), sel.locationId] : null,
        p.lettered, !!p.page,
      ]);
    },

    renderRail() {
      const root = $('#comic-projects');
      if (!root) return;
      const list = Comics.data.projects;
      if (!list.length) {
        root.innerHTML = '<div class="hint">No comics yet. Press <b>+ New comic</b>, write one sentence, press Make.</div>';
        return;
      }
      root.innerHTML = list.map((p) => {
        const chosen = p.panels.find((x) => x.chosen);
        const thumb = (p.page && p.page.url) || (chosen ? `ala://img/${chosen.chosen}` : '');
        const done = p.panels.filter((x) => x.chosen).length;
        return `<div class="comic-proj ${p.id === activeId ? 'on' : ''}" data-proj="${p.id}">
          ${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" />` : '<div class="arch-nothumb">▥</div>'}
          <div class="cp-info">
            <div class="cp-name">${esc(p.title || p.name)}</div>
            <div class="hint">${p.run.active ? '● ' : ''}${esc(PHASE_LABEL[p.run.phase] || p.run.phase)}${p.panels.length ? ` · ${done}/${p.panels.length}` : ''}</div>
          </div>
        </div>`;
      }).join('');
      root.querySelectorAll('[data-proj]').forEach((el) =>
        el.addEventListener('click', () => { activeId = el.dataset.proj; selectedPanel = null; selItem = null; this.render(); }));
    },

    guideHtml() {
      return `<div class="panel">
        <div class="panel-head"><h2>Make a comic</h2></div>
        <ol class="cx-guide">
          <li><b>Write the premise</b> — one or two sentences. Optionally add pictures of the characters (yours, the library's) — a clean
            cast sheet is drawn from them. Ask the Overseer and it finds pictures of known characters on the web itself.</li>
          <li><b>Press Make.</b> The writer plans the panels, a clean cast sheet is drawn per character, and every panel is drawn
            with that sheet attached as a reference, so it is the same person in every panel. Panels go through the normal queue.</li>
          <li><b>The words come last:</b> a vision model looks at the finished panels and writes captions and dialogue to match what
            is actually drawn; balloons are placed off the faces. The page lands in Review.</li>
          <li><b>Fix anything:</b> pick another take, reroll a panel, or edit it in words ("add a red scarf"). Click a balloon to
            move it, aim its tail, resize it or rewrite it.</li>
        </ol>
        <div class="btn-row" style="margin-top:14px">
          <button class="btn primary" id="cx-guide-new">+ New comic</button>
          <button class="btn ghost" id="cx-guide-example">Start from an example</button>
          <button class="btn ghost" id="cx-guide-seq">Example: step-by-step sequence</button>
        </div>
        <div class="hint" style="margin-top:8px">Needs the ComfyUI engine with the Qwen-Image 2.1 reference workflow (Settings → Generation).</div>
      </div>`;
    },

    renderWork() {
      const root = $('#comic-work');
      if (!root) return;
      const p = this.active();
      if (!p) {
        root.innerHTML = this.guideHtml();
        const b = (s, f) => { const el = $(s); if (el) el.addEventListener('click', f); };
        b('#cx-guide-new', () => this.create());
        b('#cx-guide-example', () => this.create({
          premise: 'A young inventor tests her homemade jetpack in the backyard; it sputters, she crashes into the hedge and climbs out laughing with leaves in her hair.',
          theme: 'backyard slapstick',
        }));
        b('#cx-guide-seq', () => this.create({
          premise: 'A knight in the castle armoury puts on a suit of armour piece by piece — boots, breastplate, gauntlets, then the helmet — and ends ready for the tournament.',
          theme: 'getting ready', panels: 3, sequence: true, lettering: 'float', pageStyle: 'rounded',
        }));
        lastSig = '';
        return;
      }
      if (!selectedPanel || !p.panels.some((x) => x.id === selectedPanel)) selectedPanel = p.panels[0] ? p.panels[0].id : null;
      lastSig = this.signature(p);
      root.innerHTML = `${this.briefHtml(p)}
        <div class="panel" style="padding:10px 14px"><div class="cx-status" id="cx-status"></div></div>
        <div class="cx-main">
          <div>
            <div class="cx-itembar" id="cx-itembar"></div>
            <div class="cx-stage" id="cx-stage"><canvas id="cx-canvas" tabindex="0"></canvas><textarea id="cx-inline" class="cx-inline" style="display:none"></textarea></div>
            <div class="btn-row" style="margin-top:10px">
              <button class="btn" id="cx-reletter" ${p.panels.some((x) => x.chosen) ? '' : 'disabled'} title="Read the panels again and rewrite the captions and dialogue to match them">↺ Re-letter</button>
              <button class="btn primary" id="cx-export" ${p.panels.some((x) => x.chosen) ? '' : 'disabled'}>Send page to Review</button>
              <button class="btn ghost small" id="cx-letter-opts">⋯ Lettering</button>
              <span class="hint">Click a balloon, caption or sound effect to select it: drag to move, ● aims the tail, ■ resizes, double-click rewrites, Del removes.</span>
            </div>
            <div id="cx-letter-box"></div>
            ${p.storyboarded && p.cast.length ? `<div class="panel" style="margin-top:14px">
              <div class="panel-head"><h2>Cast <span class="hint">the sheet is attached to every panel the character is in</span></h2>
                ${p.run.phase === 'cast-review' ? '<button class="btn primary small" id="cx-approve">✓ Use this cast — draw the panels</button>' : ''}</div>
              <div class="cx-sheets" id="cx-sheets">${this.sheetsHtml(p)}</div>
              <input type="file" id="cx-ref-input" accept="image/png,image/jpeg,image/webp" style="display:none" />
            </div>` : ''}
            ${p.storyboarded && (p.locations || []).length ? `<div class="panel" style="margin-top:14px">
              <div class="panel-head"><h2>Places <span class="hint">${p.sequence ? 'a sequence keeps one place by editing the previous panel' : p.plates === false ? 'backgrounds are off — places come from words only' : 'an empty background is drawn for a place two or more panels share, and attached to them'}</span></h2></div>
              <div class="cx-sheets cx-places">${this.placesHtml(p)}</div>
            </div>` : ''}
          </div>
          <div class="panel cx-insp" id="cx-insp">${this.inspectorHtml(p)}</div>
        </div>`;
      this.wireBrief(p);
      this.wireWork(p);
      this.wireInspector(p);
      this.renderStatus(p);
      this.schedulePaint();
    },

    briefHtml(p) {
      const fromUser = p.cast.filter((m) => m.fromUser);
      const renders = this.estimate(p);
      const opt = (v, cur, l) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${l}</option>`;
      return `<div class="panel cx-brief">
        <div class="panel-head"><h2>${esc(p.title || p.name)}</h2>
          <div class="btn-row">
            <button class="btn ghost small" id="cx-rename">Rename</button>
            <button class="btn ghost small danger" id="cx-delete">Delete</button>
          </div>
        </div>
        <label class="fld"><span>Premise <em>— what happens, in a sentence or two</em></span>
          <textarea id="cx-premise" rows="2" placeholder="e.g. a tiny robot gets lost in a huge library and finds its way home">${esc(p.premise)}</textarea></label>
        <div class="cx-cast">
          <span class="lbl">Characters:</span>
          ${fromUser.map((m) => {
            const pics = [...(m.refs || [])].filter((r) => r && r.fname);
            const first = pics[0] || m.sheet;
            return `<div class="cx-star" title="${esc(m.name)}">
            ${first ? `<img src="${esc(first.url || `ala://img/${first.fname}`)}" alt="" />` : ''}<div class="cx-star-body">
            ${p.storyboarded ? `<span class="nm">${esc(m.name)}</span>`
              : `<input class="nm-in" data-starname="${m.id}" value="${esc(m.named ? m.name : '')}" placeholder="name" />`}
            ${pics.length > 1 ? `<span class="hint">+${pics.length - 1}</span>` : ''}
            ${p.storyboarded ? '' : `<label class="asis" title="Use this picture directly as the character sheet instead of drawing a clean sheet from it"><input type="checkbox" data-asis="${m.id}" ${m.refAsSheet ? 'checked' : ''} />as-is</label>
            <button class="x" data-unstar="${m.id}" title="Remove">✕</button>`}
          </div></div>`;
          }).join('')}
          ${p.storyboarded ? '' : `<button class="btn ghost small" id="cx-star-lib" title="A picture of a character from your library">+ From library</button>
          <button class="btn ghost small" id="cx-star-file">+ Picture file</button>
          <input type="file" id="cx-star-input" accept="image/png,image/jpeg,image/webp" style="display:none" />`}
          <span class="hint">${fromUser.length ? 'Name them as the premise does. A clean full-body sheet is drawn from each picture (tick as-is to use the picture itself).' : 'Optional — pictures of who stars in it. Without them a cast sheet is drawn from the writer\'s description.'}</span>
        </div>
        <div class="cx-row" style="margin-top:10px">
          <label class="fld slim"><span>Panels</span><select id="cx-count" ${p.storyboarded || p.format === 'story' ? 'disabled' : ''}>
            ${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => opt(n, p.panelCount, n)).join('')}</select></label>
          <label class="fld slim"><span>Format</span><select id="cx-format" ${p.storyboarded ? 'disabled' : ''}>
            ${opt('page', p.format, 'Comic page')}${opt('webtoon', p.format, 'Webtoon strip')}${opt('story', p.format, 'Illustrated story')}</select></label>
          <label class="fld slim"><span>Takes / panel</span><select id="cx-takes">
            ${[1, 2, 3, 4].map((n) => opt(n, p.takes, n)).join('')}</select></label>
          <label class="fld" style="max-width:300px"><span>Page</span><select id="cx-pagestyle">
            ${Object.entries(ComicLayout.PAGE_STYLES).map(([k, v]) => opt(k, p.pageStyle || 'classic', esc(v.label))).join('')}</select></label>
          <label class="fld slim"><span>Words</span><select id="cx-lettering">
            ${opt('balloons', p.letter.mode || 'balloons', 'Speech balloons')}${opt('float', p.letter.mode, 'Hand-lettered, no balloons')}</select></label>
          <label class="fld" style="max-width:260px"><span>Colours</span><select id="cx-preset">
            ${Object.entries(ComicPrompts.PRESETS).map(([k, v]) => opt(k, p.letter.preset, esc(v.label))).join('')}</select></label>
        </div>
        <div class="checkbox-row" title="One framing; every panel is the next stage of the change, drawn as an edit of the previous one; laid out side by side">
          <input type="checkbox" id="cx-sequence" ${p.sequence ? 'checked' : ''} ${p.storyboarded ? 'disabled' : ''} /><span><b>Step-by-step sequence</b> — same shot every panel, each one the next stage of the change</span></div>
        <details class="fold" style="margin-top:8px">
          <summary>More <em>— theme, tone, workflow, backgrounds, cast approval</em></summary>
          <div class="cx-row" style="margin-top:8px">
            <label class="fld"><span>Theme</span><input id="cx-theme" type="text" value="${esc(p.theme)}" placeholder="e.g. lost robot adventure" /></label>
            <label class="fld"><span>Tone</span><input id="cx-tone" type="text" value="${esc(p.tone)}" placeholder="playful" /></label>
            <label class="fld"><span>Workflow <em>(this comic only)</em></span><select id="cx-workflow"><option value="">Settings default</option></select></label>
          </div>
          <div class="checkbox-row"><input type="checkbox" id="cx-approvecast" ${p.approveCast ? 'checked' : ''} /><span>Stop after the cast sheets and backgrounds so I can approve them</span></div>
          <div class="checkbox-row"><input type="checkbox" id="cx-reroll" ${p.autoReroll ? 'checked' : ''} /><span>Reroll a panel once by itself when every take misses the character, the place, or draws someone twice</span></div>
          <div class="checkbox-row"><input type="checkbox" id="cx-plates" ${p.plates !== false ? 'checked' : ''} /><span>Draw an empty background for each place two panels share and attach it, so the place looks the same (+1 render per place)</span></div>
          <div class="hint">The Qwen 2.1 <b>Turbo</b> model is licensed for non-commercial use. For pages you will monetise, pick a base-model workflow here.</div>
        </details>
        <div class="cx-make">
          ${p.run.active
            ? '<button class="btn" id="cx-stop">■ Stop</button>'
            : p.storyboarded && p.panels.length && p.panels.every((x) => x.chosen) && p.lettered && p.page ? ''
              : `<button class="btn primary" id="cx-make">${p.storyboarded ? (p.panels.every((x) => x.chosen) ? '▶ Finish the page' : '▶ Carry on') : '▶ Make the comic'}</button>`}
          ${p.storyboarded && !p.run.active ? '<button class="btn ghost small" id="cx-restart" title="Throw the storyboard away and write a new one (pictures already drawn stay on disk)">↺ New storyboard</button>' : ''}
          <span class="hint">${esc(renders)}</span>
        </div>
      </div>`;
    },

    estimate(p) {
      const panels = p.storyboarded ? p.panels.filter((x) => !x.chosen).length : (p.format === 'story' ? 1 : p.panelCount);
      const sheets = p.storyboarded ? p.cast.filter((m) => !m.sheet).length : Math.max(1, p.cast.filter((m) => m.fromUser && !m.refAsSheet).length);
      const plates = p.storyboarded ? ComicPrompts.platesWanted(p).filter((l) => !l.plate && !l.plateFailed).length : (p.plates !== false && !p.sequence && p.format !== 'story' ? 1 : 0);
      const n = panels * (p.takes || 2) + sheets + plates;
      if (!n) return 'Every panel is drawn.';
      const lo = Math.max(1, Math.round((n * 15) / 60)), hi = Math.max(1, Math.round((n * 25) / 60));
      return `≈ ${n} render${n > 1 ? 's' : ''} · about ${lo === hi ? lo : `${lo}–${hi}`} min on the Turbo workflow, plus a few writer/vision calls.`;
    },

    sheetsHtml(p) {
      return p.cast.map((m) => {
        const refs = (m.refs || []).filter((r) => r && r.fname);
        const check = m.sheetCheck && m.sheetCheck.identity != null
          ? `<span class="cx-score ${m.sheetCheck.identity < 6 ? 'bad' : ''}" title="${esc(m.sheetCheck.issue || 'matches the reference')}">look ${m.sheetCheck.identity}/10</span>` : '';
        const card = (sheet, form, jobId) => `<div class="cx-sheet">
          ${sheet ? `<img src="${esc(sheet.url || `ala://img/${sheet.fname}`)}" alt="" data-zoom="${esc(sheet.url || `ala://img/${sheet.fname}`)}" />`
            : `<div class="cx-empty">${jobId ? 'drawing…' : 'not drawn yet'}</div>`}
          <div class="nm" title="${esc(form === 'after' ? m.after : `${m.look} ${m.outfit}`)}">${esc(m.name)}${form === 'after' ? ' · after' : ''} ${form === 'before' ? check : ''}</div>
          ${form === 'before' && refs.length ? `<div class="cx-refs" title="Reference pictures this sheet is drawn from">${refs.map((r) => `<img src="${esc(r.url || `ala://img/${r.fname}`)}" alt="" data-zoom="${esc(r.url || `ala://img/${r.fname}`)}" />`).join('')}</div>` : ''}
          <div class="btn-row">
            ${p.storyboarded ? `<button class="btn ghost small" data-resheet="${m.id}:${form}" ${jobId ? 'disabled' : ''}>🔁 Redraw</button>` : ''}
            ${form === 'before' && p.storyboarded ? `<button class="btn ghost small" data-addref="${m.id}:library" title="Add a library picture of ${esc(m.name)} and redraw the sheet from it">+ Ref (library)</button>
            <button class="btn ghost small" data-addref="${m.id}:file" title="Add a picture file of ${esc(m.name)} and redraw the sheet from it">+ Ref (file)</button>` : ''}
          </div>
        </div>`;
        return card(m.sheet, 'before', m.sheetJobId) + (m.after ? card(m.afterSheet, 'after', m.afterJobId) : '');
      }).join('');
    },

    placesHtml(p) {
      const wanted = new Set(ComicPrompts.platesWanted(p).map((l) => l.id));
      return (p.locations || []).map((l) => {
        const panels = p.panels.filter((x) => x.locationId === l.id).map((x) => x.n);
        const img = l.plate ? `<img src="${esc(l.plate.url || `ala://img/${l.plate.fname}`)}" alt="" data-zoom="${esc(l.plate.url || `ala://img/${l.plate.fname}`)}" />`
          : `<div class="cx-empty">${l.plateJobId ? 'drawing…' : l.plateFailed ? 'failed — words only' : wanted.has(l.id) ? 'waiting' : 'no background needed'}</div>`;
        return `<div class="cx-sheet cx-place">
          ${img}
          <div class="nm" title="${esc(l.look)}">${esc(l.name)} <span class="hint">· panel${panels.length > 1 ? 's' : ''} ${panels.join(', ')}</span></div>
          <textarea data-placelook="${l.id}" rows="2" title="What the place looks like — used by backgrounds and rerolls">${esc(l.look)}</textarea>
          ${p.plates !== false && !p.sequence ? `<button class="btn ghost small" data-replate="${l.id}" ${l.plateJobId ? 'disabled' : ''}>🔁 ${l.plate ? 'Redraw background' : 'Draw background'}</button>` : ''}
        </div>`;
      }).join('');
    },

    renderStatus(p) {
      const el = $('#cx-status');
      if (!el) return;
      const failed = p.run.phase === 'needs attention' || p.run.error;
      el.className = `cx-status${failed ? ' err' : ''}`;
      const jobStatus = (panel) => {
        const j = Comics.pendingJob(panel.jobId);
        if (j) return 'queued';
        return panel.chosen ? 'ready' : panel.status;
      };
      el.innerHTML = `<span class="ph">${p.run.active ? '● ' : ''}${esc(PHASE_LABEL[p.run.phase] || p.run.phase)}</span>
        <span>${esc(p.run.note || '')}</span>
        ${p.run.error ? `<span class="err-msg">${esc(p.run.error)}</span>` : ''}
        ${p.panels.length ? `<span class="cx-dots" title="Panels: grey = waiting, blue = choosing a take, green = drawn, red = failed">
          ${p.panels.map((x) => `<span class="cx-dot ${jobStatus(x)}"></span>`).join('')}</span>` : ''}
        ${p.panels.some((x) => x.status === 'failed') && !p.run.active ? '<button class="btn small" id="cx-retry">Retry failed panels</button>' : ''}
        ${p.page ? '<span class="hint">· page in Review</span>' : ''}`;
      const r = $('#cx-retry');
      if (r) r.addEventListener('click', () => { Comics.retryFailed(p); this.renderWork(); });
    },

    inspectorHtml(p) {
      const panel = p.panels.find((x) => x.id === selectedPanel);
      if (!panel) {
        return `<div class="panel-head"><h2>Panels</h2></div><div class="hint">The storyboard writes the panels. Press <b>Make the comic</b>.</div>`;
      }
      const names = p.cast.map((m) => m.name);
      const fresh = panel.takes.filter((t) => !panel.pickFrom || t.jobId === panel.pickFrom);
      const scoreOf = (t) => {
        const i = fresh.indexOf(t);
        const row = panel.pick && panel.pick.tiles && i >= 0 ? panel.pick.tiles[i + 1] : null;
        return row ? `${row.identity}·${row.beat}·${row.render}` : '';
      };
      const who = (panel.who || []).map((w) => {
        const m = p.cast.find((c) => c.id === w.castId);
        return m ? `${m.name}${w.form === 'after' ? ' (after)' : ''}` : '';
      }).filter(Boolean).join(', ');
      const pending = Comics.pendingJob(panel.jobId);
      return `<div class="panel-head"><h2>Panel ${panel.n} <span class="hint">of ${p.panels.length}</span></h2>
          <div class="btn-row">
            <button class="btn ghost small" data-step="-1" ${panel.n <= 1 ? 'disabled' : ''}>‹</button>
            <button class="btn ghost small" data-step="1" ${panel.n >= p.panels.length ? 'disabled' : ''}>›</button>
          </div></div>
        <div class="cx-tags">
          <span class="cx-tag">${esc(panel.shot)}</span>
          <span class="cx-tag" title="${panel.mode === 'continue' ? 'Drawn as an edit of the previous panel: same place and camera' : 'Drawn fresh with the cast sheets as references'}">${panel.mode === 'continue' ? 'continues previous' : 'new shot'}</span>
          ${who ? `<span class="cx-tag">${esc(who)}</span>` : ''}
          <span class="cx-tag">${pending ? 'queued' : esc(panel.chosen ? 'drawn' : panel.status)}</span>
        </div>
        ${panel.error ? `<div class="hint err" style="margin-bottom:8px">${esc(panel.error)}</div>` : ''}
        ${panel.takes.length ? `<div class="hint" style="margin-bottom:4px">Takes${panel.pick ? ' — scores: identity · beat · anatomy' : ''}</div>
        <div class="cx-takes">${panel.takes.slice(-8).map((t) => `<button class="cx-take ${t.fname === panel.chosen ? 'on' : ''}" data-take="${esc(t.fname)}" title="${t.fname === panel.chosen ? 'In use' : 'Use this take'}">
          <img src="${esc(t.url || `ala://img/${t.fname}`)}" alt="" loading="lazy" />${scoreOf(t) ? `<span class="sc">${scoreOf(t)}</span>` : ''}</button>`).join('')}</div>` : ''}
        <div class="btn-row">
          <button class="btn small" id="cx-reroll-panel" ${pending || !p.storyboarded ? 'disabled' : ''}>🔁 Reroll</button>
          <button class="btn ghost small" id="cx-show-prompt" ${p.storyboarded ? '' : 'disabled'}>⋯ Prompt</button>
          ${panel.chosen ? `<button class="btn ghost small" id="cx-zoom">🔍 Full size</button>` : ''}
        </div>
        ${panel.chosen ? `<div class="cx-edit"><input type="text" id="cx-edit-text" placeholder="Edit in words — e.g. add a red scarf, close the eyes" />
          <button class="btn small" id="cx-edit-go" ${pending ? 'disabled' : ''}>Apply</button></div>` : ''}
        <label class="fld"><span>What the picture shows <em>— used by the next reroll</em></span>
          <textarea id="cx-action" rows="3">${esc(panel.action)}</textarea></label>
        ${p.cast.length ? `<div class="fld"><span>Who is in it <em>— their sheets are attached (max ${ComicPrompts.MAX_PER_PANEL}); used by the next reroll</em></span>
          <div class="cx-who">${p.cast.map((m) => {
            const w = (panel.who || []).find((x) => x.castId === m.id);
            return `<label class="cx-who-item"><input type="checkbox" data-who="${m.id}" ${w ? 'checked' : ''} />${esc(m.name)}${m.after ? `<select data-whoform="${m.id}" ${w ? '' : 'disabled'}><option value="before" ${!w || w.form !== 'after' ? 'selected' : ''}>before</option><option value="after" ${w && w.form === 'after' ? 'selected' : ''}>after</option></select>` : ''}</label>`;
          }).join('')}</div></div>` : ''}
        ${(p.locations || []).length ? `<label class="fld"><span>Place <em>— the panel is drawn in this place only</em></span><select id="cx-place">
          ${(p.locations || []).map((l) => `<option value="${l.id}" ${l.id === panel.locationId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>` : ''}
        <label class="fld"><span>Caption</span><input type="text" id="cx-caption" value="${esc(panel.caption)}" placeholder="narration box, or empty" /></label>
        <div class="hint" style="margin-bottom:4px">Balloons</div>
        <div class="cx-lines">
          ${(panel.lines || []).map((l) => `<div class="cx-line">
            <select class="sp" data-l="speaker" data-id="${l.id}">
              ${[...new Set([...names, l.speaker].filter(Boolean))].map((n) => `<option ${n === l.speaker ? 'selected' : ''}>${esc(n)}</option>`).join('')}
            </select>
            <input type="text" class="tx" data-l="text" data-id="${l.id}" value="${esc(l.text)}" />
            <select class="kd" data-l="kind" data-id="${l.id}">
              ${ComicPrompts.KINDS.map((k) => `<option value="${k}" ${l.kind === k ? 'selected' : ''}>${k}</option>`).join('')}
            </select>
            ${l.manual || (l.scale && l.scale !== 1) ? `<button class="btn ghost small" data-unpin="${l.id}" title="Let the app place and size this balloon again">📌</button>` : ''}
            <button class="btn ghost small" data-delline="${l.id}">✕</button>
          </div>`).join('')}
          <div class="btn-row"><button class="btn ghost small" id="cx-addline">+ Balloon</button>
            ${panel.lines.some((l) => l.manual || l.tailManual || (l.scale && l.scale !== 1)) || panel.captionAt || panel.sfxAt || (panel.captionScale && panel.captionScale !== 1) || (panel.sfxScale && panel.sfxScale !== 1)
              ? '<button class="btn ghost small" id="cx-resetplace" title="Forget every hand placement and size in this panel">↺ Auto placement</button>' : ''}</div>
        </div>
        <label class="fld"><span>Sound effect</span><input type="text" id="cx-sfx" value="${esc(panel.sfx || '')}" placeholder="e.g. GULP — or empty" /></label>`;
    },

    wireBrief(p) {
      const bind = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
      const save = (patch) => Comics.update(p.id, patch);
      bind('#cx-premise', 'input', U.debounce((e) => save({ premise: e.target.value }), 400));
      bind('#cx-theme', 'input', U.debounce((e) => save({ theme: e.target.value }), 400));
      bind('#cx-tone', 'input', U.debounce((e) => save({ tone: e.target.value }), 400));
      bind('#cx-count', 'change', (e) => { save({ panelCount: Number(e.target.value) }); this.renderWork(); });
      bind('#cx-format', 'change', (e) => {
        const format = e.target.value;
        save({
          format, geom: ComicPrompts.defaultGeom(format),
          template: format === 'story' ? 'story-left' : '', panelCount: format === 'story' ? 1 : (p.panelCount === 1 ? 4 : p.panelCount),
        });
        this.renderWork();
      });
      bind('#cx-takes', 'change', (e) => { save({ takes: Number(e.target.value) }); this.renderWork(); });
      bind('#cx-preset', 'change', (e) => {
        const keep = { captionSize: p.letter.captionSize, bubbleSize: p.letter.bubbleSize, showTitle: p.letter.showTitle };
        save({ letter: { ...ComicPrompts.defaultLetter(e.target.value), ...keep } });
        this.schedulePaint();
      });
      bind('#cx-approvecast', 'change', (e) => save({ approveCast: e.target.checked }));
      bind('#cx-reroll', 'change', (e) => save({ autoReroll: e.target.checked }));
      bind('#cx-plates', 'change', (e) => { save({ plates: e.target.checked }); this.renderWork(); });
      bind('#cx-pagestyle', 'change', (e) => {
        save({ pageStyle: e.target.value });
        if (p.storyboarded) { Comics.assignLayout(p); Comics.persist(); }
        this.schedulePaint();
      });
      bind('#cx-lettering', 'change', (e) => { p.letter.mode = e.target.value === 'float' ? 'float' : 'balloons'; Comics.persist(); this.schedulePaint(); });
      bind('#cx-sequence', 'change', (e) => {
        const on = e.target.checked;
        const patch = { sequence: on };
        if (on && (p.pageStyle || 'classic') === 'classic') patch.pageStyle = 'rounded';
        if (on) p.letter.mode = 'float';
        if (on && (p.panelCount < 2 || p.panelCount > 4)) patch.panelCount = 3;
        save(patch);
        this.renderWork();
      });
      document.querySelectorAll('[data-starname]').forEach((inp) => inp.addEventListener('input', U.debounce(() => {
        const m = p.cast.find((x) => x.id === inp.dataset.starname);
        if (!m) return;
        m.name = inp.value.trim().slice(0, 28) || 'Character';
        m.named = !!inp.value.trim();
        Comics.persist();
      }, 300)));
      document.querySelectorAll('[data-asis]').forEach((cb) => cb.addEventListener('change', () => {
        const m = p.cast.find((x) => x.id === cb.dataset.asis);
        if (!m) return;
        m.refAsSheet = cb.checked;
        const first = (m.refs || [])[0];
        m.sheet = cb.checked && first ? { ...first } : null;
        Comics.persist();
        this.renderWork();
      }));
      const wfSel = $('#cx-workflow');
      if (wfSel) {
        const dir = ((State.settings || {}).comfy || {}).workflowsDir;
        Promise.resolve(dir ? window.ala.comfy.listWorkflows(dir) : []).then((files) => {
          const list = (Array.isArray(files) ? files : (files && files.files) || []).map((f) => (typeof f === 'string' ? f : f.name)).filter((f) => /\.json$/i.test(f) && !/video|i2v|h3/i.test(f));
          wfSel.innerHTML = `<option value="">Settings default</option>${list.map((f) => `<option ${f === p.workflow ? 'selected' : ''}>${esc(f)}</option>`).join('')}`;
        }).catch(() => {});
        wfSel.addEventListener('change', (e) => save({ workflow: e.target.value }));
      }
      document.querySelectorAll('[data-unstar]').forEach((b) => b.addEventListener('click', () => {
        p.cast = p.cast.filter((m) => m.id !== b.dataset.unstar);
        Comics.persist();
        this.renderWork();
      }));
      bind('#cx-star-lib', 'click', () => this.pickFromLibrary(p));
      bind('#cx-star-file', 'click', () => { const i = $('#cx-star-input'); if (i) i.click(); });
      bind('#cx-star-input', 'change', async (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });
        const saved = await window.ala.files.saveImage(b64, U.extFromMime(f.type || 'image/png'), 'comic-star');
        this.addStar(p, saved.fname, saved.url, f.name.replace(/\.[a-z0-9]+$/i, ''));
      });
      bind('#cx-rename', 'click', async () => {
        const name = await window.askText('Rename', p.title || p.name, { label: 'Title' });
        if (name && name.trim()) { save({ title: name.trim(), name: name.trim(), titleManual: true }); this.render(); }
      });
      bind('#cx-delete', 'click', async () => {
        const withFiles = confirm(`Delete "${p.title || p.name}"?\n\nOK also deletes its panel and cast pictures from disk.\nCancel keeps the pictures and deletes only the project.`);
        await Comics.remove(p.id, { withFiles });
        activeId = null;
        this.render();
      });
      bind('#cx-make', 'click', () => {
        try {
          Comics.start(p);
          this.renderWork();
          window.toast('Making the comic — the panels go through the queue.', 'ok');
        } catch (e) { window.toast(e.message, 'err'); }
      });
      bind('#cx-stop', 'click', () => { Comics.stop(p); this.renderWork(); });
      bind('#cx-restart', 'click', () => {
        if (!confirm('Write a new storyboard? The current panels are dropped from this comic (their pictures stay on disk).')) return;
        Object.assign(p, {
          storyboarded: false, panels: [], lettered: false, page: null, template: p.format === 'story' ? 'story-left' : '',
          cast: p.cast.filter((m) => m.fromUser), castApproved: false, artStyle: '', setting: '', locations: [],
        });
        for (const m of p.cast) if (!m.refAsSheet) { m.sheet = null; m.afterSheet = null; m.sheetCheck = null; m.sheetRedrawn = false; }
        p.run = { ...p.run, phase: 'draft', note: '', error: null };
        Comics.persist();
        this.renderWork();
      });
    },

    addStar(p, fname, url, name = '') {
      if (p.cast.filter((m) => m.fromUser).length >= 4) { window.toast('Four characters is the most a comic here takes.', 'err'); return; }
      const clean = name && !/^(comic-star|pch|img|image|screenshot|\d)/i.test(name) ? name.slice(0, 28) : '';
      const m = ComicPrompts.castFromRef({ name: clean, refs: [{ fname, url }] });
      if (!clean) { m.name = 'Character'; m.named = false; }
      p.cast.push(m);
      Comics.persist();
      this.renderWork();
    },

    async pickPicture(source, onPick) {
      if (source === 'library') { this.pickFromLibrary(null, onPick); return; }
      const input = $('#cx-ref-input');
      if (!input) return;
      input.value = '';
      input.onchange = async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });
        const saved = await window.ala.files.saveImage(b64, U.extFromMime(f.type || 'image/png'), 'comic-ref');
        onPick(saved.fname, saved.url, f.name.replace(/\.[a-z0-9]+$/i, ''));
      };
      input.click();
    },

    pickFromLibrary(p, onPick = null) {
      const cards = (State.library || []).filter((c) => c && c.fname && c.status !== 'discarded' && c.promptSource !== 'comic').slice(0, 120);
      const root = $('#modal-root');
      root.innerHTML = `<div class="modal-backdrop"><div class="panel" style="max-width:900px;width:92vw">
        <div class="panel-head"><h2>Who stars in it?</h2><button class="btn ghost small" data-close>✕</button></div>
        <div class="hint" style="margin-bottom:8px">Newest first. Pick a clear picture of the character — it is attached to every panel they are in.</div>
        <div class="cx-pick-grid">${cards.map((c) => `<img src="${esc(c.url)}" data-pick="${esc(c.fname)}" loading="lazy" title="${esc((c.metadata && c.metadata.title) || c.theme || '')}" />`).join('')}</div>
      </div></div>`;
      const close = () => { root.innerHTML = ''; };
      root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
      root.querySelector('.modal-backdrop').addEventListener('click', (e) => { if (e.target.classList.contains('modal-backdrop')) close(); });
      root.querySelectorAll('[data-pick]').forEach((img) => img.addEventListener('click', () => {
        const c = cards.find((x) => x.fname === img.dataset.pick);
        close();
        if (onPick) onPick(c.fname, c.url, '');
        else this.addStar(p, c.fname, c.url);
      }));
    },

    wireWork(p) {
      const bind = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
      bind('#cx-reletter', 'click', async () => {
        const btn = $('#cx-reletter');
        if (btn) btn.disabled = true;
        try {
          await Comics.lock(p, () => Comics.letter(p));
          window.toast(p.letteredBy === 'vision' ? 'Re-lettered from the pictures.' : 'Vision was unavailable — kept the storyboard\'s words.', p.letteredBy === 'vision' ? 'ok' : 'err');
          this.renderWork();
        } catch (e) { window.toast(e.message, 'err'); } finally { if ($('#cx-reletter')) $('#cx-reletter').disabled = false; }
      });
      bind('#cx-export', 'click', async () => {
        const missing = p.panels.filter((x) => !x.chosen).length;
        if (missing && !confirm(`${missing} panel(s) have no picture yet — they will be empty boxes.\n\nSend the page anyway?`)) return;
        try {
          if (!p.lettered) await Comics.lock(p, () => Comics.letter(p));
          await Comics.lock(p, () => Comics.exportPage(p));
          window.toast('The page is in Review.', 'ok');
          this.renderWork();
        } catch (e) { window.toast(e.message, 'err'); }
      });
      bind('#cx-letter-opts', 'click', () => {
        const box = $('#cx-letter-box');
        if (!box) return;
        if (box.innerHTML) { box.innerHTML = ''; return; }
        const L = window.ComicLayout;
        const templates = Object.entries(L.LAYOUTS).filter(([, t]) => (p.format === 'story' ? t.kind === 'story' : t.kind === 'page' && t.slots === p.panels.length));
        box.innerHTML = `<div class="panel" style="margin-top:10px"><div class="cx-row">
          <label class="fld slim"><span>Caption size</span><input type="number" id="cx-capsize" min="12" max="60" value="${p.letter.captionSize}" /></label>
          <label class="fld slim"><span>Balloon size</span><input type="number" id="cx-bubsize" min="12" max="60" value="${p.letter.bubbleSize}" /></label>
          ${p.format === 'page' || p.format === 'story' ? `<label class="fld"><span>Layout</span><select id="cx-template">
            ${templates.map(([id, t]) => `<option value="${id}" ${p.template === id ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}
            ${p.format === 'page' ? `<option value="auto" ${p.template === 'auto' ? 'selected' : ''}>Auto grid</option>` : ''}</select></label>` : ''}
          <div class="checkbox-row"><input type="checkbox" id="cx-showtitle" ${p.letter.showTitle ? 'checked' : ''} /><span>Title on the page</span></div>
          <label class="fld slim"><span>Signature</span><input type="text" id="cx-signature" value="${esc(p.letter.signature || '')}" placeholder="@yourname" /></label>
          <label class="fld slim"><span>Page no.</span><input type="text" id="cx-pageno" value="${esc(p.letter.pageNo || '')}" placeholder="1" style="width:60px" /></label>
        </div><div class="hint">A different layout changes the panel shapes; panels already drawn are cropped to fit, rerolls use the new shape.</div></div>`;
        const num = (sel, key, d) => bind(sel, 'change', (e) => { p.letter[key] = Math.max(12, Math.min(60, Number(e.target.value) || d)); Comics.persist(); this.schedulePaint(); });
        num('#cx-capsize', 'captionSize', 25);
        num('#cx-bubsize', 'bubbleSize', 26);
        bind('#cx-showtitle', 'change', (e) => { p.letter.showTitle = e.target.checked; Comics.persist(); this.schedulePaint(); });
        bind('#cx-signature', 'input', U.debounce((e) => { p.letter.signature = e.target.value.slice(0, 40); Comics.persist(); this.schedulePaint(); }, 300));
        bind('#cx-pageno', 'input', U.debounce((e) => { p.letter.pageNo = e.target.value.slice(0, 8); Comics.persist(); this.schedulePaint(); }, 300));
        bind('#cx-template', 'change', (e) => { p.template = e.target.value; Comics.assignLayout(p); Comics.persist(); this.schedulePaint(); });
      });
      bind('#cx-approve', 'click', () => { Comics.approveCast(p); this.renderWork(); });
      document.querySelectorAll('[data-resheet]').forEach((b) => b.addEventListener('click', () => {
        const [id, form] = b.dataset.resheet.split(':');
        const m = p.cast.find((x) => x.id === id);
        if (m) { Comics.rerollSheet(p, m, form); this.renderWork(); }
      }));
      document.querySelectorAll('[data-addref]').forEach((b) => b.addEventListener('click', () => {
        const [mid, source] = b.dataset.addref.split(':');
        const m = p.cast.find((x) => x.id === mid);
        if (!m) return;
        const add = (fname, url) => {
          try {
            Comics.addReference(p, m, { fname, url }, { redraw: true });
            window.toast(`Drawing ${m.name}'s sheet again from the new reference. Panels already drawn keep their pictures — reroll the ones that should change.`, 'ok');
          } catch (e) { window.toast(e.message, 'err'); }
          this.renderWork();
        };
        this.pickPicture(source, add);
      }));
      document.querySelectorAll('[data-replate]').forEach((b) => b.addEventListener('click', () => {
        const loc = (p.locations || []).find((l) => l.id === b.dataset.replate);
        if (loc) { Comics.rerollPlate(p, loc); this.renderWork(); }
      }));
      document.querySelectorAll('[data-placelook]').forEach((t) => t.addEventListener('input', U.debounce(() => {
        const loc = (p.locations || []).find((l) => l.id === t.dataset.placelook);
        if (loc) { loc.look = t.value.trim(); Comics.persist(); }
      }, 400)));
      document.querySelectorAll('[data-zoom]').forEach((img) => img.addEventListener('click', () => this.zoom(img.dataset.zoom)));
      this.wireCanvas(p);
    },

    wireInspector(p) {
      const panel = p.panels.find((x) => x.id === selectedPanel);
      if (!panel) return;
      const bind = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
      document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
        const i = p.panels.indexOf(panel) + Number(b.dataset.step);
        if (p.panels[i]) { selectedPanel = p.panels[i].id; this.renderWork(); }
      }));
      document.querySelectorAll('[data-take]').forEach((b) => b.addEventListener('click', () => {
        Comics.choose(p, panel, b.dataset.take);
        this.renderWork();
      }));
      bind('#cx-reroll-panel', 'click', () => { Comics.reroll(p, panel); this.renderWork(); window.toast(`Panel ${panel.n} queued again.`, 'ok'); });
      bind('#cx-show-prompt', 'click', () => {
        const built = ComicPrompts.panelPrompt(p, panel);
        const refs = built.refs.map((r, i) => `<image${i + 1}> = ${r.fname}`).join('\n');
        window.askText(`What the generator is sent for panel ${panel.n}`, `${built.prompt}${refs ? `\n\nReferences:\n${refs}` : ''}\n\nAspect: ${panel.aspect || 'workflow default'}`, { multiline: true });
      });
      bind('#cx-zoom', 'click', () => this.zoom(`ala://img/${panel.chosen}`));
      const applyEdit = () => {
        const t = $('#cx-edit-text');
        const text = t ? t.value.trim() : '';
        if (!text) return;
        try { Comics.revise(p, panel, text); window.toast(`Editing panel ${panel.n} — the page is re-lettered after.`, 'ok'); this.renderWork(); }
        catch (e) { window.toast(e.message, 'err'); }
      };
      bind('#cx-edit-go', 'click', applyEdit);
      bind('#cx-edit-text', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyEdit(); } });
      bind('#cx-action', 'input', U.debounce((e) => { panel.action = e.target.value; panel.actionManual = true; Comics.persist(); }, 400));
      document.querySelectorAll('[data-who]').forEach((cb) => cb.addEventListener('change', () => {
        const id = cb.dataset.who;
        let who = (panel.who || []).filter((w) => w.castId !== id);
        if (cb.checked) {
          if (who.length >= ComicPrompts.MAX_PER_PANEL) { cb.checked = false; window.toast(`At most ${ComicPrompts.MAX_PER_PANEL} characters per panel — past that the references blend into each other.`, 'err'); return; }
          const sel = document.querySelector(`[data-whoform="${id}"]`);
          who = [...who, { castId: id, form: sel && sel.value === 'after' ? 'after' : 'before' }];
        }
        panel.who = who;
        Comics.persist();
        this.refreshInspector(p);
      }));
      document.querySelectorAll('[data-whoform]').forEach((sel) => sel.addEventListener('change', () => {
        const w = (panel.who || []).find((x) => x.castId === sel.dataset.whoform);
        if (w) { w.form = sel.value === 'after' ? 'after' : 'before'; Comics.persist(); }
      }));
      bind('#cx-place', 'change', (e) => { panel.locationId = e.target.value; Comics.persist(); window.toast(`Panel ${panel.n} is set in that place from its next reroll.`, 'ok'); });
      bind('#cx-resetplace', 'click', () => {
        for (const l of panel.lines) Object.assign(l, { manual: false, anchor: null, tailTo: null, tailManual: false, scale: 1 });
        Object.assign(panel, { captionAt: null, captionScale: 1, sfxAt: null, sfxScale: 1, sfxAngle: null });
        selItem = null;
        Comics.persist();
        this.renderWork();
      });
      bind('#cx-caption', 'input', U.debounce((e) => { panel.caption = e.target.value; panel.captionManual = true; Comics.persist(); this.schedulePaint(); }, 300));
      bind('#cx-sfx', 'input', U.debounce((e) => { panel.sfx = e.target.value; panel.sfxManual = true; Comics.persist(); this.schedulePaint(); }, 300));
      document.querySelectorAll('[data-l]').forEach((inp) => inp.addEventListener(inp.tagName === 'SELECT' ? 'change' : 'input', U.debounce(() => {
        const line = panel.lines.find((l) => l.id === inp.dataset.id);
        if (!line) return;
        line[inp.dataset.l] = inp.value;
        line.textManual = true;
        Comics.persist();
        this.schedulePaint();
      }, inp.tagName === 'SELECT' ? 0 : 300)));
      document.querySelectorAll('[data-delline]').forEach((b) => b.addEventListener('click', () => {
        panel.lines = panel.lines.filter((l) => l.id !== b.dataset.delline);
        Comics.persist();
        this.renderWork();
      }));
      document.querySelectorAll('[data-unpin]').forEach((b) => b.addEventListener('click', () => {
        const line = panel.lines.find((l) => l.id === b.dataset.unpin);
        if (line) Object.assign(line, { manual: false, anchor: null, tailTo: null, tailManual: false, scale: 1 });
        Comics.persist();
        this.renderWork();
      }));
      bind('#cx-addline', 'click', () => {
        const first = (panel.who || [])[0];
        const m = first ? p.cast.find((c) => c.id === first.castId) : p.cast[0];
        panel.lines.push({ ...ComicPrompts.blankLine({ speaker: m ? m.name : '', text: '…' }), textManual: true });
        Comics.persist();
        this.renderWork();
      });
    },

    zoom(url) {
      if (window.openImageModal) { try { window.openImageModal(url); return; } catch {  } }
      const root = $('#modal-root');
      root.innerHTML = `<div class="modal-backdrop"><img class="modal-img" src="${esc(url)}" /></div>`;
      root.querySelector('.modal-backdrop').addEventListener('click', () => { root.innerHTML = ''; });
    },

    schedulePaint() {
      if (paintQueued) return;
      paintQueued = true;
      requestAnimationFrame(() => { paintQueued = false; this.repaint(); });
    },

    async repaint() {
      const p = this.active();
      const canvas = $('#cx-canvas');
      const stage = $('#cx-stage');
      if (!p || !canvas || !stage) return;
      const avail = Math.max(320, stage.clientWidth - 24);
      const full = Comics.geometry(p, 1).width || p.geom.width;
      previewScale = Math.min(1, avail / full);
      try {
        await Comics.compose(p, { scale: previewScale, canvas, selected: selectedPanel, selectedItem: selItem });
      } catch (e) {
        State.addLog('Comic preview failed: ' + e.message, 'err');
      }
      this.renderItemBar(p);
    },

    resolveItem(p, sel = selItem) {
      if (!sel) return null;
      const idx = p.panels.findIndex((x) => x.id === sel.panelId);
      if (idx < 0) return null;
      const panel = p.panels[idx];
      const canvas = $('#cx-canvas');
      const placed = canvas && canvas._placed ? (canvas._placed[idx] || []).find((b) => b.type === sel.type && b.id === sel.id) : null;
      const line = sel.type === 'line' ? panel.lines.find((l) => l.id === sel.id) : null;
      if (sel.type === 'line' && !line) return null;
      if (sel.type === 'caption' && !String(panel.caption || '').trim()) return null;
      if (sel.type === 'sfx' && !String(panel.sfx || '').trim()) return null;
      return { idx, panel, placed, line, box: canvas && canvas._boxes ? canvas._boxes[idx] : null };
    },

    select(p, sel) {
      selItem = sel;
      this.schedulePaint();
    },

    renderItemBar(p) {
      const bar = $('#cx-itembar');
      if (!bar) return;
      const it = this.resolveItem(p);
      if (!it) { if (bar.innerHTML) bar.innerHTML = ''; bar.classList.remove('on'); return; }
      const key = JSON.stringify([selItem, it.line && [it.line.kind, it.line.speaker], p.letter.mode]);
      if (bar.dataset.key === key && bar.innerHTML) return;
      bar.dataset.key = key;
      bar.classList.add('on');
      const btn = (attr, label, on = false, title = '') => `<button class="btn ghost small ${on ? 'on' : ''}" ${attr} title="${esc(title)}">${label}</button>`;
      let html = `<span class="lbl">Panel ${it.panel.n} · ${selItem.type === 'line' ? 'words' : selItem.type === 'caption' ? 'caption' : 'sound effect'}</span>`;
      if (it.line) {
        const names = [...new Set([...p.cast.map((m) => m.name), it.line.speaker].filter(Boolean))];
        const floatAll = p.letter.mode === 'float';
        html += [['speech', '💬 Speech'], ['thought', '💭 Thought'], ['shout', '💥 Shout'], ['whisper', '┄ Whisper'], ['float', '✍ Floating']]
          .map(([k, l]) => btn(`data-kind="${k}"`, l, it.line.kind === k, floatAll && k !== 'float' ? 'The page is set to hand-lettered words — every line floats' : ''))
          .join('');
        html += `<select data-speaker>${names.map((n) => `<option ${n === it.line.speaker ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
        if (it.line.tailManual) html += btn('data-reaim', '↺ Re-aim tail', false, 'Point the tail at the speaker again');
      }
      html += btn('data-size="-1"', 'A−', false, 'Smaller') + btn('data-size="1"', 'A+', false, 'Bigger');
      html += btn('data-edit', '✎ Rewrite', false, 'Or double-click it on the page');
      html += btn('data-auto', '📌 Auto place', false, 'Let the app place and size it again');
      html += btn('data-del', '🗑 Delete', false, 'Or press Delete');
      bar.innerHTML = html;
      const on = (sel, ev, fn) => bar.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, fn));
      on('[data-kind]', 'click', (e) => { it.line.kind = e.currentTarget.dataset.kind; it.line.textManual = true; this.commit(p); });
      on('[data-speaker]', 'change', (e) => {
        it.line.speaker = e.target.value; it.line.textManual = true;
        if (!it.line.tailManual) it.line.tailTo = null;
        this.commit(p);
      });
      on('[data-reaim]', 'click', () => { it.line.tailManual = false; it.line.tailTo = null; this.commit(p); });
      on('[data-size]', 'click', (e) => this.resizeBy(p, it, Number(e.currentTarget.dataset.size) > 0 ? 1.12 : 1 / 1.12));
      on('[data-edit]', 'click', () => this.inlineEdit(p));
      on('[data-auto]', 'click', () => {
        if (it.line) Object.assign(it.line, { manual: false, anchor: null, tailTo: null, tailManual: false, scale: 1 });
        else if (selItem.type === 'caption') Object.assign(it.panel, { captionAt: null, captionScale: 1 });
        else Object.assign(it.panel, { sfxAt: null, sfxScale: 1, sfxAngle: null });
        this.commit(p);
      });
      on('[data-del]', 'click', () => this.deleteSelected(p));
    },

    commit(p, { inspector = true } = {}) {
      Comics.persist();
      if (inspector) this.refreshInspector(p); else this.schedulePaint();
      const bar = $('#cx-itembar');
      if (bar) bar.dataset.key = '';
    },

    resizeBy(p, it, factor) {
      const clampS = (v) => Math.max(0.5, Math.min(2.6, v));
      if (it.line) it.line.scale = clampS((Number(it.line.scale) || 1) * factor);
      else if (selItem.type === 'caption') it.panel.captionScale = clampS((Number(it.panel.captionScale) || 1) * factor);
      else it.panel.sfxScale = clampS((Number(it.panel.sfxScale) || 1) * factor);
      this.commit(p, { inspector: false });
    },

    deleteSelected(p) {
      const it = this.resolveItem(p);
      if (!it) return;
      if (it.line) it.panel.lines = it.panel.lines.filter((l) => l.id !== it.line.id);
      else if (selItem.type === 'caption') { it.panel.caption = ''; it.panel.captionManual = true; }
      else { it.panel.sfx = ''; it.panel.sfxManual = true; }
      selItem = null;
      this.commit(p);
    },

    inlineEdit(p) {
      const it = this.resolveItem(p);
      const ta = $('#cx-inline');
      const canvas = $('#cx-canvas');
      if (!it || !it.placed || !ta || !canvas) return;
      const r = canvas.getBoundingClientRect();
      const st = $('#cx-stage').getBoundingClientRect();
      const k = r.width / canvas.width;
      const rect = it.placed.rect;
      ta.style.display = 'block';
      ta.style.left = `${r.left - st.left + rect.x * k - 6}px`;
      ta.style.top = `${r.top - st.top + rect.y * k - 6}px`;
      ta.style.width = `${Math.max(180, rect.w * k + 12)}px`;
      ta.style.height = `${Math.max(60, rect.h * k + 12)}px`;
      ta.value = it.line ? it.line.text : selItem.type === 'caption' ? it.panel.caption : it.panel.sfx;
      ta.focus();
      ta.select();
      const done = (save) => {
        ta.onkeydown = null; ta.onblur = null;
        ta.style.display = 'none';
        if (!save) return;
        const v = ta.value.replace(/\s+/g, ' ').trim();
        if (it.line) { if (v) { it.line.text = v; it.line.textManual = true; } else { it.panel.lines = it.panel.lines.filter((l) => l.id !== it.line.id); selItem = null; } }
        else if (selItem.type === 'caption') { it.panel.caption = v; it.panel.captionManual = true; }
        else { it.panel.sfx = v.slice(0, 24); it.panel.sfxManual = true; }
        this.commit(p);
      };
      ta.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(true); }
        else if (e.key === 'Escape') { e.preventDefault(); done(false); }
      };
      ta.onblur = () => done(true);
    },

    wireCanvas(p) {
      const canvas = $('#cx-canvas');
      if (!canvas) return;
      const toCanvas = (ev) => {
        const r = canvas.getBoundingClientRect();
        return { x: (ev.clientX - r.left) * (canvas.width / r.width), y: (ev.clientY - r.top) * (canvas.height / r.height) };
      };
      const panelAt = (pt) => (canvas._boxes || []).findIndex((b) => pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h);
      const inRect = (pt, r, pad = 0) => r && pt.x >= r.x - pad && pt.x <= r.x + r.w + pad && pt.y >= r.y - pad && pt.y <= r.y + r.h + pad;
      const near = (pt, h) => h && Math.hypot(pt.x - h.x, pt.y - h.y) <= h.r;
      canvas.addEventListener('mousedown', (ev) => {
        const pt = toCanvas(ev);
        const cur = this.resolveItem(p);
        if (cur && cur.placed && cur.box) {
          const hs = ComicLayout.selectionHandles(cur.placed, previewScale);
          if (hs && near(pt, hs.tail) && cur.line) {
            ev.preventDefault();
            drag = { mode: 'tail', it: cur, moved: false, p, canvas };
            canvas.classList.add('dragging');
            return;
          }
          if (hs && near(pt, hs.resize)) {
            ev.preventDefault();
            const c = { x: cur.placed.rect.x + cur.placed.rect.w / 2, y: cur.placed.rect.y + cur.placed.rect.h / 2 };
            const s0 = cur.line ? Number(cur.line.scale) || 1 : selItem.type === 'caption' ? Number(cur.panel.captionScale) || 1 : Number(cur.panel.sfxScale) || 1;
            drag = { mode: 'resize', it: cur, c, d0: Math.max(8, Math.hypot(pt.x - c.x, pt.y - c.y)), s0, moved: false, p, canvas };
            canvas.classList.add('dragging');
            return;
          }
        }
        const idx = panelAt(pt);
        const all = (canvas._placed || []).flatMap((list, i) => (list || []).map((b) => ({ ...b, panelIdx: i })));
        const order = { line: 0, caption: 1, sfx: 2 };
        const hit = all.filter((b) => inRect(pt, b.rect, 2)).sort((a, b) => order[a.type] - order[b.type])[0];
        if (hit) {
          ev.preventDefault();
          const panel = p.panels[hit.panelIdx];
          selItem = { panelId: panel.id, type: hit.type, id: hit.id };
          const box = canvas._boxes[hit.panelIdx];
          drag = {
            mode: 'move', panelIdx: hit.panelIdx, type: hit.type, id: hit.id, moved: false, p, canvas,
            dx: pt.x - hit.rect.x, dy: pt.y - hit.rect.y, rw: hit.rect.w, rh: hit.rect.h, box,
          };
          canvas.classList.add('dragging');
          canvas.focus({ preventScroll: true });
          if (panel.id !== selectedPanel) { selectedPanel = panel.id; this.refreshInspector(p); } else this.schedulePaint();
          return;
        }
        if (selItem) { selItem = null; this.schedulePaint(); }
        if (idx < 0) return;
        const panel = p.panels[idx];
        if (panel && panel.id !== selectedPanel) { selectedPanel = panel.id; this.refreshInspector(p); }
      });
      canvas.addEventListener('dblclick', (ev) => {
        if (!selItem) return;
        ev.preventDefault();
        this.inlineEdit(p);
      });
      canvas.addEventListener('mousemove', (ev) => {
        if (!drag) return;
        const pt = toCanvas(ev);
        drag.moved = true;
        const cl = (v, lo = 0.02, hi = 0.98) => Math.max(lo, Math.min(hi, v));
        if (drag.mode === 'move') {
          const box = canvas._boxes[drag.panelIdx];
          const panel = p.panels[drag.panelIdx];
          if (!box || !panel) return;
          const left = pt.x - drag.dx, top = pt.y - drag.dy;
          if (drag.type === 'line') {
            const line = panel.lines.find((l) => l.id === drag.id);
            if (!line) return;
            line.anchor = { x: cl((left + drag.rw / 2 - box.x) / box.w, 0.04, 0.96), y: cl((top + drag.rh / 2 - box.y) / box.h, 0.04, 0.96) };
            line.manual = true;
            if (!line.tailManual) line.tailTo = null;
          } else if (drag.type === 'caption') {
            panel.captionAt = { x: cl((left - box.x) / box.w, 0, 0.95), y: cl((top - box.y) / box.h, 0, 0.95) };
          } else {
            panel.sfxAt = { x: cl((left + drag.rw / 2 - box.x) / box.w), y: cl((top + drag.rh / 2 - box.y) / box.h) };
          }
        } else if (drag.mode === 'tail') {
          const { line, box, placed } = drag.it;
          if (!box) return;
          line.tailTo = { x: cl((pt.x - box.x) / box.w, 0.005, 0.995), y: cl((pt.y - box.y) / box.h, 0.005, 0.995) };
          line.tailManual = true;
          if (!line.manual && placed) { line.anchor = { ...placed.anchor }; line.manual = true; }
        } else if (drag.mode === 'resize') {
          const s = Math.max(0.5, Math.min(2.6, drag.s0 * (Math.hypot(pt.x - drag.c.x, pt.y - drag.c.y) / drag.d0)));
          const it = drag.it;
          if (it.line) it.line.scale = Math.round(s * 100) / 100;
          else if (selItem && selItem.type === 'caption') it.panel.captionScale = Math.round(s * 100) / 100;
          else it.panel.sfxScale = Math.round(s * 100) / 100;
        }
        this.schedulePaint();
      });
      canvas.addEventListener('keydown', (ev) => {
        if (!selItem) return;
        if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); this.deleteSelected(p); }
        else if (ev.key === 'Escape') { selItem = null; this.schedulePaint(); }
        else if (ev.key === 'Enter' || ev.key === 'F2') { ev.preventDefault(); this.inlineEdit(p); }
      });
      if (!this._mouseupWired) {
        this._mouseupWired = true;
        window.addEventListener('mouseup', () => this.endDrag());
      }
    },

    endDrag() {
      if (!drag) return;
      const d = drag;
      drag = null;
      d.canvas.classList.remove('dragging');
      if (d.moved) { Comics.persist(); this.refreshInspector(d.p); }
    },

    refreshInspector(p) {
      const box = $('#cx-insp');
      if (!box) return;
      box.innerHTML = this.inspectorHtml(p);
      this.wireInspector(p);
      lastSig = this.signature(p);
      this.schedulePaint();
    },
  };

  window.ComicsUI = ComicsUI;
})();
