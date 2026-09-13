const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('captureOverlay', {
  onData: (callback: (data: unknown) => void): unknown => ipcRenderer.on('capture-overlay-data', (_event: unknown, data: unknown): void => callback(data)),
  select: (region: unknown): void => ipcRenderer.send('capture-overlay-selection', region),
  cancel: (): void => ipcRenderer.send('capture-overlay-cancel'),
});
