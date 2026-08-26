// Dev-only probe: what happens to a permission request when nobody is handling
// permissions?
//
// src/main.js does not import `session` at all, and there is no
// setPermissionRequestHandler or setPermissionCheckHandler anywhere in src/. So
// every panel gets Chromium's default, on a machine that runs unattended for
// days with no one watching what a dashboard asks for. Electron's security
// checklist says the default is to approve, but AGENTS.md says an assertion about
// an Electron API has to be verified rather than assumed, and docs/validation.md
// has no permission entry at all. This measures it.
//
// Four arms, each on its own partition so nothing leaks between them:
//
//   none    - no handler installed. The claim under test.
//   request - setPermissionRequestHandler denying everything.
//   check   - setPermissionCheckHandler denying everything, request handler absent.
//   both    - both handlers, which is the shape the app would ship.
//
// Run: npm run probe:perm  (needs the mock server; probe:perm starts one)
const { app, session, BaseWindow, WebContentsView } = require('electron');

const BASE = process.env.WALLWRIGHT_MOCK_BASE || 'http://localhost:8787';
const soon = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs one arm and returns both halves of the answer: what the handlers were
// asked, and what the page got back. Keeping them together is the point. A
// getUserMedia failure on a machine with no camera looks identical to a refusal
// if you only read the page's side.
async function arm(win, name, { requestHandler, checkHandler }) {
  const partition = `persist:permprobe-${name}`;
  const ses = session.fromPartition(partition);

  const asked = { request: [], check: [] };

  if (requestHandler) {
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      asked.request.push({
        permission,
        // Recorded because the shipped handler has to resolve the requesting
        // page back to a panel, and this is what it would have to go on.
        url: (details && details.requestingUrl) || null,
        hasWebContents: !!wc,
      });
      callback(false);
    });
  }
  if (checkHandler) {
    ses.setPermissionCheckHandler((wc, permission, origin) => {
      asked.check.push({
        permission,
        origin: origin || null,
        // Documented as sometimes null, which decides whether the shipped
        // handler can rely on it to find the panel.
        hasWebContents: !!wc,
      });
      return false;
    });
  }

  const view = new WebContentsView({
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Without this the page's own timers are throttled to a crawl, because the
      // window is hidden. The first run of this probe reported nothing at all for
      // that reason, which looked like a finding and was an artefact.
      backgroundThrottling: false,
    },
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  const pageConsole = [];
  view.webContents.on('console-message', (_e, _level, message) => pageConsole.push(message));

  await view.webContents.loadURL(`${BASE}/permissions.html`);

  // Poll until nothing is outstanding, or until the budget runs out. Whatever is
  // still outstanding at the end is the answer for those, not a failure of the
  // probe: a permission request that is never answered is the outcome that
  // matters most on a wall nobody is standing at.
  const deadline = Date.now() + 15000;
  let state = null;
  let lastRaw = null;
  while (Date.now() < deadline) {
    await soon(250);
    // Read out of the DOM, not out of a page global. With contextIsolation on,
    // executeJavaScript runs in the isolated world, so it cannot see anything the
    // page's own <script> put on window. The document is shared between worlds;
    // that is the whole reason the page writes its state into a <pre>.
    const raw = await view.webContents.executeJavaScript(
      'document.getElementById("out") && document.getElementById("out").textContent',
      true
    );
    lastRaw = raw;
    if (!raw || raw === 'waiting') continue;
    try {
      state = JSON.parse(raw);
    } catch {
      continue;
    }
    if (state.outstanding.length === 0) break;
  }

  win.contentView.removeChildView(view);
  view.webContents.close();

  return {
    page: state ? state.done : 'page never reported',
    neverAnswered: state ? state.outstanding : null,
    pageError: state ? state.error || null : null,
    lastRaw: state ? undefined : String(lastRaw).slice(0, 300),
    pageConsole,
    askedRequest: asked.request,
    askedCheck: asked.check,
    requestHandlerInstalled: !!requestHandler,
    checkHandlerInstalled: !!checkHandler,
  };
}

app.whenReady().then(async () => {
  const win = new BaseWindow({ width: 900, height: 700, show: false });
  const results = { base: BASE };

  results.none = await arm(win, 'none', {});
  results.request = await arm(win, 'request', { requestHandler: true });
  results.check = await arm(win, 'check', { checkHandler: true });
  results.both = await arm(win, 'both', { requestHandler: true, checkHandler: true });

  results.electron = process.versions.electron;
  results.chrome = process.versions.chrome;
  results.platform = process.platform;

  console.log('PERMPROBE ' + JSON.stringify(results, null, 2));
  app.quit();
});
