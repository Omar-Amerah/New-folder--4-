// Wiring v2 editor: canonical physical sections own topology and membership.
import { dom } from "./dom.js";
import { state } from "../state.js";
import { PART_DEFS, PART_STATS } from "../design/parts.js";
import { findPartAtCell } from "../design/placementCandidate.js";
import { getFootprintBounds } from "../design/footprint.js";
import { persistDesign, defaultWiring, normalizeWiring } from "../design/blueprintStorage.js";
import { escapeHtml } from "../shared/formatting.js";

const GRID_SIZE = 15;
const MAX_UNDO = 60;
const SVG_NS = "http://www.w3.org/2000/svg";
const DRAG_THRESHOLD_PX = 5;
let pointerDrag = null;
let suppressNextClick = false;
function rules() { return globalThis.WiringRules; }
function ui() { return state.wiringUi; }
function currentAnalysis() { return rules().analyzeWiring(state.design, state.wiring, PART_STATS); }
function partName(type) { return PART_DEFS[type]?.name || PART_STATS[type]?.name || type; }
function moduleLabel(index) { const module = state.design[index]; return module ? `${partName(module.type)} (${module.x},${module.y})` : "Unknown"; }
function bucket(kind = ui().mode) { return state.wiring?.[kind] || { sections: [], connections: [] }; }
function partIndexAt(x, y) { const part = findPartAtCell(state.design, PART_STATS, x, y); return part ? state.design.indexOf(part) : -1; }
function isValidSource(mode, type) { return mode === "data" ? rules().isDataSourceType(type) : rules().isPowerSourceType(type); }
function isValidDestination(mode, sourceType, destinationType) { return mode === "data" ? rules().isCompatibleWeapon(sourceType, destinationType, PART_STATS) : rules().isPowerConsumer(destinationType, PART_STATS); }

function pushUndo() { const stack = ui().undoStack; stack.push(rules().cloneWiring(state.wiring)); if (stack.length > MAX_UNDO) stack.shift(); }
function commitWiring(next) { state.wiring = next; persistDesign(state.design, state.wiring, state.combatStyle); refreshWiringPresentation(); }
function releasePointerCapture() { if (!pointerDrag) return; const { target, pointerId } = pointerDrag; if (target?.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId); pointerDrag = null; }
function resetInteraction(clearSelection = true) { releasePointerCapture(); const view = ui(); view.sourceIndex = null; view.path = []; view.hoverCell = null; view.livePointer = null; view.dragging = false; if (clearSelection) { view.selectedIndex = null; view.selectedConnectionKey = null; view.selectedSectionId = null; } }
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
function removeDrawingStep() { const view = ui(); if (view.sourceIndex == null) return false; if (view.path.length > 1) view.path.pop(); else cancelDrawing(); refreshWiringPresentation(); return true; }

