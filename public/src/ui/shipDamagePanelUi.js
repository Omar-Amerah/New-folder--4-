// Selected-ship damage and heat panel. Power is universal at component level;
// there is no physical distribution topology to render here.

import { dom, withCanvasContext } from "./dom.js";
import { state } from "../state.js";
import { invalidatePresentation } from "../presentationInvalidation.js";
import { PART_DEFS, PART_STATS } from "../design/parts.js";
import { getOccupiedCells } from "../design/footprint.js";
import { shipLocalCoolantMasks } from "../design/coolantLayout.js";
import { drawRotatingWeaponTop } from "../game/componentArt.js";
import { drawPlacedStaticComponent } from "../game/staticComponentComposition.js";
import { isRotatingWeaponPart, authoritativeWeaponAngle } from "../game/weaponAim.js";
import { updateComponentHeatTrends, componentHeatTrend } from "../game/componentHeatTrend.js";
import { footprintLocalPlacement, footprintCorners } from "../game/shipGeometry.js";
import { componentHealthRatio } from "../game/shipVitals.js";
import { drawModuleDamage, drawModuleFlash } from "../game/componentDamageCanvas.js";
import {
  COMPONENT_HEAT_CAPACITY,
  COMPONENT_HEAT_RATIO,
  COMPONENT_HEAT_STATE,
  COMPONENT_HEAT_VALUE,
  normalizeComponentHeatTuple
} from "../shared/componentHeatSnapshot.js";
import { shipHeatPercent, formatHeatPercent, checkShipHeatConsistency } from "../shared/heatDisplay.js";
import { formatHeatEffect, getHeatEffectsForComponent } from "../shared/heatEffects.js";
import { SHIELD_RESTART_DELAY_MS } from "../shared/shieldRules.js";
import { escapeHtml } from "../shared/formatting.js";
import { send } from "../network.js";
import { notify } from "./toastUi.js";
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
const MIN_DRONE_UI_POWER = 0.05;
const DRONE_COMMAND_TIMEOUT_MS = 3000;

let bound = false;
let diagramInteraction = null;
let diagramStaticCache = null;
const pendingDroneBayCommands = new Map();

function componentThermal(ship, index) {
  const tuple = normalizeComponentHeatTuple(ship.componentHeat?.[index]) || [];
  const part = ship.design?.[index];
  const profile = part ? globalThis.HeatRules?.profile?.(part.type, PART_STATS[part.type] || {}) : null;
  const heat = Number(tuple[COMPONENT_HEAT_VALUE]) || 0;
  const stateValue = Number(tuple[COMPONENT_HEAT_STATE]) || 0;
  const capacity = Number(tuple[COMPONENT_HEAT_CAPACITY]) || Number(profile?.capacity) || 0;
  const tupleRatio = Number(tuple[COMPONENT_HEAT_RATIO]);
  const ratio = Number.isFinite(tupleRatio) && tupleRatio > 0
    ? tupleRatio
    : capacity > 0 ? heat / capacity : 0;
  return { heat, state: stateValue, capacity, ratio: Math.max(0, ratio) };
}

function formatHeatAmount(value) {
  return Number(value).toFixed(Math.abs(value) >= 100 ? 0 : 1).replace(/\.0$/, "");
}

function finiteHeatRate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function heatPresentationFor(ship, index, thermal = componentThermal(ship, index)) {
  const part = ship.design[index];
  return getHeatEffectsForComponent(part.type, PART_STATS[part.type] || {}, thermal.state, globalThis.HeatRules);
}

function heatStateText(ship, index, thermal = componentThermal(ship, index)) {
  const presentation = heatPresentationFor(ship, index, thermal);
  const effects = presentation.effects.filter((effect) => effect.isPenalty);
  const effectText = effects.length ? "; " + effects.map(formatHeatEffect).join("; ") : "";
  return "Heat: " + presentation.state + effectText;
}

function shieldRestartText(ship, part) {
  const stats = PART_STATS[part?.type] || {};
  if (!(Number(stats.shield) > 0 || Number(stats.shieldRegen) > 0)) return "";
  const rawDelayMs = Number(ship.shieldRestartDelayMs);
  const delayMs = Number.isFinite(rawDelayMs) && rawDelayMs >= 0 ? rawDelayMs : SHIELD_RESTART_DELAY_MS;
  const delayText = (delayMs / 1000).toFixed(1) + " s";
  const restartAt = Number(ship.shieldRestartAtMs);
  const simulationTime = Number(state.snapshot?.simulationTimeMs);
  const remainingMs = Number.isFinite(restartAt) && Number.isFinite(simulationTime)
    ? Math.max(0, restartAt - simulationTime)
    : null;
  if (remainingMs !== null && remainingMs > 0) {
    return "; Shield restart delay: " + delayText + "; Shield: Depleted; Restarting in: " + (remainingMs / 1000).toFixed(1) + " s";
  }
  if (Number(ship.maxShield) > 0 && Number(ship.shield) <= 0) {
    return "; Shield restart delay: " + delayText + "; Shield: Depleted";
  }
  return "; Shield restart delay: " + delayText;
}

function selectedSingleShip() {
  if (state.selectedShipIds.size !== 1) return null;
  const ids = state.selectedShipIds;
  const id = ids.values().next().value;
  const ship = state.snapshotIndex?.selectedShipById?.get(id)
    || state.snapshotIndex?.shipById?.get(id)
    || state.snapshot?.ships?.find((candidate) => candidate.id === id);
  return ship && ship.design && ship.chp ? ship : null;
}

function validComponentIndex(ship, index) {
  return Number.isInteger(index) && index >= 0 && index < (ship?.design?.length || 0);
}

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

