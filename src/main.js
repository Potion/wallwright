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
const os = require('os');
const crypto = require('crypto');
const { loadConfig, saveViews } = require('./config');
const { clampGrid, snapGrid } = require('./layout');
const { createControlServer } = require('./control-server');
const { statusPage } = require('./control-page');
const { createDiagLog } = require('./diag-log');
const { createCounters } = require('./counters');
const {
  classifyActivity,
  deferralExpired,
  ineligibleReason,
  memoryPlan,
  staggerSeeds,
} = require('./upkeep');

// The app was called Forge before it was Wallwright. The name decides the
// userData folder, so renaming it orphans the tuned layout and every login;
// migrateLegacyUserData() below carries them across on first run.
const APP_NAME = 'Wallwright';
const LEGACY_APP_NAME = 'Forge';

// Names this run of the process. It appears in the log banner and in
// /api/status, which is how a sampler tells "still the same run" from "it died
// and came back" without inferring it from an uptime that went backwards.
const RUN_ID = crypto.randomBytes(4).toString('hex');

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

// Diagnostics on disk. Opened here, and the position is not arbitrary: it has to
// be after setName(), which decides userData (otherwise a dev run writes into an
// "Electron" folder), and before resolveConfigPath(), because a config that fails
// to parse is exactly the failure worth having on disk.
//
// That second constraint is why the directory cannot come from the config file.
// WALLWRIGHT_LOG_DIR overrides it for a soak run; a config key may only ever turn
// the log off, never move it.
const diag = createDiagLog({ dir: process.env.WALLWRIGHT_LOG_DIR || null });
function openDiagLog() {
  const dir = process.env.WALLWRIGHT_LOG_DIR || path.join(app.getPath('userData'), 'logs');
  const file = diag.open(dir);
  if (file) log(`diagnostics log: ${file}`);
  return file;
}

const BUNDLED_CONFIG = path.join(__dirname, '..', 'config', 'wall.json');
// The source image electron-builder turns into the platform icons at packaging
// time. Nothing reads it at runtime in a shipped build, which is why a dev run
// otherwise shows the Electron logo.
const DEV_ICON = path.join(__dirname, '..', 'build', 'icon.png');

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

// Carry a previous install's state across the rename from Forge to Wallwright.
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
// Counts and peaks that only go up, for the whole life of the process. Everything
// else reported by /api/status is instantaneous, which answers nothing about a
// weekend. Declared here rather than beside the memory code because the watchdog
// and the panel lifecycle write to it too.
const counters = createCounters({ warn });
// The last 20 recycles, with what each one reclaimed. Reported by /api/status so
// a sampler can see whether recycling is working without parsing the log.
const recycleProbes = [];
// Short in the self-test, which cannot afford to wait 30 seconds, and set from
// measurement rather than taste: see the probe answers in docs/validation.md.
const RECYCLE_PROBE_MS = Number(process.env.WALLWRIGHT_RECYCLE_PROBE_MS || 3000);
const RECYCLE_PROBE_LATE_MS = Number(process.env.WALLWRIGHT_RECYCLE_PROBE_LATE_MS || 30000);
const touched = new Map(); // view id -> ms of the last INTERACTION in that panel
// Pointer motion, kept separately and deliberately doing much less work. A mouse
// left resting on an animated dashboard reports motion for as long as the content
// moves, because Chromium dispatches synthetic moves under a stationary cursor,
// so this can never be allowed to defer upkeep. It is reported in status, and it
// is the one thing that blocks a relaunch, on the grounds that a wall should not
// vanish while somebody is demonstrably standing at it.
const present = new Map(); // view id -> ms of the last pointer motion
// Which panel opened each SSO popup. `popups` alone could not answer that, so
// rebuilding the opener mid-login was possible.
const popupOwner = new Map(); // BrowserWindow -> view id
// When upkeep first wanted to do something it could not, per panel and operation,
// so a deferral can expire instead of lasting forever.
const deferredSince = new Map(); // `${id}:${op}` -> ms
// The most recent per-process reading, so ranking candidates by weight does not
// mean asking the OS again for every panel on every tick.
let lastMemoryByPid = new Map();
// State the memory ladder keeps between checks. All of it resets the moment the
// total comes back under the limit.
let memoryPressureSince = null; // when the limit was first exceeded, unbroken
let memoryHardChecks = 0; // consecutive checks past the hard limit
let memorySweptAt = null; // when the whole wall was last rebuilt at once
let recyclesSinceReduction = 0; // rebuilds that did not reclaim anything
let pendingReduction = null; // the total before the last rebuild, to compare
let memoryExhaustedSaid = false; // so "nothing left to try" is said once
// Survives a relaunch through argv, which is the only place to keep it: a file
// would outlive the condition, and a counter that resets on restart is no bound
// at all.
let relaunchCount = Number(
  (process.argv.find((a) => a.startsWith('--ww-relaunch-count=')) || '').split('=')[1] || 0
);

