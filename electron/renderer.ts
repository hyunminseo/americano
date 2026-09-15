interface UiRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface UiAsset {
  id: string;
  name: string;
  path: string;
  preview: string;
  region: UiRegion;
  learned_region: UiRegion | null;
  learned_roi: UiRegion | null;
  learned_scale_factor: number | null;
  [key: string]: unknown;
}

interface UiAction {
  type: string;
  [key: string]: unknown;
}

interface UiMacro {
  id: string;
  name: string;
  description?: string;
  script?: string;
  hotkey?: string;
  target_window: { title_contains?: string; process_name?: string; executable_path?: string };
  input_mode?: string;
  stats?: Record<string, { runs: number; hits: number; misses: number; scans: number; ms: number; type?: string }>;
  images: UiAsset[];
  actions: UiAction[];
  overlay: UiRegion | null;
  loop?: { count: number; interval_ms: number };
  binding?: { needs_overlay: boolean; needs_review: boolean; source_overlay?: UiRegion | null } | null;
  [key: string]: unknown;
}

interface AmericanoApi {
  request(command: string, payload?: unknown): Promise<any>;
  onState(callback: (state: any) => void): () => void;
  onStartHotkey(callback: () => void): () => void;
  onCaptureResult(callback: (result: any) => void): void;
}

declare global {
  interface Window {
    americano: AmericanoApi;
  }
}

const $ = (selector: string): HTMLElement => document.querySelector(selector) as HTMLElement;
// 전역 오류도 로그 줄에 남긴다. 조용한 먹통을 없앤다.
window.addEventListener('error', (event: ErrorEvent) => {
  try {
    const line = $('#log-line') as HTMLElement | null;
    if (line) line.textContent = `화면 오류: ${event.message}`;
  } catch { /* ignore */ }
});
window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  try {
    const line = $('#log-line') as HTMLElement | null;
    const reason = event.reason as Error | null;
    if (line) line.textContent = `처리되지 않은 오류: ${reason?.message || String(reason)}`;
  } catch { /* ignore */ }
});
let documentData: { version: 2; macros: UiMacro[] } = { version: 2, macros: [] };
let selectedId: string | null = null;
let dirty = false;
let backend: any;
let saving = false;
let captureMacroId: string | null = null;
let captureState: { activeAsset: string | null } = { activeAsset: null };
let selPath: string | null = null;
const canvasViews = new Map<string, { zoom: number; x: number; y: number }>();
const typeIcons: Record<string, string> = { wait: '⏳', random_wait: '🎲', key: '⌨', text: '✎', mouse_move: '➤', click: '◉', scroll: '⇅', image_detect: '◌', image_wait: '◎', image_click: '🎯', smart_click: '🧠', retry: '↻', condition: '⑂', repeat: '🔁', stop: '■' };

function assetName(macro: UiMacro, ref: unknown): string {
  if (!ref) return '이미지 없음';
  const found = (macro.images || []).find((asset) => asset.path === ref);
  if (found) return found.name;
  return String(ref).split(/[/\\]/).at(-1) as string;
}

function nodeSubtitle(macro: UiMacro, action: UiAction): string {
  switch (action.type) {
    case 'key': return action.keys as string || '';
    case 'text': return ((action.text as string) || '').slice(0, 24);
    case 'random_wait': return `${action.min_seconds}~${action.max_seconds}초`;
    case 'wait': return `${action.duration_ms}ms`;
    case 'click': case 'mouse_move': return `${action.coordinate_space === 'overlay' ? '오버레이' : '창'} ${action.x},${action.y}`;
    case 'image_detect': case 'image_wait': case 'image_click': case 'smart_click':
      return [assetName(macro, action.image), (action.alt_images as string[] || []).length ? `+대체${(action.alt_images as string[]).length}` : '', action.threshold].filter((part) => part !== '' && part !== undefined).join(' · ');
    case 'repeat': return `×${action.count}회`;
    case 'retry': return `최대 ${action.count}회 재시도`;
    case 'condition': return [assetName(macro, (action.test as UiAction)?.image), (((action.test as UiAction)?.alt_images as string[]) || []).length ? `+대체${((action.test as UiAction).alt_images as string[]).length}` : ''].filter((part) => part !== '' && part !== undefined).join(' · ');
    case 'scroll': return `${action.delta_x},${action.delta_y}`;
    default: return '';
  }
}

// 편집 경로("4.0", "5.then.0", "3.action.0")를 부모 배열과 인덱스로 푼다.
function resolvePath(macro: UiMacro, key: string): { items: UiAction[]; index: number; action: UiAction } {
  const parts = String(key).split('.');
  let items: UiAction[] = macro.actions;
  for (let i = 0; i < parts.length - 1; i++) {
    const node = items[Number(parts[i])];
    const marker = parts[i + 1];
    if (node?.type === 'repeat') items = node.actions as UiAction[];
    else if (node?.type === 'condition' && marker === 'test') { items = [node.test as UiAction]; i += 1; }
    else if (node?.type === 'condition' && (marker === 'then' || marker === 'else')) { items = node[marker] as UiAction[]; i += 1; }
    else if (node?.type === 'retry' && marker === 'action') { items = [node.action as UiAction]; i += 1; }
    else throw new Error('잘못된 단계 경로입니다.');
  }
  const index = Number(parts.at(-1));
  if (!items || !Number.isInteger(index) || !items[index]) throw new Error('단계를 찾지 못했습니다.');
  return { items, index, action: items[index] };
}

function moveStep(macro: UiMacro, key: string, dir: number): boolean {
  if (String(key).split('.').includes('test')) return false;
  const { items, index } = resolvePath(macro, key);
  const target = index + dir;
  if (target < 0 || target >= items.length) return false;
  [items[index], items[target]] = [items[target], items[index]];
  return true;
}

function moveStepTo(macro: UiMacro, key: string, destContainerKey: string, destIndex: number): string {
  if (String(key).split('.').some((part) => part === 'test' || part === 'action')) throw new Error('고정된 단계는 옮길 수 없습니다.');
  if (destContainerKey === key || destContainerKey.startsWith(`${key}.`)) throw new Error('자기 안에 옮길 수 없습니다.');
  const { items, index, action } = resolvePath(macro, key);
  const dest = containerItems(macro, destContainerKey);
  items.splice(index, 1);
  const at = Math.max(0, Math.min(dest === items && destIndex > index ? destIndex - 1 : destIndex, dest.length));
  dest.splice(at, 0, action);
  return (destContainerKey ? `${destContainerKey}.` : '') + at;
}

function containerItems(macro: UiMacro, containerKey: string): UiAction[] {
  if (!containerKey) return macro.actions;
  const parts = containerKey.split('.');
  const last = parts.at(-1) as string;
  if (/^\d+$/.test(last)) {
    const { action } = resolvePath(macro, containerKey);
    if (action?.type !== 'repeat') throw new Error('단계를 추가할 수 없는 위치입니다.');
    return action.actions as UiAction[];
  }
  const node = resolvePath(macro, parts.slice(0, -1).join('.')).action;
  if (node?.type === 'condition' && (last === 'then' || last === 'else')) return node[last] as UiAction[];
  throw new Error('단계를 추가할 수 없는 위치입니다.');
}

const escapeHtml = (value: unknown): string => String(value).replace(/[&<>'"]/g, (char) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' } as Record<string, string>)[char]));
const current = (): UiMacro | undefined => documentData.macros.find((macro) => macro.id === selectedId);
const log = (message: unknown): void => { ($('#log-line') as HTMLElement).textContent = String(message); };
function changed(): void { dirty = true; log('저장하지 않은 변경사항이 있습니다.'); }

async function request(command: string, payload: unknown = {}): Promise<any> {
  try {
    const result = await window.americano.request(command, payload);
    if (result.state) update(result.state);
    if (!result.ok) { log(result.error); return null; }
    return result.state;
  } catch (error) { log((error as Error).message); return null; }
}

function update(state: any): void {
  backend = state;
  for (const macro of documentData.macros) {
    const saved = state.document?.macros.find((item: UiMacro) => item.id === macro.id);
    if (!saved || JSON.stringify(saved.overlay) !== JSON.stringify(macro.overlay) || JSON.stringify(saved.target_window) !== JSON.stringify(macro.target_window)) continue;
    for (const asset of macro.images || []) {
      const learned = saved.images.find((item: UiAsset) => item.id === asset.id && item.path === asset.path)?.learned_region;
      if (learned) asset.learned_region = { ...learned };
    }
  }
  document.querySelectorAll('.asset-card').forEach(card => {
    const asset = current()?.images.find(item => item.id === (card as HTMLElement).dataset.assetId);
    const label = card.querySelector('[data-position]');
    if (asset && label) label.textContent = assetPositionText(asset);
  });
  if (state.license) {
    ($('#license-status') as HTMLElement).textContent = state.license.message;
    ($('#license-status') as HTMLElement).className = state.license.valid ? 'license-valid' : 'license-invalid';
    const variantName = ({ 'mac-match': '내 MAC 비교 빌드', 'mac-mismatch': '가상 MAC 비교 빌드', standard: '일반 빌드' } as Record<string, string>)[state.variant] || '일반 빌드';
    ($('#license-detail') as HTMLElement).textContent = [variantName, state.license.issuedTo, state.license.expiresAt ? `만료: ${new Date(state.license.expiresAt).toLocaleString()}` : '', state.license.code].filter(Boolean).join(' · ');
    ($('#license-summary') as HTMLElement).textContent = state.license.valid ? '활성' : '미등록';
    ($('#license-dot') as HTMLElement).style.color = state.license.valid ? '#2f7d33' : '#b91c1c';
  }
  const run = state.run;
  const labels: Record<string, string> = { STOPPED: '대기', RUNNING: run.preview ? '미리보기 실행 중' : '실행 중', PAUSED: '일시정지', ERROR: '실행 오류' };
  ($('#status-label') as HTMLElement).textContent = labels[run.status] || run.status;
  ($('#runtime-copy') as HTMLElement).textContent = `${run.macroId ? (documentData.macros.find((item) => item.id === run.macroId)?.name || run.macroId) : '실행 대기'}${run.step ? ` · 단계 ${run.step.map((part: string | number) => typeof part === 'number' ? part + 1 : (({ test: '검사', then: 'true', else: 'false' } as Record<string, string>)[part] || part)).join('.')}` : ''} · 반복 ${run.iteration || 0}/${run.iterations || 1}${run.attempt ? ` · 재시도 ${run.attempt}/${run.attempts ?? '?'}` : ''} · 탐지 ${run.matched == null ? '대기' : run.matched} · 완료 ${run.completed}회${run.wait_ms != null ? ` · 랜덤 대기 ${(run.wait_ms / 1000).toFixed(2)}초` : ''}${state.perf && !['RUNNING', 'PAUSED'].includes(run.status) ? ` · ${state.perf}` : ''}`;
  (($('#pause-button') as HTMLButtonElement)).disabled = !['RUNNING', 'PAUSED'].includes(run.status);
  (($('#pause-button') as HTMLButtonElement)).textContent = run.status === 'PAUSED' ? 'F8 재개' : 'F8 일시정지';
  (($('#start-button') as HTMLButtonElement)).disabled = !selectedId || ['RUNNING', 'PAUSED'].includes(run.status);
  (($('#start-button') as HTMLButtonElement)).title = backend?.f7Ready === false ? 'F7 등록에 실패했습니다. 버튼으로 시작하세요.' : 'F7';
  (($('#stop-button') as HTMLButtonElement)).disabled = !['RUNNING', 'PAUSED'].includes(run.status);
  ($('#availability') as HTMLElement).textContent = state.error || `${state.executionReason} 입력 실행은 대상 창 제목 조건과 권한이 준비된 매크로에서 사용할 수 있습니다.`;
  (($('#new-button') as HTMLButtonElement)).disabled = !state.storageReady || saving;
  if ($('#first-macro')) (($('#first-macro') as HTMLButtonElement)).disabled = !state.storageReady || saving;
  if (run.error) log(run.error);
  document.querySelectorAll('[data-step]').forEach((row) => (row as HTMLElement).classList.toggle('executing', run.macroId === selectedId && run.step?.join('.') === (row as HTMLElement).dataset.step));
}

