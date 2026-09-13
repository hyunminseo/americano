import * as path from 'node:path';
import { captureCenter, captureRegion } from './capture.js';
import { findTemplate, loadTemplate } from './matcher.js';
import { executeActions } from './input.js';
import type { LoadedConfig } from './config.js';

const allowedCenterPatterns = ['니플레티', '카시우스'];
const centerThreshold = 0.92;

type TemplateImage = Awaited<ReturnType<typeof loadTemplate>>;

export class Watcher {
  config: LoadedConfig;
  rootDir: string;
  onLog: (message: string) => void;
  visible = new Map<string, boolean>();
  lastTrigger = new Map<string, number>();
  templates = new Map<string, TemplateImage>();
  centerPatterns: TemplateImage[] = [];
  stopped = false;
  paused = false;

  constructor(config: LoadedConfig, rootDir: string, onLog: (message: string) => void) {
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

  async initialize(): Promise<void> {
    for (const target of this.config.targets) this.templates.set(target.id, await loadTemplate(target.imagePath));
    for (const name of allowedCenterPatterns) this.centerPatterns.push(await loadTemplate(path.join(this.rootDir, 'policy', 'center_patterns', `${name}.png`)));
  }

  async isCenterAllowed(): Promise<boolean> {
    const frame = await captureCenter(this.config.monitor);
    for (const pattern of this.centerPatterns) if (await findTemplate(frame, pattern, centerThreshold)) return true;
    return false;
  }

  async scanOnce(): Promise<void> {
    if (!(await this.isCenterAllowed())) {
      for (const target of this.config.targets) this.visible.set(target.id, false);
      return;
    }
    for (const target of this.config.targets) {
      if (!target.enabled || this.stopped) continue;
      if (this.paused) { this.visible.set(target.id, false); continue; }
      const match = await findTemplate(await captureRegion(this.config.monitor, target.region), this.templates.get(target.id) as TemplateImage, target.threshold);
      const isVisible = Boolean(match);
      const wasVisible = this.visible.get(target.id);
      this.visible.set(target.id, isVisible);
      if (!isVisible || wasVisible || Date.now() - (this.lastTrigger.get(target.id) as number) < target.cooldownMs) continue;
      this.onLog(`target detected: id=${target.id} score=${(match as NonNullable<Awaited<ReturnType<typeof findTemplate>>>).score.toFixed(4)} x=${(match as { x: number }).x} y=${(match as { y: number }).y}`);
      if (await executeActions(target.actions, () => this.stopped)) {
        this.lastTrigger.set(target.id, Date.now());
        this.onLog(`actions executed: id=${target.id}`);
      }
    }
  }

  async run(): Promise<void> {
    this.onLog(`watcher started with ${this.config.targets.length} target(s)`);
    while (!this.stopped) {
      try { await this.scanOnce(); } catch (error) { this.onLog(`watcher error: ${(error as Error).message}`); throw error; }
      await new Promise((resolve) => setTimeout(resolve, this.config.scanIntervalMs));
    }
    this.onLog('watcher stopped');
  }

  stop(): void { this.stopped = true; }
  togglePause(): boolean { this.paused = !this.paused; return this.paused; }
}
