const $ = (selector) => document.querySelector(selector);
let documentData = { version: 2, macros: [] };
let selectedId = null;
let dirty = false;
let backend;
let saving = false;
let macroFilter = '';
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
    $('#license-summary-detail').textContent = state.license.valid ? '실행 권한 사용 가능' : '미리보기만 사용 가능';
  }
  const run = state.run;
  const labels = { STOPPED: '대기', RUNNING: '미리보기 실행 중', PAUSED: '일시정지', ERROR: '실행 오류' };
  $('#status-label').textContent = labels[run.status] || run.status;
  $('#runtime-copy').textContent = `${run.macroId ? (documentData.macros.find((item) => item.id === run.macroId)?.name || run.macroId) : '실행 대기'}${run.step ? ` · 단계 ${run.step.map((part) => part + 1).join('.')}` : ''} · 완료 ${run.completed}회`;
  $('#pause-button').disabled = !['RUNNING', 'PAUSED'].includes(run.status);
  $('#pause-button').textContent = run.status === 'PAUSED' ? 'F8 재개' : 'F8 일시정지';
  $('#stop-button').disabled = !['RUNNING', 'PAUSED'].includes(run.status);
  $('#availability').textContent = state.error || `${state.executionReason} 입력 실행은 대상 창 제목 조건과 권한이 준비된 매크로에서 사용할 수 있습니다.`;
  $('#new-button').disabled = !state.storageReady || saving;
  if ($('#first-macro')) $('#first-macro').disabled = !state.storageReady || saving;
  if (run.error) log(run.error);
  document.querySelectorAll('[data-step]').forEach((row) => row.classList.toggle('executing', run.macroId === selectedId && run.step?.join('.') === row.dataset.step));
}
function renderList() {
  const visible = documentData.macros.filter((macro) => `${macro.name} ${macro.description || ''}`.toLowerCase().includes(macroFilter.toLowerCase()));
  $('#macros').innerHTML = visible.map((macro) => `<button class="macro-item ${macro.id === selectedId ? 'selected' : ''}" data-id="${escapeHtml(macro.id)}"><strong>${escapeHtml(macro.name)}</strong><small>${macro.enabled ? '활성 설정' : '비활성'} · ${macro.actions.length}개 단계</small></button>`).join('') || `<p class="empty">${macroFilter ? '검색 결과가 없습니다.' : '등록된 매크로가 없습니다.'}</p>`;
  $('#macros').querySelectorAll('button').forEach((button) => { button.onclick = () => { if (!validFields()) return; selectedId = button.dataset.id; render(); }; });
}
function defaults(type) {
  const image = { type, image: '', monitor: 1, threshold: 0.9, poll_interval_ms: 100, region: { x: 0, y: 0, width: 1920, height: 1080 } };
  return { wait: { type, duration_ms: 1000 }, image_detect: structuredClone(image), image_wait: structuredClone(image), image_click: structuredClone(image), scroll: { type, delta_x: 0, delta_y: -500 }, retry: { type, count: 2, interval_ms: 200, action: structuredClone({ ...image, type: 'image_detect' }) }, condition: { type, test: structuredClone({ ...image, type: 'image_detect' }), then: [{ type: 'wait', duration_ms: 500 }], else: [] }, key: { type, keys: 'enter' }, text: { type, text: '' }, mouse_move: { type, x: 0, y: 0 }, click: { type, x: 0, y: 0, button: 'left' }, repeat: { type, count: 2, actions: [{ type: 'wait', duration_ms: 500 }] }, stop: { type } }[type];
}
function fields(action) {
  const labels = { duration_ms: '대기 시간 (ms)', image: '찾을 이미지 경로', monitor: '모니터 번호', threshold: '일치율 (0~1)', poll_interval_ms: '검색 간격 (ms)', delta_x: '가로 스크롤', delta_y: '세로 스크롤', x: '가로 위치', y: '세로 위치', width: '캡처 너비', height: '캡처 높이', keys: '키 조합', text: '입력할 내용', count: '반복 횟수', interval_ms: '재시도 간격 (ms)' };
  return Object.entries(action).filter(([key]) => !['type', 'timeout_ms', 'actions', 'action', 'test', 'then', 'else'].includes(key)).map(([key, value]) => {
    if (['image_detect', 'image_wait', 'image_click'].includes(action.type) && key === 'image') return `<label class="image-field">${escapeHtml(labels[key])}<span class="input-with-button"><input data-field="image" type="text" value="${escapeHtml(value)}" placeholder="감지할 이미지 파일"><button type="button" data-op="select-image" aria-label="감지할 이미지 선택">찾기</button></span></label>`;
    if (['image_detect', 'image_wait', 'image_click'].includes(action.type) && key === 'region') return Object.entries(value).map(([regionKey, regionValue]) => `<label>${escapeHtml(labels[regionKey])}<input data-field="region.${regionKey}" type="number" value="${escapeHtml(regionValue)}" min="0" step="1"></label>`).join('');
    if (key === 'button') return `<label>버튼<select data-field="button">${['left', 'right', 'middle'].map((option) => `<option ${value === option ? 'selected' : ''}>${option}</option>`).join('')}</select></label>`;
    return `<label>${escapeHtml(labels[key] || key)}<input data-field="${key}" type="${typeof value === 'number' ? 'number' : 'text'}" value="${escapeHtml(value)}" ${typeof value === 'number' ? 'min="0" step="1"' : ''}></label>`;
  }).join('');
}

