// Preload for the transparent overlay. Exposes a minimal, safe bridge so the
// overlay UI can request panel activation, edit the layout, and receive state.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wallwright', {
  onState: (cb) => ipcRenderer.on('ww:state', (_e, s) => cb(s)),
  activate: (id) => ipcRenderer.send('ww:activate', id),
  back: () => ipcRenderer.send('ww:back'),
  promote: (id) => ipcRenderer.send('ww:promote', id),
  escape: () => ipcRenderer.send('ww:escape'),
  toggleFullscreen: () => ipcRenderer.send('ww:toggleFullscreen'),
  // The Back-button corner is part of the wall too: moving the mouse there must
  // count as activity or the idle timer would dock the panel under the operator.
  activity: () => ipcRenderer.send('ww:activity'),

  // Layout edit mode. Rects are sent in window pixels; the main process converts
  // to wall units and echoes the result back for the readout.
  dragStart: (id) => ipcRenderer.send('ww:dragStart', id),
  layout: (msg) => ipcRenderer.send('ww:layout', msg),
  dragEnd: () => ipcRenderer.send('ww:dragEnd'),
  editExit: (opts) => ipcRenderer.send('ww:editExit', opts),
  onLayoutEcho: (cb) => ipcRenderer.on('ww:layoutEcho', (_e, m) => cb(m)),

  // Panel CRUD, from the layout editor's inspector.
  addPanel: (rect) => ipcRenderer.send('ww:addPanel', rect),
  deletePanel: (id) => ipcRenderer.send('ww:deletePanel', id),
  updatePanel: (id, patch) => ipcRenderer.send('ww:updatePanel', { id, patch }),
  onSelect: (cb) => ipcRenderer.on('ww:select', (_e, id) => cb(id)),

  // Named montages.
  applyPreset: (id) => ipcRenderer.send('ww:applyPreset', id),
  savePreset: (name) => ipcRenderer.send('ww:savePreset', name),
  deletePreset: (id) => ipcRenderer.send('ww:deletePreset', id),
});
