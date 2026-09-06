const { keys } = require('./macros');
const codes = { backspace: 8, tab: 9, enter: 13, shift: 0xa0, ctrl: 0xa2, alt: 0xa4, esc: 27, space: 32, page_up: 33, page_down: 34, end: 35, home: 36, left: 37, up: 38, right: 39, down: 40, delete: 46, win: 0x5b };
const extended = new Set(['page_up', 'page_down', 'end', 'home', 'left', 'up', 'right', 'down', 'delete', 'win']);
function keyEvent(name, up = false) {
  const key = codes[name] ?? (/^f\d+$/.test(name) ? 111 + Number(name.slice(1)) : name.toUpperCase().charCodeAt(0));
  return { key, flags: (extended.has(name) ? 1 : 0) | (up ? 2 : 0) };
}
class KeyboardSender {
  constructor(native = require('./native-windows')) { this.native = native; this.held = new Map(); }
  send(events) {
    const sent = this.native.sendKeyboard(events);
    for (const event of events.slice(0, sent)) {
      const id = `${event.key || 0}:${event.scan || 0}`;
      if (event.flags & 2) this.held.delete(id); else this.held.set(id, event);
    }
    if (sent !== events.length) throw new Error('Windows 키보드 입력이 거부되었습니다. 대상 앱과 실행 권한을 확인하세요.');
  }
  assertTarget(handle) {
    if (!this.native.isForeground(handle)) throw new Error('대상 창이 전경에서 벗어나 키보드 입력을 중단했습니다.');
  }
  async press(combination, handle, control) {
    const parts = keys(combination).split('+');
    await control.checkpoint(); this.assertTarget(handle);
    try { this.send([...parts.map(name => keyEvent(name)), ...[...parts].reverse().map(name => keyEvent(name, true))]); }
    finally { this.releaseAll(); }
    await control.checkpoint();
  }
  async type(text, handle, control) {
    for (const character of text) {
      await control.checkpoint(); this.assertTarget(handle);
      const events = [];
      // UTF-16 pairs are sent together so emoji cannot be split by a pause.
      for (let index = 0; index < character.length; index++) {
        const scan = character.charCodeAt(index);
        events.push({ scan, flags: 4 }, { scan, flags: 6 });
      }
      try { this.send(events); } finally { this.releaseAll(); }
      await control.tick(0);
    }
    await control.checkpoint();
  }
  releaseAll() {
    if (!this.held.size) return;
    this.send([...this.held.values()].reverse().map(event => ({ ...event, flags: event.flags | 2 })));
  }
}
module.exports = { KeyboardSender, keyEvent };
