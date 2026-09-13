import { app, BrowserWindow, dialog, safeStorage } from 'electron';
import type { Event, WebContents } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import sharpFixture from 'sharp';
import * as overlayModule from '../src/overlay.js';
import * as windowsModule from '../src/windows.js';
import * as nativeWindowsModule from '../src/native-windows.js';
app.on('web-contents-created', (_event: Event, contents: WebContents): void => { contents.on('console-message', (_event: Event, level: number, message: string): void => { if (level >= 2) console.error(message); }); });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'americano-overlay-ui-')));
// Deterministic frame fixture: Windows foreground policy is tested separately.
interface CaptureArea {
  x: number;
  y: number;
  width: number;
  height: number;
}
(overlayModule as unknown as Record<string, unknown>).captureTarget = async (_target: unknown, area: CaptureArea | undefined): Promise<{ buffer: Buffer; region: CaptureArea; dpi: number }> => {
  const canvas: sharpFixture.Sharp = sharpFixture(Buffer.from('<svg width="600" height="450"><rect width="600" height="450" fill="white"/><rect x="40" y="40" width="24" height="24" fill="black"/></svg>'));
  const region: CaptureArea = area || {x:0,y:0,width:600,height:450};
  return {buffer:await canvas.extract({left:region.x,top:region.y,width:region.width,height:region.height}).png().toBuffer(),region:{...region,x:100+region.x,y:100+region.y},dpi:96};
};
const trackedClient: { x: number; y: number; width: number; height: number; dpi: number } = {x:100,y:100,width:600,height:450,dpi:96};
(windowsModule as unknown as Record<string, unknown>).findWindow = async (): Promise<{ handle: number }> => ({handle:1});
(nativeWindowsModule as unknown as Record<string, unknown>).geometry = (): { x: number; y: number; width: number; height: number; dpi: number } => ({...trackedClient});
require('../electron/main.js');
const sleep = (ms: number): Promise<void> => new Promise((resolve: (value: void) => void) => setTimeout(resolve, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>): Promise<T> { for(let n: number=0;n<150;n++){const value: T | null | undefined | false =await fn();if(value)return value as T;await sleep(100);}throw new Error('Smoke timeout'); }
app.whenReady().then(async (): Promise<void> => {
 try {
  const main: BrowserWindow = await until<BrowserWindow>((): Promise<BrowserWindow | undefined> => Promise.resolve(BrowserWindow.getAllWindows().find((w: BrowserWindow): boolean => w.webContents.getURL().endsWith('/index.html'))));
  await until<boolean>((): Promise<boolean> => main.webContents.executeJavaScript('Boolean(backend?.storageReady)') as Promise<boolean>);
  await main.webContents.executeJavaScript(`createMacro(); current().target_window = {title_contains:'Americano Overlay Smoke Target',process_name:'electron.exe'}; changed(); render();`);
  const opened: { ok: boolean; error?: string } = await main.webContents.executeJavaScript(`window.americano.request('capture-overlay-open',{mode:'region',macro:current()})`) as { ok: boolean; error?: string }; if(!opened.ok) throw new Error(opened.error);
  let overlay: BrowserWindow = await until<BrowserWindow>((): Promise<BrowserWindow | undefined> => Promise.resolve(BrowserWindow.getAllWindows().find((w: BrowserWindow): boolean => w.webContents.getURL().endsWith('/capture-overlay.html'))));
  await until<boolean>((): Promise<boolean> => overlay.webContents.executeJavaScript('meta.width > 1') as Promise<boolean>);
  await overlay.webContents.executeJavaScript(`window.captureOverlay.select({x:20,y:20,width:180,height:160})`);
  await until<boolean>((): Promise<boolean> => main.webContents.executeJavaScript('Boolean(current()?.overlay && !dirty && !saving)') as Promise<boolean>);
  const imageOpened: { ok: boolean; error?: string } = await main.webContents.executeJavaScript(`window.americano.request('capture-overlay-open',{mode:'image',macro:current()})`) as { ok: boolean; error?: string }; if(!imageOpened.ok) throw new Error(imageOpened.error);
  overlay=await until<BrowserWindow>((): Promise<BrowserWindow | undefined> => Promise.resolve(BrowserWindow.getAllWindows().find((w: BrowserWindow): boolean => w.webContents.getURL().endsWith('/capture-overlay.html'))));
  await until<boolean>((): Promise<boolean> => overlay.webContents.executeJavaScript('meta.width > 1') as Promise<boolean>);
  await overlay.webContents.executeJavaScript(`window.captureOverlay.select({x:20,y:20,width:24,height:24})`);
  await until<boolean>((): Promise<boolean> => main.webContents.executeJavaScript('Boolean(current()?.images.length && !dirty && !saving)') as Promise<boolean>);
  const shelf: { horizontal: boolean; reordered: boolean } = await main.webContents.executeJavaScript(`(() => {
    const original = current().images[0];
    current().images.push(...Array.from({length: 6}, (_, i) => ({...original, id: 'shelf-' + i, name: '캡처 ' + i})));
    render();
    const list = document.querySelector('.asset-list');
    const horizontal = list.scrollWidth > list.clientWidth && getComputedStyle(list).overflowX === 'auto';
    document.querySelector('[data-asset-id="shelf-0"] [data-op="left"]').click();
    const reordered = current().images[0].id === 'shelf-0';
    current().images = [original]; render();
    return {horizontal, reordered};
  })()`) as { horizontal: boolean; reordered: boolean };
  if (!shelf.horizontal || !shelf.reordered) throw new Error('Capture shelf scroll or reorder failed');
  await main.webContents.executeJavaScript(`document.querySelector('#add-rule').click(); current().loop={count:3,interval_ms:30}; changed();`);
  await main.webContents.executeJavaScript(`current().actions[0].then[0].keys='ctrl+a'; changed(); render();`);
  await main.webContents.executeJavaScript('save()');
  await main.webContents.executeJavaScript(`document.querySelector('#flow').scrollIntoView({block:'start'});`);
  await sleep(150);
  // 워크플로우 순서 변경: then 분기에 단계를 하나 더해 아래로 이동시켰다가 되돌린다.
  await main.webContents.executeJavaScript(`current().actions[0].then.push({type:'key',keys:'alt+enter',timeout_ms:10000}); changed(); render();`);
  const order = (): Promise<string> => main.webContents.executeJavaScript(`current().actions[0].then.map(a=>a.keys).join(',')`) as Promise<string>;
  if (await order() !== 'ctrl+a,alt+enter') throw new Error('Workflow append failed');
  await main.webContents.executeJavaScript(`document.querySelector('[data-inspect="0.then.0"] [data-op="down"]').click()`);
  if (await order() !== 'alt+enter,ctrl+a') throw new Error('Workflow reorder did not move the node');
  await main.webContents.executeJavaScript(`document.querySelector('[data-inspect="0.then.1"] [data-op="up"]').click()`);
  if (await order() !== 'ctrl+a,alt+enter') throw new Error('Workflow reorder did not restore the node');
  await main.webContents.executeJavaScript(`current().actions[0].then.pop(); changed(); render();`);
  await main.webContents.executeJavaScript('save()');
  // 자유 연결: 그립을 끌어 루트 노드 순서를 바꾼 뒤 되돌린다.
  await main.webContents.executeJavaScript(`current().actions.push({type:'wait',duration_ms:100,timeout_ms:10000}); changed(); render();`);
  async function drag(from: { x: number; y: number }, to: { x: number; y: number }, key: string): Promise<void> {
    await main.webContents.executeJavaScript(`(() => {
      const grip = document.querySelector('[data-inspect="${key}"] [data-grip]');
      const fire = (type, x, y) => grip.dispatchEvent(
        new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 7, isPrimary: true }));
      fire('pointerdown', ${from.x}, ${from.y});
      for (let n = 1; n <= 6; n++) fire('pointermove', ${from.x} + (${to.x} - ${from.x}) * n / 6, ${from.y} + (${to.y} - ${from.y}) * n / 6);
      fire('pointerup', ${to.x}, ${to.y});
    })()`);
    await sleep(200);
  }
  const gripOf = (key: string): Promise<{ x: number; y: number; h: number }> => main.webContents.executeJavaScript(`(() => { const r = document.querySelector('[data-inspect="${key}"] [data-grip]').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), h: Math.round(r.height) }; })()`) as Promise<{ x: number; y: number; h: number }>;
  const from: { x: number; y: number; h: number } = await gripOf('0');
  const below: { x: number; y: number } = await main.webContents.executeJavaScript(`(() => { const r = document.querySelector('[data-inspect="1"]').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.bottom + 24) }; })()`) as { x: number; y: number };
  await drag(from, below, '0');
  if (await main.webContents.executeJavaScript(`current().actions.map(a=>a.type).join(',')`) !== 'wait,condition') throw new Error('Pointer drag did not reorder nodes');
  const back: { x: number; y: number; h: number } = await gripOf('1');
  const above: { x: number; y: number } = await main.webContents.executeJavaScript(`(() => { const r = document.querySelector('[data-inspect="0"]').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.top + 8) }; })()`) as { x: number; y: number };
  await drag(back, above, '1');
  if (await main.webContents.executeJavaScript(`current().actions.map(a=>a.type).join(',')`) !== 'condition,wait') throw new Error('Pointer drag did not restore nodes');
  await main.webContents.executeJavaScript(`current().actions.pop(); changed(); render();`);
  await main.webContents.executeJavaScript('save()');
  const macro: { actions: Array<{ type: string; then: Array<{ keys: string }> }>; loop: { count: number }; images: Array<{ path: string }>; target_window: { title_contains?: string; process_name?: string }; overlay: { x: number; y: number; width: number; height: number } } = await main.webContents.executeJavaScript('structuredClone(current())') as { actions: Array<{ type: string; then: Array<{ keys: string }> }>; loop: { count: number }; images: Array<{ path: string }>; target_window: { title_contains?: string; process_name?: string }; overlay: { x: number; y: number; width: number; height: number } };
  if(macro.actions[0]?.then[0]?.keys!=='ctrl+a'||macro.actions[0]?.type!=='condition'||macro.loop.count!==3||!macro.images[0]?.path.endsWith('.aimg'))throw new Error('Saved workflow incomplete');
  const {MacroStore}: { MacroStore: new (dir: string, storage: unknown) => { open(): Promise<void>; readImage(imagePath: string): Promise<Buffer> } } = require('../src/store.js');
  const store: { open(): Promise<void>; readImage(imagePath: string): Promise<Buffer> } = new MacroStore(path.join(app.getPath('userData'),'macros-v2'),safeStorage);await store.open();
  const {captureTarget}: { captureTarget: (target: unknown, overlay: unknown) => Promise<{ buffer: Buffer }> } = require('../src/overlay.js');const sharp: typeof sharpFixture = require('sharp');const {findTemplate,loadTemplate}: { findTemplate: (frame: unknown, template: unknown, threshold: number) => Promise<{ x: number; y: number; score: number } | null>; loadTemplate: (buffer: Buffer) => Promise<unknown> } = require('../src/matcher.js');
  const shot: { buffer: Buffer } =await captureTarget(macro.target_window,macro.overlay);
  const frame: { data: Buffer; info: { width: number; height: number } } =await sharp(shot.buffer).resize(macro.overlay.width,macro.overlay.height).removeAlpha().greyscale().raw().toBuffer({resolveWithObject:true});
  const match: { x: number; y: number; score: number } | null =await findTemplate(frame,await loadTemplate(await store.readImage(macro.images[0]?.path as string)),0.99);
  if(!match)throw new Error('Saved image not detected');
  await main.webContents.reload();
  await until<boolean>((): Promise<boolean> => main.webContents.executeJavaScript('Boolean(current()?.images.length)') as Promise<boolean>);
  const shown: { ok: boolean; error?: string } = await main.webContents.executeJavaScript("window.americano.request('overlay-show',{macroId:current().id})") as { ok: boolean; error?: string };
  if (!shown.ok) throw new Error(shown.error);
  const outline: BrowserWindow = await until<BrowserWindow>((): Promise<BrowserWindow | undefined> => Promise.resolve(BrowserWindow.getAllWindows().find((w: BrowserWindow): boolean => w.webContents.getURL().endsWith('/overlay-outline.html'))));
  const firstX: number = outline.getBounds().x; trackedClient.x += 100;
  await until<boolean>((): Promise<boolean> => Promise.resolve(outline.getBounds().x !== firstX));
  if (outline.isFocusable()) throw new Error('Outline must not take focus');
  await main.webContents.executeJavaScript("window.americano.request('overlay-hide')");
  if (!outline.isDestroyed()) throw new Error('Outline was not closed');
  const packageFile: string = path.join(app.getPath('userData'), 'roundtrip.amacro');
  (dialog as unknown as Record<string, unknown>).showSaveDialog = async (): Promise<{ canceled: boolean; filePath: string }> => ({canceled:false,filePath:packageFile});
  (dialog as unknown as Record<string, unknown>).showOpenDialog = async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({canceled:false,filePaths:[packageFile]});
  await main.webContents.executeJavaScript(`document.querySelector('#export-macro').click()`);
  await until<boolean>((): Promise<boolean> => Promise.resolve(fs.existsSync(packageFile)));
  await main.webContents.executeJavaScript(`document.querySelector('#import-macro').click()`);
  await until<boolean>((): Promise<boolean> => main.webContents.executeJavaScript(`!current()?.binding?.needs_overlay && current()?.binding?.needs_review && documentData.macros.length === 2`) as Promise<boolean>);
  await main.webContents.executeJavaScript(`window.americano.request('capture-overlay-open',{mode:'region',macro:current()})`);
  overlay=await until<BrowserWindow>((): Promise<BrowserWindow | undefined> => Promise.resolve(BrowserWindow.getAllWindows().find((w: BrowserWindow): boolean => w.webContents.getURL().endsWith('/capture-overlay.html'))));
  await until<boolean>((): Promise<boolean> => overlay.webContents.executeJavaScript('meta.width > 1') as Promise<boolean>);
  await overlay.webContents.executeJavaScript(`window.captureOverlay.select({x:30,y:30,width:180,height:160})`);
  await until<boolean>((): Promise<boolean> => main.webContents.executeJavaScript('Boolean(current()?.overlay && !current().binding.needs_overlay && !dirty && !saving)') as Promise<boolean>);
  const imported: { actions: Array<{ type: string; then: Array<{ keys: string }> }>; images: Array<{ path: string }> } = await main.webContents.executeJavaScript('structuredClone(current())') as { actions: Array<{ type: string; then: Array<{ keys: string }> }>; images: Array<{ path: string }> };
  if(imported.actions[0]?.then[0]?.keys!=='ctrl+a'||imported.images[0]?.path===macro.images[0]?.path)throw new Error('Import lost blocks or asset remapping');
  await main.webContents.executeJavaScript(`document.querySelector('#flow').scrollIntoView({block:'start'});`);
  await sleep(150);
  const artifactDirectory: string = path.join(__dirname, '..', '..', 'artifacts'); fs.mkdirSync(artifactDirectory,{recursive:true});
  fs.writeFileSync(path.join(artifactDirectory,'workflow.png'),(await main.webContents.capturePage()).toPNG());
  const canvas: { bounded: boolean; zoomed: boolean; fitted: boolean } = await main.webContents.executeJavaScript(`(() => {
    const original = current().actions;
    const branch = (depth) => depth ? {type:'condition',test:{type:'image_detect',image:current().images[0].path},then:[branch(depth-1)],else:[{type:'wait',duration_ms:100}]} : {type:'wait',duration_ms:100};
    current().actions = [branch(5)]; render();
    const viewport = document.querySelector('#flow-viewport');
    const bounded = viewport.scrollWidth > viewport.clientWidth && document.documentElement.scrollWidth <= window.innerWidth;
    document.querySelector('#canvas-out').click();
    const zoomed = Number(document.querySelector('#flow').style.zoom) < 1;
    document.querySelector('#canvas-fit').click();
    const fitted = viewport.scrollWidth <= viewport.clientWidth + 2;
    const result = {bounded,zoomed,fitted, sw:viewport.scrollWidth,cw:viewport.clientWidth,fw:document.querySelector("#flow").offsetWidth,z:document.querySelector("#flow").style.zoom};
    current().actions = original; render();
    return result;
  })()`) as { bounded: boolean; zoomed: boolean; fitted: boolean };
  if (!canvas.bounded || !canvas.zoomed || !canvas.fitted) throw new Error('Canvas containment/zoom failed: ' + JSON.stringify(canvas));
  const result: Record<string, unknown> ={ok:true,workflowReorder:true,importExport:true,overlayRebound:true,outlineTracks:true,capture:'deterministic fixture',overlay:macro.overlay,match,restored:await main.webContents.executeJavaScript('current().loop.count===3')};
  console.log(JSON.stringify(result));app.quit();
 }catch(error){console.error(error);app.exit(1);}
});
setTimeout((): void => { app.exit(2); },35000).unref();
