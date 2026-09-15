// 심플 모드 renderer. 매크로 선택/시작/중지만 노출한다. 편집 기능 없음.
interface SimpleMacro {
  id: string;
  name: string;
  target_window: { title_contains?: string; process_name?: string; executable_path?: string };
  [key: string]: unknown;
}

interface SimpleAmericanoApi {
  request(command: string, payload?: unknown): Promise<any>;
  onState(callback: (state: any) => void): () => void;
}

const americanoApi = (): SimpleAmericanoApi => (window as unknown as { americano: SimpleAmericanoApi }).americano;

const $ = (selector: string): HTMLElement => document.querySelector(selector) as HTMLElement;
const USER_MESSAGE = '문제가 발생했습니다. 관리자에게 문의하세요.';

function classifySimpleError(message: unknown): string {
  const text = String(message ?? '');
  if (/라이선스|서명|만료|MAC|장치|authorize|실행 권한/.test(text)) return 'LIC-0001';
  if (/대상 창|전경|최소화|창을 찾|후보|재선택|오버레이 영역을 먼저|범위를 벗어났습니다|관리자 권한/.test(text)) return 'TGT-0001';
  if (/이미지|탐지|검색 timeout|timeout을 초과|재시도|기준 이미지|단계를 찾지/.test(text)) return 'IMG-0001';
  if (/입력|키보드|마우스|클릭|커서|가려져|거부되었습니다|중단했습니다/.test(text)) return 'INP-0001';
  return 'SYS-0001';
}

function targetLabel(macro: SimpleMacro | undefined): string {
  if (!macro) return '';
  const parts = [macro.target_window?.process_name, macro.target_window?.title_contains].filter(Boolean);
  return parts.length ? `대상: ${parts.join(' · ')}` : '대상: 지정 없음 (관리자에게 문의하세요)';
}

let macros: SimpleMacro[] = [];
let selectedId: string | null = localStorage.getItem('americano-simple-selected');
let lastState: any = null;
let lastErrorDetail = '';

function showError(message: string): void {
  const box = $('#error-box');
  const code = classifySimpleError(message);
  lastErrorDetail = String(message || '');
  ($('#error-code') as HTMLElement).textContent = `에러코드: ${code}`;
  ($('#error-time') as HTMLElement).textContent = new Date().toLocaleString('ko-KR');
  const detail = $('#error-detail') as HTMLElement;
  detail.textContent = `원문(관리자용):\n${lastErrorDetail}\n\n${USER_MESSAGE}`;
  detail.hidden = true;
  box.hidden = false;
}

function hideError(): void {
  ($('#error-box') as HTMLElement).hidden = true;
}

