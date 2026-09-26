const native = require('@nut-tree-fork/libnut-darwin');
function listWindows() {
  return native.getWindows().map(handle => ({ handle, title: native.getWindowTitle(handle), process_name: '', executable_path: '' })).filter(w => w.title);
}
function geometry(handle) { return { ...native.getWindowRect(handle), dpi: 96 }; }
function isForeground(handle) { return native.getActiveWindow() === handle; }
function isPointInWindow(handle, x, y) {
  if (!isForeground(handle)) return false;
  for (const id of native.getWindows()) {
    const r = geometry(id);
    if (x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height) return id === handle;
  }
  return false;
}
module.exports = { listWindows, geometry, isForeground, isPointInWindow,
  activate: handle => native.focusWindow(handle),
  moveCursor: point => native.moveMouse(point.x, point.y),
  clickMouse: button => native.mouseClick(button),
};
