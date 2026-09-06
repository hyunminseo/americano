const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MacroStore } = require('../src/store');
const { newMacro } = require('../src/macros');
// Test-only protection seam; production receives Electron safeStorage.
const protector = { isEncryptionAvailable: () => true, encryptString: (text) => Buffer.from(text), decryptString: (bytes) => bytes.toString() };
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'americano-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new MacroStore(dir, protector); await store.open(); return { dir, store };
}
test('encrypts at rest with fresh nonce and restores across instances', async (t) => {
  const { dir, store } = await setup(t); const a = newMacro(); a.name = 'secret-macro-name';
  await store.save({ version: 2, macros: [a] }); const first = await fs.readFile(store.file);
  assert.equal(first.includes(Buffer.from(a.name)), false);
  await store.save({ version: 2, macros: [a] }); const second = await fs.readFile(store.file);
  assert.notDeepEqual(first, second);
  const reopened = new MacroStore(dir, protector); assert.equal((await reopened.open()).macros[0].name, a.name);
});
test('serializes writes and rejects invalid data before replacing disk', async (t) => {
  const { store } = await setup(t); const a = newMacro(); const b = { ...a, name: 'latest' };
  await Promise.all([store.save({ version: 2, macros: [a] }), store.save({ version: 2, macros: [b] })]);
  assert.equal(store.snapshot().macros[0].name, 'latest');
  const before = await fs.readFile(store.file);
  assert.throws(() => store.save({ version: 1 })); assert.deepEqual(await fs.readFile(store.file), before);
});
test('tamper detection preserves file and prevents saving over failed recovery', async (t) => {
  const { dir, store } = await setup(t); await store.save({ version: 2, macros: [newMacro()] });
  const bytes = await fs.readFile(store.file); bytes[bytes.length - 1] ^= 1; await fs.writeFile(store.file, bytes);
  const reopened = new MacroStore(dir, protector); await assert.rejects(reopened.open(), /원본/);
  await assert.rejects(reopened.save({ version: 2, macros: [] }), /준비/);
  assert.deepEqual(await fs.readFile(store.file), bytes);
});
test('missing key and unavailable protection never downgrade to plaintext', async (t) => {
  const { dir, store } = await setup(t); await store.save({ version: 2, macros: [] });
  await fs.unlink(store.keyFile);
  await assert.rejects(new MacroStore(dir, protector).open(), /키가 없습니다/);
  await assert.rejects(new MacroStore(dir, { isEncryptionAvailable: () => false }).open(), /보호 저장소/);
});

test('captured images are encrypted, recover after restart, and reject tampering', async t => {
  const {dir,store}=await setup(t); const image=Buffer.from('private captured image');
  const file=await store.saveImage(image);
  const bytes=await fs.readFile(file); assert.equal(bytes.includes(image),false);
  const restored=new MacroStore(dir,protector); await restored.open();
  assert.deepEqual(await restored.readImage(file),image);
  bytes[bytes.length-1]^=1; await fs.writeFile(file,bytes);
  await assert.rejects(restored.readImage(file));
  await assert.rejects(restored.readImage(path.join(dir,'..','outside.aimg')));
});
