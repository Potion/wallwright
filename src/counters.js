// The cumulative ledger.
//
// Everything /api/status reported was instantaneous, which is fine when someone
// is watching and useless after a weekend. `reloadAttempts` is the clearest
// example: it is the watchdog's live backoff counter and it resets to 0 on every
// successful load, so a panel that crashed and recovered four hundred times reads
// zero. "Did anything go wrong overnight" had no answer.
//
// So: counts that only ever go up, and high-water marks that only ever go up,
// kept for the life of the process and reported alongside the live state.
//
// Electron-free, so it is unit tested rather than only exercised by the self-test.

// Deliberately a closed list. A typo like bump('recyle') must be a loud error
// during development, not a phantom counter that reads zero forever in a report
// nobody can explain.
const TOTALS = [
  'crashes',
  'failedLoads',
  'loads',
  'watchdogScheduled',
  'watchdogReloads',
  'watchdogDeferrals',
  'timerRefreshes',
  'recycles',
  'memoryLimitHits',
  'memoryRecycles',
  'memoryAllInUse',
  'presetApplies',
  'panelsCreated',
  'panelsDeleted',
];

const PEAKS = ['memoryMb', 'reloadAttempts'];

function createCounters({ maxPanels = 64, warn = () => {} } = {}) {
  const totals = {};
  const lastAt = {};
  const peaks = {};
  const peakAt = {};
  const byPanel = new Map();
  let capped = false;

  for (const n of TOTALS) totals[n] = 0;
  for (const n of PEAKS) peaks[n] = 0;

  // Panels are never forgotten, which is the opposite of how the refresh and
  // recycle clocks treat them, and the difference is deliberate: a clock has to
  // reset when a panel id is reused, a ledger that forgets makes the run's totals
  // lie. The cap exists only so an editing marathon cannot grow this without
  // bound; it is far above any real montage.
  function forPanel(id) {
    if (id === undefined || id === null) return null;
    if (!byPanel.has(id)) {
      if (byPanel.size >= maxPanels) {
        if (!capped) {
          capped = true;
          warn(`counters: past ${maxPanels} panel ids, no longer tracking new ones`);
        }
        return null;
      }
      byPanel.set(id, { totals: {}, peaks: {}, lastAt: {} });
    }
    return byPanel.get(id);
  }

  function bump(name, id, at = Date.now()) {
    if (!TOTALS.includes(name)) throw new Error(`unknown counter "${name}"`);
    totals[name] += 1;
    lastAt[name] = at;
    const p = forPanel(id);
    if (p) {
      p.totals[name] = (p.totals[name] || 0) + 1;
      p.lastAt[name] = at;
    }
  }

  function highWater(name, value, id, at = Date.now()) {
    if (!PEAKS.includes(name)) throw new Error(`unknown peak "${name}"`);
    if (!Number.isFinite(value)) return;
    if (value > peaks[name]) {
      peaks[name] = value;
      peakAt[name] = at;
    }
    const p = forPanel(id);
    if (p && value > (p.peaks[name] || 0)) p.peaks[name] = value;
  }

  // A copy, not a view. The caller folds this into the status object, and a
  // mutation there must not be able to corrupt the ledger.
  function snapshot() {
    const panels = {};
    for (const [id, p] of byPanel) {
      panels[id] = {
        totals: { ...p.totals },
        peaks: { ...p.peaks },
        lastAt: { ...p.lastAt },
      };
    }
    return {
      totals: { ...totals },
      lastAt: { ...lastAt },
      peaks: { ...peaks },
      peakAt: { ...peakAt },
      byPanel: panels,
    };
  }

  // What a panel contributed, flattened, for the per-panel rows in status.
  function forStatus(id) {
    const p = byPanel.get(id);
    const out = {};
    for (const n of TOTALS) out[n] = (p && p.totals[n]) || 0;
    out.reloadAttemptsPeak = (p && p.peaks.reloadAttempts) || 0;
    out.lastCrashAt = (p && p.lastAt.crashes) || null;
    return out;
  }

  return { bump, highWater, snapshot, forStatus, names: () => [...TOTALS] };
}

module.exports = { createCounters, TOTALS, PEAKS };
