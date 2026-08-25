// Wallwright - Electron main process.
//
// Displays four live web views laid out on one LED wall. In "grid" mode all
// four are shown at their configured rectangles and a transparent overlay on
// top captures clicks. Clicking a panel promotes it to fullscreen and hands
// input to that page ("active" mode). Esc, a corner Back button, or an idle
// timeout returns to the grid.
//
// Hard rule from SPEC.md: returning to the grid must never reload a view, and
// the watchdog must never reload the panel someone is currently using. Both
// would drop the operator's login.
//
// See SPEC.md for the full design and AGENTS.md for what is still open.

const {
  app,
  BaseWindow,
  BrowserWindow,
  View,
  WebContentsView,
  Menu,
  screen,
  ipcMain,
  globalShortcut,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { loadConfig, saveViews } = require('./config');
const { clampGrid, snapGrid } = require('./layout');
const { createControlServer } = require('./control-server');
const { statusPage } = require('./control-page');

// The app was called Wallwright before it was Wallwright. The name decides the
// userData folder, so renaming it orphans the tuned layout and every login;
// migrateLegacyUserData() below carries them across on first run.
const APP_NAME = 'Wallwright';
const LEGACY_APP_NAME = 'Wallwright';

// Set before anything reads userData, because this decides where the `persist:`
// session partitions live. Left at the default they would sit under an
// "Electron" folder, which is both wrong for a shipped exhibit and a surprise
// when someone goes looking for the logins.
//
// Note this does NOT change the macOS menu-bar title: that comes from the app
// bundle's CFBundleName, so in development it reads "Electron" until the app is
// packaged. Moot on the Windows target, which is frameless with no menu bar, and
// hidden under kiosk anyway.
app.setName(APP_NAME);

const BUNDLED_CONFIG = path.join(__dirname, '..', 'config', 'wall.json');

// Resolved at startup rather than at module load, because it depends on
// app.isPackaged and on userData, and because it can create a file.
let configPath = BUNDLED_CONFIG;

// In a packaged app the bundled config lives inside app.asar, which is
// read-only: the layout editor's save would fail and the show PC could not be
// tuned in place. So the live config is a copy under userData, seeded from the
// bundle on first run. That also means a reinstall does not overwrite a layout
// someone spent time getting right.
function resolveConfigPath() {
  if (process.env.WALLWRIGHT_CONFIG) return process.env.WALLWRIGHT_CONFIG;
  if (!app.isPackaged) return BUNDLED_CONFIG;

  const userData = app.getPath('userData');
  const live = path.join(userData, 'wall.json');
  if (!fs.existsSync(live)) {
    fs.mkdirSync(userData, { recursive: true });
    if (!migrateLegacyUserData(userData, live)) {
      fs.copyFileSync(BUNDLED_CONFIG, live);
      log(`seeded ${live} from the bundled default`);
    }
  }
  return live;
}

// Carry a previous install's state across the rename from Wallwright to Wallwright.
//
// Renaming an Electron app moves its userData folder, which holds both the
// tuned montage and every `persist:` session. Without this, upgrading a show PC
// would silently present a default layout and signed-out dashboards, which is a
// bad morning to have at a venue. Runs once: as soon as the new folder has a
// config, this is skipped.
function migrateLegacyUserData(userData, live) {
  const legacyDir = path.join(path.dirname(userData), LEGACY_APP_NAME);
  const legacyConfig = path.join(legacyDir, 'wall.json');
  if (!fs.existsSync(legacyConfig)) return false;

  try {
    fs.copyFileSync(legacyConfig, live);
    log(`migrated the montage from the previous ${LEGACY_APP_NAME} install`);
  } catch (e) {
    warn(`could not migrate the montage from ${legacyDir}: ${e.message}`);
    return false;
  }

  // Sessions live alongside it. Copied rather than moved, so a rollback still
  // finds the old install intact.
  const legacyPartitions = path.join(legacyDir, 'Partitions');
  const newPartitions = path.join(userData, 'Partitions');
  if (fs.existsSync(legacyPartitions) && !fs.existsSync(newPartitions)) {
    try {
      fs.cpSync(legacyPartitions, newPartitions, { recursive: true });
      log('migrated the saved logins too');
    } catch (e) {
      warn(`logins could not be migrated, so panels will need signing in again: ${e.message}`);
    }
  }
  return true;
}
const DEV = process.env.WALLWRIGHT_DEV === '1';
// Dev only: log which panel each click and keypress reaches.
const LOG_INPUT = DEV && process.env.WALLWRIGHT_LOG_INPUT === '1';

// Smallest panel the layout editor will produce, in wall units.
const MIN_PANEL = 160;

// Past this many live browser views, say something. Not a cap: an operator may
// have a good reason, and the warning is in the log where it belongs.
const BUSY_PANELS = 8;

let config = null;
let win = null; // BaseWindow: the wall
const contentViews = []; // WebContentsView per configured page (index-aligned with config.views)
let overlay = null; // WebContentsView: transparent hotspot layer / corner Back button
let backdrop = null; // View: opaque wall background behind every panel
let lastDisplayId = null; // so display selection is logged on change, not per resize
let lastScaleLogged = null; // ditto for the layout scale
let state = { mode: 'grid', activeIndex: -1 };
let idleTimer = null;
let lastEscAt = 0;
let activePresetId = null; // which named montage is on the wall, if any
const startedAt = Date.now();
const popups = new Set(); // BrowserWindows opened by SSO flows
let editDrag = null; // { i, baseGrid, baseZoom } while a layout drag is in flight
const watchdog = new Map(); // view id -> { attempts, pending, deferred }
const touched = new Map(); // view id -> ms of the last input in that panel

function log(...args) {
  console.log('[wallwright]', ...args);
}
function warn(...args) {
  console.warn('[wallwright]', ...args);
}

// ---- geometry / display -----------------------------------------------------
//
// The layout in config is authored in "wall units": the resolution the exhibit
// is designed for. The window we actually get may be a different size (a dev
// laptop, or a show PC display that disagrees with the config), so the whole
// authored layout is scaled uniformly and centred inside the window. On a
// display that matches the config the scale is 1 and nothing moves, which is the
// show PC case. This is what makes a 3840x2160 wall layout previewable on a
// laptop without editing any rectangles.
let layout = { scale: 1, offsetX: 0, offsetY: 0, width: 0, height: 0 };

// Height to keep clear at the top of the wall. On a notched MacBook, owning the
// whole display means page content sits under the camera housing. That is a
// laptop-only annoyance, since the show PC has no notch, so it is opt-in:
// `wall.safeAreaTop` of "auto" measures the inset macOS reports, a number sets
// it explicitly, and absent means no inset at all.
//
// Only applies while the app owns the display. In a window it already sits below
// the menu bar, so there is nothing to avoid.
function safeAreaTop() {
  if (!isFullscreenNow()) return 0;
  const setting = config.wall.safeAreaTop;
  if (setting === 'auto') {
    if (process.platform !== 'darwin') return 0;
    const d = pickWallDisplay();
    return Math.max(0, d.workArea.y - d.bounds.y);
  }
  return Number.isFinite(setting) && setting > 0 ? Math.round(setting) : 0;
}

function computeLayout() {
  const target = win ? win.getContentBounds() : pickWallDisplay().bounds;
  const W = target.width;
  const H = target.height;
  const w = config.wall.width;
  const h = config.wall.height;
  const top = safeAreaTop();
  const avail = Math.max(1, H - top);
  const scale = config.wall.fitToDisplay === false ? 1 : Math.min(W / w, avail / h);

  // Report against the window, which is what the layout is actually scaled
  // into. Reporting against the display would claim 1:1 while the app sits in
  // an 85% window. Only on change, since this is called on every resize.
  const stamp = `${scale}/${top}/${W}x${H}`;
  if (stamp !== lastScaleLogged) {
    lastScaleLogged = stamp;
    const inset = top ? `, keeping ${top}px clear at the top` : '';
    if (Math.abs(scale - 1) < 0.0005) {
      log(`layout ${w}x${h} in a ${W}x${H} window, 1:1${inset}`);
    } else {
      log(`layout ${w}x${h} in a ${W}x${H} window, scaled to ${scale.toFixed(3)}${inset}`);
    }
  }

  return {
    scale,
    offsetX: Math.round((W - w * scale) / 2),
    offsetY: top + Math.round((avail - h * scale) / 2),
    width: W,
    height: H,
    safeTop: top,
  };
}

// Wall units -> window pixels.
function scaleRect(r) {
  return {
    x: layout.offsetX + Math.round(r.x * layout.scale),
    y: layout.offsetY + Math.round(r.y * layout.scale),
    width: Math.round(r.width * layout.scale),
    height: Math.round(r.height * layout.scale),
  };
}

function panelRect(i) {
  return scaleRect(config.views[i].grid);
}

// Page zoom follows the layout scale, so a panel scaled down to preview a 4K
// wall on a laptop shows the same amount of page content it will on the wall.
function panelZoom(i) {
  return config.views[i].zoom * layout.scale;
}

// The whole window, including any letterbox margin. The grid-mode overlay uses
// this so a click anywhere is captured.
function wallBounds() {
  return { x: 0, y: 0, width: layout.width, height: layout.height };
}

// Just the authored wall area inside the window. A promoted panel fills this,
// not the whole window, so its aspect ratio matches the real wall.
function stageBounds() {
  return scaleRect({ x: 0, y: 0, width: config.wall.width, height: config.wall.height });
}

// Window pixels -> wall units. The layout editor works in window pixels because
// that is what the mouse gives it; config is always stored in wall units, so a
// layout adjusted on a laptop still means the same thing on the wall.
function unscaleRect(r) {
  const s = layout.scale || 1;
  return {
    x: Math.round((r.x - layout.offsetX) / s),
    y: Math.round((r.y - layout.offsetY) / s),
    width: Math.round(r.width / s),
    height: Math.round(r.height / s),
  };
}

// Pick the physical output the wall is driven from. The show PC will not have
// the wall on its primary display, so label/id matching matters there; falling
// back to primary is a dev-machine convenience and says so loudly.
function pickWallDisplay() {
  const displays = screen.getAllDisplays();
  const { displayLabel, displayId, width, height } = config.wall;

  // This runs on every resize and every display-metrics change, so notes are
  // collected and only emitted when the chosen display actually changes.
  // Otherwise an unattended run buries its real messages under hundreds of
  // identical warnings.
  const notes = [];
  let hit = null;

  if (displayId != null) {
    hit = displays.find((d) => String(d.id) === String(displayId));
    if (!hit) {
      notes.push([
        warn,
        `no display with id ${displayId}; known ids:`,
        displays.map((d) => d.id),
      ]);
    }
  }
  if (!hit && displayLabel) {
    hit = displays.find((d) => d.label === displayLabel);
    if (!hit) {
      notes.push([
        warn,
        `no display labelled "${displayLabel}"; known labels:`,
        displays.map((d) => d.label),
      ]);
    }
  }
  if (!hit) {
    // Last resort before primary: a display whose resolution matches the wall.
    const exact = displays.filter(
      (d) => d.bounds.width === width && d.bounds.height === height
    );
    if (exact.length === 1) {
      hit = exact[0];
      notes.push([log, `matched display by ${width}x${height}: "${hit.label}" (id ${hit.id})`]);
    }
  }
  if (!hit) {
    hit = screen.getPrimaryDisplay();
    notes.push([
      warn,
      `falling back to the PRIMARY display "${hit.label}" (id ${hit.id}). ` +
        'Set wall.displayLabel or wall.displayId to target the LED wall output.',
    ]);
  }

  // Only a real problem when the layout is not being fitted: then the authored
  // rectangles genuinely land in the wrong place. With fitToDisplay on, the
  // scale is reported by computeLayout() against the window instead.
  if (
    config.wall.fitToDisplay === false &&
    (hit.bounds.width !== width || hit.bounds.height !== height)
  ) {
    notes.push([
      warn,
      `wall config is ${width}x${height} but display "${hit.label}" is ` +
        `${hit.bounds.width}x${hit.bounds.height}, and wall.fitToDisplay is off. ` +
        'Panel rectangles will not land where you expect until these agree.',
    ]);
  }

  if (hit.id !== lastDisplayId) {
    lastDisplayId = hit.id;
    notes.forEach(([fn, msg, extra]) => (extra === undefined ? fn(msg) : fn(msg, extra)));
  }
  return hit;
}

// ---- z-order ----------------------------------------------------------------
//
// Electron paints child views in insertion order, so "frontmost" means last.
// Re-adding an existing child reorders it in place rather than detaching it,
// which avoids a repaint on every transition. Verified on Electron 43.4.1 /
// macOS by `npm run probe` (abc -> addChildView(a) -> bca). The remove + add
// fallback below is therefore dead on that build, but it is kept until the probe
// is re-run on Windows, where the show PC lives.
function bringToTop(view) {
  const kids = win.contentView.children;
  if (kids[kids.length - 1] === view) return; // already frontmost
  win.contentView.addChildView(view);
  if (win.contentView.children.at(-1) !== view) {
    win.contentView.removeChildView(view);
    win.contentView.addChildView(view);
  }
}

// ---- wall construction ------------------------------------------------------

function publicView(v, i) {
  return { id: v.id, label: v.label, grid: panelRect(i) };
}

function createWall() {
  const display = pickWallDisplay();

  // Start at the display's size when the wall is going fullscreen anyway.
  // Creating a 3840x2160 window on a smaller display and then fullscreening it
  // makes macOS animate the shrink over dozens of frames, and every frame is a
  // resize event.
  const goingFullscreen = !!(config.wall.fullscreen || config.wall.kiosk);
  win = new BaseWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: goingFullscreen ? display.bounds.width : config.wall.width,
    height: goingFullscreen ? display.bounds.height : config.wall.height,
    frame: false,
    backgroundColor: config.wall.backgroundColor,
  });

  // Applied after construction, not as constructor options. See
  // applyFullscreen() for why the obvious options are the wrong ones on macOS.
  if (goingFullscreen) applyFullscreen(true);

  // Fullscreen/kiosk means the real content size is the display's, not whatever
  // was passed above, and it only settles after the transition. Compute the
  // layout from the window itself and recompute whenever it changes.
  layout = computeLayout();
  let resizeTimer = null;
  const onResize = () => {
    // A fullscreen transition emits a resize per animation frame. Relaying out
    // on each one means dozens of setBounds + setZoomFactor passes over four
    // live web views, so wait for the size to settle instead.
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      refreshLayout();
      if (state.mode === 'active') activate(state.activeIndex, { force: true });
      else if (overlay) dockGrid({ animate: false });
    }, 120);
  };
  win.on('resize', onResize);
  win.on('enter-full-screen', onResize);
  win.on('leave-full-screen', onResize);

  // An opaque backdrop behind everything. Without it, a region no panel covers
  // keeps whatever pixels were last drawn there: shrink a panel in the layout
  // editor and the strip it vacates holds a stale copy of the page instead of
  // clearing to the wall colour. The window's own backgroundColor does not
  // repaint that area, so something has to occupy it.
  backdrop = new View();
  backdrop.setBackgroundColor(config.wall.backgroundColor);
  win.contentView.addChildView(backdrop);
  backdrop.setBounds(wallBounds());

  config.views.forEach((v) => contentViews.push(createContentView(v)));

  // Transparent overlay, added last so it sits on top.
  overlay = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Alpha compositing of a WebContentsView over sibling views is the main
  // architectural risk in SPEC.md. Validate per OS; fallbacks are in the spec.
  overlay.setBackgroundColor('#00000000');
  win.contentView.addChildView(overlay);
  // The overlay is a renderer, so its errors are invisible from here unless
  // they are forwarded. Dev only: on a wall nobody is reading a console.
  if (DEV) {
    overlay.webContents.on('console-message', (e) => {
      const level = e.level === 'error' || e.level === 'warning' ? warn : log;
      level(`overlay[${e.level}] ${e.message} (${e.lineNumber})`);
    });
  }
  overlay.webContents.loadFile(path.join(__dirname, 'overlay.html'));
  overlay.webContents.once('did-finish-load', () => {
    dockGrid();
    // Dev convenience: come up straight in the editor, for testing it and for
    // screenshotting it.
    if (DEV && process.env.WALLWRIGHT_START_EDIT === '1') enterEdit();
    // Selecting a panel makes the inspector visible, which a screenshot of the
    // editor needs.
    if (DEV && process.env.WALLWRIGHT_SELECT) {
      overlay.webContents.send('ww:select', process.env.WALLWRIGHT_SELECT);
    }
    if (DEV && process.env.WALLWRIGHT_SELFTEST === '1') selfTest();
    if (DEV && process.env.WALLWRIGHT_CAPTURE_OUT)
      scheduleCapture(process.env.WALLWRIGHT_CAPTURE_OUT);
    startUpkeep();
    startMemoryWatch();
    startControlServer();
  });
}

