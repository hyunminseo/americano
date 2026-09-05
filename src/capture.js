const screenshot = require('screenshot-desktop');
const sharp = require('sharp');

async function captureFull(monitor) {
  const buffer = await screenshot({ format: 'png', screen: Math.max(0, monitor - 1) });
  return sharp(buffer).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
}

async function captureRegion(monitor, region) {
  const buffer = await screenshot({ format: 'png', screen: Math.max(0, monitor - 1) });
  return sharp(buffer).extract({ left: region.x, top: region.y, width: region.width, height: region.height }).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
}

async function captureCenter(monitor) {
  const buffer = await screenshot({ format: 'png', screen: Math.max(0, monitor - 1) });
  const image = sharp(buffer);
  const metadata = await image.metadata();
  const region = { x: Math.floor(metadata.width * 0.25), y: Math.floor(metadata.height * 0.4), width: Math.floor(metadata.width * 0.5), height: Math.floor(metadata.height * 0.2) };
  return image.extract(region).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
}

module.exports = { captureRegion, captureCenter, captureFull };
