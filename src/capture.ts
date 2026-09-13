import screenshot from 'screenshot-desktop';
import sharp from 'sharp';

interface RawImage {
  data: Buffer;
  info: sharp.OutputInfo;
}

export async function captureFull(monitor: number): Promise<RawImage> {
  const buffer = await screenshot({ format: 'png', screen: Math.max(0, monitor - 1) });
  return sharp(buffer).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
}

export async function captureRegion(monitor: number, region: { x: number; y: number; width: number; height: number }): Promise<RawImage> {
  const buffer = await screenshot({ format: 'png', screen: Math.max(0, monitor - 1) });
  return sharp(buffer).extract({ left: region.x, top: region.y, width: region.width, height: region.height }).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
}

export async function captureCenter(monitor: number): Promise<RawImage> {
  const buffer = await screenshot({ format: 'png', screen: Math.max(0, monitor - 1) });
  const image = sharp(buffer);
  const metadata = await image.metadata();
  const region = { x: Math.floor((metadata.width as number) * 0.25), y: Math.floor((metadata.height as number) * 0.4), width: Math.floor((metadata.width as number) * 0.5), height: Math.floor((metadata.height as number) * 0.2) };
  return image.extract({ left: region.x, top: region.y, width: region.width, height: region.height }).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
}
