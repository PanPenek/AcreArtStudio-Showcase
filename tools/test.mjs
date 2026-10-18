/**
 * tools/test.mjs: offline unit tests for the app.  Run: npm test
 *
 * No Electron, no network, no GPU, no AI model. Each test loads the REAL module file
 * from src/renderer into an isolated Node VM (the same way the browser would run it,
 * as a plain script attached to `window`) and checks its behaviour directly.
 *
 * Covered:
 *   - promptstyle.js  : the quality tail every prompt must end with
 *   - state.js (U)    : JSON is recovered from chatty / slightly broken LLM answers
 *   - titles.js       : near-duplicate titles are detected, different ones are not
 *   - comiclayout.js  : panel geometry and text wrapping for comic pages
 *   - triage.js       : contact-sheet layout and parsing of the AI's pick
 *   - imageedit.js    : brushed areas in words, repairs from QC findings, edit vs re-render
 *   - comfy.js        : image edits keep the source picture's size
 *   - navorder.js     : the saved sidebar order, with new tabs slotted in
 *   - teach.js        : pictures marked good feed the playbook; forgetting one removes its lessons
 *   - pipeline.js     : a disputed QC veto goes to Review, a confirmed one does not
 *   - comfyfind.js    : an installed ComfyUI (Comfy Desktop, portable) is found on disk
 *   - videomerge.js   : the timeline of a clip that runs through several pictures
 *   - models.js       : which image model made a picture
 *   - imageedit.js    : a character remake is described in words, not pasted
 *   - promptstyle.js  : tag-list fragments are dropped from plain-sentence prompts
 *   - comfy.js        : FLUX.3 Image Klein graphs take reference pictures (workflows/ + a node-schema fixture)
 *   - imageedit.js    : the Image Edit tab's workflow picker
 *   - overseer.js     : queue_art takes library cards (or a batch's best pictures) as references
 */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
// Note: values created inside the VM have their own Array/Object prototypes, so
// structured results are compared as JSON rather than with deepEqual.

const root = new URL('../src/renderer/', import.meta.url);

/** Load renderer modules (in order) into one fresh sandbox and return its `window`.
 *  An optional first argument object adds extra globals (e.g. a stub `document`). */
