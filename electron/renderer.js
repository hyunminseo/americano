const $ = (selector) => document.querySelector(selector);
let documentData = { version: 2, macros: [] };
let selectedId = null;
let dirty = false;
let backend;
let saving = false;
let captureMacroId = null;
let captureState = { activeAsset: null };
let selPath = null;
const typeIcons = { wait: '⏳', key: '⌨', text: '✎', mouse_move: '➤', click: '◉', scroll: '⇅', image_detect: '◌', image_wait: '◎', image_click: '🎯', smart_click: '🧠', retry: '↻', condition: '⑂', repeat: '🔁', stop: '■' };
function assetName(macro, ref) {
  if (!ref) return '이미지 없음';
  const found = (macro.images || []).find((asset) => asset.path === ref);
  if (found) return found.name;
  return String(ref).split(/[/\\]/).at(-1);
}
function nodeSubtitle(macro, action) {
  switch (action.type) {
    case 'key': return action.keys || '';
    case 'text': return (action.text || '').slice(0, 24);
    case 'wait': return `${action.duration_ms}ms`;
    case 'click': case 'mouse_move': return `${action.coordinate_space === 'overlay' ? '오버레이' : '창'} ${action.x},${action.y}`;
    case 'image_detect': case 'image_wait': case 'image_click': case 'smart_click':
      return [assetName(macro, action.image), action.threshold].filter((part) => part !== '' && part !== undefined).join(' · ');
    case 'repeat': return `×${action.count}회`;
    case 'retry': return `최대 ${action.count}회 재시도`;
    case 'condition': return assetName(macro, action.test?.image);
    case 'scroll': return `${action.delta_x},${action.delta_y}`;
    default: return '';
  }
}
// 편집 경로("4.0", "5.then.0", "3.action.0")를 부모 배열과 인덱스로 푼다.
function resolvePath(macro, key) {
  const parts = String(key).split('.');
  let items = macro.actions;
  for (let i = 0; i < parts.length - 1; i++) {
    const node = items[Number(parts[i])];
    const marker = parts[i + 1];
    if (node?.type === 'repeat') items = node.actions;
    else if (node?.type === 'condition' && marker === 'test') { items = [node.test]; i += 1; }
    else if (node?.type === 'condition' && (marker === 'then' || marker === 'else')) { items = node[marker]; i += 1; }
    else if (node?.type === 'retry' && marker === 'action') { items = [node.action]; i += 1; }
    else throw new Error('잘못된 단계 경로입니다.');
  }
  const index = Number(parts.at(-1));
  if (!items || !Number.isInteger(index) || !items[index]) throw new Error('단계를 찾지 못했습니다.');
  return { items, index, action: items[index] };
}
function moveStep(macro, key, dir) {
  if (String(key).split('.').includes('test')) return false;
  const { items, index } = resolvePath(macro, key);
  const target = index + dir;
  if (target < 0 || target >= items.length) return false;
  [items[index], items[target]] = [items[target], items[index]];
  return true;
}
function containerItems(macro, containerKey) {
  if (!containerKey) return macro.actions;
  const parts = containerKey.split('.');
  const last = parts.at(-1);
  if (/^\d+$/.test(last)) {
    const { action } = resolvePath(macro, containerKey);
    if (action?.type !== 'repeat') throw new Error('단계를 추가할 수 없는 위치입니다.');
    return action.actions;
  }
  const node = resolvePath(macro, parts.slice(0, -1).join('.')).action;
  if (node?.type === 'condition' && (last === 'then' || last === 'else')) return node[last];
  throw new Error('단계를 추가할 수 없는 위치입니다.');
}
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const current = () => documentData.macros.find((macro) => macro.id === selectedId);
const log = (message) => { $('#log-line').textContent = message; };
function changed() { dirty = true; log('저장하지 않은 변경사항이 있습니다.'); }
async function request(command, payload = {}) {
  try {
    const result = await window.americano.request(command, payload);
    if (result.state) update(result.state);
    if (!result.ok) { log(result.error); return null; }
    return result.state;
  } catch (error) { log(error.message); return null; }
}
function update(state) {
  backend = state;
  if (state.license) {
    $('#license-status').textContent = state.license.message;
    $('#license-status').className = state.license.valid ? 'license-valid' : 'license-invalid';
    const variantName = { 'mac-match': '내 MAC 비교 빌드', 'mac-mismatch': '가상 MAC 비교 빌드', standard: '일반 빌드' }[state.variant] || '일반 빌드';
    $('#license-detail').textContent = [variantName, state.license.issuedTo, state.license.expiresAt ? `만료: ${new Date(state.license.expiresAt).toLocaleString()}` : '', state.license.code].filter(Boolean).join(' · ');
    $('#license-summary').textContent = state.license.valid ? '활성' : '미등록';
    $('#license-dot').style.color = state.license.valid ? '#2f7d33' : '#b91c1c';
  }
  const run = state.run;
  const labels = { STOPPED: '대기', RUNNING: run.preview ? '미리보기 실행 중' : '실행 중', PAUSED: '일시정지', ERROR: '실행 오류' };
  $('#status-label').textContent = labels[run.status] || run.status;
  $('#runtime-copy').textContent = `${run.macroId ? (documentData.macros.find((item) => item.id === run.macroId)?.name || run.macroId) : '실행 대기'}${run.step ? ` · 단계 ${run.step.map((part) => typeof part === 'number' ? part + 1 : ({test:'검사',then:'true',else:'false'}[part] || part)).join('.')}` : ''} · 반복 ${run.iteration || 0}/${run.iterations || 1} · 탐지 ${run.matched == null ? '대기' : run.matched} · 완료 ${run.completed}회`;
  $('#pause-button').disabled = !['RUNNING', 'PAUSED'].includes(run.status);
  $('#pause-button').textContent = run.status === 'PAUSED' ? 'F8 재개' : 'F8 일시정지';
  $('#start-button').disabled = !selectedId || ['RUNNING', 'PAUSED'].includes(run.status);
  $('#start-button').title = backend?.f7Ready === false ? 'F7 등록에 실패했습니다. 버튼으로 시작하세요.' : 'F7';
  $('#stop-button').disabled = !['RUNNING', 'PAUSED'].includes(run.status);
  $('#availability').textContent = state.error || `${state.executionReason} 입력 실행은 대상 창 제목 조건과 권한이 준비된 매크로에서 사용할 수 있습니다.`;
  $('#new-button').disabled = !state.storageReady || saving;
  if ($('#first-macro')) $('#first-macro').disabled = !state.storageReady || saving;
  if (run.error) log(run.error);
  document.querySelectorAll('[data-step]').forEach((row) => row.classList.toggle('executing', run.macroId === selectedId && run.step?.join('.') === row.dataset.step));
}
function renderMacroSwitch() {
  const select = $('#macro-select');
  select.innerHTML = documentData.macros.map((macro) => `<option value="${escapeHtml(macro.id)}">${escapeHtml(macro.name)}</option>`).join('') || '<option value="">매크로 없음</option>';
  select.value = selectedId || '';
  select.disabled = saving;
}
function selectedAction(macro) {
  if (!selPath) return null;
  try { return resolvePath(macro, selPath).action; }
  catch { return null; }
}
function renderInspector(macro) {
  const box = $('#inspector');
  const found = selectedAction(macro);
  if (!found) { box.innerHTML = '<p class="empty">노드를 클릭하면 여기서 편집합니다.</p>'; return; }
  const parts = selPath.split('.');
  box.innerHTML = `<h4>${escapeHtml(stepNumber(parts))} · ${escapeHtml(typeLabels[found.type] || found.type)}</h4><div class="form-grid">${fields(found)}</div>`;
  box.querySelectorAll('[data-field]').forEach((input) => { input.oninput = () => {
    const field = input.dataset.field;
    const value = input.type === 'number' ? (input.value === '' ? NaN : Number(input.value)) : input.value;
    if (field.startsWith('region.')) found.region[field.slice(7)] = value; else found[field] = value;
    changed();
    const sub = document.querySelector(`[data-inspect="${selPath}"] .node-sub`);
    if (sub) sub.textContent = nodeSubtitle(macro, found);
  }; });
  box.querySelectorAll('[data-asset-path]').forEach((button) => { button.onclick = () => { found.image = button.dataset.assetPath; changed(); render(); }; });
  box.querySelectorAll('[data-op]').forEach((button) => { button.onclick = () => {
    if (button.dataset.op === 'select-image') void selectImage(found);
  }; });
}
function bindWorkflow(macro) {
  $('#flow').querySelectorAll('[data-inspect-btn]').forEach((button) => {
    button.onclick = () => { selPath = button.closest('[data-inspect]').dataset.inspect; render(); };
  });
  $('#flow').querySelectorAll('[data-op]').forEach((button) => {
    button.onclick = () => {
      const key = button.closest('[data-inspect]').dataset.inspect;
      const op = button.dataset.op;
      if (op === 'preview') { void preview(Number(key.split('.')[0])); return; }
      if (key.split('.').some((part) => part === 'test' || part === 'action')) return;
      try {
        if (op === 'copy') { const { items, index } = resolvePath(macro, key); items.splice(index + 1, 0, structuredClone(resolvePath(macro, key).action)); }
        else if (op === 'remove') { const { items, index } = resolvePath(macro, key); items.splice(index, 1); if (selPath === key) selPath = null; }
        else if (op === 'up' || op === 'down') {
          if (!moveStep(macro, key, op === 'up' ? -1 : 1)) return;
          const parts = key.split('.'); parts[parts.length - 1] = String(Number(parts.at(-1)) + (op === 'up' ? -1 : 1)); selPath = parts.join('.');
        } else return;
      } catch (error) { log(error.message); return; }
      changed(); render();
    };
  });
  $('#flow').querySelectorAll('[data-add]').forEach((button) => {
    button.onclick = () => {
      const containerKey = button.dataset.add;
      const select = document.querySelector(`select[data-add-type="${containerKey}"]`);
      const type = select.value;
      try {
        const items = containerItems(macro, containerKey);
        const depth = containerKey.split('.').filter((part) => /^\d+$/.test(part)).length;
        if (type === 'repeat' && depth >= 8) { log('반복 중첩은 최대 8단계입니다.'); return; }
        items.push(defaults(type));
      } catch (error) { log(error.message); return; }
      changed(); render();
    };
  });
  $('#flow').querySelectorAll('[data-replace-btn]').forEach((button) => {
    button.onclick = () => {
      const select = document.querySelector(`select[data-replace="${button.dataset.replaceBtn}"]`);
      try {
        const { action } = resolvePath(macro, button.dataset.replaceBtn);
        if (action?.type !== 'retry') return;
        action.action = defaults(select.value);
      } catch (error) { log(error.message); return; }
      changed(); render();
    };
  });
}
function defaults(type) {
  const image = { type, image: '', zone: 0, monitor: 1, threshold: 0.9, poll_interval_ms: 100, region: { x: 0, y: 0, width: 1920, height: 1080 } };
  return { wait: { type, duration_ms: 1000 }, image_detect: structuredClone(image), image_wait: structuredClone(image), image_click: structuredClone(image), smart_click: { ...structuredClone(image), verify_interval_ms: 800, expect_image: '' }, scroll: { type, delta_x: 0, delta_y: -500 }, retry: { type, count: 2, interval_ms: 200, action: structuredClone({ ...image, type: 'image_detect' }) }, condition: { type, test: structuredClone({ ...image, type: 'image_detect' }), then: [{ type: 'wait', duration_ms: 500 }], else: [] }, key: { type, keys: 'enter' }, text: { type, text: '' }, mouse_move: { type, x: 0, y: 0 }, click: { type, x: 0, y: 0, button: 'left' }, repeat: { type, count: 2, actions: [{ type: 'wait', duration_ms: 500 }] }, stop: { type } }[type];
}
function fields(action) {
  const labels = { duration_ms: '대기 시간 (ms)', image: '찾을 이미지 경로', expect_image: '기대 화면 경로(선택)', verify_interval_ms: '클릭 후 확인 간격 (ms)', zone: '구역 (0=전체)', monitor: '모니터 번호', threshold: '일치율 (0~1)', poll_interval_ms: '검색 간격 (ms)', delta_x: '가로 스크롤', delta_y: '세로 스크롤', x: '가로 위치', y: '세로 위치', width: '캡처 너비', height: '캡처 높이', keys: '키 조합', text: '입력할 내용', count: '반복 횟수', interval_ms: '재시도 간격 (ms)' };
  return Object.entries(action).filter(([key]) => !['type', 'timeout_ms', 'actions', 'action', 'test', 'then', 'else'].includes(key)).map(([key, value]) => {
    if (['image_detect', 'image_wait', 'image_click', 'smart_click'].includes(action.type) && key === 'image') return `<label class="image-field">${escapeHtml(labels[key])}<span class="input-with-button"><input data-field="image" type="text" value="${escapeHtml(value)}" placeholder="캡처 자산을 선택하세요"><button type="button" data-op="select-image" aria-label="이미지 파일 선택">파일</button></span><span class="asset-quick-pick">${(current()?.images || []).map((asset) => `<button type="button" data-asset-path="${escapeHtml(asset.path)}" title="${escapeHtml(asset.name)}">${escapeHtml(asset.name)}</button>`).join('') || '<small>아래 캡처 보관함에서 기준 이미지를 먼저 만드세요.</small>'}</span></label>`;
    if (current()?.overlay && ['monitor', 'region'].includes(key)) return '';
    if (['image_detect', 'image_wait', 'image_click', 'smart_click'].includes(action.type) && key === 'region') return Object.entries(value).map(([regionKey, regionValue]) => `<label>${escapeHtml(labels[regionKey])}<input data-field="region.${regionKey}" type="number" value="${escapeHtml(regionValue)}" min="0" step="1"></label>`).join('');
    if (key === 'button') return `<label>버튼<select data-field="button">${['left', 'right', 'middle'].map((option) => `<option ${value === option ? 'selected' : ''}>${option}</option>`).join('')}</select></label>`;
    if (key === 'coordinate_space') return `<label>좌표 기준<select data-field="coordinate_space"><option value="client" ${value === 'client' ? 'selected' : ''}>창 영역</option><option value="overlay" ${value === 'overlay' ? 'selected' : ''}>오버레이 영역</option></select></label>`;
    return `<label>${escapeHtml(labels[key] || key)}<input data-field="${key}" type="${typeof value === 'number' ? 'number' : 'text'}" value="${escapeHtml(value)}" ${typeof value === 'number' ? (key === 'threshold' ? 'min="0" max="1" step="0.01"' : 'min="0" step="1"') : ''}></label>`;
  }).join('');
}