function renderComponentHeatReadout(ship, index) {
  if (!dom.shipDamageHover) return;
  const part = ship.design[index];
  const thermal = componentThermal(ship, index);
  const hp = Number(ship.chp?.[index]) || 0;
  const heatText = heatStateText(ship, index, thermal);
  if (hp <= 0) {
    const retained = thermal.heat > 0 ? "; retained " + formatHeatAmount(thermal.heat) + " H" : "";
    dom.shipDamageHover.textContent = partDisplayName(part.type) + ": Inactive / destroyed" + retained + "; " + heatText + shieldRestartText(ship, part);
    return;
  }
  const percentText = formatHeatPercent(thermal.ratio * 100);
  const capacityText = thermal.capacity > 0 ? " / " + formatHeatAmount(thermal.capacity) + " H; " + percentText : " H";
  const trend = componentHeatTrend(index);
  const trendText = trend.direction === "warming" ? "; Warming " + formatHeatRate(trend.smoothedRate)
    : trend.direction === "cooling" ? "; Cooling " + formatHeatRate(trend.smoothedRate)
    : trend.direction === "stable" ? "; Stable" : "";
  const heatRate = finiteHeatRate(ship.powerThermal?.components?.[index]?.componentHeatRate);
  const activityText = heatRate !== null && heatRate > 0
    ? part.type === "gyroscope" || part.type === "maneuverThruster"
      ? "; Turning; generating " + formatHeatAmount(heatRate) + " H/s"
      : (Number(PART_STATS[part.type]?.thrust) || 0) > 0
        ? "; Thrusting; generating " + formatHeatAmount(heatRate) + " H/s"
        : "; Generating " + formatHeatAmount(heatRate) + " H/s"
    : "";
  dom.shipDamageHover.textContent = partDisplayName(part.type) + ": "
    + formatHeatAmount(thermal.heat) + capacityText + "; "
    + heatText + trendText + activityText + shieldRestartText(ship, part);
}

function statusFor(ratio) {
  if (ratio <= 0) return "destroyed";
  if (ratio <= CRITICAL_RATIO) return "critical";
  if (ratio < DAMAGED_RATIO) return "damaged";
  return "healthy";
}

function renderComponentDamageReadout(ship, index) {
  if (!dom.shipDamageHover) return;
  const part = ship.design[index];
  const max = componentMaxFromShip(ship, index);
  const hp = ship.chp[index] ?? 0;
  const status = statusFor(max > 0 ? hp / max : 0);
  const effectiveRange = Number(ship.weaponRanges?.[index]);
  const rangeText = Number.isFinite(effectiveRange) && effectiveRange > 0 ? "; Range " + Math.round(effectiveRange) : "";
  dom.shipDamageHover.textContent = partDisplayName(part.type) + ": "
    + Math.max(0, Math.round(hp)) + "/" + Math.round(max) + ": "
    + status[0].toUpperCase() + status.slice(1) + rangeText + "; " + heatStateText(ship, index) + shieldRestartText(ship, part);
}

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

function statusTabs() {
  return [dom.shipDamageTab, dom.shipHeatTab].filter(Boolean);
}

function statusTabView(tab) {
  return tab === dom.shipHeatTab ? "heat" : "damage";
}

function focusStatusTab(index) {
  const tabs = statusTabs();
  if (!tabs.length) return;
  tabs[((index % tabs.length) + tabs.length) % tabs.length]?.focus?.();
}

function switchStatusView(view) {
  const nextView = view === "heat" ? "heat" : "damage";
  if (state.shipStatusView !== nextView) {
    state.shipStatusView = nextView;
    clearDiagramSelection();
    clearComponentReadout();
  }
  invalidatePresentation("panel-mode");
}

function handleStatusTabKeydown(event) {
  const tabs = statusTabs();
  const index = tabs.indexOf(event.currentTarget);
  if (index < 0) return;
  if (event.key === "ArrowRight") { event.preventDefault(); focusStatusTab(index + 1); }
  else if (event.key === "ArrowLeft") { event.preventDefault(); focusStatusTab(index - 1); }
  else if (event.key === "Home") { event.preventDefault(); focusStatusTab(0); }
  else if (event.key === "End") { event.preventDefault(); focusStatusTab(tabs.length - 1); }
  else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    switchStatusView(statusTabView(event.currentTarget));
  }
}

function diagramIndexAt(event, ship = selectedSingleShip()) {
  if (!diagramInteraction) return undefined;
  const canvas = event.currentTarget;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return undefined;
  const x = (event.clientX - rect.left) * (canvas.width / rect.width);
  const y = (event.clientY - rect.top) * (canvas.height / rect.height);
  const geometry = ship
    ? shipDamageDiagramGeometry(ship, canvas.width, canvas.height)
    : diagramInteraction;
  const gx = Math.round(SHIP_DAMAGE_GRID_CENTER + (x - geometry.originX) / geometry.cellSize);
  const gy = Math.round(SHIP_DAMAGE_GRID_CENTER + (y - geometry.originY) / geometry.cellSize);
  return geometry.cellMap.get(gx + "," + gy);
}

function handleDiagramPointerMove(event) {
  const ship = selectedSingleShip();
  if (!ship || !diagramInteraction || diagramInteraction.shipId !== ship.id) return;
  if (event.pointerType && event.pointerType !== "mouse") return;
  const index = diagramIndexAt(event, ship);
  if (diagramInteraction.hoverIndex !== index) {
    diagramInteraction.hoverIndex = index;
    invalidatePresentation("telemetry-component");
  }
}

function handleDiagramPointerDown(event) {
  const ship = selectedSingleShip();
  if (!ship || !diagramInteraction || diagramInteraction.shipId !== ship.id) return;
  event.preventDefault?.();
  event.stopPropagation?.();
  // A redraw can move the scrollable side panel after the last mousemove. In
  // that case the event coordinates describe the shifted canvas, while the
  // hover state still identifies the component the pointer was over. Keep the
  // hover-to-click contract for mouse input; touch has no hover state to trust.
  const hoveredIndex = event.pointerType === "mouse" && validComponentIndex(ship, diagramInteraction.hoverIndex)
    ? diagramInteraction.hoverIndex
    : undefined;
  diagramInteraction.componentIndex = hoveredIndex ?? diagramIndexAt(event, ship);
  if (event.pointerType && event.pointerType !== "mouse") diagramInteraction.hoverIndex = undefined;
  invalidatePresentation("telemetry-component");
}

