// Wiring v2 editor: canonical physical sections own topology and membership.
import { dom } from "./dom.js";
import { state } from "../state.js";
import { PART_DEFS, PART_STATS } from "../design/parts.js";
import { findPartAtCell } from "../design/placementCandidate.js";
import { getFootprintBounds } from "../design/footprint.js";
import { persistDesign, defaultWiring, normalizeWiring } from "../design/blueprintStorage.js";
import { escapeHtml } from "../shared/formatting.js";
import { computeStats } from "../design/componentStats.js";
import { preDisplacementHeatCapacities } from "../design/thermalAnalysis.js";
import { WIRING_INFRASTRUCTURE } from "../constants.js";
import { getCachedDesignDataSupport, getCachedDataVulnerabilities } from "../design/dataSupportAnalysis.js";
import { formatDataSupportValue, formatDataSupportEquation } from "../design/dataSupportPresentation.js";
import { applyPowerPolicyChange } from "./designerUi.js";

const GRID_SIZE = 15;
const MAX_UNDO = 60;
const SVG_NS = "http://www.w3.org/2000/svg";
const DRAG_THRESHOLD_PX = 5;
const CABLE_LIMITS = Object.freeze({ ...globalThis.WiringRules?.DEFAULT_CABLE_LIMITS });
let pointerDrag = null;
let suppressNextClick = false;
function rules() { return globalThis.WiringRules; }
function editRules() { return globalThis.WiringEditRules; }
function infraRules() { return globalThis.WiringInfrastructureRules; }
function clarityRules() { return globalThis.WiringClarityRules; }
function cableThermalRules() { return globalThis.PowerCableThermalRules; }
function ui() { return state.wiringUi; }
const POWER_TIERS = Object.freeze(["light", "standard", "heavy"]);
function currentTool() { return ui().wiringTool || "draw"; }
function selectedTier() { return POWER_TIERS.includes(ui().selectedPowerTier) ? ui().selectedPowerTier : "standard"; }
function tierLabel(tier) { return WIRING_INFRASTRUCTURE?.powerTiers?.[tier]?.inspectionLabel || (tier ? tier[0].toUpperCase() + tier.slice(1) : ""); }
function isPowerTierTool() { return ui().mode === "power" && currentTool() === "tier"; }
// Visible stroke width in SVG grid units, driven by authoritative renderedThickness.
// Standard (thickness 2) ~= the historical wiring width so migrated designs look
// unchanged; Light is clearly thinner, Heavy clearly thicker.
function renderedStrokeWidth(tier) {
  const thickness = Number(WIRING_INFRASTRUCTURE?.powerTiers?.[tier]?.renderedThickness);
  const scaled = Number.isFinite(thickness) && thickness > 0 ? thickness : 2;
  return (0.07 * scaled).toFixed(3);
}
function sectionActionVerb() {
  if (isPowerTierTool()) return "Change tier of";
  if (currentTool() === "erase") return "Erase";
  if (currentTool() === "inspect") return "Inspect";
  return "Select";
}
// Cheap hover highlight: toggles a class on already-rendered visible lines
// without rebuilding the overlay or re-running analysis.
function applyHoverHighlight() {
  const host = dom.wiringOverlayHost; if (!host) return;
  const hoveredId = ui().sourceIndex == null ? ui().hoveredSectionId : null;
  const previewTool = isPowerTierTool() || currentTool() === "erase";
  const inspectTool = currentTool() === "inspect";
  host.querySelectorAll(".wire-visible-layer [data-section-id]").forEach((element) => {
    const on = element.dataset.sectionId === hoveredId;
    element.classList.toggle("wire-section-preview", on && previewTool);
    element.classList.toggle("wire-section-hover", on && inspectTool);
  });
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
  "no-change": "No change to apply."
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
function commitWiring(next) { state.wiring = next; invalidatePreviewCache(); setTransientReason(null); persistDesign(state.design, state.wiring, state.combatStyle); refreshWiringPresentation(); }

// Section 7B tool/tier selection. Data ignores tier selection and cannot use
// the Change Tier tool.
function setTool(tool) {
  if (!["draw", "tier", "erase", "inspect"].includes(tool)) return;
  if (currentTool() === tool) return;
  ui().wiringTool = tool;
  resetInteraction(false);
  ui().hoveredSectionId = null;
  invalidatePreviewCache();
  setTransientReason(ui().mode === "data" && tool === "tier" ? "data-has-no-tiers" : null);
  refreshWiringPresentation();
}
function setTier(tier) {
  if (!POWER_TIERS.includes(tier) || ui().selectedPowerTier === tier) return;
  ui().selectedPowerTier = tier;
  invalidatePreviewCache();
  refreshWiringPresentation();
}

// Apply the selected tier to one existing Power section (upgrade or downgrade).
function applyTierChangeToSection(id) {
  const result = rules().setSectionTier(state.wiring, "power", id, selectedTier(), state.design, PART_STATS);
  if (!result.changed) { setTransientReason(result.reason); ui().selectedSectionId = id; refreshWiringPresentation(); return; }
  pushUndo(); resetInteraction(false); ui().selectedSectionId = id; commitWiring(result.wiring);
}
// Erase one physical section (Power or Data). Unrelated sections, all Data
// wiring and powerPolicy are preserved by shared normalisation.
function eraseSectionById(id) {
  if (!id) { setTransientReason("missing-section"); refreshWiringPresentation(); return; }
  pushUndo(); const mode = ui().mode; resetInteraction(); commitWiring(rules().removeSection(state.wiring, mode, id, state.design, PART_STATS));
}
function releasePointerCapture() { if (!pointerDrag) return; const { target, pointerId } = pointerDrag; if (target?.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId); pointerDrag = null; }
function resetInteraction(clearSelection = true) { releasePointerCapture(); suppressNextClick = false; const view = ui(); view.sourceIndex = null; view.path = []; view.hoverCell = null; view.livePointer = null; view.dragging = false; view.activeOrigin = null; if (clearSelection) { view.selectedIndex = null; view.selectedConnectionKey = null; view.selectedSectionId = null; view.selectedDataNetworkId = null; } }
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
  const connections = connectionsAtTerminal(index);
  if (connections.length) selectConnection(connections[0], index);
  else { ui().selectedIndex = index; ui().selectedConnectionKey = null; ui().selectedSectionId = null; refreshWiringPresentation(); }
}
function cancelDrawing() { resetInteraction(false); refreshWiringPresentation(); }
function focusStatusPanel() { requestAnimationFrame(() => dom.wiringStatusPanel?.focus()); }
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
function commitActivePath() { if (ui().path.length < 2 || pathOverLimit()) return; pushUndo(); const next = rules().addPathWithTier(state.wiring, ui().mode, ui().path, state.design, PART_STATS, selectedTier()); resetInteraction(); ui().activeOrigin = null; commitWiring(next); }
export function handleWiringCellHover(x, y) { if (ui().sourceIndex == null) return; const last = ui().path.at(-1); ui().hoverCell = { x, y, valid: partIndexAt(x, y) >= 0 && Math.abs(last.x - x) + Math.abs(last.y - y) === 1 && !ui().path.some((cell) => cell.x === x && cell.y === y) }; renderWiringOverlay(); }
export function handleWiringGridLeave() { ui().hoverCell = null; if (state.blueprintView === "wiring") renderWiringOverlay(); }

