const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { MacroStore } = require('../src/store');
const { newMacro, validateDocument } = require('../src/macros');
const { exportMacro, importMacro, decodePackage, rebindOverlay, assertRunnable } = require('../src/portable');
const { MacroRunner } = require('../src/runner');
const protector = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'americano-portable-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = new MacroStore(path.join(dir, 'source'), protector); await source.open();
  const destination = new MacroStore(path.join(dir, 'destination'), protector); await destination.open();
  const image = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#3167ab' } }).png().toBuffer();
  const file = await source.saveImage(image);
  const macro = { ...newMacro(), overlay: { x: 100, y: 200, width: 400, height: 300 }, target_window: { process_name: 'app.exe', executable_path: 'C:\\machine\\app.exe' },
    images: [{ id: 'image', name: '버튼', path: file, region: { x: 120, y: 230, width: 12, height: 8 } }],
    actions: [{ type: 'condition', test: { type: 'image_detect', image: file }, then: [{ type: 'repeat', count: 2, actions: [{ type: 'click', x: 140, y: 250 }] }], else: [{ type: 'retry', action: { type: 'image_wait', image: file } }] }] };
  return { dir, source, destination, macro, image };
}
test('portable roundtrip embeds nested image references, remaps IDs and encrypts on destination', async t => {
  const { source, destination, macro, image } = await fixture(t);
  const bytes = await exportMacro(macro, source);
  assert.equal(bytes.includes(Buffer.from(source.directory.replaceAll('\\', '\\\\'))), false);
  assert.equal(JSON.parse(bytes).macro.target_window.executable_path, undefined);
  const id = await importMacro(bytes, destination);
  const imported = destination.snapshot().macros[0];
  assert.equal(imported.id, id); assert.notEqual(id, macro.id);
  assert.equal(imported.overlay, null); assert.equal(imported.binding.needs_overlay, true);
  assert.throws(() => assertRunnable(imported), /재지정/);
  const file = imported.images[0].path;
  assert.notEqual(file, macro.images[0].path);
  assert.deepEqual(await destination.readImage(file), image);
  assert.equal(imported.actions[0].test.image, file);
  assert.equal(imported.actions[0].else[0].action.image, file);
  assert.deepEqual(imported.actions[0].then[0].actions[0], { type: 'click', timeout_ms: 10000, x: 40, y: 50, coordinate_space: 'overlay', button: 'left' });
  const rebound = rebindOverlay(imported, { x: 300, y: 400, width: 400, height: 300 });
  assert.doesNotThrow(() => assertRunnable(rebound));
  const inputs = [];
  const runner = new MacroRunner({ authorize: async () => {}, imageMatcher: async () => ({ x: 0, y: 0 }), input: { execute: async action => inputs.push(action), releaseAll: async () => {} } });
  runner.start(rebound); await runner.active.done;
  assert.equal(runner.state().outcome, 'completed');
  assert.deepEqual(inputs.map(a => [a.x, a.y]), [[340, 450], [340, 450]]);
});
test('changed dimensions and external client coordinates require explicit review', async t => {
  const { source, macro } = await fixture(t);
  macro.actions.push({ type: 'click', x: 20, y: 10 });
  const { macro: imported } = await decodePackage(await exportMacro(macro, source));
  const rebound = rebindOverlay(imported, { x: 0, y: 0, width: 800, height: 600 });
  assert.equal(rebound.binding.needs_review, true);
  assert.throws(() => assertRunnable(rebound), /검토/);
  assert.equal(rebound.actions[1].x, 20);
  rebound.binding.needs_review = false;
  assert.doesNotThrow(() => assertRunnable(rebound));
  rebound.overlay.width = 30;
  assert.throws(() => assertRunnable(rebound), /범위/);
});
test('malformed packages reject before writing and cannot reference external files', async t => {
  const { source, destination, macro } = await fixture(t);
  const raw = JSON.parse(await exportMacro(macro, source));
  const before = await fs.readdir(destination.directory);
  raw.macro.actions[0].test.image = 'C:\\outside.png';
  await assert.rejects(importMacro(Buffer.from(JSON.stringify(raw)), destination), /참조/);
  assert.deepEqual(await fs.readdir(destination.directory), before);
  raw.macro.actions[0].test.image = raw.assets[0].id;
  raw.assets.push(raw.assets[0]);
  await assert.rejects(decodePackage(Buffer.from(JSON.stringify(raw))), /중복/);
  raw.assets.pop(); raw.assets[0].data = Buffer.from('not an image').toString('base64');
  await assert.rejects(decodePackage(Buffer.from(JSON.stringify(raw))));
});
test('failed document commit rolls back newly encrypted images', async t => {
  const { source, destination, macro } = await fixture(t);
  const before = await fs.readdir(destination.directory);
  destination.save = async () => { throw new Error('disk full'); };
  await assert.rejects(importMacro(await exportMacro(macro, source), destination), /disk full/);
  assert.deepEqual(await fs.readdir(destination.directory), before);
});
test('legacy client coordinates remain unchanged in schema and execution', async () => {
  const raw = { ...newMacro(), actions: [{ type: 'click', x: 50, y: 60 }] };
  const macro = validateDocument({ version: 2, macros: [raw] }).macros[0];
  assert.equal(macro.actions[0].coordinate_space, undefined);
  const inputs = [];
  const runner = new MacroRunner({ authorize: async () => {}, input: { execute: async a => inputs.push(a), releaseAll: async () => {} } });
  runner.start(macro); await runner.active.done;
  assert.equal(inputs[0].x, 50); assert.equal(inputs[0].y, 60);
});
