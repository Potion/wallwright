# Forge validation record

What has actually been observed running, versus what is still assumed. The point
of this file is the "Known risks / things to validate" section of `SPEC.md`: the
overlay architecture was chosen over capture-based approaches on the assumption
that a transparent `WebContentsView` composites over its siblings, and that
promoting a panel does not disturb its session. Both are now confirmed on the dev
machine.

Every result below is from the dev harness (`npm run dev`), which serves four
local mock dashboards instead of the real Honeywell URLs. See "Not yet
validated" for what that harness cannot tell us.

## Environment

|                 |                                                             |
| --------------- | ----------------------------------------------------------- |
| Date            | 2026-08-21                                                  |
| Electron        | 43.4.1 (Chromium 150.0.7871.224)                            |
| Platform        | macOS 25.5.0 (darwin), dev machine                          |
| Config          | `config/local-dev.json`, 1600x900 wall, four 800x450 panels |
| Target platform | Windows, **not yet tested**                                 |

## Confirmed

### Overlay alpha compositing: WORKS

A transparent `WebContentsView` sized to the whole wall, added last so it sits
on top, composites correctly over the four sibling content views. All four mock
dashboards render normally with the full-wall overlay above them.

This is the decision gate from `SPEC.md`. **None of the three documented
fallbacks are needed on macOS.** Re-test on the Windows show PC before
considering this closed, since that is the platform that actually matters.

### Layout editor: WORKS

`Ctrl/Cmd+Shift+E` enters layout edit mode. Confirmed by observation plus the
numbers in the log: a corner drag on `view-4` produced

```
view-4: 2063x1161 at 1777,998 zoom 0.806 (wall units)
```

2063 x 1161 is exactly 16:9, so the aspect lock holds, and 0.806 is
`0.75 * (2063 / 1920)`, so the page zoom tracked the frame proportionally. That
is the corner-drag contract: **corners scale**, content follows the frame.

Side handles, body drag, snapping, and save-on-Esc are all confirmed too. See
"Edge snapping" below for the numbers. Still unconfirmed: that Shift+Esc
discards rather than saves.

### Edge snapping: WORKS

Panel edges snap to each other, to the wall edges, and to the wall centre lines,
with cyan guide lines drawn while a drag is live. Hold Alt to defeat it.

Snapping happens twice on purpose. The overlay snaps in window pixels so the
drag feels right under the hand, then the main process re-snaps the driven edge
in wall units before anything is saved. Without the second pass, an edge that
looked snapped while previewing a 4K layout on a laptop could save as 1919
against a neighbour's 1920, which is a visible seam at wall resolution.

Confirmed from a live session:

```
view-3: 1498x1080 at 0,1080     zoom 1
view-4: 2342x1080 at 1498,1080  zoom 0.75
view-4: 2342x1308 at 1498,851   zoom 0.75
view-4: 2784x1555 at 1056,605   zoom 0.892
layout saved to .../smoke.json
```

- view-3's right edge is `0 + 1498`, view-4's left edge is `1498`. **Exact, no
  seam.** view-4's right edge is `1498 + 2342 = 3840`, the wall edge, also exact.
- Heights stayed at exactly 1080 through the horizontal drags, and widths at
  exactly 2342 through the vertical one. A side drag touches one axis only, and
  the untouched axis no longer drifts a unit from the pixel round trip.
- Zoom held at 1 and 0.75 through every side drag, then moved to 0.892 on the
  corner drag: `0.75 * (2784 / 2342)`. Aspect went 2342/1308 = 1.7905 to
  2784/1555 = 1.790, preserved.

34 tests cover this geometry (`test/layout.test.js`), including a case asserting
that snapped neighbours share an exact edge.

### Fullscreen on macOS needs simple fullscreen, not kiosk

Every native fullscreen and kiosk path reports `isFullScreen: true` while
stopping 39px short of the top of the display, leaving the menu-bar strip
uncovered. On the wall that is a black gap across the top, and the layout gets
scaled to fit 1130px instead of 1169px. Measured with `npm run probe:fs` on
Electron 43.4.1, 1800x1169 display:

