const { app, BrowserWindow, globalShortcut, ipcMain, safeStorage, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { MacroStore } = require('../src/store');
const { MacroRunner } = require('../src/runner');
const { LicenseManager, readDeviceMacs, readLimited } = require('../src/license');
const { captureRegion, captureFull } = require('../src/capture');
const { loadTemplate, findTemplate } = require('../src/matcher');
const { createInputAdapter } = require('../src/input-adapter');
const variant = require('../package.json').americanoVariant || 'standard';
if (['mac-match', 'mac-mismatch'].includes(variant)) app.setPath('userData', path.join(app.getPath('appData'), `Americano-${variant}`));
let mainWindow, store, runner, license, licenseTimer;
let currentMacs = [];
let identityRefreshing = false;
async function refreshIdentity() {
  if (identityRefreshing) return;
  identityRefreshing = true;
  try { currentMacs = await readDeviceMacs(); } finally { identityRefreshing = false; }
}
let startupError = null;
let shortcutsReady = false;
let quitting = false;
const shutdownDeadlineMs = 5000;
const page = pathToFileURL(path.join(__dirname, 'index.html')).href;
function state() {
  return { document: store?.ready ? store.snapshot() : { version: 2, macros: [] }, run: runner.state(), error: startupError,
    storageReady: Boolean(store?.ready), shortcutsReady, executionAvailable: shortcutsReady,
    license: license.state(), variant,
    executionReason: license.state().valid ? '라이선스 인증 완료. 실제 입력은 대상 창·관리자 권한 연결 후 사용할 수 있습니다.' : license.state().message };
}
function notify() { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('backend-state', state()); }
function createWindow() {
  mainWindow = new BrowserWindow({ width: 1180, height: 850, minWidth: 900, minHeight: 650, backgroundColor: '#f5f1ea',
    icon: path.join(__dirname, 'assets', 'coffee.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.loadURL(page);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    const resourceRoot = app.isPackaged ? process.resourcesPath : app.getAppPath();
    let publicKey = '';
    try { publicKey = fs.readFileSync(path.join(resourceRoot, 'licensing', 'public-key.pem'), 'utf8'); } catch { /* Fail closed. */ }
    await refreshIdentity();
    license = new LicenseManager({ directory: path.join(app.getPath('userData'), 'licensing'), publicKey, getMacs: () => currentMacs, bundledFile: path.join(resourceRoot, 'licensing', 'bundled.lic') });
    await license.open();
    // Read-only smoke check of the same bundled verifier used by the UI; never sends input.
    if (process.argv.includes('--license-diagnostics')) {
      console.log(JSON.stringify({ variant, license: license.state() }));
      quitting = true;
      app.exit(license.state().valid ? 0 : 2);
      return;
    }
    const imageMatcher = async (action, control) => {
      const template = await loadTemplate(action.image);
      const capture = action.region.width > 0 && action.region.height > 0 ? captureRegion : captureFull;
      await control.checkpoint();
      const frame = await capture(action.monitor, action.region);
      const match = await findTemplate(frame, template, action.threshold);
      if (!match) return null;
      return match;
    };
    runner = new MacroRunner({ input: createInputAdapter(), imageMatcher, authorize: () => license.authorize(), onState: () => notify() });
    let lastLicense = JSON.stringify(license.state());
    let identityTicks = 0;
    licenseTimer = setInterval(() => {
      if (++identityTicks % 10 === 0) void refreshIdentity();
      const current = license.state();
      if (!current.valid) runner.invalidate(current.message);
      const serialized = JSON.stringify(current);
      if (serialized !== lastLicense) { lastLicense = serialized; notify(); }
    }, 1000);
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
          case 'license-device': await refreshIdentity(); return { ok: true, macs: currentMacs, state: state() };
          case 'license-check': await refreshIdentity(); license.authorize(); break;
          case 'license-import': {
            const selection = await dialog.showOpenDialog(mainWindow, { title: '오프라인 라이선스 등록', properties: ['openFile'], filters: [{ name: 'Americano 라이선스', extensions: ['lic'] }] });
            if (!selection.canceled && selection.filePaths.length) await license.install(await readLimited(selection.filePaths[0]));
            break;
          }
          case 'image-select': {
            const selection = await dialog.showOpenDialog(mainWindow, { title: '감지할 이미지 선택', properties: ['openFile'], filters: [{ name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] });
            return { ok: true, path: selection.canceled ? '' : selection.filePaths[0], state: state() };
          }
          case 'save': await store.save(payload.document); break;
          case 'preview': {
            if (!shortcutsReady) throw new Error('F8/F9 단축키를 먼저 확보해야 합니다.');
            const macro = store.snapshot().macros.find((item) => item.id === payload.macroId);
            if (!macro) throw new Error('매크로를 찾을 수 없습니다.');
            runner.start(macro, { preview: true, startIndex: payload.startIndex ?? 0 }); break;
          }
          case 'start': {
            if (!shortcutsReady) throw new Error('F8/F9 단축키를 먼저 확보해야 합니다.');
            const macro = store.snapshot().macros.find((item) => item.id === payload.macroId);
            if (!macro) throw new Error('매크로를 찾을 수 없습니다.');
            runner.start(macro, { preview: false, startIndex: payload.startIndex ?? 0 }); break;
          }
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
    clearInterval(licenseTimer);
    const cleanup = Promise.allSettled([runner?.stop(), store?.queue, license?.queue]);
    let deadlineTimer;
    const deadline = new Promise((resolve) => { deadlineTimer = setTimeout(() => resolve(true), shutdownDeadlineMs); });
    Promise.race([cleanup.then(() => false), deadline]).then((timedOut) => {
      clearTimeout(deadlineTimer);
      if (timedOut) console.error(`Shutdown cleanup exceeded ${shutdownDeadlineMs}ms; forcing exit.`);
      app.exit(timedOut ? 1 : 0);
    });
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}
