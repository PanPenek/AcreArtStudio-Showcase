/**
 * llm.js: chat + vision calls against any number of AI providers.
 *
 * Every call belongs to a ROLE (ideation, metadata, vision QC, overseer), and every
 * role has its own ordered chain of providers: e.g. "a hosted API first, the local
 * LM Studio model as a fallback". `withFallback` walks that chain and returns the
 * first genuine answer, recording which provider produced it so the UI can show it.
 *
 * Two kinds of provider:
 *   openai: any OpenAI-compatible HTTP endpoint (LM Studio, Ollama, OpenRouter...)
 *   cli:    an AI command-line tool already installed and signed in on the machine,
 *           run as a child process (see clibridge.js)
 * Refusals, moderation blocks, rate limits and dead endpoints are detected and
 * skipped, so one flaky provider never stops the pipeline.
 */
const { net } = require('electron');
const { runCli, probeCommand } = require('./clibridge');
const longFetch = (url, init) => (net && net.fetch ? net.fetch(url, init) : fetch(url, init));

const ROLES = ['vision', 'ideation', 'metadata', 'overseer'];

class LlmError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status || 0;
    this.body = body || '';
  }
}

/** The local tier, as a provider record. */
function localProvider(settings) {
  const cfg = (settings && settings.lmStudio) || {};
  return {
    id: 'local',
    name: 'LM Studio (local)',
    tier: 'local',
    enabled: true,
    vision: true,
    baseUrl: String(cfg.baseUrl || 'http://localhost:1234/v1').replace(/\/$/, ''),
    apiKey: cfg.apiKey || 'lm-studio',
    models: { ...(cfg.models || {}) },
    defaultModel: cfg.model || '',
    timeoutSec: cfg.requestTimeoutSec || 1800,
    maxConcurrency: 1,
    maxOutputTokens: Number(cfg.maxOutputTokens) || Number(cfg.visionMaxTokens) || 12000,
    reasoningEffort: normalizeEffort(cfg.reasoningEffort || { vision: 'auto', ideation: 'auto', metadata: 'auto', overseer: 'auto' }),
  };
}

/** Resolve a provider's API key. */
function resolveKey(p) {
  if (p.apiKeyEnv) return process.env[p.apiKeyEnv] || '';
  if (p.apiKey) return p.apiKey;
  if (p.legacy) return process.env.ALA_CLOUD_API_KEY || '';
  return '';
}

function cloudProviders(settings) {
  return ((settings && settings.providers) || [])
    .filter((p) => p && p.id && p.id !== 'local')
    .map((p) => {
      const kind = p.kind === 'cli' ? 'cli' : 'openai';
      return {
        id: String(p.id),
        name: String(p.name || p.command || p.baseUrl || p.id),
        kind,
        tier: kind === 'cli' ? 'sub' : 'cloud',
        enabled: p.enabled !== false,
        vision: !!p.vision,
        baseUrl: String(p.baseUrl || '').replace(/\/$/, ''),
        auth: p.auth === 'none' ? 'none' : 'key',
        apiKey: resolveKey(p),
        apiKeyEnv: p.apiKeyEnv || '',
        headers: (p.headers && typeof p.headers === 'object') ? { ...p.headers } : {},
        command: String(p.command || '').trim(),
        args: Array.isArray(p.args) ? p.args.map(String) : (p.args ? String(p.args).split(/\s+/).filter(Boolean) : []),
        promptVia: p.promptVia === 'arg' ? 'arg' : 'stdin',
        cwd: String(p.cwd || ''),
        env: (p.env && typeof p.env === 'object') ? { ...p.env } : {},
        /** Which roles a CLI provider is allowed to serve, ticked explicitly. */
        roles: (p.roles && typeof p.roles === 'object') ? { ...p.roles } : {},
        models: { ...(p.models || {}) },
        defaultModel: p.model || '',
        timeoutSec: Number(p.timeoutSec) || (kind === 'cli' ? 300 : 60),
        maxConcurrency: Math.max(1, Number(p.maxConcurrency) || (kind === 'cli' ? 2 : 4)),
        maxOutputTokens: Number(p.maxOutputTokens) > 0 ? Number(p.maxOutputTokens) : 8192,
        reasoningEffort: normalizeEffort(p.reasoningEffort),
      };
    });
}

