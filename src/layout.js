// Pure layout geometry for the editor: clamping a panel to the wall, and
// snapping its driven edges to the wall and to its neighbours. No electron
// import, so test/layout.test.js can exercise it directly.
//
// Everything here is in wall units, never window pixels.

// Keep a panel inside the wall and above the minimum size.
function clampGrid(g, wall, minPanel) {
  const width = Math.min(Math.max(g.width, minPanel), wall.width);
  const height = Math.min(Math.max(g.height, minPanel), wall.height);
  return {
    x: Math.min(Math.max(g.x, 0), wall.width - width),
    y: Math.min(Math.max(g.y, 0), wall.height - height),
    width,
    height,
  };
}

function nearest(value, targets, tolerance) {
  let best = null;
  let bestDelta = tolerance + 1;
  for (const t of targets) {
    const d = Math.abs(t - value);
    if (d < bestDelta) {
      bestDelta = d;
      best = t;
    }
  }
  return best;
}

// Candidate edges: the wall's edges and centre lines, plus every other panel's
// edges.
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
// previewed scaled down. At wall resolution that is a visible seam, so the
// driven edges are re-snapped here before anything is saved.
//
// Scale drags are returned untouched: holding the aspect ratio matters more
// there than closing a two-unit gap, and a scaled panel is not tiling anyway.
function snapGrid(g, { views, index, wall, tolerance, kind, handle }) {
  if (kind === 'scale') return { ...g };
  const r = { ...g };
  const { xs, ys } = snapTargets(views, index, wall);
  const near = (v, targets) => nearest(v, targets, tolerance);

  if (kind === 'move') {
    // Try leading edge, centre, then trailing edge, and take the first that
    // lands within tolerance.
    const offX = [0, Math.round(r.width / 2), r.width];
    for (const off of offX) {
      const t = near(r.x + off, xs);
      if (t !== null) {
        r.x = t - off;
        break;
      }
    }
    const offY = [0, Math.round(r.height / 2), r.height];
    for (const off of offY) {
      const t = near(r.y + off, ys);
      if (t !== null) {
        r.y = t - off;
        break;
      }
    }
    return r;
  }

  // resize: only the dragged edge moves, the opposite one stays put.
  if (handle === 'e') {
    const t = near(r.x + r.width, xs);
    if (t !== null) r.width = t - r.x;
  } else if (handle === 'w') {
    const right = r.x + r.width;
    const t = near(r.x, xs);
    if (t !== null) {
      r.x = t;
      r.width = right - t;
    }
  } else if (handle === 's') {
    const t = near(r.y + r.height, ys);
    if (t !== null) r.height = t - r.y;
  } else if (handle === 'n') {
    const bottom = r.y + r.height;
    const t = near(r.y, ys);
    if (t !== null) {
      r.y = t;
      r.height = bottom - t;
    }
  }
  return r;
}

module.exports = { clampGrid, snapGrid, snapTargets };
