const koffi = require('koffi');
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
const dpi = user.func('uint32_t __stdcall GetDpiForWindow(void *hwnd)');
const show = user.func('int __stdcall ShowWindow(void *hwnd, int command)');
const iconic = user.func('int __stdcall IsIconic(void *hwnd)');
const focus = user.func('int __stdcall SetForegroundWindow(void *hwnd)');
const foreground = user.func('void * __stdcall GetForegroundWindow()');
const windowFromPoint = user.func('void * __stdcall WindowFromPoint(AmericanoPoint point)');
const ancestor = user.func('void * __stdcall GetAncestor(void *window, uint32_t flags)');
const setCursor = user.func('int __stdcall SetCursorPos(int x, int y)');
const getCursor = user.func('int __stdcall GetCursorPos(_Out_ AmericanoPoint *point)');
const systemMetric = user.func('int __stdcall GetSystemMetrics(int index)');
function cursorPosition() { const point = {}; if (!getCursor(point)) throw new Error('커서 위치를 읽지 못했습니다.'); return point; }
async function moveCursor(point) {
  if (!setCursor(point.x, point.y)) {
    const size = process.arch === 'x64' ? 40 : 28;
    const offset = process.arch === 'x64' ? 8 : 4;
    const buffer = Buffer.alloc(size);
    const left = systemMetric(76), top = systemMetric(77), width = systemMetric(78), height = systemMetric(79);
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
function clickMouse(button = 'left') {
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
function isPointInWindow(handle, x, y) {
  const hit = windowFromPoint({ x, y });
  const root = hit && ancestor(hit, 2);
  return Boolean(root && koffi.address(root) === koffi.address(handle));
}
const sendInput = user.func('uint32_t __stdcall SendInput(uint32_t count, const void *inputs, int size)');
function sendKeyboard(events) {
  const size = process.arch === 'x64' ? 40 : 28;
  const offset = process.arch === 'x64' ? 8 : 4;
  const buffer = Buffer.alloc(events.length * size);
  events.forEach((event, index) => {
    const base = index * size; buffer.writeUInt32LE(1, base);
    buffer.writeUInt16LE(event.key || 0, base + offset);
    buffer.writeUInt16LE(event.scan || 0, base + offset + 2);
    buffer.writeUInt32LE(event.flags || 0, base + offset + 4);
  });
  return sendInput(events.length, buffer, size);
}
const decode = (buffer) => buffer.toString('utf16le').split('\0')[0];
function listWindows() {
  const result = [];
  const cb = koffi.register((handle) => {
    if (!visible(handle)) return 1;
    const text = Buffer.alloc(2048); title(handle, text, 1024);
    const name = decode(text); if (!name) return 1;
    const ids = [0]; pid(handle, ids);
    const process = open(0x1000, 0, ids[0]);
    let executable_path = '';
    if (process) { try { const buffer = Buffer.alloc(65536); const size = [32768]; if (query(process, 0, buffer, size)) executable_path = decode(buffer); } finally { close(process); } }
    result.push({ handle, title: name, process_name: executable_path.split('\\').at(-1), executable_path });
    return 1;
  }, koffi.pointer(callback));
  try { enumerate(cb, 0); } finally { koffi.unregister(cb); }
  return result;
}
function geometry(handle) {
  const r = {}; const p = { x: 0, y: 0 };
  if (!rect(handle, r) || !origin(handle, p) || r.right <= 0 || r.bottom <= 0) throw new Error('대상 창 client 영역을 읽을 수 없습니다.');
  return { x: p.x, y: p.y, width: r.right, height: r.bottom, dpi: dpi(handle) || 96 };
}
function activate(handle) {
  if (iconic(handle)) show(handle, 9);
  focus(handle);
}
function isForeground(handle) {
  const active = foreground();
  return Boolean(active && koffi.address(active) === koffi.address(handle));
}
module.exports = { listWindows, geometry, activate, isForeground, isPointInWindow, sendKeyboard, cursorPosition, moveCursor, clickMouse };
