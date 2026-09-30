/**
 * insights.js: measurement and learning.
 *
 * Answers three questions, each built on the last:
 *   1. What happened?  perf.json: real engagement per published artwork, joined
 *                      back to the prompt and settings that produced it.
 *   2. What does it imply?  breakdowns(): lift per theme / tag / prompt trait /
 *                      posting hour / quality band; median-based, and a group
 *                      needs enough samples before it counts.
 *   3. What should we do?  buildPlaybook(): the numbers plus short lessons written
 *                      by an LLM, turned by guidance() into a block that the
 *                      prompt writers read.
 * Before anything is published, the artist's own approve/reject decisions and the
 * quality scores act as the learning signal.
 */
(function () {
  const DAY = 86400000;

  const STOP = new Set(`a an the and or but of in on at to for with from by as is are was were
    be been being this that these those it its her his their they she he you your my our
    very highly extremely detailed quality masterpiece best ultra super image picture photo
    style art artwork render rendering shot view generated ai anime girl one two three
    while during over under into onto about around near up down out off then than so if
    who whom which what when where how all any both each few more most other some such
    no nor not only own same too s t can will just don should now`.split(/\s+/).filter(Boolean));

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const median = (xs) => {
    if (!xs.length) return 0;
    const a = [...xs].sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const round2 = (n) => Math.round(n * 100) / 100;
  const DEFAULT_WEIGHTS = { views: 0.2, favourites: 10, comments: 25, downloads: 4 };
  const counter = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;

  /** Pull a raw lift toward 1 in proportion to how little evidence stands behind it. */
  function shrink(raw, n, k = 6, cap = 4) {
    if (!Number.isFinite(raw) || !Number.isFinite(n) || n <= 0) return 1;
    const kk = Number.isFinite(k) ? Math.max(0, k) : 6;
    const cc = Number.isFinite(cap) && cap > 1 ? cap : 4;
    const pulled = 1 + (raw - 1) * (n / (n + kk));
    return Math.max(1 / cc, Math.min(cc, pulled));
  }

  /** Real age in days, floored at an hour — NOT the metric's 3-day divisor floor. */
  const trueAgeDays = (d) => Math.max(1 / 24, (Date.now() - (d.publishedAt || d.firstSeenAt || Date.now())) / DAY);

  const THEME_STOP = new Set(`a an the and or but of in on at to for with from by as is are was were be
    this that it its her his their she he very high detail detailed quality style anime girl girls
    woman women man men boy boys scene scenes image images art character characters portrait
    portraits color colors colour colours vibrant`.split(/\s+/).filter(Boolean));
  const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const themeStem = (w) => w.replace(/(?:ations?|ings?|ers?|ies|es|ed|s|y)$/, '').replace(/(.)\1$/, '$1');
  function themeStems(text) {
    return new Set(norm(plain(text)).split(' ')
      .filter((w) => w.length > 2 && !THEME_STOP.has(w))
      .map(themeStem)
      .filter((w) => w.length > 2));
  }
  function onTheme(theme, rec) {
    const t = norm(plain(theme));
    if (!t) return true;
    if (norm(plain(rec && rec.theme)) === t) return true;
    const want = themeStems(theme);
    if (!want.size) return true;
    const have = themeStems(`${(rec && rec.theme) || ''} ${(rec && rec.prompt) || ''}`);
    let hit = 0;
    for (const w of want) if (have.has(w)) hit++;
    return hit / want.size >= 0.5;
  }

  const Insights = {
    perf: { deviations: [], lastSyncAt: null, username: '' },
    playbook: null,
    syncing: false,

    get cfg() { return (State.settings && State.settings.learn) || {}; },

    async init() {
      this.perf = (await window.ala.db.getPerf()) || this.perf;
      this.perf.deviations = this.perf.deviations || [];
      this.playbook = await window.ala.db.getPlaybook();
      this.relink();
    },

    persistPerf() { window.ala.db.setPerf(this.perf); State.emit('perf', this.perf); },
    persistPlaybook() { window.ala.db.setPlaybook(this.playbook); State.emit('playbook', this.playbook); },

    /** Pull the published gallery and merge it into perf, preserving per-deviation history. */
    async sync({ withViews = true, quiet = false, limit = 0 } = {}) {
      if (this.syncing) return { ok: false, error: 'a sync is already running' };
      this.syncing = true;
      State.emit('perfSync', { running: true, phase: 'starting' });
      try {
        const res = await window.ala.dastats.sync({
          withViews,
          maxViewFetches: limit ? Math.min(limit, this.cfg.maxViewFetches || 400) : (this.cfg.maxViewFetches || 400),
          maxDeviations: limit,
        });
        if (!res.ok) {
          if (!quiet) State.addLog(`DeviantArt stats sync failed: ${res.error}`, 'err');
          return res;
        }
        const now = Date.now();
        const byId = new Map(this.perf.deviations.map((d) => [d.deviationId, d]));
        let added = 0;
        for (const fresh of res.items) {
          const prev = byId.get(fresh.deviationId);
          if (!prev) {
            byId.set(fresh.deviationId, {
              ...fresh,
              firstSeenAt: now,
              history: [{ at: now, ...fresh.stats }],
              note: null, cardId: null,
            });
            added++;
            continue;
          }
          const last = prev.history && prev.history[prev.history.length - 1];
          const moved = !last
            || last.views !== fresh.stats.views
            || last.favourites !== fresh.stats.favourites
            || last.comments !== fresh.stats.comments;
          if (moved || !last || now - last.at > DAY) {
            prev.history = [...(prev.history || []), { at: now, ...fresh.stats }].slice(-60);
          }
          Object.assign(prev, {
            title: fresh.title, url: fresh.url || prev.url,
            publishedAt: fresh.publishedAt || prev.publishedAt,
            thumb: fresh.thumb || prev.thumb,
            isMature: fresh.isMature, isAiGenerated: fresh.isAiGenerated,
            tags: fresh.tags.length ? fresh.tags : prev.tags,
            stats: { ...prev.stats, ...fresh.stats },
          });
        }
        this.perf.deviations = [...byId.values()];
        this.perf.lastSyncAt = now;
        this.perf.username = res.username || this.perf.username;
        this.relink();
        this.persistPerf();
        if (!quiet) {
          State.addLog(`DeviantArt stats: ${res.items.length} deviation(s) read`
            + `${res.partial ? ' (newest only — this was a capped sync)' : ''}`
            + `${added ? `, ${added} new` : ''}`
            + `${res.viewsFetched ? `, views for ${res.viewsFetched}` : ' (no view counts — favourites/comments only)'}.`, 'ok');
        }
        return { ...res, added };
      } finally {
        this.syncing = false;
        State.emit('perfSync', { running: false });
      }
    },

    /** Join deviations back to the local cards that made them. */
    relink() {
      const byDevId = new Map();
      const byTitle = new Map();
      const add = (map, key, card) => {
        if (key) map.set(key, map.has(key) ? null : card);
      };
      for (const c of State.library) {
        if (c.da && c.da.deviationId != null) add(byDevId, String(c.da.deviationId), c);
        add(byTitle, norm(c.metadata && c.metadata.title), c);
      }
      let linked = 0;
      for (const d of this.perf.deviations) {
        const id = String(d.deviationId ?? '');
        const exact = byDevId.has(id);
        const title = norm(d.title);
        const candidate = exact ? byDevId.get(id) : byTitle.get(title);
        const conflict = candidate && !exact && candidate.da && candidate.da.deviationId != null
          && String(candidate.da.deviationId) !== id;
        const ambiguous = (exact && !candidate) || (!exact && byTitle.has(title) && !candidate) || conflict;
        if (ambiguous) {
          Object.assign(d, { cardId: null, prompt: '', theme: '', qcScore: null,
            promptSource: null, upscaled: false, linkMethod: 'ambiguous' });
          continue;
        }
        const card = candidate;
        if (!card) continue;
        linked++;
        d.linkMethod = exact ? 'id' : 'title';
        d.cardId = card.id;
        d.theme = card.theme || d.theme || '';
        d.prompt = card.prompt || d.prompt || '';
        d.qcScore = (card.qc && card.qc.score) ?? d.qcScore ?? null;
        d.upscaled = !!card.upscaled;
        d.promptSource = card.promptSource || d.promptSource || null;
        if (!d.tags || !d.tags.length) d.tags = (card.metadata && card.metadata.tags) || [];
      }
      return linked;
    },

    /** Engagement, normalised for how long the piece has been up. */
    metric(d, basis = null) {
      const w = { ...DEFAULT_WEIGHTS, ...this.cfg.weights };
      const s = d.stats || {};
      const views = counter(s.views);
      const favs = counter(s.favourites);
      const comments = counter(s.comments);
      const downloads = counter(s.downloads);
      const observed = Object.keys(DEFAULT_WEIGHTS).filter((k) => counter(s[k]) != null
        && Number.isFinite(w[k]) && w[k] > 0 && (!basis || basis.includes(k)));
      const engagement = observed.length ? observed.reduce((sum, k) => sum + s[k] * w[k], 0) : null;
      const floor = Math.max(0.5, Number(this.cfg.minAgeDays) || 3);
      const ageDays = Math.max(floor, (Date.now() - (d.publishedAt || d.firstSeenAt || Date.now())) / DAY);
      return {
        engagement,
        perDay: engagement == null ? null : engagement / ageDays,
        ageDays,
        observed,
        favRate: views > 0 && favs != null ? favs / views : null,
        views, favs, comments, downloads,
      };
    },

    /** Recent velocity from the history trail: engagement gained per day since last sync. */
    velocity(d) {
      const h = d.history || [];
      if (h.length < 2) return null;
      const a = h[h.length - 2], b = h[h.length - 1];
      if (!Number.isFinite(a.at) || !Number.isFinite(b.at) || b.at <= a.at) return null;
      const days = Math.max(0.25, (b.at - a.at) / DAY);
      const w = { ...DEFAULT_WEIGHTS, ...this.cfg.weights };
      let delta = 0, observed = 0;
      for (const k of Object.keys(DEFAULT_WEIGHTS)) {
        if (!Number.isFinite(w[k]) || w[k] <= 0) continue;
        const x = counter(a[k]), y = counter(b[k]);
        if (x == null && y == null) continue;
        if (x == null || y == null || y < x) return null;
        observed++;
        delta += (y - x) * w[k];
      }
      return observed ? delta / days : null;
    },

    /** The best picture to show for a deviation, and where to get it. */
    thumb(dev) {
      if (!dev) return '';
      const local = window.Origins ? (Origins.resolve(dev, { guess: false }).fname || '') : '';
      if (local) return `ala://img/${local}`;
      return String(dev.thumb || '').replace(/\.(jpg|jpeg|png|gif|webp)\/\/+/i, '.$1/');
    },

    /** Everything published, scored and ranked. */
    scored() {
      return this.perf.deviations
        .filter((d) => !d.isDeleted)
        .map((d) => ({ d, m: this.metric(d) }))
        .sort((x, y) => (y.m.perDay ?? -Infinity) - (x.m.perDay ?? -Infinity));
    },

    /** Compare only counters actually observed for every candidate; unknown is not zero. */
    measured() {
      const rows = this.scored().filter(({ m }) => m.perDay != null);
      const basis = Object.keys(DEFAULT_WEIGHTS).filter((k) => rows.length && rows.every(({ m }) => m.observed.includes(k)));
      if (!basis.length) return [];
      return rows.map(({ d }) => ({ d, m: this.metric(d, basis) }))
        .sort((x, y) => y.m.perDay - x.m.perDay);
    },

    /** How each published piece did against the pieces published closest to it in time. */
    peerScores(rows = null) {
      const list = rows || this.measured();
      const out = new Map();
      if (!list.length) return out;
      const eng = (r) => Math.max(0, Number(r.m.engagement) || 0);
      const n = list.length;
      if (n < 12) {
        const med = median(list.map(eng));
        for (const r of list) out.set(String(r.d.deviationId), { vsPeers: (eng(r) + 1) / (med + 1), peers: n });
        return out;
      }
      const want = Math.round(Number(this.cfg.peerWindow) || 30);
      const K = Math.min(n, Math.max(8, Math.min(want, Math.round(n / 3))));
      const byAge = list.map((r) => ({ r, la: Math.log(trueAgeDays(r.d)), e: eng(r) }))
        .sort((a, b) => a.la - b.la);
      for (let i = 0; i < n; i++) {
        let lo = i, hi = i;
        while (hi - lo + 1 < K) {
          const left = lo > 0 ? byAge[i].la - byAge[lo - 1].la : Infinity;
          const right = hi < n - 1 ? byAge[hi + 1].la - byAge[i].la : Infinity;
          if (left <= right) lo--; else hi++;
        }
        const med = median(byAge.slice(lo, hi + 1).map((x) => x.e));
        out.set(String(byAge[i].r.d.deviationId), { vsPeers: (byAge[i].e + 1) / (med + 1), peers: hi - lo + 1 });
      }
      return out;
    },

    /** Posts younger than this have not settled; they are measured, but never a model to copy. */
    minExemplarAgeDays() {
      const v = Number(this.cfg.minExemplarAgeDays);
      return Number.isFinite(v) && v >= 0 ? v : 2;
    },

    /** Everything measured, with `m.vsPeers` attached, best first by that. */
    ranked({ eligibleOnly = false } = {}) {
      const rows = this.measured();
      const peer = this.peerScores(rows);
      const minAge = this.minExemplarAgeDays();
      return rows
        .map(({ d, m }) => ({ d, m: { ...m, vsPeers: (peer.get(String(d.deviationId)) || {}).vsPeers ?? null } }))
        .filter(({ d, m }) => m.vsPeers != null && (!eligibleOnly || trueAgeDays(d) >= minAge))
        .sort((x, y) => y.m.vsPeers - x.m.vsPeers);
    },

    overview() {
      const all = this.scored();
      const totals = all.reduce((acc, { m }) => {
        acc.views += m.views; acc.favs += m.favs; acc.comments += m.comments;
        return acc;
      }, { views: 0, favs: 0, comments: 0 });
      const perDays = this.measured().map(({ m }) => m.perDay);
      const favRates = all.map(({ m }) => m.favRate).filter((x) => x != null);
      const linked = all.filter(({ d }) => d.cardId).length;
      const withViews = all.filter(({ m }) => m.views != null).length;
      const withFavs = all.filter(({ m }) => m.favs != null).length;
      return {
        count: all.length,
        linked,
        withViews,
        ...totals,
        avgViews: withViews ? Math.round(totals.views / withViews) : null,
        avgFavs: withFavs ? round2(totals.favs / withFavs) : null,
        medianPerDay: round2(median(perDays)),
        medianFavRate: favRates.length ? median(favRates) : null,
        lastSyncAt: this.perf.lastSyncAt,
        username: this.perf.username,
      };
    },

    /** Lift for one grouping. */
    _lift(rows, keysOf, { minSamples = null, limit = 12 } = {}) {
      const min = minSamples ?? (this.cfg.minSamples || 3);
      const base = median(rows.map((r) => r.value));
      if (!base) return [];
      const groups = new Map();
      for (const r of rows) {
        for (const key of new Set(keysOf(r) || [])) {
          if (!key) continue;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(r);
        }
      }
      const k = Math.max(0, Number.isFinite(Number(this.cfg.shrink)) ? Number(this.cfg.shrink) : 6);
      const cap = Math.max(1.5, Number(this.cfg.maxLift) || 4);
      const out = [];
      for (const [key, members] of groups) {
        if (members.length < min) continue;
        const med = median(members.map((r) => r.value));
        const raw = med / base;
        out.push({
          key,
          n: members.length,
          median: round2(med),
          rawLift: round2(raw),
          lift: round2(shrink(raw, members.length, k, cap)),
          best: members.slice().sort((a, b) => b.value - a.value)[0]?.label || '',
        });
      }
      return out.sort((a, b) => b.lift - a.lift).slice(0, limit);
    },

    /** Prompt/title feature extraction: unigrams plus adjacent bigrams, stopwords dropped. */
    _features(text) {
      const words = norm(text).split(' ').filter((w) => w.length > 2 && !STOP.has(w));
      const out = new Set(words);
      for (let i = 0; i < words.length - 1; i++) out.add(`${words[i]} ${words[i + 1]}`);
      return [...out];
    },

    /** The full analysis. */
    breakdowns() {
      const min = this.cfg.minSamples || 3;
      const measured = this.ranked();
      const daRows = measured.map(({ d, m }) => ({
        d, value: m.vsPeers, label: d.title,
        theme: d.theme || '', tags: d.tags || [], prompt: d.prompt || '',
        title: d.title || '', qc: d.qcScore, at: d.publishedAt, mature: d.isMature,
      }));

      const useDa = daRows.length >= min * 2;
      const rows = useDa ? daRows : this._localRows();
      const source = daRows.length >= min * 2 ? 'deviantart' : (rows.length ? 'local' : 'none');

      return {
        source,
        sampleSize: rows.length,
        daCount: daRows.length,
        metricBasis: measured[0]?.m.observed || [],
        themes: this._lift(rows, (r) => [r.theme && r.theme.trim().toLowerCase()]),
        tags: this._lift(rows, (r) => r.tags),
        promptTraits: this._lift(rows, (r) => this._features(r.prompt), { minSamples: Math.max(min, 3), limit: 14 }),
        titleTraits: this._lift(rows, (r) => titleTraits(r.title), { limit: 8 }),
        timing: useDa ? this._lift(rows, (r) => timingKeys(r.at), { limit: 8 }) : [],
        qcBands: this._lift(rows, (r) => (r.qc == null ? [] : [qcBand(r.qc)]), { minSamples: 2, limit: 4 }),
      };
    },

    /** The day-one signal: the artist's own decisions. */
    _localRows() {
      const YES = new Set(['approved', 'drafted', 'upload_failed']);
      const NO = new Set(['rejected', 'discarded']);
      return State.library
        .filter((c) => YES.has(c.status) || NO.has(c.status))
        .map((c) => ({
          d: null,
          value: YES.has(c.status) ? 1 : 0,
          label: (c.metadata && c.metadata.title) || c.fname,
          theme: c.theme || '',
          tags: (c.metadata && c.metadata.tags) || [],
          prompt: c.prompt || '',
          title: (c.metadata && c.metadata.title) || '',
          qc: (c.qc && c.qc.score) ?? null,
          at: c.createdAt,
          mature: c.mature !== undefined ? !!c.mature : !!State.settings.metadata.mature,
        }));
    },

    topPerformers(n = 10) { return this.ranked({ eligibleOnly: true }).slice(0, n); },
    worstPerformers(n = 10) { return this.ranked({ eligibleOnly: true }).slice(-n).reverse(); },

    /** Winners to grow ONE theme's next prompts from, best first. */
    recipesFor({ theme = '', limit = 8 } = {}) {
      const live = this.ranked({ eligibleOnly: true })
        .filter(({ d, m }) => d.prompt && m.engagement > 0)
        .map(({ d, m }) => recipeOf(d, m));
      const saved = ((this.playbook && this.playbook.recipes) || []).filter((r) => r && r.prompt);
      const sim = window.promptSimilarity;
      const seen = new Set();
      const out = [];
      for (const r of [...live, ...saved]) {
        const id = String(r.from ?? r.title);
        if (seen.has(id)) continue;
        seen.add(id);
        if (!onTheme(theme, r)) continue;
        if (sim && out.some((o) => sim(o.prompt, r.prompt) > 0.6)) continue;
        out.push(r);
        if (out.length >= limit) break;
      }
      return out;
    },

    onTheme,

    /**
     * Build the playbook: the statistics, plus an LLM pass that turns them into instructions a
     * prompt writer can actually follow.
     */
    async buildPlaybook({ useLlm = null, log = () => {} } = {}) {
      const b = this.breakdowns();
      const wantLlm = useLlm == null ? this.cfg.useLlmLessons !== false : useLlm;

      const top = this.topPerformers(8).filter(({ m }) => m.engagement > 0);
      const bottom = b.source === 'deviantart' ? this.worstPerformers(6) : [];

      const playbook = {
        updatedAt: Date.now(),
        source: b.source,
        sampleSize: b.sampleSize,
        daCount: b.daCount,
        metricBasis: b.metricBasis,
        themes: b.themes,
        tags: b.tags,
        promptTraits: b.promptTraits,
        titleTraits: b.titleTraits,
        timing: b.timing,
        qcBands: b.qcBands,
        mature: b.mature,
        exemplars: top.map(({ d, m }) => ({
          deviationId: d.deviationId,
          title: d.title,
          url: d.url,
          theme: d.theme || '',
          prompt: d.prompt || '',
          tags: (d.tags || []).slice(0, 12),
          perDay: round2(m.perDay),
          vsPeers: round2(m.vsPeers),
          favRate: m.favRate == null ? null : round2(m.favRate * 100),
          views: m.views, favs: m.favs, comments: m.comments,
          note: d.note || null,
        })),
        lessons: this.playbook && this.playbook.source === b.source && b.source !== 'none'
          ? (this.playbook.lessons || []) : [],
        recipes: [],
        summary: '',
        manual: (this.playbook && this.playbook.manual) || (window.Teach ? Teach._blank() : null),
        rotation: (this.playbook && this.playbook.rotation) || { round: 0, seeds: {}, modes: [] },
      };

      if (b.source === 'none') {
        playbook.summary = 'Nothing measured yet. Publish some deviations and sync, or approve/reject a few cards — either gives the learning loop something to work from.';
        this.playbook = playbook;
        this.persistPlaybook();
        return playbook;
      }

      playbook.summary = statSummary(playbook);

      if (wantLlm && (top.length >= 2 || b.promptTraits.length)) {
        try {
          log('Asking the model what the winners have in common…');
          const lessons = await this._askLessons(playbook, top, bottom);
          const kept = window.Teach ? Teach.filterDerived(lessons) : lessons;
          playbook.lessons = (kept || []).slice(0, this.cfg.maxLessons || 8);
        } catch (e) {
          log(`Lesson extraction failed (${e.message}) — keeping the statistical playbook.`, 'err');
        }
      }

      const perTheme = new Map();
      playbook.recipes = this.ranked({ eligibleOnly: true })
        .filter(({ d, m }) => d.prompt && m.engagement > 0)
        .filter(({ d }) => {
          const k = norm(d.theme) || '(none)';
          const n = perTheme.get(k) || 0;
          if (n >= 2) return false;
          perTheme.set(k, n + 1);
          return true;
        })
        .slice(0, 8)
        .map(({ d, m }) => recipeOf(d, m));

      this.playbook = playbook;
      this.persistPlaybook();
      return playbook;
    },

    async _askLessons(playbook, top, bottom) {
      const fmt = ({ d, m }) => [
        `title: ${d.title}`,
        d.theme ? `theme: ${d.theme}` : null,
        `${m.vsPeers != null ? `${round2(m.vsPeers)}× a typical post of the same age` : `engagement/day: ${round2(m.perDay)}`}${m.views ? ` (${m.views} views, ${m.favs} favs, ${m.comments} comments` : ` (${m.favs} favs, ${m.comments} comments`} over ${Math.round(trueAgeDays(d))} days)`,
        (d.tags || []).length ? `tags: ${(d.tags || []).slice(0, 10).join(', ')}` : null,
        d.prompt ? `prompt: ${String(d.prompt).slice(0, 420)}` : null,
      ].filter(Boolean).join('\n');

      const statLines = [
        ...playbook.themes.slice(0, 5).map((t) => `theme "${t.key}" — ${t.lift}× the median over ${t.n} posts`),
        ...playbook.tags.slice(0, 8).map((t) => `tag #${t.key} — ${t.lift}× over ${t.n} posts`),
        ...playbook.promptTraits.slice(0, 10).map((t) => `prompt contains "${t.key}" — ${t.lift}× over ${t.n} posts`),
      ].join('\n');

      const signalNote = playbook.source === 'deviantart'
        ? `The numbers below are real DeviantArt engagement, using only shared observed counters: ${(playbook.metricBasis || []).join(', ') || 'legacy basis'}. Each piece is compared with the posts published closest to it in time, so a week-old piece and a year-old piece are judged on the same footing — "2×" means twice what a typical post of that age earned.`
        : 'NOTE: published evidence is insufficient. These are local workflow outcomes, mixing keep/reject actions with automated QC discards. They are not verified human preferences or audience demand. Write the lessons accordingly.';

      const prompt = `You analyse performance data for an anime-style AI art account and write down what to repeat.

${signalNote}

MEASURED CORRELATIONS (median-based, sample-gated):
${statLines || '(too few samples for reliable correlations)'}

BEST PERFORMERS:
${top.map(fmt).join('\n---\n')}
${bottom.length ? `\nWORST PERFORMERS:\n${bottom.map(fmt).join('\n---\n')}` : ''}

Write up to ${this.cfg.maxLessons || 8} lessons. Hard requirements:
- Each lesson must be a CONCRETE, REPEATABLE instruction for writing the next image prompt or its metadata — something like "frame at three-quarter length with the face fully in shot" or "warm practical light sources beat flat studio lighting", not "post good art" or "engage the audience".
- Ground each one in the data above. If a lesson only holds for one deviation, say so in "confidence".
- Prefer lessons about the IMAGE (subject, framing, lighting, pose, wardrobe, setting, colour) over lessons about posting mechanics.
- Do not invent numbers. Do not repeat the same idea twice.
- These are observational associations, NOT causal effects or conversion measurements. Age cohorts and shrinkage do not control exposure, posting date, theme, model/rubric changes, or selection bias. Treat proposed changes as hypotheses; report weak evidence when confounded.
- CRITICAL — write PRINCIPLES, not phrases to paste. Never instruct that a prompt should
  start with, contain, or quote specific wording from the examples above. "Open with 'a
  knight in red armour'" is forbidden; "the outfit should be ordinary streetwear rather
  than costume" is the same observation stated as something reusable. A lesson that can
  only be followed by copying words from a winning prompt is a lesson that makes every
  future image a copy of that one, and it will be rejected.
- Each lesson must leave the SCENE open. If following all your lessons at once could only
  produce one picture, they are too tight — say what has to be true about the image, not
  what the image has to be.

Respond ONLY with a JSON array:
[{"lesson": "the instruction", "why": "what in the data supports it", "confidence": "high"|"medium"|"low"}]`;

      const { text } = await U.llmChat(
        [{ role: 'user', content: prompt }],
        { temperature: 0.6, maxTokens: 6000, role: 'metadata' }, 'Writing the playbook lessons');
      const raw = U.extractJson(text);
      const list = Array.isArray(raw) ? raw : (raw.lessons || []);
      return list
        .map((x) => ({
          lesson: String((x && x.lesson) || '').trim(),
          why: String((x && x.why) || '').trim(),
          confidence: String((x && x.confidence) || 'medium').toLowerCase(),
        }))
        .filter((x) => x.lesson);
    },

    /** Write down why ONE deviation did well, and keep it on the record. */
    async explain(dev) {
      const m = this.metric(dev);
      const all = this.ranked();
      const idx = all.findIndex(({ d }) => d.deviationId === dev.deviationId);
      const vs = idx >= 0 ? all[idx].m.vsPeers : null;
      const rankLine = idx >= 0
        ? `rank: #${idx + 1} of ${all.length} against posts of the same age (${round2(vs)}× what a typical post of its age earned)`
        : `rank: unranked (${this.perf.deviations.length} deviations on file)`;
      const prompt = `A deviation on an anime-style AI art account is outperforming the artist's median.

title: ${dev.title}
${dev.theme ? `theme: ${dev.theme}\n` : ''}${rankLine}
numbers: ${m.views ? `${m.views} views, ` : ''}${m.favs} favourites, ${m.comments} comments over ${Math.round(trueAgeDays(dev))} day(s)${m.favRate != null ? ` — ${round2(m.favRate * 100)}% of viewers favourited it` : ''}
tags: ${(dev.tags || []).join(', ') || '(none recorded)'}
${dev.prompt ? `generation prompt:\n"""${String(dev.prompt).slice(0, 700)}"""` : '(the generation prompt for this one was not recorded)'}

In 2-3 sentences say what about THIS piece most plausibly drove the result — subject, framing, lighting, mood, wardrobe, or tagging — and name the one element most worth reusing. Be specific and concrete. No preamble.`;
      const { text } = await U.llmChat(
        [{ role: 'user', content: prompt }],
        { temperature: 0.6, maxTokens: 1200, role: 'metadata' }, 'Explaining a top performer');
      const note = String(text || '').trim().slice(0, 700);
      if (note) {
        dev.note = note;
        dev.noteAt = Date.now();
        this.persistPerf();
      }
      return note;
    },

    /** Winners that have not been explained yet. */
    unexplainedWinners(limit = 3) {
      const all = this.ranked({ eligibleOnly: true });
      if (all.length < 4) return [];
      return all
        .filter(({ d, m }) => !d.note && m.vsPeers >= 1.5 && m.engagement > 0)
        .slice(0, limit)
        .map(({ d }) => d);
    },

    /** The block that gets pasted into ideation and metadata prompts. */
    guidance({ theme = '', maxChars = 1800, mode = 'exploit', axes = null } = {}) {
      const p = this.playbook;
      const V = window.Variety;
      const own = window.Teach ? Teach.block({ hard: mode === 'wild' }) : '';
      const lines = [];

      const finish = () => {
        const prefix = own ? own + '\n\n' : '';
        const derived = lines.join('\n');
        const room = Math.max(0, maxChars - prefix.length);
        return prefix + (derived.length > room ? (room > 1 ? derived.slice(0, room - 1) + '…' : '') : derived);
      };

      const stale = V ? V.stalePhrases() : [];

      if (mode === 'wild') {
        lines.push('THIS IS A WILDCARD ROUND. Deliberately ignore what has performed well before.',
          'The account has been converging on a narrow set of ideas; this round exists to go somewhere it has not been.',
          'Invent scenes that would not have been chosen by looking at past performance. Take a real swing.');
        if (stale.length) lines.push('', V.staleBlock(stale));
        if (axes && axes.length && V) lines.push('', V.axesBlock(axes));
        return finish();
      }

      if (!p || p.source === 'none' || !this.cfg.enabled) {
        return own;
      }

      const head = p.source === 'deviantart'
        ? `WHAT PERFORMS BEST for this artist — measured on ${p.daCount} published deviation(s):`
        : `LOCAL WORKFLOW OUTCOMES — ${p.sampleSize} keep/reject records, including automated QC discards. Not verified human preferences or audience demand:`;
      lines.push(head);

      const boost = (window.Teach ? Teach.manual().boost : { themes: {}, tags: {} }) || { themes: {}, tags: {} };
      const muteMul = (bucket, key) => {
        const v = bucket[norm(key)];
        return Number.isFinite(v) ? v : 1;
      };
      const up = (arr, fmt, bucket) => arr
        .filter((x) => x.lift * (bucket ? muteMul(bucket, x.key) : 1) >= 1.15)
        .slice(0, 5).map(fmt);
      const down = (arr, fmt) => arr.filter((x) => x.lift <= 0.8).slice(-3).map(fmt);

      const goodThemes = up(p.themes, (t) => `"${t.key}" (${t.lift}×, ${t.n})`, boost.themes);
      if (goodThemes.length) lines.push(`- Themes that outperform: ${goodThemes.join(', ')}`);
      const badThemes = down(p.themes, (t) => `"${t.key}" (${t.lift}×)`);
      if (badThemes.length) lines.push(`- Themes that underperform: ${badThemes.join(', ')}`);

      const triaged = V ? V.triage(p.promptTraits || []) : { keep: (p.promptTraits || []).slice(0, 5), overused: [] };

      if (mode !== 'explore') {
        const goodTraits = triaged.keep.filter((t) => t.lift >= 1.15).map((t) => `"${t.key}" (${t.lift}×)`);
        if (goodTraits.length) lines.push(`- Prompt elements correlated with success: ${goodTraits.join(', ')}`);
      }
      const badTraits = down(p.promptTraits || [], (t) => `"${t.key}"`);
      if (badTraits.length) lines.push(`- Prompt elements correlated with weak results: ${badTraits.join(', ')}`);

      if (triaged.overused.length) {
        lines.push(`- WORN OUT — these appear in most of what this account has made lately, so they no longer read as a choice. Do NOT use them this round: ${triaged.overused.map((t) => `"${t.key}"`).join(', ')}`);
      }
      if (stale.length) lines.push(V.staleBlock(stale));

      const goodTags = up(p.tags || [], (t) => `#${t.key}`, boost.tags);
      if (goodTags.length) lines.push(`- Tags that travel well: ${goodTags.join(' ')}`);

      if ((p.lessons || []).length) {
        const shown = (p.lessons || []).filter((l) => !(window.Teach && Teach.isMuted(l.lesson))).slice(0, 6);
        if (shown.length) {
          lines.push('- Lessons learned from the best performers:');
          for (const l of shown) {
            lines.push(`  · ${l.lesson}${l.confidence === 'low' ? ' (weak evidence)' : ''}`);
          }
        }
      }

      if (mode !== 'explore') {
        const pool = (p.exemplars || []).filter((e) => e.prompt);
        const themed = theme ? pool.filter((e) => norm(e.theme) === norm(theme)) : [];
        const ex = V
          ? V.pickSeed((themed.length ? themed : pool).map((e) => ({ ...e, from: e.deviationId })), { theme })
          : (themed[0] || pool[0]);
        if (ex && ex.prompt) {
          lines.push(`- A prompt that performed well${ex.theme ? ` (theme "${ex.theme}")` : ''}. Copy only its LEVEL OF DETAIL — how concretely it names light, framing and setting. The subject, location, wardrobe, mood and composition of your prompts must all be different from it:\n  """${String(ex.prompt).slice(0, 380)}"""`);
        }
      }

      if (mode === 'explore') {
        lines.push('- This is an EXPLORE round: the winning prompts have been deliberately withheld. Apply the lessons above as principles and build genuinely new scenes from them.');
      }

      if (axes && axes.length && V) lines.push('', V.axesBlock(axes));

      lines.push('Use this as direction, not as a template. Every prompt must still be a new scene.');
      return finish();
    },

    /** Tags with measured lift, for the metadata writer to prioritise. */
    preferredTags(n = 8) {
      const p = this.playbook;
      if (!p || !this.cfg.enabled) return [];
      const boost = (window.Teach ? Teach.manual().boost.tags : {}) || {};
      return (p.tags || [])
        .map((t) => ({ ...t, eff: t.lift * (Number.isFinite(boost[norm(t.key)]) ? boost[norm(t.key)] : 1) }))
        .filter((t) => t.eff >= 1.15)
        .sort((a, b) => b.eff - a.eff)
        .slice(0, n)
        .map((t) => t.key);
    },

    /** Relative weight per configured theme, for auto mode's rotation. */
    themeWeights(themes) {
      const p = this.playbook;
      const flat = new Map(themes.map((t) => [norm(t.theme), 1]));
      if (!p || !this.cfg.enabled || !(p.themes || []).length) return flat;
      for (const row of p.themes) {
        const k = norm(row.key);
        if (flat.has(k)) flat.set(k, Math.max(0.25, Math.min(4, row.lift)));
      }
      const boost = (window.Teach ? Teach.manual().boost.themes : {}) || {};
      for (const [k, v] of flat) {
        const b = boost[k];
        if (Number.isFinite(b)) flat.set(k, Math.max(0, Math.min(6, v * b)));
      }
      if (window.Variety && Variety.cfg.enabled) {
        const novelty = Variety.themeNovelty(themes);
        for (const [k, v] of flat) flat.set(k, v * (novelty.get(k) || 1));
      }
      return flat;
    },

    /** Is the DeviantArt data stale enough to be worth a background refresh? */
    syncIsStale() {
      const hours = Number(this.cfg.autoSyncHours) || 0;
      if (!hours) return false;
      if (!this.perf.lastSyncAt) return true;
      return Date.now() - this.perf.lastSyncAt > hours * 3600_000;
    },

    /** One full learning pass: read DeviantArt, explain any new winners, rebuild the playbook. */
    async refresh({ sync = true, explain = true, log = () => {} } = {}) {
      if (sync && this.syncIsStale()) {
        const res = await this.sync({ quiet: true }).catch((e) => ({ ok: false, error: e.message }));
        if (!res.ok) log(`Could not refresh DeviantArt stats (${res.error}) — learning from what is already stored.`, 'err');
      }
      this.relink();
      if (explain) {
        for (const dev of this.unexplainedWinners(2)) {
          try {
            const note = await this.explain(dev);
            if (note) log(`Noted why "${dev.title}" is working: ${note.slice(0, 140)}…`, 'ok');
          } catch { }
        }
      }
      const p = await this.buildPlaybook({ log });
      return p;
    },
  };

  /** One recipe record, the same shape wherever it is built (playbook or live seed pool). */
  function recipeOf(d, m) {
    return {
      from: d.deviationId,
      promptSource: d.promptSource || null,
      title: d.title,
      theme: d.theme || '',
      prompt: d.prompt,
      tags: (d.tags || []).slice(0, 12),
      perDay: round2(m.perDay),
      vsPeers: m.vsPeers == null ? null : round2(m.vsPeers),
    };
  }

  function qcBand(score) {
    if (score >= 9) return 'QC 9-10';
    if (score >= 7) return 'QC 7-8';
    return 'QC below 7';
  }

  function titleTraits(title) {
    const t = String(title || '').trim();
    if (!t) return [];
    const words = t.split(/\s+/).length;
    const out = [words <= 3 ? 'title: 1-3 words' : words <= 6 ? 'title: 4-6 words' : 'title: 7+ words'];
    if (/[?]/.test(t)) out.push('title: asks a question');
    if (/[!]/.test(t)) out.push('title: exclamation');
    if (/[:—–-]/.test(t)) out.push('title: two-part');
    if (/\b(her|his|their|my|your)\b/i.test(t)) out.push('title: possessive');
    return out;
  }

  function timingKeys(at) {
    if (!at) return [];
    const d = new Date(at);
    const h = d.getHours();
    const band = h < 6 ? 'posted 00-06' : h < 12 ? 'posted 06-12' : h < 18 ? 'posted 12-18' : 'posted 18-24';
    const day = d.getDay();
    return [band, (day === 0 || day === 6) ? 'posted weekend' : 'posted weekday'];
  }

  function statSummary(p) {
    const bits = [];
    const t = (p.themes || [])[0];
    if (t && t.lift > 1.15) bits.push(`"${t.key}" is the strongest theme at ${t.lift}× the median over ${t.n} post(s)`);
    const tr = (p.promptTraits || [])[0];
    if (tr && tr.lift > 1.15) bits.push(`prompts mentioning "${tr.key}" run ${tr.lift}× ahead`);
    const tag = (p.tags || [])[0];
    if (tag && tag.lift > 1.15) bits.push(`#${tag.key} has the highest observed tag association (${tag.lift}×)`);
    const q = (p.qcBands || []).slice().sort((a, b) => b.lift - a.lift)[0];
    if (q && q.lift > 1.15) bits.push(`${q.key} outperforms the rest (${q.lift}×)`);
    if (!bits.length) return `Measured ${p.sampleSize} item(s); nothing yet clears the sample threshold, so the loop is still collecting.`;
    return bits.join('; ') + '.';
  }

  window.Insights = Insights;
})();
