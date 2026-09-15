// node --test test/panel-input.test.js
//
// src/panel-input.js is the arithmetic between a tablet and sendInputEvent, and
// it imports no electron so it can be checked directly rather than through a
// running wall.
const test = require('node:test');
const assert = require('node:assert');
const {
  inputEvents,
  MAX_EVENTS,
  MAX_TEXT_CHARS,
  MAX_PASTE_CHARS,
  EDIT_COMMANDS,
} = require('../src/panel-input');

const at = (kind, x, y, extra) => Object.assign({ kind, x, y }, extra || {});

test('a click becomes the three events a page expects', () => {
  const v = inputEvents([at('move', 10, 20), at('down', 10, 20), at('up', 10, 20)]);
  assert.ok(v.ok);
  assert.deepStrictEqual(
    v.events.map((e) => e.type),
    ['mouseMove', 'mouseDown', 'mouseUp']
  );
  assert.strictEqual(v.events[1].button, 'left');
  assert.strictEqual(v.events[1].clickCount, 1);
});

// Coordinates pass through untouched. The measurement behind that is in the
// header of src/panel-input.js: sendInputEvent works in the view's own
// window-pixel space, which is the space the tablet already sends.
test('coordinates are passed through, not converted', () => {
  const v = inputEvents([at('down', 80, 625)]);
  assert.strictEqual(v.events[0].x, 80);
  assert.strictEqual(v.events[0].y, 625);
});

test('fractional coordinates are rounded, since sendInputEvent wants integers', () => {
  const v = inputEvents([at('move', 10.4, 20.6)]);
  assert.strictEqual(v.events[0].x, 10);
  assert.strictEqual(v.events[0].y, 21);
});

test('a double click is carried through, and anything higher is not', () => {
  assert.strictEqual(
    inputEvents([at('down', 1, 1, { clickCount: 2 })]).events[0].clickCount,
    2
  );
  assert.strictEqual(
    inputEvents([at('down', 1, 1, { clickCount: 7 })]).events[0].clickCount,
    1
  );
});

test('a wheel carries its deltas and may scroll', () => {
  const v = inputEvents([at('wheel', 5, 5, { deltaX: 0, deltaY: -120 })]);
  assert.strictEqual(v.events[0].type, 'mouseWheel');
  assert.strictEqual(v.events[0].canScroll, true);
});

// The two conventions disagree: a DOM wheel event reports a positive deltaY when
// the user scrolls down, and sendInputEvent wants a negative one to move the page
// down. Passing the browser's value through unchanged scrolled every swipe the
// wrong way.
test('wheel deltas are negated for sendInputEvent', () => {
  const down = inputEvents([at('wheel', 5, 5, { deltaX: 0, deltaY: 120 })]);
  assert.strictEqual(down.events[0].deltaY, -120, 'a scroll-down becomes a negative delta');
  const up = inputEvents([at('wheel', 5, 5, { deltaX: 0, deltaY: -120 })]);
  assert.strictEqual(up.events[0].deltaY, 120);
  const right = inputEvents([at('wheel', 5, 5, { deltaX: 40, deltaY: 0 })]);
  assert.strictEqual(right.events[0].deltaX, -40, 'both axes follow the same rule');
});

test('a wheel without deltas is refused rather than sent as a zero scroll', () => {
  const v = inputEvents([at('wheel', 5, 5)]);
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /deltaX and deltaY/);
});

test('an unknown kind is refused, and names itself', () => {
  const v = inputEvents([at('teleport', 1, 1)]);
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /teleport/);
});

test('coordinates that are not finite numbers are refused', () => {
  for (const bad of [{ x: 'ten', y: 1 }, { x: 1, y: NaN }, { x: Infinity, y: 1 }, {}]) {
    const v = inputEvents([Object.assign({ kind: 'move' }, bad)]);
    assert.strictEqual(v.ok, false, JSON.stringify(bad));
    assert.match(v.reason, /finite/);
  }
});

test('a batch that is not an array, or is empty, is refused', () => {
  assert.match(inputEvents('down').reason, /must be an array/);
  assert.match(inputEvents([]).reason, /empty/);
});

test('an over-long batch is refused', () => {
  const many = Array.from({ length: MAX_EVENTS + 1 }, () => at('move', 1, 1));
  const v = inputEvents(many);
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, new RegExp(String(MAX_EVENTS)));
  assert.ok(inputEvents(many.slice(0, MAX_EVENTS)).ok, 'the cap itself is allowed');
});

