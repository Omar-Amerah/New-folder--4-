// Blueprint validation, tile connectivity checks, component type validation, and rotation normalization.

const { PARTS } = require("./components");
const { computeStats } = require("./shipStats");
const { DEFAULT_DESIGN } = require("./config");
const { getOccupiedCells } = require("./footprint");
const RotationRules = require("../../public/src/shared/rotationRules");
const StructuralConnectivity = require("../../public/src/shared/structuralConnectivity");
const ComponentTransform = require("../../public/src/shared/componentTransform");
const DroneBayRules = require("../../public/src/shared/droneBayRules");
const DataSupportRules = require("../../public/src/shared/dataSupportRules");
const LegacyComponentRules = require("../../public/src/shared/legacyComponentRules");
const { BALANCE } = require("./balanceConfig");

function designIssue(code, inputIndex) {
  const messages = {
    "invalid-coordinate": "Invalid design: module has invalid coordinates.",
    "unknown-module": "Invalid design: unknown module type.",
    "out-of-bounds": "Invalid design: modules outside build grid.",
    overlap: "Invalid design: overlapping modules."
  };
  return { code, message: messages[code] || "Invalid design: invalid module.", inputIndex };
}

function validateDesign(input) {
  if (!Array.isArray(input)) return { ok: false, reason: "Invalid design: no blueprint was sent." };
  const source = LegacyComponentRules.migrateDesignTypes(input);
  const clean = [];
  const occupied = new Set();
  const issues = [];
  const counts = {};
  let coreCount = 0;
  let backupCoreCount = 0;

  for (let inputIndex = 0; inputIndex < source.length; inputIndex += 1) {
    const raw = source[inputIndex];
    const x = Math.trunc(Number(raw?.x));
    const y = Math.trunc(Number(raw?.y));
    const type = String(raw?.type || "");

    if (!Number.isInteger(x) || !Number.isInteger(y)) { issues.push(designIssue("invalid-coordinate", inputIndex)); continue; }
    if (!PARTS[type]) { issues.push(designIssue("unknown-module", inputIndex)); continue; }

    const rotation = normalizePartRotation(type, x, raw?.rotation);
    const flipped = normalizePartFlip(type, raw?.flipped);
    const footprint = PARTS[type].footprint || { width: 1, height: 1 };
    const cells = getOccupiedCells(x, y, footprint, rotation, flipped);
    let outOfBounds = false;
    let overlap = false;
    for (const cell of cells) {
      if (cell.x < 0 || cell.x > 14 || cell.y < 0 || cell.y > 14) outOfBounds = true;
      if (occupied.has(`${cell.x},${cell.y}`)) overlap = true;
    }
    if (outOfBounds) { issues.push(designIssue("out-of-bounds", inputIndex)); continue; }
    if (overlap) { issues.push(designIssue("overlap", inputIndex)); continue; }
    if (type === "core") coreCount += 1;
    if (type === "backupCore") backupCoreCount += 1;
    counts[type] = (counts[type] || 0) + 1;
    for (const cell of cells) occupied.add(`${cell.x},${cell.y}`);
    if (type === "droneBay") clean.push({ x, y, type, rotation: 0, droneType: DroneBayRules.normalizeDroneType(raw?.droneType) });
    // `flipped` is emitted only when true, so designs that predate mirroring
    // serialize exactly as they did before.
    else clean.push(flipped ? { x, y, type, rotation, flipped: true } : { x, y, type, rotation });
  }

  if (issues.length) return { ok: false, reason: issues[0].message, issue: issues[0], issues, modules: clean };
  if (!clean.length) return { ok: false, reason: "Invalid design: blueprint is empty." };
  if (coreCount === 0) return { ok: false, reason: "Invalid design: missing core." };
  if (coreCount > 1) return { ok: false, reason: "Invalid design: exactly one core is required." };
  if (backupCoreCount > 1) return { ok: false, reason: "Invalid design: maximum one Backup Command Core is allowed." };
  for (const type of Object.keys(counts)) {
    const limit = PARTS[type]?.maxPerShip;
    if (Number.isFinite(limit) && counts[type] > limit) {
      return { ok: false, reason: `Invalid design: at most ${limit} ${PARTS[type].name || type} per ship.` };
    }
  }
  if (!isConnected(clean)) return { ok: false, reason: "Invalid design: disconnected parts." };
  const droneValidation = DroneBayRules.validateDroneBays(clean, PARTS, { maximum: BALANCE.drones.maxBaysPerShip });
  if (!droneValidation.ok) return { ok: false, reason: `Invalid design: ${droneValidation.errors[0].message}`, issue: droneValidation.errors[0], issues: droneValidation.errors, modules: clean };

  const stats = computeStats(clean);
  return { ok: true, modules: clean, stats, issues: [] };
}

