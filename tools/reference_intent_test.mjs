/**
 * reference_intent_test.mjs — the Overseer follows the reference he names and keeps a
 * non-human form.
 *  [1] namedReferences: "use the i1 reference" → his attachment is feedback; "this picture" keeps it
 *  [2] write_research_prompts: a1 dropped when he names i1; imageIds forced to i1
 *  [3] queue_research_prompts: a set that carries a1 queues with i1 only when he names i1
 *  [4] writerAsks / askCheck: a non-human form reaches the writer; prompts that still paint a
 *      human face are rewritten once and the rest reported
 *  [5] the reader's humanLooking:false puts a FORM row and the form rule into the writer prompt
 *  [6] resultText keeps attachmentsNote / referenceRead when a long result is shortened
 * Offline: no Electron, no network.
 *
 *   node tools/reference_intent_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { DEFAULT_SETTINGS } = require(path.join(root, 'src/main/store.js'));
const ctx = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval, JSON, Math, Date, Object, Array, String, Number, Set, Map, RegExp, Promise, Error });
ctx.window = ctx; ctx.globalThis = ctx;
for (const f of ['state.js', 'perchance.js', 'promptstyle.js', 'promptlab.js', 'titles.js', 'comfy.js', 'pipeline.js', 'overseer.js']) {
  new vm.Script(fs.readFileSync(path.join(root, 'src/renderer', f), 'utf8'), { filename: f }).runInContext(ctx);
}
const { State, Pipeline, Overseer: O, PromptLab } = ctx;
let pass = 0, fail = 0;
const eq = (a, b, what) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.log(`  FAIL ${what}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); } };
const ok = (c, w) => { if (c) pass++; else { fail++; console.log('  FAIL ' + w); } };

State.addLog = () => {}; State.bumpStats = () => {}; State.persistLibrary = () => {}; State.persistQueue = () => {};
State.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
State.settings.gen.engine = 'comfy';
State.library = []; State.queue = [];

console.log('[1] namedReferences');
const N = (t) => O.namedReferences(t);
eq(N('still looks too human, use the lumen i1 reference').onlyResearch, true, 'i1 named');
eq(N('still looks too human, use the lumen i1 reference').research, ['i1'], 'i1 parsed');
eq(N('use i1 and this picture').onlyResearch, false, '"this picture" keeps the attachment');
eq(N('use i2 like the attached one').onlyResearch, false, '"attached" keeps it');
eq(N('use a1 and i1').onlyResearch, false, 'a1 named');
eq(N('only one reference per image please').onlyResearch, false, 'no id named');

const attach = [{ id: 'a1', fname: 'ovr-1-image.png', mime: 'image/png', name: 'image.png' }];
const SAID = ['make 6 pictures of lumen at the lighthouse', 'use the references', 'keep its robot form, not a human in a costume'];
const LAST = 'still looks too human, use the lumen i1 reference';
const HUMANISH = 'Lumen the lighthouse keeper smiles, pale skin, blushing cheeks, standing on the rocks at dusk, low-angle camera';
const GOOD = (n) => `Lumen the lighthouse keeper, a brass robot with a glass dome head and one glowing lamp eye, riveted copper plates, pose ${n}, rocky shore at dusk, low-angle camera`;

ctx.ala = {
  files: { readAttachment: async () => ({ base64: 'QUJD', mime: 'image/png' }) },
  research: { image: async () => ({ ok: true, base64: 'QUJD', mime: 'image/png' }) },
  llm: { route: async () => [{ maxConcurrency: 1 }] },
};
Pipeline.downscaleForQc = async (b, m) => ({ base64: b, mime: m });
const reads = [];
PromptLab.readCharacterReference = async (a) => {
  reads.push(a.label);
  return /artist's own/.test(a.label)
    ? { recognizedAs: 'Lumen', hair: null, humanLooking: true }
    : { recognizedAs: 'Lumen', humanLooking: false, form: 'brass robot body, glass dome head with one glowing lamp eye', identityPrompt: 'Lumen, brass robot, glass dome head, lamp eye' };
};
const calls = [];
let replies = [];
PromptLab.fromResearch = async (a) => { calls.push(a); const r = replies.shift() || []; return { prompts: r.slice(0, a.count), provider: 'stub' }; };
Pipeline.start = () => { Pipeline.running = true; };
O.routeReferenceJobs = async () => null;

const RID = 'research-lumen';
const freshPack = () => [{ id: RID, query: 'Lumen lighthouse keeper robot', kind: 'character', at: 1,
  sources: [{ title: 'Lumen | Wiki', snippet: 'Lumen is a brass robot that keeps a lighthouse' }],
  images: [{ id: 'i1', title: 'Lumen official art', imageUrl: 'u1' }, { id: 'i2', title: 'Lumen fan art', imageUrl: 'u2' }],
  promptSets: [] }];
const chat = (last) => {
  O.messages = [...SAID.map((text) => ({ role: 'user', text })), { role: 'user', text: last, attachments: attach }];
  O._requestText = last;
  O._activeKind = 'helper'; O._writeAsked = true; O._generateAsked = true;
};

console.log('[2] write_research_prompts: his named i1 beats his attached screenshot');
O.research = freshPack();
chat(LAST);
replies = [[GOOD(1), GOOD(2), GOOD(3)]];
reads.length = 0;
const w = await O.writeResearchPrompts({ count: 3, imageIds: ['i1'], referenceImages: ['a1'], researchId: RID });
ok(w.ok && w.written === 3, 'written ' + JSON.stringify(w).slice(0, 200));
eq(w.attachmentsNotUsed, ['a1'], 'a1 reported as not used');
ok(!reads.some((l) => /artist's own/.test(l)), 'a1 never read as a reference: ' + JSON.stringify(reads));
const set1 = O.research[0].promptSets.at(-1);
eq(set1.imageIds, ['i1'], 'set references = i1 only');
eq(set1.chatReferences, [], 'set carries no chat reference');
ok(Array.isArray(w.referenceRead) && w.referenceRead[0].humanLooking === false && /robot/.test(w.referenceRead[0].form), 'the reply sees what i1 really shows');
replies = [[GOOD(4)]];
await O.writeResearchPrompts({ count: 1, imageIds: ['i2'], researchId: RID });
eq(O.research[0].promptSets.at(-1).imageIds, ['i1'], 'his i1 beats the model\'s i2');
chat('use this picture and i1 for the reference');
replies = [[GOOD(5)]];
reads.length = 0;
const w3 = await O.writeResearchPrompts({ count: 1, imageIds: ['i1'], referenceImages: ['a1'], researchId: RID });
ok(w3.ok && !w3.attachmentsNotUsed && reads.some((l) => /artist's own/.test(l)), 'pointed-at attachment still read');

console.log('[3] queue_research_prompts');
O.research = freshPack();
const set = { id: 'prompts-lumen', theme: 'Lumen', prompts: [GOOD(1), GOOD(2)], imageIds: ['a1', 'i1'], chatReferences: [{ ...attach[0] }] };
O.research[0].promptSets.push(set);
State.queue = [];
chat(LAST);
const q = await O.queueResearchPrompts({ promptSetId: set.id, researchId: RID, first: true });
ok(q.ok && q.queued === 2, 'queued ' + JSON.stringify(q).slice(0, 300));
eq(q.perJobReferences, [['i1'], ['i1']], 'every job carries i1, not a1');
eq(q.attachmentsNotUsed, ['a1'], 'a1 reported');
const jobs = State.queue.filter((j) => j.promptSetId === set.id);
ok(jobs.every((j) => !(j.chatReferences || []).length && !j.referenceIds.includes('a1')), 'no job holds a1');
State.queue = [];
O._requestText = 'queue them';
const q3 = await O.queueResearchPrompts({ promptSetId: set.id, researchId: RID });
ok(q3.ok && !q3.attachmentsNotUsed && q3.perJobReferences[0].includes('a1'), 'nothing named → his attachment still rides');

console.log('[4] writerAsks + askCheck');
chat(LAST);
const asks = O.writerAsks([]);
ok(asks.nonHuman && /NOT a normal human/.test(asks.instruction), 'his words → non-human: ' + asks.instruction);
O.messages = [{ role: 'user', text: 'make 6 lighthouse pictures' }]; O._requestText = 'make 6 lighthouse pictures';
const none = O.writerAsks([]);
ok(!none.nonHuman && none.instruction === '', 'nothing asked → nothing added');
ok(O.writerAsks([{ humanLooking: false, form: 'robot' }]).nonHuman, 'reader humanLooking:false alone turns it on');
for (const [t, want] of [['i want human looking art', false], ['still looks human', true], ['keep its robot form', true], ['make him human', false]]) {
  O.messages = [{ role: 'user', text: t }]; O._requestText = t;
  eq(O.writerAsks([]).nonHuman, want, `nonHuman("${t}")`);
}
eq(O.humanTells(HUMANISH), ['pale skin', 'blushing', 'cheeks'], 'human tells');
eq(O.humanTells(GOOD(1)), [], 'the robot prompt is clean');
eq(O.humanTells('a brass robot, no blush'), [], 'negated blush is not a tell');
O.research = freshPack();
chat(LAST);
calls.length = 0;
replies = [[HUMANISH, GOOD(2), HUMANISH], [GOOD(7), HUMANISH]];
const w4 = await O.writeResearchPrompts({ count: 3, researchId: RID });
ok(w4.ok && w4.askCheck, 'askCheck present ' + JSON.stringify(w4.askCheck));
eq(calls.length, 2, 'first write + one rewrite round');
eq(calls[1].count, 2, 'only the 2 bad prompts rewritten');
ok(/human: pale skin/.test(calls[1].extra), 'rewrite told what broke: ' + calls[1].extra.slice(-160));
eq(w4.askCheck.rewritten, 1, 'one was fixed');
eq(w4.askCheck.promptsStillMissing, 1, 'the other is reported, not hidden');
ok(/still describe a human look/.test(w4.askCheck.note), 'note tells the model not to over-claim');
ok(calls[0].nonHuman === true && /NOT a normal human/.test(calls[0].extra), 'first write already carries the form');

console.log('[5] writer prompt text');
let seen = '';
new vm.Script(fs.readFileSync(path.join(root, 'src/renderer/promptlab.js'), 'utf8'), { filename: 'promptlab.js' }).runInContext(ctx);
ctx.PromptLab.ask = async (build) => { seen = build(3, []); return { prompts: [] }; };
await ctx.PromptLab.fromResearch({ query: 'Lumen', kind: 'character', briefs: [{ recognizedAs: 'Lumen', humanLooking: false, form: 'brass robot body' }], count: 3, nonHuman: true });
ok(/FORM \(not a normal human\): brass robot body/.test(seen), 'FORM row in the reference block');
ok(/THE CHARACTER IS NOT A NORMAL HUMAN/.test(seen), 'form rule present');
await ctx.PromptLab.fromResearch({ query: 'Lumen', kind: 'character', briefs: [{ recognizedAs: 'Lumen', hair: 'none' }], count: 3 });
ok(!/NOT A NORMAL HUMAN|FORM \(not/.test(seen), 'default prompt unchanged');
ctx.U.llmVision = async () => ({ text: '{"matchesSubject":true,"humanLooking":"false","form":"robot body"}' });
const rb = await ctx.PromptLab.readCharacterReference({ base64: 'A', subject: 'x' });
ok(rb.humanLooking === false && rb.form === 'robot body', 'string "false" → false');
ctx.U.llmVision = async () => ({ text: '{"matchesSubject":true,"form":"ignored"}' });
const rb2 = await ctx.PromptLab.readCharacterReference({ base64: 'A', subject: 'x' });
ok(rb2.humanLooking === true && rb2.form === null, 'missing → human, form dropped');

console.log('[6] shortened results keep the notes');
ctx.PromptLab.fromResearch = PromptLab.fromResearch;
ctx.PromptLab.readCharacterReference = PromptLab.readCharacterReference;
O.research = freshPack();
chat(LAST);
const long = (n) => `${GOOD(n)} ${'detail '.repeat(90)}`;
replies = [[long(1), long(2), long(3), long(4), long(5), long(6)]];
const w5 = await O.writeResearchPrompts({ count: 6, researchId: RID, referenceImages: ['a1'] });
const shown = JSON.parse(O.resultText(w5));
ok(shown.truncated && shown.attachmentsNote && Array.isArray(shown.referenceRead), 'shortened result keeps attachmentsNote + referenceRead: ' + Object.keys(shown).join(','));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
