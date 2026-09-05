const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { validateDocument } = require('./macros');
class Cancelled extends Error {}
class RunControl {
  constructor() { this.abort = new AbortController(); this.paused = false; this.listeners = new Set(); this.elapsed = 0; this.last = performance.now(); }
  time() { const now = performance.now(); if (!this.paused) this.elapsed += now - this.last; this.last = now; return this.elapsed; }
  wake() { for (const resolve of [...this.listeners]) resolve(); }
  pause() { this.time(); this.paused = !this.paused; this.wake(); }
  stop() { this.abort.abort(); this.wake(); }
  tick(ms = 25) { return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); this.listeners.delete(done); resolve(); };
    const timer = setTimeout(done, ms); this.listeners.add(done);
  }); }
  async checkpoint() {
    if (this.abort.signal.aborted) throw new Cancelled();
    while (this.paused) { await this.tick(); if (this.abort.signal.aborted) throw new Cancelled(); }
  }
  async wait(ms) {
    const end = this.time() + ms;
    do { await this.checkpoint(); const remaining = end - this.time(); if (remaining <= 0) return; await this.tick(Math.min(25, remaining)); } while (true);
  }
}
class MacroRunner {
  constructor({ input, authorize = async () => { throw new Error('실제 실행은 창·권한·라이선스 연결 후 사용할 수 있습니다.'); }, onState = () => {} } = {}) {
    this.input = input; this.authorize = authorize; this.onState = onState;
    this.current = { status: 'STOPPED', runId: null, macroId: null, step: null, preview: false, completed: 0, error: null, outcome: null };
    this.active = null;
  }
  state() { return structuredClone(this.current); }
  publish(change) { Object.assign(this.current, change); this.onState(this.state()); }
  start(raw, { preview = false, startIndex = 0 } = {}) {
    if (this.active) throw new Error('이미 실행 또는 정리 중인 매크로가 있습니다.');
    const macro = validateDocument({ version: 2, macros: [raw] }).macros[0];
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= macro.actions.length) throw new Error('실행할 단계가 없습니다.');
    const control = new RunControl();
    const active = { control, done: null }; this.active = active;
    this.publish({ status: 'RUNNING', runId: randomUUID(), macroId: macro.id, step: null, preview, error: null, outcome: null });
    active.done = Promise.resolve().then(async () => {
      let outcome = 'completed'; let failure = null;
      try {
        if (!preview) await this.authorize(macro);
        await this.execute(macro.actions.slice(startIndex), control, macro, preview, [], startIndex);
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
      const action = items[index]; const step = [...prefix, index + offset];
      this.publish({ step });
      if (action.type === 'stop') throw new Cancelled();
      if (action.type === 'wait') await control.wait(action.duration_ms);
      else if (action.type === 'repeat') {
        for (let count = 0; count < action.count; count++) {
          await control.checkpoint(); await this.execute(action.actions, control, macro, preview, step);
          await control.tick(0);
        }
      } else if (!preview) {
        await this.authorize(macro); await control.checkpoint();
        if (!this.input) throw new Error('창 입력 어댑터가 준비되지 않았습니다.');
        // The adapter must honor signal/checkpoint before every OS input and drain before resolving.
        const start = control.time();
        let settled = false; let timedOut = false;
        const operation = Promise.resolve().then(() => this.input.execute(action, macro.target_window, control)).finally(() => { settled = true; });
        operation.catch(() => {});
        while (!settled) {
          if (control.time() - start >= action.timeout_ms) { timedOut = true; control.stop(); }
          await control.tick();
        }
        await operation;
        if (timedOut) throw new Error('단계 timeout을 초과했습니다.');
        await control.checkpoint();
      } else { await control.tick(0); }
    }
  }
  pause() { if (this.active && !this.active.control.abort.signal.aborted) { this.active.control.pause(); this.publish({ status: this.active.control.paused ? 'PAUSED' : 'RUNNING' }); } return this.state(); }
  async stop() { const active = this.active; if (active) { active.control.stop(); await active.done; } return this.state(); }
}
module.exports = { MacroRunner, RunControl };