const allProviders = (settings) => [localProvider(settings), ...cloudProviders(settings)];

const modelFor = (p, role) => (role && p.models && p.models[role]) || p.defaultModel || '';

/** Why this provider cannot serve this role, or null when it can. */
function ineligible(p, role) {
  if (!p.enabled) return 'switched off';
  if (role === 'vision' && !p.vision) return 'text-only provider';
  if (p.kind === 'cli') {
    if (!p.command) return 'no command set';
    if (!p.roles || !p.roles[role]) return 'not switched on for this role';
    const probe = probeCommand(p.command);
    if (!probe.ok) return probe.error;
    return null;
  }
  if (!p.baseUrl) return 'no base URL';
  if (p.auth !== 'none' && !p.apiKey) return p.apiKeyEnv ? `${p.apiKeyEnv} is not set` : 'no API key';
  if (!modelFor(p, role)) return 'no model set for this role';
  return null;
}

const toEndpoint = (p, role) => ({
  id: p.id,
  name: p.name,
  kind: p.kind || 'openai',
  tier: p.tier,
  baseUrl: p.baseUrl,
  apiKey: p.apiKey,
  auth: p.auth,
  headers: p.headers,
  command: p.command,
  args: p.args,
  promptVia: p.promptVia,
  cwd: p.cwd,
  env: p.env,
  model: modelFor(p, role),
  vision: !!p.vision,
  timeoutSec: p.timeoutSec,
  maxConcurrency: p.maxConcurrency,
  maxOutputTokens: p.maxOutputTokens,
  reasoningEffort: effortFor(p, role),
});

/** The ordered list of endpoints to try for a role. */
function chainFor(settings, role) {
  const all = allProviders(settings);
  const byId = new Map(all.map((p) => [p.id, p]));
  const routing = (settings && settings.routing) || {};
  const order = Array.isArray(routing[role]) ? routing[role].map(String) : [];

  const picked = [];
  const seen = new Set();
  const take = (p) => { if (p && !seen.has(p.id)) { seen.add(p.id); picked.push(p); } };

  for (const id of order) take(byId.get(id));
  for (const p of all) if (p.id !== 'local') take(p);
  if (!seen.has('local') && routing.fallbackLocal !== false) take(byId.get('local'));

  return picked.filter((p) => !ineligible(p, role)).map((p) => toEndpoint(p, role));
}

/** The same walk, but reporting what was skipped and why — this is what the UI renders. */
function describeRoute(settings, role) {
  const all = allProviders(settings);
  const byId = new Map(all.map((p) => [p.id, p]));
  const routing = (settings && settings.routing) || {};
  const order = Array.isArray(routing[role]) ? routing[role].map(String) : [];

  const seq = [];
  const seen = new Set();
  const take = (p) => { if (p && !seen.has(p.id)) { seen.add(p.id); seq.push(p); } };
  for (const id of order) take(byId.get(id));
  for (const p of all) if (p.id !== 'local') take(p);
  if (!seen.has('local') && routing.fallbackLocal !== false) take(byId.get('local'));

  const ordered = seq.map((p) => {
    const reason = ineligible(p, role);
    return {
      id: p.id, name: p.name, tier: p.tier, kind: p.kind || 'openai', model: modelFor(p, role),
      vision: !!p.vision,
      command: p.command || '',
      maxConcurrency: p.maxConcurrency, timeoutSec: p.timeoutSec,
      eligible: !reason, reason,
      refusals: refusals.get(circuitKey(p.id, role)) || 0,
      open: circuitOpen(p.id, role),
    };
  });
  const chain = ordered.filter((x) => x.eligible);
  const skipped = ordered.filter((x) => !x.eligible);
  return {
    role,
    order: ordered,
    chain,
    skipped,
    maxConcurrency: chain.length ? chain[0].maxConcurrency : 1,
    leadTier: chain.length ? chain[0].tier : null,
    cloudFirst: !!(chain.length && chain[0].tier !== 'local'),
    usesCloud: chain.some((c) => c.tier !== 'local'),
    vision: chain.some((c) => c.vision),
    visionProviders: chain.filter((c) => c.vision).map((c) => c.name),
  };
}

