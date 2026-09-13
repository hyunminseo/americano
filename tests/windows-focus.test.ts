import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureForeground, readGameGeometry } from '../src/windows.js';

test('foreground already acquired skips activation; delayed acquisition retries',async()=>{
 let attempts=0;let waits=0;
  const control={checkpoint:async()=>{},wait:async()=>{waits++;},time:()=>0};
 await ensureForeground(1,control,{isForeground:()=>true,activate:()=>attempts++});
 assert.equal(attempts,0);
 await ensureForeground(1,control,{isForeground:()=>attempts===2,activate:()=>attempts++});
 assert.equal(attempts,2);assert.equal(waits,21);
});
test('foreground failure is bounded and cancellation interrupts retries',async()=>{
 let attempts=0;
 const adapter={isForeground:()=>false,activate:()=>attempts++};
  await assert.rejects(ensureForeground(1,{checkpoint:async()=>{},wait:async()=>{},time:()=>0},adapter),/직접 클릭/);
 assert.equal(attempts,3);
  await assert.rejects(ensureForeground(1,{checkpoint:async()=>{throw Error('cancelled');},wait:async()=>{},time:()=>0},adapter),/cancelled/);
 assert.equal(attempts,3);
});
test('automatic resolution waits for stable geometry without activating the game',async()=>{
 let calls=0;
 const result=await readGameGeometry(1,{geometry:()=>({x:0,y:0,width:++calls===1?1920:1280,height:960,dpi:96})});
 assert.equal(result.width,1280);assert.equal(calls,3);
});
