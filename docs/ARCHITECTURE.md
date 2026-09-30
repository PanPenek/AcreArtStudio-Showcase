# Architecture

A map of every module in the app, for reviewers. Each section below is the same text that
opens the file itself, so the code and this document say the same thing.

## The big picture

```
┌──────────────────────────── Electron main process (Node.js) ────────────────────────────┐
│ main.js ── IPC handlers ── store.js (JSON on disk)   llm.js ─ clibridge.js (AI calls)   │
│            ala:// media    research.js (web, read-only)   videocheck.js (ffmpeg/Whisper)│
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                 preload.js │ window.ala  (contextIsolation: the only bridge)
┌───────────────────────────────────────────┴───── Renderer (sandboxed page) ─────────────┐
│ app.js (all tabs) ─ state.js (shared state + helpers)                                   │
│ pipeline.js ── ideate → generate → save → quality check → metadata → Review → publish   │
│      │             │                                                                    │
│      │        perchance.js | comfy.js (image + video engines)                           │
│ overseer.js (chat agent: every tool wraps a function a button already calls)            │
│ insights.js + teach.js + variety.js + promptstyle.js → guidance for the prompt writers │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### Conventions

- **No build step, no framework.** Renderer modules are plain scripts loaded in order by
  `index.html`. Each is an IIFE that attaches one object to `window` (`window.Pipeline`,
  `window.Comfy`, …), so load order in `index.html` doubles as the dependency list.
- **One way out of the sandbox.** The renderer reaches disk, network and processes only
  through `window.ala` (defined in `preload.js`, handled in `main.js`).
- **Every AI call goes through `U.llmChat` / `U.llmVision`** (`state.js`) → IPC → `llm.js`,
  so fallbacks, token counts and "which engine answered" are recorded in one place.
- **Hard rules are enforced in code, not only requested in prompts** (tag format, banned
  phrases, quality-score caps). Models forget instructions. Code doesn't.

### Data flow of one job

1. `Pipeline.makeJob()` creates a job `{ prompt, theme, engine, … }` and puts it in the queue (`store.js`).
2. The generation lane calls `Perchance.generate()` or `Comfy.generate()`
   → `{ images: [{ base64, mime, w, h }] }`.
3. Images are saved through IPC into the library, and each becomes a **card**.
4. The inspection lane runs the vision quality check. Code-side caps can only lower the score.
5. The metadata writer adds title, description and tags. `Titles.similarity()` flags near-repeats.
6. The card waits in **Review**. A human approves, rejects or edits it.
7. On approval: upload (`daweb.js` / `da.js`) as a private draft. Publishing is a separate switch.
8. `dastats.js` reads engagement later. `insights.js` turns it into a playbook for step 1.

---

## Main process: privileged services (`src/main/`)

### `src/main/main.js` <sub>(769 lines)</sub>

**Electron main process, the app's privileged service layer.**

Owns everything the browser sandbox is not allowed to touch: the window, the JSON store on disk, the LLM bridge, file I/O for the image library, the ComfyUI HTTP bridge, OS notifications and the custom `ala://` media protocol (which serves library images and videos to the UI, including byte-range requests so video seeking works). The renderer asks for all of this over IPC (see preload.js); every handler is registered in one place below so the whole API surface is readable top to bottom.

### `src/main/preload.js` <sub>(146 lines)</sub>

**The only bridge between the UI and the main process.**

Runs with contextIsolation on and exposes a small, explicit API as `window.ala` (settings, library, LLM calls, files, ComfyUI, research...). The renderer never gets Node.js or `ipcRenderer` directly, so a bug in a web page shown inside the app cannot reach the file system.

### `src/main/store.js` <sub>(601 lines)</sub>

**JSON persistence for settings, the job queue, the image library and everything the app learns.**

