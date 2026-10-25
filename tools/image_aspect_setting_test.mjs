/* Assertions for `comfy.imageAspect` — Settings → Generation → Image shape.
 *
 * Loads the REAL renderer comfy.js and stubs only window.ala.comfy.http, so the job path
 * runs offline (no ComfyUI, no GPU). Pins:
 *   - '' (default)            -> the workflow's ResolutionSelector is left as the file says
 *   - a preferred shape       -> every ResolutionSelector gets that aspect; megapixels/multiple untouched
 *   - a job aspect (comics)   -> wins over the preference
 *   - an edit (matchSource + an attached reference) -> keeps the source shape, preference ignored
 *   - an unknown label        -> warns and renders at the workflow's own size
 *   - the Settings select exists in app.js and the default exists in store.js
 *
 * Run: node tools/image_aspect_setting_test.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

// The Qwen workflow's shape: ResolutionSelector -> EmptyLatentImage width/height.
const WORKFLOW = {
  3: { class_type: 'KSampler', inputs: { seed: 0, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: ['13', 0], height: ['13', 1], batch_size: 1 } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'ala', images: ['8', 0] } },
  13: { class_type: 'ResolutionSelector', inputs: { aspect_ratio: '1:1 (Square)', megapixels: 1, multiple: 8 } },
};

let submits = [], promptCalls = 0;
global.window = {};
window.ala = {
  comfy: {
    http: async ({ url, json = null }) => {
      const u = String(url);
      if (u.endsWith('/system_stats')) return { ok: true, status: 200, json: { system: { name: 'FakeComfy' } } };
      if (u.endsWith('/object_info')) return { ok: true, status: 200, json: {} };
      if (u.endsWith('/prompt')) { promptCalls += 1; submits.push(json.prompt); return { ok: true, status: 200, json: { prompt_id: 'p' + promptCalls } }; }
      const h = u.match(/\/history\/(\S+)$/);
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
const { ComfyDriver } = window;

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };
const eq = (g, w, l) => ok(g === w, `${l} (got ${JSON.stringify(g)}, want ${JSON.stringify(w)})`);
const mk = (o = {}) => new ComfyDriver({ comfy: { serverUrl: 'http://fake:1', workflowsDir: 'x', imageWorkflow: 'wf.json', imagesPerPrompt: 1, ...o } });
async function run(driver, opts = {}) {
  submits = []; promptCalls = 0;
  const logs = [];
  await driver.generate('a girl on a rooftop', opts, (m, k) => logs.push({ m: String(m), k }));
  return { sel: submits[0] && submits[0]['13'].inputs, logs };
}

(async () => {
  const watchdog = setTimeout(() => { console.log('FAIL: harness hung'); process.exit(1); }, 120000);
  console.log('== comfy.imageAspect ==');
  {
    const { sel, logs } = await run(mk());
    eq(sel.aspect_ratio, '1:1 (Square)', 'no preference -> the workflow file\'s aspect stays');
    ok(!logs.some((l) => /Canvas aspect/.test(l.m)), 'no preference -> no canvas-aspect log line');
  }
  {
    const { sel, logs } = await run(mk({ imageAspect: '2:3 (Portrait Photo)' }));
    eq(sel.aspect_ratio, '2:3 (Portrait Photo)', 'preference 2:3 -> ResolutionSelector set to 2:3');
    eq(sel.megapixels, 1, 'megapixels untouched');
    eq(sel.multiple, 8, 'multiple untouched');
    ok(logs.some((l) => /Canvas aspect: 2:3 \(Portrait Photo\) \(your preferred image shape\)/.test(l.m)), 'log names the preferred shape');
  }
  {
    const { sel } = await run(mk({ imageAspect: '2:3 (Portrait Photo)' }), { aspect: '16:9 (Widescreen)' });
    eq(sel.aspect_ratio, '16:9 (Widescreen)', 'a job aspect (comic slot) wins over the preference');
  }
  {
    const { sel, logs } = await run(mk({ imageAspect: 'banana' }));
    eq(sel.aspect_ratio, '1:1 (Square)', 'unknown label -> workflow size kept');
    ok(logs.some((l) => l.k === 'warn' && /unknown aspect/.test(l.m)), 'unknown label -> warning logged');
  }
  {
    // An edit with an attached reference keeps the source's shape: stub staging so the
    // reference counts as attached without a real upload.
    const d = mk({ imageAspect: '2:3 (Portrait Photo)' });
    d.stageReferenceImages = async () => ({ attached: ['r1'], failed: [], skipped: [] });
    const { sel } = await run(d, { matchSource: true, references: [{ id: 'r1', base64: PNG, mime: 'image/png' }] });
    eq(sel.aspect_ratio, '1:1 (Square)', 'edit (matchSource + reference) ignores the preference');
  }
  // UI + default wiring (source checks).
  const app = fs.readFileSync(path.join(APP, 'src', 'renderer', 'app.js'), 'utf8');
  const store = fs.readFileSync(path.join(APP, 'src', 'main', 'store.js'), 'utf8');
  ok(/data-set="comfy\.imageAspect"/.test(app), 'Settings → Generation has the Image shape select');
  ok(/function imageAspectOptions\(/.test(app), 'imageAspectOptions helper exists');
  ok(/imageAspect: '',/.test(store), "store.js default is '' (workflow's own size)");
  clearTimeout(watchdog);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
