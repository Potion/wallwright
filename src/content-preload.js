// Preload injected into each content view. It exposes NOTHING to the page; it
// reports user activity to the main process, which uses it to know which panel
// is in use: to keep the idle timer from docking the wall under someone, to
// stop the watchdog reloading a panel mid-login, and to give the keyboard a
// target when a panel is clicked.
const { ipcRenderer } = require('electron');

const report = (e) => ipcRenderer.send('forge:activity', e.type);

['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach((ev) =>
  window.addEventListener(ev, report, { passive: true, capture: true })
);
