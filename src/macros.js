const { randomUUID } = require('node:crypto');
const { parseScript } = require('./uo-script/parser');
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
function number(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${name}: ${min}~${max} 범위의 숫자가 필요합니다.`);
  return value;
}
function region(value, name = 'region') {
  const source = value ?? {};
  return {
    x: integer(source.x ?? 0, `${name}.x`, 0, 100000),
    y: integer(source.y ?? 0, `${name}.y`, 0, 100000),
    width: integer(source.width ?? 1920, `${name}.width`, 1, 100000),
    height: integer(source.height ?? 1080, `${name}.height`, 1, 100000),
  };
}
function imageAction(item, base) {
  return { ...base, image: string(item.image, 'image', 2048), monitor: integer(item.monitor ?? 1, 'monitor', 1, 16), threshold: number(item.threshold ?? 0.9, 'threshold', 0, 1), zone: integer(item.zone ?? 0, 'zone', 0, 9), region: region(item.region), poll_interval_ms: integer(item.poll_interval_ms ?? 100, 'poll_interval_ms', 30, 60000) };
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
      case 'image_detect': case 'image_wait': case 'image_click': return imageAction(item, base);
      case 'smart_click': {
        const result = imageAction(item, base);
        result.verify_interval_ms = integer(item.verify_interval_ms ?? 800, 'verify_interval_ms', 100, 10000);
        if (item.expect_image !== undefined && item.expect_image !== '') result.expect_image = string(item.expect_image, 'expect_image', 2048);
        return result;
      }
      case 'scroll': return { ...base, delta_x: integer(item.delta_x ?? 0, 'delta_x', -100000, 100000), delta_y: integer(item.delta_y ?? 0, 'delta_y', -100000, 100000) };
      case 'retry': {
        const nested = actions([item.action], depth + 1, budget)[0];
        if (!['image_detect', 'image_wait', 'image_click', 'smart_click'].includes(nested.type)) fail('retry는 이미지 액션 하나만 감쌀 수 있습니다.');
        return { ...base, count: integer(item.count ?? 0, 'retry.count', 0, 10), interval_ms: integer(item.interval_ms ?? 200, 'retry.interval_ms', 0, 60000), action: nested };
      }
      case 'condition': {
        const test = actions([item.test], depth + 1, budget)[0];
        if (test.type !== 'image_detect') fail('condition의 test는 image_detect여야 합니다.');
        return { ...base, test, then: actions(item.then ?? [], depth + 1, budget), else: actions(item.else ?? [], depth + 1, budget) };
      }
      case 'mouse_move': case 'click': {
        const result = { ...base, x: integer(item.x, 'x', 0, 100000), y: integer(item.y, 'y', 0, 100000) };
        if (item.coordinate_space !== undefined) {
          if (!['client', 'overlay'].includes(item.coordinate_space)) fail('좌표 기준이 잘못되었습니다.');
          result.coordinate_space = item.coordinate_space;
        }
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
    const script = string(item.script ?? '', 'script', 50000);
    if (script) {
      try { parseScript(script); } catch (error) { fail(`script: ${error.message}`); }
    }
    if (Array.isArray(item.images) && item.images.length > 200) fail('이미지 자산은 최대 200개입니다.');
    const images = Array.isArray(item.images) ? item.images.map((image) => {
      if (!image || typeof image !== 'object') fail('이미지 자산이 잘못되었습니다.');
      return { id: string(image.id, 'image.id', 64), name: string(image.name, 'image.name', 200).trim(), path: string(image.path, 'image.path', 4096), preview: string(image.preview ?? '', 'image.preview', 2000000), region: region(image.region, 'image.region') };
    }) : [];
    const overlay = item.overlay == null ? null : region(item.overlay, 'overlay');
    const loop = { count: integer(item.loop?.count ?? 1, 'loop.count', 1, 10000), interval_ms: integer(item.loop?.interval_ms ?? 500, 'loop.interval_ms', 30, 60000) };
    const binding = item.binding == null ? null : {
      needs_overlay: item.binding.needs_overlay === true,
      needs_review: item.binding.needs_review === true,
      source_overlay: item.binding.source_overlay == null ? null : region(item.binding.source_overlay, 'binding.source_overlay'),
    };
    return { id, name, description: string(item.description ?? '', 'description', 2000), script, enabled: item.enabled, hotkey, target_window, overlay, loop, images, actions: actions(item.actions), binding };
  }), global: { pause_hotkey: 'f8', stop_hotkey: 'f9', default_timeout_ms: 10000 } };
}
function newMacro() {
  return { id: randomUUID(), name: '새 매크로', description: '', script: '', enabled: false, hotkey: '', target_window: {}, images: [], actions: [{ type: 'wait', duration_ms: 1000 }] };
}
module.exports = { MacroError, validateDocument, newMacro, keys };
