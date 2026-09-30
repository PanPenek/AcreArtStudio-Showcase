/**
 * research.js: read-only web research for the Overseer assistant.
 *
 * When the artist asks for "a picture of <character>" the assistant can look the
 * subject up first. Keyless sources only: DuckDuckGo Lite for web results, AniList
 * for character records, Openverse for openly licensed concept images, and
 * MediaWiki's API for Fandom/Wikipedia pages. Nothing fetched is ever executed;
 * downloads are size- and type-capped and private network addresses are refused.
 * The UI receives short snippets, source URLs and image candidates.
 */
'use strict';

const dns = require('dns').promises;
const net = require('net');

const USER_AGENT = 'AiLaborAutomation/1.0 (local desktop research; +https://github.com/)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36 AiLaborAutomation/1.0';
const HTML_LIMIT = 2 * 1024 * 1024;
const JSON_LIMIT = 2 * 1024 * 1024;
const IMAGE_LIMIT = 12 * 1024 * 1024;
const PREVIEW_LIMIT = 1024 * 1024;

const clamp = (v, lo, hi, fallback = lo) => {
  const n = Math.round(Number(v));
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : fallback));
};

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&(amp|quot|apos|lt|gt|nbsp|#39);/gi, (m, n) => ({
      amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', '#39': "'",
    }[String(n).toLowerCase()] || m));
}

