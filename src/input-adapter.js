const { keyboard, mouse, Key, Button } = require('@nut-tree-fork/nut-js');
const { prepareWindow, screenPoint } = require('./windows');

const specialKeys = { backspace: Key.Backspace, delete: Key.Delete, down: Key.ArrowDown, end: Key.End, enter: Key.Enter, esc: Key.Escape, home: Key.Home, left: Key.ArrowLeft, page_down: Key.PageDown, page_up: Key.PageUp, right: Key.ArrowRight, space: Key.Space, tab: Key.Tab, up: Key.ArrowUp, alt: Key.LeftAlt, ctrl: Key.LeftControl, shift: Key.LeftShift, win: Key.LeftWin };
const buttons = { left: Button.LEFT, right: Button.RIGHT, middle: Button.MIDDLE };

async function press(keys) {
  const values = keys.toLowerCase().split('+').map((key) => specialKeys[key] || key);
  if (values.length === 1 && typeof values[0] === 'string') { await keyboard.type(values[0]); return; }
  try {
    for (const key of values) await keyboard.pressKey(key);
    for (const key of [...values].reverse()) await keyboard.releaseKey(key);
  } catch (error) {
    for (const key of [...values].reverse()) await keyboard.releaseKey(key).catch(() => {});
    throw error;
  }
}

function createInputAdapter({ windowAdapter = { prepareWindow, screenPoint } } = {}) {
  return {
    async execute(action, target, control) {
      await control.checkpoint();
      const prepared = await windowAdapter.prepareWindow(target, control);
      if (action.type === 'key') { await press(action.keys); return; }
      if (action.type === 'text') { await keyboard.type(action.text); return; }
      if (action.type === 'scroll') {
        if (action.delta_y < 0) await mouse.scrollDown(Math.abs(action.delta_y));
        if (action.delta_y > 0) await mouse.scrollUp(action.delta_y);
        if (action.delta_x < 0) await mouse.scrollLeft(Math.abs(action.delta_x));
        if (action.delta_x > 0) await mouse.scrollRight(action.delta_x);
        return;
      }
      if (action.type === 'mouse_move' || action.type === 'click') {
        const point = windowAdapter.screenPoint(prepared.region, action.x, action.y);
        await mouse.setPosition(point);
        if (action.type === 'click') await mouse.click(buttons[action.button || 'left']);
        return;
      }
      throw new Error(`입력 adapter가 지원하지 않는 액션: ${action.type}`);
    },
    async releaseAll() {},
  };
}

module.exports = { createInputAdapter };