function pointerGridPoint(clientX, clientY) {
  const rect = dom.grid?.getBoundingClientRect(); if (!rect || !rect.width || !rect.height) return null;
  const style = getComputedStyle(dom.grid); const px = (value, fallback = 0) => Number.parseFloat(value) || fallback;
  const left = px(style.borderLeftWidth) + px(style.paddingLeft, 8); const top = px(style.borderTopWidth) + px(style.paddingTop, 8);
  const right = px(style.borderRightWidth) + px(style.paddingRight, 8); const bottom = px(style.borderBottomWidth) + px(style.paddingBottom, 8);
  const gapX = px(style.columnGap || style.gap, 2); const gapY = px(style.rowGap || style.gap, 2);
  const cellWidth = (rect.width - left - right - gapX * (GRID_SIZE - 1)) / GRID_SIZE; const cellHeight = (rect.height - top - bottom - gapY * (GRID_SIZE - 1)) / GRID_SIZE;
  return { x: (clientX - rect.left - left) / (cellWidth + gapX), y: (clientY - rect.top - top) / (cellHeight + gapY) };
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
function clearSelectedNetwork() { const network = selectedNetwork(); if (!network || ui().sourceIndex != null) return; pushUndo(); resetInteraction(); commitWiring(rules().removeNetwork(state.wiring, ui().mode, network, state.design, PART_STATS)); }
function setMode(mode) {
  if (ui().mode === mode) return;
  resetInteraction(); ui().mode = mode; ui().hoveredSectionId = null; invalidatePreviewCache(); setTransientReason(null);
  // Data has no Change Tier tool; fall back to Draw so the toolbar stays valid.
  if (mode === "data" && currentTool() === "tier") ui().wiringTool = "draw";
  refreshWiringPresentation();
}

let controlsBound = false;
export function suppressWiringClick() { if (!suppressNextClick) return false; suppressNextClick = false; return true; }
export function bindWiringControls() {
  if (controlsBound) return; controlsBound = true;
  bindPointerDrawing();
  dom.wiringModePower?.addEventListener("click", () => setMode("power"));
  dom.wiringModeData?.addEventListener("click", () => setMode("data"));
  dom.wiringUndoButton?.addEventListener("click", undoWiring);
  dom.wiringClearNetworkButton?.addEventListener("click", clearSelectedNetwork);
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
    const id = event.target?.dataset?.sectionId; if (!id || ui().sourceIndex != null) return;
    ui().hoveredSectionId = id; applyHoverHighlight(); renderPreviewPanel();
  });
  dom.wiringOverlayHost?.addEventListener("mouseout", (event) => {
    if (!event.target?.dataset?.sectionId) return;
    ui().hoveredSectionId = null; applyHoverHighlight(); renderPreviewPanel();
  });
  dom.wiringOverlayHost?.addEventListener("click", (event) => {
    const port = event.target?.closest?.("[data-wiring-port-kind]");
    // Ports only start a Draw path; other tools ignore them.
    if (port && ui().sourceIndex == null) { event.stopPropagation(); if (currentTool() === "draw" && port.dataset.wiringPortKind === ui().mode) beginPath(Number(port.dataset.wiringComponentIndex), { x: Number(port.dataset.wiringCellX), y: Number(port.dataset.wiringCellY) }); return; }
    const id = event.target?.dataset?.sectionId; if (!id) return;
    if (ui().sourceIndex != null) {
      if (event.button !== 0) return;
      const endpoint = wireEndpointFromEvent(event); if (!endpoint) return;
      event.preventDefault(); event.stopPropagation(); handleWiringCellClick(endpoint.x, endpoint.y); return;
    }
    event.stopPropagation();
    // Tool-aware section click: Change Tier / Erase mutate; Inspect / Draw select.
    if (isPowerTierTool()) { applyTierChangeToSection(id); return; }
    if (currentTool() === "erase") { eraseSectionById(id); return; }
    resetInteraction(); ui().selectedSectionId = id; refreshWiringPresentation();
  });
  dom.wiringOverlayHost?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const port = event.target?.closest?.("[data-wiring-port-kind]");
    if (port && ui().sourceIndex == null && currentTool() === "draw" && port.dataset.wiringPortKind === ui().mode) {
      event.preventDefault(); event.stopPropagation();
      beginPath(Number(port.dataset.wiringComponentIndex), { x: Number(port.dataset.wiringCellX), y: Number(port.dataset.wiringCellY) });
      return;
    }
    // Keyboard activation of a focused section honours the active tool.
    const id = event.target?.dataset?.sectionId; if (!id || ui().sourceIndex != null) return;
    event.preventDefault(); event.stopPropagation();
    if (isPowerTierTool()) { applyTierChangeToSection(id); return; }
    if (currentTool() === "erase") { eraseSectionById(id); return; }
    resetInteraction(); ui().selectedSectionId = id; refreshWiringPresentation();
  });
  dom.wiringOverlayHost?.addEventListener("contextmenu", (event) => {
    const id = event.target?.dataset?.sectionId; if (!id) return; event.preventDefault(); event.stopPropagation();
    if (ui().sourceIndex != null) { removeDrawingStep(); return; }
    ui().selectedSectionId = id; removeSelectedSection();
  });
  document.addEventListener("keydown", (event) => { if (state.blueprintView === "wiring" && event.key === "Escape" && ui().sourceIndex != null) { event.preventDefault(); cancelDrawing(); focusStatusPanel(); } });
  dom.grid?.addEventListener("contextmenu", (event) => {
    if (state.blueprintView !== "wiring") return; event.preventDefault();
    if (ui().sourceIndex != null) { removeDrawingStep(); return; }
    // Component context menus never delete physical cable implicitly.
  });
  dom.wiringStatusPanel?.addEventListener("change", (event) => { const select = event.target?.closest?.("[data-wiring-action=\"data-scenario\"]"); if (!select) return; state.thermalLoadMode = select.value; refreshWiringPresentation(); });
  dom.wiringStatusPanel?.addEventListener("click", (event) => { const actionButton = event.target?.closest?.("[data-wiring-action]"); const action = actionButton?.dataset?.wiringAction || event.target?.dataset?.wiringAction; if (action === "power-preset") { if (!actionButton?.disabled) setPowerPreset(actionButton.dataset.preset); return; } if (action === "power-priority-move") { if (!actionButton?.disabled) movePowerPriority(actionButton.dataset.category, actionButton.dataset.direction); return; } if (action === "branch-a" || action === "branch-b") branchFrom(action.at(-1)); else if (action === "remove-section") { removeSelectedSection(); focusStatusPanel(); } else if (action === "remove-branch") { removeSelectedBranch(); focusStatusPanel(); } else if (action === "inspect-component") { inspectComponent(Number(event.target.dataset.index)); focusStatusPanel(); } else if (action === "select-network") { ui().selectedDataNetworkId = event.target.dataset.networkId; ui().selectedIndex = null; ui().selectedSectionId = null; refreshWiringPresentation(); focusStatusPanel(); } else if (action === "cancel-selection") { resetInteraction(); refreshWiringPresentation(); focusStatusPanel(); } else if (action === "cancel-drawing") { cancelDrawing(); focusStatusPanel(); } else if (action === "finish") { commitActivePath(); focusStatusPanel(); } });
}

