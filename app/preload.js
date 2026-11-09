const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('studyTimer', {
  get: () => ipcRenderer.invoke('app:get'),
  start: (name, minutes) => ipcRenderer.invoke('task:start', name, minutes),
  toggle: (id) => ipcRenderer.invoke('task:toggle', id),
  remove: (id) => ipcRenderer.invoke('task:remove', id),
  settle: (id) => ipcRenderer.invoke('task:settle', id),
  quit: () => ipcRenderer.invoke('app:quit'),
  hide: () => ipcRenderer.send('win:hide'),
  collapse: (v) => ipcRenderer.send('ui:collapse', v),
  shape: (w, h) => ipcRenderer.send('win:shape', { w, h }),
  onUpdate: (cb) => ipcRenderer.on('state:update', (_e, s) => cb(s)),
  onSound: (cb) => ipcRenderer.on('sound:done', () => cb()),
  soundFailed: () => ipcRenderer.send('sound:failed'),
})