| variant                            | content bounds | covers display |
| ---------------------------------- | -------------- | -------------- |
| constructor `fullscreen` + `kiosk` | y:39 h:1130    | no             |
| constructor `kiosk` only           | y:39 h:1130    | no             |
| constructor `fullscreen` only      | y:39 h:1130    | no             |
| `setKiosk(true)` after creation    | y:39 h:1130    | no             |
| `setSimpleFullScreen(true)`        | **y:0 h:1169** | **yes**        |

So on darwin the app uses `setSimpleFullScreen`, applied after construction
rather than as a constructor option. Confirmed fixed: the log now reads
`layout 1800x1169 in a 1800x1169 window, 1:1`.

**Windows is unverified.** It is expected to behave with the normal fullscreen
path, and `applyFullscreen()` branches on platform on that assumption. Run
`npm run probe:fs` on the show PC to confirm before trusting it.

### Layout must be recomputed after the window settles

Entering fullscreen is asynchronous, so the layout computed during
`createWall()` can be against the smaller pre-fullscreen bounds. If no resize
event follows, it stays wrong: the wall letterboxes and every panel is scaled
slightly. `refreshLayout()` now re-reads the window on every state transition
rather than trusting the last value.

### Uncovered wall area needs a real backdrop

Shrink a panel in the layout editor and the strip it vacates kept a stale copy
of the page instead of clearing to the wall colour. The window's own
`backgroundColor` does not repaint that region, so an opaque `View` now sits at
the bottom of the z-order across the whole window. Reproduced and fixed: the
band was wall x 622..901, exactly the strip a panel vacated when narrowed from
900 to 619.

### Windows: view APIs match macOS, and every fullscreen path covers the display

Answered by the **Probe Windows** workflow (`windows-latest`, Electron 43.4.1,
1024x768 virtual display), not by assumption.

View APIs are identical to macOS, so nothing platform-specific is needed there:

```
initialOrder      abc
addChildView(a)   bca     <- reorders in place, same as macOS
addChildView(b,2) cab
hasSetVisible     true
hasGetVisible     true
animatedSetBounds ok
```

That means `bringToTop()`'s remove + add fallback is dead code on Windows too.
It can go, but it costs nothing and no real Windows hardware has run it yet.

Fullscreen is where the platforms differ, and Windows is the easy one. **All five
variants covered the whole display** (`content: {x:0, y:0, 1024x768}`,
`coversDisplay: true`), including the constructor options that fall 39px short on
macOS. So `applyFullscreen()`'s non-darwin branch is correct: Windows needs no
special case, and the macOS simple-fullscreen workaround stays scoped to darwin.

**Caveat: a CI runner is not the show PC.** The display is a 1024x768 virtual
one with no real GPU. This settles the API questions, which are
platform-behaviour questions. It does **not** settle overlay alpha compositing,
which still has to be judged by eye on the real wall, and it says nothing about
4K performance.

### The macOS build produces working dmgs

`npm run build:mac` produced both, verified by mounting the arm64 one:

| artifact                | size   |
| ----------------------- | ------ |
| `Forge-0.1.0-arm64.dmg` | 114 MB |
| `Forge-0.1.0-x64.dmg`   | 116 MB |

Inside: `Forge.app` with the drag-to-Applications layout,
`CFBundleName = Forge`, `CFBundleIdentifier = com.potion.forge`, thin arm64.

Unsigned, and `identity: null` in `electron-builder.yml` now says so explicitly
rather than letting electron-builder hunt the keychain and report unrelated Jamf
certificates, which read like a failure and was not. Consequence: Gatekeeper
quarantines the app on any machine that downloads it. Open it once with
right-click then Open, or clear it with
`xattr -dr com.apple.quarantine /Applications/Forge.app`.

### The Windows build produces installable artifacts

`build-windows.yml` on `windows-latest` produced, after lint and tests passed:

| artifact                               | size   |
| -------------------------------------- | ------ |
| `Forge-0.1.0-x64.exe` (NSIS installer) | 103 MB |
| `Forge-0.1.0-x64.zip`                  | 145 MB |

Neither has been run on Windows yet; see the checklist. Both are unsigned.

### The MacBook notch, and what is done about it

Owning the whole display on a notched MacBook puts content under the camera
housing. Two separate problems, handled differently:

- **The editor's own chrome** was centred at the top, which is exactly where the
  notch is: it cut the middle out of the toolbar. Moved to the bottom of the
  screen, where nothing obstructs it on any Mac. No config, no platform check,
  and it reads the same on the wall.