const typeLabels = { wait: '대기', image_detect: '이미지 확인', image_wait: '이미지 발견 대기', image_click: '이미지 클릭', scroll: '스크롤', retry: '재시도', condition: '조건 분기', key: '키 입력', text: '문자 입력', mouse_move: '마우스 이동', click: '클릭', repeat: '반복', stop: '중단' };
function typeOptions() { return Object.entries(typeLabels).map(([type, label]) => '<option value="' + type + '">' + label + '</option>').join(''); }
function stepCards(items, prefix = []) {
  if (!items.length) return '<p class="empty">단계를 추가해 실행 순서를 구성하세요.</p>';
  return items.map((action, index) => {
    const step = [...prefix, index];
    return '<article class="step-card" data-step="' + step.join('.') + '"><div class="section-heading"><strong>' + step.map((part) => part + 1).join('.') + '. ' + escapeHtml(typeLabels[action.type]) + '</strong><div class="actions">' +
      '<button data-op="up" aria-label="단계 위로 이동" ' + (index === 0 ? 'disabled' : '') + '>↑</button><button data-op="down" aria-label="단계 아래로 이동" ' + (index === items.length - 1 ? 'disabled' : '') + '>↓</button><button data-op="copy">복제</button><button data-op="remove">삭제</button>' +
      (prefix.length === 0 ? '<button data-op="preview">여기부터 미리보기</button>' : '') + '</div></div><div class="form-grid">' + fields(action) + '</div>' +
      (action.type === 'repeat' ? '<div class="nested-steps">' + stepCards(action.actions, step) + '</div><div class="editor-actions"><select data-child-type aria-label="반복에 추가할 단계">' + typeOptions() + '</select><button data-op="add-child">반복 내부 단계 추가</button></div>' : '') + '</article>';
  }).join('');
}
function bindSteps(macro) {
  $('#steps').querySelectorAll('.step-card').forEach((row) => {
    const step = row.dataset.step.split('.').map(Number);
    const index = step.at(-1);
    let items = macro.actions;
    for (const part of step.slice(0, -1)) items = items[part].actions;
    const action = items[index];
    const own = (selector) => [...row.querySelectorAll(selector)].filter((element) => element.closest('.step-card') === row);
    own('[data-field]').forEach((input) => { input.oninput = () => {
      const field = input.dataset.field;
      const value = input.type === 'number' ? (input.value === '' ? NaN : Number(input.value)) : input.value;
      if (field.startsWith('region.')) action.region[field.slice(7)] = value; else action[field] = value;
      changed();
    }; });
    own('[data-op]').forEach((button) => { button.onclick = () => {
      if (!validFields()) return;
      const op = button.dataset.op;
      if (op === 'select-image') { void selectImage(action); return; }
      if (op === 'preview') { void preview(index); return; }
      if (op === 'copy') items.splice(index + 1, 0, structuredClone(action));
      if (op === 'remove') items.splice(index, 1);
      if (op === 'up') [items[index - 1], items[index]] = [items[index], items[index - 1]];
      if (op === 'down') [items[index + 1], items[index]] = [items[index], items[index + 1]];
      if (op === 'add-child') {
        const type = own('[data-child-type]')[0].value;
        if (step.length >= 8 && type === 'repeat') { log('반복 중첩은 최대 8단계입니다.'); return; }
        action.actions.push(defaults(type));
      }
      changed(); render();
    }; });
  });
}
async function selectImage(action) {
  try {
    const result = await window.americano.request('image-select');
    if (result.ok && result.path) { action.image = result.path; changed(); render(); }
  } catch (error) { log(error.message); }
}

