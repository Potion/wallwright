// Preload injected into each content view. It exposes NOTHING to the page; it
// only reports user activity to the main process so the idle auto-return timer
// resets while someone is actively using a fullscreen panel.
const { ipcRenderer } = require('electron');

const ping = () => ipcRenderer.send('forge:activity');
['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach((ev) =>
  window.addEventListener(ev, ping, { passive: true, capture: true })
);
