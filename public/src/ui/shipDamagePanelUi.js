// Selected-ship damage panel: a mini rendering of the actual ship (real
// component art via the shared drawModule pipeline, blueprint-up orientation)
// with live status tints, per-component hp bars, hover/tap highlight + readout,
// the recent-damage feed, and core warnings. Everything renders from the
// client-side ship/component state already received — no extra server traffic.

import { dom, withCanvasContext } from "./dom.js";
import { state } from "../state.js";
import { PART_DEFS, PART_STATS, isRotatablePart } from "../design/parts.js";
import { getOccupiedCells } from "../design/footprint.js";
import { normalizeRotation, moduleRotationToRadians } from "../design/rotation.js";
import { drawShipStructure, drawModule, drawFootprintComponent } from "../game/componentArt.js";
import { footprintLocalPlacement } from "../game/shipGeometry.js";
import { componentHealthRatio } from "../game/shipVitals.js";
import { drawModuleDamage, drawModuleFlash } from "../game/componentDamageCanvas.js";
import { COMPONENT_HEAT_CAPACITY, COMPONENT_HEAT_RATIO, COMPONENT_HEAT_STATE, COMPONENT_HEAT_VALUE, normalizeComponentHeatTuple } from "../shared/componentHeatSnapshot.js";
import { shipHeatPercent, formatHeatPercent, checkShipHeatConsistency } from "../shared/heatDisplay.js";
import {
  componentMaxFromShip,
  componentFlash,
  partDisplayName,
  recentDamageFeed,
  activeCoreWarning,
  CRITICAL_RATIO,
  DAMAGED_RATIO
} from "../game/componentDamage.js";

const SHIP_DAMAGE_GRID_CENTER = 7;

let bound = false;
// Diagram interaction context. Tracks the selected ship by id (snapshots
// replace ship objects every frame, so object identity must never be used)
// plus the geometry needed to hit-test pointer events against the last drawn
// diagram. componentIndex is a persistent tap selection; hoverIndex is the
// transient mouse hover.
let diagramInteraction = null; // { shipId, componentIndex, hoverIndex, cellMap, cellSize, originX, originY }

const HEAT_LABELS = ["Cool", "Warm", "Hot", "Critical", "Overheated"];

function componentThermal(ship, index) {
  const data = normalizeComponentHeatTuple(ship.componentHeat?.[index]) || [];
  const part = ship.design?.[index];
  const profile = part ? globalThis.HeatRules?.profile?.(part.type, PART_STATS[part.type] || {}) : null;
  const heat = Number(data[COMPONENT_HEAT_VALUE]) || 0;
  const stateValue = Number(data[COMPONENT_HEAT_STATE]) || 0;
  const capacity = Number(data[COMPONENT_HEAT_CAPACITY]) || Number(profile?.capacity) || 0;
  const ratio = Number.isFinite(Number(data[COMPONENT_HEAT_RATIO])) && Number(data[COMPONENT_HEAT_RATIO]) > 0
    ? Number(data[COMPONENT_HEAT_RATIO])
    : capacity > 0 ? heat / capacity : 0;
  return { heat, state: stateValue, capacity, ratio: Math.max(0, ratio) };
}

function formatHeatAmount(value) {
  return Number(value).toFixed(Math.abs(value) >= 100 ? 0 : 1).replace(/\.0$/, "");
}

function renderHeatSummary(ship) {
  const summary = dom.shipHeatSummary;
  if (!summary) return;
  const heatNow = Number(ship.heatNow) || 0;
  const heatMax = Number(ship.heatMax) || 0;
  // Derive the percentage from the same stored/capacity values displayed
  // beside it so the two lines can never look mathematically impossible.
  const percentText = formatHeatPercent(shipHeatPercent(ship));
  const hot = Number(ship.hot) || 0;
  const overheated = Number(ship.overheated) || 0;
  summary.hidden = false;
  summary.innerHTML = `
    <div><span title="Aggregate stored heat across the whole ship — individual components may run hotter or cooler">Overall heat</span><strong>${percentText}</strong></div>
    <div><span>Stored</span><strong>${formatHeatAmount(heatNow)} / ${formatHeatAmount(heatMax)} H</strong></div>
    <div><span>Hot parts</span><strong>${hot}</strong></div>
    <div><span>Overheated</span><strong>${overheated}</strong></div>`;
  checkShipHeatConsistency(ship);
}

