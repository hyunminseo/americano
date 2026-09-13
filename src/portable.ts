import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { validateDocument, MacroAction, MacroDocument, Region } from './macros.js';
import { resolveScale, remapRect, remapPoint } from './resolution.js';

const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const normalize = (macro: Record<string, unknown>): MacroDocument => validateDocument({ version: 2, macros: [macro] }).macros[0];
const branchName = (part: unknown): string => typeof part === 'number' ? String(part + 1) : ({ test: '검사', then: '참', else: '거짓', action: '재시도' } as Record<string, string>)[part as string] || String(part);
const stepLabel = (step: unknown[]): string => step.map(branchName).join('.');

function walk(items: MacroAction[] | undefined, visit: (action: MacroAction) => void): void {
  for (const action of items ?? []) {
    visit(action);
    if (action.type === 'repeat') walk(action.actions as MacroAction[], visit);
    if (action.type === 'condition') {
      walk([action.test as MacroAction], visit);
      walk(action.then as MacroAction[], visit);
      walk(action.else as MacroAction[], visit);
    }
    if (action.type === 'retry') walk([action.action as MacroAction], visit);
  }
}

function inside(point: { x: number; y: number }, area: Region | null): boolean {
  return !!area && point.x >= area.x && point.y >= area.y && point.x < area.x + area.width && point.y < area.y + area.height;
}

// 이미지 참조를 가진 액션 종류. image_detect 계열은 대체 이미지(최대 2개)를 가진다.
function imageRefs(action: MacroAction): string[] {
  if (action.type === 'smart_click') return ['image', ...(action.expect_image ? ['expect_image'] : []), 'alt_images'];
  return action.type.startsWith('image_') ? ['image', 'alt_images'] : [];
}

function refPaths(action: MacroAction): unknown[] {
  const paths: unknown[] = [];
  for (const field of imageRefs(action)) {
    const value = action[field];
    // 빈 참조도 포함해야 내보내기 단계 오류가 정확한 위치를 가리킨다.
    if (Array.isArray(value)) paths.push(...value);
    else paths.push(value);
  }
  return paths;
}

function remapRefs(action: MacroAction, references: Map<string, string>): void {
  for (const field of imageRefs(action)) {
    const value = action[field];
    if (Array.isArray(value)) action[field] = (value as string[]).map((path) => references.get(path) as string);
    else if (value) action[field] = references.get(value as string) as string;
  }
}

async function png(bytes: Buffer): Promise<Buffer> {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('이미지 크기 제한은 8MB입니다.');
  const result = await sharp(bytes, { limitInputPixels: 16000000 }).rotate().png().toBuffer();
  if (result.length > MAX_IMAGE_BYTES) throw new Error('변환된 이미지가 너무 큽니다.');
  return result;
}

interface StoreLike {
  readImage(file: string): Promise<Buffer>;
  saveImage(data: Buffer): Promise<string>;
  snapshot(): { version: 2; macros: MacroDocument[] };
  save(document: { version: 2; macros: MacroDocument[] }): Promise<{ version: 2; macros: MacroDocument[] }>;
}

export async function readPackage(file: string): Promise<Buffer> {
  if ((await fs.stat(file)).size > MAX_PACKAGE_BYTES) throw new Error('매크로 패키지 크기 제한은 32MB입니다.');
  return fs.readFile(file);
}

interface ImageRef {
  file: unknown;
  step: string;
}

