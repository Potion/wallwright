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
    partitions.add(v.partition || `persist:forge-${i + 1}`);

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
    if (v.allowedOrigins !== undefined && !Array.isArray(v.allowedOrigins)) {
      p.push(`${at}.allowedOrigins must be an array of origins`);
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
    backButton: c.backButton || { x: 24, y: 24, width: 176, height: 56 },
    views: c.views.map((v, i) => ({
      zoom: 1,
      partition: `persist:forge-${i + 1}`,
      ...v,
    })),
  };
}

// Write the panel list back to the config file. The editor can add, delete and
// retitle panels, not just move them, so the whole array is replaced rather than
// patched in place. Everything else in the file is preserved, so keys the
// running config filled in from defaults are not written back as if they had
// been authored.
function saveViews(file, views) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.views = views.map(serializeView);
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
  if (Array.isArray(v.allowedOrigins) && v.allowedOrigins.length) {
    out.allowedOrigins = v.allowedOrigins;
  }
  return out;
}

module.exports = { loadConfig, validateConfig, withDefaults, saveViews, serializeView };
