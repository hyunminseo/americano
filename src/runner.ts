import { randomUUID, randomInt } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { validateDocument, MacroAction, MacroDocument, TargetWindow, StepStatEntry } from './macros.js';
import { assertRunnable } from './portable.js';

export class Cancelled extends Error {}

export interface SearchControl {
  abort: AbortController;
  time(): number;
  checkpoint(): Promise<void>;
  wait(ms: number): Promise<void>;
}

export class RunControl {
  abort = new AbortController();
  paused = false;
  listeners = new Set<() => void>();
  elapsed = 0;
  last = performance.now();
  failure: Error | null = null;
  onClickPoint: ((point: { x: number; y: number }) => void) | null = null;

  time(): number {
    const now = performance.now();
    if (!this.paused) this.elapsed += now - this.last;
    this.last = now;
    return this.elapsed;
  }
  wake(): void { for (const resolve of [...this.listeners]) resolve(); }
  pause(): void { this.time(); this.paused = !this.paused; this.wake(); }
  stop(): void { this.abort.abort(); this.wake(); }
  fail(error: Error): void { this.failure = error; this.stop(); }
  tick(ms = 25): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => { clearTimeout(timer); this.listeners.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      this.listeners.add(done);
    });
  }
  async checkpoint(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.abort.signal.aborted) throw new Cancelled();
    while (this.paused) {
      await this.tick();
      if (this.failure) throw this.failure;
      if (this.abort.signal.aborted) throw new Cancelled();
    }
  }
  async wait(ms: number): Promise<void> {
    const end = this.time() + ms;
    do {
      await this.checkpoint();
      const remaining = end - this.time();
      if (remaining <= 0) return;
      await this.tick(Math.min(25, remaining));
    } while (true);
  }
}

export interface TemplateMatch {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  [key: string]: unknown;
}

export interface InputAdapter {
  execute(action: MacroAction, target: TargetWindow, control: RunControl, mode?: string): Promise<void>;
  releaseAll(): Promise<void>;
}

export interface RunnerState {
  status: string;
  runId: string | null;
  macroId: string | null;
  step: unknown;
  preview: boolean;
  completed: number;
  error: string | null;
  outcome: string | null;
  [key: string]: unknown;
}

interface ActiveRun {
  control: RunControl;
  done: Promise<RunnerState> | null;
  macro: MacroDocument;
}

export class MacroRunner {
  input: InputAdapter | null;
  imageMatcher: ((action: MacroAction, control: RunControl | SearchControl, macro: MacroDocument) => Promise<TemplateMatch | null>) | null;
  authorize: (macro: MacroDocument) => Promise<void>;
  onState: (state: RunnerState) => void;
  onClickPoint: ((point: { x: number; y: number }) => void) | null;
  current: RunnerState = { status: 'STOPPED', runId: null, macroId: null, step: null, preview: false, completed: 0, error: null, outcome: null };
  active: ActiveRun | null = null;
  // 조건 분기가 마지막에 탄 가지. retry가 조건 분기를 감쌀 때 거짓이면 재시도한다.
  lastBranch: 'then' | 'else' | null = null;
  // 실행 통계: 단계별 탐색 횟수·소요 시간·성패. runStats()로 읽고 자동 최적화에 쓴다.
  stepStats: StepStatEntry[] = [];
  scanCount = 0;

  constructor({ input = null, imageMatcher = null, authorize = async () => { throw new Error('실제 실행은 창·권한·라이선스 연결 후 사용할 수 있습니다.'); }, onState = () => {}, onClickPoint = null }: {
    input?: InputAdapter | null;
    imageMatcher?: ((action: MacroAction, control: RunControl | SearchControl, macro: MacroDocument) => Promise<TemplateMatch | null>) | null;
    authorize?: (macro: MacroDocument) => Promise<void>;
    onState?: (state: RunnerState) => void;
    onClickPoint?: ((point: { x: number; y: number }) => void) | null;
  } = {}) {
    this.input = input;
    this.imageMatcher = imageMatcher;
    this.authorize = authorize;
    this.onState = onState;
    this.onClickPoint = onClickPoint;
    this.current = { status: 'STOPPED', runId: null, macroId: null, step: null, preview: false, completed: 0, error: null, outcome: null };
    this.active = null;
  }

