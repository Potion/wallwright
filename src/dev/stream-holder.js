// Holds a panel stream open for the length of a soak, and writes down that it
// did.
//
// The soak sampler (src/dev/soak.js) polls /api/status and nothing else, so the
// 72-hour baseline never exercised streaming at all. Streaming attaches a CDP
// debugger and runs capturePage on an idle keepalive, which is the shape that
// leaks, so a soak that does not hold a stream cannot answer whether it does.
//
// A browser tab can hold the stream instead, but not for three days: a laptop
// sleeps, a tab gets closed, and the run quietly degrades into the baseline
// without saying so. This runs on the wall machine itself.
//
// It counts frames and bytes and throws them away. Buffering anything here would
// make the holder the leak.
//
//   node src/dev/stream-holder.js --port 8901 --panel heavy --out ./hold.log

const http = require('node:http');
const fs = require('node:fs');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(arg('port', 8901));
const HOST = arg('host', '127.0.0.1');
const PANEL = arg('panel', 'heavy');
const QUALITY = Number(arg('q', 70));
const WIDTH = Number(arg('w', 1600));
const OUT = arg('out', '');
const REPORT_MS = Number(arg('report', 60000));
// Long enough not to spin against an app that is down, short enough that a
// restart is covered well inside one sampler interval.
const RETRY_MS = 3000;

let frames = 0;
let bytes = 0;
let reconnects = 0;
let refusals = 0;
let attachedSince = 0;
let attachedMs = 0;
let live = false;
const startedAt = Date.now();

function say(line) {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  if (OUT) {
    try {
      fs.appendFileSync(OUT, stamped + '\n');
    } catch {
      /* a full disk must not kill the holder */
    }
  }
}

function connect() {
  const path = `/api/stream?id=${encodeURIComponent(PANEL)}&q=${QUALITY}&w=${WIDTH}`;
  const req = http.get({ host: HOST, port: PORT, path }, (res) => {
    if (res.statusCode !== 200) {
      // Almost always another viewer holding the one stream slot. Worth counting
      // rather than ignoring: a run where this is nonzero was not measuring what
      // it thinks it was.
      refusals++;
      res.resume();
      res.on('end', () => setTimeout(connect, RETRY_MS));
      return;
    }
    live = true;
    attachedSince = Date.now();
    say(`attached to ${PANEL} q=${QUALITY} w=${WIDTH}`);

    const BOUNDARY = Buffer.from('--wallwrightframe');
    let tail = Buffer.alloc(0);
    res.on('data', (chunk) => {
      bytes += chunk.length;
      // Count boundaries without keeping the frames. Only the last few bytes are
      // carried over, in case a boundary is split across two chunks.
      const hay = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      let i = 0;
      while ((i = hay.indexOf(BOUNDARY, i)) !== -1) {
        frames++;
        i += BOUNDARY.length;
      }
      tail = hay.subarray(Math.max(0, hay.length - BOUNDARY.length));
    });

    const dropped = () => {
      if (!live) return;
      live = false;
      attachedMs += Date.now() - attachedSince;
      reconnects++;
      say(`stream dropped after ${frames} frames; reconnecting`);
      setTimeout(connect, RETRY_MS);
    };
    res.on('end', dropped);
    res.on('error', dropped);
  });
  req.on('error', () => {
    if (live) {
      live = false;
      attachedMs += Date.now() - attachedSince;
    }
    setTimeout(connect, RETRY_MS);
  });
}

setInterval(() => {
  const held = attachedMs + (live ? Date.now() - attachedSince : 0);
  const elapsed = Date.now() - startedAt;
  const pct = elapsed ? ((held / elapsed) * 100).toFixed(1) : '0.0';
  say(
    `held ${pct}% of ${Math.round(elapsed / 1000)}s | frames ${frames} | ` +
      `${Math.round(bytes / 1024 / 1024)}MB | reconnects ${reconnects} | refused ${refusals} | ` +
      `live ${live}`
  );
}, REPORT_MS).unref?.();

say(`holding ${PANEL} on ${HOST}:${PORT}`);
connect();
