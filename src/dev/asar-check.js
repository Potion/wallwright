#!/usr/bin/env node
//
// Asserts what is and is not inside a packaged app.asar.
//
// `electron-builder.yml` excludes `src/dev/**`, and that exclusion has been
// correct every time anyone has looked. The problem is that nothing ever looks.
// The `files` list is a glob array in a YAML file: a later entry, a re-ordering,
// or a switch to `asar.unpack` can quietly re-include the dev harness, and the
// failure is silent, because a shipped exhibit that also contains a mock server
// and six probes still starts up perfectly.
//
// What ships is a security question rather than a tidiness one. `src/dev/`
// contains a mock server that binds a port, probe scripts that disable web
// security, and `selftest-run.js`. None of that belongs on a show floor machine
// inside a Honeywell building.
//
// This reads the real artifact rather than the config that produced it, which is
// the difference between asserting the intent and asserting the outcome. There is
// a unit test over the config too (`test/packaging.test.js`), and it is the fast
// guard; this is the true one, and it runs in the build workflows where an asar
// exists.
//
// Usage:
//   node src/dev/asar-check.js                    # finds the asar under dist/
//   node src/dev/asar-check.js path/to/app.asar
'use strict';

const fs = require('fs');
const path = require('path');

// Paths that must never appear. Prefix-matched against every entry in the
// archive, using forward slashes, which is what asar stores regardless of host.
const FORBIDDEN = [
  { prefix: 'src/dev/', why: 'the dev harness: mock server, probes, the self-test' },
  { prefix: 'test/', why: 'the unit tests' },
  {
    prefix: 'node_modules/electron/',
    why: 'the Electron binary should not be inside its own app',
  },
  { prefix: '.github/', why: 'CI configuration' },
  { prefix: 'docs/', why: 'documentation, including the soak evidence' },
];

// Paths that must appear. A packaging change that drops one of these produces an
// app that fails at runtime rather than one that leaks, so it is the other half
// of the same question and cheaper to catch here than on a show floor.
const REQUIRED = [
  { file: 'src/main.js', why: 'the entry point' },
  { file: 'src/overlay.js', why: 'the overlay renderer' },
  { file: 'src/preload.js', why: 'the overlay bridge' },
  { file: 'src/content-preload.js', why: 'the per-panel activity bridge' },
  {
    file: 'config/wall.json',
    why: 'the default config the app copies into userData on first run',
  },
  { file: 'package.json', why: 'electron reads main and version from it' },
];

// Walk the asar header into a flat list of file paths.
function listFiles(asarPath) {
  // @electron/asar arrives with electron-builder. Required lazily so the failure
  // is a clear message rather than a stack trace at import time.
  let asar;
  try {
    asar = require('@electron/asar');
  } catch {
    fail('@electron/asar is not installed. It ships with electron-builder; run npm ci.');
  }
  return asar
    .listPackage(asarPath, { isPack: false })
    .map((p) => p.replace(/\\/g, '/').replace(/^\//, ''))
    .filter(Boolean);
}

function findAsar() {
  const roots = ['dist'];
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name === 'app.asar') found.push(full);
    }
  };
  for (const r of roots) walk(r, 0);
  return found;
}

function fail(msg) {
  console.error(`ASARCHECK FAIL  ${msg}`);
  process.exit(1);
}

function main() {
  const arg = process.argv[2];
  const targets = arg ? [arg] : findAsar();

  if (!targets.length) {
    fail('no app.asar found under dist/. Build first, or pass a path.');
  }
  for (const t of targets) {
    if (!fs.existsSync(t)) fail(`no such file: ${t}`);
  }

  let problems = 0;
  for (const target of targets) {
    const files = listFiles(target);
    console.log(`ASARCHECK ${target}  (${files.length} entries)`);

    for (const { prefix, why } of FORBIDDEN) {
      const hits = files.filter((f) => f.startsWith(prefix));
      if (hits.length) {
        problems += 1;
        console.error(
          `  SHIPPED WHAT IT MUST NOT: ${hits.length} entr${hits.length === 1 ? 'y' : 'ies'} under ` +
            `${prefix} (${why})`
        );
        for (const h of hits.slice(0, 10)) console.error(`    ${h}`);
        if (hits.length > 10) console.error(`    ... and ${hits.length - 10} more`);
      } else {
        console.log(`  ok  nothing under ${prefix}`);
      }
    }

    for (const { file, why } of REQUIRED) {
      if (files.includes(file)) {
        console.log(`  ok  ${file} is present`);
      } else {
        problems += 1;
        console.error(`  MISSING: ${file} (${why})`);
      }
    }
  }

  if (problems) {
    console.error(
      `\nASARCHECK FAIL  ${problems} problem(s) across ${targets.length} archive(s)`
    );
    process.exit(1);
  }
  console.log(`\nASARCHECK PASS  ${targets.length} archive(s)`);
}

main();
