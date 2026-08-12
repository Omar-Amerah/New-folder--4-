import { dom } from "../dom.js";
import { state } from "../../state.js";
import { PART_DEFS, PART_STATS, isFlippablePart, isRotatablePart, partIconMarkup } from "../../design/parts.js";
import { findPartAtCell } from "../../design/placementCandidate.js";
import { normalizeRotation } from "../../design/rotation.js";
import { getFootprintBounds, getOccupiedCells } from "../../design/footprint.js";
import { coolantConnectionMasks } from "../../design/coolantLayout.js";
import { disconnectedComponentIndexSet } from "./validationPresentation.js";

export const GRID_SIZE = 15;

export function findPartAt(x, y) {
  return findPartAtCell(state.design, PART_STATS, x, y);
}

function blueprintCellTitle(part, partIndex, exhaustAnalysis = null) {
  if (!part) return "Empty";
  const blocked = exhaustAnalysis?.blockedEngineIndices?.has(partIndex);
  if (blocked) return "Blocked exhaust : engine provides no thrust.";
  const flipHint = isFlippablePart(part.type) ? `${part.flipped === true ? " | mirrored" : ""} | press F to mirror` : "";
  return `${PART_DEFS[part.type].name}${isRotatablePart(part.type) ? ` | ${normalizeRotation(part.rotation, PART_STATS[part.type]?.allowedRotations, part.x)} deg | Select ${PART_DEFS[part.type].name} and click again, or hover and press R to rotate${flipHint}` : ""}`;
}

export function restoreBlueprintCellTitle(cell, part, partIndex, exhaustAnalysis = null) {
  cell.title = blueprintCellTitle(part, partIndex, exhaustAnalysis);
  cell.removeAttribute("aria-label");
}

export function renderBaseBlueprintGridLayout() {
  dom.grid.textContent = "";
  const exhaustAnalysis = globalThis.EngineExhaustRules.analyze(state.design, PART_STATS);
  const disconnectedIndices = disconnectedComponentIndexSet(state.design);
  // Heat Pipes are one non-rotatable part whose art follows its live orthogonal
  // connections, so the placed shape has to be recomputed with the design.
  const coolantMasks = coolantConnectionMasks(state.design, PART_STATS);

  // Find which cells are already covered by the extension of some component
  const coveredCells = new Set();
  const byCell = new Map();
  const ownerByCell = new Map();
  for (let partIndex = 0; partIndex < state.design.length; partIndex += 1) {
    const part = state.design[partIndex];
    byCell.set(`${part.x},${part.y}`, part);
    const stat = PART_STATS[part.type] || PART_STATS.frame;
    const footprint = stat.footprint || { width: 1, height: 1 };
    const cells = getOccupiedCells(part.x, part.y, footprint, part.rotation || 0, part.flipped === true);
    for (const c of cells) {
      ownerByCell.set(`${c.x},${c.y}`, { part, partIndex });
      if (c.x !== part.x || c.y !== part.y) {
        coveredCells.add(`${c.x},${c.y}`);
      }
    }
  }

  for (let y = 0; y < GRID_SIZE; y += 1) {
    for (let x = 0; x < GRID_SIZE; x += 1) {
      const isCovered = coveredCells.has(`${x},${y}`);
      if (isCovered) continue; // Skip rendering separate cell for extensions

      const part = byCell.get(`${x},${y}`);
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = `build-cell${part ? ` occupied ${part.type}` : ""}`;
      const partIndex = part ? state.design.indexOf(part) : -1;
      if (part && disconnectedIndices.has(partIndex)) {
        cell.classList.add("disconnected-component");
        cell.setAttribute("aria-invalid", "true");
      }

      // Anchor stays at (x,y); the visual box is drawn from the rotated
      // footprint's top-left bound so rotated multi-tile parts extend correctly.
      let originX = x;
      let originY = y;
      let width = 1;
      let height = 1;

      if (part) {
        const stat = PART_STATS[part.type] || PART_STATS.frame;
        const footprint = stat.footprint || { width: 1, height: 1 };
        const bounds = getFootprintBounds(part.x, part.y, footprint, part.rotation || 0, part.flipped === true);
        originX = bounds.minX;
        originY = bounds.minY;
        width = bounds.width;
        height = bounds.height;
      }

      // We position using 1-based indexing for CSS grid lines
      cell.style.gridColumn = `${originX + 1} / span ${width}`;
      cell.style.gridRow = `${originY + 1} / span ${height}`;

      restoreBlueprintCellTitle(cell, part, part ? state.design.indexOf(part) : -1, exhaustAnalysis);
      if (part) {
        const blockedExhaust = exhaustAnalysis.blockedEngineIndices.has(partIndex);
        const rotation = normalizeRotation(part.rotation, PART_STATS[part.type]?.allowedRotations, part.x);
        const exhaustWarning = blockedExhaust ? `<span class="blocked-exhaust-warning" title="Blocked exhaust : engine provides no thrust." aria-label="Blocked exhaust : engine provides no thrust.">!</span>` : "";
        const droneBadge = part.type === "droneBay" ? `<span class="drone-bay-type-badge drone-${part.droneType || "unconfigured"}" aria-label="${part.droneType ? `${part.droneType} drones` : "Drone type not configured"}">${part.droneType ? part.droneType.charAt(0).toUpperCase() + part.droneType.slice(1) : "!"}</span>` : "";
        cell.innerHTML = `${partIconMarkup(part.type, "build-glyph", rotation, part.flipped === true, coolantMasks[partIndex])}${droneBadge}${exhaustWarning}`;
        cell.dataset.partIndex = String(partIndex);
      }
      cell.dataset.x = String(x);
      cell.dataset.y = String(y);
      dom.grid.appendChild(cell);
    }
  }
}

