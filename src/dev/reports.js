// Renders every report in docs/report/ to PDF. A node runner rather than two
// shell commands, so it works on Windows too.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const electron = require(path.join(ROOT, 'node_modules', 'electron'));

const reports = [
  ['docs/report/comparison.html', 'docs/report/wallwright-vs-commercial.pdf'],
  ['docs/report/hiperwall.html', 'docs/report/wallwright-vs-hiperwall.pdf'],
];

let failed = 0;
for (const [src, out] of reports) {
  const r = spawnSync(electron, [path.join(__dirname, 'make-pdf.js'), src, out], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  if (r.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
