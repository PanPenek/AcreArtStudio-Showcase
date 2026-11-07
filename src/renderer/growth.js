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
  };

  function settings() { return (window.State && State.settings) || {}; }
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
    if (premium && !(core.enabled && core.premiumGalleryId)) {
      throw new Error('this card is marked for a DeviantArt premium gallery: turn on DeviantArt Core and pick the premium gallery first (Statistics → Channel growth)');
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
    const galleryIds = premium ? [String(core.premiumGalleryId)] : (own.length ? own : (da.galleryIds || []).map(String));
    const isAiGenerated = premium ? true : (card.aiLabel != null ? !!card.aiLabel : !!md.isAiGenerated);
    const isMature = card.mature !== undefined ? !!card.mature : !!md.mature;
    return { media, galleryIds, isAiGenerated, isMature, premium };
  }

  function gifCardFrom(card, { title = '' } = {}) {
    if (!card || !card.gif || !card.gif.fname) throw new Error('that card has no GIF yet');
    const now = Date.now();
    const id = `${now}-${Math.random().toString(16).slice(2, 10)}`;
    const md = card.metadata || {};
    return {
      ...card,
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

  window.Growth = {
    TAG_BANK, MAX_TAGS, DEFAULTS,
    cfg, username, cleanTag, houseTags, learnedTags, tagsFor, formatOf, uploadOptions, gifCardFrom,
    viewsAt, median, formatReport, channelSummary,
  };
})();
