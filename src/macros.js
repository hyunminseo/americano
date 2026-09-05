const { randomUUID } = require('node:crypto');
class MacroError extends Error {}
const fail = (message) => { throw new MacroError(message); };
function string(value, name, max = 256) {
  if (typeof value !== 'string' || value.length > max) fail(`${name}: 문자열 길이는 ${max}자 이하여야 합니다.`);
  return value;
}
function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${name}: ${min}~${max} 정수가 필요합니다.`);
  return value;
}
const modifiers = ['ctrl', 'alt', 'shift', 'win'];
const aliases = { control: 'ctrl', commandorcontrol: 'ctrl', super: 'win', meta: 'win', escape: 'esc' };
function keys(value) {
  const parts = string(value, 'keys', 100).toLowerCase().split('+').map((part) => {
    const name = part.trim(); return aliases[name] || name;
  });
  if (new Set(parts).size !== parts.length) fail('중복 키입니다.');
  const main = parts.filter((part) => !modifiers.includes(part));
  if (main.length !== 1 || !/^(?:[a-z0-9]|f(?:[1-9]|1[0-9]|2[0-4])|enter|esc|space|tab|backspace|delete|up|down|left|right|home|end|page_up|page_down)$/.test(main[0])) fail('지원하지 않는 키 조합입니다.');
  return [...modifiers.filter((part) => parts.includes(part)), main[0]].join('+');
}
function actions(items, depth = 0, budget = { count: 0 }) {
  if (!Array.isArray(items) || depth > 8) fail('액션 배열 또는 중첩 깊이가 잘못되었습니다.');
  return items.map((item) => {
    if (!item || typeof item !== 'object' || ++budget.count > 1000) fail('액션은 최대 1,000개입니다.');
    const type = item.type;
    const base = { type, timeout_ms: integer(item.timeout_ms ?? 10000, 'timeout_ms', 1, 3600000) };
    switch (type) {
      case 'wait': return { ...base, duration_ms: integer(item.duration_ms, 'duration_ms', 0, 3600000) };
      case 'key': return { ...base, keys: keys(item.keys) };
      case 'text': return { ...base, text: string(item.text, 'text', 10000) };
      case 'mouse_move': case 'click': {
        const result = { ...base, x: integer(item.x, 'x', 0, 100000), y: integer(item.y, 'y', 0, 100000) };
        if (type === 'click') {
          if (!['left', 'right', 'middle'].includes(item.button ?? 'left')) fail('지원하지 않는 마우스 버튼입니다.');
          result.button = item.button ?? 'left';
        }
        return result;
      }
      case 'repeat': return { ...base, count: integer(item.count, 'count', 1, 10000), actions: actions(item.actions, depth + 1, budget) };
      case 'stop': return base;
      default: fail(`아직 지원하지 않는 액션: ${type}`);
    }
  });
}
function validateDocument(raw) {
  if (!raw || raw.version !== 2 || !Array.isArray(raw.macros) || raw.macros.length > 100) fail('version 2 문서와 최대 100개의 매크로가 필요합니다.');
  const ids = new Set(); const hotkeys = new Set();
  return { version: 2, macros: raw.macros.map((item) => {
    if (!item || typeof item !== 'object') fail('잘못된 매크로입니다.');
    const id = string(item.id, 'id', 64);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) fail('매크로 ID가 잘못되었거나 중복됩니다.');
    ids.add(id);
    const name = string(item.name, 'name', 100).trim();
    if (!name) fail('매크로 이름이 필요합니다.');
    if (typeof item.enabled !== 'boolean') fail('enabled는 boolean이어야 합니다.');
    const hotkey = item.hotkey ? keys(item.hotkey) : '';
    if (['f8', 'f9'].includes(hotkey)) fail('F8/F9는 예약 단축키입니다.');
    if (hotkey && item.enabled) {
      if (hotkeys.has(hotkey)) fail('활성 매크로의 단축키가 중복됩니다.');
      hotkeys.add(hotkey);
    }
    const target = item.target_window ?? {};
    if (!target || typeof target !== 'object' || Array.isArray(target)) fail('대상 창 조건이 잘못되었습니다.');
    const target_window = {};
    for (const field of ['process_name', 'executable_path', 'title_contains']) {
      if (target[field] !== undefined) target_window[field] = string(target[field], field, 1024).trim();
    }
    return { id, name, description: string(item.description ?? '', 'description', 2000), enabled: item.enabled, hotkey, target_window, actions: actions(item.actions) };
  }), global: { pause_hotkey: 'f8', stop_hotkey: 'f9', default_timeout_ms: 10000 } };
}
function newMacro() {
  return { id: randomUUID(), name: '새 매크로', description: '', enabled: false, hotkey: '', target_window: {}, actions: [{ type: 'wait', duration_ms: 1000 }] };
}
module.exports = { MacroError, validateDocument, newMacro, keys };
