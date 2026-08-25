// Upkeep policy: what to recycle, when, and how hard to insist.
//
// This is the decision-making that used to sit inline in checkMemory(), pulled
// out so it can be tested in plain node. The behaviour it governs is destructive
// (rebuilding a panel costs whatever the page was holding in sessionStorage), it
// only ever runs when nobody is watching, and it is reached through a config
// value that will be tuned from a soak. That combination wants tests, not
// eyeballs.
//
// Nothing here imports electron, and nothing here does anything: it takes plain
// numbers and returns a decision for src/main.js to carry out.

// ---- activity ---------------------------------------------------------------
//
// Two kinds of signal arrive from src/content-preload.js and they should not mean
// the same thing.
//
// An interaction says somebody is doing something that a rebuild would ruin:
// credentials half typed, an SSO redirect chain in flight, an SPA navigated
// somewhere. Pointer motion says only that a cursor moved across a panel, which
// on an unattended wall may be nothing more than the mouse sitting where it was
// left, with Chromium dispatching synthetic moves as animated content passes
// under it. Treating those as equivalent lets a parked cursor defer upkeep for as
// long as the content keeps moving.
const INTERACT = ['mousedown', 'keydown', 'wheel', 'touchstart'];
const PRESENCE = ['mousemove'];

function classifyActivity(type) {
  if (PRESENCE.includes(type)) return 'presence';
  // Anything unrecognised counts as interaction. If a new event type is added to
  // the preload and nobody updates this list, the safe failure is to protect the
  // panel, not to rebuild it under someone.
  return INTERACT.includes(type) ? 'interact' : 'interact';
}

// A deferral that has been outstanding this long stops being a courtesy. Without
// a ceiling, "never touch a panel someone is using" can mean "never touch this
// panel", and the wall has no way back under memory pressure.
function deferralExpired({ wantedSince, now, maxDeferMs }) {
  if (!maxDeferMs || !wantedSince) return false;
  return now - wantedSince >= maxDeferMs;
}

// ---- metrics ----------------------------------------------------------------
//
// The same arithmetic src/main.js runs over app.getAppMetrics(), in a form that
// can be handed a captured payload in a test. workingSetSize is in kilobytes and
// counts shared pages once per process that maps them, so the total reads high;
// it is a trend, not an accounting of unique bytes.
function summarizeMetrics(metrics) {
  const byType = new Map();
  const byPid = new Map();
  let totalMb = 0;
  for (const m of metrics || []) {
    const mb = (m && m.memory && m.memory.workingSetSize ? m.memory.workingSetSize : 0) / 1024;
    totalMb += mb;
    const type = (m && m.type) || 'Unknown';
    byType.set(type, (byType.get(type) || 0) + mb);
    if (m && m.pid) byPid.set(m.pid, mb);
  }
  return { totalMb, byType, byPid };
}

// ---- choosing a panel -------------------------------------------------------
//
// A panel is only a candidate if rebuilding it would not interrupt anybody and
// would plausibly help.
//
// `reason` is returned rather than logged so the caller can say why nothing
// happened, which is the difference between a quiet wall and an inexplicable one.
function ineligibleReason(p, { now, recentUseMs, minRecycleIntervalMs, force }) {
  // Promotion is never overridden, at any rung. Somebody is standing at the wall
  // looking at this panel, and the idle timer will dock it soon enough anyway.
  if (p.promoted) return 'promoted';
  if (p.neverRecycle) return 'neverRecycle is set';
  // Mid-load is both unkind and pointless: it may be an SSO redirect chain, and a
  // page that has not finished loading has not reached the memory that recycling
  // would reclaim.
  if (p.loading) return 'still loading';
  // The popup belongs to this panel's session. Rebuilding the opener orphans the
  // login it is in the middle of.
  if (p.popupOpen) return 'an SSO popup is open';
  if (minRecycleIntervalMs && p.lastRecycleAt && now - p.lastRecycleAt < minRecycleIntervalMs) {
    return 'recycled too recently';
  }
  if (!force && recentUseMs && now - (p.interactAt || 0) < recentUseMs) return 'in use';
  return null;
}

