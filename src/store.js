const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateDocument } = require('./macros');
const MAX_BYTES = 16 * 1024 * 1024;
class MacroStore {
  constructor(directory, protector) {
    this.directory = directory; this.protector = protector;
    this.file = path.join(directory, 'macros.enc'); this.keyFile = path.join(directory, 'key.bin');
    this.queue = Promise.resolve(); this.ready = false;
  }
  async open() {
    if (!this.protector.isEncryptionAvailable()) throw new Error('Windows 보호 저장소를 사용할 수 없습니다.');
    await fs.mkdir(this.directory, { recursive: true });
    let wrapped;
    try { wrapped = await fs.readFile(this.keyFile); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await fs.access(this.file); throw new Error('저장소 키가 없습니다. 기존 데이터는 보존됩니다.'); }
      catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
      wrapped = this.protector.encryptString(crypto.randomBytes(32).toString('base64'));
      await fs.writeFile(this.keyFile, wrapped, { flag: 'wx' });
    }
    this.key = Buffer.from(this.protector.decryptString(wrapped), 'base64');
    if (this.key.length !== 32) throw new Error('저장소 키가 잘못되었습니다.');
    let document;
    try {
      if ((await fs.stat(this.file)).size > MAX_BYTES) throw new Error('저장소 크기 제한을 초과했습니다.');
      const bytes = await fs.readFile(this.file);
      if (bytes.length < 32 || bytes.subarray(0, 4).toString() !== 'AM02') throw new Error('저장소 형식이 잘못되었습니다.');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, bytes.subarray(4, 16));
      decipher.setAAD(Buffer.from('AM02')); decipher.setAuthTag(bytes.subarray(16, 32));
      document = validateDocument(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]).toString('utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`저장소 복구 실패. 원본을 보존합니다: ${error.message}`);
      document = validateDocument({ version: 2, macros: [] });
    }
    this.document = document; this.ready = true; return this.snapshot();
  }
  snapshot() { if (!this.ready) throw new Error('저장소가 준비되지 않았습니다.'); return structuredClone(this.document); }
  saveImage(buffer) {
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
    this.queue = job.catch(() => {}); return job;
  }
  async readImage(file) {
    if (!this.ready || path.dirname(path.resolve(file)) !== path.resolve(this.directory) || !/^[a-f0-9-]+\.aimg$/.test(path.basename(file))) throw new Error('허용되지 않은 이미지입니다.');
    if ((await fs.stat(file)).size > MAX_BYTES + 32) throw new Error('이미지 크기 제한을 초과했습니다.');
    const bytes = await fs.readFile(file);
    if (bytes.length < 32 || bytes.subarray(0, 4).toString() !== 'AI01') throw new Error('잘못된 이미지 형식입니다.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, bytes.subarray(4, 16));
    decipher.setAAD(Buffer.from('AI01')); decipher.setAuthTag(bytes.subarray(16, 32));
    return Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]);
  }
  save(raw) {
    const document = validateDocument(raw);
    const job = this.queue.then(async () => {
      if (!this.ready) throw new Error('저장소가 준비되지 않았습니다.');
      const plain = Buffer.from(JSON.stringify(document));
      if (plain.length + 32 > MAX_BYTES) throw new Error('저장소 크기 제한을 초과했습니다.');
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonce); cipher.setAAD(Buffer.from('AM02'));
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      const bytes = Buffer.concat([Buffer.from('AM02'), nonce, cipher.getAuthTag(), encrypted]);
      const temporary = path.join(this.directory, `${crypto.randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporary, 'wx');
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, this.file);
      } finally { await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
      this.document = document; return this.snapshot();
    });
    this.queue = job.catch(() => {}); return job;
  }
}
module.exports = { MacroStore };
