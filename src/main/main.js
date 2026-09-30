/**
 * main.js: Electron main process, the app's privileged service layer.
 *
 * Owns everything the browser sandbox is not allowed to touch: the window, the JSON
 * store on disk, the LLM bridge, file I/O for the image library, the ComfyUI HTTP
 * bridge, OS notifications and the custom `ala://` media protocol (which serves
 * library images and videos to the UI, including byte-range requests so video
 * seeking works). The renderer asks for all of this over IPC (see preload.js);
 * every handler is registered in one place below so the whole API surface is
 * readable top to bottom.
 */
const { app, BrowserWindow, ipcMain, session, protocol, shell, webContents, powerSaveBlocker,
  clipboard, nativeImage, Notification, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const { Store, migrateDestinationToList } = require('./store');
const llm = require('./llm');
const { DAClient } = require('./da');
const { DAWebClient } = require('./daweb');
const { DAStatsClient } = require('./dastats');
const { createPatreonMedia } = require('./patreon-media');
const research = require('./research');
const { createVideoInspector } = require('./videocheck');

protocol.registerSchemesAsPrivileged([
  { scheme: 'ala', privileges: { secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

let win = null;
let store = null;
let da = null;
let daweb = null;
let dastats = null;
let powerBlockerId = null;
let patreonMedia = null;
const START_HIDDEN = process.argv.includes('--start-hidden');

const reviewMarker = path.join(__dirname, '..', '..', '.ala-review.json');
const REVIEW_MODE = fs.existsSync(reviewMarker);
if (REVIEW_MODE) {
  const marker = JSON.parse(fs.readFileSync(reviewMarker, 'utf8'));
  const reviewData = path.resolve(marker.userData || '');
  const productionData = path.resolve(app.getPath('userData'));
  if (!marker.userData || reviewData.toLowerCase() === productionData.toLowerCase()
      || path.basename(reviewData).toLowerCase() !== 'ailaborautomation-review') {
    throw new Error('Unsafe review data directory; refusing to start.');
  }
  fs.mkdirSync(reviewData, { recursive: true });
  app.setPath('userData', reviewData);
  app.setPath('sessionData', reviewData);
  app.setName('AiLaborAutomation Review');
}

const single = app.requestSingleInstanceLock();
if (!single) { app.quit(); }
app.on('second-instance', () => { if (win) { win.show(); } });

app.whenReady().then(() => {
  try {
    store = new Store(app.getPath('userData'));
    da = new DAClient(store);
    daweb = new DAWebClient('persist:da');
    dastats = new DAStatsClient(daweb);
    store.stats.data.sessions += 1;
    store.stats.save();
    fs.mkdirSync(path.join(store.libraryDir, 'images'), { recursive: true });
    fs.mkdirSync(path.join(store.libraryDir, 'tmp'), { recursive: true });
    fs.mkdirSync(path.join(store.libraryDir, 'videos'), { recursive: true });
    fs.mkdirSync(path.join(store.libraryDir, 'gifs'), { recursive: true });
    fs.mkdirSync(path.join(store.libraryDir, 'overseer'), { recursive: true });

    registerMediaProtocol();
    patreonMedia = createPatreonMedia({ store, getWindow: () => win,
      patreonSession: session.fromPartition('persist:patreon'), nativeImage, clipboard, shell });
    registerIpc();
    installDaOAuthInterceptor();
    installUpscalerDownloadHandler();
    installWebviewOpenHandler();
    createWindow();
    console.log('[ala] boot ok — window created');
  } catch (e) {
    console.error('[ala] BOOT FAILURE:', e);
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { try { if (store) store.flushAll(); } catch (e) { console.error('[ala] flush on quit failed:', e); } });
app.on('will-quit', () => { try { if (store) store.flushAll(); } catch { } });

function createWindow() {
  const startHidden = START_HIDDEN || !!(store.settings.data.ui && store.settings.data.ui.startHidden);
  const saved = (store.settings.data.ui && store.settings.data.ui.windowBounds) || null;
  const bounds = { width: 1520, height: 940 };
  if (saved && saved.width >= 600 && saved.height >= 400) {
    bounds.width = saved.width;
    bounds.height = saved.height;
    try {
      const { screen } = require('electron');
      const onScreen = screen.getAllDisplays().some((d) =>
        saved.x >= d.bounds.x - 50 && saved.y >= d.bounds.y - 50
        && saved.x < d.bounds.x + d.bounds.width && saved.y < d.bounds.y + d.bounds.height);
      if (onScreen) { bounds.x = saved.x; bounds.y = saved.y; }
    } catch { }
  }
  win = new BrowserWindow({
    ...bounds,
    minWidth: 1180,
    minHeight: 720,
    show: !startHidden,
    backgroundColor: '#0c0a09',
    title: REVIEW_MODE ? 'AiLaborAutomation — REVIEW COPY (production unchanged)' : 'AiLaborAutomation',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  if (REVIEW_MODE) win.on('page-title-updated', (event) => event.preventDefault());
  win.webContents.on('did-attach-webview', (_event, guest) => patreonMedia.trackGuest(guest));
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (startHidden) win.hide();

  const seatFocus = () => { if (win && !win.isDestroyed()) win.webContents.focus(); };
  win.webContents.on('did-finish-load', seatFocus);
  win.on('show', seatFocus);
  win.on('close', () => {
    try {
      if (!win.isMinimized() && !win.isFullScreen()) {
        store.settings.data.ui = store.settings.data.ui || {};
        store.settings.data.ui.windowBounds = win.getBounds();
        store.settings.save(true);
      }
    } catch { }
  });
}

const MEDIA_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
};

const MEDIA_HOSTS = { img: 'images', tmp: 'tmp', videos: 'videos', gifs: 'gifs', ovr: 'overseer' };

/** Answer one media request, honouring a byte range when the client sends one. */
function mediaResponse(target, request) {
  const size = fs.statSync(target).size;
  const type = MEDIA_MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.get('range') || '').trim());
  if (!m) {
    return new Response(Readable.toWeb(fs.createReadStream(target)),
      { status: 200, headers: Object.assign(base, { 'Content-Length': String(size) }) });
  }
  const suffix = m[1] === '';
  const start = suffix ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  const end = suffix || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    return new Response('range not satisfiable',
      { status: 416, headers: Object.assign(base, { 'Content-Range': `bytes */${size}` }) });
  }
  return new Response(Readable.toWeb(fs.createReadStream(target, { start, end })), {
    status: 206,
    headers: Object.assign(base, { 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` }),
  });
}

function registerMediaProtocol() {
  protocol.handle('ala', (request) => {
    try {
      const url = new URL(request.url);
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const sub = MEDIA_HOSTS[url.host];
      if (!sub) return new Response('unknown media host', { status: 404 });
      const base = path.join(store.libraryDir, sub);
      const target = path.normalize(path.join(base, rel));
      if (target !== base && !target.startsWith(base + path.sep)) return new Response('forbidden', { status: 403 });
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return new Response('not found', { status: 404 });
      return mediaResponse(target, request);
    } catch (e) {
      return new Response('bad request: ' + e.message, { status: 400 });
    }
  });
}

function installDaOAuthInterceptor() {
  const ses = session.fromPartition('persist:da');
  ses.webRequest.onBeforeRequest(
    { urls: ['*://localhost/*', '*://*.deviantart.com/settings/applications/redirect_error*'] },
    (details, callback) => {
      try {
        const url = new URL(details.url);

        if (url.pathname.startsWith('/settings/applications/redirect_error')) {
          const err = url.searchParams.get('error') || 'unknown_error';
          const desc = url.searchParams.get('error_description') || '';
          broadcast('da:authChanged', {
            authenticated: false,
            error: `${desc || err}`,
            hint: /invalid client_id|unauthorized_client/i.test(desc + err)
              ? 'Your DeviantArt application is not published/approved. Until it is, use the Session upload method (Settings → DeviantArt → Upload method).'
              : null,
          });
          return callback({ cancel: true });
        }

        const isCallback = url.port === '5556' && url.pathname.startsWith('/auth/callback');
        if (isCallback) {
          const code = url.searchParams.get('code');
          const err = url.searchParams.get('error');
          const desc = url.searchParams.get('error_description');
          if (code) {
            da.exchangeCode(code).then((res) => {
              broadcast('da:authChanged', { authenticated: res.ok, error: res.error || null });
              if (res.ok) refreshDaIdentity();
            });
          } else {
            broadcast('da:authChanged', { authenticated: false, error: desc || err || 'no code in redirect' });
          }
          return callback({ cancel: true });
        }
      } catch { }
      return callback({});
    }
  );
}

function installUpscalerDownloadHandler() {
  const ses = session.fromPartition('persist:upscaler');
  ses.on('will-download', (_event, item) => {
    const name = item.getFilename() || 'upscaled.png';
    if (!/\.(png|jpe?g|webp)$/i.test(name)) return;
    const dest = path.join(store.libraryDir, 'tmp', `${Date.now()}-${name.replace(/[^\w.-]/g, '_')}`);
    item.setSavePath(dest);
    item.once('done', (_e, state) => {
      broadcast('upscale:downloaded', state === 'completed'
        ? { ok: true, path: dest, fname: path.basename(dest), bytes: item.getReceivedBytes() }
        : { ok: false, error: `download ${state}` });
    });
  });
}

/**
 * Move an upscaled image into the library, replacing a card's file and keeping the original as
 * <name>.orig so the upscale can be undone.
 */
function adoptUpscaledBuffer(buf, ext, currentFname, cleanup) {
  const imagesDir = path.join(store.libraryDir, 'images');
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const fname = `up-${id}.${(ext || 'png').toLowerCase()}`;
  fs.writeFileSync(path.join(imagesDir, fname), buf);
  if (cleanup) cleanup();

  let backup = null;
  if (currentFname) {
    const old = path.join(imagesDir, path.basename(currentFname));
    if (fs.existsSync(old)) {
      backup = path.basename(currentFname) + '.orig';
      try { fs.copyFileSync(old, path.join(imagesDir, backup)); } catch { backup = null; }
    }
  }
  return {
    fname, path: path.join(imagesDir, fname), url: `ala://img/${fname}`,
    bytes: buf.length, backup,
  };
}

function installWebviewOpenHandler() {
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.setWindowOpenHandler(({ url }) => {
      if (/deviantart\.com|sta\.sh|perchance\.org|patreon\.com|imgupscaler\.com|pixiv\.net/.test(url)) {
        return { action: 'allow' };
      }
      if (/^https:\/\/(accounts\.google\.com|appleid\.apple\.com|(api|x)\.twitter\.com|twitter\.com|x\.com)\//.test(url)) {
        let opener = '';
        try { opener = contents.getURL() || ''; } catch { }
        if (/^https:\/\/[\w.-]*pixiv\.net\//.test(opener)) return { action: 'allow' };
      }
      shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
  });
}

async function refreshDaIdentity() {
  try {
    const me = await da.whoami();
    if (me && me.username) {
      store.settings.data.da.username = me.username;
      store.settings.save();
      broadcast('da:identity', { username: me.username, icon: me.usericon });
    }
  } catch (e) {
    console.error('[da] whoami failed:', e.message);
  }
}

function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function registerIpc() {
  const h = ipcMain.handle;
  h('patreon:armAttach', (e, p) => patreonMedia.arm(e, p));
  h('patreon:disarmAttach', (e, p) => patreonMedia.disarm(e, p));
  h('patreon:copyFile', (e, p) => patreonMedia.copyFile(e, p));
  h('patreon:revealMedia', (e, p) => patreonMedia.reveal(e, p));
  ipcMain.on('patreon:startDrag', (e, p) => {
    try { patreonMedia.startDrag(e, p); }
    catch (err) { if (e.sender === win?.webContents) e.sender.send('patreon:dragError', String(err.message)); }
  });

  h('settings:get', () => store.settings.data);
  h('settings:patch', (_e, patchObj) => {
    deepPatch(store.settings.data, patchObj);
    if (patchObj && patchObj.publish) {
      migrateDestinationToList(store.settings.data,
        { prefer: patchObj.publish.destinations ? 'list' : 'single' });
    }
    store.settings.save();
    if (patchObj && (patchObj.cloud || patchObj.providers || patchObj.routing)) llm.resetCircuit();
    return store.settings.data;
  });

  h('db:getQueue', () => store.queue.data);
  h('db:setQueue', (_e, data) => { store.queue.data = data; store.queue.save(); return true; });
  h('db:getLibrary', () => store.library.data);
  h('db:setLibrary', (_e, data) => { store.library.data = data; store.library.save(); return true; });
  h('db:getStats', () => store.stats.data);
  h('db:bumpStats', (_e, deltas) => {
    for (const [k, v] of Object.entries(deltas || {})) {
      if (typeof store.stats.data[k] === 'number') store.stats.data[k] += v;
    }
    store.stats.save();
    return store.stats.data;
  });
  h('db:getPerf', () => store.perf.data);
  h('db:setPerf', (_e, data) => { store.perf.data = data; store.perf.save(); return true; });
  h('db:getPlaybook', () => store.playbook.data);
  h('db:setPlaybook', (_e, data) => { store.playbook.data = data; store.playbook.save(); return true; });
  h('db:getTitles', () => store.titles.data);
  h('db:setTitles', (_e, data) => { store.titles.data = data; store.titles.save(); return true; });
  h('db:getOrigins', () => store.origins.data);
  h('db:setOrigins', (_e, data) => { store.origins.data = data; store.origins.save(); return true; });
  h('db:getComics', () => store.comics.data);
  h('db:setComics', (_e, data) => { store.comics.data = data; store.comics.save(); return true; });
  h('db:getPchCatalog', () => store.pchCatalog.data);
  h('db:setPchCatalog', (_e, data) => { store.pchCatalog.data = data; store.pchCatalog.save(); return true; });
  h('db:getRequests', () => store.requests.data);
  h('db:setRequests', (_e, data) => { store.requests.data = data; store.requests.save(); return true; });
  h('db:getOverseer', () => store.overseer.data);
  h('db:setOverseer', (_e, data) => { store.overseer.data = data; store.overseer.save(); return true; });

  h('dastats:sync', async (_e, opts) => {
    try {
      const res = await dastats.sync({
        withViews: (opts && opts.withViews) !== false,
        maxViewFetches: (opts && opts.maxViewFetches) || store.settings.data.learn.maxViewFetches || 400,
        maxDeviations: (opts && Number(opts.maxDeviations)) || 0,
        onProgress: (p) => broadcast('dastats:progress', p),
      });
      if (res.ok) {
        store.settings.data.learn.lastSyncAt = res.syncedAt;
        store.settings.save();
      }
      return res;
    } catch (e) {
      return { ok: false, error: e.message, items: [] };
    }
  });

  h('dastats:image', async (_e, { deviationId, username, preferFull }) => {
    try {
      return await dastats.image(deviationId, username || store.settings.data.da.username, { preferFull });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  h('dastats:comments', async (_e, { deviationId, limit, debug }) => {
    try { return await dastats.comments(deviationId, { limit, debug }); }
    catch (e) { return { ok: false, error: e.message, items: [] }; }
  });

  h('llm:status', () => llm.status(store.settings.data));
  h('llm:models', (_e, payload) => llm.listModels(store.settings.data, (payload && payload.providerId) || 'local'));
  h('llm:chat', (_e, { messages, opts }) => llm.chat(store.settings.data, messages, opts));
  h('llm:vision', (_e, { base64, mime, prompt, opts }) =>
    llm.vision(store.settings.data, base64, mime, prompt, opts));
  h('llm:testProvider', (_e, payload) => llm.testProvider(store.settings.data, payload));
  h('llm:route', (_e, { role }) => llm.describeRoute(store.settings.data, role || 'vision'));
  h('llm:routes', () => Object.fromEntries(
    llm.ROLES.map((r) => [r, llm.describeRoute(store.settings.data, r)])));
  h('llm:resetCircuit', (_e, payload) =>
    llm.resetCircuit(payload && payload.providerId, payload && payload.role) || true);
  h('llm:probeCommand', (_e, { command }) => llm.probeCommand(command));

  h('research:search', async (_e, payload) => {
    try { return await research.search(payload || {}); }
    catch (e) { return { ok: false, error: e.message, sources: [], images: [] }; }
  });
  h('research:image', async (_e, payload) => {
    try { return await research.fetchImage(payload || {}); }
    catch (e) { return { ok: false, error: e.message }; }
  });
  h('research:preview', async (_e, payload) => {
    try { return await research.fetchPreview(payload || {}); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  h('files:saveImage', (_e, { base64, ext, nameHint }) => {
    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const safeExt = /^[a-z0-9]{2,5}$/i.test(ext || '') ? ext.toLowerCase() : 'png';
    const fname = `${(nameHint || 'img').replace(/[^a-z0-9-_]/gi, '_').slice(0, 40)}-${id}.${safeExt}`;
    const fpath = path.join(store.libraryDir, 'images', fname);
    fs.writeFileSync(fpath, Buffer.from(base64, 'base64'));
    return { id, fname, path: fpath, url: `ala://img/${fname}` };
  });
  /** IPC: save pictures the artist attaches to an Overseer message. */
  h('files:saveAttachment', (_e, { base64, mime, name }) => {
    const buf = Buffer.from(String(base64 || ''), 'base64');
    if (!buf.length) throw new Error('empty attachment');
    if (buf.length > 20 * 1024 * 1024) throw new Error('attachment is larger than 20 MB');
    const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const isWebp = buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
    const isGif = /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'));
    const ext = isPng ? 'png' : isJpg ? 'jpg' : isWebp ? 'webp' : isGif ? 'gif' : null;
    if (!ext) throw new Error(`not a PNG, JPEG, WebP or GIF image${mime ? ` (${String(mime).slice(0, 40)})` : ''}`);
    const stem = String(name || 'attached').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[^a-z0-9-_]/gi, '_').slice(0, 32) || 'attached';
    const fname = `ovr-${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${stem}.${ext}`;
    fs.writeFileSync(path.join(store.libraryDir, 'overseer', fname), buf);
    return { fname, mime: MEDIA_MIME['.' + ext], bytes: buf.length, url: `ala://ovr/${fname}` };
  });
  h('files:readAttachment', (_e, { fname }) => {
    const fpath = path.join(store.libraryDir, 'overseer', path.basename(String(fname || '')));
    if (!fs.existsSync(fpath)) throw new Error('attachment not found');
    return { base64: fs.readFileSync(fpath).toString('base64'), mime: MEDIA_MIME[path.extname(fpath).toLowerCase()] || 'image/png' };
  });
  h('files:deleteAttachment', (_e, { fname }) => {
    const fpath = path.join(store.libraryDir, 'overseer', path.basename(String(fname || '')));
    if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
    return true;
  });
  h('files:readImageBase64', (_e, { fname }) => {
    const fpath = path.join(store.libraryDir, 'images', path.basename(fname));
    if (!fs.existsSync(fpath)) throw new Error('not found');
    return fs.readFileSync(fpath).toString('base64');
  });
  h('files:deleteImage', (_e, { fname }) => {
    const fpath = path.join(store.libraryDir, 'images', path.basename(fname));
    if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
    return true;
  });
  /** Promote a file the upscaler dropped in tmp/ into the library, replacing a card's image. */
  h('files:adoptUpscaled', (_e, { tmpPath, currentFname }) => {
    if (!fs.existsSync(tmpPath)) throw new Error('upscaled file is gone');
    const ext = (path.extname(tmpPath) || '.png').slice(1).toLowerCase();
    return adoptUpscaledBuffer(fs.readFileSync(tmpPath), ext, currentFname, () => fs.unlink(tmpPath, () => {}));
  });
  /** The same promotion, from bytes the renderer already holds. */
  h('files:adoptUpscaledData', (_e, { base64, ext, currentFname }) => {
    const buf = Buffer.from(String(base64 || ''), 'base64');
    if (!buf.length) throw new Error('no image data came back from the page');
    return adoptUpscaledBuffer(buf, String(ext || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png', currentFname);
  });

  h('files:libraryDir', () => store.libraryDir);
  h('files:openLibrary', () => shell.openPath(store.libraryDir));
  /** How much disk the image library is actually using — Settings shows it. */
  h('files:libraryStats', () => {
    const dir = path.join(store.libraryDir, 'images');
    let count = 0, bytes = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        try {
          const st = fs.statSync(path.join(dir, f));
          if (st.isFile()) { count++; bytes += st.size; }
        } catch { }
      }
    } catch { }
    return { count, bytes };
  });

  h('comfy:http', async (_e, { url, method = 'GET', json = null, upload = null, timeoutMs = 0 }) => {
    const u = String(url || '');
    const limit = Math.min(30 * 60 * 1000, Math.max(5000, Number(timeoutMs) || 30 * 60 * 1000));
    if (!/^https?:\/\//i.test(u)) throw new Error('not a valid url');
    let body;
    const headers = {};
    if (json !== null && json !== undefined) {
      body = JSON.stringify(json);
      headers['Content-Type'] = 'application/json';
    } else if (upload) {
      const buf = Buffer.from(String(upload.base64 || ''), 'base64');
      if (!buf.length) throw new Error('no image data to upload');
      const form = new FormData();
      form.append('image', new Blob([buf], { type: `image/${upload.ext === 'jpg' ? 'jpeg' : (upload.ext || 'png')}` }), String(upload.fname || 'img.png'));
      form.append('subfolder', '');
      form.append('type', 'input');
      body = form;
    }
    const resp = await fetch(u, { method: String(method || 'GET').toUpperCase(), headers, body, signal: AbortSignal.timeout(limit) });
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/json')) {
      return { ok: resp.ok, status: resp.status, json: await resp.json().catch(() => null) };
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    return { ok: resp.ok, status: resp.status, base64: buf.toString('base64'), size: buf.length };
  });

  /**
   * Spawn the configured launch command detached; the driver polls for readiness.
   * The command is split into program + arguments first (double quotes group a path with
   * spaces), because spawning the whole line as one program name fails with ENOENT.
   */
  h('comfy:startServer', (_e, { command }) => {
    const cmd = String(command || '').trim();
    if (!cmd) return { ok: false, error: 'no launch command' };
    const parts = (cmd.match(/"[^"]*"|\S+/g) || []).map((t) => t.replace(/^"(.*)"$/, '$1'));
    try {
      const child = spawn(parts[0], parts.slice(1), { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', (e) => console.error('[comfy] launch failed:', e.message));
      child.unref();
      return { ok: true, pid: child.pid };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** List the .json workflow files in a folder (Settings picker). */
  h('comfy:listWorkflows', (_e, dir) => {
    const d = String(dir || '').trim();
    if (!d) return [];
    try {
      return fs.readdirSync(d)
        .filter((f) => f.toLowerCase().endsWith('.json'))
        .sort((a, b) => a.localeCompare(b));
    } catch (e) {
      return [];
    }
  });

  /** Read one workflow file as JSON. */
  h('comfy:readWorkflow', (_e, { dir, file }) => {
    const dRaw = String(dir || '').trim();
    const f = path.basename(String(file || '').trim());
    if (!dRaw || !f) throw new Error('missing workflow dir or file (pick a workflows folder and a workflow in Settings → Generation)');
    const d = path.resolve(dRaw);
    const full = path.join(d, f);
    if (full !== d && !full.startsWith(d + path.sep)) throw new Error('path escapes the workflows directory');
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  });

  /** Pick a folder of ComfyUI workflow files. */
  h('comfy:pickDir', async () => {
    if (!win || win.isDestroyed()) return null;
    const r = await dialog.showOpenDialog(win, { title: 'ComfyUI workflows folder', properties: ['openDirectory'] });
    return (r && !r.canceled && r.filePaths.length) ? r.filePaths[0] : null;
  });

  /** Download a ComfyUI /view URL straight into the library's videos/ folder. */
  h('comfy:downloadVideo', async (_e, { url, nameHint }) => {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) throw new Error('not a valid video url');
    const resp = await fetch(u, { signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (!resp.ok) throw new Error(`download failed: HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const ct = (resp.headers.get('content-type') || 'video/webm').split(';')[0].trim().toLowerCase();
    const ext = ct === 'video/mp4' ? 'mp4' : ct === 'image/webp' ? 'webp' : ct === 'video/x-matroska' ? 'mkv' : 'webm';
    const fname = `${String(nameHint || 'video').replace(/[^a-z0-9-_]/gi, '_').slice(0, 30)}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
    const fpath = path.join(store.libraryDir, 'videos', fname);
    fs.writeFileSync(fpath, buf);
    return { id: Date.now().toString(), fname, path: fpath, url: `ala://videos/${fname}`, size: buf.length };
  });

  /** Delete a saved video file (card delete). */
  h('comfy:deleteVideo', (_e, { fname }) => {
    const fpath = path.join(store.libraryDir, 'videos', path.basename(String(fname || '')));
    if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
    return true;
  });

  /** Convert a saved clip to an animated GIF with ffmpeg. */
  h('comfy:videoToGif', async (_e, { fname, fps = 12, width = 480, nameHint = 'i2v' }) => {
    const base = path.basename(String(fname || ''));
    const src = path.join(store.libraryDir, 'videos', base);
    if (!base || !/\.(mp4|webm|mkv|mov)$/i.test(base)) throw new Error('not a video file: ' + (base || '(none)'));
    if (!fs.existsSync(src)) throw new Error('video not found on disk: ' + base);
    const dir = path.join(store.libraryDir, 'gifs');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${String(nameHint).replace(/[^a-z0-9-_]/gi, '_').slice(0, 30)}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.gif`);
    const vf = `fps=${Number(fps) || 12},scale=${Number(width) || 480}:-1:flags=lanczos,`
      + 'split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle';
    await new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-vf', vf, '-loop', '0', out], { windowsHide: true });
      let err = '';
      child.stderr.on('data', (d) => { err = (err + d.toString()).slice(-1500); });
      child.on('error', (e) => reject(new Error(e.code === 'ENOENT'
        ? 'ffmpeg was not found on PATH — install it (winget install Gyan.FFmpeg) or add it to PATH, then try again'
        : 'ffmpeg could not start: ' + e.message)));
      child.on('close', (code) => (code === 0 && fs.existsSync(out))
        ? resolve()
        : reject(new Error(`ffmpeg exited ${code}${err.trim() ? ': ' + err.trim() : ''}`)));
    });
    const size = fs.statSync(out).size;
    return { fname: path.basename(out), path: out, url: `ala://gifs/${path.basename(out)}`, size };
  });

  let videoInspector = null;
  h('comfy:inspectVideo', (_e, opts = {}) => {
    if (!videoInspector) {
      videoInspector = createVideoInspector({
        spawn, fs, os: require('os'), path,
        libraryDir: () => store.libraryDir,
        whisperScript: path.join(__dirname, '..', '..', 'tools', 'whisper_transcribe.py'),
      });
    }
    return videoInspector.inspect(opts || {});
  });

  /** Delete a saved GIF (card delete, or replacing it on a re-render). */
  h('comfy:deleteGif', (_e, { fname }) => {
    const fpath = path.join(store.libraryDir, 'gifs', path.basename(String(fname || '')));
    if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
    return true;
  });

  /** Put the *picture* on the clipboard, not a path to it. */
  h('clip:writeImage', (_e, { fname }) => {
    const file = path.join(store.libraryDir, 'images', path.basename(String(fname || '')));
    if (!fs.existsSync(file)) throw new Error('image not found: ' + path.basename(file));
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) throw new Error('could not decode ' + path.basename(file));
    clipboard.writeImage(img);
    const { width, height } = img.getSize();
    return { ok: true, width, height };
  });

  /** Put a *file* on the clipboard, for the one thing here that is not a picture. */
  h('clip:writeFile', (_e, { fname, kind }) => {
    if (!['image', 'gif', 'video'].includes(kind)) throw new Error('Invalid media kind');
    const dir = kind === 'gif' ? 'gifs' : kind === 'video' ? 'videos' : 'images';
    const file = path.join(store.libraryDir, dir, path.basename(String(fname || '')));
    if (!fs.existsSync(file)) throw new Error(`${kind || 'file'} not found: ` + path.basename(file));
    clipboard.writeBuffer('FileNameW', Buffer.from(file + '\0', 'utf16le'));
    return { ok: true, name: path.basename(file), size: fs.statSync(file).size };
  });

  h('clip:writeText', (_e, { text }) => { clipboard.writeText(String(text ?? '')); return { ok: true }; });

  /** Open the library folder with this file already selected, ready to drag. */
  h('files:revealImage', (_e, { fname }) => {
    const file = path.join(store.libraryDir, 'images', path.basename(String(fname || '')));
    if (!fs.existsSync(file)) throw new Error('image not found');
    shell.showItemInFolder(file);
    return { ok: true };
  });

  h('da:beginAuth', () => da.beginAuth());
  h('da:status', async () => {
    const s = store.settings.data.da;
    return { authenticated: da.isAuthenticated, username: s.username || null, scope: s.scope || '' };
  });
  h('da:whoami', async () => {
    const me = await da.whoami();
    if (me && me.username) {
      store.settings.data.da.username = me.username;
      store.settings.save();
    }
    return me;
  });
  h('da:logout', () => {
    store.settings.data.da.accessToken = null;
    store.settings.data.da.refreshToken = null;
    store.settings.data.da.username = '';
    store.settings.save();
    return true;
  });
  h('da:stashDraft', (_e, payload) => da.stashDraft(payload));

  h('daweb:status', () => daweb.status());
  h('daweb:upload', (_e, payload) => daweb.uploadDraft(payload));
  h('daweb:applyMetadata', (_e, payload) => daweb.applyMetadata(payload));
  h('daweb:publish', (_e, { deviationId }) => daweb.publishDeviation(deviationId));
  h('daweb:deleteDraft', (_e, { deviationId }) => daweb.deleteDraft(deviationId));
  h('daweb:listDrafts', () => daweb.listDrafts());
  h('daweb:galleries', async () => {
    try { return await daweb.galleries(); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  h('da:uploadReadiness', async () => {
    const sess = await daweb.status();
    return {
      method: store.settings.data.da.uploadMethod || 'session',
      session: sess,
      api: { authenticated: da.isAuthenticated, username: store.settings.data.da.username || null },
    };
  });

  const allFrames = (wc) => wc.frames || (wc.mainFrame && wc.mainFrame.framesInSubtree) || [];
  const findGeneratorFrame = (wc) =>
    allFrames(wc).find((f) => /^https:\/\/[a-f0-9]{32}\.perchance\.org\//.test(f.url)) || null;

  h('pch:hasGenerator', (_e, { wcId }) => {
    const wc = webContents.fromId(wcId);
    return !!(wc && findGeneratorFrame(wc));
  });
  h('pch:execGenerator', (_e, { wcId, js }) => {
    const wc = webContents.fromId(wcId);
    if (!wc) throw new Error('webcontents gone');
    const frame = findGeneratorFrame(wc);
    if (!frame) throw new Error('generator frame not found (page still loading?)');
    return frame.executeJavaScript(js, true);
  });
  h('pch:execServer', (_e, { wcId, frameId, js }) => {
    const wc = webContents.fromId(wcId);
    if (!wc) throw new Error('webcontents gone');
    const frame = allFrames(wc).find((f) =>
      f.url.includes('image-generation.perchance.org/embed') && f.url.includes(frameId));
    if (!frame) throw new Error('server frame not found: ' + frameId);
    return frame.executeJavaScript(js, true);
  });

  /** Keep Windows from sleeping through an overnight run. */
  h('power:keepAwake', (_e, on) => {
    if (on) {
      if (powerBlockerId === null || !powerSaveBlocker.isStarted(powerBlockerId)) {
        powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
        console.log('[ala] power-save blocker started');
      }
    } else if (powerBlockerId !== null) {
      if (powerSaveBlocker.isStarted(powerBlockerId)) powerSaveBlocker.stop(powerBlockerId);
      powerBlockerId = null;
      console.log('[ala] power-save blocker released');
    }
    return powerBlockerId !== null;
  });

  h('app:openExternal', (_e, url) => shell.openExternal(url));
  h('app:version', () => app.getVersion());
  h('app:runtime', (e) => {
    if (e.sender !== win?.webContents || e.senderFrame !== win.webContents.mainFrame) throw new Error('Untrusted app sender');
    return { review: REVIEW_MODE, userData: app.getPath('userData') };
  });
  h('app:show', () => { if (win) win.show(); });
  /** OS notification. */
  h('app:notify', (_e, { title, body }) => {
    if (!Notification.isSupported()) return false;
    const n = new Notification({ title: String(title || 'AiLaborAutomation'), body: String(body || '') });
    n.on('click', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
    n.show();
    return true;
  });
}

function deepPatch(target, patchObj) {
  for (const [k, v] of Object.entries(patchObj || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      deepPatch(target[k], v);
    } else {
      target[k] = v;
    }
  }
}
