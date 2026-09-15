import { isDeepStrictEqual } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { validateDocument, MacroDocument, Region, Roi } from './macros.js';

const MAX_BYTES = 16 * 1024 * 1024;

export interface Protector {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(bytes: Buffer): string;
}

export interface StoredDocument {
  version: 2;
  macros: MacroDocument[];
  [key: string]: unknown;
}

export interface LearnedMatch {
  region: Region;
  roi: Roi | null;
  scaleFactor: number | null;
}

export class MacroStore {
  directory: string;
  protector: Protector;
  file: string;
  keyFile: string;
  queue: Promise<unknown> = Promise.resolve();
  ready = false;
  document!: StoredDocument;
  private key!: Buffer;

  constructor(directory: string, protector: Protector) {
    this.directory = directory;
    this.protector = protector;
    this.file = path.join(directory, 'macros.enc');
    this.keyFile = path.join(directory, 'key.bin');
    this.queue = Promise.resolve();
    this.ready = false;
  }

  async open(): Promise<StoredDocument> {
    if (!this.protector.isEncryptionAvailable()) throw new Error('Windows 보호 저장소를 사용할 수 없습니다.');
    await fs.mkdir(this.directory, { recursive: true });
    let wrapped: Buffer;
    try { wrapped = await fs.readFile(this.keyFile); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { await fs.access(this.file); throw new Error('저장소 키가 없습니다. 기존 데이터는 보존됩니다.'); }
      catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing; }
      wrapped = this.protector.encryptString(crypto.randomBytes(32).toString('base64'));
      await fs.writeFile(this.keyFile, wrapped, { flag: 'wx' });
    }
    this.key = Buffer.from(this.protector.decryptString(wrapped), 'base64');
    if (this.key.length !== 32) throw new Error('저장소 키가 잘못되었습니다.');
    let document: StoredDocument;
    try {
      if ((await fs.stat(this.file)).size > MAX_BYTES) throw new Error('저장소 크기 제한을 초과했습니다.');
      const bytes = await fs.readFile(this.file);
      if (bytes.length < 32 || bytes.subarray(0, 4).toString() !== 'AM02') throw new Error('저장소 형식이 잘못되었습니다.');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, bytes.subarray(4, 16));
      decipher.setAAD(Buffer.from('AM02'));
      decipher.setAuthTag(bytes.subarray(16, 32));
      document = validateDocument(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]).toString('utf8'))) as StoredDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`저장소 복구 실패. 원본을 보존합니다: ${(error as Error).message}`);
      document = validateDocument({ version: 2, macros: [] }) as StoredDocument;
    }
    this.document = document;
    this.ready = true;
    return this.snapshot();
  }

  snapshot(): StoredDocument {
    if (!this.ready) throw new Error('저장소가 준비되지 않았습니다.');
    return structuredClone(this.document);
  }

  saveImage(buffer: Buffer): Promise<string> {
    const job = this.queue.then(async () => {
      if (!this.ready || !Buffer.isBuffer(buffer) || buffer.length > MAX_BYTES) throw new Error('이미지 저장소 또는 크기가 잘못되었습니다.');
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonce);
      cipher.setAAD(Buffer.from('AI01'));
      const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
      const file = path.join(this.directory, `${crypto.randomUUID()}.aimg`);
      const temporary = `${file}.tmp`;
      try {
        await fs.writeFile(temporary, Buffer.concat([Buffer.from('AI01'), nonce, cipher.getAuthTag(), encrypted]), { flag: 'wx' });
        await fs.rename(temporary, file);
      } finally { await fs.unlink(temporary).catch(() => {}); }
      return file;
    });
    this.queue = job.catch(() => {});
    return job;
  }

  async readImage(file: string): Promise<Buffer> {
    if (!this.ready || path.dirname(path.resolve(file)) !== path.resolve(this.directory) || !/^[a-f0-9-]+\.aimg$/.test(path.basename(file))) throw new Error('허용되지 않은 이미지입니다.');
    if ((await fs.stat(file)).size > MAX_BYTES + 32) throw new Error('이미지 크기 제한을 초과했습니다.');
    const bytes = await fs.readFile(file);
    if (bytes.length < 32 || bytes.subarray(0, 4).toString() !== 'AI01') throw new Error('잘못된 이미지 형식입니다.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, bytes.subarray(4, 16));
    decipher.setAAD(Buffer.from('AI01'));
    decipher.setAuthTag(bytes.subarray(16, 32));
    return Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]);
  }

  deleteImage(file: string): Promise<void> {
    const job = this.queue.then(async () => {
      if (!this.ready || path.dirname(path.resolve(file)) !== path.resolve(this.directory) || !/^[a-f0-9-]+\.aimg$/.test(path.basename(file))) throw new Error('허용되지 않은 이미지입니다.');
      await fs.unlink(file).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    });
    this.queue = job.catch(() => {});
    return job as Promise<void>;
  }

  updateLearnedPosition(macroId: string, assetPath: string, position: Region, target: Record<string, unknown>, overlay: Region | null): Promise<StoredDocument> {
    return this.save(document => {
      const macro = document.macros.find(m => m.id === macroId);
      if (!macro || !isDeepStrictEqual(macro.target_window, target) || !isDeepStrictEqual(macro.overlay, overlay ?? null)) return document;
      const asset = macro.images.find(a => a.path === assetPath);
      if (asset) asset.learned_region = position;
      return document;
    });
  }

  // 자동 최적화: 적중 위치(learned_region)와 상대 ROI(learned_roi),
  // 피라미드 적중 배율(learned_scale_factor)을 함께 저장한다.
  updateLearnedMatch(macroId: string, assetPath: string, learned: LearnedMatch, target: Record<string, unknown>, overlay: Region | null): Promise<StoredDocument> {
    return this.save(document => {
      const macro = document.macros.find(m => m.id === macroId);
      if (!macro || !isDeepStrictEqual(macro.target_window, target) || !isDeepStrictEqual(macro.overlay, overlay ?? null)) return document;
      const asset = macro.images.find(a => a.path === assetPath);
      if (asset) {
        asset.learned_region = learned.region;
        asset.learned_roi = learned.roi;
        if (learned.scaleFactor) asset.learned_scale_factor = learned.scaleFactor;
      }
      return document;
    });
  }

  // 자산의 학습값(위치·ROI·배율)을 모두 초기화한다.
  resetLearned(macroId: string, assetPath: string): Promise<StoredDocument> {
    return this.save(document => {
      const macro = document.macros.find(m => m.id === macroId);
      const asset = macro?.images.find(a => a.path === assetPath);
      if (asset) { asset.learned_region = null; asset.learned_roi = null; asset.learned_scale_factor = null; }
      return document;
    });
  }

  // 실행 통계 누적: 단계별 탐색 횟수·소요 시간·성패를 매크로에 저장한다.
  // 자동 최적화(탐색 간격 조정)의 근거가 된다. 최대 200개 키를 유지한다.
  updateRunStats(macroId: string, entries: { key: string; type: string; scans: number; ms: number; ok: boolean }[]): Promise<StoredDocument> {
    return this.save(document => {
      const macro = document.macros.find(m => m.id === macroId);
      if (!macro) return document;
      const stats = (macro.stats ?? {}) as Record<string, { runs: number; hits: number; misses: number; scans: number; ms: number; type?: string }>;
      for (const entry of entries || []) {
        if (!entry || typeof entry.key !== 'string' || !entry.key || entry.key.length > 64) continue;
        const record = stats[entry.key] ?? { runs: 0, hits: 0, misses: 0, scans: 0, ms: 0 };
        record.runs += 1;
        if (entry.ok) record.hits += 1; else record.misses += 1;
        record.scans += Math.max(0, entry.scans || 0);
        record.ms += Math.max(0, entry.ms || 0);
        if (typeof entry.type === 'string' && entry.type) record.type = entry.type.slice(0, 32);
        stats[entry.key] = record;
      }
      const keys = Object.keys(stats);
      if (keys.length > 200) for (const extra of keys.slice(0, keys.length - 200)) delete stats[extra];
      macro.stats = stats;
      return document;
    });
  }

  save(raw: StoredDocument | ((snapshot: StoredDocument) => StoredDocument)): Promise<StoredDocument> {
    const snapshot = typeof raw === 'function' ? null : validateDocument(raw) as StoredDocument;
    const job = this.queue.then(async () => {
      if (!this.ready) throw new Error('저장소가 준비되지 않았습니다.');
      const document = snapshot || validateDocument((raw as (snapshot: StoredDocument) => StoredDocument)(this.snapshot())) as StoredDocument;
      // Runtime learning must survive a save from an editor opened before the run.
      if (snapshot) for (const macro of document.macros) {
        const old = this.document.macros.find(m => m.id === macro.id);
        if (!old) continue;
        if (!isDeepStrictEqual(old.target_window, macro.target_window) || !isDeepStrictEqual(old.overlay, macro.overlay)) {
          macro.images.forEach(asset => { asset.learned_region = null; });
          continue;
        }
        for (const asset of macro.images) {
          const previous = old.images.find(a => a.id === asset.id && a.path === asset.path);
          if (previous && isDeepStrictEqual(previous.region, asset.region)) {
            asset.learned_region = previous.learned_region;
            asset.learned_roi = previous.learned_roi ?? null;
            asset.learned_scale_factor = previous.learned_scale_factor ?? null;
          }
        }
      }
      const plain = Buffer.from(JSON.stringify(document));
      if (plain.length + 32 > MAX_BYTES) throw new Error('저장소 크기 제한을 초과했습니다.');
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonce);
      cipher.setAAD(Buffer.from('AM02'));
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      const bytes = Buffer.concat([Buffer.from('AM02'), nonce, cipher.getAuthTag(), encrypted]);
      const temporary = path.join(this.directory, `${crypto.randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporary, 'wx');
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, this.file);
      } finally { await fs.unlink(temporary).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
      this.document = document;
      return this.snapshot();
    });
    this.queue = job.catch(() => {});
    return job;
  }
}
