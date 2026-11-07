/* edit_model_route_test.mjs — Settings → Generation "Edit model".
 *
 * comfy.editWorkflow, when set and able to take a picture, handles every edit (editRoute);
 * unset keeps the old order (image workflow first). A per-call file still wins.
 * Loads the REAL renderer comfy.js with window.ala.comfy stubbed.
 *
 * Run: node tools/edit_model_route_test.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(process.env.ACRE_APP || path.join(HERE, '..'));

const REF = {
  2: { class_type: 'CLIPLoader', inputs: { clip_name: 'te', type: 'qwen_image', device: 'default' } },
  3: { class_type: 'VAELoader', inputs: { vae_name: 'v' } },
  4: { class_type: 'TextEncodeQwenImage21', inputs: { prompt: '', clip: ['2', 0], vae: ['3', 0] } },
  6: { class_type: 'EmptySD3LatentImage', inputs: { width: 832, height: 1248, batch_size: 1 } },
  1: { class_type: 'UNETLoader', inputs: { unet_name: 'q', weight_dtype: 'default' } },
  7: { class_type: 'KSampler', inputs: { seed: 0, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['1', 0], positive: ['4', 0], negative: ['4', 0], latent_image: ['6', 0] } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'T', images: ['8', 0] } },
};
const TEXT = {
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm' } },
  2: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
  3: { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1248, batch_size: 1 } },
  4: { class_type: 'KSampler', inputs: { seed: 0, steps: 8, cfg: 5, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['1', 0], positive: ['2', 0], negative: ['2', 0], latent_image: ['3', 0] } },
  5: { class_type: 'VAEDecode', inputs: { samples: ['4', 0], vae: ['1', 2] } },
  6: { class_type: 'SaveImage', inputs: { filename_prefix: 'T', images: ['5', 0] } },
};
const FILES = { 'image_ref.json': REF, 'edit_ref.json': REF, 'text_only.json': TEXT };

global.window = {};
window.ala = {
  comfy: {
    http: async () => ({ ok: true, status: 200, json: {} }),
    readWorkflow: async ({ file }) => { if (!FILES[file]) throw new Error('no such file ' + file); return JSON.parse(JSON.stringify(FILES[file])); },
  },
  files: { readImageBase64: () => { throw new Error('n/a'); } },
};
global.U = { llmVision: async () => { throw new Error('n/a'); }, llmChat: async () => { throw new Error('n/a'); } };
(0, eval)(fs.readFileSync(path.join(APP, 'src', 'renderer', 'comfy.js'), 'utf8'));
const { ComfyDriver } = window;

let pass = 0, fail = 0;
const ok = (c, l, x = '') => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l + (x ? ' — ' + x : '')); } };
const drv = (comfy) => new ComfyDriver({ comfy: { serverUrl: 'http://fake:1', workflowsDir: 'x', videoWorkflow: '', launchCommand: '', ...comfy } });

const a = await drv({ imageWorkflow: 'image_ref.json', editWorkflow: '' }).editRoute();
ok(a.file === 'image_ref.json' && a.from === 'image', 'unset: edits use the image workflow (old behaviour)', JSON.stringify(a));

const b = await drv({ imageWorkflow: 'image_ref.json', editWorkflow: 'edit_ref.json' }).editRoute();
ok(b.file === 'edit_ref.json' && b.from === 'edit', 'set: the picked edit model wins over a reference-capable image workflow', JSON.stringify(b));

const c = await drv({ imageWorkflow: 'image_ref.json', editWorkflow: 'edit_ref.json' }).editRoute('image_ref.json');
ok(c.file === 'image_ref.json', 'an explicit per-call file still wins', JSON.stringify(c));

const d = await drv({ imageWorkflow: 'image_ref.json', editWorkflow: 'text_only.json' }).editRoute();
ok(d.file === 'image_ref.json', 'a picked edit model that cannot take a picture is skipped', JSON.stringify(d));

const e = await drv({ imageWorkflow: 'text_only.json', editWorkflow: 'edit_ref.json' }).editRoute();
ok(e.file === 'edit_ref.json', 'text-only image workflow → the edit model (unchanged)', JSON.stringify(e));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
