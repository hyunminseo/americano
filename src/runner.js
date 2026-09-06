const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { validateDocument } = require('./macros');
const { assertRunnable } = require('./portable');
class Cancelled extends Error {}
class RunControl {
  constructor() { this.abort = new AbortController(); this.paused = false; this.listeners = new Set(); this.elapsed = 0; this.last = performance.now(); }
  time() { const now = performance.now(); if (!this.paused) this.elapsed += now - this.last; this.last = now; return this.elapsed; }
  wake() { for (const resolve of [...this.listeners]) resolve(); }
  pause() { this.time(); this.paused = !this.paused; this.wake(); }
  stop() { this.abort.abort(); this.wake(); }
  fail(error) { this.failure = error; this.stop(); }
  tick(ms = 25) { return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); this.listeners.delete(done); resolve(); };
    const timer = setTimeout(done, ms); this.listeners.add(done);
  }); }
  async checkpoint() {
    if (this.failure) throw this.failure;
    if (this.abort.signal.aborted) throw new Cancelled();
    while (this.paused) { await this.tick(); if (this.failure) throw this.failure; if (this.abort.signal.aborted) throw new Cancelled(); }
  }
  async wait(ms) {
    const end = this.time() + ms;
    do { await this.checkpoint(); const remaining = end - this.time(); if (remaining <= 0) return; await this.tick(Math.min(25, remaining)); } while (true);
  }
}
class MacroRunner {
  constructor({ input, imageMatcher, authorize = async () => { throw new Error('실제 실행은 창·권한·라이선스 연결 후 사용할 수 있습니다.'); }, onState = () => {}, onClickPoint = null } = {}) {
    this.input = input; this.imageMatcher = imageMatcher; this.authorize = authorize; this.onState = onState; this.onClickPoint = onClickPoint;
    this.current = { status: 'STOPPED', runId: null, macroId: null, step: null, preview: false, completed: 0, error: null, outcome: null };
    this.active = null;
  }
  state() { return structuredClone(this.current); }
  publish(change) { Object.assign(this.current, change); this.onState(this.state()); }
  start(raw, { preview = false, startIndex = 0 } = {}) {
    if (this.active) throw new Error('이미 실행 또는 정리 중인 매크로가 있습니다.');
    const macro = validateDocument({ version: 2, macros: [raw] }).macros[0];
    if (!preview) assertRunnable(macro);
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= macro.actions.length) throw new Error('실행할 단계가 없습니다.');
    const control = new RunControl();
    if (this.onClickPoint) control.onClickPoint = this.onClickPoint;
    const active = { control, done: null, macro }; this.active = active;
    this.publish({ status: 'RUNNING', runId: randomUUID(), macroId: macro.id, step: null, preview, error: null, outcome: null, matched: null, iteration: 0, iterations: macro.loop.count });
    active.done = Promise.resolve().then(async () => {
      let outcome = 'completed'; let failure = null;
      try {
        if (!preview) await this.authorize(macro);
        for (let iteration = 0; iteration < macro.loop.count; iteration++) {
          this.publish({ iteration: iteration + 1, iterations: macro.loop.count });
          await this.execute(macro.actions.slice(startIndex), control, macro, preview, [], startIndex);
          if (iteration + 1 < macro.loop.count) await control.wait(macro.loop.interval_ms);
        }
      } catch (error) { if (error instanceof Cancelled) outcome = 'cancelled'; else { outcome = 'failed'; failure = error.message; } }
      finally {
        try { if (!preview && this.input) await this.input.releaseAll(); }
        catch (error) { outcome = 'failed'; failure = error.message; }
        this.active = null;
        this.publish({ status: failure ? 'ERROR' : 'STOPPED', step: null, error: failure, outcome, completed: this.current.completed + (outcome === 'completed' ? 1 : 0) });
      }
      return this.state();
    });
    return this.state();
  }
  async execute(items, control, macro, preview, prefix, offset = 0) {
    for (let index = 0; index < items.length; index++) {
      await control.checkpoint();
      if (!preview) { await this.authorize(macro); await control.checkpoint(); }
      const action = items[index]; const step = [...prefix, index + offset];
      this.publish({ step });
      if (action.type === 'stop') throw new Cancelled();
      if (action.type === 'wait') await control.wait(action.duration_ms);
      else if (action.type === 'image_detect') {
        if (!preview && !(await this.findImage(action, control))) throw new Error(`이미지를 찾지 못했습니다: ${action.image}`);
        if (preview) await control.tick(0);
      }
      else if (action.type === 'image_wait') {
        if (preview) await control.wait(Math.min(action.timeout_ms, 500));
        else if (!(await this.waitForImage(action, control))) throw new Error(`이미지를 찾지 못했습니다: ${action.image}`);
      }
      else if (action.type === 'image_click') {
        if (preview) await control.tick(0);
        else {
          const match = await this.waitForImage(action, control);
          if (!match) throw new Error(`클릭할 이미지를 찾지 못했습니다: ${action.image}`);
          await this.executeInput({ type: 'click', button: action.button ?? 'left', x: (macro.overlay || action.region).x + match.x + Math.floor(match.width / 2), y: (macro.overlay || action.region).y + match.y + Math.floor(match.height / 2), timeout_ms: action.timeout_ms }, control, macro);
        }
      }
      else if (action.type === 'smart_click') {
        if (preview) await control.tick(0);
        else {
          // 탐지된 범위 안에서 가운데→위→아래 순서로 눌러보고,
          // 화면이 변하면(또는 기대 화면이 나타나면) 성공으로 확정한다.
          const origin = macro.overlay || action.region;
          const threshold = action.threshold ?? 0.9;
          const interval = action.verify_interval_ms ?? 800;
          const deadline = control.time() + action.timeout_ms;
          const changed = async () => {
            if (action.expect_image) {
              return Boolean(await this.imageMatcher({ ...action, image: action.expect_image }, control, macro));
            }
            const again = await this.imageMatcher(action, control, macro);
            return !again || again.score < threshold * 0.9;
          };
          let lastError = new Error(`클릭할 이미지를 찾지 못했습니다: ${action.image}`);
          for (;;) {
            const match = await this.imageMatcher(action, control, macro);
            let done = false;
            if (match) {
              const spots = [
                { x: match.x + Math.floor(match.width / 2), y: match.y + Math.floor(match.height / 2) },
                { x: match.x + Math.floor(match.width / 2), y: match.y + Math.max(0, Math.floor(match.height * 0.25)) },
                { x: match.x + Math.floor(match.width / 2), y: match.y + Math.floor(match.height * 0.75) },
              ];
              for (const spot of spots) {
                await this.executeInput({ type: 'click', button: action.button ?? 'left', x: origin.x + spot.x, y: origin.y + spot.y, timeout_ms: action.timeout_ms }, control, macro);
                await control.wait(interval);
                if (await changed()) { done = true; break; }
              }
              if (!done) lastError = new Error(`클릭 후 화면이 변하지 않았습니다: ${action.image}`);
            }
            if (done) { this.publish({ matched: true }); break; }
            if (control.time() >= deadline) throw lastError;
            await control.wait(Math.min(action.poll_interval_ms, Math.max(0, deadline - control.time())));
          }
        }
      }
      else if (action.type === 'retry') {
        let lastError;
        for (let attempt = 0; attempt <= action.count; attempt += 1) {
          try { await this.execute([action.action], control, macro, preview, step, 0); lastError = null; break; }
          catch (error) { lastError = error; if (control.abort.signal.aborted || attempt === action.count) throw error; await control.wait(action.interval_ms); }
        }
        if (lastError) throw lastError;
      }
      else if (action.type === 'condition') {
        const matched = preview ? false : Boolean(await this.findImage(action.test, control));
        await this.execute(matched ? action.then : action.else, control, macro, preview, [...step, matched ? 'then' : 'else'], 0);
      }
      else if (action.type === 'repeat') {
        for (let count = 0; count < action.count; count++) {
          await control.checkpoint(); await this.execute(action.actions, control, macro, preview, step);
          await control.tick(0);
        }
      } else if (!preview) {
        await this.executeInput(action, control, macro);
      } else { await control.tick(0); }
    }
  }
  async findImage(action, control) {
    if (!this.imageMatcher) throw new Error('이미지 캡처 어댑터가 준비되지 않았습니다.');
    await control.checkpoint();
    const macro = this.active?.macro;
    const deadline = control.time() + action.timeout_ms;
    const searchControl = {
      abort: control.abort,
      time: () => control.time(),
      checkpoint: async () => {
        await control.checkpoint();
        if (control.time() >= deadline) throw new Error('이미지 검색 timeout을 초과했습니다.');
      },
      wait: async (ms) => { await control.wait(Math.min(ms, Math.max(0, deadline - control.time()))); await searchControl.checkpoint(); },
    };
    const result = await this.imageMatcher(action, searchControl, macro);
    await searchControl.checkpoint();
    this.publish({ matched: Boolean(result) });
    return result;
  }
  async waitForImage(action, control) {
    const deadline = control.time() + action.timeout_ms;
    do {
      const match = await this.findImage(action, control);
      if (match) return match;
      const remaining = deadline - control.time();
      if (remaining <= 0) return null;
      await control.wait(Math.min(action.poll_interval_ms, remaining));
    } while (true);
  }
  async executeInput(action, control, macro) {
    if (action.coordinate_space === 'overlay') {
      if (!macro.overlay) throw new Error('오버레이 영역이 필요합니다.');
      action = { ...action, coordinate_space: 'client', x: macro.overlay.x + action.x, y: macro.overlay.y + action.y };
    }
    await this.authorize(macro); await control.checkpoint();
    if (!this.input) throw new Error('창 입력 어댑터가 준비되지 않았습니다.');
    const start = control.time(); let settled = false; let timedOut = false;
    const operation = Promise.resolve().then(() => this.input.execute(action, macro.target_window, control)).finally(() => { settled = true; });
    operation.catch(() => {});
    while (!settled) {
      if (control.time() - start >= action.timeout_ms) { timedOut = true; control.stop(); }
      await control.tick();
    }
    await operation;
    if (timedOut) throw new Error('단계 timeout을 초과했습니다.');
    await control.checkpoint();
  }
  pause() { if (this.active && !this.active.control.abort.signal.aborted) { this.active.control.pause(); this.publish({ status: this.active.control.paused ? 'PAUSED' : 'RUNNING' }); } return this.state(); }
  async stop() { const active = this.active; if (active) { active.control.stop(); await active.done; } return this.state(); }
  invalidate(message) { if (this.active && !this.current.preview) this.active.control.fail(new Error(message)); }
}
module.exports = { MacroRunner, RunControl };
