import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigError, loadConfig } from './config.js';
import { Watcher } from './watcher.js';

export class AutomationController {
  configPath: string;
  rootDir: string;
  onLog: (message: string) => void;
  watcher: Watcher | null = null;
  running = false;
  paused = false;
  error: string | null = null;

  constructor(configPath: string, rootDir: string, onLog: (message: string) => void) {
    this.configPath = configPath;
    this.rootDir = rootDir;
    this.onLog = onLog;
    this.watcher = null;
    this.running = false;
    this.paused = false;
    this.error = null;
  }

  state(): Record<string, unknown> {
    let config: ReturnType<typeof loadConfig> | null;
    try { config = loadConfig(this.configPath); this.error = null; }
    catch (error) { config = null; if (error instanceof ConfigError) this.error = error.message; }
    return { running: this.running, paused: this.running && this.paused, error: this.error, configPath: this.configPath, monitor: config?.monitor ?? null, scanIntervalMs: config?.scanIntervalMs ?? null, targets: config?.targets.map((target) => ({ id: target.id, image: target.imagePath, trigger: target.trigger, actions_count: target.actions.length, enabled: target.enabled })) ?? [] };
  }

  async start(): Promise<Record<string, unknown>> {
    if (this.running) return this.state();
    const config = loadConfig(this.configPath);
    this.watcher = new Watcher(config, this.rootDir, this.onLog);
    await this.watcher.initialize();
    this.running = true;
    this.paused = false;
    this.watcher.run().catch((error: Error) => { this.error = error.message; this.running = false; this.watcher = null; });
    return this.state();
  }

  async stop(): Promise<Record<string, unknown>> {
    if (this.watcher) this.watcher.stop();
    this.running = false;
    this.paused = false;
    this.watcher = null;
    return this.state();
  }

  pause(): Record<string, unknown> {
    if (this.watcher) this.paused = this.watcher.togglePause();
    return this.state();
  }

  async toggleTarget(targetId: string): Promise<Record<string, unknown>> {
    const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as { targets?: { id: string; enabled?: boolean }[] };
    const target = raw.targets?.find((item) => item.id === targetId);
    if (!target) throw new ConfigError(`target not found: ${targetId}`);
    target.enabled = !(target.enabled ?? true);
    fs.writeFileSync(this.configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    const wasRunning = this.running;
    if (wasRunning) { await this.stop(); await this.start(); }
    return this.state();
  }
}
