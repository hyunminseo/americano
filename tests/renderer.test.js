const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function renderer() {
  const elements = new Map();
  const context = vm.createContext({
    document: { querySelector: (selector) => {
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
test('workflow moves nodes and resolves nested paths', () => {
  const { context } = renderer();
  const order = vm.runInContext(`JSON.stringify((() => { const m = { actions: [{type:'key',keys:'a'},{type:'key',keys:'b'}] }; moveStep(m, '1', -1); return m.actions.map(a=>a.keys); })())`, context);
  assert.deepEqual(JSON.parse(order), ['b', 'a']);
  const resolved = vm.runInContext(`JSON.stringify(resolvePath({ actions: [{ type: 'condition', test: { type: 'image_detect' }, then: [{ type: 'key' }], else: [] }] }, '0.then.0').action.type)`, context);
  assert.deepEqual(JSON.parse(resolved), 'key');
  assert.throws(() => vm.runInContext(`resolvePath({ actions: [] }, '0')`, context), /찾지 못했습니다/);
});