```text
Files live in the OS profile folder (app.getPath('userData')), never in the
project folder. Three rules keep that data safe:
  - writes are debounced, then done atomically (write a sibling file, rename it
    over the original), so a crash mid-write cannot corrupt the library;
  - a file that fails to load is quarantined instead of being overwritten by
    defaults;
  - `migrate*` functions upgrade settings saved by older versions in place.
The DEFAULTS object at the top is also the reference for every setting.
```

### `src/main/llm.js` <sub>(643 lines)</sub>

**Chat + vision calls against any number of AI providers.**

```text
Every call belongs to a ROLE (ideation, metadata, vision QC, overseer), and every
role has its own ordered chain of providers: e.g. "a hosted API first, the local
LM Studio model as a fallback". `withFallback` walks that chain and returns the
first genuine answer, recording which provider produced it so the UI can show it.

Two kinds of provider:
  openai: any OpenAI-compatible HTTP endpoint (LM Studio, Ollama, OpenRouter...)
  cli:    an AI command-line tool already installed and signed in on the machine,
          run as a child process (see clibridge.js)
Refusals, moderation blocks, rate limits and dead endpoints are detected and
skipped, so one flaky provider never stops the pipeline.
```

### `src/main/clibridge.js` <sub>(269 lines)</sub>

**Use an installed AI command-line tool as if it were a chat API.**

Tools such as Claude Code, Codex, Gemini CLI or Qwen Code are already signed in and paid for by a subscription, but they expose no HTTP endpoint, only a process. This module writes the prompt to that process's stdin, reads the answer from stdout and returns the same `{ text, promptTokens, completionTokens }` shape as an HTTP call, so nothing downstream needs to know the difference. Handles the three practical problems: Windows `.cmd` shims (resolveCommand), safe quoting of multi-line prompts (stdin, never a shell), and CLI chatter around the actual answer (pickText).

### `src/main/prompts.js` <sub>(84 lines)</sub>

**Shared LLM prompt templates for ideation, quality check and metadata. Post-processing in code enforces hard rules (tag format, the optional supporter link) that a model might otherwise forget.**

### `src/main/research.js` <sub>(579 lines)</sub>

**Read-only web research for the Overseer assistant.**

When the artist asks for "a picture of <character>" the assistant can look the subject up first. Keyless sources only: DuckDuckGo Lite for web results, AniList for character records, Openverse for openly licensed concept images, and MediaWiki's API for Fandom/Wikipedia pages. Nothing fetched is ever executed; downloads are size- and type-capped and private network addresses are refused. The UI receives short snippets, source URLs and image candidates.

### `src/main/videocheck.js` <sub>(168 lines)</sub>

**Measure a rendered video clip so the assistant can check its own work.**

```text
`inspect({ fname })` returns, all in memory:
  - facts from ffprobe: duration, size, fps, audio present or not;
  - a few frames as small JPEGs at fixed points of the clip;
  - loudness from ffmpeg's volumedetect (and `silent` below -50 dB);
  - a Whisper speech transcript with language and timestamps.
Every measurement is optional on its own: a missing Whisper install just means
"audio unchecked". Dependencies are injected so tests can run it without ffmpeg.
```

---

## Main process: publishing helpers

### `src/main/da.js` <sub>(141 lines)</sub>

**DeviantArt OAuth2 + Sta.sh draft client.**

The official-API route for uploading: uploads land as private DRAFTS in the account's Sta.sh; this module never publishes anything. Requires a registered DeviantArt application; daweb.js is the alternative when none is available.

### `src/main/daweb.js` <sub>(501 lines)</sub>

**DeviantArt uploader that uses the signed-in browser session.**

```text
Does what DeviantArt's own upload page does, with the user's own cookies:
  1. upload the image     -> creates a private draft
  2. read the draft info  -> gallery folders + draft URL
  3. write the metadata   -> title, description, tags, AI-generated flag
  4. (optional) publish   -> only when the user switched "submit after upload" on
Errors are classified (retry later / signed out / final answer) so the queue
knows whether to try again.
```