function statusFor(ratio) {
  if (ratio <= 0) return "destroyed";
  if (ratio <= CRITICAL_RATIO) return "critical";
  if (ratio < DAMAGED_RATIO) return "damaged";
  return "healthy";
}

function statusLabel(status) {
  if (status === "healthy") return "Operational";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function selectedSingleShip() {
  if (state.selectedShipIds.size !== 1) return null;
  const [id] = state.selectedShipIds;
  const ship = state.snapshot?.ships?.find((candidate) => candidate.id === id);
  if (!ship || !ship.design || !ship.chp) return null;
  return ship;
}

function validComponentIndex(ship, index) {
  return Number.isInteger(index) && index >= 0 && index < (ship?.design?.length || 0);
}

// The component index the readout/highlight should show for the current ship:
// the transient mouse hover wins over the persistent tap selection.
function activeComponentIndex(ship) {
  if (!diagramInteraction || diagramInteraction.shipId !== ship.id) return undefined;
  if (validComponentIndex(ship, diagramInteraction.hoverIndex)) return diagramInteraction.hoverIndex;
  if (validComponentIndex(ship, diagramInteraction.componentIndex)) return diagramInteraction.componentIndex;
  return undefined;
}

function readoutPlaceholder() {
  return state.shipStatusView === "heat" ? "Tap or hover a component" : "Hover a component";
}

function clearComponentReadout() {
  if (dom.shipDamageHover) dom.shipDamageHover.textContent = readoutPlaceholder();
}

// Renders the heat readout for one component from the latest ship snapshot:
// name, current heat, capacity, local percentage, heat state, and any active
// output/passive protection penalty.
function renderComponentHeatReadout(ship, index) {
  if (!dom.shipDamageHover) return;
  const part = ship.design[index];
  const thermal = componentThermal(ship, index);
  const percentText = formatHeatPercent(Math.min(125, thermal.ratio * 100));
  const capacityText = thermal.capacity > 0 ? ` / ${formatHeatAmount(thermal.capacity)} H · ${percentText}` : " H";
  const rules = globalThis.HeatRules;
  const passive = /frame/i.test(part.type) || ["armor", "compositeArmor", "bulkhead", "weaponMount"].includes(part.type);
  const activePerf = rules?.activeOutputForState?.(thermal.state);
  const passivePerf = rules?.passiveProtectionForState?.(thermal.state);
  const perfText = passive && passivePerf != null && passivePerf < 1
    ? ` · ${Math.round(passivePerf * 100)}% protection`
    : activePerf != null && activePerf < 1 ? ` · ${Math.round(activePerf * 100)}% output` : "";
  dom.shipDamageHover.textContent = `${partDisplayName(part.type)} — ${formatHeatAmount(thermal.heat)}${capacityText} — ${HEAT_LABELS[thermal.state] || "Cool"}${perfText}`;
}

function renderComponentDamageReadout(ship, index) {
  if (!dom.shipDamageHover) return;
  const part = ship.design[index];
  if (part.type === "core") {
    dom.shipDamageHover.textContent = "Core — indestructible";
    return;
  }
  const max = componentMaxFromShip(ship, index);
  const hp = ship.chp[index] ?? 0;
  const status = statusFor(max > 0 ? hp / max : 0);
  dom.shipDamageHover.textContent = `${partDisplayName(part.type)} — ${Math.max(0, Math.round(hp))}/${Math.round(max)} — ${statusLabel(status)}`;
}

// Re-renders the component readout from the latest ship snapshot object. Used
// by both pointer/touch selection and every renderShipDamagePanel() pass so a
// value from an older snapshot can never remain on screen.
function refreshComponentReadout(ship) {
  if (!dom.shipDamageHover) return;
  const index = ship ? activeComponentIndex(ship) : undefined;
  if (!ship || index === undefined) {
    clearComponentReadout();
    return;
  }
  if (state.shipStatusView === "heat") renderComponentHeatReadout(ship, index);
  else renderComponentDamageReadout(ship, index);
}

function clearDiagramSelection() {
  if (!diagramInteraction) return;
  diagramInteraction.componentIndex = undefined;
  diagramInteraction.hoverIndex = undefined;
}

function bindOnce() {
  if (bound) return;
  bound = true;
  const canvas = dom.shipDamageCanvas;
  if (canvas) {
    // Pointer events cover mouse, touch, and pen. Taps on the diagram are a
    // deliberate selection gesture, so disable browser panning over it.
    if (canvas.style) canvas.style.touchAction = "none";
    canvas.addEventListener("pointermove", handleDiagramPointerMove);
    canvas.addEventListener("pointerdown", handleDiagramPointerDown);
    canvas.addEventListener("pointerleave", handleDiagramPointerLeave);
  }
  dom.shipDamageTab?.addEventListener("click", () => { switchStatusView("damage"); });
  dom.shipHeatTab?.addEventListener("click", () => { switchStatusView("heat"); });
}

function switchStatusView(view) {
  if (state.shipStatusView !== view) {
    state.shipStatusView = view;
    // A heat readout must not linger on the Damage tab (or vice versa).
    clearDiagramSelection();
    clearComponentReadout();
  }
  renderShipDamagePanel();
}

function diagramIndexAt(event) {
  if (!diagramInteraction) return undefined;
  const canvas = event.currentTarget;
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (canvas.width / rect.width);
  const y = (event.clientY - rect.top) * (canvas.height / rect.height);
  const gx = Math.round(SHIP_DAMAGE_GRID_CENTER + (x - diagramInteraction.originX) / diagramInteraction.cellSize);
  const gy = Math.round(SHIP_DAMAGE_GRID_CENTER + (y - diagramInteraction.originY) / diagramInteraction.cellSize);
  return diagramInteraction.cellMap.get(`${gx},${gy}`);
}

function handleDiagramPointerMove(event) {
  const ship = selectedSingleShip();
  if (!ship || !diagramInteraction || diagramInteraction.shipId !== ship.id) return;
  // Touch/pen select via deliberate taps in pointerdown; a moving finger
  // should not drag the hover readout around.
  if (event.pointerType && event.pointerType !== "mouse") return;
  const index = diagramIndexAt(event);
  const changed = diagramInteraction.hoverIndex !== index;
  diagramInteraction.hoverIndex = index;
  refreshComponentReadout(ship);
  if (changed) drawDiagram(ship);
}

function handleDiagramPointerDown(event) {
  const ship = selectedSingleShip();
  if (!ship || !diagramInteraction || diagramInteraction.shipId !== ship.id) return;
  // The diagram is a status readout: never let its taps fall through to
  // battlefield movement/selection handlers.
  event.preventDefault?.();
  event.stopPropagation?.();
  const index = diagramIndexAt(event);
  // Tapping a component selects it persistently; tapping outside clears.
  diagramInteraction.componentIndex = index;
  if (event.pointerType && event.pointerType !== "mouse") diagramInteraction.hoverIndex = undefined;
  refreshComponentReadout(ship);
  drawDiagram(ship);
}

function handleDiagramPointerLeave() {
  if (diagramInteraction) diagramInteraction.hoverIndex = undefined;
  const ship = selectedSingleShip();
  if (ship && diagramInteraction && diagramInteraction.shipId === ship.id) {
    refreshComponentReadout(ship);
    drawDiagram(ship);
  } else {
    clearComponentReadout();
  }
}

// Screen-space bounding rect of a component's occupied cells on the diagram.
function componentScreenRect(cells, cellSize, originX, originY) {
  let minGx = Infinity, minGy = Infinity, maxGx = -Infinity, maxGy = -Infinity;
  for (const cell of cells) {
    if (cell.x < minGx) minGx = cell.x;
    if (cell.y < minGy) minGy = cell.y;
    if (cell.x > maxGx) maxGx = cell.x;
    if (cell.y > maxGy) maxGy = cell.y;
  }
  const half = cellSize / 2;
  return {
    x: originX + (minGx - SHIP_DAMAGE_GRID_CENTER) * cellSize - half,
    y: originY + (minGy - SHIP_DAMAGE_GRID_CENTER) * cellSize - half,
    w: (maxGx - minGx + 1) * cellSize,
    h: (maxGy - minGy + 1) * cellSize
  };
}

function hpBarColor(ratio) {
  if (ratio <= CRITICAL_RATIO) return "#ef4444";
  if (ratio < DAMAGED_RATIO) return "#fbb040";
  return "#4ade80";
}

function heatColor(stateValue) {
  if (stateValue >= 4) return "#fff1f2";
  if (stateValue === 3) return "#ff334f";
  if (stateValue === 2) return "#ff713d";
  if (stateValue === 1) return "#fbbf24";
  return "#38bdf8";
}

// Renders the ship with its real component art (same drawModule pipeline as
// the arena), rotated so the nose points up like the blueprint grid, then
// layers status tints, hit flashes, hp bars, the core marker, and the
// hover/selection highlight on top.
function drawDiagram(ship) {
  const canvas = dom.shipDamageCanvas;
  const drawCtx = canvas?.getContext("2d");
  if (!drawCtx) return;
  drawCtx.clearRect(0, 0, canvas.width, canvas.height);

  // Occupied cells per component (blueprint grid coordinates) + bounding box.
  const cellMap = new Map();
  const cellsByIndex = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  ship.design.forEach((part, i) => {
    const footprint = PART_STATS[part.type]?.footprint || { width: 1, height: 1 };
    const cells = getOccupiedCells(part.x, part.y, footprint, part.rotation || 0);
    cellsByIndex[i] = cells;
    for (const cell of cells) {
      cellMap.set(`${cell.x},${cell.y}`, i);
      if (cell.x < minX) minX = cell.x;
      if (cell.y < minY) minY = cell.y;
      if (cell.x > maxX) maxX = cell.x;
      if (cell.y > maxY) maxY = cell.y;
    }
  });
  const cols = maxX - minX + 1;
  const rows = maxY - minY + 1;
  const pad = 18; // keeps weapon barrels and hp bars inside the frame
  const cellSize = Math.max(6, Math.floor(Math.min((canvas.width - pad) / cols, (canvas.height - pad) / rows)));
  // Ship-grid origin (cell 7,7 centre) positioned so the design bbox is centred.
  const originX = canvas.width / 2 - ((minX + maxX) / 2 - SHIP_DAMAGE_GRID_CENTER) * cellSize;
  const originY = canvas.height / 2 - ((minY + maxY) / 2 - SHIP_DAMAGE_GRID_CENTER) * cellSize;
  // Snapshots replace ship objects each frame, so interaction state is keyed
  // by ship id: the selection survives replacement objects for the same ship
  // and is dropped when a different ship (or an invalid index) shows up.
  const sameShip = diagramInteraction?.shipId === ship.id;
  const componentIndex = sameShip && validComponentIndex(ship, diagramInteraction.componentIndex)
    ? diagramInteraction.componentIndex
    : undefined;
  const hoverIndex = sameShip && validComponentIndex(ship, diagramInteraction.hoverIndex)
    ? diagramInteraction.hoverIndex
    : undefined;
  diagramInteraction = { shipId: ship.id, componentIndex, hoverIndex, cellMap, cellSize, originX, originY };

  const player = state.snapshot?.players?.find((candidate) => candidate.id === ship.ownerId);
  const trim = player?.color || "#8fd8ff";
  const now = performance.now();

  // The arena drawing helpers work in ship-local space (nose along +x); rotate
  // the whole frame -90deg so the ship renders nose-up like the build grid.
  withCanvasContext(drawCtx, () => {
    drawCtx.save();
    drawCtx.translate(originX, originY);
    drawCtx.rotate(-Math.PI / 2);
    drawShipStructure(ship.design, cellSize, trim);

    ship.design.forEach((part, i) => {
      const def = PART_DEFS[part.type] || PART_DEFS.frame;
      const place = footprintLocalPlacement(part, cellSize);
      const ratio = componentHealthRatio(ship, i);
      const destroyed = ratio !== null && ratio <= 0;
      const halfLong = (place.tilesLong * cellSize) / 2;
      const halfCross = (place.tilesCross * cellSize) / 2;
      drawCtx.save();
      drawCtx.translate(place.cx, place.cy);
      if (destroyed) drawCtx.globalAlpha *= 0.6;
      if (isRotatablePart(part.type)) {
        drawCtx.rotate(moduleRotationToRadians(normalizeRotation(part.rotation)));
        if (place.multi) {
          drawFootprintComponent({ type: part.type, unit: cellSize, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: def.color, trim });
        } else {
          drawModule({ x: 0, y: 0, size: cellSize, color: def.color, type: part.type, trim });
        }
      } else if (place.multi) {
        drawCtx.rotate(place.longAxisAngle);
        drawFootprintComponent({ type: part.type, unit: cellSize, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: def.color, trim });
      } else {
        if (part.type === "maneuverThruster") {
          drawCtx.rotate(moduleRotationToRadians(normalizeRotation(part.rotation)));
        }
        drawModule({ x: 0, y: 0, size: cellSize, color: def.color, type: part.type, trim });
      }
      if (state.shipStatusView !== "heat") {
        drawModuleDamage(drawCtx, ratio, halfLong, halfCross, now);
        drawModuleFlash(drawCtx, componentFlash(ship.id, i, now), halfLong, halfCross);
      }
      if (state.shipStatusView === "heat") {
        const thermal = componentThermal(ship, i);
        if (thermal.state > 0 || thermal.heat > 0) {
          drawCtx.fillStyle = heatColor(thermal.state);
          drawCtx.globalAlpha = thermal.state >= 3 ? 0.42 + Math.sin(now / 140) * 0.12 : Math.min(0.42, 0.08 + thermal.ratio * 0.34);
          drawCtx.fillRect(-halfLong, -halfCross, halfLong * 2, halfCross * 2);
        }
      }
      drawCtx.restore();
    });
    drawCtx.restore();
  });

  // Screen-space overlays: hp bars, core marker, hover highlight.
  ship.design.forEach((part, i) => {
    const rect = componentScreenRect(cellsByIndex[i], cellSize, originX, originY);
    if (state.shipStatusView !== "heat" && part.type === "core") {
      drawCtx.strokeStyle = "#8fd8ff";
      drawCtx.lineWidth = Math.max(1.5, cellSize * 0.1);
      drawCtx.strokeRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);
      return;
    }
    const ratio = componentHealthRatio(ship, i);
    const thermal = componentThermal(ship, i);
    if (state.shipStatusView === "heat" && thermal.heat > 0) {
      const barH = Math.max(2, cellSize * 0.14);
      const y = rect.y + rect.h - barH - 1;
      drawCtx.fillStyle = "rgba(3, 8, 15, 0.82)";
      drawCtx.fillRect(rect.x + 1, y, rect.w - 2, barH);
      drawCtx.fillStyle = heatColor(thermal.state);
      drawCtx.fillRect(rect.x + 1, y, Math.max(1, (rect.w - 2) * Math.min(1, thermal.ratio)), barH);
    } else if (state.shipStatusView !== "heat" && ratio !== null && ratio > 0 && ratio < 0.999) {
      const barH = Math.max(2, cellSize * 0.14);
      const y = rect.y + rect.h - barH - 1;
      drawCtx.fillStyle = "rgba(3, 8, 15, 0.85)";
      drawCtx.fillRect(rect.x + 1, y, rect.w - 2, barH);
      drawCtx.fillStyle = hpBarColor(ratio);
      drawCtx.fillRect(rect.x + 1, y, Math.max(1, (rect.w - 2) * ratio), barH);
    }
  });

  const highlightIndex = hoverIndex !== undefined ? hoverIndex : componentIndex;
  if (highlightIndex !== undefined && ship.design[highlightIndex]) {
    const rect = componentScreenRect(cellsByIndex[highlightIndex], cellSize, originX, originY);
    drawCtx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    drawCtx.lineWidth = 1.5;
    drawCtx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
  }
}

