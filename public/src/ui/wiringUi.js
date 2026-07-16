// Wiring editor view: draws Power/Data wire overlays on the blueprint grid,
// handles source→destination auto-routing, erase/clear/undo tools, and the
// designer status summaries. All connectivity results come from the shared
// WiringRules engine (globalThis.WiringRules) — nothing here stores network
// ids or bonuses in the blueprint.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { PART_DEFS, PART_STATS } from "../design/parts.js";
import { findPartAtCell } from "../design/placementCandidate.js";
import { getFootprintBounds } from "../design/footprint.js";
import { persistDesign, defaultWiring, normalizeWiring } from "../design/blueprintStorage.js";
import { escapeHtml } from "../shared/formatting.js";
import { showToast } from "./toastUi.js";

const GRID_SIZE = 15;
const MAX_UNDO = 60;
const SVG_NS = "http://www.w3.org/2000/svg";

function rules() { return globalThis.WiringRules; }

function ui() { return state.wiringUi; }

function currentAnalysis() {
  return rules().analyzeWiring(state.design, state.wiring, PART_STATS);
}

function partName(type) {
  return PART_DEFS[type]?.name || PART_STATS[type]?.name || type;
}

function moduleLabel(index) {
  const module = state.design[index];
  return module ? `${partName(module.type)} (${module.x},${module.y})` : "Unknown";
}

function trimNumber(value, decimals = 1) {
  const rounded = Number(value.toFixed(decimals));
  return String(rounded);
}

function formatBonus(value, unit) {
  if (unit === "percent") return `+${trimNumber(value * 100)}%`;
  return `+${trimNumber(value)} ${unit}`;
}

// ---- Wiring mutations -----------------------------------------------------

function pushUndo() {
  const stack = ui().undoStack;
  stack.push(rules().cloneWiring(state.wiring));
  if (stack.length > MAX_UNDO) stack.shift();
}

function commitWiring(next) {
  state.wiring = next;
  persistDesign(state.design, state.wiring, state.combatStyle);
  refreshWiringPresentation();
}

// Re-normalizes the current wiring against the current design; call after any
// component placement, rotation or removal so segments never float.
export function syncWiringWithDesign() {
  state.wiring = normalizeWiring(state.wiring, state.design);
  clearWiringInteraction();
}

export function resetWiringToDefault() {
  state.wiring = normalizeWiring(defaultWiring(), state.design);
  ui().undoStack = [];
  clearWiringInteraction();
}

export function clearAllWiring() {
  state.wiring = { version: 1, power: [], data: [] };
  ui().undoStack = [];
  clearWiringInteraction();
}

function clearWiringInteraction() {
  const view = ui();
  view.selectedIndex = null;
  view.sourceIndex = null;
  view.hoverIndex = null;
  view.previewRoute = null;
}

// Full reset for when state.design is replaced wholesale (loading a saved
// design, adopting the server default): selection indices point into the old
// module array and the undo stack holds the old ship's wiring.
export function resetWiringEditorState() {
  clearWiringInteraction();
  ui().undoStack = [];
}

function undoWiring() {
  const stack = ui().undoStack;
  if (!stack.length) { setWiringHint("Nothing to undo."); return; }
  const previous = stack.pop();
  commitWiring(normalizeWiring(previous, state.design));
  setWiringHint("Wiring change undone.");
}

// ---- Interaction ----------------------------------------------------------

function isValidSource(mode, type) {
  return mode === "data" ? rules().isDataSourceType(type) : rules().isPowerSourceType(type);
}

function isValidDestination(mode, sourceType, destType) {
  if (mode === "data") return rules().isCompatibleWeapon(sourceType, destType, PART_STATS);
  return rules().isPowerConsumer(destType, PART_STATS);
}

function partIndexAt(x, y) {
  const part = findPartAtCell(state.design, PART_STATS, x, y);
  return part ? state.design.indexOf(part) : -1;
}

