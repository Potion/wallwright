// Layout geometry for the editor: clamping a panel to its bounds, and snapping
// its driven edges to the bounds and to its neighbours.
//
// **Loaded two ways.** The main process and the tests `require()` it; the overlay
// renderer gets it as a plain `<script src="layout.js">` before overlay.js,
// because a renderer has no require(). The footer at the bottom is what serves
// both. That is the point of this file: the snapping used to be implemented
// twice, once here in wall units and once in the overlay in window pixels, and
// the two had already drifted apart three ways - one took the first edge within
// tolerance where the other took the closest, one rounded the centre line and the
// other did not, and the aspect-locked scale branch existed only in the untested
// copy.
//
// The unit space is not baked in. Every primitive takes its candidate edges and
// its tolerance as arguments, so the same code snaps window pixels during a drag
// and wall units before a save. The wrappers lower down are where each unit
// space's own conventions live.
//
// Two rectangle shapes are in play, also deliberately: `{x, y, w, h}` is what the
// primitives and the overlay use, `{x, y, width, height}` is what config files
// and the main process use. toRect/toGrid convert, and nothing else should.

// ---- primitives -------------------------------------------------------------

// The closest target within tolerance, or null. Returns the delta as well as the
// target, because callers move an edge by it rather than assigning it.
function nearestTarget(value, targets, tolerance) {
  let best = null;
  let bestDelta = tolerance + 1;
  for (const t of targets) {
    const d = Math.abs(t - value);
    if (d < bestDelta) {
      bestDelta = d;
      best = t;
    }
  }
  return best === null ? null : { target: best, delta: best - value };
}

// Of several candidate edges on one axis, the one that lands closest to a target.
// Closest rather than first: dragging a panel whose centre is near one edge and
// whose leading edge is near another should snap to whichever the operator is
// actually closer to, not to whichever happens to be checked first.
function nearestOfEdges(values, targets, tolerance) {
  let best = null;
  for (const v of values) {
    const hit = nearestTarget(v, targets, tolerance);
    if (hit && (!best || Math.abs(hit.delta) < Math.abs(best.delta))) best = hit;
  }
  return best;
}

// What a drag handle means. 'move' is the body; one letter is a side resize; two
// letters is a corner scale. Derived in one place, so the string shape is not
// re-read as a taxonomy in five others.
function parseHandle(handle) {
  if (handle === 'move') return { kind: 'move', axis: null, east: false, south: false };
  const h = String(handle);
  return {
    kind: h.length === 2 ? 'scale' : 'resize',
    axis: h === 'e' || h === 'w' ? 'x' : h === 'n' || h === 's' ? 'y' : null,
    east: h.includes('e'),
    south: h.includes('s'),
  };
}

// A rectangle drawn between two points, normalised so dragging up or to the left
// works the same as down and to the right.
function normaliseRect(ax, ay, bx, by) {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    w: Math.abs(bx - ax),
    h: Math.abs(by - ay),
  };
}

// Snap the edges a gesture is driving. Returns a new rect plus the guide lines
// worth drawing; never mutates its input.
//
// `base` is where the drag started. A resize pins the edge opposite the one being
// dragged to the baseline rather than to the live rect, because converting back
// and forth through pixels loses a unit or two and that error would otherwise
// accumulate over a long drag.
function snapRect(r, { kind, handle, base, aspect, xs, ys, tolerance }) {
  const out = { ...r };
  const guides = { x: [], y: [] };

  if (kind === 'move') {
    const sx = nearestOfEdges([out.x, out.x + out.w / 2, out.x + out.w], xs, tolerance);
    if (sx) {
      out.x += sx.delta;
      guides.x.push(sx.target);
    }
    const sy = nearestOfEdges([out.y, out.y + out.h / 2, out.y + out.h], ys, tolerance);
    if (sy) {
      out.y += sy.delta;
      guides.y.push(sy.target);
    }
    return { rect: out, guides };
  }

  if (kind === 'resize') {
    // Only the dragged edge snaps; the opposite one stays where the drag started.
    if (handle === 'e') {
      const s = nearestTarget(out.x + out.w, xs, tolerance);
      if (s) {
        out.w = s.target - base.x;
        guides.x.push(s.target);
      }
    } else if (handle === 'w') {
      const s = nearestTarget(out.x, xs, tolerance);
      if (s) {
        out.x = s.target;
        out.w = base.x + base.w - s.target;
        guides.x.push(s.target);
      }
    } else if (handle === 's') {
      const s = nearestTarget(out.y + out.h, ys, tolerance);
      if (s) {
        out.h = s.target - base.y;
        guides.y.push(s.target);
      }
    } else if (handle === 'n') {
      const s = nearestTarget(out.y, ys, tolerance);
      if (s) {
        out.y = s.target;
        out.h = base.y + base.h - s.target;
        guides.y.push(s.target);
      }
    }
    return { rect: out, guides };
  }

  // Scale: aspect is locked, so snapping one edge decides both dimensions. Take
  // whichever of the two moving edges is closer to a target, then re-anchor on
  // the opposite corner the same way the drag itself does.
  const { east, south } = parseHandle(handle);
  const sx = nearestTarget(east ? out.x + out.w : out.x, xs, tolerance);
  const sy = nearestTarget(south ? out.y + out.h : out.y, ys, tolerance);
  const useX = sx && (!sy || Math.abs(sx.delta) <= Math.abs(sy.delta));

  if (useX) {
    out.w = east ? sx.target - base.x : base.x + base.w - sx.target;
    out.h = out.w / aspect;
    guides.x.push(sx.target);
  } else if (sy) {
    out.h = south ? sy.target - base.y : base.y + base.h - sy.target;
    out.w = out.h * aspect;
    guides.y.push(sy.target);
  } else {
    return { rect: out, guides };
  }
  out.x = east ? base.x : base.x + base.w - out.w;
  out.y = south ? base.y : base.y + base.h - out.h;
  return { rect: out, guides };
}

