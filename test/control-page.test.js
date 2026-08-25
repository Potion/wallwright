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
  const served = ['/api/status', '/api/preset', '/api/panel', '/api/promote', '/api/reload'];
  for (const p of new Set(paths)) assert.ok(served.includes(p), `${p} is not a served route`);
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
