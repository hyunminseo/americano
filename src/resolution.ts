import type { Region, Roi } from './macros.js';

// 해상도 독립 실행을 위한 스케일 계산.
// 게임 UI는 창 크기에 비례해 확대/축소 렌더링된다고 가정한다:
//   현재 화면 좌표 = 기준 화면 좌표 * (현재 오버레이 크기 / 기준 오버레이 크기)
// 기준 오버레이는 패키지에 저장된 binding.source_overlay(캡처 당시 크기)이다.
// 종횡비가 달라지면(예: 4:3 캡처 → 16:10 창) UI가 재배치되므로 자동 변환하지 않는다.
export const ASPECT_TOLERANCE = 0.02;
export const MIN_PERCENT = 25;
export const MAX_PERCENT = 400;

export interface Scale {
  sx: number;
  sy: number;
  uniform: boolean;
  estimated: boolean;
}

export interface Point {
  x: number;
  y: number;
}

function assertRegion(value: unknown, name: string): Region {
  if (!value || typeof value !== 'object') throw new Error(`${name}: 영역이 필요합니다.`);
  const record = value as Record<string, unknown>;
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    if (!Number.isSafeInteger(record[key])) throw new Error(`${name}.${key}: 정수가 필요합니다.`);
  }
  const region = value as Region;
  if (region.width < 1 || region.height < 1) throw new Error(`${name}: 너비·높이는 1 이상이어야 합니다.`);
  return region;
}

// current(현재 오버레이)와 reference(기준 오버레이) 사이의 배율을 구한다.
// reference가 없으면 기존 동작과 같은 배율 1을 반환한다.
export function resolveScale(current: Region, reference?: Region | null): Scale {
  assertRegion(current, 'current');
  if (!reference) return { sx: 1, sy: 1, uniform: true, estimated: false };
  assertRegion(reference, 'reference');
  const sx = current.width / reference.width;
  const sy = current.height / reference.height;
  const uniform = Math.abs(sx - sy) / Math.max(sx, sy) <= ASPECT_TOLERANCE;
  return { sx, sy, uniform, estimated: true };
}

// 수동 배율(base, %)에 해상도 배율을 곱한 실효 템플릿 배율을 구한다.
// 정수% 반올림은 최대 0.8% 오차로 작은 템플릿 상관을 깨뜨리므로 소수 첫째자리까지 유지한다.
export function effectivePercent(base: number, scale: Scale): number | { x: number; y: number } {
  if (!Number.isInteger(base) || base < MIN_PERCENT || base > MAX_PERCENT) throw new Error('기준 이미지 배율은 25~400%입니다.');
  const round1 = (value: number): number => Math.round(value * 10) / 10;
  const px = round1(base * scale.sx);
  const py = round1(base * scale.sy);
  const entries: Array<[string, number]> = [['x', px], ['y', py]];
  for (const [key, value] of entries) {
    if (value < MIN_PERCENT || value > MAX_PERCENT) throw new Error(`현재 해상도가 기준과 너무 다릅니다. 이미지를 다시 캡처하세요. (필요 배율 ${key}: ${value}%)`);
  }
  return scale.uniform ? round1((px + py) / 2) : { x: px, y: py };
}

// 기준 오버레이 좌표계의 rect를 현재 오버레이 좌표계로 옮긴다.
// 오버레이 좌상단을 원점으로 비례 변환하며, 좌표가 {x,y} 오프셋을 가져도 성립한다.
export function remapRect(rect: Region | null | undefined, scale: Scale, fromOrigin?: Point | null, toOrigin?: Point | null): Region | null {
  if (!rect) return null;
  const from = fromOrigin || { x: 0, y: 0 };
  const to = toOrigin || { x: 0, y: 0 };
  return {
    x: Math.round(to.x + (rect.x - from.x) * scale.sx),
    y: Math.round(to.y + (rect.y - from.y) * scale.sy),
    width: Math.max(1, Math.round(rect.width * scale.sx)),
    height: Math.max(1, Math.round(rect.height * scale.sy)),
  };
}

export function remapPoint(x: number, y: number, scale: Scale, fromOrigin?: Point | null, toOrigin?: Point | null): Point {
  const mapped = remapRect({ x, y, width: 1, height: 1 }, scale, fromOrigin, toOrigin) as Region;
  return { x: mapped.x, y: mapped.y };
}

// 실행 성공 위치를 다음 실행의 ROI로 학습한다. 적중 상자를 오버레이 기준
// 상대 좌표(0~1)로 바꾸고 여유를 둬 이전 학습과 합친다. 상대값이라 해상도가
// 바뀌어도 그대로 쓸 수 있다. 탐색 힌트일 뿐이라 틀려도 폴백이 처리한다.
export const LEARN_MARGIN = 0.12;
export const LEARN_MIN_SIZE = 0.06;
export function learnRoi(previous: Roi | null | undefined, matchBox: Region, overlay: Region): Roi {
  assertRegion(matchBox, 'matchBox');
  assertRegion(overlay, 'overlay');
  const current = {
    x: (matchBox.x - overlay.x) / overlay.width,
    y: (matchBox.y - overlay.y) / overlay.height,
    width: matchBox.width / overlay.width,
    height: matchBox.height / overlay.height,
  };
  const expand = (rect: Roi): Roi => {
    const x = Math.min(1, Math.max(0, rect.x - LEARN_MARGIN));
    const y = Math.min(1, Math.max(0, rect.y - LEARN_MARGIN));
    return {
      x,
      y,
      width: Math.min(1 - x, Math.max(0, rect.x + rect.width + LEARN_MARGIN - x)),
      height: Math.min(1 - y, Math.max(0, rect.y + rect.height + LEARN_MARGIN - y)),
    };
  };
  const grown = expand(current);
  if (!previous) {
    return {
      x: grown.x,
      y: grown.y,
      width: Math.max(LEARN_MIN_SIZE, grown.width),
      height: Math.max(LEARN_MIN_SIZE, grown.height),
    };
  }
  const x0 = Math.min(previous.x, grown.x);
  const y0 = Math.min(previous.y, grown.y);
  const x1 = Math.max(previous.x + previous.width, grown.x + grown.width);
  const y1 = Math.max(previous.y + previous.height, grown.y + grown.height);
  return {
    x: Math.max(0, x0),
    y: Math.max(0, y0),
    width: Math.min(1 - Math.max(0, x0), Math.max(LEARN_MIN_SIZE, x1 - x0)),
    height: Math.min(1 - Math.max(0, y0), Math.max(LEARN_MIN_SIZE, y1 - y0)),
  };
}
