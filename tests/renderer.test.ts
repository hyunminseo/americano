import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function renderer() {
  const elements = new Map();
  const context = vm.createContext({
    structuredClone,
    document: { querySelector: (selector: string) => {
      if (!elements.has(selector)) elements.set(selector, { innerHTML: '', querySelectorAll: () => [] });
      return elements.get(selector);
    } },
    window: { americano: { request: () => new Promise(() => {}), onState: () => {}, onStartHotkey: () => {}, onCaptureResult: undefined }, addEventListener: () => {}, Blockly: undefined, MacroBlocks: undefined },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../electron/renderer.js'), 'utf8'), context);
  return { context, elements };
}

test('empty workspace offers first macro setup without a configuration file', () => {
  const { context, elements } = renderer();
  vm.runInContext('render()', context);
  assert.match(elements.get('#editor').innerHTML, /첫 매크로 만들기/);
  assert.equal(typeof elements.get('#first-macro').onclick, 'function');
});

test('asset usages map nested image references to steps', () => {
  const { context } = renderer();
  const json = vm.runInContext(`JSON.stringify([...assetUsages({ actions: [
    { type: 'key', keys: 'enter' },
    { type: 'condition', test: { type: 'image_detect', image: 'a.png' }, then: [{ type: 'smart_click', image: 'b.png', expect_image: 'a.png' }], else: [] },
    { type: 'repeat', count: 2, actions: [{ type: 'image_click', image: 'a.png' }] },
  ] }).entries()])`, context);
  assert.deepEqual(JSON.parse(json), [
    ['a.png', [{ step: '2.검사.1', type: 'image_detect' }, { step: '2.참.1', type: 'smart_click' }, { step: '3.1', type: 'image_click' }]],
    ['b.png', [{ step: '2.참.1', type: 'smart_click' }]],
  ]);
});
test('workflow renders nested branches and escapes node text', () => {
  const { context } = renderer();
  const html = vm.runInContext(`workflowHtml({ images: [], actions: [{ type: 'repeat', count: 2, actions: [{ type: 'text', text: '<script>alert(1)</script>' }] }] })`, context);
  assert.match(html, /data-step="0\.0"/);
  assert.match(html, /반복 내부|반복 ×2/);
  assert.match(html, /data-add="0"/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|textarea|JSON/);
});
test('workflow moves nodes across containers and guards fixed paths', () => {
  const { context } = renderer();
  const moved = vm.runInContext(`JSON.stringify((() => {
    const m = { actions: [{ type: 'key', keys: 'a' }, { type: 'repeat', count: 2, actions: [{ type: 'wait', duration_ms: 1 }] }] };
    const key = moveStepTo(m, '0', '1', 1);
    return { key, types: m.actions[0].actions.map((a) => a.type) };
  })())`, context);
  assert.deepEqual(JSON.parse(moved), { key: '1.1', types: ['wait', 'key'] });
  assert.throws(() => vm.runInContext(`moveStepTo({ actions: [{ type: 'repeat', count: 1, actions: [] }] }, '0', '0', 0)`, context), /자기 안/);
  assert.throws(() => vm.runInContext(`moveStepTo({ actions: [{ type: 'condition', test: { type: 'image_detect' }, then: [], else: [] }] }, '0.test.0', '', 0)`, context), /고정된 단계/);
});
test('inspector numbers match workflow nodes and condition shows test image picker', () => {
  const { context, elements } = renderer();
  vm.runInContext(`selectedId = 'm1'; documentData = { version: 2, macros: [{ id: 'm1', images: [{ id: 'a', name: '버튼', path: 'b.png' }], actions: [{ type: 'wait', duration_ms: 100 }, { type: 'condition', test: { type: 'image_detect', image: '' }, then: [], else: [] }] }] }; selPath = '1';`, context);
  vm.runInContext(`renderInspector(documentData.macros[0])`, context);
  const html = elements.get('#inspector').innerHTML;
  assert.match(html, /2 · 조건 분기/);
  assert.match(html, /검사 이미지/);
  assert.match(html, /버튼/);
});
test('workflow moves nodes and resolves nested paths', () => {
  const { context } = renderer();
  const order = vm.runInContext(`JSON.stringify((() => { const m = { actions: [{type:'key',keys:'a'},{type:'key',keys:'b'}] }; moveStep(m, '1', -1); return m.actions.map((a) => a.keys); })())`, context);
  assert.deepEqual(JSON.parse(order), ['b', 'a']);
  const resolved = vm.runInContext(`JSON.stringify(resolvePath({ actions: [{ type: 'condition', test: { type: 'image_detect' }, then: [{ type: 'key' }], else: [] }] }, '0.then.0').action.type)`, context);
  assert.deepEqual(JSON.parse(resolved), 'key');
  assert.throws(() => vm.runInContext(`resolvePath({ actions: [] }, '0')`, context), /찾지 못했습니다/);
});

test('capture reorder preserves image references and rejects boundary moves', () => {
  const { context } = renderer();
  const result = vm.runInContext(`JSON.stringify((() => {
    const m = { images: [{id:'a',path:'a.png'}, {id:'b',path:'b.png'}, {id:'c',path:'c.png'}], actions: [{type:'image_click',image:'b.png'}] };
    const moved = moveAsset(m, 'b', -1);
    const boundary = moveAsset(m, 'b', -1);
    const missing = moveAsset(m, 'missing', 1);
    return { moved, boundary, missing, ids: m.images.map((a) => a.id), ref: m.actions[0].image };
  })())`, context);
  assert.deepEqual(JSON.parse(result), { moved: true, boundary: false, missing: false, ids: ['b','a','c'], ref: 'b.png' });
});

test('empty flow allows adding the first action on the canvas', () => {
  const { context } = renderer();
  assert.match(vm.runInContext('workflowHtml({actions:[]})', context), /data-add=""/);
});

test('pointed actions carry capture region as ROI', () => {
  const { context } = renderer();
  const result = vm.runInContext(`JSON.stringify((() => {
    const m = { overlay: { x: 0, y: 0, width: 800, height: 600 } };
    const asset = { path: 'b.png', region: { x: 400, y: 300, width: 200, height: 100 } };
    return {
      roi: roiFromAsset(m, asset),
      click: buildPointedAction(m, asset, 'click'),
      wait: buildPointedAction(m, asset, 'wait'),
      branch: buildPointedAction(m, asset, 'branch'),
      none: roiFromAsset({ overlay: null }, asset),
    };
  })())`, context);
  const parsed = JSON.parse(result);
  assert.deepEqual(parsed.roi, { x: 0.5, y: 0.5, width: 0.25, height: 0.167 });
  assert.equal(parsed.click.type, 'image_click');
  assert.equal(parsed.wait.type, 'image_wait');
  assert.equal(parsed.branch.type, 'condition');
  assert.equal(parsed.branch.then[0].type, 'image_click');
  assert.deepEqual(parsed.click.roi, parsed.roi);
  assert.equal(parsed.none, null);
});

test('sentence view describes steps without coordinates or paths', () => {  const { context } = renderer();
  const html = vm.runInContext(`describeSteps({ loop: { count: 10 }, images: [{ path: 'b.png', name: '시작 버튼', preview: 'data:image/png;base64,xx' }], actions: [
    { type: 'image_click', image: 'b.png', alt_images: ['c.png'], timeout_ms: 30000 },
    { type: 'image_wait', image: 'b.png', timeout_ms: 30000 },
    { type: 'condition', test: { type: 'image_detect', image: 'b.png' }, then: [{ type: 'key', keys: 'space' }], else: [] },
    { type: 'repeat', count: 3, actions: [{ type: 'wait', duration_ms: 500 }] },
  ] })`, context);
  assert.match(html, /시작 버튼.*나타나면 누르기/);
  assert.match(html, /나타날 때까지 기다리기.*최대 30초/);
  assert.match(html, /보이면/);
  assert.match(html, /안 보이면/);
  assert.match(html, /3회 반복/);
  assert.match(html, /10번 반복/);
  assert.match(html, /\+대체1/);
  assert.doesNotMatch(html, /b\.png/);
});

test('utterances become actions with repeat wrap and warnings', () => {  const { context } = renderer();
  const result = vm.runInContext(`JSON.stringify((() => {
    const m = { overlay: { x: 0, y: 0, width: 800, height: 600 }, images: [{ name: '시작 버튼', path: 's.png', region: { x: 0, y: 0, width: 100, height: 40 } }, { name: '완료', path: 'd.png', region: { x: 0, y: 0, width: 100, height: 40 } }] };
    return parseUtterances([
      '시작 버튼을 누르기',
      '완료될 때까지 기다리기 · 최대 30초',
      'space 누르기',
      '3초 기다리기',
      '10번 반복',
      '없는 버튼 누르기',
      '이건 뭔지 모르겠음',
    ].join(String.fromCharCode(10)), m);
  })())`, context);
  const parsed = JSON.parse(result);
  assert.equal(parsed.actions.length, 1);
  assert.equal(parsed.actions[0].type, 'repeat');
  assert.equal(parsed.actions[0].count, 10);
  const body = parsed.actions[0].actions;
  assert.deepEqual(body.map((a: any) => a.type), ['image_click', 'image_wait', 'key', 'wait', 'image_click']);
  assert.equal(body[0].image, 's.png');
  assert.equal(body[1].timeout_ms, 30000);
  assert.equal(body[4].image, '');
  assert.equal(parsed.warnings.length, 2);
});

test('validation receipt names the step, rule, and fix', () => {  const { context } = renderer();
  const result = vm.runInContext(`JSON.stringify(validateMacro({
    overlay: null, loop: { count: 1, interval_ms: 500 },
    images: [{ id: 'a', name: '안씀', path: 'unused.png' }],
    actions: [
      { type: 'image_click', image: '', alt_images: [], region: { x: 0, y: 0, width: 10, height: 10 }, timeout_ms: 1000 },
      { type: 'condition', test: { type: 'image_detect', image: 'used.png' }, then: [{ type: 'key', keys: 'space' }], else: [] },
    ],
  }))`, context);
  const issues = JSON.parse(result);
  const rules = issues.map((issue: any) => issue.rule);
  assert.ok(rules.includes('IMG-01'), '빈 이미지 규칙이 있어야 합니다.');
  assert.ok(rules.includes('RGN-01'), '영역 규칙이 있어야 합니다.');
  assert.ok(rules.includes('INFO-01'), '미사용 자산 안내가 있어야 합니다.');
  for (const issue of issues) {
    assert.match(issue.step, /[0-9.\-검사참거짓]+/);
    assert.ok(issue.message && issue.fix, '메시지와 고치는 법이 있어야 합니다.');
  }
});

test('picking an image auto-loads ROI from its capture region', () => {
  const { context } = renderer();
  const result = vm.runInContext(`JSON.stringify((() => {
    const m = { overlay: { x: 0, y: 0, width: 800, height: 600 }, images: [{ path: 'b.png', region: { x: 400, y: 300, width: 200, height: 120 } }] };
    const picked = { type: 'image_click', image: '', roi: null };
    applyAssetToAction(m, picked, 'b.png');
    const manual = { type: 'image_click', image: '', roi: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } };
    applyAssetToAction(m, manual, 'b.png');
    const unknown = { type: 'image_click', image: '', roi: null };
    applyAssetToAction(m, unknown, 'missing.png');
    const noOverlay = { type: 'image_click', image: '', roi: null };
    applyAssetToAction({ overlay: null, images: m.images }, noOverlay, 'b.png');
    return { picked, manual, unknown, noOverlay };
  })())`, context);
  const parsed = JSON.parse(result);
  assert.equal(parsed.picked.image, 'b.png');
  assert.deepEqual(parsed.picked.roi, { x: 0.5, y: 0.5, width: 0.25, height: 0.2 });
  assert.deepEqual(parsed.manual.roi, { x: 0.5, y: 0.5, width: 0.25, height: 0.2 });
  assert.equal(parsed.unknown.image, 'missing.png');
  assert.equal(parsed.unknown.roi, null);
  assert.equal(parsed.noOverlay.roi, null);
});
