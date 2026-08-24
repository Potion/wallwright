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

## Build / harden next (TODO)

1. **Walk the checklist in `docs/validation.md` "Still to verify".** 30 items in
   three groups: (A) mechanical, doable on the dev machine right now, (B) blocked
   on the real dashboard URLs, (C) needs the Windows show PC and the real wall.
   Group A is the highest-value next action; group C is where the real risk is.
2. Re-check **overlay transparency on the Windows show PC**. This is the one
   thing CI cannot answer, and the whole architecture rests on it. The Electron
   API questions are settled: the **Probe Windows** workflow confirmed the view
   APIs behave exactly as on macOS and that every fullscreen path covers the
   display on Windows, so the macOS simple-fullscreen workaround stays scoped to
   darwin. That was on a 1024x768 virtual display though, so re-run the probes on
   the real hardware too.
3. Scope `allowedOrigins` (per view, in config) to the real Honeywell IdP and app
   domains once the URLs are known. The enforcement code is already in place for
   both `will-navigate` and `setWindowOpenHandler`; this is now a config edit.
   Decide how far a panel may legitimately navigate. Note this is a
   misconfiguration guard, not a hardening measure: only administrators have
   keyboard and mouse access, so there is no untrusted person at the wall to
   defend against.
4. Cursor auto-hide when idle (native on Windows; there is no cross-platform
   Electron API).
5. Confirm and set per-panel `zoom` and the wall resolution/rectangles against
   the real dashboards.
6. Decide `hideInactiveWhenActive` (default `false`). Four live dashboards on a
   4K wall is real GPU load, but hiding a view may throttle it. Mock 4's ticker
   is there to measure this.
7. Optional polish: a subtle idle-countdown indicator before auto-return; a
   manual "reset panel" action that reloads a view to its configured URL.
8. Packaging: **partly done.** electron-builder is configured
   (`electron-builder.yml`). The Windows installer and zip build in CI on
   `windows-latest`, macOS arm64 and x64 dmgs build on `macos-latest`, and a
   packaged app copies its config to userData so the layout editor can write to
   it. Still to do: **code signing** on both platforms (no certificate yet; see
   README "Signing" for exactly which secrets each needs), **auto-launch on
   boot**, and a **crash-restart wrapper** for unattended operation.

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
  run `FORGE_DEV=1 FORGE_SELFTEST=1 npm start` and read the log.
- The control surface is unauthenticated by design and binds to loopback. If
  that ever changes, it needs auth first, not a comment.
- Anything that reloads a panel on a timer must skip panels in use. `inUse()` is
  the single check; do not write a second one.
- Do not build markup with inline event handlers in `src/control-page.js`. The
  first version did and the escaping collapsed into an unparseable page. Use
  `data-` attributes and the delegated listener.