function renderMacroSwitch(): void {
  const select = $('#macro-select') as HTMLSelectElement;
  select.innerHTML = documentData.macros.map((macro) => `<option value="${escapeHtml(macro.id)}">${escapeHtml(macro.name)}</option>`).join('') || '<option value="">매크로 없음</option>';
  select.value = selectedId || '';
  select.disabled = saving;
}

function selectedAction(macro: UiMacro): UiAction | null {
  if (!selPath) return null;
  try { return resolvePath(macro, selPath).action; }
  catch { return null; }
}

// 대체 이미지(최대 2개) 선택 UI. target은 image_detect 액션 또는 condition의 test다.
function altImageSelects(macro: UiMacro, target: UiAction, prefix: string): string {
  const assets = macro.images || [];
  const currentRefs = (target.alt_images as string[]) || [];
  return [0, 1].map((index) => {
    const options = `<option value="">없음</option>` + assets.map((asset) => `<option value="${escapeHtml(asset.path)}" ${currentRefs[index] === asset.path ? 'selected' : ''}>${escapeHtml(asset.name)}</option>`).join('');
    return `<label>대체 이미지 ${index + 1}<select data-alt="${prefix}${index}">${options}</select><small>현재: ${escapeHtml(assetName(macro, currentRefs[index]))}</small></label>`;
  }).join('');
}

function applyAltSelect(macro: UiMacro, target: UiAction, index: number, path: string): void {
  const next = [...((target.alt_images as string[]) || [])];
  if (!path) next.splice(index, 1);
  else {
    while (next.length <= index) next.push('');
    next[index] = path;
  }
  target.alt_images = next.filter(Boolean).slice(0, 2);
  if ((target.alt_images as string[]).length !== new Set([target.image, ...target.alt_images as string[]]).size) {
    target.alt_images = ((target.alt_images as string[]) || []).filter((ref) => ref !== target.image).slice(0, 2);
    log('기본 이미지와 같은 대체 이미지는 제외했습니다.');
  }
  changed();
  render();
}