// ---- panel lifecycle -------------------------------------------------------

// A panel with no URL yet is a normal state right after it is created in the
// editor. Show something that says so rather than a black rectangle.
function placeholderURL(v) {
  const html = `<body style="margin:0;height:100vh;display:flex;align-items:center;
    justify-content:center;background:#0d1117;color:#8b949e;
    font:16px/1.5 -apple-system,Helvetica,Arial,sans-serif;text-align:center">
    <div><div style="color:#f04e23;font-weight:600;margin-bottom:8px">
    ${escapeHtml(v.label || v.id)}</div>
    No URL set. Select this panel in layout edit mode and enter one.</div></body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function createContentView(v) {
  const view = new WebContentsView({
    webPreferences: {
      partition: v.partition,
      preload: path.join(__dirname, 'content-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.contentView.addChildView(view);
  const i = config.views.indexOf(v);
  if (i >= 0) {
    view.setBounds(panelRect(i));
    view.webContents.setZoomFactor(panelZoom(i));
  }
  hardenView(view, v);
  view.webContents.loadURL(v.url || placeholderURL(v));
  return view;
}

function uniqueId(base) {
  let n = config.views.length + 1;
  const taken = new Set(config.views.map((v) => v.id));
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// Each new panel gets its own session by default. The editor can point it at
// another panel's session afterwards, which is what several views of one
// SSO-protected app need.
function addPanel(rect) {
  const id = uniqueId('panel');
  const v = {
    id,
    label: '',
    url: '',
    grid: clampGrid(rect, wallUnits(), MIN_PANEL),
    zoom: 1,
    partition: `persist:${id}`,
  };
  config.views.push(v);
  contentViews.push(createContentView(v));
  if (config.views.length > BUSY_PANELS) {
    warn(
      `${config.views.length} panels. Each one is a live browser view, so on a ` +
        '4K wall expect this to show in GPU and memory.'
    );
  }
  log(`added ${id}`);
  return v;
}

function deletePanel(id) {
  const i = indexOfId(id);
  if (i < 0) return;
  const view = contentViews[i];

  win.contentView.removeChildView(view);
  // Without this the renderer process for a deleted panel keeps running.
  if (!view.webContents.isDestroyed()) view.webContents.close();

  config.views.splice(i, 1);
  contentViews.splice(i, 1);

  const w = watchdog.get(id);
  if (w && w.pending) clearTimeout(w.pending);
  watchdog.delete(id);
  touched.delete(id);

  // A promoted panel that gets deleted has to leave active mode, and indices
  // after the removed one have all shifted.
  if (state.mode === 'active') {
    if (state.activeIndex === i) state = { mode: 'grid', activeIndex: -1 };
    else if (state.activeIndex > i) state.activeIndex -= 1;
  }
  log(`deleted ${id}`);
}

// url, label, zoom and partition. A partition change means a new session, which
// can only be chosen when a view is created, so that one rebuilds the view.
function updatePanel(id, patch) {
  const i = indexOfId(id);
  if (i < 0) return;
  const v = config.views[i];

  if (patch.label !== undefined) v.label = String(patch.label);
  if (patch.zoom !== undefined && Number.isFinite(patch.zoom) && patch.zoom > 0) {
    v.zoom = patch.zoom;
    contentViews[i].webContents.setZoomFactor(panelZoom(i));
  }

  const newPartition =
    patch.partition !== undefined && patch.partition && patch.partition !== v.partition
      ? String(patch.partition)
      : null;
  const newUrl =
    patch.url !== undefined && String(patch.url) !== v.url ? String(patch.url) : null;
  if (newUrl !== null) v.url = newUrl;

  if (newPartition) {
    v.partition = newPartition;
    const old = contentViews[i];
    win.contentView.removeChildView(old);
    if (!old.webContents.isDestroyed()) old.webContents.close();
    contentViews[i] = createContentView(v);
    log(`${id}: session -> ${newPartition}`);
  } else if (newUrl !== null) {
    // Loading a new URL is exactly what was asked for here, so the usual
    // "never reload a panel" rule does not apply.
    contentViews[i].webContents.loadURL(v.url || placeholderURL(v));
    log(`${id}: ${v.url || '(no url)'}`);
  }

  bringToTop(overlay);
}

function wallUnits() {
  return { width: config.wall.width, height: config.wall.height };
}

// ---- upkeep: refresh, recycle, memory ---------------------------------------
//
// An exhibit runs for weeks. Dashboards go stale, and long-lived renderers grow.
// Both fixes are timer-driven reloads, so both share one safety rule: never
// touch a panel somebody is using.
//
// The two are not equivalent, which src/dev/session-probe.js measured:
//
//   refreshMs -> webContents.reload()
//     Cookies and sessionStorage both survive. Safe for a signed-in dashboard.
//     Frees the document, but the renderer process itself lives on.
//
//   recycleMs -> destroy the view and build a new one
//     Cookies survive, sessionStorage does NOT: it is per-tab. An app holding
//     its access token there gets signed out. Reclaims the whole process, which
//     is the point. Off unless asked for, for that reason.

let upkeepTimer = null;
let memoryTimer = null;
const lastRefresh = new Map(); // view id -> ms
const lastRecycle = new Map();

function inUse(v) {
  const promoted = state.mode === 'active' && state.activeIndex === config.views.indexOf(v);
  return promoted || Date.now() - (touched.get(v.id) || 0) < config.recentUseMs;
}

function dueFor(map, v, everyMs) {
  if (!everyMs) return false;
  const since = Date.now() - (map.get(v.id) || startedAt);
  return since >= everyMs;
}

function refreshPanel(i) {
  const v = config.views[i];
  lastRefresh.set(v.id, Date.now());
  log(`refreshing ${v.id}`);
  contentViews[i].webContents.reload();
}

// Rebuild the view, which is the only way to hand the renderer process back.
function recyclePanel(i) {
  const v = config.views[i];
  lastRecycle.set(v.id, Date.now());
  lastRefresh.set(v.id, Date.now());
  log(`recycling ${v.id} to reclaim its renderer`);
  const old = contentViews[i];
  win.contentView.removeChildView(old);
  if (!old.webContents.isDestroyed()) old.webContents.close();
  contentViews[i] = createContentView(v);
  bringToTop(overlay);
}

function runUpkeep() {
  config.views.forEach((v, i) => {
    if (inUse(v)) return; // never under someone's hands
    if (state.mode === 'edit') return; // nor while the layout is being changed
    if (dueFor(lastRecycle, v, v.recycleMs)) return recyclePanel(i);
    if (dueFor(lastRefresh, v, v.refreshMs)) return refreshPanel(i);
  });
}

function startUpkeep() {
  if (upkeepTimer) clearInterval(upkeepTimer);
  const wanted = config.views.some((v) => v.refreshMs || v.recycleMs);
  if (!wanted) return;
  // Checked once a second; each panel's own interval decides when it is due.
  upkeepTimer = setInterval(runUpkeep, 1000);
}

// Memory. Reported rather than acted on by default: an exhibit that restarts
// itself unpredictably is worse than one that uses a lot of RAM, and knowing the
// real numbers has to come before tuning anything.
function checkMemory() {
  let total = 0;
  const byType = new Map();
  for (const m of app.getAppMetrics()) {
    const mb = (m.memory && m.memory.workingSetSize ? m.memory.workingSetSize : 0) / 1024;
    total += mb;
    byType.set(m.type, (byType.get(m.type) || 0) + mb);
  }
  const parts = [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, mb]) => `${t} ${Math.round(mb)}MB`)
    .join(', ');
  log(`memory: ${Math.round(total)}MB total (${parts})`);

  if (!config.memoryLimitMb || total <= config.memoryLimitMb) return;
  warn(`memory is over the ${config.memoryLimitMb}MB limit`);
  // Recycle the least recently used idle panel, one per check, so a spike does
  // not rebuild the whole wall at once.
  const candidates = config.views
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => !inUse(v))
    .sort((a, b) => (touched.get(a.v.id) || 0) - (touched.get(b.v.id) || 0));
  if (!candidates.length) return log('every panel is in use; leaving them alone');
  recyclePanel(candidates[0].i);
}

function startMemoryWatch() {
  if (memoryTimer) clearInterval(memoryTimer);
  if (!config.memoryCheckMs) return;
  memoryTimer = setInterval(checkMemory, config.memoryCheckMs);
}

// ---- presets ----------------------------------------------------------------
//
// A preset is a named snapshot of a montage. config.views is what is on the wall
// now; presets are copies you can recall into it. Every video wall platform in
// this category has this, and it is what turns the layout editor from a one-shot
// setup tool into something usable day to day.

function clonePresetViews(views) {
  return views.map((v) => ({ ...v, grid: { ...v.grid } }));
}

function findPreset(id) {
  return config.presets.find((p) => p.id === id);
}

// Panels that are unchanged keep their existing view, so recalling a preset does
// not throw away the pages that were already right. A reload would keep the
// login (see src/dev/session-probe.js) but would still lose whatever the page
// was showing, and on a control room wall that reads as the whole thing
// flickering for no reason.
function applyPreset(id) {
  const preset = findPreset(id);
  if (!preset) return warn(`no preset "${id}"`);

  const wanted = clonePresetViews(preset.views);
  const keptViews = [];
  const spare = contentViews.slice();
  const spareSpecs = config.views.slice();

  wanted.forEach((want) => {
    const i = spareSpecs.findIndex(
      (have) =>
        have.id === want.id && have.url === want.url && have.partition === want.partition
    );
    if (i >= 0) {
      keptViews.push(spare[i]);
      spare.splice(i, 1);
      spareSpecs.splice(i, 1);
    } else {
      keptViews.push(null); // built below, once config.views is in place
    }
  });

  // Anything left over is not in the preset, so it goes.
  spare.forEach((view) => {
    win.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  });
  spareSpecs.forEach((v) => {
    const w = watchdog.get(v.id);
    if (w && w.pending) clearTimeout(w.pending);
    watchdog.delete(v.id);
    touched.delete(v.id);
  });

  config.views = wanted;
  contentViews.length = 0;
  wanted.forEach((v, i) => {
    contentViews.push(keptViews[i] || createContentView(v));
  });

  activePresetId = id;
  state = { mode: state.mode === 'edit' ? 'edit' : 'grid', activeIndex: -1 };
  startUpkeep(); // the new montage may want different intervals
  const reused = keptViews.filter(Boolean).length;
  log(`preset "${preset.name || id}": ${wanted.length} panels, ${reused} reused`);
  dockGridOrKeepEditing();
}

// Recalling while the editor is open should leave the editor open.
function dockGridOrKeepEditing() {
  if (state.mode === 'edit') {
    refreshLayout();
    config.views.forEach((v, i) => {
      contentViews[i].setVisible(true);
      contentViews[i].setBounds(panelRect(i));
      contentViews[i].webContents.setZoomFactor(panelZoom(i));
    });
    bringToTop(overlay);
    sendOverlayState();
  } else {
    dockGrid({ animate: false });
  }
}

function savePreset(name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const id =
    clean
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'preset';
  const existing = findPreset(id);
  const preset = {
    id,
    name: clean,
    views: clonePresetViews(config.views),
  };
  if (existing) Object.assign(existing, preset);
  else config.presets.push(preset);
  activePresetId = id;
  log(`saved preset "${clean}" (${preset.views.length} panels)`);
  return preset;
}

function deletePreset(id) {
  const i = config.presets.findIndex((p) => p.id === id);
  if (i < 0) return;
  log(`deleted preset "${config.presets[i].name || id}"`);
  config.presets.splice(i, 1);
  if (activePresetId === id) activePresetId = null;
}

// ---- state transitions ------------------------------------------------------

// Animated bounds when a transition duration is configured. Electron animates
// this natively, so there is no custom tween to maintain.
function setBounds(view, bounds, animate) {
  const ms = config.transitionMs;
  if (animate && ms > 0) {
    view.setBounds(bounds, { animate: { duration: ms, easing: 'ease-out' } });
  } else {
    view.setBounds(bounds);
  }
}

// The window does not necessarily have its final size when createWall() runs:
// entering fullscreen/kiosk settles asynchronously, and if no resize event
// follows, the layout stays computed against the smaller pre-fullscreen bounds.
// That letterboxes the wall and scales every panel slightly, so every state
// transition re-reads the window rather than trusting the last value.
function refreshLayout() {
  if (!win) return;
  layout = computeLayout();
  if (backdrop) backdrop.setBounds(wallBounds());
}

function dockGrid({ animate = true } = {}) {
  refreshLayout();
  const wasActive = state.activeIndex;
  state = { mode: 'grid', activeIndex: -1 };
  clearIdle();
  lastEscAt = 0;

  config.views.forEach((v, i) => {
    contentViews[i].setVisible(true);
    setBounds(contentViews[i], panelRect(i), animate && i === wasActive);
    // Re-assert zoom: promoting changes the viewport, and some pages reset zoom
    // on navigation.
    contentViews[i].webContents.setZoomFactor(panelZoom(i));
  });

  // The overlay is hidden in grid mode, which is what makes the panels
  // interactive: a WebContentsView consumes every OS event that lands on it,
  // and there is no way to make one selectively transparent to input
  // (setIgnoreMouseEvents is a BrowserWindow API). Promotion moved to select
  // and edit modes for exactly this reason.
  overlay.setBounds(wallBounds());
  overlay.setVisible(false);
  bringToTop(overlay);
  sendOverlayState();

  closePopups();
  runDeferredReloads();
  resetIdle();
}

// Today's grid-mode overlay, now behind a key. Panels are not interactive here;
// that is the point, the hotspots need the clicks.
function enterSelect() {
  if (state.mode === 'select') return;
  if (state.mode === 'active' || state.mode === 'edit') dockGrid({ animate: false });
  state = { mode: 'select', activeIndex: -1 };
  overlay.setBounds(wallBounds());
  overlay.setVisible(true);
  bringToTop(overlay);
  sendOverlayState();
  overlay.webContents.focus();
  resetIdle();
  log('select mode: click a panel to open it fullscreen, Esc to cancel');
}

function toggleSelect() {
  if (state.mode === 'select') dockGrid();
  else enterSelect();
}

// The overlay lays out in window pixels, so everything it is told is already
// scaled. Wall units only ever cross this boundary as readout numbers.
function sendOverlayState() {
  if (state.mode === 'edit') {
    overlay.webContents.send('ww:state', {
      mode: 'edit',
      stage: stageBounds(),
      minPx: Math.max(8, Math.round(MIN_PANEL * layout.scale)),
      wall: { width: config.wall.width, height: config.wall.height },
      presets: config.presets.map((p) => ({ id: p.id, name: p.name || p.id })),
      activePresetId,
      views: config.views.map((v, i) => ({
        ...publicView(v, i),
        wallGrid: v.grid,
        zoom: round3(v.zoom),
        url: v.url || '',
        partition: v.partition,
        // Which other panels share this session, so the picker can say so.
        sharedWith: config.views
          .filter((o) => o !== v && o.partition === v.partition)
          .map((o) => o.id),
      })),
    });
    return;
  }
  if (state.mode === 'grid' || state.mode === 'select') {
    overlay.webContents.send('ww:state', {
      mode: state.mode,
      hint: config.showHotspotHint,
      views: config.views.map((v, i) => publicView(v, i)),
    });
    return;
  }
  overlay.webContents.send('ww:state', {
    mode: 'active',
    activeIndex: state.activeIndex,
    id: config.views[state.activeIndex] && config.views[state.activeIndex].id,
  });
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// ---- fullscreen toggle ------------------------------------------------------

// Cmd/Ctrl+F flips between the wall's fullscreen kiosk state and a window, so
// the app can be driven on a dev machine without taking over the display.
//
// Deliberately NOT a globalShortcut: those are OS-level accelerators that fire
// regardless of focus, so registering Cmd+F there would steal find-in-page from
// every other app on the machine. It is handled per view instead, the same way
// Esc is. The tradeoff is that the panels themselves lose Cmd+F find-in-page,
// which is the right call for a kiosk wall.
function isFullscreenToggle(input) {
  return (
    input.type === 'keyDown' &&
    String(input.key).toLowerCase() === 'f' &&
    (input.meta || input.control) &&
    !input.shift &&
    !input.alt
  );
}

// macOS is the awkward one. Measured on Electron 43.4.1 with a 1800x1169
// display (`/tmp/fsprobe1.js`, see docs/validation.md):
//
//   constructor fullscreen+kiosk  ->  content y:39 height:1130   isFullScreen:true
//   constructor kiosk only        ->  content y:39 height:1130   isFullScreen:true
//   constructor fullscreen only   ->  content y:39 height:1130   isFullScreen:true
//   setKiosk(true) after          ->  content y:39 height:1130   isFullScreen:true
//   setSimpleFullScreen(true)     ->  content y:0  height:1169   isSimple:true
//
// Every native fullscreen and kiosk path reports isFullScreen true while
// stopping 39px short of the top, leaving the menu-bar strip uncovered: a black
// gap across the top of the wall, and a layout scaled to fit 1130 instead of
// 1169. Simple fullscreen is the only one that actually owns the display, which
// is what an exhibit needs.
//
// Windows is expected to behave with the normal fullscreen path; that has not
// been verified yet.
function isFullscreenNow() {
  if (!win) return false;
  if (process.platform === 'darwin') return win.isSimpleFullScreen();
  return win.isFullScreen() || win.isKiosk();
}

function applyFullscreen(on) {
  if (!win) return;
  if (process.platform === 'darwin') {
    win.setSimpleFullScreen(on);
    return;
  }
  if (on) {
    win.setFullScreen(true);
    if (config.wall.kiosk) win.setKiosk(true);
  } else {
    if (win.isKiosk()) win.setKiosk(false);
    win.setFullScreen(false);
  }
}

// Cmd/Ctrl+F flips between owning the display and sitting in a window, so the
// app can be driven on a dev machine without taking over the screen.
//
// Deliberately NOT a globalShortcut: those are OS-level accelerators that fire
// regardless of focus, so registering Cmd+F there would steal find-in-page from
// every other app on the machine. It is handled per view instead, the same way
// Esc is. The tradeoff is that the panels lose Cmd+F find-in-page, which is the
// right call for a kiosk wall.
function toggleFullscreen() {
  if (!win) return;

  if (isFullscreenNow()) {
    applyFullscreen(false);
    // frame:false leaves no titlebar to drag, so place the window rather than
    // letting it land wherever. Inset from the display so it reads as windowed.
    const d = pickWallDisplay();
    const fit = Math.min(
      (d.bounds.width * 0.85) / config.wall.width,
      (d.bounds.height * 0.85) / config.wall.height
    );
    const w = Math.round(config.wall.width * fit);
    const h = Math.round(config.wall.height * fit);
    win.setBounds({
      x: d.bounds.x + Math.round((d.bounds.width - w) / 2),
      y: d.bounds.y + Math.round((d.bounds.height - h) / 2),
      width: w,
      height: h,
    });
    log(`windowed at ${w}x${h}`);
  } else {
    applyFullscreen(true);
    log('fullscreen');
  }
  refreshLayout();
  if (state.mode === 'active') activate(state.activeIndex, { force: true });
  else if (overlay) dockGrid({ animate: false });
}

// ---- layout edit mode -------------------------------------------------------
//
// Deliberately a mode rather than always-on handles: in grid mode a click
// promotes a panel, so live handles would both fight that gesture and let a
// visitor wreck the layout. Ctrl/Cmd+Shift+E toggles it.

function enterEdit() {
  if (state.mode === 'edit') return;
  if (state.mode === 'active') dockGrid({ animate: false });
  state = { mode: 'edit', activeIndex: -1 };
  refreshLayout();
  clearIdle(); // never dock the wall out from under someone editing it
  editDrag = null;
  config.views.forEach((v, i) => {
    contentViews[i].setVisible(true);
    contentViews[i].setBounds(panelRect(i));
    contentViews[i].webContents.setZoomFactor(panelZoom(i));
  });
  overlay.setBounds(wallBounds());
  overlay.setVisible(true);
  bringToTop(overlay);
  sendOverlayState();
  overlay.webContents.focus();
  log('layout edit mode: drag to move, sides to resize, corners to scale');
}

function exitEdit({ save = true } = {}) {
  if (state.mode !== 'edit') return;
  editDrag = null;
  if (save) {
    try {
      saveViews(configPath, config.views, config.presets);
      log(`layout saved to ${configPath}`);
    } catch (e) {
      warn('could not save layout:', e.message);
    }
  }
  dockGrid({ animate: false });
}

function toggleEdit() {
  if (state.mode === 'edit') exitEdit();
  else enterEdit();
}

function activate(index, { force = false } = {}) {
  const v = config.views[index];
  if (!v) return;
  // force is used by relayout, which must re-apply bounds for the mode we are
  // already in.
  if (!force && state.mode === 'active' && state.activeIndex === index) return;
  refreshLayout();
  state = { mode: 'active', activeIndex: index };
  lastEscAt = 0;

  // NOTE: do NOT reload here. Not because it would log anyone out: cookies live
  // in the persist: partition and survive a reload (measured, see
  // src/dev/session-probe.js). It would throw away in-page state, which is what
  // actually hurts: a half-typed form, an SSO redirect chain in flight, wherever
  // an SPA had been navigated to.
  setBounds(contentViews[index], stageBounds(), !force);
  contentViews[index].webContents.setZoomFactor(panelZoom(index));
  bringToTop(contentViews[index]);

  if (config.hideInactiveWhenActive) {
    contentViews.forEach((view, i) => {
      if (i !== index) view.setVisible(false);
    });
  }

  // Keep the overlay on top but shrink it to the Back button corner so the rest
  // of the page below is directly clickable.
  overlay.setBounds(scaleRect(config.backButton));
  overlay.setVisible(true);
  bringToTop(overlay);
  sendOverlayState();

  // Without this the wireless keyboard has no target: Esc and any login typing
  // would go nowhere.
  contentViews[index].webContents.focus();

  resetIdle();
}

// ---- idle auto-return -------------------------------------------------------

function resetIdle() {
  clearIdle();
  // Armed in grid too, not just active: with interactive panels the grid is
  // where people work, so that is where a wall gets left mid-something.
  if (config.idleReturnMs > 0 && state.mode !== 'edit') {
    idleTimer = setTimeout(() => idleReset(), config.idleReturnMs);
  }
}

// Return to the grid when the wall has been left alone, so a panel someone
// promoted does not stay fullscreen forever.
//
// Putting the URLs back is opt-in (idleResetUrls) rather than part of this,
// because only administrators have input: the wall is idle almost all the time,
// so an automatic reload would be a scheduled logout for every logged-in
// dashboard.
function idleReset() {
  const wasGrid = state.mode === 'grid';
  if (!wasGrid) dockGrid();

  if (!config.idleResetUrls) return;
  config.views.forEach((v, i) => {
    const current = contentViews[i].webContents.getURL();
    const target = v.url || placeholderURL(v);
    if (current === target) return;
    log(`idle: returning ${v.id} to its configured URL`);
    contentViews[i].webContents.loadURL(target);
  });
  touched.clear();
}

function clearIdle() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

// ---- navigation policy ------------------------------------------------------

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Absent or empty allowedOrigins means permissive, which is today's behavior
// and the right default while the real Honeywell domains are unknown. Populate
// it in config to enforce; no code change needed then.
function isAllowed(v, url) {
  const list = v.allowedOrigins;
  if (!Array.isArray(list) || list.length === 0) return true;
  const origin = originOf(url);
  return !!origin && list.includes(origin);
}

// ---- per-view hardening -----------------------------------------------------

// The one place the Esc policy lives, so the per-view key handler and the
// overlay cannot disagree. Returns true when the wall consumed the key, meaning
// the page must not also see it.
function handleEscape() {
  if (state.mode === 'select') {
    dockGrid();
    return true;
  }
  if (state.mode !== 'active') return false;
  const mode = config.escToGrid;
  if (mode === 'off') return false;
  if (mode === 'single') {
    dockGrid();
    return true;
  }
  // "double": let the first Esc through so the page can close its own modal,
  // and dock on a quick second press.
  const now = Date.now();
  if (now - lastEscAt < config.escDoubleMs) {
    lastEscAt = 0;
    dockGrid();
    return true;
  }
  lastEscAt = now;
  return false;
}

function hardenView(view, v) {
  const wc = view.webContents;
  // Resolved on each call, never captured. Panels can be deleted, which shifts
  // every later index, and these handlers outlive that. The spec object's
  // identity is stable, so it is the reliable key.
  const idx = () => config.views.indexOf(v);

  wc.on('before-input-event', (event, input) => {
    if (isFullscreenToggle(input)) {
      event.preventDefault();
      toggleFullscreen();
      return;
    }
    if (state.mode !== 'active' || state.activeIndex !== idx()) return;
    resetIdle();
    if (input.type !== 'keyDown' || input.key !== 'Escape') return;
    if (handleEscape()) event.preventDefault();
  });

  // Auth / SSO popups: allow them in a real, closable window so login works.
  wc.setWindowOpenHandler(({ url }) => {
    if (!isAllowed(v, url)) {
      warn(`blocked popup to ${url} from ${v.id} (not in allowedOrigins)`);
      return { action: 'deny' };
    }
    // On a frameless kiosk wall an unplaced popup can land off-wall or behind
    // the content views, where nobody can finish the login.
    const w = Math.min(720, layout.width - 80);
    const h = Math.min(860, layout.height - 80);
    return {
      action: 'allow',
      overrides: {
        parent: win,
        modal: false,
        frame: true,
        autoHideMenuBar: true,
        width: w,
        height: h,
        x: Math.round((layout.width - w) / 2),
        y: Math.round((layout.height - h) / 2),
        webPreferences: {
          partition: v.partition,
          // Same activity reporter the content views use. Without it, typing a
          // password into an SSO popup would not count as activity, and the
          // idle timer would dock the wall and close the popup mid-login.
          preload: path.join(__dirname, 'content-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      },
    };
  });

  wc.on('did-create-window', (child) => {
    popups.add(child);
    child.on('closed', () => popups.delete(child));
  });

  wc.on('will-navigate', (event, url) => {
    if (!isAllowed(v, url)) {
      warn(`blocked navigation to ${url} in ${v.id} (not in allowedOrigins)`);
      event.preventDefault();
    }
  });

  // Watchdog: reload on crash / failed main-frame load, with backoff.
  wc.on('render-process-gone', (_e, details) => {
    warn(`${v.id} render process gone:`, details && details.reason);
    scheduleReload(view, v);
  });
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    // -3 is ERR_ABORTED, which a normal redirect or a cancelled load produces.
    if (!isMainFrame || code === -3) return;
    warn(`${v.id} failed to load ${url}: ${desc} (${code})`);
    scheduleReload(view, v);
  });
  // 'unresponsive' is deliberately NOT a reload trigger: a slow enterprise
  // dashboard is not a crashed one, and reloading would drop the session.
  wc.on('unresponsive', () => warn(`${v.id} is unresponsive (not reloading)`));
  wc.on('did-finish-load', () => {
    const w = watchdog.get(v.id);
    if (w) w.attempts = 0;
  });
}

function wd(id) {
  if (!watchdog.has(id)) watchdog.set(id, { attempts: 0, pending: null, deferred: false });
  return watchdog.get(id);
}

function scheduleReload(view, v) {
  const w = wd(v.id);
  if (w.pending) return; // one in-flight reload per view

  // Never reload a panel somebody is using. The session itself would survive
  // (see src/dev/session-probe.js), but the interaction in progress would not:
  // credentials half typed, an SSO redirect chain mid-flight, an SPA's current
  // view. That used to mean only the promoted panel, but with an interactive
  // grid someone can be signing in without promoting anything, so recent input
  // counts too.
  const promoted = state.mode === 'active' && state.activeIndex === config.views.indexOf(v);
  const recent = Date.now() - (touched.get(v.id) || 0) < config.recentUseMs;
  if (promoted || recent) {
    if (!w.deferred) {
      log(`deferring reload of ${v.id}: ${promoted ? 'it is promoted' : 'in use just now'}`);
    }
    w.deferred = true;
    return;
  }

  w.attempts += 1;
  const delay = Math.min(30000, 1000 * 2 ** w.attempts);
  log(`reloading ${v.id} in ${delay}ms (attempt ${w.attempts})`);
  w.pending = setTimeout(() => {
    w.pending = null;
    try {
      view.webContents.loadURL(v.url);
    } catch {
      /* window torn down */
    }
  }, delay);
}

function runDeferredReloads() {
  config.views.forEach((v, i) => {
    const w = watchdog.get(v.id);
    if (!w || !w.deferred) return;
    // Still in use: leave it deferred rather than reloading under them. The
    // idle timer and the next dock will both come back around.
    if (Date.now() - (touched.get(v.id) || 0) < config.recentUseMs) return;
    w.deferred = false;
    scheduleReload(contentViews[i], v);
  });
}

function closePopups() {
  for (const p of popups) {
    if (!p.isDestroyed()) p.close();
  }
  popups.clear();
}

// ---- IPC from the overlay ---------------------------------------------------

ipcMain.on('ww:activate', (_e, id) => {
  if (state.mode !== 'select') return; // grid panels are interactive; nothing to intercept
  const i = config.views.findIndex((v) => v.id === id);
  if (i >= 0) activate(i);
});

// From the editor's inspector, which is the other way to open a panel.
ipcMain.on('ww:promote', (_e, id) => {
  const i = config.views.findIndex((v) => v.id === id);
  if (i >= 0) activate(i);
});
ipcMain.on('ww:back', () => {
  if (state.mode === 'active') dockGrid();
});
ipcMain.on('ww:escape', () => handleEscape());
ipcMain.on('ww:toggleFullscreen', () => toggleFullscreen());
// Panels report their own input. Which panel it came from now matters: it gives
// the keyboard a target, keeps the watchdog off a panel being used, and keeps
// the idle timer from resetting the wall under someone.
ipcMain.on('ww:activity', (e, type) => {
  const i = contentViews.findIndex(
    (view) => !view.webContents.isDestroyed() && view.webContents === e.sender
  );
  if (i >= 0) {
    touched.set(config.views[i].id, Date.now());
    // Grid-mode input is otherwise completely silent, which makes "do clicks
    // land in the right panel" impossible to check except by eye. Mousemove is
    // left out: it would drown everything else.
    if (LOG_INPUT && type !== 'mousemove') {
      log(`input: ${type} -> ${config.views[i].id} (${state.mode} mode)`);
    }
    // Clicking a sibling WebContentsView is not guaranteed to move focus to it,
    // and without focus the wireless keyboard has no target. Doing it here is a
    // no-op when the platform already did it.
    if (type === 'mousedown') e.sender.focus();
  }
  resetIdle();
});

// ---- IPC: layout editing ----------------------------------------------------

function indexOfId(id) {
  return config.views.findIndex((v) => v.id === id);
}

// Snapshot the panel as the drag begins. A corner scale needs the ratio against
// where the drag started, not against the previous frame, or the rounding
// compounds over a long drag.
ipcMain.on('ww:dragStart', (_e, id) => {
  if (state.mode !== 'edit') return;
  const i = indexOfId(id);
  if (i < 0) return;
  editDrag = { i, baseGrid: { ...config.views[i].grid }, baseZoom: config.views[i].zoom };
});

ipcMain.on('ww:dragEnd', () => {
  if (editDrag) {
    const v = config.views[editDrag.i];
    log(
      `${v.id}: ${v.grid.width}x${v.grid.height} at ${v.grid.x},${v.grid.y} ` +
        `zoom ${round3(v.zoom)} (wall units)`
    );
  }
  editDrag = null;
});

// rect arrives in window pixels. kind is 'move' | 'resize' | 'scale'.
ipcMain.on('ww:layout', (_e, msg) => {
  if (state.mode !== 'edit' || !msg) return;
  const i = indexOfId(msg.id);
  if (i < 0) return;
  const v = config.views[i];

  // Only the dimensions the gesture actually drives are taken from the pointer.
  // The rest are pinned to the drag baseline, because converting window pixels
  // back to wall units loses a unit or two, and these numbers get written to
  // config: a side drag that quietly shifted 1080 to 1079 would accumulate
  // drift every time the layout was touched.
  const g = unscaleRect(msg.rect);
  const base = editDrag && editDrag.i === i ? editDrag.baseGrid : null;
  if (base) {
    if (msg.kind === 'move') {
      g.width = base.width;
      g.height = base.height;
    } else if (msg.kind === 'resize' && msg.axis === 'x') {
      g.y = base.y;
      g.height = base.height;
    } else if (msg.kind === 'resize' && msg.axis === 'y') {
      g.x = base.x;
      g.width = base.width;
    } else if (msg.kind === 'scale') {
      // Keep the authored aspect ratio exact rather than whatever survived the
      // pixel round trip.
      g.height = Math.round((g.width * base.height) / base.width);
    }
  }
  const wall = { width: config.wall.width, height: config.wall.height };
  v.grid = clampGrid(
    snapGrid(g, {
      views: config.views,
      index: i,
      wall,
      // The residual error from pixel snapping is at most one window pixel, so
      // the tolerance is that pixel expressed in wall units.
      tolerance: Math.max(2, Math.ceil(2 / (layout.scale || 1))),
      kind: msg.kind,
      handle: msg.handle,
    }),
    wall,
    MIN_PANEL
  );

  // A corner drag is a scale: the page content tracks the frame, the way
  // scaling an image does. A side drag is a resize: the frame changes on one
  // axis and the page reflows into the new viewport, zoom untouched.
  if (msg.kind === 'scale' && editDrag && editDrag.i === i && editDrag.baseGrid.width > 0) {
    v.zoom = round3(editDrag.baseZoom * (v.grid.width / editDrag.baseGrid.width));
  }

  contentViews[i].setBounds(panelRect(i));
  contentViews[i].webContents.setZoomFactor(panelZoom(i));
  overlay.webContents.send('ww:layoutEcho', {
    id: v.id,
    grid: v.grid,
    zoom: round3(v.zoom),
    rect: panelRect(i),
  });
});

ipcMain.on('ww:editExit', (_e, opts) => exitEdit({ save: !(opts && opts.discard) }));

ipcMain.on('ww:applyPreset', (_e, id) => applyPreset(id));
ipcMain.on('ww:savePreset', (_e, name) => {
  if (savePreset(name)) sendOverlayState();
});
ipcMain.on('ww:deletePreset', (_e, id) => {
  deletePreset(id);
  sendOverlayState();
});

ipcMain.on('ww:addPanel', (_e, rect) => {
  if (state.mode !== 'edit' || !rect) return;
  const v = addPanel(unscaleRect(rect));
  bringToTop(overlay);
  sendOverlayState();
  // Tell the overlay which panel to select, so the inspector opens on the thing
  // that was just created and the URL field is ready to type into.
  overlay.webContents.send('ww:select', v.id);
});

ipcMain.on('ww:deletePanel', (_e, id) => {
  if (state.mode !== 'edit') return;
  deletePanel(id);
  bringToTop(overlay);
  sendOverlayState();
});

ipcMain.on('ww:updatePanel', (_e, msg) => {
  if (state.mode !== 'edit' || !msg) return;
  updatePanel(msg.id, msg.patch || {});
  sendOverlayState();
  overlay.webContents.send('ww:select', msg.id);
});

// Dev-only smoke test for panel CRUD. Nothing in src/main.js has unit tests, it
// imports electron at module scope, so this drives the real path instead: the
// overlay's bridge, over IPC, into the same handlers a click would reach.
//
//   WALLWRIGHT_DEV=1 WALLWRIGHT_SELFTEST=1 npm start
function selfTest() {
  // step() reports; check() decides. The first version only logged, so an
  // assertion that went false printed "false" into a log nobody reads and the
  // run still looked fine. A smoke test that cannot fail is not a test.
  const failures = [];
  const step = (n, msg) => log(`selftest ${n}: ${msg}`);
  const check = (n, label, ok) => {
    log(`selftest ${n}: ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    if (!ok) failures.push(`${n}: ${label}`);
  };
  const ids = () => config.views.map((v) => v.id).join(',');
  const run = (js) => overlay.webContents.executeJavaScript(js, true);
  const soon = (ms) => new Promise((r) => setTimeout(r, ms));

  // Wait for a condition rather than sleeping a guessed amount. On a shared
  // build runner a fixed sleep is a coin toss, and a smoke test that fails at
  // random is worse than none: people learn to ignore it.
  const until = async (fn, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fn()) return true;
      await soon(100);
    }
    return false;
  };

  (async () => {
    enterEdit();
    await soon(400);
    const before = config.views.length;
    step(1, `start with ${before} panels: ${ids()}`);

    await run(`window.wallwright.addPanel({ x: 40, y: 700, width: 500, height: 300 })`);
    await until(() => config.views.length === before + 1);
    const added = config.views[config.views.length - 1];
    step(2, `after add: ${config.views.length} panels: ${ids()}`);
    step(
      2,
      `new panel partition ${added.partition}, url "${added.url}" (placeholder expected)`
    );

    await run(
      `window.wallwright.updatePanel(${JSON.stringify(added.id)}, { url: 'https://example.com/', label: 'Added by selftest' })`
    );
    await until(() => added.url === 'https://example.com/');
    check(
      3,
      'url and label applied',
      added.url === 'https://example.com/' && added.label === 'Added by selftest'
    );

    // The interesting one: sharing a session rebuilds the view, because a
    // partition can only be chosen when a WebContentsView is created.
    const target = config.views[0];
    await run(
      `window.wallwright.updatePanel(${JSON.stringify(added.id)}, { partition: ${JSON.stringify(target.partition)} })`
    );
    await until(() => added.partition === target.partition);
    const sharers = config.views
      .filter((v) => v.partition === target.partition)
      .map((v) => v.id);
    step(4, `after sharing session: ${target.partition} used by ${sharers.join(' + ')}`);
    check(4, 'view count still matches config', contentViews.length === config.views.length);

    await run(`window.wallwright.updatePanel(${JSON.stringify(added.id)}, { zoom: 0.5 })`);
    await until(() => added.zoom === 0.5);
    check(5, 'zoom applied', added.zoom === 0.5);

    await run(`window.wallwright.deletePanel(${JSON.stringify(added.id)})`);
    await until(() => config.views.length === before);
    step(6, `after delete: ${config.views.length} panels: ${ids()}`);
    check(6, 'views and config still aligned', contentViews.length === config.views.length);
    check(6, 'back to the starting count', config.views.length === before);

    // Overlay must still be frontmost after all that churn, or the wall stops
    // responding to clicks.
    const kids = win.contentView.children;
    check(7, 'overlay still frontmost', kids[kids.length - 1] === overlay);

    // Whether the overlay is showing is exactly what decides if the panels can
    // be interacted with, so it is worth asserting per mode rather than
    // discovering it at the wall.
    const vis = () => overlay.getVisible();
    const full = () => {
      const b = overlay.getBounds();
      return b.width === layout.width && b.height === layout.height;
    };

    dockGrid({ animate: false });
    await soon(300);
    check(8, 'grid: overlay hidden, so panels are interactive', vis() === false);

    enterSelect();
    await soon(300);
    check(8, 'select: overlay shown, full wall', vis() && full());

    activate(0);
    await soon(400);
    check(8, 'active: overlay shown, shrunk to the back button', vis() && !full());

    dockGrid({ animate: false });
    await soon(300);
    check(8, 'back to grid: overlay hidden again', vis() === false);

    enterEdit();
    await soon(300);
    check(8, 'edit: overlay shown, full wall', vis() && full());
    exitEdit({ save: false });
    await soon(300);

    // Presets: save the current montage, change it, recall it, and confirm the
    // panels that did not change were reused rather than rebuilt.
    enterEdit();
    await soon(300);
    await run(`window.wallwright.savePreset('Selftest A')`);
    await until(() => config.presets.length === 1);
    step(9, `saved: ${config.presets.map((p) => p.id).join(',')}`);

    const beforeIds = ids();
    await run(`window.wallwright.addPanel({ x: 20, y: 20, width: 400, height: 300 })`);
    await until(() => ids() !== beforeIds);
    step(9, `montage changed: ${ids()}`);

    await run(`window.wallwright.applyPreset('selftest-a')`);
    await until(() => ids() === beforeIds);
    step(9, `after recall: ${ids()}`);
    check(9, 'recall matches the saved montage', ids() === beforeIds);
    check(
      9,
      'views and config aligned after recall',
      contentViews.length === config.views.length
    );

    await run(`window.wallwright.deletePreset('selftest-a')`);
    await until(() => config.presets.length === 0);
    check(9, 'preset deleted', config.presets.length === 0);
    exitEdit({ save: false });
    await soon(300);

    // Upkeep. The safety rule is the whole point: a timer must never reload a
    // panel under someone's hands.
    dockGrid({ animate: false });
    await soon(300);
    const upkeepPanel = config.views[0];
    const realRecentUse = config.recentUseMs;
    upkeepPanel.refreshMs = 1200;
    lastRefresh.delete(upkeepPanel.id);
    touched.delete(upkeepPanel.id);
    startUpkeep();

    // "In use" is driven through recentUseMs rather than by clearing touched,
    // because the pages report every mousemove. With a pointer resting over the
    // window this test otherwise depends on where the mouse happens to be: the
    // panel stays perpetually in use and the refresh never fires. That is the
    // right behaviour, and a lousy thing to hang a test on.
    config.recentUseMs = 0; // nothing counts as recent, so the panel is idle
    check(
      10,
      'idle panel refreshed on its timer',
      await until(() => lastRefresh.has(upkeepPanel.id))
    );

    // Now claim it is being used, and confirm the timer leaves it alone.
    const refreshedAt = lastRefresh.get(upkeepPanel.id);
    config.recentUseMs = 60000;
    touched.set(upkeepPanel.id, Date.now());
    // A fixed wait on purpose: this asserts that nothing happened, so there is
    // no condition to poll for. Comfortably longer than the 1200ms interval.
    await soon(4000);
    check(10, 'in-use panel left alone', lastRefresh.get(upkeepPanel.id) === refreshedAt);

    // And that it resumes once the panel goes quiet again.
    config.recentUseMs = 0;
    check(
      10,
      'refresh resumes once the panel is quiet',
      await until(() => lastRefresh.get(upkeepPanel.id) !== refreshedAt)
    );

    // Recycling swaps the view for a new one, which is how the renderer process
    // is actually handed back.
    const viewBeforeRecycle = contentViews[0];
    upkeepPanel.refreshMs = 0;
    upkeepPanel.recycleMs = 1200;
    lastRecycle.delete(upkeepPanel.id);
    touched.delete(upkeepPanel.id);
    check(
      10,
      'recycle replaced the view',
      await until(() => contentViews[0] !== viewBeforeRecycle)
    );
    check(
      10,
      'views and config aligned after recycle',
      contentViews.length === config.views.length
    );
    const kids2 = win.contentView.children;
    check(10, 'overlay still frontmost after recycling', kids2[kids2.length - 1] === overlay);

    upkeepPanel.recycleMs = 0;
    config.recentUseMs = realRecentUse;
    startUpkeep();
    checkMemory();

    if (failures.length) {
      warn(`selftest FAILED (${failures.length}): ${failures.join('; ')}`);
    } else {
      log('selftest passed');
    }
    // Exit with a code, so this can gate anything rather than only being read.
    app.exit(failures.length ? 1 : 0);
  })().catch((e) => {
    warn('selftest threw:', e.message);
    app.exit(1);
  });
}

