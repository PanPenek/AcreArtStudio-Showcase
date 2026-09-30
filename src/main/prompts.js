/**
 * prompts.js: shared LLM prompt templates for ideation, quality check and
 * metadata. Post-processing in code enforces hard rules (tag format, the optional
 * supporter link) that a model might otherwise forget.
 */
const PATREON_LINE = (link) => link;

function ideationPrompt({ theme, example, count }) {
  return `You are a creative director for an anime-style AI art studio. Your job is to write image-generation prompts.

Theme to explore: "${theme}"
${example ? `\nHere is an example prompt from the artist showing the style and level of detail to imitate:\n"""${example}"""\n` : ''}
Write ${count} DISTINCT, highly detailed image prompts for an anime image generator. Rules:
- Each prompt describes ONE scene: character(s), appearance, outfit, pose, expression, setting, lighting, camera angle.
- Be clear and specific about the theme — the audience wants variety within the theme.
- Vary composition: different poses, angles, settings, moods across the ${count} prompts.
- 40-90 words each. No preamble, no numbering commentary.
- Quality tags style is fine (e.g. "masterpiece, best quality" prefixes are allowed but not required).

Respond ONLY with a JSON array of strings: ["prompt1", "prompt2", ...]`;
}

function qcPrompt() {
  return `You are a ruthless AI-generated image quality inspector. Examine this image closely for generation artifacts and anatomical defects.

Check specifically for:
- Hands/fingers: extra fingers, missing fingers, fused fingers, malformed hands
- Limbs: extra limbs, missing limbs, limbs bending wrong, disconnected limbs
- Face: distorted/asymmetric/melted facial features, dead/wonky eyes, broken mouth
- Anatomy: impossible body proportions, twisted torso, broken joints
- Image defects: watermarks, embedded text/signature artifacts, heavy jpeg artifacts, smearing, blur in focal areas, duplicated body parts, objects merging into skin
- Composition: unintended cropping of the subject's head/face

Score the image 1-10 (10 = flawless, professional; 7 = minor issues only; 5 = noticeable artifacts; 1 = broken).

Respond ONLY with JSON:
{"score": <1-10>, "verdict": "PASS"|"FAIL", "defects": ["..."], "notes": "one sentence overall impression"}
Verdict PASS only if score >= 7 and there are no major anatomical defects.`;
}

function metadataPrompt({ prompt, qcNotes, exampleStyle, maxTags }) {
  return `You write DeviantArt submission metadata for anime-style AI art posts.

The image was generated from this prompt:
"""${prompt}"""
${qcNotes ? `Inspector notes about the image: ${qcNotes}` : ''}
${exampleStyle ? `\nMimic the tone/style of this example metadata from the artist:\n"""${exampleStyle}"""\n` : ''}
Generate:
1. "title": catchy, tasteful, max 60 characters. No quotes, no hashtags.
2. "description": 2-4 sentences. Artistic and warm. Describes the scene, mood, and aesthetic. Do NOT include any URLs or Patreon mentions — that gets prepended separately.
3. "tags": array of ${maxTags} relevant DeviantArt tags. Lowercase, single words (letters/numbers only, no spaces, no hyphens). Mix subject tags, style tags, and theme tags.

Respond ONLY with JSON: {"title": "...", "description": "...", "tags": ["...", "..."]}`;
}

function cleanTag(tag) {
  return String(tag || '')
    .trim().toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 60);
}

function buildDescription(patreonLink, cta, aiDescription, destination = 'deviantart') {
  const body = String(aiDescription || '')
    .replace(/https?:\/\/\S*patreon\S*/gi, '')
    .trim();
  if (destination === 'patreon') return body;
  const linkLine = PATREON_LINE(patreonLink);
  return `${linkLine}\n\n${cta}\n\n${body}`.trim();
}

function finalizeTags(aiTags, defaultTags, maxTags) {
  const out = [];
  const seen = new Set();
  for (const t of [...(aiTags || []), ...(defaultTags || [])]) {
    const c = cleanTag(t);
    if (c && !seen.has(c)) { seen.add(c); out.push(c); }
    if (out.length >= maxTags) break;
  }
  return out;
}

module.exports = { ideationPrompt, qcPrompt, metadataPrompt, cleanTag, buildDescription, finalizeTags };
