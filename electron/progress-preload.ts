const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('macroProgress', {
  onProgress: (callback: (data: unknown) => void): (() => void) => {
    const listener = (_event: unknown, data: unknown): void => callback(data);
    ipcRenderer.on('macro-progress', listener);
    return (): void => ipcRenderer.removeListener('macro-progress', listener);
  },
});
