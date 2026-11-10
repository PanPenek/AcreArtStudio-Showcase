/**
 * growthui.js: Statistics → Channel growth.
 *
 * The watcher goal and its pace, a table of daily counters for him and any reference
 * accounts (read from public profile pages by channel.js, once a day while the app runs, or
 * with Snapshot now), which kind of post works best, his own tags, and the DeviantArt Core
 * switches (MP4 posts, premium gallery, AI label on sold items).
 */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n, d = 0) => (n == null || !Number.isFinite(n) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
  const signed = (n, d = 1) => (n == null || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${num(n, d)}`);
  const pct = (x, d = 2) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
  const FORMAT_NAMES = { single: 'Single picture', sequence: 'Comic page / series part', gif: 'GIF', video: 'Video (MP4)' };
  const CORE_PLANS = ['', 'Core+', 'Core Pro', 'Core Pro+', 'Core Max'];

  let busy = false;
  let lastHistory = null;

  function today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  async function patchSettings(patch) {
    const s = await window.ala.settings.patch(patch);
    State.settings = s;
    return s;
  }

  function accountsRows(accounts, me, g) {
    const users = [me, ...(g.references || [])].filter(Boolean);
    const seen = new Set();
    return users.filter((u) => !seen.has(u) && seen.add(u)).map((u) => {
      const sum = Growth.channelSummary(accounts[u] || [], { goal: u === me ? g.goalWatchers : null });
      if (!sum) return `<tr><td class="t-title">${esc(u)}${u === me ? ' <span class="p-tag">you</span>' : ''}</td><td class="num" colspan="7">no snapshot yet</td></tr>`;
      return `<tr>
        <td class="t-title">${esc(u)}${u === me ? ' <span class="p-tag">you</span>' : ''}</td>
        <td class="num">${num(sum.watchers)}</td><td class="num">${signed(sum.watchersPerDay)}</td>
        <td class="num">${num(sum.pageviews)}</td><td class="num">${signed(sum.pageviewsPerDay, 0)}</td>
        <td class="num">${num(sum.deviations)}</td><td class="num">${num(sum.watchersPerDeviation, 1)}</td>
        <td class="num">${esc(sum.day)}</td></tr>`;
    }).join('');
  }

  function formatRows() {
    const perf = (window.Insights && Insights.perf) || { deviations: [] };
    const since = Date.now() - 45 * 86400000;
    const rows = Growth.formatReport({ deviations: perf.deviations, library: State.library, hours: 24, sinceMs: since });
    if (!rows.length) return '<tr><td colspan="5" class="hint">Sync the gallery (Performance data above) to fill this in.</td></tr>';
    return rows.map((r) => `<tr>
      <td class="t-title">${esc(FORMAT_NAMES[r.format] || r.format)}</td>
      <td class="num">${num(r.posts)}</td><td class="num">${num(r.medianViews)}</td>
      <td class="num">${pct(r.favPerView)}</td><td class="num">${num(r.medianComments, 1)}</td></tr>`).join('');
  }

  function coreBox(s) {
    const core = (s.da && s.da.core) || {};
    const galleries = ((s.da && s.da.galleryCache) || []).filter((g) => g.special !== 'featured' && g.premium === true);
    const tiers = (s.da && s.da.tierCache) || [];
    return `<div class="fld-row" style="flex-wrap:wrap">
        <label class="fld" style="min-width:150px"><span>DeviantArt Core</span>
          <select id="cg-core-plan">${CORE_PLANS.map((p) => `<option value="${esc(p)}" ${p === (core.enabled ? core.plan || 'Core Pro' : '') ? 'selected' : ''}>${p ? esc(p) : 'No Core (free account)'}</option>`).join('')}</select></label>
        <label class="fld" style="min-width:220px"><span>Premium gallery <em>(sold sets go here)</em></span>
          <select id="cg-core-premium" ${core.enabled ? '' : 'disabled'}><option value="">${galleries.length ? '— none —' : '— no Premium Gallery found —'}</option>${galleries.map((g) => `<option value="${esc(g.id)}" ${String(g.id) === String(core.premiumGalleryId || '') ? 'selected' : ''}>${esc(g.name)}${g.price != null ? ' · $' + esc(g.price) : ''}</option>`).join('')}</select></label>
        <label class="fld" style="min-width:200px"><span>Subscription tier <em>(🔒 Subscribers posts go here)</em></span>
          <select id="cg-core-tier"><option value="">${tiers.length ? '— none —' : '— no tier found —'}</option>${tiers.map((t) => `<option value="${esc(t.id)}" ${String(t.id) === String(core.tierId || '') ? 'selected' : ''}>${esc(t.name)}${t.published ? '' : ' (not published)'}</option>`).join('')}</select></label>
        <button class="btn ghost" id="cg-core-refresh" style="align-self:flex-end" ${core.enabled ? '' : 'disabled'}
          title="Read your gallery folders and Subscription tiers from DeviantArt again — press it after creating a Premium Gallery or a tier there">↻ Refresh</button>
      </div>
      <div class="hint">Without Core nothing changes. With Core: MP4 posts and the premium gallery unlock, and anything posted to the premium gallery gets DeviantArt's "Created using AI tools" label, which their terms require on items you sell. GIF posts work without Core.</div>`;
  }

  async function render() {
    const root = $('#channel-growth');
    if (!root || !window.Growth) return;
    const g = Growth.cfg();
    const me = Growth.username();
    lastHistory = await window.ala.channel.history().catch(() => null);
    const accounts = (lastHistory && lastHistory.accounts) || {};
    const mine = me ? Growth.channelSummary(accounts[me] || [], { goal: g.goalWatchers }) : null;
    const pctGoal = mine && mine.progress != null ? Math.round(mine.progress * 1000) / 10 : 0;
    const pace = !mine ? (me ? 'No snapshot yet. Press Snapshot now.' : 'Set your DeviantArt username first (DeviantArt tab → sign in).')
      : mine.spanDays < 1 ? `First snapshot ${esc(mine.day)}. The pace appears after the second day.`
        : `${signed(mine.watchersPerDay)} watchers/day over the last ${mine.spanDays} day(s)${mine.daysToGoal ? ` → goal in about ${num(mine.daysToGoal)} days at this pace` : ''}.`;
    root.innerHTML = `
      <div class="cg-goal">
        <div class="cg-goal-head"><b>${mine ? num(mine.watchers) : '—'}</b> / ${num(g.goalWatchers)} watchers
          <span class="hint">· ${pctGoal}% of the goal</span>
          <label class="hint" style="margin-left:auto">Goal <input id="cg-goal" type="number" min="100" step="500" value="${esc(g.goalWatchers)}" style="width:90px" /></label></div>
        <div class="cg-bar"><i style="width:${Math.min(100, pctGoal)}%"></i></div>
        <div class="hint">${pace}</div>
      </div>
      <h3 class="cg-h">You and the reference accounts</h3>
      <div class="tbl-wrap"><table class="stat-table">
        <thead><tr><th>Account</th><th class="num">Watchers</th><th class="num">/day</th><th class="num">Profile views</th><th class="num">/day</th><th class="num">Deviations</th><th class="num">Watchers per deviation</th><th class="num">Snapshot</th></tr></thead>
        <tbody>${accountsRows(accounts, me, g)}</tbody></table></div>
      <h3 class="cg-h">Which kind of post works <span class="hint">last 45 days, views 24 h after posting</span></h3>
      <div class="tbl-wrap"><table class="stat-table">
        <thead><tr><th>Format</th><th class="num">Posts</th><th class="num">Median views @24h</th><th class="num">Favourites per view</th><th class="num">Comments</th></tr></thead>
        <tbody>${formatRows()}</tbody></table></div>
      <h3 class="cg-h">Tags and reference accounts</h3>
      <div class="fld-row" style="flex-wrap:wrap">
        <label class="fld" style="min-width:260px;flex:1" title="Added first to every post's tags. Tags from your best-viewed posts are added after the post's own."><span>Your own tags <em>(comma-separated)</em></span>
          <input id="cg-house" type="text" spellcheck="false" placeholder="e.g. digitalart, illustration" value="${esc(Growth.houseTags().join(', '))}" /></label>
        <label class="fld" style="min-width:260px;flex:1" title="Other DeviantArt accounts to compare with (public profile counters only)."><span>Reference accounts <em>(usernames, comma-separated)</em></span>
          <input id="cg-refs" type="text" spellcheck="false" placeholder="none" value="${esc((g.references || []).join(', '))}" /></label>
      </div>
      <h3 class="cg-h">DeviantArt Core</h3>
      ${coreBox(State.settings)}`;
    wireInner(root);
  }

  function wireInner(root) {
    const goal = $('#cg-goal', root);
    if (goal) goal.addEventListener('change', async () => {
      const v = Math.max(100, Math.round(Number(goal.value) || 15000));
      await patchSettings({ growth: { goalWatchers: v } });
      render();
    });
    const list = (v, clean) => [...new Set(String(v || '').split(/[\s,]+/).map(clean).filter(Boolean))].slice(0, 30);
    const house = $('#cg-house', root);
    if (house) house.addEventListener('change', async () => {
      await patchSettings({ growth: { houseTags: list(house.value, Growth.cleanTag) } });
      window.toast('Your tags are saved.', 'ok');
    });
    const refs = $('#cg-refs', root);
    if (refs) refs.addEventListener('change', async () => {
      await patchSettings({ growth: { references: list(refs.value, (u) => String(u).toLowerCase().replace(/[^a-z0-9_-]/g, '')).slice(0, 11) } });
      render();
    });
    const plan = $('#cg-core-plan', root);
    if (plan) plan.addEventListener('change', async () => {
      await patchSettings({ da: { core: { enabled: !!plan.value, plan: plan.value } } });
      render();
    });
    const prem = $('#cg-core-premium', root);
    if (prem) prem.addEventListener('change', async () => {
      const hit = ((State.settings.da && State.settings.da.galleryCache) || []).find((g) => String(g.id) === prem.value);
      const name = hit ? hit.name : '';
      await patchSettings({ da: { core: { premiumGalleryId: prem.value, premiumGalleryName: prem.value ? name : '' } } });
      window.toast(prem.value ? `Premium gallery: ${name}` : 'No premium gallery', 'ok');
    });
    const tierSel = $('#cg-core-tier', root);
    if (tierSel) tierSel.addEventListener('change', async () => {
      const t = ((State.settings.da && State.settings.da.tierCache) || []).find((x) => String(x.id) === tierSel.value);
      await patchSettings({ da: { core: { tierId: t ? String(t.id) : '', tierName: t ? t.name : '' } } });
      window.toast(t ? `Subscription tier: ${t.name}` : 'No subscription tier', 'ok');
      render();
    });
    const refresh = $('#cg-core-refresh', root);
    if (refresh) refresh.addEventListener('click', async () => {
      refresh.disabled = true; refresh.textContent = 'Reading…';
      const res = await window.ala.daweb.galleries().catch((e) => ({ ok: false, error: e.message }));
      if (!res.ok) { window.toast('Could not read galleries: ' + res.error, 'err'); render(); return; }
      const prem = res.galleries.filter((g) => g.premium);
      const core = (State.settings.da && State.settings.da.core) || {};
      const keep = prem.some((g) => String(g.id) === String(core.premiumGalleryId || ''));
      await patchSettings({ da: { galleryCache: res.galleries, ...(keep ? {} : { core: { premiumGalleryId: '', premiumGalleryName: '' } }) } });
      const tr = await window.ala.daweb.tiers().catch((e) => ({ ok: false, error: e.message }));
      let tierMsg = '';
      if (tr.ok) {
        const keepTier = tr.tiers.some((t) => String(t.id) === String(core.tierId || ''));
        const only = !core.tierId && tr.tiers.length === 1 ? tr.tiers[0] : null;
        await patchSettings({ da: { tierCache: tr.tiers, core: keepTier ? {} : only ? { tierId: only.id, tierName: only.name } : { tierId: '', tierName: '' } } });
        tierMsg = tr.tiers.length ? ` · tiers: ${tr.tiers.map((t) => t.name).join(', ')}` : ' · no Subscription tier yet';
      } else tierMsg = ` · could not read tiers: ${tr.error}`;
      window.toast((prem.length ? `${prem.length} Premium Galler${prem.length > 1 ? 'ies' : 'y'} found: ${prem.map((g) => g.name).join(', ')}` : 'No Premium Gallery on your account yet — create one on DeviantArt (Gallery → Edit → New Gallery → Premium Gallery), add one deviation to it, then refresh.') + tierMsg, prem.length || (tr.ok && tr.tiers.length) ? 'ok' : 'err');
      render();
    });
  }

  async function snapshot({ quiet = false } = {}) {
    if (busy) return null;
    const me = Growth.username();
    const g = Growth.cfg();
    const users = [me, ...(g.references || [])].filter(Boolean);
    if (!users.length) { if (!quiet) window.toast('No DeviantArt username yet: sign in on the DeviantArt tab first.', 'err'); return null; }
    busy = true;
    const btn = $('#btn-cg-snap');
    if (btn) btn.disabled = true;
    try {
      const res = await window.ala.channel.snapshot(users);
      const bad = Object.entries(res.errors || {});
      if (!quiet) window.toast(bad.length ? `Snapshot: ${Object.keys(res.read || {}).length} read, ${bad.length} failed (${bad.map(([u, e]) => `${u}: ${e}`).join('; ')})` : 'Snapshot saved.', bad.length ? 'warn' : 'ok');
      State.addLog(`Channel snapshot: ${Object.entries(res.read || {}).map(([u, s]) => `${u} ${s.watchers} watchers`).join(', ')}${bad.length ? ` · failed: ${bad.map(([u]) => u).join(', ')}` : ''}`, bad.length ? 'warn' : 'ok');
      await render();
      return res;
    } catch (e) {
      if (!quiet) window.toast(`Snapshot failed: ${e.message}`, 'err');
      return null;
    } finally {
      busy = false;
      if (btn) btn.disabled = false;
    }
  }

  async function dailyTick() {
    try {
      const me = Growth.username();
      if (!me) return;
      const h = await window.ala.channel.history().catch(() => null);
      const list = (h && h.accounts && h.accounts[me]) || [];
      if (!list.length || list[list.length - 1].day !== today()) await snapshot({ quiet: true });
    } catch {  }
  }

  function init() {
    const btn = $('#btn-cg-snap');
    if (btn) btn.addEventListener('click', () => snapshot());
    const tab = document.querySelector('[data-tab="stats"]');
    if (tab) tab.addEventListener('click', () => setTimeout(render, 60));
    render();
    setTimeout(dailyTick, 45000);
    setInterval(dailyTick, 3 * 3600000);
  }

  window.GrowthUI = { init, render, snapshot, dailyTick };
})();
