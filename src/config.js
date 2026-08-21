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

  if (!Array.isArray(c.views) || c.views.length === 0) {
    p.push('"views" must be a non-empty array');
    return p;
  }

  const ids = new Set();
  const partitions = new Set();
  c.views.forEach((v, i) => {
    const at = `views[${i}]`;
    if (!v || typeof v !== 'object') {
      p.push(`${at} is not an object`);
      return;
    }
    if (!v.id) p.push(`${at}.id is required`);
    else if (ids.has(v.id)) p.push(`${at}.id "${v.id}" is duplicated`);
    else ids.add(v.id);

    if (typeof v.url !== 'string' || !v.url) p.push(`${at}.url is required`);

    // Distinct partitions keep the four logins independent. A shared partition
    // is almost always a copy/paste mistake, and silently sharing cookies
    // between panels would be a confusing failure on the wall.
    const part = v.partition || `persist:forge-${i + 1}`;
    if (partitions.has(part)) p.push(`${at}.partition "${part}" is used by another view`);
    else partitions.add(part);

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
    // dashboards use it to close modals. "double" lets a single Esc reach the
    // page and docks on a quick second press. See docs/validation.md.
    escToGrid: c.escToGrid || 'double',
    escDoubleMs: c.escDoubleMs ?? 600,
    backButton: c.backButton || { x: 24, y: 24, width: 176, height: 56 },
    views: c.views.map((v, i) => ({
      zoom: 1,
      partition: `persist:forge-${i + 1}`,
      ...v,
    })),
  };
}

// Write edited panel rectangles and zoom back to the config file. Re-reads the
// file and patches only grid/zoom by view id, so keys the running config filled
// in from defaults are not written back into the file as if they were authored.
function saveLayout(file, views) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byId = new Map(views.map((v) => [v.id, v]));
  let patched = 0;
  (raw.views || []).forEach((v) => {
    const u = byId.get(v.id);
    if (!u) return;
    v.grid = {
      x: Math.round(u.grid.x),
      y: Math.round(u.grid.y),
      width: Math.round(u.grid.width),
      height: Math.round(u.grid.height),
    };
    v.zoom = Math.round(u.zoom * 1000) / 1000;
    patched++;
  });
  if (!patched) throw new Error('no matching view ids in ' + file);
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  return patched;
}

module.exports = { loadConfig, validateConfig, withDefaults, saveLayout };
