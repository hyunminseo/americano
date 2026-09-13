// opencode Windows 바이너리를 GitHub 릴리스에서 받아 vendor/에 둔다.
// 이미 있으면 버전만 확인하고 넘어간다. (빌드 전에 실행)
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const VERSION = 'v1.18.30';
const ASSET = 'opencode-windows-x64.zip';
const URL = `https://github.com/anomalyco/opencode/releases/download/${VERSION}/${ASSET}`;

async function main(): Promise<void> {
  const root = path.join(__dirname, '..', '..');
  const dir = path.join(root, 'vendor', 'opencode');
  const exe = path.join(dir, 'opencode.exe');
  if (fs.existsSync(exe)) {
    try {
      const { stdout } = await promisify(execFile)(exe, ['--version'], { timeout: 15000, windowsHide: true });
      console.log(`opencode 내장 바이너리 확인: ${String(stdout).trim()}`);
      return;
    } catch (error) {
      console.log(`기존 바이너리 실행 실패, 다시 받습니다: ${(error as Error).message}`);
    }
  }
  console.log(`opencode ${VERSION} 다운로드 중...`);
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, ASSET);
  const response = await fetch(URL, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`다운로드 실패: ${response.status}`);
  await fs.promises.writeFile(zip, Buffer.from(await response.arrayBuffer()));
  // 압축 해제는 PowerShell Expand-Archive로 처리한다 (추가 의존성 없음).
  const { stdout, stderr } = await promisify(execFile)('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`], { timeout: 120000, windowsHide: true });
  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.log(stderr.trim());
  await fs.promises.unlink(zip).catch(() => {});
  if (!fs.existsSync(exe)) throw new Error('압축 안에 opencode.exe가 없습니다.');
  const check = await promisify(execFile)(exe, ['--version'], { timeout: 15000, windowsHide: true });
  console.log(`opencode 내장 완료: ${String(check.stdout).trim()}`);
}

main().catch((error: unknown) => { console.error((error as Error).message); process.exitCode = 1; });