### `src/main/dastats.js` <sub>(420 lines)</sub>

**Read how published artworks are doing (views, favourites, comments) from the signed-in DeviantArt session.**

Feeds the learning loop in insights.js. Strictly read-only: nothing is posted, edited or deleted. The endpoints are undocumented, so every reader tolerates shape changes: unknown fields become null instead of throwing.

### `src/main/patreon-media.js` <sub>(219 lines)</sub>

**Hand a finished file to Patreon's own upload button.**

The artist writes and publishes the post themselves; this module only saves them a trip through the file dialog. They click Patreon's upload button as usual and, instead of the Windows file picker, the file input that button opened receives the selected artwork (Chrome DevTools Protocol file-chooser interception). It never creates, schedules or publishes a post.

---

## Renderer core: state, UI shell, orchestration (`src/renderer/`)

### `src/renderer/state.js` <sub>(420 lines)</sub>

**Shared renderer state + utilities used by every module.**

`State` holds the live settings, queue and library mirrored from the main process. `U` holds helpers: robust JSON extraction from LLM answers (models wrap JSON in prose, or almost-close it), prompt normalisation, debounce, a concurrency-limited map, and `llmChat`/`llmVision`, which every AI call in the UI goes through so a provider fallback is never silent.

### `src/renderer/theme.js` <sub>(94 lines)</sub>

**Applies the colour theme before the first paint.**

Settings arrive over IPC only after the page has drawn, so a mirror in localStorage is read synchronously here to stop every launch from flashing the wrong palette. app.js re-applies the real setting once it loads.

### `src/renderer/app.js` <sub>(6,366 lines)</sub>

**UI wiring. Builds and updates every tab (Dashboard, Review, Drafts, Statistics, Settings...), connects buttons to the engines in the other modules and keeps the screen in sync with the store.**

The heavy lifting lives elsewhere (pipeline.js, overseer.js, promptlab.js...); this file turns their state into DOM. Large grids (Review) are reconciled card by card instead of rebuilt, so typing in a card never loses the caret.

### `src/renderer/pipeline.js` <sub>(3,152 lines)</sub>

**The automation orchestrator, the heart of the app.**

```text
One job = one prompt. Its path through the pipeline:
  ideate -> generate -> save -> quality check -> metadata -> Review (human)
         -> on approval: publish / upload
Generation and inspection run as two lanes in parallel: while the GPU renders
the next job, the previous batch is being checked, so neither waits for the
other. AutoMode (bottom of the file) runs rounds unattended: it picks a theme,
writes prompts, respects hourly limits and stop conditions, and rebuilds the
learned playbook as results come in.

Quality check is designed not to be a rubber stamp: the vision model must list
defects before it may score, and three independent checks in code (a general
rating, a veto on structural defects such as extra fingers, and a detail metric
measured on the pixels) can only LOWER the score, never raise it.
```

### `src/renderer/health.js` <sub>(266 lines)</sub>

**"is it working, and which engine is doing it?"**

Five plain rows, one per capability: prompt writing, metadata, image quality check, image generation, upload. Each row reports three things separately, because they fail independently: configured (what settings say), observed (what actually happened last time) and reachable (a real test call, on request). A row is never green on configuration alone.

### `src/renderer/providers.js` <sub>(701 lines)</sub>

**Settings UI for AI engines and per-role routing.**

Two panels: the engines themselves (URL + key, or a CLI command) and the routing table (which engine each role tries first, and what happens when it fails). The routing panel shows the WHOLE chain, including engines that cannot run and why, because "why is my provider not being used?" is exactly the question it exists to answer.

---

## Image and video engines

### `src/renderer/perchance.js` <sub>(685 lines)</sub>

**Drives the free Perchance web image generator inside the app's embedded browser (webview).**