// 이미지를 고르면 캡처 영역에서 ROI를 자동 계산해 함께 넣는다.
// 수동 ROI 입력은 선택 이후에 편집하면 유지된다.
function applyAssetToAction(macro: UiMacro, action: UiAction, assetPath: string): void {
  action.image = assetPath;
  const asset = (macro.images || []).find((item) => item.path === assetPath);
  const roi = asset ? roiFromAsset(macro, asset) : null;
  if (roi) action.roi = roi;
}
// 말로 만들기: 정형 문장을 동작으로 바꾼다. 대상은 보관함 이름으로 찾고,
function findAssetByName(macro: UiMacro, text: string): UiAsset | null {
  const query = String(text || '').replace(/["'“”]/g, '').trim();
  if (!query) return null;
  const assets = macro.images || [];
  return assets.find((asset) => asset.name === query)
    || assets.find((asset) => asset.name.includes(query) || query.includes(asset.name))
    || null;
}

function parseUtterances(text: string, macro: UiMacro): { actions: UiAction[]; warnings: string[] } {
  const actions: UiAction[] = [];
  const warnings: string[] = [];
  let repeat: number | null = null;
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    let matched = false;
    const timeout = (line.match(/최대\s*(\d+)\s*초/) || [])[1];
    const timeout_ms = timeout ? Number(timeout) * 1000 : undefined;
    const targetOf = (pattern: RegExp): UiAsset | null | undefined => {
      const m = line.match(pattern);
      if (!m) return undefined;
      const asset = findAssetByName(macro, m[1]);
      if (!asset) warnings.push(`“${m[1].trim()}” 이미지를 보관함에서 찾지 못했습니다.`);
      return asset;
    };
    const wait = line.match(/(\d+)\s*초?\s*(?:기다리기|대기)/);
    if (wait && !/나타날 때까지/.test(line)) {
      actions.push({ ...defaults('wait'), duration_ms: Number(wait[1]) * 1000 });
      matched = true;
    }
    if (!matched) {
      const repeatMatch = line.match(/(\d+)\s*번\s*반복/);
      if (repeatMatch) {
        if (repeat) warnings.push('반복은 한 번만 적용됩니다.');
        else repeat = Number(repeatMatch[1]);
        matched = true;
      }
    }
    if (!matched) {
      const keyMatch = line.match(/(space|enter|esc|tab|backspace|delete|up|down|left|right|home|end|f(?:[1-9]|1[0-9]|2[0-4]))\s*(?:키)?\s*누르기/);
      if (keyMatch) {
        actions.push({ ...defaults('key'), keys: keyMatch[1] });
        matched = true;
      }
    }
    if (!matched) {
      const asset = targetOf(/(.+?)(?:이|가)?\s*(?:나타날 때까지|될 때까지|때까지)\s*기다리기/) ?? targetOf(/(.+?)\s*기다리기/);
      if (asset !== undefined) {
        actions.push({ ...buildPointedAction(macro, { path: asset?.path || '', region: asset?.region }, 'wait'), timeout_ms: timeout_ms ?? 60000 });
        matched = true;
      }
    }
    if (!matched) {
      const asset = targetOf(/(.+?)(?:을|를)?\s*누르(?:기)?/);
      if (asset !== undefined) {
        actions.push({ ...buildPointedAction(macro, { path: asset?.path || '', region: asset?.region }, 'click'), timeout_ms: timeout_ms ?? 60000 });
        matched = true;
      }
    }
    if (!matched) warnings.push(`해석하지 못했습니다: ${line}`);
  }
  const body = actions.length ? actions : [];
  return { actions: repeat ? [{ ...defaults('repeat'), count: repeat, actions: body }] : body, warnings };
}

function roiFromAsset(macro: UiMacro, asset: { region?: UiRegion | null }): UiRegion | null {
  const overlay = macro.overlay;
  if (!overlay || !asset?.region) return null;
  const round3 = (value: number): number => Math.round(value * 1000) / 1000;
  return {
    x: round3(Math.max(0, (asset.region.x - overlay.x) / overlay.width)),
    y: round3(Math.max(0, (asset.region.y - overlay.y) / overlay.height)),
    width: round3(Math.min(1, asset.region.width / overlay.width)),
    height: round3(Math.min(1, asset.region.height / overlay.height)),
  };
}

// 화면에서 짚은 대상으로 동작을 만든다. kind: 누르기(wait+click) / 기다리기 / 확인 후 누르기(분기).
function buildPointedAction(macro: UiMacro, asset: { path: string; region?: UiRegion | null }, kind: string, threshold = 0.9): UiAction {
  const base = { image: asset.path, region: structuredClone(macro.overlay), threshold };
  const roi = roiFromAsset(macro, asset);
  if (roi) (base as Record<string, unknown>).roi = roi;
  if (kind === 'wait') return { ...defaults('image_wait'), ...base, timeout_ms: 60000 };
  if (kind === 'branch') {
    return { type: 'condition', test: { ...defaults('image_detect'), ...base, timeout_ms: 10000 }, then: [{ ...defaults('image_click'), ...structuredClone(base), timeout_ms: 60000 }], else: [] };
  }
  return { ...defaults('image_click'), ...base, timeout_ms: 60000 };
}

function testImagePicker(macro: UiMacro, action: UiAction): string {
  const assets = macro.images || [];
  return `<label class="image-field">검사 이미지<span class="input-with-button"><input data-test-image-path type="text" value="${escapeHtml((action.test as UiAction).image || '')}" placeholder="캡처 자산을 선택하세요"><button type="button" data-op="select-test-image">파일</button></span><span class="asset-quick-pick">${assets.map((asset) => `<button type="button" data-test-asset-path="${escapeHtml(asset.path)}" title="${escapeHtml(asset.name)}">${escapeHtml(asset.name)}</button>`).join('') || '<small>탐지 이미지 보관함에서 기준 이미지를 먼저 만드세요.</small>'}</span><small>현재: ${escapeHtml(assetName(macro, (action.test as UiAction).image))}</small></label>`;
}

function renderInspector(macro: UiMacro): void {
  const box = $('#inspector') as HTMLElement;
  const found = selectedAction(macro);
  if (!found) { box.innerHTML = '<p class="empty">노드를 클릭하면 여기서 편집합니다.</p>'; return; }
  const parts = (selPath as string).split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  box.innerHTML = `<h4>${escapeHtml(stepNumber(parts))} · ${escapeHtml(typeLabels[found.type] || found.type)}</h4>${found.type === 'condition' && found.test ? testImagePicker(macro, found) + altImageSelects(macro, found.test as UiAction, 'test:') + `<div class="form-grid"><label>기준 이미지 배율 (%)<input data-test-scale type="number" min="25" max="400" value="${(found.test as UiAction).template_scale_percent ?? 100}"></label></div>` : ''}<div class="form-grid">${fields(found)}</div>`;
  box.querySelectorAll('[data-alt]').forEach((select) => {
    (select as HTMLSelectElement).onchange = () => {
      const [prefix, index] = ((select as HTMLElement).dataset.alt as string).split(':');
      if (prefix === 'test' && found.type === 'condition' && found.test) applyAltSelect(macro, found.test as UiAction, Number(index), (select as HTMLSelectElement).value);
      else applyAltSelect(macro, found, Number(index), (select as HTMLSelectElement).value);
    };
  });
  box.querySelectorAll('[data-field]').forEach((input) => {
    (input as HTMLInputElement).oninput = () => {
      const control = input as HTMLInputElement;
      const field = (control as HTMLElement).dataset.field as string;
      const value = control.type === 'checkbox' ? control.checked : (control.type === 'number' ? (control.value === '' ? NaN : Number(control.value)) : control.value);
      if (field.startsWith('region.')) (found.region as Record<string, unknown>)[field.slice(7)] = value;
      else if (field.startsWith('roi.')) {
        const next: Record<string, number> = { x: NaN, y: NaN, width: NaN, height: NaN, ...((found.roi as Record<string, number>) || {}), [field.slice(4)]: value as number };
        const empty = [next.x, next.y, next.width, next.height].every((part) => typeof part !== 'number' || Number.isNaN(part));
        found.roi = empty ? null : { x: next.x || 0, y: next.y || 0, width: next.width || 0, height: next.height || 0 };
      }
      else found[field] = value;
      changed();
      const sub = document.querySelector(`[data-inspect="${selPath}"] .node-sub`);
      if (sub) sub.textContent = nodeSubtitle(macro, found);
    };
  });
  box.querySelectorAll('[data-asset-path]').forEach((button) => {
    (button as HTMLButtonElement).onclick = () => { applyAssetToAction(macro, found, ((button as HTMLElement).dataset.assetPath as string)); changed(); render(); };
  });
  box.querySelectorAll('[data-test-asset-path]').forEach((button) => {
    (button as HTMLButtonElement).onclick = () => { if (found.type === 'condition' && found.test) { applyAssetToAction(macro, found.test as UiAction, ((button as HTMLElement).dataset.testAssetPath as string)); changed(); render(); } };
  });
  const testScaleInput = box.querySelectorAll('[data-test-scale]')[0] as HTMLInputElement | undefined;
  if (testScaleInput) testScaleInput.oninput = () => { (found.test as UiAction).template_scale_percent = Number(testScaleInput.value); changed(); };
  const testPathInput = box.querySelectorAll('[data-test-image-path]')[0] as HTMLInputElement | undefined;
  if (testPathInput) testPathInput.oninput = () => { if (found.type === 'condition' && found.test) { (found.test as UiAction).image = testPathInput.value; changed(); } };
  box.querySelectorAll('[data-op]').forEach((button) => {
    (button as HTMLButtonElement).onclick = () => {
      if ((button as HTMLElement).dataset.op === 'select-image') void selectImage(found);
      if ((button as HTMLElement).dataset.op === 'select-test-image' && found.type === 'condition' && found.test) void selectImage(found.test as UiAction);
    };
  });
}

function bindWorkflow(macro: UiMacro): void {
  ($('#flow') as HTMLElement).querySelectorAll('[data-inspect-btn]').forEach((button) => {
    (button as HTMLButtonElement).onclick = () => { if (suppressClick) { suppressClick = false; return; } selPath = ((button as HTMLElement).closest('[data-inspect]') as HTMLElement).dataset.inspect as string; render(); applyTrace(); };
  });
  ($('#flow') as HTMLElement).querySelectorAll('[data-op]').forEach((button) => {
    (button as HTMLButtonElement).onclick = () => {
      const key = (((button as HTMLElement).closest('[data-inspect]') as HTMLElement).dataset.inspect as string);
      const op = (button as HTMLElement).dataset.op;
      if (op === 'preview') { void preview(Number(key.split('.')[0])); return; }
      if (key.split('.').some((part) => part === 'test' || part === 'action')) return;
      try {
        if (op === 'copy') { const { items, index } = resolvePath(macro, key); items.splice(index + 1, 0, structuredClone(resolvePath(macro, key).action)); }
        else if (op === 'remove') { const { items, index } = resolvePath(macro, key); items.splice(index, 1); if (selPath === key) selPath = null; }
        else if (op === 'up' || op === 'down') {
          if (!moveStep(macro, key, op === 'up' ? -1 : 1)) return;
          const parts = key.split('.');
          parts[parts.length - 1] = String(Number(parts.at(-1)) + (op === 'up' ? -1 : 1));
          selPath = parts.join('.');
        } else return;
      } catch (error) { log((error as Error).message); return; }
      changed();
      render();
    };
  });
  ($('#flow') as HTMLElement).querySelectorAll('[data-add]').forEach((button) => {
    (button as HTMLButtonElement).onclick = () => {
      const containerKey = ((button as HTMLElement).dataset.add as string);
      const select = document.querySelector(`select[data-add-type="${containerKey}"]`) as HTMLSelectElement;
      const type = select.value;
      try {
        const items = containerItems(macro, containerKey);
        const depth = containerKey.split('.').filter((part) => (/^\d+$/.test(part))).length;
        if (type === 'repeat' && depth >= 8) { log('반복 중첩은 최대 8단계입니다.'); return; }
        items.push(defaults(type));
      } catch (error) { log((error as Error).message); return; }
      changed();
      render();
    };
  });
  ($('#flow') as HTMLElement).querySelectorAll('[data-replace-btn]').forEach((button) => {
    (button as HTMLButtonElement).onclick = () => {
      const select = document.querySelector(`select[data-replace="${(button as HTMLElement).dataset.replaceBtn}"]`) as HTMLSelectElement;
      try {
        const { action } = resolvePath(macro, (button as HTMLElement).dataset.replaceBtn as string);
        if (action?.type !== 'retry') return;
        action.action = defaults(select.value);
      } catch (error) { log((error as Error).message); return; }
      changed();
      render();
    };
  });
  bindNodeDrag(macro);
  const search = $('#node-search') as HTMLInputElement | null;
  if (search) search.oninput = () => applySearch(search.value);
  applyTrace();
}

let dragState: { key: string; x: number; y: number; active: boolean; ghost: HTMLElement | null; target: Element | null; after: boolean } | null = null;
let suppressClick = false;
function clearDropMarks(): void { document.querySelectorAll('.drop-before,.drop-after,.drop-append').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-append')); }

function dropAllowed(macro: UiMacro, key: string, target: Element): boolean {
  try {
    const destContainer = (target as HTMLElement).dataset.container as string;
    if (destContainerKeyInvalid(key, destContainer)) return false;
    if (target.hasAttribute('data-index')) {
      const { items, index } = resolvePath(macro, key);
      const dest = containerItems(macro, destContainer);
      if (dest !== items) return true;
      const at = Number((target as HTMLElement).dataset.index) + (target.classList.contains('drop-after') ? 1 : 0);
      return !(at === index || at === index + 1);
    }
    return true;
  } catch { return false; }
}

function destContainerKeyInvalid(key: string, destContainer: string): boolean {
  return destContainer === key || destContainer.startsWith(`${key}.`);
}

function bindNodeDrag(macro: UiMacro): void {
  ($('#flow') as HTMLElement).querySelectorAll('[data-grip]').forEach((grip) => {
    (grip as HTMLElement).onpointerdown = (event: PointerEvent) => {
      const host = (grip as HTMLElement).closest('[data-inspect]');
      if (!host) return;
      event.preventDefault();
      try { (grip as HTMLElement).setPointerCapture(event.pointerId); } catch { /* 합성 입력에서는 무시 */ }
      dragState = { key: ((host as HTMLElement).dataset.inspect as string), x: event.clientX, y: event.clientY, active: false, ghost: null, target: null, after: false };
    };
    (grip as HTMLElement).onpointermove = (event: PointerEvent) => {
      if (!dragState || !current()) return;
      if (!dragState.active && Math.hypot(event.clientX - dragState.x, event.clientY - dragState.y) < 6) return;
      if (!dragState.active) {
        dragState.active = true;
        const host = (grip as HTMLElement).closest('.flow-node');
        if (host) host.classList.add('dragging');
        const ghost = host ? host.cloneNode(true) as HTMLElement : document.createElement('div');
        ghost.className = 'flow-ghost';
        ghost.style.left = `${event.clientX + 12}px`;
        ghost.style.top = `${event.clientY + 12}px`;
        document.body.appendChild(ghost);
        dragState.ghost = ghost;
      } else {
        (dragState.ghost as HTMLElement).style.left = `${event.clientX + 12}px`;
        (dragState.ghost as HTMLElement).style.top = `${event.clientY + 12}px`;
      }
      clearDropMarks();
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const target = under ? under.closest('[data-container]') : null;
      dragState.target = null;
      if (target && dropAllowed(current() as UiMacro, dragState.key, target)) {
        if (target.hasAttribute('data-index')) {
          const rect = target.getBoundingClientRect();
          dragState.after = event.clientY > rect.top + rect.height / 2;
          target.classList.toggle('drop-after', dragState.after);
          target.classList.toggle('drop-before', !dragState.after);
        } else {
          target.classList.add('drop-append');
        }
        dragState.target = target;
      }
    };
    const finish = (commit: boolean): void => {
      if (!dragState) return;
      const moved = dragState.active;
      const macroNow = current();
      dragState.ghost?.remove();
      document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
      const dropAfter = dragState.after;
      clearDropMarks();
      const target = dragState.target;
      const key = dragState.key;
      dragState = null;
      if (!commit || !moved || !target || !macroNow) return;
      try {
        let newKey: string;
        if (target.hasAttribute('data-index')) {
          const after = dropAfter;
          const at = Number((target as HTMLElement).dataset.index) + (after ? 1 : 0);
          newKey = moveStepTo(macroNow, key, (target as HTMLElement).dataset.container as string, at);
        } else {
          newKey = moveStepTo(macroNow, key, (target as HTMLElement).dataset.container as string, containerItems(macroNow, (target as HTMLElement).dataset.container as string).length);
        }
        selPath = newKey;
        changed();
        render();
      } catch (error) { log((error as Error).message); return; }
      suppressClick = true;
    };
    (grip as HTMLElement).onpointerup = () => finish(true);
    (grip as HTMLElement).onpointercancel = () => finish(false);
  });
}

function defaults(type: string): UiAction {
  const image: UiAction = { type, image: '', alt_images: [], zone: 0, monitor: 1, threshold: 0.9, template_scale_percent: 100, poll_interval_ms: 100, roi: null, preprocess: 'none', pyramid: false, features: 'off', region: { x: 0, y: 0, width: 1920, height: 1080 } };
  return ({ random_wait: { type, min_seconds: 1, max_seconds: 60 }, wait: { type, duration_ms: 1000 }, image_detect: structuredClone(image), image_wait: structuredClone(image), image_click: structuredClone(image), smart_click: { ...structuredClone(image), verify_interval_ms: 800, expect_image: '' }, scroll: { type, delta_x: 0, delta_y: -500 }, retry: { type, count: 2, interval_ms: 200, action: structuredClone({ ...image, type: 'image_detect' }) }, condition: { type, test: structuredClone({ ...image, type: 'image_detect' }), then: [{ type: 'wait', duration_ms: 500 }], else: [] }, key: { type, keys: 'enter' }, text: { type, text: '' }, mouse_move: { type, x: 0, y: 0 }, click: { type, x: 0, y: 0, button: 'left' }, repeat: { type, count: 2, actions: [{ type: 'wait', duration_ms: 500 }] }, stop: { type } } as Record<string, UiAction>)[type];
}

function fields(action: UiAction): string {
  const labels: Record<string, string> = { min_seconds: '최소 대기 (초)', max_seconds: '최대 대기 (초)', template_scale_percent: '기준 이미지 배율 (%)', duration_ms: '대기 시간 (ms)', image: '찾을 이미지 경로', expect_image: '기대 화면 경로(선택)', verify_interval_ms: '클릭 후 확인 간격 (ms)', zone: '구역 (0=전체)', roi: '관심 영역 ROI (0~1)', preprocess: '전처리', pyramid: '다중 스케일', features: '특징점 매칭', monitor: '모니터 번호', threshold: '일치율 (0~1)', poll_interval_ms: '검색 간격 (ms)', delta_x: '가로 스크롤', delta_y: '세로 스크롤', x: '가로 위치', y: '세로 위치', width: '캡처 너비', height: '캡처 높이', keys: '키 조합', text: '입력할 내용', count: '반복 횟수', interval_ms: '재시도 간격 (ms)' };
  const isImageAction = ['image_detect', 'image_wait', 'image_click', 'smart_click'].includes(action.type);
  return Object.entries(action).filter(([key]) => !['type', 'timeout_ms', 'actions', 'action', 'test', 'then', 'else'].includes(key)).map(([key, value]) => {
    if (['image_detect', 'image_wait', 'image_click', 'smart_click'].includes(action.type) && key === 'image') return `<label class="image-field">${escapeHtml(labels[key])}<span class="input-with-button"><input data-field="image" type="text" value="${escapeHtml(value)}" placeholder="캡처 자산을 선택하세요"><button type="button" data-op="select-image" aria-label="이미지 파일 선택">파일</button></span><span class="asset-quick-pick">${(current()?.images || []).map((asset) => `<button type="button" data-asset-path="${escapeHtml(asset.path)}" title="${escapeHtml(asset.name)}">${escapeHtml(asset.name)}</button>`).join('') || '<small>아래 캡처 보관함에서 기준 이미지를 먼저 만드세요.</small>'}</span></label>`;
    if (current()?.overlay && ['monitor', 'region'].includes(key)) return '';
    if (['image_detect', 'image_wait', 'image_click', 'smart_click'].includes(action.type) && key === 'region') return Object.entries(value as Record<string, unknown>).map(([regionKey, regionValue]) => `<label>${escapeHtml(labels[regionKey])}<input data-field="region.${regionKey}" type="number" value="${escapeHtml(regionValue)}" min="0" step="1"></label>`).join('');
    if (isImageAction && key === 'roi') {
      const roi = (value as UiRegion) || { x: '', y: '', width: '', height: '' };
      return `<label>관심 영역 ROI (이미지 선택 시 자동 입력 · 직접 수정 가능)${['x', 'y', 'width', 'height'].map((part) => `<input data-field="roi.${part}" type="number" min="0" max="1" step="0.001" placeholder="${part}" value="${(roi as unknown as Record<string, unknown>)[part] ?? ''}">`).join('')}</label>`;
    }
    if (isImageAction && key === 'preprocess') return `<label>전처리<select data-field="preprocess">${['none', 'normalize'].map((option) => `<option value="${option}" ${value === option ? 'selected' : ''}>${option === 'none' ? '없음' : '명암 정규화(조명 보정)'}</option>`).join('')}</select></label>`;
    if (isImageAction && key === 'features') return `<label>특징점 매칭<select data-field="features">${[['off', '끄기'], ['fallback', '실패 시 사용(권장)'], ['only', '특징점만']].map(([option, text]) => `<option value="${option}" ${value === option ? 'selected' : ''}>${text}</option>`).join('')}</select></label>`;
    if (isImageAction && key === 'pyramid') return `<label>다중 스케일<input data-field="pyramid" type="checkbox" ${value ? 'checked' : ''}></label>`;
    if (isImageAction && key === 'alt_images') return altImageSelects(current() as UiMacro, action, 'self:');
    if (key === 'button') return `<label>버튼<select data-field="button">${['left', 'right', 'middle'].map((option) => `<option ${value === option ? 'selected' : ''}>${option}</option>`).join('')}</select></label>`;
    if (key === 'coordinate_space') return `<label>좌표 기준<select data-field="coordinate_space"><option value="client" ${value === 'client' ? 'selected' : ''}>창 영역</option><option value="overlay" ${value === 'overlay' ? 'selected' : ''}>오버레이 영역</option></select></label>`;
    return `<label>${escapeHtml(labels[key] || key)}<input data-field="${key}" type="${typeof value === 'number' ? 'number' : 'text'}" value="${escapeHtml(value)}" ${typeof value === 'number' ? (key === 'threshold' ? 'min="0" max="1" step="0.001"' : 'min="0" step="1"') : ''}></label>`;
  }).join('');
}

const typeLabels: Record<string, string> = { wait: '대기', random_wait: '랜덤 대기', image_detect: '이미지 확인', image_wait: '이미지 발견 대기', image_click: '이미지 클릭', smart_click: '스마트 클릭', scroll: '스크롤', retry: '재시도', condition: '조건 분기', key: '키 입력', text: '문자 입력', mouse_move: '마우스 이동', click: '클릭', repeat: '반복', stop: '중단' };
function typeOptions(): string { return Object.entries(typeLabels).map(([type, label]) => '<option value="' + type + '">' + label + '</option>').join(''); }
function stepNumber(step: (string | number)[]): string { return step.map((part) => typeof part === 'number' ? part + 1 : (({ test: '검사', then: '참', else: '거짓', action: '재시도' } as Record<string, string>)[part] || part)).join('.'); }

function addSlot(containerKey: string): string {
  return '<div class="flow-add" data-container="' + escapeHtml(containerKey) + '"><select data-add-type="' + escapeHtml(containerKey) + '" aria-label="추가할 단계">' + typeOptions() + '</select><button data-add="' + escapeHtml(containerKey) + '">＋ 추가</button></div>';
}

function nodeHtml(macro: UiMacro, action: UiAction, step: (string | number)[], drop: { container: string; index: number } | null): string {
  const editKey = step.join('.');
  const isTest = step.includes('test');
  const opsHtml = (isTest || step.includes('action')) ? '' : '<div class="node-ops"><button data-op="up" title="위로">↑</button><button data-op="down" title="아래로">↓</button><button data-op="copy" title="복제">⧉</button><button data-op="remove" title="삭제">✕</button>' + (step.length === 1 ? '<button data-op="preview" title="여기부터 미리보기">▶</button>' : '') + '</div>';
  let children = '';
  if (action.type === 'condition') {
    children = '<div class="flow-lanes">'
      + '<div class="flow-lane"><p class="lane-title true">참 · 탐지 성공</p>' + (action.then as UiAction[]).map((child, i) => nodeHtml(macro, child, [...step, 'then', i], { container: [...step, 'then'].join('.'), index: i })).join('<div class="flow-link"></div>') + addSlot([...step, 'then'].join('.')) + '</div>'
      + '<div class="flow-lane"><p class="lane-title false">거짓 · 탐지 실패</p>' + (action.else as UiAction[]).map((child, i) => nodeHtml(macro, child, [...step, 'else', i], { container: [...step, 'else'].join('.'), index: i })).join('<div class="flow-link"></div>') + addSlot([...step, 'else'].join('.')) + '</div>'
      + '</div>';
  } else if (action.type === 'repeat') {
    children = '<div class="flow-lane"><p class="lane-title">반복 ×' + action.count + '</p>' + (action.actions as UiAction[]).map((child, i) => nodeHtml(macro, child, [...step, i], { container: editKey, index: i })).join('<div class="flow-link"></div>') + addSlot(editKey) + '</div>';
  } else if (action.type === 'retry') {
    const imageOptions = ['image_detect', 'image_wait', 'image_click', 'smart_click', 'condition'].map((type) => `<option value="${type}">${typeLabels[type]}</option>`).join('');
    children = '<div class="flow-lane"><p class="lane-title">재시도 대상</p>' + nodeHtml(macro, action.action as UiAction, [...step, 'action', 0], null) + '<div class="flow-add"><select data-replace="' + escapeHtml(editKey) + '" aria-label="교체할 재시도 대상">' + imageOptions + '</select><button data-replace-btn="' + escapeHtml(editKey) + '">교체</button></div></div>';
  }
  const dropAttrs = drop ? ` data-container="${escapeHtml(drop.container)}" data-index="${drop.index}"` : '';
  const grip = drop ? '<span class="node-grip" data-grip title="끌어 순서 변경">⠿</span>' : '';
  return '<div class="flow-node' + (selPath === editKey ? ' selected' : '') + '" data-step="' + escapeHtml(runKey(step)) + '" data-inspect="' + escapeHtml(editKey) + '"' + dropAttrs + '>'
    + '<div class="node-line">' + grip + '<button class="node-main" data-inspect-btn title="선택해 편집"><span class="node-icon">' + (typeIcons[action.type] || '•') + '</span><span class="node-text"><strong>' + stepNumber(step) + '. ' + escapeHtml(typeLabels[action.type] || action.type) + '</strong><small class="node-sub">' + escapeHtml(nodeSubtitle(macro, action)) + '</small></span></button>' + opsHtml + '</div>'
    + children + '</div>';
}

// 문장형 단계 목록: 좌표·경로 대신 "무엇을"만 보여준다. 읽기 전용 요약이다.
function sentenceThumb(macro: UiMacro, ref: unknown): string {
  const asset = (macro.images || []).find((item) => item.path === ref);
  if (!asset?.preview) return '';
  return `<img class="sentence-thumb" src="${escapeHtml(asset.preview)}" alt="${escapeHtml(asset.name)}">`;
}

function sentenceTimeout(action: UiAction): string {
  const seconds = Math.round(((action.timeout_ms as number) ?? 0) / 1000);
  return seconds >= 1 ? `최대 ${seconds}초` : `${action.timeout_ms ?? 0}ms`;
}

function describeItems(macro: UiMacro, items: UiAction[] | undefined, prefix: number[]): string {
  return (items || []).map((action, index) => describeAction(macro, action, [...prefix, index + 1])).join('');
}

function describeAction(macro: UiMacro, action: UiAction, number: number[]): string {
  const no = number.join('.');
  const nested = (items: UiAction[] | undefined): string => items?.length ? `<ol>${describeItems(macro, items, number)}</ol>` : '<small>없음</small>';
  let text = '';
  switch (action.type) {
    case 'wait': text = `⏳ ${action.duration_ms}ms 기다리기`; break;
    case 'random_wait': text = `🎲 ${action.min_seconds}~${action.max_seconds}초 랜덤 대기`; break;
    case 'key': text = `⌨ ${escapeHtml(action.keys)} 누르기`; break;
    case 'text': text = `✎ "${escapeHtml(((action.text as string) || '').slice(0, 24))}" 입력`; break;
    case 'click': text = `◉ ${action.coordinate_space === 'overlay' ? '오버레이' : '창'} ${action.x},${action.y} 클릭`; break;
    case 'mouse_move': text = `➤ ${action.coordinate_space === 'overlay' ? '오버레이' : '창'} ${action.x},${action.y}로 이동`; break;
    case 'scroll': text = `⇅ 스크롤 ${action.delta_x},${action.delta_y}`; break;
    case 'image_detect': text = `◌ ${sentenceThumb(macro, action.image)}${escapeHtml(assetName(macro, action.image))} 지금 보이면 통과`; break;
    case 'image_wait': text = `◎ ${sentenceThumb(macro, action.image)}${escapeHtml(assetName(macro, action.image))} 나타날 때까지 기다리기 · ${sentenceTimeout(action)}`; break;
    case 'image_click': text = `🎯 ${sentenceThumb(macro, action.image)}${escapeHtml(assetName(macro, action.image))} 나타나면 누르기`; break;
    case 'smart_click': text = `🧠 ${sentenceThumb(macro, action.image)}${escapeHtml(assetName(macro, action.image))} 눌러서 화면 바꾸기`; break;
    case 'retry': text = `↻ 최대 ${action.count}회 재시도:${nested(action.action ? [action.action as UiAction] : [])}`; break;
    case 'condition': text = `⑂ ${sentenceThumb(macro, (action.test as UiAction)?.image)}${escapeHtml(assetName(macro, (action.test as UiAction)?.image))} 보이면:${nested(action.then as UiAction[])} 안 보이면:${nested(action.else as UiAction[])}`; break;
    case 'repeat': text = `🔁 ${action.count}회 반복:${nested(action.actions as UiAction[])}`; break;
    case 'stop': text = `■ 중단`; break;
    default: text = escapeHtml(action.type);
  }
  const alts = (action.alt_images as string[])?.length ? ` <small>+대체${(action.alt_images as string[]).length}</small>` : '';
  return `<li><strong>${no}.</strong> ${text}${alts}</li>`;
}

function describeSteps(macro: UiMacro): string {
  const loop = (macro.loop?.count ?? 1) > 1 ? `<p>↻ 위 작업을 ${macro.loop?.count}번 반복</p>` : '';
  return `<div class="sentence-view"><ol>${describeItems(macro, macro.actions, [])}</ol>${loop}</div>`;
}

let sentenceMode = false;

// archify식 검증 영수증: 저장 전에 규칙별로 검사하고 고치는 법까지 보여준다.
interface ValidationIssue {
  step: string;
  rule: string;
  message: string;
  fix: string;
}

function walkActions(items: UiAction[] | undefined, visit: (action: UiAction, step: (string | number)[]) => void, prefix: (string | number)[] = []): void {
  (items || []).forEach((action, index) => {
    const step = [...prefix, index];
    visit(action, step);
    if (action.type === 'repeat') walkActions(action.actions as UiAction[], visit, step);
    if (action.type === 'condition') {
      if (action.test) visit(action.test as UiAction, [...step, 'test']);
      walkActions(action.then as UiAction[], visit, [...step, 'then']);
      walkActions(action.else as UiAction[], visit, [...step, 'else']);
    }
    if (action.type === 'retry' && action.action) {
      const nested = action.action as UiAction;
      visit(nested, [...step, 'action']);
      if (nested.type === 'condition') {
        if (nested.test) visit(nested.test as UiAction, [...step, 'action', 'test']);
        walkActions(nested.then as UiAction[], visit, [...step, 'action', 'then']);
        walkActions(nested.else as UiAction[], visit, [...step, 'action', 'else']);
      }
    }
  });
}

const IMAGE_TYPES = ['image_detect', 'image_wait', 'image_click', 'smart_click'];

function validateMacro(macro: UiMacro): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const stepName = (step: (string | number)[]): string => step.map((part) => typeof part === 'number' ? part + 1 : (({ test: '검사', then: '참', else: '거짓', action: '재시도' } as Record<string, string>)[part] || part)).join('.');
  walkActions(macro.actions, (action, step) => {
    if (!IMAGE_TYPES.includes(action.type)) return;
    const at = stepName(step);
    if (!action.image) issues.push({ step: at, rule: 'IMG-01', message: '기준 이미지가 비어 있습니다.', fix: '노드를 선택해 보관함에서 이미지를 고르세요.' });
    const alts = (action.alt_images as string[]) || [];
    if (alts.some((ref) => ref === action.image)) issues.push({ step: at, rule: 'IMG-02', message: '대체 이미지가 기본 이미지와 겹칩니다.', fix: '대체 이미지 선택을 바꾸거나 비우세요.' });
    if (!macro.overlay && !(action.region as UiRegion)?.width) issues.push({ step: at, rule: 'RGN-01', message: '탐색 영역이 없습니다.', fix: '오버레이를 먼저 지정하세요.' });
    if ((action.timeout_ms as number) <= 0) issues.push({ step: at, rule: 'TMO-01', message: '제한 시간이 0 이하입니다.', fix: '1ms 이상으로 설정하세요.' });
  });
  const used = new Set<string>();
  walkActions(macro.actions, (action) => {
    if (typeof action.image === 'string' && action.image) used.add(action.image);
    for (const ref of (action.alt_images as string[]) || []) used.add(ref);
    if (typeof action.expect_image === 'string' && action.expect_image) used.add(action.expect_image);
  });
  for (const asset of macro.images || []) {
    if (!used.has(asset.path)) issues.push({ step: '-', rule: 'INFO-01', message: `“${asset.name}” 이미지를 쓰는 단계가 없습니다.`, fix: '미사용이면 보관함에서 삭제할 수 있습니다.' });
  }
  return issues;
}

// archify식 포커스 추적: 선택한 노드의 조상·자손만 남기고 나머지는 흐리게 한다.
function applyTrace(): void {
  document.querySelectorAll('#flow .flow-node').forEach((node) => (node as HTMLElement).classList.remove('traced', 'dimmed'));
  if (!selPath) return;
  const parts = selPath.split('.');
  const related = new Set<string>();
  for (let i = 1; i <= parts.length; i++) related.add(parts.slice(0, i).join('.'));
  document.querySelectorAll('#flow .flow-node').forEach((node) => {
    const el = node as HTMLElement;
    const key = el.dataset.inspect as string;
    if (key === selPath) { el.classList.add('traced'); return; }
    if (related.has(key) || key.startsWith(selPath + '.')) return;
    el.classList.add('dimmed');
  });
}

function applySearch(query: string): void {
  const text = query.trim().toLowerCase();
  document.querySelectorAll('#flow .flow-node').forEach((node) => {
    const el = node as HTMLElement;
    if (!text) { el.classList.remove('search-dim'); return; }
    const body = (el.querySelector('.node-text')?.textContent || '').toLowerCase();
    el.classList.toggle('search-dim', !body.includes(text));
  });
}

function renderReceipt(macro: UiMacro, issues: ValidationIssue[]): void {
  const box = $('#receipt') as HTMLElement | null;
  if (!box) return;
  box.innerHTML = issues.length
    ? `<strong>검사 ${issues.length}건</strong><ul>${issues.map((issue) => `<li><strong>${escapeHtml(issue.step)} · ${escapeHtml(issue.rule)}</strong> ${escapeHtml(issue.message)} <small>${escapeHtml(issue.fix)}</small></li>`).join('')}</ul>`
    : '<strong>검사 통과</strong> · 실행 가능한 상태입니다.';
}

function exportReport(macro: UiMacro): void {
  const issues = validateMacro(macro);
  const rows = issues.length
    ? issues.map((issue) => `<li><strong>${escapeHtml(issue.step)} · ${escapeHtml(issue.rule)}</strong> ${escapeHtml(issue.message)} — ${escapeHtml(issue.fix)}</li>`).join('')
    : '<li>문제 없음</li>';
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escapeHtml(macro.name)} - 매크로 리포트</title><style>body{font-family:sans-serif;max-width:760px;margin:24px auto;padding:0 16px}li{margin:6px 0;line-height:1.7}img.sentence-thumb{height:28px;vertical-align:middle;margin:0 6px;border:1px solid #ccc;border-radius:4px}small{color:#777}</style></head><body><h1>${escapeHtml(macro.name)}</h1><p>${escapeHtml(macro.description || '')}</p><h2>단계</h2>${describeSteps(macro)}<h2>검사 영수증 (${issues.length}건)</h2><ul>${rows}</ul></body></html>`;
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  anchor.download = `${macro.name.replace(/[<>:"/\\|?*]/g, '_')}.html`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 5000);
  log('리포트를 다운로드했습니다.');
}
// 실행 상태 키(run.step)와 맞추기 위해 retry 자식은 부모 키를 공유한다.
function runKey(step: (string | number)[]): string {
  const clean = [...step];
  const at = clean.indexOf('action');
  if (at >= 0) clean.splice(at, 2);
  const testAt = clean.indexOf('test');
  if (testAt >= 0) clean.splice(testAt, 2);
  return clean.join('.');
}

