/**
 * daweb.js: DeviantArt uploader that uses the signed-in browser session.
 *
 * Does what DeviantArt's own upload page does, with the user's own cookies:
 *   1. upload the image     -> creates a private draft
 *   2. read the draft info  -> gallery folders + draft URL
 *   3. write the metadata   -> title, description, tags, AI-generated flag
 *   4. (optional) publish   -> only when the user switched "submit after upload" on
 * Errors are classified (retry later / signed out / final answer) so the queue
 * knows whether to try again.
 */
const { session } = require('electron');
const fs = require('fs');
const path = require('path');

const ORIGIN = 'https://www.deviantart.com';
const DA_MINOR = '20230710';
const DRAFT_FOLDER = 'Saved Submissions';
const CSRF_TTL_MS = 10 * 60 * 1000;
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

class DAWebClient {
  constructor(partition = 'persist:da') {
    this.partition = partition;
    this._csrf = null;
    this._csrfAt = 0;
    this._username = null;
  }

  get ses() { return session.fromPartition(this.partition); }

  _headers(extra = {}) {
    return {
      'User-Agent': this.ses.getUserAgent(),
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-GB,en;q=0.9',
      Origin: ORIGIN,
      Referer: `${ORIGIN}/studio`,
      'X-Requested-With': 'XMLHttpRequest',
      ...extra,
    };
  }

  async _fetch(url, init = {}, timeoutMs = 120000) {
    return this.ses.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  }

