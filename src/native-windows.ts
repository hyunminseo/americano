// @ts-expect-error: koffi 타입은 ESM으로 선언되어 있으나 실제 패키지(index.cjs)는 CJS로 동작한다.
import koffi from 'koffi';

const user = koffi.load('user32.dll');
const kernel = koffi.load('kernel32.dll');
const RECT = koffi.struct('AmericanoRect', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const POINT = koffi.struct('AmericanoPoint', { x: 'long', y: 'long' });
const callback = koffi.proto('int __stdcall AmericanoEnum(void *hwnd, intptr_t data)');
const enumerate = user.func('int __stdcall EnumWindows(AmericanoEnum *callback, intptr_t data)');
const visible = user.func('int __stdcall IsWindowVisible(void *hwnd)');
const title = user.func('int __stdcall GetWindowTextW(void *hwnd, _Out_ uint16_t *text, int size)');
const pid = user.func('uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)');
const open = kernel.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)');
const query = kernel.func('int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)');
const close = kernel.func('int __stdcall CloseHandle(void *handle)');
const rect = user.func('int __stdcall GetClientRect(void *hwnd, _Out_ AmericanoRect *rect)');
const origin = user.func('int __stdcall ClientToScreen(void *hwnd, _Inout_ AmericanoPoint *point)');
const threadDpi = user.func('intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)');
const logicalPoint = user.func('int __stdcall PhysicalToLogicalPointForPerMonitorDPI(void *hwnd, _Inout_ AmericanoPoint *point)');
const dpi = user.func('uint32_t __stdcall GetDpiForWindow(void *hwnd)');
const show = user.func('int __stdcall ShowWindowAsync(void *hwnd, int command)');
const iconic = user.func('int __stdcall IsIconic(void *hwnd)');
const focus = user.func('void * __stdcall SetForegroundWindow(void *hwnd)');
const foreground = user.func('void * __stdcall GetForegroundWindow()');
const windowFromPoint = user.func('void * __stdcall WindowFromPoint(AmericanoPoint point)');
const ancestor = user.func('void * __stdcall GetAncestor(void *window, uint32_t flags)');
const setCursor = user.func('int __stdcall SetCursorPos(int x, int y)');
const getCursor = user.func('int __stdcall GetCursorPos(_Out_ AmericanoPoint *point)');
const systemMetric = user.func('int __stdcall GetSystemMetrics(int index)');
const post = user.func('int __stdcall PostMessageW(void *hwnd, uint32_t msg, intptr_t wparam, intptr_t lparam)');

export type WindowHandle = unknown;

export interface ListedWindow {
  handle: WindowHandle;
  title: string;
  process_name: string;
  executable_path: string;
}

export interface KeyEventInput {
  key?: number;
  scan?: number;
  flags?: number;
}

export function cursorPosition(): { x: number; y: number } {
  const point = {} as { x: number; y: number };
  if (!getCursor(point)) throw new Error('커서 위치를 읽지 못했습니다.');
  return point;
}

