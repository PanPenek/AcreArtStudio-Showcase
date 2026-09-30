/**
 * comics.js: the comic page / illustrated story builder.
 *
 * The hard part is CONSISTENCY: an image generator has no memory between panels,
 * so panel two draws a different character unless something prevents it. Two
 * mechanisms, chosen per project:
 *   bible:  a character model sheet is written once and repeated word for word at
 *           the top of every panel prompt (cheap, text-only, most of the win);
 *   vision: additionally, each finished panel is read back by a vision model and
 *           what it ACTUALLY shows is carried into the next panel's prompt.
 * Panels are project assets, not artworks: only the composed page becomes a card
 * in the library.
 */
(function () {
  const T = {
    /** Prompt: write the character model sheet (the "bible") for a comic. */
    bible({ premise, theme, panels, style, tone }) {
      return `You are the art director for an anime-style comic. Before anything is drawn you write the model sheet — the fixed description that every single panel will repeat word for word so the same character comes out of the generator every time.

Premise: """${String(premise || '').slice(0, 700)}"""
${theme ? `Theme: ${theme}\n` : ''}${style ? `House style: ${style}\n` : ''}${tone ? `Tone: ${tone}\n` : ''}Planned length: ${panels} panels.

Rules for the character descriptions:
- ONE self-contained sentence each, 20-40 words, physical only. It gets pasted verbatim into every panel prompt, so it cannot refer to anything outside itself and cannot contain story.
- Concrete and countable: exact hair colour, length and style; eye colour; body type; skin tone; age impression; the default outfit with its colours and materials. "Silver hair to the waist with a blunt fringe, amber eyes" is usable. "Beautiful long hair" is not.
- If the premise involves a costume or look change (e.g. a knight putting on armour), describe the character's BEFORE state here and put the after state in "transformTo" — the panels will move between them.

Respond ONLY with JSON:
{
  "title": "a short title for the comic, max 40 characters",
  "logline": "one sentence describing what happens",
  "characters": [{"name": "short label used in dialogue", "look": "the repeatable sentence", "transformTo": "the changed physical description, or empty string"}],
  "setting": "one sentence: where this happens, time of day, light",
  "style": "one short phrase for rendering style, repeated in every panel"
}`;
    },

    /** Prompt: write the panel-by-panel script (beats, captions, dialogue). */
    script({ premise, theme, panels, bible, tone, kind }) {
      const cast = (bible.characters || [])
        .map((c) => `- ${c.name}: ${c.look}${c.transformTo ? ` | after the change: ${c.transformTo}` : ''}`)
        .join('\n');
      return `You are writing ${kind === 'story' ? 'a short illustrated story' : `a ${panels}-panel anime-style comic`}.

Premise: """${String(premise || '').slice(0, 700)}"""
${theme ? `Theme: ${theme}\n` : ''}${tone ? `Tone: ${tone}\n` : ''}
THE CAST (these descriptions are fixed — the panel prompts must reuse them, not reinvent them):
${cast || '- (none defined)'}
Setting: ${bible.setting || '(free)'}
Rendering style: ${bible.style || '(free)'}

Write ${panels} panel${panels > 1 ? 's' : ''} that tell one complete arc — a setup, a turn, and a payoff. Not ${panels} versions of the same moment.

For each panel give:
- "beat": what happens, one sentence, in story terms. This is for the artist to read.
- "stage": where this panel sits in the change — "before" if it has not started, "changing" if it is visibly happening in this panel, "after" once it is finished. If nothing about the character's look changes in this story, every panel is "before". This picks which character description gets prepended to the prompt, so a panel showing the character mid-change MUST be "changing" or it will be drawn unchanged no matter what the prompt says.
- "prompt": what the image generator is told. Describe ONLY what is visible: pose, expression, outfit, camera angle, framing, lighting. No names, no story, no "then", no reference to other panels. Do NOT repeat the character description — that gets prepended automatically. On a "changing" panel, say what the change looks like AT THIS MOMENT — how far it has got, what is half-done — because that is the only thing separating this panel from the next one. 25-60 words.
- "caption": narration for the corner box, or "" if the picture carries it alone. Max 110 characters.
- "dialogue": 0-2 spoken lines, each {"speaker": "name from the cast", "text": "what they say, max 90 characters", "kind": "speech" or "thought"}.

Vary the camera across panels: at least one wide or establishing shot and at least one close-up. Escalate — the last panel must not be interchangeable with the first.
${kind === 'story' ? '\nAlso write "story": 120-220 words of prose telling the whole thing, for the text block beside the picture. Past tense, third person, sensory, and it must stand alone without the panels.\n' : ''}
Respond ONLY with JSON:
{"panels": [{"beat": "...", "stage": "before | changing | after", "prompt": "...", "caption": "...", "dialogue": [{"speaker": "...", "text": "...", "kind": "speech"}]}]${kind === 'story' ? ', "story": "..."' : ''}}`;
    },

    /** Vision: what a finished panel actually shows, in the terms the next panel needs. */
    continuity() {
      return `You are keeping continuity on a comic. Look at this finished panel and record what a reader can SEE, so the next panel can be drawn to match it. Ignore quality and subject matter — you are recording facts, not judging them.

Respond ONLY with JSON:
{"appearance": "the character's fixed physical facts as rendered here — hair colour and length, eye colour, body type, skin tone (max 30 words)", "wardrobe": "every garment visible and its exact state right now (max 25 words)", "setting": "where they are and the light (max 20 words)", "carryOver": "the one sentence the NEXT panel must include to look like a continuation of this one (max 35 words)"}`;
    },

    /** Vision: choose which of the batch to keep. */
    pick({ look, beat, count }) {
      return `You are choosing which generated image to use as one panel of a comic. ${count} candidates are shown to you as separate images, numbered 1 to ${count} in the order given.

The panel must show: ${beat}
The character must match: ${look}

Judge in this order:
1. Does it match the character description above? A mismatch in hair, eye colour, body or outfit disqualifies an image no matter how well drawn it is.
2. Does it show the beat?
3. Is it competently rendered — hands, limbs, faces, no melted geometry?

Respond ONLY with JSON: {"best": <1-${count}>, "why": "one short sentence", "scores": [{"n": 1, "match": <1-10>, "render": <1-10>}]}`;
    },

    /** Prose for the story layout, when the script call did not produce it. */
    story({ premise, bible, panels }) {
      return `Write the prose for an illustrated story panel-set.

Premise: """${String(premise || '').slice(0, 600)}"""
Characters: ${(bible.characters || []).map((c) => `${c.name} (${c.look})`).join('; ') || '(free)'}
The beats, in order:
${(panels || []).map((p, i) => `${i + 1}. ${p.beat || p.prompt}`).join('\n')}

Write 140-240 words of prose telling this story. Past tense, third person, sensory and warm. It sits beside the picture and must stand alone. No headings, no bullet points, no title.

Respond with the prose only — no JSON, no quotes around it.`;
    },
  };

  /** Where the Nth speech bubble in a panel starts out. */
  function defaultBubblePlacement(i, hasCaption = false) {
    const spots = [
      { anchor: { x: 0.34, y: 0.15 }, tailTo: { x: 0.40, y: 0.38 } },
      { anchor: { x: 0.68, y: 0.34 }, tailTo: { x: 0.62, y: 0.56 } },
      { anchor: { x: 0.36, y: 0.56 }, tailTo: { x: 0.42, y: 0.76 } },
    ];
    const spot = spots[i % spots.length];
    if (!hasCaption || spot.anchor.y > 0.26) return spot;
    return { anchor: { x: spot.anchor.x, y: 0.32 }, tailTo: { x: spot.tailTo.x, y: 0.55 } };
  }

  // Stories often show a change over time (a knight putting on armour, a caterpillar becoming a
  // butterfly). Each panel is placed "before", "changing" or "after" that change, so the right
  // character description is prepended. When the script does not say, guess from its wording.
  const STAGE_AFTER = /(fully|completely|finished|now a |now an |afterwards?|change complete)/i;
  const STAGE_CHANGING = /(shift|grow|morph|chang|transform|becom|turning into|mid-)/i;

  function panelStage(panel) {
    const chosen = String((panel && panel.stage) || '').toLowerCase();
    if (chosen === 'before' || chosen === 'changing' || chosen === 'after') return chosen;
    const text = `${(panel && panel.beat) || ''} ${(panel && panel.prompt) || ''}`;
    if (STAGE_AFTER.test(text)) return 'after';
    if (STAGE_CHANGING.test(text)) return 'changing';
    return 'before';
  }

  /** The description of one character at one stage of the change. */
  function describeAt(character, stage) {
    const look = String(character.look || '');
    const after = String(character.transformTo || '');
    if (!after || stage === 'before') return look;
    if (stage === 'after') return after;
    return `${after}, mid-transformation and only partly changed`;
  }

  /** Text defaults for a freshly created project. */
  function defaultStyle() {
    return {
      font: '"Comic Sans MS", "Segoe UI", sans-serif',
      captionSize: 22,
      bubbleSize: 22,
      storySize: 26,
      captionBg: 'rgba(252, 250, 245, 0.94)',
      captionColor: '#1c1917',
      bubbleBg: '#fdfcf9',
      bubbleColor: '#12100e',
      bubbleBorder: '#12100e',
      captionCorner: 'top',
      captionAlign: 'left',
      pageBg: '#0f0d0c',
      gutterColor: '#0f0d0c',
      panelBorder: '#f5f5f4',
      panelBorderWidth: 4,
      storyBg: '#141210',
      storyColor: '#f5f5f4',
      titleColor: '#f5f5f4',
      showTitle: true,
      showPageNumber: false,
    };
  }

  function defaultGeom(kind) {
    return kind === 'story'
      ? { width: 1800, height: 1100, margin: 46, gutter: 30 }
      : { width: 1400, height: 1900, margin: 40, gutter: 22 };
  }

  const log = (m, k) => State.addLog(m, k);

  const Comics = {
    data: { projects: [], version: 1 },
    busy: false,

    async init() {
      const loaded = await window.ala.db.getComics().catch(() => null);
      this.data = loaded && Array.isArray(loaded.projects) ? loaded : { projects: [], version: 1 };
    },

    persist() {
      window.ala.db.setComics(this.data);
      State.emit('comics', this.data);
    },

    get(id) { return this.data.projects.find((p) => p.id === id) || null; },

    create({ name = 'Untitled comic', kind = 'page', premise = '', theme = '', panels = 4, template = '' } = {}) {
      const project = {
        id: U.uid(),
        name, kind,
        premise, theme,
        tone: '',
        panelCount: Math.max(1, Math.min(12, panels | 0 || 4)),
        visionMode: 'off',
        candidatesPerPanel: 2,
        shape: kind === 'story' ? 'portrait' : 'square',
        bible: { characters: [], setting: '', style: '' },
        title: name,
        logline: '',
        story: '',
        panels: [],
        template: template || (kind === 'story' ? 'story-left' : 'grid-2x2'),
        geom: defaultGeom(kind),
        style: defaultStyle(),
        page: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      project.panels = Array.from({ length: project.panelCount }, (_, i) => this.blankPanel(i));
      this.data.projects.unshift(project);
      this.persist();
      return project;
    },

    blankPanel(i) {
      return {
        id: U.uid(), n: i + 1,
        beat: '', prompt: '', caption: '',
        stage: '',
        dialogue: [],
        candidates: [],
        fname: '', url: '',
        status: 'empty',
        error: null,
        continuity: null,
      };
    },

    update(id, patch) {
      const p = this.get(id);
      if (!p) return null;
      Object.assign(p, patch, { updatedAt: Date.now() });
      this.persist();
      return p;
    },

    /** Resize the panel list without destroying work that is already in the kept slots. */
    setPanelCount(project, n) {
      const want = Math.max(1, Math.min(12, n | 0 || 1));
      while (project.panels.length < want) project.panels.push(this.blankPanel(project.panels.length));
      if (project.panels.length > want) project.panels = project.panels.slice(0, want);
      project.panels.forEach((p, i) => { p.n = i + 1; });
      project.panelCount = want;
      project.updatedAt = Date.now();
      this.persist();
      return project;
    },

    /** Delete a project, and optionally the panel images it made. */
    async remove(id, { withFiles = false } = {}) {
      const p = this.get(id);
      if (!p) return;
      if (withFiles) {
        const names = new Set();
        for (const panel of p.panels) {
          for (const c of panel.candidates || []) if (c.fname) names.add(c.fname);
          if (panel.fname) names.add(panel.fname);
        }
        for (const fname of names) await window.ala.files.deleteImage(fname).catch(() => {});
      }
      this.data.projects = this.data.projects.filter((x) => x.id !== id);
      this.persist();
    },

    /** The model sheet. */
    async writeBible(project) {
      const { text } = await U.llmChat(
        [{ role: 'user', content: T.bible({
          premise: project.premise, theme: project.theme,
          panels: project.panelCount, style: project.bible.style, tone: project.tone,
        }) }],
        { temperature: 0.85, maxTokens: 4000, role: 'ideation' }, 'Comic model sheet');
      const raw = U.extractJson(text);
      project.bible = {
        characters: (raw.characters || []).slice(0, 4).map((c) => ({
          name: String(c.name || 'her').slice(0, 24),
          look: String(c.look || '').trim(),
          transformTo: String(c.transformTo || '').trim(),
        })).filter((c) => c.look),
        setting: String(raw.setting || '').trim(),
        style: String(raw.style || project.bible.style || '').trim(),
      };
      if (raw.title) project.title = String(raw.title).slice(0, 60);
      if (raw.logline) project.logline = String(raw.logline).slice(0, 240);
      project.updatedAt = Date.now();
      this.persist();
      return project.bible;
    },

    /** The beats and the words. */
    async writeScript(project, { keepImages = true } = {}) {
      if (!project.bible.characters.length) await this.writeBible(project);
      const { text } = await U.llmChat(
        [{ role: 'user', content: T.script({
          premise: project.premise, theme: project.theme, panels: project.panelCount,
          bible: project.bible, tone: project.tone, kind: project.kind,
        }) }],
        { temperature: 0.9, maxTokens: 9000, role: 'ideation' }, 'Comic script');
      const raw = U.extractJson(text);
      const written = Array.isArray(raw) ? raw : (raw.panels || []);
      if (!written.length) throw new Error('the writer returned no panels');

      this.setPanelCount(project, Math.min(12, Math.max(1, written.length)));
      project.panels.forEach((panel, i) => {
        const w = written[i] || {};
        panel.beat = String(w.beat || '').trim();
        panel.prompt = String(w.prompt || w.beat || '').trim();
        panel.caption = String(w.caption || '').trim().slice(0, 160);
        panel.stage = ['before', 'changing', 'after'].includes(String(w.stage || '').toLowerCase())
          ? String(w.stage).toLowerCase() : '';
        panel.dialogue = (w.dialogue || []).slice(0, 3).map((d, di) => ({
          speaker: String(d.speaker || '').slice(0, 24),
          text: String(d.text || '').trim().slice(0, 140),
          kind: d.kind === 'thought' ? 'thought' : 'speech',
          ...defaultBubblePlacement(di),
        })).filter((d) => d.text);
        if (!keepImages) { panel.fname = ''; panel.url = ''; panel.status = 'empty'; panel.candidates = []; }
      });
      if (raw.story) project.story = String(raw.story).trim();
      if (project.kind === 'story' && !project.story) await this.writeStory(project);
      project.updatedAt = Date.now();
      this.persist();
      return project.panels;
    },

    /** Prose for the story layout, when the script did not carry it. */
    async writeStory(project) {
      const { text } = await U.llmChat(
        [{ role: 'user', content: T.story({ premise: project.premise, bible: project.bible, panels: project.panels }) }],
        { temperature: 0.9, maxTokens: 4000, role: 'ideation' }, 'Illustrated story text');
      project.story = String(text || '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
      project.updatedAt = Date.now();
      this.persist();
      return project.story;
    },

    /** What the generator is actually sent for one panel. */
    panelPrompt(project, panel) {
      const parts = [];
      const cast = project.bible.characters || [];
      const stage = panelStage(panel);
      const looks = cast.map((c) => describeAt(c, stage)).filter(Boolean);
      if (looks.length) parts.push(looks.join(' '));
      if (panel.prompt) parts.push(panel.prompt);
      else if (panel.beat) parts.push(panel.beat);
      if (panel.continuity && panel.continuity.carryOver) parts.push(panel.continuity.carryOver);
      else if (project._carry) parts.push(project._carry);
      if (project.bible.setting && !/setting|room|outdoor/i.test(panel.prompt || '')) parts.push(project.bible.setting);
      if (project.bible.style) parts.push(project.bible.style);
      parts.push('no text, no speech bubbles, no watermark, no signature');
      return parts.join('. ').replace(/\.\s*\./g, '.').slice(0, 1400);
    },

    /** The shared Perchance driver, with the checks that stop two jobs fighting over it. */
    driver() {
      if (!Pipeline.driver) throw new Error('the Perchance tab is not ready yet');
      if (Pipeline.running) throw new Error('the worker is running — pause it before building a comic (they share one Perchance tab)');
      if (window.AutoMode && AutoMode.running) throw new Error('auto mode is running — stop it before building a comic');
      if (Pipeline.driver.busy) throw new Error('the generator is busy with another panel');
      return Pipeline.driver;
    },

    /** Generate one panel: ask for a few candidates, keep them all, choose one. */
    async generatePanel(project, panelId, { onLog = log } = {}) {
      const panel = project.panels.find((p) => p.id === panelId);
      if (!panel) throw new Error('no such panel');
      const prompt = this.panelPrompt(project, panel);
      if (!prompt.trim()) throw new Error(`panel ${panel.n} has nothing to draw — write the script first`);

      const driver = this.driver();
      panel.status = 'generating';
      panel.error = null;
      this.persist();

      try {
        if (!panel.controls && Pipeline.advancedIdeationOn()) {
          panel.controls = await Pipeline.chooseControls(prompt).catch((e) => {
            onLog(`Panel ${panel.n}: could not choose controls (${e.message}) — using the saved presets.`, 'err');
            return null;
          });
          if (panel.controls) {
            onLog(`Panel ${panel.n}: controls ${Object.entries(panel.controls).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
            this.persist();
          }
        }
        const res = await driver.generate(prompt, {
          timeoutMs: 300000,
          count: project.candidatesPerPanel || 2,
          shape: project.shape || '',
          filters: panel.controls || null,
        }, (m, k) => onLog(`Panel ${panel.n}: ${m}`, k));
        if (!res.images.length) throw new Error('the generator returned no images');

        const saved = [];
        for (const img of res.images) {
          const file = await window.ala.files.saveImage(img.base64, U.extFromMime(img.mime), `panel${panel.n}`);
          saved.push({ fname: file.fname, url: file.url, mime: img.mime, w: img.w, h: img.h, at: Date.now() });
        }
        panel.candidates = [...(panel.candidates || []), ...saved];

        let chosen = saved[0];
        if (project.visionMode === 'continuity' && saved.length > 1) {
          const best = await this.pickBest(project, panel, saved).catch((e) => {
            onLog(`Panel ${panel.n}: could not judge the candidates (${e.message}) — keeping the first.`, 'err');
            return null;
          });
          if (best) chosen = best;
        }
        this.choose(project, panel, chosen.fname, { persist: false });
        panel.status = 'ready';
        panel.error = null;
        this.persist();

        if (project.visionMode === 'continuity') {
          await this.readPanel(project, panel).catch((e) =>
            onLog(`Panel ${panel.n}: continuity read failed (${e.message}) — the next panel falls back to the model sheet.`, 'err'));
        }
        return panel;
      } catch (e) {
        panel.status = 'failed';
        panel.error = e.message;
        this.persist();
        throw e;
      }
    },

    /** Point a panel at one of its candidates. */
    choose(project, panel, fname, { persist = true } = {}) {
      const cand = (panel.candidates || []).find((c) => c.fname === fname);
      if (!cand) return panel;
      panel.fname = cand.fname;
      panel.url = cand.url;
      panel.status = 'ready';
      panel.continuity = null;
      project.updatedAt = Date.now();
      if (persist) this.persist();
      return panel;
    },

    /** Vision: which candidate is the panel. */
    async pickBest(project, panel, candidates) {
      const look = (project.bible.characters || []).map((c) => c.look).join(' ');
      const scored = await U.mapLimit(candidates, 2, async (cand, i) => {
        const base64 = await window.ala.files.readImageBase64(cand.fname).catch(() => null);
        if (!base64) return { i, score: -1 };
        const shrunk = await Pipeline.downscaleForQc(base64, cand.mime || 'image/jpeg');
        const r = await U.llmVision(shrunk.base64, shrunk.mime,
          T.pick({ look, beat: panel.beat || panel.prompt, count: 1 }),
          { role: 'vision', maxTokens: State.settings.lmStudio.visionMaxTokens || 12000 },
          `Judging panel ${panel.n} candidate ${i + 1}`);
        try {
          const j = U.extractJson(r.text);
          const s = (j.scores && j.scores[0]) || j;
          return { i, score: (Number(s.match) || 0) * 2 + (Number(s.render) || 0), why: j.why || '' };
        } catch { return { i, score: 0 }; }
      });
      const best = scored.reduce((a, b) => (b.score > a.score ? b : a), scored[0]);
      if (!best || best.score < 0) return candidates[0];
      if (best.why) log(`Panel ${panel.n}: picked candidate ${best.i + 1} — ${best.why}`);
      return candidates[best.i];
    },

    /** Vision: read the chosen panel and remember what it really shows. */
    async readPanel(project, panel) {
      if (!panel.fname) return null;
      const base64 = await window.ala.files.readImageBase64(panel.fname).catch(() => null);
      if (!base64) return null;
      const shrunk = await Pipeline.downscaleForQc(base64, 'image/jpeg');
      const r = await U.llmVision(shrunk.base64, shrunk.mime, T.continuity(),
        { role: 'vision', maxTokens: State.settings.lmStudio.visionMaxTokens || 12000 },
        `Continuity read of panel ${panel.n}`);
      let note = null;
      try { note = U.extractJson(r.text); } catch { note = null; }
      panel.continuity = note;
      if (note && note.carryOver) project._carry = note.carryOver;
      this.persist();
      return note;
    },

    /** Generate every panel that has no image yet, in order. */
    async generateAll(project, { onProgress = () => {}, redoAll = false } = {}) {
      if (this.busy) throw new Error('a comic is already being generated');
      this.busy = true;
      State.emit('comicsBusy', { running: true, projectId: project.id });
      try {
        const todo = project.panels.filter((p) => redoAll || !p.fname);
        for (let i = 0; i < todo.length; i++) {
          onProgress({ done: i, total: todo.length, panel: todo[i] });
          await this.generatePanel(project, todo[i].id);
          const delay = (State.settings.gen.delayBetweenGensSec || 8) * 1000;
          if (i < todo.length - 1) await U.sleep(delay);
        }
        onProgress({ done: todo.length, total: todo.length });
        return project;
      } finally {
        this.busy = false;
        State.emit('comicsBusy', { running: false, projectId: project.id });
      }
    },

    /** Draw the page onto a canvas. */
    async compose(project, { scale = 1, canvas = null } = {}) {
      const L = window.ComicLayout;
      const layout = L.layoutFor(project.template, project.panels.length);
      const geom = {
        width: Math.round(project.geom.width * scale),
        height: Math.round(project.geom.height * scale),
        margin: Math.round(project.geom.margin * scale),
        gutter: Math.round(project.geom.gutter * scale),
      };
      const st = project.style;
      const cv = canvas || document.createElement('canvas');
      cv.width = geom.width;
      cv.height = geom.height;
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingQuality = 'high';

      ctx.fillStyle = st.pageBg;
      ctx.fillRect(0, 0, geom.width, geom.height);

      let titleH = 0;
      if (st.showTitle && project.title) {
        titleH = Math.round(54 * scale);
        ctx.fillStyle = st.titleColor;
        ctx.font = `700 ${Math.round(34 * scale)}px ${st.font}`;
        ctx.textBaseline = 'middle';
        ctx.fillText(project.title, geom.margin, geom.margin + titleH / 2 - Math.round(8 * scale));
      }
      const body = { ...geom, height: geom.height - titleH };
      const boxes = L.panelBoxes(layout, body).map((b) => ({ ...b, y: b.y + titleH }));
      const tBox = L.textBox(layout, body);
      const textArea = tBox ? { ...tBox, y: tBox.y + titleH } : null;

      const captionStyle = {
        font: st.font, fontSize: Math.round(st.captionSize * scale), fontWeight: 600,
        bg: st.captionBg, color: st.captionColor, corner: st.captionCorner,
        align: st.captionAlign, radius: Math.round(5 * scale),
        borderColor: null,
      };
      const bubbleStyle = {
        font: st.font, fontSize: Math.round(st.bubbleSize * scale), fontWeight: 500,
        bg: st.bubbleBg, color: st.bubbleColor, borderColor: st.bubbleBorder,
        borderWidth: Math.max(1, Math.round(2.5 * scale)), speakerColor: st.captionColor,
      };

      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        const panel = project.panels[i];
        ctx.save();
        ctx.beginPath();
        ctx.rect(box.x, box.y, box.w, box.h);
        ctx.clip();

        if (panel && panel.url) {
          const img = await loadImage(panel.url).catch(() => null);
          if (img) {
            const s = L.coverRect(img, box);
            ctx.drawImage(img, s.sx, s.sy, s.sw, s.sh, box.x, box.y, box.w, box.h);
          } else {
            drawPlaceholder(ctx, box, `panel ${i + 1} — image missing`, st, scale);
          }
        } else {
          drawPlaceholder(ctx, box, `panel ${i + 1}`, st, scale);
        }

        if (panel) {
          const capBox = L.drawCaption(ctx, box, panel.caption, captionStyle);
          (panel.dialogue || []).forEach((line, di) =>
            L.drawBubble(ctx, box, { ...defaultBubblePlacement(di, !!panel.caption), ...line }, bubbleStyle, { avoid: capBox }));
        }
        ctx.restore();

        if (st.panelBorderWidth > 0) {
          ctx.strokeStyle = st.panelBorder;
          ctx.lineWidth = Math.max(1, Math.round(st.panelBorderWidth * scale));
          ctx.strokeRect(box.x, box.y, box.w, box.h);
        }
      }

      if (textArea) this.drawStory(ctx, project, textArea, scale);

      if (st.showPageNumber) {
        ctx.fillStyle = st.titleColor;
        ctx.font = `500 ${Math.round(18 * scale)}px ${st.font}`;
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('1', geom.width - geom.margin - Math.round(10 * scale), geom.height - Math.round(14 * scale));
      }
      return cv;
    },

    /** The story column. */
    drawStory(ctx, project, box, scale) {
      const L = window.ComicLayout;
      const st = project.style;
      ctx.fillStyle = st.storyBg;
      L.roundRect(ctx, box.x, box.y, box.w, box.h, Math.round(8 * scale));
      ctx.fill();

      const pad = Math.round(30 * scale);
      const inner = { x: box.x + pad, y: box.y + pad, w: box.w - pad * 2, h: box.h - pad * 2 };
      let cursorY = inner.y;

      if (project.title && !st.showTitle) {
        const size = Math.round(34 * scale);
        ctx.font = `700 ${size}px ${st.font}`;
        ctx.fillStyle = st.titleColor;
        ctx.textBaseline = 'top';
        ctx.fillText(project.title, inner.x, cursorY);
        cursorY += size * 1.5;
      }

      const text = project.story || project.logline || '';
      if (!text) return;
      const avail = { w: inner.w, h: inner.h - (cursorY - inner.y) };
      const fit = L.fitFontSize(text, avail, {
        max: Math.round(st.storySize * scale),
        min: Math.round(11 * scale),
        measureAt: (s, size) => { ctx.font = `400 ${size}px ${st.font}`; return ctx.measureText(s).width; },
      });
      ctx.font = `400 ${fit.size}px ${st.font}`;
      ctx.fillStyle = st.storyColor;
      ctx.textBaseline = 'top';
      const lh = Math.round(fit.size * 1.38);
      const slack = Math.max(0, avail.h - fit.lines.length * lh);
      const top = cursorY + Math.round(slack / 2);
      fit.lines.forEach((line, i) => ctx.fillText(line, inner.x, top + i * lh));
      if (fit.clipped) {
        log('The story text is longer than its column — it was cut. Shorten it, or use a taller layout.', 'err');
      }
    },

    /** Compose at full size and put the result in the library as a normal card. */
    async exportPage(project, { writeMetadata = false } = {}) {
      const canvas = await this.compose(project, { scale: 1 });
      const base64 = canvas.toDataURL('image/png').split(',')[1];
      if (!base64) throw new Error('the page could not be rendered');
      const saved = await window.ala.files.saveImage(base64, 'png', `comic-${(project.title || 'page').slice(0, 20)}`);

      const card = {
        id: saved.id,
        jobId: null,
        theme: project.theme || '',
        prompt: this.pagePrompt(project),
        promptSource: 'comic',
        learnedFrom: null,
        comicId: project.id,
        fname: saved.fname, path: saved.path, url: saved.url,
        mime: 'image/png', width: canvas.width, height: canvas.height,
        destination: (State.settings.publish && State.settings.publish.destination) || 'deviantart',
        status: 'review', qc: null, qcSkipped: true,
        metadata: {
          title: (project.title || project.name || 'Comic').slice(0, 50),
          description: project.logline || project.story || '',
          tags: [],
        },
        da: null, error: null,
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      State.library.unshift(card);
      State.persistLibrary();

      project.page = { fname: saved.fname, url: saved.url, cardId: card.id, composedAt: Date.now() };
      project.updatedAt = Date.now();
      this.persist();

      if (writeMetadata) {
        await Pipeline.writeCardMetadata(card).catch((e) =>
          log(`The page is in Review but its metadata could not be written: ${e.message}`, 'err'));
      } else if (window.Titles && card.metadata.title) {
        Titles.remember(card.metadata.title, 'card', card.id);
      }
      log(`Comic page "${project.title}" composed and sent to Review.`, 'ok');
      return card;
    },

    /** The "prompt" a composed page carries into the library. */
    pagePrompt(project) {
      const cast = (project.bible.characters || []).map((c) => `${c.name}: ${c.look}`).join(' ');
      const beats = project.panels.map((p, i) => `(${i + 1}) ${p.beat || p.prompt}`).join(' ');
      return [
        `${project.kind === 'story' ? 'Illustrated story' : `${project.panels.length}-panel comic`}: ${project.logline || project.premise}`,
        cast, beats,
      ].filter(Boolean).join(' — ').slice(0, 1800);
    },
  };

  function drawPlaceholder(ctx, box, label, st, scale) {
    ctx.fillStyle = '#1c1917';
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.strokeStyle = '#44403c';
    ctx.setLineDash([Math.round(10 * scale), Math.round(8 * scale)]);
    ctx.lineWidth = Math.max(1, Math.round(2 * scale));
    ctx.strokeRect(box.x + 6, box.y + 6, box.w - 12, box.h - 12);
    ctx.setLineDash([]);
    ctx.fillStyle = '#78716c';
    ctx.font = `500 ${Math.round(20 * scale)}px ${st.font}`;
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(label).width;
    ctx.fillText(label, box.x + (box.w - w) / 2, box.y + box.h / 2);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image failed to load'));
      img.src = src;
    });
  }

  window.Comics = Comics;
  window.ComicT = T;
  window.comicBubblePlacement = defaultBubblePlacement;
  window.comicPanelStage = panelStage;
  window.comicDescribeAt = describeAt;
})();