// Console and file, not one or the other. `npm run dev` and `npm run selftest`
// are read off stdout, and CI reads the same stream, so removing it would buy
// nothing. The file exists because on Windows stdout is not there at all.
function log(...args) {
  console.log('[wallwright]', ...args);
  diag.write('info', ...args);
}
function warn(...args) {
  console.warn('[wallwright]', ...args);
  diag.write('warn', ...args);
}
// For the lines that explain why the app is not running. showFatal() used to call
// console.error directly, which on a packaged Windows build meant the single most
// important line went nowhere.
function fatal(...args) {
  console.error('[wallwright]', ...args);
  diag.write('fatal', ...args);
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
    // Development only. A packaged build gets its icon from the bundle, which
    // electron-builder generates from build/icon.png; unpackaged, the window and
    // taskbar show the Electron binary's own icon unless told otherwise, and
    // build/ is not shipped so this path only exists in a checkout.
    ...(app.isPackaged ? {} : { icon: DEV_ICON }),
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
  counters.bump('panelsCreated', id);
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
  if (w && w.slowTimer) clearTimeout(w.slowTimer);
  watchdog.delete(id);
  touched.delete(id);
  // These two were the only maps left behind. It is kilobytes, but the reason to
  // clean them is correctness rather than memory: uniqueId() can hand out a
  // deleted id again, and a stale entry here defeats dueFor()'s startedAt
  // fallback, so the new panel with the old name refreshes at once or never.
  lastRefresh.delete(id);
  lastRecycle.delete(id);

  // A promoted panel that gets deleted has to leave active mode, and indices
  // after the removed one have all shifted.
  if (state.mode === 'active') {
    if (state.activeIndex === i) state = { mode: 'grid', activeIndex: -1 };
    else if (state.activeIndex > i) state.activeIndex -= 1;
  }
  counters.bump('panelsDeleted', id);
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

// inUse() used to live here, and eligible() below replaces it. The convention it
// existed to serve - one answer to "is somebody using this panel", not three that
// can drift - is unchanged; there is simply more to the answer now than a
// timestamp comparison, and the interesting parts are testable.

// What src/upkeep.js needs to know about each panel, in plain values. Built here
// because it is the only place that can see the views, the watchdog and the
// popups at once.
function panelStates() {
  return config.views.map((v, i) => {
    const wc = contentViews[i] && contentViews[i].webContents;
    const alive = wc && !wc.isDestroyed();
    const pid = osPidOf(contentViews[i]);
    return {
      id: v.id,
      index: i,
      promoted: state.mode === 'active' && state.activeIndex === i,
      interactAt: touched.get(v.id) || 0,
      presentAt: present.get(v.id) || 0,
      rssMb: pid ? lastMemoryByPid.get(pid) || 0 : 0,
      lastRecycleAt: lastRecycle.get(v.id) || 0,
      loading: alive ? wc.isLoading() : false,
      popupOpen: [...popupOwner.values()].includes(v.id),
      neverRecycle: !!v.neverRecycle,
    };
  });
}

// Whether one panel may be rebuilt or refreshed right now, and if not, why.
//
// The single in-use check the conventions ask for: upkeep, the memory ladder and
// the watchdog all come through here, so there is one answer rather than three
// that can drift apart. `op` only distinguishes which deferral clock is used.
function eligible(v, i, op, { force = false } = {}) {
  const now = Date.now();
  const p = panelStates(now)[i];
  const key = `${v.id}:${op}`;
  const reason = ineligibleReason(p, {
    now,
    recentUseMs: config.recentUseMs,
    // The cooldown exists to stop rebuild stampedes, so it applies to rebuilds
    // only. Applying it to a reload meant the watchdog could not recover a panel
    // for a minute after escalating to a rebuild, which is exactly when it needs
    // to: measured, the panel stopped retrying and stayed on the error page.
    minRecycleIntervalMs: op === 'recycle' ? config.minRecycleIntervalMs : 0,
    // The watchdog is reacting to a load that already failed, and isLoading() is
    // still true at that moment. Deferring on it would mean never recovering.
    allowLoading: op === 'reload',
    force,
  });
  if (!reason) {
    deferredSince.delete(key);
    return { ok: true, forced: false };
  }
  // A promoted panel is never forced, so its deferral is not on a clock: the idle
  // timer will dock it, and then it becomes an ordinary candidate.
  if (p.promoted) return { ok: false, reason, forced: false };

  if (!deferredSince.has(key)) deferredSince.set(key, now);
  const expired = deferralExpired({
    wantedSince: deferredSince.get(key),
    now,
    maxDeferMs: config.maxDeferMs,
  });
  // Every reason expires except a policy one. The alternative was measured twice
  // in one afternoon: a reason that cannot expire, on a deferral that is only
  // re-checked when the wall docks, is a panel that never recovers. Fifteen
  // minutes of "still loading" is not a login in progress, and a popup open that
  // long has been abandoned.
  if (expired && reason !== 'neverRecycle is set') {
    const waited = Math.round((now - deferredSince.get(key)) / 1000);
    deferredSince.delete(key);
    warn(`${v.id}: ${op} deferred for ${waited}s, proceeding anyway`);
    return { ok: true, forced: true };
  }
  return { ok: false, reason, forced: false };
}

function dueFor(map, v, everyMs) {
  if (!everyMs) return false;
  const since = Date.now() - (map.get(v.id) || startedAt);
  return since >= everyMs;
}

function refreshPanel(i) {
  const v = config.views[i];
  counters.bump('timerRefreshes', v.id);
  lastRefresh.set(v.id, Date.now());
  log(`refreshing ${v.id}`);
  contentViews[i].webContents.reload();
}

// Rebuild the view, which is the only way to hand the renderer process back.
function recyclePanel(i) {
  const v = config.views[i];
  counters.bump('recycles', v.id);
  lastRecycle.set(v.id, Date.now());
  lastRefresh.set(v.id, Date.now());
  log(`recycling ${v.id} to reclaim its renderer`);
  const old = contentViews[i];
  const before = memorySnapshot();
  const oldPid = osPidOf(old);
  win.contentView.removeChildView(old);
  if (!old.webContents.isDestroyed()) old.webContents.close();
  contentViews[i] = createContentView(v);
  bringToTop(overlay);
  probeRecycle({
    id: v.id,
    oldPid,
    beforeMb: before.totalMb,
    beforePanelMb: oldPid ? before.byPid.get(oldPid) || null : null,
    at: Date.now(),
  });
}

function osPidOf(view) {
  try {
    const wc = view && view.webContents;
    return wc && !wc.isDestroyed() ? wc.getOSProcessId() : null;
  } catch {
    return null;
  }
}

// Did recycling actually reclaim anything?
//
// Nothing in this codebase has ever checked, which made "the countermeasure
// fired" and "the countermeasure worked" indistinguishable in a log. A single
// before/after would not answer it either: webContents.close() tears the process
// down asynchronously, the OS reclaims lazily, and createContentView() has
// already started a replacement loading the same URL. So sample twice, and report
// both numbers.
//
// The load-bearing field is `gone`. A pid that has left getAppMetrics() is direct
// evidence the process was handed back; a pid still present after 30 seconds is a
// leaked renderer, and that is worth finding out from a soak rather than from a
// wall that dies in week three.
function probeRecycle(probe) {
  const record = { ...probe, afterMb: null, lateMb: null, gone: null, newPid: null };
  recycleProbes.push(record);
  if (recycleProbes.length > 20) recycleProbes.shift();

  setTimeout(() => {
    const snap = memorySnapshot();
    record.afterMb = Math.round(snap.totalMb);
    record.gone = probe.oldPid ? !snap.byPid.has(probe.oldPid) : null;
  }, RECYCLE_PROBE_MS);

  setTimeout(() => {
    const snap = memorySnapshot();
    record.lateMb = Math.round(snap.totalMb);
    if (probe.oldPid) record.gone = !snap.byPid.has(probe.oldPid);
    const i = config.views.findIndex((v) => v.id === probe.id);
    record.newPid = i >= 0 ? osPidOf(contentViews[i]) : null;
    record.reclaimedMb = Math.round(probe.beforeMb) - record.lateMb;
    log(
      `recycled ${probe.id}: ${Math.round(probe.beforeMb)}MB -> ${record.afterMb}MB ` +
        `after ${Math.round(RECYCLE_PROBE_MS / 1000)}s, ${record.lateMb}MB after ` +
        `${Math.round(RECYCLE_PROBE_LATE_MS / 1000)}s ` +
        `(${record.reclaimedMb >= 0 ? '-' : '+'}${Math.abs(record.reclaimedMb)}MB net); ` +
        `old pid ${probe.oldPid} gone=${record.gone}; new pid ${record.newPid}`
    );
  }, RECYCLE_PROBE_LATE_MS);

  return record;
}

function runUpkeep() {
  if (state.mode === 'edit') return; // not while the layout is being changed
  config.views.forEach((v, i) => {
    const wantsRecycle = dueFor(lastRecycle, v, v.recycleMs);
    const wantsRefresh = dueFor(lastRefresh, v, v.refreshMs);
    if (!wantsRecycle && !wantsRefresh) return;
    const op = wantsRecycle ? 'recycle' : 'refresh';
    // Deferral is recorded per panel and operation, so a panel that is always
    // busy eventually gets its upkeep rather than never getting it.
    if (!eligible(v, i, op).ok) return;
    if (wantsRecycle) return recyclePanel(i);
    return refreshPanel(i);
  });
}

function startUpkeep() {
  if (upkeepTimer) clearInterval(upkeepTimer);
  const wanted = config.views.some((v) => v.refreshMs || v.recycleMs);
  if (!wanted) return;
  // Spread the clocks, so panels sharing one interval do not all come due in the
  // same second. dueFor() falls back to process start, so without this four
  // panels on one refreshMs reload together: a whole-wall flicker and four
  // renderers loading at once.
  for (const [map, key] of [
    [lastRefresh, 'refreshMs'],
    [lastRecycle, 'recycleMs'],
  ]) {
    const on = config.views.filter((v) => v[key]);
    if (on.length < 2) continue;
    const seeds = staggerSeeds(on.length, on[0][key], startedAt);
    on.forEach((v, n) => {
      if (!map.has(v.id)) map.set(v.id, seeds[n]);
    });
  }
  // Checked once a second; each panel's own interval decides when it is due.
  upkeepTimer = setInterval(runUpkeep, 1000);
}

// One reading of process memory, used by the check below, by the status page and
// by the recycle probe. It was written out twice before, in two slightly
// different ways, and only one of them was wrapped against getAppMetrics
// throwing.
//
// workingSetSize is resident memory per process, and shared pages are counted
// once per process that maps them, so the total reads high. That is fine for
// watching a trend, and it is why the soak also records private bytes from
// outside the app: see docs/validation.md before comparing this number to
// anything.
function memorySnapshot() {
  const byType = new Map();
  const byPid = new Map();
  let totalMb = 0;
  try {
    for (const m of app.getAppMetrics()) {
      const mb = (m.memory && m.memory.workingSetSize ? m.memory.workingSetSize : 0) / 1024;
      totalMb += mb;
      byType.set(m.type, (byType.get(m.type) || 0) + mb);
      if (m.pid) byPid.set(m.pid, mb);
    }
  } catch {
    /* metrics unavailable */
  }
  lastMemoryByPid = byPid;
  return { totalMb, byType, byPid };
}

// Memory. Reported rather than acted on by default: an exhibit that restarts
// itself unpredictably is worse than one that uses a lot of RAM, and knowing the
// real numbers has to come before tuning anything. Everything below rung 0 is
// inert until someone sets memoryLimitMb.
//
// The decision lives in src/upkeep.js so it can be tested; this function reads
// the meters, keeps the state the ladder needs between checks, and carries out
// whatever comes back.
function checkMemory() {
  const { totalMb: total, byType } = memorySnapshot();
  const now = Date.now();
  counters.highWater('memoryMb', Math.round(total));
  const parts = [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, mb]) => `${t} ${Math.round(mb)}MB`)
    .join(', ');
  log(`memory: ${Math.round(total)}MB total (${parts})`);

  // Did the last rebuild actually reclaim anything? Without this, "the
  // countermeasure fired" and "the countermeasure worked" look identical in a
  // log, and the wall can churn sessions for no benefit indefinitely.
  if (pendingReduction !== null) {
    const dropped = pendingReduction - total;
    if (dropped >= config.memoryReduceMinMb) {
      recyclesSinceReduction = 0;
    } else {
      recyclesSinceReduction += 1;
      warn(
        `the last recycle reclaimed ${Math.round(dropped)}MB, under the ` +
          `${config.memoryReduceMinMb}MB that counts (${recyclesSinceReduction} in a row)`
      );
    }
    pendingReduction = null;
  }

  const over = config.memoryLimitMb > 0 && total > config.memoryLimitMb;
  if (!over) {
    // Recovered. Forget the pressure history, so a spike next week starts its own
    // clock rather than inheriting this one.
    memoryPressureSince = null;
    memoryHardChecks = 0;
    memorySweptAt = null;
    memoryExhaustedSaid = false;
    return;
  }

  counters.bump('memoryLimitHits');
  if (!memoryPressureSince) memoryPressureSince = now;
  if (config.memoryHardLimitMb > 0 && total > config.memoryHardLimitMb) memoryHardChecks += 1;
  else memoryHardChecks = 0;

  // The relaunch gates. Kept here rather than in the policy because they are
  // facts about this process, and every one of them is a way the rung can be
  // wrong: no unsaved layout, nobody standing at the wall, and not in the first
  // ten minutes, which is what stops a limit set below the baseline turning into
  // a restart loop.
  const recentPresence = [...present.values()].some((at) => now - at < config.presenceGraceMs);
  const relaunchEnabled =
    config.memoryRelaunch &&
    state.mode !== 'edit' &&
    !recentPresence &&
    now - startedAt > config.minUptimeMs &&
    relaunchCount < config.maxRelaunches;

  const plan = memoryPlan({
    totalMb: total,
    limitMb: config.memoryLimitMb,
    hardLimitMb: config.memoryHardLimitMb,
    panels: panelStates(),
    mode: state.mode,
    now,
    pressureSince: memoryPressureSince,
    hardChecks: memoryHardChecks,
    sweptAt: memorySweptAt,
    recyclesSinceReduction,
    cfg: {
      recentUseMs: config.recentUseMs,
      minRecycleIntervalMs: config.minRecycleIntervalMs,
      memoryForceAfterMs: config.memoryForceAfterMs,
      memoryHardForChecks: config.memoryHardForChecks,
      memoryReduceMinMb: config.memoryReduceMinMb,
      memoryGiveUpAfter: config.memoryGiveUpAfter,
      relaunchEnabled,
    },
  });

  warn(`memory is over the ${config.memoryLimitMb}MB limit (rung ${plan.rung})`);
  const indexOf = (id) => config.views.findIndex((v) => v.id === id);

  if (plan.action === 'recycle') {
    const i = indexOf(plan.targetIds[0]);
    if (i < 0) return;
    if (plan.forced) warn(`forcing a recycle of ${plan.targetIds[0]}: ${plan.reason}`);
    counters.bump('memoryRecycles', plan.targetIds[0]);
    pendingReduction = total;
    return recyclePanel(i);
  }

  if (plan.action === 'sweep') {
    warn(`sweeping ${plan.targetIds.length} panels: ${plan.reason}`);
    memorySweptAt = now;
    pendingReduction = total;
    // Highest index first, so rebuilding one cannot shift the next one's index.
    plan.targetIds
      .map(indexOf)
      .filter((i) => i >= 0)
      .sort((a, b) => b - a)
      .forEach((i) => {
        counters.bump('memoryRecycles', config.views[i].id);
        recyclePanel(i);
      });
    return;
  }

  if (plan.action === 'dock') {
    // Docking reloads nothing, so it costs a fullscreen state the idle timer
    // would have taken anyway, and it makes that panel an ordinary candidate on
    // the next check. Cheaper than overriding promotion.
    warn(`docking the wall: ${plan.reason}`);
    return dockGrid();
  }

  if (plan.action === 'relaunch') {
    relaunchCount += 1;
    warn(`relaunching (${relaunchCount} of ${config.maxRelaunches}): ${plan.reason}`);
    app.relaunch({ args: [...process.argv.slice(1), `--ww-relaunch-count=${relaunchCount}`] });
    return app.exit(0);
  }

  if (plan.rung === 2) counters.bump('memoryAllInUse');
  // Said once rather than every minute for as long as it lasts.
  if (plan.exhausted && !memoryExhaustedSaid) {
    memoryExhaustedSaid = true;
    warn(`no further action available: ${plan.reason}`);
  } else if (plan.reason && !plan.exhausted) {
    log(plan.reason);
  }
}

