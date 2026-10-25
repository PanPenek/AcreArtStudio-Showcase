/**
 * overseer_ltx_video_test.mjs — make_video with the fallback video model (LTX): model choice ('ltx' → comfy.ltxWorkflow,
 * default FastH3), the LTX prompt writer, and TEXT-ONLY clips (no picture → t2v + a Review card from the
 * clip's first frame). Offline: driver, writer and IPC are stubbed (graph/GPU path: tools/ltx_video_test.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
const ok = (cond, what, extra = '') => { if (cond) pass++; else { fail++; console.log('  FAIL ' + what + (extra ? ` — ${extra}` : '')); } };

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const ctx = vm.createContext({
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  JSON, Math, Date, Object, Array, String, Number, Set, Map, RegExp, Promise, Error,
});
ctx.window = ctx;
ctx.globalThis = ctx;
for (const f of ['state.js', 'perchance.js', 'promptstyle.js', 'promptlab.js', 'titles.js', 'comfy.js', 'pipeline.js', 'overseer.js']) {
  new vm.Script(fs.readFileSync(path.join(root, 'src/renderer', f), 'utf8'), { filename: f }).runInContext(ctx);
}
const { State, Overseer } = ctx;
const { DEFAULT_SETTINGS } = require(path.join(root, 'src/main/store.js'));
State.addLog = () => {};
State.persistQueue = () => {};
let persisted = 0;
State.persistLibrary = () => { persisted++; };
State.settings = structuredClone(DEFAULT_SETTINGS);
State.settings.gen.engine = 'comfy';
State.library = [];
State.queue = [];

const deleted = [];
const saved = [];
ctx.ala = {
  settings: { patch: async () => State.settings },
  db: { getOverseer: async () => ({}), setOverseer: async () => true },
  files: {
    readAttachment: async (fname) => { if (fname !== 'ovr-1-aaaa-girl.png') throw new Error('attachment not found'); return { base64: PNG, mime: 'image/png' }; },
    readImageBase64: async () => PNG,
    saveImage: async (b64, ext, hint) => { saved.push({ b64, ext, hint }); return { id: 'newcard1', fname: `${hint}-1.${ext}`, path: `/lib/${hint}-1.${ext}`, url: `ala://img/${hint}-1.${ext}` }; },
  },
  comfy: { deleteVideo: async (f) => { deleted.push(f); }, deleteGif: async (f) => { deleted.push(f); } },
  llm: { chat: async () => ({ text: '{}' }), route: async () => ({ maxConcurrency: 1, vision: true }) },
};

// The real driver and prompt writer are replaced: the GPU path is covered by comfy_subgraph_test --render.
const renders = [];
let renderFails = false;
ctx.ComfyDriver = class { constructor(s) { this.s = s; } async convertToVideo(o) {
  renders.push(o);
  if (renderFails) throw new Error('ComfyUI rejected the video workflow');
  return { fname: 'i2v-1.mp4', url: 'ala://videos/i2v-1.mp4', size: 2 * 1048576, gif: { fname: 'i2v-1.gif', url: 'ala://gifs/i2v-1.gif', size: 5 * 1048576 } };
} };
const writes = [];
ctx.ComfyUI.writeVideoPrompt = async (o) => { writes.push(o); return { prompt: (o.mode === 'hybrid' ? o.userText + '\n\n' : '') + 'She blinks and smiles, slow push-in.' }; };

// A transcript with one attached picture (a1), as the composer saves it.
Overseer.messages = [{ id: 'm1', role: 'user', text: 'make a video of that image', at: Date.now(),
  attachments: [{ id: 'a1', fname: 'ovr-1-aaaa-girl.png', mime: 'image/png', name: 'girl.png', w: 512, h: 768 }] }];

console.log('[1] model choice and text-only refusals');
Overseer._activeKind = 'chat';
Overseer._generateAsked = true;
State.settings.comfy.videoWorkflow = 'FastH3-4step-VSA-I2V.json';
State.settings.comfy.ltxWorkflow = '';
let r = await Overseer.makeVideo({ image: 'a1', model: 'ltx' });
ok(r.ok === false && /no fallback video model/.test(r.error), 'model ltx without an LTX workflow set → clear error', JSON.stringify(r));
r = await Overseer.makeVideo({ instructions: 'a fox in the snow' });
ok(r.ok === false && /name the picture/.test(r.error) && /fallback video model/.test(r.error), 'text-only with no LTX workflow → names the picture + says LTX is needed', JSON.stringify(r));
State.settings.comfy.ltxWorkflow = 'LTX-2.5-Text-and-Reference.json';
r = await Overseer.makeVideo({ instructions: 'a fox in the snow' });
ok(r.ok === false && /model "ltx"/.test(r.error), 'text-only without model ltx → asks for model ltx', JSON.stringify(r));
r = await Overseer.makeVideo({ model: 'ltx' });
ok(r.ok === false && /name the picture/.test(r.error), 'model ltx with nothing at all → still asks for a picture or words', JSON.stringify(r));
ok(renders.length === 0, 'none of those rendered');

console.log('[2] picture + model ltx → the LTX workflow and LTX writer');
r = await Overseer.makeVideo({ image: 'a1', model: 'ltx', instructions: 'she waves' });
ok(r.ok === true && /LTX/.test(r.model), 'ok and reports the LTX model', JSON.stringify(r));
ok(renders[0].workflow === 'LTX-2.5-Text-and-Reference.json' && renders[0].base64 === PNG, 'rendered on the LTX workflow with the picture');
ok(writes[0].model === 'ltx', 'the prompt writer was told ltx');

console.log('[3] default stays FastH3');
renders.length = 0; writes.length = 0;
r = await Overseer.makeVideo({ image: 'a1', instructions: 'she waves' });
ok(r.ok === true && r.model === 'FastH3' && renders[0].workflow === 'FastH3-4step-VSA-I2V.json' && writes[0].model === 'h3', 'no model → FastH3 workflow + H3 writer', JSON.stringify(renders[0] && renders[0].workflow));

console.log('[4] text-only on LTX → t2v render + card from the first frame');
renders.length = 0; writes.length = 0; saved.length = 0;
const before = State.library.length;
const inspected = [];
ctx.ala.comfy.inspectVideo = async (o) => { inspected.push(o); return { fname: o.fname, width: 1280, height: 704, frames: [{ t: 0.1, base64: 'JPEGB64', mime: 'image/jpeg' }] }; };
r = await Overseer.makeVideo({ model: 'ltx', instructions: 'Gojo vs Sukuna in a ruined city', seconds: 10 });
ok(r.ok === true && /text only/.test(r.source), 'ok, source says text only', JSON.stringify(r));
ok(renders.length === 1 && !renders[0].base64 && renders[0].workflow === 'LTX-2.5-Text-and-Reference.json' && renders[0].nameHint === 't2v' && renders[0].seconds === 10, 'rendered with NO picture on the LTX workflow, 10 s');
ok(writes.length === 1 && writes[0].model === 'ltx' && !writes[0].base64 && writes[0].userText === 'Gojo vs Sukuna in a ruined city', 'writer got his words, no picture, model ltx');
ok(inspected.length === 1 && inspected[0].frames === 1 && inspected[0].transcribe === false, 'one frame grabbed from the clip, no transcription');
ok(saved.length === 1 && saved[0].b64 === 'JPEGB64' && saved[0].ext === 'jpg' && saved[0].hint === 'ovr-t2v', 'the first frame became the card still');
const c = State.library[0];
ok(State.library.length === before + 1 && c.theme === 'Overseer text-to-video' && c.status === 'review' && c.qcSkipped === true && c.width === 1280, 'new Review card for the text-only clip');
ok(c.video && c.video.fname === 'i2v-1.mp4' && !c.chatReferences, 'card carries the clip, no chat reference');

console.log('[5] the model is told about LTX');
ok(/model "ltx"/.test(Overseer.TOOLS.make_video.what) && /"model"/.test(Overseer.TOOLS.make_video.args), 'tool description and args mention model ltx');
ok(/fallback video model/.test(Overseer.catalogue()) && /"ltx"/.test(Overseer.catalogue()), 'the catalogue lists the fallback video model');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
