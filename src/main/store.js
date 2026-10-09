/**
 * store.js: JSON persistence for settings, the job queue, the image library and
 * everything the app learns.
 *
 * Files live in the OS profile folder (app.getPath('userData')), never in the
 * project folder. Three rules keep that data safe:
 *   - writes are debounced, then done atomically (write a sibling file, rename it
 *     over the original), so a crash mid-write cannot corrupt the library;
 *   - a file that fails to load is quarantined instead of being overwritten by
 *     defaults;
 *   - `migrate*` functions upgrade settings saved by older versions in place.
 * The DEFAULTS object at the top is also the reference for every setting.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  lmStudio: {
    baseUrl: 'http://localhost:1234/v1',
    apiKey: 'lm-studio',
    model: 'gemma-4-e4b-it', // the installer replaces this with the model it downloaded
    models: {
      ideation: '',
      vision: '',
      metadata: '',
      overseer: '',
    },
    temperature: 0.85,
    maxTokens: 2048,
    visionMaxTokens: 12000,
    requestTimeoutSec: 1800,
  },
  providers: [],
  routing: {
    vision: [],
    ideation: [],
    metadata: [],
    overseer: [],
    fallbackLocal: true,
    rerouteOnPolicyRefusal: true,
  },
  cloud: {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: '',
    models: { ideation: '', vision: '', metadata: '' },
    maxConcurrency: 4,
    timeoutSec: 60,
    migratedAt: null,
  },
  da: {
    uploadMethod: 'session',
    clientId: '',
    clientSecret: '',
    redirectUri: 'https://localhost:5556/auth/callback',
    accessToken: null,
    refreshToken: null,
    scope: '',
    username: '',
    loginUsername: '',
    loginPassword: '',
    galleryIds: [],
    allowComments: true,
    allowFreeDownload: true,
    autoPublish: true,
  },
  patreon: {
    link: '',
    cta: 'Support me on Patreon for full versions, exclusives, and more!',
    composerUrl: 'https://www.patreon.com/posts/new',
    teaser: {
      blur: 28,
      badge: '#Join Patreon',
      band: 'middle',
      showLink: true,
      darken: 0.25,
      format: 'jpeg',
    },
  },
  pixiv: {
    maxTitle: 32,
    maxTags: 10,
    extraTags: ['AIイラスト'],
    appendPatreon: true,
    captionSuffix: '',
    restrict: 'public',
    xRestrictMature: 'r18',
    xRestrictClean: 'general',
    
    aiType: 'aiGenerated',
    original: 'false',
    allowTagEdit: 'false',
    allowComment: 'true',
    extraFields: {},
  },
  publish: {
    destination: 'deviantart',
    destinations: ['deviantart'],
  },
  gen: {
    engine: 'perchance',
    batchSize: 4,
    maxRetries: 2,
    maxUploadRetries: 3,
    passThreshold: 7,
    qcVeto: true,
    qcConfirmVeto: true,
    qcGeneralPass: true,
    qcMetrics: true,
    qcDetailFloor: 0,
    skipQc: false,
    autoPick: false,
    /**
     * Auto-fix (imageedit.js): when a picture FAILS QC, queue a repair render of it — a
     * Qwen-Image edit of itself built from its own QC findings. Off by default: it is an
     * extra render + QC pass per failed picture. Never fixes a fix.
     */
    autoFix: false,
    /** Auto-fix attempts per failed picture (1–2). Each one repairs the ORIGINAL from its QC
     *  findings and is QC'd again; after the last failed try the picture stays discarded. */
    autoFixTries: 2,
    /** Repairs may be a fresh RE-RENDER (new seed, same character/outfit/scene, simple pose)
     *  when QC says the body itself is broken, and always for a second try. false = edits only. */
    fixRerender: true,
    /** Seeds per re-render repair (1–4); the repair counts as fixed when any one passes QC. */
    rerenderSeeds: 2,
    /**
     * Image Edit: ask "edit anyway?" when the picture's size differs from the workflow's
     * native size. The result keeps the picture's size either way; false skips only the popup.
     */
    editSizeWarning: true,
    skipMetadata: false,
    metadataOnlyInspected: false,
    qcMaxEdge: 1024,
    parallelQc: true,
    qcLaneDepth: 2,
    upscaleAuto: true,
    upscaleFactor: 4,
    delayBetweenGensSec: 8,
    autoUploadApproved: false,
    artStyle: '',
    artStylePin: false,
    shape: '',
    generator: 'classic',
    advAutoFilters: true,
    advMaxFilters: 12,
    advResetFilters: true,
    advGuidance: '',
    advMenuCap: 28,
  },
  comfy: {
    serverUrl: 'http://127.0.0.1:8188',
    workflowsDir: '',
    imageWorkflow: '',
    videoWorkflow: '',
    imagesPerPrompt: 6,
    maxReferences: 4,
    launchCommand: '',
    autoGif: false,
    selfCheck: true,
    selfCheckRerenders: 0,
  },
  metadata: {
    exampleStyle: '',
    defaultTags: ['aiart', 'digitalart', 'anime', 'animeart', 'aigenerated'],
    maxTags: 10,
    titles: {
      creativity: 1,
      devices: true,
      useDaHistory: true,
      avoidCount: 24,
      similarityLimit: 0.7,
      maxRepairs: 2,
      bannedWords: [],
      learnStyle: true,
      styleExamples: 8,
      deviceMode: 'auto',
    },
    descriptionStyle: 'story',
    expandedStorytelling: false,
    descriptionFooter: '',
    mature: false,
    matureLevel: 'strict',
    matureClassification: [],
    isAiGenerated: true,
    noai: false,
  },
  auto: {
    enabled: false,
    themes: [],
    promptsPerRound: 4,
    stopAfterHours: 8,
    maxReviewBacklog: 80,
    maxImagesPerHour: 0,
    useLearning: true,
    exploitRatio: 0.4,
    relearnEveryRounds: 4,
    startedAt: null,
    themeIndex: 0,
    roundsDone: 0,
  },
  overseer: {
    enabled: false,
    mode: 'helper',
    brief: '',
    imagesPerRun: 6,
    maxSteps: 20,
    // 'auto' offers native tool calling and falls back per engine to the JSON envelope;
    // 'native' never guesses; 'json' never sends tools (for servers that mangle them).
    toolProtocol: 'auto',
    // What one turn may spend, in provider-reported input tokens. 0 = no budget.
    turnBudget: { tokens: 300000 },
    memoryTurns: 20,
    approval: 'ask',
    autoSubmit: {
      minScore: 8,
      maxDefect: 'minor',
      requireMetadata: true,
      requireQcPass: true,
      maxPerRun: 3,
      maxPerDay: 6,
      sentToday: 0,
      dayKey: '',
    },
    schedule: {
      runsPerDay: 2,
      windowStart: 9,
      windowEnd: 23,
      jitter: true,
      nextAt: null,
      lastRunAt: null,
      runsToday: 0,
      dayKey: '',
    },
    autoSync: {
      enabled: true,
      everyMinutes: 60,
      withViews: true,
      lastAt: null,
    },
  },
  learn: {
    enabled: true,
    weights: { views: 0.2, favourites: 10, comments: 25, downloads: 4 },
    minSamples: 3,
    shrink: 6,
    maxLift: 4,
    minAgeDays: 3,
    peerWindow: 30,
    minExemplarAgeDays: 2,
    useLlmLessons: true,
    maxLessons: 8,
    autoSyncHours: 12,
    maxViewFetches: 400,
    syncLimit: 50,
    lastSyncAt: null,
  },
  variety: {
    enabled: true,
    exploreRatio: 0.35,
    wildRatio: 0.12,
    saturationCeiling: 0.45,
    recentWindow: 40,
    seedCooldown: 3,
    maxTraits: 5,
    axesPerRound: 3,
    noveltyBonus: 0.5,
  },
  promptLab: {
    defaultCount: 6,
    defaultMode: 'similar',
    useGuidance: true,
    bank: [],
    refMode: 'style',
    refCount: 4,
    activeProfile: 'deviantart',
    profiles: {},
  },
  paths: {
    libraryDir: '',
  },
  ui: {
    startHidden: false,
    windowBounds: null,
    reviewSort: 'score',
    reviewDir: 'desc',
    showPixiv: false,
    showPerchance: false,
    showDeviantArt: true,
    // The sidebar tab order the artist dragged into place (hold a tab 1 s, drag). null = the
    // shipped order. Tabs added by an update are slotted in after their shipped neighbour.
    tabOrder: null,
    theme: 'verdant',
    triage: { keepTo: 'review', meta: 'none', order: 'newest' },
  },
};

