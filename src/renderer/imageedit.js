/* imageedit.js — the engine behind the Image Edit tab and the 🩹 Fix button.
 *
 * Qwen-Image 2.1 is one model for generating AND editing: the picture goes in as <image1>
 * through the same TextEncodeQwenImage21 reference socket the research path already fills,
 * and the model re-renders the whole frame from it plus an instruction. That re-render is
 * its strength, so nothing here crops, masks or pastes pixels back — a brushed area only
 * becomes WORDS in the instruction ("in the top-left area of the picture: …").
 *
 * Three ways in, one job shape (the same as Overseer.editImage, and the same edit template):
 *   - Image Edit tab: brushed-area or whole-picture instruction  → promptSource 'edit'
 *   - 🩹 Fix on a card: a preset or the card's own QC defects     → promptSource 'edit', fixOf
 *   - auto-fix after a QC fail (gen.autoFix, off by default)      → same, autoFix: true
 *     (up to gen.autoFixTries attempts, each from the original picture)
 *
 * Every result is a NEW card (the original is never touched). A card source keeps its own
 * prompt on the new card (`basePrompt`), so titles/metadata/character names are written from
 * what the picture shows rather than from "Edit <image1>…" — and the QC critique that a fix
 * instruction carries can never reach the title writer through card.prompt.
 */
