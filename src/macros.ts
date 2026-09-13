import { randomUUID } from 'node:crypto';
import { parseScript } from './uo-script/parser.js';

export class MacroError extends Error {}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Roi {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Preprocess = 'none' | 'normalize';
export type FeatureMode = 'off' | 'fallback' | 'only';

export interface ImageAsset {
  id: string;
  name: string;
  path: string;
  preview: string;
  region: Region;
  learned_region: Region | null;
  learned_roi: Roi | null;
  learned_scale_factor: number | null;
  [key: string]: unknown;
}

export interface TargetWindow {
  process_name?: string;
  executable_path?: string;
  title_contains?: string;
  [key: string]: string | undefined;
}

export interface ImageActionBase {
  type: string;
  timeout_ms: number;
  image: string;
  alt_images: string[];
  template_scale_percent: number;
  monitor: number;
  threshold: number;
  zone: number;
  region: Region;
  poll_interval_ms: number;
  roi: Roi | null;
  preprocess: Preprocess;
  pyramid: boolean;
  features: FeatureMode;
  button?: string;
  verify_interval_ms?: number;
  expect_image?: string;
  coordinate_space?: string;
  x?: number;
  y?: number;
}

export type MacroAction = Record<string, unknown> & { type: string; timeout_ms?: number };

export interface OverlayBinding {
  needs_overlay: boolean;
  needs_review: boolean;
  source_overlay: Region | null;
}

export interface MacroDocument {
  id: string;
  name: string;
  description: string;
  script: string;
  enabled: boolean;
  hotkey: string;
  target_window: TargetWindow;
  images: ImageAsset[];
  actions: MacroAction[];
  overlay: Region | null;
  loop: { count: number; interval_ms: number };
  binding: OverlayBinding | null;
  [key: string]: unknown;
}

const fail = (message: string): never => {
  throw new MacroError(message);
};

function string(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || value.length > max) fail(`${name}: 문자열 길이는 ${max}자 이하여야 합니다.`);
  return value as string;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(`${name}: ${min}~${max} 정수가 필요합니다.`);
  return value as number;
}

function number(value: unknown, name: string, min: number, max: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) return value;
  throw new MacroError(`${name}: ${min}~${max} 범위의 숫자가 필요합니다.`);
}

function region(value: unknown, name = 'region'): Region {
  const source = (value ?? {}) as Partial<Region>;
  return {
    x: integer(source.x ?? 0, `${name}.x`, 0, 100000),
    y: integer(source.y ?? 0, `${name}.y`, 0, 100000),
    width: integer(source.width ?? 1920, `${name}.width`, 1, 100000),
    height: integer(source.height ?? 1080, `${name}.height`, 1, 100000),
  };
}

function fraction(value: unknown, name: string): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) return value;
  throw new MacroError(`${name}: 0~1 범위의 숫자가 필요합니다.`);
}

function roi(value: unknown): Roi | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail('roi: 관심 영역이 잘못되었습니다.');
  const source = value as Partial<Roi>;
  const result = { x: fraction(source.x ?? 0, 'roi.x'), y: fraction(source.y ?? 0, 'roi.y'), width: fraction(source.width ?? 1, 'roi.width'), height: fraction(source.height ?? 1, 'roi.height') };
  if (result.width <= 0 || result.height <= 0 || result.x + result.width > 1 || result.y + result.height > 1) fail('roi: 영역이 오버레이를 벗어났습니다.');
  return result;
}

interface RawAction extends Record<string, unknown> {
  type: string;
  timeout_ms?: unknown;
  image?: unknown;
  alt_images?: unknown;
  template_scale_percent?: unknown;
  monitor?: unknown;
  threshold?: unknown;
  zone?: unknown;
  region?: unknown;
  poll_interval_ms?: unknown;
  roi?: unknown;
  preprocess?: unknown;
  pyramid?: unknown;
  features?: unknown;
  verify_interval_ms?: unknown;
  expect_image?: unknown;
}