function render(state: any): void {
  lastState = state;
  const documentData = state?.document || { macros: [] };
  macros = documentData.macros || [];
  const select = $('#macro-select') as HTMLSelectElement;
  const previous = selectedId && macros.some((item) => item.id === selectedId) ? selectedId : macros[0]?.id || null;
  selectedId = previous;
  select.innerHTML = macros.length
    ? macros.map((item) => `<option value="${item.id}">${item.name.replace(/</g, '&lt;')}</option>`).join('')
    : '<option value="">등록된 매크로가 없습니다</option>';
  if (selectedId) select.value = selectedId;
  const selected = macros.find((item) => item.id === selectedId);
  ($('#target-info') as HTMLElement).textContent = macros.length ? targetLabel(selected) : '관리자가 매크로를 먼저 등록해야 합니다.';

  const run = state?.run || { status: 'STOPPED' };
  const pill = $('#status-pill') as HTMLElement;
  const statusText = run.status === 'RUNNING' ? '실행중' : run.status === 'PAUSED' ? '일시정지됨' : run.status === 'ERROR' ? '오류' : '대기중';
  pill.textContent = statusText;
  pill.classList.toggle('running', run.status === 'RUNNING');
  pill.classList.toggle('error', run.status === 'ERROR');

  const progress = $('#progress-line') as HTMLElement;
  if (run.status === 'RUNNING' || run.status === 'PAUSED') {
    const step = run.step !== null && run.step !== undefined ? `단계 ${run.step}` : '준비 중';
    const iteration = run.iteration && run.iterations ? ` · ${run.iteration}/${run.iterations}회` : '';
    progress.textContent = `${step}${iteration}`;
  } else if (run.status === 'ERROR') {
    progress.textContent = '오류로 중지됨';
  } else if (run.outcome === 'completed' || (run.completed && run.status === 'STOPPED')) {
    progress.textContent = '완료되었습니다';
  } else {
    progress.textContent = '실행 대기';
  }

  ( $('#start-button') as HTMLButtonElement).disabled = !selectedId || run.status === 'RUNNING' || run.status === 'PAUSED';
  ( $('#stop-button') as HTMLButtonElement).disabled = run.status !== 'RUNNING' && run.status !== 'PAUSED';
  (select as HTMLSelectElement).disabled = run.status === 'RUNNING' || run.status === 'PAUSED';

  const license = state?.license;
  ($('#license-line') as HTMLElement).textContent = license
    ? (license.valid ? '라이선스 인증됨' : `라이선스 문제: ${license.message || '확인 필요'}`)
    : (state?.error || '');
  const licenseStatus = $('#license-status') as HTMLElement;
  if (!license) {
    licenseStatus.textContent = '확인 중';
    licenseStatus.classList.remove('running', 'error');
  } else if (license.valid) {
    licenseStatus.textContent = '활성화됨';
    licenseStatus.classList.add('running');
    licenseStatus.classList.remove('error');
  } else {
    licenseStatus.textContent = '미활성화';
    licenseStatus.classList.add('error');
    licenseStatus.classList.remove('running');
  }

  if (run.status === 'ERROR' && run.error) showError(run.error as string);
  else if (state?.error && !macros.length) showError(state.error as string);
  else if (run.status !== 'ERROR') hideError();
}

async function request(command: string, payload?: unknown): Promise<any> {
  try {
    const result = await americanoApi().request(command, payload);
    if (result && result.ok === false && result.error) showError(result.error as string);
    return result;
  } catch (error) {
    showError((error as Error).message);
    return null;
  }
}

window.addEventListener('error', (event: ErrorEvent) => {
  try { showError(event.message); } catch { /* ignore */ }
});

($('#macro-select') as HTMLSelectElement).onchange = (event: Event): void => {
  selectedId = (event.target as HTMLSelectElement).value || null;
  if (selectedId) localStorage.setItem('americano-simple-selected', selectedId);
  if (lastState) render(lastState);
};

($('#start-button') as HTMLButtonElement).onclick = async (): Promise<void> => {
  if (!selectedId) return;
  hideError();
  await request('start', { macroId: selectedId });
};

($('#stop-button') as HTMLButtonElement).onclick = async (): Promise<void> => {
  await request('stop');
};

($('#error-copy') as HTMLButtonElement).onclick = async (): Promise<void> => {
  const code = ($('#error-code') as HTMLElement).textContent || '';
  const time = ($('#error-time') as HTMLElement).textContent || '';
  try {
    await navigator.clipboard.writeText(`${USER_MESSAGE}\n${code}\n${time}\n상세: ${lastErrorDetail}`);
    (($('#error-copy') as HTMLButtonElement)).textContent = '복사됨';
    setTimeout(() => { (($('#error-copy') as HTMLButtonElement)).textContent = '에러코드 복사'; }, 1500);
  } catch {
    (($('#error-copy') as HTMLButtonElement)).textContent = '복사 실패';
  }
};

($('#error-detail-toggle') as HTMLButtonElement).onclick = (): void => {
  const detail = $('#error-detail') as HTMLElement;
  detail.hidden = !detail.hidden;
};

($('#license-register') as HTMLButtonElement).onclick = async (): Promise<void> => {
  await request('license-import');
};

($('#admin-open') as HTMLButtonElement).onclick = async (): Promise<void> => {
  await request('admin-open');
};

americanoApi().onState(render);
void request('state').then((state) => { if (state?.state) render(state.state); else if (state) render(state); });
