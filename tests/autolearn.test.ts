import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import type { TestContext } from 'node:test';
import { validateDocument, newMacro } from '../src/macros.js';
import { learnRoi } from '../src/resolution.js';
import { matchCandidates } from '../src/detect.js';
import { MacroStore } from '../src/store.js';
import { exportMacro, decodePackage, rebindOverlay } from '../src/portable.js';

const dir = path.join(__dirname, 'test_images');
const protector = { isEncryptionAvailable: () => true, encryptString: (s: any) => Buffer.from(s), decryptString: (b: any) => b.toString() };

function imageAction(overrides: any = {}): any {
  const macro = validateDocument({ version: 2, macros: [{ ...newMacro(), actions: [{ type: 'image_detect', image: 'asset-1', ...overrides }] }] }).macros[0];
  return macro.actions[0];
}

test('대체 이미지는 최대 2개, 중복 금지', () => {
  assert.deepEqual(imageAction().alt_images, []);
  assert.deepEqual(imageAction({ alt_images: ['a', 'b'] }).alt_images, ['a', 'b']);
  assert.throws(() => imageAction({ alt_images: ['a', 'b', 'c'] }), /최대 2개/);
  assert.throws(() => imageAction({ alt_images: ['asset-1'] }), /중복/);
  assert.throws(() => imageAction({ alt_images: ['a', 'a'] }), /중복/);
});

test('학습 필드가 검증되고 기본값은 null이다', () => {
  const macro = validateDocument({ version: 2, macros: [{ ...newMacro(), images: [{ id: 'a', name: 'n', path: 'p', region: { x: 0, y: 0, width: 10, height: 10 } }] }] }).macros[0];
  assert.equal(macro.images[0].learned_roi, null);
  assert.equal(macro.images[0].learned_scale_factor, null);
  const filled = validateDocument({ version: 2, macros: [{ ...newMacro(), images: [{ id: 'a', name: 'n', path: 'p', region: { x: 0, y: 0, width: 10, height: 10 }, learned_roi: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 }, learned_scale_factor: 0.9 }] }] }).macros[0];
  assert.deepEqual(filled.images[0].learned_roi, { x: 0.1, y: 0.1, width: 0.3, height: 0.3 });
  assert.equal(filled.images[0].learned_scale_factor, 0.9);
  assert.throws(() => validateDocument({ version: 2, macros: [{ ...newMacro(), images: [{ id: 'a', name: 'n', path: 'p', region: { x: 0, y: 0, width: 10, height: 10 }, learned_scale_factor: 9 }] }] }), /0.25~4/);
});

test('learnRoi는 적중 상자를 상대 ROI로 바꾸고 합친다', () => {
  const overlay = { x: 0, y: 0, width: 800, height: 600 };
  const first = learnRoi(null, { x: 396, y: 513, width: 125, height: 50 }, overlay);
  assert(first.x < 396 / 800 && first.y < 513 / 600, `여유가 없습니다: ${JSON.stringify(first)}`);
  assert(first.x + first.width > (396 + 125) / 800, '적중 상자를 포함해야 합니다.');
  assert(first.width >= 0.06 && first.height >= 0.06, '최소 크기를 보장해야 합니다.');
  const grown = learnRoi(first, { x: 100, y: 100, width: 50, height: 50 }, overlay);
  assert(grown.x <= first.x && grown.width >= first.width, '합집합으로 커져야 합니다.');
  for (const value of Object.values(grown)) assert(value >= 0 && value <= 1, '0~1을 벗어났습니다.');
  const edge = learnRoi(null, { x: 790, y: 590, width: 100, height: 100 }, overlay);
  assert(edge.x + edge.width <= 1 && edge.y + edge.height <= 1, '클램프되어야 합니다.');
});

