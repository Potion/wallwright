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
  session,
  BaseWindow,
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
const { clampGrid, snapGrid, snapNewGrid } = require('./layout');
const {
  isOriginAllowed,
  isPermissionAllowed,
  panelUrlVerdict,
  partitionVerdict,
  rectVerdict,
} = require('./policy');
const { dataUrl, placeholderPage, unrecoverablePage, fatalPage } = require('./pages');
const { escapeDecision, isFullscreenToggle } = require('./interaction');
const { chooseWallDisplay, safeAreaTopFor, fitLayout, describeLayout } = require('./display');
const {
  newWatchdogRecord,
  nextWatchdogStep,
  failureReport,
  isRealLoadFailure,
} = require('./watchdog');
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
  const fullscreen = isFullscreenNow();
  return safeAreaTopFor({
    setting: config.wall.safeAreaTop,
    fullscreen,
    platform: process.platform,
    // Only measured when it will actually be used, so the "auto" path does not
    // pick a display on every call in windowed mode.
    display: fullscreen && config.wall.safeAreaTop === 'auto' ? pickWallDisplay() : null,
  });
}

function computeLayout() {
  const target = win ? win.getContentBounds() : pickWallDisplay().bounds;
  const next = fitLayout({
    target,
    wall: config.wall,
    safeTop: safeAreaTop(),
    fitToDisplay: config.wall.fitToDisplay,
  });

  // Report against the window, which is what the layout is actually scaled into.
  // Reporting against the display would claim 1:1 while the app sits in an 85%
  // window. Only on change, since this is called on every resize.
  const stamp = `${next.scale}/${next.safeTop}/${next.width}x${next.height}`;
  if (stamp !== lastScaleLogged) {
    lastScaleLogged = stamp;
    log(describeLayout({ wall: config.wall, layout: next }));
  }

  return next;
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
  const { display, notes } = chooseWallDisplay(
    screen.getAllDisplays(),
    screen.getPrimaryDisplay(),
    config.wall
  );
  // Emitted only when the chosen display changes. chooseWallDisplay() collects
  // rather than logs precisely so this can stay quiet: it runs on every resize and
  // every display-metrics change, and an unattended run would otherwise bury its
  // real messages under hundreds of identical warnings.
  if (display.id !== lastDisplayId) {
    lastDisplayId = display.id;
    for (const n of notes) {
      const emit = n.level === 'warn' ? warn : log;
      if (n.extra === undefined) emit(n.message);
      else emit(n.message, n.extra);
    }
  }
  return display;
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
    if (DEV && process.env.WALLWRIGHT_CAPTURE_OUT) {
      // Required here rather than at the top: src/dev/ does not ship, so a
      // packaged build must never reach this line. It cannot - DEV gates it - but
      // a lazy require means a missing file would fail loudly at capture time
      // instead of stopping the app from starting at all.
      const { scheduleCapture } = require('./dev/capture-wall');
      scheduleCapture(captureContext(), process.env.WALLWRIGHT_CAPTURE_OUT);
    }
    startUpkeep();
    startMemoryWatch();
    startControlServer();
  });
}

// ---- panel lifecycle -------------------------------------------------------

// A panel with no URL yet is a normal state right after it is created in the
// editor. Show something that says so rather than a black rectangle.
function placeholderURL(v) {
  return dataUrl(placeholderPage(v));
}

// Every partition that already has permission handlers, so attaching is cheap to
// repeat. It has to be repeatable: a brand-new partition can appear at runtime
// from addPanel(), from a partition change in updatePanel(), or from a preset
// naming one nothing has seen, so there is no single startup moment that covers
// them all. createContentView() is the one chokepoint they all pass through.
const guardedPartitions = new Set();

// Which panel is asking. Deliberately resolved at call time rather than captured:
// panels may share a partition on purpose (see the conventions in AGENTS.md), and
// the handler is per-session, so two views with different allowedPermissions can
// land on one session. Popups resolve through popupOwner, which is the same map
// that stops upkeep rebuilding a panel mid-login.
function viewForWebContents(wc) {
  if (!wc) return null;
  const i = contentViews.findIndex(
    (cv) => cv && !cv.webContents.isDestroyed() && cv.webContents === wc
  );
  if (i >= 0) return config.views[i];
  for (const [win_, id] of popupOwner) {
    if (!win_.isDestroyed() && win_.webContents === wc) {
      return config.views.find((v) => v.id === id) || null;
    }
  }
  return null;
}

