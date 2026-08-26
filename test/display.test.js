// node --test test/display.test.js
//
// Which output the wall lands on. This is the show-PC path a dev machine never
// exercises, and it had no test at all: on the wrong branch the exhibit appears
// on the wrong screen, or at the wrong scale, and nobody finds out until the
// install.
const test = require('node:test');
const assert = require('node:assert');
const {
  chooseWallDisplay,
  safeAreaTopFor,
  fitLayout,
  describeLayout,
} = require('../src/display');

const d = (id, label, width, height, over = {}) => ({
  id,
  label,
  bounds: { x: 0, y: 0, width, height },
  workArea: { x: 0, y: 0, width, height },
  ...over,
});

const WALL = d(1, 'LED WALL', 3840, 2160);
const LAPTOP = d(2, 'Built-in', 1800, 1169);
const SECOND = d(3, 'Second', 3840, 2160);

const wall = (over) => ({ width: 3840, height: 2160, fitToDisplay: true, ...over });
const warns = (notes) => notes.filter((n) => n.level === 'warn').map((n) => n.message);

// ---- picking ----------------------------------------------------------------

test('an explicit displayId wins over everything else', () => {
  const r = chooseWallDisplay(
    [WALL, LAPTOP],
    LAPTOP,
    wall({ displayId: 2, displayLabel: 'LED WALL' })
  );
  assert.strictEqual(r.display.id, 2);
  assert.strictEqual(r.matchedBy, 'id');
});

test('displayId is compared as a string, so a config number still matches', () => {
  const r = chooseWallDisplay([d('99', 'x', 100, 100)], LAPTOP, wall({ displayId: 99 }));
  assert.strictEqual(r.matchedBy, 'id');
});

test('a missing displayId warns and lists what is actually there', () => {
  const r = chooseWallDisplay([WALL, LAPTOP], LAPTOP, wall({ displayId: 42 }));
  assert.match(warns(r.notes).join('\n'), /no display with id 42/);
  const listed = r.notes.find((n) => n.message.includes('no display with id'));
  assert.deepStrictEqual(listed.extra, [1, 2], 'the known ids are what makes this fixable');
});

test('a label match is used when there is no id', () => {
  const r = chooseWallDisplay([WALL, LAPTOP], LAPTOP, wall({ displayLabel: 'LED WALL' }));
  assert.strictEqual(r.display.id, 1);
  assert.strictEqual(r.matchedBy, 'label');
});

test('a missing label warns and falls through to the next rule', () => {
  const r = chooseWallDisplay([WALL, LAPTOP], LAPTOP, wall({ displayLabel: 'Nope' }));
  assert.match(warns(r.notes).join('\n'), /no display labelled "Nope"/);
  assert.strictEqual(r.matchedBy, 'resolution', 'must keep going, not give up');
});

test('resolution is the last resort before primary', () => {
  const r = chooseWallDisplay([WALL, LAPTOP], LAPTOP, wall());
  assert.strictEqual(r.display.id, 1);
  assert.strictEqual(r.matchedBy, 'resolution');
});

// Two identical outputs is the normal case on a video wall, so picking either one
// silently would be a coin toss that looks fine in testing.
test('an ambiguous resolution match is refused, not guessed', () => {
  const r = chooseWallDisplay([WALL, SECOND, LAPTOP], LAPTOP, wall());
  assert.strictEqual(r.matchedBy, 'primary');
  assert.match(warns(r.notes).join('\n'), /falling back to the PRIMARY/);
});

test('the primary fallback is loud, and says how to fix it', () => {
  const r = chooseWallDisplay([LAPTOP], LAPTOP, wall());
  assert.strictEqual(r.matchedBy, 'primary');
  const w = warns(r.notes).join('\n');
  assert.match(w, /PRIMARY/);
  assert.match(w, /wall.displayLabel or wall.displayId/);
});

// ---- the size mismatch warning ----------------------------------------------

// With fitToDisplay on, a mismatch is fine: the layout is scaled. It is only a
// real problem when the authored rectangles are being used as literal pixels.
test('a size mismatch warns only when the layout is not being fitted', () => {
  const fitted = chooseWallDisplay([LAPTOP], LAPTOP, wall({ fitToDisplay: true }));
  assert.ok(!warns(fitted.notes).some((m) => m.includes('fitToDisplay is off')));

  const literal = chooseWallDisplay([LAPTOP], LAPTOP, wall({ fitToDisplay: false }));
  assert.match(warns(literal.notes).join('\n'), /fitToDisplay is off/);
});

