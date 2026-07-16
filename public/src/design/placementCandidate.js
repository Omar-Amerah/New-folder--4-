import { isConnected, isOutOfBounds, isOverlapping, explainConnectionProblem } from "./blueprintValidation.js";
import { getOccupiedCells } from "./footprint.js";
import { isRotatablePart } from "./parts.js";
import { maneuverThrusterAutoRotation, normalizeRotation } from "./rotation.js";
import { makeDesignPart } from "./blueprintStorage.js";

export const GRID_SIZE = 15;

function cellsFor(part, catalogue) {
  const stat = catalogue?.[part.type] || catalogue?.frame || {};
  return getOccupiedCells(part.x, part.y, stat.footprint || { width: 1, height: 1 }, part.rotation || 0);
}

export function findPartAtCell(design, catalogue, x, y) {
  for (const part of design || []) {
    if (cellsFor(part, catalogue).some(cell => cell.x === x && cell.y === y)) return part;
  }
  return null;
}

function cellKey(cell) { return `${cell.x},${cell.y}`; }

export function createPlacementCandidate({ grid, componentType, rotation = 0, design = [], catalogue = {}, mode = "replace" }) {
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
  const part = makeDesignPart(targetX, targetY, type, normalizedRotation);
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
  } else if (!isConnected(nextDesign)) {
    reasonCode = "disconnected";
    message = explainConnectionProblem(baseDesign, type, targetX, targetY, part.rotation);
  } else if (type === "maneuverThruster") {
    const idx = nextDesign.indexOf(part);
    const exhaust = globalThis.EngineExhaustRules?.analyze?.(nextDesign, catalogue);
    if (exhaust && !exhaust.validEngineIndices.has(idx)) {
      reasonCode = "blocked-exhaust";
      message = "Lateral exhaust path blocked";
    }
  }

  return {
    ok: !reasonCode,
    reasonCode,
    message,
    part,
    normalizedPart: part,
    normalizedRotation: part.rotation,
    occupiedCells,
    overlaps,
    outOfBoundsCells,
    existing,
    replacing: Boolean(existing && mode !== "add"),
    nextDesign,
    baseDesign
  };
}
