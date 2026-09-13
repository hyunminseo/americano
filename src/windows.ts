import type { TargetWindow } from './macros.js';

export type { TargetWindow };

export class WindowAdapterError extends Error {}

export interface WindowInfo {
  handle: unknown;
  title: string;
  process_name: string;
  executable_path: string;
  [key: string]: unknown;
}

interface NativeAdapter {
  listWindows(): WindowInfo[];
  geometry(handle: unknown): ClientRect;
  isForeground(handle: unknown): boolean;
  activate(handle: unknown): void;
}

export interface ClientRect {
  x: number;
  y: number;
  width: number;
  height: number;
  dpi: number;
}

const native = (): NativeAdapter => require('./native-windows.js') as NativeAdapter;

export function matchesTarget(info: WindowInfo, target: TargetWindow): boolean {
  const fields: (keyof TargetWindow)[] = ['process_name', 'executable_path', 'title_contains'];
  if (!fields.some((field) => target[field])) return false;
  return fields.every((field) => !target[field] || (field === 'title_contains'
    ? info.title.toLowerCase().includes((target[field] as string).toLowerCase())
    : ((info[field] || '') as string).toLowerCase() === (target[field] as string).toLowerCase()));
}

export async function listWindows(): Promise<WindowInfo[]> { return native().listWindows(); }

export interface WaitControl {
  time(): number;
  checkpoint(): Promise<void>;
  wait(ms: number): Promise<void>;
}

export interface ForegroundAdapter {
  isForeground(handle: unknown): boolean;
  activate(handle: unknown): void;
}

export interface GeometryAdapter {
  geometry(handle: unknown): ClientRect;
}

export async function findWindow(target: TargetWindow, timeoutMs = 10000, control: WaitControl | null = null): Promise<WindowInfo> {
  if (!['process_name', 'executable_path', 'title_contains'].some((field) => target[field as keyof TargetWindow])) throw new WindowAdapterError('실행 대상 창을 먼저 선택하세요.');
  const start = control ? control.time() : Date.now();
  do {
    if (control) await control.checkpoint();
    const candidates = (await listWindows()).filter((info) => matchesTarget(info, target));
    if (candidates.length > 1) throw new WindowAdapterError('대상 창이 여러 개입니다. 창 제목과 프로세스를 더 구체적으로 지정하세요.');
    if (candidates.length === 1) return candidates[0];
    if (timeoutMs === 0) break;
    if (control) await control.wait(100);
    else await new Promise((resolve) => setTimeout(resolve, 100));
  } while ((control ? control.time() : Date.now()) - start <= timeoutMs);
  throw new WindowAdapterError('대상 창을 찾지 못했습니다.');
}

export async function readGameGeometry(handle: unknown, adapter: GeometryAdapter = native()): Promise<ClientRect> {
  let previous: ClientRect | null = null;
  let error: Error | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const current = adapter.geometry(handle);
      if (current.width >= 8 && current.height >= 8 && JSON.stringify(current) === JSON.stringify(previous)) return current;
      previous = current;
    } catch (caught) { error = caught as Error; previous = null; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new WindowAdapterError(error?.message || '게임 창 크기가 변경 중입니다. 해상도 변경을 마친 뒤 다시 시도하세요.');
}

export async function ensureForeground(handle: unknown, control: WaitControl | undefined, adapter: ForegroundAdapter = native()): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (control) await control.checkpoint();
    if (adapter.isForeground(handle)) return;
    adapter.activate(handle);
    for (let tick = 0; tick < 20; tick++) {
      if (control) await control.wait(25);
      else await new Promise(resolve => setTimeout(resolve, 25));
      if (adapter.isForeground(handle)) return;
    }
  }
  throw new WindowAdapterError('대상 창 전경 전환에 실패했습니다. 게임 창을 직접 클릭한 뒤 다시 실행하세요. 게임과 Americano의 실행 권한 수준도 확인하세요.');
}

export async function prepareWindow(target: TargetWindow, control: WaitControl | undefined): Promise<{ window: WindowInfo; region: ClientRect; dpi: number }> {
  const window = await findWindow(target, 10000, control);
  if (control) await control.checkpoint();
  await ensureForeground(window.handle, control);
  const region = native().geometry(window.handle);
  return { window, region, dpi: region.dpi };
}

export function screenPoint(region: ClientRect, x: number, y: number): { x: number; y: number } {
  const scale = (region.dpi || 96) / 96;
  const point = { x: region.x + Math.round(x * scale), y: region.y + Math.round(y * scale) };
  if (point.x < region.x || point.y < region.y || point.x >= region.x + region.width || point.y >= region.y + region.height) throw new WindowAdapterError('창 상대 좌표가 대상 창 영역을 벗어났습니다.');
  return point;
}
