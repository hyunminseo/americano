import { mouse } from '@nut-tree-fork/nut-js';
import { prepareWindow, screenPoint, ClientRect, WindowInfo, TargetWindow } from './windows.js';
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
  screenPoint(region: ClientRect, x: number, y: number): { x: number; y: number };
}

interface NativeAdapter {
  isPointInWindow(handle: unknown, x: number, y: number): boolean;
  moveCursor(point: { x: number; y: number }): Promise<void>;
  isForeground(handle: unknown): boolean;
  clickMouse(button?: string): void;
}

export type { WindowAdapter, NativeAdapter };

export function createInputAdapter({ windowAdapter = { prepareWindow, screenPoint }, keyboard = new KeyboardSender(), nativeAdapter = require('./native-windows.js') as NativeAdapter } = {} as {
  windowAdapter?: WindowAdapter;
  keyboard?: KeyboardSender;
  nativeAdapter?: NativeAdapter;
}): {
  execute(action: MacroAction, target: TargetWindow, control: RunControlLike): Promise<void>;
  releaseAll(): Promise<void>;
} {
  return {
    async execute(action: MacroAction, target: TargetWindow, control: RunControlLike): Promise<void> {
      await control.checkpoint();
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
