/**
 * overseer_comic_parts_test.mjs: changing a running comic from the Overseer (update_comic,
 * stop_comic), the next part of a finished comic (next_comic_part / Comics.nextPart), and the
 * picture count he asks for (picturesWanted / applyPictureCount).
 *
 * Real state/comfy/pipeline/comiclayout/comics/overseer in a VM, models stubbed.
 * Offline: no Electron, GPU, model or app data.   node tools/overseer_comic_parts_test.mjs
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
const ok = (c, what, extra = '') => { if (c) pass++; else { fail++; console.log('  FAIL ' + what + (extra ? ` — ${extra}` : '')); } };

const ctx = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval, JSON, Math, Date, Object, Array, String, Number, Set, Map, RegExp, Promise, Error });
ctx.window = ctx;
ctx.globalThis = ctx;
const saved = [];
let chatReplies = [];
ctx.ala = {
  settings: { patch: async () => ctx.State.settings },
  db: { getOverseer: async () => ({}), setOverseer: async () => true, getComics: async () => ({ projects: [] }), setComics: async () => true },
  llm: {
    chat: async () => ({ text: chatReplies.shift() || '{}' }),
    vision: async () => ({ text: '{}' }),
    route: async () => ({ maxConcurrency: 1, vision: true }),
  },
  files: {
    readImageBase64: async (f) => `B64:${f}`,
    readAttachment: async (f) => ({ base64: `ATT:${f}`, mime: 'image/png' }),
    saveImage: async (b, ext, hint) => { const fname = `${hint}-${saved.length + 1}.${ext}`; saved.push({ b, fname }); return { id: 's' + saved.length, fname, url: `ala://img/${fname}`, path: fname }; },
    deleteImage: async () => true,
  },
};
for (const f of ['state.js', 'perchance.js', 'promptstyle.js', 'promptlab.js', 'titles.js', 'comfy.js', 'pipeline.js', 'comiclayout.js', 'comics.js', 'overseer.js']) {
  new vm.Script(fs.readFileSync(path.join(root, 'src/renderer', f), 'utf8'), { filename: f }).runInContext(ctx);
}
const { State, Overseer, Comics, Pipeline } = ctx;
const { DEFAULT_SETTINGS } = require(path.join(root, 'src/main/store.js'));
State.addLog = () => {}; State.persistQueue = () => {}; State.persistLibrary = () => {};
State.settings = structuredClone(DEFAULT_SETTINGS);
State.settings.gen.engine = 'comfy';
State.library = [{ id: 'c1', fname: 'c1.png', url: 'ala://img/c1.png', mime: 'image/png', status: 'review', metadata: { title: 'x' } }];
State.queue = [];
const starts = [];
Pipeline.start = (o) => { starts.push(o); };
await Comics.init();
Overseer.messages = [{ id: 'm1', role: 'user', text: 'make a comic of this character', at: Date.now(), attachments: [{ id: 'a1', fname: 'ovr-a1-x.png', mime: 'image/png', name: 'x.png', w: 1024, h: 1024 }] }];
Overseer._activeKind = 'helper'; Overseer._generateAsked = true;
const settle = async (p) => { for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 0)); await (Comics._locks.get(p.id) || Promise.resolve()); } };


console.log('[1] offered and routed');
ok(['update_comic', 'stop_comic'].every((n) => !!Overseer.TOOLS[n] && Overseer.catalogue().includes(n)), 'update_comic and stop_comic are in the catalogue');
const sys = Overseer.systemPrompt('helper');
ok(/update_comic/.test(sys) && /never a second make_comic/.test(sys), 'the system prompt routes whole-comic corrections to update_comic');

console.log('[2] a correction to a running comic → one comic, restarted with it');
let r = await Overseer.makeComic({ premise: 'Mira finds a map in the attic and follows it to the harbour', panels: 4, cast: ['Mira: a1'] });
ok(r.ok, 'make_comic started', JSON.stringify(r));
const p = Comics.get(r.projectId);
await settle(p);
const castIdBefore = p.cast.filter((m) => m.fromUser).map((m) => m.id)[0];
p.artStyle = ctx.ComicPrompts.ART_STYLES.manga.style;
State.queue.push({ id: 'old1', status: 'queued', comic: { projectId: p.id, kind: 'sheet' } });
r = await Overseer.updateComic({ instruction: 'she starts in a raincoat; it is raining' });
await settle(p);
ok(r.ok && r.restarted && r.projectId === p.id, 'update_comic restarted the SAME project', JSON.stringify(r));
ok(Comics.data.projects.length === 1, 'still one comic, not two', String(Comics.data.projects.length));
ok(/Also: she starts in a raincoat/.test(p.premise) && /Mira finds a map/.test(p.premise), 'premise = original + his addition', p.premise);
ok(!State.queue.some((j) => j.id === 'old1'), 'the old queued jobs were removed');
ok(p.cast.some((m) => m.fromUser && (m.refs || []).length), 'his reference picture is kept');
ok(p.cast.filter((m) => m.fromUser)[0].id !== castIdBefore, 'his character got a new id (an old sheet still rendering is not taken)');
ok(p.artStyle === ctx.ComicPrompts.ART_STYLES.manga.style, 'a picked art style is kept');
ok(p.run.active === true, 'it is running again');

console.log('[3] full premise replacement, refusals, stop');
r = await Overseer.updateComic({ premise: 'A totally new premise' });
await settle(p);
ok(r.ok && p.premise === 'A totally new premise', 'premise replaced', p.premise);
r = await Overseer.updateComic({});
ok(!r.ok && /instruction/.test(r.error), 'no instruction → refused');
r = Overseer.stopComic({});
ok(r.ok && r.stopped === true && p.run.active === false, 'stop_comic stops it', JSON.stringify(r));
r = Overseer.stopComic({});
ok(r.ok && r.stopped === false, 'stopping a stopped comic says so');

console.log('[4] update_comic acts');
ok(Overseer.TOOLS.update_comic.reads !== true, 'update_comic acts (not a read)');

console.log('[5] next part offered');
ok(!!Overseer.TOOLS.next_comic_part && Overseer.catalogue().includes('next_comic_part'), 'next_comic_part is in the catalogue');
ok(/next_comic_part/.test(Overseer.systemPrompt('helper')), 'the system prompt routes "part 2" to it');

console.log('[6] a finished comic → Part 2');
r = await Overseer.makeComic({ premise: 'Mira repairs an old lighthouse lamp', panels: 4, sequence: true, cast: ['Mira: a1'] });
const p2 = Comics.get(r.projectId);
await settle(p2);
r = await Overseer.nextComicPart({});
ok(!r.ok && /finished page/.test(r.error), 'refused before the page exists', JSON.stringify(r));
Comics.stop(p2);
p2.storyboarded = true;
if (!p2.panels.length) p2.panels = [{ n: 1, action: 'She climbs the stairs', caption: 'The lamp was dark', lines: [{ speaker: 'Mira', text: 'Almost there.' }] }];
p2.page = { fname: 'x.png' }; p2.title = "The Lamp"; p2.artStyle = 'manga-ish'; p2.galleryIds = ['111', '222']; p2.pageScale = 2; p2.pageStyle = 'sunset';
const m = p2.cast.find((c) => c.name) || p2.cast[0]; m.after = 'soot on her cheeks, rolled-up sleeves'; m.afterSheet = { fname: 'after.png' };
r = await Overseer.nextComicPart({ projectId: p2.id, direction: 'a ship answers the light' });
ok(r.ok, 'next part started', JSON.stringify(r));
const q = Comics.get(r.projectId);
ok(q && q.id !== p2.id && Comics.data.projects.length === 3, 'a NEW comic (the update_comic one + Part 1 + Part 2)');
ok(q.title === "The Lamp — Part 2" && q.titleManual === true && q.part === 2 && p2.part === 1 && p2.nextPartId === q.id, 'titled Part 2 and linked', q.title);
ok(q.artStyle === 'manga-ish' && q.pageStyle === 'sunset' && q.pageScale === 2 && JSON.stringify(q.galleryIds) === '["111","222"]' && q.sequence === true, 'style, page look, size, folders carried');
const qm = q.cast.find((c) => c.name === m.name);
ok(qm && qm.refs[0] && qm.refs[0].fname === 'after.png' && qm.look === 'soot on her cheeks, rolled-up sleeves', 'the character starts as she ended (after sheet first)', JSON.stringify(qm && qm.refs));
ok(q.premise.length > 20, 'premise written', q.premise.slice(0, 120));

console.log('[7] Part 3 from Part 2');
q.page = { fname: 'y.png' }; Comics.stop(q); q.storyboarded = true; if (!q.panels.length) q.panels = p2.panels;
r = await Overseer.nextComicPart({ projectId: q.id });
const z = Comics.get(r.projectId);
ok(r.ok && z.title === "The Lamp — Part 3" && z.partOf.rootId === p2.id, 'Part 3 keeps the base title and root', z && z.title);


console.log('[8] the number of pictures he asked for');
Overseer.messages = [{ id: 'p1', role: 'user', text: 'make 1 image of a lighthouse first', at: 1 }];
Overseer._requestText = 'make 1 image of a lighthouse first';
ok(Overseer.picturesWanted() === 1, '"make 1 image" → 1 picture');
Overseer._requestText = 'use 3 reference images and make two pictures';
ok(Overseer.picturesWanted() === 2, 'reference-image counts are not picture counts');
Overseer._requestText = 'make some pictures'; Overseer.messages = [];
ok(Overseer.picturesWanted() === null, 'no number → null');
const jobs = [1, 2, 3, 4].map((i) => ({ id: 'j' + i, count: 3 }));
let kept = Overseer.applyPictureCount(jobs.map((j) => ({ ...j })), 1);
ok(kept.length === 1 && kept[0].count === 1, 'pictures 1 → one prompt, one render', JSON.stringify(kept));
kept = Overseer.applyPictureCount(jobs.map((j) => ({ ...j })), 6);
ok(kept.length === 4 && kept.map((j) => j.count).join() === '2,2,1,1', 'pictures 6 over 4 prompts → 2/2/1/1', JSON.stringify(kept.map((j) => j.count)));
kept = Overseer.applyPictureCount(jobs.map((j) => ({ ...j })), 0);
ok(kept.length === 4 && kept[0].count === 3, 'no count asked → jobs unchanged');
ok(/"pictures"/.test(Overseer.TOOLS.queue_art.args) && /"pictures"/.test(Overseer.TOOLS.queue_research_prompts.args), 'queue_art and queue_research_prompts take a pictures arg');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
