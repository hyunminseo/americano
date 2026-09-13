import sharp from 'sharp';

export interface RawImage {
  data: Buffer;
  info: sharp.OutputInfo;
}

export interface Corner {
  x: number;
  y: number;
  score: number;
}

export interface DescribedPoint {
  x: number;
  y: number;
  angle: number;
  descriptor: Buffer;
}

export interface DescriptorMatch {
  template: DescribedPoint;
  frame: DescribedPoint;
  distance: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface SimilarityModel {
  cos: number;
  sin: number;
  tx: number;
  ty: number;
  scale: number;
  theta: number;
}

export interface RansacResult {
  model: SimilarityModel;
  inliers: DescriptorMatch[];
}

export interface FeatureMatch {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  inliers: number;
  rotation_deg: number;
  [key: string]: unknown;
}

// ORB 스타일 특징점 매칭: FAST 코너 + 방향 정규화 BRIEF + 해밍 매칭 +
// 유사변환(회전·크기·이동) RANSAC 검증. 네이티브 의존성 없이 순수 JS로 동작하며,
// 템플릿 매칭이 실패했을 때의 폴백(회전·스케일 변화 대응)으로 사용한다.
const CIRCLE: Array<[number, number]> = [[0, -3], [1, -3], [2, -2], [3, -1], [3, 0], [3, 1], [2, 2], [1, 3], [0, 3], [-1, 3], [-2, 2], [-3, 1], [-3, 0], [-3, -1], [-2, -2], [-1, -3]];
const FAST_THRESHOLD = 25;
const DESCRIPTOR_BITS = 256;
const PATCH_RADIUS = 7;

// 재현 가능한 난수로 기술자 샘플 쌍 256개를 만든다.
function samplePairs(): number[][] {
  let seed = 0x2f6e2b1;
  const next = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const pairs: number[][] = [];
  for (let i = 0; i < DESCRIPTOR_BITS; i += 1) {
    pairs.push([
      Math.floor(next() * (PATCH_RADIUS * 2 + 1)) - PATCH_RADIUS,
      Math.floor(next() * (PATCH_RADIUS * 2 + 1)) - PATCH_RADIUS,
      Math.floor(next() * (PATCH_RADIUS * 2 + 1)) - PATCH_RADIUS,
      Math.floor(next() * (PATCH_RADIUS * 2 + 1)) - PATCH_RADIUS,
    ]);
  }
  return pairs;
}
const PAIRS: number[][] = samplePairs();

const POPCOUNT: number[] = new Array(256).fill(0).map((_: unknown, i: number) => i.toString(2).replace(/0/g, '').length);
export function hamming(a: Buffer, b: Buffer): number {
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) distance += POPCOUNT[a[i] ^ b[i]];
  return distance;
}

// FAST-9: 16개 원 위에서 연속 9개가 임계값을 넘게 밝거나 어두우면 코너다.
function fastScore(data: Buffer, width: number, x: number, y: number): number {
  const center = data[y * width + x];
  const values = CIRCLE.map(([dx, dy]) => data[(y + dy) * width + x + dx]);
  const bright = values.map((v) => v > center + FAST_THRESHOLD);
  const dark = values.map((v) => v < center - FAST_THRESHOLD);
  // 0,4,8,12번 4점 사전 검사로 대부분을 탈락시킨다.
  const pre = [0, 4, 8, 12];
  if (pre.filter((i) => bright[i]).length < 3 && pre.filter((i) => dark[i]).length < 3) return 0;
  const longest = (flags: boolean[]): number => {
    let best = 0;
    for (let start = 0; start < 16; start += 1) {
      if (!flags[start]) continue;
      let run = 0;
      for (let k = 0; k < 16; k += 1) {
        if (!flags[(start + k) % 16]) break;
        run += 1;
      }
      if (run > best) best = run;
    }
    return best;
  };
  return Math.max(longest(bright) >= 9 ? longest(bright) : 0, longest(dark) >= 9 ? longest(dark) : 0);
}

export function detectCorners(raw: RawImage, maxCorners: number): Corner[] {
  const { data, info } = raw;
  const { width, height } = info;
  const margin = PATCH_RADIUS + 4;
  const found: Corner[] = [];
  for (let y = margin; y < height - margin; y += 1) {
    for (let x = margin; x < width - margin; x += 1) {
      const score = fastScore(data, width, x, y);
      if (score >= 9) found.push({ x, y, score });
    }
  }
  found.sort((a, b) => b.score - a.score);
  // 8px 격자 비최대 억제로 뭉친 코너를 솎아낸다.
  const grid = new Map<string, boolean>();
  const kept: Corner[] = [];
  for (const corner of found) {
    const key = `${corner.x >> 3},${corner.y >> 3}`;
    if (grid.has(key)) continue;
    grid.set(key, true);
    kept.push(corner);
    if (kept.length >= maxCorners) break;
  }
  return kept;
}

