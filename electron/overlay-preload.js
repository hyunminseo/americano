const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('captureOverlay', {
  onData: (callback) => ipcRenderer.on('capture-overlay-data', (_event, data) => callback(data)),
  select: (region) => ipcRenderer.send('capture-overlay-selection', region),
  cancel: () => ipcRenderer.send('capture-overlay-cancel'),
});
