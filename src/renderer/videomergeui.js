/**
 * videomergeui.js: the Video Merge tab.
 *
 * Pick pictures (library, file, drop or paste), set the second each one is reached, write the
 * prompt (Auto: a vision model describes every picture and writes the change; Hybrid: your
 * direction plus that; Custom: your own words) and render through the same ComfyUI video
 * workflow as Convert to video. A finished merge becomes a new card in Review.
 */
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => U.escapeHtml(String(s == null ? '' : s));
  const toast = (m, k) => (window.toast ? window.toast(m, k) : console.log(m));
  const SESSION_KEY = 'ala.videoMerge.session';
  const HISTORY_KEY = 'ala.videoMerge.history';
  const VM = () => window.VideoMerge;

  let frames = [];
  let landEnd = true;
  let seconds = 10;
  let aspect = 'auto';
  let mode = 'auto';
  let words = '';
  let prompt = '';
  let busy = false;
  let history = [];
  let uid = 0;
  const bytes = new Map();
  const logLines = [];

  const mimeOf = (name) => (/\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.webp$/i.test(name) ? 'image/webp' : 'image/png');
  const letter = (i) => String.fromCharCode(65 + i);
  const fmt = (n) => (Number.isInteger(n) ? String(n) : Number(n).toFixed(1));
  const comfyOn = () => !!State.settings?.comfy?.videoWorkflow;

  function decodeSize(url) {
    return new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => resolve({ w: 0, h: 0 });
      im.src = url;
    });
  }
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(new Error('could not read the file'));
      r.readAsDataURL(file);
    });
  }

  const ui = {
    wire() {
      const pane = $('#pane-videomerge');
      if (!pane) return;
      this.restore();
      $('#vm-add-card').addEventListener('click', () => this.openPicker());
      $('#vm-upload').addEventListener('click', () => $('#vm-file').click());
      $('#vm-file').addEventListener('change', async (e) => { await this.addFiles([...(e.target.files || [])]); e.target.value = ''; });
      pane.addEventListener('dragover', (e) => e.preventDefault());
      pane.addEventListener('drop', async (e) => {
        e.preventDefault();
        await this.addFiles([...(e.dataTransfer?.files || [])].filter((f) => /^image\//.test(f.type)));
      });
      const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      document.addEventListener('paste', async (e) => {
        if (!pane.classList.contains('active') || typing(e.target)) return;
        const files = [...(e.clipboardData?.items || [])].filter((x) => /^image\//.test(x.type)).map((x) => x.getAsFile()).filter(Boolean);
        if (files.length) { e.preventDefault(); await this.addFiles(files); }
      });
      $('#vm-strip').addEventListener('click', (e) => this.onStrip(e));
      $('#vm-strip').addEventListener('change', (e) => this.onTime(e));
      $('#vm-seconds').addEventListener('change', (e) => {
        seconds = Math.min(VM().MAX_SECONDS, Math.max(VM().MIN_SECONDS, Number(e.target.value) || 10));
        e.target.value = seconds;
        frames = VM().retime(frames, seconds, landEnd);
        this.changed();
      });
      $('#vm-aspect').addEventListener('change', (e) => { aspect = e.target.value; this.save(); });
      $('#vm-land').addEventListener('change', (e) => { landEnd = e.target.checked; frames = VM().retime(frames, seconds, landEnd); this.changed(); });
      $('#vm-mode').addEventListener('change', (e) => { mode = e.target.value; this.renderControls(); this.save(); });
      $('#vm-words').addEventListener('input', (e) => { words = e.target.value; this.renderControls(); this.save(); });
      $('#vm-prompt').addEventListener('input', (e) => { prompt = e.target.value; this.renderControls(); this.save(); });
      $('#vm-write').addEventListener('click', () => this.writePrompt());
      $('#vm-render').addEventListener('click', () => this.render_());
      $('#vm-hist').addEventListener('click', (e) => this.onHistory(e));
      State.on('library', () => this.pruneMissing());
      this.fillAspects();
      this.render();
    },

    render() {
      $('#vm-engine').hidden = comfyOn();
      $('#vm-engine').textContent = 'No video workflow is set — pick one in Settings → Generation (Local image generation).';
      $('#vm-seconds').value = seconds;
      $('#vm-aspect').value = aspect;
      $('#vm-land').checked = landEnd;
      $('#vm-mode').value = mode;
      $('#vm-words').value = words;
      $('#vm-prompt').value = prompt;
      this.renderStrip();
      this.renderControls();
      this.renderHistory();
    },

    fillAspects() {
      const opts = [['auto', 'Follow picture 1 (recommended)'], ...window.ComfyUI.ASPECTS.map(([l]) => [l, l])];
      $('#vm-aspect').innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
    },

    async add(src, dims) {
      if (frames.length >= VM().MAX_PICTURES) return toast(`At most ${VM().MAX_PICTURES} pictures in one clip.`, 'err');
      const d = dims && dims.w ? dims : await decodeSize(src.url);
      frames.push({ key: 'f' + (++uid) + '-' + Date.now(), src, w: d.w, h: d.h, at: 0, manual: false });
      frames = VM().retime(frames, seconds, landEnd);
      this.changed();
    },
    async addCard(card) {
      if (!card || !card.fname) return;
      await this.add({ kind: 'card', id: card.id, fname: card.fname, url: card.url, name: (card.metadata && card.metadata.title) || card.fname },
        { w: Number(card.width) || 0, h: Number(card.height) || 0 });
    },
    async addFiles(files) {
      for (const f of files) {
        if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { toast(`${f.name || 'that file'} is not a PNG, JPEG or WebP picture.`, 'err'); continue; }
        try {
          const base64 = await fileToBase64(f);
          const saved = await window.ala.files.saveAttachment(base64, f.type, f.name || 'merge');
          await this.add({ kind: 'file', fname: saved.fname, url: saved.url, name: f.name || saved.fname });
          bytes.set(frames[frames.length - 1].key, { base64, mime: saved.mime || f.type });
        } catch (e) { toast('Could not add the picture: ' + e.message, 'err'); }
      }
    },
    async bytesOf(f) {
      if (bytes.has(f.key)) return bytes.get(f.key);
      const r = await this.srcBytes(f.src);
      bytes.set(f.key, r);
      return r;
    },
    async srcBytes(src) {
      if (src.kind === 'card' || src.kind === 'img') return { base64: await window.ala.files.readImageBase64(src.fname), mime: mimeOf(src.fname) };
      const a = await window.ala.files.readAttachment(src.fname);
      return { base64: a.base64, mime: a.mime || mimeOf(src.fname) };
    },
    pruneMissing() {
      const ids = new Set((State.library || []).map((c) => c.id));
      const live = history.filter((h) => !h.cardId || ids.has(h.cardId));
      if (live.length !== history.length) { history = live; this.saveHistory(); }
      this.renderHistory();
      if (!frames.some((f) => f.src.kind === 'card')) return;
      const keep = frames.filter((f) => f.src.kind !== 'card' || ids.has(f.src.id));
      if (keep.length !== frames.length) { frames = VM().retime(keep, seconds, landEnd); this.changed(); }
    },
    changed() { this.renderStrip(); this.renderControls(); this.save(); },

    onStrip(e) {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const i = Number(b.dataset.i);
      if (b.dataset.act === 'rm') frames.splice(i, 1);
      else if (b.dataset.act === 'left' && i > 0) [frames[i - 1], frames[i]] = [frames[i], frames[i - 1]];
      else if (b.dataset.act === 'right' && i < frames.length - 1) [frames[i + 1], frames[i]] = [frames[i], frames[i + 1]];
      else if (b.dataset.act === 'add') return this.openPicker();
      else if (b.dataset.act === 'zoom') return this.zoom(frames[i]);
      else return;
      frames = VM().retime(frames.map((f) => ({ ...f, manual: false })), seconds, landEnd);
      this.changed();
    },
    onTime(e) {
      const inp = e.target.closest('input[data-time]');
      if (!inp) return;
      const i = Number(inp.dataset.time);
      const v = VM().round(Number(inp.value));
      if (!Number.isFinite(v)) return;
      frames[i].at = v; frames[i].manual = true;
      this.changed();
    },

    renderStrip() {
      const strip = $('#vm-strip');
      if (!frames.length) {
        strip.innerHTML = `<div class="vm-empty">Add at least two pictures — from the library, an upload, drop or paste — or press <b>⇄ Merge</b> on a card in Review.</div>`;
        $('#vm-timeline').innerHTML = '';
        return;
      }
      const T = seconds;
      const parts = frames.map((f, i) => {
        const isEnd = landEnd && i === frames.length - 1 && i > 0;
        const when = i === 0 ? '<span class="vm-when">opens the clip · 0 s</span>'
          : isEnd ? `<span class="vm-when">last frame · ${fmt(T)} s</span>`
            : `<label class="vm-when">at <input type="number" data-time="${i}" min="0.5" max="${T - 0.5}" step="0.5" value="${fmt(Number(f.at))}" /> s</label>`;
        return `<div class="vm-frame" data-i="${i}">
          <div class="vm-thumb" data-act="zoom" data-i="${i}" title="Click to see it big"><img src="${esc(f.src.url)}" alt="" draggable="false" /><span class="vm-letter">${letter(i)}</span></div>
          <div class="vm-name" title="${esc(f.src.name)}">${esc(f.src.name)}</div>
          ${when}
          <div class="vm-btns">
            <button class="btn ghost small" data-act="left" data-i="${i}" ${i === 0 ? 'disabled' : ''} title="Move earlier">◀</button>
            <button class="btn ghost small" data-act="right" data-i="${i}" ${i === frames.length - 1 ? 'disabled' : ''} title="Move later">▶</button>
            <button class="btn ghost small" data-act="rm" data-i="${i}" title="Remove">✕</button>
          </div>
        </div>`;
      });
      const add = frames.length < VM().MAX_PICTURES ? `<button class="vm-addtile" data-act="add" title="Add another picture">＋<span>Add</span></button>` : '';
      strip.innerHTML = parts.join('<div class="vm-arrow">→</div>') + (add ? '<div class="vm-arrow">→</div>' + add : '');
      const dots = frames.map((f, i) => {
        const at = i === 0 ? 0 : (landEnd && i === frames.length - 1) ? T : Number(f.at);
        const pct = Math.max(0, Math.min(100, (at / T) * 100));
        return `<span class="vm-dot" style="left:${pct}%" title="${letter(i)} at ${fmt(at)} s">${letter(i)}</span>`;
      });
      $('#vm-timeline').innerHTML = `<div class="vm-tl-bar"></div>${dots.join('')}<span class="vm-tl-end">${fmt(T)} s</span>`;
    },

    renderControls() {
      const chk = VM().check(frames, seconds, landEnd);
      const on = comfyOn();
      const st = $('#vm-status');
      if (!busy) {
        st.className = 'hint' + (chk.ok ? '' : ' err');
        st.textContent = chk.ok
          ? `${VM().describe(frames, landEnd)} · about ${VM().estimateSeconds(seconds)} s to render on the GPU`
          : chk.error;
      }
      const custom = mode === 'custom';
      $('#vm-words-wrap').hidden = mode === 'auto';
      $('#vm-write').textContent = custom ? 'Use my words as the prompt' : 'Write prompt';
      $('#vm-write').disabled = busy || !chk.ok || !on || (mode !== 'auto' && !words.trim());
      $('#vm-render').disabled = busy || !chk.ok || !on || !prompt.trim();
      for (const id of ['#vm-seconds', '#vm-aspect', '#vm-land', '#vm-mode', '#vm-add-card', '#vm-upload']) $(id).disabled = busy;
    },

    timeline() {
      return frames.map((f, i) => ({ f, at: i === 0 ? 0 : (landEnd && i === frames.length - 1) ? 'end' : Number(f.at) }));
    },
    async writePrompt() {
      if (busy) return;
      const chk = VM().check(frames, seconds, landEnd);
      if (!chk.ok) return toast(chk.error, 'err');
      busy = true; this.renderControls();
      const st = $('#vm-status');
      try {
        if (mode === 'custom') {
          prompt = words.trim();
          if (!prompt) throw new Error('type your prompt first');
        } else {
          st.className = 'hint'; st.textContent = 'Looking at the pictures and writing the prompt…';
          const tl = this.timeline();
          const fr = [];
          for (const t of tl) { const b = await this.bytesOf(t.f); fr.push({ base64: b.base64, mime: b.mime, at: t.at }); }
          const r = await window.ComfyUI.writeMergePrompt({ frames: fr, userText: words, mode, seconds });
          prompt = r.prompt;
        }
        $('#vm-prompt').value = prompt;
        st.className = 'hint'; st.textContent = 'Prompt ready — edit it if you like, then Render.';
      } catch (e) {
        st.className = 'hint err'; st.textContent = 'Could not write the prompt: ' + e.message;
      } finally { busy = false; this.renderControls(); this.save(); }
    },

    log(m) {
      logLines.push(m);
      if (logLines.length > 40) logLines.shift();
      const el = $('#vm-log'); if (el) { el.textContent = logLines.join('\n'); el.scrollTop = el.scrollHeight; }
    },

    async render_() {
      if (busy) return;
      const chk = VM().check(frames, seconds, landEnd);
      if (!chk.ok) return toast(chk.error, 'err');
      if (!prompt.trim()) return toast('The prompt box is empty — press Write prompt first.', 'err');
      busy = true; this.renderControls();
      const st = $('#vm-status');
      st.className = 'hint';
      st.textContent = 'Rendering — a few minutes on the GPU. You can leave this tab; the clip appears below when it is done.';
      logLines.length = 0; this.log('Reading the pictures…');
      const snapshot = frames.map((f) => ({ src: f.src, at: f.at, w: f.w, h: f.h }));
      const snapEnd = landEnd, snapSeconds = seconds, snapPrompt = prompt.trim(), snapAspect = aspect;
      try {
        const tl = this.timeline();
        const first = await this.bytesOf(tl[0].f);
        const rest = [];
        for (let i = 1; i < tl.length; i++) { const b = await this.bytesOf(tl[i].f); rest.push({ base64: b.base64, mime: b.mime, at: tl[i].at }); }
        const d = new window.ComfyDriver(State.settings);
        const res = await d.convertToVideo({
          base64: first.base64, mime: first.mime, prompt: snapPrompt, seconds: snapSeconds, frames: rest,
          aspect: snapAspect, size: { w: tl[0].f.w, h: tl[0].f.h }, nameHint: 'merge',
          log: (m) => { State.addLog(m, 'comfy'); this.log(m); },
        });
        const card = await this.record({ res, prompt: snapPrompt, seconds: snapSeconds, aspect: snapAspect, landEnd: snapEnd, frames: snapshot, poster: first });
        st.className = 'hint'; st.textContent = `Done — ${(res.size / 1048576).toFixed(1)} MB. ${card ? 'It is a new card in Review, and' : 'It is'} the first clip below.`;
        toast(card ? 'Merged video ready — new card in Review.' : 'Merged video ready.', 'ok');
      } catch (e) {
        st.className = 'hint err'; st.textContent = 'Render failed: ' + e.message;
        this.log('FAILED: ' + e.message);
      } finally { busy = false; this.renderControls(); this.renderHistory(); }
    },

    async record({ res, prompt, seconds, aspect, landEnd, frames, poster }) {
      let card = null;
      try { card = await this.makeCard({ res, prompt, frames, poster }); } catch (e) {
        toast('The clip is saved, but no Review card was made: ' + e.message, 'err');
      }
      history = VM().pushHistory(history, {
        id: 'm' + Date.now(), cardId: card ? card.id : null, fname: res.fname, url: res.url, size: res.size,
        gif: res.gif ? { fname: res.gif.fname, url: res.gif.url, size: res.gif.size } : null,
        prompt, seconds, aspect, landEnd, at: Date.now(),
        frames: frames.map((f) => ({ src: f.src, at: f.at, w: f.w, h: f.h })),
      });
      this.saveHistory();
      this.renderHistory();
      return card;
    },

    async makeCard({ res, prompt, frames, poster }) {
      const a = frames[0] && frames[0].src;
      if (!a) throw new Error('the clip has no first picture');
      const b = poster && poster.base64 ? poster : await this.srcBytes(a);
      const mime = b.mime || mimeOf(a.fname || '');
      const ext = /jpe?g/.test(mime) ? 'jpg' : /webp/.test(mime) ? 'webp' : 'png';
      const saved = await window.ala.files.saveImage(b.base64, ext, 'merge');
      const lib = State.library || [];
      const from = a.kind === 'card' ? lib.find((c) => c.id === a.id) : null;
      const pub = (State.settings && State.settings.publish) || {};
      const dests = Array.isArray(pub.destinations) && pub.destinations.length ? pub.destinations.slice() : [pub.destination || 'deviantart'];
      const now = Date.now();
      const card = {
        id: saved.id, jobId: null,
        theme: 'Video merge: ' + frames.map((f, i) => `${letter(i)} ${f.src.name || f.src.fname || ''}`.trim()).join(' → ').slice(0, 200),
        prompt: (from && from.prompt) || '', promptSource: 'video-merge',
        mergeOf: frames.map((f) => (f.src.kind === 'card' ? { cardId: f.src.id } : { fname: f.src.fname })),
        fname: saved.fname, path: saved.path, url: saved.url,
        mime, width: Number(frames[0].w) || null, height: Number(frames[0].h) || null,
        destinations: dests, destination: dests[0],
        mature: from ? from.mature : undefined,
        status: 'review', qc: null, qcSkipped: true, metadata: null, da: null, pixiv: null, pixivPrep: null, error: null,
        video: { url: res.url, fname: res.fname, prompt, at: now, merge: true },
        gif: res.gif ? { url: res.gif.url, fname: res.gif.fname, size: res.gif.size, at: now } : null,
        createdAt: now, updatedAt: now,
      };
      State.library.unshift(card);
      State.persistLibrary();
      return card;
    },

    renderHistory() {
      const box = $('#vm-hist');
      $('#vm-hist-title').hidden = !history.length;
      if (!history.length) { box.innerHTML = ''; return; }
      box.innerHTML = history.map((h) => {
        const card = h.cardId && (State.library || []).find((c) => c.id === h.cardId);
        const tl = h.frames.map((f, i) => `${letter(i)} ${i === 0 ? '0 s' : (h.landEnd && i === h.frames.length - 1) ? 'end' : fmt(Number(f.at)) + ' s'}`).join(' → ');
        return `<div class="vm-clip" data-id="${esc(h.id)}">
          <video controls preload="metadata" src="${esc(h.url)}"></video>
          <div class="vm-clip-body">
            <div class="vm-clip-tl">${esc(tl)} · ${fmt(h.seconds)} s</div>
            <div class="vm-clip-pics">${h.frames.map((f, i) => `<img src="${esc(f.src.url)}" alt="${letter(i)}" title="${letter(i)}" />`).join('')}</div>
            <details><summary>prompt</summary><pre>${esc(h.prompt)}</pre></details>
            <div class="btn-row">
              <button class="btn small" data-act="reuse" title="Put these pictures, times and prompt back in the builder">↺ Reuse</button>
              ${card ? `<span class="hint" title="This clip has its own card in Review">✓ In Review</span>` : `<button class="btn small" data-act="card" title="Make a new card in Review for this clip (picture A as its still)">＋ Review card</button>`}
              ${h.gif ? `<span class="hint">GIF ${(h.gif.size / 1048576).toFixed(1)} MB</span>` : `<button class="btn ghost small" data-act="gif" title="Convert this clip to an animated GIF (ffmpeg, no GPU)">→ GIF</button>`}
              <button class="btn ghost small" data-act="folder" title="Open the library folder">Folder</button>
              <button class="btn ghost small" data-act="del" title="Delete this clip's files">✕ Delete</button>
            </div>
          </div>
        </div>`;
      }).join('');
    },

    async onHistory(e) {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const row = b.closest('.vm-clip');
      const h = history.find((x) => x.id === row?.dataset.id);
      if (!h) return;
      const act = b.dataset.act;
      if (act === 'reuse') {
        frames = h.frames.map((f) => ({ key: 'f' + (++uid) + '-' + Date.now(), src: f.src, w: f.w, h: f.h, at: f.at, manual: false }));
        seconds = h.seconds; landEnd = h.landEnd; aspect = h.aspect; prompt = h.prompt; mode = 'custom'; words = h.prompt;
        this.pruneMissing(); this.render(); this.save();
        toast('Loaded into the builder. Mode is Custom, so the prompt is used as it is.', 'ok');
      } else if (act === 'card') {
        b.disabled = true;
        try {
          const card = await this.makeCard({ res: { url: h.url, fname: h.fname, gif: h.gif }, prompt: h.prompt, frames: h.frames });
          h.cardId = card.id;
          this.saveHistory(); this.renderHistory();
          toast('New card in Review.', 'ok');
        } catch (err) { toast('Could not make the card: ' + err.message, 'err'); b.disabled = false; }
      } else if (act === 'gif') {
        b.disabled = true; b.textContent = 'Converting…';
        try {
          const g = await window.ala.comfy.videoToGif({ fname: h.fname, nameHint: 'merge' });
          h.gif = { fname: g.fname, url: g.url, size: g.size };
          const card = h.cardId && (State.library || []).find((c) => c.id === h.cardId);
          if (card && !card.gif && card.video && card.video.fname === h.fname) {
            card.gif = { url: g.url, fname: g.fname, size: g.size, at: Date.now() }; card.updatedAt = Date.now(); State.persistLibrary();
          }
          this.saveHistory(); this.renderHistory(); toast('GIF ready.', 'ok');
        } catch (err) { toast('GIF failed: ' + err.message, 'err'); b.disabled = false; b.textContent = '→ GIF'; }
      } else if (act === 'folder') {
        window.ala.files.openLibrary();
      } else if (act === 'del') {
        if (!window.confirm('Delete this merged clip? The pictures it was made from are kept.')) return;
        const onCard = (State.library || []).some((c) => c.video && c.video.fname === h.fname);
        if (!onCard) {
          window.ala.comfy.deleteVideo(h.fname).catch(() => {});
          if (h.gif) window.ala.comfy.deleteGif(h.gif.fname).catch(() => {});
        } else toast('The clip is on a card in Review, so its file stays; only this entry is removed. Delete the card in Review to remove the clip.', 'ok');
        history = history.filter((x) => x.id !== h.id);
        this.saveHistory(); this.renderHistory();
      }
    },

    zoom(f) {
      if (!f) return;
      const el = document.createElement('div');
      el.className = 'vm-zoom';
      el.innerHTML = `<img src="${esc(f.src.url)}" alt="" /><div class="vm-zoom-cap">${esc(f.src.name)}</div>`;
      const close = () => { el.remove(); document.removeEventListener('keydown', onKey, true); };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
      el.addEventListener('click', close);
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(el);
    },

    daItems() {
      const devs = (window.Insights && Insights.perf && Insights.perf.deviations) || [];
      return devs.filter((d) => d && !d.isDeleted && d.deviationId)
        .sort((x, y) => (Number(y.publishedAt) || 0) - (Number(x.publishedAt) || 0));
    },
    async addDeviation(dev) {
      const res = window.Origins ? Origins.resolve(dev, { guess: false }) : {};
      if (res.card && res.card.fname) return this.addCard(res.card);
      const name = dev.title || ('deviation ' + dev.deviationId);
      if (res.fname) {
        const url = `ala://img/${res.fname}`;
        return this.add({ kind: 'img', fname: res.fname, url, name });
      }
      const user = (String(dev.url || '').match(/deviantart\.com\/([^/?#]+)\//i) || [])[1] || '';
      const got = await window.ala.dastats.image(String(dev.deviationId), user, true).catch((e) => ({ ok: false, error: e.message }));
      if (!got || !got.ok) throw new Error((got && got.error) || 'DeviantArt did not give the picture (is the DeviantArt tab signed in?)');
      const saved = await window.ala.files.saveAttachment(got.base64, got.mime || 'image/jpeg', 'da-' + dev.deviationId);
      await this.add({ kind: 'file', fname: saved.fname, url: saved.url, name });
      bytes.set(frames[frames.length - 1].key, { base64: got.base64, mime: saved.mime || got.mime || 'image/jpeg' });
    },

    openPicker() {
      const root = $('#modal-root');
      const left = VM().MAX_PICTURES - frames.length;
      if (left <= 0) return toast(`At most ${VM().MAX_PICTURES} pictures in one clip.`, 'err');
      let tab = 'lib', filter = 'kept', q = '', shown = 90;
      const picked = [];
      const norm = (x) => String(x || '').toLowerCase();
      const items = () => {
        if (tab === 'da') {
          return this.daItems()
            .filter((d) => !q || norm(d.title).includes(q) || norm((d.tags || []).join(' ')).includes(q))
            .map((d) => {
              const r = window.Origins ? Origins.resolve(d, { guess: false }) : {};
              return { id: 'da:' + d.deviationId, url: window.Insights ? Insights.thumb(d) : d.thumb, title: d.title, local: !!r.fname };
            }).filter((x) => x.url);
        }
        return (State.library || [])
          .filter((c) => c.fname)
          .filter((c) => (filter === 'all' ? true
            : filter === 'kept' ? c.status !== 'discarded' && c.status !== 'rejected'
              : filter === 'published' ? !!(c.da && (c.da.deviationId || c.da.url))
                : c.status === filter))
          .filter((c) => !q || norm(c.metadata && c.metadata.title).includes(q) || norm(c.theme).includes(q) || norm(c.prompt).includes(q))
          .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
          .map((c) => ({ id: c.id, url: c.url, title: (c.metadata && c.metadata.title) || c.theme || c.fname, local: true }));
      };
      const paint = () => {
        const list = items();
        $('#vm-pick-grid').innerHTML = list.slice(0, shown).map((c) => {
          const n = picked.indexOf(c.id);
          return `<button class="vm-pick ${n >= 0 ? 'on' : ''}" data-id="${esc(c.id)}" title="${esc(c.title)}"><img loading="lazy" src="${esc(c.url)}" alt="" />${n >= 0 ? `<span class="vm-pick-n">${n + 1}</span>` : ''}${tab === 'da' && !c.local ? '<span class="vm-pick-tag" title="Not on this PC — downloaded from DeviantArt when you press Add">DA</span>' : ''}</button>`;
        }).join('') || `<div class="vm-empty">${tab === 'da' ? 'No published deviations on file — sync your gallery on the Statistics tab.' : 'No pictures match.'}</div>`;
        $('#vm-pick-more').hidden = list.length <= shown;
        $('#vm-pick-count').textContent = `${picked.length} picked · ${list.length} pictures`;
        $('#vm-pick-go').disabled = !picked.length;
        for (const b of root.querySelectorAll('.vm-pick-tab')) b.classList.toggle('on', b.dataset.tab === tab);
        $('#vm-pick-filter').hidden = tab === 'da';
      };
      root.innerHTML = `<div class="modal-backdrop"><div class="panel vm-picker">
        <div class="panel-head"><h2>Pick pictures (in order)</h2><button class="btn ghost small" data-close>✕</button></div>
        <div class="vm-pick-bar">
          <div class="vm-pick-tabs"><button class="vm-pick-tab on" data-tab="lib">Library</button><button class="vm-pick-tab" data-tab="da" title="Everything published on your DeviantArt, including pictures that are no longer in the library">DeviantArt gallery</button></div>
          <label class="ie-inline"><select id="vm-pick-filter">
            <option value="kept">Review, drafted, approved</option><option value="published">Published on DeviantArt</option><option value="review">Review only</option>
            <option value="drafted">Drafted</option><option value="rejected">Rejected</option><option value="discarded">Discarded</option><option value="all">Everything</option></select></label>
          <input type="search" id="vm-pick-q" placeholder="Search title, theme, prompt…" />
          <span class="hint" id="vm-pick-count"></span>
        </div>
        <div class="vm-pick-grid" id="vm-pick-grid"></div>
        <div class="btn-row vm-pick-foot"><button class="btn ghost" id="vm-pick-more">Show more</button><span style="flex:1"></span>
          <button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="vm-pick-go">Add</button></div>
      </div></div>`;
      const close = () => { root.innerHTML = ''; };
      root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
      root.querySelectorAll('.vm-pick-tab').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; shown = 90; picked.length = 0; paint(); }));
      $('#vm-pick-filter').addEventListener('change', (e) => { filter = e.target.value; shown = 90; paint(); });
      $('#vm-pick-q').addEventListener('input', (e) => { q = norm(e.target.value).trim(); shown = 90; paint(); });
      $('#vm-pick-more').addEventListener('click', () => { shown += 90; paint(); });
      $('#vm-pick-grid').addEventListener('click', (e) => {
        const b = e.target.closest('.vm-pick'); if (!b) return;
        const i = picked.indexOf(b.dataset.id);
        if (i >= 0) picked.splice(i, 1);
        else if (picked.length < left) picked.push(b.dataset.id);
        else toast(`Room for ${left} more picture${left > 1 ? 's' : ''}.`, 'err');
        paint();
      });
      $('#vm-pick-go').addEventListener('click', async () => {
        const ids = picked.slice(), fromDa = tab === 'da'; close();
        for (const id of ids) {
          try {
            if (fromDa) {
              const dev = this.daItems().find((d) => 'da:' + d.deviationId === id);
              if (dev) await this.addDeviation(dev);
            } else await this.addCard((State.library || []).find((c) => c.id === id));
          } catch (e) { toast('Could not add that picture: ' + e.message, 'err'); }
        }
      });
      paint();
    },

    save() {
      try {
        localStorage.setItem(SESSION_KEY, JSON.stringify({ frames: frames.map((f) => ({ src: f.src, w: f.w, h: f.h, at: f.at, manual: f.manual })), landEnd, seconds, aspect, mode, words, prompt }));
      } catch {  }
    },
    saveHistory() { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch {  } },
    restore() {
      try {
        const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
        if (s) {
          frames = (s.frames || []).map((f) => ({ key: 'f' + (++uid) + '-' + Date.now(), src: f.src, w: f.w, h: f.h, at: f.at, manual: !!f.manual }));
          landEnd = s.landEnd !== false; seconds = Number(s.seconds) || 10; aspect = s.aspect || 'auto';
          mode = s.mode || 'auto'; words = s.words || ''; prompt = s.prompt || '';
        }
        history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') || [];
      } catch { frames = []; history = []; }
    },

    async open({ cardId } = {}) {
      const card = (State.library || []).find((c) => c.id === cardId);
      if (card) await this.addCard(card);
    },
  };

  window.VideoMergeUI = ui;
})();