// 명도 중심(centroid)으로 방향을 구해 회전에 강인하게 만든다.
function orientation(data: Buffer, width: number, x: number, y: number): number {
  let m10 = 0;
  let m01 = 0;
  for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy += 1) {
    for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx += 1) {
      const value = data[(y + dy) * width + x + dx];
      m10 += dx * value;
      m01 += dy * value;
    }
  }
  return Math.atan2(m01, m10);
}

// 단일 픽셀 대신 3x3 평균을 비교한다. 표준 BRIEF의 가우시안 스무딩과 같은
// 역할로, 노이즈·보간·미세 스케일 차이에 강해진다.
function sampleAt(data: Buffer, width: number, height: number, fx: number, fy: number): number {
  const x = Math.round(fx);
  const y = Math.round(fy);
  if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return 128;
  let sum = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    const row = (y + dy) * width + x;
    sum += data[row - 1] + data[row] + data[row + 1];
  }
  return sum / 9;
}

export function describe(raw: RawImage, corner: Corner): DescribedPoint {
  const { data, info } = raw;
  const { width, height } = info;
  const angle = orientation(data, width, corner.x, corner.y);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const out = Buffer.alloc(DESCRIPTOR_BITS / 8);
  for (let i = 0; i < DESCRIPTOR_BITS; i += 1) {
    const [ax, ay, bx, by] = PAIRS[i];
    const pax = corner.x + ax * cos - ay * sin;
    const pay = corner.y + ax * sin + ay * cos;
    const pbx = corner.x + bx * cos - by * sin;
    const pby = corner.y + bx * sin + by * cos;
    if (sampleAt(data, width, height, pax, pay) < sampleAt(data, width, height, pbx, pby)) {
      out[i >> 3] |= 1 << (i % 8);
    }
  }
  return { x: corner.x, y: corner.y, angle, descriptor: out };
}

export function matchDescriptors(templateDescs: DescribedPoint[], frameDescs: DescribedPoint[], ratio = 0.85): DescriptorMatch[] {
  const matches: DescriptorMatch[] = [];
  for (const t of templateDescs) {
    let best: { frame: DescribedPoint; distance: number } | null = null;
    let second = Infinity;
    for (const f of frameDescs) {
      const distance = hamming(t.descriptor, f.descriptor);
      if (distance < (best?.distance ?? Infinity)) { second = best?.distance ?? Infinity; best = { frame: f, distance }; }
      else if (distance < second) second = distance;
    }
    if (best && best.distance < 64 && best.distance < second * ratio) matches.push({ template: t, frame: best.frame, distance: best.distance });
  }
  // 상호 검사로 일대다 매칭을 제거한다.
  const bestByFrame = new Map<string, DescriptorMatch>();
  for (const m of matches) {
    const key = `${m.frame.x},${m.frame.y}`;
    const current = bestByFrame.get(key);
    if (!current || current.distance > m.distance) bestByFrame.set(key, m);
  }
  return [...bestByFrame.values()];
}

// 2점 유사변환 RANSAC: 회전·균일 스케일·이동을 함께 푼다.
export function solveSimilarity(p1: Point, q1: Point, p2: Point, q2: Point): SimilarityModel | null {
  const dpx = p2.x - p1.x;
  const dpy = p2.y - p1.y;
  const dqx = q2.x - q1.x;
  const dqy = q2.y - q1.y;
  const dpLen = Math.hypot(dpx, dpy);
  const dqLen = Math.hypot(dqx, dqy);
  if (dpLen < 4 || dqLen < 1) return null;
  const s = dqLen / dpLen;
  if (s < 0.3 || s > 3.5) return null;
  const theta = Math.atan2(dqy, dqx) - Math.atan2(dpy, dpx);
  const cos = Math.cos(theta) * s;
  const sin = Math.sin(theta) * s;
  const tx = q1.x - (cos * p1.x - sin * p1.y);
  const ty = q1.y - (sin * p1.x + cos * p1.y);
  return { cos, sin, tx, ty, scale: s, theta };
}

function applyModel(model: SimilarityModel, p: Point): Point {
  return { x: model.cos * p.x - model.sin * p.y + model.tx, y: model.sin * p.x + model.cos * p.y + model.ty };
}

// 인라이어 전체로 유사변환을 최소제곱 재적합한다. RANSAC 2점 해보다 중심이 정확해진다.
export function refitSimilarity(inliers: DescriptorMatch[]): SimilarityModel | null {
  let pcx = 0;
  let pcy = 0;
  let qcx = 0;
  let qcy = 0;
  for (const m of inliers) { pcx += m.template.x; pcy += m.template.y; qcx += m.frame.x; qcy += m.frame.y; }
  pcx /= inliers.length; pcy /= inliers.length; qcx /= inliers.length; qcy /= inliers.length;
  let numA = 0;
  let numB = 0;
  let den = 0;
  for (const m of inliers) {
    const px = m.template.x - pcx;
    const py = m.template.y - pcy;
    const qx = m.frame.x - qcx;
    const qy = m.frame.y - qcy;
    numA += qx * px + qy * py;
    numB += qy * px - qx * py;
    den += px * px + py * py;
  }
  if (den < 1) return null;
  const a = numA / den;
  const b = numB / den;
  const scale = Math.hypot(a, b);
  if (scale < 0.3 || scale > 3.5) return null;
  return { cos: a, sin: b, tx: qcx - (a * pcx - b * pcy), ty: qcy - (b * pcx + a * pcy), scale, theta: Math.atan2(b, a) };
}

