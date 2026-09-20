import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import sharp from 'sharp';
import { resolveScale, effectivePercent, remapRect, remapPoint } from '../src/resolution.js';
import { scaleTemplate, findCoarseToFine, findZoned } from '../src/detect.js';
import { rebindOverlay } from '../src/portable.js';
import { newMacro } from '../src/macros.js';

const REF = { x: 0, y: 0, width: 1280, height: 960 };
const SMALL = { x: 0, y: 0, width: 800, height: 600 };

test('동일 종횡비에서는 균일 배율 0.625가 계산된다', () => {
  const scale = resolveScale(SMALL, REF);
  assert.equal(scale.uniform, true);
  assert.equal(scale.sx, 0.625);
  assert.equal(scale.sy, 0.625);
  assert.equal(effectivePercent(100, scale), 62.5);
  const noRef = resolveScale(SMALL, null);
  assert.deepEqual([noRef.sx, noRef.sy, noRef.estimated], [1, 1, false]);
});

test('종횡비가 다르면 비균일로 판정한다', () => {
  const wide = resolveScale({ x: 0, y: 0, width: 1706, height: 1066 }, REF);
  assert.equal(wide.uniform, false);
  const percent = effectivePercent(100, wide);
  assert.deepEqual(percent, { x: 133.3, y: 111 });
  assert.throws(() => effectivePercent(100, { sx: 0.1, sy: 0.1, uniform: true, estimated: true }), /너무 다릅니다/);
});

test('힌트와 고정 좌표가 오버레이 원점 기준으로 비례 이동한다', () => {
  const scale = resolveScale(SMALL, REF);
  assert.deepEqual(remapRect({ x: 633, y: 821, width: 200, height: 80 }, scale, { x: 0, y: 0 }, { x: 0, y: 0 }),
    { x: 396, y: 513, width: 125, height: 50 });
  assert.deepEqual(remapPoint(640, 480, scale, { x: 0, y: 0 }, { x: 0, y: 0 }), { x: 400, y: 300 });
  assert.equal(remapRect(null, scale), null);
});

test('템플릿이 가로·세로 각각 확대된다', async () => {
  const source = await sharp({ create: { width: 20, height: 10, channels: 3, background: 'white' } }).png().toBuffer();
  const resized = await scaleTemplate(source, { x: 150, y: 200 });
  const meta = await sharp(resized).metadata();
  assert.deepEqual([meta.width, meta.height], [30, 20]);
  assert.equal(await scaleTemplate(source, 100), source);
  await assert.rejects(scaleTemplate(source, 0), /25~400/);
  await assert.rejects(scaleTemplate(source, { x: 100, y: 10 }), /25~400/);
});

test('동일 종횡비 rebind는 좌표를 비례 변환하고 검토를 해제한다', () => {
  const raw = {
    ...newMacro(),
    overlay: { ...REF },
    binding: { needs_overlay: true, needs_review: false, source_overlay: { ...REF } },
    images: [{ id: 'img1', name: 'a', path: 'asset-1', preview: '', region: { x: 633, y: 821, width: 200, height: 80 }, learned_region: null }],
    actions: [{ type: 'click', x: 640, y: 480, coordinate_space: 'overlay', timeout_ms: 1000 }],
  };
  const rebound = rebindOverlay(raw, { ...SMALL });
  assert.deepEqual(rebound.actions[0].x, 400);
  assert.deepEqual(rebound.actions[0].y, 300);
  assert.deepEqual(rebound.images[0].region, { x: 396, y: 513, width: 125, height: 50 });
  assert.equal(rebound.binding!.needs_review, false);
  assert.equal(rebound.binding!.needs_overlay, false);
});

test('종횡비가 다른 rebind는 좌표를 건드리지 않고 검토를 유지한다', () => {
  const raw = {
    ...newMacro(),
    overlay: { ...REF },
    binding: { needs_overlay: true, needs_review: false, source_overlay: { ...REF } },
    images: [],
    actions: [{ type: 'click', x: 640, y: 480, coordinate_space: 'overlay', timeout_ms: 1000 }],
  };
  const rebound = rebindOverlay(raw, { x: 0, y: 0, width: 1706, height: 1066 });
  assert.deepEqual([rebound.actions[0].x, rebound.actions[0].y], [640, 480]);
  assert.equal(rebound.binding!.needs_review, true);
});

test('800x600 합성 장면에서 자동 배율로 탐지된다', async () => {
  const dir = path.join(__dirname, 'test_images');
  const ref = { x: 0, y: 0, width: 1274, height: 952 };
  const area = { x: 0, y: 0, width: 800, height: 600 };
  const frame = await sharp(path.join(dir, 'background1.png')).resize(800, 600).png().toBuffer();
  const scale = resolveScale(area, ref);
  assert.equal(scale.uniform, true);
  const template = await scaleTemplate(path.join(dir, 'target1.png'), effectivePercent(100, scale));
  const match = await findCoarseToFine(frame, template, 0.9, null);
  assert(match, '자동 배율로 target1을 찾지 못했습니다.');
  assert(match.score >= 0.9, `일치율이 낮습니다: ${match.score}`);
  assert(Math.abs(match.x + match.width / 2 - 402.5) <= 5, `중심 X가 다릅니다: ${JSON.stringify(match)}`);
  assert(Math.abs(match.y + match.height / 2 - 110.6) <= 5, `중심 Y가 다릅니다: ${JSON.stringify(match)}`);
  // 캡처 위치 힌트(1280 기준)를 800 기준으로 옮기면 홈에서 바로 맞는다.
  const hint = remapRect({ x: 528, y: 154, width: 232, height: 46 }, scale, { x: 0, y: 0 }, { x: 0, y: 0 });
  const zoned = await findZoned(frame, template, area, 0, 0.9, null, hint, null);
  assert(zoned, '힌트에서 찾지 못했습니다.');
  assert(Math.abs(zoned.x + zoned.width / 2 - 402.5) <= 5);
});

test('소수점 배율이 정수 반올림보다 정확하다', async () => {
  const dir = path.join(__dirname, 'test_images');
  const frame = await sharp(path.join(dir, 'background1.png')).resize(800, 600).png().toBuffer();
  const exact = await scaleTemplate(path.join(dir, 'target1.png'), 62.5);
  const rounded = await scaleTemplate(path.join(dir, 'target1.png'), 63);
  const good = await findCoarseToFine(frame, exact, 0.0, null);
  const rough = await findCoarseToFine(frame, rounded, 0.0, null);
  assert(good && rough, '기준 매치를 찾지 못했습니다.');
  // 선형 합성에서는 동등 수준이어야 한다(회귀 없음). 실템플릿 이득은 측정 스크립트로 확인.
  assert(Math.abs(good.score - rough.score) <= 0.02, `배율별 점수 차이 과다: ${good.score} vs ${rough.score}`);
});
