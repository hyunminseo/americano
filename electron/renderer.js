const $ = (selector) => document.querySelector(selector);
let documentData = { version: 2, macros: [] };
let selectedId = null;
let dirty = false;
let backend;
let saving = false;
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
  const run = state.run;
  const labels = { STOPPED: '대기', RUNNING: '미리보기 실행 중', PAUSED: '일시정지', ERROR: '실행 오류' };
  $('#status-label').textContent = labels[run.status] || run.status;
  $('#runtime-copy').textContent = `${run.macroId ? (documentData.macros.find((item) => item.id === run.macroId)?.name || run.macroId) : '실행 대기'}${run.step ? ` · 단계 ${run.step.map((part) => part + 1).join('.')}` : ''} · 완료 ${run.completed}회`;
  $('#pause-button').disabled = !['RUNNING', 'PAUSED'].includes(run.status);
  $('#pause-button').textContent = run.status === 'PAUSED' ? 'F8 재개' : 'F8 일시정지';
  $('#stop-button').disabled = !['RUNNING', 'PAUSED'].includes(run.status);
  $('#availability').textContent = state.error || `${state.executionReason} 미리보기에서는 입력 단계를 건너뛰고 대기와 순서를 확인합니다. 시작 단축키 등록은 실제 실행 지원 시 활성화됩니다.`;
  $('#new-button').disabled = !state.storageReady || saving;
  if (run.error) log(run.error);
  document.querySelectorAll('[data-step]').forEach((row) => row.classList.toggle('executing', run.macroId === selectedId && run.step?.join('.') === row.dataset.step));
}
function renderList() {
  $('#macros').innerHTML = documentData.macros.map((macro) => `<button class="macro-item ${macro.id === selectedId ? 'selected' : ''}" data-id="${escapeHtml(macro.id)}"><strong>${escapeHtml(macro.name)}</strong><small>${macro.enabled ? '활성 설정' : '비활성'} · ${macro.actions.length}개 단계</small></button>`).join('') || '<p>등록된 매크로가 없습니다.</p>';
  $('#macros').querySelectorAll('button').forEach((button) => { button.onclick = () => { if (!validFields()) return; selectedId = button.dataset.id; render(); }; });
}
function defaults(type) {
  return { wait: { type, duration_ms: 1000 }, key: { type, keys: 'enter' }, text: { type, text: '' }, mouse_move: { type, x: 0, y: 0 }, click: { type, x: 0, y: 0, button: 'left' }, repeat: { type, count: 2, actions: [{ type: 'wait', duration_ms: 500 }] }, stop: { type } }[type];
}
function fields(action) {
  return Object.entries(action).filter(([key]) => !['type', 'timeout_ms'].includes(key)).map(([key, value]) => {
    if (key === 'actions') return `<label>반복 내부 단계 (JSON)<textarea data-field="actions" rows="5">${escapeHtml(JSON.stringify(value, null, 2))}</textarea></label>`;
    if (key === 'button') return `<label>버튼<select data-field="button">${['left', 'right', 'middle'].map((option) => `<option ${value === option ? 'selected' : ''}>${option}</option>`).join('')}</select></label>`;
    return `<label>${escapeHtml(key)}<input data-field="${key}" type="${typeof value === 'number' ? 'number' : 'text'}" value="${escapeHtml(value)}" ${typeof value === 'number' ? 'min="0" step="1"' : ''}></label>`;
  }).join('');
}
function render() {
  renderList(); const macro = current();
  if (!macro) { $('#editor').innerHTML = '<p>매크로를 만들거나 선택하세요.</p>'; return; }
  $('#editor').innerHTML = `<div class="section-heading"><h3>순서 편집</h3><div class="actions"><button id="duplicate">매크로 복제</button><button id="delete">삭제</button></div></div>
    <div class="form-grid"><label>이름<input id="name" maxlength="100" value="${escapeHtml(macro.name)}"></label><label>시작 단축키 (준비 중)<input id="hotkey" value="${escapeHtml(macro.hotkey)}" placeholder="ctrl+alt+q"></label><label>프로세스 이름<input id="process" value="${escapeHtml(macro.target_window.process_name || '')}" placeholder="example.exe"></label><label>창 제목 포함<input id="title" value="${escapeHtml(macro.target_window.title_contains || '')}"></label><label class="checkbox"><input id="enabled" type="checkbox" ${macro.enabled ? 'checked' : ''}> 활성화 설정</label></div>
    <div id="steps">${macro.actions.map((action, index) => `<article class="step-card" data-step="${index}"><div class="section-heading"><strong>${index + 1}. ${escapeHtml(action.type)}</strong><div class="actions"><button data-op="up" ${index === 0 ? 'disabled' : ''}>↑</button><button data-op="down" ${index === macro.actions.length - 1 ? 'disabled' : ''}>↓</button><button data-op="copy">복제</button><button data-op="remove">삭제</button><button data-op="preview">여기부터 미리보기</button></div></div><div class="form-grid">${fields(action)}</div></article>`).join('')}</div>
    <div class="editor-actions"><select id="action-type" aria-label="추가할 단계 유형">${['wait', 'key', 'text', 'mouse_move', 'click', 'repeat', 'stop'].map((type) => `<option>${type}</option>`).join('')}</select><button id="add">단계 추가</button><button id="save" class="button primary">암호화 저장</button><button id="preview" class="button ghost">전체 미리보기</button></div>`;
  for (const [id, field] of [['name', 'name'], ['hotkey', 'hotkey']]) $(`#${id}`).oninput = (event) => { macro[field] = event.target.value; changed(); renderList(); };
  $('#process').oninput = (event) => { macro.target_window.process_name = event.target.value; changed(); };
  $('#title').oninput = (event) => { macro.target_window.title_contains = event.target.value; changed(); };
  $('#enabled').onchange = (event) => { macro.enabled = event.target.checked; changed(); renderList(); };
  $('#duplicate').onclick = () => { if (!validFields()) return; const copy = structuredClone(macro); copy.id = crypto.randomUUID(); copy.name += ' 복사'; copy.enabled = false; copy.hotkey = ''; documentData.macros.push(copy); selectedId = copy.id; changed(); render(); };
  $('#delete').onclick = () => { if (!confirm(`“${macro.name}” 매크로를 삭제할까요?`)) return; documentData.macros = documentData.macros.filter((item) => item.id !== selectedId); selectedId = documentData.macros[0]?.id; changed(); render(); void save(); };
  $('#add').onclick = () => { if (!validFields()) return; macro.actions.push(defaults($('#action-type').value)); changed(); render(); };
  $('#save').onclick = save;
  $('#preview').onclick = () => preview(0);
  $('#steps').querySelectorAll('.step-card').forEach((row, index) => {
    row.querySelectorAll('[data-field]').forEach((input) => { input.oninput = () => {
      const field = input.dataset.field;
      try {
        const value = field === 'actions' ? JSON.parse(input.value) : input.type === 'number' ? (input.value === '' ? NaN : Number(input.value)) : input.value;
        if (field === 'actions' && !Array.isArray(value)) throw new Error('배열이 필요합니다.');
        macro.actions[index][field] = value; input.setCustomValidity(''); changed();
      } catch { dirty = true; input.setCustomValidity('유효한 액션 JSON 배열을 입력하세요.'); log('반복 내부 JSON이 올바르지 않습니다.'); }
    }; });
    row.querySelectorAll('[data-op]').forEach((button) => { button.onclick = () => {
      const op = button.dataset.op;
      if (op === 'preview') { void preview(index); return; }
      if (!validFields()) return;
      if (op === 'copy') macro.actions.splice(index + 1, 0, structuredClone(macro.actions[index]));
      if (op === 'remove') macro.actions.splice(index, 1);
      if (op === 'up') [macro.actions[index - 1], macro.actions[index]] = [macro.actions[index], macro.actions[index - 1]];
      if (op === 'down') [macro.actions[index + 1], macro.actions[index]] = [macro.actions[index], macro.actions[index + 1]];
      changed(); render();
    }; });
  });
  if (backend) update(backend);
}
function validFields() { const invalid = $('#editor').querySelector(':invalid'); if (invalid) { invalid.reportValidity(); return false; } return true; }
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
$('#new-button').onclick = () => { if (!validFields()) return; const macro = { id: crypto.randomUUID(), name: '새 매크로', description: '', enabled: false, hotkey: '', target_window: {}, actions: [defaults('wait')] }; documentData.macros.push(macro); selectedId = macro.id; changed(); render(); };
$('#pause-button').onclick = () => request('pause');
$('#stop-button').onclick = () => request('stop');
window.americano.onState(update);
window.addEventListener('beforeunload', (event) => { if (dirty && !confirm('저장하지 않은 변경사항을 버리고 종료할까요?')) { event.preventDefault(); event.returnValue = false; } });
request('state').then((state) => { if (!state) return; documentData = state.document; selectedId = documentData.macros[0]?.id; render(); log(state.error || '로컬 암호화 저장소를 불러왔습니다.'); });
