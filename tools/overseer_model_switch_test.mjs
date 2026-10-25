/**
 * overseer_model_switch_test.mjs — the Overseer engine bar and the set_model tool.
 *
 *   [1] llm.js    — modelInfo: the lead engine of a role, its thinking level and its context
 *                   window, read from what each kind of server reports (OpenRouter /models,
 *                   LM Studio /api/v0, llama.cpp /props, OpenRouter's catalogue as the label-
 *                   led fallback for a hosted API that reports nothing, a typed-in number).
 *   [2] setModel  — the switch itself (real overseer.js in a VM, real llm.js behind a stubbed
 *                   IPC, main's own deepPatch): routing order, per-role model, thinking,
 *                   CLI --effort, LM Studio, name matching, refusals, the per-turn cap.
 *   [3] the loop  — the agent calls set_model mid-turn and its next step's state block already
 *                   reports the new engine.
 *
 * Offline: fetch is stubbed; no Electron, no network, no spend.
 *
 *   node tools/overseer_model_switch_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
const ok = (cond, what, extra = '') => { if (cond) pass++; else { fail++; console.log('  FAIL ' + what + (extra ? ` — ${extra}` : '')); } };
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), what, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'electron') return { net: null };
  // eslint-disable-next-line prefer-rest-params
  return origLoad.apply(this, arguments);
};
const llm = require('../src/main/llm.js');
Module._load = origLoad;

// ------------------------------------------------------------------ fake servers
const hits = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = new URL(url);
  hits.push(`${u.host}${u.pathname}`);
  // OpenRouter (the user's provider AND the public catalogue share this host)
  if (u.host === 'openrouter.ai' && u.pathname === '/api/v1/models') {
    return json({ data: [
      { id: 'deepseek/deepseek-v4-flash-0731', context_length: 1048576, architecture: { input_modalities: ['text'] } },
      { id: 'deepseek/deepseek-v4-flash-vision-exp', context_length: 1048576, architecture: { input_modalities: ['text', 'image'] } },
      { id: 'anthropic/claude-sonnet-4.5', context_length: 1000000, architecture: { input_modalities: ['text', 'image'] } },
      { id: 'anthropic/claude-3.7-sonnet', context_length: 200000, architecture: { input_modalities: ['text', 'image'] } },
      { id: 'qwen/qwen3.8-27b', context_length: 262144, architecture: { input_modalities: ['text', 'image'] } },
    ] });
  }
  // DeepSeek's own API: a roster with no context field at all
  if (u.host === 'api.deepseek.com' && u.pathname === '/v1/models') return json({ data: [{ id: 'deepseek-v4-flash-vision-exp' }, { id: 'deepseek-v4-flash' }] });
  // LM Studio on :1234: /v1/models has no context, /api/v0 has the loaded one
  if (u.host === 'localhost:1234' && u.pathname === '/v1/models') return json({ data: [{ id: 'qwen3.8-27b' }] });
  if (u.host === 'localhost:1234' && u.pathname.startsWith('/api/v0/models/')) return json({ id: 'qwen3.8-27b', max_context_length: 262144, loaded_context_length: 32768 });
  // llama.cpp on :18020: /v1/models, then /props with the real n_ctx
  if (u.host === 'localhost:18020' && u.pathname === '/v1/models') return json({ data: [{ id: 'qwen3.8-27b' }] });
  if (u.host === 'localhost:18020' && u.pathname === '/props') return json({ default_generation_settings: { n_ctx: 98304 } });
  // a local server that reports nothing
  if (u.host === 'localhost:9999') return json({ data: [{ id: 'mystery' }] });
  return new Response('not found', { status: 404 });
};

// A stand-in Claude Code binary: the CLI path must exist for the route to accept it, and its
// name is what tells the app it takes --effort.
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acre-ms-'));
const FAKE_CLAUDE = path.join(fakeDir, 'claude.cmd');
fs.writeFileSync(FAKE_CLAUDE, '@echo {}');

const PROVIDERS = () => ([
  { id: 'or', name: 'OpenRouter', kind: 'openai', enabled: true, vision: false, baseUrl: 'https://openrouter.ai/api/v1', auth: 'key', apiKey: 'k',
    models: { overseer: 'deepseek/deepseek-v4-flash-0731', ideation: 'deepseek/deepseek-v4-flash-0731', vision: '' },
    reasoningEffort: { vision: 'auto', ideation: 'none', metadata: 'none', overseer: 'low' } },
  { id: 'ds', name: 'DeepseekOfficial', kind: 'openai', enabled: true, vision: true, baseUrl: 'https://api.deepseek.com/v1', auth: 'key', apiKey: 'k',
    models: { vision: 'deepseek-v4-flash-vision-exp', overseer: 'deepseek-v4-flash-vision-exp' },
    reasoningEffort: { vision: 'none', ideation: 'none', metadata: 'none', overseer: 'low' } },
  { id: 'dflash', name: 'LocalDflash2Qwen3.8-27b', kind: 'openai', enabled: true, vision: true, baseUrl: 'http://localhost:18020/v1', auth: 'none', apiKey: '',
    models: { vision: 'qwen3.8-27b', overseer: 'qwen3.8-27b' }, reasoningEffort: { overseer: 'low' } },
  { id: 'off', name: 'SwitchedOff', kind: 'openai', enabled: false, vision: true, baseUrl: 'https://off.example/v1', auth: 'key', apiKey: 'k', models: { overseer: 'x' } },
  { id: 'cc', name: 'Claude Code', kind: 'cli', enabled: true, vision: true, command: FAKE_CLAUDE, args: ['-p', '--output-format', 'json', '--model', '{{model}}'],
    roles: { vision: true, ideation: true, metadata: true, overseer: true } },
]);
const SETTINGS = () => ({
  providers: PROVIDERS(),
  routing: { overseer: ['or', 'ds', 'cc', 'dflash', 'local'], vision: ['ds', 'dflash', 'cc'], fallbackLocal: false },
  lmStudio: { baseUrl: 'http://localhost:1234/v1', apiKey: 'lm', model: 'qwen3.8-27b', models: { overseer: '' }, reasoningEffort: { vision: 'none', overseer: 'low' } },
  overseer: {},
});

// ====================================================================== [1] llm.js
console.log('[1] modelInfo: lead engine, thinking, context window');
{
  const s = SETTINGS();
  let i = await llm.modelInfo(s, 'overseer');
  eq([i.provider, i.model, i.effort, i.effortKind], ['OpenRouter', 'deepseek/deepseek-v4-flash-0731', 'low', 'http'], 'main = the first eligible link, with its model and thinking');
  eq([i.contextWindow, i.contextSource], [1048576, 'OpenRouter /models'], 'OpenRouter reports context_length on /models');
  ok(i.fallbacks.length >= 2 && /DeepseekOfficial/.test(i.fallbacks[0]), 'the rest of the chain is reported as fallbacks', JSON.stringify(i.fallbacks));

  i = await llm.modelInfo(s, 'vision');
  eq([i.provider, i.model, i.effort], ['DeepseekOfficial', 'deepseek-v4-flash-vision-exp', 'none'], 'vision = the vision route lead');
  eq([i.contextWindow, i.contextSource], [1048576, 'OpenRouter catalogue (same model name)'],
    'a hosted API with no context field falls back to OpenRouter\'s catalogue, and says so');

  const s2 = SETTINGS(); s2.providers[1].contextWindows = { 'deepseek-v4-flash-vision-exp': 131072 };
  i = await llm.modelInfo(s2, 'vision');
  eq([i.contextWindow, i.contextSource], [131072, 'set by you'], 'a typed-in window always wins');

  const s3 = SETTINGS(); s3.routing.overseer = ['local'];
  i = await llm.modelInfo(s3, 'overseer');
  eq([i.provider, i.model, i.contextWindow, i.contextSource], ['LM Studio (local)', 'qwen3.8-27b', 32768, 'LM Studio (loaded context)'],
    'LM Studio: the LOADED context, not the model maximum');

  const s4 = SETTINGS(); s4.routing.overseer = ['dflash'];
  i = await llm.modelInfo(s4, 'overseer');
  eq([i.contextWindow, i.contextSource], [98304, 'llama.cpp server (n_ctx)'], 'llama.cpp: n_ctx from /props');

  const s5 = SETTINGS(); s5.providers.push({ id: 'm', name: 'Mystery', kind: 'openai', enabled: true, baseUrl: 'http://localhost:9999/v1', auth: 'none', models: { overseer: 'mystery' } });
  s5.routing.overseer = ['m'];
  i = await llm.modelInfo(s5, 'overseer');
  ok(i.contextWindow === null && /click to set/.test(i.contextSource), 'a server that reports nothing gives null, never a guess', JSON.stringify(i));

  const s6 = SETTINGS(); s6.routing.overseer = ['cc']; s6.providers[4].args.push('--effort', 'high');
  i = await llm.modelInfo(s6, 'overseer');
  eq([i.provider, i.effortKind, i.effort, i.contextWindow], ['Claude Code', 'cli', 'high', null], 'Claude Code: thinking read from --effort; no context reported');

  const s7 = SETTINGS(); s7.providers.forEach((p) => { p.enabled = false; }); s7.routing.fallbackLocal = false; s7.routing.overseer = ['or'];
  s7.lmStudio.baseUrl = '';
  i = await llm.modelInfo({ ...s7, routing: { overseer: ['or'], fallbackLocal: false } }, 'overseer');
  ok(i.none === true && /switched off/.test(i.reason), 'nothing eligible → none, with the reasons', JSON.stringify(i));

  const cat = await llm.modelCatalog(SETTINGS(), 'or');
  const v = Object.fromEntries(cat.map((c) => [c.id, c.vision]));
  eq([v['deepseek/deepseek-v4-flash-0731'], v['anthropic/claude-sonnet-4.5']], [false, true], 'the catalogue says which models see images');
  const dcat = await llm.modelCatalog(SETTINGS(), 'ds');
  eq(dcat[0].vision, null, 'a roster without modalities says "not reported" (null), not "no"');
}

// ====================================================================== the renderer sandbox
const { DEFAULT_SETTINGS } = require(path.join(root, 'src/main/store.js'));
// main's own deepPatch, sliced out of main.js — the renderer's patches must merge the way the real IPC merges them.
const mainSrc = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
const dpStart = mainSrc.indexOf('function deepPatch(target, patchObj) {');
let depth = 0; let dpEnd = dpStart;
for (let k = mainSrc.indexOf('{', dpStart); k < mainSrc.length; k++) {
  if (mainSrc[k] === '{') depth++;
  if (mainSrc[k] === '}') { depth--; if (!depth) { dpEnd = k + 1; break; } }
}
const deepPatch = new Function(`${mainSrc.slice(dpStart, dpEnd)}; return deepPatch;`)();

const ctx = vm.createContext({
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  JSON, Math, Date, Object, Array, String, Number, Set, Map, RegExp, Promise, Error, structuredClone,
});
ctx.window = ctx;
ctx.globalThis = ctx;
for (const f of ['state.js', 'perchance.js', 'promptstyle.js', 'promptlab.js', 'titles.js', 'comfy.js', 'pipeline.js', 'overseer.js']) {
  new vm.Script(fs.readFileSync(path.join(root, 'src/renderer', f), 'utf8'), { filename: f }).runInContext(ctx);
}
const { State, Pipeline, Overseer } = ctx;
State.addLog = () => {};
State.bumpStats = () => {};
State.persistLibrary = () => {};
State.persistQueue = () => {};
Pipeline.start = () => { Pipeline.running = true; };

let chatReplies = [];
const chatCalls = [];
const patches = [];
ctx.ala = {
  settings: {
    get: async () => State.settings,
    // Through JSON both ways, like structured-clone over IPC.
    patch: async (p) => { patches.push(JSON.parse(JSON.stringify(p))); deepPatch(State.settings, JSON.parse(JSON.stringify(p))); return JSON.parse(JSON.stringify(State.settings)); },
  },
  db: { getOverseer: async () => ({ messages: [], runs: [], version: 1 }), setOverseer: async () => true, getTitles: async () => null, setTitles: async () => {} },
  da: { uploadReadiness: async () => ({ session: { ok: true } }) },
  app: { notify: async () => {} },
  files: { readImageBase64: async () => 'aW1n' },
  llm: {
    chat: async (messages, opts) => {
      chatCalls.push({ messages, opts });
      const next = chatReplies.shift();
      const base = { engine: 'stub', provider: 'stub', tier: 'cloud', model: 'm', promptTokens: 12000, completionTokens: 300, cachedTokens: 0 };
      if (next && next.__native) return { ...base, text: next.text || '', toolCalls: next.calls || [], nativeTools: true };
      return { ...base, text: typeof next === 'string' ? next : JSON.stringify(next || { say: 'ok', tool: null, done: true }), toolCalls: [], nativeTools: false };
    },
    vision: async () => { throw new Error('no vision'); },
    route: async (role) => llm.describeRoute(State.settings, role),
    modelInfo: async (role) => llm.modelInfo(JSON.parse(JSON.stringify(State.settings)), role),
    catalog: async (id) => llm.modelCatalog(JSON.parse(JSON.stringify(State.settings)), id),
  },
};

function resetWorld() {
  State.settings = { ...structuredClone(DEFAULT_SETTINGS), ...SETTINGS() };
  State.settings.overseer = { ...structuredClone(DEFAULT_SETTINGS.overseer), toolProtocol: 'auto' };
  State.library = []; State.queue = [];
  State.worker = { running: false, currentJobId: null, statusText: 'Idle', qcLane: 0 };
  State.llmLast = {};
  Overseer.messages = []; Overseer.runs = []; Overseer.busy = false; Overseer._engines = null; Overseer._turnModelSwitches = 0;
  chatReplies = []; chatCalls.length = 0; patches.length = 0;
}

// ====================================================================== [2] setModel
console.log('\n[2] setModel: the switch both the bar and the agent use');
{
  resetWorld();
  let r = await Overseer.setModel({ role: 'main', provider: 'DeepseekOfficial', model: 'deepseek-v4-flash' });
  ok(r.ok && r.changed, 'switching main to another provider + model works', JSON.stringify(r));
  eq(State.settings.routing.overseer, ['ds', 'or', 'cc', 'dflash', 'local'], 'the provider moves to the FRONT; the rest stays behind it in order');
  eq(State.settings.providers.find((p) => p.id === 'ds').models, { vision: 'deepseek-v4-flash-vision-exp', overseer: 'deepseek-v4-flash' }, 'only its overseer model changes');
  eq(State.settings.routing.vision, ['ds', 'dflash', 'cc'], 'the vision route is untouched by a main switch');
  ok(/DeepseekOfficial · deepseek-v4-flash/.test(r.to) && /OpenRouter/.test(r.from), 'the result says from → to', `${r.from} → ${r.to}`);
  eq(Overseer.engineSnapshot().main, 'DeepseekOfficial · deepseek-v4-flash', 'the state block reports the new main engine');

  r = await Overseer.setModel({ role: 'main', thinking: 'high' });
  eq(State.settings.providers.find((p) => p.id === 'ds').reasoningEffort, { vision: 'none', ideation: 'none', metadata: 'none', overseer: 'high' }, 'thinking alone changes the CURRENT lead\'s overseer effort only');
  eq(Overseer._engines.main.effort, 'high', 'and modelInfo reads it back');
  r = await Overseer.setModel({ role: 'main', thinking: 'off' });
  eq(State.settings.providers.find((p) => p.id === 'ds').reasoningEffort.overseer, 'none', '"off" means none');
  r = await Overseer.setModel({ role: 'main', thinking: 'max' });
  ok(r.ok && State.settings.providers.find((p) => p.id === 'ds').reasoningEffort.overseer === 'high' && /at most "high"/.test((r.notes || []).join()), 'an HTTP engine asked for max gets high, with a note');

  resetWorld();
  r = await Overseer.setModel({ role: 'main', provider: 'openrouter', model: 'sonnet 4.5' });
  ok(r.ok && State.settings.providers.find((p) => p.id === 'or').models.overseer === 'anthropic/claude-sonnet-4.5', 'a unique partial name is matched to the exact id', JSON.stringify(r));
  ok(/matched anthropic\/claude-sonnet-4\.5/.test((r.notes || []).join()), 'and the match is reported');
  r = await Overseer.setModel({ role: 'main', provider: 'OpenRouter', model: 'sonnet' });
  ok(!r.ok && r.candidates && r.candidates.length === 2, 'an ambiguous name returns the candidates instead of guessing', JSON.stringify(r));
  ok(State.settings.providers.find((p) => p.id === 'or').models.overseer === 'anthropic/claude-sonnet-4.5', 'and changes nothing');
  r = await Overseer.setModel({ role: 'main', provider: 'OpenRouter', model: 'gpt-9-ultra' });
  ok(!r.ok && Array.isArray(r.someModels), 'an unknown model is refused with a sample of real ids');
  r = await Overseer.setModel({ role: 'main', provider: 'OpenRouter', model: 'some/unlisted-model' }, { fromUi: true });
  ok(r.ok && State.settings.providers.find((p) => p.id === 'or').models.overseer === 'some/unlisted-model', 'the artist typing an exact unlisted id himself is accepted', JSON.stringify(r));
  // Live 10-23: DeepSeek's /models omits the experimental vision model the app already uses.
  State.settings.providers.find((p) => p.id === 'ds').models.vision = 'deepseek-unlisted-exp';
  r = await Overseer.setModel({ role: 'main', provider: 'DeepseekOfficial', model: 'DEEPSEEK-unlisted-exp' });
  ok(r.ok && State.settings.providers.find((p) => p.id === 'ds').models.overseer === 'deepseek-unlisted-exp',
    'a model the provider is already configured with (another role) is accepted even when its roster leaves it out', JSON.stringify(r));

  resetWorld();
  r = await Overseer.setModel({ role: 'vision', provider: 'OpenRouter', model: 'deepseek/deepseek-v4-flash-vision-exp' });
  ok(!r.ok && /text-only/.test(r.error), 'a text-only provider cannot become the vision model', r.error);
  r = await Overseer.setModel({ role: 'main', provider: 'SwitchedOff' });
  ok(!r.ok && /switched off/.test(r.error), 'a switched-off provider is refused (it is not silently switched on)', r.error);
  r = await Overseer.setModel({ role: 'main', provider: 'Nonexistent' });
  ok(!r.ok && Array.isArray(r.providers) && r.providers.length >= 4, 'an unknown provider name lists the real ones');
  eq(State.settings.routing.overseer, ['or', 'ds', 'cc', 'dflash', 'local'], 'refusals leave the routing alone');
  eq(patches.length, 0, 'and write nothing');

  // vision: the catalogue saying "text only" refuses the model even on a vision provider
  State.settings.providers[0].vision = true;
  r = await Overseer.setModel({ role: 'vision', provider: 'OpenRouter', model: 'deepseek/deepseek-v4-flash-0731' });
  ok(!r.ok && /cannot see images/.test(r.error), 'a model the catalogue lists as text-only cannot be the vision model', r.error);
  r = await Overseer.setModel({ role: 'eyes', provider: 'OpenRouter', model: 'deepseek-v4-flash-vision-exp' });
  ok(r.ok && State.settings.routing.vision[0] === 'or' && State.settings.providers[0].models.vision === 'deepseek/deepseek-v4-flash-vision-exp', 'the vision switch: route front + models.vision ("eyes" = vision)', JSON.stringify(r));
  eq(State.settings.routing.overseer[0], 'or', 'and the main route is untouched');
  eq(Overseer._engines.vision.provider, 'OpenRouter', 'modelInfo now reports the new vision engine');

  // CLI: thinking is --effort in the args
  resetWorld();
  r = await Overseer.setModel({ role: 'main', provider: 'Claude Code', model: 'sonnet', thinking: 'high' });
  const cc = () => State.settings.providers.find((p) => p.id === 'cc');
  ok(r.ok && State.settings.routing.overseer[0] === 'cc', 'the CLI becomes the lead', JSON.stringify(r));
  eq(cc().args.slice(-2), ['--effort', 'high'], 'Claude Code thinking goes in as --effort');
  eq(cc().models.overseer, 'sonnet', 'and a CLI model alias is kept as typed (no roster to check)');
  await Overseer.setModel({ role: 'main', thinking: 'xhigh' });
  eq(cc().args.filter((a) => a === '--effort').length, 1, 'a second change replaces the flag instead of adding another');
  eq(cc().args.slice(-1)[0], 'xhigh', 'xhigh is allowed for Claude Code');
  await Overseer.setModel({ role: 'main', thinking: 'auto' });
  ok(!cc().args.includes('--effort'), 'auto removes the flag (CLI default)');
  r = await Overseer.setModel({ role: 'main', thinking: 'none' });
  ok(r.ok && cc().args.slice(-1)[0] === 'low' && /used low/.test((r.notes || []).join()), 'Claude Code has no "off": none becomes low, with a note');
  eq(cc().args.slice(0, 5), ['-p', '--output-format', 'json', '--model', '{{model}}'], 'the rest of the CLI arguments are untouched');

  // LM Studio (local)
  resetWorld();
  r = await Overseer.setModel({ role: 'main', provider: 'LM Studio', model: 'qwen3.8-27b', thinking: 'medium' });
  ok(r.ok && State.settings.routing.overseer[0] === 'local', 'LM Studio (local) can be picked by name', JSON.stringify(r));
  eq(State.settings.lmStudio.models.overseer, 'qwen3.8-27b', 'its overseer model is lmStudio.models.overseer');
  eq(State.settings.lmStudio.reasoningEffort, { vision: 'none', overseer: 'medium' }, 'its thinking merges into lmStudio.reasoningEffort');
  eq(Overseer._engines.main.contextWindow, 32768, 'and the context window follows the switch');

  // no arguments = a read
  resetWorld();
  r = await Overseer.setModel({});
  ok(r.ok && !r.changed && /OpenRouter/.test(r.current) && r.providers.some((x) => /Claude Code/.test(x)), 'no arguments lists the current engine and the providers', JSON.stringify(r));
  eq(patches.length, 0, 'and writes nothing');
  r = await Overseer.setModel({ role: 'vision' });
  ok(!r.providers.some((x) => /^OpenRouter/.test(x)), 'the vision list leaves out text-only providers');

  // typed context window
  resetWorld();
  await Overseer.refreshEngines();
  await Overseer.setContextWindow(200000);
  eq(State.settings.providers.find((p) => p.id === 'or').contextWindows, { 'deepseek/deepseek-v4-flash-0731': 200000 }, 'a typed window is saved per model');
  eq([Overseer._engines.main.contextWindow, Overseer._engines.main.contextSource], [200000, 'set by you'], 'and wins over the provider\'s number');
  await Overseer.setContextWindow(0);
  eq(Overseer._engines.main.contextWindow, 1048576, 'blank/0 goes back to what the provider reports');

  // the agent's per-turn cap
  resetWorld();
  const names = ['DeepseekOfficial', 'OpenRouter', 'DeepseekOfficial', 'OpenRouter'];
  const res = [];
  for (const n of names) res.push(await Overseer.setModelTool({ role: 'main', provider: n }));
  eq(res.map((x) => x.ok), [true, true, true, false], 'set_model: three switches per turn, then it is told to finish with what it has');
  ok(/3 times/.test(res[3].error), 'with a reason');
  ok((await Overseer.setModelTool({})).ok, 'a read (no arguments) is never capped');

  // the tool is registered as an ACTION with a usable schema
  const t = Overseer.TOOLS.set_model;
  ok(t && !t.reads, 'set_model is an acting tool, not a read');
  const def = Overseer.toolDefs().find((d) => d.function.name === 'set_model');
  eq(def.function.parameters.properties.role.enum, ['main', 'vision'], 'role is an enum main|vision in the native schema');
  ok(def.function.parameters.properties.thinking.enum.includes('xhigh'), 'thinking lists every level');
}

// ====================================================================== [3] the loop
console.log('\n[3] the agent switches its own model mid-turn');
{
  resetWorld();
  chatReplies = [
    { __native: true, text: 'Switching to Sonnet.', calls: [{ name: 'set_model', args: '{"role":"main","provider":"OpenRouter","model":"sonnet 4.5","thinking":"low"}' }] },
    { __native: true, text: 'Done — I am on Claude Sonnet 4.5 now.' },
  ];
  await Overseer.ask('switch yourself to claude sonnet 4.5');
  const row = Overseer.messages.find((m) => m.role === 'tool' && m.tool === 'set_model');
  ok(row && /"ok":true/.test(row.text) && /claude-sonnet-4\.5/.test(row.text), 'the switch ran and its receipt is in the transcript', row && row.text);
  const stateOf = (call) => JSON.parse(call.messages[call.messages.length - 1].content.replace(/^CURRENT STATE\n/, '').split('\n\nThat block')[0]);
  const s1 = stateOf(chatCalls[0]);
  const s2 = stateOf(chatCalls[1]);
  eq(s1.models.main, 'OpenRouter · deepseek/deepseek-v4-flash-0731', 'step 1 state block: the old engine');
  eq(s2.models.main, 'OpenRouter · anthropic/claude-sonnet-4.5', 'step 2 state block: already the new engine');
  eq([s2.models.thinking, s2.models.contextWindow], ['low', 1000000], 'with its thinking and context window');
  ok(s2.models.vision && /DeepseekOfficial/.test(s2.models.vision), 'and the vision engine');
  ok(/set_model switches either one/.test(chatCalls[0].messages[0].content), 'the system prompt explains the engines in one line');
  eq(Overseer._turnModelSwitches, 0, 'the per-turn counter resets when the turn ends');
}

globalThis.fetch = realFetch;
fs.rmSync(fakeDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
