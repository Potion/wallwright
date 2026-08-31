// node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { supported, desiredLoginItem, reconcile, describe } = require('../src/autostart');

// A packaged Windows app that wants to start at login, so each test can spoil
// exactly one thing about it.
const env = (over = {}) => ({
  platform: 'win32',
  execPath: 'C:\\Program Files\\Wallwright\\Wallwright.exe',
  isPackaged: true,
  ...over,
});

test('supported covers the two platforms the exhibit ships to', () => {
  assert.equal(supported('win32'), true);
  assert.equal(supported('darwin'), true);
  assert.equal(supported('linux'), false);
  assert.equal(supported(undefined), false);
});

test('a packaged Windows build with autoStart on registers its own exe', () => {
  const d = desiredLoginItem({ autoStart: true }, env());
  assert.equal(d.openAtLogin, true);
  assert.equal(d.blocked, false);
  assert.equal(d.path, 'C:\\Program Files\\Wallwright\\Wallwright.exe');
});

test('autoStart off is a real answer, not a blocked one', () => {
  const d = desiredLoginItem({ autoStart: false }, env());
  assert.equal(d.openAtLogin, false);
  assert.equal(d.blocked, false);
  assert.equal(d.reason, undefined);
});

// The guard that keeps CI off a real person's login items. The macOS job runs on
// a development machine on every push.
test('an unpackaged run never registers, however the config is set', () => {
  const d = desiredLoginItem({ autoStart: true }, env({ isPackaged: false }));
  assert.equal(d.openAtLogin, false);
  assert.equal(d.blocked, true);
  assert.match(d.reason, /not a packaged build/);
  // Still reports what was asked for, so the panel can say why it is inert
  // rather than silently showing the box unticked.
  assert.equal(d.wanted, true);
});

test('an unsupported platform is blocked and says which one', () => {
  const d = desiredLoginItem({ autoStart: true }, env({ platform: 'linux' }));
  assert.equal(d.openAtLogin, false);
  assert.equal(d.blocked, true);
  assert.match(d.reason, /linux/);
});

// The asymmetry is deliberate: execPath inside a .app is the binary in
// Contents/MacOS, not the bundle, and Electron resolves the bundle when path is
// omitted.
test('macOS is given no path, Windows is', () => {
  assert.equal(
    desiredLoginItem({ autoStart: true }, env({ platform: 'darwin' })).path,
    undefined
  );
  assert.ok(desiredLoginItem({ autoStart: true }, env()).path);
});

test('a missing config is the same as autoStart off', () => {
  assert.equal(desiredLoginItem(undefined, env()).openAtLogin, false);
  assert.equal(desiredLoginItem({}, env()).openAtLogin, false);
});

test('reconcile is null when the OS already agrees', () => {
  const on = desiredLoginItem({ autoStart: true }, env());
  assert.equal(reconcile(on, { openAtLogin: true }), null);
  const off = desiredLoginItem({ autoStart: false }, env());
  assert.equal(reconcile(off, { openAtLogin: false }), null);
});

test('reconcile turns it on, carrying the path', () => {
  const change = reconcile(desiredLoginItem({ autoStart: true }, env()), {
    openAtLogin: false,
  });
  assert.equal(change.openAtLogin, true);
  assert.ok(change.path);
});

test('reconcile turns it off again', () => {
  const change = reconcile(desiredLoginItem({ autoStart: false }, env()), {
    openAtLogin: true,
  });
  assert.equal(change.openAtLogin, false);
});

// Someone deleting the Run entry by hand while the app is running. Without this,
// the next boot would leave it off and the panel would still claim it was on.
test('reconcile puts back an entry that was removed underneath us', () => {
  const change = reconcile(desiredLoginItem({ autoStart: true }, env()), {
    openAtLogin: false,
  });
  assert.equal(change.openAtLogin, true);
});

test('reconcile never acts on a blocked platform', () => {
  const d = desiredLoginItem({ autoStart: true }, env({ isPackaged: false }));
  assert.equal(reconcile(d, { openAtLogin: true }), null);
  assert.equal(reconcile(d, { openAtLogin: false }), null);
});

test('reconcile tolerates an OS answer it did not get', () => {
  const on = desiredLoginItem({ autoStart: true }, env());
  assert.equal(reconcile(on, undefined).openAtLogin, true);
  assert.equal(reconcile(undefined, { openAtLogin: true }), null);
});

// The status page reports the OS, not the config. These two fields disagreeing is
// the whole point of having both.
test('describe reports config and OS separately when they disagree', () => {
  const d = describe({ autoStart: true }, { openAtLogin: false }, env());
  assert.equal(d.configured, true);
  assert.equal(d.effective, false);
  assert.equal(d.supported, true);
  assert.equal(d.blocked, false);
});

test('describe explains an inert setting rather than just showing it off', () => {
  const d = describe({ autoStart: true }, { openAtLogin: false }, env({ isPackaged: false }));
  assert.equal(d.configured, true);
  assert.equal(d.effective, false);
  assert.equal(d.blocked, true);
  assert.match(d.reason, /packaged/);
});

test('describe on a supported platform in agreement has nothing to explain', () => {
  const d = describe({ autoStart: true }, { openAtLogin: true }, env());
  assert.deepEqual(d, {
    configured: true,
    effective: true,
    supported: true,
    blocked: false,
    reason: null,
  });
});