function workflowHtml(macro: UiMacro): string {
  if (!macro.actions.length) return '<p class="empty">아래 ＋ 추가로 첫 단계를 만드세요.</p>' + addSlot('');
  return '<div class="flow-terminal">시작</div><div class="flow-link"></div>' + macro.actions.map((action, index) => nodeHtml(macro, action, [index], { container: '', index })).join('<div class="flow-link"></div>') + addSlot('') + '<div class="flow-link"></div><div class="flow-terminal">완료 · 전체 반복 설정에 따라 다시 시작</div>';
}

async function selectImage(action: UiAction): Promise<void> {
  try {
    const result = await window.americano.request('image-select');
    if (result.ok && result.path) {
      const macro = current();
      if (macro) applyAssetToAction(macro, action, result.path);
      else action.image = result.path;
      changed();
      render();
    }
  } catch (error) { log((error as Error).message); }
}

// 오버레이가 비어 있으면 게임 해상도로 자동 설정하고 테두리까지 표시한다.
async function autoOverlay(macro: UiMacro): Promise<boolean> {
  if (macro.overlay || !macro.target_window?.process_name) return true;
  log('오버레이가 없어 게임 해상도로 자동 설정합니다.');
  try {
    const result = await window.americano.request('overlay-auto', { macro });
    if (!result.ok) { log(result.error); return false; }
    Object.assign(macro, result.macro);
    changed();
    render();
    await save();
    await request('overlay-show', { macroId: macro.id });
    return true;
  } catch (error) { log((error as Error).message); return false; }
}