class JsonFile {
  constructor(file, defaults) {
    this.file = file;
    this.data = structuredClone(defaults);
    this._timer = null;
    this.load();
  }
  /**
   * A failed load used to be a one-line console message nobody would ever see, and the very next
   * `save()` then wrote the untouched defaults straight over the file — turning a recoverable read
   * error into permanent data loss.
   */
  load() {
    this.loadError = null;
    if (!fs.existsSync(this.file)) return;
    const defaults = structuredClone(this.data);
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = deepMerge(defaults, raw);
    } catch (e) {
      this.loadError = e.message;
      console.error(`[store] failed to load ${this.file}: ${e.message}`);
      this._quarantine();
      for (const alt of [`${this.file}.tmp`, `${this.file}.bak`]) {
        try {
          const raw = JSON.parse(fs.readFileSync(alt, 'utf8'));
          this.data = deepMerge(structuredClone(defaults), raw);
          this.recoveredFrom = alt;
          console.error(`[store] recovered ${path.basename(this.file)} from ${path.basename(alt)}`);
          return;
        } catch { }
      }
      console.error('[store] no readable copy left — running on defaults');
    }
  }
  /** Park an unreadable file next to itself so the defaults about to be saved cannot erase it. */
  _quarantine() {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const kept = `${this.file}.unreadable-${stamp}`;
      fs.copyFileSync(this.file, kept);
      console.error(`[store] kept a copy of it at ${kept}`);
    } catch (e) {
      console.error(`[store] could not preserve ${this.file}:`, e.message);
    }
  }
  save(immediate = false) {
    clearTimeout(this._timer);
    this._timer = null;
    if (immediate || JsonFile.quitting) return this._write();
    this._timer = setTimeout(() => { this._timer = null; this._write(); }, 400);
  }
  /** Write now if a save is still waiting on its debounce. */
  flush() {
    if (!this._timer) return;
    clearTimeout(this._timer);
    this._timer = null;
    this._write();
  }
  /**
   * Replace the file atomically: write a sibling, then rename it over the original. library.json is
   * ~30 MB and is rewritten several times a minute while the worker runs.
   */
  _write() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const json = JSON.stringify(this.data, null, 2);
      if (!this._sessionBackup) {
        this._sessionBackup = true;
        if (!this.loadError && fs.existsSync(this.file)) {
          try { fs.copyFileSync(this.file, `${this.file}.bak`); } catch { }
        }
      }
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, json);
      try {
        fs.renameSync(tmp, this.file);
      } catch (e) {
        fs.writeFileSync(this.file, json);
        try { fs.unlinkSync(tmp); } catch { }
      }
    } catch (e) {
      console.error(`[store] failed to write ${this.file}:`, e.message);
    }
  }
}
JsonFile.quitting = false;