export function canUndoWiring() { return ui().undoStack.length > 0; }
export function refreshWiringPresentation() { if (state.blueprintView !== "wiring") return; bindWiringControls(); refreshToolbar(); renderWiringOverlay(); renderPreviewPanel(); renderStatusPanel(); }
export function clearWiringPresentation() { resetInteraction(false); ui().hoveredSectionId = null; invalidatePreviewCache(); dom.wiringOverlayHost?.replaceChildren(); dom.grid?.classList.remove("wiring-overlay-active"); if (dom.wiringPreviewPanel) { dom.wiringPreviewPanel.hidden = true; dom.wiringPreviewPanel.innerHTML = ""; } if (dom.wiringStatusPanel) { dom.wiringStatusPanel.hidden = true; dom.wiringStatusPanel.innerHTML = ""; } }
const TOOL_HINTS = Object.freeze({
  draw: "Draw through occupied cells with the selected tier. New sections use the tier; existing cable keeps its own.",
  tier: "Click a Power section to apply the selected tier. Existing tier is preserved until you change it.",
  erase: "Click a Power or Data section to remove it. Unrelated cable and Data wiring are preserved.",
  inspect: "Click a section to read its cable rating, hosts and net design impact. No changes are made."
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
    // Change Tier is Power-only; disable it for Data so the control cannot lie.
    if (button.dataset.wiringTool === "tier") button.disabled = !power;
  });
  // Data has no cable tiers, so the tier row and legend are hidden for Data.
  if (dom.wiringTierRow) dom.wiringTierRow.hidden = !power;
  if (dom.wiringTierLegend) dom.wiringTierLegend.hidden = !power;
  dom.wiringToolbar?.querySelectorAll("[data-wiring-tier]").forEach((button) => {
    const active = button.dataset.wiringTier === selectedTier();
    button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));
  });
  if (dom.wiringUndoButton) dom.wiringUndoButton.disabled = !ui().undoStack.length;
  if (dom.wiringClearNetworkButton) dom.wiringClearNetworkButton.disabled = ui().sourceIndex != null || !selectedNetwork();
  if (dom.wiringHint) dom.wiringHint.textContent = ui().sourceIndex != null
    ? "Continue through occupied cells; click the last cell or release to finish. Reused trunk sections add no cable length."
    : (power ? TOOL_HINTS[currentTool()] : "Data wiring is single-tier. Draw, erase or inspect Data cable.");
}