function handleDiagramPointerLeave() {
  if (diagramInteraction) diagramInteraction.hoverIndex = undefined;
  const ship = selectedSingleShip();
  if (ship && diagramInteraction?.shipId === ship.id) invalidatePresentation("telemetry-component");
  else clearComponentReadout();
}

function componentScreenRect(cells, cellSize, originX, originY) {
  let minGx = Infinity, minGy = Infinity, maxGx = -Infinity, maxGy = -Infinity;
  for (const cell of cells || []) {
    minGx = Math.min(minGx, cell.x);
    minGy = Math.min(minGy, cell.y);
    maxGx = Math.max(maxGx, cell.x);
    maxGy = Math.max(maxGy, cell.y);
  }
  if (!Number.isFinite(minGx)) return { x: originX, y: originY, w: cellSize, h: cellSize };
  const half = cellSize / 2;
  return {
    x: originX + (minGx - SHIP_DAMAGE_GRID_CENTER) * cellSize - half,
    y: originY + (minGy - SHIP_DAMAGE_GRID_CENTER) * cellSize - half,
    w: (maxGx - minGx + 1) * cellSize,
    h: (maxGy - minGy + 1) * cellSize
  };
}

export function shipDamageComponentClientPoint(shipId, componentIndex) {
  const canvas = dom.shipDamageCanvas;
  const ship = selectedSingleShip();
  if (!canvas || !ship || ship.id !== shipId || !validComponentIndex(ship, componentIndex)) return null;
  const geometry = diagramInteraction?.shipId === ship.id
    ? diagramInteraction
    : shipDamageDiagramGeometry(ship, canvas.width, canvas.height);
  const cells = geometry.cellsByIndex?.[componentIndex];
  if (!cells?.length) return null;
  const rect = componentScreenRect(cells, geometry.cellSize, geometry.originX, geometry.originY);
  const canvasRect = canvas.getBoundingClientRect();
  if (!canvasRect.width || !canvasRect.height) return null;
  const canvasX = rect.x + rect.w / 2;
  const canvasY = rect.y + rect.h / 2;
  return {
    x: canvasRect.left + canvasX * (canvasRect.width / canvas.width),
    y: canvasRect.top + canvasY * (canvasRect.height / canvas.height),
    canvasX,
    canvasY,
    componentIndex,
    componentType: ship.design[componentIndex]?.type || null,
    componentName: ship.design[componentIndex] ? partDisplayName(ship.design[componentIndex].type) : null,
    rect: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
    canvasRect: { x: canvasRect.left, y: canvasRect.top, width: canvasRect.width, height: canvasRect.height }
  };
}

export function shipDamageDiagramDiagnostics(shipId, clientX, clientY) {
  const canvas = dom.shipDamageCanvas;
  const ship = selectedSingleShip();
  const rect = canvas?.getBoundingClientRect?.();
  const geometry = ship && canvas
    ? (diagramInteraction?.shipId === ship.id ? diagramInteraction : shipDamageDiagramGeometry(ship, canvas.width, canvas.height))
    : null;
  let canvasX = null;
  let canvasY = null;
  let mappedIndex;
  if (canvas && rect?.width && rect?.height && Number.isFinite(clientX) && Number.isFinite(clientY)) {
    canvasX = (clientX - rect.left) * (canvas.width / rect.width);
    canvasY = (clientY - rect.top) * (canvas.height / rect.height);
    if (geometry) {
      const gx = Math.round(SHIP_DAMAGE_GRID_CENTER + (canvasX - geometry.originX) / geometry.cellSize);
      const gy = Math.round(SHIP_DAMAGE_GRID_CENTER + (canvasY - geometry.originY) / geometry.cellSize);
      mappedIndex = geometry.cellMap?.get(gx + "," + gy);
    }
  }
  return {
    ready: !!(canvas && ship && geometry && ship.id === shipId),
    shipId: ship?.id || null,
    requestedShipId: shipId,
    canvasX,
    canvasY,
    mappedIndex: mappedIndex ?? null,
    interaction: geometry ? {
      shipId: geometry.shipId || ship?.id || null,
      componentIndex: geometry.componentIndex,
      hoverIndex: geometry.hoverIndex,
      cellSize: geometry.cellSize,
      originX: geometry.originX,
      originY: geometry.originY,
      bounds: geometry.bounds
    } : null
  };
}

function projectShipLocalToDiagram(point) {
  return { x: point.y, y: -point.x };
}

function componentFootprintGeometry(part, unit) {
  const place = footprintLocalPlacement(part, unit);
  const halfLong = place.tilesLong * unit / 2;
  const halfCross = place.tilesCross * unit / 2;
  const corners = footprintCorners(place, halfLong, halfCross).slice(0, 4);
  const cells = getOccupiedCells(part.x, part.y, PART_STATS[part.type]?.footprint || { width: 1, height: 1 }, part.rotation || 0);
  return { place, cells, diagramCorners: corners.map(projectShipLocalToDiagram) };
}

function includePoint(bounds, point) {
  bounds.minX = Math.min(bounds.minX, point.x);
  bounds.minY = Math.min(bounds.minY, point.y);
  bounds.maxX = Math.max(bounds.maxX, point.x);
  bounds.maxY = Math.max(bounds.maxY, point.y);
}