/** Merge a saved file over the defaults. */
function deepMerge(base, over) {
  if (Array.isArray(over)) return over;
  if (over && typeof over === 'object') {
    const isObj = base && typeof base === 'object' && !Array.isArray(base);
    const src = isObj ? base : {};
    const out = { ...src };
    for (const k of Object.keys(over)) {
      out[k] = (k in src) ? deepMerge(src[k], over[k]) : over[k];
    }
    return out;
  }
  return over === undefined ? base : over;
}

/**
 * Nudge settings saved by an older build. deepMerge only fills in *missing* keys, so a value that
 * was the old default sticks around forever — and the old 120s timeout silently kills any vision
 * model slower than two…
 */
function migrate(s) {
  if (!s || !s.lmStudio) return;
  if ((s.lmStudio.requestTimeoutSec || 0) < 1800) s.lmStudio.requestTimeoutSec = 1800;
  if ((s.lmStudio.visionMaxTokens || 0) < 12000) s.lmStudio.visionMaxTokens = 12000;
  if (s.gen) delete s.gen.qcMode;
  if (s.gen) delete s.gen.negativePrompt;
  if (s.learn) delete s.learn.freshDays;
  if (s.comfy) delete s.comfy.selfCheckRetries;
  migrateCloudToProviders(s);
  migrateDestinationToList(s);
  migratePixivEnums(s);
  migrateLabProfiles(s);
  migrateTitleSimilarity(s);
  migrateOverseerRole(s);
  migrateOverseerSteps(s);
}

/** Lift the Overseer's step ceiling off the old default of 6, once; a chosen value stays. */
function migrateOverseerSteps(s) {
  const o = s && s.overseer;
  if (!o || o.stepsMigratedAt) return;
  if (o.maxSteps === 6 || o.maxSteps === undefined) o.maxSteps = 20;
  if (o.toolProtocol === undefined) o.toolProtocol = 'auto';
  if (!o.turnBudget || typeof o.turnBudget !== 'object') o.turnBudget = { tokens: 300000 };
  o.stepsMigratedAt = Date.now();
}