function load(...files) {
  const extra = typeof files[0] === 'object' ? files.shift() : {};
  const sandbox = { console, setTimeout, clearTimeout, structuredClone, URL, TextEncoder, TextDecoder, atob, btoa, ...extra };
  sandbox.window = sandbox;
  sandbox.window.ala = {};          // the preload bridge; unused by the pure functions tested here
  vm.createContext(sandbox);
  for (const f of files) vm.runInContext(fs.readFileSync(new URL(f, root), 'utf8'), sandbox, { filename: f });
  return sandbox;
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('promptstyle.js');
{
  const w = load('state.js', 'promptstyle.js');
  const prof = { enough: false, tail: [] };   // no learned style yet: only the built-in quality tail
  test('appends the missing quality guards to a prompt', () => {
    const out = w.PromptStyle.enforceTail('a lighthouse keeper on a stormy cliff, lantern glow', prof);
    assert.ok(out.endsWith('no extra fingers, no extra limbs'), out);
  });
  test('does not repeat guards that are already there', () => {
    const src = 'a fox spirit in a forest, no extra fingers, no extra limbs';
    assert.equal(w.PromptStyle.enforceTail(src, prof), src);
  });
  test('leaves an empty prompt empty', () => assert.equal(w.PromptStyle.enforceTail('  ', prof), ''));
}

console.log('state.js');
{
  const { U } = load('state.js');
  test('extracts JSON wrapped in prose and code fences', () => {
    const v = U.extractJson('Sure! Here you go:\n```json\n{"title": "Lantern Walk", "tags": ["night"]}\n```\nEnjoy.');
    assert.equal(v.title, 'Lantern Walk');
  });
  test('finds every JSON value in a reply, in order', () => {
    const all = U.jsonCandidates('first {"a":1} then [2,3]');
    assert.equal(JSON.stringify(all.map((c) => c.value)), '[{"a":1},[2,3]]');
  });
  test('recognises an image prompt vs. a sentence about one', () => {
    assert.equal(U.looksLikePrompt('a lighthouse keeper on a stormy cliff, rain-wet coat, lantern glow, wide shot, painted anime'), true);
    assert.equal(U.looksLikePrompt('I should write the prompt about the lighthouse now, however the artist wants JSON'), false);
  });
  test('strips a medium-naming opener from a prompt', () => {
    const out = U.housePrompt('Anime illustration of a lighthouse keeper on a stormy cliff at night, lantern glow');
    assert.ok(!/^anime illustration/i.test(out), out);
  });
}

console.log('titles.js');
{
  const w = load('titles.js');
  const sim = (a, b) => w.Titles.similarity(a, b);
  test('identical titles score 1', () => assert.equal(sim('Moonlit Harbour', 'Moonlit Harbour'), 1));
  test('near-duplicates score high ("Moonlight" vs "Moonlit")', () => assert.ok(sim('Moonlight Harbour', 'Moonlit Harbour') >= 0.5));
  test('unrelated titles score low', () => assert.ok(sim('Moonlit Harbour', 'The Clockmaker\'s Cat') < 0.3));
}

console.log('comiclayout.js');
{
  const { ComicLayout: L } = load('comiclayout.js');
  test('auto layout creates one rect per panel', () => {
    for (const n of [1, 2, 3, 4, 5, 6]) assert.equal(L.layoutFor('auto', n).rects.length, n);
  });
  test('panel boxes stay inside the page', () => {
    const geom = { width: 1400, height: 1800, margin: 40, gutter: 20 };
    for (const b of L.panelBoxes(L.layoutFor('auto', 4), geom)) {
      assert.ok(b.x >= 40 && b.y >= 40 && b.x + b.w <= 1360 && b.y + b.h <= 1760, JSON.stringify(b));
    }
  });
  test('word wrap never exceeds the width', () => {
    const measure = (s) => s.length * 10;
    const lines = L.wrapText('the quick brown fox jumps over the lazy dog again and again', 120, measure);
    assert.ok(lines.length > 1 && lines.every((l) => measure(l) <= 120), JSON.stringify(lines));
  });
}

console.log('triage.js');
{
  const w = load('state.js', 'triage.js');
  test('contact sheet grid fits the tile count', () => {
    for (const n of [1, 2, 3, 4, 6, 9]) {
      const s = w.Triage.sheetLayout(n);
      assert.ok(s.cols * s.rows >= n);
    }
  });
  test('parses the AI pick and ignores out-of-range tiles', () => {
    const r = w.Triage.parsePick('{"tiles":[{"n":1,"verdict":"clean"},{"n":9,"verdict":"clean"}],"best":1,"keep":[1,9]}', 4);
    assert.equal(r.best, 1);
    assert.equal(JSON.stringify(r.keep), '[1]');
    assert.equal(r.tiles[1].verdict, 'clean');
  });
}

console.log('imageedit.js');
{
  const w = load('state.js', 'comfy.js', 'imageedit.js');
  const E = w.ImageEdit;
  test('a brushed box becomes words in the instruction', () => {
    assert.equal(E.locationPhrase({ x: 0, y: 0, w: 100, h: 100 }, 900, 900), 'top-left area of the picture');
    assert.equal(E.locationPhrase({ x: 400, y: 400, w: 100, h: 100 }, 900, 900), 'centre of the picture');
    assert.equal(E.locationPhrase({ x: 0, y: 0, w: 900, h: 800 }, 900, 900), 'most of the picture');
    assert.equal(E.regionInstruction('Make the lantern glow blue.', { x: 800, y: 0, w: 90, h: 90 }, 900, 900),
      'in the top-right area of the picture: make the lantern glow blue');
  });
  test('a repair is built from the QC findings', () => {
    const card = { qc: { detail: [{ what: 'Fused fingers', where: 'left hand' }], fix: 'Separate the fingers.' } };
    const t = E.fixInstruction('auto', card);
    assert.ok(t.startsWith('Fix these flaws: Fused fingers (left hand)') && /separate the fingers/.test(t), t);
    assert.equal(E.fixInstruction('auto', { qc: {} }), '');
    assert.ok(E.fixPrompt('fix the hands').startsWith('Repair <image1>.'));
  });
  test('local damage is edited, a broken body is re-rendered', () => {
    const route = (what, gates = []) => E.fixRoute({ qc: { score: 4, detail: [{ what, where: '' }], gates: { failed: gates } } }).mode;
    assert.equal(route('Fused fingers on the raised hand'), 'edit');
    assert.equal(route('Left arm merges into the torso with no elbow'), 'rerender');
    assert.equal(route('Smeared lettering on the sign'), 'edit');
    assert.equal(route('Blurry background', ['limbs', 'face']), 'rerender');
  });
  test('the size warning only appears when the sizes differ', () => {
    assert.equal(E.sizeWarning({ w: 1024, h: 1024 }, { width: 1024, height: 1024 }), null);
    assert.ok(/512×768/.test(E.sizeWarning({ w: 512, h: 768 }, { width: 1024, height: 1024 })));
  });
}

console.log('comfy.js (edit size)');
{
  const C = load('state.js', 'comfy.js').ComfyUI;
  test('the Qwen edit canvas follows the source aspect', () => {
    assert.equal(JSON.stringify(C.qwenEditCanvas({ w: 512, h: 768 }, 1024)), '{"width":832,"height":1248}');
    assert.equal(JSON.stringify(C.qwenEditCanvas({ w: 1024, h: 1024 }, 1024)), '{"width":1024,"height":1024}');
  });
  test('an edit samples on the encoder latent and is scaled back to the source size', () => {
    const nodes = {
      enc: { classType: 'TextEncodeQwenImage21', inputs: { resolution: 1024, 'images.image_1': ['ref', 0] } },
      ref: { classType: 'LoadImage', inputs: { image: 'a.png' } },
      lat: { classType: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
      ks: { classType: 'KSampler', inputs: { latent_image: ['lat', 0], positive: ['enc', 0], seed: 1 } },
      dec: { classType: 'VAEDecode', inputs: { samples: ['ks', 0] } },
      save: { classType: 'SaveImage', inputs: { images: ['dec', 0] } },
    };
    const m = C.matchEditSize(nodes, { w: 512, h: 768 });
    assert.ok(m.ok && m.scaled, JSON.stringify(m));
    assert.equal(JSON.stringify(nodes.ks.inputs.latent_image), '["enc",2]');
    const scale = nodes[nodes.save.inputs.images[0]];
    assert.equal(scale.classType, 'ImageScale');
    assert.equal(`${scale.inputs.width}x${scale.inputs.height}`, '512x768');
  });
}

console.log('navorder.js');
{
  const doc = { getElementById: () => null, querySelectorAll: () => [] };
  const w = load({ document: doc, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } }, 'navorder.js');
  test('a saved order keeps new tabs next to their neighbour', () => {
    const shipped = ['dashboard', 'review', 'imageedit', 'drafts', 'settings'];
    assert.equal(w.NavOrder.merge(shipped, ['settings', 'drafts', 'review', 'dashboard']).join(),
      'settings,drafts,review,imageedit,dashboard');
    assert.equal(w.NavOrder.merge(shipped, ['gone', 'review', 'review']).join(), 'dashboard,review,imageedit,drafts,settings');
    assert.equal(w.NavOrder.merge(shipped, null).join(), shipped.join());
  });
}

console.log('teach.js');
{
  const w = load({ Insights: { playbook: null, persistPlaybook() {} } }, 'teach.js');
  w.U = { uid: (() => { let n = 0; return () => 'u' + (++n); })() };
  test('a good example adds its lessons and reaches the guidance block', () => {
    const ex = w.Teach.addExample({ cardId: 'c1', fname: 'a.png', note: 'the window light', summary: 'soft window light portrait',
      traits: ['warm rim light'], lessons: [{ text: 'Light the subject from a window behind them', why: 'rim light' }] });
    const m = w.Teach.manual();
    assert.equal(m.examples.length, 1);
    assert.equal(m.lessons.filter((l) => l.exampleId === ex.id).length, 1);
    const block = w.Teach.block();
    assert.ok(block.includes('Light the subject from a window behind them'), block);
    assert.ok(block.includes('marked GOOD') && block.includes('the window light'), block);
    assert.equal(w.Teach.isEmpty(), false);
  });
  test('marking the same picture again replaces it; forgetting it removes its lessons', () => {
    w.Teach.addExample({ cardId: 'c1', fname: 'a.png', lessons: [{ text: 'second reading' }] });
    let m = w.Teach.manual();
    assert.equal(m.examples.length, 1);
    assert.equal(JSON.stringify(m.lessons.map((l) => l.text)), '["second reading"]');
    w.Teach.removeExample(m.examples[0].id);
    m = w.Teach.manual();
    assert.equal(m.examples.length + m.lessons.length, 0);
  });
}

console.log('pipeline.js (QC veto)');
{
  const gen = { passThreshold: 7, qcVeto: true, qcConfirmVeto: true, qcGeneralPass: true, qcMetrics: false };
  const w = load({ State: { settings: { gen, metadata: {}, comfy: {} }, library: [] }, document: { createElement: () => ({}) } },
    'state.js', 'pipeline.js');
  w.State.settings = { gen, metadata: {}, comfy: {} };
  w.State.library = [];
  const P = w.Pipeline;
  const qc = (score, verdict, defects, fingerCounts = '') => ({ score, verdict, defects, fingerCounts, regions: [], notes: '', fix: '', scene: '' });
  const fused = [{ what: 'fingers fused into a smooth shape', where: 'right hand', severity: 'noticeable' }];
  test('a veto on an inspector FAIL at 5 gets a second look; a 4 or a severe defect does not', () => {
    assert.equal(P.vetoNeedsConfirmation(qc(5, 'FAIL', fused)), true);
    assert.equal(P.vetoNeedsConfirmation(qc(8, 'PASS', fused)), true);
    assert.equal(P.vetoNeedsConfirmation(qc(4, 'FAIL', fused)), false);
    assert.equal(P.vetoNeedsConfirmation(qc(6, 'FAIL', [{ what: 'fingers fused', severity: 'severe' }])), false);
    assert.equal(P.vetoNeedsConfirmation(qc(5, 'FAIL', [{ what: 'background slightly soft' }])), false);
  });
  const clean = { gates: { hands: 'YES', limbs: 'YES', no_merges: 'YES', face: 'YES', detail: 'YES' }, overall: 8, worst: 'nothing' };
  const broken = { gates: { hands: 'NO', limbs: 'YES', no_merges: 'YES', face: 'YES', detail: 'YES' }, overall: 5, worst: 'fused hand' };
  test('a second look that finds the hands clean marks the card disputed (Review, not the bin)', () => {
    const card = {};
    const pass = P.applyQcResult(card, qc(5, 'FAIL', fused), { gateRole: 'confirm-veto', gates: clean });
    assert.equal(pass, false);
    assert.equal(card.qc.disputed, true);
    assert.equal(card.qc.veto.checked, 'disputed');
    assert.equal(card.qc.verdict, 'FAIL');
  });
  test('a second look that agrees keeps the veto, and the card is not disputed', () => {
    const card = {};
    P.applyQcResult(card, qc(5, 'FAIL', fused), { gateRole: 'confirm-veto', gates: broken });
    assert.equal(card.qc.disputed, undefined);
    assert.equal(card.qc.score, 4);
    assert.equal(card.qc.veto.checked, 'confirmed');
  });
}

console.log('comfyfind.js');
{
  const { createRequire } = await import('node:module');
  const os = await import('node:os');
  const path = await import('node:path');
  const req = createRequire(import.meta.url);
  const F = req('../src/main/comfyfind.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acre-comfyfind-'));
  try {
    const appData = path.join(tmp, 'Roaming');
    const home = path.join(tmp, 'home');
    const inst = path.join(tmp, 'Installs', 'ComfyUI_me');
    const wf = path.join(inst, 'ComfyUI', 'user', 'default', 'workflows');
    fs.mkdirSync(wf, { recursive: true });
    fs.writeFileSync(path.join(wf, 'AcreArtStudio_Qwen-Image-2.1_Q8.json'), '{}');
    fs.mkdirSync(path.join(appData, 'Comfy Desktop', 'comfy-procs'), { recursive: true });
    fs.writeFileSync(path.join(appData, 'Comfy Desktop', 'installations.json'), JSON.stringify([
      { id: 'i1', name: 'ComfyUI_me', installPath: inst, sourceId: 'standalone', lastLaunchedAt: 5 },
      { id: 'i2', name: 'Comfy Cloud', sourceId: 'cloud', remoteUrl: 'https://cloud.comfy.org/' }]));
    fs.writeFileSync(path.join(appData, 'Comfy Desktop', 'comfy-procs', 'i1.json'), JSON.stringify({ port: 8189 }));
    const portable = path.join(home, 'ComfyUI_windows_portable', 'ComfyUI');
    fs.mkdirSync(path.join(portable, 'comfy'), { recursive: true });
    fs.writeFileSync(path.join(portable, 'main.py'), '');
    test('Comfy Desktop installs are found with their own port; a workflow-holding folder ranks first', () => {
      const r = F.findComfyInstalls({ appData, home, drives: [] });
      assert.equal(r[0].workflowsDir, wf);
      assert.equal(r[0].workflows, 1);
      assert.equal(JSON.stringify(r[0].serverUrls), '["http://127.0.0.1:8189"]');
      assert.ok(r.some((x) => x.root === portable && !x.exists), 'portable root without a user folder is still offered');
      assert.ok(!r.some((x) => /cloud/i.test(x.label)));
    });
    test("the studio's bundled workflow is preselected, anyone else's is not", () => {
      assert.equal(F.pickBundled(['x.json', 'AcreArtStudio_Qwen-Image-2.1_Q4.json'], 'image'), 'AcreArtStudio_Qwen-Image-2.1_Q4.json');
      assert.equal(F.pickBundled(['x.json'], 'image'), null);
      assert.equal(F.pickBundled(['AcreArtStudio_FastH3_Video.json'], 'video'), 'AcreArtStudio_FastH3_Video.json');
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('videomerge.js');
{
  const w = load('videomerge.js');
  const VM = w.VideoMerge;
  test('pictures are spaced evenly, and the last one can land on the final frame', () => {
    const t = VM.defaultTimes(3, 10, false);
    assert.ok(t.length === 3 && t[0] === 0 && t[1] > 0 && t[2] > t[1] && t[2] < 10);
    assert.equal(VM.defaultTimes(3, 10, true)[2], 'end');
    assert.equal(VM.defaultTimes(2, 10, true).join(), '0,end');
  });
  test('a timeline that goes backwards or runs past the clip is refused', () => {
    assert.equal(VM.check([{}, { at: 4 }, { at: 3 }], 10, false).ok, false);
    assert.equal(VM.check([{}, { at: 12 }], 10, false).ok, false);
    assert.equal(VM.check([{}], 10, false).ok, false);
    assert.equal(VM.check([{}, { at: 4 }, { at: 'x' }], 10, true).ok, true);
  });
  test('the timeline reads as letters and seconds', () => {
    assert.equal(VM.describe([{}, { at: 4 }, {}], true), 'A 0 s → B 4 s → C end');
  });
}

console.log('models.js');
{
  const w = load('models.js');
  const M = w.Models;
  test('a card names its model; older cards are inferred from their size', () => {
    assert.equal(M.ofCard({ model: 'perchance' }), 'perchance');
    assert.equal(M.ofCard({ width: 512, height: 768 }), 'perchance');
    assert.equal(M.ofCard(null), 'else');
    assert.equal(M.label('qwen-image-2.1'), 'Qwen-image-2.1');
  });
}

console.log('imageedit.js (character remake)');
{
  const w = load('state.js', 'comfy.js', 'imageedit.js');
  const E = w.ImageEdit;
  test('the remake prompt carries the design in words and no second picture', () => {
    const p = E.remakePrompt('short silver hair with a blue ribbon, green eyes, round glasses.');
    assert.ok(p.startsWith('Edit <image1>. Redraw the main character with a new hairstyle and face: short silver hair with a blue ribbon, green eyes, round glasses. '));
    assert.ok(!/<image2>/.test(p));
    assert.ok(/same art style as <image1>/.test(p) && /Keep the body shape, pose/.test(p));
  });
  test('the reference reader asks only for the design, never clothing or pose', () => {
    assert.ok(/Do NOT describe: clothing/.test(E.DESIGN_PROMPT));
    assert.ok(/"ok": true/.test(E.DESIGN_PROMPT));
  });
}

console.log('promptstyle.js (plain sentences)');
{
  const w = load('promptstyle.js');
  const P = w.PromptStyle;
  test('quality tags and "no X" guards are dropped from a sentence prompt', () => {
    assert.equal(P.stripTags('A fox reads a map under a lantern, masterpiece, best quality, 4k, no extra fingers.'), 'A fox reads a map under a lantern.');
    assert.equal(P.stripTags('A lighthouse in a storm.'), 'A lighthouse in a storm.');
  });
}

async function testAsync(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const J = (x) => JSON.stringify(x);

console.log('comfy.js (FLUX.3 Image Klein references)');
{
  const C = load('state.js', 'comfy.js').ComfyUI;
  const defs = JSON.parse(fs.readFileSync(new URL('../../tools/fixtures/flux3_object_info.json', root), 'utf8'));
  const raw = JSON.parse(fs.readFileSync(new URL('../../workflows/AcreArtStudio_FLUX.3-Klein_int8.json', root), 'utf8'));
  const wf = C.normalizeWorkflow(raw, defs);
  const N = wf.nodes;
  const byClass = (c) => Object.entries(N).filter(([, n]) => n.classType === c);
  const [rmlId, rml] = byClass('ReferenceMultiLatent')[0] || [];
  const [ksId, ks] = byClass('KSampler')[0] || [];
  const [encId] = byClass('CLIPTextEncode')[0] || [];
  test('the editor file normalizes: named widgets, a wired width does not slide into batch_size', () => {
    assert.ok(!wf.needsDefs && !byClass('MarkdownNote').length);
    assert.ok(rml && rml.inputs.resolution === 'resize' && rml.inputs['resolution.megapixels'] === 1, J(rml && rml.inputs));
    assert.ok(ks && ks.inputs.steps === 16 && ks.inputs.sampler_name === 'er_sde', J(ks && ks.inputs));
    const [, lat] = byClass('EmptyFlux2LatentImage')[0];
    assert.ok(Array.isArray(lat.inputs.width) && Array.isArray(lat.inputs.height) && lat.inputs.batch_size === 1, J(lat.inputs));
  });
  test('the prompt traces through ReferenceMultiLatent to CLIPTextEncode', () => {
    const slots = C.detectPromptSlots(wf);
    assert.ok(slots && slots.positive === encId && !slots.negative, J(slots));
    assert.equal(C.detectSeedSlot(wf).id, ksId);
  });
  test('references land on ReferenceMultiLatent as zero-based images.image0…', () => {
    const g = JSON.parse(J(N));
    const w = C.injectQwenReferences(g, ['a.png', 'b.png', 'c.png'], 2);
    assert.ok(w.ok && w.targetId === rmlId, J(w));
    assert.equal(J(w.inserted.map((x) => x.slot)), J(['images.image0', 'images.image1']));
    assert.equal(J(w.skipped), J(['c.png']));
    const again = C.injectQwenReferences(g, ['z.png'], 1);
    assert.ok(again.ok && !g[rmlId].inputs['images.image1'], 're-injection clears the previous set');
    assert.equal(C.referenceSlotName({ classType: 'TextEncodeQwenImage21' }, 0), 'images.image_1');
  });
  test('a FLUX.3 edit samples on the reference latent and keeps the source size', () => {
    const e = JSON.parse(J(N));
    C.injectQwenReferences(e, ['src.png'], 1);
    const m = C.matchEditSize(e, { w: 512, h: 768 });
    assert.ok(m.ok && J(e[ksId].inputs.latent_image) === J([rmlId, 2]), J(m));
    assert.equal(J(m.canvas), '{"width":832,"height":1248}');
    assert.equal(J(C.rmlEditCanvas({ w: 1024, h: 1024 }, { resolution: 'resize', 'resolution.megapixels': 1 })), '{"width":1024,"height":1024}');
  });
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  async function runGen(nodes, prompt, refs) {
    const d = new C.ComfyDriver({ comfy: {} });
    Object.defineProperty(d, 'cfg', { get: () => ({ imageWorkflow: 'x.json', imagesPerPrompt: 1, maxReferences: 1 }) });
    let sent = null;
    d.ensureServer = async () => {};
    d.loadWorkflow = async () => ({ nodes: JSON.parse(J(nodes)) });
    d.uploadImage = async ({ nameHint }) => `${nameHint}.png`;
    d.submit = async (graph) => { sent = graph; return { ok: true, promptId: 'p1' }; };
    d.pollHistory = async () => ({});
    d.collectImages = async () => [{ base64: 'x', mime: 'image/png', w: 1, h: 1 }];
    await d.generate(prompt, { count: 1, references: refs }, () => {});
    return sent;
  }
  await testAsync('<image1> becomes <ref_image_0> on a FLUX.3 graph only', async () => {
    const s1 = await runGen(N, 'Keep the lighthouse in <image1>; add a rainbow.', [{ id: 'r1', base64: PNG, mime: 'image/png' }]);
    assert.equal(s1[encId].inputs.text, 'Keep the lighthouse in <ref_image_0>; add a rainbow.');
    const s2 = await runGen(N, 'A plain <image1> mention with no reference.', []);
    assert.equal(s2[encId].inputs.text, 'A plain <image1> mention with no reference.');
    const qwen = { '1': { classType: 'VAELoader', inputs: { vae_name: 'v' } }, '2': { classType: 'TextEncodeQwenImage21', inputs: { prompt: '', vae: ['1', 0], resolution: 1024 } },
      '3': { classType: 'KSampler', inputs: { seed: 1, positive: ['2', 0], negative: ['2', 1], latent_image: ['2', 2] } } };
    const s3 = await runGen(qwen, 'In <image1> the sky turns orange.', [{ id: 'q', base64: PNG, mime: 'image/png' }]);
    assert.ok(s3['2'].inputs.prompt === 'In <image1> the sky turns orange.' && Array.isArray(s3['2'].inputs['images.image_1']), J(s3['2'].inputs));
  });
}

console.log('imageedit.js (edit workflow picker)');
{
  const w = load('state.js', 'comfy.js', 'imageedit.js');
  const E = w.ImageEdit;
  w.State.settings = { comfy: { imageWorkflow: 'AcreArtStudio_Qwen-Image-2.1_Q8.json', editWorkflow: '', videoWorkflow: 'AcreArtStudio_FastH3_Video.json' } };
  test('the picker lists edit-capable workflows only and keeps the current pick', () => {
    const files = ['a_Text_to_Image.json', 'b_Text_and_Reference.json', 'AcreArtStudio_FastH3_Video.json', 'AcreArtStudio_Qwen-Image-2.1_Q4.json', 'AcreArtStudio_FLUX.3-Klein_int8.json', 'c_Edit.json', 'notes.txt'];
    assert.equal(J(E.editWorkflowChoices(files, w.State.settings.comfy)),
      J(['b_Text_and_Reference.json', 'AcreArtStudio_Qwen-Image-2.1_Q4.json', 'AcreArtStudio_FLUX.3-Klein_int8.json', 'c_Edit.json']));
    assert.equal(J(E.editWorkflowChoices(['x.json'], { editWorkflow: 'mine.json' })), J(['mine.json']));
  });
  test('no pick → the generator workflow; a pick wins', () => {
    assert.equal(E.editWorkflow(), 'AcreArtStudio_Qwen-Image-2.1_Q8.json');
    w.State.settings.comfy.editWorkflow = 'AcreArtStudio_FLUX.3-Klein_int8.json';
    assert.equal(E.editWorkflow(), 'AcreArtStudio_FLUX.3-Klein_int8.json');
  });
}

console.log('overseer.js (library cards as references)');
{
  const require = createRequire(import.meta.url);
  const { DEFAULT_SETTINGS } = require('../src/main/store.js');
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const w = load({ setInterval, clearInterval }, 'state.js', 'perchance.js', 'promptstyle.js', 'promptlab.js', 'titles.js', 'comfy.js', 'pipeline.js', 'overseer.js');
  const { State, Pipeline, Overseer } = w;
  State.addLog = () => {};
  State.persistQueue = () => {};
  State.persistLibrary = () => {};
  State.settings = structuredClone(DEFAULT_SETTINGS);
  State.settings.gen.engine = 'comfy';
  State.queue = [];
  State.worker = { running: false, currentJobId: null, statusText: 'Idle', qcLane: 0 };
  Pipeline.start = () => { Pipeline.running = true; };
  Pipeline.laneImages = () => 0;
  Pipeline.ideate = async (theme, _e, count) => Array.from({ length: count }, (_, i) => ({ prompt: `${theme} #${i}`, controls: {} }));
  w.Teach = { screen: (p) => ({ kept: p, dropped: [] }) };
  w.Variety = { invalidate: () => {} };
  const card = (id, extra = {}) => ({ id, fname: `img-${id}.png`, mime: 'image/png', prompt: 'x', theme: 'x', status: 'review', promptSource: 'overseer', ...extra });
  State.library = [
    card('c1'), card('c2'), card('nofile', { fname: '' }),
    card('a-s5', { batchId: 'bA', qc: { score: 5 } }), card('a-s9', { batchId: 'bA', qc: { score: 9 } }),
    card('a-s7', { batchId: 'bA', qc: { score: 7 } }), card('a-s8', { batchId: 'bA', qc: { score: 8 } }),
    card('a-s6', { batchId: 'bA', qc: { score: 6 } }), card('a-noqc', { batchId: 'bA', qc: null }),
    card('a-bin', { batchId: 'bA', status: 'discarded', qc: { score: 10 } }), card('a-rej', { batchId: 'bA', status: 'rejected', qc: { score: 10 } }),
  ];
  let saved = 0;
  w.ala = {
    settings: { patch: async () => State.settings },
    db: { getOverseer: async () => ({}), setOverseer: async () => true },
    files: {
      readImageBase64: async () => PNG,
      saveAttachment: async (_b, mime, name) => ({ fname: `ovr-${saved++}-${name}.png`, mime }),
      readAttachment: async () => ({ base64: PNG, mime: 'image/png' }),
    },
    llm: { chat: async () => ({ text: '{"say":"ok","tool":null,"done":true}' }), route: async () => ({ maxConcurrency: 1, vision: true }) },
  };
  await testAsync('a card named by id rides with every job, copied like an attachment', async () => {
    const r = await Overseer.queueArt({ theme: 'a forest path in autumn', count: 2, referenceImages: ['card-c1'] });
    assert.ok(r.ok, r.error);
    assert.equal(J(State.queue.map((j) => j.referenceIds)), J([['card-c1'], ['card-c1']]));
    assert.ok(/^ovr-/.test(State.queue[0].chatReferences[0].fname));
    assert.equal(J(r.cardReferences), J(['card-c1']));
  });
  await testAsync('bare ids work and several cards rotate one per picture', async () => {
    State.queue = [];
    const r = await Overseer.queueArt({ theme: 't', count: 4, referenceImages: ['c1', 'c2'] });
    assert.equal(J(r.cardReferences), J(['card-c1', 'card-c2']));
    assert.ok(r.cycled === true && State.queue[0].referenceIds[0] !== State.queue[1].referenceIds[0], J(r));
    State.queue = [];
    const n = await Overseer.queueArt({ theme: 't', count: 2, referenceImages: ['c1', 'c2'], cycleReferences: false });
    assert.ok(!n.cycled, 'cycleReferences:false still wins');
  });
  await testAsync('unknown or fileless cards fail loudly; chat ids keep their own path', async () => {
    const bad = await Overseer.queueArt({ theme: 't', count: 1, referenceImages: ['card-zzz'] });
    assert.ok(!bad.ok && /no library card with id zzz/.test(bad.error) && Array.isArray(bad.recentResults), J(bad));
    const nofile = await Overseer.queueArt({ theme: 't', count: 1, referenceImages: ['card-nofile'] });
    assert.ok(!nofile.ok && /nofile/.test(nofile.error), J(nofile));
    const chat = await Overseer.queueArt({ theme: 't', count: 1, referenceImages: ['a1'] });
    assert.ok(!chat.ok && /no attached image called a1/.test(chat.error), J(chat));
  });
  await testAsync('referenceBatch takes the four best finished pictures of a batch', async () => {
    State.queue = [];
    const r = await Overseer.queueArt({ theme: 'variations', count: 4, referenceBatch: 'bA' });
    assert.equal(J(r.cardReferences), J(['card-a-s9', 'card-a-s8', 'card-a-s7', 'card-a-s6']));
    assert.ok(/4 best of 6 finished/.test(r.cardNote), r.cardNote);
    State.queue = [];
    Overseer._lastBatchId = 'bA';
    const latest = await Overseer.queueArt({ theme: 'variations', count: 1, referenceBatch: 'latest' });
    assert.ok(latest.ok && latest.cardReferences.length === 4 && /batch bA/.test(latest.cardNote), J(latest));
    State.queue = [{ id: 'j1', batchId: 'bWait', status: 'generating' }];
    const wait = await Overseer.queueArt({ theme: 'v', count: 1, referenceBatch: 'bWait' });
    assert.ok(!wait.ok && /no finished picture yet \(1 still to render\)/.test(wait.error), J(wait));
    const none = await Overseer.queueArt({ theme: 'v', count: 1, referenceBatch: 'bNope' });
    assert.ok(!none.ok && /no usable picture/.test(none.error), J(none));
    State.queue = [];
    const both = await Overseer.queueArt({ theme: 'v', count: 1, referenceImages: ['c1', 'card-a-s9'], referenceBatch: 'bA' });
    assert.equal(J(both.cardReferences), J(['card-c1', 'card-a-s9', 'card-a-s8', 'card-a-s7', 'card-a-s6']));
  });
  test('queue_art documents card ids and referenceBatch to the model', () => {
    const cat = Overseer.catalogue();
    assert.ok(/referenceBatch/.test(cat) && /library cardId/.test(cat));
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
