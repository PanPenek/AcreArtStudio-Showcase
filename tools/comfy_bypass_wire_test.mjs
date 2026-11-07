/* comfy_bypass_wire_test.mjs — wires from muted / bypassed nodes are dropped.
 *
 * The Qwen 2.1 Turbo INT8 workflow saves its four reference LoadImage nodes BYPASSED (mode 4)
 * but still wired into TextEncodeQwenImage21's images.image_1..4. If normalizeWorkflow skipped the
 * bypassed loaders and kept the wires, a job with a reference would still work (injectQwenReferences
 * clears them), but every job WITHOUT a reference (comic cast sheets, plain
 * text jobs) would be refused by ComfyUI: "Exception when validating inner node: '471'".
 *
 * Loads the REAL renderer comfy.js (window.ala.comfy stubbed, as in textonly_reference_test).
 *
 * Run: node tools/comfy_bypass_wire_test.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(process.env.ACRE_APP || path.join(HERE, '..'));
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

// API-format Qwen-shaped graph whose encoder still points at loaders that are not in the file.
const WORKFLOW = {
  1: { class_type: 'UNETLoader', inputs: { unet_name: 'qwen.gguf', weight_dtype: 'default' } },
  2: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_te.safetensors', type: 'qwen_image', device: 'default' } },
  3: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_vae.safetensors' } },
  4: { class_type: 'TextEncodeQwenImage21', inputs: { prompt: '', clip: ['2', 0], vae: ['3', 0], 'images.image_1': ['470', 0], 'images.image_2': ['471', 0] } },
  6: { class_type: 'EmptySD3LatentImage', inputs: { width: 832, height: 1248, batch_size: 1 } },
  7: { class_type: 'KSampler', inputs: { seed: 0, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['1', 0], positive: ['4', 0], negative: ['4', 0], latent_image: ['6', 0] } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'T', images: ['8', 0] } },
};

const submits = [];
let promptCalls = 0;
global.window = {};
window.ala = {
  comfy: {
    http: async ({ url, json = null }) => {
      const u = String(url);
      if (u.endsWith('/system_stats')) return { ok: true, status: 200, json: { system: { name: 'FakeComfy' } } };
      if (u.endsWith('/object_info')) return { ok: true, status: 200, json: {} };
      if (u.endsWith('/prompt')) { promptCalls += 1; submits.push(json.prompt); return { ok: true, status: 200, json: { prompt_id: 'p' + promptCalls } }; }
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
const { ComfyDriver, ComfyUI } = window;

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass += 1; console.log('  ok   ' + label); } else { fail += 1; console.log('  FAIL ' + label + (extra ? ' — ' + extra : '')); } };
const dangling = (nodes) => {
  const out = [];
  for (const [id, n] of Object.entries(nodes)) for (const [k, v] of Object.entries(n.inputs || {})) if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && !nodes[v[0]]) out.push(`${id}.${k}`);
  return out;
};

console.log('[1] editor format: a bypassed loader wired into the encoder');
{
  const raw = {
    nodes: [
      { id: 470, type: 'LoadImage', mode: 4, widgets_values: ['old.png', 'image'], inputs: [], outputs: [{ name: 'IMAGE', links: [5] }] },
      { id: 452, type: 'TextEncodeQwenImage21', mode: 0, inputs: [{ name: 'images.image_1', link: 5 }, { name: 'clip', link: 6 }], widgets_values: ['p'] },
      { id: 2, type: 'CLIPLoader', mode: 0, inputs: [], widgets_values: ['te', 'qwen_image', 'default'] },
    ],
    links: [[5, 470, 0, 452, 0, 'IMAGE'], [6, 2, 0, 452, 1, 'CLIP']],
  };
  const wf = ComfyUI.normalizeWorkflow(raw, null);
  ok(!wf.nodes['470'], 'the bypassed loader is not in the graph');
  ok(!('images.image_1' in wf.nodes['452'].inputs), 'its wire into the encoder is dropped', JSON.stringify(wf.nodes['452'].inputs));
  ok(Array.isArray(wf.nodes['452'].inputs.clip) && wf.nodes['452'].inputs.clip[0] === '2', 'a live wire stays');
  ok(dangling(wf.nodes).length === 0, 'no wire points at a missing node');
}

console.log('[2] API format (what a subgraph workflow becomes): a wire to a missing node');
{
  const wf = ComfyUI.normalizeWorkflow(JSON.parse(JSON.stringify(WORKFLOW)));
  ok(dangling(wf.nodes).length === 0, 'dropped', dangling(wf.nodes).join(','));
  ok(wf.nodes['4'].inputs.vae[0] === '3' && wf.nodes['7'].inputs.positive[0] === '4', 'everything else is untouched');
}

console.log('[3] a clean graph is unchanged');
{
  const clean = JSON.parse(JSON.stringify(WORKFLOW));
  delete clean['4'].inputs['images.image_1'];
  delete clean['4'].inputs['images.image_2'];
  const wf = ComfyUI.normalizeWorkflow(clean);
  ok(JSON.stringify(Object.keys(wf.nodes['4'].inputs)) === JSON.stringify(['prompt', 'clip', 'vae']), 'inputs as saved');
  ok(!wf.dangling, 'nothing reported');
}

console.log('[4] a job with NO reference submits a valid prompt');
{
  const d = new ComfyDriver({ comfy: { serverUrl: 'http://fake:1', workflowsDir: 'x', imageWorkflow: 'qwen.json', videoWorkflow: '', launchCommand: '', imagesPerPrompt: 1, maxReferences: 1 } });
  let err = null;
  try { await d.generate('A lighthouse on a cliff at dusk, painted anime style.', { count: 1 }, () => {}); } catch (e) { err = e.message; }
  ok(!err, 'generate ran', err || '');
  const sub = submits[submits.length - 1] || {};
  ok(Object.keys(sub).length > 0 && dangling(Object.fromEntries(Object.entries(sub).map(([k, v]) => [k, { inputs: v.inputs }]))).length === 0, 'the submitted prompt has no wire to a missing node');
  const enc = Object.values(sub).find((n) => n.class_type === 'TextEncodeQwenImage21');
  ok(enc && !Object.keys(enc.inputs).some((k) => /^images\./.test(k)), 'the encoder carries no reference input', enc ? Object.keys(enc.inputs).join(',') : 'no encoder');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