export function handleWiringCellClick(x, y) {
  const view = ui(); const index = partIndexAt(x, y);
  if (view.sourceIndex == null) {
    if (index < 0) { resetInteraction(); refreshWiringPresentation(); return; }
    const type = state.design[index].type;
    if (isValidSource(view.mode, type)) { resetInteraction(); view.sourceIndex = index; view.selectedIndex = index; view.path = [{ x, y }]; refreshWiringPresentation(); return; }
    inspectComponent(index); return;
  }
  if (index < 0) { view.hoverCell = { x, y, valid: false }; refreshWiringPresentation(); return; }
  const last = view.path.at(-1);
  if (view.path.length > 1 && x === view.path.at(-2).x && y === view.path.at(-2).y) { removeDrawingStep(); return; }
  if (x === last.x && y === last.y) { if (view.path.length > 1) { pushUndo(); const next = rules().addPath(state.wiring, view.mode, view.path, state.design, PART_STATS); resetInteraction(); commitWiring(next); } return; }
  if (Math.abs(last.x - x) + Math.abs(last.y - y) !== 1 || view.path.some((cell) => cell.x === x && cell.y === y)) { view.hoverCell = { x, y, valid: false }; refreshWiringPresentation(); return; }
  view.path.push({ x, y }); view.hoverCell = null;
  refreshWiringPresentation();
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
  return { x: (clientX - rect.left - left) / (cellWidth + gapX), y: (clientY - rect.top - top) / (cellHeight + gapY) };
}
function cellFromPointer(clientX, clientY) { const point = pointerGridPoint(clientX, clientY); return point ? { x: Math.floor(point.x), y: Math.floor(point.y) } : null; }
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
  pushUndo(); const next = rules().addPath(state.wiring, view.mode, view.path, state.design, PART_STATS);
  resetInteraction(); commitWiring(next);
}
function bindPointerDrawing() {
  dom.grid?.addEventListener("pointerdown", (event) => {
    if (state.blueprintView !== "wiring" || event.button !== 0 || event.pointerType === "touch" || ui().sourceIndex != null) return;
    const cell = cellFromPointer(event.clientX, event.clientY); const index = cell ? partIndexAt(cell.x, cell.y) : -1;
    if (index < 0 || !isValidSource(ui().mode, state.design[index].type)) return;
    pointerDrag = { pointerId: event.pointerId, target: dom.grid, startX: event.clientX, startY: event.clientY, sourceIndex: index, startCell: cell, lastPoint: pointerGridPoint(event.clientX, event.clientY), active: false };
  });
  dom.grid?.addEventListener("pointermove", (event) => {
    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return; const point = pointerGridPoint(event.clientX, event.clientY); if (!point) return;
    if (!pointerDrag.active) {
      if (Math.hypot(event.clientX - pointerDrag.startX, event.clientY - pointerDrag.startY) < DRAG_THRESHOLD_PX) return;
      const pending = pointerDrag; pointerDrag = null; resetInteraction();
      pointerDrag = { ...pending, active: true }; suppressNextClick = true; dom.grid.setPointerCapture(event.pointerId);
      const index = partIndexAt(pointerDrag.startCell.x, pointerDrag.startCell.y); ui().sourceIndex = index; ui().selectedIndex = index; ui().path = [pointerDrag.startCell]; ui().dragging = true;
    }
    extendDraggedPath(interpolatedWiringCells(pointerDrag.lastPoint, point)); pointerDrag.lastPoint = point; ui().livePointer = point; renderWiringOverlay();
  });
  dom.grid?.addEventListener("pointerup", (event) => { if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return; const active = pointerDrag.active; const point = pointerGridPoint(event.clientX, event.clientY); if (active && point) extendDraggedPath(interpolatedWiringCells(pointerDrag.lastPoint, point)); const cell = cellFromPointer(event.clientX, event.clientY); if (active) finishDraggedConnection(cell); else releasePointerCapture(); });
  dom.grid?.addEventListener("pointercancel", () => { if (pointerDrag?.active) cancelDrawing(); else releasePointerCapture(); });
  window.addEventListener("blur", () => { if (pointerDrag?.active) cancelDrawing(); else releasePointerCapture(); });
}

function removeLogicalConnection(connection) { if (!connection) return; pushUndo(); resetInteraction(); commitWiring(rules().removeConnection(state.wiring, ui().mode, rules().connectionKey(connection), state.design, PART_STATS)); }
function selectedNetwork() {
  const analysis = currentAnalysis(); const view = ui();
  if (view.selectedSectionId) return rules().networkForSection(analysis, view.mode, view.selectedSectionId);
  const connection = selectedConnection();
  if (connection) return (view.mode === "data" ? analysis.data.networks : analysis.power.networks).find((network) => network.connections.some((item) => rules().connectionKey(item) === rules().connectionKey(connection))) || null;
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
    const id = event.target?.dataset?.sectionId; if (!id || ui().sourceIndex != null) return;
    event.stopPropagation(); const section = bucket().sections.find((item) => item.id === id); if (!section) return;
    const rect = dom.wiringOverlayHost.getBoundingClientRect(); const point = pointerGridPoint(event.clientX, event.clientY); const ends = rules().sectionCells(section); const origin = !point ? ends[0] : ends.slice().sort((a, b) => ((a.x + .5 - point.x) ** 2 + (a.y + .5 - point.y) ** 2) - ((b.x + .5 - point.x) ** 2 + (b.y + .5 - point.y) ** 2) || a.y - b.y || a.x - b.x)[0];
    resetInteraction(); ui().sourceIndex = partIndexAt(origin.x, origin.y); ui().selectedSectionId = id; ui().path = [origin]; refreshWiringPresentation();
  });
  dom.wiringOverlayHost?.addEventListener("contextmenu", (event) => {
    const id = event.target?.dataset?.sectionId; if (!id) return; event.preventDefault(); event.stopPropagation();
    if (ui().sourceIndex != null) { removeDrawingStep(); return; }
    const users = bucket().connections.filter((connection) => connection.sectionIds.includes(id));
    const inspected = selectedConnection(); removeLogicalConnection(inspected && users.includes(inspected) ? inspected : users[0] || null);
  });
  document.addEventListener("keydown", (event) => { if (state.blueprintView === "wiring" && event.key === "Escape" && ui().sourceIndex != null) { event.preventDefault(); cancelDrawing(); } });
  dom.grid?.addEventListener("contextmenu", (event) => {
    if (state.blueprintView !== "wiring") return; event.preventDefault();
    if (ui().sourceIndex != null) { removeDrawingStep(); return; }
    const cell = event.target.closest(".build-cell"); if (!cell) return;
    const index = partIndexAt(Number(cell.dataset.x), Number(cell.dataset.y));
    if (index < 0) return; const terminalConnections = connectionsAtTerminal(index);
    if (!terminalConnections.length) return; removeLogicalConnection(selectedConnection() && terminalConnections.includes(selectedConnection()) ? selectedConnection() : terminalConnections[0]);
  });
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
function line(section, className) { return svgEl("line", { x1: section.x1 + 0.5, y1: section.y1 + 0.5, x2: section.x2 + 0.5, y2: section.y2 + 0.5 }, className); }
function moduleRect(index, className) { const module = state.design[index]; if (!module) return null; const stat = PART_STATS[module.type] || PART_STATS.frame; const bounds = getFootprintBounds(module.x, module.y, stat.footprint || { width: 1, height: 1 }, module.rotation || 0); return svgEl("rect", { x: bounds.minX + 0.07, y: bounds.minY + 0.07, width: bounds.width - 0.14, height: bounds.height - 0.14, rx: 0.12, ry: 0.12 }, className); }
function terminal(index, kind, selected) { const center = rules().componentCenter(state.design[index], PART_STATS); return svgEl("circle", { cx: center.x, cy: center.y, r: 0.14 }, `wire-terminal wire-terminal-${kind}${selected ? " selected" : ""}`); }

