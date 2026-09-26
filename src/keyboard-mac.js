const { keyboard, Key } = require('@nut-tree-fork/nut-js');
const { keys } = require('./macros');
const native = require('./native-mac');
const names = { ctrl: 'LeftControl', alt: 'LeftAlt', shift: 'LeftShift', win: 'LeftSuper', esc: 'Escape', enter: 'Return', space: 'Space', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', page_up: 'PageUp', page_down: 'PageDown', up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End' };
class MacKeyboard {
  constructor() { this.held = []; }
  async assertTarget(handle, control) {
    await control.checkpoint();
    if (!(await native.isForeground(handle))) throw new Error('대상 창이 전경에서 벗어나 입력을 중단했습니다.');
  }
  async press(combination, handle, control) {
    await this.assertTarget(handle, control);
    const codes = keys(combination).split('+').map(k => Key[names[k] || (/^[0-9]$/.test(k) ? `Num${k}` : k.toUpperCase())]);
    if (codes.some(k => k === undefined)) throw new Error('macOS에서 지원하지 않는 키입니다.');
    this.held = codes;
    try { await keyboard.pressKey(...codes); } finally { await this.releaseAll(); }
  }
  async type(text, handle, control) {
    for (const c of text) { await this.assertTarget(handle, control); await keyboard.type(c); }
  }
  async releaseAll() { if (this.held.length) { await keyboard.releaseKey(...this.held.slice().reverse()); this.held = []; } }
}
module.exports = { MacKeyboard };
