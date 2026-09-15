import { keys } from './macros.js';

const codes: Record<string, number> = { backspace: 8, tab: 9, enter: 13, shift: 0xa0, ctrl: 0xa2, alt: 0xa4, esc: 27, space: 32, page_up: 33, page_down: 34, end: 35, home: 36, left: 37, up: 38, right: 39, down: 40, delete: 46, win: 0x5b };
const extended = new Set(['page_up', 'page_down', 'end', 'home', 'left', 'up', 'right', 'down', 'delete', 'win']);

export interface KeyEvent {
  key?: number;
  scan?: number;
  flags?: number;
}

export function keyEvent(name: string, up = false): KeyEvent {
  const key = codes[name] ?? (/^f\d+$/.test(name) ? 111 + Number(name.slice(1)) : name.toUpperCase().charCodeAt(0));
  return { key, flags: (extended.has(name) ? 1 : 0) | (up ? 2 : 0) };
}

interface NativeKeyboard {
  sendKeyboard(events: KeyEvent[]): number;
  isForeground(handle: unknown): boolean;
  postMessage?(handle: unknown, msg: number, wParam: number, lParam: number): void;
}

// 백그라운드 전달용 Windows 메시지.
const WM_KEYDOWN = 0x100;
const WM_KEYUP = 0x101;
const WM_CHAR = 0x102;
const WM_SYSKEYDOWN = 0x104;
const WM_SYSKEYUP = 0x105;

interface KeyControl {
  checkpoint(): Promise<void>;
  tick(ms: number): Promise<void>;
}

export class KeyboardSender {
  native: NativeKeyboard;
  held = new Map<string, KeyEvent>();
  backgroundHeld: number[] = [];

  constructor(native: NativeKeyboard = require('./native-windows.js') as NativeKeyboard) {
    this.native = native;
    this.held = new Map();
    this.backgroundHeld = [];
  }

  send(events: KeyEvent[]): void {
    const sent = this.native.sendKeyboard(events);
    for (const event of events.slice(0, sent)) {
      const id = `${event.key || 0}:${event.scan || 0}`;
      if ((event.flags as number) & 2) this.held.delete(id);
      else this.held.set(id, event);
    }
    if (sent !== events.length) throw new Error('Windows 키보드 입력이 거부되었습니다. 대상 앱과 실행 권한을 확인하세요.');
  }

  assertTarget(handle: unknown): void {
    if (!this.native.isForeground(handle)) throw new Error('대상 창이 전경에서 벗어나 키보드 입력을 중단했습니다.');
  }

  async press(combination: string, handle: unknown, control: KeyControl, background = false): Promise<void> {
    const parts = keys(combination).split('+');
    await control.checkpoint();
    if (background) {
      if (!this.native.postMessage) throw new Error('백그라운드 키보드 입력을 지원하지 않는 환경입니다.');
      const post = this.native.postMessage.bind(this.native);
      const sys = parts.includes('alt');
      const down = sys ? WM_SYSKEYDOWN : WM_KEYDOWN;
      const up = sys ? WM_SYSKEYUP : WM_KEYUP;
      try {
        for (const name of parts) {
          const event = keyEvent(name);
          post(handle, down, event.key as number, ((event.flags as number) & 1 ? 1 << 24 : 0));
          this.backgroundHeld.push(event.key as number);
        }
        for (const name of [...parts].reverse()) {
          const event = keyEvent(name);
          post(handle, up, event.key as number, (1 << 30) | (1 << 31) | ((event.flags as number) & 1 ? 1 << 24 : 0));
          this.backgroundHeld = this.backgroundHeld.filter((key) => key !== event.key);
        }
      } finally { this.releaseBackground(handle); }
      await control.checkpoint();
      return;
    }
    this.assertTarget(handle);
    try { this.send([...parts.map(name => keyEvent(name)), ...[...parts].reverse().map(name => keyEvent(name, true))]); }
    finally { this.releaseAll(); }
    await control.checkpoint();
  }

  async type(text: string, handle: unknown, control: KeyControl, background = false): Promise<void> {
    if (background) {
      if (!this.native.postMessage) throw new Error('백그라운드 키보드 입력을 지원하지 않는 환경입니다.');
      const post = this.native.postMessage.bind(this.native);
      for (const character of text) {
        await control.checkpoint();
        for (let index = 0; index < character.length; index++) post(handle, WM_CHAR, character.charCodeAt(index), 1);
        await control.tick(0);
      }
      await control.checkpoint();
      return;
    }
    for (const character of text) {
      await control.checkpoint();
      this.assertTarget(handle);
      const events: KeyEvent[] = [];
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

  releaseAll(): void {
    if (!this.held.size) return;
    this.send([...this.held.values()].reverse().map(event => ({ ...event, flags: (event.flags as number) | 2 })));
  }

  releaseBackground(handle: unknown): void {
    if (!this.backgroundHeld.length) return;
    if (!this.native.postMessage) { this.backgroundHeld = []; return; }
    const post = this.native.postMessage.bind(this.native);
    for (const key of [...this.backgroundHeld].reverse()) {
      try { post(handle, WM_KEYUP, key, (1 << 30) | (1 << 31)); } catch { /* 해제는 best-effort */ }
    }
    this.backgroundHeld = [];
  }
}
