import { app, BrowserWindow, globalShortcut, ipcMain, safeStorage, dialog, screen, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import sharp from 'sharp';
import { MacroStore } from '../src/store.js';
import { MacroRunner, RunControl } from '../src/runner.js';
import type { TemplateMatch, SearchControl } from '../src/runner.js';
import { exportMacro, importMacro, readPackage, rebindOverlay } from '../src/portable.js';
import { LicenseManager, readDeviceMacs, readLimited } from '../src/license.js';
import { matchCandidates } from '../src/detect.js';
import type { MatchCandidate, NccMatch } from '../src/detect.js';
import { createInputAdapter } from '../src/input-adapter.js';
import { listWindows, findWindow } from '../src/windows.js';
import { captureTarget, physicalRegion } from '../src/overlay.js';
import { validateDocument, newMacro, MacroAction, MacroDocument, Region, applyPerfTuning } from '../src/macros.js';
import { resolveScale, effectivePercent, remapRect, learnRoi } from '../src/resolution.js';
import { scaleTemplate } from '../src/detect.js';
import { authedFetch, connectOpencode, serverVersion, listProviders, startLogin, finishLogin, setApiKey, isConnected, OpencodeV2Client, ProviderInfo } from '../src/opencode.js';
import { fullClientOverlay } from '../src/overlay.js';
import { readGameGeometry } from '../src/windows.js';
import { geometry } from '../src/native-windows.js';

const variant: string = (require('../package.json') as { americanoVariant?: string }).americanoVariant || 'standard';
if (['mac-match', 'mac-mismatch'].includes(variant)) app.setPath('userData', path.join(app.getPath('appData'), `Americano-${variant}`));

let mainWindow: BrowserWindow | undefined;
let store: MacroStore | undefined;
let runner: MacroRunner;
let license: LicenseManager;
let licenseTimer: NodeJS.Timeout;
let captureOverlay: BrowserWindow | undefined;
let captureBuffer: Buffer | undefined;
let captureMeta: { width: number; height: number; dpi: number; mode: string; macroId: string; offset: Region } | undefined;
let captureOpening = false;
let captureSaving = false;
let outline: BrowserWindow | undefined;
let outlineTimer: NodeJS.Timeout | undefined;
let progressWindow: BrowserWindow | null = null;
let progressMacroId: string | null = null;
// 실행 통계·자동 최적화 요약. 실행이 끝날 때 갱신되고 화면에 보여준다.
let lastPerf: string | null = null;
let lastTuning: string[] = [];
let lastRunStatus = 'STOPPED';
let lastRunId: string | null = null;

function displayStep(key: string): string {
  return key.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) + 1 : (({ test: '검사', then: '참', else: '거짓', action: '재시도' }) as Record<string, string>)[part] || part)).join('.');
}

// 실행 종료 시 통계를 누적하고 성능 요약을 만든다. 미리보기는 제외한다.
async function persistRunStats(run: ReturnType<MacroRunner['state']>): Promise<void> {
  try {
    if (run.preview || !run.macroId || !store?.ready) return;
    const entries = runner.runStats();
    if (!entries.length) return;
    await (store as MacroStore).updateRunStats(run.macroId, entries);
    const visits = entries.length;
    const scans = entries.reduce((total, entry) => total + entry.scans, 0);
    const ms = entries.reduce((total, entry) => total + entry.ms, 0);
    const slowest = entries.reduce((worst, entry) => (entry.ms > worst.ms ? entry : worst), entries[0]);
    const parts = [`${visits}단계`, `탐색 ${scans}회`, `${(ms / 1000).toFixed(1)}초`, `가장 느림 ${displayStep(slowest.key)}(${(slowest.ms / 1000).toFixed(1)}초)`];
    if (lastTuning.length) parts.push(`탐색간격 자동조정 ${lastTuning.length}건`);
    lastPerf = parts.join(' · ');
  } catch { /* 통계 저장 실패는 실행 결과에 영향을 주지 않는다. */ }
}

function closeProgress(): void {
  if (progressWindow && !progressWindow.isDestroyed()) progressWindow.destroy();
  progressWindow = null;
  progressMacroId = null;
}

function pushProgress(state: BackendState): void {
  if (!progressWindow || progressWindow.isDestroyed() || !progressMacroId) return;
  const macro = state.document.macros.find((item) => item.id === progressMacroId) || null;
  if (!macro) { progressWindow.webContents.send('macro-progress', { macro: null, run: state.run }); return; }
  progressWindow.webContents.send('macro-progress', { macro, run: state.run });
}

function closeOutline(): void {
  if (outlineTimer) clearInterval(outlineTimer);
  outlineTimer = undefined;
  if (outline && !outline.isDestroyed()) outline.destroy();
  outline = undefined;
}

