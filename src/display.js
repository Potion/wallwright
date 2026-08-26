// Which output the wall lands on, and how the authored layout is fitted into it.
// No electron import, so test/display.test.js can exercise it directly: a display
// here is just `{ id, label, bounds, workArea }`.
//
// Extracted because this decides whether the exhibit appears on the LED wall at
// all, it is the show-PC path a dev machine never exercises, and `AGENTS.md`
// TODO 3 depends on it. Everything it did was pure apart from two `screen` calls,
// and it had no test.

// Pick the output, and say why.
//
// Four steps, most specific first: an explicit id, then a label, then a display
// whose resolution matches the wall, then the primary as a last resort. Falling
// back to primary is a dev-machine convenience and is meant to be loud, because
// on the show PC it means the wall is about to appear on the wrong screen.
//
// Returns the display plus `notes`, rather than logging: this runs on every
// resize and every display-metrics change, so the caller emits them only when the
// chosen display actually changes. Otherwise an unattended run buries its real
// messages under hundreds of identical warnings.
function chooseWallDisplay(displays, primary, wall) {
  const { displayLabel, displayId, width, height, fitToDisplay } = wall;
  const notes = [];
  let hit = null;
  let matchedBy = null;

  if (displayId != null) {
    hit = displays.find((d) => String(d.id) === String(displayId));
    if (hit) matchedBy = 'id';
    else {
      notes.push({
        level: 'warn',
        message: `no display with id ${displayId}; known ids:`,
        extra: displays.map((d) => d.id),
      });
    }
  }

  if (!hit && displayLabel) {
    hit = displays.find((d) => d.label === displayLabel);
    if (hit) matchedBy = 'label';
    else {
      notes.push({
        level: 'warn',
        message: `no display labelled "${displayLabel}"; known labels:`,
        extra: displays.map((d) => d.label),
      });
    }
  }

  if (!hit) {
    // Only when exactly one matches. Two identical outputs is the normal case on
    // a video wall, and picking either of them silently would be a coin toss.
    const exact = displays.filter(
      (d) => d.bounds.width === width && d.bounds.height === height
    );
    if (exact.length === 1) {
      hit = exact[0];
      matchedBy = 'resolution';
      notes.push({
        level: 'log',
        message: `matched display by ${width}x${height}: "${hit.label}" (id ${hit.id})`,
      });
    }
  }

  if (!hit) {
    hit = primary;
    matchedBy = 'primary';
    notes.push({
      level: 'warn',
      message:
        `falling back to the PRIMARY display "${hit.label}" (id ${hit.id}). ` +
        'Set wall.displayLabel or wall.displayId to target the LED wall output.',
    });
  }

  // Only a real problem when the layout is not being fitted: then the authored
  // rectangles genuinely land in the wrong place. With fitToDisplay on, the scale
  // is reported by fitLayout() against the window instead.
  if (fitToDisplay === false && (hit.bounds.width !== width || hit.bounds.height !== height)) {
    notes.push({
      level: 'warn',
      message:
        `wall config is ${width}x${height} but display "${hit.label}" is ` +
        `${hit.bounds.width}x${hit.bounds.height}, and wall.fitToDisplay is off. ` +
        'Panel rectangles will not land where you expect until these agree.',
    });
  }

  return { display: hit, notes, matchedBy };
}

// How much to keep clear at the top of the display.
//
// Only applies while the app owns the display: in a window it already sits below
// the menu bar, so there is nothing to avoid. "auto" measures the macOS notch
// from the display itself; anywhere else it is zero, because no other platform
// puts anything over a fullscreen window.
function safeAreaTopFor({ setting, fullscreen, platform, display }) {
  if (!fullscreen) return 0;
  if (setting === 'auto') {
    if (platform !== 'darwin' || !display) return 0;
    return Math.max(0, display.workArea.y - display.bounds.y);
  }
  return Number.isFinite(setting) && setting > 0 ? Math.round(setting) : 0;
}

// Fit the authored wall into whatever window it actually got, centred, preserving
// aspect. This is what makes a 3840x2160 layout previewable on a laptop at the
// proportions it will have on the wall.
//
// `fitToDisplay === false` pins the scale to 1, so the authored rectangles are
// used as literal pixels. That is the mode where a display-size mismatch matters,
// which is why chooseWallDisplay warns about it only then.
function fitLayout({ target, wall, safeTop = 0, fitToDisplay = true }) {
  const W = target.width;
  const H = target.height;
  const w = wall.width;
  const h = wall.height;
  // Never let the available height reach zero: it would divide the scale to 0 and
  // collapse every panel to nothing.
  const avail = Math.max(1, H - safeTop);
  const scale = fitToDisplay === false ? 1 : Math.min(W / w, avail / h);

  return {
    scale,
    offsetX: Math.round((W - w * scale) / 2),
    offsetY: safeTop + Math.round((avail - h * scale) / 2),
    width: W,
    height: H,
    safeTop,
  };
}

// The line the caller logs when the fit changes. Separate from fitLayout so that
// stays a pure geometry function, and so the caller can compare stamps and stay
// quiet on a resize that changed nothing.
function describeLayout({ wall, layout }) {
  const inset = layout.safeTop ? `, keeping ${layout.safeTop}px clear at the top` : '';
  const where = `${wall.width}x${wall.height} in a ${layout.width}x${layout.height} window`;
  return Math.abs(layout.scale - 1) < 0.0005
    ? `layout ${where}, 1:1${inset}`
    : `layout ${where}, scaled to ${layout.scale.toFixed(3)}${inset}`;
}

module.exports = { chooseWallDisplay, safeAreaTopFor, fitLayout, describeLayout };
