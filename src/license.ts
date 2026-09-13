import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const PRODUCT = 'com.americano.automation';
export const MAX_LICENSE_BYTES = 32768;

const messages: Record<string, string> = {
  VALID: '라이선스 인증 성공', MISSING: '등록된 라이선스가 없습니다.',
  INVALID: '라이선스 형식이 올바르지 않습니다.', INVALID_SIGNATURE: '라이선스 서명이 올바르지 않습니다.',
  WRONG_PRODUCT: '다른 제품의 라이선스입니다.', DEVICE_MISMATCH: '이 PC의 MAC 주소와 일치하지 않습니다.',
  DEVICE_UNAVAILABLE: '사용 가능한 MAC 주소를 찾을 수 없습니다.', EXPIRED: '라이선스가 만료되었습니다.',
  NOT_YET_VALID: '라이선스 사용 시작일 이전입니다.', FEATURE_DENIED: '매크로 실행 권한이 없는 라이선스입니다.',
  KEY_UNAVAILABLE: '라이선스 검증 공개키를 사용할 수 없습니다.', STORAGE_ERROR: '라이선스 저장소를 읽을 수 없습니다.',
};

export interface LicenseStatus {
  valid: boolean;
  code: string;
  message: string;
  [key: string]: unknown;
}

export function normalizeMac(value: unknown): string {
  if (typeof value !== 'string') throw new Error('MAC 주소가 필요합니다.');
  const compact = value.replace(/[:-]/g, '').toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(compact) || /^(0{12}|F{12})$/.test(compact) || (parseInt(compact.slice(0, 2), 16) & 1)) throw new Error('유효한 유니캐스트 MAC 주소가 필요합니다.');
  return (compact.match(/.{2}/g) as string[]).join(':');
}

export function macHash(mac: string): string {
  return crypto.createHash('sha256').update(`${PRODUCT}:mac-v1:${normalizeMac(mac)}`).digest('hex');
}

export function deviceMacs(): string[] {
  const result = new Set<string>();
  for (const entries of Object.values(os.networkInterfaces())) for (const entry of entries || []) {
    if (entry.internal) continue;
    try { result.add(normalizeMac(entry.mac)); } catch { /* Ignore zero/invalid addresses. */ }
  }
  return [...result].sort();
}

export async function readDeviceMacs(): Promise<string[]> {
  const result = new Set<string>(deviceMacs());
  if (process.platform === 'win32') {
    try {
      const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'getmac.exe');
      const { stdout } = await promisify(execFile)(executable, ['/fo', 'csv', '/nh'], { windowsHide: true, timeout: 3000, maxBuffer: 65536 });
      for (const value of stdout.match(/[0-9a-f]{2}(?:-[0-9a-f]{2}){5}/gi) || []) {
        try { result.add(normalizeMac(value)); } catch { /* Ignore invalid entries. */ }
      }
    } catch { /* Active adapter fallback; no bypass if both sources are unavailable. */ }
  }
  return [...result].sort();
}

function status(code: string, fields: Record<string, unknown> = {}): LicenseStatus {
  return { valid: code === 'VALID', code, message: messages[code], ...fields };
}

function base64(value: unknown): Buffer {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('base64');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('base64');
  return bytes;
}

interface LicensePayload {
  version: unknown;
  id: unknown;
  issuedTo: unknown;
  issuedAt: unknown;
  notBefore: unknown;
  expiresAt: unknown;
  features: unknown;
  product: unknown;
  binding: {
    type: unknown;
    hashes: unknown;
  };
}

