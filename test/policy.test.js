// node --test test/policy.test.js
//
// src/policy.js decides what a panel may load and where it may navigate. It had
// no tests at all while it lived in main.js, despite being the code that decides
// whether a navigation or a popup is blocked, and it is what `allowedOrigins`
// will be judged on once the real domains are known.
const test = require('node:test');
const assert = require('node:assert');
const {
  PANEL_SCHEMES,
  originOf,
  schemeOf,
  isOriginAllowed,
  isPermissionAllowed,
  panelUrlVerdict,
  partitionVerdict,
  rectVerdict,
} = require('../src/policy');

// ---- parsing ----------------------------------------------------------------

test('originOf and schemeOf return null rather than throwing on rubbish', () => {
  for (const bad of ['', 'not a url', '///', 'http://', undefined, null, 7]) {
    assert.strictEqual(originOf(bad), null, `originOf(${JSON.stringify(bad)})`);
    assert.strictEqual(schemeOf(bad), null, `schemeOf(${JSON.stringify(bad)})`);
  }
});

test('originOf drops the path, so one page does not authorise a whole host', () => {
  assert.strictEqual(
    originOf('https://sso.example.com/login?next=/x'),
    'https://sso.example.com'
  );
});

// A different port or scheme is a different origin, which is what makes this a
// useful guard rather than a hostname check.
test('origin includes scheme and port', () => {
  assert.strictEqual(originOf('https://x.example:8443/a'), 'https://x.example:8443');
  assert.notStrictEqual(originOf('http://x.example/'), originOf('https://x.example/'));
});

// ---- allowedOrigins ---------------------------------------------------------

test('an empty or absent list is permissive, which is the shipped default', () => {
  for (const list of [undefined, null, [], 'not an array']) {
    assert.strictEqual(isOriginAllowed('https://anywhere.example/', list), true);
  }
});

test('a populated list admits its own origins and refuses everything else', () => {
  const list = ['https://sso.example.com', 'https://app.example.com'];
  assert.strictEqual(isOriginAllowed('https://sso.example.com/login', list), true);
  assert.strictEqual(isOriginAllowed('https://app.example.com/d/1?x=2', list), true);
  assert.strictEqual(isOriginAllowed('https://evil.example.com/', list), false);
  // A subdomain is not the same origin. This is the case worth knowing about
  // before allowedOrigins is scoped to the real domains.
  assert.strictEqual(isOriginAllowed('https://other.sso.example.com/', list), false);
  // Nor is the same host over plain http.
  assert.strictEqual(isOriginAllowed('http://sso.example.com/', list), false);
});

test('an unparseable url is refused once a list is set', () => {
  assert.strictEqual(isOriginAllowed('javascript:alert(1)', ['https://x.example']), false);
});

// ---- what a panel may be pointed at ----------------------------------------

test('http and https are the only panel schemes', () => {
  assert.deepStrictEqual(PANEL_SCHEMES, ['http:', 'https:']);
  assert.strictEqual(panelUrlVerdict('https://example.com/').ok, true);
  // http matters: the dev harness and the soak both serve panels over it.
  assert.strictEqual(panelUrlVerdict('http://localhost:8787/soak-static.html').ok, true);
});

// Each of these was accepted before, String()-coerced and handed to loadURL.
test('the schemes that make a panel do something it should not are refused', () => {
  for (const url of [
    'file:///etc/passwd',
    'file://C:/Users/proto/AppData',
    'javascript:alert(document.cookie)',
    'data:text/html,<h1>hi',
    'chrome://settings',
    'devtools://devtools/bundled/inspector.html',
    'about:blank',
  ]) {
    const v = panelUrlVerdict(url);
    assert.strictEqual(v.ok, false, `${url} must be refused`);
    assert.match(v.reason, /not allowed for a panel/);
  }
});

// An empty url is how a placeholder panel is expressed, so it must not be an
// error: the editor creates every new panel that way.
test('an absent or empty url is allowed, because it means the placeholder', () => {
  for (const url of [undefined, null, '']) {
    assert.strictEqual(panelUrlVerdict(url).ok, true, JSON.stringify(url));
  }
});