// The whole batch is checked before any of it is returned. A half-delivered drag
// leaves a page holding a mouse button nobody is pressing.
test('one bad event refuses the whole batch', () => {
  const v = inputEvents([at('move', 1, 1), at('down', 1, 1), at('nonsense', 1, 1)]);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.events, undefined);
});

// ---- keyboard ---------------------------------------------------------------
//
// Logins are the reason this exists, so the characters that matter are the ones
// a password actually contains: accents, currency symbols, anything a long-press
// menu or an IME composed. Those never arrive as key names; they arrive as text.

const codes = (v) => v.events.map((e) => e.keyCode);

test('text becomes one char event per character', () => {
  const v = inputEvents([{ kind: 'text', text: 'ab' }]);
  assert.ok(v.ok);
  assert.deepStrictEqual(
    v.events.map((e) => e.type),
    ['char', 'char']
  );
  assert.deepStrictEqual(codes(v), ['a', 'b']);
});

// The whole point of the feature. A keyDown cannot carry these: there is no
// scancode for an accented letter.
test('accented letters and symbols survive intact', () => {
  assert.deepStrictEqual(codes(inputEvents([{ kind: 'text', text: 'éüñ' }])), ['é', 'ü', 'ñ']);
  assert.deepStrictEqual(codes(inputEvents([{ kind: 'text', text: '€£¥' }])), ['€', '£', '¥']);
  assert.deepStrictEqual(codes(inputEvents([{ kind: 'text', text: 'Ω中' }])), ['Ω', '中']);
});

// Indexing a string by position would split this into two halves of a surrogate
// pair and send two characters, neither of which is anything.
test('an astral character is one event, not two halves', () => {
  const v = inputEvents([{ kind: 'text', text: '🔑' }]);
  assert.strictEqual(v.events.length, 1, 'one code point, one event');
  assert.strictEqual(v.events[0].keyCode, '🔑');
});

test('a mixed string keeps its order and its code points', () => {
  assert.deepStrictEqual(codes(inputEvents([{ kind: 'text', text: 'pa55.é' }])), [
    'p',
    'a',
    '5',
    '5',
    '.',
    'é',
  ]);
});

test('text carries no coordinates and is not asked for any', () => {
  const v = inputEvents([{ kind: 'text', text: 'a' }]);
  assert.ok(v.ok, v.reason);
  assert.strictEqual(v.events[0].x, undefined);
});

test('empty or non-string text is refused', () => {
  assert.match(inputEvents([{ kind: 'text', text: '' }]).reason, /empty/);
  assert.match(inputEvents([{ kind: 'text', text: 42 }]).reason, /must be a string/);
  assert.match(inputEvents([{ kind: 'text' }]).reason, /must be a string/);
});

test('an over-long text event is refused', () => {
  const v = inputEvents([{ kind: 'text', text: 'x'.repeat(MAX_TEXT_CHARS + 1) }]);
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, new RegExp(String(MAX_TEXT_CHARS)));
  assert.ok(inputEvents([{ kind: 'text', text: 'x'.repeat(MAX_TEXT_CHARS) }]).ok);
});

// A full batch of full strings is thousands of events for the wall to replay.
test('a batch that expands too far is refused', () => {
  const many = Array.from({ length: 8 }, () => ({
    kind: 'text',
    text: 'x'.repeat(MAX_TEXT_CHARS),
  }));
  const v = inputEvents(many);
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /expands past/);
});

// A page watching for keyup to close a dialog needs to see the release.
test('a named key sends both the press and the release', () => {
  const v = inputEvents([{ kind: 'key', key: 'Enter' }]);
  assert.deepStrictEqual(
    v.events.map((e) => e.type),
    ['keyDown', 'keyUp']
  );
  assert.strictEqual(v.events[0].keyCode, 'Return', 'Enter is Return to sendInputEvent');
});

// The DOM name and the Accelerator name disagree on the arrows, which is why
// there is a map rather than a pass-through.
test('DOM key names are translated, not passed through', () => {
  assert.strictEqual(
    inputEvents([{ kind: 'key', key: 'ArrowLeft' }]).events[0].keyCode,
    'Left'
  );
  assert.strictEqual(inputEvents([{ kind: 'key', key: 'ArrowUp' }]).events[0].keyCode, 'Up');
});

test('modifiers are carried on both the press and the release', () => {
  const v = inputEvents([{ kind: 'key', key: 'Tab', modifiers: ['shift'] }]);
  assert.deepStrictEqual(v.events[0].modifiers, ['shift']);
  assert.deepStrictEqual(v.events[1].modifiers, ['shift']);
});

