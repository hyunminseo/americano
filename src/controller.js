const fs = require('fs');
const path = require('path');
const { ConfigError, loadConfig } = require('./config');
const { Watcher } = require('./watcher');

class AutomationController {
  constructor(configPath, rootDir, onLog) {
    this.configPath = configPath;
    this.rootDir = rootDir;
    this.onLog = onLog;
    this.watcher = null;
    this.running = false;
    this.paused = false;
    this.error = null;
  }

  state() {
    let config;
    try { config = loadConfig(this.configPath); this.error = null; }
    catch (error) { config = null; if (error instanceof ConfigError) this.error = error.message; }
    return { running: this.running, paused: this.running && this.paused, error: this.error, configPath: this.configPath, monitor: config?.monitor ?? null, scanIntervalMs: config?.scanIntervalMs ?? null, targets: config?.targets.map((target) => ({ id: target.id, image: target.imagePath, trigger: target.trigger, actions_count: target.actions.length, enabled: target.enabled })) ?? [] };
  }

  async start() {
    if (this.running) return this.state();
    const config = loadConfig(this.configPath);
    this.watcher = new Watcher(config, this.rootDir, this.onLog);
    await this.watcher.initialize();
    this.running = true;
    this.paused = false;
    this.watcher.run().catch((error) => { this.error = error.message; this.running = false; this.watcher = null; });
    return this.state();
  }

  async stop() {
    if (this.watcher) this.watcher.stop();
    this.running = false;
    this.paused = false;
    this.watcher = null;
    return this.state();
  }

  pause() {
    if (this.watcher) this.paused = this.watcher.togglePause();
    return this.state();
  }

  async toggleTarget(targetId) {
    const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    const target = raw.targets?.find((item) => item.id === targetId);
    if (!target) throw new ConfigError(`target not found: ${targetId}`);
    target.enabled = !(target.enabled ?? true);
    fs.writeFileSync(this.configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    const wasRunning = this.running;
    if (wasRunning) { await this.stop(); await this.start(); }
    return this.state();
  }
}

module.exports = { AutomationController };