test('a non-string url is refused by type, not coerced', () => {
  assert.match(panelUrlVerdict(7).reason, /must be a string/);
  assert.match(panelUrlVerdict({}).reason, /must be a string/);
});

test('a string that is not a url at all is refused', () => {
  assert.match(panelUrlVerdict('example.com').reason, /not a URL/);
});

// ---- partitions -------------------------------------------------------------

// The whole point of the partition in this app is that a login survives a
// rebuild. A name without the prefix is an in-memory session, so the symptom is
// a panel that signs itself out later, a long way from the cause.
test('a partition must carry the persist: prefix', () => {
  assert.strictEqual(partitionVerdict('persist:wall-1').ok, true);
  const v = partitionVerdict('wall-1');
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /persist:/);
});

test('an absent partition is fine, an empty or non-string one is not', () => {
  assert.strictEqual(partitionVerdict(undefined).ok, true);
  assert.strictEqual(partitionVerdict(null).ok, true);
  assert.match(partitionVerdict('').reason, /non-empty string/);
  assert.match(partitionVerdict(7).reason, /non-empty string/);
});

// Panels may deliberately share a partition, so nothing here may treat a
// repeated name as a problem.
test('two panels may name the same partition', () => {
  assert.strictEqual(partitionVerdict('persist:shared-sso').ok, true);
  assert.strictEqual(partitionVerdict('persist:shared-sso').ok, true);
});

// ---- permissions ------------------------------------------------------------

// Measured (npm run probe:perm): with no handler a session grants microphone,
// camera and notifications silently, and leaves geolocation pending forever. So
// the default here has to be deny, and that is the opposite polarity to
// allowedOrigins, which is permissive when empty.
test('an absent or empty list allows nothing, unlike allowedOrigins', () => {
  for (const list of [undefined, null, [], 'not an array']) {
    assert.strictEqual(isPermissionAllowed('media', list), false, JSON.stringify(list));
  }
  // The contrast, asserted rather than described, because the two functions sit
  // next to each other and read alike.
  assert.strictEqual(isOriginAllowed('https://anywhere.example/', []), true);
});

test('a permission is allowed only when the panel names it', () => {
  const list = ['geolocation'];
  assert.strictEqual(isPermissionAllowed('geolocation', list), true);
  assert.strictEqual(isPermissionAllowed('media', list), false);
  assert.strictEqual(isPermissionAllowed('notifications', list), false);
});

// These are Chromium's strings, seen on 43.4.1 and again on 44.1.0, not names
// this app invents. One
// getUserMedia call for audio and one for video both arrive as 'media', so there
// is no way to allow the microphone without also allowing the camera.
test("the permission strings are Chromium's, and media covers both", () => {
  const list = ['media', 'geolocation', 'notifications', 'web-app-installation'];
  for (const p of list) assert.strictEqual(isPermissionAllowed(p, list), true, p);
  assert.strictEqual(isPermissionAllowed('speaker-selection', list), false);
  assert.strictEqual(
    isPermissionAllowed('MEDIA', list),
    false,
    'match is exact, not case-folded'
  );
});

// ---- rects from the renderer ------------------------------------------------

test('a rect needs four finite numbers', () => {
  assert.strictEqual(rectVerdict({ x: 0, y: 0, width: 100, height: 50 }).ok, true);
  // Negatives are the clamp's job, not this one's.
  assert.strictEqual(rectVerdict({ x: -10, y: -10, width: 1, height: 1 }).ok, true);
});

test('a rect field that is not a finite number is refused before it becomes NaN', () => {
  for (const [key, value] of [
    ['x', '10'],
    ['y', null],
    ['width', NaN],
    ['height', Infinity],
    ['width', undefined],
  ]) {
    const rect = { x: 0, y: 0, width: 10, height: 10, [key]: value };
    const v = rectVerdict(rect);
    assert.strictEqual(v.ok, false, `${key}=${String(value)} must be refused`);
    assert.match(v.reason, new RegExp(`rect.${key}`));
  }
});

test('a missing or non-object rect is refused', () => {
  for (const rect of [undefined, null, 'x', 7]) {
    assert.match(rectVerdict(rect).reason, /must be an object/);
  }
});
