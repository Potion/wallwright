// Serves the mock dashboards, runs one probe against them, forwards its exit
// code. Takes the probe filename as an argument:
//
//   node src/dev/probe-serve.js perm-probe.js
//   node src/dev/probe-serve.js nav-probe.js
//
// One runner rather than a `*-run.js` per probe, which is what session-probe and
// activity-probe each grew separately. The environment is set here rather than as
// a shell prefix, so it works on Windows, which is the platform these most need
// to run on.
//
// It waits for the server to answer instead of sleeping a guessed interval. The
// two older runners both use a fixed 1200ms setTimeout; dev.js polls, and on a
// loaded machine polling is the difference between a probe and a coin toss.
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const electron = require(path.join(ROOT, 'node_modules', 'electron'));
// Deliberately not 8787. A probe that quietly measured somebody else's long-lived
// `npm run dev` server would be worse than no probe at all, and the first run of
// this hit exactly that: the spawn below died with EADDRINUSE, the ping found the
// other server, and the probe reported a page that did not exist as a finding.
const PORT = process.env.WALLWRIGHT_MOCK_PORT || '8799';

const probe = process.argv[2];
if (!probe) {
  console.error('usage: node src/dev/probe-serve.js <probe-file.js>');
  process.exit(2);
}

const server = spawn(process.execPath, [path.join(__dirname, 'mock-server.js')], {
  // Not 'ignore'. Swallowing the child's stderr is what let an EADDRINUSE look
  // like a healthy start.
  stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, WALLWRIGHT_MOCK_PORT: PORT },
});

let serverErr = '';
server.stderr.on('data', (chunk) => (serverErr += chunk));

// If our own server exits before the probe runs, stop. Otherwise the ping below
// can succeed against a completely different process that happens to hold the
// port, and the probe silently measures the wrong thing.
let serverDead = false;
server.on('exit', (code) => {
  serverDead = true;
  if (!ran) {
    const why =
      serverErr
        .trim()
        .split('\n')
        .find((l) => l.includes('Error')) || `exit ${code}`;
    console.error(`[probe] mock server on ${PORT} died before the probe started: ${why}`);
    process.exit(1);
  }
});

const stop = () => {
  if (!server.killed) server.kill();
};
process.on('exit', stop);
process.on('SIGINT', () => {
  stop();
  process.exit(130);
});

let ran = false;

function ping(attempt = 0) {
  if (serverDead) return;
  http
    .get({ host: '127.0.0.1', port: PORT, path: '/dash-1.html' }, (res) => {
      res.resume();
      run();
    })
    .on('error', () => {
      if (attempt > 40) {
        console.error(`[probe] mock server never came up on ${PORT}`);
        stop();
        process.exit(1);
      }
      setTimeout(() => ping(attempt + 1), 100);
    });
}

function run() {
  ran = true;
  const r = spawnSync(electron, [path.join(__dirname, probe)], {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, WALLWRIGHT_MOCK_BASE: `http://localhost:${PORT}` },
  });
  stop();
  process.exit(r.status ?? 1);
}

ping();