const typeLabels = { wait: '대기', image_detect: '이미지 확인', image_wait: '이미지 발견 대기', image_click: '이미지 클릭', smart_click: '스마트 클릭', scroll: '스크롤', retry: '재시도', condition: '조건 분기', key: '키 입력', text: '문자 입력', mouse_move: '마우스 이동', click: '클릭', repeat: '반복', stop: '중단' };
function typeOptions() { return Object.entries(typeLabels).map(([type, label]) => '<option value="' + type + '">' + label + '</option>').join(''); }
function stepNumber(step) { return step.map((part) => typeof part === 'number' ? part + 1 : ({ test: '검사', then: '참', else: '거짓', action: '재시도' }[part] || part)).join('.'); }
function addSlot(containerKey) {
  return '<div class="flow-add"><select data-add-type="' + escapeHtml(containerKey) + '" aria-label="추가할 단계">' + typeOptions() + '</select><button data-add="' + escapeHtml(containerKey) + '">＋ 추가</button></div>';
}
function nodeHtml(macro, action, step) {
  const editKey = step.join('.');
  const isTest = step.includes('test');
  const ops = isTest ? '' : '<div class="node-ops"><button data-op="up" title="위로">↑</button><button data-op="down" title="아래로">↓</button><button data-op="copy" title="복제">⧉</button><button data-op="remove" title="삭제">✕</button>' + (step.length === 1 ? '<button data-op="preview" title="여기부터 미리보기">▶</button>' : '') + '</div>';
  let children = '';
  if (action.type === 'condition') {
    children = '<div class="flow-lanes">'
      + '<div class="flow-lane"><p class="lane-title true">참 · 탐지 성공</p>' + action.then.map((child, i) => nodeHtml(macro, child, [...step, 'then', i])).join('<div class="flow-link"></div>') + addSlot([...step, 'then'].join('.')) + '</div>'
      + '<div class="flow-lane"><p class="lane-title false">거짓 · 탐지 실패</p>' + action.else.map((child, i) => nodeHtml(macro, child, [...step, 'else', i])).join('<div class="flow-link"></div>') + addSlot([...step, 'else'].join('.')) + '</div>'
      + '</div>';
  } else if (action.type === 'repeat') {
    children = '<div class="flow-lane"><p class="lane-title">반복 ×' + action.count + '</p>' + action.actions.map((child, i) => nodeHtml(macro, child, [...step, i])).join('<div class="flow-link"></div>') + addSlot(editKey) + '</div>';
  } else if (action.type === 'retry') {
    const imageOptions = ['image_detect', 'image_wait', 'image_click', 'smart_click'].map((type) => `<option value="${type}">${typeLabels[type]}</option>`).join('');
    children = '<div class="flow-lane"><p class="lane-title">재시도 대상</p>' + nodeHtml(macro, action.action, [...step, 'action', 0]) + '<div class="flow-add"><select data-replace="' + escapeHtml(editKey) + '" aria-label="교체할 이미지 동작">' + imageOptions + '</select><button data-replace-btn="' + escapeHtml(editKey) + '">교체</button></div></div>';
  }
  return '<div class="flow-node' + (selPath === editKey ? ' selected' : '') + '" data-step="' + escapeHtml(runKey(step)) + '" data-inspect="' + escapeHtml(editKey) + '">'
    + '<div class="node-line"><button class="node-main" data-inspect-btn title="선택해 편집"><span class="node-icon">' + (typeIcons[action.type] || '•') + '</span><span class="node-text"><strong>' + stepNumber(step) + '. ' + escapeHtml(typeLabels[action.type] || action.type) + '</strong><small class="node-sub">' + escapeHtml(nodeSubtitle(macro, action)) + '</small></span></button>' + ops + '</div>'
    + children + '</div>';
}
// 실행 상태 키(run.step)와 맞추기 위해 retry 자식은 부모 키를 공유한다.
function runKey(step) {
  const clean = [...step];
  const at = clean.indexOf('action');
  if (at >= 0) clean.splice(at, 2);
  const testAt = clean.indexOf('test');
  if (testAt >= 0) clean.splice(testAt, 2);
  return clean.join('.');
}
function workflowHtml(macro) {
  if (!macro.actions.length) return '<p class="empty">아래 ＋ 추가로 첫 단계를 만드세요.</p>';
  return macro.actions.map((action, index) => nodeHtml(macro, action, [index])).join('<div class="flow-link"></div>') + addSlot('');
}
async function selectImage(action) {
  try {
    const result = await window.americano.request('image-select');
    if (result.ok && result.path) { action.image = result.path; changed(); render(); }
  } catch (error) { log(error.message); }
}
// 오버레이가 비어 있으면 전체 창으로 자동 설정하고 테두리까지 표시한다.
async function autoOverlay(macro) {
  if (macro.overlay || !macro.target_window?.process_name) return true;
  log('오버레이가 없어 전체 창으로 자동 설정합니다.');
  try {
    const result = await window.americano.request('overlay-auto', { macro });
    if (!result.ok) { log(result.error); return false; }
    Object.assign(macro, result.macro); changed(); render(); await save();
    await request('overlay-show', { macroId: macro.id });
    return true;
  } catch (error) { log(error.message); return false; }
}
function captureStudio(macro) {
  const area = macro.overlay;
  const assets = macro.images || [];
  const usages = assetUsages(macro);
  const cards = assets.map((asset) => {
    const uses = usages.get(asset.path) || [];
    const size = asset.region ? `${asset.region.width}×${asset.region.height}` : '';
    const useText = uses.length ? `${uses.length}개 단계 사용` : '미사용';
    return '<article class="asset-card' + (captureState.activeAsset === asset.id ? ' selected' : '') + '" data-asset-id="' + escapeHtml(asset.id) + '">'
      + '<button class="asset-select" data-op="select" title="이 이미지로 조건 추가"><img width="64" src="' + escapeHtml(asset.preview) + '" alt=""><span class="asset-meta"><strong>' + escapeHtml(asset.name) + '</strong><small>' + escapeHtml([size, useText].filter(Boolean).join(' · ')) + '</small></span>' + (captureState.activeAsset === asset.id ? '<em>✓</em>' : '') + '</button>'
      + '<div class="asset-tools"><button data-op="rename">이름</button><button data-op="delete">삭제</button></div>'
      + '<div class="asset-rename" hidden><input maxlength="200" value="' + escapeHtml(asset.name) + '" aria-label="이미지 이름"><button data-op="rename-save">저장</button><button data-op="rename-cancel">취소</button></div>'
      + '</article>';
  }).join('');
  return '<section class="capture-studio"><h3>탐지 이미지</h3><p>찾을 기준 이미지를 캡처해 보관합니다. 실행 대상 영역이 필요하면 오버레이를 지정하세요.</p><p>' + (area ? '저장 영역: ' + area.x + ', ' + area.y + ' / ' + area.width + ' × ' + area.height : '오버레이가 아직 없습니다.') + '</p><div class="editor-actions"><button class="button ghost" id="capture-open">오버레이 영역 설정</button><button class="button ghost" id="overlay-auto">전체 창 자동 설정</button><button class="button ghost" id="overlay-show">저장 오버레이 표시</button><button class="button ghost" id="overlay-hide">오버레이 숨기기</button><button class="button ghost" id="capture-image" ' + (!area ? 'disabled' : '') + '>영역 안에서 이미지 캡처</button></div><div class="asset-list">' + cards + '</div><div class="form-grid"><label>탐지 일치율<input id="rule-threshold" type="number" min="0" max="1" step="0.01" value="0.9"></label><label>탐지 true일 때<select id="rule-type"><option value="key">키 입력</option><option value="click">지정 좌표 클릭</option><option value="text">문자 입력</option><option value="stop">반복 중지</option></select></label></div><button class="button primary" id="add-rule" ' + (!area || !assets.length ? 'disabled' : '') + '>선택 이미지 조건 추가</button><p>조건을 추가한 뒤 아래 true / false 단계에서 실행 내용을 편집하세요.</p><div class="form-grid"><label>전체 반복 횟수 (1~10000)<input id="loop-count" type="number" min="1" max="10000" value="' + (macro.loop?.count || 1) + '"></label><label>반복 간격 (ms)<input id="loop-interval" type="number" min="30" max="60000" value="' + (macro.loop?.interval_ms || 500) + '"></label></div></section>';
}
function bindCapture(macro) {
  const open = async (mode) => {
    if (!validFields()) return;
    captureMacroId = macro.id;
    try {
      const result = await window.americano.request('capture-overlay-open', { mode, macro });
      if (!result.ok) log(result.error);
    } catch (error) { log(error.message); }
  };
  $('#overlay-show').onclick = async () => { if (dirty && !(await save())) return; await request('overlay-show', {macroId: selectedId}); };
  $('#overlay-hide').onclick = () => request('overlay-hide');
  $('#capture-open').onclick = () => open('region');
  $('#overlay-auto').onclick = async () => {
    if (!validFields()) return;
    try {
      const result = await window.americano.request('overlay-auto', { macro });
      if (!result.ok) { log(result.error); return; }
      Object.assign(macro, result.macro); changed(); render(); await save();
      await request('overlay-show', { macroId: macro.id });
    } catch (error) { log(error.message); }
  };
  $('#capture-image').onclick = () => open('image');
  async function removeAsset(asset) {
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
    const asset = (macro.images || []).find((item) => item.id === card.dataset.assetId);
    if (!asset) return;
    const pick = (selector) => card.querySelector(selector);
    pick('[data-op="select"]').onclick = () => { if (!validFields()) return; captureState.activeAsset = asset.id; render(); };
    pick('[data-op="rename"]').onclick = () => {
      if (!validFields()) return;
      pick('.asset-rename').hidden = false;
      const input = pick('.asset-rename input'); input.focus(); input.select();
    };
    pick('[data-op="rename-cancel"]').onclick = () => render();
    const commitRename = () => {
      const name = pick('.asset-rename input').value.trim();
      if (!name) { log('이미지 이름이 비어 있습니다.'); return; }
      if (name.length > 200) { log('이미지 이름은 200자 이하여야 합니다.'); return; }
      asset.name = name; changed(); render();
      const uses = assetUsages(macro).get(asset.path) || [];
      log(uses.length ? `이름을 바꿨습니다. ${uses.length}개 단계의 참조는 그대로 유지됩니다.` : '이름을 바꿨습니다.');
    };
    pick('[data-op="rename-save"]').onclick = commitRename;
    pick('.asset-rename input').onkeydown = (event) => { if (event.key === 'Enter') commitRename(); if (event.key === 'Escape') render(); };
    pick('[data-op="delete"]').onclick = () => void removeAsset(asset);
  });
  $('#add-rule').onclick = () => {
    if (!validFields()) return;
    const asset = (macro.images || []).find(item => item.id === captureState.activeAsset) || macro.images[0];
    macro.actions.push({ type: 'condition', test: { ...defaults('image_detect'), image: asset.path, region: structuredClone(macro.overlay), threshold: Number($('#rule-threshold').value) }, then: [defaults($('#rule-type').value)], else: [] });
    changed(); render();
  };
  for (const [id, field] of [['loop-count', 'count'], ['loop-interval', 'interval_ms']]) {
    $('#' + id).oninput = event => { macro.loop ||= { count: 1, interval_ms: 500 }; macro.loop[field] = Number(event.target.value); changed(); };
  }
}

