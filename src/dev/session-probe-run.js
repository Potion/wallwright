// Launcher for the session probe: starts the mock server, runs the probe
// against it, then shuts the server down. Environment and process handling in
// node rather than a shell, so this works on Windows too.
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const electron = require(path.join(ROOT, 'node_modules', 'electron'));

const mock = spawn(process.execPath, [path.join(__dirname, 'mock-server.js')], {
  stdio: 'ignore',
  env: process.env,
});

const stop = () => mock.kill();
process.on('exit', stop);
process.on('SIGINT', () => {
  stop();
  process.exit(130);
});

setTimeout(() => {
  const r = spawnSync(electron, [path.join(__dirname, 'session-probe.js')], {
    stdio: 'inherit',
    cwd: ROOT,
    env: process.env,
  });
  stop();
  process.exit(r.status ?? 0);
}, 1200);
