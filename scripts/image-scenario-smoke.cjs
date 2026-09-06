const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const sharp = require('sharp');
const native = require('../src/native-windows');
const { createInputAdapter } = require('../src/input-adapter');
const { MacroRunner } = require('../src/runner');
const { newMacro } = require('../src/macros');
const { captureTarget } = require('../src/overlay');
const { findTemplate } = require('../src/matcher');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const title = `Americano Image Scenario ${process.pid}`;
const dir = path.join(__dirname, '..', 'tests', 'test_images');
// Full-HD class frames are matched at half resolution inside this test so a
// single scan stays within seconds; coordinates are mapped back to overlay DIP.
const SCALE = 2;
const condition = { title_contains: title, process_name: 'electron.exe' };
const stages = [
  { name: 'stage1', background: 'background1.png', target: 'target1.png', expect: { x: 644, y: 177 } },
  { name: 'stage2', background: 'background2.png', target: 'target2.png', expect: { x: 636.5, y: 905 } },
];
const seen = [];
let current = stages[0];

async function until(check, attempts = 200) {
  for (let i = 0; i < attempts; i += 1) {
    if (await check()) return;
    await sleep(30);
  }
  throw new Error('이미지 시나리오 테스트 시간 초과');
}

async function showBackground(win, stage) {
  const file = path.join(dir, stage.background);
  const meta = await sharp(file).metadata();
  stage.area = { x: 0, y: 0, width: meta.width, height: meta.height };
  stage.targetPath = path.join(dir, stage.target);
  win.setContentSize(meta.width, meta.height);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body style="margin:0;overflow:hidden;background:#000">`
    + `<img src="data:image/png;base64,${fs.readFileSync(file).toString('base64')}" style="display:block;width:${meta.width}px;height:${meta.height}px">`
    + `<script>window.clicks=[];window.keys=[];`
    + `document.addEventListener('mousedown',e=>clicks.push({x:e.clientX,y:e.clientY}));`
    + `document.addEventListener('keydown',e=>{keys.push(e.key);e.preventDefault();});</script>`
    + `</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  win.setMenu(null);
  await sleep(400);
  win.show(); win.focus(); win.webContents.focus();
  const isActive = () => {
    const handle = native.listWindows().find((w) => w.title === title)?.handle;
    return handle && native.isForeground(handle) ? handle : null;
  };
  let handle = null;
  for (let i = 0; i < 40 && !handle; i += 1) { handle = isActive(); if (!handle) await sleep(100); }
  if (!handle) {
    // Windows 전경 정책이 focus()를 거부하면 실사용과 같은 마우스 활성화로 전환한다.
    const any = native.listWindows().find((w) => w.title === title)?.handle;
    const point = require('../src/windows').screenPoint(native.geometry(any), 60, 60);
    await native.moveCursor(point);
    native.clickMouse('left');
    await sleep(400);
    handle = isActive();
  }
  assert(handle, '테스트 창을 전경으로 가져오지 못했습니다.');
  // Wait for first paint so the first capture never races image decoding.
  await until(() => win.webContents.executeJavaScript(
    `(() => { const img = document.querySelector('img'); return img && img.complete && img.naturalWidth > 0; })()`));
  // 활성화 클릭이 기록되었을 수 있으므로 입력 기록을 초기화한다.
  await win.webContents.executeJavaScript('window.clicks=[];window.keys=[];');
}

async function matchCurrent(action, control, macro) {
  const area = macro.overlay;
  const shot = await captureTarget(condition, area, control);
  const frame = await sharp(shot.buffer).resize(Math.round(area.width / SCALE), Math.round(area.height / SCALE))
    .removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  const templateMeta = await sharp(current.targetPath).metadata();
  const template = await sharp(current.targetPath)
    .resize(Math.round(templateMeta.width / SCALE), Math.round(templateMeta.height / SCALE))
    .removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  const match = await findTemplate(frame, template, action.threshold ?? 0.9, control);
  if (!match) return null;
  const found = {
    x: match.x * SCALE, y: match.y * SCALE,
    width: templateMeta.width, height: templateMeta.height, score: match.score,
  };
  seen.push({ stage: current.name, ...found });
  return found;
}

