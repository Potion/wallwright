// Dev launcher: starts the mock dashboard server, waits for it to answer, then
// launches Electron against config/local-dev.json. Dev only.

const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const PORT = Number(process.env.FORGE_MOCK_PORT || 8787);
const ROOT = path.join(__dirname, '..', '..');

const mock = spawn(process.execPath, [path.join(__dirname, 'mock-server.js')], {
  stdio: 'inherit',
  env: process.env,
});

function ping(attempt = 0) {
  http
    .get({ host: '127.0.0.1', port: PORT, path: '/dash-1.html' }, (res) => {
      res.resume();
      launch();
    })
    .on('error', () => {
      if (attempt > 40) {
        console.error(`[dev] mock server never came up on ${PORT}`);
        mock.kill();
        process.exit(1);
      }
      setTimeout(() => ping(attempt + 1), 100);
    });
}

function launch() {
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const app = spawn(electron, ['.'], { stdio: 'inherit', cwd: ROOT, env: process.env });
  app.on('exit', (code) => {
    mock.kill();
    process.exit(code ?? 0);
  });
}

process.on('SIGINT', () => {
  mock.kill();
  process.exit(0);
});

ping();
