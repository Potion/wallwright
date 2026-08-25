// Analysis for the soak sampler. Pure functions over an array of samples, so the
// statistics can be tested rather than trusted, and so a botched summary is never
// a lost run: `soak.js --report existing.csv` recomputes it offline.
//
// A sample is `{ t, iso, ok, runId, memoryMb, ... }` where `t` is epoch ms and
// `ok` is 0 when the poll failed. Failed polls are kept, deliberately: a gap in a
// series is indistinguishable from a stopped sampler, while a recorded failure is
// dated evidence of downtime.

// Ordinary least squares on (hours, MB), returning MB/hour.
//
// Returns null rather than NaN for a series too short to fit. A NaN in a summary
// reads as a bug in the app rather than as "not enough data yet".
function ols(points) {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (const [x, y] of points) {
    sx += x;
    sy += y;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  for (const [x, y] of points) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) * (x - mx);
  }
  if (sxx === 0) return null; // every sample at the same instant
  const slope = sxy / sxx;
  const intercept = my - slope * mx;

  let ssTot = 0;
  let ssRes = 0;
  for (const [x, y] of points) {
    ssTot += (y - my) * (y - my);
    const fit = slope * x + intercept;
    ssRes += (y - fit) * (y - fit);
  }
  // A flat series has no variance to explain. Call that a perfect fit rather than
  // dividing by zero: it is the honest reading of "nothing is changing".
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { slope, intercept, r2, n };
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// The robust cross-check on the OLS slope: the difference between the median of
// the last hour and the median of the first hour, over the hours between them.
//
// Two statistics on purpose. OLS on a series with one spike reports a slope driven
// by the spike, so a fit that disagrees with this is a fit not to be trusted.
function medianSlope(samples, windowMs = 3600000) {
  const ok = samples.filter((s) => s.ok && Number.isFinite(s.memoryMb));
  if (ok.length < 4) return null;
  const first = ok[0].t;
  const last = ok[ok.length - 1].t;
  const spanHours = (last - first) / 3600000;
  if (spanHours <= 0) return null;
  const head = ok.filter((s) => s.t <= first + windowMs).map((s) => s.memoryMb);
  const tail = ok.filter((s) => s.t >= last - windowMs).map((s) => s.memoryMb);
  const a = median(head);
  const b = median(tail);
  if (a === null || b === null) return null;
  // Measured between the window midpoints, not the endpoints, or a short run
  // divides by almost nothing and reports an enormous slope.
  const gapHours = Math.max(spanHours - windowMs / 3600000, spanHours / 2);
  return { slope: (b - a) / gapHours, headMb: a, tailMb: b, hours: gapHours };
}

// Split on runId change. A restart drops memory back to a few hundred MB, and one
// fit across it flattens a real leak into nothing, so every slope is per segment.
function segments(samples) {
  const out = [];
  let cur = null;
  for (const s of samples) {
    if (!s.ok) continue;
    if (!cur || (s.runId && cur.runId && s.runId !== cur.runId)) {
      cur = { runId: s.runId || null, samples: [] };
      out.push(cur);
    }
    cur.samples.push(s);
  }
  return out;
}

// Runs of failed polls, including one still open at the end of the file.
//
// `seconds` runs from the first failed poll to the one that recovered, which is a
// lower bound: the outage began somewhere in the interval before the first failure
// and ended somewhere in the interval before the recovery, so the true duration is
// bracketed by the poll cadence. Worth knowing before quoting it to anybody.
function downtime(samples) {
  const out = [];
  let start = null;
  for (const s of samples) {
    if (!s.ok && start === null) start = s;
    if (s.ok && start !== null) {
      out.push({
        fromIso: start.iso,
        toIso: s.iso,
        seconds: Math.round((s.t - start.t) / 1000),
      });
      start = null;
    }
  }
  if (start !== null) {
    const last = samples[samples.length - 1];
    out.push({
      fromIso: start.iso,
      toIso: last.iso,
      seconds: Math.round((last.t - start.t) / 1000),
      openAtEnd: true,
    });
  }
  return out;
}

