# Wallwright validation record

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
| Date            | 2026-08-21, Electron row updated 2026-08-31                 |
| Electron        | 44.1.0 (Chromium 152.0.7977.65), was 43.4.1 (Chromium 150)  |
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

23 tests cover this geometry (`test/layout.test.js`), including a case asserting
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

Those are the names this build actually carried: 0.1.0 predates the rename, and
this row records what was observed rather than what the app is called now. The
post-rename bundle is verified separately below.

Unsigned, and `identity: null` in `electron-builder.yml` now says so explicitly
rather than letting electron-builder hunt the keychain and report unrelated Jamf
certificates, which read like a failure and was not. Consequence: Gatekeeper
quarantines the app on any machine that downloads it. Open it once with
right-click then Open, or clear it with
`xattr -dr com.apple.quarantine /Applications/Wallwright.app`.

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

### What a reload actually costs, measured

"Never reload a panel, it drops the login" was the working assumption from the
start, including in `SPEC.md`. It is wrong, and `src/dev/session-probe.js`
measures what is actually true:

| operation                          | cookie session | sessionStorage | in-page state |
| ---------------------------------- | -------------- | -------------- | ------------- |
| `reload()`                         | survives       | survives       | lost          |
| `loadURL()` (watchdog, idle reset) | survives       | survives       | lost          |
| destroy and recreate the view      | survives       | **lost**       | lost          |

Cookies live in the `persist:` partition, which outlives the renderer entirely,
so even destroying a `WebContentsView` and building a new one leaves the user
signed in. What a reload really costs is the interaction in progress:
credentials half typed, an SSO redirect chain mid-flight, wherever an SPA had
been navigated to.

The never-reload rules were right, then, but for the wrong reason, and the
correct reason is narrower. Two consequences:

- **Refreshing a panel on a timer is safe** for logged-in dashboards, provided
  it skips panels somebody is using.
- **Recycling a renderer to reclaim memory is riskier than reloading**, and only
  in one specific way: `sessionStorage` is per-tab, so an app that keeps its
  access token there is signed out by a recycle but not by a reload. That is why
  recycling is opt-in.

Caveat: this was measured against the mock login, which uses a plain cookie. A
real IdP that holds an access token in JavaScript memory would need a silent
re-auth on reload. Usually invisible, occasionally not.

### Interactive grid panels

Panels are live in grid mode. No coordinate translation was needed: each panel
is a native `WebContentsView`, so Chromium routes and scales input to it,
`zoomFactor` included. The work was removing the full-wall overlay that was
swallowing every event, since a `WebContentsView` consumes any OS event landing
on it and cannot be made selectively transparent to input.

Overlay visibility per mode is what decides whether panels can be touched, so
the self-test asserts it:

```
selftest 8: grid: overlay hidden (panels interactive): true
selftest 8: select: overlay shown and full wall: true
selftest 8: active: overlay shown, shrunk to the back button: true
selftest 8: back to grid: overlay hidden again: true
selftest 8: edit: overlay shown and full wall: true
```

Clicks land in the right panel, confirmed with `WALLWRIGHT_LOG_INPUT=1`, which logs
which panel each event reaches:

```
input: mousedown -> view-2 (grid mode)
```

That was with the wall at scale 0.469 and offset inside the window, which is the
case that would expose a coordinate problem: a mistranslated click would have
been attributed to the wrong panel or to none.

Still to confirm: that typing follows the last click across panels. The main
process focuses the `mousedown` sender rather than relying on the platform,
which is a no-op if sibling views already take focus natively; the two have not
been distinguished.

### Idle behaviour is shaped by who has input

Only administrators have keyboard and mouse access, so **the wall is idle almost
all of the time**. Anything hung off the idle timer therefore fires constantly
in normal operation, which inverts what a sensible default looks like.

`idleResetUrls` was briefly defaulted to on, to stop a visitor leaving a panel
somewhere strange. With admin-only input that reasoning does not hold, and the
default was actively harmful: it would have reloaded every panel a few minutes
after the operator stopped typing, logging them out of dashboards meant to sit
signed in all day. It defaults to **off**, and the idle timeout returns to the
grid without touching the pages.

### The control surface works, and caught two things

Every route exercised against a running wall: status, preset recall, URL change,
promote, back to grid, reload one, reload all. Error paths return the right
codes: 404 for an unknown preset or panel, 400 for a missing id or malformed
JSON, 404 for an unknown route. Rendered in a real browser with no console
errors, and clicking a preset chip recalled it: panel count went to one, the
chip lit, and memory dropped from 1414MB to 730MB as the removed panel's
renderer was reclaimed.

Two bugs it surfaced:

- **The first status page shipped broken.** It built `onclick="..."` into the
  markup, which meant JavaScript quoted inside HTML inside a template literal,
  and the escaping collapsed: the served page would not parse and would have
  rendered blank. Rewritten with `data-` attributes and one delegated listener,
  which removes the nesting. The page's inline script is now extracted and
  syntax-checked as part of verifying it.
- **`startControlServer()` would have crashed on every production config.** It
  destructured `config.control`, which `withDefaults` was not filling in, so any
  config without an explicit `control` block threw at startup. It only worked in
  testing because the test config happened to set one. A test for the default
  caught it.

The drift flag earned itself immediately: a panel showed `now at
https://sf.thijs.gg/`, having been navigated away from its configured URL during
earlier interaction testing. That is precisely the state an unattended wall gets
into and nobody notices.

### Upkeep: refresh, recycle, and memory

An exhibit runs for weeks, so dashboards go stale and renderers grow. Both fixes
are timer-driven reloads, and both obey one rule: never touch a panel somebody is
using. The self-test proves that rule rather than the happy path:

```
selftest 10: idle panel refreshed on its timer: true
selftest 10: in-use panel left alone: true
selftest 10: resumes once quiet: true
selftest 10: recycle replaced the view: true
selftest 10: views and config still aligned: true
selftest 10: overlay still frontmost after recycling: true
```

`refreshMs` reloads a panel; `recycleMs` destroys the view and builds a new one.
They are not interchangeable, per the session probe above: a reload keeps
`sessionStorage`, a recycle does not. Recycling is what actually hands the
renderer process back, which is why it exists, and why it is off unless asked
for.

Memory is reported, not acted on, by default. An exhibit that restarts itself
unpredictably is worse than one that uses a lot of RAM, and the real numbers
should come before any tuning. Measured with two panels and the overlay:

```
memory: 699MB total (Tab 365MB, Browser 165MB, GPU 110MB, Utility 59MB)
```

That is the case for the feature: two panels already cost most of a gigabyte, so
a montage of eight on a wall running for a fortnight is worth watching. Setting
`memoryLimitMb` recycles the least recently used idle panel, one per check, so a
spike does not rebuild the whole wall at once.

Still to confirm: what memory actually does over days rather than minutes, which
only the sustained run below can answer.

### Instrumenting the memory countermeasure, and what it found

Built to make the sustained run below possible at all, and it found three defects
before that run has even started. Measured on the dev machine against
`config/local-demo.json`, four live public dashboards, with `memoryLimitMb` set
deliberately under the observed baseline so the ladder engaged immediately.

**Four live dashboards cost 1513MB.** The only previous figure was 699MB for two
panels against local mocks, which was not a baseline for anything. Split at that
moment: `Tab 1143MB, Browser 169MB, GPU 131MB, Utility 70MB`. Still macOS, still
not the show PC, and `workingSetSize` counts shared pages once per process, so
treat it as a trend rather than an accounting of unique bytes.

**The candidate ordering was wrong, and the log proves it:**

```
14 recycles in 40 seconds, every one of them demo-1
```

Ranking ascending on the last-touched timestamp looks like least-recently-used and
is not. A panel nobody has touched has no timestamp, so every untouched panel
shared the key 0 and a stable sort took the lowest index every time. Panel 1 was
rebuilt fourteen times while panels 2 to 4 were never considered, and untouched is
the normal state of an exhibit wall. Ranking is now by resident memory, which is
what the action is for, with ties breaking towards whatever has gone longest
without a rebuild. Same conditions afterwards: **five recycles, one per panel.**

**Recycling faster than a page loads costs memory rather than saving it:**

```
memory: 1513MB -> 1885MB -> 1804MB   (while recycling every five seconds)
```

The replacement renderer is up before the old one is gone, so the wall pays for
both. This is the evidence behind `minRecycleIntervalMs` and behind expressing
`memoryLimitMb` as a derivation from a measured baseline rather than a guess: a
limit inside the normal operating band rebuilds a panel on every check, forever.

**A rebuild resets a heavy panel, it does not shrink it.** From a manual
`POST /api/recycle` against a live dashboard:

```
old pid 92184 -> new pid 92205, gone=true
1478MB -> 1252MB after 2s, 1485MB after 6s (-7MB net)
```

The renderer really was handed back, and the replacement then took the memory
straight back. A single sample at +2s would have claimed a 226MB win that does not
exist, which is why the probe takes two and reports both. `gone` is the field that
matters: an old process id still present in `getAppMetrics()` is a leaked renderer.

With the limit set below the baseline, the ladder now gives up rather than churning:

```
the last recycle reclaimed 1MB, under the 50MB that counts (2 in a row)
no further action available: 3 recycles have not reclaimed 50MB
```

Said once, not every minute. That is also the signal that the growth is not in the
renderers at all, which is the only thing that justifies the rungs above it.

### The watchdog never backed off, and had not since it was written

```
counters: loads 141, failedLoads 141
```

Identical, because `did-finish-load` fires for Chromium's error page too. Every
failure therefore looked like a recovery, reset the attempt counter, and the
exponential backoff never advanced past its first step. Reading the code, the
backoff caps at 30 seconds and the obvious conclusion is that a broken panel
retries every 30 seconds forever; that was optimistic by two orders of magnitude.
Measured against a refused port, it was **four times a second**, indefinitely.

Fixed by distinguishing a failed navigation from a successful one per navigation
rather than by timing, and by not counting the diagnostic pages the app puts up
itself - loading the "could not be loaded" page counted as recovery, which cleared
the state and cancelled the retry that page had just promised the reader.

The bounded ladder, verified end to end with compressed timings:

```
dead failed to load http://127.0.0.1:1/: ERR_UNSAFE_PORT (-312)
reloading dead in 400ms (attempt 1, round 1)
reloading dead in 400ms (attempt 2, round 1)
reloading dead in 400ms (attempt 3, round 1)
dead: 3 reloads failed, rebuilding the view
reloading dead in 400ms (attempt 1, round 2)
...
dead: giving up after 2 rounds (ERR_UNSAFE_PORT (-312))
dead: trying again after a pause
```

At the shipped `retryMs` of ten minutes that is roughly 36 attempts an hour rather
than 14,500. A url-less panel is now left alone entirely, with zero watchdog
activity, rather than calling `loadURL('')` into a swallowed exception forever.

### What counts as activity, measured

A claim worth correcting, because it was made in a commit message before it was
tested. The argument for separating pointer motion from interaction rested on
Chromium dispatching synthetic mouse-move events when content moves beneath a
stationary cursor - which would mean a mouse left resting on a live dashboard
reports activity indefinitely, and on a wall with no cursor auto-hide that would
be the normal state.

`npm run probe:activity` parks a cursor, sends nothing else, and counts what
arrives over twelve seconds. **It does not reproduce that behaviour:**

| page                           | moves/second while unattended | sustained stream |
| ------------------------------ | ----------------------------- | ---------------- |
| animated (mock ticker)         | 0.08                          | no               |
| scrolled under a parked cursor | 0.08                          | no               |
| static (control)               | 0.08                          | no               |

One event in twelve seconds, identically on a page with nothing happening, on one
animating, and on one being scrolled under the cursor on purpose - scrolling being
the documented trigger. There is no stream, so **a stationary cursor cannot hold a
panel in-use for longer than `recentUseMs` after the last real motion.**

Two caveats on the method. The probe parks a synthetic cursor via
`sendInputEvent` in an offscreen window, which is not the same as a physical
cursor resting over a visible wall, so this narrows the claim rather than closing
it. And the single event in every case, including the static control, is
unexplained; it arrives during the watch window rather than with the parking
event, and it is the same everywhere, so it is treated as noise rather than as
signal.

The change it was used to justify stands on other grounds, which the earlier
commit message understated. Pointer motion is a weaker claim on a panel than a
click or a keypress: an operator moving the mouse across the wall to reach one
panel should not defer upkeep on every panel the cursor crosses. And throttling
those events to one a second is worth it regardless, since unthrottled motion
across several panels was the highest-frequency thing this app did and carried
almost no information.

