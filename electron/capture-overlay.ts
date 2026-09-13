interface CaptureOverlayData {
  width: number;
  height: number;
  mode: string;
  preview: string;
}
interface WindowApi {
  captureOverlay: {
    onData: (callback: (data: CaptureOverlayData) => void) => void;
    select: (region: unknown) => void;
    cancel: () => void;
  };
}
const api = (window as unknown as WindowApi).captureOverlay;
let meta: { width: number; height: number } = { width: 1, height: 1 };
let start: { x: number; y: number } | null | undefined;
const surface = document.querySelector('#surface') as HTMLElement;
const selection = document.querySelector('#selection') as HTMLElement;
function point(event: PointerEvent): { x: number; y: number } { const bounds = surface.getBoundingClientRect(); return { x: Math.max(0, Math.min(meta.width, Math.round((event.clientX - bounds.left) / bounds.width * meta.width))), y: Math.max(0, Math.min(meta.height, Math.round((event.clientY - bounds.top) / bounds.height * meta.height))) }; }
function draw(end: { x: number; y: number }): void { const x = Math.min((start as { x: number; y: number }).x, end.x); const y = Math.min((start as { x: number; y: number }).y, end.y); const width = Math.abs(end.x - (start as { x: number; y: number }).x); const height = Math.abs(end.y - (start as { x: number; y: number }).y); selection.style.display = 'block'; selection.style.left = `${x / meta.width * 100}%`; selection.style.top = `${y / meta.height * 100}%`; selection.style.width = `${width / meta.width * 100}%`; selection.style.height = `${height / meta.height * 100}%`; selection.dataset.region = JSON.stringify({ x, y, width, height }); const size = document.querySelector('#size') as HTMLElement; size.textContent = `${width} × ${height}`; size.classList.toggle('too-small', width < 8 || height < 8); }
api.onData((data: CaptureOverlayData): void => { meta = data; (document.querySelector('#toolbar strong') as HTMLElement).textContent = data.mode === 'region' ? '오버레이 영역 설정' : '기준 이미지 선택'; surface.style.backgroundImage = `url('${data.preview}')`; });
surface.onpointerdown = (event: PointerEvent): void => { if ((event.target as Element).closest('#toolbar')) return; start = point(event); surface.setPointerCapture(event.pointerId); draw(start); };
surface.onpointermove = (event: PointerEvent): void => { if (start) draw(point(event)); };
surface.onpointerup = (): void => { start = null; };
(document.querySelector('#cancel') as HTMLElement).onclick = (): void => api.cancel();
window.addEventListener('keydown', (event: KeyboardEvent): void => { if (event.key === 'Escape') api.cancel(); if (event.key === 'Enter' && selection.dataset.region) api.select(JSON.parse(selection.dataset.region as string)); });
