// Reference pixels are independent of OS DPI. Client geometry and input share
// the platform's native coordinate unit (physical pixels on Windows, points on macOS).
function validateReference(value) {
  if (!value || ![[800, 600], [1280, 960]].some(([w, h]) => value.width === w && value.height === h)) throw new Error('기준 해상도는 800×600 또는 1280×960이어야 합니다.');
  return { width: value.width, height: value.height };
}
function transform(client, reference) {
  validateReference(reference);
  const sx = client.width / reference.width, sy = client.height / reference.height;
  if (![sx, sy].every(v => Number.isFinite(v) && v > 0) || Math.abs(sx / sy - 1) > 0.015) throw new Error('대상 영역의 비율이 4:3이 아닙니다. 게임 콘텐츠 영역을 800×600 또는 1280×960 비율로 맞추세요.');
  return {
    point(x, y) {
      if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x >= reference.width || y >= reference.height) throw new Error('기준 좌표가 대상 영역을 벗어났습니다.');
      return { x: client.x + Math.round(x * sx), y: client.y + Math.round(y * sy) };
    },
    region(area) {
      if (area.x < 0 || area.y < 0 || area.width < 1 || area.height < 1 || area.x + area.width > reference.width || area.y + area.height > reference.height) throw new Error('검색 영역이 기준 해상도를 벗어났습니다.');
      const p = this.point(area.x, area.y);
      return { ...p, width: Math.round((area.x + area.width) * sx) - Math.round(area.x * sx), height: Math.round((area.y + area.height) * sy) - Math.round(area.y * sy) };
    }, sx, sy,
  };
}
module.exports = { validateReference, transform };
