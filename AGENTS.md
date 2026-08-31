# AGENTS.md - implementation handoff

This repo is a working app with a dev harness, not a finished product. Read
`SPEC.md` first for the design and the reasoning, then `docs/validation.md` for
what has actually been observed running. Below is what is done, what to build,
and the decisions that need Jeff before some of it can be finalized.

## What works today

- Loads and **validates** `config/wall.json` (57 tests in `test/config.test.js`).
  A bad config shows a readable error on the wall instead of a stack trace.
- One kiosk `BaseWindow` at wall size, targeted by `wall.displayLabel` /
  `wall.displayId` / resolution match, with loud warnings when it has to fall
  back to the primary display or when the config resolution disagrees with the
  chosen output. Re-targets on display add/remove/metrics-changed.
- Four content `WebContentsView`s, each with its own persistent session
  partition and per-view `zoomFactor`.
- Transparent overlay `WebContentsView` on top with grid hotspots and an
  active-mode Back button. **Transparency is confirmed working on macOS and on
  Windows**; none of the `SPEC.md` fallbacks are needed on either.
- Grid/active state machine with native animated transitions (`transitionMs`).
  Click a hotspot to fullscreen a panel; Back / double-Esc / idle timeout returns
  to the grid without reloading.
- Hardening: SSO popups allowed and centered on the wall, an `allowedOrigins`
  navigation policy (permissive when empty), a watchdog that will not reload the
  panel someone is using, single-instance lock, no application menu.
- Layout edit mode (`Ctrl/Cmd+Shift+E`) is a full montage editor: corners scale
  proportionally with the page zoom following the frame, sides resize one axis
  and let the page reflow, the body drags to move. Edges snap to each other, the
  wall edges, and the wall centre lines, in wall units so saved layouts have no
  seams. Panels are added by drawing on empty wall or an Add button, deleted with
  Del, and an inspector edits URL, label, zoom and session. Esc saves the whole
  panel list back to config, Shift+Esc discards.
- Panels are created and destroyed at runtime, so the count is not fixed at four
  and `views` may be empty.
- Named montages (presets), per-panel refresh and renderer recycling, memory
  reporting, and an optional HTTP control surface with a status page.
- `wall.fitToDisplay` scales and centres the authored layout into whatever window
  it gets, so a 3840x2160 wall layout is previewable on a laptop at the same
  proportions it will have on the wall.
- Dev harness: `npm run dev` serves four local mock dashboards that exercise
  login/session persistence, Esc handling, an SSO popup flow, and per-panel zoom.
- Packaging with electron-builder, and five CI workflows. `ci.yml` runs on every
  push and PR on two runners: hosted Linux for lint and the unit tests, and the
  self-hosted Windows runner for lint, the unit tests and **the self-test**, which
  is the only coverage `src/main.js` has. Then Windows and macOS installer builds
  on tags, a manual Windows probe job that answers the open platform questions
  without the show PC, and a parked screenshot job that cannot run (see "Parked"
  below).

## Where this was left

**`package.json` is 0.1.2 and `CHANGELOG.md` has its section written.** The
artifacts only exist once a `v0.1.2` tag is pushed, which is what
`build-windows.yml` and `build-mac.yml` fire on; until then **v0.1.1** is still the
newest published release. The headline of 0.1.2 is Electron 43.4.1 to 44.1.0
(Chromium 150 to 152) plus the navigation, permission and popup hardening done
since the last tag.

`npm test` is 270 tests, `npm run selftest` is 85 end to end assertions, and both
gate every build. CI is green.

The app is **Wallwright**, the repository is `Potion/wallwright`, and the npm
package is `wallwright`. The `hon-` prefix is gone with the rest of the Honeywell
naming: the exhibit is for Honeywell, but nothing in the app is specific to them,
and the prefix implied otherwise.