export function positionGridOverlay(overlay, x, y, width, height) {
  overlay.classList.add("build-grid-overlay");
  const column = gridOverlayAxisPlacement(x, width);
  const row = gridOverlayAxisPlacement(y, height);
  overlay.hidden = !column || !row;
  overlay.style.gridColumn = column || "1 / 1";
  overlay.style.gridRow = row || "1 / 1";
  overlay.style.left = "";
  overlay.style.top = "";
  overlay.style.width = "";
  overlay.style.height = "";
  overlay.style.alignSelf = "";
  overlay.style.justifySelf = "";
}

function gridOverlayAxisPlacement(origin, span) {
  if (origin >= 0 && origin + span <= GRID_SIZE) return `${origin + 1} / span ${span}`;
  const visibleStart = Math.max(0, origin);
  const visibleEnd = Math.min(GRID_SIZE, origin + span);
  return visibleEnd > visibleStart ? `${visibleStart + 1} / ${visibleEnd + 1}` : null;
}

export function positionGridCellRelativeOverlay(overlay, x, y, { width, height, left, top }) {
  positionGridOverlay(overlay, x, y, 1, 1);
  overlay.style.width = width;
  overlay.style.height = height;
  overlay.style.left = left;
  overlay.style.top = top;
  overlay.style.alignSelf = "start";
  overlay.style.justifySelf = "start";
}

function cssPx(value, fallback) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : fallback;
}

export function gridCellFromPointer(clientX, clientY) {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  if (typeof dom.grid.getBoundingClientRect !== "function") return null;
  const rect = dom.grid.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) return null;
  const computed = typeof window !== "undefined" && typeof window.getComputedStyle === "function"
    ? window.getComputedStyle(dom.grid)
    : null;
  const gapX = cssPx(computed?.columnGap || computed?.gap, 2);
  const gapY = cssPx(computed?.rowGap || computed?.gap, 2);
  const insetLeft = cssPx(computed?.borderLeftWidth, 1) + cssPx(computed?.paddingLeft, 8);
  const insetRight = cssPx(computed?.borderRightWidth, 1) + cssPx(computed?.paddingRight, 8);
  const insetTop = cssPx(computed?.borderTopWidth, 1) + cssPx(computed?.paddingTop, 8);
  const insetBottom = cssPx(computed?.borderBottomWidth, 1) + cssPx(computed?.paddingBottom, 8);
  const contentWidth = rect.width - insetLeft - insetRight;
  const contentHeight = rect.height - insetTop - insetBottom;
  const cellWidth = (contentWidth - gapX * (GRID_SIZE - 1)) / GRID_SIZE;
  const cellHeight = (contentHeight - gapY * (GRID_SIZE - 1)) / GRID_SIZE;
  if (!(cellWidth > 0 && cellHeight > 0)) return null;
  const localX = clientX - rect.left - insetLeft;
  const localY = clientY - rect.top - insetTop;
  const pitchX = cellWidth + gapX;
  const pitchY = cellHeight + gapY;
  if ((localX % pitchX) > cellWidth || (localY % pitchY) > cellHeight) return null;
  const x = Math.floor(localX / pitchX);
  const y = Math.floor(localY / pitchY);
  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return null;
  return { x, y };
}

export function recordBlueprintDesignerGridSize() {
  const stage = document.getElementById("buildGridStage");
  const grid = document.getElementById("buildGrid");
  const stageRect = stage?.getBoundingClientRect();
  const gridRect = grid?.getBoundingClientRect();
  return {
    view: state.blueprintView,
    stageWidth: stageRect?.width ?? 0,
    stageHeight: stageRect?.height ?? 0,
    gridWidth: gridRect?.width ?? 0,
    gridHeight: gridRect?.height ?? 0
  };
}