function render() {
  renderMacroSwitch();
  const macro = current();
  if (!macro) {
    $('#editor').innerHTML = '<div class="welcome"><p class="eyebrow">시작하기</p><h2>첫 매크로를 만들어 보세요</h2><p>이름과 대상 앱을 지정하고, 실행할 동작을 순서대로 추가하세요. 설정은 앱이 관리합니다.</p><ol><li>매크로 이름과 대상 앱 설정</li><li>워크플로우에 동작 노드 추가</li><li>저장 후 미리보기로 순서 확인</li></ol><button id="first-macro" class="button primary">첫 매크로 만들기</button></div>';
    $('#first-macro').onclick = createMacro;
    if (backend) update(backend);
    return;
  }
  if (!selectedAction(macro)) selPath = null;
  $('#editor').innerHTML = `<div class="macro-head"><div><p class="eyebrow">WORKFLOW</p><h3>${escapeHtml(macro.name)}</h3></div><div class="actions"><button id="export-macro" class="button ghost">내보내기</button><button id="import-macro" class="button ghost">가져오기</button></div></div>
    <div class="target-row"><div><p class="eyebrow">TARGET WINDOW</p><strong>실행 대상 창</strong><small id="target-status">창 목록을 불러오지 않았습니다.</small></div><div class="target-controls"><select id="target-window" aria-label="실행 대상 창"><option value="">창을 선택하세요</option>${macro.target_window.title_contains ? `<option value="current" selected>${escapeHtml(macro.target_window.process_name || '')} · ${escapeHtml(macro.target_window.title_contains)}</option>` : ''}</select><button id="refresh-windows" type="button" class="button ghost">창 새로고침</button></div><div class="target-meta"><span>프로세스 ${escapeHtml(macro.target_window.process_name || '-')}</span><span>제목 ${escapeHtml(macro.target_window.title_contains || '-')}</span><label class="checkbox"><input id="enabled" type="checkbox" ${macro.enabled ? 'checked' : ''}> 활성화</label></div></div>
    <details class="settings"><summary>매크로 설정 (이름·설명·스크립트)</summary><div class="form-grid"><label>이름<input id="name" maxlength="100" value="${escapeHtml(macro.name)}"></label><label>설명<input id="description" maxlength="200" value="${escapeHtml(macro.description || '')}" placeholder="이 매크로의 용도"></label><label>시작 단축키 (준비 중)<input id="hotkey" value="${escapeHtml(macro.hotkey)}" placeholder="ctrl+alt+q"></label></div><label class="script-editor-label">Americano Script<textarea id="script" rows="8">${escapeHtml(macro.script || '')}</textarea></label></details>
    <div class="studio-flow">${captureStudio(macro)}<div class="flow-col"><div class="work-area"><section class="workflow"><div class="section-heading"><h3>워크플로우</h3></div><div id="flow">${workflowHtml(macro)}</div></section><aside id="inspector" aria-label="노드 편집"></aside></div></div></div>
    <section class="portable-panel"><p>설정과 이미지가 함께 들어 있는 .amacro 파일로 주고받습니다.</p>${macro.binding ? `<p>${macro.binding.needs_overlay ? '가져오기 완료: 대상 창을 확인하고 오버레이를 재지정하세요.' : '오버레이 연결 완료'}${macro.binding.needs_review ? ' · 이미지 크기와 창 기준 좌표를 검토해야 합니다.' : ''}</p>${macro.binding.needs_review && !macro.binding.needs_overlay ? '<button id="binding-reviewed">이미지와 좌표 검토 완료</button>' : ''}` : ''}</section>
    <div class="editor-actions"><button id="save" class="button primary">저장</button><button id="run" class="button danger">실행</button><button id="preview" class="button ghost">입력 없이 미리보기</button><button id="progress-toggle" class="button ghost">진행 오버레이</button></div>`;
  for (const [id, field] of [['name', 'name'], ['description', 'description'], ['hotkey', 'hotkey']]) $(`#${id}`).oninput = (event) => { macro[field] = event.target.value; changed(); renderMacroSwitch(); };
  $('#script').oninput = (event) => { macro.script = event.target.value; changed(); };
  $('#target-window').onchange = async (event) => {
    if (!validFields()) { render(); return; }
    if (event.target.value === 'current') return;
    const item = event.target._windows?.[event.target.value]; if (!item) return;
    macro.target_window = { title_contains: item.title, process_name: item.process_name, executable_path: item.executable_path };
    if (macro.overlay) { macro.binding = { needs_overlay: true, needs_review: macro.binding?.needs_review || false, source_overlay: macro.overlay }; }
    macro.overlay = null; changed(); render();
    await autoOverlay(macro);
  };
  $('#refresh-windows').onclick = () => refreshWindows(macro);
  bindCapture(macro);
  $('#enabled').onchange = (event) => { macro.enabled = event.target.checked; changed(); };
  $('#save').onclick = save;
  $('#export-macro').onclick = async () => {
    if (dirty && !(await save())) return;
    const result = await window.americano.request('macro-export', { macroId: selectedId });
    log(result.ok ? (result.canceled ? '내보내기를 취소했습니다.' : '설정과 이미지를 내보냈습니다.') : result.error);
  };
  $('#import-macro').onclick = async () => {
    if (saving || (dirty && !(await save()))) return;
    $('#editor').inert = true;
    try {
      const result = await window.americano.request('macro-import');
      if (!result.ok) { log(result.error); return; }
      if (result.canceled) return;
      documentData = result.state.document; selectedId = result.macroId; dirty = false; render();
      log('가져왔습니다. 대상 창을 확인한 뒤 오버레이를 재지정하세요.');
      await autoOverlay(documentData.macros.find((item) => item.id === selectedId));
    } catch (error) { log(error.message); }
    finally { $('#editor').inert = false; }
  };
  if ($('#binding-reviewed')) $('#binding-reviewed').onclick = () => { macro.binding.needs_review = false; changed(); render(); };
  $('#run').onclick = startSelected;
  $('#preview').onclick = () => preview(0);
  $('#progress-toggle').onclick = async () => {
    try {
      const result = await window.americano.request('progress-toggle', { macroId: selectedId });
      if (result.state) update(result.state);
      log(result.ok ? (result.open ? '진행 오버레이를 열었습니다.' : '진행 오버레이를 닫았습니다.') : result.error);
    } catch (error) { log(error.message); }
  };
  bindWorkflow(macro);
  renderInspector(macro);
  if (backend) update(backend);
}
async function refreshWindows(macro) {
  const select = $('#target-window'); const status = $('#target-status');
  select.disabled = true; status.textContent = '창 검색 중...';
  try {
    const result = await window.americano.request('window-list');
    if (!result.ok) throw new Error(result.error);
    const unique = result.windows; select._windows = unique;
    select.innerHTML = (macro.target_window.title_contains ? `<option value="current" selected>${escapeHtml(macro.target_window.process_name || '')} · ${escapeHtml(macro.target_window.title_contains)} (현재)</option>` : '<option value="">창을 선택하세요</option>') + unique.map((item, index) => `<option value="${index}" ${item.title === macro.target_window.title_contains ? 'selected' : ''}>${escapeHtml(item.process_name)} · ${escapeHtml(item.title)}</option>`).join('');
    status.textContent = `${unique.length}개 창을 찾았습니다.`;
  } catch (error) { status.textContent = error.message; }
  finally { select.disabled = false; }
}
function validFields() { const invalid = $('#editor').querySelector(':invalid'); if (invalid) { invalid.reportValidity(); return false; } return true; }
function countSteps(items) { return items.reduce((total, action) => total + 1 + (action.type === 'repeat' ? countSteps(action.actions) : action.type === 'condition' ? 1 + countSteps(action.then) + countSteps(action.else) : action.type === 'retry' ? 1 : 0), 0); }
// 자산 경로 -> 사용하는 단계 목록. 삭제 가드와 사용처 표시에 쓴다.
function assetUsages(macro) {
  const usages = new Map();
  const push = (ref, step, type) => {
    if (typeof ref !== 'string' || !ref) return;
    if (!usages.has(ref)) usages.set(ref, []);
    usages.get(ref).push({ step: step.map((part) => typeof part === 'number' ? part + 1 : ({ test: '검사', then: '참', else: '거짓', action: '재시도' }[part] || part)).join('.'), type });
  };
  const visit = (items, prefix = []) => {
    (items || []).forEach((action, index) => {
      const step = [...prefix, index];
      for (const field of ['image', 'expect_image']) if (typeof action[field] === 'string') push(action[field], step, action.type);
      if (action.type === 'repeat' && Array.isArray(action.actions)) visit(action.actions, step);
      if (action.type === 'condition') {
        if (action.test) visit([action.test], [...step, 'test']);
        visit(action.then || [], [...step, 'then']);
        visit(action.else || [], [...step, 'else']);
      }
      if (action.type === 'retry' && action.action) visit([action.action], [...step, 'action']);
    });
  };
  visit(macro.actions || []);
  return usages;
}
async function save() {
  if (saving || !validFields()) return false;
  saving = true;
  $('#editor').inert = true;
  // Freeze editing until this snapshot has been acknowledged, preventing lost edits.
  const controls = [...document.querySelectorAll('#editor input, #editor textarea, #editor select, #editor button, #macro-select, #new-button, #duplicate-button, #delete-button')];
  const disabled = controls.map((control) => control.disabled); controls.forEach((control) => { control.disabled = true; });
  const state = await request('save', { document: documentData });
  saving = false; $('#editor').inert = false; controls.forEach((control, index) => { control.disabled = disabled[index]; });
  if (!state) return false;
  documentData = state.document; dirty = false; render(); log('암호화 저장했습니다.'); return true;
}
async function preview(startIndex) { if (dirty && !(await save())) return; await request('preview', { macroId: selectedId, startIndex }); }
async function startSelected() {
  if (!selectedId) { log('시작할 매크로를 선택하세요.'); return; }
  if (dirty && !(await save())) return;
  const state = await request('start', { macroId: selectedId, startIndex: 0 });
  if (state) {
    try { await window.americano.request('progress-toggle', { macroId: selectedId, open: true }); }
    catch { /* 진행 오버레이 자동 열기 실패는 무시한다. */ }
  }
}
function createMacro() {
  if (saving || !backend?.storageReady || !validFields()) return;
  const macro = { id: crypto.randomUUID(), name: '새 매크로', description: '', script: '', enabled: false, hotkey: '', target_window: {}, images: [], actions: [] };
  documentData.macros.push(macro); selectedId = macro.id; changed(); render(); selPath = null;
  const nameInput = $('#name'); if (nameInput) { nameInput.focus(); nameInput.select(); }
}
$('#new-button').onclick = createMacro;
$('#macro-select').onchange = (event) => {
  if (!validFields()) { renderMacroSwitch(); return; }
  selectedId = event.target.value || null; selPath = null; render();
};
$('#duplicate-button').onclick = () => {
  const macro = current(); if (!macro || !validFields()) return;
  const copy = structuredClone(macro); copy.id = crypto.randomUUID(); copy.name += ' 복사'; copy.enabled = false; copy.hotkey = '';
  documentData.macros.push(copy); selectedId = copy.id; selPath = null; changed(); render();
};
$('#delete-button').onclick = () => {
  const macro = current(); if (!macro) return;
  if (!confirm(`“${macro.name}” 매크로를 삭제할까요?`)) return;
  documentData.macros = documentData.macros.filter((item) => item.id !== selectedId);
  selectedId = documentData.macros[0]?.id; selPath = null; changed(); render(); void save();
};
$('#start-button').onclick = startSelected;
$('#pause-button').onclick = () => request('pause');
$('#stop-button').onclick = () => request('stop');
window.americano.onStartHotkey(startSelected);
$('#license-import').onclick = () => request('license-import');
$('#license-check').onclick = async () => { const state = await request('license-check'); if (state) log('실행 권한 확인 성공: 서명, MAC, 유효기간, 기능 권한이 모두 유효합니다. 실제 입력은 수행하지 않았습니다.'); };
$('#license-device-button').onclick = async () => {
  try { const result = await window.americano.request('license-device'); if (!result.ok) { log(result.error); return; } $('#license-device').textContent = result.macs.length ? result.macs.join(' / ') : '사용 가능한 MAC 주소가 없습니다.'; }
  catch (error) { log(error.message); }
};
function closeLicenseDialog() { $('#license-dialog').hidden = true; }
$('#license-open').onclick = () => { $('#license-dialog').hidden = false; $('#license-close').focus(); };
$('#license-close').onclick = closeLicenseDialog;
$('#license-dialog').onclick = (event) => { if (event.target === $('#license-dialog')) closeLicenseDialog(); };
window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('#license-dialog').hidden) closeLicenseDialog(); });
window.americano.onState(update);
if (window.americano.onCaptureResult) window.americano.onCaptureResult(async (result) => {
  if (!result.ok) { log(`이미지를 저장하지 못했습니다: ${result.error}`); return; }
  const macro = documentData.macros.find((item) => item.id === (result.macroId || captureMacroId));
  if (!macro) { log('캡처 결과를 받을 매크로를 찾지 못했습니다.'); return; }
  if (result.mode === 'region') {
    const rebound = await window.americano.request('overlay-rebind', { macro, region: result.region });
    if (!rebound.ok) { log(rebound.error); return; }
    Object.assign(macro, rebound.macro); changed(); render(); await save();
    await request('overlay-show', { macroId: macro.id });
    return;
  }
  macro.images = macro.images || [];
  const asset = { id: crypto.randomUUID(), name: `영역 ${macro.images.length + 1}`, path: result.path, preview: result.preview, region: result.region };
  macro.images.push(asset);
  captureState.activeAsset = asset.id;
  changed();
  render();
  void save();
});
request('state').then((state) => { if (!state) return; documentData = state.document; selectedId = documentData.macros[0]?.id; render(); log(state.error || '로컬 암호화 저장소를 불러왔습니다.'); });