- **Page content** under the notch is opt-in to fix, because the show PC has no
  notch and insetting the wall by default would make every macOS preview
  geometrically unfaithful. `wall.safeAreaTop: "auto"` measures the inset macOS
  reports and lays the wall out below it. Verified:
  `layout 1800x1169 in a 1800x1169 window, scaled to 0.967, keeping 38px clear at the top`.

Set to `"auto"` in the local dev configs. The committed `config/wall.json` leaves
it off, so deployment behaviour is unchanged.

### Panel CRUD works end to end

`src/main.js` has no unit tests, so `FORGE_SELFTEST=1` drives the real path:
the overlay's bridge, over IPC, into the same handlers a click reaches.

```
selftest 1: start with 2 panels: a,b
selftest 2: after add: 3 panels: a,b,panel-3
selftest 2: new panel partition persist:panel-3, url "" (placeholder expected)
selftest 3: after url set: url="https://example.com/" label="Added by selftest"
selftest 4: after sharing session: persist:a used by a + panel-3
selftest 4: view count still matches config: true
selftest 5: after zoom: 0.5
selftest 6: after delete: 2 panels: a,b
selftest 6: views and config still aligned: true
selftest 6: back to the starting count: true
selftest 7: overlay still frontmost: true
```

The last two lines are the ones that matter most. `contentViews` runs parallel to
`config.views`, so a bug in add or delete desynchronises them and every panel
after the change gets the wrong bounds. And the overlay has to stay frontmost
through all that churn or the wall stops responding to clicks entirely.

Deleting a panel shifts every later index, which is why no handler captures its
index any more: they resolve it from the spec object at call time. A promoted
panel that gets deleted also drops the wall out of active mode.

Still to check by hand: that a shared session really does mean one login (the
self-test confirms the wiring, not the cookie behaviour), and that a panel
created by drawing on empty wall lands where it was drawn.

### The wall composites correctly, captured end to end

`npm run capture` rendered four live public sites in a 2x2 grid and wrote a
single 3600x2338 PNG: a Grafana dashboard, a live wind-map globe, NASA's APOD,
and Hacker News. All four painted fully, at their configured rectangles, with no
browser chrome and no seams.

This is also independent evidence for the compositing claim above: each panel is
captured from its own `webContents` and drawn at its wall coordinates, and the
result matches what is on the display.

The tool exists because OS screen capture is not always available. It needs no
Screen Recording permission, so it also works on a CI runner or a headless show
PC.

### Packaging works, and it is what fixes the app name

`npm run build:mac` produces `Forge.app` with `CFBundleName = Forge`, which is
the only thing that changes the macOS menu-bar title: `app.setName()` does not
touch it. Verified on the packaged build:

- The asar contains exactly the runtime files. `src/dev/**` and `test/**` are
  excluded, so no mock server or probe ships in an exhibit.
- First run seeds the writable config and reads it:
  `seeded ~/Library/Application Support/Forge/wall.json from the bundled default`.
  Without this the layout editor could not save in a packaged app, because the
  bundled config sits read-only inside `app.asar`.

Builds are unsigned; there is no certificate yet.

### Fixed: a relayout storm during the fullscreen transition

The packaged run logged **45 relayouts** at startup, each one re-bounding and
re-zooming all four live web views. Two causes, both fixed:

- The window was created at wall size (3840x2160) on a 1800x1169 display, so
  macOS animated the shrink, emitting a resize per frame. It now starts at the
  display's size when it is going fullscreen anyway.
- Resize events were handled individually. They are now coalesced on a 120ms
  timer, so a transition produces one relayout.

Startup went from 45 relayouts to 1.

### Fixed: display retargeting fought fullscreen

The `display-metrics-changed` handler forced the window to `wall.width` x
`wall.height` unconditionally. Entering fullscreen fires that event, so the
window was yanked to 3840x2160 mid-transition and then back. It now only moves
the window when it is on the wrong output, and relocates by leaving fullscreen,
moving, and re-entering.

### Display fit: WORKS

`wall.fitToDisplay` (default on) scales and centres the authored layout to
whatever window it gets. The dev config now authors the real 3840x2160 wall and
previews it at scale 0.469 on the laptop, so the layout being tuned is the
layout that ships. On a display that matches the config the scale is 1 and
nothing moves.

