// Dev-only probe: does a stationary cursor report activity?
//
// The question matters because src/main.js treats pointer motion differently from
// interaction, and the argument for that rests on a claim about Chromium: that it
// dispatches synthetic mouse-move events when content scrolls or animates beneath
// a pointer that has not moved. If true, a mouse left resting on a live dashboard
// reports activity for as long as the content moves, and on a wall with no cursor
// auto-hide that is the normal state rather than an edge case.
//
// AGENTS.md says anything asserted about an Electron API should be verified rather
// than assumed, so this measures it: park a cursor over an animating page, send
// nothing else, and count what arrives. A static page is the control.
//
// Run: npm run probe:activity  (needs the mock server; probe:activity starts one)
const { app, BaseWindow, WebContentsView, ipcMain } = require('electron');
const path = require('node:path');

const BASE = process.env.WALLWRIGHT_MOCK_BASE || 'http://localhost:8787';
const WATCH_MS = Number(process.env.WALLWRIGHT_ACTIVITY_MS || 12000);

const soon = (ms) => new Promise((r) => setTimeout(r, ms));

async function watch(win, url, label, { scroll = false } = {}) {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'content-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  await view.webContents.loadURL(url);
  // Let the page settle, so load-time layout is not counted as animation.
  await soon(1500);

  const counts = {};
  const onActivity = (e, type) => {
    if (e.sender !== view.webContents) return;
    counts[type] = (counts[type] || 0) + 1;
  };
  ipcMain.on('ww:activity', onActivity);

  // One move to park the cursor in the middle of the page, then nothing at all.
  // Anything counted after this line was not sent by us.
  view.webContents.sendInputEvent({ type: 'mouseMove', x: 400, y: 300 });
  // Wait for our own parking event to arrive before starting the count, rather
  // than guessing how long it takes. The first two runs of this probe reported
  // exactly one event on a completely static page, which was this event landing
  // after a fixed 200ms and then 1200ms wait, and it would have read as evidence
  // for the very thing being tested.
  const parkDeadline = Date.now() + 4000;
  while (!counts.mousemove && Date.now() < parkDeadline) await soon(100);
  const afterPark = { ...counts };
  const parkedEventSeen = !!counts.mousemove;

  // Scrolling the document under a pointer that has not moved is the documented
  // trigger for a synthetic mouse-move, so this case drives it deliberately
  // rather than hoping the page's own animation is enough.
  let scroller = null;
  if (scroll) {
    scroller = setInterval(() => {
      view.webContents
        .executeJavaScript(`window.scrollBy(0, 40); window.scrollY`, true)
        .catch(() => {});
    }, 250);
  }
  await soon(WATCH_MS);
  if (scroller) clearInterval(scroller);
  ipcMain.removeListener('ww:activity', onActivity);
  win.contentView.removeChildView(view);
  view.webContents.close();

  const spontaneous = {};
  for (const [k, n] of Object.entries(counts)) {
    const before = afterPark[k] || 0;
    if (n - before > 0) spontaneous[k] = n - before;
  }
  const moves = spontaneous.mousemove || 0;
  const seconds = WATCH_MS / 1000;
  return {
    page: label,
    url,
    watchedMs: WATCH_MS,
    parkedEventSeen,
    afterParkingTheCursor: afterPark,
    whileNobodyTouchedAnything: spontaneous,
    // The question is whether the signal renews itself, not whether a single
    // event ever arrives. The preload throttles moves to one a second, so a page
    // that really did report continuously would show close to `seconds` of them;
    // one or two is noise, and it cannot hold a panel in-use for longer than
    // recentUseMs after it.
    movesPerSecond: Math.round((moves / seconds) * 100) / 100,
    sustainedStream: moves > 2,
  };
}

app.whenReady().then(async () => {
  const win = new BaseWindow({ width: 800, height: 600, show: false });
  const results = {};
  try {
    // dash-4 is the ticker: a setInterval redrawing content, which is the shape of
    // a real dashboard.
    results.animated = await watch(win, `${BASE}/dash-4.html`, 'animated (mock ticker)');
    // A data URL with nothing moving at all: the control.
    // The documented trigger, driven on purpose: content moving under a pointer
    // that has not moved.
    results.scrolledUnderCursor = await watch(
      win,
      `${BASE}/dash-4.html`,
      'scrolled under a parked cursor',
      { scroll: true }
    );
    results.static = await watch(
      win,
      'data:text/html,' +
        encodeURIComponent('<body style="background:#111;height:400vh"></body>'),
      'static (control)'
    );
  } catch (e) {
    console.error('ACTIVITYPROBE failed:', e.message);
    return app.exit(1);
  }
  console.log('ACTIVITYPROBE ' + JSON.stringify(results, null, 2));
  app.exit(0);
});
