// Dev-only: does a session actually survive a reload, and a view being
// destroyed and recreated?
//
// This underpins two features. "Never reload a panel, it drops the login" has
// been the working assumption, but cookies live in the `persist:` partition,
// not in the renderer, so a reload may well keep someone signed in. What a
// reload really costs is in-page state: a half-typed form, a redirect chain in
// flight. Worth knowing which, before building anything that reloads on a timer.
//
//   npm run mock &   (or npm run dev in another terminal)
//   npx electron src/dev/session-probe.js

const { app, BaseWindow, WebContentsView } = require('electron');

const BASE = process.env.WALLWRIGHT_MOCK_BASE || 'http://localhost:8787';
const PARTITION = 'persist:session-probe';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeView(win) {
  const view = new WebContentsView({
    webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true },
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 600 });
  return view;
}

async function load(view, url) {
  const done = new Promise((res) => view.webContents.once('did-stop-loading', res));
  view.webContents.loadURL(url);
  await done;
  await wait(300);
}

// Ask the page itself, so this goes through the same cookie jar the page uses.
async function whoami(view) {
  return view.webContents.executeJavaScript(
    `fetch('/whoami').then(r => r.json()).then(j => j.user)`,
    true
  );
}

app.whenReady().then(async () => {
  const win = new BaseWindow({ width: 900, height: 600, show: false });
  const out = {};

  try {
    let view = makeView(win);

    // Sign in, which sets a cookie in the partition.
    await load(view, `${BASE}/login?user=operator&next=/dash-1.html`);
    out.afterLogin = await whoami(view);

    // 1. A plain reload.
    const reloaded = new Promise((res) => view.webContents.once('did-stop-loading', res));
    view.webContents.reload();
    await reloaded;
    await wait(300);
    out.afterReload = await whoami(view);

    // 2. A fresh loadURL of the same page, which is what the watchdog and the
    //    idle reset do.
    await load(view, `${BASE}/dash-1.html`);
    out.afterLoadURL = await whoami(view);

    // 3. The view destroyed and recreated, which is what recycling a renderer
    //    to reclaim memory would do.
    win.contentView.removeChildView(view);
    view.webContents.close();
    await wait(500);
    view = makeView(win);
    await load(view, `${BASE}/dash-1.html`);
    out.afterViewRecreated = await whoami(view);

    // 4. sessionStorage, which is per-tab rather than per-partition. Some SPAs
    //    keep an access token there, so this is the difference between "safe to
    //    reload" and "safe to recycle the whole renderer".
    await view.webContents.executeJavaScript(
      `sessionStorage.setItem('probe', 'token-in-session-storage')`,
      true
    );
    const r1 = new Promise((res) => view.webContents.once('did-stop-loading', res));
    view.webContents.reload();
    await r1;
    await wait(300);
    out.sessionStorageAfterReload = await view.webContents.executeJavaScript(
      `sessionStorage.getItem('probe')`,
      true
    );

    win.contentView.removeChildView(view);
    view.webContents.close();
    await wait(500);
    view = makeView(win);
    await load(view, `${BASE}/dash-1.html`);
    out.sessionStorageAfterRecreate = await view.webContents.executeJavaScript(
      `sessionStorage.getItem('probe')`,
      true
    );
    out.loginAfterSecondRecreate = await whoami(view);

    // 5. In-page state, which is the thing a reload really costs.
    await view.webContents.executeJavaScript(
      `document.getElementById('scratch').value = 'typed but not submitted'`,
      true
    );
    const r2 = new Promise((res) => view.webContents.once('did-stop-loading', res));
    view.webContents.reload();
    await r2;
    await wait(300);
    out.scratchAfterReload = await view.webContents.executeJavaScript(
      `document.getElementById('scratch').value`,
      true
    );
  } catch (e) {
    out.error = e.message;
  }

  console.log('SESSIONPROBE ' + JSON.stringify(out, null, 2));
  app.exit(out.error ? 1 : 0);
});