An earlier note here said the repository would stay `hon-forge` to avoid breaking
clones and release URLs; that turned out to be a non-issue, because GitHub
permanently redirects both after a rename. A stale clone keeps pushing to the old
URL and it still works.

**The releases were renumbered on 2026-08-24.** What shipped as v0.2.0 and v0.3.0
is now v0.1.0 and v0.1.1, and every `Forge-*` installer has been deleted from
both. Nothing had been downloaded, so it was free to do, and `CHANGELOG.md`
records it so nobody does it a second time. Anything built from here on is
`Wallwright-*`.

**The architectural risk is closed.** Overlay compositing on Windows was the one
genuinely unverified thing, and it works: confirmed 2026-08-25 on HQ-PROTO-MINI-2
with a packaged build, editor chrome and an inspector drawn over live page content.
See "Overlay compositing on Windows: WORKS" in `docs/validation.md`. None of the
`SPEC.md` fallbacks are needed, and the build-versus-buy question stays closed.

**What is unverified now is longevity, not architecture.** The memory
countermeasure ships switched off because the number that would engage it has to
come from a measured baseline.

**The 72-hour soak is DONE and it PASSED.** The third attempt ran the full 72.0
hours on HQ-PROTO-MINI-2, `2026-08-27T20:31:56Z` to `2026-08-30T20:32:07Z`, and was
harvested on 2026-08-31. **0.45 MB/hour over the final 24 hours against a
pre-registered 15**, median cross-check 0.89 agreeing, 4320/4320 samples, zero
crashes, zero restarts, zero watchdog reloads, no reboot. The `control` arm, the
only one whose growth would have indicted the product, did not climb. `heavy`
plateaued at exactly 121MB from h+24 onward, which closes the one question the
16-hour checkpoint left open. Written up in `docs/validation.md` under "The 72-hour
run, third attempt: COMPLETE"; data in `docs/soak/2026-08-30-complete/`.

**It is reported as partial, and deliberately so.** One human input instant reached
the `control` panel at `2026-08-29T00:58Z` when somebody closed an unrelated app on
that machine. Any human input is a pre-registered invalidating condition, so it is
disclosed and argued rather than omitted: `lastUsedSecAgo` proves it was exactly one
event, it never touched the other three arms, and it is 19.6 hours before the scored
window opens. The verdict stands on a clean final 24 hours.

**The memory countermeasure is switched ON**, for the first time since it was
written. `_memoryBaseline` is filled in with `p95_24h` 1367, `peak_72h` 1537 and
`driftMbPerHour` 0.45, and `config/wall.json` now ships `memoryLimitMb` **2000** and
`memoryHardLimitMb` **2750** from the committed rule. What unblocked it: Jeff
confirmed on 2026-08-31 that the show PC's HDMI is always in the discrete GPU port,
the same path the baseline was measured on, so it transfers. If a show PC ever runs
off the motherboard port the baseline is void and must be re-measured.

**The limit is a guard, not a tuned figure.** It was measured against the soak
lineup, not the real Honeywell dashboards, which are the thing most likely to move
`p95_24h`. Re-measure when the real URLs land.

Also settled by the run: the `workingSetSize` versus private-bytes gap, open since
the original 699MB datum, is **1.44 and stable**, not the drifting figure the
partial runs suggested. The app's own number reads about 44% high.

**The machine is torn down and given back**, on 2026-08-31, after the archive was
taken and hash-verified. Checked independently of the teardown script's own output:
stage and `%APPDATA%\Wallwright` gone, no Wallwright or node processes, no `Soak*`
task, and all three `FCAT*` tasks back to `Ready`. The app had reached 90.8 hours of
continuous uptime. It belongs to another project, so if you stage a run there again:
**do not RDP to it**, because a remote session hijacks console session 1 and blanks
the physical display, which is a pre-registered invalidating condition.

