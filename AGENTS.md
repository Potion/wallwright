# AGENTS.md - implementation handoff

This repo is a working app with a dev harness, not a finished product. Read
`SPEC.md` first for the design and the reasoning, then `docs/validation.md` for
what has actually been observed running. Below is what is done, what to build,
and the decisions that need Jeff before some of it can be finalized.

## What works today

- Loads and **validates** `config/wall.json` (12 tests in `test/config.test.js`).
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
- Packaging with electron-builder, and three CI workflows: lint/test on Ubuntu
  and Windows, a Windows installer build, and a manual Windows probe job that
  answers the open platform questions without the show PC.

## Where this was left

Released as **v0.1.1** with Windows and macOS artifacts, built on Potion's
self-hosted runners. `npm test` is 133 tests, `npm run selftest` is 38 end to end
assertions, and both gate every build. CI is green.

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

**A 72-hour soak is IN FLIGHT.** Started 2026-08-25T13:24:29Z on HQ-PROTO-MINI-2,
ending Friday morning. `docs/soak-run.md` is the runbook: what is running, how to
read it without disturbing it, how to harvest and tear down, and what to do with
the numbers. Read that first if you are picking this up.

Two things to know before touching that machine. It belongs to another project, and
`FCATWallLauncher` and `FCATSoakSampler` are disabled for the duration and are
re-enabled by the teardown script. And **do not RDP to it**: a remote session
hijacks console session 1 and blanks the physical display, which is a
pre-registered invalidating condition.

Parked, and now largely moot: making the self-hosted runner photograph the wall.
The question it existed to answer has been answered another way, on a machine that
already has a signed-in console session. `docs/windows-runner.md` still has the
diagnosis and the security trade-off if per-build screenshots are ever wanted, and
`docs/validation.md` has the pattern that worked instead: a Scheduled Task with an
`InteractiveToken` principal, everything else over SSH.

## Build / harden next (TODO)

1. **Finish the soak.** It is running; see `docs/soak-run.md`. When it ends:
   harvest before tearing down, judge the final 24 hours against the pre-registered
   15 MB/hour, quantify the workingSetSize versus private-bytes gap at the plateau,
   and set `memoryLimitMb` from the rule in `config/wall.json` `_memoryBaseline`
   rather than by guessing. A limit inside the normal operating band was measured
   taking memory _up_, from 1513 to 1885MB.
2. **Walk the checklist in `docs/validation.md` "Still to verify".** Grouped by
   where each check can be done: (A) on the dev machine now, (B) blocked on the
   real dashboard URLs, (C) needs the show PC.
3. **Real URLs and wall geometry.** Set the dashboard URLs, the wall resolution,
   the panel rectangles and the per-panel `zoom` against the real dashboards.
   Everything else is guesswork until this lands.
4. **Scope `allowedOrigins`** to the real Honeywell IdP and app domains once
   known. Enforcement already exists for `will-navigate` and
   `setWindowOpenHandler`, so this is a config edit. It is a misconfiguration
   guard, not hardening: only administrators have input.
5. **Code signing**, both platforms. No certificates yet. README "Signing" lists
   exactly which secrets each needs. Unsigned builds are warned about by
   SmartScreen and quarantined by Gatekeeper, and a signed build is easier for
   Honeywell IT to approve.
6. **Auto-launch on boot and crash restart**, for unattended operation.
7. **Cursor auto-hide when idle.** Needs a native Windows approach; there is no
   cross-platform Electron API.
8. **Decide `hideInactiveWhenActive`** (default off). Several live dashboards on
   a 4K wall is real GPU load, but hiding a view may throttle it. Mock 4's ticker
   exists to measure this.
9. **Sustained run against the real dashboards**, once the URLs exist, for session
   expiry rather than memory. Four live public dashboards measured 1513MB.
10. Optional polish: an idle countdown before auto-return, and a manual "reset
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
- Nothing under `src/dev/` ships: `electron-builder.yml` excludes it.
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
  `main.js` is testable only by the self-test.
- Add a `check()` to the self-test for behaviour you would otherwise verify by
  eye, and make sure it can actually fail. It once only logged, so nothing ever
  went red.
- The control surface is unauthenticated by design and binds to loopback. If
  that ever changes, it needs auth first, not a comment.
- Anything that reloads a panel on a timer must skip panels in use. `inUse()` is
  the single check; do not write a second one.
- Do not build markup with inline event handlers in `src/control-page.js`. The
  first version did and the escaping collapsed into an unparseable page. Use
  `data-` attributes and the delegated listener.
