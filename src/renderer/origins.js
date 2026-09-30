/**
 * origins.js: "which prompt made this published artwork?"
 *
 * Recorded at upload time from the card as it was, so deleting the card later does
 * not lose the answer. Every entry states HOW it was matched: `upload` and `manual`
 * are facts, `title` is an exact normalised match, `probable` is a fuzzy match that
 * is shown clearly marked and never fed back into the learning loop.
 */
(function () {
  /** Same normalisation the title ledger uses, so "exact" means the same thing here. */
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  const PROBABLE_FLOOR = 0.62;

  const TIER_RANK = { manual: 4, upload: 3, title: 2, probable: 1, none: 0 };

  const Origins = {
    data: { entries: [], version: 1 },
    _byDev: new Map(),
    _guessCache: new Map(),

    async init() {
      const loaded = await window.ala.db.getOrigins().catch(() => null);
      this.data = loaded && Array.isArray(loaded.entries) ? loaded : { entries: [], version: 1 };
      this.reindex();
      this.watchLibrary();
      const added = this.backfill();
      if (added) {
        this.persist();
        State.addLog(`Prompt archive: ${added} published deviation(s) matched to the prompt that made them.`);
      }
    },

    reindex() {
      this._byDev = new Map(this.data.entries.map((e) => [String(e.deviationId), e]));
    },

    /**
     * The fuzzy-guess cache is keyed on a title and computed against the library, so the library
     * changing is the only thing that can invalidate it.
     */
    watchLibrary() {
      if (this._watching) return;
      this._watching = true;
      State.on('library', () => this._guessCache.clear());
    },

    persist() {
      window.ala.db.setOrigins(this.data);
      State.emit('origins', this.data);
    },

    /** Record what made a deviation. */
    record(card, { link = 'upload' } = {}) {
      const devId = String(card && card.da && card.da.deviationId || '');
      if (!devId) return null;
      const prev = this._byDev.get(devId) || null;
      const meta = card.metadata || {};
      const entry = {
        deviationId: devId,
        url: (card.da && card.da.url) || (prev && prev.url) || '',
        stashUrl: (card.da && card.da.stashUrl) || (prev && prev.stashUrl) || '',
        title: meta.title || (prev && prev.title) || '',
        prompt: card.prompt || (prev && prev.prompt) || '',
        theme: card.theme || (prev && prev.theme) || '',
        tags: (meta.tags && meta.tags.length ? meta.tags : (prev && prev.tags)) || [],
        description: meta.description || (prev && prev.description) || '',
        cardId: card.id || (prev && prev.cardId) || null,
        fname: card.fname || (prev && prev.fname) || '',
        promptSource: card.promptSource || (prev && prev.promptSource) || null,
        learnedFrom: card.learnedFrom || (prev && prev.learnedFrom) || null,
        continuationOf: card.continuationOf || (prev && prev.continuationOf) || null,
        qcScore: (card.qc && card.qc.score) ?? (prev && prev.qcScore) ?? null,
        destination: card.destination || (prev && prev.destination) || 'deviantart',
        upscaled: !!card.upscaled || !!(prev && prev.upscaled),
        publishedAt: (card.da && card.da.publishedAt) || (prev && prev.publishedAt) || null,
        recordedAt: (prev && prev.recordedAt) || Date.now(),
        updatedAt: Date.now(),
        link: TIER_RANK[link] >= TIER_RANK[(prev && prev.link) || 'none'] ? link : prev.link,
      };
      if (prev) Object.assign(prev, entry);
      else { this.data.entries.push(entry); this._byDev.set(devId, entry); }
      this.persist();
      return prev || entry;
    },

    /** Pin a deviation to a card by hand. */
    linkManually(deviationId, card) {
      const dev = (window.Insights && Insights.perf.deviations.find((d) => String(d.deviationId) === String(deviationId))) || null;
      const stub = {
        ...card,
        da: { ...(card.da || {}), deviationId: String(deviationId), url: (dev && dev.url) || (card.da && card.da.url) || '' },
      };
      const entry = this.record(stub, { link: 'manual' });
      if (entry && dev) {
        entry.title = entry.title || dev.title;
        entry.publishedAt = entry.publishedAt || dev.publishedAt;
        this.persist();
      }
      return entry;
    },

    /** Forget a hand-made link (or a wrong automatic one) without touching the card. */
    unlink(deviationId) {
      const id = String(deviationId);
      this.data.entries = this.data.entries.filter((e) => String(e.deviationId) !== id);
      this.reindex();
      this.persist();
    },

    /** Sweep the library and the synced gallery for entries that could exist but don't. */
    backfill() {
      const devs = (window.Insights && Insights.perf.deviations) || [];
      let added = 0;

      for (const c of State.library) {
        const devId = c.da && c.da.deviationId;
        if (!devId || !c.prompt) continue;
        const prev = this._byDev.get(String(devId));
        if (prev && TIER_RANK[prev.link] >= TIER_RANK.upload) continue;
        this.record(c, { link: 'upload' });
        added++;
      }

      const byTitle = new Map();
      for (const c of State.library) {
        const t = norm(c.metadata && c.metadata.title);
        if (t && c.prompt && !byTitle.has(t)) byTitle.set(t, c);
      }
      for (const d of devs) {
        if (this._byDev.has(String(d.deviationId))) continue;
        const card = byTitle.get(norm(d.title));
        if (!card) continue;
        this.record({ ...card, da: { ...(card.da || {}), deviationId: String(d.deviationId), url: d.url } }, { link: 'title' });
        added++;
      }
      return added;
    },

    /** The stored entry for a deviation, if there is one. */
    get(deviationId) {
      return this._byDev.get(String(deviationId)) || null;
    },

    /** `guess: false` skips the fuzzy fallback and returns `candidate: null`. */
    resolve(dev, { guess = true } = {}) {
      const devId = String(dev && dev.deviationId || dev || '');
      const entry = this.get(devId);
      const card = entry && entry.cardId ? State.library.find((c) => c.id === entry.cardId) : null;

      if (entry && entry.prompt) {
        return {
          link: entry.link, confidence: entry.link === 'probable' ? 0.7 : 1,
          prompt: entry.prompt, title: entry.title, theme: entry.theme,
          tags: entry.tags || [], entry, card, candidate: null,
          fname: entry.fname || (card && card.fname) || '',
        };
      }

      const devTitle = (dev && dev.title) || (entry && entry.title) || '';
      const candidate = guess ? this.bestGuess(devTitle) : null;
      return {
        link: 'none', confidence: candidate ? candidate.score : 0,
        prompt: '', title: devTitle, theme: '', tags: [],
        entry, card: null, candidate,
        fname: '',
      };
    },

    /** The library card whose title is closest to this one, if anything is close enough. */
    bestGuess(title) {
      const t = String(title || '').trim();
      if (!t || !window.Titles) return null;
      const memo = this._guessCache.get(t);
      if (memo !== undefined) return memo;
      let best = null;
      for (const c of State.library) {
        const ct = c.metadata && c.metadata.title;
        if (!ct || !c.prompt) continue;
        const score = window.Titles.similarity(t, ct);
        if (score >= PROBABLE_FLOOR && (!best || score > best.score)) best = { card: c, score };
      }
      this._guessCache.set(t, best);
      return best;
    },

    /** Free-text search across the archive AND the synced gallery. */
    search(query, { limit = 40 } = {}) {
      const q = norm(query);
      const devs = (window.Insights && Insights.perf.deviations) || [];
      const withGuesses = (list) => list.map((row) => ({ ...row, res: this.resolve(row.dev) }));
      const rows = devs.map((d) => ({ dev: d, res: this.resolve(d, { guess: false }) }));
      if (!q) {
        return withGuesses(rows
          .sort((a, b) => (b.dev.publishedAt || 0) - (a.dev.publishedAt || 0))
          .slice(0, limit));
      }
      const terms = q.split(' ').filter(Boolean);
      const ranked = rows
        .map((row) => {
          const hay = norm([
            row.dev.title, row.res.prompt, row.res.theme,
            (row.res.tags || []).join(' '), (row.dev.tags || []).join(' '),
          ].join(' '));
          const hits = terms.filter((t) => hay.includes(t)).length;
          if (hits < terms.length) return null;
          const inTitle = terms.filter((t) => norm(row.dev.title).includes(t)).length;
          return { ...row, rank: inTitle * 10 + hits };
        })
        .filter(Boolean)
        .sort((a, b) => b.rank - a.rank || (b.dev.publishedAt || 0) - (a.dev.publishedAt || 0))
        .slice(0, limit);
      return withGuesses(ranked);
    },

    /** Coverage, for the panel header: how much of the gallery can answer the question. */
    coverage() {
      const devs = (window.Insights && Insights.perf.deviations) || [];
      const known = devs.filter((d) => {
        const e = this.get(d.deviationId);
        return e && e.prompt;
      }).length;
      return { total: devs.length, known, missing: Math.max(0, devs.length - known) };
    },
  };

  window.Origins = Origins;
})();
