// The watchdog's decisions: how long to wait before the next reload, when to stop
// reloading and rebuild instead, when to give up, and how much of a repeating
// failure to write down. No electron import, so test/watchdog.test.js can
// exercise it directly.
//
// Extracted because this code has already been wrong in production terms. Commit
// f4bf7de is "Bound the watchdog, and find out why it never backed off", and the
// cause was recorded at the time: loads and failedLoads were identical, 141 each,
// because Chromium's error page counted as a successful load and reset the ladder,
// so a broken panel retried at the base delay forever instead of backing off. It
// was fixed by hand and then had no test.

// The per-panel state the ladder walks. One place, so a new field cannot be added
// to the record and forgotten in the reset.
function newWatchdogRecord() {
  return {
    attempts: 0,
    pending: null,
    deferred: false,
    // How many times the whole ladder has been walked. Round 2 is the last one:
    // past that the panel is declared unrecoverable rather than retried forever.
    round: 0,
    gaveUp: false,
    slowTimer: null,
    lastError: null,
    suppressed: 0,
    sawFailure: false,
    // True while the panel is showing a page this app generated rather than the
    // configured one. Without it, loading the "could not be loaded" page counts as
    // the panel having recovered, which clears the ladder and cancels the retry
    // that page has just promised the reader.
    showingDiagnostic: false,
  };
}

// Exponential, capped. Doubling from the attempt number rather than from the
// previous delay, so the ladder cannot drift if an attempt is ever skipped.
function backoffDelay(attempts, cfg) {
  return Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** attempts);
}

// What the watchdog should do next, given where it has got to.
//
// Returns one of:
//   { action: 'retry',   attempts, delayMs }  - load again after delayMs
//   { action: 'recycle', round, attempts }    - rebuild the view, restart the ladder
//   { action: 'giveUp' }                      - show the diagnostic, stop the fast ladder
//
// The escalation to a rebuild happens once, at the end of round 0, because a
// fresh renderer fixes failures a reload cannot - a wedged GPU context, a renderer
// dying on its own corrupt state - and the sessionStorage a rebuild costs is
// already gone: the panel is showing an error, not a session.
//
// maxAttempts of 0 means unlimited, matching every other 0 in the config.
function nextWatchdogStep(w, cfg) {
  if (cfg.maxAttempts && w.attempts >= cfg.maxAttempts) {
    if (cfg.escalateToRecycle && w.round === 0) {
      return { action: 'recycle', round: 1, attempts: 0 };
    }
    return { action: 'giveUp' };
  }
  const attempts = w.attempts + 1;
  return { action: 'retry', attempts, delayMs: backoffDelay(attempts, cfg) };
}

// What to write down about a failed load, and what the suppression state becomes.
//
// The same failure repeating is one fact, not fifty. An unattended wall can
// otherwise fill its diagnostics file with a single message and push out
// everything else, which on the show PC is the only record there is.
//
// Returns `{ state, log }`, where `log` is null when the line is suppressed.
function failureReport({ lastError, suppressed = 0 }, { id, url, text }) {
  if (lastError === text) {
    const n = suppressed + 1;
    return {
      state: { lastError, suppressed: n },
      log: n % 10 === 0 ? `${id} still failing: ${text}, ${n} times` : null,
    };
  }
  // A different failure is news, so it always gets a line and resets the count.
  return {
    state: { lastError: text, suppressed: 0 },
    log: `${id} failed to load ${url}: ${text}`,
  };
}

// ERR_ABORTED. A normal redirect or a cancelled load produces it, and so does a
// navigation this app blocked on purpose, so it must never wake the watchdog.
const ERR_ABORTED = -3;

// Whether a did-fail-load is a real failure or noise. Subframe failures are
// ignored: an advert or a widget failing inside a dashboard is not the dashboard
// failing, and reloading the whole panel for it would be worse than the fault.
function isRealLoadFailure({ code, isMainFrame }) {
  return !!isMainFrame && code !== ERR_ABORTED;
}

module.exports = {
  ERR_ABORTED,
  newWatchdogRecord,
  backoffDelay,
  nextWatchdogStep,
  failureReport,
  isRealLoadFailure,
};