export function verifyLicense(bytes: Buffer | null, publicKey: string, { now = Date.now(), macs = deviceMacs() }: { now?: number; macs?: string[] } = {}): LicenseStatus {
  if (!bytes) return status('MISSING');
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error();
  } catch { return status('KEY_UNAVAILABLE'); }
  let payload: LicensePayload;
  try {
    if (Buffer.byteLength(bytes) > MAX_LICENSE_BYTES) throw new Error('size');
    const envelope = JSON.parse(bytes.toString()) as { version: unknown; algorithm: unknown; payload: unknown; signature: unknown };
    if (envelope.version !== 1 || envelope.algorithm !== 'Ed25519') throw new Error('envelope');
    const raw = base64(envelope.payload);
    const signature = base64(envelope.signature);
    if (signature.length !== 64 || !crypto.verify(null, raw, key, signature)) return status('INVALID_SIGNATURE');
    payload = JSON.parse(raw.toString('utf8')) as LicensePayload;
    const date = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
    if (payload.version !== 1 || typeof payload.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(payload.id) ||
        typeof payload.issuedTo !== 'string' || !payload.issuedTo.trim() || payload.issuedTo.length > 200 ||
        !date(payload.issuedAt) || !date(payload.notBefore) || !date(payload.expiresAt) ||
        Date.parse(payload.issuedAt as string) > Date.parse(payload.notBefore as string) || Date.parse(payload.notBefore as string) >= Date.parse(payload.expiresAt as string) ||
        !Array.isArray(payload.features) || payload.features.length > 32 || !payload.features.every((f) => typeof f === 'string' && (f as string).length < 64) ||
        payload.binding?.type !== 'mac-sha256-v1' || !Array.isArray(payload.binding.hashes) ||
        payload.binding.hashes.length < 1 || payload.binding.hashes.length > 16 || !payload.binding.hashes.every((h) => /^[a-f0-9]{64}$/.test(h as string))) throw new Error('payload');
  } catch { return status('INVALID'); }
  if (payload.product !== PRODUCT) return status('WRONG_PRODUCT');
  const fields = { id: payload.id, issuedTo: payload.issuedTo, issuedAt: payload.issuedAt, expiresAt: payload.expiresAt, features: payload.features };
  if (!Number.isFinite(now)) return status('INVALID');
  if (now < Date.parse(payload.notBefore as string)) return status('NOT_YET_VALID', fields as Record<string, unknown>);
  if (now >= Date.parse(payload.expiresAt as string)) return status('EXPIRED', fields as Record<string, unknown>);
  const hashes = macs.flatMap((mac) => { try { return [macHash(mac)]; } catch { return []; } });
  if (!hashes.length) return status('DEVICE_UNAVAILABLE', fields as Record<string, unknown>);
  if (!hashes.some((hash) => (payload.binding.hashes as string[]).includes(hash))) return status('DEVICE_MISMATCH', fields as Record<string, unknown>);
  if (!(payload.features as string[]).includes('macro.run')) return status('FEATURE_DENIED', fields as Record<string, unknown>);
  return status('VALID', fields as Record<string, unknown>);
}

export async function readLimited(file: string): Promise<Buffer> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(MAX_LICENSE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_LICENSE_BYTES) throw new Error('라이선스 파일은 32KB 이하여야 합니다.');
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

export class LicenseManager {
  directory: string;
  file: string;
  publicKey: string;
  bundledFile: string | null;
  getMacs: () => string[];
  clock: () => number;
  bytes: Buffer | null = null;
  source: string | null = null;
  loadError = false;
  queue: Promise<unknown> = Promise.resolve();

  constructor({ directory, publicKey, bundledFile = null, getMacs = deviceMacs, clock = Date.now }: {
    directory: string;
    publicKey: string;
    bundledFile?: string | null;
    getMacs?: () => string[];
    clock?: () => number;
  }) {
    this.directory = directory;
    this.file = path.join(directory, 'license.lic');
    this.publicKey = publicKey;
    this.bundledFile = bundledFile;
    this.getMacs = getMacs;
    this.clock = clock;
    this.bytes = null;
    this.source = null;
    this.loadError = false;
    this.queue = Promise.resolve();
  }

  async open(): Promise<LicenseStatus & { source: string | null }> {
    try { this.bytes = await readLimited(this.file); this.source = 'registered'; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.loadError = true; return this.state(); }
      if (this.bundledFile) {
        try { this.bytes = await readLimited(this.bundledFile); this.source = 'bundled'; }
        catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') this.loadError = true; }
      }
    }
    return this.state();
  }

  state(): LicenseStatus & { source: string | null } {
    let result: LicenseStatus;
    try { result = this.loadError ? status('STORAGE_ERROR') : verifyLicense(this.bytes, this.publicKey, { now: this.clock(), macs: this.getMacs() }); }
    catch { result = status('DEVICE_UNAVAILABLE'); }
    return { ...result, source: this.source };
  }

  authorize(): LicenseStatus & { source: string | null } {
    const result = this.state();
    if (!result.valid) throw new Error(result.message);
    return result;
  }

  install(bytes: Buffer): Promise<LicenseStatus & { source: string | null }> {
    const snapshot = Buffer.from(bytes);
    const task = this.queue.then(async () => {
      const result = verifyLicense(snapshot, this.publicKey, { now: this.clock(), macs: this.getMacs() });
      if (!result.valid) throw new Error(result.message);
      await fs.mkdir(this.directory, { recursive: true });
      const temporary = path.join(this.directory, `${crypto.randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporary, 'wx');
        try { await handle.writeFile(snapshot); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, this.file);
      } finally { await fs.unlink(temporary).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
      this.bytes = snapshot;
      this.source = 'registered';
      this.loadError = false;
      return this.state();
    });
    this.queue = task.catch(() => {});
    return task;
  }
}
