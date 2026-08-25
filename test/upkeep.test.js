// node --test test/
const test = require('node:test');
const assert = require('node:assert');
const {
  classifyActivity,
  deferralExpired,
  summarizeMetrics,
  ineligibleReason,
  rankRecycleCandidates,
  memoryPlan,
  staggerSeeds,
  memoryLimitFromBaseline,
  memoryHardLimitFromBaseline,
} = require('../src/upkeep');

const NOW = 1_000_000_000;

// A panel that is a perfectly good candidate, so each test can spoil exactly one
// thing about it.
const panel = (over = {}) => ({
  id: 'a',
  index: 0,
  promoted: false,
  interactAt: 0,
  rssMb: 100,
  lastRecycleAt: 0,
  loading: false,
  popupOpen: false,
  neverRecycle: false,
  ...over,
});

const opts = (over = {}) => ({
  now: NOW,
  recentUseMs: 60000,
  minRecycleIntervalMs: 60000,
  force: false,
  ...over,
});

// ---- activity ---------------------------------------------------------------

test('pointer motion is presence; anything else is interaction', () => {
  assert.strictEqual(classifyActivity('mousemove'), 'presence');
  for (const t of ['mousedown', 'keydown', 'wheel', 'touchstart']) {
    assert.strictEqual(classifyActivity(t), 'interact', t);
  }
});

test('an unknown event type counts as interaction, which is the safe default', () => {
  // If someone adds an event to the preload and forgets this list, the failure
  // should be "we protected a panel we did not need to", not "we rebuilt one
  // under somebody".
  assert.strictEqual(classifyActivity('pointerdown'), 'interact');
  assert.strictEqual(classifyActivity(undefined), 'interact');
});

test('a deferral expires only once it has actually been outstanding', () => {
  assert.strictEqual(
    deferralExpired({ wantedSince: NOW - 5000, now: NOW, maxDeferMs: 10000 }),
    false
  );
  assert.strictEqual(
    deferralExpired({ wantedSince: NOW - 10000, now: NOW, maxDeferMs: 10000 }),
    true
  );
  // Never wanted, or no ceiling configured: nothing to expire.
  assert.strictEqual(
    deferralExpired({ wantedSince: null, now: NOW, maxDeferMs: 10000 }),
    false
  );
  assert.strictEqual(
    deferralExpired({ wantedSince: NOW - 1e9, now: NOW, maxDeferMs: 0 }),
    false
  );
});

// ---- metrics ----------------------------------------------------------------

test('metrics are summed per type and per pid, in MB', () => {
  const s = summarizeMetrics([
    { pid: 1, type: 'Browser', memory: { workingSetSize: 102400 } }, // 100MB
    { pid: 2, type: 'Tab', memory: { workingSetSize: 51200 } }, // 50MB
    { pid: 3, type: 'Tab', memory: { workingSetSize: 25600 } }, // 25MB
  ]);
  assert.strictEqual(Math.round(s.totalMb), 175);
  assert.strictEqual(Math.round(s.byType.get('Tab')), 75);
  assert.strictEqual(Math.round(s.byPid.get(2)), 50);
});

test('metrics survive missing fields rather than throwing', () => {
  const s = summarizeMetrics([{}, { pid: 9 }, null, { type: 'GPU', memory: {} }]);
  assert.strictEqual(s.totalMb, 0);
  assert.strictEqual(Math.round(s.byType.get('Unknown')), 0);
});

// ---- eligibility ------------------------------------------------------------

test('a promoted panel is never a candidate, even when forcing', () => {
  assert.strictEqual(ineligibleReason(panel({ promoted: true }), opts()), 'promoted');
  assert.strictEqual(
    ineligibleReason(panel({ promoted: true }), opts({ force: true })),
    'promoted',
    'force must not override promotion'
  );
});

test('the guards that were missing are all guards', () => {
  assert.strictEqual(ineligibleReason(panel({ loading: true }), opts()), 'still loading');
  assert.strictEqual(
    ineligibleReason(panel({ popupOpen: true }), opts()),
    'an SSO popup is open'
  );
  assert.strictEqual(
    ineligibleReason(panel({ neverRecycle: true }), opts()),
    'neverRecycle is set'
  );
  assert.strictEqual(
    ineligibleReason(panel({ lastRecycleAt: NOW - 1000 }), opts()),
    'recycled too recently'
  );
});

test('recent interaction blocks a recycle, and forcing overrides that one', () => {
  const p = panel({ interactAt: NOW - 1000 });
  assert.strictEqual(ineligibleReason(p, opts()), 'in use');
  assert.strictEqual(ineligibleReason(p, opts({ force: true })), null);
});

// ---- the ranking bug --------------------------------------------------------

