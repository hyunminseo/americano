import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as vm from 'node:vm';
import { build, Platform, Arch } from 'electron-builder';
import * as asar from '@electron/asar';
import { init, issue } from './license-issuer.js';
import { normalizeMac, deviceMacs, verifyLicense } from '../src/license.js';
const root: string = path.join(__dirname, '..', '..');

interface ComparisonBuild {
  variant: string;
  executable: string;
  expected: string;
  actual: string;
  sha256: string;
}

interface ComparisonReport {
  issuedAt: string;
  expiresAt: string;
  actualMac: string;
  fictionalMac: string;
  builds: ComparisonBuild[];
}

interface BuilderConfig {
  appId?: string;
  directories?: unknown;
  extraMetadata?: unknown;
  portable?: Record<string, unknown>;
  extraResources?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

async function main(): Promise<void> {
  const args: string[] = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--mac') throw new Error('Usage: npm run build:license-compare -- --mac XX:XX:XX:XX:XX:XX');
  const actual: string = normalizeMac(args[1] as string);
  const localMacs: string[] = deviceMacs();
  if (!localMacs.includes(actual)) throw new Error('선택한 MAC을 현재 PC에서 찾을 수 없습니다. 해당 어댑터를 연결하세요.');
  let fake: string = '02:00:00:00:00:01';
  while (localMacs.includes(fake)) fake = normalizeMac('02' + crypto.randomBytes(5).toString('hex'));
  const keys: { privateKey: string; publicKey: string } = await init();
  const issuedAt: Date = new Date(); const expiresAt: string = new Date(issuedAt.getTime() + 30 * 86400000).toISOString();
  const staging: string = path.join(root, '.local', 'license-comparison'); await fs.mkdir(staging, { recursive: true });
  const report: ComparisonReport = { issuedAt: issuedAt.toISOString(), expiresAt, actualMac: actual, fictionalMac: fake, builds: [] };
  const base: BuilderConfig = (require('../package.json') as { build: BuilderConfig }).build;
  const variants: Array<[string, string, string, string]> = [
    ['mac-match', actual, 'VALID', 'Americano-MyMAC.exe'],
    ['mac-mismatch', fake, 'DEVICE_MISMATCH', 'Americano-OtherMAC.exe'],
  ];
  for (const [variant, mac, expected, artifactName] of variants) {
    const bytes: Buffer = issue(keys.privateKey, { mac, issuedTo: `Local comparison (${variant})`, expiresAt, now: issuedAt });
    const bundled: string = path.join(staging, `${variant}.lic`); await fs.writeFile(bundled, bytes);
    const result: { code: string } = verifyLicense(bytes, keys.publicKey);
    if (result.code !== expected) throw new Error(`Preflight ${variant}: ${result.code}`);
    const output: string = path.join(root, 'dist', 'license-comparison', variant);
    await build({
      projectDir: root, targets: Platform.WINDOWS.createTarget('portable', Arch.x64), config: {
      ...base, appId: `com.americano.automation.${variant}`, directories: { output },
      extraMetadata: { americanoVariant: variant }, portable: { ...base.portable, artifactName },
      extraResources: [...(base.extraResources as Array<Record<string, unknown>>), { from: bundled, to: 'licensing/bundled.lic' }],
    } } as Parameters<typeof build>[0]);
    const resources: string = path.join(output, 'win-unpacked', 'resources');
    const archive: string = path.join(resources, 'app.asar');
    const entries: string[] = asar.listPackage(archive, { isPack: false }).map((name: string): string => name.replaceAll('\\', '/'));
    if (entries.some((name: string): boolean => /(^|\/)(?:\.local|private\.pem|license-issuer\.cjs|config\.example\.json|config\.v2\.example\.json)(\/|$)/.test(name))) throw new Error('패키지에 배포 금지 파일이 포함되었습니다.');
    const code: Buffer = asar.extractFile(archive, path.join('compiled', 'src', 'license.js'));
    if (!code.equals(await fs.readFile(path.join(root, 'compiled', 'src', 'license.js')))) throw new Error('검증기 코드가 빌드와 다릅니다.');
    const sandbox: { module: { exports: Record<string, unknown> }; require: NodeRequire; Buffer: BufferConstructor } = { module: { exports: {} }, require, Buffer };
    vm.runInNewContext(code.toString(), sandbox, { filename: 'packaged-license.js' });
    const packaged: { code: string } = (sandbox.module.exports as { verifyLicense: (bytes: Buffer, key: string | Buffer) => { code: string } }).verifyLicense(await fs.readFile(path.join(resources, 'licensing', 'bundled.lic')), await fs.readFile(path.join(resources, 'licensing', 'public-key.pem')));
    if (packaged.code !== expected) throw new Error(`Packaged ${variant}: ${packaged.code}`);
    const executable: string = path.join(output, artifactName);
    report.builds.push({ variant, executable: path.relative(root, executable), expected, actual: packaged.code, sha256: crypto.createHash('sha256').update(await fs.readFile(executable)).digest('hex') });
    console.log(`${artifactName}: ${packaged.code}`);
  }
  await fs.writeFile(path.join(root, 'dist', 'license-comparison', 'comparison.json'), JSON.stringify(report, null, 2));
  console.log('Both portable builds verified. Report: dist/license-comparison/comparison.json');
}
main().catch((error: unknown): void => { console.error(error); process.exitCode = 1; });
