# Forge LED wall - design spec

## Goal

Show live web pages on one large LED wall in the "Next Gen Control Room /
Experion Orion" exhibit. Panels are laid out in a grid, each positioned and
scaled independently, with no browser chrome. The pages are real, interactive
browser views: an operator must be able to log in and use them (SSO included),
not just look at a static picture.

The immediate exhibit is four Honeywell dashboards, but nothing is fixed at
four: panels are added, removed, re-pointed and rearranged from inside the app
(see "Layout editor"), so the same build serves any montage of live pages.

## Interaction model

There is no touch on the wall. Interaction is a single wireless keyboard and
mouse used at the wall itself (no separate admin monitor). Behavior:

- Grid mode: every panel displays at its configured rectangle. A
  transparent overlay on top captures clicks.
- Click a panel: it animates/snaps to fullscreen and becomes the input target
  (active mode). It was always live; promoting just makes it big and frontmost.
- Return to grid: Esc key, a small corner Back button, or an idle timeout
  (default 4 minutes) so the wall heals itself if someone walks away mid-session.
- On return, the panel is re-docked, NOT reloaded, so the operator's login and
  page state survive.

## Why this architecture

Two families of approaches were considered:

- Capture-based (TouchDesigner Web Render TOP, Spout/NDI, OBS browser sources):
  great for pixel-perfect layout, but what lands on the wall is a video texture,
  so native interaction is lost. Making it interactive means reverse-mapping wall
  coordinates back into an offscreen browser and injecting synthetic input, which
  is as much work as a custom app plus added latency and a second failure point.
  Rejected because login/interaction is a hard requirement.
- Native / embedded browser views (this design): the pages stay live and
  interactive; we own the layout. Chosen.

Within the native family, iframes in one page were rejected because enterprise
apps typically send `X-Frame-Options` / CSP `frame-ancestors` that forbid being
framed, and SSO login flows commonly break inside an iframe. Raw CEF and a
window-manager approach were both viable but Electron with `WebContentsView`
gives independent per-view scaling, persistent per-view sessions, clean
lockdown, and no chrome with far less code and better maintainability.

## Layout editor

Because the wall has no admin monitor, the layout has to be adjustable at the
wall itself, against the real dashboards, without editing JSON on site.
`Ctrl/Cmd+Shift+E` toggles a layout edit mode. It is a mode rather than
always-on handles: in grid mode a click promotes a panel, so live handles would
both fight that gesture and let a visitor wreck the exhibit.

In edit mode a panel can be:

- **moved** by dragging its body,
- **resized** by dragging a side handle, which changes one axis and lets the page
  reflow into the new viewport,
- **scaled** by dragging a corner, which is aspect-locked and takes `zoomFactor`
  with it, so the page scales like an image rather than reflowing. `SPEC.md`
  already noted that enterprise apps often do not reflow to arbitrary sizes;
  this is the gesture for that case.

Edges snap to each other, to the wall edges, and to the wall centre lines, so
panels tile without seams. Snapping happens twice: in window pixels for feel,
then again in wall units before saving, because a layout tuned on a scaled-down
preview would otherwise store edges a unit or two apart, which is a visible seam
at wall resolution.

Selecting a panel opens an inspector for its **URL, label, zoom and session**,
plus delete. New panels come from dragging on empty wall or an Add button. Esc
saves the whole panel list back to the config file, Shift+Esc discards.

## Components

- `BaseWindow` (frameless, fullscreen) sized to the wall resolution, placed on
  the wall's display output. On macOS this must be _simple_ fullscreen: every
  native fullscreen and kiosk path leaves the menu-bar strip uncovered.
- An opaque backdrop `View` behind everything, so wall area no panel covers
  clears to the background colour instead of keeping stale pixels.
- One content `WebContentsView` per configured URL, created and destroyed at
  runtime as panels are added and removed. Each has a session partition
  (logins survive restarts) and a `zoomFactor` for per-panel scale.
- One transparent overlay `WebContentsView`, always kept on top:
  - Grid mode: sized to the whole wall; renders four invisible hotspots at the
    panel rectangles that capture the click and request activation.
  - Active mode: shrunk to just the Back-button corner rectangle, so the rest of
    the fullscreen page below is directly clickable while a persistent Back
    control stays on top.

## Config schema

`config/wall.json` (path overridable via `FORGE_CONFIG`):

- `wall.width`, `wall.height`, `wall.backgroundColor`, `wall.displayLabel`
- `idleReturnMs` (0 disables auto-return)
- `showHotspotHint` (hover highlight on panels in grid mode)
- `backButton` rectangle (position/size of the corner Back control)
- `views[]`: `{ id, label, url, grid:{x,y,width,height}, zoom, partition }`.
  May be empty, so a montage can be built from a blank wall. Written back by the
  layout editor.

## Sessions and SSO

Each view uses a `persist:` partition so cookies/sessions persist. Auth popups
are allowed via `setWindowOpenHandler` so SSO that spawns a popup works; the
allow-list should be scoped to the real identity-provider domains once known.

Panels default to their own partition, but may deliberately **share** one. This
matters for the exhibit: several panels showing the same SSO-protected app
should sit behind one login rather than making an operator sign in once per
panel. The editor's inspector chooses this per panel.

In a packaged app the bundled config is read-only inside `app.asar`, so the live
config is a copy under the user data directory, seeded on first run. That is what
the editor writes to, so a layout tuned at the wall survives a reinstall.

## Reliability

A watchdog reloads a view on `render-process-gone`, `unresponsive`, and
main-frame `did-fail-load`, with exponential backoff, and resets the backoff on
`did-finish-load`. These are live URLs that will occasionally hiccup.

## Lockdown

Frameless kiosk, application menu removed, deliberate admin-exit shortcut
(`Ctrl/Cmd+Shift+Q`), Esc to return. Navigation/new-window handling starts
permissive and should be tightened to the real domains. Cursor auto-hide when
idle is desired so the wall stays clean between interactions (see TODO).

## Known risks / things to validate

- WebContentsView alpha compositing: the overlay must render transparent over
  the content views. Validate on the target OS. Fallback if it does not: keep the
  overlay only over the panel gaps, or drive activation from a thin always-on-top
  frameless BrowserWindow per hotspot, or render hotspots in a single top
  BrowserWindow with `setIgnoreMouseEvents(true, { forward: true })` and toggle
  passthrough per region.
- Enterprise apps often do not reflow to arbitrary sizes; `zoomFactor` scales the
  whole page to fit a rectangle legibly. Confirm per-panel zoom values against the
  real dashboards and wall resolution.
- Honeywell IT approval for running a custom Electron app on the show PC. A signed
  build is easier to approve. Confirm their stance before hardening.
