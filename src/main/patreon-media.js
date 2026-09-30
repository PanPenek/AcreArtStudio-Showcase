/**
 * patreon-media.js: hand a finished file to Patreon's own upload button.
 *
 * The artist writes and publishes the post themselves; this module only saves them
 * a trip through the file dialog. They click Patreon's upload button as usual and,
 * instead of the Windows file picker, the file input that button opened receives
 * the selected artwork (Chrome DevTools Protocol file-chooser interception). It
 * never creates, schedules or publishes a post.
 */
const fs = require('fs');
const path = require('path');
const TYPES = {
  image: {dir:'images', label:'Photo', extensions:['.png','.jpg','.jpeg','.webp','.avif','.bmp']},
  video: {dir:'videos', label:'MP4', extensions:['.mp4']},
  gif: {dir:'gifs', label:'GIF', extensions:['.gif']},
};
const MIME = {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.bmp':'image/bmp','.mp4':'video/mp4','.gif':'image/gif'};
const WAIT_MS = 2 * 60 * 1000;
const EDITOR_PATH = /\/posts?\/(?:new|[^/]+\/edit)(?:\/|$)/i;

function trustedPatreonUrl(raw) {
  try { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password && !u.port
    && ['www.patreon.com','patreon.com'].includes(u.hostname); } catch { return false; }
}
function isEditorUrl(raw) {
  return trustedPatreonUrl(raw) && EDITOR_PATH.test(new URL(raw).pathname);
}
/** Would an <input accept="…"> take this file? */
function acceptsFile(accept, mime, ext) {
  const list = String(accept || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  return !list.length || list.some(a => a === ext || a === mime || a === '*/*'
    || (a.endsWith('/*') && mime.startsWith(a.slice(0, -1))));
}

const WATCH_INPUT = `function () {
  return new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer);
      this.removeEventListener('input', seen, true);
      this.removeEventListener('change', seen, true);
      resolve(value);
    };
    const seen = () => {
      const f = this.files && this.files[0];
      done(f ? { name: f.name, size: f.size, count: this.files.length } : { empty: true });
    };
    const timer = setTimeout(() => done(null), 4000);
    this.addEventListener('input', seen, true);
    this.addEventListener('change', seen, true);
  });
}`;

function createPatreonMedia({store, getWindow, patreonSession, nativeImage, clipboard, shell, waitMs = WAIT_MS}) {
  const guests = new Map();
  const waiting = new Map();
  let tokens = 0;
  function hostEvent(e) {
    const host = getWindow()?.webContents;
    if (!host || e?.sender !== host || !e.senderFrame || e.senderFrame !== host.mainFrame) throw Error('Untrusted Patreon IPC sender');
    return host;
  }
  function cardFor(id) {
    if (typeof id !== 'string' || !id || id.length > 200) throw Error('Invalid card ID');
    const card = store.library.data.items.find(c => c.id === id);
    if (!card || card.status !== 'approved') throw Error('Card must still be approved');
    const publish = store.settings.data.publish || {};
    const valid = a => (a || []).filter(d => ['patreon','pixiv','deviantart'].includes(d));
    const own = valid(Array.isArray(card.destinations) ? card.destinations : [card.destination]);
    const destinations = own.length ? own : valid(Array.isArray(publish.destinations) ? publish.destinations : [publish.destination]);
    if (!destinations.includes('patreon')) throw Error('Card is not queued for Patreon');
    return card;
  }
  function mediaFor(p) {
    if (!p || !Object.hasOwn(TYPES, p.kind)) throw Error('Invalid media kind');
    const card = cardFor(p.cardId), type = TYPES[p.kind];
    const name = p.kind === 'image' ? card.fname : card[p.kind]?.fname;
    if (typeof name !== 'string' || !name || /[\\/:\x00-\x1f]/.test(name) || name === '.' || name === '..'
      || !type.extensions.includes(path.extname(name).toLowerCase())) throw Error('Invalid or unavailable media name');
    if (p.expectedName !== undefined && p.expectedName !== name) throw Error('Media changed; choose again');
    const library = fs.realpathSync(store.libraryDir);
    const folder = fs.realpathSync(path.join(library, type.dir));
    if (path.dirname(folder) !== library) throw Error('Media folder escapes library');
    const file = fs.realpathSync(path.join(folder, name));
    if (path.dirname(file) !== folder) throw Error('Media file escapes library');
    const stat = fs.statSync(file);
    if (!stat.isFile() || !stat.size) throw Error('Media file is empty or missing');
    return {file, name, kind:p.kind, label:type.label, size:stat.size, mime:MIME[path.extname(name).toLowerCase()]};
  }
  function selected(e,p) {
    hostEvent(e);
    if (typeof p?.expectedName !== 'string') throw Error('Choose a media file first');
    return mediaFor(p);
  }
  function trackGuest(guest) {
    if (guest.getType() !== 'webview' || guest.hostWebContents !== getWindow()?.webContents || guest.session !== patreonSession) return;
    guests.set(guest.id, guest);
    guest.once('destroyed', () => guests.delete(guest.id));
  }
  function guestFor(e,id) {
    const host = hostEvent(e), guest = guests.get(id);
    if (!Number.isInteger(id) || !guest || guest.isDestroyed() || guest.hostWebContents !== host
      || guest.session !== patreonSession || guest.getType() !== 'webview') throw Error('Not the attached Patreon guest');
    if (!trustedPatreonUrl(guest.getURL())) throw Error('The embedded page is not on patreon.com');
    if (!isEditorUrl(guest.getURL())) throw Error(`Open the Patreon post editor first (New post), then press Attach. This page is ${new URL(guest.getURL()).pathname}`);
    return guest;
  }
  function startDrag(e,p) {
    const m = selected(e,p);
    const icon = nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4, 255), { width: 16, height: 16 });
    e.sender.startDrag({file:m.file, icon});
  }
  function copyFile(e,p) {
    const m = selected(e,p);
    clipboard.writeBuffer('FileNameW', Buffer.from(m.file + '\0', 'utf16le'));
    return {state:'file-copied',name:m.name,size:m.size};
  }
  function reveal(e,p) { const m=selected(e,p); shell.showItemInFolder(m.file); return {name:m.name}; }

  function notify(job, payload) {
    if (!job.host || job.host.isDestroyed?.()) return;
    const {kind, label, name, size} = job.media;
    job.host.send('patreon:attachEvent', {token:job.token, cardId:job.cardId, kind, label, name, size, ...payload});
  }
  /** Hand the picker back to Patreon and tell the deck why. */
  async function finish(job, reason, message = '', {quiet = false} = {}) {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    if (waiting.get(job.guestId) === job) waiting.delete(job.guestId);
    const guest = job.guest;
    try { guest.removeListener('did-start-navigation', job.onNavigate); guest.removeListener('destroyed', job.onGone); } catch { }
    if (!guest.isDestroyed()) {
      const dbg = guest.debugger;
      dbg.removeListener('message', job.onMessage);
      dbg.removeListener('detach', job.onDetach);
      if (dbg.isAttached()) {
        try { await dbg.sendCommand('Page.setInterceptFileChooserDialog', {enabled:false}); } catch { }
        try { dbg.detach(); } catch { }
      }
    }
    if (!quiet) notify(job, {state: reason === 'filled' ? 'filled' : 'ended', reason, message});
  }
  async function chooserOpened(job, params) {
    if (job.done || job.busy) return;
    job.busy = true;
    const send = (method, p) => job.guest.debugger.sendCommand(method, p);
    try {
      if (!isEditorUrl(job.guest.getURL())) return await finish(job, 'navigated');
      if (!params?.backendNodeId) return await finish(job, 'error', 'Patreon opened a picker this cannot fill. Click its upload button again for the normal file dialog, or drag the file.');
      const current = mediaFor({cardId:job.cardId, kind:job.media.kind, expectedName:job.media.name});
      if (current.file !== job.media.file || current.size !== job.media.size) return await finish(job, 'error', 'The file changed on disk. Press Attach again.');
      const {node} = await send('DOM.describeNode', {backendNodeId:params.backendNodeId});
      const attrs = {};
      for (let i = 0; i + 1 < (node.attributes || []).length; i += 2) attrs[node.attributes[i].toLowerCase()] = node.attributes[i + 1];
      if (String(node.nodeName).toUpperCase() !== 'INPUT' || String(attrs.type).toLowerCase() !== 'file') {
        return await finish(job, 'error', 'Patreon opened something other than a file field. Use Drag file instead.');
      }
      if (!acceptsFile(attrs.accept, current.mime, path.extname(current.name).toLowerCase())) {
        notify(job, {state:'wrong-input', accept:attrs.accept || '',
          message:`That Patreon button only takes ${attrs.accept}, not a ${current.label}. Click the media/video upload instead — still waiting.`});
        return;
      }
      const {object} = await send('DOM.resolveNode', {backendNodeId:params.backendNodeId});
      const watch = send('Runtime.callFunctionOn', {objectId:object.objectId, functionDeclaration:WATCH_INPUT, awaitPromise:true, returnByValue:true});
      await send('DOM.setFileInputFiles', {backendNodeId:params.backendNodeId, files:[current.file]});
      const seen = (await watch)?.result?.value;
      if (!seen || seen.name !== current.name || seen.size !== current.size) {
        return await finish(job, 'error', 'Patreon did not confirm the file. Look at the composer before trying again, so it is not attached twice.');
      }
      await finish(job, 'filled');
    } catch (err) {
      await finish(job, 'error', String(err?.message || err));
    } finally { job.busy = false; }
  }
  /**
   * Wait for the artist's next click on one of Patreon's upload buttons, and give that picker this
   * card's file.
   */
  async function arm(e,p) {
    const media = selected(e,p);
    const guest = guestFor(e,p.guestId);
    const previous = waiting.get(guest.id);
    if (previous) await finish(previous, 'replaced');
    if (guest.debugger.isAttached()) throw Error('Close DevTools on the Patreon page first — Attach needs its debugger');
    const job = {token:++tokens, guest, guestId:guest.id, host:e.sender, media, cardId:p.cardId, done:false, busy:false};
    job.onMessage = (_event, method, params) => { if (method === 'Page.fileChooserOpened') chooserOpened(job, params); };
    job.onDetach = () => { finish(job, 'detached'); };
    job.onNavigate = (event, _url, inPlace, isMainFrame) => {
      const main = event?.isMainFrame ?? isMainFrame, sameDocument = event?.isSameDocument ?? inPlace;
      if (main && !sameDocument) finish(job, 'navigated');
    };
    job.onGone = () => { finish(job, 'closed'); };
    const dbg = guest.debugger;
    dbg.attach('1.3');
    dbg.on('message', job.onMessage);
    dbg.on('detach', job.onDetach);
    guest.on('did-start-navigation', job.onNavigate);
    guest.once('destroyed', job.onGone);
    waiting.set(guest.id, job);
    try {
      await dbg.sendCommand('Page.enable');
      await dbg.sendCommand('Page.setInterceptFileChooserDialog', {enabled:true});
    } catch (err) {
      await finish(job, 'error', '', {quiet:true});
      throw Error('Could not hook Patreon\'s file picker: ' + (err?.message || err));
    }
    if (job.done) throw Error('Patreon changed page while Attach was starting. Press Attach again.');
    job.timer = setTimeout(() => finish(job, 'timeout'), waitMs);
    return {state:'waiting', token:job.token, kind:media.kind, label:media.label, name:media.name, size:media.size, waitMs};
  }
  async function disarm(e,p) {
    hostEvent(e);
    const job = waiting.get(p?.guestId);
    if (job && (p.token === undefined || p.token === job.token)) await finish(job, 'cancelled');
    return {state:'idle'};
  }
  return {trackGuest,startDrag,copyFile,reveal,arm,disarm};
}
module.exports={createPatreonMedia,trustedPatreonUrl,isEditorUrl,acceptsFile};
