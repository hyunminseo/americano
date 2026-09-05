const { getWindows } = require('@nut-tree-fork/nut-js');

class WindowAdapterError extends Error {}

function matchesTarget(windowInfo, target) {
  if (target.title_contains && !windowInfo.title.toLowerCase().includes(target.title_contains.toLowerCase())) return false;
  if (target.process_name || target.executable_path) throw new WindowAdapterError('현재 Windows adapter는 창 제목 조건만 지원합니다. 프로세스/경로 조건은 native adapter가 필요합니다.');
  return Boolean(target.title_contains);
}

async function findWindow(target, timeoutMs = 10000, control = null) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (control) await control.checkpoint();
    const windows = await getWindows();
    const candidates = [];
    for (const window of windows) {
      const title = await window.getTitle();
      if (matchesTarget({ title }, target)) candidates.push({ window, title });
    }
    if (candidates.length === 1) return candidates[0].window;
    if (candidates.length > 1) throw new WindowAdapterError('대상 창이 여러 개입니다. 창 제목을 더 구체적으로 지정하세요.');
    if (control) await control.wait(100);
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new WindowAdapterError('대상 창을 찾지 못했습니다.');
}

async function prepareWindow(target, control) {
  const window = await findWindow(target, target.timeout_ms ?? 10000, control);
  const region = await window.getRegion();
  if (!region || region.width <= 0 || region.height <= 0) throw new WindowAdapterError('대상 창 영역을 확인할 수 없습니다.');
  await window.restore();
  if (!await window.focus()) throw new WindowAdapterError('대상 창을 활성화할 수 없습니다.');
  return { window, region, dpi: 96 };
}

function screenPoint(region, x, y) {
  const point = { x: region.x + Math.round(x), y: region.y + Math.round(y) };
  if (point.x < region.x || point.y < region.y || point.x >= region.x + region.width || point.y >= region.y + region.height) throw new WindowAdapterError('창 상대 좌표가 대상 창 영역을 벗어났습니다.');
  return point;
}

module.exports = { WindowAdapterError, findWindow, prepareWindow, screenPoint };