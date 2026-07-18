// Wiring v2 editor: canonical physical sections own topology and membership.
import { dom } from "./dom.js";
import { state } from "../state.js";
import { PART_DEFS, PART_STATS } from "../design/parts.js";
import { findPartAtCell } from "../design/placementCandidate.js";
import { getFootprintBounds } from "../design/footprint.js";
import { persistDesign, defaultWiring, normalizeWiring } from "../design/blueprintStorage.js";
import { escapeHtml } from "../shared/formatting.js";
import { getCachedDesignDataSupport, getCachedDataVulnerabilities } from "../design/dataSupportAnalysis.js";
import { formatDataSupportValue, formatDataSupportEquation } from "../design/dataSupportPresentation.js";

const GRID_SIZE = 15;
const MAX_UNDO = 60;
const SVG_NS = "http://www.w3.org/2000/svg";
const DRAG_THRESHOLD_PX = 5;
const CABLE_LIMITS = Object.freeze({ ...globalThis.WiringRules?.DEFAULT_CABLE_LIMITS });
let pointerDrag = null;
let suppressNextClick = false;
function rules() { return globalThis.WiringRules; }
function ui() { return state.wiringUi; }
function currentAnalysis() { return rules().analyzeWiring(state.design, state.wiring, PART_STATS); }
function currentDataInspection() { return getCachedDesignDataSupport(state.design, state.wiring, PART_STATS, { thermalLoadMode: state.thermalLoadMode || "full" }); }
function partName(type) { return PART_DEFS[type]?.name || PART_STATS[type]?.name || type; }
function moduleLabel(index) { const module = state.design[index]; return module ? `${partName(module.type)} (${module.x},${module.y})` : "Unknown"; }
function bucket(kind = ui().mode) { return state.wiring?.[kind] || { sections: [], connections: [] }; }
function partIndexAt(x, y) { const part = findPartAtCell(state.design, PART_STATS, x, y); return part ? state.design.indexOf(part) : -1; }
function isValidSource(mode, type) { return mode === "data" ? rules().isDataSourceType(type) : rules().isPowerSourceType(type); }
function isValidDestination(mode, sourceType, destinationType) { return mode === "data" ? rules().isCompatibleWeapon(sourceType, destinationType, PART_STATS) : rules().isPowerConsumer(destinationType, PART_STATS); }

function pushUndo() { const stack = ui().undoStack; stack.push(rules().cloneWiring(state.wiring)); if (stack.length > MAX_UNDO) stack.shift(); }
function commitWiring(next) { state.wiring = next; persistDesign(state.design, state.wiring, state.combatStyle); refreshWiringPresentation(); }
function releasePointerCapture() { if (!pointerDrag) return; const { target, pointerId } = pointerDrag; if (target?.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId); pointerDrag = null; }
function resetInteraction(clearSelection = true) { releasePointerCapture(); const view = ui(); view.sourceIndex = null; view.path = []; view.hoverCell = null; view.livePointer = null; view.dragging = false; view.activeOrigin = null; if (clearSelection) { view.selectedIndex = null; view.selectedConnectionKey = null; view.selectedSectionId = null; view.selectedDataNetworkId = null; } }
export function syncWiringWithDesign() { state.wiring = normalizeWiring(state.wiring, state.design); resetInteraction(); }
export function resetWiringToDefault() { state.wiring = normalizeWiring(defaultWiring(), state.design); ui().undoStack = []; resetInteraction(); }
export function clearAllWiring() { state.wiring = rules().emptyWiring(); ui().undoStack = []; resetInteraction(); }
export function resetWiringEditorState() { resetInteraction(); ui().undoStack = []; }
function undoWiring() { if (!ui().undoStack.length) return; const previous = ui().undoStack.pop(); resetInteraction(); commitWiring(normalizeWiring(previous, state.design)); }

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
function commitActivePath() { if (ui().path.length < 2 || pathOverLimit()) return; pushUndo(); const next = rules().addPath(state.wiring, ui().mode, ui().path, state.design, PART_STATS); resetInteraction(); ui().activeOrigin = null; commitWiring(next); }
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
function setMode(mode) { if (ui().mode === mode) return; resetInteraction(); ui().mode = mode; refreshWiringPresentation(); }