test('ranking recycles the heaviest panel, not whichever comes first', () => {
  // The regression test for the measured defect: every untouched panel shared the
  // key 0 under the old ordering, so a stable sort took the lowest index every
  // time. Fourteen consecutive rebuilds of panel 1 while 2 to 4 grew.
  const panels = [
    panel({ id: 'p1', index: 0, rssMb: 80 }),
    panel({ id: 'p2', index: 1, rssMb: 500 }),
    panel({ id: 'p3', index: 2, rssMb: 120 }),
  ];
  const ranked = rankRecycleCandidates(panels, opts());
  assert.deepStrictEqual(
    ranked.map((p) => p.id),
    ['p2', 'p3', 'p1']
  );
});

test('never-touched and touched-long-ago are not ordered by index', () => {
  const panels = [
    panel({ id: 'first', index: 0, interactAt: 0, rssMb: 100 }),
    panel({ id: 'second', index: 1, interactAt: NOW - 3600000, rssMb: 300 }),
  ];
  assert.strictEqual(rankRecycleCandidates(panels, opts())[0].id, 'second');
});

test('equal weight breaks towards whatever has gone longest without a rebuild', () => {
  const panels = [
    panel({ id: 'recent', index: 0, rssMb: 200, lastRecycleAt: NOW - 120000 }),
    panel({ id: 'stale', index: 1, rssMb: 200, lastRecycleAt: NOW - 600000 }),
  ];
  assert.strictEqual(rankRecycleCandidates(panels, opts())[0].id, 'stale');
});

// ---- the ladder -------------------------------------------------------------

const ladder = (over = {}) => ({
  totalMb: 1000,
  limitMb: 800,
  hardLimitMb: 2000,
  panels: [panel({ id: 'a', index: 0, rssMb: 300 }), panel({ id: 'b', index: 1, rssMb: 100 })],
  mode: 'grid',
  now: NOW,
  pressureSince: null,
  hardChecks: 0,
  sweptAt: null,
  recyclesSinceReduction: 0,
  cfg: {},
  ...over,
});

test('rung 0: under the limit, and with no limit at all, nothing happens', () => {
  assert.deepStrictEqual(memoryPlan(ladder({ totalMb: 500 })), {
    rung: 0,
    action: 'none',
    over: false,
  });
  assert.strictEqual(memoryPlan(ladder({ limitMb: 0, totalMb: 99999 })).action, 'none');
});

test('rung 1: over the limit with something idle recycles exactly one panel', () => {
  const plan = memoryPlan(ladder());
  assert.strictEqual(plan.rung, 1);
  assert.strictEqual(plan.action, 'recycle');
  assert.deepStrictEqual(plan.targetIds, ['a'], 'the heaviest');
});

test('edit mode stops the action but not the reporting', () => {
  const plan = memoryPlan(ladder({ mode: 'edit' }));
  assert.strictEqual(plan.action, 'none');
  assert.strictEqual(plan.over, true, 'still over: the caller still logs the number');
  assert.match(plan.reason, /edited/);
});

test('rung 2: nothing idle holds off, then forces once pressure persists', () => {
  const inUse = [
    panel({ id: 'a', index: 0, interactAt: NOW - 1000, rssMb: 300 }),
    panel({ id: 'b', index: 1, interactAt: NOW - 1000, rssMb: 100 }),
  ];
  const held = memoryPlan(ladder({ panels: inUse, pressureSince: NOW - 1000 }));
  assert.strictEqual(held.rung, 2);
  assert.strictEqual(held.action, 'none');
  assert.match(held.reason, /nothing eligible \(2 in use\)/);

  const forced = memoryPlan(
    ladder({ panels: inUse, pressureSince: NOW - 400000, cfg: { memoryForceAfterMs: 300000 } })
  );
  assert.strictEqual(forced.rung, 2);
  assert.strictEqual(forced.action, 'recycle');
  assert.strictEqual(forced.forced, true);
  assert.deepStrictEqual(forced.targetIds, ['a']);
});

test('rung 2 forcing still refuses to touch the promoted panel', () => {
  const plan = memoryPlan(
    ladder({
      panels: [
        panel({ id: 'a', index: 0, promoted: true, interactAt: NOW, rssMb: 900 }),
        panel({ id: 'b', index: 1, interactAt: NOW - 1000, rssMb: 100 }),
      ],
      pressureSince: NOW - 400000,
    })
  );
  assert.deepStrictEqual(plan.targetIds, ['b'], 'the promoted panel is not a target');
});

