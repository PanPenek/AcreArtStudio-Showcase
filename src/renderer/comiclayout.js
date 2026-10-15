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
    'hero-4': {
      label: 'Wide opener, two beats, wide closer', kind: 'page', slots: 4,
      rects: [
        { x: 0, y: 0, w: 1, h: 0.3 },
        { x: 0, y: 0.3, w: 0.5, h: 0.38 }, { x: 0.5, y: 0.3, w: 0.5, h: 0.38 },
        { x: 0, y: 0.68, w: 1, h: 0.32 },
      ],
    },
    'manga-4': {
      label: 'Wide opener, tall panel + two stacked', kind: 'page', slots: 4,
      rects: [
        { x: 0, y: 0, w: 1, h: 0.32 },
        { x: 0, y: 0.32, w: 0.5, h: 0.68 },
        { x: 0.5, y: 0.32, w: 0.5, h: 0.34 }, { x: 0.5, y: 0.66, w: 0.5, h: 0.34 },
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
    'hero-6': {
      label: 'Wide opener, four beats, wide closer', kind: 'page', slots: 6,
      rects: [
        { x: 0, y: 0, w: 1, h: 0.24 },
        { x: 0, y: 0.24, w: 0.5, h: 0.26 }, { x: 0.5, y: 0.24, w: 0.5, h: 0.26 },
        { x: 0, y: 0.5, w: 0.5, h: 0.26 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.26 },
        { x: 0, y: 0.76, w: 1, h: 0.24 },
      ],
    },
    'strip-v3': {
      label: 'Three wide panels', kind: 'page', slots: 3,
      rects: [
        { x: 0, y: 0, w: 1, h: 1 / 3 }, { x: 0, y: 1 / 3, w: 1, h: 1 / 3 }, { x: 0, y: 2 / 3, w: 1, h: 1 / 3 },
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
    'manga-5': {
      label: 'Two up top, wide middle, two below', kind: 'page', slots: 5,
      rects: [
        { x: 0, y: 0, w: 0.5, h: 0.3 }, { x: 0.5, y: 0, w: 0.5, h: 0.3 },
        { x: 0, y: 0.3, w: 1, h: 0.36 },
        { x: 0, y: 0.66, w: 0.5, h: 0.34 }, { x: 0.5, y: 0.66, w: 0.5, h: 0.34 },
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
    'row-2': {
      label: 'Strip — two tall panels side by side', kind: 'page', slots: 2, row: true, page: { width: 1800, height: 1300 },
      rects: [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }],
    },
    'row-3': {
      label: 'Strip — three tall panels side by side', kind: 'page', slots: 3, row: true, page: { width: 2400, height: 1200 },
      rects: [{ x: 0, y: 0, w: 1 / 3, h: 1 }, { x: 1 / 3, y: 0, w: 1 / 3, h: 1 }, { x: 2 / 3, y: 0, w: 1 / 3, h: 1 }],
    },
    'row-4': {
      label: 'Strip — four tall panels side by side', kind: 'page', slots: 4, row: true, page: { width: 2900, height: 1150 },
      rects: [0, 1, 2, 3].map((i) => ({ x: i / 4, y: 0, w: 1 / 4, h: 1 })),
    },
    'single': {
      label: 'One full-page panel', kind: 'page', slots: 1,
      rects: [{ x: 0, y: 0, w: 1, h: 1 }],
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

  const PAGE_STYLES = {
    classic: { label: 'Classic — white gutters, black frames' },
    tight: { label: 'Tight — no white bars, thin black lines', margin: 0, gutter: 0, border: 3 },
    bleed: { label: 'Borderless — pictures touch, no lines at all', margin: 0, gutter: 0, border: 0 },
    manga: { label: 'Manga — narrow gutters, heavy frames', margin: 34, gutter: 12, border: 6, borderColor: '#000000' },
    rounded: {
      label: 'Soft cards — rounded panels on a pastel gradient', margin: 30, gutter: 26, border: 0, radius: 22, edge: 6, edgeColor: '#ffffff',
      bg: { type: 'gradient', colors: ['#bfe7ff', '#efd9ff', '#ffe0ef'] }, titleColor: '#3b2a5c',
    },
    dots: {
      label: 'Polka page — bold frames on a dotted pastel page', margin: 36, gutter: 30, border: 6, borderColor: '#111111',
      bg: { type: 'dots', color: '#fdeef5', dot: '#bccdff' }, titleColor: '#111111',
    },
  };
  const pageStyle = (key) => PAGE_STYLES[key] || PAGE_STYLES.classic;

  function drawPageBackground(ctx, W, H, ps, fallback, scale = 1) {
    const bg = ps.bg || null;
    if (bg && bg.type === 'gradient') {
      const g = ctx.createLinearGradient(0, 0, W, H);
      const cs = bg.colors || ['#ffffff', '#eeeeee'];
      cs.forEach((c, i) => g.addColorStop(cs.length > 1 ? i / (cs.length - 1) : 0, c));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      return;
    }
    ctx.fillStyle = (bg && bg.color) || fallback || '#ffffff';
    ctx.fillRect(0, 0, W, H);
    if (bg && bg.type === 'dots') {
      const step = Math.max(14, 54 * scale), r = Math.max(3, 10 * scale);
      ctx.fillStyle = bg.dot || '#dddddd';
      for (let y = step / 2, row = 0; y < H + step; y += step * 0.87, row++) {
        for (let x = (row % 2 ? step / 2 : 0); x < W + step; x += step) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  function panelPath(ctx, box, ps, scale = 1) {
    const r = Math.round((ps.radius || 0) * scale);
    if (r > 0) roundRect(ctx, box.x, box.y, box.w, box.h, r);
    else { ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); }
  }

  function drawPanelFrame(ctx, box, ps, fallbackColor, scale = 1) {
    if (ps.edge) {
      const e = Math.max(2, Math.round(ps.edge * scale));
      ctx.save();
      panelPath(ctx, box, ps, scale);
      ctx.clip();
      panelPath(ctx, box, ps, scale);
      ctx.strokeStyle = ps.edgeColor || '#ffffff';
      ctx.lineWidth = e * 2;
      ctx.stroke();
      ctx.restore();
    }
    const bw = ps.border == null ? 4 : ps.border;
    if (bw > 0) {
      ctx.strokeStyle = ps.borderColor || fallbackColor || '#111111';
      ctx.lineWidth = Math.max(1, Math.round(bw * scale));
      panelPath(ctx, box, ps, scale);
      ctx.stroke();
    }
  }

  function drawPageMarks(ctx, W, H, { signature = '', pageNo = '', color = '#111111', font = 'sans-serif', margin = 0 }, scale = 1) {
    if (!signature && !pageNo) return;
    const fs = Math.max(12, Math.round(30 * scale));
    const y = margin >= fs * 1.2 ? H - margin / 2 : H - fs * 0.9;
    ctx.save();
    ctx.font = `700 ${fs}px ${font}`;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const put = (text, x, align) => {
      const w = ctx.measureText(text).width;
      const tx = align === 'right' ? x - w : x;
      if (margin < fs * 1.2) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(3, fs * 0.22); ctx.strokeText(text, tx, y); }
      ctx.fillStyle = color;
      ctx.fillText(text, tx, y);
    };
    const pad = Math.max(fs, margin);
    if (signature) put(String(signature), pad, 'left');
    if (pageNo) put(String(pageNo), W - pad, 'right');
    ctx.restore();
  }

  /** Rects for a panel count the templates do not cover. */
  function autoRects(n) {
    const count = Math.max(1, n | 0);
    if (count === 1) return [{ x: 0, y: 0, w: 1, h: 1 }];
    const cols = count <= 4 ? 2 : count <= 9 ? 3 : 4;
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
    if (panelCount !== t.slots && t.kind === 'page') {
      return { ...t, label: `${t.label} (auto grid for ${panelCount})`, slots: panelCount, rects: autoRects(panelCount) };
    }
    return t;
  }

  /** Turn normalised rects into pixel boxes, inset by margin and gutter. */
  function panelBoxes(layout, geom) {
    const { width, height, margin, gutter } = geom;
    const top = geom.top || 0;
    const innerW = width - margin * 2;
    const innerH = height - top - margin * 2;
    const g = gutter / 2;
    return layout.rects.map((r) => ({
      x: Math.round(margin + r.x * innerW + g),
      y: Math.round(top + margin + r.y * innerH + g),
      w: Math.round(r.w * innerW - gutter),
      h: Math.round(r.h * innerH - gutter),
    }));
  }

  function textBox(layout, geom) {
    if (!layout.textRect) return null;
    return panelBoxes({ rects: [layout.textRect] }, geom)[0];
  }

  const ASPECTS = [
    ['1:1 (Square)', 1], ['2:3 (Portrait Photo)', 2 / 3], ['3:2 (Photo)', 3 / 2],
    ['3:4 (Portrait Standard)', 3 / 4], ['4:3 (Standard)', 4 / 3],
    ['9:16 (Portrait Widescreen)', 9 / 16], ['16:9 (Widescreen)', 16 / 9], ['21:9 (Ultrawide)', 21 / 9],
  ];
  function nearestAspect(w, h) {
    const r = Number(w) / Number(h);
    if (!(r > 0) || !Number.isFinite(r)) return '1:1 (Square)';
    let best = null;
    for (const [label, v] of ASPECTS) {
      const d = Math.abs(Math.log(r / v));
      if (!best || d < best.d) best = { label, d };
    }
    return best.label;
  }
  const aspectRatio = (label) => (ASPECTS.find(([l]) => l === label) || [null, 1])[1];

  function slotAspects(layout, geom) {
    return panelBoxes(layout, geom).map((b) => nearestAspect(b.w, b.h));
  }

  function pickLayout(shots, geom = { width: 1400, height: 1900, margin: 40, gutter: 18 }, { sequence = false } = {}) {
    const n = shots.length;
    if (sequence && LAYOUTS[`row-${n}`]) return `row-${n}`;
    const cands = Object.entries(LAYOUTS).filter(([, t]) => t.kind === 'page' && t.slots === n && !t.row);
    if (!cands.length) return 'auto';
    let best = null;
    for (const [id, t] of cands) {
      const boxes = panelBoxes(t, t.page ? { ...geom, ...t.page } : geom);
      let score = 0;
      boxes.forEach((b, i) => {
        const r = b.w / b.h;
        const shot = String(shots[i] || 'medium');
        if (shot === 'wide') score += r >= 1.3 ? 3 : r >= 1 ? 1 : -2;
        else if (shot === 'close' || shot === 'extreme-close') score += r <= 1.15 ? 2 : r <= 1.6 ? 0 : -1;
        else score += r >= 0.6 && r <= 1.8 ? 1 : 0;
      });
      if (!best || score > best.score) best = { id, score };
    }
    return best.id;
  }

  function webtoonBoxes(ratios, { width = 1080, margin = 40, gutter = 70, top = 0 } = {}) {
    const w = width - margin * 2;
    let y = top + margin;
    const boxes = ratios.map((r) => {
      const ratio = Number(r) > 0 ? Number(r) : 1;
      const h = Math.round(w / ratio);
      const box = { x: margin, y, w, h };
      y += h + gutter;
      return box;
    });
    return { boxes, height: y - gutter + margin };
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
  function coverRect(img, box, focus = null) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return { sx: 0, sy: 0, sw: 0, sh: 0 };
    const scale = Math.max(box.w / iw, box.h / ih);
    const sw = box.w / scale;
    const sh = box.h / scale;
    const fx = focus && Number.isFinite(focus.x) ? focus.x : 0.5;
    const fy = focus && Number.isFinite(focus.y) ? focus.y : 0.35;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    return {
      sx: clamp(fx * iw - sw / 2, 0, iw - sw),
      sy: focus ? clamp(fy * ih - sh / 2, 0, ih - sh) : Math.max(0, (ih - sh) * 0.35),
      sw, sh,
    };
  }

  const rectArea = (r) => Math.max(0, r.w) * Math.max(0, r.h);
  function overlap(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
  }
  function boxPx(b, W, H) {
    if (!Array.isArray(b) || b.length < 4) return null;
    const [x, y, w, h] = b.map(Number);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    return { x: x * W, y: y * H, w: w * W, h: h * H };
  }
  const norm = (s) => String(s || '').trim().toLowerCase();
  const round3 = (v) => Math.round(v * 1000) / 1000;

  function placeBalloons({ panel, items, people = [], empty = [], avoid = [] }) {
    const W = Math.max(1, panel.w), H = Math.max(1, panel.h);
    const heads = (people || []).map((p) => ({
      name: norm(p && p.name),
      head: boxPx(p && p.head, W, H),
      body: boxPx(p && p.body, W, H),
    })).filter((p) => p.head);
    const free = (empty || []).map((b) => boxPx(b, W, H)).filter(Boolean);
    const taken = (avoid || []).filter(Boolean).map((r) => ({ ...r }));
    const edge = Math.round(Math.min(W, H) * 0.025);
    const out = [];
    let prev = null;
    const speakerOf = (name, i) => {
      const n = norm(name);
      if (!n || !heads.length) return null;
      const exact = heads.find((h) => h.name && (h.name === n || h.name.includes(n) || n.includes(h.name)));
      if (exact) return exact;
      if (heads.length === 1) return heads[0];
      const sorted = [...heads].sort((a, b) => a.head.x - b.head.x);
      return sorted[i % sorted.length];
    };
    const STEPS = 11;
    items.forEach((it, i) => {
      const bw = Math.min(it.w, W - edge * 2), bh = Math.min(it.h, H - edge * 2);
      const who = it.kind === 'caption' ? null : speakerOf(it.speaker, i);
      let chosen;
      if (it.fixed && it.fixed.anchor) {
        const clampC = (v, half, size) => (size - edge * 2 <= half * 2 ? size / 2 : Math.max(edge + half, Math.min(size - edge - half, v)));
        chosen = { cx: clampC(it.fixed.anchor.x * W, bw / 2, W), cy: clampC(it.fixed.anchor.y * H, bh / 2, H) };
      } else {
        let best = null;
        for (let gy = 0; gy < STEPS; gy++) {
          for (let gx = 0; gx < STEPS; gx++) {
            const cx = edge + bw / 2 + (W - edge * 2 - bw) * (gx / (STEPS - 1));
            const cy = edge + bh / 2 + (H - edge * 2 - bh) * (gy / (STEPS - 1));
            const r = { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
            const area = rectArea(r) || 1;
            let cost = 0;
            for (const p of heads) {
              const grown = { x: p.head.x - p.head.w * 0.12, y: p.head.y - p.head.h * 0.12, w: p.head.w * 1.24, h: p.head.h * 1.24 };
              cost += (overlap(r, grown) / area) * 5000;
              if (p.body) cost += (overlap(r, p.body) / area) * 250;
            }
            for (const t of taken) cost += (overlap(r, t) / area) * 6000;
            if (prev) {
              if (cy + bh * 0.25 < prev.cy - prev.h * 0.5) cost += 900;
              else if (Math.abs(cy - prev.cy) < (bh + prev.h) / 4 && cx < prev.cx) cost += 500;
            }
            if (who) {
              const hx = who.head.x + who.head.w / 2, hy = who.head.y;
              cost += (Math.hypot(cx - hx, cy - hy) / Math.hypot(W, H)) * 500;
              if (cy > who.head.y + who.head.h * 0.5) cost += 160;
            }
            cost += (cy / H) * 140;
            for (const f of free) cost -= (overlap(r, f) / area) * 260;
            if (!best || cost < best.cost) best = { cost, cx, cy };
          }
        }
        chosen = best;
      }
      const rect = { x: chosen.cx - bw / 2, y: chosen.cy - bh / 2, w: bw, h: bh };
      taken.push(rect);
      prev = { cx: chosen.cx, cy: chosen.cy, h: bh };
      const keptTail = it.fixed && it.fixed.tailTo ? it.fixed.tailTo : null;
      out.push({
        anchor: { x: round3(chosen.cx / W), y: round3(chosen.cy / H) },
        tailTo: it.kind === 'caption' || it.kind === 'float' ? null
          : keptTail || tailTip({ cx: chosen.cx, cy: chosen.cy, w: bw, h: bh }, who, W, H),
      });
    });
    return out;
  }

  function tailTip(b, who, W, H) {
    if (!who) {
      const tx = b.cx + (W / 2 - b.cx) * 0.25;
      const ty = Math.min(H * 0.97, b.cy + b.h / 2 + H * 0.1);
      return { x: round3(tx / W), y: round3(ty / H) };
    }
    const hb = who.head;
    const mx = hb.x + hb.w / 2, my = hb.y + hb.h * 0.72;
    const gx = hb.w * 0.1, gy = hb.h * 0.1;
    const inHead = (x, y) => x > hb.x - gx && x < hb.x + hb.w + gx && y > hb.y - gy && y < hb.y + hb.h + gy;
    if (inHead(b.cx, b.cy)) return { x: round3(mx / W), y: round3(my / H) };
    let tx = mx, ty = my;
    for (let t = 0; t <= 1; t += 0.02) {
      tx = mx + (b.cx - mx) * t;
      ty = my + (b.cy - my) * t;
      if (!inHead(tx, ty)) break;
    }
    const dx = mx - b.cx, dy = my - b.cy;
    const dist = Math.hypot(dx, dy) || 1;
    const edgeR = Math.hypot((dx / dist) * (b.w / 2), (dy / dist) * (b.h / 2));
    const minR = Math.min(dist * 0.85, edgeR + Math.min(W, H) * 0.07);
    if (Math.hypot(tx - b.cx, ty - b.cy) < minR) { tx = b.cx + (dx / dist) * minR; ty = b.cy + (dy / dist) * minR; }
    return { x: round3(Math.max(0.01, Math.min(0.99, tx / W))), y: round3(Math.max(0.01, Math.min(0.99, ty / H))) };
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

  const upper = (s, st) => (st && st.uppercase === false ? String(s || '') : String(s || '').toUpperCase());

  /** A caption box — narration, pinned to a corner of the panel. */
  function drawCaption(ctx, panel, text, style) {
    if (!String(text || '').trim()) return null;
    const fs = style.fontSize;
    const pad = Math.round(fs * 0.55);
    const maxW = Math.min(panel.w * 0.7, panel.w - pad * 2);
    ctx.font = `${style.fontWeight || 700} ${fs}px ${style.font}`;
    const words = upper(text, style);
    const lines = wrapText(words, maxW - pad * 2, (s) => ctx.measureText(s).width);
    const lh = Math.round(fs * 1.18);
    const boxW = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2);
    const boxH = lines.length * lh + pad * 1.4;
    const inset = Math.round(style.inset || 0);
    let x = style.align === 'right' ? panel.x + panel.w - boxW - inset : panel.x + inset;
    let y = style.corner === 'bottom' ? panel.y + panel.h - boxH - inset : panel.y + inset;
    if (style.at && Number.isFinite(style.at.x) && Number.isFinite(style.at.y)) {
      x = panel.x + Math.max(0, Math.min(panel.w - boxW, style.at.x * panel.w));
      y = panel.y + Math.max(0, Math.min(panel.h - boxH, style.at.y * panel.h));
    }
    ctx.fillStyle = style.bg;
    ctx.fillRect(x, y, boxW, boxH);
    if (style.borderColor) {
      ctx.strokeStyle = style.borderColor;
      ctx.lineWidth = style.borderWidth || 2;
      ctx.strokeRect(x, y, boxW, boxH);
    }
    ctx.fillStyle = style.color;
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => ctx.fillText(line, x + pad, y + pad * 0.75 + i * lh));
    return { x, y, w: boxW, h: boxH };
  }

  function measureBalloon(ctx, line, style, panel) {
    const kind = line.kind || 'speech';
    if (kind === 'float') return measureFloat(ctx, line, style, panel);
    const fs = style.fontSize;
    ctx.font = `${style.fontWeight || 700} ${fs}px ${style.font}`;
    const lh = Math.round(fs * 1.12);
    const text = upper(line.text, style);
    const full = ctx.measureText(text).width;
    const wantLines = Math.max(1, Math.round(Math.sqrt(full / (lh * 3.5))));
    const maxW = Math.max(fs * 4, Math.min(panel.w * 0.46, fs * 13, (full / wantLines) * 1.12));
    const lines = wrapText(text, maxW, (s) => ctx.measureText(s).width);
    const tw = Math.max(...lines.map((l) => ctx.measureText(l).width), fs);
    const th = lines.length * lh;
    const grow = kind === 'thought' ? 1.42 : kind === 'shout' ? 1.5 : 1.3;
    const pad = fs * 0.35;
    const rx = (tw / 2) * grow + pad;
    const ry = (th / 2) * grow + pad;
    return { lines, lh, tw, th, rx, ry, w: rx * 2, h: ry * 2 };
  }

  function ellipsePath(ctx, cx, cy, rx, ry) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(4, rx), Math.max(4, ry), 0, 0, Math.PI * 2);
    ctx.closePath();
  }

  function tailPath(ctx, cx, cy, rx, ry, tx, ty, base) {
    const ang = Math.atan2((ty - cy) / ry, (tx - cx) / rx);
    const spread = Math.min(0.32, base / Math.max(rx, ry));
    const p1 = { x: cx + Math.cos(ang - spread) * rx * 0.92, y: cy + Math.sin(ang - spread) * ry * 0.92 };
    const p2 = { x: cx + Math.cos(ang + spread) * rx * 0.92, y: cy + Math.sin(ang + spread) * ry * 0.92 };
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const nx = -(ty - mid.y), ny = tx - mid.x;
    const nl = Math.hypot(nx, ny) || 1;
    const bend = Math.hypot(tx - mid.x, ty - mid.y) * 0.18;
    const c = { x: (mid.x + tx) / 2 + (nx / nl) * bend, y: (mid.y + ty) / 2 + (ny / nl) * bend };
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.quadraticCurveTo(c.x, c.y, tx, ty);
    ctx.quadraticCurveTo(c.x, c.y, p2.x, p2.y);
    ctx.closePath();
  }

  function burstPath(ctx, cx, cy, rx, ry) {
    const pts = 22;
    ctx.beginPath();
    for (let i = 0; i < pts; i++) {
      const a = (i / pts) * Math.PI * 2;
      const k = i % 2 === 0 ? 1.12 : 0.9;
      const x = cx + Math.cos(a) * rx * k, y = cy + Math.sin(a) * ry * k;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function drawBalloon(ctx, panel, line, style) {
    const text = String(line.text || '').trim();
    if (!text) return null;
    if ((line.kind || 'speech') === 'float') return drawFloat(ctx, panel, line, style);
    const m = line._m || measureBalloon(ctx, line, style, panel);
    const kind = line.kind || 'speech';
    const cx = panel.x + (line.anchor ? line.anchor.x : 0.5) * panel.w;
    const cy = panel.y + (line.anchor ? line.anchor.y : 0.15) * panel.h;
    const tip = line.tailTo ? { x: panel.x + line.tailTo.x * panel.w, y: panel.y + line.tailTo.y * panel.h } : null;
    const bw = Math.max(1.5, style.borderWidth || 2.5);
    const shapes = [];
    if (kind === 'thought') {
      const puffs = Math.max(8, Math.round((m.rx + m.ry) / (style.fontSize * 0.9)));
      const pr = Math.min(m.rx, m.ry) * 0.38;
      for (let i = 0; i < puffs; i++) {
        const a = (i / puffs) * Math.PI * 2;
        const px = cx + Math.cos(a) * (m.rx - pr * 0.6), py = cy + Math.sin(a) * (m.ry - pr * 0.6);
        shapes.push(() => ellipsePath(ctx, px, py, pr, pr * 0.9));
      }
      shapes.push(() => ellipsePath(ctx, cx, cy, m.rx - pr * 0.5, m.ry - pr * 0.5));
      if (tip) {
        for (let i = 1; i <= 3; i++) {
          const t = 0.3 + i * 0.2;
          const sx = cx + (tip.x - cx) * t, sy = cy + (tip.y - cy) * t;
          const r = style.fontSize * (0.42 - i * 0.09);
          if (Math.hypot((sx - cx) / m.rx, (sy - cy) / m.ry) > 1.05) shapes.push(() => ellipsePath(ctx, sx, sy, r, r));
        }
      }
    } else if (kind === 'shout') {
      shapes.push(() => burstPath(ctx, cx, cy, m.rx, m.ry));
      if (tip) shapes.push(() => tailPath(ctx, cx, cy, m.rx, m.ry, tip.x, tip.y, style.fontSize * 0.9));
    } else {
      shapes.push(() => ellipsePath(ctx, cx, cy, m.rx, m.ry));
      if (tip) shapes.push(() => tailPath(ctx, cx, cy, m.rx, m.ry, tip.x, tip.y, style.fontSize * 0.75));
    }
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = style.borderColor;
    ctx.lineWidth = bw * 2;
    if (kind === 'whisper') ctx.setLineDash([style.fontSize * 0.45, style.fontSize * 0.3]);
    for (const s of shapes) { s(); ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.fillStyle = kind === 'shout' && style.shoutBg ? style.shoutBg : style.bg;
    for (const s of shapes) { s(); ctx.fill(); }
    ctx.fillStyle = style.color;
    ctx.textBaseline = 'middle';
    ctx.font = `${style.fontWeight || 700} ${style.fontSize}px ${style.font}`;
    const top = cy - m.th / 2 + m.lh / 2;
    m.lines.forEach((l, i) => {
      const w = ctx.measureText(l).width;
      ctx.fillText(l, cx - w / 2, top + i * m.lh);
    });
    ctx.restore();
    return { x: cx - m.rx, y: cy - m.ry, w: m.rx * 2, h: m.ry * 2 };
  }

  function drawSfx(ctx, panel, text, style, at = { x: 0.78, y: 0.82 }) {
    const t = String(text || '').trim().toUpperCase();
    if (!t) return null;
    const fs = Math.round(Math.min(panel.w, panel.h) * 0.13 * (Number(style.scale) > 0 ? Number(style.scale) : 1));
    ctx.save();
    ctx.translate(panel.x + at.x * panel.w, panel.y + at.y * panel.h);
    ctx.rotate(Number.isFinite(style.angle) ? style.angle : -0.14);
    ctx.font = `400 ${fs}px ${style.sfxFont || style.font}`;
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(t).width;
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(4, fs * 0.16);
    ctx.strokeStyle = style.sfxStroke || '#111';
    ctx.strokeText(t, -w / 2, 0);
    ctx.fillStyle = style.sfxColor || '#ffd23f';
    ctx.fillText(t, -w / 2, 0);
    ctx.restore();
    return { x: panel.x + at.x * panel.w - w / 2, y: panel.y + at.y * panel.h - fs / 2, w, h: fs };
  }

  function measureFloat(ctx, line, style, panel) {
    const fs = Math.round(style.fontSize * 1.3);
    ctx.font = `400 ${fs}px ${style.handFont || style.font}`;
    const lh = Math.round(fs * 1.02);
    const text = upper(line.text, style);
    const full = ctx.measureText(text).width;
    const wantLines = Math.max(1, Math.round(Math.sqrt(full / (lh * 2.6))));
    const maxW = Math.max(fs * 3, Math.min(panel.w * 0.42, fs * 9, (full / wantLines) * 1.1));
    const lines = wrapText(text, maxW, (s) => ctx.measureText(s).width);
    const tw = Math.max(...lines.map((l) => ctx.measureText(l).width), fs);
    const th = lines.length * lh;
    const pad = fs * 0.25;
    return { lines, lh, tw, th, fs, rx: tw / 2 + pad, ry: th / 2 + pad, w: tw + pad * 2, h: th + pad * 2, float: true };
  }

  function drawFloat(ctx, panel, line, style) {
    const m = line._m && line._m.float ? line._m : measureFloat(ctx, line, style, panel);
    const cx = panel.x + (line.anchor ? line.anchor.x : 0.5) * panel.w;
    const cy = panel.y + (line.anchor ? line.anchor.y : 0.15) * panel.h;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Number.isFinite(line.rot) ? line.rot : -0.05);
    ctx.font = `400 ${m.fs}px ${style.handFont || style.font}`;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const top = -m.th / 2 + m.lh / 2;
    m.lines.forEach((l, i) => {
      const w = ctx.measureText(l).width;
      const x = -w / 2, y = top + i * m.lh;
      ctx.strokeStyle = style.floatStroke || '#ffffff';
      ctx.lineWidth = Math.max(3, m.fs * 0.2);
      ctx.strokeText(l, x, y);
      ctx.fillStyle = style.floatColor || style.color || '#1f8fb3';
      ctx.fillText(l, x, y);
    });
    ctx.restore();
    return { x: cx - m.w / 2, y: cy - m.h / 2, w: m.w, h: m.h };
  }

  function drawSelection(ctx, item, scale = 1) {
    if (!item || !item.rect) return;
    const r = item.rect;
    const hs = Math.max(6, Math.round(9 * Math.max(scale, 0.7)));
    ctx.save();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = Math.max(1.5, 2.5 * scale);
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8);
    ctx.setLineDash([]);
    ctx.fillStyle = '#f59e0b';
    ctx.strokeStyle = '#1c1917';
    ctx.lineWidth = 2;
    ctx.fillRect(r.x + r.w + 4 - hs, r.y + r.h + 4 - hs, hs * 2, hs * 2);
    ctx.strokeRect(r.x + r.w + 4 - hs, r.y + r.h + 4 - hs, hs * 2, hs * 2);
    if (item.tip) {
      ctx.beginPath();
      ctx.arc(item.tip.x, item.tip.y, hs * 1.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function selectionHandles(item, scale = 1) {
    if (!item || !item.rect) return null;
    const r = item.rect;
    const hs = Math.max(6, Math.round(9 * Math.max(scale, 0.7)));
    return {
      resize: { x: r.x + r.w + 4, y: r.y + r.h + 4, r: hs * 1.8 },
      tail: item.tip ? { x: item.tip.x, y: item.tip.y, r: hs * 2 } : null,
    };
  }

  function mapBox(b, crop) {
    if (!Array.isArray(b) || !crop || !crop.iw || !crop.sw) return b;
    const x1 = (b[0] * crop.iw - crop.sx) / crop.sw, y1 = (b[1] * crop.ih - crop.sy) / crop.sh;
    const x2 = ((b[0] + b[2]) * crop.iw - crop.sx) / crop.sw, y2 = ((b[1] + b[3]) * crop.ih - crop.sy) / crop.sh;
    const cx1 = Math.max(0, x1), cy1 = Math.max(0, y1), cx2 = Math.min(1, x2), cy2 = Math.min(1, y2);
    if (cx2 - cx1 <= 0.005 || cy2 - cy1 <= 0.005) return null;
    return [cx1, cy1, cx2 - cx1, cy2 - cy1];
  }

  window.ComicLayout = {
    mapBox,
    LAYOUTS, ASPECTS, autoRects, layoutFor, panelBoxes, textBox, nearestAspect, aspectRatio,
    slotAspects, pickLayout, webtoonBoxes,
    wrapText, fitFontSize, coverRect, roundRect, overlap,
    placeBalloons, tailTip, measureBalloon, drawCaption, drawBalloon, drawSfx,
    measureFloat, drawFloat, drawSelection, selectionHandles,
    PAGE_STYLES, pageStyle, drawPageBackground, panelPath, drawPanelFrame, drawPageMarks,
  };
})();
