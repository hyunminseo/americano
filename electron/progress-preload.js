const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('macroProgress', {
  onProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('macro-progress', listener);
    return () => ipcRenderer.removeListener('macro-progress', listener);
  },
});
