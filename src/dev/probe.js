// Dev-only probe: answers Electron API questions empirically instead of by
// assumption. Run: npm run probe
const { app, BaseWindow, WebContentsView } = require('electron');

app.whenReady().then(async () => {
  const win = new BaseWindow({ width: 400, height: 300, show: false });
  const mk = () => new WebContentsView();
  const a = mk();
  const b = mk();
  const c = mk();
  [a, b, c].forEach((v) => win.contentView.addChildView(v));

  const order = () =>
    win.contentView.children
      .map((v) => ({ a: 'a', b: 'b', c: 'c' })[v === a ? 'a' : v === b ? 'b' : 'c'])
      .join('');

  const results = {};
  results.initialOrder = order();

  // Q1: does re-adding an existing child reorder in place (Chromium behavior),
  // or is it a no-op (which would mean bringToTop needs remove + add)?
  win.contentView.addChildView(a);
  results.afterReAddA = order();
  results.reAddReorders = order() === 'bca';

  // Q2: does the explicit index argument reorder an existing child?
  win.contentView.addChildView(b, 2);
  results.afterAddBAtIndex2 = order();

  // Q3: is setVisible/getVisible present on this Electron?
  results.hasSetVisible = typeof a.setVisible === 'function';
  results.hasGetVisible = typeof a.getVisible === 'function';

  // Q4: does animated setBounds throw on this platform?
  try {
    a.setBounds({ x: 0, y: 0, width: 10, height: 10 }, { animate: { duration: 10 } });
    results.animatedSetBounds = 'ok';
  } catch (e) {
    results.animatedSetBounds = 'threw: ' + e.message;
  }

  // Q5: what does the login item API actually report on this platform, and does
  // it exist at all? Read-only on purpose. Registering one would write into the
  // login items of whoever runs this, and the macOS CI job is somebody's own
  // machine. src/autostart.js decides what to set; this only records what is
  // readable, which is the half that shapes the status page.
  try {
    const li = app.getLoginItemSettings();
    results.loginItem = {
      keys: Object.keys(li).sort(),
      openAtLogin: li.openAtLogin,
      // Windows-only in the docs. Recording whether it is actually present is
      // the point: the status page would otherwise assume.
      hasExecutableWillLaunchAtLogin: 'executableWillLaunchAtLogin' in li,
      wasOpenedAtLogin: li.wasOpenedAtLogin,
    };
  } catch (e) {
    results.loginItem = 'threw: ' + e.message;
  }
  results.hasSetLoginItemSettings = typeof app.setLoginItemSettings === 'function';
  results.packaged = app.isPackaged;
  results.execPath = process.execPath;

  results.electron = process.versions.electron;
  results.chrome = process.versions.chrome;
  results.platform = process.platform;

  console.log('PROBE ' + JSON.stringify(results, null, 2));
  app.quit();
});
