const { app, BrowserWindow, globalShortcut, ipcMain, safeStorage, dialog, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { MacroStore } = require('../src/store');
const { MacroRunner } = require('../src/runner');
const { exportMacro, importMacro, readPackage, rebindOverlay } = require('../src/portable');
const { LicenseManager, readDeviceMacs, readLimited } = require('../src/license');
const { loadTemplate, findTemplate } = require('../src/matcher');
const { createInputAdapter } = require('../src/input-adapter');
const { listWindows, findWindow } = require('../src/windows');
const { captureTarget, physicalRegion } = require('../src/overlay');
const sharp = require('sharp');
const variant = require('../package.json').americanoVariant || 'standard';
if (['mac-match', 'mac-mismatch'].includes(variant)) app.setPath('userData', path.join(app.getPath('appData'), `Americano-${variant}`));
let mainWindow, store, runner, license, licenseTimer;
let captureOverlay;
let captureBuffer;
let captureMeta;
let captureOpening = false;
let captureSaving = false;
let outline;
let outlineTimer;
function closeOutline() { clearInterval(outlineTimer); outlineTimer = null; if (outline && !outline.isDestroyed()) outline.destroy(); outline = null; }
async function showOutline(macro) {
  closeOutline();
  if (!macro.overlay) throw new Error('오버레이 영역을 먼저 저장하세요.');
  const window = new BrowserWindow({show: false, frame: false, transparent: true, focusable: false, skipTaskbar: true, alwaysOnTop: true, resizable: false, webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false}});
  outline = window; window.setIgnoreMouseEvents(true); window.setAlwaysOnTop(true, 'screen-saver');
  await window.loadFile(path.join(__dirname, 'overlay-outline.html'));
  let pending = false;
  const track = async () => {
    if (pending || window.isDestroyed()) return; pending = true;
    try {
      const target = await findWindow(macro.target_window, 0);
      const region = physicalRegion(require('../src/native-windows').geometry(target.handle), macro.overlay);
      if (window.isDestroyed()) return;
      const bounds = screen.screenToDipRect(null, region);
      window.setBounds({ x: bounds.x - 2, y: bounds.y - 2, width: bounds.width + 4, height: bounds.height + 4 });
      window.showInactive();
    } catch { if (!window.isDestroyed()) window.hide(); }
    finally { pending = false; }
  };
  await track();
  if (!window.isDestroyed()) outlineTimer = setInterval(track, 100);
}
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
let shutdownPromise = null;
const shutdownDeadlineMs = 5000;
const page = pathToFileURL(path.join(__dirname, 'index.html')).href;
function state() {
  return { document: store?.ready ? store.snapshot() : { version: 2, macros: [] }, run: runner.state(), error: startupError,
    storageReady: Boolean(store?.ready), shortcutsReady, executionAvailable: shortcutsReady,
    license: license.state(), variant,
    executionReason: license.state().valid ? '라이선스 인증 완료. 선택한 대상 창에서 실행할 수 있습니다.' : license.state().message };
}
function notify() { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('backend-state', state()); }
function createWindow() {
  mainWindow = new BrowserWindow({ width: 1180, height: 850, minWidth: 900, minHeight: 650, backgroundColor: '#f5f1ea',
    icon: path.join(__dirname, 'assets', 'coffee.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.on('closed', () => { if (!quitting) app.quit(); });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.loadURL(page);
}
async function openCaptureOverlay(payload) {
  if (runner.active) throw new Error('실행을 중지한 뒤 캡처하세요.');
  if (captureOverlay || captureOpening || captureSaving) throw new Error('이미 오버레이를 편집 중입니다.');
  captureOpening = true;
  try {
  const mode = payload.mode === 'image' ? 'image' : 'region';
  const macro = require('../src/macros').validateDocument({version: 2, macros: [payload.macro]}).macros[0];
  if (mode === 'image' && !macro.overlay) throw new Error('오버레이 영역을 먼저 설정하세요.');
  const frame = await captureTarget(macro.target_window, mode === 'image' ? macro.overlay : null);
  captureBuffer = frame.buffer;
  const metadata = await sharp(captureBuffer).metadata();
  captureMeta = { width: metadata.width, height: metadata.height, dpi: frame.dpi, mode, macroId: macro.id, offset: mode === 'image' ? macro.overlay : { x: 0, y: 0 } };
  const bounds = screen.screenToDipRect(null, frame.region);
  captureOverlay = new BrowserWindow({ ...bounds, frame: false, transparent: true, resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'overlay-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  captureOverlay.setAlwaysOnTop(true, 'screen-saver');
  captureOverlay.on('closed', () => { captureOverlay = null; captureBuffer = null; captureMeta = null; });
  await captureOverlay.loadURL(pathToFileURL(path.join(__dirname, 'capture-overlay.html')).href);
  captureOverlay.webContents.send('capture-overlay-data', { preview: 'data:image/png;base64,' + captureBuffer.toString('base64'), ...captureMeta });
  } catch (error) {
    if (captureOverlay && !captureOverlay.isDestroyed()) captureOverlay.destroy();
    throw error;
  } finally { captureOpening = false; }
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
    const imageMatcher = async (action, control, macro) => {
      const source = action.image.endsWith('.aimg') ? await store.readImage(action.image) : action.image;
      const area = macro.overlay || action.region;
      const shot = await captureTarget(macro.target_window, area, control);
      const frame = await sharp(shot.buffer).resize({ width: area.width, height: area.height }).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
      const template = await loadTemplate(source);
      if (template.info.width > frame.info.width || template.info.height > frame.info.height) throw new Error('기준 이미지가 오버레이 검색 영역보다 큽니다.');
      return findTemplate(frame, template, action.threshold, control);
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
          case 'macro-export': {
            const macro = store.snapshot().macros.find(item => item.id === payload.macroId);
            if (!macro) throw new Error('매크로를 찾을 수 없습니다.');
            const bytes = await exportMacro(macro, store);
            const selection = await dialog.showSaveDialog(mainWindow, { title: '매크로 내보내기 (설정과 이미지 포함)', defaultPath: `${macro.name.replace(/[<>:"/\\|?*]/g, '_')}.amacro`, filters: [{ name: 'Americano 매크로', extensions: ['amacro'] }] });
            if (!selection.canceled && selection.filePath) await fs.promises.writeFile(selection.filePath, bytes);
            return { ok: true, canceled: selection.canceled, state: state() };
          }
          case 'macro-import': {
            if (runner.active || captureOverlay || captureOpening || captureSaving) throw new Error('실행 또는 캡처를 마친 뒤 가져오세요.');
            const selection = await dialog.showOpenDialog(mainWindow, { title: '매크로 가져오기', properties: ['openFile'], filters: [{ name: 'Americano 매크로', extensions: ['amacro'] }] });
            if (selection.canceled || !selection.filePaths.length) return { ok: true, canceled: true, state: state() };
            const macroId = await importMacro(await readPackage(selection.filePaths[0]), store);
            return { ok: true, macroId, state: state() };
          }
          case 'overlay-rebind': return { ok: true, macro: rebindOverlay(payload.macro, payload.region), state: state() };
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
          case 'window-list': return { ok: true, windows: (await listWindows()).map(({handle, ...info}) => info), state: state() };
          case 'overlay-hide': closeOutline(); break;
          case 'overlay-show': {
            const macro = store.snapshot().macros.find(item => item.id === payload.macroId);
            if (!macro) throw new Error('매크로를 찾을 수 없습니다.');
            await showOutline(macro); break;
          }
          case 'capture-overlay-open': await openCaptureOverlay(payload); break;
          case 'save': await store.save(payload.document); closeOutline(); break;
          case 'preview': {
            if (!shortcutsReady) throw new Error('F8/F9 단축키를 먼저 확보해야 합니다.');
            const macro = store.snapshot().macros.find((item) => item.id === payload.macroId);
            if (!macro) throw new Error('매크로를 찾을 수 없습니다.');
            runner.start(macro, { preview: true, startIndex: payload.startIndex ?? 0 }); break;
          }
          case 'start': {
            if (captureOverlay || captureOpening || captureSaving) throw new Error('오버레이 편집을 먼저 마치세요.');
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
    ipcMain.on('capture-overlay-cancel', (event) => {
      if (event.sender === captureOverlay?.webContents && captureOverlay && !captureOverlay.isDestroyed()) captureOverlay.close();
    });
    ipcMain.on('capture-overlay-selection', async (event, selection) => {
      if (event.sender !== captureOverlay?.webContents || event.senderFrame !== event.sender.mainFrame || !captureBuffer || !captureMeta || captureSaving) return;
      captureSaving = true;
      const session = captureOverlay;
      const buffer = captureBuffer;
      try {
        const region = { x: Math.max(0, Math.min(captureMeta.width - 1, Math.round(selection.x))), y: Math.max(0, Math.min(captureMeta.height - 1, Math.round(selection.y))), width: Math.round(selection.width), height: Math.round(selection.height) };
        if (region.width < 8 || region.height < 8 || region.x + region.width > captureMeta.width || region.y + region.height > captureMeta.height) throw new Error('캡처 영역이 올바르지 않습니다.');
        if (!Object.values(region).every(Number.isSafeInteger)) throw new Error('잘못된 캡처 좌표입니다.');
        const meta = captureMeta;
        const relative = { x: meta.offset.x + Math.round(region.x * 96 / meta.dpi), y: meta.offset.y + Math.round(region.y * 96 / meta.dpi), width: Math.max(1, Math.round(region.width * 96 / meta.dpi)), height: Math.max(1, Math.round(region.height * 96 / meta.dpi)) };
        if (meta.mode === 'region') {
          mainWindow?.webContents.send('capture-result', { ok: true, mode: 'region', macroId: meta.macroId, region: relative });
          return;
        }
        const cropped = await sharp(buffer).extract({ left: region.x, top: region.y, width: region.width, height: region.height }).resize(relative.width, relative.height).png().toBuffer();
        const filePath = await store.saveImage(cropped);
        mainWindow?.webContents.send('capture-result', { ok: true, mode: 'image', macroId: meta.macroId, path: filePath, preview: `data:image/png;base64,${cropped.toString('base64')}`, region: relative });
      } catch (error) {
        mainWindow?.webContents.send('capture-result', { ok: false, error: error.message });
      } finally {
        if (session && !session.isDestroyed()) session.close();
        captureSaving = false;
      }
    });
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('before-quit', (event) => {
    if (shutdownPromise) { event.preventDefault(); return; }
    event.preventDefault(); quitting = true;
    clearInterval(licenseTimer);
    closeOutline();
    globalShortcut.unregisterAll();
    let finishShutdown;
    shutdownPromise = new Promise((resolve) => { finishShutdown = resolve; });
    // Destroying the renderer prevents beforeunload confirmation from blocking app.quit().
    if (captureOverlay && !captureOverlay.isDestroyed()) captureOverlay.destroy();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    const cleanup = Promise.allSettled([runner?.stop(), store?.queue, license?.queue]);
    const deadlineTimer = setTimeout(() => finishShutdown(true), shutdownDeadlineMs);
    cleanup.then(() => {
      clearTimeout(deadlineTimer);
      finishShutdown(false);
    });
    shutdownPromise.then((timedOut) => {
      if (timedOut) console.error(`Shutdown cleanup exceeded ${shutdownDeadlineMs}ms; forcing exit.`);
      app.exit(timedOut ? 1 : 0);
    });
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}