// Ordered best-first.
//
// The old ordering was ascending on the last-touched timestamp, which looks like
// least-recently-used and is not: a panel nobody has ever touched has no
// timestamp, so every untouched panel shared the key 0 and a stable sort picked
// the lowest index every time. Measured on four live dashboards, that meant
// fourteen consecutive recycles of panel 1 while panels 2 to 4 were never
// considered - and untouched is the normal state of an exhibit wall.
//
// So rank by what the action is for: reclaim the most memory. Ties break towards
// whatever has gone longest without a rebuild, which rotates naturally, and the
// cooldown filter above stops any one panel being chosen twice in a row.
function rankRecycleCandidates(panels, opts) {
  const { now = Date.now() } = opts || {};
  const o = { recentUseMs: 0, minRecycleIntervalMs: 0, force: false, ...opts, now };
  return (panels || [])
    .filter((p) => !ineligibleReason(p, o))
    .sort(
      (a, b) =>
        (b.rssMb || 0) - (a.rssMb || 0) ||
        (a.lastRecycleAt || 0) - (b.lastRecycleAt || 0) ||
        (a.interactAt || 0) - (b.interactAt || 0) ||
        (a.index || 0) - (b.index || 0)
    );
}

// ---- the ladder -------------------------------------------------------------
//
// Rung 0 is the shipped default and does nothing but report. The rest only exist
// once someone sets a limit, and the limit is meant to come from a measured
// baseline rather than a guess: see memoryLimitFromBaseline below.
//
// The returned action is one of:
//   none      nothing to do, or nothing safe to do
//   recycle   rebuild targetIds (one panel, unless sweeping)
//   sweep     rebuild every eligible panel, because one at a time is not keeping up
//   dock      leave active mode, which makes the promoted panel eligible next check
//   relaunch  restart the process; only reachable with relaunchEnabled
function memoryPlan(input) {
  const {
    totalMb = 0,
    limitMb = 0,
    hardLimitMb = 0,
    panels = [],
    mode = 'grid',
    now = Date.now(),
    pressureSince = null,
    hardChecks = 0,
    sweptAt = null,
    recyclesSinceReduction = 0,
    cfg = {},
  } = input || {};

  const c = {
    recentUseMs: 60000,
    minRecycleIntervalMs: 60000,
    maxDeferMs: 900000,
    memoryForceAfterMs: 300000,
    memoryHardForChecks: 2,
    memoryGiveUpAfter: 3,
    relaunchEnabled: false,
    ...cfg,
  };

  const over = limitMb > 0 && totalMb > limitMb;
  if (!over) return { rung: 0, action: 'none', over: false };

  // Acting while the layout is being edited would rebuild a panel under the hands
  // of whoever is dragging it, and leave the inspector pointing at a view that no
  // longer exists. runUpkeep() has always skipped edit mode; this did not.
  if (mode === 'edit') {
    return { rung: 0, action: 'none', over: true, reason: 'the layout is being edited' };
  }

  // Recycling that demonstrably is not reclaiming anything should stop rather than
  // churn the wall for nothing. It is also the evidence that the growth is not in
  // the renderers, which is what justifies the rungs below.
  if (recyclesSinceReduction >= c.memoryGiveUpAfter) {
    return {
      rung: 0,
      action: 'none',
      over: true,
      exhausted: true,
      reason: `${recyclesSinceReduction} recycles have not reclaimed ${c.memoryReduceMinMb || 50}MB`,
    };
  }

  const overHard = hardLimitMb > 0 && totalMb > hardLimitMb;
  if (overHard && hardChecks >= c.memoryHardForChecks) {
    const sweepable = rankRecycleCandidates(panels, {
      now,
      recentUseMs: c.recentUseMs,
      minRecycleIntervalMs: c.minRecycleIntervalMs,
      force: true,
    });
    // One panel per check is not keeping up, so take them all at once and accept
    // that it is visible.
    if (!sweptAt && sweepable.length) {
      return {
        rung: 3,
        action: 'sweep',
        over: true,
        targetIds: sweepable.map((p) => p.id),
        reason: `over the hard limit of ${hardLimitMb}MB`,
      };
    }
    // A sweep has happened and it is still over. If a panel is promoted it was
    // excluded from that sweep, so dock first: docking reloads nothing, and it
    // makes the panel an ordinary candidate on the next check. That is a cheaper
    // last resort than overriding promotion, and the idle timer would have done
    // it within minutes anyway.
    const promoted = panels.find((p) => p.promoted);
    if (promoted) {
      return {
        rung: 3,
        action: 'dock',
        over: true,
        reason: `still over the hard limit with ${promoted.id} promoted`,
      };
    }
    // Nothing left to rebuild means the growth is not in a renderer, so no
    // per-panel action can reach it. Restarting is the only thing that would, and
    // it is off unless someone has decided otherwise.
    if (c.relaunchEnabled) {
      return { rung: 4, action: 'relaunch', over: true, reason: 'a full sweep did not help' };
    }
    return {
      rung: 3,
      action: 'none',
      over: true,
      exhausted: true,
      reason: 'a full sweep did not help; the growth is not in the panels',
    };
  }

  const ready = rankRecycleCandidates(panels, {
    now,
    recentUseMs: c.recentUseMs,
    minRecycleIntervalMs: c.minRecycleIntervalMs,
    force: false,
  });
  if (ready.length) {
    return { rung: 1, action: 'recycle', over: true, targetIds: [ready[0].id] };
  }

  // Nothing is eligible. Wait for the pressure to persist before overriding
  // anything: a passing spike should not cost anybody their session.
  if (deferralExpired({ wantedSince: pressureSince, now, maxDeferMs: c.memoryForceAfterMs })) {
    const forced = rankRecycleCandidates(panels, {
      now,
      recentUseMs: c.recentUseMs,
      minRecycleIntervalMs: c.minRecycleIntervalMs,
      force: true,
    });
    if (forced.length) {
      return {
        rung: 2,
        action: 'recycle',
        over: true,
        forced: true,
        targetIds: [forced[0].id],
        reason: `over the limit for ${Math.round((now - pressureSince) / 1000)}s with nothing idle`,
      };
    }
  }
  return { rung: 2, action: 'none', over: true, reason: 'every panel is in use' };
}

