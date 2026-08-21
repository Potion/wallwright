// Forge LED wall - Electron main process.
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
  WebContentsView,
  Menu,
  screen,
  ipcMain,
  globalShortcut,
} = require('electron');
const path = require('path');
const { loadConfig, saveLayout } = require('./config');
const { clampGrid, snapGrid } = require('./layout');

const CONFIG_PATH =
  process.env.FORGE_CONFIG || path.join(__dirname, '..', 'config', 'wall.json');
const DEV = process.env.FORGE_DEV === '1';

// Smallest panel the layout editor will produce, in wall units.
const MIN_PANEL = 160;

let config = null;
let win = null; // BaseWindow: the wall
const contentViews = []; // WebContentsView per configured page (index-aligned with config.views)
let overlay = null; // WebContentsView: transparent hotspot layer / corner Back button
let state = { mode: 'grid', activeIndex: -1 };
let idleTimer = null;
let lastEscAt = 0;
const popups = new Set(); // BrowserWindows opened by SSO flows
let editDrag = null; // { i, baseGrid, baseZoom } while a layout drag is in flight
const watchdog = new Map(); // view id -> { attempts, pending, deferred }

function log(...args) {
  console.log('[forge]', ...args);
}
function warn(...args) {
  console.warn('[forge]', ...args);
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

function computeLayout() {
  const target = win ? win.getContentBounds() : pickWallDisplay().bounds;
  const W = target.width;
  const H = target.height;
  const w = config.wall.width;
  const h = config.wall.height;
  const scale = config.wall.fitToDisplay === false ? 1 : Math.min(W / w, H / h);
  return {
    scale,
    offsetX: Math.round((W - w * scale) / 2),
    offsetY: Math.round((H - h * scale) / 2),
    width: W,
    height: H,
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

  let hit = null;
  if (displayId != null) {
    hit = displays.find((d) => String(d.id) === String(displayId));
    if (!hit)
      warn(
        `no display with id ${displayId}; known ids:`,
        displays.map((d) => d.id)
      );
  }
  if (!hit && displayLabel) {
    hit = displays.find((d) => d.label === displayLabel);
    if (!hit) {
      warn(
        `no display labelled "${displayLabel}"; known labels:`,
        displays.map((d) => d.label)
      );
    }
  }
  if (!hit) {
    // Last resort before primary: a display whose resolution matches the wall.
    const exact = displays.filter(
      (d) => d.bounds.width === width && d.bounds.height === height
    );
    if (exact.length === 1) {
      hit = exact[0];
      log(`matched display by ${width}x${height} resolution: "${hit.label}" (id ${hit.id})`);
    }
  }
  if (!hit) {
    hit = screen.getPrimaryDisplay();
    warn(
      `falling back to the PRIMARY display "${hit.label}" (id ${hit.id}). ` +
        'Set wall.displayLabel or wall.displayId to target the LED wall output.'
    );
  }

  if (hit.bounds.width !== width || hit.bounds.height !== height) {
    const s = Math.min(hit.bounds.width / width, hit.bounds.height / height);
    if (config.wall.fitToDisplay === false) {
      warn(
        `wall config is ${width}x${height} but display "${hit.label}" is ` +
          `${hit.bounds.width}x${hit.bounds.height}, and wall.fitToDisplay is off. ` +
          'Panel rectangles will not land where you expect until these agree.'
      );
    } else {
      log(
        `previewing the ${width}x${height} layout on a ` +
          `${hit.bounds.width}x${hit.bounds.height} display, scaled to ${s.toFixed(3)}. ` +
          'Set wall.width/height to the real wall resolution for a 1:1 run.'
      );
    }
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

  win = new BaseWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: config.wall.width,
    height: config.wall.height,
    frame: false,
    fullscreen: !!config.wall.fullscreen,
    kiosk: !!config.wall.kiosk,
    backgroundColor: config.wall.backgroundColor,
  });

  // Fullscreen/kiosk means the real content size is the display's, not whatever
  // was passed above, and it only settles after the transition. Compute the
  // layout from the window itself and recompute whenever it changes.
  layout = computeLayout();
  const onResize = () => {
    layout = computeLayout();
    if (state.mode === 'active') activate(state.activeIndex, { force: true });
    else if (overlay) dockGrid({ animate: false });
  };
  win.on('resize', onResize);
  win.on('enter-full-screen', onResize);
  win.on('leave-full-screen', onResize);

  config.views.forEach((v, i) => {
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
    view.setBounds(panelRect(i));
    view.webContents.setZoomFactor(panelZoom(i));
    hardenView(view, v, i);
    view.webContents.loadURL(v.url);
    contentViews.push(view);
  });

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
  overlay.webContents.loadFile(path.join(__dirname, 'overlay.html'));
  overlay.webContents.once('did-finish-load', () => dockGrid());
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

function dockGrid({ animate = true } = {}) {
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

  overlay.setBounds(wallBounds());
  bringToTop(overlay);
  sendOverlayState();
  overlay.webContents.focus();

  closePopups();
  runDeferredReloads();
}

// The overlay lays out in window pixels, so everything it is told is already
// scaled. Wall units only ever cross this boundary as readout numbers.
function sendOverlayState() {
  if (state.mode === 'edit') {
    overlay.webContents.send('forge:state', {
      mode: 'edit',
      stage: stageBounds(),
      minPx: Math.max(8, Math.round(MIN_PANEL * layout.scale)),
      wall: { width: config.wall.width, height: config.wall.height },
      views: config.views.map((v, i) => ({
        ...publicView(v, i),
        wallGrid: v.grid,
        zoom: round3(v.zoom),
      })),
    });
    return;
  }
  if (state.mode === 'grid') {
    overlay.webContents.send('forge:state', {
      mode: 'grid',
      hint: config.showHotspotHint,
      views: config.views.map((v, i) => publicView(v, i)),
    });
    return;
  }
  overlay.webContents.send('forge:state', {
    mode: 'active',
    activeIndex: state.activeIndex,
    id: config.views[state.activeIndex] && config.views[state.activeIndex].id,
  });
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
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
  clearIdle(); // never dock the wall out from under someone editing it
  editDrag = null;
  config.views.forEach((v, i) => {
    contentViews[i].setVisible(true);
    contentViews[i].setBounds(panelRect(i));
    contentViews[i].webContents.setZoomFactor(panelZoom(i));
  });
  overlay.setBounds(wallBounds());
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
      saveLayout(CONFIG_PATH, config.views);
      log(`layout saved to ${CONFIG_PATH}`);
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
  state = { mode: 'active', activeIndex: index };
  lastEscAt = 0;

  // NOTE: do NOT reload here. Reloading would drop the login the operator may
  // have just established.
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
  if (state.mode === 'active' && config.idleReturnMs > 0) {
    idleTimer = setTimeout(() => dockGrid(), config.idleReturnMs);
  }
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

function hardenView(view, v, i) {
  const wc = view.webContents;

  wc.on('before-input-event', (event, input) => {
    if (state.mode !== 'active' || state.activeIndex !== i) return;
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
    scheduleReload(view, v, i);
  });
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    // -3 is ERR_ABORTED, which a normal redirect or a cancelled load produces.
    if (!isMainFrame || code === -3) return;
    warn(`${v.id} failed to load ${url}: ${desc} (${code})`);
    scheduleReload(view, v, i);
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

function scheduleReload(view, v, i) {
  const w = wd(v.id);
  if (w.pending) return; // one in-flight reload per view

  // Never reload the panel somebody is using: it would destroy their login
  // mid-session. Defer it until the wall returns to the grid.
  if (state.mode === 'active' && state.activeIndex === i) {
    if (!w.deferred) log(`deferring reload of ${v.id} until it is no longer active`);
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
    if (w && w.deferred) {
      w.deferred = false;
      scheduleReload(contentViews[i], v, i);
    }
  });
}

function closePopups() {
  for (const p of popups) {
    if (!p.isDestroyed()) p.close();
  }
  popups.clear();
}

// ---- IPC from the overlay ---------------------------------------------------

ipcMain.on('forge:activate', (_e, id) => {
  if (state.mode === 'edit') return; // handles own the mouse while editing
  const i = config.views.findIndex((v) => v.id === id);
  if (i >= 0) activate(i);
});
ipcMain.on('forge:back', () => {
  if (state.mode === 'active') dockGrid();
});
ipcMain.on('forge:escape', () => handleEscape());
ipcMain.on('forge:activity', () => {
  if (state.mode === 'active') resetIdle();
});

// ---- IPC: layout editing ----------------------------------------------------

function indexOfId(id) {
  return config.views.findIndex((v) => v.id === id);
}

// Snapshot the panel as the drag begins. A corner scale needs the ratio against
// where the drag started, not against the previous frame, or the rounding
// compounds over a long drag.
ipcMain.on('forge:dragStart', (_e, id) => {
  if (state.mode !== 'edit') return;
  const i = indexOfId(id);
  if (i < 0) return;
  editDrag = { i, baseGrid: { ...config.views[i].grid }, baseZoom: config.views[i].zoom };
});

ipcMain.on('forge:dragEnd', () => {
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
ipcMain.on('forge:layout', (_e, msg) => {
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
  overlay.webContents.send('forge:layoutEcho', {
    id: v.id,
    grid: v.grid,
    zoom: round3(v.zoom),
    rect: panelRect(i),
  });
});

ipcMain.on('forge:editExit', (_e, opts) => exitEdit({ save: !(opts && opts.discard) }));

// ---- lockdown + lifecycle ---------------------------------------------------

function registerShortcuts() {
  // Deliberate admin exit.
  globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());
  // Layout edit mode. Not dev-only: this is how the layout gets tuned at the
  // wall, against the real dashboards, without editing JSON on site.
  globalShortcut.register('CommandOrControl+Shift+E', () => toggleEdit());
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
    <h1 style="font:600 20px sans-serif;color:#f04e23;margin:0 0 16px">Forge cannot start</h1>
    <pre style="white-space:pre-wrap">${escapeHtml(message)}</pre>
    <p style="color:#8b949e">Config: ${escapeHtml(CONFIG_PATH)}</p></body>`;
  v.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  console.error('[forge] fatal:', message);
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// Two copies would fight over the wall.
if (!app.requestSingleInstanceLock()) {
  console.error('[forge] another instance is already running; exiting');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) win.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    try {
      config = loadConfig(CONFIG_PATH);
    } catch (e) {
      return showFatal(e.message);
    }
    log(
      `config ${CONFIG_PATH}: ${config.views.length} views on a ` +
        `${config.wall.width}x${config.wall.height} wall`
    );
    createWall();
    registerShortcuts();

    // An LED controller can enumerate outputs late at boot, so re-target rather
    // than sitting on the wrong display for the rest of the show.
    const retarget = () => {
      if (!win) return;
      const d = pickWallDisplay();
      win.setBounds({
        x: d.bounds.x,
        y: d.bounds.y,
        width: config.wall.width,
        height: config.wall.height,
      });
      layout = computeLayout();
      if (state.mode === 'active') activate(state.activeIndex, { force: true });
      else dockGrid({ animate: false });
    };
    screen.on('display-added', retarget);
    screen.on('display-removed', retarget);
    screen.on('display-metrics-changed', retarget);
  });
}

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
