// Wiring v2 editor: canonical physical sections own topology and membership.
import { dom } from "./dom.js";
import { state } from "../state.js";
import { PART_DEFS, PART_STATS } from "../design/parts.js";
import { findPartAtCell } from "../design/placementCandidate.js";
import { getFootprintBounds } from "../design/footprint.js";
import { persistDesign, defaultWiring, normalizeWiring } from "../design/blueprintStorage.js";
import { escapeHtml } from "../shared/formatting.js";
import { computeStats } from "../design/componentStats.js";
import { canUndoBlueprintEdit } from "../design/blueprintEditHistory.js";
import { preDisplacementHeatCapacities } from "../design/thermalAnalysis.js";
import { WIRING_INFRASTRUCTURE } from "../constants.js";
import { getCachedDesignDataSupport, getCachedDataVulnerabilities } from "../design/dataSupportAnalysis.js";
import { formatDataSupportValue, formatDataSupportEquation } from "../design/dataSupportPresentation.js";
import { solveBlueprintPower } from "../design/powerAllocationAnalysis.js";
import { applyPowerPolicyChange, renderLocalStats } from "./designerUi.js";

const GRID_SIZE = 15;
const MAX_UNDO = 60;
const SVG_NS = "http://www.w3.org/2000/svg";
const DRAG_THRESHOLD_PX = 5;
const CABLE_LIMITS = Object.freeze({ ...globalThis.WiringRules?.DEFAULT_CABLE_LIMITS });
let pointerDrag = null;
let suppressNextClick = false;
let locatedSectionId = null;
let locatedComponentIndex = null;
let locateHighlightTimer = null;
const analysisDetailsState = { healthy: false, advanced: false, tier: false };
function rules() { return globalThis.WiringRules; }
function editRules() { return globalThis.WiringEditRules; }
function infraRules() { return globalThis.WiringInfrastructureRules; }
function clarityRules() { return globalThis.WiringClarityRules; }
function cableThermalRules() { return globalThis.PowerCableThermalRules; }
function ui() { return state.wiringUi; }
const POWER_TIERS = Object.freeze(["light", "standard", "heavy"]);
function currentTool() { return ["draw", "erase", "inspect"].includes(ui().wiringTool) ? ui().wiringTool : "draw"; }
function selectedTier() { return POWER_TIERS.includes(ui().selectedPowerTier) ? ui().selectedPowerTier : "standard"; }
function tierLabel(tier) { return WIRING_INFRASTRUCTURE?.powerTiers?.[tier]?.inspectionLabel || (tier ? tier[0].toUpperCase() + tier.slice(1) : ""); }
// Visible stroke width in SVG grid units, driven by authoritative renderedThickness.
// Standard (thickness 2) ~= the historical wiring width so migrated designs look
// unchanged; Light is clearly thinner, Heavy clearly thicker.
function renderedStrokeWidth(tier) {
  const thickness = Number(WIRING_INFRASTRUCTURE?.powerTiers?.[tier]?.renderedThickness);
  const scaled = Number.isFinite(thickness) && thickness > 0 ? thickness : 2;
  return (0.07 * scaled).toFixed(3);
}
function sectionActionVerb() {
  if (currentTool() === "erase") return "Erase";
  if (currentTool() === "inspect") return "Inspect";
  return "Draw from";
}
// Cheap hover highlight: toggles a class on already-rendered visible lines
// without rebuilding the overlay or re-running analysis.
function applyHoverHighlight() {
  const host = dom.wiringOverlayHost; if (!host) return;
  const hoveredId = ui().sourceIndex == null ? ui().hoveredSectionId : null;
  const previewTool = currentTool() === "erase";
  const inspectTool = currentTool() === "inspect";
  const shortageNetworkId = ui().hoveredPowerShortageNetworkId || ui().selectedPowerShortageNetworkId || null;
  host.classList.toggle("wiring-inspect-hover-active", Boolean(hoveredId && inspectTool));
  host.classList.toggle("wiring-shortage-highlight-active", Boolean(shortageNetworkId));
  let hoveredNetworkId = null;
  host.querySelectorAll(".wire-visible-layer [data-section-id]").forEach((element) => {
    const on = element.dataset.sectionId === hoveredId;
    if (on) hoveredNetworkId = element.dataset.networkId || null;
    element.classList.toggle("wire-section-preview", on && previewTool);
    element.classList.toggle("wire-section-hover", on && inspectTool);
  });
  host.querySelectorAll(".wire-energy-layer [data-network-id]").forEach((element) => {
    element.classList.toggle("active", Boolean(
      (inspectTool && hoveredNetworkId && element.dataset.networkId === hoveredNetworkId)
      || (shortageNetworkId && element.dataset.networkId === shortageNetworkId)
    ));
  });
  host.querySelectorAll("[data-power-network-id]").forEach((element) => {
    const related = Boolean(shortageNetworkId && element.dataset.powerNetworkId === shortageNetworkId);
    element.classList.toggle("wire-shortage-related", related);
    element.classList.toggle("wire-shortage-unrelated", Boolean(shortageNetworkId && !related));
  });
  host.querySelectorAll("[data-power-shortage-network-id]").forEach((element) => {
    element.classList.toggle("is-selected", element.dataset.powerShortageNetworkId === ui().selectedPowerShortageNetworkId);
  });
}

function clearWiringHoverCard() {
  if (!dom.wiringHoverCard) return;
  dom.wiringHoverCard.hidden = true;
  dom.wiringHoverCard.innerHTML = "";
}

// Pre-displacement Heat capacities (base profile + legitimate heat-sink adjacency
// bonuses, no wiring displacement) from the shared thermal model, so previews
// see the same authoritative capacity the committed design and server use.
function powerBaseCapacities() { try { return preDisplacementHeatCapacities(state.design); } catch (_) { return state.design.map(() => 0); } }
// The component-derived ship price is independent of wiring, so it is a safe
// shared baseline for total-ship-cost and infrastructure-percentage previews.
function preInfrastructureShipCost() { try { return computeStats(state.design).costBreakdown.total; } catch (_) { return 0; } }
function previewOptions() { return { baseCapacities: powerBaseCapacities(), preInfrastructureShipCost: preInfrastructureShipCost() }; }

// One cached preview per hover/edit frame; invalidated on any committed edit.
let previewCache = { signature: null, preview: null };
let transientReason = null;
function invalidatePreviewCache() { previewCache = { signature: null, preview: null }; }
function cachedPreview(signature, compute) {
  if (previewCache.signature === signature) return previewCache.preview;
  const preview = compute();
  previewCache = { signature, preview };
  return preview;
}
function setTransientReason(reason) { transientReason = reason || null; }

const REASON_TEXT = Object.freeze({
  "data-has-no-tiers": "Data wiring has no cable tiers.",
  "missing-section": "Select an existing Power section.",
  "already-selected-tier": "This section is already that tier.",
  "empty-path": "No valid path between these components.",
  "invalid-path": "Power routes must stay inside occupied ship cells.",
  "internal-terminal": "These terminals are on the same component and are already connected internally.",
  "no-change": "No change to apply.",
  "over-cable-limit": "This route exceeds the cable length limit."
});
function reasonText(reason) { return REASON_TEXT[reason] || "That action is not valid here."; }
function currentAnalysis() { return rules().analyzeWiring(state.design, state.wiring, PART_STATS); }
function currentDataInspection() { return getCachedDesignDataSupport(state.design, state.wiring, PART_STATS, { thermalLoadMode: state.thermalLoadMode || "full" }); }
function partName(type) { return PART_DEFS[type]?.name || PART_STATS[type]?.name || type; }
function moduleLabel(index) { const module = state.design[index]; return module ? `${partName(module.type)} (${module.x},${module.y})` : "Unknown"; }
function bucket(kind = ui().mode) { return state.wiring?.[kind] || { sections: [], connections: [] }; }
function partIndexAt(x, y) { const part = findPartAtCell(state.design, PART_STATS, x, y); return part ? state.design.indexOf(part) : -1; }
function isValidSource(mode, type) { return mode === "data" ? rules().isDataSourceType(type) : rules().isPowerSourceType(type); }
function isValidDestination(mode, sourceType, destinationType) { return mode === "data" ? rules().isCompatibleWeapon(sourceType, destinationType, PART_STATS) : rules().isPowerConsumer(destinationType, PART_STATS); }

function pushUndo() { const stack = ui().undoStack; stack.push(rules().cloneWiring(state.wiring)); if (stack.length > MAX_UNDO) stack.shift(); }
// Every committed wiring edit changes infrastructure cost, so the designer-derived
// presentation (build cost, funds remaining, ship status, analysis) must refresh
// alongside the wiring panel — not just refreshWiringPresentation().
function commitWiring(next) { state.wiring = next; invalidatePreviewCache(); setTransientReason(null); persistDesign(state.design, state.wiring, state.combatStyle); refreshWiringPresentation(); renderLocalStats(); }

function clearLocateHighlight() {
  locatedSectionId = null;
  locatedComponentIndex = null;
  if (locateHighlightTimer) clearTimeout(locateHighlightTimer);
  locateHighlightTimer = null;
}

function scheduleLocateHighlightClear() {
  if (locateHighlightTimer) clearTimeout(locateHighlightTimer);
  locateHighlightTimer = setTimeout(() => {
    locatedSectionId = null;
    locatedComponentIndex = null;
    locateHighlightTimer = null;
    if (state.blueprintView === "wiring") renderWiringOverlay();
  }, 2200);
}

// Tool/tier selection. Data ignores the remembered Power tier.
function setTool(tool) {
  if (!["draw", "erase", "inspect"].includes(tool)) return;
  if (currentTool() === tool) return;
  clearLocateHighlight();
  ui().wiringTool = tool;
  resetInteraction(false);
  ui().hoveredSectionId = null;
  clearWiringHoverCard();
  invalidatePreviewCache();
  setTransientReason(null);
  refreshWiringPresentation();
}
function setTier(tier) {
  if (!POWER_TIERS.includes(tier) || ui().selectedPowerTier === tier) return;
  clearLocateHighlight();
  ui().selectedPowerTier = tier;
  invalidatePreviewCache();
  refreshWiringPresentation();
}

// Erase one physical section (Power or Data). Unrelated sections, all Data
// wiring and powerPolicy are preserved by shared normalisation.
function eraseSectionById(id) {
  if (!id) { setTransientReason("missing-section"); refreshWiringPresentation(); return; }
  pushUndo(); const mode = ui().mode; resetInteraction(); commitWiring(rules().removeSection(state.wiring, mode, id, state.design, PART_STATS));
}
function releasePointerCapture() { if (!pointerDrag) return; const { target, pointerId } = pointerDrag; if (target?.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId); pointerDrag = null; }
function resetInteraction(clearSelection = true) { releasePointerCapture(); suppressNextClick = false; const view = ui(); view.sourceIndex = null; view.path = []; view.hoverCell = null; view.livePointer = null; view.dragging = false; view.activeOrigin = null; view.hoveredPowerShortageNetworkId = null; if (clearSelection) { view.selectedIndex = null; view.selectedConnectionKey = null; view.selectedSectionId = null; view.selectedDataNetworkId = null; view.selectedPowerShortageNetworkId = null; } }
export function resetWiringTransientState({ clearSelection = true } = {}) { resetInteraction(clearSelection); }
export function syncWiringWithDesign() { state.wiring = normalizeWiring(state.wiring, state.design); resetInteraction(); }
export function resetWiringToDefault(options = {}) { state.wiring = normalizeWiring(defaultWiring(), state.design); if (options.resetEditorHistory !== false) resetWiringEditorState(); }
export function clearAllWiring(options = {}) { state.wiring = rules().emptyWiring(); if (options.resetEditorHistory !== false) resetWiringEditorState(); }
export function clearWiringUndoHistory() { ui().undoStack = []; }
export function resetWiringEditorState() { resetWiringTransientState(); clearWiringUndoHistory(); }
export function undoWiring() { if (!ui().undoStack.length) return false; const previous = ui().undoStack.pop(); resetInteraction(); commitWiring(normalizeWiring(previous, state.design)); return true; }

