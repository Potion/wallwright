// node --test test/layout.test.js
const test = require('node:test');
const assert = require('node:assert');
const {
  clampGrid,
  snapGrid,
  snapNewGrid,
  parseHandle,
  normaliseRect,
  nearestTarget,
  nearestOfEdges,
  snapRect,
  clampRect,
} = require('../src/layout');

const WALL = { width: 3840, height: 2160 };
const MIN = 160;

// A 2x2 grid. Index 0 is the panel being dragged in most tests.
const views = () => [
  { id: 'a', grid: { x: 0, y: 0, width: 1920, height: 1080 } },
  { id: 'b', grid: { x: 1920, y: 0, width: 1920, height: 1080 } },
  { id: 'c', grid: { x: 0, y: 1080, width: 1920, height: 1080 } },
  { id: 'd', grid: { x: 1920, y: 1080, width: 1920, height: 1080 } },
];

const opts = (over) => ({
  views: views(),
  index: 0,
  wall: WALL,
  tolerance: 5,
  ...over,
});

// ---- clampGrid --------------------------------------------------------------

test('clampGrid keeps a panel inside the wall', () => {
  const g = clampGrid({ x: 3800, y: 2100, width: 1920, height: 1080 }, WALL, MIN);
  assert.strictEqual(g.x + g.width, WALL.width);
  assert.strictEqual(g.y + g.height, WALL.height);
});

test('clampGrid enforces the minimum size', () => {
  const g = clampGrid({ x: 0, y: 0, width: 4, height: 4 }, WALL, MIN);
  assert.deepStrictEqual([g.width, g.height], [MIN, MIN]);
});

test('clampGrid never lets a panel exceed the wall', () => {
  const g = clampGrid({ x: 0, y: 0, width: 99999, height: 99999 }, WALL, MIN);
  assert.deepStrictEqual([g.width, g.height], [WALL.width, WALL.height]);
});

// ---- move -------------------------------------------------------------------

test("a move snaps its left edge to a neighbour's edge", () => {
  // Dragged panel's left edge sits 3 units off b's left edge (1920).
  const g = snapGrid({ x: 1923, y: 0, width: 1920, height: 1080 }, opts({ kind: 'move' }));
  assert.strictEqual(g.x, 1920);
});

test('a move snaps its right edge too, not just its left', () => {
  // Right edge at 1917 is 3 off 1920; left edge at -3 is 3 off 0. Leading edge
  // is tried first, so x lands on 0 and the right edge falls on 1920 anyway.
  const g = snapGrid({ x: -3, y: 0, width: 1920, height: 1080 }, opts({ kind: 'move' }));
  assert.strictEqual(g.x, 0);
  assert.strictEqual(g.x + g.width, 1920);
});

test('a move snaps to the wall edge', () => {
  const g = snapGrid({ x: 4, y: 900, width: 400, height: 300 }, opts({ kind: 'move' }));
  assert.strictEqual(g.x, 0);
});

// This used to assert y became 2160 for a 3-unit-tall panel sitting at 2157,
// which moved its TOP edge onto the wall's bottom and pushed the whole panel off
// the wall. The old rule took the first edge within tolerance, so the leading
// edge always won even when the trailing edge was already exactly on target.
// Collapsing the two implementations replaced it with "closest wins", which the
// overlay had used all along - so what is saved now matches what the operator saw
// while dragging, which is the entire point of the second pass.
test('a move prefers the edge already closest, rather than the first one checked', () => {
  // Bottom edge is exactly on the wall's bottom; nothing should move.
  const flush = snapGrid({ x: 500, y: 2157, width: 400, height: 3 }, opts({ kind: 'move' }));
  assert.strictEqual(flush.y, 2157, 'a panel already flush must be left where it is');
  assert.strictEqual(flush.y + flush.height, WALL.height);

  // And when it genuinely is off, it still snaps.
  const off = snapGrid({ x: 500, y: 2155, width: 400, height: 3 }, opts({ kind: 'move' }));
  assert.strictEqual(off.y + off.height, WALL.height, 'the closest edge is the bottom one');
});

test('a move snaps to the wall centre line', () => {
  const g = snapGrid({ x: 1918, y: 500, width: 200, height: 200 }, opts({ kind: 'move' }));
  assert.strictEqual(g.x, 1920); // wall centre and b's edge coincide here
});

