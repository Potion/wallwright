// node --test test/
const test = require('node:test');
const assert = require('node:assert');
const {
  ols,
  medianSlope,
  segments,
  downtime,
  summarize,
  renderSummary,
} = require('../src/dev/soak-stats');

const H = 3600000;
// A sample series: minutes apart, memory following whatever function is passed.
const series = (n, fn, { runId = 'aaa', everyMs = 60000, start = 0 } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    t: start + i * everyMs,
    iso: new Date(start + i * everyMs).toISOString(),
    ok: 1,
    runId,
    memoryMb: fn(i),
  }));

test('a linear series returns its exact slope, and R2 of 1', () => {
  const f = ols([
    [0, 100],
    [1, 110],
    [2, 120],
  ]);
  assert.strictEqual(f.slope, 10);
  assert.strictEqual(f.r2, 1);
  assert.strictEqual(f.n, 3);
});

test('a flat series has slope 0, and is called a perfect fit rather than dividing by zero', () => {
  const f = ols([
    [0, 500],
    [1, 500],
    [2, 500],
  ]);
  assert.strictEqual(f.slope, 0);
  assert.strictEqual(f.r2, 1, 'nothing changing is explained perfectly');
});

test('too few points returns null, not NaN', () => {
  // A NaN in a summary reads as a bug in the app rather than as "not enough data".
  assert.strictEqual(ols([]), null);
  assert.strictEqual(ols([[0, 100]]), null);
  assert.strictEqual(
    ols([
      [5, 100],
      [5, 200],
    ]),
    null,
    'every sample at the same instant has no slope'
  );
});

test('a spike at the centroid does not move the slope at all', () => {
  // Worth knowing before reading any fit: a single outlier sitting exactly at the
  // mean of x has no leverage. Six flat hours with one enormous spike dead centre
  // reports a slope of essentially zero, and only R2 gives the outlier away.
  const centred = series(360, (i) => (i === 180 ? 4000 : 500));
  const fit = ols(centred.map((s) => [s.t / H, s.memoryMb]));
  assert.ok(Math.abs(fit.slope) < 0.5, `slope barely moves (${fit.slope.toFixed(3)})`);
  assert.ok(fit.r2 < 0.1, 'but R2 shows the fit does not describe the data');
});

test('the median cross-check DISAGREES with OLS on a late spike', () => {
  // This is the whole reason the second statistic exists. An outlier with leverage,
  // late in the run, is exactly what a preset recall or a login looks like: OLS is
  // dragged into reporting a leak, and the medians are not.
  const flat = series(360, (i) => (i === 324 ? 4000 : 500));
  const fit = ols(flat.map((s) => [s.t / H, s.memoryMb]));
  const robust = medianSlope(flat);
  assert.ok(
    fit.slope > 3,
    `OLS reports a leak that is not there (${fit.slope.toFixed(2)} MB/h)`
  );
  assert.strictEqual(robust.slope, 0, 'the medians ignore it entirely');
  assert.ok(fit.r2 < 0.1, 'and R2 announces that the fit is meaningless');
});

test('the median cross-check agrees with OLS on a clean ramp', () => {
  const ramp = series(360, (i) => 500 + i * 0.5); // 30MB/hour
  const fit = ols(ramp.map((s) => [s.t / H, s.memoryMb]));
  const robust = medianSlope(ramp);
  assert.ok(Math.abs(fit.slope - 30) < 0.01, `OLS ${fit.slope}`);
  // The medians measure between window midpoints, so they under-read a ramp
  // slightly; agreement in sign and rough magnitude is what is being asserted.
  assert.ok(robust.slope > 20 && robust.slope < 40, `robust ${robust.slope}`);
});

test('segments split on a runId change, so a restart cannot flatten a leak', () => {
  const a = series(10, () => 1000, { runId: 'aaa' });
  const b = series(10, () => 300, { runId: 'bbb', start: 10 * 60000 });
  const segs = segments([...a, ...b]);
  assert.strictEqual(segs.length, 2);
  assert.deepStrictEqual(
    segs.map((s) => s.runId),
    ['aaa', 'bbb']
  );
  // Fitting across the restart would report a large fake decline.
  const across = ols([...a, ...b].map((s) => [s.t / H, s.memoryMb]));
  assert.ok(across.slope < -1000, 'which is why it is never done');
});

