// Dev-only: render the wall and write a single PNG of it.
//
// Exists because OS-level screen capture is not always available (a terminal
// without Screen Recording permission, a CI runner, a headless show PC). This
// captures each panel with webContents.capturePage() and composites them at
// their wall coordinates, which is the same image the wall shows: in grid mode
// the overlay is invisible, so backdrop plus panels is the whole picture.
//
//   FORGE_CONFIG=./config/local-demo.json \
//   FORGE_CAPTURE_OUT=./wall.png \
//   electron src/dev/capture.js

const { app, BaseWindow, BrowserWindow, View, WebContentsView, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { loadConfig } = require('../config');

const CONFIG =
  process.env.FORGE_CONFIG || path.join(__dirname, '..', '..', 'config', 'wall.json');
const OUT = process.env.FORGE_CAPTURE_OUT || path.join(process.cwd(), 'wall.png');
const SETTLE = Number(process.env.FORGE_CAPTURE_SETTLE || 7000);
const LOAD_TIMEOUT = Number(process.env.FORGE_CAPTURE_LOAD_TIMEOUT || 25000);

app.setName('Forge');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const config = loadConfig(CONFIG);
  const display = screen.getPrimaryDisplay();

  // Render at the display size, which is what the wall actually shows, and
  // capture at its device pixel ratio so the result is not soft on a Retina
  // panel.
  const W = display.bounds.width;
  const H = display.bounds.height;
  const dpr = display.scaleFactor || 1;
  const scale = Math.min(W / config.wall.width, H / config.wall.height);
  const offX = Math.round((W - config.wall.width * scale) / 2);
  const offY = Math.round((H - config.wall.height * scale) / 2);
  const rectOf = (g) => ({
    x: offX + Math.round(g.x * scale),
    y: offY + Math.round(g.y * scale),
    width: Math.round(g.width * scale),
    height: Math.round(g.height * scale),
  });

  const win = new BaseWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: W,
    height: H,
    frame: false,
    backgroundColor: config.wall.backgroundColor,
  });
  if (process.platform === 'darwin') win.setSimpleFullScreen(true);
  else win.setFullScreen(true);

  const backdrop = new View();
  backdrop.setBackgroundColor(config.wall.backgroundColor);
  win.contentView.addChildView(backdrop);
  backdrop.setBounds({ x: 0, y: 0, width: W, height: H });

  const rects = config.views.map((v) => rectOf(v.grid));
  const views = config.views.map((v, i) => {
    const view = new WebContentsView({
      webPreferences: {
        partition: v.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.contentView.addChildView(view);
    view.setBounds(rects[i]);
    view.webContents.setZoomFactor(v.zoom * scale);
    view.webContents.loadURL(v.url);
    return view;
  });

  // Wait for each page to stop loading, with a ceiling so one slow panel does
  // not hang the capture.
  await Promise.all(
    views.map(
      (view, i) =>
        new Promise((res) => {
          const done = () => res();
          view.webContents.once('did-stop-loading', () => {
            console.log(`loaded ${config.views[i].id}`);
            done();
          });
          setTimeout(() => {
            console.log(`timed out waiting for ${config.views[i].id}`);
            done();
          }, LOAD_TIMEOUT);
        })
    )
  );

  // Let fonts, images and charts settle after load.
  console.log(`settling for ${SETTLE}ms`);
  await wait(SETTLE);

  const shots = [];
  for (const view of views) shots.push((await view.webContents.capturePage()).toDataURL());

  // Composite on a canvas. Data URLs rather than files on disk, so the canvas
  // is same-origin and toDataURL is not tainted.
  const comp = new BrowserWindow({ show: false, width: 64, height: 64 });
  await comp.loadURL('data:text/html,<canvas id="c"></canvas>');
  const png = await comp.webContents.executeJavaScript(
    `(async () => {
      const shots = ${JSON.stringify(shots)};
      const rects = ${JSON.stringify(rects)};
      const dpr = ${dpr};
      const c = document.getElementById('c');
      c.width = ${W} * dpr;
      c.height = ${H} * dpr;
      const ctx = c.getContext('2d');
      ctx.fillStyle = ${JSON.stringify(config.wall.backgroundColor || '#000000')};
      ctx.fillRect(0, 0, c.width, c.height);
      for (let i = 0; i < shots.length; i++) {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = shots[i]; });
        const r = rects[i];
        ctx.drawImage(img, r.x * dpr, r.y * dpr, r.width * dpr, r.height * dpr);
      }
      return c.toDataURL('image/png');
    })()`,
    true
  );

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(png.split(',')[1], 'base64'));
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`CAPTURE wrote ${OUT} (${W * dpr}x${H * dpr}, ${kb}KB)`);
  app.exit(0);
});
