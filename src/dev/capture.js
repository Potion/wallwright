// Launcher for the app's built-in wall capture. The capture itself lives in
// src/main.js so it uses the real layout, the real overlay and the real state
// machine; this only sets the environment and starts the app.
//
//   FORGE_CONFIG=./config/local-demo.json FORGE_CAPTURE_OUT=./wall.png npm run capture
//   ... plus FORGE_START_EDIT=1 FORGE_SELECT=<panel id> to capture the editor
//
// Environment set here rather than as a shell prefix in the npm script, because
// `FOO=1 node ...` is not valid on Windows.

const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

process.env.FORGE_DEV = '1';
process.env.FORGE_CAPTURE_OUT =
  process.env.FORGE_CAPTURE_OUT || path.join(process.cwd(), 'wall.png');

const electron = require(path.join(ROOT, 'node_modules', 'electron'));
const app = spawn(electron, ['.'], { stdio: 'inherit', cwd: ROOT, env: process.env });
app.on('exit', (code) => process.exit(code ?? 0));