// ---- schedules --------------------------------------------------------------
//
// dueFor() falls back to the process start time for a panel that has never
// refreshed, so four panels sharing one refreshMs all come due in the same
// second: a whole-wall flicker and four renderers loading at once. Seeding the
// clocks apart turns that into a rotation.
function staggerSeeds(count, everyMs, startedAt) {
  if (!count || !everyMs) return [];
  const step = everyMs / count;
  return Array.from({ length: count }, (_, i) => Math.round(startedAt - i * step));
}

// ---- the threshold ----------------------------------------------------------
//
// Committed as a derivation rather than a constant, because a limit set inside
// the normal operating band is worse than no limit: it recycles a panel on every
// check, and a recycle that outpaces page load costs more memory than it frees.
// Measured on four live dashboards, a limit under the baseline produced fourteen
// rebuilds in forty seconds while the total went up.
//
// Fill p95 and peak in from the soak, not from taste. The two terms cover
// different shapes: the p95 term sets ordinary headroom, and the peak term keeps
// the limit above a spiky curve that a percentile would flatter.
function roundUp250(mb) {
  return Math.ceil(mb / 250) * 250;
}
function memoryLimitFromBaseline(p95Mb, peakMb) {
  if (!(p95Mb > 0)) return 0;
  return roundUp250(Math.max(1.35 * p95Mb, 1.15 * (peakMb || p95Mb)));
}
function memoryHardLimitFromBaseline(p95Mb, peakMb) {
  const soft = memoryLimitFromBaseline(p95Mb, peakMb);
  if (!soft) return 0;
  return roundUp250(Math.max(2 * p95Mb, soft + 750));
}

module.exports = {
  classifyActivity,
  deferralExpired,
  summarizeMetrics,
  ineligibleReason,
  rankRecycleCandidates,
  memoryPlan,
  staggerSeeds,
  roundUp250,
  memoryLimitFromBaseline,
  memoryHardLimitFromBaseline,
  INTERACT,
  PRESENCE,
};