### Grid to active transition and Back button: WORKS

Clicking a panel in grid mode promotes it to fullscreen, and the corner Back
button returns it to the grid. So the overlay is capturing clicks in grid mode
and the shrunk active-mode overlay is still hit-testable, which together are the
whole interaction model.

### Child view z-order semantics: reorder in place

Answered empirically by `npm run probe` rather than assumed:

```
initialOrder      abc
addChildView(a)   bca     <- re-adding an existing child REORDERS, does not no-op
addChildView(b,2) cab     <- the index argument reorders too
hasSetVisible     true
hasGetVisible     true
animatedSetBounds ok
```

So `bringToTop()` raises a view without a detach/reattach cycle, and its
remove + add fallback is dead code on this build. It is kept because the probe
has not been run on Windows.

This also settles the Electron version question: `View.setVisible()` exists on
43.4.1. The scaffold called it while pinned to Electron `^31`, which is why the
pin was moved to `^43`.

### Native animated bounds: WORKS

`View.setBounds(bounds, { animate: { duration, easing } })` does not throw. The
promote/return animation (`AGENTS.md` TODO 6) is therefore a config value
(`transitionMs`, default 220) rather than a hand-rolled tween.

### Display targeting warns correctly

On the dev machine the app reports both of the things that will matter on the
show PC:

```
falling back to the PRIMARY display "Built-in Retina Display" (id 1).
  Set wall.displayLabel or wall.displayId to target the LED wall output.
wall config is 1600x900 but display "Built-in Retina Display" is 1800x1169.
  Panel rectangles will not land where you expect until these agree.
```

Silently landing on the wrong output, or on an output whose resolution disagrees
with the authored rectangles, is the most likely way this fails at the venue.
Both now say so loudly.

### Config validation

12 tests in `test/config.test.js`, all passing (`npm test`). Rejects rects that
fall outside the wall, duplicate view ids, two views sharing a session
partition, missing wall dimensions, and bad `escToGrid` values. A malformed
config now shows a readable error page on the wall instead of a stack trace.

## Still to verify

Grouped by where each item can actually be done. Nothing here is known broken;
these are the things the automated tests and the dev harness cannot settle.

### A. On the dev machine, now

All mechanical, all just need hands and eyes. Run `npm run dev`.

- [ ] **Session persistence across restart.** Sign in on mock 1, quit
      (`Cmd/Ctrl+Shift+Q`), relaunch. Still signed in? Proves the `persist:`
      partition actually persists.
- [ ] **Page state survives dock/undock.** Sign in on mock 1, type into the
      scratch field, promote, Esc, promote again. The "Loaded at" timestamp must
      not change and the typed text must still be there. A changed timestamp
      means the view reloaded, which `SPEC.md` forbids.
- [ ] **Esc docks the wall.** With `escToGrid: "single"`, promote a panel and
      press Esc once: it should return to the grid. On mock 2, confirm the
      consequence too, that the page's own Esc-to-close modal no longer fires.
      That is the accepted tradeoff, not a bug.
- [ ] **Keyboard focus.** Type into mock 2's input while it is promoted. If
      nothing appears, the `webContents.focus()` call in `activate()` is not
      taking effect and the wireless keyboard will have no target at the wall.
- [ ] **SSO popup.** On mock 3, click "Sign in with SSO". The popup must appear
      centred on the wall, not off-wall or behind the panels, and Continue must
      report back into the panel.
- [ ] **Popup activity keeps the wall awake.** With `idleReturnMs: 15000`, open
      the mock 3 popup and keep typing in it for over 15 seconds. The wall must
      not dock and close the popup underneath you. This is why the content
      preload is injected into popups.
- [ ] **Per-panel zoom.** Mock 4 is at `zoom: 0.75` while its neighbours are at
      1.0. Its text should be visibly smaller, and promoting it then returning
      must not leak zoom onto any other panel.
- [ ] **Background liveness.** Mock 4's tick counter must keep counting while
      another panel is promoted fullscreen.
- [ ] **Idle auto-return.** Promote a panel, stop touching it, confirm it docks
      after ~15s and is still signed in afterwards.
