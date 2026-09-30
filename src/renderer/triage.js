/**
 * triage.js: "Pick keepers", review by batch instead of by single image.
 *
 * One prompt is usually rendered several times; the real decision is "which of
 * these rolls came out clean", not "is this one good" six times over. Siblings are
 * shown side by side (an extra finger is obvious next to a correct hand), one key
 * picks the keeper, and the rest are discarded, restorably, with undo.
 * An optional AI suggestion looks at a numbered contact sheet of the batch in a
 * single vision call. Nothing here can publish anything.
 */
(function () {
  const MAX_TILES = 12;
  const log = (msg, kind) => { if (window.State && State.addLog) State.addLog(msg, kind); };

  const batchKey = (c) => (c.jobId ? `job:${c.jobId}` : `card:${c.id}`);
  /** A card already judged in a previous pass: kept, and still waiting in Review. */
  const isKept = (c) => !!(c && c.triage && c.triage.kept);

  /** Contact-sheet grid for n tiles. */
  function sheetLayout(n) {
    const count = Math.max(1, Math.min(MAX_TILES, n | 0));
    const cols = count <= 3 ? count : count === 4 ? 2 : count <= 9 ? 3 : 4;
    const rows = Math.ceil(count / cols);
    const tile = count === 1 ? 1024 : count === 2 ? 768 : count === 4 ? 640 : count <= 9 ? 512 : 384;
    return { cols, rows, tile, width: cols * tile, height: rows * tile };
  }

  /** The words the vision model is given. */
  function pickPrompt(n, prompt = '') {
    const p = String(prompt || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    return [
      `This picture is a contact sheet of ${n} renders of the SAME image prompt, each tile numbered 1–${n} in its top-left corner.`,
      'The artist keeps the cleanest render and discards the rest. Judge every tile ONLY on rendering defects:',
      'hands and fingers (count them — five per visible hand), extra, missing or fused limbs, bodies merging into each other or into objects,',
      'broken faces or mismatched eyes, melted or smeared anatomy, and garbled text. Do not judge style, pose, content or composition —',
      'every tile shares one prompt, so those are not the question.',
      p ? `The shared prompt, for context only: "${p}"` : '',
      '',
      'Reply with JSON only, no prose:',
      '{"tiles":[{"n":1,"verdict":"clean|minor|broken","issue":"the worst defect in under 8 words, or none"}],"best":<number>,"keep":[<numbers>]}',
      '"tiles" has one entry per tile. "keep" lists the tiles worth keeping — normally just the best one, several only if several are',
      'genuinely clean, and an empty list if every tile is broken.',
    ].filter((l) => l !== null).join('\n');
  }

  /** Read the model's answer into { tiles: {n: {verdict, issue}}, best, keep }. */
  function parsePick(text, n) {
    const cands = (window.U && U.jsonCandidates) ? U.jsonCandidates(text || '') : [];
    let obj = null;
    for (const c of cands) {
      const v = c.value;
      if (v && typeof v === 'object' && !Array.isArray(v) && (Array.isArray(v.tiles) || v.best != null || Array.isArray(v.keep))) obj = v;
    }
    if (!obj) return null;
    const inRange = (x) => Number.isInteger(x) && x >= 1 && x <= n;
    const tiles = {};
    for (const t of Array.isArray(obj.tiles) ? obj.tiles : []) {
      const k = Number(t && (t.n ?? t.tile ?? t.id));
      if (!inRange(k)) continue;
      const v = String((t && t.verdict) || '').trim().toLowerCase();
      tiles[k] = {
        verdict: ['clean', 'minor', 'broken'].includes(v) ? v : 'unknown',
        issue: String((t && (t.issue || t.defect)) || '').trim().replace(/^none\.?$/i, '').slice(0, 120),
      };
    }
    const keep = [...new Set((Array.isArray(obj.keep) ? obj.keep : []).map(Number).filter(inRange))];
    let best = Number(obj.best);
    if (!inRange(best)) best = keep[0] || null;
    if (best && !keep.length && !(tiles[best] && tiles[best].verdict === 'broken')) keep.push(best);
    return { tiles, best, keep };
  }

  const Triage = {
    MAX_TILES,
    sheetLayout,
    pickPrompt,
    parsePick,
    isKept,

    /**
     * Every open batch: the cards of one generation job that are in `status`, with at least one of
     * them not yet judged.
     */
    batches({ status = 'review', order = 'newest' } = {}) {
      const map = new Map();
      for (const c of State.library) {
        if (!c || c.status !== status) continue;
        const key = batchKey(c);
        let b = map.get(key);
        if (!b) { b = { key, jobId: c.jobId || null, cards: [] }; map.set(key, b); }
        b.cards.push(c);
      }
      const out = [];
      for (const b of map.values()) {
        if (b.cards.every(isKept)) continue;
        b.cards.sort((a, z) => (a.createdAt || 0) - (z.createdAt || 0) || String(a.fname).localeCompare(String(z.fname)));
        if (b.cards.length > MAX_TILES) b.cards = b.cards.slice(-MAX_TILES);
        const lead = b.cards[0];
        b.prompt = lead.prompt || '';
        b.theme = lead.theme || '';
        b.promptSource = lead.promptSource || '';
        b.createdAt = Math.max(...b.cards.map((c) => c.createdAt || 0));
        out.push(b);
      }
      const dir = order === 'oldest' ? 1 : -1;
      out.sort((a, z) => (a.createdAt - z.createdAt) * dir);
      return out;
    },

    /** What to have selected when a batch first appears, and why. */
    preselect(batch) {
      const cards = batch.cards;
      const ids = new Set(cards.filter(isKept).map((c) => c.id));
      const picked = cards.filter((c) => c.pick && c.pick.keep);
      if (cards.some((c) => c.pick)) {
        picked.forEach((c) => ids.add(c.id));
        const best = cards.find((c) => c.pick && c.pick.best);
        return { ids, source: 'ai', best: best ? best.id : null };
      }
      const scored = cards.filter((c) => c.qc && typeof c.qc.score === 'number');
      if (scored.length === cards.length && scored.length) {
        const passing = scored.filter((c) => c.qc.verdict === 'PASS').sort((a, z) => z.qc.score - a.qc.score);
        if (passing.length) {
          ids.add(passing[0].id);
          return { ids, source: 'qc', best: passing[0].id };
        }
        return { ids, source: 'qc', best: null };
      }
      return { ids, source: null, best: null };
    },

    /** Keepers stay (marked) or go to Approved; everything else in the batch is discarded. */
    commit(batch, keepIds, { keepTo = 'review', aiSource = null } = {}) {
      const keep = new Set(keepIds || []);
      const at = Date.now();
      const record = { key: batch.key, at, entries: [] };
      for (const c of batch.cards) {
        record.entries.push({ card: c, status: c.status, updatedAt: c.updatedAt, triage: c.triage || null });
        const kept = keep.has(c.id);
        c.triage = { at, kept, suggested: !!(c.pick && c.pick.keep), source: aiSource };
        c.status = kept ? (keepTo === 'approved' ? 'approved' : 'review') : 'discarded';
        c.updatedAt = at;
      }
      State.persistLibrary();
      return record;
    },

    undo(record) {
      if (!record) return 0;
      for (const e of record.entries) {
        e.card.status = e.status;
        e.card.updatedAt = e.updatedAt;
        if (e.triage) e.card.triage = e.triage; else delete e.card.triage;
      }
      State.persistLibrary();
      return record.entries.length;
    },

    /** Pre-picking new batches as the worker finishes them. */
    autoPickOn() {
      return !!(State.settings && State.settings.gen && State.settings.gen.autoPick);
    },

    /** Draw the batch as one numbered image. */
    async contactSheet(cards) {
      const list = cards.slice(0, MAX_TILES);
      const L = sheetLayout(list.length);
      const canvas = document.createElement('canvas');
      canvas.width = L.width;
      canvas.height = L.height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#101010';
      ctx.fillRect(0, 0, L.width, L.height);
      ctx.imageSmoothingQuality = 'high';
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        const x = (i % L.cols) * L.tile;
        const y = Math.floor(i / L.cols) * L.tile;
        try {
          const b64 = await window.ala.files.readImageBase64(c.fname);
          const img = await new Promise((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('decode failed'));
            el.src = `data:${c.mime || 'image/png'};base64,${b64}`;
          });
          const s = Math.min(L.tile / img.naturalWidth, L.tile / img.naturalHeight);
          const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
          ctx.drawImage(img, x + Math.round((L.tile - w) / 2), y + Math.round((L.tile - h) / 2), w, h);
        } catch {
          ctx.fillStyle = '#402020';
          ctx.fillRect(x, y, L.tile, L.tile);
        }
        const fs = Math.round(L.tile * 0.11);
        ctx.fillStyle = 'rgba(0,0,0,0.78)';
        ctx.fillRect(x + 6, y + 6, fs * 1.5, fs * 1.35);
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${fs}px sans-serif`;
        ctx.textBaseline = 'top';
        ctx.fillText(String(i + 1), x + 6 + fs * 0.3, y + 6 + fs * 0.18);
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, L.tile - 2, L.tile - 2);
      }
      const url = canvas.toDataURL('image/jpeg', 0.9);
      return { base64: url.split(',')[1], mime: 'image/jpeg', layout: L };
    },

    /**
     * Ask the vision model which rolls are clean, and write the answer onto the cards as
     * `card.pick`.
     */
    async suggest(batch) {
      const cards = batch.cards.slice(0, MAX_TILES);
      const sheet = await this.contactSheet(cards);
      const r = await U.llmVision(sheet.base64, sheet.mime, pickPrompt(cards.length, batch.prompt),
        { role: 'vision' }, 'Picking the keeper');
      const pick = parsePick(r && r.text, cards.length);
      if (!pick) throw new Error('the vision model did not answer in the expected shape');
      const at = Date.now();
      cards.forEach((c, i) => {
        const t = pick.tiles[i + 1] || { verdict: 'unknown', issue: '' };
        c.pick = {
          at, n: i + 1,
          keep: pick.keep.includes(i + 1),
          best: pick.best === i + 1,
          verdict: t.verdict, issue: t.issue,
          engine: (r && (r.provider || r.engine)) || '', model: (r && r.model) || '',
        };
      });
      State.persistLibrary({ quiet: true });
      return pick;
    },

    /** The worker's hook: pre-pick the batch a job just produced, if there is a choice to make. */
    async suggestForJob(jobId) {
      const cards = State.library.filter((c) => c.jobId === jobId && c.status === 'review' && !c.pick);
      if (cards.length < 2) return null;
      const batch = this.batches({ status: 'review' }).find((b) => b.jobId === jobId);
      if (!batch) return null;
      const pick = await this.suggest(batch);
      log(pick.keep.length
        ? `Pre-picked the keeper${pick.keep.length > 1 ? 's' : ''} of ${batch.cards.length}: #${pick.keep.join(', #')} — confirm in Review → Pick keepers.`
        : `All ${batch.cards.length} renders of that prompt look broken to the inspector — Pick keepers will offer to discard them.`);
      return pick;
    },
  };

  window.Triage = Triage;
})();