test('rung 3: past the hard limit it sweeps, then docks, then gives up', () => {
  const hard = { totalMb: 2500, hardChecks: 2 };
  const swept = memoryPlan(ladder(hard));
  assert.strictEqual(swept.rung, 3);
  assert.strictEqual(swept.action, 'sweep');
  assert.deepStrictEqual(swept.targetIds.sort(), ['a', 'b']);

  // Swept already, and a promoted panel was excluded from it.
  const docked = memoryPlan(
    ladder({
      ...hard,
      sweptAt: NOW - 5000,
      panels: [panel({ id: 'a', index: 0, promoted: true }), panel({ id: 'b', index: 1 })],
    })
  );
  assert.strictEqual(docked.action, 'dock');

  // Swept, nothing promoted, still over: recycling cannot reach this.
  const stuck = memoryPlan(ladder({ ...hard, sweptAt: NOW - 5000, panels: [] }));
  assert.strictEqual(stuck.action, 'none');
  assert.strictEqual(stuck.exhausted, true);
});

test('the hard limit waits for consecutive checks before sweeping', () => {
  const plan = memoryPlan(ladder({ totalMb: 2500, hardChecks: 1 }));
  assert.notStrictEqual(plan.action, 'sweep', 'one reading is not a trend');
});

test('rung 4 is unreachable unless it is switched on', () => {
  const base = { totalMb: 2500, hardChecks: 2, sweptAt: NOW - 5000, panels: [] };
  assert.strictEqual(memoryPlan(ladder(base)).action, 'none');
  assert.strictEqual(
    memoryPlan(ladder({ ...base, cfg: { relaunchEnabled: true } })).action,
    'relaunch'
  );
});

test('recycling that is not reclaiming stops instead of churning the wall', () => {
  const plan = memoryPlan(ladder({ recyclesSinceReduction: 3, cfg: { memoryGiveUpAfter: 3 } }));
  assert.strictEqual(plan.action, 'none');
  assert.strictEqual(plan.exhausted, true);
  assert.match(plan.reason, /have not reclaimed/);
});

// ---- schedules and thresholds ----------------------------------------------

test('stagger seeds spread panels across the interval', () => {
  const seeds = staggerSeeds(4, 4000, 10000);
  assert.deepStrictEqual(seeds, [10000, 9000, 8000, 7000]);
  // Distinct, so they do not all come due in the same second.
  assert.strictEqual(new Set(seeds).size, 4);
});

test('stagger seeds are empty when there is nothing to stagger', () => {
  assert.deepStrictEqual(staggerSeeds(0, 4000, 1), []);
  assert.deepStrictEqual(staggerSeeds(4, 0, 1), []);
});

test('the threshold rule keeps the limit clear of the operating band', () => {
  // A flat curve: the p95 term leads.
  assert.strictEqual(memoryLimitFromBaseline(1000, 1050), 1500);
  // A spiky curve: the peak term takes over, which is the point of having it.
  assert.strictEqual(memoryLimitFromBaseline(1000, 1800), 2250);
  // No baseline yet means no limit, rather than a guessed one.
  assert.strictEqual(memoryLimitFromBaseline(0, 0), 0);
  assert.strictEqual(memoryHardLimitFromBaseline(0, 0), 0);
});

test('the hard limit always sits clear of the soft one', () => {
  for (const [p95, peak] of [
    [500, 500],
    [1000, 1050],
    [1000, 1800],
    [2000, 2100],
  ]) {
    const soft = memoryLimitFromBaseline(p95, peak);
    const hard = memoryHardLimitFromBaseline(p95, peak);
    assert.ok(hard >= soft + 750, `${hard} clear of ${soft}`);
  }
});

test('when nothing is eligible it says what actually blocked it', () => {
  // Measured against four live dashboards, the usual blocker was the cooldown
  // rather than anybody using the wall, so "every panel is in use" was untrue.
  const plan = memoryPlan({
    totalMb: 1000,
    limitMb: 800,
    now: NOW,
    panels: [
      panel({ id: 'a', lastRecycleAt: NOW - 1000 }),
      panel({ id: 'b', lastRecycleAt: NOW - 2000 }),
      panel({ id: 'c', loading: true }),
    ],
    cfg: { minRecycleIntervalMs: 60000 },
  });
  assert.strictEqual(plan.action, 'none');
  assert.match(plan.reason, /2 recycled too recently/);
  assert.match(plan.reason, /still loading/);
});

test('the watchdog is not blocked by the load it is reacting to', () => {
  // isLoading() is still true when did-fail-load fires. Treating that as "leave
  // this alone" deferred recovery permanently: one failure and the panel was
  // never retried, which is worse than the unbounded retrying it replaced.
  const failing = panel({ loading: true });
  assert.strictEqual(ineligibleReason(failing, opts()), 'still loading');
  assert.strictEqual(ineligibleReason(failing, opts({ allowLoading: true })), null);
});
