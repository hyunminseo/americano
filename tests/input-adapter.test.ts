import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInputAdapter } from '../src/input-adapter.js';
import type { WindowAdapter, NativeAdapter } from '../src/input-adapter.js';
import type { KeyboardSender } from '../src/keyboard.js';
import { RunControl } from '../src/runner.js';

function fixture(): any {
  const events: any[] = [];
  const nativeAdapter = { isPointInWindow: () => true, isForeground: () => true, moveCursor: async (point: any) => { events.push(['move', point]); }, clickMouse: (button: any) => events.push(['click', button]) };
  const windowAdapter = { prepareWindow: async () => ({ window: { handle: 1 }, region: {} }), screenPoint: (_region: any, x: number, y: number) => ({ x: x + 100, y: y + 200 }) };
  return { events, nativeAdapter, input: createInputAdapter({ nativeAdapter: nativeAdapter as unknown as NativeAdapter, windowAdapter: windowAdapter as unknown as WindowAdapter, keyboard: { releaseAll() {} } as unknown as KeyboardSender }) };
}
test('coordinate click verifies hit target, moves to screen point and presses requested button', async () => {
  const { events, input } = fixture();
  await input.execute({ type: 'click', x: 30, y: 40, button: 'right' }, {}, new RunControl());
  assert.deepEqual(events, [['move', { x: 130, y: 240 }], ['click', 'right']]);
});
test('failed movement, covered point and changed foreground each prevent a click', async () => {
  for (const mode of ['movement', 'covered', 'foreground']) {
    const { events, input, nativeAdapter } = fixture();
    if (mode === 'movement') nativeAdapter.moveCursor = async () => { throw new Error('movement failed'); };
    if (mode === 'covered') nativeAdapter.isPointInWindow = () => false;
    if (mode === 'foreground') nativeAdapter.isForeground = () => false;
    await assert.rejects(input.execute({ type: 'click', x: 30, y: 40 }, {}, new RunControl()));
    assert.equal(events.some(([type]: any) => type === 'click'), false);
  }
});
test('stop while moving prevents mouse-down after the move settles', async () => {
  const { events, input, nativeAdapter } = fixture(); const control = new RunControl();
  nativeAdapter.moveCursor = async () => { control.stop(); };
  await assert.rejects(input.execute({ type: 'click', x: 30, y: 40 }, {}, control));
  assert.equal(events.length, 0);
});
test('click reports its screen point for visual feedback without affecting input', async () => {
  const { events, input } = fixture();
  const control = new RunControl(); const points: any[] = [];
  control.onClickPoint = (point: any) => points.push(point);
  await input.execute({ type: 'click', x: 30, y: 40 }, {}, control);
  assert.deepEqual(points, [{ x: 130, y: 240 }]);
  assert.deepEqual(events, [['move', { x: 130, y: 240 }], ['click', 'left']]);
});
test('move-only actions never report a click point', async () => {
  const { input } = fixture();
  const control = new RunControl(); let called = 0;
  control.onClickPoint = () => { called++; };
  await input.execute({ type: 'mouse_move', x: 5, y: 6 }, {}, control);
  assert.equal(called, 0);
});