function renderWiringOverlay() {
  const host = dom.wiringOverlayHost; if (!host || state.blueprintView !== "wiring") return; const view = ui(); host.replaceChildren(); dom.grid?.classList.add("wiring-overlay-active");
  const svg = svgEl("svg", { viewBox: `0 0 ${GRID_SIZE} ${GRID_SIZE}` }, "wiring-overlay"); const selected = selectedConnection(); const selectedNet = selectedNetwork(); const analysis = currentAnalysis();
  for (const section of bucket().sections) {
    const users = bucket().connections.filter((connection) => connection.sectionIds.includes(section.id)); const isSelected = selectedNet?.sectionIds.includes(section.id);
    const powerState = view.mode === "power" ? analysis.power.networks.find((network) => network.sectionIds.includes(section.id))?.status : null;
    svg.appendChild(line(section, `wire-${view.mode}${powerState === "online" ? " wire-net-working" : powerState === "underpowered" ? " wire-net-underpowered" : powerState === "unpowered" ? " wire-net-broken" : ""}${isSelected ? " wire-net-selected" : ""}`));
    const hit = line(section, "wire-hit"); hit.dataset.sectionId = section.id; svg.appendChild(hit);
    if (users.length > 1) svg.appendChild(svgEl("circle", { cx: (section.x1 + section.x2 + 1) / 2, cy: (section.y1 + section.y2 + 1) / 2, r: 0.07 }, "wire-branch"));
  }
  const endpoints = new Set(); bucket().connections.forEach((connection) => { endpoints.add(connection.sourceIndex); endpoints.add(connection.targetIndex); });
  endpoints.forEach((index) => svg.appendChild(terminal(index, view.mode, selected && (selected.sourceIndex === index || selected.targetIndex === index))));
  if (view.mode === "power") state.design.forEach((module, index) => {
    if (!rules().isPowerConsumer(module.type, PART_STATS)) return;
    const className = analysis.power.disconnectedConsumerIndices.includes(index) ? "wire-comp-disconnected" : analysis.power.underpoweredConsumerIndices.includes(index) ? "wire-comp-underpowered" : "wire-comp-connected-dest";
    const rect = moduleRect(index, className); if (rect) svg.appendChild(rect);
  });
  state.design.forEach((module) => { const center = rules().componentCenter(module, PART_STATS); const power = rules().isPowerSourceType(module.type) || rules().isPowerConsumer(module.type, PART_STATS); const data = rules().isDataSourceType(module.type) || rules().isDataTarget(module.type, PART_STATS); const offset = power && data ? 0.08 : 0; if (power) svg.appendChild(svgEl("circle", { cx: center.x - offset, cy: center.y, r: 0.07 }, `wire-port wire-port-power${rules().isPowerSourceType(module.type) ? " source" : ""}`)); if (data) svg.appendChild(svgEl("circle", { cx: center.x + offset, cy: center.y, r: 0.07 }, `wire-port wire-port-data${rules().isDataSourceType(module.type) ? " source" : ""}`)); });
  if (view.selectedIndex != null) { const rect = moduleRect(view.selectedIndex, "wire-comp-selected"); if (rect) svg.appendChild(rect); }
  if (view.sourceIndex != null) {
    const sourceType = state.design[view.sourceIndex]?.type; state.design.forEach((module, index) => { if (sourceType && index !== view.sourceIndex && isValidDestination(view.mode, sourceType, module.type)) { const rect = moduleRect(index, "wire-comp-candidate"); if (rect) svg.appendChild(rect); } });
    for (let i = 1; i < view.path.length; i += 1) svg.appendChild(line({ x1: view.path[i - 1].x, y1: view.path[i - 1].y, x2: view.path[i].x, y2: view.path[i].y }, `wire-preview confirmed wire-preview-${view.mode}`));
    if (view.dragging && view.livePointer) { const last = view.path.at(-1); svg.appendChild(svgEl("line", { x1: last.x + .5, y1: last.y + .5, x2: view.livePointer.x, y2: view.livePointer.y }, `wire-preview ${view.hoverCell && !view.hoverCell.valid ? "invalid" : "valid"} wire-preview-${view.mode}`)); }
    const last = view.path.at(-1); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const x = last.x + dx; const y = last.y + dy; if (partIndexAt(x, y) >= 0 && !view.path.some((cell) => cell.x === x && cell.y === y)) svg.appendChild(svgEl("circle", { cx: x + 0.5, cy: y + 0.5, r: 0.12 }, "wire-next-cell")); }
    if (view.hoverCell && !view.hoverCell.valid) svg.appendChild(svgEl("circle", { cx: view.hoverCell.x + 0.5, cy: view.hoverCell.y + 0.5, r: 0.15 }, "wire-invalid-cell"));
  }
  host.appendChild(svg);
}