Parked, and now largely moot: making the self-hosted runner photograph the wall.
The question it existed to answer has been answered another way, on a machine that
already has a signed-in console session. `docs/windows-runner.md` still has the
diagnosis and the security trade-off if per-build screenshots are ever wanted, and
`docs/validation.md` has the pattern that worked instead: a Scheduled Task with an
`InteractiveToken` principal, everything else over SSH.

## Build / harden next (TODO)

1. **Re-measure the memory baseline once the real dashboards are wired.** The
   countermeasure is now on at `memoryLimitMb` 2000, but that came from the soak
   lineup, not from the real Honeywell dashboards. They are the one thing most
   likely to move `p95_24h`, and a limit that lands inside the normal operating band
   is worse than no limit: measured, it took memory _up_ from 1513 to 1885MB while
   recycling every five seconds. Treat 2000 as a runaway guard until then, and
   re-derive it from `_memoryBaseline`'s rule against real content.
2. **Fix the two harness defects the run exposed**, before any fourth soak. The
   grab task's console knocks the window to scale 0.999 and the geometry check
   cannot see it; the sampler should record the app's reported scale as a column.
   And `urlDrifted` is a per-sample state reported under an event's name, which
   makes a passing summary read as a failure. Both are written up in
   `docs/validation.md`.
3. **Walk the checklist in `docs/validation.md` "Still to verify".** Grouped by
   where each check can be done: (A) on the dev machine now, (B) blocked on the
   real dashboard URLs, (C) needs the show PC.
4. **Real URLs and wall geometry.** Set the dashboard URLs, the wall resolution,
   the panel rectangles and the per-panel `zoom` against the real dashboards.
   Everything else is guesswork until this lands.
5. **Scope `allowedOrigins`** to the real Honeywell IdP and app domains once
   known. Enforcement already exists for `will-navigate` and
   `setWindowOpenHandler`, so this is a config edit. It is a misconfiguration
   guard, not hardening: only administrators have input.
6. **Code signing**, both platforms. No certificates yet. README "Signing" lists
   exactly which secrets each needs. Unsigned builds are warned about by
   SmartScreen and quarantined by Gatekeeper, and a signed build is easier for
   Honeywell IT to approve.
7. **~~Auto-launch on boot~~ built; crash restart is scripted and unrun.** The
   `autoStart` setting registers a login item, reconciled at every boot and
   toggleable from the control page. It is unverified on Windows: the only Windows
   machine here is a CI runner, and registering a login item on one is not an
   acceptable side effect of a build. **A login item cannot cover a crash** - it
   fires once at logon, and a main process that has died cannot restart itself -
   so that half is `scripts/wallwright-autostart.ps1`, a Scheduled Task with
   restart-on-failure, committed deliberately unrun. Both are in
   `docs/validation.md` group C. Do not use the two together: they launch two
   copies at logon and the second one exits on the single-instance lock.
8. **Cursor auto-hide when idle.** Needs a native Windows approach; there is no
   cross-platform Electron API.
9. **Decide `hideInactiveWhenActive`** (default off). **The liveness half is
   answered: on Windows it costs nothing.** Self-test steps 22 and 30 measure a
   backgrounded panel at about 1Hz on Windows whether the option is on or off,
   because Chromium already throttles an occluded renderer there. On macOS the
   same panel runs at the full rate when merely occluded, so a dev machine makes
   the option look expensive and will mislead you. What is still unmeasured is
   the benefit: how much GPU load hiding four 4K panels actually saves. So it is
   safe to enable rather than known to be worth enabling, and the default is
   deliberately unchanged. See "`hideInactiveWhenActive` costs nothing on
   Windows" in `docs/validation.md`.
10. **Sustained run against the real dashboards**, once the URLs exist, for
    session expiry rather than memory. Four live public dashboards measured
    1513MB.
11. Optional polish: an idle countdown before auto-return, and a manual "reset
    panel" action.

## Open decisions (need Jeff)

