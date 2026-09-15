import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument, newMacro, applyPerfTuning } from '../src/macros.js';

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

test('retry wraps an image action or a condition with a wide count range', () => {
  const a = newMacro();
  const region = { x: 0, y: 0, width: 100, height: 100 };
  const cond = { type: 'condition', test: { type: 'image_detect', image: 'a.png', region }, then: [{ type: 'key', keys: 'space' }], else: [] };
  const validated = validateDocument(doc({ ...a, actions: [{ type: 'retry', count: 10000, interval_ms: 3000, action: cond }] })).macros[0].actions[0];
  assert.equal(validated.count, 10000);
  assert.equal((validated.action as any).type, 'condition');
  assert.throws(() => validateDocument(doc({ ...a, actions: [{ type: 'retry', count: 10001, action: cond }] })), /retry\.count/);
  assert.throws(() => validateDocument(doc({ ...a, actions: [{ type: 'retry', action: { type: 'key', keys: 'space' } }] })), /조건 분기/);
});

test('roi and threshold save instead of failing on range', () => {
  const a = newMacro();
  const region = { x: 0, y: 0, width: 100, height: 100 };
  const act = (overrides: any): any => validateDocument(doc({ ...a, actions: [{ type: 'image_detect', image: 'a.png', region, ...overrides }] })).macros[0].actions[0];
  assert.deepEqual(act({ roi: { x: 0.762, y: 0.331, width: 0.2, height: 0.305 } }).roi, { x: 0.762, y: 0.331, width: 0.2, height: 0.305 });
  assert.deepEqual(act({ roi: { x: 0.762, y: 0.331, width: 0.276, height: 0.305 } }).roi, { x: 0.762, y: 0.331, width: 0.238, height: 0.305 });
  assert.deepEqual(act({ roi: { x: '0.5', y: 0, width: 1.5, height: -2 } }).roi, { x: 0.5, y: 0, width: 0.5, height: 1 });
  assert.equal(act({ threshold: '0.95' }).threshold, 0.95);
  assert.equal(act({ threshold: 7 }).threshold, 1);
});

test('input mode defaults to foreground and keeps background', () => {
  assert.equal(validateDocument(doc(newMacro())).macros[0].input_mode, 'foreground');
  assert.equal(validateDocument(doc({ ...newMacro(), input_mode: 'background' })).macros[0].input_mode, 'background');
  assert.equal(validateDocument(doc({ ...newMacro(), input_mode: 'sideways' })).macros[0].input_mode, 'foreground');
});
test('run stats validate leniently and tune only confident image steps', () => {
  const region = { x: 0, y: 0, width: 100, height: 100 };
  const base = { ...newMacro(), actions: [{ type: 'image_detect', image: 'a.png', region, poll_interval_ms: 100 }] };
  const withStats = validateDocument(doc({ ...base, stats: { '0': { runs: 5, hits: 5, misses: 0, scans: 5, ms: 500, type: 'image_detect' }, broken: 42, '': { runs: 1 } } })).macros[0];
  assert.deepEqual(Object.keys(withStats.stats), ['0']);
  const tuned = applyPerfTuning(withStats);
  assert.equal(tuned.macro.actions[0].poll_interval_ms, 200);
  assert.equal(tuned.changes.length, 1);
  const slow = validateDocument(doc({ ...base, stats: { '0': { runs: 4, hits: 4, misses: 0, scans: 100, ms: 9000, type: 'image_detect' } } })).macros[0];
  const slowed = applyPerfTuning({ ...slow, actions: [{ ...slow.actions[0], poll_interval_ms: 1000 }] });
  assert.equal(slowed.macro.actions[0].poll_interval_ms, 500);
  // 타입이 바뀌면(구조 편집) 과거 통계로 조정하지 않는다.
  const changed = applyPerfTuning({ ...withStats, actions: [{ type: 'key', keys: 'space' }] });
  assert.equal(changed.changes.length, 0);
});

test('random wait defaults to 1–60 seconds and rejects reversed bounds',()=>{
  const action=validateDocument(doc({...newMacro(),actions:[{type:'random_wait'}]})).macros[0].actions[0];
  assert.equal(action.min_seconds,1);assert.equal(action.max_seconds,60);
 for(const range of [{min_seconds:0,max_seconds:60},{min_seconds:61,max_seconds:60},{min_seconds:1,max_seconds:3601}]) assert.throws(()=>validateDocument(doc({...newMacro(),actions:[{type:'random_wait',...range}]})));
});