function moveAsset(macro: UiMacro, id: string, direction: number): boolean {
  const images = macro.images || [];
  const from = images.findIndex((image) => image.id === id);
  const to = from + direction;
  if (from < 0 || ![-1, 1].includes(direction) || to < 0 || to >= images.length) return false;
  const [asset] = images.splice(from, 1);
  images.splice(to, 0, asset);
  return true;
}

function assetPositionText(asset: UiAsset): string {
  const learned = asset.learned_roi ? ' · 자동최적화 ROI' : '';
  return `최초 (${asset.region.x}, ${asset.region.y}) · 최근 ${asset.learned_region ? `(${asset.learned_region.x}, ${asset.learned_region.y})` : '탐지 전'}${learned}`;
}

function captureStudio(macro: UiMacro): string {
  const area = macro.overlay;
  const assets = macro.images || [];
  const usages = assetUsages(macro);
  const cards = assets.map((asset, index) => {
    const uses = usages.get(asset.path) || [];
    const size = asset.region ? `${asset.region.width}×${asset.region.height}` : '';
    const useText = uses.length ? `${uses.length}개 단계 사용` : '미사용';
    return '<article class="asset-card' + (captureState.activeAsset === asset.id ? ' selected' : '') + '" data-asset-id="' + escapeHtml(asset.id) + '">'
      + '<button class="asset-select" data-op="select" title="조건에 사용할 이미지 선택"><img width="64" src="' + escapeHtml(asset.preview) + '" alt=""><span class="asset-meta"><strong>' + escapeHtml(asset.name) + '</strong><small>' + escapeHtml([size, useText].filter(Boolean).join(' · ')) + '</small><small data-position>' + escapeHtml(assetPositionText(asset)) + '</small></span>' + (captureState.activeAsset === asset.id ? '<em>✓</em>' : '') + '</button>'
      + '<div class="asset-tools"><button data-op="left" aria-label="이미지 왼쪽으로 이동" ' + (index === 0 ? 'disabled' : '') + '>←</button><button data-op="right" aria-label="이미지 오른쪽으로 이동" ' + (index === assets.length - 1 ? 'disabled' : '') + '>→</button><button data-op="rename">이름</button>' + ((asset.learned_roi || asset.learned_region || asset.learned_scale_factor) ? '<button data-op="reset-learn" title="학습된 위치·ROI·배율을 지웁니다">최적화 초기화</button>' : '') + '<button data-op="delete">삭제</button></div>'
      + '<div class="asset-rename" hidden><input maxlength="200" value="' + escapeHtml(asset.name) + '" aria-label="이미지 이름"><button data-op="rename-save">저장</button><button data-op="rename-cancel">취소</button></div>'
      + '</article>';
  }).join('');
  return '<section class="capture-studio"><h3>탐지 이미지</h3><p>찾을 기준 이미지를 캡처해 보관합니다. 실행 대상 영역이 필요하면 오버레이를 지정하세요.</p><p>' + (area ? '저장 영역: ' + area.x + ', ' + area.y + ' / ' + area.width + ' × ' + area.height : '오버레이가 아직 없습니다.') + '</p><div class="editor-actions"><button class="button ghost" id="capture-open">오버레이 영역 설정</button><button class="button ghost" id="overlay-auto">게임 해상도 자동 설정</button><button class="button ghost" id="overlay-show">저장 오버레이 표시</button><button class="button ghost" id="overlay-hide">오버레이 숨기기</button><button class="button ghost" id="capture-image" ' + (!area ? 'disabled' : '') + '>영역 안에서 이미지 캡처</button></div><p class="capture-hint">화면에서 대상을 짚으면 동작까지 한 번에 만듭니다. 캡처 후 원하는 동작을 고르고 영역을 드래그하세요.</p><div class="form-grid"><label>캡처 후 동작<select id="capture-after"><option value="">만들지 않음 (보관만)</option><option value="click">나타나면 누르기</option><option value="wait">나타날 때까지 기다리기</option><option value="branch">나타나면 눌렀는지 확인 후 분기</option></select></label></div><div class="asset-list" tabindex="0" role="region" aria-label="캡처 이미지 보관함">' + cards + '</div><div class="form-grid"><label>탐지 일치율<input id="rule-threshold" type="number" min="0" max="1" step="0.001" value="0.9"></label><label>탐지 true일 때<select id="rule-type"><option value="key">키 입력</option><option value="click">지정 좌표 클릭</option><option value="image_click">이미지 대기 클릭</option><option value="text">문자 입력</option><option value="stop">반복 중지</option></select></label></div><button class="button primary" id="add-rule" ' + (!area || !assets.length ? 'disabled' : '') + '>선택 이미지 조건 추가</button><p>조건을 추가한 뒤 아래 true / false 단계에서 실행 내용을 편집하세요.</p><div class="form-grid"><label>전체 반복 횟수 (1~10000)<input id="loop-count" type="number" min="1" max="10000" value="' + (macro.loop?.count || 1) + '"></label><label>반복 간격 (ms)<input id="loop-interval" type="number" min="30" max="60000" value="' + (macro.loop?.interval_ms || 500) + '"></label></div></section>';
}