// Dev-only: render the wall and write a single PNG of it, then quit.
//
// Captures each panel from its own webContents and the overlay on top, then
// composites them at their wall coordinates. That means it needs no OS
// screen-recording permission, so it works where `screencapture` cannot run at
// all: a terminal without that permission, a CI runner, a headless show PC. It
// also captures the editor, which an OS screenshot of a kiosk window can only do
// if someone is standing there.
//
//   WALLWRIGHT_DEV=1 WALLWRIGHT_CAPTURE_OUT=./wall.png npm start
async function captureWall(outPath) {
  const dpr = Number(process.env.WALLWRIGHT_CAPTURE_DPR || 1);
  const shots = [];

  for (let i = 0; i < contentViews.length; i++) {
    const img = await contentViews[i].webContents.capturePage();
    shots.push({ rect: panelRect(i), data: img.toDataURL() });
  }
  // The overlay last, so it lands on top the way it does on the wall. In grid
  // mode it is invisible; in edit mode it is the whole point of the picture.
  const ov = await overlay.webContents.capturePage();
  shots.push({ rect: overlay.getBounds(), data: ov.toDataURL() });

  const comp = new BrowserWindow({ show: false, width: 64, height: 64 });
  await comp.loadURL('data:text/html,<canvas id="c"></canvas>');
  const png = await comp.webContents.executeJavaScript(
    `(async () => {
      const shots = ${JSON.stringify(shots)};
      const dpr = ${dpr};
      const c = document.getElementById('c');
      c.width = ${layout.width} * dpr;
      c.height = ${layout.height} * dpr;
      const ctx = c.getContext('2d');
      ctx.fillStyle = ${JSON.stringify(config.wall.backgroundColor || '#000000')};
      ctx.fillRect(0, 0, c.width, c.height);
      for (const s of shots) {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = s.data; });
        ctx.drawImage(img, s.rect.x * dpr, s.rect.y * dpr, s.rect.width * dpr, s.rect.height * dpr);
      }
      return c.toDataURL('image/png');
    })()`,
    true
  );

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(png.split(',')[1], 'base64'));
  const kb = Math.round(fs.statSync(outPath).size / 1024);
  log(`captured ${outPath} (${layout.width * dpr}x${layout.height * dpr}, ${kb}KB)`);
}

