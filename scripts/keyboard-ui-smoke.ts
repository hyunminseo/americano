import { app, BrowserWindow, globalShortcut } from 'electron';
import assert from 'node:assert/strict';
import * as native from '../src/native-windows.js';
import { createInputAdapter } from '../src/input-adapter.js';
import { MacroRunner, RunControl } from '../src/runner.js';
import type { TemplateMatch } from '../src/runner.js';
import type { MacroAction } from '../src/macros.js';
import { KeyboardSender } from '../src/keyboard.js';
import { newMacro } from '../src/macros.js';
import { captureTarget } from '../src/overlay.js';
import { findTemplate, loadTemplate } from '../src/matcher.js';
import sharp from 'sharp';
import * as fs from 'node:fs';
import * as path from 'node:path';
const sleep = (ms: number): Promise<void> => new Promise((resolve: (value: void) => void) => setTimeout(resolve, ms));
const title: string = `Americano Keyboard Receiver ${process.pid}`;
let target: BrowserWindow, decoy: BrowserWindow;
async function until(check: () => boolean | Promise<boolean>, attempts: number = 100): Promise<void> { for (let i: number = 0; i < attempts; i++) { if (await check()) return; await sleep(30); } throw new Error('키보드 수신 테스트 시간 초과'); }
app.whenReady().then(async (): Promise<void> => {
  try {
    const html = (name: string): string => `<!doctype html><html><head><title>${name}</title></head><body><div style="width:32px;height:32px;background:black"></div><textarea autofocus style="width:90%;height:180px" aria-label="테스트 입력"></textarea><script>window.received=[];window.clicks=[];document.addEventListener('mousedown',e=>clicks.push({x:e.clientX,y:e.clientY,button:e.button}));for(const type of ['keydown','keyup'])document.addEventListener(type,e=>received.push({type,key:e.key,ctrl:e.ctrlKey,shift:e.shiftKey}));document.querySelector('textarea').focus();</script></body></html>`;
    decoy = new BrowserWindow({ width: 450, height: 330, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    await decoy.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html('Americano Decoy'))}`);
    target = new BrowserWindow({ width: 500, height: 350, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    target.setMenu(null);
    await target.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html(title))}`);
    target.setAlwaysOnTop(true); target.show(); target.focus(); target.webContents.focus();
    const condition: Record<string, string> = { title_contains: title, process_name: 'electron.exe' };
    await sleep(200);
    const testHandle: unknown = (native as { listWindows: () => Array<{ title: string; handle: unknown }> }).listWindows().find((w: { title: string }): boolean => w.title === title)?.handle;
    assert(testHandle, '테스트 창을 찾을 수 없습니다.');
    const clickPoint: { x: number; y: number } = (require('../src/windows.js') as { screenPoint: (geometry: unknown, x: number, y: number) => { x: number; y: number } }).screenPoint((native as { geometry: (handle: unknown) => unknown }).geometry(testHandle), 80, 100);
    assert((native as { isPointInWindow: (handle: unknown, x: number, y: number) => boolean }).isPointInWindow(testHandle, clickPoint.x, clickPoint.y), '테스트 창이 클릭 위치에 없습니다.');
    await (native as { moveCursor: (point: { x: number; y: number }) => Promise<void> }).moveCursor(clickPoint); (native as { clickMouse: (button: string) => void }).clickMouse('left');
    await sleep(100);
    console.log(JSON.stringify({clickPoint,mouse:(native as { cursorPosition: () => unknown }).cursorPosition(),bounds:target.getBounds(),client:(native as { geometry: (handle: unknown) => unknown }).geometry(testHandle),foreground:(native as { isForeground: (handle: unknown) => boolean }).isForeground(testHandle),focused:target.isFocused(),clicks:await target.webContents.executeJavaScript('clicks')}));
    console.log(`자동 클릭·키보드 테스트 수신 창: ${title}`);
    await until((): boolean => (native as { listWindows: () => Array<{ title: string; handle: unknown }>; isForeground: (handle: unknown) => boolean }).listWindows().some((w: { title: string; handle: unknown }): boolean => w.title === title && (native as { isForeground: (handle: unknown) => boolean }).isForeground(w.handle)));
    await sleep(350);
    const area: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, width: 80, height: 60 };
    const original: { buffer: Buffer } = await (captureTarget as (target: unknown, area: unknown) => Promise<{ buffer: Buffer }>)(condition, area);
    const template: unknown = await (loadTemplate as (buffer: Buffer) => Promise<unknown>)(await sharp(original.buffer).resize(80, 60).extract({ left: 8, top: 8, width: 32, height: 32 }).png().toBuffer());
    const matcher = async (_action: MacroAction, control: { checkpoint(): Promise<void> }): Promise<TemplateMatch | null> => {
      const shot: { buffer: Buffer } = await (captureTarget as (target: unknown, area: unknown, control?: unknown) => Promise<{ buffer: Buffer }>)(condition, area, control);
      const frame: { data: Buffer; info: { width: number; height: number } } = await sharp(shot.buffer).resize(80, 60).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
      const match: { x: number; y: number } | null = await (findTemplate as (frame: unknown, template: unknown, threshold: number, control?: unknown) => Promise<{ x: number; y: number } | null>)(frame, template, 0.99, control);
      if (!match) {
        const directory: string = path.join(__dirname, '..', '..', 'artifacts'); fs.mkdirSync(directory, {recursive:true});
        fs.writeFileSync(path.join(directory, 'keyboard-original.png'), original.buffer);
        fs.writeFileSync(path.join(directory, 'keyboard-mismatch.png'), shot.buffer);
      }
      return match as unknown as TemplateMatch | null;
    };
    const input = createInputAdapter();
    // Test-only authorization; production still checks its signed licence.
    const runner = new MacroRunner({ input, imageMatcher: matcher, authorize: async (): Promise<void> => {} });
    const run = async (actions: Array<MacroAction>): Promise<void> => { runner.start({ ...newMacro(), target_window: condition, overlay: area, actions }); await runner.active!.done; assert.equal(runner.state().outcome, 'completed', runner.state().error as string); await sleep(80); };
    await run([{ type: 'condition', test: { type: 'image_detect', image: 'fixture.png' }, then: [
      { type: 'text', text: 'replace me' }, { type: 'key', keys: 'ctrl+a' }, { type: 'text', text: '한글 Americano 😀' },
      { type: 'key', keys: 'enter' }, { type: 'key', keys: 'a' }, { type: 'key', keys: 'f6' },
    ], else: [{ type: 'stop' }] }]);
    const value: string = await target.webContents.executeJavaScript("document.querySelector('textarea').value") as string;
    assert.equal(value, '한글 Americano 😀\na');
    const events: Array<{ type: string; key: string; ctrl?: boolean }> = await target.webContents.executeJavaScript('received') as Array<{ type: string; key: string; ctrl?: boolean }>;
    assert(events.some((e: { type: string; key: string; ctrl?: boolean }): boolean => e.type === 'keydown' && !!e.ctrl && e.key.toLowerCase() === 'a'));
    assert(events.some((e: { type: string; key: string }): boolean => e.type === 'keyup' && e.key === 'F6'));
    await run([{type:'click',x:100,y:120},{type:'image_click',image:'fixture.png'}]);
    const clicks: Array<{ x: number; y: number }> = await target.webContents.executeJavaScript('clicks') as Array<{ x: number; y: number }>;
    assert(clicks.some((e: { x: number; y: number }): boolean =>Math.abs(e.x-100)<=1 && Math.abs(e.y-120)<=1));
    assert(clicks.some((e: { x: number; y: number }): boolean =>Math.abs(e.x-24)<=1 && Math.abs(e.y-24)<=1));
    await run([{type:'click',x:100,y:120},{type:'key',keys:'ctrl+end'}]);
    assert.equal(await decoy.webContents.executeJavaScript('received.length'), 0);
    assert(globalShortcut.register('F8', (): void => { runner.pause(); }));
    assert(globalShortcut.register('F9', (): void => { void runner.stop(); }));
    const handle: unknown = (native as { listWindows: () => Array<{ title: string; handle: unknown }> }).listWindows().find((w: { title: string }): boolean => w.title === title)?.handle;
    const keyboard: { press: (key: string, handle: unknown, control: unknown) => Promise<void> } = new (KeyboardSender as new () => { press: (key: string, handle: unknown, control: unknown) => Promise<void> })();
    runner.start({ ...(newMacro as () => Record<string, unknown>)(), target_window: condition, actions: [{ type: 'wait', duration_ms: 400 }, { type: 'text', text: 'RESUMED' }] });
    await keyboard.press('f8', handle, new (RunControl as new () => unknown)());
    await until((): boolean => runner.state().status === 'PAUSED'); await sleep(450);
    assert.equal(await target.webContents.executeJavaScript("document.querySelector('textarea').value"), value);
    await keyboard.press('f8', handle, new (RunControl as new () => unknown)()); await until((): boolean => !runner.active); await sleep(80);
    const resumed: string = await target.webContents.executeJavaScript("document.querySelector('textarea').value") as string;
    assert.equal(resumed, value + 'RESUMED');
    runner.start({ ...(newMacro as () => Record<string, unknown>)(), target_window: condition, actions: [{ type: 'wait', duration_ms: 400 }, { type: 'text', text: 'MUST_NOT_ARRIVE' }] });
    await keyboard.press('f9', handle, new (RunControl as new () => unknown)()); await until((): boolean => !runner.active); await sleep(450);
    assert.equal(await target.webContents.executeJavaScript("document.querySelector('textarea').value"), resumed);
    globalShortcut.unregisterAll();
    target.setAlwaysOnTop(false); decoy.setAlwaysOnTop(true); decoy.show(); decoy.focus(); decoy.webContents.focus();
    await until((): boolean => !(native as { isForeground: (handle: unknown) => boolean }).isForeground(handle));
    await assert.rejects(keyboard.press('enter', handle, new (RunControl as new () => unknown)()), /전경/);
    const activate: (handle: unknown) => void = (native as { activate: (handle: unknown) => void }).activate;
    (native as { activate: (handle: unknown) => void }).activate = (): void => {};
    try { await assert.rejects(input.execute({ type:'key', keys:'enter' }, condition, new RunControl()), /전경 전환/); }
    finally { (native as { activate: (handle: unknown) => void }).activate = activate; }
    target.destroy();
    await assert.rejects((require('../src/windows.js') as { findWindow: (condition: unknown, timeout: number) => Promise<unknown> }).findWindow(condition, 0), /찾지 못/);
    assert.equal(await decoy.webContents.executeJavaScript('received.length'), 0);
    const keyDown: (code: number) => number = (require('koffi') as { load: (dll: string) => { func: (signature: string) => (code: number) => number } }).load('user32.dll').func('short __stdcall GetAsyncKeyState(int key)');
    for (const code of [0xa2, 0xa0, 0xa4, 65, 117]) assert.equal((keyDown(code) as number) & 0x8000, 0);
    console.log(JSON.stringify({ ok: true, activationByMouse: true, coordinateClick: true, imageClick: true, imageDetected: true, unicode: true, ctrlA: true, singleKey: true, functionKey: true, decoyUntouched: true, F8PauseResume: true, F9Stop: true, focusLoss: true, activationFailure: true, targetMissing: true, keysReleased: true, value }));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
setTimeout((): void => { app.exit(2); }, 20000).unref();
