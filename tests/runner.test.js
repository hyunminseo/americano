const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MacroRunner } = require('../src/runner');
const { newMacro } = require('../src/macros');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const macro = (actions) => ({ ...newMacro(), actions });
test('claims lock synchronously, cancels a long wait and permits a subsequent run', async () => {
  const runner = new MacroRunner(); const a = macro([{ type: 'wait', duration_ms: 60000 }]);
  runner.start(a, { preview: true });
  assert.throws(() => runner.start(a, { preview: true }), /이미 실행/);
  const start = Date.now(); await runner.stop();
  assert.ok(Date.now() - start < 500);
  assert.equal(runner.state().outcome, 'cancelled');
  runner.start(macro([{ type: 'wait', duration_ms: 0 }]), { preview: true });
  await runner.active.done;
  assert.equal(runner.state().completed, 1);
});
test('pause preserves remaining wait and blocks following steps', async () => {
  const runner = new MacroRunner();
  runner.start(macro([{ type: 'wait', duration_ms: 120 }, { type: 'key', keys: 'enter' }]), { preview: true });
  await sleep(25); runner.pause();
  await sleep(160);
  assert.equal(runner.state().status, 'PAUSED'); assert.deepEqual(runner.state().step, [0]);
  runner.pause(); await sleep(30);
  assert.equal(runner.state().status, 'RUNNING');
  await runner.active.done; assert.equal(runner.state().outcome, 'completed');
});
test('preview never calls input or authorization, and runs a snapshot', async () => {
  let called = 0;
  const runner = new MacroRunner({ authorize: async () => { called++; }, input: { execute: async () => { called++; }, releaseAll: async () => { called++; } } });
  const a = macro([{ type: 'wait', duration_ms: 25 }, { type: 'key', keys: 'enter' }]);
  runner.start(a, { preview: true }); a.actions[1] = { type: 'stop' };
  await runner.active.done;
  assert.equal(called, 0); assert.equal(runner.state().outcome, 'completed');
});
test('authorization failure persists across state reads', async () => {
  const runner = new MacroRunner(); runner.start(macro([{ type: 'key', keys: 'enter' }]));
  await runner.active.done;
  assert.equal(runner.state().status, 'ERROR'); assert.match(runner.state().error, /라이선스/);
  assert.equal(runner.state().status, 'ERROR');
});
test('stop retains lock until native operation and release cleanup settle', async () => {
  let finish; let release; let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const runner = new MacroRunner({ authorize: async () => {}, input: {
    execute: () => { entered(); return new Promise((resolve) => { finish = resolve; }); },
    releaseAll: () => new Promise((resolve) => { release = resolve; }),
  } });
  const a = macro([{ type: 'key', keys: 'enter' }]); runner.start(a); await started;
  const stopping = runner.stop(); assert.throws(() => runner.start(a), /이미 실행/);
  finish();
  while (!release) await sleep(1);
  assert.throws(() => runner.start(a), /이미 실행/); release(); await stopping;
  assert.equal(runner.state().outcome, 'cancelled');
});
test('timed out native operation prevents following input and drains before unlocking', async () => {
  let called = 0;
  const runner = new MacroRunner({ authorize: async () => {}, input: {
    execute: async (_action, _target, control) => { called++; while (!control.abort.signal.aborted) await sleep(2); },
    releaseAll: async () => {},
  } });
  runner.start(macro([{ type: 'key', keys: 'enter', timeout_ms: 15 }, { type: 'key', keys: 'a' }]));
  await runner.active.done;
  assert.equal(called, 1); assert.equal(runner.state().status, 'ERROR'); assert.match(runner.state().error, /timeout/);
});