/** Does any message carry an image part (OpenAI `image_url` content)? */
function hasImages(messages) {
  return (messages || []).some((m) => Array.isArray(m && m.content)
    && m.content.some((p) => p && p.type === 'image_url'));
}

/** The same conversation with every picture replaced by a sentence saying one was there. */
function stripImages(messages) {
  return (messages || []).map((m) => {
    if (!m || !Array.isArray(m.content)) return m;
    const text = m.content.map((p) => {
      if (!p) return '';
      if (p.type === 'text') return p.text || '';
      if (p.type === 'image_url') return '[An image was attached here, but the model answering now cannot see images. Say so if the request depends on it.]';
      return '';
    }).filter(Boolean).join('\n');
    return { ...m, content: text };
  });
}

/** Did the model decline instead of answering? */
function isRefusal(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  try { extractJson(s); return false; } catch { }
  return /\b(can'?t|cannot|won'?t|unable to)\b[^.]{0,40}\b(assist|help|comply|provide|analyz|describe|process)|i'?m sorry|i apologi[sz]e|content polic|guidelines|not able to (assist|help|process)|as an ai/i.test(s);
}

const REFUSAL_FRAME = /\b(?:can(?:no|['\u2019])?t|cannot|won['\u2019]?t|unable to|not able to|not allowed to|not going to|outside what|against my)\b/i;
const CONTENT_OBJECT = /\b(?:restricted content|unsafe content|content policy)\b/i;
const POLICY_OBJECT = /\b(?:content polic|usage polic|community guidelines|my guidelines|(?:allowed|able) to (?:produce|generate|create|make|do)|what i['\u2019]?m allowed|as an ai)\b/i;
const OPERATIONAL = /\b(?:approv\w*|upload|publish|post(?:ing)?|deviantart|pixiv|patreon|queue|theme|card|deviation|credential|signed in|logged in|gate)\b/i;

function isPolicyRefusal(text) {
  let obj;
  try { obj = extractJson(text); } catch { return false; }
  if (!obj || typeof obj !== 'object') return false;
  if (obj.tool) return false;
  const said = [obj.say, obj.message, obj.error, obj.reason, obj.note]
    .filter((v) => typeof v === 'string')
    .join(' ');
  return saysPolicyRefusal(said);
}

function saysPolicyRefusal(said) {
  if (!REFUSAL_FRAME.test(said)) return false;
  const content = CONTENT_OBJECT.test(said);
  if (!content && OPERATIONAL.test(said)) return false;
  return content || POLICY_OBJECT.test(said);
}

/**
 * The same questions for a reply made through native tool calling, where a finished
 * answer is plain prose by design. Only an empty reply, or prose that declines the
 * request, counts as a refusal.
 */
function isNativeRefusal(text) {
  return !String(text || '').trim();
}
function isNativePolicyRefusal(text) {
  return saysPolicyRefusal(String(text || '').slice(0, 1500));
}
/** Is a 4xx body a moderation block, or a configuration mistake? */
function looksModerated(body) {
  return /content[_ -]?polic|moderat|safety|violat|flagged|prohibited|not allowed|inappropriate/i
    .test(String(body || ''));
}

const CONTENT_REFUSAL_KEEPS_CIRCUIT_SHUT = new Set(['overseer', 'ideation']);

const REFUSAL_LIMIT = 3;
const refusals = new Map();
const circuitKey = (providerId, role) => `${role || 'any'}::${providerId}`;
const circuitOpen = (providerId, role) => (refusals.get(circuitKey(providerId, role)) || 0) >= REFUSAL_LIMIT;
function noteRefusal(providerId, role) {
  const k = circuitKey(providerId, role);
  refusals.set(k, (refusals.get(k) || 0) + 1);
}
function resetCircuit(providerId, role) {
  if (!providerId) return refusals.clear();
  if (!role) {
    for (const k of [...refusals.keys()]) if (k.endsWith(`::${providerId}`)) refusals.delete(k);
    return;
  }
  refusals.delete(circuitKey(providerId, role));
}

const EFFORT_DEFAULTS = { vision: '', ideation: 'none', metadata: 'none', overseer: 'none' };
const EFFORT_VALUES = new Set(['', 'auto', 'none', 'minimal', 'low', 'medium', 'high']);

/**
 * Accepts what a hand-edited settings.json might plausibly hold: nothing, one string for every
 * role, or a per-role object.
 */
function normalizeEffort(raw) {
  const clean = (v, fallback) => {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (v == null || s === '') return fallback;
    if (!EFFORT_VALUES.has(s)) return fallback;
    return s === 'auto' ? '' : s;
  };
  if (raw && typeof raw === 'object') {
    return {
      vision: clean(raw.vision, EFFORT_DEFAULTS.vision),
      ideation: clean(raw.ideation, EFFORT_DEFAULTS.ideation),
      metadata: clean(raw.metadata, EFFORT_DEFAULTS.metadata),
      overseer: clean(raw.overseer, EFFORT_DEFAULTS.overseer),
    };
  }
  if (typeof raw === 'string' && raw.trim()) {
    const one = clean(raw, null);
    if (one !== null) return { vision: one, ideation: one, metadata: one, overseer: one };
  }
  return { ...EFFORT_DEFAULTS };
}

const effortFor = (p, role) => (p.reasoningEffort && p.reasoningEffort[role]) || '';

const noEffortSupport = new Set();
const effortKey = (ep) => `${ep.baseUrl}::${ep.model}`;
const supportsEffort = (ep) => !!ep.reasoningEffort && !noEffortSupport.has(effortKey(ep));

const noJsonModeSupport = new Set();
const supportsJsonMode = (ep) => !noJsonModeSupport.has(effortKey(ep));

/**
 * Native tool calling, discovered per endpoint. Ollama answers 400 "does not support
 * tools", llama.cpp needs --jinja, and some gateways answer 404 for models without tool
 * support. The first such refusal is remembered per baseUrl+model and the request is
 * re-sent without `tools`, using the caller's JSON-envelope prompt instead.
 */
const noToolSupport = new Set();
const supportsTools = (ep) => ep.kind !== 'cli' && !noToolSupport.has(effortKey(ep));
const TOOLS_REJECTED = /\btools?\b|tool[._ -]?choice|function[._ -]?call|--jinja|jinja/i;

/** Tool calls from an OpenAI-style message as `{ id, name, args }` (args still raw). */
function readToolCalls(msg) {
  const out = [];
  const list = Array.isArray(msg && msg.tool_calls) ? msg.tool_calls : [];
  for (const c of list) {
    const fn = c && (c.function || c);
    if (fn && typeof fn.name === 'string' && fn.name.trim()) {
      out.push({ id: String((c && c.id) || ''), name: fn.name.trim(), args: fn.arguments == null ? '{}' : fn.arguments });
    }
  }
  if (!out.length && msg && msg.function_call && msg.function_call.name) {
    out.push({ id: '', name: String(msg.function_call.name).trim(), args: msg.function_call.arguments == null ? '{}' : msg.function_call.arguments });
  }
  return out;
}

/** The same intent, two spellings. */
const usesReasoningObject = (ep) => {
  try { return /(^|\.)openrouter\.ai$/i.test(new URL(ep.baseUrl).hostname); } catch { return false; }
};
const effortField = (ep, effort) => {
  if (!effort) return {};
  return usesReasoningObject(ep) ? { reasoning: { effort } } : { reasoning_effort: effort };
};

const JSON_MODE_REJECTED = /response[._ -]?format|\bjson[._ -]?object\b|\bjson_schema\b/i;

const EFFORT_REJECTED = /reasoning[._ -]?effort|\breasoning\b[^.]{0,40}\b(?:unsupported|unrecognized|not supported|not recognized|invalid|unknown)/i;

/**
 * The request as it should read when `tools` will not be sent: the caller's JSON-envelope
 * system prompt, plus an optional reminder on the last user message. Applied per endpoint,
 * so one routing chain can mix engines with and without a tools API.
 */
function applyJsonFallback(messages, fb) {
  if (!fb || !Array.isArray(messages)) return messages;
  const out = messages.map((m) => ({ ...m }));
  if (fb.system && out[0] && out[0].role === 'system') out[0].content = fb.system;
  const last = out[out.length - 1];
  if (fb.suffix && last && typeof last.content === 'string') last.content = `${last.content}${fb.suffix}`;
  return out;
}

async function callChat(endpoint, messages, { temperature, maxTokens, jsonMode, tools, jsonFallback } = {}) {
  if (endpoint.kind === 'cli') {
    try {
      return await runCli(endpoint, applyJsonFallback(messages, jsonFallback), { timeoutSec: endpoint.timeoutSec });
    } catch (e) {
      throw new LlmError(e.message, 0, e.message);
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), endpoint.timeoutSec * 1000);
  const want = maxTokens ?? 2048;
  const capped = endpoint.maxOutputTokens ? Math.min(want, endpoint.maxOutputTokens) : want;
  try {
    const post = (effort, useJsonMode, useTools) => longFetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(endpoint.auth === 'none' && !endpoint.apiKey ? {} : { Authorization: `Bearer ${endpoint.apiKey}` }),
        ...(endpoint.headers || {}),
      },
      body: JSON.stringify({
        model: endpoint.model,
        messages: useTools ? messages : applyJsonFallback(messages, jsonFallback),
        temperature: temperature ?? 0.8,
        max_tokens: capped,
        ...effortField(endpoint, effort),
        // JSON mode and tools are exclusive; several servers reject the pair.
        ...(useTools ? { tools, tool_choice: 'auto' } : {}),
        ...(useJsonMode && !useTools ? { response_format: { type: 'json_object' } } : {}),
      }),
    });

    const wanted = supportsEffort(endpoint) ? endpoint.reasoningEffort : '';
    const wantTools = Array.isArray(tools) && tools.length > 0 && supportsTools(endpoint);
    const wantJson = !!jsonMode && supportsJsonMode(endpoint);
    let effortNow = wanted;
    let toolsNow = wantTools;
    let jsonNow = wantJson;
    let resp = await post(effortNow, jsonNow, toolsNow);
    if (effortNow && resp.status === 400) {
      const probe = await resp.clone().text().catch(() => '');
      if (EFFORT_REJECTED.test(probe)) {
        noEffortSupport.add(effortKey(endpoint));
        effortNow = '';
        resp = await post(effortNow, jsonNow, toolsNow);
      }
    }
    // No tools API here (or not for this model): fall back to the JSON envelope.
    if (toolsNow && [400, 404, 422, 500, 501].includes(resp.status)) {
      const probe = await resp.clone().text().catch(() => '');
      if (TOOLS_REJECTED.test(probe)) {
        noToolSupport.add(effortKey(endpoint));
        toolsNow = false;
        resp = await post(effortNow, jsonNow, toolsNow);
      }
    }
    if (jsonNow && !toolsNow && resp.status === 400) {
      const probe = await resp.clone().text().catch(() => '');
      if (JSON_MODE_REJECTED.test(probe)) {
        noJsonModeSupport.add(effortKey(endpoint));
        jsonNow = false;
        resp = await post(effortNow, jsonNow, toolsNow);
      }
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new LlmError(`${endpoint.name} ${resp.status}: ${text.slice(0, 300)}`, resp.status, text);
    }
    const data = await resp.json();
    const choice = data.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    const answer = (msg.content || '').trim();
    const text = answer || (msg.reasoning_content || '');
    const finishReason = choice.finish_reason || choice.finishReason || '';
    const toolCalls = toolsNow ? readToolCalls(msg) : [];
    const fromReasoning = !answer && !!msg.reasoning_content && !toolCalls.length;
    const u = data.usage || {};
    return {
      text: toolCalls.length && !answer ? '' : text,
      finishReason,
      fromReasoning,
      toolCalls,
      nativeTools: toolsNow,
      truncated: finishReason === 'length',
      promptTokens: u.prompt_tokens || 0,
      completionTokens: u.completion_tokens || 0,
      cachedTokens: u.prompt_cache_hit_tokens
        || (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens)
        || 0,
    };
  } catch (e) {
    if (e instanceof LlmError) throw e;
    if (e.name === 'AbortError') throw new LlmError(`${endpoint.name} timed out after ${endpoint.timeoutSec}s`, 0);
    throw new LlmError(`${endpoint.name} request failed: ${e.message}`, 0);
  } finally {
    clearTimeout(timeout);
  }
}

