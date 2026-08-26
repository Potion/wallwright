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
//
// Lives under src/dev/ so it does not ship: electron-builder excludes this
// directory, and main.js requires it lazily, only when the capture env var is
// set. Everything it needs from main is passed in as `ctx` rather than reached
// for, which is what makes the coupling visible - nine things, all read-only.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

async function captureWall(ctx, outPath) {
  const { contentViews, overlay, panelRect, layout, config, log } = ctx;
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
function scheduleCapture(ctx, outPath) {
  const { contentViews, config, log, warn } = ctx;
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
    .then(() => captureWall(ctx, outPath))
    .then(() => app.exit(0))
    .catch((e) => {
      warn('capture failed:', e.message);
      app.exit(1);
    });
}

module.exports = { captureWall, scheduleCapture };