- Real dashboard URLs and the wall's true resolution and panel layout.
- ~~Esc behavior.~~ **Decided 2026-08-21: `escToGrid: "single"`.** A single Esc
  returns to the grid. Revisit only if a real dashboard needs Esc for its own
  modals, in which case `"double"` or `"off"` is a one-word config change. See
  `docs/validation.md`.
- Idle auto-return duration (production default 4 minutes) and whether the hover
  hint on panels is wanted in grid mode (`showHotspotHint`).
- Whether any panel legitimately navigates across subdomains (affects
  `allowedOrigins`).
- Honeywell IT posture on a custom Electron app vs a managed browser; this may
  change packaging and signing needs.

## Conventions

- Keep all layout/content in `config/wall.json`; do not hardcode URLs or rects.
- Target is Windows; development is macOS. Use project-relative paths, never
  absolute machine paths.
- Do not reload a view on return-to-grid, and never reload a panel that is in
  use: the promoted one, or any touched within `recentUseMs`. `scheduleReload()`
  defers instead. Note the reason: a reload does **not** log anyone out, since
  cookies live in the `persist:` partition (`npm run probe:session` measures
  this). It throws away the interaction in progress, which is the thing worth
  protecting. Recycling a whole view is different again: it also clears
  `sessionStorage`, so an app keeping its token there would be signed out.
- Only administrators have input, so the wall is idle nearly all the time.
  Anything hung off the idle timer fires constantly in normal operation. That is
  why `idleResetUrls` defaults to off: reloading on idle would log every
  dashboard out on a schedule. Think twice before adding idle-triggered
  behaviour.
- Esc must not be a `globalShortcut`. It is an OS-level accelerator that fires
  regardless of focus and consumes the key before the page sees it, which kills
  Esc-to-close inside the dashboards. Handle it per view in `hardenView()`.
- Anything asserted about an Electron API should be verified, not assumed. Add a
  case to `src/dev/probe.js` or `src/dev/fsprobe.js` and record the answer in
  `docs/validation.md`.
- npm scripts must run on Windows too, so no `FOO=1 cmd` prefixes and no shell
  loops. Put the environment setup inside the node script instead.
- Nothing under `src/dev/` ships: `electron-builder.yml` excludes it, and two
  things now enforce that rather than trusting it. `test/packaging.test.js` asserts
  the config on every push, including that the `!src/dev/**` negation still comes
  **after** the `src/**/*` include that would otherwise match it, because the order
  is load-bearing and swapping two adjacent lines looks harmless in review.
  `npm run check:asar` reads the built artifact in the build workflows. Adding
  anything to the `files` list means re-reading both.
- A new top-level `src/*.js` needs a `test/<name>.test.js`, or an entry in
  `KNOWN_UNTESTED` in `test/packaging.test.js` **and** in the table in
  `docs/validation.md`. The coverage thresholds cannot catch a module with no tests
  at all: Node's reporter only lists files the test process loaded, so an untested
  module is absent from the report rather than shown as 0%.
- The README is the non-developer entry point: what the thing does, with
  screenshots, before any build instructions. Regenerate the images with
  `npm run capture` after a visible change to the wall or the editor.
- Panels may deliberately share a session partition, so do not reintroduce a
  uniqueness check on it. Several views of one SSO-protected app need one login.
- Never capture a view's index in a closure. Panels can be deleted, which shifts
  every later index; resolve it from the spec object with
  `config.views.indexOf(v)` at call time.
- `src/main.js` has no unit tests, so after changing panel lifecycle behaviour
  run `WALLWRIGHT_DEV=1 WALLWRIGHT_SELFTEST=1 npm start`. It exits non-zero on failure, so
  check the code, not just the log.
- New logic that could live without electron should. Extraction is what got
  `src/layout.js` and `src/control-server.js` to full coverage; anything left in
  `main.js` is testable only by the self-test. This cuts finer than whole
  functions: `memorySnapshot()` is one call to `app.getAppMetrics()` wrapped in a
  try, and the arithmetic over the result is `summarizeMetrics()` in
  `src/upkeep.js`, where a captured payload can be handed to it. A function that
  reaches for an Electron API in the middle of a calculation is two functions.
