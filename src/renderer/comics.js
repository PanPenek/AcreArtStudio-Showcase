/**
 * comics.js: the comic engine: one button from a premise to a lettered page.
 *
 * A comic is planned by a writer model (storyboard: cast, places, panels with shot,
 * action and lines), then drawn on the normal queue through ComfyUI:
 *   cast sheets:  one clean full-body reference per character, drawn once (from his
 *                 pictures when he gave some) and attached to every panel, so the
 *                 character stays the same person from panel to panel;
 *   plates:       an empty background per place used in two or more panels;
 *   panels:       several takes each; a vision model scores the takes on a contact
 *                 sheet (identity, beat, clean render, place) and keeps the best;
 *   lettering:    the captions and lines are rewritten from what was actually drawn,
 *                 and balloons are placed away from faces.
 * Panels are project assets, not artworks: only the composed page becomes a card.
 */
(function () {
  const VERSION = 2;
  const SHOTS = ['wide', 'medium', 'close', 'extreme-close'];
  const KINDS = ['speech', 'thought', 'shout', 'whisper', 'float'];
  const MAX_CAST = 4;
  const MAX_PER_PANEL = 2;
  const MAX_CONTINUE_CHAIN = 3;
  const MAX_SEQUENCE_CHAIN = 7;
  const MAX_LOCATIONS = 5;
  const CLOSE_SHOTS = new Set(['close', 'extreme-close']);
  const FLOAT_COLORS = ['#1f8fb3', '#8b3fd1', '#e0287a', '#e36414', '#2b9348'];

  const log = (m, k) => State.addLog(`Comic: ${m}`, k);
  const clampN = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  const str = (v, max = 400) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  const norm = (s) => String(s || '').trim().toLowerCase();

  const T = {
    storyboard({ premise, theme, tone, panels, format, cast, sequence = false }) {
      const known = (cast || []).filter((c) => c.look || c.name);
      const chain = sequence ? MAX_SEQUENCE_CHAIN : MAX_CONTINUE_CHAIN;
      return `You are the writer and storyboard artist of a short ${format === 'webtoon' ? 'vertical-scroll webtoon' : format === 'story' ? 'illustrated story (one picture plus prose)' : 'comic page'} for an anime-art audience. Plan it so that every panel can be drawn as ONE picture and the words make sense next to the pictures.

Premise (follow any panel-by-panel plan and character looks it gives, exactly): """${String(premise || '').slice(0, 6000)}"""
${theme ? `Theme: ${theme}\n` : ''}${tone ? `Tone: ${tone}\n` : ''}Panels: ${panels}
${known.length ? `Characters already fixed (keep these names, looks and outfits exactly):\n${known.map((c) => `- ${c.name || '(unnamed)'}: ${c.look || ''}${c.outfit ? ` | outfit: ${c.outfit}` : ''}`).join('\n')}\n` : ''}
Rules:
- One complete mini-story with a setup, a turn and a payoff. Every panel moves it forward; no two panels show the same moment. The last panel lands the payoff.
- Each panel is a single moment with at most ${MAX_PER_PANEL} characters visible. A character appears ONCE in a panel — never two moments of the same person in one picture; if a beat has two moments, show one of them.
- "shot": "wide" (establishing: the place and whole bodies), "medium" (waist up), "close" (face and shoulders) or "extreme-close". Open wide, vary the rest.
- "mode": "continue" when the panel is the SAME place and camera as the previous panel and only the characters' pose, expression or body changes (reactions, a change in progress); otherwise "new". Never more than ${chain} "continue" panels in a row. Panel 1 is always "new".
${sequence ? `- This is a CHANGE SEQUENCE: panel 1 shows the character before the change; EVERY later panel is "continue" (same place, camera and framing) and shows the NEXT stage of the change. In "action", say exactly what has changed so far compared with the previous panel (outfit, hair, props, what is around them). The last panel shows the finished change with "form": "after". Their words react to each stage.\n` : ''}
- "action": what the picture shows, 25-60 words of plain visual description — who is where, pose, expression, what they are doing, what is around them. Use the cast names. No story-telling words ("then", "realises", "suddenly"), no text, signs or speech bubbles in the scene. For a "continue" panel, describe what is different NOW compared with the previous panel.
- "who": the cast names visible in the panel, each with "form": "before", or "after" for a character shown in their changed form.
- "caption": narration, max 90 characters, or "". "lines": 0-2 spoken lines, each {"speaker": a cast name VISIBLE in this panel, "text": max 80 characters, "kind": "speech" | "thought" | "shout" | "whisper"}. A line may only mention what the panel shows. "sfx": one sound-effect word or "".
- "cast": 1-${MAX_CAST} characters. "look": 20-40 words, physical only — exact hair colour, length and style, eye colour, body type, skin tone, and an age impression. "outfit": 10-25 words with exact colours and materials. "after": the changed look and outfit if the premise changes how this character looks, else "".
- "style": one phrase for the drawing style, e.g. "clean anime comic illustration, crisp dark lineart, flat cel shading, bright readable colours".
- "locations": every distinct place in the comic (1-${MAX_LOCATIONS}): {"name": a short label, "look": 15-35 words — the place, time of day, light, key objects and colours}. A flashback, another room or the inside of a vehicle is its own location. Every panel names its "location" (one of those names) and only shows that place.
${format === 'story' ? '- "story": 140-240 words of prose telling the whole thing, past tense, third person, sensory; it sits beside the picture and must stand alone.\n' : ''}
Respond ONLY with JSON:
{"title": "max 40 characters", "logline": "one sentence", "style": "...",
 "locations": [{"name": "...", "look": "..."}],
 "cast": [{"name": "...", "look": "...", "outfit": "...", "after": ""}],
 "panels": [{"shot": "wide", "mode": "new", "location": "...", "who": [{"name": "...", "form": "before"}], "action": "...", "caption": "", "lines": [{"speaker": "...", "text": "...", "kind": "speech"}], "sfx": ""}]${format === 'story' ? ', "story": "..."' : ''}}`;
    },

    describe() {
      return `This picture shows a character the artist wants to star in a comic. Describe them so the same character can be drawn again.

Respond ONLY with JSON:
{"name": "the character's name if it is obvious (a known franchise character), else \\"\\"", "look": "20-40 words, physical only: exact hair colour, length and style, eye colour, body type, skin tone, age impression", "outfit": "10-25 words: every visible garment with colours and materials"}`;
    },

    pick({ n, hasRef, hasPlace = false, action, cast, place = '' }) {
      return [
        `This picture is a contact sheet. ${hasRef ? 'The tile labelled R is the CHARACTER REFERENCE sheet. ' : ''}${hasPlace ? 'The tile labelled P is the PLACE reference (the empty background). ' : ''}The tiles numbered 1-${n} are candidate renders of ONE comic panel.`,
        `The panel must show: ${str(action, 500)}`,
        cast ? `Characters: ${cast}` : '',
        place ? `Place: ${str(place, 300)}` : '',
        'Score every numbered tile from 1 to 10 on:',
        '- identity: the same person as the reference / description — face, hair colour and style, eye colour, body, outfit;',
        '- beat: it shows what the panel must show;',
        '- render: clean anatomy — count fingers, no extra or fused limbs, intact faces, no melted shapes, no garbled lettering;',
        place ? '- place: the background is this place and nothing out of it (no ruins on an airfield, no city in a cockpit);' : '',
        'and "once": false when any character is drawn more than once in the same tile (two copies of one person) or the tile is split into several frames, else true.',
        '',
        `Respond with JSON only: {"tiles": [{"n": 1, "identity": 7, "beat": 8, "render": 6${place ? ', "place": 7' : ''}, "once": true, "issue": "worst problem in under 8 words, or none"}], "best": <1-${n}>}`,
      ].filter(Boolean).join('\n');
    },

    sheetCheck(name) {
      return `This picture is a contact sheet. Tile R is a REFERENCE picture of the character ${name}. Tile 1 is a character sheet drawn from it.
Score tile 1 from 1 to 10 on identity: the same character as R — face, eye colour, hair colour and style, skin, body type, outfit and its colours. Ignore the art style, pose and background.

Respond with JSON only: {"identity": 7, "issue": "the biggest difference in under 10 words, or none"}`;
    },

    facts(names, looks = []) {
      return `This is one finished comic panel. Speech balloons will be lettered on top of it, so I need to know where the faces are and where there is free room.
${names.length ? `Characters who may be in it: ${names.join(', ')}.\n` : ''}${looks.length ? `Tell them apart by their looks:\n${looks.map((l) => `- ${l}`).join('\n')}\nName each person exactly as above; a person who matches none of them is "other".\n` : ''}Coordinates are fractions of the picture: x and y from the top-left corner, w and h as width and height, all between 0 and 1.

Respond ONLY with JSON:
{"people": [{"name": "one of the names above, or \\"other\\"", "head": [x, y, w, h], "body": [x, y, w, h]}], "empty": [[x, y, w, h]]}
"head" is a tight box around the head and hair. "body" is the rest of the visible body. "empty" lists up to 3 regions with no face, no hands and nothing important (sky, wall, floor, plain background), largest first.`;
    },

    letter({ premise, cast, panels }) {
      return `This picture is a comic page that has NOT been lettered yet. Its panels are numbered in reading order with a big number in each panel's top-left corner.

The draft script below was written BEFORE the pictures were drawn, so parts of it may not match them. Rewrite the words so they fit what each panel ACTUALLY shows, keeping the story.

Premise: """${String(premise || '').slice(0, 3000)}"""
Cast: ${cast || '(none)'}
Draft:
${panels.map((p) => `Panel ${p.n} (${p.shot}): ${p.action}${p.caption ? `\n  caption: ${p.caption}` : ''}${(p.lines || []).map((l) => `\n  ${l.speaker || '?'} (${l.kind}): ${l.text}`).join('')}${p.sfx ? `\n  sfx: ${p.sfx}` : ''}`).join('\n')}

Rules:
- A speaker must be visible in their panel; otherwise use a caption. Never mention anything the picture does not show.
- Short and punchy: at most 2 balloons per panel, each at most 80 characters; captions at most 90. Most panels get a line; the last panel lands the payoff.
- "kind" is "speech", "thought", "shout" or "whisper". "sfx" is one sound-effect word only when the panel shows a sound-making action, else "".

Respond ONLY with JSON:
{"title": "a short punchy title, max 40 characters", "panels": [{"n": 1, "caption": "", "lines": [{"speaker": "...", "text": "...", "kind": "speech"}], "sfx": ""}]}`;
    },
  };

  const SHOT_TEXT = {
    wide: 'Wide establishing shot showing the whole place and the characters\' full bodies',
    medium: 'Medium shot, framed from the waist up',
    close: 'Close-up on the face and shoulders',
    'extreme-close': 'Extreme close-up',
  };
  const LIGHT = 'Bright, even, readable lighting; clean comic panel art.';

  const memberById = (project, id) => (project.cast || []).find((c) => c.id === id) || null;
  const lookAt = (m, form) => (form === 'after' && m.after ? m.after : [m.look, m.outfit ? `wearing ${m.outfit}` : ''].filter(Boolean).join(', '));
  const sheetOf = (m, form) => (form === 'after' && m.after ? m.afterSheet : m.sheet);
  const DEFAULT_STYLE = 'clean anime comic illustration, crisp dark lineart, flat cel shading, bright readable colours';
  const refsOf = (m) => (Array.isArray(m && m.refs) ? m.refs.filter((r) => r && r.fname) : []);
  const locationById = (project, id) => (project.locations || []).find((l) => l.id === id) || null;
  const locationOf = (project, panel) => locationById(project, panel && panel.locationId);
  const endStop = (t) => (/[.!?]$/.test(t) ? t : `${t}.`);

  function platesWanted(project) {
    if (project.plates === false || project.sequence) return [];
    const uses = new Map();
    for (const p of project.panels || []) {
      if (!p.locationId || p.mode === 'continue' || CLOSE_SHOTS.has(p.shot)) continue;
      uses.set(p.locationId, (uses.get(p.locationId) || 0) + 1);
    }
    return (project.locations || []).filter((l) => (uses.get(l.id) || 0) >= 2);
  }

  function sheetJob(project, m, form = 'before') {
    const style = project.artStyle || DEFAULT_STYLE;
    if (form === 'after' && m.after && m.sheet) {
      return {
        prompt: `Edit <image1>. Change the character into this: ${m.after}. Keep the same full-body standing pose facing the viewer, the same framing, the same plain light-grey background and the same art style as <image1>.`,
        refs: [{ fname: m.sheet.fname }], edit: true,
      };
    }
    const refs = refsOf(m).slice(0, 2);
    const body = 'Standing upright in a relaxed neutral pose facing the viewer, the whole body visible from head to feet. Plain flat light-grey background with nothing else in the picture.';
    if (refs.length) {
      const which = refs.length > 1 ? '<image1> and <image2>' : '<image1>';
      const look = lookAt(m, 'before');
      return {
        prompt: `${style}. Character reference sheet of ${m.name}, redrawn from ${which}: the same face, eye colour, hair, skin, body and outfit as the character in ${refs.length > 1 ? 'those pictures' : 'that picture'}${look ? ` (${look})` : ''}. One single full-body view of ${m.name} alone. ${body} ${LIGHT}`,
        refs: refs.map((r) => ({ fname: r.fname })), edit: false,
      };
    }
    return { prompt: `${style}. Character reference of ${m.name}, one single full-body view: ${lookAt(m, 'before')}. ${body} ${LIGHT}`, refs: [], edit: false };
  }
  const sheetPrompt = (project, m, form = 'before') => sheetJob(project, m, form).prompt;

  function platePrompt(project, loc) {
    const style = project.artStyle || DEFAULT_STYLE;
    return `${style}. ${endStop(str(loc.look || loc.name, 400))} Background plate of ${loc.name}: wide establishing view of the place only, with no people, no characters and no animals in it. ${LIGHT}`;
  }

  function panelPrompt(project, panel) {
    const idx = project.panels.indexOf(panel);
    const prev = idx > 0 ? project.panels[idx - 1] : null;
    const visible = (panel.who || []).map((w) => ({ ...w, m: memberById(project, w.castId) })).filter((w) => w.m);
    if (panel.mode === 'continue' && prev && prev.chosen) {
      const prevForms = new Map((prev.who || []).map((w) => [w.castId, w.form]));
      const changed = visible.filter((w) => prevForms.has(w.castId) && prevForms.get(w.castId) !== w.form)
        .map((w) => `${w.m.name} now looks like this: ${lookAt(w.m, w.form)}.`);
      const shot = prev.shot !== panel.shot && SHOT_TEXT[panel.shot] ? ` Reframe it as a ${String(SHOT_TEXT[panel.shot]).toLowerCase()}.` : '';
      const refs = [{ castId: null, form: null, fname: prev.chosen }];
      const target = [];
      for (const w of visible) {
        if (w.form !== 'after' || !w.m.afterSheet || !w.m.afterSheet.fname || refs.length > MAX_PER_PANEL) continue;
        refs.push({ castId: w.m.id, form: 'after', fname: w.m.afterSheet.fname });
        target.push(`${w.m.name} now looks exactly like the character in <image${refs.length}> — that face, hair, body and outfit — in the pose and place of <image1>.`);
      }
      return {
        edit: true,
        refs,
        prompt: `Edit <image1>. Keep the same place, lighting, camera, art style and characters as <image1> — the same faces, hair and outfits unless stated. Now: ${endStop(str(panel.action, 700))} ${(target.length ? target : changed).join(' ')}${shot}`.replace(/\s+/g, ' ').trim(),
      };
    }
    const refs = [];
    const intro = [];
    for (const w of visible.slice(0, MAX_PER_PANEL)) {
      const sheet = sheetOf(w.m, w.form);
      if (sheet && sheet.fname) {
        refs.push({ castId: w.m.id, form: w.form, fname: sheet.fname });
        intro.push(`${w.m.name} is the character shown in <image${refs.length}>: ${lookAt(w.m, w.form)}.`);
      } else {
        intro.push(`${w.m.name}: ${lookAt(w.m, w.form)}.`);
      }
    }
    const people = refs.length;
    const loc = locationOf(project, panel);
    const place = loc ? loc.look || loc.name : project.setting;
    let plateLine = '';
    if (loc && loc.plate && loc.plate.fname && !CLOSE_SHOTS.has(panel.shot) && project.plates !== false) {
      refs.push({ castId: null, form: null, fname: loc.plate.fname, place: true });
      plateLine = `<image${refs.length}> shows this place (${loc.name}) empty: draw the background to match it — the same architecture, objects, colours and light — seen from this panel's own camera.`;
    }
    const style = project.artStyle || DEFAULT_STYLE;
    const names = visible.map((w) => w.m.name);
    const parts = [
      `${style}.`,
      `${SHOT_TEXT[panel.shot] || SHOT_TEXT.medium}.`,
      ...intro,
      people ? `Use ${people > 1 ? `<image1> and <image2>` : '<image1>'} only for ${people > 1 ? 'the characters\'' : 'the character\'s'} identity and outfit; draw this scene's own pose and expression.` : '',
      endStop(str(panel.action, 700)),
      names.length ? `${names.length > 1 ? `${names.join(' and ')} each appear` : `${names[0]} appears`} only once in the picture.` : '',
      place && panel.shot !== 'extreme-close' ? `Setting: ${endStop(str(place, 300))}` : '',
      plateLine,
      LIGHT,
    ];
    return { edit: false, refs, prompt: parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() };
  }

  function lastJson(text, ok) {
    const cands = (window.U && U.jsonCandidates) ? U.jsonCandidates(String(text || '')) : [];
    let found = null;
    for (const c of cands) if (c.value && typeof c.value === 'object' && ok(c.value)) found = c.value;
    if (!found) { try { const v = U.extractJson(text); if (v && ok(v)) found = v; } catch {  } }
    return found;
  }

  function normalizeStoryboard(raw, { panels: want, existingCast = [], sequence = false } = {}) {
    const cast = [];
    const byName = new Map();
    const claimed = new Set();
    for (const c of existingCast) { cast.push(c); byName.set(norm(c.name), c); }
    for (const c of (Array.isArray(raw.cast) ? raw.cast : []).slice(0, MAX_CAST + existingCast.length)) {
      const name = str(c && c.name, 28) || `Character ${cast.length + 1}`;
      let hit = byName.get(norm(name)) || null;
      if (!hit && existingCast.length === 1 && !existingCast[0].named && !claimed.has(existingCast[0].id)) hit = existingCast[0];
      if (hit) {
        claimed.add(hit.id);
        if (!hit.named && name) { hit.name = name; hit.named = true; byName.set(norm(name), hit); }
        if (!hit.after && c.after) hit.after = str(c.after, 400);
        if (!hit.look && c.look) hit.look = str(c.look, 400);
        if (!hit.outfit && c.outfit) hit.outfit = str(c.outfit, 300);
        continue;
      }
      if (cast.length >= MAX_CAST) continue;
      const m = blankMember({ name, look: str(c.look, 400), outfit: str(c.outfit, 300), after: str(c.after, 400) });
      cast.push(m);
      byName.set(norm(name), m);
    }
    const findMember = (name) => {
      const n = norm(name);
      if (!n) return null;
      return byName.get(n) || cast.find((m) => norm(m.name).includes(n) || n.includes(norm(m.name))) || null;
    };
    const locations = [];
    for (const l of (Array.isArray(raw.locations) ? raw.locations : []).slice(0, MAX_LOCATIONS)) {
      const name = str(l && (l.name || l.label), 40);
      const look = str(l && (l.look || l.description), 400);
      if (!name && !look) continue;
      if (locations.some((x) => norm(x.name) === norm(name || look))) continue;
      locations.push(blankLocation({ name: name || look.split(/[,.]/)[0].slice(0, 40), look: look || name }));
    }
    if (!locations.length && str(raw.setting)) locations.push(blankLocation({ name: str(raw.setting, 40).split(/[,.]/)[0], look: str(raw.setting, 400) }));
    const findLocation = (name) => {
      const n = norm(name);
      if (!n) return null;
      return locations.find((l) => norm(l.name) === n) || locations.find((l) => norm(l.name).includes(n) || n.includes(norm(l.name))) || null;
    };
    const maxChain = sequence ? MAX_SEQUENCE_CHAIN : MAX_CONTINUE_CHAIN;
    const list = (Array.isArray(raw.panels) ? raw.panels : []).slice(0, Math.max(1, want || 12));
    let chain = 0;
    let lastLoc = null;
    const panels = list.map((p, i) => {
      const who = [];
      for (const w of Array.isArray(p && p.who) ? p.who : []) {
        const m = findMember(typeof w === 'string' ? w : w && w.name);
        if (!m || who.some((x) => x.castId === m.id)) continue;
        const form = (w && w.form === 'after' && m.after) ? 'after' : 'before';
        who.push({ castId: m.id, form });
        if (who.length >= MAX_PER_PANEL) break;
      }
      let mode = i > 0 && (sequence || (p && p.mode === 'continue')) ? 'continue' : 'new';
      chain = mode === 'continue' ? chain + 1 : 0;
      if (chain > maxChain) { mode = 'new'; chain = 0; }
      const loc = mode === 'continue' && lastLoc ? lastLoc : (findLocation(p && (p.location || p.place)) || lastLoc || locations[0] || null);
      lastLoc = loc;
      const lines = (Array.isArray(p && p.lines) ? p.lines : (p && p.dialogue) || []).slice(0, 2).map((l) => {
        const sp = findMember(l && l.speaker);
        return blankLine({
          speaker: sp ? sp.name : str(l && l.speaker, 28),
          text: str(l && l.text, 140),
          kind: KINDS.includes(l && l.kind) ? l.kind : 'speech',
        });
      }).filter((l) => l.text);
      return {
        ...blankPanel(i),
        shot: SHOTS.includes(p && p.shot) ? p.shot : (i === 0 ? 'wide' : 'medium'),
        mode, who, locationId: loc ? loc.id : null,
        action: str((p && (p.action || p.prompt || p.beat)) || '', 700),
        caption: str(p && p.caption, 160),
        lines,
        sfx: str(p && p.sfx, 24),
      };
    });
    const usedLoc = new Set(panels.map((p) => p.locationId).filter(Boolean));
    return {
      title: str(raw.title, 60), logline: str(raw.logline, 240),
      artStyle: str(raw.style, 240), setting: str(raw.setting, 300) || (locations[0] ? locations[0].look : ''),
      story: String(raw.story || '').trim(), cast, panels, locations: locations.filter((l) => usedLoc.has(l.id)),
    };
  }

  function parsePick(text, n) {
    const obj = lastJson(text, (v) => Array.isArray(v.tiles) || v.best != null);
    if (!obj) return null;
    const tiles = {};
    for (const t of Array.isArray(obj.tiles) ? obj.tiles : []) {
      const k = Number(t && (t.n ?? t.tile));
      if (!Number.isInteger(k) || k < 1 || k > n) continue;
      const g = (v) => clampN(v, 0, 10, 0);
      const row = { identity: g(t.identity), beat: g(t.beat), render: g(t.render), issue: str(t.issue, 100).replace(/^none\.?$/i, '') };
      if (t.place != null && Number.isFinite(Number(t.place))) row.place = g(t.place);
      row.once = !(t.once === false || /^false$/i.test(String(t.once)));
      row.score = row.identity * 2 + row.beat + row.render + (row.place != null ? row.place : 0) - (row.once ? 0 : 15);
      if (!row.once && !row.issue) row.issue = 'a character is drawn twice';
      tiles[k] = row;
    }
    let best = null;
    for (const [k, row] of Object.entries(tiles)) if (!best || row.score > tiles[best].score) best = Number(k);
    const said = Number(obj.best);
    if (!best && Number.isInteger(said) && said >= 1 && said <= n) best = said;
    return best ? { best, tiles } : null;
  }

  function parseFacts(text) {
    const obj = lastJson(text, (v) => Array.isArray(v.people) || Array.isArray(v.empty));
    if (!obj) return null;
    const box = (b) => {
      if (!Array.isArray(b) || b.length < 4) return null;
      let [x, y, w, h] = b.slice(0, 4).map(Number);
      if (![x, y, w, h].every(Number.isFinite)) return null;
      if ([x, y, w, h].some((v) => v > 1.5)) { x /= 100; y /= 100; w /= 100; h /= 100; }
      if (w > x && h > y && x + w > 1.02) { w -= x; h -= y; }
      x = Math.max(0, Math.min(1, x)); y = Math.max(0, Math.min(1, y));
      w = Math.max(0, Math.min(1 - x, w)); h = Math.max(0, Math.min(1 - y, h));
      return w > 0.01 && h > 0.01 ? [x, y, w, h].map((v) => Math.round(v * 1000) / 1000) : null;
    };
    const people = (Array.isArray(obj.people) ? obj.people : []).slice(0, 4).map((p) => ({
      name: str(p && p.name, 28), head: box(p && p.head), body: box(p && p.body),
    })).filter((p) => p.head);
    const empty = (Array.isArray(obj.empty) ? obj.empty : []).map(box).filter(Boolean).slice(0, 3);
    return { people, empty };
  }

  function parseSheetCheck(text) {
    const obj = lastJson(text, (v) => v.identity != null);
    if (!obj) return null;
    return { identity: clampN(obj.identity, 0, 10, 0), issue: str(obj.issue, 120).replace(/^none\.?$/i, '') };
  }

  function pickMissed(row) {
    return !!row && (row.identity < 5 || row.render < 4 || row.once === false || (row.place != null && row.place < 4));
  }

  function parseLetter(text, count) {
    const obj = lastJson(text, (v) => Array.isArray(v.panels));
    if (!obj) return null;
    const panels = {};
    for (const p of obj.panels) {
      const n = Number(p && p.n);
      if (!Number.isInteger(n) || n < 1 || n > count) continue;
      panels[n] = {
        caption: str(p.caption, 160),
        sfx: str(p.sfx, 24),
        lines: (Array.isArray(p.lines) ? p.lines : []).slice(0, 2).map((l) => ({
          speaker: str(l && l.speaker, 28), text: str(l && l.text, 140),
          kind: KINDS.includes(l && l.kind) ? l.kind : 'speech',
        })).filter((l) => l.text),
      };
    }
    return { title: str(obj.title, 60), panels };
  }

  const PRESETS = {
    western: {
      label: 'Western — white page, yellow captions',
      pageBg: '#ffffff', panelBorder: '#111111', panelBorderWidth: 4,
      captionBg: '#fff3b0', captionColor: '#111111', captionBorder: '#111111',
      bubbleBg: '#ffffff', bubbleColor: '#111111', bubbleBorder: '#111111', shoutBg: '#ffffff',
      titleColor: '#111111', storyBg: '#f4f1ea', storyColor: '#1c1917', sfxColor: '#ffd23f', sfxStroke: '#111111',
    },
    manga: {
      label: 'Manga — black & white, thin borders',
      pageBg: '#ffffff', panelBorder: '#000000', panelBorderWidth: 3,
      captionBg: '#ffffff', captionColor: '#000000', captionBorder: '#000000',
      bubbleBg: '#ffffff', bubbleColor: '#000000', bubbleBorder: '#000000', shoutBg: '#ffffff',
      titleColor: '#000000', storyBg: '#ffffff', storyColor: '#000000', sfxColor: '#ffffff', sfxStroke: '#000000',
    },
    dark: {
      label: 'Dark page',
      pageBg: '#0f0d0c', panelBorder: '#f5f5f4', panelBorderWidth: 3,
      captionBg: '#fff3b0', captionColor: '#111111', captionBorder: '#111111',
      bubbleBg: '#ffffff', bubbleColor: '#111111', bubbleBorder: '#111111', shoutBg: '#ffffff',
      titleColor: '#f5f5f4', storyBg: '#141210', storyColor: '#f5f5f4', sfxColor: '#ffd23f', sfxStroke: '#111111',
    },
  };
  const FONT = '"Comic Neue", "Comic Sans MS", "Segoe UI", sans-serif';
  const TITLE_FONT = 'Bangers, Impact, "Segoe UI", sans-serif';
  const HAND_FONT = '"Gochi Hand", "Comic Neue", "Comic Sans MS", sans-serif';

  function defaultLetter(preset = 'western') {
    return {
      preset, ...PRESETS[preset] || PRESETS.western,
      font: FONT, titleFont: TITLE_FONT, handFont: HAND_FONT,
      captionSize: 25, bubbleSize: 26, storySize: 26,
      showTitle: true, uppercase: true,
      mode: 'balloons', signature: '', pageNo: '',
    };
  }

  function defaultGeom(format) {
    if (format === 'story') return { width: 1800, height: 1100, margin: 46, gutter: 30 };
    if (format === 'webtoon') return { width: 1080, height: 0, margin: 40, gutter: 70 };
    return { width: 1400, height: 1900, margin: 40, gutter: 22 };
  }

  function blankMember(seed = {}) {
    return {
      id: U.uid(), name: seed.name || 'Character', named: !!seed.named,
      look: seed.look || '', outfit: seed.outfit || '', after: seed.after || '',
      sheet: seed.sheet || null, afterSheet: null,
      sheetJobId: null, afterJobId: null, fromUser: !!seed.fromUser,
      refs: Array.isArray(seed.refs) ? seed.refs.slice(0, 4) : [], refAsSheet: !!seed.refAsSheet,
      sheetCheck: null, sheetRedrawn: false,
    };
  }

  function picOf(r) {
    return r && r.fname ? { fname: r.fname, url: r.url || `ala://img/${r.fname}`, mime: mimeOf(r.fname), source: r.source || 'library' } : null;
  }

  function castFromRef(r) {
    if (!r) return null;
    const pics = (Array.isArray(r.refs) ? r.refs : [r]).map(picOf).filter(Boolean);
    if (!pics.length && !r.name) return null;
    const asIs = !!(r.asIs || r.refAsSheet) && pics.length > 0;
    return blankMember({
      name: r.name || '', named: !!r.name, fromUser: true, refs: pics, refAsSheet: asIs, sheet: asIs ? pics[0] : null,
      look: r.look || '', outfit: r.outfit || '',
    });
  }

  function blankLocation(seed = {}) {
    return { id: U.uid(), name: seed.name || 'Place', look: seed.look || '', plate: null, plateJobId: null, plateFailed: false };
  }

  function blankLine(seed = {}) {
    return {
      id: U.uid(), speaker: seed.speaker || '', text: seed.text || '', kind: KINDS.includes(seed.kind) ? seed.kind : 'speech',
      manual: false, anchor: null, tailTo: null, tailManual: false, scale: 1,
    };
  }

  function blankPanel(i) {
    return {
      id: U.uid(), n: i + 1,
      shot: 'medium', aspect: '', mode: 'new', who: [],
      action: '', caption: '', lines: [], sfx: '',
      takes: [], chosen: null, jobId: null, pickFrom: null,
      status: 'empty', error: null, facts: null, pick: null, rerolled: false, revise: null,
      locationId: null, captionAt: null, captionScale: 1, sfxAt: null, sfxScale: 1, sfxAngle: null,
    };
  }

  const mimeOf = (fname) => (/\.png$/i.test(fname) ? 'image/png' : /\.webp$/i.test(fname) ? 'image/webp' : 'image/jpeg');

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image failed to load'));
      img.src = src;
    });
  }

  const imgCache = new Map();
  function loadFname(fname) {
    if (imgCache.has(fname)) {
      const hit = imgCache.get(fname);
      imgCache.delete(fname);
      imgCache.set(fname, hit);
      return hit;
    }
    const pr = (async () => {
      const b64 = await window.ala.files.readImageBase64(fname);
      if (!b64) throw new Error('empty image file');
      return loadImage(`data:${mimeOf(fname)};base64,${b64}`);
    })();
    pr.catch(() => imgCache.delete(fname));
    imgCache.set(fname, pr);
    while (imgCache.size > 40) imgCache.delete(imgCache.keys().next().value);
    return pr;
  }

  let fontsReady = null;
  function ensureFonts() {
    if (!fontsReady) {
      fontsReady = (async () => {
        if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) return;
        await Promise.all([
          document.fonts.load('700 24px "Comic Neue"'),
          document.fonts.load('400 24px Bangers'),
          document.fonts.load('400 24px "Gochi Hand"'),
        ]).catch(() => {});
      })();
    }
    return fontsReady;
  }

  async function contactSheet(tiles, refFname = null, extra = []) {
    const all = [...(refFname ? [{ fname: refFname, label: 'R' }] : []), ...(extra || []).filter((e) => e && e.fname),
      ...tiles.map((t, i) => ({ fname: t.fname, label: String(i + 1) }))];
    const n = all.length;
    const cols = n <= 3 ? n : n <= 4 ? 2 : 3;
    const rows = Math.ceil(n / cols);
    const tile = n <= 2 ? 768 : n <= 4 ? 640 : 512;
    const cv = document.createElement('canvas');
    cv.width = cols * tile; cv.height = rows * tile;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#101010'; ctx.fillRect(0, 0, cv.width, cv.height);
    for (let i = 0; i < n; i++) {
      const x = (i % cols) * tile, y = Math.floor(i / cols) * tile;
      try {
        const img = await loadFname(all[i].fname);
        const s = Math.min(tile / img.naturalWidth, tile / img.naturalHeight);
        const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
        ctx.drawImage(img, x + (tile - w) / 2, y + (tile - h) / 2, w, h);
      } catch { ctx.fillStyle = '#402020'; ctx.fillRect(x, y, tile, tile); }
      const fs = Math.round(tile * 0.11);
      ctx.fillStyle = /^[A-Z]$/.test(all[i].label) ? 'rgba(160,20,20,0.85)' : 'rgba(0,0,0,0.8)';
      ctx.fillRect(x + 6, y + 6, fs * 1.5, fs * 1.35);
      ctx.fillStyle = '#fff'; ctx.font = `bold ${fs}px sans-serif`; ctx.textBaseline = 'top';
      ctx.fillText(all[i].label, x + 6 + fs * 0.3, y + 6 + fs * 0.18);
      ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, tile - 2, tile - 2);
    }
    return { base64: cv.toDataURL('image/jpeg', 0.9).split(',')[1], mime: 'image/jpeg' };
  }

  const Comics = {
    data: { projects: [], version: VERSION },
    _locks: new Map(),

    async init() {
      const loaded = await window.ala.db.getComics().catch(() => null);
      const projects = loaded && Array.isArray(loaded.projects) ? loaded.projects : [];
      this.data = {
        projects: projects.filter((p) => p && p.version === VERSION),
        legacy: [...((loaded && loaded.legacy) || []), ...projects.filter((p) => !p || p.version !== VERSION)],
        version: VERSION,
      };
      setTimeout(() => this.resumeAll(), 8000);
    },

    persist() {
      window.ala.db.setComics(this.data);
      State.emit('comics', this.data);
    },

    get(id) { return this.data.projects.find((p) => p.id === id) || null; },

    lock(project, fn) {
      const prev = this._locks.get(project.id) || Promise.resolve();
      const next = prev.catch(() => {}).then(fn);
      this._locks.set(project.id, next.catch(() => {}));
      return next;
    },

    create({ name = '', format = 'page', premise = '', theme = '', tone = '', panels = 4, takes = 2,
      castRefs = [], approveCast = false, workflow = '', preset = 'western',
      pageStyle = 'classic', lettering = 'balloons', sequence = false, plates = true } = {}) {
      const fmt = ['page', 'webtoon', 'story'].includes(format) ? format : 'page';
      const L = window.ComicLayout;
      const letter = defaultLetter(preset);
      letter.mode = lettering === 'float' ? 'float' : 'balloons';
      const project = {
        id: U.uid(), version: VERSION,
        name: name || (fmt === 'story' ? 'Untitled story' : 'Untitled comic'), title: name || '',
        format: fmt, premise, theme, tone,
        panelCount: fmt === 'story' ? 1 : clampN(panels, 1, 8, 4),
        takes: clampN(takes, 1, 4, 2),
        approveCast: !!approveCast, castApproved: false,
        autoSend: true, autoReroll: true,
        workflow: String(workflow || ''),
        cast: (castRefs || []).slice(0, MAX_CAST).map((r) => castFromRef(r)).filter(Boolean),
        artStyle: '', setting: '', logline: '', story: '', locations: [],
        sequence: !!sequence && fmt !== 'story', plates: plates !== false,
        pageStyle: L && L.PAGE_STYLES && L.PAGE_STYLES[pageStyle] ? pageStyle : 'classic',
        template: fmt === 'story' ? 'story-left' : '',
        panels: [], storyboarded: false, lettered: false, letteredBy: '',
        geom: defaultGeom(fmt), letter,
        page: null,
        run: { active: false, phase: 'draft', note: '', error: null, startedAt: 0, finishedAt: 0 },
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      this.data.projects.unshift(project);
      this.persist();
      return project;
    },

    update(id, patch) {
      const p = this.get(id);
      if (!p) return null;
      Object.assign(p, patch, { updatedAt: Date.now() });
      this.persist();
      return p;
    },

    async remove(id, { withFiles = false } = {}) {
      const p = this.get(id);
      if (!p) return;
      State.queue = (State.queue || []).filter((j) => !(j.comic && j.comic.projectId === id && j.status === 'queued'));
      State.persistQueue();
      if (withFiles) {
        const names = new Set();
        for (const panel of p.panels) for (const t of panel.takes || []) if (t.fname) names.add(t.fname);
        for (const m of p.cast) for (const s of [m.sheet, m.afterSheet]) if (s && s.fname && s.source === 'generated') names.add(s.fname);
        for (const l of p.locations || []) if (l.plate && l.plate.fname) names.add(l.plate.fname);
        for (const fname of names) await window.ala.files.deleteImage(fname).catch(() => {});
      }
      this.data.projects = this.data.projects.filter((x) => x.id !== id);
      this.persist();
    },

    start(project, { autoSend = true } = {}) {
      if (!this.engineOk()) throw new Error('comics need the ComfyUI engine with the Qwen-Image 2.1 reference workflow (Settings → Generation)');
      if (!String(project.premise || '').trim() && !project.storyboarded) throw new Error('write the premise first');
      project.autoSend = autoSend;
      project.run = { ...project.run, active: true, error: null, startedAt: Date.now(), finishedAt: 0 };
      this.persist();
      this.kick(project);
      return project;
    },

    stop(project) {
      project.run.active = false;
      project.run.phase = 'stopped';
      project.run.note = 'Stopped. Queued pictures were removed; finished ones are kept.';
      State.queue = (State.queue || []).filter((j) => !(j.comic && j.comic.projectId === project.id && j.status === 'queued'));
      State.persistQueue();
      for (const p of project.panels) if (p.status === 'queued') p.status = p.takes.length ? 'picking' : 'empty';
      this.persist();
    },

    engineOk() {
      return ((State.settings && State.settings.gen) || {}).engine === 'comfy';
    },

    kick(project) {
      this.lock(project, () => this.advance(project)).catch((e) => {
        project.run.error = e.message;
        project.run.phase = 'needs attention';
        log(`${project.title || project.name}: ${e.message}`, 'err');
        this.persist();
      });
    },

    resumeAll() {
      for (const p of this.data.projects) if (p.run && p.run.active) this.kick(p);
    },

    pendingJob(id) {
      if (!id) return null;
      return (State.queue || []).find((j) => j.id === id && (j.status === 'queued' || j.status === 'generating')) || null;
    },

    setPhase(project, phase, note = '') {
      project.run.phase = phase;
      project.run.note = note;
      project.updatedAt = Date.now();
      this.persist();
    },

    async advance(project) {
      if (!project.run.active) return;

      for (const m of project.cast) {
        if (m.fromUser && !m.look && !m.describeFailed && (refsOf(m).length || m.sheet)) {
          this.setPhase(project, 'reading the cast', `Looking at the picture of ${m.name || 'the character'}…`);
          await this.describeMember(project, m).catch((e) => {
            m.describeFailed = true;
            log(`could not read the reference picture (${e.message}) — the writer invents the look.`, 'err');
          });
        }
      }

      if (!project.storyboarded) {
        this.setPhase(project, 'storyboard', 'Writing the storyboard…');
        await this.writeStoryboard(project);
      }

      const used = this.formsInUse(project);
      let waiting = false;
      for (const m of project.cast) {
        const forms = used.get(m.id) || new Set();
        if (!forms.size) continue;
        if (!m.sheet) {
          if (!this.pendingJob(m.sheetJobId)) this.queueSheet(project, m, 'before');
          waiting = true;
          continue;
        }
        if (refsOf(m).length && !m.refAsSheet && m.sheet.source === 'generated' && !m.sheetCheck) {
          this.setPhase(project, 'cast', `Checking ${m.name}'s sheet against the reference…`);
          const verdict = await this.checkSheet(project, m).catch((e) => { log(`could not check ${m.name}'s sheet (${e.message}) — keeping it.`, 'err'); return null; });
          m.sheetCheck = verdict || { identity: null, issue: 'not checked', at: Date.now() };
          if (verdict && verdict.identity < 6 && !m.sheetRedrawn) {
            m.sheetRedrawn = true;
            m.sheet = null;
            m.sheetCheck = null;
            log(`${m.name}'s sheet does not look like the reference (${verdict.issue || `identity ${verdict.identity}/10`}) — drawing it again.`, 'warn');
            this.queueSheet(project, m, 'before');
            waiting = true;
            continue;
          }
          this.persist();
        }
        if (forms.has('after') && m.after && !m.afterSheet) {
          if (!this.pendingJob(m.afterJobId)) this.queueSheet(project, m, 'after');
          waiting = true;
        }
      }
      for (const loc of platesWanted(project)) {
        if (loc.plate || loc.plateFailed) continue;
        if (!this.pendingJob(loc.plateJobId)) this.queuePlate(project, loc);
        waiting = true;
      }
      if (waiting) { this.setPhase(project, 'cast', 'Drawing the cast sheets and backgrounds…'); this.startWorker(project); return; }
      if (project.approveCast && !project.castApproved) {
        this.setPhase(project, 'cast-review', 'Cast sheets and backgrounds are ready — approve them (or redraw one) to draw the panels.');
        return;
      }

      let open = 0;
      for (let i = 0; i < project.panels.length; i++) {
        const p = project.panels[i];
        if (p.chosen && !p.revise) continue;
        open++;
        if (p.status === 'failed') continue;
        const fresh = p.takes.filter((t) => !p.pickFrom || t.jobId === p.pickFrom);
        if (fresh.length && !this.pendingJob(p.jobId) && (p.status === 'picking' || !p.chosen)) {
          this.setPhase(project, 'picking', `Choosing the best take of panel ${p.n}…`);
          await this.pickPanel(project, p);
          if (p.chosen && !p.revise) { open--; continue; }
        }
        if (this.pendingJob(p.jobId)) continue;
        if (p.revise) continue;
        if (p.mode === 'continue' && i > 0 && !project.panels[i - 1].chosen) continue;
        if (!p.chosen) this.queuePanel(project, p);
      }
      if (open) {
        const left = project.panels.filter((p) => !p.chosen).length;
        const failed = project.panels.filter((p) => p.status === 'failed').length;
        this.setPhase(project, failed ? 'needs attention' : 'panels',
          failed ? `${failed} panel(s) failed — reroll them to carry on.` : `Drawing panels — ${project.panels.length - left}/${project.panels.length} done.`);
        this.startWorker(project);
        return;
      }

      if (!project.lettered) {
        this.setPhase(project, 'lettering', 'Reading the finished panels and writing the words to match…');
        await this.letter(project);
      }
      if (project.autoSend) {
        this.setPhase(project, 'composing', 'Composing the page…');
        await this.exportPage(project);
      }
      project.run.active = false;
      project.run.finishedAt = Date.now();
      this.setPhase(project, 'done', project.autoSend ? 'The page is in Review.' : 'Ready — compose it when you like.');
      State.emit('comicDone', { projectId: project.id });
    },

    formsInUse(project) {
      const used = new Map();
      for (const p of project.panels) for (const w of p.who || []) {
        if (!used.has(w.castId)) used.set(w.castId, new Set());
        used.get(w.castId).add(w.form || 'before');
      }
      return used;
    },

    async describeMember(project, m) {
      const src = refsOf(m)[0] || m.sheet;
      const b64 = await window.ala.files.readImageBase64(src.fname);
      const small = await Pipeline.downscaleForQc(b64, src.mime || mimeOf(src.fname));
      const r = await U.llmVision(small.base64, small.mime, T.describe(), { role: 'vision', maxTokens: 6000 }, 'Comic: reading the character picture');
      const j = lastJson(r.text, (v) => v.look);
      if (!j) throw new Error('the vision model did not describe the picture');
      m.look = str(j.look, 400);
      m.outfit = str(j.outfit, 300);
      if (!m.named && j.name) { m.name = str(j.name, 28); m.named = true; }
      this.persist();
    },

    async writeStoryboard(project) {
      const { text } = await U.llmChat([{ role: 'user', content: T.storyboard({
        premise: project.premise, theme: project.theme, tone: project.tone,
        panels: project.panelCount, format: project.format, cast: project.cast, sequence: !!project.sequence,
      }) }], { temperature: 0.85, maxTokens: 9000, role: 'ideation' }, 'Comic storyboard');
      const raw = lastJson(text, (v) => Array.isArray(v.panels));
      if (!raw) throw new Error('the writer did not return a storyboard');
      const sb = normalizeStoryboard(raw, { panels: project.panelCount, existingCast: project.cast, sequence: !!project.sequence });
      if (!sb.panels.length) throw new Error('the writer returned no panels');
      Object.assign(project, {
        title: project.title || sb.title || project.name, logline: sb.logline,
        artStyle: project.artStyle || sb.artStyle, setting: project.setting || sb.setting,
        story: sb.story || project.story, cast: sb.cast, panels: sb.panels, panelCount: sb.panels.length,
        locations: sb.locations, storyboarded: true, lettered: false, page: null,
      });
      if (project.title && (!project.name || /^Untitled/.test(project.name))) project.name = project.title;
      this.assignLayout(project);
      this.persist();
      log(`storyboard for "${project.title}" — ${project.panels.length} panels, ${project.cast.length} character(s), ${project.locations.length} place(s).`, 'ok');
    },

    assignLayout(project) {
      const L = window.ComicLayout;
      if (project.format === 'story') {
        project.template = project.template || 'story-left';
        project.panels.forEach((p) => { p.aspect = '2:3 (Portrait Photo)'; });
        return;
      }
      if (project.format === 'webtoon') {
        const by = { wide: '16:9 (Widescreen)', medium: '4:3 (Standard)', close: '1:1 (Square)', 'extreme-close': '3:2 (Photo)' };
        project.panels.forEach((p) => { p.aspect = by[p.shot] || '4:3 (Standard)'; });
        return;
      }
      if (!project.template || !L.LAYOUTS[project.template] || L.LAYOUTS[project.template].slots !== project.panels.length) {
        project.template = L.pickLayout(project.panels.map((p) => p.shot), this.pageGeom(project, 1, ''), { sequence: !!project.sequence });
      }
      const layout = L.layoutFor(project.template, project.panels.length);
      const aspects = L.slotAspects(layout, { ...this.pageGeom(project, 1), top: this.titleBand(project, 1) });
      project.panels.forEach((p, i) => { p.aspect = aspects[i] || '1:1 (Square)'; });
    },

    pageGeom(project, scale = 1, template = project.template) {
      const L = window.ComicLayout;
      const g = project.geom || defaultGeom(project.format);
      const ps = L.pageStyle(project.pageStyle);
      const t = project.format === 'page' && template ? L.LAYOUTS[template] : null;
      const page = t && t.page && t.slots === (project.panels.length || project.panelCount) ? t.page : null;
      const pick = (k) => (ps[k] != null ? ps[k] : g[k]);
      return {
        width: Math.round((page ? page.width : g.width) * scale),
        height: Math.round((page ? page.height : g.height) * scale),
        margin: Math.round(pick('margin') * scale), gutter: Math.round(pick('gutter') * scale),
      };
    },

    titleBand(project, scale) {
      return project.letter.showTitle && (project.title || project.name) ? Math.round(86 * scale) : 0;
    },

    startWorker(project) {
      const ids = (State.queue || []).filter((j) => j.comic && j.comic.projectId === project.id && j.status === 'queued').map((j) => j.id);
      if (ids.length && window.Pipeline && typeof Pipeline.start === 'function') Pipeline.start({ only: ids });
    },

    enqueue(project, { prompt, kind, panelId = null, castId = null, locationId = null, form = null, refs = [], edit = false, aspect = '', count = 1, label }) {
      const job = Pipeline.makeJob(prompt, label, 'comic');
      job.count = count;
      job.aspect = aspect || '';
      job.workflow = project.workflow || '';
      job.referenceCount = refs.length || 0;
      job.comic = { projectId: project.id, kind, panelId, castId, locationId, form, edit: !!edit, refs: refs.map((r) => r.fname) };
      job.batchId = `comic-${project.id}`;
      const q = State.queue || [];
      let at = 0;
      q.forEach((j, i) => { if (j.comic && j.comic.projectId === project.id) at = i + 1; });
      State.queue = [...q.slice(0, at), job, ...q.slice(at)];
      State.persistQueue();
      return job;
    },

    queueSheet(project, m, form) {
      const built = sheetJob(project, m, form);
      const edit = built.edit;
      const job = this.enqueue(project, {
        kind: 'sheet', castId: m.id, form, edit,
        prompt: built.prompt, refs: built.refs,
        aspect: '2:3 (Portrait Photo)', count: 1,
        label: `Comic “${project.title || project.name}” — ${m.name}${form === 'after' ? ' (after)' : ''} sheet`,
      });
      if (form === 'after') m.afterJobId = job.id; else m.sheetJobId = job.id;
      this.persist();
      log(`queued the ${form === 'after' ? 'after-form ' : ''}cast sheet for ${m.name}${built.refs.length && !edit ? ` (from ${built.refs.length} reference picture${built.refs.length > 1 ? 's' : ''})` : ''}.`);
    },

    queuePlate(project, loc) {
      const job = this.enqueue(project, {
        kind: 'plate', locationId: loc.id, prompt: platePrompt(project, loc), refs: [],
        aspect: '16:9 (Widescreen)', count: 1,
        label: `Comic “${project.title || project.name}” — background: ${loc.name}`,
      });
      loc.plateJobId = job.id;
      loc.plateFailed = false;
      this.persist();
      log(`queued the background for "${loc.name}".`);
    },

    async checkSheet(project, m) {
      const ref = refsOf(m)[0];
      const sheet = await contactSheet([{ fname: m.sheet.fname }], ref.fname);
      const r = await U.llmVision(sheet.base64, sheet.mime, T.sheetCheck(m.name), { role: 'vision', maxTokens: 4000 }, `Comic: checking ${m.name}'s sheet`);
      const v = parseSheetCheck(r.text);
      if (!v) throw new Error('no usable answer');
      return { ...v, at: Date.now() };
    },

    queuePanel(project, p, { count = null, prompt = null, refs = null, edit = null } = {}) {
      const built = prompt ? { prompt, refs: refs || [], edit: !!edit } : panelPrompt(project, p);
      const job = this.enqueue(project, {
        kind: 'panel', panelId: p.id, prompt: built.prompt, refs: built.refs, edit: built.edit,
        aspect: p.aspect, count: count || project.takes || 2,
        label: `Comic “${project.title || project.name}” — panel ${p.n}`,
      });
      p.jobId = job.id;
      p.pickFrom = job.id;
      p.status = 'queued';
      p.error = null;
      p.prompt = built.prompt;
      this.persist();
      return job;
    },

    async jobReferences(job) {
      const out = [];
      for (const [i, fname] of ((job.comic && job.comic.refs) || []).entries()) {
        const base64 = await window.ala.files.readImageBase64(fname);
        if (!base64) throw new Error(`the comic reference ${fname} is missing on disk`);
        out.push({ id: `comic-${i + 1}`, base64, mime: mimeOf(fname) });
      }
      return out;
    },

    async acceptJobImages(job, images) {
      const c = job.comic || {};
      const project = this.get(c.projectId);
      const saved = [];
      for (const img of images) {
        const file = await window.ala.files.saveImage(img.base64, U.extFromMime(img.mime), c.kind === 'sheet' ? 'comic-cast' : c.kind === 'plate' ? 'comic-place' : 'comic-panel');
        saved.push({ fname: file.fname, url: file.url, mime: img.mime, w: img.w || 0, h: img.h || 0, jobId: job.id, at: Date.now() });
      }
      if (!project) return saved;
      if (c.kind === 'sheet') {
        const m = project.cast.find((x) => x.id === c.castId);
        if (m) {
          const sheet = { ...saved[0], source: 'generated' };
          if (c.form === 'after') { m.afterSheet = sheet; m.afterJobId = null; } else { m.sheet = sheet; m.sheetJobId = null; m.sheetCheck = null; }
        }
      } else if (c.kind === 'plate') {
        const loc = locationById(project, c.locationId);
        if (loc) { loc.plate = { ...saved[0], source: 'generated' }; loc.plateJobId = null; loc.plateFailed = false; }
      } else {
        const p = project.panels.find((x) => x.id === c.panelId);
        if (p) {
          p.takes.push(...saved);
          p.status = 'picking';
          p.jobId = null;
        }
      }
      project.updatedAt = Date.now();
      this.persist();
      this.kick(project);
      return saved;
    },

    jobFailed(job) {
      const c = job.comic || {};
      const project = this.get(c.projectId);
      if (!project) return;
      if (c.kind === 'sheet') {
        const m = project.cast.find((x) => x.id === c.castId);
        if (m) { if (c.form === 'after') m.afterJobId = null; else m.sheetJobId = null; }
        project.run.error = `the cast sheet for ${m ? m.name : 'a character'} failed: ${job.error || 'unknown error'}`;
        project.run.active = false;
      } else if (c.kind === 'plate') {
        const loc = locationById(project, c.locationId);
        if (loc) { loc.plateJobId = null; loc.plateFailed = true; }
        log(`the background for ${loc ? `"${loc.name}"` : 'a place'} failed (${job.error || 'unknown error'}) — its panels are drawn from the description alone.`, 'err');
        this.persist();
        this.kick(project);
        return;
      } else {
        const p = project.panels.find((x) => x.id === c.panelId);
        if (p) { p.status = 'failed'; p.error = job.error || 'render failed'; p.jobId = null; p.revise = null; }
      }
      project.run.phase = 'needs attention';
      this.persist();
      this.kick(project);
    },

    async pickPanel(project, p) {
      const fresh = p.takes.filter((t) => !p.pickFrom || t.jobId === p.pickFrom).slice(-6);
      if (!fresh.length) return;
      let chosen = fresh[0];
      let pick = null;
      if (fresh.length > 1 && !(p.revise && p.revise.instruction)) {
        try {
          const ref = (p.who || []).map((w) => sheetOf(memberById(project, w.castId) || {}, w.form)).find((s) => s && s.fname);
          const loc = locationOf(project, p);
          const plate = loc && loc.plate && !CLOSE_SHOTS.has(p.shot) && p.mode !== 'continue' ? loc.plate : null;
          const sheet = await contactSheet(fresh, ref ? ref.fname : null, plate ? [{ fname: plate.fname, label: 'P' }] : []);
          const cast = (p.who || []).map((w) => { const m = memberById(project, w.castId); return m ? `${m.name} (${lookAt(m, w.form)})` : ''; }).filter(Boolean).join('; ');
          const place = loc && p.shot !== 'extreme-close' ? `${loc.name} — ${loc.look}` : '';
          const r = await U.llmVision(sheet.base64, sheet.mime, T.pick({ n: fresh.length, hasRef: !!ref, hasPlace: !!plate, action: p.action, cast, place }),
            { role: 'vision', maxTokens: 8000 }, `Comic: choosing panel ${p.n}`);
          pick = parsePick(r.text, fresh.length);
          if (pick) {
            chosen = fresh[pick.best - 1];
            const row = pick.tiles[pick.best] || null;
            p.pick = { at: Date.now(), best: pick.best, tiles: pick.tiles };
            const miss = pickMissed(row);
            if (miss && project.autoReroll && !p.rerolled) {
              p.rerolled = true;
              log(`panel ${p.n}: every take missed (${row.issue || `identity ${row.identity}/10, anatomy ${row.render}/10${row.place != null ? `, place ${row.place}/10` : ''}`}) — rerolling once.`, 'warn');
              this.queuePanel(project, p);
              return;
            }
          }
        } catch (e) {
          log(`panel ${p.n}: could not judge the takes (${e.message}) — keeping the first.`, 'err');
        }
      }
      this.choose(project, p, chosen.fname, { persist: false });
      p.revise = null;
      await this.readFacts(project, p).catch((e) => log(`panel ${p.n}: could not find the faces (${e.message}) — balloons avoid the middle instead.`, 'err'));
      this.persist();
    },

    choose(project, p, fname, { persist = true } = {}) {
      const take = (p.takes || []).find((t) => t.fname === fname);
      if (!take) return p;
      const changed = p.chosen !== fname;
      p.chosen = take.fname;
      p.status = 'ready';
      p.error = null;
      if (changed) {
        p.facts = null;
        project.lettered = false;
        for (const l of p.lines) if (l.manual) { l.manual = false; l.anchor = null; l.tailTo = null; l.tailManual = false; }
      }
      project.updatedAt = Date.now();
      if (persist) {
        this.persist();
        if (changed && !project.run.active) this.lock(project, () => this.readFacts(project, p)).then(() => this.persist()).catch(() => {});
      }
      return p;
    },

    async readFacts(project, p) {
      if (!p.chosen) return null;
      const b64 = await window.ala.files.readImageBase64(p.chosen);
      if (!b64) return null;
      const small = await Pipeline.downscaleForQc(b64, mimeOf(p.chosen));
      const members = (p.who || []).map((w) => ({ m: memberById(project, w.castId), form: w.form })).filter((x) => x.m);
      const names = members.map((x) => x.m.name);
      const looks = members.length > 1 ? members.map((x) => `${x.m.name}: ${str(lookAt(x.m, x.form), 160)}`) : [];
      const r = await U.llmVision(small.base64, small.mime, T.facts(names, looks), { role: 'vision', maxTokens: 6000 }, `Comic: faces in panel ${p.n}`);
      const facts = parseFacts(r.text);
      if (!facts) throw new Error('no usable answer');
      p.facts = facts;
      return facts;
    },

    async letter(project) {
      try {
        await ensureFonts();
        const cv = await this.compose(project, { scale: 0.62, lettering: false, numbers: true });
        const b64 = cv.toDataURL('image/jpeg', 0.88).split(',')[1];
        const cast = project.cast.map((m) => `${m.name}: ${m.look}`).join('; ');
        const panels = project.panels.map((p) => ({ n: p.n, shot: p.shot, action: p.action, caption: p.caption, lines: p.lines, sfx: p.sfx }));
        const r = await U.llmVision(b64, 'image/jpeg', T.letter({ premise: project.premise, cast, panels }),
          { role: 'vision', maxTokens: 9000 }, 'Comic: lettering the page');
        const got = parseLetter(r.text, project.panels.length);
        if (!got) throw new Error('the reply had no panels');
        project.panels.forEach((p) => {
          const w = got.panels[p.n];
          if (!w) return;
          if (!p.captionManual) p.caption = w.caption;
          if (!p.sfxManual) p.sfx = w.sfx;
          const keep = p.lines.filter((l) => l.textManual);
          if (!keep.length) {
            const old = p.lines;
            p.lines = w.lines.map((l, i) => {
              const fresh = blankLine(l);
              const o = old[i];
              if (o && o.manual && o.anchor) Object.assign(fresh, { manual: true, anchor: o.anchor, tailManual: !!o.tailManual, tailTo: o.tailManual ? o.tailTo : null, scale: o.scale || 1 });
              else if (o && o.scale && o.scale !== 1) fresh.scale = o.scale;
              return fresh;
            });
          }
        });
        if (got.title && !project.titleManual) project.title = got.title;
        project.letteredBy = 'vision';
      } catch (e) {
        log(`lettering from the pictures failed (${e.message}) — keeping the storyboard's words.`, 'err');
        project.letteredBy = 'draft';
      }
      project.lettered = true;
      this.persist();
    },

    reroll(project, p) {
      p.rerolled = true;
      p.revise = null;
      p.status = 'queued';
      if (!project.run.active) project.run = { ...project.run, active: true, error: null };
      project.autoSend = project.autoSend !== false;
      p.chosen = null;
      this.queuePanel(project, p);
      this.startWorker(project);
      this.persist();
    },

    revise(project, p, instruction) {
      const change = str(instruction, 1200);
      if (!change) throw new Error('say what should change in the panel');
      if (!p.chosen) throw new Error(`panel ${p.n} has no picture yet — reroll it instead`);
      const prompt = `Edit <image1>. Keep the same characters, faces, hair, outfits, place, lighting and art style as <image1>. ${change.charAt(0).toUpperCase()}${change.slice(1)}${/[.!?]$/.test(change) ? '' : '.'} Change nothing else.`;
      p.revise = { instruction: change, at: Date.now() };
      if (!project.run.active) project.run = { ...project.run, active: true, error: null };
      this.queuePanel(project, p, { count: 1, prompt, refs: [{ fname: p.chosen }], edit: true });
      this.startWorker(project);
    },

    rerollSheet(project, m, form = 'before') {
      if (form === 'after') m.afterSheet = null;
      else { m.sheet = null; m.refAsSheet = false; m.sheetCheck = null; m.sheetRedrawn = true; }
      if (!project.run.active) project.run = { ...project.run, active: true, error: null };
      this.queueSheet(project, m, form);
      this.startWorker(project);
    },

    rerollPlate(project, loc) {
      loc.plate = null;
      if (!project.run.active) project.run = { ...project.run, active: true, error: null };
      this.queuePlate(project, loc);
      this.startWorker(project);
    },

    addReference(project, m, pic, { redraw = false } = {}) {
      const ref = picOf(pic);
      if (!ref) throw new Error('no picture');
      m.refs = [...refsOf(m).filter((r) => r.fname !== ref.fname), ref].slice(-4);
      m.fromUser = true;
      this.persist();
      if (redraw && project.storyboarded) this.rerollSheet(project, m, 'before');
      return m;
    },

    approveCast(project) {
      project.castApproved = true;
      if (!project.run.active) project.run = { ...project.run, active: true, error: null };
      this.persist();
      this.kick(project);
    },

    retryFailed(project) {
      for (const p of project.panels) if (p.status === 'failed') { p.status = p.takes.length ? 'picking' : 'empty'; p.error = null; }
      project.run = { ...project.run, active: true, error: null };
      this.persist();
      this.kick(project);
    },

    geometry(project, scale = 1) {
      const L = window.ComicLayout;
      const pg = this.pageGeom(project, scale);
      const titleH = this.titleBand(project, scale);
      if (project.format === 'webtoon') {
        const ratios = project.panels.map((p) => {
          const t = (p.takes || []).find((x) => x.fname === p.chosen);
          return t && t.w && t.h ? t.w / t.h : L.aspectRatio(p.aspect) || 1;
        });
        const wt = L.webtoonBoxes(ratios, { width: pg.width, margin: pg.margin, gutter: pg.gutter, top: titleH });
        return { width: pg.width, height: wt.height, boxes: wt.boxes, textBox: null, titleH, margin: pg.margin };
      }
      const geom = { ...pg, top: titleH };
      const layout = L.layoutFor(project.template, project.panels.length);
      return { width: geom.width, height: geom.height, boxes: L.panelBoxes(layout, geom), textBox: L.textBox(layout, geom), titleH, margin: pg.margin };
    },

    async compose(project, { scale = 1, canvas = null, lettering = true, numbers = false, selected = null, selectedItem = null } = {}) {
      const L = window.ComicLayout;
      await ensureFonts();
      const G = this.geometry(project, scale);
      const st = project.letter;
      const ps = L.pageStyle(project.pageStyle);
      const cv = canvas || document.createElement('canvas');
      cv.width = G.width;
      cv.height = G.height;
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      L.drawPageBackground(ctx, G.width, G.height, ps, st.pageBg, scale);

      if (G.titleH) {
        const fs = Math.round(G.titleH * 0.72);
        ctx.fillStyle = ps.titleColor || st.titleColor;
        ctx.font = `400 ${fs}px ${st.titleFont || TITLE_FONT}`;
        ctx.textBaseline = 'middle';
        const title = String(project.title || project.name).toUpperCase();
        const w = ctx.measureText(title).width;
        ctx.fillText(title, Math.max(G.margin, (G.width - w) / 2), G.margin + G.titleH / 2);
      }

      const placed = [];
      for (let i = 0; i < G.boxes.length; i++) {
        const box = G.boxes[i];
        const panel = project.panels[i];
        ctx.save();
        L.panelPath(ctx, box, ps, scale);
        ctx.clip();
        let drawn = false;
        let crop = null;
        if (panel && panel.chosen) {
          const img = await loadFname(panel.chosen).catch(() => null);
          if (img) {
            const heads = ((panel.facts && panel.facts.people) || []).map((x) => x.head).filter(Boolean);
            const focus = heads.length ? {
              x: heads.reduce((a, h) => a + h[0] + h[2] / 2, 0) / heads.length,
              y: Math.min(...heads.map((h) => h[1] + h[3] / 2)),
            } : null;
            const s = L.coverRect(img, box, focus);
            ctx.drawImage(img, s.sx, s.sy, s.sw, s.sh, box.x, box.y, box.w, box.h);
            crop = { ...s, iw: img.naturalWidth || img.width, ih: img.naturalHeight || img.height };
            drawn = true;
          }
        }
        if (!drawn) drawPlaceholder(ctx, box, panel ? `panel ${i + 1}${panel.status === 'queued' ? ' — queued' : panel.status === 'failed' ? ' — failed' : ''}` : '', scale);

        if (panel && lettering) placed.push(this.letterPanel(ctx, project, panel, box, scale, crop));
        else placed.push([]);
        if (numbers) {
          const fs = Math.round(Math.min(box.w, box.h) * 0.16);
          ctx.fillStyle = 'rgba(200,20,20,0.9)';
          ctx.fillRect(box.x + 8, box.y + 8, fs * 1.3, fs * 1.25);
          ctx.fillStyle = '#fff';
          ctx.font = `bold ${fs}px sans-serif`;
          ctx.textBaseline = 'top';
          ctx.fillText(String(i + 1), box.x + 8 + fs * 0.32, box.y + 8 + fs * 0.12);
        }
        ctx.restore();

        L.drawPanelFrame(ctx, box, ps.border == null ? { ...ps, border: st.panelBorderWidth } : ps, st.panelBorder, scale);
        if (selected && panel && panel.id === selected) {
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = Math.max(3, Math.round(6 * scale));
          ctx.strokeRect(box.x + 2, box.y + 2, box.w - 4, box.h - 4);
        }
      }
      if (G.textBox) this.drawStory(ctx, project, G.textBox, scale);
      L.drawPageMarks(ctx, G.width, G.height, {
        signature: st.signature, pageNo: st.pageNo, color: ps.titleColor || st.titleColor, font: st.font || FONT, margin: G.margin,
      }, scale);
      if (selectedItem && lettering) {
        const idx = project.panels.findIndex((x) => x.id === selectedItem.panelId);
        const item = idx >= 0 ? (placed[idx] || []).find((b) => b.type === selectedItem.type && b.id === selectedItem.id) : null;
        if (item) L.drawSelection(ctx, item, scale);
      }
      cv._boxes = G.boxes;
      cv._placed = placed;
      return cv;
    },

    letterPanel(ctx, project, panel, box, scale, crop = null) {
      const L = window.ComicLayout;
      const facts = panel.facts || {};
      const people = (facts.people || []).map((x) => ({ ...x, head: L.mapBox(x.head, crop), body: x.body ? L.mapBox(x.body, crop) : null })).filter((x) => x.head);
      const empty = (facts.empty || []).map((b) => L.mapBox(b, crop)).filter(Boolean);
      const st = project.letter;
      const font = st.font || FONT;
      const k = Math.max(0.75, Math.min(1.15, Math.sqrt((box.w * box.h) / (620 * 620 * scale * scale))));
      const capScale = Number(panel.captionScale) > 0 ? Number(panel.captionScale) : 1;
      const capStyle = {
        font, fontSize: Math.round(st.captionSize * scale * k * capScale), fontWeight: 700,
        bg: st.captionBg, color: st.captionColor, borderColor: st.captionBorder, borderWidth: Math.max(1, Math.round(2.5 * scale)),
        corner: 'top', align: 'left', inset: 0, uppercase: st.uppercase, at: panel.captionAt || null,
      };
      const balStyle = {
        font, handFont: st.handFont || HAND_FONT, fontSize: Math.round(st.bubbleSize * scale * k), fontWeight: 700,
        bg: st.bubbleBg, color: st.bubbleColor, borderColor: st.bubbleBorder, shoutBg: st.shoutBg,
        borderWidth: Math.max(1.2, 2.4 * scale), uppercase: st.uppercase,
      };
      const capBox = L.drawCaption(ctx, box, panel.caption, capStyle);
      const out = [];
      const lines = (panel.lines || []).filter((l) => String(l.text || '').trim());
      const kindOf = (l) => (st.mode === 'float' || l.kind === 'float' ? 'float' : l.kind || 'speech');
      const castIdx = (name) => Math.max(0, (project.cast || []).findIndex((m) => norm(m.name) === norm(name)));
      const styleOf = (l) => {
        const sc = Number(l.scale) > 0 ? Number(l.scale) : 1;
        const kind = kindOf(l);
        const big = kind === 'float' && l.kind === 'shout' ? 1.25 : 1;
        return { ...balStyle, fontSize: Math.round(balStyle.fontSize * sc * big), floatColor: FLOAT_COLORS[castIdx(l.speaker) % FLOAT_COLORS.length] };
      };
      const items = lines.map((l) => {
        const style = styleOf(l);
        const kind = kindOf(l);
        const m = L.measureBalloon(ctx, { ...l, kind }, style, box);
        return {
          w: m.w, h: m.h, speaker: l.speaker, kind, _m: m, _style: style,
          fixed: l.manual && l.anchor ? { anchor: l.anchor, tailTo: l.tailManual ? l.tailTo : null } : null,
        };
      });
      const avoid = capBox ? [{ x: capBox.x - box.x, y: capBox.y - box.y, w: capBox.w, h: capBox.h }] : [];
      const spots = L.placeBalloons({ panel: { w: box.w, h: box.h }, items, people, empty, avoid });
      lines.forEach((l, i) => {
        const at = spots[i];
        const tailTo = items[i].kind === 'float' ? null : (l.tailManual && l.tailTo ? l.tailTo : at.tailTo);
        const rect = L.drawBalloon(ctx, box, { ...l, kind: items[i].kind, anchor: at.anchor, tailTo, _m: items[i]._m }, items[i]._style);
        out.push({
          type: 'line', id: l.id, lineId: l.id, anchor: at.anchor, tailTo, rect,
          tip: tailTo ? { x: box.x + tailTo.x * box.w, y: box.y + tailTo.y * box.h } : null,
        });
      });
      if (capBox) out.push({ type: 'caption', id: 'caption', rect: capBox, anchor: { x: (capBox.x - box.x) / box.w, y: (capBox.y - box.y) / box.h } });
      if (panel.sfx) {
        const sfxScale = Number(panel.sfxScale) > 0 ? Number(panel.sfxScale) : 1;
        let at = panel.sfxAt;
        if (!at) {
          const fs = Math.round(Math.min(box.w, box.h) * 0.13 * sfxScale);
          ctx.font = `400 ${fs}px ${st.titleFont || TITLE_FONT}`;
          const sw = ctx.measureText(String(panel.sfx).toUpperCase()).width * 1.1 + fs * 0.3;
          const taken = [...avoid, ...out.filter((b) => b.rect).map((b) => ({ x: b.rect.x - box.x, y: b.rect.y - box.y, w: b.rect.w, h: b.rect.h }))];
          [{ anchor: at }] = L.placeBalloons({ panel: { w: box.w, h: box.h }, items: [{ w: sw, h: fs * 1.4, kind: 'caption' }], people, empty, avoid: taken });
        }
        const rect = L.drawSfx(ctx, box, panel.sfx, {
          font, sfxFont: st.titleFont || TITLE_FONT, sfxColor: st.sfxColor, sfxStroke: st.sfxStroke,
          scale: sfxScale, angle: Number.isFinite(panel.sfxAngle) ? panel.sfxAngle : undefined,
        }, at);
        if (rect) out.push({ type: 'sfx', id: 'sfx', rect, anchor: at });
      }
      return out;
    },

    drawStory(ctx, project, box, scale) {
      const L = window.ComicLayout;
      const st = project.letter;
      ctx.fillStyle = st.storyBg;
      L.roundRect(ctx, box.x, box.y, box.w, box.h, Math.round(8 * scale));
      ctx.fill();
      const pad = Math.round(30 * scale);
      const inner = { x: box.x + pad, y: box.y + pad, w: box.w - pad * 2, h: box.h - pad * 2 };
      const text = project.story || project.logline || '';
      if (!text) return;
      const fit = L.fitFontSize(text, inner, {
        max: Math.round(st.storySize * scale), min: Math.round(11 * scale),
        measureAt: (s, size) => { ctx.font = `400 ${size}px Georgia, serif`; return ctx.measureText(s).width; },
      });
      ctx.font = `400 ${fit.size}px Georgia, serif`;
      ctx.fillStyle = st.storyColor;
      ctx.textBaseline = 'top';
      const lh = Math.round(fit.size * 1.38);
      const top = inner.y + Math.max(0, Math.round((inner.h - fit.lines.length * lh) / 2));
      fit.lines.forEach((line, i) => ctx.fillText(line, inner.x, top + i * lh));
      if (fit.clipped) log('the story text is longer than its column — it was cut. Shorten it, or use a taller layout.', 'err');
    },

    async exportPage(project) {
      const canvas = await this.compose(project, { scale: 1 });
      const base64 = canvas.toDataURL('image/png').split(',')[1];
      if (!base64) throw new Error('the page could not be rendered');
      const saved = await window.ala.files.saveImage(base64, 'png', `comic-${(project.title || 'page').slice(0, 20)}`);
      const existing = project.page && project.page.cardId ? State.library.find((c) => c.id === project.page.cardId) : null;
      const meta = {
        title: (project.title || project.name || 'Comic').slice(0, 50),
        description: project.logline || project.story || '',
        tags: [],
      };
      let card;
      if (existing && existing.status === 'review') {
        const old = existing.fname;
        Object.assign(existing, {
          fname: saved.fname, path: saved.path, url: saved.url, mime: 'image/png',
          width: canvas.width, height: canvas.height, prompt: this.pagePrompt(project), updatedAt: Date.now(),
        });
        if (!existing.metadata || !existing.metadata.title) existing.metadata = meta;
        card = existing;
        if (old && old !== saved.fname) window.ala.files.deleteImage(old).catch(() => {});
      } else {
        card = {
          id: saved.id, jobId: null, theme: project.theme || '',
          prompt: this.pagePrompt(project), promptSource: 'comic', learnedFrom: null, comicId: project.id,
          fname: saved.fname, path: saved.path, url: saved.url,
          mime: 'image/png', width: canvas.width, height: canvas.height,
          destination: (State.settings.publish && State.settings.publish.destination) || 'deviantart',
          status: 'review', qc: null, qcSkipped: true,
          metadata: meta, da: null, error: null,
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        State.library.unshift(card);
        if (window.Titles && typeof Titles.remember === 'function' && meta.title) Titles.remember(meta.title, 'card', card.id);
      }
      State.persistLibrary();
      project.page = { fname: saved.fname, url: saved.url, cardId: card.id, composedAt: Date.now() };
      project.updatedAt = Date.now();
      this.persist();
      log(`page "${project.title}" composed and sent to Review.`, 'ok');
      return card;
    },

    pagePrompt(project) {
      const cast = (project.cast || []).map((c) => `${c.name}: ${c.look}`).join(' ');
      const beats = project.panels.map((p, i) => `(${i + 1}) ${p.action}`).join(' ');
      return [
        `${project.format === 'story' ? 'Illustrated story' : `${project.panels.length}-panel comic`}: ${project.logline || project.premise}`,
        cast, beats,
      ].filter(Boolean).join(' — ').slice(0, 1800);
    },

    status(project) {
      const queued = (State.queue || []).filter((j) => j.comic && j.comic.projectId === project.id && (j.status === 'queued' || j.status === 'generating'));
      return {
        projectId: project.id, title: project.title || project.name, format: project.format,
        phase: project.run.phase, note: project.run.note, active: !!project.run.active, error: project.run.error || null,
        cast: project.cast.map((m) => ({
          name: m.name, sheet: !!m.sheet, after: m.after ? !!m.afterSheet : null, references: refsOf(m).length,
          sheetIdentity: m.sheetCheck && m.sheetCheck.identity != null ? m.sheetCheck.identity : undefined,
        })),
        places: (project.locations || []).map((l) => ({ name: l.name, background: l.plate ? 'drawn' : l.plateJobId ? 'queued' : l.plateFailed ? 'failed' : 'none' })),
        pageStyle: project.pageStyle || 'classic', lettering: (project.letter && project.letter.mode) || 'balloons', sequence: !!project.sequence,
        panels: project.panels.map((p) => ({
          n: p.n, shot: p.shot, mode: p.mode, place: (locationOf(project, p) || {}).name, status: p.status, takes: p.takes.length, error: p.error || undefined,
        })),
        jobsQueued: queued.length, lettered: project.lettered, pageCardId: project.page ? project.page.cardId : null,
      };
    },
  };

  function drawPlaceholder(ctx, box, label, scale) {
    ctx.fillStyle = '#e7e5e4';
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.strokeStyle = '#a8a29e';
    ctx.setLineDash([Math.round(10 * scale), Math.round(8 * scale)]);
    ctx.lineWidth = Math.max(1, Math.round(2 * scale));
    ctx.strokeRect(box.x + 6, box.y + 6, box.w - 12, box.h - 12);
    ctx.setLineDash([]);
    if (!label) return;
    ctx.fillStyle = '#78716c';
    ctx.font = `600 ${Math.round(22 * scale)}px sans-serif`;
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(label).width;
    ctx.fillText(label, box.x + (box.w - w) / 2, box.y + box.h / 2);
  }

  window.Comics = Comics;
  window.ComicT = T;
  window.ComicPrompts = {
    sheetPrompt, sheetJob, platePrompt, platesWanted, panelPrompt, normalizeStoryboard, parsePick, parseFacts, parseLetter,
    parseSheetCheck, pickMissed, castFromRef,
    PRESETS, defaultLetter, defaultGeom, blankPanel, blankLine, blankMember, blankLocation, SHOTS, KINDS, FLOAT_COLORS,
    MAX_PER_PANEL, MAX_CONTINUE_CHAIN, MAX_SEQUENCE_CHAIN,
  };
})();