test('a move outside tolerance is left alone', () => {
  const g = snapGrid({ x: 1820, y: 300, width: 400, height: 400 }, opts({ kind: 'move' }));
  assert.strictEqual(g.x, 1820);
  assert.strictEqual(g.y, 300);
});

test('a move never changes size', () => {
  const before = { x: 1923, y: 3, width: 1920, height: 1080 };
  const g = snapGrid(before, opts({ kind: 'move' }));
  assert.strictEqual(g.width, before.width);
  assert.strictEqual(g.height, before.height);
});

test('a panel does not snap to itself', () => {
  // Index 1 is b, whose own left edge is 1920. Dragging it to 1922 must snap to
  // a's right edge (also 1920) rather than being pinned by its own.
  const g = snapGrid(
    { x: 1922, y: 0, width: 1920, height: 1080 },
    opts({ kind: 'move', index: 1 })
  );
  assert.strictEqual(g.x, 1920);
});

// ---- resize -----------------------------------------------------------------

test('an east resize moves only the right edge', () => {
  const g = snapGrid(
    { x: 0, y: 0, width: 1917, height: 1080 },
    opts({ kind: 'resize', handle: 'e' })
  );
  assert.strictEqual(g.x, 0); // left edge pinned
  assert.strictEqual(g.width, 1920); // right edge snapped to 1920
  assert.strictEqual(g.height, 1080); // untouched axis untouched
});

test('a west resize moves the left edge and keeps the right one pinned', () => {
  const g = snapGrid(
    { x: 1923, y: 0, width: 1917, height: 1080 },
    opts({ kind: 'resize', handle: 'w', index: 1 })
  );
  assert.strictEqual(g.x, 1920);
  assert.strictEqual(g.x + g.width, 3840); // right edge held
});

test('a south resize snaps the bottom edge only', () => {
  const g = snapGrid(
    { x: 0, y: 0, width: 1920, height: 1077 },
    opts({ kind: 'resize', handle: 's' })
  );
  assert.strictEqual(g.height, 1080);
  assert.strictEqual(g.width, 1920);
});

test('a north resize moves the top edge and holds the bottom', () => {
  const g = snapGrid(
    { x: 0, y: 1083, width: 1920, height: 1077 },
    opts({ kind: 'resize', handle: 'n', index: 2 })
  );
  assert.strictEqual(g.y, 1080);
  assert.strictEqual(g.y + g.height, 2160);
});

test('a resize does not snap the axis it is not driving', () => {
  // Bottom edge is 3 off 1080, but this is an east drag, so it must not move.
  const g = snapGrid(
    { x: 0, y: 0, width: 1917, height: 1077 },
    opts({ kind: 'resize', handle: 'e' })
  );
  assert.strictEqual(g.height, 1077);
});

// ---- scale ------------------------------------------------------------------

test('a scale is returned untouched so the aspect lock holds', () => {
  const before = { x: 3, y: 3, width: 1917, height: 1078 };
  const g = snapGrid(before, opts({ kind: 'scale', handle: 'se' }));
  assert.deepStrictEqual(g, before);
});

// ---- the seam this exists to prevent ---------------------------------------

test('snapped neighbours share an exact edge, leaving no seam', () => {
  const g = snapGrid(
    { x: 0, y: 0, width: 1919, height: 1080 },
    opts({ kind: 'resize', handle: 'e' })
  );
  const b = views()[1];
  assert.strictEqual(g.x + g.width, b.grid.x, 'right edge must equal the neighbour left edge');
});

// ---- drawing a new panel ----------------------------------------------------

// The create path had no wall-unit pass at all: the overlay snapped the drawn
// rectangle in window pixels and main.js only clamped it. Previewing a 4K layout
// scaled down, that leaves a panel a unit or two off its neighbour, which is a
// visible seam at wall resolution.
const newOpts = (over) => ({ views: views(), wall: WALL, tolerance: 8, ...over });

test('a drawn rect snaps all four edges, not just one', () => {
  // Drawn slightly inside the bottom-right quadrant, every edge a few units off.
  const g = snapNewGrid({ x: 1923, y: 1084, width: 1914, height: 1073 }, newOpts());
  assert.deepStrictEqual(g, { x: 1920, y: 1080, width: 1920, height: 1080 });
});