test('downtime is derived from runs of failed polls', () => {
  const s = [
    { t: 0, iso: 'a', ok: 1, memoryMb: 500, runId: 'x' },
    { t: 60000, iso: 'b', ok: 0 },
    { t: 120000, iso: 'c', ok: 0 },
    { t: 180000, iso: 'd', ok: 1, memoryMb: 500, runId: 'x' },
  ];
  const d = downtime(s);
  assert.strictEqual(d.length, 1);
  // Measured from the first failed poll to the recovering one. The true outage is
  // bracketed by the poll interval: it began somewhere after the last good sample
  // and ended somewhere before this one, so 120s is a lower bound on a 60s cadence.
  assert.strictEqual(d[0].seconds, 120);
  assert.ok(!d[0].openAtEnd);
});

test('an outage still open at the end of the file is reported, not dropped', () => {
  const s = [
    { t: 0, iso: 'a', ok: 1, memoryMb: 500, runId: 'x' },
    { t: 60000, iso: 'b', ok: 0 },
    { t: 120000, iso: 'c', ok: 0 },
  ];
  const d = downtime(s);
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].openAtEnd, true);
});

test('the summary judges the final window, not the whole run', () => {
  // Warm-up for two hours, then dead flat: the honest verdict is flat.
  const warm = series(120, (i) => 300 + i * 2); // steep for 2h
  const flat = series(1560, () => 540, { start: 120 * 60000 }); // 26h flat
  const sum = summarize([...warm, ...flat], { finalHours: 24, thresholdMbPerHour: 15 });
  assert.ok(sum.overall.mbPerHour > 1, 'the whole run looks like it is climbing');
  assert.ok(Math.abs(sum.finalWindow.mbPerHour) < 0.01, 'the final 24h is flat');
  assert.strictEqual(sum.verdict, 'PASS');
});

test('a real leak fails the threshold', () => {
  const leak = series(1500, (i) => 500 + i * 0.5); // 30MB/hour
  const sum = summarize(leak, { finalHours: 24, thresholdMbPerHour: 15 });
  assert.strictEqual(sum.verdict, 'OVER THRESHOLD');
});

test('the rendered summary always has as many columns as its header', () => {
  const sum = summarize(
    series(200, () => 500),
    { thresholdMbPerHour: 15 }
  );
  const md = renderSummary(sum, { label: 'test', host: 'somewhere' });
  const rows = md.split('\n').filter((l) => l.startsWith('|'));
  const widths = new Set(rows.map((r) => r.split('|').length));
  assert.strictEqual(widths.size, 1, `ragged table: ${[...widths].join(',')}`);
  assert.match(md, /Verdict/);
});

test('the summary survives an empty and an all-failed series', () => {
  const empty = summarize([], { thresholdMbPerHour: 15 });
  assert.strictEqual(empty.samples, 0);
  assert.strictEqual(empty.memory, null);
  assert.doesNotThrow(() => renderSummary(empty));

  const dead = summarize([
    { t: 0, iso: 'a', ok: 0 },
    { t: 60000, iso: 'b', ok: 0 },
  ]);
  assert.strictEqual(dead.ok, 0);
  assert.strictEqual(dead.downtime.length, 1);
  assert.doesNotThrow(() => renderSummary(dead));
});

test('a window too short to mean anything refuses to return a verdict', () => {
  // The harness shake-out fitted 802 MB/hour from seven samples over thirty
  // seconds, while the medians read zero. A verdict from that is worse than none.
  const brief = series(7, (i) => 500 + i, { everyMs: 4000 });
  const sum = summarize(brief, { finalHours: 24, thresholdMbPerHour: 15 });
  assert.strictEqual(sum.verdict, 'INSUFFICIENT DATA');
  assert.match(renderSummary(sum), /Too little to judge/);

  // And a real run does return one.
  const real = series(1500, () => 500);
  assert.strictEqual(
    summarize(real, { finalHours: 24, thresholdMbPerHour: 15 }).verdict,
    'PASS'
  );
});
