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
- Layout edit mode (`Ctrl/Cmd+Shift+E`): corners scale proportionally with the
  page zoom following the frame, sides resize one axis and let the page reflow,
  the body drags to move. Edges snap to each other, the wall edges, and the wall
  centre lines, in wall units so saved layouts have no seams. Esc saves back to
  config, Shift+Esc discards.
- `wall.fitToDisplay` scales and centres the authored layout into whatever window
  it gets, so a 3840x2160 wall layout is previewable on a laptop at the same
  proportions it will have on the wall.
- Dev harness: `npm run dev` serves four local mock dashboards that exercise
  login/session persistence, Esc handling, an SSO popup flow, and per-panel zoom.

## Build / harden next (TODO)

1. **Walk the checklist in `docs/validation.md` "Still to verify".** 30 items in
   three groups: (A) mechanical, doable on the dev machine right now, (B) blocked
   on the real dashboard URLs, (C) needs the Windows show PC and the real wall.
   Group A is the highest-value next action; group C is where the real risk is.
2. Re-run `npm run probe` and re-check overlay transparency **on the Windows show
   PC**. macOS passing does not settle the target platform, and the overlay
   compositing assumption is what the whole architecture rests on.
3. Scope `allowedOrigins` (per view, in config) to the real Honeywell IdP and app
   domains once the URLs are known. The enforcement code is already in place for
   both `will-navigate` and `setWindowOpenHandler`; this is now a config edit.
   Decide how far a panel may legitimately navigate.
4. Cursor auto-hide when idle (native on Windows; there is no cross-platform
   Electron API).
5. Confirm and set per-panel `zoom` and the wall resolution/rectangles against
   the real dashboards.
6. Decide `hideInactiveWhenActive` (default `false`). Four live dashboards on a
   4K wall is real GPU load, but hiding a view may throttle it. Mock 4's ticker
   is there to measure this.
7. Optional polish: a subtle idle-countdown indicator before auto-return; a
   manual "reset panel" action that reloads a view to its configured URL.
8. Packaging: sign and package for Windows (electron-builder or similar),
   auto-launch on boot, and a crash-restart wrapper for unattended operation.

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
- Do not reload a view on return-to-grid, and never reload the panel that is
  currently active (it drops the operator's login). `scheduleReload()` defers
  instead.
- Esc must not be a `globalShortcut`. It is an OS-level accelerator that fires
  regardless of focus and consumes the key before the page sees it, which kills
  Esc-to-close inside the dashboards. Handle it per view in `hardenView()`.
- Anything asserted about an Electron API should be verified, not assumed. Add a
  case to `src/dev/probe.js` and record the answer in `docs/validation.md`.
