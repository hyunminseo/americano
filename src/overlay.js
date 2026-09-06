const sharp = require('sharp');
const { screen, Region } = require('@nut-tree-fork/nut-js');
const { prepareWindow } = require('./windows');
function physicalRegion(client, area) {

  if (!area) return { x: client.x, y: client.y, width: client.width, height: client.height };
  const scale = client.dpi / 96;
  const result = { x: client.x + Math.round(area.x * scale), y: client.y + Math.round(area.y * scale), width: Math.round(area.width * scale), height: Math.round(area.height * scale) };
  if (result.width < 1 || result.height < 1 || result.x < client.x || result.y < client.y || result.x + result.width > client.x + client.width || result.y + result.height > client.y + client.height) throw new Error('오버레이 영역이 현재 대상 창을 벗어났습니다. 영역을 다시 설정하세요.');
  return result;
}
async function captureTarget(target, area, control) {
  const prepared = await prepareWindow(target, control);
  const region = physicalRegion(prepared.region, area);
  if (control) await control.checkpoint();
  const image = await (await screen.grabRegion(new Region(region.x, region.y, region.width, region.height))).toRGB();
  const buffer = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: image.channels } }).png().toBuffer();
  return { buffer, region, dpi: prepared.dpi };
}
// 대상 창 전체를 오버레이로 자동 설정한다. client는 네이티브 물리 픽셀이므로
// 96 DPI 논리 좌표로 환산한다. 수동 드래그 없이 시작할 때 사용한다.
function fullClientOverlay(client) {
  const dpi = client.dpi || 96;
  const width = Math.max(1, Math.round(client.width * 96 / dpi));
  const height = Math.max(1, Math.round(client.height * 96 / dpi));
  return { x: 0, y: 0, width, height };
}
module.exports = { captureTarget, physicalRegion, fullClientOverlay };
