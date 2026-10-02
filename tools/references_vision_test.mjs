/**
 * tools/references_vision_test.mjs: offline tests for picture handling in the Overseer.
 * Run: node tools/references_vision_test.mjs
 *
 * No Electron, no network, no AI model. llm.js runs with a stubbed `fetch`; the renderer
 * modules run in a Node VM.
 *
 * Covered:
 *   - llm.js   : a text-only model receives attached pictures as a description written by
 *                the vision route; descriptions are cached; a failed read falls back to a note
 *   - overseer : reference preferences read from the artist's words ("one reference max,
 *                cycle between them"), references rotated across a batch, attachment intent
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let passed = 0, failed = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// ---------------------------------------------------------------- llm.js
console.log('llm.js (pictures for text-only models)');
{
  const origLoad = Module._load;
  Module._load = function (req) {
    if (req === 'electron') return { net: null };
    // eslint-disable-next-line prefer-rest-params
    return origLoad.apply(this, arguments);
  };
  const llm = require('../src/main/llm.js');
  Module._load = origLoad;

  const prov = (id, vision) => ({ id, name: id, kind: 'openai', enabled: true, vision, baseUrl: `https://${id}.example/v1`, apiKey: 'x', models: { overseer: `${id}-m`, vision: `${id}-v` } });
  const settings = (extra = {}) => ({
    lmStudio: {}, providers: [prov('txt', false), prov('eye', true)],
    routing: { overseer: ['txt'], vision: ['eye'], fallbackLocal: false, ...extra },
  });
  const img = 'data:image/png;base64,AAAA';
  const msgs = [{ role: 'user', content: [{ type: 'text', text: 'what is in this?' }, { type: 'image_url', image_url: { url: img } }] }];

  const calls = [];
  let eyeFails = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const host = new URL(url).hostname.split('.')[0];
    const body = JSON.parse(init.body);
    calls.push({ host, body });
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
    if (host === 'eye') {
      if (eyeFails) return new Response('{"error":"down"}', { status: 500 });
      return json({ choices: [{ message: { content: '{"description":"a lighthouse on a cliff at sunset"}' } }], usage: {} });
    }
    return json({ choices: [{ message: { content: 'It shows a lighthouse.' } }], usage: {} });
  };
  try {
    const route = llm.describeRoute(settings(), 'overseer');
    ok(route.vision === true && route.describedBy.includes('eye'), 'a text-only route still accepts pictures when a vision route exists');

    llm._clearDescribeCache();
    let r = await llm.chat(settings(), msgs, { role: 'overseer' });
    eq(calls.map((c) => c.host), ['eye', 'txt'], 'the vision route reads the picture, then the text model answers');
    const sentText = calls[1].body.messages[0].content;
    ok(typeof sentText === 'string' && /lighthouse on a cliff/.test(sentText), 'the text model receives the description in place of the picture');
    ok(r.sawImages === false && r.imagesDescribed === 1 && /eye/.test(r.imagesDescribedBy), 'the result says who described the picture');

    calls.length = 0;
    await llm.chat(settings(), msgs, { role: 'overseer' });
    eq(calls.map((c) => c.host), ['txt'], 'the description is cached for the next step');

    llm._clearDescribeCache(); calls.length = 0; eyeFails = true;
    r = await llm.chat(settings(), msgs, { role: 'overseer' });
    const hosts = calls.map((c) => c.host);
    ok(hosts[hosts.length - 1] === 'txt' && hosts.slice(0, -1).every((h) => h === 'eye') && hosts.length >= 3,
      'no description: the link that can see is tried first, the text model last', JSON.stringify(hosts));
    ok(/cannot see images/.test(calls[calls.length - 1].body.messages[0].content), 'the text model is then told a picture was there');
    ok(r.sawImages === false && r.provider === 'txt', 'and the result says the answer did not see it');

    llm._clearDescribeCache(); calls.length = 0; eyeFails = false;
    await llm.chat(settings({ describeImagesForTextModels: false }), msgs, { role: 'overseer' });
    eq(calls.map((c) => c.host), ['eye'], 'the off switch restores the old order (links that can see first)');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------- renderer sandbox
const { DEFAULT_SETTINGS } = require(path.join(root, 'src/main/store.js'));
const ctx = vm.createContext({
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  JSON, Math, Date, Object, Array, String, Number, Set, Map, RegExp, Promise, Error, structuredClone,
});
ctx.window = ctx;
ctx.globalThis = ctx;
for (const f of ['state.js', 'perchance.js', 'promptstyle.js', 'titles.js', 'comfy.js', 'pipeline.js', 'overseer.js']) {
  new vm.Script(fs.readFileSync(path.join(root, 'src/renderer', f), 'utf8'), { filename: f }).runInContext(ctx);
}
const { State, Overseer } = ctx;
State.addLog = () => {};
State.settings = structuredClone(DEFAULT_SETTINGS);

console.log('reference preferences');
{
  const prefs = (text, history = []) => {
    Overseer._requestText = text;
    Overseer.messages = history.map((t) => ({ role: 'user', text: t }));
    return JSON.parse(JSON.stringify(Overseer.referencePrefs()));
  };
  eq(prefs('use one refference image max (you can cycle betwen them for variety)'), { max: 1, cycle: true }, 'cap and cycle read from a misspelled request');
  eq(prefs('2 refs at most'), { max: 2, cycle: null }, 'a numeric cap');
  eq(prefs('make a forest scene'), { max: null, cycle: null }, 'no preference stated');
  eq(prefs('make three more', ['just a single reference please, rotate them']), { max: 1, cycle: true }, 'a preference from an earlier message still holds');
  eq(prefs("don't cycle them, same one for all"), { max: null, cycle: false }, 'an explicit no-cycle');
}

console.log('assigning references');
{
  const jobs = [{}, {}, {}, {}, {}];
  const r = JSON.parse(JSON.stringify(Overseer.assignReferences(jobs, ['i1', 'i2', 'i3'], 1, true)));
  ok(r.cycled === true, 'cycling is on');
  eq(r.perJobReferences, [['i1'], ['i2'], ['i3'], ['i1'], ['i2']], 'each job starts at its own reference');
  ok(jobs.every((j) => j.referenceCount === 1), 'each job attaches one');
  const same = [{}, {}];
  const s = JSON.parse(JSON.stringify(Overseer.assignReferences(same, ['i1', 'i2'], 1, false)));
  eq(s.perJobReferences, [['i1'], ['i1']], 'without cycling every job gets the first one');
}

console.log('requests with an attachment');
{
  ok(Overseer.generationRequested('use that as a refference', { attachments: 1 }), 'an attachment plus "use that as a reference" asks for pictures');
  ok(!Overseer.generationRequested('use that as a refference'), 'the same words without an attachment do not');
  ok(Overseer.generationRequested('yes\\'), 'a stray key after "yes" is still a yes');
  ok(!Overseer.generationRequested("don't make anything yet", { attachments: 1 }), 'a negation still wins');
}

console.log('toolDefs');
{
  const defs = Overseer.toolDefs();
  const q = defs.find((d) => d.function.name === 'queue_art').function.parameters.properties;
  ok(q.cycleReferences && q.cycleReferences.type === 'boolean', 'cycleReferences is a boolean argument');
  const w = defs.find((d) => d.function.name === 'write_research_prompts').function.parameters.properties;
  ok(w.referenceImages && w.referenceImages.type === 'array', 'write_research_prompts accepts attached pictures');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
