import { app, safeStorage } from 'electron';
import * as fs from 'node:fs';
app.whenReady().then((): void => {
  const out: string[] = [];
  try {
    const c: Buffer = safeStorage.encryptString('hello');
    out.push('enc ok len=' + c.length);
    out.push('dec=' + safeStorage.decryptString(c).toString());
  } catch (e) { out.push('FAIL: ' + (e as Error).message); }
  fs.writeFileSync('C:/Users/hyunm/Sources/americano/artifacts/dpapi-check.txt', out.join('\n'));
  app.exit(0);
});
