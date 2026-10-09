/**
 * pipeline.js: the automation orchestrator, the heart of the app.
 *
 * One job = one prompt. Its path through the pipeline:
 *   ideate -> generate -> save -> quality check -> metadata -> Review (human)
 *          -> on approval: publish / upload
 * Generation and inspection run as two lanes in parallel: while the GPU renders
 * the next job, the previous batch is being checked, so neither waits for the
 * other. AutoMode (bottom of the file) runs rounds unattended: it picks a theme,
 * writes prompts, respects hourly limits and stop conditions, and rebuilds the
 * learned playbook as results come in.
 *
 * Quality check is designed not to be a rubber stamp: the vision model must list
 * defects before it may score, and three independent checks in code (a general
 * rating, a veto on structural defects such as extra fingers, and a detail metric
 * measured on the pixels) can only LOWER the score, never raise it.
 */
(function () {
  const DESCRIPTION_BRIEFS = {
    brief: '2-4 sentences. Artistic and warm. Describes the scene, mood, aesthetic.',
    story: '4-7 sentences, roughly 70-130 words, written as a small story rather than a caption.' + ' Put the reader in the moment: what is happening right now, what led to it, what the character is' + ' thinking and noticing. Present tense. Do not list what is in the picture; the picture is already there.' + ' End on a beat that leaves something still happening.',
    scene: '8-12 sentences, roughly 150-260 words, written as a scene from a story.' + ' Open in the middle of the moment, give it a before and an after, and let the character think and' + ' react in their own voice — at least one line of interior monologue or spoken dialogue.' + ' Sensory and specific: sounds, weather, light, small actions. End on a hook' + ' rather than a summary.',
    expanded: '14-20 sentences, roughly 300-450 words — a proper short piece of writing, not a' + ' listing. Give it a shape: how the moment started, what turns partway through it, and' + ' where it leaves the character. Let them think and speak in their own voice. Slow down on small' + ' details: the weather, the light, the sounds, what their hands are doing. Whatever is visible' + ' in the picture has to arrive inside the story, never as a list.'
  };

  /** The configured description instruction, falling back to the house default. */
  const descriptionBrief = () => {
    const m = (State.settings || {}).metadata || {};
    if (m.expandedStorytelling) return DESCRIPTION_BRIEFS.expanded;
    const key = String(m.descriptionStyle || 'story');
    return DESCRIPTION_BRIEFS[key] || DESCRIPTION_BRIEFS.story;
  };

  /** Extra completion budget one expanded description needs, in tokens. */
  const descriptionHeadroom = (count = 1) =>
    (((State.settings || {}).metadata || {}).expandedStorytelling ? 900 * count : 0);

  /** Optional footer line appended to every description (empty by default). */
  const descriptionFooter = () => String(((State.settings || {}).metadata || {}).descriptionFooter || '').trim();

    function hasDescriptionFooter(text) {
    const t = String(text || '');
    if (!t.trim()) return false;
    const line = descriptionFooter();
    const norm = (x) => String(x).toLowerCase().replace(/\s+/g, ' ').trim();
    return !!line && norm(t).includes(norm(line));
  }

  /** The text one metadata field should ship as — the clipboard, a preview, a caption. */
  function publishField(meta, field) {
    const raw = String(((meta || {})[field]) || "").trim();
    if (!raw) return "";
    return field === "description" ? withDescriptionFooter(raw) : raw;
  }

  function withDescriptionFooter(text) {
    const body = String(text || '').trim();
    const line = descriptionFooter();
    if (!line) return body;
    if (hasDescriptionFooter(body)) return body;
    return body ? `${body}\n\n${line}` : line;
  }

  /** Told to the writer so it does not produce a second one in its own words. */
  const noFooterRule = () => (descriptionFooter()
    ? '\n- Do NOT write any footer or sign-off line. That line is'
      + ' appended automatically underneath and a second one in your own words reads as a stutter.'
    : '');

  const ALTS_RULE = `2. "alts": TWO more titles for this same image, same rules, ranked best first. `
    + `They are used only if the first one turns out to be already taken in this gallery, `
    + `so they must be genuinely DIFFERENT ideas — a different image in the mind, a different `
    + `angle on the moment — not the first title reworded.`;

  const HARD_DEFECT_RE = /\b(?:fus(?:e|ed|es|ing|ion)|malform\w*|deform\w*|distort\w*|blob\w*|shapeless|melt(?:ed|ing|y)?|merg(?:e|ed|es|ing)|amputat\w*|detach\w*|disembod\w*|mangl\w*|mitten|no (?:distinct |clear |separate )?(?:knuckles|fingers|digits)|extra (?:arm|leg|limb|hand|finger|digit|head|ear|eye)|missing (?:arm|leg|limb|hand|finger|digit|foot|ear|eye|head)|(?:three|four|5|6|seven) (?:arms|legs|hands|fingers)|two (?:left|right) (?:hands|arms|legs|feet)|not attached|ends? in nothing|neck (?:merges|melts|disappears)|(?:arm|leg|limb|hand|finger|digit|foot|ear|eye|head|thumb)\s+(?:is\s+|are\s+|was\s+|were\s+)?(?:missing|absent|gone|amputated|detached|severed|cut off))\b/i;

  const NEGATION_RE = /\b(?:no|not|never|without|free of|absence of|none of|nothing)\b/gi;
  const CLAUSE_BREAK_RE = /[.;:!?]|\b(?:but|however|though|although|except|whereas|yet|and then)\b|\band\s+(?:the\s+)?(?:left|right|other)\b/i;

  function negatedFinding(s, match) {
    const before = s.slice(Math.max(0, match.index - 48), match.index);
    NEGATION_RE.lastIndex = 0;
    let last = null, n;
    while ((n = NEGATION_RE.exec(before))) last = n;
    return !!last && !CLAUSE_BREAK_RE.test(before.slice(last.index + last[0].length));
  }

  /** The hard-defect words in one piece of text, with clean mentions filtered out. */
  function hardDefectWords(text) {
    const s = String(text || '');
    const re = new RegExp(HARD_DEFECT_RE.source, 'gi');
    const out = [];
    let m;
    while ((m = re.exec(s))) {
      if (negatedFinding(s, m)) continue;
      if (/^5 fingers$/i.test(m[0])) continue;
      const w = m[0].toLowerCase().trim();
      if (!out.includes(w)) out.push(w);
    }
    return out;
  }

  const FINGER_HIDDEN_RE = /not visible|not shown|not in (?:frame|view)|out of (?:frame|view)|off-?screen|cropped|behind|occlud|obscur|tucked|hidden|partly|partially|part of the frame|edge of the frame/i;
  const FINGER_BAD_RE = /\b(?:blob\w*|fus(?:ed|ion|ing)?|shapeless|mush\w*|mangl\w*|malform\w*|mitten\w*|paw\w*|stub\w*|merg\w*|smear\w*|no (?:clear |distinct |separate |visible )?(?:fingers|digits|thumb)|thumb (?:missing|absent|merged)|wrong number)\b/gi;
  const FINGER_VAGUE_RE = /\b(?:indistinct|unclear|undefined)\b/gi;
  const FINGER_UNCOUNTABLE_RE = /\b(?:not countable|uncountable|cannot (?:be )?count(?:ed)?|can't count)\b/i;
  const FINGER_RANGE_RE = /(\d)\s*(?:-|–|—|to|or)\s*(\d)/;
  const FINGER_PLUS_THUMB_RE = /(?:\+|\bplus\b|\band\b)\s*(?:a |one |the |its )?thumb\b/i;

  /** Read one `fingerCounts` string into per-hand verdicts. */
  function fingerReport(str, { handsVerdict = null } = {}) {
    const s = String(str || '');
    const region = String(handsVerdict || '').trim().toUpperCase();
    const segs = s.split(/[;.\n]|,\s*(?=(?:left|right|both)\b)/i).map((x) => x.trim()).filter(Boolean);
    const hands = [];
    for (const seg of segs) {
      const side = /\bleft\b/i.test(seg) ? 'left' : /\bright\b/i.test(seg) ? 'right' : /hand|finger/i.test(seg) ? 'hands' : null;
      if (!side) continue;
      const structural = [...seg.matchAll(FINGER_BAD_RE)].some((m) => !negatedFinding(seg, m));
      const vague = [...seg.matchAll(FINGER_VAGUE_RE)].some((m) => !negatedFinding(seg, m));
      const occluded = FINGER_HIDDEN_RE.test(seg) || FINGER_UNCOUNTABLE_RE.test(seg);
      const bad = structural || (vague && !occluded);
      const hidden = FINGER_HIDDEN_RE.test(seg) && !bad;
      const range = seg.match(FINGER_RANGE_RE);
      let count = null;
      if (range) count = null;
      else {
        const n = seg.match(/\d+/);
        if (n) count = Number(n[0]) + (FINGER_PLUS_THUMB_RE.test(seg) ? 1 : 0);
      }
      const visibleSubset = count !== null && count < 5 && /\bvisible\b/i.test(seg)
        && (region === 'CLEAN' || region === 'NOT_VISIBLE');
      let status;
      if (bad) status = 'defect';
      else if (hidden) status = 'hidden';
      else if (range || visibleSubset || FINGER_UNCOUNTABLE_RE.test(seg)
        || /\b(?:uncertain|unsure|maybe|approximately)\b|[~?]/i.test(seg)) status = 'unreadable';
      else if (count !== null && count !== 5) status = 'defect';
      else if (count === 5) status = 'clean';
      else status = 'unreadable';
      hands.push({ side, status, said: seg });
    }
    return { hands, bad: hands.filter((h) => h.status === 'defect') };
  }

  const SEVERE_BAND = 4;
  const DISPUTED_CAP = 6;
  const METRIC_MIN_SAMPLES = 40;

  const GATE_KEYS = ['hands', 'limbs', 'no_merges', 'face', 'detail'];
  const STRUCTURAL_GATES = ['hands', 'limbs', 'no_merges', 'face'];
  const GATE_CEILING = { 1: 6, 2: 4, 3: 2 };
  const DETAIL_ONLY_CEILING = 7;

  const QC_POLICY_VERSION = 'qc-evidence-v1';
  const QC_PROMPT_VERSION = 'qc-visibility-v1';
  const qcObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const qcScoreNumber = (v) => (typeof v === 'number' || (typeof v === 'string' && /^\d+(?:\.\d+)?$/.test(v.trim())))
    && Number.isFinite(Number(v)) && Number(v) >= 1 && Number(v) <= 10;

  function validateQc(qc) {
    const invalid = (field) => { throw new Error(`Invalid QC response: ${field}`); };
    if (!qcObject(qc)) invalid('expected an object');
    if (!qcScoreNumber(qc.score)) invalid('score must be a finite number from 1 to 10');
    if (typeof qc.verdict !== 'string' || !/^(PASS|FAIL)$/i.test(qc.verdict.trim())) invalid('verdict must be PASS or FAIL');
    if (!Array.isArray(qc.defects)) invalid('defects must be an array');
    for (const d of qc.defects) {
      if (typeof d === 'string' && d.trim()) continue;
      if (!qcObject(d) || typeof (d.what || d.defect) !== 'string' || !(d.what || d.defect).trim()) invalid('defect needs a description');
      for (const k of ['where', 'severity', 'area', 'focus']) if (d[k] != null && typeof d[k] !== 'string') invalid(`defect ${k} must be text`);
    }
    for (const k of ['fingerCounts', 'notes', 'fix', 'scene']) if (qc[k] != null && typeof qc[k] !== 'string') invalid(`${k} must be text`);
    if (qc.regions != null && !Array.isArray(qc.regions)) invalid('regions must be an array');
    return qc;
  }

  function gateAnswer(value) {
    if (value === true || value === 1) return 'YES';
    if (value === false || value === 0) return 'NO';
    if (typeof value !== 'string') return null;
    const v = value.trim().toUpperCase();
    return ['YES', 'TRUE', '1'].includes(v) ? 'YES' : ['NO', 'FALSE', '0'].includes(v) ? 'NO' : null;
  }

  /** Turn the general pass's gate answers into a score ceiling — in CODE, not in the model's hands. */
  function gateScore(gates) {
    if (!qcObject(gates)) return null;
    const g = gates.gates;
    if (!qcObject(g)) return null;
    let answered = 0;
    const failed = [];
    const answers = {};
    for (const k of GATE_KEYS) {
      const v = Object.prototype.hasOwnProperty.call(g, k) ? gateAnswer(g[k]) : null;
      answers[k] = v || 'UNKNOWN';
      if (!v) continue;
      answered++;
      if (v === 'NO') failed.push(k);
    }
    if (!answered) return null;
    const no = failed.length;
    const structural = failed.filter((k) => STRUCTURAL_GATES.includes(k));
    const overall = Number(gates.overall);
    const hasOverall = qcScoreNumber(gates.overall);
    let ceiling;
    if (structural.length) ceiling = GATE_CEILING[Math.min(structural.length, 3)];
    else if (no) ceiling = DETAIL_ONLY_CEILING;
    else ceiling = 10;
    if (hasOverall && (structural.length || !no)) ceiling = Math.min(ceiling, Math.round(overall));
    return {
      ceiling, no, answered, failed, answers, complete: answered === GATE_KEYS.length && hasOverall, structural: structural.length,
      overall: hasOverall ? Math.round(overall) : null,
      worst: String(gates.worst || ''),
    };
  }

  /** Where `value` sits in `list`, as a percentile 0-100. */
  function percentileOf(list, value) {
    if (!list.length) return null;
    let below = 0;
    for (const v of list) if (v <= value) below++;
    return Math.round((below / list.length) * 100);
  }

  const T = {
    ideation(theme, example, count, avoid = [], guidance = '', extras = {}) {
      const { house = '', skeleton = '', modeRule = '', extra = '' } = extras;
      const houseBlock = house ? `\n${house}\n` : '';
      const modeBlock = modeRule ? `\nHOW FAR TO TRAVEL FROM THE EXAMPLE:\n${modeRule}\n` : '';
      return `You are a creative director for an anime-style AI art studio. Your job is to write image-generation prompts.

Theme to explore: "${theme}"
${example ? `\nHere is an example prompt from the artist showing the style and level of detail to imitate:\n"""${example}"""\n` : ''}${skeleton}${guidance ? `\n${guidance}\n` : ''}${avoid.length ? `\nPrompts already generated recently — write something clearly different from every one of these, not a reworded version:\n${avoid.map((p) => `- ${String(p).slice(0, 130)}`).join('\n')}\n` : ''}${houseBlock}${modeBlock}
Write ${count} DISTINCT, highly detailed image prompts for an anime image generator. Rules:
- Each prompt describes ONE scene: character(s), appearance, outfit, pose, expression, setting, lighting, camera angle.
- Be clear and specific about the theme — the audience wants variety within it.
- Vary composition: different poses, angles, settings, moods across the ${count} prompts.
- Write generator input, not a caption: comma-separated fragments, subject first, render and quality tokens last. Never open a prompt by naming the medium (no "anime illustration", no "digital art of", no "an image of").
- 40-90 words each. No preamble, no numbering.
${extra ? `- ${extra}\n` : ''}
Respond ONLY with a JSON array of strings: ["prompt1", "prompt2", ...]`;
    },
    /** Ideation for the advanced generator, where the writer picks the page's dropdowns too. */
    ideationAdvanced(theme, example, count, avoid = [], guidance = '', menu = '', maxControls = 12, pinnedStyle = '', extras = {}) {
      const { house = '', skeleton = '', modeRule = '', extra = '' } = extras;
      const houseBlock = house ? `\n${house}\n` : '';
      const modeBlock = modeRule ? `\nHOW FAR TO TRAVEL FROM THE EXAMPLE:\n${modeRule}\n` : '';
      return `You are a creative director for an anime-style AI art studio. You write image-generation prompts AND set the generator's own controls for each one.

Theme to explore: "${theme}"
${example ? `\nHere is an example prompt from the artist showing the style and level of detail to imitate:\n"""${example}"""\n` : ''}${skeleton}${guidance ? `\n${guidance}\n` : ''}${avoid.length ? `\nPrompts already generated recently — write something clearly different from every one of these, not a reworded version:\n${avoid.map((p) => `- ${String(p).slice(0, 130)}`).join('\n')}\n` : ''}
HOW THIS GENERATOR WORKS
The art style you pick is a prompt template: your description is inserted into it, and it
brings its own rendering language and negative prompt with it. Every other control appends
its own sentence to the prompt. So the controls are not tags on top of your prompt — they
are part of it, and a control you set is wording you do not have to write.

${menu}
${houseBlock}${modeBlock}
Write ${count} DISTINCT images. For each one:
- "prompt": ONE scene, 40-90 words. Character(s), body, outfit, pose,
  expression, setting, lighting, camera angle. Clear and specific about the theme.
  Generator input, not a caption: comma-separated fragments, subject first. Never open by
  naming the medium — no "anime illustration", no "digital art of", no "an image of".
- "controls": the generator settings for that scene. Rules:
  · ${pinnedStyle
    ? `Do NOT set "artStyle". It is fixed at "${pinnedStyle}" for every image in this batch and`
      + ` your choice would be discarded. Write for that style.`
    : 'Always set "artStyle" — it is the single biggest decision, and the default is a photo style.'}
  · Set at most ${maxControls} controls in total. Fewer, chosen well, beats filling in the form.
  · Only set a control the scene actually calls for. An unset control adds nothing; a wrongly
    set one puts wording in the prompt that fights what you wrote.
  · Do not restate a control in the prose. If you set the location control, do not also spend
    twenty words describing the room.
  · Use the option text from the menu where one fits. Where none does, name what you want in
    plain words — the closest real option will be matched for you.
- Vary composition across the ${count} images: different poses, angles, settings, moods${pinnedStyle
    ? '. The art style is fixed, so the variety has to come from the scene.'
    : ` — and\n  different art styles unless the theme demands one.`}
${extra ? `- ${extra}\n` : ''}
Respond ONLY with a JSON array:
[{"prompt": "...", "controls": {"artStyle": "...", "lighting": "...", "position": "..."}}, ...]`;
    },
    /** Controls only, for a prompt that already exists. */
    controlsFor(prompt, menu, maxControls = 12, pinnedStyle = '') {
      return `You are setting up an anime-art image generator to render a prompt somebody else wrote.

THE PROMPT — do not rewrite it, do not comment on it, just read it:
"""${String(prompt).slice(0, 900)}"""

The generator's art style is a prompt template: the prompt above gets inserted into the
style's own wording, and the style brings its own negative prompt. Every other control
appends a sentence of its own to the prompt.

${menu}

Choose the controls for this prompt. Rules:
- ${pinnedStyle
  ? `Do NOT set "artStyle" — it is fixed at "${pinnedStyle}" and anything you choose is discarded.`
  : 'Always set "artStyle". Its default is a photo style, which is wrong for almost everything here.'}
- At most ${maxControls} controls in total. Fewer, chosen well, beats filling in the form.
- Only set a control the prompt actually implies. A control you set that contradicts the
  prompt puts fighting wording into the same sentence; a control you leave alone adds nothing.
- Do not set a control just because the prompt already says it in words. Prefer controls that
  the prompt leaves to the generator.
- Use the option text from the menu where one fits. Where none does, name what you want in
  plain words — the closest real option will be matched for you.

Respond ONLY with JSON: {"controls": {"artStyle": "...", "lighting": "..."}}`;
    },
    /**
     * QC prompt, v3. v1 asked for a score first and got 9/10 on 58 out of 58 images — a rubber
     * stamp, not a gate. v2 enumerated the defects BEFORE any score existed so the model could not
     * anchor high and rationalise…
     */
    qc(prompt, threshold = 7) {
      const asked = prompt ? `\nThe image was generated from this prompt:\n"""${String(prompt).slice(0, 700)}"""\nAnything the prompt explicitly asked for is INTENDED and is not a defect — including rendered text or speech bubbles if the prompt requested them. Judge only execution: is what was asked for rendered competently?\n` : '';
      return `You are a technical QA inspector for AI-generated images. You inspect for GENERATION ARTIFACTS ONLY. You are not judging subject matter, taste, or style — only how competently the image was rendered. Do not describe the content outside the final description step; until then report defects only.
${asked}
Work in this exact order.

STEP 1 - REGION CHECK. Go region by region and record a verdict for each one, clean or not.
- Hands: count the fingers on each visible hand and state the counts. Fused, missing, extra, or wrongly bent fingers are defects.
Report only digits you can actually distinguish. A visible subset behind an object is not evidence of missing anatomy. Mark hidden regions NOT_VISIBLE; mark visible but too small/unclear to judge UNKNOWN and explain the visibility limit. Never fill an uncertain count with 5 or call an unexamined region CLEAN.
- Limbs: count arms and legs. Check every joint bends the correct way and connects to the body.
- Face: eye symmetry, pupil alignment and gaze direction, teeth, ear placement and count.
- Anatomy: proportions, torso twist, shoulders, anywhere two body parts merge into each other.
- Rendering: smearing, melted or mushy texture, loss of sharpness and fine detail, warped straight lines in the background, stray text, watermark or signature artifacts, duplicated objects.
- Composition: unintended cropping of head, face, or limbs at the frame edge.
A clean region is a RESULT, not a failure to inspect. "hands: CLEAN (left 5, right 5)" is exactly as valid an answer as a defect, and it is never a shortcut. Leave out only a region you genuinely did not examine.

STEP 2 - NAME THE DEFECTS. ONE problem in ONE place is ONE defect. Never split a single bad hand into four defects because it shows four symptoms (fused fingers, wrong thumb, no knuckles): that one hand is one defect. Two bad hands are two defects. Count places, not symptoms. List only what a viewer could actually see, and never invent a defect to fill the list.

STEP 3 - RATE each defect by HOW VISIBLE IT IS TO A VIEWER WHO WAS NOT TOLD TO LOOK. Also give \`area\` (roughly how much of the picture it affects: "a corner", "one hand", "the whole lower half") and \`focus\` ("yes" if it sits on the part of the picture a viewer looks at first).
- minor = INVISIBLE. You found it because you inspected; a viewer at normal size would not see it. A slightly short finger, a small asymmetry, an artifact in a corner.
- noticeable = VISIBLE. A viewer sees it without being told, and the picture still works.
- severe = BREAKS. The eye goes there first and the picture is spoiled: a missing limb, two bodies merged into one, a melted face, hands as shapeless blobs, an element that contradicts the prompt so hard the scene no longer reads.
The SAME flaw is not the same severity in two different pictures. A slightly mangled hand that is small, occluded or in the background is minor; a hand the composition centres on is noticeable. Sitting on the focus point raises a defect by at most one step — it does not by itself make it severe.

STEP 4 - SCORE the picture as a whole, not the length of the list. Score the WORST thing you found, not the average of what you inspected: the question is whether this frame could go out as it is. One bad hand is one visible flaw and lands at 6, never at 3, and a picture with several defects is not automatically the sum of them.
10 = you inspected everything and found nothing a viewer would notice, and the detail holds up at normal viewing size
9 = one minor defect, invisible unless pointed at
8 = two or more minor defects, still invisible unless pointed at
7 = no defect in your list at all — every region came back clean
6 = one visible defect, everything else clean — a good picture with something wrong in it
5 = two visible defects, or one visible defect sitting on the focus point
4 = one severe defect — the picture is spoiled
3 = one severe defect plus other visible ones
2 = more than one severe defect
1 = the render failed and the picture is unusable

Calibration: an empty defect list claims a flawless render — only leave it empty if you actually counted fingers and limbs, and then it is a 9 or a 10. Padding the list is equally wrong. But a visible defect in the list always caps the picture at 6, because the question is whether it could go out as it is: a hand, limb or face a viewer would notice is not offset by the rest of the frame being good.

STEP 5 - FIX. In one short sentence: the single change that would raise this picture by one point. If it is already a 10, write "nothing".

STEP 6 - DESCRIBE. Only now, with the score already decided, stop inspecting and look at the picture the way a viewer would. In ONE sentence, say what it actually shows: who is in frame, how much of them, what they are doing, what they are wearing, and where they are. Concrete and plain. Say nothing about render quality and name no defect — that work is finished and this sentence is not part of it. Someone who will never see this image has to write its title from your sentence alone, so lead with whatever a viewer notices first.

Respond ONLY with JSON:
{"regions": [{"region": "hands", "verdict": "CLEAN"|"DEFECT"|"UNKNOWN"|"NOT_VISIBLE", "detail": "..."}], "fingerCounts": "left hand: N, right hand: N (or 'not visible' / 'uncertain')", "defects": [{"what": "...", "where": "...", "area": "...", "focus": "yes"|"no", "severity": "minor|noticeable|severe"}], "score": <1-10>, "verdict": "PASS"|"FAIL", "notes": "one sentence", "fix": "one sentence", "scene": "one sentence"}
Verdict is PASS only if score >= ${threshold} and no defect is "severe". "fix" and "scene" are written last, after the verdict, and "scene" never mentions a defect.`;
    },
    /** The SECOND opinion — a general rating, asked as questions instead of as a rubric. */
    qcGates() {
      return `You are the artist's client, looking at one finished picture before it goes on sale. Judge only how well it is made — what the picture is OF is not your business, and the subject is never a defect.
Nobody has told you what to look for, so answer from the frame itself.

Answer each gate independently. Answer YES only when you have actually verified it in the picture, and say YES rather than NO about anything genuinely out of frame or hidden. Answer NO the moment the picture shows you something wrong, however good the rest of it is, and do not soften a NO because one flaw seems forgivable.
If a visible region is too small or unclear to assess, answer UNKNOWN and explain the limitation in worst; do not guess YES or invent a NO. An UNKNOWN leaves QC incomplete and retryable, not a verdict about the artwork. Hidden digits are not missing anatomy.
- hands: every hand in frame shows five separate fingers with a palm and knuckles. Fingers fused or run together, a hand with no division at all, an extra or missing digit, or fingers growing out of the wrong place are each NO.
- limbs: every arm and leg is present, attached where it belongs, and bending the way a joint bends. A limb that is missing, duplicated, bent backwards, or that ends in nothing is NO.
- no_merges: no part of the body runs into another part, into clothing, or into whatever the character is touching; nothing has melted into an unresolved mass of colour.
- face: eyes, pupils, ears, nose, mouth and teeth are where they belong and correctly formed. Misaligned, crossed, duplicated or missing features, or a mouth and jaw that do not resolve, are NO.
- detail: at normal viewing size the picture is clean. Smearing, mush, blotches, swirls standing in for texture, or any area gone to a flat smear instead of detail is NO — the background, and anything with a straight line in it, shows this first.

Then, and only then, rate it as one number: "overall", 1-10, the competence of the finished piece to a paying viewer comparing it with other art. 10 = you cannot find anything wrong with it; 8 = good and clean; 6 = clearly flawed but it still works as a picture; 4 = the flaw is the first thing you see; 2 = unusable. If hands, limbs, no_merges or face came back NO, the overall cannot be above 6. A detail NO alone is a soft or busy render rather than a broken picture, and a picture that is only soft can still be a 7 or an 8 — say so with the number rather than punishing it twice.

Respond ONLY with JSON:
{"gates": {"hands": "YES"|"NO", "limbs": "YES"|"NO", "no_merges": "YES"|"NO", "face": "YES"|"NO", "detail": "YES"|"NO"}, "overall": <1-10>, "worst": "the single worst thing you can see, one short sentence, or 'nothing'"}
"worst" is written last and describes only what you can see in the picture — never the score.`;
    },

    metadata({ prompt, exampleStyle, maxTags, variety = '', scene = '' }) {
      const shown = String(scene || '').trim()
        ? `\nAn inspector looked at the finished image and reported what it shows:\n"""${String(scene).trim()}"""\nThe prompt is what was asked for; this is what came out. Where they disagree, believe this.\n`
        : '';
      return `You write DeviantArt submission metadata for anime-style AI art posts.

The image was generated from this prompt:
"""${prompt}"""
${shown}${exampleStyle ? `\nMimic the tone/style of this example metadata from the artist:\n"""${exampleStyle}"""\n` : ''}${variety ? `\n${variety}\n` : ''}
Generate:
1. "title": catchy, tasteful, max 50 characters (hard DeviantArt limit). No quotes, no hashtags. Describe the scene, never the render quality — no mention of hands, blur, texture, or anything that reads as a flaw.
${ALTS_RULE}
3. "description": ${descriptionBrief()} Do NOT include URLs or Patreon mentions — that gets prepended separately.${noFooterRule()}
4. "tags": array of ${maxTags} relevant DeviantArt tags. Lowercase, single words (letters/numbers only, no spaces, no hyphens). Mix subject, style, and theme tags.

Respond ONLY with JSON: {"title": "...", "alts": ["...", "..."], "description": "...", "tags": ["...", "..."]}`;
    },

    /** Metadata written by a model that can SEE the image — the "Enhance" path. */
    metadataVision({ prompt, exampleStyle, maxTags, variety = '', preferredTags = [], titleHints = [] }) {
      return `You are writing the gallery listing for one piece of the artist's own anime-style artwork. The finished image is attached. You are its copywriter, not its critic.

Look at the image first. It is the truth about this piece.
${prompt ? `\nFor context, the artist asked the generator for this — it is what was REQUESTED, not what came out. Where the image and this disagree, the image wins:\n"""${String(prompt).slice(0, 900)}"""\n` : ''}${exampleStyle ? `\nMimic the tone/style of this example metadata from the artist:\n"""${exampleStyle}"""\n` : ''}${preferredTags.length ? `\nThese tags have measurably out-performed for this artist — include the ones that genuinely fit THIS image, and do not force the rest:\n${preferredTags.map((t) => `#${t}`).join(' ')}\n` : ''}${titleHints.length ? `\nTitle patterns that have performed well here: ${titleHints.join('; ')}.\n` : ''}${variety ? `\n${variety}\n` : ''}
Write:
1. "title": catchy, tasteful, max 50 characters (hard DeviantArt limit). No quotes, no hashtags. It must be about what you can SEE — the moment in this specific picture, not the theme in general.
${ALTS_RULE}
3. "description": ${descriptionBrief()} Written from what is actually in the image: the character's expression and posture, the outfit, the light, the place. Do NOT include URLs or Patreon mentions — those get prepended separately.${noFooterRule()}
4. "tags": array of ${maxTags} DeviantArt tags. Lowercase, single words (letters/numbers only, no spaces, no hyphens). Mix subject, style, and theme tags, and let what you can see in the image choose them.

You are NOT inspecting this image. Do not mention, hint at, or work around anatomy, hands, fingers, proportions, rendering, blur, texture, or anything that reads as a flaw — this is a sales page. If something looks off, write around it and describe what does work.

Respond ONLY with JSON: {"title": "...", "alts": ["...", "..."], "description": "...", "tags": ["...", "..."]}`;
    },

    /** Titles only, for slots that came back repeating something. */
    retitle({ prompt, slots, variety = '' }) {
      return `You are re-titling artwork for a DeviantArt gallery. Only titles — nothing else.

The image(s) were generated from this prompt:
"""${prompt}"""

These titles were REJECTED and need replacing:
${slots.map((s, i) => `${i + 1}. "${s.title}" — ${s.reason}`).join('\n')}
${variety ? `\n${variety}\n` : ''}
Write ${slots.length} replacement title(s), in the same order. Hard requirements:
- Each must be unmistakably different from the title it replaces — a different image in the mind, not a reworded version of the same one.
- Max 50 characters. No quotes, no hashtags, no numbering.
- Describe the scene, never the render quality.

Respond ONLY with a JSON array of exactly ${slots.length} string(s): ["...", ...]`;
    },

    metadataBatch({ prompt, count, exampleStyle, maxTags, variety = '', preferredTags = [], titleHints = [], scenes = [] }) {
      const seen = scenes.filter((s) => String(s || '').trim()).length;
      const shown = seen
        ? `\nAn inspector looked at the finished images and reported what each one SHOWS, in order:\n${scenes.map((s, i) => `${i + 1}. ${String(s || '').trim() || '(not recorded)'}`).join('\n')}\n\nThe prompt is what was asked for; these sentences are what came out. Where the two disagree, believe these. Title each image from ITS OWN line — they are different pictures, not one picture described ${count} times.\n`
        : '';
      return `You write DeviantArt submission metadata for anime-style AI art posts.

${count} images were generated from this single prompt:
"""${prompt}"""
${shown}${exampleStyle ? `\nMimic the tone/style of this example metadata from the artist:\n"""${exampleStyle}"""\n` : ''}
${preferredTags.length ? `\nThese tags have measurably out-performed for this artist — include the ones that genuinely fit the image, and do not force the rest:\n${preferredTags.map((t) => `#${t}`).join(' ')}\n` : ''}${titleHints.length ? `\nTitle patterns that have performed well here: ${titleHints.join('; ')}.\n` : ''}${variety ? `\n${variety}\n` : ''}
Write metadata for all ${count} images as one set. Hard requirements:
- Each "title" must be genuinely DISTINCT from the other ${count - 1}. Different opening word, different image, different angle on the scene. They will appear side by side in a gallery.
- Describe the SCENE, never the render quality. Never mention hands, fingers, poses being twisted, blur, texture, or anything that reads as a flaw — this is a sales page, not a critique.
- Do NOT use a shared prefix or a "Series Name: subtitle" pattern across the set.
- Max 50 characters per title (hard DeviantArt limit). No quotes, no hashtags.
- "alts": TWO more titles for that same image, ranked best first, used only if the first turns out to be already taken in this gallery. Genuinely different ideas, not the title reworded — and they must also be distinct from the other images' titles in this set.
- "description": ${descriptionBrief()} Vary the opening and the sentence structure between them — ${count} descriptions built the same way read as one description reworded. No URLs or Patreon mentions — those get prepended separately.${noFooterRule()}
- "tags": ${maxTags} lowercase single-word DeviantArt tags per image (letters/numbers only). Share the core subject tags across the set, but vary a few per image to widen search reach.

Respond ONLY with a JSON array of exactly ${count} objects, in image order:
[{"title": "...", "alts": ["...", "..."], "description": "...", "tags": ["...", "..."]}, ...]`;
    },
  };

  function cleanTag(tag) {
    return String(tag || '').trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 60);
  }

  /** The description a card ships with, which depends on where it is going. */
  function buildDescription(link, cta, aiDescription, destination = 'deviantart') {
    const body = String(aiDescription || '').replace(/https?:\/\/\S*patreon\S*/gi, '').trim();
    if (!wantsPatreonBlock(destination)) return body;
    return `${link}\n\n${cta}\n\n${body}`.trim();
  }

  /** Does this routing want the Patreon block in its description? */
  function wantsPatreonBlock(destination) {
    const list = Array.isArray(destination) ? destination : [destination];
    return !list.includes('patreon');
  }

  /** Add/remove the Patreon block on a description that already exists. */
  function stripPatreonBlock(text, { link, cta } = {}) {
    const ctaNorm = String(cta || '').trim().toLowerCase();
    const kept = String(text || '').split('\n').filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/patreon\.com/i.test(t)) return false;
      if (ctaNorm && t.toLowerCase() === ctaNorm) return false;
      if (String(link || '').trim() && t === String(link).trim()) return false;
      return true;
    });
    return kept.join('\n').replace(/^\s+/, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function addPatreonBlock(text, { link, cta } = {}) {
    const body = stripPatreonBlock(text, { link, cta });
    return `${link || ''}\n\n${cta || ''}\n\n${body}`.trim();
  }

  const DESTINATIONS = ['deviantart', 'pixiv', 'patreon'];
  const isDestination = (d) => DESTINATIONS.includes(d);

  /** Every site a card is headed for — its own choice, else the configured default. */
  function destinationsOf(card) {
    const raw = card && Array.isArray(card.destinations) ? card.destinations
      : card && isDestination(card.destination) ? [card.destination]
        : null;
    const list = normaliseDestinations(raw);
    if (list.length) return list;
    const s = (State.settings && State.settings.publish) || {};
    const fallback = normaliseDestinations(Array.isArray(s.destinations) ? s.destinations : [s.destination]);
    return fallback.length ? fallback : ['deviantart'];
  }

  function normaliseDestinations(list) {
    const seen = (list || []).filter(isDestination);
    if (seen.includes('patreon')) return ['patreon'];
    return DESTINATIONS.filter((d) => seen.includes(d));
  }

  /** The single destination the pre-pixiv code asked about. */
  function destinationOf(card) {
    const list = destinationsOf(card);
    return list.includes('patreon') ? 'patreon'
      : list.includes('deviantart') ? 'deviantart'
        : list[0];
  }

  const goesTo = (card, id) => destinationsOf(card).includes(id);

  const PUBLIC_SITES = ['deviantart', 'pixiv'];

  /** Has this card already landed on that site? */
  function siteDone(card, site) {
    if (!card) return false;
    if (site === 'deviantart') return !!(card.da && card.da.itemid);
    if (site === 'pixiv') return !!(card.pixiv && card.pixiv.illustId);
    return false;
  }

  /** Which sites this card is routed to but has not reached yet. */
  function pendingSites(card) {
    return destinationsOf(card).filter((d) => PUBLIC_SITES.includes(d) && !siteDone(card, d));
  }

  /** Everything this card has already reached. */
  function doneSites(card) {
    return destinationsOf(card).filter((d) => PUBLIC_SITES.includes(d) && siteDone(card, d));
  }

  const SITE_LABEL = { deviantart: 'DeviantArt', pixiv: 'pixiv', patreon: 'Patreon' };

  /** The default stamped onto a new card. */
  function defaultDestinations() {
    const s = (State.settings && State.settings.publish) || {};
    const list = normaliseDestinations(Array.isArray(s.destinations) ? s.destinations : [s.destination]);
    return list.length ? list : ['deviantart'];
  }

  function finalizeTags(aiTags, defaultTags, maxTags) {
    const out = [], seen = new Set();
    for (const t of [...(aiTags || []), ...(defaultTags || [])]) {
      const c = cleanTag(t);
      if (c && !seen.has(c)) { seen.add(c); out.push(c); }
      if (out.length >= maxTags) break;
    }
    return out;
  }

  /**
   * The last step before a title becomes real: commit it to the ledger, and deal with anything that
   * repeated its way through both the prompt and the repair call.
   */
  function settleTitles(cards) {
    const chosen = [];
    for (const c of cards) {
      const meta = c.metadata;
      const title = meta && meta.title;
      if (!title) continue;
      const alts = Array.isArray(meta.titleAlts) ? meta.titleAlts : [];
      delete meta.titleAlts;

      /**
       * "Used by anything that is not this card." The self-exemption is needed — a card re-checked
       * twice must not flag itself — but it works by string, and the corpus is de-duplicated by
       * string, so excluding "this card's…
       */
      const same = (x) => String(x || '').trim().toLowerCase() === String(title).trim().toLowerCase();
      const takenByAnother = (State.library || []).some((o) => o && o.id !== c.id
        && o.metadata && same(o.metadata.title));
      const verdict = Titles.isRepeat(title, { exclude: [title] });
      const clashesWithSibling = chosen.some((t) => Titles.similarity(title, t, Titles.voice()) >= verdict.limit);

      if (!verdict.repeat && !takenByAnother && !clashesWithSibling) {
        if (c.titleWarning) delete c.titleWarning;
      } else {
        const against = takenByAnother ? title
          : (verdict.against || {}).t || 'another title in this batch';
        const pick = Titles.pickFree(alts, { avoid: [...chosen, title] });
        if (pick) {
          meta.title = pick.title;
          meta.titleWritten = pick.title;
          c.titleWarning = `Written as "${title}", which is close to "${against}". `
            + `Swapped for the writer's own next choice — no extra call was made.`;
        } else {
          c.titleWarning = alts.length
            ? `Close to "${against}", and so were the spare titles. Kept as written — rename it here if you disagree.`
            : `Close to "${against}". Kept as written — rename it here if you disagree.`;
        }
      }
      chosen.push(meta.title);
      Titles.remember(meta.title, 'card', c.id, false);
    }
    Titles.persist();
  }

  /** Is the automatic title/description/tags pass switched off? */
  const metadataOff = () => !!(State.settings && State.settings.gen && State.settings.gen.skipMetadata);

  /** Should metadata be withheld from images nobody inspected? */
  const metadataNeedsQc = () => !!(State.settings && State.settings.gen && State.settings.gen.metadataOnlyInspected);

  /** Does this card carry metadata worth uploading? */
  function hasMetadata(card) {
    const m = card && card.metadata;
    if (!m) return false;
    return !!(String(m.title || '').trim()
      || String(m.description || '').trim()
      || (Array.isArray(m.tags) && m.tags.length));
  }

  const log = (msg, kind) => State.addLog(msg, kind);

  const SKELETONS = new Map();

  /** OS-level notification, only when the app is in the background. */
  const osNotify = (title, body) => {
    try {
      if (document.hasFocus()) return;
      if (window.ala.app.notify) window.ala.app.notify(title, body).catch(() => {});
    } catch { }
  };

  const RETRY_BACKOFF_MS = [30_000, 120_000, 480_000];

  const Pipeline = {
    running: false,
    _stopRequested: false,
    driver: null,

    _lane: [],
    _laneCurrent: null,
    _laneRunning: false,
    _lanePromise: null,
    _lanePhase: null,
    _abandonLane: false,
    _referenceCache: new Map(),
    _referenceCacheBytes: 0,

    attachDriver(webviewEl) { this.driver = new PerchanceDriver(webviewEl); },

    /** The driver that makes pixels, per the current engine setting. */
    genDriver() {
      const engine = ((State.settings && State.settings.gen) || {}).engine || 'perchance';
      if (engine === 'comfy') {
        if (!this._comfyDriver) this._comfyDriver = new ComfyDriver();
        return this._comfyDriver;
      }
      return this.driver;
    },

    _cachedReference(key) {
      const hit = this._referenceCache.get(key);
      if (!hit) return null;
      this._referenceCache.delete(key);
      this._referenceCache.set(key, hit);
      return hit.value;
    },

    _cacheReference(key, value) {
      const bytes = Math.max(0, Number(value.bytes) || Math.floor(String(value.base64 || '').length * 0.75));
      if (!value.base64 || bytes > 12 * 1024 * 1024) return;
      const old = this._referenceCache.get(key);
      if (old) this._referenceCacheBytes -= old.bytes;
      this._referenceCache.delete(key);
      this._referenceCache.set(key, { value, bytes });
      this._referenceCacheBytes += bytes;
      while (this._referenceCache.size > 8 || this._referenceCacheBytes > 32 * 1024 * 1024) {
        const oldest = this._referenceCache.keys().next().value;
        const dropped = this._referenceCache.get(oldest);
        this._referenceCache.delete(oldest);
        this._referenceCacheBytes -= dropped ? dropped.bytes : 0;
      }
    },

    /** Resolve a researched job's compact ids into transient bytes for ComfyUI. */
    async researchReferences(job) {
      const ceiling = window.ComfyUI?.referenceLimit
        ? window.ComfyUI.referenceLimit(State.settings && State.settings.comfy)
        : 8;
      // A job may ask for fewer references than the setting allows (Overseer.assignReferences).
      const perJob = Math.floor(Number(job.referenceCount));
      const limit = perJob > 0 ? Math.min(perJob, ceiling) : ceiling;
      const ids = [...new Set((Array.isArray(job.referenceIds) ? job.referenceIds : [])
        .map(String).filter(Boolean))].slice(0, limit);
      if (!ids.length) return [];
      const chatById = new Map((Array.isArray(job.chatReferences) ? job.chatReferences : [])
        .filter((r) => r && r.id && r.fname).map((r) => [String(r.id), r]));
      const loaded = [];
      const failed = [];
      for (const id of ids.filter((x) => chatById.has(x))) {
        const row = chatById.get(id);
        try {
          const got = await window.ala.files.readAttachment(row.fname);
          if (!got || !got.base64) throw new Error('the attached file is empty');
          loaded.push({ id, key: `chat:${row.fname}`, title: String(row.name || id).slice(0, 240), base64: got.base64, mime: got.mime || row.mime || 'image/png', bytes: 0 });
        } catch (e) {
          failed.push({ id, error: `attached image unavailable: ${e.message}` });
        }
      }
      const researchIds = ids.filter((x) => !chatById.has(x));
      const pack = researchIds.length && window.Overseer && typeof window.Overseer.researchPack === 'function'
        ? window.Overseer.researchPack(job.researchId) : null;
      if (researchIds.length && !pack) {
        failed.push(...researchIds.map((id) => ({ id, error: 'saved research pack is no longer available' })));
        log('The researched prompt is still usable, but its saved image references are no longer available — generating from the grounded text only.', 'err');
      }

      const byId = new Map(((pack && pack.images) || []).map((im) => [String(im.id), im]));
      for (const id of pack ? researchIds : []) {
        const image = byId.get(id);
        if (!image) { failed.push({ id, error: 'reference id is not in the saved research pack' }); continue; }
        const key = `${pack.id}:${id}:${image.imageUrl || image.thumbnailUrl || ''}`;
        let ref = this._cachedReference(key);
        if (!ref) {
          try {
            const got = await window.ala.research.image(image);
            if (!got || !got.ok || !got.base64) throw new Error((got && got.error) || 'image download returned no bytes');
            ref = {
              id, key, title: String(image.title || '').slice(0, 240),
              base64: got.base64, mime: got.mime || 'image/png', bytes: got.bytes || 0,
            };
            this._cacheReference(key, ref);
          } catch (e) {
            failed.push({ id, error: e.message });
            continue;
          }
        }
        loaded.push(ref);
      }
      job.referenceFetchErrors = failed;
      log(loaded.length
        ? `Prepared ${loaded.length}/${ids.length} reference image(s) for the ComfyUI workflow.`
        : 'No searched reference image could be downloaded — generating from the already grounded prompt text.',
      loaded.length ? undefined : 'err');
      return loaded;
    },

    /** Is the post-generation stage allowed to run beside generation? */
    parallelPostOn() {
      return (State.settings.gen || {}).parallelQc !== false;
    },

    /** Images generated but not yet judged — the lane's depth, in frames. */
    laneImages() {
      const waiting = this._lane.reduce((n, b) => n + b.items.length, 0);
      const inFlight = this._laneCurrent
        ? this._laneCurrent.items.filter((it) => it.card.status === 'qc').length
        : 0;
      return waiting + inFlight;
    },

    /** The art style this run is locked to, or '' when the writer still chooses. */
    pinnedStyle() {
      const g = State.settings.gen || {};
      return g.artStylePin ? String(g.artStyle || '').trim() : '';
    },

    advancedIdeationOn() {
      const g = State.settings.gen || {};
      return g.generator === 'advanced' && g.advAutoFilters !== false;
    },

    /**
     * The controls menu handed to the writer: control name, the page's own label, and a trimmed
     * slice of its options.
     */
    controlMenu() {
      const d = this.driver;
      if (!d || typeof d.filterableInputs !== 'function' || !d.isAdvanced()) return '';
      let inputs = d.filterableInputs();
      if (!inputs.length) return '';
      const cap = Math.max(6, Number((State.settings.gen || {}).advMenuCap) || 28);
      if (this.pinnedStyle()) inputs = inputs.filter((i) => i.name !== 'artStyle');

      const groups = new Map();
      for (const i of inputs) {
        const key = (i.options || []).join('\u0000');
        if (!groups.has(key)) groups.set(key, { names: [], label: i.label, options: i.options || [] });
        groups.get(key).names.push(i.name);
      }
      const rank = (g) => (g.names[0] === 'artStyle' ? 0 : 1);
      const lines = [...groups.values()].sort((a, b) => rank(a) - rank(b)).map((g) => {
        const opts = g.options.filter((o) => !/^default$/i.test(o));
        const shown = g.names[0] === 'artStyle' ? opts : opts.slice(0, cap);
        const more = opts.length - shown.length;
        const head = g.names.length > 1
          ? `${g.names[0]} … ${g.names[g.names.length - 1]} (${g.names.length} slots, all offering this same list)`
          : `${g.names[0]} (${g.label})`;
        return `- ${head}: ${shown.join(' | ')}`
          + (more > 0 ? ` … and ${more} more not listed` : '');
      });
      return `CONTROLS AVAILABLE — the control's name, what the page calls it, then its options.\n${lines.join('\n')}`;
    },

    /** Controls for a prompt that arrived without any. */
    async chooseControls(prompt) {
      const menu = this.controlMenu();
      if (!menu) return null;
      const maxControls = Math.max(1, Number((State.settings.gen || {}).advMaxFilters) || 12);
      const r = await U.llmChat(
        [{ role: 'user', content: T.controlsFor(prompt, menu, maxControls, this.pinnedStyle()) }],
        { temperature: 0.3, maxTokens: 4000, role: 'ideation' }, 'Choosing generator controls');
      let obj = null;
      for (const c of U.jsonCandidates(r.text || '')) {
        const v = c.value && (c.value.controls || c.value);
        if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) obj = v;
      }
      if (!obj) return null;
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (v == null) continue;
        const val = String(v).trim();
        if (!val || Object.keys(out).length >= maxControls) continue;
        out[String(k).trim()] = val;
      }
      return Object.keys(out).length ? out : null;
    },

    /** `guidance` defaults to the learned playbook. */
    async ideate(theme, example, count, avoid = [], guidance = null, mode = '') {
      const learned = guidance == null
        ? (window.Insights ? window.Insights.guidance({ theme }) : '')
        : guidance;

      const house = window.PromptStyle ? PromptStyle.block() : '';

      const pool = String(example || '').split(/\n\s*-{3,}\s*\n/).map((s) => s.trim()).filter(Boolean);
      let seed = pool.length > 1 ? pool[Math.floor(Math.random() * pool.length)] : (pool[0] || '');
      if (!seed && !house && window.PromptStyle) {
        const best = PromptStyle.exemplars({ n: 1 })[0];
        if (best) seed = best.text;
      }

      const skeletonBlock = window.PromptLab
        ? PromptLab.skeletonBlock(await this.themeSkeleton(seed))
        : '';

      const modeRule = ((window.PromptLab && PromptLab.AUTO_MODES[mode]) || {}).rule || '';

      let menu = '';
      if (this.advancedIdeationOn() && this.driver && this.genDriver() === this.driver) {
        await this.driver.ensureCatalog(log).catch(() => null);
        menu = this.controlMenu();
        if (!menu) {
          log('Advanced mode is on but the generator\'s controls have not been read yet —'
            + ' writing prompts without them. Press "Read the generator\'s options" in Settings → Perchance.', 'err');
        }
      }
      const advanced = !!menu;
      const maxControls = Math.max(1, Number((State.settings.gen || {}).advMaxFilters) || 12);
      const extras = { house, skeleton: skeletonBlock, modeRule };

      const build = (n, dodge, extra) => (advanced
        ? T.ideationAdvanced(theme, seed, n, dodge, learned, menu, maxControls,
          this.pinnedStyle(), { ...extras, extra })
        : T.ideation(theme, seed, n, dodge, learned, { ...extras, extra }));

      const ask = async (n, dodge, extra = '') => {
        const res = await U.llmChat(
          [{ role: 'user', content: build(n, dodge, extra) }],
          { temperature: 0.95, maxTokens: advanced ? 12000 : 8000, role: 'ideation' }, 'Ideation');
        return {
          res,
          ideas: advanced
            ? U.ideasFrom(res, { count: n, max: 600 })
            : U.promptsFrom(res, { count: n, max: 600 }).map((p) => ({ prompt: p, controls: {} })),
        };
      };

      const first = await ask(count, avoid);
      const r = first.res;

      let list = first.ideas;
      if (!list.length) {
        throw new Error(r.truncated || r.fromReasoning
          ? `${r.provider || 'the writer'} used its whole token budget thinking and never emitted a prompt`
            + ' — raise its Max output tokens in Settings → Engines, or route ideation to a non-reasoning model'
          : 'LLM returned no prompts');
      }

      const sim = window.promptSimilarity;
      if (sim && list.length) {
        const recent = [...new Set([...(avoid || []), ...this.recentPrompts(80)])];
        const fresh = (ideas, against) => {
          const kept = [];
          for (const i of ideas) {
            const others = [...against, ...kept.map((k) => k.prompt)];
            if (others.some((q) => sim(i.prompt, q) > 0.82)) continue;
            kept.push(i);
          }
          return kept;
        };
        const unique = fresh(list, recent);
        const copies = list.length - unique.length;
        if (copies) {
          log(`${copies} of ${list.length} prompt(s) repeated recent work — asking for replacements.`, 'err');
          let repl = [];
          try {
            const again = await ask(copies, [...list.map((i) => i.prompt), ...(avoid || [])],
              'The previous attempt repeated scenes that already exist. Every prompt must be a'
              + ' clearly different scene from all of the prompts listed above — not a reworded one.');
            repl = fresh(again.ideas, [...recent, ...unique.map((i) => i.prompt)]);
          } catch (e) {
            log(`Could not re-ask for the repeated prompts (${e.message}).`, 'err');
          }
          list = [...unique, ...repl].slice(0, count);
          if (repl.length) log(`Replaced ${repl.length} of them.`, 'ok');
          if (!list.length) throw new Error('every prompt written repeated recent work');
        }
      }

      if (window.PromptStyle) {
        const prof = PromptStyle.profile();
        const score = (i) => PromptStyle.houseScore(i.prompt, prof);
        const weak = list.filter((i) => score(i) <= 0);
        if (weak.length) {
          log(`${weak.length} of ${list.length} prompt(s) came back off-voice — asking again.`, 'err');
          let repl = [];
          try {
            const again = await ask(weak.length, [...weak.map((i) => i.prompt), ...avoid],
              'The previous attempt was rejected for form. Comma-separated fragments in the'
              + ' artist\u2019s voice shown above: no prose, no third-person narration'
              + ' ("she is holding…"), and never open by naming the medium.');
            repl = again.ideas.filter((i) => score(i) > 0);
          } catch (e) {
            log(`Could not re-ask for the off-voice prompts (${e.message}) — keeping them.`, 'err');
          }
          list = [...list.filter((i) => score(i) > 0), ...repl, ...weak.slice(repl.length)]
            .slice(0, count);
          if (repl.length) log(`Replaced ${repl.length} of them.`, 'ok');
        }
        const sorted = list.map(score).sort((a, b) => a - b);
        log(`Voice score for this batch: median ${sorted[Math.floor(sorted.length / 2)]}`
          + ` (his own prompts: median 6 on this scale).`);
      }

      if (advanced) {
        const pinned = this.pinnedStyle();
        if (pinned) {
          for (const idea of list) {
            if (idea.controls && idea.controls.artStyle) delete idea.controls.artStyle;
          }
        }
        for (const idea of list) {
          const keys = Object.keys(idea.controls || {});
          if (keys.length > maxControls) {
            for (const k of keys.slice(maxControls)) delete idea.controls[k];
          }
        }
        const withControls = list.filter((i) => Object.keys(i.controls || {}).length).length;
        log(`${list.length} prompt(s) written, ${withControls} with generator controls chosen.`);
      }
      State.bumpStats({ promptsGenerated: list.length });
      return list;
    },

    /** `PromptLab.analyze(seed)`, remembered for as long as the app is open. */
    async themeSkeleton(seed) {
      const text = String(seed || '').trim();
      if (!text || !window.PromptLab) return null;
      const key = text.slice(0, 400);
      if (SKELETONS.has(key)) return SKELETONS.get(key);
      let skel = null;
      try {
        skel = await PromptLab.analyze(text);
      } catch (e) {
        log(`Could not read the example prompt's structure (${e.message}) — writing without it.`);
      }
      SKELETONS.set(key, skel || null);
      return skel || null;
    },

    /**
     * Prompts already in play, newest first, each once — queue and library merged by when they were
     * written.
     */
    recentPrompts(n = 30) {
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
        if (out.length >= n) break;
      }
      return out;
    },

    /** `source` records where the prompt came from — 'ideation', 'manual', 'lab', 'evolved'. */
    makeJob(prompt, theme, source = 'ideation', learnedFrom = null, controls = null) {
      return {
        id: U.uid(), theme: theme || '', prompt,
        status: 'queued', attempts: 0, error: null,
        promptSource: source, learnedFrom,
        controls: controls && Object.keys(controls).length ? controls : null,
        createdAt: Date.now(), updatedAt: Date.now(),
      };
    },

    /**
     * `only` (job ids) runs JUST those jobs and stops — an image edit/fix queued while the
     * worker is paused must not wake the whole paused queue. A plain start() while an `only`
     * run is going widens it to the whole queue (the Dashboard Start button); another `only`
     * start adds its ids to the running set.
     */
    async start({ only = null } = {}) {
      if (this.running) {
        if (!only) this._only = null;
        else if (this._only) for (const id of only) this._only.add(id);
        return;
      }
      if (!this.driver) { log('Perchance driver not attached yet.', 'err'); return; }
      this._only = only ? new Set(only) : null;
      this.running = true;
      this._stopRequested = false;
      this._abandonLane = false;
      State.setWorker({ running: true, statusText: 'Running' });
      log('Worker started.', 'ok');
      const tick = setInterval(() => {
        const t = this._phaseText();
        if (t && State.worker.statusText !== t) State.setWorker({ statusText: t });
      }, 5000);
      let jobsDone = 0;
      const nextJob = () => State.queue.find((j) => j.status === 'queued' && (!this._only || this._only.has(j.id)));
      try {
        while (!this._stopRequested) {
          let job = nextJob();
          if (!job && this._only) {
            const rest = State.queue.filter((j) => j.status === 'queued').length;
            log(`Edit${this._only.size === 1 ? '' : 's'} done — worker stops here${rest ? `; the other ${rest} queued job(s) stay paused` : ''}.`, 'ok');
            break;
          }
          if (!job) {
            if (jobsDone > 0 && !this.laneImages()) {
              const waiting = State.library.filter((c) => c.status === 'review').length;
              osNotify('Acre Art Studio — queue finished',
                `${jobsDone} job(s) done. ${waiting} card(s) waiting in Review.`);
              jobsDone = 0;
            }
            this._phase = null;
            State.setWorker({ currentJobId: null, statusText: this._phaseText() || 'Idle — queue empty' });
            await U.sleep(4000);
            continue;
          }
          if (this.engineDown) {
            await this.awaitEngine();
            if (this._stopRequested) break;
          }
          await this.awaitLaneRoom();
          if (this._stopRequested) break;
          job = nextJob();
          if (!job) continue;
          State.setWorker({ currentJobId: job.id });
          this.setPhase('Generating images…');
          await this.processJob(job);
          jobsDone++;
          const delaySec = State.settings.gen.delayBetweenGensSec || 0;
          if (delaySec > 0 && !this._stopRequested) {
            this.setPhase(`Cooldown ${delaySec}s…`);
            await U.sleep(delaySec * 1000);
          }
        }
      } finally {
        if (this._lanePromise && this.laneImages()) {
          this.setPhase(null);
          log(`Paused — finishing QC on ${this.laneImages()} image(s) already generated. `
            + `Press Pause again to park them for later instead.`);
        }
        if (this._lanePromise) await this._lanePromise.catch(() => {});
        this.running = false;
        this._only = null;
        this._phase = null;
        this._lanePhase = null;
        clearInterval(tick);
        State.setWorker({ running: false, currentJobId: null, statusText: 'Paused', qcLane: 0 });
        log('Worker stopped.');
      }
    },

    /** Pressed once: stop generating, let the lane finish. */
    stop() {
      if (this._stopRequested && this.laneImages()) {
        this._abandonLane = true;
        log('Pause pressed again — parking the rest of the QC lane in Review for retry.');
      }
      this._stopRequested = true;
    },

    engineDown: null,

    async awaitEngine() {
      const driver = this.genDriver();
      if (!driver || typeof driver.status !== 'function') { this.engineDown = null; return; }
      const cfg = (State.settings && State.settings.comfy) || {};
      let probedAt = 0;
      while (this.engineDown && !this._stopRequested) {
        if (Date.now() - probedAt >= 30000) {
          probedAt = Date.now();
          const st = await driver.status().catch(() => ({ up: false }));
          if (st && st.up) {
            const mins = Math.round((Date.now() - this.engineDown.since) / 60000);
            log(`Image engine is answering again${mins ? ` after ${mins} min` : ''} — resuming the queue.`, 'ok');
            this.engineDown = null;
            return;
          }
          if (String(cfg.launchCommand || '').trim()
            && Date.now() - (this.engineDown.launchTriedAt || 0) > 10 * 60000) {
            this.engineDown.launchTriedAt = Date.now();
            return;
          }
        }
        const mins = Math.floor((Date.now() - this.engineDown.since) / 60000);
        const text = `Waiting for ComfyUI at ${cfg.serverUrl || 'its address'} — not answering${mins ? ` for ${mins} min` : ''}. Start it and the queue resumes.`;
        if (!this._phase || this._phase.text !== text) this.setPhase(text);
        await U.sleep(2000);
      }
    },

    /** Hold the generator until the lane has room. */
    async awaitLaneRoom() {
      if (!this.parallelPostOn()) return;
      const cap = Math.max(1, Number(State.settings.gen.qcLaneDepth) || 2);
      let told = false;
      while (!this._stopRequested && this._lane.length >= cap) {
        if (!told) {
          told = true;
          log(`Generation paused — ${this.laneImages()} image(s) still waiting on the `
            + `inspector. Raise "QC lane depth" only if you want a deeper backlog.`);
        }
        const text = `Waiting for QC — ${this.laneImages()} image(s) to inspect`;
        if (!this._phase || this._phase.text !== text) this.setPhase(text);
        await U.sleep(2000);
      }
    },

    /** Name the phase the worker is actually in, with a clock. */
    setPhase(text) {
      this._phase = text ? { text, at: Date.now() } : null;
      State.setWorker({ statusText: this._phaseText() || (text || 'Idle') });
    },

    /** The same, for the inspection lane. */
    setLanePhase(text) {
      this._lanePhase = text ? { text, at: Date.now() } : null;
      State.setWorker({ statusText: this._phaseText() || 'Idle', qcLane: this.laneImages() });
    },

    _phaseText() {
      const stamp = (p) => {
        if (!p) return null;
        const sec = Math.round((Date.now() - p.at) / 1000);
        if (sec < 45) return p.text;
        const m = Math.floor(sec / 60);
        return `${p.text} — ${m ? `${m}m ` : ''}${sec % 60}s`;
      };
      const main = stamp(this._phase);
      const lane = stamp(this._lanePhase);
      if (main && lane) return `${main} · QC lane: ${lane}`;
      return main || (lane ? `QC lane: ${lane}` : null);
    },

    /** One job, as far as "the pixels exist and are safe on disk". */
    async processJob(job) {
      job.status = 'generating';
      job.updatedAt = Date.now();
      State.persistQueue();
      log(`Generating: "${job.prompt.slice(0, 70)}…"`);
      const generationDriver = this.genDriver();

      if (!job.controls && this.advancedIdeationOn() && generationDriver === this.driver) {
        try {
          this.setPhase('Choosing generator controls…');
          const picked = await this.chooseControls(job.prompt);
          if (picked) {
            job.controls = picked;
            job.updatedAt = Date.now();
            State.persistQueue();
            log(`Controls chosen for this prompt: ${Object.entries(picked).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
          }
        } catch (e) {
          log(`Could not choose controls (${e.message}) — generating with the saved presets.`, 'err');
        }
      }

      let batch;
      try {
        let references = [];
        if (Array.isArray(job.referenceIds) && job.referenceIds.length) {
          if (generationDriver === this._comfyDriver) {
            this.setPhase('Preparing searched references…');
            references = await this.researchReferences(job);
          } else if (job.promptSource === 'edit') {
            // "Edit <image1>…" without the picture would render a random new image.
            throw new Error('an image edit needs the ComfyUI engine (Settings → Generation) — Perchance cannot take a picture as input');
          } else {
            job.referenceFetchErrors = job.referenceIds.map((id) => ({
              id: String(id), error: 'the active generation engine does not accept image references',
            }));
            log('The active engine cannot receive image references — using the research-grounded prompt text only.', 'err');
          }
        }

        this.setPhase('Generating images…');
        const result = await generationDriver.generate(job.prompt,
          { filters: job.controls, references, shouldStop: () => this._stopRequested, count: Number(job.count) > 0 ? Number(job.count) : 0,
            // An edit (Image Edit tab, 🩹 Fix, Overseer edit_image) comes back at the source size.
            matchSource: !!job.editOf }, log);
        const refResult = result.referenceResult || null;
        job.attachedReferenceIds = refResult ? [...(refResult.attached || [])] : [];
        job.referenceErrors = [
          ...(Array.isArray(job.referenceFetchErrors) ? job.referenceFetchErrors : []),
          ...(refResult && Array.isArray(refResult.failed) ? refResult.failed : []),
          ...(refResult && Array.isArray(refResult.skipped) ? refResult.skipped : []),
        ].slice(0, 8).map((e) => ({ id: String(e.id || ''), error: String(e.error || '').slice(0, 300) }));
        job.updatedAt = Date.now();
        State.persistQueue();
        const images = result.images || [];
        if (!images.length) throw new Error('no images detected on the page');
        if (this.engineDown) {
          log('Image engine is answering again — resuming the queue.', 'ok');
          this.engineDown = null;
        }
        State.bumpStats({ imagesGenerated: images.length });

        this.setPhase(`Saving ${images.length} image(s)…`);
        const items = [];
        for (const img of images) {
          items.push({ card: await this.saveCard(job, img), base64: img.base64, mime: img.mime });
        }
        batch = { job, items };
      } catch (e) {
        if (e && e.engineDown) {
          job.status = 'queued';
          job.error = e.message;
          job.updatedAt = Date.now();
          State.persistQueue();
          if (!this.engineDown) {
            this.engineDown = { since: Date.now(), error: e.message };
            log(`Image engine unreachable — ${e.message}. The job is kept; generation resumes by itself when it answers again.`, 'err');
            osNotify('Acre Art Studio — image engine unreachable', e.message);
          } else {
            this.engineDown.error = e.message;
          }
          return;
        }
        job.attempts += 1;
        const max = State.settings.gen.maxRetries || 0;
        job.error = e.message;
        if (job.attempts <= max) {
          job.status = 'queued';
          log(`Generation error (${e.message}) — retry ${job.attempts}/${max}.`, 'err');
        } else {
          job.status = 'failed';
          log(`Job failed: ${e.message}`, 'err');
        }
        job.updatedAt = Date.now();
        State.persistQueue();
        return;
      }

      if (this.parallelPostOn()) {
        job.status = 'qc';
        job.updatedAt = Date.now();
        State.persistQueue();
        log(`${batch.items.length} image(s) saved — inspecting them alongside the next generation.`);
        this.enqueueBatch(batch);
        return;
      }
      await this.finishBatch(batch);
    },

    /** Hand a saved batch to the lane, starting the lane if it is not already running. */
    enqueueBatch(batch) {
      this._lane.push(batch);
      if (!this._laneRunning) this._lanePromise = this.runLane();
      else State.setWorker({ qcLane: this.laneImages() });
    },

    /** Drain the lane, one batch at a time. */
    async runLane() {
      this._laneRunning = true;
      try {
        while (this._lane.length) {
          const batch = this._lane.shift();
          this._laneCurrent = batch;
          try {
            await this.finishBatch(batch);
          } catch (e) {
            log(`QC lane error: ${e.message}`, 'err');
          }
          this._laneCurrent = null;
        }
      } finally {
        this._laneRunning = false;
        this._laneCurrent = null;
        this.setLanePhase(null);
      }
    },

    /** Park this batch rather than inspect it? */
    _parkInsteadOfInspect() {
      if (this._abandonLane) return true;
      return this._stopRequested && !this.parallelPostOn();
    },

    /** Everything after the pixels exist: inspect, write metadata, settle the job. */
    async finishBatch(batch) {
      const { job, items } = batch;
      const total = items.length;
      const phase = (t) => (this.parallelPostOn() ? this.setLanePhase(t) : this.setPhase(t));
      try {
        // forceQc: a repair the Overseer queued (fix_images) is always inspected — a "fix"
        // nobody checked is not one — even while Manual QC is on.
        const manual = !!State.settings.gen.skipQc && !job.forceQc;
        const route = manual ? null : await window.ala.llm.route('vision').catch(() => null);
        const lead = route && route.chain && route.chain[0];
        const limit = manual ? total : Math.max(1, (route && route.maxConcurrency) || 1);
        const qcStart = Date.now();
        phase(manual
          ? `Finishing ${total} image(s)…`
          : `Inspecting ${total} image(s)${lead ? ` via ${lead.name}` : ''}…`);
        log(manual
          ? `AI quality check is off — ${total} image(s) go straight to Review for manual sorting…`
          : `Inspecting ${total} image(s)${lead ? ` via ${lead.name}` : ''}`
            + `${limit > 1 ? ` — ${limit} at a time` : ' — one at a time'}…`);

        const cards = await U.mapLimit(items, limit, async (it) =>
          this.inspectSaved(job, it, { skipInspection: this._parkInsteadOfInspect() }));
        const passed = cards.filter((c) => c && c.status === 'metadata');
        const stalled = cards.filter((c) => c && c.status === 'qc_error').length;
        log(manual
          ? `${passed.length} image(s) saved in ${Math.round((Date.now() - qcStart) / 1000)}s — none inspected, all go to Review.`
          : `QC done in ${Math.round((Date.now() - qcStart) / 1000)}s — ${passed.length} passed`
            + `, ${cards.filter((c) => c && c.status === 'discarded').length} failed`
            + (stalled ? `, ${stalled} could not be inspected (kept for retry)` : ''));

        const blind = (passed.length && !metadataOff() && metadataNeedsQc())
          ? passed.filter((c) => c && c.qcSkipped)
          : [];
        const described = blind.length ? passed.filter((c) => !(c && c.qcSkipped)) : passed;
        if (blind.length) {
          log(`${blind.length} image(s) were not inspected — they go to Review bare rather than `
            + `carrying a title written from the prompt alone. Turn the AI quality check on, or `
            + `untick "only for inspected images" in Settings → Automatic metadata.`);
          this.promoteWithoutMetadata(blind);
        }

        if (passed.length && metadataOff()) {
          phase(`${passed.length} image(s) → Review…`);
          log(`${passed.length}/${total} ready — auto metadata is off, so they go to Review bare. `
            + `Use "Write metadata" on the ones you like.`);
          this.promoteWithoutMetadata(passed);
        } else if (described.length) {
          const metaLead = await window.ala.llm.route('metadata').catch(() => null);
          const mName = metaLead && metaLead.chain && metaLead.chain[0] && metaLead.chain[0].name;
          phase(`Writing titles & tags for ${described.length}${mName ? ` via ${mName}` : ''}…`);
          log(`${described.length}/${total} passed QC — writing metadata…`);
          await this.applyBatchMetadata(job.basePrompt ? { ...job, prompt: job.basePrompt } : job, described);
        }
        const passCount = passed.length;

        if (passCount > 1 && window.Triage && Triage.autoPickOn()) {
          phase(`Pre-picking the keeper among ${passCount} render(s)…`);
          await Triage.suggestForJob(job.id).catch((e) => log(`AI pre-pick skipped this batch (${e.message}).`, 'err'));
        }

        if (passCount === 0 && stalled === total) {
          job.status = 'done';
          job.error = 'QC did not run — images kept, retry QC from the Review tab';
          log(`Job parked — none of ${total} image(s) were inspected `
            + `(${this._stopRequested ? 'worker stopped' : 'vision model unreachable'}). `
            + `They are kept, not discarded.`, 'err');
        } else if (passCount === 0 && job.autoFix) {
          // An auto-fix repair is never re-rendered by Retries: the auto-fix chain owns its
          // tries (gen.autoFixTries). Only when EVERY picture of the repair failed does the
          // next try go in (a re-render's 2 seeds: one passing is a fixed picture).
          job.status = 'failed';
          job.error = 'auto-fix repair failed QC';
          log(`Auto-fix repair ${job.autoFixTry || 1}${job.fixMode === 'rerender' ? ' (re-render)' : ''} failed QC.`, 'err');
          const lastFail = cards.filter((c) => c && c.status === 'discarded' && c.qc).pop();
          if (lastFail && window.ImageEdit) await ImageEdit.maybeAutoFix(lastFail).catch(() => null);
        } else if (passCount === 0) {
          job.attempts += 1;
          const max = State.settings.gen.maxRetries || 0;
          if (job.attempts <= max) {
            job.status = 'queued';
            log(`All images failed QC — retrying (${job.attempts}/${max}).`, 'err');
          } else {
            job.status = 'failed';
            job.error = 'all images failed QC after retries';
            log('Job failed: all images failed QC after retries.', 'err');
          }
        } else {
          job.status = 'done';
          log(`Job done — ${passCount}/${total} image(s) passed QC.`, 'ok');
        }
      } catch (e) {
        job.attempts += 1;
        const max = State.settings.gen.maxRetries || 0;
        job.error = e.message;
        if (job.attempts <= max) {
          job.status = 'queued';
          log(`Error after generation (${e.message}) — retry ${job.attempts}/${max}.`, 'err');
        } else {
          job.status = 'failed';
          log(`Job failed: ${e.message}`, 'err');
        }
      }
      job.updatedAt = Date.now();
      State.persistQueue();
      if (this.parallelPostOn()) {
        this.setLanePhase(this._lane.length ? `${this.laneImages()} image(s) waiting` : null);
      }
    },

    /** Run vision QC on one image and return { qc, meta }. */
    async inspect(base64, mime, prompt) {
      const small = await this.downscaleForQc(base64, mime);
      const threshold = State.settings.gen.passThreshold || 7;
      const metrics = State.settings.gen.qcMetrics !== false
        ? await this.qcMetrics(small.base64, small.mime).catch(() => null)
        : null;
      const r = await U.llmVision(small.base64, small.mime,
        T.qc(prompt, threshold), {}, 'Vision QC');
      let qc;
      try { qc = validateQc(U.extractJson(r.text)); }
      catch (e) {
        e.qcAttempt = { stage: 'inspection', engine: r.engine || 'unknown', model: r.model || '',
          promptVersion: QC_PROMPT_VERSION, policyVersion: QC_POLICY_VERSION, error: e.message };
        throw e;
      }
      const meta = {
        engine: r.engine, model: r.model, latencyMs: r.latencyMs, passes: 1,
        promptVersion: QC_PROMPT_VERSION,
        promptTokens: r.promptTokens || 0,
        completionTokens: r.completionTokens || 0,
        metrics,
      };
      const worth = State.settings.gen.qcGeneralPass !== false
        && this.applyQcResult({}, qc, meta);
      const confirm = !worth && this.vetoNeedsConfirmation(qc);
      meta.generalRequired = worth;
      meta.confirmRequired = confirm;
      if (worth || confirm) {
        meta.gateRole = worth ? 'second-opinion' : 'confirm-veto';
        try {
          const g = await U.llmVision(small.base64, small.mime, T.qcGates(), {},
            worth ? 'Vision QC (general)' : 'Vision QC (checking a veto)');
          meta.gateEngine = g.engine;
          meta.gateModel = g.model;
          meta.gates = U.extractJson(g.text);
          if (!gateScore(meta.gates)?.complete) throw new Error('Invalid general QC response: all five YES/NO gates and a score from 1 to 10 are required');
          meta.gateLatencyMs = g.latencyMs || 0;
          meta.promptTokens += g.promptTokens || 0;
          meta.completionTokens += g.completionTokens || 0;
          meta.latencyMs += g.latencyMs || 0;
          meta.passes = 2;
        } catch (e) {
          log(worth
            ? `General QC pass could not run — image kept for retry (${e.message}).`
            : `Second look at a vetoed image could not run — image kept for retry (${e.message}).`, 'err');
          e.qcAttempt = { stage: worth ? 'general' : 'confirm-veto', inspection: qc, engine: meta.engine || 'unknown', model: meta.model || '',
            gateEngine: meta.gateEngine || 'unknown', gateModel: meta.gateModel || '', gates: meta.gates || null,
            promptVersion: QC_PROMPT_VERSION, policyVersion: QC_POLICY_VERSION, error: e.message };
          throw e;
        }
      }
      return { qc, meta };
    },

    /** Shrink an image before it reaches the vision model, if it is bigger than the cap. */
    async downscaleForQc(base64, mime) {
      const maxEdge = Number(State.settings.gen.qcMaxEdge) || 0;
      if (!maxEdge) return { base64, mime };
      try {
        const img = await new Promise((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = () => reject(new Error('decode failed'));
          el.src = `data:${mime};base64,${base64}`;
        });
        const longest = Math.max(img.naturalWidth, img.naturalHeight);
        if (!longest || longest <= maxEdge) return { base64, mime };
        const scale = maxEdge / longest;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const url = canvas.toDataURL('image/jpeg', 0.92);
        const out = url.split(',')[1];
        if (!out) return { base64, mime };
        log(`QC image downscaled ${img.naturalWidth}x${img.naturalHeight} → ${canvas.width}x${canvas.height} before inspection.`);
        return { base64: out, mime: 'image/jpeg' };
      } catch {
        return { base64, mime };
      }
    },

    /**
     * Deterministic pixel measurements, taken on the same downscaled pixels the vision model is
     * shown.
     */
    async qcMetrics(base64, mime) {
      const MEASURE_EDGE = 512;
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('decode failed'));
        el.src = `data:${mime};base64,${base64}`;
      });
      const longest = Math.max(img.naturalWidth, img.naturalHeight);
      if (!longest) throw new Error('no pixels in image');
      const scale = Math.min(1, MEASURE_EDGE / longest);
      const w = Math.max(8, Math.round(img.naturalWidth * scale));
      const h = Math.max(8, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('no 2d context');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      const px = ctx.getImageData(0, 0, w, h).data;
      const lum = new Float32Array(w * h);
      for (let i = 0, p = 0; i < lum.length; i++, p += 4) lum[i] = 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];
      let mean = 0;
      for (let i = 0; i < lum.length; i++) mean += lum[i];
      mean /= lum.length;
      let varr = 0;
      for (let i = 0; i < lum.length; i++) { const d = lum[i] - mean; varr += d * d; }
      varr /= lum.length;
      const sd = Math.sqrt(varr) || 1;
      let hf = 0, lap = 0, n = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          const nb = (lum[i - 1] + lum[i + 1] + lum[i - w] + lum[i + w]) / 4;
          hf += Math.abs(lum[i] - nb);
          const l = 4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - w] - lum[i + w];
          lap += l * l;
          n++;
        }
      }
      const T = 16;
      let tiles = 0, flat = 0;
      for (let ty = 0; ty + T <= h; ty += T) {
        for (let tx = 0; tx + T <= w; tx += T) {
          let m = 0;
          for (let y = ty; y < ty + T; y++) for (let x = tx; x < tx + T; x++) m += lum[y * w + x];
          m /= T * T;
          let v = 0;
          for (let y = ty; y < ty + T; y++) for (let x = tx; x < tx + T; x++) { const d = lum[y * w + x] - m; v += d * d; }
          v /= T * T;
          tiles++;
          if (Math.sqrt(v) < 3) flat++;
        }
      }
      const r4 = (x) => Math.round(x * 10000) / 10000;
      return {
        w, h,
        detail: r4(n ? (hf / n) / sd : 0),
        sharp: r4(n ? lap / n / (varr + 1) : 0),
        flat: r4(tiles ? flat / tiles : 0),
      };
    },

    /**
     * Cap a score by how much fine detail the picture actually carries, ranked against this
     * artist's own library.
     */
    metricsCap(metrics) {
      if (!metrics || State.settings.gen.qcMetrics === false) return null;
      const floor = Number(State.settings.gen.qcDetailFloor);
      if (!Number.isFinite(floor) || floor <= 0) return null;
      const ref = [];
      for (const c of (State.library || [])) {
        const m = c && c.qc && c.qc.metrics;
        if (m && typeof m.detail === 'number') ref.push(m.detail);
      }
      if (ref.length < METRIC_MIN_SAMPLES) return null;
      const pct = percentileOf(ref, metrics.detail);
      if (pct === null || pct > floor) return null;
      return { ceiling: 6, percentile: pct, floor, samples: ref.length, value: metrics.detail };
    },

    /**
     * The structural hard defects in an inspection, found by reading what the inspector WROTE
     * rather than the severity it chose.
     */
    qcVetoes(defects, fingerCounts, regions = null) {
      const words = [];
      for (const d of defects || []) {
        const text = `${(d && d.what) || ''} ${(d && d.where) || ''}`.trim();
        for (const w of hardDefectWords(text)) if (!words.includes(w)) words.push(w);
      }
      const hands = (Array.isArray(regions) ? regions : [])
        .find((r) => r && typeof r === 'object' && /hand/i.test(String(r.region || '')));
      const fr = fingerReport(fingerCounts, { handsVerdict: hands ? hands.verdict : null });
      return { words, fingers: fr.bad.map((h) => h.said), hands: fr.hands };
    },

    /** Would a second look be worth spending on this vetoed frame? */
    vetoNeedsConfirmation(qc) {
      const gen = State.settings.gen || {};
      if (gen.qcConfirmVeto === false || gen.qcVeto === false) return false;
      if (!qc || typeof qc.verdict !== 'string' || qc.verdict.trim().toUpperCase() !== 'PASS') return false;
      const threshold = gen.passThreshold || 7;
      if (Math.min(Number(qc.score), DISPUTED_CAP) < threshold) return false;
      const defects = (Array.isArray(qc.defects) ? qc.defects : []).map((d) => (d && typeof d === 'object')
        ? { what: String(d.what || d.defect || ''), where: String(d.where || ''), severity: String(d.severity || '').trim().toLowerCase() }
        : { what: String(d), where: '', severity: '' });
      if (defects.some((d) => d.severity === 'severe')) return false;
      const veto = this.qcVetoes(defects, qc.fingerCounts, qc.regions);
      return veto.words.length > 0 || veto.fingers.length > 0;
    },

    qcHardWords: hardDefectWords,
    qcFingerReport: fingerReport,
    qcGateScore: gateScore,
    qcPercentile: percentileOf,

    /** Write one generated frame to disk and put it in the library, uninspected. */
    async saveCard(job, img) {
      const saved = await window.ala.files.saveImage(img.base64, U.extFromMime(img.mime), 'pch');
      const card = {
        // An Image Edit / Fix card keeps its source's prompt as `prompt` — titles, metadata
        // and QC all read it — and the instruction Qwen got as `editPrompt`. A fix
        // instruction quotes the QC critique, which must never reach the title writer.
        id: saved.id, jobId: job.id, theme: job.theme, prompt: job.basePrompt || job.prompt,
        editPrompt: job.promptSource === 'edit' ? job.prompt : null,
        editLabel: job.editLabel || null,
        editRoot: job.editRoot || null,
        // Image Edit history: the artist's own instruction (✎ Reuse) and which checkpoint a ↻ Redo repeats.
        editInstruction: job.editInstruction || null,
        redoOf: job.redoOf || null,
        fixOf: job.fixOf || null,
        autoFix: job.autoFix ? true : undefined,
        promptSource: job.promptSource || 'ideation', learnedFrom: job.learnedFrom || null,
        researchId: job.researchId || null,
        promptSetId: job.promptSetId || null,
        researchPromptIndex: Number.isInteger(job.researchPromptIndex) ? job.researchPromptIndex : null,
        researchQuery: job.researchQuery || null,
        referenceIds: Array.isArray(job.referenceIds) ? [...job.referenceIds] : [],
        chatReferences: Array.isArray(job.chatReferences)
          ? job.chatReferences.slice(0, 16).map((r) => ({ id: String(r.id || ''), fname: String(r.fname || ''), name: String(r.name || '').slice(0, 80) })) : [],
        attachedReferenceIds: Array.isArray(job.attachedReferenceIds) ? [...job.attachedReferenceIds] : [],
        referenceErrors: Array.isArray(job.referenceErrors)
          ? job.referenceErrors.slice(0, 8).map((e) => ({ id: String(e.id || ''), error: String(e.error || '').slice(0, 300) })) : [],
        continuationOf: job.continuationOf || null,
        requestId: job.requestId || null,
        batchId: job.batchId || null,
        editOf: job.editOf || null,
        fname: saved.fname, path: saved.path, url: saved.url,
        mime: img.mime, width: img.w, height: img.h,
        destinations: defaultDestinations(),
        destination: defaultDestinations()[0],
        status: 'qc', qc: null, metadata: null, da: null, pixiv: null, pixivPrep: null, error: null,
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      State.library.unshift(card);
      State.persistLibrary();
      return card;
    },

    /** Judge one already-saved frame. */
    async inspectSaved(job, item, { skipInspection = false } = {}) {
      const card = item.card;
      try {
        if (skipInspection) {
          card.status = 'qc_error';
          card.error = 'worker was stopped before this image was inspected';
          card.updatedAt = Date.now();
          State.persistLibrary();
          return card;
        }

        if (State.settings.gen.skipQc && !job.forceQc) {
          card.qc = null;
          card.qcSkipped = true;
          card.status = 'metadata';
          card.updatedAt = Date.now();
          State.persistLibrary();
          return card;
        }

        let pass;
        try {
          const out = await this.inspect(item.base64, item.mime, job.basePrompt || job.prompt);
          pass = this.applyQcResult(card, out.qc, out.meta);
          if (card.fixOf && window.ImageEdit) ImageEdit.noteFixResult(card);
          card.error = null;
          delete card.qcAttempt;
          if (card.qc && card.qc.veto && card.qc.veto.checked === 'disputed') {
            log(`QC veto disputed by a second look (${card.qc.score}/10) — sent to Review for you to judge.`);
          }
          this.noteQcOutcome();
        } catch (e) {
          card.status = 'qc_error';
          card.error = 'QC error: ' + e.message;
          card.qcAttempt = e.qcAttempt || { stage: 'inspection', error: e.message, policyVersion: QC_POLICY_VERSION };
          card.updatedAt = Date.now();
          State.persistLibrary();
          log(`QC could not run — image kept for retry (${e.message})`, 'err');
          return card;
        }
        if (!pass) {
          card.status = 'discarded';
          card.updatedAt = Date.now();
          State.persistLibrary();
          State.bumpStats({ imagesFailed: 1 });
          log(`QC FAIL (${card.qc.score}/10): ${card.qc.defects.slice(0, 2).join('; ') || card.qc.notes}`, 'err');
          // A failed REPAIR waits for its batch: a re-render makes several seeds, and one
          // failing while its sibling passes is not a reason to try again (finishBatch decides).
          if (window.ImageEdit && !(job.autoFix && job.fixOf)) await ImageEdit.maybeAutoFix(card).catch(() => null);
          return card;
        }

        card.status = 'metadata';
        card.updatedAt = Date.now();
        State.persistLibrary();
        State.bumpStats({ imagesPassed: 1 });
        return card;
      } finally {
        item.base64 = null;
      }
    },

    /** Whether the pass threshold still fits the inspector behind it. */
    qcCalibration(n = 40) {
      const threshold = State.settings.gen.passThreshold || 7;
      const scored = (State.library || [])
        .filter((c) => c && c.qc && typeof c.qc.score === 'number')
        .slice(0, n);
      if (scored.length < 20) return null;
      const scores = scored.map((c) => c.qc.score);
      const rateAt = (x) => scores.filter((s) => s >= x).length / scores.length;
      let suggest = threshold;
      for (let cand = 9; cand >= 3; cand--) { if (rateAt(cand) >= 0.5) { suggest = cand; break; } }
      const passed = (c) => {
        const v = String(c.qc.verdict || '').trim().toUpperCase();
        return v ? v === 'PASS' : c.qc.score >= threshold;
      };
      const blockers = { veto: 0, general: 0, detail: 0, score: 0, inspector: 0 };
      for (const c of scored) {
        if (passed(c)) continue;
        const by = (c.qc.caps || []).map((k) => k && k.by);
        if (by.includes('veto')) blockers.veto++;
        else if (by.includes('general')) blockers.general++;
        else if (by.includes('detail')) blockers.detail++;
        else if (c.qc.score < threshold) blockers.score++;
        else blockers.inspector++;
      }
      return {
        n: scores.length, threshold, passRate: scored.filter(passed).length / scored.length,
        suggest, suggestRate: rateAt(suggest), blockers,
      };
    },

    /**
     * The calibration, said in one log line that names the switch to reach for — or null when the
     * pass rate is not alarming.
     */
    qcCalibrationNote(cal) {
      if (!cal || cal.passRate >= 0.15) return null;
      const b = cal.blockers || {};
      const top = Object.entries(b).sort((x, y) => y[1] - x[1])[0] || ['score', 0];
      const head = `QC passed ${Math.round(cal.passRate * 100)}% of the last ${cal.n} inspections`;
      const failed = cal.n - Math.round(cal.passRate * cal.n);
      switch (top[0]) {
        case 'veto':
          return `${head} — the hand/anatomy veto failed ${top[1]} of the ${failed}. The inspector's own words did it, so a lower pass bar cannot help;`
            + ' Settings → Quality check → "Check a veto with a second look" lets a disputed frame through, and "Believe what the inspector describes" switches the veto off.';
        case 'general':
          return `${head} — the second-opinion gates capped ${top[1]} of the ${failed} (Settings → Quality check → "Second opinion on everything that would pass").`;
        case 'detail':
          return `${head} — the detail floor capped ${top[1]} of the ${failed} (Settings → Quality check → Detail floor).`;
        case 'inspector':
          return `${head} — the inspector itself answered FAIL on ${top[1]} of the ${failed}. That is the vision model's own verdict, not a setting here; try another model on the vision role.`;
        default:
          return cal.suggest < cal.threshold
            ? `${head} at a bar of ${cal.threshold} — this inspector scores lower than that. ${cal.suggest} would pass ${Math.round(cal.suggestRate * 100)}%. Settings → Generation → Pass threshold.`
            : `${head}; ${top[1]} of the ${failed} scored under the bar of ${cal.threshold}.`;
      }
    },

    /** Watch the pass rate from the worker, not only from auto mode. */
    noteQcOutcome() {
      const w = this._qcWatch || (this._qcWatch = { n: 0, saidAt: 0 });
      w.n += 1;
      if (w.n % 20 !== 0 || Date.now() - w.saidAt < 30 * 60_000) return null;
      const note = this.qcCalibrationNote(this.qcCalibration());
      if (note) { w.saidAt = Date.now(); log(note, 'err'); }
      return note;
    },

    /**
     * Normalise a raw QC response onto the card, run it past the three independent checks, and
     * return whether it passed.
     */
    applyQcResult(card, qc, qcMeta = {}) {
      validateQc(qc);
      const threshold = State.settings.gen.passThreshold || 7;
      const rawScore = Number(qc.score);
      const defects = (Array.isArray(qc.defects) ? qc.defects : []).map((d) =>
        (d && typeof d === 'object')
          ? { what: String(d.what || d.defect || ''), where: String(d.where || ''), severity: String(d.severity || 'noticeable').trim().toLowerCase(), area: String(d.area || ''), focus: String(d.focus || '') }
          : { what: String(d), where: '', severity: 'noticeable' });

      const vetoOn = State.settings.gen.qcVeto !== false;
      const veto = vetoOn ? this.qcVetoes(defects, qc.fingerCounts, qc.regions) : { words: [], fingers: [], hands: [] };
      const vetoed = veto.words.length > 0 || veto.fingers.length > 0;
      const confirmOn = State.settings.gen.qcConfirmVeto !== false;
      const gatesOn = State.settings.gen.qcGeneralPass !== false || (confirmOn && vetoed && qcMeta.gateRole === 'confirm-veto');
      const gates = gatesOn ? gateScore(qcMeta.gates) : null;
      if (State.settings.gen.qcGeneralPass !== false && qcMeta.generalRequired && !gates?.complete) {
        throw new Error('Required general QC is incomplete; retry inspection');
      }
      if (confirmOn && vetoed && qcMeta.confirmRequired && !gates?.complete) {
        throw new Error('The second look at a vetoed image is incomplete; retry inspection');
      }
      const metricCap = this.metricsCap(qcMeta.metrics);
      const checkedVeto = confirmOn && vetoed && qcMeta.gateRole === 'confirm-veto' && !!gates && gates.complete;
      const disputed = checkedVeto && gates.structural === 0;

      let score = rawScore;
      const caps = [];
      if (vetoed) {
        const said = [
          veto.words.length ? `its own defect list says "${veto.words.join('", "')}"` : '',
          veto.fingers.length ? `it counted the fingers as ${veto.fingers.join(' / ')}` : '',
        ].filter(Boolean).join('; ');
        if (disputed) {
          if (score > DISPUTED_CAP) {
            caps.push({
              by: 'veto', to: DISPUTED_CAP, disputed: true,
              why: `${said} — but a second, independent look found every hand, limb and face correct. Disputed: yours to judge.`,
            });
            score = DISPUTED_CAP;
          }
        } else if (score > SEVERE_BAND) {
          caps.push({
            by: 'veto', to: SEVERE_BAND,
            why: checkedVeto
              ? `${said}; a second look agreed (${gates.failed.filter((k) => STRUCTURAL_GATES.includes(k)).join(', ')})`
              : said,
          });
          score = SEVERE_BAND;
        }
      }
      if (gates && gates.ceiling < score) {
        caps.push({
          by: 'general', to: gates.ceiling,
          why: gates.no
            ? `${gates.no} of ${gates.answered} general gates answered NO (${gates.failed.join(', ')})${gates.worst && !/^nothing/i.test(gates.worst) ? ` — ${gates.worst}` : ''}`
            : `said this is a ${gates.overall}/10 on its own`,
        });
        score = gates.ceiling;
      }
      if (metricCap && metricCap.ceiling < score) {
        caps.push({
          by: 'detail', to: metricCap.ceiling,
          why: `less fine detail than ${100 - metricCap.percentile}% of your library (detail ${metricCap.value}, bottom ${metricCap.floor}% caps at ${metricCap.ceiling})`,
        });
        score = metricCap.ceiling;
      }

      const hasSevere = defects.some((d) => d.severity === 'severe') || (vetoed && !disputed) || (gates && gates.structural > 0);
      const pass = score >= threshold && !hasSevere && qc.verdict.trim().toUpperCase() === 'PASS';

      card.qc = {
        score,
        rawScore,
        policyVersion: QC_POLICY_VERSION,
        promptVersion: qcMeta.promptVersion || 'unknown',
        threshold,
        verdict: pass ? 'PASS' : 'FAIL',
        modelVerdict: qc.verdict.trim().toUpperCase(),
        caps,
        veto: {
          words: veto.words, fingers: veto.fingers,
          ...(checkedVeto ? { checked: disputed ? 'disputed' : 'confirmed' } : {}),
        },
        defects: defects.map((d) => d.where ? `${d.what} (${d.where})` : d.what).filter(Boolean),
        detail: defects,
        regions: (Array.isArray(qc.regions) ? qc.regions : []).map((r) =>
          (r && typeof r === 'object')
            ? {
              region: String(r.region || ''),
              verdict: ['CLEAN', 'DEFECT', 'NOT_VISIBLE'].includes(String(r.verdict || '').trim().toUpperCase()) ? String(r.verdict).trim().toUpperCase() : 'UNKNOWN',
              detail: String(r.detail || ''),
            }
            : { region: String(r || '').trim(), verdict: 'UNKNOWN', detail: '' }).filter((r) => r.region),
        fingerCounts: String(qc.fingerCounts || ''),
        fingers: veto.hands,
        notes: String(qc.notes || ''),
        fix: String(qc.fix || ''),
        scene: String(qc.scene || ''),
        gates: gates ? {
          ceiling: gates.ceiling, overall: gates.overall, no: gates.no, structural: gates.structural,
          answered: gates.answered, failed: gates.failed, worst: gates.worst,
          answers: gates.answers, complete: gates.complete, raw: qcMeta.gates,
        } : null,
        metrics: qcMeta.metrics ? {
          ...qcMeta.metrics,
          detailPercentile: metricCap ? metricCap.percentile : null,
          samples: metricCap ? metricCap.samples : 0,
        } : null,
        engine: qcMeta.engine || 'unknown',
        model: qcMeta.model || '',
        latencyMs: qcMeta.latencyMs || 0,
        passes: qcMeta.passes || 1,
        promptTokens: qcMeta.promptTokens || 0,
        completionTokens: qcMeta.completionTokens || 0,
        gateEngine: qcMeta.gateEngine || '',
        gateModel: qcMeta.gateModel || '',
        gateLatencyMs: qcMeta.gateLatencyMs || 0,
      };
      return pass;
    },

    /**
     * Re-run QC on a card whose inspection never completed (`qc_error`), reading the image back off
     * disk.
     */
    async retryQc(card) {
      const fromQcError = card.status === 'qc_error';
      let applied;
      try {
        const base64 = await window.ala.files.readImageBase64(card.fname);
        const out = await this.inspect(base64, card.mime || 'image/jpeg', card.prompt);
        applied = this.applyQcResult(card, out.qc, out.meta);
      } catch (e) {
        card.status = 'qc_error';
        card.error = 'QC error: ' + e.message;
        card.qcAttempt = e.qcAttempt || { stage: 'inspection', error: e.message, policyVersion: QC_POLICY_VERSION };
        card.updatedAt = Date.now();
        State.persistLibrary();
        throw e;
      }
      delete card.qcAttempt;
      card.error = null;
      card.qcSkipped = false;
      if (applied) {
        if (!hasMetadata(card) && !metadataOff()) {
          card.metadata = await this.genMetadata(card.prompt, card.qc, destinationsOf(card)).catch(() => null);
          card.metaEngine = card.metadata ? (this._lastMetaEngine || null) : null;
          if (card.metadata) settleTitles([card]);
        }
        card.status = 'review';
        if (fromQcError) State.bumpStats({ imagesPassed: 1 });
      } else if (fromQcError) {
        card.status = 'discarded';
        State.bumpStats({ imagesFailed: 1 });
      }
      card.updatedAt = Date.now();
      State.persistLibrary();
      return card;
    },

    /** One metadata call for a whole batch, so sibling titles come out distinct. */
    async applyBatchMetadata(job, cards) {
      const devices = Titles.takeDevices(cards.length);
      const variety = Titles.promptBlock({ prompt: job.prompt, count: cards.length, devices });

      this._lastMetaEngine = null;
      let list = await this._askBatchMetadata(job, cards, variety);

      if (list) {
        let rescued = 0;
        for (const p of Titles.review(list)) {
          const entry = list[p.index];
          const alts = Array.isArray(entry && entry.alts) ? entry.alts : [];
          if (!alts.length) continue;
          const taken = list.filter((x, i) => i !== p.index).map((x) => String((x && x.title) || ''));
          const pick = Titles.pickFree(alts, { avoid: taken });
          if (pick) { entry.title = pick.title; rescued++; }
        }
        if (rescued) log(`${rescued} title(s) repeated something already used — swapped for the writer's own spares, at no extra call.`);
      }

      let budget = Math.max(0, Number(Titles.cfg.maxRepairs) || 0);
      while (list && budget > 0) {
        const problems = Titles.review(list);
        if (!problems.length) break;
        budget--;
        log(`${problems.length} title(s) repeated something already used — asking for replacements: `
          + problems.map((p) => `"${p.title}" (${p.reason})`).join('; '), 'err');
        const fixed = await this._askReplacementTitles(job, problems);
        if (!fixed) break;
        for (let i = 0; i < problems.length; i++) {
          const candidate = String(fixed[i] || '').trim();
          if (!candidate) continue;
          const before = Titles.similarity(problems[i].title, (Titles.nearest(problems[i].title, { exclude: [problems[i].title] }) || {}).t || '');
          const after = Titles.isRepeat(candidate, { exclude: [candidate] });
          if (!after.repeat || (after.against && after.against.score < before)) {
            list[problems[i].index].title = candidate;
          }
        }
      }

      for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        const entry = list && list[i];
        card.metadata = entry
          ? this.shapeMetadata(entry, destinationsOf(card))
          : await this.genMetadata(job.prompt, card.qc, destinationsOf(card)).catch(() => null);
        card.metaEngine = entry ? this._lastMetaEngine : (this._lastMetaEngine || null);
        card.metaFromImage = false;
        if (card.status === 'metadata') card.status = 'review';
        card.updatedAt = Date.now();
      }
      settleTitles(cards);
      State.persistLibrary();
    },

    /** The targeted second call: replacement titles for named slots, nothing else. */
    async _askReplacementTitles(job, problems) {
      try {
        const { text } = await U.llmChat(
          [{ role: 'user', content: T.retitle({
            prompt: job.prompt,
            slots: problems,
            variety: Titles.promptBlock({ prompt: job.prompt, count: problems.length }),
          }) }],
          { temperature: Titles.temperature(0.15), maxTokens: 4000 + 400 * problems.length, role: 'metadata' },
          'Replacement titles');
        const raw = U.extractJson(text);
        const list = Array.isArray(raw) ? raw : (raw.titles || raw.items || null);
        return Array.isArray(list) ? list.map((x) => (typeof x === 'string' ? x : (x && x.title) || '')) : null;
      } catch (e) {
        log('Could not get replacement titles (' + e.message + ') — keeping what was written.', 'err');
        return null;
      }
    },

    async _askBatchMetadata(job, cards, variety) {
      const s = State.settings;
      const preferredTags = window.Insights ? window.Insights.preferredTags(8) : [];
      const titleHints = window.Insights && window.Insights.playbook
        ? (window.Insights.playbook.titleTraits || []).filter((t) => t.lift >= 1.2).slice(0, 3).map((t) => t.key)
        : [];
      try {
        const { text, provider, tier, model } = await U.llmChat(
          [{ role: 'user', content: T.metadataBatch({
            prompt: job.prompt,
            count: cards.length,
            exampleStyle: s.metadata.exampleStyle,
            maxTags: s.metadata.maxTags,
            variety,
            preferredTags,
            titleHints,
            scenes: cards.map((c) => (c && c.qc && c.qc.scene) || ''),
          }) }],
          { temperature: Titles.temperature(), maxTokens: 1200 * cards.length + 4000, role: 'metadata' },
          'Batch metadata');
        this._lastMetaEngine = { provider, tier, model, at: Date.now() };
        const raw = U.extractJson(text);
        return Array.isArray(raw) ? raw : (raw.items || raw.metadata || null);
      } catch (e) {
        log('Batch metadata failed (' + e.message + ') — falling back to per-image.', 'err');
        return null;
      }
    },

    shapeMetadata(raw, destination = 'deviantart') {
      const s = State.settings;
      const learned = window.Insights ? window.Insights.preferredTags(6) : [];
      const written = String(raw.title || 'Untitled').replace(/["#]/g, '').trim().slice(0, 50) || 'Untitled';
      return {
        title: written,
        titleWritten: written,
        /** The spare titles from the same response, kept until the collision check has run. */
        titleAlts: (Array.isArray(raw.alts) ? raw.alts : [])
          .map((t) => String(t || '').replace(/["#]/g, '').trim().slice(0, 50))
          .filter((t) => t && t.toLowerCase() !== written.toLowerCase())
          .slice(0, 4),
        description: buildDescription(s.patreon.link, s.patreon.cta, raw.description, destination),
        tags: finalizeTags(raw.tags, [...learned, ...(s.metadata.defaultTags || [])], s.metadata.maxTags),
      };
    },

    async genMetadata(prompt, qc, destination = 'deviantart') {
      const s = State.settings;
      const { text, provider, tier, model } = await U.llmChat(
        [{ role: 'user', content: T.metadata({
          prompt,
          exampleStyle: s.metadata.exampleStyle,
          maxTags: s.metadata.maxTags,
          variety: Titles.promptBlock({ prompt, count: 1 }),
          scene: (qc && qc.scene) || '',
        }) }],
        { temperature: Titles.temperature(), maxTokens: 3500 + descriptionHeadroom(), role: 'metadata' }, 'Metadata');
      this._lastMetaEngine = { provider, tier, model, at: Date.now() };
      return this.shapeMetadata(U.extractJson(text), destination);
    },

    /** Rewrite ONE card's title and nothing else. */
    async retitleCard(card, reason = '') {
      if (!card || !card.metadata) throw new Error('this card has no metadata to retitle');
      const current = String(card.metadata.title || '').trim();
      const verdict = current ? Titles.isRepeat(current, { exclude: [current] }) : { repeat: false };
      const slot = {
        title: current || '(none)',
        reason: reason
          || (verdict.repeat ? `too close to "${verdict.against.t}"` : 'the artist asked for a different one'),
      };
      const { text, provider, tier, model } = await U.llmChat(
        [{ role: 'user', content: T.retitle({
          prompt: card.prompt || '',
          slots: [slot],
          variety: Titles.promptBlock({ prompt: card.prompt || '', count: 1 }),
        }) }],
        { temperature: Titles.temperature(0.15), maxTokens: 4400, role: 'metadata' }, 'New title');
      const raw = U.extractJson(text);
      const list = Array.isArray(raw) ? raw : (raw.titles || [raw.title]);
      const next = String((list && (typeof list[0] === 'string' ? list[0] : (list[0] || {}).title)) || '')
        .replace(/["#]/g, '').trim().slice(0, 50);
      if (!next) throw new Error('the writer returned nothing usable');
      card.metadata.title = next;
      card.metadata.titleWritten = next;
      card.metaEngine = { provider, tier, model, at: Date.now() };
      delete card.titleWarning;
      Titles.remember(next, 'card', card.id);
      card.updatedAt = Date.now();
      State.persistLibrary();
      return next;
    },

    /** Send a batch to Review carrying no metadata at all — the `gen.skipMetadata` path. */
    promoteWithoutMetadata(cards) {
      for (const card of cards) {
        card.metadata = null;
        card.metaEngine = null;
        card.status = 'review';
        card.updatedAt = Date.now();
      }
      State.persistLibrary();
      return cards;
    },

    /** Write metadata for ONE card from the prompt that generated it. */
    async writeCardMetadata(card) {
      const meta = await this.genMetadata(card.prompt, card.qc, destinationsOf(card));
      card.metadata = meta;
      card.metaEngine = this._lastMetaEngine || null;
      card.metaFromImage = false;
      card.updatedAt = Date.now();
      settleTitles([card]);
      State.persistLibrary();
      return meta;
    },

    /** Write ONE card's metadata from the FINISHED IMAGE — Review's "Enhance" button. */
    async enhanceCardMetadata(card) {
      if (!card) throw new Error('no card');
      const s = State.settings;
      const preferredTags = window.Insights ? window.Insights.preferredTags(8) : [];
      const titleHints = window.Insights && window.Insights.playbook
        ? (window.Insights.playbook.titleTraits || []).filter((t) => t.lift >= 1.2).slice(0, 3).map((t) => t.key)
        : [];
      let meta = null;
      let engine = null;
      let sawTheImage = true;
      try {
        const full = await window.ala.files.readImageBase64(card.fname);
        const small = await this.downscaleForQc(full, card.mime || 'image/jpeg');
        const r = await U.llmVision(small.base64, small.mime, T.metadataVision({
          prompt: card.prompt || '',
          exampleStyle: s.metadata.exampleStyle,
          maxTags: s.metadata.maxTags,
          variety: Titles.promptBlock({ prompt: card.prompt || '', count: 1 }),
          preferredTags,
          titleHints,
        }), {
          temperature: Titles.temperature(),
          maxTokens: 6000 + descriptionHeadroom(),
        }, 'Metadata from image');
        const raw = U.extractJson(r.text);
        const one = Array.isArray(raw) ? raw[0] : raw;
        if (!one || (!String(one.title || '').trim() && !String(one.description || '').trim())) {
          throw new Error('the writer answered without metadata in it');
        }
        meta = this.shapeMetadata(one, destinationsOf(card));
        engine = { provider: r.provider || r.engine, tier: r.tier || '', model: r.model || '', at: Date.now() };
      } catch (e) {
        sawTheImage = false;
        log(`Could not write metadata from the image (${e.message}) — falling back to the prompt.`, 'err');
        meta = await this.genMetadata(card.prompt, card.qc, destinationsOf(card));
        engine = this._lastMetaEngine || null;
      }
      card.metadata = meta;
      card.metaEngine = engine;
      card.metaFromImage = sawTheImage;
      card.updatedAt = Date.now();
      settleTitles([card]);
      State.persistLibrary();
      return meta;
    },

    /** "Enhance" over a whole selection. */
    async enhanceMetadataForCards(cards, onProgress) {
      let done = 0, failed = 0;
      for (const card of cards) {
        if (onProgress) onProgress(done, cards.length);
        try {
          await this.enhanceCardMetadata(card);
          done++;
        } catch (e) {
          failed++;
          log(`Enhance failed for ${card.fname}: ${e.message}`, 'err');
        }
      }
      if (onProgress) onProgress(done, cards.length);
      return { done, failed };
    },

    /** Write metadata for a whole selection, grouped so siblings still get distinct titles. */
    async writeMetadataForCards(cards, onProgress) {
      const groups = new Map();
      for (const card of cards) {
        const key = card.jobId || `prompt:${card.prompt}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(card);
      }
      let done = 0, failed = 0;
      for (const group of groups.values()) {
        if (onProgress) onProgress(done, cards.length);
        try {
          await this.applyBatchMetadata({ prompt: group[0].prompt }, group);
          done += group.filter((c) => hasMetadata(c)).length;
          failed += group.filter((c) => !hasMetadata(c)).length;
        } catch (e) {
          failed += group.length;
          log(`Metadata failed for ${group.length} card(s): ${e.message}`, 'err');
        }
      }
      if (onProgress) onProgress(done, cards.length);
      return { done, failed };
    },

    hasMetadata,
    metadataOff,
    metadataNeedsQc,

    descriptionFooter,
    hasDescriptionFooter,
    withDescriptionFooter,
    publishField,
    descriptionBrief,
    descriptionHeadroom,
    DESCRIPTION_BRIEFS,

    destinationOf,
    destinationsOf,
    goesTo,
    DESTINATIONS,
    stripPatreonBlock,
    addPatreonBlock,
    wantsPatreonBlock,

    /** Point a card at a set of sites, rewriting its description to match. */
    setDestinations(card, list) {
      const next = normaliseDestinations(list);
      if (!next.length) return false;
      const before = destinationsOf(card);
      if (before.length === next.length && before.every((d, i) => d === next[i]) && Array.isArray(card.destinations)) {
        return false;
      }
      const p = State.settings.patreon || {};
      const wantedBlock = wantsPatreonBlock(before);
      const wantsBlock = wantsPatreonBlock(next);
      card.destinations = next;
      card.destination = next.includes('patreon') ? 'patreon'
        : next.includes('deviantart') ? 'deviantart' : next[0];
      if (wantedBlock !== wantsBlock && card.metadata && typeof card.metadata.description === 'string') {
        card.metadata.description = wantsBlock
          ? addPatreonBlock(card.metadata.description, p)
          : stripPatreonBlock(card.metadata.description, p);
      }
      card.updatedAt = Date.now();
      return true;
    },

    /** Move a card to exactly one destination. */
    setDestination(card, destination) {
      if (!isDestination(destination)) return false;
      return this.setDestinations(card, [destination]);
    },

    /** Add or remove one site, which is what a click on the Review picker means. */
    toggleDestination(card, id) {
      if (!isDestination(id)) return false;
      const before = destinationsOf(card);
      if (id === 'patreon') {
        return before.includes('patreon') ? false : this.setDestinations(card, ['patreon']);
      }
      const next = before.includes('patreon')
        ? [id]
        : before.includes(id) ? before.filter((d) => d !== id) : [...before, id];
      if (!next.length) return false;
      return this.setDestinations(card, next);
    },

    /**
     * Two routes to the same place — an unpublished draft in Sta.sh: 'session' drives the logged-in
     * DeviantArt tab (default, always available) 'api' uses OAuth + stash/submit (needs a published
     * DeviantArt app)
     */
    async uploadCard(card) {
      if (!card.metadata) throw new Error('card has no metadata');
      if (!String(card.metadata.title || '').trim()) throw new Error('card has no title — DeviantArt requires one');
      if (!goesTo(card, 'deviantart')) {
        const where = destinationsOf(card).join(' + ');
        throw new Error(`this card is set to publish on ${where} — tick DeviantArt in Review first`);
      }

      card.status = 'uploading';
      card.error = null;
      card.updatedAt = Date.now();
      State.persistLibrary();
      const startedAt = Date.now();

      const s = State.settings;
      const method = s.da.uploadMethod || 'session';
      const isMature = card.mature !== undefined ? !!card.mature : !!s.metadata.mature;
      const description = withDescriptionFooter(card.metadata.description);

      let res;
      try {
        res = method === 'api'
          ? await window.ala.da.stashDraft({
            filePath: card.path,
            title: card.metadata.title,
            description,
            tags: card.metadata.tags,
            isAiGenerated: s.metadata.isAiGenerated,
            noai: s.metadata.noai,
          })
          : await window.ala.daweb.upload({
            filePath: card.path,
            title: card.metadata.title,
            description,
            tags: card.metadata.tags,
            isMature,
            isAiGenerated: s.metadata.isAiGenerated,
            noai: s.metadata.noai,
            galleryIds: s.da.galleryIds || [],
            allowComments: s.da.allowComments !== false,
            allowFreeDownload: s.da.allowFreeDownload !== false,
            publish: s.da.autoPublish !== false,
          });
      } catch (e) {
        res = { ok: false, error: e.message, kind: 'transient' };
      }

      this.applyUploadResult(card, res, method, Date.now() - startedAt);
      return res;
    },

    /**
     * Where a card lands after an upload attempt — the whole point being that this depends on WHY
     * it failed, not merely that it did.
     */
    applyUploadResult(card, res, method = 'session', elapsedMs = 0) {
      if (res.ok) {
        card.status = 'drafted';
        card.da = { itemid: res.itemid, deviationId: res.deviationId, stashUrl: res.stashUrl, method };
        card.error = null;
        card.uploadError = null;
        card.nextRetryAt = null;
        card.uploadAttempts = 0;
        if (res.published) this.markPublished(card, res.url);
        else if (res.publishError) {
          card.da.publishError = { message: res.publishError, kind: res.publishKind || 'permanent', at: Date.now() };
        }
        try { if (window.Origins) Origins.record(card, { link: 'upload' }); } catch { }
        card.updatedAt = Date.now();
        State.persistLibrary();
        State.bumpStats({ draftsUploaded: 1 });
        const how = res.published ? 'Uploaded and submitted' : 'Draft uploaded';
        log(`${how} (${method}) in ${Math.round(elapsedMs / 1000)}s: ${card.metadata.title}`, 'ok');
        if (res.publishError) log(`Submit failed for "${card.metadata.title}" — it is still a draft: ${res.publishError}`, 'err');
        return card.status;
      }

      const kind = res.kind || 'permanent';
      const message = res.error || 'upload failed';
      card.error = message;
      card.uploadError = { message, kind, stage: res.stage || null, at: Date.now() };

      if (res.itemid) {
        card.status = 'drafted';
        card.da = { itemid: res.itemid, deviationId: res.deviationId, stashUrl: res.stashUrl, method, partial: true };
        card.nextRetryAt = null;
        log(`Upload partial (${method}): image is in Sta.sh but metadata failed — ${message}`, 'err');
      } else if (kind === 'auth') {
        card.status = 'approved';
        card.nextRetryAt = null;
        log(`Upload blocked — not signed in to DeviantArt: ${message}`, 'err');
        State.emit('daAuthLost', { message });
      } else if (kind === 'transient') {
        card.uploadAttempts = (card.uploadAttempts || 0) + 1;
        const max = State.settings.gen.maxUploadRetries ?? 3;
        if (card.uploadAttempts < max) {
          card.status = 'approved';
          card.nextRetryAt = Date.now() + RETRY_BACKOFF_MS[Math.min(card.uploadAttempts - 1, RETRY_BACKOFF_MS.length - 1)];
          log(`Upload failed (attempt ${card.uploadAttempts}/${max}, retrying): ${message}`, 'err');
        } else {
          card.status = 'upload_failed';
          card.nextRetryAt = null;
          log(`Upload failed permanently after ${max} attempts: ${message}`, 'err');
        }
      } else {
        card.status = 'upload_failed';
        card.nextRetryAt = null;
        log(`DeviantArt rejected "${card.metadata.title}": ${message}`, 'err');
      }

      card.updatedAt = Date.now();
      State.persistLibrary();
      return card.status;
    },

    /** Stamp a card as live on DeviantArt. */
    markPublished(card, url) {
      card.da = {
        ...(card.da || {}),
        published: true,
        publishedAt: Date.now(),
        publishError: null,
        missing: false,
        url: url || (card.da && card.da.url) || null,
      };
      try { if (window.Origins) Origins.record(card, { link: 'upload' }); } catch { }
      return card;
    },

    /**
     * Press Submit on a draft that is already in Sta.sh — the manual counterpart of the `publish`
     * flag on upload, and the recovery path when that flag's call failed.
     */
    async publishCard(card) {
      if (!card.da || !card.da.deviationId) throw new Error('no deviation id on this card — delete the draft on DeviantArt and upload it again');
      if (card.da.published) return { ok: true, url: card.da.url, alreadyPublished: true };

      const res = await window.ala.daweb.publish(card.da.deviationId)
        .catch((e) => ({ ok: false, error: e.message, kind: 'transient' }));

      if (res.ok) {
        this.markPublished(card, res.url);
        log(`Submitted to DeviantArt: ${card.metadata?.title || card.id}`, 'ok');
      } else {
        card.da.publishError = { message: res.error || 'submit failed', kind: res.kind || 'permanent', at: Date.now() };
        log(`Submit failed (the draft is still in Sta.sh): ${card.da.publishError.message}`, 'err');
      }
      card.updatedAt = Date.now();
      State.persistLibrary();
      return res;
    },

    /** Finish a draft whose file reached Sta.sh but whose metadata write failed. */
    async retryDraftMetadata(card) {
      if (!card.da || !card.da.itemid) throw new Error('no Sta.sh id on this card');
      const s = State.settings;
      const isMature = card.mature !== undefined ? !!card.mature : !!s.metadata.mature;
      const res = await window.ala.daweb.applyMetadata({
        privateId: card.da.itemid,
        title: card.metadata.title,
        description: withDescriptionFooter(card.metadata.description),
        tags: card.metadata.tags,
        isMature,
        isAiGenerated: s.metadata.isAiGenerated,
        noai: s.metadata.noai,
        galleryIds: s.da.galleryIds || [],
        allowComments: s.da.allowComments !== false,
        allowFreeDownload: s.da.allowFreeDownload !== false,
      }).catch((e) => ({ ok: false, error: e.message, kind: 'transient' }));

      if (res.ok) {
        card.da = { ...card.da, deviationId: res.deviationId || card.da.deviationId, partial: false };
        card.error = null;
        card.uploadError = null;
        log(`Metadata applied to draft: ${card.metadata.title}`, 'ok');
      } else {
        card.error = res.error || 'metadata retry failed';
        card.uploadError = { message: card.error, kind: res.kind || 'permanent', stage: 'metadata', at: Date.now() };
        log(`Metadata retry failed: ${card.error}`, 'err');
      }
      card.updatedAt = Date.now();
      State.persistLibrary();
      return res;
    },

    PUBLIC_SITES,
    pendingSites,
    doneSites,
    siteDone,
    SITE_LABEL,

    /** Is this card still owed a pixiv post? */
    pixivPending(card) {
      if (!card || !goesTo(card, 'pixiv')) return false;
      if (card.pixiv && card.pixiv.illustId) return false;
      return card.status === 'approved' || card.status === 'drafted';
    },

    /** Is this card waiting in the publishing queue? */
    awaitingPublish(card) {
      if (!card) return false;
      if (card.status !== 'approved' && card.status !== 'drafted') return false;
      return pendingSites(card).length > 0;
    },

    /** Send one approved card to **every** site it is routed to. */
    async sendEverywhere(card, { onSite, skip = [] } = {}) {
      const sites = pendingSites(card).filter((s) => !skip.includes(s));
      const results = {};
      for (const site of sites) {
        if (onSite) onSite(site);
        try {
          if (site === 'deviantart') results.deviantart = await this.uploadCard(card);
          else if (site === 'pixiv') results.pixiv = await this.postCardToPixiv(card);
        } catch (e) {
          results[site] = { ok: false, error: e.message, kind: 'permanent' };
          if (site === 'pixiv' && !card.pixivError) {
            card.pixivError = { message: e.message, kind: 'permanent', at: Date.now() };
          }
        }
      }
      this.settleStatus(card);
      const landed = sites.filter((s) => siteDone(card, s));
      return {
        sites,
        results,
        ok: landed.length,
        failed: sites.length - landed.length,
        landed,
      };
    },

    /** A card that owes nothing leaves the queue. */
    settleStatus(card) {
      if (card.status === 'approved' && pendingSites(card).length === 0 && doneSites(card).length) {
        card.status = 'drafted';
        card.updatedAt = Date.now();
        State.persistLibrary();
      }
      return card.status;
    },

    /** Card → the exact multipart pixiv is sent. */
    pixivPayload(card) {
      const s = State.settings;
      const px = s.pixiv || {};
      const p = s.patreon || {};
      const meta = card.metadata || {};

      const title = trimToWord(String(meta.title || '').trim(), px.maxTitle || 32) || 'Untitled';

      let caption = String(meta.description || '').trim();
      if (px.appendPatreon !== false && String(p.link || '').trim() && !/patreon\.com/i.test(caption)) {
        caption = `${p.link}\n\n${p.cta || ''}\n\n${caption}`.trim();
      }
      if (String(px.captionSuffix || '').trim()) caption = `${caption}\n\n${px.captionSuffix.trim()}`.trim();
      caption = withDescriptionFooter(caption);

      const tags = [];
      const seen = new Set();
      for (const t of [...(px.extraTags || []), ...(meta.tags || [])]) {
        const clean = String(t || '').trim().replace(/\s+/g, '');
        if (!clean) continue;
        const key = clean.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        tags.push(clean);
        if (tags.length >= (px.maxTags || 10)) break;
      }

      const isMature = card.mature !== undefined ? !!card.mature : !!s.metadata.mature;
      const fields = {
        title,
        caption,
        restrict: px.restrict ?? 'public',
        xRestrict: isMature ? (px.xRestrictMature ?? 'r18') : (px.xRestrictClean ?? 'general'),
        aiType: px.aiType ?? 'aiGenerated',
        original: px.original ?? 'false',
        allowTagEdit: px.allowTagEdit ?? 'false',
        allowComment: px.allowComment ?? 'true',
        ...(px.extraFields && typeof px.extraFields === 'object' ? px.extraFields : {}),
      };

      return { fields, tags, fname: card.fname, mime: card.mime || 'image/png' };
    },

    /** Post one card to pixiv. */
    async postCardToPixiv(card) {
      if (!card.metadata) throw new Error('card has no metadata');
      if (!String(card.metadata.title || '').trim()) throw new Error('card has no title — pixiv requires one');
      if (!goesTo(card, 'pixiv')) throw new Error('this card is not set to publish on pixiv — tick pixiv in Review first');
      if (card.pixiv && card.pixiv.illustId) return { ok: true, alreadyPosted: true, illustId: card.pixiv.illustId };
      if (!window.Pixiv) throw new Error('the Pixiv driver did not load');

      card.pixivPosting = true;
      card.updatedAt = Date.now();
      State.persistLibrary();
      const startedAt = Date.now();

      let res;
      try {
        const payload = this.pixivPayload(card);
        const base64 = await window.ala.files.readImageBase64(card.fname);
        res = await window.Pixiv.post({ ...payload, base64 });
      } catch (e) {
        res = { ok: false, error: e.message, kind: 'transient' };
      }

      return this.applyPixivResult(card, res, Date.now() - startedAt);
    },

    /** Where a card lands after a pixiv attempt. */
    applyPixivResult(card, res, elapsedMs = 0) {
      card.pixivPosting = false;
      card.updatedAt = Date.now();

      if (res && res.ok) {
        card.pixiv = { illustId: String(res.illustId), url: res.url || null, at: Date.now() };
        card.pixivError = null;
        card.pixivAttempts = 0;
        card.nextPixivRetryAt = null;
        this.settleStatus(card);
        State.persistLibrary();
        State.bumpStats({ pixivPosted: 1 });
        log(`Posted to pixiv in ${Math.round(elapsedMs / 1000)}s: ${card.metadata.title}`, 'ok');
        return card;
      }

      const kind = (res && res.kind) || 'permanent';
      const message = (res && res.error) || 'pixiv post failed';
      card.pixivError = { message, kind, at: Date.now() };

      if (kind === 'pending') {
        card.nextPixivRetryAt = null;
        card.pixivAttempts = 0;
        log(`Pixiv is still processing "${card.metadata.title}" — do not re-post it: ${message}`, 'err');
      } else if (kind === 'manual') {
        card.nextPixivRetryAt = null;
        card.pixivAttempts = 0;
        log(`Pixiv wants a human check for "${card.metadata.title}" — press Prepare on pixiv to stage it.`, 'err');
      } else if (kind === 'auth') {
        card.nextPixivRetryAt = null;
        log(`Pixiv post blocked — not signed in: ${message}`, 'err');
        State.emit('pixivAuthLost', { message });
      } else if (kind === 'transient') {
        card.pixivAttempts = (card.pixivAttempts || 0) + 1;
        const max = State.settings.gen.maxUploadRetries ?? 3;
        if (card.pixivAttempts < max) {
          card.nextPixivRetryAt = Date.now()
            + RETRY_BACKOFF_MS[Math.min(card.pixivAttempts - 1, RETRY_BACKOFF_MS.length - 1)];
          log(`Pixiv post failed (attempt ${card.pixivAttempts}/${max}, retrying): ${message}`, 'err');
        } else {
          card.nextPixivRetryAt = null;
          log(`Pixiv post failed permanently after ${max} attempts: ${message}`, 'err');
        }
      } else {
        card.nextPixivRetryAt = null;
        log(`Pixiv rejected "${card.metadata.title}": ${message}`, 'err');
      }

      State.persistLibrary();
      return card;
    },

    /** Stage a card on pixiv's own upload page for the person to post. */
    async prepareCardOnPixiv(card) {
      if (!card.metadata) throw new Error('card has no metadata');
      if (!String(card.metadata.title || '').trim()) throw new Error('card has no title — pixiv requires one');
      if (!goesTo(card, 'pixiv')) throw new Error('this card is not set to publish on pixiv — tick pixiv in Review first');
      if (card.pixiv && card.pixiv.illustId) return { ok: true, alreadyPosted: true, illustId: card.pixiv.illustId };
      if (!window.Pixiv) throw new Error('the Pixiv driver did not load');

      const held = State.library.find((c) => c !== card && c.pixivPrep && !(c.pixiv && c.pixiv.illustId));
      if (held) this.clearPixivPrep(held, 'replaced by another card');

      let res;
      try {
        const payload = this.pixivPayload(card);
        const base64 = await window.ala.files.readImageBase64(card.fname);
        res = await window.Pixiv.prepare({ ...payload, base64 });
      } catch (e) {
        res = { ok: false, error: e.message, kind: 'transient' };
      }

      card.updatedAt = Date.now();
      if (!res || !res.ok) {
        const message = (res && res.error) || 'could not open the pixiv upload form';
        card.pixivError = { message, kind: (res && res.kind) || 'transient', at: Date.now() };
        State.persistLibrary();
        log(`Could not stage "${card.metadata.title}" on pixiv: ${message}`, 'err');
        return { ok: false, error: message };
      }

      card.pixivPrep = {
        at: Date.now(),
        userId: res.userId || null,
        sinceId: res.sinceId || null,
        filled: res.filled || [],
        missed: res.missed || [],
        critical: res.critical || [],
      };
      card.pixivError = null;
      State.persistLibrary();
      log(`Staged "${card.metadata.title}" on the pixiv upload form — press Post on the Pixiv tab.`
        + (res.missed?.length ? ` Not filled: ${res.missed.join(', ')}.` : ''), res.critical?.length ? 'err' : 'ok');
      return { ok: true, ...res };
    },

    /** Did the staged card go up? */
    async harvestPixiv(card) {
      const prep = card && card.pixivPrep;
      if (!prep || !window.Pixiv) return { ok: false, found: false };
      if (card.pixiv && card.pixiv.illustId) return { ok: true, found: true, illustId: card.pixiv.illustId };
      const res = await window.Pixiv.harvest(prep.userId, prep.sinceId);
      if (!res.ok) return { ok: false, found: false, error: res.error };
      if (!res.illustId) return { ok: true, found: false };
      card.pixivPrep = null;
      this.applyPixivResult(card, {
        ok: true, illustId: res.illustId, url: `https://www.pixiv.net/artworks/${res.illustId}`,
      }, Date.now() - prep.at);
      return { ok: true, found: true, illustId: res.illustId };
    },

    /** Forget that a card is staged — it was replaced, abandoned, or the app restarted. */
    clearPixivPrep(card, why = '') {
      if (!card || !card.pixivPrep) return;
      card.pixivPrep = null;
      if (!(card.pixiv && card.pixiv.illustId)) {
        card.pixivError = {
          message: (window.Pixiv && window.Pixiv.HUMAN_CHECK_MSG) || 'pixiv needs a human check for this post',
          kind: 'manual', at: Date.now(),
        };
      }
      card.updatedAt = Date.now();
      State.persistLibrary();
      if (why) log(`No longer waiting on a pixiv post for "${card.metadata?.title || card.fname}" — ${why}.`);
    },

    /** Is this card's pixiv post one only a person can finish? */
    pixivNeedsHuman(card) {
      if (!card || (card.pixiv && card.pixiv.illustId)) return false;
      if (card.pixivPrep) return true;
      const err = card.pixivError;
      if (!err) return false;
      if (err.kind === 'manual') return true;
      const re = window.Pixiv && window.Pixiv.HUMAN_CHECK_RE;
      return !!(re && re.test(String(err.message || '')));
    },

    /** The card currently sitting on pixiv's upload page, if any. */
    pixivStaged() {
      return State.library.find((c) => c.pixivPrep && !(c.pixiv && c.pixiv.illustId)) || null;
    },
  };

  /** Cut to `max` characters without splitting the last word. */
  function trimToWord(text, max) {
    const t = String(text || '').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const space = cut.lastIndexOf(' ');
    return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
  }

  const AutoMode = {
    running: false,
    _stop: false,
    status: 'Idle',
    stopReason: null,
    _imageTimestamps: [],
    _consecutiveFailures: 0,
    _llmDownChecks: 0,
    _contention: null,

    get settings() { return State.settings.auto || {}; },

    async patch(patchObj) {
      State.settings = await window.ala.settings.patch({ auto: patchObj });
    },

    elapsedMs() {
      const s = this.settings;
      return s.startedAt ? Date.now() - s.startedAt : 0;
    },

    reviewBacklog() {
      return State.library.filter((c) => c.status === 'review').length;
    },

    /** Why we should stop, or null to keep going. */
    stopCondition() {
      const s = this.settings;
      const hours = Number(s.stopAfterHours) || 0;
      if (hours > 0 && this.elapsedMs() >= hours * 3600_000) {
        return `ran the full ${hours}h`;
      }
      const cap = Number(s.maxReviewBacklog) || 0;
      if (cap > 0 && this.reviewBacklog() >= cap) {
        return `${this.reviewBacklog()} cards waiting in Review (cap ${cap})`;
      }
      if (this._consecutiveFailures >= 5) {
        return 'five rounds in a row could not queue anything — the prompt writer is probably down';
      }
      if (this._llmDownChecks >= 3) {
        return 'the LLM has been unreachable for three checks';
      }
      const down = Pipeline.engineDown;
      if (down && Date.now() - down.since >= 30 * 60000) {
        return `the image engine has not answered for ${Math.round((Date.now() - down.since) / 60000)} minutes (${down.error})`;
      }
      if (this._roundsAllFailed >= 3) {
        return `every job in the last ${this._roundsAllFailed} rounds failed${this._lastJobError ? ` — last error: ${this._lastJobError}` : ''}`;
      }
      return null;
    },

    /** Settle the previous round once its jobs are out of the queue: did ANY of them work? */
    noteRoundOutcome() {
      const ids = this._lastRoundJobIds;
      if (!ids || !ids.length) return;
      const jobs = State.queue.filter((j) => ids.includes(j.id));
      if (jobs.some((j) => !['done', 'failed'].includes(j.status))) return;
      this._lastRoundJobIds = null;
      if (jobs.length && jobs.every((j) => j.status === 'failed')) {
        this._roundsAllFailed += 1;
        this._lastJobError = String(jobs[jobs.length - 1].error || '').slice(0, 200);
        log(`Every job from the last round failed (${this._lastJobError || 'no error recorded'}) — `
          + `${this._roundsAllFailed} such round(s) in a row; auto mode stops at 3.`, 'err');
      } else {
        this._roundsAllFailed = 0;
        this._lastJobError = '';
      }
    },

    /** Prompts already in play, newest first. */
    recentPrompts(n = 30) {
      return Pipeline.recentPrompts(n);
    },

    nextTheme() {
      const themes = (this.settings.themes || []).filter((t) => t && String(t.theme || '').trim());
      if (!themes.length) return null;
      const i = (Number(this.settings.themeIndex) || 0) % themes.length;
      return { ...themes[i], _nextIndex: (i + 1) % themes.length };
    },

    /** Which theme to farm this round. */
    chooseTheme() {
      const rr = this.nextTheme();
      if (!rr) return null;
      const themes = (this.settings.themes || []).filter((t) => t && String(t.theme || '').trim());
      const learningOn = this.settings.useLearning !== false
        && State.settings.learn && State.settings.learn.enabled !== false
        && window.Insights;
      if (!learningOn || themes.length < 2) return rr;

      const EXPLORE = 1 / 3;
      if (Math.random() < EXPLORE) return { ...rr, _pick: 'rotation' };

      const weights = window.Insights.themeWeights(themes);
      const scored = themes.map((t, i) => ({
        t, i, w: weights.get(String(t.theme).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()) || 1,
      }));
      const total = scored.reduce((a, x) => a + x.w, 0);
      if (!(total > 0)) return rr;
      let r = Math.random() * total;
      for (const x of scored) {
        r -= x.w;
        if (r <= 0) {
          return {
            ...x.t,
            _nextIndex: rr._nextIndex,
            _pick: x.w > 1.05 ? `weighted ${x.w.toFixed(2)}×` : 'weighted',
          };
        }
      }
      return rr;
    },

    /** Throttle: how long to wait before the next round, honouring maxImagesPerHour. */
    throttleDelayMs() {
      const cap = Number(this.settings.maxImagesPerHour) || 0;
      if (cap <= 0) return 0;
      const cutoff = Date.now() - 3600_000;
      this._imageTimestamps = this._imageTimestamps.filter((t) => t > cutoff);
      if (this._imageTimestamps.length < cap) return 0;
      return Math.max(0, this._imageTimestamps[0] + 3600_000 - Date.now()) + 1000;
    },

    noteImages(n) {
      const now = Date.now();
      for (let i = 0; i < n; i++) this._imageTimestamps.push(now);
    },

    setStatus(text) {
      this.status = text;
      State.emit('auto', this.snapshot());
    },

    snapshot() {
      const s = this.settings;
      const theme = this.nextTheme();
      return {
        running: this.running,
        status: this.status,
        stopReason: this.stopReason,
        elapsedMs: this.elapsedMs(),
        rounds: Number(s.roundsDone) || 0,
        backlog: this.reviewBacklog(),
        maxBacklog: Number(s.maxReviewBacklog) || 0,
        stopAfterHours: Number(s.stopAfterHours) || 0,
        theme: theme ? theme.theme : null,
      };
    },

    async start() {
      if (this.running) return;
      const themes = (this.settings.themes || []).filter((t) => t && String(t.theme || '').trim());
      if (!themes.length) {
        log('Auto mode needs at least one theme — add one on the Dashboard.', 'err');
        return;
      }
      this.running = true;
      this._stop = false;
      this.stopReason = null;
      this._consecutiveFailures = 0;
      this._llmDownChecks = 0;
      this._roundsAllFailed = 0;
      this._lastJobError = '';
      this._lastRoundJobIds = null;
      this._imageTimestamps = [];
      await this.patch({ enabled: true, startedAt: Date.now(), roundsDone: 0 });
      await window.ala.power.keepAwake(true).catch(() => {});
      log(`Auto mode started — ${themes.length} theme(s), ${this.settings.promptsPerRound} prompt(s) per round, stops after ${this.settings.stopAfterHours}h or ${this.settings.maxReviewBacklog} cards.`, 'ok');
      this.setStatus('Starting…');

      this._startedWorker = !Pipeline.running;
      if (this._startedWorker) Pipeline.start();

      try {
        await this.loop();
      } finally {
        this.running = false;
        await this.patch({ enabled: false });
        if (this._startedWorker) Pipeline.stop();
        this._startedWorker = false;
        await window.ala.power.keepAwake(false).catch(() => {});
        this.setStatus(this.stopReason ? `Stopped — ${this.stopReason}` : 'Stopped');
        log(`Auto mode stopped${this.stopReason ? ` — ${this.stopReason}` : ''}. `
          + `${this.settings.roundsDone} round(s), ${this.reviewBacklog()} card(s) waiting in Review.`, 'ok');
        osNotify('Acre Art Studio — auto mode stopped',
          `${this.stopReason || 'stopped'} · ${this.settings.roundsDone} round(s), `
          + `${this.reviewBacklog()} card(s) waiting in Review.`);
      }
    },

    stop(reason) {
      if (!this.running) return;
      this._stop = true;
      this.stopReason = reason || 'stopped by hand';
    },

    /** Would ideating right now fight the inspector for the same GPU? */
    async gpuContention() {
      const now = Date.now();
      if (this._contention && now - this._contention.at < 60_000) return this._contention.v;
      let v = true;
      try {
        const g = State.settings.gen || {};
        const laneRoles = [];
        if (!g.skipQc) laneRoles.push('vision');
        if (!g.skipMetadata) laneRoles.push('metadata');
        if (!laneRoles.length) {
          v = false;
        } else {
          const isLocal = async (r) => {
            const x = await window.ala.llm.route(r);
            return !!(x && !x.cloudFirst);
          };
          const [writer, lane] = await Promise.all([
            Promise.all(['ideation', 'metadata'].map(isLocal)),
            Promise.all(laneRoles.map(isLocal)),
          ]);
          v = writer.some(Boolean) && lane.some(Boolean);
        }
      } catch { }
      this._contention = { at: now, v };
      return v;
    },

    async loop() {
      while (!this._stop) {
        this.noteRoundOutcome();
        const reason = this.stopCondition();
        if (reason) { this.stopReason = reason; break; }

        const pending = State.queue.filter((j) => ['queued', 'generating'].includes(j.status)).length;
        if (pending > 0 || State.worker.currentJobId) {
          if (pending > 0 && !Pipeline.running) {
            log('The worker was not running while jobs were queued — restarting it.', 'err');
            Pipeline.start();
          }
          const down = Pipeline.engineDown;
          this.setStatus(down
            ? `Waiting — the image engine is not answering (${Math.floor((Date.now() - down.since) / 60000)} min; stops at 30)`
            : pending
              ? `Waiting — ${pending} job(s) still in the queue`
              : 'Waiting — the worker is finishing a job');
          await U.sleep(10_000);
          continue;
        }

        const laneDepth = Pipeline.laneImages();
        if (laneDepth > 0 && await this.gpuContention()) {
          this.setStatus(`Waiting — ${laneDepth} image(s) in QC, and the writer shares its GPU`);
          await U.sleep(10_000);
          continue;
        }

        const wait = this.throttleDelayMs();
        if (wait > 0) {
          this.setStatus(`Throttled — ${Math.ceil(wait / 60_000)}m until the hourly image cap resets`);
          await U.sleep(Math.min(wait, 60_000));
          continue;
        }

        const before = State.library.length;
        const ok = await this.runRound();
        this.noteImages(Math.max(0, State.library.length - before));
        this._consecutiveFailures = ok ? 0 : this._consecutiveFailures + 1;

        if (!this._stop) await U.sleep(3000);
      }
    },

    /** Re-read the numbers and rebuild the playbook mid-run. */
    async maybeRelearn(round) {
      if (this.settings.useLearning === false) return;
      if (!window.Insights || !State.settings.learn || State.settings.learn.enabled === false) return;
      const every = Math.max(0, Number(this.settings.relearnEveryRounds) || 0);
      if (!every) return;
      if (round !== 1 && round % every !== 0) return;

      this.setStatus(`Round ${round} — re-reading what performed`);
      try {
        const p = await window.Insights.refresh({ log });
        if (p && p.summary) log(`Learning pass before round ${round}: ${p.summary}`, 'ok');
      } catch (e) {
        log(`Learning pass skipped (${e.message}).`, 'err');
      }
    },

    async runRound() {
      const theme = this.chooseTheme();
      if (!theme) { this.stopReason = 'no themes configured'; this._stop = true; return false; }

      const s = this.settings;
      const count = Math.max(1, Math.min(12, Number(s.promptsPerRound) || 4));
      const round = (Number(s.roundsDone) || 0) + 1;

      await this.maybeRelearn(round);

      if (round === 1 || round % 12 === 0) {
        const note = Pipeline.qcCalibrationNote(Pipeline.qcCalibration());
        if (note) log(note, 'err');
      }

      const V = window.Variety;
      const mode = V ? V.rollMode() : 'exploit';
      const axes = V && mode !== 'exploit' ? V.freshAxes() : (V ? V.freshAxes(1) : null);
      if (V) V.noteRound(mode);

      const ratio = Math.max(0, Math.min(1, Number(s.exploitRatio ?? 0.4)));
      const wantEvolved = (s.useLearning === false || mode !== 'exploit')
        ? 0
        : Math.min(count - 1, Math.round(count * ratio));
      const avoid = this.recentPrompts(mode === 'exploit' ? 30 : 60);
      const jobs = [];

      const prof = window.PromptStyle ? PromptStyle.profile() : null;
      let guarded = 0;
      const guard = (text) => {
        if (!window.PromptStyle) return text;
        const g = PromptStyle.enforceTail(text, prof);
        if (g !== text) guarded += 1;
        return g;
      };

      if (wantEvolved > 0 && window.PromptLab) {
        this.setStatus(`Round ${round} — growing ${wantEvolved} prompt(s) from a top performer`);
        try {
          const grown = await PromptLab.fromWinners({ count: wantEvolved, theme: theme.theme, avoid, axes, log });
          for (const p of grown.prompts) {
            jobs.push(Pipeline.makeJob(guard(p), theme.theme, 'evolved', grown.seed && grown.seed.from));
            avoid.unshift(p);
          }
        } catch (e) {
          log(`Could not grow prompts from a winner (${e.message}) — ideating the whole round instead.`, 'err');
        }
      }

      const fresh = count - jobs.length;
      this.setStatus(`Round ${round} — ideating ${fresh} prompt(s) for "${theme.theme}" (${mode})`);
      let prompts;
      try {
        const guidance = window.Insights
          ? window.Insights.guidance({ theme: theme.theme, mode, axes })
          : '';
        prompts = await Pipeline.ideate(theme.theme, theme.example || '', fresh, avoid, guidance, mode);
        this._llmDownChecks = 0;
      } catch (e) {
        if (/unreachable|failed|timed out|ECONN|fetch/i.test(e.message)) this._llmDownChecks += 1;
        log(`Auto round ${round} could not ideate: ${e.message}`, 'err');
        this.setStatus(`Round ${round} failed to ideate — retrying shortly`);
        if (jobs.length) {
          State.queue.push(...jobs);
          State.persistQueue();
          this._lastRoundJobIds = jobs.map((j) => j.id);
          await this.patch({ themeIndex: theme._nextIndex, roundsDone: round });
          log(`Kept ${jobs.length} evolved prompt(s) from round ${round}.`, 'ok');
          if (!Pipeline.running) Pipeline.start();
          return true;
        }
        await U.sleep(30_000);
        return false;
      }

      let queued = prompts;
      if (window.Teach) {
        const { kept, dropped } = Teach.screen(prompts.map((p) => p.prompt));
        if (dropped.length) {
          const terms = [...new Set(dropped.flatMap((x) => x.banned))].join(', ');
          log(`Dropped ${dropped.length} prompt(s) that used banned wording (${terms}).`, 'err');
        }
        const keptSet = new Set(kept);
        queued = prompts.filter((p) => keptSet.has(p.prompt));
      }
      const source = mode === 'exploit' ? 'ideation' : mode;
      for (const p of queued) jobs.push(Pipeline.makeJob(guard(p.prompt), theme.theme, source, null, p.controls));

      if (!jobs.length) {
        log(`Auto round ${round} produced nothing usable — retrying shortly.`, 'err');
        await this.patch({ themeIndex: theme._nextIndex, roundsDone: round });
        await U.sleep(15_000);
        return false;
      }

      if (guarded) log(`Appended the missing house tail tags to ${guarded} prompt(s) — enforced, not requested.`);
      State.queue.push(...jobs);
      State.persistQueue();
      this._lastRoundJobIds = jobs.map((j) => j.id);
      if (window.Variety) Variety.invalidate();
      await this.patch({ themeIndex: theme._nextIndex, roundsDone: round });
      const evolved = jobs.filter((j) => j.promptSource === 'evolved').length;
      log(`Auto round ${round}: queued ${jobs.length} prompt(s) for "${theme.theme}"`
        + `${evolved ? ` (${evolved} grown from a top performer)` : ''}`
        + `${V ? ` · ${V.describeMode(mode)}` : ''}`
        + `${axes && axes.length ? ` · varying ${axes.map((a) => a.axis).join('/')}` : ''}`
        + `${theme._pick ? ` · theme picked by ${theme._pick}` : ''}.`, 'ok');
      this.setStatus(`Round ${round} — generating "${theme.theme}"`);

      if (!Pipeline.running) Pipeline.start();
      return true;
    },
  };

  window.Pipeline = Pipeline;
  window.AutoMode = AutoMode;
  window.PromptT = T;
})();