function shipDamageDiagramGeometry(ship, canvasWidth, canvasHeight, pad) {
  const padding = pad ?? 18;
  const cellMap = new Map();
  const cellsByIndex = [];
  const footprintByIndex = [];
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  ship.design.forEach((part, index) => {
    const geometry = componentFootprintGeometry(part, 1);
    cellsByIndex[index] = geometry.cells;
    footprintByIndex[index] = geometry;
    for (const cell of geometry.cells) cellMap.set(cell.x + "," + cell.y, index);
    for (const corner of geometry.diagramCorners) includePoint(bounds, corner);
  });
  if (!ship.design.length || !Number.isFinite(bounds.minX)) {
    bounds.minX = bounds.minY = -0.5;
    bounds.maxX = bounds.maxY = 0.5;
  }
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const cellSize = Math.max(6, Math.floor(Math.min((canvasWidth - padding * 2) / width, (canvasHeight - padding * 2) / height)));
  const originX = canvasWidth / 2 - (bounds.minX + bounds.maxX) / 2 * cellSize;
  const originY = canvasHeight / 2 - (bounds.minY + bounds.maxY) / 2 * cellSize;
  return { cellMap, cellsByIndex, footprintByIndex, bounds, cellSize, originX, originY, pad: padding };
}

function staticDiagramLayer(ship, canvas, trim) {
  const key = [ship.id, ship.designRevision || 0, canvas.width, canvas.height, trim].join("|");
  if (diagramStaticCache?.key === key) return diagramStaticCache;
  const geometry = shipDamageDiagramGeometry(ship, canvas.width, canvas.height);
  const layer = typeof document !== "undefined" && document.createElement ? document.createElement("canvas") : null;
  if (layer) {
    layer.width = canvas.width;
    layer.height = canvas.height;
    const context = layer.getContext?.("2d");
    if (context) {
      withCanvasContext(context, () => {
        context.save();
        context.translate(geometry.originX, geometry.originY);
        context.rotate(-Math.PI / 2);
        const coolantMasks = shipLocalCoolantMasks(ship.design, PART_STATS);
        ship.design.forEach((part, index) => {
          const def = PART_DEFS[part.type] || PART_DEFS.frame;
          const place = footprintLocalPlacement(part, geometry.cellSize);
          drawPlacedStaticComponent(context, {
            part,
            place,
            unit: geometry.cellSize,
            color: def.color,
            trim,
            connectionMask: coolantMasks[index]
          });
        });
        context.restore();
      });
    }
  }
  diagramStaticCache = { key, layer, geometry };
  const diagnostics = state.presentationDiagnostics;
  if (diagnostics) diagnostics.selectedStaticGeometryBuildCount = (diagnostics.selectedStaticGeometryBuildCount || 0) + 1;
  return diagramStaticCache;
}

function hpBarColor(ratio) {
  if (ratio <= CRITICAL_RATIO) return "#ef4444";
  if (ratio < DAMAGED_RATIO) return "#fbb040";
  return "#4ade80";
}

const HEAT_STOPS = [
  [0, "#38d5ff"], [0.12, "#38bdf8"], [0.25, "#ff7043"],
  [0.42, "#ff3b3b"], [0.68, "#ff183f"], [0.86, "#ed0038"], [1, "#b80024"]
];