Perchance has no API, so the driver operates the page like a person would: fill the description, set the style/shape/count dropdowns, press Generate, wait for the result frames, and extract the finished images. Frame access goes through the main process (webFrameMain.executeJavaScript) because the generator runs in cross-origin iframes. Every page call has a hard timeout so a hung page can never freeze the pipeline.

### `src/renderer/comfy.js` <sub>(990 lines)</sub>

**Local image and video generation through a ComfyUI server.**

The second generation engine, with the same contract as the Perchance driver: `generate(prompt, opts, log)` returns `{ images: [{ base64, mime, w, h }] }`, so everything downstream does not care which engine made the pixels. The key idea: THE WORKFLOW FILE IS THE CONFIG. Any ComfyUI graph can be used. On every job the driver re-reads the file and works out what to touch: it traces the prompt nodes back from the sampler, randomises the seed per image, and collects whatever the save nodes produce. Both of ComfyUI's file formats (API and editor, including subgraphs) are supported. If the server is not running, the driver starts it from Settings and waits for it.

---

## Writing prompts and titles

### `src/renderer/promptlab.js` <sub>(808 lines)</sub>

**Write new image prompts from an example prompt, a reference image, web research or a short story.**

```text
The trick is the SKELETON. Asking a model for "6 prompts like this one" gets the
same words back. Extracting the prompt's STRUCTURE first (which slots it fills:
subject, action, setting, light, camera, style, in what order and detail) and
then writing new prompts against that skeleton gives variety inside a
consistent style. Four modes, in increasing distance from the source:
  variations: same scene, one thing changed (pose, angle, light, setting)
  similar:    new scenes, same skeleton and voice (default)
  remix:      blend two or more examples
  evolve:     push a measured best performer further in the direction that won
Reference images are read by a vision model into a structured brief first, so a
picture nobody has words for still becomes source material.
```

### `src/renderer/promptstyle.js` <sub>(197 lines)</sub>

**The artist's own prompt "voice", measured from their prompts.**

```text
Diffusion models respond best to a compact form: comma-separated fragments, the
subject and action first, descriptive tags after, quality tokens last, no prose.
Asked to "write a prompt", most language models write an art-director paragraph
instead. This module fixes that in two steps:
  - EVIDENCE: hand the writer real example prompts plus measured facts about
    them (length, fragment count, tag habits), so it can match a form it can see;
  - ENFORCEMENT: normalise the result in code afterwards (strip a leading
    "Illustration of...", append missing quality tags).
```

### `src/renderer/variety.js` <sub>(345 lines)</sub>

**Keeps the learning loop from collapsing into one idea.**

```text
If the app always builds on its best result, three nights later every prompt is
the same scene in a different room. Four counterweights:
  1. SATURATION: a phrase that appears in most recent prompts is banned for a
     round, since it no longer explains anything;
  2. ROTATION: the example to grow from is sampled from the whole top tier with
     a cooldown, not always rank #1;
  3. AXES: concrete creative dimensions (light, lens, place, palette, weather,
     era...) with values chosen by how ABSENT they are from recent work;
  4. MODES: each round rolls exploit / explore / wild, and results are tagged so
     exploration can win on merit.
```

### `src/renderer/titles.js` <sub>(728 lines)</sub>

**Memory and imagination for artwork titles.**

```text
Language models write good titles, but the SAME good title every time ("Moonlit
Serenity", again). Two fixes:
  MEMORY: a ledger of every title already used (in Review, published, or
          discarded) with a similarity score (word overlap + character bigrams)
          that flags near-repeats;
  FORM:   a rotation of title shapes (a question, an overheard line, a place
          name...) that cannot be satisfied by swapping one adjective.
It also learns the artist's own title style from the titles they rename by hand.
```

---

## The Overseer assistant

### `src/renderer/overseer.js` <sub>(1,876 lines)</sub>

**The Overseer, a chat assistant that operates the app with tools.**

