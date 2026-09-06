const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
app.on('web-contents-created', (_event, contents) => contents.on('console-message', (_event, level, message) => { if (level >= 2) console.error(message); }));
app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'americano-overlay-ui-')));
// Deterministic frame fixture: Windows foreground policy is tested separately.
const sharpFixture = require('sharp');
require('../src/overlay').captureTarget = async (_target, area) => {
  const canvas = sharpFixture(Buffer.from('<svg width="600" height="450"><rect width="600" height="450" fill="white"/><rect x="40" y="40" width="24" height="24" fill="black"/></svg>'));
  const region = area || {x:0,y:0,width:600,height:450};
  return {buffer:await canvas.extract({left:region.x,top:region.y,width:region.width,height:region.height}).png().toBuffer(),region:{...region,x:100+region.x,y:100+region.y},dpi:96};
};
const trackedClient = {x:100,y:100,width:600,height:450,dpi:96};
require('../src/windows').findWindow = async () => ({handle:1});
require('../src/native-windows').geometry = () => ({...trackedClient});
require('../electron/main');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for(let n=0;n<150;n++){const value=await fn();if(value)return value;await sleep(100);}throw new Error('Smoke timeout'); }
app.whenReady().then(async()=>{
 try {
  const main = await until(()=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')));
  await until(()=>main.webContents.executeJavaScript('Boolean(backend?.storageReady)'));
  await main.webContents.executeJavaScript(`createMacro(); current().target_window = {title_contains:'Americano Overlay Smoke Target',process_name:'electron.exe'}; changed(); render();`);
  const opened = await main.webContents.executeJavaScript(`window.americano.request('capture-overlay-open',{mode:'region',macro:current()})`); if(!opened.ok) throw new Error(opened.error);
  let overlay = await until(()=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/capture-overlay.html')));
  await until(()=>overlay.webContents.executeJavaScript('meta.width > 1'));
  await overlay.webContents.executeJavaScript(`window.captureOverlay.select({x:20,y:20,width:180,height:160})`);
  await until(()=>main.webContents.executeJavaScript('Boolean(current()?.overlay && !dirty && !saving)'));
  const imageOpened = await main.webContents.executeJavaScript(`window.americano.request('capture-overlay-open',{mode:'image',macro:current()})`); if(!imageOpened.ok) throw new Error(imageOpened.error);
  overlay=await until(()=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/capture-overlay.html')));
  await until(()=>overlay.webContents.executeJavaScript('meta.width > 1'));
  await overlay.webContents.executeJavaScript(`window.captureOverlay.select({x:20,y:20,width:24,height:24})`);
  await until(()=>main.webContents.executeJavaScript('Boolean(current()?.images.length && !dirty && !saving)'));
  await main.webContents.executeJavaScript(`document.querySelector('#add-rule').click(); current().loop={count:3,interval_ms:30}; changed();`);
  await main.webContents.executeJavaScript(`blockWorkspace.getAllBlocks(false).find(block => block.type === 'am_key').setFieldValue('ctrl+a', 'keys'); syncBlocks();`);
  await main.webContents.executeJavaScript('save()');
  await main.webContents.executeJavaScript(`document.querySelector('#block-workspace').scrollIntoView({block:'start'}); blockWorkspace.zoomToFit();`);
  await sleep(150);
  const start = await main.webContents.executeJavaScript(`(() => { const block=blockWorkspace.getAllBlocks(false).find(b=>b.type==='am_key'); const r=block.getSvgRoot().getBoundingClientRect(); return {x:Math.round(r.x+12),y:Math.round(r.y+12)}; })()`);
  async function drag(from, to) {
    main.webContents.sendInputEvent({type:'mouseMove',...from});
    main.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...from});
    for(let n=1;n<=12;n++){main.webContents.sendInputEvent({type:'mouseMove',button:'left',modifiers:['leftButtonDown'],x:Math.round(from.x+(to.x-from.x)*n/12),y:Math.round(from.y+(to.y-from.y)*n/12)});await sleep(16);}
    main.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...to});await sleep(150);
  }
  const moved = {x:start.x+180,y:start.y+65};
  await drag(start,moved);
  if (!(await main.webContents.executeJavaScript(`blockWorkspace.getTopBlocks(false).length > 1`))) throw new Error('Pointer drag did not detach block');
  await drag(moved,start);
  if (!(await main.webContents.executeJavaScript(`syncBlocks()`))) throw new Error('Pointer drag did not reconnect block');
  await main.webContents.executeJavaScript('save()');
  const macro = await main.webContents.executeJavaScript('structuredClone(current())');
  if(macro.actions[0].then[0].keys!=='ctrl+a'||macro.actions[0].type!=='condition'||macro.loop.count!==3||!macro.images[0].path.endsWith('.aimg'))throw new Error('Saved workflow incomplete');
  const {MacroStore}=require('../src/store'); const store = new MacroStore(path.join(app.getPath('userData'),'macros-v2'),require('electron').safeStorage);await store.open();
  const {captureTarget}=require('../src/overlay');const sharp=require('sharp');const {findTemplate,loadTemplate}=require('../src/matcher');
  const shot=await captureTarget(macro.target_window,macro.overlay);
  const frame=await sharp(shot.buffer).resize(macro.overlay.width,macro.overlay.height).removeAlpha().greyscale().raw().toBuffer({resolveWithObject:true});
  const match=await findTemplate(frame,await loadTemplate(await store.readImage(macro.images[0].path)),0.99);
  if(!match)throw new Error('Saved image not detected');
  await main.webContents.reload();
  await until(()=>main.webContents.executeJavaScript('Boolean(current()?.images.length)'));
  const shown = await main.webContents.executeJavaScript("window.americano.request('overlay-show',{macroId:current().id})");
  if (!shown.ok) throw new Error(shown.error);
  const outline = await until(()=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/overlay-outline.html')));
  const firstX = outline.getBounds().x; trackedClient.x += 100;
  await until(()=>outline.getBounds().x !== firstX);
  if (outline.isFocusable()) throw new Error('Outline must not take focus');
  await main.webContents.executeJavaScript("window.americano.request('overlay-hide')");
  if (!outline.isDestroyed()) throw new Error('Outline was not closed');
  const packageFile = path.join(app.getPath('userData'), 'roundtrip.amacro');
  dialog.showSaveDialog = async () => ({canceled:false,filePath:packageFile});
  dialog.showOpenDialog = async () => ({canceled:false,filePaths:[packageFile]});
  await main.webContents.executeJavaScript(`document.querySelector('#export-macro').click()`);
  await until(()=>fs.existsSync(packageFile));
  await main.webContents.executeJavaScript(`document.querySelector('#import-macro').click()`);
  await until(()=>main.webContents.executeJavaScript(`current().binding?.needs_overlay && documentData.macros.length === 2`));
  await main.webContents.executeJavaScript(`window.americano.request('capture-overlay-open',{mode:'region',macro:current()})`);
  overlay=await until(()=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/capture-overlay.html')));
  await until(()=>overlay.webContents.executeJavaScript('meta.width > 1'));
  await overlay.webContents.executeJavaScript(`window.captureOverlay.select({x:30,y:30,width:180,height:160})`);
  await until(()=>main.webContents.executeJavaScript('Boolean(current()?.overlay && !current().binding.needs_overlay && !dirty && !saving)'));
  const imported = await main.webContents.executeJavaScript('structuredClone(current())');
  if(imported.actions[0].then[0].keys!=='ctrl+a'||imported.images[0].path===macro.images[0].path)throw new Error('Import lost blocks or asset remapping');
  await main.webContents.executeJavaScript(`document.querySelector('#block-workspace').scrollIntoView({block:'start'}); blockWorkspace.zoomToFit();`);
  await sleep(150);
  const artifactDirectory = path.join(__dirname, '..', 'artifacts'); fs.mkdirSync(artifactDirectory,{recursive:true});
  fs.writeFileSync(path.join(artifactDirectory,'block-editor.png'),(await main.webContents.capturePage()).toPNG());
  const result={ok:true,pointerDrag:true,importExport:true,overlayRebound:true,outlineTracks:true,capture:'deterministic fixture',overlay:macro.overlay,match,restored:await main.webContents.executeJavaScript('current().loop.count===3')};
  console.log(JSON.stringify(result));app.quit();
 }catch(error){console.error(error);app.exit(1);}
});
setTimeout(()=>app.exit(2),35000).unref();
