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
    const automatic = new Set(['ideation', 'evolved', 'explore', 'wild', 'continuation', 'teaser', 'overseer']);
    const automaticIds = new Set([...entries, ...devs, ...lib]
      .filter((r) => automatic.has(r.promptSource))
      .map((r) => String(r.deviationId || (r.da && r.da.deviationId) || '')).filter(Boolean));
    const eligible = (r, id = '') => r && !automatic.has(r.promptSource) && !automaticIds.has(String(id));
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
    const p = prof || profile();
    const measured = p.enough ? p.tail.filter((k) => GUARD_RE.test(k) || QUALITY_RE.test(k)) : [];
    const want = [...new Set([...measured, 'no extra fingers', 'no extra limbs'])];
    const low = t.toLowerCase();
    const missing = want.filter((k) => !low.includes(k.toLowerCase()));
    if (!missing.length) return t;
    return t.replace(/[,\s]+$/, '') + ', ' + missing.join(', ');
  }

  /** The best-formed, least alike of his prompts. */
  function exemplars({ n = SHOW, from = null } = {}) {
    const rows = (from || corpus()).map((c) => (typeof c === 'string' ? { text: c, src: '' } : c));
    const ranked = rows.map((r) => ({ ...r, score: houseScore(r.text) }))
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
  function block({ n = SHOW, maxChars = 2200 } = {}) {
    const rows = corpus();
    const p = profile(rows.map((r) => r.text));
    const ex = exemplars({ n, from: rows });
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

  window.PromptStyle = {
    SHOW,
    MIN_CORPUS,
    corpus,
    profile,
    exemplars,
    houseScore,
    enforceTail,
    block,
    clean: (s) => (window.U ? U.housePrompt(s) : s),
  };
})();
