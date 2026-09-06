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
module.exports = { listWindows, geometry, activate, isForeground };
