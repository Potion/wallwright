// node --test test/control-page.test.js
//
// The control page shipped broken once. It built onclick="..." into its markup,
// so JavaScript sat inside HTML attributes inside a template literal, the
// escaping collapsed, and the served page would not parse: a browser would have
// rendered it blank. It was only caught by extracting the script and checking it
// by hand. That check belongs here instead.
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const {
  statusPage,
  touchPage,
  transportDecision,
  touchToPanel,
} = require('../src/control-page');

const html = statusPage();

function inlineScript() {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'the page should contain an inline script');
  return m[1];
}

test('the inline script parses', () => {
  // Compiles without running, so a syntax error throws here.
  assert.doesNotThrow(() => new vm.Script(inlineScript()));
});

test('the page has the elements the script writes into', () => {
  for (const id of ['mode', 'sub', 'err', 'presets', 'panels']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
});

// The regression guard. Inline handlers are what broke it, and they are what
// would break it again.
test('no inline event handlers anywhere in the page', () => {
  const offenders = html.match(/\son(click|change|keydown|input|submit|load)\s*=/gi);
  assert.strictEqual(
    offenders,
    null,
    `use data- attributes and the delegated listener instead of ${offenders}`
  );
});

test('every action the page can take is one the server routes', () => {
  const script = inlineScript();
  const actions = [...script.matchAll(/data-action="([a-z-]+)"/g)].map((m) => m[1]);
  const handled = [...script.matchAll(/action === '([a-z-]+)'/g)].map((m) => m[1]);
  // Every button the page renders must be one the delegated listener knows.
  for (const a of actions) assert.ok(handled.includes(a), `nothing handles data-action="${a}"`);
  assert.ok(handled.length >= 5, 'expected the full set of actions');
});

test('it posts only to routes the control server serves', () => {
  const paths = [...inlineScript().matchAll(/'(\/api\/[a-z]+)'/g)].map((m) => m[1]);
  const served = [
    '/api/status',
    '/api/preset',
    '/api/panel',
    '/api/promote',
    '/api/reload',
    '/api/recycle',
    '/api/settings',
  ];
  for (const p of new Set(paths)) assert.ok(served.includes(p), `${p} is not a served route`);
});

test('the settings box has a slot and a control for every editable setting', () => {
  assert.match(html, /id="settings"/, 'missing #settings');
  const script = inlineScript();
  const rendered = [...script.matchAll(/data-setting="([A-Za-z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(rendered, ['autoStart', 'memoryHardLimitMb', 'memoryLimitMb']);
});

// The page must render what the wall reports, not what it last posted. A panel
// that echoed its own input would hide a patch the wall had refused, or a value
// changed from the config file underneath it.
test('the settings box reads its values out of the status payload', () => {
  const script = inlineScript();
  assert.match(script, /s\.settings/, 'settings should come from the status');
  assert.match(script, /esc\(st\.memoryLimitMb\)/, 'and be escaped on the way in');
});

// The three-second poll would otherwise revert a tick the instant it was made:
// a checkbox loses focus as soon as it is clicked, so refresh()'s focus guard
// does not cover it.
test('an unsaved edit is not overwritten by the poll', () => {
  const script = inlineScript();
  assert.match(script, /settingsDirty/, 'there should be a dirty flag');
  assert.match(script, /if \(!settingsDirty\) drawSettings\(s\)/, 'draw must respect it');
  // Cleared on success only. Clearing it before the request would let a failed
  // save hand the field back to the poll.
  assert.match(script, /post\('\/api\/settings',[\s\S]{0,120}settingsDirty = false/);
});

// draw() runs every three seconds. It used to write the memory-pressure banner
// into #err, which meant a refused patch reported an error that erased itself
// before it could be read. The settings box refuses patches by design, so that
// stopped being a rare path.
test('the poll cannot erase the message from the last request', () => {
  const script = inlineScript();
  assert.match(html, /id="pressure"/, 'pressure needs its own slot');
  const draw = script.slice(script.indexOf('function draw(s)'));
  assert.ok(
    !/\$\('err'\)\.innerHTML/.test(draw),
    'draw() must not write to #err; that belongs to the last POST'
  );
  assert.match(draw, /\$\('pressure'\)\.innerHTML/, 'the banner goes to #pressure');
});

test('values are escaped before being written into markup', () => {
  const script = inlineScript();
  assert.match(script, /function esc\(/, 'an escaper should exist');
  // A URL comes from the page itself and can contain anything.
  assert.match(script, /esc\(p\.url\)/, 'panel urls must be escaped');
  assert.match(script, /esc\(p\.id\)/, 'panel ids must be escaped');
});

test('it is self-contained, since a show PC may have no internet', () => {
  assert.ok(!/<script[^>]+src=/i.test(html), 'no external scripts');
  assert.ok(!/<link[^>]+stylesheet/i.test(html), 'no external stylesheets');
  assert.ok(!/https?:\/\//i.test(html.replace(/https?:\/\/'/g, '')), 'no remote references');
});

// ---- the tablet surface -----------------------------------------------------

const touch = touchPage();

function touchScript() {
  const m = touch.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'the touch page should contain an inline script');
  return m[1];
}

test('the touch page inline script parses', () => {
  assert.doesNotThrow(() => new vm.Script(touchScript()));
});

test('the touch page has no inline event handlers', () => {
  assert.ok(!/<[^>]+\son[a-z]+=/i.test(touch), 'no on*= attributes in markup');
});

test('the touch page is self-contained', () => {
  assert.ok(!/<script[^>]+src=/i.test(touch), 'no external scripts');
  assert.ok(!/<link[^>]+stylesheet/i.test(touch), 'no external stylesheets');
  assert.ok(!/https?:\/\//i.test(touch), 'no remote references');
});

// The rule lives in exactly one place. If the page ever grows its own copy the
// tests below stop describing what the browser runs.
test('the page runs the same decision function the tests do', () => {
  assert.match(touchScript(), /function transportDecision/);
  assert.strictEqual(touchScript().match(/function transportDecision/g).length, 1);
});

test('a frame that decodes means the stream works', () => {
  const d = transportDecision({ loaded: true, errored: false, elapsedMs: 10, timeoutMs: 2500 });
  assert.strictEqual(d, 'stream');
});

// An engine that refuses multipart outright: the error is immediate.
test('an image error falls back to polling', () => {
  const d = transportDecision({ loaded: false, errored: true, elapsedMs: 10, timeoutMs: 2500 });
  assert.strictEqual(d, 'poll');
});

// The other failure shape, and the reason a timeout exists at all: an engine
// that renders nothing and reports nothing is only visible as time passing.
test('silence for long enough falls back to polling', () => {
  assert.strictEqual(
    transportDecision({ loaded: false, errored: false, elapsedMs: 2499, timeoutMs: 2500 }),
    'waiting'
  );
  assert.strictEqual(
    transportDecision({ loaded: false, errored: false, elapsedMs: 2500, timeoutMs: 2500 }),
    'poll'
  );
});

// A stream that dies after its first frame would otherwise leave a still image
// on screen being presented as live.
test('a stream that breaks after a frame still falls back', () => {
  const d = transportDecision({ loaded: true, errored: true, elapsedMs: 10, timeoutMs: 2500 });
  assert.strictEqual(d, 'poll');
});

// The server streams one panel at a time and a socket nobody reads still holds
// the slot. Switching to polling without letting go would lock the wall out.
test('falling back releases the stream socket first', () => {
  const script = touchScript();
  const poll = script.slice(script.indexOf('function poll('));
  const release = poll.indexOf("img.removeAttribute('src')");
  const firstFetch = poll.indexOf("'/api/frame");
  assert.ok(release > -1, 'poll() must release the stream socket');
  assert.ok(release < firstFetch, 'it must release before asking for a still');
});

// The id arrives from the address bar, so it reaches markup as text and a URL
// as an encoded component.
test('the panel id is never interpolated raw', () => {
  const script = touchScript();
  assert.match(script, /nameEl\.textContent = id/, 'id goes in as text');
  assert.ok(!/innerHTML\s*=\s*[^;]*\bid\b/.test(script), 'id must not reach innerHTML');
  assert.strictEqual(
    (script.match(/encodeURIComponent\(id\)/g) || []).length,
    3,
    'the stream url, the still url and the address bar must all encode it'
  );
});

test('the touch page only talks to routes the control server serves', () => {
  const script = touchScript();
  const urls = script.match(/'\/[a-z/]+/g) || [];
  const served = ["'/api/stream", "'/api/frame", "'/api/status", "'/api/input"];
  for (const u of urls) assert.ok(served.includes(u), `unexpected route ${u}`);
});

// ---- coordinate mapping -----------------------------------------------------
//
// The frame is capped at 1600x1200 by the screencast and the element is whatever
// the tablet's screen allows, so the panel, the frame and the box are three
// different sizes. Fractions are what make that not matter.

const BOX = { left: 0, top: 0, width: 400, height: 300 };
const NAT = { width: 1600, height: 900 };
const RECT = { width: 1253, height: 705 };

test('the centre of the frame is the centre of the panel', () => {
  const at = touchToPanel({ x: 200, y: 150 }, BOX, NAT, RECT);
  assert.ok(Math.abs(at.x - RECT.width / 2) <= 1, `x was ${at.x}`);
  assert.ok(Math.abs(at.y - RECT.height / 2) <= 1, `y was ${at.y}`);
  assert.strictEqual(at.inside, true);
});

// object-fit: contain letterboxes a 16:9 frame inside a 4:3 box. Measuring from
// the box instead of the drawn frame would skew every touch toward the centre.
test('the letterbox is taken out before the fraction goes in', () => {
  // 1600x900 into 400x300 draws 400x225, so there are 37.5px bars top and bottom.
  const top = touchToPanel({ x: 0, y: 37.5 }, BOX, NAT, RECT);
  assert.deepStrictEqual([top.x, top.y], [0, 0]);
  const bottom = touchToPanel({ x: 400, y: 262.5 }, BOX, NAT, RECT);
  assert.deepStrictEqual([bottom.x, bottom.y], [RECT.width, RECT.height]);
});

test('a touch in the letterbox is not a touch on the panel', () => {
  assert.strictEqual(touchToPanel({ x: 200, y: 5 }, BOX, NAT, RECT).inside, false);
  assert.strictEqual(touchToPanel({ x: 200, y: 295 }, BOX, NAT, RECT).inside, false);
});

// The element is not at the page origin once there is a bar above it.
test('the element offset is subtracted', () => {
  const offset = { left: 30, top: 60, width: 400, height: 300 };
  const at = touchToPanel({ x: 230, y: 210 }, offset, NAT, RECT);
  assert.ok(Math.abs(at.x - RECT.width / 2) <= 1, `x was ${at.x}`);
  assert.ok(Math.abs(at.y - RECT.height / 2) <= 1, `y was ${at.y}`);
});

// The frame is downscaled by the screencast and the panel is not, so these two
// differ on the wall. The answer must be in panel space, never frame space.
test('the answer is in panel space, not frame space', () => {
  const at = touchToPanel({ x: 400, y: 262.5 }, BOX, NAT, RECT);
  assert.strictEqual(at.x, RECT.width);
  assert.notStrictEqual(at.x, NAT.width);
});

// ---- input wiring -----------------------------------------------------------

test('the page runs the same mapping function the tests do', () => {
  assert.strictEqual(touchScript().match(/function touchToPanel/g).length, 1);
});

// A page that reveals a control on hover needs the move to have happened before
// the click lands, or the click hits whatever was underneath.
test('a move is sent before every down', () => {
  const script = touchScript();
  const down = script.slice(script.indexOf("addEventListener('pointerdown'"));
  const move = down.indexOf("send('move'");
  const press = down.indexOf("send('down'");
  assert.ok(move > -1 && press > -1, 'both must be sent');
  assert.ok(move < press, 'the move must come first');
});

// A drag fires dozens of moves a second. One POST each would be a request storm.
test('moves are coalesced, and the batch respects the server cap', () => {
  const script = touchScript();
  assert.match(script, /queue\.splice\(0, 32\)/, 'a batch must respect the server cap');
  assert.match(script, /setTimeout\(flush, 16\)/, 'moves wait briefly');
});

// requestAnimationFrame does not run while a page is hidden, so a tablet that
// had been backgrounded stacked up taps and delivered none of them.
test('a tap is never held back waiting for a frame', () => {
  const script = touchScript();
  assert.ok(!/requestAnimationFrame\(/.test(script), 'rAF must not gate input delivery');
  assert.match(script, /if \(kind !== 'move'\) return flush\(\);/);
});

// rect changes when a panel is promoted. Reading it once would skew every touch
// from that moment on, so the status poll refreshes it.
test('the panel rect is re-read rather than captured once', () => {
  const script = touchScript();
  assert.match(script, /schedulePoll\(STATUS_MS\)/);
});

test('a touch outside the frame is never sent', () => {
  const script = touchScript();
  assert.match(script, /if \(!at\.inside\) return;/);
});

// ---- panel switching --------------------------------------------------------
//
// Both transports drive the same <img>, and a polling chain reschedules itself.
// Switching panels has to end whatever the element was doing, or the old panel
// keeps overwriting the new one's picture and taps land on the wrong page.

test('the picker is built with DOM calls, not markup', () => {
  const script = touchScript();
  const draw = script.slice(script.indexOf('function drawPicker'));
  assert.match(draw, /createElement\('button'\)/);
  assert.match(draw, /\.textContent = p\.label \|\| p\.id/, 'labels go in as text');
  assert.ok(!/innerHTML/.test(draw), 'ids and labels must never reach innerHTML');
});

test('the picker uses one delegated listener, like the status page', () => {
  const script = touchScript();
  assert.match(script, /pickerEl\.addEventListener\('click'/);
  assert.ok(!/<button[^>]+onclick/i.test(touch), 'no inline handlers');
});

// The counter is the whole mechanism. Every callback that can outlive a switch
// is gated on it.
test('switching bumps a session that stale callbacks check', () => {
  const script = touchScript();
  const attach = script.slice(script.indexOf('function attach('));
  assert.match(attach, /session\+\+/, 'attach must start a new session');
  assert.match(attach, /var mine = session/);
  const poll = script.slice(script.indexOf('function poll('));
  assert.match(poll, /if \(mine !== session\) return;/, 'a polling tick must check it');
  const decide = script.slice(script.indexOf('function decide('));
  assert.match(decide, /if \(mine !== session \|\| settled\) return;/);
});

test('switching clears the element before pointing it anywhere new', () => {
  const script = touchScript();
  const attach = script.slice(
    script.indexOf('function attach('),
    script.indexOf('// ---- input')
  );
  const cleared = attach.indexOf("img.removeAttribute('src')");
  const pointed = attach.indexOf("'/api/stream?id='");
  assert.ok(cleared > -1 && pointed > -1);
  assert.ok(cleared < pointed, 'the old source must be dropped first');
  assert.match(attach, /img\.onload = null/, 'old handlers must go too');
});

// The server streams one panel at a time and frees the slot when the socket
// closes. Asking for the new stream in the same tick is answered with a 400,
// which the transport probe reads as "cannot stream" and would drop to polling
// permanently.
test('the new stream waits for the old slot to be released', () => {
  const script = touchScript();
  assert.match(script, /var RELEASE_MS = \d+/);
  const attach = script.slice(script.indexOf('function attach('));
  assert.match(attach, /setTimeout\(function \(\) \{[\s\S]{0,600}RELEASE_MS\)/);
});

// A rect belongs to the panel it came from.
test('switching drops the old rect rather than reusing it', () => {
  const script = touchScript();
  const attach = script.slice(script.indexOf('function attach('));
  assert.match(attach, /rect = null/);
});

test('switching rearms the transport probe', () => {
  const script = touchScript();
  const attach = script.slice(script.indexOf('function attach('));
  for (const f of ['loaded = false', 'errored = false', 'settled = false']) {
    assert.ok(attach.includes(f), `attach must reset ${f}`);
  }
});

// A reload should come back to the panel the operator was on, and the link
// should be worth sending to somebody.
test('the address bar follows the selected panel', () => {
  const script = touchScript();
  assert.match(
    script,
    /history\.replaceState\(null, '', '\?id=' \+ encodeURIComponent\(id\)\)/
  );
});

// Arriving with no id used to be a dead end. The picker is right there.
test('no id in the url still offers the picker', () => {
  const script = touchScript();
  assert.match(script, /readStatus\(\);/);
  assert.match(script, /pick a panel/);
  assert.ok(
    !/if \(!id\) \{[^}]*return;/.test(script),
    'it must not bail before drawing the picker'
  );
});

// ---- keyboard ---------------------------------------------------------------
//
// This exists for logins, which sets the bar: the page must not keep what is
// typed, and the characters a password contains must survive.

// A local field is the only way to raise a tablet's on-screen keyboard, but it
// must not become a place a password sits.
test('the field never keeps what is typed into it', () => {
  const script = touchScript();
  const bi = script.slice(script.indexOf("addEventListener('beforeinput'"));
  assert.match(bi, /ev\.preventDefault\(\)/, 'every insertion must be cancelled');
  const ce = script.slice(script.indexOf("addEventListener('compositionend'"));
  assert.match(ce, /fieldEl\.value = ''/, 'a composed string must be cleared too');
});

test('the field opts out of autofill, autocorrect and capitalisation', () => {
  for (const attr of [
    'autocomplete="off"',
    'autocorrect="off"',
    'autocapitalize="off"',
    'spellcheck="false"',
  ]) {
    assert.ok(touch.includes(attr), `missing ${attr}`);
  }
});

// Accents, currency symbols and anything dictated or composed arrive as
// insertions, never as key names. Sending them by name would lose them.
test('printable input is sent as text, not as key names', () => {
  const script = touchScript();
  const bi = script.slice(script.indexOf("addEventListener('beforeinput'"));
  assert.match(bi, /kind: 'text', text: ev\.data/);
});

// An IME composes over several events; forwarding the intermediate ones would
// type the phonetic spelling into the panel and leave it there.
test('an IME composition is sent once, when it finishes', () => {
  const script = touchScript();
  assert.match(script, /compositionstart[\s\S]{0,120}composing = true/);
  const bi = script.slice(script.indexOf("addEventListener('beforeinput'"));
  assert.match(bi, /if \(composing\) return;/, 'nothing goes out mid-composition');
  const ce = script.slice(script.indexOf("addEventListener('compositionend'"));
  assert.match(ce, /kind: 'text', text: ev\.data/);
});

// The field is always empty, so Backspace raises no deletion event to read.
test('non-printing keys are read from keydown, by name', () => {
  const script = touchScript();
  const kd = script.slice(script.indexOf("fieldEl.addEventListener('keydown'"));
  assert.match(kd, /if \(composing\) return;/);
  assert.match(kd, /if \(!NAMED\[ev\.key\]\) return;/);
  assert.match(kd, /kind: 'key', key: ev\.key, modifiers: modsOf\(ev\)/);
  for (const k of ['Backspace', 'Tab', 'Enter', 'Escape', 'ArrowLeft']) {
    assert.match(script, new RegExp(k + ': 1'), `${k} should be a named key`);
  }
});

test('modifiers are collected from the event', () => {
  const script = touchScript();
  const m = script.slice(script.indexOf('function modsOf'));
  for (const [prop, name] of [
    ['shiftKey', 'shift'],
    ['ctrlKey', 'control'],
    ['altKey', 'alt'],
    ['metaKey', 'meta'],
  ]) {
    assert.match(m, new RegExp(`ev\\.${prop}[\\s\\S]{0,30}'${name}'`));
  }
});

// Tapping a login box is how the operator puts the cursor there, and that moves
// the tablet's own focus off the field.
test('tapping the panel hands focus back to the field', () => {
  const script = touchScript();
  assert.match(script, /if \(keyboardOn\) fieldEl\.focus\(\);/);
});

// A keystroke is not worth coalescing, and must not wait behind a move timer.
test('keystrokes are flushed immediately', () => {
  const script = touchScript();
  const q = script.slice(script.indexOf('function queueEvent'));
  assert.match(q, /queue\.push\(e\);[\s\S]{0,40}flush\(\);/);
});

test('the keyboard is off until it is asked for', () => {
  assert.match(touch, /<div id="keys" hidden>/);
  const script = touchScript();
  assert.match(script, /var keyboardOn = false;/);
});

// ---- quality ----------------------------------------------------------------

// Quality and width are paired, because they are not independent in practice:
// on animation-heavy content the sharp preset is slow AND expensive, and an
// operator offered two knobs will eventually pick that corner.
test('the view control cycles paired presets and restarts the stream', () => {
  const script = touchScript();
  assert.match(script, /\{ name: 'smooth', q: 40, w: 640 \}/);
  assert.match(script, /\{ name: 'sharp', q: 90, w: 1600 \}/);
  const q = script.slice(script.indexOf("qEl.addEventListener('click'"));
  assert.match(q, /preset = \(preset \+ 1\) % PRESETS\.length/, 'it cycles');
  // These are screencast start-up parameters, not per-frame ones.
  assert.match(q, /if \(id\) attach\(id\)/);
});

test('both transports ask for the chosen preset', () => {
  const script = touchScript();
  const stream = script.slice(script.indexOf("'/api/stream?id='"));
  assert.match(stream.slice(0, 200), /PRESETS\[preset\]\.q[\s\S]{0,60}PRESETS\[preset\]\.w/);
  const still = script.slice(script.indexOf("'/api/frame?id='"));
  assert.match(still.slice(0, 220), /PRESETS\[preset\]\.q[\s\S]{0,60}PRESETS\[preset\]\.w/);
});

// Narrower buys frame rate and bandwidth together; lower quality only buys
// bandwidth. A preset that dropped detail without dropping pixels would be the
// weaker half of the trade.
test('the cheaper presets are narrower, not just softer', () => {
  const script = touchScript();
  const widths = (script.match(/w: (\d+)/g) || []).map((m) => Number(m.slice(3)));
  assert.deepStrictEqual(widths, [640, 960, 1600], 'width must climb with quality');
});

// ---- pinch and pan ----------------------------------------------------------
//
// The mapping needs no changes for the transform, because touchToPanel measures
// against getBoundingClientRect and that already reports the transformed box.
// These check the arithmetic holds for a box that has been scaled and moved.

test('a zoomed box still maps the centre to the centre', () => {
  // scale(2) about the centre: twice the size, origin pulled out by half.
  const zoomed = { left: -200, top: -150, width: 800, height: 600 };
  const at = touchToPanel({ x: 200, y: 150 }, zoomed, NAT, RECT);
  assert.ok(Math.abs(at.x - RECT.width / 2) <= 1, `x was ${at.x}`);
  assert.ok(Math.abs(at.y - RECT.height / 2) <= 1, `y was ${at.y}`);
});

test('a panned box shifts the mapping by the same amount', () => {
  const panned = { left: 100, top: 50, width: 400, height: 300 };
  const at = touchToPanel({ x: 300, y: 200 }, panned, NAT, RECT);
  assert.ok(Math.abs(at.x - RECT.width / 2) <= 1, `x was ${at.x}`);
  assert.ok(Math.abs(at.y - RECT.height / 2) <= 1, `y was ${at.y}`);
});

// Two fingers zoom, one finger is input. The split is what keeps them apart.
test('a second finger turns the gesture into a pinch, not a drag', () => {
  const script = touchScript();
  const down = script.slice(script.indexOf("addEventListener('pointerdown'"));
  assert.match(down, /if \(pointers\.size === 2\)/);
  // The first finger already pressed; leaving it down would strand the panel
  // holding a mouse button for the whole gesture.
  assert.match(down, /send\('up', ev\)/);
});

test('a gesture does not also send a release when the fingers lift', () => {
  const script = touchScript();
  const up = script.slice(script.indexOf("img.addEventListener('pointerup'"));
  assert.match(up, /if \(!wasGesture\) send\('up'/);
});

test('pointercancel releases the gesture too', () => {
  assert.match(touchScript(), /addEventListener\('pointercancel', lift\)/);
});

test('the zoom is clamped at both ends', () => {
  const script = touchScript();
  assert.match(script, /Math\.min\(8, Math\.max\(1,/);
});

// A zoom belongs to the panel it was set on.
test('switching panels resets the view', () => {
  const attach = touchScript().slice(touchScript().indexOf('function attach('));
  assert.match(attach, /resetView\(\)/);
});

// ---- shortcuts --------------------------------------------------------------

// navigator.clipboard needs a secure context and this surface is plain HTTP, so
// a paste event is the only way at the tablet's clipboard.
test('paste reads the clipboard from the event, not the clipboard API', () => {
  const script = touchScript();
  const h = script.slice(script.indexOf("addEventListener('paste'"));
  assert.match(h, /ev\.clipboardData/);
  assert.match(h, /kind: 'paste', text: data/);
  assert.ok(
    !/navigator\.clipboard\.\w+\(/.test(script),
    'the clipboard API is unavailable on a plain-HTTP origin'
  );
});

// It must never land in the field, for the same reason typing must not.
test('pasted text is not written into the field', () => {
  const h = touchScript().slice(touchScript().indexOf("addEventListener('paste'"));
  assert.match(h, /ev\.preventDefault\(\)/);
});

// Chords for these do nothing when injected; they go over as commands instead.
test('clipboard chords are sent as edit commands', () => {
  const script = touchScript();
  assert.match(
    script,
    /var EDIT_CHORDS = \{ a: 'selectAll', c: 'copy', x: 'cut', z: 'undo' \}/
  );
  const kd = script.slice(script.indexOf("fieldEl.addEventListener('keydown'"));
  assert.match(kd, /kind: 'edit', command: command/);
});

// Sending both would paste twice, from two different clipboards.
test('Cmd+V is not also sent as an edit command', () => {
  const script = touchScript();
  assert.ok(!/v: 'paste'/.test(script), 'the paste handler already covers it');
});

// ---- reconnection -----------------------------------------------------------
//
// The app restarts and the stream socket dies with it. The <img> cannot notice:
// a multipart stream that ended looks exactly like one that has gone quiet,
// which is the ordinary state of a still dashboard. Polling recovered by itself
// because every still is a fresh request; the stream had no path at all.

test('the status poll is the heartbeat, and reconnects when it comes back', () => {
  const script = touchScript();
  const rs = script.slice(script.indexOf('function readStatus'));
  assert.match(rs, /if \(!serverUp\)/, 'it must notice the server returning');
  assert.match(rs, /serverUp = true;[\s\S]{0,500}attach\(id\)/, 'and re-attach');
});

// A half-started app answering 500 is as much "not ready" as a closed port.
test('a non-ok status counts as down, not as up', () => {
  const rs = touchScript().slice(touchScript().indexOf('function readStatus'));
  assert.match(rs, /if \(!r\.ok\) throw/);
});

test('it polls faster while the server is down', () => {
  const script = touchScript();
  assert.match(script, /var STATUS_MS = 3000/);
  assert.match(script, /var RETRY_MS = 1500/);
  const rs = script.slice(script.indexOf('function readStatus'));
  const c = rs.slice(rs.indexOf('.catch('));
  assert.match(c, /schedulePoll\(RETRY_MS\)/, 'the failure path retries sooner');
});

test('the surface says it is reconnecting rather than showing a frozen picture', () => {
  const rs = touchScript().slice(touchScript().indexOf('function readStatus'));
  assert.match(rs, /setMode\('reconnecting', 'dead'\)/);
});

// Before the probe settles an error means the browser cannot stream, and the
// fallback owns it. After it settles the stream worked and then stopped, which
// is a different thing entirely.
test('an error after settling reconnects instead of falling back', () => {
  const script = touchScript();
  const attach = script.slice(script.indexOf('function attach('));
  assert.match(attach, /if \(settled\) return reconnectSoon\(mine\);/);
});

// If the app is genuinely gone this would spin, and the heartbeat is the thing
// that recovers properly.
test('only one reconnect is ever in flight', () => {
  const r = touchScript().slice(touchScript().indexOf('function reconnectSoon'));
  assert.match(r, /if \(mine !== session \|\| reconnectTimer\) return;/);
  assert.match(r, /reconnectTimer = null;/, 'and it clears itself');
});