```text
Architecture: the Overseer owns no machinery of its own. Every tool is a thin
wrapper over a function a button already calls (Pipeline.ideate, AutoMode.start,
Insights.sync...), so everything it does appears in the same activity log, the
same Review grid and the same statistics as work done by hand.

Protocol: plain JSON in the model's reply, one tool per step:
  {"say": "...", "tool": "queue_art", "args": {...}, "done": false}
Not vendor function-calling, because the app also runs local models and CLI
tools that have no tools API. A small model emitting one object at a time is
far more reliable than one asked to plan a whole array of calls.

Two modes: helper (you ask, it acts, it stops) and agent (it wakes on a schedule,
reviews what happened since last time and works toward a standing brief).
```

### `src/renderer/overseerui.js` <sub>(563 lines)</sub>

**The Overseer tab: transcript, composer (with image attachments), and the switches that decide what the assistant may do on its own.**

Design rule: every tool call is shown, collapsed but always visible. An agent you cannot audit is an agent you cannot trust with a schedule, and "it said it queued ten images" is not the same as "queue_art returned queued: 10".

### `src/renderer/videocheck.js` <sub>(312 lines)</sub>

**The Overseer checks its own video before reporting back.**

```text
  1. buildChecklist() turns the request into FIXED yes/no questions, so the
     vision judge answers a list instead of writing an essay;
  2. measurements beat opinions: length from ffprobe, speech and language from
     Whisper, silence from volumedetect; only camera, action, on-screen text and
     identity go to the vision model, over a strip of timestamped frames;
  3. fixPrompt() rewrites the prompt in code for a single retry.
"unclear" never counts as passed. Pure functions, so tests run without a GPU.
```

---

## Learning loop

### `src/renderer/insights.js` <sub>(850 lines)</sub>

**Measurement and learning.**

```text
Answers three questions, each built on the last:
  1. What happened?  perf.json: real engagement per published artwork, joined
                     back to the prompt and settings that produced it.
  2. What does it imply?  breakdowns(): lift per theme / tag / prompt trait /
                     posting hour / quality band; median-based, and a group
                     needs enough samples before it counts.
  3. What should we do?  buildPlaybook(): the numbers plus short lessons written
                     by an LLM, turned by guidance() into a block that the
                     prompt writers read.
Before anything is published, the artist's own approve/reject decisions and the
quality scores act as the learning signal.
```

### `src/renderer/teach.js` <sub>(335 lines)</sub>

**The hand-written half of the playbook.**

```text
Everything in insights.js is derived and changes on every rebuild. Instructions
the artist writes by hand must survive every rebuild, so they live in a separate
section that is never overwritten and always read first:
  lessons: free-text instructions, ranked above measured lessons
  rules:   always / never constraints
  banned:  phrases a prompt must not contain; CHECKED in code, not just requested
  boost:   manual weights on themes and tags
`propose` turns a paragraph of the artist's words into structured lessons, but
only returns them. Nothing is saved without the artist accepting it.
```

### `src/renderer/origins.js` <sub>(228 lines)</sub>

**"which prompt made this published artwork?"**

Recorded at upload time from the card as it was, so deleting the card later does not lose the answer. Every entry states HOW it was matched: `upload` and `manual` are facts, `title` is an exact normalised match, `probable` is a fuzzy match that is shown clearly marked and never fed back into the learning loop.

### `src/renderer/originsui.js` <sub>(268 lines)</sub>

**The prompt archive on screen. A searchable list of everything published, and a detail view per artwork: the prompt that made it, how certain the match is (always shown in words), and the next steps: copy it, run it again, or write a continuation.**

---

## Comics, continuations, review tools

### `src/renderer/comics.js` <sub>(720 lines)</sub>

**The comic page / illustrated story builder.**

