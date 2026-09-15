// The soak sampler: polls the wall's control surface and writes a durable series.
//
// Runs beside the app, on the machine under test, because Windows OpenSSH kills the
// whole process tree when the SSH session ends. On Windows this belongs in a
// Scheduled Task; a `Start-Process` over SSH dies after one row, which is a lesson
// already learned the hard way on this fleet.
//
// Zero dependencies and no import from src/, so the soak machine needs only this
// file and soak-stats.js copied across. Flags only, no environment prefixes, so it
// runs on Windows without a shell.
//
//   node src/dev/soak.js --port 8901 --out ./soak --hours 72 --label mini2
//   node src/dev/soak.js --report ./soak/soak-mini2-<stamp>.jsonl
//
// Three behaviours are load-bearing, and none of them is an accident:
//
//   Every poll writes a row. A failed poll writes ok=0 with the error kind rather
//   than nothing, because a gap in a series cannot be told apart from a stopped
//   sampler, while a recorded failure is dated evidence of downtime.
//
//   It never exits on error. It has to survive the app dying at hour 4 and being
//   restarted at 4.1, since that is the single most important thing a soak could
//   discover.
//
//   Each poll is scheduled from the end of the last one, never on an interval.
//   Over four thousand polls, a hung request on a fixed interval stacks.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { summarize, renderSummary } = require('./soak-stats');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const REPORT = arg('report', null);
const PORT = Number(arg('port', 8901));
const HOST = arg('host', '127.0.0.1');
const INTERVAL = Number(arg('interval', 60)) * 1000;
const HOURS = Number(arg('hours', 72));
const OUT = arg('out', path.join(process.cwd(), 'soak'));
const LABEL = arg('label', os.hostname());
const THRESHOLD = arg('threshold', null) === null ? null : Number(arg('threshold', null));
const FINAL_HOURS = Number(arg('final-hours', 24));

// One row per poll. Fixed columns: a header that changes partway through is not a
// file anything can load.
const COLUMNS = [
  'iso',
  'epochMs',
  'elapsedSec',
  'ok',
  'errorKind',
  'runId',
  'appUptimeSec',
  'mode',
  'panelCount',
  // Geometry, in the series rather than only in the app log. The 72-hour baseline
  // walked away from a passing geometry check and a screen grab knocked the window
  // to 1920x1079 at scale 0.999 twelve seconds later, where it sat for 28.4 hours
  // before anyone noticed. The app logs layout only on change, so nothing periodic
  // was watching. Now a geometry change shows up as a step in these three columns.
  'wallWidth',
  'wallHeight',
  'wallScale',
  'memoryMb',
  'memoryPeakMb',
  'mem_Browser',
  'mem_Tab',
  'mem_GPU',
  'mem_Utility',
  'mem_Other',
  'crashes',
  'failedLoads',
  'loads',
  'watchdogReloads',
  'watchdogDeferrals',
  'timerRefreshes',
  'recycles',
  'memoryRecycles',
  'memoryLimitHits',
  'memoryAllInUse',
  'memoryPressure',
  'panelsCrashedNow',
  'panelsLoadingNow',
  'maxReloadAttemptsPeak',
  'urlDrifted',
  'lastRecycleReclaimedMb',
  'lastRecycleGone',
];

const PANEL_COLUMNS = [
  'iso',
  'elapsedSec',
  'runId',
  'panelId',
  'pid',
  'memoryMb',
  'pidShared',
  'crashed',
  'everCrashed',
  'loading',
  'urlDrifted',
  'crashes',
  'failedLoads',
  'loads',
  'watchdogReloads',
  'reloadAttempts',
  'reloadAttemptsPeak',
  'recycleCount',
  'timerRefreshes',
  'lastUsedSecAgo',
  'gaveUp',
];

