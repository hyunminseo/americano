import { mouse } from '@nut-tree-fork/nut-js';
import { prepareWindow, prepareWindowBackground, screenPoint, clientPoint, ClientRect, WindowInfo, TargetWindow } from './windows.js';
import { KeyboardSender } from './keyboard.js';
import type { MacroAction } from './macros.js';

interface RunControlLike {
  checkpoint(): Promise<void>;
  time(): number;
  wait(ms: number): Promise<void>;
  tick(ms: number): Promise<void>;
  onClickPoint?: ((point: { x: number; y: number }) => void) | null;
}

interface WindowAdapter {
  prepareWindow(target: TargetWindow, control: RunControlLike): Promise<{ window: WindowInfo; region: ClientRect; dpi: number }>;
  prepareBackground?(target: TargetWindow, control: RunControlLike): Promise<{ window: WindowInfo; region: ClientRect; dpi: number }>;
  screenPoint(region: ClientRect, x: number, y: number): { x: number; y: number };
  clientPoint?(region: ClientRect, x: number, y: number): { x: number; y: number };
}

interface NativeAdapter {
  isPointInWindow(handle: unknown, x: number, y: number): boolean;
  moveCursor(point: { x: number; y: number }): Promise<void>;
  isForeground(handle: unknown): boolean;
  clickMouse(button?: string): void;
  postMessage?(handle: unknown, msg: number, wParam: number, lParam: number): void;
}

// 백그라운드 전달용 마우스 메시지.
const WM_MOUSEMOVE = 0x200;
const WM_LBUTTONDOWN = 0x201;
const WM_LBUTTONUP = 0x202;
const WM_RBUTTONDOWN = 0x204;
const WM_RBUTTONUP = 0x205;
const WM_MBUTTONDOWN = 0x207;
const WM_MBUTTONUP = 0x208;
const WM_MOUSEWHEEL = 0x20a;
const WM_MOUSEHWHEEL = 0x20e;
const mouseButtons: Record<string, { down: number; up: number; flag: number }> = {
  left: { down: WM_LBUTTONDOWN, up: WM_LBUTTONUP, flag: 1 },
  right: { down: WM_RBUTTONDOWN, up: WM_RBUTTONUP, flag: 2 },
  middle: { down: WM_MBUTTONDOWN, up: WM_MBUTTONUP, flag: 16 },
};

export type { WindowAdapter, NativeAdapter };

export function createInputAdapter({ windowAdapter = { prepareWindow, prepareBackground: prepareWindowBackground, screenPoint, clientPoint }, keyboard = new KeyboardSender(), nativeAdapter = require('./native-windows.js') as NativeAdapter } = {} as {
  windowAdapter?: WindowAdapter;
  keyboard?: KeyboardSender;
  nativeAdapter?: NativeAdapter;
}): {
  execute(action: MacroAction, target: TargetWindow, control: RunControlLike, mode?: string): Promise<void>;
  releaseAll(): Promise<void>;
} {
  // 백그라운드 입력: 커서를 움직이지 않고 창 메시지 큐에 직접 전달한다.
  // 사용자는 실행 중에도 키보드·마우스를 그대로 쓸 수 있다.
  const executeBackground = async (action: MacroAction, target: TargetWindow, control: RunControlLike): Promise<void> => {
    const prepare = windowAdapter.prepareBackground ?? prepareWindowBackground;
    const toClient = windowAdapter.clientPoint ?? clientPoint;
    const post = nativeAdapter.postMessage;
    if (!post) throw new Error('백그라운드 입력을 지원하지 않는 환경입니다.');
    const send = post.bind(nativeAdapter);
    const prepared = await prepare(target, control);
    await control.checkpoint();
    const handle = prepared.window.handle;
    if (action.type === 'key') { await keyboard.press(action.keys as string, handle, control, true); return; }
    if (action.type === 'text') { await keyboard.type(action.text as string, handle, control, true); return; }
    if (action.type === 'scroll') {
      const point = toClient(prepared.region, 0, 0);
      const param = (point.y << 16) | (point.x & 0xffff);
      const notch = (delta: number): number => Math.max(1, Math.round(Math.abs(delta) / 50)) * 120 * Math.sign(delta);
      if (action.delta_y) send(handle, WM_MOUSEWHEEL, (notch(action.delta_y as number) << 16) & 0xffffffff, param);
      if (action.delta_x) send(handle, WM_MOUSEHWHEEL, (notch(action.delta_x as number) << 16) & 0xffffffff, param);
      return;
    }
    if (action.type === 'mouse_move' || action.type === 'click') {
      const point = toClient(prepared.region, action.x as number, action.y as number);
      const param = ((point.y & 0xffff) << 16) | (point.x & 0xffff);
      send(handle, WM_MOUSEMOVE, 0, param);
      if (action.type === 'click') {
        await control.checkpoint();
        const button = mouseButtons[(action.button as string) || 'left'];
        if (!button) throw new Error('지원하지 않는 마우스 버튼입니다.');
        send(handle, button.down, button.flag, param);
        send(handle, button.up, 0, param);
        if (control.onClickPoint) {
          try {
            const shown = windowAdapter.screenPoint(prepared.region, action.x as number, action.y as number);
            control.onClickPoint({ x: shown.x, y: shown.y });
          } catch { /* 표시는 실패해도 클릭을 막지 않는다. */ }
        }
      }
      return;
    }
    throw new Error(`입력 adapter가 지원하지 않는 액션: ${action.type}`);
  };
  return {
    async execute(action: MacroAction, target: TargetWindow, control: RunControlLike, mode = 'foreground'): Promise<void> {
      await control.checkpoint();
      if (mode === 'background') { await executeBackground(action, target, control); return; }
      const prepared = await windowAdapter.prepareWindow(target, control);
      await control.checkpoint();
      if (action.type === 'key') { await keyboard.press(action.keys as string, prepared.window.handle, control); return; }
      if (action.type === 'text') { await keyboard.type(action.text as string, prepared.window.handle, control); return; }
      if (action.type === 'scroll') {
        if ((action.delta_y as number) < 0) await mouse.scrollDown(Math.abs(action.delta_y as number));
        if ((action.delta_y as number) > 0) await mouse.scrollUp(action.delta_y as number);
        if ((action.delta_x as number) < 0) await mouse.scrollLeft(Math.abs(action.delta_x as number));
        if ((action.delta_x as number) > 0) await mouse.scrollRight(action.delta_x as number);
        return;
      }
      if (action.type === 'mouse_move' || action.type === 'click') {
        const point = windowAdapter.screenPoint(prepared.region, action.x as number, action.y as number);
        if (!nativeAdapter.isPointInWindow(prepared.window.handle, point.x, point.y)) throw new Error('마우스 입력 위치가 다른 창에 가려져 있습니다.');
        await nativeAdapter.moveCursor(point);
        if (action.type === 'click') {
          await control.checkpoint();
          const native = nativeAdapter;
          if (!native.isForeground(prepared.window.handle) || !native.isPointInWindow(prepared.window.handle, point.x, point.y)) throw new Error('대상 창이 바뀌어 클릭을 중단했습니다.');
          if (control.onClickPoint) { try { control.onClickPoint({ x: point.x, y: point.y }); } catch { /* 표시는 실패해도 클릭을 막지 않는다. */ } }
          native.clickMouse((action.button as string) || 'left');
        }
        return;
      }
      throw new Error(`입력 adapter가 지원하지 않는 액션: ${action.type}`);
    },
    async releaseAll(): Promise<void> { keyboard.releaseAll(); },
  };
}
