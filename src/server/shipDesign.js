// Blueprint validation, tile connectivity checks, component type validation, and rotation normalization.

const { PARTS } = require("./components");
const { computeStats } = require("./shipStats");
const { DEFAULT_DESIGN } = require("./config");

function validateDesign(input) {
  if (!Array.isArray(input)) return { ok: false, reason: "Invalid design: no blueprint was sent." };
  const modules = input;
  const clean = [];
  const occupied = new Set();
  let coreCount = 0;

  for (const raw of modules) {
    const x = Math.trunc(Number(raw?.x));
    const y = Math.trunc(Number(raw?.y));
    const type = String(raw?.type || "");
    const key = `${x},${y}`;

    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 6 || y < 0 || y > 6) continue;
    if (!PARTS[type] || occupied.has(key)) continue;
    if (type === "core") coreCount += 1;

    occupied.add(key);
    clean.push({ x, y, type, rotation: normalizeRotation(raw?.rotation) });
  }

  if (!clean.length) return { ok: false, reason: "Invalid design: blueprint is empty." };
  if (coreCount !== 1) return { ok: false, reason: "Invalid design: exactly one core is required." };
  if (!isConnected(clean)) return { ok: false, reason: "Invalid design: all parts must connect to the core." };

  return { ok: true, modules: clean, stats: computeStats(clean) };
}

function isConnected(modules) {
  const keys = new Set(modules.map((part) => `${part.x},${part.y}`));
  const core = modules.find((part) => part.type === "core");
  if (!core) return false;

  const queue = [core];
  const seen = new Set([`${core.x},${core.y}`]);
  for (let i = 0; i < queue.length; i += 1) {
    const part = queue[i];
    const neighbors = [
      [part.x + 1, part.y],
      [part.x - 1, part.y],
      [part.x, part.y + 1],
      [part.x, part.y - 1]
    ];

    for (const [x, y] of neighbors) {
      const key = `${x},${y}`;
      if (keys.has(key) && !seen.has(key)) {
        seen.add(key);
        queue.push({ x, y });
      }
    }
  }

  return seen.size === modules.length;
}

function normalizeShipDesignSnapshot(design) {
  const source = Array.isArray(design) ? design : DEFAULT_DESIGN;
  return source.map((part) => ({ x: part.x, y: part.y, type: part.type, rotation: normalizeRotation(part.rotation) }));
}

function normalizeRotation(value) {
  const rotation = Number(value);
  return [0, 90, 180, 270].includes(rotation) ? rotation : 0;
}

module.exports = {
  validateDesign,
  isConnected,
  normalizeShipDesignSnapshot,
  normalizeRotation
};
