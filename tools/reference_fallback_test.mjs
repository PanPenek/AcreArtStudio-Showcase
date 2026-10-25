/**
 * reference_fallback_test.mjs — reference pictures on a text-only image model.
 *
 *   [1] ComfyUI.routeJobsForReferences — the decision before queueing: ask / always / textonly,
 *       unattended, no usable fallback, cancel; edits, comic jobs and pinned jobs untouched;
 *       nothing to decide when the image workflow takes pictures.
 *   [2] ComfyDriver.generate — an unrouted job with pictures moves to the fallback (uploads,
 *       reports referenceFallback); referenceRoute 'textonly' renders the prompt alone with
 *       byte-less refs even on a picture-taking graph; edits never move; 'textonly' mode.
 *   [3] Overseer — buttons (askReferenceChoice/answerChoice), "always" saves the setting,
 *       Stop cancels, unattended runs never ask, routeSummary wording, and the custom
 *       instructions from Settings land at the end of the system prompt.
 *
 * Offline: real state.js / comfy.js / pipeline.js / overseer.js in a VM, ComfyUI HTTP stubbed.
 *
 *   node tools/reference_fallback_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
const ok = (cond, what, extra = '') => { if (cond) { pass++; console.log('  ok   ' + what); } else { fail++; console.log('  FAIL ' + what + (extra ? ` — ${extra}` : '')); } };
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), what, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'electron') return { net: null, app: { getPath: () => root } };
  // eslint-disable-next-line prefer-rest-params
  return origLoad.apply(this, arguments);
};
const { DEFAULT_SETTINGS } = require(path.join(root, 'src/main/store.js'));
Module._load = origLoad;

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const MOSS = {
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
const QWEN = {
  1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'qwen-image2.1-q4.gguf' } },
  2: { class_type: 'CLIPLoaderGGUF', inputs: { clip_name: 'qwen3vl_8b-Q4_K_M.gguf', type: 'qwen_image' } },
  3: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_2.1_vae_bf16.safetensors' } },
  4: { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['2', 0], prompt: '', negative_prompt: '', resolution: 1024, vae: ['3', 0] } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
  6: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['4', 0], negative: ['4', 1], latent_image: ['5', 0], seed: 0, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
  7: { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['3', 0] } },
  8: { class_type: 'SaveImage', inputs: { filename_prefix: 'Qwen', images: ['7', 0] } },
};
const FILES = { 'MOSS_Fast8_Text.json': MOSS, 'Qwen_Turbo_Text_and_Reference.json': QWEN, 'Broken.json': null };

// ------------------------------------------------------------------ sandbox
const ctx = vm.createContext({
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  JSON, Math, Date, Object, Array, String, Number, Set, Map, RegExp, Promise, Error, structuredClone,
});
ctx.window = ctx;
ctx.globalThis = ctx;
for (const f of ['state.js', 'perchance.js', 'promptstyle.js', 'promptlab.js', 'titles.js', 'comfy.js', 'pipeline.js', 'overseer.js']) {
  new vm.Script(fs.readFileSync(path.join(root, 'src/renderer', f), 'utf8'), { filename: f }).runInContext(ctx);
}
const { State, Pipeline, Overseer, ComfyUI } = ctx;
State.addLog = () => {};
State.persistQueue = () => {};
State.persistLibrary = () => {};
State.bumpStats = () => {};

const settings = () => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.gen.engine = 'comfy';
  Object.assign(s.comfy, {
    serverUrl: 'http://fake:1', workflowsDir: 'wf', imageWorkflow: 'MOSS_Fast8_Text.json',
    referenceFallbackWorkflow: 'Qwen_Turbo_Text_and_Reference.json', referenceFallbackMode: 'ask',
    imagesPerPrompt: 1, maxReferences: 1, promptVariants: 1, launchCommand: '',
  });
  return s;
};
State.settings = settings();

let uploads = 0;
let submits = [];
let promptN = 0;
const patches = [];
ctx.ala = {
  settings: { patch: async (p) => { patches.push(p); if (p.comfy) Object.assign(State.settings.comfy, p.comfy); return State.settings; } },
  comfy: {
    readWorkflow: async ({ file }) => {
      if (!(file in FILES) || FILES[file] === null) throw new Error('no such file ' + file);
      return JSON.parse(JSON.stringify(FILES[file]));
    },
    http: async ({ url, json = null }) => {
      const u = String(url);
      if (u.endsWith('/system_stats')) return { ok: true, status: 200, json: { system: {} } };
      if (u.endsWith('/object_info')) return { ok: true, status: 200, json: {} };
      if (u.endsWith('/upload/image')) { uploads += 1; return { ok: true, status: 200, json: { name: `up${uploads}.png` } }; }
      if (u.endsWith('/prompt')) { promptN += 1; submits.push(json.prompt); return { ok: true, status: 200, json: { prompt_id: 'p' + promptN } }; }
      const h = u.match(/\/history\/(p\d+)/);
      if (h) return { ok: true, status: 200, json: { [h[1]]: { status: { completed: true, status_str: 'success' }, outputs: { 9: { images: [{ filename: h[1] + '.png', subfolder: '', type: 'output' }] }, 8: { images: [{ filename: h[1] + '.png', subfolder: '', type: 'output' }] } } } } };
      if (u.includes('/view?')) return { ok: true, status: 200, base64: PNG, size: 68 };
      throw new Error('unexpected HTTP ' + u);
    },
  },
  files: { readImageBase64: async () => PNG },
  db: { setOverseer: async () => true },
};
const driver = () => Pipeline.genDriver();
const reset = () => { State.settings = settings(); uploads = 0; submits = []; patches.length = 0; Pipeline._comfyDriver = null; };
const job = (extra = {}) => ({ prompt: 'p', referenceIds: ['a1'], ...extra });

// ====================================================================== [1]
console.log('[1] routeJobsForReferences');
{
  reset();
  let asked = 0;
  const jobs = [job(), job(), job({ editOf: 'c1' }), job({ workflow: 'Pinned.json' }), job({ comic: { kind: 'panel' } }), { prompt: 'no refs' }];
  const r = await ComfyUI.routeJobsForReferences(jobs, { driver: driver(), ask: async (plan, n) => { asked = n; return { choice: 'fallback', how: 'asked' }; } });
  eq([r.choice, r.how, r.jobs, asked], ['fallback', 'asked', 2, 2], 'ask → fallback for the 2 eligible jobs');
  eq([jobs[0].workflow, jobs[1].workflow], ['Qwen_Turbo_Text_and_Reference.json', 'Qwen_Turbo_Text_and_Reference.json'], 'eligible jobs are pinned to the fallback');
  eq([jobs[2].workflow, jobs[3].workflow, jobs[4].workflow, jobs[5].workflow], [undefined, 'Pinned.json', undefined, undefined], 'edit, pinned, comic and picture-less jobs untouched');
  eq([r.imageLabel, r.fallbackLabel], ['MOSS Fast8', 'Qwen Turbo'], 'button labels come from the file names');
  eq(State.settings.comfy.imageWorkflow, 'MOSS_Fast8_Text.json', 'the image workflow setting never changes');

  const t = [job()];
  const r2 = await ComfyUI.routeJobsForReferences(t, { driver: driver(), ask: async () => ({ choice: 'textonly' }) });
  eq([r2.choice, t[0].referenceRoute, t[0].workflow], ['textonly', 'textonly', undefined], 'ask → text only stamps referenceRoute');

  const c = [job()];
  const r3 = await ComfyUI.routeJobsForReferences(c, { driver: driver(), ask: async () => ({ choice: 'cancel' }) });
  eq([r3.choice, c[0].referenceRoute, c[0].workflow], ['cancel', undefined, undefined], 'cancel stamps nothing');

  asked = 0;
  const u = [job()];
  const r4 = await ComfyUI.routeJobsForReferences(u, { driver: driver(), unattended: true, ask: async () => { asked++; return { choice: 'textonly' }; } });
  eq([r4.choice, r4.how, asked, u[0].workflow], ['fallback', 'unattended', 0, 'Qwen_Turbo_Text_and_Reference.json'], 'unattended → fallback without asking');

  State.settings.comfy.referenceFallbackMode = 'always';
  const a = [job()];
  const r5 = await ComfyUI.routeJobsForReferences(a, { driver: driver(), ask: async () => { asked++; return { choice: 'textonly' }; } });
  eq([r5.choice, r5.how, asked], ['fallback', 'setting', 0], 'mode always → fallback, no question');

  State.settings.comfy.referenceFallbackMode = 'textonly';
  const x = [job()];
  const r6 = await ComfyUI.routeJobsForReferences(x, { driver: driver(), ask: async () => { asked++; return { choice: 'fallback' }; } });
  eq([r6.choice, r6.how, asked, x[0].referenceRoute], ['textonly', 'setting', 0, 'textonly'], 'mode textonly → text only, no question');

  reset();
  State.settings.comfy.referenceFallbackWorkflow = 'Broken.json';
  const b = [job()];
  const r7 = await ComfyUI.routeJobsForReferences(b, { driver: driver(), ask: async () => { asked++; return { choice: 'fallback' }; } });
  eq([r7.choice, r7.how, asked], ['textonly', 'no-fallback', 0], 'unreadable fallback → text only, no question');
  State.settings.comfy.referenceFallbackWorkflow = '';
  const r7b = await ComfyUI.routeJobsForReferences([job()], { driver: driver(), ask: async () => ({ choice: 'fallback' }) });
  eq([r7b.choice, r7b.how], ['textonly', 'no-fallback'], 'fallback "(none)" → text only');

  reset();
  State.settings.comfy.imageWorkflow = 'Qwen_Turbo_Text_and_Reference.json';
  const q = [job()];
  const r8 = await ComfyUI.routeJobsForReferences(q, { driver: driver(), ask: async () => { asked++; return { choice: 'textonly' }; } });
  eq([r8, q[0].workflow, q[0].referenceRoute], [null, undefined, undefined], 'a picture-taking image workflow → nothing to decide');
}

// ====================================================================== [2]
console.log('[2] ComfyDriver.generate');
{
  reset();
  const refs = [{ id: 'a1', base64: PNG, mime: 'image/png' }];
  const logs = [];
  const r = await driver().generate('A woman like <image1>.', { references: refs, count: 1 }, (m) => logs.push(m));
  ok(r.referenceFallback === 'Qwen_Turbo_Text_and_Reference.json' && r.workflowUsed === 'Qwen_Turbo_Text_and_Reference.json', 'unrouted job with pictures renders on the fallback', JSON.stringify({ f: r.referenceFallback, u: r.workflowUsed }));
  ok(uploads === 1 && r.referenceResult.attached.length === 1, 'its picture is uploaded and attached', `${uploads} ${JSON.stringify(r.referenceResult)}`);
  ok(submits[0] && Object.values(submits[0]).some((n) => n.class_type === 'TextEncodeQwenImage21'), 'the submitted graph is the fallback graph');
  ok(logs.some((l) => /reference fallback/.test(l)), 'the job log says it moved');

  reset();
  State.settings.comfy.referenceFallbackMode = 'textonly';
  const r2 = await driver().generate('A woman like <image1>.', { references: refs, count: 1 }, () => {});
  ok(!r2.referenceFallback && uploads === 0 && r2.referenceResult.textOnly, 'mode textonly: stays on the image workflow, nothing uploaded', JSON.stringify(r2.referenceResult));

  reset();
  State.settings.comfy.imageWorkflow = 'Qwen_Turbo_Text_and_Reference.json';
  const r3 = await driver().generate('A woman like <image1>.', { references: [{ id: 'a1' }], count: 1, referenceRoute: 'textonly' }, () => {});
  ok(uploads === 0 && r3.referenceResult.textOnly && /chose text only/.test(r3.referenceResult.skipped[0].error), 'referenceRoute textonly: byte-less refs, no upload, even on a picture-taking graph', JSON.stringify(r3.referenceResult));
  eq(submits[0]['4'].inputs.prompt, 'A woman.', '<image1> marker stripped from the prompt');

  reset();
  let err = null;
  try { await driver().generate('Edit <image1>.', { references: refs, count: 1, matchSource: true }, () => {}); } catch (e) { err = e; }
  // An edit needs its picture, so on a text-only image workflow it now
  // MOVES to the edit-capable fallback (it used to throw and fail 3× in the queue).
  ok(!err && submits.length === 1 && uploads === 1, 'an edit on the text-only workflow moves to the edit-capable fallback', err && err.message);

  reset();
  const r4 = await driver().generate('A woman like <image1>.', { references: refs, count: 1, workflow: 'MOSS_Fast8_Text.json' }, () => {});
  ok(!r4.referenceFallback && uploads === 0, 'a job pinned to a workflow is never moved');
}

// ====================================================================== [3]
console.log('[3] Overseer');
{
  reset();
  Overseer._activeKind = 'chat';
  Overseer._abort = false;
  Overseer.messages = [];
  const jobs = [job(), job()];
  const pending = Overseer.routeReferenceJobs(jobs);
  await new Promise((r) => setTimeout(r, 30));
  const pc = Overseer.pendingChoice;
  ok(pc && pc.buttons.length === 3 && /MOSS Fast8 can't use reference pictures/.test(pc.text), 'buttons wait in the chat', JSON.stringify(pc));
  eq(pc && pc.buttons.map((b) => b.key), ['fallback', 'textonly', 'always'], 'fallback first (it is also the no-answer default)');
  await Overseer.answerChoice('textonly');
  const r = await pending;
  eq([r.choice, r.how, jobs[0].referenceRoute, Overseer.pendingChoice], ['textonly', 'asked', 'textonly', null], 'a click answers it');
  ok(Overseer.messages.some((m) => m.role === 'note' && /from the prompt alone/.test(m.text)), 'a note row records the choice');
  ok(/NOT attached/.test(Overseer.routeSummary(r)), 'routeSummary says the pictures are not attached');

  const j2 = [job()];
  const p2 = Overseer.routeReferenceJobs(j2);
  await new Promise((r) => setTimeout(r, 30));
  await Overseer.answerChoice('always');
  const r2 = await p2;
  eq([r2.choice, j2[0].workflow, State.settings.comfy.referenceFallbackMode], ['fallback', 'Qwen_Turbo_Text_and_Reference.json', 'always'], '"Always" saves the setting and uses the fallback');
  ok(/SEE the pictures/.test(Overseer.routeSummary(r2)) && /setting is unchanged/.test(Overseer.routeSummary(r2)), 'routeSummary for the fallback');

  State.settings.comfy.referenceFallbackMode = 'ask';
  const j3 = [job()];
  const p3 = Overseer.routeReferenceJobs(j3);
  await new Promise((r) => setTimeout(r, 30));
  Overseer._abort = true;
  const r3 = await p3;
  Overseer._abort = false;
  eq([r3.choice, j3[0].workflow, j3[0].referenceRoute, Overseer.pendingChoice], ['cancel', undefined, undefined, null], 'Stop while asking → cancel, nothing stamped');

  Overseer._activeKind = 'agent';
  const j4 = [job()];
  const r4 = await Overseer.routeReferenceJobs(j4);
  eq([r4.choice, r4.how, Overseer.pendingChoice], ['fallback', 'unattended', null], 'an unattended run never asks');
  Overseer._activeKind = 'chat';

  // custom instructions
  State.settings.overseer.customInstructions = 'Talk like a pirate. Always make 6 per prompt.';
  const sp = Overseer.systemPrompt('chat', 'json');
  ok(/HIS INSTRUCTIONS FOR YOU[\s\S]*Talk like a pirate\. Always make 6 per prompt\./.test(sp), 'custom instructions are in the system prompt');
  ok(sp.lastIndexOf('Talk like a pirate') > sp.lastIndexOf('HARD LIMITS'), 'they come after the app rules (so they win)');
  ok(/HIS INSTRUCTIONS FOR YOU/.test(Overseer.systemPrompt('agent', 'native')), 'unattended runs get them too');
  State.settings.overseer.customInstructions = '   ';
  ok(!/HIS INSTRUCTIONS FOR YOU/.test(Overseer.systemPrompt('chat', 'json')), 'blank instructions add nothing');
  State.settings.overseer.customInstructions = 'x'.repeat(9000);
  const long = Overseer.systemPrompt('chat', 'json');
  ok(long.includes('x'.repeat(4000)) && !long.includes('x'.repeat(4001)), 'capped at 4000 characters');
  eq([DEFAULT_SETTINGS.overseer.customInstructions, DEFAULT_SETTINGS.comfy.referenceFallbackMode, DEFAULT_SETTINGS.comfy.referenceFallbackWorkflow],
    ['', 'auto', ''], 'store.js defaults');
}

// ====================================================================== [4] source wiring
console.log('[4] wiring');
{
  const ov = fs.readFileSync(path.join(root, 'src/renderer/overseer.js'), 'utf8');
  eq((ov.match(/const route = await this\.routeReferenceJobs\(jobs, this\.wantsReferenceInput\(useReferenceImage\)\);/g) || []).length, 2, 'queue_art and queue_research_prompts both route before insertJobs');
  const app = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  ok(/data-set="overseer\.customInstructions"/.test(app) && /data-set="comfy\.referenceFallbackMode"/.test(app) && /id="sel-comfy-reffb"/.test(app), 'Settings → Overseer has the new fields');
  ok(/\['#sel-comfy-reffb', s\.comfy\?\.referenceFallbackWorkflow\]/.test(app), 'the fallback dropdown is filled from the workflows folder');
  const ui = fs.readFileSync(path.join(root, 'src/renderer/overseerui.js'), 'utf8');
  ok(/data-ov-choice/.test(ui) && /answerChoice\(choice\.dataset\.ovChoice\)/.test(ui), 'overseerui renders and wires the buttons');
  const pl = fs.readFileSync(path.join(root, 'src/renderer/pipeline.js'), 'utf8');
  ok(/referenceRoute: job\.referenceRoute \|\| ''/.test(pl), 'the pipeline passes the job route to the driver');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