test('a drawn rect leaves no seam against its neighbour', () => {
  const g = snapNewGrid({ x: 1917, y: 6, width: 1920, height: 1074 }, newOpts());
  const a = views()[0];
  assert.strictEqual(
    g.x,
    a.grid.x + a.grid.width,
    'left edge must equal the neighbour right edge'
  );
});

test('a drawn rect snaps to the wall centre lines', () => {
  const g = snapNewGrid({ x: 1918, y: 4, width: 400, height: 300 }, newOpts());
  assert.strictEqual(g.x, WALL.width / 2);
  assert.strictEqual(g.y, 0);
});

// index is -1 rather than a real index, because the new panel is not in `views`
// yet. If it were excluded by position, the first panel would stop being a target.
test('every existing panel is a snap target for a new one', () => {
  const g = snapNewGrid({ x: 4, y: 1076, width: 500, height: 400 }, newOpts());
  assert.strictEqual(g.x, 0);
  assert.strictEqual(g.y, 1080, 'must snap to panel c top edge');
});

test('edges far from anything are left where they were drawn', () => {
  const before = { x: 700, y: 500, width: 421, height: 337 };
  assert.deepStrictEqual(snapNewGrid(before, newOpts()), before);
});

// Both edges can land on the same target. clampGrid is what rescues it, so this
// only has to hand over something non-negative rather than a negative width.
test('a collapsed rect stays non-negative and is rescued by clampGrid', () => {
  const g = snapNewGrid({ x: 1918, y: 1078, width: 4, height: 4 }, newOpts());
  assert.ok(g.width >= 0 && g.height >= 0, 'no negative dimensions');
  const clamped = clampGrid(g, WALL, MIN);
  assert.strictEqual(clamped.width, MIN);
  assert.strictEqual(clamped.height, MIN);
});

// ---- the shared primitives --------------------------------------------------
//
// These now serve both unit spaces: the overlay calls them in window pixels
// during a drag, and the wrappers above call them in wall units before a save.
// Until the two implementations were collapsed, the pixel-space half - including
// the whole aspect-locked scale branch - had no tests at all.

test('parseHandle turns the handle string into a taxonomy, in one place', () => {
  assert.deepStrictEqual(parseHandle('move'), {
    kind: 'move',
    axis: null,
    east: false,
    south: false,
  });
  assert.deepStrictEqual(parseHandle('e'), {
    kind: 'resize',
    axis: 'x',
    east: true,
    south: false,
  });
  assert.deepStrictEqual(parseHandle('n'), {
    kind: 'resize',
    axis: 'y',
    east: false,
    south: false,
  });
  // Two letters is a corner, and a corner has no single axis.
  assert.deepStrictEqual(parseHandle('se'), {
    kind: 'scale',
    axis: null,
    east: true,
    south: true,
  });
  assert.deepStrictEqual(parseHandle('nw'), {
    kind: 'scale',
    axis: null,
    east: false,
    south: false,
  });
});

test('normaliseRect makes dragging up and left the same as down and right', () => {
  const down = normaliseRect(10, 10, 110, 60);
  assert.deepStrictEqual(down, { x: 10, y: 10, w: 100, h: 50 });
  assert.deepStrictEqual(normaliseRect(110, 60, 10, 10), down);
});

test('nearestTarget reports the delta, not just the target', () => {
  assert.deepStrictEqual(nearestTarget(97, [0, 100, 200], 5), { target: 100, delta: 3 });
  assert.strictEqual(nearestTarget(50, [0, 100, 200], 5), null, 'outside tolerance');
  // Ties go to the first, which keeps the result stable rather than order-dependent.
  assert.strictEqual(nearestTarget(50, [45, 55], 10).target, 45);
});

test('nearestOfEdges picks the edge needing the least movement', () => {
  // Leading edge is 4 away, trailing edge is 1 away.
  const hit = nearestOfEdges([96, 199], [100, 200], 5);
  assert.strictEqual(hit.target, 200);
  assert.strictEqual(hit.delta, 1);
});

// The branch that only ever existed in the renderer, where nothing could test it.
test('a scale snap keeps the aspect ratio and re-anchors on the opposite corner', () => {
  const base = { x: 100, y: 100, w: 200, h: 100 };
  const { rect } = snapRect(
    { x: 100, y: 100, w: 196, h: 98 },
    { kind: 'scale', handle: 'se', base, aspect: 2, xs: [300], ys: [], tolerance: 8 }
  );
  assert.strictEqual(rect.x, 100, 'the anchored corner does not move');
  assert.strictEqual(rect.y, 100);
  assert.strictEqual(rect.w, 200, 'the driven edge landed on the target');
  assert.strictEqual(rect.w / rect.h, 2, 'aspect held');
});