// 실제 클릭 지점에 0.8초 동안 녹색 링을 표시한다. 자동화 흐름을 바꾸지 않는다.
function flashClick(point: { x: number; y: number }): void {
  try {
    const marker = new BrowserWindow({
      x: Math.round(point.x - 22), y: Math.round(point.y - 22), width: 44, height: 44,
      show: false, frame: false, transparent: true, focusable: false, skipTaskbar: true, alwaysOnTop: true, resizable: false, movable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    marker.setIgnoreMouseEvents(true);
    marker.setAlwaysOnTop(true, 'screen-saver');
    marker.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><body style="margin:0"><div style="width:36px;height:36px;margin:4px;border:5px solid #22c55e;border-radius:50%;box-sizing:border-box"></div></body></html>'));
    marker.showInactive();
    setTimeout(() => { if (!marker.isDestroyed()) marker.close(); }, 800).unref();
  } catch { /* 표시는 실패해도 클릭을 막지 않는다. */ }
}

// 탐지에 성공한 프레임을 근거로 저장한다. 최신 30개만 유지하며 실패해도 무시한다.
async function saveMatchShot(framePng: Buffer, match: TemplateMatch, label: string): Promise<void> {
  try {
    const dir = path.join(app.getPath('userData'), 'match-shots');
    await fs.promises.mkdir(dir, { recursive: true });
    const meta = await sharp(framePng).metadata();
    const cx = match.x + match.width / 2;
    const cy = match.y + match.height / 2;
    const overlay = `<svg width="${meta.width}" height="${meta.height}"><rect x="${match.x}" y="${match.y}" width="${match.width}" height="${match.height}" fill="none" stroke="lime" stroke-width="3"/><circle cx="${cx}" cy="${cy}" r="6" fill="red"/><text x="${match.x}" y="${Math.max(16, match.y - 6)}" fill="lime" font-size="18">${label} ${match.score.toFixed(3)}</text></svg>`;
    const annotated = await sharp(framePng).composite([{ input: Buffer.from(overlay), left: 0, top: 0 }]).png().toBuffer();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.promises.writeFile(path.join(dir, `${stamp}-${label}-${match.score.toFixed(3)}.png`), annotated);
    const files = (await fs.promises.readdir(dir)).sort();
    await Promise.all(files.slice(0, Math.max(0, files.length - 30)).map((file) => fs.promises.unlink(path.join(dir, file)).catch(() => {})));
  } catch { /* 근거 저장은 실행에 영향을 주지 않는다. */ }
}

async function showOutline(macro: MacroDocument): Promise<void> {
  closeOutline();
  if (!macro.overlay) throw new Error('오버레이 영역을 먼저 저장하세요.');
  const window = new BrowserWindow({ show: false, frame: false, transparent: true, focusable: false, skipTaskbar: true, alwaysOnTop: true, resizable: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  outline = window;
  window.setIgnoreMouseEvents(true);
  window.setAlwaysOnTop(true, 'screen-saver');
  await window.loadFile(path.join(__dirname, 'overlay-outline.html'));
  let pending = false;
  const track = async (): Promise<void> => {
    if (pending || window.isDestroyed()) return;
    pending = true;
    try {
      const target = await findWindow(macro.target_window, 0);
      const region = physicalRegion(geometry(target.handle), macro.overlay as Region);
      if (window.isDestroyed()) return;
      const bounds = screen.screenToDipRect(null, region);
      window.setBounds({ x: bounds.x - 2, y: bounds.y - 2, width: bounds.width + 4, height: bounds.height + 4 });
      window.showInactive();
    } catch { if (!window.isDestroyed()) window.hide(); }
    finally { pending = false; }
  };
  await track();
  if (!window.isDestroyed()) outlineTimer = setInterval(track, 100);
}

let currentMacs: string[] = [];
let identityRefreshing = false;
async function refreshIdentity(): Promise<void> {
  if (identityRefreshing) return;
  identityRefreshing = true;
  try { currentMacs = await readDeviceMacs(); } finally { identityRefreshing = false; }
}

let startupError: string | null = null;
let shortcutsReady = false;
let f7Ready = false;
let quitting = false;
let shutdownPromise: Promise<boolean> | null = null;
const shutdownDeadlineMs = 5000;
const page = pathToFileURL(path.join(__dirname, 'index.html')).href;

interface BackendState {
  document: { version: 2; macros: MacroDocument[] };
  run: ReturnType<MacroRunner['state']>;
  perf: string | null;
  error: string | null;
  storageReady: boolean;
  shortcutsReady: boolean;
  f7Ready: boolean;
  executionAvailable: boolean;
  license: ReturnType<LicenseManager['state']>;
  variant: string;
  executionReason: string;
}

function state(): BackendState {
  return {
    document: store?.ready ? store.snapshot() : { version: 2, macros: [] },
    run: runner.state(),
    perf: lastPerf,
    error: startupError,
    storageReady: Boolean(store?.ready),
    shortcutsReady,
    f7Ready,
    executionAvailable: shortcutsReady,
    license: license.state(),
    variant,
    executionReason: license.state().valid ? '라이선스 인증 완료. 선택한 대상 창에서 실행할 수 있습니다.' : (license.state().message as string),
  };
}

function notify(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const current = state();
    const run = current.run;
    if (lastRunStatus === 'RUNNING' && (run.status === 'STOPPED' || run.status === 'ERROR') && lastRunId && run.runId === lastRunId) {
      void persistRunStats(run).then(() => notify());
    }
    lastRunStatus = run.status;
    lastRunId = run.runId;
    mainWindow.webContents.send('backend-state', current);
    pushProgress(current);
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180, height: 850, minWidth: 900, minHeight: 650, backgroundColor: '#f5f1ea',
    icon: path.join(__dirname, 'assets', 'coffee.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.on('closed', () => { if (!quitting) app.quit(); });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.loadURL(page);
}

async function openCaptureOverlay(payload: { mode?: string; macro: Record<string, unknown> }): Promise<void> {
  if (runner.active) throw new Error('실행을 중지한 뒤 캡처하세요.');
  if (captureOverlay || captureOpening || captureSaving) throw new Error('이미 오버레이를 편집 중입니다.');
  captureOpening = true;
  try {
    const mode = payload.mode === 'image' ? 'image' : 'region';
    const macro = validateDocument({ version: 2, macros: [payload.macro] }).macros[0];
    if (mode === 'image' && !macro.overlay) throw new Error('오버레이 영역을 먼저 설정하세요.');
    const frame = await captureTarget(macro.target_window, mode === 'image' ? macro.overlay : null);
    captureBuffer = frame.buffer;
    const metadata = await sharp(captureBuffer).metadata();
    captureMeta = { width: metadata.width as number, height: metadata.height as number, dpi: frame.dpi, mode, macroId: macro.id, offset: mode === 'image' ? (macro.overlay as Region) : { x: 0, y: 0, width: 0, height: 0 } };
    const bounds = screen.screenToDipRect(null, frame.region);
    captureOverlay = new BrowserWindow({
      ...bounds, frame: false, transparent: true, resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, 'overlay-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    captureOverlay.setAlwaysOnTop(true, 'screen-saver');
    captureOverlay.on('closed', () => { captureOverlay = undefined; captureBuffer = undefined; captureMeta = undefined; });
    await captureOverlay.loadURL(pathToFileURL(path.join(__dirname, 'capture-overlay.html')).href);
    captureOverlay.webContents.send('capture-overlay-data', { preview: 'data:image/png;base64,' + (captureBuffer as Buffer).toString('base64'), ...captureMeta });
  } catch (error) {
    if (captureOverlay && !captureOverlay.isDestroyed()) captureOverlay.destroy();
    throw error;
  } finally { captureOpening = false; }
}

// AI 설정: 모델과 에이전트만 저장한다. 인증은 opencode 로그인을 쓴다.
interface AiConfigFull {
  model: string;
  agent: string;
}

function aiFile(): string {
  return path.join(app.getPath('userData'), 'ai.json');
}

async function readAiConfigFull(): Promise<AiConfigFull> {
  try {
    const raw = JSON.parse(await fs.promises.readFile(aiFile(), 'utf8')) as Partial<AiConfigFull>;
    return {
      model: String(raw.model || ''),
      agent: String(raw.agent || ''),
    };
  } catch {
    return { model: '', agent: '' };
  }
}

async function readAiConfig(): Promise<{ model: string; agent: string }> {
  const full = await readAiConfigFull();
  return { model: full.model, agent: full.agent };
}

// opencode 공식 SDK(@opencode-ai/sdk/v2)로 로컬 서버에 연결한다. ESM 전용이라 동적 import한다.
async function opencodeClient(baseUrl: string, password?: string): Promise<OpencodeV2Client> {
  return connectOpencode(baseUrl, password ? authedFetch(password) : undefined);
}

function sdkData<T>(result: unknown): T {
  const data = (result as { data?: T } | undefined)?.data;
  return (data ?? result) as T;
}

async function opencodeStatus(): Promise<{ running: boolean; version: string; url: string | null; managed: boolean }> {
  try {
    if (opencodeUrl) {
      const version = await healthCheck(opencodeUrl, opencodeManaged ? (opencodePassword as string) : undefined);
      if (version) return { running: true, version, url: opencodeUrl, managed: opencodeManaged };
    }
    const embedded = await healthCheck('http://127.0.0.1:4096');
    if (embedded) {
      opencodeUrl = 'http://127.0.0.1:4096';
      opencodeManaged = false;
      return { running: true, version: embedded, url: opencodeUrl, managed: false };
    }
    return { running: false, version: '', url: null, managed: false };
  } catch {
    return { running: false, version: '', url: null, managed: false };
  }
}

async function promptOpencode(model: string, system: string, user: string, agent?: string): Promise<unknown> {
  const slash = model.indexOf('/');
  const providerID = slash >= 0 ? model.slice(0, slash) : '';
  const modelID = slash >= 0 ? model.slice(slash + 1) : '';
  if (!providerID || !modelID) throw new Error('모델은 "제공자/모델" 형식이어야 합니다. 예: anthropic/claude-3-5-sonnet-20241022');
  const { client } = await opencodeConnect();
  const created = await client.session.create({ title: 'Americano 말로 만들기' });
  if (created.error || !created.data?.id) throw new Error(`opencode 세션을 만들지 못했습니다: ${JSON.stringify(created.error || 'unknown').slice(0, 200)}`);
  const sessionId = created.data.id;
  try {
    const replied = await client.session.prompt({
      sessionID: sessionId,
      model: { providerID, modelID },
      ...(agent ? { agent } : {}),
      system,
      parts: [{ type: 'text', text: user }],
      format: { type: 'json_schema', schema: ACTION_SCHEMA, retryCount: 2 },
    });
    if (replied.error) throw new Error(`opencode 호출 실패: ${JSON.stringify(replied.error).slice(0, 200)}`);
    const info = replied.data?.info;
    if (info?.error) throw new Error(`AI 출력 실패: ${info.error.message || info.error.name}`);
    if (info?.structured === undefined) throw new Error('AI 응답에 구조화된 출력이 없습니다.');
    return info.structured;
  } finally {
    await client.session.delete({ sessionID: sessionId }).catch(() => {});
  }
}

const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    actions: {
      type: 'array',
      description: '매크로 단계 목록. 허용 타입: image_click, image_wait, wait(duration_ms 필수), key(keys 필수), repeat(count와 actions 필수). image에는 보관함 이름을 그대로 적는다.',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', description: '동작 종류' },
          image: { type: 'string', description: '보관함 이미지 이름' },
          duration_ms: { type: 'number' },
          keys: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['type'],
        additionalProperties: true,
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['actions'],
};

// opencode.json slash-command 방식과 같은 템플릿. SDK든 HTTP든 같은 JSON 계약을 쓴다.
function aiPrompt(images: string[], text: string): { system: string; user: string } {
  const system = [
    '너는 게임 매크로 단계 생성기다. 반드시 JSON {"actions": [...], "warnings": [...]}만 출력한다.',
    '허용 타입: image_click(이미지 나타나면 누르기), image_wait(나타날 때까지 기다리기), wait(고정 대기, duration_ms 필수), key(키 입력, keys 필수: space/enter/esc 등 소문자), repeat(반복, count와 actions 필수).',
    '이미지를 쓰는 동작은 image 필드에 아래 보관함 이름 중 하나를 그대로 적는다. 이미지는 사용자가 직접 캡처한 것만 쓰고, 없는 이름은 절대 만들지 말고 해당 줄은 빼고 warnings에 적는다.',
    'repeat는 전체를 감싸는 용도로만 쓰고 한 번만 쓴다. 설명 문장을 넣지 않는다.',
  ].join('\n');
  const user = [`보관함: ${images.length ? images.join(', ') : '(비어 있음)'}`, `요청:\n${text}`].join('\n');
  return { system, user };
}

// 말로 만들기의 AI 경로: 보관함 이름 기준으로 동작 초안을 받아 검증까지 마친다.
async function generateActions(text: string, macroId: string, images: string[], overlay: Region | null): Promise<{ actions: MacroAction[]; warnings: string[] }> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('만들 동작을 먼저 적으세요.');
  const config = await readAiConfigFull();
  const { system, user } = aiPrompt(images, trimmed);
  let parsed: unknown;
  if (!config.model) throw new Error('모델을 "제공자/모델" 형식으로 저장하세요. 예: anthropic/claude-3-5-sonnet-20241022');
  parsed = await promptOpencode(config.model, system, user, config.agent || undefined);
  return finalizeAiActions(parsed, macroId, overlay);
}

function finalizeAiActions(parsed: unknown, macroId: string, overlay: Region | null): { actions: MacroAction[]; warnings: string[] } {
  const input = (parsed || {}) as { actions?: Record<string, unknown>[]; warnings?: string[] };
  const warnings = [...(input.warnings || [])];
  const missing: string[] = [];
  const actions: MacroAction[] = [];
  for (const raw of input.actions || []) {
    try {
      const resolved = resolveActionImages(raw, macroId, missing);
      if (overlay && typeof resolved === 'object') {
        (resolved as Record<string, unknown>).region = (resolved as Record<string, unknown>).region ?? { x: 0, y: 0, width: overlay.width, height: overlay.height };
      }
      const checked = validateDocument({ version: 2, macros: [{ ...newMacro(), actions: [resolved] }] }).macros[0].actions[0];
      actions.push(checked);
    } catch (error) {
      warnings.push(`빼고 만듦: ${(error as Error).message}`);
    }
  }
  if (missing.length) warnings.push(`보관함에 없는 이미지(${missing.join(', ')})는 비워 두었습니다. 화면에서 직접 캡처한 뒤 지정하세요.`);
  return { actions, warnings };
}

// AI가 적은 보관함 "이름"을 같은 매크로 자산 경로로 바꾼다.
// 보관함에 없는 이름은 missing에 모아 "직접 캡처" 경고로 돌려준다.
function resolveActionImages(raw: Record<string, unknown>, macroId: string, missing: string[]): Record<string, unknown> {
  const macro = (store as MacroStore | undefined)?.snapshot().macros.find((item) => item.id === macroId);
  const assets = macro?.images || [];
  const toPath = (name: unknown): string => {
    if (typeof name !== 'string' || !name) return '';
    const exact = assets.find((asset) => asset.name === name);
    if (exact) return exact.path;
    const fuzzy = assets.find((asset) => asset.name.includes(name) || name.includes(asset.name));
    if (fuzzy) return fuzzy.path;
    if (!missing.includes(name)) missing.push(name);
    return '';
  };
  const out = { ...(raw as Record<string, unknown>) };
  if (typeof out.image === 'string') out.image = toPath(out.image);
  if (Array.isArray(out.alt_images)) out.alt_images = (out.alt_images as unknown[]).filter((ref) => typeof ref === 'string').map(toPath).filter(Boolean).slice(0, 2);
  if (typeof out.expect_image === 'string') out.expect_image = toPath(out.expect_image);
  if (out.test && typeof out.test === 'object') out.test = resolveActionImages(out.test as Record<string, unknown>, macroId, missing);
  for (const branch of ['then', 'else', 'actions'] as const) {
    if (Array.isArray(out[branch])) out[branch] = (out[branch] as Record<string, unknown>[]).map((item) => resolveActionImages(item, macroId, missing));
  }
  if (out.action && typeof out.action === 'object') out.action = resolveActionImages(out.action as Record<string, unknown>, macroId, missing);
  return out;
}

// 내장 opencode 서버 생명주기. 바이너리는 빌드 때 vendor/에 받아 extraResources로 들어간다.
let opencodeProc: ChildProcess | null = null;
let opencodePassword: string | null = null;
let opencodeUrl: string | null = null;
let opencodeManaged = false;

function opencodeBinary(): string | null {
  const candidates = [
    path.join(process.resourcesPath, 'opencode', 'opencode.exe'),
    path.join(app.getAppPath(), 'vendor', 'opencode', 'opencode.exe'),
  ];
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch { /* 다음 후보 */ }
  }
  return null;
}

async function healthCheck(baseUrl: string, password?: string): Promise<string | null> {
  try {
    const client = await opencodeClient(baseUrl, password);
    return await serverVersion(client);
  } catch {
    return null;
  }
}

// AI용 서버 URL을 확보한다. 떠 있는 내 서버가 있으면 쓰고,
// 없으면 내장 바이너리로 서버를 띄운다. {url, managed}를 돌려준다.
async function ensureOpencodeServer(): Promise<{ url: string; managed: boolean }> {
  if (opencodeUrl && opencodeProc && !opencodeProc.killed) {
    const version = await healthCheck(opencodeUrl, opencodePassword || undefined);
    if (version) return { url: opencodeUrl, managed: opencodeManaged };
  }
  const embeddedHealth = await healthCheck('http://127.0.0.1:4096');
  if (embeddedHealth) {
    opencodeUrl = 'http://127.0.0.1:4096';
    opencodeManaged = false;
    return { url: opencodeUrl, managed: false };
  }
  const binary = opencodeBinary();
  if (!binary) throw new Error('내장 opencode가 없습니다. 빌드 때 npm run fetch:opencode를 실행하세요.');
  opencodePassword = crypto.randomBytes(24).toString('base64');
  const ports = [4096, 4097, 4098];
  for (const port of ports) {
    opencodeProc = spawn(binary, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: opencodePassword },
    });
    const started = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 20000);
      const tick = async (): Promise<void> => {
        const version = await healthCheck(`http://127.0.0.1:${port}`, opencodePassword as string);
        if (version) { clearTimeout(timer); resolve(true); return; }
        if (opencodeProc?.exitCode !== null && opencodeProc?.exitCode !== undefined) { clearTimeout(timer); resolve(false); return; }
        setTimeout(() => void tick(), 500);
      };
      void tick();
      opencodeProc?.once('error', () => { clearTimeout(timer); resolve(false); });
    });
    if (started) {
      opencodeUrl = `http://127.0.0.1:${port}`;
      opencodeManaged = true;
      return { url: opencodeUrl, managed: true };
    }
    opencodeProc?.kill();
    opencodeProc = null;
  }
  opencodePassword = null;
  throw new Error('내장 opencode 서버를 시작하지 못했습니다. 4096~4098 포트를 확인하세요.');
}

