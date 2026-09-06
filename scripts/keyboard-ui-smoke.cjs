const { app, BrowserWindow, globalShortcut } = require('electron');
const assert = require('node:assert/strict');
const native = require('../src/native-windows');
const { createInputAdapter } = require('../src/input-adapter');
const { MacroRunner, RunControl } = require('../src/runner');
const { KeyboardSender } = require('../src/keyboard');
const { newMacro } = require('../src/macros');
const { captureTarget } = require('../src/overlay');
const { findTemplate, loadTemplate } = require('../src/matcher');
const sharp = require('sharp');
const fs = require('node:fs');
const path = require('node:path');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const title = `Americano Keyboard Receiver ${process.pid}`;
let target, decoy;
async function until(check, attempts = 100) { for (let i = 0; i < attempts; i++) { if (await check()) return; await sleep(30); } throw new Error('키보드 수신 테스트 시간 초과'); }
app.whenReady().then(async () => {
  try {
    const html = name => `<!doctype html><html><head><title>${name}</title></head><body><div style="width:32px;height:32px;background:black"></div><textarea autofocus style="width:90%;height:180px" aria-label="테스트 입력"></textarea><script>window.received=[];window.clicks=[];document.addEventListener('mousedown',e=>clicks.push({x:e.clientX,y:e.clientY,button:e.button}));for(const type of ['keydown','keyup'])document.addEventListener(type,e=>received.push({type,key:e.key,ctrl:e.ctrlKey,shift:e.shiftKey}));document.querySelector('textarea').focus();</script></body></html>`;
    decoy = new BrowserWindow({ width: 450, height: 330, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    await decoy.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html('Americano Decoy'))}`);
    target = new BrowserWindow({ width: 500, height: 350, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    target.setMenu(null);
    await target.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html(title))}`);
    target.setAlwaysOnTop(true); target.show(); target.focus(); target.webContents.focus();
    const condition = { title_contains: title, process_name: 'electron.exe' };
    await sleep(200);
    const testHandle = native.listWindows().find(w => w.title === title)?.handle;
    assert(testHandle, '테스트 창을 찾을 수 없습니다.');
    const clickPoint = require('../src/windows').screenPoint(native.geometry(testHandle), 80, 100);
    assert(native.isPointInWindow(testHandle, clickPoint.x, clickPoint.y), '테스트 창이 클릭 위치에 없습니다.');
    await native.moveCursor(clickPoint); native.clickMouse('left');
    await sleep(100);
    console.log(JSON.stringify({clickPoint,mouse:native.cursorPosition(),bounds:target.getBounds(),client:native.geometry(testHandle),foreground:native.isForeground(testHandle),focused:target.isFocused(),clicks:await target.webContents.executeJavaScript('clicks')}));
    console.log(`자동 클릭·키보드 테스트 수신 창: ${title}`);
    await until(() => native.listWindows().some(w => w.title === title && native.isForeground(w.handle)));
    await sleep(350);
    const area = { x: 0, y: 0, width: 80, height: 60 };
    const original = await captureTarget(condition, area);
    const template = await loadTemplate(await sharp(original.buffer).resize(80, 60).extract({ left: 8, top: 8, width: 32, height: 32 }).png().toBuffer());
    const matcher = async (_action, control) => {
      const shot = await captureTarget(condition, area, control);
      const frame = await sharp(shot.buffer).resize(80, 60).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
      const match = await findTemplate(frame, template, 0.99, control);
      if (!match) {
        const directory = path.join(__dirname, '..', 'artifacts'); fs.mkdirSync(directory, {recursive:true});
        fs.writeFileSync(path.join(directory, 'keyboard-original.png'), original.buffer);
        fs.writeFileSync(path.join(directory, 'keyboard-mismatch.png'), shot.buffer);
      }
      return match;
    };
    const input = createInputAdapter();
    // Test-only authorization; production still checks its signed licence.
    const runner = new MacroRunner({ input, imageMatcher: matcher, authorize: async () => {} });
    const run = async actions => { runner.start({ ...newMacro(), target_window: condition, overlay: area, actions }); await runner.active.done; assert.equal(runner.state().outcome, 'completed', runner.state().error); await sleep(80); };
    await run([{ type: 'condition', test: { type: 'image_detect', image: 'fixture.png' }, then: [
      { type: 'text', text: 'replace me' }, { type: 'key', keys: 'ctrl+a' }, { type: 'text', text: '한글 Americano 😀' },
      { type: 'key', keys: 'enter' }, { type: 'key', keys: 'a' }, { type: 'key', keys: 'f6' },
    ], else: [{ type: 'stop' }] }]);
    const value = await target.webContents.executeJavaScript("document.querySelector('textarea').value");
    assert.equal(value, '한글 Americano 😀\na');
    const events = await target.webContents.executeJavaScript('received');
    assert(events.some(e => e.type === 'keydown' && e.ctrl && e.key.toLowerCase() === 'a'));
    assert(events.some(e => e.type === 'keyup' && e.key === 'F6'));
    await run([{type:'click',x:100,y:120},{type:'image_click',image:'fixture.png'}]);
    const clicks = await target.webContents.executeJavaScript('clicks');
    assert(clicks.some(e=>Math.abs(e.x-100)<=1 && Math.abs(e.y-120)<=1));
    assert(clicks.some(e=>Math.abs(e.x-24)<=1 && Math.abs(e.y-24)<=1));
    await run([{type:'click',x:100,y:120},{type:'key',keys:'ctrl+end'}]);
    assert.equal(await decoy.webContents.executeJavaScript('received.length'), 0);
    assert(globalShortcut.register('F8', () => runner.pause()));
    assert(globalShortcut.register('F9', () => { void runner.stop(); }));
    const handle = native.listWindows().find(w => w.title === title).handle;
    const keyboard = new KeyboardSender();
    runner.start({ ...newMacro(), target_window: condition, actions: [{ type: 'wait', duration_ms: 400 }, { type: 'text', text: 'RESUMED' }] });
    await keyboard.press('f8', handle, new RunControl());
    await until(() => runner.state().status === 'PAUSED'); await sleep(450);
    assert.equal(await target.webContents.executeJavaScript("document.querySelector('textarea').value"), value);
    await keyboard.press('f8', handle, new RunControl()); await until(() => !runner.active); await sleep(80);
    const resumed = await target.webContents.executeJavaScript("document.querySelector('textarea').value");
    assert.equal(resumed, value + 'RESUMED');
    runner.start({ ...newMacro(), target_window: condition, actions: [{ type: 'wait', duration_ms: 400 }, { type: 'text', text: 'MUST_NOT_ARRIVE' }] });
    await keyboard.press('f9', handle, new RunControl()); await until(() => !runner.active); await sleep(450);
    assert.equal(await target.webContents.executeJavaScript("document.querySelector('textarea').value"), resumed);
    globalShortcut.unregisterAll();
    target.setAlwaysOnTop(false); decoy.setAlwaysOnTop(true); decoy.show(); decoy.focus(); decoy.webContents.focus();
    await until(() => !native.isForeground(handle));
    await assert.rejects(keyboard.press('enter', handle, new RunControl()), /전경/);
    const activate = native.activate;
    native.activate = () => {};
    try { await assert.rejects(input.execute({ type:'key', keys:'enter' }, condition, new RunControl()), /전경 전환/); }
    finally { native.activate = activate; }
    target.destroy();
    await assert.rejects(require('../src/windows').findWindow(condition, 0), /찾지 못/);
    assert.equal(await decoy.webContents.executeJavaScript('received.length'), 0);
    const keyDown = require('koffi').load('user32.dll').func('short __stdcall GetAsyncKeyState(int key)');
    for (const code of [0xa2, 0xa0, 0xa4, 65, 117]) assert.equal(keyDown(code) & 0x8000, 0);
    console.log(JSON.stringify({ ok: true, activationByMouse: true, coordinateClick: true, imageClick: true, imageDetected: true, unicode: true, ctrlA: true, singleKey: true, functionKey: true, decoyUntouched: true, F8PauseResume: true, F9Stop: true, focusLoss: true, activationFailure: true, targetMissing: true, keysReleased: true, value }));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
setTimeout(() => app.exit(2), 20000).unref();
