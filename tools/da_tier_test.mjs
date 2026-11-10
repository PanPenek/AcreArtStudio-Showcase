/**
 * da_tier_test.mjs: DeviantArt Subscription-tier and Premium Gallery uploads, plus the
 * posting-strategy helpers in growth.js.
 *
 *   growth.js  uploadOptions: a card with `subscription` goes to the tier from the settings and
 *              fails closed when the tier is unset / not in DeviantArt's list / unpublished;
 *              a premium card needs a folder DeviantArt reported as premium; Mature is a plain
 *              per-card / settings option. partOf / postingPlan / partSpacingNotes / sellCardFrom.
 *   daweb.js   the deviation/update payload carries `tierids` as numbers, the tier list parser,
 *              and uploadDraft refuses to press Submit when DeviantArt does not list the draft in the tier.
 *
 * No app, no network: electron's session is stubbed with a fake fetch.
 *   node tools/da_tier_test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const require = createRequire(import.meta.url);

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

// ---------------------------------------------------------------- growth.js
console.log('\n[growth.uploadOptions]');
function growthWith(da) {
  const State = { settings: { metadata: { isAiGenerated: false, mature: false }, da: { galleryIds: ['84304319'], ...da }, growth: {} }, library: [] };
  const ctx = vm.createContext({ console, window: {}, State, U: {}, Date, Math, JSON, String, Number, Array, Object, Set, Map, RegExp, Error });
  ctx.window = ctx;
  new vm.Script(fs.readFileSync(path.join(root, 'src/renderer/growth.js'), 'utf8')).runInContext(ctx);
  return { G: ctx.Growth, s: State.settings };
}
const tierCache = [{ id: '1407811399', name: 'Supporter', published: true }];
{
  const { G, s } = growthWith({ core: { enabled: true, tierId: '1407811399', tierName: 'Supporter' }, tierCache });
  const o = G.uploadOptions({ subscription: true }, s);
  ok('tier card → tierIds from settings', JSON.stringify(o.tierIds) === '["1407811399"]', JSON.stringify(o.tierIds));
  ok('tier card is AI-labelled; Mature follows the setting (off)', o.isMature === false && o.isAiGenerated === true);
  ok('tier card lands in NO public folder by default', Array.isArray(o.galleryIds) && o.galleryIds.length === 0, JSON.stringify(o.galleryIds));
  ok('tier card keeps a folder it names itself', JSON.stringify(G.uploadOptions({ subscription: true, galleryIds: ['96682504'] }, s).galleryIds) === '["96682504"]');
  const free = G.uploadOptions({}, s);
  ok('free card unchanged: no tier, default folders', free.tierIds.length === 0 && JSON.stringify(free.galleryIds) === '["84304319"]' && free.subscription === false);
}
{
  const { G, s } = growthWith({ core: { enabled: true, tierId: '' }, tierCache });
  ok('no tier picked → refuses', throws(() => G.uploadOptions({ subscription: true }, s), /pick the tier/));
}
{
  const { G, s } = growthWith({ core: { enabled: true, tierId: '999', tierName: 'Gone' }, tierCache });
  ok('tier not in DeviantArt list → refuses (fail closed)', throws(() => G.uploadOptions({ subscription: true }, s), /not in the tier list/));
}
{
  const { G, s } = growthWith({ core: { enabled: true, tierId: '1407811399' }, tierCache: [{ id: '1407811399', name: 'Supporter', published: false }] });
  ok('unpublished tier → refuses', throws(() => G.uploadOptions({ subscription: true }, s), /not published/));
}

{
  const { G, s } = growthWith({ core: { enabled: true, premiumGalleryId: '5', premiumGalleryName: 'Paid' }, galleryCache: [{ id: '5', name: 'Paid', premium: true }, { id: '6', name: 'Free', premium: false }] });
  const o = G.uploadOptions({ premium: true }, s);
  ok('premium card → the premium folder, AI label, Mature follows the card', JSON.stringify(o.galleryIds) === '["5"]' && o.isAiGenerated === true && o.isMature === false);
  ok('premium card with mature:true keeps it', G.uploadOptions({ premium: true, mature: true }, s).isMature === true);
  s.da.core.premiumGalleryId = '6';
  ok('a normal gallery picked as premium → refuses (fail closed)', throws(() => G.uploadOptions({ premium: true }, s), /not a Premium Gallery/));
}

console.log('\n[growth.posting strategy]');
{
  const { G } = growthWith({});
  const p = (t) => JSON.stringify(G.partOf(t));
  ok('partOf: "Lighthouse Keeper. Part 3.5"', p('Lighthouse Keeper. Part 3.5') === '{"base":"lighthouse keeper","part":3.5}', p('Lighthouse Keeper. Part 3.5'));
  ok('partOf: bracket note keeps the story', (G.partOf('Lighthouse Keeper. Part 5 (Teaser)') || {}).base === 'lighthouse keeper');
  ok('partOf: "— Part 2"', (G.partOf('Forest Path — Part 2') || {}).part === 2);
  ok('partOf: a sentence that mentions a page is not a part', G.partOf('I came for page 52!') === null);
  ok('partOf: no number → null', G.partOf('Stone Wall Study') === null);
  const H = 36e5, NOW = Date.UTC(2026, 10, 10, 12);
  const dev = (id, title, hoursAgo, v24) => ({ deviationId: id, title, publishedAt: NOW - hoursAgo * H, stats: { views: v24 }, history: [{ at: NOW - hoursAgo * H + 24 * H, views: v24 }, { at: NOW - hoursAgo * H + 12 * H, views: Math.round(v24 / 2) }] });
  const devs = [
    ...Array.from({ length: 6 }, (_, i) => dev(`s${i}`, `Single ${i}`, 80 - i, 1000 + i * 10)),
    dev('c1', 'Harbor Tales. Part 1', 50, 5000), dev('c2', 'Harbor Tales. Part 2', 49, 4800), dev('c3', 'Harbor Tales. Part 3', 48, 4000),
  ];
  const plan = G.postingPlan({ deviations: devs, library: [], now: NOW });
  ok('plan splits comics from singles', plan.byKind.comic && plan.byKind.single && plan.byKind.comic.posts === 3 && plan.byKind.single.posts === 6, JSON.stringify(plan.byKind));
  ok('plan flags parts posted too close together', plan.crowdedParts.length === 2 && plan.crowdedParts.every((c) => c.base === 'harbor tales'));
  const paid = G.postingPlan({ deviations: devs, library: [{ da: { deviationId: 'c3' }, subscription: true }], now: NOW });
  ok('paid pages are left out of the plan', paid.byKind.comic.posts === 2);
  const notes = G.partSpacingNotes([{ metadata: { title: 'Harbor Tales. Part 4' } }], devs, { now: NOW - 40 * H + 2 * H, partGapHours: 20 });
  ok('spacing note for a part right after the previous one', notes.length === 1 && /Part 4/.test(notes[0]));
  ok('a paid card gets no spacing note', G.partSpacingNotes([{ subscription: true, metadata: { title: 'Harbor Tales. Part 4' } }], devs, { now: NOW - 38 * H }).length === 0);
  const src = { id: 'a', path: 'x.png', fname: 'x.png', metadata: { title: 'T', tags: ['a'] }, video: { fname: 'v.mp4' }, status: 'approved' };
  const copy = G.sellCardFrom(src);
  copy.video.fname = 'changed'; copy.metadata.tags.push('b');
  ok('sellCardFrom: a deep copy (editing it leaves the source alone)', src.video.fname === 'v.mp4' && src.metadata.tags.length === 1 && copy.sellOf === 'a' && copy.premium === true && copy.status === 'review');
}

// ---------------------------------------------------------------- daweb.js
console.log('\n[daweb]');
const calls = [];
let inTiers = ['1407811399'];
const fakeFetch = async (url, init = {}) => {
  calls.push({ url, body: init.body });
  const json = (o) => ({ status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (url.endsWith('/studio')) return { status: 200, text: async () => '<input name="validate_token" value="TOKEN123">' };
  if (url.includes('/tier/user/list')) return json({ results: [
    { deviationId: 1407811399, type: 'tier', title: 'Supporter', isPublished: true, url: 'u' },
    { deviationId: 5, type: 'art', title: 'not a tier' },
  ] });
  if (url.includes('/studio/pages/drafts')) return json({ rootFolder: { owner: { username: 'penekark' }, size: 0 } });
  if (url.includes('/submit/upload/deviation')) return json({ status: 'success', privateId: 777, deviationId: 888 });
  if (url.includes('/submit/init')) return json({ galleries: [{ folderId: 84304319, name: 'Featured', specialType: 'featured' }], deviation: { url: 'stash' }, inTiers: inTiers.map((id) => ({ deviationId: Number(id) })) });
  if (url.includes('/deviation/update')) return json({ status: 'success', deviationId: 888 });
  if (url.includes('/deviation/publish')) return json({ deviation: { url: 'https://www.deviantart.com/penekark/art/x-888' } });
  return json({});
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') return { session: { fromPartition: () => ({ fetch: fakeFetch, getUserAgent: () => 'test' }) } };
  return origLoad.call(this, req, ...rest);
};
const { DAWebClient, tierIdsOf } = require(path.join(root, 'src/main/daweb.js'));
Module._load = origLoad;

ok('tierIdsOf reads numbers, strings and objects', JSON.stringify(tierIdsOf([1, '2', { deviationId: 3 }, { value: 4 }, null])) === '["1","2","3","4"]');
const tmp = path.join(os.tmpdir(), `da-tier-${process.pid}.png`);
fs.writeFileSync(tmp, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
try {
  const c = new DAWebClient();
  const t = await c.tiers();
  ok('tiers() lists only type "tier"', t.ok && t.tiers.length === 1 && t.tiers[0].id === '1407811399' && t.tiers[0].name === 'Supporter', JSON.stringify(t));

  calls.length = 0;
  const r = await c.uploadDraft({ filePath: tmp, title: 'Part 7', description: 'd', tags: ['art'], isMature: true, tierIds: ['1407811399'], publish: true });
  const upd = calls.find((x) => x.url.includes('/deviation/update'));
  const body = upd ? JSON.parse(upd.body) : {};
  ok('update payload: tierids = [1407811399] (numbers)', JSON.stringify(body.tierids) === '[1407811399]', JSON.stringify(body.tierids));
  ok('update payload: no Featured fallback for a tier post', Array.isArray(body.galleryids) && body.galleryids.length === 0, JSON.stringify(body.galleryids));
  ok('update payload: Mature', body.is_mature === true);
  ok('confirmed in tier → submitted', r.ok && r.published === true, JSON.stringify(r));

  inTiers = [];
  calls.length = 0;
  const r2 = await c.uploadDraft({ filePath: tmp, title: 'Part 7', description: 'd', tags: [], isMature: true, tierIds: ['1407811399'], publish: true });
  ok('NOT in tier → never presses Submit', r2.ok && r2.published === false && /NOT submitted/.test(r2.publishError || '') && !calls.some((x) => x.url.includes('/deviation/publish')), JSON.stringify(r2));

  calls.length = 0;
  await c.uploadDraft({ filePath: tmp, title: 'Free', description: 'd', tags: [], publish: false });
  const upd3 = JSON.parse(calls.find((x) => x.url.includes('/deviation/update')).body);
  ok('free post: tierids stays "_empty" and Featured is used', upd3.tierids === '_empty' && JSON.stringify(upd3.galleryids) === '["84304319"]', JSON.stringify([upd3.tierids, upd3.galleryids]));
} finally { fs.rmSync(tmp, { force: true }); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
