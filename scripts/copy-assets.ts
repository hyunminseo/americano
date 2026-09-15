// tsc가 복사하지 않는 정적 파일(html/css/아이콘)을 compiled/electron으로 복사한다.
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '..', '..');
const out = path.join(root, 'compiled', 'electron');

function copyDir(relative: string): void {
  const from = path.join(root, relative);
  const to = path.join(root, 'compiled', relative);
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.js') || entry.name.endsWith('.cjs')) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(path.join(relative, entry.name));
    } else {
      fs.copyFileSync(source, target);
    }
  }
}

fs.mkdirSync(out, { recursive: true });
copyDir('electron');
copyDir(path.join('tests', 'test_images'));
if (fs.existsSync(path.join(root, 'artifacts'))) copyDir('artifacts');
// main 프로세스가 require('../package.json')로 변형을 읽으므로 함께 복사한다.
fs.copyFileSync(path.join(root, 'package.json'), path.join(root, 'compiled', 'package.json'));
// TS 7은 일반 스크립트에도 CJS 헤더를 붙인다. 브라우저가 고전 스크립트로
// 읽는 파일에서는 exports가 없어 터지므로 헤더를 벗겨낸다.
const BROWSER_SCRIPTS = ['renderer.js', 'simple.js', 'preload.js', 'overlay-preload.js', 'progress-preload.js', 'capture-overlay.js', 'progress.js'];
const header = '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\n';
for (const file of BROWSER_SCRIPTS) {
  const target = path.join(out, file);
  if (!fs.existsSync(target)) continue;
  const text = fs.readFileSync(target, 'utf8');
  if (text.startsWith(header)) fs.writeFileSync(target, text.slice(header.length));
}
console.log('assets copied to compiled/electron');
