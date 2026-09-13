// 실패 자산 덤프: 암호화 저장소에서 라이브 매크로와 .aimg를 복호화해 artifacts로 저장한다.
// 실행: electron scripts/dump-debug.cjs [aimg파일명]
import { app, safeStorage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MacroStore } from '../src/store.js';

const LOG: string = path.join(__dirname, '..', '..', 'artifacts', 'live-debug-log.txt');
function log(msg: string): void {
  try { fs.appendFileSync(LOG, msg + '\n'); } catch {}
}

type ActionRecord = Record<string, unknown> & { type: string };

interface ImageUse {
  step: string;
  type: string;
  image: string;
  alt?: string[];
  action: Record<string, unknown>;
}

interface MacroImage {
  path: string;
  name: string;
  region: unknown;
  learned_region: unknown;
  learned_roi: unknown;
}

interface MacroDoc {
  id: string;
  name: string;
  actions?: ActionRecord[];
  images: MacroImage[];
  overlay: unknown;
  binding: unknown;
}

interface StoreSnapshot {
  macros: MacroDoc[];
}

interface OpenableStore {
  open(): Promise<unknown>;
  snapshot(): StoreSnapshot;
  readImage(imagePath: string): Promise<Buffer>;
}

app.whenReady().then(async (): Promise<void> => {
  try { fs.writeFileSync(LOG, 'start\n'); } catch {}
  try {
    const variant: string | undefined = process.argv.slice(2).find((a: string): boolean => a.startsWith('variant='));
    const appDir: string = variant ? `Americano-${(variant.split('=')[1] as string)}` : 'Americano';
    app.setPath('userData', path.join(app.getPath('appData'), appDir));
    const dir: string = path.join(app.getPath('userData'), 'macros-v2');
    log('dir=' + dir);
    const store: OpenableStore = new MacroStore(dir, safeStorage);
    await store.open();
    log('store open ok');
    const wanted: string | undefined = process.argv.slice(2).find((a: string): boolean => a.endsWith('.aimg'));
    log('wanted=' + wanted);
    const outDir: string = path.join(__dirname, '..', '..', 'artifacts', 'live-debug');
    fs.mkdirSync(outDir, { recursive: true });
    const doc: StoreSnapshot = store.snapshot();
    log('macros=' + doc.macros.length);
    for (const macro of doc.macros) {
      const uses: ImageUse[] = [];
      const walk = (items: ActionRecord[] | undefined, pre: string[]): void => {
        (items || []).forEach((a: ActionRecord, i: number): void => {
          const s: string = [...pre, i].join('.');
          if (['image_detect', 'image_wait', 'image_click', 'smart_click'].includes(a.type)) {
            uses.push({ step: s, type: a.type, image: a.image as string, action: a });
          }
          if (a.type === 'repeat') walk(a.actions as ActionRecord[], [s]);
          if (a.type === 'condition') { walk([a.test] as ActionRecord[], [s, 't']); walk(a.then as ActionRecord[], [s, 'T']); walk(a.else as ActionRecord[], [s, 'F']); }
          if (a.type === 'retry') walk([a.action] as ActionRecord[], [s, 'r']);
        });
      };
      walk(macro.actions || [], []);
      const hit: ImageUse[] = wanted ? uses.filter((u: ImageUse): boolean => u.image === wanted || ((u.alt || []).includes(wanted))) : uses;
      if (wanted && !hit.length && !macro.images.some((a: MacroImage): boolean => a.path === wanted)) continue;
      log(`MACRO: ${macro.name} id=${macro.id}`);
      log(`overlay=${JSON.stringify(macro.overlay)} binding=${JSON.stringify(macro.binding)}`);
      for (const u of hit) {
        const full: Record<string, unknown> = u.action || {};
        log(`  step ${u.step} ${u.type} img=${path.basename(u.image)} th=${full.threshold as string} zone=${full.zone as string} timeout=${full.timeout_ms as string} roi=${JSON.stringify(full.roi || null)} feat=${full.features as string} pyr=${!!full.pyramid} alt=${JSON.stringify(full.alt_images || [])}`);
      }
      const slim: Record<string, unknown> = { ...macro, images: macro.images.map((a: MacroImage): Record<string, unknown> => ({ ...a, preview: '' })) };
      fs.writeFileSync(path.join(outDir, `macro-${macro.id}.json`), JSON.stringify(slim, null, 1));
      for (const asset of macro.images) {
        if (wanted && asset.path !== wanted) continue;
        try {
          const bytes: Buffer = await store.readImage(asset.path);
          fs.writeFileSync(path.join(outDir, `${path.basename(asset.path, '.aimg')}.png`), bytes);
          log(`  asset ${asset.name}: ${path.basename(asset.path)} region=${JSON.stringify(asset.region)} learned=${JSON.stringify(asset.learned_region)} roi=${JSON.stringify(asset.learned_roi || null)}`);
        } catch (e) { log(`  asset read failed: ${asset.path}: ${(e as Error).message}`); }
      }
    }
  } catch (e) { log('DUMP FAILED: ' + ((e as Error) && (e as Error).message)); process.exitCode = 1; }
  finally { app.exit(0); }
});
