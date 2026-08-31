// Config loading and validation. Kept free of any electron import so it can be
// exercised by plain node, which is what test/config.test.js does.

const fs = require('fs');

// onWarn is injected the way src/counters.js and src/control-server.js take their
// logger, so this file still imports nothing and stays testable on plain node.
function loadConfig(file, { onWarn } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read config at ${file}\n${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Config at ${file} is not valid JSON\n${e.message}`);
  }
  const problems = validateConfig(parsed);
  if (problems.length) {
    throw new Error(`Config at ${file} is invalid:\n- ${problems.join('\n- ')}`);
  }
  // After validation, so a config that is going to fail says why it failed rather
  // than also complaining about spelling.
  if (onWarn) {
    for (const key of unknownKeys(parsed)) {
      onWarn(
        `config: unknown key "${key}" is ignored (typo, or a setting that no longer exists)`
      );
    }
  }
  return withDefaults(parsed);
}

// Durations and counts that share one rule: a finite number, zero or more, where
// zero disables. Kept as a table so adding a knob cannot mean forgetting to
// validate it, which is how memoryCheckMs ended up unchecked while every setting
// around it was covered.
const NON_NEGATIVE = {
  maxDeferMs: 'how long upkeep may be deferred before it proceeds anyway; 0 = forever',
  memoryHardLimitMb: 'the point past which the whole wall is swept; 0 = no hard limit',
  memoryForceAfterMs:
    'how long memory pressure must persist before overriding in-use; 0 = never override',
  memoryHardForChecks: 'consecutive checks over the hard limit before sweeping',
  minRecycleIntervalMs: 'the cooldown between rebuilds of one panel',
  memoryReduceMinMb: 'what counts as a recycle having reclaimed something',
  memoryGiveUpAfter: 'recycles without reclaiming before giving up; 0 = never give up',
  minUptimeMs: 'no relaunch before this, so a bad limit cannot become a restart loop',
  maxRelaunches: 'how many times the ladder may restart the app',
  presenceGraceMs: 'recent pointer motion blocks a relaunch for this long',
  // These two predate the table and were the last unchecked durations. Both reach
  // Electron or a comparison as raw numbers: a NaN transitionMs silently disables
  // the promote animation, and a NaN escDoubleMs makes double-Esc never fire,
  // quietly undoing the Esc policy decided on 2026-08-21.
  transitionMs: 'how long the promote/dock animation takes; 0 = snap, no animation',
  escDoubleMs: 'how quickly two Esc presses must land to count as a double',
};

// Flags where anything other than a real boolean is a mistake worth naming. The
// defaults coerce with `!!` or `??`, so without this a quoted "false" reads as
// true - which for idleResetUrls means turning on a scheduled logout of every
// dashboard, the one behaviour the conventions warn hardest about.
const BOOLEANS = {
  showHotspotHint: 'whether grid mode hints that a panel can be promoted',
  hideInactiveWhenActive: 'whether the other panels are hidden while one is promoted',
  idleResetUrls: 'whether idling puts every panel back to its configured URL',
  memoryRelaunch: 'whether the memory ladder may restart the app as a last resort',
  // The login item, not a crash supervisor. src/autostart.js says why those are
  // different problems and why only one of them can live in this process.
  autoStart: 'whether the app registers itself to start when the operator logs in',
};

const WATCHDOG_NON_NEGATIVE = {
  baseDelayMs: 'first retry delay, doubling from there',
  maxDelayMs: 'the cap on that backoff',
  maxAttempts: 'reloads before escalating to a rebuild; 0 = unlimited',
  retryMs: 'how long an unrecoverable panel waits before trying again; 0 = never',
};

// Every key the app actually reads, per level. Kept beside the validation tables
// because unknownKeys() below is only useful if this stays complete.
const KNOWN_TOP = new Set([
  'wall',
  'views',
  'presets',
  'backButton',
  'watchdog',
  'control',
  'idleReturnMs',
  'escToGrid',
  'recentUseMs',
  'memoryCheckMs',
  'memoryLimitMb',
  ...Object.keys(NON_NEGATIVE),
  ...Object.keys(BOOLEANS),
]);

const KNOWN_WALL = new Set([
  'width',
  'height',
  'backgroundColor',
  'displayLabel',
  'displayId',
  'kiosk',
  'fullscreen',
  'fitToDisplay',
  'safeAreaTop',
]);

const KNOWN_VIEW = new Set([
  'id',
  'label',
  'url',
  'grid',
  'zoom',
  'partition',
  'refreshMs',
  'recycleMs',
  'neverRecycle',
  'allowedOrigins',
  'allowedPermissions',
]);

// Unrecognised keys, as warnings rather than problems.
//
// The validator is an allow-check and withDefaults spreads the raw object first,
// so a typo has always been accepted in silence: `memoryLimitMB` or `escToGird`
// parse, validate, and do nothing at all. That is the same class of hole the
// NON_NEGATIVE table exists to close, one level up.
//
// Deliberately NOT fatal. These configs are hand-edited on a show floor, and
// refusing to boot over a stray key would be a worse failure than ignoring one.
// A leading underscore means documentation: `_comment`, `_memoryBaseline` and
// `_soak` are already used that way, and saveViews preserves them.
function unknownKeys(c) {
  if (!c || typeof c !== 'object') return [];
  const out = [];
  const walk = (obj, known, where) => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      if (key.startsWith('_')) continue;
      if (!known.has(key)) out.push(`${where}${key}`);
    }
  };
  walk(c, KNOWN_TOP, '');
  walk(c.wall, KNOWN_WALL, 'wall.');
  if (Array.isArray(c.views)) {
    c.views.forEach((v, i) => walk(v, KNOWN_VIEW, `views[${i}].`));
  }
  if (Array.isArray(c.presets)) {
    c.presets.forEach((preset, i) => {
      walk(preset, new Set(['id', 'name', 'views']), `presets[${i}].`);
      if (preset && Array.isArray(preset.views)) {
        preset.views.forEach((v, j) => walk(v, KNOWN_VIEW, `presets[${i}].views[${j}].`));
      }
    });
  }
  return out;
}

// Returns a list of human-readable problems. A bad config must fail here with a
// readable message rather than throwing a stack trace on a show floor.
function validateConfig(c) {
  const p = [];
  if (!c || typeof c !== 'object') return ['config is not an object'];

  const w = c.wall;
  if (!w || typeof w !== 'object') {
    p.push('missing "wall" object');
  } else {
    if (!isPositiveInt(w.width)) p.push('wall.width must be a positive integer');
    if (!isPositiveInt(w.height)) p.push('wall.height must be a positive integer');
  }

  // May be empty: a montage can be built from an empty wall.
  if (!Array.isArray(c.views)) {
    p.push('"views" must be an array');
    return p;
  }

  const ids = new Set();
  const partitions = new Set(); // collected for reference; sharing is legal
  c.views.forEach((v, i) => {
    const at = `views[${i}]`;
    if (!v || typeof v !== 'object') {
      p.push(`${at} is not an object`);
      return;
    }
    if (!v.id) p.push(`${at}.id is required`);
    else if (ids.has(v.id)) p.push(`${at}.id "${v.id}" is duplicated`);
    else ids.add(v.id);

    // An empty url means "not set yet", which is a normal state for a panel
    // that was just created in the editor.
    if (typeof v.url !== 'string') p.push(`${at}.url must be a string`);

    // Sharing a partition is allowed and sometimes required: several panels
    // showing the same SSO-protected app should share one login rather than
    // making an operator sign in once per panel.
    partitions.add(v.partition || `persist:wall-${i + 1}`);

    const g = v.grid;
    if (!g || typeof g !== 'object') {
      p.push(`${at}.grid is required`);
    } else if (
      !Number.isFinite(g.x) ||
      !Number.isFinite(g.y) ||
      !isPositiveInt(g.width) ||
      !isPositiveInt(g.height)
    ) {
      p.push(`${at}.grid needs numeric x,y and positive width,height`);
    } else if (w && isPositiveInt(w.width) && isPositiveInt(w.height)) {
      if (g.x < 0 || g.y < 0 || g.x + g.width > w.width || g.y + g.height > w.height) {
        p.push(
          `${at}.grid (${g.x},${g.y} ${g.width}x${g.height}) falls outside the ` +
            `${w.width}x${w.height} wall`
        );
      }
    }

    if (v.zoom !== undefined && !(Number.isFinite(v.zoom) && v.zoom > 0)) {
      p.push(`${at}.zoom must be a positive number`);
    }
    if (v.refreshMs !== undefined && !(Number.isFinite(v.refreshMs) && v.refreshMs >= 0)) {
      p.push(`${at}.refreshMs must be a number >= 0 (0 = never)`);
    }
    if (v.recycleMs !== undefined && !(Number.isFinite(v.recycleMs) && v.recycleMs >= 0)) {
      p.push(`${at}.recycleMs must be a number >= 0 (0 = never)`);
    }
    if (v.allowedOrigins !== undefined && !Array.isArray(v.allowedOrigins)) {
      p.push(`${at}.allowedOrigins must be an array of origins`);
    }
    // Permissions this panel may be granted. Absent or empty means none, which is
    // the opposite polarity to allowedOrigins above and is deliberate: measured,
    // a session with no handler grants microphone, camera and notifications
    // silently (npm run probe:perm, docs/validation.md). The strings are
    // Chromium's own, so they are not validated against a fixed list here.
    if (v.allowedPermissions !== undefined) {
      if (!Array.isArray(v.allowedPermissions)) {
        p.push(`${at}.allowedPermissions must be an array of permission names`);
      } else if (v.allowedPermissions.some((x) => typeof x !== 'string')) {
        p.push(`${at}.allowedPermissions must contain only strings`);
      }
    }
    // Exempts a panel from every automatic rebuild. For a dashboard that keeps
    // its token in sessionStorage, where a recycle is a logout, that is a
    // decision to make here rather than discover on the wall at 3am.
    if (v.neverRecycle !== undefined && typeof v.neverRecycle !== 'boolean') {
      p.push(`${at}.neverRecycle must be true or false`);
    }
  });

  if (
    c.idleReturnMs !== undefined &&
    !(Number.isFinite(c.idleReturnMs) && c.idleReturnMs >= 0)
  ) {
    p.push('idleReturnMs must be a number >= 0 (0 disables auto-return)');
  }
  if (c.escToGrid !== undefined && !['single', 'double', 'off'].includes(c.escToGrid)) {
    p.push('escToGrid must be "single", "double" or "off"');
  }
  if (c.recentUseMs !== undefined && !(Number.isFinite(c.recentUseMs) && c.recentUseMs >= 0)) {
    p.push('recentUseMs must be a number >= 0');
  }
  if (
    c.memoryLimitMb !== undefined &&
    !(Number.isFinite(c.memoryLimitMb) && c.memoryLimitMb >= 0)
  ) {
    p.push('memoryLimitMb must be a number >= 0 (0 = no limit)');
  }
  // This one was missing while every setting around it was checked, and it is the
  // worst one to leave open: withDefaults uses `?? 60000`, so a quoted "60000"
  // passes straight through and silently works, and "abc" becomes NaN, which
  // setInterval treats as 1. That is a memory check every millisecond, for the
  // length of a soak, each one writing a line to the log file.
  if (
    c.memoryCheckMs !== undefined &&
    !(Number.isFinite(c.memoryCheckMs) && c.memoryCheckMs >= 0)
  ) {
    p.push('memoryCheckMs must be a number >= 0 (0 disables the check)');
  }
  // A hard limit at or below the soft limit inverts the ladder: every check that
  // is over the limit at all is also over the hard limit, so rung 3 sweeps the
  // whole wall where rung 1 would have rebuilt one idle panel. Cross-field, so
  // neither NON_NEGATIVE entry can catch it on its own.
  if (
    Number.isFinite(c.memoryHardLimitMb) &&
    c.memoryHardLimitMb > 0 &&
    Number.isFinite(c.memoryLimitMb) &&
    c.memoryLimitMb > 0 &&
    c.memoryHardLimitMb <= c.memoryLimitMb
  ) {
    p.push(
      `memoryHardLimitMb (${c.memoryHardLimitMb}) must be above memoryLimitMb ` +
        `(${c.memoryLimitMb}), or 0 for no hard limit: below it, every check over ` +
        'the limit sweeps the whole wall instead of recycling one panel'
    );
  }
  // The upkeep and memory-ladder settings. A table rather than a dozen
  // near-identical blocks: every one of them is a duration or a count, and the
  // check is the same. 0 means "off" for all of them, which is why the shipped
  // config can leave them out entirely.
  for (const [key, note] of Object.entries(NON_NEGATIVE)) {
    if (c[key] !== undefined && !(Number.isFinite(c[key]) && c[key] >= 0)) {
      p.push(`${key} must be a number >= 0 (${note})`);
    }
  }
  for (const [key, note] of Object.entries(BOOLEANS)) {
    if (c[key] !== undefined && typeof c[key] !== 'boolean') {
      p.push(`${key} must be true or false (${note})`);
    }
  }
  // Checked because it is load-bearing and was not. main.js hands it to
  // scaleRect() and then to setBounds(), so a malformed value becomes NaN bounds
  // on the one control that leaves active mode besides Esc: get both wrong and an
  // administrator is stuck on a fullscreen panel with no way back.
  if (c.backButton !== undefined) {
    const b = c.backButton;
    if (typeof b !== 'object' || b === null || Array.isArray(b)) {
      p.push('backButton must be an object with x, y, width and height in wall units');
    } else {
      for (const key of ['x', 'y']) {
        if (b[key] !== undefined && !(Number.isFinite(b[key]) && b[key] >= 0)) {
          p.push(`backButton.${key} must be a number >= 0`);
        }
      }
      for (const key of ['width', 'height']) {
        if (b[key] !== undefined && !(Number.isFinite(b[key]) && b[key] > 0)) {
          p.push(`backButton.${key} must be a number > 0`);
        }
      }
    }
  }
  if (c.watchdog !== undefined) {
    if (typeof c.watchdog !== 'object' || c.watchdog === null) {
      p.push('watchdog must be an object');
    } else {
      for (const [key, note] of Object.entries(WATCHDOG_NON_NEGATIVE)) {
        const v = c.watchdog[key];
        if (v !== undefined && !(Number.isFinite(v) && v >= 0)) {
          p.push(`watchdog.${key} must be a number >= 0 (${note})`);
        }
      }
      if (
        c.watchdog.escalateToRecycle !== undefined &&
        typeof c.watchdog.escalateToRecycle !== 'boolean'
      ) {
        p.push('watchdog.escalateToRecycle must be true or false');
      }
    }
  }
  if (c.control !== undefined) {
    if (typeof c.control !== 'object' || c.control === null) {
      p.push('control must be an object');
    } else {
      const port = c.control.port;
      if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535)) {
        p.push('control.port must be an integer 0-65535 (0 = disabled)');
      }
      if (c.control.host !== undefined && typeof c.control.host !== 'string') {
        p.push('control.host must be a string');
      }
    }
  }

  // Presets are named snapshots of a montage. Each holds the same shape as the
  // live views, so it is checked with the same rules rather than a second set
  // that could drift.
  if (c.presets !== undefined) {
    if (!Array.isArray(c.presets)) {
      p.push('"presets" must be an array');
    } else {
      const presetIds = new Set();
      c.presets.forEach((preset, i) => {
        const at = `presets[${i}]`;
        if (!preset || typeof preset !== 'object') return p.push(`${at} is not an object`);
        if (!preset.id) p.push(`${at}.id is required`);
        else if (presetIds.has(preset.id)) p.push(`${at}.id "${preset.id}" is duplicated`);
        else presetIds.add(preset.id);
        if (!Array.isArray(preset.views)) {
          p.push(`${at}.views must be an array`);
          return;
        }
        validateConfig({ wall: c.wall, views: preset.views }).forEach((problem) =>
          p.push(`${at}: ${problem}`)
        );
      });
    }
  }
  const sat = c.wall && c.wall.safeAreaTop;
  if (
    sat !== undefined &&
    sat !== null &&
    sat !== 'auto' &&
    !(Number.isFinite(sat) && sat >= 0)
  ) {
    p.push('wall.safeAreaTop must be "auto", a number >= 0, or absent');
  }
  return p;
}

function isPositiveInt(n) {
  return Number.isInteger(n) && n > 0;
}

function withDefaults(c) {
  return {
    ...c,
    wall: {
      backgroundColor: '#000000',
      displayLabel: null,
      displayId: null,
      kiosk: true,
      fullscreen: true,
      // Scale and centre the authored layout to whatever window we actually
      // get. Scale is 1 when the display matches the config.
      fitToDisplay: true,
      ...c.wall,
    },
    idleReturnMs: c.idleReturnMs ?? 240000,
    showHotspotHint: !!c.showHotspotHint,
    hideInactiveWhenActive: !!c.hideInactiveWhenActive,
    transitionMs: c.transitionMs ?? 0,
    // Esc is ambiguous: the wall wants it for "back to grid", but real
    // dashboards also use it to close modals, and one key cannot do both.
    // Jeff chose "single" (press Esc, return to grid) on 2026-08-21. If a real
    // dashboard turns out to need Esc for its own modals, "double" lets the
    // first press reach the page and docks on a quick second one. "off" leaves
    // only the Back button and the idle timeout. See docs/validation.md.
    escToGrid: c.escToGrid || 'single',
    escDoubleMs: c.escDoubleMs ?? 600,
    // On idle, put the panels back to their configured URLs.
    //
    // Off by default, and that default matters. Only administrators have
    // keyboard and mouse access, so nobody touches the wall for most of its
    // life: idle is the exhibit's normal state, not an exceptional one. Turning
    // this on would reload every panel a few minutes after the operator stops
    // typing and log them out of dashboards meant to sit there all day.
    //
    // Turn it on only where the pages are public and unauthenticated, and
    // wandering away from the configured URL is the bigger risk.
    idleResetUrls: c.idleResetUrls ?? false,
    // How long after someone touches a panel it still counts as in use, and so
    // must not be reloaded under them by the watchdog.
    recentUseMs: c.recentUseMs ?? 60000,
    // How often to log process memory, and the point past which a panel is
    // considered to have ballooned. 0 disables the check entirely.
    memoryCheckMs: c.memoryCheckMs ?? 60000,
    memoryLimitMb: c.memoryLimitMb ?? 0,
    // Upkeep may be put off while a panel is in use, but not indefinitely: with
    // no ceiling, "never touch a panel someone is using" can become "never touch
    // this panel", and under memory pressure the wall has no way back.
    maxDeferMs: c.maxDeferMs ?? 900000,
    // The rest of the ladder. All inert until memoryLimitMb is set, which waits
    // on a measured baseline: see docs/validation.md and memoryLimitFromBaseline
    // in src/upkeep.js. A limit inside the normal operating band is worse than
    // none, because it rebuilds a panel on every check.
    memoryHardLimitMb: c.memoryHardLimitMb ?? 0,
    // 0 here means the in-use rule is never overridden, matching every other 0 in
    // this file. It does not mean "force immediately".
    memoryForceAfterMs: c.memoryForceAfterMs ?? 300000,
    memoryHardForChecks: c.memoryHardForChecks ?? 2,
    minRecycleIntervalMs: c.minRecycleIntervalMs ?? 60000,
    memoryReduceMinMb: c.memoryReduceMinMb ?? 50,
    memoryGiveUpAfter: c.memoryGiveUpAfter ?? 3,
    // Off. Reachable only after a full sweep has proved the growth is not in the
    // renderers, and even then a wall that vanishes mid-demo is a worse failure
    // than a wall using a lot of RAM. There is no supervisor to bring it back.
    memoryRelaunch: c.memoryRelaunch ?? false,
    // Off, so installing the app never quietly adds itself to somebody's login
    // items. An exhibit wants it on, and the settings panel is where it goes on,
    // at the machine it is going to run on.
    autoStart: c.autoStart ?? false,
    minUptimeMs: c.minUptimeMs ?? 600000,
    maxRelaunches: c.maxRelaunches ?? 3,
    presenceGraceMs: c.presenceGraceMs ?? 60000,
    watchdog: {
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      // Past this the ladder escalates to a rebuild, then to a slow retry. It
      // used to be unbounded, so a permanently broken URL reloaded every 30
      // seconds for as long as the exhibit ran.
      maxAttempts: 5,
      retryMs: 600000,
      escalateToRecycle: true,
      ...(c.watchdog || {}),
    },
    // A small HTTP surface for administrators: status, and the same actions the
    // wall keyboard can take. Off unless a port is set, and bound to loopback
    // unless told otherwise, because it is unauthenticated.
    control: {
      port: 0,
      host: '127.0.0.1',
      ...(c.control || {}),
    },
    presets: Array.isArray(c.presets)
      ? c.presets.map((preset) => ({
          ...preset,
          views: preset.views.map((v, i) => ({
            zoom: 1,
            partition: `persist:wall-${i + 1}`,
            ...v,
          })),
        }))
      : [],
    backButton: c.backButton || { x: 24, y: 24, width: 176, height: 56 },
    views: c.views.map((v, i) => ({
      zoom: 1,
      partition: `persist:wall-${i + 1}`,
      neverRecycle: false,
      ...v,
    })),
  };
}

// The settings the control surface may change, and nothing else.
//
// An allow-list rather than "any top-level key". This arrives over an
// unauthenticated HTTP surface, and most of the config is not a setting: views,
// presets and wall each have their own path that does considerably more than
// write a number, and none of them should be reachable by patching a scalar.
const EDITABLE_SETTINGS = new Set(['memoryLimitMb', 'memoryHardLimitMb', 'autoStart']);

// Validates the WHOLE patch before any of it is applied, and answers { ok, reason }
// rather than a boolean, the same contract panel patches follow. A half-applied
// settings patch would leave a hard limit below a soft one, which is exactly the
// state the rule above exists to refuse.
//
// The rules are validateConfig's, applied to a merged candidate, rather than a
// second copy that can drift from it.
function settingsVerdict(config, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, reason: 'patch must be an object' };
  }
  const keys = Object.keys(patch);
  if (!keys.length) return { ok: false, reason: 'patch is empty' };

  const unknown = keys.filter((k) => !EDITABLE_SETTINGS.has(k));
  if (unknown.length) {
    return {
      ok: false,
      reason:
        `not an editable setting: ${unknown.join(', ')} ` +
        `(editable: ${[...EDITABLE_SETTINGS].join(', ')})`,
    };
  }

  const problems = validateConfig({ ...config, ...patch });
  if (problems.length) return { ok: false, reason: problems.join('; ') };

  const clean = {};
  for (const k of keys) clean[k] = patch[k];
  return { ok: true, patch: clean };
}

// Write settings back to the config file.
//
// Only the keys given. A value the running config filled in from a default must
// not be written back as though somebody had authored it, which is the same rule
// saveViews follows for everything outside `views`, and the reason both take a
// narrow patch rather than the whole live object.
//
// Sibling then rename, because this is the file the wall boots from: a crash or a
// full disk part-way through a plain writeFileSync would truncate it and send the
// next launch down the fatal-config path.
function saveSettings(file, patch) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(patch)) raw[key] = value;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return raw;
}

// The per-panel fields a patch may carry, and nothing else.
//
// Same reasoning as EDITABLE_SETTINGS, with one difference that matters more:
// unknown keys here used to be accepted **in silence**. A patch naming
// allowedOrigins answered ok and did nothing at all, which is worse than
// refusing, because the caller is left believing a security-relevant field was
// set.
//
// Deliberately not the whole of KNOWN_VIEW. `grid` arrives through the layout
// editor's own path, `id` is identity, and `allowedOrigins` and
// `allowedPermissions` are deliberate config edits rather than something to
// change over an unauthenticated HTTP surface. Adding a field here means writing
// the code in updatePanel() that applies it.
const PATCHABLE_PANEL_FIELDS = new Set(['url', 'label', 'zoom', 'partition']);

// Shape and fields only. The value rules that are security decisions - which URL
// schemes a panel may load, and the persist: partition rule - stay in
// src/policy.js, and updatePanel() asks both.
function panelPatchVerdict(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, reason: 'patch must be an object' };
  }
  const keys = Object.keys(patch);
  if (!keys.length) return { ok: false, reason: 'patch is empty' };

  const unknown = keys.filter((k) => !PATCHABLE_PANEL_FIELDS.has(k));
  if (unknown.length) {
    return {
      ok: false,
      reason:
        `not a patchable field: ${unknown.join(', ')} ` +
        `(patchable: ${[...PATCHABLE_PANEL_FIELDS].join(', ')}). ` +
        'allowedOrigins and allowedPermissions are edited in the config file.',
    };
  }

  // Was silently dropped rather than refused, which is the same defect as an
  // unknown key wearing different clothes: the caller is told ok and the zoom
  // does not change.
  if (patch.zoom !== undefined && !(Number.isFinite(patch.zoom) && patch.zoom > 0)) {
    return { ok: false, reason: 'zoom must be a positive number' };
  }
  return { ok: true };
}

// Write the panel list back to the config file. The editor can add, delete and
// retitle panels, not just move them, so the whole array is replaced rather than
// patched in place. Everything else in the file is preserved, so keys the
// running config filled in from defaults are not written back as if they had
// been authored.
function saveViews(file, views, presets) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.views = views.map(serializeView);
  // Only written when there are any, so a config that never used presets does
  // not grow an empty key it did not ask for.
  if (Array.isArray(presets) && presets.length) {
    raw.presets = presets.map((preset) => ({
      id: preset.id,
      name: preset.name || preset.id,
      views: preset.views.map(serializeView),
    }));
  } else if (raw.presets) {
    delete raw.presets;
  }
  // Write to a sibling then rename. This file is what the editor saves and what
  // the wall boots from, so a crash or a full disk part-way through a plain
  // writeFileSync would truncate it and send the next launch down the
  // fatal-config path. rename(2) is atomic within a directory, which is why the
  // temp file sits beside the target rather than in a temp dir. Same reasoning as
  // the rotation in src/diag-log.js.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return raw.views.length;
}

function serializeView(v) {
  const out = { id: v.id };
  if (v.label) out.label = v.label;
  out.url = v.url || '';
  out.grid = {
    x: Math.round(v.grid.x),
    y: Math.round(v.grid.y),
    width: Math.round(v.grid.width),
    height: Math.round(v.grid.height),
  };
  out.zoom = Math.round((v.zoom ?? 1) * 1000) / 1000;
  out.partition = v.partition;
  if (v.refreshMs) out.refreshMs = v.refreshMs;
  if (v.recycleMs) out.recycleMs = v.recycleMs;
  if (v.neverRecycle) out.neverRecycle = true;
  if (Array.isArray(v.allowedOrigins) && v.allowedOrigins.length) {
    out.allowedOrigins = v.allowedOrigins;
  }
  // This was missing, and its absence was silent and destructive. saveViews
  // rewrites every view, so dragging one panel and pressing Esc deleted the
  // permission grants of ALL of them. It fails closed - absent means none, the
  // opposite polarity to allowedOrigins - so nothing broke loudly: a dashboard
  // simply stopped being allowed its camera, with nothing in the log to say why.
  if (Array.isArray(v.allowedPermissions) && v.allowedPermissions.length) {
    out.allowedPermissions = v.allowedPermissions;
  }
  return out;
}

module.exports = {
  loadConfig,
  validateConfig,
  withDefaults,
  unknownKeys,
  saveViews,
  saveSettings,
  settingsVerdict,
  panelPatchVerdict,
  serializeView,
  EDITABLE_SETTINGS,
  PATCHABLE_PANEL_FIELDS,
};
