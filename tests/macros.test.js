const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDocument, newMacro } = require('../src/macros');
const doc = (...macros) => ({ version: 2, macros });
test('normalizes hotkeys and rejects semantic duplicates and reserved keys', () => {
  const a = { ...newMacro(), enabled: true, hotkey: 'Shift+Control+A' };
  assert.equal(validateDocument(doc(a)).macros[0].hotkey, 'ctrl+shift+a');
  assert.throws(() => validateDocument(doc(a, { ...a, id: 'second', hotkey: 'ctrl+shift+a' })), /중복/);
  assert.throws(() => validateDocument(doc({ ...a, hotkey: 'F9' })), /예약/);
  assert.throws(() => validateDocument(doc({ ...a, actions: [{ type: 'key', keys: 'ctrl+invalid' }] })), /키 조합/);
});
test('rejects unsupported schema, actions, nonfinite values and oversized trees', () => {
  assert.throws(() => validateDocument({ version: 1, targets: [] }), /version 2/);
  const a = newMacro();
  for (const action of [{ type: 'execute' }, { type: 'wait', duration_ms: Infinity }, { type: 'click', x: -1, y: 0 }]) {
    assert.throws(() => validateDocument(doc({ ...a, actions: [action] })));
  }
  let nested = [{ type: 'wait', duration_ms: 0 }];
  for (let i = 0; i < 10; i++) nested = [{ type: 'repeat', count: 1, actions: nested }];
  assert.throws(() => validateDocument(doc({ ...a, actions: nested })), /중첩/);
  assert.throws(() => validateDocument(doc({ ...a, actions: Array.from({ length: 1001 }, () => ({ type: 'stop' })) })), /1,000/);
});