let controlsBound = false;
export function suppressWiringClick() { if (!suppressNextClick) return false; suppressNextClick = false; return true; }
export function bindWiringControls() {
  if (controlsBound) return; controlsBound = true;
  bindPointerDrawing();
  dom.wiringModePower?.addEventListener("click", () => setMode("power"));
  dom.wiringModeData?.addEventListener("click", () => setMode("data"));
  dom.wiringUndoButton?.addEventListener("click", undoWiring);
  dom.wiringClearNetworkButton?.addEventListener("click", clearSelectedNetwork);
  dom.wiringOverlayHost?.addEventListener("click", (event) => {
    const port = event.target?.closest?.("[data-wiring-port-kind]");
    if (port && ui().sourceIndex == null) { event.stopPropagation(); if (port.dataset.wiringPortKind === ui().mode) beginPath(Number(port.dataset.wiringComponentIndex), { x: Number(port.dataset.wiringCellX), y: Number(port.dataset.wiringCellY) }); return; }
    const id = event.target?.dataset?.sectionId; if (!id) return;
    if (ui().sourceIndex != null) {
      if (event.button !== 0) return;
      const endpoint = wireEndpointFromEvent(event); if (!endpoint) return;
      event.preventDefault(); event.stopPropagation(); handleWiringCellClick(endpoint.x, endpoint.y); return;
    }
    event.stopPropagation(); resetInteraction(); ui().selectedSectionId = id; refreshWiringPresentation();
  });
  dom.wiringOverlayHost?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const port = event.target?.closest?.("[data-wiring-port-kind]");
    if (!port || ui().sourceIndex != null || port.dataset.wiringPortKind !== ui().mode) return;
    event.preventDefault(); event.stopPropagation();
    beginPath(Number(port.dataset.wiringComponentIndex), { x: Number(port.dataset.wiringCellX), y: Number(port.dataset.wiringCellY) });
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
  dom.wiringStatusPanel?.addEventListener("click", (event) => { const action = event.target?.dataset?.wiringAction; if (action === "branch-a" || action === "branch-b") branchFrom(action.at(-1)); else if (action === "remove-section") { removeSelectedSection(); focusStatusPanel(); } else if (action === "remove-branch") { removeSelectedBranch(); focusStatusPanel(); } else if (action === "inspect-component") { inspectComponent(Number(event.target.dataset.index)); focusStatusPanel(); } else if (action === "select-network") { ui().selectedDataNetworkId = event.target.dataset.networkId; ui().selectedIndex = null; ui().selectedSectionId = null; refreshWiringPresentation(); focusStatusPanel(); } else if (action === "cancel-selection") { resetInteraction(); refreshWiringPresentation(); focusStatusPanel(); } else if (action === "cancel-drawing") { cancelDrawing(); focusStatusPanel(); } else if (action === "finish") { commitActivePath(); focusStatusPanel(); } });
}

