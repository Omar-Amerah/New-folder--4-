// Blueprint validation, tile connectivity checks, component type validation, and rotation normalization.

const { PARTS } = require("./components");
const { computeStats } = require("./shipStats");
const { DEFAULT_DESIGN } = require("./config");
const { getOccupiedCells } = require("./footprint");
const WiringRules = require("../../public/src/shared/wiringRules");

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

// Independently normalizes and validates client-supplied wiring against the
// already-validated module list. The server never trusts client network ids,
// connectivity results, connected-component lists, bonuses or powered states —
// only raw segments are read, and everything else is re-derived from them.
// Malformed, floating, duplicate or excess segments are dropped rather than
// rejecting the blueprint (disconnected wiring is a designer warning, not a
// blocking error).
function validateWiring(modules, wiring) {
  const { wiring: normalized, droppedSegments } = WiringRules.normalizeWiring(wiring, modules, PARTS);
  return { ok: true, wiring: normalized, droppedSegments };
}

// The single boundary used by ship creation.  Returning fresh clones here makes
// blueprint state a value: neither a later editor save nor another ship can
// mutate an existing ship's design/wiring snapshot.
function createShipBlueprintSnapshot(design, wiring) {
  const normalizedDesign = normalizeShipDesignSnapshot(design);
  const normalizedWiring = validateWiring(normalizedDesign, wiring).wiring;
  return {
    design: normalizedDesign.map((part) => ({ ...part })),
    wiring: WiringRules.cloneWiring(normalizedWiring)
  };
}

// Deterministic server-only wiring for generated ships. Each consumer gets the
// shortest occupied-cell route from the lowest-index reachable Power source.
function createGeneratedPowerWiring(design) {
  const modules = normalizeShipDesignSnapshot(design);
  const occupied = new Map();
  modules.forEach((module, index) => WiringRules.moduleCells(module, PARTS)
    .forEach((cell) => occupied.set(WiringRules.cellKey(cell.x, cell.y), { ...cell, index })));
  const sources = modules.map((module, index) => ({ module, index }))
    .filter(({ module }) => WiringRules.isPowerSourceType(module.type));
  let wiring = WiringRules.emptyWiring();
  modules.forEach((module, targetIndex) => {
    if (!WiringRules.isPowerConsumer(module.type, PARTS)) return;
    let best = null;
    for (const { index: sourceIndex } of sources) {
      const starts = WiringRules.moduleCells(modules[sourceIndex], PARTS);
      const targets = new Set(WiringRules.moduleCells(module, PARTS).map((cell) => WiringRules.cellKey(cell.x, cell.y)));
      const queue = starts.map((cell) => [cell]);
      const seen = new Set(starts.map((cell) => WiringRules.cellKey(cell.x, cell.y)));
      let route = null;
      for (let cursor = 0; cursor < queue.length && !route; cursor += 1) {
        const path = queue[cursor]; const cell = path.at(-1);
        if (targets.has(WiringRules.cellKey(cell.x, cell.y))) { route = path; break; }
        for (const [x, y] of [[cell.x, cell.y - 1], [cell.x - 1, cell.y], [cell.x + 1, cell.y], [cell.x, cell.y + 1]]) {
          const key = WiringRules.cellKey(x, y);
          if (occupied.has(key) && !seen.has(key)) { seen.add(key); queue.push([...path, { x, y }]); }
        }
      }
      if (route && (!best || route.length < best.route.length || (route.length === best.route.length && sourceIndex < best.sourceIndex))) best = { route, sourceIndex };
    }
    if (best && best.route.length > 1) wiring = WiringRules.addConnection(wiring, "power", best.sourceIndex, targetIndex, best.route, modules, PARTS);
  });
  return wiring;
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

  const coreIndex = modules.indexOf(core);
  const traverse = (canEnter) => {
    const seenParts = new Set([coreIndex]);
    const queue = [coreIndex];
    for (let i = 0; i < queue.length; i += 1) {
      const partIndex = queue[i];
      const cells = partCellsMap.get(partIndex);

      for (const cell of cells) {
        for (const [nx, ny] of [[cell.x + 1, cell.y], [cell.x - 1, cell.y], [cell.x, cell.y + 1], [cell.x, cell.y - 1]]) {
          const neighbor = cellOwner.get(`${nx},${ny}`);
          if (neighbor !== undefined && !seenParts.has(neighbor) && canEnter(neighbor)) {
            seenParts.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
    }
    return seenParts;
  };

  const physicallyConnected = traverse(() => true);
  if (physicallyConnected.size !== modules.length) return false;

  // Heat pipes are mounted services, not hull structure. They may be attached to
  // the ship as thermal conduits, but no normal component may rely on a heat-pipe
  // chain as its only path back to the core.
  const structurallyConnected = traverse(index => modules[index].type !== "heatPipe");
  for (let i = 0; i < modules.length; i += 1) {
    if (modules[i].type !== "heatPipe" && !structurallyConnected.has(i)) return false;
  }

  return true;
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
  const allowed = (PARTS[type] || {}).allowedRotations;
  return type === "maneuverThruster" ? legacySideRotation(x) : isRotatablePart(type) ? normalizeRotation(rotation, allowed, x) : 0;
}

function isRotatablePart(type) {
  const part = PARTS[type] || {};
  if (type === "engine" || type === "maneuverThruster") return false;
  if (Array.isArray(part.allowedRotations) && part.allowedRotations.length) return true;
  if (part.category === "Engines") return part.thrust > 0 && part.rotationRequired === true;
  return part.category === "Weapons"
    || (part.category === "Defence" && Boolean(part.weapon))
    || part.rotationRequired === true;
}

function legacySideRotation(x) { return Number(x) < 7 ? 90 : 270; }

function normalizeRotation(value, allowedRotations, x) {
  const allowed = Array.isArray(allowedRotations) && allowedRotations.length ? allowedRotations.map(Number) : [0, 90, 180, 270];
  const rotation = Number(value);
  if (allowed.includes(rotation)) return rotation;
  if (allowed.length === 2 && allowed.includes(90) && allowed.includes(270)) return legacySideRotation(x);
  return allowed.includes(0) ? 0 : allowed[0];
}

module.exports = {
  validateDesign,
  validateWiring,
  createShipBlueprintSnapshot,
  createGeneratedPowerWiring,
  isConnected,
  normalizeShipDesignSnapshot,
  normalizeRotation,
  normalizePartRotation
};
