/**
 * comic_redraw_cast_test.mjs: redraw a cast sheet WITH the user's instruction.
 *
 * Proves: redraw_cast is offered and routed; it redraws the SAME project's sheet with the
 * words in the prompt and an attachment as a reference; the before redraw drops the after
 * sheet; the note sticks and clears; "words only" skips the references.
 *
 * Offline: no Electron, GPU, model or app data.   node tools/comic_redraw_cast_test.mjs
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
Overseer.messages = [{ id: 'm1', role: 'user', text: 'make a comic of her', at: Date.now(), attachments: [{ id: 'a1', fname: 'ovr-a1-x.png', mime: 'image/png', name: 'x.png', w: 1024, h: 1024 }] }];
Overseer._activeKind = 'helper'; Overseer._generateAsked = true;
const settle = async (p) => { for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 0)); await (Comics._locks.get(p.id) || Promise.resolve()); } };


console.log('[1] offered and routed');
ok(!!Overseer.TOOLS.redraw_cast && Overseer.catalogue().includes('redraw_cast'), 'redraw_cast is in the catalogue');
ok(/redraw_cast/.test(Overseer.systemPrompt('helper')), 'the system prompt routes cast fixes to redraw_cast');
ok(Overseer.TOOLS.redraw_cast.reads !== true, 'redraw_cast acts (not a read)');

console.log('[2] redraw_cast = same comic, his words + his picture');
let r = await Overseer.makeComic({ premise: 'Mira walks a lighthouse path and finds a lantern', panels: 4 });
ok(r.ok, 'make_comic started', JSON.stringify(r));
const p = Comics.get(r.projectId);
await settle(p);
Comics.stop(p);
State.queue.length = 0;
p.storyboarded = true;
p.cast = [ctx.ComicPrompts.blankMember({ name: 'Mira', look: 'short blonde hair', after: 'wearing a silver coat' })];
const m = p.cast[0];
m.sheet = { fname: 'old.png', source: 'generated' }; m.afterSheet = { fname: 'olda.png' };
Overseer._requestText = 'redo the cast. Blonde hair, large blue eyes';
r = await Overseer.redrawCast({ instruction: 'large blue eyes, young anime face', references: ['a1'] });
ok(r.ok && r.projectId === p.id && r.character === 'Mira', 'redraw_cast ok on the same project', JSON.stringify(r));
ok(Comics.data.projects.length === 1, 'still one comic', String(Comics.data.projects.length));
ok(m.sheetNotes && m.sheetNotes.before === 'large blue eyes, young anime face', 'his words are kept on the sheet', JSON.stringify(m.sheetNotes));
ok(m.sheet === null && m.afterSheet === null, 'before AND after sheets dropped (after follows the new before)');
ok((m.refs || []).some((x) => /comic-star/.test(x.fname)), 'his attachment became a reference', JSON.stringify(m.refs));
const job = State.queue.find((j) => j.comic && j.comic.kind === 'sheet' && j.comic.castId === m.id);
ok(!!job, 'a sheet job is queued');
ok(job && /Important: large blue eyes, young anime face\./.test(job.prompt), 'the instruction is in the sheet prompt', job && job.prompt);
ok(job && job.comic.refs && job.comic.refs.some((x) => /comic-star/.test(typeof x === 'string' ? x : x.fname)), 'the job draws FROM his picture', job && JSON.stringify(job.comic.refs));
ok(p.storyboarded === true && p.panels.length >= 0, 'storyboard kept');

console.log('[3] note sticks, clears, and reaches the after edit');
State.queue.length = 0; m.sheetJobId = null;
Comics.rerollSheet(p, m, 'before');
ok(m.sheetNotes.before === 'large blue eyes, young anime face', 'a plain reroll keeps the last note');
Comics.rerollSheet(p, m, 'before', { instruction: '' });
ok(!m.sheetNotes.before, 'an empty box clears it');
m.sheet = { fname: 'new.png' };
Comics.rerollSheet(p, m, 'after', { instruction: 'keep the blue eyes' });
const aj = State.queue.filter((j) => j.comic && j.comic.form === 'after').pop();
ok(aj && /Important: keep the blue eyes\./.test(aj.prompt) && aj.comic.edit === true, 'after edit carries its own note', aj && aj.prompt);
r = await Overseer.redrawCast({ character: 'Nobody' });
ok(!r.ok && /Mira/.test(r.error), 'unknown character → names the cast');


console.log('[4] words only');
m.refs = [{ fname: 'r.png' }]; m.noRefs = false; m.refFaceOnly = false;
ok(ctx.ComicPrompts.sheetJob(p, m, 'before').refs.length === 1, 'references are attached by default');
r = await Overseer.redrawCast({ dropReferences: true });
ok(r.ok && r.fromWordsOnly === true && m.noRefs === true, 'dropReferences → words only', JSON.stringify(r));
ok(ctx.ComicPrompts.sheetJob(p, m, 'before').refs.length === 0, 'no reference attached when words only');
m.noRefs = false; m.refFaceOnly = true;
ok(/body and clothes exactly as written/.test(ctx.ComicPrompts.sheetJob(p, m, 'before').prompt), 'faceOnly: references lend the face only');

console.log(`
${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