export function handleWiringCellClick(x, y) {
  const view = ui();
  if (view.tool === "erase") return; // segments are erased on the overlay itself
  const index = partIndexAt(x, y);
  if (index < 0) {
    clearWiringInteraction();
    refreshWiringPresentation();
    return;
  }
  const type = state.design[index].type;

  if (view.sourceIndex != null && index !== view.sourceIndex) {
    const sourceType = state.design[view.sourceIndex]?.type;
    if (sourceType && isValidDestination(view.mode, sourceType, type)) {
      confirmRoute(view.sourceIndex, index);
      return;
    }
  }

  if (isValidSource(view.mode, type)) {
    if (view.sourceIndex === index) {
      view.sourceIndex = null;
      setWiringHint("Route cancelled.");
    } else {
      view.sourceIndex = index;
      setWiringHint(view.mode === "data"
        ? "Hover a compatible weapon, then click it to confirm the route."
        : "Hover a powered component, then click it to confirm the route.");
    }
    view.selectedIndex = index;
    view.previewRoute = null;
    refreshWiringPresentation();
    return;
  }

  // Plain selection for inspection (network + connection summary).
  view.sourceIndex = null;
  view.previewRoute = null;
  view.selectedIndex = view.selectedIndex === index ? null : index;
  refreshWiringPresentation();
}

export function handleWiringCellHover(x, y) {
  const view = ui();
  const index = partIndexAt(x, y);
  if (view.hoverIndex === index) return;
  view.hoverIndex = index;
  if (view.sourceIndex == null || view.tool === "erase") {
    if (view.previewRoute) { view.previewRoute = null; renderWiringOverlay(); }
    return;
  }
  const sourceType = state.design[view.sourceIndex]?.type;
  if (index < 0 || index === view.sourceIndex || !sourceType || !isValidDestination(view.mode, sourceType, state.design[index].type)) {
    if (view.previewRoute) { view.previewRoute = null; setWiringHint(defaultHint()); renderWiringOverlay(); }
    return;
  }
  const route = rules().findRoute(state.design, view.sourceIndex, index, PART_STATS);
  view.previewRoute = { targetIndex: index, ok: route.ok, segments: route.segments };
  setWiringHint(route.ok ? `Click to connect ${moduleLabel(view.sourceIndex)} to ${moduleLabel(index)}.` : "No valid route to that component.");
  renderWiringOverlay();
}

export function handleWiringGridLeave() {
  const view = ui();
  view.hoverIndex = null;
  if (view.previewRoute) { view.previewRoute = null; setWiringHint(defaultHint()); renderWiringOverlay(); }
}

function confirmRoute(fromIndex, toIndex) {
  const view = ui();
  // Hover preview and final placement use the exact same calculated route.
  const route = view.previewRoute && view.previewRoute.targetIndex === toIndex
    ? view.previewRoute
    : rules().findRoute(state.design, fromIndex, toIndex, PART_STATS);
  if (!route.ok) {
    setWiringHint("That route cannot be completed.");
    showToast("No valid wiring route to that component.", "warning");
    return;
  }
  pushUndo();
  const next = rules().addRoute(state.wiring, view.mode, route.segments, state.design, PART_STATS);
  view.previewRoute = null;
  view.sourceIndex = null; // route complete — the next source click starts fresh
  view.selectedIndex = toIndex;
  commitWiring(next);
  setWiringHint(route.segments.length
    ? `Connected ${moduleLabel(fromIndex)} to ${moduleLabel(toIndex)}.`
    : `${moduleLabel(fromIndex)} and ${moduleLabel(toIndex)} already share a connection point.`);
}

function eraseSegment(kind, key) {
  const segments = (state.wiring?.[kind] || []).filter((segment) => rules().segmentKey(segment) === key);
  if (!segments.length) return;
  pushUndo();
  commitWiring(rules().removeSegments(state.wiring, kind, segments, state.design, PART_STATS));
  setWiringHint("Wire segment removed.");
}

function clearSelectedNetwork() {
  const view = ui();
  if (view.selectedIndex == null) { setWiringHint("Select a component first."); return; }
  const analysis = currentAnalysis();
  const network = rules().networkForComponent(analysis, view.mode, view.selectedIndex);
  if (!network) { setWiringHint("The selected component has no network in this mode."); return; }
  pushUndo();
  commitWiring(rules().removeSegments(state.wiring, view.mode, network.segments, state.design, PART_STATS));
  setWiringHint(`${network.label} cleared.`);
}

