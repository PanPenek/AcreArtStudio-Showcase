/**
 * teaser.js: make a preview copy of an artwork (blurred and captioned) as a new
 * card, paired with the original so either half can be found or undone from the
 * other. All drawing is done on a canvas with the browser's GPU compositor; no
 * image library is needed.
 */
(function () {
  const DEFAULTS = {
    blur: 28,
    badge: '#Join Patreon',
    band: 'middle',
    showLink: true,
    darken: 0.25,
    format: 'jpeg',
  };

  const REFERENCE_EDGE = 1000;

  const cfg = () => ({ ...DEFAULTS, ...((State.settings.patreon || {}).teaser || {}) });

  /** Load one library image as a decoded bitmap the canvas can draw. */
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('the image could not be read from disk'));
      img.src = url;
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  const Teaser = {
    defaults: () => ({ ...DEFAULTS }),
    settings: cfg,

    /** Remember the last set of knobs, so the second teaser is one press. */
    async saveSettings(opts) {
      State.settings = await window.ala.settings.patch({ patreon: { teaser: { ...cfg(), ...opts } } });
      return (State.settings.patreon || {}).teaser;
    },

    /** Draw the teaser onto a canvas and return it. */
    async render(card, opts = {}, { scale = 1, canvas = null } = {}) {
      const o = { ...cfg(), ...opts };
      const img = await loadImage(card.url);
      const w = Math.max(1, Math.round((card.width || img.naturalWidth) * scale));
      const h = Math.max(1, Math.round((card.height || img.naturalHeight) * scale));

      const cv = canvas || document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, w, h);

      const radius = Math.max(1, (Number(o.blur) || 0) * (Math.max(w, h) / REFERENCE_EDGE));

      const bleed = radius * 2;
      ctx.save();
      ctx.filter = `blur(${radius}px)`;
      ctx.drawImage(img, -bleed, -bleed, w + bleed * 2, h + bleed * 2);
      ctx.restore();

      if (o.darken > 0) {
        ctx.fillStyle = `rgba(0,0,0,${Math.min(0.9, Number(o.darken) || 0)})`;
        ctx.fillRect(0, 0, w, h);
      }

      if (o.band !== 'none' && String(o.badge || '').trim()) {
        this.drawBand(ctx, w, h, o);
      }
      return cv;
    },

    /** The caption band. */
    drawBand(ctx, w, h, o) {
      const link = String((State.settings.patreon || {}).link || '');
      const badge = String(o.badge || '').trim();
      const showLink = o.showLink && link;

      const fs = Math.max(14, Math.round(Math.min(w, h) * 0.075));
      const linkFs = Math.round(fs * 0.38);
      const padY = Math.round(fs * 0.55);
      const bandH = padY * 2 + fs + (showLink ? Math.round(linkFs * 1.7) : 0);
      const y = o.band === 'bottom' ? h - bandH - Math.round(h * 0.04) : Math.round((h - bandH) / 2);

      const inset = Math.round(w * 0.06);
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      roundRect(ctx, inset, y, w - inset * 2, bandH, Math.round(fs * 0.35));
      ctx.fill();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = Math.round(fs * 0.35);
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${fs}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillText(badge, w / 2, y + padY, w - inset * 2 - fs);

      if (showLink) {
        ctx.font = `500 ${linkFs}px "Segoe UI", system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(255,255,255,0.86)';
        ctx.fillText(link.replace(/^https?:\/\//, ''), w / 2, y + padY + fs + Math.round(linkFs * 0.5),
          w - inset * 2 - fs);
      }
      ctx.restore();
    },

    /** Has this card already got a teaser that still exists? */
    teaserOf(card) {
      if (!card || !card.teaserId) return null;
      return State.library.find((c) => c.id === card.teaserId) || null;
    },

    /** Resolve the whole pair from whichever half you happen to be holding. */
    pair(card) {
      if (!card) return { original: null, teaser: null };
      if (card.promptSource === 'teaser') {
        return {
          teaser: card,
          original: card.teaserFor ? (State.library.find((c) => c.id === card.teaserFor) || null) : null,
        };
      }
      return { original: card, teaser: this.teaserOf(card) };
    },

    /** Make the pair. */
    async make(card, opts = {}) {
      const o = { ...cfg(), ...opts };
      if (!card || !card.url) throw new Error('this card has no image');

      const cv = await this.render(card, o, { scale: 1 });
      const ext = o.format === 'png' ? 'png' : 'jpg';
      const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
      const base64 = cv.toDataURL(mime, 0.92).split(',')[1];
      if (!base64) throw new Error('the teaser could not be rendered');
      const saved = await window.ala.files.saveImage(base64, ext, 'teaser');

      const p = State.settings.patreon || {};
      const meta = card.metadata || { title: '', description: '', tags: [] };
      const teaser = {
        id: saved.id,
        jobId: null,
        theme: card.theme || '',
        prompt: card.prompt || '',
        promptSource: 'teaser',
        learnedFrom: card.learnedFrom || null,
        teaserFor: card.id,
        continuationOf: card.continuationOf || null,
        requestId: card.requestId || null,
        fname: saved.fname, path: saved.path, url: saved.url,
        mime, width: cv.width, height: cv.height,
        destination: 'deviantart',
        status: 'review',
        qc: null, qcSkipped: true,
        metadata: {
          title: meta.title || '',
          description: Pipeline.addPatreonBlock(meta.description || '', p),
          tags: [...(meta.tags || [])],
        },
        mature: false,
        da: null, error: null,
        createdAt: Date.now(), updatedAt: Date.now(),
      };

      Pipeline.setDestination(card, 'patreon');
      card.teaserId = teaser.id;
      card.updatedAt = Date.now();

      State.library.unshift(teaser);
      State.persistLibrary();
      State.addLog(`Teaser made for "${meta.title || card.fname}" — the blurred copy goes to DeviantArt, `
        + `the original is now queued for Patreon.`, 'ok');
      return { teaser, original: card };
    },

    /** Undo the pair, from either half. */
    async undo(card) {
      const { original, teaser } = this.pair(card);
      const isPair = !!teaser || card.promptSource === 'teaser' || !!(original && original.teaserId);
      if (!isPair) throw new Error('this card is not part of a teaser pair');

      if (teaser) {
        State.library = State.library.filter((c) => c.id !== teaser.id);
        window.ala.files.deleteImage(teaser.fname).catch(() => {});
      }
      if (original) {
        original.teaserId = null;
        Pipeline.setDestination(original, 'deviantart');
        original.updatedAt = Date.now();
      }
      State.persistLibrary();
      State.addLog(original
        ? 'Teaser removed — the original is back on the DeviantArt route with its Patreon link restored.'
        : 'Teaser removed. Its original is no longer in the library, so there was nothing to route back.',
        'ok');
      return { original, removed: !!teaser };
    },
  };

  window.Teaser = Teaser;
})();
