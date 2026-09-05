const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { build, Platform, Arch } = require('electron-builder');
const asar = require('@electron/asar');
const { init, issue } = require('./license-issuer.cjs');
const { normalizeMac, deviceMacs, verifyLicense } = require('../src/license');
const root = path.join(__dirname, '..');
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--mac') throw new Error('Usage: npm run build:license-compare -- --mac XX:XX:XX:XX:XX:XX');
  const actual = normalizeMac(args[1]);
  const localMacs = deviceMacs();
  if (!localMacs.includes(actual)) throw new Error('선택한 MAC을 현재 PC에서 찾을 수 없습니다. 해당 어댑터를 연결하세요.');
  let fake = '02:00:00:00:00:01';
  while (localMacs.includes(fake)) fake = normalizeMac('02' + crypto.randomBytes(5).toString('hex'));
  const keys = await init();
  const issuedAt = new Date(); const expiresAt = new Date(issuedAt.getTime() + 30 * 86400000).toISOString();
  const staging = path.join(root, '.local', 'license-comparison'); await fs.mkdir(staging, { recursive: true });
  const report = { issuedAt: issuedAt.toISOString(), expiresAt, actualMac: actual, fictionalMac: fake, builds: [] };
  const base = require('../package.json').build;
  for (const [variant, mac, expected, artifactName] of [
    ['mac-match', actual, 'VALID', 'Americano-MyMAC.exe'],
    ['mac-mismatch', fake, 'DEVICE_MISMATCH', 'Americano-OtherMAC.exe'],
  ]) {
    const bytes = issue(keys.privateKey, { mac, issuedTo: `Local comparison (${variant})`, expiresAt, now: issuedAt });
    const bundled = path.join(staging, `${variant}.lic`); await fs.writeFile(bundled, bytes);
    const result = verifyLicense(bytes, keys.publicKey);
    if (result.code !== expected) throw new Error(`Preflight ${variant}: ${result.code}`);
    const output = path.join(root, 'dist', 'license-comparison', variant);
    await build({ projectDir: root, targets: Platform.WINDOWS.createTarget('portable', Arch.x64), config: {
      ...base, appId: `com.americano.automation.${variant}`, directories: { output },
      extraMetadata: { americanoVariant: variant }, portable: { ...base.portable, artifactName },
      extraResources: [...base.extraResources, { from: bundled, to: 'licensing/bundled.lic' }],
    } });
    const resources = path.join(output, 'win-unpacked', 'resources');
    const archive = path.join(resources, 'app.asar');
    const entries = asar.listPackage(archive).map((name) => name.replaceAll('\\', '/'));
    if (entries.some((name) => /(^|\/)(?:\.local|private\.pem|license-issuer\.cjs|config\.example\.json|config\.v2\.example\.json)(\/|$)/.test(name))) throw new Error('패키지에 배포 금지 파일이 포함되었습니다.');
    const code = asar.extractFile(archive, path.join('src', 'license.js'));
    if (!code.equals(await fs.readFile(path.join(root, 'src', 'license.js')))) throw new Error('검증기 코드가 빌드와 다릅니다.');
    const sandbox = { module: { exports: {} }, require, Buffer };
    vm.runInNewContext(code.toString(), sandbox, { filename: 'packaged-license.js' });
    const packaged = sandbox.module.exports.verifyLicense(await fs.readFile(path.join(resources, 'licensing', 'bundled.lic')), await fs.readFile(path.join(resources, 'licensing', 'public-key.pem')));
    if (packaged.code !== expected) throw new Error(`Packaged ${variant}: ${packaged.code}`);
    const executable = path.join(output, artifactName);
    report.builds.push({ variant, executable: path.relative(root, executable), expected, actual: packaged.code, sha256: crypto.createHash('sha256').update(await fs.readFile(executable)).digest('hex') });
    console.log(`${artifactName}: ${packaged.code}`);
  }
  await fs.writeFile(path.join(root, 'dist', 'license-comparison', 'comparison.json'), JSON.stringify(report, null, 2));
  console.log('Both portable builds verified. Report: dist/license-comparison/comparison.json');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
