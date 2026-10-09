/**
 * teach.js: the hand-written half of the playbook.
 *
 * Everything in insights.js is derived and changes on every rebuild. Instructions
 * the artist writes by hand must survive every rebuild, so they live in a separate
 * section that is never overwritten and always read first:
 *   lessons: free-text instructions, ranked above measured lessons
 *   rules:   always / never constraints
 *   banned:  phrases a prompt must not contain; CHECKED in code, not just requested
 *   boost:   manual weights on themes and tags
 *   examples: pictures the artist marked GOOD, each read by the vision model together with
 *            the artist's own words about it (what to repeat, never the subject itself)
 * `propose` turns a paragraph of the artist's words into structured lessons, but
 * only returns them. Nothing is saved without the artist accepting it.
 */
(function () {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  /** Content fingerprint for a derived lesson, stable across rebuilds that reword it. */
  const fingerprint = (text) => norm(text).split(' ').slice(0, 9).join(' ');

  const BLANK = () => ({
    lessons: [],
    rules: { always: [], never: [] },
    banned: [],
    boost: { themes: {}, tags: {} },
    pinned: [],
    muted: [],
    notes: '',
    examples: [],
    updatedAt: null,
  });

  const Teach = {
    /** The manual section, created on demand. */
    manual() {
      if (!window.Insights) return BLANK();
      if (!Insights.playbook) {
        Insights.playbook = {
          updatedAt: Date.now(), source: 'none', sampleSize: 0,
          themes: [], tags: [], promptTraits: [], titleTraits: [], timing: [],
          lessons: [], exemplars: [], recipes: [], summary: '',
        };
      }
      const p = Insights.playbook;
      if (!p.manual) p.manual = BLANK();
      const m = p.manual;
      if (!Array.isArray(m.lessons)) m.lessons = [];
      if (!m.rules || typeof m.rules !== 'object') m.rules = { always: [], never: [] };
      if (!Array.isArray(m.rules.always)) m.rules.always = [];
      if (!Array.isArray(m.rules.never)) m.rules.never = [];
      if (!Array.isArray(m.banned)) m.banned = [];
      if (!m.boost || typeof m.boost !== 'object') m.boost = { themes: {}, tags: {} };
      if (!m.boost.themes) m.boost.themes = {};
      if (!m.boost.tags) m.boost.tags = {};
      if (!Array.isArray(m.pinned)) m.pinned = [];
      if (!Array.isArray(m.muted)) m.muted = [];
      if (typeof m.notes !== 'string') m.notes = '';
      if (!Array.isArray(m.examples)) m.examples = [];
      return m;
    },

    _save() {
      const m = this.manual();
      m.updatedAt = Date.now();
      if (window.Insights) Insights.persistPlaybook();
      return m;
    },

    addLesson(text, { why = '', weight = 'prefer' } = {}) {
      const t = String(text || '').trim();
      if (!t) return null;
      const m = this.manual();
      const lesson = {
        id: (window.U && U.uid) ? U.uid() : `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
        text: t.slice(0, 600),
        why: String(why || '').trim().slice(0, 400),
        weight: weight === 'always' ? 'always' : 'prefer',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      m.lessons = [...m.lessons, lesson];
      this._save();
      return lesson;
    },

    updateLesson(id, patch = {}) {
      const m = this.manual();
      const l = m.lessons.find((x) => x.id === id);
      if (!l) return null;
      if (patch.text !== undefined) l.text = String(patch.text).trim().slice(0, 600);
      if (patch.why !== undefined) l.why = String(patch.why).trim().slice(0, 400);
      if (patch.weight !== undefined) l.weight = patch.weight === 'always' ? 'always' : 'prefer';
      l.updatedAt = Date.now();
      this._save();
      return l;
    },

    removeLesson(id) {
      const m = this.manual();
      const before = m.lessons.length;
      m.lessons = m.lessons.filter((x) => x.id !== id);
      if (m.lessons.length !== before) this._save();
      return m.lessons;
    },

    /** Move a lesson up or down — order is the priority order inside the guidance block. */
    moveLesson(id, delta) {
      const m = this.manual();
      const i = m.lessons.findIndex((x) => x.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= m.lessons.length) return m.lessons;
      const copy = m.lessons.slice();
      [copy[i], copy[j]] = [copy[j], copy[i]];
      m.lessons = copy;
      this._save();
      return m.lessons;
    },

    isPinned(text) { return this.manual().pinned.includes(fingerprint(text)); },
    isMuted(text) { return this.manual().muted.includes(fingerprint(text)); },

    /** Keep a derived lesson through the next rebuild. */
    pin(text, why = '') {
      const m = this.manual();
      const f = fingerprint(text);
      if (!f) return m;
      m.muted = m.muted.filter((x) => x !== f);
      if (!m.pinned.includes(f)) {
        m.pinned = [...m.pinned, f];
        m.lessons = [...m.lessons, {
          id: (window.U && U.uid) ? U.uid() : `p${Date.now().toString(36)}`,
          text: String(text).trim().slice(0, 600),
          why: String(why || '').trim().slice(0, 400),
          weight: 'prefer',
          adopted: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }];
      }
      this._save();
      return m;
    },

    unpin(text) {
      const m = this.manual();
      const f = fingerprint(text);
      m.pinned = m.pinned.filter((x) => x !== f);
      m.lessons = m.lessons.filter((l) => !(l.adopted && fingerprint(l.text) === f));
      this._save();
      return m;
    },

    /** Kill a derived lesson for good — it will not come back from a rebuild. */
    mute(text) {
      const m = this.manual();
      const f = fingerprint(text);
      if (!f) return m;
      m.pinned = m.pinned.filter((x) => x !== f);
      m.lessons = m.lessons.filter((l) => !(l.adopted && fingerprint(l.text) === f));
      if (!m.muted.includes(f)) m.muted = [...m.muted, f];
      if (window.Insights && Insights.playbook) {
        Insights.playbook.lessons = (Insights.playbook.lessons || [])
          .filter((l) => fingerprint(l.lesson) !== f);
      }
      this._save();
      return m;
    },

    unmute(text) {
      const m = this.manual();
      m.muted = m.muted.filter((x) => x !== fingerprint(text));
      this._save();
      return m;
    },

    /** Filter a freshly derived lesson list against the muted set. */
    filterDerived(lessons) {
      const m = this.manual();
      if (!m.muted.length) return lessons || [];
      return (lessons || []).filter((l) => !m.muted.includes(fingerprint(l && l.lesson)));
    },

    setRules({ always, never } = {}) {
      const m = this.manual();
      const clean = (arr) => (Array.isArray(arr) ? arr : String(arr || '').split('\n'))
        .map((x) => String(x).trim())
        .filter(Boolean)
        .slice(0, 20)
        .map((x) => x.slice(0, 240));
      if (always !== undefined) m.rules.always = clean(always);
      if (never !== undefined) m.rules.never = clean(never);
      this._save();
      return m.rules;
    },

    setBanned(list) {
      const m = this.manual();
      m.banned = (Array.isArray(list) ? list : String(list || '').split(/[\n,]/))
        .map((x) => String(x).trim().toLowerCase())
        .filter(Boolean)
        .filter((x, i, a) => a.indexOf(x) === i)
        .slice(0, 60)
        .map((x) => x.slice(0, 80));
      this._save();
      return m.banned;
    },

    setNotes(text) {
      const m = this.manual();
      m.notes = String(text || '').slice(0, 2000);
      this._save();
      return m.notes;
    },

    setBoost(kind, key, mult) {
      const m = this.manual();
      const bucket = kind === 'tags' ? m.boost.tags : m.boost.themes;
      const k = norm(key);
      if (!k) return m.boost;
      const n = Number(mult);
      if (!Number.isFinite(n) || n === 1) delete bucket[k];
      else bucket[k] = Math.max(0, Math.min(5, n));
      this._save();
      return m.boost;
    },

    /** Which banned phrases a prompt actually contains. */
    violations(prompt) {
      const m = this.manual();
      if (!m.banned.length) return [];
      const hay = ` ${norm(prompt)} `;
      return m.banned.filter((b) => {
        const n = norm(b);
        return n && hay.includes(` ${n} `);
      });
    },

    /** Drop prompts that break a ban. */
    screen(prompts) {
      const kept = [];
      const dropped = [];
      for (const p of prompts || []) {
        const bad = this.violations(p);
        if (bad.length) dropped.push({ prompt: p, banned: bad });
        else kept.push(p);
      }
      return { kept, dropped };
    },

    /** The manual block for the guidance prompt. */
    block({ hard = false } = {}) {
      const m = this.manual();
      const lines = [];
      const always = m.rules.always.filter(Boolean);
      const never = m.rules.never.filter(Boolean);
      const own = hard ? m.lessons.filter((l) => l.weight === 'always') : m.lessons;
      const examples = hard ? [] : (m.examples || []).slice(-6);

      if (own.length || always.length || never.length || m.banned.length || m.notes.trim() || examples.length) {
        lines.push("THE ARTIST'S OWN INSTRUCTIONS — these outrank everything measured below:");
      }
      for (const l of own.slice(0, 20)) {
        lines.push(`  · ${l.weight === 'always' ? '[ALWAYS] ' : ''}${l.text}`);
      }
      for (const r of always) lines.push(`  · ALWAYS: ${r}`);
      for (const r of never) lines.push(`  · NEVER: ${r}`);
      if (m.banned.length) {
        lines.push(`  · These words and phrases are BANNED and must not appear in any prompt: ${m.banned.join(', ')}`);
      }
      if (m.notes.trim()) lines.push(`  · Context from the artist: ${m.notes.trim().slice(0, 500)}`);
      for (const x of examples) {
        const bits = [x.summary, x.note ? `the artist said: "${x.note.slice(0, 240)}"` : '', x.traits.length ? `repeat: ${x.traits.join(', ')}` : '']
          .filter(Boolean).join(' — ');
        if (bits) lines.push(`  · A picture the artist marked GOOD: ${bits}`);
      }
      return lines.join('\n');
    },

    /** Is there anything hand-written at all? */
    isEmpty() {
      const m = this.manual();
      return !m.lessons.length && !m.rules.always.length && !m.rules.never.length
        && !m.banned.length && !m.notes.trim() && !m.examples.length
        && !Object.keys(m.boost.themes).length && !Object.keys(m.boost.tags).length;
    },

    count() {
      const m = this.manual();
      return m.lessons.length + m.rules.always.length + m.rules.never.length + m.banned.length;
    },

    // ---------- good examples: a picture + the artist's words, read by vision ----------

    /**
     * Show the vision model a picture the artist marked GOOD, together with what THEY say is
     * good about it, and get back what to repeat. Returns a proposal only; nothing is saved
     * until `addExample` (the artist sees it first).
     */
    async readExample({ base64, mime = 'image/png', note = '', prompt = '' } = {}) {
      if (!base64) throw new Error('no picture to look at');
      const said = String(note || '').trim().slice(0, 1200);
      const ask = `An artist marked this picture as a GOOD example: more of their AI art should be like it.
${said ? `What THEY say makes it good — this comes first, build everything around it:\n"""${said}"""\n` : 'They did not say why, so work it out from the picture itself.\n'}${prompt ? `It was generated from this prompt (context only — judge the picture, not the prompt):\n"""${String(prompt).slice(0, 1200)}"""\n` : ''}
Look at the picture. Name the qualities that make it work — composition, framing and camera, pose and expression, lighting, palette, mood, background, rendering style — and turn them into instructions a prompt writer can follow for NEW pictures.
- Their words decide what matters; use what you see to make each point concrete ("warm rim light from a window behind her", not "nice lighting").
- Describe what to REPEAT, not this exact scene: no character names, no identity details, nothing that only fits this one picture.
- Never mention flaws, hands, anatomy or render defects; this is about what is good.
- 1 to 3 lessons. Do not pad.

Respond ONLY with JSON:
{"summary": "one sentence: what is good about it", "traits": ["short visual trait", "..."], "lessons": [{"text": "instruction for future prompts", "why": "what in the picture shows it"}]}`;
      const r = await U.llmVision(base64, mime, ask, { role: 'vision', temperature: 0.3, maxTokens: 3000 }, 'Reading your good example');
      const j = U.extractJson(r.text) || {};
      const lessons = (Array.isArray(j.lessons) ? j.lessons : [])
        .map((l) => ({ text: String((l && l.text) || '').trim(), why: String((l && l.why) || '').trim() }))
        .filter((l) => l.text)
        .slice(0, 3);
      if (!lessons.length) throw new Error('the vision model did not say anything concrete about it');
      return {
        summary: String(j.summary || '').trim().slice(0, 300),
        traits: (Array.isArray(j.traits) ? j.traits : []).map((t) => String(t || '').trim()).filter(Boolean).slice(0, 8),
        lessons,
        note: said,
        engine: r.provider || r.engine || '',
        model: r.model || '',
      };
    },

    /** Save an accepted example: the picture reference, the artist's words and its lessons. */
    addExample({ cardId = null, fname = '', note = '', summary = '', traits = [], lessons = [], engine = '', model = '' } = {}) {
      const m = this.manual();
      const id = (window.U && U.uid) ? U.uid() : `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const ex = {
        id, cardId, fname: String(fname || ''),
        note: String(note || '').slice(0, 1200),
        summary: String(summary || '').slice(0, 300),
        traits: (traits || []).map(String).slice(0, 8),
        engine: String(engine || ''), model: String(model || ''),
        createdAt: Date.now(),
      };
      // Drop an older example of the same picture: marking it again replaces the reading.
      if (cardId) {
        const old = m.examples.filter((x) => x.cardId === cardId).map((x) => x.id);
        if (old.length) {
          m.examples = m.examples.filter((x) => !old.includes(x.id));
          m.lessons = m.lessons.filter((l) => !old.includes(l.exampleId));
        }
      }
      m.examples = [...m.examples, ex].slice(-24);
      const now = Date.now();
      m.lessons = [...m.lessons, ...(lessons || []).filter((l) => l && l.text).map((l, i) => ({
        id: `${id}-${i}`,
        text: String(l.text).trim().slice(0, 600),
        why: `From a picture you marked good${ex.summary ? ` (${ex.summary})` : ''}${l.why ? ` — ${l.why}` : ''}`.slice(0, 400),
        weight: 'prefer',
        exampleId: id,
        createdAt: now,
        updatedAt: now,
      }))];
      this._save();
      return ex;
    },

    /** Forget an example and the lessons it produced. */
    removeExample(id) {
      const m = this.manual();
      const before = m.examples.length;
      m.examples = m.examples.filter((x) => x.id !== id);
      m.lessons = m.lessons.filter((l) => l.exampleId !== id);
      if (m.examples.length !== before) this._save();
      return m.examples;
    },

    /** Turn a paragraph of the artist's own words into structured lessons and rules. */
    async propose(text) {
      const raw = String(text || '').trim();
      if (!raw) throw new Error('nothing to learn from');
      const prompt = `An artist is teaching their AI art pipeline something. Convert what they said into structured, actionable entries.

WHAT THEY SAID:
"""${raw.slice(0, 2000)}"""

Rules for the conversion:
- Keep their meaning exactly. Do not add advice they did not give, and do not soften an instruction into a suggestion.
- A "lesson" is a concrete instruction for writing an image prompt or its metadata.
- Use weight "always" only if they clearly meant it as absolute ("never", "every time", "must"). Otherwise "prefer".
- "never" rules are things that must not happen. "banned" is for specific words or phrases they want out of prompts entirely.
- If they only said one thing, return one entry. Do not pad.

Respond ONLY with JSON:
{"lessons":[{"text":"...","why":"...","weight":"prefer"|"always"}],"always":["..."],"never":["..."],"banned":["..."]}`;

      const { text: out } = await U.llmChat(
        [{ role: 'user', content: prompt }],
        { temperature: 0.3, maxTokens: 3000, role: 'metadata' }, 'Reading your instructions');
      const j = U.extractJson(out) || {};
      const arr = (x) => (Array.isArray(x) ? x : []).map((s) => String(s || '').trim()).filter(Boolean);
      return {
        lessons: (Array.isArray(j.lessons) ? j.lessons : [])
          .map((l) => ({
            text: String((l && l.text) || '').trim(),
            why: String((l && l.why) || '').trim(),
            weight: (l && l.weight) === 'always' ? 'always' : 'prefer',
          }))
          .filter((l) => l.text),
        always: arr(j.always),
        never: arr(j.never),
        banned: arr(j.banned).map((s) => s.toLowerCase()),
      };
    },

    /** Commit an accepted proposal, merging rather than replacing. */
    applyProposal(p) {
      const m = this.manual();
      for (const l of p.lessons || []) this.addLesson(l.text, { why: l.why, weight: l.weight });
      if ((p.always || []).length) this.setRules({ always: [...m.rules.always, ...p.always] });
      if ((p.never || []).length) this.setRules({ never: [...this.manual().rules.never, ...p.never] });
      if ((p.banned || []).length) this.setBanned([...this.manual().banned, ...p.banned]);
      return this.manual();
    },
  };

  Teach._fingerprint = fingerprint;
  Teach._blank = BLANK;
  window.Teach = Teach;
})();
