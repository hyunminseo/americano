const { keyboard, Key } = require('@nut-tree-fork/nut-js');

keyboard.config.autoDelayMs = 0;
const specialKeys = { backspace: Key.Backspace, delete: Key.Delete, down: Key.ArrowDown, end: Key.End, enter: Key.Enter, esc: Key.Escape, home: Key.Home, left: Key.ArrowLeft, page_down: Key.PageDown, page_up: Key.PageUp, right: Key.ArrowRight, space: Key.Space, tab: Key.Tab, up: Key.ArrowUp, alt: Key.LeftAlt, ctrl: Key.LeftControl, shift: Key.LeftShift, win: Key.LeftWin };

async function press(key) {
  const parts = key.toLowerCase().split('+');
  if (parts.length === 1 && !specialKeys[parts[0]]) { await keyboard.type(parts[0]); return; }
  const resolved = parts.map((part) => specialKeys[part] || part);
  try {
    for (const value of resolved) await keyboard.pressKey(value);
    for (const value of [...resolved].reverse()) await keyboard.releaseKey(value);
  } catch (error) {
    for (const value of [...resolved].reverse()) await keyboard.releaseKey(value).catch(() => {});
    throw error;
  }
}

async function executeActions(actions, shouldStop) {
  for (const action of actions) {
    if (shouldStop()) return false;
    await press(action.key);
    if (action.delayMs) await new Promise((resolve) => setTimeout(resolve, action.delayMs));
  }
  return true;
}

module.exports = { executeActions };