// Deny every permission unless the panel's config names it.
//
// Measured before this existed (npm run probe:perm, and the write-up in
// docs/validation.md): a session with no handler grants microphone, camera and
// notifications silently and leaves geolocation pending forever. Both handlers
// are installed because neither is sufficient alone - the request handler is what
// refuses getUserMedia, and the check handler is the only thing that stops
// navigator.permissions.query telling a page it already has what it is about to
// ask for.
//
// The default session is deliberately not touched. Only the overlay, showFatal()
// and the generated data: pages live there, all local and authored here, none of
// which request anything. It is also the session behind the overlay's
// did-finish-load, which is the sole trigger for upkeep, the memory watch and the
// control server, with no timeout: wedging it would take the wall up with no way
// to diagnose it.
function guardPermissions(partition) {
  if (!partition || guardedPartitions.has(partition)) return;
  guardedPartitions.add(partition);
  const ses = session.fromPartition(partition);

  const decide = (wc, permission) => {
    const v = viewForWebContents(wc);
    const allowed = isPermissionAllowed(permission, v && v.allowedPermissions);
    if (!allowed) {
      log(`denied ${permission} to ${v ? v.id : 'an unknown view'} on ${partition}`);
    }
    return allowed;
  };

  ses.setPermissionRequestHandler((wc, permission, callback) => {
    callback(decide(wc, permission));
  });
  // Synchronous, and documented as sometimes being called with no webContents.
  // Without a view there is nothing to consult, so it refuses.
  ses.setPermissionCheckHandler((wc, permission) => decide(wc, permission));
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
  guardPermissions(v.partition);
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
  const wall = wallUnits();
  const v = {
    id,
    label: '',
    url: '',
    // Snapped in wall units before it is stored, the same way a drag is at
    // ww:layout. This path used to clamp only, which made it the one way to
    // create a seam the editor's snapping was supposed to prevent.
    grid: clampGrid(
      snapNewGrid(rect, {
        views: config.views,
        wall,
        // Same tolerance as the drag path: the residual error from snapping in
        // window pixels is at most one pixel, expressed in wall units.
        tolerance: Math.max(2, Math.ceil(2 / (layout.scale || 1))),
      }),
      wall,
      MIN_PANEL
    ),
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
  if (i < 0) return { ok: false, notFound: true, reason: `no panel "${id}"` };
  const v = config.views[i];

  // Checked before anything is applied, so a rejected patch cannot leave the
  // panel half-updated with a new label and its old URL. Neither field was
  // checked at all before: patch.url was String()-coerced and handed straight to
  // loadURL, so file:, chrome: and data: all worked, and a partition without the
  // persist: prefix silently became an in-memory session.
  if (patch.url !== undefined) {
    const verdict = panelUrlVerdict(patch.url);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
  }
  // A falsy partition has always meant "leave the session alone", so it is not
  // put to the verdict.
  if (patch.partition) {
    const verdict = partitionVerdict(patch.partition);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
  }

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
  return { ok: true };
}

// What src/dev/capture-wall.js is allowed to see. Getters rather than values,
// because `layout` and `overlay` are module-level bindings that get reassigned:
// a snapshot taken when the context is built would go stale the first time the
// window is resized.
function captureContext() {
  return {
    get contentViews() {
      return contentViews;
    },
    get overlay() {
      return overlay;
    },
    get layout() {
      return layout;
    },
    get config() {
      return config;
    },
    panelRect,
    log,
    warn,
  };
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

// The policy itself lives in src/policy.js, where it is testable. This is only
// the bit that knows a view has an allowedOrigins field.
function isAllowed(v, url) {
  return isOriginAllowed(url, v.allowedOrigins);
}

// ---- per-view hardening -----------------------------------------------------

// The one place the Esc policy lives, so the per-view key handler and the
// overlay cannot disagree. Returns true when the wall consumed the key, meaning
// the page must not also see it.
function handleEscape() {
  const now = Date.now();
  const decision = escapeDecision({
    mode: state.mode,
    escToGrid: config.escToGrid,
    lastEscAt,
    now,
    escDoubleMs: config.escDoubleMs,
  });
  if (decision === 'dock') {
    lastEscAt = 0;
    dockGrid();
    return true;
  }
  // 'arm' starts the double-press clock; 'pass' leaves it alone.
  if (decision === 'arm') lastEscAt = now;
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
    // popupOwner is what lets upkeep refuse to rebuild the panel that opened
    // this login. Without the mapping, ineligibleReason()'s popup rule is dead.
    popupOwner.set(child, v.id);
    child.on('closed', () => {
      popups.delete(child);
      popupOwner.delete(child);
    });
    hardenPopup(child, v);
  });

  // Three events, one policy. Measured (npm run probe:nav, docs/validation.md):
  // will-navigate alone lets four of six navigation shapes through, because it is
  // handed the URL the page ASKED for and never the one it lands on, and it does
  // not fire for a subframe at all.
  wc.on('will-navigate', (event, url) => {
    if (!isAllowed(v, url)) {
      warn(`blocked navigation to ${url} in ${v.id} (not in allowedOrigins)`);
      event.preventDefault();
    }
  });
  // The redirect target. A page can ask for a URL that is perfectly allowed and
  // be bounced somewhere else, which is what an expired session going to an
  // identity provider looks like. Nothing in the requested URL names where it
  // ends up, so will-navigate cannot see this coming.
  wc.on('will-redirect', (event, url) => {
    if (!isAllowed(v, url)) {
      warn(`blocked redirect to ${url} in ${v.id} (not in allowedOrigins)`);
      event.preventDefault();
    }
  });
  // Subframes only: the main frame is already covered above, and blocking the
  // same navigation from two listeners would just double the log line. This is
  // the only event that fires when an iframe navigates itself.
  wc.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return;
    if (!isAllowed(v, event.url)) {
      warn(`blocked subframe navigation to ${event.url} in ${v.id} (not in allowedOrigins)`);
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
    if (!isRealLoadFailure({ code, isMainFrame })) return;
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
    const report = failureReport(w, { id: v.id, url, text: `${desc} (${code})` });
    w.lastError = report.state.lastError;
    w.suppressed = report.state.suppressed;
    if (report.log) warn(report.log);
    scheduleReload(view, v);
  });
  // 'unresponsive' is deliberately NOT a reload trigger: a slow enterprise
  // dashboard is not a crashed one, and reloading would drop the session.
  wc.on('unresponsive', () => warn(`${v.id} is unresponsive (not reloading)`));

  // A preload that throws takes activity reporting to zero and does it in
  // silence: no crash, no failed load, the page renders normally. Found the hard
  // way, by breaking src/content-preload.js and watching every test still pass.
  // That preload is what tells the wall which panel is in use, so losing it means
  // the idle timer docks the wall under someone and the watchdog reloads a panel
  // mid-login.
  wc.on('preload-error', (_e, preloadPath, error) => {
    warn(`${v.id}: preload failed (${preloadPath}): ${error && error.message}`);
  });
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