  state(): RunnerState { return structuredClone(this.current); }
  publish(change: Partial<RunnerState>): void { Object.assign(this.current, change); this.onState(this.state()); }

  start(raw: Record<string, unknown>, { preview = false, startIndex = 0 }: { preview?: boolean; startIndex?: number } = {}): RunnerState {
    if (this.active) throw new Error('이미 실행 또는 정리 중인 매크로가 있습니다.');
    const macro = validateDocument({ version: 2, macros: [raw] }).macros[0];
    if (!preview) assertRunnable(macro);
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= macro.actions.length) throw new Error('실행할 단계가 없습니다.');
    const control = new RunControl();
    if (this.onClickPoint) control.onClickPoint = this.onClickPoint;
    const active: ActiveRun = { control, done: null, macro };
    this.active = active;
    this.stepStats = [];
    this.scanCount = 0;
    this.lastBranch = null;
    this.publish({ status: 'RUNNING', runId: randomUUID(), macroId: macro.id, step: null, preview, error: null, outcome: null, matched: null, iteration: 0, iterations: macro.loop.count, attempt: null, attempts: null });
    active.done = Promise.resolve().then(async () => {
      let outcome = 'completed';
      let failure: string | null = null;
      try {
        if (!preview) await this.authorize(macro);
        for (let iteration = 0; iteration < macro.loop.count; iteration++) {
          this.publish({ iteration: iteration + 1, iterations: macro.loop.count });
          await this.execute(macro.actions.slice(startIndex), control, macro, preview, [], startIndex);
          if (iteration + 1 < macro.loop.count) await control.wait(macro.loop.interval_ms);
        }
      } catch (error) {
        if (error instanceof Cancelled) outcome = 'cancelled';
        else { outcome = 'failed'; failure = (error as Error).message; }
      } finally {
        try { if (!preview && this.input) await this.input.releaseAll(); }
        catch (error) { outcome = 'failed'; failure = (error as Error).message; }
        this.active = null;
        this.publish({ status: failure ? 'ERROR' : 'STOPPED', step: null, error: failure, outcome, completed: (this.current.completed as number) + (outcome === 'completed' ? 1 : 0), attempt: null, attempts: null });
      }
      return this.state();
    });
    return this.state();
  }

  runStats(): StepStatEntry[] { return structuredClone(this.stepStats); }

  async execute(items: MacroAction[], control: RunControl, macro: MacroDocument, preview: boolean, prefix: unknown[], offset = 0): Promise<void> {
    for (let index = 0; index < items.length; index++) {
      await control.checkpoint();
      if (!preview) { await this.authorize(macro); await control.checkpoint(); }
      const action = items[index];
      const step = [...prefix, index + offset];
      // 단계가 바뀌었을 때만 재시도 표시를 지운다. 같은 단계의 중첩 실행은 유지한다.
      if (JSON.stringify(step) !== JSON.stringify(this.current.step)) this.publish({ step, wait_ms: null, attempt: null, attempts: null });
      else this.publish({ step, wait_ms: null });
      const statKey = step.map((part) => String(part)).join('.');
      const statStart = control.time();
      const scansBefore = this.scanCount;
      let statOk = true;
      try {
      if (action.type === 'stop') throw new Cancelled();
      if (action.type === 'random_wait') {
        const duration = randomInt((action.min_seconds as number) * 1000, (action.max_seconds as number) * 1000 + 1);
        this.publish({ wait_ms: duration });
        await control.wait(duration);
      }
      else if (action.type === 'wait') await control.wait(action.duration_ms as number);
      else if (action.type === 'image_detect') {
        if (!preview && !(await this.findImage(action, control))) throw new Error(`이미지를 찾지 못했습니다: ${action.image}`);
        if (preview) await control.tick(0);
      }
      else if (action.type === 'image_wait') {
        if (preview) await control.wait(Math.min(action.timeout_ms as number, 500));
        else if (!(await this.waitForImage(action, control))) throw new Error(`이미지를 찾지 못했습니다: ${action.image}`);
      }
      else if (action.type === 'image_click') {
        if (preview) await control.tick(0);
        else {
          const match = await this.waitForImage(action, control);
          if (!match) throw new Error(`클릭할 이미지를 찾지 못했습니다: ${action.image}`);
          await this.executeInput({ type: 'click', button: (action.button ?? 'left') as string, x: ((macro.overlay || action.region) as { x: number; y: number }).x + match.x + Math.floor(match.width / 2), y: ((macro.overlay || action.region) as { x: number; y: number }).y + match.y + Math.floor(match.height / 2), timeout_ms: action.timeout_ms } as MacroAction, control, macro);
        }
      }
      else if (action.type === 'smart_click') {
        if (preview) await control.tick(0);
        else {
          // 탐지된 범위 안에서 가운데→위→아래 순서로 눌러보고,
          // 화면이 변하면(또는 기대 화면이 나타나면) 성공으로 확정한다.
          const origin = (macro.overlay || action.region) as { x: number; y: number };
          const threshold = (action.threshold ?? 0.9) as number;
          const interval = (action.verify_interval_ms ?? 800) as number;
          const deadline = control.time() + (action.timeout_ms as number);
          const changed = async (): Promise<boolean> => {
            if (action.expect_image) {
              return Boolean(await (this.imageMatcher as NonNullable<MacroRunner['imageMatcher']>)({ ...action, image: action.expect_image } as MacroAction, control, macro));
            }
            const again = await (this.imageMatcher as NonNullable<MacroRunner['imageMatcher']>)(action, control, macro);
            return !again || again.score < threshold * 0.9;
          };
          let lastError: Error = new Error(`클릭할 이미지를 찾지 못했습니다: ${action.image}`);
          for (;;) {
            const match = await (this.imageMatcher as NonNullable<MacroRunner['imageMatcher']>)(action, control, macro);
            let done = false;
            if (match) {
              const spots = [
                { x: match.x + Math.floor(match.width / 2), y: match.y + Math.floor(match.height / 2) },
                { x: match.x + Math.floor(match.width / 2), y: match.y + Math.max(0, Math.floor(match.height * 0.25)) },
                { x: match.x + Math.floor(match.width / 2), y: match.y + Math.floor(match.height * 0.75) },
              ];
              for (const spot of spots) {
                await this.executeInput({ type: 'click', button: (action.button ?? 'left') as string, x: origin.x + spot.x, y: origin.y + spot.y, timeout_ms: action.timeout_ms } as MacroAction, control, macro);
                await control.wait(interval);
                if (await changed()) { done = true; break; }
              }
              if (!done) lastError = new Error(`클릭 후 화면이 변하지 않았습니다: ${action.image}`);
            }
            if (done) { this.publish({ matched: true }); break; }
            if (control.time() >= deadline) throw lastError;
            await control.wait(Math.min(action.poll_interval_ms as number, Math.max(0, deadline - control.time())));
          }
        }
      }
      else if (action.type === 'retry') {
        let lastError: Error | undefined;
        const total = (action.count as number) + 1;
        for (let attempt = 0; attempt <= (action.count as number); attempt += 1) {
          try {
            // 재시도 중 진행 표시: 몇 번째 시도인지 계속 보여준다.
            if (!preview) this.publish({ step, attempt: attempt + 1, attempts: total });
            if (preview) { await this.execute([action.action as MacroAction], control, macro, preview, step, 0); lastError = undefined; break; }
            this.lastBranch = null;
            await this.execute([action.action as MacroAction], control, macro, preview, step, 0);
            // 조건 분기를 감싸면 거짓 가지를 실패로 간주한다. 대기 후 다시 발견으로 돌아간다.
            if ((action.action as MacroAction).type === 'condition' && this.lastBranch === 'else') {
              lastError = new Error('이미지를 찾지 못했습니다. 다시 확인합니다.');
              if (attempt === (action.count as number)) throw lastError;
              await control.wait(action.interval_ms as number);
              continue;
            }
            lastError = undefined; break;
          }
          catch (error) { lastError = error as Error; if (control.abort.signal.aborted || attempt === (action.count as number)) throw error; await control.wait(action.interval_ms as number); }
        }
        if (lastError) throw lastError;
      }
      else if (action.type === 'condition') {
        const matched = preview ? false : Boolean(await this.findImage(action.test as MacroAction, control));
        this.lastBranch = matched ? 'then' : 'else';
        await this.execute(matched ? action.then as MacroAction[] : action.else as MacroAction[], control, macro, preview, [...step, matched ? 'then' : 'else'], 0);
      }
      else if (action.type === 'repeat') {
        for (let count = 0; count < (action.count as number); count++) {
          await control.checkpoint();
          await this.execute(action.actions as MacroAction[], control, macro, preview, step);
          await control.tick(0);
        }
      } else if (!preview) {
        await this.executeInput(action, control, macro);
      } else { await control.tick(0); }
      } catch (error) { statOk = false; throw error; }
      finally { this.stepStats.push({ key: statKey, type: action.type, scans: this.scanCount - scansBefore, ms: Math.max(0, control.time() - statStart), ok: statOk }); }
    }
  }

  async findImage(action: MacroAction, control: RunControl): Promise<TemplateMatch | null> {
    if (!this.imageMatcher) throw new Error('이미지 캡처 어댑터가 준비되지 않았습니다.');
    await control.checkpoint();
    const macro = this.active?.macro as MacroDocument;
    const deadline = control.time() + (action.timeout_ms as number);
    const searchControl: SearchControl = {
      abort: control.abort,
      time: () => control.time(),
      checkpoint: async () => {
        await control.checkpoint();
        if (control.time() >= deadline) throw new Error('이미지 검색 timeout을 초과했습니다.');
      },
      wait: async (ms: number) => { await control.wait(Math.min(ms, Math.max(0, deadline - control.time()))); await searchControl.checkpoint(); },
    };
    const result = await this.imageMatcher(action, searchControl, macro);
    this.scanCount += 1;
    await searchControl.checkpoint();
    this.publish({ matched: Boolean(result) });
    return result;
  }

  async waitForImage(action: MacroAction, control: RunControl): Promise<TemplateMatch | null> {
    const deadline = control.time() + (action.timeout_ms as number);
    do {
      const match = await this.findImage(action, control);
      if (match) return match;
      const remaining = deadline - control.time();
      if (remaining <= 0) return null;
      await control.wait(Math.min(action.poll_interval_ms as number, remaining));
    } while (true);
  }

  async executeInput(action: MacroAction, control: RunControl, macro: MacroDocument): Promise<void> {
    if (action.coordinate_space === 'overlay') {
      if (!macro.overlay) throw new Error('오버레이 영역이 필요합니다.');
      action = { ...action, coordinate_space: 'client', x: macro.overlay.x + (action.x as number), y: macro.overlay.y + (action.y as number) };
    }
    await this.authorize(macro);
    await control.checkpoint();
    if (!this.input) throw new Error('창 입력 어댑터가 준비되지 않았습니다.');
    const start = control.time();
    let settled = false;
    let timedOut = false;
    const operation = Promise.resolve().then(() => (this.input as InputAdapter).execute(action, macro.target_window, control, (macro.input_mode as string) || 'foreground')).finally(() => { settled = true; });
    operation.catch(() => {});
    while (!settled) {
      if (control.time() - start >= (action.timeout_ms as number)) { timedOut = true; control.stop(); }
      await control.tick();
    }
    await operation;
    if (timedOut) throw new Error('단계 timeout을 초과했습니다.');
    await control.checkpoint();
  }

  pause(): RunnerState {
    if (this.active && !this.active.control.abort.signal.aborted) {
      this.active.control.pause();
      this.publish({ status: this.active.control.paused ? 'PAUSED' : 'RUNNING' });
    }
    return this.state();
  }

  async stop(): Promise<RunnerState> {
    const active = this.active;
    if (active) { active.control.stop(); await active.done; }
    return this.state();
  }

  invalidate(message: string): void {
    if (this.active && !this.current.preview) this.active.control.fail(new Error(message));
  }
}