### Overlay compositing on Windows: WORKS

The project's last architectural unknown, and the item `AGENTS.md` called the most
important unverified thing in it. **Confirmed on Windows 11.**

![The layout editor compositing over live pages on Windows](images/windows-compositing.png)

Edit mode on a packaged build: panel frames in the accent colour, corner and side
grips, the label bars with their green readouts, the inspector with its URL, label,
zoom and session fields, and the bottom edit bar - all drawn over **live page
content that is visible underneath**, the control page on the left and a live web
page on the right. Active mode composites too: a Back button over a promoted
panel. Grid mode is the control and shows the panels alone, because the overlay is
`setVisible(false)` there by design.

So none of the three fallbacks in `SPEC.md` are needed on either platform.

Run on **HQ-PROTO-MINI-2** (i7-14700, 31.6GB, Windows 11 Pro build 26200), from
git `ddafb04`, artifact `Wallwright-0.1.1-x64.zip`, sha256 `020be292...`, verified
by `certutil` against the local hash after transfer. Not the show PC, and not the
GitHub runner: a machine with a real signed-in console session, which is what made
this possible at all.

### How to run something on the wall machine from somewhere else

`docs/windows-runner.md` recorded this as blocked. It is not blocked; it needed a
machine with a desktop rather than a change to the runner.

The pattern, which works and is worth keeping:

- A **Scheduled Task with an `InteractiveToken` principal**, fired with
  `schtasks /run`. That is the only way into the console session. An SSH session is
  not it, and neither is a task set to run whether the user is logged on or not.
- A **wrapper `.cmd`** as the task action, because environment does not propagate
  through `schtasks /run`: the task carries its own.
- **Everything else over SSH.** Loopback TCP crosses the session boundary freely,
  so `GET 127.0.0.1/api/status` works from the SSH session even though the app is
  in session 1. Only display enumeration and the screen grab have to be in-session.

Two settings that would have bitten, both Task Scheduler defaults:
`ExecutionTimeLimit` defaults to **`PT72H`**, which would kill a 72-hour soak at
exactly hour 72, so it is set to `PT0S`; and `Priority` defaults to 7, which is
below-normal process and low I/O priority, and would distort both rendering and any
memory measurement, so it is set to 4.

### Diagnostics on disk: confirmed on the platform that needed it

The reason the log exists is that a double-clicked Windows build has no stdout.
Verified end to end on a packaged build launched by a task with no console:

```
2026-08-25T08:33:51.235-04:00 info diagnostics log: C:\Users\Proto\AppData\Roaming\Wallwright\logs\wallwright.log
2026-08-25T08:33:51.238-04:00 info session runId=55948047 version=0.1.1 electron=43.4.1 chrome=150.0.7871.224 platform=win32-x64 release=10.0.26200 host=HQ-Proto-Mini-2 packaged=true config=... wall=3840x2160 panels=2
2026-08-25T08:38:01.520-04:00 info memory: 588MB total (Tab 240MB, GPU 186MB, Browser 106MB, Utility 56MB)
```

Creation is not the interesting part; **continuing to write** is. Sampled twice 95
seconds apart the file grew 2215 to 2429 bytes, one `memory:` line per minute. That
is the mechanism a multi-day soak depends on, working on the target platform.

The self-test also passed all 38 assertions on Windows, including the two that
matter most there: `the old renderer process was returned to the OS` (pid confirmed
gone from `getAppMetrics`) and `a line written through log() reached it`.

Per-panel memory attribution works on Windows: each panel reports its own `pid` and
`memoryMb` with `pidShared: false` for panels in separate partitions, so a rising
total can be blamed on a panel rather than on the wall.

### The display is not what any single query said it was

Four sources, four answers, and the disagreement is the finding:

| source                                                         | answer                                                    |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| `Win32_VideoController` (machine-wide WMI)                     | 3840x2160 @60Hz                                           |
| `[Screen]::AllScreens` **from an SSH session**                 | `WinDisc 1024x768`                                        |
| `[Screen]::AllScreens` **from the console session**, DPI-aware | `\\.\DISPLAY5 2160x3840`, primary                         |
| the app's own log, from inside that session                    | `layout 3840x2160 in a 1080x1920 window, scaled to 0.281` |

The truth: a 4K panel mounted in **portrait**, 2160x3840, at **200% display
scaling** (system DPI 192), so the app is handed a 1080x1920 logical window and
scales the authored 3840x2160 layout to 0.281.

Two lessons. The `WinDisc 1024x768` reading that `docs/windows-runner.md`
attributed to PROTO1-P8 being a session-0 service **is at least partly an artifact
of querying from an SSH session**: the same string appears here on a machine that
demonstrably has an active desktop. And any display measurement has to come from
the console session, DPI-aware, or it is measuring the wrong thing.

Consequence for the soak: this machine is a portrait touch display, not a wall.
Compositing is compositing at any geometry, so this run stands. A memory soak at
0.281 scale would not represent a 4K wall's raster and GPU load, so the geometry
has to be settled before T0 rather than after.

### Pre-registration: the 72-hour soak, thresholds fixed before T0

Written down before the run so the thresholds cannot be chosen after seeing the
curve. A threshold picked afterwards is not a threshold.

**Machine.** HQ-PROTO-MINI-2, i7-14700, 31.6GB, Windows 11 Pro build 26200.
Display is a 4K panel mounted in **portrait**, 2160x3840, at 200% scaling, so the
app gets a 1080x1920 logical window. `config/soak-72h.json` is authored at
1080x1920 so `wall.scale` is 1.0 and no layout scaling distorts the panels.

**Why that is still representative of a wall.** At 200% scaling Chromium
rasterises the window at device pixel ratio 2, so the real raster is 2160x3840 =
**8.29 megapixels**. A 3840x2160 wall is **8.29 megapixels**. The pixel count that
drives raster memory and GPU load is identical; only the aspect and the panel
arrangement differ. What does not transfer is the layout shape, and nothing here
speaks to the real Honeywell dashboards.

**The four arms**, chosen so a leak is attributable rather than merely visible:

| panel     | what it is                                                                                                                                                                                        | if it grows                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `control` | `soak-static.html`: no timers, no animation, no network, no DOM changes after load                                                                                                                | the growth is in Electron or in Wallwright. **The only result that would indict the product** |
| `heavy`   | `soak-heavy.html`: WebGL cube with textures allocated once, ~220 canvas primitives a frame, DOM pinned at 500 rows by removing from the head, one local fetch every 5s. Leak-free by construction | the growth is the engine under load, not the content                                          |
| `grafana` | `play.grafana.org`, a real dashboard                                                                                                                                                              | probably the page. Informative, not actionable                                                |
| `earth`   | `earth.nullschool.net`, WebGL plus live data                                                                                                                                                      | as above                                                                                      |

**Countermeasures are OFF**: `memoryLimitMb: 0`, no `refreshMs`, no `recycleMs`.
You cannot measure a leak while something is periodically resetting it, and the
ladder was already proven separately.

**Pass:** slope over the **final 24 hours** at or under **15 MB/hour**, which is
roughly 5GB over three weeks on a 31.6GB machine. Judged on the final window, not
the whole run, because Chromium legitimately climbs for hours before it settles, so
an early fit measures warm-up. The median cross-check must agree in sign and rough
magnitude; if it does not, the fit is being driven by a spike and neither number is
trusted. `src/dev/soak-stats.js` refuses to print a verdict at all from fewer than
30 samples or too short a window, which the harness shake-out earned: seven samples
over thirty seconds fitted 802 MB/hour while the medians read zero.

**Also fails, whatever the memory did:** any unexpected exit of the main process,
any panel crash that does not recover inside 60s, any sustained watchdog reload
cadence, any URL drift, or the `control` arm climbing.

**Invalidating conditions**, agreed in advance: a reboot, a locked or blanked
screen, any RDP session, any human input, or the mock server dying. Each is
detectable in the record afterwards, and a run that hits one is reported as partial
rather than quietly stitched together.

**Amendment, 2026-08-27, before the second run's T0.** The text above describes the
display as portrait 2160x3840 and the window as 1080x1920, which is what the first
run found. Between the runs the project that owns HQ-PROTO-MINI-2 rotated the panel
back to **landscape**, 3840x2160, giving a 1920x1080 logical window at 200%
scaling. `config/soak-72h.json` was re-authored to match, as a 2x2 of 960x540, and
the display is now matched by resolution rather than falling back to primary.

Nothing else changed, and nothing that was actually registered has moved: the
threshold is still 15 MB/hour over the final 24 hours, the median cross-check still
has to agree, the four arms are the same four pages, the countermeasures are still
off, and the invalidating conditions are unchanged. What the pre-registration fixed
about the geometry was the **raster**, and 3840x2160 at DPR 2 is the same 8.29
megapixels as 2160x3840 at DPR 2, so the two runs' memory series remain comparable.
`wall.scale` is 1.0 in both.

Recorded here rather than edited into the text above, because a pre-registration
that gets quietly rewritten after the fact is not a pre-registration.

### The 72-hour run: STARTED 2026-08-25T13:24:29Z

Live on HQ-PROTO-MINI-2 as of that timestamp, from git `ddafb04` (shipped source
identical to the harness commit: everything after it touched only `src/dev`,
config, docs and tests, and `src/dev` is excluded from the package). Artifact
`Wallwright-0.1.1-x64.zip`, sha256 `020be292...`, hash-verified after transfer.

```
layout 1080x1920 in a 1080x1920 window, 1:1
matched display by 1080x1920: "SL4364K"
```

`wall.scale` is exactly 1.0, so no layout scaling distorts the panels, and the app
matched the display by resolution rather than falling back to primary.

**At T0**: 1380MB total, `Tab 765, GPU 427, Browser 119, Utility 68`. Per panel,
each in its own renderer: `control` 73MB, `heavy` 99MB, `grafana` 250MB,
`earth` 128MB. Zero crashes, zero failed loads, zero watchdog reloads.

**Three recorders**, all Scheduled Tasks rather than SSH children, because Windows
OpenSSH kills the whole process tree on session end:

| task          | every | writes                                                                                                                                                                    |
| ------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SoakSampler` | 60s   | the app's own `/api/status`: totals, per-type split, per-panel pid and memory, every cumulative counter. CSV, per-panel CSV, raw JSONL, and a summary rewritten each poll |
| `SoakProc`    | 60s   | the OS-side series: working set, **private bytes**, handles, threads, available MB, commit %, and a CPU delta so a throttled app shows as a cliff                         |
| `SoakGrab`    | 30min | an OS-level screen grab at half size                                                                                                                                      |

The two memory series already show why both are needed. At the same instant:

```
app  (workingSetSize, summed)  1380 MB
OS   (PrivateMemorySize64)      835 MB
```

A 545MB gap, because `workingSetSize` counts shared pages once per process that
maps them. **The app's own number reads about 65% high**, and anybody comparing a
figure from the log to a figure from Task Manager needs that. The private-bytes
series is the honest "is this machine running out" number; the app's is the trend
it can see about itself.

**Reading it remotely, without disturbing it.** Everything is over SSH and touches
nothing: `type %APPDATA%\Wallwright\logs\wallwright.log` for the app's own record,
`out\soak-mini2-*-summary.md` for the current slope and verdict, `out\proc-*.csv`
for private bytes, and `out\shots\` for the visual record. **No RDP**: a remote
session hijacks console session 1, blanks the physical display, and leaves it
disconnected, which is one of the pre-registered invalidating conditions.

The freeze detector is drawn into the canvas rather than over it in the DOM, so it
composites on the same surface as the animation. Two consecutive grabs showing the
same frame count is a frozen renderer, which no memory series can see. The DOM HUD
is still present and overlaps it slightly; cosmetic, and left alone rather than
restarting the run a third time to tidy it.

### The 72-hour run: ENDED EARLY at 6.9h, no verdict

Stopped on 2026-08-26 because the machine was needed for other work. The run had
in fact already ended the previous evening, and nobody knew.

**What happened.** The last sampler row and the last app log line are the same
moment, 2026-08-25T20:17:36Z, 24787 seconds in. The app log's final line is:

```
2026-08-25T16:17:36.119-04:00 info stopping after 24787s
```

That line is written from `app.on('will-quit')`, so this was a graceful
`app.quit()`, not a crash. The comment above it - "a run that ends must say
whether it ended on purpose; silence at the end of a soak log is otherwise
indistinguishable from a kill" - is the only reason that is knowable.

The three long-running Scheduled Tasks all exited `0xC000013A`
(`STATUS_CONTROL_C_EXIT`), i.e. a console control event. `SoakGrab`, which is a
short periodic task rather than a long-running console one, kept firing every 30
minutes for another 17 hours and collected 47 grabs. So the scheduler and the
session were healthy throughout; only the console processes were stopped.

**What it was not.** Three candidates ruled out by evidence, not assumption:

| suspected                       | checked                                       | result                                                                                     |
| ------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| reboot                          | `LastBootUpTime`, event IDs 1074/6005/6008/41 | last boot 2026-08-11, two weeks before                                                     |
| RDP hijacking console session 1 | `query session`, TerminalServices/Operational | session 1 active and unbroken since 2026-08-14, last logon `Source Network Address: LOCAL` |
| app crash                       | app log, `render-process-gone` counters       | graceful `will-quit`; 0 crashes, 0 failed loads, 0 watchdog reloads                        |

A graceful quit plus Ctrl+C to the console tasks is what a person shutting the
run down at the machine looks like. The pre-registered invalidating condition (a
remote session blanking the display) did **not** occur.

**No verdict, and that is the point of the pre-registration.** The threshold is 15
MB/hour judged on the **final 24 hours of 72**. Six point nine hours cannot satisfy
that, and `docs/soak-run.md` is explicit that an early reading is not a result. So
`config/wall.json` `_memoryBaseline` stays `NOT MEASURED YET` and `memoryLimitMb`
stays 0. What follows is data, not a pass.

|                     |                                                   |
| ------------------- | ------------------------------------------------- |
| Window              | 2026-08-25T13:26:20Z to 20:17:28Z (6.85h)         |
| Sampler             | 412 samples, 412 ok, 0 failed, 0 restarts         |
| App-reported memory | first 1379MB, last 1424MB, min 1379MB, max 1458MB |
| Whole-segment OLS   | 3.40 MB/hour, R² 0.467                            |
| Median cross-check  | 3.76 MB/hour                                      |

The two estimators agree in sign and rough magnitude, which is the pre-registered
condition for trusting either. Both are far below 15 MB/hour. Encouraging, and
still only warm-up: the two-hour reading was 14.79 MB/hour and the one-hour
extrapolation was 29, so the curve is flattening exactly as the pre-registration
predicted it would.

**The control arm did not move**, which is the result that would have mattered
most had it gone the other way:

| panel                                     | first | last  | peak  | crashes / failed loads / reloads |
| ----------------------------------------- | ----- | ----- | ----- | -------------------------------- |
| `control` (static, no timers, no network) | 73MB  | 74MB  | 74MB  | 0 / 0 / 0                        |
| `heavy` (bounded local load)              | 99MB  | 103MB | 104MB | 0 / 0 / 0                        |
| `grafana` (live dashboard)                | 248MB | 240MB | 253MB | 0 / 0 / 0                        |
| `earth` (WebGL, live data)                | 128MB | 134MB | 135MB | 0 / 0 / 0                        |

`grafana` ended lower than it started. Nothing crashed, nothing failed to load,
and the watchdog never fired, over 412 samples.

**The workingSetSize versus private-bytes gap, partially answered.** This was an
open question since the original 699MB datum. The app's own figure reads high, and
by a shrinking amount:

```
T0     ws 1384MB  private 840MB   -> 65% high
2h     ws 1414MB  private 865MB   -> 63% high
6.9h   ws 1422MB  private 892MB   -> 59% high
```

So a `memory:` line in the log overstates private bytes by roughly 60% on this
machine, trending down as the run settles. Enough to interpret a log line; not
enough to call a plateau figure, because the run never plateaued.

**Harvested before teardown**, per the runbook: `docs/soak/2026-08-25-partial/`
holds the sampler CSV, the per-panel CSV, the JSONL, the summary, the machine
description and the app log. The 47 screen grabs are in the zip alongside it,
which is gitignored for size. Teardown then ran clean: no `Soak*` task remains,
`FCATWallLauncher` and `FCATSoakSampler` are both back to `Ready`, and the stage
and `%APPDATA%\Wallwright` profile are gone.

**A re-run starts from zero.** A memory curve cannot be resumed across a two-day
gap, so Thursday is a fresh 72 hours, not a continuation. Nothing about the
harness needs changing; it did its job, including telling us how it ended.

### The 72-hour run, second attempt: ABANDONED BEFORE T0, machine not free

**Superseded by the third attempt, which is running. See below.**

Staged and started twice on 2026-08-27, torn down the same hour, and **no run is
in progress**. `memoryLimitMb` stays 0 and `_memoryBaseline` stays
`NOT MEASURED YET`. Roughly 30 minutes of data was collected and is not kept: it
is worth less than the 6.9-hour partial that precedes it.

Three things were learned, and they are the reason this attempt was worth making.

**The build and the reason for it stand.** git `c384dcf` (then `main`), artifact
sha256 `1b377dbe...`, from Actions run `33109052397`, green through lint, unit
tests and the Windows self-test before staging. The first attempt soaked
`ddafb04`; the audit has since rewritten 2,184 lines of shipped source, and the
deliverables are `memoryLimitMb` and `_memoryBaseline` for what actually ships, so
the old build would describe code that no longer exists. That reasoning is
unchanged for the next attempt.

**The geometry had moved, and the app's own log caught it in seconds.** The panel
had been rotated portrait to landscape between the attempts, so the 1080x1920
config matched nothing:

```
warn falling back to the PRIMARY display "SL4364K" (id 3179642134)
info layout 1080x1920 in a 1920x1080 window, scaled to 0.563
```

Re-authored at 1920x1080 as a 2x2 of 960x540 and restarted six minutes later,
giving `matched display by 1920x1080` and `layout ... 1:1`. See the amendment under
"Pre-registration" for why the raster argument survives a change of orientation.
Checking that line before walking away is now step 5 of staging: six minutes here,
72 hours if it is first read at harvest.

**The machine was not free, and that is the finding.** The video cable was moved
from the motherboard to the NVIDIA RTX A1000 partway through, which is when the
GPU became visible at all:

```
C:\HQ\SoDA\MS_Immersive_Tunnel.exe  -station mini2
started 2026-08-25 17:34 local, 36.9 hours of accumulated CPU
99% utilisation, 89C, 7758 of 8188 MiB VRAM
```

Sustained across repeated samples. That leaves about 430 MiB of VRAM for four
panels, and a baseline measured beside it would not be a baseline.

**It also dates the first run's death.** The first attempt's last sample is
`2026-08-25T20:17:36Z`, 16:17 local. SoDA started at 17:34 local, 77 minutes
later, and has run continuously since. "Somebody stopped it at the machine" now
has a name attached. The social precondition was satisfied for this attempt in
good faith and was still wrong, because the thing occupying the machine was a
running process rather than a booked slot, and nobody thought to look.

**Why nothing noticed for half an hour.** Wallwright was rendering on the
integrated chip while SoDA had the discrete card to itself, so the two never
contended and every number looked healthy: 10 of 10 samples ok, private bytes flat
at 783MB, per-panel figures within a few MB of the first run's. Moving the cable
put them on the same chip. A clean-looking series is not evidence of a clean
machine.

One useful residue: Wallwright on the integrated chip demonstrably coexists with
SoDA without perturbation, which is a real option if SoDA cannot be paused.

**Two gaps closed rather than noted.** `scripts/soak-setup.ps1` now **fails** the
pre-flight when the GPU is at or above 50% memory or 50% utilisation, printing
`nvidia-smi` so the neighbour is named. Verified against the live machine: it
reports `used=7751 total=8188 util=99 pct=95` and refuses. And `soak-proc.ps1` now
records `vram_used_mb`, `vram_total_mb` and `gpu_util_pct` alongside the existing
ten columns, because the cable change created a blind spot: on a discrete GPU,
textures and framebuffers live in video memory that private bytes cannot see, so a
VRAM leak would read as a perfectly flat curve. Blank rather than zero when there
is no `nvidia-smi`, so "no discrete GPU" is not recorded as "no VRAM in use".

**Before the next attempt:** confirm SoDA is stopped for the duration, not merely
that the machine is nominally free. The pre-flight now enforces that, but a script
refusing to start is a worse way to find out than asking.

### The 72-hour run, third attempt: STARTED 2026-08-27T20:31:57Z

Live on HQ-PROTO-MINI-2, due to end about `2026-08-30T20:31:57Z`. Same build as the
abandoned second attempt: git `c384dcf`, sha256 `1b377dbe...`, Actions run
`33109052397`. Same config, same four arms, same thresholds.

**The blocker was cleared rather than worked around.** Jeff confirmed
`MS_Immersive_Tunnel.exe` was left over from an old test and could be killed. Its
two Scheduled Tasks were checked first, because a run cannot survive something that
relaunches: both `SoDA_Tunnel` and `SoDA_Tunnel_Keys` are **one-shot time triggers
that already fired** on 2026-08-25, with an empty `NextRunTime`, so nothing will
start it again and neither task needed disabling. Another project's task
definitions were left untouched.

The GPU before and after:

```
before   99% util, 89C, 7758 MiB of 8188 used
after     0% util, 72C,  467 MiB of 8188 used
```

**The video cable is now on the discrete GPU**, moved by Jeff during the second
attempt, and the app is confirmed to be using it: `Wallwright.exe` appears in
`nvidia-smi`'s process list, at 611 MiB and 24% utilisation. This is the first run
whose GPU path is both known and recorded.

**A third estimator of how contaminated the second attempt was.** `commit_pct` read
34.7% during the first run, 62.9% throughout the second, and 34.1% now. The middle
figure was SoDA, and the machine is back to the state the first run measured.

**At T0**, `matched display by 1920x1080: "SL4364K"` and `layout 1920x1080 in a
1920x1080 window, 1:1`, so no PRIMARY fallback and no layout scaling. The display id
differs from the second attempt (`2715430223` against `3179642134`) because it is
now enumerated through the NVIDIA adapter rather than the Intel one; the label and
the resolution are the same panel.

One minute in, all four arms in their own renderers, zero crashes, zero failed
loads:

| panel     | third attempt | second attempt | first attempt |
| --------- | ------------- | -------------- | ------------- |
| `control` | 74MB          | 77MB           | 73MB          |
| `heavy`   | 102MB         | 103MB          | 99MB          |
| `grafana` | 248MB         | 248MB          | 250MB         |
| `earth`   | 131MB         | 131MB          | 128MB         |

Three attempts, two builds, two display orientations and two GPUs, and the four
arms land within a few MB of each other every time. That consistency is worth more
than any single run: it says the per-panel figures are a property of the pages and
the engine rather than of this machine's configuration.

**The VRAM columns are live**, which is the point of adding them now that the app
renders on a discrete card:

```
iso_utc,...,cpu_pct_sum,vram_used_mb,vram_total_mb,gpu_util_pct
2026-08-27T20:32:57Z,...,58.25,610,8188,25
```

`workingSetSize` 1266MB against private bytes 890MB at t+1min, so the app's own
figure reads about 42% high here, against 65% at the first run's T0. Not comparable
yet: this is one minute in and the first run's gap narrowed as it settled. The
plateau figure is what step 2 of the harvest wants.

**Checkpoint at 16.1 hours** (`2026-08-28T12:39Z`), recorded because a run this
long deserves a record before its result, not because it is one:

```
968 samples, 968 ok, 0 failed, 0 restarts
0 crashes, 0 failed loads, 0 watchdog reloads, 0 recycles
0 sampler rows with ok=0, so no downtime at all
```

| panel     | first | last  | min   | max   |
| --------- | ----- | ----- | ----- | ----- |
| `control` | 74MB  | 74MB  | 74MB  | 74MB  |
| `heavy`   | 103MB | 120MB | 102MB | 121MB |
| `grafana` | 413MB | 251MB | 247MB | 413MB |
| `earth`   | 142MB | 136MB | 124MB | 177MB |

**`control` has not moved a megabyte in 16 hours**, at 74MB for every one of 968
samples. That is the arm whose growth would be the only result indicting the
product, and it is flat to the resolution of the measurement. `grafana` spiked to
413MB during warm-up and settled to 251MB, ending below where it started, which is
the shape the pre-registration predicted and the reason the verdict is judged on the
final 24 hours rather than the whole run.

`heavy` is the one line to watch: up 17MB, about 1.1 MB/hour, on a page that is
leak-free by construction. It appears to have plateaued (max 121, current 120) and
the magnitude is small against a 15 MB/hour whole-app threshold, but it is the only
arm that is not obviously flat and it should be read again at harvest.

```
whole segment OLS    1.67 MB/hour  (R2 0.370)
median cross-check   1.72 MB/hour
```

The two estimators agree in sign and magnitude, which is the pre-registered
condition for trusting either. Private bytes went 890MB at t+1min to 912MB, about
1.4 MB/hour, agreeing with the app's own series.

**VRAM is flat**, 609 to 614 MiB for the whole run after the startup transient of
731 MiB. This is the first run able to say that at all, and it is worth saying
plainly: the discrete GPU is not accumulating.

**None of the above is a verdict.** The summary's "final 24h" row currently just
restates the whole run, because there are only 16.1 hours of it and
`soak-stats.js` fits what it has. The threshold is the final 24 hours of 72.

**No verdict is possible yet and none is being offered.** `memoryLimitMb` stays 0
and `_memoryBaseline` stays `NOT MEASURED YET` until the final-24h window exists.

Everything above is the record as it stood at 16.1 hours and is left as written. The
run went on to complete; the result is the next section.

### The 72-hour run, third attempt: COMPLETE, verdict PASS

Ran the full 72.0 hours, `2026-08-27T20:31:56Z` to `2026-08-30T20:32:07Z`, and
harvested on 2026-08-31 before anything was torn down. Build git `c384dcf`,
HQ-PROTO-MINI-2, discrete RTX A1000. Data in `docs/soak/2026-08-30-complete/`.

**Verdict: PASS**, against the threshold pre-registered before T0.

```
final 24h OLS        0.45 MB/hour  (R2 0.288, 1440 samples)
median cross-check   0.89 MB/hour  (head 1299MB, tail 1362MB)
threshold           15    MB/hour
```

The two estimators agree in sign and magnitude, which is the pre-registered
condition for trusting either. The whole-run fit is 0.80 MB/hour, and the app ended
**below** where it started: 1537MB at T0, 1406MB at the last sample, min 1261, mean 1339. The 1537 is the startup sample alone; the second sample is 1267.

It is not a marginal pass. 0.45 MB/hour is a thirty-third of the threshold, and it
is the kind of number that only means anything because the failure conditions that
do not involve memory were also checked, one at a time, below.

**Nothing failed, and there is no downtime to report:**

```
4320 samples, 4320 ok, 0 failed        0 crashes         0 failed loads
0 rows with ok=0, so no outage at all  0 watchdog reloads, 0 deferrals
one runId (83acd2e6) for all 72h       0 recycles, 0 memory limit hits
```

One `runId` across the whole run is the restart check: a restart drops memory back
to a few hundred MB and would show as a new id. There was no reboot either, which
matters because a reboot invalidates the curve and must not be stitched over: last
boot was **2026-08-11**, sixteen days before T0, and the System log has no 1074,
6005, 6008 or 41 event inside the window.

**The per-panel result, which is the part that makes a leak attributable:**

| panel     | first | last  | min   | max   | final-24h       | URL drift |
| --------- | ----- | ----- | ----- | ----- | --------------- | --------- |
| `control` | 74MB  | 77MB  | 73MB  | 79MB  | **+0.021 MB/h** | 0         |
| `heavy`   | 103MB | 121MB | 102MB | 121MB | **0.000 MB/h**  | 0         |
| `grafana` | 413MB | 252MB | 244MB | 413MB | +0.006 MB/h     | 4320      |
| `earth`   | 142MB | 173MB | 124MB | 177MB | +0.036 MB/h     | 4319      |

**`control` did not climb**, which is the pre-registered condition that would have
indicted the product rather than the pages. It moved inside a 73 to 79MB band all
run and fits at +0.021 MB/hour over the final 24 hours, with a median cross-check of
exactly zero. The honest description is a staircase, not a slope: it sat at 74MB for
the first 34 hours, then stepped up a megabyte roughly every 6.5 hours, then stepped
back **down** from 79 to 77 at h+66.5. Something that steps down is not
accumulating. Even at the whole-run rate of 0.075 MB/hour it would take about six
months to reach 400MB, and the step down says even that overstates it.

**`heavy` was warm-up, and this closes the question the 16-hour checkpoint left
open.** At the checkpoint it was up 17MB in 16 hours, about 1.1 MB/hour, on a page
that is leak-free by construction, and it was the one arm not obviously flat:

```
h+0  103MB    h+24  121MB    h+48  121MB
h+6  119MB    h+28  121MB    h+60  121MB
h+12 120MB    h+36  121MB    h+72  121MB
```

Exactly 121MB at every checkpoint from h+24 on, and a final-24h slope of 0.000. It
plateaued and stayed there for two full days. The 1.1 MB/hour reading was warm-up
being extrapolated, which is the same mistake the pre-registration warns about and
the reason the verdict is judged on the final window.

`grafana` spiked to 413MB in warm-up and settled to 252MB, ending 161MB **below**
where it started, exactly the shape predicted. `earth` oscillates between 124 and
177MB as it repaints and ends within that band.

**The process-type split**, first sample against last, showing where the small
whole-run drift actually went:

```
Tab      1059 -> 864 MB     Browser  123 -> 135 MB
GPU       285 -> 337 MB     Utility   70 ->  69 MB
```

Renderer memory fell by 195MB over three days. What rose is the GPU process, by
52MB, on a machine where the app is on a discrete card.

#### Nothing froze, which a flat memory curve cannot tell you

A stalled renderer holds its memory perfectly flat, so the flattest possible curve
is also what a frozen wall looks like. That is why the grabs exist, and a PASS is
exactly when they have to be read rather than filed.

180 grabs at a perfect 30-minute cadence, 178 consecutive gaps of exactly 30
minutes and not one missed firing. Two consecutive grabs from inside the scored
window, `2026-08-30T20:02:40Z` and `20:32:40Z`, were read against each other.

The cleanest number is the `heavy` panel's local fetch counter, which is unobscured
and advanced **51489 to 51849** across that half hour: 360 fetches in 1800 seconds,
one every five seconds exactly as configured, so its network loop was still running
72 hours in. The canvas frame counter advanced by about 108,000 over the same
interval, which is **60 fps sustained**, and its end-of-run value of roughly 15.55M
frames is what 60fps for 72 hours predicts (60 x 3600 x 72 = 15.55M). The stripe
animation had moved and the `earth` globe had rotated between the two frames.

Read the frame figures as approximate: the `heavy` page's DOM HUD overlaps the
canvas-drawn counter, which makes individual digits ambiguous in a half-size grab.
The fetch counter, the animation and the globe are unambiguous on their own, and all
three say the same thing. **Nothing was frozen, throttled or dropping frames.**

**Handles and threads were checked for the leak a memory series would miss**, and
there is none: handles 5285 to 5256 (peak 5293), threads 323 to 353, process count
pinned at 9 for all 4320 samples.

**VRAM is flat and low.** 610 MiB at the start, 545 at the end, peak 926 of 8188
MiB, which is 11.3% against the 50% pre-flight gate. GPU utilisation averaged 19.7%.
Available system memory never fell below 20392MB and commit never exceeded 38.6%,
so nothing here was measured under pressure.

#### The workingSetSize versus private-bytes gap, answered

This has been open since the original 699MB datum and it was step 2 of the harvest.
The answer is **1.44, and stable**, so the app's own figure reads about 44% high:

| point   | ws_mb  | private_mb | ratio |
| ------- | ------ | ---------- | ----- |
| T0+2min | 1259.8 | 881.8      | 1.429 |
| h+12    | 1326.8 | 911.7      | 1.455 |
| h+24    | 1328.1 | 914.5      | 1.452 |
| h+48    | 1357.4 | 961.5      | 1.412 |
| h+71.9  | 1364.5 | 944.9      | 1.444 |

Mean 1.444 across the whole run, 1.437 across the final 24 hours, range 1.242 to
1.454. **It does not drift.** The earlier partial readings suggested it did (65%
high falling to 59% across the first run's seven hours, 42% at one minute into this
one), and a full run says those were startup transient and sampling noise rather
than a trend. The gap is what it is because `workingSetSize` counts shared pages
once per process that maps them, and the process count here was constant at 9.

Anyone comparing the app's own log line to Task Manager needs that 1.44. It also
means a limit expressed in the app's units is about 1/1.44 of that in private bytes:
the 2000MB below is about 1389MB of private bytes.

The OS-side series carries the verdict independently and agrees:

```
private bytes, final 24h   0.579 MB/hour     (app metric: 0.45)
private bytes, whole run   0.731 MB/hour     (app metric: 0.80)
p50 943.7MB, p95 962.6MB, p99 981.2MB over the final 24h, peak 1133.6MB over 72h
```

#### Disclosure: one human input instant, and the run is reported as partial

**Any human input is a pre-registered invalidating condition**, and the run took
one. It is disclosed here rather than left to be found, and the pre-registration
says such a run is reported as partial rather than quietly stitched together, so
that is what this is: a complete 72-hour series with one recorded interference,
argued rather than omitted.

**What happened.** `FCATTable.exe` was launched from its on-demand Scheduled Task
at `2026-08-29T00:39:58Z`, 28.1 hours in, by a person; Jeff confirmed at the time it
was deliberate and nearly finished. Closing it at about `00:58Z` landed input on the
`control` panel.

**What the record proves about it**, and this is why it is one event rather than an
unknown amount of interference. `lastUsedSecAgo` is null until that moment and then
counts upward for the rest of the run:

```
control:  2614 of 4320 samples non-null, first at 2026-08-29T00:58:23Z
          exactly ONE implied input instant, 2026-08-29T00:58Z
          monotonically increasing for 43.6h afterwards, zero resets