function startMemoryWatch() {
  if (memoryTimer) clearInterval(memoryTimer);
  if (!config.memoryCheckMs) return;
  // Belt and braces over the validator: a floor here means that however this
  // value arrived, it cannot become a tight loop that floods the log.
  const every = Math.max(1000, Number(config.memoryCheckMs) || 0);
  if (every !== config.memoryCheckMs) {
    warn(`memoryCheckMs ${config.memoryCheckMs} clamped to ${every}ms`);
  }
  memoryTimer = setInterval(checkMemory, every);
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
  counters.bump('presetApplies');

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
    if (w && w.slowTimer) clearTimeout(w.slowTimer);
    watchdog.delete(v.id);
    touched.delete(v.id);
    lastRefresh.delete(v.id);
    lastRecycle.delete(v.id);
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
    counters.bump('crashes', v.id);
    warn(`${v.id} render process gone:`, details && details.reason);
    scheduleReload(view, v);
  });
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    // -3 is ERR_ABORTED, which a normal redirect or a cancelled load produces.
    if (!isMainFrame || code === -3) return;
    // Counted after that return, so the number means real failures rather than
    // every cancelled navigation.
    counters.bump('failedLoads', v.id);
    const w = wd(v.id);
    // Marks this navigation as failed, so the did-finish-load that follows for
    // Chromium's error page is not mistaken for recovery. Measured: loads and
    // failedLoads were identical, 141 each, because every error page counted as a
    // successful load and reset the ladder - which is why a broken panel retried
    // at the base delay forever instead of backing off.
    w.sawFailure = true;
    const text = `${desc} (${code})`;
    // The same failure repeating is one fact, not fifty. An unattended wall can
    // otherwise fill its log with one message and push out everything else.
    if (w.lastError === text) {
      w.suppressed += 1;
      if (w.suppressed % 10 === 0) {
        warn(`${v.id} still failing: ${text}, ${w.suppressed} times`);
      }
    } else {
      w.lastError = text;
      w.suppressed = 0;
      warn(`${v.id} failed to load ${url}: ${text}`);
    }
    scheduleReload(view, v);
  });
  // 'unresponsive' is deliberately NOT a reload trigger: a slow enterprise
  // dashboard is not a crashed one, and reloading would drop the session.
  wc.on('unresponsive', () => warn(`${v.id} is unresponsive (not reloading)`));
  // Cleared per navigation, so a failure recorded for one load cannot suppress
  // recovery from the next.
  wc.on('did-start-loading', () => {
    const w = watchdog.get(v.id);
    if (w) w.sawFailure = false;
  });
  wc.on('did-finish-load', () => {
    const w = watchdog.get(v.id);
    if (!w) return;
    // An error page finishes loading too, and so does the diagnostic page this
    // app puts up itself. Only a load of the real URL that did not fail counts as
    // the panel having come back.
    if (w.sawFailure) {
      w.sawFailure = false;
      return;
    }
    if (w.showingDiagnostic) {
      w.showingDiagnostic = false;
      return;
    }
    counters.bump('loads', v.id);
    // Clears the whole ladder, not only the attempt count: a panel that has come
    // back should not be one failure away from being declared unrecoverable.
    w.attempts = 0;
    w.round = 0;
    w.gaveUp = false;
    w.lastError = null;
    w.suppressed = 0;
    if (w.slowTimer) {
      clearTimeout(w.slowTimer);
      w.slowTimer = null;
    }
  });
}

