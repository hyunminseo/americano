import { keyboard } from '@nut-tree-fork/nut-js';

// Key enum은 타입 패키지에 노출되지 않아 런타임 require로 받는다(레거시 경로).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Key }: { Key: Record<string, any> } = require('@nut-tree-fork/nut-js');

keyboard.config.autoDelayMs = 0;
const specialKeys: Record<string, any> = { backspace: Key.Backspace, delete: Key.Delete, down: Key.ArrowDown, end: Key.End, enter: Key.Enter, esc: Key.Escape, home: Key.Home, left: Key.ArrowLeft, page_down: Key.PageDown, page_up: Key.PageUp, right: Key.ArrowRight, space: Key.Space, tab: Key.Tab, up: Key.ArrowUp, alt: Key.LeftAlt, ctrl: Key.LeftControl, shift: Key.LeftShift, win: Key.LeftWin };

async function press(key: string): Promise<void> {
  const parts = key.toLowerCase().split('+');
  if (parts.length === 1 && !specialKeys[parts[0]]) { await keyboard.type(parts[0]); return; }
  const resolved = parts.map((part) => (specialKeys[part] || part) as Parameters<typeof keyboard.pressKey>[0]);
  try {
    for (const value of resolved) await keyboard.pressKey(value);
    for (const value of [...resolved].reverse()) await keyboard.releaseKey(value);
  } catch (error) {
    for (const value of [...resolved].reverse()) await keyboard.releaseKey(value).catch(() => {});
    throw error;
  }
}

export async function executeActions(actions: { key: string; delayMs?: number }[], shouldStop: () => boolean): Promise<boolean> {
  for (const action of actions) {
    if (shouldStop()) return false;
    await press(action.key);
    if (action.delayMs) await new Promise((resolve) => setTimeout(resolve, action.delayMs));
  }
  return true;
}
