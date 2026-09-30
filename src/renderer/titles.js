/**
 * titles.js: memory and imagination for artwork titles.
 *
 * Language models write good titles, but the SAME good title every time ("Moonlit
 * Serenity", again). Two fixes:
 *   MEMORY: a ledger of every title already used (in Review, published, or
 *           discarded) with a similarity score (word overlap + character bigrams)
 *           that flags near-repeats;
 *   FORM:   a rotation of title shapes (a question, an overheard line, a place
 *           name...) that cannot be satisfied by swapping one adjective.
 * It also learns the artist's own title style from the titles they rename by hand.
 */
(function () {
  const STOP = new Set(`a an the and or of in on at to for with from by as is are was were
    be her his its their my your our this that these those it into onto over under`.split(/\s+/).filter(Boolean));

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  const SUFFIX_RE = /[,;-]?\s+((?:WIP|OC|FA)(?:\s+(?:WIP|OC|FA))*)\s*$/i;

  const MIN_STYLE_SAMPLE = 20;

  const DEVICES_STAND_DOWN_AT = 12;
  const words = (s) => norm(s).split(' ').filter(Boolean);
  const content = (s) => words(s).filter((w) => w.length > 2 && !STOP.has(w));

  /**
   * Character bigrams, for the case token overlap misses entirely: "Moonlight" against "Moonlit"
   * share no token at all but are obviously the same title on a gallery page.
   */
  function bigrams(s) {
    const t = norm(s).replace(/ /g, '');
    const out = new Set();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  }

  const overlap = (a, b) => {
    if (!a.size || !b.size) return 0;
    let hit = 0;
    for (const x of a) if (b.has(x)) hit++;
    return (2 * hit) / (a.size + b.size);
  };

  /** Shared content words, damped when there is only ONE of them. */
  function wordScore(a, b, weightOf) {
    if (!a.size || !b.size) return 0;
    const w = weightOf || (() => 1);
    let shared = 0, total = 0, hits = 0;
    for (const x of a) { const k = w(x); total += k; if (b.has(x)) { shared += k; hits++; } }
    for (const x of b) total += w(x);
    if (!shared || !total) return 0;
    const dice = (2 * shared) / total;
    return hits === 1 ? dice * 0.55 : dice;
  }

  const FRAME_SHARE = 0.015;

  const COMMON_OPENER_SHARE = 0.02;

  /** How alike are these two titles, 0..1? */
  function similarity(a, b, voice = null) {
    const ba = bodyOf(a), bb = bodyOf(b);
    const na = norm(ba), nb = norm(bb);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    const wa = new Set(content(ba)), wb = new Set(content(bb));
    const weightOf = voice ? voice.weightOf : null;
    const tokenScore = wordScore(wa, wb, weightOf);

    const longer = Math.max(wa.size, wb.size);
    const charWeight = longer <= 3 ? 0.9 : longer <= 5 ? 0.6 : 0.35;
    const charScore = overlap(bigrams(ba), bigrams(bb)) * charWeight;

    const firstA = words(ba)[0], firstB = words(bb)[0];
    const shared = firstA && firstA === firstB;
    const houseOpener = shared && voice ? voice.commonOpener(firstA) : false;
    const openingBonus = shared && !houseOpener ? 0.2 : 0;
    return Math.min(1, Math.max(tokenScore, charScore) + openingBonus);
  }

  const DEVICES = [
    'a single evocative noun phrase, three words at most',
    'a question the image seems to be asking',
    'a line of overheard speech — no quote marks',
    'a moment in time: an hour, a season, or the weather',
    'a present-participle verb doing the work ("Sinking", "Unfolding")',
    'two contrasting words joined by a comma',
    'a place, named the way a location card would name it',
    'a promise, or a challenge',
    'deliberate understatement — say less than the image shows',
    'the title of an imaginary song',
    'a myth or fairy tale bent to fit this scene',
    'a texture or a temperature carrying the whole title',
    'second person — speak to the viewer as "you"',
    'a number or a measurement',
    'one precisely named colour',
    'one object from the scene standing in for all of it',
    'a verb-first instruction to the viewer',
    'a fragment that reads like the middle of a sentence',
    'a compound word the artist invented',
  ];

  const CREATIVITY = [
    { key: 0, label: 'Plain', temp: 0.7, devices: 0, push: '' },
    { key: 1, label: 'Balanced', temp: 0.9, devices: 1, push: '' },
    {
      key: 2, label: 'Bold', temp: 1.05, devices: 1,
      push: 'Reach past the first phrase that occurs to you — the obvious one is the one already used. Concrete nouns beat mood words: name the thing in the frame, not the feeling about it.',
    },
    {
      key: 3, label: 'Wild', temp: 1.2, devices: 1,
      push: 'Take real swings. Wordplay, invented compounds, an unexpected register, a title that only makes sense once you have looked at the image. Ban yourself from the words "serenity", "whispers", "echoes", "journey", "dreams", "bliss", "wonder", "secret", "untitled" and anything else that would fit a thousand other pictures.',
    },
  ];

  /** Trailing tag conventions such as " WIP" or " OC". */
  function suffixOf(title) {
    const m = String(title || '').match(SUFFIX_RE);
    return m ? m[1].toUpperCase().replace(/\s+/g, ' ') : '';
  }

  /** The title with its trailing convention removed, so the body can be measured alone. */
  function bodyOf(title) {
    return String(title || '').replace(SUFFIX_RE, '').trim() || String(title || '').trim();
  }

  const FIRST_PERSON = /\b(i|im|my|me|mine|am|myself)\b/i;

  /** What one title looks like, reduced to the few things worth imitating. */
  function traitsOf(title) {
    const body = bodyOf(title);
    const w = body.split(/\s+/).filter(Boolean);
    const letters = body.replace(/[^A-Za-z ]/g, ' ').split(/\s+/).filter(Boolean);
    const capped = letters.filter((x) => /^[A-Z]/.test(x)).length;
    return {
      words: w.length,
      chars: body.length,
      firstPerson: FIRST_PERSON.test(body.replace(/'/g, '')),
      question: /\?/.test(body),
      exclaim: /!/.test(body),
      endsStopped: /[.!?]$/.test(body),
      titleCase: letters.length > 1 && capped / letters.length > 0.7,
    };
  }

  const Style = {
    suffixOf,
    bodyOf,
    traitsOf,

    /** Build the profile from everything that carries the artist's own hand. */
    build({ renames = [], published = [] } = {}) {
      const rows = [];
      for (const r of renames) if (r && r.human) rows.push({ t: r.human, w: 3 });
      for (const p of published) if (p && p.title) rows.push({ t: p.title, w: 1 + Math.min(2, Number(p.weight) || 0) });
      if (rows.length < MIN_STYLE_SAMPLE) return null;

      const total = rows.reduce((a, r) => a + r.w, 0);
      const share = (fn) => rows.reduce((a, r) => a + (fn(r.t) ? r.w : 0), 0) / total;

      const tally = new Map();
      for (const r of rows) {
        const s = suffixOf(r.t);
        if (s) tally.set(s, (tally.get(s) || 0) + r.w);
      }
      const suffixes = [...tally.entries()]
        .map(([suffix, n]) => ({ suffix, share: n / total }))
        .filter((x) => x.share >= 0.12)
        .sort((a, b) => b.share - a.share)
        .slice(0, 3);

      const counts = [];
      for (const r of rows) for (let i = 0; i < r.w; i++) counts.push(traitsOf(r.t).words);
      counts.sort((a, b) => a - b);
      const at = (q) => counts[Math.min(counts.length - 1, Math.floor(counts.length * q))] || 5;

      return {
        suffixes,
        suffixShare: suffixes.reduce((a, x) => a + x.share, 0),
        words: { p20: at(0.2), median: at(0.5), p80: at(0.8) },
        traits: {
          firstPerson: share((t) => traitsOf(t).firstPerson),
          question: share((t) => traitsOf(t).question),
          exclaim: share((t) => traitsOf(t).exclaim),
          endsStopped: share((t) => traitsOf(t).endsStopped),
          titleCase: share((t) => traitsOf(t).titleCase),
        },
        sampleSize: rows.length,
        renameCount: renames.length,
        builtAt: Date.now(),
      };
    },

    /** The profile written out as instructions. */
    describe(p) {
      if (!p) return '';
      const pct = (x) => Math.round(x * 100);
      const t = p.traits || {};
      const lines = [];

      if (t.titleCase < 0.35) {
        lines.push(`Write a SENTENCE, not Title Case — only ${pct(t.titleCase)}% of this artist's titles capitalise every word. `
          + `"My cat stole the paintbrush", not "Paint Everywhere".`);
      }
      if (t.firstPerson >= 0.2) {
        lines.push(`${pct(t.firstPerson)}% speak in FIRST PERSON — the character talking from inside the picture `
          + `("I can't find my brush!", "Why is the sky green?"), not a narrator describing it from outside.`);
      }
      if (t.question >= 0.2) lines.push(`${pct(t.question)}% are questions.`);
      if (t.exclaim >= 0.15) lines.push(`${pct(t.exclaim)}% end on an exclamation.`);
      if (t.endsStopped >= 0.5) {
        lines.push(`${pct(t.endsStopped)}% close with real punctuation — a full stop, a question mark or an exclamation mark.`);
      }
      lines.push(`Length: ${p.words.p20}-${p.words.p80} words, ${p.words.median} is typical. `
        + `Plain spoken words, not literary ones — no invented compounds, no "—" constructions.`);

      if (p.suffixes && p.suffixes.length) {
        const main = p.suffixes[0].suffix;
        lines.push(`TAG SUFFIX — ${pct(p.suffixShare)}% of this artist's titles end with a tag after the sentence: `
          + p.suffixes.map((s) => `"${s.suffix}" (${pct(s.share)}%)`).join(', ')
          + `. Put "${main}" after the closing punctuation, exactly like this:  My cat stole the paintbrush. ${main}`);
      }
      return `HOUSE STYLE — how THIS artist titles their own work, measured over ${p.sampleSize} of their titles`
        + `${p.renameCount ? `, including ${p.renameCount} the artist rewrote by hand after the machine wrote one` : ''}:\n`
        + lines.map((l) => `- ${l}`).join('\n');
    },

    /** The rename pairs, shown as before → after. */
    examples(renames, limit = 8) {
      if (limit <= 0) return '';
      const seen = new Set();
      const out = [];
      for (const r of [...(renames || [])].reverse()) {
        if (!r || !r.ai || !r.human) continue;
        const key = norm(r.human);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(r);
        if (out.length >= limit) break;
      }
      if (!out.length) return '';
      return `TITLES THE MACHINE WROTE, AND WHAT THE ARTIST REPLACED THEM WITH — the difference between these two `
        + `columns is the entire brief:\n`
        + out.map((r) => `- it wrote "${r.ai}"   →   the artist shipped "${r.human}"`).join('\n');
    },

    /** Bend a title the model already wrote toward the house style, without a second call. */
    conform(title, p) {
      let t = String(title || '').trim();
      if (!t || !p) return t;
      const wantSuffix = p.suffixes && p.suffixes.length && p.suffixShare >= 0.5 ? p.suffixes[0].suffix : '';
      const has = suffixOf(t);
      if (has) {
        if (t.length <= 50) return t;
        const room = 50 - has.length - 1;
        return `${bodyOf(t).slice(0, room).replace(/[\s.,!?-]+$/, '')} ${has}`;
      }
      if ((p.traits || {}).endsStopped >= 0.5 && !/[.!?]$/.test(t)) t += '.';
      if (wantSuffix) t = `${t} ${wantSuffix}`;
      if (t.length > 50 && wantSuffix) {
        const room = 50 - wantSuffix.length - 1;
        t = `${bodyOf(t).slice(0, room).replace(/[\s.,!?-]+$/, '')} ${wantSuffix}`;
      }
      return t.slice(0, 50);
    },
  };

  const Titles = {
    ledger: { used: [], cursor: 0, renames: [], forgotten: [], style: null },
    ready: false,
    Style,

    get cfg() {
      const m = (State.settings && State.settings.metadata) || {};
      return {
        creativity: 1, devices: true, useDaHistory: true, avoidCount: 24,
        similarityLimit: 0.5, maxRepairs: 1, bannedWords: [],
        learnStyle: true, styleExamples: 8, deviceMode: 'auto',
        ...(m.titles || {}),
      };
    },
    get level() {
      const c = Math.max(0, Math.min(3, Number(this.cfg.creativity) || 0));
      return CREATIVITY[c];
    },

    /** Fill in anything a ledger from an older build (or a test) does not carry. */
    normalise() {
      const l = this.ledger || (this.ledger = {});
      if (!Array.isArray(l.used)) l.used = [];
      if (!Array.isArray(l.renames)) l.renames = [];
      if (!Array.isArray(l.forgotten)) l.forgotten = [];
      if (typeof l.style === 'undefined') l.style = null;
      l.cursor = Number(l.cursor) || 0;
      return l;
    },

    async init() {
      this.ledger = (await window.ala.db.getTitles()) || this.ledger;
      this.normalise();
      if (!this.ledger.used.length) this.absorbExisting();
      const found = this.backfillRenames();
      if (found || !this.ledger.style || this.styleIsStale()) this.rebuildStyle();
      this.ready = true;
      return this.ledger;
    },

    persist() {
      window.ala.db.setTitles(this.ledger);
      State.emit('titles', this.ledger);
    },

    /** Fold every title currently visible anywhere into the ledger. */
    absorbExisting() {
      let added = 0;
      for (const c of State.library || []) {
        const t = c.metadata && c.metadata.title;
        if (t) added += this.remember(t, 'card', c.id, false) ? 1 : 0;
      }
      const devs = (window.Insights && window.Insights.perf && window.Insights.perf.deviations) || [];
      for (const d of devs) {
        if (d.title) added += this.remember(d.title, 'deviantart', null, false) ? 1 : 0;
      }
      if (added) this.persist();
      return added;
    },

    /** Record a title as used. */
    remember(title, src = 'card', cardId = null, persist = true) {
      const t = String(title || '').trim();
      if (!t) return false;
      const key = norm(t);
      if (!key) return false;
      if (this.ledger.used.some((u) => norm(u.t) === key)) return false;
      this.ledger.used.push({ t, at: Date.now(), src, cardId });
      if (this.ledger.used.length > 5000) this.ledger.used.splice(0, this.ledger.used.length - 5000);
      if (persist) this.persist();
      return true;
    },

    /** Record that the artist replaced a written title with one of their own. */
    noteRename(ai, human, card = null) {
      this.normalise();
      const a = String(ai || '').trim();
      const h = String(human || '').trim();
      if (!a || !h || norm(a) === norm(h)) return false;
      if (similarity(a, h) > 0.85) return false;
      const cardId = card && card.id ? card.id : null;
      const prev = cardId ? this.ledger.renames.findIndex((r) => r.cardId === cardId) : -1;
      const row = {
        ai: a.slice(0, 120),
        human: h.slice(0, 120),
        cardId,
        prompt: String((card && card.prompt) || '').slice(0, 400),
        at: Date.now(),
        src: 'edit',
      };
      if (prev >= 0) this.ledger.renames[prev] = { ...this.ledger.renames[prev], ...row };
      else this.ledger.renames.push(row);
      if (this.ledger.renames.length > 600) {
        this.ledger.renames.splice(0, this.ledger.renames.length - 600);
      }
      this.remember(h, 'manual', cardId, false);
      this.rebuildStyle();
      this.persist();
      return true;
    },

    /** Recover renames the app watched happen and never recorded. */
    backfillRenames() {
      this.normalise();
      const first = new Map();
      for (const u of this.ledger.used) {
        if (u.cardId && u.src !== 'manual' && !first.has(u.cardId)) first.set(u.cardId, u.t);
      }
      const known = new Set(this.ledger.renames.map((r) => r.cardId).filter(Boolean));
      const dropped = new Set(this.ledger.forgotten || []);
      let added = 0;
      for (const c of State.library || []) {
        if (known.has(c.id) || dropped.has(c.id)) continue;
        const now = c.metadata && c.metadata.title;
        const was = first.get(c.id);
        if (!now || !was || norm(now) === norm(was)) continue;
        if (similarity(was, now) > 0.85) continue;
        this.ledger.renames.push({
          ai: String(was).slice(0, 120),
          human: String(now).slice(0, 120),
          cardId: c.id,
          prompt: String(c.prompt || '').slice(0, 400),
          at: c.updatedAt || Date.now(),
          src: 'backfill',
        });
        added++;
      }
      if (added) {
        this.ledger.renames.sort((a, b) => (a.at || 0) - (b.at || 0));
        this.persist();
      }
      return added;
    },

    /** Drop a rename pair from the corpus. */
    forgetRename(row) {
      this.normalise();
      if (!row) return false;
      const before = this.ledger.renames.length;
      this.ledger.renames = this.ledger.renames.filter((r) => !(
        r.ai === row.ai && r.human === row.human && r.cardId === row.cardId));
      if (this.ledger.renames.length === before) return false;
      if (row.cardId) {
        this.ledger.forgotten = [...new Set([...(this.ledger.forgotten || []), row.cardId])];
        this.remember(row.human, 'manual', row.cardId, false);
      }
      this.rebuildStyle();
      this.persist();
      return true;
    },

    /** Published titles, each weighted by how well it actually did. */
    _publishedForStyle() {
      const I = window.Insights;
      if (!I || !I.perf || !Array.isArray(I.perf.deviations)) return [];
      let rows;
      try {
        const all = I.scored();
        const top = Math.max(1, Math.floor(all.length * 0.1));
        rows = all.map(({ d }, i) => ({ title: d.title, weight: i < top ? 2 : 0 }));
      } catch {
        rows = I.perf.deviations.map((d) => ({ title: d.title, weight: 0 }));
      }
      return rows.filter((r) => r.title);
    },

    /** Recompute the house style from the current evidence and cache it. */
    rebuildStyle() {
      this.normalise();
      this.ledger.style = Style.build({
        renames: this.ledger.renames,
        published: this.cfg.useDaHistory ? this._publishedForStyle() : [],
      });
      this.persist();
      return this.ledger.style;
    },

    /** Has the evidence moved since the cached profile was built? */
    styleIsStale() {
      const s = this.normalise().style;
      if (!s) return true;
      if (s.renameCount !== this.ledger.renames.length) return true;
      const devs = (window.Insights && window.Insights.perf && window.Insights.perf.deviations) || [];
      const publishedCount = this.cfg.useDaHistory ? devs.filter((d) => !d.isDeleted && d.title).length : 0;
      return Math.abs((s.sampleSize - s.renameCount) - publishedCount) > 5;
    },

    /** The learned profile, or null when there is not enough evidence to claim one. */
    get style() {
      if (this.cfg.learnStyle === false) return null;
      return this.normalise().style || null;
    },

    /** Should the shape rotation run for this call? */
    devicesOn() {
      this.normalise();
      if (!this.cfg.devices || !this.level.devices) return false;
      const mode = this.cfg.deviceMode || 'auto';
      if (mode === 'always') return true;
      if (mode === 'never') return false;
      const p = this.style;
      return !(p && p.renameCount >= DEVICES_STAND_DOWN_AT);
    },

    /** Everything that counts as "already used", newest first. */
    corpus() {
      const seen = new Map();
      const add = (t, src, at) => {
        const key = norm(t);
        if (!key || seen.has(key)) return;
        seen.set(key, { t: String(t).trim(), src, at: at || 0 });
      };
      for (const u of [...this.ledger.used].reverse()) add(u.t, u.src, u.at);
      for (const c of State.library || []) {
        if (c.metadata && c.metadata.title) add(c.metadata.title, 'card', c.updatedAt || c.createdAt);
      }
      if (this.cfg.useDaHistory) {
        const devs = (window.Insights && window.Insights.perf && window.Insights.perf.deviations) || [];
        for (const d of devs) add(d.title, 'deviantart', d.publishedAt || d.firstSeenAt);
      }
      return [...seen.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
    },

    /** Which words in this gallery are the artist's frame rather than a title's identity. */
    voice(pool = null) {
      const all = pool || this.corpus();
      const key = `${all.length}:${(all[0] && all[0].at) || 0}`;
      if (this._voice && this._voice.key === key) return this._voice;
      const df = new Map();
      const openers = new Map();
      for (const { t } of all) {
        const body = bodyOf(t);
        for (const w of new Set(content(body))) df.set(w, (df.get(w) || 0) + 1);
        const first = words(body)[0];
        if (first) openers.set(first, (openers.get(first) || 0) + 1);
      }
      const n = all.length;
      const frameAt = Math.max(3, n * FRAME_SHARE);
      const openerAt = Math.max(3, n * COMMON_OPENER_SHARE);
      this._voice = {
        key, n, df, openers,
        weightOf: (w) => (n >= MIN_STYLE_SAMPLE && (df.get(w) || 0) >= frameAt ? 0.15 : 1),
        commonOpener: (w) => n >= MIN_STYLE_SAMPLE && (openers.get(w) || 0) >= openerAt,
      };
      return this._voice;
    },

    /** The closest thing already used to this title, with its score. */
    nearest(title, { exclude = [], pool = null } = {}) {
      const skip = new Set(exclude.map(norm));
      const all = pool || this.corpus();
      const voice = this.voice(all);
      let best = null;
      for (const entry of all) {
        if (skip.has(norm(entry.t))) continue;
        const score = similarity(title, entry.t, voice);
        if (!best || score > best.score) best = { ...entry, score };
        if (best.score === 1) break;
      }
      return best;
    },

    /** Is this title too close to something already used? */
    isRepeat(title, opts = {}) {
      const limit = opts.limit ?? this.cfg.similarityLimit;
      const near = this.nearest(title, opts);
      return { repeat: !!(near && near.score >= limit), against: near, limit };
    },

    /** Words this artist leans on, across every title ever used. */
    overusedWords(limit = 12, minCount = 3) {
      const counts = new Map();
      for (const { t } of this.corpus()) {
        for (const w of new Set(content(t))) counts.set(w, (counts.get(w) || 0) + 1);
      }
      return [...counts.entries()]
        .filter(([, n]) => n >= minCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([word, count]) => ({ word, count }));
    },

    /** The past titles worth showing the writer, for THIS prompt. */
    atRisk(prompt, limit = null) {
      const n = limit ?? this.cfg.avoidCount;
      const all = this.corpus();
      if (!all.length) return [];
      const promptWords = new Set(content(prompt).slice(0, 60));
      const scored = all.map((entry) => {
        const tw = content(entry.t);
        const hits = tw.filter((w) => promptWords.has(w)).length;
        return { entry, relevance: tw.length ? hits / tw.length : 0 };
      });
      const recent = all.slice(0, Math.min(8, Math.ceil(n / 3)));
      const relevant = scored
        .filter((x) => x.relevance > 0)
        .sort((a, b) => b.relevance - a.relevance)
        .map((x) => x.entry);
      const out = [];
      const seen = new Set();
      for (const e of [...recent, ...relevant, ...all]) {
        const key = norm(e.t);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(e);
        if (out.length >= n) break;
      }
      return out;
    },

    /** Hand out `count` distinct shapes and advance the rotation. */
    takeDevices(count) {
      if (!this.devicesOn() || count < 1) return [];
      const start = ((Number(this.ledger.cursor) || 0) % DEVICES.length + DEVICES.length) % DEVICES.length;
      const picked = [];
      for (let i = 0; i < Math.min(count, DEVICES.length); i++) {
        picked.push(DEVICES[(start + i) % DEVICES.length]);
      }
      this.ledger.cursor = start + picked.length;
      this.persist();
      return picked;
    },

    /** The block of instructions that goes into a metadata prompt. */
    promptBlock({ prompt = '', count = 1, devices = null } = {}) {
      const parts = [];
      const avoid = this.atRisk(prompt);
      if (avoid.length) {
        const da = avoid.filter((a) => a.src === 'deviantart').length;
        parts.push(`TITLES ALREADY USED — never repeat one of these, and never write a rewording of one`
          + `${da ? ` (${da} of them are already published on this artist's DeviantArt page)` : ''}:\n`
          + avoid.map((a) => `- ${a.t}`).join('\n'));
      }
      const overused = this.overusedWords(8, 3);
      const banned = (this.cfg.bannedWords || []).map((w) => String(w).trim()).filter(Boolean);
      if (overused.length) {
        parts.push(`WORDS THIS ARTIST HAS LEANED ON TOO HARD — avoid them unless one is genuinely the only right word: `
          + overused.map((o) => `${o.word} (${o.count}×)`).join(', ') + '.');
      }
      if (banned.length) parts.push(`NEVER use these words in a title: ${banned.join(', ')}.`);

      parts.push('The title names what is HAPPENING in the picture, never what the picture is.'
        + ' "Illustration", "artwork", "digital art", "anime art", "image" and "render" are'
        + ' never title words — a viewer scrolling a gallery of anime art already knows.');

      const profile = this.style;
      if (profile) {
        parts.push(Style.describe(profile));
        const ex = Style.examples(this.ledger.renames, Math.max(0, Number(this.cfg.styleExamples) || 0));
        if (ex) parts.push(ex);
      }

      const shapes = devices || this.takeDevices(count);
      if (shapes.length) {
        parts.push(count > 1
          ? `TITLE SHAPES — write each title in a different shape, in this order. The shape is a rule about FORM, not about subject; the title must still describe its own image:\n`
            + shapes.map((d, i) => `${i + 1}. ${d}`).join('\n')
          : `TITLE SHAPE — write it as ${shapes[0]}. This is a rule about form; the title must still describe the image.`);
      }
      if (this.level.push) parts.push(this.level.push);
      return parts.join('\n\n');
    },

    /** Temperature for a title-writing call at the configured creativity. */
    temperature(bump = 0) { return Math.min(1.4, this.level.temp + bump); },

    /** Judge a freshly written set. */
    review(list, { exclude = [] } = {}) {
      const limit = this.cfg.similarityLimit;
      const pool = this.corpus();
      const problems = [];
      const titles = (list || []).map((x) => String((x && x.title) || '').trim());
      titles.forEach((title, i) => {
        if (!title) return;
        const against = this.nearest(title, { exclude, pool });
        if (against && against.score >= limit) {
          problems.push({
            index: i, title, score: Math.round(against.score * 100) / 100,
            reason: `too close to "${against.t}"${against.src === 'deviantart' ? ' (already published)' : ''}`,
          });
          return;
        }
        for (let j = 0; j < i; j++) {
          if (!titles[j]) continue;
          const s = similarity(title, titles[j], this.voice(pool));
          if (s >= limit) {
            problems.push({
              index: i, title, score: Math.round(s * 100) / 100,
              reason: `too close to "${titles[j]}" in this same set`,
            });
            return;
          }
        }
      });
      return problems;
    },

    /** Every near-duplicate pair currently sitting in the library. */
    audit({ limit = 40 } = {}) {
      const cards = (State.library || []).filter((c) => c.metadata && c.metadata.title
        && !['discarded', 'rejected'].includes(c.status));
      const out = [];
      const voice = this.voice();
      for (let i = 0; i < cards.length; i++) {
        for (let j = i + 1; j < cards.length; j++) {
          const s = similarity(cards[i].metadata.title, cards[j].metadata.title, voice);
          if (s >= this.cfg.similarityLimit) {
            out.push({ a: cards[i], b: cards[j], score: Math.round(s * 100) / 100 });
          }
        }
      }
      return out.sort((x, y) => y.score - x.score).slice(0, limit);
    },

    /** Numbers for the settings readout. */
    stats() {
      const all = this.corpus();
      return {
        total: all.length,
        fromDa: all.filter((a) => a.src === 'deviantart').length,
        fromCards: all.filter((a) => a.src !== 'deviantart').length,
        overused: this.overusedWords(6, 3),
        collisions: this.audit({ limit: 200 }).length,
        cursor: this.ledger.cursor,
        deviceCount: DEVICES.length,
        style: this.style,
        renames: this.normalise().renames.length,
        devicesOn: this.devicesOn(),
      };
    },

    /** The first candidate that is not already used, out of the ones the writer offered. */
    pickFree(candidates, { exclude = [], avoid = [], limit = null } = {}) {
      const lim = limit ?? this.cfg.similarityLimit;
      const pool = this.corpus();
      const voice = this.voice(pool);
      const seen = new Set();
      let tried = 0;
      for (const raw of candidates || []) {
        const title = String(raw || '').replace(/["#]/g, '').trim().slice(0, 50);
        if (!title || seen.has(norm(title))) continue;
        seen.add(norm(title));
        tried++;
        const against = this.nearest(title, { exclude, pool });
        if (against && against.score >= lim) continue;
        if (avoid.some((t) => t && similarity(title, t, voice) >= lim)) continue;
        return { title, index: tried - 1, tried, against: against || null };
      }
      return null;
    },

    similarity,
    DEVICES,
    CREATIVITY,
    MIN_STYLE_SAMPLE,
    DEVICES_STAND_DOWN_AT,
  };

  window.Titles = Titles;
})();
