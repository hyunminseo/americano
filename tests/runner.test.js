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

test('supports image detection, retry, condition, and image click coordinates', async () => {
  let scans = 0; const inputs = [];
  const runner = new MacroRunner({ authorize: async () => {}, imageMatcher: async () => { scans += 1; return scans >= 2 ? { x: 10, y: 20, width: 30, height: 40 } : null; }, input: {
    execute: async (action) => { inputs.push(action); }, releaseAll: async () => {},
  } });
  const a = macro([{ type: 'retry', count: 2, interval_ms: 0, action: { type: 'image_detect', image: 'ok.png', region: { x: 0, y: 0, width: 100, height: 100 } } }, { type: 'image_click', image: 'ok.png', region: { x: 100, y: 200, width: 100, height: 100 } }]);
  runner.start(a); await runner.active.done;
  assert.equal(runner.state().outcome, 'completed');
  assert.deepEqual(inputs[0], { type: 'click', button: 'left', x: 125, y: 240, timeout_ms: 10000 });
});

test('click point hook is attached to the run control when provided', async () => {
  let seen = null;
  const runner = new MacroRunner({ authorize: async () => {}, onClickPoint: (point) => { seen = point; }, input: {
    execute: async (_action, _target, control) => { control.onClickPoint?.({ x: 1, y: 2 }); }, releaseAll: async () => {},
  } });
  runner.start(macro([{ type: 'key', keys: 'enter' }])); await runner.active.done;
  assert.equal(runner.state().outcome, 'completed');
  assert.deepEqual(seen, { x: 1, y: 2 });
});
test('condition selects only the matching branch', async () => {
  const inputs = [];
  const runner = new MacroRunner({ authorize: async () => {}, imageMatcher: async () => null, input: {
    execute: async (action) => inputs.push(action.type), releaseAll: async () => {},
  } });
  runner.start(macro([{ type: 'condition', test: { type: 'image_detect', image: 'missing.png' }, then: [{ type: 'key', keys: 'enter' }], else: [{ type: 'text', text: 'fallback' }] }]));
  await runner.active.done;
  assert.equal(runner.state().outcome, 'completed'); assert.deepEqual(inputs, ['text']);
});

test('overlay loop reevaluates conditions and executes true branch only on matches', async () => {
  let scans = 0; const inputs = [];
  const a = { ...macro([{ type: 'condition', test: {type:'image_detect', image:'saved.aimg'}, then:[{type:'key',keys:'enter'}], else:[] }]), overlay:{x:10,y:20,width:100,height:80}, loop:{count:3,interval_ms:30} };
  const runner = new MacroRunner({authorize: async()=>{}, imageMatcher: async (_action, _control, snapshot) => { assert.deepEqual(snapshot.overlay, a.overlay); return ++scans === 2 ? {x:1,y:2,width:3,height:4} : null; }, input:{execute:async action=>inputs.push(action),releaseAll:async()=>{}}});
  runner.start(a); await runner.active.done;
  assert.equal(scans,3); assert.equal(inputs.length,1); assert.equal(runner.state().iteration,3);
});
test('stop cancels the interval before another loop can run', async () => {
  let scans=0; let scanned;
  const first = new Promise(resolve=>{scanned=resolve;});
  const runner = new MacroRunner({authorize:async()=>{}, imageMatcher:async()=>{scans++;scanned();return null;}});
  runner.start({...macro([{type:'condition',test:{type:'image_detect',image:'a'},then:[],else:[]}]),loop:{count:10,interval_ms:60000}});
  await first; await runner.stop();
  assert.equal(scans,1); assert.equal(runner.state().outcome,'cancelled');
});

test('image scan timeout prevents a matching branch from running', async () => {
  let inputs=0;
  const runner=new MacroRunner({authorize:async()=>{},imageMatcher:async(_action,control)=>{while(true){await sleep(2);await control.checkpoint();}},input:{execute:async()=>{inputs++;},releaseAll:async()=>{}}});
  runner.start(macro([{type:'condition',test:{type:'image_detect',image:'a',timeout_ms:10},then:[{type:'key',keys:'enter'}],else:[]}]))
  await runner.active.done;assert.equal(inputs,0);assert.match(runner.state().error,/timeout/);
});
test('smart click verifies screen change after the center click', async () => {
  const inputs = []; let calls = 0;
  const runner = new MacroRunner({ authorize: async () => {}, imageMatcher: async () => (calls++ === 0 ? { x: 10, y: 20, width: 30, height: 40 } : null), input: {
    execute: async (action) => { inputs.push(action); }, releaseAll: async () => {},
  } });
  runner.start(macro([{ type: 'smart_click', image: 'ok.png', region: { x: 100, y: 200, width: 200, height: 200 }, verify_interval_ms: 100 }]));
  await runner.active.done;
  assert.equal(runner.state().outcome, 'completed');
  assert.deepEqual(inputs.map((a) => [a.x, a.y]), [[125, 240]]);
  assert.equal(calls, 2);
});
test('smart click falls back to upper and lower points while the screen persists', async () => {
  const inputs = []; let calls = 0;
  const runner = new MacroRunner({ authorize: async () => {}, imageMatcher: async () => (++calls <= 3 ? { x: 0, y: 0, width: 100, height: 100 } : null), input: {
    execute: async (action) => { inputs.push(action); }, releaseAll: async () => {},
  } });
  runner.start(macro([{ type: 'smart_click', image: 'ok.png', region: { x: 0, y: 0, width: 200, height: 200 }, verify_interval_ms: 100 }]));
  await runner.active.done;
  assert.equal(runner.state().outcome, 'completed');
  assert.deepEqual(inputs.map((a) => [a.x, a.y]), [[50, 50], [50, 25], [50, 75]]);
});
test('smart click accepts an expected image appearing instead of disappearance', async () => {
  const inputs = [];
  const seen = [];
  const runner = new MacroRunner({ authorize: async () => {}, imageMatcher: async (action) => {
    seen.push(action.image);
    if (action.image === 'ok.png') return { x: 0, y: 0, width: 20, height: 20 };
    return seen.filter((image) => image === 'next.png').length >= 1 ? { x: 5, y: 5, width: 10, height: 10 } : null;
  }, input: {
    execute: async (action) => { inputs.push(action); }, releaseAll: async () => {},
  } });
  runner.start(macro([{ type: 'smart_click', image: 'ok.png', expect_image: 'next.png', region: { x: 0, y: 0, width: 200, height: 200 }, verify_interval_ms: 100 }]));
  await runner.active.done;
  assert.equal(runner.state().outcome, 'completed');
  assert.equal(inputs.length, 1);
  assert.deepEqual([inputs[0].x, inputs[0].y], [10, 10]);
});
