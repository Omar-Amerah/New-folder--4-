// Selected-ship damage panel: a mini rendering of the actual ship (real
// component art via the shared drawModule pipeline, blueprint-up orientation)
// with live status tints, per-component hp bars, hover/tap highlight + readout,
// the recent-damage feed, and core warnings. Everything renders from the
// client-side ship/component state already received — no extra server traffic.

import { dom, withCanvasContext } from "./dom.js";
import { state } from "../state.js";
import { PART_DEFS, PART_STATS } from "../design/parts.js";
import { getOccupiedCells } from "../design/footprint.js";
import { drawRotatingWeaponTop } from "../game/componentArt.js";
import { drawPlacedStaticComponent } from "../game/staticComponentComposition.js";
import { isRotatingWeaponPart, authoritativeWeaponAngle } from "../game/weaponAim.js";
import { updateComponentHeatTrends, componentHeatTrend } from "../game/componentHeatTrend.js";
import { footprintLocalPlacement, footprintCorners } from "../game/shipGeometry.js";
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

function switchgearSummaryText(ship) {
  const records = Array.isArray(ship.switchgear) ? ship.switchgear : [];
  if (!records.length) return "None";
  return records.map((record) => {
    const parts = [`#${record.componentIndex} ${record.state || record.mode || "Unknown"}${record.mode === "automatic" || record.state === "automatic" ? ` (${record.automaticClosed ? "conducting" : "open"})` : ""} ${record.ratingTier || "standard"} ${record.classification || "isolator"} ${formatHeatAmount(record.signedTransferMw || 0)} MW`];
    // Section 7G runtime protection: saved mode, overload stress, trip reason,
    // cooldown, retry count and last retry reason as clear text labels.
    parts.push(`mode ${record.mode || "closed"}`);
    if ((record.overloadStress || 0) > 0) parts.push(`stress ${Math.round((record.overloadStress || 0) * 100)}%`);
    if (record.state === "tripped") {
      parts.push(`trip: ${record.trippedReason || record.lastTripReason || "Unknown"}`);
      parts.push(`cooldown ${formatHeatAmount(record.cooldownRemaining || 0)}s`);
    }
    if ((record.retryCount || 0) > 0) parts.push(`retries ${record.retryCount}${record.lastRetryReason ? ` (${record.lastRetryReason})` : ""}`);
    return parts.join(" · ");
  }).join("; ");
}

// Section 7G ship-level Power-protection summary (diagnostics only; states
// come from the authoritative server snapshot).
function protectionStateLabel(state) {
  const labels = {
    "normal": "Normal",
    "strained": "Strained",
    "brownout": "Brownout",
    "load-shedding": "Load shedding",
    "protection-trip": "Protection trip"
  };
  return labels[state] || "Unknown";
}

function mostStressedSectionText(pp) {
  if (!pp || !pp.mostStressedSectionId) return "None";
  return `${pp.mostStressedSectionId} ${Math.round((pp.mostStressedStress || 0) * 100)}%`;
}