export async function moveCursor(point: { x: number; y: number }): Promise<void> {
  if (!setCursor(point.x, point.y)) {
    const size = process.arch === 'x64' ? 40 : 28;
    const offset = process.arch === 'x64' ? 8 : 4;
    const buffer = Buffer.alloc(size);
    const left = systemMetric(76) as number;
    const top = systemMetric(77) as number;
    const width = systemMetric(78) as number;
    const height = systemMetric(79) as number;
    if (!width || !height) throw new Error('가상 화면 크기를 읽지 못했습니다.');
    buffer.writeInt32LE(Math.floor((point.x - left + 0.5) * 65536 / width), offset);
    buffer.writeInt32LE(Math.floor((point.y - top + 0.5) * 65536 / height), offset + 4);
    buffer.writeUInt32LE(0xc001, offset + 12);
    if (sendInput(1, buffer, size) !== 1) throw new Error('Windows가 마우스 입력을 허용하지 않았습니다.');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const actual = cursorPosition();
  if (actual.x !== point.x || actual.y !== point.y) throw new Error(`요청한 위치로 커서를 이동하지 못했습니다 (${point.x},${point.y} → ${actual.x},${actual.y}).`);
}

export function clickMouse(button = 'left'): void {
  const flags = { left: [2, 4], right: [8, 16], middle: [32, 64] }[button];
  if (!flags) throw new Error('지원하지 않는 마우스 버튼입니다.');
  const size = process.arch === 'x64' ? 40 : 28;
  const offset = process.arch === 'x64' ? 8 : 4;
  const buffer = Buffer.alloc(size * 2);
  flags.forEach((flag, index) => buffer.writeUInt32LE(flag, size * index + offset + 12));
  const sent = sendInput(2, buffer, size);
  if (sent === 1) sendInput(1, buffer.subarray(size), size);
  if (sent !== 2) throw new Error('Windows 마우스 클릭이 거부되었습니다.');
}

export function isPointInWindow(handle: WindowHandle, x: number, y: number): boolean {
  const hit = windowFromPoint({ x, y });
  const root = hit && ancestor(hit, 2);
  return Boolean(root && koffi.address(root) === koffi.address(handle));
}

const sendInput = user.func('uint32_t __stdcall SendInput(uint32_t count, const void *inputs, int size)');

export function sendKeyboard(events: KeyEventInput[]): number {
  const size = process.arch === 'x64' ? 40 : 28;
  const offset = process.arch === 'x64' ? 8 : 4;
  const buffer = Buffer.alloc(events.length * size);
  events.forEach((event, index) => {
    const base = index * size;
    buffer.writeUInt32LE(1, base);
    buffer.writeUInt16LE(event.key || 0, base + offset);
    buffer.writeUInt16LE(event.scan || 0, base + offset + 2);
    buffer.writeUInt32LE(event.flags || 0, base + offset + 4);
  });
  return sendInput(events.length, buffer, size) as number;
}

const decode = (buffer: Buffer): string => buffer.toString('utf16le').split('\0')[0];

export function listWindows(): ListedWindow[] {
  const result: ListedWindow[] = [];
  const cb = koffi.register((handle: WindowHandle) => {
    if (!visible(handle)) return 1;
    const text = Buffer.alloc(2048);
    title(handle, text, 1024);
    const name = decode(text);
    if (!name) return 1;
    const ids = [0];
    pid(handle, ids);
    const process = open(0x1000, 0, ids[0]);
    let executable_path = '';
    if (process) {
      try {
        const buffer = Buffer.alloc(65536);
        const size = [32768];
        if (query(process, 0, buffer, size)) executable_path = decode(buffer);
      } finally { close(process); }
    }
    result.push({ handle, title: name, process_name: executable_path.split('\\').at(-1) as string, executable_path });
    return 1;
  }, koffi.pointer(callback));
  try { enumerate(cb, 0); } finally { koffi.unregister(cb); }
  return result;
}

export interface ClientGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  dpi: number;
}

export function geometry(handle: WindowHandle): ClientGeometry {
  if (iconic(handle)) throw new Error('게임 창이 최소화되어 있습니다. 창을 복원한 뒤 해상도를 다시 설정하세요.');
  // Query physical pixels explicitly, then derive the target's virtualization scale.
  // GetDpiForWindow alone returns 96 for DPI-unaware games even at 150% scaling.
  const previous = threadDpi(-4); // PER_MONITOR_AWARE_V2
  if (!previous) throw new Error('화면 DPI 좌표계를 설정하지 못했습니다.');
  try {
    const r = {} as { right: number; bottom: number };
    const p = { x: 0, y: 0 };
    if (!rect(handle, r) || !origin(handle, p) || r.right <= 0 || r.bottom <= 0) throw new Error('대상 창 client 영역을 읽을 수 없습니다.');
    const start = { ...p };
    const end = { x: p.x + r.right, y: p.y + r.bottom };
    if (!logicalPoint(handle, start) || !logicalPoint(handle, end) || end.x <= start.x) throw new Error('게임 해상도 배율을 읽을 수 없습니다.');
    const effectiveDpi = ((dpi(handle) as number) || 96) * r.right / (end.x - start.x);
    return { x: p.x, y: p.y, width: r.right, height: r.bottom, dpi: effectiveDpi };
  } finally { threadDpi(previous); }
}

export function activate(handle: WindowHandle): void {
  if (isForeground(handle)) return;
  if (iconic(handle)) show(handle, 9);
  focus(handle);
}

export function isForeground(handle: WindowHandle): boolean {
  const active = foreground();
  return Boolean(active && koffi.address(active) === koffi.address(handle));
}

// 백그라운드 입력: 커서를 움직이거나 창을 전경으로 가져오지 않고
// 대상 창의 메시지 큐에 직접 전달한다. DirectInput 계열 게임은 무시할 수 있다.
export function postMessage(handle: WindowHandle, msg: number, wParam: number, lParam: number): void {
  if (!post(handle, msg, wParam, lParam)) throw new Error('창에 입력을 전달하지 못했습니다. 창이 닫혔거나 권한이 다릅니다.');
}
