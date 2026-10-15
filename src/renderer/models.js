/**
 * models.js: which image model made a picture, and which models the app learns from.
 *
 * Every new card records its model ("Qwen-Image 2.1", "Perchance" or "Else"); older cards
 * are inferred from their size. Learning reads the target model's own posts first and blends
 * the other models in as a fading prior, so prompts written for one model are not steered by
 * what worked on another.
 */
(function () {
  const LIST = [
    { id: 'qwen-image-2.1', label: 'Qwen-image-2.1' },
    { id: 'perchance', label: 'Perchance' },
    { id: 'else', label: 'Else' },
  ];
  const IDS = new Set(LIST.map((m) => m.id));
  const DEFAULT_ON = { 'qwen-image-2.1': true, perchance: true, else: false };

  const QWEN_FROM = Date.UTC(2026, 8, 9);

  function label(id) {
    const m = LIST.find((x) => x.id === id);
    return m ? m.label : 'Else';
  }

  function ofCard(card) {
    if (!card) return 'else';
    if (IDS.has(card.model)) return card.model;
    const w = Number(card.width) || 0;
    const h = Number(card.height) || 0;
    if (w === 512 || (w === 2048 && h === 3072)) return 'perchance';
    if (w && (Number(card.createdAt) || 0) >= QWEN_FROM) return 'qwen-image-2.1';
    return 'else';
  }

  function active() {
    const s = (window.State && State.settings) || {};
    const g = s.gen || {};
    if (g.engine === 'comfy') {
      const wf = String((s.comfy && s.comfy.imageWorkflow) || '');
      return /qwen/i.test(wf) || !wf ? 'qwen-image-2.1' : 'else';
    }
    return 'perchance';
  }

  function ofJob(job, engine = null) {
    if (job && (job.editOf || job.promptSource === 'edit')) return 'qwen-image-2.1';
    if (engine === 'perchance') return 'perchance';
    if (engine === 'comfy') {
      const wf = String((job && job.workflow) || (State.settings.comfy || {}).imageWorkflow || '');
      return /qwen/i.test(wf) || !wf ? 'qwen-image-2.1' : 'else';
    }
    return active();
  }

  function selected() {
    const raw = ((window.State && State.settings && State.settings.learn) || {}).models;
    const on = { ...DEFAULT_ON, ...(raw && typeof raw === 'object' ? raw : {}) };
    return new Set(LIST.map((m) => m.id).filter((id) => on[id]));
  }

  window.Models = { LIST, DEFAULT_ON, label, ofCard, active, ofJob, selected };
})();
