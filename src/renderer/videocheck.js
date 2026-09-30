/**
 * videocheck.js (renderer): the Overseer checks its own video before reporting
 * back.
 *   1. buildChecklist() turns the request into FIXED yes/no questions, so the
 *      vision judge answers a list instead of writing an essay;
 *   2. measurements beat opinions: length from ffprobe, speech and language from
 *      Whisper, silence from volumedetect; only camera, action, on-screen text and
 *      identity go to the vision model, over a strip of timestamped frames;
 *   3. fixPrompt() rewrites the prompt in code for a single retry.
 * "unclear" never counts as passed. Pure functions, so tests run without a GPU.
 */
(() => {
  const NEG = String.raw`(?:no|not|don['’]?t|dont|do not|never|without|stop|avoid|zero)`;
  const negated = (text, word) => new RegExp(String.raw`\b${NEG}\b[^.,;!?\n]{0,24}\b${word}`, 'i').test(text);
  const LANGS = {
    english: 'en', japanese: 'ja', polish: 'pl', spanish: 'es', french: 'fr', german: 'de',
    korean: 'ko', chinese: 'zh', mandarin: 'zh', italian: 'it', portuguese: 'pt', russian: 'ru',
  };
  const LANG_NAME = Object.fromEntries(Object.entries(LANGS).map(([k, v]) => [v, k[0].toUpperCase() + k.slice(1)]));
  const SPEECH_RE = /\b(say|says|saying|said|speak|speaks|speaking|talk|talks|talking|dialogue|dialog|sentences?|lines?|voice|voiced|words?)\b/i;
  const LENGTH_TOLERANCE = 0.75;

  /** `<d>[English] words</d>` lines in a written H3 prompt. */
  function dialogueIn(prompt) {
    const out = [];
    const re = /<d>\s*(?:\[([A-Za-z]+)\])?\s*([\s\S]*?)<\/d>/gi;
    let m;
    while ((m = re.exec(String(prompt || '')))) out.push({ lang: m[1] ? (LANGS[m[1].toLowerCase()] || m[1].toLowerCase()) : null, words: m[2].trim() });
    return out;
  }

  /** Quoted words in his request ("say 'wow, look at me'") — what the clip must say. */
  function quotedWords(text) {
    const out = [];
    const re = /["“”']([^"“”']{4,200})["“”']/g;
    let m;
    while ((m = re.exec(String(text || '')))) if (/\s/.test(m[1].trim())) out.push(m[1].trim());
    return out;
  }

  const COMPLAINT_RE = /\byou\b[^.!?\n,]{0,24}\b(did|added|made|used|gave|put|zoomed|kept|still)\b/i;
  function splitComplaints(text) {
    const clauses = String(text || '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
    return {
      wanted: clauses.filter((c) => !COMPLAINT_RE.test(c)).join('\n'),
      unwanted: clauses.filter((c) => COMPLAINT_RE.test(c)).join('\n'),
    };
  }

  function buildChecklist({ request = '', instructions = '', prompt = '', seconds = null } = {}) {
    const full = String(request || '');
    const { wanted: req, unwanted } = splitComplaints(full);
    const said = dialogueIn(prompt);
    const complained = (word) => new RegExp(`\\b${word}`, 'i').test(unwanted);
    const checks = [];
    const add = (id, ask, by, extra = {}) => checks.push({ id, ask, by, ...extra });

    const secs = Number(seconds);
    if (secs > 0) add('length', `the clip is ${secs} s long`, 'ffprobe', { expect: secs });

    const wantsSilent = /\b(silent|silence|mute[d]?)\b/i.test(req) || negated(req, '(?:sound|audio)');
    const speechNegated = negated(req, '(?:voice|speech|speak\\w*|talk\\w*|dialog\\w*|narration|words)')
      || (complained('(?:voice|speech|speak\\w*|talk\\w*|dialog\\w*)') && !/\b(english|polish|spanish|french|german|korean|say|says|sentences?|lines?)\b/i.test(req));
    const speechAsked = !speechNegated && !wantsSilent && (SPEECH_RE.test(req.replace(new RegExp(String.raw`\b${NEG}\b[^.,;!?\n]{0,24}`, 'gi'), '')) || said.length > 0);
    let lang = null;
    for (const [name, code] of Object.entries(LANGS)) {
      if (new RegExp(`\\b${name}\\b`, 'i').test(req) && !negated(req, name) && !complained(name)) { lang = code; break; }
    }
    if (!lang && said.length && said[0].lang) lang = said[0].lang;
    if (speechAsked && !lang) lang = 'en';

    if (wantsSilent) add('silent', 'the clip is silent', 'volumedetect');
    else if (speechAsked) {
      add('language', `the spoken words are in ${LANG_NAME[lang] || lang}`, 'whisper', { expect: lang });
      const words = quotedWords(req)[0] || (said[0] && said[0].words) || '';
      if (words) add('words', `the character says "${words.slice(0, 160)}"`, 'whisper', { expect: words });
    } else {
      add('no_speech', 'nobody speaks (ambient sounds only)', 'whisper');
    }

    const wantsText = /\b(caption|subtitle|title card|on-screen text|text on screen|sign that says)\b/i.test(req) && !negated(req, '(?:text|caption|subtitle|lettering)');
    if (!wantsText) add('text', 'no subtitles, captions or new lettering appear (a signature already in the source picture does not count)', 'vision');

    const cameraAsked = /\b(zoom\w*|static|still camera|locked|push[- ]?in|dolly|wide shot|camera|framing|reframe|crop\w*)\b/i.test(full)
      || /The camera holds a static shot/i.test(prompt);
    const moveAsked = /\b(zoom(?:s|ing)? in|push(?:es)?[- ]in|dolly|pan|orbit|track)\b/i.test(req) && !negated(req, '(?:zoom|push|dolly|pan|orbit|track|mov)');
    if (cameraAsked && !moveAsked) add('camera', 'the camera stays static — the last frame has the same framing as the first', 'vision');

    const action = actionWords(String(instructions || '').trim() || req);
    if (action) add('action', `the requested action is visible: ${action}`, 'vision', { expect: action });
    add('identity', 'the character keeps the same face, hair and outfit from first frame to last', 'vision');
    return checks;
  }

  /** His motion words with the camera/audio/negation clauses stripped — what should HAPPEN. */
  function actionWords(req) {
    const FILLER = /^(again|redo|remake|please|ok|okay|pls|hot|good|nice|better|high quality|also)$/i;
    return splitComplaints(req).wanted.replace(/["“”'‘’][^"“”'‘’]{2,200}["“”'‘’]/g, ' ')
      .split(/(?<=[.!?\n])\s+|,\s*(?:and\s+)?|\band\b|\+/i)
      .map((s) => s.trim()
        .replace(/^(?:(?:please|now|ok|also|but)\s+)*(?:(?:make|create|render|do|give me|try)\s+)?(?:(?:a|an|the|another|new)\s+)?(?:video|clip|animation|version)\s*(?:of|where|with|in which)?\s*/i, '')
        .replace(/[.!?]+$/, '').trim())
      .filter((s) => s && !FILLER.test(s) && !new RegExp(String.raw`\b${NEG}\b`, 'i').test(s)
        && !/\b(camera|zoom\w*|static|locked|shot|voice|speech|speak\w*|say\w*|sentences?|english|japanese|language|audio|sound|silent|text|subtitles?|captions?|quality|quiality|general|redo|again|remake|render|seconds?|longer|shorter|image|picture|photo|reference|refference|start|card)\b/i.test(s))
      .join(', ')
      .slice(0, 300);
  }

  const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);

  /** The checks a measurement answers. */
  function measured(check, facts) {
    const t = facts.transcript || {};
    const heard = (t.segments || []).map((s) => s.text).join(' ').trim();
    const heardLine = heard ? `heard [${t.language || '?'} ${t.prob != null ? Math.round(t.prob * 100) + '%' : ''}] "${heard.slice(0, 160)}"` : 'no speech heard';
    switch (check.id) {
      case 'length': {
        const d = Number(facts.duration) || 0;
        return { met: Math.abs(d - check.expect) <= LENGTH_TOLERANCE, evidence: `ffprobe: ${d.toFixed(2)} s` };
      }
      case 'silent': {
        const a = facts.audio || {};
        if (!a.ok) return { met: 'unclear', evidence: `loudness unreadable (${a.error || 'no reading'})` };
        return { met: !!a.silent, evidence: a.maxDb == null ? 'no audio signal' : `peak ${a.maxDb} dB, mean ${a.meanDb} dB` };
      }
      case 'language':
      case 'words':
      case 'no_speech': {
        if (!t.ok) return { met: 'unclear', evidence: `audio not transcribed: ${t.error || 'Whisper unavailable'}` };
        const chars = heard.replace(/[\s.…,!?-]/g, '').length;
        if (check.id === 'no_speech') return { met: chars < 3, evidence: heardLine };
        if (chars < 3) return { met: false, evidence: 'no speech heard' };
        if (check.id === 'language') return { met: t.language === check.expect, evidence: heardLine };
        const want = norm(check.expect);
        const got = new Set(norm(heard));
        const hit = want.filter((w) => got.has(w)).length;
        const recall = want.length ? hit / want.length : 0;
        return { met: recall >= 0.6 ? true : recall >= 0.3 ? 'unclear' : false, evidence: `${heardLine} — ${hit}/${want.length} expected words` };
      }
      default: return null;
    }
  }

  /** The vision judge's prompt: yes = met, over a strip of frames labelled with their time. */
  function judgePrompt(checks, times) {
    const qs = {
      text: 'Is the clip free of NEW text: no subtitle, caption or lettering appears in any frame that was not already in the first frame? A signature, watermark or logo already visible in the first frame belongs to the source picture and does NOT count.',
      camera: 'Is the framing the same in the first and the last frame: same shot size, the subject at the same size and position, no zoom-in, push-in or re-crop?',
      action: (c) => `Does the clip show this action: ${JSON.stringify(c.expect)}? Answer from what changes across the frames.`,
      identity: 'Is it the same character in every frame: same face, hair, body and outfit colours?',
    };
    const vis = checks.filter((c) => c.by === 'vision');
    return [
      `This picture is a strip of ${times.length} frames from ONE video clip, left to right in time order: ${times.map((t) => t + ' s').join(', ')}.`,
      'Answer each question strictly from what is visible. "unclear" is allowed when the frames cannot show it — never guess yes.',
      '',
      ...vis.map((c) => `${c.id}: ${typeof qs[c.id] === 'function' ? qs[c.id](c) : qs[c.id]}`),
      '',
      'Respond with ONLY JSON: {"checks":[{"id":"<id>","answer":"yes|no|unclear","evidence":"<what you see, one short sentence, name the frame times>"}]}',
    ].join('\n');
  }

  function parseJudge(text, checks) {
    let j = null;
    try { j = U.extractJson(text); } catch { }
    const rows = j && Array.isArray(j.checks) ? j.checks : [];
    const out = {};
    for (const c of checks.filter((x) => x.by === 'vision')) {
      const r = rows.find((x) => x && String(x.id) === c.id);
      const a = r ? String(r.answer || '').toLowerCase().trim() : '';
      out[c.id] = {
        met: a === 'yes' ? true : a === 'no' ? false : 'unclear',
        evidence: r && r.evidence ? String(r.evidence).slice(0, 240) : (j ? 'the judge did not answer this one' : 'the judge reply was not readable'),
      };
    }
    return out;
  }

  const FIX = {
    camera: 'The camera holds a static shot for the entire clip: the framing in the final second is identical to the first frame, with the subject at the same size and position.',
    text: 'The frame shows only the scene from the picture, clean from the first second to the last.',
    no_speech: 'The soundscape carries only footsteps, rustling and ambient room tone, and the character\u2019s lips stay relaxed.',
    silent: 'The clip is completely silent.',
    identity: 'The character keeps the exact face, hair, body and outfit colours of the first frame throughout.',
  };
  const CAMERA_MOVE_RE = /[^.\n]*\bThe camera (?:pushes|pulls|dollies|zooms|moves|tracks|pans|orbits|tilts|slowly)[^.\n]*\.\s*/gi;

  function fixPrompt(prompt, failed, { request = '' } = {}) {
    let p = String(prompt || '');
    const ids = new Set(failed.map((c) => c.id));
    const add = [];
    if (ids.has('camera')) { p = p.replace(CAMERA_MOVE_RE, ''); add.push(FIX.camera); }
    if (ids.has('text')) add.push(FIX.text);
    if (ids.has('identity')) add.push(FIX.identity);
    if (ids.has('no_speech') || ids.has('silent')) {
      p = p.replace(/[^.\n]*<d>[\s\S]*?<\/d>[^.\n]*\.?\s*/gi, '');
      add.push(ids.has('silent') ? FIX.silent : FIX.no_speech);
    }
    const langCheck = failed.find((c) => c.id === 'language') || failed.find((c) => c.id === 'words');
    if (langCheck) {
      const code = (failed.find((c) => c.id === 'language') || {}).expect || 'en';
      const name = LANG_NAME[code] || 'English';
      p = p.replace(/<d>\s*(?:\[[A-Za-z]+\]\s*)?/gi, `<d>[${name}] `);
      const words = (failed.find((c) => c.id === 'words') || {}).expect;
      add.push(words && !/<d>/i.test(p)
        ? `The character speaks clearly in ${name}, saying: <d>[${name}] ${words}</d>`
        : `Every spoken word is in ${name}, spoken clearly with an ${name} accent.`);
    }
    if (ids.has('action')) {
      const a = failed.find((c) => c.id === 'action').expect;
      if (a) add.push(`The action is clearly visible and continuous through the clip: ${a}.`);
    }
    if (!add.length) return p;
    const fix = add.join(' ');
    const label = /integrated_multimodal_description:\s*/i.exec(p);
    if (label) return p.slice(0, label.index + label[0].length) + fix + ' ' + p.slice(label.index + label[0].length);
    const first = p.indexOf('\n');
    return first > 0 ? `${p.slice(0, first)}\n\n${fix}\n${p.slice(first)}` : `${fix}\n\n${p}`;
  }

  /** Merge measurements and the judge into one verdict. */
  function verdict(checks, facts, judged) {
    const rows = checks.map((c) => {
      const r = c.by === 'vision' ? (judged[c.id] || { met: 'unclear', evidence: 'not judged' }) : measured(c, facts);
      return { id: c.id, ask: c.ask, by: c.by, expect: c.expect, met: r.met, evidence: r.evidence };
    });
    const met = rows.filter((r) => r.met === true).length;
    const unmet = rows.filter((r) => r.met === false);
    const unclear = rows.filter((r) => r.met === 'unclear');
    return {
      checks: rows, met, total: rows.length, failed: unmet.length, unclear: unclear.length,
      summary: `${met}/${rows.length} met${unmet.length ? `, ${unmet.length} missed` : ''}${unclear.length ? `, ${unclear.length} unclear` : ''}`,
    };
  }

  /** One line per check, for the chat. */
  function report(v, label = '') {
    const mark = (m) => (m === true ? '✓' : m === false ? '✗' : '?');
    return `${label}${v.summary}\n` + v.checks.map((c) => `${mark(c.met)} ${c.ask} — ${c.evidence}`).join('\n');
  }

  /** A horizontal strip of the frames with their timestamps (canvas; replaced in tests). */
  async function sheet(frames) {
    const tile = 320;
    const canvas = document.createElement('canvas');
    canvas.width = tile * frames.length;
    canvas.height = tile;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#101010';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('frame decode failed'));
        el.src = `data:${f.mime || 'image/jpeg'};base64,${f.base64}`;
      });
      const s = Math.min(tile / img.naturalWidth, tile / img.naturalHeight);
      const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
      ctx.drawImage(img, i * tile + Math.round((tile - w) / 2), Math.round((tile - h) / 2), w, h);
      ctx.strokeStyle = '#000';
      ctx.strokeRect(i * tile + 0.5, 0.5, tile - 1, canvas.height - 1);
    }
    const url = canvas.toDataURL('image/jpeg', 0.88);
    return { base64: url.split(',')[1], mime: 'image/jpeg' };
  }

  /** Measure + judge one saved clip. */
  async function check({ fname, request, instructions = '', prompt, seconds, log = () => {} }) {
    const checks = buildChecklist({ request, instructions, prompt, seconds });
    let facts;
    try {
      facts = await window.ala.comfy.inspectVideo({ fname, frames: 5 });
    } catch (e) {
      const why = `the clip could not be inspected: ${e.message}`;
      log(`Self-check: ${why}`);
      return { ...verdict(checks, { transcript: { ok: false, error: why }, audio: { ok: false, error: why }, duration: NaN }, {}), error: why, at: Date.now() };
    }
    let judged = {};
    let engine = null;
    if (checks.some((c) => c.by === 'vision')) {
      if (!facts.frames || !facts.frames.length) {
        judged = {};
      } else {
        try {
          const strip = await VideoCheck.sheet(facts.frames);
          const r = await U.llmVision(strip.base64, strip.mime, judgePrompt(checks, facts.frames.map((f) => f.t)), { role: 'vision', temperature: 0.1 }, 'Checking the video');
          engine = r.engine || r.provider || null;
          judged = parseJudge(r.text, checks);
        } catch (e) {
          log(`Self-check: the vision judge failed (${e.message}); frame checks are unclear.`);
          for (const c of checks.filter((x) => x.by === 'vision')) judged[c.id] = { met: 'unclear', evidence: `vision judge failed: ${e.message}` };
        }
      }
    }
    const v = verdict(checks, facts, judged);
    const t = facts.transcript || {};
    return {
      ...v, at: Date.now(), judge: engine, duration: facts.duration, frames: (facts.frames || []).map((f) => f.t),
      transcript: t.ok ? { language: t.language, prob: t.prob, text: (t.segments || []).map((s) => s.text).join(' ').slice(0, 400) } : { error: t.error || 'not transcribed' },
    };
  }

  const VideoCheck = {
    buildChecklist, dialogueIn, quotedWords, actionWords, measured, judgePrompt, parseJudge, fixPrompt, verdict, report, sheet, check,
    LENGTH_TOLERANCE, FIX,
    /** Retry only on a definite miss the prompt can fix — length is a workflow input, not wording. */
    retryable: (v) => v.checks.filter((c) => c.met === false && c.id !== 'length'),
  };
  window.VideoCheck = VideoCheck;
})();
