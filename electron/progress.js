const labels = { wait: '대기', key: '키 입력', text: '문자 입력', mouse_move: '마우스 이동', click: '클릭', scroll: '스크롤', image_detect: '이미지 확인', image_wait: '이미지 대기', image_click: '이미지 클릭', retry: '재시도', condition: '조건 분기', repeat: '반복', stop: '중단' };
function flatten(items, prefix = []) {
  const rows = [];
  items.forEach((action, index) => {
    const step = [...prefix, index];
    rows.push({ key: step.join('.'), depth: prefix.length, label: `${step.map((p) => (typeof p === 'number' ? p + 1 : p)).join('.')}. ${labels[action.type] || action.type}` });
    if (action.type === 'repeat') rows.push(...flatten(action.actions, step));
    if (action.type === 'condition') {
      rows.push(...flatten([action.test], [...step, 'test']));
      rows.push(...flatten(action.then, [...step, 'then']));
      rows.push(...flatten(action.else, [...step, 'else']));
    }
    if (action.type === 'retry') rows.push(...flatten([action.action], [...step, 'action']));
  });
  return rows;
}
function render({ macro, run }) {
  document.querySelector('#macro-name').textContent = macro ? macro.name : '매크로 없음';
  const status = run.status === 'RUNNING' ? `실행 중 · 반복 ${run.iteration || 0}/${run.iterations || 1}` : { STOPPED: '대기', PAUSED: '일시정지', ERROR: '실행 오류' }[run.status] || run.status;
  document.querySelector('#run-status').textContent = status;
  const current = run.step ? run.step.join('.') : null;
  const list = document.querySelector('#steps');
  list.innerHTML = '';
  for (const row of flatten(macro ? macro.actions : [])) {
    const item = document.createElement('li');
    if (row.key === current) item.className = 'current';
    item.style.marginLeft = `${row.depth * 14}px`;
    item.textContent = row.label;
    list.appendChild(item);
  }
  document.querySelector('#run-error').textContent = run.error || '';
  const active = document.querySelector('#steps li.current');
  if (active) active.scrollIntoView({ block: 'nearest' });
}
window.macroProgress.onProgress(render);
