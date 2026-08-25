// Config loading and validation. Kept free of any electron import so it can be
// exercised by plain node, which is what test/config.test.js does.

const fs = require('fs');

function loadConfig(file) {
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
};

const WATCHDOG_NON_NEGATIVE = {
  baseDelayMs: 'first retry delay, doubling from there',
  maxDelayMs: 'the cap on that backoff',
  maxAttempts: 'reloads before escalating to a rebuild; 0 = unlimited',
  retryMs: 'how long an unrecoverable panel waits before trying again; 0 = never',
};

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
  // The upkeep and memory-ladder settings. A table rather than a dozen
  // near-identical blocks: every one of them is a duration or a count, and the
  // check is the same. 0 means "off" for all of them, which is why the shipped
  // config can leave them out entirely.
  for (const [key, note] of Object.entries(NON_NEGATIVE)) {
    if (c[key] !== undefined && !(Number.isFinite(c[key]) && c[key] >= 0)) {
      p.push(`${key} must be a number >= 0 (${note})`);
    }
  }
  if (c.memoryRelaunch !== undefined && typeof c.memoryRelaunch !== 'boolean') {
    p.push('memoryRelaunch must be true or false');
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
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
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
  return out;
}

module.exports = { loadConfig, validateConfig, withDefaults, saveViews, serializeView };