function imageAction(item: RawAction, base: { type: string; timeout_ms?: number }): MacroAction {
  const preprocess = (item.preprocess ?? 'none') as string;
  if (!['none', 'normalize'].includes(preprocess)) fail('preprocess: none 또는 normalize이 필요합니다.');
  const features = (item.features ?? 'off') as string;
  if (!['off', 'fallback', 'only'].includes(features)) fail('features: off, fallback 또는 only가 필요합니다.');
  // 하나의 확인에 최대 3개까지(기본 1 + 대체 2) 등록해 OR로 판정한다.
  const alt: unknown = item.alt_images ?? [];
  if (!Array.isArray(alt) || alt.length > 2) fail('alt_images: 대체 이미지는 최대 2개입니다.');
  const alt_images = (alt as unknown[]).map((path: unknown, index: number) => {
    if (!path) fail(`alt_images[${index}]: 대체 이미지를 선택하세요.`);
    return string(path, `alt_images[${index}]`, 2048);
  });
  if (new Set([item.image, ...alt_images]).size !== alt_images.length + 1) fail('alt_images: 중복된 이미지입니다.');
  return {
    ...base,
    image: string(item.image, 'image', 2048),
    alt_images,
    template_scale_percent: integer(item.template_scale_percent ?? 100, '기준 이미지 배율 (%)', 25, 400),
    monitor: integer(item.monitor ?? 1, 'monitor', 1, 16),
    threshold: number(item.threshold ?? 0.9, 'threshold', 0, 1),
    zone: integer(item.zone ?? 0, 'zone', 0, 9),
    region: region(item.region),
    poll_interval_ms: integer(item.poll_interval_ms ?? 100, 'poll_interval_ms', 30, 60000),
    roi: roi(item.roi),
    preprocess: preprocess as Preprocess,
    pyramid: item.pyramid === true,
    features: features as FeatureMode,
  };
}

const modifiers = ['ctrl', 'alt', 'shift', 'win'];
const aliases: Record<string, string> = { control: 'ctrl', commandorcontrol: 'ctrl', super: 'win', meta: 'win', escape: 'esc' };

function keys(value: unknown): string {
  const parts = string(value, 'keys', 100).toLowerCase().split('+').map((part) => {
    const name = part.trim();
    return aliases[name] || name;
  });
  if (new Set(parts).size !== parts.length) fail('중복 키입니다.');
  const main = parts.filter((part) => !modifiers.includes(part));
  if (main.length !== 1 || !/^(?:[a-z0-9]|f(?:[1-9]|1[0-9]|2[0-4])|enter|esc|space|tab|backspace|delete|up|down|left|right|home|end|page_up|page_down)$/.test(main[0])) fail('지원하지 않는 키 조합입니다.');
  return [...modifiers.filter((part) => parts.includes(part)), main[0]].join('+');
}

interface Budget {
  count: number;
}

