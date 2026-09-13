import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import sharp from 'sharp';
import * as native from '../src/native-windows.js';
import { createInputAdapter } from '../src/input-adapter.js';
import { MacroRunner } from '../src/runner.js';
import { newMacro } from '../src/macros.js';
import { captureTarget } from '../src/overlay.js';
import { findTemplate } from '../src/matcher.js';

interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Stage {
  name: string;
  background: string;
  target: string;
  expect: { x: number; y: number };
  area?: Area;
  targetPath?: string;
}

type MacroActionRecord = Record<string, unknown> & { type: string };
type RunnerLike = { start(macro: Record<string, unknown>): void; active: { done: Promise<unknown> }; state(): { outcome: string; error?: string } };

const sleep = (ms: number): Promise<void> => new Promise((resolve: (value: void) => void) => setTimeout(resolve, ms));
const title: string = `Americano Image Scenario ${process.pid}`;
const dir: string = path.join(__dirname, '..', 'tests', 'test_images');
// Full-HD class frames are matched at half resolution inside this test so a
// single scan stays within seconds; coordinates are mapped back to overlay DIP.
const SCALE: number = 2;
const condition: Record<string, string> = { title_contains: title, process_name: 'electron.exe' };
const stages: Stage[] = [
  { name: 'stage1', background: 'background1.png', target: 'target1.png', expect: { x: 644, y: 177 } },
  { name: 'stage2', background: 'background2.png', target: 'target2.png', expect: { x: 636.5, y: 905 } },
];
const seen: Array<{ stage: string; x: number; y: number; width: number; height: number; score: number }> = [];
let current: Stage = stages[0] as Stage;

async function until(check: () => Promise<boolean>, attempts: number = 200): Promise<void> {
  for (let i: number = 0; i < attempts; i += 1) {
    if (await check()) return;
    await sleep(30);
  }
  throw new Error('이미지 시나리오 테스트 시간 초과');
}

async function showBackground(win: BrowserWindow, stage: Stage): Promise<void> {
  const file: string = path.join(dir, stage.background);
  const meta: { width?: number; height?: number } = await sharp(file).metadata();
  stage.area = { x: 0, y: 0, width: meta.width as number, height: meta.height as number };
  stage.targetPath = path.join(dir, stage.target);
  win.setContentSize(meta.width as number, meta.height as number);
  const html: string = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body style="margin:0;overflow:hidden;background:#000">`
    + `<img src="data:image/png;base64,${fs.readFileSync(file).toString('base64')}" style="display:block;width:${meta.width as number}px;height:${meta.height as number}px">`
    + `<script>window.clicks=[];window.keys=[];`
    + `document.addEventListener('mousedown',e=>clicks.push({x:e.clientX,y:e.clientY}));`
    + `document.addEventListener('keydown',e=>{keys.push(e.key);e.preventDefault();});</script>`
    + `</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  win.setMenu(null);
  await sleep(400);
  win.show(); win.focus(); win.webContents.focus();
  const isActive = (): unknown => {
    const handle: unknown = (native as { listWindows: () => Array<{ title: string; handle: unknown }> }).listWindows().find((w: { title: string; handle: unknown }): boolean => w.title === title)?.handle;
    return handle && (native as { isForeground: (handle: unknown) => boolean }).isForeground(handle) ? handle : null;
  };
  let handle: unknown = null;
  for (let i: number = 0; i < 40 && !handle; i += 1) { handle = isActive(); if (!handle) await sleep(100); }
  if (!handle) {
    // Windows 전경 정책이 focus()를 거부하면 실사용과 같은 마우스 활성화로 전환한다.
    const any: unknown = (native as { listWindows: () => Array<{ title: string; handle: unknown }> }).listWindows().find((w: { title: string }): boolean => w.title === title)?.handle;
    const point: { x: number; y: number } = (require('../src/windows.js') as { screenPoint: (geometry: unknown, x: number, y: number) => { x: number; y: number } }).screenPoint((native as { geometry: (handle: unknown) => unknown }).geometry(any), 60, 60);
    await (native as { moveCursor: (point: { x: number; y: number }) => Promise<void> }).moveCursor(point);
    (native as { clickMouse: (button: string) => void }).clickMouse('left');
    await sleep(400);
    handle = isActive();
  }
  assert(handle, '테스트 창을 전경으로 가져오지 못했습니다.');
  // Wait for first paint so the first capture never races image decoding.
  await until((): Promise<boolean> => win.webContents.executeJavaScript(
    `(() => { const img = document.querySelector('img'); return img && img.complete && img.naturalWidth > 0; })()`) as Promise<boolean>);
  // 활성화 클릭이 기록되었을 수 있으므로 입력 기록을 초기화한다.
  await win.webContents.executeJavaScript('window.clicks=[];window.keys=[];');
}

