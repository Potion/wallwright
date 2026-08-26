// node --test test/
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const {
  validateConfig,
  withDefaults,
  loadConfig,
  unknownKeys,
  saveViews,
} = require('../src/config');

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
  assert.strictEqual(c.views[0].partition, 'persist:wall-1');
  assert.strictEqual(c.views[1].partition, 'persist:wall-2');
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

test('wall.safeAreaTop accepts "auto", a number, or nothing', () => {
  const c = good();
  assert.deepStrictEqual(validateConfig(c), []); // absent
  c.wall.safeAreaTop = 'auto';
  assert.deepStrictEqual(validateConfig(c), []);
  c.wall.safeAreaTop = 38;
  assert.deepStrictEqual(validateConfig(c), []);
  c.wall.safeAreaTop = 0;
  assert.deepStrictEqual(validateConfig(c), []);
});

test('a bad wall.safeAreaTop is reported', () => {
  const c = good();
  c.wall.safeAreaTop = 'notch';
  assert.match(validateConfig(c).join(), /safeAreaTop/);
  c.wall.safeAreaTop = -5;
  assert.match(validateConfig(c).join(), /safeAreaTop/);
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
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wallwright-')), 'wall.json');
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

// The wall boots from this file, so it is written to a sibling and renamed rather
// than truncated in place. Assert the temp file is not left behind, which is the
// only externally visible trace of the mechanism.
test('saveViews leaves no temp file beside the config', () => {
  const f = tmpConfig(good());
  saveViews(f, [view({ id: 'a' })]);
  const siblings = fs.readdirSync(path.dirname(f));
  assert.deepStrictEqual(siblings, ['wall.json']);
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

// ---- presets ----------------------------------------------------------------

const withPresets = () => ({
  ...good(),
  presets: [
    {
      id: 'overview',
      name: 'Overview',
      views: [{ id: 'a', url: 'https://x/1', grid: { x: 0, y: 0, width: 100, height: 100 } }],
    },
  ],
});

test('a config with presets validates', () => {
  assert.deepStrictEqual(validateConfig(withPresets()), []);
});

test('presets are optional', () => {
  assert.deepStrictEqual(validateConfig(good()), []);
  assert.deepStrictEqual(withDefaults(good()).presets, []);
});

test('duplicate preset ids are rejected', () => {
  const c = withPresets();
  c.presets.push({ ...c.presets[0] });
  assert.match(validateConfig(c).join(), /duplicated/);
});

// The same rules as the live views, rather than a second set that could drift.
test("a preset's views are validated like the live ones", () => {
  const c = withPresets();
  c.presets[0].views[0].grid = { x: 0, y: 0, width: 99999, height: 100 };
  assert.match(validateConfig(c).join(), /presets\[0\].*falls outside/);
});

test('a preset with a non-array views is reported', () => {
  const c = withPresets();
  c.presets[0].views = 'nope';
  assert.match(validateConfig(c).join(), /presets\[0\]\.views must be an array/);
});

test('presets survive defaults, and their views get defaults too', () => {
  const c = withDefaults(withPresets());
  assert.strictEqual(c.presets.length, 1);
  assert.strictEqual(c.presets[0].views[0].zoom, 1);
  assert.strictEqual(c.presets[0].views[0].partition, 'persist:wall-1');
});

test('saveViews writes presets alongside the live views', () => {
  const f = tmpConfig(good());
  saveViews(f, [view()], [{ id: 'p1', name: 'One', views: [view({ id: 'z' })] }]);
  const out = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(out.presets.length, 1);
  assert.strictEqual(out.presets[0].name, 'One');
  assert.strictEqual(out.presets[0].views[0].id, 'z');
});

test('saveViews does not add a presets key when there are none', () => {
  const f = tmpConfig(good());
  saveViews(f, [view()], []);
  assert.ok(!('presets' in JSON.parse(fs.readFileSync(f, 'utf8'))));
});

test('saveViews removes presets once the last one is deleted', () => {
  const f = tmpConfig(withPresets());
  saveViews(f, [view()], []);
  assert.ok(!('presets' in JSON.parse(fs.readFileSync(f, 'utf8'))));
});

test('a saved preset round-trips back through validation', () => {
  const f = tmpConfig(good());
  saveViews(f, [view()], [{ id: 'p1', name: 'One', views: [view({ id: 'z' })] }]);
  const c = loadConfig(f);
  assert.strictEqual(c.presets[0].views[0].id, 'z');
});

// ---- control surface --------------------------------------------------------

test('control defaults to disabled and loopback', () => {
  const c = withDefaults(good());
  assert.strictEqual(c.control.port, 0);
  assert.strictEqual(c.control.host, '127.0.0.1');
});

test('a control port is accepted', () => {
  const c = good();
  c.control = { port: 8080 };
  assert.deepStrictEqual(validateConfig(c), []);
  // The host default survives a partial control block.
  assert.strictEqual(withDefaults(c).control.host, '127.0.0.1');
});

test('a bad control port is reported', () => {
  const c = good();
  for (const port of [70000, -1, 'eighty', 1.5]) {
    c.control = { port };
    assert.match(validateConfig(c).join(), /control\.port/, `port ${port}`);
  }
});

test('a non-object control block is reported', () => {
  const c = good();
  c.control = 8080;
  assert.match(validateConfig(c).join(), /control must be an object/);
});

// ---- upkeep intervals -------------------------------------------------------

test('refreshMs and recycleMs are per panel and optional', () => {
  const c = good();
  c.views[0].refreshMs = 300000;
  c.views[0].recycleMs = 3600000;
  assert.deepStrictEqual(validateConfig(c), []);
});

test('negative intervals are reported', () => {
  const c = good();
  c.views[0].refreshMs = -1;
  assert.match(validateConfig(c).join(), /refreshMs/);
  c.views[0].refreshMs = 0;
  c.views[0].recycleMs = -5;
  assert.match(validateConfig(c).join(), /recycleMs/);
});

test('intervals round-trip through saveViews, and zero is omitted', () => {
  const f = tmpConfig(good());
  saveViews(f, [view({ refreshMs: 300000, recycleMs: 0 })]);
  const out = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(out.views[0].refreshMs, 300000);
  assert.ok(!('recycleMs' in out.views[0]));
});

test('a bad memoryLimitMb is reported', () => {
  const c = good();
  c.memoryLimitMb = -10;
  assert.match(validateConfig(c).join(), /memoryLimitMb/);
});

test('a bad memoryCheckMs is reported', () => {
  // The dangerous cases are not obviously-wrong numbers but wrong *types*:
  // withDefaults uses `?? 60000`, so a string survives it, and NaN reaching
  // setInterval means a check every millisecond.
  for (const bad of ['60000', -1, NaN, null, {}]) {
    const c = good();
    c.memoryCheckMs = bad;
    assert.match(
      validateConfig(c).join('\n'),
      /memoryCheckMs/,
      `${JSON.stringify(bad)} should be rejected`
    );
  }
});

test('memoryCheckMs of 0 is legal and means the check is off', () => {
  const c = good();
  c.memoryCheckMs = 0;
  assert.deepStrictEqual(validateConfig(c), []);
  assert.strictEqual(withDefaults(c).memoryCheckMs, 0);
});

test('the upkeep and ladder settings are validated as a family', () => {
  // The table in config.js exists so that adding a knob cannot mean forgetting to
  // check it, which is exactly how memoryCheckMs stayed unchecked.
  const keys = [
    'maxDeferMs',
    'memoryHardLimitMb',
    'memoryForceAfterMs',
    'memoryHardForChecks',
    'minRecycleIntervalMs',
    'memoryReduceMinMb',
    'memoryGiveUpAfter',
    'minUptimeMs',
    'maxRelaunches',
    'presenceGraceMs',
  ];
  for (const key of keys) {
    const c = good();
    c[key] = -1;
    assert.match(validateConfig(c).join('\n'), new RegExp(key), `${key} rejects -1`);
    const s = good();
    s[key] = '900';
    assert.match(validateConfig(s).join('\n'), new RegExp(key), `${key} rejects a string`);
    const ok = good();
    ok[key] = 0;
    assert.deepStrictEqual(validateConfig(ok), [], `${key} accepts 0 as off`);
  }
});

test('memoryRelaunch is a boolean, and defaults to off', () => {
  const c = good();
  c.memoryRelaunch = 'yes';
  assert.match(validateConfig(c).join('\n'), /memoryRelaunch/);
  assert.strictEqual(withDefaults(good()).memoryRelaunch, false);
});

// The defaults coerce these with `!!` or `??`, so a quoted "false" used to read as
// true. For idleResetUrls that is not cosmetic: it turns on a scheduled reload of
// every panel a few minutes after the operator stops typing.
test('the flags reject a quoted boolean rather than reading it as true', () => {
  for (const key of [
    'showHotspotHint',
    'hideInactiveWhenActive',
    'idleResetUrls',
    'memoryRelaunch',
  ]) {
    const c = good();
    c[key] = 'false';
    assert.match(validateConfig(c).join('\n'), new RegExp(key), `${key} rejects "false"`);

    const ok = good();
    ok[key] = true;
    assert.deepStrictEqual(validateConfig(ok), [], `${key} accepts a real boolean`);
  }
});

// transitionMs and escDoubleMs predate the NON_NEGATIVE table. A NaN in either is
// silent: no animation, or double-Esc that never fires.
test('transitionMs and escDoubleMs are numbers >= 0', () => {
  for (const key of ['transitionMs', 'escDoubleMs']) {
    const c = good();
    c[key] = 'soon';
    assert.match(validateConfig(c).join('\n'), new RegExp(key), `${key} rejects a string`);

    const ok = good();
    ok[key] = 0;
    assert.deepStrictEqual(validateConfig(ok), [], `${key} accepts 0`);
  }
});

// backButton reaches setBounds() by way of scaleRect(). It is also the only way
// out of active mode besides Esc, so NaN bounds strand an administrator.
test('backButton is checked as a rect, not just passed through', () => {
  const notObject = good();
  notObject.backButton = 7;
  assert.match(validateConfig(notObject).join('\n'), /backButton must be an object/);

  const badWidth = good();
  badWidth.backButton = { x: 24, y: 24, width: 0, height: 56 };
  assert.match(validateConfig(badWidth).join('\n'), /backButton.width must be a number > 0/);

  const negative = good();
  negative.backButton = { x: -5, y: 24, width: 176, height: 56 };
  assert.match(validateConfig(negative).join('\n'), /backButton.x must be a number >= 0/);

  const ok = good();
  ok.backButton = { x: 24, y: 24, width: 176, height: 56 };
  assert.deepStrictEqual(validateConfig(ok), []);
});

test('allowedPermissions must be an array of strings', () => {
  const notArray = good();
  notArray.views[0].allowedPermissions = 'media';
  assert.match(validateConfig(notArray).join('\n'), /allowedPermissions must be an array/);

  const notStrings = good();
  notStrings.views[0].allowedPermissions = ['media', 7];
  assert.match(
    validateConfig(notStrings).join('\n'),
    /allowedPermissions must contain only strings/
  );

  const ok = good();
  ok.views[0].allowedPermissions = ['geolocation'];
  assert.deepStrictEqual(validateConfig(ok), []);

  // Absent is the normal case and must stay valid: it means no permissions.
  assert.deepStrictEqual(validateConfig(good()), []);
});

// ---- unknown keys -----------------------------------------------------------

// A typo used to parse, validate and do nothing, in silence. Warnings rather than
// problems on purpose: these files are hand-edited on a show floor, and refusing
// to boot over a stray key is a worse failure than ignoring one.
test('unknownKeys names a typo at every level, and stays quiet on a clean config', () => {
  assert.deepStrictEqual(unknownKeys(good()), []);

  const c = good();
  c.memoryLimitMB = 2000; // the real key is memoryLimitMb
  c.wall.backgroundColour = '#000';
  c.views[1].refreshMS = 5000;
  assert.deepStrictEqual(unknownKeys(c).sort(), [
    'memoryLimitMB',
    'views[1].refreshMS',
    'wall.backgroundColour',
  ]);
});

// _comment, _memoryBaseline and _soak are already used this way in config/, and
// saveViews preserves them, so the convention has to be honoured here too.
test('an underscore prefix means documentation, at every level', () => {
  const c = good();
  c._memoryBaseline = { status: 'NOT MEASURED YET' };
  c._comment = 'why this wall is shaped like this';
  c.wall._note = 'portrait';
  c.views[0]._why = 'the control arm';
  assert.deepStrictEqual(unknownKeys(c), []);
});

test('unknownKeys walks presets as well as the live views', () => {
  const c = good();
  c.presets = [{ id: 'solo', name: 'Solo', views: [{ id: 'a', gird: {} }], extra: 1 }];
  assert.deepStrictEqual(unknownKeys(c).sort(), [
    'presets[0].extra',
    'presets[0].views[0].gird',
  ]);
});

test('every committed config is free of unknown keys', () => {
  const dir = path.join(__dirname, '..', 'config');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.deepStrictEqual(unknownKeys(c), [], `${f} has no unknown keys`);
  }
});

test('the watchdog block is validated and merged over the defaults', () => {
  const bad = good();
  bad.watchdog = { maxAttempts: 'five' };
  assert.match(validateConfig(bad).join('\n'), /watchdog.maxAttempts/);

  const notAnObject = good();
  notAnObject.watchdog = 7;
  assert.match(validateConfig(notAnObject).join('\n'), /watchdog must be an object/);

  const partial = good();
  partial.watchdog = { maxAttempts: 2 };
  const w = withDefaults(partial).watchdog;
  assert.strictEqual(w.maxAttempts, 2, 'the override wins');
  assert.strictEqual(w.maxDelayMs, 30000, 'the rest still defaults');
  assert.strictEqual(w.escalateToRecycle, true);
});

test('neverRecycle is per panel, boolean, and round-trips only when set', () => {
  const c = good();
  c.views[0].neverRecycle = 'sometimes';
  assert.match(validateConfig(c).join('\n'), /neverRecycle/);

  const ok = good();
  ok.views[0].neverRecycle = true;
  assert.deepStrictEqual(validateConfig(ok), []);
  const d = withDefaults(ok);
  assert.strictEqual(d.views[0].neverRecycle, true);
  assert.strictEqual(d.views[1].neverRecycle, false, 'defaults to off');

  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wallwright-')), 'wall.json');
  fs.writeFileSync(f, JSON.stringify(ok));
  saveViews(f, d.views);
  const written = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(written.views[0].neverRecycle, true);
  assert.ok(
    !('neverRecycle' in written.views[1]),
    'the default is not written back as if it had been authored'
  );
});
