// Preload for the transparent overlay. Exposes a minimal, safe bridge so the
// overlay UI can request panel activation, edit the layout, and receive state.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('forge', {
  onState: (cb) => ipcRenderer.on('forge:state', (_e, s) => cb(s)),
  activate: (id) => ipcRenderer.send('forge:activate', id),
  back: () => ipcRenderer.send('forge:back'),
  escape: () => ipcRenderer.send('forge:escape'),
  toggleFullscreen: () => ipcRenderer.send('forge:toggleFullscreen'),
  // The Back-button corner is part of the wall too: moving the mouse there must
  // count as activity or the idle timer would dock the panel under the operator.
  activity: () => ipcRenderer.send('forge:activity'),

  // Layout edit mode. Rects are sent in window pixels; the main process converts
  // to wall units and echoes the result back for the readout.
  dragStart: (id) => ipcRenderer.send('forge:dragStart', id),
  layout: (msg) => ipcRenderer.send('forge:layout', msg),
  dragEnd: () => ipcRenderer.send('forge:dragEnd'),
  editExit: (opts) => ipcRenderer.send('forge:editExit', opts),
  onLayoutEcho: (cb) => ipcRenderer.on('forge:layoutEcho', (_e, m) => cb(m)),

  // Panel CRUD, from the layout editor's inspector.
  addPanel: (rect) => ipcRenderer.send('forge:addPanel', rect),
  deletePanel: (id) => ipcRenderer.send('forge:deletePanel', id),
  updatePanel: (id, patch) => ipcRenderer.send('forge:updatePanel', { id, patch }),
  onSelect: (cb) => ipcRenderer.on('forge:select', (_e, id) => cb(id)),
});
