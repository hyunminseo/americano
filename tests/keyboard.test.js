const { test } = require('node:test');
const assert = require('node:assert/strict');
const { KeyboardSender, keyEvent } = require('../src/keyboard');
const { RunControl } = require('../src/runner');
test('keys are virtual keys, combinations release in reverse order, F keys are mapped', async () => {
  const batches = [];
  const keyboard = new KeyboardSender({ isForeground: () => true, sendKeyboard: events => { batches.push(events); return events.length; } });
  await keyboard.press('ctrl+shift+a', 1, new RunControl());
  assert.deepEqual(batches[0].map(e => e.key), [0xa2, 0xa0, 65, 65, 0xa0, 0xa2]);
  assert.deepEqual(batches[0].map(e => Boolean(e.flags & 2)), [false, false, false, true, true, true]);
  assert.equal(keyEvent('f12').key, 123); assert.equal(keyEvent('left').flags, 1);
  assert.equal(keyboard.held.size, 0);
});
test('Unicode text is layout independent and cancellation stops remaining characters', async () => {
  const batches = []; const control = new RunControl();
  const keyboard = new KeyboardSender({ isForeground: () => true, sendKeyboard: events => { batches.push(events); if (batches.length === 2) control.stop(); return events.length; } });
  await assert.rejects(keyboard.type('한😀STOP', 1, control));
  assert.equal(batches.length, 2); assert.equal(batches[0][0].scan, '한'.charCodeAt(0));
  assert.equal(batches[1].length, 4); assert.equal(keyboard.held.size, 0);
});
test('partial native key delivery releases only injected keys', async () => {
  let count = 0; const batches = [];
  const keyboard = new KeyboardSender({ isForeground: () => true, sendKeyboard: events => { batches.push(events); return ++count === 1 ? 1 : events.length; } });
  await assert.rejects(keyboard.press('ctrl+a', 1, new RunControl()), /거부/);
  assert.deepEqual(batches[1], [{ key: 0xa2, flags: 2 }]); assert.equal(keyboard.held.size, 0);
});
test('focus change after pause prevents any keys reaching another window', async () => {
  let foreground = true; let sent = 0;
  const keyboard = new KeyboardSender({ isForeground: () => foreground, sendKeyboard: events => { sent++; return events.length; } });
  const control = new RunControl(); control.pause();
  const pending = keyboard.press('enter', 1, control);
  foreground = false; control.pause();
  await assert.rejects(pending, /전경/); assert.equal(sent, 0);
});
