const sharp = require('sharp');
const { findTemplate, loadTemplate } = require('./matcher');

// 절반 해상도 선탐색 + 원본 해상도 정밀화로 전체 클라이언트 탐색을 수 초 안에 끝낸다.
// 모든 sharp 호출은 PNG/파일 기반이며 raw 버퍼 재해석을 사용하지 않는다.
// 반환은 프레임 좌표 기준 {x, y, width, height, score}이며 없으면 null이다.
async function findCoarseToFine(framePng, templateSource, threshold, control) {
  const meta = await sharp(framePng).metadata();
  const templateMeta = await sharp(templateSource).metadata();
  if (templateMeta.width > meta.width || templateMeta.height > meta.height) {
    throw new Error('기준 이미지가 오버레이 검색 영역보다 큽니다.');
  }
  const template = await loadTemplate(templateSource);
  const useHalf = meta.width > 320 && templateMeta.width > 32 && templateMeta.height > 16;
  if (!useHalf) {
    const frame = await sharp(framePng).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
    return findTemplate(frame, template, threshold, control);
  }
  const scale = 2;
  const smallFrame = await sharp(framePng)
    .resize(Math.round(meta.width / scale), Math.round(meta.height / scale))
    .removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  const smallTemplate = await sharp(templateSource)
    .resize(Math.round(templateMeta.width / scale), Math.round(templateMeta.height / scale))
    .removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  const candidate = await findTemplate(smallFrame, smallTemplate, threshold, control);
  if (!candidate) return null;
  const pad = 24;
  const coarse = {
    x: Math.round(candidate.x * scale + (templateMeta.width - candidate.width * scale) / 2),
    y: Math.round(candidate.y * scale + (templateMeta.height - candidate.height * scale) / 2),
  };
  const width = Math.min(meta.width, templateMeta.width + pad * 2);
  const height = Math.min(meta.height, templateMeta.height + pad * 2);
  if (width < templateMeta.width || height < templateMeta.height) return { ...coarse, width: templateMeta.width, height: templateMeta.height, score: candidate.score };
  const left = Math.max(0, Math.min(meta.width - width, coarse.x - pad));
  const top = Math.max(0, Math.min(meta.height - height, coarse.y - pad));
  const crop = await sharp(framePng).extract({ left, top, width, height })
    .removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  const refined = await findTemplate(crop, template, threshold, control);
  if (!refined) return { ...coarse, width: templateMeta.width, height: templateMeta.height, score: candidate.score };
  return { x: left + refined.x, y: top + refined.y, width: templateMeta.width, height: templateMeta.height, score: refined.score };
}

// 3x3 구역 번호: 아래쪽부터 123, 중간 456, 위쪽 789, 0은 전체.
// 구역 안에서 먼저 찾고, 없으면 전체에서 다시 찾는다.
function zoneRegion(area, zone) {
  if (!zone) return { ...area };
  const column = (zone - 1) % 3;
  const row = 2 - Math.floor((zone - 1) / 3);
  const x0 = Math.round(area.x + (area.width * column) / 3);
  const x1 = Math.round(area.x + (area.width * (column + 1)) / 3);
  const y0 = Math.round(area.y + (area.height * row) / 3);
  const y1 = Math.round(area.y + (area.height * (row + 1)) / 3);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
async function searchWindow(framePng, area, window, templateSource, threshold, control) {
  const templateMeta = await sharp(templateSource).metadata();
  if (templateMeta.width > window.width || templateMeta.height > window.height) return null;
  const windowPng = await sharp(framePng)
    .extract({ left: window.x - area.x, top: window.y - area.y, width: window.width, height: window.height })
    .png().toBuffer();
  const match = await findCoarseToFine(windowPng, templateSource, threshold, control);
  if (!match) return null;
  return { ...match, x: window.x + match.x, y: window.y + match.y };
}
// 캡처했던 위치를 가장 먼저 뒤진다. UI가 그대로면 수십 ms 안에 끝난다.
// home은 캡처 당시 client 좌표이며 area와 같은 좌표계여야 한다.
const HOME_MARGIN = 48;
function homeWindow(area, home) {
  if (!home || home.width < 1 || home.height < 1) return null;
  const x0 = Math.max(area.x, Math.min(home.x - HOME_MARGIN, area.x + area.width));
  const y0 = Math.max(area.y, Math.min(home.y - HOME_MARGIN, area.y + area.height));
  const x1 = Math.min(area.x + area.width, Math.max(home.x + home.width + HOME_MARGIN, area.x));
  const y1 = Math.min(area.y + area.height, Math.max(home.y + home.height + HOME_MARGIN, area.y));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
async function findZoned(framePng, templateSource, area, zone, threshold, control, home = null) {
  const window = homeWindow(area, home);
  if (window) {
    const match = await searchWindow(framePng, area, window, templateSource, threshold, control);
    if (match) return match;
  }
  if (zone) {
    const match = await searchWindow(framePng, area, zoneRegion(area, zone), templateSource, threshold, control);
    if (match) return match;
  }
  return findCoarseToFine(framePng, templateSource, threshold, control);
}

module.exports = { findCoarseToFine, zoneRegion, findZoned, homeWindow };