/** Give the new 'overseer' role something to run on. */
function migrateOverseerRole(s) {
  if (!s) return;
  if (s.lmStudio && s.lmStudio.models && s.lmStudio.models.overseer === undefined) {
    s.lmStudio.models.overseer = '';
  }
  for (const p of Array.isArray(s.providers) ? s.providers : []) {
    if (!p || typeof p !== 'object') continue;
    if (p.kind === 'cli') {
      if (p.roles && p.roles.overseer === undefined) p.roles.overseer = !!p.roles.metadata;
      continue;
    }
    if (p.models && p.models.overseer === undefined) {
      p.models.overseer = p.models.metadata || p.models.ideation || '';
    }
  }
}

/** Lift the repeat threshold off the old default, once. */
function migrateTitleSimilarity(s) {
  const t = s && s.metadata && s.metadata.titles;
  if (!t) return;
  if (t.similarityLimit === 0.5) t.similarityLimit = 0.7;
}

/**
 * The Prompt Lab bank predates job profiles, and everything saved into it was saved while the lab's
 * only audience was the DeviantArt gallery — so that is the profile that inherits it.
 */
function migrateLabProfiles(s) {
  const pl = s && s.promptLab;
  if (!pl || typeof pl !== 'object') return;
  if (!Array.isArray(pl.bank) || !pl.bank.length) return;
  pl.profiles = pl.profiles && typeof pl.profiles === 'object' ? pl.profiles : {};
  const da = pl.profiles.deviantart = pl.profiles.deviantart && typeof pl.profiles.deviantart === 'object'
    ? pl.profiles.deviantart : {};
  if (!Array.isArray(da.bank) || !da.bank.length) da.bank = pl.bank;
  pl.bank = [];
}

/** Repair pixiv form values that were saved as numeric codes. */
function migratePixivEnums(s) {
  const px = s && s.pixiv;
  if (!px || typeof px !== 'object') return;
  const swap = (key, table) => {
    const v = px[key];
    if (typeof v === 'string' && Object.prototype.hasOwnProperty.call(table, v)) px[key] = table[v];
  };
  swap('restrict', { 0: 'public', 1: 'mypixiv', 2: 'private' });
  swap('xRestrictClean', { 0: 'general', 1: 'r18', 2: 'r18g' });
  swap('xRestrictMature', { 0: 'general', 1: 'r18', 2: 'r18g' });
  swap('aiType', { 1: 'notAiGenerated', 2: 'aiGenerated' });
  swap('original', { 0: 'false', 1: 'true' });
  swap('allowTagEdit', { 0: 'false', 1: 'true' });
  
  delete px.aiTypeHuman;
  delete px.allowCitationWork;
  delete px.autoPost;
}

const DESTINATION_ORDER = ['deviantart', 'pixiv', 'patreon'];

/**
 * The default destination became a *list* when pixiv arrived — "both at once" is the point of
 * having two public sites, so a single value could not express it.
 */
function migrateDestinationToList(s, { prefer = 'single' } = {}) {
  if (!s || typeof s !== 'object') return;
  s.publish = s.publish && typeof s.publish === 'object' ? s.publish : {};
  const p = s.publish;
  const valid = (d) => DESTINATION_ORDER.includes(d);
  const clean = (list) => {
    const seen = (list || []).filter(valid);
    if (seen.includes('patreon')) return ['patreon'];
    return DESTINATION_ORDER.filter((d) => seen.includes(d));
  };
  const primaryOf = (list) => (list.includes('patreon') ? 'patreon'
    : list.includes('deviantart') ? 'deviantart' : list[0]);

  let list = clean(Array.isArray(p.destinations) ? p.destinations : []);
  const single = valid(p.destination) ? p.destination : null;
  if (prefer === 'single' && single && (!list.length || primaryOf(list) !== single)) {
    list = clean([single]);
  }
  if (!list.length) list = single ? clean([single]) : ['deviantart'];

  p.destinations = list;
  p.destination = primaryOf(list);
}