async function bindCapture(macro: UiMacro): Promise<void> {
  const open = async (mode: string): Promise<void> => {
    if (!validFields()) return;
    captureMacroId = macro.id;
    try {
      const result = await window.americano.request('capture-overlay-open', { mode, macro });
      if (!result.ok) log(result.error);
    } catch (error) { log((error as Error).message); }
  };
  ($('#overlay-show') as HTMLButtonElement).onclick = async () => { if (dirty && !(await save())) return; await request('overlay-show', { macroId: selectedId }); };
  ($('#overlay-hide') as HTMLButtonElement).onclick = () => request('overlay-hide');
  ($('#capture-open') as HTMLButtonElement).onclick = () => open('region');
  ($('#overlay-auto') as HTMLButtonElement).onclick = async () => {
    if (!validFields()) return;
    try {
      const result = await window.americano.request('overlay-auto', { macro });
      if (!result.ok) { log(result.error); return; }
      Object.assign(macro, result.macro);
      changed();
      render();
      await save();
      await request('overlay-show', { macroId: macro.id });
    } catch (error) { log((error as Error).message); }
  };
  ($('#capture-image') as HTMLButtonElement).onclick = () => open('image');
  async function removeAsset(asset: UiAsset): Promise<void> {
    const uses = assetUsages(macro).get(asset.path) || [];
    if (uses.length) { log(`삭제할 수 없습니다. ${uses.length}개 단계(${uses.slice(0, 3).map((use) => use.step).join(', ')})에서 사용 중입니다.`); return; }
    if (!confirm(`“${asset.name}” 이미지를 삭제할까요?`)) return;
    macro.images = (macro.images || []).filter((item) => item.id !== asset.id);
    if (captureState.activeAsset === asset.id) captureState.activeAsset = macro.images[0]?.id ?? null;
    changed();
    if (!(await save())) return;
    await request('image-delete', { path: asset.path });
    render();
  }
  document.querySelectorAll('.asset-card').forEach((card) => {
    const asset = (macro.images || []).find((item) => item.id === (card as HTMLElement).dataset.assetId);
    if (!asset) return;
    const pick = (selector: string): HTMLElement => card.querySelector(selector) as HTMLElement;
    for (const [op, direction] of [['left', -1], ['right', 1]] as [string, number][]) {
      (pick(`[data-op="${op}"]`) as HTMLButtonElement).onclick = () => {
        if (!validFields() || !moveAsset(macro, asset.id, direction)) return;
        changed();
        render();
        const moved = [...document.querySelectorAll('.asset-card')].find((item) => (item as HTMLElement).dataset.assetId === asset.id);
        moved?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        (moved?.querySelector(`[data-op="${op}"]:not(:disabled)`) as HTMLButtonElement | null)?.focus({ preventScroll: true });
      };
    }
    (pick('[data-op="select"]') as HTMLButtonElement).onclick = () => { if (!validFields()) return; captureState.activeAsset = asset.id; render(); };
    (pick('[data-op="rename"]') as HTMLButtonElement).onclick = () => {
      if (!validFields()) return;
      (pick('.asset-rename') as HTMLElement).hidden = false;
      const input = pick('.asset-rename input') as HTMLInputElement;
      input.focus();
      input.select();
    };
    (pick('[data-op="rename-cancel"]') as HTMLButtonElement).onclick = () => render();
    const commitRename = (): void => {
      const name = (pick('.asset-rename input') as HTMLInputElement).value.trim();
      if (!name) { log('이미지 이름이 비어 있습니다.'); return; }
      if (name.length > 200) { log('이미지 이름은 200자 이하여야 합니다.'); return; }
      asset.name = name;
      changed();
      render();
      const uses = assetUsages(macro).get(asset.path) || [];
      log(uses.length ? `이름을 바꿨습니다. ${uses.length}개 단계의 참조는 그대로 유지됩니다.` : '이름을 바꿨습니다.');
    };
    (pick('[data-op="rename-save"]') as HTMLButtonElement).onclick = commitRename;
    (pick('.asset-rename input') as HTMLInputElement).onkeydown = (event: KeyboardEvent) => { if (event.key === 'Enter') commitRename(); if (event.key === 'Escape') render(); };
    (pick('[data-op="delete"]') as HTMLButtonElement).onclick = () => void removeAsset(asset);
    const resetButton = pick('[data-op="reset-learn"]') as HTMLButtonElement | null;
    if (resetButton) resetButton.onclick = async () => {
      try {
        const result = await window.americano.request('learn-reset', { macroId: macro.id, path: asset.path });
        if (!result.ok) { log(result.error); return; }
        asset.learned_region = null;
        asset.learned_roi = null;
        asset.learned_scale_factor = null;
        changed();
        render();
        log('자동 최적화 학습값을 초기화했습니다.');
      } catch (error) { log((error as Error).message); }
    };
  });
  ($('#add-rule') as HTMLButtonElement).onclick = () => {
    if (!validFields()) return;
    const asset = (macro.images || []).find(item => item.id === captureState.activeAsset) || macro.images[0];
    // 이미지 대기 클릭 프리셋: 나타나기를 기다렸다가 탐지된 위치를 그대로 클릭한다.
    const ruleType = (($('#rule-type') as HTMLSelectElement).value);
    const thenAction = ruleType === 'image_click'
      ? buildPointedAction(macro, asset, 'click', Number((($('#rule-threshold') as HTMLInputElement).value)))
      : defaults(ruleType);
    macro.actions.push({ type: 'condition', test: { ...defaults('image_detect'), image: asset.path, region: structuredClone(macro.overlay), threshold: Number((($('#rule-threshold') as HTMLInputElement).value)), ...(roiFromAsset(macro, asset) ? { roi: roiFromAsset(macro, asset) } : {}) }, then: [thenAction], else: [] });
    changed();
    render();
  };
  for (const [id, field] of [['loop-count', 'count'], ['loop-interval', 'interval_ms']]) {
    (($('#' + id) as HTMLInputElement)).oninput = event => { macro.loop ||= { count: 1, interval_ms: 500 }; (macro.loop as Record<string, number>)[field] = Number((event.target as HTMLInputElement).value); changed(); };
  }
  (($('#utterance-build') as HTMLButtonElement)).onclick = () => {
    if (!validFields()) return;
    const { actions, warnings } = parseUtterances((($('#utterances') as HTMLTextAreaElement).value), macro);
    if (!actions.length && warnings.length) { showUtteranceResult([], warnings); return; }
    macro.actions.push(...actions);
    changed();
    render();
    log(warnings.length ? `동작 ${actions.length}개를 만들었습니다. ${warnings.join(' ')}` : `동작 ${actions.length}개를 만들었습니다. 순서도 맨 아래에서 확인하세요.`);
  };
  (($('#utterance-ai') as HTMLButtonElement)).onclick = async () => {
    if (!validFields()) return;
    const text = ((($('#utterances') as HTMLTextAreaElement).value)).trim();
    if (!text) { log('만들 동작을 먼저 적으세요.'); return; }
    log('AI가 동작을 만들고 있습니다...');
    try {
      const result = await window.americano.request('ai-generate', { text, macroId: selectedId, images: (macro.images || []).map((asset) => asset.name), overlay: macro.overlay });
      if (!result.ok) { log(result.error); return; }
      macro.actions.push(...result.actions);
      changed();
      render();
      showUtteranceResult(result.actions, result.warnings || []);
      log(`AI가 동작 ${result.actions.length}개를 만들었습니다.`);
    } catch (error) { log((error as Error).message); }
  };
  try {
    const config = await window.americano.request('ai-get');
    if (config?.ok === false && config?.error) { log(config.error); }
    else if (config) {
      (($('#ai-model') as HTMLInputElement)).value = config.model || '';
      (($('#ai-agent') as HTMLInputElement)).value = config.agent || '';
    }
  } catch (error) { log((error as Error).message); }
  (($('#ai-save') as HTMLButtonElement)).onclick = async () => {
    try {
      const result = await window.americano.request('ai-set', {
        model: (($('#ai-model') as HTMLInputElement)).value.trim(),
        agent: (($('#ai-agent') as HTMLInputElement)).value.trim(),
      });
      if (!result.ok) { log(result.error); return; }
      log('AI 설정을 저장했습니다.');
    } catch (error) { log((error as Error).message); }
  };
  (($('#ai-test') as HTMLButtonElement)).onclick = async () => {
    log('AI 서버에 연결 중...');
    try {
      const result = await window.americano.request('ai-test');
      log(result.ok ? `연결 성공: ${result.model}` : result.error);
    } catch (error) { log((error as Error).message); }
  };
  (($('#opencode-start') as HTMLButtonElement)).onclick = async () => {
    log('내장 서버를 시작합니다...');
    try {
      const result = await window.americano.request('ai-server-start');
      if (!result.ok) { log(result.error); return; }
      log(`서버 시작: ${result.version} (${result.url})`);
      await refreshOpencode();
    } catch (error) { log((error as Error).message); }
  };
  (($('#opencode-refresh') as HTMLButtonElement)).onclick = () => void refreshOpencode();
  await refreshOpencode();
}

let loginPollTimer: ReturnType<typeof setInterval> | null = null;

async function refreshOpencode(): Promise<void> {
  const statusBox = $('#opencode-status') as HTMLElement | null;
  const listBox = $('#provider-list') as HTMLElement | null;
  if (!statusBox || !listBox) return;
  try {
    const status = await window.americano.request('ai-server');
    if (!status?.running) {
      statusBox.innerHTML = '<small>내장 서버 중지됨. [내장 서버 시작]을 누르세요.</small>';
      listBox.innerHTML = '';
      return;
    }
    statusBox.innerHTML = `<small>서버 실행 중 · ${escapeHtml(status.version)}${status.managed ? ' (내장)' : ' (외부)'}</small>`;
    const result = await window.americano.request('ai-providers');
    if (!result.ok) { listBox.innerHTML = `<small>${escapeHtml(result.error)}</small>`; return; }
    const models: string[] = [];
    listBox.innerHTML = (result.providers || []).map((provider: any) => {
      const id = escapeHtml(provider.id);
      if (provider.connected && provider.defaultModel) models.push(`${provider.id}/${provider.defaultModel}`);
      const methods = (provider.methods || []).map((method: any) => {
        if (provider.connected) return '';
        if (method.type === 'oauth') return `<button data-login-oauth="${id}">로그인</button>`;
        const fields = (method.prompts || []).map((prompt: any) =>
          `<input data-key-field="${escapeHtml(prompt.key)}" type="password" placeholder="${escapeHtml(prompt.message || prompt.key)}" aria-label="${escapeHtml(prompt.key)}">`).join('');
        return `<span>${escapeHtml(method.label)}: ${fields}<button data-login-key="${id}">키 저장</button></span>`;
      }).join(' ');
      const pending = pendingLogin;
      const code = pending && pending.providerID === provider.id && pending.method === 'code'
        ? `<span><input id="oauth-code" placeholder="브라우저에 표시된 코드"> <button id="oauth-finish">입력 완료</button></span>` : '';
      return `<div class="provider-row" data-provider="${id}"><strong>${escapeHtml(provider.name)}</strong> ${provider.connected ? '<em>연결됨</em>' : '<small>미연결</small>'} ${methods} ${code}</div>`;
    }).join('');
    const datalist = $('#ai-model-list') as HTMLElement | null;
    if (datalist) datalist.innerHTML = models.map((model) => `<option value="${escapeHtml(model)}">`).join('');
    listBox.querySelectorAll('[data-login-oauth]').forEach((button) => {
      (button as HTMLButtonElement).onclick = () => void startProviderLogin((button as HTMLElement).dataset.loginOauth as string);
    });
    listBox.querySelectorAll('[data-login-key]').forEach((button) => {
      (button as HTMLButtonElement).onclick = async () => {
        const row = (button as HTMLElement).closest('.provider-row') as HTMLElement;
        const providerID = row.dataset.provider as string;
        const fields: Record<string, string> = {};
        row.querySelectorAll('[data-key-field]').forEach((input) => {
          fields[(input as HTMLElement).dataset.keyField as string] = (input as HTMLInputElement).value;
        });
        try {
          const result = await window.americano.request('ai-key-set', { providerID, fields });
          log(result.ok ? (result.connected ? `${providerID} 연결됨` : '저장했으나 미연결입니다.') : result.error);
          await refreshOpencode();
        } catch (error) { log((error as Error).message); }
      };
    });
    const finish = $('#oauth-finish') as HTMLButtonElement | null;
    if (finish) finish.onclick = async () => {
      const pending = pendingLogin;
      const code = (($('#oauth-code') as HTMLInputElement)).value.trim();
      if (!code || !pending) return;
      try {
        const result = await window.americano.request('ai-login-finish', { providerID: pending.providerID, code });
        pendingLogin = null;
        log(result.ok && result.connected ? '로그인 완료' : (result.error || '미연결입니다.'));
        await refreshOpencode();
      } catch (error) { log((error as Error).message); }
    };
  } catch (error) { statusBox.innerHTML = `<small>${escapeHtml((error as Error).message)}</small>`; }
}

let pendingLogin: { providerID: string; method: string } | null = null;