// Per-section runtime protection readout for one hosted Power section.
function sectionProtectionText(ship, sectionId) {
  const records = ship.powerProtection?.sections;
  const record = Array.isArray(records) ? records.find((entry) => entry.sectionId === sectionId) : null;
  if (!record) return `${sectionId}: normal`;
  const seconds = record.secondsAboveSustained > 0 ? ` · ${formatHeatAmount(record.secondsAboveSustained)}s above sustained` : "";
  const disabled = record.operational === false ? " · disabled" : "";
  return `${sectionId} (${record.tier}): ${record.state} · ${formatHeatAmount(record.absoluteFlowMw)} / ${formatHeatAmount(record.sustainedCapacityMw)} MW sustained (${formatHeatAmount(record.peakCapacityMw)} MW peak) · ${Math.round((record.sustainedUtilisation || 0) * 100)}% sustained, ${Math.round((record.peakUtilisation || 0) * 100)}% peak · stress ${Math.round((record.stress || 0) * 100)}%${seconds}${disabled}`;
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
  const pt = ship.powerThermal || {};
  const pp = ship.powerProtection || {};
  const heatState = overheated > 0 ? "Overheating" : hot > 0 ? "Heating" : "Stable";
  const hottest = Number.isInteger(pt.hottestComponentIndex) && ship.design?.[pt.hottestComponentIndex]
    ? `${partDisplayName(ship.design[pt.hottestComponentIndex].type)} #${pt.hottestComponentIndex}`
    : "None";
  summary.hidden = false;
  let fastestHeat = null;
  ship.design?.forEach((part, i) => {
    const trend = componentHeatTrend(i);
    if (trend.direction === "warming" && (!fastestHeat || trend.smoothedRate > fastestHeat.rate)) fastestHeat = { index: i, rate: trend.smoothedRate, name: partDisplayName(part.type) };
  });
  summary.innerHTML = `
    <div><span title="Aggregate stored heat across the whole ship — individual components may run hotter or cooler">Overall heat</span><strong>${percentText}</strong></div>
    <div><span>Stored</span><strong>${formatHeatAmount(heatNow)} / ${formatHeatAmount(heatMax)} H</strong></div>
    <div><span>Component Heat rate</span><strong>${formatHeatAmount(pt.componentHeatRate || 0)} H/s</strong></div>
    <div><span>Power cable Heat rate</span><strong>${formatHeatAmount(pt.powerCableHeatRate || 0)} H/s</strong></div>
    <div><span>Total / net Heat rate</span><strong>${formatHeatAmount(pt.totalHeatRate || 0)} / ${formatHeatAmount(pt.netHeatRate || 0)} H/s</strong></div>
    <div><span>Cooling</span><strong>${formatHeatAmount(pt.cooling || 0)} H/s</strong></div>
    <div><span>Heat state</span><strong>${heatState}</strong></div>
    <div><span>Hottest component</span><strong>${hottest}</strong></div>
    <div><span>Hottest cable</span><strong>${pt.hottestSectionId || "None"}</strong></div>
    <div><span>Overloaded / peak cables</span><strong>${pt.aboveSustainedSectionCount || 0} / ${pt.atPeakSectionCount || 0}</strong></div>
    <div><span>Throttled / disabled</span><strong>${pt.throttledComponentCount || 0} / ${pt.disabledComponentCount || 0}</strong></div>
    <div><span>Power gen / requested</span><strong>${formatHeatAmount(pt.powerGenerationMw || 0)} / ${formatHeatAmount(pt.requestedDemandMw || 0)} MW</strong></div>
    <div><span>Power delivered</span><strong>${formatHeatAmount(pt.deliveredDemandMw || 0)} MW</strong></div>
    <div><span>Power spare / unmet</span><strong>${formatHeatAmount(pt.sparePowerMw || 0)} / ${formatHeatAmount(pt.unmetDemandMw || 0)} MW</strong></div>
    <div><span>Priority preset</span><strong>${pt.activePriorityPreset || "Default"}</strong></div>
    <div><span title="Runtime Power overload protection state derived from the authoritative allocation">Power protection</span><strong>${protectionStateLabel(pp.state || "normal")}</strong></div>
    <div><span>Sections above sustained / at peak</span><strong>${pp.aboveSustainedSectionCount || 0} / ${pp.atPeakSectionCount || 0}</strong></div>
    <div><span>Critical-stress sections</span><strong>${pp.criticalSectionCount || 0}</strong></div>
    <div><span>Most stressed section</span><strong>${mostStressedSectionText(pp)}</strong></div>
    <div><span>Tripped Switchgear</span><strong>${pp.trippedSwitchgearCount || 0}</strong></div>
    <div><span>Next retry</span><strong>${(pp.trippedSwitchgearCount || 0) > 0 ? `${formatHeatAmount(pp.nextRetrySeconds || 0)}s` : "None"}</strong></div>
    <div><span>Partial / shed consumers</span><strong>${pp.partialConsumerCount || 0} / ${pp.shedConsumerCount || 0}</strong></div>
    <div><span>Switchgear</span><strong>${switchgearSummaryText(ship)}</strong></div>
    <div><span>Hot parts</span><strong>${hot}</strong></div>
    <div><span>Overheated</span><strong>${overheated}</strong></div>
    ${fastestHeat ? `<button type="button" class="heat-trend-jump" data-component-index="${fastestHeat.index}"><span>Fastest heating</span><strong>${fastestHeat.name} ${formatHeatRate(fastestHeat.rate)}</strong></button>` : ""}`;
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
  const hp = Number(ship.chp?.[index]) || 0;
  if (hp <= 0) {
    const retained = thermal.heat > 0 ? ` · retained ${formatHeatAmount(thermal.heat)} H` : "";
    dom.shipDamageHover.textContent = `${partDisplayName(part.type)} — Inactive / destroyed${retained}`;
    return;
  }
  const percentText = formatHeatPercent(Math.min(125, thermal.ratio * 100));
  const capacityText = thermal.capacity > 0 ? ` / ${formatHeatAmount(thermal.capacity)} H · ${percentText}` : " H";
  const rules = globalThis.HeatRules;
  const passive = /frame/i.test(part.type) || ["armor", "compositeArmor", "bulkhead", "weaponMount"].includes(part.type);
  const activePerf = rules?.activeOutputForState?.(thermal.state);
  const passivePerf = rules?.passiveProtectionForState?.(thermal.state);
  const perfText = passive && passivePerf != null && passivePerf < 1
    ? ` · ${Math.round(passivePerf * 100)}% protection`
    : activePerf != null && activePerf < 1 ? ` · ${Math.round(activePerf * 100)}% output` : "";
  const trend = componentHeatTrend(index);
  const trendText = trend.direction === "warming" ? ` — Warming ${formatHeatRate(trend.smoothedRate)}`
    : trend.direction === "cooling" ? ` — Cooling ${formatHeatRate(trend.smoothedRate)}`
    : trend.direction === "stable" ? " — Stable" : "";
  const powerDiag = ship.powerThermal?.components?.[index];
  const powerText = powerDiag
    ? ` · Power ${formatHeatAmount(powerDiag.requestedMw)} / ${formatHeatAmount(powerDiag.allocatedMw)} MW · Cable Heat ${formatHeatAmount(powerDiag.powerCableHeatRate)} H/s · Sections ${(powerDiag.hostedActiveSectionIds || []).join(", ") || "None"}`
    : "";
  // Section 7G wiring-section inspection: per-hosted-section runtime overload
  // protection (id, tier, flow vs sustained/peak, utilisation, stress,
  // seconds above sustained, protection state).
  const hostedIds = powerDiag?.hostedActiveSectionIds || [];
  const protectionText = hostedIds.length
    ? ` · Protection ${hostedIds.map((sectionId) => sectionProtectionText(ship, sectionId)).join("; ")}`
    : "";
  dom.shipDamageHover.textContent = `${partDisplayName(part.type)} — ${formatHeatAmount(thermal.heat)}${capacityText} — ${HEAT_LABELS[thermal.state] || "Cool"}${trendText}${perfText}${powerText}${protectionText}`;
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
  const geometry = ship && canvas ? (diagramInteraction?.shipId === ship.id
    ? diagramInteraction
    : shipDamageDiagramGeometry(ship, canvas.width, canvas.height)) : null;
  let canvasX = null, canvasY = null, mappedIndex;
  if (canvas && rect?.width && rect?.height && Number.isFinite(clientX) && Number.isFinite(clientY)) {
    canvasX = (clientX - rect.left) * (canvas.width / rect.width);
    canvasY = (clientY - rect.top) * (canvas.height / rect.height);
    if (geometry) {
      const gx = Math.round(SHIP_DAMAGE_GRID_CENTER + (canvasX - geometry.originX) / geometry.cellSize);
      const gy = Math.round(SHIP_DAMAGE_GRID_CENTER + (canvasY - geometry.originY) / geometry.cellSize);
      mappedIndex = geometry.cellMap?.get(`${gx},${gy}`);
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
  // drawDiagram renders ship-local art after rotate(-90deg), so the projected
  // screen-space diagram axes are (x, y) -> (y, -x) before origin/scale.
  return { x: point.y, y: -point.x };
}

function componentFootprintGeometry(part, unit = 1) {
  const place = footprintLocalPlacement(part, unit);
  const halfLong = (place.tilesLong * unit) / 2;
  const halfCross = (place.tilesCross * unit) / 2;
  const corners = footprintCorners(place, halfLong, halfCross).slice(0, 4);
  const cells = getOccupiedCells(part.x, part.y, PART_STATS[part.type]?.footprint || { width: 1, height: 1 }, part.rotation || 0);
  return { place, cells, diagramCorners: corners.map(projectShipLocalToDiagram) };
}

function includePoint(bounds, point) {
  if (point.x < bounds.minX) bounds.minX = point.x;
  if (point.y < bounds.minY) bounds.minY = point.y;
  if (point.x > bounds.maxX) bounds.maxX = point.x;
  if (point.y > bounds.maxY) bounds.maxY = point.y;
}

function shipDamageDiagramGeometry(ship, canvasWidth, canvasHeight, pad = 18) {
  const cellMap = new Map();
  const cellsByIndex = [];
  const footprintByIndex = [];
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

  ship.design.forEach((part, i) => {
    const geometry = componentFootprintGeometry(part, 1);
    cellsByIndex[i] = geometry.cells;
    footprintByIndex[i] = geometry;
    for (const cell of geometry.cells) cellMap.set(`${cell.x},${cell.y}`, i);
    for (const corner of geometry.diagramCorners) includePoint(bounds, corner);
  });

  if (!ship.design.length || !Number.isFinite(bounds.minX)) {
    bounds.minX = bounds.minY = -0.5;
    bounds.maxX = bounds.maxY = 0.5;
  }

  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const cellSize = Math.max(6, Math.floor(Math.min((canvasWidth - pad * 2) / width, (canvasHeight - pad * 2) / height)));
  const originX = canvasWidth / 2 - ((bounds.minX + bounds.maxX) / 2) * cellSize;
  const originY = canvasHeight / 2 - ((bounds.minY + bounds.maxY) / 2) * cellSize;
  return { cellMap, cellsByIndex, footprintByIndex, bounds, cellSize, originX, originY, pad };
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
function hexToRgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function heatColor(ratio) {
  const r = Math.max(0, Math.min(1, Number(ratio) || 0));
  for (let i = 1; i < HEAT_STOPS.length; i += 1) {
    const [at, color] = HEAT_STOPS[i];
    if (r <= at) {
      const [prevAt, prevColor] = HEAT_STOPS[i - 1];
      const t = (r - prevAt) / Math.max(0.0001, at - prevAt);
      const a = hexToRgb(prevColor), b = hexToRgb(color);
      return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
    }
  }
  return "#b80024";
}
function makeHeatGradient(ctx, x, w) {
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  for (const [stop, color] of HEAT_STOPS) g.addColorStop(stop, color);
  return g;
}
function formatHeatRate(rate) { const v = Number(rate) || 0; return `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)} H/s`; }

// Renders the ship with its real component art (same drawModule pipeline as
// the arena), rotated so the nose points up like the blueprint grid, then
// layers status tints, hit flashes, hp bars, the core marker, and the
// hover/selection highlight on top.
function drawDiagram(ship) {
  const canvas = dom.shipDamageCanvas;
  const drawCtx = canvas?.getContext("2d");
  if (!drawCtx) return;
  drawCtx.clearRect(0, 0, canvas.width, canvas.height);

  // Authoritative per-component footprints and bounds. The design bounds come
  // from the same footprintLocalPlacement()/drawPlacedStaticComponent() geometry
  // used to render art, not just anchor cells, so rotated multi-cell parts that
  // extend right, left, above, or below their anchor cannot be clipped.
  const geometry = shipDamageDiagramGeometry(ship, canvas.width, canvas.height);
  const { cellMap, cellsByIndex, cellSize, originX, originY } = geometry;
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
  diagramInteraction = { shipId: ship.id, componentIndex, hoverIndex, cellMap, cellsByIndex, cellSize, originX, originY, bounds: geometry.bounds };

  const player = state.snapshot?.players?.find((candidate) => candidate.id === ship.ownerId);
  const trim = player?.color || "#8fd8ff";
  const now = performance.now();

  // The arena drawing helpers work in ship-local space (nose along +x); rotate
  // the whole frame -90deg so the ship renders nose-up like the build grid.
  withCanvasContext(drawCtx, () => {
    drawCtx.save();
    drawCtx.translate(originX, originY);
    drawCtx.rotate(-Math.PI / 2);
    ship.design.forEach((part, i) => {
      const def = PART_DEFS[part.type] || PART_DEFS.frame;
      const place = footprintLocalPlacement(part, cellSize);
      const ratio = componentHealthRatio(ship, i);
      const destroyed = ratio !== null && ratio <= 0;
      const halfLong = (place.tilesLong * cellSize) / 2;
      const halfCross = (place.tilesCross * cellSize) / 2;
      drawCtx.save();
      if (destroyed) drawCtx.globalAlpha *= 0.6;
      drawPlacedStaticComponent(drawCtx, { part, place, unit: cellSize, color: def.color, trim });
      if (isRotatingWeaponPart(part.type)) {
        drawCtx.save();
        drawCtx.translate(place.cx, place.cy);
        drawCtx.rotate(authoritativeWeaponAngle(ship, i, part));
        drawRotatingWeaponTop({ type: part.type, unit: cellSize, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: def.color });
        drawCtx.restore();
      }
      drawCtx.translate(place.cx, place.cy);
      drawCtx.rotate(place.longAxisAngle);
      if (state.shipStatusView !== "heat") {
        drawModuleDamage(drawCtx, ratio, halfLong, halfCross, now);
        drawModuleFlash(drawCtx, componentFlash(ship.id, i, now), halfLong, halfCross);
      }
      if (state.shipStatusView === "heat" && !destroyed) {
        const thermal = componentThermal(ship, i);
        if (thermal.heat > 0) {
          drawCtx.fillStyle = heatColor(thermal.ratio);
          drawCtx.globalAlpha = Math.min(0.58, 0.08 + thermal.ratio * 0.5);
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
    if (state.shipStatusView === "heat" && ratio > 0 && thermal.heat > 0) {
      const barH = Math.max(2, cellSize * 0.14);
      const y = rect.y + rect.h - barH - 1;
      drawCtx.fillStyle = "rgba(3, 8, 15, 0.82)";
      drawCtx.fillRect(rect.x + 1, y, rect.w - 2, barH);
      drawCtx.save();
      drawCtx.beginPath();
      drawCtx.rect(rect.x + 1, y, Math.max(1, (rect.w - 2) * Math.min(1, thermal.ratio)), barH);
      drawCtx.clip();
      drawCtx.fillStyle = makeHeatGradient(drawCtx, rect.x + 1, rect.w - 2);
      drawCtx.fillRect(rect.x + 1, y, rect.w - 2, barH);
      drawCtx.restore();
      if (thermal.ratio >= 0.86) { drawCtx.strokeStyle = "rgba(255,24,63,.55)"; drawCtx.strokeRect(rect.x + 1, y, rect.w - 2, barH); }
      const trend = componentHeatTrend(i);
      if (trend.direction === "warming" || trend.direction === "cooling") {
        const warming = trend.direction === "warming";
        const cx = Math.min(canvas.width - 8, Math.max(8, rect.x + rect.w / 2));
        const ty = Math.min(canvas.height - 10, Math.max(10, rect.y + 8));
        drawCtx.fillStyle = warming ? "#ffb020" : "#38d5ff";
        drawCtx.strokeStyle = "rgba(0,0,0,.75)";
        drawCtx.lineWidth = 2;
        drawCtx.beginPath();
        if (warming) { drawCtx.moveTo(cx, ty - 6); drawCtx.lineTo(cx - 6, ty + 5); drawCtx.lineTo(cx + 6, ty + 5); }
        else { drawCtx.moveTo(cx, ty + 6); drawCtx.lineTo(cx - 6, ty - 5); drawCtx.lineTo(cx + 6, ty - 5); }
        drawCtx.closePath(); drawCtx.stroke(); drawCtx.fill();
        if (rect.w > cellSize * 1.5) {
          const label = formatHeatRate(trend.smoothedRate).replace(" H/s", "");
          drawCtx.font = `900 ${Math.max(8, Math.min(11, cellSize * 0.28))}px system-ui`;
          const tw = drawCtx.measureText(label).width + 8;
          const px = Math.min(canvas.width - tw - 2, Math.max(2, cx + 8));
          drawCtx.fillStyle = "rgba(3,8,15,.82)"; drawCtx.fillRect(px, ty - 8, tw, 14);
          drawCtx.fillStyle = warming ? "#ffd17a" : "#9befff"; drawCtx.fillText(label, px + 4, ty + 3);
        }
      }
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
  if (heatView) updateComponentHeatTrends(ship, state.snapshotReceivedAt, state.room);
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
