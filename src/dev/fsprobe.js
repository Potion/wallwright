// Dev-only probe: which fullscreen path actually owns the whole display?
//
// On macOS every native fullscreen and kiosk path reports isFullScreen true
// while stopping short of the menu bar, which shows up as a black gap across
// the top of the wall. Only simple fullscreen covers it. Run this on the
// Windows show PC to find out what is true there.
//
//   npm run probe:fs              # runs every variant in turn
//   npm run probe:fs -- ctor_both # or just one
//
// Each variant runs in its own process, because a fullscreen window that is
// still settling reports stale bounds.

const { app, BaseWindow, screen } = require('electron');

const VARIANTS = ['ctor_both', 'ctor_kiosk', 'ctor_fs', 'set_kiosk', 'set_simple'];
const variant = process.argv.slice(2).find((a) => VARIANTS.includes(a));

app.on('window-all-closed', () => {}); // a destroy must not end the run early

app.whenReady().then(() => {
  if (!variant) {
    console.log('usage: electron src/dev/fsprobe.js <' + VARIANTS.join('|') + '>');
    return app.exit(1);
  }

  const d = screen.getPrimaryDisplay();
  const base = {
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
    frame: false,
    backgroundColor: '#101010',
  };

  let win;
  if (variant === 'ctor_both') win = new BaseWindow({ ...base, fullscreen: true, kiosk: true });
  else if (variant === 'ctor_kiosk') win = new BaseWindow({ ...base, kiosk: true });
  else if (variant === 'ctor_fs') win = new BaseWindow({ ...base, fullscreen: true });
  else if (variant === 'set_kiosk') {
    win = new BaseWindow(base);
    win.setKiosk(true);
  } else {
    win = new BaseWindow(base);
    win.setSimpleFullScreen(true);
  }

  // Give the transition time to settle before measuring.
  setTimeout(() => {
    const c = win.getContentBounds();
    const covers = c.x === d.bounds.x && c.y === d.bounds.y && c.height === d.bounds.height;
    console.log(
      'FSPROBE ' +
        JSON.stringify({
          platform: process.platform,
          electron: process.versions.electron,
          variant,
          display: `${d.bounds.width}x${d.bounds.height}@${d.bounds.x},${d.bounds.y}`,
          workArea: `${d.workArea.width}x${d.workArea.height}@${d.workArea.x},${d.workArea.y}`,
          content: c,
          coversDisplay: covers,
          isFullScreen: win.isFullScreen(),
          isKiosk: win.isKiosk(),
          isSimpleFullScreen: win.isSimpleFullScreen(),
        })
    );
    app.exit(0);
  }, 1800);
});
