import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument, newMacro } from '../src/macros.js';

const doc = (...macros: any[]): any => ({ version: 2, macros });
test('normalizes hotkeys and rejects semantic duplicates and reserved keys', () => {
  const a = { ...newMacro(), enabled: true, hotkey: 'Shift+Control+A' };
  assert.equal(validateDocument(doc(a)).macros[0].hotkey, 'ctrl+shift+a');
  assert.throws(() => validateDocument(doc(a, { ...a, id: 'second', hotkey: 'ctrl+shift+a' })), /중복/);
  assert.throws(() => validateDocument(doc({ ...a, hotkey: 'F9' })), /예약/);
  assert.throws(() => validateDocument(doc({ ...a, actions: [{ type: 'key', keys: 'ctrl+invalid' }] })), /키 조합/);
});
test('smart click validates verify interval and optional expected image', () => {
  const a = newMacro();
  const base = { type: 'smart_click', image: 'button.png', region: { x: 0, y: 0, width: 100, height: 100 } };
  const validated = validateDocument(doc({ ...a, actions: [base] })).macros[0].actions[0];
  assert.equal(validated.verify_interval_ms, 800);
  assert.equal(validated.expect_image, undefined);
  const withExpect = validateDocument(doc({ ...a, actions: [{ ...base, verify_interval_ms: 500, expect_image: 'next.png' }] })).macros[0].actions[0];
  assert.equal(withExpect.verify_interval_ms, 500);
  assert.equal(withExpect.expect_image, 'next.png');
  assert.throws(() => validateDocument(doc({ ...a, actions: [{ ...base, verify_interval_ms: 50 }] })), /verify_interval/);
  assert.throws(() => validateDocument(doc({ ...a, actions: [{ ...base, image: 123 }] })), /image/);
});
test('rejects unsupported schema, actions, nonfinite values and oversized trees', () => {
  assert.throws(() => validateDocument({ version: 1, targets: [] }), /version 2/);
  const a = newMacro();
  for (const action of [{ type: 'execute' }, { type: 'wait', duration_ms: Infinity }, { type: 'click', x: -1, y: 0 }]) {
    assert.throws(() => validateDocument(doc({ ...a, actions: [action] })));
  }
  let nested: any[] = [{ type: 'wait', duration_ms: 0 }];
  for (let i = 0; i < 10; i++) nested = [{ type: 'repeat', count: 1, actions: nested }];
  assert.throws(() => validateDocument(doc({ ...a, actions: nested })), /중첩/);
  assert.throws(() => validateDocument(doc({ ...a, actions: Array.from({ length: 1001 }, () => ({ type: 'stop' })) })), /1,000/);
});

test('random wait defaults to 1–60 seconds and rejects reversed bounds',()=>{
 const action=validateDocument(doc({...newMacro(),actions:[{type:'random_wait'}]})).macros[0].actions[0];
 assert.equal(action.min_seconds,1);assert.equal(action.max_seconds,60);
 for(const range of [{min_seconds:0,max_seconds:60},{min_seconds:61,max_seconds:60},{min_seconds:1,max_seconds:3601}]) assert.throws(()=>validateDocument(doc({...newMacro(),actions:[{type:'random_wait',...range}]})));
});