test('matchCandidates는 순서대로 OR 판정한다', async () => {
  const frame = await sharp(path.join(dir, 'background1.png')).png().toBuffer();
  const area = { x: 0, y: 0, width: 1274, height: 952 };
  const absent = path.join(dir, 'target2.png');
  const present = path.join(dir, 'target1.png');
  const second = await matchCandidates(frame, area, [
    { template: absent, threshold: 0.9 },
    { template: present, threshold: 0.9 },
  ], null);
  assert.equal(second.index, 1, '두 번째 후보에서 맞아야 합니다.');
  assert(second.match!.score >= 0.9);
  const none = await matchCandidates(frame, area, [{ template: absent, threshold: 0.9 }], null);
  assert.deepEqual(none, { match: null, index: -1 });
  const first = await matchCandidates(frame, area, [
    { template: present, threshold: 0.9 },
    { template: absent, threshold: 0.9 },
  ], null);
  assert.equal(first.index, 0, '첫 번째 후보에서 맞아야 합니다.');
});

test('대체 이미지 참조가 패키지를 왕복한다', async (t: TestContext) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'americano-alt-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const store = new MacroStore(tmp, protector);
  await store.open();
  const make = (color: any): Promise<Buffer> => sharp({ create: { width: 12, height: 8, channels: 3, background: color } }).png().toBuffer();
  const fileA = await store.saveImage(await make('#3167ab'));
  const fileB = await store.saveImage(await make('#ab6731'));
  const macro = { ...newMacro(), overlay: { x: 0, y: 0, width: 400, height: 300 }, target_window: { process_name: 'app.exe' },
    images: [
      { id: 'a', name: '기본', path: fileA, region: { x: 10, y: 10, width: 12, height: 8 } },
      { id: 'b', name: '대체', path: fileB, region: { x: 20, y: 20, width: 12, height: 8 } },
    ],
    actions: [{ type: 'image_detect', image: fileA, alt_images: [fileB] }] };
  const { macro: decoded, assets } = await decodePackage(await exportMacro(macro, store));
  assert.equal(assets.size, 2);
  assert.deepEqual([decoded.actions[0].image, ...(decoded.actions[0].alt_images as string[])].sort(), ['asset-1', 'asset-2']);
});

test('학습값이 저장·유지·초기화되고 rebind 크기와 무관하게 ROI는 산다', async (t: TestContext) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'americano-learn-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const store = new MacroStore(tmp, protector);
  await store.open();
  const macro = newMacro();
  macro.target_window = { process_name: 'app.exe' };
  macro.overlay = { x: 0, y: 0, width: 800, height: 600 };
  macro.images = [{ id: 'a', name: 'n', path: 'p.png', preview: '', region: { x: 390, y: 510, width: 125, height: 50 }, learned_region: null, learned_roi: null, learned_scale_factor: null }];
  await store.save({ version: 2, macros: [macro] });
  const roi = learnRoi(null, { x: 396, y: 513, width: 125, height: 50 }, macro.overlay);
  await store.updateLearnedMatch(macro.id, 'p.png', { region: { x: 396, y: 513, width: 125, height: 50 }, roi, scaleFactor: 0.9 }, macro.target_window, macro.overlay);
  const saved = store.snapshot().macros[0].images[0];
  assert.deepEqual(saved.learned_roi, roi);
  assert.equal(saved.learned_scale_factor, 0.9);
  // 편집 저장(같은 영역)이 학습값을 보존한다.
  const stale = store.snapshot();
  await store.save(stale);
  assert.deepEqual(store.snapshot().macros[0].images[0].learned_roi, roi);
  // rebind 크기 변경: 절대 위치는 지워지고 상대 ROI·배율은 산다.
  const rebound = rebindOverlay(store.snapshot().macros[0], { x: 0, y: 0, width: 1280, height: 960 });
  assert.equal(rebound.images[0].learned_region, null);
  assert.deepEqual(rebound.images[0].learned_roi, roi);
  assert.equal(rebound.images[0].learned_scale_factor, 0.9);
  // 초기화는 모두 지운다.
  await store.resetLearned(macro.id, 'p.png');
  const cleared = store.snapshot().macros[0].images[0];
  assert.equal(cleared.learned_region, null);
  assert.equal(cleared.learned_roi, null);
  assert.equal(cleared.learned_scale_factor, null);
});
