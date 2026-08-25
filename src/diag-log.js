// Diagnostics on disk.
//
// The wall runs unattended for weeks, and on the target platform its log output
// currently goes nowhere: Electron builds a GUI-subsystem binary on Windows, so a
// double-clicked Wallwright.exe has no stdout, and every line written by main.js
// lands on an invalid handle. The 60-second memory line is the only record of
// what memory does over days, and it was being thrown away on the one machine
// that matters.
//
// So this writes it to a file as well. No electron import, so it is testable with
// plain node like config.js and layout.js.
//
// Three decisions worth knowing about, because each one is load-bearing:
//
//   Synchronous appends, no buffering. Steady state is one line a minute, so the
//   syscall cost is irrelevant, and buffering would lose the last lines before a
//   crash, which are precisely the lines a crash makes interesting.
//
//   A rate limiter, not as polish. A hot loop (a misconfigured interval, a panel
//   failing in a tight cycle) would otherwise push every useful line out through
//   rotation and leave a file full of the same message.
//
//   It never throws. An unwritable path on a managed PC is an ordinary thing to
//   meet; a logger that can take the wall down with it is worse than no logger at
//   all. On the first failure it says so on the console and goes quiet.

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  baseName: 'wallwright',
  // 8MB x 7 files is a hard 56MB ceiling. Steady state is ~145KB a day, and the
  // worst realistic case (several panels failing, each logging twice per 30s) is
  // around 5MB a day, so this holds well over a week of even that.
  maxBytes: 8 * 1024 * 1024,
  keep: 6,
  // Roughly ten lines a second sustained. Normal operation is nowhere near it.
  maxLinesPerMinute: 600,
};

// 2026-08-24T15:04:05.123-04:00
//
// Local offset rather than UTC, deliberately. Someone reading this alongside the
// Windows event log, or against "the thing that happened at 3pm", should not have
// to do timezone arithmetic. Still sorts correctly within a run.
//
// offsetMinutes is injectable so the format can be tested without depending on
// the machine's zone.
function isoLocal(ms, offsetMinutes) {
  const d = new Date(ms);
  const off = offsetMinutes === undefined ? -d.getTimezoneOffset() : offsetMinutes;
  const shifted = new Date(ms + off * 60000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const abs = Math.abs(off);
  return (
    `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}` +
    `T${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}` +
    `.${p(shifted.getUTCMilliseconds(), 3)}` +
    `${off < 0 ? '-' : '+'}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

// Turns whatever was passed to log()/warn() into one string. Needed because call
// sites pass objects: `warn(id, 'render process gone:', details.reason)` would
// otherwise write "[object Object]" into the one record that explains a crash.
function fmt(x) {
  if (typeof x === 'string') return x;
  if (x instanceof Error) return x.stack || `${x.name}: ${x.message}`;
  if (x === null || x === undefined || typeof x !== 'object') return String(x);
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function createDiagLog(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const now = cfg.now || Date.now;
  const offsetMinutes = cfg.offsetMinutes;

  let dir = cfg.dir || null;
  let file = null;
  let bytes = 0;
  let off = false; // set when writing has failed; never retried
  let reason = null;
  let written = 0;
  let dropped = 0;

  // Rolling one-minute budget.
  let windowStartedAt = 0;
  let inWindow = 0;
  let suppressedInWindow = 0;

  function fail(e) {
    if (off) return;
    off = true;
    reason = e && e.message ? e.message : String(e);
    // Console rather than through this module, for obvious reasons.
    console.warn(`[wallwright] diagnostics log disabled: ${reason}`);
  }

  function open(nextDir) {
    if (nextDir) dir = nextDir;
    if (!dir) return null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, `${cfg.baseName}.log`);
      // Append, never truncate. A second instance that loses the single-instance
      // lock still gets to say so, rather than clobbering the running one's file.
      bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
      off = false;
      reason = null;
    } catch (e) {
      fail(e);
      return null;
    }
    return file;
  }

  // Rename-only, oldest first. Nothing is ever truncated in place, so a reader
  // holding the file open sees a complete file rather than a mangled one.
  function rotate() {
    if (!file) return;
    try {
      const oldest = `${file}.${cfg.keep}`;
      if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
      for (let i = cfg.keep - 1; i >= 1; i--) {
        const from = `${file}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
      }
      if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
      bytes = 0;
    } catch (e) {
      fail(e);
    }
  }

  // Returns false when the line was dropped by the budget, so a caller could
  // count it. Never throws, whatever the filesystem does.
  function write(level, ...args) {
    if (off || !file) return false;
    const at = now();

    if (at - windowStartedAt >= 60000) {
      // Rolling over. If the window that just ended dropped anything, say how
      // much, so a gap in the file is never silent.
      if (suppressedInWindow > 0) {
        const note =
          `${isoLocal(at, offsetMinutes)} warn diagnostics: ` +
          `dropped ${suppressedInWindow} line(s) over the last minute, ` +
          `past the ${cfg.maxLinesPerMinute}/min budget\n`;
        try {
          fs.appendFileSync(file, note);
          bytes += Buffer.byteLength(note);
        } catch (e) {
          fail(e);
          return false;
        }
      }
      windowStartedAt = at;
      inWindow = 0;
      suppressedInWindow = 0;
    }

    if (inWindow >= cfg.maxLinesPerMinute) {
      suppressedInWindow += 1;
      dropped += 1;
      return false;
    }

    const line = `${isoLocal(at, offsetMinutes)} ${level} ${args.map(fmt).join(' ')}\n`;
    try {
      fs.appendFileSync(file, line);
      bytes += Buffer.byteLength(line);
      inWindow += 1;
      written += 1;
      if (bytes >= cfg.maxBytes) rotate();
    } catch (e) {
      fail(e);
      return false;
    }
    return true;
  }

  // One line naming the run, so a log found six months later says what produced
  // it. runId is the join key between this file, /api/status and the soak
  // sampler's CSVs, and it is how a restart is recognised rather than inferred
  // from an uptime that went backwards.
  function banner(fields = {}) {
    const parts = Object.entries(fields).map(([k, v]) => `${k}=${fmt(v)}`);
    return write('info', 'session', ...parts);
  }

  return {
    open,
    write,
    banner,
    path: () => file,
    stats: () => ({ file, bytes, written, dropped, disabled: off, reason }),
    close: () => {
      file = null;
    },
  };
}

module.exports = { createDiagLog, isoLocal, fmt };