function renderCoreStatus(ship) {
  const label = dom.coreStatusLabel;
  if (!label) return;
  const coreIndex = ship.design.findIndex((part) => part.type === "core");
  const coreMax = coreIndex >= 0 ? componentMaxFromShip(ship, coreIndex) : 0;
  const coreHp = coreIndex >= 0 ? ship.chp[coreIndex] ?? 0 : 0;
  const warning = activeCoreWarning(ship.id, performance.now());

  let text = "";
  let tone = "";
  if (!ship.alive || coreHp <= 0) {
    text = "SHIP LOST";
    tone = "destroyed";
  } else if (coreMax > 0 && coreHp / coreMax <= CRITICAL_RATIO) {
    text = "CORE CRITICAL";
    tone = "critical";
  } else if (warning) {
    text = warning.text;
    tone = warning.text === "CORE EXPOSED" ? "exposed" : "critical";
  }

  label.hidden = !text;
  if (text) {
    label.textContent = text;
    label.dataset.tone = tone;
  }
}

function renderFeed(ship) {
  const list = dom.damageFeed;
  if (!list) return;
  const entries = recentDamageFeed(ship.id, performance.now());
  const html = entries
    .map((entry) => `<li class="damage-feed-${entry.tone}">${entry.text}</li>`)
    .reverse()
    .join("");
  if (list.dataset.rendered !== html) {
    list.dataset.rendered = html;
    list.innerHTML = html;
  }
}