// Wait for the pages to load and settle, then capture and exit.
function scheduleCapture(outPath) {
  const settle = Number(process.env.WALLWRIGHT_CAPTURE_SETTLE || 7000);
  const timeout = Number(process.env.WALLWRIGHT_CAPTURE_LOAD_TIMEOUT || 25000);

  const loaded = contentViews.map(
    (view, i) =>
      new Promise((res) => {
        if (!view.webContents.isLoading()) return res();
        view.webContents.once('did-stop-loading', () => {
          log(`loaded ${config.views[i].id}`);
          res();
        });
        setTimeout(res, timeout);
      })
  );

  Promise.all(loaded)
    .then(() => new Promise((r) => setTimeout(r, settle)))
    .then(() => captureWall(outPath))
    .then(() => app.exit(0))
    .catch((e) => {
      warn('capture failed:', e.message);
      app.exit(1);
    });
}

// ---- control surface --------------------------------------------------------

let controlServer = null;

// Everything an administrator can see about the wall without standing at it.
function wallStatus() {
  const now = Date.now();
  let memoryMb = 0;
  try {
    for (const m of app.getAppMetrics()) {
      memoryMb += (m.memory && m.memory.workingSetSize ? m.memory.workingSetSize : 0) / 1024;
    }
  } catch {
    /* metrics unavailable */
  }

  return {
    mode: state.mode,
    activePanel: state.activeIndex >= 0 ? config.views[state.activeIndex].id : null,
    activePreset: activePresetId,
    uptimeSec: Math.round((now - startedAt) / 1000),
    memoryMb: Math.round(memoryMb),
    wall: { width: config.wall.width, height: config.wall.height, scale: round3(layout.scale) },
    presets: config.presets.map((p) => ({ id: p.id, name: p.name || p.id })),
    panels: config.views.map((v, i) => {
      const wc = contentViews[i] && contentViews[i].webContents;
      const w = watchdog.get(v.id) || {};
      return {
        id: v.id,
        label: v.label || '',
        url: v.url || '',
        // Where it actually is, which is the point of a status page: a panel
        // that has been navigated away shows it here.
        currentUrl: wc && !wc.isDestroyed() ? wc.getURL() : null,
        grid: v.grid,
        zoom: round3(v.zoom),
        partition: v.partition,
        loading: wc && !wc.isDestroyed() ? wc.isLoading() : null,
        crashed: wc ? wc.isDestroyed() : true,
        reloadAttempts: w.attempts || 0,
        reloadDeferred: !!w.deferred,
        lastUsedSecAgo: touched.has(v.id) ? Math.round((now - touched.get(v.id)) / 1000) : null,
      };
    }),
  };
}

