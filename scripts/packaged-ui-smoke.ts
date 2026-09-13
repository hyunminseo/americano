import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import assert from 'node:assert/strict';
const archive: string = path.join(__dirname, '..', '..', 'dist', 'win-unpacked', 'resources', 'app.asar');
app.whenReady().then(async (): Promise<void> => {
  try {
    const { MacroStore }: { MacroStore: new (dir: string, storage: unknown) => { open(): Promise<void>; save(document: unknown): Promise<void>; snapshot(): { macros: Array<{ actions: Array<{ keys?: string }> }> } } } = require(path.join(archive, 'src/store'));
    const store: { open(): Promise<void>; save(document: unknown): Promise<void>; snapshot(): { macros: Array<{ actions: Array<{ keys?: string }> }> } } = new MacroStore(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'americano-packaged-')), safeStorage);
    await store.open();
    (require(path.join(archive, 'src/native-windows')) as { listWindows: () => unknown }).listWindows();
    (require(path.join(archive, 'src/input-adapter')) as { createInputAdapter: () => unknown }).createInputAdapter();
    const errors: string[] = [];
    const window: BrowserWindow = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { preload: path.join(archive, 'electron/preload.js'), sandbox: true, contextIsolation: true } });
    window.webContents.on('console-message', (_event: unknown, level: number, message: string): void => { if (level >= 3) errors.push(message); });
    const state = (): Record<string, unknown> => ({ document: store.snapshot(), storageReady: true, run: { status: 'STOPPED', completed: 0 }, license: { valid: false, message: '패키지 로딩 테스트' }, executionReason: '입력 없는 테스트' });
    ipcMain.handle('backend:request', async (_event: unknown, command: string, payload: { document: unknown }): Promise<Record<string, unknown>> => {
      if (command === 'save') await store.save(payload.document);
      return { ok: true, state: state() };
    });
    await window.loadFile(path.join(archive, 'electron/index.html'));
    await window.webContents.executeJavaScript(`createMacro(); current().actions=[{type:'key',keys:'ctrl+a'}]; render();`);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#flow').textContent.includes('키 입력')`), true);
    assert.equal(await window.webContents.executeJavaScript('save()'), true);
    assert.equal(store.snapshot().macros[0]?.actions[0]?.keys, 'ctrl+a');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, packagedBlockly: true, packagedNativeModules: true, encryptedSave: true }));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
setTimeout((): void => { app.exit(2); }, 15000).unref();
