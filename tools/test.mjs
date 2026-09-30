/**
 * tools/test.mjs: offline unit tests for the app.  Run: npm test
 *
 * No Electron, no network, no GPU, no AI model. Each test loads the REAL module file
 * from src/renderer into an isolated Node VM (the same way the browser would run it,
 * as a plain script attached to `window`) and checks its behaviour directly.
 *
 * Covered:
 *   - promptstyle.js  : the quality tail every prompt must end with
 *   - state.js (U)    : JSON is recovered from chatty / slightly broken LLM answers
 *   - titles.js       : near-duplicate titles are detected, different ones are not
 *   - comiclayout.js  : panel geometry and text wrapping for comic pages
 *   - triage.js       : contact-sheet layout and parsing of the AI's pick
 */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
// Note: values created inside the VM have their own Array/Object prototypes, so
// structured results are compared as JSON rather than with deepEqual.

const root = new URL('../src/renderer/', import.meta.url);

/** Load renderer modules (in order) into one fresh sandbox and return its `window`. */
function load(...files) {
  const sandbox = { console, setTimeout, clearTimeout, structuredClone, URL, TextEncoder, TextDecoder };
  sandbox.window = sandbox;
  sandbox.window.ala = {};          // the preload bridge; unused by the pure functions tested here
  vm.createContext(sandbox);
  for (const f of files) vm.runInContext(fs.readFileSync(new URL(f, root), 'utf8'), sandbox, { filename: f });
  return sandbox;
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('promptstyle.js');
{
  const w = load('state.js', 'promptstyle.js');
  const prof = { enough: false, tail: [] };   // no learned style yet: only the built-in quality tail
  test('appends the missing quality guards to a prompt', () => {
    const out = w.PromptStyle.enforceTail('a lighthouse keeper on a stormy cliff, lantern glow', prof);
    assert.ok(out.endsWith('no extra fingers, no extra limbs'), out);
  });
  test('does not repeat guards that are already there', () => {
    const src = 'a fox spirit in a forest, no extra fingers, no extra limbs';
    assert.equal(w.PromptStyle.enforceTail(src, prof), src);
  });
  test('leaves an empty prompt empty', () => assert.equal(w.PromptStyle.enforceTail('  ', prof), ''));
}

console.log('state.js');
{
  const { U } = load('state.js');
  test('extracts JSON wrapped in prose and code fences', () => {
    const v = U.extractJson('Sure! Here you go:\n```json\n{"title": "Lantern Walk", "tags": ["night"]}\n```\nEnjoy.');
    assert.equal(v.title, 'Lantern Walk');
  });
  test('finds every JSON value in a reply, in order', () => {
    const all = U.jsonCandidates('first {"a":1} then [2,3]');
    assert.equal(JSON.stringify(all.map((c) => c.value)), '[{"a":1},[2,3]]');
  });
  test('recognises an image prompt vs. a sentence about one', () => {
    assert.equal(U.looksLikePrompt('a lighthouse keeper on a stormy cliff, rain-wet coat, lantern glow, wide shot, painted anime'), true);
    assert.equal(U.looksLikePrompt('I should write the prompt about the lighthouse now, however the artist wants JSON'), false);
  });
  test('strips a medium-naming opener from a prompt', () => {
    const out = U.housePrompt('Anime illustration of a lighthouse keeper on a stormy cliff at night, lantern glow');
    assert.ok(!/^anime illustration/i.test(out), out);
  });
}

console.log('titles.js');
{
  const w = load('titles.js');
  const sim = (a, b) => w.Titles.similarity(a, b);
  test('identical titles score 1', () => assert.equal(sim('Moonlit Harbour', 'Moonlit Harbour'), 1));
  test('near-duplicates score high ("Moonlight" vs "Moonlit")', () => assert.ok(sim('Moonlight Harbour', 'Moonlit Harbour') >= 0.5));
  test('unrelated titles score low', () => assert.ok(sim('Moonlit Harbour', 'The Clockmaker\'s Cat') < 0.3));
}

console.log('comiclayout.js');
{
  const { ComicLayout: L } = load('comiclayout.js');
  test('auto layout creates one rect per panel', () => {
    for (const n of [1, 2, 3, 4, 5, 6]) assert.equal(L.layoutFor('auto', n).rects.length, n);
  });
  test('panel boxes stay inside the page', () => {
    const geom = { width: 1400, height: 1800, margin: 40, gutter: 20 };
    for (const b of L.panelBoxes(L.layoutFor('auto', 4), geom)) {
      assert.ok(b.x >= 40 && b.y >= 40 && b.x + b.w <= 1360 && b.y + b.h <= 1760, JSON.stringify(b));
    }
  });
  test('word wrap never exceeds the width', () => {
    const measure = (s) => s.length * 10;
    const lines = L.wrapText('the quick brown fox jumps over the lazy dog again and again', 120, measure);
    assert.ok(lines.length > 1 && lines.every((l) => measure(l) <= 120), JSON.stringify(lines));
  });
}

console.log('triage.js');
{
  const w = load('state.js', 'triage.js');
  test('contact sheet grid fits the tile count', () => {
    for (const n of [1, 2, 3, 4, 6, 9]) {
      const s = w.Triage.sheetLayout(n);
      assert.ok(s.cols * s.rows >= n);
    }
  });
  test('parses the AI pick and ignores out-of-range tiles', () => {
    const r = w.Triage.parsePick('{"tiles":[{"n":1,"verdict":"clean"},{"n":9,"verdict":"clean"}],"best":1,"keep":[1,9]}', 4);
    assert.equal(r.best, 1);
    assert.equal(JSON.stringify(r.keep), '[1]');
    assert.equal(r.tiles[1].verdict, 'clean');
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