- Add a `check()` to the self-test for behaviour you would otherwise verify by
  eye, and make sure it can actually fail. It once only logged, so nothing ever
  went red.
- The control surface is unauthenticated by design and binds to loopback. If
  that ever changes, it needs auth first, not a comment.
- **Auto-start is two mechanisms for two failures, and they do not substitute for
  each other.** `src/autostart.js` is the login item: it answers "the machine
  rebooted". Only something outside this process can answer "the app died", which
  is `scripts/wallwright-autostart.ps1`. Anything that runs a GUI app from a
  Scheduled Task must make the exe the action itself, never a `.cmd` or
  `powershell` wrapper: the wrapper returns immediately, the task completes, and
  restart-on-failure becomes decoration. `docs/soak-run.md` has the run where
  that was discovered.
- Anything that reloads a panel on a timer must skip panels in use. `eligible()`
  in `src/main.js` is the single check and upkeep, the memory ladder and the
  watchdog all route through it; do not write a second one. It replaced an earlier
  `inUse()`, which this list named until 2026-08-31.
- **One helper per repeated decision, and these four are the ones that exist.**
  `loadPanel(view, v)` is the only place that decides what a panel loads, including
  what an empty URL means; `indexOfId(id)` is the only id-to-index lookup;
  `contentWebPreferences(v)` is the security posture for both surfaces that render
  a third party's page; `showPanelsInGrid()` and `raiseOverlay()` are the mode-entry
  sequences. Each of the first three existed already and was being bypassed by
  inline copies that agreed with it only by coincidence. `contentWebPreferences` is
  the one to be careful with: a second copy that drifts on `contextIsolation` or
  `sandbox` is a security regression that still logs people in perfectly.
- Ask `panelStateAt(i)` for one panel and `panelStates()` for all of them. Building
  the whole array to index one element out of it is what made the upkeep tick
  quadratic: `eligible()` did it, and `runUpkeep()` calls `eligible()` once per
  panel per second. `panelStateAt()` returns null for an index whose panel is gone,
  which is a real case rather than a defensive one, because `deletePanel()` splices
  a spec out while that view's handlers are still attached.
- Do not build markup with inline event handlers in `src/control-page.js`. The
  first version did and the escaping collapsed into an unparseable page. Use
  `data-` attributes and the delegated listener.
- A new config knob goes in one of the tables in `src/config.js`
  (`NON_NEGATIVE`, `BOOLEANS`, `WATCHDOG_NON_NEGATIVE`) **and** in the matching
  `KNOWN_*` set. The tables exist because `memoryCheckMs` once shipped unchecked
  while everything around it was covered, and `transitionMs`, `escDoubleMs` and
  `backButton` were found the same way in the 2026-08-25 audit. The `KNOWN_*`
  sets are what make `unknownKeys()` able to warn about a typo; a knob missing
  from them is reported as unknown, so the test over every committed config
  catches it.
- Unknown config keys are a **warning, not a problem**. `validateConfig`'s list
  is fatal, and these files are hand-edited on a show floor: refusing to boot over
  a stray key is a worse failure than ignoring one. A leading `_` means
  documentation and stays quiet.
- Anything that writes a file the wall reads at boot writes a sibling and renames.
  `src/config.js` `saveViews()` and `src/diag-log.js`'s rotation both do this, so
  a crash part-way through cannot leave a truncated file behind.
- `globalShortcut.register()` returns false when the OS refuses an accelerator.
  Check it. Twelve were registered unchecked, including the admin exit, and a
  collision is otherwise discovered at a venue.
- Navigation and panel-source policy lives in `src/policy.js`, not in `main.js`.
  Two separate questions kept apart on purpose: `allowedOrigins` is a
  configurable misconfiguration guard, while the http/https scheme list and the
  `persist:` partition rule are fixed, because no config should be able to point
  a wall panel at the show PC's disk or at a session that loses its login.
