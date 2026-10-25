/**
 * edit_routing_test.mjs — a text-only image workflow (MOSS-Image) and picture edits.
 *
 * An edit needs its picture, so it renders on the image workflow when that one can edit, else on
 * the Image Edit workflow, else on the reference fallback. New pictures with references render
 * text only unless he asks to use the reference picture as the input ('auto' mode).
 *
 *   [1] routeJobsForReferences mode 'auto' (default): text only, fallback only on wantsPicture
 *   [2] ComfyDriver.editRoute order + generate() edits move; unrouted auto jobs stay text-only
 *   [3] Overseer.wantsReferenceInput phrasing (negations never count)
 *   [4] Overseer.editImage: whole batch in one call, cardIds, refusal with nothing queued
 *
 * Offline: real state.js / comfy.js / pipeline.js / overseer.js in a VM, ComfyUI HTTP stubbed.
 *   node tools/edit_routing_test.mjs
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
const FILES = { 'MOSS_Fast8_Text.json': MOSS, 'Qwen_Turbo_Text_and_Reference.json': QWEN, 'Edit_Text_and_Reference.json': QWEN, 'Broken.json': null };

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
    referenceFallbackWorkflow: 'Qwen_Turbo_Text_and_Reference.json', referenceFallbackMode: 'auto',
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
console.log('[1] auto mode (default)');
{
  reset();
  eq(DEFAULT_SETTINGS.comfy.referenceFallbackMode, 'auto', 'the shipped mode is auto');
  let asked = 0;
  const ask = async () => { asked++; return { choice: 'fallback' }; };
  const t = [job()];
  const r = await ComfyUI.routeJobsForReferences(t, { driver: driver(), ask });
  eq([r.choice, r.how, asked, t[0].referenceRoute, t[0].workflow], ['textonly', 'default', 0, 'textonly', undefined], 'no words → text only, never asks');
  const w = [job()];
  const r2 = await ComfyUI.routeJobsForReferences(w, { driver: driver(), ask, wantsPicture: true });
  eq([r2.choice, r2.how, asked, w[0].workflow], ['fallback', 'words', 0, 'Qwen_Turbo_Text_and_Reference.json'], 'he asked for the picture as input → fallback, no question');
  const u = [job()];
  const r3 = await ComfyUI.routeJobsForReferences(u, { driver: driver(), unattended: true, ask });
  eq([r3.choice, asked], ['textonly', 0], 'unattended run in auto → text only');
  Overseer._activeKind = 'chat';
  Overseer.messages = [];
  const o = [job()];
  const r4 = await Overseer.routeReferenceJobs(o, false);
  eq([r4.choice, Overseer.pendingChoice], ['textonly', null], 'Overseer: no buttons in auto');
  ok(/did not ask for the picture as the input/.test(Overseer.routeSummary(r4)), 'routeSummary says why it is text only', Overseer.routeSummary(r4));
  const r5 = await Overseer.routeReferenceJobs([job()], true);
  ok(r5.choice === 'fallback' && /asked for the picture as the input/.test(Overseer.routeSummary(r5)), 'Overseer: wantsPicture → fallback with the reason', Overseer.routeSummary(r5));
}

// ====================================================================== [2]
console.log('[2] editRoute + generate');
{
  reset();
  const d = driver();
  let er = await d.editRoute();
  eq([er.file, er.from], ['Qwen_Turbo_Text_and_Reference.json', 'fallback'], 'MOSS + no Image Edit pick → the reference fallback');
  State.settings.comfy.editWorkflow = 'Edit_Text_and_Reference.json';
  er = await d.editRoute();
  eq([er.file, er.from], ['Edit_Text_and_Reference.json', 'edit'], 'the Image Edit tab pick comes before the fallback');
  State.settings.comfy.imageWorkflow = 'Qwen_Turbo_Text_and_Reference.json';
  er = await d.editRoute();
  eq([er.file, er.from], ['Qwen_Turbo_Text_and_Reference.json', 'image'], 'an image workflow that can edit is used first (his default model wins)');
  reset();
  State.settings.comfy.referenceFallbackWorkflow = '';
  er = await driver().editRoute();
  ok(er.file === null && /text-only/.test(er.reason), 'nothing edit-capable → file null with a reason', JSON.stringify(er));

  reset();
  State.settings.comfy.editWorkflow = 'Edit_Text_and_Reference.json';
  const refs = [{ id: 'card-x', base64: PNG, mime: 'image/png' }];
  const logs = [];
  const g = await driver().generate('Edit <image1>. Give her a red scarf.', { references: refs, count: 1, matchSource: true }, (m) => logs.push(m));
  ok(g.workflowUsed === 'Edit_Text_and_Reference.json' && g.referenceFallback === 'Edit_Text_and_Reference.json', 'an edit on MOSS renders on the edit workflow', JSON.stringify({ u: g.workflowUsed, f: g.referenceFallback }));
  ok(uploads === 1 && g.referenceResult.attached.length === 1, 'the source picture is attached');
  ok(Object.values(submits[0]).some((n) => n.class_type === 'TextEncodeQwenImage21' && /Edit <image1>/.test(n.inputs.prompt)), 'the edit prompt keeps its <image1> marker on the reference graph');
  ok(logs.some((l) => /this edit renders on/.test(l)), 'the job log says where the edit went');

  reset();
  const g2 = await driver().generate('A woman like <image1>.', { references: refs, count: 1 }, () => {});
  ok(!g2.referenceFallback && uploads === 0 && g2.referenceResult.textOnly, 'auto: an unrouted new picture stays on MOSS, nothing uploaded', JSON.stringify(g2.referenceResult));
  eq(submits[0]['4'].inputs.text, 'A woman.', 'and its <image1> marker is stripped');
  reset();
  State.settings.comfy.referenceFallbackMode = 'ask';
  const g3 = await driver().generate('A woman like <image1>.', { references: refs, count: 1 }, () => {});
  ok(g3.referenceFallback === 'Qwen_Turbo_Text_and_Reference.json', "mode 'ask' keeps the old unrouted fallback");
}

// ====================================================================== [3]
console.log('[3] wantsReferenceInput');
{
  const yes = ['use the reference image as input', 'make 2 more and use i1 as the base', 'queue it with the reference',
    'img2img this one', 'use the fallback for these', 'attach the ref this time', 'Use the reference picture as an input please'];
  const no = ['make one more prompt, and que', "don't use the reference", 'edit last batch and give them hats',
    'without the reference picture', 'make her look like the reference', 'good, but make her shy', 'use just one reference'];
  for (const s of yes) { Overseer._requestText = s; Overseer.messages = []; ok(Overseer.wantsReferenceInput() === true, `yes: "${s}"`); }
  for (const s of no) { Overseer._requestText = s; Overseer.messages = []; ok(Overseer.wantsReferenceInput() === false, `no: "${s}"`); }
  Overseer._requestText = 'make two more';
  Overseer.messages = [{ role: 'user', text: 'use the reference image as input from now on' }, { role: 'agent', text: 'ok' }, { role: 'user', text: 'make two more' }];
  ok(Overseer.wantsReferenceInput() === true, 'said in one of his last three messages still counts');
  Overseer.messages = [];
  Overseer._requestText = 'whatever';
  eq([Overseer.wantsReferenceInput(true), Overseer.wantsReferenceInput('false')], [true, false], 'the model\'s useReferenceImage flag wins');
}

// ====================================================================== [4]
console.log('[4] editImage');
{
  reset();
  Pipeline.start = () => { Pipeline.running = true; };
  Pipeline.running = false;
  Overseer._activeKind = 'helper';
  Overseer._generateAsked = true;
  Overseer._abort = false;
  Overseer.messages = [];
  const saved = [];
  ctx.ala.files.saveAttachment = async (b64, mime, name) => { saved.push(name); return { fname: `ovr-${saved.length}.png`, mime: 'image/png' }; };
  const cards = Array.from({ length: 6 }, (_, i) => ({ id: `179277159090${i}-c${i}`, fname: `c${i}.png`, mime: 'image/png', batchId: 'bmoss', status: 'review', promptSource: 'overseer', theme: 'Omi reclining', createdAt: 1000 + i }));
  State.library = [...cards];
  State.queue = [];
  const r = await Overseer.editImage({ fromBatch: 'bmoss', instruction: 'Give her a red scarf and a winter coat.' });
  eq([r.ok, r.queued, r.pictures], [true, 6, 6], 'fromBatch of 6 → 6 edits in ONE call', JSON.stringify(r));
  const jobs = State.queue.filter((j) => j.batchId === r.batchId);
  eq(jobs.length, 6, 'six jobs share one batchId');
  ok(jobs.every((j, i) => j.editOf === `card-${cards[i].id}` && j.count === 1 && j.referenceIds.length === 1 && j.chatReferences[0].id === `card-${cards[i].id}`), 'each job edits its own card, one picture each');
  ok(r.editWorkflow === 'Qwen_Turbo_Text_and_Reference.json' && /text-only/.test(r.note) && /reference fallback/.test(r.note), 'the receipt names where the edits render', r.note);
  ok(!jobs.some((j) => j.workflow), 'jobs are not pinned (the driver decides at render time)');

  State.queue = [];
  const r2 = await Overseer.editImage({ cardIds: [cards[0].id, `card-${cards[1].id}`], instruction: 'add falling snow' });
  eq([r2.ok, r2.queued], [true, 2], 'cardIds (bare or card-…) → one edit each', JSON.stringify(r2));

  State.queue = [];
  const r3 = await Overseer.editImage({ cardId: cards[2].id, instruction: 'add falling snow' });
  eq([r3.ok, r3.queued, State.queue.length], [true, 1, 1], 'a single cardId still makes one edit');

  State.queue = [];
  State.settings.comfy.referenceFallbackWorkflow = '';
  Pipeline._comfyDriver = null;
  const r4 = await Overseer.editImage({ fromBatch: 'bmoss', instruction: 'add falling snow' });
  ok(r4.ok === false && /cannot edit/.test(r4.error) && State.queue.length === 0, 'no edit-capable workflow → refused, nothing queued', JSON.stringify(r4));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
