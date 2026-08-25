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
  active-mode Back button. **Transparency is confirmed working on macOS**; none
  of the `SPEC.md` fallbacks are needed there.
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
self-hosted runners. `npm test` is 80 tests, `npm run selftest` is 20 end to end
assertions, and both gate every build. CI is green.

The app is **Wallwright**, the repository is `Potion/hon-wallwright`, and the npm
package is `hon-wallwright`. An earlier note here said the repository would stay
`hon-forge` to avoid breaking clones and release URLs; that turned out to be a
non-issue, because GitHub permanently redirects both after a rename. A stale clone
keeps pushing to the old URL and it still works.

**The releases were renumbered on 2026-08-24.** What shipped as v0.2.0 and v0.3.0
is now v0.1.0 and v0.1.1, and every `Forge-*` installer has been deleted from
both. Nothing had been downloaded, so it was free to do, and `CHANGELOG.md`
records it so nobody does it a second time. Anything built from here on is
`Wallwright-*`.

**One thing is genuinely unverified and it is the important one.** Overlay
compositing on Windows. Everything CI can prove about Windows is proven: the
view APIs, the fullscreen paths, `main.js` behaviour, and the build. What is
missing is a person looking at the wall on a Windows machine. Do that before
anything else; if it fails, the `SPEC.md` fallbacks are the plan, and the
build-versus-buy question genuinely reopens.

Parked, not abandoned: making the self-hosted Windows runner able to photograph
the wall. It cannot today because nobody is signed in to that machine and the
runner is a service in session 0. `docs/windows-runner.md` has the full
diagnosis, a script, and the security trade-off. Jeff decided this is not needed
right now, and the cheaper path is simply to run the app on any Windows machine
with a display.

## Build / harden next (TODO)

1. **Look at the wall on Windows.** See above. Highest value, roughly an hour,
   and it is the only remaining architectural risk.
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
9. **Sustained run.** A working day against the real dashboards, watching memory
   and session expiry. Two panels and the overlay already measured 699MB.
10. Optional polish: an idle countdown before auto-return, and a manual "reset
    panel" action.

## Open decisions (need Jeff)

- Whether to rename the repository and npm package to match the app. Left alone
  so far because it breaks clones and existing release URLs.

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
