// Blueprint validation, tile connectivity checks, component type validation, and rotation normalization.

const { PARTS } = require("./components");
const { computeStats } = require("./shipStats");
const { DEFAULT_DESIGN } = require("./config");
const { getOccupiedCells } = require("./footprint");

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
    const rotation = normalizePartRotation(type, x, raw?.rotation);

    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    if (!PARTS[type]) continue;

    const footprint = PARTS[type].footprint || { width: 1, height: 1 };
    const cells = getOccupiedCells(x, y, footprint, rotation);

    let isOutOfBounds = false;
    let isOverlapping = false;

    for (const cell of cells) {
      if (cell.x < 0 || cell.x > 14 || cell.y < 0 || cell.y > 14) isOutOfBounds = true;
      const key = `${cell.x},${cell.y}`;
      if (occupied.has(key)) isOverlapping = true;
    }

    if (isOutOfBounds || isOverlapping) continue;

    if (type === "core") coreCount += 1;

    for (const cell of cells) {
      occupied.add(`${cell.x},${cell.y}`);
    }

    clean.push({ x, y, type, rotation });
  }

  if (!clean.length) return { ok: false, reason: "Invalid design: blueprint is empty." };
  if (coreCount !== 1) return { ok: false, reason: "Invalid design: exactly one core is required." };
  if (!isConnected(clean)) return { ok: false, reason: "Invalid design: all parts must connect to the core." };

  if (clean.length < input.length) return { ok: false, reason: "Invalid design: blueprint contains invalid overlapping or out of bounds modules." };

  const stats = computeStats(clean);
  if (stats.thrust <= 0) return { ok: false, reason: "Invalid design: add at least one engine." };

  return { ok: true, modules: clean, stats };
}

function isConnected(modules) {
  const core = modules.find((part) => part.type === "core");
  if (!core) return false;

  // Cell -> owning module index so each neighbour lookup is O(1). Kept in sync
  // with public/src/design/blueprintValidation.js. Assumes modules don't
  // overlap — validateDesign filters overlaps before calling this.
  const partCellsMap = new Map();
  const cellOwner = new Map();

  for (let i = 0; i < modules.length; i++) {
    const part = modules[i];
    const stat = PARTS[part.type] || PARTS.frame;
    const footprint = stat.footprint || { width: 1, height: 1 };
    const cells = getOccupiedCells(part.x, part.y, footprint, part.rotation || 0);
    partCellsMap.set(i, cells);
    for (const cell of cells) {
      cellOwner.set(`${cell.x},${cell.y}`, i);
    }
  }

  const seenParts = new Set();
  const queue = [];

  const coreIndex = modules.indexOf(core);
  seenParts.add(coreIndex);
  queue.push(coreIndex);

  for (let i = 0; i < queue.length; i += 1) {
    const partIndex = queue[i];
    const cells = partCellsMap.get(partIndex);

    for (const cell of cells) {
      for (const [nx, ny] of [[cell.x + 1, cell.y], [cell.x - 1, cell.y], [cell.x, cell.y + 1], [cell.x, cell.y - 1]]) {
        const neighbor = cellOwner.get(`${nx},${ny}`);
        if (neighbor !== undefined && !seenParts.has(neighbor)) {
          seenParts.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
  }

  return seenParts.size === modules.length;
}

function normalizeShipDesignSnapshot(design) {
  const source = Array.isArray(design) ? design : DEFAULT_DESIGN;
  const oldCore = source.find(p => p && p.type === "core" && Math.trunc(Number(p.x)) === 3 && Math.trunc(Number(p.y)) === 3);
  const offsetX = oldCore ? 4 : 0;
  const offsetY = oldCore ? 4 : 0;
  return source.map((part) => {
    const x = part.x + offsetX;
    const type = part.type;
    return {
      x,
      y: part.y + offsetY,
      type,
      rotation: normalizePartRotation(type, x, part.rotation)
    };
  });
}

function normalizePartRotation(type, x, rotation) {
  if (type === "maneuverThruster") return maneuverThrusterAutoRotation(x);
  return isRotatablePart(type) ? normalizeRotation(rotation) : 0;
}

function isRotatablePart(type) {
  const part = PARTS[type] || {};
  if (type === "engine" || type === "maneuverThruster") return false;
  if (part.category === "Engines") return part.thrust > 0 && part.rotationRequired === true;
  return part.category === "Weapons"
    || (part.category === "Defence" && Boolean(part.weapon))
    || part.rotationRequired === true;
}

function maneuverThrusterAutoRotation(x) {
  if (x < 7) return 90;
  if (x > 7) return 270;
  return 0;
}

function normalizeRotation(value) {
  const rotation = Number(value);
  return [0, 90, 180, 270].includes(rotation) ? rotation : 0;
}

module.exports = {
  validateDesign,
  isConnected,
  normalizeShipDesignSnapshot,
  normalizeRotation,
  normalizePartRotation
};
