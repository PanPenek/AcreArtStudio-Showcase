/**
 * overseer_chats_comic_frames_test.mjs: Overseer chats, the one-comic-per-turn guard, and the
 * comic frame / crop editing.
 *
 * Real state/comfy/pipeline/comiclayout/comics/overseer in a VM, models and IPC stubbed. Proves:
 *   [1] one make_comic per turn — a second one is refused and names update_comic; update_comic
 *       is capped at 2 restarts per turn; a new turn starts fresh.
 *   [2] chats — + New chat files the live chat (not erased), Chats ▾ lists/searches by name,
 *       reopening restores messages AND its research packs, rename/delete, files persist.
 *   [3] crop — cropRect clamps; a crop made for another take is ignored; compose draws it.
 *   [4] frames — findEdge/moveEdge move the right panels, keep a minimum size; layoutOf uses
 *       dragged frames only for their own template; geometry/aspects follow them; 'auto' sticks.
 *
 * Offline: no Electron, GPU, model or app data.   node tools/overseer_chats_comic_frames_test.mjs
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
let chatFile = { chats: [], version: 1 };
let overseerFile = null;
ctx.ala = {
  settings: { patch: async () => ctx.State.settings },
  db: {
    getOverseer: async () => overseerFile || {},
    setOverseer: async (d) => { overseerFile = JSON.parse(JSON.stringify(d)); return true; },
    getOverseerChats: async () => chatFile,
    setOverseerChats: async (d) => { chatFile = JSON.parse(JSON.stringify(d)); return true; },
    getComics: async () => ({ projects: [] }), setComics: async () => true,
  },
  llm: {
    chat: async () => ({ text: '{}' }),
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
const { State, Overseer, Comics, Pipeline, ComicLayout: L } = ctx;
const { DEFAULT_SETTINGS } = require(path.join(root, 'src/main/store.js'));
State.addLog = () => {}; State.persistQueue = () => {}; State.persistLibrary = () => {};
State.settings = structuredClone(DEFAULT_SETTINGS);
State.settings.gen.engine = 'comfy';
State.library = [];
State.queue = [];
Pipeline.start = () => {};
await Comics.init();
const settle = async (p) => { for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 0)); await (Comics._locks.get(p.id) || Promise.resolve()); } };

console.log('[1] one comic per turn');
Overseer.messages = [{ id: 'm1', role: 'user', text: 'lighthouse comic, 6 panels', at: Date.now() }];
Overseer._activeKind = 'helper'; Overseer._generateAsked = true;
Overseer.busy = true; // inside a chat turn (turn() sets this)
let r = await Overseer.makeComic({ premise: 'A lighthouse keeper finds a glowing bottle on the beach', panels: 6, sequence: true });
ok(r.ok && r.projectId, 'the first make_comic starts', JSON.stringify(r));
const first = Comics.get(r.projectId);
await settle(first);
const stop = Overseer.stopComic({ projectId: first.id });
ok(stop.ok, 'stop_comic in the same turn works');
const before = Comics.data.projects.length;
const sheetsBefore = State.queue.length;
// A loop: stop → make again, seven more times.
let refusals = 0;
for (let i = 0; i < 7; i++) {
  const again = await Overseer.makeComic({ premise: `A lighthouse keeper finds a glowing bottle (try ${i + 2})`, panels: 6, sequence: true, confirmed: true });
  if (!again.ok && /update_comic/.test(again.refused || '') && again.refused.includes(first.id)) refusals++;
}
ok(refusals === 7, 'every further make_comic in the turn is refused and points at update_comic + the projectId', String(refusals));
ok(Comics.data.projects.length === before, 'no second project was created', `${before} → ${Comics.data.projects.length}`);
ok(State.queue.length === sheetsBefore, 'nothing more landed on the queue', `${sheetsBefore} → ${State.queue.length}`);
let u1 = await Overseer.updateComic({ projectId: first.id, instruction: 'it starts at night' });
await settle(first);
let u2 = await Overseer.updateComic({ projectId: first.id, instruction: 'no warm light' });
await settle(first);
let u3 = await Overseer.updateComic({ projectId: first.id, instruction: 'bigger' });
ok(u1.ok && u2.ok, 'update_comic works twice in a turn');
ok(!u3.ok && /restarted twice/.test(u3.refused || ''), 'a third restart in the same turn is refused', JSON.stringify(u3));
// A new turn (turn() resets these in its start and finally).
Overseer._turnComic = null; Overseer._turnComicUpdates = 0;
r = await Overseer.makeComic({ premise: 'A second, different comic', panels: 4 });
ok(r.ok && r.projectId !== first.id, 'the next turn may start a new comic');
await settle(Comics.get(r.projectId));
Overseer.busy = false;
const src = fs.readFileSync(path.join(root, 'src/renderer/overseer.js'), 'utf8');
const turnSrc = src.slice(src.indexOf('async turn(kind) {'), src.indexOf('async step(kind) {'));
ok((turnSrc.match(/this\._turnComic = null;/g) || []).length === 2, 'turn() resets the per-turn comic guard at its start and in finally');
// Outside a chat turn (Comics tab / CDP) nothing is limited.
Overseer._turnComic = 'x';
r = await Overseer.makeComic({ premise: 'From CDP, not a chat turn', panels: 2 });
ok(r.ok, 'make_comic outside a turn is not limited');
await settle(Comics.get(r.projectId));
Overseer._turnComic = null;

console.log('[2] chats');
overseerFile = {
  messages: [
    { id: 'u1', role: 'user', text: 'make me a lighthouse video, 15s', at: 1000 },
    { id: 'h1', role: 'user', text: 'CHECK: hidden nudge', at: 1001, hidden: true },
    { id: 'a1', role: 'agent', text: 'Done', at: 1002 },
  ],
  runs: [{ id: 'r1', status: 'done', at: 1000 }],
  research: [{ id: 'research-lighthouse', query: 'lighthouse', images: [{ id: 'i1' }] }],
  version: 2,
};
chatFile = { chats: [], version: 1 };
await Overseer.init();
clearInterval(Overseer._tick);
ok(!!Overseer.chatId, 'an old overseer.json (no chat id) gets one on load');
ok(Overseer.currentChatName() === 'make me a lighthouse video, 15s', 'the chat is named after his first real message', Overseer.currentChatName());
const lighthouseChat = Overseer.chatId;
await Overseer.newChat();
ok(Overseer.messages.length === 0 && Overseer.research.length === 0, '+ New chat starts empty');
ok(Overseer.chatId !== lighthouseChat, '… with a new id');
ok(chatFile.chats.length === 1 && chatFile.chats[0].id === lighthouseChat && chatFile.chats[0].messages.length === 3, 'the old chat was FILED in overseer-chats.json, not erased', JSON.stringify(chatFile.chats.map((c) => [c.id, (c.messages || []).length])));
ok(chatFile.chats[0].research.length === 1, 'its research packs are filed with it (its i1… ids point into them)');
ok(overseerFile.chatId === Overseer.chatId, 'overseer.json holds the live chat id');
ok(Overseer.runs.length === 1, 'runs stay global');
await Overseer.newChat();
ok(chatFile.chats.length === 1, 'an empty chat is not filed');
Overseer.push('user', 'Robot comic 4 panels please');
Overseer.push('agent', 'Comic is running');
await Overseer.renameChat(Overseer.chatId, 'Robot comic');
ok(Overseer.currentChatName() === 'Robot comic' && overseerFile.chatName === 'Robot comic', 'rename the live chat (saved)');
const robotChat = Overseer.chatId;
let rows = Overseer.listChats();
ok(rows[0].current && rows[0].id === robotChat && rows[1].id === lighthouseChat, 'the list: live chat first, then filed', JSON.stringify(rows.map((x) => x.id)));
ok(rows.every((x) => !('messages' in x)), 'list rows carry no transcript');
ok(Overseer.listChats('lighthouse').map((x) => x.id).join() === lighthouseChat, 'search by name');
ok(Overseer.listChats('ROBOT').map((x) => x.id).join() === robotChat, 'search is case-insensitive');
rows = Overseer.listChats('15s');
ok(rows.length === 1 && rows[0].id === lighthouseChat && !rows[0].inText, '"15s" is in the lighthouse chat\'s NAME');
rows = Overseer.listChats('Done');
ok(rows.length === 0, 'agent replies are not searched (only names + his own words)');
Overseer.chats[0].name = 'Lighthouse clip';
rows = Overseer.listChats('15s');
ok(rows.length === 1 && rows[0].inText === true, 'a chat whose name does not match but his message does is listed after, marked', JSON.stringify(rows));
Overseer._pendingMessages = ['x']; Overseer.pendingChoice = { q: 'x' };
const ok1 = await Overseer.openChat(lighthouseChat);
ok(ok1 && Overseer.chatId === lighthouseChat && Overseer.messages.length === 3, 'reopen the lighthouse chat');
ok(Overseer.research.length === 1 && Overseer.research[0].id === 'research-lighthouse', 'its research packs come back');
ok(Overseer._pendingMessages.length === 0 && Overseer.pendingChoice === null, 'turn memory of the other chat is dropped');
ok(chatFile.chats.length === 1 && chatFile.chats[0].id === robotChat && chatFile.chats[0].name === 'Robot comic', 'the chat he left is filed under its name');
Overseer.busy = true;
ok(await Overseer.openChat(robotChat) === false && Overseer.chatId === lighthouseChat, 'no switching while a turn runs');
ok(await Overseer.newChat() === false, 'no + New chat while a turn runs');
Overseer.busy = false;
await Overseer.renameChat(robotChat, 'Robot comic v1');
ok(chatFile.chats[0].name === 'Robot comic v1', 'rename a filed chat');
await Overseer.deleteChat(robotChat);
ok(chatFile.chats.length === 0, 'delete a filed chat');
// Reload from disk: the live chat id/name survive a restart.
const liveId = Overseer.chatId;
await Overseer.save();
await Overseer.init();
clearInterval(Overseer._tick);
ok(Overseer.chatId === liveId && Overseer.messages.length === 3, 'after a restart the same chat is open');
for (let i = 0; i < 90; i++) Overseer.chats.push({ id: 'c' + i, name: 'x', messages: [] });
await Overseer.saveChats();
ok(chatFile.chats.length === 80, 'the filed list is capped at 80');

console.log('[3] crop inside the frame');
const img = { naturalWidth: 1000, naturalHeight: 1000 };
let s = L.cropRect(img, { w: 200, h: 100 }, { x: 0.5, y: 0.5, z: 1 });
ok(Math.abs(s.sw - 1000) < 1e-6 && Math.abs(s.sh - 500) < 1e-6 && Math.abs(s.sy - 250) < 1e-6, 'z 1 = cover fit, centred', JSON.stringify(s));
s = L.cropRect(img, { w: 200, h: 100 }, { x: 0.9, y: 0.05, z: 2 });
ok(Math.abs(s.sw - 500) < 1e-6 && s.sx === 500 && s.sy === 0, 'zoom 2× and clamped to the picture (no empty strip)', JSON.stringify(s));
s = L.cropRect(img, { w: 100, h: 100 }, { x: 0.5, y: 0.5, z: 0.2 });
ok(s.sw === 1000, 'zoom below 1 is clamped to the cover fit');
ok(Comics.panelCrop({ chosen: 'b.png', crop: { of: 'a.png', x: 0.2, y: 0.2, z: 2 } }) === null, 'a crop made for another take is ignored (a new take starts fitted)');
ok(!!Comics.panelCrop({ chosen: 'a.png', crop: { of: 'a.png', x: 0.2, y: 0.2, z: 2 } }), 'a crop for the take in use applies');
const cSrc = fs.readFileSync(path.join(root, 'src/renderer/comics.js'), 'utf8');
ok((cSrc.match(/this\.panelCrop\(panel\) \? L\.cropRect\(img, box, panel\.crop\)/g) || []).length === 2, 'compose uses his crop for both the normal and the upscaled picture');

console.log('[4] frames');
const g23 = L.LAYOUTS['grid-2x3'].rects;
let e = L.findEdge(g23, 0.5, 0.5, 0.02, 0.02);
ok(e && e.axis === 'x' && e.before.join() === '0,2,4' && e.after.join() === '1,3,5', 'the middle line of a 2×3 grid moves the whole column', JSON.stringify(e));
let moved = L.moveEdge(g23, e, 0.65);
ok(moved[0].w === 0.65 && moved[1].x === 0.65 && Math.abs(moved[1].w - 0.35) < 1e-9 && moved[5].x === 0.65, 'left column wider, right column narrower');
moved = L.moveEdge(g23, e, 0.99);
ok(Math.abs(moved[1].w - 0.08) < 1e-9, 'a panel keeps a minimum size', String(moved[1].w));
const h6 = L.LAYOUTS['hero-6'].rects;
e = L.findEdge(h6, 0.3, 0.24, 0.02, 0.02);
ok(e && e.axis === 'y' && e.before.join() === '0' && e.after.join() === '1,2', 'hero-6: the line under the wide opener moves the opener and the row below', JSON.stringify(e));
e = L.findEdge(h6, 0.5, 0.12, 0.02, 0.02);
ok(e === null, 'no edge inside the wide opener (the column line does not reach it)');
e = L.findEdge(h6, 0.5, 0.4, 0.02, 0.02);
ok(e && e.axis === 'x' && e.before.join() === '1,3' && e.after.join() === '2,4', 'hero-6 middle line moves only the four middle panels', JSON.stringify(e));
ok(L.findEdge(g23, 0.0, 0.5, 0.02, 0.02) === null, 'the page border is not a movable edge');
const proj = Comics.create({ name: 'frames', format: 'page', premise: 'x', panels: 6 });
proj.panels = Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, n: i + 1, shot: 'medium', lines: [], takes: [], who: [] }));
proj.storyboarded = true;
proj.template = 'grid-2x3';
Comics.assignLayout(proj);
const plain = Comics.geometry(proj, 1).boxes.map((b) => b.w);
proj.frames = { template: 'grid-2x3', rects: L.moveEdge(g23, L.findEdge(g23, 0.5, 0.5, 0.02, 0.02), 0.7) };
const G = Comics.geometry(proj, 1);
ok(G.boxes[0].w > plain[0] && G.boxes[1].w < plain[1], 'geometry follows the dragged frames', `${plain[0]}/${plain[1]} → ${G.boxes[0].w}/${G.boxes[1].w}`);
ok(Array.isArray(G.rects) && G.rects[0].w === 0.7, 'geometry hands the editor the rects it drew');
Comics.assignLayout(proj);
ok(proj.template === 'grid-2x3', 'assignLayout keeps his template');
ok(proj.panels[0].aspect !== proj.panels[1].aspect, 'rerolls get the new slot shapes', `${proj.panels[0].aspect} / ${proj.panels[1].aspect}`);
proj.template = 'hero-6';
ok(!Comics.layoutOf(proj).custom, 'frames dragged for another template are ignored');
proj.template = 'auto';
Comics.assignLayout(proj);
ok(proj.template === 'auto', '"Auto grid" sticks (it used to be re-picked straight away)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
