/**
 * da.js: DeviantArt OAuth2 + Sta.sh draft client.
 *
 * The official-API route for uploading: uploads land as private DRAFTS in the
 * account's Sta.sh; this module never publishes anything. Requires a registered
 * DeviantArt application; daweb.js is the alternative when none is available.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DA_API = 'https://www.deviantart.com/api/v1/oauth2';
const DA_AUTH = 'https://www.deviantart.com/oauth2/authorize';
const DA_TOKEN = 'https://www.deviantart.com/oauth2/token';

class DAClient {
  constructor(store) {
    this.store = store;
  }

  get cfg() { return this.store.settings.data.da; }

  beginAuth() {
    this.codeVerifier = crypto.randomBytes(64).toString('base64url').slice(0, 128);
    const challenge = crypto.createHash('sha256').update(this.codeVerifier).digest('base64url');
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: 'code',
      scope: 'browse stash user.manage',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${DA_AUTH}?${params.toString()}`;
  }

  async exchangeCode(code) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      redirect_uri: this.cfg.redirectUri,
      code,
    });
    if (this.codeVerifier) body.set('code_verifier', this.codeVerifier);
    let data;
    try {
      const resp = await fetch(DA_TOKEN, { method: 'POST', body, signal: AbortSignal.timeout(45000) });
      data = await resp.json().catch(() => ({}));
    } catch (e) {
      return { ok: false, error: `token request failed: ${e.message}` };
    }
    if (data.access_token) {
      this._saveTokens(data);
      return { ok: true, data };
    }
    return { ok: false, error: data.error_description || data.error || JSON.stringify(data) };
  }

  async refresh() {
    if (!this.cfg.refreshToken) return false;
    const resp = await fetch(DA_TOKEN, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: this.cfg.refreshToken,
      }),
    });
    const data = await resp.json();
    if (data.access_token) { this._saveTokens(data); return true; }
    return false;
  }

  _saveTokens(data) {
    const s = this.store.settings.data;
    s.da.accessToken = data.access_token;
    s.da.refreshToken = data.refresh_token || s.da.refreshToken;
    s.da.scope = data.scope || s.da.scope;
    this.store.settings.save();
  }

  get isAuthenticated() { return !!this.cfg.accessToken; }

  async _authed(url, init = {}, retried = false) {
    const headers = { ...(init.headers || {}), Authorization: `Bearer ${this.cfg.accessToken}` };
    const resp = await fetch(url, { ...init, headers });
    if (resp.status === 401 && !retried && await this.refresh()) {
      return this._authed(url, init, true);
    }
    return resp;
  }

  async whoami() {
    if (!this.cfg.accessToken) return { error: 'not_authenticated', error_description: 'No access token — connect DeviantArt first.' };
    const resp = await this._authed(`${DA_API}/user/whoami`);
    return resp.json();
  }

  /** Upload an image to Sta.sh as a DRAFT. */
  async stashDraft({ filePath, title, description, tags = [], isAiGenerated = true, noai = false }) {
    if (!this.cfg.accessToken) {
      return { ok: false, error: 'Not authenticated. The API route needs a published DeviantArt application — switch to the Session upload method to upload now.' };
    }
    if (!fs.existsSync(filePath)) return { ok: false, error: `file missing: ${filePath}` };

    const buf = fs.readFileSync(filePath);
    const form = new FormData();
    form.set('title', title);
    form.set('artist_comments', description);
    form.set('is_ai_generated', String(!!isAiGenerated));
    form.set('noai', String(!!noai));
    tags.forEach((t, i) => form.set(`tags[${i}]`, t));
    form.set('file', new Blob([buf], { type: mimeFor(filePath) }), path.basename(filePath));

    let data;
    try {
      const resp = await this._authed(`${DA_API}/stash/submit`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(180000),
      });
      data = await resp.json().catch(() => ({}));
    } catch (e) {
      return { ok: false, error: `network error: ${e.message}` };
    }
    if (data.itemid) {
      return { ok: true, itemid: data.itemid, stashUrl: 'https://www.deviantart.com/stash', raw: data };
    }
    return { ok: false, error: data.error_description || data.error || JSON.stringify(data).slice(0, 400), raw: data };
  }
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

module.exports = { DAClient };
