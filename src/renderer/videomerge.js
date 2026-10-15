/**
 * videomerge.js: Video Merge, the pure part (no DOM, no network).
 *
 * A merge is two or more pictures on the timeline of ONE clip. Picture 1 opens the clip;
 * every later picture is reached at its own second, or, for the last one, on the very last
 * frame. This module checks a timeline, spaces pictures evenly when no time is given, and
 * describes it in words for the prompt writer and the history list.
 */
(function () {
  const MIN_PICTURES = 2;
  const MAX_PICTURES = 8;
  const MIN_SECONDS = 4;
  const MAX_SECONDS = 60;
  const STEP = 0.5;
  const HISTORY_MAX = 60;

  const round = (n) => Math.round(n / STEP) * STEP;
  const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

  function defaultTimes(n, seconds, landEnd) {
    n = Math.max(MIN_PICTURES, Math.floor(n));
    const T = Number(seconds) > 0 ? Number(seconds) : 10;
    const out = [0];
    const gaps = landEnd ? n - 1 : n;
    for (let k = 1; k < n; k++) {
      if (landEnd && k === n - 1) { out.push('end'); continue; }
      out.push(Math.min(round((T * k) / gaps), T - STEP));
    }
    return out;
  }

  function retime(frames, seconds, landEnd) {
    const n = frames.length;
    const even = defaultTimes(Math.max(n, MIN_PICTURES), seconds, landEnd);
    const T = Number(seconds) > 0 ? Number(seconds) : 10;
    return frames.map((f, i) => {
      const c = { ...f };
      if (i === 0) { c.at = 0; c.manual = false; return c; }
      if (landEnd && i === n - 1) { c.at = 'end'; c.manual = false; return c; }
      const keep = c.manual && typeof c.at === 'number' && c.at > 0 && c.at < T;
      if (!keep) { c.at = even[i]; c.manual = false; }
      return c;
    });
  }

  function check(frames, seconds, landEnd) {
    const T = Number(seconds);
    if (!Array.isArray(frames) || frames.length < MIN_PICTURES) return { ok: false, error: `add at least ${MIN_PICTURES} pictures` };
    if (frames.length > MAX_PICTURES) return { ok: false, error: `at most ${MAX_PICTURES} pictures` };
    if (!Number.isFinite(T) || T < MIN_SECONDS || T > MAX_SECONDS) return { ok: false, error: `length must be ${MIN_SECONDS}–${MAX_SECONDS} seconds` };
    const rest = [];
    let prev = 0;
    for (let i = 1; i < frames.length; i++) {
      const last = i === frames.length - 1;
      if (last && landEnd) { rest.push({ at: 'end' }); continue; }
      const at = Number(frames[i].at);
      if (!Number.isFinite(at) || at <= prev) return { ok: false, error: `picture ${i + 1} must come after ${fmt(prev)} s` };
      if (at >= T) return { ok: false, error: `picture ${i + 1} (${fmt(at)} s) does not fit in a ${fmt(T)} s clip` };
      rest.push({ at });
      prev = at;
    }
    return { ok: true, error: '', frames: rest };
  }

  function describe(frames, landEnd) {
    return frames.map((f, i) => {
      const L = String.fromCharCode(65 + i);
      const at = i === 0 ? 0 : (landEnd && i === frames.length - 1) ? 'end' : f.at;
      return `${L} ${at === 'end' ? 'end' : fmt(Number(at)) + ' s'}`;
    }).join(' → ');
  }

  function estimateSeconds(videoSeconds) {
    return Math.round(Math.max(1, Number(videoSeconds) || 10) * 10);
  }

  function pushHistory(list, entry) {
    const out = [entry, ...(list || []).filter((h) => h && h.fname !== entry.fname)];
    return out.slice(0, HISTORY_MAX);
  }

  window.VideoMerge = {
    MIN_PICTURES, MAX_PICTURES, MIN_SECONDS, MAX_SECONDS, STEP, HISTORY_MAX,
    defaultTimes, retime, check, describe, estimateSeconds, pushHistory, round,
  };
})();