  /** CSRF token, scraped from any server-rendered DeviantArt page. */
  async csrf(force = false) {
    if (!force && this._csrf && Date.now() - this._csrfAt < CSRF_TTL_MS) return this._csrf;
    const resp = await this._fetch(`${ORIGIN}/studio`, {
      headers: this._headers({ Accept: 'text/html,application/xhtml+xml' }),
    }, 45000);
    const html = await resp.text();
    const m = html.match(/name="validate_token"[^>]*value="([^"]+)"/)
      || html.match(/csrfToken\\?["']?\s*:\s*\\?["']([A-Za-z0-9_.-]{20,})/);
    if (!m) {
      const loggedOut = /\/users\/login|Join DeviantArt/i.test(html);
      throw new Error(loggedOut
        ? 'Not logged in to DeviantArt — open the DeviantArt tab and sign in.'
        : 'Could not read the DeviantArt session token (page layout changed?).');
    }
    this._csrf = m[1];
    this._csrfAt = Date.now();
    return this._csrf;
  }

  /** Are we signed in, and as whom? */
  async status() {
    try {
      const token = await this.csrf();
      const qs = new URLSearchParams({
        init: 'false',
        deviations_offset: '0',
        root_foldername: DRAFT_FOLDER,
        da_minor_version: DA_MINOR,
        csrf_token: token,
      });
      const resp = await this._fetch(`${ORIGIN}/_puppy/v1/studio/pages/drafts?${qs}`, {
        headers: this._headers(),
      }, 45000);
      if (resp.status === 403) { this._csrf = null; return { ok: false, error: 'session token rejected — reload the DeviantArt tab' }; }
      const data = await resp.json().catch(() => null);
      const owner = data && data.rootFolder && data.rootFolder.owner;
      if (!owner || !owner.username) return { ok: false, error: 'not signed in to DeviantArt' };
      this._username = owner.username;
      return {
        ok: true,
        username: owner.username,
        drafts: (data.rootFolder && data.rootFolder.size) || 0,
        quotaUsed: data.rootFolder && data.rootFolder.usage,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** The account's gallery folders. */
  async galleries() {
    const token = await this.csrf();
    if (!this._username) await this.status();
    const qs = new URLSearchParams({
      username: this._username || '',
      type: 'gallery',
      offset: '0',
      limit: '50',
      da_minor_version: DA_MINOR,
      csrf_token: token,
    });
    const resp = await this._fetch(`${ORIGIN}/_puppy/dashared/gallection/folders?${qs}`, {
      headers: this._headers(),
    }, 45000);
    const data = await resp.json().catch(() => ({}));
    if (!Array.isArray(data.results)) return { ok: false, error: daError(data, resp.status) };
    return {
      ok: true,
      galleries: data.results.map((g) => ({
        id: String(g.folderId), name: g.name, special: g.specialType || null,
      })),
    };
  }

  /** Per-draft detail: which galleries it landed in, and its Sta.sh url. */
  async draftInfo(privateId, token) {
    const qs = new URLSearchParams({
      deviationid: String(privateId),
      da_minor_version: DA_MINOR,
      csrf_token: token,
    });
    const resp = await this._fetch(`${ORIGIN}/_puppy/dashared/deviation/submit/init?${qs}`, {
      headers: this._headers(),
    }, 45000);
    const data = await resp.json().catch(() => ({}));
    return {
      galleries: (data.galleries || []).map((g) => ({
        id: String(g.folderId), name: g.name, special: g.specialType || null,
      })),
      stashUrl: (data.deviation && (data.deviation.url || data.deviation.shortUrl)) || null,
      deviationId: data.deviation && data.deviation.deviationId,
    };
  }

  /**
   * Upload one image as a draft, write its metadata, and — when `publish` is set — press Submit for
   * it.
   */
  async uploadDraft({
    filePath, title, description, tags = [],
    isMature = false, isAiGenerated = true, noai = false,
    galleryIds = null, allowComments = true, allowFreeDownload = true,
    publish = false,
  }) {
    if (!fs.existsSync(filePath)) {
      return { ok: false, stage: 'preflight', kind: 'permanent', error: `file missing: ${filePath}` };
    }
    const bytes = fs.statSync(filePath).size;
    if (bytes > MAX_UPLOAD_BYTES) {
      return {
        ok: false, stage: 'preflight', kind: 'permanent',
        error: `file is ${(bytes / 1048576).toFixed(1)} MB — over the ${MAX_UPLOAD_BYTES / 1048576} MB ceiling this app enforces`,
      };
    }

    let token;
    try {
      token = await this.csrf();
    } catch (e) {
      return { ok: false, stage: 'auth', kind: classifyDaError(e.message, 0), error: e.message };
    }

    let up = await this._uploadFile(filePath, token);
    if (up.retryWithFreshToken) {
      token = await this.csrf(true);
      up = await this._uploadFile(filePath, token);
    }
    if (!up.ok) {
      return { ok: false, stage: 'upload', kind: up.kind || classifyDaError(up.error, up.status), error: up.error };
    }

    const privateId = up.privateId;
    const deviationId = up.deviationId;

    let info = { galleries: [], stashUrl: null };
    try { info = await this.draftInfo(privateId, token); } catch { }

    let gids = (galleryIds && galleryIds.length) ? galleryIds.map(String) : null;
    if (!gids) {
      const featured = info.galleries.find((g) => g.special === 'featured') || info.galleries[0];
      gids = featured ? [featured.id] : [];
    }

    const meta = await this._writeMetadata({
      privateId, title, description, tags, isMature, isAiGenerated, noai,
      galleryIds: gids, allowComments, allowFreeDownload,
    }, token);

    if (!meta.ok) {
      return {
        ok: false,
        stage: 'metadata',
        kind: meta.kind,
        itemid: String(privateId),
        deviationId,
        stashUrl: info.stashUrl || `${ORIGIN}/stash`,
        error: meta.error + ' (image uploaded, metadata not applied)',
      };
    }

    const out = {
      ok: true,
      itemid: String(privateId),
      deviationId: meta.deviationId || deviationId,
      stashUrl: info.stashUrl || `${ORIGIN}/stash`,
      galleries: info.galleries,
      raw: meta.raw,
    };
    if (!publish) return out;

    const pub = await this.publishDeviation(out.deviationId);
    if (!pub.ok) {
      return { ...out, published: false, publishError: pub.error, publishKind: pub.kind };
    }
    return { ...out, published: true, url: pub.url || out.stashUrl };
  }

  /**
   * Publish a draft that is already in Sta.sh — the Submit press you would otherwise make by hand
   * on the deviation page.
   */
  async publishDeviation(deviationId, _isRetry = false) {
    if (!deviationId) return { ok: false, kind: 'permanent', error: 'no deviationId — this draft predates publish support' };

    let token;
    try {
      token = await this.csrf(_isRetry);
    } catch (e) {
      return { ok: false, kind: classifyDaError(e.message, 0), error: e.message };
    }

    let resp;
    try {
      resp = await this._fetch(`${ORIGIN}/_puppy/dashared/deviation/publish`, {
        method: 'POST',
        headers: this._headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          stashid: String(deviationId),
          da_minor_version: Number(DA_MINOR),
          csrf_token: token,
        }),
      }, 90000);
    } catch (e) {
      return { ok: false, kind: 'transient', error: `network error publishing: ${e.message}` };
    }

    if (resp.status === 403 && !_isRetry) {
      this._csrf = null;
      return this.publishDeviation(deviationId, true);
    }

    const text = await resp.text();
    let data = {};
    try { data = JSON.parse(text); } catch { }

    if (data.deviation && !data.errorCode && !data.error) {
      return { ok: true, deviationId, url: data.deviation.url || null, raw: data };
    }
    const quota = data.errorCode === 1;
    const error = quota
      ? `${daError(data, resp.status, text)} (DeviantArt submission quota)`
      : daError(data, resp.status, text);
    return { ok: false, kind: quota ? 'permanent' : classifyDaError(error, resp.status), error };
  }

  /** Re-run step 3 alone against a draft that is already in Sta.sh. */
  async applyMetadata(payload) {
    if (!payload || !payload.privateId) {
      return { ok: false, kind: 'permanent', error: 'no draft id — this card predates metadata retry' };
    }
    let token;
    try {
      token = await this.csrf(true);
    } catch (e) {
      return { ok: false, kind: classifyDaError(e.message, 0), error: e.message };
    }
    return this._writeMetadata(payload, token);
  }

  /** The `deviation/update` POST. */
  async _writeMetadata({
    privateId, title, description, tags = [],
    isMature = false, isAiGenerated = true, noai = false,
    galleryIds = [], allowComments = true, allowFreeDownload = true,
  }, token, _isRetry = false) {
    const payload = {
      deviationid: String(privateId),
      editorRaw: buildEditorRaw(description),
      title: String(title || '').trim().slice(0, 50) || 'Untitled',
      ...(isMature ? { is_mature: true } : {}),
      is_scrap: false,
      allow_comments: !!allowComments,
      allow_free_download: !!allowFreeDownload,
      add_watermark: false,
      display_resolution: 0,
      tags: (tags || []).slice(0, 30),
      tierids: '_empty',
      galleryids: (galleryIds || []).map(String),
      groups: '_empty',
      group_folders: '_empty',
      noai: !!noai,
      is_ai_generated: !!isAiGenerated,
      license_options: { creative_commons: false, commercial: false, modify: 'no' },
      location_tag: null,
      subject_tag_types: '_empty',
      subject_tags: '_empty',
      da_minor_version: Number(DA_MINOR),
      csrf_token: token,
    };

    let resp;
    try {
      resp = await this._fetch(`${ORIGIN}/_napi/shared_api/deviation/update`, {
        method: 'POST',
        headers: this._headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      }, 90000);
    } catch (e) {
      return { ok: false, kind: 'transient', error: `network error writing metadata: ${e.message}` };
    }

    if (resp.status === 403 && !_isRetry) {
      this._csrf = null;
      const fresh = await this.csrf(true).catch(() => null);
      if (fresh) {
        return this._writeMetadata({
          privateId, title, description, tags, isMature, isAiGenerated, noai,
          galleryIds, allowComments, allowFreeDownload,
        }, fresh, true);
      }
    }

    const text = await resp.text();
    let data = {};
    try { data = JSON.parse(text); } catch { }

    if (data.status !== 'success') {
      const error = daError(data, resp.status, text);
      return { ok: false, kind: classifyDaError(error, resp.status), error };
    }
    return { ok: true, deviationId: data.deviationId, raw: data };
  }

  async _uploadFile(filePath, token) {
    const buf = fs.readFileSync(filePath);
    const form = new FormData();
    form.set('upload_file', new Blob([buf], { type: mimeFor(filePath) }), path.basename(filePath));
    form.set('use_defaults', 'true');
    form.set('folder_name', DRAFT_FOLDER);
    form.set('da_minor_version', DA_MINOR);
    form.set('csrf_token', token);

    let resp;
    try {
      resp = await this._fetch(`${ORIGIN}/_puppy/dashared/deviation/submit/upload/deviation`, {
        method: 'POST',
        headers: this._headers(),
        body: form,
      }, 180000);
    } catch (e) {
      return { ok: false, kind: 'transient', error: `network error during upload: ${e.message}` };
    }

    if (resp.status === 403) return { ok: false, retryWithFreshToken: true, kind: 'transient', error: 'csrf rejected' };
    const text = await resp.text();
    let data = {};
    try { data = JSON.parse(text); } catch { }

    if (data.status === 'success' && data.privateId) {
      return { ok: true, privateId: data.privateId, deviationId: data.deviationId, raw: data };
    }
    if (/\/users\/login/.test(text)) {
      return { ok: false, kind: 'auth', error: 'DeviantArt signed you out — open the DeviantArt tab and sign in again.' };
    }
    const error = daError(data, resp.status, text);
    return { ok: false, status: resp.status, kind: classifyDaError(error, resp.status), error };
  }

  /** Delete a draft. */
  async deleteDraft(deviationId) {
    if (!deviationId) return { ok: false, error: 'no deviationId — this draft predates delete support' };
    const token = await this.csrf();
    const resp = await this._fetch(`${ORIGIN}/_puppy/dashared/deviation/delete`, {
      method: 'POST',
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ deviationid: String(deviationId), da_minor_version: Number(DA_MINOR), csrf_token: token }),
    }, 45000);
    const data = await resp.json().catch(() => ({}));
    return data.success ? { ok: true } : { ok: false, error: daError(data, resp.status) };
  }