(function () {
  const SAMPLER_RE = /^(KSampler|KSamplerAdvanced|S3Sampler|SamplerCustomAdvanced)$/;
  const isWire = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string';

  const FIX_PRESETS = {
    hands: {
      label: 'Fingers / hands',
      text: 'Fix the hands: every visible hand has five correctly shaped, clearly separated fingers with natural joints and nails, and no fused, extra, missing or bent-backwards fingers',
    },
    detail: {
      label: 'Mushed / blurry detail',
      text: 'Fix the mushed, smeared and blurry areas: render every surface with clean, sharp, coherent detail — clear eyes, crisp fabric folds, separate hair strands and clean edges',
    },
    anatomy: {
      label: 'Proportions / anatomy',
      text: 'Fix the anatomy and proportions: natural limb lengths, arms and legs correctly attached, a believable torso and head size, no merged, twisted or duplicated body parts',
    },
    face: {
      label: 'Face / eyes',
      text: 'Fix the face: clearly drawn, symmetrical eyes with matching irises and pupils, a well-formed nose and mouth, no smearing or distortion — same person, same expression',
    },
  };

  const clean = (s) => String(s || '').trim().replace(/\s+/g, ' ');
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  /**
   * The edit instruction as the encoder sees it. Written in code, never by a model, so the
   * artist's words reach Qwen as-is. ONE template for the whole app: Overseer.editPrompt is
   * the source (its tests pin it), and the tab uses exactly the same words.
   */
  function editPrompt(instruction) {
    return window.Overseer.editPrompt(instruction);
  }

  /**
   * A repair. Unlike editPrompt it does not pin "same face" — a face fix has to be allowed
   * to redraw the face — so it pins identity, pose and scene instead.
   */
  function fixPrompt(fix) {
    const f = clean(fix).replace(/(?:[.\s]*\bchange nothing else)+[.\s]*$/i, '').replace(/[.\s]+$/, '');
    return `Repair <image1>. Keep everything else in <image1> exactly the same: the same character and identity, hair, body shape, pose, clothing, camera angle, framing and background. ${cap(f)}. Change nothing else. Keep the same art style, lighting and colours as <image1>.`;
  }

  /** Where a brushed box sits, in words: thirds of the frame, plus "most of the picture". */
  function locationPhrase(box, w, h) {
    if (!box || !(w > 0) || !(h > 0)) return 'picture';
    const bw = Math.max(0, box.w), bh = Math.max(0, box.h);
    if ((bw * bh) / (w * h) >= 0.6) return 'most of the picture';
    const cx = (box.x + bw / 2) / w;
    const cy = (box.y + bh / 2) / h;
    const row = cy < 1 / 3 ? 'top' : cy > 2 / 3 ? 'bottom' : 'middle';
    const col = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : 'centre';
    if (row === 'middle' && col === 'centre') return 'centre of the picture';
    if (row === 'middle') return `${col} side of the picture`;
    if (col === 'centre') return `${row} centre of the picture`;
    return `${row}-${col} area of the picture`;
  }

  /** A brushed-area instruction: the location becomes part of the change. */
  function regionInstruction(text, box, w, h) {
    const t = clean(text).replace(/[.\s]+$/, '');
    if (!t) return '';
    const where = locationPhrase(box, w, h);
    if (where === 'picture') return t;
    return `in the ${where}: ${t.charAt(0).toLowerCase()}${t.slice(1)}`;
  }

  /**
   * The repair sentence for a card. `preset` is a FIX_PRESETS key, 'auto' (built from the
   * card's own QC findings) or free text. Returns '' when 'auto' has nothing to work from.
   */
  function fixInstruction(preset, card) {
    if (preset && FIX_PRESETS[preset]) return FIX_PRESETS[preset].text;
    if (preset === 'auto') {
      const qc = (card && card.qc) || {};
      const detail = Array.isArray(qc.detail) ? qc.detail : [];
      let flaws = detail.map((d) => {
        if (!d || typeof d !== 'object') return clean(d);
        const what = clean(d.what);
        const where = clean(d.where);
        return what ? (where ? `${what} (${where})` : what) : '';
      }).filter(Boolean);
      if (!flaws.length && Array.isArray(qc.defects)) flaws = qc.defects.map(clean).filter(Boolean);
      const fingers = (Array.isArray(qc.fingers) ? qc.fingers : []).filter((f) => f && f.status === 'defect');
      if (fingers.length && !flaws.some((f) => /finger|hand/i.test(f))) {
        flaws.push(`malformed fingers (${fingers.map((f) => clean(f.side)).filter(Boolean).join(', ') || 'hands'})`);
      }
      const tip = clean(qc.fix).replace(/[.\s]+$/, '');
      if (!flaws.length && !tip) return '';
      const parts = [];
      if (flaws.length) parts.push(`Fix these flaws: ${flaws.slice(0, 5).join('; ')}`);
      if (tip) parts.push(parts.length ? `also ${tip.charAt(0).toLowerCase()}${tip.slice(1)}` : tip);
      return parts.join('; ');
    }
    return clean(preset);
  }

  /**
   * ComfyUI's ResolutionSelector (comfy_extras/nodes_resolution.py), computed the same way:
   * aspect ratio + megapixels → width/height rounded to `multiple`. The app's Qwen workflow
   * feeds its EmptyLatentImage from one of these, so a plain number is not always there.
   */
  const RESOLUTION_RATIOS = {
    '1:1 (Square)': [1, 1], '2:3 (Portrait Photo)': [2, 3], '3:2 (Photo)': [3, 2],
    '3:4 (Portrait Standard)': [3, 4], '4:3 (Standard)': [4, 3], '9:16 (Portrait Widescreen)': [9, 16],
    '16:9 (Widescreen)': [16, 9], '21:9 (Ultrawide)': [21, 9],
  };
  // Python's round() is round-half-to-even; match it so 1.5 → 2 and 2.5 → 2 like the server.
  const pyRound = (x) => { const f = Math.floor(x); const d = x - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1); };
  function resolutionSelector(inputs) {
    const r = RESOLUTION_RATIOS[String(inputs.aspect_ratio || '')];
    const mp = Number(inputs.megapixels), mult = Number(inputs.multiple) || 8;
    if (!r || !(mp > 0)) return null;
    const scale = Math.sqrt((mp * 1024 * 1024) / (r[0] * r[1]));
    return [pyRound((r[0] * scale) / mult) * mult, pyRound((r[1] * scale) / mult) * mult];
  }

  /** One width/height input: a number, or the output of a node we can evaluate. */
  function dimValue(nodes, v, which) {
    if (Number.isFinite(Number(v)) && !isWire(v)) return Number(v);
    if (!isWire(v)) return null;
    const src = nodes[v[0]];
    if (!src) return null;
    if (/^ResolutionSelector$/.test(src.classType || '')) {
      const wh = resolutionSelector(src.inputs || {});
      return wh ? wh[Number(v[1]) === 1 ? 1 : 0] : null;
    }
    // A primitive/int node passing a number through.
    const own = src.inputs && (src.inputs.value ?? src.inputs[which]);
    return Number.isFinite(Number(own)) && !isWire(own) ? Number(own) : null;
  }

  /**
   * The size the image workflow renders at: the empty-latent node that feeds the sampler's
   * `latent_image`, traced through the graph (never a hardcoded node id). Null when the graph
   * has no such node or its size cannot be worked out — then no warning is shown.
   */
  function latentSizeOf(wf) {
    const nodes = (wf && wf.nodes) || {};
    const sizeOf = (n) => {
      if (!n || !/latent/i.test(n.classType || '') || !n.inputs || !('width' in n.inputs) || !('height' in n.inputs)) return null;
      const width = dimValue(nodes, n.inputs.width, 'width');
      const height = dimValue(nodes, n.inputs.height, 'height');
      return width > 0 && height > 0 ? { width, height } : null;
    };
    const sampler = Object.entries(nodes).find(([, n]) => SAMPLER_RE.test(n.classType || '') && n.inputs);
    if (sampler) {
      const start = sampler[1].inputs.latent_image;
      const queue = isWire(start) ? [start[0]] : [];
      const seen = new Set();
      while (queue.length) {
        const id = queue.shift();
        if (seen.has(id)) continue;
        seen.add(id);
        const n = nodes[id];
        if (!n) continue;
        const sz = sizeOf(n);
        if (sz) return sz;
        if (/latent/i.test(n.classType || '') && n.inputs && 'width' in n.inputs) return null;
        for (const v of Object.values(n.inputs || {})) if (isWire(v)) queue.push(v[0]);
      }
      return null;
    }
    for (const n of Object.values(nodes)) {
      if (/^Empty.*Latent/i.test(n.classType || '')) { const sz = sizeOf(n); if (sz) return sz; }
    }
    return null;
  }

  /** The live workflow's render size, or null if it cannot be read (no warning then). */
  async function nativeSize() {
    try {
      const d = window.Pipeline && Pipeline.genDriver ? Pipeline.genDriver() : null;
      if (!d || typeof d.loadWorkflow !== 'function') return null;
      const wf = await d.loadWorkflow(d.cfg.imageWorkflow);
      return latentSizeOf(wf);
    } catch {
      return null;
    }
  }

  /**
   * Only when the sizes differ: null = same size (or unknown), else the warning text. The
   * caller asks the artist; a matching picture goes straight through with no prompt.
   */
  function sizeWarning(src, native) {
    if (!src || !native || !(src.w > 0) || !(src.h > 0)) return null;
    if (src.w === native.width && src.h === native.height) return null;
    return `This picture is ${src.w}×${src.h}, but the edit workflow's native size is ${native.width}×${native.height}. `
      + `The result keeps this picture's size (${src.w}×${src.h}), but editing a picture of a different size can lower the edit quality.`;
  }

  function comfyOn() {
    return ((window.State && State.settings && State.settings.gen) || {}).engine === 'comfy';
  }

  /** A library card as an edit source: copied into library/overseer like a chat attachment. */
  async function cardRow(card) {
    if (!card || !card.fname) throw new Error('that card has no image file');
    const base64 = await window.ala.files.readImageBase64(card.fname);
    const saved = await window.ala.files.saveAttachment(base64, card.mime || 'image/png', `card-${card.id}`);
    return { id: `card-${card.id}`, fname: saved.fname, mime: saved.mime || card.mime || 'image/png', name: `card ${card.id}` };
  }

  /**
   * Queue one edit/fix job at the FRONT of the queue. `source` is
   *   { card }                                   — a library card, or
   *   { row: { id, fname, mime, name } }          — an uploaded file already in library/overseer.
   * Returns { job, batchId }.
   */
  async function queueEdit({ source, prompt, label = '', count = 1, fixOf = null, autoFix = false, root = null, start = true, basePrompt = null, redoOf = null, instruction = '' } = {}) {
    if (!comfyOn()) throw new Error('image edits need the ComfyUI engine (Settings → Generation); Perchance cannot take a picture as input');
    if (!prompt) throw new Error('nothing to edit — the instruction is empty');
    const card = source && source.card;
    const row = card ? await cardRow(card) : source && source.row;
    if (!row || !row.fname) throw new Error('no picture to edit');
    const theme = (card && card.theme) || 'Image edit';
    const job = Pipeline.makeJob(prompt, theme, 'edit');
    job.count = Math.max(1, Math.min(4, Number(count) || 1));
    job.editOf = row.id;
    job.editRoot = root || (card && card.editRoot) || row.id;
    job.editLabel = clean(label).slice(0, 200);
    job.chatReferences = [{ ...row }];
    job.referenceIds = [row.id];
    job.referenceCount = 1;
    if (card && card.prompt) job.basePrompt = card.prompt;
    if (basePrompt) job.basePrompt = basePrompt;
    if (redoOf) job.redoOf = redoOf;
    if (instruction) job.editInstruction = clean(instruction).slice(0, 1500);
    if (fixOf) job.fixOf = fixOf;
    if (autoFix) job.autoFix = true;
    const batchId = `b${U.uid()}`;
    job.batchId = batchId;
    State.queue = [job, ...(State.queue || [])];
    State.persistQueue();
    // Paused worker → run just this edit, not the whole paused queue. Running worker → it is
    // at the front and goes next (and joins an edits-only run if that is what is going).
    if (start) Pipeline.start({ only: [job.id] });
    State.addLog(`${fixOf ? 'Fix' : 'Edit'} queued at the front: ${job.editLabel || prompt.slice(0, 80)}`, 'ok');
    return { job, batchId };
  }

  /**
   * Auto (from QC) on a card with no QC findings: run QC on it now (the same inspection the
   * worker does), store the verdict on the card, and return the findings. The card's status is
   * left alone — a Review card stays in Review with its new score. If QC finds nothing to fix,
   * a general anatomy + detail repair is used. Throws only when QC itself cannot run.
   */
  async function qcForFix(card) {
    if (!card || !card.fname) throw new Error('that card has no image file');
    State.addLog(`Fix: card ${card.id} has no QC findings — running QC on it first.`);
    let out;
    try {
      const base64 = await window.ala.files.readImageBase64(card.fname);
      out = await Pipeline.inspect(base64, card.mime || 'image/png', card.prompt || '');
    } catch (e) {
      throw new Error(`QC could not run on it (${String(e && e.message || e).slice(0, 160)}) — pick a preset or describe the fix`);
    }
    Pipeline.applyQcResult(card, out.qc, out.meta);
    card.qcSkipped = false;
    card.updatedAt = Date.now();
    State.persistLibrary();
    const found = fixInstruction('auto', card);
    State.addLog(`Fix: QC on ${card.id} — ${card.qc ? `${card.qc.verdict} ${card.qc.score}/10` : 'no verdict'}${found ? '' : ', nothing specific found — using a general anatomy + detail repair'}.`, 'ok');
    return found || `${FIX_PRESETS.anatomy.text}; ${FIX_PRESETS.detail.text.charAt(0).toLowerCase()}${FIX_PRESETS.detail.text.slice(1)}`;
  }

  /** 🩹 Fix for one card: preset key, 'auto' or free text. */
  async function queueFix(card, preset, { autoFix = false, start = true, allowRerender = false } = {}) {
    let text = fixInstruction(preset, card);
    // Auto with nothing to go on: run QC now instead of refusing.
    if (!text && preset === 'auto') text = await qcForFix(card);
    if (!text) throw new Error('nothing to fix — pick a preset or describe the fix');
    const label = FIX_PRESETS[preset] ? `Fix: ${FIX_PRESETS[preset].label}` : preset === 'auto' ? `Fix from QC: ${text}` : `Fix: ${text}`;
    // Vision-written repair when a vision model is up; the plain template otherwise.
    const plan = await planFix(card, text);
    // The planner looked at the picture and says the corrected pose cannot be reached by
    // redrawing in place (no readable body to keep): a fresh render instead of a doomed edit.
    if (allowRerender && plan && plan.editable === false) {
      State.addLog(`Fix: ${plan.by} says ${card.id} cannot be repaired in place — re-rendering it instead.`, 'warn');
      return queueRerender(card, { autoFix, start, flaws: text });
    }
    const out = await queueEdit({ source: { card }, prompt: plan ? plan.prompt : fixPrompt(text), label: plan ? `${label} (vision-written)` : label, fixOf: card.id, autoFix, start });
    out.job.fixPlan = plan ? { by: plan.by, fixed: plan.fixed } : null;
    out.planned = !!plan;
    return out;
  }

  /*
   * Vision-written repair. "Repair … keep the same body shape, pose … Fix these flaws: <list>"
   * tends to redraw the same broken shape (Qwen copies what it is told to keep, and a list of
   * what is wrong does not say what right looks like). A description of the corrected body —
   * "two separate legs with visible knees, the near leg bent over the far one…" — works far
   * better. So when a vision model is available it looks at the picture and writes that
   * description; when none is, the plain template above is used and nothing else changes.
   */
  const PLAN_PROMPT = (flaws) => `You are preparing an instruction for an image-EDITING model. It receives this picture and your text, and redraws the picture.

The picture has these problems: ${flaws}

The editing model copies whatever it is told to keep, and a list of what is wrong does not tell it what right looks like. So describe the CORRECTED picture as a concrete, physically possible scene.

Look closely at the picture and answer ONLY with JSON:
{
  "keep": "a short comma-separated list of what must stay the same: the character's identifying look (face, expression, hair colour and style, skin tone, body type), each piece of clothing with its colour, notable objects, the setting and background, the lighting, the camera angle and the art style. Do NOT list the pose or the broken body parts here.",
  "pose": "1-2 sentences: the whole-body pose in spatial terms, as it should be drawn correctly. Say how the body is placed (lying on her side / sitting / kneeling / standing), which way the hips and shoulders face relative to the viewer, and for EACH arm and EACH leg where it is, whether it is bent or straight, which one is in front, and where the knees, hands and feet end up. Example: 'The figure sits on a low stone wall facing the viewer; the left leg is bent with the foot flat on the ground, the right leg stretched forward; the right hand rests on the knee, the left hand holds a lantern at hip height.'",
  "fixed": "1-3 sentences on how each BROKEN part looks when drawn correctly, in positive concrete words (e.g. 'the two legs are separate, each with a visible knee and foot', 'the raised hand has five separate fingers wrapped around the lantern handle'). Describe the corrected result, not the defect. Do not invent new clothing, objects or people.",
  "editable": true,
  "ok": true
}
Set "editable": false when the corrected picture CANNOT be reached by redrawing only the broken parts in this same composition — the body has no readable structure to keep (two bodies merged into one, legs fused into one shape, a torso facing two ways at once, a limb with nowhere to attach). Otherwise true.
If the picture has no visible problem matching the list, set "ok": false.`;

  /** Is any vision model in the chain right now? Never throws. */
  async function visionAvailable() {
    try {
      const r = await window.ala.llm.route('vision');
      const chain = (r && (r.chain || (Array.isArray(r) ? r : null))) || [];
      return chain.some((c) => c && c.eligible !== false && c.vision !== false && !c.open);
    } catch {
      return false;
    }
  }

  /** The repair prompt Qwen sees when the vision model wrote the corrected description. */
  function plannedFixPrompt(keep, fixed, pose = '') {
    const k = clean(keep).replace(/[.\s]+$/, '');
    const f = clean(fixed).replace(/[.\s]+$/, '');
    const p = clean(pose).replace(/[.\s]+$/, '');
    return `Redraw <image1> with corrected anatomy and clean detail. Keep the same ${k} as <image1>. ${p ? `${cap(p)}. ` : ''}${cap(f)}. `
      + 'Redraw the broken parts with clear, confident outlines and clearly separate body shapes; everything that already looks right stays as it is. Sharp, clean detail.';
  }

  /**
   * Ask the vision model to describe the corrected picture. Returns { prompt, keep, fixed, by }
   * or null — null when no vision model is available, the call fails, or the answer is unusable
   * (the caller then uses the plain fixPrompt). Never throws.
   */
  async function planFix(card, flaws) {
    if (!card || !card.fname || !flaws) return null;
    if (!(await visionAvailable())) {
      State.addLog('Fix: no vision model available — using the plain repair instruction.', 'warn');
      return null;
    }
    try {
      const raw = await window.ala.files.readImageBase64(card.fname);
      const small = window.Pipeline && Pipeline.downscaleForQc ? await Pipeline.downscaleForQc(raw, card.mime || 'image/png') : { base64: raw, mime: card.mime || 'image/png' };
      const r = await U.llmVision(small.base64, small.mime, PLAN_PROMPT(clean(flaws)), { role: 'vision', temperature: 0.2 }, 'Fix planner');
      const j = U.extractJson(r && r.text);
      const keep = clean(j && j.keep).slice(0, 600);
      // The pose sentence helps a broken body but would re-pose a picture whose only flaw is
      // the hands (legs and furniture move). So it is used only when the flaws
      // are about the body itself; a hands/face/detail fix keeps the original pose untouched.
      // Location notes in brackets ("where her arms rest on the chair") are not flaws, so skip them.
      const bodyFlaw = /\b(body|torso|hips?|thighs?|legs?|knees?|feet|foot|arms?|limbs?|waist|pose|proportions?|anatom\w*|merged)\b/i
        .test(String(flaws).replace(/\([^)]*\)/g, ' '));
      const pose = bodyFlaw ? clean(j && j.pose).slice(0, 700) : '';
      const fixed = clean(j && j.fixed).slice(0, 900);
      if (j && j.ok === false) { State.addLog('Fix: the vision model saw none of those problems — using the plain repair instruction.', 'warn'); return null; }
      if (keep.length < 10 || fixed.length < 20) throw new Error('the answer had no usable keep/fixed text');
      const by = r && r.provider ? `${r.provider}${r.model ? ` (${r.model})` : ''}` : 'vision model';
      State.addLog(`Fix: ${by} described the corrected picture — ${(pose || fixed).slice(0, 140)}`, 'ok');
      return { prompt: plannedFixPrompt(keep, fixed, pose), keep, pose, fixed, by, editable: !(j && (j.editable === false || j.editable === 'false')) };
    } catch (e) {
      State.addLog(`Fix: the vision model could not plan the repair (${String(e && e.message || e).slice(0, 160)}) — using the plain repair instruction.`, 'warn');
      return null;
    }
  }

  // ---------- repair triage: edit (keeps the look) or re-render (new seed) ----------
  /*
   * An edit redraws FROM the broken picture, so it copies its structure: it fixes
   * a hand, a face, a smear, but a body with no readable skeleton (two legs fused into one
   * tube, merged torsos, an impossible twist) comes back as the same blob. Those get a fresh
   * render instead: same character, outfit, setting and style, ONE drawable pose, new seed.
   *
   * Decided in code from what QC already wrote — never another model opinion. A defect is
   * structural when its own words name a BODY part (torso, hips, legs, arm, shoulder…) before
   * any hand/face/object word, together with a hard word (fused, merged, melted, missing,
   * twisted…): "fused hand resting on the knee" is a hand, "left arm merges into the torso
   * with no elbow" is an arm. Two or more of the limbs/face/no_merges gates failing together
   * also counts (no_merges next to a hands NO is fused fingers, so it is dropped there).
   * Every hands-only fail stays an edit.
   */
  const HARD_RE = /\b(fus(?:e|ed|es|ing|ion)|merg\w*|melt\w*|blob\w*|shapeless|amorphous|formless|undefined|indistinct|mangl\w*|deform\w*|malform\w*|twist\w*|contort\w*|impossible|unnatural(?:ly)? (?:bent|twisted|angle\w*)|missing|extra|duplicat\w*|detach\w*|disconnect\w*|not attached|floating|wrong number|third|backwards|broken anatomy|unreadable|unresolvable|jointless|unarticulated)\b/i;
  const BODY_RE = /\b(body|bodies|torso|torsos|hips?|thighs?|legs?|knees?|forearms?|elbows?|arms?|limbs?|waist|pelvis|lower (?:half|body)|upper body|spine|shoulders?|chest|stomach|abdomen|silhouette|anatomy|pose|posture)\b/i;
  const LOCAL_RE = /\b(hands?|fingers?|thumbs?|digits?|knuckles?|palms?|wrists?|nails?|eyes?|pupils?|iris\w*|teeth|tooth|mouth|lips?|ears?|nose|eyebrows?|toes?|feet|foot|ankles?|text|watermark|signature|hair|background)\b/i;
  const OBJ_RE = /\b(strap|cable|pendant|necklace|shirt|top|jacket|coat|dress|clothing|clothes|garment|fabric|sleeve|collar|button|zipper|belt|shoe|boot|sock|glove|hat|helmet|scarf|jewel\w*|earbud|phone|cup|glass|bottle|book|sign|label|keys?|chair|table|bench|pillow|towel|railing|window|door|wall|floor|plant|flower|food|bag|wire|string|rope|chain|tail|wings?|horns?|weapon|sword|staff|shield|orb|lantern|umbrella|mushroom\w*|lettering)\b/i;
  const BIG_AREA_RE = /\b(whole|entire|most of|full|lower half|upper half|half (?:of )?the (?:picture|image|frame|body))\b/i;

  /** { mode: 'edit'|'rerender', reasons: [..] } for a card with a QC verdict. */
  function fixRoute(card) {
    const qc = (card && card.qc) || {};
    const reasons = [];
    const body = [];
    for (const d of (Array.isArray(qc.detail) ? qc.detail : [])) {
      if (!d || typeof d !== 'object') continue;
      const what = String(d.what || '');
      const where = String(d.where || '');
      if (!HARD_RE.test(`${what} ${where}`)) continue;
      const b = BODY_RE.exec(what);
      const l = LOCAL_RE.exec(what);
      const o = OBJ_RE.exec(what);
      const first = Math.min(l ? l.index : Infinity, o ? o.index : Infinity);
      if (b && b.index < first) body.push(clean(what));
      else if (!b && !l && !o && BIG_AREA_RE.test(String(d.area || '')) && BODY_RE.test(where)) body.push(clean(what));
    }
    if (body.length) reasons.push(`body: ${body.slice(0, 2).join('; ')}`);
    const failed = new Set(((qc.gates || {}).failed) || []);
    const bodyGates = ['limbs', 'face', 'no_merges'].filter((k) => failed.has(k));
    const counted = failed.has('hands') && !body.length ? bodyGates.filter((k) => k !== 'no_merges') : bodyGates;
    if (counted.length >= 2) reasons.push(`gates: ${counted.join(', ')}`);
    if (Number(qc.score) <= 1) reasons.push(`score ${qc.score}`);
    return { mode: reasons.length ? 'rerender' : 'edit', reasons };
  }

  /** gen.fixRerender (default on): may a repair be a fresh render? Off = edits only (the old way). */
  function rerenderOn() {
    const g = (State.settings && State.settings.gen) || {};
    return g.fixRerender !== false;
  }

  const RERENDER_PROMPT = (prompt, flaws) => `This picture came out with broken anatomy, so it will be generated again from scratch on a new seed. You write the new generation prompt.

The prompt that made it:
<<<${prompt}>>>

What is broken: ${flaws}

Rewrite that prompt so a fresh render draws the SAME picture minus the broken body:
- Keep the same character (face, hair, skin tone, body type, age look), the same number of people, every piece of clothing with its colour (never add or remove clothes), the props, the setting, the lighting and the art style. Look at the picture for anything the prompt leaves out.
- Replace ONLY the pose/action words with ONE simple pose a body can clearly take, where every limb is visible and separate (standing, sitting, kneeling, walking, leaning on a railing…). Stay close to the original idea. Say where the arms and legs are.
- Keep the prompt's own form: comma-separated tags stay comma-separated tags; keep its quality and style tags. No quality complaints and no mention of what was broken.

Answer ONLY with JSON: {"prompt": "the full new prompt", "pose": "the pose you chose, one short sentence", "ok": true}`;

  /** Vision-written re-render prompt, or null (no vision model / unusable answer). Never throws. */
  async function planRerender(card, flaws) {
    if (!card || !card.fname) return null;
    if (!(await visionAvailable())) return null;
    try {
      const raw = await window.ala.files.readImageBase64(card.fname);
      const small = window.Pipeline && Pipeline.downscaleForQc ? await Pipeline.downscaleForQc(raw, card.mime || 'image/png') : { base64: raw, mime: card.mime || 'image/png' };
      const r = await U.llmVision(small.base64, small.mime, RERENDER_PROMPT(String(card.prompt || '').slice(0, 2500), clean(flaws) || 'broken body anatomy'), { role: 'vision', temperature: 0.3 }, 'Re-render planner');
      const j = U.extractJson(r && r.text);
      const prompt = clean(j && j.prompt);
      if (prompt.length < 30 || prompt.length > 3000) throw new Error('no usable prompt came back');
      const by = r && r.provider ? `${r.provider}${r.model ? ` (${r.model})` : ''}` : 'vision model';
      return { prompt, pose: clean(j && j.pose).slice(0, 300), by };
    } catch (e) {
      State.addLog(`Re-render: the vision model could not write the new prompt (${String(e && e.message || e).slice(0, 160)}) — using the original prompt with a simple-pose instruction.`, 'warn');
      return null;
    }
  }

  /** The plain fallback: the original prompt plus a clear-anatomy instruction. */
  function rerenderFallback(prompt) {
    const p = clean(prompt).replace(/[,.\s]+$/, '');
    return `${p}, simple clear pose, whole body clearly readable, every arm and leg visible and separate, anatomically correct`;
  }

  /**
   * Queue a FRESH render of a broken card: the vision-rewritten prompt (same character, outfit,
   * scene and style; one drawable pose) on new seeds — `gen.rerenderSeeds` pictures (default 2),
   * each QC'd. The card's own character references ride along; the broken picture itself never
   * does (Qwen copies what it is shown). Front of the queue. Returns { job, batchId, planned }.
   */
  async function queueRerender(card, { autoFix = false, start = true, flaws = '' } = {}) {
    if (!comfyOn()) throw new Error('re-renders run on the ComfyUI engine (Settings → Generation)');
    if (!card) throw new Error('no picture to re-render');
    const text = flaws || fixInstruction('auto', card).replace(/^Fix these flaws:\s*/i, '');
    const plan = await planRerender(card, text);
    let prompt = plan ? plan.prompt : rerenderFallback(card.prompt || '');
    if (window.PromptStyle) prompt = PromptStyle.enforceTail(prompt);
    const g = (State.settings && State.settings.gen) || {};
    const source = card.promptSource && card.promptSource !== 'edit' ? card.promptSource : 'ideation';
    const job = Pipeline.makeJob(prompt, card.theme || 'Re-render', source);
    job.count = Math.max(1, Math.min(4, Math.round(Number(g.rerenderSeeds)) || 2));
    job.fixOf = card.id;
    job.fixMode = 'rerender';
    job.editLabel = `Re-render${plan && plan.pose ? `: ${plan.pose}` : ' with a simple pose'}`.slice(0, 200);
    if (autoFix) job.autoFix = true;
    if (Array.isArray(card.referenceIds) && card.referenceIds.length) job.referenceIds = [...card.referenceIds];
    if (Array.isArray(card.chatReferences) && card.chatReferences.length) job.chatReferences = card.chatReferences.map((r) => ({ ...r }));
    if (card.researchId) job.researchId = card.researchId;
    job.fixPlan = { mode: 'rerender', by: plan ? plan.by : null, pose: plan ? plan.pose : '' };
    const batchId = `b${U.uid()}`;
    job.batchId = batchId;
    State.queue = [job, ...(State.queue || [])];
    State.persistQueue();
    if (start) Pipeline.start({ only: [job.id] });
    State.addLog(`Re-render queued at the front for ${card.id} (${job.count} new seed${job.count > 1 ? 's' : ''})${plan ? ` — ${plan.pose || 'new prompt by the vision model'}` : ' — plain prompt'}.`, 'ok');
    return { job, batchId, planned: !!plan };
  }

  /**
   * One repair of a card with QC findings, routed: try 1 follows fixRoute (an edit when the
   * damage is local, a re-render when the body is broken; the edit planner can still say the
   * pose cannot be kept and switch it), and every later try is a re-render — an edit that
   * already failed will not start working on the second go. `gen.fixRerender:false` keeps
   * every repair an edit. A card that is itself an edit result is always edited (its prompt
   * does not describe the edit, so a fresh render would lose it).
   */
  async function queueRepair(card, { autoFix = true, start = false, tryNo = 1 } = {}) {
    const route = fixRoute(card);
    const canRerender = rerenderOn() && !card.editOf;
    const mode = canRerender && (tryNo > 1 || route.mode === 'rerender') ? 'rerender' : 'edit';
    let out;
    if (mode === 'rerender') {
      out = await queueRerender(card, { autoFix, start });
    } else {
      const preset = fixInstruction('auto', card) ? 'auto' : 'detail';
      out = await queueFix(card, preset, { autoFix, start, allowRerender: canRerender });
    }
    out.route = route;
    return out;
  }

  /** gen.autoFixTries: repair attempts per failed picture, 1–2 (default 2; 1 = the old one-shot). */
  function autoFixTries() {
    const g = (State.settings && State.settings.gen) || {};
    const n = Math.round(Number(g.autoFixTries));
    return Number.isFinite(n) && n >= 1 ? Math.min(2, n) : 2;
  }

  /**
   * After a card FAILS QC: up to `gen.autoFixTries` repair attempts, if the artist switched
   * auto-fix on. Every attempt repairs the ORIGINAL picture (stacked edits drift), from the
   * original's QC findings, on a fresh seed; each repair goes through QC like any picture.
   * A failed AUTO repair queues the next attempt until the limit, then the picture stays
   * discarded. A manual 🩹 fix that fails is never retried. Never twice for the same card,
   * never on Perchance. Returns the queued job or null. The worker is already running.
   */
  async function maybeAutoFix(card) {
    const g = (State.settings && State.settings.gen) || {};
    if (!comfyOn() || !card) return null;
    if (card.autoFixJob) return null;
    if (!card.qc || card.qc.verdict !== 'FAIL') return null;
    // A failed repair hands over to its original; a failed MANUAL fix is left alone.
    let orig = card;
    if (card.fixOf) {
      if (!card.autoFix) return null;
      orig = (State.library || []).find((c) => c && c.id === card.fixOf) || null;
      if (!orig || orig.fixOf) return null;
    }
    // The Overseer's fix_images marks the original `fixChain`: its repairs chain even with
    // the auto-fix setting off (he asked for the fix himself).
    if (!g.autoFix && !orig.fixChain) return null;
    if (orig === card && orig.fixChain) return null;
    const max = autoFixTries();
    const used = Number(orig.autoFixTries) || (orig.autoFixJob ? 1 : 0);
    if (orig === card && used) return null;
    if (used >= max) {
      State.addLog(`Auto-fix: repair ${used}/${max} of card ${orig.id} failed QC (${card.qc.score}/10) — no tries left, the picture stays discarded.`, 'warn');
      return null;
    }
    card.autoFixJob = 'pending';
    try {
      const { job } = await queueRepair(orig, { autoFix: true, start: false, tryNo: used + 1 });
      job.autoFixTry = used + 1;
      if (orig.fixChain) job.forceQc = true;
      card.autoFixJob = job.id;
      orig.autoFixJob = job.id;
      orig.autoFixTries = used + 1;
      orig.updatedAt = card.updatedAt = Date.now();
      State.persistLibrary();
      const how = job.fixMode === 'rerender' ? 're-render' : 'edit';
      State.addLog(orig === card
        ? `Auto-fix: card ${card.id} failed QC (${card.qc.score}/10) — repair ${used + 1}/${max} queued (${how}).`
        : `Auto-fix: repair ${used}/${max} of card ${orig.id} also failed QC (${card.qc.score}/10) — repair ${used + 1}/${max} queued (${how}).`, 'ok');
      return job;
    } catch (e) {
      card.autoFixJob = null;
      State.addLog(`Auto-fix could not queue a repair for ${orig.id}: ${e.message}`, 'err');
      return null;
    }
  }

  /** After a FIX card has its QC verdict: record before → after on both cards. */
  function noteFixResult(card) {
    if (!card || !card.fixOf) return;
    const orig = (State.library || []).find((c) => c && c.id === card.fixOf);
    const after = card.qc ? card.qc.score : null;
    const before = orig && orig.qc ? orig.qc.score : null;
    card.fixDelta = { from: before, to: after };
    if (orig) { orig.fixedBy = card.id; orig.updatedAt = Date.now(); }
  }

  // ---------- edit history (checkpoints) ----------
  /*
   * Every finished edit is a checkpoint; the source picture is checkpoint 0. Nothing is
   * stored separately: the tree is rebuilt from the library (cards carry editRoot = the
   * session, editOf = the checkpoint they were made from) and the queue (pending edits), so
   * it survives restarts and can never disagree with what is actually on disk.
   * Node keys use the edit-source id format: `card-<id>` for a card, the upload row id for an
   * uploaded root, `job-<id>` for a pending edit.
   */
  const PENDING = new Set(['queued', 'generating']);

  /**
   * `rootRow` (optional): the uploaded picture's row when the root is an upload — needed
   * before any result exists; afterwards it is recovered from the results' references.
   * Discarded checkpoints are hidden unless `showDiscarded`; their children hang on the
   * nearest visible ancestor. Returns { root, nodes: Map, discarded } or null.
   */
  function historyTree(rootKey, library = [], queue = [], { rootRow = null, showDiscarded = false } = {}) {
    if (!rootKey) return null;
    const lib = (library || []).filter((c) => c && c.editRoot === rootKey && c.fname);
    const rootCard = /^card-/.test(rootKey) ? (library || []).find((c) => c && `card-${c.id}` === rootKey) || null : null;
    let row = rootRow;
    if (!rootCard && !row) {
      const child = lib.find((c) => c.editOf === rootKey && Array.isArray(c.chatReferences) && c.chatReferences[0] && c.chatReferences[0].fname);
      if (child) row = { id: rootKey, fname: child.chatReferences[0].fname, mime: 'image/png', name: child.chatReferences[0].name || 'uploaded picture' };
    }
    const root = {
      key: rootKey, kind: 'root', n: 0, card: rootCard, row,
      url: rootCard ? rootCard.url : row && row.fname ? `ala://ovr/${row.fname}` : '',
      parentKey: null, parent: null, children: [], at: 0,
    };
    const nodes = new Map([[rootKey, root]]);
    let n = 0;
    let discarded = 0;
    for (const c of lib.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
      const key = `card-${c.id}`;
      if (key === rootKey || nodes.has(key)) continue;
      const isOff = c.status === 'discarded';
      if (isOff) discarded++;
      nodes.set(key, { key, kind: 'card', n: ++n, card: c, url: c.url, parentKey: c.editOf || rootKey, children: [], at: c.createdAt || 0, discarded: isOff });
    }
    for (const j of (queue || [])) {
      if (!j || j.editRoot !== rootKey || !PENDING.has(j.status)) continue;
      const key = `job-${j.id}`;
      nodes.set(key, { key, kind: 'pending', n: null, job: j, url: '', parentKey: j.editOf || rootKey, children: [], at: j.createdAt || Date.now(), discarded: false });
    }
    const hidden = (node) => node.discarded && !showDiscarded;
    for (const node of nodes.values()) {
      if (node === root || hidden(node)) continue;
      let p = nodes.get(node.parentKey) || root;
      for (let guard = 0; p !== root && (hidden(p) || p === node) && guard < 1000; guard++) p = nodes.get(p.parentKey) || root;
      if (p === node) p = root;
      node.parent = p;
      p.children.push(node);
    }
    for (const node of nodes.values()) node.children.sort((a, b) => (a.kind === 'pending') - (b.kind === 'pending') || a.at - b.at);
    return { root, nodes, discarded };
  }

  /**
   * Rows for the history panel, depth-first. A straight run of edits stays in one column; a
   * second (third…) child is a BRANCH and is indented one step, marked with where it came
   * from — so a long chain does not walk off the side of a 320-px panel.
   */
  function historyRows(tree, currentKey = null) {
    if (!tree) return [];
    const lineage = new Set();
    for (let p = currentKey && tree.nodes.get(currentKey); p; p = p.parent) lineage.add(p.key);
    const rows = [];
    const walk = (node, depth, branchFrom) => {
      rows.push({ node, depth, branchFrom, on: node.key === currentKey, lineage: lineage.has(node.key) });
      const kids = node.children;
      if (!kids.length) return;
      walk(kids[0], depth, null);
      for (const k of kids.slice(1)) walk(k, Math.min(depth + 1, 4), node);
    };
    walk(tree.root, 0, null);
    return rows;
  }

  /** What to ask Qwen again for ↻ Redo: same source checkpoint, same instruction, new seed. */
  function redoSpec(node, tree) {
    if (!node || node.kind !== 'card' || !tree) return null;
    const c = node.card;
    const parent = tree.nodes.get(c.editOf) || tree.root;
    const source = parent.kind === 'card' || (parent.kind === 'root' && parent.card)
      ? { card: parent.card }
      : parent.row ? { row: parent.row } : null;
    if (!source || !c.editPrompt) return null;
    return {
      source, prompt: c.editPrompt, label: c.editLabel || '', instruction: c.editInstruction || '',
      fixOf: c.fixOf || null, basePrompt: c.prompt && c.prompt !== c.editPrompt ? c.prompt : null,
      redoOf: c.id, root: c.editRoot, parentKey: parent.key,
    };
  }

  /**
   * The artist's own words for ✎ Reuse. New cards store them (`editInstruction`); older ones
   * are read back out of the edit template; a fix (whose prompt is a repair) has none.
   */
  function reuseText(card) {
    if (!card || card.fixOf) return '';
    if (card.editInstruction) return card.editInstruction;
    const m = /^Edit <image1>\..*?\bbackground\. (.+?)\.? Change nothing else\./.exec(String(card.editPrompt || ''));
    return m ? m[1] : '';
  }

  window.ImageEdit = {
    FIX_PRESETS, editPrompt, fixPrompt, locationPhrase, regionInstruction, fixInstruction,
    latentSizeOf, nativeSize, sizeWarning, comfyOn, cardRow, queueEdit, queueFix, queueRerender, queueRepair, fixRoute, maybeAutoFix, autoFixTries, noteFixResult,
    visionAvailable, planFix, plannedFixPrompt, PLAN_PROMPT,
    historyTree, historyRows, redoSpec, reuseText,
  };
})();
