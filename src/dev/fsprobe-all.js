// Runs every fsprobe variant, each in its own process. A node runner rather
// than a shell loop in the npm script, because the shell loop only worked on
// POSIX and the platform this most needs to run on is Windows.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const VARIANTS = ['ctor_both', 'ctor_kiosk', 'ctor_fs', 'set_kiosk', 'set_simple'];
const electron = require(path.join(__dirname, '..', '..', 'node_modules', 'electron'));
const script = path.join(__dirname, 'fsprobe.js');

let failed = 0;
for (const v of VARIANTS) {
  const r = spawnSync(electron, [script, v], { encoding: 'utf8' });
  const line = String(r.stdout || '')
    .split('\n')
    .find((l) => l.startsWith('FSPROBE '));
  if (line) console.log(line);
  else {
    failed++;
    console.error(
      `no result for ${v}` + (r.stderr ? ': ' + r.stderr.trim().split('\n')[0] : '')
    );
  }
}
process.exit(failed ? 1 : 0);
