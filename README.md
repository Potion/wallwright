# hon-forge

Forge is the "Next Gen Control Room" LED wall exhibit. It shows four live
Honeywell web dashboards laid out on one large LED wall. Each panel is a real,
interactive browser view (real logins, real sessions), positioned and scaled
independently, with no browser chrome. A single wireless keyboard and mouse is
used at the wall: click a panel and it goes fullscreen and interactive; Esc, a
corner Back button, or an idle timeout returns to the four-up grid.

Read `SPEC.md` for the full design and the reasoning behind it,
`docs/validation.md` for what has actually been observed running, and
`AGENTS.md` for the remaining checklist and the open decisions that still need
Jeff's input.

## Stack

Electron, using one `BaseWindow` (the wall) with four `WebContentsView`
content panels plus a transparent `WebContentsView` overlay for the click
targets and the Back button. No compositor, no video capture; the pages stay
live and interactive.

## Run

```sh
npm install

# Development: serves four local mock dashboards and opens a windowed 1600x900
# wall. This is how you exercise the app without the real Honeywell URLs.
npm run dev

# Production-shaped run against config/wall.json (kiosk, fullscreen).
npm start
FORGE_CONFIG=./config/wall.json npm start

npm test      # config validation
npm run lint
npm run probe # empirically check the Electron view APIs on this platform
```

Requires Node 18+ and Electron 43+ (for `BaseWindow`, `WebContentsView`,
`View.setVisible`, and animated `View.setBounds`). Target deployment is Windows;
development is on macOS.

`Cmd/Ctrl+Shift+E` enters layout edit mode: drag a panel to move it, drag a side
handle to resize one axis (the page reflows), drag a corner to scale
proportionally (the page zoom follows the frame). Edges snap to each other, to
the wall edges, and to the wall centre lines; hold `Alt` to defeat snapping. Esc
saves the layout back to the config file, `Shift`+Esc discards it.

`Cmd/Ctrl+F` toggles between owning the whole display and an 85% window, so the
app can be driven on a dev machine without taking over the screen.
`Cmd/Ctrl+Shift+Q` quits. In dev, `Cmd/Ctrl+Shift+I` opens devtools for the
active panel and `Cmd/Ctrl+Shift+G` forces a return to the grid.

On macOS the wall uses simple fullscreen rather than kiosk: every native
fullscreen and kiosk path leaves the menu-bar strip uncovered, which reads as a
black gap across the top of the wall. See `docs/validation.md` and
`npm run probe:fs`.

## Build

```sh
npm run build:win   # Windows installer + zip, into dist/
npm run build:mac   # unpacked .app, for checking packaging locally
npm run icon        # regenerate build/icon.png
```

Packaging is electron-builder, configured in `electron-builder.yml`. The Windows
build produces both an NSIS installer and a zip, because whether Honeywell IT
will allow an installer to run on the show PC is still open: the zip covers the
case where it will not.

Builds are **unsigned** for now. Once there is a certificate, set `CSC_LINK` and
`CSC_KEY_PASSWORD` as repository secrets and electron-builder picks them up with
no config change.

Windows builds run in CI on `windows-latest`, which is also the only place they
are known to work: building a Windows installer from macOS is not part of this
setup.

### Where the config lives once installed

In development the app reads `config/wall.json` from the repo. In a **packaged**
app that file is inside `app.asar` and read-only, so on first run it is copied to
the user data directory and the app reads and writes that copy:

|         |                                                 |
| ------- | ----------------------------------------------- |
| Windows | `%APPDATA%\Forge\wall.json`                     |
| macOS   | `~/Library/Application Support/Forge/wall.json` |

That is the file the layout editor saves to, so a layout tuned at the wall
survives a reinstall. `FORGE_CONFIG` still overrides it.

## CI

Three GitHub Actions workflows:

- **CI** (`ci.yml`) - lint and tests on every push to `main` and every PR, on
  both Ubuntu and Windows. Installs with `--ignore-scripts` to skip Electron's
  binary download, which the tests do not need.
- **Build Windows** (`build-windows.yml`) - on a `v*` tag or manual dispatch.
  Not on every push: Windows runners bill at 2x on a private repo.
- **Probe Windows** (`probe-windows.yml`) - manual. Runs the two Electron probes
  on a Windows runner to answer the open platform questions in
  `docs/validation.md`. A runner is not the show PC, so treat it as a signal
  rather than sign-off.

## Configure

Everything layout- and content-related lives in `config/wall.json` so the URLs,
rectangles, and per-panel zoom can change without touching code:

```jsonc
{
  "wall": { "width": 3840, "height": 2160, "backgroundColor": "#000000" },
  "idleReturnMs": 240000, // auto-return to grid after inactivity (0 = never)
  "showHotspotHint": true, // subtle hover highlight on the four panels in grid mode
  "backButton": { "x": 24, "y": 24, "width": 176, "height": 56 },
  "views": [
    {
      "id": "view-1",
      "url": "https://.../dashboard-1",
      "grid": { "x": 0, "y": 0, "width": 1920, "height": 1080 },
      "zoom": 1.0, // per-panel scale, independent of the others
      "partition": "persist:forge-1", // persistent session so logins survive restarts
    },
    // ...four total
  ],
}
```

The committed config uses placeholder `example.com` URLs and a 3840x2160 2x2
grid. Replace the URLs with the real Honeywell dashboards and set the wall
resolution and rectangles to the actual LED wall once known.

## Files

- `src/main.js` - Electron main process: window, four content views, overlay,
  the grid/active state machine, session partitions, watchdog, idle return.
- `src/config.js` - config loading, validation, defaults, and writing an edited
  layout back. No electron import, so it is testable with plain node.
- `src/layout.js` - pure layout geometry: clamping a panel to the wall and
  snapping its edges to the wall and its neighbours. Also electron-free.
- `src/preload.js` - safe bridge for the overlay (activate a panel, go back,
  receive state).
- `src/content-preload.js` - injected into each page only to report user
  activity so the idle timer resets during use. Exposes nothing to the page.
- `src/overlay.html` / `src/overlay.js` - the transparent hotspot layer and the
  Back button.
- `config/wall.json` - layout and content config.
- `config/local-dev.json` - dev config pointing at the mock dashboards
  (gitignored).
- `src/dev/` - dev-only harness: `dev.js` launcher, `mock-server.js`, the mock
  dashboard pages under `mock/`, `probe.js` for checking Electron view APIs, and
  `fsprobe.js` for checking which fullscreen path covers the display.
- `test/config.test.js`, `test/layout.test.js` - config and geometry tests
  (`npm test`).
- `electron-builder.yml` - packaging config. `build/icon.png` is the source
  image, generated by `src/dev/make-icon.js`.
- `.github/workflows/` - CI, the Windows build, and the Windows probe.
- `docs/validation.md` - what has been observed running, and what is still
  unverified.
