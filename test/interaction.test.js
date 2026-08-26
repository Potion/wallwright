// node --test test/interaction.test.js
//
// The Esc policy is a decision Jeff made on 2026-08-21 (escToGrid: "single", see
// docs/validation.md), it has three modes and a double-press timing, and none of
// it had a test while it lived inside the function that also did the docking.
const test = require('node:test');
const assert = require('node:assert');
const { escapeDecision, isFullscreenToggle } = require('../src/interaction');

const esc = (over) =>
  escapeDecision({
    mode: 'active',
    escToGrid: 'single',
    lastEscAt: 0,
    now: 10000,
    escDoubleMs: 600,
    ...over,
  });

// ---- the shipped setting ----------------------------------------------------

test('single: one press docks', () => {
  assert.strictEqual(esc({ escToGrid: 'single' }), 'dock');
});

test('off: Esc always belongs to the page', () => {
  assert.strictEqual(esc({ escToGrid: 'off' }), 'pass');
  // Even a rapid second press. "off" means off.
  assert.strictEqual(esc({ escToGrid: 'off', lastEscAt: 9900 }), 'pass');
});

// ---- double ----------------------------------------------------------------

// The whole point of "double" is that the first press reaches the page so a
// dashboard can close its own modal.
test('double: the first press passes through and arms the clock', () => {
  assert.strictEqual(esc({ escToGrid: 'double', lastEscAt: 0 }), 'arm');
});

test('double: a quick second press docks', () => {
  assert.strictEqual(esc({ escToGrid: 'double', lastEscAt: 9700, now: 10000 }), 'dock');
});

test('double: a slow second press only re-arms', () => {
  assert.strictEqual(esc({ escToGrid: 'double', lastEscAt: 9000, now: 10000 }), 'arm');
});

// Exactly at the boundary is too slow, so the comparison is strict.
test('double: the window is exclusive at its edge', () => {
  assert.strictEqual(esc({ escToGrid: 'double', lastEscAt: 9400, now: 10000 }), 'arm');
  assert.strictEqual(esc({ escToGrid: 'double', lastEscAt: 9401, now: 10000 }), 'dock');
});

// config.js validates escDoubleMs precisely so this cannot happen, but the
// decision should degrade to "the page keeps Esc" rather than to "Esc is dead".
test('double: a NaN window never docks, and never traps the key', () => {
  assert.strictEqual(esc({ escToGrid: 'double', lastEscAt: 9999, escDoubleMs: NaN }), 'arm');
});

// ---- modes other than active ------------------------------------------------

test('select mode always docks, whatever escToGrid says', () => {
  for (const escToGrid of ['single', 'double', 'off']) {
    assert.strictEqual(esc({ mode: 'select', escToGrid }), 'dock', escToGrid);
  }
});

test('grid and edit modes leave Esc alone', () => {
  // Edit mode has its own Esc handling in the overlay: save, or Shift+Esc to
  // discard. This must not take the key away from it.
  assert.strictEqual(esc({ mode: 'grid' }), 'pass');
  assert.strictEqual(esc({ mode: 'edit' }), 'pass');
});

test('an unrecognised escToGrid does not swallow the key', () => {
  assert.strictEqual(esc({ escToGrid: 'sometimes' }), 'pass');
  assert.strictEqual(esc({ escToGrid: undefined }), 'pass');
});

// ---- Cmd/Ctrl+F -------------------------------------------------------------

const key = (over) => ({ type: 'keyDown', key: 'f', meta: true, ...over });

test('Cmd+F and Ctrl+F both toggle', () => {
  assert.strictEqual(isFullscreenToggle(key({ meta: true })), true);
  assert.strictEqual(isFullscreenToggle(key({ meta: false, control: true })), true);
  assert.strictEqual(isFullscreenToggle(key({ key: 'F' })), true, 'case-insensitive');
});

// A dashboard's own Cmd+Shift+F must reach it.
test("adding shift or alt makes it someone else's shortcut", () => {
  assert.strictEqual(isFullscreenToggle(key({ shift: true })), false);
  assert.strictEqual(isFullscreenToggle(key({ alt: true })), false);
});

test('plain f, keyUp, and other keys are not the toggle', () => {
  assert.strictEqual(isFullscreenToggle(key({ meta: false, control: false })), false);
  assert.strictEqual(isFullscreenToggle(key({ type: 'keyUp' })), false);
  assert.strictEqual(isFullscreenToggle(key({ key: 'g' })), false);
});

test('a missing or malformed input is not a toggle', () => {
  assert.strictEqual(isFullscreenToggle(undefined), false);
  assert.strictEqual(isFullscreenToggle({}), false);
});
