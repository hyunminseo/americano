import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { PRODUCT, macHash } from '../src/license.js';
const root: string = path.join(__dirname, '..', '..');
const privateFile: string = path.join(root, '.local', 'license-issuer', 'private.pem');
const publicFile: string = path.join(root, 'licensing', 'public-key.pem');

interface KeyPair {
  privateKey: string;
  publicKey: string;
}

interface IssueOptions {
  mac: string;
  issuedTo: string;
  expiresAt: string;
  now?: Date;
  features?: string[];
}

async function init(): Promise<KeyPair> {
  await fs.mkdir(path.dirname(privateFile), { recursive: true });
  await fs.mkdir(path.dirname(publicFile), { recursive: true });
  let privateKey: string;
  try { privateKey = await fs.readFile(privateFile, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Never rotate a published authority silently if its private key has been lost.
    try { await fs.access(publicFile); throw new Error('공개키가 이미 있습니다. 기존 발급 개인키를 복원하세요.'); }
    catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing; }
    privateKey = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await fs.writeFile(privateFile, privateKey, { flag: 'wx', mode: 0o600 });
  }
  const publicKey: string = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  try { const existing: string = await fs.readFile(publicFile, 'utf8'); if (existing !== publicKey) throw new Error('발급 개인키와 공개키가 다릅니다.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await fs.writeFile(publicFile, publicKey, { flag: 'wx' }); }
  return { privateKey, publicKey };
}
function issue(privateKey: string | Buffer | crypto.KeyObject, { mac, issuedTo, expiresAt, now = new Date(), features = ['macro.run'] }: IssueOptions): Buffer {
  const expiry: Date = new Date(expiresAt);
  if (!issuedTo?.trim() || issuedTo.length > 200 || !Number.isFinite(expiry.getTime()) || expiry <= now) throw new Error('발급 대상과 미래 만료일이 필요합니다.');
  const payload: Record<string, unknown> = { version: 1, id: crypto.randomUUID(), product: PRODUCT, issuedTo,
    issuedAt: now.toISOString(), notBefore: now.toISOString(), expiresAt: expiry.toISOString(), features,
    binding: { type: 'mac-sha256-v1', hashes: [(macHash as (mac: string) => string)(mac)] } };
  const bytes: Buffer = Buffer.from(JSON.stringify(payload));
  return Buffer.from(JSON.stringify({ version: 1, algorithm: 'Ed25519', payload: bytes.toString('base64'), signature: crypto.sign(null, bytes, privateKey).toString('base64') }));
}
async function cli(): Promise<void> {
  const [command, ...args]: string[] = process.argv.slice(2);
  const keys: KeyPair = await init();
  if (command === 'init') { console.log('발급 키 준비 완료. 개인키는 .local/license-issuer에만 보관합니다.'); return; }
  if (command !== 'issue') throw new Error('Usage: node scripts/license-issuer.cjs init | issue --mac MAC --to NAME --expires ISO_DATE --out FILE');
  const options: Record<string, string> = {};
  for (let i: number = 0; i < args.length; i += 2) { if (!['--mac', '--to', '--expires', '--out'].includes(args[i] as string) || !args[i + 1]) throw new Error('잘못된 옵션입니다.'); options[args[i] as string] = args[i + 1] as string; }
  if (!options['--out']) throw new Error('--out이 필요합니다.');
  const bytes: Buffer = issue(keys.privateKey, { mac: options['--mac'] as string, issuedTo: options['--to'] as string, expiresAt: options['--expires'] as string });
  await fs.writeFile(path.resolve(options['--out'] as string), bytes, { flag: 'wx' });
  console.log('서명된 라이선스를 발급했습니다.');
}
if (require.main === module) cli().catch((error: Error): void => { console.error(error.message); process.exitCode = 1; });
export { init, issue };