function clearKind(kind) {
  if (!(state.wiring?.[kind] || []).length) { setWiringHint(`No ${kind === "data" ? "Data" : "Power"} wiring to clear.`); return; }
  pushUndo();
  const next = rules().cloneWiring(state.wiring);
  next[kind] = [];
  commitWiring(normalizeWiring(next, state.design));
  setWiringHint(`All ${kind === "data" ? "Data" : "Power"} wiring cleared.`);
}

function setMode(mode) {
  const view = ui();
  if (view.mode === mode) return;
  view.mode = mode;
  clearWiringInteraction();
  refreshWiringPresentation();
}

function setTool(tool) {
  const view = ui();
  view.tool = tool;
  view.sourceIndex = null;
  view.previewRoute = null;
  refreshWiringPresentation();
}

function setWiringHint(text) {
  if (dom.wiringHint) dom.wiringHint.textContent = text;
}

function defaultHint() {
  const view = ui();
  if (view.tool === "erase") return "Erase: click a wire segment to remove it.";
  if (view.sourceIndex != null) {
    return view.mode === "data"
      ? "Hover a compatible weapon, then click it to confirm the route."
      : "Hover a powered component, then click it to confirm the route.";
  }
  return view.mode === "data"
    ? "Editing Data wiring — click a support module (Fire Control, Sensor Array, Targeting Computer, Signal Amplifier, Stabilizer Node) to start a route."
    : "Editing Power wiring — click a Power source (Core, Reactor, Aux Generator) to start a route.";
}

// ---- Controls -------------------------------------------------------------

let controlsBound = false;
export function bindWiringControls() {
  if (controlsBound) return;
  controlsBound = true;
  dom.wiringModePower?.addEventListener("click", () => setMode("power"));
  dom.wiringModeData?.addEventListener("click", () => setMode("data"));
  dom.wiringToolRoute?.addEventListener("click", () => setTool("route"));
  dom.wiringToolErase?.addEventListener("click", () => setTool("erase"));
  dom.wiringUndoButton?.addEventListener("click", undoWiring);
  dom.wiringClearNetworkButton?.addEventListener("click", clearSelectedNetwork);
  dom.wiringClearPowerButton?.addEventListener("click", () => clearKind("power"));
  dom.wiringClearDataButton?.addEventListener("click", () => clearKind("data"));
  dom.wiringShowAllButton?.addEventListener("click", () => {
    ui().showAllNetworks = !ui().showAllNetworks;
    refreshWiringPresentation();
  });
  dom.wiringOverlayHost?.addEventListener("click", (event) => {
    const target = event.target;
    const key = target?.dataset?.segKey;
    if (!key || ui().tool !== "erase") return;
    event.stopPropagation();
    eraseSegment(target.dataset.segKind || ui().mode, key);
  });
}

// ---- Presentation ---------------------------------------------------------

export function refreshWiringPresentation() {
  if (state.blueprintView !== "wiring") return;
  bindWiringControls();
  refreshWiringToolbar();
  renderWiringOverlay();
  renderWiringStatusPanel();
}

export function clearWiringPresentation() {
  dom.wiringOverlayHost?.replaceChildren();
  dom.wiringOverlayHost?.classList.remove("wiring-erase-active");
  if (dom.wiringStatusPanel) { dom.wiringStatusPanel.hidden = true; dom.wiringStatusPanel.innerHTML = ""; }
  dom.grid?.classList.remove("wiring-overlay-active");
  const view = ui();
  view.hoverIndex = null;
  view.previewRoute = null;
}

function refreshWiringToolbar() {
  const view = ui();
  const setPressed = (button, active) => {
    button?.classList.toggle("active", active);
    button?.setAttribute("aria-pressed", String(active));
  };
  setPressed(dom.wiringModePower, view.mode === "power");
  setPressed(dom.wiringModeData, view.mode === "data");
  setPressed(dom.wiringToolRoute, view.tool === "route");
  setPressed(dom.wiringToolErase, view.tool === "erase");
  setPressed(dom.wiringShowAllButton, view.showAllNetworks);
  if (dom.wiringUndoButton) dom.wiringUndoButton.disabled = !view.undoStack.length;
  setWiringHint(defaultHint());
}