function wd(id) {
  if (!watchdog.has(id)) {
    watchdog.set(id, {
      attempts: 0,
      pending: null,
      deferred: false,
      // How many times the whole ladder has been walked. Round 2 is the last one:
      // past that the panel is declared unrecoverable rather than retried forever.
      round: 0,
      gaveUp: false,
      slowTimer: null,
      lastError: null,
      suppressed: 0,
      sawFailure: false,
      // True while the panel is showing a page this app generated rather than the
      // configured one. Without it, loading the "could not be loaded" page counts
      // as the panel having recovered, which clears the ladder and cancels the
      // retry that page has just promised the reader.
      showingDiagnostic: false,
    });
  }
  return watchdog.get(id);
}

// What a panel that cannot be recovered shows.
//
// Not a blank rectangle and not Chromium's error page: on a wall, both read as
// "this thing is broken", while a dark panel with the accent heading reads as
// deliberate. It also makes a dead panel diagnosable by somebody standing in
// front of the wall with no access to a log, which is the realistic support
// situation for an exhibit.
function unrecoverableURL(v, w) {
  const retry = config.watchdog.retryMs
    ? `Retrying every ${Math.round(config.watchdog.retryMs / 60000)} minutes.`
    : 'Not retrying.';
  const html = `<body style="margin:0;height:100vh;display:flex;align-items:center;
    justify-content:center;background:#0d1117;color:#8b949e;
    font:15px/1.6 -apple-system,Helvetica,Arial,sans-serif;text-align:center">
    <div style="max-width:80%">
    <div style="color:#f04e23;font-weight:600;font-size:19px;margin-bottom:12px">
    ${escapeHtml(v.label || v.id)} could not be loaded</div>
    <div style="font-family:ui-monospace,Menlo,monospace;color:#e6edf3;
    word-break:break-all;margin-bottom:12px">${escapeHtml(v.url || '(no URL set)')}</div>
    <div>${escapeHtml(w.lastError || 'unknown error')}</div>
    <div style="margin-top:12px">Gave up after ${w.round + 1} rounds
    at ${escapeHtml(new Date().toLocaleTimeString())}. ${retry}</div>
    </div></body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

// Load whatever this panel should be showing. The one place that decides, so the
// watchdog cannot disagree with every other load path about what an empty URL
// means - it used to call loadURL('') and throw into a swallowed catch, then do it
// again thirty seconds later, forever.
function loadPanel(view, v) {
  try {
    view.webContents.loadURL(v.url || placeholderURL(v));
  } catch {
    /* window torn down */
  }
}

function scheduleReload(view, v) {
  const w = wd(v.id);
  if (w.pending || w.gaveUp) return; // one in-flight reload per view
  const i = config.views.indexOf(v);

  // A panel with no URL has nothing to recover. It shows the placeholder, and the
  // placeholder cannot fail, so retrying is pure noise.
  if (!v.url) return;

  // Never reload a panel somebody is using. The session itself would survive
  // (see src/dev/session-probe.js), but the interaction in progress would not:
  // credentials half typed, an SSO redirect chain mid-flight, an SPA's current
  // view. Routed through eligible() so this agrees with upkeep and with the
  // memory ladder, and so a panel that is always busy is not deferred forever.
  const verdict = eligible(v, i, 'reload');
  if (!verdict.ok) {
    // Counted on every deferral, not only the first: the `if (!w.deferred)`
    // below suppresses the log line, not the event, and how often the safety
    // rule fired is exactly what a soak wants to know.
    counters.bump('watchdogDeferrals', v.id);
    if (!w.deferred) log(`deferring reload of ${v.id}: ${verdict.reason}`);
    w.deferred = true;
    return;
  }

  const cfg = config.watchdog;
  // Out of attempts for this round. Escalate once to a rebuild, because a fresh
  // renderer fixes failures a reload cannot - a wedged GPU context, a renderer
  // dying on its own corrupt state - and the sessionStorage a rebuild costs is
  // already gone: the panel is showing an error, not a session.
  if (cfg.maxAttempts && w.attempts >= cfg.maxAttempts) {
    if (cfg.escalateToRecycle && w.round === 0) {
      w.round = 1;
      w.attempts = 0;
      warn(`${v.id}: ${cfg.maxAttempts} reloads failed, rebuilding the view`);
      if (i >= 0) recyclePanel(i);
      return;
    }
    return giveUpOn(view, v, w);
  }

  w.attempts += 1;
  counters.bump('watchdogScheduled', v.id);
  counters.highWater('reloadAttempts', w.attempts, v.id);
  const delay = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** w.attempts);
  log(`reloading ${v.id} in ${delay}ms (attempt ${w.attempts}, round ${w.round + 1})`);
  w.pending = setTimeout(() => {
    w.pending = null;
    // Counted here rather than where it was scheduled, so it means reloads that
    // actually happened.
    counters.bump('watchdogReloads', v.id);
    loadPanel(view, v);
  }, delay);
}

// Stop the fast ladder and say so on the wall. Then try again on a slow timer
// rather than never: a dashboard behind a maintenance window, or a network that
// comes back, should heal without anybody driving to the venue. Retrying every ten
// minutes instead of every thirty seconds takes the log from roughly 120 lines an
// hour to 6, and the renderer churn to nearly nothing.
function giveUpOn(view, v, w) {
  w.gaveUp = true;
  w.showingDiagnostic = true;
  warn(`${v.id}: giving up after ${w.round + 1} rounds (${w.lastError || 'unknown error'})`);
  try {
    view.webContents.loadURL(unrecoverableURL(v, w));
  } catch {
    /* window torn down */
  }
  if (w.slowTimer) clearTimeout(w.slowTimer);
  if (!config.watchdog.retryMs) return;
  w.slowTimer = setTimeout(() => {
    w.slowTimer = null;
    w.gaveUp = false;
    w.round = 0;
    w.attempts = 0;
    log(`${v.id}: trying again after a pause`);
    const i = config.views.indexOf(v);
    if (i >= 0) loadPanel(contentViews[i], v);
  }, config.watchdog.retryMs);
}

function runDeferredReloads() {
  config.views.forEach((v, i) => {
    const w = watchdog.get(v.id);
    if (!w || !w.deferred) return;
    // Still in use: leave it deferred rather than reloading under them. The idle
    // timer and the next dock both come back around, and maxDeferMs means this
    // cannot go on indefinitely.
    if (!eligible(v, i, 'reload').ok) return;
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
    // Interaction and presence are not the same claim. An interaction says
    // somebody is doing something a rebuild would ruin; pointer motion says only
    // that a cursor moved, which on an unattended wall may be the mouse sitting
    // where it was left with animated content passing under it.
    const kind = classifyActivity(type);
    const clock = kind === 'presence' ? present : touched;
    clock.set(config.views[i].id, Date.now());
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
  const mem = memorySnapshot();
  const ledger = counters.snapshot();
  const byType = {};
  for (const [t, mb] of mem.byType) byType[t] = Math.round(mb);

  return {
    // Identifies the run. A sampler compares this across polls to tell "still
    // the same process" from "it died and came back", which an uptime that went
    // backwards only implies.
    runId: RUN_ID,
    startedAtIso: new Date(startedAt).toISOString(),
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    platform: `${process.platform}-${process.arch}`,
    logFile: diag.path(),
    mode: state.mode,
    activePanel: state.activeIndex >= 0 ? config.views[state.activeIndex].id : null,
    activePreset: activePresetId,
    uptimeSec: Math.round((now - startedAt) / 1000),
    memoryMb: Math.round(mem.totalMb),
    // Sampled at memoryCheckMs, so this is a 60-second peak rather than a true
    // maximum. Deliberately not given its own faster timer: the sampler polls
    // more often than the check does anyway.
    memoryPeakMb: ledger.peaks.memoryMb || 0,
    // The split that says whether growth is in the pages (Tab) or in the app
    // itself (Browser, GPU). It only ever existed in a log line before.
    memoryByType: byType,
    counters: ledger.totals,
    timers: {
      memoryCheckMs: config.memoryCheckMs,
      upkeepRunning: !!upkeepTimer,
      memoryWatchRunning: !!memoryTimer,
    },
    recycles: recycleProbes.slice(-20),
    // Over the limit and unable to act. The gap between this being true and
    // anything being recycled is the interesting failure.
    memoryPressure: !!memoryPressureSince,
    memoryPressureSec: memoryPressureSince
      ? Math.round((now - memoryPressureSince) / 1000)
      : null,
    wall: { width: config.wall.width, height: config.wall.height, scale: round3(layout.scale) },
    presets: config.presets.map((p) => ({ id: p.id, name: p.name || p.id })),
    panels: config.views.map((v, i) => {
      const wc = contentViews[i] && contentViews[i].webContents;
      const w = watchdog.get(v.id) || {};
      const c = counters.forStatus(v.id);
      const pid = osPidOf(contentViews[i]);
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
        pid,
        // Attributing memory to a panel needs the pid join to be sound. Several
        // panels can share one renderer process, in which case this figure would
        // be the process total for each of them rather than each panel's share,
        // so `pidShared` says when not to trust it. See the probe answers in
        // docs/validation.md.
        memoryMb: pid && mem.byPid.has(pid) ? Math.round(mem.byPid.get(pid)) : null,
        pidShared: pid
          ? contentViews.filter((other) => other && osPidOf(other) === pid).length > 1
          : null,
        // Cumulative, unlike everything above. reloadAttempts resets on every
        // successful load, so without these a panel that crashed and recovered
        // four hundred times reads zero.
        crashes: c.crashes,
        everCrashed: c.crashes > 0,
        lastCrashAt: c.lastCrashAt,
        failedLoads: c.failedLoads,
        loads: c.loads,
        watchdogReloads: c.watchdogReloads,
        watchdogDeferrals: c.watchdogDeferrals,
        timerRefreshes: c.timerRefreshes,
        recycleCount: c.recycles,
        reloadAttemptsPeak: c.reloadAttemptsPeak,
        // The watchdog has stopped trying and the panel is showing why. Slow
        // retries continue, so this is a state rather than an ending.
        gaveUp: !!w.gaveUp,
        lastError: w.lastError || null,
        lastMoveSecAgo: present.has(v.id) ? Math.round((now - present.get(v.id)) / 1000) : null,
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
  // watchdog, a person pressed this. Same reasoning as reload below, with more at
  // stake, since a rebuild costs sessionStorage.
  //
  // This is also how a dashboard gets tested before recycleMs is turned on for
  // it: sign in, press this, see whether it is still signed in.
  recycle: (id) => {
    const targets = id === null ? config.views.map((_v, i) => i) : [indexOfId(id)];
    if (targets.some((i) => i < 0)) return false;
    // Highest index first, so rebuilding one cannot shift the next one's index.
    targets
      .sort((a, b) => b - a)
      .forEach((i) => {
        log(`recycle requested for ${config.views[i].id}`);
        recyclePanel(i);
      });
    return true;
  },
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
  fatal('cannot start:', message);
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// Two copies would fight over the wall.
if (!app.requestSingleInstanceLock()) {
  // Through diag as well: on a soak machine this is the line that explains why
  // "the app was launched" and nothing changed on the wall.
  openDiagLog();
  fatal('another instance is already running; exiting');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) win.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    // Same reason as the window icon above: in development the Dock shows
    // Electron's icon, because the app is running inside Electron's own bundle.
    if (!app.isPackaged && app.dock && fs.existsSync(DEV_ICON)) {
      try {
        app.dock.setIcon(DEV_ICON);
      } catch (e) {
        warn(`could not set the dev dock icon: ${e.message}`);
      }
    }
    openDiagLog();
    try {
      configPath = resolveConfigPath();
      config = loadConfig(configPath);
    } catch (e) {
      return showFatal(e.message);
    }
    // One line of provenance per run. runId is the join key between this file,
    // /api/status and the soak sampler, and it is how a restart is recognised
    // rather than guessed at from an uptime that went backwards.
    diag.banner({
      runId: RUN_ID,
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      platform: `${process.platform}-${process.arch}`,
      release: os.release(),
      host: os.hostname(),
      packaged: app.isPackaged,
      config: configPath,
      wall: `${config.wall.width}x${config.wall.height}`,
      panels: config.views.length,
    });
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
  // A run that ends must say whether it ended on purpose. Silence at the end of
  // a soak log is otherwise indistinguishable from a kill.
  log(`stopping after ${Math.round((Date.now() - startedAt) / 1000)}s`);
  diag.close();
});
app.on('window-all-closed', () => app.quit());

// ---- the ways a long run dies -----------------------------------------------
//
// None of these were recorded anywhere before. On a wall that is meant to be up
// for weeks, "it was gone on Monday" with no line explaining why is the worst
// possible outcome of a soak, because it cannot be acted on.

process.on('uncaughtException', (e) => {
  fatal('uncaught exception:', e);
  throw e; // still crash: masking it would leave the wall in an unknown state
});
process.on('unhandledRejection', (e) => {
  fatal('unhandled rejection:', e);
});
// Renderer death is already handled per view in hardenView(). This catches the
// processes nothing was watching: the GPU process and the utility processes,
// whose loss is invisible today and is a real multi-day failure mode.
app.on('child-process-gone', (_e, details) => {
  if (details && details.type === 'Frame Renderer') return; // hardenView() has it
  warn(
    `child process gone: type=${details && details.type} ` +
      `reason=${details && details.reason} name=${details && details.name}`
  );
});
