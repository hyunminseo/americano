const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { issue } = require('../scripts/license-issuer.cjs');
const { verifyLicense, macHash, LicenseManager, readLimited } = require('../src/license');
const { MacroRunner } = require('../src/runner');
const { newMacro } = require('../src/macros');
const pair = crypto.generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
const mac = '34:5A:60:11:22:33'; const other = '02:00:00:00:00:01';
const now = Date.parse('2026-09-05T00:00:00.000Z');
const expiry = '2026-10-05T00:00:00.000Z';
const signed = (options = {}) => issue(pair.privateKey, { mac, issuedTo: 'Test user', expiresAt: expiry, now: new Date(now), ...options });
const check = (bytes, options = {}, key = publicKey) => verifyLicense(bytes, key, { now, macs: [mac], ...options });

test('MAC normalization, multiple adapters, and a different MAC', () => {
  assert.equal(macHash('34-5a-60-11-22-33'), macHash(mac));
  assert.equal(check(signed()).code, 'VALID');
  assert.equal(check(signed(), { macs: [other, mac] }).code, 'VALID');
  assert.equal(check(signed({ mac: other })).code, 'DEVICE_MISMATCH');
  assert.equal(check(signed(), { macs: [] }).code, 'DEVICE_UNAVAILABLE');
});
test('signature tampering, wrong key, absent key, malformed and oversized files', () => {
  const envelope = JSON.parse(signed());
  const payload = JSON.parse(Buffer.from(envelope.payload, 'base64'));
  payload.issuedTo = 'Attacker'; envelope.payload = Buffer.from(JSON.stringify(payload)).toString('base64');
  assert.equal(check(Buffer.from(JSON.stringify(envelope))).code, 'INVALID_SIGNATURE');
  const wrong = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal(check(signed(), {}, wrong).code, 'INVALID_SIGNATURE');
  assert.equal(check(signed(), {}, '').code, 'KEY_UNAVAILABLE');
  for (const bytes of [Buffer.from('oops'), Buffer.alloc(32769), Buffer.from('{"version":5}')]) assert.equal(check(bytes).code, 'INVALID');
  assert.equal(check(null).code, 'MISSING');
});
test('expiry boundary, not-before and feature permission are enforced', () => {
  assert.equal(check(signed(), { now: Date.parse(expiry) - 1 }).code, 'VALID');
  assert.equal(check(signed(), { now: Date.parse(expiry) }).code, 'EXPIRED');
  assert.equal(check(signed(), { now: now - 1 }).code, 'NOT_YET_VALID');
  assert.equal(check(signed({ features: [] })).code, 'FEATURE_DENIED');
});
test('correctly signed wrong product and malformed payload fail', () => {
  const envelope = JSON.parse(signed()); const payload = JSON.parse(Buffer.from(envelope.payload, 'base64'));
  function altered(change) { const bytes = Buffer.from(JSON.stringify({ ...payload, ...change })); return Buffer.from(JSON.stringify({ ...envelope, payload: bytes.toString('base64'), signature: crypto.sign(null, bytes, pair.privateKey).toString('base64') })); }
  assert.equal(check(altered({ product: 'other' })).code, 'WRONG_PRODUCT');
  assert.equal(check(altered({ binding: { type: 'mac-sha256-v1', hashes: [] } })).code, 'INVALID');
});
test('registration persists, rejects replacement by invalid license, and does not fall back after corruption', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'americano-license-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bundledFile = path.join(dir, 'bundled.lic'); await fs.writeFile(bundledFile, signed({ mac: other }));
  const options = { directory: path.join(dir, 'user'), publicKey, bundledFile, getMacs: () => [mac], clock: () => now };
  const manager = new LicenseManager(options); assert.equal((await manager.open()).code, 'DEVICE_MISMATCH');
  await manager.install(signed()); assert.equal(manager.authorize().valid, true);
  const before = await fs.readFile(manager.file);
  await assert.rejects(manager.install(signed({ mac: other })), /MAC/);
  assert.deepEqual(await fs.readFile(manager.file), before);
  const reopened = new LicenseManager(options); assert.equal((await reopened.open()).code, 'VALID');
  await fs.writeFile(manager.file, 'corrupt'); assert.equal((await new LicenseManager(options).open()).code, 'INVALID');
  await fs.writeFile(manager.file, Buffer.alloc(32769)); await assert.rejects(readLimited(manager.file), /32KB/);
});
test('expiry interrupts a paused real run but leaves input-free preview available', async () => {
  let clock = now;
  const manager = new LicenseManager({ directory: 'unused', publicKey, getMacs: () => [mac], clock: () => clock });
  manager.bytes = signed();
  let entered; const began = new Promise((resolve) => { entered = resolve; });
  const runner = new MacroRunner({ authorize: () => manager.authorize(), onState: (state) => { if (state.step) entered(); } });
  const macro = { ...newMacro(), actions: [{ type: 'wait', duration_ms: 60000 }] };
  runner.start(macro); await began; runner.pause(); clock = Date.parse(expiry);
  const finished = runner.active.done; runner.invalidate(manager.state().message); await finished;
  assert.equal(runner.state().status, 'ERROR'); assert.match(runner.state().error, /만료/);
  runner.start({ ...macro, actions: [{ type: 'wait', duration_ms: 0 }] }, { preview: true });
  await runner.active.done; assert.equal(runner.state().outcome, 'completed');
});
