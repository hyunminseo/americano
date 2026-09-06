const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDocument, newMacro } = require('../src/macros');
const { matchesTarget, screenPoint } = require('../src/windows');
const { physicalRegion } = require('../src/overlay');
const { findTemplate } = require('../src/matcher');
const { RunControl } = require('../src/runner');

test('overlay and bounded loop survive validation; old documents retain defaults', () => {
  const original = { ...newMacro(), overlay: { x: 20, y: 30, width: 200, height: 100 }, loop: { count: 3, interval_ms: 40 } };
  const result = validateDocument({version: 2, macros: [original]}).macros[0];
  assert.deepEqual(result.overlay, original.overlay); assert.deepEqual(result.loop, original.loop);
  const old = validateDocument({version: 2, macros: [newMacro()]}).macros[0];
  assert.equal(old.overlay, null); assert.equal(old.loop.count, 1);
  for (const count of [0, 10001, Infinity]) assert.throws(() => validateDocument({version: 2, macros: [{...original, loop: { count }}]}));
  assert.throws(() => validateDocument({version: 2, macros: [{...original, overlay: {...original.overlay, width: -1}}]}));
});
test('target conditions all match, and DPI coordinates track moved windows', () => {
  const info = { title: 'Example - editor', process_name: 'example.exe', executable_path: 'C:\\example.exe' };
  assert.equal(matchesTarget(info, {process_name: 'EXAMPLE.EXE', title_contains: 'editor'}), true);
  assert.equal(matchesTarget(info, {process_name: 'wrong.exe', title_contains: 'editor'}), false);
  assert.equal(matchesTarget(info, {}), false);
  const client = {x: -1000, y: 100, width: 600, height: 400, dpi: 144};
  assert.deepEqual(physicalRegion(client, {x: 20, y: 30, width: 100, height: 50}), {x: -970, y: 145, width: 150, height: 75});
  assert.deepEqual(screenPoint(client, 20, 30), {x: -970, y: 145});
  assert.throws(() => physicalRegion(client, {x: 399, y: 0, width: 20, height: 20}), /벗어/);
});
test('matching returns location and yields so cancellation can interrupt scanning', async () => {
  const frame = {data: Buffer.from([0,0,0,0,0,1,2,0,0,3,4,0,0,0,0,0]), info: {width:4,height:4}};
  const template = {data: Buffer.from([1,2,3,4]), info:{width:2,height:2}};
  const found = await findTemplate(frame, template, 0.99);
  assert.equal(found.x, 1); assert.equal(found.y, 1);
  const control = new RunControl();
  setImmediate(() => control.stop());
  await assert.rejects(findTemplate({data: Buffer.alloc(40000), info:{width:200,height:200}}, template, 0.99, control));
});