function connectionsAtTerminal(index, kind = ui().mode) { return bucket(kind).connections.filter((connection) => connection.sourceIndex === index || connection.targetIndex === index); }
function selectedConnection() { return bucket().connections.find((connection) => rules().connectionKey(connection) === ui().selectedConnectionKey) || null; }
function selectConnection(connection, index = null) { const view = ui(); view.selectedConnectionKey = connection ? rules().connectionKey(connection) : null; view.selectedSectionId = null; view.selectedIndex = index; refreshWiringPresentation(); }
function inspectComponent(index) {
  clearLocateHighlight();
  const connections = connectionsAtTerminal(index);
  if (connections.length) selectConnection(connections[0], index);
  else { ui().selectedIndex = index; ui().selectedConnectionKey = null; ui().selectedSectionId = null; refreshWiringPresentation(); }
}
function cancelDrawing() { resetInteraction(false); refreshWiringPresentation(); }
function focusStatusPanel() {
  dom.wiringStatusPanel?.style?.removeProperty?.("min-height");
  requestAnimationFrame(() => {
    const panel = dom.wiringStatusPanel;
    if (!panel) return;
    panel.focus({ preventScroll: true });
    const scroller = panel.closest?.(".designer-inspector-panel");
    const stickyTabs = scroller?.querySelector?.(".designer-analysis-tabs");
    if (scroller) scroller.scrollTop = Math.max(0, panel.offsetTop - (stickyTabs?.offsetHeight || 0) - 56);
  });
}
function preserveStatusPanelScroll(action) {
  const panel = dom.wiringStatusPanel;
  const scroller = dom.wiringStatusPanel?.closest?.(".designer-inspector-panel");
  const scrollTop = scroller?.scrollTop;
  const panelHeight = panel?.scrollHeight;
  action();
  if (!scroller || !Number.isFinite(scrollTop)) return;
  if (panel && Number.isFinite(panelHeight) && panel.scrollHeight < panelHeight) {
    panel.style.minHeight = `${panelHeight}px`;
  }
  const restore = () => {
    scroller.scrollTop = Math.min(scrollTop, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
  };
  restore();
  requestAnimationFrame(restore);
}
function removeDrawingStep() { const view = ui(); if (view.sourceIndex == null) return false; if (view.path.length > 1) view.path.pop(); else cancelDrawing(); refreshWiringPresentation(); return true; }

export function handleWiringCellClick(x, y) {
  const view = ui(); const index = partIndexAt(x, y);
  if (view.sourceIndex == null) {
    if (index < 0) { resetInteraction(); refreshWiringPresentation(); return; }
    inspectComponent(index); return;
  }
  if (index < 0) { view.hoverCell = { x, y, valid: false }; refreshWiringPresentation(); return; }
  const last = view.path.at(-1);
  if (view.path.length > 1 && x === view.path.at(-2).x && y === view.path.at(-2).y) { removeDrawingStep(); return; }
  if (x === last.x && y === last.y) { if (view.path.length > 1) commitActivePath(); return; }
  if (Math.abs(last.x - x) + Math.abs(last.y - y) !== 1 || view.path.some((cell) => cell.x === x && cell.y === y)) { view.hoverCell = { x, y, valid: false }; refreshWiringPresentation(); return; }
  view.path.push({ x, y }); view.hoverCell = null;
  refreshWiringPresentation();
}
function beginPath(index, cell) { resetInteraction(false); ui().sourceIndex = index; ui().selectedIndex = index; ui().path = [{ x: cell.x, y: cell.y }]; ui().activeOrigin = { x: cell.x, y: cell.y }; refreshWiringPresentation(); }
function pathOverLimit() { const limit = CABLE_LIMITS[ui().mode]; return Number.isFinite(limit) && rules().countUniqueSections(state.wiring, ui().mode) + rules().additionalLengthForPath(state.wiring, ui().mode, ui().path) > limit; }
function commitActivePath() {
  if (ui().path.length < 2) { setTransientReason("empty-path"); refreshWiringPresentation(); return; }
  if (pathOverLimit()) { setTransientReason("over-cable-limit"); refreshWiringPresentation(); return; }
  const result = rules().applyPathWithTier(state.wiring, ui().mode, ui().path, state.design, PART_STATS, selectedTier());
  if (!result.changed) {
    const reason = result.reason;
    resetInteraction();
    setTransientReason(reason);
    refreshWiringPresentation();
    return;
  }
  pushUndo();
  resetInteraction();
  ui().activeOrigin = null;
  commitWiring(result.wiring);
}
export function handleWiringCellHover(x, y) { if (ui().sourceIndex == null) return; const last = ui().path.at(-1); ui().hoverCell = { x, y, valid: partIndexAt(x, y) >= 0 && Math.abs(last.x - x) + Math.abs(last.y - y) === 1 && !ui().path.some((cell) => cell.x === x && cell.y === y) }; renderWiringOverlay(); }
export function handleWiringGridLeave() { ui().hoverCell = null; if (state.blueprintView === "wiring") renderWiringOverlay(); }

function pointerGridPoint(clientX, clientY) {
  const rect = dom.grid?.getBoundingClientRect(); if (!rect || !rect.width || !rect.height) return null;
  const style = getComputedStyle(dom.grid); const px = (value, fallback = 0) => Number.parseFloat(value) || fallback;
  const left = px(style.borderLeftWidth) + px(style.paddingLeft, 8); const top = px(style.borderTopWidth) + px(style.paddingTop, 8);
  const right = px(style.borderRightWidth) + px(style.paddingRight, 8); const bottom = px(style.borderBottomWidth) + px(style.paddingBottom, 8);
  const gapX = px(style.columnGap || style.gap, 2); const gapY = px(style.rowGap || style.gap, 2);
  const cellWidth = (rect.width - left - right - gapX * (GRID_SIZE - 1)) / GRID_SIZE; const cellHeight = (rect.height - top - bottom - gapY * (GRID_SIZE - 1)) / GRID_SIZE;
  const stepX = cellWidth + gapX; const stepY = cellHeight + gapY;
  // Guard against a mid-layout race where the grid momentarily reports a
  // zero/negative cell size: dividing by it would yield ±Infinity coordinates
  // that render as a giant stray shape in the overlay.
  if (!(stepX > 0) || !(stepY > 0)) return null;
  return { x: (clientX - rect.left - left) / stepX, y: (clientY - rect.top - top) / stepY };
}
function cellFromPointer(clientX, clientY) { const point = pointerGridPoint(clientX, clientY); return point ? { x: Math.floor(point.x), y: Math.floor(point.y) } : null; }
function pointerToSvgPoint(svg, event) {
  const matrix = svg?.getScreenCTM?.(); if (!matrix) return null;
  const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
  return point.matrixTransform(matrix.inverse());
}
function wireEndpointFromEvent(event, kind = ui().mode) {
  const target = event.target?.closest?.("[data-section-id]"); const svg = target?.ownerSVGElement;
  const section = bucket(kind).sections.find((item) => item.id === target?.dataset.sectionId); const pointer = pointerToSvgPoint(svg, event);
  if (!section || !pointer) return null;
  // A widened hit line can overlap another section at a junction. Snap to the
  // canonical cell centre first so either line deterministically chooses the
  // shared endpoint rather than depending on SVG paint order or tiny rounding.
  const snapped = { x: Math.round(pointer.x - .5) + .5, y: Math.round(pointer.y - .5) + .5 };
  return rules().nearestSectionEndpoint(section, snapped);
}
// Supercover-style traversal in pointer order. At an exact corner, the
// dominant physical pointer axis chooses one corner step; no alternate route
// is searched when that cell is empty.
export function interpolatedWiringCells(from, to) {
  const cells = []; let x = Math.floor(from.x); let y = Math.floor(from.y); const endX = Math.floor(to.x); const endY = Math.floor(to.y);
  const dx = to.x - from.x; const dy = to.y - from.y; const sx = Math.sign(dx); const sy = Math.sign(dy);
  const tx = dx ? ((sx > 0 ? x + 1 : x) - from.x) / dx : Infinity; const ty = dy ? ((sy > 0 ? y + 1 : y) - from.y) / dy : Infinity;
  const dtx = dx ? 1 / Math.abs(dx) : Infinity; const dty = dy ? 1 / Math.abs(dy) : Infinity; let nextX = tx; let nextY = ty;
  while ((x !== endX || y !== endY) && cells.length < GRID_SIZE * GRID_SIZE) {
    if (nextX < nextY || (nextX === nextY && Math.abs(dx) >= Math.abs(dy))) { x += sx; nextX += dtx; }
    else { y += sy; nextY += dty; }
    cells.push({ x, y });
  }
  return cells;
}
function extendDraggedPath(cells) {
  const view = ui();
  for (const cell of cells) {
    const last = view.path.at(-1); if (cell.x === last.x && cell.y === last.y) continue;
    if (view.path.length > 1 && cell.x === view.path.at(-2).x && cell.y === view.path.at(-2).y) { view.path.pop(); continue; }
    const valid = cell.x >= 0 && cell.y >= 0 && cell.x < GRID_SIZE && cell.y < GRID_SIZE && partIndexAt(cell.x, cell.y) >= 0 && Math.abs(last.x - cell.x) + Math.abs(last.y - cell.y) === 1 && !view.path.some((item) => item.x === cell.x && item.y === cell.y);
    if (!valid) { view.hoverCell = { ...cell, valid: false }; return false; }
    view.path.push(cell); view.hoverCell = null;
  }
  return true;
}
function finishDraggedConnection(cell) {
  const view = ui(); const index = cell ? partIndexAt(cell.x, cell.y) : -1; const sourceIndex = view.sourceIndex;
  const valid = sourceIndex != null && view.path.length > 1 && index >= 0 && view.path.at(-1).x === cell.x && view.path.at(-1).y === cell.y;
  if (!valid) { cancelDrawing(); return; }
  commitActivePath();
}
function bindPointerDrawing() {
  const pointerSurface = dom.grid?.parentElement; if (!pointerSurface) return;
  pointerSurface.addEventListener("pointerdown", (event) => {
    // Native SVG focus outlines are enormous once this 15x15 viewBox is scaled
    // to the grid. Pointer inspection must not focus the transparent hit line;
    // keyboard focus remains available through tabindex and Enter/Space.
    const inspectHit = event.target.closest?.(".wire-hit[data-section-id]");
    if (state.blueprintView === "wiring" && currentTool() === "inspect" && inspectHit) {
      event.preventDefault();
      return;
    }
    if (state.blueprintView !== "wiring" || event.button !== 0 || event.pointerType === "touch" || ui().sourceIndex != null) return;
    if (currentTool() !== "draw") return; // Draw is the only path-creating tool.
    const target = event.target.closest?.("[data-wiring-port-kind], [data-section-id]"); if (!target) return;
    const point = pointerGridPoint(event.clientX, event.clientY); let cell; let index;
    if (target.dataset.wiringPortKind) { if (target.dataset.wiringPortKind !== ui().mode) return; cell = { x: Number(target.dataset.wiringCellX), y: Number(target.dataset.wiringCellY) }; index = Number(target.dataset.wiringComponentIndex); }
    else { const section = bucket().sections.find((item) => item.id === target.dataset.sectionId); if (!section) return; cell = rules().nearestSectionEndpoint(section, point); index = partIndexAt(cell.x, cell.y); }
    event.preventDefault();
    pointerDrag = { pointerId: event.pointerId, target: pointerSurface, startX: event.clientX, startY: event.clientY, sourceIndex: index, startCell: cell, lastPoint: point, active: false };
  });
  pointerSurface.addEventListener("pointermove", (event) => {
    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return; const point = pointerGridPoint(event.clientX, event.clientY); if (!point) return;
    if (!pointerDrag.active) {
      if (Math.hypot(event.clientX - pointerDrag.startX, event.clientY - pointerDrag.startY) < DRAG_THRESHOLD_PX) return;
      const pending = pointerDrag; pointerDrag = null; resetInteraction();
      pointerDrag = { ...pending, active: true }; suppressNextClick = true; pointerSurface.setPointerCapture(event.pointerId);
      const index = partIndexAt(pointerDrag.startCell.x, pointerDrag.startCell.y); ui().sourceIndex = index; ui().selectedIndex = index; ui().path = [pointerDrag.startCell]; ui().activeOrigin = { ...pointerDrag.startCell }; ui().dragging = true;
    }
    extendDraggedPath(interpolatedWiringCells(pointerDrag.lastPoint, point)); pointerDrag.lastPoint = point; ui().livePointer = point; renderWiringOverlay();
  });
  pointerSurface.addEventListener("pointerup", (event) => { if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return; const active = pointerDrag.active; const point = pointerGridPoint(event.clientX, event.clientY); if (active && point) extendDraggedPath(interpolatedWiringCells(pointerDrag.lastPoint, point)); const cell = cellFromPointer(event.clientX, event.clientY); if (active) finishDraggedConnection(cell); else releasePointerCapture(); });
  pointerSurface.addEventListener("pointercancel", () => { if (pointerDrag?.active) cancelDrawing(); else releasePointerCapture(); });
  window.addEventListener("blur", () => { if (pointerDrag?.active) cancelDrawing(); else releasePointerCapture(); });
}

function removeSelectedSection() { const id = ui().selectedSectionId; if (!id) return; pushUndo(); resetInteraction(); commitWiring(rules().removeSection(state.wiring, ui().mode, id, state.design, PART_STATS)); }
function removeSelectedBranch(endpoint = null) { const id = ui().selectedSectionId; if (!id) return; pushUndo(); const result = rules().removeBranch(state.wiring, ui().mode, id, endpoint, state.design, PART_STATS); resetInteraction(); commitWiring(result.wiring); }
function branchFrom(endpoint) { const section = bucket().sections.find((item) => item.id === ui().selectedSectionId); if (!section) return; const ends = rules().sectionCells(section); const cell = endpoint === "b" ? ends[1] : ends[0]; beginPath(partIndexAt(cell.x, cell.y), cell); ui().selectedSectionId = section.id; }
function selectedNetwork() {
  const analysis = currentAnalysis(); const view = ui();
  if (view.selectedSectionId) return rules().networkForSection(analysis, view.mode, view.selectedSectionId);
  if (view.mode === "data" && view.selectedDataNetworkId) return analysis.data.networks.find((network) => network.id === view.selectedDataNetworkId) || null;
  return view.selectedIndex == null ? null : rules().networkForComponent(analysis, view.mode, view.selectedIndex);
}
function clearableNetwork() {
  const selected = selectedNetwork();
  if (selected) return selected;
  const networks = currentAnalysis()?.[ui().mode]?.networks || [];
  return networks.length === 1 ? networks[0] : null;
}
function clearSelectedNetwork() {
  const network = clearableNetwork();
  if (!network || ui().sourceIndex != null) return;
  state.pendingWiringClearNetwork = { mode: ui().mode, networkId: network.id };
  state.pendingBlueprintDestructiveAction = null;
  state.pendingDeleteDesignId = null;
  state.pendingKickTargetId = null;
  state.blueprintModalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (dom.confirmModalTitle) dom.confirmModalTitle.textContent = `Clear ${network.label || ui().mode + " network"}?`;
  if (dom.confirmModalMessage) dom.confirmModalMessage.textContent = "Every cable section in this network will be removed. You can Undo this afterward.";
  if (dom.confirmAcceptButton) dom.confirmAcceptButton.textContent = "Clear Network";
  if (dom.confirmModal) dom.confirmModal.hidden = false;
  dom.confirmCancelButton?.focus?.();
}
export function confirmPendingWiringClear() {
  const pending = state.pendingWiringClearNetwork;
  if (!pending) return false;
  state.pendingWiringClearNetwork = null;
  const network = currentAnalysis()?.[pending.mode]?.networks?.find((item) => item.id === pending.networkId);
  if (network) {
    pushUndo();
    resetInteraction();
    commitWiring(rules().removeNetwork(state.wiring, pending.mode, network, state.design, PART_STATS));
  }
  if (dom.confirmModal) dom.confirmModal.hidden = true;
  state.blueprintModalReturnFocus?.focus?.();
  state.blueprintModalReturnFocus = null;
  return true;
}
export function cancelPendingWiringClear() {
  if (!state.pendingWiringClearNetwork) return false;
  state.pendingWiringClearNetwork = null;
  if (dom.confirmModal) dom.confirmModal.hidden = true;
  state.blueprintModalReturnFocus?.focus?.();
  state.blueprintModalReturnFocus = null;
  return true;
}
function setMode(mode) {
  if (ui().mode === mode) return;
  clearLocateHighlight(); resetInteraction(); ui().mode = mode; ui().hoveredSectionId = null; clearWiringHoverCard(); invalidatePreviewCache(); setTransientReason(null);
  refreshWiringPresentation();
}

let controlsBound = false;
export function suppressWiringClick() { if (!suppressNextClick) return false; suppressNextClick = false; return true; }
function setWiringHelpOpen(open, { restoreFocus = false } = {}) {
  if (!dom.wiringHelpPanel || !dom.wiringHelpButton) return;
  dom.wiringHelpPanel.hidden = !open;
  dom.wiringHelpButton.setAttribute("aria-expanded", String(open));
  if (open) requestAnimationFrame(() => dom.wiringHelpCloseButton?.focus());
  else if (restoreFocus) dom.wiringHelpButton.focus();
}
export function bindWiringControls() {
  if (controlsBound) return; controlsBound = true;
  bindPointerDrawing();
  dom.wiringModePower?.addEventListener("click", () => setMode("power"));
  dom.wiringModeData?.addEventListener("click", () => setMode("data"));
  dom.wiringUndoButton?.addEventListener("click", undoWiring);
  dom.wiringClearNetworkButton?.addEventListener("click", clearSelectedNetwork);
  dom.wiringHelpButton?.addEventListener("click", () => setWiringHelpOpen(dom.wiringHelpPanel?.hidden !== false));
  dom.wiringHelpCloseButton?.addEventListener("click", () => setWiringHelpOpen(false, { restoreFocus: true }));
  dom.wiringToolbar?.addEventListener("click", (event) => {
    const toolButton = event.target?.closest?.("[data-wiring-tool]");
    if (toolButton && !toolButton.disabled) { setTool(toolButton.dataset.wiringTool); return; }
    const tierButton = event.target?.closest?.("[data-wiring-tier]");
    if (tierButton) setTier(tierButton.dataset.wiringTier);
  });
  // Hover updates only the preview panel and a cheap highlight class — never a
  // full overlay rebuild — so pointer movement does not re-run infrastructure
  // analysis for every frame.
  dom.wiringOverlayHost?.addEventListener("mouseover", (event) => {
    const shortage = event.target?.closest?.("[data-power-shortage-network-id]");
    if (shortage) {
      ui().hoveredPowerShortageNetworkId = shortage.dataset.powerShortageNetworkId;
      applyHoverHighlight();
      renderPowerShortageHoverCard(shortage.dataset.powerShortageNetworkId, shortage);
      return;
    }
    const terminalHit = event.target?.closest?.("[data-power-component-index]");
    if (terminalHit) {
      renderPowerComponentHoverCard(Number(terminalHit.dataset.powerComponentIndex), terminalHit);
      return;
    }
    const id = event.target?.dataset?.sectionId; if (!id || ui().sourceIndex != null) return;
    ui().hoveredSectionId = id; applyHoverHighlight(); renderWiringHoverCard(id, event.target); renderPreviewPanel();
  });
  dom.wiringOverlayHost?.addEventListener("mouseout", (event) => {
    const shortage = event.target?.closest?.("[data-power-shortage-network-id]");
    if (shortage) {
      if (shortage.contains?.(event.relatedTarget)) return;
      ui().hoveredPowerShortageNetworkId = null;
      applyHoverHighlight();
      if (ui().selectedPowerShortageNetworkId) {
        const selected = dom.wiringOverlayHost.querySelector(`[data-power-shortage-network-id="${ui().selectedPowerShortageNetworkId}"]`);
        renderPowerShortageHoverCard(ui().selectedPowerShortageNetworkId, selected);
      } else clearWiringHoverCard();
      return;
    }
    const terminalHit = event.target?.closest?.("[data-power-component-index]");
    if (terminalHit) {
      if (terminalHit.contains?.(event.relatedTarget)) return;
      clearWiringHoverCard();
      return;
    }
    if (!event.target?.dataset?.sectionId) return;
    ui().hoveredSectionId = null; clearWiringHoverCard(); applyHoverHighlight(); renderPreviewPanel();
  });
  dom.wiringOverlayHost?.addEventListener("focusin", (event) => {
    const shortage = event.target?.closest?.("[data-power-shortage-network-id]");
    if (shortage) {
      ui().hoveredPowerShortageNetworkId = shortage.dataset.powerShortageNetworkId;
      applyHoverHighlight();
      renderPowerShortageHoverCard(shortage.dataset.powerShortageNetworkId, shortage);
      return;
    }
    const terminalHit = event.target?.closest?.("[data-power-component-index]");
    if (terminalHit) {
      renderPowerComponentHoverCard(Number(terminalHit.dataset.powerComponentIndex), terminalHit);
      return;
    }
    const id = event.target?.matches?.(".wire-hit[data-section-id]") ? event.target.dataset.sectionId : null;
    if (!id) return;
    dom.wiringOverlayHost.querySelectorAll(".wire-visible-layer [data-section-id]").forEach((element) => {
      element.classList.toggle("wire-section-keyboard-focus", element.dataset.sectionId === id);
    });
  });
  dom.wiringOverlayHost?.addEventListener("focusout", (event) => {
    const shortage = event.target?.closest?.("[data-power-shortage-network-id]");
    if (shortage) {
      ui().hoveredPowerShortageNetworkId = null;
      applyHoverHighlight();
      if (!ui().selectedPowerShortageNetworkId) clearWiringHoverCard();
      return;
    }
    if (event.target?.matches?.("[data-power-component-index]")) {
      clearWiringHoverCard();
      return;
    }
    if (!event.target?.matches?.(".wire-hit[data-section-id]")) return;
    dom.wiringOverlayHost.querySelectorAll(".wire-visible-layer .wire-section-keyboard-focus")
      .forEach((element) => element.classList.remove("wire-section-keyboard-focus"));
  });
  dom.wiringOverlayHost?.addEventListener("click", (event) => {
    if (ui().sourceIndex != null) {
      if (event.button !== 0) return;
      const endpoint = wireEndpointFromEvent(event) || cellFromPointer(event.clientX, event.clientY);
      if (!endpoint) return;
      event.preventDefault(); event.stopPropagation(); handleWiringCellClick(endpoint.x, endpoint.y); return;
    }
    const shortage = event.target?.closest?.("[data-power-shortage-network-id]");
    if (shortage) {
      event.preventDefault(); event.stopPropagation();
      ui().selectedPowerShortageNetworkId = shortage.dataset.powerShortageNetworkId;
      applyHoverHighlight();
      renderPowerShortageHoverCard(shortage.dataset.powerShortageNetworkId, shortage);
      return;
    }
    if (event.target?.closest?.("[data-power-component-index]")) {
      event.stopPropagation();
      return;
    }
    const port = event.target?.closest?.("[data-wiring-port-kind]");
    // Ports only start a Draw path; other tools ignore them.
    if (port && ui().sourceIndex == null) { event.stopPropagation(); if (currentTool() === "draw" && port.dataset.wiringPortKind === ui().mode) beginPath(Number(port.dataset.wiringComponentIndex), { x: Number(port.dataset.wiringCellX), y: Number(port.dataset.wiringCellY) }); return; }
    const id = event.target?.dataset?.sectionId; if (!id) return;
    event.stopPropagation();
    // Tool-aware section click: Erase mutates; Inspect / Draw select.
    if (currentTool() === "erase") { eraseSectionById(id); return; }
    clearLocateHighlight(); resetInteraction(); ui().hoveredSectionId = null; clearWiringHoverCard(); ui().selectedSectionId = id; refreshWiringPresentation(); focusStatusPanel();
  });
  dom.wiringOverlayHost?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const shortage = event.target?.closest?.("[data-power-shortage-network-id]");
    if (shortage) {
      event.preventDefault(); event.stopPropagation();
      ui().selectedPowerShortageNetworkId = shortage.dataset.powerShortageNetworkId;
      applyHoverHighlight();
      renderPowerShortageHoverCard(shortage.dataset.powerShortageNetworkId, shortage);
      return;
    }
    const terminalHit = event.target?.closest?.("[data-power-component-index]");
    if (terminalHit) {
      event.preventDefault(); event.stopPropagation();
      renderPowerComponentHoverCard(Number(terminalHit.dataset.powerComponentIndex), terminalHit);
      return;
    }
    const port = event.target?.closest?.("[data-wiring-port-kind]");
    if (port && ui().sourceIndex == null && currentTool() === "draw" && port.dataset.wiringPortKind === ui().mode) {
      event.preventDefault(); event.stopPropagation();
      beginPath(Number(port.dataset.wiringComponentIndex), { x: Number(port.dataset.wiringCellX), y: Number(port.dataset.wiringCellY) });
      return;
    }
    // Keyboard activation of a focused section honours the active tool.
    const id = event.target?.dataset?.sectionId; if (!id || ui().sourceIndex != null) return;
    event.preventDefault(); event.stopPropagation();
    if (currentTool() === "erase") { eraseSectionById(id); return; }
    clearLocateHighlight(); resetInteraction(); ui().hoveredSectionId = null; clearWiringHoverCard(); ui().selectedSectionId = id; refreshWiringPresentation(); focusStatusPanel();
  });
  dom.wiringOverlayHost?.addEventListener("contextmenu", (event) => {
    const id = event.target?.dataset?.sectionId; if (!id) return; event.preventDefault(); event.stopPropagation();
    if (ui().sourceIndex != null) { removeDrawingStep(); return; }
    ui().selectedSectionId = id; removeSelectedSection();
  });
  document.addEventListener("keydown", (event) => {
    if (state.blueprintView !== "wiring" || event.key !== "Escape") return;
    if (dom.wiringHelpPanel?.hidden === false) { event.preventDefault(); setWiringHelpOpen(false, { restoreFocus: true }); return; }
    if (ui().sourceIndex != null) { event.preventDefault(); cancelDrawing(); focusStatusPanel(); }
  });
  dom.grid?.addEventListener("contextmenu", (event) => {
    if (state.blueprintView !== "wiring") return; event.preventDefault();
    if (ui().sourceIndex != null) { removeDrawingStep(); return; }
    // Component context menus never delete physical cable implicitly.
  });
  dom.wiringStatusPanel?.addEventListener("change", (event) => { const select = event.target?.closest?.("[data-wiring-action=\"data-scenario\"]"); if (!select) return; state.thermalLoadMode = select.value; refreshWiringPresentation(); });
  dom.wiringStatusPanel?.addEventListener("pointerdown", (event) => {
    const action = event.target?.closest?.("[data-wiring-action]")?.dataset?.wiringAction;
    if (action === "remove-section" || action === "remove-branch") event.preventDefault();
  });
  dom.wiringStatusPanel?.addEventListener("click", (event) => {
    const actionButton = event.target?.closest?.("[data-wiring-action]");
    const action = actionButton?.dataset?.wiringAction;
    if (!action) return;
    const issues = dom.wiringStatusPanel?._wiringIssues || [];
    if (action === "locate-issue") locateIssue(issues[Number(actionButton.dataset.issueIndex)], Number(actionButton.dataset.issueIndex));
    else if (action === "upgrade-issue") upgradeIssue(issues[Number(actionButton.dataset.issueIndex)]);
    else if (action === "retry-analysis") refreshWiringPresentation();
    else if (action === "branch-a" || action === "branch-b") branchFrom(action.at(-1));
    else if (action === "remove-section") preserveStatusPanelScroll(removeSelectedSection);
    else if (action === "remove-branch") preserveStatusPanelScroll(removeSelectedBranch);
    else if (action === "inspect-component") { clearLocateHighlight(); inspectComponent(Number(actionButton.dataset.index)); focusStatusPanel(); }
    else if (action === "select-network") { clearLocateHighlight(); ui().selectedDataNetworkId = actionButton.dataset.networkId; ui().selectedIndex = null; ui().selectedSectionId = null; refreshWiringPresentation(); focusStatusPanel(); }
    else if (action === "cancel-selection") { clearLocateHighlight(); resetInteraction(); refreshWiringPresentation(); focusStatusPanel(); }
    else if (action === "cancel-drawing") { cancelDrawing(); focusStatusPanel(); }
    else if (action === "finish") { commitActivePath(); focusStatusPanel(); }
  });
  dom.wiringStatusPanel?.addEventListener("toggle", (event) => {
    const details = event.target?.closest?.("[data-wiring-details]");
    if (!details || !(details.dataset.wiringDetails in analysisDetailsState)) return;
    analysisDetailsState[details.dataset.wiringDetails] = details.open;
  }, true);
}

