/**
 * pixiv.js: pixiv uploader that runs inside the signed-in pixiv page.
 *
 * pixiv refuses requests that are not from a real browser session, so the upload
 * runs inside the embedded pixiv tab: cookies, headers and the CSRF token are
 * genuinely the browser's, and the request is same-origin. Everything the page
 * returns is plain JSON, validated here. The form format was read from pixiv's own
 * page code rather than guessed (camelCase keys, a conversion key that must be
 * polled until the work exists).
 */
(function () {
  const ORIGIN = 'https://www.pixiv.net';
  const UPLOAD_PAGE = ORIGIN + '/illustration/create';
  const MAX_BYTES = 32 * 1024 * 1024;
  const NAV_TIMEOUT_MS = 45000;
  const POLL_INTERVAL_MS = 1000;
  const POLL_MAX_TRIES = 90;

  const HUMAN_CHECK_RE = /recaptcha|captcha|are ?you ?a ?human|bot ?check/i;
  const HUMAN_CHECK_MSG = 'pixiv now asks for a human check when a picture is uploaded, so it '
    + 'will not accept an automatic post. Press “Prepare on pixiv” — the app fills the real '
    + 'upload form for you and you press Post.';

  const FIELD_SELECTORS = {
    image: ['input[type=file]'],
    title: ['input[name="title"]', 'input[placeholder*="タイトル"]', 'input[aria-label*="title" i]',
      'input[placeholder*="title" i]'],
    caption: ['textarea[name="caption"]', 'textarea[name="comment"]', 'textarea[placeholder*="キャプション"]',
      'textarea[aria-label*="caption" i]', 'textarea[aria-label*="description" i]',
      'div[contenteditable="true"]', 'textarea'],
    tags: ['input[name="tag"]', 'input[placeholder*="タグ"]', 'input[aria-label*="tag" i]',
      'input[placeholder*="tag" i]'],
  };

  const RADIO_GROUPS = [
    ['x_restrict', 'xRestrict', 'age rating', true],
    ['ai_type', 'aiType', 'AI declaration', true],
    ['restrict', 'restrict', 'who can see it', false],
    ['original', 'original', 'original work', false],
  ];

  let wv = null;

  const IDENTITY_JS = `(() => {
    const out = { token: null, userId: null, username: null, url: location.href };
    try {
      const meta = document.querySelector('meta[name="global-data"]');
      if (meta && meta.content) {
        const g = JSON.parse(meta.content);
        if (g.token) out.token = String(g.token);
        if (g.userData && g.userData.id) {
          out.userId = String(g.userData.id);
          out.username = g.userData.pixivId || g.userData.name || null;
        }
      }
    } catch (e) { out.parseError = e.message; }
    const html = document.documentElement.innerHTML;
    const grab = (patterns) => {
      for (const re of patterns) { const m = html.match(re); if (m) return m[1]; }
      return null;
    };
    if (!out.token) {
      out.token = grab([
        /\\\\?"token\\\\?"\\s*:\\s*\\\\?"([0-9a-zA-Z_-]{16,64})\\\\?"/,
        /\\\\?"csrfToken\\\\?"\\s*:\\s*\\\\?"([0-9a-zA-Z_-]{16,64})\\\\?"/,
      ]);
    }
    if (!out.userId) {
      out.userId = grab([
        /\\\\?"user_id\\\\?"\\s*:\\s*\\\\?"(\\d{2,})\\\\?"/,
        /\\\\?"userId\\\\?"\\s*:\\s*\\\\?"(\\d{2,})\\\\?"/,
      ]);
    }
    if (!out.username) {
      out.username = grab([
        /\\\\?"pixivId\\\\?"\\s*:\\s*\\\\?"([^"\\\\]{1,40})\\\\?"/,
        /\\\\?"userName\\\\?"\\s*:\\s*\\\\?"([^"\\\\]{1,40})\\\\?"/,
      ]);
    }
    out.loginPage = /accounts\\.pixiv\\.net|\\/login/.test(location.href);
    return out;
  })()`;

  const PROBE_JS = `(() => {
    const radios = {};
    for (const el of document.querySelectorAll('input[type=radio], input[type=checkbox]')) {
      const name = el.name || '(unnamed)';
      (radios[name] = radios[name] || []).push({ value: el.value, checked: !!el.checked });
    }
    const fields = [...document.querySelectorAll('input[name], select[name], textarea[name]')]
      .map((el) => ({ name: el.name, tag: el.tagName.toLowerCase(), type: el.type || null }));

    /**
     * Would a Prepare find what it needs?
     *
     * The same selector lists the filler uses, resolved but not touched. This is the whole
     * value of the Probe button now: the wire contract is settled and pinned by tests, but
     * the *form* is markup that can be restyled underneath this app at any time, and the
     * only cheap way to know is to look before there is a picture riding on it.
     */
    const SELS = ${JSON.stringify(FIELD_SELECTORS)};
    const reach = {};
    for (const key of Object.keys(SELS)) {
      let hit = null;
      for (const s of SELS[key]) {
        let el = null;
        try { el = document.querySelector(s); } catch (e) { continue; }
        if (el) { hit = { selector: s, tag: el.tagName.toLowerCase(), name: el.name || null }; break; }
      }
      reach[key] = hit;
    }
    for (const [domName] of ${JSON.stringify(RADIO_GROUPS)}) {
      const opts = radios[domName];
      reach[domName] = opts ? { selector: 'input[name="' + domName + '"]', values: opts.map((o) => o.value) } : null;
    }
    return { url: location.href, title: document.title, radios, fields, reach,
             hasFileInput: !!document.querySelector('input[type=file]') };
  })()`;

  const Pixiv = {
    last: null,

    attach(webview) { wv = webview; },
    get attached() { return !!wv; },

    /** Is the guest currently sitting on a pixiv page we can post from? */
    onPixiv() {
      try { return !!wv && /^https:\/\/(www\.)?pixiv\.net\//.test(wv.getURL() || ''); }
      catch { return false; }
    },

    /** Put the guest on the upload page and wait for it. */
    async ready() {
      if (!wv) throw new Error('the Pixiv tab has not loaded yet — open it once');
      if (this.onPixiv()) return true;
      await this.navigate(UPLOAD_PAGE);
      return true;
    },

    navigate(url) {
      if (!wv) return Promise.reject(new Error('no Pixiv tab'));
      return new Promise((resolve, reject) => {
        let done = false;
        const finish = (fn, arg) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          wv.removeEventListener('did-finish-load', ok);
          wv.removeEventListener('did-fail-load', fail);
          fn(arg);
        };
        const ok = () => finish(resolve, true);
        const fail = (e) => {
          if (e.errorCode === -3) return finish(resolve, true);
          finish(reject, new Error(`could not open ${url}: ${e.errorDescription || e.errorCode}`));
        };
        const timer = setTimeout(() => finish(reject, new Error('timed out loading ' + url)), NAV_TIMEOUT_MS);
        wv.addEventListener('did-finish-load', ok);
        wv.addEventListener('did-fail-load', fail);
        try { wv.loadURL(url); } catch (e) { finish(reject, e); }
      });
    },

    exec(js) {
      if (!wv) return Promise.reject(new Error('the Pixiv tab has not loaded yet'));
      return wv.executeJavaScript(js, true);
    },

    /** Signed in, and as whom? */
    async status({ navigate = false } = {}) {
      try {
        if (!wv) return { ok: false, error: 'the Pixiv tab has not loaded yet — open it once' };
        if (navigate && !this.onPixiv()) await this.ready();
        if (!this.onPixiv()) {
          return { ok: false, error: `the Pixiv tab is on ${short(safeUrl())} — press Reload, or sign in` };
        }
        const id = await this.exec(IDENTITY_JS);
        if (!id) return { ok: false, error: 'the Pixiv page did not answer — reload the tab' };
        if (id.loginPage || !id.userId) {
          return { ok: false, kind: 'auth', error: 'not signed in to pixiv — log in on the Pixiv tab' };
        }
        if (!id.token) {
          return { ok: false, kind: 'transient', error: 'signed in, but no CSRF token on this page — press Reload' };
        }
        return { ok: true, userId: id.userId, username: id.username || null, url: id.url };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    /** What the live upload form accepts. */
    async probe() {
      await this.ready();
      if (!/\/illustration\/create|upload\.php/.test(safeUrl())) await this.navigate(UPLOAD_PAGE);
      return this.exec(PROBE_JS);
    },

    /** Post one illustration. */
    async post(payload) {
      const { fields = {}, tags = [], fname = 'image.png', mime = 'image/png', base64 = '' } = payload || {};
      if (!base64) return { ok: false, kind: 'permanent', error: 'no image data to post' };
      const bytes = Math.floor(base64.length * 0.75);
      if (bytes > MAX_BYTES) {
        return {
          ok: false, kind: 'permanent',
          error: `image is ${(bytes / 1048576).toFixed(1)} MB — pixiv's limit is ${MAX_BYTES / 1048576} MB`,
        };
      }

      try {
        await this.ready();
      } catch (e) {
        return { ok: false, kind: 'transient', error: e.message };
      }

      const st = await this.status();
      if (!st.ok) return { ok: false, kind: st.kind || 'auth', error: st.error };

      this.last = { at: Date.now(), endpoint: '/ajax/work/create/illustration', fields, tags, status: null, body: null };

      let res;
      try {
        res = await this.exec(uploadJs({ fields, tags, fname, mime, base64 }));
      } catch (e) {
        return { ok: false, kind: 'transient', error: 'the Pixiv tab went away mid-upload: ' + e.message };
      }
      if (!res) return { ok: false, kind: 'transient', error: 'no answer from the Pixiv tab' };

      this.last.status = res.status ?? null;
      this.last.body = String(res.raw || '').slice(0, 2000);

      if (res.ok && res.illustId) {
        return { ok: true, illustId: String(res.illustId), url: `${ORIGIN}/artworks/${res.illustId}`, raw: res.raw };
      }
      const error = res.error || `pixiv returned HTTP ${res.status} with nothing usable in it`;
      if (HUMAN_CHECK_RE.test(error)) {
        return { ok: false, kind: 'manual', error: HUMAN_CHECK_MSG, detail: error, status: res.status, raw: res.raw };
      }
      return { ok: false, kind: res.kind || classify(error, res.status), error, status: res.status, raw: res.raw };
    },

    /** Stage a card on the real upload page, and stop. */
    async prepare(payload) {
      const { fields = {}, tags = [], fname = 'image.png', mime = 'image/png', base64 = '' } = payload || {};
      if (!base64) return { ok: false, kind: 'permanent', error: 'no image data to stage' };
      const bytes = Math.floor(base64.length * 0.75);
      if (bytes > MAX_BYTES) {
        return {
          ok: false, kind: 'permanent',
          error: `image is ${(bytes / 1048576).toFixed(1)} MB — pixiv's limit is ${MAX_BYTES / 1048576} MB`,
        };
      }
      if (!wv) return { ok: false, kind: 'transient', error: 'the Pixiv tab has not loaded yet — open it once' };

      try {
        await this.navigate(UPLOAD_PAGE);
      } catch (e) {
        return { ok: false, kind: 'transient', error: e.message };
      }

      const st = await this.status();
      if (!st.ok) return { ok: false, kind: st.kind || 'auth', error: st.error };

      const sinceId = await this.snapshotWorks(st.userId);

      let res;
      try {
        res = await this.exec(fillJs({ fields, tags, fname, mime, base64 }));
      } catch (e) {
        return { ok: false, kind: 'transient', error: 'the Pixiv tab went away while filling the form: ' + e.message };
      }
      if (!res) return { ok: false, kind: 'transient', error: 'no answer from the Pixiv tab' };

      this.last = {
        at: Date.now(), endpoint: '(form staged for a manual post)', fields, tags,
        status: null, body: `filled: ${(res.filled || []).join(', ') || '(nothing)'}\nnot filled: ${(res.missed || []).join(', ') || '(nothing)'}`,
      };

      return {
        ok: !!res.ok, filled: res.filled || [], missed: res.missed || [],
        critical: res.critical || [], userId: st.userId, sinceId,
        error: res.ok ? null : (res.error || 'could not fill the pixiv upload form'),
      };
    },

    /** The highest illustration id on the account right now, or null. */
    async snapshotWorks(userId) {
      try {
        const r = await this.exec(worksJs(userId));
        return r && r.ok && r.maxId ? String(r.maxId) : null;
      } catch { return null; }
    },

    /** Has anything newer than `sinceId` appeared on the account? */
    async harvest(userId, sinceId) {
      try {
        const r = await this.exec(worksJs(userId));
        if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'could not read your pixiv works' };
        const since = Number(sinceId || 0);
        const fresh = (r.ids || []).map(Number).filter((n) => Number.isFinite(n) && n > since).sort((a, b) => a - b);
        return { ok: true, illustId: fresh.length ? String(fresh[fresh.length - 1]) : null, count: r.count };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    classify,
    HUMAN_CHECK_RE,
    HUMAN_CHECK_MSG,
  };

  function safeUrl() { try { return (wv && wv.getURL()) || ''; } catch { return ''; } }
  function short(u) { return String(u || '(nothing)').replace(/^https?:\/\//, '').slice(0, 60); }

  /** Is this failure worth retrying, a sign we are signed out, or pixiv's final answer? */
  function classify(message, status) {
    const m = String(message || '').toLowerCase();
    if (HUMAN_CHECK_RE.test(m)) return 'manual';
    if (/not signed in|log ?in|logged out|session|unauthor/.test(m)) return 'auth';
    if (status === 401 || status === 403) return 'auth';
    if (status === 429 || (status >= 500 && status <= 599)) return 'transient';
    if (/network|timed? ?out|timeout|abort|econnreset|rate ?limit|too many requests|try again|temporar/.test(m)) {
      return 'transient';
    }
    if (/csrf|token/.test(m)) return 'transient';
    return 'permanent';
  }

  /** The guest-side upload. */
  function uploadJs({ fields, tags, fname, mime, base64 }) {
    return `(async () => {
  const FIELDS = ${JSON.stringify(fields)};
  const TAGS = ${JSON.stringify(tags)};
  const FNAME = ${JSON.stringify(fname)};
  const MIME = ${JSON.stringify(mime)};
  const B64 = ${JSON.stringify(base64)};
  const POLL_MS = ${POLL_INTERVAL_MS};
  const POLL_MAX = ${POLL_MAX_TRIES};

  const ident = ${IDENTITY_JS};
  if (!ident.token) return { ok: false, kind: 'auth', status: 0, error: 'no CSRF token on the page — sign in again' };

  let file;
  try {
    const bin = atob(B64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    file = new File([arr], FNAME, { type: MIME });
  } catch (e) {
    return { ok: false, kind: 'permanent', status: 0, error: 'could not rebuild the image in the page: ' + e.message };
  }

  // Mirrors pixiv's own serialiser: null/undefined/'' are dropped rather than sent, and a
  // key ending in [] is a repeated field.
  const fd = new FormData();
  for (const k of Object.keys(FIELDS)) {
    const v = FIELDS[k];
    if (v === null || v === undefined || v === '') continue;
    fd.append(k, String(v));
  }
  for (const t of TAGS) fd.append('tags[]', t);
  fd.append('files[]', file, FNAME);
  /**
   * imageOrder is REQUIRED, and it is not a setting — it is derived from the file list.
   *
   * Leaving it out gets \`{"errors":{"imageOrder":"Invalid parameter."}}\` and nothing else,
   * which is how this was found. pixiv's own builder maps each file to
   * \`{ type, fileKey }\` — 'newFile' with a running index for a fresh upload, 'reupload' or
   * 'linkedService' for files already on the account — and its serialiser flattens an
   * array of objects to \`name[i][key]\`. This app posts exactly one fresh file per card,
   * so that mapping has exactly one entry.
   */
  fd.append('imageOrder[0][type]', 'newFile');
  fd.append('imageOrder[0][fileKey]', '0');

  const headers = { 'x-csrf-token': ident.token, Accept: 'application/json' };
  const readErr = (data, raw, status) => {
    let msg = (data && typeof data.message === 'string' && data.message) || '';
    const errs = data && data.body && data.body.errors;
    if (errs) {
      const parts = [];
      for (const k of Object.keys(errs)) {
        const v = errs[k];
        parts.push(k + ': ' + (Array.isArray(v) ? v.join('; ') : (v && v.message) || String(v)));
      }
      if (parts.length) msg = parts.join(' · ');
    }
    if (!msg && data && typeof data.error === 'string') msg = data.error;
    if (!msg) {
      msg = String(raw || '')
        .replace(/<script[\\s\\S]*?<\\/script>/gi, ' ')
        .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\\s+/g, ' ')
        .trim()
        .slice(0, 300) || ('HTTP ' + status);
    }
    return msg;
  };

  // ---- 1. hand over the picture and its metadata ----
  let resp, raw;
  try {
    resp = await fetch('/ajax/work/create/illustration', {
      method: 'POST', credentials: 'include', headers, body: fd,
    });
    raw = await resp.text();
  } catch (e) {
    return { ok: false, kind: 'transient', status: 0, error: 'network error posting to pixiv: ' + e.message };
  }

  let data = null;
  try { data = JSON.parse(raw); } catch (e) { /* an HTML error page */ }
  if (!data || data.error) {
    return { ok: false, status: resp.status, error: readErr(data, raw, resp.status), raw: String(raw || '').slice(0, 2000) };
  }

  // ---- 2. wait for pixiv to finish making it ----
  // The POST does not create the illustration; it queues the conversion and hands back a
  // convertKey. The id only exists once /progress says COMPLETE, so a client that stops at
  // the POST reports "accepted but named no id" for a post that is going to succeed.
  const key = (data.body && (data.body.convertKey || data.body.convert_key)) || null;
  const direct = data.body && (data.body.illustId || data.body.illust_id);
  if (direct) return { ok: true, status: resp.status, illustId: String(direct), raw: String(raw).slice(0, 2000) };
  if (!key) {
    return { ok: false, status: resp.status, kind: 'permanent',
             error: 'pixiv accepted the upload but returned neither an illustration id nor a convertKey',
             raw: String(raw).slice(0, 2000) };
  }

  for (let i = 0; i < POLL_MAX; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let pr, praw;
    try {
      pr = await fetch('/ajax/work/create/illustration/progress?convertKey=' + encodeURIComponent(key),
        { credentials: 'include', headers });
      praw = await pr.text();
    } catch (e) {
      continue; // a blip mid-poll is not a failed upload — the work is already queued
    }
    let pd = null;
    try { pd = JSON.parse(praw); } catch (e) { continue; }
    const b = (pd && pd.body) || {};
    if (pd && pd.error) {
      return { ok: false, status: pr.status, error: readErr(pd, praw, pr.status), raw: String(praw).slice(0, 2000) };
    }
    if (b.status === 'COMPLETE') {
      const id = b.illustId || b.illust_id || null;
      return id
        ? { ok: true, status: pr.status, illustId: String(id), raw: String(praw).slice(0, 2000) }
        : { ok: false, status: pr.status, kind: 'permanent',
            error: 'pixiv finished the upload but named no illustration id', raw: String(praw).slice(0, 2000) };
    }
    if (b.status === 'FAILURE') {
      return { ok: false, status: pr.status, kind: 'permanent',
               error: 'pixiv could not process the image (' + (b.message || 'FAILURE') + ')',
               raw: String(praw).slice(0, 2000) };
    }
  }
  // Timed out watching, but the upload itself was accepted — so this must NOT read as a
  // failure the caller retries, or the same picture goes up twice.
  return { ok: false, status: resp.status, kind: 'pending',
           error: 'pixiv accepted the upload but was still processing it after '
             + Math.round((POLL_MS * POLL_MAX) / 1000) + 's — check your pixiv profile before posting it again',
           raw: String(raw).slice(0, 2000) };
})()`;
  }

  /** Every illustration id on an account, newest first by number. */
  function worksJs(userId) {
    return `(async () => {
  try {
    const r = await fetch('/ajax/user/' + encodeURIComponent(${JSON.stringify(String(userId || ''))}) + '/profile/all',
      { credentials: 'include', headers: { Accept: 'application/json' } });
    const d = await r.json();
    if (!d || d.error) return { ok: false, error: (d && d.message) || ('HTTP ' + r.status) };
    const ill = (d.body && d.body.illusts) || {};
    const ids = Object.keys(ill).filter((k) => /^\\d+$/.test(k));
    let max = null;
    for (const k of ids) { if (max === null || Number(k) > Number(max)) max = k; }
    return { ok: true, ids, maxId: max, count: ids.length };
  } catch (e) { return { ok: false, error: e.message }; }
})()`;
  }

  /** Fill pixiv's upload form. */
  function fillJs({ fields, tags, fname, mime, base64 }) {
    return `(async () => {
  const F = ${JSON.stringify(fields)};
  const TAGS = ${JSON.stringify(tags)};
  const FNAME = ${JSON.stringify(fname)};
  const MIME = ${JSON.stringify(mime)};
  const B64 = ${JSON.stringify(base64)};
  const SELS = ${JSON.stringify(FIELD_SELECTORS)};
  const GROUPS = ${JSON.stringify(RADIO_GROUPS)};

  const filled = [];
  const missed = [];
  const critical = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const setNative = (el, value) => {
    const proto = (el.tagName === 'TEXTAREA') ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, String(value)); else el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const setText = (el, value) => {
    if (!el) return false;
    el.focus();
    if (el.isContentEditable) {
      // A rich-text description: there is no .value to set, so it is typed in.
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, String(value));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    setNative(el, value);
    return true;
  };
  const pick = (sels) => {
    for (const s of sels) {
      let el = null;
      try { el = document.querySelector(s); } catch (e) { continue; }
      if (el && el.offsetParent !== null) return el;
      if (el && !el.offsetParent && s.indexOf('file') >= 0) return el; // file inputs are usually hidden
    }
    // Second pass ignoring visibility, rather than giving up on a field that is merely
    // scrolled out of the layout.
    for (const s of sels) {
      try { const el = document.querySelector(s); if (el) return el; } catch (e) { /* bad selector */ }
    }
    return null;
  };
  const q = (s) => JSON.stringify(String(s));

  // ---- the picture ----
  const fileEl = pick(SELS.image);
  if (!fileEl) {
    missed.push('the image (no file input on this page)');
  } else {
    try {
      const bin = atob(B64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([arr], FNAME, { type: MIME }));
      fileEl.files = dt.files;
      fileEl.dispatchEvent(new Event('change', { bubbles: true }));
      filled.push('the image');
    } catch (e) {
      missed.push('the image (' + e.message + ')');
    }
  }
  // The uploader re-renders around the thumbnail once it has a file, and the text fields
  // below only exist after that.
  await sleep(1500);

  // ---- title ----
  if (F.title) {
    const el = pick(SELS.title);
    if (setText(el, F.title)) filled.push('title'); else missed.push('title');
  }

  // ---- caption / description ----
  if (F.caption) {
    const el = pick(SELS.caption);
    if (setText(el, F.caption)) filled.push('caption'); else missed.push('caption');
  }

  // ---- tags ----
  if (TAGS.length) {
    const el = pick(SELS.tags);
    if (!el) {
      missed.push(TAGS.length + ' tag(s)');
    } else {
      let n = 0;
      for (const t of TAGS) {
        setNative(el, t);
        await sleep(150);
        // pixiv's tag box commits on Enter; the three events are dispatched because
        // different builds have listened on different ones.
        for (const type of ['keydown', 'keypress', 'keyup']) {
          el.dispatchEvent(new KeyboardEvent(type, {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
          }));
        }
        await sleep(220);
        n++;
      }
      filled.push(n + ' tag(s)');
    }
  }

  /**
   * The radio groups.
   *
   * The DOM names are snake_case while the wire fields are camelCase (the whole reason
   * this integration reads the bundle rather than the markup), and the DOM *values* have
   * historically been either the same strings the wire takes or the numeric codes behind
   * them. Both are tried before a field is called missed.
   */
  const ALIASES = {
    general: ['general', '0'],
    aiGenerated: ['aiGenerated', '2'], notAiGenerated: ['notAiGenerated', '1'],
    public: ['public', '0'], loginOnly: ['loginOnly', '1'], mypixiv: ['mypixiv', '2'], private: ['private', '3'],
    true: ['true', '1'], false: ['false', '0'],
  };
  const setRadio = (name, value) => {
    if (value === null || value === undefined || value === '') return true; // nothing asked for
    const tries = ALIASES[String(value)] || [String(value)];
    for (const v of tries) {
      let el = null;
      try { el = document.querySelector('input[name=' + q(name) + '][value=' + q(v) + ']'); } catch (e) { /* skip */ }
      if (el) { if (!el.checked) el.click(); return true; }
    }
    return false;
  };

  for (const [name, wireKey, label, isCritical] of GROUPS) {
    const value = F[wireKey];
    if (value === null || value === undefined || value === '') continue;
    if (setRadio(name, value)) {
      filled.push(label);
    } else {
      missed.push(label + ' (wanted "' + value + '")');
      if (isCritical) critical.push(label);
    }
  }

  // Bring the form into view so the person lands on it rather than on the top of the page.
  try { (fileEl && fileEl.closest('form') || document.body).scrollIntoView({ block: 'start' }); } catch (e) { /* cosmetic */ }

  return { ok: filled.length > 0, filled, missed, critical, url: location.href };
})()`;
  }

  window.Pixiv = Pixiv;
})();
