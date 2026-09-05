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
    window: { americano: { request: () => new Promise(() => {}), onState: () => {} }, addEventListener: () => {} },
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

test('nested repeats render editable cards and escape user text without raw JSON', () => {
  const { context } = renderer();
  const html = vm.runInContext(`stepCards([{ type: 'repeat', count: 2, actions: [{ type: 'text', text: '<script>alert(1)</script>' }] }])`, context);
  assert.match(html, /data-step="0.0"/);
  assert.match(html, /반복 내부 단계 추가/);
  assert.match(html, /data-field="text"/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|textarea|JSON|\?\?\?/);
});