function visibleKinds() {
  const view = ui();
  return view.showAllNetworks ? ["power", "data"] : [view.mode];
}

function svgEl(tag, attributes = {}, className = "") {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (className) element.setAttribute("class", className);
  return element;
}

function segmentLine(segment, className, extra = {}) {
  return svgEl("line", { x1: segment.x1, y1: segment.y1, x2: segment.x2, y2: segment.y2, ...extra }, className);
}

function moduleRect(index, className) {
  const module = state.design[index];
  if (!module) return null;
  const stat = PART_STATS[module.type] || PART_STATS.frame;
  const bounds = getFootprintBounds(module.x, module.y, stat.footprint || { width: 1, height: 1 }, module.rotation || 0);
  return svgEl("rect", {
    x: bounds.minX + 0.07,
    y: bounds.minY + 0.07,
    width: bounds.width - 0.14,
    height: bounds.height - 0.14,
    rx: 0.12,
    ry: 0.12
  }, className);
}

function networkIsWorking(network, analysis) {
  if (!network) return false;
  // A powered network is "working" even before consumers are attached — red is
  // reserved for networks that cannot reach a source.
  if (network.kind === "power") return network.powered;
  const hasCompatiblePair = analysis.data.supports.some((support) => support.networkId === network.id && support.connectedWeaponIndices.length > 0);
  return hasCompatiblePair;
}

function renderWiringOverlay() {
  const host = dom.wiringOverlayHost;
  if (!host || state.blueprintView !== "wiring") return;
  const view = ui();
  const analysis = currentAnalysis();
  host.replaceChildren();
  host.classList.toggle("wiring-erase-active", view.tool === "erase");
  dom.grid?.classList.add("wiring-overlay-active");

  const svg = svgEl("svg", { viewBox: `0 0 ${GRID_SIZE} ${GRID_SIZE}` }, "wiring-overlay");

  const selected = Number.isInteger(view.selectedIndex) && state.design[view.selectedIndex] ? view.selectedIndex : null;
  const selectedNetworks = new Set();
  if (selected != null) {
    for (const kind of ["power", "data"]) {
      const network = rules().networkForComponent(analysis, kind, selected);
      if (network) selectedNetworks.add(network);
    }
  }
  const dimUnrelated = selected != null && selectedNetworks.size > 0;

  // Wire segments per visible kind, grouped by derived network.
  for (const kind of visibleKinds()) {
    const networks = kind === "power" ? analysis.power.networks : analysis.data.networks;
    for (const network of networks) {
      const isSelectedNetwork = [...selectedNetworks].some((candidate) => candidate.kind === kind && candidate.id === network.id);
      const working = networkIsWorking(network, analysis);
      for (const segment of network.segments) {
        const classes = [`wire-${kind}`];
        if (isSelectedNetwork) {
          classes.push("wire-net-selected", working ? "wire-net-working" : "wire-net-broken");
        } else if (dimUnrelated) {
          classes.push("wire-dim");
        }
        svg.appendChild(segmentLine(segment, classes.join(" ")));
        // Wider invisible hit target so Erase clicks land easily.
        const hit = segmentLine(segment, "wire-hit");
        hit.dataset.segKind = kind;
        hit.dataset.segKey = rules().segmentKey(segment);
        svg.appendChild(hit);
      }
    }
  }

  // Disconnected powered components are always flagged in red.
  for (const index of analysis.power.disconnectedConsumerIndices) {
    const rect = moduleRect(index, "wire-comp-disconnected");
    if (rect) svg.appendChild(rect);
  }

  // Selection highlights: component, ports, its network's endpoints.
  if (selected != null) {
    const selectedRect = moduleRect(selected, "wire-comp-selected");
    if (selectedRect) svg.appendChild(selectedRect);
    for (const port of rules().componentPorts(state.design[selected], PART_STATS)) {
      svg.appendChild(svgEl("circle", { cx: port.x, cy: port.y, r: 0.09 }, "wire-port"));
    }
    for (const network of selectedNetworks) {
      const related = new Set(network.componentIndices);
      related.delete(selected);
      for (const index of related) {
        const module = state.design[index];
        if (!module) continue;
        const isSource = network.kind === "power" ? rules().isPowerSourceType(module.type) : rules().isDataSourceType(module.type);
        const isTarget = network.kind === "power" ? rules().isPowerConsumer(module.type, PART_STATS) : rules().isDataTarget(module.type, PART_STATS);
        if (!isSource && !isTarget) continue;
        const rect = moduleRect(index, isSource ? "wire-comp-connected-source" : "wire-comp-connected-dest");
        if (rect) svg.appendChild(rect);
      }
    }
  }

  // Routing affordances: mark the active source and every valid destination.
  if (view.sourceIndex != null && state.design[view.sourceIndex]) {
    const sourceRect = moduleRect(view.sourceIndex, "wire-comp-route-source");
    if (sourceRect) svg.appendChild(sourceRect);
    const sourceType = state.design[view.sourceIndex].type;
    state.design.forEach((module, index) => {
      if (index === view.sourceIndex) return;
      if (isValidDestination(view.mode, sourceType, module.type)) {
        const rect = moduleRect(index, "wire-comp-candidate");
        if (rect) svg.appendChild(rect);
      }
    });
  }

  // Proposed route preview (exact segments that a confirming click will add).
  if (view.previewRoute) {
    for (const segment of view.previewRoute.segments) {
      svg.appendChild(segmentLine(segment, `wire-preview ${view.previewRoute.ok ? "valid" : "invalid"} wire-preview-${view.mode}`));
    }
  }

  host.appendChild(svg);
}

