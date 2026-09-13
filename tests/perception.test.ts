import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import sharp from 'sharp';
import { validateDocument, newMacro } from '../src/macros.js';
import { normalizeContrast, blockConsensus, loadTemplate } from '../src/matcher.js';
import { findCoarseToFine, findZoned, roiWindow, greyRaw } from '../src/detect.js';
import { matchFeatures, detectCorners, ransacSimilarity, refitSimilarity } from '../src/features.js';

const dir = path.join(__dirname, 'test_images');
const ART = path.join(__dirname, '..', 'artifacts');

function imageAction(overrides: any = {}): any {
  const macro = validateDocument({ version: 2, macros: [{ ...newMacro(), actions: [{ type: 'image_detect', image: 'asset-1', ...overrides }] }] }).macros[0];
  return macro.actions[0];
}

test('이미지 액션에 ROI·전처리·피라미드·특징점 옵션이 검증된다', () => {
  const base = imageAction();
  assert.equal(base.roi, null);
  assert.equal(base.preprocess, 'none');
  assert.equal(base.pyramid, false);
  assert.equal(base.features, 'off');
  const full = imageAction({ roi: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 }, preprocess: 'normalize', pyramid: true, features: 'fallback' });
  assert.deepEqual(full.roi, { x: 0.1, y: 0.2, width: 0.5, height: 0.4 });
  assert.equal(full.preprocess, 'normalize');
  assert.equal(full.pyramid, true);
  assert.equal(full.features, 'fallback');
  assert.throws(() => imageAction({ roi: { x: 0.8, y: 0, width: 0.5, height: 0.5 } }), /벗어/);
  assert.throws(() => imageAction({ preprocess: 'equalize' }), /preprocess/);
  assert.throws(() => imageAction({ features: 'sift' }), /features/);
});

test('ROI가 구역보다 먼저 탐색되고 잘못된 구역에서도 찾는다', async () => {
  const area = { x: 0, y: 0, width: 1274, height: 952 };
  assert.deepEqual(roiWindow(area, null), null);
  assert.deepEqual(roiWindow(area, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }),
    { x: 319, y: 238, width: 637, height: 476 });
  assert.equal(roiWindow(area, { x: 0, y: 0, width: 0.001, height: 0.001 }), null);
  const frame = await sharp(path.join(dir, 'background1.png')).png().toBuffer();
  // target1은 8구역이 아니라 7구역 쪽에 있다. ROI를 주면 구역과 무관하게 맞는다.
  const hit = await findZoned(frame, path.join(dir, 'target1.png'), area, 3, 0.9, null, null, null,
    { roi: { x: 0.3, y: 0.05, width: 0.45, height: 0.25 } });
  assert(hit, 'ROI에서 target1을 찾지 못했습니다.');
  assert(Math.abs(hit.x + hit.width / 2 - 644) <= 4);
});

test('명암 정규화 후에도 정상 템플릿이 탐지된다', async () => {
  const frame = await sharp(path.join(dir, 'background1.png')).png().toBuffer();
  const match = await findCoarseToFine(frame, path.join(dir, 'target1.png'), 0.9, null, { preprocess: 'normalize' });
  assert(match, 'normalize 후 target1을 찾지 못했습니다.');
  assert(match.score >= 0.9, `일치율이 낮습니다: ${match.score}`);
  const flat = normalizeContrast(Buffer.from([100, 100, 100, 100]));
  assert.deepEqual([...flat], [100, 100, 100, 100]);
});

test('닮은꼴 버튼 오인식은 차단하고 진짜는 통과한다', async () => {
  const frame = await sharp(path.join(dir, 'background2.png')).resize(1280, 960).png().toBuffer();
  const button = path.join(ART, 'cur6btn.png');
  // NCC만으로는 0.951 오인식이 나지만 블록 합의에서 걸러진다.
  const frameGrey = await greyRaw(frame);
  const templateGrey = await loadTemplate(button);
  const verdict = blockConsensus(frameGrey, templateGrey, 407, 859, 0.9);
  assert(verdict.mean < 1 && verdict.ratio <= 1, '합의 구조가 깨졌습니다.');
  const blocked = await findCoarseToFine(frame, button, 0.9, null);
  assert(blocked === null || blocked.score < 0.9 + 0.12, '의심 구간 판정이 필요합니다.');
  const good = await sharp({ create: { width: 900, height: 500, channels: 3, background: '#20242c' } })
    .composite([{ input: await sharp(button).png().toBuffer(), left: 300, top: 200 }]).png().toBuffer();
  const hit = await findCoarseToFine(good, button, 0.9, null);
  assert(hit, '진짜 버튼을 오차단했습니다.');
  assert(hit.score >= 0.99);
});