async function startProviderLogin(providerID: string): Promise<void> {
  if (loginPollTimer) { clearInterval(loginPollTimer); loginPollTimer = null; }
  try {
    const result = await window.americano.request('ai-login-start', { providerID });
    if (!result.ok) { log(result.error); return; }
    log(`브라우저에서 로그인을 마치세요. ${result.instructions || ''}`);
    pendingLogin = { providerID, method: result.method || 'auto' };
    if (pendingLogin.method === 'code') { await refreshOpencode(); return; }
    let tries = 0;
    loginPollTimer = setInterval(async () => {
      tries += 1;
      try {
        const poll = await window.americano.request('ai-login-poll', { providerID });
        if (poll?.connected) {
          if (loginPollTimer) clearInterval(loginPollTimer);
          loginPollTimer = null;
          pendingLogin = null;
          log(`${providerID} 로그인 완료`);
          await refreshOpencode();
        } else if (tries >= 100) {
          if (loginPollTimer) clearInterval(loginPollTimer);
          loginPollTimer = null;
          pendingLogin = null;
          log('로그인 대기 시간이 끝났습니다. 다시 시도하세요.');
        }
      } catch (error) { log((error as Error).message); }
    }, 3000);
  } catch (error) { log((error as Error).message); }
}

function showUtteranceResult(actions: UiAction[], warnings: string[]): void {
  const box = $('#utterance-result') as HTMLElement | null;
  if (!box) return;
  box.innerHTML = (actions.length ? `<p>생성된 동작 ${actions.length}개</p>` : '') + (warnings.length ? `<ul>${warnings.map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul>` : '');
}

function bindCanvas(macro: UiMacro): void {
  const viewport = $('#flow-viewport') as HTMLElement;
  const flow = $('#flow') as HTMLElement;
  const view = canvasViews.get(macro.id) || { zoom: 1, x: 0, y: 0 };
  canvasViews.set(macro.id, view);
  const apply = (zoom: number): void => {
    const old = view.zoom;
    view.zoom = Math.max(0.1, Math.min(2, zoom));
    flow.style.setProperty('zoom', String(view.zoom));
    viewport.scrollLeft = view.x * view.zoom / old;
    viewport.scrollTop = view.y * view.zoom / old;
    view.x = viewport.scrollLeft;
    view.y = viewport.scrollTop;
    ($('#canvas-scale') as HTMLElement).textContent = Math.round(view.zoom * 100) + '%';
  };
  apply(view.zoom);
  viewport.onscroll = () => { view.x = viewport.scrollLeft; view.y = viewport.scrollTop; };
  (($('#canvas-in') as HTMLButtonElement)).onclick = () => apply(view.zoom * 1.2);
  (($('#canvas-out') as HTMLButtonElement)).onclick = () => apply(view.zoom / 1.2);
  (($('#canvas-reset') as HTMLButtonElement)).onclick = () => apply(1);
  (($('#canvas-fit') as HTMLButtonElement)).onclick = () => {
    apply(1);
    apply(Math.min(1, (viewport.clientWidth - 32) / flow.offsetWidth, (viewport.clientHeight - 32) / flow.offsetHeight));
    // Intrinsic text widths can change slightly at fractional zoom levels.
    for (let i = 0; i < 3 && viewport.scrollWidth > viewport.clientWidth; i++) {
      apply(view.zoom * (viewport.clientWidth - 16) / viewport.scrollWidth);
    }
    viewport.scrollLeft = viewport.scrollTop = 0;
    view.x = view.y = 0;
  };
  viewport.addEventListener('wheel', (event: WheelEvent) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    apply(view.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });
  let pan: { x: number; y: number; left: number; top: number } | null = null;
  viewport.onpointerdown = (event: PointerEvent) => {
    if (event.button !== 0 || (event.target as Element).closest('.flow-node, .flow-add, button, input, select')) return;
    pan = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('panning');
    event.preventDefault();
  };
  viewport.onpointermove = (event: PointerEvent) => {
    if (!pan) return;
    viewport.scrollLeft = pan.left - event.clientX + pan.x;
    viewport.scrollTop = pan.top - event.clientY + pan.y;
  };
  viewport.onpointerup = viewport.onpointercancel = viewport.onlostpointercapture = () => { pan = null; viewport.classList.remove('panning'); };
}

function render(): void {
  const assetScroll = (document.querySelector('.asset-list') as HTMLElement | null)?.scrollLeft || 0;
  renderMacroSwitch();
  const macro = current();
  if (!macro) {
    ($('#editor') as HTMLElement).innerHTML = '<div class="welcome"><p class="eyebrow">시작하기</p><h2>첫 매크로를 만들어 보세요</h2><p>이름과 대상 앱을 지정하고, 실행할 동작을 순서대로 추가하세요. 설정은 앱이 관리합니다.</p><ol><li>매크로 이름과 대상 앱 설정</li><li>워크플로우에 동작 노드 추가</li><li>저장 후 미리보기로 순서 확인</li></ol><button id="first-macro" class="button primary">첫 매크로 만들기</button></div>';
    (($('#first-macro') as HTMLButtonElement)).onclick = createMacro;
    if (backend) update(backend);
    return;
  }
  if (!selectedAction(macro)) selPath = null;
  ($('#editor') as HTMLElement).innerHTML = `<div class="macro-head"><div><p class="eyebrow">WORKFLOW</p><h3><input id="macro-name" maxlength="100" value="${escapeHtml(macro.name)}" aria-label="매크로 이름"></h3></div><div class="actions"><button id="save" class="button primary">저장</button><button id="validate" class="button ghost">검사</button><button id="report" class="button ghost">리포트</button><button id="run" class="button danger">실행</button><button id="preview" class="button ghost">입력 없이 미리보기</button><button id="progress-toggle" class="button ghost">진행 오버레이</button><button id="export-macro" class="button ghost">내보내기</button><button id="import-macro" class="button ghost">가져오기</button></div></div>
    <div id="receipt" aria-label="검사 영수증"></div>
    <section class="utterance-panel"><h3>말로 만들기</h3><label>하고 싶은 일<textarea id="utterances" rows="3" placeholder="예:&#10;시작 버튼을 누르기&#10;완료될 때까지 기다리기 · 최대 30초&#10;확인 누르기&#10;10번 반복"></textarea></label><div class="utterance-actions"><button id="utterance-build" class="button primary">로컬 규칙으로 만들기</button><button id="utterance-ai" class="button ghost">AI로 만들기</button></div><div id="utterance-result" aria-label="생성 결과"></div><details class="ai-settings"><summary>AI 설정 (opencode 로그인)</summary><div id="opencode-status"><small>확인 중...</small></div><div class="utterance-actions"><button id="opencode-start" class="button ghost">내장 서버 시작</button><button id="opencode-refresh" class="button ghost">공급자 새로고침</button></div><div id="provider-list"></div><div class="form-grid"><label>모델<input id="ai-model" list="ai-model-list" placeholder="opencode-go/gpt-5.6-luna"><datalist id="ai-model-list"></datalist></label><label>에이전트(선택)<input id="ai-agent" placeholder="비우면 기본"></label></div><div class="utterance-actions"><button id="ai-save" class="button ghost">AI 설정 저장</button><button id="ai-test" class="button ghost">연결 테스트</button></div><small>로그인은 위 공급자 목록에서 하세요. 나가는 것은 입력 문장과 보관함 이름뿐입니다.</small></details></section>
    <div class="target-row"><div><p class="eyebrow">TARGET WINDOW</p><strong>실행 대상 창</strong><small id="target-status">창 목록을 불러오지 않았습니다.</small></div><div class="target-controls"><select id="target-window" aria-label="실행 대상 창"><option value="">창을 선택하세요</option>${macro.target_window.title_contains ? `<option value="current" selected>${escapeHtml(macro.target_window.process_name || '')} · ${escapeHtml(macro.target_window.title_contains)}</option>` : ''}</select><button id="refresh-windows" type="button" class="button ghost">창 새로고침</button><select id="input-mode" aria-label="입력 방식" title="전경 입력은 커서를 점유하고, 백그라운드 입력은 창에 직접 전달해 PC를 같이 쓸 수 있습니다(일부 게임 미지원)"><option value="foreground">전경 입력</option><option value="background">백그라운드 입력</option></select></div><div class="target-meta"><span>프로세스 ${escapeHtml(macro.target_window.process_name || '-')}</span><span>제목 ${escapeHtml(macro.target_window.title_contains || '-')}</span></div></div>
    <div class="studio-flow">${captureStudio(macro)}<div class="flow-col"><div class="work-area"><section class="workflow"><div class="section-heading"><h3>순서도 편집</h3><small>노드를 선택해 편집 · ⠿ 끌어 이동</small><input id="node-search" type="search" placeholder="/ 단계 검색" aria-label="단계 검색"><button id="sentence-toggle" class="button ghost">문장 보기</button></div><div class="canvas-tools"><button id="canvas-out" aria-label="축소">−</button><output id="canvas-scale">100%</output><button id="canvas-in" aria-label="확대">＋</button><button id="canvas-fit">전체 보기</button><button id="canvas-reset">100%</button><small>빈 공간을 끌어 이동 · Ctrl + 휠로 확대/축소</small></div><div id="flow-viewport" tabindex="0" aria-label="순서도 캔버스"><div id="flow">${workflowHtml(macro)}</div></div></section><aside id="inspector" aria-label="노드 편집"></aside></div></div></div>
    <section class="portable-panel"><p>설정과 이미지가 함께 들어 있는 .amacro 파일로 주고받습니다.</p>${macro.binding ? `<p>${macro.binding.needs_overlay ? '가져오기 완료: 대상 창을 확인하고 오버레이를 재지정하세요.' : '오버레이 연결 완료'}${macro.binding.needs_review ? ' · 이미지 크기와 창 기준 좌표를 검토해야 합니다.' : ''}</p>${macro.binding.needs_review && !macro.binding.needs_overlay ? '<button id="binding-reviewed">이미지와 좌표 검토 완료</button>' : ''}` : ''}</section>`;
  (($('#macro-name') as HTMLInputElement)).oninput = (event) => { macro.name = ((event.target as HTMLInputElement).value); changed(); renderMacroSwitch(); };
  (($('#target-window') as HTMLSelectElement)).onchange = async (event) => {
    if (!validFields()) { render(); return; }
    if ((event.target as HTMLSelectElement).value === 'current') return;
    const item = ((event.target as HTMLSelectElement & { _windows?: { title: string; process_name: string; executable_path: string }[] })._windows)?.[Number((event.target as HTMLSelectElement).value)];
    if (!item) return;
    macro.target_window = { title_contains: item.title, process_name: item.process_name, executable_path: item.executable_path };
    if (macro.overlay) { macro.binding = { needs_overlay: true, needs_review: macro.binding?.needs_review || false, source_overlay: macro.overlay }; }
    macro.overlay = null;
    changed();
    render();
    await autoOverlay(macro);
  };
  (($('#refresh-windows') as HTMLButtonElement)).onclick = () => refreshWindows(macro);
  (($('#input-mode') as HTMLSelectElement)).value = macro.input_mode === 'background' ? 'background' : 'foreground';
  (($('#input-mode') as HTMLSelectElement)).onchange = (event) => {
    macro.input_mode = ((event.target as HTMLSelectElement).value === 'background' ? 'background' : 'foreground');
    changed();
  };
  bindCapture(macro).catch((error: unknown) => log(`바인딩 오류: ${(error as Error).message}`));
  (document.querySelector('.asset-list') as HTMLElement).scrollLeft = assetScroll;
  (($('#save') as HTMLButtonElement)).onclick = save;
  (($('#validate') as HTMLButtonElement)).onclick = () => {
    const issues = validateMacro(macro);
    renderReceipt(macro, issues);
    log(issues.length ? `검사 ${issues.length}건을 확인하세요.` : '검사 통과. 실행 가능한 상태입니다.');
  };
  (($('#report') as HTMLButtonElement)).onclick = () => exportReport(macro);
  (($('#export-macro') as HTMLButtonElement)).onclick = async () => {
    if (dirty && !(await save())) return;
    const result = await window.americano.request('macro-export', { macroId: selectedId });
    log(result.ok ? (result.canceled ? '내보내기를 취소했습니다.' : '설정과 이미지를 내보냈습니다.') : result.error);
  };
  (($('#import-macro') as HTMLButtonElement)).onclick = async () => {
    if (saving || (dirty && !(await save()))) return;
    ($('#editor') as HTMLElement).inert = true;
    try {
      const result = await window.americano.request('macro-import');
      if (!result.ok) { log(result.error); return; }
      if (result.canceled) return;
      documentData = result.state.document;
      selectedId = result.macroId;
      dirty = false;
      render();
      log('가져왔습니다. 대상 창을 확인한 뒤 오버레이를 재지정하세요.');
      await autoOverlay(documentData.macros.find((item) => item.id === selectedId) as UiMacro);
    } catch (error) { log((error as Error).message); }
    finally { ($('#editor') as HTMLElement).inert = false; }
  };
  if ($('#binding-reviewed')) (($('#binding-reviewed') as HTMLButtonElement)).onclick = () => { (macro.binding as { needs_review: boolean }).needs_review = false; changed(); render(); };
  (($('#run') as HTMLButtonElement)).onclick = startSelected;
  (($('#preview') as HTMLButtonElement)).onclick = () => preview(0);
  (($('#progress-toggle') as HTMLButtonElement)).onclick = async () => {
    try {
      const result = await window.americano.request('progress-toggle', { macroId: selectedId });
      if (result.state) update(result.state);
      log(result.ok ? (result.open ? '진행 오버레이를 열었습니다.' : '진행 오버레이를 닫았습니다.') : result.error);
    } catch (error) { log((error as Error).message); }
  };
  bindWorkflow(macro);
  bindCanvas(macro);
  sentenceMode = false;
  (($('#sentence-toggle') as HTMLButtonElement)).onclick = () => {
    sentenceMode = !sentenceMode;
    (($('#sentence-toggle') as HTMLButtonElement)).textContent = sentenceMode ? '순서도 보기' : '문장 보기';
    ($('#flow') as HTMLElement).innerHTML = sentenceMode ? describeSteps(macro) : workflowHtml(macro);
    if (!sentenceMode) bindWorkflow(macro);
  };
  renderInspector(macro);
  if (backend) update(backend);
}