function countInliers(model: SimilarityModel, matches: DescriptorMatch[], tolerance: number): DescriptorMatch[] {
  return matches.filter((m) => {
    const projected = applyModel(model, m.template);
    return Math.hypot(projected.x - m.frame.x, projected.y - m.frame.y) <= tolerance;
  });
}

export function ransacSimilarity(matches: DescriptorMatch[], tolerance = 4): RansacResult | null {
  if (matches.length < 2) return null;
  let best: RansacResult | null = null;
  let seed = 0x9e3779b9;
  const rand = (n: number): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % n;
  };
  const iterations = Math.min(300, matches.length * (matches.length - 1) / 2);
  for (let i = 0; i < iterations; i += 1) {
    const a = matches[rand(matches.length)];
    let b = matches[rand(matches.length)];
    if (a === b) continue;
    const model = solveSimilarity(a.template, a.frame, b.template, b.frame);
    if (!model) continue;
    const inliers: DescriptorMatch[] = [];
    for (const m of matches) {
      const projected = applyModel(model, m.template);
      if (Math.hypot(projected.x - m.frame.x, projected.y - m.frame.y) <= tolerance) inliers.push(m);
    }
    if (!best || inliers.length > best.inliers.length) {
      best = { model, inliers };
      if (inliers.length >= Math.max(12, matches.length * 0.6)) break;
    }
  }
  if (!best || best.inliers.length < 8) return null;
  // 최적 모델을 인라이어 전체로 재적합하고 인라이어를 다시 센다.
  const refit = refitSimilarity(best.inliers);
  if (refit) {
    const recount = countInliers(refit, matches, tolerance);
    if (recount.length >= best.inliers.length) return { model: refit, inliers: recount };
  }
  return best;
}

// 프레임은 3단 피라미드(1, 1/1.2, 1/1.44)로 코너를 모아 스케일 변화에 대응한다.
// 템플릿은 기준이므로 원본 한 장만 쓴다. 좌표는 원본 기준으로 환산해 모은다.
const PYRAMID: number[] = [1, 1 / 1.2, 1 / 1.44];

async function downRaw(raw: RawImage, factor: number): Promise<RawImage> {
  const width = Math.max(16, Math.round(raw.info.width * factor));
  const height = Math.max(16, Math.round(raw.info.height * factor));
  return sharp(raw.data, { raw: { width: raw.info.width, height: raw.info.height, channels: raw.info.channels } })
    .resize(width, height).greyscale().raw().toBuffer({ resolveWithObject: true });
}

// frameRaw 안에서 templateRaw를 찾아 프레임 좌표를 반환한다. 없으면 null.
// 프레임 3단 + 템플릿 2단 피라미드로 양방향 스케일 변화에 대응한다.
export async function matchFeatures(frameRaw: RawImage, templateRaw: RawImage): Promise<FeatureMatch | null> {
  const templateDescs: DescribedPoint[] = [];
  for (const factor of [1, 0.8]) {
    const level = factor === 1 ? templateRaw : await downRaw(templateRaw, factor);
    for (const corner of detectCorners(level, 150)) {
      const described = describe(level, corner);
      templateDescs.push({ x: corner.x / factor, y: corner.y / factor, angle: described.angle, descriptor: described.descriptor });
    }
  }
  if (templateDescs.length < 8) return null;
  const frameDescs: DescribedPoint[] = [];
  for (const factor of PYRAMID) {
    const level = factor === 1 ? frameRaw : await downRaw(frameRaw, factor);
    const corners = detectCorners(level, 400);
    for (const corner of corners) {
      const described = describe(level, corner);
      frameDescs.push({ x: corner.x / factor, y: corner.y / factor, angle: described.angle, descriptor: described.descriptor });
    }
  }
  if (!frameDescs.length) return null;
  const matches = matchDescriptors(templateDescs, frameDescs);
  if (matches.length < 8) return null;
  const consensus = ransacSimilarity(matches);
  if (!consensus) return null;
  const { model, inliers } = consensus;
  const tw = templateRaw.info.width;
  const th = templateRaw.info.height;
  const center = applyModel(model, { x: tw / 2, y: th / 2 });
  const width = Math.max(1, Math.round(tw * model.scale));
  const height = Math.max(1, Math.round(th * model.scale));
  return {
    x: Math.round(center.x - width / 2),
    y: Math.round(center.y - height / 2),
    width,
    height,
    score: Math.min(0.99, 0.5 + inliers.length / 40),
    inliers: inliers.length,
    rotation_deg: Math.round(model.theta * 180 / Math.PI),
  };
}