const controlActions = {
  status: wallStatus,
  page: () => statusPage(),
  applyPreset: (id) => {
    if (!findPreset(id)) return false;
    applyPreset(id);
    return true;
  },
  updatePanel: (id, patch) => {
    if (indexOfId(id) < 0) return false;
    updatePanel(id, patch);
    return true;
  },
  promote: (id) => {
    if (id === null) {
      dockGrid();
      return true;
    }
    const i = indexOfId(id);
    if (i < 0) return false;
    activate(i);
    return true;
  },
  // Explicitly asked for, so it is allowed to interrupt someone: unlike the
  // watchdog, a person pressed this.
  reload: (id) => {
    const targets = id === null ? config.views.map((_v, i) => i) : [indexOfId(id)];
    if (targets.some((i) => i < 0)) return false;
    targets.forEach((i) => {
      const v = config.views[i];
      log(`reload requested for ${v.id}`);
      contentViews[i].webContents.loadURL(v.url || placeholderURL(v));
    });
    return true;
  },
};

function startControlServer() {
  const { port, host } = config.control;
  if (!port) return;

  controlServer = createControlServer(controlActions, { log: warn });
  controlServer.on('error', (e) => warn(`control server: ${e.message}`));
  controlServer.listen(port, host, () => {
    const bound = controlServer.address();
    log(`control surface on http://${host}:${bound.port}`);
    if (host !== '127.0.0.1' && host !== 'localhost') {
      warn(
        `the control surface is reachable at ${host} and has no authentication. ` +
          'Anyone who can reach it can drive the wall.'
      );
    }
  });
}