// ---------------------------------------------------------------------------
// Section 7C-4 — Power Priority controls and authoritative solver diagnostics.
// The panel lives in the Power Wiring status area (never the component palette).
// Preset and Custom-order changes go through the single authoritative policy
// path (applyPowerPolicyChange -> Blueprint design edit + Undo + persistence).
// ---------------------------------------------------------------------------
function policyRules() { return globalThis.PowerPolicyRules; }
const PRESET_LABELS = Object.freeze({ balanced: "Balanced", defensive: "Defensive", offensive: "Offensive", mobility: "Mobility", custom: "Custom" });
const PRESET_CHOICES = Object.freeze(["balanced", "defensive", "offensive", "mobility", "custom"]);
function currentPowerPolicy() { const pr = policyRules(); return pr ? pr.normalizePolicy(state.wiring?.powerPolicy) : { preset: "balanced", customOrder: [] }; }
function setPowerPreset(preset) { const pr = policyRules(); if (pr) applyPowerPolicyChange((current) => pr.selectPreset(current, preset)); }
function movePowerPriority(category, direction) { const pr = policyRules(); if (pr) applyPowerPolicyChange((current) => pr.moveCustomCategory(current, category, direction === "up" ? -1 : 1)); }

// The designer prediction uses the authoritative shared solver (never a UI-only
// calculation), with all components intact and nominal source generation so the
// preview reflects the saved Blueprint policy over the current wiring.
function designerPowerFlowFor(wiring) {
  const PF = globalThis.PowerFlowRules; if (!PF) return null;
  const design = Array.isArray(state.design) ? state.design : [];
  const sourceGenerationByIndex = {};
  design.forEach((module, index) => {
    const gen = Number(PART_STATS[module?.type]?.powerGeneration) || 0;
    if (gen > 0 || rules().isPowerSourceType(module?.type)) sourceGenerationByIndex[index] = gen;
  });
  try {
    return PF.solvePowerFlow({ design, wiring, catalogue: PART_STATS, infrastructure: WIRING_INFRASTRUCTURE, sourceGenerationByIndex, componentOperationalByIndex: design.map(() => true) });
  } catch (_) { return null; }
}
function designerPowerFlow() { return designerPowerFlowFor(state.wiring); }

// Section flows keyed by id for one wiring value (authoritative solver only).
function sectionFlowsById(wiring) {
  const flow = designerPowerFlowFor(wiring);
  const map = new Map();
  if (flow && Array.isArray(flow.sectionFlows)) for (const f of flow.sectionFlows) map.set(f.sectionId, f);
  return map;
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
        currentSectionFlow, proposedSectionFlow, weakerTierRemainsOnRoute,
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
  const catRows = pr.POWER_CATEGORIES.map((cat) => {
    const c = summary.byCategory?.[cat] || { demandMw: 0, allocatedMw: 0, unmetMw: 0, priorityBand: null };
    const band = c.priorityBand == null ? "" : ` · priority ${c.priorityBand + 1}`;
    const shed = Number(c.unmetMw) > 0 ? " power-priority-shed" : "";
    return `<li class="power-priority-cat-row${shed}" data-diag-category="${cat}"><span class="power-priority-chip" data-category="${cat}">${escapeHtml(labels[cat])}</span> <span data-cat-demand>${mwText(c.demandMw)} demand</span> · <span data-cat-delivered>${mwText(c.allocatedMw)} delivered</span> · <span data-cat-unmet>${mwText(c.unmetMw)} unmet</span>${band}</li>`;
  }).join("");
  const shedText = (summary.loadShedCategories || []).length
    ? `Load-shed: ${summary.loadShedCategories.map((c) => escapeHtml(labels[c])).join(", ")}` : "No load shedding";
  return `<div class="power-priority-diagnostics" data-power-priority-diagnostics>
    <div class="wiring-summary-line">${mwText(summary.availableGenerationMw)} generation · ${mwText(summary.demandMw)} demand · ${mwText(summary.allocatedMw)} delivered · ${mwText(summary.unmetMw)} unmet</div>
    <div class="wiring-summary-line">${mwText(summary.spareGenerationMw)} spare · ${mwText(summary.strandedGenerationMw)} stranded · ${escapeHtml(shedText)}</div>
    <div class="wiring-summary-line power-priority-diag-heading">Unmet demand by priority</div>
    <ul class="power-priority-cat-list">${catRows}</ul>
  </div>`;
}