function render() {
  renderList();
  $('#macro-count').textContent = documentData.macros.length;
  $('#step-count').textContent = documentData.macros.reduce((total, macro) => total + countSteps(macro.actions), 0);
  const macro = current();
  if (!macro) {
    $('#editor').innerHTML = '<div class="welcome"><p class="eyebrow">시작하기</p><h2>첫 매크로를 만들어 보세요</h2><p>이름과 대상 앱을 지정하고, 실행할 동작을 순서대로 추가하세요. 설정은 앱이 관리합니다.</p><ol><li>매크로 이름과 대상 앱 설정</li><li>대기, 키 입력, 클릭 등 단계 추가</li><li>저장 후 미리보기로 순서 확인</li></ol><button id="first-macro" class="button primary">첫 매크로 만들기</button></div>';
    $('#first-macro').onclick = createMacro;
    if (backend) update(backend);
    return;
  }
  $('#editor').innerHTML = `<div class="section-heading"><div><p class="eyebrow">MACRO EDITOR</p><h3>순서 편집</h3></div><div class="actions"><button id="duplicate">매크로 복제</button><button id="delete" class="text-danger">삭제</button></div></div>
    <div class="form-grid"><label>이름<input id="name" maxlength="100" value="${escapeHtml(macro.name)}"></label><label>설명<input id="description" maxlength="200" value="${escapeHtml(macro.description || '')}" placeholder="이 매크로의 용도"></label><label>시작 단축키 (준비 중)<input id="hotkey" value="${escapeHtml(macro.hotkey)}" placeholder="ctrl+alt+q"></label><label>프로세스 이름<input id="process" value="${escapeHtml(macro.target_window.process_name || '')}" placeholder="example.exe"></label><label>창 제목 포함<input id="title" value="${escapeHtml(macro.target_window.title_contains || '')}"></label><label class="checkbox"><input id="enabled" type="checkbox" ${macro.enabled ? 'checked' : ''}> 활성화 설정</label></div>
    <label class="script-editor-label">Americano Script<textarea id="script" rows="8" placeholder="if image_detect 'confirm.png'\n  click 420 310\nendif">${escapeHtml(macro.script || '')}</textarea></label>
    <div id="steps">${stepCards(macro.actions)}</div>
    <div class="editor-actions"><select id="action-type" aria-label="추가할 단계 유형">${typeOptions()}</select><button id="add">단계 추가</button><button id="save" class="button primary">저장</button><button id="run" class="button danger">실행</button><button id="preview" class="button ghost">입력 없이 미리보기</button></div>`;
  for (const [id, field] of [['name', 'name'], ['description', 'description'], ['hotkey', 'hotkey']]) $(`#${id}`).oninput = (event) => { macro[field] = event.target.value; changed(); renderList(); };
  $('#script').oninput = (event) => { macro.script = event.target.value; changed(); };
  $('#process').oninput = (event) => { macro.target_window.process_name = event.target.value; changed(); };
  $('#title').oninput = (event) => { macro.target_window.title_contains = event.target.value; changed(); };
  $('#enabled').onchange = (event) => { macro.enabled = event.target.checked; changed(); renderList(); };
  $('#duplicate').onclick = () => { if (!validFields()) return; const copy = structuredClone(macro); copy.id = crypto.randomUUID(); copy.name += ' 복사'; copy.enabled = false; copy.hotkey = ''; documentData.macros.push(copy); selectedId = copy.id; changed(); render(); };
  $('#delete').onclick = () => { if (!confirm(`“${macro.name}” 매크로를 삭제할까요?`)) return; documentData.macros = documentData.macros.filter((item) => item.id !== selectedId); selectedId = documentData.macros[0]?.id; changed(); render(); void save(); };
  $('#add').onclick = () => { if (!validFields()) return; macro.actions.push(defaults($('#action-type').value)); changed(); render(); };
  $('#save').onclick = save;
  $('#run').onclick = async () => { if (dirty && !(await save())) return; await request('start', { macroId: selectedId, startIndex: 0 }); };
  $('#preview').onclick = () => preview(0);
  bindSteps(macro);
  if (backend) update(backend);
}
function validFields() { const invalid = $('#editor').querySelector(':invalid'); if (invalid) { invalid.reportValidity(); return false; } return true; }
function countSteps(items) { return items.reduce((total, action) => total + 1 + (action.type === 'repeat' ? countSteps(action.actions) : 0), 0); }
async function save() {
  if (saving || !validFields()) return false;
  saving = true;
  // Freeze editing until this snapshot has been acknowledged, preventing lost edits.
  const controls = [...document.querySelectorAll('#editor input, #editor textarea, #editor select, #editor button, #macros button, #new-button')];
  const disabled = controls.map((control) => control.disabled); controls.forEach((control) => { control.disabled = true; });
  const state = await request('save', { document: documentData });
  saving = false; controls.forEach((control, index) => { control.disabled = disabled[index]; });
  if (!state) return false;
  documentData = state.document; dirty = false; render(); log('암호화 저장했습니다.'); return true;
}
async function preview(startIndex) { if (dirty && !(await save())) return; await request('preview', { macroId: selectedId, startIndex }); }
function createMacro() {
  if (saving || !backend?.storageReady || !validFields()) return;
  const macro = { id: crypto.randomUUID(), name: '새 매크로', description: '', script: '', enabled: false, hotkey: '', target_window: {}, actions: [] };
  documentData.macros.push(macro); selectedId = macro.id; changed(); render(); $('#name').focus(); $('#name').select();
}
$('#new-button').onclick = createMacro;
$('#macro-search').oninput = (event) => { macroFilter = event.target.value.trim(); renderList(); };
$('#pause-button').onclick = () => request('pause');
$('#stop-button').onclick = () => request('stop');
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
window.addEventListener('beforeunload', (event) => { if (dirty && !confirm('저장하지 않은 변경사항을 버리고 종료할까요?')) { event.preventDefault(); event.returnValue = false; } });
request('state').then((state) => { if (!state) return; documentData = state.document; selectedId = documentData.macros[0]?.id; render(); log(state.error || '로컬 암호화 저장소를 불러왔습니다.'); });
