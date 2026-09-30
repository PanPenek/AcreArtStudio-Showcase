/**
 * dastats.js: read how published artworks are doing (views, favourites,
 * comments) from the signed-in DeviantArt session.
 *
 * Feeds the learning loop in insights.js. Strictly read-only: nothing is posted,
 * edited or deleted. The endpoints are undocumented, so every reader tolerates
 * shape changes: unknown fields become null instead of throwing.
 */
const ORIGIN = 'https://www.deviantart.com';
const DA_MINOR = '20230710';
const PAGE_SIZE = 24;

class DAStatsClient {
  /** Shares the csrf token, cookies, and identity of the existing session uploader. */
  constructor(daweb) {
    this.daweb = daweb;
  }

  get ses() { return this.daweb.ses; }

  _headers(extra = {}) {
    return {
      'User-Agent': this.ses.getUserAgent(),
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-GB,en;q=0.9',
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
      'X-Requested-With': 'XMLHttpRequest',
      ...extra,
    };
  }

  /** The same request as `_json`, with the status code kept. */
  async _jsonRaw(url, timeoutMs = 45000) {
    const resp = await this.ses.fetch(url, {
      headers: this._headers(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.status === 403) {
      throw Object.assign(new Error('session token rejected'), { status: 403 });
    }
    const text = await resp.text();
    try { return { status: resp.status, data: JSON.parse(text) }; } catch {
      throw new Error(`DeviantArt answered with a non-JSON page (HTTP ${resp.status})`);
    }
  }

  async _json(url, timeoutMs = 45000) {
    return (await this._jsonRaw(url, timeoutMs)).data;
  }

  /** One deviation's own payload — media, extended stats, the lot. */
  async _deviation(deviationId, username, token, timeoutMs = 30000) {
    const qs = new URLSearchParams({
      deviationid: String(deviationId),
      username: username || '',
      type: 'art',
      include_session: 'false',
      da_minor_version: DA_MINOR,
      csrf_token: token,
    }).toString();
    const candidates = [
      `${ORIGIN}/_puppy/dadeviation/init?${qs}`,
      `${ORIGIN}/_napi/shared_api/deviation/extended_fetch?${qs}`,
    ];
    let lastErr = null;
    for (const url of candidates) {
      try {
        const { status, data } = await this._jsonRaw(url, timeoutMs);
        const dev = (data && data.deviation) || null;
        if (status === 200 && dev && (dev.deviationId || dev.media || dev.extended)) {
          return { deviation: dev, via: url.split('?')[0] };
        }
        const why = (data && (data.errorDescription || data.message)) || 'no deviation in the response';
        lastErr = new Error(`${url.split('?')[0].replace(ORIGIN, '')} → ${status}, ${String(why).slice(0, 80)}`);
      } catch (e) {
        lastErr = e;
        if (e.status === 403) throw e;
      }
    }
    throw lastErr || new Error('no deviation endpoint answered');
  }

  /** One page of the user's own gallery. */
  async _galleryPage(username, offset, token) {
    const qs = (extra = {}) => new URLSearchParams({
      username,
      offset: String(offset),
      limit: String(PAGE_SIZE),
      all_folder: 'true',
      da_minor_version: DA_MINOR,
      csrf_token: token,
      ...extra,
    }).toString();

    const candidates = [
      `${ORIGIN}/_puppy/dashared/gallection/contents?${qs({ type: 'gallery' })}`,
      `${ORIGIN}/_napi/da-user-profile/api/gallery/contents?${qs()}`,
    ];

    let lastErr = null;
    for (const url of candidates) {
      try {
        const data = await this._json(url);
        if (Array.isArray(data.results)) {
          return {
            items: data.results.map(normDeviation).filter((d) => d.deviationId),
            hasMore: !!data.hasMore,
            nextOffset: Number(data.nextOffset) || offset + PAGE_SIZE,
          };
        }
      } catch (e) {
        lastErr = e;
        if (e.status === 403) throw e;
      }
    }
    throw lastErr || new Error('gallery endpoint returned an unexpected shape');
  }

  /** Views for one deviation. */
  async views(deviationId, username, token) {
    try {
      const { deviation } = await this._deviation(deviationId, username, token);
      const st = (deviation.extended || {}).stats || {};
      return {
        views: num(st.views),
        favourites: num(st.favourites),
        comments: num(st.comments),
        downloads: num(st.downloads),
      };
    } catch {
      return null;
    }
  }

  /** View count for one artwork. */
  async comments(deviationId, opts = {}) {
    const { limit = 50 } = opts;
    let token;
    try { token = await this.daweb.csrf(); }
    catch (e) { return { ok: false, error: e.message, items: [] }; }

    const qs = new URLSearchParams({
      itemid: String(deviationId),
      typeid: '1',
      order: 'newest',
      limit: String(Math.min(Math.max(Number(limit) || 50, 1), 100)),
      maxdepth: '2',
      da_minor_version: DA_MINOR,
      csrf_token: token,
    }).toString();

    const candidates = [
      `${ORIGIN}/_puppy/dashared/comments/thread?${qs}`,
      `${ORIGIN}/_napi/shared_api/comments/thread?${qs}`,
    ];
    let lastErr = null;
    for (const url of candidates) {
      try {
        const data = await this._json(url, 30000);
        const raw = data.thread || data.comments || data.results || [];
        if (!Array.isArray(raw)) continue;
        if (opts && opts.debug) {
          return { ok: true, debug: { url, keys: Object.keys(data), sample: raw[0], hasMore: data.hasMore, total: data.total, count: raw.length } };
        }
        const items = raw.map(normComment).filter((c) => c.text);
        return {
          ok: true, items,
          topLevel: items.length,
          total: num(data.total) ?? items.length,
        };
      } catch (e) { lastErr = e; }
    }
    return { ok: false, error: (lastErr && lastErr.message) || 'no comment endpoint answered', items: [] };
  }

  /** Full sync. */
  async sync({ withViews = true, maxViewFetches = 400, maxDeviations = 0, onProgress = null } = {}) {
    const who = await this.daweb.status();
    if (!who.ok) return { ok: false, error: who.error || 'not signed in to DeviantArt', items: [] };
    const username = who.username;

    let token;
    try { token = await this.daweb.csrf(); }
    catch (e) { return { ok: false, error: e.message, items: [] }; }

    const cap = Math.max(0, Number(maxDeviations) || 0);
    const items = [];
    let offset = 0;
    for (let page = 0; page < 200; page++) {
      let res;
      try {
        res = await this._galleryPage(username, offset, token);
      } catch (e) {
        if (e.status === 403 && page === 0) {
          token = await this.daweb.csrf(true).catch(() => null);
          if (!token) return { ok: false, error: 'DeviantArt session expired — reload the DeviantArt tab.', items: [] };
          page--; continue;
        }
        if (!items.length) return { ok: false, error: e.message, items: [] };
        break;
      }
      items.push(...res.items);
      if (onProgress) onProgress({ phase: 'gallery', done: items.length, total: cap || null });
      if (cap && items.length >= cap) break;
      if (!res.hasMore || !res.items.length) break;
      offset = res.nextOffset;
      await sleep(350);
    }

    items.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
    const kept = cap ? items.slice(0, cap) : items;

    let viewsFetched = 0;
    if (withViews && kept.length) {
      const ordered = kept;
      const budget = Math.min(ordered.length, maxViewFetches);
      for (let i = 0; i < budget; i++) {
        const d = ordered[i];
        const s = await this.views(d.deviationId, username, token);
        if (s) {
          if (s.views != null) d.stats.views = s.views;
          if (s.favourites != null) d.stats.favourites = s.favourites;
          if (s.comments != null) d.stats.comments = s.comments;
          if (s.downloads != null) d.stats.downloads = s.downloads;
          viewsFetched++;
        }
        if (onProgress) onProgress({ phase: 'views', done: i + 1, total: budget });
        await sleep(250);
      }
    }

    return {
      ok: true, username, items: kept, viewsFetched, syncedAt: Date.now(),
      seen: items.length, partial: !!(cap && items.length > kept.length),
    };
  }

  /** The picture behind a published deviation, as bytes. */
  async image(deviationId, username, { preferFull = false } = {}) {
    let token;
    try { token = await this.daweb.csrf(); } catch (e) { return { ok: false, error: e.message }; }
    let user = String(username || '').trim();
    if (!user) {
      const who = await this.daweb.status().catch(() => null);
      user = (who && who.ok && who.username) || '';
    }
    if (!user) return { ok: false, error: 'no DeviantArt username to ask under — is the tab signed in?' };
    let url = null;
    try {
      const { deviation } = await this._deviation(deviationId, user, token);
      const media = deviation.media || {};
      const types = media.types || [];
      const order = preferFull
        ? ['fullview', 'preview', 'thumb']
        : ['preview', 'fullview', 'thumb'];
      let pick = null;
      for (const want of order) {
        pick = types.find((x) => x.t === want);
        if (pick) break;
      }
      pick = pick || types[types.length - 1];
      if (media.baseUri) {
        const token0 = (media.token && media.token[0]) ? `?token=${media.token[0]}` : '';
        const variant = pick && pick.c ? String(pick.c).replace('<prettyName>', media.prettyName || '') : '';
        url = variant
          ? `${String(media.baseUri).replace(/\/+$/, '')}/${variant.replace(/^\/+/, '')}${token0}`
          : `${media.baseUri}${token0}`;
      }
    } catch (e) {
      return { ok: false, error: `could not read the deviation (${e.message})` };
    }
    if (!url) return { ok: false, error: 'DeviantArt returned the deviation but no image in it' };
    try {
      const resp = await this.ses.fetch(url, {
        headers: { 'User-Agent': this.ses.getUserAgent(), Referer: `${ORIGIN}/`, Accept: 'image/*,*/*' },
        signal: AbortSignal.timeout(60000),
      });
      if (!resp.ok) return { ok: false, error: `image fetch ${resp.status}` };
      const mime = resp.headers.get('content-type') || 'image/jpeg';
      if (!/^image\//.test(mime)) return { ok: false, error: `DeviantArt served ${mime}, not an image — is the session signed in?` };
      const buf = Buffer.from(await resp.arrayBuffer());
      return { ok: true, base64: buf.toString('base64'), mime, bytes: buf.length, url };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

/** DeviantArt hands back several shapes for a deviation; flatten them all to one. */
function normDeviation(row) {
  const d = (row && row.deviation) || row || {};
  const stats = d.stats || {};
  const tags = []
    .concat(row && row.tags ? row.tags : [])
    .concat(d.tags || [])
    .map((t) => String((t && t.name) || t || '').trim().toLowerCase())
    .filter(Boolean);
  return {
    deviationId: String(d.deviationId ?? d.deviationid ?? ''),
    title: String(d.title || ''),
    url: d.url || d.shortUrl || '',
    publishedAt: toMs(d.publishedTime ?? d.publishedDate ?? d.ts),
    thumb: pickThumb(d.media),
    isMature: !!d.isMature,
    isAiGenerated: !!d.isAiGenerated,
    isDeleted: !!d.isDeleted,
    tags: [...new Set(tags)],
    stats: {
      views: num(stats.views),
      favourites: num(stats.favourites) ?? 0,
      comments: num(stats.comments) ?? 0,
      downloads: num(stats.downloads),
    },
  };
}

/** Flatten one comment down to plain text — the only form a prompt or a list has a use for. */
function normComment(row) {
  const c = (row && row.comment) || row || {};
  return {
    commentId: String(c.commentId ?? c.commentid ?? c.id ?? ''),
    author: String((c.user && (c.user.username || c.user.userName)) || c.username || 'someone'),
    avatar: (c.user && (c.user.usericon || c.user.userIcon)) || null,
    at: toMs(c.posted ?? c.postedDate ?? c.ts),
    likes: num(c.likes) || 0,
    replyTo: String(c.parentId ?? c.parentid ?? '') || null,
    replyCount: num(c.replies) || 0,
    flags: { isOwner: !!c.isOwner, isAuthor: !!c.isAuthor, isHidden: !!c.isHidden },
    text: bodyToText(c.textContent || c.body || c),
  };
}

/** The comment body, in whichever of three shapes DeviantArt sent it. */
function bodyToText(body) {
  if (!body) return '';
  if (typeof body === 'string') return richToText(body);
  const excerpt = String(body.excerpt || '').trim();
  if (excerpt) return excerpt;
  const html = body.html;
  if (html && typeof html === 'object') return richToText(html.markup || html.html || '');
  return richToText(html || body.text || body.richContent || '');
}

/** ProseMirror JSON if it parses as such, HTML otherwise. */
function richToText(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('{')) {
    try {
      const doc = JSON.parse(raw);
      const node = doc.document || doc;
      const out = walkRich(node).replace(/\n{3,}/g, '\n\n').trim();
      if (out) return out;
    } catch { }
  }
  return htmlToText(raw);
}

/** Depth-first walk of a ProseMirror document, collecting text and paragraph breaks. */
function walkRich(node) {
  if (!node || typeof node !== 'object') return '';
  if (Array.isArray(node)) return node.map(walkRich).join('');
  if (node.type === 'text') return String(node.text || '');
  if (node.type === 'hard_break' || node.type === 'hardBreak') return '\n';
  const inner = node.content ? walkRich(node.content) : '';
  return /^(paragraph|heading|blockquote|list_item|listItem)$/.test(node.type || '') ? inner + '\n' : inner;
}

/** Comment bodies that arrive as markup. */
function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A small preview URL, if the media block carries one. */
function pickThumb(media) {
  try {
    if (!media || !media.baseUri) return null;
    const types = media.types || [];
    const t = types.find((x) => x.t === 'preview') || types.find((x) => x.t === 'thumb') || types[0];
    if (!t) return media.baseUri;
    const token = (media.token && media.token[0]) ? `?token=${media.token[0]}` : '';
    const variant = t.c ? String(t.c).replace('<prettyName>', media.prettyName || '') : '';
    return variant
      ? `${String(media.baseUri).replace(/\/+$/, '')}/${variant.replace(/^\/+/, '')}${token}`
      : `${media.baseUri}${token}`;
  } catch { return null; }
}

function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) { const n = Number(s); return n < 1e12 ? n * 1000 : n; }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { DAStatsClient, normDeviation, normComment, bodyToText, richToText, htmlToText, toMs, num };
