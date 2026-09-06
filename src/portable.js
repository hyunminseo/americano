const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { validateDocument } = require('./macros');

const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const normalize = macro => validateDocument({ version: 2, macros: [macro] }).macros[0];
function walk(items, visit) {
  for (const action of items) {
    visit(action);
    if (action.type === 'repeat') walk(action.actions, visit);
    if (action.type === 'condition') { walk([action.test], visit); walk(action.then, visit); walk(action.else, visit); }
    if (action.type === 'retry') walk([action.action], visit);
  }
}
function inside(point, area) {
  return area && point.x >= area.x && point.y >= area.y && point.x < area.x + area.width && point.y < area.y + area.height;
}
// 이미지 참조를 가진 액션 종류. smart_click은 기대 화면 자산을 추가로 가진다.
function imageRefs(action) {
  if (action.type === 'smart_click') return ['image', ...(action.expect_image ? ['expect_image'] : [])];
  return action.type.startsWith('image_') ? ['image'] : [];
}
async function png(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('이미지 크기 제한은 8MB입니다.');
  const result = await sharp(bytes, { limitInputPixels: 16000000 }).rotate().png().toBuffer();
  if (result.length > MAX_IMAGE_BYTES) throw new Error('변환된 이미지가 너무 큽니다.');
  return result;
}
async function readPackage(file) {
  if ((await fs.stat(file)).size > MAX_PACKAGE_BYTES) throw new Error('매크로 패키지 크기 제한은 32MB입니다.');
  return fs.readFile(file);
}
async function exportMacro(raw, store) {
  const macro = normalize(raw);
  const paths = new Set(macro.images.map(asset => asset.path));
  walk(macro.actions, action => { for (const field of imageRefs(action)) paths.add(action[field]); });
  if (paths.size > 200) throw new Error('이미지는 최대 200개까지 내보낼 수 있습니다.');
  const assets = []; const references = new Map();
  let size = 0;
  for (const file of paths) {
    if (!file) throw new Error('블록의 기준 이미지를 먼저 선택하세요.');
    let bytes;
    if (file.endsWith('.aimg')) bytes = await store.readImage(file);
    else {
      if ((await fs.stat(file)).size > MAX_IMAGE_BYTES) throw new Error('이미지 크기 제한은 8MB입니다.');
      bytes = await fs.readFile(file);
    }
    const data = (await png(bytes)).toString('base64');
    size += data.length;
    if (size > MAX_PACKAGE_BYTES) throw new Error('매크로 패키지 크기 제한은 32MB입니다.');
    const id = `asset-${assets.length + 1}`;
    references.set(file, id); assets.push({ id, data });
  }
  let needsReview = macro.binding?.needs_review || false;
  walk(macro.actions, action => {
    for (const field of imageRefs(action)) action[field] = references.get(action[field]);
    if (['click', 'mouse_move'].includes(action.type) && action.coordinate_space !== 'overlay') {
      if (inside(action, macro.overlay)) {
        action.x -= macro.overlay.x; action.y -= macro.overlay.y; action.coordinate_space = 'overlay';
      } else needsReview = true;
    }
  });
  macro.images = macro.images.map(asset => ({ ...asset, path: references.get(asset.path), preview: '' }));
  // Machine-specific executable paths and shortcuts must not bind another PC silently.
  delete macro.target_window.executable_path;
  macro.hotkey = ''; macro.enabled = false;
  macro.binding = { needs_overlay: true, needs_review: needsReview, source_overlay: macro.overlay || macro.binding?.source_overlay || null };
  const bytes = Buffer.from(JSON.stringify({ format: 'americano-macro', version: 1, macro, assets }));
  if (bytes.length > MAX_PACKAGE_BYTES) throw new Error('매크로 패키지 크기 제한은 32MB입니다.');
  return bytes;
}
async function decodePackage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_PACKAGE_BYTES) throw new Error('매크로 패키지 크기가 잘못되었습니다.');
  const raw = JSON.parse(bytes.toString('utf8'));
  if (raw?.format !== 'americano-macro' || raw.version !== 1 || !Array.isArray(raw.assets) || raw.assets.length > 200) throw new Error('지원하지 않는 매크로 패키지입니다.');
  const macro = normalize(raw.macro);
  const assets = new Map();
  for (const asset of raw.assets) {
    if (!asset || typeof asset.id !== 'string' || !/^asset-[1-9][0-9]{0,2}$/.test(asset.id) || assets.has(asset.id)) throw new Error('이미지 자산 ID가 잘못되었거나 중복됩니다.');
    if (typeof asset.data !== 'string' || asset.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.data)) throw new Error('이미지 데이터가 잘못되었습니다.');
    assets.set(asset.id, await png(Buffer.from(asset.data, 'base64')));
  }
  const check = id => { if (!assets.has(id)) throw new Error('패키지 안에 참조된 이미지가 없습니다.'); };
  macro.images.forEach(asset => check(asset.path));
  walk(macro.actions, action => { for (const field of imageRefs(action)) check(action[field]); });
  macro.id = randomUUID(); macro.enabled = false; macro.hotkey = '';
  delete macro.target_window.executable_path;
  macro.binding = { needs_overlay: true, needs_review: macro.binding?.needs_review || false, source_overlay: macro.overlay || macro.binding?.source_overlay || null };
  // A package can be produced outside this application; derive review flags ourselves.
  walk(macro.actions, action => {
    if (['click', 'mouse_move'].includes(action.type) && action.coordinate_space !== 'overlay') macro.binding.needs_review = true;
  });
  macro.overlay = null;
  return { macro, assets };
}
async function importMacro(bytes, store) {
  const { macro, assets } = await decodePackage(bytes);
  const created = []; const paths = new Map();
  try {
    for (const [id, data] of assets) { const file = await store.saveImage(data); created.push(file); paths.set(id, file); }
    macro.images = macro.images.map(asset => ({ ...asset, id: randomUUID(), path: paths.get(asset.path), preview: `data:image/png;base64,${assets.get(asset.path).toString('base64')}` }));
    // Include file-selected images in the library as well as captured images.
    for (const [id, file] of paths) if (!macro.images.some(asset => asset.path === file)) {
      const metadata = await sharp(assets.get(id)).metadata();
      macro.images.push({ id: randomUUID(), name: id, path: file, preview: `data:image/png;base64,${assets.get(id).toString('base64')}`, region: { x: 0, y: 0, width: metadata.width, height: metadata.height } });
    }
    walk(macro.actions, action => { for (const field of imageRefs(action)) action[field] = paths.get(action[field]); });
    const document = store.snapshot(); document.macros.push(macro);
    await store.save(document);
    return macro.id;
  } catch (error) {
    await Promise.all(created.map(file => fs.unlink(file).catch(() => {})));
    throw error;
  }
}
function rebindOverlay(raw, region) {
  const macro = normalize({ ...raw, overlay: region });
  const previous = raw.overlay || macro.binding?.source_overlay;
  if (macro.binding) {
    macro.binding.needs_overlay = false;
    if (previous && (previous.width !== region.width || previous.height !== region.height)) macro.binding.needs_review = true;
  }
  // Preserve DIP offsets; stretching coordinates would guess the target app's layout.
  walk(macro.actions, action => {
    if (action.type === 'smart_click' || action.type.startsWith('image_')) action.region = { ...macro.overlay };
  });
  return macro;
}
function assertRunnable(macro) {
  if (macro.binding?.needs_overlay) throw new Error('가져온 매크로의 대상 창을 확인하고 오버레이를 재지정하세요.');
  if (macro.binding?.needs_review) throw new Error('영역 크기 또는 창 기준 좌표가 달라졌습니다. 이미지와 좌표 검토를 완료하세요.');
  walk(macro.actions, action => {
    if (['click', 'mouse_move'].includes(action.type) && action.coordinate_space === 'overlay' && (!macro.overlay || action.x >= macro.overlay.width || action.y >= macro.overlay.height)) throw new Error('입력 좌표가 오버레이 범위를 벗어났습니다.');
  });
}
module.exports = { exportMacro, decodePackage, importMacro, readPackage, rebindOverlay, assertRunnable, walk };
