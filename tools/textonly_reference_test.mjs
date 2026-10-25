/* text-only workflows (MOSS-Image) take researched references gracefully.
 *
 * Loads the REAL renderer comfy.js and stubs only window.ala.comfy.http / readWorkflow, so the
 * job path runs offline. Pins:
 *   - a researched job WITH references on a graph that has no reference input renders text-only
 *     instead of throwing; nothing is uploaded; every reference comes back in `skipped` with a
 *     text-only reason and `textOnly: true`;
 *   - `<imageN>` markers (and their lead-in word) are stripped from the submitted prompt, also
 *     on prompt variants;
 *   - an EDIT (matchSource) on the same graph still throws, so an edit never turns into a random
 *     new picture;
 *   - a job without references is untouched.
 *
 * Run: node tools/textonly_reference_test.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

// API-format MOSS-shaped graph: no TextEncodeQwenImage21, no ReferenceMultiLatent.
const WORKFLOW = {
  1: { class_type: 'UNETLoader', inputs: { unet_name: 'moss_image_sft_int8_convrot.safetensors', weight_dtype: 'default' } },
  2: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3.5_9b_int8_convrot.safetensors', type: 'moss_image', device: 'default' } },
  3: { class_type: 'VAELoader', inputs: { vae_name: 'flux2-vae_small.safetensors' } },
  4: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
  5: { class_type: 'CLIPTextEncode', inputs: { text: 'worst quality', clip: ['2', 0] } },
  6: { class_type: 'EmptyFlux2LatentImage', inputs: { width: 832, height: 1248, batch_size: 1 } },
  7: { class_type: 'KSampler', inputs: { seed: 0, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0] } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'MOSS', images: ['8', 0] } },
};

let submits = [];
let uploads = 0;
let promptCalls = 0;
global.window = {};
window.ala = {
  comfy: {
    http: async ({ url, json = null }) => {
      const u = String(url);
      if (u.endsWith('/system_stats')) return { ok: true, status: 200, json: { system: { name: 'FakeComfy' } } };
      if (u.endsWith('/object_info')) return { ok: true, status: 200, json: {} };
      if (u.endsWith('/upload/image')) { uploads += 1; return { ok: true, status: 200, json: { name: 'up.png' } }; }
      if (u.endsWith('/prompt')) {
        promptCalls += 1;
        submits.push(json.prompt);
        return { ok: true, status: 200, json: { prompt_id: 'p' + promptCalls } };
      }
      const h = u.match(/\/history\/(p\d+)/);
      if (h) return { ok: true, status: 200, json: { [h[1]]: { status: { completed: true, status_str: 'success' }, outputs: { 9: { images: [{ filename: h[1] + '.png', subfolder: '', type: 'output' }] } } } } };
      if (u.includes('/view?')) return { ok: true, status: 200, base64: PNG, size: 68 };
      throw new Error('unexpected HTTP call: ' + u);
    },
    readWorkflow: async () => JSON.parse(JSON.stringify(WORKFLOW)),
  },
  files: { readImageBase64: () => { throw new Error('n/a'); } },
};
global.U = { llmVision: async () => { throw new Error('n/a'); }, llmChat: async () => { throw new Error('n/a'); } };
(0, eval)(fs.readFileSync(path.join(APP, 'src', 'renderer', 'comfy.js'), 'utf8'));
const ComfyDriver = window.ComfyDriver;

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass += 1; console.log('  ok   ' + label); } else { fail += 1; console.log('  FAIL ' + label + (extra ? ' — ' + extra : '')); } };
const mk = () => new ComfyDriver({ comfy: { serverUrl: 'http://fake:1', workflowsDir: 'x', imageWorkflow: 'moss.json', videoWorkflow: '', launchCommand: '', imagesPerPrompt: 2, maxReferences: 1 } });
const REFS = [{ id: 'r1', base64: PNG, mime: 'image/png' }, { id: 'r2', base64: PNG, mime: 'image/png' }];
const logs = [];
const log = (m, t) => logs.push(`${t || 'info'}: ${m}`);

console.log('[1] researched job with references on a text-only graph renders');
submits = []; uploads = 0; promptCalls = 0;
let r, err = null;
try {
  r = await mk().generate('A woman with the red jacket from <image1>, standing in rain like <image2>. Neon street (<image1>).', {
    references: REFS, count: 0, variants: ['Variant one in the outfit of <image1>.', 'Variant two, no marker.'],
  }, log);
} catch (e) { err = e; }
ok(!err, 'generate() does not throw', err && err.message);
ok(r && r.images && r.images.length === 2, 'renders imagesPerPrompt (2) pictures', JSON.stringify(r && r.images && r.images.length));
ok(uploads === 0, 'nothing is uploaded to ComfyUI', String(uploads));
const rr = r && r.referenceResult;
ok(rr && rr.textOnly === true && rr.attached.length === 0, 'referenceResult says textOnly, none attached', JSON.stringify(rr));
ok(rr && rr.skipped.length === 2 && rr.skipped.every((s) => /text-only/.test(s.error)), 'every reference is reported skipped with a text-only reason', JSON.stringify(rr && rr.skipped));
ok(logs.some((l) => l.startsWith('warn:') && /text-only/.test(l)), 'a warning is logged');
const texts = submits.map((p) => p['4'].inputs.text);
ok(texts.every((t) => !/<image\d+>/i.test(t)), 'no <imageN> marker reaches the prompt', JSON.stringify(texts));
ok(texts[0] === 'Variant one in the outfit.', 'variant 1 marker stripped with its lead-in word', JSON.stringify(texts[0]));
ok(texts[1] === 'Variant two, no marker.', 'variant 2 untouched', JSON.stringify(texts[1]));

console.log('[2] the base prompt is cleaned too (no variants)');
submits = []; promptCalls = 0;
r = await mk().generate('A woman with the red jacket from <image1>, standing in rain like <image2>. Neon street (<image1>).', { references: REFS, count: 1 }, log);
ok(submits[0]['4'].inputs.text === 'A woman with the red jacket, standing in rain. Neon street.', 'markers and lead-ins removed, punctuation kept', JSON.stringify(submits[0]['4'].inputs.text));

console.log('[3] an edit on a text-only graph still stops');
err = null; submits = []; promptCalls = 0;
try { await mk().generate('Edit <image1>. Give her a red scarf.', { references: REFS.slice(0, 1), count: 1, matchSource: true }, log); } catch (e) { err = e; }
ok(err && /image edit/.test(err.message), 'edit throws a clear error', err && err.message);
ok(submits.length === 0, 'nothing was submitted for the edit');

console.log('[4] a job without references is untouched');
submits = []; promptCalls = 0;
r = await mk().generate('Plain prompt about <image1> marker kept.', { references: [], count: 1 }, log);
ok(r.referenceResult === null, 'referenceResult is null', JSON.stringify(r.referenceResult));
ok(submits[0]['4'].inputs.text === 'Plain prompt about <image1> marker kept.', 'prompt passes through unchanged');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