  /** Drafts currently sitting in Sta.sh. */
  async listDrafts() {
    const token = await this.csrf();
    const qs = new URLSearchParams({
      init: 'false', deviations_offset: '0', root_foldername: DRAFT_FOLDER,
      da_minor_version: DA_MINOR, csrf_token: token,
    });
    const resp = await this._fetch(`${ORIGIN}/_puppy/v1/studio/pages/drafts?${qs}`, { headers: this._headers() }, 45000);
    const data = await resp.json().catch(() => ({}));
    const results = (data.deviations && data.deviations.studioResults) || [];
    const items = results.map((r) => {
      const d = r.deviation || r;
      return {
        deviationId: d.deviationId,
        itemid: String(d.stashPrivateid || ''),
        title: d.title,
        url: d.url || d.shortUrl,
        isMature: !!d.isMature,
        isAiGenerated: !!d.isAiGenerated,
        tags: (r.tags || []).map((t) => t.name || t),
      };
    });
    return { ok: true, items, total: (data.rootFolder && data.rootFolder.size) || items.length };
  }
}

/** DeviantArt's TipTap description format. */
function buildEditorRaw(text) {
  const attrs = { indentType: null, indentation: null, textAlign: 'left' };
  const content = String(text || '').split(/\r?\n/).map((line) => {
    const inline = linkify(line);
    return inline.length ? { type: 'paragraph', attrs, content: inline } : { type: 'paragraph', attrs };
  });
  if (!content.length) content.push({ type: 'paragraph', attrs });
  return JSON.stringify({ version: '1', document: { type: 'doc', content } });
}

