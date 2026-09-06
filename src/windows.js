class WindowAdapterError extends Error {}
const native = () => require('./native-windows');
function matchesTarget(info, target) {
  const fields = ['process_name', 'executable_path', 'title_contains'];
  if (!fields.some((field) => target[field])) return false;
  return fields.every((field) => !target[field] || (field === 'title_contains' ? info.title.toLowerCase().includes(target[field].toLowerCase()) : (info[field] || '').toLowerCase() === target[field].toLowerCase()));
}
async function listWindows() { return native().listWindows(); }
async function findWindow(target, timeoutMs = 10000, control = null) {
  if (!['process_name', 'executable_path', 'title_contains'].some((field) => target[field])) throw new WindowAdapterError('실행 대상 창을 먼저 선택하세요.');
  const start = control ? control.time() : Date.now();
  do {
    if (control) await control.checkpoint();
    const candidates = (await listWindows()).filter((info) => matchesTarget(info, target));
    if (candidates.length > 1) throw new WindowAdapterError('대상 창이 여러 개입니다. 창 제목과 프로세스를 더 구체적으로 지정하세요.');
    if (candidates.length === 1) return candidates[0];
    if (timeoutMs === 0) break;
    if (control) await control.wait(100); else await new Promise((resolve) => setTimeout(resolve, 100));
  } while ((control ? control.time() : Date.now()) - start <= timeoutMs);
  throw new WindowAdapterError('대상 창을 찾지 못했습니다.');
}
async function prepareWindow(target, control) {
  const window = await findWindow(target, 10000, control);
  if (control) await control.checkpoint();
  native().activate(window.handle);
  for (let attempt = 0; attempt < 20 && !native().isForeground(window.handle); attempt++) {
    if (control) await control.wait(25); else await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!native().isForeground(window.handle)) throw new WindowAdapterError('대상 창 전경 전환에 실패했습니다.');
  const region = native().geometry(window.handle);
  return { window, region, dpi: region.dpi };
}
function screenPoint(region, x, y) {
  const scale = (region.dpi || 96) / 96;
  const point = { x: region.x + Math.round(x * scale), y: region.y + Math.round(y * scale) };
  if (point.x < region.x || point.y < region.y || point.x >= region.x + region.width || point.y >= region.y + region.height) throw new WindowAdapterError('창 상대 좌표가 대상 창 영역을 벗어났습니다.');
  return point;
}
module.exports = { WindowAdapterError, listWindows, matchesTarget, findWindow, prepareWindow, screenPoint };