- [ ] **Watchdog, both paths.** Kill a background panel's renderer from Activity
      Monitor and confirm a backoff reload in the log. Then kill the _promoted_
      panel's renderer and confirm the log says `deferring reload ... until it is
no longer active`, and that it only reloads after docking. The second path
      is the one that protects an operator's login.
- [ ] **Discarding a layout edit.** Esc-to-save is confirmed. Confirm the other
      half: edit, press Shift+Esc, and the change must be dropped rather than
      written to config.
- [ ] **Editing the production config.** Layout edit mode writes to whatever
      `FORGE_CONFIG` points at. Run once against `config/wall.json`, edit, save,
      and check `git diff` is a clean readable change to `grid` and `zoom` only,
      with no defaults injected and no key reordering.
- [ ] **Cmd/Ctrl+F toggle.** Flips between owning the display and an 85% window.
      Confirmed working on macOS; confirm the windowed layout is still correct
      and that toggling back restores 1:1.
- [ ] **The fatal-config path.** Point `FORGE_CONFIG` at a deliberately broken
      file. A readable error page should appear instead of a stack trace. The
      code path exists and is unit tested, but the rendered page has never
      actually been looked at.
- [ ] **Single-instance lock.** Launch twice. The second should refuse and exit
      rather than fighting over the wall. Never exercised.
- [ ] **Promote/return animation.** `transitionMs` is 220. Animated `setBounds`
      is confirmed not to throw, but the animation itself has not been watched.
- [ ] **`hideInactiveWhenActive`.** Default `false`. Flip it to `true` and check
      whether the hidden panels keep running (mock 4's ticker) or get throttled.
      That decides whether it is safe to use for GPU headroom on a 4K wall.

### B. Needs the real dashboards

Blocked on the real URLs, and each one is a place a real enterprise app may
behave differently from a mock.

- [ ] **Do any dashboards need Esc?** If one uses Esc for its own modals,
      `escToGrid` should move to `"double"` or `"off"`. See the decision below.
- [ ] **Per-panel `zoom` values.** Set them against the real dashboards at the
      real wall resolution. `SPEC.md` flags that enterprise apps often do not
      reflow to arbitrary sizes, which is the whole reason zoom exists here.
- [ ] **`allowedOrigins`.** The enforcement code is written for both
      `will-navigate` and `setWindowOpenHandler` but has never run against a
      populated list. Scope it to the real IdP and app domains, then confirm a
      legitimate cross-subdomain navigation is not blocked by accident.
- [ ] **Popup preload against a real IdP.** `content-preload.js` is now injected
      into SSO popups so their activity resets the idle timer. Confirm it does
      not trip a real identity provider's CSP or break its flow.
- [ ] **Whether the real SSO flow uses a popup at all.** Some redirect in place,
      which exercises `will-navigate` instead.

### C. Needs the Windows show PC and the real wall

macOS passing does not settle the target platform. This group is the real risk.

- [ ] **Install the built artifact on the show PC.** The installer and zip build
      in CI but have never been run on Windows. Check the NSIS install, that the
      config seeds to `%APPDATA%\\Forge\\wall.json`, and that the layout editor
      can save there without admin rights.
- [ ] **Code signing, both platforms.** Unsigned Windows builds may be blocked
      or warned about by SmartScreen, and a signed build is easier for Honeywell
      IT to approve. Unsigned macOS builds are quarantined by Gatekeeper on any
      machine that downloads them. Needs certificates first; README "Signing"
      lists the secrets each platform wants.
- [ ] **Run a dmg on a Mac that did not build it.** The arm64 dmg was verified
      by mounting it and reading the bundle, but never installed and launched
      from a quarantined download, which is the path anyone else will take.
- [ ] **Auto-launch on boot and crash restart.** Not built. Required for
      unattended operation.
- [ ] **Overlay alpha compositing on Windows.** Now the single most important
      open item, and the one CI cannot answer because it needs eyes on real
      hardware. The whole architecture was chosen over capture-based approaches
      on the assumption this works. It works on macOS; if it renders opaque on
      Windows, implement one of the `SPEC.md` fallbacks.
- [ ] **Re-run the probes on the real show PC.** CI answered them on a 1024x768
      virtual display. Confirm on the actual hardware and wall resolution.
- [ ] **Display targeting.** Set `wall.displayLabel` or `wall.displayId` to the
      real LED wall output and confirm the window lands there rather than on the
      operator's monitor. Only the primary-display fallback path has ever run.
      Note that `pickWallDisplay()` was accidentally deleted and restored during
      the layout-geometry extraction, and it has no automated test, so read it
      before trusting it.
- [ ] **Display hotplug.** `display-added` / `display-removed` /
      `display-metrics-changed` all re-target the window. Written, never
      exercised. An LED controller enumerating late at boot is the case this
      exists for.
- [ ] **Snapping at scale 1.** All snapping so far was verified at scale 0.469
      while previewing. At 1:1 the main-process re-snap becomes a near no-op and
      the tolerance collapses to its 2-unit floor. Confirm it still snaps
      cleanly and does not over-snap.
- [ ] **Live drag feel at 4K.** Bounds and zoom update every animation frame
      during a drag, with four live dashboards behind it. If it degrades, draw
      only the overlay outline while dragging and commit on mouse-up.
- [ ] **Cursor auto-hide when idle.** Not built. Needs a native Windows
      approach; there is no cross-platform Electron API. The pointer should not
      sit on the wall between interactions.
- [ ] **Sustained run.** Leave it up for a working day against the real
      dashboards and watch for leaks, session expiry behaviour, and whether the
      watchdog fires more than expected.

### What CI covers

- `ci.yml` runs lint and the 34 tests on Ubuntu **and Windows** for every push
  to `main` and every PR. Windows is in the matrix because it is the deployment
  target and because it catches POSIX-only scripts and paths.
- `build-windows.yml` builds the installer and zip on `windows-latest`, on a
  `v*` tag or manual dispatch. It runs lint and tests first, so a failing build
  cannot ship.
- `probe-windows.yml` is manual, and is the cheapest way to answer several
  group C items below without the show PC.

Verified before pushing by simulating the CI job in a clean checkout: this is
how the gitignored-dev-config test failure was caught, since `config/local*.json`
does not exist outside a dev machine. That test now skips when the file is
absent.

### Gaps in the automated tests

Worth knowing what the 34 passing tests do and do not cover.

- Covered: config validation and defaults, `saveLayout` round-tripping, and all
  the clamp and snap geometry in `src/layout.js`.
- Not covered: everything in `src/main.js`. It imports electron at module scope
  and has module-level side effects, so the state machine, the Esc policy, the
  watchdog, and `pickWallDisplay()` have no unit tests. They are only exercised
  by running the app. If any of those grow, extracting them the way
  `src/layout.js` was extracted is the cheap way to get them under test.

## Decided: Esc returns to the grid on a single press

`escToGrid: "single"` (Jeff, 2026-08-21). Pressing Esc while a panel is
fullscreen returns to the grid, which is what `SPEC.md` asks for and what anyone
walking up to the wall will expect.

The tradeoff to keep in mind once the real dashboards are wired up: a single Esc
is consumed by the wall, so a dashboard that uses Esc to close its own modals or
dropdowns will not see the key. If that turns out to matter, it is a one-word
config change:

- `"double"` - the first Esc reaches the page, a second press within
  `escDoubleMs` (600ms) docks the wall. Mock 2 in the dev harness exists to make
  this tradeoff concrete.
- `"off"` - Esc does nothing; the Back button and the idle timeout are the only
  ways back.

The policy lives in one place (`handleEscape()` in `src/main.js`), shared by the
per-view key handler and the overlay, so the two cannot drift apart.

What must never come back is the scaffold's original approach: Esc registered as
a `globalShortcut`. That is an OS-level accelerator that fires regardless of
focus and consumes the key before any page sees it, so every Esc-driven control
in the dashboards would have been dead with no way to opt out.

## Decided: live drag updates stay

Panel bounds and page zoom update on every animation frame during a layout drag.
Confirmed to feel fine on the dev machine (Jeff, 2026-08-21). Worth re-checking
on the real 4K wall with four live dashboards behind it; if it degrades there,
the fix is to draw only the overlay outline during the drag and commit the real
bounds on mouse-up.

## Deliberately out of scope for this pass

Windows overlay transparency, cursor auto-hide, the navigation allow-list
domains, real per-panel zoom values, and packaging/signing. See the plan and the
`AGENTS.md` TODO list for why each is blocked.
