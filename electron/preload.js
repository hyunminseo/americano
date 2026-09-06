const { contextBridge, ipcRenderer } = require('electron');
const commands = new Set(['state', 'save', 'preview', 'start', 'pause', 'stop', 'license-import', 'license-check', 'license-device', 'image-select', 'window-list', 'capture-overlay-open', 'overlay-show', 'overlay-hide', 'macro-import', 'macro-export', 'overlay-rebind']);
contextBridge.exposeInMainWorld('americano', {
  request: (command, payload = {}) => {
    if (!commands.has(command)) return Promise.reject(new Error('허용되지 않은 명령입니다.'));
    return ipcRenderer.invoke('backend:request', command, payload);
  },
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('backend-state', listener);
    return () => ipcRenderer.removeListener('backend-state', listener);
  },
  onCaptureResult: (callback) => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('capture-result', listener);
    return () => ipcRenderer.removeListener('capture-result', listener);
  },
});
