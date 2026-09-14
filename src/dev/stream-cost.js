// What the tablet control surface costs the wall.
//
// Every figure gathered while building the control surface measured the
// TABLET's experience: frames delivered, bytes on the wire, clicks landing. None
// of it measured the thing that actually matters on a show floor, which is
// whether the wall keeps its own frame rate while a tablet is watching.
//
// This answers that. It drives a panel showing src/dev/mock/soak-heavy.html -
// WebGL cube, 2D canvas, a rotating globe, the content class the real exhibit
// uses - and reads the frame counter that page already keeps. Baseline first
// with nothing attached, then again at each quality with a stream running. The
// difference is the cost.
//
// Dev only. Assumes the app is already up with its control surface reachable.
//
//   node src/dev/stream-cost.js [--control 8799] [--mock 8787] [--panel view-1]

const http = require('node:http');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const CONTROL = Number(opt('control', 8799));
const MOCK = Number(opt('mock', 8787));
const PANEL = opt('panel', 'view-1');
const SAMPLE_MS = Number(opt('sample', 8000));
// Which mock page to put on the panel. soak-heavy is the default because the
// 72h soak already validates it; globe.html and dash-ops.html are the pages that
// look like the exhibit's real content.
const PAGE = opt('page', 'soak-heavy.html');

function get(port, path) {
  return new Promise((resolve) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      })
      .on('error', () => resolve(null));
  });
}

function post(path, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: CONTROL,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', () => resolve(0));
    req.end(body);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function frames() {
  const raw = await get(MOCK, '/fps-state');
  try {
    const all = JSON.parse(raw || '{}');
    return all[PANEL] ? all[PANEL].frames : null;
  } catch {
    return null;
  }
}

// Panel frames per second over the sample window, with an optional stream
// attached for the whole of it.
async function sample(quality, width) {
  let bytes = 0;
  let parts = 0;
  let req = null;
  let refused = 0;

  if (quality !== null) {
    await new Promise((resolve) => {
      req = http.get(
        {
          host: '127.0.0.1',
          port: CONTROL,
          path: `/api/stream?id=${PANEL}&q=${quality}&w=${width}`,
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            req = null;
            // Loudly, because a sample that quietly ran without a stream reads
            // as "streaming is free" and is the most misleading result this
            // script could produce. A 400 here is almost always another viewer
            // holding the one stream slot.
            refused = res.statusCode;
            return resolve();
          }
          let buf = Buffer.alloc(0);
          const B = Buffer.from('--wallwrightframe');
          res.on('data', (c) => {
            bytes += c.length;
            buf = Buffer.concat([buf, c]);
            let i = 0;
            let n = 0;
            while ((i = buf.indexOf(B, i)) !== -1) {
              n++;
              i += B.length;
            }
            parts = n;
            // Keep the tail only: this runs for minutes and the buffer is only
            // here to count boundaries.
            if (buf.length > 2e6) buf = buf.subarray(-5e5);
          });
          resolve();
        }
      );
      req.on('error', () => {
        req = null;
        resolve();
      });
    });
    // Let the stream settle before the clock starts.
    await wait(1000);
  }

  const before = await frames();
  const t0 = Date.now();
  await wait(SAMPLE_MS);
  const after = await frames();
  const secs = (Date.now() - t0) / 1000;
  if (req) req.destroy();

  if (refused) {
    return {
      err: `the wall refused the stream (HTTP ${refused}) - is something else watching?`,
    };
  }
  if (before === null || after === null) return { err: 'the panel is not reporting frames' };
  // The counter only ever climbs. Going backwards means the page reloaded inside
  // the window - a watchdog, a recycle, a crash - and the sample is meaningless.
  // Worth catching loudly: a reset reads as "the frame rate collapsed", which is
  // the wrong conclusion drawn from the right number.
  if (after < before) return { err: 'the panel reloaded mid-sample; rerun' };
  if (quality !== null && parts < 2) {
    return { err: 'the stream attached but delivered no frames' };
  }
  return {
    fps: +((after - before) / secs).toFixed(1),
    streamFps: quality === null ? null : +((parts - 1) / secs).toFixed(1),
    kbs: quality === null ? null : Math.round(bytes / secs / 1024),
  };
}

(async () => {
  const status = await get(CONTROL, '/api/status');
  if (!status) {
    console.error(`[stream-cost] no control surface on ${CONTROL}. Is the app running?`);
    process.exit(1);
  }

  const url = `http://localhost:${MOCK}/${PAGE}?fps=1&id=${encodeURIComponent(PANEL)}`;
  console.log(`[stream-cost] pointing ${PANEL} at ${url}`);
  const code = await post('/api/panel', { id: PANEL, patch: { url } });
  if (code !== 200) {
    console.error(`[stream-cost] could not set the panel url (HTTP ${code})`);
    process.exit(1);
  }
  // The page has to load and start reporting before anything is worth reading.
  // globe.html pulls a library and two textures off a CDN, so it needs longer
  // than a local page does.
  await wait(PAGE.indexOf('globe') >= 0 ? 12000 : 6000);

  console.log(`[stream-cost] ${SAMPLE_MS / 1000}s per sample\n`);
  const rows = [];
  rows.push(['no stream', await sample(null, null)]);
  for (const [q, w] of [
    [40, 1600],
    [70, 1600],
    [90, 1600],
    [70, 960],
    [70, 640],
    [40, 640],
  ]) {
    await wait(1500);
    rows.push([`q=${q} w=${w}`, await sample(q, w)]);
  }

  const base = rows[0][1].fps;
  console.log('  condition       panel fps   vs baseline   stream fps   bandwidth');
  for (const [label, r] of rows) {
    if (r.err) {
      console.log(`  ${label.padEnd(15)} ${r.err}`);
      continue;
    }
    const delta = label === 'no stream' ? '' : `${(((r.fps - base) / base) * 100).toFixed(1)}%`;
    console.log(
      '  ' +
        label.padEnd(15) +
        String(r.fps).padStart(9) +
        delta.padStart(14) +
        String(r.streamFps === null ? '-' : r.streamFps).padStart(13) +
        (r.kbs === null ? '-' : r.kbs + ' KB/s').padStart(12)
    );
  }
  console.log(
    '\n  The middle column is the whole point: how much of the wall a watching\n' +
      '  tablet costs. The wall is the deliverable; the tablet is the accessory.'
  );
  process.exit(0);
})();