test('a north-west scale grows away from the anchored bottom-right corner', () => {
  const base = { x: 100, y: 100, w: 200, h: 100 };
  const { rect } = snapRect(
    { x: 104, y: 102, w: 196, h: 98 },
    { kind: 'scale', handle: 'nw', base, aspect: 2, xs: [100], ys: [], tolerance: 8 }
  );
  assert.strictEqual(rect.x, 100);
  assert.strictEqual(rect.x + rect.w, base.x + base.w, 'the right edge is the anchor');
  assert.strictEqual(rect.w / rect.h, 2);
});

test('snapRect never mutates what it is given', () => {
  const r = { x: 96, y: 0, w: 100, h: 50 };
  const before = { ...r };
  snapRect(r, { kind: 'move', handle: 'move', base: r, xs: [100], ys: [], tolerance: 8 });
  assert.deepStrictEqual(r, before);
});

// The three-way min that holds the aspect lock at the edges. Easy to get wrong
// and impossible to notice by eye.
test('a scale clamp shrinks proportionally rather than clipping one axis', () => {
  const bounds = { x: 0, y: 0, width: 400, height: 200 };
  const out = clampRect(
    { x: 0, y: 0, w: 800, h: 400 },
    { kind: 'scale', aspect: 2, bounds, min: 10 }
  );
  assert.strictEqual(out.w, 400);
  assert.strictEqual(out.h, 200);
  assert.strictEqual(out.w / out.h, 2, 'aspect survived the clamp');
});

test('a scale clamp lifts a too-small rect back to the minimum, keeping aspect', () => {
  const bounds = { x: 0, y: 0, width: 400, height: 400 };
  const out = clampRect(
    { x: 0, y: 0, w: 4, h: 2 },
    { kind: 'scale', aspect: 2, bounds, min: 40 }
  );
  assert.strictEqual(out.w, 40);
  assert.strictEqual(out.h, 20);
});

// In window pixels the stage is letterboxed inside the window, so the bounds have
// an origin. Clamping to 0,0 would push panels into the letterbox.
test('clampRect respects a bounds origin, not just its size', () => {
  const bounds = { x: 50, y: 30, width: 400, height: 200 };
  const out = clampRect(
    { x: -100, y: -100, w: 100, h: 50 },
    { kind: 'resize', bounds, min: 10 }
  );
  assert.strictEqual(out.x, 50);
  assert.strictEqual(out.y, 30);

  const far = clampRect(
    { x: 9999, y: 9999, w: 100, h: 50 },
    { kind: 'resize', bounds, min: 10 }
  );
  assert.strictEqual(far.x + far.w, bounds.x + bounds.width);
  assert.strictEqual(far.y + far.h, bounds.y + bounds.height);
});

// The y-driven half of the scale branch, and the case where neither axis has
// anything to snap to. Both were unreachable by any test while this lived in the
// renderer.
test('a scale snaps on the vertical axis when that edge is the closer one', () => {
  const base = { x: 100, y: 100, w: 200, h: 100 };
  const { rect, guides } = snapRect(
    { x: 100, y: 100, w: 190, h: 95 },
    { kind: 'scale', handle: 'se', base, aspect: 2, xs: [400], ys: [200], tolerance: 8 }
  );
  assert.strictEqual(rect.y + rect.h, 200, 'the bottom edge landed on the target');
  assert.strictEqual(rect.w / rect.h, 2, 'aspect held');
  assert.deepStrictEqual(guides, { x: [], y: [200] }, 'the guide marks the axis that decided');
});

test('a scale with nothing in range is returned unchanged', () => {
  const base = { x: 100, y: 100, w: 200, h: 100 };
  const r = { x: 100, y: 100, w: 150, h: 75 };
  const { rect, guides } = snapRect(r, {
    kind: 'scale',
    handle: 'se',
    base,
    aspect: 2,
    xs: [9999],
    ys: [9999],
    tolerance: 8,
  });
  assert.deepStrictEqual(rect, r, 'no re-anchoring when no edge snapped');
  assert.deepStrictEqual(guides, { x: [], y: [] });
});
