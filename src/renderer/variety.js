/**
 * variety.js: keeps the learning loop from collapsing into one idea.
 *
 * If the app always builds on its best result, three nights later every prompt is
 * the same scene in a different room. Four counterweights:
 *   1. SATURATION: a phrase that appears in most recent prompts is banned for a
 *      round, since it no longer explains anything;
 *   2. ROTATION: the example to grow from is sampled from the whole top tier with
 *      a cooldown, not always rank #1;
 *   3. AXES: concrete creative dimensions (light, lens, place, palette, weather,
 *      era...) with values chosen by how ABSENT they are from recent work;
 *   4. MODES: each round rolls exploit / explore / wild, and results are tagged so
 *      exploration can win on merit.
 */
(function () {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  const STOP = new Set(`a an the and or but of in on at to for with from by as is are was were
    be been being this that these those it its her his their they she he you your my our into
    onto over under near up down out off then than so if while during about around very`
    .split(/\s+/).filter(Boolean));

  const AXES = {
    light: [
      'hard midday sun with sharp shadows', 'overcast diffuse grey light',
      'single warm practical lamp', 'cold fluorescent overhead strip',
      'firelight from below', 'blue hour window light', 'harsh direct flash',
      'candlelit, most of the frame in shadow', 'backlit rim light, subject nearly a silhouette',
      'coloured neon spill, magenta and cyan', 'dappled light through leaves',
      'monitor glow as the only light source', 'stormlight, sudden and flat',
      'golden hour raking across the frame', 'bounced light off a white wall, very soft',
    ],
    camera: [
      'wide establishing shot, subject small in frame', 'extreme close-up on hands',
      'over-the-shoulder', 'dutch angle', 'straight-on eye level, symmetrical',
      'high overhead looking down', 'ground-level view looking up',
      'long lens, compressed background', 'fisheye distortion',
      'through a doorway or window frame', 'reflection in a mirror or glass',
      'three-quarter length, classical portrait distance',
      'shot from behind, face turned away', 'macro on a single detail, subject out of focus',
    ],
    place: [
      'rain-wet city street at night', 'empty laundromat', 'greenhouse full of overgrowth',
      'rooftop above a sleeping city', 'university library stacks', 'ferry deck at sea',
      'desert highway rest stop', 'cramped record shop', 'lighthouse stairwell',
      'snowbound cabin', 'backstage of a small theatre', 'public aquarium, after hours',
      'cable car above a valley', 'abandoned observatory', 'night market alley',
      'commuter train at dawn', 'quiet chapel', 'workshop full of half-finished projects',
    ],
    palette: [
      'near-monochrome with one saturated accent', 'warm ochre and deep brown',
      'cold teal and slate', 'washed-out pastel', 'high-contrast black and red',
      'sun-bleached film colour', 'deep greens and gold', 'muted earth tones',
      'candy brights', 'sepia and dust', 'ice blue and white', 'ink black with paper white',
    ],
    weather: [
      'heavy rain', 'thin fog', 'first snow', 'heat haze', 'wind moving everything',
      'the air just after a storm', 'dry cold, breath visible', 'humid and still',
    ],
    mood: [
      'quiet and unobserved', 'caught mid-laugh', 'exhausted and content',
      'tense, something about to happen', 'nostalgic', 'defiant', 'absorbed in a task',
      'lonely but not sad', 'newly awake', 'triumphant and messy',
    ],
    composition: [
      'subject pushed to the edge of frame', 'heavy negative space above',
      'foreground object partly blocking the view', 'strong leading line',
      'framed by an opening', 'layered depth, three distinct planes',
      'flat and graphic, poster-like', 'centred and still',
    ],
    era: [
      '1970s film stock', 'late-90s digital camera artefacts', 'hand-painted cel look',
      'ink and watercolour', 'thick painterly brushwork', 'clean modern vector flatness',
      'grainy black and white photography', 'faded 80s anime key art',
    ],
    action: [
      'mid-motion, caught between two poses', 'completely still, holding something',
      'reaching for something out of frame', 'turning toward the viewer',
      'asleep or nearly', 'eating or drinking', 'working with their hands',
      'sheltering from the weather', 'about to leave', 'just arrived',
    ],
  };

  const AXIS_NAMES = Object.keys(AXES);

  const Variety = {
    /** Settings block, with the defaults spelled out so a pre-update settings.json works. */
    get cfg() {
      const v = (State.settings && State.settings.variety) || {};
      return {
        enabled: v.enabled !== false,
        exploreRatio: num(v.exploreRatio, 0.35),
        wildRatio: num(v.wildRatio, 0.12),
        saturationCeiling: num(v.saturationCeiling, 0.45),
        recentWindow: Math.max(8, Math.round(num(v.recentWindow, 40))),
        seedCooldown: Math.max(0, Math.round(num(v.seedCooldown, 3))),
        maxTraits: Math.max(1, Math.round(num(v.maxTraits, 5))),
        axesPerRound: Math.max(1, Math.round(num(v.axesPerRound, 3))),
        noveltyBonus: num(v.noveltyBonus, 0.5),
      };
    },

    /** The prompts the account has actually produced lately, newest first. */
    recentPrompts(n = null) {
      const limit = n || this.cfg.recentWindow;
      const rows = [];
      for (const j of (State.queue || [])) if (j && j.prompt) rows.push({ at: j.createdAt || 0, p: j.prompt });
      for (const c of (State.library || [])) if (c && c.prompt) rows.push({ at: c.createdAt || 0, p: c.prompt });
      rows.sort((a, b) => b.at - a.at);
      const seen = new Set();
      const out = [];
      for (const r of rows) {
        if (seen.has(r.p)) continue;
        seen.add(r.p);
        out.push(r.p);
        if (out.length >= limit) break;
      }
      return out;
    },

    /** Fraction of recent prompts containing `term`, matched on normalised word runs. */
    saturation(term, corpus = null) {
      const t = norm(term);
      if (!t) return 0;
      const rows = corpus || this._corpus();
      if (!rows.length) return 0;
      const needle = ` ${t} `;
      let hits = 0;
      for (const r of rows) if (r.includes(needle)) hits++;
      return hits / rows.length;
    },

    _corpus() {
      if (this._corpusCache && Date.now() - this._corpusAt < 20000) return this._corpusCache;
      this._corpusCache = this.recentPrompts().map((p) => ` ${norm(p)} `);
      this._corpusAt = Date.now();
      return this._corpusCache;
    },

    /** Drop the cache so the next read sees prompts queued since. */
    invalidate() { this._corpusCache = null; this._corpusAt = 0; },

    /** Split playbook rows into what is still worth saying and what has become wallpaper. */
    triage(rows, { ceiling = null, limit = null } = {}) {
      const cap = ceiling == null ? this.cfg.saturationCeiling : ceiling;
      const corpus = this._corpus();
      const keep = [];
      const overused = [];
      for (const r of rows || []) {
        const s = this.saturation(r.key, corpus);
        (s >= cap ? overused : keep).push({ ...r, saturation: Math.round(s * 100) / 100 });
      }
      return {
        keep: keep.slice(0, limit == null ? this.cfg.maxTraits : limit),
        overused: overused.slice(0, 8),
      };
    },

    /** The phrases the account cannot stop writing, read straight off recent prompts. */
    stalePhrases(limit = 6, { ceiling = null } = {}) {
      const cap = ceiling == null ? this.cfg.saturationCeiling : ceiling;
      const corpus = this._corpus();
      if (corpus.length < 4) return [];
      const df = new Map();
      for (const row of corpus) {
        const words = row.trim().split(' ').filter((w) => w.length > 2 && !STOP.has(w));
        const seen = new Set();
        for (let i = 0; i < words.length; i++) {
          for (let n = 2; n <= 3 && i + n <= words.length; n++) {
            seen.add(words.slice(i, i + n).join(' '));
          }
        }
        for (const g of seen) df.set(g, (df.get(g) || 0) + 1);
      }
      const out = [];
      for (const [phrase, n] of df) {
        const share = n / corpus.length;
        if (share >= cap) out.push({ phrase, share: Math.round(share * 100) / 100 });
      }
      out.sort((a, b) => (b.share - a.share) || (b.phrase.length - a.phrase.length));
      const kept = [];
      for (const c of out) {
        if (kept.some((k) => k.phrase.includes(c.phrase))) continue;
        kept.push(c);
        if (kept.length >= limit) break;
      }
      return kept;
    },

    /** The stale-phrase warning as an instruction block. */
    staleBlock(stale) {
      if (!stale || !stale.length) return '';
      return `- YOU KEEP WRITING THESE. Each appears in at least ${Math.round((stale[0].share) * 100)}% of the last ${this._corpus().length} prompts this account produced: ${stale.map((s) => `"${s.phrase}" (${Math.round(s.share * 100)}%)`).join(', ')}.\n  This is repetition, not a house style. Do not use them this round — write scenes that would need entirely different words.`;
    },

    /** Pick axis values the recent work has *not* used. */
    freshAxes(k = null, { rng = Math.random } = {}) {
      const want = k == null ? this.cfg.axesPerRound : k;
      const corpus = this._corpus();
      const names = AXIS_NAMES.slice().sort(() => rng() - 0.5).slice(0, Math.min(want, AXIS_NAMES.length));
      const out = [];
      for (const axis of names) {
        const scored = AXES[axis].map((value) => ({
          value,
          used: this._axisUse(value, corpus),
          jitter: rng(),
        }));
        scored.sort((a, b) => (a.used - b.used) || (a.jitter - b.jitter));
        out.push({ axis, value: scored[0].value });
      }
      return out;
    },

    /** How present an axis value is in recent work — scored on its content words. */
    _axisUse(value, corpus) {
      const words = norm(value).split(' ').filter((w) => w.length > 3);
      if (!words.length || !corpus.length) return 0;
      let total = 0;
      for (const w of words) {
        let hits = 0;
        for (const r of corpus) if (r.includes(` ${w} `)) hits++;
        total += hits / corpus.length;
      }
      return total / words.length;
    },

    /** The axes as an instruction block. */
    axesBlock(axes) {
      if (!axes || !axes.length) return '';
      return [
        'THIS ROUND MUST VARY ALONG THESE AXES — the account has not used them recently.',
        'Treat each as a requirement for the scene, not a phrase to paste in:',
        ...axes.map((a) => `  · ${a.axis}: ${a.value}`),
      ].join('\n');
    },

    /** Choose which winner to grow from, with a cooldown. */
    pickSeed(recipes, { theme = '', rng = Math.random } = {}) {
      const pool = (recipes || []).filter((r) => r && r.prompt);
      if (!pool.length) return null;
      const ledger = this.ledger();
      const cooldown = this.cfg.seedCooldown;
      const fresh = pool.filter((r) => {
        const used = ledger.seeds[String(r.from == null ? r.title : r.from)];
        return used === undefined || (ledger.round - used) > cooldown;
      });
      const candidates = fresh.length ? fresh : pool;
      const themed = theme ? candidates.filter((r) => norm(r.theme) === norm(theme)) : [];
      const from = themed.length ? themed : candidates;
      const weights = from.map((r) => Math.max(0.2, Math.min(4, Number(r.vsPeers ?? r.perDay) || 1)));
      const total = weights.reduce((a, b) => a + b, 0);
      let x = rng() * total;
      for (let i = 0; i < from.length; i++) {
        x -= weights[i];
        if (x <= 0) return from[i];
      }
      return from[from.length - 1];
    },

    /** Rotation bookkeeping, persisted on the playbook so a restart does not reset it. */
    ledger() {
      const p = window.Insights && Insights.playbook;
      const l = (p && p.rotation) || null;
      if (l && l.seeds) return l;
      const blank = { round: 0, seeds: {}, modes: [] };
      if (p) p.rotation = blank;
      return blank;
    },

    noteSeedUsed(seed) {
      if (!seed) return;
      const l = this.ledger();
      l.seeds[String(seed.from == null ? seed.title : seed.from)] = l.round;
      this._save();
    },

    noteRound(mode) {
      const l = this.ledger();
      l.round = (l.round || 0) + 1;
      l.modes = [...(l.modes || []), mode].slice(-40);
      this._save();
      this.invalidate();
      return l.round;
    },

    _save() {
      if (window.Insights && Insights.playbook) Insights.persistPlaybook();
    },

    /** exploit / explore / wild for this round. */
    rollMode({ rng = Math.random } = {}) {
      if (!this.cfg.enabled) return 'exploit';
      const l = this.ledger();
      const recent = (l.modes || []).slice(-12);
      if (recent.length >= 6) {
        const share = (m) => recent.filter((x) => x === m).length / recent.length;
        if (share('wild') < this.cfg.wildRatio * 0.6) return 'wild';
        if (share('explore') + share('wild') < this.cfg.exploreRatio * 0.6) return 'explore';
      }
      const r = rng();
      if (r < this.cfg.wildRatio) return 'wild';
      if (r < this.cfg.wildRatio + this.cfg.exploreRatio) return 'explore';
      return 'exploit';
    },

    /** Human-readable, for the log line and the auto-mode status. */
    describeMode(mode) {
      return mode === 'wild'
        ? 'wildcard — your rules only, no learned guidance'
        : mode === 'explore'
          ? 'explore — lessons kept, winning prompt withheld'
          : 'exploit — full playbook';
    },

    /** Novelty bonus per theme, for auto mode's rotation. */
    themeNovelty(themes) {
      const out = new Map();
      const recent = (State.library || [])
        .slice()
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, this.cfg.recentWindow * 2);
      const counts = new Map();
      for (const c of recent) {
        const k = norm(c.theme);
        if (k) counts.set(k, (counts.get(k) || 0) + 1);
      }
      const n = recent.length || 1;
      for (const t of themes || []) {
        const k = norm(t.theme);
        const share = (counts.get(k) || 0) / n;
        out.set(k, 1 + this.cfg.noveltyBonus * (1 - Math.min(1, share * 2)));
      }
      return out;
    },
  };

  function num(v, d) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }

  Variety.AXES = AXES;
  Variety._norm = norm;
  window.Variety = Variety;
})();
