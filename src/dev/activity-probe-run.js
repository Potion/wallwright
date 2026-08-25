// Starts the mock server, runs the activity probe against it, and forwards the
// exit code. Same shape as session-probe-run.js: environment set here rather than
// as a shell prefix, so it works on Windows.
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const electron = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = process.env.WALLWRIGHT_MOCK_PORT || '8787';

const server = spawn(process.execPath, [path.join(__dirname, 'mock-server.js')], {
  stdio: 'ignore',
  env: { ...process.env, WALLWRIGHT_MOCK_PORT: PORT },
});

setTimeout(() => {
  const r = spawnSync(electron, [path.join(__dirname, 'activity-probe.js')], {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, WALLWRIGHT_MOCK_BASE: `http://localhost:${PORT}` },
  });
  server.kill();
  process.exit(r.status ?? 1);
}, 1200);
