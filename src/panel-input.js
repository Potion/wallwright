// Turns what a tablet sends into what webContents.sendInputEvent takes.
//
// Pure, and imports no electron, for the same reason src/control-server.js does
// not: it is the part with the arithmetic in it, so it is the part worth testing
// directly rather than through a running wall.
//
// The tablet sends coordinates in the panel's own window-pixel space, which is
// the `rect` the status route publishes, and they are passed to sendInputEvent
// unchanged. No zoom conversion, which is not obvious and was settled by
// measurement rather than by reading:
//
// A panel rendering 1253x705 window pixels at panelZoom 1.306 reports an
// innerWidth of 960, so its CSS space and its window-pixel space differ. Sending
// sendInputEvent an x of 61 produced a clientX of 46, which is 61 / 1.306.
// sendInputEvent therefore works in the view's own window-pixel space and
// Chromium divides by the zoom on the way in. To land at the right fraction of
// the page, the number to hand it is the window-pixel coordinate itself.
//
// At zoom 1 both candidate answers agree, which is why the first calibration
// pass looked conclusive and was not. Any future check has to use a panel whose
// zoom is not 1.

// A coalesced drag sends a burst, not a stream. Thirty-two is far more than one
// animation frame's worth and still bounds what a single request can ask the
// wall to replay.
const MAX_EVENTS = 32;

// A burst of typing, not a paste of a document. Long enough for dictation or a
// password manager filling a field in one go.
const MAX_TEXT_CHARS = 256;
// A paste is one insertion rather than a run of characters, so it can afford to
// be longer than something typed.
const MAX_PASTE_CHARS = 4096;
// Text expands to one event per character, so a full batch of full strings would
// be thousands of events for the wall to replay. This bounds the expansion
// rather than the request.
const MAX_EXPANDED_EVENTS = 1024;