test('피라미드로 0.8배 버튼을 찾는다', async () => {
  const button = await sharp(path.join(ART, 'cur6btn.png')).png().toBuffer();
  const small = await sharp(path.join(ART, 'cur6btn.png')).resize({ width: 160 }).png().toBuffer();
  const frame = await sharp({ create: { width: 900, height: 500, channels: 3, background: '#20242c' } })
    .composite([{ input: small, left: 350, top: 250 }]).png().toBuffer();
  const area = { x: 0, y: 0, width: 900, height: 500 };
  assert.equal(await findZoned(frame, path.join(ART, 'cur6btn.png'), area, 0, 0.9, null, null, null), null);
  const hit = await findZoned(frame, path.join(ART, 'cur6btn.png'), area, 0, 0.9, null, null, null, { scales: [1, 0.9, 0.8] });
  assert(hit, '피라미드로 0.8배 버튼을 찾지 못했습니다.');
  assert(Math.abs(hit.x - 350) <= 3 && Math.abs(hit.y - 250) <= 3);
});

test('특징점은 회전을 찾고 무관한 화면은 null이다', async () => {
  const target = await greyRaw(await sharp(path.join(dir, 'target1.png')).png().toBuffer());
  const rotated = await sharp(path.join(dir, 'target1.png')).rotate(15, { background: '#000000' }).png().toBuffer();
  const frame = await greyRaw(await sharp({ create: { width: 900, height: 500, channels: 3, background: '#20242c' } })
    .composite([{ input: rotated, left: 300, top: 200 }]).png().toBuffer());
  const found = await matchFeatures(frame, target);
  assert(found, '회전된 target1을 찾지 못했습니다.');
  assert(found.inliers >= 10, `인라이어 부족: ${found.inliers}`);
  assert(Math.abs(found.rotation_deg - 15) <= 3, `회전각 오차: ${found.rotation_deg}`);
  // 중심 오차는 템플릿 대각선의 10% 이내여야 한다.
  const centerError = Math.hypot(found.x + found.width / 2 - 418, found.y + found.height / 2 - 252);
  assert(centerError <= Math.hypot(232, 46) * 0.1, `중심 오차: ${centerError}`);
  const negative = await greyRaw(await sharp(path.join(dir, 'background2.png')).resize(900, 500).png().toBuffer());
  assert.equal(await matchFeatures(negative, target), null);
});

test('특징점 검증이 doubt band 오인식을 탈락시킨다', async () => {
  const frame = await sharp(path.join(dir, 'background2.png')).resize(1280, 960).png().toBuffer();
  const area = { x: 0, y: 0, width: 1280, height: 960 };
  const button = path.join(ART, 'cur6btn.png');
  const plain = await findZoned(frame, button, area, 0, 0.9, null, null, null, { features: 'off' });
  assert(plain && plain.score >= 0.9 && plain.score < 0.9 + 0.08, `오인식 함정이 성립하지 않습니다: ${JSON.stringify(plain)}`);
  const verified = await findZoned(frame, button, area, 0, 0.9, null, null, null, { features: 'fallback' });
  assert.equal(verified, null, '검증이 오인식을 통과시켰습니다.');
  const corners = detectCorners(await greyRaw(await sharp(button).png().toBuffer()), 150);
  assert(corners.length >= 8, '검증 가능한 코너가 부족합니다.');
});

test('RANSAC 재적합이 2점 해보다 정확하다', () => {
  const matches: any[] = [];
  for (let i = 0; i < 10; i += 1) {
    matches.push({ template: { x: i * 10, y: (i % 3) * 10 }, frame: { x: 100 + i * 8, y: 50 + (i % 3) * 8 }, distance: 10 });
  }
  matches.push({ template: { x: 5, y: 5 }, frame: { x: 900, y: 900 }, distance: 10 });
  const result = ransacSimilarity(matches);
  assert(result, '합의에 실패했습니다.');
  assert(result.inliers.length >= 10, `인라이어 부족: ${result.inliers.length}`);
  assert(Math.abs(result.model.scale - 0.8) <= 0.05, `스케일 오차: ${result.model.scale}`);
  assert(refitSimilarity(result.inliers), '재적합에 실패했습니다.');
});
