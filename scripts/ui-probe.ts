// 전체 재현 프로브: 실제 창을 대상으로 캡처→저장→카드 버튼→AI 버튼을 실구동으로 확인한다.
// electron compiled/scripts/ui-probe.js
import { app, BrowserWindow } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'americano-ui-probe-')));
require('../electron/main.js');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(check: () => Promise<T | null | undefined | false>, attempts = 600): Promise<T> {
  for (let i = 0; i < attempts; i += 1) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error('프로브 시간 초과');
}

app.whenReady().then(async (): Promise<void> => {
  const results: Record<string, string> = {};
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try { await fn(); results[name] = 'PASS'; }
    catch (error) { results[name] = `FAIL: ${(error as Error).message}`; }
  };
  let target: BrowserWindow | null = null;
  try {
    results['app-path'] = app.getAppPath();
    const main = await until(() => Promise.resolve(BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/index.html'))));
    await until(() => main.webContents.executeJavaScript('Boolean(backend?.storageReady)') as Promise<boolean>);
    const js = (code: string): Promise<any> => main.webContents.executeJavaScript(code);
    const logLine = (): Promise<string> => js(`document.querySelector('#log-line').textContent`);
    // 실제 대상 창을 띄운다.
    target = new BrowserWindow({ width: 500, height: 400, show: false });
    await target.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><head><title>Americano Probe Target ${process.pid}</title></head><body><h1>target</h1></body></html>`));
    target.showInactive();
    await js(`createMacro(); current().target_window = {title_contains:'Americano Probe Target',process_name:'electron.exe'}; changed(); render();`);
    await js(`window.americano.request('overlay-auto', {macro: current()}).then(r => { if (r.ok) { Object.assign(current(), r.macro); changed(); render(); } })`);
    await sleep(1000);
    await check('overlay-auto', async () => {
      const overlay = await js(`JSON.stringify(current().overlay)`);
      if (overlay === 'null') throw new Error('오버레이 없음: ' + await logLine());
    });
    // 오버레이 영역 설정 버튼 클릭 → 선택 → 저장
    await check('capture-open-select-save', async () => {
      await js(`document.querySelector('#capture-open').click()`);
      const overlayWin = await until(() => Promise.resolve(BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/capture-overlay.html')))).catch(() => null);
      if (!overlayWin) throw new Error('캡처창 미표시: ' + await logLine());
      await until(() => overlayWin.webContents.executeJavaScript('meta.width > 1') as Promise<boolean>);
      await overlayWin.webContents.executeJavaScript(`window.captureOverlay.select({x:10,y:10,width:200,height:150})`);
      await until(() => main.webContents.executeJavaScript('Boolean(current()?.overlay && !dirty && !saving)') as Promise<boolean>);
    });
    // 영역 안에서 이미지 캡처 버튼 클릭 → 자산 생성 확인
    await check('capture-image', async () => {
      await js(`document.querySelector('#capture-image').click()`);
      await until(() => main.webContents.executeJavaScript('Boolean(current()?.images?.length)') as Promise<boolean>);
    });
    // 저장 후 카드 버튼들
    await check('save-then-cards', async () => {
      await js(`document.querySelector('#save').click()`);
      await sleep(800);
      const dirty = await js(`dirty`);
      if (dirty) throw new Error('저장 미완료(dirty 유지): ' + await logLine());
      await js(`document.querySelector('[data-asset-id] [data-op="select"]').click()`);
      await sleep(300);
      const selected = await js(`document.querySelector('.asset-card.selected') !== null`);
      if (!selected) throw new Error('선택 표시 없음: ' + await logLine());
      await js(`document.querySelector('[data-asset-id] [data-op="rename"]').click()`);
      await sleep(300);
      await js(`{ const input = document.querySelector('.asset-rename input'); input.value = '바뀐이름'; input.dispatchEvent(new Event('input')); }`);
      await js(`document.querySelector('[data-op="rename-save"]').click()`);
      await sleep(500);
      const name = await js(`current().images[0].name`);
      if (name !== '바뀐이름') throw new Error('이름 미반영: ' + name + ' / ' + await logLine());
      await js(`document.querySelector('#save').click()`);
      await sleep(800);
      if (await js(`dirty`)) throw new Error('2차 저장 미완료: ' + await logLine());
    });
    // AI 버튼들
    await check('ai-server-start', async () => {
      await js(`document.querySelector('#opencode-start').click()`);
      await sleep(25000);
      const status = await js(`document.querySelector('#opencode-status').textContent`);
      if (!/실행 중/.test(status)) throw new Error('서버 미시작: ' + status + ' / ' + await logLine());
    });
    await check('ai-test', async () => {
      await js(`document.querySelector('#ai-test').click()`);
      await sleep(8000);
      const line = await logLine();
      if (!/연결 성공/.test(line)) throw new Error('연결 테스트 실패: ' + line);
    });
    await check('ai-providers', async () => {
      const count = await js(`document.querySelectorAll('.provider-row').length`);
      if (!count) throw new Error('공급자 목록 없음: ' + await logLine());
    });
    console.log(JSON.stringify(results, null, 1));
  } catch (error) {
    console.log(JSON.stringify({ ...results, fatal: (error as Error).message }, null, 1));
  } finally {
    try { target?.close(); } catch { /* ignore */ }
    app.exit(Object.values(results).some((v) => v.startsWith('FAIL')) ? 1 : 0);
  }
});