// A panel drawn on empty space has all four edges driven at once, which is
// neither a move nor a single-edge resize, so each edge is snapped on its own.
// Leading edges first: moving x or y changes the width or height needed to hold
// the trailing edge still, and the trailing snap reads the new value.
function snapDrawnRect(r, { xs, ys, tolerance }) {
  const out = { ...r };
  const guides = { x: [], y: [] };

  const left = nearestTarget(out.x, xs, tolerance);
  if (left) {
    const right = out.x + out.w;
    out.x = left.target;
    out.w = right - out.x;
    guides.x.push(left.target);
  }
  const right = nearestTarget(out.x + out.w, xs, tolerance);
  if (right) {
    out.w = right.target - out.x;
    guides.x.push(right.target);
  }
  const top = nearestTarget(out.y, ys, tolerance);
  if (top) {
    const bottom = out.y + out.h;
    out.y = top.target;
    out.h = bottom - out.y;
    guides.y.push(top.target);
  }
  const bottom = nearestTarget(out.y + out.h, ys, tolerance);
  if (bottom) {
    out.h = bottom.target - out.y;
    guides.y.push(bottom.target);
  }

  // Both edges can land on the same target, which collapses the rect. The caller
  // clamps to a minimum, so this only has to stay non-negative. Unconditional
  // rather than a pair of ifs: the negative case is barely reachable, since
  // nearestTarget prefers the closest, and a branch nothing exercises is worse
  // than no branch.
  out.w = Math.max(0, out.w);
  out.h = Math.max(0, out.h);
  return { rect: out, guides };
}

// Keep a rectangle inside `bounds` and above `min`. A scale drag shrinks
// proportionally rather than clipping one axis, so the aspect lock holds even at
// the edges.
//
// `bounds` carries an origin as well as a size, because in window pixels the
// stage is letterboxed inside the window and does not start at 0,0.
function clampRect(r, { kind, aspect, bounds, min }) {
  const out = { ...r };

  if (kind === 'scale') {
    if (out.w < min) {
      out.w = min;
      out.h = min / aspect;
    }
    const k = Math.min(1, bounds.width / out.w, bounds.height / out.h);
    out.w *= k;
    out.h *= k;
  } else {
    out.w = Math.min(Math.max(out.w, min), bounds.width);
    out.h = Math.min(Math.max(out.h, min), bounds.height);
  }

  out.x = Math.min(Math.max(out.x, bounds.x), bounds.x + bounds.width - out.w);
  out.y = Math.min(Math.max(out.y, bounds.y), bounds.y + bounds.height - out.h);
  return out;
}

// ---- wall units -------------------------------------------------------------
//
// What the main process and the config files use: `{x, y, width, height}`, with
// the origin at the wall's own top-left.

const toRect = (g) => ({ x: g.x, y: g.y, w: g.width, h: g.height });
const toGrid = (r) => ({ x: r.x, y: r.y, width: r.w, height: r.h });

// Keep a panel inside the wall and above the minimum size.
function clampGrid(g, wall, minPanel) {
  return toGrid(
    clampRect(toRect(g), {
      kind: 'resize',
      bounds: { x: 0, y: 0, width: wall.width, height: wall.height },
      min: minPanel,
    })
  );
}

// Candidate edges in wall units: the wall's edges and centre lines, plus every
// other panel's edges. The centre lines are rounded because wall units are whole
// numbers; the overlay builds its own in fractional pixels and does not round.
function snapTargets(views, index, wall) {
  const xs = [0, Math.round(wall.width / 2), wall.width];
  const ys = [0, Math.round(wall.height / 2), wall.height];
  views.forEach((v, k) => {
    if (k === index) return;
    xs.push(v.grid.x, v.grid.x + v.grid.width);
    ys.push(v.grid.y, v.grid.y + v.grid.height);
  });
  return { xs, ys };
}

// The overlay already snapped in window pixels, which is exact when the wall is
// driven 1:1 but can leave an edge a unit or two off when a 4K layout is being
// previewed scaled down. At wall resolution that is a visible seam, so the driven
// edges are re-snapped here before anything is saved.
//
// Scale drags are returned untouched: holding the aspect ratio matters more there
// than closing a two-unit gap, and a scaled panel is not tiling anyway. That is a
// wall-units decision rather than a property of snapRect, which is why it lives
// here and not in the primitive.
function snapGrid(g, { views, index, wall, tolerance, kind, handle }) {
  if (kind === 'scale') return { ...g };
  const { xs, ys } = snapTargets(views, index, wall);
  const r = toRect(g);
  const { rect } = snapRect(r, { kind, handle, base: r, xs, ys, tolerance });
  return toGrid(rect);
}

// A panel drawn on empty wall, snapped in wall units before it is stored. The
// index is -1 because the new panel is not in `views` yet, so nothing is excluded.
function snapNewGrid(g, { views, wall, tolerance }) {
  const { xs, ys } = snapTargets(views, -1, wall);
  const { rect } = snapDrawnRect(toRect(g), { xs, ys, tolerance });
  return toGrid(rect);
}

// ---- loaded two ways --------------------------------------------------------

const api = {
  nearestTarget,
  nearestOfEdges,
  parseHandle,
  normaliseRect,
  snapRect,
  snapDrawnRect,
  clampRect,
  clampGrid,
  snapGrid,
  snapNewGrid,
  snapTargets,
};

// CommonJS for the main process and the tests; a global for the overlay renderer,
// which loads this as a plain script and cannot require(). Both, not either: one
// file has to serve both callers or the duplication comes straight back.
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.WallwrightLayout = api;
