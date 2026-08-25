// Runs the self-test against config/selftest.json and exits with its code.
//
// The self-test drives src/main.js over real IPC, which is the only coverage
// that file has. It needs a real display, so this belongs on the self-hosted
// runners rather than in the hosted Linux CI job.
//
// Environment set here rather than as a shell prefix, so it works on Windows.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const electron = require(path.join(ROOT, 'node_modules', 'electron'));

const env = {
  ...process.env,
  WALLWRIGHT_DEV: '1',
  WALLWRIGHT_SELFTEST: '1',
  WALLWRIGHT_CONFIG:
    process.env.WALLWRIGHT_CONFIG || path.join(ROOT, 'config', 'selftest.json'),
};

const r = spawnSync(electron, ['.'], { stdio: 'inherit', cwd: ROOT, env });
if (r.error) {
  console.error('could not start electron:', r.error.message);
  process.exit(1);
}
process.exit(r.status ?? 1);
