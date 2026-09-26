const sharp = require('sharp');
const { findZoned } = require('./detect');
async function matchFrame({ buffer, source, area, reference, asset, zone = 0, threshold = .9, control }) {
  const scale = reference && asset?.reference_width ? reference.width / asset.reference_width : 1;
  if (scale !== 1) {
    const meta = await sharp(source).metadata();
    source = await sharp(source).resize(Math.max(1, Math.round(meta.width * scale)), Math.max(1, Math.round(meta.height * scale))).png().toBuffer();
  }
  const frame = await sharp(buffer).resize(area.width, area.height).png().toBuffer();
  const home = asset?.region ? Object.fromEntries(Object.entries(asset.region).map(([k,v]) => [k, Math.round(v * scale)])) : null;
  const match = await findZoned(frame, source, area, zone, threshold, control, home);
  return { match, frame };
}
module.exports = { matchFrame };