function hexToRgb(hex) {
  const number = parseInt(hex.slice(1), 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

function heatColor(ratio) {
  const value = Math.max(0, Math.min(1, Number(ratio) || 0));
  for (let index = 1; index < HEAT_STOPS.length; index += 1) {
    const [at, color] = HEAT_STOPS[index];
    if (value <= at) {
      const [previousAt, previousColor] = HEAT_STOPS[index - 1];
      const t = (value - previousAt) / Math.max(0.0001, at - previousAt);
      const a = hexToRgb(previousColor);
      const b = hexToRgb(color);
      return "rgb(" + Math.round(a[0] + (b[0] - a[0]) * t) + "," + Math.round(a[1] + (b[1] - a[1]) * t) + "," + Math.round(a[2] + (b[2] - a[2]) * t) + ")";
    }
  }
  return "#b80024";
}

function makeHeatGradient(context, x, width) {
  const gradient = context.createLinearGradient(x, 0, x + width, 0);
  for (const stop of HEAT_STOPS) gradient.addColorStop(stop[0], stop[1]);
  return gradient;
}

function formatHeatRate(rate) {
  const value = Number(rate) || 0;
  return (value > 0 ? "+" : "-") + Math.abs(value).toFixed(1) + " H/s";
}

function drawDiagram(ship) {
  const canvas = dom.shipDamageCanvas;
  const drawContext = canvas?.getContext("2d");
  if (!drawContext) return;
  drawContext.clearRect(0, 0, canvas.width, canvas.height);
  const player = state.snapshot?.players?.find((candidate) => candidate.id === ship.ownerId);
  const trim = player?.color || "#8fd8ff";
  const staticLayer = staticDiagramLayer(ship, canvas, trim);
  if (staticLayer.layer) drawContext.drawImage(staticLayer.layer, 0, 0);
  const geometry = staticLayer.geometry;
  const cellMap = geometry.cellMap;
  const cellsByIndex = geometry.cellsByIndex;
  const cellSize = geometry.cellSize;
  const originX = geometry.originX;
  const originY = geometry.originY;
  const sameShip = diagramInteraction?.shipId === ship.id;
  const componentIndex = sameShip && validComponentIndex(ship, diagramInteraction.componentIndex) ? diagramInteraction.componentIndex : undefined;
  const hoverIndex = sameShip && validComponentIndex(ship, diagramInteraction.hoverIndex) ? diagramInteraction.hoverIndex : undefined;
  diagramInteraction = { shipId: ship.id, componentIndex, hoverIndex, cellMap, cellsByIndex, cellSize, originX, originY, bounds: geometry.bounds };
  const now = performance.now();
  withCanvasContext(drawContext, () => {
    drawContext.save();
    drawContext.translate(originX, originY);
    drawContext.rotate(-Math.PI / 2);
    ship.design.forEach((part, index) => {
      const def = PART_DEFS[part.type] || PART_DEFS.frame;
      const place = footprintLocalPlacement(part, cellSize);
      const ratio = componentHealthRatio(ship, index);
      const destroyed = ratio !== null && ratio <= 0;
      const halfLong = place.tilesLong * cellSize / 2;
      const halfCross = place.tilesCross * cellSize / 2;
      drawContext.save();
      if (isRotatingWeaponPart(part.type)) {
        drawContext.save();
        drawContext.translate(place.cx, place.cy);
        drawContext.rotate(authoritativeWeaponAngle(ship, index, part));
        // This panel shows a live ship, so a charge-driven mount gets its real
        // reported progress rather than the resting picture the palette uses.
        const charge = ship.weaponCharge?.[index];
        drawRotatingWeaponTop({
          type: part.type,
          unit: cellSize,
          tilesLong: place.tilesLong,
          tilesCross: place.tilesCross,
          color: def.color,
          chargeProgress: Number.isFinite(charge) ? charge : null
        });
        drawContext.restore();
      }
      drawContext.translate(place.cx, place.cy);
      drawContext.rotate(place.longAxisAngle);
      if (state.shipStatusView === "damage") {
        drawModuleDamage(drawContext, ratio, halfLong, halfCross, now);
        drawModuleFlash(drawContext, componentFlash(ship.id, index, now), halfLong, halfCross);
      }
      if (state.shipStatusView === "heat" && !destroyed) {
        const thermal = componentThermal(ship, index);
        if (thermal.heat > 0) {
          drawContext.fillStyle = heatColor(thermal.ratio);
          drawContext.globalAlpha = Math.min(0.58, 0.08 + thermal.ratio * 0.5);
          drawContext.fillRect(-halfLong, -halfCross, halfLong * 2, halfCross * 2);
        }
      }
      drawContext.restore();
    });
    drawContext.restore();
  });
  ship.design.forEach((part, index) => {
    const rect = componentScreenRect(cellsByIndex[index], cellSize, originX, originY);
    if (state.shipStatusView === "damage" && part.type === "core") {
      drawContext.strokeStyle = "#8fd8ff";
      drawContext.lineWidth = Math.max(1.5, cellSize * 0.1);
      drawContext.strokeRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);
      return;
    }
    const ratio = componentHealthRatio(ship, index);
    const thermal = componentThermal(ship, index);
    if (state.shipStatusView === "heat" && ratio > 0 && thermal.heat > 0) {
      const barHeight = Math.max(2, cellSize * 0.14);
      const y = rect.y + rect.h - barHeight - 1;
      drawContext.fillStyle = "rgba(3, 8, 15, 0.82)";
      drawContext.fillRect(rect.x + 1, y, rect.w - 2, barHeight);
      drawContext.save();
      drawContext.beginPath();
      drawContext.rect(rect.x + 1, y, Math.max(1, (rect.w - 2) * Math.min(1, thermal.ratio)), barHeight);
      drawContext.clip();
      drawContext.fillStyle = makeHeatGradient(drawContext, rect.x + 1, rect.w - 2);
      drawContext.fillRect(rect.x + 1, y, rect.w - 2, barHeight);
      drawContext.restore();
      if (thermal.ratio >= 0.86) {
        drawContext.strokeStyle = "rgba(255,24,63,.55)";
        drawContext.strokeRect(rect.x + 1, y, rect.w - 2, barHeight);
      }
      const trend = componentHeatTrend(index);
      if (trend.direction === "warming" || trend.direction === "cooling") {
        const warming = trend.direction === "warming";
        const cx = Math.min(canvas.width - 8, Math.max(8, rect.x + rect.w / 2));
        const ty = Math.min(canvas.height - 10, Math.max(10, rect.y + 8));
        drawContext.fillStyle = warming ? "#ffb020" : "#38d5ff";
        drawContext.strokeStyle = "rgba(0,0,0,.75)";
        drawContext.lineWidth = 2;
        drawContext.beginPath();
        if (warming) {
          drawContext.moveTo(cx, ty - 6);
          drawContext.lineTo(cx - 6, ty + 5);
          drawContext.lineTo(cx + 6, ty + 5);
        } else {
          drawContext.moveTo(cx, ty + 6);
          drawContext.lineTo(cx - 6, ty - 5);
          drawContext.lineTo(cx + 6, ty - 5);
        }
        drawContext.closePath();
        drawContext.stroke();
        drawContext.fill();
        if (rect.w > cellSize * 1.5) {
          const label = formatHeatRate(trend.smoothedRate).replace(" H/s", "");
          drawContext.font = "900 " + Math.max(8, Math.min(11, cellSize * 0.28)) + "px system-ui";
          const textWidth = drawContext.measureText(label).width + 8;
          const x = Math.min(canvas.width - textWidth - 2, Math.max(2, cx + 8));
          drawContext.fillStyle = "rgba(3,8,15,.82)";
          drawContext.fillRect(x, ty - 8, textWidth, 14);
          drawContext.fillStyle = warming ? "#ffd17a" : "#9befff";
          drawContext.fillText(label, x + 4, ty + 3);
        }
      }
    } else if (state.shipStatusView === "damage" && ratio !== null && ratio > 0 && ratio < 0.999) {
      const barHeight = Math.max(2, cellSize * 0.14);
      const y = rect.y + rect.h - barHeight - 1;
      drawContext.fillStyle = "rgba(3, 8, 15, 0.85)";
      drawContext.fillRect(rect.x + 1, y, rect.w - 2, barHeight);
      drawContext.fillStyle = hpBarColor(ratio);
      drawContext.fillRect(rect.x + 1, y, Math.max(1, (rect.w - 2) * ratio), barHeight);
    }
  });
  const highlightIndex = hoverIndex !== undefined ? hoverIndex : componentIndex;
  if (highlightIndex !== undefined && ship.design[highlightIndex]) {
    const rect = componentScreenRect(cellsByIndex[highlightIndex], cellSize, originX, originY);
    drawContext.strokeStyle = "rgba(255, 255, 255, 0.85)";
    drawContext.lineWidth = 1.5;
    drawContext.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
  }
}

function telemetryReadout(ship) {
  const thermal = ship.powerThermal;
  const hasSummary = thermal && typeof thermal === "object" && (
    Number.isFinite(Number(thermal.componentHeatRate)) || Number.isFinite(Number(thermal.totalHeatRate))
  );
  const requested = state.desiredTelemetryFocusShipId === ship.id;
  const status = hasSummary ? "available" : requested ? "loading" : "unavailable";
  const rateText = (value) => {
    if (status === "loading") return "Loading telemetry...";
    if (status === "unavailable") return "Unavailable";
    const number = finiteHeatRate(value);
    return number === null ? "Unavailable" : formatHeatAmount(number) + " H/s";
  };
  let hottest = "None";
  if (status === "loading") hottest = "Loading telemetry...";
  else if (status === "unavailable") hottest = "Unavailable";
  else if (Number.isInteger(thermal?.hottestComponentIndex) && ship.design?.[thermal.hottestComponentIndex]) {
    hottest = partDisplayName(ship.design[thermal.hottestComponentIndex].type) + " #" + thermal.hottestComponentIndex;
  }
  return { status, rateText, hottest, componentHeatRate: thermal?.componentHeatRate, totalHeatRate: thermal?.totalHeatRate, netHeatRate: thermal?.netHeatRate, cooling: thermal?.cooling };
}

function renderHeatSummary(ship) {
  const summary = dom.shipHeatSummary;
  if (!summary) return;
  const heatNow = Number(ship.heatNow) || 0;
  const heatMax = Number(ship.heatMax) || 0;
  const percentText = formatHeatPercent(shipHeatPercent(ship));
  const hot = Number(ship.hot) || 0;
  const overheated = Number(ship.overheated) || 0;
  const heatState = overheated > 0 ? "Overheating" : hot > 0 ? "Heating" : "Stable";
  const readout = telemetryReadout(ship);
  let fastestHeat = null;
  ship.design?.forEach((part, index) => {
    const trend = componentHeatTrend(index);
    if (trend.direction === "warming" && (!fastestHeat || trend.smoothedRate > fastestHeat.rate)) {
      fastestHeat = { index, rate: trend.smoothedRate, name: partDisplayName(part.type) };
    }
  });
  summary.hidden = false;
  summary.innerHTML = "<div><span title=\"Aggregate stored heat across the whole ship\">Overall heat</span><strong>" + percentText + "</strong></div>"
    + "<div><span>Stored</span><strong>" + formatHeatAmount(heatNow) + " / " + formatHeatAmount(heatMax) + " H</strong></div>"
    + "<div><span>Component heat rate</span><strong>" + readout.rateText(readout.componentHeatRate) + "</strong></div>"
    + "<div><span>Total / net heat rate</span><strong>" + readout.rateText(readout.totalHeatRate) + " / " + readout.rateText(readout.netHeatRate) + "</strong></div>"
    + "<div><span>Cooling</span><strong>" + readout.rateText(readout.cooling) + "</strong></div>"
    + "<div><span>Heat state</span><strong>" + heatState + "</strong></div>"
    + "<div><span>Hottest component</span><strong>" + escapeHtml(readout.hottest) + "</strong></div>"
    + "<div><span>Hot parts</span><strong>" + hot + "</strong></div>"
    + "<div><span>Overheated</span><strong>" + overheated + "</strong></div>"
    + (readout.status === "unavailable" ? "<p class=\"heat-telemetry-note\">Detailed live telemetry is unavailable for this ship.</p>" : "")
    + (fastestHeat ? "<button type=\"button\" class=\"heat-trend-jump\" data-component-index=\"" + fastestHeat.index + "\"><span>Fastest heating</span><strong>" + escapeHtml(fastestHeat.name) + " " + formatHeatRate(fastestHeat.rate) + "</strong></button>" : "");
  summary.querySelectorAll(".heat-trend-jump").forEach((button) => button.addEventListener("click", () => {
    diagramInteraction = diagramInteraction || { shipId: ship.id };
    diagramInteraction.shipId = ship.id;
    diagramInteraction.componentIndex = Number(button.dataset.componentIndex);
    diagramInteraction.hoverIndex = undefined;
    refreshComponentReadout(ship);
    drawDiagram(ship);
  }));
  checkShipHeatConsistency(ship);
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
  } else if (ship.commandState === "backupCore") {
    if (ship.emergencyReserveUntil && performance.now() < ship.emergencyReserveUntil) {
      text = "EMERGENCY RESERVE (" + Math.max(0, (ship.emergencyReserveUntil - performance.now()) / 1000).toFixed(1) + "s)";
      tone = "critical";
    } else {
      text = "BACKUP COMMAND ACTIVE";
      tone = "exposed";
    }
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
  const html = recentDamageFeed(ship.id, performance.now())
    .map((entry) => "<li class=\"damage-feed-" + entry.tone + "\">" + entry.text + "</li>")
    .reverse()
    .join("");
  if (list.dataset.rendered !== html) {
    list.dataset.rendered = html;
    list.innerHTML = html;
  }
}

function droneCommandKey(shipId, componentId) {
  return String(shipId) + ":" + String(componentId);
}

function droneTypeLabel(bay) {
  return String(bay?.droneType || "drone").replace(/^./, (letter) => letter.toUpperCase());
}

function droneProblemLabel(reason) {
  return {
    "low-power": "rebuilding slowly: low power",
    "insufficient-power": "rebuild paused: no power",
    "bay-overheated": "rebuild paused: overheated",
    "bay-destroyed": "production unavailable: bay offline",
    "parent-destroyed": "parent ship destroyed",
    "invalid-configuration": "invalid bay configuration"
  }[reason] || (reason ? String(reason).replaceAll("-", " ") : null);
}

function droneCommandPresentation(bay, counts) {
  if (!bay.operational) return { tone: "offline", status: "Bay offline", action: "Deploy squad" };
  if (bay.mode === "recalled") {
    if (counts.returning > 0) return { tone: "recalling", status: "Recalling; " + counts.returning + " in transit", action: "Cancel recall" };
    return { tone: "recalled", status: "Recalled; " + (counts.stored + counts.ready) + " stored", action: "Deploy squad" };
  }
  if (counts.returning > 0) return { tone: "recalling", status: "Recall cancelling; " + counts.returning + " in transit", action: "Recall squad" };
  if (counts.refueling > 0) return { tone: "refueling", status: "Refueling; " + counts.refueling + " docked", action: "Recall squad" };
  if (counts.active > 0) {
    const launching = (bay.slots || []).filter((slot) => slot.state === "launching").length;
    return launching > 0
      ? { tone: "deploying", status: "Deploying; " + launching + " launching", action: "Recall squad" }
      : { tone: "deployed", status: "Deployed; " + counts.active + " active", action: "Recall squad" };
  }
  if (bay.launchBlockedBySpawn) return { tone: "paused", status: "Launch paused; leave spawn", action: "Recall squad" };
  if (bay.overheated) return { tone: "paused", status: "Launch paused; overheated", action: "Recall squad" };
  if (counts.powerFraction <= MIN_DRONE_UI_POWER) return { tone: "paused", status: "Launch paused; no power", action: "Recall squad" };
  if (counts.producing) return { tone: "queued", status: "Rebuilding replacement", action: "Recall squad" };
  return { tone: "queued", status: "Deployment queued; " + counts.ready + " ready", action: "Recall squad" };
}

function renderDroneSummary(ship) {
  const target = dom.shipDroneSummary;
  if (!target) return;
  const bays = Array.isArray(ship?.droneBays) ? ship.droneBays : [];
  target.hidden = bays.length === 0;
  if (!bays.length) {
    target.innerHTML = "";
    return;
  }
  target.innerHTML = "<section aria-label=\"Drone Bay status\"><strong class=\"ship-drone-summary-title\">Drones</strong>"
    + bays.map((bay) => {
      const slots = bay.slots || [];
      const active = slots.filter((slot) => ["launching", "active"].includes(slot.state)).length;
      const returning = slots.filter((slot) => ["returning", "docking"].includes(slot.state)).length;
      const refueling = slots.filter((slot) => slot.state === "refueling").length;
      const inSpace = active + returning + refueling;
      const producing = bay.operational === false ? null : slots.find((slot) => slot.state === "producing");
      const orphaned = slots.filter((slot) => slot.state === "orphaned").length;
      const ready = slots.filter((slot) => slot.state === "ready").length;
      const stored = slots.filter((slot) => slot.state === "stored").length;
      const label = droneTypeLabel(bay);
      const range = Math.max(0, Math.round(Number(bay.commandRange) || 0));
      const problem = droneProblemLabel(bay.productionPausedReason);
      const productionClass = bay.productionPausedReason === "low-power"
        ? " is-slowed"
        : problem ? " is-paused" : "";
      const progress = producing ? Math.max(0, Math.min(1, Number(producing.progress) || 0)) : null;
      const progressPercent = progress === null ? null : Math.round(progress * 100);
      const squadComplete = slots.length > 0 && inSpace + ready + stored === slots.length;
      const key = droneCommandKey(ship.id, bay.componentId);
      let pending = pendingDroneBayCommands.get(key) || null;
      if (pending && bay.mode === pending.mode) {
        pendingDroneBayCommands.delete(key);
        pending = null;
      }
      const powerFraction = Number.isFinite(Number(bay.powerFraction)) ? Number(bay.powerFraction) : (bay.operational ? 1 : 0);
      const command = droneCommandPresentation(bay, { active, returning, refueling, ready, stored, producing, powerFraction });
      const pips = slots.map((slot, index) => {
        const stateName = String(slot.state || "unavailable");
        const title = "Drone " + (index + 1) + ": " + stateName;
        return "<i class=\"ship-drone-pip is-" + escapeHtml(stateName) + "\" aria-hidden=\"true\" title=\"" + escapeHtml(title) + "\"></i>";
      }).join("");
      const targetMode = bay.mode === "recalled" ? "deployed" : "recalled";
      const actionLabel = pending ? (pending.mode === "recalled" ? "Recalling..." : "Deploying...") : command.action;
      const disabled = Boolean(pending) || !bay.operational;
      const progressBar = progressPercent === null ? "" : "<div class=\"ship-drone-production" + productionClass + "\" role=\"progressbar\" aria-valuemin=\"0\" aria-valuemax=\"100\" aria-valuenow=\"" + progressPercent + "\"><span style=\"width:" + progressPercent + "%\"></span></div>";
      return "<div class=\"ship-drone-bay-row\" data-drone-command-state=\"" + escapeHtml(command.tone) + "\">"
        + "<div class=\"ship-drone-bay-info\"><div class=\"ship-drone-bay-heading\"><b>" + escapeHtml(label) + "</b><span class=\"ship-drone-command-state is-" + escapeHtml(command.tone) + "\">" + escapeHtml(command.status) + "</span></div>"
        + (range ? "<small class=\"ship-drone-range\">360° drone range; " + range + " m</small>" : "")
        + "<div class=\"ship-drone-squad-pips\" aria-label=\"" + active + " active, " + returning + " returning, " + refueling + " refueling, " + orphaned + " orphaned, " + stored + " stored out of " + slots.length + " drones\">" + pips + "</div>"
        + "<small>" + active + " active; " + ready + " ready; " + stored + " stored; " + (Number(bay.runtimePowerMw) || 0) + " MW"
        + (orphaned ? "; " + orphaned + " orphaned; self-destructing" : producing ? "; " + progressPercent + "% rebuilding" : squadComplete ? "; squad accounted for" : "; replacement pending")
        + (problem ? "; " + escapeHtml(problem) : "") + "</small>" + progressBar + "</div>"
        + "<button type=\"button\" class=\"ship-drone-command-button is-" + escapeHtml(command.tone) + "\" data-drone-bay-id=\"" + escapeHtml(bay.componentId) + "\" data-drone-bay-mode=\"" + targetMode + "\" aria-label=\"" + escapeHtml(actionLabel + " for " + label + " Drone Bay") + "\"" + (pending ? " aria-busy=\"true\"" : "") + (disabled ? " disabled" : "") + ">" + escapeHtml(actionLabel) + "</button></div>";
    }).join("") + "</section>";
}

function bindOnce() {
  if (bound) return;
  bound = true;
  const canvas = dom.shipDamageCanvas;
  if (canvas) {
    if (canvas.style) canvas.style.touchAction = "none";
    canvas.addEventListener("pointermove", handleDiagramPointerMove);
    canvas.addEventListener("pointerdown", handleDiagramPointerDown);
    canvas.addEventListener("pointerleave", handleDiagramPointerLeave);
  }
  dom.shipDamageTab?.addEventListener("click", () => switchStatusView("damage"));
  dom.shipHeatTab?.addEventListener("click", () => switchStatusView("heat"));
  dom.shipDroneSummary?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-drone-bay-mode]");
    const ship = selectedSingleShip();
    if (!button || !ship || button.disabled) return;
    const componentId = button.dataset.droneBayId;
    const mode = button.dataset.droneBayMode;
    const bay = ship.droneBays?.find((entry) => entry.componentId === componentId);
    if (!bay || !["deployed", "recalled"].includes(mode)) return;
    const key = droneCommandKey(ship.id, componentId);
    if (pendingDroneBayCommands.has(key)) return;
    if (!send({ type: "setDroneBayMode", shipId: ship.id, componentId, mode })) {
      notify.warning("Drone command not sent: connection unavailable.", { key: "drone-send:" + key });
      return;
    }
    const pending = { mode, at: performance.now() };
    pendingDroneBayCommands.set(key, pending);
    renderDroneSummary(ship);
    setTimeout(() => {
      if (pendingDroneBayCommands.get(key) !== pending) return;
      pendingDroneBayCommands.delete(key);
      const current = selectedSingleShip();
      if (current?.id === ship.id) renderDroneSummary(current);
      notify.warning("Drone command was not confirmed. Check the connection and try again.", { key: "drone-timeout:" + key });
    }, DRONE_COMMAND_TIMEOUT_MS);
  });
  for (const tab of statusTabs()) tab.addEventListener("keydown", handleStatusTabKeydown);
}

