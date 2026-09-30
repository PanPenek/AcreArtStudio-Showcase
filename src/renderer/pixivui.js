/**
 * pixivui.js: the pixiv tab: sign-in, a session check, a probe of the live
 * upload form and the raw request/response of the last post for diagnostics.
 */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const esc = U.escapeHtml;
  const fmtTime = U.fmtTime;

  let wv = null;
  let status = null;
  let note = '';

  const PixivUI = {
    wire() {
      wv = $('#wv-pixiv');
      if (!wv) return;
      Pixiv.attach(wv);

      $('#btn-px-reload').addEventListener('click', () => wv.reload());
      $('#btn-px-home').addEventListener('click', () => Pixiv.navigate('https://www.pixiv.net/illustration/create')
        .catch((e) => window.toast(e.message, 'err')));
      $('#btn-px-check').addEventListener('click', () => this.refreshStatus({ loud: true, navigate: true }));
      $('#btn-px-probe').addEventListener('click', () => this.probe());

      wv.addEventListener('did-finish-load', () => {
        if ($('#pane-pixiv').classList.contains('active')) this.refreshStatus();
      });

      State.on('pixivAuthLost', ({ message }) => {
        window.toast('Signed out of pixiv — open the Pixiv tab and log in. ' + (message || ''), 'err');
        status = { ok: false, error: message || 'not signed in' };
        this.render();
      });
    },

    async refreshStatus({ loud = false, navigate = false } = {}) {
      const hint = $('#pixiv-hint');
      if (hint && loud) hint.textContent = 'checking…';
      status = await Pixiv.status({ navigate });
      this.render();
      if (loud) {
        window.toast(status.ok
          ? `Signed in to pixiv as ${status.username || 'user ' + status.userId}.`
          : 'Pixiv: ' + status.error, status.ok ? 'ok' : 'err');
      }
      return status;
    },

    async probe() {
      try {
        const p = await Pixiv.probe();
        window.__lastPixivProbe = p;
        console.log('[pixiv probe]', p);
        const groups = Object.entries(p.radios || {})
          .map(([k, v]) => `${k}: ${v.map((o) => o.value + (o.checked ? '*' : '')).join(' / ')}`)
          .join('\n');
        const reach = p.reach || {};
        const found = Object.keys(reach).filter((k) => reach[k]);
        const lost = Object.keys(reach).filter((k) => !reach[k]);
        const readiness = `Prepare can fill: ${found.join(', ') || 'nothing'}`
          + (lost.length ? `\nPrepare CANNOT find: ${lost.join(', ')} — those must be set by hand.` : '');
        State.addLog(`Pixiv form probe — ${(p.fields || []).length} named field(s), `
          + `${found.length} of ${found.length + lost.length} fillable. Details in the console (window.__lastPixivProbe).`,
        lost.length ? 'err' : 'ok');
        note = `${readiness}\n\n${groups
          ? `Upload form values (a * marks the default):\n${groups}`
          : 'The page exposed no named radio groups — see the console dump.'}`;
        this.render();
      } catch (e) {
        window.toast('Probe failed: ' + e.message, 'err');
      }
    },

    render() {
      const hint = $('#pixiv-hint');
      if (hint) {
        hint.textContent = !status ? 'log in once — session persists'
          : status.ok ? `signed in as ${status.username || status.userId}`
            : status.error;
        hint.className = status ? (status.ok ? 'ok' : 'err') : '';
      }
      this.renderStaged();
      this.renderDiag();
    },

    /**
     * "This card is filled in below — press Post." pixiv's human check means a card can be staged
     * on the page and waiting on a click.
     */
    renderStaged() {
      const box = $('#px-staged');
      if (!box || !window.Pipeline) return;
      const card = Pipeline.pixivStaged();
      box.hidden = !card;
      if (!card) return;
      const prep = card.pixivPrep || {};
      box.innerHTML = `
        <div><b>${esc(card.metadata?.title || card.fname)}</b> is filled in on the form below —
          check it over and press <b>Post</b>. pixiv asks for a human here, so this last click is yours.</div>
        ${prep.filled?.length ? `<div class="hint ok">Filled in for you: ${esc(prep.filled.join(', '))}.</div>` : ''}
        ${prep.missed?.length ? `<div class="hint ${prep.critical?.length ? 'err' : ''}">Set by hand:
          <b>${esc(prep.missed.join(', '))}</b>${prep.critical?.length ? ' — pixiv requires these' : ''}.</div>` : ''}
        <div class="btn-row">
          <button class="btn small" id="btn-px-staged-check">Posted it — check</button>
          <button class="btn ghost small" id="btn-px-staged-cancel">Cancel</button>
        </div>`;
      $('#btn-px-staged-check').addEventListener('click', async () => {
        const res = await Pipeline.harvestPixiv(card).catch((e) => ({ ok: false, error: e.message }));
        if (res.found) window.toast(`Found it — "${card.metadata?.title || card.fname}" is on pixiv.`, 'ok');
        else window.toast(res.ok ? 'Nothing new on your account yet — press Post first.'
          : 'Could not read your pixiv works: ' + (res.error || 'unknown'), 'err');
      });
      $('#btn-px-staged-cancel').addEventListener('click', () => {
        Pipeline.clearPixivPrep(card, 'cancelled');
      });
    },

    /** The last request and pixiv's raw answer. */
    renderDiag() {
      const body = $('#px-diag-body');
      if (!body) return;
      const last = Pixiv.last;
      const head = note ? `<pre class="px-pre">${esc(note)}</pre>` : '';
      if (!last) {
        body.innerHTML = head + 'Nothing posted yet this session. After a post — from the Drafts tab — '
          + "the exact fields sent and pixiv's raw reply appear here.";
        return;
      }
      body.innerHTML = head + `
        <div><b>${esc(fmtTime(last.at))}</b> · POST ${esc(last.endpoint)} · HTTP ${last.status ?? '—'}</div>
        <pre class="px-pre">${esc(JSON.stringify({ ...last.fields, 'tags[]': last.tags }, null, 2))}</pre>
        <div>pixiv replied:</div>
        <pre class="px-pre">${esc(String(last.body || '(empty)').slice(0, 1200))}</pre>`;
    },
  };

  window.PixivUI = PixivUI;
})();
