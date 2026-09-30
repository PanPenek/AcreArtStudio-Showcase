/**
 * clibridge.js: use an installed AI command-line tool as if it were a chat API.
 *
 * Tools such as Claude Code, Codex, Gemini CLI or Qwen Code are already signed in
 * and paid for by a subscription, but they expose no HTTP endpoint, only a
 * process. This module writes the prompt to that process's stdin, reads the answer
 * from stdout and returns the same `{ text, promptTokens, completionTokens }` shape
 * as an HTTP call, so nothing downstream needs to know the difference.
 *
 * Handles the three practical problems: Windows `.cmd` shims (resolveCommand),
 * safe quoting of multi-line prompts (stdin, never a shell), and CLI chatter
 * around the actual answer (pickText).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PH = {
  prompt: '{{prompt}}',
  model: '{{model}}',
  image: '{{imagePath}}',
};

/** Find what to actually execute, and how. */
function resolveCommand(command) {
  const raw = String(command || '').trim();
  if (!raw) throw new Error('no command set');

  const direct = raw.includes('/') || raw.includes('\\');
  const found = direct ? (fs.existsSync(raw) ? raw : null) : searchPath(raw);
  if (!found) {
    throw new Error(`"${raw}" is not on PATH — install it, or give the full path to the executable`);
  }
  const ext = path.extname(found).toLowerCase();

  if (ext === '.cmd' || ext === '.bat') {
    return { file: process.env.ComSpec || 'cmd.exe', prefixArgs: ['/d', '/s', '/c', found], why: 'batch shim' };
  }
  if (ext === '.ps1') {
    return {
      file: 'powershell.exe',
      prefixArgs: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', found],
      why: 'powershell shim',
    };
  }
  return { file: found, prefixArgs: [], why: 'executable' };
}

/** `where`, without the round trip. */
function searchPath(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? ['', ...String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.PS1').split(';').filter(Boolean)]
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch { }
    }
  }
  return null;
}

