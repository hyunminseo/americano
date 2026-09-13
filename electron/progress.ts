interface MacroAction {
  type: string;
  actions?: MacroAction[];
  test?: MacroAction;
  then?: MacroAction[];
  else?: MacroAction[];
  action?: MacroAction;
}
interface FlatRow {
  key: string;
  depth: number;
  label: string;
}
interface ProgressMacro {
  name: string;
  actions: MacroAction[];
}
interface ProgressRun {
  status: string;
  iteration?: number;
  iterations?: number;
  step?: (string | number)[];
  error?: string;
}
interface ProgressApi {
  macroProgress: {
    onProgress: (callback: (data: { macro: ProgressMacro | null | undefined; run: ProgressRun }) => void) => void;
  };
}
const progressApi = (window as unknown as ProgressApi).macroProgress;
const labels: Record<string, string> = { wait: '대기', random_wait: '랜덤 대기', key: '키 입력', text: '문자 입력', mouse_move: '마우스 이동', click: '클릭', scroll: '스크롤', image_detect: '이미지 확인', image_wait: '이미지 대기', image_click: '이미지 클릭', retry: '재시도', condition: '조건 분기', repeat: '반복', stop: '중단' };
function flatten(items: MacroAction[], prefix: (string | number)[] = []): FlatRow[] {
  const rows: FlatRow[] = [];
  items.forEach((action: MacroAction, index: number): void => {
    const step: (string | number)[] = [...prefix, index];
    rows.push({ key: step.join('.'), depth: prefix.length, label: `${step.map((p: string | number): string | number => (typeof p === 'number' ? p + 1 : p)).join('.')}. ${labels[action.type] || action.type}` });
    if (action.type === 'repeat') rows.push(...flatten(action.actions as MacroAction[], step));
    if (action.type === 'condition') {
      rows.push(...flatten([action.test as MacroAction], [...step, 'test']));
      rows.push(...flatten(action.then as MacroAction[], [...step, 'then']));
      rows.push(...flatten(action.else as MacroAction[], [...step, 'else']));
    }
    if (action.type === 'retry') rows.push(...flatten([action.action as MacroAction], [...step, 'action']));
  });
  return rows;
}
function render({ macro, run }: { macro: ProgressMacro | null | undefined; run: ProgressRun }): void {
  (document.querySelector('#macro-name') as HTMLElement).textContent = macro ? macro.name : '매크로 없음';
  const status: string = run.status === 'RUNNING' ? `실행 중 · 반복 ${run.iteration || 0}/${run.iterations || 1}` : ({ STOPPED: '대기', PAUSED: '일시정지', ERROR: '실행 오류' } as Record<string, string>)[run.status] || run.status;
  (document.querySelector('#run-status') as HTMLElement).textContent = status;
  const current: string | null = run.step ? run.step.join('.') : null;
  const list = document.querySelector('#steps') as HTMLElement;
  list.innerHTML = '';
  for (const row of flatten(macro ? macro.actions : [])) {
    const item: HTMLLIElement = document.createElement('li');
    if (row.key === current) item.className = 'current';
    item.style.marginLeft = `${row.depth * 14}px`;
    item.textContent = row.label;
    list.appendChild(item);
  }
  (document.querySelector('#run-error') as HTMLElement).textContent = run.error || '';
  const active = document.querySelector('#steps li.current') as HTMLElement | null;
  if (active) active.scrollIntoView({ block: 'nearest' });
}
progressApi.onProgress(render);
