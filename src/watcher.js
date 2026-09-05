const path = require('path');
const { captureCenter, captureRegion } = require('./capture');
const { findTemplate, loadTemplate } = require('./matcher');
const { executeActions } = require('./input');

const allowedCenterPatterns = ['니플레티', '카시우스'];
const centerThreshold = 0.92;

class Watcher {
  constructor(config, rootDir, onLog) {
    this.config = config;
    this.rootDir = rootDir;
    this.onLog = onLog;
    this.visible = new Map(config.targets.map((target) => [target.id, false]));
    this.lastTrigger = new Map(config.targets.map((target) => [target.id, 0]));
    this.templates = new Map();
    this.centerPatterns = [];
    this.stopped = false;
    this.paused = false;
  }

  async initialize() {
    for (const target of this.config.targets) this.templates.set(target.id, await loadTemplate(target.imagePath));
    for (const name of allowedCenterPatterns) this.centerPatterns.push(await loadTemplate(path.join(this.rootDir, 'policy', 'center_patterns', `${name}.png`)));
  }

  async isCenterAllowed() {
    const frame = await captureCenter(this.config.monitor);
    for (const pattern of this.centerPatterns) if (await findTemplate(frame, pattern, centerThreshold)) return true;
    return false;
  }

  async scanOnce() {
    if (!(await this.isCenterAllowed())) {
      for (const target of this.config.targets) this.visible.set(target.id, false);
      return;
    }
    for (const target of this.config.targets) {
      if (!target.enabled || this.stopped) continue;
      if (this.paused) { this.visible.set(target.id, false); continue; }
      const match = await findTemplate(await captureRegion(this.config.monitor, target.region), this.templates.get(target.id), target.threshold);
      const isVisible = Boolean(match);
      const wasVisible = this.visible.get(target.id);
      this.visible.set(target.id, isVisible);
      if (!isVisible || wasVisible || Date.now() - this.lastTrigger.get(target.id) < target.cooldownMs) continue;
      this.onLog(`target detected: id=${target.id} score=${match.score.toFixed(4)} x=${match.x} y=${match.y}`);
      if (await executeActions(target.actions, () => this.stopped)) {
        this.lastTrigger.set(target.id, Date.now());
        this.onLog(`actions executed: id=${target.id}`);
      }
    }
  }

  async run() {
    this.onLog(`watcher started with ${this.config.targets.length} target(s)`);
    while (!this.stopped) {
      try { await this.scanOnce(); } catch (error) { this.onLog(`watcher error: ${error.message}`); throw error; }
      await new Promise((resolve) => setTimeout(resolve, this.config.scanIntervalMs));
    }
    this.onLog('watcher stopped');
  }

  stop() { this.stopped = true; }
  togglePause() { this.paused = !this.paused; return this.paused; }
}

module.exports = { Watcher };