function stopOpencodeServer(): void {
  if (opencodeProc && !opencodeProc.killed) opencodeProc.kill();
  opencodeProc = null;
  opencodePassword = null;
  opencodeUrl = null;
  opencodeManaged = false;
}

async function opencodeConnect(): Promise<{ client: OpencodeV2Client; url: string }> {
  const ensured = await ensureOpencodeServer();
  const password = ensured.managed ? (opencodePassword as string) : undefined;
  return { client: await opencodeClient(ensured.url, password), url: ensured.url };
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    const resourceRoot = app.isPackaged ? process.resourcesPath : app.getAppPath();
    let publicKey = '';
    try { publicKey = fs.readFileSync(path.join(resourceRoot, 'licensing', 'public-key.pem'), 'utf8'); } catch { /* Fail closed. */ }
    await refreshIdentity();
    license = new LicenseManager({ directory: path.join(app.getPath('userData'), 'licensing'), publicKey, getMacs: () => currentMacs, bundledFile: path.join(resourceRoot, 'licensing', 'bundled.lic') });
    await license.open();
    // Read-only smoke check of the same bundled verifier used by the UI; never sends input.
    if (process.argv.includes('--license-diagnostics')) {
      console.log(JSON.stringify({ variant, license: license.state() }));
      quitting = true;
      app.exit(license.state().valid ? 0 : 2);
      return;
    }
    const imageMatcher = async (action: MacroAction, control: RunControl | SearchControl, macro: MacroDocument): Promise<TemplateMatch | null> => {
      const area = (macro.overlay || action.region) as Region;
      // 기준 해상도(캡처 당시 오버레이)와 현재 오버레이의 비율만큼 템플릿을
      // 자동 확대/축소한다. 같은 .amacro가 1280x960과 800x600에서 그대로 동작한다.
      const reference = macro.overlay ? (macro.binding?.source_overlay || null) : null;
      const scale = resolveScale(area, reference);
      const percent = effectivePercent((action.template_scale_percent ?? 100) as number, scale);
      const shot = await captureTarget(macro.target_window, area, control);
      const frame = await sharp(shot.buffer).resize({ width: area.width, height: area.height }).png().toBuffer();
      // 하나의 확인에 최대 3개 이미지를 등록하면 순서대로 시도해 먼저 맞은 것을 쓴다.
      const from = reference ? { x: reference.x, y: reference.y } : { x: area.x, y: area.y };
      const to = { x: area.x, y: area.y };
      const paths = [action.image as string, ...((action.alt_images as string[]) || [])];
      const candidates: MatchCandidate[] = [];
      const meta: { asset: MacroDocument['images'][number] | undefined; path: string }[] = [];
      for (const candidate of paths) {
        if (control) await control.checkpoint();
        const source = await scaleTemplate(candidate.endsWith('.aimg') ? await (store as MacroStore).readImage(candidate) : candidate, percent);
        const asset = macro.images?.find(item => item.path === candidate);
        // ROI는 명시값이 학습값보다 우선하고, 피라미드는 학습된 배율을 먼저 시도한다.
        const learnedFactor = asset?.learned_scale_factor ?? null;
        const scales = action.pyramid
          ? [learnedFactor ?? 1, 1, 0.9, 1.12].filter((value, index, all) => all.indexOf(value) === index)
          : [1];
        candidates.push({
          template: source,
          zone: (action.zone ?? 0) as number,
          threshold: action.threshold as number,
          home: remapRect(asset?.region ?? null, scale, from, to),
          learned: remapRect(asset?.learned_region ?? null, scale, from, to),
          options: {
            roi: (action.roi as Region | null) ?? asset?.learned_roi ?? null,
            preprocess: ((action.preprocess as string) ?? 'none'),
            features: ((action.features as string) ?? 'off'),
            scales,
          },
        });
        meta.push({ asset, path: candidate });
      }
      const searched = await matchCandidates(frame, area, candidates, control);
      if (!searched.match) return null;
      const match = searched.match;
      const won = meta[searched.index];
      void saveMatchShot(frame, match, action.type);
      if (won.asset) {
        const position = { x: area.x + match.x, y: area.y + match.y, width: match.width, height: match.height };
        // 1차 수행이 성공하면 적중 위치와 배율을 학습해 다음 실행을 안정화·가속한다.
        const roi = learnRoi(won.asset.learned_roi ?? null, position, area);
        const factor = action.pyramid ? ((match as NccMatch).scaleFactor ?? 1) : null;
        await (store as MacroStore).updateLearnedMatch(macro.id, won.path, { region: position, roi, scaleFactor: factor }, macro.target_window, macro.overlay);
        won.asset.learned_region = position;
        won.asset.learned_roi = roi;
        if (factor) won.asset.learned_scale_factor = factor;
        notify();
      }
      return match;
    };
    runner = new MacroRunner({ input: createInputAdapter(), imageMatcher, authorize: async () => { license.authorize(); }, onState: () => notify(), onClickPoint: (point) => flashClick(point) });
    let lastLicense = JSON.stringify(license.state());
    let identityTicks = 0;
    licenseTimer = setInterval(() => {
      if (++identityTicks % 10 === 0) void refreshIdentity();
      const current = license.state();
      if (!current.valid) runner.invalidate(current.message as string);
      const serialized = JSON.stringify(current);
      if (serialized !== lastLicense) { lastLicense = serialized; notify(); }
    }, 1000);
    store = new MacroStore(path.join(app.getPath('userData'), 'macros-v2'), safeStorage);
    try { await store.open(); } catch (error) { startupError = (error as Error).message; }
    const pauseReady = globalShortcut.register('F8', () => runner.pause());
    const stopReady = globalShortcut.register('F9', () => { void runner.stop(); });
    shortcutsReady = pauseReady && stopReady;
    f7Ready = globalShortcut.register('F7', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('start-hotkey'); });
    if (!shortcutsReady) startupError = [startupError, 'F8/F9 등록에 실패했습니다. 다른 앱의 단축키 설정을 확인하세요.'].filter(Boolean).join('\n');
    ipcMain.handle('backend:request', async (event: IpcMainInvokeEvent, command: string, payload: Record<string, unknown> = {}) => {
      try {
        if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== page) throw new Error('허용되지 않은 요청입니다.');
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('잘못된 요청입니다.');
        switch (command) {
          case 'state': break;
          case 'macro-export': {
            const macro = (store as MacroStore).snapshot().macros.find(item => item.id === payload.macroId);
            if (!macro) throw new Error('매크로를 찾을 수 없습니다.');
            const bytes = await exportMacro(macro, store as MacroStore);
            const selection = await dialog.showSaveDialog(mainWindow as BrowserWindow, { title: '매크로 내보내기 (설정과 이미지 포함)', defaultPath: `${macro.name.replace(/[<>:"/\\|?*]/g, '_')}.amacro`, filters: [{ name: 'Americano 매크로', extensions: ['amacro'] }] });
            if (!selection.canceled && selection.filePath) await fs.promises.writeFile(selection.filePath, bytes);
            return { ok: true, canceled: selection.canceled, state: state() };
          }
          case 'macro-import': {
            if (runner.active || captureOverlay || captureOpening || captureSaving) throw new Error('실행 또는 캡처를 마친 뒤 가져오세요.');
            const selection = await dialog.showOpenDialog(mainWindow as BrowserWindow, { title: '매크로 가져오기', properties: ['openFile'], filters: [{ name: 'Americano 매크로', extensions: ['amacro'] }] });
            if (selection.canceled || !selection.filePaths.length) return { ok: true, canceled: true, state: state() };
            const macroId = await importMacro(await readPackage(selection.filePaths[0]), store as MacroStore);
            return { ok: true, macroId, state: state() };
          }
          case 'overlay-rebind': return { ok: true, macro: rebindOverlay(payload.macro as Record<string, unknown>, payload.region as Region), state: state() };
          case 'learn-reset': {
            const macro = (store as MacroStore).snapshot().macros.find(item => item.id === payload.macroId);
            if (!macro) throw new Error('매크로를 찾을 수 없습니다.');
            const asset = (macro.images || []).find(item => item.path === payload.path);
            if (!asset) throw new Error('이미지를 찾을 수 없습니다.');
            await (store as MacroStore).resetLearned(macro.id, asset.path);
            break;
          }
          case 'ai-get': return { ok: true, ...(await readAiConfig()), state: state() };
          case 'ai-set': {
            const model = String(payload.model || '').trim();
            const agent = String(payload.agent || '').trim();
            await fs.promises.writeFile(aiFile(), JSON.stringify({ model, agent }, null, 1));
            return { ok: true, state: state() };
          }
          case 'ai-test': {
            const status = await opencodeStatus();
            if (!status.running) throw new Error('opencode 서버가 없습니다. [내장 서버 시작]을 먼저 누르세요.');
            return { ok: true, model: status.version, state: state() };
          }
          case 'ai-generate': {
            const result = await generateActions(String(payload.text || ''), String(payload.macroId || ''), (payload.images as string[]) || [], (payload.overlay as Region | null) || null);
            return { ok: true, ...result, state: state() };
          }
          case 'ai-server': {
            return { ok: true, ...(await opencodeStatus()), state: state() };
          }
          case 'ai-server-start': {
            const ensured = await ensureOpencodeServer();
            const version = await healthCheck(ensured.url, ensured.managed ? (opencodePassword as string) : undefined);
            return { ok: true, url: ensured.url, managed: ensured.managed, version, state: state() };
          }
          case 'ai-providers': {
            const { client } = await opencodeConnect();
            return { ok: true, providers: await listProviders(client, ['opencode-go']), state: state() };
          }
          case 'ai-login-start': {
            const providerID = String(payload.providerID || '');
            if (!providerID) throw new Error('공급자를 지정하세요.');
            const { client } = await opencodeConnect();
            const started = await startLogin(client, providerID);
            try { shell.openExternal(started.url); } catch { /* 브라우저 열기 실패는 URL을 보여준다. */ }
            return { ok: true, ...started, state: state() };
          }
          case 'ai-login-poll': {
            const providerID = String(payload.providerID || '');
            const { client } = await opencodeConnect();
            return { ok: true, connected: await isConnected(client, providerID), state: state() };
          }
          case 'ai-login-finish': {
            const providerID = String(payload.providerID || '');
            const { client } = await opencodeConnect();
            await finishLogin(client, providerID, String(payload.code || '') || undefined);
            return { ok: true, connected: await isConnected(client, providerID), state: state() };
          }
          case 'ai-key-set': {
            const providerID = String(payload.providerID || '');
            const fields = (payload.fields || {}) as Record<string, string>;
            const { client } = await opencodeConnect();
            await setApiKey(client, providerID, fields);
            return { ok: true, connected: await isConnected(client, providerID), state: state() };
          }
          case 'progress-toggle': {
            if (payload.open === true && progressWindow && !progressWindow.isDestroyed()) return { ok: true, open: true, state: state() };
            if (progressWindow && !progressWindow.isDestroyed()) { closeProgress(); return { ok: true, open: false, state: state() }; }
            const found = (store as MacroStore).snapshot().macros.find((item) => item.id === payload.macroId);
            if (!found) throw new Error('매크로를 찾을 수 없습니다.');
            progressMacroId = found.id;
            progressWindow = new BrowserWindow({
              width: 360, height: 560, minWidth: 280, minHeight: 300, title: '매크로 진행 상황',
              icon: path.join(__dirname, 'assets', 'coffee.ico'),
              webPreferences: { preload: path.join(__dirname, 'progress-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
            });
            progressWindow.setAlwaysOnTop(true);
            progressWindow.on('closed', () => { progressWindow = null; progressMacroId = null; });
            await progressWindow.loadFile(path.join(__dirname, 'progress.html'));
            pushProgress(state());
            return { ok: true, open: true, state: state() };
          }
          case 'overlay-auto': {
            const macro = validateDocument({ version: 2, macros: [payload.macro] }).macros[0];
            const target = await findWindow(macro.target_window, 10000);
            const client = await readGameGeometry(target.handle);
            if (client.width < 8 || client.height < 8) throw new Error('대상 창의 영역을 읽지 못했습니다. 최소화를 해제하고 다시 시도하세요.');
            return { ok: true, macro: rebindOverlay(macro, fullClientOverlay(client)), state: state() };
          }
          case 'license-device': await refreshIdentity(); return { ok: true, macs: currentMacs, state: state() };
          case 'license-check': await refreshIdentity(); license.authorize(); break;
          case 'license-import': {
            const selection = await dialog.showOpenDialog(mainWindow as BrowserWindow, { title: '오프라인 라이선스 등록', properties: ['openFile'], filters: [{ name: '오프라인 라이선스', extensions: ['lic'] }] });
            if (!selection.canceled && selection.filePaths.length) await license.install(await readLimited(selection.filePaths[0]));
            break;
          }
          case 'image-select': {
            const selection = await dialog.showOpenDialog(mainWindow as BrowserWindow, { title: '감지할 이미지 선택', properties: ['openFile'], filters: [{ name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] });
            return { ok: true, path: selection.canceled ? '' : selection.filePaths[0], state: state() };
          }
          case 'image-delete': {
            if (!payload || typeof payload.path !== 'string') throw new Error('잘못된 요청입니다.');
            await (store as MacroStore).deleteImage(payload.path);
            break;
          }
          case 'window-list': return { ok: true, windows: (await listWindows()).map(({ handle, ...info }) => info), state: state() };
          case 'overlay-hide': closeOutline(); break;
          case 'overlay-show': {
            const macro = (store as MacroStore).snapshot().macros.find(item => item.id === payload.macroId);
            if (!macro) throw new Error('매크로를 찾을 수 없습니다.');
            await showOutline(macro);
            break;
          }
          case 'capture-overlay-open': await openCaptureOverlay(payload as { mode?: string; macro: Record<string, unknown> }); break;
          case 'save': await (store as MacroStore).save(payload.document as Parameters<MacroStore['save']>[0]); closeOutline(); break;
          case 'preview': {
            if (!shortcutsReady) throw new Error('F8/F9 단축키를 먼저 확보해야 합니다.');
            const macro = (store as MacroStore).snapshot().macros.find((item) => item.id === payload.macroId);
            if (!macro) throw new Error('매크로를 찾을 수 없습니다.');
            runner.start(macro, { preview: true, startIndex: (payload.startIndex as number) ?? 0 });
            break;
          }
          case 'start': {
            if (captureOverlay || captureOpening || captureSaving) throw new Error('오버레이 편집을 먼저 마치세요.');
            if (!shortcutsReady) throw new Error('F8/F9 단축키를 먼저 확보해야 합니다.');
            const macro = (store as MacroStore).snapshot().macros.find((item) => item.id === payload.macroId);
            if (!macro) throw new Error('매크로를 찾을 수 없습니다.');
            // 누적 통계로 탐색 간격을 자동 조정한 복사본으로 실행한다. 저장값은 그대로 둔다.
            const tuned = applyPerfTuning(macro);
            lastTuning = tuned.changes;
            runner.start(tuned.macro, { preview: false, startIndex: (payload.startIndex as number) ?? 0 });
            break;
          }
          case 'pause': runner.pause(); break;
          case 'stop': await runner.stop(); break;
          default: throw new Error('허용되지 않은 명령입니다.');
        }
        return { ok: true, state: state() };
      } catch (error) { return { ok: false, error: (error as Error).message, state: state() }; }
    });
    ipcMain.on('capture-overlay-cancel', (event: IpcMainEvent) => {
      if (event.sender === captureOverlay?.webContents && captureOverlay && !captureOverlay.isDestroyed()) captureOverlay.close();
    });
    ipcMain.on('capture-overlay-selection', async (event: IpcMainEvent, selection: { x: number; y: number; width: number; height: number }) => {
      if (event.sender !== captureOverlay?.webContents || event.senderFrame !== event.sender.mainFrame || !captureBuffer || !captureMeta || captureSaving) return;
      captureSaving = true;
      const session = captureOverlay;
      const buffer = captureBuffer;
      try {
        const region = { x: Math.max(0, Math.min((captureMeta as NonNullable<typeof captureMeta>).width - 1, Math.round(selection.x))), y: Math.max(0, Math.min((captureMeta as NonNullable<typeof captureMeta>).width - 1, Math.round(selection.y))), width: Math.round(selection.width), height: Math.round(selection.height) };
        if (region.width < 8 || region.height < 8 || region.x + region.width > (captureMeta as NonNullable<typeof captureMeta>).width || region.y + region.height > (captureMeta as NonNullable<typeof captureMeta>).height) throw new Error('캡처 영역이 올바르지 않습니다.');
        if (!Object.values(region).every(Number.isSafeInteger)) throw new Error('잘못된 캡처 좌표입니다.');
        const meta = captureMeta as NonNullable<typeof captureMeta>;
        const relative = { x: meta.offset.x + Math.round(region.x * 96 / meta.dpi), y: meta.offset.y + Math.round(region.y * 96 / meta.dpi), width: Math.max(1, Math.round(region.width * 96 / meta.dpi)), height: Math.max(1, Math.round(region.height * 96 / meta.dpi)) };
        if (meta.mode === 'region') {
          mainWindow?.webContents.send('capture-result', { ok: true, mode: 'region', macroId: meta.macroId, region: relative });
          return;
        }
        const cropped = await sharp(buffer).extract({ left: region.x, top: region.y, width: region.width, height: region.height }).resize(relative.width, relative.height).png().toBuffer();
        const filePath = await (store as MacroStore).saveImage(cropped);
        mainWindow?.webContents.send('capture-result', { ok: true, mode: 'image', macroId: meta.macroId, path: filePath, preview: `data:image/png;base64,${cropped.toString('base64')}`, region: relative });
      } catch (error) {
        mainWindow?.webContents.send('capture-result', { ok: false, error: (error as Error).message });
      } finally {
        if (session && !session.isDestroyed()) session.close();
        captureSaving = false;
      }
    });
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('before-quit', (event) => {
    if (shutdownPromise) { event.preventDefault(); return; }
    event.preventDefault();
    quitting = true;
    if (licenseTimer) clearInterval(licenseTimer);
    closeOutline();
    closeProgress();
    stopOpencodeServer();
    globalShortcut.unregisterAll();
    let finishShutdown!: (timedOut: boolean) => void;
    shutdownPromise = new Promise<boolean>((resolve) => { finishShutdown = resolve; });
    // Destroying the renderer prevents beforeunload confirmation from blocking app.quit().
    if (captureOverlay && !captureOverlay.isDestroyed()) captureOverlay.destroy();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    const cleanup = Promise.allSettled([runner?.stop(), store?.queue, (license as unknown as { queue?: unknown })?.queue]);
    const deadlineTimer = setTimeout(() => finishShutdown(true), shutdownDeadlineMs);
    cleanup.then(() => {
      clearTimeout(deadlineTimer);
      finishShutdown(false);
    });
    shutdownPromise.then((timedOut) => {
      if (timedOut) console.error(`Shutdown cleanup exceeded ${shutdownDeadlineMs}ms; forcing exit.`);
      app.exit(timedOut ? 1 : 0);
    });
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}