export async function exportMacro(raw: Record<string, unknown>, store: StoreLike): Promise<Buffer> {
  const macro = normalize(raw);
  const refs: ImageRef[] = [];
  const collect = (items: MacroAction[] | undefined, prefix: unknown[] = []): void => {
    (items || []).forEach((action, index) => {
      const step = [...prefix, index];
      for (const file of refPaths(action)) refs.push({ file, step: step.join('.') });
      if (action.type === 'repeat') collect(action.actions as MacroAction[], step);
      if (action.type === 'condition') { collect([action.test as MacroAction], [...step, 'test']); collect(action.then as MacroAction[], [...step, 'then']); collect(action.else as MacroAction[], [...step, 'else']); }
      if (action.type === 'retry') collect([action.action as MacroAction], [...step, 'action']);
    });
  };
  collect(macro.actions);
  const badAsset = macro.images.find((asset) => !asset.path);
  if (badAsset) throw new Error(`보관함 "${badAsset.name || '이름 없음'}"의 이미지 파일이 없습니다.`);
  const culprit = refs.find((ref) => !ref.file);
  if (culprit) throw new Error(`${stepLabel(culprit.step.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)))}단계의 기준 이미지를 먼저 선택하세요.`);
  const paths = new Set(macro.images.map(asset => asset.path));
  for (const ref of refs) paths.add(ref.file as string);
  if (paths.size > 200) throw new Error('이미지는 최대 200개까지 내보낼 수 있습니다.');
  const assets: { id: string; data: string }[] = [];
  const references = new Map<string, string>();
  let size = 0;
  for (const file of paths) {
    if (!file) throw new Error('블록의 기준 이미지를 먼저 선택하세요.');
    let bytes: Buffer;
    if (file.endsWith('.aimg')) bytes = await store.readImage(file);
    else {
      if ((await fs.stat(file)).size > MAX_IMAGE_BYTES) throw new Error('이미지 크기 제한은 8MB입니다.');
      bytes = await fs.readFile(file);
    }
    const data = (await png(bytes)).toString('base64');
    size += data.length;
    if (size > MAX_PACKAGE_BYTES) throw new Error('매크로 패키지 크기 제한은 32MB입니다.');
    const id = `asset-${assets.length + 1}`;
    references.set(file, id);
    assets.push({ id, data });
  }
  let needsReview = macro.binding?.needs_review || false;
  walk(macro.actions, action => {
    remapRefs(action, references);
    if (['click', 'mouse_move'].includes(action.type) && action.coordinate_space !== 'overlay') {
      if (inside({ x: action.x as number, y: action.y as number }, macro.overlay)) {
        action.x = (action.x as number) - (macro.overlay as Region).x;
        action.y = (action.y as number) - (macro.overlay as Region).y;
        action.coordinate_space = 'overlay';
      } else needsReview = true;
    }
  });
  macro.images = macro.images.map(asset => ({ ...asset, path: references.get(asset.path) as string, preview: '' }));
  // Machine-specific executable paths and shortcuts must not bind another PC silently.
  delete macro.target_window.executable_path;
  macro.hotkey = '';
  macro.enabled = false;
  macro.binding = { needs_overlay: true, needs_review: needsReview, source_overlay: macro.overlay || macro.binding?.source_overlay || null };
  const bytes = Buffer.from(JSON.stringify({ format: 'americano-macro', version: 1, macro, assets }));
  if (bytes.length > MAX_PACKAGE_BYTES) throw new Error('매크로 패키지 크기 제한은 32MB입니다.');
  return bytes;
}

interface RawPackage {
  format?: unknown;
  version?: unknown;
  macro?: unknown;
  assets?: unknown;
}

interface RawAsset {
  id?: unknown;
  data?: unknown;
}

export async function decodePackage(bytes: Buffer): Promise<{ macro: MacroDocument; assets: Map<string, Buffer> }> {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_PACKAGE_BYTES) throw new Error('매크로 패키지 크기가 잘못되었습니다.');
  const raw = JSON.parse(bytes.toString('utf8')) as RawPackage;
  if (raw?.format !== 'americano-macro' || raw.version !== 1 || !Array.isArray(raw.assets) || (raw.assets as unknown[]).length > 200) throw new Error('지원하지 않는 매크로 패키지입니다.');
  const macro = normalize(raw.macro as Record<string, unknown>);
  const assets = new Map<string, Buffer>();
  for (const item of raw.assets as RawAsset[]) {
    if (!item || typeof item.id !== 'string' || !/^asset-[1-9][0-9]{0,2}$/.test(item.id) || assets.has(item.id)) throw new Error('이미지 자산 ID가 잘못되었거나 중복됩니다.');
    if (typeof item.data !== 'string' || item.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.data)) throw new Error('이미지 데이터가 잘못되었습니다.');
    assets.set(item.id, await png(Buffer.from(item.data, 'base64')));
  }
  const check = (id: unknown): void => { if (!assets.has(id as string)) throw new Error('패키지 안에 참조된 이미지가 없습니다.'); };
  macro.images.forEach(asset => check(asset.path));
  walk(macro.actions, action => { for (const file of refPaths(action)) check(file); });
  macro.id = randomUUID();
  macro.enabled = false;
  macro.hotkey = '';
  delete macro.target_window.executable_path;
  macro.binding = { needs_overlay: true, needs_review: macro.binding?.needs_review || false, source_overlay: macro.overlay || macro.binding?.source_overlay || null };
  // A package can be produced outside this application; derive review flags ourselves.
  walk(macro.actions, action => {
    if (['click', 'mouse_move'].includes(action.type) && action.coordinate_space !== 'overlay') macro.binding!.needs_review = true;
  });
  macro.overlay = null;
  return { macro, assets };
}