// ---- lockdown + lifecycle ---------------------------------------------------

function registerShortcuts() {
  // Deliberate admin exit.
  globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());
  // Layout edit mode. Not dev-only: this is how the layout gets tuned at the
  // wall, against the real dashboards, without editing JSON on site.
  globalShortcut.register('CommandOrControl+Shift+E', () => toggleEdit());
  // Panels are interactive in grid mode, so promoting one needs its own mode
  // rather than a click that would otherwise land on the page.
  globalShortcut.register('CommandOrControl+Shift+P', () => toggleSelect());
  // Recall a montage by number, without opening the editor. Registered for all
  // nine whether or not that many presets exist; the handler just does nothing.
  for (let n = 1; n <= 9; n++) {
    globalShortcut.register(`CommandOrControl+Shift+${n}`, () => {
      const preset = config.presets[n - 1];
      if (preset) applyPreset(preset.id);
      else log(`no preset ${n}`);
    });
  }
  // NOTE: Esc is intentionally NOT a globalShortcut. globalShortcut is an
  // OS-level accelerator: it fires regardless of focus and swallows the key
  // before the page sees it, which would break every Esc-to-close modal in the
  // dashboards. Esc is handled per view in hardenView() instead.
  if (DEV) {
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      const i = state.activeIndex;
      const target = i >= 0 ? contentViews[i] : overlay;
      target.webContents.openDevTools({ mode: 'detach' });
    });
    globalShortcut.register('CommandOrControl+Shift+G', () => dockGrid());
  }
}