function imageAction(type, extra = {}) {
  return {
    type, image: current.targetPath, threshold: 0.9, monitor: 1,
    poll_interval_ms: 200, timeout_ms: 60000, region: { ...current.area }, ...extra,
  };
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    const runner = new MacroRunner({ input: createInputAdapter(), imageMatcher: matchCurrent, authorize: async () => {} });
    async function run(actions) {
      const macro = { ...newMacro(), target_window: condition, overlay: { ...current.area }, actions };
      const started = Date.now();
      runner.start(macro);
      await runner.active.done;
      assert.equal(runner.state().outcome, 'completed', runner.state().error);
      return Date.now() - started;
    }
    const clicks = () => win.webContents.executeJavaScript('clicks');
    const keys = () => win.webContents.executeJavaScript('keys');

    // Stage 1: background1에서 target1(던전 클리어!) 탐지 후 클릭 + 2초 대기.
    // image_wait으로 폴링 탐지하므로 렌더 타이밍과 실제 출현 타이밍에 모두 강건하다.
    current = stages[0];
    await showBackground(win, current);
    await run([imageAction('image_wait')]);
    assert.equal(seen.length, 1, 'target1 탐지 기록이 없습니다.');
    const found1 = seen[0];
    const center1 = { x: Math.round(found1.x + found1.width / 2), y: Math.round(found1.y + found1.height / 2) };
    assert(Math.abs(center1.x - current.expect.x) <= 12 && Math.abs(center1.y - current.expect.y) <= 12,
      `target1 탐지 위치가 기대값과 다릅니다: ${JSON.stringify(center1)}`);
    const waited = await run([{ type: 'click', x: center1.x, y: center1.y, button: 'left', timeout_ms: 10000 }, { type: 'wait', duration_ms: 2000, timeout_ms: 10000 }]);
    assert(waited >= 1900, `2초 대기가 실행되지 않았습니다: ${waited}ms`);
    const clicks1 = await clicks();
    assert(clicks1.length === 1, `클릭이 1회 기록되어야 합니다: ${JSON.stringify(clicks1)}`);
    assert(Math.abs(clicks1[0].x - current.expect.x) <= 12 && Math.abs(clicks1[0].y - current.expect.y) <= 12,
      `클릭 위치가 탐지 중심과 다릅니다: ${JSON.stringify(clicks1[0])}`);

    // Stage 2: background2에서 target2(나가기) 탐지 후 space 입력.
    current = stages[1];
    await showBackground(win, current);
    assert.deepEqual(await clicks(), [], '배경 교체 전에 클릭이 추가로 발생했습니다.');
    await run([imageAction('image_wait'), { type: 'key', keys: 'space', timeout_ms: 10000 }]);
    assert.equal(seen.length, 2, 'target2 탐지 기록이 없습니다.');
    const found2 = seen[1];
    const center2 = { x: found2.x + found2.width / 2, y: found2.y + found2.height / 2 };
    assert(Math.abs(center2.x - current.expect.x) <= 12 && Math.abs(center2.y - current.expect.y) <= 12,
      `target2 탐지 위치가 기대값과 다릅니다: ${JSON.stringify(center2)}`);
    assert((await keys()).includes(' '), 'space 키 입력이 수신되지 않았습니다.');
    assert.deepEqual(await clicks(), [], 'stage2에서 클릭이 발생했습니다.');

    console.log(JSON.stringify({
      ok: true, target1: { score: found1.score, click: clicks1[0] }, waitedMs: waited,
      target2: { score: found2.score, spacePressed: true },
    }));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
setTimeout(() => app.exit(2), 180000).unref();
