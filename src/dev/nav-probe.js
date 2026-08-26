// Dev-only probe: which navigation events does the main process actually get,
// and does blocking one of them stop the navigation?
//
// The whole navigation policy in src/main.js is two `will-navigate` listeners and
// two setWindowOpenHandlers. There is no will-redirect and no
// will-frame-navigate anywhere. AGENTS.md TODO 4 treats scoping `allowedOrigins`
// to the real Honeywell domains as a config edit, and docs/validation.md notes
// the enforcement "has never run against a populated list". Whether that is a
// config edit or a code change depends entirely on which events fire, and for
// what, so this measures it rather than assuming.
//
// Two passes over the same cases:
//
//   observe                  - attach every listener, touch nothing, record what
//                              fires and in what order.
//   willNavigateOnly         - police by origin in `will-navigate` alone, which is
//                              exactly what the app does today.
//   willNavigatePlusRedirect - police in `will-redirect` as well.
//
// The last two are the ones that matter. Knowing an event fires is not the same as
// knowing the policy can stop what it is for.
//
// Run: npm run probe:nav  (needs the mock server; probe:nav starts one)
const { app, BaseWindow, WebContentsView } = require('electron');

const BASE = process.env.WALLWRIGHT_MOCK_BASE || 'http://localhost:8799';
const soon = (ms) => new Promise((r) => setTimeout(r, ms));

const short = (u) => String(u || '').replace(BASE, '');

// Every navigation-ish event Electron 43 exposes on webContents. Recorded with
// isMainFrame where the event carries it, because "main frame only" is the
// documented limit of will-navigate and the thing most likely to bite.
function listen(
  wc,
  log,
  { block = null, alsoBlockRedirects = false, alsoBlockFrames = false } = {}
) {
  wc.on('will-navigate', (event, url) => {
    const stopped = !!block && block(short(url));
    log.push({ event: 'will-navigate', url: short(url), stopped });
    if (stopped) event.preventDefault();
  });
  wc.on('will-redirect', (event, url) => {
    const stopped = !!block && alsoBlockRedirects && block(short(url));
    log.push({ event: 'will-redirect', url: short(url), stopped });
    if (stopped) event.preventDefault();
  });
  wc.on('did-redirect-navigation', (_e, url, isInPlace, isMainFrame) => {
    log.push({ event: 'did-redirect-navigation', url: short(url), isMainFrame });
  });
  wc.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
    log.push({ event: 'did-start-navigation', url: short(url), isMainFrame });
  });
  wc.on('will-frame-navigate', (event) => {
    // Subframes only. The main frame is already covered by will-navigate, and
    // blocking the same navigation from two listeners proves nothing.
    const stopped = !!block && alsoBlockFrames && !event.isMainFrame && block(short(event.url));
    log.push({
      event: 'will-frame-navigate',
      url: short(event.url),
      isMainFrame: event.isMainFrame,
      stopped,
    });
    if (stopped) event.preventDefault();
  });
  wc.on('did-frame-navigate', (_e, url, code, _s, isMainFrame) => {
    log.push({ event: 'did-frame-navigate', url: short(url), isMainFrame });
  });
}

// Loads `start`, waits for it to settle, then attaches the listeners and lets the
// page do whatever it does. Attaching after the first load is deliberate: a
// loadURL from the main process does not fire will-navigate, so anything recorded
// here is the page moving itself, which is the case the policy has to cover.
async function run(
  win,
  { start, kick, endedAtJs, settleMs = 2500, block, alsoBlockRedirects, alsoBlockFrames }
) {
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 });

  await view.webContents.loadURL(`${BASE}${start}`);
  await soon(300);

  const log = [];
  listen(view.webContents, log, { block, alsoBlockRedirects, alsoBlockFrames });

  if (kick) {
    await view.webContents.executeJavaScript(kick, true).catch(() => {});
  }
  await soon(settleMs);

  // For a subframe case the top document never moves, so getURL() would report
  // "nothing happened" no matter what the frame did. endedAtJs reads the frame.
  let endedAt = short(view.webContents.getURL());
  if (endedAtJs) {
    endedAt = await view.webContents
      .executeJavaScript(endedAtJs, true)
      .then((v) => short(v))
      .catch((e) => 'unreadable: ' + e.message);
  }
  win.contentView.removeChildView(view);
  view.webContents.close();
  return { events: log, endedAt };
}

// start is somewhere harmless; kick is what moves the page. Where the page moves
// itself on a timer, kick is null and settleMs covers it. `forbidden` is the
// pathname an origin policy would be trying to keep the panel away from.
const FRAME_URL = `document.getElementById('f').contentWindow.location.href`;

const CASES = {
  // A single server 302, the shape an SSO hop takes.
  redirect302: {
    start: '/dash-1.html',
    kick: `location.assign('/redirect?to=/dash-2.html&n=1')`,
    forbidden: '/dash-2.html',
  },
  // Three hops. The question is whether the main process hears about the middle.
  redirectChain: {
    start: '/dash-1.html',
    kick: `location.assign('/redirect?to=/dash-2.html&n=3')`,
    forbidden: '/dash-2.html',
  },
  // No script at all, so a CSP or a blocked script would not stop this one.
  metaRefresh: { start: '/nav-meta.html', kick: null, forbidden: '/dash-2.html' },
  // What an SPA route change looks like.
  jsAssign: { start: '/nav-js.html', kick: null, forbidden: '/dash-2.html' },
  // The top document never moves; only the frame does, so the frame is what has
  // to be read back.
  subframe: {
    start: '/nav-frame.html',
    kick: null,
    forbidden: '/dash-4.html',
    endedAtJs: FRAME_URL,
  },
  // The case an origin policy cannot see coming: the page asks for a URL that is
  // perfectly allowed, and the server bounces it somewhere else. Nothing in the
  // requested URL names the destination.
  opaqueRedirect: {
    start: '/dash-1.html',
    kick: `location.assign('/sso-bounce')`,
    forbidden: '/dash-4.html',
  },
};

app.whenReady().then(async () => {
  const win = new BaseWindow({ width: 900, height: 700, show: false });
  const results = {
    base: BASE,
    observe: {},
    willNavigateOnly: {},
    willNavigatePlusRedirect: {},
    allThree: {},
  };

  for (const [name, c] of Object.entries(CASES)) {
    results.observe[name] = await run(win, c);
  }

  // Both passes police by the same rule an allowedOrigins list would: refuse any
  // URL naming the forbidden page. The only difference between them is which
  // events get to enforce it.
  const passes = [
    ['willNavigateOnly', false, false],
    ['willNavigatePlusRedirect', true, false],
    ['allThree', true, true],
  ];
  for (const [label, alsoBlockRedirects, alsoBlockFrames] of passes) {
    for (const [name, c] of Object.entries(CASES)) {
      const block = (url) => url.startsWith(c.forbidden);
      const r = await run(win, { ...c, block, alsoBlockRedirects, alsoBlockFrames });
      results[label][name] = {
        ...r,
        forbidden: c.forbidden,
        // reachedForbidden is the finding. True means the panel arrived at a URL
        // the policy was refusing.
        reachedForbidden: r.endedAt.startsWith(c.forbidden),
      };
    }
  }

  results.electron = process.versions.electron;
  results.chrome = process.versions.chrome;
  results.platform = process.platform;

  console.log('NAVPROBE ' + JSON.stringify(results, null, 2));
  app.quit();
});
