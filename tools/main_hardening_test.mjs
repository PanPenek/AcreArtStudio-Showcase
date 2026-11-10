/**
 * main_hardening_test.mjs — two main-process handlers that trusted their input (2026-11-10 bug sweep).
 *
 *   comfy:startServer   spawned the whole launch command as ONE program name with no 'error'
 *                       listener: any command with arguments or a quoted path never started,
 *                       and the ENOENT was an unhandled 'error' event in the main process.
 *                       It now goes through the shell (the measured route that also starts .bat).
 *   app:openExternal    handed any string to shell.openExternal, and so did the <webview>
 *   + window.open       window-open handler for pages it does not know. shell.openExternal
 *                       launches whatever Windows associates with the scheme or path, and the
 *                       Perchance / DeviantArt / Patreon tabs show pages other people wrote.
 *                       Only http(s) links may leave the app.
 *
 * Runs the REAL handlers out of src/main/main.js with Electron stubbed. No app, no network.
 *   node tools/main_hardening_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const mainSrc = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8');

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

/** Index of the character that closes the block starting at `startIdx`. */
function endOfBalanced(startIdx, openChar, closeChar) {
  let i = startIdx, depth = 0, quote = null;
  for (; i < mainSrc.length; i++) {
    const c = mainSrc[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '/' && mainSrc[i + 1] === '/') { i = mainSrc.indexOf('\n', i); continue; }
    if (c === '/' && mainSrc[i + 1] === '*') { i = mainSrc.indexOf('*/', i) + 1; continue; }
    // A regex literal can hold quotes and brackets: skip it (only after ( , = : or && ||).
    if (c === '/' && /[(,=:&|!?]\s*$/.test(mainSrc.slice(Math.max(0, i - 6), i))) {
      let j = i + 1, cls = false;
      for (; j < mainSrc.length; j++) {
        const d = mainSrc[j];
        if (d === '\\') { j++; continue; }
        if (d === '[') cls = true; else if (d === ']') cls = false;
        else if (d === '/' && !cls) break;
        else if (d === '\n') { j = i; break; }
      }
      i = j; continue;
    }
    if (c === openChar) depth++;
    else if (c === closeChar && --depth === 0) return i;
  }
  throw new Error('unbalanced slice from index ' + startIdx);
}
function registrationOf(channel) {
  const at = mainSrc.indexOf(`h('${channel}'`);
  if (at < 0) throw new Error('main.js no longer registers ' + channel);
  const arrow = mainSrc.indexOf('=>', at);
  const bodyAt = mainSrc.indexOf('{', arrow);
  const semi = mainSrc.indexOf(';', arrow);
  // `h('x', (_e, url) => expr);` has no block body.
  if (semi > 0 && (bodyAt < 0 || semi < bodyAt)) return mainSrc.slice(at, semi + 1);
  return mainSrc.slice(at, mainSrc.indexOf(';', endOfBalanced(bodyAt, '{', '}')) + 1);
}
function functionOf(name) {
  const at = mainSrc.indexOf(`function ${name}(`);
  if (at < 0) throw new Error('main.js no longer defines ' + name);
  return mainSrc.slice(at, endOfBalanced(mainSrc.indexOf('{', at), '{', '}') + 1);
}
/** The module-level helper both handlers use (absent before the fix). */
const helper = (/^const isHttpUrl = .*$/m.exec(mainSrc) || [''])[0];

function sandbox(extra) {
  const handlers = {};
  const ctx = vm.createContext({ console, URL, String, Error, JSON, Promise, h: (ch, fn) => { handlers[ch] = fn; }, ...extra });
  return { ctx, handlers };
}

// ---------------------------------------------------------------- comfy:startServer
console.log('\n[comfy:startServer]');
{
  // Which route works was measured with the app's own Electron (scratch spawn_probe.cjs,
  // 2026-11-10): whole line as one program → ENOENT; program + args → EINVAL for a .bat;
  // through the shell → a .bat and an .exe with quoted paths and arguments both start.
  const spawned = [];
  const mkChild = () => ({ events: [], on(ev) { this.events.push(ev); return this; }, unref() {}, pid: 4242 });
  const { ctx, handlers } = sandbox({ spawn: (cmd, opts, extra) => { const child = mkChild(); spawned.push({ cmd, opts, extra, child }); return child; } });
  vm.runInContext(registrationOf('comfy:startServer'), ctx);
  const start = handlers['comfy:startServer'];
  const line = '"C:\\My Comfy\\python_embeded\\python.exe" -s ComfyUI\\main.py --port 8188 --vram-headroom 6';
  let r = start(null, { command: line });
  const s0 = spawned[0] || {};
  ok('the command line goes to the shell whole, quotes and arguments intact', s0.cmd === line && s0.opts && s0.opts.shell === true, JSON.stringify([s0.cmd, s0.opts]));
  ok('a launch that cannot start is caught, not thrown into the main process', (s0.child ? s0.child.events : []).includes('error'));
  ok('the reply still carries the pid', r && r.ok === true && r.pid === 4242, JSON.stringify(r));
  ok('the server stays up when the app closes (detached)', !!(s0.opts && s0.opts.detached === true && s0.opts.stdio === 'ignore'));
  spawned.length = 0;
  start(null, { command: '  C:\\ComfyUI\\run_nvidia_gpu.bat  ' });
  ok('a .bat launcher is started through the shell too (trimmed)', spawned[0] && spawned[0].cmd === 'C:\\ComfyUI\\run_nvidia_gpu.bat' && spawned[0].opts.shell === true);
  spawned.length = 0;
  r = start(null, { command: '   ' });
  ok('an empty command is refused without spawning', r && r.ok === false && spawned.length === 0, JSON.stringify(r));
}

// ---------------------------------------------------------------- app:openExternal
console.log('\n[app:openExternal]');
const BAD = ['file:///C:/Windows/System32/calc.exe', 'C:\\Windows\\System32\\calc.exe', '\\\\evil\\share\\run.bat', 'ms-settings:privacy',
  'javascript:alert(1)', 'data:text/html,<script>1</script>', 'search-ms:query=x', '', null, undefined, {}, 'not a url'];
const GOOD = ['https://www.deviantart.com/stash', 'http://127.0.0.1:8188/', 'https://www.patreon.com/posts/new', 'HTTPS://EXAMPLE.COM/a?b=c#d'];
{
  const opened = [];
  const { ctx, handlers } = sandbox({ shell: { openExternal: async (u) => { opened.push(u); } } });
  vm.runInContext(`${helper}\n${registrationOf('app:openExternal')}`, ctx);
  const open = handlers['app:openExternal'];
  const leaked = [];
  for (const u of BAD) {
    opened.length = 0;
    try { await open(null, u); } catch { /* refused */ }
    if (opened.length) leaked.push(String(u));
  }
  ok('nothing but http(s) reaches shell.openExternal', leaked.length === 0, 'opened: ' + leaked.join(' , '));
  opened.length = 0;
  for (const u of GOOD) { try { await open(null, u); } catch (e) { opened.push('THREW ' + e.message); } }
  ok('web links still open in the browser', opened.length === GOOD.length && !opened.some((x) => String(x).startsWith('THREW')), JSON.stringify(opened));
}

// ---------------------------------------------------------------- <webview> window.open
console.log('\n[webview window.open]');
{
  const opened = [];
  let onCreated = null;
  const { ctx } = sandbox({ app: { on: (ev, fn) => { if (ev === 'web-contents-created') onCreated = fn; } }, shell: { openExternal: (u) => { opened.push(u); return Promise.resolve(); } } });
  vm.runInContext(`${helper}\n${functionOf('installWebviewOpenHandler')}\ninstallWebviewOpenHandler();`, ctx);
  let handler = null;
  onCreated({}, { getType: () => 'webview', setWindowOpenHandler: (fn) => { handler = fn; }, getURL: () => 'https://perchance.org/some-generator' });
  const act = (url) => handler({ url });

  ok('known sites keep opening inside the app', act('https://www.patreon.com/login').action === 'allow' && act('https://www.deviantart.com/users/login').action === 'allow' && opened.length === 0);
  opened.length = 0;
  let r = act('https://example.com/article');
  ok('an ordinary link goes to the system browser', r.action === 'deny' && opened.length === 1 && opened[0] === 'https://example.com/article', JSON.stringify([r, opened]));
  const leaked = [];
  for (const u of BAD.filter((x) => typeof x === 'string')) {
    opened.length = 0;
    let res = null;
    try { res = act(u); } catch (e) { res = { action: 'threw ' + e.message }; }
    if (opened.length || res.action !== 'deny') leaked.push(`${u} → ${res.action}${opened.length ? ' (opened)' : ''}`);
  }
  ok('a page cannot launch a file, a script or another program', leaked.length === 0, leaked.join(' | '));
  let other = null;
  onCreated({}, { getType: () => 'window', setWindowOpenHandler: (fn) => { other = fn; }, getURL: () => '' });
  ok('only <webview> contents are touched', other === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
