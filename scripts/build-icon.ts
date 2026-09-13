import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import sharp from 'sharp';

async function main(): Promise<void> {
  const root: string = path.join(__dirname, '..', '..');
  const source: string = path.join(root, 'assets', 'coffee-source.png');
  const destination: string = path.join(root, 'electron', 'assets');
  await fs.mkdir(destination, { recursive: true });
  await sharp(source).resize(512, 512).png().toFile(path.join(destination, 'coffee.png'));
  const sizes: number[] = [16, 24, 32, 48, 64, 128, 256];
  const images: Buffer[] = await Promise.all(sizes.map((size: number): Promise<Buffer> => sharp(source).resize(size, size).png().toBuffer()));
  const header: Buffer = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset: number = header.length;
  images.forEach((image: Buffer, index: number): void => {
    const entry: number = 6 + index * 16;
    header[entry] = header[entry + 1] = sizes[index] === 256 ? 0 : (sizes[index] as number);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  await fs.writeFile(path.join(destination, 'coffee.ico'), Buffer.concat([header, ...images]));
  console.log('Created coffee.png and coffee.ico (16 through 256 px).');
}
main().catch((error: unknown): void => { console.error(error); process.exitCode = 1; });
