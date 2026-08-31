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
const { statusPage } = require('../src/control-page');

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
