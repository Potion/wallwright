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

`Cmd/Ctrl+Shift+E` enters layout edit mode, where the whole montage is editable
at the wall without touching JSON:

| gesture                   | effect                                                  |
| ------------------------- | ------------------------------------------------------- |
| drag a panel's body       | move it                                                 |
| drag a **side** handle    | resize one axis; the page reflows into the new viewport |
| drag a **corner** handle  | scale proportionally; page zoom follows the frame       |
| drag on **empty wall**    | draw a new panel                                        |
| `+ Add panel`             | drop a new panel in the middle                          |
| click a panel             | select it, opening the inspector                        |
| `Del` / `Backspace`       | delete the selected panel                               |
| hold `Alt` while dragging | defeat edge snapping                                    |
| `Esc` / `Shift`+`Esc`     | save the montage to config / discard                    |

Edges snap to each other, to the wall edges, and to the wall centre lines, so
panels tile without seams.

The inspector edits the selected panel's **URL, label, zoom and session**, and
deletes it. Panels default to their own session, but can share another panel's:
several views of the same SSO-protected app should sit behind one login rather
than making an operator sign in once per panel.

`Cmd/Ctrl+F` toggles between owning the whole display and an 85% window, so the
app can be driven on a dev machine without taking over the screen.
`Cmd/Ctrl+Shift+Q` quits. In dev, `Cmd/Ctrl+Shift+I` opens devtools for the
active panel and `Cmd/Ctrl+Shift+G` forces a return to the grid.

On macOS the wall uses simple fullscreen rather than kiosk: every native
fullscreen and kiosk path leaves the menu-bar strip uncovered, which reads as a
black gap across the top of the wall. See `docs/validation.md` and
`npm run probe:fs`.

Owning the whole display also means that on a notched MacBook, page content sits
under the camera housing. The deployment machines have no notch, so this is
opt-in rather than automatic: set `wall.safeAreaTop` to `"auto"` in a local dev
config and the wall is laid out below the notch instead. The editor's own
toolbar sits at the bottom of the screen for the same reason, where nothing
obstructs it on any Mac.

## Build

```sh
npm run build:win      # Windows: NSIS installer + zip, into dist/
npm run build:mac      # macOS: arm64 and x64 dmgs
npm run build:mac:dir  # macOS: unpacked .app only, faster, for a quick check
npm run icon           # regenerate build/icon.png
```

### Screenshotting the wall

```sh
FORGE_CONFIG=./config/my-wall.json \
FORGE_CAPTURE_OUT=./wall.png \
npm run capture
```

Renders the wall and writes a single PNG of it, at the display's device pixel
ratio. It captures each panel with `webContents.capturePage()` and composites
them at their wall coordinates, so it needs no OS screen-recording permission
and works where `screencapture` cannot run: a terminal without that permission,
a CI runner, a headless show PC.

`FORGE_CAPTURE_SETTLE` (default 7000ms) is how long to wait after load before
capturing; raise it for pages with charts or maps that draw late.

### Dev flags

With `FORGE_DEV=1`:

| variable             | effect                                          |
| -------------------- | ----------------------------------------------- |
| `FORGE_START_EDIT=1` | boot straight into layout edit mode             |
| `FORGE_SELFTEST=1`   | run the panel CRUD smoke test and log each step |

`FORGE_SELFTEST` exists because nothing in `src/main.js` has unit tests: it
imports electron at module scope. It drives the real path instead, through the
overlay's bridge and over IPC into the same handlers a click reaches, covering
add, URL change, session sharing, zoom and delete.

Packaging is electron-builder, configured in `electron-builder.yml`.

The exhibit runs on Windows; the macOS build exists for development and for
showing the thing to people on their own machines. The Windows build produces
both an NSIS installer and a zip, because whether Honeywell IT will allow an
installer to run on the show PC is still open and the zip covers the case where
it will not.

Windows builds run in CI on `windows-latest`, which is the only place they are
known to work: building a Windows installer from macOS is not part of this setup.
macOS dmgs build locally and on `macos-latest`.

### Signing

Every build is currently **unsigned**, because there is no certificate for
either platform.

- **Windows:** set `CSC_LINK` and `CSC_KEY_PASSWORD` as repository secrets;
  electron-builder picks them up with no config change. Unsigned installers may
  be warned about or blocked by SmartScreen.
- **macOS:** `identity: null` in `electron-builder.yml` currently disables
  signing outright. To sign and notarize, remove that line and add `CSC_LINK`,
  `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
  `APPLE_TEAM_ID`. Until then Gatekeeper quarantines the app on any machine that
  downloads it, and it has to be opened once with right-click then Open, or
  cleared with `xattr -dr com.apple.quarantine /Applications/Forge.app`.

A signed build is easier for Honeywell IT to approve, which is an open question
in `AGENTS.md`.

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
- **Build macOS** (`build-mac.yml`) - same triggers. macOS runners bill at 10x,
  so this one especially is not on every push.
- **Probe Windows** (`probe-windows.yml`) - manual. Runs the two Electron probes
  on a Windows runner to answer the open platform questions in
  `docs/validation.md`. A runner is not the show PC, so treat it as a signal
  rather than sign-off.

## Configure

Everything layout- and content-related lives in `config/wall.json` so the URLs,
rectangles, and per-panel zoom can change without touching code:

```jsonc
{
  "wall": {
    "width": 3840,
    "height": 2160,
    "backgroundColor": "#000000",
    "displayLabel": null, // match screen.getAllDisplays().label to pick the wall output
    "displayId": null, // or match by display id
    "kiosk": true,
    "fullscreen": true,
    "fitToDisplay": true, // scale and centre the authored layout into the window
    "safeAreaTop": null, // "auto" keeps the wall clear of a MacBook notch
  },
  "idleReturnMs": 240000, // auto-return to grid after inactivity (0 = never)
  "showHotspotHint": true, // subtle hover highlight on the panels in grid mode
  "hideInactiveWhenActive": false, // hide the others while one is fullscreen
  "transitionMs": 220, // promote/return animation (0 = snap)
  "escToGrid": "single", // "single" | "double" | "off"  (see AGENTS.md)
  "backButton": { "x": 24, "y": 24, "width": 176, "height": 56 },
  "views": [
    // May be empty: a montage can be built from a blank wall in the editor.
    {
      "id": "view-1",
      "label": "Dashboard 1",
      "url": "https://.../dashboard-1",
      "grid": { "x": 0, "y": 0, "width": 1920, "height": 1080 },
      "zoom": 1.0, // per-panel scale, independent of the others
      "partition": "persist:forge-1", // persistent session; may be shared with another panel
      "allowedOrigins": [], // empty = permissive; populate to lock navigation down
    },
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