heavy, grafana, earth:  0 of 4320 non-null. Input never reached them
```

A second touch would reset that counter, and it never resets. So the artifact of one
event ageing is not to be mistaken for ongoing interaction, and the other three arms
were never touched at all.

**Why it does not reach the verdict.** The scored window opens at
`2026-08-29T20:32Z`. The input is at `00:58Z` the same day, **19.6 hours before the
window opens**, and no part of it is inside the scored data. Its behavioural effect
is nil in this configuration: `lastUsedSecAgo` exists only to defer watchdog reloads
and recycles, and both are off, which the counters confirm at 0 and 0. Wallwright
private bytes were flat at 916MB across the FCATTable boundary with no step in any
panel, VRAM went 613 to 910 MiB at its worst, 11% of the card against the 50% gate,
and afterwards fell to 524 MiB, below where it had been before. `earth` blipped 137
to 162 to 138MB on the repaint and `control` did not rise, going 74 to 73MB.

The conservative reading is the one to take: this is a 72-hour run with a clean
scored window and a disclosed interference 19.6 hours outside it, not an unblemished
72 hours.

#### The geometry check passed and was invalidated twelve seconds later

A finding about the harness, not the app, and the more useful of the two because it
will recur. The runbook's single most important walk-away check is that the app log
says `1:1` and not `scaled to 0.nnn`, because the pre-registration fixes `wall.scale`
at 1.0. It said `1:1`. Twelve seconds later it stopped being true, and nothing
noticed for 28.4 hours.

The app logs layout only when it changes, which is what hid this. Reading all 249
layout lines rather than the first six:

```
T0-12s      layout 1920x1080 in a 1920x1080 window, 1:1
T0+12s      layout 1920x1080 in a 1920x1079 window, scaled to 0.999   <- first grab
            ... 28.4 hours with no further layout line ...