/** Is this command reachable at all? */
function probeCommand(command) {
  try {
    const r = resolveCommand(command);
    return { ok: true, path: r.file === (process.env.ComSpec || 'cmd.exe') || r.file === 'powershell.exe' ? r.prefixArgs[r.prefixArgs.length - 1] : r.file, kind: r.why };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Collapse a chat array into the single prompt an agent CLI takes. */
function flatten(messages) {
  const parts = [];
  const images = [];
  for (const m of messages || []) {
    const content = m && m.content;
    if (typeof content === 'string') {
      parts.push(m.role === 'system' ? content : content);
      continue;
    }
    for (const piece of content || []) {
      if (!piece) continue;
      if (piece.type === 'text') parts.push(piece.text || '');
      else if (piece.type === 'image_url') {
        const written = writeDataUrl((piece.image_url || {}).url || '');
        if (written) images.push(written);
      }
    }
  }
  return { prompt: parts.filter(Boolean).join('\n\n').trim(), images };
}

function writeDataUrl(url) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(url || ''));
  if (!m) return null;
  const ext = /png/.test(m[1]) ? 'png' : /webp/.test(m[1]) ? 'webp' : 'jpg';
  const file = path.join(os.tmpdir(), `ala-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
  return file;
}

const stripAnsi = (s) => String(s || '')
  .replace(/\[[0-9;?]*[ -/]*[@-~]/g, '')
  .replace(/\r/g, '');

const TEXT_KEYS = ['result', 'response', 'output_text', 'text', 'output', 'answer', 'completion'];

function fromEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const k of TEXT_KEYS) {
    if (typeof value[k] === 'string' && value[k].trim()) return value[k];
  }
  const msg = value.message || (Array.isArray(value.choices) && value.choices[0] && value.choices[0].message);
  if (msg) {
    if (typeof msg.content === 'string' && msg.content.trim()) return msg.content;
    if (Array.isArray(msg.content)) {
      const joined = msg.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('').trim();
      if (joined) return joined;
    }
  }
  return null;
}

/** The model's answer, out of whatever the CLI printed. */
function pickText(stdout) {
  const s = stripAnsi(stdout).trim();
  if (!s) return '';

  try {
    const unwrapped = fromEnvelope(JSON.parse(s));
    if (unwrapped) return unwrapped;
    return s;
  } catch { }

  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  let streamed = null;
  let sawJsonLine = false;
  for (const line of lines) {
    if (line[0] !== '{') continue;
    try {
      const obj = JSON.parse(line);
      sawJsonLine = true;
      const unwrapped = fromEnvelope(obj);
      if (unwrapped) streamed = unwrapped;
    } catch { }
  }
  if (sawJsonLine && streamed) return streamed;
  return s;
}

const NOT_USABLE = /not logged in|please run \/login|\/login\b|not authenticated|authentication (required|failed)|no active session|session (has )?expired|sign in to|usage limit|quota exceeded|out of credits|subscription (required|expired)|upgrade to (a )?(pro|plus)/i;

/** Kill the whole tree, not just the launcher. */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch { }
  }
  try { child.kill('SIGKILL'); } catch { }
}

/** One round trip through a local agent CLI. */
function runCli(endpoint, messages, { timeoutSec } = {}) {
  const { prompt, images } = flatten(messages);
  const seconds = Number(timeoutSec || endpoint.timeoutSec) || 300;
  const viaStdin = (endpoint.promptVia || 'stdin') === 'stdin';

  const template = Array.isArray(endpoint.args) && endpoint.args.length
    ? endpoint.args
    : (endpoint.args ? String(endpoint.args).split(/\s+/).filter(Boolean) : []);

  const args = [];
  for (let i = 0; i < template.length; i++) {
    let a = String(template[i]);
    const next = i + 1 < template.length ? String(template[i + 1]) : '';
    const emptyPlaceholder = (ph, value) => next.includes(ph) && !value;
    if (a.startsWith('-') && (emptyPlaceholder(PH.model, endpoint.model) || emptyPlaceholder(PH.image, images[0]))) {
      i++;
      continue;
    }
    if (a.includes(PH.model)) {
      if (!endpoint.model) continue;
      a = a.split(PH.model).join(endpoint.model);
    }
    if (a.includes(PH.image)) {
      if (!images.length) continue;
      a = a.split(PH.image).join(images[0]);
    }
    if (a.includes(PH.prompt)) a = a.split(PH.prompt).join(prompt);
    args.push(a);
  }
  if (!viaStdin && !template.some((a) => String(a).includes(PH.prompt))) args.push(prompt);

  const resolved = resolveCommand(endpoint.command);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(resolved.file, [...resolved.prefixArgs, ...args], {
        cwd: endpoint.cwd && fs.existsSync(endpoint.cwd) ? endpoint.cwd : os.tmpdir(),
        env: { ...process.env, ...(endpoint.env || {}) },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return reject(new Error(`could not start ${endpoint.command}: ${e.message}`));
    }

    let out = '';
    let err = '';
    let timedOut = false;
    const CAP = 4_000_000;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, seconds * 1000);

    child.stdout.on('data', (d) => { if (out.length < CAP) out += d.toString(); });
    child.stderr.on('data', (d) => { if (err.length < CAP) err += d.toString(); });

    if (viaStdin) {
      child.stdin.on('error', () => { });
      child.stdin.end(prompt);
    } else {
      child.stdin.end();
    }

    const cleanup = () => {
      clearTimeout(timer);
      for (const f of images) fs.unlink(f, () => {});
    };

    child.on('error', (e) => {
      cleanup();
      reject(new Error(`${endpoint.command} failed to run: ${e.message}`));
    });

    child.on('close', (code) => {
      cleanup();
      if (timedOut) {
        return reject(new Error(`${endpoint.name || endpoint.command} timed out after ${seconds}s`));
      }
      const text = pickText(out);
      if (code !== 0) {
        const detail = (text || stripAnsi(err).trim() || '(no output)').slice(0, 400);
        return reject(new Error(`${endpoint.name || endpoint.command} exited ${code}: ${detail}`));
      }
      if (text.length < 240 && NOT_USABLE.test(text)) {
        return reject(new Error(`${endpoint.name || endpoint.command} is installed but not usable: ${text.slice(0, 200)}`));
      }
      resolve({
        text,
        promptTokens: 0,
        completionTokens: 0,
        stdout: stripAnsi(out).slice(0, 4000),
        stderr: stripAnsi(err).slice(0, 2000),
        exitCode: code,
      });
    });
  });
}

module.exports = { runCli, probeCommand, resolveCommand, pickText, flatten, PH };