export function refreshWiringPresentation() { if (state.blueprintView !== "wiring") return; bindWiringControls(); refreshToolbar(); renderWiringOverlay(); renderStatusPanel(); }
export function clearWiringPresentation() { resetInteraction(false); dom.wiringOverlayHost?.replaceChildren(); dom.grid?.classList.remove("wiring-overlay-active"); if (dom.wiringStatusPanel) { dom.wiringStatusPanel.hidden = true; dom.wiringStatusPanel.innerHTML = ""; } }
function refreshToolbar() {
  dom.wiringModePower?.classList.toggle("active", ui().mode === "power"); dom.wiringModePower?.setAttribute("aria-pressed", String(ui().mode === "power"));
  dom.wiringModeData?.classList.toggle("active", ui().mode === "data"); dom.wiringModeData?.setAttribute("aria-pressed", String(ui().mode === "data"));
  if (dom.wiringUndoButton) dom.wiringUndoButton.disabled = !ui().undoStack.length;
  if (dom.wiringClearNetworkButton) dom.wiringClearNetworkButton.disabled = ui().sourceIndex != null || !selectedNetwork();
  if (dom.wiringHint) dom.wiringHint.textContent = ui().sourceIndex == null ? "Draw through components. Compatible systems touched by the cable join automatically. Drag from an existing cable to create a branch." : "Continue through occupied cells; click the last cell or release to finish. Reused trunk sections add no cable length.";
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
  const visibleLayer = svgGroup("wire-visible-layer"); const hitLayer = svgGroup("wire-hit-layer");
  const markerLayer = svgGroup("wire-marker-layer"); const indicatorLayer = svgGroup("wire-indicator-layer"); const portLayer = svgGroup("wire-port-layer");
  // SVG paint order is also hit-test order. Ports intentionally remain last so
  // their normal-sized circles are authoritative where a cable crosses them.
  svg.append(visibleLayer, hitLayer, markerLayer, indicatorLayer, portLayer);
  for (const section of bucket().sections) {
    const netForSection = view.mode === "data" ? dataAnalysis?.networks?.find((network) => network.sectionIds.includes(section.id)) : null;
    const isSelected = selectedNet?.sectionIds.includes(section.id) || (view.mode === "data" && selectedDataNetworkId && netForSection?.id === selectedDataNetworkId);
    const powerState = view.mode === "power" ? analysis.power.networks.find((network) => network.sectionIds.includes(section.id))?.status : null;
    const dim = view.mode === "data" && selectedDataNetworkId && netForSection?.id !== selectedDataNetworkId ? " data-dimmed" : "";
    const sectionVulnerability = sectionVulnerabilityById.get(section.id);
    const severityClass = view.mode === "data" ? DATA_SECTION_SEVERITY_CLASS[sectionVulnerability?.severity] || "" : "";
    visibleLayer.appendChild(line(section, `wire-${view.mode}${dim}${severityClass ? ` ${severityClass}` : ""}${powerState === "online" ? " wire-net-working" : powerState === "underpowered" ? " wire-net-underpowered" : powerState === "unpowered" ? " wire-net-broken" : ""}${isSelected ? " wire-net-selected" : ""}`));
    const severityText = view.mode === "data" ? `. Vulnerability: ${sectionVulnerability?.severity || "unknown"}.` : "";
    const hit = line(section, "wire-hit"); hit.dataset.sectionId = section.id; hit.setAttribute("aria-label", `Select ${view.mode} cable section from ${section.x1},${section.y1} to ${section.x2},${section.y2}${severityText}`); hitLayer.appendChild(hit);
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
  const buttons = (indices, kind) => indices.map(i => `<button type="button" data-wiring-action="inspect-component" data-index="${i}">${escapeHtml(moduleLabel(i))}</button>`).join(" ") || "None";
  let body = `<h3>Data-support inspection</h3><div id="data-support-live" aria-live="polite" class="sr-only">Data support prediction refreshed for ${escapeHtml(analysis.scenarioLabel)}.</div><label class="wiring-summary-line data-scenario-label">Prediction scenario <select data-wiring-action="data-scenario" aria-label="Data support prediction scenario"><option value="idle" ${analysis.scenario === "idle" ? "selected" : ""}>Idle</option><option value="combat" ${analysis.scenario === "combat" ? "selected" : ""}>Typical Combat</option><option value="full" ${analysis.scenario === "full" ? "selected" : ""}>Maximum Sustained Load</option></select></label>`;
  body += `<div class="wiring-summary-line">${analysis.networks.length} physical Data networks · ${analysis.sources.filter(s => s.effectiveBudget > 0).length} active sources · ${analysis.weapons.filter(w => w.status === "supported").length} supported weapons · ${analysis.cableSectionCount} cable sections</div>`;
  if (source) {
    body += `<section class="wiring-summary-section"><h4>${escapeHtml(partName(source.sourceType))} — ${escapeHtml(source.status)}</h4><div class="wiring-summary-line">Network: ${escapeHtml(source.networkLabel || "Disconnected")}</div><div class="wiring-summary-line">Effect: ${escapeHtml(source.effect)} · nominal ${fmtBonus(source.nominalBudget, source.bonusField)}</div><div class="wiring-summary-line">Power ${pct(source.predictedPowerMultiplier)} · Heat ${pct(source.predictedThermalMultiplier)} · Operational ${pct(source.predictedOperationalMultiplier)} · Final ${pct(source.predictedSourceMultiplier)}</div><div class="wiring-summary-line">Effective budget ${fmtBonus(source.effectiveBudget, source.bonusField)} · recipients ${source.recipientCount} · each receives ${fmtBonus(source.bonusPerWeapon, source.bonusField)}</div><div class="wiring-summary-line">${escapeHtml(source.statusReason)}</div><div class="wiring-summary-line">${escapeHtml(partName(source.sourceType))} effective budget: ${escapeHtml(formatDataSupportEquation(source))}.</div><div class="wiring-summary-line">Connected weapons: ${buttons(source.connectedWeaponIndices, "weapon")}</div><div class="wiring-summary-line"><strong>Failure impact:</strong> ${escapeHtml(selectedSourceVulnerability?.severity || "redundant")} · lost ${escapeHtml(lossesHtml(selectedSourceVulnerability))}. ${selectedSourceVulnerability?.severity === "redundant" ? "Another source fully preserves current output." : "Other Data sources remain operational where connected."}</div></section>`;
  } else if (weapon) {
    const b = weapon.baseProfile, e = weapon.effectiveProfile;
    body += `<section class="wiring-summary-section"><h4>${escapeHtml(partName(weapon.weaponType))} — ${escapeHtml(weapon.status)}</h4><div class="wiring-summary-line">Network: ${escapeHtml(weapon.networkLabel || "Disconnected")}</div><div class="wiring-summary-line">${escapeHtml(weapon.statusReason)}</div><div class="wiring-summary-line">Contributing sources: ${buttons(weapon.sourceIndices, "source")}</div>${statLine("Range", b.range, e.range, "")}${statLine("Accuracy", (b.accuracy || 0) * 100, (e.accuracy || 0) * 100, "%")}${statLine("Fire rate", b.fireRate, e.fireRate, "/s")}${statLine("Reload", b.reload, e.reload, "ms")}${statLine("DPS", b.dps, e.dps, "")}`;
    if (!weapon.contributions.length) body += `<div class="wiring-summary-line">Operating at base stats.</div>`;
    else body += weapon.contributions.map(c => `<div class="wiring-summary-line">${escapeHtml(partName(c.sourceType))}: ${fmtBonus(c.amount, c.bonusField)} ${escapeHtml(c.effect || c.bonusField)} (${fmtBonus(c.effectiveBudget, c.bonusField)} ÷ ${c.recipientCount})</div>`).join("");
    body += `</section>`;
  }
  if (network) body += `<section class="wiring-summary-section"><h4>${escapeHtml(network.label)}</h4><div class="wiring-summary-line">Sources: ${buttons(network.sourceIndices, "source")}</div><div class="wiring-summary-line">Weapons: ${buttons(network.weaponIndices, "weapon")}</div></section>`;
  if (selectedHost) body += `<section class="wiring-summary-section"><h4>${escapeHtml(moduleLabel(selectedHost.componentIndex))}</h4><div class="wiring-summary-line">Hosts Data cable sections. Failure impact: <strong>${escapeHtml(selectedHost.severity)}</strong></div><div class="wiring-summary-line">Topology changes: ${selectedHost.topologyChanged ? "yes" : "no"} · ${escapeHtml(selectedHost.summary)}</div><div class="wiring-summary-line">Lost support: ${escapeHtml(lossesHtml(selectedHost))}</div><div class="wiring-summary-line">Redundancy: ${selectedHost.severity === "redundant" ? "redundant route preserves connectivity" : "single point of failure for listed support"}</div></section>`;
  if (section) { const hit = vuln.find(v => v.kind === "section" && v.id === section.id); body += `<section class="wiring-summary-section"><h4>Selected Data section</h4><div class="wiring-summary-line">(${section.x1},${section.y1}) ↔ (${section.x2},${section.y2}) · ${escapeHtml(hit?.severity || "ordinary")}</div><div class="wiring-summary-line">${escapeHtml(hit?.summary || "No predicted support loss.")}</div><div class="wiring-summary-line">Lost support: ${escapeHtml(lossesHtml(hit))}</div></section>`; }
  if (!source && !weapon && !section) body += `<section class="wiring-summary-section"><h4>Networks</h4>${analysis.networks.map(n => `<button type="button" aria-selected="${network?.id === n.id}" data-wiring-action="select-network" data-network-id="${escapeHtml(n.id)}">${escapeHtml(n.label)} · ${n.sourceIndices.length} sources · ${n.weaponIndices.length} weapons${n.sourceIndices.length ? "" : " · no source"}</button>`).join(" ") || "<div class=\"wiring-summary-line\">No Data networks yet.</div>"}</section>`;
  const warnings = [...analysis.networks.filter(n => !n.sourceIndices.length && n.weaponIndices.length).map(n => `${n.label} has weapons but no support source.`), ...analysis.sources.filter(s => s.predictedPowerMultiplier <= 0 && s.networkId).map(s => `${partName(s.sourceType)} is connected to Data but has no Power.`), ...analysis.sources.filter(s => s.predictedThermalMultiplier < 1).map(s => `${partName(s.sourceType)} is predicted thermally reduced in ${analysis.scenarioLabel}.`)];
  body += warnings.length ? `<section class="wiring-summary-section"><h4>Warnings</h4>${warnings.slice(0, 5).map(w => `<div class="wiring-summary-line">⚠ ${escapeHtml(w)}</div>`).join("")}</section>` : "";
  panel.hidden = false; panel.tabIndex = -1; panel.innerHTML = body;
  return true;
}

function renderStatusPanel() {
  const panel = dom.wiringStatusPanel; if (!panel || state.blueprintView !== "wiring") return; const analysis = currentAnalysis(); const network = selectedNetwork(); const section = bucket().sections.find((item) => item.id === ui().selectedSectionId);
  if (ui().mode === "data" && renderDataInspectionPanel(panel, section)) return;
  const current = rules().countUniqueSections(state.wiring, ui().mode); const additional = rules().additionalLengthForPath(state.wiring, ui().mode, ui().path); const limit = CABLE_LIMITS[ui().mode];
  const degrees = section ? rules().sectionEndpointDegrees(bucket()).get(section.id) : null; const junctionCount = network ? rules().junctionCells({ sections: network.sections }).length : 0; const mw = (value) => `${Number(value).toFixed(1)} MW`; const labels = (indices) => indices.map(moduleLabel).map(escapeHtml).join(", ") || "None";
  const branch = section ? rules().findLeafBranchSections(bucket(), section.id) : null; const role = !section ? "" : degrees.some((degree) => degree > 2) ? "junction-adjacent" : branch.reason === "leaf-branch" ? "leaf branch" : degrees.every((degree) => degree === 2) ? "trunk or loop" : "branch";
  const status = network ? (ui().mode === "power" ? network.status : network.sourceIndices.length ? "online" : "source-less") : null;
  panel.hidden = false; panel.tabIndex = -1; panel.innerHTML = `<h3>Physical ${escapeHtml(ui().mode)} wiring</h3>
    <div class="wiring-summary-line">${current} unique cable sections${ui().path.length > 1 ? ` · +${additional} new in preview` : ""}${Number.isFinite(limit) ? ` · ${Math.max(0, limit - current - additional)} remaining` : ""}</div>
    ${ui().sourceIndex != null ? `<div class="wiring-drawing-actions"><button type="button" data-wiring-action="finish" ${ui().path.length < 2 || pathOverLimit() ? "disabled" : ""}>Finish cable</button><button type="button" data-wiring-action="cancel-drawing">Cancel drawing</button></div>` : ""}
    ${network ? `<div class="wiring-summary-section"><h4>${escapeHtml(network.label)} — ${escapeHtml(status)}</h4><div class="wiring-summary-line">${network.sections.length} sections · ${junctionCount} junctions · ${network.sourceIndices.length ? "contains a source" : "source-less"}</div><div class="wiring-summary-line">Sources: ${labels(network.sourceIndices)}</div><div class="wiring-summary-line">${ui().mode === "power" ? `Consumers: ${labels(network.consumerIndices)}<br>${mw(network.generationMw)} generation / ${mw(network.demandMw)} demand · ${network.surplusMw >= 0 ? `${mw(network.surplusMw)} surplus` : `${mw(network.deficitMw)} deficit`} · ${Math.round(network.availableEfficiency * 100)}% available` : `Data supports: ${labels(network.sourceIndices)}<br>Compatible weapons: ${labels(network.weaponIndices)}`}</div><div class="wiring-summary-line">Passive hosts: ${labels(network.hostIndices.filter((index) => !network.componentIndices.includes(index)))}</div></div>` : ""}
    ${section ? `<div class="wiring-summary-section"><h4>Selected physical section</h4><div class="wiring-summary-line">(${section.x1},${section.y1}) ↔ (${section.x2},${section.y2}) · ${escapeHtml(section.tier)} tier · ${role}</div><div class="wiring-summary-line">Endpoint degrees: ${degrees[0]} / ${degrees[1]} · Hosts: ${labels([...new Set(rules().sectionCells(section).map((cell) => partIndexAt(cell.x, cell.y)).filter((index) => index >= 0))])}</div><div class="wiring-section-actions"><button type="button" data-wiring-action="branch-a">Branch from A</button><button type="button" data-wiring-action="branch-b">Branch from B</button><button type="button" data-wiring-action="remove-section">Remove section</button><button type="button" data-wiring-action="remove-branch">Remove branch</button><button type="button" data-wiring-action="cancel-selection">Cancel selection</button></div></div>` : ""}`;
}