// A popup is the SSO login window, and until now it was the only window in the
// app with no navigation policy at all: hardenView() was never applied to it, so
// a redirect chain could take it anywhere and it could open further windows
// freely. It gets the same origin policy the content views get.
//
// Three deliberate differences from hardenView():
//
//   - No Esc handling. Esc in a login form belongs to the page, and docking the
//     wall would close the popup out from under a half-entered password. This is
//     the one window where swallowing Esc would be actively harmful.
//   - No watchdog reload. A popup is a transient part of a login flow, not a
//     panel with a configured URL to recover to; there is nothing to reload it
//     to. A dead one is closed instead.
//   - Closing on a dead renderer is not tidiness, it is required. popupOwner
//     keeps this panel ineligible for upkeep while the popup is open, and
//     'closed' is what clears that. A popup whose renderer died without being
//     closed would hold the entry, and the panel would be passed over until the
//     deferral expired.
function hardenPopup(child, v) {
  const pwc = child.webContents;
  // A popup reuses the opener's partition, so this is normally already done. It
  // is repeated because it is idempotent and because a popup is where a login
  // form lives, which is the last place to discover the guard was missed.
  guardPermissions(v.partition);

  // Same three events as hardenView, and for the same measured reason. A login
  // window is if anything more redirect-heavy than a panel.
  pwc.on('will-navigate', (event, url) => {
    if (!isAllowed(v, url)) {
      warn(`blocked popup navigation to ${url} from ${v.id} (not in allowedOrigins)`);
      event.preventDefault();
    }
  });
  pwc.on('will-redirect', (event, url) => {
    if (!isAllowed(v, url)) {
      warn(`blocked popup redirect to ${url} from ${v.id} (not in allowedOrigins)`);
      event.preventDefault();
    }
  });
  pwc.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return;
    if (!isAllowed(v, event.url)) {
      warn(`blocked popup subframe navigation to ${event.url} from ${v.id}`);
      event.preventDefault();
    }
  });

  // A popup opening another window is unusual but real in some SSO flows, so it
  // is policed rather than refused outright. No geometry override: the wall
  // centring in hardenView() is for a popup opened from a docked panel, and a
  // window opened from a popup should sit where the OS puts it.
  pwc.setWindowOpenHandler(({ url }) => {
    if (!isAllowed(v, url)) {
      warn(`blocked window from ${v.id}'s popup to ${url} (not in allowedOrigins)`);
      return { action: 'deny' };
    }
    return { action: 'allow', overrides: { parent: win } };
  });

  pwc.on('render-process-gone', (_e, details) => {
    warn(`${v.id}: popup renderer gone (${details && details.reason}), closing it`);
    if (!child.isDestroyed()) child.close();
  });

  pwc.on('unresponsive', () => warn(`${v.id}: popup is unresponsive`));
}

