// Preload injected into each content view. It exposes NOTHING to the page; it
// reports user activity to the main process, which uses it to know which panel
// is in use: to keep the idle timer from docking the wall under someone, to
// stop the watchdog reloading a panel mid-login, and to give the keyboard a
// target when a panel is clicked.
const { ipcRenderer } = require('electron');

// NOTE: this file cannot require anything but electron and a few node built-ins.
// It is a preload in a sandboxed renderer, where require() is limited. Pulling the
// throttle below out into src/interaction.js to share it was tried and reverted:
// it fails at runtime with "module not found", takes activity reporting to zero,
// and does it silently. Keep the logic here, inline.

// mousemove is throttled, and the other events are not.
//
// Two reasons. It is the highest-frequency thing this app does - four panels of
// unthrottled pointer motion, every message crossing IPC and allocating on both
// sides - and it carries almost no information: the main process only wants to
// know that a cursor was moving recently, not how far.
//
// The second reason matters more on an unattended wall. Chromium dispatches
// synthetic mouse-move when content scrolls or animates under a stationary
// pointer, so a mouse left resting on an animated dashboard reports motion
// indefinitely. Main treats pointer motion as presence rather than interaction
// for that reason; throttling here keeps the volume sane either way.
const MOVE_EVERY_MS = 1000;
let lastMove = 0;

const report = (e) => {
  if (e.type === 'mousemove') {
    const now = Date.now();
    if (now - lastMove < MOVE_EVERY_MS) return;
    lastMove = now;
  }
  ipcRenderer.send('ww:activity', e.type);
};

['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach((ev) =>
  window.addEventListener(ev, report, { passive: true, capture: true })
);
