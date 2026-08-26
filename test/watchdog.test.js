// node --test test/watchdog.test.js
//
// The ladder has already been wrong once in a way that survived review: commit
// f4bf7de, where a broken panel retried at the base delay forever because
// Chromium's error page counted as a successful load and reset the ladder. That
// was fixed by hand and never tested.
const test = require('node:test');
const assert = require('node:assert');
const {
  ERR_ABORTED,
  newWatchdogRecord,
  backoffDelay,
  nextWatchdogStep,
  failureReport,
  isRealLoadFailure,
} = require('../src/watchdog');

// The shipped defaults, from src/config.js withDefaults().
const CFG = {
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  maxAttempts: 5,
  retryMs: 600000,
  escalateToRecycle: true,
};

// ---- the record -------------------------------------------------------------

test('a fresh record starts at the bottom of the ladder', () => {
  const w = newWatchdogRecord();
  assert.strictEqual(w.attempts, 0);
  assert.strictEqual(w.round, 0);
  assert.strictEqual(w.gaveUp, false);
  assert.strictEqual(w.sawFailure, false);
  assert.strictEqual(w.showingDiagnostic, false);
  assert.strictEqual(w.lastError, null);
});

test('two records do not share state', () => {
  const a = newWatchdogRecord();
  a.attempts = 3;
  assert.strictEqual(newWatchdogRecord().attempts, 0);
});

// ---- backoff ----------------------------------------------------------------

// The bug this file exists for was a ladder that never backed off, so the
// doubling is asserted rung by rung rather than in aggregate.
test('the delay doubles each attempt and then stops at the cap', () => {
  assert.deepStrictEqual(
    [1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, CFG)),
    [2000, 4000, 8000, 16000, 30000, 30000]
  );
});

test('the cap is honoured even when it is below the base delay', () => {
  assert.strictEqual(backoffDelay(1, { baseDelayMs: 60000, maxDelayMs: 5000 }), 5000);
});

// ---- the ladder -------------------------------------------------------------

test('a fresh failure schedules a retry rather than escalating', () => {
  const step = nextWatchdogStep({ attempts: 0, round: 0 }, CFG);
  assert.deepStrictEqual(step, { action: 'retry', attempts: 1, delayMs: 2000 });
});

test('the last attempt of round 0 escalates to a rebuild, and restarts the ladder', () => {
  const step = nextWatchdogStep({ attempts: 5, round: 0 }, CFG);
  assert.deepStrictEqual(step, { action: 'recycle', round: 1, attempts: 0 });
});

// A rebuild is worth one shot, not an endless supply.
test('running out a second time gives up instead of rebuilding again', () => {
  assert.deepStrictEqual(nextWatchdogStep({ attempts: 5, round: 1 }, CFG), {
    action: 'giveUp',
  });
});

test('with escalation switched off it gives up at the end of round 0', () => {
  const cfg = { ...CFG, escalateToRecycle: false };
  assert.deepStrictEqual(nextWatchdogStep({ attempts: 5, round: 0 }, cfg), {
    action: 'giveUp',
  });
});

// 0 means unlimited everywhere else in the config, and it has to here too, or a
// wall configured that way would give up on its first failure.
test('maxAttempts 0 means unlimited, not zero attempts', () => {
  const cfg = { ...CFG, maxAttempts: 0 };
  const step = nextWatchdogStep({ attempts: 99, round: 0 }, cfg);
  assert.strictEqual(step.action, 'retry');
  assert.strictEqual(step.attempts, 100);
  assert.strictEqual(step.delayMs, CFG.maxDelayMs, 'still capped');
});

// Walk the whole thing, which is the only way to see the shape rather than the
// individual rungs.
test('the full ladder is five retries, a rebuild, five more, then give up', () => {
  const w = { attempts: 0, round: 0 };
  const actions = [];
  for (let i = 0; i < 12; i++) {
    const step = nextWatchdogStep(w, CFG);
    actions.push(step.action);
    if (step.action === 'giveUp') break;
    w.attempts = step.attempts;
    if (step.action === 'recycle') w.round = step.round;
  }
  assert.deepStrictEqual(actions, [
    ...Array(5).fill('retry'),
    'recycle',
    ...Array(5).fill('retry'),
    'giveUp',
  ]);
});

// ---- what counts as a failure ----------------------------------------------

test('ERR_ABORTED is not a failure, whoever caused it', () => {
  assert.strictEqual(ERR_ABORTED, -3);
  assert.strictEqual(isRealLoadFailure({ code: ERR_ABORTED, isMainFrame: true }), false);
});

// This matters more since the navigation policy started blocking redirects and
// subframes: a blocked navigation produces ERR_ABORTED, and it must not start
// waking the watchdog.
test('a navigation the policy blocked does not wake the watchdog', () => {
  assert.strictEqual(isRealLoadFailure({ code: -3, isMainFrame: true }), false);
});

test('a subframe failing is not the panel failing', () => {
  assert.strictEqual(isRealLoadFailure({ code: -105, isMainFrame: false }), false);
});

test('a real main-frame failure counts', () => {
  assert.strictEqual(isRealLoadFailure({ code: -105, isMainFrame: true }), true);
});

// ---- log suppression --------------------------------------------------------

test('a new failure is always written down', () => {
  const r = failureReport(
    { lastError: null, suppressed: 0 },
    {
      id: 'a',
      url: 'https://x/',
      text: 'ERR_NAME_NOT_RESOLVED (-105)',
    }
  );
  assert.match(r.log, /a failed to load https:\/\/x\/: ERR_NAME_NOT_RESOLVED \(-105\)/);
  assert.deepStrictEqual(r.state, {
    lastError: 'ERR_NAME_NOT_RESOLVED (-105)',
    suppressed: 0,
  });
});

test('the same failure repeating is silent until the tenth', () => {
  let state = { lastError: 'E', suppressed: 0 };
  const logged = [];
  for (let i = 0; i < 25; i++) {
    const r = failureReport(state, { id: 'a', url: 'u', text: 'E' });
    state = r.state;
    if (r.log) logged.push(r.log);
  }
  assert.strictEqual(state.suppressed, 25);
  assert.strictEqual(logged.length, 2, 'one line at ten and one at twenty, not twenty-five');
  assert.match(logged[0], /still failing: E, 10 times/);
  assert.match(logged[1], /still failing: E, 20 times/);
});

// A different failure is news: the panel has changed how it is broken.
test('a different failure breaks the suppression and resets the count', () => {
  const r = failureReport({ lastError: 'E', suppressed: 7 }, { id: 'a', url: 'u', text: 'F' });
  assert.match(r.log, /failed to load u: F/);
  assert.strictEqual(r.state.suppressed, 0);
  assert.strictEqual(r.state.lastError, 'F');
});

test('a missing suppressed count is treated as zero rather than NaN', () => {
  const r = failureReport({ lastError: 'E' }, { id: 'a', url: 'u', text: 'E' });
  assert.strictEqual(r.state.suppressed, 1);
});
