// Launcher for the app's built-in wall capture. The capture itself lives in
// src/dev/capture-wall.js, required lazily by main.js so it uses the real layout,
// the real overlay and the real state machine; this only sets the environment and
// starts the app.
//
//   WALLWRIGHT_CONFIG=./config/local-demo.json WALLWRIGHT_CAPTURE_OUT=./wall.png npm run capture
//   ... plus WALLWRIGHT_START_EDIT=1 WALLWRIGHT_SELECT=<panel id> to capture the editor
//
// Environment set here rather than as a shell prefix in the npm script, because
// `FOO=1 node ...` is not valid on Windows.

const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

process.env.WALLWRIGHT_DEV = '1';
process.env.WALLWRIGHT_CAPTURE_OUT =
  process.env.WALLWRIGHT_CAPTURE_OUT || path.join(process.cwd(), 'wall.png');

const electron = require(path.join(ROOT, 'node_modules', 'electron'));
const app = spawn(electron, ['.'], { stdio: 'inherit', cwd: ROOT, env: process.env });
app.on('exit', (code) => process.exit(code ?? 0));