function stripMarkup(value, max = 600) {
  return decodeHtml(String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function attr(tag, name) {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(String(tag || ''));
  return m ? decodeHtml(m[1] ?? m[2] ?? m[3] ?? '') : '';
}

function duckTarget(raw) {
  let href = decodeHtml(raw);
  if (href.startsWith('//')) href = `https:${href}`;
  try {
    const u = new URL(href, 'https://lite.duckduckgo.com/');
    const target = u.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : u.href;
  } catch {
    return '';
  }
}

function parseDuckLite(html, limit = 8) {
  const anchors = [...String(html || '').matchAll(/<a\b([^>]*\bclass\s*=\s*['"]result-link['"][^>]*)>([\s\S]*?)<\/a>/gi)];
  const out = [];
  for (let i = 0; i < anchors.length && out.length < limit; i++) {
    const m = anchors[i];
    const href = duckTarget(attr(m[1], 'href'));
    if (!href || !isSafeRemoteUrl(href)) continue;
    const segment = String(html).slice(m.index + m[0].length, anchors[i + 1]?.index ?? String(html).length);
    const snippet = (/<td\b[^>]*\bclass\s*=\s*['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i.exec(segment) || [])[1] || '';
    const title = stripMarkup(m[2], 220);
    if (!title) continue;
    out.push({ title, url: href, snippet: stripMarkup(snippet, 520), provider: 'DuckDuckGo' });
  }
  return out;
}

function parseOpenverse(data, limit = 8) {
  const rows = Array.isArray(data?.results) ? data.results : [];
  return rows.slice(0, limit * 2).map((r) => ({
    title: stripMarkup(r.title || 'Openverse image', 180),
    imageUrl: isSafeRemoteUrl(r.url) ? String(r.url) : '',
    thumbnailUrl: isSafeRemoteUrl(r.thumbnail) ? String(r.thumbnail) : '',
    sourceUrl: isSafeRemoteUrl(r.foreign_landing_url || r.detail_url) ? String(r.foreign_landing_url || r.detail_url) : '',
    provider: `Openverse${r.source ? ` · ${r.source}` : ''}`,
    creator: stripMarkup(r.creator || '', 120),
    license: [r.license, r.license_version].filter(Boolean).join(' ').trim(),
    width: Number(r.width) || null,
    height: Number(r.height) || null,
  })).filter(validImageCandidate).slice(0, limit);
}

function parseCommons(data, limit = 8) {
  const pages = Object.values(data?.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  return pages.map((p) => {
    const info = p.imageinfo?.[0] || {};
    const meta = info.extmetadata || {};
    return {
      title: stripMarkup(meta.ObjectName?.value || p.title || 'Wikimedia Commons image', 180),
      imageUrl: isSafeRemoteUrl(info.url) ? String(info.url) : '',
      thumbnailUrl: isSafeRemoteUrl(info.thumburl || info.url) ? String(info.thumburl || info.url) : '',
      sourceUrl: isSafeRemoteUrl(info.descriptionurl) ? String(info.descriptionurl) : '',
      provider: 'Wikimedia Commons',
      creator: stripMarkup(meta.Artist?.value || '', 120),
      license: stripMarkup(meta.LicenseShortName?.value || meta.UsageTerms?.value || '', 100),
      width: Number(info.width) || null,
      height: Number(info.height) || null,
    };
  }).filter(validImageCandidate).slice(0, limit);
}

function cleanMarkdown(value, max = 900) {
  return stripMarkup(String(value || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[_*~`>#]+/g, ' '), max);
}

function isPrivateIp(ip) {
  const s = String(ip || '').toLowerCase().split('%')[0];
  if (!s) return true;
  if (net.isIPv4(s)) {
    const p = s.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127
      || (p[0] === 169 && p[1] === 254)
      || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
      || (p[0] === 192 && p[1] === 168)
      || p[0] >= 224;
  }
  if (net.isIPv6(s)) {
    if (s === '::' || s === '::1') return true;
    if (/^(fc|fd)/.test(s) || /^fe[89ab]/.test(s)) return true;
    if (s.startsWith('::ffff:')) return isPrivateIp(s.slice(7));
  }
  return false;
}

function isSafeRemoteUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return false;
    let host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (!host || host === 'localhost' || host.endsWith('.localhost')
      || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (net.isIP(host) && isPrivateIp(host)) return false;
    return true;
  } catch {
    return false;
  }
}

async function assertPublicDns(raw, deps = {}) {
  if (!isSafeRemoteUrl(raw)) throw new Error('refused a local or invalid web address');
  let host = new URL(raw).hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (net.isIP(host)) return;
  const lookup = deps.lookup || dns.lookup.bind(dns);
  const rows = await lookup(host, { all: true, verbatim: true });
  if (!rows?.length || rows.some((r) => isPrivateIp(r.address))) {
    throw new Error('refused a web address that resolves to a private network');
  }
}

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`response is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { }
        throw new Error(`response is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`response is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  return buf;
}

async function requestKnown(url, { method = 'GET', headers = {}, body = null, timeoutMs = 20_000, maxBytes = JSON_LIMIT } = {}, deps = {}) {
  const fetchImpl = deps.fetch || global.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method, headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...headers }, body,
      redirect: 'follow', signal: controller.signal,
    });
    if (!response.ok) throw new Error(`request failed (${response.status})`);
    return { response, bytes: await readLimited(response, maxBytes), url: response.url || url };
  } finally {
    clearTimeout(timer);
  }
}

async function requestRemote(raw, { headers = {}, timeoutMs = 25_000, maxBytes = HTML_LIMIT } = {}, deps = {}) {
  const fetchImpl = deps.fetch || global.fetch;
  let current = String(raw || '');
  for (let hop = 0; hop < 5; hop++) {
    if (!deps.skipDns) await assertPublicDns(current, deps);
    else if (!isSafeRemoteUrl(current)) throw new Error('refused a local or invalid web address');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(current, {
        method: 'GET', headers: { 'User-Agent': BROWSER_UA, Accept: '*/*', ...headers },
        redirect: 'manual', signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.('location');
        if (!location) throw new Error(`redirect ${response.status} had no destination`);
        current = new URL(location, current).href;
        continue;
      }
      if (!response.ok) throw new Error(`fetch failed (${response.status})`);
      return { response, bytes: await readLimited(response, maxBytes), url: response.url || current };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('too many redirects');
}

async function searchDuck(query, limit, deps) {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const { bytes } = await requestKnown(url, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' },
    maxBytes: HTML_LIMIT,
  }, deps);
  return parseDuckLite(bytes.toString('utf8'), limit);
}

async function searchWikipedia(query, limit, deps) {
  const p = new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: query, gsrlimit: String(limit),
    prop: 'extracts|pageimages', exintro: '1', explaintext: '1', exsentences: '3',
    piprop: 'thumbnail|original', pithumbsize: '1200', format: 'json', origin: '*',
  });
  const { bytes } = await requestKnown(`https://en.wikipedia.org/w/api.php?${p}`, {}, deps);
  const data = JSON.parse(bytes.toString('utf8'));
  return Object.values(data?.query?.pages || {})
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .slice(0, limit)
    .map((page) => ({
      title: stripMarkup(page.title, 220),
      url: `https://en.wikipedia.org/?curid=${page.pageid}`,
      snippet: stripMarkup(page.extract || '', 520),
      provider: 'Wikipedia',
      image: page.original?.source || page.thumbnail?.source || '',
    }));
}

function characterTerms(query) {
  const q = String(query || '').trim();
  return [...new Set([
    q,
    q.split(/\s+from\s+/i)[0].trim(),
    q.replace(/\s*\([^)]*\)\s*$/, '').trim(),
  ].filter(Boolean))];
}

function normalizedWords(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
}

async function searchAniList(query, deps) {
  const gql = `query ($search: String) {
    Character(search: $search) {
      id name { full native alternative }
      image { large medium }
      description
      media(perPage: 4) { nodes { title { romaji english native } } }
    }
  }`;
  for (const term of characterTerms(query)) {
    try {
      const { bytes } = await requestKnown('https://graphql.anilist.co', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: gql, variables: { search: term } }), maxBytes: 512 * 1024,
      }, deps);
      const c = JSON.parse(bytes.toString('utf8'))?.data?.Character;
      if (!c?.id || !c?.name?.full) continue;
      const aliases = [c.name.full, c.name.native, ...(c.name.alternative || [])].filter(Boolean);
      const hay = normalizedWords(query);
      if (!aliases.some((name) => {
        const n = normalizedWords(name);
        return n && (hay.includes(n) || n.includes(hay));
      })) continue;
      const media = (c.media?.nodes || []).map((m) => m.title?.english || m.title?.romaji || m.title?.native).filter(Boolean);
      const sourceUrl = `https://anilist.co/character/${c.id}`;
      return {
        source: {
          title: `${c.name.full}${media[0] ? ` — ${media[0]}` : ''}`,
          url: sourceUrl,
          snippet: cleanMarkdown(c.description || '', 700),
          provider: 'AniList',
        },
        image: {
          title: `${c.name.full} character portrait`, imageUrl: c.image?.large || c.image?.medium || '',
          thumbnailUrl: c.image?.medium || c.image?.large || '', sourceUrl,
          provider: 'AniList', creator: '', license: '', width: null, height: null,
        },
      };
    } catch { }
  }
  return null;
}

async function searchOpenverse(query, limit, deps) {
  const p = new URLSearchParams({ q: query, page_size: String(Math.min(20, limit * 2)), mature: 'false' });
  const { bytes } = await requestKnown(`https://api.openverse.org/v1/images/?${p}`, {}, deps);
  return parseOpenverse(JSON.parse(bytes.toString('utf8')), limit);
}

async function searchCommons(query, limit, deps) {
  const p = new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: query, gsrnamespace: '6', gsrlimit: String(limit),
    prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: '1400', format: 'json', origin: '*',
  });
  const { bytes } = await requestKnown(`https://commons.wikimedia.org/w/api.php?${p}`, {}, deps);
  return parseCommons(JSON.parse(bytes.toString('utf8')), limit);
}

function validImageCandidate(row) {
  return !!row && (isSafeRemoteUrl(row.imageUrl) || isSafeRemoteUrl(row.thumbnailUrl));
}

async function mediaWikiImage(source, deps) {
  let u;
  try { u = new URL(source.url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (!(host.endsWith('.fandom.com') || host.endsWith('.wikipedia.org'))) return null;
  const m = /^\/wiki\/(.+)$/i.exec(u.pathname);
  if (!m) return null;
  const title = decodeURIComponent(m[1]).replace(/_/g, ' ');
  const apiPath = host.endsWith('.fandom.com') ? '/api.php' : '/w/api.php';
  const p = new URLSearchParams({
    action: 'query', prop: 'pageimages', piprop: 'thumbnail|original', pithumbsize: '1400',
    titles: title, format: 'json', origin: '*',
  });
  const { bytes } = await requestKnown(`${u.origin}${apiPath}?${p}`, {}, deps);
  const page = Object.values(JSON.parse(bytes.toString('utf8'))?.query?.pages || {})[0];
  const image = page?.original?.source || page?.thumbnail?.source || '';
  if (!isSafeRemoteUrl(image)) return null;
  return {
    title: `${source.title} reference`, imageUrl: image,
    thumbnailUrl: page?.thumbnail?.source || image, sourceUrl: source.url,
    provider: host.endsWith('.fandom.com') ? 'Fandom MediaWiki' : 'Wikipedia',
    creator: '', license: '', width: null, height: null,
  };
}

function metaMap(html) {
  const out = {};
  for (const m of String(html || '').matchAll(/<meta\b([^>]*)>/gi)) {
    const key = (attr(m[1], 'property') || attr(m[1], 'name')).toLowerCase();
    const value = attr(m[1], 'content');
    if (key && value && out[key] === undefined) out[key] = value;
  }
  return out;
}

async function pageMetaImage(source, deps) {
  const { bytes, url } = await requestRemote(source.url, {
    headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Language': 'en-US,en;q=0.9' },
    maxBytes: HTML_LIMIT,
  }, deps);
  const html = bytes.toString('utf8');
  const meta = metaMap(html);
  const raw = meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'];
  if (!raw) return null;
  const image = new URL(raw, url).href;
  if (!isSafeRemoteUrl(image)) return null;
  return {
    title: stripMarkup(meta['og:title'] || source.title, 180),
    imageUrl: image, thumbnailUrl: image, sourceUrl: source.url,
    provider: 'Page preview', creator: '', license: '', width: null, height: null,
  };
}

async function discoverPageImage(source, deps) {
  try {
    const wiki = await mediaWikiImage(source, deps);
    if (wiki) return wiki;
  } catch { }
  try { return await pageMetaImage(source, deps); }
  catch { return null; }
}

function canonicalUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
    return u.href.replace(/\/revision\/latest.*$/i, '').replace(/[?#].*$/, '').toLowerCase();
  } catch { return String(raw || '').toLowerCase(); }
}

function dedupeSources(rows) {
  const seen = new Set();
  return rows.filter((r) => {
    if (!r?.url || !isSafeRemoteUrl(r.url)) return false;
    const key = canonicalUrl(r.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function imageRelevance(row, query, kind, index) {
  const words = [...new Set(normalizedWords(query).split(' ').filter((w) => w.length > 3))];
  const title = normalizedWords(`${row.title || ''} ${row.sourceUrl || ''}`);
  let score = words.reduce((n, w) => n + (title.includes(w) ? 10 : 0), 0);
  if (/\b(wholesale|buy|shop|shopping|coupon|vacuum cleaner|product listing)\b/.test(title)
      || /\b(alibaba|aliexpress|amazon|ebay|temu)\./.test(title)) score -= 80;
  if (kind === 'character' && row.provider === 'AniList') score += 100;
  if (kind === 'character' && /Fandom|Wikipedia/i.test(row.provider || '')) score += 45;
  if (kind === 'concept' && /Openverse|Wikimedia/i.test(row.provider || '') && row.license) score += 2;
  return score - index / 1000;
}

function dedupeImages(rows) {
  const seen = new Set();
  return rows.filter((r) => {
    if (!validImageCandidate(r)) return false;
    const key = canonicalUrl(r.imageUrl || r.thumbnailUrl);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function search(payload = {}, deps = {}) {
  const query = String(payload.query || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!query) return { ok: false, error: 'web research needs a query', sources: [], images: [] };
  const kind = payload.kind === 'character' ? 'character' : 'concept';
  const webLimit = clamp(payload.webLimit, 3, 10, 6);
  const imageLimit = clamp(payload.imageLimit, 1, 10, 6);
  const searchQuery = kind === 'character'
    ? `${query} character appearance outfit reference`
    : `${query} visual reference design motifs`;
  const warnings = [];

  const webTask = searchDuck(searchQuery, webLimit, deps).catch((e) => {
    warnings.push(`DuckDuckGo: ${e.message}`); return [];
  });
  const specialistTask = kind === 'character'
    ? searchAniList(query, deps).catch((e) => { warnings.push(`AniList: ${e.message}`); return null; })
    : searchOpenverse(query, imageLimit, deps).catch((e) => { warnings.push(`Openverse: ${e.message}`); return []; });

  let [sources, specialist] = await Promise.all([webTask, specialistTask]);
  if (sources.length < 3) {
    const wiki = await searchWikipedia(query, webLimit, deps).catch((e) => {
      warnings.push(`Wikipedia: ${e.message}`); return [];
    });
    sources = dedupeSources([...sources, ...wiki]).slice(0, webLimit);
  }

  const images = [];
  if (kind === 'character' && specialist) {
    sources = dedupeSources([specialist.source, ...sources]).slice(0, webLimit);
    if (validImageCandidate(specialist.image)) images.push(specialist.image);
  } else if (kind === 'concept' && Array.isArray(specialist)) {
    images.push(...specialist);
  }

  for (const source of sources) {
    if (!isSafeRemoteUrl(source.image)) continue;
    images.push({
      title: `${source.title} reference`, imageUrl: source.image, thumbnailUrl: source.image,
      sourceUrl: source.url, provider: source.provider || 'Wikipedia', creator: '', license: '',
      width: null, height: null,
    });
  }
  const pageRefs = await Promise.all(sources.slice(0, 5).map((s) => discoverPageImage(s, deps)));
  images.push(...pageRefs.filter(Boolean));

  if (images.length < imageLimit) {
    const commons = await searchCommons(query, imageLimit, deps).catch((e) => {
      warnings.push(`Wikimedia Commons: ${e.message}`); return [];
    });
    images.push(...commons);
  }

  const finalSources = dedupeSources(sources).slice(0, webLimit)
    .map((r, i) => ({ id: `s${i + 1}`, title: r.title, url: r.url, snippet: r.snippet || '', provider: r.provider || 'Web' }));
  const rankedImages = dedupeImages(images)
    .map((row, index) => ({ row, score: imageRelevance(row, query, kind, index) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, imageLimit)
    .map(({ row }) => row);
  const finalImages = rankedImages
    .map((r, i) => {
      const imageUrl = isSafeRemoteUrl(r.imageUrl) ? r.imageUrl : '';
      const thumbnailUrl = isSafeRemoteUrl(r.thumbnailUrl) ? r.thumbnailUrl : '';
      return {
        id: `i${i + 1}`, title: r.title || `reference ${i + 1}`,
        imageUrl: imageUrl || thumbnailUrl, thumbnailUrl: thumbnailUrl || imageUrl,
        sourceUrl: isSafeRemoteUrl(r.sourceUrl) ? r.sourceUrl : '', provider: r.provider || 'Web',
        creator: r.creator || '', license: r.license || '', width: r.width || null, height: r.height || null,
      };
    });

  if (!finalSources.length && !finalImages.length) {
    return { ok: false, error: warnings[0] || 'no web results or reference images were found', query, kind, sources: [], images: [], warnings };
  }
  return { ok: true, query, kind, sources: finalSources, images: finalImages, warnings };
}

function sniffMime(bytes, declared = '') {
  void declared;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp';
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp'
      && /avif|avis/.test(bytes.subarray(8, 32).toString('ascii'))) return 'image/avif';
  return '';
}

async function fetchImageBounded(payload = {}, deps = {}, { maxBytes = IMAGE_LIMIT, thumbnailFirst = false } = {}) {
  const urls = thumbnailFirst
    ? [payload.thumbnailUrl, payload.imageUrl || payload.url]
    : [payload.imageUrl || payload.url, payload.thumbnailUrl];
  const choices = [...new Set(urls.filter(Boolean).map(String))];
  if (!choices.length) return { ok: false, error: 'no image URL was supplied' };
  const errors = [];
  for (const url of choices) {
    try {
      const headers = { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.4' };
      if (isSafeRemoteUrl(payload.sourceUrl)) headers.Referer = payload.sourceUrl;
      const { response, bytes, url: finalUrl } = await requestRemote(url, {
        headers, timeoutMs: 35_000, maxBytes,
      }, deps);
      const mime = sniffMime(bytes, response.headers?.get?.('content-type'));
      if (!mime) throw new Error('the URL did not return a supported image');
      return { ok: true, base64: bytes.toString('base64'), mime, bytes: bytes.length, url: finalUrl };
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
  }
  return { ok: false, error: errors.join(' | ').slice(0, 1000) || 'the reference image could not be downloaded' };
}

async function fetchImage(payload = {}, deps = {}) {
  return fetchImageBounded(payload, deps, { maxBytes: IMAGE_LIMIT, thumbnailFirst: false });
}

async function fetchPreview(payload = {}, deps = {}) {
  return fetchImageBounded(payload, deps, { maxBytes: PREVIEW_LIMIT, thumbnailFirst: true });
}

module.exports = {
  search,
  fetchImage,
  fetchPreview,
  parseDuckLite,
  parseOpenverse,
  parseCommons,
  metaMap,
  isPrivateIp,
  isSafeRemoteUrl,
  sniffMime,
  _internals: { stripMarkup, duckTarget, searchAniList, mediaWikiImage, pageMetaImage, requestRemote, imageRelevance },
};