export async function importMacro(bytes: Buffer, store: StoreLike): Promise<string> {
  const { macro, assets } = await decodePackage(bytes);
  const created: string[] = [];
  const paths = new Map<string, string>();
  try {
    for (const [id, data] of assets) { const file = await store.saveImage(data); created.push(file); paths.set(id, file); }
    macro.images = macro.images.map(asset => ({ ...asset, id: randomUUID(), path: paths.get(asset.path) as string, preview: `data:image/png;base64,${(assets.get(asset.path) as Buffer).toString('base64')}` }));
    // Include file-selected images in the library as well as captured images.
    for (const [id, file] of paths) if (!macro.images.some(asset => asset.path === file)) {
      const metadata = await sharp(assets.get(id) as Buffer).metadata();
      macro.images.push({ id: randomUUID(), name: id, path: file, preview: `data:image/png;base64,${(assets.get(id) as Buffer).toString('base64')}`, region: { x: 0, y: 0, width: metadata.width ?? 0, height: metadata.height ?? 0 }, learned_region: null, learned_roi: null, learned_scale_factor: null });
    }
    walk(macro.actions, action => { remapRefs(action, paths); });
    const document = store.snapshot();
    document.macros.push(macro);
    await store.save(document);
    return macro.id;
  } catch (error) {
    await Promise.all(created.map(file => fs.unlink(file).catch(() => {})));
    throw error;
  }
}

export function rebindOverlay(raw: Record<string, unknown> & { overlay?: Region | null }, region: Region): MacroDocument {
  const macro = normalize({ ...raw, overlay: region });
  const previous = (raw.overlay || macro.binding?.source_overlay) as Region | null | undefined;
  if (macro.binding) {
    macro.binding.needs_overlay = false;
    if (previous && (previous.width !== region.width || previous.height !== region.height)) macro.binding.needs_review = true;
  }
  if (JSON.stringify(previous) !== JSON.stringify(region)) macro.images.forEach(asset => { asset.learned_region = null; });
  // Preserve DIP offsets; stretching coordinates would guess the target app's layout.
  walk(macro.actions, action => {
    if (action.type === 'smart_click' || action.type.startsWith('image_')) action.region = { ...macro.overlay } as Region;
  });
  // 종횡비가 같으면(예: 1280x960 → 800x600) UI가 비례 축소되므로 고정 좌표와
  // 캡처 위치 힌트를 같은 비율로 옮기고 검토 플래그를 해제한다.
  // 종횡비가 다르면 레이아웃이 재배치되므로 기존처럼 수동 검토를 요구한다.
  if (previous && (previous.width !== region.width || previous.height !== region.height)) {
    const scale = resolveScale(region, previous);
    if (scale.uniform) {
      const from = { x: previous.x, y: previous.y };
      const to = { x: region.x, y: region.y };
      let outside = false;
      walk(macro.actions, action => {
        if (['click', 'mouse_move'].includes(action.type) && action.coordinate_space === 'overlay') {
          const moved = remapPoint(action.x as number, action.y as number, scale, { x: 0, y: 0 }, { x: 0, y: 0 });
          action.x = moved.x;
          action.y = moved.y;
          if ((action.x as number) < 0 || (action.y as number) < 0 || (action.x as number) >= region.width || (action.y as number) >= region.height) outside = true;
        }
        // 창 기준 고정 좌표가 남아 있으면 비례 변환으로 해결되지 않으므로 검토를 유지한다.
        if (['click', 'mouse_move'].includes(action.type) && action.coordinate_space !== 'overlay') outside = true;
      });
      macro.images.forEach(asset => {
        asset.region = remapRect(asset.region, scale, from, to) || asset.region;
      });
      if (macro.binding && !outside) macro.binding.needs_review = false;
    }
  }
  return macro;
}

export function assertRunnable(macro: MacroDocument): void {
  if (macro.binding?.needs_overlay) throw new Error('가져온 매크로의 대상 창을 확인하고 오버레이를 재지정하세요.');
  if (macro.binding?.needs_review) throw new Error('영역 크기 또는 창 기준 좌표가 달라졌습니다. 이미지와 좌표 검토를 완료하세요.');
  walk(macro.actions, action => {
    if (['click', 'mouse_move'].includes(action.type) && action.coordinate_space === 'overlay' && (!macro.overlay || (action.x as number) >= macro.overlay.width || (action.y as number) >= macro.overlay.height)) throw new Error('입력 좌표가 오버레이 범위를 벗어났습니다.');
  });
}