h+28.44     layout 1920x1080 in a 1920x1080 window, 1:1               <- FCATTable closed
h+28.51 on  0.999 then 1:1 again, every 30 minutes, at :02:40 and :32:40
```

So the window lost one pixel of height to the **first screen grab** and stayed at
scale 0.999 for the first 28.4 hours of the run. The human closing FCATTable is what
restored it to 1920x1080. From then on each `SoakGrab` firing dips it for about half
a second and it springs back: 245 of the 249 layout lines are that cadence, and they
line up exactly with the grab timestamps.

**The scored window is unaffected**, which is why the verdict stands: the final 24
hours ran at the registered 1920x1080 and 1:1 apart from roughly 48 half-second
dips, and the whole 0.999 period is in the unscored first 28.4 hours. The deviation
is also tiny in the terms the pre-registration actually fixed, which was the raster:
1920x1079 at DPR 2 is 8.286 megapixels against 8.294, a difference of 0.09%.

**What to fix before a fourth run.** `soak-grab.ps1` does nothing but
`CopyFromScreen`, so the resize is a side effect of the Scheduled Task's console
appearing in session 1, not of the capture. Two cheap changes would close it: have
the grab task run its console hidden, and have the sampler record the app's reported
scale as a column so a geometry change is visible in the series instead of only in a
log line that is written once. The current runbook check is weaker than it reads,
because it verifies a condition at the one moment the harness has not yet perturbed.

**A related caveat the grabs also revealed: scheduled-task console windows sit on
top of the wall for the entire run.** Three of them at T0, one by the end, occluding
part of `control` and part of `heavy`. This was constant from T0 rather than a change
mid-run, and the frame counter proves painting continued underneath, but occlusion
can only bias memory downward, so it belongs in the caveats and not in the argument
for the result.

#### The URL drift flag reads as a failure and is not one

`URL drift samples: 4320` prints directly above `Verdict: PASS` in the summary, and
the pre-registration lists "any URL drift" among the things that fail a run whatever
the memory did. Those two lines look like a contradiction and they are not, so the
record should say why rather than leave it for a reader to trip over.

They do not actually conflict, because the verdict is computed from the memory slope
alone: `summarize()` in `src/dev/soak-stats.js` reports `urlDriftSamples` alongside
the result and never feeds it into the pass or fail. The drift condition was written
for a panel that wanders off to somewhere it was not configured to be, which is a
real failure mode for an unattended wall.

What was actually recorded is the two remote pages normalising their own URLs at
load, once each, on the first sample they appear in:

| panel     | drift samples | what it appended                   |
| --------- | ------------- | ---------------------------------- |
| `grafana` | 4320 of 4320  | `?from=now-6h&to=now&timezone=utc` |
| `earth`   | 4319 of 4320  | a `#current/wind/...` fragment     |
| `control` | 0             | never drifts                       |
| `heavy`   | 0             | never drifts                       |

The counts are high because the flag is a per-sample comparison against the
configured URL, not an event count: one normalisation at load is then true for every
subsequent sample. `grafana` shows 4320 because it had already normalised by the
first sample and `earth` 4319 because it did so by the second. Neither page ever
navigated anywhere else, and the two local arms, which are the ones that would
matter, never drift at all.

**This also explains the 2026-08-25 partial**, which recorded the same thing as
412 of 412 and left it unexplained. Same two pages, same cause.

The flag is doing its job and the summary is not lying; it is reporting a per-sample
state under a name that sounds like an event. Worth narrowing to a comparison
against the post-load URL, or renaming, before anyone reads a future run cold.

#### The measured baseline, and the countermeasure switched on

The run's purpose was to produce these four numbers, in the app's own metric because
that is what `upkeep.js` compares against at runtime:

```
p95_24h         1367 MB
peak_72h        1537 MB     (the T0 startup sample; steady state is 1261 to 1406)
driftMbPerHour  0.45
p50_24h 1359, p99_24h 1382, max_24h 1406
```

Through the rule already committed in `config/wall.json` and implemented as
`memoryLimitFromBaseline()`, that gives **`memoryLimitMb` 2000** and
**`memoryHardLimitMb` 2750**.

That answer is robust to the one judgement call in it. `peak_72h` of 1537 is a single
startup sample and there is a fair argument for excluding it, but the p95 term
dominates the maximum either way, so the limit is 2000 whether the peak is taken as
1537, as 1406 excluding the first hour, or as 1406 from the final 24 hours alone. It
did not need deciding.

`_memoryBaseline` is filled in with those measurements, and **`config/wall.json` now
ships `memoryLimitMb` 2000 and `memoryHardLimitMb` 2750**. The memory countermeasure
is switched on for the first time; it has shipped inert since it was written.

**What unblocked it was a question about a cable.** The baseline was measured with
the video cable on a discrete A1000, where textures and framebuffers live in VRAM
and never enter the number the limit is compared against. On integrated graphics the
same allocations come out of system RAM and do enter it, so a baseline from one path
does not transfer to the other, and 2000MB shipped to a machine cabled the other way
would be a guess wearing a measurement's clothes. Jeff confirmed on 2026-08-31 that
the HDMI on the show PC is always in the discrete GPU port. Same path, so the
baseline transfers. **If a show PC ever runs off the motherboard port, this baseline
is void and has to be re-measured**, which is why the reason is written down here
and in `_memoryBaseline.gpu_path` rather than left as folklore.

**One caveat that survives, and it is the more likely of the two to bite.** These
figures come from the soak lineup: a static page, a synthetic WebGL page,
`play.grafana.org` and `earth.nullschool.net`. They do **not** come from the real
Honeywell dashboards, which did not exist when this was measured. Real dashboards
are the single thing most likely to move `p95_24h`, and the rule's headroom is 1.35x
over a p95 measured on other content. So 2000 is honestly described as a guard
against runaway growth, not as a tuned figure, and it should be re-measured when the
real URLs land. That is already a separate item in `AGENTS.md`.

The reason this is worth being careful about rather than just picking a round
number: a limit inside the normal operating band is worse than no limit, because it
rebuilds a panel on every check. Measured, that took memory **up** from 1513 to
1885MB while recycling every five seconds. 2000 sits 633MB above the measured p95
and 594MB above the highest single sample in the scored window, so it is outside the
band with room to spare on this content.

#### What this run does not settle

- **Not the real dashboards.** `grafana` and `earth` are realistic, public and
  stateless. Nothing here says whether a real Honeywell IdP session survives three
  days of idleness or a panel rebuild.
- **Not the show PC and not a wall.** 8.29 megapixels of raster is representative;
  a 2x2 of 960x540 on a 4K desktop panel is not the panel arrangement, and
  SentinelOne at about 844MB is a background variable this machine has and another
  might not.
- **One machine, one run, no replicate.** A strong lower bound on how bad things
  get, weak evidence of how good.
- The `heavy` DOM HUD still overlaps the canvas counters. Cosmetic, and it made the
  frame counter harder to read at harvest than it needed to be.

#### Afterwards, and the teardown

The sampler stopped itself at 72 hours as designed, and the app was deliberately
left running so the machine could be given back on Jeff's say-so rather than
automatically. `soak-proc.ps1` loops forever and kept recording, which turned into a
free extension of the result:

```
18.7 further hours past the scored window
private bytes 949.0MB -> 948.2MB      OLS +0.315 MB/hour at R2 0.034
process count 9 throughout, VRAM 543 MiB at the end
90.8 hours of continuous uptime when it was finally killed
```

Read the endpoints rather than that fit: 0.8MB of movement across eighteen hours is
the series not going anywhere, and an R2 of 0.034 says the slope is fitting noise.
Which is the useful part. The last thing this app did before being killed was hold
1369MB steady for most of a day, on a build that had by then been rendering four
panels continuously for nearly four days.

**Torn down on 2026-08-31**, on Jeff's go-ahead, after the archive was taken and
verified. `soak-teardown.ps1` reported clean on every step, and the state was then
checked independently rather than taken from the script's own output:

```
stage removed, %APPDATA%\Wallwright removed
0 Wallwright processes, 0 node processes, 0 Soak* tasks
FCATWallLauncher Ready, FCATSoakSampler Ready, FCATTableLauncher Ready
GPU back to 420 of 8188 MiB at 0% utilisation
```

The other project's two tasks are re-enabled and the machine is given back.

**The app log has no `stopping after Ns` line, and that is not a mystery to solve
later.** Teardown kills with `taskkill /F`, so no `will-quit` handler runs. A plain
`taskkill` was tried first, specifically to get that line into the record, and the
kiosk window did not take the `WM_CLOSE`: all nine processes were still up ten
seconds later. So this run ends with an ordinary memory line at
`2026-08-31T11:17:35-04:00` and was ended by teardown's hard kill. Worth knowing,
because the first run's write-up leans on that line to prove it quit gracefully, and
its absence here means something different from what it would have meant there.

**Evidence.** The scored series, the per-panel CSV, the raw JSONL and the summary in
`docs/soak/2026-08-30-complete/` were hash-verified against the machine immediately
before teardown and are byte-identical to what was harvested. The `proc` CSV and the
app log in that directory are the final versions, running past the scored window to
the moment of the kill. The 183 screen grabs are in
`docs/soak/soak-2026-08-30-complete.zip`, which is gitignored like the partial's.

### Panel CRUD works end to end

`src/main.js` has no unit tests, so `WALLWRIGHT_SELFTEST=1` drives the real path:
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
PC, and it can capture the **editor**, which an OS screenshot of a kiosk window
can only do with someone standing there.

It now lives in `src/main.js` rather than duplicating the layout maths in a
standalone script, so it captures through the real layout, the real overlay and
the real state machine. The two screenshots in the README were produced with it.

### Packaging works, and it is what fixes the app name

`npm run build:mac` produces `Wallwright.app` with `CFBundleName = Wallwright`, which is
the only thing that changes the macOS menu-bar title: `app.setName()` does not
touch it. Verified on the packaged build:

- The asar contains exactly the runtime files. `src/dev/**` and `test/**` are
  excluded, so no mock server or probe ships in an exhibit.
- First run seeds the writable config and reads it:
  `seeded ~/Library/Application Support/Wallwright/wall.json from the bundled default`.
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

57 tests in `test/config.test.js`, all passing (`npm test`). Rejects rects that
fall outside the wall, duplicate view ids, two views sharing a session
partition, missing wall dimensions, and bad `escToGrid` values. A malformed
config now shows a readable error page on the wall instead of a stack trace.

### Permissions are granted by default, and one of them hangs

Electron's security checklist says a session with no permission handler approves
requests. Nothing in `src/` had ever touched permissions - `session` was not even
imported - so the claim mattered and was untested. `npm run probe:perm` asks for
each permission from a page on `http://localhost` and records both what the
handlers were asked and what the page got back, across four arms.

With **no handler**, which is what shipped up to now:

```
media.audio          resolved  stream        <- microphone, granted, no prompt
media.video          resolved  stream        <- camera, granted, no prompt
notifications        resolved  granted
query:geolocation    resolved  granted
geolocation          NEVER ANSWERED          <- pending forever, not denied
clipboard-read       rejected  NotAllowedError
```

So the checklist is right, and worse than it sounds: camera and microphone are
handed to any panel that asks, silently, on a machine that runs unattended for
days. `clipboard-read` is refused for an unrelated reason (it wants a user
gesture), and `geolocation` is the one that never resolves at all - on a wall
nobody is standing at, a request that hangs is a different failure from one that
is denied.

**One handler is not enough, and which one is not obvious.** The four arms:

| arm                                | media / geolocation / notifications         | `navigator.permissions.query` |
| ---------------------------------- | ------------------------------------------- | ----------------------------- |
| no handler                         | granted (geolocation hangs)                 | granted                       |
| `setPermissionRequestHandler` only | **denied, cleanly**                         | **still granted**             |
| `setPermissionCheckHandler` only   | **still granted** (geolocation still hangs) | denied                        |
| both                               | denied, cleanly                             | denied                        |

The request handler is what actually refuses `getUserMedia` and
`getCurrentPosition`; the check handler is the only thing that stops
`navigator.permissions.query` reporting `granted` to a page that is about to ask.
Installing either alone leaves a hole, so `src/main.js` installs both.

The permission strings seen on 43.4.1 were `media` (once per `getUserMedia` call,
covering both audio and video), `geolocation`, `notifications`,
`web-app-installation` and `speaker-selection`. That set is why
`allowedPermissions` is a config array rather than a fixed list in code: the
strings are Chromium's, and they change between versions.

Denying is clean. Every refusal came back as a normal JS rejection
(`NotAllowedError: Permission denied`, `User denied Geolocation`), and nothing
hung once a request handler was installed - so a deny-by-default policy removes
the hanging case rather than adding to it.

**Windows is unverified.** These are Chromium-level behaviours and are expected
to match, but the deployment target is Windows. Run `npm run probe:perm` there,
or dispatch the `probe-windows.yml` workflow, before trusting it.

### `will-navigate` does not see a redirect, and never sees a subframe

`AGENTS.md` TODO 4 treats scoping `allowedOrigins` to the real Honeywell domains
as a config edit, on the grounds that "enforcement already exists for
`will-navigate` and `setWindowOpenHandler`". `npm run probe:nav` measures whether
that enforcement actually covers the shapes a real dashboard navigates in. It
does not.

What fires for a single server 302 (`->` order as received):

```
did-start-navigation     /redirect?to=/dash-2.html   mainFrame=true
will-frame-navigate      /redirect?to=/dash-2.html   mainFrame=true
will-navigate            /redirect?to=/dash-2.html   <- the URL ASKED FOR
will-redirect            /dash-2.html                <- where it actually goes
did-redirect-navigation  /dash-2.html
```

