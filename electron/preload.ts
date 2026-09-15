import { contextBridge, ipcRenderer } from 'electron';
const commands = new Set<string>(['state', 'save', 'preview', 'start', 'pause', 'stop', 'admin-open', 'simple-open', 'license-import', 'license-check', 'license-device', 'image-select', 'image-delete', 'window-list', 'capture-overlay-open', 'overlay-show', 'overlay-hide', 'macro-import', 'macro-export', 'overlay-rebind', 'overlay-auto', 'progress-toggle', 'learn-reset', 'ai-get', 'ai-set', 'ai-test', 'ai-generate', 'ai-server', 'ai-server-start', 'ai-providers', 'ai-login-start', 'ai-login-poll', 'ai-login-finish', 'ai-key-set']);
contextBridge.exposeInMainWorld('americano', {
  request: (command: string, payload: unknown = {}): Promise<unknown> => {
    if (!commands.has(command)) return Promise.reject(new Error('허용되지 않은 명령입니다.'));
    return ipcRenderer.invoke('backend:request', command, payload);
  },
  onState: (callback: (state: unknown) => void): (() => void) => {
    const listener = (_event: unknown, state: unknown): void => callback(state);
    ipcRenderer.on('backend-state', listener);
    return (): void => { ipcRenderer.removeListener('backend-state', listener); };
  },
  onStartHotkey: (callback: () => void): (() => void) => {
    const listener = (): void => callback();
    ipcRenderer.on('start-hotkey', listener);
    return (): void => { ipcRenderer.removeListener('start-hotkey', listener); };
  },
  onCaptureResult: (callback: (result: unknown) => void): (() => void) => {
    const listener = (_event: unknown, result: unknown): void => callback(result);
    ipcRenderer.on('capture-result', listener);
    return (): void => { ipcRenderer.removeListener('capture-result', listener); };
  },
});
