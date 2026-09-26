const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const {validateDocument}=require('../src/macros');
async function studio(saved=null){
  const dom=new JSDOM(fs.readFileSync('electron/workflow.html','utf8'),{url:'https://americano.local',runScripts:'outside-only'});
  const w=dom.window;w.structuredClone=structuredClone;w.confirm=()=>true;
  if(saved)w.localStorage.setItem('americano-studio-demo',JSON.stringify(saved));
  w.eval(fs.readFileSync('src/workflow.js','utf8'));w.eval(fs.readFileSync('electron/workflow-renderer.js','utf8'));
  return {dom,w,$:s=>w.document.querySelector(s),click:s=>w.document.querySelector(s).click()};
}
test('studio adds, edits, deletes, undoes and persists actual graph nodes',async()=>{
  const {dom,w,$,click}=await studio();
  assert.equal(w.document.querySelectorAll('.node').length,5);
  click('[data-type="click"]');assert.equal(w.document.querySelectorAll('.node').length,6);
  $('#field-x').value='220';$('#field-x').dispatchEvent(new w.Event('change'));
  assert.match($('.node.selected .summary').textContent,/220, 300/);
  click('#delete-node');assert.equal(w.document.querySelectorAll('.node').length,5);
  click('#undo');assert.equal(w.document.querySelectorAll('.node').length,6);
  click('#redo');assert.equal(w.document.querySelectorAll('.node').length,5);
  click('#save');await new Promise(r=>setImmediate(r));
  const saved=JSON.parse(w.localStorage.getItem('americano-studio-demo'));
  assert.equal(validateDocument(saved).macros[0].workflow.nodes.length,5);
  click('#history-tab');assert.equal($('#history').hidden,false);
  dom.window.close();
  const restored=await studio(saved);assert.equal(restored.w.document.querySelectorAll('.node').length,5);restored.dom.window.close();
});
test('studio connections reject cycles and reconnect named branch outputs',async()=>{
 const {dom,w,$,click}=await studio();
 click('[data-output="click"]');click('[data-input="detect"]');
 assert.match($('#notice').textContent,/순환/);
 click('[data-output="detect"][data-port="false"]');click('[data-input="end"]');
 click('#save');await new Promise(r=>setImmediate(r));
 const saved=JSON.parse(w.localStorage.getItem('americano-studio-demo'));
 assert.equal(saved.macros[0].workflow.edges.find(e=>e.source==='detect'&&e.port==='false').target,'end');
 dom.window.close();
});
test('studio reference setting rescales coordinates and keeps asset capture resolution',async()=>{
 const {dom,w,$,click}=await studio();
 click('[data-type="click"]');click('#show-settings');
 $('#reference').value='1280';$('#reference').dispatchEvent(new w.Event('change'));
 click('#save');await new Promise(r=>setImmediate(r));
 const saved=JSON.parse(w.localStorage.getItem('americano-studio-demo'));
 const m=validateDocument(saved).macros[0];assert.equal(m.reference.width,1280);
 assert.equal(m.workflow.nodes.find(n=>n.action?.type==='click').action.x,640);
 dom.window.close();
});
