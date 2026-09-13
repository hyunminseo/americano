import sharp from 'sharp';
import { findTemplate, loadTemplate, blockConsensus, normalizeContrast } from './matcher.js';
import type { RawImage, MatchControl } from './matcher.js';
import { matchFeatures, detectCorners } from './features.js';
import type { FeatureMatch } from './features.js';
import type { Region, Roi } from './macros.js';

export interface NccMatch {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  scaleFactor?: number;
  [key: string]: unknown;
}

export type AnyMatch = NccMatch | FeatureMatch;

export interface DetectOptions {
  preprocess?: string;
  scales?: number[];
  features?: string;
  roi?: Roi | null;
}

export interface MatchCandidate {
  template: string | Buffer;
  zone?: number;
  threshold: number;
  home?: Region | null;
  learned?: Region | null;
  options?: DetectOptions;
}

// 절반 해상도 선탐색은 디테일이 줄어 상관값이 낮게 나오므로 판정을 완화하고,
// 원본 해상도 정밀화가 최종 판정한다. 선탐색만 통과하고 정밀화가 안 되면 null이다.
const COARSE_TOLERANCE = 0.85;
// 전체 상관값이 역치 근처(doubt band)에 있으면 블록 합의로 오인식을 걸러낸다.
const CONSENSUS_BAND = 0.12;
const CONSENSUS_RATIO = 0.7;
// 특징점 RANSAC 최소 인라이어. 8개 이상의 우연한 기하 일치는 사실상 불가능하다.
const MIN_FEATURE_INLIERS = 10;

export async function greyRaw(source: string | Buffer, preprocess = 'none'): Promise<RawImage> {
  const raw = await sharp(source).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  if (preprocess === 'normalize') {
    return { data: normalizeContrast(raw.data), info: raw.info };
  }
  return raw;
}

export async function scalePng(source: string | Buffer, factor?: number): Promise<string | Buffer> {
  if (!factor || factor === 1) return source;
  const meta = await sharp(source).metadata();
  const width = meta.width as number;
  const height = meta.height as number;
  return sharp(source).resize(Math.max(1, Math.round(width * factor)), Math.max(1, Math.round(height * factor))).png().toBuffer();
}
// 모든 sharp 호출은 PNG/파일 기반이며 raw 버퍼 재해석을 사용하지 않는다.
// 반환은 프레임 좌표 기준 {x, y, width, height, score}이며 없으면 null이다.
// options.preprocess: 'none' | 'normalize' (템플릿·프레임 양측 적용)
// options.scales: 피라미드 배율 목록(예: [1, 0.9, 1.1]), 순서대로 시도해 첫 적중 반환
// options.features: 'off' | 'fallback' | 'only' (특징점 매칭)
// options.roi: 오버레이 기준 상대 영역 {x,y,width,height} (0~1), findZoned에서 우선 탐색
export async function findCoarseToFine(framePng: string | Buffer, templateSource: string | Buffer, threshold: number, control?: MatchControl | null, options: DetectOptions = {}): Promise<NccMatch | null> {
  const meta = await sharp(framePng).metadata();
  const templateMeta = await sharp(templateSource).metadata();
  const frameWidth = meta.width as number;
  const frameHeight = meta.height as number;
  const templateWidth = templateMeta.width as number;
  const templateHeight = templateMeta.height as number;
  if (templateWidth > frameWidth || templateHeight > frameHeight) {
    throw new Error('기준 이미지가 오버레이 검색 영역보다 큽니다.');
  }
  const preprocess = options.preprocess === 'normalize' ? 'normalize' : 'none';
  const template = await loadTemplate(templateSource, { preprocess });
  const useHalf = frameWidth > 320 && templateWidth > 32 && templateHeight > 16;
  let match: NccMatch | null = null;
  if (!useHalf) {
    const frame = await greyRaw(framePng, preprocess);
    const direct = await findTemplate(frame, template, threshold, control);
    if (direct) match = direct;
  } else {
    const scale = 2;
    const smallFrame = await sharp(framePng)
      .resize(Math.round(frameWidth / scale), Math.round(frameHeight / scale))
      .removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
    const smallTemplate = await sharp(templateSource)
      .resize(Math.round(templateWidth / scale), Math.round(templateHeight / scale))
      .removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
    const framed = preprocess === 'normalize' ? { data: normalizeContrast(smallFrame.data), info: smallFrame.info } : smallFrame;
    const shrunk = preprocess === 'normalize' ? { data: normalizeContrast(smallTemplate.data), info: smallTemplate.info } : smallTemplate;
    const candidate = await findTemplate(framed, shrunk, threshold * COARSE_TOLERANCE, control);
    if (candidate) {
      const pad = 24;
      const coarse = {
        x: Math.round(candidate.x * scale + (templateWidth - candidate.width * scale) / 2),
        y: Math.round(candidate.y * scale + (templateHeight - candidate.height * scale) / 2),
      };
      const width = Math.min(frameWidth, templateWidth + pad * 2);
      const height = Math.min(frameHeight, templateHeight + pad * 2);
      if (width >= templateWidth && height >= templateHeight) {
        const left = Math.max(0, Math.min(frameWidth - width, coarse.x - pad));
        const top = Math.max(0, Math.min(frameHeight - height, coarse.y - pad));
        const crop = await sharp(framePng).extract({ left, top, width, height })
          .removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
        const cropped = preprocess === 'normalize' ? { data: normalizeContrast(crop.data), info: crop.info } : crop;
        const refined = await findTemplate(cropped, template, threshold, control);
        if (refined) match = { x: left + refined.x, y: top + refined.y, width: templateWidth, height: templateHeight, score: refined.score };
        else if (candidate.score >= threshold) match = { ...coarse, width: templateWidth, height: templateHeight, score: candidate.score };
      } else if (candidate.score >= threshold) {
        match = { ...coarse, width: templateWidth, height: templateHeight, score: candidate.score };
      }
    }
  }
  if (match && match.score < threshold + CONSENSUS_BAND) {
    const frame = await greyRaw(framePng, preprocess);
    const verdict = blockConsensus(frame, template, match.x, match.y, threshold);
    if (verdict.ratio < CONSENSUS_RATIO || verdict.mean < threshold - 0.1) return null;
  }
  return match;
}