function renderPowerPriorityPanel() {
  const pr = policyRules(); if (!pr) return "";
  const policy = pr.normalizePolicy(state.wiring?.powerPolicy);
  const labels = pr.POWER_CATEGORY_LABELS;
  const bands = pr.resolvePriorityBands(policy);
  const isCustom = policy.preset === "custom";
  const presetButtons = PRESET_CHOICES.map((preset) => `<button type="button" class="power-priority-preset${policy.preset === preset ? " active" : ""}" data-wiring-action="power-preset" data-preset="${preset}" aria-pressed="${policy.preset === preset}">${escapeHtml(PRESET_LABELS[preset])}</button>`).join("");
  const bandNumberByCategory = new Map();
  bands.forEach((band, index) => band.forEach((cat) => bandNumberByCategory.set(cat, index + 1)));
  const order = isCustom ? policy.customOrder : pr.presetOrder(policy.preset);
  let rows;
  if (isCustom) {
    rows = order.map((cat, index) => {
      const upDisabled = index === 0 ? " disabled" : "";
      const downDisabled = index === order.length - 1 ? " disabled" : "";
      return `<li class="power-priority-row" data-custom-row data-category="${cat}"><span class="power-priority-number">${index + 1}</span><span class="power-priority-chip" data-category="${cat}">${escapeHtml(labels[cat])}</span><span class="power-priority-move"><button type="button" data-wiring-action="power-priority-move" data-category="${cat}" data-direction="up" aria-label="Move ${escapeHtml(labels[cat])} up"${upDisabled}>▲</button><button type="button" data-wiring-action="power-priority-move" data-category="${cat}" data-direction="down" aria-label="Move ${escapeHtml(labels[cat])} down"${downDisabled}>▼</button></span></li>`;
    }).join("");
  } else {
    rows = order.map((cat) => {
      const number = bandNumberByCategory.get(cat);
      const tied = bands[number - 1].length > 1;
      return `<li class="power-priority-row${tied ? " power-priority-tied" : ""}" data-priority-band="${number}" data-category="${cat}"><span class="power-priority-number">${number}</span><span class="power-priority-chip" data-category="${cat}">${escapeHtml(labels[cat])}</span>${tied ? `<span class="power-priority-tie-note" aria-label="tied priority">tied</span>` : ""}</li>`;
    }).join("");
  }
  const hint = isCustom
    ? `<div class="wiring-summary-line power-priority-hint">Reorder categories to set Custom priority. Shields and Point Defence order independently.</div>`
    : (bands.some((band) => band.length > 1) ? `<div class="wiring-summary-line power-priority-hint">Categories sharing a number are tied and share shortages fairly, staying separate categories.</div>` : "");
  return `<section class="wiring-summary-section" data-wiring-panel="power-priority"><h4>Power Priority</h4>
    <div class="power-priority-presets" role="group" aria-label="Power priority preset">${presetButtons}</div>
    <div class="power-priority-current wiring-summary-line">Preset: <strong data-power-priority-preset>${escapeHtml(PRESET_LABELS[policy.preset])}</strong></div>
    <ol class="power-priority-order">${rows}</ol>
    ${hint}
    ${renderPowerPriorityDiagnostics()}</section>`;
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
  if (!preview) {
    // Clear guidance instead of an empty panel while a comparison tool is
    // active but nothing is hovered or drawn yet.
    if (isPowerTierTool() && clarityRules()) {
      panel.hidden = false;
      panel.innerHTML = `<div class="wiring-preview-line" data-preview-empty-state>${escapeHtml(clarityRules().EMPTY_STATES.noSelection)}</div>`;
      return;
    }
    panel.hidden = true; panel.innerHTML = ""; return;
  }
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
  if (tool === "tier" && preview.affectedSectionIds) {
    const section = bucket("power").sections.find((s) => s.id === preview.affectedSectionIds[0]);
    rows.push(`<div class="wiring-preview-head">${escapeHtml(tierLabel(section?.tier))} → ${escapeHtml(tierLabel(selectedTier()))}</div>`);
  } else if (tool === "erase") {
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
  if (isPowerTierTool()) {
    const signature = editRules().previewSignature(["tier", id, selectedTier(), state.wiring.power.sections.length]);
    return cachedPreview(signature, () => attachPreviewClarity(editRules().previewPowerTierEdit(state.design, state.wiring, id, selectedTier(), PART_STATS, WIRING_INFRASTRUCTURE, previewOptions()), "tier", id));
  }
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
function terminal(index, kind, selected) { const center = rules().componentCenter(state.design[index], PART_STATS); return svgEl("circle", { cx: center.x, cy: center.y, r: 0.14 }, `wire-terminal wire-terminal-${kind}${selected ? " selected" : ""}`); }
const DATA_SECTION_SEVERITY_CLASS = Object.freeze({ critical: "data-critical-section", high: "data-high-impact-section", medium: "data-medium-impact-section", low: "data-low-impact-section", redundant: "data-redundant-section" });
function positiveContributionIndices(weapon) { return new Set((weapon?.contributions || []).filter((item) => Number(item.amount) > 0).map((item) => item.sourceIndex)); }

function renderWiringOverlay() {
  const host = dom.wiringOverlayHost; if (!host || state.blueprintView !== "wiring") return; const view = ui(); host.replaceChildren(); dom.grid?.classList.add("wiring-overlay-active");
  const svg = svgEl("svg", { viewBox: `0 0 ${GRID_SIZE} ${GRID_SIZE}` }, "wiring-overlay"); const selectedNet = selectedNetwork(); const analysis = currentAnalysis(); const dataAnalysis = view.mode === "data" ? currentDataInspection() : null; const dataSource = dataAnalysis?.sourceAllocationByIndex?.[view.selectedIndex]; const dataWeapon = dataAnalysis?.weaponBonusByIndex?.[view.selectedIndex]; const selectedDataNetworkId = selectedNet?.id || dataSource?.networkId || dataWeapon?.networkId || view.selectedDataNetworkId;
  const vulnerabilities = view.mode === "data" && dataAnalysis ? getCachedDataVulnerabilities(state.design, state.wiring, PART_STATS, dataAnalysis) : [];
  const sectionVulnerabilityById = new Map(vulnerabilities.filter((item) => item.kind === "section").map((item) => [item.id, item]));
  const hostVulnerabilityByIndex = new Map(vulnerabilities.filter((item) => item.kind === "host").map((item) => [item.componentIndex, item]));
  const selectedSourceActiveRecipients = new Set(dataSource && Number(dataSource.effectiveBudget) > 0 ? dataSource.eligibleWeaponIndices || [] : []);
  const selectedSourceZeroRecipients = new Set(dataSource && Number(dataSource.effectiveBudget) <= 0 ? dataSource.connectedWeaponIndices || [] : []);
  const selectedWeaponActiveContributors = positiveContributionIndices(dataWeapon);
  const selectedWeaponZeroContributors = new Set(dataWeapon ? (dataAnalysis.sources || []).filter((src) => src.networkId === dataWeapon.networkId && !selectedWeaponActiveContributors.has(src.sourceIndex)).map((src) => src.sourceIndex) : []);
  const glowLayer = svgGroup("wire-glow-layer");
  const visibleLayer = svgGroup("wire-visible-layer"); const hitLayer = svgGroup("wire-hit-layer");
  const markerLayer = svgGroup("wire-marker-layer"); const indicatorLayer = svgGroup("wire-indicator-layer"); const portLayer = svgGroup("wire-port-layer");
  // SVG paint order is also hit-test order. The glow layer is drawn first (below
  // everything) so status halos read as an outer ring while the tier-coloured
  // cable stays on top. Ports remain last so they win hit testing over cable.
  svg.append(glowLayer, visibleLayer, hitLayer, markerLayer, indicatorLayer, portLayer);
  // Section 7D-2: per-section delivered flow status from the shared solver, used
  // for the load/above-sustained/at-peak overlays (never replaces tier colour).
  const powerFlowBySection = new Map();
  if (view.mode === "power") { try { const flow = designerPowerFlow(); if (flow && Array.isArray(flow.sectionFlows)) for (const f of flow.sectionFlows) powerFlowBySection.set(f.sectionId, f); } catch (_) { /* preview optional */ } }
  const POWER_STATUS_TEXT = { working: "working", loaded: "highly loaded", above: "above sustained capacity", peak: "at peak capacity", broken: "disconnected" };
  for (const section of bucket().sections) {
    const netForSection = view.mode === "data" ? dataAnalysis?.networks?.find((network) => network.sectionIds.includes(section.id)) : null;
    const isSelected = selectedNet?.sectionIds.includes(section.id) || (view.mode === "data" && selectedDataNetworkId && netForSection?.id === selectedDataNetworkId);
    const powerState = view.mode === "power" ? analysis.power.networks.find((network) => network.sectionIds.includes(section.id))?.status : null;
    const dim = view.mode === "data" && selectedDataNetworkId && netForSection?.id !== selectedDataNetworkId ? " data-dimmed" : "";
    const sectionVulnerability = sectionVulnerabilityById.get(section.id);
    const severityClass = view.mode === "data" ? DATA_SECTION_SEVERITY_CLASS[sectionVulnerability?.severity] || "" : "";
    // Tier-specific stroke width. The rendered thickness is authoritative balance
    // data; only the VISIBLE stroke scales, never the hit target (a separate wide
    // line below), so Light cable stays easy to tap.
    const tierClass = view.mode === "power" ? ` wire-tier-${section.tier || "standard"}` : "";
    const hovered = ui().hoveredSectionId === section.id && ui().sourceIndex == null;
    const previewClass = hovered && (isPowerTierTool() || currentTool() === "erase") ? " wire-section-preview" : hovered && currentTool() === "inspect" ? " wire-section-hover" : "";
    // Power status is an OVERLAY (halo), so the tier colour on the visible line is
    // never replaced. Determine the status severity from connectivity + flow.
    let powerSeverity = null;
    if (view.mode === "power") {
      const flow = powerFlowBySection.get(section.id);
      if (powerState === "unpowered") powerSeverity = "broken";
      else if (flow && flow.atPeak) powerSeverity = "peak";
      else if (flow && flow.aboveSustained) powerSeverity = "above";
      else if ((flow && Number(flow.sustainedUtilisation) >= 0.75) || powerState === "underpowered") powerSeverity = "loaded";
      else powerSeverity = "working";
    }
    if (view.mode === "power") {
      const haloWidth = (extra) => (Number(renderedStrokeWidth(section.tier)) + extra).toFixed(3);
      // Selection halo (bottom, widest) then status halo, both under the tier line.
      if (isSelected) { const sel = line(section, "wire-status-halo wire-status-selected"); sel.style.strokeWidth = haloWidth(0.14); sel.dataset.sectionId = section.id; glowLayer.appendChild(sel); }
      if (powerSeverity) { const st = line(section, `wire-status-halo wire-status-${powerSeverity}`); st.style.strokeWidth = haloWidth(0.07); st.dataset.sectionId = section.id; glowLayer.appendChild(st); }
      if (powerSeverity === "peak") { const mx = (section.x1 + section.x2) / 2 + 0.5; const my = (section.y1 + section.y2) / 2 + 0.5; glowLayer.appendChild(svgEl("circle", { cx: mx, cy: my, r: 0.09 }, "wire-status-peak-marker")); }
    }
    // Power selection is shown by the .wire-status-selected halo above; Data mode
    // has no halo, so selected Data-network sections keep their positive emphasis
    // class (the counterpart to data-dimmed on the other networks).
    const selectedClass = view.mode === "data" && isSelected ? " wire-net-selected" : "";
    const visible = line(section, `wire-${view.mode}${tierClass}${dim}${selectedClass}${severityClass ? ` ${severityClass}` : ""}${previewClass}`);
    if (view.mode === "power") { visible.style.strokeWidth = renderedStrokeWidth(section.tier); if (powerSeverity) visible.dataset.powerStatus = powerSeverity; if (isSelected) visible.dataset.powerSelected = "true"; }
    visible.dataset.sectionId = section.id; visibleLayer.appendChild(visible);
    const tierText = view.mode === "power" ? `. ${tierLabel(section.tier)}` : "";
    const statusText = view.mode === "power" && powerSeverity ? `. Status: ${POWER_STATUS_TEXT[powerSeverity]}${isSelected ? ", selected" : ""}.` : "";
    const severityText = view.mode === "data" ? `. Vulnerability: ${sectionVulnerability?.severity || "unknown"}.` : "";
    const hit = line(section, "wire-hit"); hit.dataset.sectionId = section.id; hit.setAttribute("tabindex", "0"); hit.setAttribute("role", "button"); hit.setAttribute("aria-label", `${sectionActionVerb()} ${view.mode} cable section from ${section.x1},${section.y1} to ${section.x2},${section.y2}${tierText}${statusText}${severityText}`); hitLayer.appendChild(hit);
  }
  rules().junctionCells(bucket()).forEach((cell) => markerLayer.appendChild(svgEl("circle", { cx: cell.x + .5, cy: cell.y + .5, r: .09, "data-junction-degree": cell.degree }, "wire-junction")));
  (selectedNet?.componentIndices || []).forEach((index) => indicatorLayer.appendChild(terminal(index, view.mode, true)));
  if (view.mode === "power") state.design.forEach((module, index) => {
    if (!rules().isPowerConsumer(module.type, PART_STATS)) return;
    const className = analysis.power.disconnectedConsumerIndices.includes(index) ? "wire-comp-disconnected" : analysis.power.underpoweredConsumerIndices.includes(index) ? "wire-comp-underpowered" : "wire-comp-connected-dest";
    const rect = moduleRect(index, className); if (rect) indicatorLayer.appendChild(rect);
  });
  state.design.forEach((module, index) => rules().moduleCells(module, PART_STATS).forEach((cell) => {
    const power = rules().isPowerSourceType(module.type); const data = rules().isDataSourceType(module.type); const offset = power && data ? .08 : 0;
    const addPort = (kind, x) => { const port = svgEl("circle", { cx: cell.x + .5 + x, cy: cell.y + .5, r: .11, tabindex: 0, role: "button", "aria-label": `Start ${kind} cable from ${moduleLabel(index)}` }, `wire-port wire-port-${kind} source`); port.dataset.wiringPortKind = kind; port.dataset.wiringComponentIndex = index; port.dataset.wiringCellX = cell.x; port.dataset.wiringCellY = cell.y; portLayer.appendChild(port); };
    if (power) addPort("power", -offset); if (data) addPort("data", offset);
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
  if (view.sourceIndex != null) {
    const sourceType = state.design[view.sourceIndex]?.type; state.design.forEach((module, index) => { if (sourceType && index !== view.sourceIndex && isValidDestination(view.mode, sourceType, module.type)) { const rect = moduleRect(index, "wire-comp-candidate"); if (rect) indicatorLayer.appendChild(rect); } });
    for (let i = 1; i < view.path.length; i += 1) visibleLayer.appendChild(line({ x1: view.path[i - 1].x, y1: view.path[i - 1].y, x2: view.path[i].x, y2: view.path[i].y }, `wire-preview confirmed wire-preview-${view.mode}`));
    if (view.activeOrigin) markerLayer.appendChild(svgEl("circle", { cx: view.activeOrigin.x + .5, cy: view.activeOrigin.y + .5, r: .18 }, "wire-branch-origin"));
    if (view.dragging && view.livePointer) { const last = view.path.at(-1); visibleLayer.appendChild(svgEl("line", { x1: last.x + .5, y1: last.y + .5, x2: view.livePointer.x, y2: view.livePointer.y }, `wire-preview ${view.hoverCell && !view.hoverCell.valid ? "invalid" : "valid"} wire-preview-${view.mode}`)); }
    const last = view.path.at(-1); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const x = last.x + dx; const y = last.y + dy; if (partIndexAt(x, y) >= 0 && !view.path.some((cell) => cell.x === x && cell.y === y)) markerLayer.appendChild(svgEl("circle", { cx: x + 0.5, cy: y + 0.5, r: 0.12 }, "wire-next-cell")); }
    if (view.hoverCell && !view.hoverCell.valid) markerLayer.appendChild(svgEl("circle", { cx: view.hoverCell.x + 0.5, cy: view.hoverCell.y + 0.5, r: 0.15 }, "wire-invalid-cell"));
  }
  host.appendChild(svg);
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
    const flowRows = flow
      ? `<div class="wiring-summary-line" data-section-flow>Predicted flow: ${Math.round((Number(flow.absoluteFlowMw) || 0) * 100) / 100} MW · ${Math.round((Number(flow.sustainedUtilisation) || 0) * 100)}% of sustained · ${Math.round((Number(flow.peakUtilisation) || 0) * 100)}% of peak (current estimate)</div>
         <div class="wiring-summary-line" data-section-heat>${heatRate === null ? escapeHtml(clarity.EMPTY_STATES.incompleteRoute) : `Cable Heat contribution: ${Math.round(heatRate * 1000) / 1000} H/s under this activity`}</div>
         <div class="wiring-summary-line" data-section-protection>Protection state: ${escapeHtml(protectionState)} · Overload stress: none before deployment (accumulates in battle above sustained)</div>`
      : `<div class="wiring-summary-line" data-section-flow>${escapeHtml(clarity.EMPTY_STATES.noPowerPath)}</div>`;
    clarityHtml = `
    ${flowRows}
    <div class="wiring-summary-line" data-section-cell-cost>Selected cells: $${cellCost} installed cost · ${cellDisplacement} Heat-capacity displacement</div>
    <div class="wiring-summary-line" data-section-route>${isBottleneck ? "Bottleneck: yes" : "Bottleneck: no"} · ${hasAlternateRoute ? "Alternate route: yes" : escapeHtml(clarity.EMPTY_STATES.noAlternateRoute)}</div>
    <div class="wiring-summary-line wiring-section-interpretation" data-section-interpretation>${interpretation.map(escapeHtml).join(" ")}</div>`;
  }
  return `<div class="wiring-summary-section" data-wiring-inspection="power-section"><h4>${escapeHtml(tierLabel(section.tier))}</h4>
    <div class="wiring-summary-line">Cable rating: ${Number(tier.sustainedCapacityMw) || 0} MW sustained / ${Number(tier.peakCapacityMw) || 0} MW peak</div>
    <div class="wiring-summary-line">Section (${section.x1},${section.y1}) ↔ (${section.x2},${section.y2})</div>
    <div class="wiring-summary-line">Hosts: ${endpointHtml}</div>
    <div class="wiring-summary-line">${network ? `Physical network: ${escapeHtml(network.label)}` : "Not part of a sourced network"}</div>
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

function renderStatusPanel() {
  const panel = dom.wiringStatusPanel; if (!panel || state.blueprintView !== "wiring") return; const analysis = currentAnalysis(); const network = selectedNetwork(); const section = bucket().sections.find((item) => item.id === ui().selectedSectionId);
  const current = rules().countUniqueSections(state.wiring, ui().mode); const additional = rules().additionalLengthForPath(state.wiring, ui().mode, ui().path); const limit = CABLE_LIMITS[ui().mode];
  const degrees = section ? rules().sectionEndpointDegrees(bucket()).get(section.id) : null; const junctionCount = network ? rules().junctionCells({ sections: network.sections }).length : 0; const mw = (value) => `${Number(value).toFixed(1)} MW`; const labels = (indices) => indices.map(moduleLabel).map(escapeHtml).join(", ") || "None";
  const branch = section ? rules().findLeafBranchSections(bucket(), section.id) : null; const role = !section ? "" : degrees.some((degree) => degree > 2) ? "junction-adjacent" : branch.reason === "leaf-branch" ? "leaf branch" : degrees.every((degree) => degree === 2) ? "trunk or loop" : "branch";
  const status = network ? (ui().mode === "power" ? network.status : network.sourceIndices.length ? "online" : "source-less") : null;
  if (ui().sourceIndex == null && ui().mode === "data" && renderDataInspectionPanel(panel, section)) return;
  const priorityPanel = ui().mode === "power" ? renderPowerPriorityPanel() : "";
  const infrastructurePanel = ui().mode === "power" ? infrastructureSummaryHtml() : "";
  const observationsPanel = ui().mode === "power" ? blueprintObservationsHtml() : "";
  panel.hidden = false; panel.tabIndex = -1; panel.innerHTML = `<h3>Physical ${escapeHtml(ui().mode)} wiring</h3>
    ${infrastructurePanel}
    ${observationsPanel}
    ${priorityPanel}
    <div class="wiring-summary-line">${current} unique cable sections${ui().path.length > 1 ? ` · +${additional} new in preview` : ""}${Number.isFinite(limit) ? ` · ${Math.max(0, limit - current - additional)} remaining` : ""}</div>
    ${ui().sourceIndex != null ? `<div class="wiring-drawing-actions"><button type="button" data-wiring-action="finish" ${ui().path.length < 2 || pathOverLimit() ? "disabled" : ""}>Finish cable</button><button type="button" data-wiring-action="cancel-drawing">Cancel drawing</button></div>` : ""}
    ${network ? `<div class="wiring-summary-section"><h4>${escapeHtml(network.label)} — ${escapeHtml(status)}</h4><div class="wiring-summary-line">${network.sections.length} sections · ${junctionCount} junctions · ${network.sourceIndices.length ? "contains a source" : "source-less"}</div><div class="wiring-summary-line">Sources: ${labels(network.sourceIndices)}</div><div class="wiring-summary-line">${ui().mode === "power" ? `Consumers: ${labels(network.consumerIndices)}<br>${mw(network.generationMw)} generation / ${mw(network.demandMw)} demand · ${network.surplusMw >= 0 ? `${mw(network.surplusMw)} surplus` : `${mw(network.deficitMw)} deficit`} · ${Math.round(network.availableEfficiency * 100)}% available` : `Data supports: ${labels(network.sourceIndices)}<br>Compatible weapons: ${labels(network.weaponIndices)}`}</div><div class="wiring-summary-line">Passive hosts: ${labels(network.hostIndices.filter((index) => !network.componentIndices.includes(index)))}</div></div>` : ""}
    ${section ? `<div class="wiring-summary-section"><h4>Selected physical section</h4><div class="wiring-summary-line">(${section.x1},${section.y1}) ↔ (${section.x2},${section.y2}) · ${escapeHtml(section.tier)} tier · ${role}</div><div class="wiring-summary-line">Endpoint degrees: ${degrees[0]} / ${degrees[1]} · Hosts: ${labels([...new Set(rules().sectionCells(section).map((cell) => partIndexAt(cell.x, cell.y)).filter((index) => index >= 0))])}</div><div class="wiring-section-actions"><button type="button" data-wiring-action="branch-a">Branch from A</button><button type="button" data-wiring-action="branch-b">Branch from B</button><button type="button" data-wiring-action="remove-section">Remove section</button><button type="button" data-wiring-action="remove-branch">Remove branch</button><button type="button" data-wiring-action="cancel-selection">Cancel selection</button></div></div>` : ""}
    ${section ? powerSectionInspectionHtml(section) : ""}`;
}
