/**
 * tools/overseer_toolcall_test.mjs: offline tests for the Overseer's tool calling.
 * Run: node tools/overseer_toolcall_test.mjs
 *
 * No Electron, no network, no AI model. The real llm.js is loaded with a stubbed
 * `fetch`, and the real renderer modules are loaded into a Node VM with a stubbed
 * model, so every check runs the production code paths.
 *
 * Covered:
 *   - llm.js      : native `tools` go out and `tool_calls` come back; an endpoint that
 *                   rejects tools is remembered and re-asked with the JSON-envelope prompt
 *   - readReply   : the reply shapes small local models actually produce
 *   - the loop    : several reads per step, one action per step, empty-argument calls,
 *                   "claimed but not done" correction, stall limit, token budget
 *   - toolDefs    : every generated JSON Schema is well formed
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

// ---------------------------------------------------------------- llm.js transport
console.log('llm.js (native tools, JSON fallback)');
{
  const origLoad = Module._load;
  Module._load = function (req) {
    if (req === 'electron') return { net: null };
    // eslint-disable-next-line prefer-rest-params
    return origLoad.apply(this, arguments);
  };
  const llm = require('../src/main/llm.js');
  Module._load = origLoad;

  const prov = (id) => ({ id, name: id, kind: 'openai', enabled: true, vision: false, baseUrl: `https://${id}.example/v1`, apiKey: 'k', models: { overseer: `${id}-model` } });
  const settings = (ids) => ({ lmStudio: {}, providers: ids.map(prov), routing: { overseer: ids, fallbackLocal: false } });
  const tools = [{ type: 'function', function: { name: 'read_stats', description: 'd', parameters: { type: 'object', properties: {} } } }];
  const msgs = [{ role: 'system', content: 'NATIVE SYSTEM' }, { role: 'user', content: 'hi' }];
  const jsonFallback = { system: 'JSON SYSTEM', suffix: ' Reply with one JSON object.' };

  const calls = [];
  let behaviour = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const host = new URL(url).hostname.split('.')[0];
    const body = JSON.parse(init.body);
    calls.push({ host, body });
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
    const b = behaviour[host] || 'call';
    if (b === 'no-tools' && body.tools) return new Response('{"error":"this model does not support tools"}', { status: 400 });
    if (b === 'prose') return json({ choices: [{ message: { content: 'Nothing published yet.' } }], usage: {} });
    if (!body.tools) return json({ choices: [{ message: { content: '{"say":"env","tool":"read_stats","args":{},"done":false}' } }], usage: {} });
    return json({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_stats', arguments: '{"top": 3}' } }] } }], usage: {} });
  };
  try {
    let r = await llm.chat(settings(['a']), msgs, { role: 'overseer', tools, jsonMode: true, jsonFallback });
    ok(Array.isArray(calls[0].body.tools) && !calls[0].body.response_format, 'tools are sent, JSON mode is not sent alongside them');
    eq(r.toolCalls, [{ id: 'c1', name: 'read_stats', args: '{"top": 3}' }], 'tool_calls are read back');

    calls.length = 0; behaviour = { b: 'no-tools' };
    r = await llm.chat(settings(['b']), msgs, { role: 'overseer', tools, jsonMode: true, jsonFallback });
    eq(calls.map((c) => !!c.body.tools), [true, false], 'an endpoint that rejects tools is re-asked without them');
    eq(calls[1].body.messages[0].content, 'JSON SYSTEM', 'with the JSON-envelope system prompt');
    calls.length = 0;
    await llm.chat(settings(['b']), msgs, { role: 'overseer', tools, jsonMode: true, jsonFallback });
    eq(calls.map((c) => !!c.body.tools), [false], 'and the refusal is remembered for the next call');

    calls.length = 0; behaviour = { p: 'prose' };
    r = await llm.chat(settings(['p']), msgs, { role: 'overseer', tools, jsonMode: true, jsonFallback });
    ok(calls.length === 1 && r.text === 'Nothing published yet.', 'native prose is an answer, not a refusal');
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
State.persistLibrary = () => {};
State.persistQueue = () => {};

let replies = [];
const sent = [];
ctx.ala = {
  settings: { get: async () => State.settings, patch: async () => State.settings },
  db: { getOverseer: async () => ({ messages: [], runs: [] }), setOverseer: async () => true },
  app: { notify: async () => {} },
  llm: {
    chat: async (messages, opts) => {
      sent.push({ messages, opts });
      const next = replies.shift();
      const base = { engine: 'stub', provider: 'stub', model: 'm', promptTokens: 1000, completionTokens: 50, cachedTokens: 0 };
      if (next && next.__native) return { ...base, text: next.text || '', toolCalls: next.calls || [], nativeTools: true };
      return { ...base, text: typeof next === 'string' ? next : JSON.stringify(next), toolCalls: [], nativeTools: false };
    },
  },
};

function reset(proto = 'auto') {
  State.settings = structuredClone(DEFAULT_SETTINGS);
  State.settings.overseer.toolProtocol = proto;
  State.library = [];
  State.queue = [];
  Overseer.messages = [];
  Overseer.runs = [];
  Overseer.busy = false;
  Overseer._envelopeModels = new Set();
  replies = [];
  sent.length = 0;
}
reset();

console.log('readReply (what small models send)');
{
  const R = (text) => Overseer.readReply({ text, toolCalls: [], nativeTools: false });
  const one = (r) => [r.tool, r.args];
  eq(one(R('{"say":"ok","tool":"read_stats","args":{"top":3},"done":false}')), ['read_stats', { top: 3 }], 'the JSON envelope');
  eq(one(R('<tool_call>\n{"name": "list_cards", "arguments": {"filter": "review", "limit": "5"}}\n</tool_call>')), ['list_cards', { filter: 'review', limit: 5 }], '<tool_call> tags, "5" read as 5');
  eq(one(R('[TOOL_CALLS] [{"name": "read_stats", "arguments": {"top": 2}}]')), ['read_stats', { top: 2 }], '[TOOL_CALLS] form');
  eq(one(R('```json\n{"tool": "queueArt", "args": {"theme": "lighthouse", "count": "4", "first": "true",}}\n```')),
    ['queue_art', { theme: 'lighthouse', count: 4, first: true }], 'fenced, camelCase name, strings for numbers, trailing comma');
  eq(one(R('{"name": "read_stats", "arguments": "{\\"top\\": 3}"}')), ['read_stats', { top: 3 }], 'arguments as a JSON string');
  eq(one(R('{"say": "All done.", "tool": "null", "done": true}')), [null, {}], 'tool:"null" as a string is a finished turn');
  const prose = R('I would start with six forest pictures.');
  ok(prose.tool === null && !prose.needsRepair, 'plain prose is an answer');
  ok(R('{"say": "on it", "tool": "read_stats", "args": {top: 3}').needsRepair, 'a broken call gets one repair request');
}

console.log('the loop');
{
  reset('auto');
  replies = [
    { __native: true, calls: [{ name: 'read_stats', args: '{}' }, { name: 'read_playbook', args: '{}' }] },
    { __native: true, text: 'Nothing published yet.' },
  ];
  await Overseer.ask('what should I make today?');
  eq(Overseer.messages.filter((m) => m.role === 'tool').map((m) => m.tool), ['read_stats', 'read_playbook'], 'two reads run in one step');
  ok(Array.isArray(sent[0].opts.tools) && sent[0].opts.jsonFallback, 'tools go out with the envelope as fallback');

  reset('auto');
  const approved = [];
  Overseer.approve = async ({ ids }) => { approved.push(...ids); return { ok: true, approved: ids }; };
  replies = [
    { __native: true, calls: [{ name: 'approve', args: '{}' }] },
    { __native: true, calls: [{ name: 'approve', args: '{"ids":["c1","c2"]}' }] },
    { __native: true, text: 'Approved c1 and c2.' },
  ];
  await Overseer.ask('approve c1 and c2');
  ok(/needs ids/.test(Overseer.messages.find((m) => m.role === 'tool').text), 'an empty-argument call is answered with what is missing');
  eq(approved, ['c1', 'c2'], 'and the retried call runs');

  reset('auto');
  approved.length = 0;
  replies = [
    { __native: true, text: 'I have approved cards c1 and c2.' },
    { say: '', tool: 'approve', args: { ids: ['c1', 'c2'] }, done: false },
    { say: 'Approved.', tool: null, done: true },
  ];
  await Overseer.ask('approve c1 and c2');
  eq(approved, ['c1', 'c2'], 'a claimed-but-not-done action is corrected into the real call');
  ok(!sent[1].opts.tools, 'and that model drops to the JSON envelope');

  reset('json');
  let changed = null;
  Overseer.changePipeline = async (a) => { changed = a; return { ok: true, changed: a }; };
  replies = [
    { say: '', tool: 'pipeline_settings', args: { qcPassThreshold: 5 }, done: false },
    { say: 'Done.', tool: null, done: true },
  ];
  await Overseer.ask('pass threshold 5');
  eq(changed, { passThreshold: 5 }, 'a near-miss argument name is mapped to the real one');

  reset('json');
  State.settings.overseer.maxSteps = 30;
  replies = Array.from({ length: 30 }, () => ({ say: '', tool: 'make_magic', args: {}, done: false }));
  await Overseer.ask('go');
  eq(sent.length, 3, 'a model stuck on a missing tool stops after three steps');

  reset('json');
  State.settings.overseer.maxSteps = 30;
  State.settings.overseer.turnBudget = { tokens: 2500 };
  replies = Array.from({ length: 30 }, (_v, i) => ({ say: '', tool: 'read_state', args: { n: i }, done: false }));
  await Overseer.ask('go');
  eq(sent.length, 3, 'the token budget ends a long turn');
}

console.log('toolDefs');
{
  const defs = Overseer.toolDefs();
  ok(defs.length >= 20, `${defs.length} tools defined`);
  ok(defs.every((d) => d.type === 'function' && /^[a-z_]+$/.test(d.function.name) && d.function.parameters.type === 'object'), 'every definition is a valid function schema');
  const q = defs.find((d) => d.function.name === 'queue_art').function.parameters.properties;
  ok(q.mode.enum && q.count.type === 'number' && q.first.type === 'boolean', 'enums, numbers and booleans keep their types');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
