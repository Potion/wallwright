// Auto-start: whether the wall comes back on its own.
//
// Two halves, kept apart on purpose, because they fail for different reasons and
// only one of them can live in this process.
//
// This file is the **login item** half: the per-user "start this at logon" entry
// that Electron drives through `app.setLoginItemSettings()`. It closes the case
// that actually blocks a deployment, which is that the show PC reboots overnight
// and nobody is standing there to click anything.
//
// It does not close a crash, and nothing in this process can. A login item fires
// once, at logon. Restarting an app whose main process has died needs something
// outside the app, because the thing that would do the restarting is the thing
// that died. On Windows that is a Scheduled Task with restart-on-failure:
// `scripts/wallwright-autostart.ps1`, written and deliberately unrun until there
// is a show PC to run it on. See `docs/validation.md` group C.
//
// Nothing here imports electron. `src/main.js` reads `app.getLoginItemSettings()`,
// hands the answer in, and applies whatever comes back. That is what keeps the
// decisions testable on plain node, which is the only reason `src/layout.js` and
// `src/control-server.js` have the coverage they do.

// Windows and macOS have a login item Electron can drive. Linux does not through
// this API, and the exhibit does not ship there.
const SUPPORTED = ['win32', 'darwin'];

function supported(platform) {
  return SUPPORTED.includes(platform);
}

// What the login item should be, given the config and the process we happen to be.
//
// `reason` is filled in whenever the answer is "off" for a cause other than the
// config saying so, because the settings panel has to be able to explain a
// checkbox that will not stay ticked. Silence there is how a setting becomes a
// bug report.
function desiredLoginItem(config, env) {
  const { platform, execPath, isPackaged } = env || {};
  const wanted = !!(config && config.autoStart);

  if (!supported(platform)) {
    return {
      openAtLogin: false,
      wanted,
      blocked: true,
      reason: `${platform || 'this platform'} has no login item this can set`,
    };
  }

  // A dev run must never register itself. Unpackaged, `process.execPath` is the
  // Electron binary under node_modules, so honouring the flag would put "start
  // Electron at login" in somebody's account, pointed at a path that disappears
  // with the next `npm ci`. The macOS CI job runs on a real person's machine, so
  // this guard is doing real work rather than being tidy.
  if (!isPackaged) {
    return {
      openAtLogin: false,
      wanted,
      blocked: true,
      reason: 'this is not a packaged build',
    };
  }

  const out = { openAtLogin: wanted, wanted, blocked: false };
  // Only Windows is given an explicit path, and that is a deliberate asymmetry
  // rather than an oversight. Electron defaults `path` to `process.execPath`,
  // which inside a .app bundle is the binary in Contents/MacOS rather than the
  // bundle itself, and a login item pointed at that is not what should show up in
  // System Settings. Omitting it lets Electron resolve the bundle. Windows is the
  // deployment target and is the half that matters; the macOS half is unverified
  // on a real install and is listed in docs/validation.md group C.
  if (platform === 'win32') out.path = execPath;
  return out;
}

// The change to make, or null when the OS already agrees. Separated from applying
// it so the decision can be tested without an OS to change.
function reconcile(desired, actual) {
  if (!desired || desired.blocked) return null;
  const current = !!(actual && actual.openAtLogin);
  if (current === desired.openAtLogin) return null;
  const apply = { openAtLogin: desired.openAtLogin };
  if (desired.path) apply.path = desired.path;
  return apply;
}

// What the settings panel renders.
//
// `effective` is the OS's answer, not the config's, and the two are separate
// fields on purpose: somebody who deleted the Run entry by hand should see an
// unticked box and a note, rather than a ticked one that is lying to them.
function describe(config, actual, env) {
  const desired = desiredLoginItem(config, env);
  return {
    configured: !!(config && config.autoStart),
    effective: !!(actual && actual.openAtLogin),
    supported: supported(env && env.platform),
    blocked: !!desired.blocked,
    reason: desired.reason || null,
  };
}

module.exports = { supported, desiredLoginItem, reconcile, describe, SUPPORTED };
