const { app, BrowserWindow, globalShortcut, ipcMain, safeStorage } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { MacroStore } = require('../src/store');
const { MacroRunner } = require('../src/runner');
let mainWindow, store, runner;
let startupError = null;
let shortcutsReady = false;
let quitting = false;
const page = pathToFileURL(path.join(__dirname, 'index.html')).href;
function state() {
  return { document: store?.ready ? store.snapshot() : { version: 2, macros: [] }, run: runner.state(), error: startupError,
    storageReady: Boolean(store?.ready), shortcutsReady, executionAvailable: false,
    executionReason: '실제 입력은 대상 창·관리자 권한·라이선스 검증 연결 후 사용할 수 있습니다.' };
}
function notify() { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('backend-state', state()); }
function createWindow() {
  mainWindow = new BrowserWindow({ width: 1180, height: 850, minWidth: 900, minHeight: 650, backgroundColor: '#f5f1ea',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.loadURL(page);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    runner = new MacroRunner({ onState: () => notify() });
    store = new MacroStore(path.join(app.getPath('userData'), 'macros-v2'), safeStorage);
    try { await store.open(); } catch (error) { startupError = error.message; }
    const pauseReady = globalShortcut.register('F8', () => runner.pause());
    const stopReady = globalShortcut.register('F9', () => { void runner.stop(); });
    shortcutsReady = pauseReady && stopReady;
    if (!shortcutsReady) startupError = [startupError, 'F8/F9 등록에 실패했습니다. 다른 앱의 단축키 설정을 확인하세요.'].filter(Boolean).join('\n');
    ipcMain.handle('backend:request', async (event, command, payload = {}) => {
      try {
        if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== page) throw new Error('허용되지 않은 요청입니다.');
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('잘못된 요청입니다.');
        switch (command) {
          case 'state': break;
          case 'save': await store.save(payload.document); break;
          case 'preview': {
            if (!shortcutsReady) throw new Error('F8/F9 단축키를 먼저 확보해야 합니다.');
            const macro = store.snapshot().macros.find((item) => item.id === payload.macroId);
            if (!macro) throw new Error('매크로를 찾을 수 없습니다.');
            runner.start(macro, { preview: true, startIndex: payload.startIndex ?? 0 }); break;
          }
          case 'start': throw new Error(state().executionReason);
          case 'pause': runner.pause(); break;
          case 'stop': await runner.stop(); break;
          default: throw new Error('허용되지 않은 명령입니다.');
        }
        return { ok: true, state: state() };
      } catch (error) { return { ok: false, error: error.message, state: state() }; }
    });
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    Promise.all([runner?.stop(), store?.queue]).finally(() => app.quit());
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}