const KNOWN_TYPES = ['Browser', 'Tab', 'GPU', 'Utility'];

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function get(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ errorKind: `http_${res.statusCode}` });
        try {
          resolve({ status: JSON.parse(body) });
        } catch {
          resolve({ errorKind: 'bad_json' });
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ errorKind: 'timeout' });
    });
    req.on('error', (e) => {
      resolve({ errorKind: (e.code || 'other').toLowerCase() });
    });
  });
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = path.join(OUT, `soak-${LABEL}-${stamp}`);
  const csv = `${base}.csv`;
  const panelsCsv = `${base}-panels.csv`;
  const jsonl = `${base}.jsonl`;
  const summaryPath = `${base}-summary.md`;

  fs.writeFileSync(csv, COLUMNS.join(',') + '\n');
  fs.writeFileSync(panelsCsv, PANEL_COLUMNS.join(',') + '\n');

  // Enough about the machine to make the numbers interpretable later. Without it a
  // memory figure is uninterpretable the moment anyone forgets which box it was.
  fs.writeFileSync(
    `${base}-machine.json`,
    JSON.stringify(
      {
        label: LABEL,
        host: os.hostname(),
        platform: `${process.platform}-${process.arch}`,
        release: os.release(),
        cpu: (os.cpus()[0] || {}).model || null,
        cpus: os.cpus().length,
        totalMemGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
        node: process.version,
        startedIso: new Date().toISOString(),
        url: `http://${HOST}:${PORT}/api/status`,
        intervalSec: INTERVAL / 1000,
        plannedHours: HOURS,
        thresholdMbPerHour: THRESHOLD,
      },
      null,
      2
    ) + '\n'
  );

  const started = Date.now();
  const samples = [];
  let lastRunId = null;

  const writeSummary = () => {
    const sum = summarize(samples, { finalHours: FINAL_HOURS, thresholdMbPerHour: THRESHOLD });
    // Write to a temp file and rename, so a reader never sees half a summary and a
    // reboot at hour 71 still leaves the last complete one.
    const tmp = `${summaryPath}.tmp`;
    fs.writeFileSync(tmp, renderSummary(sum, { label: LABEL, host: os.hostname() }));
    fs.renameSync(tmp, summaryPath);
    return sum;
  };

  const poll = async () => {
    const now = Date.now();
    const iso = new Date(now).toISOString();
    const elapsed = Math.round((now - started) / 1000);
    const r = await get(`http://${HOST}:${PORT}/api/status`);

    const row = { iso, epochMs: now, elapsedSec: elapsed, ok: r.status ? 1 : 0 };
    const sample = { t: now, iso, ok: row.ok };

    if (!r.status) {
      row.errorKind = r.errorKind;
    } else {
      const s = r.status;
      const c = s.counters || {};
      const byType = s.memoryByType || {};
      const other = Object.keys(byType)
        .filter((k) => !KNOWN_TYPES.includes(k))
        .reduce((a, k) => a + byType[k], 0);
      const panels = s.panels || [];
      const drifted = panels.filter((p) => p.currentUrl && p.url && p.currentUrl !== p.url);
      const lastRecycle = (s.recycles || []).slice(-1)[0] || {};

      Object.assign(row, {
        runId: s.runId,
        appUptimeSec: s.uptimeSec,
        mode: s.mode,
        panelCount: panels.length,
        wallWidth: s.wall ? s.wall.width : '',
        wallHeight: s.wall ? s.wall.height : '',
        wallScale: s.wall ? s.wall.scale : '',
        memoryMb: s.memoryMb,
        memoryPeakMb: s.memoryPeakMb,
        mem_Browser: byType.Browser ?? '',
        mem_Tab: byType.Tab ?? '',
        mem_GPU: byType.GPU ?? '',
        mem_Utility: byType.Utility ?? '',
        mem_Other: other || '',
        crashes: c.crashes,
        failedLoads: c.failedLoads,
        loads: c.loads,
        watchdogReloads: c.watchdogReloads,
        watchdogDeferrals: c.watchdogDeferrals,
        timerRefreshes: c.timerRefreshes,
        recycles: c.recycles,
        memoryRecycles: c.memoryRecycles,
        memoryLimitHits: c.memoryLimitHits,
        memoryAllInUse: c.memoryAllInUse,
        memoryPressure: s.memoryPressure ? 1 : 0,
        panelsCrashedNow: panels.filter((p) => p.crashed).length,
        panelsLoadingNow: panels.filter((p) => p.loading).length,
        maxReloadAttemptsPeak: panels.reduce(
          (a, p) => Math.max(a, p.reloadAttemptsPeak || 0),
          0
        ),
        urlDrifted: drifted.length,
        lastRecycleReclaimedMb: lastRecycle.reclaimedMb ?? '',
        lastRecycleGone: lastRecycle.gone === undefined ? '' : lastRecycle.gone ? 1 : 0,
      });

      Object.assign(sample, {
        runId: s.runId,
        memoryMb: s.memoryMb,
        counters: c,
        urlDrifted: drifted.length > 0,
      });

      // A changed runId means the process restarted. Say so in the record: memory
      // drops back to a few hundred MB and any slope fitted across it is a lie.
      if (lastRunId && s.runId && s.runId !== lastRunId) {
        fs.appendFileSync(
          jsonl,
          JSON.stringify({ t: now, iso, event: 'restart', from: lastRunId, to: s.runId }) + '\n'
        );
      }
      lastRunId = s.runId || lastRunId;

      // One row per panel per poll, in its own file: panels can be added or removed
      // mid-run, and a CSV whose columns change partway is not loadable.
      for (const p of panels) {
        const pr = {
          iso,
          elapsedSec: elapsed,
          runId: s.runId,
          panelId: p.id,
          pid: p.pid,
          memoryMb: p.memoryMb,
          pidShared: p.pidShared ? 1 : 0,
          crashed: p.crashed ? 1 : 0,
          everCrashed: p.everCrashed ? 1 : 0,
          loading: p.loading ? 1 : 0,
          urlDrifted: p.currentUrl && p.url && p.currentUrl !== p.url ? 1 : 0,
          crashes: p.crashes,
          failedLoads: p.failedLoads,
          loads: p.loads,
          watchdogReloads: p.watchdogReloads,
          reloadAttempts: p.reloadAttempts,
          reloadAttemptsPeak: p.reloadAttemptsPeak,
          recycleCount: p.recycleCount,
          timerRefreshes: p.timerRefreshes,
          lastUsedSecAgo: p.lastUsedSecAgo,
          gaveUp: p.gaveUp ? 1 : 0,
        };
        fs.appendFileSync(panelsCsv, PANEL_COLUMNS.map((k) => csvCell(pr[k])).join(',') + '\n');
      }

      // The raw body too. It is the only way to answer a question the columns did
      // not anticipate, which over 72 hours is a question worth being able to ask.
      fs.appendFileSync(jsonl, JSON.stringify({ t: now, iso, status: s }) + '\n');
    }

    fs.appendFileSync(csv, COLUMNS.map((k) => csvCell(row[k])).join(',') + '\n');
    samples.push(sample);
    writeSummary();

    if (Date.now() - started >= HOURS * 3600000) {
      const sum = writeSummary();
      console.log(`done: ${samples.length} samples, verdict ${sum.verdict}`);
      // Non-zero if anything went wrong, so this can gate something later.
      process.exit(sum.failed > 0 || sum.verdict === 'OVER THRESHOLD' ? 1 : 0);
    }
    // From the end of this poll, not on a fixed interval.
    setTimeout(poll, INTERVAL);
  };

  const stop = () => {
    const sum = writeSummary();
    console.log(`stopped: ${samples.length} samples, verdict ${sum.verdict}`);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  console.log(
    `sampling http://${HOST}:${PORT}/api/status every ${INTERVAL / 1000}s -> ${base}.csv`
  );
  poll();
}

// Recompute a summary from a jsonl a previous run wrote, so a botched summary is
// never a lost run.
function report(file) {
  const samples = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.status)
    .map((r) => ({
      t: r.t,
      iso: r.iso,
      ok: 1,
      runId: r.status.runId,
      memoryMb: r.status.memoryMb,
      counters: r.status.counters || {},
    }));
  const sum = summarize(samples, { finalHours: FINAL_HOURS, thresholdMbPerHour: THRESHOLD });
  process.stdout.write(renderSummary(sum, { label: LABEL, host: os.hostname() }));
}

if (REPORT) report(REPORT);
else main();
