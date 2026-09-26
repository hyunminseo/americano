'use strict';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => crypto.randomUUID();
const clone = value => structuredClone(value);
const library = [
  ['인식 & 분기','image_click','◎','이미지 찾아 클릭','인식한 대상의 중앙 클릭'],
  ['인식 & 분기','image_wait','⌕','이미지 기다리기','화면이 나타날 때까지 대기'],
  ['인식 & 분기','condition','⑂','이미지 조건 분기','있음 / 없음 경로 연결'],
  ['입력','click','↖','좌표 클릭','기준 해상도의 좌표 클릭'],
  ['입력','key','⌨','키보드 입력','단축키 또는 키 조합'],
  ['입력','text','T','텍스트 입력','문자열을 순서대로 입력'],
  ['입력','scroll','↕','스크롤','가로 / 세로 스크롤'],
  ['흐름','wait','◷','대기','지정한 시간만큼 대기'],
  ['흐름','end','✓','완료','이 경로의 실행 종료'],
];
let backend = null, doc = {version:2,macros:[]}, selectedId = '', selectedNode = null, dirty = false;
let history = [], redo = [], connection = null, pan = {x:45,y:40}, zoom = 1, windows = [];
let run = {status:'STOPPED'}, events = [], captureNode = null;
const api = window.americano;
function macro() { return doc.macros.find(m => m.id === selectedId); }
function graph() { return macro()?.workflow; }
function newMacro() {
  return {id:uid(),name:'새 워크플로우',enabled:true,hotkey:'',target_window:{},reference:{width:800,height:600},overlay:{x:0,y:0,width:800,height:600},images:[],actions:[],loop:{count:1,interval_ms:500},workflow:Workflow.fromActions([])};
}
function seed() {
  const m = newMacro(); m.name = '화면 인식 워크플로우';
  m.workflow = {version:1,nodes:[
    {id:'start',kind:'start',name:'시작',x:60,y:190},
    {id:'detect',kind:'condition',name:'이미지 확인',x:330,y:190,action:defaults('image_detect')},
    {id:'click',kind:'action',name:'이미지 찾아 클릭',x:610,y:100,action:defaults('image_click')},
    {id:'wait',kind:'action',name:'잠시 기다리기',x:610,y:320,action:defaults('wait')},
    {id:'end',kind:'end',name:'완료',x:890,y:200}],edges:[
    {source:'start',target:'detect',port:'next'},{source:'detect',target:'click',port:'true'},
    {source:'detect',target:'wait',port:'false'},{source:'click',target:'end',port:'next'},{source:'wait',target:'end',port:'next'}]};
  return m;
}
function defaults(type) {
  const reference = macro()?.reference || {width:800,height:600};
  const base = {type,timeout_ms:10000};
  if (type.startsWith('image_')) return {...base,image:'',threshold:.9,region:{x:0,y:0,...reference},poll_interval_ms:200};
  if(type==='wait') return {...base,duration_ms:500};
  if(type==='click') return {...base,x:400,y:300,button:'left'};
  if(type==='key') return {...base,keys:'enter'};
  if(type==='text') return {...base,text:''};
  if(type==='scroll') return {...base,delta_x:0,delta_y:-3};
  return base;
}
function mark() {dirty=true;$('#saved').textContent='저장하지 않음';}
function remember() {history.push(JSON.stringify(doc));if(history.length>60)history.shift();redo=[];mark();}
function restore(from,to) {if(!from.length||running())return;to.push(JSON.stringify(doc));doc=JSON.parse(from.pop());selectedId=macro()?.id||doc.macros[0]?.id;selectedNode=null;mark();render();}
function running(){return ['RUNNING','PAUSED'].includes(run.status);}
function message(text) {$('#notice').textContent=text||'';}
async function request(command,payload={}) {
  if(!api) throw new Error('화면 미리보기입니다. 실제 실행과 캡처는 Electron 앱에서 사용할 수 있습니다.');
  const result=await api.request(command,payload);
  if(!result.ok)throw new Error(result.error);
  if(result.state) receive(result.state);
  return result;
}
function safe(fn) {return async (...args)=>{try{await fn(...args);}catch(e){message(e.message);}};}
async function save() {
  if(running())throw new Error('실행을 중지한 뒤 저장하세요.');
  for(const m of doc.macros){Workflow.validate(m.workflow);m.actions=m.workflow.nodes.filter(n=>n.action).map(n=>n.action);}
  if(!api){localStorage.setItem('americano-studio-demo',JSON.stringify(doc));dirty=false;$('#saved').textContent='미리보기 저장됨';return;}
  const result=await request('save',{document:doc});
  doc=clone(result.state.document);dirty=false;$('#saved').textContent='저장됨';message('');
}
function receive(state) {
  backend=state;run=state.run||run;
  if(!doc.macros.length && state.document?.macros.length){doc=clone(state.document);for(const m of doc.macros)if(!m.workflow)m.workflow=Workflow.fromActions(m.actions);selectedId=doc.macros[0].id;render();fit();}
  const latest=run.trace||[];
  if(latest.length){events=latest;$('#log-count').textContent=events.length;renderEvents();}
  $('#status').textContent = run.error || ({RUNNING:'실행 중',PAUSED:'일시정지',STOPPED:run.outcome==='completed'?'실행 완료':'준비됨',ERROR:'실행 오류'}[run.status]||run.status);
  if(run.error)message(run.error);else if(state.error)message(state.error);
  document.querySelectorAll('.node').forEach(el=>el.classList.toggle('running',running() && run.macroId===selectedId && el.dataset.id===run.nodeId));
  $('#pause').textContent=run.status==='PAUSED'?'▶ 재개 F8':'Ⅱ F8';
  $('#pause').disabled=!running();$('#stop').disabled=!running();
  for(const id of ['run','preview','save','new','rename','import','export','undo','redo'])$('#'+id).disabled=running();
  $('#run').disabled=running()||!state.executionAvailable||!state.license?.valid;
  $('#workflows').disabled=running();
  $('.library').inert=running();$('.inspector').inert=running();
}
function renderEvents() {$('#events').innerHTML=events.map((e,i)=>`<div class="event"><time>${String(i+1).padStart(2,'0')}</time><b>✓</b><span>${esc(e.name)}</span><time>${e.time} ms</time></div>`).join('');}
function icon(node){return node.kind==='start'?'ϟ':node.kind==='end'?'✓':library.find(v=>v[1]===(node.kind==='condition'?'condition':node.action?.type))?.[2]||'◇';}
function summary(node){const a=node.action;if(!a)return node.kind==='start'?'수동 실행 · F7':'워크플로우 종료';if(node.kind==='condition')return a.image?'이미지 있음 / 없음':'기준 이미지를 선택하세요';if(a.type.startsWith('image_'))return a.image?`일치도 ${Math.round(a.threshold*100)}% 이상`:'기준 이미지를 선택하세요';return a.type==='wait'?`${a.duration_ms} ms`:a.type==='key'?a.keys:a.type==='text'?a.text:a.type==='click'?`${a.x}, ${a.y}`:a.type;}
function renderPalette() {
  const q=$('#search').value.toLowerCase();let group='';
  $('#palette').innerHTML=library.filter(v=>v.join(' ').toLowerCase().includes(q)).map(v=>{const heading=group===v[0]?'':`<div class="group-label">${v[0]}</div>`;group=v[0];return heading+`<button class="palette-item" data-type="${v[1]}"><span class="glyph">${v[2]}</span><span>${v[3]}<small>${v[4]}</small></span></button>`;}).join('');
  document.querySelectorAll('.palette-item').forEach(b=>b.onclick=()=>addNode(b.dataset.type));
}
function addNode(type){if(running())return;remember();const item=library.find(v=>v[1]===type),parent=graph().nodes.find(n=>n.id===selectedNode);const n={id:uid(),kind:type==='condition'?'condition':type==='end'?'end':'action',name:item[3],x:parent?parent.x+270:Math.max(30,(120-pan.x)/zoom),y:parent?parent.y+160:Math.max(30,(120-pan.y)/zoom)};if(n.kind!=='end')n.action=defaults(type==='condition'?'image_detect':type);graph().nodes.push(n);selectedNode=n.id;render();}
function render(){if(!macro())return;$('#workflows').innerHTML=doc.macros.map(m=>`<option value="${esc(m.id)}" ${m.id===selectedId?'selected':''}>${esc(m.name)}</option>`).join('');renderPalette();renderCanvas();renderInspector();if(backend)receive(backend);}
function renderCanvas(){
  if(!graph())return;
  $('#nodes').innerHTML=graph().nodes.map(n=>`<article class="node ${n.kind} ${n.id===selectedNode?'selected':''}" style="left:${n.x}px;top:${n.y}px" data-id="${n.id}" tabindex="0" aria-label="${esc(n.name)}"><div class="node-top"><span class="glyph">${icon(n)}</span><div><strong>${esc(n.name)}</strong><small>${n.kind==='condition'?'CONDITION':n.kind==='start'?'TRIGGER':n.kind==='end'?'OUTPUT':'ACTION'}</small></div></div><div class="summary">${esc(summary(n))}</div>${n.kind==='start'?'':`<button class="port input" data-input="${n.id}" title="${esc(n.name)} 입력"></button>`}${n.kind==='end'?'':n.kind==='condition'?`<button class="port output" data-output="${n.id}" data-port="true" title="이미지 있음"></button><span class="port-label">있음</span><button class="port output false" data-output="${n.id}" data-port="false" title="이미지 없음"></button><span class="port-label false">없음</span>`:`<button class="port output" data-output="${n.id}" data-port="next" title="다음 노드 연결"></button>`}</article>`).join('');
  renderEdges();applyView();
  document.querySelectorAll('.node').forEach(el=>{el.onpointerdown=e=>dragNode(e,el);el.onkeydown=e=>{if(e.key==='Enter'){selectedNode=el.dataset.id;render();}if(e.key==='Delete')deleteNode(el.dataset.id);};});
  document.querySelectorAll('[data-output]').forEach(el=>el.onclick=e=>{e.stopPropagation();if(running())return;connection={source:el.dataset.output,port:el.dataset.port};document.querySelectorAll('.port').forEach(p=>p.classList.remove('pending'));el.classList.add('pending');$('#hint').textContent='연결할 노드의 왼쪽 입력 ●을 선택하세요. Esc 취소';});
  document.querySelectorAll('[data-input]').forEach(el=>el.onclick=e=>{e.stopPropagation();if(!connection||running())return;const next=clone(graph());next.edges=next.edges.filter(edge=>!(edge.source===connection.source&&edge.port===connection.port));next.edges.push({...connection,target:el.dataset.input});try{Workflow.validate(next);remember();macro().workflow=next;connection=null;$('#hint').textContent='출력 ● → 입력 ● 연결 · 연결선을 클릭하면 삭제';renderCanvas();}catch(error){message(error.message);}});
}
function renderEdges(){
  $('#edges').innerHTML=`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a8bcb0"/></marker></defs>`+graph().edges.map((e,i)=>{const a=graph().nodes.find(n=>n.id===e.source),b=graph().nodes.find(n=>n.id===e.target);if(!a||!b)return '';const x=a.x+197,y=a.y+(e.port==='false'?82:48),xx=b.x-8,yy=b.y+48,d=Math.max(65,Math.abs(xx-x)/2);return `<path class="edge" data-edge="${i}" d="M${x},${y} C${x+d},${y} ${xx-d},${yy} ${xx},${yy}" marker-end="url(#arrow)"/>`;}).join('');
  document.querySelectorAll('[data-edge]').forEach(el=>el.onclick=()=>{if(running())return;remember();graph().edges.splice(Number(el.dataset.edge),1);renderEdges();});
}
function applyView(){$('#world').style.transform=`translate(${pan.x}px,${pan.y}px) scale(${zoom})`;$('#zoom').textContent=`${Math.round(zoom*100)}%`;}
function fit(){if(!graph())return;const ns=graph().nodes,minX=Math.min(...ns.map(n=>n.x)),minY=Math.min(...ns.map(n=>n.y));const w=Math.max(...ns.map(n=>n.x+210))-minX,h=Math.max(...ns.map(n=>n.y+140))-minY;zoom=Math.min(1,Math.max(.25,Math.min(($('#canvas').clientWidth-80)/w,($('#canvas').clientHeight-100)/h)));pan={x:($('#canvas').clientWidth-w*zoom)/2-minX*zoom,y:($('#canvas').clientHeight-h*zoom)/2-minY*zoom};applyView();}
function dragNode(e,el){if(e.target.closest('button')||e.button!==0||running())return;e.stopPropagation();selectedNode=el.dataset.id;renderInspector();document.querySelectorAll('.node').forEach(n=>n.classList.toggle('selected',n===el));const node=graph().nodes.find(n=>n.id===selectedNode),start={x:e.clientX,y:e.clientY,nx:node.x,ny:node.y};let moved=false;el.setPointerCapture(e.pointerId);el.onpointermove=ev=>{if(!moved&&Math.abs(ev.clientX-start.x)+Math.abs(ev.clientY-start.y)>3){remember();moved=true;}if(!moved)return;node.x=Math.max(0,Math.round(start.nx+(ev.clientX-start.x)/zoom));node.y=Math.max(0,Math.round(start.ny+(ev.clientY-start.y)/zoom));el.style.left=node.x+'px';el.style.top=node.y+'px';renderEdges();};el.onpointerup=()=>{el.onpointermove=null;el.onpointerup=null;};}
function field(label,key,value,type='text',extra=''){return `<label for="field-${key}">${label}</label><input id="field-${key}" data-field="${key}" type="${type}" value="${esc(value)}" ${extra}>`;}
function renderInspector(){
  const m=macro();if(!m)return;const n=graph().nodes.find(n=>n.id===selectedNode);$('#inspector-title').textContent=n?'노드 설정':'워크플로우 설정';
  if(!n){
    $('#inspector').innerHTML=`<span class="badge">RESOLUTION AWARE</span><label>기준 해상도</label><select id="reference"><option value="800" ${m.reference?.width===800?'selected':''}>800 × 600</option><option value="1280" ${m.reference?.width===1280?'selected':''}>1280 × 960</option><option value="legacy" ${!m.reference?'selected':''}>기존 DPI 좌표</option></select><p>이미지와 좌표를 작성한 해상도입니다. 변경 시 좌표와 이미지 크기도 함께 변환됩니다.</p><label>실행할 대상 창</label><select id="target"><option value="">${esc(m.target_window.title_contains||'창을 선택하세요')}</option>${windows.map((w,i)=>`<option value="${i}">${esc(w.title)}</option>`).join('')}</select><button class="wide" id="refresh-windows">↻ 실행 중인 창 새로고침</button><p>macOS: 시스템 설정에서 화면 기록과 손쉬운 사용 권한을 허용하세요. 제목 표시줄을 제외할 때 콘텐츠 영역을 입력하세요.</p><details><summary>콘텐츠 영역 (창 내부 좌표)</summary><p>비워 두면 창 전체를 사용합니다. macOS 창 테두리가 포함되면 게임 영역의 x, y, 너비, 높이를 지정하세요.</p>${['x','y','width','height'].map(k=>field(k,'viewport_'+k,m.target_window.viewport?.[k]??'','number','min="0"')).join('')}<button id="viewport-apply">영역 적용</button><button id="viewport-clear">전체 창</button></details>${field('워크플로우 반복 횟수','loop',m.loop?.count||1,'number','min="1" max="10000"')}${field('반복 사이 대기 (ms)','interval',m.loop?.interval_ms||500,'number','min="30"')}${m.binding?.needs_review?'<p>가져온 좌표와 이미지를 검토한 후 실행을 허용하세요.</p><button id="review-complete">좌표·이미지 검토 완료</button>':''}<button class="wide" id="capture-library">▣ 화면에서 이미지 캡처</button><p>노드 출력과 다음 노드 입력을 연결하세요. 배경을 클릭하면 이 설정으로 돌아옵니다.</p><button id="delete-workflow" class="danger wide">워크플로우 삭제</button>`;
    $('#reference').onchange=safe(async e=>{const width=Number(e.target.value);if(!width){remember();m.reference=null;return;}if(m.reference?.width===width)return;const old=m.reference?.width||width,ratio=width/old;remember();m.reference={width,height:width*3/4};m.overlay={x:0,y:0,...m.reference};const scale=a=>{if(['click','mouse_move'].includes(a.type)){a.x=Math.round(a.x*ratio);a.y=Math.round(a.y*ratio);}if(a.type.startsWith('image_')||a.type==='smart_click')a.region={...m.overlay};if(a.test)scale(a.test);if(a.action)scale(a.action);for(const list of [a.actions,a.then,a.else])list?.forEach(scale);};graph().nodes.filter(n=>n.action).forEach(n=>scale(n.action));for(const asset of m.images){asset.reference_width=asset.reference_width||old;}renderInspector();message('기준 해상도를 변경했습니다. 이미지의 원래 해상도는 보존됩니다.');});
    $('#target').onchange=e=>{if(e.target.value==='')return;remember();const w=windows[Number(e.target.value)];m.target_window={title_contains:w.title,...(w.process_name?{process_name:w.process_name}:{})};if(!m.overlay)m.overlay=m.reference?{x:0,y:0,...m.reference}:m.binding?.source_overlay||null;if(m.binding)m.binding.needs_overlay=!m.overlay;renderInspector();};
    $('#refresh-windows').onclick=safe(async()=>{windows=(await request('window-list')).windows;renderInspector();});
    $('#field-loop').onchange=e=>{remember();m.loop={...m.loop,count:Number(e.target.value)};};$('#field-interval').onchange=e=>{remember();m.loop={...m.loop,interval_ms:Number(e.target.value)};};
    $('#viewport-apply').onclick=()=>{const v=Object.fromEntries(['x','y','width','height'].map(k=>[k,Number($('#field-viewport_'+k).value)]));if(![v.x,v.y].every(x=>Number.isInteger(x)&&x>=0)||![v.width,v.height].every(x=>Number.isInteger(x)&&x>0))return message('콘텐츠 영역에 올바른 좌표와 크기를 입력하세요.');remember();m.target_window.viewport=v;message('콘텐츠 영역을 적용했습니다.');};$('#viewport-clear').onclick=()=>{remember();delete m.target_window.viewport;renderInspector();};
    $('#capture-library').onclick=safe(()=>capture(null));
    if($('#review-complete'))$('#review-complete').onclick=()=>{remember();m.binding.needs_review=false;renderInspector();};
    $('#delete-workflow').onclick=()=>{if(!confirm('이 워크플로우를 삭제할까요? 저장 전에는 실행 취소할 수 있습니다.'))return;remember();doc.macros=doc.macros.filter(v=>v.id!==m.id);if(!doc.macros.length)doc.macros.push(newMacro());selectedId=doc.macros[0].id;selectedNode=null;render();};return;
  }
  const a=n.action;
  let html=`<span class="badge">${n.kind.toUpperCase()}</span>${field('노드 이름','name',n.name)}`;
  if(a){
    if(a.type.startsWith('image_')||a.type==='smart_click')html+=`<label>기준 이미지</label><select id="asset"><option value="">선택하세요</option>${m.images.map(im=>`<option value="${esc(im.path)}" ${im.path===a.image?'selected':''}>${esc(im.name)}</option>`).join('')}</select><label>이미지를 캡처한 해상도</label><select id="asset-resolution">${[800,1280].map(w=>`<option value="${w}" ${(m.images.find(im=>im.path===a.image)?.reference_width||m.reference?.width||800)===w?'selected':''}>${w} × ${w*3/4}</option>`).join('')}</select><button id="pick-image">파일 선택</button> <button id="capture-image">화면 캡처</button>${m.images.find(im=>im.path===a.image)?.preview?`<img class="asset" src="${esc(m.images.find(im=>im.path===a.image).preview)}" alt="기준 이미지">`:''}${field('최소 일치도 (0~1)','threshold',a.threshold,'number','min="0" max="1" step="0.01"')}${field('검색 제한 시간 (ms)','timeout_ms',a.timeout_ms||10000,'number','min="1"')}${field('검색 간격 (ms)','poll_interval_ms',a.poll_interval_ms||200,'number','min="30"')}<p>현재 화면을 기준 해상도로 정규화한 뒤 검색합니다. 조건 분기는 있음 / 없음 두 출력을 연결하세요.</p>`;
    else if(a.type==='wait')html+=field('대기 시간 (ms)','duration_ms',a.duration_ms,'number','min="0"');
    else if(a.type==='key')html+=field('키 조합','keys',a.keys)+`<p>예: enter, ctrl+a, shift+f1<br>macOS Command 키는 win으로 입력합니다.</p>`;
    else if(a.type==='text')html+=`<label>입력할 텍스트</label><textarea data-field="text">${esc(a.text)}</textarea>`;
    else if(['click','mouse_move'].includes(a.type))html+=`<div class="pair"><div>${field('X 좌표','x',a.x,'number','min="0"')}</div><div>${field('Y 좌표','y',a.y,'number','min="0"')}</div></div><p>기준 해상도 안의 콘텐츠 좌표입니다.</p><label>마우스 버튼</label><select id="mouse-button">${['left','right','middle'].map(v=>`<option ${a.button===v?'selected':''}>${v}</option>`).join('')}</select>`;
    else if(a.type==='scroll')html+=field('세로 스크롤','delta_y',a.delta_y,'number')+field('가로 스크롤','delta_x',a.delta_x,'number');
    else html+=`<p>기존 복합 액션을 보존했습니다. 아래 JSON에서 내부 조건과 반복을 수정할 수 있습니다.</p><textarea id="legacy-action">${esc(JSON.stringify(a,null,2))}</textarea><button id="apply-action">액션 적용</button>`;
  }else html+=`<p>${n.kind==='start'?'이 노드부터 연결된 순서로 실행합니다.':'이 경로의 실행이 완료됩니다.'}</p>`;
  if(n.kind!=='start')html+='<button id="delete-node" class="danger wide">노드 삭제</button>';
  html+='<button id="show-settings" class="wide">워크플로우 설정</button>';
  $('#inspector').innerHTML=html;
  document.querySelectorAll('[data-field]').forEach(el=>el.onchange=()=>{remember();const key=el.dataset.field;if(key==='name')n.name=el.value;else a[key]=el.type==='number'?Number(el.value):el.value;renderCanvas();});
  if($('#asset'))$('#asset').onchange=e=>{remember();a.image=e.target.value;renderCanvas();renderInspector();};
  if($('#asset-resolution'))$('#asset-resolution').onchange=e=>{const asset=m.images.find(im=>im.path===a.image);if(asset){remember();asset.reference_width=Number(e.target.value);}};
  if($('#pick-image'))$('#pick-image').onclick=safe(async()=>{const result=await request('image-select');if(!result.path)return;remember();a.image=result.path;if(!m.images.some(im=>im.path===result.path))m.images.push({id:uid(),name:result.path.split(/[\\/]/).pop(),path:result.path,preview:'',region:{x:0,y:0,width:1,height:1},reference_width:m.reference?.width||800});render();});
  if($('#capture-image'))$('#capture-image').onclick=safe(()=>capture(n.id));
  if($('#mouse-button'))$('#mouse-button').onchange=e=>{remember();a.button=e.target.value;};
  if($('#apply-action'))$('#apply-action').onclick=safe(()=>{const value=JSON.parse($('#legacy-action').value);remember();n.action=value;render();});
  if($('#delete-node'))$('#delete-node').onclick=()=>deleteNode(n.id);
  $('#show-settings').onclick=()=>{selectedNode=null;render();};
}
function deleteNode(id){if(running()||graph().nodes.find(n=>n.id===id)?.kind==='start')return;remember();graph().nodes=graph().nodes.filter(n=>n.id!==id);graph().edges=graph().edges.filter(e=>e.source!==id&&e.target!==id);selectedNode=null;render();}
async function capture(nodeId){captureNode=nodeId;await request('capture-overlay-open',{mode:'image',macro:macro()});}
async function execute(preview){Workflow.runnable(graph());if(!preview){if(!Object.values(macro().target_window).some(Boolean))throw new Error('워크플로우 설정에서 대상 창을 선택하세요.');for(const n of graph().nodes)if(n.action?.type.startsWith('image_')&&!n.action.image)throw new Error(`“${n.name}” 노드의 기준 이미지를 선택하세요.`);}await save();message(preview?'흐름 미리보기: 실제 입력 없이 실행합니다. 이미지 분기는 없음 경로를 사용합니다.':'');await request(preview?'preview':'start',{macroId:selectedId});}
$('#save').onclick=safe(save);$('#run').onclick=safe(()=>execute(false));$('#preview').onclick=safe(()=>execute(true));$('#pause').onclick=safe(()=>request('pause'));$('#stop').onclick=safe(()=>request('stop'));
$('#search').oninput=renderPalette;$('#fit').onclick=fit;$('#zoom-in').onclick=()=>{zoom=Math.min(2,zoom+.1);applyView();};$('#zoom-out').onclick=()=>{zoom=Math.max(.25,zoom-.1);applyView();};$('#undo').onclick=()=>restore(history,redo);$('#redo').onclick=()=>restore(redo,history);
$('#new').onclick=()=>{remember();const m=newMacro();doc.macros.push(m);selectedId=m.id;selectedNode=null;render();fit();};
$('#rename').onclick=()=>{$('#name-input').value=macro().name;$('#name-dialog').showModal();};$('#name-dialog').onclose=()=>{if($('#name-dialog').returnValue==='ok'&&$('#name-input').value.trim()){remember();macro().name=$('#name-input').value.trim();render();}};
$('#workflows').onchange=e=>{selectedId=e.target.value;selectedNode=null;connection=null;render();fit();};
$('#import').onclick=safe(async()=>{if(dirty)await save();const result=await request('macro-import');if(!result.canceled){doc=clone(result.state.document);for(const m of doc.macros)if(!m.workflow)m.workflow=Workflow.fromActions(m.actions);selectedId=result.macroId;selectedNode=null;mark();render();fit();message('가져온 워크플로우의 대상 창과 콘텐츠 영역을 설정하세요.');}});
$('#export').onclick=safe(async()=>{await save();await request('macro-export',{macroId:selectedId});});
$('#license').onclick=()=>{$('#license-info').textContent=backend?.license?.message||'Electron 앱에서 라이선스를 확인할 수 있습니다.';$('#license-dialog').showModal();};$('#license-close').onclick=()=>$('#license-dialog').close();$('#license-import').onclick=safe(async()=>{await request('license-import');$('#license-info').textContent=backend.license.message;});
$('#history-tab').onclick=()=>{$('#history').hidden=false;$('#history-tab').classList.add('active');$('#editor-tab').classList.remove('active');};$('#editor-tab').onclick=()=>{$('#history').hidden=true;$('#editor-tab').classList.add('active');$('#history-tab').classList.remove('active');};
$('#canvas').onpointerdown=e=>{if(e.target.closest('.node')||e.target.classList.contains('edge')||e.button!==0)return;selectedNode=null;connection=null;renderInspector();document.querySelectorAll('.node').forEach(n=>n.classList.remove('selected'));const start={x:e.clientX,y:e.clientY,px:pan.x,py:pan.y};$('#canvas').setPointerCapture(e.pointerId);$('#canvas').onpointermove=ev=>{pan={x:start.px+ev.clientX-start.x,y:start.py+ev.clientY-start.y};applyView();};$('#canvas').onpointerup=()=>{$('#canvas').onpointermove=null;};};
$('#canvas').onwheel=e=>{e.preventDefault();const rect=$('#canvas').getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top,old=zoom;zoom=Math.max(.25,Math.min(2,zoom*(e.deltaY<0?1.1:.9)));pan={x:x-(x-pan.x)*zoom/old,y:y-(y-pan.y)*zoom/old};applyView();};
window.addEventListener('keydown',e=>{if(e.key==='Escape'){connection=null;$('#hint').textContent='출력 ● → 입력 ● 연결 · 배경 드래그로 이동';}if(['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName))return;if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();safe(save)();}if((e.ctrlKey||e.metaKey)&&e.key==='z'){e.preventDefault();restore(e.shiftKey?redo:history,e.shiftKey?history:redo);}if(e.key==='Delete'&&selectedNode)deleteNode(selectedNode);});
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
if(api){api.onState(receive);api.onStartHotkey(safe(()=>execute(false)));api.onCaptureResult?.(result=>{if(!result.ok)return message(result.error);const m=doc.macros.find(v=>v.id===result.macroId);if(!m)return;remember();const asset={id:uid(),name:`캡처 이미지 ${m.images.length+1}`,path:result.path,preview:result.preview,region:result.region,reference_width:m.reference?.width||800};m.images.push(asset);const n=m.workflow.nodes.find(n=>n.id===captureNode);if(n?.action)n.action.image=asset.path;render();});safe(async()=>{const result=await request('state');if(!doc.macros.length){const m=seed();doc.macros=[m];selectedId=m.id;mark();render();fit();}if(result.state.error)message(result.state.error);})();}
else{try{doc=JSON.parse(localStorage.getItem('americano-studio-demo'))||doc;}catch{}if(!doc.macros.length)doc.macros=[seed()];selectedId=doc.macros[0].id;render();fit();message('디자인 미리보기 · 실행과 화면 캡처는 Electron 앱에서 사용할 수 있습니다.');$('#status').textContent='브라우저 미리보기';$('#run').disabled=true;$('#pause').disabled=true;$('#stop').disabled=true;}
