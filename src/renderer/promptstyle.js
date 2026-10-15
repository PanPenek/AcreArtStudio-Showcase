/**
 * promptstyle.js: the artist's own prompt "voice", measured from their prompts.
 *
 * Diffusion models respond best to a compact form: comma-separated fragments, the
 * subject and action first, descriptive tags after, quality tokens last, no prose.
 * Asked to "write a prompt", most language models write an art-director paragraph
 * instead. This module fixes that in two steps:
 *   - EVIDENCE: hand the writer real example prompts plus measured facts about
 *     them (length, fragment count, tag habits), so it can match a form it can see;
 *   - ENFORCEMENT: normalise the result in code afterwards (strip a leading
 *     "Illustration of...", append missing quality tags).
 */
(function () {
  const SHOW = 3;

  const MIN_CORPUS = 6;

  const TAIL_FROM = 0.6;

  /** The medium-naming opener, owned by U so the detector and the stripper cannot drift apart. */
  const LEAD_RE = (window.U && U.MEDIUM_LEAD_RE) || /^$/;

  const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
  const frags = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);

  /** Shorten an exemplar at a fragment boundary. */
  function trim(text, max) {
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    const at = cut.lastIndexOf(',');
    return (at > max * 0.5 ? cut.slice(0, at) : cut.trimEnd()) + '…';
  }

  /** How much a prompt reads like one of his rather than like an art-director caption. */
  function houseScore(p, prof = null) {
    const text = String(p || '').trim();
    if (!text) return -99;
    const w = words(text);
    const f = frags(text);
    let score = 0;
    score += Math.min(3, (f.length / Math.max(1, w)) * 30);
    score -= (text.match(/\.\s+[A-Z]/g) || []).length * 2;
    score -= (text.match(/\b(?:she|he|they)\s+(?:is|are|was|were|feels?|seems?|appears?|looks?)\b/gi) || []).length;
    if (/^[a-z0-9]/.test(text)) score += 1;
    if (LEAD_RE.test(text)) score -= 6;
    if (prof && prof.enough) {
      const t = text.toLowerCase();
      if (prof.tail.length) score += prof.tail.some((k) => t.includes(k)) ? 2 : -1;
      if (w >= prof.lo && w <= prof.hi) score += 1;
      else if (w > prof.hi * 1.5 || w < prof.lo * 0.6) score -= 2;
    }
    return score;
  }

  /** The artist's own prompts, best evidence first. */
  function corpus({ limit = 60 } = {}) {
    const out = [];
    const seen = new Set();
    const push = (text, src) => {
      const t = String(text || '').trim();
      if (t.length < 40) return;
      const key = t.slice(0, 120).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ text: t, src });
    };

    const recipes = (window.Insights && window.Insights.playbook && window.Insights.playbook.recipes) || [];
    const entries = (window.Origins && window.Origins.data && window.Origins.data.entries) || [];
    const devs = (window.Insights && window.Insights.perf && window.Insights.perf.deviations) || [];
    const lib = (window.State && State.library) || [];
    const automatic = new Set(['ideation', 'evolved', 'explore', 'wild', 'continuation', 'teaser', 'overseer', 'edit']);
    const automaticIds = new Set([...entries, ...devs, ...lib]
      .filter((r) => automatic.has(r.promptSource))
      .map((r) => String(r.deviationId || (r.da && r.da.deviationId) || '')).filter(Boolean));
    const eligible = (r, id = '') => r && !automatic.has(r.promptSource) && !automaticIds.has(String(id));
    if (prose()) {
      const refd = (c) => (window.Insights && Insights.isReferencePrompt) ? Insights.isReferencePrompt(c) : /<image\d+>/i.test(String(c.prompt || ''));
      const mine = lib.filter((c) => c && c.promptStyle === 'prose' && !refd(c) && eligible(c, c.da && c.da.deviationId));
      for (const c of mine) if (c.da && c.da.deviationId) push(c.prompt, 'card');
      for (const c of mine) if (['approved', 'drafted'].includes(c.status)) push(c.prompt, 'card');
      return out.slice(0, limit);
    }
    for (const r of recipes) if (eligible(r, r && r.from)) push(r.prompt, 'recipe');
    for (const e of entries) {
      if (eligible(e, e && e.deviationId) && (e.link === 'upload' || e.link === 'manual' || !e.link)) push(e.prompt, 'origin');
    }
    for (const c of lib) {
      if (eligible(c, c && c.da && c.da.deviationId) && ['approved', 'drafted'].includes(c.status)) push(c.prompt, 'card');
    }

    return out.slice(0, limit);
  }

  /** The measurable facts about that corpus. */
  function profile(list = null) {
    const rows = (list || corpus().map((c) => c.text)).filter(Boolean);
    if (rows.length < MIN_CORPUS) return { n: rows.length, enough: false };

    const w = rows.map(words);
    const f = rows.map((r) => frags(r).length);

    const tally = new Map();
    for (const r of rows) {
      const parts = frags(r);
      const present = new Set();
      for (const t of parts.slice(Math.floor(parts.length * TAIL_FROM))) {
        const k = t.toLowerCase().replace(/[.;]+$/, '');
        if (k.split(/\s+/).length > 3 || k.length < 2) continue;
        present.add(k);
      }
      for (const k of present) tally.set(k, (tally.get(k) || 0) + 1);
    }
    const tail = [...tally.entries()]
      .filter(([, n]) => n >= Math.max(2, Math.round(rows.length * 0.1)))
      .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k);

    return {
      n: rows.length,
      enough: true,
      words: median(w),
      lo: Math.max(30, Math.round(median(w) * 0.7)),
      hi: Math.round(median(w) * 1.35),
      frags: median(f),
      lowerStart: rows.filter((r) => /^[a-z0-9]/.test(r)).length / rows.length,
      tail,
    };
  }

  const GUARD_RE = /^no\s+\S/i;
  const QUALITY_RE = /^(?:masterpiece(?:\s+quality)?|best quality|high(?:est)? quality|[48]k|professional camera(?:\s+lens)?|cinematic|painted anime|anime screencap|3d)$/i;

  /** Append the guard and quality tags a generated prompt is missing. */
  function enforceTail(text, prof = null) {
    const t = String(text || '').trim();
    if (!t) return t;
    if (prose()) return stripTags(t);
    const p = prof || profile();
    const measured = p.enough ? p.tail.filter((k) => GUARD_RE.test(k) || QUALITY_RE.test(k)) : [];
    const want = [...new Set([...measured, 'no extra fingers', 'no extra limbs'])];
    const low = t.toLowerCase();
    const missing = want.filter((k) => !low.includes(k.toLowerCase()));
    if (!missing.length) return t;
    return t.replace(/[,\s]+$/, '') + ', ' + missing.join(', ');
  }

  /** Qwen-Image on ComfyUI reads plain sentences better than tag lists (on unless gen.qwenProse is false). */
  function prose() {
    const g = (window.State && State.settings && State.settings.gen) || {};
    return g.engine === 'comfy' && g.qwenProse !== false;
  }

  const TAG_ONLY_RE = /^(?:masterpiece(?:\s+quality)?|best quality|high(?:est)? quality|ultra[- ]?detailed|highres|absurdres|[248]k(?:\s+resolution)?|uhd|professional camera(?:\s+lens)?|1girl|1boy|2girls|solo|alone|no\s+(?:extra|artifacts?|text|watermarks?|deformed|bad|mutated|missing|duplicate|blur(?:ry)?)\b[^,]*)$/i;

  /** Drop tag-list fragments (quality tokens, "no X" guards) from a sentence prompt. */
  function stripTags(text) {
    const t = String(text || '').trim();
    if (!t) return t;
    const parts = t.split(',');
    const kept = parts.filter((p) => !TAG_ONLY_RE.test(p.trim().replace(/[.;:!]+$/, '').trim()));
    if (kept.length === parts.length) return t;
    let out = kept.join(',').replace(/(?:\s*,\s*)+$/, '').replace(/,(\s*,)+/g, ',').trim();
    if (/[.!?"]$/.test(t) && !/[.!?"]$/.test(out)) out += '.';
    return out;
  }

  const PROSE_LO = 60;
  const PROSE_HI = 130;

  /** Writing rules for sentence prompts; `arm` decides whether the moment or the character comes first. */
  function proseRules(arm = 'action') {
    const order = arm === 'character'
      ? [
        'The FIRST sentence says who the character is: a named character by name and series ("Frieren from'
          + ' Sousou no Frieren, an elf mage with long white twin tails ..."), otherwise their look: hair, eyes, build and'
          + ' what they are wearing.',
        'Then what is happening to them right now and how they react (surprise, joy, focus,'
          + ' determination), then the place, the light and the camera angle. A short spoken'
          + ' line in quotes is welcome when it fits.',
      ]
      : [
        'The FIRST sentence is the moment itself: what is happening to the character right now and how they react'
          + ' (surprise, joy, focus, determination). If a named character is'
          + ' pictured, name them in that first sentence ("Frieren from Sousou no Frieren looks up as ...").',
        'Then their look (hair, eyes, build, outfit), then the place, the light and the camera'
          + ' angle. A short spoken line in quotes is welcome when it fits.',
      ];
    return [
      `Write plain English sentences for Qwen-Image, not a tag list: 3-6 sentences, ${PROSE_LO}-${PROSE_HI} words.`,
      ...order,
      'End with one short art-style sentence, e.g. "Painted anime style, dramatic rim light."',
      'No quality tokens or tag soup: never "1girl", "solo", "masterpiece", "best quality", "4k". Never write'
        + ' "no X" ("no extra fingers", "no text"): this generator has no negative prompt, so naming a thing draws it.',
      'Never open by naming the medium ("anime illustration", "digital art of", "an image of").',
    ];
  }

  function lengthRule(prof = null) {
    if (prose()) return `${PROSE_LO}-${PROSE_HI} words each, in plain sentences.`;
    const p = prof || profile();
    return p.enough
      ? `${p.lo}-${p.hi} words each, in comma-separated fragments — that is this artist's measured range.`
      : '40-90 words each.';
  }

  function proseScore(p) {
    const text = String(p || '').trim();
    if (!text) return -99;
    const w = words(text);
    const fr = frags(text);
    let score = 3;
    const tags = fr.filter((x) => TAG_ONLY_RE.test(x.replace(/[.;:!]+$/, '').trim())).length;
    score -= tags * 2;
    if (LEAD_RE.test(text)) score -= 6;
    if (w < PROSE_LO * 0.6 || w > PROSE_HI * 1.5) score -= 2;
    const short = fr.filter((x) => words(x) <= 3).length;
    if (fr.length >= 8 && short / fr.length > 0.6) score -= 3;
    return score;
  }

  function voiceScore(p, prof = null) {
    return prose() ? proseScore(p) : houseScore(p, prof);
  }

  /** The best-formed, least alike of his prompts. */
  function exemplars({ n = SHOW, from = null } = {}) {
    const rows = (from || corpus()).map((c) => (typeof c === 'string' ? { text: c, src: '' } : c));
    const ranked = rows.map((r) => ({ ...r, score: prose() ? proseScore(r.text) : houseScore(r.text) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
    const sim = window.promptSimilarity || (() => 0);
    const kept = [];
    for (const r of ranked) {
      if (kept.length >= n) break;
      if (!kept.some((k) => sim(k.text, r.text) > 0.5)) kept.push(r);
    }
    return kept;
  }

  /** The block pasted into a prompt-writing call. */
  function block({ n = SHOW, maxChars = 2200, arm = 'action' } = {}) {
    const rows = corpus();
    const p = profile(rows.map((r) => r.text));
    const ex = exemplars({ n, from: rows });
    if (prose()) {
      const lines = [
        'HOW TO WRITE FOR THIS GENERATOR (Qwen-Image 2.1 on ComfyUI). It reads plain English, not tag lists:',
        ...proseRules(arm).map((r) => `- ${r}`),
      ];
      if (ex.length) {
        lines.push('',
          `QWEN PROMPTS OF HIS — ${ex.length} he kept. Match how they are written, not what they show:`,
          ...ex.map((r, i) => `[${i + 1}] """${trim(r.text, 600)}"""`));
      }
      const out = lines.join('\n');
      return out.length > maxChars ? out.slice(0, maxChars) + '…' : out;
    }
    if (!p.enough || !ex.length) return '';

    const lines = [
      `HOW THIS ARTIST WRITES PROMPTS — measured on ${p.n} of his own, not invented. Match this form:`,
      '- Comma-separated fragments, not sentences. No narration and no scene-setting prose:'
        + ' write what is in the picture, not what is happening to the person in it.',
      '- NEVER open by naming the medium. "anime illustration", "digital art of", "an image of",'
        + ' "a portrait of" are banned openings. The first fragment is the subject and what is'
        + ' being done to it — that is the position the generator weights hardest, and it is not'
        + ' for the word "illustration".',
      `- About ${p.words} words across ${p.frags} comma-separated fragments (${p.lo}-${p.hi} words is the band).`,
    ];
    if (p.lowerStart >= 0.6) {
      lines.push(`- ${Math.round(p.lowerStart * 100)}% of his prompts start lowercase, mid-thought. Do the same.`);
    }
    if (p.tail.length) {
      lines.push(`- The last fragments are tags, not prose. The ones he closes with most: ${p.tail.join(', ')}.`);
    }
    lines.push('',
      'HIS OWN PROMPTS — copy the shape, not the content:',
      ...ex.map((r, i) => `[${i + 1}] """${trim(r.text, 700)}"""`));

    const out = lines.join('\n');
    return out.length > maxChars ? out.slice(0, maxChars) + '…' : out;
  }

  const ARM_KEY = 'acre.promptArms';
  const ARM_CAP = 3000;
  let armMap = null;
  function arms() {
    if (armMap) return armMap;
    try { armMap = new Map(JSON.parse(localStorage.getItem(ARM_KEY) || '[]')); } catch { armMap = new Map(); }
    return armMap;
  }
  function armKey(text) {
    const cleaned = window.U && U.housePrompt ? U.housePrompt(String(text || '')) : String(text || '');
    return stripTags(cleaned).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 200);
  }

  /** Prompt-order test: half the prompts open with the moment, half with the character, to learn which works. */
  function pickArm(rnd = Math.random) {
    if (!prose()) return null;
    const g = (window.State && State.settings && State.settings.gen) || {};
    if (g.promptOrderTest === false) return 'action';
    return rnd() < 0.5 ? 'action' : 'character';
  }

  function noteArm(texts, arm) {
    if (!arm) return;
    const m = arms();
    for (const t of [].concat(texts || [])) {
      const k = armKey(t && typeof t === 'object' ? t.prompt : t);
      if (k.length >= 20) { m.delete(k); m.set(k, arm); }
    }
    while (m.size > ARM_CAP) m.delete(m.keys().next().value);
    try { localStorage.setItem(ARM_KEY, JSON.stringify([...m])); } catch {  }
  }

  function armOf(text) {
    const k = armKey(text);
    return (k && arms().get(k)) || null;
  }

  window.PromptStyle = {
    SHOW,
    MIN_CORPUS,
    corpus,
    profile,
    exemplars,
    houseScore,
    enforceTail,
    block,
    prose,
    proseRules,
    proseScore,
    voiceScore,
    lengthRule,
    stripTags,
    pickArm,
    noteArm,
    armOf,
    clean: (s) => (window.U ? U.housePrompt(s) : s),
  };
})();