// 특징점 단계: 강한 NCC 적중은 그대로 통과, doubt band 적중은 특징점 존재
// 확인을 거친다(모양만 닮은 오인식 차단). NCC 실패 시 특징점이 대신 찾는다.
const VERIFY_BAND = 0.08;
async function featureStep(ncc: NccMatch | null, windowPng: string | Buffer, templateSource: string | Buffer, threshold: number, control?: MatchControl | null, options: DetectOptions = {}): Promise<AnyMatch | null> {
  if (ncc && ncc.score >= threshold + VERIFY_BAND) return ncc;
  if (control) await control.checkpoint();
  const preprocess = options.preprocess === 'normalize' ? 'normalize' : 'none';
  const frame = await greyRaw(windowPng, preprocess);
  const template = await greyRaw(templateSource, preprocess);
  if (detectCorners(template, 150).length < 8) return ncc; // 검증 불가 → NCC 신뢰
  const featured = await matchFeatures(frame, template);
  if (ncc && featured) return ncc; // 위치는 정밀한 NCC 상자를 쓴다
  if (ncc && !featured) return null; // 닮은꼴 오인식으로 판정
  if (!ncc && featured && featured.inliers >= MIN_FEATURE_INLIERS) return featured;
  return null;
}

// 단일 윈도우에서 피라미드 스케일 순회 + 특징점 단계까지 수행한다.
export async function matchWindow(windowPng: string | Buffer, templateSource: string | Buffer, threshold: number, control?: MatchControl | null, options: DetectOptions = {}): Promise<AnyMatch | null> {
  let ncc: NccMatch | null = null;
  if (options.features !== 'only') {
    const scales = Array.isArray(options.scales) && options.scales.length ? options.scales : [1];
    for (const factor of scales) {
      if (control) await control.checkpoint();
      const scaled = await scalePng(templateSource, factor);
      const match = await findCoarseToFine(windowPng, scaled, threshold, control, options);
      if (match) { match.scaleFactor = factor; ncc = match; break; }
    }
  }
  if (options.features === 'fallback' || options.features === 'only') {
    return featureStep(ncc, windowPng, templateSource, threshold, control, options);
  }
  return ncc;
}

