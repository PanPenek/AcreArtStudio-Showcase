/**
 * channel.js: daily channel counters (Statistics → Channel growth).
 *
 * Reads the public DeviantArt profile page of the artist and of any reference accounts he
 * lists (watchers, profile views, deviations, watching), with no login, and keeps one entry
 * per account per day in <userData>/channel.json, written atomically.
 */
const fs = require('fs');
const path = require('path');

const VERSION = 1;
const MAX_DAYS = 2000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const FIELDS = ['watchers', 'pageviews', 'deviations', 'watching'];

/** The counters embedded in a profile page's JSON, or null when the page has none. */
function parseProfile(html) {
  const text = String(html || '');
  const out = {};
  for (const k of FIELDS) {
    const m = text.match(new RegExp(`\\\\?"${k}\\\\?"\\s*:\\s*(\\d+)`));
    out[k] = m ? Number(m[1]) : null;
  }
  return out.watchers == null ? null : out;
}

function cleanUser(u) {
  return String(u || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
}

function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function emptyData() { return { version: VERSION, accounts: {} }; }

function readFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && raw.accounts && typeof raw.accounts === 'object') return raw;
  } catch {  }
  return emptyData();
}

/** Put one day's counters for an account into the history (one entry per day, oldest first). */
function merge(data, user, snap) {
  const u = cleanUser(user);
  if (!u || !snap) return data;
  const list = Array.isArray(data.accounts[u]) ? data.accounts[u].filter((e) => e && e.day) : [];
  const entry = { day: snap.day || dayKey(snap.at || Date.now()), at: snap.at || Date.now() };
  for (const k of FIELDS) entry[k] = snap[k] == null ? null : Number(snap[k]);
  if (snap.source) entry.source = String(snap.source).slice(0, 12);
  const i = list.findIndex((e) => e.day === entry.day);
  if (i >= 0) list[i] = entry; else list.push(entry);
  list.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  data.accounts[u] = list.slice(-MAX_DAYS);
  data.version = VERSION;
  return data;
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

class ChannelTracker {
  constructor(userDataDir, { fetchImpl = null } = {}) {
    this.file = path.join(userDataDir, 'channel.json');
    this.fetch = fetchImpl || ((...a) => fetch(...a));
  }

  history() { return readFile(this.file); }

  async read(user) {
    const u = cleanUser(user);
    if (!u) throw new Error('no DeviantArt username');
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await this.fetch(`https://www.deviantart.com/${u}`, {
          headers: { 'User-Agent': UA, Accept: 'text/html' },
          signal: AbortSignal.timeout(25000),
        });
        if (res.ok || res.status === 404 || attempt >= 1) break;
      } catch (e) {
        if (attempt >= 1) throw e;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!res.ok) throw new Error(`deviantart.com/${u} answered ${res.status}`);
    const stats = parseProfile(await res.text());
    if (!stats) throw new Error(`no profile counters on deviantart.com/${u} (page layout changed?)`);
    return stats;
  }

  /** Read every account now and save what could be read; errors are reported per account. */
  async snapshot(users, { source = 'app' } = {}) {
    const list = [...new Set((users || []).map(cleanUser).filter(Boolean))].slice(0, 12);
    const at = Date.now();
    const got = {};
    const errors = {};
    for (const u of list) {
      try { got[u] = await this.read(u); } catch (e) { errors[u] = e.message; }
    }
    if (Object.keys(got).length) {
      const data = readFile(this.file);
      for (const [u, s] of Object.entries(got)) merge(data, u, { ...s, at, day: dayKey(at), source });
      writeAtomic(this.file, data);
    }
    return { ok: Object.keys(got).length > 0, at, day: dayKey(at), read: got, errors };
  }
}

module.exports = { ChannelTracker, parseProfile, merge, dayKey, cleanUser, readFile, VERSION };
