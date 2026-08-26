// node --test test/pages.test.js
//
// The three generated pages. escapeHtml is the only thing between an
// operator-supplied label or URL and a data: document, and it had no test while
// it lived in main.js.
const test = require('node:test');
const assert = require('node:assert');
const {
  escapeHtml,
  dataUrl,
  placeholderPage,
  unrecoverablePage,
  fatalPage,
} = require('../src/pages');

// ---- escaping ---------------------------------------------------------------

test('escapeHtml covers all five, including both quote characters', () => {
  assert.strictEqual(
    escapeHtml(`&<>"'`),
    '&amp;&lt;&gt;&quot;&#39;',
    'a missed quote is what turns an attribute into a new one'
  );
});

test('escapeHtml escapes the ampersand first, so nothing is double-decoded', () => {
  assert.strictEqual(escapeHtml('&lt;'), '&amp;lt;');
});

test('escapeHtml coerces rather than throwing on a non-string', () => {
  assert.strictEqual(escapeHtml(7), '7');
  assert.strictEqual(escapeHtml(null), 'null');
  assert.strictEqual(escapeHtml(undefined), 'undefined');
});

// The label and the url both come from the layout editor's inspector, which any
// administrator can type into, and both land in a data: document.
test('a script tag in a label cannot escape into the placeholder page', () => {
  const html = placeholderPage({ id: 'a', label: '<script>alert(1)</script>' });
  assert.ok(!html.includes('<script>'), 'raw tag must not survive');
  assert.match(html, /&lt;script&gt;/);
});

test('a quote in a url cannot break out of the diagnostic page', () => {
  const html = unrecoverablePage(
    { id: 'a', label: 'Panel', url: `https://x/"><img src=x onerror=alert(1)>` },
    { lastError: 'ERR', round: 0 },
    { retryMs: 0 }
  );
  assert.ok(!html.includes('<img'), 'raw tag must not survive');
  assert.match(html, /&quot;&gt;&lt;img/);
});

test('the error text from a failed load is escaped too', () => {
  const html = unrecoverablePage(
    { id: 'a', url: 'https://x/' },
    { lastError: '<b>boom</b>', round: 1 },
    { retryMs: 0 }
  );
  assert.ok(!html.includes('<b>'));
});

test('the fatal page escapes both the message and the config path', () => {
  const html = fatalPage('Wallwright', 'bad <config>', `/tmp/"><x>/wall.json`);
  assert.ok(!html.includes('<config>'));
  assert.ok(!html.includes('"><x>'));
  assert.match(html, /Wallwright cannot start/);
});

// ---- content ----------------------------------------------------------------

test('the placeholder falls back from label to id, and says how to fix it', () => {
  assert.match(placeholderPage({ id: 'panel-2', label: '' }), /panel-2/);
  assert.match(placeholderPage({ id: 'panel-2', label: 'Line 3' }), /Line 3/);
  assert.match(placeholderPage({ id: 'a' }), /layout edit mode/);
});

// The retry line is the difference between "this is being handled" and "this is
// stuck", which is the thing someone looking at the wall needs to know.
test('the diagnostic page says whether it will try again', () => {
  const v = { id: 'a', url: 'https://x/' };
  const w = { lastError: 'ERR_FAILED', round: 2 };
  assert.match(unrecoverablePage(v, w, { retryMs: 600000 }), /Retrying every 10 minutes/);
  assert.match(unrecoverablePage(v, w, { retryMs: 0 }), /Not retrying/);
});

test('the diagnostic page counts rounds from one, not zero', () => {
  const html = unrecoverablePage(
    { id: 'a', url: 'https://x/' },
    { lastError: 'e', round: 0 },
    { retryMs: 0 }
  );
  assert.match(html, /Gave up after 1 rounds/);
});

test('a panel with no url says so rather than showing an empty line', () => {
  const html = unrecoverablePage(
    { id: 'a', url: '' },
    { lastError: 'e', round: 0 },
    { retryMs: 0 }
  );
  assert.match(html, /\(no URL set\)/);
});

test('an unknown error still produces a readable page', () => {
  const html = unrecoverablePage({ id: 'a', url: 'x' }, { round: 0 }, { retryMs: 0 });
  assert.match(html, /unknown error/);
});

// now is injected so the page is a pure function of its inputs.
test('the time on the diagnostic page comes from the caller', () => {
  const when = new Date(2026, 7, 25, 13, 24, 29);
  const html = unrecoverablePage(
    { id: 'a', url: 'x' },
    { lastError: 'e', round: 0 },
    { retryMs: 0, now: when }
  );
  assert.match(
    html,
    new RegExp(when.toLocaleTimeString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  );
});

// ---- the data: wrapper ------------------------------------------------------

test('dataUrl produces something loadURL will accept, with no raw markup left', () => {
  const url = dataUrl('<body>hi & bye</body>');
  assert.match(url, /^data:text\/html;charset=utf-8,/);
  assert.ok(!url.includes('<'), 'markup must be percent-encoded, not inline');
  assert.strictEqual(decodeURIComponent(url.split(',')[1]), '<body>hi & bye</body>');
});