// Named keys the tablet may send, mapped to what sendInputEvent wants. An
// allow-list rather than passing the DOM key name straight through: keyCode is
// documented as taking Accelerator names, and the two do not agree on the arrows.
//
// Printable characters never come through here. They arrive as `text` and go out
// as char events, which is the only path that carries an accent, a currency
// symbol, or anything a dead key or an IME composed.
const NAMED_KEYS = {
  Backspace: 'Backspace',
  Tab: 'Tab',
  Enter: 'Return',
  Escape: 'Escape',
  Delete: 'Delete',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

// Editing commands, which are NOT keystrokes.
//
// This was originally built as a shortcut chord - control or meta plus a letter,
// sent through `key` - and it silently did nothing. Measured: an injected Cmd+V
// arrives at the page as a keydown of "v" with the meta modifier set and pastes
// nothing, and an injected Cmd+A appends where it should have replaced. Clipboard
// and selection are browser-level commands in Chromium, driven by the command
// layer rather than by a page's key handling, so no amount of key injection
// reaches them. webContents exposes them directly instead.
//
// An allow-list, because the command is used to index into webContents.
const EDIT_COMMANDS = [
  'selectAll',
  'copy',
  'cut',
  'paste',
  'pasteAndMatchStyle',
  'undo',
  'redo',
  'delete',
];

// What Electron accepts. capsLock and numLock are deliberately absent: a tablet
// has no such state to report and nothing should be inventing one.
const MODIFIERS = ['shift', 'control', 'alt', 'meta'];

function modifiersOf(list) {
  if (list === undefined) return { ok: true, modifiers: [] };
  if (!Array.isArray(list)) return { ok: false, reason: 'modifiers must be an array' };
  for (const m of list) {
    if (MODIFIERS.indexOf(m) < 0) {
      return { ok: false, reason: `unknown modifier: ${JSON.stringify(m)}` };
    }
  }
  return { ok: true, modifiers: list.slice() };
}

// Printable text, as the tablet's own input produced it.
//
// One char event per CODE POINT, via Array.from: indexing a string would cut an
// emoji or any other astral character in half and send two halves of a surrogate
// pair, which arrives as nothing legible. Accented letters, currency symbols and
// anything an IME or a long-press accent menu composed all travel this path.
//
// char only, with no keyDown or keyUp around it: char is the event that inserts
// the character, and a keyDown carrying a keyCode of "e-acute" is not something
// Chromium has a scancode for.
function text(e) {
  if (typeof e.text !== 'string') return { ok: false, reason: 'text must be a string' };
  if (!e.text.length) return { ok: false, reason: 'text is empty' };
  const chars = Array.from(e.text);
  if (chars.length > MAX_TEXT_CHARS) {
    return { ok: false, reason: `at most ${MAX_TEXT_CHARS} characters per text event` };
  }
  return { ok: true, events: chars.map((ch) => ({ type: 'char', keyCode: ch })) };
}

// A named key: the ones a text field needs that produce no character.
// The clipboard and the selection, as commands rather than chords.
function edit(e) {
  if (EDIT_COMMANDS.indexOf(e.command) < 0) {
    return { ok: false, reason: `unknown edit command: ${JSON.stringify(e.command)}` };
  }
  return { ok: true, events: [{ type: 'edit', command: e.command }] };
}

// A paste of text the TABLET holds.
//
// Not the `paste` edit command, which pastes the show PC's own clipboard and is
// almost never what somebody holding a tablet meant. This carries the text
// across and inserts it, so a password copied out of a password manager on the
// tablet reaches the panel without ever touching the wall's clipboard.
//
// insertText rather than a run of char events: it is one operation, the page
// sees one insertion rather than a hundred, and there is no per-character cap to
// run into on a long value.
function paste(e) {
  if (typeof e.text !== 'string') return { ok: false, reason: 'text must be a string' };
  if (!e.text.length) return { ok: false, reason: 'text is empty' };
  if (e.text.length > MAX_PASTE_CHARS) {
    return { ok: false, reason: `at most ${MAX_PASTE_CHARS} characters per paste` };
  }
  return { ok: true, events: [{ type: 'insertText', text: e.text }] };
}

function key(e) {
  const mods = modifiersOf(e.modifiers);
  if (!mods.ok) return mods;

  const code = NAMED_KEYS[e.key];
  if (!code) {
    if (typeof e.key === 'string' && /^[A-Za-z0-9]$/.test(e.key)) {
      return {
        ok: false,
        reason: `${JSON.stringify(e.key)} is not a key this sends; use text to type it, or edit for a clipboard command`,
      };
    }
    return { ok: false, reason: `unknown key: ${JSON.stringify(e.key)}` };
  }
  // Down and up together: a page watching for keyup to close a dialog, or to
  // stop a key repeating, needs to see the release.
  return {
    ok: true,
    events: [
      { type: 'keyDown', keyCode: code, modifiers: mods.modifiers },
      { type: 'keyUp', keyCode: code, modifiers: mods.modifiers },
    ],
  };
}

function finite(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

// Only ever 1 or 2. A tablet reporting a triple click is either confused or
// hostile, and neither is worth passing to a page.
function clicks(n) {
  return n === 2 ? 2 : 1;
}

function one(e) {
  if (!e || typeof e !== 'object') return { ok: false, reason: 'each event must be an object' };

  // Keyboard events carry no coordinates: they go wherever the focus already is,
  // which is the point of them. Checked before the coordinate guard so they are
  // not asked for an x and a y they have no business having.
  if (e.kind === 'text') return text(e);
  if (e.kind === 'key') return key(e);
  if (e.kind === 'edit') return edit(e);
  if (e.kind === 'paste') return paste(e);

  if (!finite(e.x) || !finite(e.y))
    return { ok: false, reason: 'x and y must be finite numbers' };
  const x = Math.round(e.x);
  const y = Math.round(e.y);

  switch (e.kind) {
    // Before a down, always. Pages that reveal controls on hover need the move
    // to have happened or the click lands on something that is not there yet.
    case 'move':
      return { ok: true, event: { type: 'mouseMove', x, y } };
    case 'down':
      return {
        ok: true,
        event: { type: 'mouseDown', x, y, button: 'left', clickCount: clicks(e.clickCount) },
      };
    case 'up':
      return {
        ok: true,
        event: { type: 'mouseUp', x, y, button: 'left', clickCount: clicks(e.clickCount) },
      };
    case 'wheel': {
      if (!finite(e.deltaX) || !finite(e.deltaY)) {
        return { ok: false, reason: 'wheel needs finite deltaX and deltaY' };
      }
      // Negated, because the two conventions disagree. A DOM wheel event reports
      // a POSITIVE deltaY when the user scrolls down; sendInputEvent takes the
      // traditional wheel convention where a NEGATIVE deltaY moves the page
      // down. Measured: deltaY -600 took a page from scrollY 0 to 919, and +600
      // brought it back. Forwarding the browser's value unchanged would scroll
      // every tablet swipe backwards.
      return {
        ok: true,
        event: {
          type: 'mouseWheel',
          x,
          y,
          deltaX: -Math.round(e.deltaX),
          deltaY: -Math.round(e.deltaY),
          canScroll: true,
        },
      };
    }
    default:
      return { ok: false, reason: `unknown input kind: ${JSON.stringify(e.kind)}` };
  }
}

// Validates the WHOLE batch before returning any of it, the same contract the
// settings patch follows. A half-delivered drag is worse than a refused one: it
// leaves a page holding a mouse button nobody is pressing.
function inputEvents(events) {
  if (!Array.isArray(events)) return { ok: false, reason: 'events must be an array' };
  if (!events.length) return { ok: false, reason: 'events is empty' };
  if (events.length > MAX_EVENTS) {
    return { ok: false, reason: `at most ${MAX_EVENTS} events per request` };
  }
  const out = [];
  for (const e of events) {
    const built = one(e);
    if (!built.ok) return built;
    // A pointer event builds one; a text event builds one per character.
    if (built.events) out.push(...built.events);
    else out.push(built.event);
    if (out.length > MAX_EXPANDED_EVENTS) {
      return { ok: false, reason: `that expands past ${MAX_EXPANDED_EVENTS} input events` };
    }
  }
  return { ok: true, events: out };
}

module.exports = {
  inputEvents,
  MAX_EVENTS,
  MAX_TEXT_CHARS,
  MAX_PASTE_CHARS,
  NAMED_KEYS,
  EDIT_COMMANDS,
};