// A malformed config or a missing display should show something readable on the
// wall, not die with a stack trace.
function showFatal(message) {
  const w = new BaseWindow({ width: 900, height: 520, backgroundColor: '#0d1117' });
  const v = new WebContentsView();
  w.contentView.addChildView(v);
  v.setBounds({ x: 0, y: 0, width: 900, height: 520 });
  const html = `<body style="margin:0;padding:32px;background:#0d1117;color:#e6edf3;
    font:14px/1.5 ui-monospace,Menlo,monospace">
    <h1 style="font:600 20px sans-serif;color:#f04e23;margin:0 0 16px">${APP_NAME} cannot start</h1>
    <pre style="white-space:pre-wrap">${escapeHtml(message)}</pre>
    <p style="color:#8b949e">Config: ${escapeHtml(configPath)}</p></body>`;
  v.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  console.error('[wallwright] fatal:', message);
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// Two copies would fight over the wall.
if (!app.requestSingleInstanceLock()) {
  console.error('[wallwright] another instance is already running; exiting');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) win.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    try {
      configPath = resolveConfigPath();
      config = loadConfig(configPath);
    } catch (e) {
      return showFatal(e.message);
    }
    log(
      `config ${configPath}: ${config.views.length} views on a ` +
        `${config.wall.width}x${config.wall.height} wall`
    );
    createWall();
    registerShortcuts();

    // An LED controller can enumerate outputs late at boot, so re-target rather
    // than sitting on the wrong display for the rest of the show.
    const retarget = () => {
      if (!win) return;
      const d = pickWallDisplay();

      if (isFullscreenNow()) {
        // Already owning a display, so do not force the window to wall size:
        // that fights the fullscreen state, and entering fullscreen itself
        // fires display-metrics-changed. Only act when it is on the wrong
        // output, which means dropping out, relocating, and going back in.
        const b = win.getBounds();
        if (b.x !== d.bounds.x || b.y !== d.bounds.y) {
          log(`moving the wall to display "${d.label}" (id ${d.id})`);
          applyFullscreen(false);
          win.setBounds({
            x: d.bounds.x,
            y: d.bounds.y,
            width: d.bounds.width,
            height: d.bounds.height,
          });
          applyFullscreen(true);
        }
      } else {
        win.setBounds({
          x: d.bounds.x,
          y: d.bounds.y,
          width: config.wall.width,
          height: config.wall.height,
        });
      }
      // The relayout is left to the debounced resize handler, so a burst of
      // display events collapses into one pass.
    };
    screen.on('display-added', retarget);
    screen.on('display-removed', retarget);
    screen.on('display-metrics-changed', retarget);
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (controlServer) controlServer.close();
});
app.on('window-all-closed', () => app.quit());
