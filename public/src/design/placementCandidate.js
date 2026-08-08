import { isOutOfBounds, isOverlapping } from "./blueprintValidation.js";
import { getOccupiedCells } from "./footprint.js";
import { isRotatablePart } from "./parts.js";
import { maneuverThrusterAutoRotation, normalizeRotation } from "./rotation.js";
import { makeDesignPart } from "./blueprintStorage.js";
import "../shared/componentTransform.js";

const ComponentTransform = globalThis.ComponentTransform;

export const GRID_SIZE = 15;

function cellsFor(part, catalogue) {
  const stat = catalogue?.[part.type] || catalogue?.frame || {};
  return getOccupiedCells(part.x, part.y, stat.footprint || { width: 1, height: 1 }, part.rotation || 0, part.flipped === true);
}

export function findPartAtCell(design, catalogue, x, y) {
  for (const part of design || []) {
    if (cellsFor(part, catalogue).some(cell => cell.x === x && cell.y === y)) return part;
  }
  return null;
}

function cellKey(cell) { return `${cell.x},${cell.y}`; }

export function createPlacementCandidate({ grid, componentType, rotation = 0, flipped = false, design = [], catalogue = {}, mode = "replace" }) {
  const x = Number(grid?.x);
  const y = Number(grid?.y);
  const type = String(componentType || "");
  const existing = Number.isFinite(x) && Number.isFinite(y) ? findPartAtCell(design, catalogue, x, y) : null;
  if (!catalogue[type]) return { ok: false, reasonCode: "unknown-component", message: "Unknown component", existing: null, occupiedCells: [], overlaps: [], outOfBoundsCells: [] };
  if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, reasonCode: "invalid-cell", message: "Invalid grid cell", existing, occupiedCells: [], overlaps: [], outOfBoundsCells: [] };
  if (existing?.type === "core") return { ok: false, reasonCode: "core-replace", message: "The core cannot be replaced", existing, occupiedCells: [], overlaps: [], outOfBoundsCells: [] };

  const editingSamePart = existing?.type === type;
  const targetX = editingSamePart ? existing.x : x;
  const targetY = editingSamePart ? existing.y : y;
  const normalizedRotation = type === "maneuverThruster" ? maneuverThrusterAutoRotation(targetX) : isRotatablePart(type) ? normalizeRotation(rotation, catalogue[type]?.allowedRotations, targetX) : 0;
  // A flip the catalogue does not offer is dropped here, so the preview, the
  // validity check and the placed part all describe the same transform.
  const normalizedFlip = ComponentTransform.normalizePartFlip(catalogue[type], flipped);
  const part = makeDesignPart(targetX, targetY, type, normalizedRotation, normalizedFlip);
  const occupiedCells = cellsFor(part, catalogue);
  const outOfBoundsCells = occupiedCells.filter(cell => cell.x < 0 || cell.x >= GRID_SIZE || cell.y < 0 || cell.y >= GRID_SIZE);
  const baseDesign = existing && mode !== "add" ? design.filter(candidate => candidate !== existing) : [...design];
  const occupiedByOther = new Map();
  for (const other of baseDesign) {
    for (const cell of cellsFor(other, catalogue)) occupiedByOther.set(cellKey(cell), other);
  }
  const overlaps = occupiedCells
    .map(cell => ({ cell, part: occupiedByOther.get(cellKey(cell)) }))
    .filter(entry => entry.part);
  const nextDesign = existing && mode !== "add"
    ? design.map(candidate => candidate === existing ? part : candidate)
    : [...design, part];

  let reasonCode = null;
  let message = "Placement valid";
  if (outOfBoundsCells.length || isOutOfBounds(nextDesign)) {
    reasonCode = "out-of-bounds";
    message = "Outside build grid";
  } else if (overlaps.length || isOverlapping(nextDesign)) {
    reasonCode = "overlap";
    message = "Overlaps another component";
  } else {
    const shipCap = Number.isFinite(catalogue[type]?.maxPerShip)
      ? catalogue[type].maxPerShip
      : (type === "droneBay" && Number.isFinite(catalogue[type]?.droneConfig?.maxBaysPerShip)
        ? catalogue[type].droneConfig.maxBaysPerShip
        : null);
    if (Number.isFinite(shipCap) && nextDesign.filter((candidate) => candidate.type === type).length > shipCap) {
      reasonCode = "max-per-ship";
      message = `Max ${shipCap} ${catalogue[type]?.name || type} per ship`;
    } else if (type === "maneuverThruster") {
      const idx = nextDesign.indexOf(part);
      const exhaust = globalThis.EngineExhaustRules?.analyze?.(nextDesign, catalogue);
      if (exhaust && !exhaust.validEngineIndices.has(idx)) {
        reasonCode = "blocked-exhaust";
        message = "Lateral exhaust path blocked";
      }
    }
  }

  return {
    ok: !reasonCode,
    reasonCode,
    message,
    part,
    normalizedPart: part,
    normalizedRotation: part.rotation,
    normalizedFlipped: part.flipped === true,
    occupiedCells,
    overlaps,
    outOfBoundsCells,
    existing,
    replacing: Boolean(existing && mode !== "add"),
    nextDesign,
    baseDesign
  };
}