test('no mismatch warning when the display really does match', () => {
  const r = chooseWallDisplay([WALL], WALL, wall({ fitToDisplay: false }));
  assert.ok(!warns(r.notes).some((m) => m.includes('fitToDisplay is off')));
});

// ---- the safe area ----------------------------------------------------------

test('nothing is reserved unless the app owns the display', () => {
  assert.strictEqual(
    safeAreaTopFor({ setting: 'auto', fullscreen: false, platform: 'darwin', display: WALL }),
    0
  );
});

test('auto measures the notch from the display, on darwin only', () => {
  const notched = d(1, 'MacBook', 1800, 1169, {
    bounds: { x: 0, y: 0, width: 1800, height: 1169 },
    workArea: { x: 0, y: 38, width: 1800, height: 1131 },
  });
  assert.strictEqual(
    safeAreaTopFor({ setting: 'auto', fullscreen: true, platform: 'darwin', display: notched }),
    38
  );
  // Windows is the deployment target and puts nothing over a fullscreen window.
  assert.strictEqual(
    safeAreaTopFor({ setting: 'auto', fullscreen: true, platform: 'win32', display: notched }),
    0
  );
});

test('auto with no display to measure is zero, not NaN', () => {
  assert.strictEqual(
    safeAreaTopFor({ setting: 'auto', fullscreen: true, platform: 'darwin', display: null }),
    0
  );
});

test('an explicit number is used, and rubbish is ignored', () => {
  const at = (setting) => safeAreaTopFor({ setting, fullscreen: true, platform: 'win32' });
  assert.strictEqual(at(40), 40);
  assert.strictEqual(at(40.6), 41);
  assert.strictEqual(at(0), 0);
  assert.strictEqual(at(-10), 0);
  assert.strictEqual(at('tall'), 0);
  assert.strictEqual(at(undefined), 0);
});

// ---- fitting ----------------------------------------------------------------

test('a display that matches the wall is 1:1 and not offset', () => {
  const l = fitLayout({ target: { width: 3840, height: 2160 }, wall: WALL_UNITS() });
  assert.strictEqual(l.scale, 1);
  assert.strictEqual(l.offsetX, 0);
  assert.strictEqual(l.offsetY, 0);
});

function WALL_UNITS() {
  return { width: 3840, height: 2160 };
}

// The feature that makes a 4K layout previewable on a laptop at the proportions
// it will have on the wall.
test('a smaller window scales down and letterboxes on the constrained axis', () => {
  const l = fitLayout({ target: { width: 1920, height: 1200 }, wall: WALL_UNITS() });
  assert.strictEqual(l.scale, 0.5, 'width is the tighter constraint');
  assert.strictEqual(l.offsetX, 0);
  assert.strictEqual(l.offsetY, 60, 'centred vertically in the leftover');
});

test('fitToDisplay false pins the scale to 1 whatever the window is', () => {
  const l = fitLayout({
    target: { width: 1280, height: 800 },
    wall: WALL_UNITS(),
    fitToDisplay: false,
  });
  assert.strictEqual(l.scale, 1);
});

test('the safe area is reserved at the top and the rest is centred below it', () => {
  const l = fitLayout({
    target: { width: 3840, height: 2198 },
    wall: WALL_UNITS(),
    safeTop: 38,
  });
  assert.strictEqual(l.scale, 1);
  assert.strictEqual(l.offsetY, 38);
  assert.strictEqual(l.safeTop, 38);
});

// A zero or negative available height would divide the scale to 0 and collapse
// every panel to nothing.
test('a safe area taller than the window does not collapse the layout', () => {
  const l = fitLayout({ target: { width: 800, height: 40 }, wall: WALL_UNITS(), safeTop: 100 });
  assert.ok(l.scale > 0, `scale was ${l.scale}`);
  assert.ok(Number.isFinite(l.offsetY));
});

// ---- the log line -----------------------------------------------------------

test('the log line distinguishes 1:1 from scaled, and mentions any inset', () => {
  const wall_ = WALL_UNITS();
  const one = describeLayout({
    wall: wall_,
    layout: fitLayout({ target: { width: 3840, height: 2160 }, wall: wall_ }),
  });
  assert.match(one, /1:1/);
  assert.ok(!one.includes('clear at the top'));

  const scaled = describeLayout({
    wall: wall_,
    layout: fitLayout({ target: { width: 1920, height: 1080 }, wall: wall_, safeTop: 38 }),
  });
  assert.match(scaled, /scaled to 0\.\d+/);
  assert.match(scaled, /keeping 38px clear at the top/);
});