```text
The hard part is CONSISTENCY: an image generator has no memory between panels,
so panel two draws a different character unless something prevents it. Two
mechanisms, chosen per project:
  bible:  a character model sheet is written once and repeated word for word at
          the top of every panel prompt (cheap, text-only, most of the win);
  vision: additionally, each finished panel is read back by a vision model and
          what it ACTUALLY shows is carried into the next panel's prompt.
Panels are project assets, not artworks: only the composed page becomes a card
in the library.
```

### `src/renderer/comiclayout.js` <sub>(337 lines)</sub>

**Page geometry and canvas drawing for comics.**

Pure functions, no network, no models, so it is the half of the comic builder that can be tested offline. Layouts are lists of rectangles in 0..1 space, so the same template renders as a thumbnail in the editor and at full size for export. Includes word wrapping, font fitting, captions and speech bubbles.

### `src/renderer/comicsui.js` <sub>(765 lines)</sub>

**The Comics tab.**

The editor is a live preview of the REAL page composer, drawn at whatever scale fits the screen, so what you see is exactly what exports (font fitting and wrapping included). Speech bubbles are dragged directly on that canvas.

### `src/renderer/continuations.js` <sub>(298 lines)</sub>

**"someone asked for a part 2 of this one."**

A sequel is written as a NEW prompt that lands on the same character in a later moment. Inputs: the original prompt (from the archive), the request (usually a comment), and the anchors that must NOT drift (character, outfit, place). The subtle failure it guards against: asked to "continue" a scene, a model quietly replaces the subject. Optional vision mode reads the original image to capture details the prompt never stated (hair length, eye colour, exact outfit).

### `src/renderer/continuationsui.js` <sub>(419 lines)</sub>

**The Continuations tab. One screen for the whole flow: a request comes in, find the picture's prompt, decide what changes, write a prompt that keeps the character, queue it, and remember that it was done.**

### `src/renderer/triage.js` <sub>(250 lines)</sub>

**"Pick keepers", review by batch instead of by single image.**

One prompt is usually rendered several times; the real decision is "which of these rolls came out clean", not "is this one good" six times over. Siblings are shown side by side (an extra finger is obvious next to a correct hand), one key picks the keeper, and the rest are discarded, restorably, with undo. An optional AI suggestion looks at a numbered contact sheet of the batch in a single vision call. Nothing here can publish anything.

### `src/renderer/triageui.js` <sub>(509 lines)</sub>

**The "Pick keepers" full-screen overlay. Keyboard first:**

```text
  1-9, 0   toggle a tile as keeper        Enter   keep selected, discard rest
  Shift+#  view a tile full size          X/Del   discard the whole batch
  S / P    skip / back                    G / A   ask the AI / take its pick
  U        undo the last batch            Esc     close
Repaints are split so toggling a keeper never re-decodes the images.
```

### `src/renderer/teaser.js` <sub>(211 lines)</sub>

**Make a preview copy of an artwork (blurred and captioned) as a new card, paired with the original so either half can be found or undone from the other. All drawing is done on a canvas with the browser's GPU compositor; no image library is needed.**

---

## pixiv (optional, hidden by default)

### `src/renderer/pixiv.js` <sub>(640 lines)</sub>

**Pixiv uploader that runs inside the signed-in pixiv page.**

pixiv refuses requests that are not from a real browser session, so the upload runs inside the embedded pixiv tab: cookies, headers and the CSRF token are genuinely the browser's, and the request is same-origin. Everything the page returns is plain JSON, validated here. The form format was read from pixiv's own page code rather than guessed (camelCase keys, a conversion key that must be polled until the work exists).

### `src/renderer/pixivui.js` <sub>(139 lines)</sub>

**The pixiv tab: sign-in, a session check, a probe of the live upload form and the raw request/response of the last post for diagnostics.**

---

## Tests

`tools/test.mjs` (run with `npm test`) loads the real renderer files into a Node `vm`
sandbox with a stub `window`, then calls their exported functions directly. That's the
same code the app runs, without Electron. See the header of that file for what is covered.