function actions(items: unknown, depth = 0, budget: Budget = { count: 0 }): MacroAction[] {
  if (!Array.isArray(items) || depth > 8) fail('액션 배열 또는 중첩 깊이가 잘못되었습니다.');
  return (items as RawAction[]).map((item) => {
    if (!item || typeof item !== 'object' || ++budget.count > 1000) fail('액션은 최대 1,000개입니다.');
    const type = item.type;
    const base: MacroAction = { type, timeout_ms: integer(item.timeout_ms ?? 10000, 'timeout_ms', 1, 3600000) };
    switch (type) {
      case 'random_wait': {
        const min_seconds = integer(item.min_seconds ?? 1, '최소 대기 (초)', 1, 3600);
        const max_seconds = integer(item.max_seconds ?? 60, '최대 대기 (초)', min_seconds, 3600);
        return { ...base, min_seconds, max_seconds };
      }
      case 'wait': return { ...base, duration_ms: integer(item.duration_ms, 'duration_ms', 0, 3600000) };
      case 'key': return { ...base, keys: keys(item.keys) };
      case 'text': return { ...base, text: string(item.text, 'text', 10000) };
      case 'image_detect': case 'image_wait': case 'image_click': return imageAction(item, base);
      case 'smart_click': {
        const result = imageAction(item, base);
        result.verify_interval_ms = integer(item.verify_interval_ms ?? 800, 'verify_interval_ms', 100, 10000);
        if (item.expect_image !== undefined && item.expect_image !== '') result.expect_image = string(item.expect_image, 'expect_image', 2048);
        return result;
      }
      case 'scroll': return { ...base, delta_x: integer(item.delta_x ?? 0, 'delta_x', -100000, 100000), delta_y: integer(item.delta_y ?? 0, 'delta_y', -100000, 100000) };
      case 'retry': {
        const nested = actions([item.action], depth + 1, budget)[0];
        if (!['image_detect', 'image_wait', 'image_click', 'smart_click'].includes(nested.type)) fail('retry는 이미지 액션 하나만 감쌀 수 있습니다.');
        return { ...base, count: integer(item.count ?? 0, 'retry.count', 0, 10), interval_ms: integer(item.interval_ms ?? 200, 'retry.interval_ms', 0, 60000), action: nested };
      }
      case 'condition': {
        const test = actions([item.test], depth + 1, budget)[0];
        if (test.type !== 'image_detect') fail('condition의 test는 image_detect여야 합니다.');
        return { ...base, test, then: actions(item.then ?? [], depth + 1, budget), else: actions(item.else ?? [], depth + 1, budget) };
      }
      case 'mouse_move': case 'click': {
        const result: MacroAction = { ...base, x: integer(item.x, 'x', 0, 100000), y: integer(item.y, 'y', 0, 100000) };
        if (item.coordinate_space !== undefined) {
          if (!['client', 'overlay'].includes(item.coordinate_space as string)) fail('좌표 기준이 잘못되었습니다.');
          result.coordinate_space = item.coordinate_space as string;
        }
        if (type === 'click') {
          if (!['left', 'right', 'middle'].includes((item.button ?? 'left') as string)) fail('지원하지 않는 마우스 버튼입니다.');
          result.button = (item.button ?? 'left') as string;
        }
        return result;
      }
      case 'repeat': return { ...base, count: integer(item.count, 'count', 1, 10000), actions: actions(item.actions, depth + 1, budget) };
      case 'stop': return base;
      default: fail(`아직 지원하지 않는 액션: ${type}`);
    }
    throw new MacroError(`아직 지원하지 않는 액션: ${type}`);
  });
}

interface RawDocument {
  version?: unknown;
  macros?: unknown;
  global?: unknown;
  [key: string]: unknown;
}

interface RawMacro extends Record<string, unknown> {
  id?: unknown;
  name?: unknown;
  enabled?: unknown;
  hotkey?: unknown;
  target_window?: unknown;
  script?: unknown;
  images?: unknown;
  overlay?: unknown;
  loop?: unknown;
  binding?: unknown;
  description?: unknown;
  actions?: unknown;
}

