'use strict';
/**
 * comfyfind.js: find a ComfyUI that is already installed, so a fresh install of the studio
 * does not make the artist hunt for the workflows folder by hand.
 *
 * ComfyUI keeps the workflows its sidebar lists in `<ComfyUI>/user/default/workflows`. Where
 * `<ComfyUI>` lives depends on how it was installed:
 *   - Comfy Desktop (the current launcher): %APPDATA%\Comfy Desktop\installations.json lists
 *     every install with its `installPath`; the code sits in `<installPath>\ComfyUI`. A running
 *     install writes its port to comfy-procs\<id>.json (it picks a free one, often not 8188).
 *   - the older ComfyUI Desktop app: %APPDATA%\ComfyUI\config.json holds `basePath`; it serves
 *     on port 8000.
 *   - the portable build / a git clone: anywhere, usually in the user's home, Documents,
 *     Desktop or Downloads, or at a drive root; the studio's own installer puts it in
 *     `<app>/comfyui/ComfyUI_windows_portable/ComfyUI`.
 * Everything here only READS the disk. Nothing is created, copied or launched.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const WF_SUB = ['user', 'default', 'workflows'];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function jsonFiles(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json')); } catch { return []; }
}

/** `<ComfyUI>` root -> its workflows folder (null if it is not a ComfyUI root). */
function workflowsOf(root) {
  if (!root) return null;
  const wf = path.join(root, ...WF_SUB);
  if (isDir(wf)) return wf;
  // A root that has never been opened in the browser has no user/ folder yet: still the right place.
  if (fs.existsSync(path.join(root, 'main.py')) && fs.existsSync(path.join(root, 'comfy'))) return wf;
  return null;
}

/**
 * Every ComfyUI install found on this machine, best first.
 * @param {{ appData?: string, home?: string, appRoot?: string, drives?: string[] }} env
 * @returns {Array<{ source: string, label: string, root: string, workflowsDir: string,
 *   exists: boolean, workflows: number, serverUrls: string[], lastUsed: number }>}
 */
function findComfyInstalls(env = {}) {
  const appData = env.appData || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const home = env.home || os.homedir();
  const out = [];
  const seen = new Set();
  const add = (source, label, root, extra = {}) => {
    const wf = workflowsOf(root);
    if (!wf) return;
    const key = path.resolve(wf).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const exists = isDir(wf);
    out.push({
      source, label, root, workflowsDir: wf, exists,
      workflows: exists ? jsonFiles(wf).length : 0,
      serverUrls: extra.serverUrls || [],
      lastUsed: Number(extra.lastUsed) || 0,
    });
  };

  // 1. Comfy Desktop (current launcher).
  const cd = path.join(appData, 'Comfy Desktop');
  const installs = readJson(path.join(cd, 'installations.json'));
  if (Array.isArray(installs)) {
    for (const it of installs) {
      if (!it || !it.installPath || it.sourceId === 'cloud') continue;
      const proc = readJson(path.join(cd, 'comfy-procs', `${it.id}.json`));
      const urls = proc && Number(proc.port) ? [`http://127.0.0.1:${Number(proc.port)}`] : [];
      add('comfy-desktop', `Comfy Desktop — ${it.name || path.basename(it.installPath)}`,
        path.join(it.installPath, 'ComfyUI'), { serverUrls: urls, lastUsed: it.lastLaunchedAt });
    }
  }

  // 2. The older ComfyUI Desktop app.
  const legacy = readJson(path.join(appData, 'ComfyUI', 'config.json'));
  if (legacy && legacy.basePath) {
    add('comfyui-desktop', 'ComfyUI Desktop', legacy.basePath, { serverUrls: ['http://127.0.0.1:8000'] });
  }
  add('comfyui-desktop', 'ComfyUI Desktop', path.join(home, 'Documents', 'ComfyUI'), { serverUrls: ['http://127.0.0.1:8000'] });

  // 3. Portable builds and git clones in the usual places.
  const names = [
    ['ComfyUI_windows_portable', 'ComfyUI'], ['ComfyUI_windows_portable_nvidia', 'ComfyUI'],
    ['ComfyUI'], ['comfy', 'ComfyUI'], ['ComfyUI-master'],
  ];
  const parents = [home, path.join(home, 'Documents'), path.join(home, 'Desktop'), path.join(home, 'Downloads')];
  for (const d of env.drives || (process.platform === 'win32' ? ['C:\\', 'D:\\', 'E:\\'] : [])) parents.push(d);
  if (env.appRoot) add('portable', 'ComfyUI installed by the studio', path.join(env.appRoot, 'comfyui', 'ComfyUI_windows_portable', 'ComfyUI'), { serverUrls: ['http://127.0.0.1:8188'] });
  for (const p of parents) {
    for (const n of names) add('portable', 'ComfyUI (portable / manual install)', path.join(p, ...n), { serverUrls: ['http://127.0.0.1:8188'] });
  }

  // Best first: a folder that already holds workflows, then the most recently launched install.
  return out
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (Number(b.c.workflows > 0) - Number(a.c.workflows > 0))
      || (Number(b.c.exists) - Number(a.c.exists))
      || (b.c.lastUsed - a.c.lastUsed)
      || (a.i - b.i))
    .map((x) => x.c);
}

/**
 * The workflow to preselect from a folder: the studio's own bundled image workflow if it is
 * there (Q8, then Q4), otherwise null — never guess at someone else's graph.
 */
function pickBundled(files, kind) {
  const list = (files || []).map(String);
  const prefs = kind === 'video'
    ? [/^AcreArtStudio_FastH3_Video\.json$/i]
    : [/^AcreArtStudio_Qwen-Image-2\.1_Q8\.json$/i, /^AcreArtStudio_Qwen-Image-2\.1_Q4\.json$/i];
  for (const re of prefs) { const f = list.find((x) => re.test(x)); if (f) return f; }
  return null;
}

/** Ask each URL for /system_stats; the first that answers wins. */
async function firstLiveServer(urls, timeoutMs = 1500) {
  for (const u of [...new Set((urls || []).filter(Boolean).map((x) => String(x).replace(/\/+$/, '')))]) {
    try {
      const r = await fetch(`${u}/system_stats`, { signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j && j.system) return { url: u, version: j.system.comfyui_version || '' };
      }
    } catch { /* not this one */ }
  }
  return null;
}

module.exports = { findComfyInstalls, pickBundled, firstLiveServer, workflowsOf };
