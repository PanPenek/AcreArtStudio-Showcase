/**
 * health.js: "is it working, and which engine is doing it?"
 *
 * Five plain rows, one per capability: prompt writing, metadata, image quality
 * check, image generation, upload. Each row reports three things separately,
 * because they fail independently: configured (what settings say), observed (what
 * actually happened last time) and reachable (a real test call, on request).
 * A row is never green on configuration alone.
 */
(function () {
  const esc = (s) => U.escapeHtml(s);

  const ROLE_ROWS = [
    { id: 'ideation', label: 'Prompt writing', what: 'The Prompt Lab, Auto mode and the Overseer.' },
    { id: 'metadata', label: 'Title, description, tags', what: 'Metadata for every image before it reaches Review.' },
    { id: 'vision', label: 'Image quality check', what: 'Inspects each generated image for defects.' },
  ];

  const ago = (ts) => {
    if (!ts) return '';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
  };

  const engineOf = () => ((State.settings && State.settings.gen) || {}).engine || 'perchance';

  const Health = {
    routes: {},
    da: null,
    comfy: null,
    lastCheckedAt: null,

    /** Re-read everything cheap: routing config, the DeviantArt session, the image server. */
    async refresh() {
      this.routes = await window.ala.llm.routes().catch(() => ({}));
      this.da = await window.ala.da.uploadReadiness().catch((e) => ({
        method: 'session', session: { ok: false, error: e.message }, api: { authenticated: false },
      }));
      const drv = engineOf() === 'comfy' && window.Pipeline && typeof window.Pipeline.genDriver === 'function'
        ? window.Pipeline.genDriver() : null;
      this.comfy = drv && typeof drv.status === 'function'
        ? { ...(await drv.status().catch((e) => ({ up: false, error: e.message }))), at: Date.now() }
        : null;
      this.lastCheckedAt = Date.now();
      State.emit('health', this);
      return this;
    },

    /** One row per capability. */
    rows() {
      const out = [];
      const manualQc = !!(State.settings.gen && State.settings.gen.skipQc);
      const manualMeta = !!(State.settings.gen && State.settings.gen.skipMetadata);

      for (const r of ROLE_ROWS) {
        const route = this.routes[r.id];
        const last = State.llmLast[r.id];
        const chain = (route && route.chain) || [];
        const skipped = (route && route.skipped) || [];

        if (r.id === 'vision' && manualQc) {
          out.push({
            id: r.id, label: r.label, level: 'off',
            headline: 'Off — you are sorting by eye',
            detail: 'Images go straight to Review uninspected. Nothing is auto-discarded.',
            fix: { tab: 'settings', text: 'Turn the AI check back on' },
            actions: [],
          });
          continue;
        }

        if (!chain.length) {
          out.push({
            id: r.id, label: r.label, level: 'bad',
            headline: 'Nothing can do this job',
            detail: skipped.length
              ? `Every candidate was skipped — ${skipped.map((s) => `${s.name}: ${s.reason}`).join('; ')}.`
              : 'No provider is configured and the local fallback is switched off.',
            fix: { tab: 'settings', text: 'Fix the routing' },
            actions: [{ act: 'test', label: 'Test' }],
          });
          continue;
        }

        const first = chain[0];
        const what = first.model || first.command || 'its own default';
        const parts = [`${first.name} · ${what}`];
        if (chain.length > 1) parts.push(`falls back to ${chain.slice(1).map((c) => c.name).join(', ')}`);

        let level = 'ok';
        let headline = `${first.name}`;
        let detail = parts.join(' — ');

        if (!last) {
          level = 'idle';
          headline = `${first.name} — ready`;
          detail = `${detail}. Nothing has run through it since launch — hit Test now to prove it.`;
        } else if (!last.ok) {
          level = 'bad';
          headline = 'Failed last time';
          detail = `${last.label} failed ${ago(last.at)}: ${last.error}`;
        } else if (last.fellBack) {
          level = 'warn';
          headline = `Fell back to ${last.provider}`;
          detail = `${last.label} ${ago(last.at)} — ${last.notes.join(', ')}. `
            + `Configured first choice is ${first.name}.`;
        } else {
          headline = `${last.provider} — working`;
          detail = `${last.label} answered in ${(last.ms / 1000).toFixed(1)}s, ${ago(last.at)}.`
            + (chain.length > 1 ? ` Falls back to ${chain.slice(1).map((c) => c.name).join(', ')}.` : '');
        }

        const openCircuit = chain.find((c) => c.open);
        if (openCircuit) {
          level = 'warn';
          detail += ` ${openCircuit.name} refused repeatedly and is parked for this session.`;
        }

        if (r.id === 'metadata' && manualMeta) {
          detail += ' Auto metadata is off — this only runs when you press Write metadata in Review.';
        }

        out.push({
          id: r.id, label: r.label, level, headline, detail,
          fix: { tab: 'settings', text: 'Change the engine' },
          actions: [{ act: 'test', label: 'Test now' }],
        });
      }

      if (engineOf() === 'comfy') {
        const cfg = (State.settings && State.settings.comfy) || {};
        const where = cfg.serverUrl || 'http://127.0.0.1:8188';
        const c = this.comfy;
        const down = window.Pipeline && window.Pipeline.engineDown;
        const per = Math.max(1, Math.round(Number(cfg.imagesPerPrompt) || 1));
        const wf = cfg.imageWorkflow || 'no workflow picked';
        let level, headline, detail;
        if (!c) {
          level = 'idle';
          headline = 'ComfyUI — not checked yet';
          detail = `${where} · ${wf}. Press Re-check to ask the server.`;
        } else if (c.up) {
          level = 'ok';
          headline = `ComfyUI up${c.version ? ` — ${c.version}` : ''}`;
          detail = `${where} · workflow ${wf} · ${per} picture(s) per prompt. Answered ${ago(c.at)}.`;
        } else {
          level = 'bad';
          headline = 'ComfyUI not answering';
          detail = `${where} did not answer${c.error ? ` (${c.error})` : ''}. `
            + (String(cfg.launchCommand || '').trim()
              ? 'The worker starts it with your launch command when a job needs it.'
              : 'Start ComfyUI, or set a launch command in Settings → Generator so the app can start it itself.')
            + (down ? ` The worker is waiting for it (${Math.floor((Date.now() - down.since) / 60000)} min) — no job is being marked failed.` : '');
        }
        out.push({
          id: 'comfy', label: 'Image generation', level, headline, detail,
          fix: { tab: 'settings', text: 'Generator settings' },
          actions: [{ act: 'recheck', label: 'Re-check' }],
        });
      }

      const drv = window.Pipeline && window.Pipeline.driver;
      if (engineOf() !== 'comfy') out.push({
        id: 'perchance',
        label: 'Image generation',
        level: drv ? 'ok' : 'bad',
        headline: drv ? 'Perchance tab attached' : 'Perchance tab not ready',
        detail: drv
          ? 'The generator runs in the Perchance tab. If generation stalls, open that tab and check for a pop-up dialog.'
          : 'The embedded browser tab has not loaded yet.',
        fix: { tab: 'perchance', text: 'Open the tab' },
        actions: [{ act: 'probe', label: 'Probe' }],
      });

      const d = this.da;
      const usingApi = d && d.method === 'api';
      const daOk = d && (usingApi ? d.api.authenticated : d.session.ok);
      out.push({
        id: 'deviantart',
        label: 'DeviantArt upload',
        level: daOk ? 'ok' : 'warn',
        headline: daOk
          ? `Signed in as @${(usingApi ? d.api.username : d.session.username) || '?'}`
          : 'Not signed in',
        detail: daOk
          ? `Approved cards upload via the ${usingApi ? 'API — to Sta.sh only, where you submit them by hand' : 'browser session, and are submitted for you unless you turn that off on the Drafts tab'}.`
          : `Nothing can upload until you sign in${usingApi ? ' (API method selected — the session route needs no app)' : ' on the DeviantArt tab'}.`,
        fix: { tab: 'deviantart', text: 'Sign in' },
        actions: [{ act: 'recheck', label: 'Re-check' }],
      });

      return out;
    },

    /** One real round trip for a role, using the shipped prompt. */
    async test(role) {
      const route = this.routes[role];
      const first = route && route.chain && route.chain[0];
      if (!first) throw new Error('nothing is routed to this job');
      if (role === 'vision') {
        const sample = State.library.find((c) => c.fname && c.status !== 'discarded') || State.library[0];
        if (!sample) throw new Error('no images in the library yet — generate a turn first');
        const base64 = await window.ala.files.readImageBase64(sample.fname);
        const small = await Pipeline.downscaleForQc(base64, sample.mime || 'image/jpeg');
        const r = await U.llmVision(small.base64, small.mime, PromptT.qc(sample.prompt), { role: 'vision' }, 'Status check');
        return { provider: r.provider, ms: r.latencyMs, fellBack: (r.notes || []).length > 0, notes: r.notes || [] };
      }
      const prompt = role === 'metadata'
        ? PromptT.metadata({ prompt: 'a fox spirit exploring a moonlit bamboo forest, soft rim light', exampleStyle: '', maxTags: 6 })
        : PromptT.ideation('a quiet moonlit scene', '', 1, [], '');
      const r = await U.llmChat([{ role: 'user', content: prompt }], { role, maxTokens: 2000, temperature: 0.7 }, 'Status check');
      U.extractJson(r.text);
      return { provider: r.provider, ms: r.latencyMs, fellBack: (r.notes || []).length > 0, notes: r.notes || [] };
    },

    /** Render into a container. */
    render(root, { compact = false } = {}) {
      if (!root) return;
      const rows = this.rows();
      root.innerHTML = rows.map((r) => `
        <div class="hz-row ${r.level}" data-hz="${r.id}"${compact ? ` title="${esc(r.headline)} — ${esc(r.detail)}"` : ''}>
          <span class="hz-dot"></span>
          <div class="hz-main">
            ${compact ? '' : `<div class="hz-label">${esc(r.label)}</div>`}
            <div class="hz-head">${esc(compact ? r.label : r.headline)}</div>
            ${compact ? '' : `<div class="hz-detail">${esc(r.detail)}</div>`}
          </div>
          ${compact ? '' : `<div class="hz-actions">
            ${r.actions.map((a) => `<button class="btn ghost small" data-hzact="${a.act}" data-role="${r.id}">${esc(a.label)}</button>`).join('')}
            ${r.fix ? `<button class="btn ghost small" data-hzfix="${r.fix.tab}">${esc(r.fix.text)} →</button>` : ''}
          </div>`}
        </div>`).join('');

      root.querySelectorAll('[data-hzfix]').forEach((b) =>
        b.addEventListener('click', () => window.switchTab(b.dataset.hzfix)));

      root.querySelectorAll('[data-hzact]').forEach((b) =>
        b.addEventListener('click', async () => {
          const role = b.dataset.role;
          const act = b.dataset.hzact;
          if (act === 'recheck') { await this.refresh(); return this.render(root, { compact }); }
          if (act === 'probe') { window.switchTab('perchance'); return; }
          const label = b.textContent;
          b.disabled = true;
          b.textContent = 'Testing…';
          try {
            const res = await this.test(role);
            window.toast(res.fellBack
              ? `Worked, but ${res.provider} answered after ${res.notes.join(', ')}.`
              : `${res.provider} answered in ${(res.ms / 1000).toFixed(1)}s.`, res.fellBack ? 'err' : 'ok');
          } catch (e) {
            window.toast(`${role} test failed: ${e.message}`, 'err');
          } finally {
            b.disabled = false;
            b.textContent = label;
            await this.refresh();
            this.render(root, { compact });
          }
        }));
    },
  };

  window.Health = Health;
})();