function synchronizePanelShell() {
  const panel = dom.shipDamagePanel;
  if (!panel) return null;
  bindOnce();
  const view = state.shipStatusView === "heat" ? "heat" : "damage";
  state.shipStatusView = view;
  panel.dataset.statusView = view;
  const damageView = view === "damage";
  const heatView = view === "heat";
  dom.shipDamageTab?.classList.toggle("active", damageView);
  dom.shipHeatTab?.classList.toggle("active", heatView);
  dom.shipDamageTab?.setAttribute?.("aria-selected", String(damageView));
  dom.shipHeatTab?.setAttribute?.("aria-selected", String(heatView));
  dom.shipDamageTab?.setAttribute?.("tabindex", damageView ? "0" : "-1");
  dom.shipHeatTab?.setAttribute?.("tabindex", heatView ? "0" : "-1");
  dom.shipStatusPanelBody?.setAttribute?.("aria-labelledby", heatView ? "shipHeatTab" : "shipDamageTab");
  if (dom.damageLegend) dom.damageLegend.hidden = !damageView;
  if (dom.heatLegend) dom.heatLegend.hidden = !heatView;
  if (dom.damageFeed) dom.damageFeed.hidden = !damageView;
  if (dom.shipHeatSummary) dom.shipHeatSummary.hidden = !heatView;
  const ship = selectedSingleShip();
  if (!ship) {
    panel.hidden = true;
    diagramInteraction = null;
    clearComponentReadout();
    if (dom.shipHeatSummary) dom.shipHeatSummary.hidden = true;
    if (dom.shipDroneSummary) dom.shipDroneSummary.hidden = true;
    return null;
  }
  panel.hidden = false;
  renderDroneSummary(ship);
  return { ship, view };
}