export function validateDocument(raw: RawDocument): { version: 2; macros: MacroDocument[]; global: { pause_hotkey: string; stop_hotkey: string; default_timeout_ms: number } } {
  if (!raw || raw.version !== 2 || !Array.isArray(raw.macros) || raw.macros.length > 100) fail('version 2 문서와 최대 100개의 매크로가 필요합니다.');
  const ids = new Set<string>();
  const hotkeys = new Set<string>();
  return {
    version: 2,
    macros: (raw.macros as RawMacro[]).map((item) => {
      if (!item || typeof item !== 'object') fail('잘못된 매크로입니다.');
      const id = string(item.id, 'id', 64);
      if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) fail('매크로 ID가 잘못되었거나 중복됩니다.');
      ids.add(id);
      const name = string(item.name, 'name', 100).trim();
      if (!name) fail('매크로 이름이 필요합니다.');
      if (typeof item.enabled !== 'boolean') fail('enabled는 boolean이어야 합니다.');
      const hotkey = item.hotkey ? keys(item.hotkey) : '';
      if (['f8', 'f9'].includes(hotkey)) fail('F8/F9는 예약 단축키입니다.');
      if (hotkey && item.enabled) {
        if (hotkeys.has(hotkey)) fail('활성 매크로의 단축키가 중복됩니다.');
        hotkeys.add(hotkey);
      }
      const target = (item.target_window ?? {}) as Record<string, unknown>;
      if (!target || typeof target !== 'object' || Array.isArray(target)) fail('대상 창 조건이 잘못되었습니다.');
      const target_window: TargetWindow = {};
      for (const field of ['process_name', 'executable_path', 'title_contains'] as const) {
        if (target[field] !== undefined) target_window[field] = string(target[field], field, 1024).trim();
      }
      const script = string(item.script ?? '', 'script', 50000);
      if (script) {
        try { parseScript(script); } catch (error) { fail(`script: ${(error as Error).message}`); }
      }
      if (Array.isArray(item.images) && item.images.length > 200) fail('이미지 자산은 최대 200개입니다.');
      const images: ImageAsset[] = Array.isArray(item.images) ? (item.images as Record<string, unknown>[]).map((image) => {
        if (!image || typeof image !== 'object') fail('이미지 자산이 잘못되었습니다.');
        const learnedScale = image.learned_scale_factor as unknown;
        if (learnedScale !== undefined && learnedScale !== null && (typeof learnedScale !== 'number' || !Number.isFinite(learnedScale) || learnedScale < 0.25 || learnedScale > 4)) fail('learned_scale_factor: 0.25~4 범위의 숫자가 필요합니다.');
        return {
          id: string(image.id, 'image.id', 64),
          name: string(image.name, 'image.name', 200).trim(),
          path: string(image.path, 'image.path', 4096),
          preview: string(image.preview ?? '', 'image.preview', 2000000),
          region: region(image.region, 'image.region'),
          learned_region: image.learned_region == null ? null : region(image.learned_region, 'image.learned_region'),
          learned_roi: roi(image.learned_roi ?? null),
          learned_scale_factor: (learnedScale as number | null) ?? null,
        };
      }) : [];
      const overlay = item.overlay == null ? null : region(item.overlay, 'overlay');
      const loopSource = (item.loop ?? {}) as { count?: unknown; interval_ms?: unknown };
      const loop = { count: integer(loopSource.count ?? 1, 'loop.count', 1, 10000), interval_ms: integer(loopSource.interval_ms ?? 500, 'loop.interval_ms', 30, 60000) };
      const bindingSource = item.binding as { needs_overlay?: unknown; needs_review?: unknown; source_overlay?: unknown } | null | undefined;
      const binding = bindingSource == null ? null : {
        needs_overlay: bindingSource.needs_overlay === true,
        needs_review: bindingSource.needs_review === true,
        source_overlay: bindingSource.source_overlay == null ? null : region(bindingSource.source_overlay, 'binding.source_overlay'),
      };
      return {
        id,
        name,
        description: string(item.description ?? '', 'description', 2000),
        script,
        enabled: item.enabled as boolean,
        hotkey,
        target_window,
        overlay,
        loop,
        images,
        actions: actions(item.actions),
        binding,
      };
    }),
    global: { pause_hotkey: 'f8', stop_hotkey: 'f9', default_timeout_ms: 10000 },
  };
}

export function newMacro(): MacroDocument {
  return { id: randomUUID(), name: '새 매크로', description: '', script: '', enabled: false, hotkey: '', target_window: {}, images: [], actions: [{ type: 'wait', duration_ms: 1000 }], overlay: null, loop: { count: 1, interval_ms: 500 }, binding: null };
}

export { keys };