/** The old build had exactly one hosted endpoint, in `settings.cloud`. */
function migrateCloudToProviders(s) {
  s.providers = Array.isArray(s.providers) ? s.providers : [];
  s.routing = s.routing && typeof s.routing === 'object' ? s.routing : {};
  for (const role of ['vision', 'ideation', 'metadata']) {
    if (!Array.isArray(s.routing[role])) s.routing[role] = [];
  }
  if (s.routing.fallbackLocal === undefined) s.routing.fallbackLocal = true;

  const c = s.cloud;
  if (!c || c.migratedAt || !String(c.baseUrl || '').trim()) return;

  const models = c.models || {};
  const id = 'cloud-legacy';
  if (!s.providers.some((p) => p && p.id === id)) {
    s.providers.push({
      id,
      name: guessProviderName(c.baseUrl),
      enabled: c.enabled !== false,
      baseUrl: c.baseUrl,
      apiKey: c.apiKey || '',
      apiKeyEnv: '',
      vision: !!(models.vision || c.model),
      legacy: true,
      model: c.model || '',
      models: { vision: models.vision || '', ideation: models.ideation || '', metadata: models.metadata || '' },
      timeoutSec: c.timeoutSec || 60,
      maxConcurrency: c.maxConcurrency || 4,
      maxOutputTokens: 8192,
    });
    for (const role of ['vision', 'ideation', 'metadata']) {
      if ((models[role] || c.model) && !s.routing[role].includes(id)) s.routing[role].unshift(id);
    }
  }
  c.migratedAt = Date.now();
}

function guessProviderName(baseUrl) {
  const u = String(baseUrl || '').toLowerCase();
  if (u.includes('groq')) return 'Groq';
  if (u.includes('openrouter')) return 'OpenRouter';
  if (u.includes('together')) return 'Together';
  if (u.includes('deepinfra')) return 'DeepInfra';
  if (u.includes('mistral')) return 'Mistral';
  if (u.includes('openai')) return 'OpenAI';
  try { return new URL(baseUrl).hostname.replace(/^api\./, ''); } catch { return 'Cloud'; }
}

class Store {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.settings = new JsonFile(path.join(userDataDir, 'settings.json'), DEFAULT_SETTINGS);
    migrate(this.settings.data);
    this.settings.save();
    this.queue = new JsonFile(path.join(userDataDir, 'queue.json'), { items: [] });
    this.library = new JsonFile(path.join(userDataDir, 'library.json'), { items: [] });
    this.stats = new JsonFile(path.join(userDataDir, 'stats.json'), {
      promptsGenerated: 0, imagesGenerated: 0, imagesPassed: 0,
      imagesFailed: 0, draftsUploaded: 0, pixivPosted: 0, sessions: 0,
    });
    this.perf = new JsonFile(path.join(userDataDir, 'perf.json'), {
      deviations: [], lastSyncAt: null, username: '',
    });
    this.playbook = new JsonFile(path.join(userDataDir, 'playbook.json'), {
      updatedAt: null, source: 'none', sampleSize: 0,
      themes: [], tags: [], promptTraits: [], titleTraits: [], timing: [],
      lessons: [], exemplars: [], recipes: [], summary: '',
      manual: {
        lessons: [], rules: { always: [], never: [] }, banned: [],
        boost: { themes: {}, tags: {} }, pinned: [], muted: [], notes: '', updatedAt: null,
      },
      rotation: { round: 0, seeds: {}, modes: [] },
    });
    this.titles = new JsonFile(path.join(userDataDir, 'titles.json'), {
      used: [],
      cursor: 0,
      renames: [],
      forgotten: [],
      style: null,
    });
    this.origins = new JsonFile(path.join(userDataDir, 'origins.json'), {
      entries: [],
      version: 1,
    });
    this.comics = new JsonFile(path.join(userDataDir, 'comics.json'), {
      projects: [],
      version: 1,
    });
    this.requests = new JsonFile(path.join(userDataDir, 'requests.json'), {
      items: [],
      version: 1,
    });
    this.pchCatalog = new JsonFile(path.join(userDataDir, 'pchcatalog.json'), {
      generators: {},
      version: 1,
    });
    this.overseer = new JsonFile(path.join(userDataDir, 'overseer.json'), {
      messages: [],
      runs: [],
      research: [],
      version: 2,
    });
  }
  get defaultLibraryDir() { return path.join(this.dir, 'library'); }
  get libraryDir() { return this.settings.data.paths.libraryDir || this.defaultLibraryDir; }

  /** Quit-time: write every file still waiting on its debounce, and make every later save immediate. */
  flushAll() {
    JsonFile.quitting = true;
    for (const v of Object.values(this)) {
      if (v instanceof JsonFile) v.flush();
    }
  }
}

module.exports = { Store, JsonFile, DEFAULT_SETTINGS, migrate, migrateDestinationToList, deepMerge };