async function matchCurrent(action: MacroActionRecord, control: Record<string, unknown>, macro: { overlay: Area }): Promise<{ x: number; y: number; width: number; height: number; score: number } | null> {
  const area: Area = macro.overlay;
  const shot: { buffer: Buffer } = await (captureTarget as (target: unknown, area: unknown, control?: unknown) => Promise<{ buffer: Buffer }>)(condition, area, control);
  const frame: { data: Buffer; info: { width: number; height: number } } = await sharp(shot.buffer).resize(Math.round(area.width / SCALE), Math.round(area.height / SCALE))
    .removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  const templateMeta: { width?: number; height?: number } = await sharp(current.targetPath as string).metadata();
  const template: { data: Buffer; info: { width: number; height: number } } = await sharp(current.targetPath as string)
    .resize(Math.round((templateMeta.width as number) / SCALE), Math.round((templateMeta.height as number) / SCALE))
    .removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  const match: { x: number; y: number; score: number } | null = await (findTemplate as (frame: unknown, template: unknown, threshold: number, control?: unknown) => Promise<{ x: number; y: number; score: number } | null>)(frame, template, (action.threshold as number) ?? 0.9, control);
  if (!match) return null;
  const found: { x: number; y: number; width: number; height: number; score: number } = {
    x: match.x * SCALE, y: match.y * SCALE,
    width: templateMeta.width as number, height: templateMeta.height as number, score: match.score,
  };
  seen.push({ stage: current.name, ...found });
  return found;
}

function imageAction(type: string, extra: Record<string, unknown> = {}): MacroActionRecord {
  return {
    type, image: current.targetPath as string, threshold: 0.9, monitor: 1,
    poll_interval_ms: 200, timeout_ms: 60000, region: { ...(current.area as Area) }, ...extra,
  };
}

app.whenReady().then(async (): Promise<void> => {
  try {
    const win: BrowserWindow = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    const runner: RunnerLike = new (MacroRunner as new (options: Record<string, unknown>) => RunnerLike)({ input: (createInputAdapter as () => unknown)(), imageMatcher: matchCurrent, authorize: async (): Promise<void> => {} });
    async function run(actions: MacroActionRecord[]): Promise<number> {
      const macro: Record<string, unknown> = { ...(newMacro as () => Record<string, unknown>)(), target_window: condition, overlay: { ...(current.area as Area) }, actions };
      const started: number = Date.now();
      runner.start(macro);
      await runner.active.done;
      assert.equal(runner.state().outcome, 'completed', runner.state().error);
      return Date.now() - started;
    }
    const clicks = (): Promise<Array<{ x: number; y: number }>> => win.webContents.executeJavaScript('clicks') as Promise<Array<{ x: number; y: number }>>;
    const keys = (): Promise<string[]> => win.webContents.executeJavaScript('keys') as Promise<string[]>;

    // Stage 1: background1에서 target1(던전 클리어!) 탐지 후 클릭 + 2초 대기.
    // image_wait으로 폴링 탐지하므로 렌더 타이밍과 실제 출현 타이밍에 모두 강건하다.
    current = stages[0] as Stage;
    await showBackground(win, current);
    await run([imageAction('image_wait')]);
    assert.equal(seen.length, 1, 'target1 탐지 기록이 없습니다.');
    const found1: { stage: string; x: number; y: number; width: number; height: number; score: number } = seen[0] as { stage: string; x: number; y: number; width: number; height: number; score: number };
    const center1: { x: number; y: number } = { x: Math.round(found1.x + found1.width / 2), y: Math.round(found1.y + found1.height / 2) };
    assert(Math.abs(center1.x - current.expect.x) <= 12 && Math.abs(center1.y - current.expect.y) <= 12,
      `target1 탐지 위치가 기대값과 다릅니다: ${JSON.stringify(center1)}`);
    const waited: number = await run([{ type: 'click', x: center1.x, y: center1.y, button: 'left', timeout_ms: 10000 }, { type: 'wait', duration_ms: 2000, timeout_ms: 10000 }]);
    assert(waited >= 1900, `2초 대기가 실행되지 않았습니다: ${waited}ms`);
    const clicks1: Array<{ x: number; y: number }> = await clicks();
    assert(clicks1.length === 1, `클릭이 1회 기록되어야 합니다: ${JSON.stringify(clicks1)}`);
    assert(Math.abs((clicks1[0] as { x: number; y: number }).x - current.expect.x) <= 12 && Math.abs((clicks1[0] as { x: number; y: number }).y - current.expect.y) <= 12,
      `클릭 위치가 탐지 중심과 다릅니다: ${JSON.stringify(clicks1[0])}`);

    // Stage 2: background2에서 target2(나가기) 탐지 후 space 입력.
    current = stages[1] as Stage;
    await showBackground(win, current);
    assert.deepEqual(await clicks(), [], '배경 교체 전에 클릭이 추가로 발생했습니다.');
    await run([imageAction('image_wait'), { type: 'key', keys: 'space', timeout_ms: 10000 }]);
    assert.equal(seen.length, 2, 'target2 탐지 기록이 없습니다.');
    const found2: { stage: string; x: number; y: number; width: number; height: number; score: number } = seen[1] as { stage: string; x: number; y: number; width: number; height: number; score: number };
    const center2: { x: number; y: number } = { x: found2.x + found2.width / 2, y: found2.y + found2.height / 2 };
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
setTimeout((): void => { app.exit(2); }, 180000).unref();