async function refreshWindows(macro: UiMacro): Promise<void> {
  const select = $('#target-window') as HTMLSelectElement & { _windows?: { title: string; process_name: string }[] };
  const status = $('#target-status') as HTMLElement;
  select.disabled = true;
  status.textContent = '창 검색 중...';
  try {
    const result = await window.americano.request('window-list');
    if (!result.ok) throw new Error(result.error);
    const unique = result.windows;
    select._windows = unique;
    select.innerHTML = (macro.target_window.title_contains ? `<option value="current" selected>${escapeHtml(macro.target_window.process_name || '')} · ${escapeHtml(macro.target_window.title_contains)} (현재)</option>` : '<option value="">창을 선택하세요</option>') + unique.map((item: { title: string; process_name: string }, index: number) => `<option value="${index}" ${item.title === macro.target_window.title_contains ? 'selected' : ''}>${escapeHtml(item.process_name)} · ${escapeHtml(item.title)}</option>`).join('');
    status.textContent = `${unique.length}개 창을 찾았습니다.`;
  } catch (error) { status.textContent = (error as Error).message; }
  finally { select.disabled = false; }
}

function validFields(): boolean {
  const invalid = ($('#editor') as HTMLElement).querySelector(':invalid') as HTMLElement | null;
  if (invalid) { (invalid as HTMLInputElement).reportValidity(); return false; }
  return true;
}

function countSteps(items: UiAction[]): number {
  return items.reduce((total, action) => total + 1 + (action.type === 'repeat' ? countSteps(action.actions as UiAction[]) : action.type === 'condition' ? 1 + countSteps(action.then as UiAction[]) + countSteps(action.else as UiAction[]) : action.type === 'retry' ? 1 : 0), 0);
}

// 자산 경로 -> 사용하는 단계 목록. 삭제 가드와 사용처 표시에 쓴다.
function assetUsages(macro: UiMacro): Map<string, { step: string; type: string }[]> {
  const usages = new Map<string, { step: string; type: string }[]>();
  const push = (ref: unknown, step: (string | number)[], type: string): void => {
    if (typeof ref !== 'string' || !ref) return;
    if (!usages.has(ref)) usages.set(ref, []);
    (usages.get(ref) as { step: string; type: string }[]).push({ step: step.map((part) => typeof part === 'number' ? part + 1 : (({ test: '검사', then: '참', else: '거짓', action: '재시도' } as Record<string, string>)[part] || part)).join('.'), type });
  };
  const visit = (items: UiAction[] | undefined, prefix: (string | number)[] = []): void => {
    (items || []).forEach((action, index) => {
      const step = [...prefix, index];
      for (const field of ['image', 'expect_image']) if (typeof action[field] === 'string') push(action[field], step, action.type);
      if (Array.isArray(action.alt_images)) for (const ref of action.alt_images as string[]) push(ref, step, action.type);
      if (action.type === 'repeat' && Array.isArray(action.actions)) visit(action.actions as UiAction[], step);
      if (action.type === 'condition') {
        if (action.test) visit([action.test as UiAction], [...step, 'test']);
        visit(action.then as UiAction[] || [], [...step, 'then']);
        visit(action.else as UiAction[] || [], [...step, 'else']);
      }
      if (action.type === 'retry' && action.action) visit([action.action as UiAction], [...step, 'action']);
    });
  };
  visit(macro.actions || []);
  return usages;
}

async function save(): Promise<boolean> {
  if (saving || !validFields()) return false;
  saving = true;
  ($('#editor') as HTMLElement).inert = true;
  // Freeze editing until this snapshot has been acknowledged, preventing lost edits.
  const controls = [...document.querySelectorAll('#editor input, #editor textarea, #editor select, #editor button, #macro-select, #new-button, #duplicate-button, #delete-button')] as (HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement)[];
  const disabled = controls.map((control) => control.disabled);
  controls.forEach((control) => { control.disabled = true; });
  const state = await request('save', { document: documentData });
  saving = false;
  ($('#editor') as HTMLElement).inert = false;
  controls.forEach((control, index) => { control.disabled = disabled[index]; });
  if (!state) return false;
  documentData = state.document;
  dirty = false;
  render();
  log('암호화 저장했습니다.');
  return true;
}

async function preview(startIndex: number): Promise<void> {
  if (dirty && !(await save())) return;
  await request('preview', { macroId: selectedId, startIndex });
}

async function startSelected(): Promise<void> {
  if (!selectedId) { log('시작할 매크로를 선택하세요.'); return; }
  if (dirty && !(await save())) return;
  const state = await request('start', { macroId: selectedId, startIndex: 0 });
  if (state) {
    try { await window.americano.request('progress-toggle', { macroId: selectedId, open: true }); }
    catch { /* 진행 오버레이 자동 열기 실패는 무시한다. */ }
  }
}

function createMacro(): void {
  if (saving || !backend?.storageReady || !validFields()) return;
  const macro: UiMacro = { id: crypto.randomUUID(), name: '새 매크로', description: '', script: '', enabled: true, hotkey: '', target_window: {}, images: [], actions: [], overlay: null };
  documentData.macros.push(macro);
  selectedId = macro.id;
  changed();
  render();
  selPath = null;
  const nameInput = $('#macro-name') as HTMLInputElement | null;
  if (nameInput) { nameInput.focus(); nameInput.select(); }
}

(($('#new-button') as HTMLButtonElement)).onclick = createMacro;
(($('#macro-select') as HTMLSelectElement)).onchange = (event) => {
  if (!validFields()) { renderMacroSwitch(); return; }
  selectedId = (event.target as HTMLSelectElement).value || null;
  selPath = null;
  render();
};
(($('#duplicate-button') as HTMLButtonElement)).onclick = () => {
  const macro = current();
  if (!macro || !validFields()) return;
  const copy = structuredClone(macro);
  copy.id = crypto.randomUUID();
  copy.name += ' 복사';
  copy.hotkey = '';
  documentData.macros.push(copy);
  selectedId = copy.id;
  selPath = null;
  changed();
  render();
};
(($('#delete-button') as HTMLButtonElement)).onclick = () => {
  const macro = current();
  if (!macro) return;
  if (!confirm(`“${macro.name}” 매크로를 삭제할까요?`)) return;
  documentData.macros = documentData.macros.filter((item) => item.id !== selectedId);
  selectedId = documentData.macros[0]?.id ?? null;
  selPath = null;
  changed();
  render();
  void save();
};
(($('#start-button') as HTMLButtonElement)).onclick = startSelected;
(($('#pause-button') as HTMLButtonElement)).onclick = () => request('pause');
(($('#stop-button') as HTMLButtonElement)).onclick = () => request('stop');
window.americano.onStartHotkey(startSelected);
(($('#license-import') as HTMLButtonElement)).onclick = () => request('license-import');
(($('#license-check') as HTMLButtonElement)).onclick = async () => { const state = await request('license-check'); if (state) log('실행 권한 확인 성공: 서명, MAC, 유효기간, 기능 권한이 모두 유효합니다. 실제 입력은 수행하지 않았습니다.'); };
(($('#license-device-button') as HTMLButtonElement)).onclick = async () => {
  try {
    const result = await window.americano.request('license-device');
    if (!result.ok) { log(result.error); return; }
    ($('#license-device') as HTMLElement).textContent = result.macs.length ? result.macs.join(' / ') : '사용 가능한 MAC 주소가 없습니다.';
  }
  catch (error) { log((error as Error).message); }
};
function closeLicenseDialog(): void { (($('#license-dialog') as HTMLElement)).hidden = true; }
(($('#license-open') as HTMLButtonElement)).onclick = () => { (($('#license-dialog') as HTMLElement)).hidden = false; (($('#license-close') as HTMLButtonElement)).focus(); };
(($('#license-close') as HTMLButtonElement)).onclick = closeLicenseDialog;
(($('#license-dialog') as HTMLElement)).onclick = (event) => { if (event.target === $('#license-dialog')) closeLicenseDialog(); };
window.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Escape' && !(($('#license-dialog') as HTMLElement)).hidden) closeLicenseDialog();
  const target = event.target as HTMLElement | null;
  const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
  if (event.key === '/' && !typing) {
    const search = $('#node-search') as HTMLInputElement | null;
    if (search) { event.preventDefault(); search.focus(); }
  }
});
window.americano.onState(update);
if (window.americano.onCaptureResult) window.americano.onCaptureResult(async (result: any) => {
  if (!result.ok) { log(`이미지를 저장하지 못했습니다: ${result.error}`); return; }
  const macro = documentData.macros.find((item) => item.id === (result.macroId || captureMacroId));
  if (!macro) { log('캡처 결과를 받을 매크로를 찾지 못했습니다.'); return; }
  if (result.mode === 'region') {
    const rebound = await window.americano.request('overlay-rebind', { macro, region: result.region });
    if (!rebound.ok) { log(rebound.error); return; }
    Object.assign(macro, rebound.macro);
    changed();
    render();
    await save();
    await request('overlay-show', { macroId: macro.id });
    return;
  }
  macro.images = macro.images || [];
  const asset: UiAsset = { id: crypto.randomUUID(), name: `영역 ${macro.images.length + 1}`, path: result.path, preview: result.preview, region: result.region, learned_region: null, learned_roi: null, learned_scale_factor: null };
  macro.images.push(asset);
  captureState.activeAsset = asset.id;
  // 화면에서 짚어 만들기: 캡처와 동시에 동작 카드까지 생성한다.
  const after = (document.querySelector('#capture-after') as HTMLSelectElement | null)?.value;
  if (after && macro.overlay) {
    macro.actions.push(buildPointedAction(macro, asset, after, 0.9));
    log(`“${asset.name}” 대상으로 동작을 만들었습니다. 순서도 맨 아래에서 확인하세요.`);
  }
  changed();
  render();
  void save();
});
request('state').then((state) => { if (!state) return; documentData = state.document; selectedId = documentData.macros[0]?.id ?? null; render(); log(state.error || '로컬 암호화 저장소를 불러왔습니다.'); });
