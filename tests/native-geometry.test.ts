import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vm from 'node:vm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fullClientOverlay, physicalRegion } from '../src/overlay.js';

function geometryFixture(windowDpi: number, virtualScale: number, fail = false): any {
  const contexts: number[] = [];
  const functions: Record<string, any> = {
    SetThreadDpiAwarenessContext: (c: any)=>{contexts.push(c);return -2;},
    GetClientRect: (_h: any,r: any)=>{Object.assign(r,{right:1920,bottom:1440});return 1;},
    ClientToScreen: (_h: any,p: any)=>{Object.assign(p,{x:0,y:0});return 1;},
    PhysicalToLogicalPointForPerMonitorDPI: (_h: any,p: any)=>{p.x/=virtualScale;p.y/=virtualScale;return !fail;},
    GetDpiForWindow: ()=>windowDpi,
  };
  const koffi={struct:()=>{},proto:()=>{},load:()=>({func:(s: string)=>functions[s.match(/__stdcall (\w+)/)![1]] || (()=>{})})};
  const context: any={require:()=>koffi,module:{exports:{}},Buffer,process};
  context.exports = context.module.exports;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/native-windows.js'),'utf8'),context);
  return {native:context.module.exports, contexts};
}
test('DPI-unaware game at 150% resolves 1280x960 and round-trips physical capture',()=>{
  const {native,contexts}=geometryFixture(96,1.5);
  const client=native.geometry(1);
  assert.equal(client.dpi,144);
  const area=fullClientOverlay(client);
  assert.deepEqual(area,{x:0,y:0,width:1280,height:960});
  assert.deepEqual(physicalRegion(client,area),{x:0,y:0,width:1920,height:1440});
  assert.deepEqual(contexts,[-4,-2]);
});
test('DPI-aware game does not apply the virtualization scale twice',()=>{
  assert.equal(geometryFixture(144,1).native.geometry(1).dpi,144);
});
test('native DPI context is restored after a geometry error',()=>{
  const fixture=geometryFixture(96,1.5,true);
  assert.throws(()=>fixture.native.geometry(1),/배율/);
  assert.deepEqual(fixture.contexts,[-4,-2]);
});
