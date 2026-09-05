const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { PRODUCT, macHash } = require('../src/license');
const root = path.join(__dirname, '..');
const privateFile = path.join(root, '.local', 'license-issuer', 'private.pem');
const publicFile = path.join(root, 'licensing', 'public-key.pem');
async function init() {
  await fs.mkdir(path.dirname(privateFile), { recursive: true });
  await fs.mkdir(path.dirname(publicFile), { recursive: true });
  let privateKey;
  try { privateKey = await fs.readFile(privateFile, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Never rotate a published authority silently if its private key has been lost.
    try { await fs.access(publicFile); throw new Error('공개키가 이미 있습니다. 기존 발급 개인키를 복원하세요.'); }
    catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
    privateKey = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    await fs.writeFile(privateFile, privateKey, { flag: 'wx', mode: 0o600 });
  }
  const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  try { const existing = await fs.readFile(publicFile, 'utf8'); if (existing !== publicKey) throw new Error('발급 개인키와 공개키가 다릅니다.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await fs.writeFile(publicFile, publicKey, { flag: 'wx' }); }
  return { privateKey, publicKey };
}
function issue(privateKey, { mac, issuedTo, expiresAt, now = new Date(), features = ['macro.run'] }) {
  const expiry = new Date(expiresAt);
  if (!issuedTo?.trim() || issuedTo.length > 200 || !Number.isFinite(expiry.getTime()) || expiry <= now) throw new Error('발급 대상과 미래 만료일이 필요합니다.');
  const payload = { version: 1, id: crypto.randomUUID(), product: PRODUCT, issuedTo,
    issuedAt: now.toISOString(), notBefore: now.toISOString(), expiresAt: expiry.toISOString(), features,
    binding: { type: 'mac-sha256-v1', hashes: [macHash(mac)] } };
  const bytes = Buffer.from(JSON.stringify(payload));
  return Buffer.from(JSON.stringify({ version: 1, algorithm: 'Ed25519', payload: bytes.toString('base64'), signature: crypto.sign(null, bytes, privateKey).toString('base64') }));
}
async function cli() {
  const [command, ...args] = process.argv.slice(2);
  const keys = await init();
  if (command === 'init') { console.log('발급 키 준비 완료. 개인키는 .local/license-issuer에만 보관합니다.'); return; }
  if (command !== 'issue') throw new Error('Usage: node scripts/license-issuer.cjs init | issue --mac MAC --to NAME --expires ISO_DATE --out FILE');
  const options = {};
  for (let i = 0; i < args.length; i += 2) { if (!['--mac', '--to', '--expires', '--out'].includes(args[i]) || !args[i + 1]) throw new Error('잘못된 옵션입니다.'); options[args[i]] = args[i + 1]; }
  if (!options['--out']) throw new Error('--out이 필요합니다.');
  const bytes = issue(keys.privateKey, { mac: options['--mac'], issuedTo: options['--to'], expiresAt: options['--expires'] });
  await fs.writeFile(path.resolve(options['--out']), bytes, { flag: 'wx' });
  console.log('서명된 라이선스를 발급했습니다.');
}
if (require.main === module) cli().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { init, issue };
