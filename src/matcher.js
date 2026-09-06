const sharp = require('sharp');

async function loadTemplate(filePath) {
  try {
    return await sharp(filePath).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw new Error(`unable to read template image: ${filePath}: ${error.message}`);
  }
}

function standardDeviation(data) {
  let sum = 0;
  for (const value of data) sum += value;
  const mean = sum / data.length;
  let variance = 0;
  for (const value of data) variance += (value - mean) ** 2;
  return Math.sqrt(variance / data.length);
}

function correlation(screen, template, width, height, templateWidth, templateHeight, offsetX, offsetY) {
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

function squaredDifference(screen, template, width, height, templateWidth, templateHeight, offsetX, offsetY) {
  let error = 0;
  for (let y = 0; y < templateHeight; y += 1) for (let x = 0; x < templateWidth; x += 1) {
    const difference = screen[(offsetY + y) * width + offsetX + x] - template[y * templateWidth + x];
    error += difference * difference;
  }
  return 1 - Math.sqrt(error / (templateWidth * templateHeight)) / 255;
}

async function findBest(screen, template, width, height, templateWidth, templateHeight, control) {
  const constant = standardDeviation(template) === 0;
  let best = { score: -1, x: 0, y: 0 };
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

async function findTemplate(screen, template, threshold, control) {
  const screenWidth = screen.info.width;
  const screenHeight = screen.info.height;
  const templateWidth = template.info.width;
  const templateHeight = template.info.height;
  if (templateHeight > screenHeight || templateWidth > screenWidth) return null;
  const match = await findBest(screen.data, template.data, screenWidth, screenHeight, templateWidth, templateHeight, control);
  if (match.score < threshold) return null;
  return { ...match, width: templateWidth, height: templateHeight };
}

module.exports = { loadTemplate, findTemplate };