// The single boundary used by ship creation. Returning fresh clones here makes
// blueprint state a value: neither a later editor save nor another ship can
// mutate an existing ship's design snapshot.
function createShipBlueprintSnapshot(design, dataLinks = []) {
  const normalizedDesign = normalizeShipDesignSnapshot(design);
  return {
    design: normalizedDesign.map((part) => ({ ...part })),
    dataLinks: DataSupportRules.normalizeDataLinks(normalizedDesign, dataLinks, PARTS)
  };
}

// Shared with the browser designer (public/src/shared/structuralConnectivity.js)
// so client-valid designs can never be rejected by the server. validateDesign
// filters overlaps before calling this, matching the shared BFS's assumption.
function isConnected(modules) {
  return StructuralConnectivity.isConnected(modules, PARTS, getOccupiedCells);
}

function normalizeShipDesignSnapshot(design, { sourceGridSize = 15 } = {}) {
  if (sourceGridSize === 11) return migrateLegacy11DesignSnapshot(design);
  if (sourceGridSize !== 15) throw new Error(`Unsupported design source grid size: ${sourceGridSize}`);
  const source = LegacyComponentRules.migrateDesignTypes(Array.isArray(design) ? design : DEFAULT_DESIGN);
  return source.map((part) => {
    const x = Math.trunc(Number(part?.x));
    const y = Math.trunc(Number(part?.y));
    const type = String(part?.type || "");
    const rotation = normalizePartRotation(type, x, part?.rotation);
    const flipped = normalizePartFlip(type, part?.flipped);
    if (type === "droneBay") return { x, y, type, rotation: 0, droneType: DroneBayRules.normalizeDroneType(part?.droneType) };
    return flipped ? { x, y, type, rotation, flipped: true } : { x, y, type, rotation };
  });
}

function assertFootprintsFitGrid(modules, min, max, message) {
  for (const part of modules) {
    const footprint = (PARTS[part.type] || PARTS.frame).footprint || { width: 1, height: 1 };
    for (const cell of getOccupiedCells(part.x, part.y, footprint, part.rotation || 0, part.flipped === true)) {
      if (cell.x < min || cell.x > max || cell.y < min || cell.y > max) throw new Error(message);
    }
  }
}

function migrateLegacy11DesignSnapshot(design) {
  if (!Array.isArray(design)) throw new Error("Legacy 11x11 migration requires a design array.");
  const source = LegacyComponentRules.migrateDesignTypes(design);
  const normalized = source.map((part) => {
    const x = Math.trunc(Number(part?.x));
    const y = Math.trunc(Number(part?.y));
    const type = String(part?.type || "");
    if (!Number.isInteger(x) || !Number.isInteger(y) || !PARTS[type]) throw new Error("Legacy 11x11 migration requires valid module coordinates and types.");
    return { x, y, type, rotation: normalizePartRotation(type, x + 4, part?.rotation) };
  });
  const cores = normalized.filter((part) => part.type === "core");
  if (cores.length !== 1 || cores[0].x !== 3 || cores[0].y !== 3) throw new Error("Legacy 11x11 migration requires exactly one core anchored at 3,3.");
  assertFootprintsFitGrid(normalized, 0, 10, "Legacy 11x11 migration rejected: footprint leaves the 0-10 source grid.");
  const shifted = normalized.map((part) => ({ ...part, x: part.x + 4, y: part.y + 4 }));
  assertFootprintsFitGrid(shifted, 0, 14, "Legacy 11x11 migration rejected: shifted footprint leaves the 0-14 modern grid.");
  return shifted;
}

function normalizePartRotation(type, x, rotation) {
  const allowed = (PARTS[type] || {}).allowedRotations;
  return type === "maneuverThruster" ? RotationRules.maneuverThrusterAutoRotation(x) : isRotatablePart(type) ? normalizeRotation(rotation, allowed, x) : 0;
}

// A client may only claim `flipped` on a component the catalogue marks
// flippable; anything else is silently dropped rather than rejected, so an old
// or hand-edited blueprint still deploys.
function normalizePartFlip(type, flipped) {
  return ComponentTransform.normalizePartFlip(PARTS[type], flipped);
}

function isRotatablePart(type) {
  const part = PARTS[type] || {};
  if (type === "engine" || type === "compactEngine" || type === "heavyEngine" || type === "maneuverThruster" || type === "droneBay") return false;
  if (part.rotatable === false) return false;
  if (Array.isArray(part.allowedRotations) && part.allowedRotations.length) return true;
  if (part.category === "Engines") return part.thrust > 0 && part.rotationRequired === true;
  return part.category === "Weapons"
    || (part.category === "Defence" && Boolean(part.weapon))
    || part.rotationRequired === true
    || part.rotatable === true;
}

function normalizeRotation(value, allowedRotations, x) { return RotationRules.normalizeRotation(value, allowedRotations, x); }

module.exports = {
  validateDesign,
  createShipBlueprintSnapshot,
  isConnected,
  normalizeShipDesignSnapshot,
  migrateLegacy11DesignSnapshot,
  normalizeRotation,
  normalizePartRotation,
  normalizePartFlip
};