export function canUndoWiring() { return ui().undoStack.length > 0; }
export function wiringReadinessWarning() {
  try {
    if (!state.design.length) return null;
    const analysis = currentAnalysis();
    const powerSections = bucket("power").sections.length;
    const dataSections = bucket("data").sections.length;
    // Data routes provide optional weapon support and are not a deployment
    // requirement. Only mandatory Power consumers can make a ship incomplete.
    const disconnected = [...new Set(analysis.power.disconnectedConsumerIndices || [])]
      .filter((index) => Number.isInteger(index) && state.design[index]);
    if (powerSections + dataSections === 0) {
      return {
        kind: "no-wiring",
        count: disconnected.length,
        message: `This ship has no Power or Data wiring. ${disconnected.length
          ? `${disconnected.length} component${disconnected.length === 1 ? " is" : "s are"} unable to connect to the ship's Power network.`
          : "Its components cannot use a ship wiring network."} Open Wiring and connect the ship before using this blueprint.`
      };
    }
    if (disconnected.length) {
      const names = disconnected.slice(0, 3).map(moduleLabel);
      const remainder = disconnected.length - names.length;
      return {
        kind: "incomplete-wiring",
        count: disconnected.length,
        message: `${disconnected.length} component${disconnected.length === 1 ? " is" : "s are"} not connected to Power: ${names.join(", ")}${remainder ? `, and ${remainder} more` : ""}. The ship may deploy with systems offline.`
      };
    }
    return null;
  } catch {
    return {
      kind: "analysis-unavailable",
      count: 0,
      message: "Wiring readiness could not be verified. Open Wiring Analysis and resolve the problem before using this blueprint."
    };
  }
}
export function refreshWiringAnalysisPresentation() { bindWiringControls(); renderStatusPanel(); }
export function refreshWiringPresentation() {
  refreshWiringAnalysisPresentation();
  if (state.blueprintView !== "wiring") return;
  refreshToolbar();
  renderWiringOverlay();
  renderPreviewPanel();
}
export function clearWiringPresentation() {
  resetInteraction(false);
  ui().hoveredSectionId = null;
  clearWiringHoverCard();
  invalidatePreviewCache();
  setWiringHelpOpen(false);
  dom.wiringOverlayHost?.replaceChildren();
  dom.grid?.classList.remove("wiring-overlay-active");
  if (dom.wiringPreviewPanel) { dom.wiringPreviewPanel.hidden = true; dom.wiringPreviewPanel.innerHTML = ""; }
  dom.wiringStatusPanel?.style?.removeProperty?.("min-height");
  refreshWiringAnalysisPresentation();
}
const TOOL_HINTS = Object.freeze({
  draw: "Draw through occupied cells. Existing Power cable on the route changes to the selected tier.",
  erase: "Click a Power or Data section to remove it. Unrelated cable and Data wiring are preserved.",
  inspect: "Hover a Power section for live flow and watch energy pulse from its source. Click only to open its detailed analysis."
});

// ---------------------------------------------------------------------------
// Wiring cost/benefit clarity. All displayed capacity, cost, displacement and
// Heat values come from the authoritative balance (WIRING_INFRASTRUCTURE) and
// shared solver/accounting results; WiringClarityRules only holds guidance
// prose and comparison logic. Rendered once — the values never change while
// the designer is open.
// ---------------------------------------------------------------------------
let staticClarityRendered = false;
function renderStaticClarity() {
  const clarity = clarityRules();
  if (staticClarityRendered || !clarity) return;
  staticClarityRendered = true;
  const cards = clarity.tierCards(WIRING_INFRASTRUCTURE);
  document.querySelectorAll("[data-tier-capacity-compact]").forEach((element) => {
    const card = cards.find((item) => item.key === element.dataset.tierCapacityCompact);
    if (card) element.textContent = `${card.sustainedMw} / ${card.peakMw} MW`;
  });
  document.querySelectorAll("[data-tier-meta]").forEach((element) => {
    const card = cards.find((item) => item.key === element.dataset.tierMeta);
    if (card) element.textContent = `$${card.costPerCell} \u00b7 \u2212${card.displacementPerCell} Heat`;
  });
  document.querySelectorAll("[data-wiring-tier]").forEach((button) => {
    const card = cards.find((item) => item.key === button.dataset.wiringTier);
    if (!card) return;
    button.title = `${card.label}: ${card.sustainedMw} MW sustained / ${card.peakMw} MW peak; $${card.costPerCell} and ${card.displacementPerCell} Heat capacity per new cell. ${card.bestFor}`;
  });
  if (dom.wiringTierCardList) {
    dom.wiringTierCardList.innerHTML = cards.map((card) => `
      <article class="wiring-tier-card" data-tier-card="${escapeHtml(card.key)}">
        <h5>${escapeHtml(card.label)}</h5>
        ${card.kind === "power"
          ? `<div class="wiring-summary-line">Capacity: <strong>${card.sustainedMw} MW sustained / ${card.peakMw} MW peak</strong></div>`
          : `<div class="wiring-summary-line">Carries Data only — no capacity, Heat or overload mechanics.</div>`}
        <div class="wiring-summary-line">Cost: <strong>$${card.costPerCell}</strong> per unique cell · Displacement: <strong>${card.displacementPerCell}</strong> Heat capacity per cell</div>
        <div class="wiring-summary-line">Heat: ${escapeHtml(card.heatNote)}</div>
        <div class="wiring-summary-line">Best for: ${escapeHtml(card.bestFor)}</div>
        <div class="wiring-summary-line">Benefit: ${escapeHtml(card.benefit)}</div>
        <div class="wiring-summary-line">Downside: ${escapeHtml(card.downside)}</div>
      </article>`).join("");
  }
  // Tier-button detail text and reference capacities read the same authority.
  document.querySelectorAll("[data-tier-detail]").forEach((element) => {
    const card = cards.find((item) => item.key === element.dataset.tierDetail);
    if (card) element.textContent = `${element.textContent.split(" · ")[0]} · ${card.sustainedMw} / ${card.peakMw} MW`;
  });
  document.querySelectorAll("[data-tier-capacity]").forEach((element) => {
    const card = cards.find((item) => item.key === element.dataset.tierCapacity);
    if (card) element.textContent = `${card.sustainedMw} MW sustained / ${card.peakMw} MW peak`;
  });
  if (dom.architectureComparison) {
    const notes = clarity.ARCHITECTURE_NOTES.map((note) => `
      <div class="architecture-note" data-architecture="${escapeHtml(note.key)}">
        <strong>${escapeHtml(note.label)}.</strong>
        Benefits: ${escapeHtml(note.benefits)}
        Downsides: ${escapeHtml(note.downsides)}
      </div>`).join("");
    const facts = `<ul class="architecture-facts">${clarity.ARCHITECTURE_FACTS.map((fact) => `<li>${escapeHtml(fact)}</li>`).join("")}</ul>`;
    dom.architectureComparison.insertAdjacentHTML("beforeend", notes + facts);
  }
}

function renderToolSummary() {
  const host = dom.wiringToolSummary;
  const clarity = clarityRules();
  if (!host) return;
  if (!clarity) { host.hidden = true; return; }
  const summary = clarity.toolSummary(WIRING_INFRASTRUCTURE, ui().mode, selectedTier());
  host.hidden = false;
  host.innerHTML = `
    <strong data-tool-summary-title>${escapeHtml(summary.title)}</strong>
    <span data-tool-summary-capacity>${escapeHtml(summary.capacityText)}</span>
    <span data-tool-summary-cost>${escapeHtml(summary.costText)} · ${escapeHtml(summary.displacementText)}</span>
    <span class="wiring-tool-summary-hint" data-tool-summary-recommendation>${escapeHtml(summary.recommendation)}</span>
    <span class="wiring-tool-summary-warning" data-tool-summary-warning>${escapeHtml(summary.warning)}</span>`;
}
function refreshToolbar() {
  const power = ui().mode === "power";
  renderStaticClarity();
  renderToolSummary();
  if (dom.wiringTierCards) dom.wiringTierCards.hidden = false;
  dom.wiringModePower?.classList.toggle("active", power); dom.wiringModePower?.setAttribute("aria-pressed", String(power));
  dom.wiringModeData?.classList.toggle("active", !power); dom.wiringModeData?.setAttribute("aria-pressed", String(!power));
  dom.wiringToolbar?.querySelectorAll("[data-wiring-tool]").forEach((button) => {
    const active = button.dataset.wiringTool === currentTool();
    button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));
  });
  // Data has no cable tiers, so the tier row and legend are hidden for Data.
  if (dom.wiringTierRow) dom.wiringTierRow.hidden = !power;
  if (dom.wiringTierLegend) dom.wiringTierLegend.hidden = !power;
  dom.wiringToolbar?.querySelectorAll("[data-wiring-tier]").forEach((button) => {
    const active = button.dataset.wiringTier === selectedTier();
    button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));
  });
  if (dom.wiringUndoButton) dom.wiringUndoButton.disabled = !ui().undoStack.length;
  if (dom.undoBlueprintEditButton && state.blueprintView === "wiring") {
    const wiringUndoAvailable = ui().undoStack.length > 0;
    dom.undoBlueprintEditButton.disabled = !(wiringUndoAvailable || canUndoBlueprintEdit());
    dom.undoBlueprintEditButton.title = wiringUndoAvailable ? "Undo last wiring change (Ctrl+Z)" : "Undo last blueprint edit (Ctrl+Z)";
    dom.undoBlueprintEditButton.setAttribute("aria-label", wiringUndoAvailable ? "Undo last wiring change" : "Undo last blueprint edit");
  }
  if (dom.wiringClearNetworkButton) dom.wiringClearNetworkButton.disabled = ui().sourceIndex != null || !clearableNetwork();
  if (dom.wiringHint) dom.wiringHint.textContent = ui().sourceIndex != null
    ? "Continue through occupied cells; click the last cell or release to finish. Reused trunk sections add no cable length."
    : (power ? TOOL_HINTS[currentTool()] : "Data wiring is single-tier. Draw, erase or inspect Data cable.");
}

// ---------------------------------------------------------------------------
// Section 7C-4 — Power Priority controls and authoritative solver diagnostics.
// The compact preset control lives with the other Blueprint-wide settings in
// the left column. Solver diagnostics remain in the Power Wiring analysis.
// All changes go through the single authoritative policy edit path.
// ---------------------------------------------------------------------------
function policyRules() { return globalThis.PowerPolicyRules; }
function currentPowerPolicy() { const pr = policyRules(); return pr ? pr.normalizePolicy(state.wiring?.powerPolicy) : { preset: "balanced", customOrder: [] }; }
function setPowerPreset(preset) { const pr = policyRules(); if (pr) applyPowerPolicyChange((current) => pr.selectPreset(current, preset)); }
function movePowerPriority(category, direction) { const pr = policyRules(); if (pr) applyPowerPolicyChange((current) => pr.moveCustomCategory(current, category, direction === "up" ? -1 : 1)); }

function renderCustomPowerPriorityOrder(policy) {
  const pr = policyRules();
  if (!pr || policy.preset !== "custom") return "";
  const labels = pr.POWER_CATEGORY_LABELS;
  const rows = policy.customOrder.map((cat, index) => {
    const upDisabled = index === 0 ? " disabled" : "";
    const downDisabled = index === policy.customOrder.length - 1 ? " disabled" : "";
    return `<li class="power-priority-row" data-custom-row data-category="${cat}"><span class="power-priority-number">${index + 1}</span><span class="power-priority-chip" data-category="${cat}">${escapeHtml(labels[cat])}</span><span class="power-priority-move"><button type="button" data-power-priority-move data-category="${cat}" data-direction="up" aria-label="Move ${escapeHtml(labels[cat])} up"${upDisabled}>▲</button><button type="button" data-power-priority-move data-category="${cat}" data-direction="down" aria-label="Move ${escapeHtml(labels[cat])} down"${downDisabled}>▼</button></span></li>`;
  }).join("");
  return `<div class="power-priority-hint">Reorder categories from highest to lowest priority.</div><ol class="power-priority-order">${rows}</ol>`;
}

let powerPriorityControlsBound = false;
export function bindPowerPriorityControls() {
  if (powerPriorityControlsBound) return;
  powerPriorityControlsBound = true;
  dom.powerPrioritySelect?.addEventListener("change", (event) => setPowerPreset(event.target.value));
  dom.powerPriorityCustomOrder?.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-power-priority-move]");
    if (!button || button.disabled) return;
    movePowerPriority(button.dataset.category, button.dataset.direction);
  });
}

export function refreshPowerPriorityControls() {
  const policy = currentPowerPolicy();
  if (dom.powerPrioritySelect) dom.powerPrioritySelect.value = policy.preset;
  if (!dom.powerPriorityCustomOrder) return;
  const isCustom = policy.preset === "custom";
  dom.powerPriorityCustomOrder.hidden = !isCustom;
  dom.powerPriorityCustomOrder.innerHTML = isCustom ? renderCustomPowerPriorityOrder(policy) : "";
}

// The designer prediction uses the authoritative shared solver (never a UI-only
// calculation), with all components intact and nominal source generation so the
// preview reflects the saved Blueprint policy over the current wiring.
function designerPowerFlowFor(wiring) {
  return solveBlueprintPower(Array.isArray(state.design) ? state.design : [], wiring, PART_STATS, WIRING_INFRASTRUCTURE);
}
function designerPowerFlow() { return designerPowerFlowFor(state.wiring); }

// Section flows keyed by id for one wiring value (authoritative solver only).
function sectionFlowsById(wiring) {
  const flow = designerPowerFlowFor(wiring);
  const map = new Map();
  if (flow && Array.isArray(flow.sectionFlows)) for (const f of flow.sectionFlows) map.set(f.sectionId, f);
  return map;
}

function formatHoverMw(value) {
  const rounded = Math.round((Number(value) || 0) * 100) / 100;
  return `${rounded.toLocaleString(undefined, { maximumFractionDigits: 2 })} MW`;
}
function formatNetworkMw(value) { return `${(Number(value) || 0).toFixed(1)} MW`; }
function powerSupplyState(entry) {
  if (!entry || entry.role !== "consumer" || ["disconnected", "unpowered", "destroyed"].includes(entry.state)) return "none";
  if (entry.state === "underpowered" || Number(entry.unmetMw) > 0) return "partial";
  return "full";
}
function generationShortageNetworks(flow) {
  return (flow?.networks || []).filter((network) =>
    Number(network.demandMw) > 0
    && Number(network.availableGenerationMw) + 0.0005 < Number(network.demandMw)
  );
}
function positionWiringHoverCard(target) {
  const card = dom.wiringHoverCard;
  const targetRect = target?.getBoundingClientRect?.();
  const stageRect = dom.gridStage?.getBoundingClientRect?.();
  if (!card || !targetRect || !stageRect) return;
  const gap = 12;
  const cardWidth = card.offsetWidth;
  const cardHeight = card.offsetHeight;
  const anchorX = targetRect.left + targetRect.width / 2 - stageRect.left;
  const anchorY = targetRect.top + targetRect.height / 2 - stageRect.top;
  const left = Math.max(6, Math.min(stageRect.width - cardWidth - 6, anchorX + gap));
  const top = Math.max(6, Math.min(stageRect.height - cardHeight - 6, anchorY + gap));
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}
function showWiringHoverCard(markup, target) {
  const card = dom.wiringHoverCard;
  if (!card) return;
  card.innerHTML = markup;
  card.hidden = false;
  positionWiringHoverCard(target);
}
function renderPowerShortageHoverCard(networkId, target) {
  if (state.blueprintView !== "wiring" || ui().mode !== "power") return clearWiringHoverCard();
  const flow = designerPowerFlow();
  const network = flow?.networks?.find((item) => item.id === networkId);
  if (!network || !generationShortageNetworks(flow).some((item) => item.id === networkId)) return clearWiringHoverCard();
  showWiringHoverCard(`<h4>Power shortage</h4>
    <div class="wiring-hover-flow">${escapeHtml(formatNetworkMw(Math.max(0, Number(network.demandMw) - Number(network.availableGenerationMw))))} short</div>
    <div class="wiring-hover-card-grid">
      <span>Generation</span><strong>${escapeHtml(formatNetworkMw(network.availableGenerationMw))}</strong>
      <span>Requested</span><strong>${escapeHtml(formatNetworkMw(network.demandMw))}</strong>
      <span>Delivered</span><strong>${escapeHtml(formatNetworkMw(network.allocatedMw))}</strong>
      <span>Unmet</span><strong>${escapeHtml(formatNetworkMw(network.unmetMw))}</strong>
    </div>`, target);
}
function renderPowerSourceHoverCard(entry, network, componentIndex, target) {
  const demand = Number(network?.demandMw) || 0;
  const delivered = Number(network?.allocatedMw) || 0;
  const unmet = Number(network?.unmetMw) || 0;
  const stateLabel = !network
    ? "No connected demand"
    : Number(network.availableGenerationMw) + 0.0005 < demand
      ? "Insufficient generation"
      : unmet > 0.0005
        ? "Cable bottleneck"
        : demand <= 0
          ? "No active demand"
          : "Demand supplied";
  showWiringHoverCard(`<h4>${escapeHtml(partName(state.design[componentIndex]?.type))}</h4>
    <div class="wiring-hover-flow">${escapeHtml(stateLabel)}</div>
    <div class="wiring-hover-card-grid">
      <span>Generation</span><strong>${escapeHtml(formatNetworkMw(network ? network.availableGenerationMw : entry.generationAvailableMw))}</strong>
      <span>Requested</span><strong>${escapeHtml(formatNetworkMw(demand))}</strong>
      <span>Delivered</span><strong>${escapeHtml(formatNetworkMw(delivered))}</strong>
      <span>Unmet</span><strong>${escapeHtml(formatNetworkMw(unmet))}</strong>
    </div>`, target);
}
function renderPowerComponentHoverCard(componentIndex, target) {
  if (state.blueprintView !== "wiring" || ui().mode !== "power") return clearWiringHoverCard();
  const flow = designerPowerFlow();
  const entry = flow?.byComponentIndex?.find((item) => item.componentIndex === componentIndex);
  if (!entry) return clearWiringHoverCard();
  const network = (flow.networks || []).find((item) => entry.networkIds?.includes(item.id));
  if (entry.role === "source") return renderPowerSourceHoverCard(entry, network, componentIndex, target);
  if (entry.role !== "consumer") return clearWiringHoverCard();
  const supply = entry.requestedMw > 0 ? Math.round((Number(entry.allocatedMw) / Number(entry.requestedMw)) * 100) : 100;
  const stateLabel = powerSupplyState(entry) === "full" ? "Fully powered" : powerSupplyState(entry) === "partial" ? "Partially powered" : "Unpowered";
  const reason = entry.state === "disconnected"
    ? "No completed Power connection"
    : network && Number(network.availableGenerationMw) + 0.0005 < Number(network.demandMw)
      ? "Insufficient generation"
      : Number(entry.unmetMw) > 0
        ? "Cable bottleneck"
        : "Power demand supplied";
  showWiringHoverCard(`<h4>${escapeHtml(partName(state.design[componentIndex]?.type))}</h4>
    <div class="wiring-hover-flow">${escapeHtml(stateLabel)}</div>
    <div class="wiring-hover-card-grid">
      <span>Requested</span><strong>${escapeHtml(formatNetworkMw(entry.requestedMw))}</strong>
      <span>Delivered</span><strong>${escapeHtml(formatNetworkMw(entry.allocatedMw))}</strong>
      <span>Supply</span><strong>${Math.max(0, Math.min(100, supply))}%</strong>
    </div>
    <div class="wiring-hover-reason">${escapeHtml(reason)}</div>`, target);
}

// Heat-style context card for the exact section under the pointer. Power flow
// comes from the shared solver; Data topology and vulnerability come from the
// same authoritative analyses used by the detailed inspector.
function renderWiringHoverCard(sectionId, hitTarget) {
  const card = dom.wiringHoverCard;
  if (!card || state.blueprintView !== "wiring" || currentTool() !== "inspect") {
    clearWiringHoverCard();
    return;
  }
  const mode = ui().mode;
  const section = bucket(mode).sections.find((item) => item.id === sectionId);
  if (!section) { clearWiringHoverCard(); return; }
  if (mode === "power") {
    const flow = sectionFlowsById(state.wiring).get(section.id) || null;
    const utilisation = flow ? `${Math.round((Number(flow.sustainedUtilisation) || 0) * 100)}%` : "Unavailable";
    const capacity = flow ? formatHoverMw(flow.sustainedCapacityMw) : "Unavailable";
    const overloaded = Boolean(flow?.aboveSustained || flow?.atPeak);
    card.innerHTML = `<h4>${escapeHtml(overloaded ? "Cable overload" : `${tierLabel(section.tier)} Power cable`)}</h4>
      <div class="wiring-hover-flow">${escapeHtml(flow ? formatHoverMw(flow.absoluteFlowMw) : "Flow unavailable")}</div>
      <div class="wiring-hover-card-grid">
        <span>Sustained load</span><strong>${escapeHtml(utilisation)}</strong>
        <span>Cable capacity</span><strong>${escapeHtml(capacity)}</strong>
      </div>`;
  } else {
    const network = rules().networkForSection(currentAnalysis(), "data", section.id);
    const vulnerability = getCachedDataVulnerabilities(state.design, state.wiring, PART_STATS, currentDataInspection())
      .find((item) => item.kind === "section" && item.id === section.id);
    card.innerHTML = `<h4>Data cable</h4>
      <div class="wiring-hover-flow">Signal link</div>
      <div class="wiring-hover-card-grid">
        <span>Network</span><strong>${escapeHtml(network?.label || "Source-less")}</strong>
        <span>Failure impact</span><strong>${escapeHtml(vulnerability?.severity || "none")}</strong>
      </div>`;
  }
  card.hidden = false;
  positionWiringHoverCard(hitTarget);
}
// Sections belonging to the same physical Power network as sectionId within
// an arbitrary wiring value (shared analysis; nothing is mutated).
function routeSectionsFor(wiring, sectionId) {
  try {
    const analysis = rules().analyzeWiring(state.design, wiring, PART_STATS);
    return rules().networkForSection(analysis, "power", sectionId)?.sections || [];
  } catch (_) { return []; }
}
// Total cable-Heat rate of one solved section (both hosted endpoint cells)
// through the authoritative PowerCableThermalRules formula.
function sectionHeatRate(flowRecord, tier) {
  const thermal = cableThermalRules();
  const config = WIRING_INFRASTRUCTURE?.powerTiers?.[tier];
  if (!thermal || !config || !flowRecord) return null;
  try { return thermal.cableHeatRateForSection(flowRecord, config) * 2; } catch (_) { return null; }
}

// Enrich a cached edit preview with clarity data (computed once per hover
// signature — includes one authoritative solve of the proposed wiring).
function attachPreviewClarity(preview, kind, sectionId) {
  const clarity = clarityRules();
  if (!clarity || !preview || !preview.valid || ui().mode !== "power") return preview;
  if (kind === "draw") {
    const proposedFlows = preview.proposedWiring ? sectionFlowsById(preview.proposedWiring) : new Map();
    const currentIds = new Set(bucket("power").sections.map((s) => s.id));
    let predicted = null;
    for (const [id, flow] of proposedFlows) {
      if (currentIds.has(id)) continue;
      const abs = Number(flow.absoluteFlowMw) || 0;
      if (predicted === null || abs > predicted) predicted = abs;
    }
    preview.clarity = { kind, predictedRouteLoadMw: predicted };
  } else if (kind === "tier" && sectionId) {
    const fromTier = bucket("power").sections.find((s) => s.id === sectionId)?.tier || "standard";
    const toTier = selectedTier();
    const currentSectionFlow = sectionFlowsById(state.wiring).get(sectionId) || null;
    const proposedSectionFlow = preview.proposedWiring ? sectionFlowsById(preview.proposedWiring).get(sectionId) || null : null;
    const routeSections = preview.proposedWiring ? routeSectionsFor(preview.proposedWiring, sectionId) : [];
    const toRank = clarity.POWER_TIER_ORDER.indexOf(toTier);
    const weakerTierRemainsOnRoute = routeSections.some((s) => s.id !== sectionId && clarity.POWER_TIER_ORDER.indexOf(s.tier) < toRank);
    preview.clarity = {
      kind,
      comparison: clarity.tierChangeComparison({
        infrastructure: WIRING_INFRASTRUCTURE,
        fromTier, toTier, preview,
        currentSectionFlow, proposedSectionFlow, weakerTierRemainsOnRoute, routeEvidenceAvailable: false,
        currentCableHeatRate: sectionHeatRate(currentSectionFlow, fromTier),
        proposedCableHeatRate: sectionHeatRate(proposedSectionFlow, toTier)
      })
    };
  }
  return preview;
}

function mwText(value) { return `${Math.round((Number(value) || 0) * 100) / 100} MW`; }

function renderPowerPriorityDiagnostics() {
  const pr = policyRules(); const flow = designerPowerFlow();
  if (!pr || !flow || !flow.summary) return "";
  const summary = flow.summary; const labels = pr.POWER_CATEGORY_LABELS;
  // Categories read as a priority ladder, so order by the band the solver actually
  // used (declaration order is meaningless to the player). Every category is still
  // listed — zero-demand ones stay, muted, so the ladder has no gaps.
  const entries = pr.POWER_CATEGORIES.map((cat) => ({
    cat, c: summary.byCategory?.[cat] || { demandMw: 0, allocatedMw: 0, unmetMw: 0, priorityBand: null }
  })).sort((a, b) => {
    const ab = a.c.priorityBand == null ? Infinity : a.c.priorityBand;
    const bb = b.c.priorityBand == null ? Infinity : b.c.priorityBand;
    return ab - bb || pr.POWER_CATEGORIES.indexOf(a.cat) - pr.POWER_CATEGORIES.indexOf(b.cat);
  });
  // One shared scale across every bar so lengths are comparable between rows.
  const scaleMw = Math.max(...entries.map(({ c }) => Number(c.demandMw) || 0), 0);
  const pct = (value) => (scaleMw > 0 ? `${(((Number(value) || 0) / scaleMw) * 100).toFixed(2)}%` : "0%");
  const catRows = entries.map(({ cat, c }) => {
    const demand = Number(c.demandMw) || 0, delivered = Number(c.allocatedMw) || 0, unmet = Number(c.unmetMw) || 0;
    const band = c.priorityBand == null ? "" : String(c.priorityBand + 1);
    const shed = unmet > 0 ? " power-priority-shed" : "";
    const idle = demand <= 0 ? " power-priority-idle" : "";
    // The bar is decorative for AT; the aria-label carries the same numbers.
    // A zero-demand category gets no track at all — an empty bar is a mark that
    // states nothing and costs a row of height.
    const bar = demand > 0
      ? `<span class="power-alloc-track" role="img" title="${escapeHtml(labels[cat])} — ${mwText(demand)} demand · ${mwText(delivered)} delivered · ${mwText(unmet)} unmet" aria-label="${escapeHtml(labels[cat])}: ${mwText(delivered)} delivered of ${mwText(demand)} demand, ${mwText(unmet)} unmet.">
          ${delivered > 0 ? `<span class="power-alloc-fill power-alloc-delivered" style="width:${pct(delivered)}"></span>` : ""}
          ${unmet > 0 ? `<span class="power-alloc-fill power-alloc-unmet" style="width:${pct(unmet)}"></span>` : ""}
        </span>`
      : "";
    // Direct-label only the rows that carry the story. A fully-delivered row is
    // already said by an all-amber bar plus its total, so it stays unlabelled.
    const note = demand <= 0
      ? `<span class="power-alloc-note">No demand</span>`
      : unmet > 0
        ? `<span class="power-alloc-note power-alloc-note-shed">${mwText(unmet)} unmet of ${mwText(demand)}</span>`
        : "";
    // Hidden mirrors keep the machine-readable per-category values addressable.
    // aria-hidden: the visible note and the bar's aria-label already say this, and
    // a screen reader should not hear the same three numbers a third time.
    const values = `<span class="power-alloc-values" aria-hidden="true"><span data-cat-demand>${mwText(demand)} demand</span> · <span data-cat-delivered>${mwText(delivered)} delivered</span> · <span data-cat-unmet>${mwText(unmet)} unmet</span></span>`;
    return `<li class="power-priority-cat-row${shed}${idle}" data-diag-category="${cat}">
      <span class="power-alloc-rank${band ? "" : " is-none"}" aria-label="${band ? `Priority ${band}` : "No priority band"}">${band || "–"}</span>
      <span class="power-priority-chip" data-category="${cat}">${escapeHtml(labels[cat])}</span>
      <span class="power-alloc-total">${mwText(demand)}</span>
      ${bar}${note}${values}
    </li>`;
  }).join("");
  const loadShed = (summary.loadShedCategories || []);
  const shedText = loadShed.length
    ? `Load-shed: ${loadShed.map((c) => labels[c]).join(", ")}` : "No load shedding";
  const unmetTotal = Number(summary.unmetMw) || 0;
  const kpi = (label, value, tone = "") => `<div class="power-alloc-kpi${tone}"><span class="power-alloc-kpi-label">${escapeHtml(label)}</span><strong class="power-alloc-kpi-value">${escapeHtml(mwText(value))}</strong></div>`;
  return `<div class="power-priority-diagnostics" data-power-priority-diagnostics>
    <div class="power-alloc-kpis">
      ${kpi("Generation", summary.availableGenerationMw)}
      ${kpi("Demand", summary.demandMw)}
      ${kpi("Delivered", summary.allocatedMw)}
      ${kpi("Unmet", summary.unmetMw, unmetTotal > 0 ? " power-alloc-kpi-bad" : "")}
    </div>
    <div class="power-alloc-meta">
      <span class="power-alloc-meta-item">${escapeHtml(mwText(summary.spareGenerationMw))} spare</span>
      <span class="power-alloc-meta-item">${escapeHtml(mwText(summary.strandedGenerationMw))} stranded</span>
      <span class="power-alloc-chip${loadShed.length ? " power-alloc-chip-bad" : " power-alloc-chip-ok"}">${escapeHtml(shedText)}</span>
    </div>
    <div class="power-alloc-chart-head">
      <span class="power-priority-diag-heading">Unmet demand by priority</span>
      <span class="power-alloc-legend">
        <span class="power-alloc-key"><i class="power-alloc-swatch power-alloc-delivered"></i>Delivered</span>
        <span class="power-alloc-key"><i class="power-alloc-swatch power-alloc-unmet"></i>Unmet</span>
      </span>
    </div>
    <ul class="power-priority-cat-list">${catRows}</ul>
  </div>`;
}

export function powerAllocationAnalysisHtml() {
  const diagnostics = renderPowerPriorityDiagnostics();
  if (!diagnostics) return "";
  return `<section class="wiring-summary-section" data-wiring-panel="power-allocation"><h4>Power Allocation</h4>${diagnostics}</section>`;
}

function signed(value) { const n = Math.round((Number(value) || 0) * 100) / 100; return n > 0 ? `+${n}` : `${n}`; }
function signedMoney(value) { const n = Math.round((Number(value) || 0) * 100) / 100; return n >= 0 ? `+$${n}` : `-$${Math.abs(n)}`; }
// The Wiring status panel shows hover previews and invalid reasons; toasts are
// reserved for committed actions elsewhere. This keeps hover feedback quiet.
function renderPreviewPanel() {
  const panel = dom.wiringPreviewPanel; if (!panel) return;
  if (state.blueprintView !== "wiring") { panel.hidden = true; panel.innerHTML = ""; return; }
  const preview = hoverPreview();
  if (transientReason) {
    panel.hidden = false;
    panel.innerHTML = `<div class="wiring-preview-reason" role="status">${escapeHtml(reasonText(transientReason))}</div>`;
    return;
  }
  if (!preview) { panel.hidden = true; panel.innerHTML = ""; return; }
  if (!preview.valid) {
    panel.hidden = false;
    panel.innerHTML = `<div class="wiring-preview-reason" role="status">${escapeHtml(reasonText(preview.reason))}</div>`;
    return;
  }
  const capacityLine = `Heat capacity: ${signed(preview.delta.actualHeatCapacity)}`;
  const costLine = `Cost: ${signedMoney(preview.delta.totalInfrastructure)}`;
  const rows = [];
  const tool = currentTool();
  const clarity = clarityRules();
  if (tool === "erase") {
    rows.push(`<div class="wiring-preview-head">Remove ${escapeHtml(ui().mode)} section</div>`);
  } else if (ui().sourceIndex != null) {
    rows.push(`<div class="wiring-preview-head">New sections: ${preview.newSections ?? 0} · New host cells: ${preview.newPowerCells}</div>`);
  }
  rows.push(`<div class="wiring-preview-line">${escapeHtml(costLine)}</div>`);
  rows.push(`<div class="wiring-preview-line">${escapeHtml(capacityLine)}</div>`);
  // Clarity: cell reuse, tier changes, capacity and predicted-load context
  // from the authoritative edit preview and solver.
  if (clarity && preview.clarity?.kind === "draw" && ui().sourceIndex != null) {
    const uniquePathCells = new Set(ui().path.map((cell) => `${cell.x},${cell.y}`)).size;
    const summary = clarity.describeDrawPreview({
      preview, infrastructure: WIRING_INFRASTRUCTURE, mode: ui().mode, tier: selectedTier(),
      pathCellCount: uniquePathCells, predictedRouteLoadMw: preview.clarity.predictedRouteLoadMw
    });
    for (const lineText of summary.lines) rows.push(`<div class="wiring-preview-line" data-preview-clarity>${escapeHtml(lineText)}</div>`);
    for (const warning of summary.warnings) rows.push(`<div class="wiring-preview-warning" data-preview-clarity>⚠ ${escapeHtml(warning)}</div>`);
  }
  if (clarity && preview.clarity?.comparison) {
    const comparison = preview.clarity.comparison;
    const counts = clarity.cellChangeCounts(preview);
    const utilText = (value) => value === null ? "no load estimate" : `${Math.round(value * 100)}% of sustained`;
    const heatText = (value) => value === null ? "Heat estimate unavailable for an incomplete route." : `${value} H/s cable Heat`;
    rows.push(`<div class="wiring-preview-comparison" data-tier-comparison>
      <div class="wiring-preview-line">Cells upgraded: ${counts.upgraded} · downgraded: ${counts.downgraded}</div>
      <div class="wiring-preview-compare-grid">
        <div data-comparison-current><strong>Current — ${escapeHtml(comparison.current.label)}</strong>
          <span>${comparison.current.sustainedMw} / ${comparison.current.peakMw} MW</span>
          <span>$${comparison.current.costPerCell} · ${comparison.current.displacementPerCell} displacement per cell</span>
          <span>${escapeHtml(utilText(comparison.current.utilisation))}</span>
          <span>${escapeHtml(heatText(comparison.current.cableHeatRate))}</span>
        </div>
        <div data-comparison-proposed><strong>Proposed — ${escapeHtml(comparison.proposed.label)}</strong>
          <span>${comparison.proposed.sustainedMw} / ${comparison.proposed.peakMw} MW (${escapeHtml(clarity.signedText(comparison.delta.sustainedMw))} / ${escapeHtml(clarity.signedText(comparison.delta.peakMw))})</span>
          <span>$${comparison.proposed.costPerCell} · ${comparison.proposed.displacementPerCell} displacement per cell</span>
          <span>${escapeHtml(utilText(comparison.proposed.utilisation))}</span>
          <span>${escapeHtml(heatText(comparison.proposed.cableHeatRate))}</span>
        </div>
      </div>
      <div class="wiring-preview-line" data-comparison-benefit>Benefit: ${escapeHtml(comparison.benefit)}</div>
      <div class="wiring-preview-line" data-comparison-drawback>Drawback: ${escapeHtml(comparison.drawback)}</div>
      <div class="wiring-preview-line" data-comparison-verdict><strong>${escapeHtml(comparison.verdict)}</strong></div>
    </div>`);
  }
  const warnings = previewWarnings(preview);
  for (const warning of warnings) rows.push(`<div class="wiring-preview-warning">⚠ ${escapeHtml(warning)}</div>`);
  panel.hidden = false;
  panel.innerHTML = rows.join("");
}

// Warn when an erase would leave a Power consumer without a connected source.
function previewWarnings(preview) {
  if (currentTool() !== "erase" || ui().mode !== "power" || !preview?.proposedWiring) return [];
  let before; let after;
  try {
    before = rules().analyzePowerNetworks(state.design, state.wiring, PART_STATS);
    after = rules().analyzePowerNetworks(state.design, preview.proposedWiring, PART_STATS);
  } catch (_) { return []; }
  const beforeDisconnected = new Set(before.disconnectedConsumerIndices || []);
  const newlyDisconnected = (after.disconnectedConsumerIndices || []).filter((index) => !beforeDisconnected.has(index));
  return newlyDisconnected.map((index) => `disconnects ${moduleLabel(index)}`);
}

function hoverPreview() {
  // The edit/preview module is an optional classic script; if it has not loaded
  // the editor still works, only without live previews.
  if (!editRules()) return null;
  const id = ui().hoveredSectionId;
  const tool = currentTool();
  // Active Draw path preview (multi-section).
  if (ui().sourceIndex != null && ui().path.length > 1) {
    const cells = ui().path.map((cell) => ({ x: cell.x, y: cell.y }));
    const signature = editRules().previewSignature(["draw", ui().mode, selectedTier(), cells]);
    return cachedPreview(signature, () => attachPreviewClarity(editRules().previewPowerPathEdit(state.design, state.wiring, ui().mode, cells, selectedTier(), PART_STATS, WIRING_INFRASTRUCTURE, previewOptions()), "draw", null));
  }
  if (!id) return null;
  if (tool === "erase") {
    const signature = editRules().previewSignature(["erase", ui().mode, id, state.wiring.power.sections.length, state.wiring.data.sections.length]);
    return cachedPreview(signature, () => editRules().previewWiringSectionRemoval(state.design, state.wiring, ui().mode, id, PART_STATS, WIRING_INFRASTRUCTURE, previewOptions()));
  }
  return null;
}
function svgEl(tag, attributes = {}, className = "") { const element = document.createElementNS(SVG_NS, tag); Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value))); if (className) element.setAttribute("class", className); return element; }
function svgGroup(className) { return svgEl("g", {}, className); }
function line(section, className) { return svgEl("line", { x1: section.x1 + 0.5, y1: section.y1 + 0.5, x2: section.x2 + 0.5, y2: section.y2 + 0.5 }, className); }
function moduleRect(index, className) { const module = state.design[index]; if (!module) return null; const stat = PART_STATS[module.type] || PART_STATS.frame; const bounds = getFootprintBounds(module.x, module.y, stat.footprint || { width: 1, height: 1 }, module.rotation || 0); return svgEl("rect", { x: bounds.minX + 0.07, y: bounds.minY + 0.07, width: bounds.width - 0.14, height: bounds.height - 0.14, rx: 0.12, ry: 0.12 }, className); }
function terminal(index, kind, selected) {
  let center;
  try { center = rules().componentCenter(state.design[index], PART_STATS); } catch (_) { return null; }
  const x = Number(center?.x); const y = Number(center?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > GRID_SIZE || y < 0 || y > GRID_SIZE) return null;
  return svgEl("circle", { cx: x, cy: y, r: 0.14 }, `wire-terminal wire-terminal-${kind}${selected ? " wire-terminal-selected" : ""}`);
}
function powerTerminalVisual(index, entry, selected = false) {
  let center;
  try { center = rules().componentCenter(state.design[index], PART_STATS); } catch (_) { return null; }
  const x = Number(center?.x); const y = Number(center?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > GRID_SIZE || y < 0 || y > GRID_SIZE) return null;
  const networkId = entry?.networkIds?.[0] || "";
  const group = svgGroup(`wire-power-terminal wire-power-terminal-${entry?.role || "consumer"}${selected ? " wire-terminal-selected" : ""}`);
  if (networkId) group.dataset.powerNetworkId = networkId;
  if (entry?.role === "source") {
    group.appendChild(svgEl("circle", { cx: x, cy: y, r: 0.14 }, "wire-terminal wire-terminal-power wire-terminal-source"));
    // A hit target so hovering the source (reactor) shows the network's
    // generation vs demand, the same way hovering a consumer/weapon does.
    const hit = svgEl("circle", {
      cx: x, cy: y, r: 0.11, tabindex: 0, role: "button",
      "aria-label": `${moduleLabel(index)}. Power source. ${formatNetworkMw(entry?.generationAvailableMw)} generation.`
    }, "wire-power-terminal-hit");
    hit.dataset.powerComponentIndex = String(index);
    if (networkId) hit.dataset.powerNetworkId = networkId;
    group.appendChild(hit);
    return group;
  }
  const supplyState = powerSupplyState(entry);
  group.classList.add(`wire-terminal-supply-${supplyState}`);
  const supply = Number(entry?.requestedMw) > 0 ? Math.round((Number(entry.allocatedMw) / Number(entry.requestedMw)) * 100) : 0;
  const stateLabel = supplyState === "full" ? "Fully powered" : supplyState === "partial" ? "Partially powered" : "Unpowered";
  group.appendChild(svgEl("circle", { cx: x, cy: y, r: 0.14 }, "wire-terminal wire-terminal-power wire-terminal-supply-ring"));
  if (supplyState === "partial") {
    group.appendChild(svgEl("path", { d: `M ${x} ${y - 0.14} A 0.14 0.14 0 0 1 ${x} ${y + 0.14}` }, "wire-terminal-partial-mark"));
  } else if (supplyState === "none") {
    group.append(
      svgEl("line", { x1: x - 0.075, y1: y - 0.075, x2: x + 0.075, y2: y + 0.075 }, "wire-terminal-unpowered-mark"),
      svgEl("line", { x1: x + 0.075, y1: y - 0.075, x2: x - 0.075, y2: y + 0.075 }, "wire-terminal-unpowered-mark")
    );
  }
  const hit = svgEl("circle", {
    cx: x, cy: y, r: 0.11, tabindex: 0, role: "button",
    "aria-label": `${moduleLabel(index)}. ${stateLabel}. ${formatNetworkMw(entry?.allocatedMw)} delivered of ${formatNetworkMw(entry?.requestedMw)} requested. Supply ${Math.max(0, Math.min(100, supply))}%.`
  }, "wire-power-terminal-hit");
  hit.dataset.powerComponentIndex = String(index);
  if (networkId) hit.dataset.powerNetworkId = networkId;
  group.appendChild(hit);
  return group;
}
const DATA_SECTION_SEVERITY_CLASS = Object.freeze({ critical: "data-critical-section", high: "data-high-impact-section", medium: "data-medium-impact-section", low: "data-low-impact-section", redundant: "data-redundant-section" });
function positiveContributionIndices(weapon) { return new Set((weapon?.contributions || []).filter((item) => Number(item.amount) > 0).map((item) => item.sourceIndex)); }

function renderWiringOverlay() {
  const host = dom.wiringOverlayHost; if (!host || state.blueprintView !== "wiring") return; const view = ui(); clearWiringHoverCard(); host.replaceChildren(); dom.grid?.classList.add("wiring-overlay-active");
  host.classList.toggle("wiring-inspect-hover-active", Boolean(view.hoveredSectionId && view.sourceIndex == null && currentTool() === "inspect"));
  const svg = svgEl("svg", { viewBox: `0 0 ${GRID_SIZE} ${GRID_SIZE}` }, "wiring-overlay"); const selectedNet = selectedNetwork(); const analysis = currentAnalysis(); const dataAnalysis = view.mode === "data" ? currentDataInspection() : null; const dataSource = dataAnalysis?.sourceAllocationByIndex?.[view.selectedIndex]; const dataWeapon = dataAnalysis?.weaponBonusByIndex?.[view.selectedIndex]; const selectedDataNetworkId = selectedNet?.id || dataSource?.networkId || dataWeapon?.networkId || view.selectedDataNetworkId;
  const powerFlow = view.mode === "power" ? designerPowerFlow() : null;
  const powerComponentByIndex = new Map((powerFlow?.byComponentIndex || []).map((entry) => [entry.componentIndex, entry]));
  const powerFlowNetworkBySection = new Map();
  for (const network of powerFlow?.networks || []) for (const sectionId of network.sectionIds || []) powerFlowNetworkBySection.set(sectionId, network);
  const vulnerabilities = view.mode === "data" && dataAnalysis ? getCachedDataVulnerabilities(state.design, state.wiring, PART_STATS, dataAnalysis) : [];
  const sectionVulnerabilityById = new Map(vulnerabilities.filter((item) => item.kind === "section").map((item) => [item.id, item]));
  const hostVulnerabilityByIndex = new Map(vulnerabilities.filter((item) => item.kind === "host").map((item) => [item.componentIndex, item]));
  const selectedSourceActiveRecipients = new Set(dataSource && Number(dataSource.effectiveBudget) > 0 ? dataSource.eligibleWeaponIndices || [] : []);
  const selectedSourceZeroRecipients = new Set(dataSource && Number(dataSource.effectiveBudget) <= 0 ? dataSource.connectedWeaponIndices || [] : []);
  const selectedWeaponActiveContributors = positiveContributionIndices(dataWeapon);
  const selectedWeaponZeroContributors = new Set(dataWeapon ? (dataAnalysis.sources || []).filter((src) => src.networkId === dataWeapon.networkId && !selectedWeaponActiveContributors.has(src.sourceIndex)).map((src) => src.sourceIndex) : []);
  const glowLayer = svgGroup("wire-glow-layer");
  const visibleLayer = svgGroup("wire-visible-layer"); const energyLayer = svgGroup("wire-energy-layer"); const hitLayer = svgGroup("wire-hit-layer");
  const markerLayer = svgGroup("wire-marker-layer"); const indicatorLayer = svgGroup("wire-indicator-layer"); const warningLayer = svgGroup("wire-warning-layer"); const portLayer = svgGroup("wire-port-layer");
  // SVG paint order is also hit-test order. The glow layer is drawn first (below
  // everything) so status halos read as an outer ring while the tier-coloured
  // cable stays on top. Ports remain last so they win hit testing over cable.
  svg.append(glowLayer, visibleLayer, energyLayer, hitLayer, markerLayer, indicatorLayer, warningLayer, portLayer);
  // Section 7D-2: per-section delivered flow status from the shared solver, used
  // for the load/above-sustained/at-peak overlays (never replaces tier colour).
  const powerFlowBySection = new Map();
  if (view.mode === "power" && Array.isArray(powerFlow?.sectionFlows)) for (const flow of powerFlow.sectionFlows) powerFlowBySection.set(flow.sectionId, flow);
  const POWER_STATUS_TEXT = { working: "fully supplied", loaded: "partially supplied", above: "cable above sustained capacity", peak: "cable at peak capacity", broken: "no Power delivered" };
  for (const section of bucket().sections) {
    const netForSection = view.mode === "data" ? dataAnalysis?.networks?.find((network) => network.sectionIds.includes(section.id)) : null;
    const isSelected = selectedNet?.sectionIds.includes(section.id) || (view.mode === "data" && selectedDataNetworkId && netForSection?.id === selectedDataNetworkId);
    const powerNetwork = view.mode === "power" ? powerFlowNetworkBySection.get(section.id) : null;
    const sectionFlow = view.mode === "power" ? powerFlowBySection.get(section.id) : null;
    const dim = view.mode === "data" && selectedDataNetworkId && netForSection?.id !== selectedDataNetworkId ? " data-dimmed" : "";
    const sectionVulnerability = sectionVulnerabilityById.get(section.id);
    const severityClass = view.mode === "data" ? DATA_SECTION_SEVERITY_CLASS[sectionVulnerability?.severity] || "" : "";
    // Tier-specific stroke width. The rendered thickness is authoritative balance
    // data; only the VISIBLE stroke scales, never the hit target (a separate wide
    // line below), so Light cable stays easy to tap.
    const tierClass = view.mode === "power" ? ` wire-tier-${section.tier || "standard"}` : "";
    const hovered = ui().hoveredSectionId === section.id && ui().sourceIndex == null;
    const previewClass = hovered && currentTool() === "erase" ? " wire-section-preview" : hovered && currentTool() === "inspect" ? " wire-section-hover" : "";
    // Power status is an OVERLAY (halo), so the tier colour on the visible line is
    // never replaced. Determine the status severity from connectivity + flow.
    let powerSeverity = null;
    let supplyState = null;
    if (view.mode === "power") {
      const delivered = Number(sectionFlow?.absoluteFlowMw) || 0;
      supplyState = delivered <= 0.0005 ? "none" : Number(powerNetwork?.unmetMw) > 0.0005 ? "partial" : "full";
      if (sectionFlow && sectionFlow.atPeak) powerSeverity = "peak";
      else if (sectionFlow && sectionFlow.aboveSustained) powerSeverity = "above";
      else if (supplyState === "none") powerSeverity = "broken";
      else if (supplyState === "partial") powerSeverity = "loaded";
      else powerSeverity = "working";
    }
    if (view.mode === "power") {
      const haloWidth = (extra) => (Number(renderedStrokeWidth(section.tier)) + extra).toFixed(3);
      // Operational status remains visible, but clicking a section has no
      // persistent grid effect: Inspect communicates selection in the panel.
      if (powerSeverity) { const st = line(section, `wire-status-halo wire-status-${powerSeverity}${tierClass}`); st.style.strokeWidth = haloWidth(0.07); st.dataset.sectionId = section.id; glowLayer.appendChild(st); }
      if (powerSeverity === "peak") { const mx = (section.x1 + section.x2) / 2 + 0.5; const my = (section.y1 + section.y2) / 2 + 0.5; glowLayer.appendChild(svgEl("circle", { cx: mx, cy: my, r: 0.09 }, "wire-status-peak-marker")); }
    }
    // Explicit Data-network selection from the analysis panel may still compare
    // a whole network. Clicking a physical section never recolours the grid.
    const selectedClass = view.mode === "data" && view.selectedDataNetworkId && isSelected ? " wire-net-selected" : "";
    const locateClass = locatedSectionId === section.id ? " wire-section-locate" : "";
    const supplyClass = view.mode === "power" ? ` wire-supply-${supplyState || "none"}` : "";
    const visible = line(section, `wire-${view.mode}${tierClass}${supplyClass}${dim}${selectedClass}${severityClass ? ` ${severityClass}` : ""}${previewClass}${locateClass}`);
    if (view.mode === "power") {
      visible.style.strokeWidth = renderedStrokeWidth(section.tier);
      if (powerSeverity) visible.dataset.powerStatus = powerSeverity;
      if (powerNetwork) {
        visible.dataset.networkId = powerNetwork.id;
        visible.dataset.powerNetworkId = powerNetwork.id;
      }
    }
    visible.dataset.sectionId = section.id; visibleLayer.appendChild(visible);
    if (view.mode === "power" && powerNetwork && Number(sectionFlow?.absoluteFlowMw) > 0) {
      const directionClass = Number(sectionFlow.signedFlowMw) < 0 ? "wire-energy-reverse" : "wire-energy-forward";
      const pulse = line(section, `wire-energy-pulse ${directionClass} wire-energy-${supplyState}`);
      pulse.dataset.networkId = powerNetwork.id;
      pulse.dataset.powerNetworkId = powerNetwork.id;
      pulse.dataset.sectionId = section.id;
      energyLayer.appendChild(pulse);
    }
    const tierText = view.mode === "power" ? `. ${tierLabel(section.tier)}` : "";
    const statusText = view.mode === "power" && powerSeverity ? `. Status: ${POWER_STATUS_TEXT[powerSeverity]}.` : "";
    const severityText = view.mode === "data" ? `. Vulnerability: ${sectionVulnerability?.severity || "unknown"}.` : "";
    const hit = line(section, "wire-hit"); hit.dataset.sectionId = section.id; hit.setAttribute("tabindex", "0"); hit.setAttribute("role", "button"); hit.setAttribute("aria-label", `${sectionActionVerb()} ${view.mode} cable section from ${section.x1},${section.y1} to ${section.x2},${section.y2}${tierText}${statusText}${severityText}`); hitLayer.appendChild(hit);
  }
  if (view.mode === "power") {
    for (const network of powerFlow?.networks || []) {
      for (const sourceIndex of network.sourceIndices) {
        const sourcePulse = moduleRect(sourceIndex, "wire-energy-source");
        if (!sourcePulse) continue;
        sourcePulse.dataset.networkId = network.id;
        sourcePulse.dataset.powerNetworkId = network.id;
        sourcePulse.dataset.sourceIndex = String(sourceIndex);
        energyLayer.appendChild(sourcePulse);
      }
    }
  }
  rules().junctionCells(bucket()).forEach((cell) => markerLayer.appendChild(svgEl("circle", { cx: cell.x + .5, cy: cell.y + .5, r: .09, "data-junction-degree": cell.degree }, "wire-junction")));
  // Terminals mark the components a network actually *uses* for the active mode —
  // sources plus consumers for Power, sources plus compatible weapons for Data.
  // A cable may route across any occupied cell, but those pass-through hosts
  // (network.hostIndices) are not terminals and must not be marked as such.
  const selectedTerminalIndices = new Set(view.selectedSectionId ? [] : selectedNet?.componentIndices || []);
  if (view.mode === "power") {
    const terminalIndices = new Set();
    powerComponentByIndex.forEach((entry, index) => {
      if (entry.role === "source" || entry.role === "consumer") terminalIndices.add(index);
    });
    [...terminalIndices].sort((a, b) => a - b).forEach((index) => {
      const entry = powerComponentByIndex.get(index);
      const marker = powerTerminalVisual(index, entry, selectedTerminalIndices.has(index));
      if (marker) indicatorLayer.appendChild(marker);
      if (entry?.role !== "consumer") return;
      const networkId = entry.networkIds?.[0] || "";
      const supplyState = powerSupplyState(entry);
      const rect = moduleRect(index, `wire-component-supply wire-component-supply-${supplyState}`);
      if (rect) {
        if (networkId) rect.dataset.powerNetworkId = networkId;
        indicatorLayer.appendChild(rect);
      }
    });
  } else {
    const terminalIndices = new Set(selectedTerminalIndices);
    for (const network of analysis.data?.networks || []) for (const index of network.componentIndices) terminalIndices.add(index);
    [...terminalIndices].sort((a, b) => a - b).forEach((index) => {
      const marker = terminal(index, view.mode, selectedTerminalIndices.has(index));
      if (marker) indicatorLayer.appendChild(marker);
    });
  }
  if (view.mode === "power") {
    // Underpowered networks are surfaced through the source (reactor) terminal
    // hover card and the per-consumer supply rings — not a floating badge that
    // covers the grid. The source module keeps a subtle amber highlight.
    for (const network of generationShortageNetworks(powerFlow)) {
      for (const sourceIndex of network.sourceIndices) {
        const sourceRect = moduleRect(sourceIndex, "wire-component-supply wire-component-supply-source");
        if (sourceRect) { sourceRect.dataset.powerNetworkId = network.id; indicatorLayer.appendChild(sourceRect); }
      }
    }
  }
  // Only the active mode's source ports are drawable, so only they are drawn: a
  // Power port shown in Data mode is dead UI (the click handler rejects it) and
  // makes the two modes look identical. One kind renders, so it sits centred.
  state.design.forEach((module, index) => rules().moduleCells(module, PART_STATS).forEach((cell) => {
    if (!isValidSource(view.mode, module.type)) return;
    const kind = view.mode;
    const port = svgEl("circle", { cx: cell.x + .5, cy: cell.y + .5, r: .11, tabindex: 0, role: "button", "aria-label": `Start ${kind} cable from ${moduleLabel(index)}` }, `wire-port wire-port-${kind} source`);
    port.dataset.wiringPortKind = kind; port.dataset.wiringComponentIndex = index; port.dataset.wiringCellX = cell.x; port.dataset.wiringCellY = cell.y; portLayer.appendChild(port);
  }));
  if (view.mode === "data" && dataAnalysis) {
    dataAnalysis.sources.forEach((src) => { const rel = dataSource ? (src.sourceIndex === dataSource.sourceIndex ? " wire-comp-data-source-selected" : " wire-comp-data-unrelated") : dataWeapon ? (selectedWeaponActiveContributors.has(src.sourceIndex) ? " wire-comp-data-contributor-active" : selectedWeaponZeroContributors.has(src.sourceIndex) ? " wire-comp-data-contributor-zero" : " wire-comp-data-unrelated") : ""; const cls = src.status === "active" ? "wire-comp-data-source-active" : src.status === "underpowered" ? "wire-comp-data-source-underpowered" : src.status === "thermally-reduced" ? "wire-comp-data-source-underpowered" : src.status === "overheated" ? "wire-comp-data-source-overheated" : src.status === "unpowered" ? "wire-comp-data-source-unpowered" : "wire-comp-data-source-underpowered"; const rect = moduleRect(src.sourceIndex, `${cls}${rel}`); if (rect) { rect.setAttribute("aria-label", `${moduleLabel(src.sourceIndex)} Data source status ${src.status}${rel ? `. Relationship: ${rel.trim().replace("wire-comp-data-", "").replaceAll("-", " ")}.` : ""}`); indicatorLayer.appendChild(rect); } });
    dataAnalysis.weapons.forEach((wpn) => { const rel = dataWeapon ? (wpn.weaponIndex === dataWeapon.weaponIndex ? " wire-comp-data-weapon-selected" : " wire-comp-data-unrelated") : dataSource ? (selectedSourceActiveRecipients.has(wpn.weaponIndex) ? " wire-comp-data-recipient-active" : selectedSourceZeroRecipients.has(wpn.weaponIndex) ? " wire-comp-data-recipient-zero" : " wire-comp-data-unrelated") : ""; const rect = moduleRect(wpn.weaponIndex, `${wpn.status === "supported" ? "wire-comp-data-weapon-supported" : "wire-comp-data-weapon-unsupported"}${rel}`); if (rect) { rect.setAttribute("aria-label", `${moduleLabel(wpn.weaponIndex)} Data weapon status ${wpn.status}${rel ? `. Relationship: ${rel.trim().replace("wire-comp-data-", "").replaceAll("-", " ")}.` : ""}`); indicatorLayer.appendChild(rect); } });
    if (view.selectedIndex != null && !dataSource && !dataWeapon) {
      const hostVulnerability = hostVulnerabilityByIndex.get(view.selectedIndex);
      const hostClasses = ["wire-comp-data-host-selected"];
      if (hostVulnerability?.severity === "critical") hostClasses.push("wire-comp-data-host-critical");
      else if (hostVulnerability?.severity === "high") hostClasses.push("wire-comp-data-host-high");
      else if (hostVulnerability?.severity === "redundant") hostClasses.push("wire-comp-data-host-redundant");
      const rect = moduleRect(view.selectedIndex, hostClasses.join(" ")); if (rect) { rect.setAttribute("aria-label", `${moduleLabel(view.selectedIndex)} Data cable host selected. Vulnerability: ${hostVulnerability?.severity || "none"}.`); indicatorLayer.appendChild(rect); }
    }
  }
  if (view.selectedIndex != null) { const rect = moduleRect(view.selectedIndex, "wire-comp-selected"); if (rect) indicatorLayer.appendChild(rect); }
  if (locatedComponentIndex != null) { const rect = moduleRect(locatedComponentIndex, "wire-component-locate"); if (rect) indicatorLayer.appendChild(rect); }
  if (view.sourceIndex != null) {
    const sourceType = state.design[view.sourceIndex]?.type; state.design.forEach((module, index) => { if (sourceType && index !== view.sourceIndex && isValidDestination(view.mode, sourceType, module.type)) { const rect = moduleRect(index, "wire-comp-candidate"); if (rect) indicatorLayer.appendChild(rect); } });
    for (let i = 1; i < view.path.length; i += 1) visibleLayer.appendChild(line({ x1: view.path[i - 1].x, y1: view.path[i - 1].y, x2: view.path[i].x, y2: view.path[i].y }, `wire-preview confirmed wire-preview-${view.mode}`));
    if (view.activeOrigin) markerLayer.appendChild(svgEl("circle", { cx: view.activeOrigin.x + .5, cy: view.activeOrigin.y + .5, r: .18 }, "wire-branch-origin"));
    if (view.dragging && view.livePointer) { const last = view.path.at(-1); const clampCoord = (v) => Math.max(0, Math.min(GRID_SIZE, Number.isFinite(v) ? v : 0)); const px = clampCoord(view.livePointer.x); const py = clampCoord(view.livePointer.y); visibleLayer.appendChild(svgEl("line", { x1: last.x + .5, y1: last.y + .5, x2: px, y2: py }, `wire-preview ${view.hoverCell && !view.hoverCell.valid ? "invalid" : "valid"} wire-preview-${view.mode}`)); }
    const last = view.path.at(-1); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const x = last.x + dx; const y = last.y + dy; if (partIndexAt(x, y) >= 0 && !view.path.some((cell) => cell.x === x && cell.y === y)) markerLayer.appendChild(svgEl("circle", { cx: x + 0.5, cy: y + 0.5, r: 0.12 }, "wire-next-cell")); }
    if (view.hoverCell && !view.hoverCell.valid) markerLayer.appendChild(svgEl("circle", { cx: view.hoverCell.x + 0.5, cy: view.hoverCell.y + 0.5, r: 0.15 }, "wire-invalid-cell"));
  }
  host.appendChild(svg);
  applyHoverHighlight();
}

function pct(value) { return `${Math.round((Number(value) || 0) * 100)}%`; }
function statLine(label, base, effective, suffix = "") { if (!Number.isFinite(Number(base))) return ""; return `<div class="wiring-summary-line"><strong>${label}:</strong> ${Number(base).toFixed(label === "Accuracy" ? 0 : 2)}${suffix} → ${Number(effective).toFixed(label === "Accuracy" ? 0 : 2)}${suffix}</div>`; }
function renderDataInspectionPanel(panel, section) {
  let analysis;
  try { analysis = currentDataInspection(); } catch (error) { console.error("Data-support inspection failed", error); panel.hidden = false; panel.innerHTML = `<h3>Data-support inspection</h3><div role="status" class="wiring-summary-line">Data-inspection error. Switch views or edit wiring to retry.</div>`; return true; }
  const selectedIndex = ui().selectedIndex;
  const source = analysis.sourceAllocationByIndex[selectedIndex];
  const weapon = analysis.weaponBonusByIndex[selectedIndex];
  const vuln = getCachedDataVulnerabilities(state.design, state.wiring, PART_STATS, analysis);
  const network = selectedNetwork() || (source?.networkId ? analysis.networks.find(n => n.id === source.networkId) : null) || (weapon?.networkId ? analysis.networks.find(n => n.id === weapon.networkId) : null);
  const selectedHost = selectedIndex != null && !source && !weapon ? vuln.find(v => v.kind === "host" && v.componentIndex === selectedIndex) : null;
  const selectedSourceVulnerability = source ? vuln.find(v => v.kind === "source" && v.componentIndex === source.sourceIndex) : null;
  const fmtBonus = (v, f) => formatDataSupportValue({ bonusField: f || "accuracyBonus", amount: v });
  const lossesHtml = (hit) => !hit ? "No predicted support loss." : [ ["rangeBonus", hit.lostRangeBonus], ["accuracyBonus", hit.lostAccuracyBonus], ["fireRateBonus", hit.lostFireRateBonus] ].filter(([,v]) => Number(v) > 0).map(([f,v]) => formatDataSupportValue({ bonusField:f, amount:v })).join(" · ") || "No predicted support loss.";
  const inspectionRoleLabel = (role) => role ? role.split("-").map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" ") : "Component";
  const buttons = (indices, role) => indices.map(i => `<button type="button" data-wiring-action="inspect-component" data-index="${i}" data-inspection-role="${escapeHtml(role)}" aria-label="Inspect ${escapeHtml(moduleLabel(i))} ${escapeHtml(inspectionRoleLabel(role).toLowerCase())}">${escapeHtml(moduleLabel(i))}</button>`).join(" ") || "None";
  let body = `<h3>Data-support inspection</h3><div id="data-support-live" aria-live="polite" class="sr-only">Data support prediction refreshed for ${escapeHtml(analysis.scenarioLabel)}.</div><label class="wiring-summary-line data-scenario-label">Prediction scenario <select data-wiring-action="data-scenario" aria-label="Data support prediction scenario"><option value="idle" ${analysis.scenario === "idle" ? "selected" : ""}>Idle</option><option value="combat" ${analysis.scenario === "combat" ? "selected" : ""}>Typical Combat</option><option value="full" ${analysis.scenario === "full" ? "selected" : ""}>Maximum Sustained Load</option></select></label>`;
  body += `<div class="wiring-summary-line">${analysis.networks.length} physical Data networks · ${analysis.sources.filter(s => s.effectiveBudget > 0).length} active sources · ${analysis.weapons.filter(w => w.status === "supported").length} supported weapons · ${analysis.cableSectionCount} cable sections</div>`;
  if (source) {
    body += `<section class="wiring-summary-section" data-data-inspector="source"><h4>${escapeHtml(partName(source.sourceType))} — ${escapeHtml(source.status)}</h4><div class="wiring-summary-line">Network: ${escapeHtml(source.networkLabel || "Disconnected")}</div><div class="wiring-summary-line">Effect: ${escapeHtml(source.effect)} · nominal ${fmtBonus(source.nominalBudget, source.bonusField)}</div><div class="wiring-summary-line">Power ${pct(source.predictedPowerMultiplier)} · Heat ${pct(source.predictedThermalMultiplier)} · Operational ${pct(source.predictedOperationalMultiplier)} · Final ${pct(source.predictedSourceMultiplier)}</div><div class="wiring-summary-line">Effective budget ${fmtBonus(source.effectiveBudget, source.bonusField)} · recipients ${source.recipientCount} · each receives ${fmtBonus(source.bonusPerWeapon, source.bonusField)}</div><div class="wiring-summary-line">${escapeHtml(source.statusReason)}</div><div class="wiring-summary-line">${escapeHtml(partName(source.sourceType))} effective budget: ${escapeHtml(formatDataSupportEquation(source))}.</div><div class="wiring-summary-line">Connected weapons: ${buttons(source.connectedWeaponIndices, "recipient")}</div><div class="wiring-summary-line"><strong>Failure impact:</strong> ${escapeHtml(selectedSourceVulnerability?.severity || "redundant")} · lost ${escapeHtml(lossesHtml(selectedSourceVulnerability))}. ${selectedSourceVulnerability?.severity === "redundant" ? "Another source fully preserves current output." : "Other Data sources remain operational where connected."}</div></section>`;
  } else if (weapon) {
    const b = weapon.baseProfile, e = weapon.effectiveProfile;
    body += `<section class="wiring-summary-section" data-data-inspector="weapon"><h4>${escapeHtml(partName(weapon.weaponType))} — ${escapeHtml(weapon.status)}</h4><div class="wiring-summary-line">Network: ${escapeHtml(weapon.networkLabel || "Disconnected")}</div><div class="wiring-summary-line">${escapeHtml(weapon.statusReason)}</div><div class="wiring-summary-line">Contributing sources: ${buttons(weapon.sourceIndices, "contributor")}</div>${statLine("Range", b.range, e.range, "")}${statLine("Accuracy", (b.accuracy || 0) * 100, (e.accuracy || 0) * 100, "%")}${statLine("Fire rate", b.fireRate, e.fireRate, "/s")}${statLine("Reload", b.reload, e.reload, "ms")}${statLine("DPS", b.dps, e.dps, "")}`;
    if (!weapon.contributions.length) body += `<div class="wiring-summary-line">Operating at base stats.</div>`;
    else body += weapon.contributions.map(c => `<div class="wiring-summary-line">${escapeHtml(partName(c.sourceType))}: ${fmtBonus(c.amount, c.bonusField)} ${escapeHtml(c.effect || c.bonusField)} (${fmtBonus(c.effectiveBudget, c.bonusField)} ÷ ${c.recipientCount})</div>`).join("");
    body += `</section>`;
  }
  if (network) body += `<section class="wiring-summary-section" data-data-inspector="network"><h4>${escapeHtml(network.label)}</h4><div class="wiring-summary-line">Sources: ${buttons(network.sourceIndices, "network-source")}</div><div class="wiring-summary-line">Weapons: ${buttons(network.weaponIndices, "network-weapon")}</div></section>`;
  if (selectedHost) body += `<section class="wiring-summary-section" data-data-inspector="host-vulnerability"><h4>${escapeHtml(moduleLabel(selectedHost.componentIndex))}</h4><div class="wiring-summary-line">Hosts Data cable sections. Failure impact: <strong>${escapeHtml(selectedHost.severity)}</strong></div><div class="wiring-summary-line">Topology changes: ${selectedHost.topologyChanged ? "yes" : "no"} · ${escapeHtml(selectedHost.summary)}</div><div class="wiring-summary-line">Lost support: ${escapeHtml(lossesHtml(selectedHost))}</div><div class="wiring-summary-line">Redundancy: ${selectedHost.severity === "redundant" ? "redundant route preserves connectivity" : "single point of failure for listed support"}</div></section>`;
  if (section) {
    const hit = vuln.find(v => v.kind === "section" && v.id === section.id);
    // Data-section clarity: authoritative per-cell cost/displacement only —
    // Data has no Power capacity, Heat or overload rows by design.
    const dataConfig = WIRING_INFRASTRUCTURE?.data || {};
    const cellCost = (Number(dataConfig.costPerHostedCell) || 0) * 2;
    const cellDisplacement = (Number(dataConfig.heatCapacityDisplacement) || 0) * 2;
    const dataClarity = clarityRules() ? `<div class="wiring-summary-line" data-data-section-cost>Selected cells: $${cellCost} cost · ${cellDisplacement} Heat-capacity displacement</div><div class="wiring-summary-line" data-data-section-note>${escapeHtml(clarityRules().EMPTY_STATES.dataNoPower)} No capacity, Heat or overload mechanics.</div>` : "";
    body += `<section class="wiring-summary-section" data-data-inspector="section-vulnerability"><h4>Selected Data section</h4><div class="wiring-summary-line">(${section.x1},${section.y1}) ↔ (${section.x2},${section.y2}) · ${escapeHtml(hit?.severity || "ordinary")}</div>${dataClarity}<div class="wiring-summary-line">${escapeHtml(hit?.summary || "No predicted support loss.")}</div><div class="wiring-summary-line">Lost support: ${escapeHtml(lossesHtml(hit))}</div></section>`;
  }
  if (!source && !weapon && !section) body += `<section class="wiring-summary-section" data-data-inspector="overview"><h4>Networks</h4>${analysis.networks.map(n => `<button type="button" aria-selected="${network?.id === n.id}" data-wiring-action="select-network" data-network-id="${escapeHtml(n.id)}">${escapeHtml(n.label)} · ${n.sourceIndices.length} sources · ${n.weaponIndices.length} weapons${n.sourceIndices.length ? "" : " · no source"}</button>`).join(" ") || "<div class=\"wiring-summary-line\">No Data networks yet.</div>"}</section>`;
  const warnings = [...analysis.networks.filter(n => !n.sourceIndices.length && n.weaponIndices.length).map(n => `${n.label} has weapons but no support source.`), ...analysis.sources.filter(s => s.predictedPowerMultiplier <= 0 && s.networkId).map(s => `${partName(s.sourceType)} is connected to Data but has no Power.`), ...analysis.sources.filter(s => s.predictedThermalMultiplier < 1).map(s => `${partName(s.sourceType)} is predicted thermally reduced in ${analysis.scenarioLabel}.`)];
  body += warnings.length ? `<section class="wiring-summary-section"><h4>Warnings</h4>${warnings.slice(0, 5).map(w => `<div class="wiring-summary-line">⚠ ${escapeHtml(w)}</div>`).join("")}</section>` : "";
  panel.hidden = false; panel.tabIndex = -1; panel.innerHTML = body;
  return true;
}

// Non-destructive Power cable inspection. Capacity is labelled a static "Cable
// rating" — no flow/utilisation/overload is implied — and the net design impact
// is the real shared accounting difference of removing the section, never a
// "2 x costPerHostedCell" estimate.
function powerSectionInspectionHtml(section) {
  if (!section || ui().mode !== "power" || !infraRules() || !editRules()) return "";
  const tier = WIRING_INFRASTRUCTURE?.powerTiers?.[section.tier] || {};
  const acc = infraRules().accountInfrastructure(state.design, state.wiring, PART_STATS, WIRING_INFRASTRUCTURE);
  const endpointHtml = rules().sectionCells(section).map((cell) => {
    const index = partIndexAt(cell.x, cell.y);
    const installed = acc.maps.power.byCellKey.get(rules().cellKey(cell.x, cell.y))?.tier || section.tier;
    return `${index >= 0 ? escapeHtml(moduleLabel(index)) : `cell (${cell.x},${cell.y})`} — installed ${escapeHtml(tierLabel(installed))}`;
  }).join("<br>");
  const network = rules().networkForSection(currentAnalysis(), "power", section.id);
  let impact = "";
  try {
    const preview = editRules().previewWiringSectionRemoval(state.design, state.wiring, "power", section.id, PART_STATS, WIRING_INFRASTRUCTURE, previewOptions());
    if (preview.valid) impact = `<div class="wiring-summary-line">Net impact of removing this section:</div><div class="wiring-summary-line">Cost: ${signedMoney(preview.delta.totalInfrastructure)} · Heat capacity: ${signed(preview.delta.actualHeatCapacity)}</div>`;
  } catch (_) { impact = ""; }
  // Clarity: solved flow, utilisation, cell cost/displacement, cable Heat,
  // design-time protection state, bottleneck/alternate-route context and a
  // plain-language interpretation — all from authoritative shared rules.
  let clarityHtml = "";
  const clarity = clarityRules();
  if (clarity) {
    const flow = sectionFlowsById(state.wiring).get(section.id) || null;
    const routeSections = network?.sections || [];
    const hasAlternateRoute = routeSections.length ? clarity.sectionHasAlternateRoute(routeSections, section.id) : false;
    const minSustained = routeSections.length ? Math.min(...routeSections.map((s) => Number(WIRING_INFRASTRUCTURE?.powerTiers?.[s.tier]?.sustainedCapacityMw) || 0)) : 0;
    const isWeakest = routeSections.length > 1 && (Number(tier.sustainedCapacityMw) || 0) <= minSustained;
    const isBottleneck = Boolean(flow && (flow.aboveSustained || flow.atPeak)) || (isWeakest && Boolean(flow && Number(flow.absoluteFlowMw) > 0));
    // Cost/displacement actually represented by this section's two hosted
    // cells at their installed (highest incident) tier.
    let cellCost = 0; let cellDisplacement = 0;
    for (const cell of rules().sectionCells(section)) {
      const installed = acc.maps.power.byCellKey.get(rules().cellKey(cell.x, cell.y))?.tier || section.tier;
      const config = WIRING_INFRASTRUCTURE?.powerTiers?.[installed] || {};
      cellCost += Number(config.costPerHostedCell) || 0;
      cellDisplacement += Number(config.heatCapacityDisplacement) || 0;
    }
    const heatRate = sectionHeatRate(flow, section.tier);
    const protection = globalThis.PowerProtectionRules;
    const protectionState = flow && protection
      ? protection.protectionStateFor({ operational: true, absoluteFlowMw: flow.absoluteFlowMw, sustainedCapacityMw: flow.sustainedCapacityMw, peakCapacityMw: flow.peakCapacityMw, stress: 0 }, undefined)
      : "normal";
    const interpretation = clarity.sectionInterpretation({ flow, disabled: false, isBottleneck, hasAlternateRoute });
    const headroom = flow ? Math.round(Math.max(0, (Number(flow.peakCapacityMw) || 0) - (Number(flow.absoluteFlowMw) || 0)) * 100) / 100 : null;
    const flowRows = flow
      ? `<div class="wiring-summary-line" data-section-flow>Predicted flow: ${Math.round((Number(flow.absoluteFlowMw) || 0) * 100) / 100} MW · ${Math.round((Number(flow.sustainedUtilisation) || 0) * 100)}% of sustained · ${Math.round((Number(flow.peakUtilisation) || 0) * 100)}% of peak (current estimate)</div>
         <div class="wiring-summary-line" data-section-heat>${heatRate === null ? escapeHtml(clarity.EMPTY_STATES.incompleteRoute) : `Cable Heat contribution: ${Math.round(heatRate * 1000) / 1000} H/s under this activity`}</div>
         <div class="wiring-summary-line" data-section-protection>Protection state: ${escapeHtml(protectionState)} · Overload stress: none before deployment (accumulates in battle above sustained)</div>`
      : `<div class="wiring-summary-line" data-section-flow>${escapeHtml(clarity.EMPTY_STATES.noPowerPath)}</div>`;
    clarityHtml = `
    ${flowRows}
    ${flow ? `<div class="wiring-summary-line" data-section-headroom>Headroom: ${headroom} MW to peak · Operational: yes</div>` : ""}
    <div class="wiring-summary-line" data-section-cell-cost>Selected cells: $${cellCost} installed cost · ${cellDisplacement} Heat-capacity displacement</div>
    <div class="wiring-summary-line" data-section-route>${isBottleneck ? "Bottleneck: yes" : "Bottleneck: no"} · ${hasAlternateRoute ? "Alternate route: yes" : escapeHtml(clarity.EMPTY_STATES.noAlternateRoute)}</div>
    <div class="wiring-summary-line wiring-section-interpretation" data-section-interpretation>${interpretation.map(escapeHtml).join(" ")}</div>`;
  }
  return `<div class="wiring-summary-section" data-wiring-inspection="power-section"><h4>${escapeHtml(tierLabel(section.tier))}</h4>
    <div class="wiring-summary-line">Cable rating: ${Number(tier.sustainedCapacityMw) || 0} MW sustained / ${Number(tier.peakCapacityMw) || 0} MW peak</div>
    <div class="wiring-summary-line">Section (${section.x1},${section.y1}) ↔ (${section.x2},${section.y2})</div>
    <div class="wiring-summary-line">Hosts: ${endpointHtml}</div>
    <div class="wiring-summary-line">Network type: Power · ${network ? `Network ID: ${escapeHtml(network.id)} (${escapeHtml(network.label)})` : "Network ID: unavailable — not part of a sourced network"}</div>
    ${clarityHtml}
    ${impact}</div>`;
}

// ---------------------------------------------------------------------------
// Blueprint infrastructure summary and benefits/downsides observations.
// Values come from shared accounting/solver analysis; guidance is advisory
// (a design outside the conventional range is never marked invalid).
// ---------------------------------------------------------------------------
function infrastructureSummaryHtml() {
  if (!infraRules()) return "";
  const acc = infraRules().accountInfrastructure(state.design, state.wiring, PART_STATS, WIRING_INFRASTRUCTURE);
  const switchgearParts = (state.design || []).filter((module) => module.type === "switchgear");
  const switchgearCost = switchgearParts.length * (Number(PART_STATS.switchgear?.cost) || 0);
  const preCost = preInfrastructureShipCost();
  const presentation = infraRules().infrastructureCostPresentation(preCost, acc.power.cost, acc.data.cost);
  const analysis = currentAnalysis();
  const pct = Math.round(presentation.infrastructurePercentage * 1000) / 10;
  return `<section class="wiring-summary-section" data-wiring-panel="infrastructure-summary"><h4>Infrastructure</h4>
    <div class="wiring-summary-line" data-infra-costs>Power wiring $${acc.power.cost} · Data wiring $${acc.data.cost} · Switchgear components $${switchgearCost}</div>
    <div class="wiring-summary-line" data-infra-total>Total infrastructure $${presentation.totalInfrastructure} — ${pct}% of the $${presentation.totalShipCost} ship cost (Switchgear is priced with components)</div>
    <div class="wiring-summary-line" data-infra-displacement>Displacement: Power ${acc.power.displacement} · Data ${acc.data.displacement} · total ${acc.power.displacement + acc.data.displacement} Heat capacity</div>
    <div class="wiring-summary-line" data-infra-cells>Unique Power cells — Light ${acc.power.cellsByTier.light.length} · Standard ${acc.power.cellsByTier.standard.length} · Heavy ${acc.power.cellsByTier.heavy.length} · Data cells ${acc.data.uniqueHostedCellCount}</div>
    <div class="wiring-summary-line" data-infra-networks>Switchgear ${switchgearParts.length} · Power networks ${analysis.power.networks.length} · Data networks ${analysis.data.networks.length}</div>
    <div class="wiring-summary-line wiring-guidance" data-infra-guidance>Conventional designs often spend around 5–10% of total cost on wiring. Lower is cheaper but may indicate limited capacity or redundancy. Higher can be justified by Heavy trunks, ring routes or Switchgear protection.</div>
  </section>`;
}

function switchgearObservationInputs() {
  return (state.design || []).map((module, index) => {
    if (module.type !== "switchgear") return null;
    const sg = globalThis.SwitchgearRules;
    if (!sg) return null;
    const terminals = sg.terminalCells(module);
    const adjacentTiers = [];
    for (const section of bucket("power").sections) {
      for (const cell of [terminals.A, terminals.B]) {
        if ((section.x1 === cell.x && section.y1 === cell.y) || (section.x2 === cell.x && section.y2 === cell.y)) adjacentTiers.push(section.tier);
      }
    }
    return { index, mode: sg.normalizeMode(module.switchgearMode), ratingTier: sg.normalizeRatingTier(module.switchgearRatingTier), adjacentTiers };
  }).filter(Boolean);
}

function blueprintObservationsHtml() {
  const clarity = clarityRules();
  if (!clarity || !infraRules()) return "";
  const flow = designerPowerFlow();
  const analysis = currentAnalysis();
  const acc = infraRules().accountInfrastructure(state.design, state.wiring, PART_STATS, WIRING_INFRASTRUCTURE);
  const presentation = infraRules().infrastructureCostPresentation(preInfrastructureShipCost(), acc.power.cost, acc.data.cost);
  const sectionTierById = {};
  for (const section of bucket("power").sections) sectionTierById[section.id] = section.tier;
  const powerNetworks = (analysis.power.networks || []).map((network) => ({
    consumerCount: (network.consumerIndices || []).length,
    alternatePaths: clarity.alternatePathCount(network.sections || [])
  }));
  const dataNetworks = (analysis.data.networks || []).map((network) => ({
    sectionCount: (network.sections || []).length,
    alternatePaths: clarity.alternatePathCount(network.sections || [])
  }));
  const powerCells = new Set(acc.maps.power.uniqueHostedCells);
  const dataSeparate = acc.data.uniqueHostedCellCount > 0 && acc.maps.data.uniqueHostedCells.every((key) => !powerCells.has(key));
  const observations = clarity.blueprintObservations({
    infrastructure: WIRING_INFRASTRUCTURE,
    sectionFlows: flow?.sectionFlows || [],
    flowSummary: flow?.summary || {},
    sectionTierById,
    powerNetworks,
    dataNetworks,
    switchgear: switchgearObservationInputs(),
    alternatePaths: clarity.alternatePathCount(bucket("power").sections),
    infrastructurePercentage: presentation.infrastructurePercentage,
    dataSeparateFromPower: dataSeparate
  });
  if (!observations.positives.length && !observations.warnings.length) return "";
  return `<section class="wiring-summary-section" data-wiring-panel="blueprint-observations"><h4>Benefits and downsides</h4>
    ${observations.positives.map((text) => `<div class="wiring-summary-line wiring-observation-positive" data-observation="positive">✓ ${escapeHtml(text)}</div>`).join("")}
    ${observations.warnings.map((text) => `<div class="wiring-summary-line wiring-observation-warning" data-observation="warning">⚠ ${escapeHtml(text)}</div>`).join("")}
  </section>`;
}

function selectedTierSummaryHtml() {
  const clarity = clarityRules();
  if (!clarity) return "";
  const summary = clarity.toolSummary(WIRING_INFRASTRUCTURE, ui().mode, selectedTier());
  const config = ui().mode === "power" ? WIRING_INFRASTRUCTURE?.powerTiers?.[selectedTier()] : WIRING_INFRASTRUCTURE?.data;
  const compact = ui().mode === "power"
    ? `${summary.title} · ${Number(config?.sustainedCapacityMw) || 0}/${Number(config?.peakCapacityMw) || 0} MW · ${formatWiringMoney(config?.costPerHostedCell)}/cell · ${Number(config?.heatCapacityDisplacement) || 0} Heat displacement`
    : `Data cable · ${formatWiringMoney(config?.costPerHostedCell)}/cell · no Power capacity · ${Number(config?.heatCapacityDisplacement) || 0} Heat displacement`;
  return `<section class="wiring-analysis-section selected-tier-summary" data-wiring-panel="selected-tier">
    <h4>Selected ${ui().mode === "power" ? "tier" : "network"}</h4>
    <div class="wiring-selected-tier-row"><strong>${escapeHtml(compact)}</strong>
      <details data-wiring-details="tier" ${analysisDetailsState.tier ? "open" : ""}>
        <summary aria-label="Explain selected cable tier">i</summary>
        <p>${escapeHtml(summary.recommendation)}</p>
        <p>${escapeHtml(summary.capacityText)}. ${escapeHtml(summary.costText)}. ${escapeHtml(summary.displacementText)}.</p>
      </details>
    </div>
  </section>`;
}

function formatWiringMoney(value) {
  const rounded = Math.round((Number(value) || 0) * 100) / 100;
  return `$${rounded.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function wiringObservationModel(analysis, flow, accounting, presentation) {
  const clarity = clarityRules();
  if (!clarity) return { positives: [], warnings: [] };
  const sectionTierById = {};
  for (const section of bucket("power").sections) sectionTierById[section.id] = section.tier;
  const powerNetworks = (analysis.power.networks || []).map((network) => ({
    consumerCount: (network.consumerIndices || []).length,
    alternatePaths: clarity.alternatePathCount(network.sections || [])
  }));
  const dataNetworks = (analysis.data.networks || []).map((network) => ({
    sectionCount: (network.sections || []).length,
    alternatePaths: clarity.alternatePathCount(network.sections || [])
  }));
  const powerCells = new Set(accounting.maps.power.uniqueHostedCells);
  const dataSeparate = accounting.data.uniqueHostedCellCount > 0
    && accounting.maps.data.uniqueHostedCells.every((key) => !powerCells.has(key));
  return clarity.blueprintObservations({
    infrastructure: WIRING_INFRASTRUCTURE,
    sectionFlows: flow?.sectionFlows || [],
    flowSummary: flow?.summary || {},
    sectionTierById,
    powerNetworks,
    dataNetworks,
    switchgear: switchgearObservationInputs(),
    alternatePaths: clarity.alternatePathCount(bucket("power").sections),
    infrastructurePercentage: presentation.infrastructurePercentage,
    dataSeparateFromPower: dataSeparate
  });
}

function upgradeForIssue(section, flowRecord) {
  if (!section || !flowRecord || section.tier === "heavy") return null;
  const currentRank = POWER_TIERS.indexOf(section.tier);
  const load = Number(flowRecord.absoluteFlowMw) || 0;
  for (const targetTier of POWER_TIERS.slice(currentRank + 1)) {
    const target = WIRING_INFRASTRUCTURE?.powerTiers?.[targetTier];
    if (!target || load > Number(target.sustainedCapacityMw)) continue;
    const result = rules().setSectionTier(state.wiring, "power", section.id, targetTier, state.design, PART_STATS);
    if (!result.changed) continue;
    const proposedFlow = sectionFlowsById(result.wiring).get(section.id);
    if (!proposedFlow || proposedFlow.aboveSustained || proposedFlow.atPeak) continue;
    const currentAccounting = infraRules().accountInfrastructure(state.design, state.wiring, PART_STATS, WIRING_INFRASTRUCTURE);
    const proposedAccounting = infraRules().accountInfrastructure(state.design, result.wiring, PART_STATS, WIRING_INFRASTRUCTURE);
    const networkSections = routeSectionsFor(result.wiring, section.id);
    const targetRank = POWER_TIERS.indexOf(targetTier);
    return {
      targetTier,
      costDelta: proposedAccounting.power.cost - currentAccounting.power.cost,
      weakerSectionRemains: networkSections.some((item) => item.id !== section.id && POWER_TIERS.indexOf(item.tier) < targetRank)
    };
  }
  return null;
}

function wiringIssueModel(analysis, flow, observations) {
  const issues = [];
  const add = (issue) => issues.push(issue);
  for (const index of analysis.power.disconnectedConsumerIndices || []) {
    add({ priority: 1, severity: "critical", title: "Power consumer disconnected", affected: moduleLabel(index), current: "No powered route", safe: "Connected to a Power source", consequence: "This component cannot receive Power.", recommendation: "Draw or repair a Power route to this component.", mode: "power", componentIndex: index });
  }
  for (const index of analysis.power.unusedSourceIndices || []) {
    add({ priority: 1, severity: "warning", title: "Power source disconnected", affected: moduleLabel(index), current: "No consumer route", safe: "Connected to a useful Power network", consequence: "This source cannot deliver Power to a consumer.", recommendation: "Connect it to demand or remove the unused source.", mode: "power", componentIndex: index });
  }
  for (const section of [...bucket("power").sections, ...bucket("data").sections].filter((item) => item.disabled || item.broken)) {
    add({ priority: 2, severity: "critical", title: "Cable section broken or disabled", affected: `Section ${section.x1},${section.y1} → ${section.x2},${section.y2}`, current: "Unavailable", safe: "Operational", consequence: "Connectivity through this section is interrupted.", recommendation: "Locate and repair or redraw this section.", mode: bucket("power").sections.includes(section) ? "power" : "data", sectionId: section.id });
  }
  const sectionById = new Map(bucket("power").sections.map((section) => [section.id, section]));
  const atPeak = (flow?.sectionFlows || []).filter((item) => item.atPeak);
  const above = (flow?.sectionFlows || []).filter((item) => item.aboveSustained && !item.atPeak);
  for (const record of [...atPeak, ...above]) {
    const section = sectionById.get(record.sectionId);
    if (!section) continue;
    const upgrade = upgradeForIssue(section, record);
    add({
      priority: record.atPeak ? 3 : 4,
      severity: record.atPeak ? "critical" : "warning",
      title: `${tierLabel(section.tier)} ${record.atPeak ? "at peak capacity" : "overloaded"}`,
      affected: `Section ${section.x1},${section.y1} → ${section.x2},${section.y2}`,
      current: `Flow ${mwText(record.absoluteFlowMw)} · Sustained ${mwText(record.sustainedCapacityMw)} · Peak ${mwText(record.peakCapacityMw)}`,
      safe: `At or below ${mwText(record.sustainedCapacityMw)} sustained`,
      consequence: "This overloaded section may limit connected demand.",
      recommendation: upgrade
        ? `Upgrade this section to ${tierLabel(upgrade.targetTier)}.${upgrade.weakerSectionRemains ? " Another weaker section may still limit delivery." : ""}`
        : "Reduce demand or reroute flow; no available single-section upgrade fully resolves this load.",
      mode: "power", sectionId: section.id, upgrade
    });
  }
  const unmet = Number(flow?.summary?.unmetMw) || 0;
  if (unmet > 0) {
    add({ priority: 5, severity: "critical", title: "Power demand unmet", affected: "Power networks", current: `${mwText(unmet)} unmet`, safe: "0 MW unmet", consequence: "Some requested Power cannot be delivered.", recommendation: "Add generation, repair connectivity, or remove proven cable bottlenecks.", mode: "power" });
  }
  try {
    const data = currentDataInspection();
    for (const network of data.networks.filter((item) => !item.sourceIndices.length && item.weaponIndices.length)) {
      const componentIndex = network.weaponIndices[0];
      add({ priority: 6, severity: "critical", title: "Data support disconnected", affected: network.label, current: `${network.weaponIndices.length} weapon${network.weaponIndices.length === 1 ? "" : "s"} without a Data source`, safe: "Connected to a compatible Data source", consequence: "Connected systems receive no Data support from this network.", recommendation: "Draw a Data route from a compatible source.", mode: "data", componentIndex });
    }
    for (const source of data.sources.filter((item) => item.networkId && item.predictedPowerMultiplier <= 0)) {
      add({ priority: 6, severity: "warning", title: "Data source has no Power", affected: moduleLabel(source.sourceIndex), current: "0% predicted Power", safe: "Powered source", consequence: "This source cannot provide its Data benefit.", recommendation: "Connect the source to a working Power network.", mode: "data", componentIndex: source.sourceIndex });
    }
  } catch (_) { /* Data details remain available in Advanced Details. */ }
  const structuralWarnings = (observations.warnings || []).filter((text) => !/section .*above rating|current flow|overload/i.test(text));
  structuralWarnings.forEach((text, index) => {
    const firstSentence = String(text).split(". ")[0].trim();
    add({ priority: index === 0 ? 7 : 8, severity: "warning", title: index === 0 ? "Wiring architecture concern" : "Limited redundancy", affected: "Current wiring topology", current: "Solver observation", safe: "No proven constraint", consequence: firstSentence.endsWith(".") ? firstSentence : `${firstSentence}.`, recommendation: "Review Advanced Details before changing the design.", mode: "power" });
  });
  return issues.sort((a, b) => a.priority - b.priority);
}

function issueActionHtml(issue, index) {
  const id = `wiring-issue-${index}`;
  const locate = issue.sectionId != null || issue.componentIndex != null
    ? `<button type="button" data-wiring-action="locate-issue" data-issue-index="${index}" aria-label="Locate ${escapeHtml(issue.affected)}">Locate</button>`
    : "";
  const upgrade = issue.upgrade
    ? `<button type="button" data-wiring-action="upgrade-issue" data-issue-index="${index}" aria-label="Upgrade ${escapeHtml(issue.affected)} to ${escapeHtml(tierLabel(issue.upgrade.targetTier))}">Upgrade to ${escapeHtml(tierLabel(issue.upgrade.targetTier))} (${issue.upgrade.costDelta >= 0 ? "+" : "−"}${formatWiringMoney(Math.abs(issue.upgrade.costDelta))})</button>`
    : "";
  return `<article id="${id}" class="wiring-issue-card ${escapeHtml(issue.severity)}" data-wiring-issue="${index}">
    <h5><span aria-hidden="true">${issue.severity === "critical" ? "!" : "⚠"}</span> ${escapeHtml(issue.title)}</h5>
    <div class="wiring-issue-affected">${escapeHtml(issue.affected)}</div>
    <dl><div><dt>Current</dt><dd>${escapeHtml(issue.current)}</dd></div><div><dt>Expected</dt><dd>${escapeHtml(issue.safe)}</dd></div></dl>
    <p>${escapeHtml(issue.consequence)}</p>
    <p class="wiring-issue-recommendation">${escapeHtml(issue.recommendation)}</p>
    ${locate || upgrade ? `<div class="wiring-issue-actions">${locate}${upgrade}</div>` : ""}
  </article>`;
}

function compactSummaryHtml(accounting, presentation, analysis, flow) {
  const broken = [...bucket("power").sections, ...bucket("data").sections].filter((section) => section.disabled || section.broken).length;
  const alternate = clarityRules()?.alternatePathCount?.(bucket("power").sections);
  const overloaded = (flow?.sectionFlows || []).filter((section) => section.aboveSustained || section.atPeak).length;
  const rows = [
    ["Cost", formatWiringMoney(presentation.totalInfrastructure)],
    ["Ship share", `${Math.round(presentation.infrastructurePercentage * 1000) / 10}%`],
    ["Displacement", String(accounting.power.displacement + accounting.data.displacement)],
    ["Overloaded", String(overloaded)],
    ["Power / Data cells", `${accounting.power.uniqueHostedCellCount} / ${accounting.data.uniqueHostedCellCount}`],
    ["Networks", `${analysis.power.networks.length} Power · ${analysis.data.networks.length} Data`],
    ["Broken / disabled", String(broken)],
    ["Alternate paths", alternate == null ? "Unavailable" : String(alternate)]
  ];
  return `<section class="wiring-analysis-section" data-wiring-panel="compact-summary"><h4>Summary</h4><div class="wiring-compact-stats">${rows.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}</div></section>`;
}

function dataInspectionDetailsHtml(section) {
  const scratch = document.createElement("section");
  renderDataInspectionPanel(scratch, section);
  return scratch.innerHTML;
}

function selectedPowerDetailsHtml(section, network, status, junctionCount, labels, mw) {
  const sectionHtml = section ? powerSectionInspectionHtml(section) : "";
  if (!network) return sectionHtml;
  return `${sectionHtml}<section class="wiring-summary-section"><h4>${escapeHtml(network.label)} — ${escapeHtml(status)}</h4>
    <div class="wiring-summary-line">${network.sections.length} sections · ${junctionCount} junctions · ${network.sourceIndices.length ? "contains a source" : "source-less"}</div>
    <div class="wiring-summary-line">Sources: ${labels(network.sourceIndices)}</div>
    <div class="wiring-summary-line">Consumers: ${labels(network.consumerIndices)}<br>${mw(network.generationMw)} generation / ${mw(network.demandMw)} demand · ${network.surplusMw >= 0 ? `${mw(network.surplusMw)} surplus` : `${mw(network.deficitMw)} deficit`} · ${Math.round(network.availableEfficiency * 100)}% available</div>
  </section>`;
}

function wiringStatusHeaderHtml(status, message) {
  const icon = status === "healthy" ? "&#10003;" : status === "no-wiring" ? "—" : status === "unavailable" ? "?" : status === "critical" ? "!" : "&#9888;";
  return `<header class="wiring-analysis-status ${status}" data-wiring-status="${status}">
    <span class="wiring-status-icon" aria-hidden="true">${icon}</span>
    <div><h3>${escapeHtml(status.replace("-", " "))}</h3><p>${escapeHtml(message)}</p></div>
  </header><div class="sr-only" role="status" aria-live="polite">${escapeHtml(message)}</div>`;
}

function locateIssue(issue, issueIndex) {
  if (!issue) return;
  clearLocateHighlight();
  resetInteraction();
  ui().mode = issue.mode || "power";
  ui().wiringTool = "inspect";
  if (issue.sectionId) {
    ui().selectedSectionId = issue.sectionId;
    locatedSectionId = issue.sectionId;
  } else if (issue.componentIndex != null) {
    ui().selectedIndex = issue.componentIndex;
    locatedComponentIndex = issue.componentIndex;
  }
  refreshWiringPresentation();
  scheduleLocateHighlightClear();
  requestAnimationFrame(() => {
    dom.gridStage?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "smooth" });
    dom.wiringStatusPanel?.querySelector?.(`[data-wiring-issue="${issueIndex}"] [data-wiring-action="locate-issue"]`)?.focus({ preventScroll: true });
  });
}

function upgradeIssue(issue) {
  if (!issue?.sectionId || !issue.upgrade) return;
  const section = bucket("power").sections.find((item) => item.id === issue.sectionId);
  const flow = sectionFlowsById(state.wiring).get(issue.sectionId);
  const fresh = upgradeForIssue(section, flow);
  if (!fresh || fresh.targetTier !== issue.upgrade.targetTier) return;
  const result = rules().setSectionTier(state.wiring, "power", issue.sectionId, fresh.targetTier, state.design, PART_STATS);
  if (!result.changed || result.affectedSectionIds.length !== 1) return;
  pushUndo();
  resetInteraction();
  ui().mode = "power";
  ui().wiringTool = "inspect";
  ui().selectedSectionId = issue.sectionId;
  locatedSectionId = issue.sectionId;
  commitWiring(result.wiring);
  scheduleLocateHighlightClear();
}

function renderStatusPanel() {
  const panel = dom.wiringStatusPanel;
  if (!panel) return;
  let analysis;
  try { analysis = currentAnalysis(); } catch (_) {
    panel.hidden = false;
    panel.innerHTML = `${wiringStatusHeaderHtml("unavailable", "The wiring solver could not produce a result.")}<button type="button" data-wiring-action="retry-analysis">Retry</button>`;
    return;
  }
  const network = selectedNetwork(); const section = bucket().sections.find((item) => item.id === ui().selectedSectionId);
  const current = rules().countUniqueSections(state.wiring, ui().mode); const additional = rules().additionalLengthForPath(state.wiring, ui().mode, ui().path); const limit = CABLE_LIMITS[ui().mode];
  const degrees = section ? rules().sectionEndpointDegrees(bucket()).get(section.id) : null; const junctionCount = network ? rules().junctionCells({ sections: network.sections }).length : 0; const mw = (value) => `${Number(value).toFixed(1)} MW`; const labels = (indices) => indices.map(moduleLabel).map(escapeHtml).join(", ") || "None";
  const branch = section ? rules().findLeafBranchSections(bucket(), section.id) : null; const role = !section ? "" : degrees.some((degree) => degree > 2) ? "junction-adjacent" : branch.reason === "leaf-branch" ? "leaf branch" : degrees.every((degree) => degree === 2) ? "trunk or loop" : "branch";
  const status = network ? (ui().mode === "power" ? network.status : network.sourceIndices.length ? "online" : "source-less") : null;
  const hasWiring = bucket("power").sections.length + bucket("data").sections.length > 0;
  panel.hidden = false; panel.tabIndex = -1;
  if (!hasWiring) {
    panel.innerHTML = `${wiringStatusHeaderHtml("no-wiring", "Draw Power or Data cable to begin analysis.")}${selectedTierSummaryHtml()}
      ${ui().sourceIndex != null ? `<div class="wiring-drawing-actions"><button type="button" data-wiring-action="finish" ${ui().path.length < 2 || pathOverLimit() ? "disabled" : ""}>Finish cable</button><button type="button" data-wiring-action="cancel-drawing">Cancel drawing</button></div>` : ""}`;
    return;
  }
  const flow = designerPowerFlow();
  if (bucket("power").sections.length && !flow) {
    panel.innerHTML = `${wiringStatusHeaderHtml("unavailable", "The wiring solver could not produce a result.")}<button type="button" data-wiring-action="retry-analysis">Retry</button>`;
    return;
  }
  const accounting = infraRules().accountInfrastructure(state.design, state.wiring, PART_STATS, WIRING_INFRASTRUCTURE);
  const presentation = infraRules().infrastructureCostPresentation(preInfrastructureShipCost(), accounting.power.cost, accounting.data.cost);
  const observations = wiringObservationModel(analysis, flow, accounting, presentation);
  const issues = wiringIssueModel(analysis, flow, observations);
  panel._wiringIssues = issues;
  const disconnectedCount = issues.filter((item) => item.priority === 1 || (item.priority === 6 && item.severity === "critical")).length;
  const criticalCount = issues.filter((item) => item.severity === "critical").length;
  const overloadedCount = (flow?.sectionFlows || []).filter((item) => item.aboveSustained || item.atPeak).length;
  const overallStatus = criticalCount ? "critical" : issues.length ? "warning" : "healthy";
  const overallMessage = disconnectedCount
    ? `${disconnectedCount} disconnected consumer${disconnectedCount === 1 ? "" : "s"}`
    : overloadedCount ? `${overloadedCount} overloaded section${overloadedCount === 1 ? "" : "s"}`
      : issues.length ? `${issues.length} wiring issue${issues.length === 1 ? "" : "s"}`
        : "No overloaded or disconnected sections";
  const visibleIssues = issues.slice(0, 2);
  const hiddenIssues = issues.slice(2);
  const issuesHtml = issues.length
    ? `<section class="wiring-analysis-section wiring-issues" data-wiring-panel="issues"><h4>Issues</h4>${visibleIssues.map(issueActionHtml).join("")}
      ${hiddenIssues.length ? `<details class="wiring-more-issues"><summary>View ${hiddenIssues.length} more issue${hiddenIssues.length === 1 ? "" : "s"}</summary>${hiddenIssues.map((item, offset) => issueActionHtml(item, offset + 2)).join("")}</details>` : ""}</section>`
    : `<section class="wiring-analysis-section wiring-issues" data-wiring-panel="issues"><h4>Issues</h4><p class="wiring-empty-note">No actionable wiring issues detected.</p></section>`;
  const healthyHtml = `<details class="wiring-analysis-expander" data-wiring-details="healthy" ${analysisDetailsState.healthy ? "open" : ""}>
    <summary><span>Healthy properties</span><strong>&#10003; ${observations.positives.length} detected</strong></summary>
    <div>${observations.positives.length ? observations.positives.map((text) => `<p class="wiring-observation-positive">&#10003; ${escapeHtml(text)}</p>`).join("") : `<p>No additional healthy properties are evidenced.</p>`}</div>
  </details>`;
  const selectedDetails = ui().mode === "data"
    ? dataInspectionDetailsHtml(section)
    : selectedPowerDetailsHtml(section, network, status, junctionCount, labels, mw);
  const selectedSectionActions = section ? `<section class="wiring-summary-section"><h4>Selected physical section</h4>
    <div class="wiring-summary-line">(${section.x1},${section.y1}) ↔ (${section.x2},${section.y2}) · ${escapeHtml(section.tier)} tier · ${role}</div>
    <div class="wiring-summary-line">Endpoint degrees: ${degrees[0]} / ${degrees[1]} · Hosts: ${labels([...new Set(rules().sectionCells(section).map((cell) => partIndexAt(cell.x, cell.y)).filter((index) => index >= 0))])}</div>
    <div class="wiring-section-actions"><button type="button" data-wiring-action="branch-a">Branch from A</button><button type="button" data-wiring-action="branch-b">Branch from B</button><button type="button" data-wiring-action="remove-section">Remove section</button><button type="button" data-wiring-action="remove-branch">Remove branch</button><button type="button" data-wiring-action="cancel-selection">Cancel selection</button></div>
  </section>` : "";
  const advancedHtml = `<details class="wiring-analysis-expander wiring-advanced-details" data-wiring-details="advanced" ${analysisDetailsState.advanced ? "open" : ""}>
    <summary><span>Advanced details</span><strong>Accounting, topology and solver values</strong></summary>
    <div>${infrastructureSummaryHtml()}${blueprintObservationsHtml()}${selectedDetails}${selectedSectionActions}
      <section class="wiring-summary-section"><h4>Physical wiring</h4><div class="wiring-summary-line">${current} unique ${escapeHtml(ui().mode)} cable sections${ui().path.length > 1 ? ` · +${additional} new in preview` : ""}${Number.isFinite(limit) ? ` · ${Math.max(0, limit - current - additional)} remaining` : ""}</div></section>
    </div>
  </details>`;
  panel.innerHTML = `${wiringStatusHeaderHtml(overallStatus, overallMessage)}
    ${compactSummaryHtml(accounting, presentation, analysis, flow)}
    ${selectedTierSummaryHtml()}
    ${issuesHtml}
    ${healthyHtml}
    ${advancedHtml}
    ${ui().sourceIndex != null ? `<div class="wiring-drawing-actions"><button type="button" data-wiring-action="finish" ${ui().path.length < 2 || pathOverLimit() ? "disabled" : ""}>Finish cable</button><button type="button" data-wiring-action="cancel-drawing">Cancel drawing</button></div>` : ""}
    `;
}
