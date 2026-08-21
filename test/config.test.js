// node --test test/
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { validateConfig, withDefaults, loadConfig } = require('../src/config');

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

test('a shared partition is rejected', () => {
  const c = good();
  c.views[0].partition = 'persist:same';
  c.views[1].partition = 'persist:same';
  assert.match(validateConfig(c).join(), /used by another view/);
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
const { saveLayout } = require('../src/config');

function tmpConfig(body) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-')), 'wall.json');
  fs.writeFileSync(f, JSON.stringify(body, null, 2));
  return f;
}

test('saveLayout writes back grid and zoom', () => {
  const f = tmpConfig(good());
  saveLayout(f, [
    { id: 'a', grid: { x: 10, y: 20, width: 300, height: 400 }, zoom: 0.6666666 },
    { id: 'b', grid: { x: 0, y: 0, width: 100, height: 100 }, zoom: 1 },
  ]);
  const out = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual(out.views[0].grid, { x: 10, y: 20, width: 300, height: 400 });
  assert.strictEqual(out.views[0].zoom, 0.667);
});

test('saveLayout does not write defaults into the file', () => {
  const f = tmpConfig(good());
  saveLayout(f, [{ id: 'a', grid: { x: 0, y: 0, width: 10, height: 10 }, zoom: 1 }]);
  const out = JSON.parse(fs.readFileSync(f, 'utf8'));
  // These were never in the authored file and must not appear just because the
  // running config filled them in.
  assert.ok(!('escToGrid' in out));
  assert.ok(!('kiosk' in out.wall));
  assert.ok(!('partition' in out.views[0]));
});

test('saveLayout leaves unrelated keys and unmatched views alone', () => {
  const base = good();
  base.views[0].label = 'keep me';
  base.idleReturnMs = 999;
  const f = tmpConfig(base);
  saveLayout(f, [{ id: 'a', grid: { x: 1, y: 2, width: 3, height: 4 }, zoom: 2 }]);
  const out = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(out.views[0].label, 'keep me');
  assert.strictEqual(out.idleReturnMs, 999);
  assert.deepStrictEqual(out.views[1].grid, good().views[1].grid); // untouched
});

test('saveLayout refuses a file with no matching ids', () => {
  const f = tmpConfig(good());
  assert.throws(
    () => saveLayout(f, [{ id: 'nope', grid: { x: 0, y: 0, width: 1, height: 1 }, zoom: 1 }]),
    /no matching view ids/
  );
});

test('a saved layout round-trips back through validation', () => {
  const f = tmpConfig(good());
  saveLayout(f, [
    { id: 'a', grid: { x: 0, y: 0, width: 2000, height: 1200 }, zoom: 1.04 },
    { id: 'b', grid: { x: 2000, y: 0, width: 1840, height: 1200 }, zoom: 0.9 },
  ]);
  const c = loadConfig(f);
  assert.strictEqual(c.views[0].grid.width, 2000);
  assert.strictEqual(c.views[1].zoom, 0.9);
});
