const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

async function main() {
  const root = path.join(__dirname, '..');
  const source = path.join(root, 'assets', 'coffee-source.png');
  const destination = path.join(root, 'electron', 'assets');
  await fs.mkdir(destination, { recursive: true });
  await sharp(source).resize(512, 512).png().toFile(path.join(destination, 'coffee.png'));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = await Promise.all(sizes.map((size) => sharp(source).resize(size, size).png().toBuffer()));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  images.forEach((image, index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = sizes[index] === 256 ? 0 : sizes[index];
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  await fs.writeFile(path.join(destination, 'coffee.ico'), Buffer.concat([header, ...images]));
  console.log('Created coffee.png and coffee.ico (16 through 256 px).');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