const isRetryableStatus = (s) => s === 408 || s === 409 || s === 425 || s === 429 || (s >= 500 && s <= 599);

/** One provider's turn: the call, plus a single retry on a transient status. */
async function attempt(endpoint, messages, opts) {
  try {
    return { ok: true, result: await callChat(endpoint, messages, opts) };
  } catch (e) {
    if (isRetryableStatus(e.status)) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        return { ok: true, result: await callChat(endpoint, messages, opts) };
      } catch (e2) {
        return { ok: false, note: `${endpoint.name} ${e2.status || 'error'}`, refused: false, error: e2 };
      }
    }
    if ((e.status === 400 || e.status === 403 || e.status === 422) && looksModerated(e.body)) {
      return { ok: false, note: `${endpoint.name} refused`, refused: true, error: e };
    }
    return { ok: false, note: `${endpoint.name} ${e.status || 'error'}`, refused: false, error: e };
  }
}

/** Walk the role's chain and return the first genuine answer. */
async function withFallback(settings, role, buildMessages, opts) {
  let chain = chainFor(settings, role);
  if (!chain.length) {
    throw new LlmError(`no provider is configured for the ${role || 'chat'} role — check Settings → Providers & routing`, 0);
  }
  const notes = [];
  let lastError = null;
  const withPictures = role !== 'vision' && hasImages(buildMessages(chain[0]));
  if (withPictures) {
    const seeing = chain.filter((ep) => ep.vision);
    const blind = chain.filter((ep) => !ep.vision);
    chain = [...seeing, ...blind.map((ep) => ({ ...ep, _stripImages: true }))];
  }
  const rerouteOnPolicy = !(settings && settings.routing && settings.routing.rerouteOnPolicyRefusal === false);

  for (const ep of chain) {
    if (circuitOpen(ep.id, role)) {
      notes.push(`${ep.name} refused ${REFUSAL_LIMIT}x, skipped`);
      continue;
    }
    const t0 = Date.now();
    const built = buildMessages(ep);
    const r = await attempt(ep, ep._stripImages ? stripImages(built) : built, opts);
    // A tool call is an answer. A native-tools reply without one is prose on purpose.
    const called = r.ok && Array.isArray(r.result.toolCalls) && r.result.toolCalls.length > 0;
    const native = r.ok && r.result.nativeTools === true;
    const declinedOnContent = r.ok && !called && rerouteOnPolicy
      && (native ? isNativePolicyRefusal(r.result.text) : isPolicyRefusal(r.result.text));
    const refusedNow = r.ok && !called && (native ? isNativeRefusal(r.result.text) : isRefusal(r.result.text));
    if (r.ok && !refusedNow && !declinedOnContent) {
      resetCircuit(ep.id, role);
      const base = ep.tier === 'local' ? 'local' : ep.name;
      return {
        ...r.result,
        engine: notes.length ? `${base} (after ${notes.join(', ')})` : base,
        provider: ep.name,
        providerId: ep.id,
        tier: ep.tier,
        model: ep.model,
        latencyMs: Date.now() - t0,
        notes,
        sawImages: withPictures ? !ep._stripImages : null,
      };
    }
    if (r.ok) {
      if (declinedOnContent) {
        notes.push(`${ep.name} declined on content`);
      } else {
        noteRefusal(ep.id, role);
        notes.push(`${ep.name} refused`);
      }
    } else {
      if (r.refused && !(rerouteOnPolicy && CONTENT_REFUSAL_KEEPS_CIRCUIT_SHUT.has(role))) {
        noteRefusal(ep.id, role);
      }
      notes.push(r.note);
      lastError = r.error || lastError;
    }
  }

  const body = lastError && lastError.body ? String(lastError.body).trim().slice(0, 200) : '';
  throw new LlmError(
    `every provider failed the ${role || 'chat'} request — ${notes.join('; ')}`
    + (body ? ` — last response: ${body}` : ''),
    lastError ? lastError.status : 0,
    lastError ? lastError.body : ''
  );
}