`will-navigate` is handed the URL the page requested, never the one it lands on.
A three-hop chain fires `will-redirect` three times and `will-navigate` once. And
for a subframe navigating itself, `will-navigate` **does not fire at all**; only
`will-frame-navigate` does, with `isMainFrame: false`.

The probe then polices by origin in each event in turn and reports whether the
panel still arrived where the policy was refusing:

| navigation                                 | `will-navigate` only | + `will-redirect` | + `will-frame-navigate` |
| ------------------------------------------ | -------------------- | ----------------- | ----------------------- |
| server 302                                 | **reached it**       | blocked           | blocked                 |
| three-hop 302 chain                        | **reached it**       | blocked           | blocked                 |
| meta refresh                               | blocked              | blocked           | blocked                 |
| script `location.assign`                   | blocked              | blocked           | blocked                 |
| subframe navigating itself                 | **reached it**       | **reached it**    | blocked                 |
| 302 whose target is not in the request URL | **reached it**       | blocked           | blocked                 |

The last row is the one that matters most in practice. A page asks for a URL that
is perfectly allowed, the server bounces it somewhere else, and nothing in the
requested URL names the destination - which is exactly what an expired session
bouncing to an identity provider looks like. Four of six shapes slip past the
enforcement as it stood.

So `hardenView()` and `hardenPopup()` now police `will-redirect` and
`will-frame-navigate` as well, all three routed through the same `isAllowed()` so
there is one policy rather than three. `will-frame-navigate` is filtered to
subframes, since the main frame is already covered and blocking the same
navigation twice proves nothing. Scoping `allowedOrigins` is still a config edit,
but only because the code changed here first.

**Windows is unverified.** Run `npm run probe:nav` there, or dispatch
`probe-windows.yml`.

### Electron 44: every probe answer re-run, and every one unchanged

Bumped from 43.4.1 to **44.1.0** (Chromium 150.0.7871.224 to 152.0.7977.65) on
2026-08-31, after the soak, which is the order the plan fixed: probe answers
recorded against one runtime are evidence about that runtime and nothing else.

**All six probes were re-run and every answer is identical.** That is the useful
result, and it is worth more than a passing test suite, because these are the
findings the app's design rests on.

| probe            | what it settles                                   | 43.4.1                                                                    | 44.1.0    |
| ---------------- | ------------------------------------------------- | ------------------------------------------------------------------------- | --------- |
| `probe`          | child view z-order, `setVisible`, animated bounds | `abc`/`bca`/`cab`, all true, ok                                           | identical |
| `probe:fs`       | which fullscreen path covers the display on macOS | only `set_simple`, not `set_kiosk`                                        | identical |
| `probe:session`  | what a reload and a recycle cost a login          | login survives both; `sessionStorage` survives reload, cleared by recycle | identical |
| `probe:activity` | whether an animated page fakes input              | no sustained stream, 0.08 moves/sec on all three arms                     | identical |
| `probe:perm`     | which handler each install variant attaches       | request/check independently observable                                    | identical |
| `probe:nav`      | which navigation shapes slip past the policy      | four of six past `will-navigate` alone; all six blocked by all three      | identical |

The navigation matrix in particular came back row for row, including the two rows
that drove a code change:

```
                                        will-navigate  +will-redirect  +will-frame-navigate
server 302                              reached        blocked         blocked
three-hop 302 chain                     reached        blocked         blocked
meta refresh                            blocked        blocked         blocked
script location.assign                  blocked        blocked         blocked
subframe navigating itself              reached        reached         blocked
302 whose target is not in the request  reached        blocked         blocked
```

So the `hardenView()` policing of all three events is still exactly as necessary as
it was, and no more. `will-navigate` still never fires for a subframe, and still
sees the URL asked for rather than the one arrived at. The permission strings are
still Chromium's `media`, `geolocation` and `notifications`.

**What the breaking-change list actually costs this app: nothing.** Each of
Electron 44's breaking changes was checked against the source rather than assumed
away:

