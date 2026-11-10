/**
 * growth.js: channel growth helpers (renderer, no UI; growthui.js draws the panel).
 *
 *   tags:      the tag list for a post, from his own tags, the post's own tags, format tags
 *              and tags learned from his best-viewed posts;
 *   uploads:   what a DeviantArt upload sends (still / GIF / MP4, folders, AI label);
 *   reports:   watchers per day and the goal pace (channel.json), and which kind of post
 *              (single picture, comic page, GIF, MP4) gets the most views 24 h after posting.
 */
(function () {
  // Format tags added when the post is of that kind, plus a few cues read from the text.
  const TAG_BANK = {
    sequence: ['comic', 'comicpage', 'webcomic'],
    story: ['story'],
    motion: ['animation', 'gif', 'animatedgif'],
    cues: [
      [/\b(magic|spell|curse|cursed|witch|potion|wizard|enchant)/i, ['magic', 'fantasy']],
      [/\b(dragon|castle|knight|kingdom|elf|elves)\b/i, ['fantasy']],
      [/\b(robot|spaceship|space station|cyberpunk|android)\b/i, ['scifi']],
    ],
  };
  const MAX_TAGS = 30;

  const DEFAULTS = {
    username: '',
    references: [],
    houseTags: [],
    goalWatchers: 15000,
    tagTarget: 25,
    minutesPerComic: 20,
    minutesPerSingle: 4,
    partGapHours: 20,
  };

  function settings() { return (window.State && State.settings) || {}; }
  /** A page behind DeviantArt's paywall: a Premium Gallery page or a Subscription-tier page. */
  const isPaid = (c) => !!(c && (c.premium || c.subscription));
  function cfg() { return { ...DEFAULTS, ...(settings().growth || {}) }; }
  function username() {
    const g = cfg();
    const perf = (window.Insights && Insights.perf) || {};
    return String(g.username || (settings().da || {}).username || perf.username || '').trim().toLowerCase();
  }

  function cleanTag(t) {
    return String(t || '').toLowerCase().replace(/[^a-z0-9_]+/g, '').slice(0, 50);
  }

  /** His own tags (Statistics → Channel growth), always added first. Empty by default. */
  function houseTags() {
    const h = cfg().houseTags;
    return (Array.isArray(h) ? h : String(h || '').split(/[\s,]+/)).map(cleanTag).filter(Boolean);
  }

  /**
   * Tags learned from his own posts: every tag on a posted card, weighted by that post's
   * views (the gallery sync in Statistics). Nothing posted yet → an empty list.
   */
  function learnedTags(limit = 20) {
    const perf = (window.Insights && Insights.perf) || {};
    const views = new Map();
    for (const d of perf.deviations || []) if (d && d.deviationId != null) views.set(String(d.deviationId), Number(d.stats && d.stats.views) || 0);
    const score = new Map();
    for (const c of (window.State && State.library) || []) {
      const id = c && c.da && c.da.deviationId;
      if (id == null || !views.has(String(id))) continue;
      const w = Math.log10(1 + views.get(String(id)));
      for (const t of (c.metadata && c.metadata.tags) || []) {
        const k = cleanTag(t);
        if (k) score.set(k, (score.get(k) || 0) + w);
      }
    }
    return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([t]) => t);
  }

  /**
   * The tag list for one post, up to the tag target: his own tags, the post's own tags, the
   * series tag, format tags, cues from the text, then tags learned from his best posts.
   */
  function tagsFor({ house = null, scene = [], series = '', format = 'single', text = '' } = {}, { target } = {}) {
    const want = Math.max(5, Math.min(MAX_TAGS, Number(target) || Number(cfg().tagTarget) || 25));
    const out = [];
    const add = (t) => { const c = cleanTag(t); if (c && c.length >= 2 && !out.includes(c) && out.length < want) out.push(c); };
    (house || houseTags()).forEach(add);
    (scene || []).forEach(add);
    if (series) add(series);
    if (format === 'sequence') TAG_BANK.sequence.forEach(add);
    if (format === 'gif' || format === 'video') TAG_BANK.motion.forEach(add);
    if (/\bstory\b/i.test(text)) TAG_BANK.story.forEach(add);
    for (const [re, tags] of TAG_BANK.cues) if (re.test(text)) tags.forEach(add);
    learnedTags().forEach(add);
    return out;
  }

  function formatOf(card) {
    if (!card) return 'single';
    if (card.format) return card.format;
    if (card.series || card.comicId) return 'sequence';
    if (card.daMedia === 'gif') return 'gif';
    if (card.daMedia === 'video') return 'video';
    return 'single';
  }

  /**
   * What a DeviantArt upload of this card sends: the media (still, GIF or MP4), the folders,
   * the AI label and the platform flags. Throws with a plain reason when the choice cannot be
   * posted (MP4 needs Core; a premium item needs Core and a premium gallery).
   */
  function uploadOptions(card, s) {
    s = s || settings();
    const da = s.da || {};
    const core = da.core || {};
    const md = s.metadata || {};
    const premium = !!card.premium;
    const subscription = !!card.subscription && !premium;
    let tierIds = [];
    if (subscription) {
      if (!core.tierId) throw new Error('this card is set to your DeviantArt Subscription tier: pick the tier first (Statistics → Channel growth → DeviantArt Core, ↻ Refresh)');
      const t = (da.tierCache || []).find((x) => String(x.id) === String(core.tierId));
      if (!t) throw new Error(`"${core.tierName || core.tierId}" is not in the tier list DeviantArt sent — press ↻ Refresh in Statistics → Channel growth → DeviantArt Core and pick the tier again`);
      if (t.published === false) throw new Error(`the tier "${t.name}" is not published on DeviantArt yet — publish it there first`);
      tierIds = [String(t.id)];
    }
    if (premium && !(core.enabled && core.premiumGalleryId)) {
      throw new Error('this card is marked for a DeviantArt premium gallery: turn on DeviantArt Core and pick the premium gallery first (Statistics → Channel growth)');
    }
    if (premium) {
      const g = (da.galleryCache || []).find((x) => String(x.id) === String(core.premiumGalleryId));
      if (!g || g.premium !== true) {
        throw new Error(`"${core.premiumGalleryName || core.premiumGalleryId}" is not a Premium Gallery on DeviantArt — it would be free to everyone. Create a Premium Gallery there (Gallery → Edit → New Gallery → Premium Gallery), press ↻ Refresh galleries in Statistics → DeviantArt Core and pick it`);
      }
    }
    let media = null;
    const want = card.daMedia || 'image';
    if (want === 'gif') {
      if (!card.gif || !card.gif.fname) throw new Error('this card is set to post its GIF on DeviantArt, but it has no GIF yet');
      media = { kind: 'gif', fname: card.gif.fname };
    } else if (want === 'video') {
      if (!core.enabled) throw new Error('MP4 uploads need DeviantArt Core (turn it on in Statistics → Channel growth once you have it)');
      if (!card.video || !card.video.fname) throw new Error('this card is set to post its MP4 on DeviantArt, but it has no video yet');
      media = { kind: 'video', fname: card.video.fname };
    }
    const own = Array.isArray(card.galleryIds) ? card.galleryIds.filter(Boolean).map(String) : [];
    const galleryIds = premium ? [String(core.premiumGalleryId)] : subscription ? own : (own.length ? own : (da.galleryIds || []).map(String));
    const paid = premium || subscription;
    const isAiGenerated = paid ? true : (card.aiLabel != null ? !!card.aiLabel : !!md.isAiGenerated);
    const isMature = card.mature !== undefined ? !!card.mature : !!md.mature;
    return { media, galleryIds, isAiGenerated, isMature, premium, subscription, tierIds };
  }

  const detach = (card) => JSON.parse(JSON.stringify(card));

  function gifCardFrom(card, { title = '' } = {}) {
    if (!card || !card.gif || !card.gif.fname) throw new Error('that card has no GIF yet');
    const now = Date.now();
    const id = `${now}-${Math.random().toString(16).slice(2, 10)}`;
    const md = detach(card.metadata || {});
    return {
      ...detach(card),
      id, jobId: card.jobId || null, batchId: card.batchId || null,
      gifOf: card.id, format: 'gif', daMedia: 'gif',
      destination: 'deviantart', destinations: ['deviantart'],
      status: 'review', da: null, patreon: null, error: null, uploadError: null,
      metadata: {
        ...md,
        title: (title || md.title || '').slice(0, 50),
        titleWritten: !!title,
        tags: tagsFor({ scene: (md.tags || []).filter((t) => !houseTags().includes(cleanTag(t))), format: 'gif', text: `${card.prompt || ''} ${md.description || ''}` }),
      },
      createdAt: now, updatedAt: now,
    };
  }

  /** A DeviantArt sell / subscriber copy of a card: same picture, own id, DeviantArt only. */
  function sellCardFrom(card) {
    if (!card || !card.path) throw new Error('that card has no picture');
    const now = Date.now();
    const id = `${now}-${Math.random().toString(16).slice(2, 10)}`;
    const md = detach(card.metadata || {});
    return {
      ...detach(card),
      id, sellOf: card.id, premium: true,
      destination: 'deviantart', destinations: ['deviantart'],
      status: 'review', da: null, patreon: null, pixiv: null, error: null, uploadError: null,
      metadata: { ...md, tags: [...(md.tags || [])] },
      createdAt: now, updatedAt: now,
    };
  }


  function viewsAt(dev, hours, key = 'views') {
    if (!dev || !dev.publishedAt) return null;
    const pub = dev.publishedAt;
    const pts = [[0, 0]].concat((dev.history || [])
      .filter((h) => h && h.at && h[key] != null)
      .map((h) => [h.at - pub, h[key]])
      .sort((a, b) => a[0] - b[0]));
    const t = hours * 3600000;
    if (pts[pts.length - 1][0] < t) return null;
    for (let i = 1; i < pts.length; i++) {
      const [a, va] = pts[i - 1];
      const [b, vb] = pts[i];
      if (a <= t && t <= b) return b > a ? va + (vb - va) * (t - a) / (b - a) : vb;
    }
    return null;
  }

  const median = (xs) => {
    const v = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };

  /** Median views 24 h after posting, favourites per view and comments, per kind of post. */
  function formatReport({ deviations = [], library = [], hours = 24, sinceMs = 0 } = {}) {
    const byDev = new Map();
    for (const c of library || []) {
      const id = c && c.da && c.da.deviationId;
      if (id != null) byDev.set(String(id), c);
    }
    const groups = new Map();
    for (const d of deviations || []) {
      if (!d || d.isDeleted || (sinceMs && d.publishedAt < sinceMs)) continue;
      const card = byDev.get(String(d.deviationId));
      if (isPaid(card)) continue;
      const f = card ? formatOf(card) : 'single';
      if (!groups.has(f)) groups.set(f, []);
      groups.get(f).push(d);
    }
    const rows = [];
    for (const [format, list] of groups) {
      const v = list.map((d) => viewsAt(d, hours));
      const favRate = list.map((d) => (d.stats && d.stats.views > 50 ? d.stats.favourites / d.stats.views : null));
      rows.push({
        format, posts: list.length, measured: v.filter((x) => x != null).length,
        medianViews: median(v), favPerView: median(favRate),
        medianComments: median(list.map((d) => (d.stats ? d.stats.comments : null))),
      });
    }
    const order = ['single', 'sequence', 'gif', 'video'];
    return rows.sort((a, b) => order.indexOf(a.format) - order.indexOf(b.format));
  }

  /** Watchers, views and their pace per day over the last week, and the days left to the goal. */
  function channelSummary(entries, { goal = cfg().goalWatchers, windowDays = 7 } = {}) {
    const list = (entries || []).filter((e) => e && e.day && e.watchers != null);
    if (!list.length) return null;
    const last = list[list.length - 1];
    const lastMs = Date.parse(`${last.day}T12:00:00`);
    const base = [...list].reverse().find((e) => (lastMs - Date.parse(`${e.day}T12:00:00`)) >= windowDays * 86400000)
      || list[0];
    const days = Math.max(0, Math.round((lastMs - Date.parse(`${base.day}T12:00:00`)) / 86400000));
    const per = (k) => (days > 0 && last[k] != null && base[k] != null ? (last[k] - base[k]) / days : null);
    const watchersPerDay = per('watchers');
    const toGoal = goal && last.watchers < goal && watchersPerDay > 0 ? Math.ceil((goal - last.watchers) / watchersPerDay) : null;
    return {
      day: last.day, watchers: last.watchers, pageviews: last.pageviews, deviations: last.deviations,
      watchersPerDeviation: last.deviations ? last.watchers / last.deviations : null,
      spanDays: days, watchersPerDay, pageviewsPerDay: per('pageviews'), deviationsPerDay: per('deviations'),
      goal, progress: goal ? Math.min(1, last.watchers / goal) : null, daysToGoal: toGoal,
    };
  }

  // ---------------------------------------------------------------- posting strategy

  const PART_RE = /^(.*?)(?:([.,:;!?—–\-|]\s*)|\s+|^)(part|pt|page|chapter|ch|ep|episode)\.?\s*#?\s*(\d+(?:\.\d+)?)(?:\s*\/\s*\d+)?(.*)$/i;
  const PART_TAIL_RE = /^[\s.!?,:;\-—–]*(?:\([^)]*\))?[\s.!?]*(?:comic)?[\s.!?]*$/i;

  /** "Lighthouse Keeper. Part 3.5" → { base: 'lighthouse keeper', part: 3.5 }; null when the title has no part number. */
  function partOf(title) {
    const t = String(title || '').trim();
    const m = t.match(PART_RE);
    if (!m) return null;
    const [, head, sep, word, num, tail] = m;
    if (!PART_TAIL_RE.test(tail)) return null;
    if (head && !sep && word[0] !== word[0].toUpperCase()) return null;
    const base = head.replace(/\bcomic\b/gi, ' ').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
    return base ? { base, part: Number(num) } : null;
  }

  /** Is this deviation a comic page? The library card first, its title and tags second. */
  function isComicPost(d, card) {
    if (card) {
      const f = formatOf(card);
      if (f === 'sequence' || card.comicId) return true;
      if (f === 'gif' || f === 'video') return false;
    }
    return /\bcomic\b/i.test(d.title || '') || !!partOf(d.title) || (d.tags || []).some((t) => /^(comic|comicpage)$/i.test(t));
  }

  /**
   * The numbers and suggestions behind "what should I post, and when". Pure: pass the synced
   * deviations and the library. Advice only; nothing here blocks a post.
   */
  function postingPlan({ deviations = [], library = [], now = Date.now(), lastSyncAt = null, days = 14,
    minutesPerComic = 20, minutesPerSingle = 4, partGapHours = 20 } = {}) {
    const byDev = new Map();
    for (const c of library || []) {
      const id = c && c.da && c.da.deviationId;
      if (id != null) byDev.set(String(id), c);
    }
    const since = now - days * 864e5;
    const posts = (deviations || []).filter((d) => d && !d.isDeleted && d.publishedAt && d.publishedAt >= since)
      .filter((d) => !isPaid(byDev.get(String(d.deviationId))))
      .sort((a, b) => a.publishedAt - b.publishedAt)
      .map((d) => {
        const card = byDev.get(String(d.deviationId)) || null;
        const kind = isComicPost(d, card) ? 'comic' : (card && ['gif', 'video'].includes(formatOf(card)) ? 'gif' : 'single');
        const v12 = viewsAt(d, 12);
        const v24 = viewsAt(d, 24);
        return {
          title: d.title, kind, publishedAt: new Date(d.publishedAt).toISOString(),
          ageHours: Math.round((now - d.publishedAt) / 36e5),
          views12h: v12 == null ? null : Math.round(v12), views24h: v24 == null ? null : Math.round(v24),
          viewsNow: d.stats ? d.stats.views : null, favs: d.stats ? d.stats.favourites : null,
          part: partOf(d.title), _t: d.publishedAt,
        };
      });

    const byKind = {};
    for (const k of ['comic', 'single', 'gif']) {
      const list = posts.filter((p) => p.kind === k);
      if (!list.length) continue;
      const m12 = median(list.map((p) => p.views12h));
      const m24 = median(list.map((p) => p.views24h));
      const mins = k === 'comic' ? minutesPerComic : minutesPerSingle;
      byKind[k] = {
        posts: list.length, measured24h: list.filter((p) => p.views24h != null).length,
        medianViews12h: m12 == null ? null : Math.round(m12), medianViews24h: m24 == null ? null : Math.round(m24),
        minutesOfWorkPerPost: mins,
        views24hPerHourOfWork: m24 == null || !mins ? null : Math.round(m24 / (mins / 60)),
      };
    }

    const series = {};
    for (const p of posts) if (p.part) (series[p.part.base] = series[p.part.base] || []).push(p);
    const crowded = [];
    for (const [base, list] of Object.entries(series)) {
      list.sort((a, b) => a._t - b._t);
      for (let i = 1; i < list.length; i++) {
        const gap = (list[i]._t - list[i - 1]._t) / 36e5;
        list[i].hoursAfterPreviousPart = Math.round(gap * 10) / 10;
        if (gap < partGapHours) crowded.push({ base, title: list[i].title, hoursAfterPreviousPart: Math.round(gap * 10) / 10 });
      }
    }
    const lastPartAt = {};
    for (const [base, list] of Object.entries(series)) lastPartAt[base] = Math.max(...list.map((p) => p._t));

    const pending = (library || []).filter((c) => c && ['review', 'approved'].includes(c.status) && (c.comicId || c.series || formatOf(c) === 'sequence'))
      .slice(0, 12)
      .map((c) => {
        const title = (c.metadata && c.metadata.title) || c.title || '';
        return { c, title, pt: partOf(title) };
      });
    const nextAt = {};
    for (const [base, at] of Object.entries(lastPartAt)) nextAt[base] = at + partGapHours * 36e5;
    const timed = new Map();
    for (const w of pending.filter((x) => x.pt && nextAt[x.pt.base]).sort((a, b) => a.pt.part - b.pt.part)) {
      const at = Math.max(nextAt[w.pt.base], now);
      timed.set(w.c.id, at);
      nextAt[w.pt.base] = at + partGapHours * 36e5;
    }
    const waiting = pending.map(({ c, title }) => {
      const earliest = timed.get(c.id);
      return {
        id: c.id, title, status: c.status,
        ...(earliest ? { suggestedEarliestPost: new Date(earliest).toISOString(), readyNow: earliest <= now } : {}),
      };
    });

    const ranked = posts.filter((p) => p.kind === 'comic' && (p.views24h != null || p.views12h != null))
      .sort((a, b) => (b.views24h ?? b.views12h) - (a.views24h ?? a.views12h));
    const strip = ({ _t, part, ...rest }) => rest;

    const advice = [];
    const syncAgeH = lastSyncAt ? (now - lastSyncAt) / 36e5 : null;
    if (syncAgeH == null || syncAgeH > 3) advice.push(`The numbers are ${syncAgeH == null ? 'not synced yet' : `${Math.round(syncAgeH)} h old`} — anything below may be out of date.`);
    const c = byKind.comic, s = byKind.single;
    if (c && s && c.medianViews24h && s.medianViews24h) {
      advice.push(`A comic page earned a median ${c.medianViews24h} views in its first day vs ${s.medianViews24h} for a single (${(c.medianViews24h / s.medianViews24h).toFixed(1)}×). Per hour of work: comics ~${c.views24hPerHourOfWork}, singles ~${s.views24hPerHourOfWork} (work estimate ${c.minutesOfWorkPerPost} vs ${s.minutesOfWorkPerPost} min per post).`);
    }
    if (crowded.length) {
      advice.push(`${crowded.length} story part(s) went up less than ${partGapHours} h after the part before (${crowded.slice(0, 4).map((x) => `"${x.title}" +${x.hoursAfterPreviousPart} h`).join(', ')}). Parts posted close together compete in the same watch feed, and a later part only works for people who read the earlier one — spacing them a day apart usually gives each its own first day.`);
    }
    if (ranked.length >= 3) {
      advice.push(`Best comics so far: ${ranked.slice(0, 3).map((p) => `"${p.title}" (${p.views24h ?? p.views12h})`).join(', ')}; weakest: ${ranked.slice(-2).map((p) => `"${p.title}" (${p.views24h ?? p.views12h})`).join(', ')}. Check what the winners share in their titles and hooks.`);
    }
    if (posts.length < 6) advice.push('Fewer than 6 posts in this window — treat any comparison as a hint, not a result.');

    return {
      window: `${posts.length} posts, last ${days} days`,
      dataAgeHours: syncAgeH == null ? null : Math.round(syncAgeH * 10) / 10,
      byKind, crowdedParts: crowded, waitingComics: waiting,
      comics: ranked.slice(0, 8).map(strip),
      recent: posts.slice(-12).map(strip),
      advice,
    };
  }

  /** Deviation ids of the paid pages (Premium Gallery + Subscription tier) in the library. */
  function premiumDeviationIds(library) {
    return new Set((library || []).filter((c) => isPaid(c) && c.da && c.da.deviationId != null).map((c) => String(c.da.deviationId)));
  }

  /** Advice sentences for cards that are story parts whose previous part went up less than `partGapHours` ago. */
  function partSpacingNotes(cards, deviations, { now = Date.now(), partGapHours = 20, library = [] } = {}) {
    const premium = premiumDeviationIds(library);
    const last = {};
    for (const d of deviations || []) {
      const pt = d && !d.isDeleted && d.publishedAt && !premium.has(String(d.deviationId)) ? partOf(d.title) : null;
      if (pt) last[pt.base] = Math.max(last[pt.base] || 0, d.publishedAt);
    }
    const notes = [];
    for (const c of cards || []) {
      if (isPaid(c)) continue;
      const title = (c && c.metadata && c.metadata.title) || (c && c.title) || '';
      const pt = partOf(title);
      if (!pt || !last[pt.base]) continue;
      const gap = (now - last[pt.base]) / 36e5;
      if (gap < partGapHours) notes.push(`"${title}" follows the previous part by only ${gap.toFixed(1)} h; a gap of ${partGapHours} h or more has given each part its own first day.`);
    }
    return notes;
  }

  window.Growth = {
    TAG_BANK, MAX_TAGS, DEFAULTS,
    cfg, username, cleanTag, houseTags, learnedTags, tagsFor, formatOf, uploadOptions, gifCardFrom, sellCardFrom,
    viewsAt, median, formatReport, channelSummary,
    partOf, isComicPost, postingPlan, partSpacingNotes, premiumDeviationIds, isPaid,
  };
})();