// ---- Status panel ----------------------------------------------------------

function selectionSummaryMarkup(analysis) {
  const view = ui();
  const selected = Number.isInteger(view.selectedIndex) && state.design[view.selectedIndex] ? view.selectedIndex : null;
  if (selected == null) {
    return `<div class="wiring-selection-empty">No component selected — editing <strong>${view.mode === "data" ? "Data" : "Power"}</strong> wiring. Select a component to inspect its network.</div>`;
  }
  const module = state.design[selected];
  const rows = [];
  const powerNetwork = rules().networkForComponent(analysis, "power", selected);
  const dataNetwork = rules().networkForComponent(analysis, "data", selected);

  if (rules().isPowerSourceType(module.type) || rules().isPowerConsumer(module.type, PART_STATS)) {
    if (powerNetwork) {
      rows.push(`<div><span>Power network</span><strong>${escapeHtml(powerNetwork.label)}</strong></div>`);
      rows.push(`<div><span>Network power</span><strong>+${trimNumber(powerNetwork.generation)} / -${trimNumber(powerNetwork.demand)} MW</strong></div>`);
      if (rules().isPowerConsumer(module.type, PART_STATS)) {
        rows.push(`<div><span>Power source</span><strong class="${powerNetwork.powered ? "wiring-good" : "wiring-bad"}">${powerNetwork.powered ? "Connected" : "Not reached"}</strong></div>`);
      }
    } else {
      rows.push(`<div><span>Power network</span><strong class="${rules().isPowerConsumer(module.type, PART_STATS) ? "wiring-bad" : ""}">Not wired</strong></div>`);
    }
  }

  const support = analysis.data.supports.find((entry) => entry.index === selected);
  if (support) {
    rows.push(`<div><span>Data network</span><strong>${escapeHtml(support.networkLabel || "Not wired")}</strong></div>`);
    const weaponList = support.connectedWeaponIndices.map((index) => escapeHtml(moduleLabel(index))).join(", ");
    rows.push(`<div><span>Connected weapons</span><strong class="${support.connectedWeaponIndices.length ? "wiring-good" : "wiring-warn"}">${support.connectedWeaponIndices.length ? weaponList : "None"}</strong></div>`);
    if (support.connectedWeaponIndices.length) {
      rows.push(`<div><span>Future ${escapeHtml(support.effect)} bonus</span><strong>${escapeHtml(formatBonus(support.bonusPerWeapon, support.unit))} per weapon (preview)</strong></div>`);
    }
    if (support.incompatibleWeaponIndices.length) {
      rows.push(`<div><span>Incompatible</span><strong class="wiring-warn">${support.incompatibleWeaponIndices.map((index) => escapeHtml(moduleLabel(index))).join(", ")}</strong></div>`);
    }
  }

  const weapon = analysis.data.weapons.find((entry) => entry.index === selected);
  if (weapon) {
    rows.push(`<div><span>Data network</span><strong>${escapeHtml(weapon.networkLabel || "Not wired")}</strong></div>`);
    const supportList = weapon.supportIndices.map((index) => escapeHtml(moduleLabel(index))).join(", ");
    rows.push(`<div><span>Connected support</span><strong>${supportList || "None"}</strong></div>`);
  }

  if (!rows.length && dataNetwork) rows.push(`<div><span>Data network</span><strong>${escapeHtml(dataNetwork.label)}</strong></div>`);
  if (!rows.length) rows.push(`<div><span>Wiring</span><strong>Not part of Power or Data networks</strong></div>`);

  return `<div class="wiring-selection">
    <h4>${escapeHtml(moduleLabel(selected))}</h4>
    <div class="wiring-selection-grid">${rows.join("")}</div>
  </div>`;
}