function summarize(samples, { finalHours = 24, thresholdMbPerHour = null } = {}) {
  const ok = samples.filter((s) => s.ok && Number.isFinite(s.memoryMb));
  const segs = segments(samples);
  const longest = segs.reduce(
    (a, b) => (b.samples.length > (a ? a.samples.length : 0) ? b : a),
    null
  );

  const fit = (rows) => {
    const f = ols(rows.map((s) => [s.t / 3600000, s.memoryMb]));
    return f ? { mbPerHour: f.slope, r2: f.r2, n: f.n } : null;
  };

  let finalWindow = null;
  if (longest && longest.samples.length) {
    const end = longest.samples[longest.samples.length - 1].t;
    const rows = longest.samples.filter((s) => s.t >= end - finalHours * 3600000);
    finalWindow = fit(rows);
  }

  const mem = ok.map((s) => s.memoryMb);
  const counters = ok.length ? ok[ok.length - 1].counters || {} : {};
  const drift = samples.filter((s) => s.ok && s.urlDrifted).length;

  const overall = longest ? fit(longest.samples) : null;
  const robust = longest ? medianSlope(longest.samples) : null;

  // A slope fitted over a few minutes of Chromium warm-up is not a finding, and a
  // verdict printed from it is worse than none: it looks like an answer. So the
  // window has to be long enough to mean something before anything is declared.
  // Demonstrated by the harness shake-out: seven samples over thirty seconds fitted
  // 802 MB/hour while the medians read zero.
  const windowSpanHours =
    longest && longest.samples.length > 1
      ? (longest.samples[longest.samples.length - 1].t - longest.samples[0].t) / 3600000
      : 0;
  const enough =
    finalWindow && finalWindow.n >= 30 && windowSpanHours >= Math.min(finalHours, 6) * 0.5;

  let verdict;
  if (thresholdMbPerHour === null) verdict = 'no threshold set';
  else if (!enough) verdict = 'INSUFFICIENT DATA';
  else verdict = finalWindow.mbPerHour <= thresholdMbPerHour ? 'PASS' : 'OVER THRESHOLD';

  return {
    samples: samples.length,
    ok: ok.length,
    failed: samples.length - ok.length,
    firstIso: samples.length ? samples[0].iso : null,
    lastIso: samples.length ? samples[samples.length - 1].iso : null,
    hours: samples.length ? (samples[samples.length - 1].t - samples[0].t) / 3600000 : 0,
    restarts: Math.max(segs.length - 1, 0),
    segmentRunIds: segs.map((g) => g.runId),
    downtime: downtime(samples),
    memory: mem.length
      ? {
          firstMb: mem[0],
          lastMb: mem[mem.length - 1],
          minMb: Math.min(...mem),
          maxMb: Math.max(...mem),
          meanMb: Math.round(mem.reduce((a, b) => a + b, 0) / mem.length),
        }
      : null,
    overall,
    finalWindow,
    finalHours,
    robust,
    counters,
    urlDriftSamples: drift,
    thresholdMbPerHour,
    windowSpanHours,
    verdict,
  };
}

function num(x, dp = 2) {
  return x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : x.toFixed(dp);
}

function renderSummary(sum, extra = {}) {
  const L = [];
  L.push('# Soak summary');
  L.push('');
  if (extra.label) L.push(`Label: ${extra.label}`);
  if (extra.host) L.push(`Host: ${extra.host}`);
  L.push(`Window: ${sum.firstIso} to ${sum.lastIso} (${num(sum.hours, 1)}h)`);
  L.push(`Samples: ${sum.samples}, ok ${sum.ok}, failed ${sum.failed}`);
  L.push(
    `Restarts: ${sum.restarts}${sum.restarts ? ` (runIds ${sum.segmentRunIds.join(' -> ')})` : ''}`
  );
  L.push('');
  if (sum.memory) {
    L.push('## Memory');
    L.push('');
    L.push(
      `first ${sum.memory.firstMb}MB, last ${sum.memory.lastMb}MB, ` +
        `min ${sum.memory.minMb}MB, max ${sum.memory.maxMb}MB, mean ${sum.memory.meanMb}MB`
    );
    L.push('');
    L.push('| fit | MB/hour | R2 | samples |');
    L.push('| --- | --- | --- | --- |');
    if (sum.overall)
      L.push(
        `| whole longest segment | ${num(sum.overall.mbPerHour)} | ${num(sum.overall.r2, 3)} | ${sum.overall.n} |`
      );
    if (sum.finalWindow)
      L.push(
        `| **final ${sum.finalHours}h** | **${num(sum.finalWindow.mbPerHour)}** | ${num(sum.finalWindow.r2, 3)} | ${sum.finalWindow.n} |`
      );
    if (sum.robust)
      L.push(
        `| median cross-check | ${num(sum.robust.slope)} | - | head ${num(sum.robust.headMb, 0)}MB tail ${num(sum.robust.tailMb, 0)}MB |`
      );
    L.push('');
    L.push('The final window is the one that matters: Chromium climbs for hours before');
    L.push('it settles, so an early fit measures warm-up. The median cross-check must');
    L.push('agree in sign and rough magnitude, or the fit is being driven by a spike.');
    L.push('');
  }
  if (sum.downtime.length) {
    L.push('## Downtime');
    L.push('');
    for (const d of sum.downtime) {
      L.push(
        `- ${d.fromIso} to ${d.toIso}, ${d.seconds}s${d.openAtEnd ? ' (still down at end of file)' : ''}`
      );
    }
    L.push('');
  }
  L.push('## Counters at the end');
  L.push('');
  const keys = Object.keys(sum.counters);
  if (!keys.length) L.push('none recorded');
  else for (const k of keys) L.push(`- ${k}: ${sum.counters[k]}`);
  L.push('');
  L.push(`URL drift samples: ${sum.urlDriftSamples}`);
  L.push('');
  L.push(`## Verdict: ${sum.verdict}`);
  if (sum.verdict === 'INSUFFICIENT DATA') {
    L.push('');
    L.push(
      `Too little to judge: ${sum.finalWindow ? sum.finalWindow.n : 0} samples over ` +
        `${num(sum.windowSpanHours, 2)}h. A slope fitted across Chromium's warm-up is not a` +
        ' finding, and a verdict printed from one only looks like an answer.'
    );
  }
  if (sum.thresholdMbPerHour !== null) {
    L.push('');
    L.push(
      `Threshold ${sum.thresholdMbPerHour} MB/hour over the final ${sum.finalHours}h, ` +
        'pre-registered before the run.'
    );
  }
  return L.join('\n') + '\n';
}

module.exports = { ols, median, medianSlope, segments, downtime, summarize, renderSummary };
