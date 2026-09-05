const fs = require('fs');
const path = require('path');

class ConfigError extends Error {}
const ALLOWED_KEYS = new Set(['backspace', 'delete', 'down', 'end', 'enter', 'esc', 'home', 'left', 'page_down', 'page_up', 'right', 'space', 'tab', 'up', 'alt', 'ctrl', 'shift', 'win']);

function required(object, name, type) {
  if (typeof object?.[name] !== type) throw new ConfigError(`'${name}' must be ${type}`);
  return object[name];
}

function parseRegion(value) {
  if (!value || typeof value !== 'object') throw new ConfigError("'region' must be an object");
  const region = {};
  for (const name of ['x', 'y', 'width', 'height']) region[name] = required(value, name, 'number');
  if (![region.x, region.y].every(Number.isInteger) || ![region.width, region.height].every(Number.isInteger) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0) throw new ConfigError('region must have non-negative coordinates and positive dimensions');
  return region;
}

function parseActions(value) {
  if (!Array.isArray(value) || value.length === 0) throw new ConfigError("'actions' must be a non-empty array");
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new ConfigError('each action must be an object');
    const key = required(item, 'key', 'string').toLowerCase();
    if (key.length !== 1 && !ALLOWED_KEYS.has(key) && !key.includes('+')) throw new ConfigError(`unsupported key: ${key}`);
    const delayMs = item.delay_ms ?? 0;
    if (!Number.isInteger(delayMs) || delayMs < 0) throw new ConfigError('action delay_ms must be a non-negative integer');
    return { key, delayMs };
  });
}

function loadConfig(configPath) {
  const absolutePath = path.resolve(configPath);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(absolutePath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new ConfigError(`configuration file not found: ${absolutePath}`);
    throw new ConfigError(`invalid JSON: ${error.message}`);
  }
  if (!raw || raw.version !== 1) throw new ConfigError('configuration version must be 1');
  const monitor = raw.monitor ?? 1;
  const scanIntervalMs = raw.scan_interval_ms ?? 100;
  if (!Number.isInteger(monitor) || monitor < 1) throw new ConfigError('monitor must be a positive integer');
  if (!Number.isInteger(scanIntervalMs) || scanIntervalMs < 30) throw new ConfigError('scan_interval_ms must be at least 30');
  if (!Array.isArray(raw.targets) || raw.targets.length === 0) throw new ConfigError("'targets' must be a non-empty array");
  const ids = new Set();
  const targets = raw.targets.map((item) => {
    if (!item || typeof item !== 'object') throw new ConfigError('each target must be an object');
    const id = required(item, 'id', 'string');
    if (!id || ids.has(id)) throw new ConfigError(`target id must be unique: ${id}`);
    ids.add(id);
    const image = required(item, 'image', 'string');
    const imagePath = path.resolve(path.dirname(absolutePath), image);
    if (!fs.statSync(imagePath, { throwIfNoEntry: false })?.isFile()) throw new ConfigError(`target image not found: ${imagePath}`);
    const threshold = item.threshold ?? 0.9;
    if (typeof threshold !== 'number' || threshold < 0 || threshold > 1) throw new ConfigError('threshold must be between 0.0 and 1.0');
    const trigger = item.trigger ?? 'on_appear';
    if (trigger !== 'on_appear') throw new ConfigError("only the 'on_appear' trigger is supported");
    const cooldownMs = item.cooldown_ms ?? 1000;
    if (!Number.isInteger(cooldownMs) || cooldownMs < 0) throw new ConfigError('cooldown_ms must be a non-negative integer');
    if (typeof item.enabled !== 'undefined' && typeof item.enabled !== 'boolean') throw new ConfigError('enabled must be a boolean');
    return { id, imagePath, region: parseRegion(item.region), threshold, trigger, cooldownMs, actions: parseActions(item.actions), enabled: item.enabled ?? true };
  });
  return { monitor, scanIntervalMs, targets };
}

module.exports = { ConfigError, loadConfig };
