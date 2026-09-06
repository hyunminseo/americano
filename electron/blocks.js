(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MacroBlocks = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const definitions = {
    wait: ['기다리기', 45, { duration_ms: ['시간 ms', 1000, 0, 3600000] }],
    key: ['키 누르기', 210, { keys: ['키 조합', 'enter'] }],
    text: ['문자 입력', 210, { text: ['내용', ''] }],
    click: ['클릭', 210, { coordinate_space: ['기준', [['오버레이', 'overlay'], ['창 영역', 'client']]], x: ['X', 0, 0, 100000], y: ['Y', 0, 0, 100000], button: ['버튼', [['왼쪽', 'left'], ['오른쪽', 'right'], ['가운데', 'middle']]] }],
    mouse_move: ['마우스 이동', 210, { coordinate_space: ['기준', [['오버레이', 'overlay'], ['창 영역', 'client']]], x: ['X', 0, 0, 100000], y: ['Y', 0, 0, 100000] }],
    scroll: ['스크롤', 210, { delta_x: ['가로', 0, -100000, 100000], delta_y: ['세로', -500, -100000, 100000] }],
    image_detect: ['이미지 검사', 150, {}], image_wait: ['이미지 발견까지 기다리기', 150, {}], image_click: ['발견한 이미지 클릭', 150, {}],
    condition: ['이미지가 발견되면', 285, {}],
    repeat: ['반복', 45, { count: ['횟수', 2, 1, 10000] }],
    retry: ['이미지 재시도', 45, { count: ['추가 횟수', 2, 0, 10], interval_ms: ['간격 ms', 200, 0, 60000] }],
    stop: ['매크로 중지', 0, {}],
  };
  const imageFields = { image: ['기준 이미지', ''], threshold: ['일치율', 0.9, 0, 1, 0.01], poll_interval_ms: ['검사 간격 ms', 100, 30, 60000], monitor: ['모니터', 1, 1, 16], 'region.x': ['영역 X', 0, 0, 100000], 'region.y': ['영역 Y', 0, 0, 100000], 'region.width': ['너비', 1920, 1, 100000], 'region.height': ['높이', 1080, 1, 100000] };
  function specs(type) { return { ...definitions[type][2], ...(type.startsWith('image_') ? imageFields : {}), timeout_ms: ['제한 시간 ms', 10000, 1, 3600000] }; }
  function register(Blockly, getImages = () => [], getOverlay = () => null) {
    Blockly.Blocks.am_start = { init() { this.appendDummyInput().appendField('▶ 실행 버튼을 눌렀을 때'); this.appendStatementInput('BODY'); this.setColour(45); this.setDeletable(false); this.setMovable(false); } };
    for (const [type, [label, color]] of Object.entries(definitions)) {
      Blockly.Blocks[`am_${type}`] = { init() {
        this.appendDummyInput('TITLE').appendField(label);
        for (const [key, [name, value, min, max, precision]] of Object.entries(specs(type))) {
          let field;
          if (key === 'image') {
            field = new Blockly.FieldDropdown(() => {
              const choices = getImages().map(asset => [asset.name, asset.path]);
              const existing = this.getFieldValue('image');
              if (existing && !choices.some(([, path]) => path === existing)) choices.push(['기존 이미지', existing]);
              return [['이미지 선택', ''], ...choices];
            });
          } else if (Array.isArray(value)) field = new Blockly.FieldDropdown(value);
          else if (typeof value === 'number') field = new Blockly.FieldNumber(value, min, max, precision || 1);
          else field = new Blockly.FieldTextInput(value);
          this.appendDummyInput(key).appendField(name).appendField(field, key);
        }
        if (type === 'condition') { this.appendStatementInput('TEST').setCheck('image_detect').appendField('검사'); this.appendStatementInput('THEN').appendField('참'); this.appendStatementInput('ELSE').appendField('거짓'); }
        if (type === 'repeat') this.appendStatementInput('BODY').appendField('실행');
        if (type === 'retry') this.appendStatementInput('ACTION').setCheck(['image_detect', 'image_wait', 'image_click']).appendField('이미지 동작 하나');
        this.setPreviousStatement(true, type); this.setNextStatement(true); this.setColour(color);
        this.setTooltip(`${label}: 블록을 연결하여 실행 순서를 구성하세요.`);
        if (type.startsWith('image_') && getOverlay()) {
          for (const key of ['monitor', 'region.x', 'region.y', 'region.width', 'region.height']) this.getInput(key).setVisible(false);
        }
      } };
    }
  }
  function actionState(action) {
    const fields = {};
    for (const [key, [, fallback]] of Object.entries(specs(action.type))) {
      const value = key.startsWith('region.') ? action.region?.[key.slice(7)] : action[key];
      fields[key] = value ?? (key === 'coordinate_space' ? 'client' : Array.isArray(fallback) ? fallback[0][1] : fallback);
    }
    const inputs = {};
    if (action.type === 'repeat' && action.actions.length) inputs.BODY = { block: chainState(action.actions) };
    if (action.type === 'retry') inputs.ACTION = { block: actionState(action.action) };
    if (action.type === 'condition') {
      inputs.TEST = { block: actionState(action.test) };
      if (action.then.length) inputs.THEN = { block: chainState(action.then) };
      if (action.else.length) inputs.ELSE = { block: chainState(action.else) };
    }
    return { type: `am_${action.type}`, fields, inputs };
  }
  function chainState(actions) {
    let next;
    for (const action of [...actions].reverse()) { const state = actionState(action); if (next) state.next = { block: next }; next = state; }
    return next;
  }
  function load(Blockly, workspace, actions) {
    Blockly.serialization.workspaces.load({ blocks: { languageVersion: 0, blocks: [{ type: 'am_start', x: 24, y: 24, inputs: actions.length ? { BODY: { block: chainState(actions) } } : {} }] } }, workspace);
  }
  function compile(workspace) {
    const tops = workspace.getTopBlocks(false);
    if (tops.length !== 1 || tops[0].type !== 'am_start') throw new Error('모든 블록을 시작 블록에 연결하거나 사용하지 않는 블록을 삭제하세요.');
    const paths = new Map(); let count = 0;
    function chain(first, prefix = [], depth = 0) {
      if (depth > 8) throw new Error('블록 중첩은 최대 8단계입니다.');
      const actions = [];
      for (let block = first; block; block = block.getNextBlock()) {
        if (++count > 1000) throw new Error('블록은 최대 1,000개입니다.');
        if (!block.isEnabled()) throw new Error('비활성 블록을 삭제하거나 활성화하세요.');
        const type = block.type.slice(3);
        if (!definitions[type]) throw new Error('지원하지 않는 블록입니다.');
        const path = [...prefix, actions.length]; paths.set(path.join('.'), block.id);
        const action = { type };
        for (const [key, [, fallback]] of Object.entries(specs(type))) {
          const raw = block.getFieldValue(key); const value = typeof fallback === 'number' ? Number(raw) : raw;
          if (key.startsWith('region.')) { action.region ||= {}; action.region[key.slice(7)] = value; } else action[key] = value;
        }
        if (type === 'repeat') action.actions = chain(block.getInputTargetBlock('BODY'), path, depth + 1);
        if (type === 'retry') {
          const children = chain(block.getInputTargetBlock('ACTION'), path, depth + 1);
          if (children.length !== 1 || !children[0].type.startsWith('image_')) throw new Error('재시도 안에는 이미지 동작 하나를 연결하세요.');
          action.action = children[0];
        }
        if (type === 'condition') {
          const tests = chain(block.getInputTargetBlock('TEST'), [...path, 'test'], depth + 1);
          if (tests.length !== 1 || tests[0].type !== 'image_detect') throw new Error('조건의 검사 칸에 이미지 검사 블록 하나를 연결하세요.');
          action.test = tests[0];
          action.then = chain(block.getInputTargetBlock('THEN'), [...path, 'then'], depth + 1);
          action.else = chain(block.getInputTargetBlock('ELSE'), [...path, 'else'], depth + 1);
        }
        actions.push(action);
      }
      return actions;
    }
    return { actions: chain(tops[0].getInputTargetBlock('BODY')), paths };
  }
  function toolbox() {
    return { kind: 'categoryToolbox', contents: [
      ['입력', 210, ['key', 'text', 'click', 'mouse_move', 'scroll']],
      ['이미지 탐지', 150, ['image_detect', 'image_wait', 'image_click']],
      ['조건과 반복', 45, ['condition', 'repeat', 'retry', 'wait', 'stop']],
    ].map(([name, colour, types]) => ({ kind: 'category', name, colour, contents: types.map(type => ({ kind: 'block', type: `am_${type}` })) })) };
  }
  return { register, load, compile, toolbox, definitions };
});
