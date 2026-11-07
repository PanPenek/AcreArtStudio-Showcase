/**
 * series.js: Comics → Series (engine, no UI; seriesui.js draws the panel).
 *
 * A series is a named recurring story or theme. Each part is ONE comic page made by the
 * Comics engine: a writer plans the part from the series and the earlier parts (so a part
 * does not repeat an earlier one), the page is drawn and lettered like any comic, titled
 * "Name — Part N" and filed in the series' own DeviantArt folder, with links to the
 * earlier parts in its description. Saved in <userData>/series.json.
 */
(function () {
  const VERSION = 1;
  const MAX_SERIES = 40;
  const TITLE_MAX = 50;

  const clean = (s, n = 400) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  const uid = () => (window.U && typeof U.uid === 'function' ? U.uid() : `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`);

  function lastJsonObject(text) {
    const t = String(text || '');
    for (let end = t.lastIndexOf('}'); end >= 0; end = t.lastIndexOf('}', end - 1)) {
      for (let start = t.lastIndexOf('{', end); start >= 0; start = t.lastIndexOf('{', start - 1)) {
        try { const v = JSON.parse(t.slice(start, end + 1)); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch {  }
      }
    }
    return null;
  }

  function parsePlan(text) {
    const v = lastJsonObject(text);
    if (!v) return null;
    const plan = {
      title: clean(v.title, 60).replace(/^part\s*\d+\s*[:\-–—]\s*/i, ''),
      character: clean(v.character, 300),
      place: clean(v.place, 160),
      trigger: clean(v.trigger, 240),
      logline: clean(v.logline, 400),
      hook: clean(v.hook, 140).replace(/^["“]|["”]$/g, ''),
      next: clean(v.next, 240),
    };
    return plan.character && plan.logline ? plan : null;
  }

  function seriesTag(series) { return window.Growth ? Growth.cleanTag(series.name) : String(series.name || '').toLowerCase().replace(/[^a-z0-9_]+/g, ''); }

  const Series = {
    data: { series: [], version: VERSION },

    async init() {
      const d = await window.ala.db.getSeries().catch(() => null);
      this.data = { series: d && Array.isArray(d.series) ? d.series : [], version: VERSION };
    },

    persist() { return window.ala.db.setSeries(this.data); },

    list() { return this.data.series; },
    get(id) { return this.data.series.find((s) => s.id === id) || null; },

    create({ name, about, world = '', tone = '', folderId = '', folderName = '', panels = 4, takes = 2,
      pageStyle = 'classic', workflow = '', layout = 'auto', sequence = false } = {}) {
      name = clean(name, 40);
      about = clean(about, 600);
      if (!name) throw new Error('give the series a name');
      if (!about) throw new Error('say what the series is about');
      if (this.data.series.length >= MAX_SERIES) throw new Error(`at most ${MAX_SERIES} series`);
      if (this.data.series.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new Error(`there is already a series called "${name}"`);
      const s = {
        id: uid(), version: VERSION, name, about, world: clean(world, 400), tone: clean(tone, 200),
        folderId: clean(folderId, 40), folderName: clean(folderName, 80),
        panels: Math.max(3, Math.min(6, Number(panels) || 4)), takes: Math.max(1, Math.min(4, Number(takes) || 2)),
        pageStyle: pageStyle || 'classic', workflow: clean(workflow, 200), layout: layout === 'grid' ? 'grid' : 'auto', sequence: !!sequence,
        parts: [], createdAt: Date.now(), updatedAt: Date.now(),
      };
      this.data.series.unshift(s);
      this.persist();
      return s;
    },

    update(id, patch) {
      const s = this.get(id);
      if (!s) return null;
      const allowed = ['name', 'about', 'world', 'tone', 'folderId', 'folderName', 'panels', 'takes', 'pageStyle', 'workflow', 'layout', 'sequence'];
      for (const k of allowed) if (k in (patch || {})) s[k] = typeof s[k] === 'number' ? Number(patch[k]) : typeof s[k] === 'boolean' ? !!patch[k] : clean(patch[k], 600);
      s.updatedAt = Date.now();
      this.persist();
      return s;
    },

    remove(id) {
      this.data.series = this.data.series.filter((s) => s.id !== id);
      this.persist();
    },

    /** The writer's brief for Part n: the series, the earlier parts not to repeat, the JSON to return. */
    planPrompt(series, n) {
      const earlier = (series.parts || []).filter((p) => p.plan).slice(-12)
        .map((p) => `Part ${p.n}: ${p.plan.logline} (place: ${p.plan.place}; what set it off: ${p.plan.trigger})`);
      const shape = series.sequence
        ? `panel 1 shows the starting point, every later panel the next stage of the same change in the same framing, the last panel the result and the character's reaction`
        : 'panel 1 sets up the character and the place, the middle panels show what happens, the last panel shows the outcome and the character\'s reaction';
      return `You plan the next part of an ongoing comic series.

Series: "${series.name}".
What the series is about: ${series.about}
${series.world ? `World: ${series.world}\n` : ''}${series.tone ? `Tone: ${series.tone}\n` : ''}
${earlier.length ? `Earlier parts (do NOT repeat their main character, place or situation):\n${earlier.join('\n')}\n` : 'This is Part 1: introduce the series clearly.\n'}
Plan Part ${n} as ONE ${series.panels || 4}-panel page with a beginning, a turn and an ending: ${shape}. Keep it readable in one glance per panel.

Return JSON only:
{"title": "2-5 word hook for this part, no part number", "character": "the main character of this part in one line: look, hair, clothes", "place": "one place", "trigger": "what sets this part's events off", "logline": "one sentence: what happens", "hook": "one short line spoken in the last panel", "next": "one sentence teasing the next part"}`;
    },

    /** A plain plan when the writer fails twice, so a part can still be made. */
    fallbackPlan(series, n) {
      const places = ['a lighthouse on a stormy night', 'a city rooftop at dusk', 'a busy harbour market', 'a quiet library', 'a forest path in autumn', 'a train carriage'];
      const place = places[(n - 1) % places.length];
      return {
        title: `Part ${n}`, character: 'a young courier with short dark hair, a green jacket and a messenger bag', place,
        trigger: `the series' premise catches them by surprise in ${place}`,
        logline: `${series.about.replace(/[.!]+$/, '')}: this time it happens in ${place}.`,
        hook: 'Not again...', next: '',
      };
    },

    async planNext(seriesId) {
      const s = this.get(seriesId);
      if (!s) throw new Error('no such series');
      const n = (s.parts.reduce((m, p) => Math.max(m, p.n || 0), 0) || 0) + 1;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { text } = await U.llmChat([{ role: 'user', content: this.planPrompt(s, n) }],
            { temperature: 0.9, maxTokens: 1200, role: 'ideation' }, `Series part plan (${s.name} ${n})`);
          const plan = parsePlan(text);
          if (plan) return { n, plan, planned: 'writer' };
        } catch {  }
      }
      return { n, plan: this.fallbackPlan(s, n), planned: 'fallback' };
    },

    /** The comic premise for one part, built from the series and the part's plan. */
    premiseFor(series, plan, n) {
      const panels = series.panels || 4;
      return [
        `${series.name}, Part ${n}${plan.title && !/^part\s*\d+$/i.test(plan.title) ? `: ${plan.title}` : ''}. ${series.about}`,
        series.world ? `World: ${series.world}` : '',
        `This part: ${plan.logline}`,
        `The main character: ${plan.character}. Place: ${plan.place}. What sets it off: ${plan.trigger}.`,
        series.sequence
          ? `A ${panels}-panel change sequence in one place with the same camera: panel 1 shows the starting point; the middle panels show the change, each one further along (say exactly what has changed so far); panel ${panels} shows the result and the reaction.`
          : `A ${panels}-panel page: panel 1 sets the scene, the middle panels show it unfolding, panel ${panels} shows the outcome and the reaction.`,
        plan.hook ? `Last line: "${plan.hook}"` : '',
      ].filter(Boolean).join('\n');
    },

    /** Plan the next part and start it as a comic project (lands in Review like any comic). */
    async nextPart(seriesId, { plan = null, start = true } = {}) {
      const s = this.get(seriesId);
      if (!s) throw new Error('no such series');
      if (!window.Comics) throw new Error('the Comics engine is not loaded');
      const busy = s.parts.find((p) => p.status === 'making');
      if (busy) {
        const proj = Comics.get && Comics.get(busy.projectId);
        if (proj && proj.run && proj.run.active) throw new Error(`Part ${busy.n} is still being made`);
      }
      const planned = plan ? { n: (s.parts.reduce((m, p) => Math.max(m, p.n || 0), 0) || 0) + 1, plan, planned: 'given' } : await this.planNext(seriesId);
      const { n } = planned;
      const project = Comics.create({
        name: `${s.name} — Part ${n}`.slice(0, 80), format: 'page',
        premise: this.premiseFor(s, planned.plan, n), theme: `series:${s.name}`, tone: s.tone || '',
        panels: s.panels || 4, takes: s.takes || 2, workflow: s.workflow || '',
        pageStyle: s.pageStyle || 'classic', lettering: 'balloons', sequence: !!s.sequence, plates: !s.sequence,
      });
      project.series = { id: s.id, part: n };
      project.title = `${s.name} — Part ${n}`.slice(0, 60);
      project.titleManual = true;
      if (s.layout === 'grid' && (s.panels || 4) === 4 && window.ComicLayout && ComicLayout.LAYOUTS && ComicLayout.LAYOUTS['grid-2x2']) project.template = 'grid-2x2';
      if (Comics.persist) Comics.persist();
      const part = {
        n, projectId: project.id, cardId: null, status: 'making', plan: planned.plan, planned: planned.planned,
        createdAt: Date.now(), exportedAt: 0,
      };
      s.parts.push(part);
      s.updatedAt = Date.now();
      this.persist();
      if (start) Comics.start(project);
      return { series: s, part, project };
    },

    partOf(series, n) { return (series.parts || []).find((p) => p.n === n) || null; },

    cardOf(part) {
      if (!part || !part.cardId) return null;
      return (State.library || []).find((c) => c.id === part.cardId) || null;
    },

    links(series, n) {
      const url = (p) => { const c = this.cardOf(p); return c && c.da && c.da.url ? c.da.url : null; };
      return { first: n > 1 ? url(this.partOf(series, 1)) : null, prev: n > 1 ? url(this.partOf(series, n - 1)) : null };
    },

    /** Title, description and tags for a part's Review card: "Name — Part N", the story so far, links to earlier parts. */
    metadataFor(series, part, card) {
      const n = part.n;
      let title = `${series.name} — Part ${n}`;
      if (title.length > TITLE_MAX) title = `${series.name.slice(0, TITLE_MAX - 8).trim()} Pt ${n}`;
      const { first, prev } = this.links(series, n);
      const plan = part.plan || {};
      const next = String(plan.next || '').replace(/^\s*next(?:\s+(?:time|part))?\s*[:,.\-–—]\s*/i, '').trim();
      const story = [plan.logline, next ? `Next: ${next}` : ''].filter(Boolean).join(' ');
      const nav = [prev ? `Previous part: ${prev}` : '', first && first !== prev ? `Part 1: ${first}` : ''].filter(Boolean).join('\n');
      const description = [story, nav].filter(Boolean).join('\n\n');
      const tags = window.Growth
        ? Growth.tagsFor({ series: seriesTag(series), format: 'sequence', text: `${series.about} ${plan.logline || ''} ${plan.trigger || ''}` })
        : ['comic', 'series'];
      return { title, description, tags };
    },

    /** A part's page reached Review: link the card to the series, file it in the series folder, write its metadata. */
    onPageExported(project, card) {
      if (!project || !project.series || !card) return;
      const s = this.get(project.series.id);
      if (!s) return;
      const part = this.partOf(s, project.series.part);
      if (!part) return;
      part.cardId = card.id;
      part.status = 'review';
      part.exportedAt = Date.now();
      card.series = { id: s.id, part: part.n, name: s.name };
      card.format = 'sequence';
      if (s.folderId) card.galleryIds = [String(s.folderId)];
      if (!(card.metadata && card.metadata.titleWritten)) card.metadata = { ...(card.metadata || {}), ...this.metadataFor(s, part, card) };
      s.updatedAt = Date.now();
      if (window.State && State.persistLibrary) State.persistLibrary();
      this.persist();
    },

    refresh() {
      let changed = false;
      for (const s of this.data.series) {
        for (const p of s.parts) {
          const proj = window.Comics && Comics.get ? Comics.get(p.projectId) : null;
          const card = this.cardOf(p);
          let status = p.status;
          if (card) status = card.da && card.da.published ? 'posted' : card.status === 'drafted' ? 'uploaded' : card.status === 'discarded' || card.status === 'rejected' ? 'dropped' : 'review';
          else if (!proj) status = 'gone';
          else if (proj.run && proj.run.error && !proj.run.active) status = 'failed';
          else status = 'making';
          if (status !== p.status) { p.status = status; changed = true; }
        }
      }
      if (changed) this.persist();
      return changed;
    },

    status(id) {
      const s = this.get(id);
      if (!s) return null;
      return {
        id: s.id, name: s.name, folder: s.folderName || s.folderId || null, parts: s.parts.length,
        last: s.parts.length ? { n: s.parts[s.parts.length - 1].n, status: s.parts[s.parts.length - 1].status } : null,
      };
    },
  };

  window.Series = Series;
  window.SeriesPrompts = { parsePlan, lastJsonObject };
})();