export function renderShipDamagePanel() {
  const panel = dom.shipDamagePanel;
  if (!panel) return;
  bindOnce();

  const heatView = state.shipStatusView === "heat";
  dom.shipDamageTab?.classList.toggle("active", !heatView);
  dom.shipHeatTab?.classList.toggle("active", heatView);
  dom.shipDamageTab?.setAttribute("aria-selected", String(!heatView));
  dom.shipHeatTab?.setAttribute("aria-selected", String(heatView));
  if (dom.damageLegend) dom.damageLegend.hidden = heatView;
  if (dom.heatLegend) dom.heatLegend.hidden = !heatView;
  if (dom.damageFeed) dom.damageFeed.hidden = heatView;
  if (dom.shipHeatSummary) dom.shipHeatSummary.hidden = !heatView;

  const ship = selectedSingleShip();
  if (!ship) {
    if (!panel.hidden) panel.hidden = true;
    diagramInteraction = null;
    clearComponentReadout();
    if (dom.shipHeatSummary) dom.shipHeatSummary.hidden = true;
    return;
  }
  panel.hidden = false;
  drawDiagram(ship);
  // Every new snapshot re-renders the readout from the latest ship object so
  // the component line below the diagram can never show stale values.
  refreshComponentReadout(ship);
  if (heatView) {
    renderHeatSummary(ship);
    if (dom.coreStatusLabel) dom.coreStatusLabel.hidden = true;
  } else {
    renderCoreStatus(ship);
    renderFeed(ship);
  }
}