function renderWiringStatusPanel() {
  const panel = dom.wiringStatusPanel;
  if (!panel) return;
  if (state.blueprintView !== "wiring") { panel.hidden = true; return; }
  const analysis = currentAnalysis();
  const summaries = rules().networkSummaries(analysis);

  const powerRows = summaries.power.map((network) => `
    <div class="wiring-network-row ${network.powered ? "" : "wiring-network-broken"}">
      <span class="wiring-swatch wiring-swatch-power" aria-hidden="true"></span>
      <span>${escapeHtml(network.label)}</span>
      <strong>+${trimNumber(network.generation)} MW / -${trimNumber(network.demand)} MW</strong>
      <em>${network.sourceCount} src · ${network.consumerCount} load</em>
    </div>`).join("");

  const supportRows = analysis.data.supports.map((support) => `
    <div class="wiring-network-row ${support.connectedWeaponIndices.length ? "" : "wiring-network-broken"}">
      <span class="wiring-swatch wiring-swatch-data" aria-hidden="true"></span>
      <span>${escapeHtml(moduleLabel(support.index))}</span>
      <strong>${support.connectedWeaponIndices.length} weapon${support.connectedWeaponIndices.length === 1 ? "" : "s"}</strong>
      <em>${support.connectedWeaponIndices.length ? `${escapeHtml(formatBonus(support.bonusPerWeapon, support.unit))} each (preview)` : "no bonus"}</em>
    </div>`).join("");

  const warningRows = analysis.warnings.map((warning) => `<li>${escapeHtml(warning.message)}</li>`).join("");

  panel.hidden = false;
  panel.innerHTML = `
    <h3>Wiring</h3>
    ${selectionSummaryMarkup(analysis)}
    <div class="wiring-summary-section">
      <h4>Power</h4>
      <div class="wiring-summary-line">${summaries.power.length} network${summaries.power.length === 1 ? "" : "s"} ·
        <span class="wiring-good">${analysis.power.connectedConsumerIndices.length} connected</span> ·
        <span class="${analysis.power.disconnectedConsumerIndices.length ? "wiring-bad" : ""}">${analysis.power.disconnectedConsumerIndices.length} disconnected</span></div>
      ${powerRows || `<div class="wiring-empty-note">No Power wiring yet.</div>`}
    </div>
    <div class="wiring-summary-section">
      <h4>Data</h4>
      <div class="wiring-summary-line">${summaries.data.length} Weapon Network${summaries.data.length === 1 ? "" : "s"}</div>
      ${supportRows || `<div class="wiring-empty-note">No Data-support modules wired. Future bonuses split equally: module bonus / connected compatible weapons.</div>`}
    </div>
    ${warningRows ? `<div class="wiring-summary-section wiring-warnings"><h4>Warnings</h4><ul>${warningRows}</ul></div>` : ""}
  `;
}