async function chat(settings, messages, opts = {}) {
  const { role, ...rest } = opts;
  return withFallback(settings, role, () => messages, rest);
}

/** Vision call. imageBase64 = raw base64 (no prefix). mime = image/png|jpeg. */
async function vision(settings, imageBase64, mime, promptText, opts = {}) {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: promptText },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } },
      ],
    },
  ];
  const { role, ...rest } = opts;
  return withFallback(settings, role || 'vision', () => messages, {
    temperature: 0.2,
    maxTokens: (settings.lmStudio && settings.lmStudio.visionMaxTokens) || 12000,
    ...rest,
  });
}

/** Extract the first balanced JSON object/array from a model response. */
function extractJson(text) {
  if (!text) throw new Error('empty LLM response');
  let cleaned = text.replace(/```(?:json)?/gi, '');
  const starts = [];
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c === '{' || c === '[') starts.push(i);
  }
  for (const start of starts) {
    const open = cleaned[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < cleaned.length; i++) {
      const c = cleaned[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          const candidate = cleaned.slice(start, i + 1);
          try { return JSON.parse(candidate); } catch { break; }
        }
      }
    }
  }
  return JSON.parse(cleaned);
}

/** `GET /models` against any configured provider. */
async function listModels(settings, providerId = 'local') {
  const p = allProviders(settings).find((x) => x.id === providerId);
  if (!p) throw new Error('unknown provider');
  if (p.kind === 'cli') {
    throw new Error('this provider is a command, not an endpoint — leave the model blank to use its default, or type an alias it accepts');
  }
  if (!p.baseUrl) throw new Error('no base URL set');
  const resp = await fetch(`${p.baseUrl}/models`, {
    headers: {
      ...(p.auth === 'none' && !p.apiKey ? {} : { Authorization: `Bearer ${p.apiKey || 'none'}` }),
      ...(p.headers || {}),
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!resp.ok) throw new Error(`${p.name} ${resp.status}`);
  const data = await resp.json();
  return (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
}

async function status(settings) {
  const ep = localProvider(settings);
  try {
    const models = await listModels(settings, 'local');
    return { ok: true, models, activeModel: ep.defaultModel, loaded: models.includes(ep.defaultModel) };
  } catch (e) {
    return { ok: false, error: e.message, models: [] };
  }
}

/** One real round trip to a specific provider for a specific role. */
async function testProvider(settings, { providerId, role = 'vision', base64, mime, prompt }) {
  const p = allProviders(settings).find((x) => x.id === providerId);
  if (!p) return { ok: false, error: 'unknown provider' };
  const why = ineligible(p, role);
  if (why) return { ok: false, error: `cannot serve the ${role} role — ${why}` };

  const ep = toEndpoint(p, role);
  const isVision = role === 'vision' && base64;
  const messages = isVision
    ? [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mime || 'image/jpeg'};base64,${base64}` } },
      ],
    }]
    : [{ role: 'user', content: prompt }];

  const t0 = Date.now();
  try {
    const { text, promptTokens, completionTokens, stdout, stderr } =
      await callChat(ep, messages, { temperature: 0.2, maxTokens: 1200 });
    const latencyMs = Date.now() - t0;
    const via = { kind: ep.kind, command: ep.command || '', stdout: stdout || '', stderr: stderr || '' };
    if (isRefusal(text)) {
      return {
        ok: false, refused: true, latencyMs, provider: p.name, model: ep.model, role, ...via,
        error: isVision ? 'the model refused to inspect this image' : 'the model refused to write this',
        sample: String(text).slice(0, 200),
      };
    }
    let parsed = null;
    try { parsed = extractJson(text); } catch { }
    return {
      ok: !!parsed,
      refused: false,
      latencyMs,
      provider: p.name,
      model: ep.model,
      role,
      ...via,
      score: parsed && parsed.score,
      promptTokens, completionTokens,
      error: parsed
        ? null
        : (ep.kind === 'cli'
          ? 'the command ran, but its output was not the JSON that was asked for — check the arguments below against what it printed'
          : 'answered, but not with parseable JSON — raise max output tokens or try another model'),
      sample: String(text).slice(0, 200),
    };
  } catch (e) {
    return {
      ok: false, refused: false, latencyMs: Date.now() - t0,
      provider: p.name, model: ep.model, role, kind: ep.kind, command: ep.command || '',
      error: e.message,
    };
  }
}

module.exports = {
  chat, vision, extractJson, listModels, status, testProvider,
  chainFor, describeRoute, localProvider, isRefusal, isPolicyRefusal, resetCircuit,
  isNativeRefusal, isNativePolicyRefusal, readToolCalls, applyJsonFallback,
  hasImages, stripImages,
  probeCommand,
  LlmError, ROLES,
};