function renderStatusPanel() {
  const panel = dom.wiringStatusPanel; if (!panel || state.blueprintView !== "wiring") return; const analysis = currentAnalysis(); const network = selectedNetwork(); const connection = selectedConnection(); const section = bucket().sections.find((item) => item.id === ui().selectedSectionId); const users = section ? bucket().connections.filter((item) => item.sectionIds.includes(section.id)) : [];
  const power = analysis.power; const mw = (value) => `${Number(value).toFixed(1)} MW`; const powerNetworks = power.networks.map((item) => `<div class="wiring-summary-section"><h4>${escapeHtml(item.label)} — ${escapeHtml(item.status[0].toUpperCase() + item.status.slice(1))}</h4><div class="wiring-summary-line">${mw(item.generationMw)} generation / ${mw(item.demandMw)} demand</div><div class="wiring-summary-line">${item.surplusMw >= 0 ? `${mw(item.surplusMw)} spare` : `${mw(-item.surplusMw)} deficit`} · ${Math.round(item.availableEfficiency * 100)}% available</div><div class="wiring-summary-line">Sources: ${item.sourceIndices.map(moduleLabel).map(escapeHtml).join(", ") || "None"}</div><div class="wiring-summary-line">Consumers: ${item.consumerIndices.map(moduleLabel).map(escapeHtml).join(", ") || "None"}</div></div>`).join("");
  panel.hidden = false; panel.innerHTML = `<h3>Wiring</h3>
    ${ui().mode === "power" ? `<div class="wiring-summary-section"><h4>Ship Power networks</h4><div class="wiring-selection-grid"><div><span>Networks</span><strong>${power.networkCount}</strong></div><div><span>Connected generation</span><strong>${mw(power.totalConnectedGenerationMw)}</strong></div><div><span>Connected demand</span><strong>${mw(power.totalConnectedDemandMw)}</strong></div><div><span>Balance</span><strong>${power.totalSurplusMw >= 0 ? `${mw(power.totalSurplusMw)} spare` : `${mw(-power.totalSurplusMw)} deficit`}</strong></div><div><span>Disconnected consumers</span><strong>${power.disconnectedConsumerIndices.length}</strong></div><div><span>Unused sources</span><strong>${power.unusedSourceIndices.length}</strong></div><div><span>Invalid connections</span><strong>${power.invalidConnectionCount}</strong></div></div><div class="wiring-summary-line">Calculated available power. Gameplay effects not active yet.</div></div>${powerNetworks}` : ""}
    <div class="wiring-summary-line">${rules().countUniqueSections(state.wiring, ui().mode)} unique ${escapeHtml(ui().mode)} cable sections${ui().path.length > 1 ? ` · +${rules().additionalLengthForPath(state.wiring, ui().mode, ui().path)} preview` : ""}</div>
    ${section ? `<div class="wiring-summary-section"><h4>Physical section</h4><div class="wiring-selection-grid"><div><span>Tier</span><strong>${escapeHtml(section.tier)}</strong></div><div><span>Shared connections</span><strong>${users.length}</strong></div><div><span>Used by</span><strong>${users.length ? users.map((item) => `${escapeHtml(moduleLabel(item.sourceIndex))} → ${escapeHtml(moduleLabel(item.targetIndex))}`).join("; ") : "None"}</strong></div></div></div>` : ""}
    ${network ? `<div class="wiring-summary-section"><h4>${escapeHtml(network.label)}</h4><div class="wiring-summary-line">${network.connections.length} logical connection${network.connections.length === 1 ? "" : "s"} · ${network.sections.length} physical section${network.sections.length === 1 ? "" : "s"}</div></div>` : ""}`;
}
