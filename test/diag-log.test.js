// node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiagLog, isoLocal, fmt } = require('../src/diag-log');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wallwright-log-'));

// A fixed clock, so rotation and the rate limiter can be driven exactly rather
// than waited for.
function clock(start = Date.UTC(2026, 7, 24, 12, 0, 0)) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('the timestamp carries a local offset, at any offset', () => {
  const at = Date.UTC(2026, 7, 24, 19, 4, 5, 123);
  assert.strictEqual(isoLocal(at, -240), '2026-08-24T15:04:05.123-04:00');
  assert.strictEqual(isoLocal(at, 0), '2026-08-24T19:04:05.123+00:00');
  assert.strictEqual(isoLocal(at, 330), '2026-08-25T00:34:05.123+05:30');
});

test('non-string arguments survive, because a crash reason is an object', () => {
  assert.strictEqual(fmt('plain'), 'plain');
  assert.strictEqual(fmt({ reason: 'oom' }), '{"reason":"oom"}');
  assert.strictEqual(fmt(7), '7');
  assert.strictEqual(fmt(undefined), 'undefined');
  assert.match(fmt(new Error('boom')), /boom/);
});

test('a line is written, prefixed with a timestamp and its level', () => {
  const dir = tmp();
  const c = clock();
  const log = createDiagLog({ dir, now: c.now, offsetMinutes: 0 });
  log.open();
  assert.strictEqual(log.write('info', 'memory: 699MB total'), true);
  const text = fs.readFileSync(log.path(), 'utf8');
  assert.match(
    text,
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d info memory: 699MB total\n$/
  );
});

test('opening an existing file appends rather than truncating', () => {
  const dir = tmp();
  const first = createDiagLog({ dir, offsetMinutes: 0 });
  first.open();
  first.write('info', 'from the previous run');
  const file = first.path();

  const second = createDiagLog({ dir, offsetMinutes: 0 });
  second.open();
  second.write('info', 'from this run');

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /previous run/);
  assert.match(lines[1], /this run/);
});

test('rotation shifts the numbered files along and drops the oldest', () => {
  const dir = tmp();
  // Small enough that a couple of lines fills it.
  const log = createDiagLog({ dir, maxBytes: 120, keep: 3, offsetMinutes: 0 });
  log.open();
  for (let i = 0; i < 40; i++) log.write('info', `line ${i}`);

  const base = log.path();
  assert.ok(fs.existsSync(base), 'the live file exists');
  assert.ok(fs.existsSync(`${base}.1`), 'the previous file exists');
  assert.ok(fs.existsSync(`${base}.3`), 'the oldest kept file exists');
  assert.ok(!fs.existsSync(`${base}.4`), 'nothing is kept past keep');

  // The newest content is in the live file, and the .1 is older than it.
  assert.match(fs.readFileSync(base, 'utf8'), /line 39/);
  assert.ok(!fs.readFileSync(`${base}.1`, 'utf8').includes('line 39'));
});

test('the total on disk stays inside the ceiling rotation promises', () => {
  const dir = tmp();
  const maxBytes = 200;
  const keep = 3;
  const log = createDiagLog({ dir, maxBytes, keep, offsetMinutes: 0 });
  log.open();
  for (let i = 0; i < 500; i++) log.write('info', `a somewhat longer line number ${i}`);

  const total = fs
    .readdirSync(dir)
    .map((f) => fs.statSync(path.join(dir, f)).size)
    .reduce((a, b) => a + b, 0);
  // Each file can overshoot by at most the line that tripped rotation.
  assert.ok(total <= maxBytes * (keep + 1) + 200, `total ${total} within the ceiling`);
});

test('the rate limiter drops the excess, says so once, and recovers', () => {
  const dir = tmp();
  const c = clock();
  const log = createDiagLog({ dir, maxLinesPerMinute: 5, now: c.now, offsetMinutes: 0 });
  log.open();

  for (let i = 0; i < 5; i++) assert.strictEqual(log.write('info', `kept ${i}`), true);
  assert.strictEqual(log.write('info', 'dropped'), false, 'past the budget');
  assert.strictEqual(log.write('info', 'also dropped'), false);

  c.advance(60001); // the window rolls
  assert.strictEqual(log.write('info', 'kept again'), true);

  const text = fs.readFileSync(log.path(), 'utf8');
  assert.ok(!text.includes('dropped\n'), 'the dropped line is not in the file');
  assert.match(text, /dropped 2 line\(s\) over the last minute/);
  assert.strictEqual(text.match(/dropped 2 line/g).length, 1, 'said exactly once');
  assert.match(text, /kept again/);
  assert.strictEqual(log.stats().dropped, 2);
});

test('an unwritable directory disables the log instead of throwing', () => {
  // A file where a directory should be: mkdirSync fails, which is the shape of
  // the real failure (a path the account cannot write).
  const dir = tmp();
  const blocked = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocked, 'in the way');

  const log = createDiagLog({ dir: path.join(blocked, 'logs') });
  assert.doesNotThrow(() => log.open());
  assert.doesNotThrow(() => log.write('info', 'goes nowhere'));
  assert.strictEqual(log.write('info', 'still nowhere'), false);
  assert.strictEqual(log.stats().disabled, true);
  assert.ok(log.stats().reason, 'it records why');
});

test('writing before open, and after close, is harmless', () => {
  const log = createDiagLog({ dir: tmp(), offsetMinutes: 0 });
  assert.strictEqual(log.write('info', 'not open yet'), false);
  log.open();
  assert.strictEqual(log.write('info', 'open'), true);
  log.close();
  assert.doesNotThrow(() => log.write('info', 'closed'));
  assert.strictEqual(log.write('info', 'closed'), false);
});

test('the banner writes one line of key=value provenance', () => {
  const dir = tmp();
  const log = createDiagLog({ dir, offsetMinutes: 0 });
  log.open();
  log.banner({ runId: 'a1b2c3d4', version: '0.1.1', panels: 6 });
  const text = fs.readFileSync(log.path(), 'utf8');
  assert.match(text, /info session runId=a1b2c3d4 version=0\.1\.1 panels=6/);
  assert.strictEqual(text.trim().split('\n').length, 1);
});
