/**
 * comiclayout.js: page geometry and canvas drawing for comics.
 *
 * Pure functions, no network, no models, so it is the half of the comic builder
 * that can be tested offline. Layouts are lists of rectangles in 0..1 space, so
 * the same template renders as a thumbnail in the editor and at full size for
 * export. Includes word wrapping, font fitting, captions and speech bubbles.
 */
(function () {
  const LAYOUTS = {
    'grid-2x2': {
      label: '2 × 2 — four panels', kind: 'page', slots: 4,
      rects: [
        { x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0, w: 0.5, h: 0.5 },
        { x: 0, y: 0.5, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
      ],
    },
    'grid-2x3': {
      label: '2 × 3 — six panels', kind: 'page', slots: 6,
      rects: [
        { x: 0, y: 0, w: 0.5, h: 1 / 3 }, { x: 0.5, y: 0, w: 0.5, h: 1 / 3 },
        { x: 0, y: 1 / 3, w: 0.5, h: 1 / 3 }, { x: 0.5, y: 1 / 3, w: 0.5, h: 1 / 3 },
        { x: 0, y: 2 / 3, w: 0.5, h: 1 / 3 }, { x: 0.5, y: 2 / 3, w: 0.5, h: 1 / 3 },
      ],
    },
    'strip-v3': {
      label: 'Vertical strip — three wide panels', kind: 'page', slots: 3,
      rects: [
        { x: 0, y: 0, w: 1, h: 1 / 3 }, { x: 0, y: 1 / 3, w: 1, h: 1 / 3 }, { x: 0, y: 2 / 3, w: 1, h: 1 / 3 },
      ],
    },
    'strip-h3': {
      label: 'Horizontal strip — three tall panels', kind: 'page', slots: 3,
      rects: [
        { x: 0, y: 0, w: 1 / 3, h: 1 }, { x: 1 / 3, y: 0, w: 1 / 3, h: 1 }, { x: 2 / 3, y: 0, w: 1 / 3, h: 1 },
      ],
    },
    'hero-3': {
      label: 'Establishing shot + two reactions', kind: 'page', slots: 3,
      rects: [
        { x: 0, y: 0, w: 1, h: 0.56 },
        { x: 0, y: 0.56, w: 0.5, h: 0.44 }, { x: 0.5, y: 0.56, w: 0.5, h: 0.44 },
      ],
    },
    'hero-5': {
      label: 'Big opener + four beats', kind: 'page', slots: 5,
      rects: [
        { x: 0, y: 0, w: 1, h: 0.4 },
        { x: 0, y: 0.4, w: 0.5, h: 0.3 }, { x: 0.5, y: 0.4, w: 0.5, h: 0.3 },
        { x: 0, y: 0.7, w: 0.5, h: 0.3 }, { x: 0.5, y: 0.7, w: 0.5, h: 0.3 },
      ],
    },
    'pair-v': {
      label: 'Before / after — two stacked', kind: 'page', slots: 2,
      rects: [{ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 1, h: 0.5 }],
    },
    'pair-h': {
      label: 'Before / after — side by side', kind: 'page', slots: 2,
      rects: [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }],
    },
    'story-left': {
      label: 'Picture left · story right', kind: 'story', slots: 1,
      rects: [{ x: 0, y: 0, w: 0.5, h: 1 }],
      textRect: { x: 0.5, y: 0, w: 0.5, h: 1 },
    },
    'story-right': {
      label: 'Picture right · story left', kind: 'story', slots: 1,
      rects: [{ x: 0.5, y: 0, w: 0.5, h: 1 }],
      textRect: { x: 0, y: 0, w: 0.5, h: 1 },
    },
    'story-top': {
      label: 'Picture above · story below', kind: 'story', slots: 1,
      rects: [{ x: 0, y: 0, w: 1, h: 0.62 }],
      textRect: { x: 0, y: 0.62, w: 1, h: 0.38 },
    },
  };

  /** Rects for a panel count the templates do not cover. */
  function autoRects(n) {
    const count = Math.max(1, n | 0);
    if (count === 1) return [{ x: 0, y: 0, w: 1, h: 1 }];
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    const out = [];
    for (let i = 0; i < count; i++) {
      const r = Math.floor(i / cols);
      const inRow = Math.min(cols, count - r * cols);
      const c = i % cols;
      out.push({ x: c / inRow, y: r / rows, w: 1 / inRow, h: 1 / rows });
    }
    return out;
  }

  /** The layout a project is actually using, with `auto` resolved against its panel count. */
  function layoutFor(templateId, panelCount) {
    const t = LAYOUTS[templateId];
    if (!t) return { label: 'Auto grid', kind: 'page', slots: panelCount, rects: autoRects(panelCount) };
    if (panelCount > t.slots && t.kind === 'page') {
      return { ...t, label: `${t.label} (+${panelCount - t.slots} — auto grid)`, slots: panelCount, rects: autoRects(panelCount) };
    }
    return t;
  }

  /** Turn normalised rects into pixel boxes, inset by margin and gutter. */
  function panelBoxes(layout, geom) {
    const { width, height, margin, gutter } = geom;
    const innerW = width - margin * 2;
    const innerH = height - margin * 2;
    const g = gutter / 2;
    return layout.rects.map((r) => ({
      x: Math.round(margin + r.x * innerW + g),
      y: Math.round(margin + r.y * innerH + g),
      w: Math.round(r.w * innerW - gutter),
      h: Math.round(r.h * innerH - gutter),
    }));
  }

  function textBox(layout, geom) {
    if (!layout.textRect) return null;
    const { width, height, margin, gutter } = geom;
    const innerW = width - margin * 2;
    const innerH = height - margin * 2;
    const g = gutter / 2;
    const r = layout.textRect;
    return {
      x: Math.round(margin + r.x * innerW + g),
      y: Math.round(margin + r.y * innerH + g),
      w: Math.round(r.w * innerW - gutter),
      h: Math.round(r.h * innerH - gutter),
    };
  }

  /** Greedy word wrap against a measuring function. */
  function wrapText(text, maxWidth, measure) {
    const lines = [];
    for (const para of String(text || '').split('\n')) {
      if (!para.trim()) { lines.push(''); continue; }
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const probe = line ? `${line} ${word}` : word;
        if (measure(probe) <= maxWidth || !line) {
          if (measure(probe) > maxWidth && !line) {
            let chunk = '';
            for (const ch of word) {
              if (measure(chunk + ch) > maxWidth && chunk) { lines.push(chunk); chunk = ch; }
              else chunk += ch;
            }
            line = chunk;
          } else line = probe;
        } else {
          lines.push(line);
          line = word;
        }
      }
      if (line) lines.push(line);
    }
    return lines;
  }

  /** Largest font size at which `text` fits `box`, down to a floor. */
  function fitFontSize(text, box, { max = 34, min = 11, lineHeight = 1.38, measureAt }) {
    for (let size = max; size >= min; size--) {
      const lines = wrapText(text, box.w, (s) => measureAt(s, size));
      if (lines.length * size * lineHeight <= box.h) return { size, lines, clipped: false };
    }
    const lines = wrapText(text, box.w, (s) => measureAt(s, min));
    const fits = Math.max(1, Math.floor(box.h / (min * lineHeight)));
    return { size: min, lines: lines.slice(0, fits), clipped: lines.length > fits };
  }

  /** `object-fit: cover` for canvas — fill the box, crop the overflow, never distort. */
  function coverRect(img, box) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return { sx: 0, sy: 0, sw: 0, sh: 0 };
    const scale = Math.max(box.w / iw, box.h / ih);
    const sw = box.w / scale;
    const sh = box.h / scale;
    return {
      sx: (iw - sw) / 2,
      sy: Math.max(0, (ih - sh) * 0.35),
      sw, sh,
    };
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  /** A caption box — narration, pinned to a corner of the panel. */
  function drawCaption(ctx, panel, text, style, offsetY = 0) {
    if (!String(text || '').trim()) return null;
    const pad = Math.round(style.fontSize * 0.5);
    const maxW = Math.min(panel.w * 0.62, panel.w - pad * 2);
    ctx.font = `${style.fontWeight || 600} ${style.fontSize}px ${style.font}`;
    const lines = wrapText(text, maxW - pad * 2, (s) => ctx.measureText(s).width);
    const lh = Math.round(style.fontSize * 1.3);
    const boxW = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2);
    const boxH = lines.length * lh + pad * 1.6;
    const x = style.align === 'right' ? panel.x + panel.w - boxW - pad : panel.x + pad;
    const y = style.corner === 'bottom'
      ? panel.y + panel.h - boxH - pad - offsetY
      : panel.y + pad + offsetY;

    ctx.fillStyle = style.bg;
    roundRect(ctx, x, y, boxW, boxH, style.radius ?? 4);
    ctx.fill();
    if (style.borderColor) {
      ctx.strokeStyle = style.borderColor;
      ctx.lineWidth = style.borderWidth || 2;
      ctx.stroke();
    }
    ctx.fillStyle = style.color;
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => ctx.fillText(line, x + pad, y + pad * 0.8 + i * lh));
    return { x, y, w: boxW, h: boxH };
  }

  /** A speech bubble with a tail. */
  function drawBubble(ctx, panel, bubble, style, { avoid = null } = {}) {
    const text = String(bubble.text || '').trim();
    if (!text) return null;
    const pad = Math.round(style.fontSize * 0.62);
    const maxW = Math.min(panel.w * 0.55, 420);
    ctx.font = `${style.fontWeight || 500} ${style.fontSize}px ${style.font}`;
    const lines = wrapText(text, maxW - pad * 2, (s) => ctx.measureText(s).width);
    const lh = Math.round(style.fontSize * 1.28);
    const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
    const boxH = lines.length * lh + pad * 1.4;

    const infX = bubble.kind === 'thought' ? boxW * 0.16 : 0;
    const infY = bubble.kind === 'thought' ? boxH * 0.28 : 0;
    const edge = 6;
    const span = (lo, hi, want) => (hi < lo ? (lo + hi) / 2 : Math.max(lo, Math.min(want, hi)));
    const minX = panel.x + edge + infX;
    const maxX = panel.x + panel.w - boxW - edge - infX;
    const minY = panel.y + edge + infY;
    const maxY = panel.y + panel.h - boxH - edge - infY;

    const ax = panel.x + (bubble.anchor?.x ?? 0.5) * panel.w;
    const ay = panel.y + (bubble.anchor?.y ?? 0.18) * panel.h;
    const x = span(minX, maxX, ax - boxW / 2);
    let y = span(minY, maxY, ay - boxH / 2);

    if (avoid && x < avoid.x + avoid.w && x + boxW > avoid.x
        && y - infY < avoid.y + avoid.h && y + boxH + infY > avoid.y) {
      y = span(minY, maxY, avoid.y + avoid.h + infY + Math.round(style.fontSize * 0.5));
    }

    const tx = panel.x + (bubble.tailTo?.x ?? (bubble.anchor?.x ?? 0.5)) * panel.w;
    const ty = panel.y + (bubble.tailTo?.y ?? Math.min(1, (bubble.anchor?.y ?? 0.18) + 0.34)) * panel.h;

    ctx.fillStyle = style.bg;
    ctx.strokeStyle = style.borderColor;
    ctx.lineWidth = style.borderWidth || 2.5;

    if (bubble.kind === 'thought') {
      drawEllipse(ctx, x + boxW / 2, y + boxH / 2, boxW / 2 + infX, boxH / 2 + infY);
      ctx.fill(); ctx.stroke();
      const steps = 3;
      for (let i = 1; i <= steps; i++) {
        const t = i / (steps + 1);
        const r = style.fontSize * (0.34 - t * 0.16);
        ctx.beginPath();
        ctx.arc(x + boxW / 2 + (tx - (x + boxW / 2)) * t, y + boxH + (ty - (y + boxH)) * t, Math.max(2, r), 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }
    } else {
      roundRect(ctx, x, y, boxW, boxH, style.radius ?? Math.round(style.fontSize * 0.9));
      ctx.fill();
      const half = Math.min(boxW * 0.12, style.fontSize * 0.8);
      const cx = Math.max(x + half + 2, Math.min(tx, x + boxW - half - 2));
      const baseY = ty > y + boxH ? y + boxH : y;
      const dir = ty > y + boxH ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(cx - half, baseY);
      ctx.lineTo(cx + half, baseY);
      ctx.lineTo(tx, ty);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx - half, baseY + dir * 0.5);
      ctx.lineTo(tx, ty);
      ctx.lineTo(cx + half, baseY + dir * 0.5);
      ctx.stroke();
      roundRect(ctx, x, y, boxW, boxH, style.radius ?? Math.round(style.fontSize * 0.9));
      ctx.stroke();
    }

    ctx.fillStyle = style.color;
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => {
      const w = ctx.measureText(line).width;
      ctx.fillText(line, x + (boxW - w) / 2, y + pad * 0.7 + i * lh);
    });
    if (bubble.speaker && bubble.kind !== 'thought') {
      const size = Math.round(style.fontSize * 0.68);
      ctx.font = `600 ${size}px ${style.font}`;
      const tw = ctx.measureText(bubble.speaker).width;
      const cpad = Math.round(size * 0.45);
      const cw = tw + cpad * 2;
      const ch = Math.round(size * 1.5);
      const cx = span(panel.x + edge, panel.x + panel.w - cw - edge, x + pad);
      const cy = y - ch - Math.round(size * 0.25) >= panel.y + edge
        ? y - ch - Math.round(size * 0.25)
        : y + boxH + Math.round(size * 0.25);
      ctx.fillStyle = style.bg;
      ctx.strokeStyle = style.borderColor;
      ctx.lineWidth = Math.max(1, (style.borderWidth || 2) * 0.7);
      roundRect(ctx, cx, cy, cw, ch, Math.round(ch / 2));
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = style.speakerColor || style.color;
      ctx.textBaseline = 'top';
      ctx.fillText(bubble.speaker, cx + cpad, cy + Math.round(size * 0.22));
    }
    return { x, y, w: boxW, h: boxH };
  }

  function drawEllipse(ctx, cx, cy, rx, ry) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(4, rx), Math.max(4, ry), 0, 0, Math.PI * 2);
    ctx.closePath();
  }

  window.ComicLayout = {
    LAYOUTS, autoRects, layoutFor, panelBoxes, textBox,
    wrapText, fitFontSize, coverRect, roundRect, drawCaption, drawBubble,
  };
})();
