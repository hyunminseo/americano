const { test } = require('node:test');
const assert = require('node:assert/strict');
const Blockly = require('blockly');
const Blocks = require('../electron/blocks');
const { newMacro, validateDocument } = require('../src/macros');
const normalize = actions => validateDocument({ version: 2, macros: [{ ...newMacro(), actions }] }).macros[0].actions;
Blocks.register(Blockly, () => [{ name: '버튼', path: 'button.png' }]);
test('all supported legacy actions roundtrip through connected blocks', () => {
  const image = { type: 'image_detect', image: 'button.png' };
  const actions = normalize([
    { type: 'condition', test: image, then: [{ type: 'repeat', count: 3, actions: [{ type: 'key', keys: 'ctrl+a' }, { type: 'text', text: '한글 test' }] }], else: [{ type: 'retry', action: { ...image, type: 'image_click' } }] },
    { type: 'wait', duration_ms: 123 }, { type: 'click', x: 42, y: 50, coordinate_space: 'client' }, { type: 'mouse_move', x: 1, y: 2, coordinate_space: 'overlay' },
    { type: 'scroll', delta_x: -4, delta_y: 5 }, { ...image, type: 'image_wait' }, { type: 'stop' },
  ]);
  const workspace = new Blockly.Workspace();
  try { Blocks.load(Blockly, workspace, actions); assert.deepEqual(normalize(Blocks.compile(workspace).actions), actions); }
  finally { workspace.dispose(); }
});
test('drag connections can move an action into false branch without losing its fields', () => {
  const workspace = new Blockly.Workspace();
  try {
    Blocks.load(Blockly, workspace, normalize([{ type: 'condition', test: { type: 'image_detect', image: 'button.png' }, then: [{ type: 'key', keys: 'alt+enter' }], else: [] }]));
    const condition = workspace.getAllBlocks(false).find(b => b.type === 'am_condition');
    const key = condition.getInputTargetBlock('THEN'); key.unplug();
    assert.throws(() => Blocks.compile(workspace), /연결/);
    condition.getInput('ELSE').connection.connect(key.previousConnection);
    const { actions, paths } = Blocks.compile(workspace);
    assert.equal(actions[0].then.length, 0); assert.equal(actions[0].else[0].keys, 'alt+enter');
    assert.equal(paths.get('0.else.0'), key.id);
  } finally { workspace.dispose(); }
});
test('smart click roundtrips with its verify interval and expected image', () => {
  const actions = normalize([{ type: 'smart_click', image: 'button.png', verify_interval_ms: 500, expect_image: 'next.png' }]);
  assert.equal(actions[0].verify_interval_ms, 500);
  Blocks.register(Blockly, () => [{ name: '버튼', path: 'button.png' }, { name: '다음', path: 'next.png' }]);
  const workspace = new Blockly.Workspace();
  try {
    Blocks.load(Blockly, workspace, actions);
    const roundtripped = normalize(Blocks.compile(workspace).actions);
    assert.deepEqual(roundtripped, actions);
    const plain = workspace.getAllBlocks(false).find((b) => b.type === 'am_smart_click');
    plain.setFieldValue('', 'expect_image');
    assert.equal(normalize(Blocks.compile(workspace).actions)[0].expect_image, undefined);
  } finally { workspace.dispose(); }
});
test('missing and multiple test blocks reject rather than silently omit actions', () => {
  const workspace = new Blockly.Workspace();
  try {
    Blocks.load(Blockly, workspace, normalize([{ type: 'condition', test: { type: 'image_detect', image: 'button.png' }, then: [], else: [] }]));
    const condition = workspace.getAllBlocks(false).find(b => b.type === 'am_condition');
    condition.getInputTargetBlock('TEST').dispose();
    assert.throws(() => Blocks.compile(workspace), /검사 칸/);
  } finally { workspace.dispose(); }
});
