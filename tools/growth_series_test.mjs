/**
 * growth_series_test.mjs: offline tests for Channel growth, Series and DeviantArt media uploads.
 *
 *   growth.js      tags (his own tags first, learned tags, limits), post format, upload options
 *                  (GIF / MP4 / premium / folder / AI label), views@h, format report, channel summary
 *   series.js      plan parsing, premise, nextPart → a comic page tagged with its part,
 *                  page export → title / links / folder / tags, refresh
 *   channel.js     profile parsing (escaped embedded state), merge rule, snapshot with a stub fetch
 *   uploadmedia.js main-side media resolution stays inside the library
 *
 * Renderer IIFEs run in a vm with State/U/window.ala stubbed. No app, no LLM, no GPU, no network.
 *
 *   node tools/growth_series_test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const require = createRequire(import.meta.url);

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};
const section = (t) => console.log(`\n[${t}]`);

function load(files, { settings = {}, library = [], comics = null, llm = null, seriesData = null, perf = null } = {}) {
  const saved = { series: seriesData, library: 0 };
  const State = {
    settings: {
      gen: {}, metadata: { isAiGenerated: false, mature: false }, da: { galleryIds: [], username: 'artist' },
      growth: {}, ...settings,
    },
    library, queue: [], log: [],
    persistLibrary() { saved.library++; }, persistQueue() {}, emit() {}, on() {},
    addLog(m, k) { this.log.push({ m, k }); },
  };
  const llmCalls = [];
  const U = {
    uid: () => `id${Math.random().toString(36).slice(2, 9)}`,
    llmChat: async (messages, opts, label) => {
      llmCalls.push({ messages, opts, label });
      if (!llm) throw new Error('no llm in this test');
      return { text: typeof llm === 'function' ? llm(messages, opts) : llm };
    },
  };
  const ctx = {
    console, Date, Math, JSON, Number, String, Array, Object, Map, Set, RegExp, Error, Promise, setTimeout,
    State, U,
  };
  ctx.window = ctx;
  ctx.ala = {
    db: {
      getSeries: async () => saved.series,
      setSeries: async (d) => { saved.series = JSON.parse(JSON.stringify(d)); return true; },
    },
  };
  if (perf) ctx.Insights = { perf };
  if (comics) ctx.Comics = comics;
  ctx.ComicLayout = { LAYOUTS: { 'grid-2x2': { slots: 4 } } };
  vm.createContext(ctx);
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(root, 'src/renderer', f), 'utf8'), ctx, { filename: f });
  return { ctx, State, saved, llmCalls };
}

// ---------------------------------------------------------------- growth.js: tags
section('growth: tags');
{
  const { ctx } = load(['growth.js']);
  const G = ctx.Growth;
  ok('no own tags by default', G.houseTags().length === 0);
  const t = G.tagsFor({ scene: ['lighthouse', 'Night Sky!', 'sea'], text: 'a wizard casts a spell over the harbour' });
  ok('the post\'s own tags come first, cleaned', t.slice(0, 3).join(',') === 'lighthouse,nightsky,sea', t.join(','));
  ok('cues from the text add genre tags', t.includes('magic') && t.includes('fantasy'));
  ok('nothing is invented when there is nothing to learn from', t.length === 5, t.join(','));
  const seq = G.tagsFor({ series: 'thelighthouseletters', format: 'sequence' });
  ok('a comic page gets its series tag and the comic format tags', seq[0] === 'thelighthouseletters' && seq.includes('comic') && seq.includes('comicpage'));
  ok('a GIF post gets the motion tags', G.tagsFor({ format: 'gif' }).includes('animatedgif'));
  const many = G.tagsFor({ scene: Array.from({ length: 40 }, (_, i) => `tag${i}`) });
  ok('the default target is 25 tags', many.length === 25, String(many.length));
  ok('an explicit target caps it', G.tagsFor({ scene: Array.from({ length: 40 }, (_, i) => `tag${i}`) }, { target: 10 }).length === 10);
}
{
  const library = [
    { da: { deviationId: 1 }, metadata: { tags: ['lighthouse', 'sea', 'digitalart'] } },
    { da: { deviationId: 2 }, metadata: { tags: ['forest', 'digitalart'] } },
    { da: { deviationId: 3 }, metadata: { tags: ['unseen'] } },
  ];
  const perf = { deviations: [{ deviationId: 1, stats: { views: 5000 } }, { deviationId: 2, stats: { views: 50 } }] };
  const { ctx } = load(['growth.js'], { library, perf, settings: { growth: { houseTags: ['MyArt', 'illustration'], tagTarget: 6 } } });
  const G = ctx.Growth;
  ok('his own tags are read from settings, cleaned', G.houseTags().join(',') === 'myart,illustration');
  const L = G.learnedTags();
  ok('learned tags are weighted by views of his own posts', L[0] === 'digitalart' && L.indexOf('lighthouse') < L.indexOf('forest'), L.join(','));
  ok('a card without view data teaches nothing', !L.includes('unseen'));
  const t = G.tagsFor({ scene: ['harbour'] });
  ok('order: own tags, post tags, then learned; growth.tagTarget applies', t.join(',') === 'myart,illustration,harbour,digitalart,lighthouse,sea', t.join(','));
}

// ---------------------------------------------------------------- growth.js: format, upload options
section('growth: format, upload options');
{
  const { ctx, State } = load(['growth.js']);
  const G = ctx.Growth;
  ok('format: plain card is single', G.formatOf({}) === 'single');
  ok('format: series card is sequence', G.formatOf({ series: { id: 'x', part: 1 } }) === 'sequence');
  ok('format: comic page is sequence', G.formatOf({ comicId: 'p1' }) === 'sequence');
  ok('format: daMedia gif', G.formatOf({ daMedia: 'gif' }) === 'gif');
  ok('format: explicit format wins', G.formatOf({ format: 'video', daMedia: 'gif' }) === 'video');

  const s = State.settings;
  let o = G.uploadOptions({ path: 'x.png' }, s);
  ok('default: no media, settings gallery, settings AI flag (off)', o.media === null && o.galleryIds.length === 0 && o.isAiGenerated === false);
  o = G.uploadOptions({ galleryIds: ['96682504', '111'] }, s);
  ok('a card\'s own folders beat the settings gallery', o.galleryIds.join() === '96682504,111');
  o = G.uploadOptions({ daMedia: 'gif', gif: { fname: 'i2v-1.gif' } }, s);
  ok('a GIF card sends its GIF', o.media && o.media.kind === 'gif' && o.media.fname === 'i2v-1.gif');
  let threw = '';
  try { G.uploadOptions({ daMedia: 'gif' }, s); } catch (e) { threw = e.message; }
  ok('a GIF card without a GIF refuses with a reason', /no GIF yet/.test(threw), threw);
  threw = '';
  try { G.uploadOptions({ daMedia: 'video', video: { fname: 'a.mp4' } }, s); } catch (e) { threw = e.message; }
  ok('MP4 without Core refuses', /need DeviantArt Core/.test(threw), threw);
  threw = '';
  try { G.uploadOptions({ premium: true }, s); } catch (e) { threw = e.message; }
  ok('premium without Core refuses', /premium gallery/.test(threw), threw);
  const core = { ...s, da: { ...s.da, core: { enabled: true, premiumGalleryId: '777' } } };
  o = G.uploadOptions({ premium: true, galleryIds: ['96682504'], aiLabel: false }, core);
  ok('premium goes to the premium gallery only', o.galleryIds.join() === '777');
  ok('premium is always labelled AI (sold item), even against the card', o.isAiGenerated === true);
  o = G.uploadOptions({ daMedia: 'video', video: { fname: 'a.mp4' } }, core);
  ok('MP4 with Core sends the video', o.media && o.media.kind === 'video');
  o = G.uploadOptions({ aiLabel: true }, s);
  ok('a card can opt into the AI label on a free post', o.isAiGenerated === true);

  const src = { id: 'c1', fname: 'p.png', gif: { fname: 'g.gif' }, metadata: { title: 'Harbour at dawn', tags: ['harbour', 'boats'] }, da: { url: 'x' }, status: 'drafted' };
  const gc = G.gifCardFrom(src, { title: 'Harbour at dawn (animated)' });
  ok('gifCardFrom: new id, review, DA-only, GIF media', gc.id !== 'c1' && gc.status === 'review' && gc.daMedia === 'gif' && gc.destinations.join() === 'deviantart');
  ok('gifCardFrom: never inherits the posted state', gc.da === null);
  ok('gifCardFrom: points back at its source and carries motion tags', gc.gifOf === 'c1' && gc.metadata.tags.includes('animation') && gc.metadata.tags.includes('boats'));
  ok('gifCardFrom: source card untouched', src.status === 'drafted' && src.metadata.title === 'Harbour at dawn');
}

// ---------------------------------------------------------------- growth.js: measuring
section('growth: views@h, format report, channel summary');
{
  const { ctx } = load(['growth.js']);
  const G = ctx.Growth;
  const H = 3600000;
  const pub = Date.UTC(2026, 9, 1);
  const dev = (id, v24, favs, extra = {}) => ({ deviationId: id, publishedAt: pub, stats: { views: v24 * 2, favourites: favs, comments: 1 }, history: [{ at: pub + 12 * H, views: v24 / 2 }, { at: pub + 36 * H, views: v24 * 1.5 }], ...extra });
  ok('viewsAt interpolates between snapshots', Math.round(G.viewsAt(dev('a', 1000, 1), 24)) === 1000, G.viewsAt(dev('a', 1000, 1), 24));
  ok('viewsAt is null when the post is younger than the age', G.viewsAt({ publishedAt: pub, history: [{ at: pub + 2 * H, views: 5 }] }, 24) === null);
  const library = [{ da: { deviationId: 1 }, series: { id: 's', part: 1 } }, { da: { deviationId: 2 }, daMedia: 'gif' }, { da: { deviationId: 3 } }];
  const rows = G.formatReport({ deviations: [dev(1, 3000, 30), dev(2, 2000, 10), dev(3, 1000, 5), dev(4, 1200, 6)], library });
  const by = Object.fromEntries(rows.map((r) => [r.format, r]));
  ok('format report splits single / sequence / gif', by.single && by.sequence && by.gif);
  ok('unmatched deviations count as singles', by.single.posts === 2);
  ok('sequence median views@24h', Math.round(by.sequence.medianViews) === 3000, by.sequence.medianViews);
  ok('favourites per view is a rate', Math.abs(by.sequence.favPerView - 30 / 6000) < 1e-9);
  ok('rows come in a fixed order', rows.map((r) => r.format).join() === 'single,sequence,gif');

  const e = (day, w, pv, d) => ({ day, watchers: w, pageviews: pv, deviations: d });
  const sum = G.channelSummary([e('2026-11-01', 1200, 33000, 500), e('2026-11-05', 1240, 33300, 540), e('2026-11-08', 1270, 33500, 570)], { goal: 15000 });
  ok('summary: latest counters', sum.watchers === 1270 && sum.day === '2026-11-08');
  ok('summary: per-day pace over the 7-day window', sum.spanDays === 7 && Math.abs(sum.watchersPerDay - 10) < 1e-9, JSON.stringify(sum));
  ok('summary: days to goal at that pace', sum.daysToGoal === Math.ceil((15000 - 1270) / 10));
  const one = G.channelSummary([e('2026-11-06', 1270, 33423, 554)], { goal: 15000 });
  ok('summary with one snapshot: no pace, no ETA', one.spanDays === 0 && one.watchersPerDay === null && one.daysToGoal === null);
  ok('summary of nothing is null', G.channelSummary([], {}) === null);
}

// ---------------------------------------------------------------- series.js
section('series: plan, premise, next part, export');
{
  const created = [];
  const started = [];
  const projects = new Map();
  const Comics = {
    create(o) { const p = { id: `p${created.length + 1}`, ...o, run: { active: false, phase: 'draft' }, page: null }; created.push(o); projects.set(p.id, p); return p; },
    start(p) { started.push(p.id); p.run.active = true; return p; },
    persist() {}, get(id) { return projects.get(id) || null; },
  };
  const planJson = JSON.stringify({ title: 'The First Bottle', character: 'Mira, a young lighthouse keeper, braided red hair, yellow raincoat', place: 'a rocky beach at dawn', trigger: 'a bottle washes up with her name on it', logline: 'Mira opens the bottle and the map inside starts to glow.', hook: 'Who sent this?', next: 'Next time: the map points out to sea.' });
  const library = [];
  const { ctx, saved, llmCalls } = load(['growth.js', 'series.js'], { comics: Comics, llm: `Sure! Here is the plan:\n${planJson}`, library });
  const S = ctx.Series;
  await S.init();
  let threw = '';
  try { S.create({ name: '', about: 'x' }); } catch (e) { threw = e.message; }
  ok('create refuses a nameless series', /name/.test(threw));
  threw = '';
  try { S.create({ name: 'Empty' }); } catch (e) { threw = e.message; }
  ok('create refuses a series about nothing', /about/.test(threw));
  const s = S.create({ name: 'The Lighthouse Letters', about: 'A lighthouse keeper finds a message in a bottle every week.', world: 'A windy island village.', folderId: '96682504', folderName: 'Lighthouse Letters' });
  ok('create stores defaults (4 panels, classic page, not a sequence)', s.panels === 4 && s.pageStyle === 'classic' && s.sequence === false && s.parts.length === 0);
  ok('create persists to series.json', saved.series && saved.series.series.length === 1);
  threw = '';
  try { S.create({ name: 'the lighthouse letters', about: 'again' }); } catch (e) { threw = e.message; }
  ok('a duplicate name is refused', /already/.test(threw));

  const prompt = S.planPrompt(s, 1);
  ok('plan prompt carries the series and the part', /message in a bottle/.test(prompt) && /Part 1/.test(prompt) && /"character"/.test(prompt));
  const parsed = ctx.SeriesPrompts.parsePlan(`noise {"bad": } then ${planJson} trailing`);
  ok('parsePlan finds the last JSON object in chatter', parsed && parsed.title === 'The First Bottle' && parsed.place === 'a rocky beach at dawn');
  ok('parsePlan strips a "Part N:" prefix from the title', ctx.SeriesPrompts.parsePlan(JSON.stringify({ title: 'Part 3: Fog Day', character: 'c', logline: 'l' })).title === 'Fog Day');
  ok('parsePlan rejects a plan without a character', ctx.SeriesPrompts.parsePlan('{"title":"x","logline":"y"}') === null);

  const r = await S.nextPart(s.id);
  ok('nextPart plans with the writer (ideation role)', llmCalls.length === 1 && llmCalls[0].opts.role === 'ideation' && r.part.planned === 'writer');
  const c0 = created[0];
  ok('nextPart makes a comic page', c0.sequence === false && c0.format === 'page' && c0.panels === 4 && c0.lettering === 'balloons');
  ok('the comic is named "<Series> — Part 1"', c0.name === 'The Lighthouse Letters — Part 1', c0.name);
  ok('the premise carries part, series, place and the panel plan', /Part 1/.test(c0.premise) && /message in a bottle/.test(c0.premise) && /rocky beach/.test(c0.premise) && /panel 4 shows the outcome/.test(c0.premise), c0.premise);
  ok('the project is tagged with its series part and started', r.project.series.id === s.id && r.project.series.part === 1 && started.includes(r.project.id));
  ok('the page header is locked to "<Series> — Part 1"', r.project.title === 'The Lighthouse Letters — Part 1' && r.project.titleManual === true);
  ok('the part is recorded as being made', s.parts.length === 1 && s.parts[0].status === 'making' && s.parts[0].projectId === r.project.id);
  threw = '';
  try { await S.nextPart(s.id); } catch (e) { threw = e.message; }
  ok('a second part is refused while the first is still running', /still being made/.test(threw), threw);

  const card = { id: 'card-1', status: 'review', metadata: { title: 'The Lighthouse Letters — Part 1', description: '', tags: [] }, comicId: r.project.id };
  library.push(card);
  S.onPageExported(r.project, card);
  ok('export: the card knows its series part and format', card.series && card.series.part === 1 && card.format === 'sequence');
  ok('export: the card goes to the series folder', card.galleryIds && card.galleryIds.join() === '96682504');
  ok('export: title "<Series> — Part 1" within 50 chars', card.metadata.title === 'The Lighthouse Letters — Part 1', card.metadata.title);
  ok('export: "Next time:" from the writer is not doubled', /Next: the map points out to sea\./.test(card.metadata.description) && !/Next: Next/i.test(card.metadata.description), card.metadata.description);
  ok('export: the description tells the story', card.metadata.description.startsWith('Mira opens the bottle'), card.metadata.description);
  ok('export: Part 1 has no previous-part link', !/Previous part/.test(card.metadata.description));
  ok('export: tags carry the series tag and the comic tags', card.metadata.tags.includes('thelighthouseletters') && card.metadata.tags.includes('comic'), card.metadata.tags.join(' '));
  ok('export: the part points at its card, status review', s.parts[0].cardId === 'card-1' && s.parts[0].status === 'review');

  card.status = 'drafted';
  card.da = { deviationId: 1, url: 'https://www.deviantart.com/artist/art/The-Lighthouse-Letters-Part-1-1', published: true };
  r.project.run.active = false;
  S.refresh();
  ok('refresh: a published part reads "posted"', s.parts[0].status === 'posted');
  const r2 = await S.nextPart(s.id);
  ok('Part 2 is numbered 2 and lists Part 1 to the planner', r2.part.n === 2 && /Part 1: Mira opens the bottle/.test(llmCalls[1].messages[0].content));
  const card2 = { id: 'card-2', status: 'review', metadata: { title: '', tags: [] } };
  library.push(card2);
  S.onPageExported(r2.project, card2);
  ok('Part 2 description links the previous part', card2.metadata.description.includes('Previous part: https://www.deviantart.com/artist/art/The-Lighthouse-Letters-Part-1-1'));
  ok('Part 2 does not repeat the same URL as "Part 1"', (card2.metadata.description.match(/The-Lighthouse-Letters-Part-1-1/g) || []).length === 1);
  const hand = { id: 'card-3', status: 'review', metadata: { title: 'My own title', titleWritten: true, tags: ['x'] } };
  S.onPageExported(r2.project, hand);
  ok('a hand-written title is never overwritten', hand.metadata.title === 'My own title' && hand.metadata.tags.join() === 'x');
  const gridSeries = S.create({ name: 'Grid Test', about: 'm', layout: 'grid' });
  const rg = await S.nextPart(gridSeries.id, { plan: { title: 't', character: 'c', logline: 'l', place: 'p', trigger: 'x', hook: 'h' } });
  ok('layout grid puts a 4-panel part on the 2 × 2 page', rg.project.template === 'grid-2x2' && gridSeries.layout === 'grid');
  S.remove(gridSeries.id);
  const seqSeries = S.create({ name: 'Seasons', about: 'One tree through the year.', sequence: true });
  const rs = await S.nextPart(seqSeries.id, { plan: { title: 't', character: 'an old oak', logline: 'l', place: 'a hill', trigger: 'time', hook: '' } });
  ok('a sequence series makes change-sequence pages', created[created.length - 1].sequence === true && /change sequence/.test(rs.project.premise));
  S.remove(seqSeries.id);
  const long = S.create({ name: 'An Extremely Long Series Name For Tests Here', about: 'm' });
  ok('a long series name still fits DeviantArt\'s 50 chars', S.metadataFor(long, { n: 12, plan: {} }, {}).title.length <= 50, S.metadataFor(long, { n: 12, plan: {} }, {}).title);
  S.remove(long.id);
  ok('remove drops only the series entry', S.list().length === 1 && library.length === 2);
}
{
  const Comics = { create: (o) => ({ id: 'p', ...o, run: {} }), start() {}, persist() {}, get: () => null };
  const { ctx, llmCalls } = load(['growth.js', 'series.js'], { comics: Comics, llm: 'I cannot do that.' });
  const S = ctx.Series;
  await S.init();
  const s = S.create({ name: 'Harbour Tales', about: 'Small stories from a fishing harbour.' });
  const r = await S.nextPart(s.id);
  ok('two failed plans → fallback plan, part still made', llmCalls.length === 2 && r.part.planned === 'fallback' && /Harbour Tales, Part 1/.test(r.project.premise));
}

// ---------------------------------------------------------------- channel.js (main)
section('channel: parse, merge, snapshot');
{
  const ch = require(path.join(root, 'src/main/channel.js'));
  const html = '<script>window.__INITIAL_STATE__ = JSON.parse("{\\"user\\":{\\"username\\":\\"artist\\"},\\"stats\\":{\\"watchers\\":1270,\\"pageviews\\":33423,\\"deviations\\":554,\\"watching\\":3}}")</script>';
  const p = ch.parseProfile(html);
  ok('parses escaped embedded counters', p && p.watchers === 1270 && p.pageviews === 33423 && p.deviations === 554 && p.watching === 3, JSON.stringify(p));
  ok('a page without counters is null', ch.parseProfile('<html>nothing</html>') === null);
  ok('usernames are cleaned', ch.cleanUser(' Some-One/../x ') === 'some-onex');
  let data = { version: 1, accounts: {} };
  data = ch.merge(data, 'artist', { day: '2026-11-06', at: 2, watchers: 1270, pageviews: 1, deviations: 1 });
  data = ch.merge(data, 'artist', { day: '2026-11-05', at: 1, watchers: 1260, pageviews: 1, deviations: 1 });
  data = ch.merge(data, 'artist', { day: '2026-11-06', at: 3, watchers: 1271, pageviews: 2, deviations: 2, source: 'app' });
  const L = data.accounts.artist;
  ok('merge: one entry per day, the later replaces', L.length === 2 && L[1].watchers === 1271 && L[1].source === 'app');
  ok('merge: days sorted', L[0].day === '2026-11-05');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acre-ch-'));
  const pages = { artist: html, other: html.replace('1270', '17494') };
  const fetchImpl = async (url) => {
    const u = url.split('/').pop();
    if (!pages[u]) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => pages[u] };
  };
  const t = new ch.ChannelTracker(dir, { fetchImpl });
  const res = await t.snapshot(['artist', 'other', 'nobody'], { source: 'test' });
  ok('snapshot: reads what it can, reports the rest', res.ok && res.read.artist.watchers === 1270 && res.read.other.watchers === 17494 && /404/.test(res.errors.nobody || ''));
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'channel.json'), 'utf8'));
  onDisk.accounts.third = [{ day: '2026-11-01', at: 1, watchers: 14000, pageviews: 1, deviations: 1 }];
  fs.writeFileSync(path.join(dir, 'channel.json'), JSON.stringify(onDisk));
  await t.snapshot(['artist']);
  const after = t.history();
  ok('snapshot re-reads the disk, so an account written meanwhile survives', after.accounts.third && after.accounts.third[0].watchers === 14000);
  ok('history keeps one entry for today per account', after.accounts.artist.length === 1);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- uploadmedia.js (main)
section('uploadmedia: library-only resolution');
{
  const { resolveUploadMedia } = require(path.join(root, 'src/main/uploadmedia.js'));
  const lib = path.join('C:', 'lib');
  const a = resolveUploadMedia({ filePath: 'x.png', title: 't', media: { kind: 'gif', fname: 'i2v-1.gif' } }, lib);
  ok('a GIF resolves into library/gifs', a.filePath === path.join(lib, 'gifs', 'i2v-1.gif') && !('media' in a) && a.title === 't');
  const b = resolveUploadMedia({ media: { kind: 'video', fname: '..\\..\\Windows\\evil.mp4' } }, lib);
  ok('a traversal name is flattened to its basename', b.filePath === path.join(lib, 'videos', 'evil.mp4'), b.filePath);
  const c = resolveUploadMedia({ filePath: 'keep.png' }, lib);
  ok('no media = the card picture untouched', c.filePath === 'keep.png');
  let threw = '';
  try { resolveUploadMedia({ media: { kind: 'exe', fname: 'a' } }, lib); } catch (e) { threw = e.message; }
  ok('an unknown media kind is refused', /unknown upload media kind/.test(threw));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
