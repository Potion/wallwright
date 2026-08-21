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

Still to confirm by hand: side handles change one axis only and leave zoom
untouched (the page should reflow, not scale), body drag moves, and Esc saves
back to the config file while Shift+Esc discards.

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

## Not yet validated (needs a human at the machine)

Run `npm run dev` and walk these. They are all mechanical, they just need eyes
and hands.

- [ ] **Session persistence across restart.** Sign in on mock 1, quit
      (`Cmd+Shift+Q`), relaunch. Still signed in? Proves the `persist:` partition.
- [ ] **Page state survives dock/undock.** Sign in on mock 1, type into the
      scratch field, promote, Back, promote again. The "Loaded at" timestamp must
      not change and the typed text must still be there. If the timestamp
      changes the view was reloaded, which `SPEC.md` forbids.
- [ ] **Esc reaches the page.** On mock 2, open the modal and press Esc once: the
      modal should close and the wall should stay fullscreen. Press Esc twice
      quickly with no modal: the wall should dock. See "Open question: Esc" below.
- [ ] **Keyboard focus.** Type into mock 2's input while it is promoted. If
      nothing appears, the `webContents.focus()` call in `activate()` is not
      taking effect.
- [ ] **SSO popup.** On mock 3, click "Sign in with SSO". The popup must appear
      centered on the wall (not off-wall or behind the panels), and clicking
      Continue must report "signed in as operator" back in the panel.
- [ ] **Per-panel zoom.** Mock 4 is configured at `zoom: 0.75` while its
      neighbours are at 1.0. Its text should be visibly smaller, and promoting it
      then returning must not leak zoom onto any other panel.
- [ ] **Background liveness.** Mock 4's tick counter must keep counting while
      another panel is promoted fullscreen.
- [ ] **Idle auto-return.** The dev config uses `idleReturnMs: 15000`. Promote a
      panel, stop touching it, and confirm it docks after ~15s and is still
      signed in afterwards.
- [ ] **Watchdog.** Kill a renderer from Activity Monitor and confirm the log
      shows a backoff reload. Then kill the renderer of the _promoted_ panel and
      confirm the log says `deferring reload ... until it is no longer active`
      and that it only reloads after docking.
- [ ] **`hideInactiveWhenActive`.** Default `false`. Flip it to `true` and check
      whether the three hidden panels keep running (mock 4's ticker) or get
      throttled. That answer decides whether it is safe to use for GPU headroom
      on a 4K wall.
- [ ] **Side handles resize without scaling.** Drag a side handle: only that axis
      should change, the zoom readout should not move, and the page should reflow
      into the new width/height rather than scaling.
- [ ] **Layout persistence.** Edit, press Esc, quit, relaunch. The layout should
      come back. Then edit and press Shift+Esc: the change should be discarded.
- [ ] **Live drag feel.** Panel bounds and zoom update on every animation frame
      during a drag. If that feels janky on the real 4K wall with four live
      dashboards, switch to committing on mouse-up instead.
- [ ] **Fullscreen kiosk.** Both configs now default to `kiosk: true` and
      `fullscreen: true` (no menu bar, no dock). Confirm the wall comes up clean
      and that `Cmd/Ctrl+Shift+Q` still exits.

## Open question: Esc

`SPEC.md` says Esc returns to the grid. Real dashboards use Esc to close modals
and dropdowns. A single key cannot unambiguously do both, and the scaffold's
approach was worse than ambiguous: it registered Esc as a `globalShortcut`, an
OS-level accelerator that fires regardless of focus and consumes the key before
the page ever sees it. Every Esc-to-close control in the real dashboards would
have been dead.

Current behavior is `escToGrid: "double"`: the first Esc passes through to the
page, and a second Esc within `escDoubleMs` (600ms) docks to the grid. Also
configurable as `"single"` (spec-literal, breaks page modals) or `"off"`
(Back button and idle timeout only).

**Needs Jeff:** is double-Esc acceptable, or should Esc be dropped entirely in
favour of the Back button plus idle timeout? Mock 2 exists to make the tradeoff
concrete.

## Deliberately out of scope for this pass

Windows overlay transparency, cursor auto-hide, the navigation allow-list
domains, real per-panel zoom values, and packaging/signing. See the plan and the
`AGENTS.md` TODO list for why each is blocked.