| change                                                  | applies here?                                                                                                                                       |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clipboard` removed from the renderer                   | no. The only clipboard use is `navigator.clipboard` in a mock dev page, which is the W3C API the change points you at, and `src/dev/` does not ship |
| `clipboard` module now returns Promises                 | no. The main process never touches it                                                                                                               |
| `select-client-certificate` may have null `webContents` | no. Not listened for                                                                                                                                |
| `net.request` rejects frame destinations                | no. The `net` module is not used                                                                                                                    |
| Windows 32-bit and Linux armv7l dropped                 | no. `electron-builder.yml` builds x64 for Windows, arm64 + x64 for macOS                                                                            |
| Unity on Linux, `app.isUnityRunning()` removed          | no. Windows and macOS only                                                                                                                          |
| pre-macOS 13 login item attributes removed              | no. `setLoginItemSettings` is unused, though AGENTS.md TODO does want auto-launch eventually, and that is the API it will reach for                 |
| **macOS 12 no longer supported**                        | **check the runners.** The self-hosted macOS runners must be on 13 or later. `hqmbp26-crouse` is fine; the others gate CI when they are up          |
| **ANGLE is now statically linked on all platforms**     | **no API change, but see below**                                                                                                                    |

#### The one thing this bump puts a question mark over

`_memoryBaseline` was measured on **43.4.1**, and the app now ships 44.1.0. Two
things in this bump plausibly move a memory number: a whole Chromium major, and
ANGLE moving from a swappable library to a statically linked one, which is
squarely in the GPU path the soak had to add a VRAM column to see.

Nothing here says the baseline is wrong, and there is no reason to think 2000MB
stops being a sane runaway guard: the measured `p95_24h` was 1367 and the limit
sits 633MB above it. But the honest statement is that the number now describes a
runtime one major behind what ships, and that is a caveat the record should carry
rather than a thing to discover later from a limit that fires unexpectedly.

It does not need separate work. A re-measure against the real dashboards is
already the standing item, for the stronger reason that the soak lineup was not
real content; that re-measure now also covers the runtime change. What is worth
avoiding is bumping Electron again between a baseline being measured and the wall
going live, without re-reading this paragraph.

**Verified on this bump:** 265 unit tests, `npm run selftest` end to end on macOS,
lint and prettier, plus the six probes above. The self-test matters most, since it
is the only coverage `src/main.js` has, and it exercises the real window, the real
overlay compositing and the real permission handlers against the new runtime.

### `npm run capture` does not work on this machine

Recorded because the claim next to it is wrong, and was wrong before this pass.
`docs/validation.md` above and `README.md` both say the built-in capture "needs no
OS Screen Recording permission, so it also works on a CI runner or a headless show
PC". On the dev machine, macOS 25.5.0, it does not work at all:

```
[wallwright] capture failed: Current display surface not available for capture
```

Verified as pre-existing rather than introduced: the same command fails
identically from a clean worktree of `531f06f`, before any of the audit work. So
`webContents.capturePage()` is refusing here for a reason the compositing approach
was supposed to sidestep.

What this does and does not settle. It does not invalidate the design argument -
compositing per-view captures still avoids `screencapture` and still captures the
editor, which an OS screenshot of a kiosk window cannot. It does mean the
"no permission needed" claim is unproven on macOS, and that the screenshots in the
README cannot currently be regenerated on this machine, which the conventions ask
for after a visible change.

Not chased further because it is orthogonal to the audit and may simply need the
permission granted to the terminal. The next person to touch the README images
will hit it first.

## Still to verify

Grouped by where each item can actually be done. Nothing here is known broken;
these are the things the automated tests and the dev harness cannot settle.

### A. On the dev machine, now

**Five of these are no longer a checklist.** `AGENTS.md` has carried a convention
saying to add a `check()` to the self-test for anything you would otherwise verify
by eye, and this list was seventeen things to verify by eye, none of them ticked.
The mechanical ones are now self-test steps 21 to 25, so they run on every push on
both target platforms instead of being a box somebody ticks once. Each was proven
to fail against the behaviour it guards before being counted; the one that did not
fail on the first attempt is written up under step 24, because a check that passes
against broken code is worse than no check.

What is left below genuinely needs a person: it is either a judgement about how
something looks, or a gesture at the machine that no harness can make.

Run `npm run dev`.

- [ ] **Session persistence across restart.** Sign in on mock 1, quit
      (`Cmd/Ctrl+Shift+Q`), relaunch. Still signed in? Proves the `persist:`
      partition actually persists.
- [x] **Page state survives dock/undock.** **Automated: self-test step 21.** A
      mark set on the renderer's `window` must survive a promote and a dock; a
      reload would take it with it, which is what `SPEC.md` forbids. Proven to
      fail by making `activate()` reload every panel.
- [x] **Esc docks the wall.** **Automated: self-test step 23**, which sends a
      real Esc to the promoted panel's `webContents`, because Esc is handled per
      view rather than as a `globalShortcut`. Proven to fail by setting
      `escToGrid: "double"`. The consequence on mock 2, that the page's own
      Esc-to-close modal no longer fires, is still a by-eye check: it is a
      tradeoff to look at, not an assertion.
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
- [x] **Per-panel zoom.** **Automated: self-test step 24**, which reads the real
      `getZoomFactor()` off both panels **while one is promoted and again after
      docking**. Sampling only the docked state was measurably too weak:
      `showPanelsInGrid()` re-applies each panel's own factor on the way out, so
      an injected leak was scrubbed before the assertion ran and the check passed
      against code that leaked. Whether the text looks right is still by eye.
- [x] **Background liveness.** **Automated: self-test step 22**, which runs a
      real `setInterval` in the backgrounded panel's renderer and asserts it
      still fired while another panel was fullscreen. Deliberately a loose
      threshold: Chromium legitimately throttles background timers, and the
      question is whether it stopped, not whether it kept time.
- [x] **Idle auto-return.** **Automated: self-test step 25**, which arms
      `idleReturnMs` briefly rather than waiting minutes, then restores it.
      Proven to fail by making `resetIdle()` never arm the timer. Still signed in
      afterwards is covered separately by `npm run probe:session`.
- [x] **Watchdog, both paths.** **Automated: self-test steps 26 and 27**, which
      kill a real renderer with `forcefullyCrashRenderer()`. 26 covers the
      background path and also asserts the rule it first tripped over: a panel
      with no url is deliberately _not_ retried, because a placeholder cannot
      fail. 27 is the one that protects an operator's login, and its load-bearing
      assertion is the negative one, that nothing reloaded the panel while it was
      promoted. Proven to fail by disabling the safety rule, which reddens it with
      `watchdogReloads went 1 -> 2`.
- [x] **Discarding a layout edit.** **Automated: self-test step 28**, which
      asserts the config file is byte-identical after a discard. It also records
      something the checklist did not ask about: discard skips the save, it does
      **not** put the live layout back, so the wall keeps showing the dragged
      position until it restarts. See "Discard does not revert the live layout"
      below.
- [ ] **Editing the production config.** Layout edit mode writes to whatever
      `WALLWRIGHT_CONFIG` points at. Run once against `config/wall.json`, edit, save,
      and check `git diff` is a clean readable change to `grid` and `zoom` only,
      with no defaults injected and no key reordering.
- [ ] **Cmd/Ctrl+F toggle.** Flips between owning the display and an 85% window.
      Confirmed working on macOS; confirm the windowed layout is still correct
      and that toggling back restores 1:1.
- [x] **The fatal-config path.** **Automated: self-test step 29**, which renders
      the real `fatalPage()` through the real `dataUrl()` in a real renderer and
      reads the text back, so the page has now actually been looked at. Proven to
      fail by making `fatalPage()` return an empty body. Pointing
      `WALLWRIGHT_CONFIG` at a broken file end to end is still manual: the
      self-test runs inside an already-booted app.
- [ ] **Single-instance lock.** Launch twice. The second should refuse and exit
      rather than fighting over the wall. Never exercised.
- [ ] **Promote/return animation.** `transitionMs` is 220. Animated `setBounds`
      is confirmed not to throw, but the animation itself has not been watched.
- [x] **`hideInactiveWhenActive`.** **Measured: self-test steps 22 and 30.** On
      Windows a backgrounded panel runs at about 1Hz whether the option is on or
      off, so turning it on costs nothing on the deployment target; on macOS the
      occluded case runs at the full rate, which makes the option look expensive
      on a dev machine and will mislead anyone who evaluates it there. The
      liveness half of the trade is settled. **What is left is a different
      question, now under group A's successor work:** how much GPU load hiding
      actually saves, which needs the real 4K wall rather than this harness. See
      "`hideInactiveWhenActive` costs nothing on Windows" above.

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

- [~] **Install the built artifact on the show PC.** The **zip** has now been run
  on Windows (HQ-PROTO-MINI-2, 2026-08-25): it extracts, launches from a
  Scheduled Task, and runs. The **NSIS installer** is still unrun, and the
  `%APPDATA%` config seeding path is still unverified because this run pointed
  `WALLWRIGHT_CONFIG` at a staged file rather than letting it seed. Check the NSIS install, that the
  config seeds to `%APPDATA%\\Wallwright\\wall.json`, and that the layout editor
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
- [x] **Overlay alpha compositing on Windows.** Confirmed 2026-08-25 on
      HQ-PROTO-MINI-2. See "Overlay compositing on Windows: WORKS" above. The
      blocker was never the code and not really the runner either: it needed a
      machine with a signed-in console session, which that one has.
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
      watchdog fires more than expected. Specifically confirm that a logged-in
      panel is still logged in after hours of idleness, since idle is the wall's
      normal state.
- [ ] **Remote access.** Administrators reach the show PC remotely. A remote
      desktop session can change display topology or resolution, which fires the
      `display-metrics-changed` handler and re-targets the window. Confirm that
      connecting and disconnecting does not move the wall to the wrong output or
      leave it mis-scaled.

### What CI covers

- `ci.yml` runs on **every push to `main` and every PR**, on three runners. The
  hosted Linux job does lint, the 270 unit tests and **`npm run coverage` with
  thresholds** in about twenty seconds. The self-hosted Windows job (`PROTO1-P8`)
  and macOS job (`hqmbp26-crouse`, the development machine) each do lint, the unit
  tests **and `npm run selftest`**, both gating. So the only coverage
  `src/main.js` has now runs on both platforms the app ships to, on every change.
- The coverage gate is on the hosted job only, because coverage is a property of
  the source rather than of the platform, and that is the job that always arrives
  regardless of whether the self-hosted machines are up.
- That closes the gap this file used to describe. Windows coverage had been moved
  into `build-windows.yml`, which only runs on a `v*` tag, so a `src/main.js`
  regression could merge to `main` completely green and surface at release time.
  The self-test is the only coverage that file has. Self-hosted runners are free,
  so the cost objection that removed the old `windows-latest` job no longer
  applies.
- **The first Windows run found a bug, in the tests rather than the app.** Three
  self-test steps passed wall units to `ww:addPanel`, which takes window pixels
  and runs `unscaleRect()` on them. At scale 1.0 on the dev machine those are the
  same number, so the calls had been green for days. On the runner, fitting a
  1280x800 wall into a 1024x768 display at 0.8, a panel asked for at x=512 was
  created at 640 and the drag check failed. Fixed by converting through
  `scaleRect()`. Nothing was wrong with the app; the harness had a POSIX-shaped
  assumption baked in, which is the exact thing this job exists to catch.
- The Windows job is a **required gate, not advisory**. `continue-on-error` reports
  a failed step as `success`, which is how a sibling project believed a broken
  smoke test passed for weeks. See `docs/windows-runner.md` for what that runner
  can and cannot do.
- `build-windows.yml` builds the installer and zip on `windows-latest`, on a
  `v*` tag or manual dispatch. It runs lint and tests first, so a failing build
  cannot ship, and **`npm run check:asar` afterwards**, so a build that shipped the
  wrong thing cannot ship either. `build-mac.yml` does the same.
- `probe-windows.yml` is manual, and is the cheapest way to answer several
  group C items below without the show PC.

Verified before pushing by simulating the CI job in a clean checkout: this is
how the gitignored-dev-config test failure was caught, since `config/local*.json`
does not exist outside a dev machine. That test now skips when the file is
absent.

### The last duplications, and one comment that had stopped being true

Phase 6, the final phase of the audit: "the repeated blocks, the single load path,
one panel lookup, and the naming drift". Three of those were real. The fourth was
not, and is recorded here as a non-finding rather than turned into churn.

#### The single load path was aspirational

`loadPanel()` carried this comment, and had since it was written:

> Load whatever this panel should be showing. **The one place that decides**, so
> the watchdog cannot disagree with every other load path about what an empty URL
> means - it used to call `loadURL('')` and throw into a swallowed catch, then do
> it again thirty seconds later, forever.

It was not the one place. Three other sites built the same
`v.url || placeholderURL(v)` expression inline and called `loadURL` themselves:
creating a view, applying a URL change, and the control surface's reload. They
happened to agree with `loadPanel` about what an empty URL means, but nothing made
them agree, and the bug in that comment is precisely a disagreement of that kind.
They also did not get the `catch`, which is there because a torn-down
`webContents` throws synchronously.

All six load sites route through `loadPanel()` now, and the comment says what the
code does.

**One thing checked rather than assumed on the way.** `loadURL` returns a promise
that rejects on `ERR_ABORTED`, which is routine, and `process.on('unhandledRejection')`
logs at fatal level without crashing. That looked like it might mean the log was
full of spurious fatal lines. It is not: **zero unhandled rejections across 5787
log lines and 90 hours** of the completed soak. So the promise is left alone. There
is now one place to handle it if that ever changes, which there was not before.

#### One panel lookup

`indexOfId()` existed. Four other places inlined
`config.views.findIndex((v) => v.id === id)` anyway, including a local arrow inside
`checkMemory()` that shadowed it with an identical body. All four now call the
helper, and it has moved from under an "IPC: layout editing" heading, which is not
where its callers are, to the top of the panel lifecycle section.

#### The repeated blocks, one of which was a security posture in two copies

A scan for repeated four-line runs, ignoring comments and blank lines, found three:

| repeated                                         | where                                            | now                        |
| ------------------------------------------------ | ------------------------------------------------ | -------------------------- |
| the content `webPreferences`                     | `createContentView()` and the SSO popup override | `contentWebPreferences(v)` |
| every panel visible in its grid slot at its zoom | `dockGridOrKeepEditing()` and `enterEdit()`      | `showPanelsInGrid()`       |
| raise the overlay and give it the keyboard       | `enterSelect()` and `enterEdit()`                | `raiseOverlay()`           |

**The first is the one that mattered.** `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true` and the shared preload were written out
twice, for the two surfaces that display somebody else's page. Divergence there is
a security regression rather than an inconsistency, and it would be invisible: an
SSO popup with `contextIsolation` accidentally off still logs people in perfectly.
The popup copy even carried a comment explaining that its preload had to match the
content views', which is the sort of invariant a comment cannot enforce and a
shared function can.

`dockGridOrKeepEditing()` deliberately does **not** use `raiseOverlay()`, though
two of its five lines match. The overlay is already up in that path, and taking
focus would be a behaviour change rather than a tidy-up.

After these, a repeated four-line block scan over `src/main.js` returns nothing.

#### The naming drift was not there

Recorded because a phase that finds nothing should say so, rather than leaving the
next reader to wonder whether it was skipped. There is no `panelId` or `viewId` in
the codebase; the convention is `v` for a config spec and `view` for the Electron
`WebContentsView`, and every function across every module follows it, including
`loadPanel(view, v)`, which takes both. The one genuine inconsistency is that the
config calls the array `views` while the runtime calls its members panels, and
that is baked into the config schema: renaming it would break every committed
config and every deployed `userData` copy to settle a question of taste.

**Verified:** 270 unit tests, the coverage gate, `npm run selftest` end to end,
lint and prettier. The self-test is what carries this, since none of `src/main.js`
has unit tests, and it drives preset recall, edit mode, select mode, panel CRUD and
a real pointer drag, which between them exercise all five extractions.

### `hideInactiveWhenActive` costs nothing on Windows, because occlusion already throttles

Measured by self-test steps 22 and 30, which run the same 50ms interval in a
panel's renderer while a _different_ panel is promoted, once with the option off
and once with it on, in the same run on both platforms.

| platform               | occluded (`false`, today's default)   | hidden (`true`)    |
| ---------------------- | ------------------------------------- | ------------------ |
| macOS `hqmbp26-crouse` | **60 ticks** in 3000ms, the full rate | 3 ticks, about 1Hz |
| Windows `PROTO1-P8`    | **3 ticks**, about 1Hz                | 3 ticks, about 1Hz |

**On Windows the two columns are the same number.** Chromium already throttles an
occluded renderer to roughly 1Hz there, so hiding it as well changes nothing that
this measurement can see. Windows is the deployment target.

That answers the question `AGENTS.md` has carried since the option was written,
which was framed as "hiding a view may throttle it" and treated throttling as the
cost of turning it on. On the machine that matters, **that cost is already being
paid** whether the option is on or off.

**What is settled and what is not.** The liveness cost of turning it on is zero on
Windows: measured, not argued. The _benefit_ is still unmeasured. Nothing here says
how much GPU load hiding four 4K panels actually saves, only that it does not cost
anything in update rate. So the option is now safe to enable, rather than known to
be worth enabling, and the remaining work is to measure the GPU side rather than
the liveness side.

**The default has deliberately not been changed.** Enabling it is a one-line config
edit whenever somebody wants the headroom, and doing it on the strength of a
half-measured trade is exactly the kind of decision this file exists to prevent.

**A caveat on the macOS column, because it will mislead somebody otherwise.** A dev
machine shows backgrounded panels running at full speed and hidden ones crawling,
which makes the option look expensive. That impression is a property of macOS and
does not transfer. Anyone evaluating this on the dev machine will reach the
opposite conclusion from the correct one.

#### Discard does not revert the live layout

Also found by this batch, and reported rather than changed, because it is a product
question. The overlay labels Shift+Esc "discard", and it sends
`editExit({ discard: true })`, which is `exitEdit({ save: false })`. That skips the
write to `config/wall.json` and nothing else: the in-memory `config.views` keeps the
edit, so a panel dragged during the session **stays where it was dragged** until the
app restarts.

Self-test step 28 asserts the guarantee that is actually documented, that the file
on disk is byte-identical, and logs the in-memory position rather than asserting it.
Whether "discard" should also put the layout back is a decision for Jeff: the
current behaviour is defensible, since the wall is a live thing and yanking panels
back under somebody could be worse, but it is not what the word implies.

### Windows throttles a backgrounded panel to about 1Hz; macOS does not

Found by the Windows CI job on the first run of self-test step 22, which is
precisely what that job exists for. Not a flaky test: the same code, the same
assertion, two platforms, two different real behaviours.

A 50ms interval running in a panel's renderer, measured while a _different_ panel
is promoted fullscreen:

| platform                | ticks observed | effective rate                            |
| ----------------------- | -------------- | ----------------------------------------- |
| macOS, `hqmbp26-crouse` | 60 in 3000ms   | 20Hz, the full rate, no throttling at all |
| Windows, `PROTO1-P8`    | 1 in 1200ms    | about 1Hz                                 |

**`hideInactiveWhenActive` was `false` for both.** The backgrounded panel was still
visible and still had bounds; it was simply _occluded_ by the promoted panel.
Chromium throttles occluded renderers on Windows and, on this evidence, does not on
macOS.

**Why this matters for the wall, and it is not a small thing.** Windows is the
deployment target. When an operator promotes one dashboard, the other three do not
freeze, but they drop to roughly one update a second. A dashboard animating a trend
line, or one that polls every 250ms, is effectively at 1fps behind the promoted
panel, and will be showing something up to a second stale the moment it is docked
again. Nothing here is broken, and there is no bug to fix, but "the other panels
keep running" is a weaker statement on the show platform than the dev machine
suggests.

**It also partly answers the open `hideInactiveWhenActive` question**, which the
checklist framed as "flip it to `true` and check whether the hidden panels keep
running or get throttled". The premise was that leaving it `false` keeps them
running at full rate, and on Windows that premise is wrong: they are already
throttled by occlusion. So the trade is not "full rate versus throttled" but
"throttled versus hidden", which is a much smaller difference than the option's
description implies, and weakens the GPU-headroom argument for it correspondingly.
Measuring the `true` case is still worth doing, and is still on the list, but it is
now a comparison against 1Hz rather than against 20.

**Step 22 therefore asserts that the renderer did not stop, and does not assert a
rate.** Asserting any rate would be asserting one platform's behaviour and calling
the other a failure. The observed count is logged on every run, so the difference
stays visible rather than being flattened into a green tick.

#### And a scale-1.0 assumption, for the second time

The same CI run failed step 24 with `a=0.6000000000000001` where the test expected
0.75. The app was right: `panelZoom(i)` is `config.views[i].zoom * layout.scale`,
and `PROTO1-P8` fits a 1280x800 wall into a 1024x768 display at scale 0.8, so
0.75 x 0.8 = 0.6 is the correct answer. The assertion had a scale of 1.0 baked into
it, which is invisible on a dev machine where the scale _is_ 1.0.

This is the second time that exact mistake has been made in this file's history -
see "What CI covers", where three steps passed wall units to `ww:addPanel` for the
same reason - and the second time the Windows runner is the only thing that caught
it. The step now compares against `panelZoom()`, the app's own computation, and
asserts separately that the two panels' factors differ, so the check cannot be
satisfied by both being wrong in the same direction.

**The general lesson, worth stating once plainly:** on the dev machine
`layout.scale` is 1.0, which makes wall units, window pixels and configured zoom
all numerically identical to their scaled forms. Any self-test assertion written
against a literal is therefore untested until it runs somewhere the scale is not 1.

### Three gates that were documented rather than enforced

The audit's phase 4 was "self-test on every push, coverage thresholds,
`eslint:recommended`, and an asar assertion". The self-test landed first, as the
biggest CI gap. These are the other three, and they share a shape: each one was a
fact this file already asserted, with nothing checking it stayed true.

#### `eslint:recommended`, and it was already clean

The config was five hand-picked rules. It now starts from `eslint:recommended` and
adds those five on top, scoped to the same file set so it does not wander into
`dist/` or the mock pages. `@eslint/js` was already present as a transitive
dependency of eslint; it is now an explicit `devDependency`, because relying on
another package's dependency tree to keep the linter configured is the kind of
thing that breaks silently on an unrelated upgrade.

**The whole codebase passed on the first run, with no fixes needed.** That is a
weaker result than it sounds, so it was checked rather than believed: a config
that fails to apply and a config that finds nothing look identical from the
outside. Dropping a file into `src/` containing unreachable code and a duplicate
object key produced exactly the two expected errors, `no-unreachable` and
`no-dupe-keys`, neither of which any of the five hand-written rules covers. The
baseline is real.

#### Coverage thresholds

`npm run coverage` now fails below **97% lines, 87% branches, 95% functions**,
against measured 98.26 / 89.08 / 97.08. Set just under the current figures on
purpose: this is a ratchet against regression, not a target to chase, and a
threshold set exactly at the current number turns any unrelated refactor into a
red build.

Gated on the hosted Linux job, which runs on every push and PR.

**These thresholds cannot see the thing this file complains about two sections
below**, and it is worth being explicit rather than letting a green check imply
otherwise. Node's reporter lists only the files the test process actually loaded,
so a new module with no tests at all does not appear as 0%: it does not appear.
The 98.26% is over 2424 of 6406 lines. True coverage of shipped source is 38%.

So the hole is covered separately, in `test/packaging.test.js`: every top-level
`src/*.js` must have a matching `test/<name>.test.js`, or be one of the four
listed exceptions. Adding a module with no tests now fails the build. The check
runs in both directions and has a tripwire on its own exception list, so a module
that grows a test, or one that is deleted, forces the list and the table below to
be corrected rather than quietly rotting.

#### An asar assertion, in two layers

`electron-builder.yml` excludes `src/dev/**`, and it always has. Nothing ever
checked. That matters more than tidiness: `src/dev/` holds a mock server that binds
a port, probes that disable web security, and the self-test, and none of it belongs
on a show floor machine inside a customer's building. The failure mode is silent,
because an exhibit that also contains a mock server starts up perfectly.

The fast layer is `test/packaging.test.js`, which runs on every push on all three
runners and asserts the config: the exclusion exists, `asar` is on, the default
config still ships, and **the negation still comes after the `src/**/*` include
that would otherwise match it**. That last one is the sharp edge. Order is
load-bearing in electron-builder's glob list, and swapping two adjacent lines
silently ships the harness while looking like a harmless tidy-up in review.

The true layer is `npm run check:asar` (`src/dev/asar-check.js`), wired into
`build-windows.yml` and `build-mac.yml` after the build step. It reads the built
artifact rather than the config that produced it, which is the difference between
asserting the intent and asserting the outcome. It checks both directions: nothing
under `src/dev/`, `test/`, `docs/`, `.github/` or `node_modules/electron/`, and
`src/main.js`, the three renderer entry points, `config/wall.json` and
`package.json` all present. A packaging change that drops the default config does
not leak anything; it produces an exhibit that cannot start, which is the other way
this goes wrong.

**Both layers were proven against a real failure, not just written.** Each config
assertion was checked by making the exact edit it guards against and watching that
test and no other go red. The artifact check was proven by deleting the exclusion,
running a real `npm run build:mac:dir`, and confirming the result:

```
ASARCHECK dist/mac-arm64/Wallwright.app/Contents/Resources/app.asar  (57 entries)
  SHIPPED WHAT IT MUST NOT: 34 entries under src/dev/
    src/dev/activity-probe-run.js
    src/dev/capture.js
    src/dev/dev.js
    ...
