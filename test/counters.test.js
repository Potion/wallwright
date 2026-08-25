// node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { createCounters } = require('../src/counters');

test('a bump moves the total and the panel that caused it', () => {
  const c = createCounters();
  c.bump('crashes', 'view-1');
  c.bump('crashes', 'view-1');
  c.bump('crashes', 'view-2');
  const s = c.snapshot();
  assert.strictEqual(s.totals.crashes, 3);
  assert.strictEqual(s.byPanel['view-1'].totals.crashes, 2);
  assert.strictEqual(s.byPanel['view-2'].totals.crashes, 1);
});

test('a counter with no panel still moves the total', () => {
  const c = createCounters();
  c.bump('memoryLimitHits');
  assert.strictEqual(c.snapshot().totals.memoryLimitHits, 1);
  assert.deepStrictEqual(c.snapshot().byPanel, {});
});

test('an unknown counter throws rather than inventing itself', () => {
  const c = createCounters();
  // The real bug this prevents: a typo that reads zero forever in a report.
  assert.throws(() => c.bump('recyles', 'view-1'), /unknown counter/);
  assert.throws(() => c.highWater('memryMb', 10), /unknown peak/);
});

test('a high-water mark only ever goes up', () => {
  const c = createCounters();
  c.highWater('memoryMb', 700);
  c.highWater('memoryMb', 400);
  c.highWater('memoryMb', 1200);
  c.highWater('memoryMb', 900);
  assert.strictEqual(c.snapshot().peaks.memoryMb, 1200);
});

test('a non-numeric high-water value is ignored, not recorded as a peak', () => {
  const c = createCounters();
  c.highWater('memoryMb', 500);
  c.highWater('memoryMb', NaN);
  c.highWater('memoryMb', undefined);
  assert.strictEqual(c.snapshot().peaks.memoryMb, 500);
});

test('the snapshot is a copy a caller cannot corrupt', () => {
  const c = createCounters();
  c.bump('crashes', 'view-1');
  const s = c.snapshot();
  s.totals.crashes = 999;
  s.byPanel['view-1'].totals.crashes = 999;
  assert.strictEqual(c.snapshot().totals.crashes, 1);
  assert.strictEqual(c.snapshot().byPanel['view-1'].totals.crashes, 1);
});

test('timestamps record when a counter last moved', () => {
  const c = createCounters();
  c.bump('crashes', 'view-1', 1000);
  c.bump('crashes', 'view-1', 5000);
  assert.strictEqual(c.snapshot().lastAt.crashes, 5000);
  assert.strictEqual(c.forStatus('view-1').lastCrashAt, 5000);
});

test('the per-panel status row is zero-filled, so a field never goes missing', () => {
  const c = createCounters();
  const row = c.forStatus('never-seen');
  assert.strictEqual(row.crashes, 0);
  assert.strictEqual(row.recycles, 0);
  assert.strictEqual(row.reloadAttemptsPeak, 0);
  assert.strictEqual(row.lastCrashAt, null);
});

test('the panel cap warns once and keeps counting totals', () => {
  const warnings = [];
  const c = createCounters({ maxPanels: 2, warn: (m) => warnings.push(m) });
  c.bump('loads', 'a');
  c.bump('loads', 'b');
  c.bump('loads', 'c');
  c.bump('loads', 'd');
  assert.strictEqual(c.snapshot().totals.loads, 4, 'totals are unaffected');
  assert.strictEqual(Object.keys(c.snapshot().byPanel).length, 2);
  assert.strictEqual(warnings.length, 1, 'said once, not per panel');
});
