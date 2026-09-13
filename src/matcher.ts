import sharp from 'sharp';

export interface RawImage {
  data: Buffer;
  info: sharp.OutputInfo;
}

export interface MatchControl {
  checkpoint(): Promise<void>;
}

export interface TemplateOptions {
  preprocess?: string;
}

export interface TemplateMatch {
  score: number;
  x: number;
  y: number;
  width: number;
  height: number;
  [key: string]: unknown;
}

interface Best {
  score: number;
  x: number;
  y: number;
}

export interface Consensus {
  mean: number;
  ratio: number;
}

export async function loadTemplate(filePath: string | Buffer, options: TemplateOptions = {}): Promise<RawImage> {
  try {
    const raw = await sharp(filePath).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
    if (options.preprocess === 'normalize') {
      return { data: normalizeContrast(raw.data), info: raw.info };
    }
    return raw;
  } catch (error) {
    throw new Error(`unable to read template image: ${filePath}: ${(error as Error).message}`);
  }
}

// 조명 변화에 강하도록 명암을 전체 구간으로 늘린다. 템플릿과 프레임 양쪽에
// 같은 함수를 적용해야 상관값이 성립한다. 평탄한 영역은 그대로 둔다.
export function normalizeContrast(data: Buffer): Buffer {
  let min = 255;
  let max = 0;
  for (const value of data) { if (value < min) min = value; if (value > max) max = value; }
  if (max - min < 8) return data;
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = Math.round((data[i] - min) * 255 / (max - min));
  return out;
}

function standardDeviation(data: Buffer): number {
  let sum = 0;
  for (const value of data) sum += value;
  const mean = sum / data.length;
  let variance = 0;
  for (const value of data) variance += (value - mean) ** 2;
  return Math.sqrt(variance / data.length);
}

function correlation(screen: Buffer, template: Buffer, width: number, height: number, templateWidth: number, templateHeight: number, offsetX: number, offsetY: number): number {
  let screenSum = 0;
  let templateSum = 0;
  const size = templateWidth * templateHeight;
  for (let y = 0; y < templateHeight; y += 1) for (let x = 0; x < templateWidth; x += 1) {
    screenSum += screen[(offsetY + y) * width + offsetX + x];
    templateSum += template[y * templateWidth + x];
  }
  const screenMean = screenSum / size;
  const templateMean = templateSum / size;
  let numerator = 0;
  let screenVariance = 0;
  let templateVariance = 0;
  for (let y = 0; y < templateHeight; y += 1) for (let x = 0; x < templateWidth; x += 1) {
    const screenValue = screen[(offsetY + y) * width + offsetX + x] - screenMean;
    const templateValue = template[y * templateWidth + x] - templateMean;
    numerator += screenValue * templateValue;
    screenVariance += screenValue ** 2;
    templateVariance += templateValue ** 2;
  }
  return templateVariance === 0 || screenVariance === 0 ? -1 : numerator / Math.sqrt(screenVariance * templateVariance);
}

function squaredDifference(screen: Buffer, template: Buffer, width: number, height: number, templateWidth: number, templateHeight: number, offsetX: number, offsetY: number): number {
  let error = 0;
  for (let y = 0; y < templateHeight; y += 1) for (let x = 0; x < templateWidth; x += 1) {
    const difference = screen[(offsetY + y) * width + offsetX + x] - template[y * templateWidth + x];
    error += difference * difference;
  }
  return 1 - Math.sqrt(error / (templateWidth * templateHeight)) / 255;
}

async function findBest(screen: Buffer, template: Buffer, width: number, height: number, templateWidth: number, templateHeight: number, control?: MatchControl | null): Promise<Best> {
  const constant = standardDeviation(template) === 0;
  let best: Best = { score: -1, x: 0, y: 0 };
  for (let y = 0; y <= height - templateHeight; y += 1) for (let x = 0; x <= width - templateWidth; x += 1) {
    if ((y * (width - templateWidth + 1) + x) % Math.max(1, Math.floor(100000 / (templateWidth * templateHeight))) === 0) {
      await new Promise((resolve) => setImmediate(resolve));
      if (control) await control.checkpoint();
    }
    const score = constant ? squaredDifference(screen, template, width, height, templateWidth, templateHeight, x, y) : correlation(screen, template, width, height, templateWidth, templateHeight, x, y);
    if (score > best.score) best = { score, x, y };
    if (best.score >= 1 - Number.EPSILON) return best;
  }
  return best;
}

