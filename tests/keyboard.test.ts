import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyboardSender, keyEvent } from '../src/keyboard.js';
import { RunControl } from '../src/runner.js';

test('keys are virtual keys, combinations release in reverse order, F keys are mapped', async () => {
  const batches: any[] = [];
  const keyboard = new KeyboardSender({ isForeground: () => true, sendKeyboard: (events: any) => { batches.push(events); return events.length; } });
  await keyboard.press('ctrl+shift+a', 1, new RunControl());
  assert.deepEqual(batches[0].map((e: any) => e.key), [0xa2, 0xa0, 65, 65, 0xa0, 0xa2]);
  assert.deepEqual(batches[0].map((e: any) => Boolean(e.flags & 2)), [false, false, false, true, true, true]);
  assert.equal(keyEvent('f12').key, 123); assert.equal(keyEvent('left').flags, 1);
  assert.equal(keyboard.held.size, 0);
});
test('Unicode text is layout independent and cancellation stops remaining characters', async () => {
  const batches: any[] = []; const control = new RunControl();
  const keyboard = new KeyboardSender({ isForeground: () => true, sendKeyboard: (events: any) => { batches.push(events); if (batches.length === 2) control.stop(); return events.length; } });
  await assert.rejects(keyboard.type('한😀STOP', 1, control));
  assert.equal(batches.length, 2); assert.equal(batches[0][0].scan, '한'.charCodeAt(0));
  assert.equal(batches[1].length, 4); assert.equal(keyboard.held.size, 0);
});
test('partial native key delivery releases only injected keys', async () => {
  let count = 0; const batches: any[] = [];
  const keyboard = new KeyboardSender({ isForeground: () => true, sendKeyboard: (events: any) => { batches.push(events); return ++count === 1 ? 1 : events.length; } });
  await assert.rejects(keyboard.press('ctrl+a', 1, new RunControl()), /거부/);
  assert.deepEqual(batches[1], [{ key: 0xa2, flags: 2 }]); assert.equal(keyboard.held.size, 0);
});
test('focus change after pause prevents any keys reaching another window', async () => {
  let foreground = true; let sent = 0;
  const keyboard = new KeyboardSender({ isForeground: () => foreground, sendKeyboard: (events: any) => { sent++; return events.length; } });
  const control = new RunControl(); control.pause();
  const pending = keyboard.press('enter', 1, control);
  foreground = false; control.pause();
  await assert.rejects(pending, /전경/); assert.equal(sent, 0);
});
test('background press posts key messages without foreground checks', async () => {
  const posted: any[] = [];
  const keyboard = new KeyboardSender({ isForeground: () => false, sendKeyboard: () => 0, postMessage: (handle: any, msg: number, w: number, l: number) => { posted.push([handle, msg, w, l]); } });
  await keyboard.press('ctrl+a', 7, new RunControl(), true);
  assert.deepEqual(posted.map(([h, msg, w]) => [h, msg, w]), [[7, 0x100, 0xa2], [7, 0x100, 65], [7, 0x101, 65], [7, 0x101, 0xa2]]);
  assert.equal(keyboard.backgroundHeld.length, 0);
});
test('background type posts WM_CHAR per code unit', async () => {
  const posted: any[] = [];
  const keyboard = new KeyboardSender({ isForeground: () => false, sendKeyboard: () => 0, postMessage: (handle: any, msg: number, w: number) => { posted.push([msg, w]); } });
  await keyboard.type('가', 7, new RunControl(), true);
  assert.deepEqual(posted, [[0x102, '가'.charCodeAt(0)]]);
});
test('background without postMessage support throws', async () => {
  const keyboard = new KeyboardSender({ isForeground: () => true, sendKeyboard: () => 0 });
  await assert.rejects(keyboard.press('a', 1, new RunControl(), true), /백그라운드/);
});
