'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const builder = yaml.load(fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8'));

// ---- what ships -------------------------------------------------------------
//
// The real assertion is `src/dev/asar-check.js`, which reads a built artifact and
// runs in the build workflows. These are the fast guard: they run on every push
// on every runner, and they fail the moment somebody edits the packaging config
// in a way that would let the dev harness ship, rather than at the next tagged
// build.
//
// Why this matters more than tidiness: `src/dev/` holds a mock server that binds a
// port, probes that disable web security, and the self-test. None of that belongs
// on a show floor machine inside a customer's building.

test('the dev harness is excluded from the package', () => {
  const files = builder.files;
  assert.ok(Array.isArray(files), 'electron-builder.yml must have a files array');
  assert.ok(
    files.includes('!src/dev/**'),
    `electron-builder.yml files must exclude src/dev/**. Got: ${JSON.stringify(files)}`
  );
});

test('the exclusion comes after the include that would otherwise match it', () => {
  // Order is load-bearing in electron-builder's glob list: `src/**/*` pulls
  // src/dev in, and only a later negation takes it back out. Swapping the two
  // lines silently ships the harness, which is exactly the kind of edit that
  // looks harmless in review.
  const files = builder.files;
  const include = files.indexOf('src/**/*');
  const exclude = files.indexOf('!src/dev/**');
  assert.ok(include >= 0, 'expected src/**/* in the files list');
  assert.ok(exclude > include, 'the !src/dev/** negation must come after src/**/*');
});

test('the default config still ships', () => {
  // The app copies this into userData on first run. Dropping it does not leak
  // anything; it produces an exhibit that cannot start, which is the other way
  // packaging goes wrong.
  assert.ok(
    builder.files.includes('config/wall.json'),
    'config/wall.json must be in the files list'
  );
});

test('asar packing is on', () => {
  // asar-check.js reads an app.asar. If packing is ever turned off, that check
  // silently finds no archive to inspect, so the two belong together.
  assert.strictEqual(builder.asar, true, 'asar must be true');
});

// ---- the coverage report's blind spot ---------------------------------------

test('every shipped module has a test file, or is a known exception', () => {
  // `npm run coverage` reports a total over the files the test process actually
  // loaded, so a new module with no tests at all does not show up as 0%: it does
  // not show up. docs/validation.md calls that "a lie of omission" and puts true
  // coverage of shipped source at 38% against a reported 98%.
  //
  // The coverage thresholds on `npm run coverage` guard against regression in what
  // is already tested. This guards the hole they cannot see: adding a new module
  // with no test file now fails rather than quietly diluting nothing.
  //
  // The four exceptions are the four docs/validation.md lists, and they are
  // exceptions for a stated reason rather than by neglect. If you write a test for
  // one, delete it from here and from that table.
  const KNOWN_UNTESTED = new Set([
    'main.js', // imports electron at module scope, with side effects
    'overlay.js', // a renderer; needs a DOM and the bridge
    'preload.js', // a thin electron bridge
    'content-preload.js', // a thin electron bridge
  ]);

  const shipped = fs
    .readdirSync(path.join(ROOT, 'src'), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => e.name);

  const missing = shipped.filter((name) => {
    if (KNOWN_UNTESTED.has(name)) return false;
    return !fs.existsSync(path.join(ROOT, 'test', name.replace(/\.js$/, '.test.js')));
  });

  assert.deepStrictEqual(
    missing,
    [],
    `shipped modules with no test/<name>.test.js: ${missing.join(', ')}. ` +
      'Add one, or add the file to KNOWN_UNTESTED here and to the table in docs/validation.md.'
  );

  // And the reverse, so the exception list cannot rot: something on it that has
  // since grown a test should come off the list rather than sit there implying
  // the module is still unreachable.
  const nowTested = [...KNOWN_UNTESTED].filter((name) =>
    fs.existsSync(path.join(ROOT, 'test', name.replace(/\.js$/, '.test.js')))
  );
  assert.deepStrictEqual(
    nowTested,
    [],
    `these are listed as untestable but now have tests: ${nowTested.join(', ')}. ` +
      'Remove them from KNOWN_UNTESTED and update docs/validation.md.'
  );

  // A tripwire on the list itself. If a module is deleted or renamed, the entry
  // left behind is dead weight that makes the exception list look bigger than the
  // real gap.
  const stale = [...KNOWN_UNTESTED].filter((name) => !shipped.includes(name));
  assert.deepStrictEqual(
    stale,
    [],
    `KNOWN_UNTESTED names files that no longer exist: ${stale}`
  );
});