function bumpSelected(name) {
  const diagnostics = state.presentationDiagnostics;
  if (diagnostics) diagnostics[name] = (diagnostics[name] || 0) + 1;
}

function repaintSelectedDamage(ship) {
  drawDiagram(ship);
  refreshComponentReadout(ship);
  renderCoreStatus(ship);
  renderFeed(ship);
}

function repaintSelectedHeat(ship) {
  updateComponentHeatTrends(ship, state.snapshotReceivedAt, state.room, state.snapshotNetwork?.stateEpoch || 0);
  drawDiagram(ship);
  refreshComponentReadout(ship);
  renderHeatSummary(ship);
  if (dom.coreStatusLabel) dom.coreStatusLabel.hidden = true;
}

export function updateSelectedShipDamageUi() {
  bumpSelected("selectedDamageUpdateCount");
  const current = synchronizePanelShell();
  if (!current || current.view !== "damage") return;
  bumpSelected("selectedDynamicRedrawCount");
  repaintSelectedDamage(current.ship);
}

export function updateSelectedShipHeatUi() {
  bumpSelected("selectedHeatUpdateCount");
  const current = synchronizePanelShell();
  if (!current || current.view !== "heat") return;
  bumpSelected("selectedDynamicRedrawCount");
  repaintSelectedHeat(current.ship);
}

export function renderShipDamagePanel() {
  if (state.shipStatusView === "heat") updateSelectedShipHeatUi();
  else updateSelectedShipDamageUi();
}
