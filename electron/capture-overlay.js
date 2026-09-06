let meta = { width: 1, height: 1 };
let start;
const surface = document.querySelector('#surface');
const selection = document.querySelector('#selection');
function point(event) { const bounds = surface.getBoundingClientRect(); return { x: Math.max(0, Math.min(meta.width, Math.round((event.clientX - bounds.left) / bounds.width * meta.width))), y: Math.max(0, Math.min(meta.height, Math.round((event.clientY - bounds.top) / bounds.height * meta.height))) }; }
function draw(end) { const x = Math.min(start.x, end.x); const y = Math.min(start.y, end.y); const width = Math.abs(end.x - start.x); const height = Math.abs(end.y - start.y); selection.style.display = 'block'; selection.style.left = `${x / meta.width * 100}%`; selection.style.top = `${y / meta.height * 100}%`; selection.style.width = `${width / meta.width * 100}%`; selection.style.height = `${height / meta.height * 100}%`; selection.dataset.region = JSON.stringify({ x, y, width, height }); const size = document.querySelector('#size'); size.textContent = `${width} × ${height}`; size.classList.toggle('too-small', width < 8 || height < 8); }
window.captureOverlay.onData((data) => { meta = data; document.querySelector('#toolbar strong').textContent = data.mode === 'region' ? '오버레이 영역 설정' : '기준 이미지 선택'; surface.style.backgroundImage = `url('${data.preview}')`; });
surface.onpointerdown = (event) => { if (event.target.closest('#toolbar')) return; start = point(event); surface.setPointerCapture(event.pointerId); draw(start); };
surface.onpointermove = (event) => { if (start) draw(point(event)); };
surface.onpointerup = () => { start = null; };
document.querySelector('#cancel').onclick = () => window.captureOverlay.cancel();
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') window.captureOverlay.cancel(); if (event.key === 'Enter' && selection.dataset.region) window.captureOverlay.select(JSON.parse(selection.dataset.region)); });