export async function findTemplate(screen: RawImage, template: RawImage, threshold: number, control?: MatchControl | null): Promise<TemplateMatch | null> {
  const screenWidth = screen.info.width;
  const screenHeight = screen.info.height;
  const templateWidth = template.info.width;
  const templateHeight = template.info.height;
  if (templateHeight > screenHeight || templateWidth > screenWidth) return null;
  const match = await findBest(screen.data, template.data, screenWidth, screenHeight, templateWidth, templateHeight, control);
  if (match.score < threshold) return null;
  return { ...match, width: templateWidth, height: templateHeight };
}

// 블록 합의 검증: 템플릿을 grid x grid 조각으로 나눠 매치 위치에서 조각별 상관을
// 잰다. 모양만 닮은 오인식(버튼류)은 일부 조각이 크게 어긋나므로 걸러진다.
// 평탄한 조각은 정보가 없어 제외한다.
function correlationStrided(screen: Buffer, screenWidth: number, offsetX: number, offsetY: number, template: Buffer, templateWidth: number, templateOffset: number, blockWidth: number, blockHeight: number): number | null {
  let screenSum = 0;
  let templateSum = 0;
  const size = blockWidth * blockHeight;
  for (let y = 0; y < blockHeight; y += 1) {
    const screenRow = (offsetY + y) * screenWidth + offsetX;
    const templateRow = templateOffset + y * templateWidth;
    for (let x = 0; x < blockWidth; x += 1) {
      screenSum += screen[screenRow + x];
      templateSum += template[templateRow + x];
    }
  }
  const screenMean = screenSum / size;
  const templateMean = templateSum / size;
  let numerator = 0;
  let screenVariance = 0;
  let templateVariance = 0;
  for (let y = 0; y < blockHeight; y += 1) {
    const screenRow = (offsetY + y) * screenWidth + offsetX;
    const templateRow = templateOffset + y * templateWidth;
    for (let x = 0; x < blockWidth; x += 1) {
      const screenValue = screen[screenRow + x] - screenMean;
      const templateValue = template[templateRow + x] - templateMean;
      numerator += screenValue * templateValue;
      screenVariance += screenValue ** 2;
      templateVariance += templateValue ** 2;
    }
  }
  if (templateVariance === 0 || screenVariance === 0) return null;
  return numerator / Math.sqrt(screenVariance * templateVariance);
}

export function blockConsensus(screen: RawImage, template: RawImage, x: number, y: number, threshold: number, grid = 4): Consensus {
  const templateWidth = template.info.width;
  const templateHeight = template.info.height;
  let pass = 0;
  let total = 0;
  let sum = 0;
  for (let gy = 0; gy < grid; gy += 1) {
    for (let gx = 0; gx < grid; gx += 1) {
      const blockWidth = Math.floor(templateWidth * (gx + 1) / grid) - Math.floor(templateWidth * gx / grid);
      const blockHeight = Math.floor(templateHeight * (gy + 1) / grid) - Math.floor(templateHeight * gy / grid);
      const blockX = Math.floor(templateWidth * gx / grid);
      const blockY = Math.floor(templateHeight * gy / grid);
      const score = correlationStrided(screen.data, screen.info.width, x + blockX, y + blockY,
        template.data, templateWidth, blockY * templateWidth + blockX, blockWidth, blockHeight);
      if (score === null) continue;
      total += 1;
      sum += score;
      if (score >= threshold - 0.05) pass += 1;
    }
  }
  if (!total) return { mean: 1, ratio: 1 };
  return { mean: sum / total, ratio: pass / total };
}