- Anything that mutates a panel validates the **whole** patch before applying any
  of it, and returns `{ ok, reason }` rather than a boolean. A half-applied patch
  leaves a panel with a new label and its old URL, and a caller that cannot say
  why it refused produces a wall that silently ignores instructions.
- `hardenView()` is for content views and `hardenPopup()` is for SSO popups, and
  they are deliberately different. A popup gets the origin policy but **not** Esc
  handling, because Esc in a login form belongs to the page and docking the wall
  would close the popup over a half-entered password. It also gets no watchdog
  reload: there is no configured URL to recover to, so a dead popup is closed.
- The navigation policy is **three events, not one**: `will-navigate`,
  `will-redirect`, and `will-frame-navigate` filtered to subframes. Measured
  (`npm run probe:nav`): `will-navigate` is handed the URL a page asked for and
  never the one it lands on, and it does not fire for a subframe at all, so on
  its own it lets four of six navigation shapes through. All three route through
  the same `isAllowed()`; do not add a fourth policy.
- **Permissions are deny-by-default, per view, via `allowedPermissions`.** Note
  the polarity is the opposite of `allowedOrigins`: empty origins means
  permissive, empty permissions means none. Measured (`npm run probe:perm`): a
  session with no handler grants microphone, camera and notifications silently
  and leaves geolocation pending forever. Both `setPermissionRequestHandler` and
  `setPermissionCheckHandler` are needed; neither alone closes the hole.
- Permission handlers hang off `createContentView()`, not off startup. A brand-new
  partition can appear at runtime from `addPanel()`, from a partition change in
  `updatePanel()`, or from a preset naming one nothing has seen. The handler
  resolves the requesting `webContents` to a view at call time rather than
  capturing one, because panels may share a partition.
- The overlay's CSP is `default-src 'none'` with no exceptions, which is why the
  stylesheet lives in `src/overlay.css` rather than inline in `overlay.html`.
  Adding an inline `<style>`, an inline `<script>`, or any remote asset to that
  page will silently break it; put styles in the css file.
- **`src/content-preload.js` cannot require anything but `electron`.** It is a
  preload in a sandboxed renderer, where `require()` is limited to a handful of
  built-ins. Pulling its throttle out into a shared module was tried and reverted:
  it fails with "module not found", takes activity reporting to zero, and does it
  in total silence - the page still renders and nothing crashes. Keep that file
  self-contained; a few duplicated lines are cheaper than a wall that stops
  knowing which panel is in use.
- Every content view listens for `preload-error`, because that failure has no
  other symptom. `src/overlay.js` is a plain `<script src>` rather than a preload
  and is not subject to the same limit, but it cannot `require()` either.
- **`src/layout.js` is loaded two ways** and must stay loadable both: the main
  process and the tests `require()` it, and `src/overlay.html` serves it to the
  renderer as a plain `<script>` before `overlay.js`. That is why it ends with a
  guarded `module.exports` plus a `globalThis` assignment, and why it must never
  import anything. It exists in that shape because the snapping used to be
  written twice, in wall units here and window pixels there, and the two had
  already drifted apart.
- **Never put `continue-on-error` on the self-test step.** It reports a failed
  step's conclusion as `success`, so the gate silently stops being a gate. A
  sibling project ran a broken smoke test for weeks that way. If the self-test
  flakes, fix the test; it polls for conditions rather than sleeping precisely so a
  loaded runner does not make it flake.
- A `check()` added to the self-test must be **proved able to fail** by breaking
  the thing it covers and watching it go red. Two ways this has bitten: a check
  that passed because a popup had guarded the same partition as a side effect,
  and one that passed because `uniqueId()` handed back a deleted id and with it
  an already-guarded partition. Make the thing under test unmistakably new. Steps 16 and 17 were verified that
  way; step 16's failure message reproduces the exact crash it guards against.
