const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sharp = require('sharp');
const { findCoarseToFine, zoneRegion, findZoned, homeWindow } = require('../src/detect');

const dir = path.join(__dirname, 'test_images');
const background1 = path.join(dir, 'background1.png');
const target1 = path.join(dir, 'target1.png');
const target2 = path.join(dir, 'target2.png');

test('coarse-to-fine finds the clear banner at full resolution coordinates', async () => {
  const frame = await sharp(background1).png().toBuffer();
  const started = Date.now();
  const match = await findCoarseToFine(frame, target1, 0.9, null);
  assert(match, 'target1을 찾지 못했습니다.');
  assert(match.score >= 0.9, `일치율이 낮습니다: ${match.score}`);
  assert(Math.abs(match.x + match.width / 2 - 644) <= 4, `중심 X가 다릅니다: ${JSON.stringify(match)}`);
  assert(Math.abs(match.y + match.height / 2 - 177) <= 4, `중심 Y가 다릅니다: ${JSON.stringify(match)}`);
  assert(Date.now() - started < 60000, '전체 클라이언트 탐색이 제한을 초과했습니다.');
});

test('zones split the area baseball-style with full fallback', async () => {
  const area = { x: 10, y: 20, width: 900, height: 600 };
  assert.deepEqual(zoneRegion(area, 0), area);
  assert.deepEqual(zoneRegion(area, 1), { x: 10, y: 420, width: 300, height: 200 });
  assert.deepEqual(zoneRegion(area, 5), { x: 310, y: 220, width: 300, height: 200 });
  assert.deepEqual(zoneRegion(area, 9), { x: 610, y: 20, width: 300, height: 200 });
  assert.deepEqual(zoneRegion(area, 2), { x: 310, y: 420, width: 300, height: 200 });
  assert.deepEqual(zoneRegion(area, 8), { x: 310, y: 20, width: 300, height: 200 });
  const frame = await sharp(background1).png().toBuffer();
  const full = { x: 0, y: 0, width: 1274, height: 952 };
  const zoned = await findZoned(frame, target1, full, 8, 0.9, null);
  assert(zoned, 'target1을 8구역에서 찾지 못했습니다.');
  assert(Math.abs(zoned.x + zoned.width / 2 - 644) <= 4);
  const fallback = await findZoned(frame, target1, full, 3, 0.9, null);
  assert(fallback, '잘못된 구역에서 전체 폴백으로 찾지 못했습니다.');
  assert(Math.abs(fallback.x + fallback.width / 2 - 644) <= 4);
});
test('absent template returns null and oversized template throws', async () => {
  const frame = await sharp(background1).png().toBuffer();
  assert.equal(await findCoarseToFine(frame, target2, 0.9, null), null);
  const exact = await sharp(background1).extract({ left: 528, top: 154, width: 232, height: 46 }).png().toBuffer();
  const direct = await findCoarseToFine(exact, target1, 0.9, null);
  assert.deepEqual([direct.x, direct.y], [0, 0]);
  assert(direct.score >= 0.9, `일치율이 낮습니다: ${direct.score}`);
  await assert.rejects(findCoarseToFine(exact, background1, 0.9, null), /검색 영역보다 큽니다/);
});
test('capture position is searched first with zone and full fallback', async () => {
  const area = { x: 0, y: 0, width: 1280, height: 960 };
  assert.deepEqual(homeWindow(area, { x: 500, y: 300, width: 100, height: 50 }), { x: 452, y: 252, width: 196, height: 146 });
  assert.equal(homeWindow(area, { x: 5000, y: 5000, width: 10, height: 10 }), null);
  assert.equal(homeWindow(area, null), null);
  const frame = await sharp(background1).png().toBuffer();
  const full = { x: 0, y: 0, width: 1274, height: 952 };
  const homeHit = await findZoned(frame, target1, full, 0, 0.9, null, { x: 528, y: 154, width: 232, height: 46 });
  assert(homeHit, '캡처 위치에서 찾지 못했습니다.');
  assert(Math.abs(homeHit.x + homeHit.width / 2 - 644) <= 4);
  const homeMiss = await findZoned(frame, target1, full, 8, 0.9, null, { x: 0, y: 800, width: 100, height: 60 });
  assert(homeMiss, '잘못된 캡처 위치에서 구역·전체 폴백으로 찾지 못했습니다.');
  assert(Math.abs(homeMiss.x + homeMiss.width / 2 - 644) <= 4);
});
