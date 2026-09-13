// Live scenario run against the real Mabinogi client.
// Flow: image_wait target1 (dungeon-clear banner) -> click its center ->
// runner wait 3000ms -> image_wait target2 (exit button) -> key space.
// Run with the game open; each image_wait polls until its screen appears.
import { app } from 'electron';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import sharp from 'sharp';
import * as native from '../src/native-windows.js';
import { findWindow } from '../src/windows.js';
import { createInputAdapter } from '../src/input-adapter.js';
import { MacroRunner } from '../src/runner.js';
import { newMacro } from '../src/macros.js';
import { captureTarget } from '../src/overlay.js';
import { findTemplate } from '../src/matcher.js';

interface OverlayArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Stage {
  name: string;
  target: string;
  band: [number, number];
  targetPath?: string;
}

interface FoundBox {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

type MacroActionRecord = Record<string, unknown> & { type: string };
type RunnerLike = { start(macro: Record<string, unknown>): void; active: { done: Promise<unknown> }; state(): { outcome: string; error?: string } };
type ControlLike = Record<string, unknown>;

const sleep = (ms: number): Promise<void> => new Promise((resolve: (value: void) => void) => setTimeout(resolve, ms));
const dir: string = path.join(__dirname, '..', 'tests', 'test_images');
const SCALE: number = 2;
const STAGE_TIMEOUT_MS: number = Number(process.env.STAGE_TIMEOUT_MS || 600000);
const SLEEP_MS: number = 3000;
const condition: Record<string, string> = { process_name: 'MabinogiMobile.exe' };
const stages: Stage[] = [
  { name: 'stage1-background1', target: 'target1.png', band: [0, 0.55] },
  { name: 'stage2-background2', target: 'target2.png', band: [0.35, 1] },
];
let current: Stage = stages[0] as Stage;
let overlay: OverlayArea | null = null;
const seen: Array<{ stage: string } & FoundBox> = [];

async function matchLive(action: MacroActionRecord, control: ControlLike): Promise<FoundBox | null> {
  const area: OverlayArea = (action.region as OverlayArea) || (overlay as OverlayArea);
  const shot: { buffer: Buffer } = await (captureTarget as (target: unknown, area: unknown, control?: unknown) => Promise<{ buffer: Buffer }>)(condition, area, control);
  const frame: { data: Buffer; info: { width: number; height: number } } = await sharp(shot.buffer)
    .resize(Math.round(area.width / SCALE), Math.round(area.height / SCALE))
    .removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  const targetPath: string = current.targetPath as string;
  const templateMeta: { width?: number; height?: number } = await sharp(targetPath).metadata();
  const template: { data: Buffer; info: { width: number; height: number } } = await sharp(targetPath)
    .resize(Math.round((templateMeta.width as number) / SCALE), Math.round((templateMeta.height as number) / SCALE))
    .removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  const match: { x: number; y: number; score: number } | null = await (findTemplate as (frame: unknown, template: unknown, threshold: number, control?: unknown) => Promise<{ x: number; y: number; score: number } | null>)(frame, template, (action.threshold as number) ?? 0.9, control);
  if (!match) return null;
  const found: FoundBox = {
    x: area.x + match.x * SCALE, y: area.y + match.y * SCALE,
    width: templateMeta.width as number, height: templateMeta.height as number, score: match.score,
  };
  seen.push({ stage: current.name, ...found });
  return found;
}

function imageWait(region: OverlayArea): MacroActionRecord {
  return {
    type: 'image_wait', image: current.targetPath as string, threshold: 0.9, monitor: 1,
    poll_interval_ms: 1000, timeout_ms: STAGE_TIMEOUT_MS, region: { ...region },
  };
}

app.whenReady().then(async (): Promise<void> => {
  try {
    console.log('MabinogiMobile 창을 찾는 중...');
    const info: { title: string; process_name: string; handle: unknown } = await (findWindow as (condition: unknown, timeout: number, control: null) => Promise<{ title: string; process_name: string; handle: unknown }>)(condition, 300000, null);
    console.log(JSON.stringify({ window: { title: info.title, process: info.process_name } }));
    const client: { width: number; height: number } = (native as { geometry: (handle: unknown) => { width: number; height: number } }).geometry(info.handle);
    overlay = { x: 0, y: 0, width: client.width, height: client.height };
    console.log(JSON.stringify({ client }));
    // Windows 전경 정책이 activate()를 거부하면 타이틀바 실클릭으로 활성화한다 (게임 입력에 영향 없음).
    async function ensureForeground(): Promise<boolean> {
      (native as { activate: (handle: unknown) => void }).activate(info.handle);
      for (let i: number = 0; i < 20 && !(native as { isForeground: (handle: unknown) => boolean }).isForeground(info.handle); i += 1) await sleep(100);
      if ((native as { isForeground: (handle: unknown) => boolean }).isForeground(info.handle)) return true;
      const region: { x: number; y: number } = (native as { geometry: (handle: unknown) => { x: number; y: number } }).geometry(info.handle);
      await (native as { moveCursor: (point: { x: number; y: number }) => Promise<void> }).moveCursor({ x: region.x + 60, y: region.y - 12 });
      (native as { clickMouse: (button: string) => void }).clickMouse('left');
      await sleep(600);
      for (let i: number = 0; i < 20 && !(native as { isForeground: (handle: unknown) => boolean }).isForeground(info.handle); i += 1) await sleep(100);
      return (native as { isForeground: (handle: unknown) => boolean }).isForeground(info.handle);
    }
    assert(await ensureForeground(), '게임 창을 전경으로 가져오지 못했습니다. 게임 창을 한 번 클릭한 뒤 다시 실행하세요.');
    for (const stage of stages) stage.targetPath = path.join(dir, stage.target);

    const runner: RunnerLike = new (MacroRunner as new (options: Record<string, unknown>) => RunnerLike)({ input: (createInputAdapter as () => unknown)(), imageMatcher: matchLive, authorize: async (): Promise<void> => {} });
    async function run(actions: MacroActionRecord[]): Promise<void> {
      const macro: Record<string, unknown> = { ...(newMacro as () => Record<string, unknown>)(), target_window: condition, overlay: { ...(overlay as OverlayArea) }, actions };
      runner.start(macro);
      await runner.active.done;
      assert.equal(runner.state().outcome, 'completed', runner.state().error);
    }
    const band = (stage: Stage): OverlayArea => ({
      x: 0,
      y: Math.round((overlay as OverlayArea).height * stage.band[0]),
      width: (overlay as OverlayArea).width,
      height: Math.round((overlay as OverlayArea).height * (stage.band[1] - stage.band[0])),
    });

    current = stages[0] as Stage;
    console.log('stage1: background1 화면에서 target1(던전 클리어!) 대기 중... (게임을 플레이하세요)');
    const t0: number = Date.now();
    await run([imageWait(band(current))]);
    const found1: { stage: string } & FoundBox = seen.at(-1) as { stage: string } & FoundBox;
    const center1: { x: number; y: number } = { x: Math.round(found1.x + found1.width / 2), y: Math.round(found1.y + found1.height / 2) };
    console.log(JSON.stringify({ stage: 'stage1-detected', score: found1.score, click: center1, afterMs: Date.now() - t0 }));
    await run([
      { type: 'click', x: center1.x, y: center1.y, button: 'left', timeout_ms: 10000 },
      { type: 'wait', duration_ms: SLEEP_MS, timeout_ms: SLEEP_MS + 5000 },
    ]);
    console.log(JSON.stringify({ stage: 'stage1-clicked', sleptMs: SLEEP_MS }));

    current = stages[1] as Stage;
    console.log('stage2: background2 화면에서 target2(나가기) 대기 중...');
    const t1: number = Date.now();
    await run([imageWait(band(current)), { type: 'key', keys: 'space', timeout_ms: 10000 }]);
    const found2: { stage: string } & FoundBox = seen.at(-1) as { stage: string } & FoundBox;
    console.log(JSON.stringify({
      ok: true,
      stage1: { score: found1.score, click: center1 },
      stage2: { score: found2.score, center: { x: found2.x + found2.width / 2, y: found2.y + found2.height / 2 }, spacePressed: true, afterMs: Date.now() - t1 },
    }));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
setTimeout((): void => { console.error(new Error('전체 제한 시간 초과')); app.exit(2); }, STAGE_TIMEOUT_MS * 2 + 120000).unref();
