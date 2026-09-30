/**
 * theme.js: applies the colour theme before the first paint.
 *
 * Settings arrive over IPC only after the page has drawn, so a mirror in
 * localStorage is read synchronously here to stop every launch from flashing the
 * wrong palette. app.js re-applies the real setting once it loads.
 */
window.Theme = (function () {
  const KEY = 'ala.theme';
  const DEFAULT = 'verdant';

  const LIST = [
    {
      id: 'verdant',
      name: 'Verdant',
      blurb: 'Grey and green, matched to the app icon.',
      swatch: ['#0d1113', '#1a2124', '#35c94f', '#6ee88a', '#2dd4bf'],
    },
    {
      id: 'stone',
      name: 'Stone',
      blurb: 'The original warm stone and amber.',
      swatch: ['#0c0a09', '#1c1917', '#f59e0b', '#fbbf24', '#34d399'],
    },
    {
      id: 'midnight',
      name: 'Midnight',
      blurb: 'Deep navy with a periwinkle accent.',
      swatch: ['#0b0f19', '#161d33', '#7c9cff', '#a8bcff', '#34d399'],
    },
    {
      id: 'amethyst',
      name: 'Amethyst',
      blurb: 'Dark plum and soft violet.',
      swatch: ['#0f0b14', '#1d1627', '#a78bfa', '#c4b5fd', '#34d399'],
    },
    {
      id: 'ocean',
      name: 'Ocean',
      blurb: 'Deep teal water and bright cyan.',
      swatch: ['#071214', '#102226', '#22d3ee', '#67e8f9', '#4ade80'],
    },
    {
      id: 'ember',
      name: 'Ember',
      blurb: 'Charcoal and glowing orange.',
      swatch: ['#0f0c0a', '#1f1814', '#fb923c', '#fdba74', '#34d399'],
    },
    {
      id: 'rose',
      name: 'Rosé',
      blurb: 'Dusky mauve with a rose-pink accent.',
      swatch: ['#120c0f', '#22171c', '#f472b6', '#f9a8d4', '#34d399'],
    },
    {
      id: 'nord',
      name: 'Nord',
      blurb: 'Arctic slate and frost blue — the Nord palette.',
      swatch: ['#2e3440', '#3b4252', '#88c0d0', '#8fbcbb', '#a3be8c'],
    },
    {
      id: 'graphite',
      name: 'Graphite',
      blurb: 'Neutral greys, no colour cast — quiet and flat.',
      swatch: ['#0e0e0f', '#1b1b1d', '#e4e4e7', '#fafafa', '#34d399'],
    },
  ];

  const known = (id) => LIST.some((t) => t.id === id);

  function remembered() {
    try {
      const v = localStorage.getItem(KEY);
      return known(v) ? v : null;
    } catch {
      return null;
    }
  }

  function apply(id) {
    const t = known(id) ? id : DEFAULT;
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(KEY, t); } catch { }
    return t;
  }

  function current() {
    return document.documentElement.getAttribute('data-theme') || DEFAULT;
  }

  document.documentElement.setAttribute('data-theme', remembered() || DEFAULT);

  return { DEFAULT, LIST, apply, current, known };
})();