```

Against 22 entries and a clean pass for the same build with the exclusion in
place. Thirty-four dev files, including the mock server and every probe, one line
away from shipping at any point in this project's life.

### The rename from Forge to Wallwright

A blanket find-and-replace across `src/` did most of it correctly: IPC channels
became `ww:*` with senders and receivers still matched, environment variables
became `WALLWRIGHT_*` consistently, and the tests stayed green throughout.

It broke the one place the old name was supposed to survive. `LEGACY_APP_NAME`
exists to name the _previous_ app so a previous install can be found; the rename
set it to `'Wallwright'`, which silently disabled the migration and left a
comment reading "called Wallwright before it was Wallwright". Nothing failed:
the app started, seeded a default config, and an upgraded show PC would have
come up with a default layout and signed-out dashboards.

That migration matters because the app name decides the userData folder, which
holds both the tuned montage and every `persist:` session. Verified after the
fix, against a staged previous install:

```
migrated the montage from the previous Forge install
migrated the saved logins too
label after migration: 'TUNED ON THE OLD INSTALL'
partitions carried across: 22
```

Note that `config/wall.json` partitions were renamed `persist:forge-N` to
`persist:wall-N` at the same time. A partition name is a storage key, so a
changed name is a new, empty session. That only affects a fresh install, since a
real deployment reads its config from userData and the migration copies the old
one across unchanged.

### Why CI cannot photograph the wall

An automated screen grab on the self-hosted Windows runner fails with "the
handle is invalid". The machine is not the problem. It has a console session,
connected. The runner is: it runs as a service in Windows **session 0**, which is
isolated from the interactive desktop, so it can neither see nor capture session

1. The diagnostic step in `screenshot-windows.yml` reports it directly:

```
UserInteractive:     False
process session id:  0
screen count:        1
  WinDisc 1024x768 primary=True     <- disconnected pseudo-display

 SESSIONNAME   ID  STATE
>services       0  Disc
 console        1  Conn             <- a real desktop, out of reach
```

It is worse than that, and the second half explains why re-registering the runner
alone would not help: **nobody is signed in**. `query user` returns "No User
exists for \*" and `explorer.exe` is not running, so there is no desktop
anywhere on the machine. The console session is sitting at the sign-in screen,
and autologon is disabled.

Two consequences. The probes and the self-test all ran against that 1024x768
pseudo-display, so they establish that `main.js` behaves and the view APIs work
on Windows, and say nothing about what the wall looks like. And the fix has two
parts, automatic sign-in and an interactive runner, which is a change to shared
infrastructure rather than to this project. `docs/windows-runner.md` has the
procedure, the trade-off, and the cheaper alternative of simply running the app
on any Windows machine with a display.

### Test coverage, measured

`npm test` runs 270 tests; `npm run coverage` reports on what they reach, and
since 2026-08-31 fails below 97% lines / 87% branches / 95% functions.
Measured 2026-08-25, thresholds added 2026-08-31.

| module                  | lines | line % | branch % | funcs % |
| ----------------------- | ----- | ------ | -------- | ------- |
| `src/layout.js`         | 307   | 100    | 97       | 100     |
| `src/control-page.js`   | 217   | 100    | 100      | 100     |
| `src/control-server.js` | 163   | 100    | 92       | 83      |
| `src/policy.js`         | 135   | 100    | 100      | 100     |
| `src/pages.js`          | 77    | 100    | 100      | 100     |
| `src/interaction.js`    | 54    | 100    | 100      | 100     |
| `src/display.js`        | 143   | 100    | 100      | 100     |
| `src/watchdog.js`       | 105   | 100    | 100      | 100     |
| `src/counters.js`       | 122   | 100    | 94       | 75      |
| `src/upkeep.js`         | 337   | 99.7   | 87       | 100     |
| `src/diag-log.js`       | 207   | 95     | 77       | 100     |
| `src/config.js`         | 553   | 94     | 79       | 100     |

**Read `npm run coverage`'s own total with care.** It reports `all files 98.26%`,
and that figure is a lie of omission: Node's reporter lists only the files the
test process actually loaded, so the four untested modules below are absent from
the table rather than shown as 0%. The total describes 2424 of 6406 lines.

True coverage of shipped source is **38%**, up from 19% when this table was first written. The rest has no unit tests:

| module                                     | lines | why not                                             |
| ------------------------------------------ | ----- | --------------------------------------------------- |
| `src/main.js`                              | 3192  | imports electron at module scope, with side effects |
| `src/overlay.js`                           | 716   | a renderer; needs a DOM and the bridge              |
| `src/preload.js`, `src/content-preload.js` | 68    | thin electron bridges                               |

`src/overlay.js` used to be the one worth acting on: roughly 260 of its lines were
a second implementation of the snapping and clamping `src/layout.js` already
tested, and the two had diverged three ways. **That is now collapsed.**
`src/layout.js` holds one implementation, parameterised on its candidate edges and
tolerance so the same code snaps window pixels during a drag and wall units before
a save, and `src/overlay.html` loads it as a plain script alongside `overlay.js`.
The file is 825 lines lighter for it, and the aspect-locked scale branch and the
proportional clamp have tests for the first time.

Collapsing them found a real bug in the wall-units half. It took the **first**
edge within tolerance where the overlay took the **closest**, so a panel shorter
than the tolerance had its top edge snapped onto a target its bottom edge was
already sitting on - moving the whole panel off the wall. `clampGrid` hid the
symptom by pulling it back. The rule is now "closest wins" everywhere, which is
what the operator sees while dragging, and what gets saved now matches it.

The pattern that works is extraction: the snapping geometry moved out to
`src/layout.js` and went straight to 100%, and `src/control-server.js` was
written to take its actions as an argument so it could be driven over real HTTP
with a stand-in. Anything in `main.js` that grows enough to be worth testing
should leave the same way.

### The self-test could not fail

`WALLWRIGHT_SELFTEST=1` is the only thing covering `main.js`, and for most of its life
it only **logged** its results. An assertion that went false printed `false` into
a log nobody reads, and the process never exited, so a regression was invisible.
The exit code came from `timeout` killing it.

It now has 62 real assertions, prints `ok` or `FAIL` per line, names what failed,
and exits non-zero. Verified by deliberately breaking one:

```
selftest 7: FAIL overlay still frontmost
selftest FAILED (1): 7: overlay still frontmost
exit code 1
```

It now gates both build workflows, which run on the self-hosted runners. Those
have real displays; the hosted Linux CI job does not, so that is the only place
it can run. Gating rather than advisory: it polls for conditions instead of
sleeping, so a loaded runner should not make it flake, and a smoke test people
learn to ignore is worse than none.

Making it fit for CI found one more thing. The upkeep check was reading whether
the pointer happened to be over the window: the pages report every `mousemove`,
so a panel under a moving mouse is perpetually "in use" and never refreshes. That
is the right behaviour and a lousy thing to hang a test on, so the test drives
the guard through `recentUseMs` instead. Worth knowing about the product too: an
administrator moving the mouse across the wall pauses refreshes for
`recentUseMs`, which is what should happen, and means refreshes only really run
when the wall is unattended.

What it covers: panel add, URL and label change, session sharing, zoom, delete,
overlay visibility across all four modes, preset save, recall and delete
including panel reuse, refresh on a timer, the in-use guard, resumption once
quiet, renderer recycling, and that views stay aligned with config and the
overlay stays frontmost throughout.

What nothing covers: `pickWallDisplay()`, the Esc policy, fullscreen handling,
the watchdog's backoff, layout scaling, and the whole of `src/overlay.js`
including the drag, snap and inspector interactions. Those are only ever
exercised by hand.

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
