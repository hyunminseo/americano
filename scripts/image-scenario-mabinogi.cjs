// Live scenario run against the real Mabinogi client.
// Flow: image_wait target1 (dungeon-clear banner) -> click its center ->
// runner wait 3000ms -> image_wait target2 (exit button) -> key space.
// Run with the game open; each image_wait polls until its screen appears.
const { app } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const sharp = require('sharp');
const native = require('../src/native-windows');
const { findWindow } = require('../src/windows');
const { createInputAdapter } = require('../src/input-adapter');
const { MacroRunner } = require('../src/runner');
const { newMacro } = require('../src/macros');
const { captureTarget } = require('../src/overlay');
const { findTemplate } = require('../src/matcher');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dir = path.join(__dirname, '..', 'tests', 'test_images');
const SCALE = 2;
const STAGE_TIMEOUT_MS = Number(process.env.STAGE_TIMEOUT_MS || 600000);
const SLEEP_MS = 3000;
const condition = { process_name: 'MabinogiMobile.exe' };
const stages = [
  { name: 'stage1-background1', target: 'target1.png', band: [0, 0.55] },
  { name: 'stage2-background2', target: 'target2.png', band: [0.35, 1] },
];
let current = stages[0];
let overlay = null;
const seen = [];

async function matchLive(action, control) {
  const area = action.region || overlay;
  const shot = await captureTarget(condition, area, control);
  const frame = await sharp(shot.buffer)
    .resize(Math.round(area.width / SCALE), Math.round(area.height / SCALE))
    .removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  const targetPath = current.targetPath;
  const templateMeta = await sharp(targetPath).metadata();
  const template = await sharp(targetPath)
    .resize(Math.round(templateMeta.width / SCALE), Math.round(templateMeta.height / SCALE))
    .removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  const match = await findTemplate(frame, template, action.threshold ?? 0.9, control);
  if (!match) return null;
  const found = {
    x: area.x + match.x * SCALE, y: area.y + match.y * SCALE,
    width: templateMeta.width, height: templateMeta.height, score: match.score,
  };
  seen.push({ stage: current.name, ...found });
  return found;
}

function imageWait(region) {
  return {
    type: 'image_wait', image: current.targetPath, threshold: 0.9, monitor: 1,
    poll_interval_ms: 1000, timeout_ms: STAGE_TIMEOUT_MS, region: { ...region },
  };
}

app.whenReady().then(async () => {
  try {
    console.log('MabinogiMobile 창을 찾는 중...');
    const info = await findWindow(condition, 300000, null);
    console.log(JSON.stringify({ window: { title: info.title, process: info.process_name } }));
    const client = native.geometry(info.handle);
    overlay = { x: 0, y: 0, width: client.width, height: client.height };
    console.log(JSON.stringify({ client }));
    // Windows 전경 정책이 activate()를 거부하면 타이틀바 실클릭으로 활성화한다 (게임 입력에 영향 없음).
    async function ensureForeground() {
      native.activate(info.handle);
      for (let i = 0; i < 20 && !native.isForeground(info.handle); i += 1) await sleep(100);
      if (native.isForeground(info.handle)) return true;
      const region = native.geometry(info.handle);
      await native.moveCursor({ x: region.x + 60, y: region.y - 12 });
      native.clickMouse('left');
      await sleep(600);
      for (let i = 0; i < 20 && !native.isForeground(info.handle); i += 1) await sleep(100);
      return native.isForeground(info.handle);
    }
    assert(await ensureForeground(), '게임 창을 전경으로 가져오지 못했습니다. 게임 창을 한 번 클릭한 뒤 다시 실행하세요.');
    for (const stage of stages) stage.targetPath = path.join(dir, stage.target);

    const runner = new MacroRunner({ input: createInputAdapter(), imageMatcher: matchLive, authorize: async () => {} });
    async function run(actions) {
      const macro = { ...newMacro(), target_window: condition, overlay: { ...overlay }, actions };
      runner.start(macro);
      await runner.active.done;
      assert.equal(runner.state().outcome, 'completed', runner.state().error);
    }
    const band = (stage) => ({
      x: 0,
      y: Math.round(overlay.height * stage.band[0]),
      width: overlay.width,
      height: Math.round(overlay.height * (stage.band[1] - stage.band[0])),
    });

    current = stages[0];
    console.log('stage1: background1 화면에서 target1(던전 클리어!) 대기 중... (게임을 플레이하세요)');
    const t0 = Date.now();
    await run([imageWait(band(current))]);
    const found1 = seen.at(-1);
    const center1 = { x: Math.round(found1.x + found1.width / 2), y: Math.round(found1.y + found1.height / 2) };
    console.log(JSON.stringify({ stage: 'stage1-detected', score: found1.score, click: center1, afterMs: Date.now() - t0 }));
    await run([
      { type: 'click', x: center1.x, y: center1.y, button: 'left', timeout_ms: 10000 },
      { type: 'wait', duration_ms: SLEEP_MS, timeout_ms: SLEEP_MS + 5000 },
    ]);
    console.log(JSON.stringify({ stage: 'stage1-clicked', sleptMs: SLEEP_MS }));

    current = stages[1];
    console.log('stage2: background2 화면에서 target2(나가기) 대기 중...');
    const t1 = Date.now();
    await run([imageWait(band(current)), { type: 'key', keys: 'space', timeout_ms: 10000 }]);
    const found2 = seen.at(-1);
    console.log(JSON.stringify({
      ok: true,
      stage1: { score: found1.score, click: center1 },
      stage2: { score: found2.score, center: { x: found2.x + found2.width / 2, y: found2.y + found2.height / 2 }, spacePressed: true, afterMs: Date.now() - t1 },
    }));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
setTimeout(() => { console.error(new Error('전체 제한 시간 초과')); app.exit(2); }, STAGE_TIMEOUT_MS * 2 + 120000).unref();