function linkify(line) {
  const out = [];
  const re = /https?:\/\/[^\s]+/g;
  let last = 0, m;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push({ type: 'text', text: line.slice(last, m.index) });
    out.push({
      type: 'text',
      marks: [{ type: 'link', attrs: { href: m[0], target: '_blank', rel: 'noopener noreferrer nofollow ugc', class: null } }],
      text: m[0],
    });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ type: 'text', text: line.slice(last) });
  return out;
}

/**
 * `rawText` matters: when DeviantArt answers with an HTML error page `data` parses to `{}` and the
 * old message was the useless `HTTP 500: {}`.
 */
function daError(data, status, rawText) {
  if (data && typeof data === 'object') {
    if (data.errorDescription) return data.errorDescription;
    if (data.error_description) return data.error_description;
    if (data.errorDetails) return JSON.stringify(data.errorDetails).slice(0, 300);
    if (data.error) return String(data.error);
    if (Object.keys(data).length) return `HTTP ${status}: ${JSON.stringify(data).slice(0, 200)}`;
  }
  const body = String(rawText || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return body ? `HTTP ${status}: ${body.slice(0, 400)}` : `HTTP ${status}`;
}

/** Is this failure worth retrying, a sign we are signed out, or DeviantArt's final answer? */
function classifyDaError(message, status) {
  const m = String(message || '').toLowerCase();

  if (/signed you out|not logged in|not signed in|session token rejected|log ?in to deviantart/.test(m)) {
    return 'auth';
  }
  if (status === 401) return 'auth';

  if (status === 429 || (status >= 500 && status <= 599)) return 'transient';
  if (/csrf|network error|timed? ?out|timeout|aborted|econnreset|socket hang up|rate ?limit|too many requests|try again later|temporarily/.test(m)) {
    return 'transient';
  }
  if (/could not read the deviantart session token/.test(m)) return 'transient';

  return 'permanent';
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

module.exports = { DAWebClient, buildEditorRaw, classifyDaError, daError };
