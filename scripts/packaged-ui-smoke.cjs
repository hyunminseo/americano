const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const archive = path.join(__dirname, '..', 'dist', 'win-unpacked', 'resources', 'app.asar');
app.whenReady().then(async () => {
  try {
    const { MacroStore } = require(path.join(archive, 'src/store'));
    const store = new MacroStore(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'americano-packaged-')), safeStorage);
    await store.open();
    require(path.join(archive, 'src/native-windows')).listWindows();
    require(path.join(archive, 'src/input-adapter')).createInputAdapter();
    const errors = [];
    const window = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { preload: path.join(archive, 'electron/preload.js'), sandbox: true, contextIsolation: true } });
    window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    const state = () => ({ document: store.snapshot(), storageReady: true, run: { status: 'STOPPED', completed: 0 }, license: { valid: false, message: '패키지 로딩 테스트' }, executionReason: '입력 없는 테스트' });
    ipcMain.handle('backend:request', async (_event, command, payload) => {
      if (command === 'save') await store.save(payload.document);
      return { ok: true, state: state() };
    });
    await window.loadFile(path.join(archive, 'electron/index.html'));
    await window.webContents.executeJavaScript(`createMacro(); current().actions=[{type:'key',keys:'ctrl+a'}]; render();`);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#flow').textContent.includes('키 입력')`), true);
    assert.equal(await window.webContents.executeJavaScript('save()'), true);
    assert.equal(store.snapshot().macros[0].actions[0].keys, 'ctrl+a');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, packagedBlockly: true, packagedNativeModules: true, encryptedSave: true }));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
setTimeout(() => app.exit(2), 15000).unref();
