// node --test test/
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { validateConfig, withDefaults, loadConfig, saveViews } = require('../src/config');

const good = () => ({
  wall: { width: 3840, height: 2160 },
  views: [
    { id: 'a', url: 'https://x/1', grid: { x: 0, y: 0, width: 1920, height: 1080 } },
    { id: 'b', url: 'https://x/2', grid: { x: 1920, y: 0, width: 1920, height: 1080 } },
  ],
});

test('a well-formed config has no problems', () => {
  assert.deepStrictEqual(validateConfig(good()), []);
});

test('the committed production config is valid', () => {
  const c = loadConfig(path.join(__dirname, '..', 'config', 'wall.json'));
  assert.strictEqual(c.views.length, 4);
});

// config/local*.json is gitignored on purpose, so it is absent in a fresh
// checkout and in CI. Skip rather than fail there; still check it locally, where
// a broken dev config is worth catching.
test('the dev config is valid, when present', (t) => {
  const f = path.join(__dirname, '..', 'config', 'local-dev.json');
  if (!fs.existsSync(f)) return t.skip('config/local-dev.json is gitignored and absent');
  const c = loadConfig(f);
  assert.ok(c.views.length > 0);
});

test('rects outside the wall are rejected', () => {
  const c = good();
  c.views[1].grid.x = 3000; // 3000 + 1920 > 3840
  assert.match(validateConfig(c).join(), /falls outside/);
});

test('duplicate ids are rejected', () => {
  const c = good();
  c.views[1].id = 'a';
  assert.match(validateConfig(c).join(), /duplicated/);
});

// Several panels showing the same SSO-protected app should share one login
// rather than making an operator sign in once per panel.
test('a shared partition is allowed', () => {
  const c = good();
  c.views[0].partition = 'persist:same';
  c.views[1].partition = 'persist:same';
  assert.deepStrictEqual(validateConfig(c), []);
});

test('an empty view list is allowed, so a montage can start from nothing', () => {
  const c = good();
  c.views = [];
  assert.deepStrictEqual(validateConfig(c), []);
});

test('a panel with no url yet is allowed', () => {
  const c = good();
  c.views[0].url = '';
  assert.deepStrictEqual(validateConfig(c), []);
});

test('a non-string url is still rejected', () => {
  const c = good();
  c.views[0].url = 42;
  assert.match(validateConfig(c).join(), /must be a string/);
});

test('default partitions do not collide', () => {
  assert.deepStrictEqual(validateConfig(good()), []);
  const c = withDefaults(good());
  assert.strictEqual(c.views[0].partition, 'persist:forge-1');
  assert.strictEqual(c.views[1].partition, 'persist:forge-2');
});

test('missing wall dimensions are reported', () => {
  const c = good();
  delete c.wall.width;
  assert.match(validateConfig(c).join(), /wall\.width/);
});

test('a bad escToGrid value is reported', () => {
  const c = good();
  c.escToGrid = 'sometimes';
  assert.match(validateConfig(c).join(), /escToGrid/);
});

test('zero idleReturnMs is allowed (disables auto-return)', () => {
  const c = good();
  c.idleReturnMs = 0;
  assert.deepStrictEqual(validateConfig(c), []);
  assert.strictEqual(withDefaults(c).idleReturnMs, 0);
});

test('defaults are applied without clobbering explicit values', () => {
  const c = withDefaults({ ...good(), escToGrid: 'single' });
  assert.strictEqual(c.escToGrid, 'single');
  assert.strictEqual(c.wall.kiosk, true);
  assert.strictEqual(c.idleReturnMs, 240000);
  assert.strictEqual(c.views[0].zoom, 1);
});

test('a malformed file fails with a readable message, not a stack trace', () => {
  assert.throws(() => loadConfig('/nope/missing.json'), /Cannot read config/);
});

// ---- saveLayout -------------------------------------------------------------

const os = require('node:os');

function tmpConfig(body) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-')), 'wall.json');
  fs.writeFileSync(f, JSON.stringify(body, null, 2));
  return f;
}

const view = (over) => ({
  id: 'a',
  url: 'https://x/1',
  grid: { x: 0, y: 0, width: 100, height: 100 },
  zoom: 1,
  partition: 'persist:a',
  ...over,
});

test('saveViews writes back grid and zoom', () => {
  const f = tmpConfig(good());
  saveViews(f, [
    view({ id: 'a', grid: { x: 10, y: 20, width: 300, height: 400 }, zoom: 0.6666666 }),
    view({ id: 'b', partition: 'persist:b' }),
  ]);
  const out = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual(out.views[0].grid, { x: 10, y: 20, width: 300, height: 400 });
  assert.strictEqual(out.views[0].zoom, 0.667);
});

test('saveViews adds and removes panels, not just moves them', () => {
  const f = tmpConfig(good()); // starts with two views
  saveViews(f, [view({ id: 'only', url: 'https://new/', partition: 'persist:only' })]);
  let out = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(out.views.length, 1);
  assert.strictEqual(out.views[0].id, 'only');
  assert.strictEqual(out.views[0].url, 'https://new/');

  saveViews(f, [
    view({ id: 'only', partition: 'persist:only' }),
    view({ id: 'added', partition: 'persist:added' }),
    view({ id: 'more', partition: 'persist:more' }),
  ]);
  out = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual(
    out.views.map((v) => v.id),
    ['only', 'added', 'more']
  );
});

test('saveViews keeps a shared partition as written', () => {
  const f = tmpConfig(good());
  saveViews(f, [
    view({ id: 'a', partition: 'persist:shared' }),
    view({ id: 'b', partition: 'persist:shared' }),
  ]);
  const out = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(out.views[0].partition, 'persist:shared');
  assert.strictEqual(out.views[1].partition, 'persist:shared');
});

test('saveViews omits an empty label and empty allowedOrigins', () => {
  const f = tmpConfig(good());
  saveViews(f, [view({ allowedOrigins: [] })]);
  const out = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(!('label' in out.views[0]));
  assert.ok(!('allowedOrigins' in out.views[0]));
});

test('saveViews does not write top-level defaults into the file', () => {
  const f = tmpConfig(good());
  saveViews(f, [view()]);
  const out = JSON.parse(fs.readFileSync(f, 'utf8'));
  // These were never in the authored file and must not appear just because the
  // running config filled them in.
  assert.ok(!('escToGrid' in out));
  assert.ok(!('kiosk' in out.wall));
});

test('saveViews leaves unrelated top-level keys alone', () => {
  const base = good();
  base.idleReturnMs = 999;
  base.backButton = { x: 1, y: 2, width: 3, height: 4 };
  const f = tmpConfig(base);
  saveViews(f, [view({ label: 'keep me' })]);
  const out = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(out.idleReturnMs, 999);
  assert.deepStrictEqual(out.backButton, { x: 1, y: 2, width: 3, height: 4 });
  assert.strictEqual(out.views[0].label, 'keep me');
});

test('a saved layout round-trips back through validation', () => {
  const f = tmpConfig(good());
  saveViews(f, [
    view({ id: 'a', grid: { x: 0, y: 0, width: 2000, height: 1200 }, zoom: 1.04 }),
    view({
      id: 'b',
      grid: { x: 2000, y: 0, width: 1840, height: 1200 },
      zoom: 0.9,
      partition: 'persist:b',
    }),
  ]);
  const c = loadConfig(f);
  assert.strictEqual(c.views[0].grid.width, 2000);
  assert.strictEqual(c.views[1].zoom, 0.9);
});
