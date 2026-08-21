// node --test test/layout.test.js
const test = require('node:test');
const assert = require('node:assert');
const { clampGrid, snapGrid } = require('../src/layout');

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
  const g = snapGrid({ x: 4, y: 2157, width: 400, height: 3 }, opts({ kind: 'move' }));
  assert.strictEqual(g.x, 0);
  assert.strictEqual(g.y, 2160);
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
