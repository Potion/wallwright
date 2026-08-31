# Changelog

Wallwright is pre-1.0, so the API, the config format and the keyboard map may all
change between releases without a major bump. That is what
[semver](https://semver.org/) means by major version zero.

**The releases were renumbered once, on 2026-08-24.** What had been published as
`v0.2.0` and `v0.3.0` became `v0.1.0` and `v0.1.1`, because 0.3.0 overstated how
far along this is. Semver says a released version must never be modified, and
renumbering breaks that; it was done anyway because nothing had been downloaded
(every asset showed zero downloads) and the repository is private. It will not
happen again now that this file exists.

The Forge-named installers were deleted from both releases at the same time. The
app was called Forge until 2026-08-24; see `docs/identity.md` for why it is not
called that any more. The git tags still point at the code those installers were
built from, so nothing is unrecoverable.

## Unreleased

### The 72-hour soak finished, and there is finally a memory baseline

Third attempt, and the first to reach a verdict. It ran the full 72.0 hours on
HQ-PROTO-MINI-2 from `2026-08-27T20:31:56Z` and **passed**: 0.45 MB/hour over the
final 24 hours against a threshold of 15 fixed before T0, with the median
cross-check at 0.89 agreeing in sign and magnitude. 4320 of 4320 samples, no failed
polls, one `runId` for the whole run, zero crashes, zero failed loads, zero watchdog
reloads, and no reboot inside the window.

The `control` arm is the one that mattered, because it is a static page with no
timers, no network and no DOM changes, so growth there would have been growth in
Electron or in Wallwright rather than in anybody's dashboard. It did not climb: a 73
to 79MB band across three days, +0.021 MB/hour over the scored window, and a step
back down at h+66.5. `heavy` settled at exactly 121MB from h+24 onward, which
retires the 1.1 MB/hour reading the 16-hour checkpoint flagged as the one line to
watch; it was warm-up being extrapolated.

`_memoryBaseline` in `config/wall.json` is filled in from the run: `p95_24h` 1367,
`peak_72h` 1537, `driftMbPerHour` 0.45, which the committed rule turns into
`memoryLimitMb` 2000 and `memoryHardLimitMb` 2750. **`memoryLimitMb` is still 0.**
The baseline was measured with the video cable on a discrete GPU, where textures and
framebuffers live in VRAM and never enter the number the limit is compared against,
and nothing yet records how the show PC is cabled. A baseline from one path does not
transfer to the other, so the number is recorded and the switch stays off.

Two long-open questions are also closed. The `workingSetSize` versus private-bytes
gap is **1.44 and stable** across the whole run, not the drifting figure the two
partial runs suggested, so the app's own memory line reads about 44% high against
Task Manager. And the `URL drift samples: 4320` line that prints above `Verdict:
PASS` is not the contradiction it looks like: the verdict never consulted it, and
what it records is `grafana` and `earth` normalising their own URLs once at load,
with the two local arms never drifting at all.

The run is nonetheless **reported as partial**, because any human input is a
pre-registered invalidating condition and it took one, at `2026-08-29T00:58Z`. The
argument for the verdict is in `docs/validation.md` rather than the disclosure being
left out: `lastUsedSecAgo` shows exactly one input instant, never on the other three
arms, 19.6 hours before the scored window opens.

The write-up is `docs/validation.md` under "The 72-hour run, third attempt:
COMPLETE", and the harvested series, the app log and the summary are committed under
`docs/soak/2026-08-30-complete/`.

### The soak pre-flight fails on a busy machine, and the series records VRAM

Two soak attempts have now died because HQ-PROTO-MINI-2 was in use by another
project and nothing checked. The second was staged beside
`C:\HQ\SoDA\MS_Immersive_Tunnel.exe`, which had been holding 7758 of 8188 MiB of
VRAM at 99% GPU utilisation since the day the first attempt died, 77 minutes after
its last sample.

Nothing noticed for half an hour because Wallwright was rendering on the integrated
chip while SoDA had the discrete card, so the two never contended and every number
looked healthy. A clean-looking series is not evidence of a clean machine.

`soak-setup.ps1` now fails the pre-flight at or above 50% GPU memory or 50%
utilisation and prints `nvidia-smi` so the neighbour is named, and warns about any
foreign windowed process holding more than an hour of CPU. It fails rather than
warns because the cost of finding out late is the whole 72 hours.

`soak-proc.ps1` now records `vram_used_mb`, `vram_total_mb` and `gpu_util_pct`
after the existing ten columns, which a positional reader of the old file can still
skip. This is not bookkeeping: on a discrete GPU, textures and framebuffers live in
video memory that private bytes cannot see, so a VRAM leak would read as the
flattest and healthiest curve the harness can produce. On integrated graphics the
same allocations come out of system RAM and were always visible. Which case applies
is a question about which socket the video cable is in, so the series has to cover
both. Blank rather than zero without `nvidia-smi`, so "no discrete GPU" is not
recorded as "no VRAM in use".

### The soak can be started from the repo, not from memory

The first 72-hour run left a runbook that could tell you how to watch a run,
harvest it and tear it down, but never how to **start** one. The teardown script
existed only on the soak machine, so teardown deleted it along with the stage. The
second run had to reconstruct all five Scheduled Task definitions from the notes in
`docs/validation.md`.

The whole procedure is in `scripts/` now: `soak-stage.sh` copies the build, harness
and config from the Mac and hash-verifies the transfer; `soak-setup.ps1` expands the
build, writes the task wrappers, registers the five tasks and starts them in
dependency order; `soak-teardown.ps1` ends the run and re-enables the other
project's tasks; `soak-proc.ps1` and `soak-grab.ps1` are the OS-side recorders.

Staging deliberately stops short of starting. Staging is reversible and committing
somebody else's machine for three days is not, which is the lesson of the first
run: it ended because a person stopped it at the machine, having never been told a
run was on. Confirming the machine is free is a documented precondition now.

Three things the scripts refuse to paper over. The pre-flight **fails** rather than
warns if a `%APPDATA%\Wallwright` profile or a stale `Soak*` task is left over,
because starting on top of one both poisons the run and makes the next teardown
delete something that was not ours. Setup refuses to start the app if the mock
server is not answering on `:8787`, since both local arms would fail to load and a
failed load at T0 is a pre-registered failure. And teardown retries its deletions:
`taskkill` returns when the kill is signalled rather than when the kernel has
finished, so a single attempt leaves the expanded build behind while reporting
everything else gone.

### The soak config follows the display

`config/soak-72h.json` is authored at 1920x1080 for a landscape 3840x2160 panel. It
was 1080x1920, for the same panel mounted in portrait, which is how the first run
found it; the project that owns the machine rotated it back between the runs.

Authored to match rather than rotating the screen back, because a shared machine is
not this experiment's to reconfigure. The pre-registration survives it: what that
fixed was the raster, and 3840x2160 at device pixel ratio 2 is the same 8.29
megapixels as 2160x3840, so both runs remain comparable to each other and to a real
wall. `wall.scale` is 1.0 either way. A landscape mounting is in fact one caveat
better, since a wall is landscape.

Caught at T0 from the app's own log, which said `falling back to the PRIMARY
display` and `scaled to 0.563`. Checking that line before walking away is now a
step in the runbook: six minutes here, 72 hours if it is first read at harvest.

### The self-test now gates every push, on Windows

`npm run selftest` is the only coverage `src/main.js` has, and it only ran on a
`v*` tag. So a regression in 3,200 lines of main process could merge to `main`
completely green and surface at release time. It now runs on every push and every
PR, on the self-hosted Windows runner, along with lint and the unit tests.

Windows specifically, because Windows is the deployment target and is never
exercised on the dev machine, which is a Mac. It also restores the Windows
coverage that was dropped when the `windows-latest` job was removed for costing 2x
on a private repo - self-hosted runners are free, so that objection is gone. And
it is the only place the self-test _can_ run: it needs a real display, which a
hosted Linux runner does not have.

The macOS runner (`hqmbp26-crouse`, the development machine) runs the same three
steps, also gating, so the only coverage `src/main.js` has now runs on both
platforms the app ships to on every change. It catches the reverse case of the
Windows job - something that works on Windows and not on POSIX - and it is where
the app is actually developed, so a failure there is the fastest feedback
available.

The hosted Linux job stays, as the fifteen-second signal that does not depend on a
self-hosted machine being reachable.

**It earned itself on the first run.** Three self-test steps were passing wall
units to `ww:addPanel`, which takes window pixels - the handler runs
`unscaleRect()` on whatever it is given. At scale 1.0 on the dev machine the two
are indistinguishable, so the calls looked correct and had been green for days. On
the runner, where a 1280x800 wall is fitted into a 1024x768 display at 0.8, a panel
asked for at x=512 was created at 640, and the drag check failed. That is precisely
the class of bug a POSIX-only CI cannot see, and it was found within minutes of
turning Windows on.

The Windows step is a gate, with no `continue-on-error`, and `AGENTS.md` now
forbids adding one: a step marked that way reports a failed conclusion as
`success`, which is how a sibling project believed a broken smoke test passed for
weeks.

`docs/windows-runner.md` gains what that runner can and cannot do, which is
narrower than it looks: Electron can create and drive a real window there, and
nothing on it can photograph the desktop, because the runner is a service in
session 0. Those two facts sound contradictory and are not.

### The 72-hour soak ended early, and there is still no memory baseline

The first attempt ran 6.9 of its 72 hours. It was shut down at the machine on
2026-08-25T20:17:36Z, and the machine was needed for other work the next day, so
it was harvested and torn down on 2026-08-26. The threshold is judged on the final
24 hours of 72, so **there is no verdict**: `memoryLimitMb` stays 0 and
`_memoryBaseline` stays `NOT MEASURED YET`. A re-run is planned for 2026-08-27 and
starts from zero, because a memory curve cannot be resumed across a gap.

The 6.9 hours are worth reading, and are written up in `docs/validation.md`. The
`control` arm - a static page with no timers and no network, the one whose growth
would indict the app rather than a dashboard - went from 73MB to 74MB. Nothing
crashed, nothing failed to load, the watchdog never fired across 412 samples, and
the two drift estimators agreed at about 3.4 MB/hour against a 15 MB/hour
threshold. All of which is warm-up, not a result.

The harness came out of it well: between the sampler, the per-panel series and the
app log it dated the end to the second, proved it was a graceful `app.quit()`
rather than a crash, and ruled out both a reboot and the one pre-registered
invalidating condition. The log line that made that possible exists because of a
deliberate choice - `will-quit` writes `stopping after Ns` so that "silence at the
end of a soak log" cannot be mistaken for a clean finish.

### Ownership

- `copyright` is now `Copyright (c) 2026 Hyperquake`, and `package.json` names
  `Jeff Crouse <jeff.crouse@hyperquake.com>` as author. Both feed the shipped
  binaries: electron-builder writes the copyright into the Windows executable's
  version resource and into `NSHumanReadableCopyright` on macOS.
- **`appId` moved from `com.potion.wallwright` to `com.hyperquake.wallwright`.**
  That is the bundle identity, so Windows treats a build from here on as a
  different application from `v0.1.1`: an existing install is not upgraded in
  place, it is installed alongside, and the old entry has to be uninstalled by
  hand. Done now specifically because it is free now - no installer has been
  distributed and no asset has ever been downloaded - and it stops being free the
  moment one is.
- `userData` is unaffected. Electron derives that folder from the application
  name, not the appId, and the name is unchanged, so the tuned montage and every
  `persist:` session carry across untouched.

### Fixed

- The watchdog could take the whole wall down. `scheduleReload()` looked up a
  panel's index without guarding against `-1`, which is what it gets when a
  handler fires for a spec that `deletePanel()` or `applyPreset()` has already
  removed. The out-of-bounds lookup threw, and `uncaughtException` rethrows.
- Upkeep never actually refused to rebuild a panel mid-SSO-login. The rule was
  written and unit tested, but `popupOwner` was declared and read and never
  written to, so `popupOpen` was permanently false.
- A control-surface POST over the 1MB cap hung instead of answering. The cap
  destroyed the request while only `'end'` could settle the promise, and `'end'`
  never fires on a destroyed request. It now stops buffering, keeps draining, and
  answers 413.
- `saveViews()` wrote the live config with a plain `writeFileSync`. It now writes
  a sibling and renames, so a crash part-way through cannot truncate the file the
  wall boots from.
- `transitionMs`, `escDoubleMs` and `backButton` are validated. All three reached
  Electron as raw numbers, where a `NaN` silently disabled an animation, undid the
  Esc policy, or put the Back button at unusable bounds.
- `showHotspotHint`, `hideInactiveWhenActive`, `idleResetUrls` and
  `memoryRelaunch` must now be real booleans. A quoted `"false"` used to read as
  true, which for `idleResetUrls` meant a scheduled logout of every dashboard.
- A `globalShortcut` the OS refuses is now logged. Twelve accelerators were
  registered without checking the result, including the deliberate admin exit.
- **SSO popups had no navigation policy at all.** `hardenView()` was never
  applied to them, so the login window was the only one in the app that could
  follow a redirect chain anywhere and open further windows freely. They now get
  the same origin policy the content views get. Esc is deliberately still left to
  the page there, because docking the wall would close the popup out from under a
  half-entered password, and a popup whose renderer dies is now closed rather
  than left holding its panel ineligible for upkeep.
- **A panel could be pointed at any URL scheme and any partition.** `patch.url`
  was `String()`-coerced straight into `loadURL`, so `file:`, `javascript:`,
  `data:` and `chrome:` all worked, and `isAllowed` was never consulted on that
  path because it guards only `will-navigate` and `setWindowOpenHandler`. A
  partition without the `persist:` prefix silently became an in-memory session
  that loses the login on the next rebuild. Both are now refused with a reason,
  and the whole patch is validated before any of it is applied.
- The rectangles arriving on `ww:layout` and `ww:addPanel` are checked. A
  non-numeric field became `NaN`, passed through `clampGrid` untouched, reached
  `setBounds`, and was written into the config file.
- `POST /api/panel` answers 400 with a reason for a refused patch. It used to
  answer 200 with the wall's status, which reads as "done".

### Added

- **The layout editor's snapping is one implementation, not two.** It was written
  twice, in wall units in `src/layout.js` and in window pixels in
  `src/overlay.js`, and the two had already drifted apart. `src/layout.js` now
  holds the only copy, parameterised on its candidate edges and tolerance so it
  serves both unit spaces, and the overlay loads it as a plain script.
  `src/overlay.js` is 109 lines lighter, and the aspect-locked scale branch and
  the proportional clamp have tests for the first time.
- **Fixed a snap that moved a panel off the wall.** The wall-units half took the
  first edge within tolerance rather than the closest, so a panel shorter than the
  tolerance had its top edge snapped onto a line its bottom edge was already on.
  `clampGrid` hid it. Found by collapsing the duplication above.
- **The self-test drives a real pointer drag.** Every other check goes through IPC
  and skips the editor's geometry entirely; this one presses the mouse down on a
  panel frame, moves it, and asserts where the panel actually landed.
- `captureWall` moved to `src/dev/capture-wall.js`, required lazily so it cannot
  ship. Separately: `npm run capture` does not currently work on the dev machine,
  which is pre-existing and is now written up in `docs/validation.md`.
- **Four modules extracted from `main.js`, all at 100% coverage.**
  `src/pages.js` (the three generated pages, including the `escapeHtml` that is
  the only thing between an operator-typed label and a `data:` document),
  `src/interaction.js` (the Esc policy and the fullscreen predicate),
  `src/display.js` (which output the wall lands on, and how the layout is fitted
  into it), and `src/watchdog.js` (the backoff ladder and the failure-log
  suppression, both of which had been wrong before and fixed by hand).
- **Every content view now listens for `preload-error`.** That failure had no
  other symptom: the page renders, nothing crashes, and the wall silently stops
  knowing which panel is in use, so the idle timer docks it under an operator and
  the watchdog reloads a panel mid-login. The self-test now presses a key into a
  panel and checks the activity arrives.
- **Permissions are denied unless a panel asks for them.** Measured first
  (`npm run probe:perm`): a session with no handler grants microphone, camera and
  notifications silently, with no prompt, and leaves geolocation pending forever.
  Nothing in the app had ever touched permissions. Both
  `setPermissionRequestHandler` and `setPermissionCheckHandler` are now installed
  per partition, because neither alone closes the hole: the first is what refuses
  `getUserMedia`, the second is the only thing that stops
  `navigator.permissions.query` reporting `granted`. A panel that genuinely needs
  one names it in the new per-view `allowedPermissions`.
- **The navigation policy now covers redirects and subframes.** Measured
  (`npm run probe:nav`): `will-navigate` is handed the URL a page asked for and
  never the one it lands on, and it does not fire for a subframe at all, so four
  of six navigation shapes went straight past it - including a 302 whose target is
  not named in the request, which is what an expired session bouncing to an
  identity provider looks like. `will-redirect` and `will-frame-navigate` are now
  policed too, through the same `isAllowed()`.
- **A Content-Security-Policy on the overlay**, `default-src 'none'` with no
  exceptions. The overlay is the one renderer with a privileged bridge attached.
  Its stylesheet moved to `src/overlay.css` so `style-src` did not need an
  `'unsafe-inline'` hole; `src/overlay.html` is 444 lines shorter.
- `npm run probe:perm` and `npm run probe:nav`, both wired into
  `probe-windows.yml`. One runner, `src/dev/probe-serve.js`, serves the mocks for
  either and fails loudly if its server does not start, rather than silently
  measuring whatever else holds the port.
- `src/policy.js`: what a panel may load, and where it may navigate. The origin
  policy moved out of `main.js`, where it had no tests despite deciding whether a
  navigation or a popup is blocked, and it gained a fixed scheme allow-list.
- Unknown config keys are warned about on load. `memoryLimitMB` or `escToGird`
  used to validate, do nothing, and say nothing. A leading underscore still means
  documentation, so `_comment`, `_memoryBaseline` and `_soak` stay quiet.

### Changed

- `engines.node` is now `>=22`, which is the oldest version CI actually exercises
  and what the coverage thresholds require. `>=18` was never tested.

## 0.1.1 - 2026-08-24

Published earlier as `v0.3.0`.

### Renamed to Wallwright

- The product, the bundle, the installer, the `appId` (`com.potion.wallwright`),
  the environment variables (`WALLWRIGHT_*`), and the docs. The old `FORGE_*`
  variables are gone.
- **An existing install is carried across on first run.** An Electron app derives
  its userData folder from its own name, and that folder holds both the tuned
  montage and every `persist:` session, so a rename alone would have brought a
  show PC up with a default layout and signed-out dashboards.
  `migrateLegacyUserData()` copies both, and copies rather than moves so a
  rollback still finds the old install intact.
- `config/wall.json` partitions moved from `persist:forge-N` to `persist:wall-N`.
  A partition name is a storage key, so that is a new empty session, but it only
  affects a fresh install: a real deployment reads its config from userData, and
  the migration copies that across unchanged.

### A visual identity

- A new mark and app icon: an authored montage, one hero panel wearing the layout
  editor's corner grips, rather than the quad split every product in this category
  draws. Generated by `npm run icon`, never hand-drawn.
- A wordmark on the editor's bar and the control page, and nowhere else. Grid and
  active mode stay unbranded so a visitor sees the dashboards rather than the
  thing hosting them.
- The palette is now one set of tokens in `src/overlay.html`, mirrored by name in
  `src/control-page.js`, replacing about forty scattered literals.
- `docs/identity.md` records the name, the mark, the type, the palette, the
  placement rules, and which names were unavailable and why.

### A control surface for administrators

- Set `control.port` and the wall serves a status page an administrator can open
  from a laptop or phone: mode, memory, uptime, and every panel's size, position,
  zoom, load state, watchdog history and idle time.
- **Where a panel actually is**, flagged when it has drifted from its configured
  URL, which is how a silently logged-out dashboard gets noticed.
- The same routes are an API, so a show controller can drive the wall:
  `GET /api/status`, and `POST` to `/api/preset`, `/api/panel`, `/api/promote`
  and `/api/reload`.
- Unauthenticated, and it can drive the wall, so it binds to `127.0.0.1` unless
  told otherwise and logs a warning when it is not on loopback.

### Saved montages

- A montage can be saved under a name and recalled later, so one wall serves an
  overview layout, a detail layout, and whatever a given demo needs.
- `Ctrl/Cmd+Shift+1` through `9` recall the first nine without opening the editor.
- Recalling reuses panels that have not changed rather than rebuilding them, so
  switching montages does not reload pages that were already right.

### Keeping a long-running wall healthy

- Per-panel `refreshMs` and `recycleMs`, so a dashboard cannot go stale and a
  renderer can hand memory back on a timer.
- `memoryCheckMs` and `memoryLimitMb`: past the limit, the least recently used
  idle panel is recycled. The panel someone is currently using is never touched.

### Interaction

- Grid panels are live and usable where they sit. Promotion became its own mode
  (`Ctrl/Cmd+Shift+P`), because a click in the grid belongs to the page
  underneath.
- `WALLWRIGHT_LOG_INPUT=1` logs which panel each click and keypress reaches, so
  input routing can be checked rather than eyeballed.

### Verification

- The self-test now **gates** both build workflows. It drives the real app over
  IPC and needs a real display, which is why it runs on the self-hosted runners.
- Test coverage is measured (`npm run coverage`); 80 unit tests.
- Windows probes confirmed the view APIs match macOS and that every fullscreen
  path covers the display there.
- **Still unverified:** that the transparent overlay composites over live panels
  on Windows, which is the architecture's central assumption. The self-hosted
  runner cannot answer it: the runner is a service in session 0 and nobody is
  signed in, so there is no desktop to photograph. See `docs/windows-runner.md`.

## 0.1.0 - 2026-08-24

Published earlier as `v0.2.0`. Its installers were named `Forge-0.2.0` and have
been deleted; this release is source only.

- The wall: one `BaseWindow` with a `WebContentsView` per panel and a transparent
  overlay above them for click targets and chrome. No compositor and no video
  capture, so the pages stay live and interactive.
- A layout editor on top of the live pages (`Ctrl/Cmd+Shift+E`): move, resize from
  a side, scale from a corner, draw a new panel on empty wall, delete. Panels snap
  to each other and to the wall edges, twice, so an edge that looks snapped while
  previewing a 4K layout on a laptop does not save a one-pixel seam.
- Panel CRUD and an inspector for URL, label, zoom and session.
- Sessions persist across restarts, and panels can share one so several views of
  the same SSO-protected app sit behind a single login.
- macOS needs `setSimpleFullScreen`: every native fullscreen and kiosk path
  reports success while leaving the menu-bar strip uncovered.
- A notch-safe layout option for development on a MacBook.
- Windows and macOS packaging, and a wall capture tool that needs no
  screen-recording permission, which is how the README screenshots are made.
