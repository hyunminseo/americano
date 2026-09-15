import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import { MacroStore } from '../src/store.js';
import { newMacro } from '../src/macros.js';

// Test-only protection seam; production receives Electron safeStorage.
const protector = { isEncryptionAvailable: () => true, encryptString: (text: any) => Buffer.from(text), decryptString: (bytes: any) => bytes.toString() };
async function setup(t: TestContext): Promise<any> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'americano-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new MacroStore(dir, protector); await store.open(); return { dir, store };
}
test('encrypts at rest with fresh nonce and restores across instances', async (t: TestContext) => {
  const { dir, store } = await setup(t); const a = newMacro(); a.name = 'secret-macro-name';
  await store.save({ version: 2, macros: [a] }); const first = await fs.readFile(store.file);
  assert.equal(first.includes(Buffer.from(a.name)), false);
  await store.save({ version: 2, macros: [a] }); const second = await fs.readFile(store.file);
  assert.notDeepEqual(first, second);
  const reopened = new MacroStore(dir, protector); assert.equal((await reopened.open()).macros[0].name, a.name);
});
test('serializes writes and rejects invalid data before replacing disk', async (t: TestContext) => {
  const { store } = await setup(t); const a = newMacro(); const b = { ...a, name: 'latest' };
  await Promise.all([store.save({ version: 2, macros: [a] }), store.save({ version: 2, macros: [b] })]);
  assert.equal(store.snapshot().macros[0].name, 'latest');
  const before = await fs.readFile(store.file);
  assert.throws(() => store.save({ version: 1 })); assert.deepEqual(await fs.readFile(store.file), before);
});
test('tamper detection preserves file and prevents saving over failed recovery', async (t: TestContext) => {
  const { dir, store } = await setup(t); await store.save({ version: 2, macros: [newMacro()] });
  const bytes = await fs.readFile(store.file); bytes[bytes.length - 1] ^= 1; await fs.writeFile(store.file, bytes);
  const reopened = new MacroStore(dir, protector); await assert.rejects(reopened.open(), /원본/);
  await assert.rejects(reopened.save({ version: 2, macros: [] }), /준비/);
  assert.deepEqual(await fs.readFile(store.file), bytes);
});
test('missing key and unavailable protection never downgrade to plaintext', async (t: TestContext) => {
  const { dir, store } = await setup(t); await store.save({ version: 2, macros: [] });
  await fs.unlink(store.keyFile);
  await assert.rejects(new MacroStore(dir, protector).open(), /키가 없습니다/);
  await assert.rejects(new MacroStore(dir, { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('nope'); }, decryptString: () => { throw new Error('nope'); } }).open(), /보호 저장소/);
});

test('captured images are encrypted, recover after restart, and reject tampering', async (t: TestContext) => {
  const {dir,store}=await setup(t); const image=Buffer.from('private captured image');
  const file=await store.saveImage(image);
  const bytes=await fs.readFile(file); assert.equal(bytes.includes(image),false);
  const restored=new MacroStore(dir,protector); await restored.open();
  assert.deepEqual(await restored.readImage(file),image);
  bytes[bytes.length-1]^=1; await fs.writeFile(file,bytes);
  await assert.rejects(restored.readImage(file));
  await assert.rejects(restored.readImage(path.join(dir,'..','outside.aimg')));
});
test('unused images are deleted only inside the store directory', async (t: TestContext) => {
  const {dir,store}=await setup(t); const image=Buffer.from('temporary image');
  const file=await store.saveImage(image);
  await assert.rejects(store.deleteImage(path.join(dir,'..','outside.aimg')), /허용되지 않은 이미지/);
  await store.deleteImage(file);
  await assert.rejects(fs.access(file));
  await store.deleteImage(file);
});

test('learned positions persist alongside originals and survive stale editor saves', async (t: TestContext) => {
  const {dir,store}=await setup(t);
  const macro=newMacro(); macro.images=[{id:'asset',name:'target',path:'target.png',preview:'',region:{x:10,y:20,width:8,height:8},learned_region:null,learned_roi:null,learned_scale_factor:null}];
  await store.save({version:2,macros:[macro]});
  const stale=store.snapshot();
  const position={x:200,y:150,width:8,height:8};
  await Promise.all([
    store.updateLearnedPosition(macro.id,'target.png',position,macro.target_window,macro.overlay),
    store.save(stale),
  ]);
  const reopened=new MacroStore(dir,protector);await reopened.open();
  assert.deepEqual(reopened.snapshot().macros[0].images[0].learned_region,position);
  assert.deepEqual(reopened.snapshot().macros[0].images[0].region,macro.images[0].region);
  const changed=store.snapshot();changed.macros[0].overlay={x:0,y:0,width:500,height:400};
  await store.save(changed);
  await store.updateLearnedPosition(macro.id,'target.png',position,macro.target_window,macro.overlay);
  assert.equal(store.snapshot().macros[0].images[0].learned_region,null);
});
test('run stats accumulate per step and survive reopening', async (t: TestContext) => {
  const {dir,store}=await setup(t);
  const macro=newMacro();
  await store.save({version:2,macros:[macro]});
  await store.updateRunStats(macro.id,[{key:'6',type:'retry',scans:12,ms:1300,ok:true},{key:'6.0.then.0',type:'image_click',scans:1,ms:80,ok:true},{key:'',type:'x',scans:1,ms:1,ok:true}]);
  await store.updateRunStats(macro.id,[{key:'6',type:'retry',scans:8,ms:900,ok:false}]);
  const saved=store.snapshot().macros[0].stats;
  assert.deepEqual(saved['6'],{runs:2,hits:1,misses:1,scans:20,ms:2200,type:'retry'});
  assert.deepEqual(saved['6.0.then.0'],{runs:1,hits:1,misses:0,scans:1,ms:80,type:'image_click'});
  assert.equal(saved[''],undefined);
  const reopened=new MacroStore(dir,protector);await reopened.open();
  assert.deepEqual(reopened.snapshot().macros[0].stats['6'].runs,2);
});