// An allow-list, so nothing invents a key name the wall then tries to press.
test('an unknown key or modifier is refused by name', () => {
  assert.match(inputEvents([{ kind: 'key', key: 'F13' }]).reason, /F13/);
  // A bare letter has its own, more useful refusal: see the shortcut tests.
  assert.strictEqual(inputEvents([{ kind: 'key', key: 'a' }]).ok, false);
  assert.match(
    inputEvents([{ kind: 'key', key: 'Tab', modifiers: ['hyper'] }]).reason,
    /unknown modifier/
  );
  assert.match(
    inputEvents([{ kind: 'key', key: 'Tab', modifiers: 'shift' }]).reason,
    /must be an array/
  );
});

// Typing into a field that a tap just focused is the whole login flow.
test('pointer and keyboard mix in one batch', () => {
  const v = inputEvents([
    { kind: 'move', x: 5, y: 5 },
    { kind: 'down', x: 5, y: 5 },
    { kind: 'up', x: 5, y: 5 },
    { kind: 'text', text: 'hé' },
    { kind: 'key', key: 'Enter' },
  ]);
  assert.ok(v.ok, v.reason);
  assert.deepStrictEqual(
    v.events.map((e) => e.type),
    ['mouseMove', 'mouseDown', 'mouseUp', 'char', 'char', 'keyDown', 'keyUp']
  );
});

// ---- clipboard and selection ------------------------------------------------
//
// These began as shortcut chords sent through `key`, and they silently did
// nothing. An injected Cmd+V reaches the page as a keydown of "v" with meta set
// and pastes nothing; an injected Cmd+A appends where it should replace.
// Clipboard and selection are browser-level commands in Chromium, so they go
// over as commands.

test('an edit command is passed through as a command, not a keystroke', () => {
  const v = inputEvents([{ kind: 'edit', command: 'selectAll' }]);
  assert.ok(v.ok, v.reason);
  assert.deepStrictEqual(v.events, [{ type: 'edit', command: 'selectAll' }]);
});

test('every documented edit command is accepted', () => {
  for (const c of EDIT_COMMANDS) {
    assert.ok(inputEvents([{ kind: 'edit', command: c }]).ok, c);
  }
});

// The command indexes into webContents, so it is an allow-list rather than a
// string that gets called.
test('an unknown edit command is refused by name', () => {
  assert.match(inputEvents([{ kind: 'edit', command: 'destroy' }]).reason, /destroy/);
  assert.match(inputEvents([{ kind: 'edit', command: 'constructor' }]).reason, /unknown edit/);
  assert.strictEqual(inputEvents([{ kind: 'edit' }]).ok, false);
});

// A paste carries the TABLET's clipboard. The `paste` edit command pastes the
// show PC's own clipboard, which is almost never what the operator meant.
test('a paste is one insertion, not a run of characters', () => {
  const v = inputEvents([{ kind: 'paste', text: 'sécret€' }]);
  assert.deepStrictEqual(v.events, [{ type: 'insertText', text: 'sécret€' }]);
});

test('a paste may be much longer than something typed', () => {
  assert.ok(inputEvents([{ kind: 'paste', text: 'x'.repeat(MAX_TEXT_CHARS + 1) }]).ok);
  assert.ok(inputEvents([{ kind: 'paste', text: 'x'.repeat(MAX_PASTE_CHARS) }]).ok);
  assert.match(
    inputEvents([{ kind: 'paste', text: 'x'.repeat(MAX_PASTE_CHARS + 1) }]).reason,
    new RegExp(String(MAX_PASTE_CHARS))
  );
});

test('an empty or non-string paste is refused', () => {
  assert.match(inputEvents([{ kind: 'paste', text: '' }]).reason, /empty/);
  assert.match(inputEvents([{ kind: 'paste', text: 7 }]).reason, /must be a string/);
});

// The old chord path is gone, and says where to go instead.
test('a letter key is refused and points at text and edit', () => {
  const v = inputEvents([{ kind: 'key', key: 'v', modifiers: ['meta'] }]);
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /use text to type it/);
  assert.match(v.reason, /edit for a clipboard command/);
});

test('a named key still works, with and without modifiers', () => {
  assert.ok(inputEvents([{ kind: 'key', key: 'Tab' }]).ok);
  assert.ok(inputEvents([{ kind: 'key', key: 'Tab', modifiers: ['shift'] }]).ok);
});
