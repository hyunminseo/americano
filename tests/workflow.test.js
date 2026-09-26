const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validate,runnable,fromActions}=require('../src/workflow');
const {validateDocument,newMacro}=require('../src/macros');
const {MacroRunner}=require('../src/runner');
const {transform}=require('../src/resolution');
function branch(){return {version:1,nodes:[{id:'s',kind:'start',name:'시작',x:0,y:0},{id:'c',kind:'condition',name:'조건',x:100,y:0,action:{type:'image_detect',image:'test.png'}},{id:'yes',kind:'action',name:'있음',x:200,y:0,action:{type:'key',keys:'enter'}},{id:'no',kind:'action',name:'없음',x:200,y:100,action:{type:'key',keys:'esc'}},{id:'e',kind:'end',name:'완료',x:400,y:0}],edges:[{source:'s',target:'c',port:'next'},{source:'c',target:'yes',port:'true'},{source:'c',target:'no',port:'false'},{source:'yes',target:'e',port:'next'},{source:'no',target:'e',port:'next'}]};}
test('graph validation rejects cycles, duplicate outputs, dangling edges and incomplete runs',()=>{
  const g=branch();assert.equal(runnable(g).nodes.length,5);
  assert.throws(()=>validate({...g,edges:[...g.edges,{source:'yes',target:'c'}]}));
  assert.throws(()=>validate({...g,edges:[...g.edges,{source:'s',target:'e'}]}));
  assert.throws(()=>validate({...g,edges:[{source:'s',target:'missing'}]}));
  assert.throws(()=>runnable({...g,edges:g.edges.slice(0,-1)}),/연결/);
  assert.equal(validate({...g,edges:[]}).edges.length,0);
});
test('legacy migration preserves nested actions and workflow edits survive normalization',()=>{
  const m=newMacro();m.workflow=fromActions([{type:'repeat',count:2,actions:[{type:'key',keys:'enter'}]}]);
  const result=validateDocument({version:2,macros:[m]}).macros[0];
  assert.equal(result.actions[0].actions[0].keys,'enter');
  assert.equal(result.actions[0],result.workflow.nodes[1].action);
});
for(const found of [true,false])test(`graph runner follows only ${found?'true':'false'} edge and publishes node trace`,async()=>{
  const seen=[];const r=new MacroRunner({authorize:async()=>{},input:{execute:async a=>seen.push(a.keys),releaseAll:async()=>{}},imageMatcher:async()=>found?{x:10,y:20,width:10,height:10,score:1}:null});
  r.start({...newMacro(),workflow:branch()});await r.active.done;
  assert.equal(r.state().outcome,'completed');assert.deepEqual(seen,[found?'enter':'esc']);assert.deepEqual(r.state().trace.map(t=>t.nodeId),['s','c',found?'yes':'no','e']);
});
test('preview skips all input and authorization; cancellation interrupts graph wait',async()=>{
  const r=new MacroRunner({authorize:async()=>{throw Error('must not authorize');},input:{execute:async()=>{throw Error('must not input');}}});
  r.start({...newMacro(),workflow:branch()},{preview:true});await r.active.done;assert.equal(r.state().outcome,'completed');
  r.start({...newMacro(),workflow:fromActions([{type:'wait',duration_ms:60000}])},{preview:true});await r.stop();assert.equal(r.state().outcome,'cancelled');
});
test('resolution coordinates round-trip at 1x, 1.6x, Retina and negative desktop origins',()=>{
  for(const [w,h] of [[800,600],[1280,960],[1600,1200]]){
    const t=transform({x:-1800,y:40,width:w,height:h},{width:800,height:600});
    assert.deepEqual(t.point(400,300),{x:-1800+w/2,y:40+h/2});
    assert.deepEqual(t.region({x:100,y:100,width:200,height:100}),{x:-1800+w/8,y:40+h/6,width:w/4,height:h/6});
  }
  assert.throws(()=>transform({width:1280,height:720},{width:800,height:600}),/4:3/);
  assert.throws(()=>transform({width:800,height:600},{width:800,height:600}).point(800,0),/벗어/);
});
test('content viewport is applied once and cannot escape the native window',()=>{
 const {contentRegion}=require('../src/windows');
 assert.deepEqual(contentRegion({x:100,y:200,width:800,height:628,dpi:96},{viewport:{x:0,y:28,width:800,height:600}}),{x:100,y:228,width:800,height:600,dpi:96});
 assert.throws(()=>contentRegion({x:0,y:0,width:800,height:600},{viewport:{x:0,y:28,width:800,height:600}}),/벗어/);
});