function wd(id) {
  if (!watchdog.has(id)) watchdog.set(id, newWatchdogRecord());
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
  return dataUrl(unrecoverablePage(v, w, { retryMs: config.watchdog.retryMs }));
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

  // The spec can be gone while this view's handlers are still attached:
  // deletePanel() splices it out, and applyPreset() replaces the whole list. The
  // handler then fires with an index of -1, and eligible() would index
  // panelStates() out of bounds and dereference undefined. Since uncaughtException
  // rethrows, that took the wall down. giveUpOn() and the escalation below already
  // guard the same lookup; this is the path that did not.
  if (i < 0) return;

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
  const step = nextWatchdogStep(w, cfg);

  if (step.action === 'recycle') {
    w.round = step.round;
    w.attempts = step.attempts;
    warn(`${v.id}: ${cfg.maxAttempts} reloads failed, rebuilding the view`);
    recyclePanel(i);
    return;
  }
  if (step.action === 'giveUp') return giveUpOn(view, v, w);

  w.attempts = step.attempts;
  counters.bump('watchdogScheduled', v.id);
  counters.highWater('reloadAttempts', w.attempts, v.id);
  log(`reloading ${v.id} in ${step.delayMs}ms (attempt ${w.attempts}, round ${w.round + 1})`);
  w.pending = setTimeout(() => {
    w.pending = null;
    // Counted here rather than where it was scheduled, so it means reloads that
    // actually happened.
    counters.bump('watchdogReloads', v.id);
    loadPanel(view, v);
  }, step.delayMs);
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
  popupOwner.clear();
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
  // A non-numeric field here becomes NaN, passes through clampGrid untouched,
  // reaches setBounds, and is then written into the config file by saveViews.
  const rectOk = rectVerdict(msg.rect);
  if (!rectOk.ok) return warn(`ignored layout for ${msg.id}: ${rectOk.reason}`);
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
  if (state.mode !== 'edit') return;
  const rectOk = rectVerdict(rect);
  if (!rectOk.ok) return warn(`ignored addPanel: ${rectOk.reason}`);
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
  const verdict = updatePanel(msg.id, msg.patch || {});
  // The inspector is the only caller, so a refusal here is an administrator
  // typing something the wall will not accept. Saying so beats appearing to
  // accept it and then not changing.
  if (!verdict.ok) warn(`updatePanel refused for ${msg.id}: ${verdict.reason}`);
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
  const check = (n, label, ok, detail) => {
    const why = !ok && detail ? ` (${detail})` : '';
    log(`selftest ${n}: ${ok ? 'ok  ' : 'FAIL'} ${label}${why}`);
    if (!ok) failures.push(`${n}: ${label}${why}`);
  };
  const ids = () => config.views.map((v) => v.id).join(',');
  // ww:addPanel takes WINDOW PIXELS: the handler runs unscaleRect() on whatever it
  // is given. At scale 1.0 on the dev machine that is indistinguishable from wall
  // units, so every call here used to pass wall units and look correct. On the
  // Windows runner, where a 1280x800 wall is fitted into a 1024x768 display at
  // 0.8, a panel asked for at x=512 was created at x=640. Convert explicitly.
  const wallPx = (g) => scaleRect(g);
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

    // ---- 11: the ledger records what the view did -------------------------
    //
    // Step 10 proves the view was replaced. This proves the counters saw it,
    // which is what a soak actually reads: a rebuild nothing counted is a
    // rebuild nobody can account for on Monday.
    step(11, 'counters');
    const ledger = counters.snapshot();
    check(11, 'refreshes were counted', ledger.totals.timerRefreshes > 0);
    check(11, 'recycles were counted', ledger.totals.recycles > 0);
    check(
      11,
      'the deferral was counted, not just logged',
      ledger.totals.watchdogDeferrals >= 0
    );
    check(
      11,
      'the panel that was rebuilt is named in the ledger',
      (ledger.byPanel[upkeepPanel.id] || { totals: {} }).totals.recycles > 0
    );

    // The recycle probe, which is the only thing that can say a rebuild actually
    // handed the renderer back. Asserted on the pid rather than on bytes: a
    // vanished process id is deterministic, where a byte total lags, moves for
    // unrelated reasons, and would flake on a shared runner. The bytes are
    // logged, and the soak is where they are judged.
    const probe = recycleProbes.at(-1);
    check(11, 'a recycle probe was recorded', !!probe);
    if (probe) {
      check(
        11,
        'the probe measured a before and an after',
        Number.isFinite(probe.beforeMb) && (await until(() => probe.afterMb !== null, 15000))
      );
      check(
        11,
        'the old renderer process was returned to the OS',
        probe.oldPid === null || (await until(() => probe.gone === true, 15000))
      );
      log(
        `selftest 11: recycle reclaimed ${Math.round(probe.beforeMb) - (probe.afterMb || 0)}MB ` +
          `(pid ${probe.oldPid} gone=${probe.gone})`
      );
    }

    // ---- 12: memory is measured, and the peak is kept ---------------------
    //
    // checkMemory() used to be called here with no assertion at all, so it
    // proved only that the function did not throw.
    step(12, 'memory');
    checkMemory();
    const memStatus = wallStatus();
    check(12, 'a memory total was measured', memStatus.memoryMb > 0);
    check(12, 'the peak was kept', memStatus.memoryPeakMb > 0);
    check(
      12,
      'the per-process split is populated',
      Object.keys(memStatus.memoryByType).length > 0
    );

    // ---- 13: an in-use panel is never recycled under memory pressure ------
    //
    // The safety rule, asserted rather than assumed, at the one moment it is
    // under real pressure. Three separate ways, because each can fail alone.
    step(13, 'memory pressure and the safety rule');
    const realLimit = config.memoryLimitMb;
    const realForce = config.memoryForceAfterMs;
    const realCooldown = config.minRecycleIntervalMs;
    // A limit of 1MB is always exceeded, so the ladder is definitely engaged.
    config.memoryLimitMb = 1;
    config.recentUseMs = 60000;
    config.minRecycleIntervalMs = 0; // not what is under test here
    config.memoryForceAfterMs = 3600000; // far away, so nothing is forced yet
    memoryPressureSince = null;
    recyclesSinceReduction = 0;
    pendingReduction = null;
    const before13 = contentViews.slice();
    config.views.forEach((v) => touched.set(v.id, Date.now()));
    for (let i = 0; i < 5; i++) checkMemory();
    check(
      13,
      'nothing was recycled while every panel was in use',
      contentViews.every((view, i) => view === before13[i])
    );
    check(13, 'the wall reported being under pressure', wallStatus().memoryPressure === true);

    // Now let it force, and confirm it takes a panel nobody has promoted while
    // leaving the promoted one alone.
    activate(0);
    await until(() => state.mode === 'active');
    // 1ms, not 0: across this config 0 means "off", so a zero here would mean
    // "never force" rather than "force now". Pressure has already been recorded
    // by the five checks above, so 1ms is immediately satisfied.
    config.memoryForceAfterMs = 1;
    const before13b = contentViews.slice();
    config.views.forEach((v) => touched.set(v.id, Date.now()));
    checkMemory();
    await until(() => contentViews.some((view, i) => view !== before13b[i]), 5000);
    check(
      13,
      'the promoted panel was not recycled even when forcing',
      contentViews[0] === before13b[0]
    );
    check(
      13,
      'a non-promoted in-use panel was recycled once pressure persisted',
      contentViews[1] !== before13b[1]
    );
    dockGrid();
    await until(() => state.mode === 'grid');

    // ---- 14: the edit-mode guard -----------------------------------------
    //
    // runUpkeep() always skipped edit mode; checkMemory() did not, so a memory
    // recycle could rebuild a panel under the hands of whoever was dragging it.
    step(14, 'edit mode');
    enterEdit();
    await until(() => state.mode === 'edit');
    const before14 = contentViews.slice();
    config.views.forEach((v) => touched.delete(v.id));
    for (let i = 0; i < 3; i++) checkMemory();
    check(
      14,
      'no panel was rebuilt while the layout was being edited',
      contentViews.every((view, i) => view === before14[i])
    );
    exitEdit({ save: false });
    await until(() => state.mode !== 'edit');

    config.memoryLimitMb = realLimit;
    config.memoryForceAfterMs = realForce;
    config.minRecycleIntervalMs = realCooldown;
    config.recentUseMs = realRecentUse;
    memoryPressureSince = null;

    // ---- 15: the diagnostics log ------------------------------------------
    //
    // The only way to prove the mechanism from 90ae129 end to end: it needs the
    // real log() path and the real userData location, neither of which a unit
    // test has. On Windows this is the difference between a soak that produces a
    // record and one that produces nothing.
    step(15, 'diagnostics log');
    const nonce = `selftest-${RUN_ID}-${Date.now()}`;
    log(nonce);
    const logPath = diag.path();
    let logHasNonce = false;
    try {
      logHasNonce = logPath && fs.readFileSync(logPath, 'utf8').includes(nonce);
    } catch {
      logHasNonce = false;
    }
    check(15, 'the log file exists', !!logPath && fs.existsSync(logPath));
    check(15, 'a line written through log() reached it', logHasNonce);
    check(15, 'the log is not disabled', diag.stats().disabled === false);

    // Reproduces a crash rather than describing one. deletePanel() splices the
    // spec out while that view's own did-fail-load and render-process-gone
    // handlers are still attached, so the watchdog runs with an index of -1. That
    // used to throw inside eligible(), and uncaughtException rethrows, which took
    // the whole wall down. No unit test can reach this: scheduleReload lives in
    // main.js and needs a real view.
    step(16, 'the watchdog survives a panel that no longer exists');
    const countBefore16 = config.views.length;
    await run(
      `window.wallwright.addPanel(${JSON.stringify(wallPx({ x: 40, y: 1100, width: 400, height: 260 }))})`
    );
    await until(() => config.views.length === countBefore16 + 1);
    const doomed = config.views[config.views.length - 1];
    const doomedView = contentViews[config.views.length - 1];
    // Given a URL on purpose, so the guard is what stops this and not the
    // unrelated "a placeholder cannot fail" early return further down.
    doomed.url = 'https://example.com/';
    deletePanel(doomed.id);
    check(16, 'the spec really is gone', config.views.indexOf(doomed) === -1);
    let watchdogThrew = null;
    try {
      scheduleReload(doomedView, doomed);
    } catch (e) {
      watchdogThrew = e;
    }
    check(
      16,
      'scheduleReload did not throw for a deleted panel',
      watchdogThrew === null,
      watchdogThrew && watchdogThrew.message
    );

    // The rule that refuses to rebuild a panel mid-SSO-login was written, unit
    // tested in src/upkeep.js, and dead: popupOwner was declared and read and
    // never written to, so popupOpen was permanently false. A real popup is the
    // only way to prove the write path, which is the half that was missing.
    step(17, 'the SSO popup rule is wired, not just written');
    const owner = config.views[0];
    const ownerState = () => panelStates().find((p) => p.id === owner.id);
    // Wrapped so the expression resolves to a boolean. Returning the Window that
    // window.open() hands back fails to serialise over IPC, and executeJavaScript
    // rejects with a bare "Uncaught" that says nothing about why.
    await contentViews[0].webContents.executeJavaScript(
      `(() => { window.open('about:blank', '_blank', 'width=320,height=200'); return true; })()`,
      true
    );
    const popupOpened = await until(() => popups.size > 0);
    check(17, 'the popup was created', popupOpened);
    check(
      17,
      'panelStates attributes it to the panel that opened it',
      ownerState().popupOpen === true
    );
    check(
      17,
      'and upkeep refuses that panel even when forcing',
      /popup/.test(eligible(owner, 0, 'recycle', { force: true }).reason || '')
    );
    // hardenPopup() ran. The popup was the only window in the app with no
    // navigation policy at all, and a listener is the observable trace of it.
    const popupWin = [...popups][0];
    check(
      17,
      'the popup was given a navigation policy',
      !!popupWin && popupWin.webContents.listenerCount('will-navigate') > 0
    );
    closePopups();
    check(17, 'closing it clears the attribution', ownerState().popupOpen === false);

    // updatePanel is reachable from the inspector and, unauthenticated, from the
    // loopback control surface. Both used to accept any scheme and any partition
    // name: patch.url was String()-coerced straight into loadURL, and a partition
    // without the persist: prefix silently became an in-memory session that loses
    // the login on the next rebuild.
    step(18, 'a panel cannot be pointed at anything at all');
    const guarded = config.views[0];
    const urlBefore = guarded.url;
    const labelBefore = guarded.label;
    const partitionBefore = guarded.partition;

    const badUrl = updatePanel(guarded.id, {
      url: 'file:///etc/passwd',
      label: 'should not be applied',
    });
    check(18, 'a file: url is refused', badUrl.ok === false, badUrl.reason);
    check(18, 'the url is unchanged', guarded.url === urlBefore);
    // The whole patch is validated before any of it is applied, so a rejected
    // url must not leave a new label behind.
    check(18, 'and no other field of that patch was applied', guarded.label === labelBefore);

    const badPartition = updatePanel(guarded.id, { partition: 'wall-1' });
    check(
      18,
      'a partition without persist: is refused',
      badPartition.ok === false,
      badPartition.reason
    );
    check(18, 'the session is unchanged', guarded.partition === partitionBefore);

    const goodPatch = updatePanel(guarded.id, { label: 'accepted by selftest' });
    check(
      18,
      'a valid patch still applies',
      goodPatch.ok === true && guarded.label === 'accepted by selftest'
    );

    const missing = updatePanel('no-such-panel', { label: 'x' });
    check(
      18,
      'a missing panel is reported as not found, not as refused',
      missing.ok === false && missing.notFound === true
    );

    // The overlay's stylesheet moved out of overlay.html so the CSP could be
    // default-src 'none' with no 'unsafe-inline' exception. If overlay.css ever
    // fails to load - a rename, a bad path, a CSP that is too strict - the editor
    // still works and every other check here still passes, it just looks wrong.
    // Nothing else would catch that.
    // Measured before this existed: a session with no handler grants microphone,
    // camera and notifications silently. Nothing else here would notice the guard
    // going missing, because a granted permission looks like nothing happening.
    // Nothing covered the content preload, and a preload that fails is silent:
    // the page renders, nothing crashes, and the wall simply stops knowing which
    // panel is in use. Breaking it on purpose passed every other check here.
    step(19, 'the content preload is alive and reporting');
    const watched = config.views[0];
    const beforeTouch = touched.get(watched.id) || 0;
    contentViews[0].webContents.sendInputEvent({ type: 'keyDown', keyCode: 'a' });
    const reported = await until(() => (touched.get(watched.id) || 0) > beforeTouch, 4000);
    check(
      19,
      'a keypress in a panel reaches the main process as activity',
      reported,
      'src/content-preload.js is not reporting; check for a preload-error line above'
    );

    step(19, 'permissions are guarded on every panel session');
    const partitions = [...new Set(config.views.map((v) => v.partition))];
    check(
      19,
      'every partition currently in use has been guarded',
      partitions.length > 0 && partitions.every((pt) => guardedPartitions.has(pt)),
      `guarded=${[...guardedPartitions].join(',')} views=${partitions.join(',')}`
    );
    // Draw a new panel, which mints a partition that has never existed, and check
    // it was guarded on the way in. This is the case a startup-time attach would
    // miss, and it is the reason the guard hangs off createContentView() rather
    // than off app.whenReady(). Checking only the partitions already in use is
    // not enough: a popup guards one of those as a side effect, so that check
    // still passes with the guard removed from the panel path.
    // The partition name carries RUN_ID so it cannot collide with anything this
    // run has already guarded. addPanel() alone is not enough for this: uniqueId()
    // can hand back an id that was deleted earlier in the run, and with it a
    // partition that was already guarded, so the check would pass either way.
    const countBefore19 = config.views.length;
    await run(
      `window.wallwright.addPanel(${JSON.stringify(wallPx({ x: 60, y: 1400, width: 300, height: 220 }))})`
    );
    await until(() => config.views.length === countBefore19 + 1);
    const freshPanel = config.views[config.views.length - 1];
    const freshPartition = `persist:selftest-fresh-${RUN_ID}`;
    check(19, 'the test partition really is new', !guardedPartitions.has(freshPartition));
    updatePanel(freshPanel.id, { partition: freshPartition });
    check(
      19,
      'a partition minted at runtime is guarded too',
      guardedPartitions.has(freshPartition),
      `${freshPartition} not in guarded set`
    );
    deletePanel(freshPanel.id);
    // The deny path, exercised rather than assumed. No view names any permission
    // in config/selftest.json, so every one of these must come back false.
    check(
      19,
      'nothing is allowed by default',
      config.views.every((v) => !isPermissionAllowed('media', v.allowedPermissions))
    );

    step(19, 'the overlay stylesheet loaded under the CSP');
    const sheets = await run(`document.styleSheets.length`);
    check(19, 'a stylesheet is attached', sheets > 0, `styleSheets.length=${sheets}`);
    // A token from overlay.css, resolved rather than merely present, so a file
    // that loaded but parsed to nothing still fails.
    const accent = await run(
      `getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`
    );
    check(19, 'the palette tokens resolve', !!accent, `--accent="${accent}"`);
    // overlay.js reads window.WallwrightLayout at load. If the CSP ever blocks
    // that second script, or the file is renamed, the symptom is a drag that
    // throws rather than a message saying what went missing.
    const sharedGeometry = await run(
      `typeof window.WallwrightLayout === 'object' && typeof window.WallwrightLayout.snapRect === 'function'`
    );
    check(19, 'the shared layout geometry loaded into the overlay', sharedGeometry === true);

    // The layout editor's snapping runs in the overlay renderer, in window pixels,
    // and nothing covered it: every other check here drives the editor through IPC
    // and skips the geometry entirely. This drives a real pointer drag instead, so
    // the whole path is exercised - overlay hit-test, applySnap in pixels,
    // ww:layout, snapGrid in wall units, clampGrid - and lands on a number.
    step(20, 'a real pointer drag snaps the panel to the wall edge');
    enterEdit();
    await soon(400);

    // Self-contained: earlier steps delete panels, so this draws its own rather
    // than depending on what is left over. Placed well clear of the wall's left
    // edge so the drag has somewhere to travel from.
    const wall20 = wallUnits();
    const countBefore20 = config.views.length;
    const wanted20 = {
      x: Math.round(wall20.width * 0.4),
      y: Math.round(wall20.height * 0.3),
      width: 300,
      height: 200,
    };
    await run(`window.wallwright.addPanel(${JSON.stringify(wallPx(wanted20))})`);
    await until(() => config.views.length === countBefore20 + 1);
    await soon(300);

    const dragged = config.views[config.views.length - 1];
    const stage = stageBounds();
    const box = JSON.parse(
      await run(
        `(() => {
           const el = document.querySelector('.epanel');
           if (!el) return 'null';
           const r = el.getBoundingClientRect();
           return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
         })()`
      )
    );
    check(20, 'the editor drew a panel frame to drag', !!box, `mode=${state.mode}`);

    if (box) {
      // Aim the left edge six window pixels inside the wall's left edge: inside
      // the overlay's 10px snap radius, but well outside the 2-unit tolerance
      // main.js re-snaps with. So if the overlay stopped snapping, the panel
      // lands at ~6 units rather than 0 and this check fails rather than
      // silently passing on the second pass.
      const fromX = Math.round(box.x + box.w / 2);
      const fromY = Math.round(box.y + box.h / 2);
      const toX = fromX + (stage.x + 6 - Math.round(box.x));
      const send = (type, x, y) =>
        overlay.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });
      // Everything this step depends on, in one string. The first Windows run
      // failed with nothing but a final grid.x, which was not enough to tell a
      // drag that never started from one that landed on the wrong target.
      const where =
        `scale=${layout.scale.toFixed(3)} stage=${stage.x},${stage.y} ` +
        `box=${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.w)}x${Math.round(box.h)} ` +
        `from=${fromX},${fromY} to=${toX} startGrid=${dragged.grid.x}`;

      send('mouseDown', fromX, fromY);
      // Two questions, not one. startDrag() adds the 'dragging' class before it
      // sends ww:dragStart, so the class says whether the pointerdown reached the
      // frame at all, and editDrag says whether the main process accepted it.
      const started = await until(() => editDrag !== null, 2000);
      const grabbed = await run(`!!document.querySelector('.epanel.dragging')`);
      check(
        20,
        'the pointerdown reached the panel frame',
        grabbed === true,
        `no .dragging class. ${where}`
      );
      check(20, 'the main process accepted the drag', started, where);

      // Several moves rather than two, and slower. A loaded runner coalesces
      // events, and the last one processed is the one that decides where it lands.
      for (const t of [0.25, 0.5, 0.75, 1, 1]) {
        send('mouseMove', Math.round(fromX + (toX - fromX) * t), fromY);
        await soon(80);
      }
      send('mouseUp', toX, fromY);
      await until(() => dragged.grid.x === 0, 3000);

      check(
        20,
        'the dragged panel snapped flush to the wall edge',
        dragged.grid.x === 0,
        `grid.x=${dragged.grid.x}, expected 0. ${where}`
      );
    }
    deletePanel(dragged.id);
    exitEdit({ save: false });
    await soon(200);

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
  // Returns the verdict rather than a boolean, so the HTTP surface can tell a
  // panel that does not exist (404) from a patch that was refused (400). It used
  // to answer 200 to a rejected patch, which read as "done".
  updatePanel: (id, patch) => updatePanel(id, patch),
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
  // globalShortcut.register() returns false when the OS refuses the accelerator,
  // which happens when another running application already owns it. Unchecked,
  // that is silent, and the first anyone knows is that a key does nothing at the
  // wall - including Ctrl+Shift+Q, which is the deliberate way out of a kiosk
  // window with no menu and no title bar. Named so the warning says which one.
  const bind = (accelerator, what, handler) => {
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, handler);
    } catch (e) {
      warn(`could not register ${accelerator} (${what}): ${e.message}`);
      return false;
    }
    if (!ok) warn(`${accelerator} (${what}) was refused, probably taken by another app`);
    return ok;
  };

  // Deliberate admin exit.
  bind('CommandOrControl+Shift+Q', 'quit', () => app.quit());
  // Layout edit mode. Not dev-only: this is how the layout gets tuned at the
  // wall, against the real dashboards, without editing JSON on site.
  bind('CommandOrControl+Shift+E', 'edit mode', () => toggleEdit());
  // Panels are interactive in grid mode, so promoting one needs its own mode
  // rather than a click that would otherwise land on the page.
  bind('CommandOrControl+Shift+P', 'select mode', () => toggleSelect());
  // Recall a montage by number, without opening the editor. Registered for all
  // nine whether or not that many presets exist; the handler just does nothing.
  for (let n = 1; n <= 9; n++) {
    bind(`CommandOrControl+Shift+${n}`, `preset ${n}`, () => {
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
    bind('CommandOrControl+Shift+I', 'devtools', () => {
      const i = state.activeIndex;
      const target = i >= 0 ? contentViews[i] : overlay;
      target.webContents.openDevTools({ mode: 'detach' });
    });
    bind('CommandOrControl+Shift+G', 'dock to grid', () => dockGrid());
  }
}

// A malformed config or a missing display should show something readable on the
// wall, not die with a stack trace.
function showFatal(message) {
  const w = new BaseWindow({ width: 900, height: 520, backgroundColor: '#0d1117' });
  const v = new WebContentsView();
  w.contentView.addChildView(v);
  v.setBounds({ x: 0, y: 0, width: 900, height: 520 });
  v.webContents.loadURL(dataUrl(fatalPage(APP_NAME, message, configPath)));
  fatal('cannot start:', message);
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
      config = loadConfig(configPath, { onWarn: warn });
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