// 3x3 구역 번호: 아래쪽부터 123, 중간 456, 위쪽 789, 0은 전체.
// 구역 안에서 먼저 찾고, 없으면 전체에서 다시 찾는다.
export function zoneRegion(area: Region, zone: number): Region {
  if (!zone) return { ...area };
  const column = (zone - 1) % 3;
  const row = 2 - Math.floor((zone - 1) / 3);
  const x0 = Math.round(area.x + (area.width * column) / 3);
  const x1 = Math.round(area.x + (area.width * (column + 1)) / 3);
  const y0 = Math.round(area.y + (area.height * row) / 3);
  const y1 = Math.round(area.y + (area.height * (row + 1)) / 3);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
async function searchWindow(framePng: string | Buffer, area: Region, window: Region, templateSource: string | Buffer, threshold: number, control?: MatchControl | null, options: DetectOptions = {}): Promise<AnyMatch | null> {
  const templateMeta = await sharp(templateSource).metadata();
  const templateWidth = templateMeta.width as number;
  const templateHeight = templateMeta.height as number;
  if (templateWidth > window.width || templateHeight > window.height) return null;
  const windowPng = await sharp(framePng)
    .extract({ left: window.x - area.x, top: window.y - area.y, width: window.width, height: window.height })
    .png().toBuffer();
  const match = await matchWindow(windowPng, templateSource, threshold, control, options);
  if (!match) return null;
  return { ...match, x: window.x - area.x + match.x, y: window.y - area.y + match.y };
}
// 캡처했던 위치를 가장 먼저 뒤진다. UI가 그대로면 수십 ms 안에 끝난다.
// home은 캡처 당시 client 좌표이며 area와 같은 좌표계여야 한다.
const HOME_MARGIN = 48;
export function homeWindow(area: Region, home: Region | null | undefined): Region | null {
  if (!home || home.width < 1 || home.height < 1) return null;
  const x0 = Math.max(area.x, Math.min(home.x - HOME_MARGIN, area.x + area.width));
  const y0 = Math.max(area.y, Math.min(home.y - HOME_MARGIN, area.y + area.height));
  const x1 = Math.min(area.x + area.width, Math.max(home.x + home.width + HOME_MARGIN, area.x));
  const y1 = Math.min(area.y + area.height, Math.max(home.y + home.height + HOME_MARGIN, area.y));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
// ROI(상대 영역 0~1)가 있으면 홈·학습 힌트 다음, 구역보다 먼저 뒤진다.
export function roiWindow(area: Region, roi: Roi | null | undefined): Region | null {
  if (!roi) return null;
  const x0 = Math.round(area.x + area.width * roi.x);
  const y0 = Math.round(area.y + area.height * roi.y);
  const x1 = Math.round(area.x + area.width * (roi.x + roi.width));
  const y1 = Math.round(area.y + area.height * (roi.y + roi.height));
  const window: Region = { x: Math.max(area.x, x0), y: Math.max(area.y, y0), width: 0, height: 0 };
  window.width = Math.min(area.x + area.width, x1) - window.x;
  window.height = Math.min(area.y + area.height, y1) - window.y;
  if (window.width < 8 || window.height < 8) return null;
  return window;
}
export async function findZoned(framePng: string | Buffer, templateSource: string | Buffer, area: Region, zone: number, threshold: number, control?: MatchControl | null, home: Region | null = null, learned: Region | null = null, options: DetectOptions = {}): Promise<AnyMatch | null> {
  return searchSingle(framePng, templateSource, area, zone, threshold, control, home, learned, options);
}
async function searchSingle(framePng: string | Buffer, templateSource: string | Buffer, area: Region, zone: number, threshold: number, control?: MatchControl | null, home: Region | null = null, learned: Region | null = null, options: DetectOptions = {}): Promise<AnyMatch | null> {
  const visited = new Set<string>();
  for (const hint of [learned, home]) {
    const window = homeWindow(area, hint);
    if (!window || visited.has(JSON.stringify(window))) continue;
    visited.add(JSON.stringify(window));
    const match = await searchWindow(framePng, area, window, templateSource, threshold, control, options);
    if (match) return match;
  }
  const roi = roiWindow(area, options.roi);
  if (roi && !visited.has(JSON.stringify(roi))) {
    visited.add(JSON.stringify(roi));
    const match = await searchWindow(framePng, area, roi, templateSource, threshold, control, options);
    if (match) return match;
  }
  if (zone) {
    const match = await searchWindow(framePng, area, zoneRegion(area, zone), templateSource, threshold, control, options);
    if (match) return match;
  }
  const scales = Array.isArray(options.scales) && options.scales.length ? options.scales : [1];
  return matchWindow(framePng, templateSource, threshold, control, { ...options, scales });
}
// 다중 이미지 OR 탐색: 후보를 순서대로 시도해 먼저 맞은 것과 인덱스를 반환한다.
export async function matchCandidates(framePng: string | Buffer, area: Region, candidates: MatchCandidate[], control?: MatchControl | null): Promise<{ match: AnyMatch | null; index: number }> {
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const match = await searchSingle(framePng, candidate.template, area, candidate.zone ?? 0,
      candidate.threshold, control, candidate.home ?? null, candidate.learned ?? null, candidate.options ?? {});
    if (match) return { match, index };
  }
  return { match: null, index: -1 };
}

export async function scaleTemplate(source: string | Buffer, percent: number | { x?: number; y?: number } = 100): Promise<string | Buffer> {
  let px: number;
  let py: number;
  if (percent !== null && typeof percent === 'object') { px = percent.x ?? 100; py = percent.y ?? 100; }
  else { px = percent; py = percent; }
  for (const value of [px, py]) {
    if (!Number.isInteger(value) || value < 25 || value > 400) throw new Error('기준 이미지 배율은 25~400%입니다.');
  }
  if (px === 100 && py === 100) return source;
  const meta = await sharp(source).metadata();
  const width = meta.width as number;
  const height = meta.height as number;
  return sharp(source).resize(Math.max(1, Math.round(width * px / 100)), Math.max(1, Math.round(height * py / 100))).png().toBuffer();
}
