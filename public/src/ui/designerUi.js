// Manages the builder grid, tile placement, connectivity rules, stats previews, and validation indicators.

import { dom } from "./dom.js";
import {
  state,
  DEFAULT_THERMAL_LOAD_MODE
} from "../state.js";
import { PART_DEFS, PART_STATS, isRotatablePart, partIconMarkup } from "../design/parts.js";
import { createPlacementCandidate, findPartAtCell } from "../design/placementCandidate.js";
import { normalizeRotation, nextRotation } from "../design/rotation.js";
import { isConnected, explainConnectionProblem, isOutOfBounds, isOverlapping, validateBlueprint } from "../design/blueprintValidation.js";
import { getOccupiedCells, getFootprintBounds } from "../design/footprint.js";
import { computeStats } from "../design/componentStats.js";
import { defaultDesign, persistDesign, makeDesignPart } from "../design/blueprintStorage.js";
import { showToast } from "./toastUi.js";
import { renderSavedDesigns, saveCurrentDesign, weaponAbbrevText } from "./savedBlueprintsUi.js";
import { updateEconomyUi } from "./purchaseUi.js";
import { formatHull, formatShield, formatThrust, formatRepair, formatMass, formatSpeed, formatPercent, round2 } from "../design/statFormatting.js";
import { escapeHtml } from "../shared/formatting.js";
import { renderPartInspector } from "./partInspectorUi.js";
import { formatPowerState } from "./section13bUi.js";
import { analyzeDesignHeat, describeThermalComponent } from "../design/thermalAnalysis.js";
import { calculateCenterOfMass } from "../shared/movementStats.js";

export { analyzeDesignHeat };

const GRID_SIZE = 15;
const THERMAL_SCENARIO_NAMES = { idle: "Idle", combat: "Typical Combat", full: "Maximum Sustained Load" };
const HEAT_FLOW_THRESHOLD = 0.05;
const HEAT_FLOW_LABEL_THRESHOLD = 0.35;
let cachedHeatAnalysis = null;

function heatDesignSignature(design, mode) {
  return `${mode}|${JSON.stringify(
    design.map(part => [part.type, part.x, part.y, part.rotation || 0])
  )}`;
}

function cachedPartReferencesMatch(design) {
  const references = cachedHeatAnalysis?.partReferences;

  return Boolean(
    references &&
    references.length === design.length &&
    references.every((part, index) => part === design[index])
  );
}

export function getScenarioHeatAnalysis(mode = state.thermalLoadMode || DEFAULT_THERMAL_LOAD_MODE) {
  const design = state.design;
  const signature = heatDesignSignature(design, mode);

  if (
    cachedHeatAnalysis?.signature === signature &&
    cachedPartReferencesMatch(design)
  ) {
    return cachedHeatAnalysis.result;
  }

  const result = analyzeDesignHeat(design, mode);
  cachedHeatAnalysis = {
    signature,
    partReferences: [...design],
    result
  };
  return result;
}

export function invalidateHeatAnalysisCache() { cachedHeatAnalysis = null; }

function heatAnalysisMatchesCurrentDesign(analysis) {
  if (!analysis) return false;

  return state.design.every(part =>
    analysis.predictions?.has(part) &&
    analysis.componentHeat?.has(part) &&
    analysis.componentClasses?.has(part)
  );
}

function freshCurrentHeatAnalysis() {
  let analysis = currentHeatAnalysis();

  if (!heatAnalysisMatchesCurrentDesign(analysis)) {
    invalidateHeatAnalysisCache();
    analysis = currentHeatAnalysis();
  }

  return analysis;
}

export function renderBuildGrid() {
  renderBaseBlueprintGrid();
  if (state.blueprintView === "heat") {
    suppressHeatGridNativeTooltips();
    refreshHeatPresentationSafely();
  } else {
    applyBlueprintPresentation();
  }
  refreshBlueprintControls();
  renderHoverPreview();
  // The inspector's "Predicted in this design" rows track the live design and
  // the selected thermal scenario, so refresh it alongside the grid.
  renderPartInspector();
}

function currentHeatAnalysis(mode = state.thermalLoadMode || DEFAULT_THERMAL_LOAD_MODE) {
  return getScenarioHeatAnalysis(mode);
}

function blueprintCellTitle(part, partIndex, exhaustAnalysis = null) {
  if (!part) return "Empty";
  const blocked = exhaustAnalysis?.blockedEngineIndices?.has(partIndex);
  if (blocked) return "Blocked exhaust — engine provides no thrust.";
  return `${PART_DEFS[part.type].name}${isRotatablePart(part.type) ? ` | ${normalizeRotation(part.rotation, PART_STATS[part.type]?.allowedRotations, part.x)} deg | Select ${PART_DEFS[part.type].name} and click again, or hover and press R to rotate` : ""}`;
}

function restoreBlueprintCellTitle(cell, part, partIndex, exhaustAnalysis = null) {
  cell.title = blueprintCellTitle(part, partIndex, exhaustAnalysis);
  cell.removeAttribute("aria-label");
}

function suppressHeatGridNativeTooltips() {
  for (const cell of dom.grid.querySelectorAll(".build-cell")) {
    cell.removeAttribute("title");
  }
}

export function setBlueprintView(view) {
  state.blueprintView = view === "heat" ? "heat" : "build";
  refreshBlueprintControls();
  renderHoverPreview();

  if (state.blueprintView === "heat") {
    suppressHeatGridNativeTooltips();
    refreshHeatPresentationSafely();
  } else {
    clearHeatInspectionState();
    clearHeatPresentation();
  }
}


function migrateHeatFlowViewState() {
  if (state.heatFlowView === "total") state.showAllHeatFlows = true;
  if (state.heatFlowView === "local" || state.heatFlowView === "off") state.showAllHeatFlows = false;
  state.heatFlowView = undefined;
}

function updateHeatFlowToggleControl() {
  migrateHeatFlowViewState();
  const showAll = Boolean(state.showAllHeatFlows);
  dom.showAllHeatFlows?.classList.toggle("active", showAll);
  dom.showAllHeatFlows?.setAttribute("aria-pressed", String(showAll));
}

function refreshBlueprintControls() {
  const heatView = state.blueprintView === "heat";
  dom.grid.classList.toggle("heat-overlay-active", heatView);
  dom.blueprintBuildTab?.classList.toggle("active", !heatView);
  dom.blueprintHeatTab?.classList.toggle("active", heatView);
  dom.blueprintBuildTab?.setAttribute("aria-selected", String(!heatView));
  dom.blueprintHeatTab?.setAttribute("aria-selected", String(heatView));
  if (dom.heatToolbar) dom.heatToolbar.hidden = !heatView;
  if (dom.blueprintThermalHud) dom.blueprintThermalHud.hidden = !heatView;
  if (dom.blueprintHeatLegend) dom.blueprintHeatLegend.hidden = !heatView;
  if (dom.thermalLoadModes) {
    dom.thermalLoadModes.hidden = !heatView;
    for (const button of dom.thermalLoadModes.querySelectorAll("[data-thermal-load]")) {
      const active = button.dataset.thermalLoad === (state.thermalLoadMode || DEFAULT_THERMAL_LOAD_MODE);
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }
  if (dom.thermalScenarioLabel) {
    dom.thermalScenarioLabel.hidden = !heatView;
    dom.thermalScenarioLabel.textContent = `Predicted component heat — ${THERMAL_SCENARIO_NAMES[state.thermalLoadMode || DEFAULT_THERMAL_LOAD_MODE]}`;
  }
  if (dom.heatFlowViewControls) {
    dom.heatFlowViewControls.hidden = !heatView;
    updateHeatFlowToggleControl();
  }
}

export function renderBaseBlueprintGrid() {
  dom.grid.textContent = "";
  clearHeatInspectionState();
  renderFullLoadThermalPanel(null, null);
  const exhaustAnalysis = globalThis.EngineExhaustRules.analyze(state.design, PART_STATS);

  // Find which cells are already covered by the extension of some component
  const coveredCells = new Set();
  const byCell = new Map();
  for (const part of state.design) {
    byCell.set(`${part.x},${part.y}`, part);
    const stat = PART_STATS[part.type] || PART_STATS.frame;
    const footprint = stat.footprint || { width: 1, height: 1 };
    const cells = getOccupiedCells(part.x, part.y, footprint, part.rotation || 0);
    for (const c of cells) {
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

      // Anchor stays at (x,y); the visual box is drawn from the rotated
      // footprint's top-left bound so rotated multi-tile parts extend correctly.
      let originX = x;
      let originY = y;
      let width = 1;
      let height = 1;

      if (part) {
        const stat = PART_STATS[part.type] || PART_STATS.frame;
        const footprint = stat.footprint || { width: 1, height: 1 };
        const bounds = getFootprintBounds(part.x, part.y, footprint, part.rotation || 0);
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
        const partIndex = state.design.indexOf(part);
        const blockedExhaust = exhaustAnalysis.blockedEngineIndices.has(partIndex);
        const rotation = normalizeRotation(part.rotation, PART_STATS[part.type]?.allowedRotations, part.x);
        const exhaustWarning = blockedExhaust ? `<span class="blocked-exhaust-warning" title="Blocked exhaust — engine provides no thrust." aria-label="Blocked exhaust — engine provides no thrust.">!</span>` : "";
        cell.innerHTML = `${partIconMarkup(part.type, "build-glyph", rotation)}${exhaustWarning}`;
        cell.dataset.partIndex = String(partIndex);
      }
      cell.dataset.x = String(x);
      cell.dataset.y = String(y);
      dom.grid.appendChild(cell);
    }
  }

  ensureBlueprintGridEventHandlers();
}

function applyBlueprintPresentation() {
  clearHeatPresentation();
  renderFullLoadThermalPanel(null, null);
}

function addClassString(element, classString) {
  const tokens = String(classString || "")
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length) element.classList.add(...tokens);
}

function refreshHeatPresentationSafely() {
  clearHeatUiError();

  try {
    const analysis = freshCurrentHeatAnalysis();

    if (!heatAnalysisMatchesCurrentDesign(analysis)) {
      throw new Error("Thermal analysis does not match current design");
    }

    applyHeatPresentation(analysis);
    updateHeatInspectionOverlay(analysis);
    clearHeatUiError();
  } catch (error) {
    console.error("Heat presentation failed", error);
    showHeatUiError(error);
  }
}

function clearHeatUiError() {
  dom.grid?.classList.remove("heat-ui-error");
  dom.blueprintThermalHud?.querySelector(".heat-ui-error-message")?.remove();
}

function showHeatUiError(error) {
  clearHeatFlowOverlay();
  clearExteriorCoolingIndicators();
  clearHeatContextCard();
  dom.grid?.classList.add("heat-ui-error");
  if (!dom.blueprintThermalHud) return;
  dom.blueprintThermalHud.hidden = false;
  dom.blueprintThermalHud.querySelector(".heat-ui-error-message")?.remove();
  const message = document.createElement("div");
  message.className = "heat-ui-error-message";
  message.textContent = "Heat view could not be loaded. Please reopen the Heat tab.";
  dom.blueprintThermalHud.prepend(message);
}

function applyHeatPresentation(heatAnalysis) {
  clearInvalidHeatIndexes();
  const updates = [];
  for (const cell of dom.grid.querySelectorAll(".build-cell.occupied")) {
    const index = Number(cell.dataset.partIndex);
    const part = state.design[index];
    if (!part) continue;
    const heatClass = heatAnalysis.componentClasses.get(part) || "";
    const prediction = heatAnalysis.predictions.get(part);
    if (!prediction) {
      throw new Error(`Missing heat prediction for component ${index}`);
    }
    const displayedHeat = Math.max(
      0,
      Math.min(
        100,
        Math.round(heatAnalysis.componentHeat.get(part) || 0)
      )
    );
    const meltdown = prediction?.meltdownTime != null;
    const overheated = !meltdown && displayedHeat >= 100;
    const critical = !meltdown && !overheated && displayedHeat >= 76;
    const role = thermalRoleMarkup(part, prediction, heatAnalysis, index);
    const stateLabel = globalThis.HeatRules.STATE_LABELS[prediction.state] || "Cool";
    const threeDigitHeat = displayedHeat >= 100;
    const heatBadge = `<span
      class="component-heat-value${threeDigitHeat
        ? " component-heat-value-three-digit"
        : ""}"
      title="Predicted heat capacity used"
      aria-label="Predicted heat capacity used: ${displayedHeat} percent"
    >
      <small class="heat-badge-icon" aria-hidden="true">♨</small>
      <span class="heat-badge-number">${displayedHeat}</span>
      <small class="heat-badge-percent">%</small>
    </span>`;
    const heatWarning = meltdown
      ? `<span class="component-overheat-warning" title="Reactor meltdown predicted — will explode at sustained load" aria-label="Reactor meltdown predicted">☢</span>`
      : overheated
      ? `<span class="component-overheat-warning" title="Overheated" aria-label="Overheated">▲</span>`
      : critical ? `<span class="component-critical-warning" title="Critical heat" aria-label="Critical heat">▲</span>` : "";
    updates.push({
      cell,
      heatClass,
      markup: `${role}${heatBadge}${heatWarning}`,
      ariaLabel:
        `${PART_DEFS[part.type].name}. ` +
        `${stateLabel}. ` +
        `${displayedHeat} percent heat capacity used.`
    });
  }
  clearHeatPresentation();
  for (const update of updates) {
    addClassString(update.cell, update.heatClass);
    update.cell.insertAdjacentHTML("beforeend", update.markup);
    update.cell.removeAttribute("title");
    update.cell.setAttribute("aria-label", update.ariaLabel);
  }
  renderFullLoadThermalPanel(currentHeatAnalysis("full"), heatAnalysis);
  renderThermalHud(heatAnalysis);
}

function clearHeatFlowOverlay() {
  dom.heatFlowOverlayHost?.replaceChildren();
  dom.grid.querySelector(".heat-flow-overlay")?.remove();
}

function clearExteriorCoolingIndicators() {
  (dom.heatFlowOverlayHost || dom.grid)?.querySelectorAll(".exterior-cooling-overlay").forEach(item => item.remove());
}

function clearHeatContextCard() {
  if (!dom.heatContextCard) return;
  dom.heatContextCard.hidden = true;
  dom.heatContextCard.innerHTML = "";
  dom.heatContextCard.className = "heat-context-card";
}

function clearHeatPresentation() {
  clearHeatFlowOverlay();
  clearExteriorCoolingIndicators();
  clearHeatContextCard();
  if (dom.blueprintThermalHud) { dom.blueprintThermalHud.hidden = true; dom.blueprintThermalHud.innerHTML = ""; }
  dom.grid.classList.remove("heat-inspecting");
  const exhaustAnalysis = state.blueprintView === "build"
    ? globalThis.EngineExhaustRules.analyze(state.design, PART_STATS)
    : null;
  for (const cell of dom.grid.querySelectorAll(".build-cell")) {
    for (const className of [...cell.classList]) {
      if (className.startsWith("heat-") || className.startsWith("thermal-") || className.startsWith("radiator-exposed")) cell.classList.remove(className);
    }
    cell.querySelectorAll(".component-heat-value, .component-overheat-warning, .component-critical-warning, .thermal-role-indicator").forEach(item => item.remove());
    const index = Number(cell.dataset.partIndex);
    const part = state.design[index];
    if (state.blueprintView === "build") {
      restoreBlueprintCellTitle(cell, part, index, exhaustAnalysis);
    } else {
      cell.removeAttribute("title");
    }
  }
}

function refreshHeatFlowOverlay(analysis) {
  clearHeatFlowOverlay();
  clearExteriorCoolingIndicators();
  if (state.blueprintView === "heat") {
    renderHeatFlows(analysis);
    renderExteriorCoolingIndicators(analysis);
  }
}

function switchToHeatView() { setBlueprintView("heat"); }

function switchToBuildView() { setBlueprintView("build"); }

function assertHeatViewKeepsBaseGridDom() {
  const before = [...dom.grid.querySelectorAll(".build-cell")];
  const priorView = state.blueprintView;
  state.blueprintView = "heat";
  refreshBlueprintControls();
  renderHoverPreview();
  const after = [...dom.grid.querySelectorAll(".build-cell")];
  console.assert(
    before.length === after.length &&
    before.every((cell, index) => cell === after[index]),
    "Heat tab replaced the base grid DOM"
  );
  state.blueprintView = priorView;
  refreshBlueprintControls();
  renderHoverPreview();
}

function ensureBlueprintGridEventHandlers() {
  if (!dom.grid.dataset.hasDelegatedClick) {
    dom.grid.addEventListener("click", (event) => {
      const cell = event.target.closest(".build-cell");
      if (!cell || !dom.grid.contains(cell)) return;
      const pointed = gridCellFromPointer(event.clientX, event.clientY);
      editCell(
        pointed?.x ?? Number(cell.dataset.x),
        pointed?.y ?? Number(cell.dataset.y)
      );
    });
    // Hover preview is delegated so cells are never rebuilt mid-click:
    // rebuilding on hover destroyed the mousedown target, so no click event fired.
    dom.grid.addEventListener("mousemove", (event) => {
      const cell = event.target.closest(".build-cell");
      if (!cell || !dom.grid.contains(cell)) return;
      // A multi-cell component is one spanning DOM button, so its dataset only
      // contains the component anchor. Resolve the physical grid square under
      // the pointer so the right/left/top/bottom sections all behave normally.
      const pointed = gridCellFromPointer(event.clientX, event.clientY);
      const x = pointed?.x ?? Number(cell.dataset.x);
      const y = pointed?.y ?? Number(cell.dataset.y);
      if (state.hoveredCell?.x === x && state.hoveredCell?.y === y) return;
      state.hoveredCell = { x, y };
      updateHoveredHeatPart(x, y);
      renderHoverPreview();
    });
    dom.grid.addEventListener("mouseleave", () => {
      state.hoveredCell = null;
      updateHoveredHeatPart(null, null);
      renderHoverPreview();
    });
    dom.grid.addEventListener("contextmenu", (event) => {
      const cell = event.target.closest(".build-cell");
      if (!cell || !dom.grid.contains(cell)) return;
      if (state.blueprintView === "heat") return;
      event.preventDefault();
      const pointed = gridCellFromPointer(event.clientX, event.clientY);
      removeCell(
        pointed?.x ?? Number(cell.dataset.x),
        pointed?.y ?? Number(cell.dataset.y)
      );
    });
    dom.grid.dataset.hasDelegatedClick = "true";
  }

  if (!dom.grid.dataset.hasHeatTabs) {
    dom.blueprintBuildTab?.addEventListener("click", () => {
      setBlueprintView("build");
      renderLocalStats();
    });
    dom.blueprintHeatTab?.addEventListener("click", () => {
      setBlueprintView("heat");
      renderLocalStats();
      renderPartInspector();
    });
    dom.thermalLoadModes?.addEventListener("click", event => {
      const button = event.target.closest("[data-thermal-load]");
      if (!button) return;
      state.thermalLoadMode = button.dataset.thermalLoad;
      refreshBlueprintControls();
      refreshHeatPresentationSafely();
      renderLocalStats();
      renderPartInspector();
    });
    dom.showAllHeatFlows?.addEventListener("click", () => {
      migrateHeatFlowViewState();
      state.showAllHeatFlows = !state.showAllHeatFlows;
      updateHeatFlowToggleControl();
      refreshHeatFlowOverlay(currentHeatAnalysis());
      updateHeatInspectionOverlay(currentHeatAnalysis(), { preserveOverlay: true });
    });
    dom.grid.dataset.hasHeatTabs = "true";
  }
}

function removePlacementPreviewElements() {
  for (const stale of dom.grid.querySelectorAll(".build-preview, .engine-exhaust-preview, .engine-thrust-arrow, .maneuver-preview-plume, .maneuver-preview-force, .maneuver-preview-torque, .maneuver-preview-weak")) {
    stale.remove();
  }
}

export function renderHoverPreview() {
  removePlacementPreviewElements();

  if (!state.hoveredCell || !state.selectedPart) return;

  {
    const selectedType = state.selectedPart;
    const candidate = createPlacementCandidate({
      grid: state.hoveredCell,
      componentType: selectedType,
      rotation: state.previewRotation || 0,
      design: state.design,
      catalogue: PART_STATS
    });
    if (!candidate.part) return;
    const footprint = (PART_STATS[selectedType] || PART_STATS.frame).footprint || { width: 1, height: 1 };
    const bounds = getFootprintBounds(candidate.part.x, candidate.part.y, footprint, candidate.normalizedRotation);

    const preview = document.createElement("div");
    preview.className = `build-preview ${candidate.ok ? "valid" : "invalid"}`;
    preview.title = candidate.message || "";
    preview.innerHTML = partIconMarkup(selectedType, "preview-glyph", candidate.normalizedRotation);
    positionPreviewOverlay(preview, bounds.minX, bounds.minY, bounds.width, bounds.height);
    dom.grid.appendChild(preview);
    const candidateIndex = candidate.nextDesign.indexOf(candidate.part);
    const candidateStat = PART_STATS[selectedType] || {};
    if (selectedType === "maneuverThruster") {
      renderManeuverThrusterPreview(candidate.part, candidate.ok, candidate.nextDesign);
      renderEngineExhaustPreview(candidate.nextDesign, candidateIndex, candidate.ok);
    } else if (candidateStat.thrust > 0) renderEngineExhaustPreview(candidate.nextDesign, candidateIndex, candidate.ok);
  }
}

function renderManeuverThrusterPreview(part, placementValid, design) {
  const rotation = normalizeRotation(part.rotation, PART_STATS[part.type]?.allowedRotations, part.x);
  const nozzleSide = rotation === 270 ? 1 : -1;
  const plume = document.createElement("div");
  plume.className = `maneuver-preview-plume ${placementValid ? "valid" : "invalid"} ${nozzleSide < 0 ? "left" : "right"}`;
  plume.title = nozzleSide < 0 ? "Nozzle plume left; force right" : "Nozzle plume right; force left";
  positionPreviewOverlay(plume, part.x + nozzleSide * 0.44, part.y + 0.28, 0.5, 0.44);
  dom.grid.appendChild(plume);

  const force = document.createElement("div");
  force.className = `maneuver-preview-force ${placementValid ? "valid" : "invalid"}`;
  force.textContent = nozzleSide < 0 ? "→" : "←";
  force.title = "Force direction";
  positionPreviewOverlay(force, part.x + (nozzleSide < 0 ? 0.58 : -0.08), part.y + 0.04, 0.5, 0.5);
  dom.grid.appendChild(force);

  const torque = document.createElement("div");
  torque.className = `maneuver-preview-torque ${placementValid ? "valid" : "invalid"}`;
  const centerOfMass = calculateCenterOfMass(Array.isArray(design) ? design : state.design, PART_STATS);
  torque.textContent = part.y < centerOfMass.y ? (nozzleSide < 0 ? "↻" : "↺") : (nozzleSide < 0 ? "↺" : "↻");
  torque.title = "Resulting turn direction";
  positionPreviewOverlay(torque, part.x + 0.18, part.y + 0.55, 0.64, 0.42);
  dom.grid.appendChild(torque);

  if (Math.abs((Number(part.y) || 0) - centerOfMass.y) < 0.75) {
    const weak = document.createElement("div");
    weak.className = `maneuver-preview-weak ${placementValid ? "valid" : "invalid"}`;
    weak.textContent = "weak";
    weak.title = "Weak torque near the centre of mass";
    positionPreviewOverlay(weak, part.x + 0.06, part.y + 0.02, 0.88, 0.28);
    dom.grid.appendChild(weak);
  }
}

function renderEngineExhaustPreview(design, engineIndex, placementValid) {
  const analysis = globalThis.EngineExhaustRules.analyze(design, PART_STATS);
  const engine = analysis.engines.get(engineIndex);
  if (!engine) return;
  for (const channel of engine.channelCells) {
    const overlay = document.createElement("div");
    overlay.className = `engine-exhaust-preview ${placementValid && engine.valid ? "valid" : "invalid"}${channel.blocked ? " blocker" : ""}`;
    overlay.title = channel.blocked ? "Exhaust blocked here" : "Required clear exhaust channel";
    positionPreviewOverlay(overlay, channel.x, channel.y, 1, 1);
    dom.grid.appendChild(overlay);
  }
  const module = design[engineIndex];
  const arrow = document.createElement("div");
  arrow.className = `engine-thrust-arrow ${placementValid && engine.valid ? "valid" : "invalid"}`;
  arrow.textContent = engine.thrust.y < 0 ? "↑" : engine.thrust.y > 0 ? "↓" : engine.thrust.x < 0 ? "←" : "→";
  arrow.title = "Thrust direction";
  positionPreviewOverlay(arrow, module.x, module.y, 1, 1);
  dom.grid.appendChild(arrow);
}

function placementRotation(type, rotation) {
  return type === "maneuverThruster" ? 0 : isRotatablePart(type) ? normalizeRotation(rotation, PART_STATS[type]?.allowedRotations) : 0;
}

function positionPreviewOverlay(preview, x, y, width, height) {
  const rect = typeof dom.grid.getBoundingClientRect === "function" ? dom.grid.getBoundingClientRect() : null;
  const computed = typeof window !== "undefined" && typeof window.getComputedStyle === "function"
    ? window.getComputedStyle(dom.grid)
    : null;
  const gapX = cssPx(computed?.columnGap || computed?.gap, 2);
  const gapY = cssPx(computed?.rowGap || computed?.gap, 2);
  const paddingLeft = cssPx(computed?.paddingLeft, 8);
  const paddingRight = cssPx(computed?.paddingRight, 8);
  const paddingTop = cssPx(computed?.paddingTop, 8);
  const paddingBottom = cssPx(computed?.paddingBottom, 8);

  if (rect && rect.width > 0 && rect.height > 0) {
    const contentWidth = Math.max(0, rect.width - paddingLeft - paddingRight);
    const contentHeight = Math.max(0, rect.height - paddingTop - paddingBottom);
    const cellWidth = (contentWidth - gapX * (GRID_SIZE - 1)) / GRID_SIZE;
    const cellHeight = (contentHeight - gapY * (GRID_SIZE - 1)) / GRID_SIZE;
    if (Number.isFinite(cellWidth) && Number.isFinite(cellHeight) && cellWidth > 0 && cellHeight > 0) {
      preview.style.left = `${paddingLeft + x * (cellWidth + gapX)}px`;
      preview.style.top = `${paddingTop + y * (cellHeight + gapY)}px`;
      preview.style.width = `${width * cellWidth + Math.max(0, width - 1) * gapX}px`;
      preview.style.height = `${height * cellHeight + Math.max(0, height - 1) * gapY}px`;
      return;
    }
  }

  const unit = 100 / GRID_SIZE;
  preview.style.left = `${x * unit}%`;
  preview.style.top = `${y * unit}%`;
  preview.style.width = `${width * unit}%`;
  preview.style.height = `${height * unit}%`;
}

function cssPx(value, fallback) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : fallback;
}

function gridCellFromPointer(clientX, clientY) {
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

function findPartAt(x, y) {
  return findPartAtCell(state.design, PART_STATS, x, y);
}

function clearHeatInspectionState() {
  state.hoveredHeatPartIndex = null;
}

function validHeatIndex(index) {
  return Number.isInteger(index) && index >= 0 && index < state.design.length;
}

function updateHoveredHeatPart(x, y) {
  if (state.blueprintView !== "heat") { clearHeatContextCard(); clearExteriorCoolingIndicators(); return; }
  const part = Number.isFinite(x) && Number.isFinite(y) ? findPartAt(x, y) : null;
  const next = part ? state.design.indexOf(part) : null;
  if (state.hoveredHeatPartIndex === next) return;
  state.hoveredHeatPartIndex = next;
  updateHeatInspectionOverlay(currentHeatAnalysis());
}

function clearInvalidHeatIndexes() {
  if (!validHeatIndex(state.hoveredHeatPartIndex)) state.hoveredHeatPartIndex = null;
}

export function editCell(x, y) {
  if (!state.selectedPart) return;
  const existing = findPartAt(x, y);
  if (existing?.type === "core") return;

  const candidate = createPlacementCandidate({
    grid: { x, y },
    componentType: state.selectedPart,
    rotation: state.previewRotation || 0,
    design: state.design,
    catalogue: PART_STATS
  });

  state.selectedCell = { x: candidate.part?.x ?? x, y: candidate.part?.y ?? y };

  if (existing?.type === state.selectedPart) {
    if (isRotatablePart(existing.type)) rotateCell(existing.x, existing.y);
    return;
  }

  if (!candidate.ok) {
    const level = candidate.reasonCode === "disconnected" ? "warning" : "error";
    setBuildStatus(candidate.message, level);
    showToast(candidate.message, level);
    return;
  }

  state.design = candidate.nextDesign;
  clearInvalidHeatIndexes();
  invalidateHeatAnalysisCache();
  persistDesign(state.design, state.combatStyle);
  renderBuildGrid();
  renderLocalStats();
  renderSavedDesigns();
}

export function rotateCell(x, y) {
  const part = state.design.find((candidate) => candidate.x === x && candidate.y === y);
  if (!part || !isRotatablePart(part.type)) return false;

  const newRotation = nextRotation(part.rotation, PART_STATS[part.type]?.allowedRotations);
  const next = state.design.map((candidate) => candidate === part
    ? { ...candidate, rotation: newRotation }
    : candidate);

  if (isOutOfBounds(next)) {
    setBuildStatus("Rotation goes outside build grid", "error");
    showToast("Rotation goes outside build grid", "error");
    return false;
  }
  if (isOverlapping(next)) {
    setBuildStatus("Rotation overlaps another component", "error");
    showToast("Rotation overlaps another component", "error");
    return false;
  }
  if (!isConnected(next)) {
    setBuildStatus("Rotation breaks connection to core", "error");
    showToast("Rotation breaks connection to core", "error");
    return false;
  }

  state.design = next;
  invalidateHeatAnalysisCache();
  if (state.selectedPart === part.type) {
    state.previewRotation = newRotation;
  }
  persistDesign(state.design, state.combatStyle);
  renderBuildGrid();
  renderLocalStats();
  renderSavedDesigns();
  return true;
}

export function rotateFocusedPart() {
  const cell = state.hoveredCell || state.selectedCell;
  const part = cell ? findPartAt(cell.x, cell.y) : null;
  if (part && isRotatablePart(part.type)) {
    rotateCell(part.x, part.y);
  } else if (state.selectedPart && isRotatablePart(state.selectedPart)) {
    state.previewRotation = nextRotation(state.previewRotation || 0, PART_STATS[state.selectedPart]?.allowedRotations);
    renderHoverPreview();
  }
}

export function removeCell(x, y) {
  if (state.blueprintView === "heat") return;
  const existing = findPartAt(x, y);
  if (!existing || existing.type === "core") return;
  const next = state.design.filter((part) => part !== existing);
  const validation = validateBlueprint(next);
  if (validation.ok) {
    state.design = next;
    clearInvalidHeatIndexes();
    invalidateHeatAnalysisCache();
    persistDesign(state.design, state.combatStyle);
    renderBuildGrid();
    renderLocalStats();
    renderSavedDesigns();
  } else {
    const message = validation.errors[0] || "Removing that part would make the blueprint invalid";
    setBuildStatus(message, "warning");
    showToast(message, "warning");
  }
}

export function resetDesign() {
  state.design = defaultDesign();
  invalidateHeatAnalysisCache();
  clearHeatInspectionState();
  state.loadedEditorBlueprintId = null;
  persistDesign(state.design, state.combatStyle);
  renderBuildGrid();
  renderLocalStats();
  renderSavedDesigns();
}

export function clearDesign() {
  state.design = [];
  invalidateHeatAnalysisCache();
  clearHeatInspectionState();
  state.loadedEditorBlueprintId = null;
  persistDesign(state.design, state.combatStyle);
  renderBuildGrid();
  renderLocalStats();
  renderSavedDesigns();
}

export function renderLocalStats() {
  const stats = computeStats(state.design);
  const heat = currentHeatAnalysis();
  const status = getShipStatus(stats);
  const mine = state.mine;
  const money = currentMatchMoney(mine);
  const canAfford = money >= stats.unitCost;
  
  if (dom.combatStyleSelect) {
    dom.combatStyleSelect.value = state.combatStyle || "sentry";
  }
  if (dom.saveDesignButton) {
    const existing = state.savedDesigns.find((design) => design.id === state.loadedEditorBlueprintId);
    dom.saveDesignButton.textContent = existing ? `Update "${existing.name}"` : "Save Blueprint";
  }
  if (dom.blueprintCostLabel) dom.blueprintCostLabel.textContent = `$${stats.unitCost}`;
  if (dom.blueprintCostStatus) {
    if (state.phase === "active") {
      dom.blueprintCostStatus.textContent = "";
    } else {
      dom.blueprintCostStatus.textContent = canAfford
        ? `Remaining after first ship $${Math.floor(money - stats.unitCost)}`
        : `Need $${Math.ceil(stats.unitCost - money)} before first ship`;
      dom.blueprintCostStatus.className = canAfford ? "affordable" : "expensive";
    }
  }
  const statDiagnostics = buildStatDiagnostics(stats);
  const statCard = (key, label, value) => statMarkup(key, label, value, statDiagnostics[key]);
  dom.stats.innerHTML = [
    state.blueprintView === "heat" ? `<div class="heat-design-summary"><strong>Thermal layout</strong><span>Likely hotspot: ${escapeHtml(heat.hotspot)}</span><span>Heat removal capacity: -${heat.coolingRate} H/s</span>${[heat.meltdownWarning, heat.routeWarning, heat.networkWarning, heat.severWarning].filter(warning => !/^(All|Thermal networks within|No single-frame|No reactor)/.test(warning)).map(warning => `<span class="heat-summary-warning">${escapeHtml(warning)}</span>`).join("")}</div>` : "",
    statCard("fleet", "Fleet", stats.fleetCount),
    statCard("class", "Class", stats.massClass),
    statCard("hull", "Hull", formatHull(stats.maxHp)),
    statCard("shield", "Shield", formatShield(stats.maxShield)),
    statCard("speed", "Speed", formatSpeed(Math.round(stats.maxSpeed))),
    statCard("turn", "Turn", directionalTurnText(stats)),
    statCard("power", "Power Gen/Req", formatPowerState(stats.powerGeneration, stats.powerUse, stats.powerEfficiency)),
    statCard("thrust", "Effective Thrust", formatThrust(stats.effectiveThrust)),
    statCard("engineEfficiency", "Engine Efficiency", formatPercent(stats.engineEfficiency)),
    statCard("powerEfficiency", "Power Efficiency", formatPercent(stats.powerEfficiency)),
    statCard("powerDebuff", "Power Penalty", stats.powerDebuff > 0 ? `-${formatPercent(stats.powerDebuff)}` : "None"),
    statCard("speedCap", "Mass Drag Limit", formatSpeed(stats.speedCap)),
    statCard("thrustRatio", "Thrust/Mass", `${round2(stats.thrustRatio)} kN/T`),
    statCard("weapons", "Weapons", `${stats.weaponDps} DPS`),
    stats.captureBonus > 0 ? statCard("capture", "Capture", `+${formatPercent(stats.captureBonus)}`) : "",
    statCard("repair", "Repair", formatRepair(stats.repairRate)),
    statCard("mass", "Mass", formatMass(stats.mass))
  ].join("");

  if (dom.blueprintCostBreakdown) {
    dom.blueprintCostBreakdown.innerHTML = costBreakdownInnerMarkup(stats.costBreakdown);
  }

  renderShipStatus(status);
  updateEconomyUi();
}


function thermalRoleMarkup(part, prediction, result, index) {
  if (!prediction) return "";
  const pieces = [];
  if (prediction.generation > 0.05) pieces.push(`<span class="thermal-role-indicator heat-source" title="Active heat source: +${prediction.generation.toFixed(1)} H/s" aria-label="Active heat source generating ${prediction.generation.toFixed(1)} heat per second">✦</span>`);
  if (part.type === "heatSink") pieces.push(`<span class="thermal-role-indicator heat-sink-role" title="Absorbing ${prediction.cooling.toFixed(1)} H/s; capacity ${prediction.capacity} H" aria-label="Heat Sink absorbing ${prediction.cooling.toFixed(1)} H/s">▢</span>`);
  if (part.type === "radiator") {
    const exposed = result.exteriorDirections?.[index]?.size > 0;
    pieces.push(`<span class="thermal-role-indicator radiator-role" title="Removing ${prediction.cooling.toFixed(1)} H/s; exterior exposure: ${exposed ? "yes" : "no"}" aria-label="Radiator removing ${prediction.cooling.toFixed(1)} H/s">⇱</span>`);
  }
  if (part.type === "heatPipe") pieces.push(`<span class="thermal-role-indicator heat-pipe-role" title="Heat Pipe conduit" aria-label="Heat Pipe conduit">┄</span>`);
  return pieces.join("");
}

function renderThermalHud(result) {
  if (!dom.blueprintThermalHud || state.blueprintView !== "heat" || !result) return;
  const a = result.analysis;
  const seconds = value => value == null ? "Never" : `${value.toFixed(1)} s`;
  const reserve = a.reserve >= 0;
  dom.blueprintThermalHud.hidden = false;
  dom.blueprintThermalHud.innerHTML = `<strong>${escapeHtml(THERMAL_SCENARIO_NAMES[a.mode] || a.mode)}</strong><b class="${a.balance.toLowerCase()}">${escapeHtml(a.balance)}</b>
    <span>${reserve ? "Removal reserve" : "Net heat"}</span><em>${reserve ? a.reserve.toFixed(1) : `+${a.net.toFixed(1)}`} H/s</em>
    <span>Peak heat</span><em>${Math.round(a.peakPredictedHeat * 100)}%</em>
    <span>First overheat</span><em>${seconds(a.firstOverheatTime)}</em>
    <span>Meltdown</span><em>${seconds(a.firstMeltdownTime)}</em>`;
}

function renderHeatContextCard(result) {
  const index = validHeatIndex(state.hoveredHeatPartIndex) ? state.hoveredHeatPartIndex : null;
  if (!dom.heatContextCard || state.blueprintView !== "heat" || !validHeatIndex(index) || !result) { clearHeatContextCard(); return; }
  const part = state.design[index], prediction = result.predictions.get(part);
  if (!prediction) { clearHeatContextCard(); return; }
  const labels = globalThis.HeatRules.STATE_LABELS;
  const net = prediction.generation + prediction.received - prediction.transferredOut - prediction.cooling;
  const row = (l, v, title = "", className = "") => `<span${title ? ` title="${escapeHtml(title)}"` : ""}${className ? ` class="${escapeHtml(className)}"` : ""}>${escapeHtml(l)}</span><strong${title ? ` title="${escapeHtml(title)}"` : ""}${className ? ` class="${escapeHtml(className)}"` : ""}>${escapeHtml(v)}</strong>`;
  const coolingLabel = part.type === "radiator" ? "Radiated to space" : "Passive cooling";
  const exposureRows = [];
  const destroyed = prediction.state === globalThis.HeatRules.STATE?.DESTROYED || prediction.ratio >= 1.25;
  const isExposed = (prediction.exposedEdges || 0) > 0;
  const multiplier = prediction.exposureCoolingMultiplier ?? 1;
  const routeProblemRows = [];
  if (/frame/i.test(part.type) && result.criticalFrames?.has?.(index)) {
    routeProblemRows.push(row("Thermal route", "Bottleneck", "Possible single-frame transfer bottleneck", "heat-card-warning"));
  }
  if (result.problemIndices?.unroutedHot?.has?.(index)) {
    routeProblemRows.push(row("Heat routing", "No cooling route", "Hot component cannot reach enough cooling", "heat-card-warning"));
  }
  const overloadedNetwork = result.networks?.some(network =>
    result.overloadedNetworkIds?.has?.(network.id) && (network.attached?.includes(index) || network.frameIndices?.includes(index))
  );
  if (overloadedNetwork) {
    routeProblemRows.push(row("Thermal network", "Overloaded", "Attached thermal network is overloaded", "heat-card-warning"));
  }
  if (!destroyed && part.type === "radiator") {
    exposureRows.push(row(
      "↗ Exterior exposure",
      isExposed ? "Full radiator output" : "25% radiator output",
      isExposed ? "Exposed radiator edge" : "Enclosed radiators operate at 25% output."
    ));
  } else if (isExposed && prediction.cooling > 0 && multiplier !== 1) {
    exposureRows.push(row(
      "↗ Exterior exposure",
      "+12% cooling",
      "An exterior edge increases this component's passive cooling by 12%."
    ));
  }
  dom.heatContextCard.hidden = false;
  dom.heatContextCard.className = "heat-context-card";
  dom.heatContextCard.innerHTML = `<h4>${escapeHtml(PART_DEFS[part.type]?.name || part.type)}</h4><div class="heat-card-state">${escapeHtml(labels[prediction.state] || "Heat")} — ${Math.min(100, Math.round(prediction.ratio * 100))}% <small>${prediction.heat.toFixed(0)} / ${prediction.capacity} H</small></div><div class="heat-card-grid">
    ${row("Generated", `+${prediction.generation.toFixed(1)} H/s`)}${row("Incoming transfer", `+${prediction.received.toFixed(1)} H/s`)}${row("Outgoing transfer", `-${prediction.transferredOut.toFixed(1)} H/s`)}${row(coolingLabel, `-${prediction.cooling.toFixed(1)} H/s`)}${exposureRows.join("")}${routeProblemRows.join("")}${row("Net heat change", `${net >= 0 ? "+" : ""}${net.toFixed(1)} H/s`)}${row("Overheat in", prediction.timeToOverheat == null ? "Never" : `${prediction.timeToOverheat.toFixed(1)} s`)}${heatEffectRows(part, prediction).join("")}${prediction.meltdownTime == null ? "" : row("Meltdown", `${prediction.meltdownTime.toFixed(1)} s`)}</div>`;
  positionHeatContextCard(index);
}


function heatEffectRows(part, prediction) {
  const rules = globalThis.HeatRules;
  const stat = PART_STATS[part.type] || {};
  const pct = (value) => `${Math.round(value * 100)}%`;
  const row = (l, v) => `<span>${escapeHtml(l)}</span><strong>${escapeHtml(v)}</strong>`;
  const state = prediction.state;
  if (part.type === "heatPipe") return [row("Heat transfer", "Unaffected")];
  if (part.type === "heatSink") return [row("Storage", "Unaffected"), row("Cooling output", pct(rules.activeCoolingForState(state)))];
  if (part.type === "radiator") return [row("Cooling output", pct(rules.activeCoolingForState(state)))];
  const passive = /frame/i.test(part.type) || ["armor", "compositeArmor", "bulkhead", "weaponMount"].includes(part.type);
  if (passive) {
    if (part.type === "armor" || part.type === "compositeArmor") return [row("Protection", pct(rules.passiveProtectionForState(state)))];
    return [row("Structural strength", pct(rules.passiveProtectionForState(state))), row("Damage taken", `×${rules.structuralDamageMultiplierForState(state).toFixed(2)}`)];
  }
  if (stat.weapon) return [row(stat.weapon.type === "beam" ? "Beam output" : "Fire rate", pct(rules.activeOutputForState(state)))];
  if ((stat.thrust || 0) > 0) return [row("Thrust output", pct(rules.activeOutputForState(state))), row("Turn output", pct(rules.activeOutputForState(state)))];
  if ((stat.powerGeneration || 0) > 0) return [row("Power output", pct(rules.activeOutputForState(state)))];
  if ((stat.shieldRegen || 0) > 0) return [row("Recharge rate", pct(rules.activeOutputForState(state)))];
  if ((stat.repairRate || 0) > 0) return [row("Repair output", pct(rules.activeOutputForState(state)))];
  if (stat.rangeBonus || stat.accuracyBonus || stat.fireRateBonus || stat.captureBonus || stat.ecmStrength || stat.decoyRange) return [row("Bonus effectiveness", pct(rules.activeOutputForState(state)))];
  return [];
}

function positionHeatContextCard(index) {
  const card = dom.heatContextCard, stage = dom.gridStage || dom.grid;
  const cells = [...dom.grid.querySelectorAll(`.build-cell[data-part-index="${index}"]`)];
  if (!card || !stage || !cells.length || typeof stage.getBoundingClientRect !== "function") return;
  const sr = stage.getBoundingClientRect();
  const gridRect = dom.grid.getBoundingClientRect();
  const rects = cells.map(cell => cell.getBoundingClientRect());
  const cr = {
    left: Math.min(...rects.map(rect => rect.left)),
    right: Math.max(...rects.map(rect => rect.right)),
    top: Math.min(...rects.map(rect => rect.top)),
    bottom: Math.max(...rects.map(rect => rect.bottom))
  };
  const cardWidth = Math.min(260, Math.max(210, card.offsetWidth || 230));
  const cardHeight = Math.max(110, card.offsetHeight || 130);
  const cellSize = gridRect.width / GRID_SIZE;
  const clearance = cellSize + 14;
  const boundary = 8;
  const component = { left: cr.left - sr.left, right: cr.right - sr.left, top: cr.top - sr.top, bottom: cr.bottom - sr.top };
  const keepClear = { left: component.left - cellSize, right: component.right + cellSize, top: component.top - cellSize, bottom: component.bottom + cellSize };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const overlapArea = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const centredY = component.top + ((component.bottom - component.top) - cardHeight) / 2;
  const centredX = component.left + ((component.right - component.left) - cardWidth) / 2;
  const rawCandidates = [
    { side: "right", x: component.right + clearance, y: centredY },
    { side: "left", x: component.left - cardWidth - clearance, y: centredY },
    { side: "below", x: centredX, y: component.bottom + clearance },
    { side: "above", x: centredX, y: component.top - cardHeight - clearance }
  ];
  const candidates = rawCandidates.map((candidate, order) => {
    const x = clamp(candidate.x, boundary, sr.width - cardWidth - boundary);
    const y = clamp(candidate.y, boundary, sr.height - cardHeight - boundary);
    const rect = { left: x, right: x + cardWidth, top: y, bottom: y + cardHeight };
    const fits = candidate.x >= boundary && candidate.x + cardWidth <= sr.width - boundary && candidate.y >= boundary && candidate.y + cardHeight <= sr.height - boundary;
    return { ...candidate, order, x, y, fits, keepOverlap: overlapArea(rect, keepClear), componentOverlap: overlapArea(rect, component) };
  });
  const best = candidates
    .filter(candidate => candidate.fits && candidate.keepOverlap === 0 && candidate.componentOverlap === 0)[0]
    || [...candidates].sort((a, b) => (a.keepOverlap + a.componentOverlap * 3) - (b.keepOverlap + b.componentOverlap * 3) || Number(b.fits) - Number(a.fits) || a.order - b.order)[0];
  const x = best.x;
  const y = best.y;
  card.style.left = `${x}px`; card.style.top = `${y}px`; card.style.maxWidth = `${cardWidth}px`;
}

function thermalHoverText(prediction) {
  if (!prediction) return "";
  const labels = globalThis.HeatRules.STATE_LABELS;
  const overheat = prediction.timeToOverheat === null ? "Time until overheat: never" : `Time until overheat: ${prediction.timeToOverheat.toFixed(1)}s`;
  const meltdown = prediction.meltdownTime != null ? `\nREACTOR MELTDOWN predicted at ${prediction.meltdownTime.toFixed(1)}s — explodes, damaging nearby components` : "";
  return `\nPredicted heat: ${Math.min(100, Math.round(prediction.ratio * 100))}% (${prediction.heat.toFixed(1)} / ${prediction.capacity} H)\nThermal state: ${labels[prediction.state]}\nHeat generated: +${prediction.generation.toFixed(1)} H/s\nDirect heat received: +${prediction.received.toFixed(1)} H/s\nDirect heat transferred out: -${prediction.transferredOut.toFixed(1)} H/s\nHeat removed: -${prediction.cooling.toFixed(1)} H/s\n${overheat}${meltdown}`;
}

function renderFullLoadThermalPanel(fullLoadResult, currentHeatResult = null) {
  const panel = dom.fullLoadThermalPanel;
  if (!panel) return;
  panel.hidden = !fullLoadResult;
  if (!fullLoadResult) return;
  const analysis = fullLoadResult.analysis;
  const tone = analysis.balance.toLowerCase();
  const statusText = analysis.meltdownCount > 0 ? "Reactor meltdown predicted"
    : analysis.balance === "Stable" ? "Thermally stable" : analysis.balance === "Marginal" ? "Thermally marginal" : "Thermally unsustainable";
  const row = (label, value) => `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
  const actionRows = (analysis.actionItems || []).map(item => `<li>${escapeHtml(item)}</li>`).join("");
  const seconds = value => value === null ? "Never" : `${value.toFixed(1)} s`;
  const equilibrium = analysis.equilibriumTime === null ? "No equilibrium" : `${analysis.equilibriumTime.toFixed(1)} s`;
  const spareCooling = analysis.reserve >= 0;
  panel.innerHTML = `
    <h3>Thermal Analysis</h3>
    <p>Maximum Sustained Load — all major systems operating continuously.</p>
    <div class="thermal-analysis-status ${tone}">${escapeHtml(statusText)}</div>
    <div class="thermal-key-stats">
      <div><span>${spareCooling ? "Removal reserve" : "Net heat"}</span><strong class="${spareCooling ? "thermal-good" : "thermal-bad"}">${spareCooling ? `${analysis.reserve.toFixed(1)} H/s` : `+${analysis.net.toFixed(1)} H/s`}</strong></div>
      <div><span>First overheat</span><strong class="${analysis.firstOverheatTime === null ? "thermal-good" : "thermal-bad"}">${seconds(analysis.firstOverheatTime)}</strong></div>
      <div><span>Reactor meltdown</span><strong class="${analysis.firstMeltdownTime === null ? "thermal-good" : "thermal-bad"}">${seconds(analysis.firstMeltdownTime)}</strong></div>
      <div><span>Peak component heat</span><strong>${Math.round(analysis.peakPredictedHeat * 100)}%</strong></div>
    </div>
    <details class="thermal-detailed-analysis"${state.thermalDetailsOpen ? " open" : ""}>
      <summary>Detailed analysis</summary>
      <div class="thermal-analysis-rows">
        ${row("Heat generation", `+${analysis.generation.toFixed(1)} H/s`)}
        ${row("Cooling capacity", `-${analysis.cooling.toFixed(1)} H/s`)}
        ${row("Actual heat removed", `-${analysis.actualCooling.toFixed(1)} H/s`)}
        ${row("Thermal equilibrium", equilibrium)}
        ${row("Expected to overheat", String(analysis.overheatedCount))}
        ${row("First component", analysis.firstOverheatIndex < 0 ? "None" : describeThermalComponent(analysis.firstOverheatIndex, state.design))}
        ${row("Predicted meltdowns", String(analysis.meltdownCount))}
        ${row("First meltdown", analysis.firstMeltdownIndex < 0 ? "None" : describeThermalComponent(analysis.firstMeltdownIndex, state.design))}
        ${row("Hottest network", analysis.hottestNetwork)}
        ${row("Weapon uptime", `${Math.round(analysis.weaponUptime * 100)}%`)}
        ${row("Engine efficiency", `${Math.round(analysis.engineEfficiency * 100)}%`)}
        ${row("Shield recharge uptime", `${Math.round(analysis.shieldUptime * 100)}%`)}
        ${row("Radiator utilisation", `${Math.round(analysis.radiatorUtilisation * 100)}%`)}
        ${row("Heat-sink saturation", analysis.heatSinkSaturationTime === null ? "Never" : `${analysis.heatSinkSaturationTime.toFixed(1)} s`)}
      </div>
      ${actionRows ? `<ul class="thermal-action-list">${actionRows}</ul>` : ""}
    </details>`;
  panel.querySelector(".thermal-detailed-analysis")?.addEventListener("toggle", event => {
    state.thermalDetailsOpen = event.target.open;
  });
}

function updateHeatInspectionOverlay(analysis, options = {}) {
  clearInvalidHeatIndexes();
  if (!options.preserveOverlay) {
    clearHeatFlowOverlay();
    clearExteriorCoolingIndicators();
  }
  for (const cell of dom.grid.querySelectorAll(".build-cell")) {
    cell.classList.remove("heat-related", "heat-unrelated");
  }
  dom.grid.classList.toggle("heat-inspecting", state.blueprintView === "heat" && validHeatIndex(state.hoveredHeatPartIndex));
  if (state.blueprintView !== "heat") { clearExteriorCoolingIndicators(); return; }
  const focus = validHeatIndex(state.hoveredHeatPartIndex) ? state.hoveredHeatPartIndex : null;
  const connected = new Set(validHeatIndex(focus) ? [focus] : []);
  for (const flow of analysis.flows || []) {
    if (flow.amount < HEAT_FLOW_THRESHOLD) continue;
    if (flow.from === focus || flow.to === focus) { connected.add(flow.from); connected.add(flow.to); }
  }
  for (const cell of dom.grid.querySelectorAll(".build-cell.occupied")) {
    const part = findPartAt(Number(cell.dataset.x), Number(cell.dataset.y));
    const index = part ? state.design.indexOf(part) : -1;
    cell.classList.toggle("heat-related", connected.has(index));
    cell.classList.toggle("heat-unrelated", connected.size > 0 && !connected.has(index));
  }
  renderHeatContextCard(analysis);
  if (!options.preserveOverlay) {
    renderHeatFlows(analysis);
    renderExteriorCoolingIndicators(analysis);
  }
}

function renderExteriorCoolingIndicators(analysis) {
  clearExteriorCoolingIndicators();
  const focus = validHeatIndex(state.hoveredHeatPartIndex) ? state.hoveredHeatPartIndex : null;
  if (state.blueprintView !== "heat" || focus == null || !analysis) return;
  const part = state.design[focus];
  const prediction = part ? analysis.predictions?.get(part) : null;
  const directions = prediction?.exteriorDirections || [];
  if (!part || !directions.length) return;
  const cells = [...dom.grid.querySelectorAll(`.build-cell[data-part-index="${focus}"]`)];
  if (!cells.length) return;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${GRID_SIZE} ${GRID_SIZE}`);
  svg.classList.add("exterior-cooling-overlay");
  const directionSet = new Set(directions);
  const titleText = part.type === "radiator" ? "Exposed radiator edge" : "Exterior cooling edge: +12% passive cooling";
  const byDirection = {
    left: { dx: -1, dy: 0, char: "←", x: cell => cell.x - 0.12, y: cell => cell.y + 0.5 },
    right: { dx: 1, dy: 0, char: "→", x: cell => cell.x + 1.12, y: cell => cell.y + 0.5 },
    top: { dx: 0, dy: -1, char: "↑", x: cell => cell.x + 0.5, y: cell => cell.y - 0.12 },
    bottom: { dx: 0, dy: 1, char: "↓", x: cell => cell.x + 0.5, y: cell => cell.y + 1.12 }
  };
  for (const cellEl of cells) {
    const cell = { x: Number(cellEl.dataset.x), y: Number(cellEl.dataset.y) };
    for (const direction of directionSet) {
      const meta = byDirection[direction];
      if (!meta || findPartAt(cell.x + meta.dx, cell.y + meta.dy)) continue;
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.classList.add("exterior-cooling-indicator", `exterior-cooling-${direction}`);
      text.setAttribute("x", String(meta.x(cell)));
      text.setAttribute("y", String(meta.y(cell)));
      text.setAttribute("aria-label", titleText);
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = titleText;
      text.appendChild(title);
      text.appendChild(document.createTextNode(meta.char));
      svg.appendChild(text);
    }
  }
  if (svg.children.length) (dom.heatFlowOverlayHost || dom.grid).appendChild(svg);
}

function renderHeatFlows(analysis) {
  migrateHeatFlowViewState();
  const focus = validHeatIndex(state.hoveredHeatPartIndex)
    ? state.hoveredHeatPartIndex
    : null;
  const showAll = Boolean(state.showAllHeatFlows);
  if (!showAll && focus == null) return;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 15 15");
  svg.classList.add("heat-flow-overlay");
  svg.innerHTML = `<defs><marker id="heat-flow-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="3.4" markerHeight="3.4" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#ff9a3d"/></marker><marker id="heat-flow-arrow-incoming" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="3.4" markerHeight="3.4" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#38d9ff"/></marker><marker id="heat-flow-arrow-outgoing" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="3.4" markerHeight="3.4" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#ff9a3d"/></marker></defs>`;
  const owner = new Map();
  const occupiedByIndex = state.design.map((part, i) => {
    const stat = PART_STATS[part.type] || PART_STATS.frame;
    const occupied = getOccupiedCells(part.x, part.y, stat.footprint || { width:1, height:1 }, part.rotation || 0);
    for (const cell of occupied) owner.set(`${cell.x},${cell.y}`, i);
    return occupied;
  });
  const renderedEdges = new Set();
  const labeledEdges = new Set();
  const labelRequests = [];
  for (const flow of analysis.flows || []) {
    if (flow.amount < HEAT_FLOW_THRESHOLD) continue;
    const focusedFlow = focus != null && (flow.from === focus || flow.to === focus);
    if (!showAll && !focusedFlow) continue;
    const from = state.design[flow.from];
    const to = state.design[flow.to];
    if (!from || !to) continue;
    const isHeatPipeFlow = from.type === "heatPipe" || to.type === "heatPipe";
    const isFrameFlow = /frame/i.test(from.type) || /frame/i.test(to.type) || isHeatPipeFlow;
    let drewFlow = false;
    for (const cell of occupiedByIndex[flow.from] || []) for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      if (owner.get(`${cell.x + dx},${cell.y + dy}`) !== flow.to) continue;
      const edgeKey = `${flow.from}>${flow.to}:${cell.x},${cell.y}:${dx},${dy}`;
      if (renderedEdges.has(edgeKey)) continue;
      renderedEdges.add(edgeKey);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(cell.x + 0.5 - dx * 0.12));
      line.setAttribute("y1", String(cell.y + 0.5 - dy * 0.12));
      line.setAttribute("x2", String(cell.x + 0.5 + dx * 0.72));
      line.setAttribute("y2", String(cell.y + 0.5 + dy * 0.72));
      const directionalClass = focusedFlow ? (flow.to === focus ? "heat-flow-incoming" : "heat-flow-outgoing") : "";
      line.setAttribute("marker-end", directionalClass === "heat-flow-incoming" ? "url(#heat-flow-arrow-incoming)" : directionalClass === "heat-flow-outgoing" ? "url(#heat-flow-arrow-outgoing)" : "url(#heat-flow-arrow)");
      const strength = Math.min(1, flow.amount / 5);
      line.classList.add(isFrameFlow ? "frame-heat-flow" : "component-heat-flow", isHeatPipeFlow ? "heat-pipe-heat-flow" : "frame-route-heat-flow", strength >= 0.9 ? "critical-heat-flow" : strength >= 0.58 ? "high-heat-flow" : strength >= 0.28 ? "moderate-heat-flow" : "low-heat-flow");
      if (directionalClass) line.classList.add(directionalClass);
      if (showAll && focus != null && !focusedFlow) line.classList.add("heat-flow-muted");
      if (focusedFlow) line.classList.add("heat-flow-focus");
      let opacity = 0.44 + strength * 0.46;
      let width = 0.032 + strength * 0.065;
      if (focusedFlow) {
        opacity = Math.min(1, opacity + 0.22);
        width = Math.min(0.12, width + 0.018);
      } else if (showAll && focus != null) {
        opacity *= 0.55;
      }
      line.style.opacity = String(opacity);
      line.style.strokeWidth = String(width);
      svg.appendChild(line);
      const labelEdgeKey = `${flow.from}>${flow.to}`;
      const shouldLabel = focusedFlow && !labeledEdges.has(labelEdgeKey);
      if (shouldLabel) {
        labeledEdges.add(labelEdgeKey);
        labelRequests.push({
          flow,
          cell,
          dx,
          dy,
          edgeKey,
          text: `${flow.amount.toFixed(1)} H/s`,
          incoming: flow.to === focus
        });
      }
      drewFlow = true;
    }
    if (drewFlow) continue;
  }
  renderHeatFlowLabels(svg, labelRequests, focus, occupiedByIndex[focus] || []);
  if (svg.children.length > 1) (dom.heatFlowOverlayHost || dom.grid).appendChild(svg);
}

const MAX_LABEL_ALONG_DISPLACEMENT = 0.20;
const MAX_LABEL_PERPENDICULAR_DISPLACEMENT = 0.42;
const LABEL_CLEARANCES = [0.20, 0.29, 0.38];
const LABEL_ALONG_ADJUSTMENTS = [0, -0.10, 0.10];
const LABEL_BOUNDARY_PADDING = 0.12;
const MIN_ARROWHEAD_LABEL_DISTANCE = 0.20;
const LABEL_TEXT_PADDING_X = 0.055;
const LABEL_TEXT_PADDING_Y = 0.026;
const LABEL_MAX_WIDTH = 0.86;

function canonicalEdgeKey(a, b) {
  const first = a.x < b.x || (a.x === b.x && a.y <= b.y) ? a : b;
  const second = first === a ? b : a;
  return `${first.x},${first.y}:${second.x},${second.y}`;
}

function canonicalEdgeNormal(a, b) {
  const first = a.x < b.x || (a.x === b.x && a.y <= b.y) ? a : b;
  const second = first === a ? b : a;
  const edgeDx = second.x - first.x;
  const edgeDy = second.y - first.y;
  return { x: -edgeDy, y: edgeDx };
}

function clampLabelCenter(value, halfSize) {
  return Math.min(GRID_SIZE - LABEL_BOUNDARY_PADDING - halfSize, Math.max(LABEL_BOUNDARY_PADDING + halfSize, value));
}

function labelBox(cx, cy, width, height) {
  return { left: cx - width / 2, right: cx + width / 2, top: cy - height / 2, bottom: cy + height / 2, width, height };
}

function overlapArea(a, b) {
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return width * height;
}

function renderHeatFlowLabels(svg, labelRequests, focus, focusCells) {
  if (!labelRequests.length || focus == null) return;
  labelRequests.sort((a, b) =>
    b.flow.amount - a.flow.amount ||
    Number(b.incoming) - Number(a.incoming) ||
    a.edgeKey.localeCompare(b.edgeKey) ||
    a.flow.from - b.flow.from ||
    a.flow.to - b.flow.to
  );
  const placedLabelBoxes = [];
  const focusBox = focusCells.length ? {
    left: Math.min(...focusCells.map(cell => cell.x)) + 0.18,
    right: Math.max(...focusCells.map(cell => cell.x)) + 0.82,
    top: Math.min(...focusCells.map(cell => cell.y)) + 0.18,
    bottom: Math.max(...focusCells.map(cell => cell.y)) + 0.82
  } : null;

  function measureLabel(text) {
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.classList.add("heat-flow-label-group");
    group.style.opacity = "0";
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.classList.add("heat-flow-label", "focused-flow-label");
    label.setAttribute("x", "0");
    label.setAttribute("y", "0");
    label.textContent = text;
    group.appendChild(label);
    svg.appendChild(group);
    const fallbackWidth = Math.min(LABEL_MAX_WIDTH, Math.max(0.56, text.length * 0.092 + LABEL_TEXT_PADDING_X * 2));
    const fallbackHeight = 0.24;
    let textBox = { x: -fallbackWidth / 2 + LABEL_TEXT_PADDING_X, y: -fallbackHeight / 2 + LABEL_TEXT_PADDING_Y, width: fallbackWidth - LABEL_TEXT_PADDING_X * 2, height: fallbackHeight - LABEL_TEXT_PADDING_Y * 2 };
    try {
      const measured = label.getBBox?.();
      if (measured && measured.width > 0 && measured.height > 0) {
        textBox = { x: measured.x, y: measured.y, width: measured.width, height: measured.height };
      }
    } catch (error) {
      // Browsers without SVG text measurement use the deterministic estimate above.
    }
    group.remove();
    const backgroundBox = {
      x: textBox.x - LABEL_TEXT_PADDING_X,
      y: textBox.y - LABEL_TEXT_PADDING_Y,
      width: Math.min(LABEL_MAX_WIDTH, textBox.width + LABEL_TEXT_PADDING_X * 2),
      height: textBox.height + LABEL_TEXT_PADDING_Y * 2
    };
    return { backgroundBox, width: backgroundBox.width, height: backgroundBox.height };
  }

  for (const request of labelRequests) {
    const { cell, dx, dy, text, incoming, flow } = request;
    const x1 = cell.x + 0.5 - dx * 0.12;
    const y1 = cell.y + 0.5 - dy * 0.12;
    const x2 = cell.x + 0.5 + dx * 0.72;
    const y2 = cell.y + 0.5 + dy * 0.72;
    const midpointX = (x1 + x2) / 2;
    const midpointY = (y1 + y2) / 2;
    const directionOffset = incoming ? -0.06 : 0.06;
    const baseX = midpointX + dx * directionOffset;
    const baseY = midpointY + dy * directionOffset;
    const fromCell = { x: cell.x, y: cell.y };
    const toCell = { x: cell.x + dx, y: cell.y + dy };
    const edgeKey = canonicalEdgeKey(fromCell, toCell);
    const canonicalNormal = canonicalEdgeNormal(fromCell, toCell);
    const preferredSide = incoming ? 1 : -1;
    const { backgroundBox, width, height } = measureLabel(text);
    let best = null;
    const orderedCandidates = [
      { side: preferredSide, distance: LABEL_CLEARANCES[0], alongAdjust: 0 },
      { side: preferredSide, distance: LABEL_CLEARANCES[1], alongAdjust: 0 },
      { side: -preferredSide, distance: LABEL_CLEARANCES[0], alongAdjust: 0 }
    ];
    for (const side of [preferredSide, -preferredSide]) {
      for (const distance of LABEL_CLEARANCES) {
        for (const alongAdjust of LABEL_ALONG_ADJUSTMENTS) {
          if (!orderedCandidates.some(candidate => candidate.side === side && candidate.distance === distance && candidate.alongAdjust === alongAdjust)) {
            orderedCandidates.push({ side, distance, alongAdjust });
          }
        }
      }
    }

    for (const { side, distance, alongAdjust } of orderedCandidates) {
      const rawX = baseX + canonicalNormal.x * distance * side + dx * alongAdjust;
      const rawY = baseY + canonicalNormal.y * distance * side + dy * alongAdjust;
      const cx = clampLabelCenter(rawX, width / 2);
      const cy = clampLabelCenter(rawY, height / 2);
      const alongDisplacement = Math.abs((cx - midpointX) * dx + (cy - midpointY) * dy);
      const perpendicularDisplacement = Math.abs((cx - midpointX) * canonicalNormal.x + (cy - midpointY) * canonicalNormal.y);
      if (alongDisplacement > MAX_LABEL_ALONG_DISPLACEMENT || perpendicularDisplacement > MAX_LABEL_PERPENDICULAR_DISPLACEMENT) continue;
      const box = labelBox(cx, cy, width, height);
      const arrowheadDistance = Math.hypot(cx - x2, cy - y2);
      if (arrowheadDistance < MIN_ARROWHEAD_LABEL_DISTANCE) continue;
      const midpointDistance = Math.hypot(cx - midpointX, cy - midpointY);
      const placedOverlap = placedLabelBoxes.reduce((total, placed) => total + overlapArea(box, placed.box), 0);
      const focusOverlap = focusBox ? overlapArea(box, focusBox) : 0;
      const outsideDistance = Math.abs(cx - rawX) + Math.abs(cy - rawY);
      const score =
        placedOverlap * 10000 +
        midpointDistance * 500 +
        focusOverlap * 900 +
        outsideDistance * 120 +
        (side === preferredSide ? 0 : 40) +
        Math.abs(alongAdjust) * 8 +
        distance * 0.1;
      if (!best || score < best.score) best = { cx, cy, box, score, edgeKey, side, backgroundBox };
    }

    if (!best) continue;
    placedLabelBoxes.push(best);
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.classList.add("heat-flow-label-group", incoming ? "incoming-flow-label-group" : "outgoing-flow-label-group");
    group.setAttribute("data-physical-edge", best.edgeKey);
    group.setAttribute("data-label-side", String(best.side));
    group.setAttribute("data-flow-from", String(flow.from));
    group.setAttribute("data-flow-to", String(flow.to));
    group.setAttribute("data-flow-amount", String(flow.amount));
    group.setAttribute("data-midpoint-x", String(midpointX));
    group.setAttribute("data-midpoint-y", String(midpointY));
    group.setAttribute("data-label-x", String(best.cx));
    group.setAttribute("data-label-y", String(best.cy));
    group.setAttribute("transform", `translate(${best.cx} ${best.cy})`);

    const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    background.classList.add("heat-flow-label-background");
    background.setAttribute("x", String(best.backgroundBox.x));
    background.setAttribute("y", String(best.backgroundBox.y));
    background.setAttribute("width", String(best.backgroundBox.width));
    background.setAttribute("height", String(best.backgroundBox.height));
    background.setAttribute("rx", ".045");
    background.setAttribute("ry", ".045");
    group.appendChild(background);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.classList.add("heat-flow-label", "focused-flow-label", incoming ? "incoming-flow-label" : "outgoing-flow-label");
    label.setAttribute("x", "0");
    label.setAttribute("y", "0");
    label.textContent = text;
    group.appendChild(label);
    svg.appendChild(group);
  }
}

export function heatInteractionDiagnostics() {
  const activeScenarioButton = dom.thermalLoadModes?.querySelector("[data-thermal-load].active")?.dataset.thermalLoad || null;
  return {
    blueprintView: state.blueprintView,
    thermalLoadMode: state.thermalLoadMode || DEFAULT_THERMAL_LOAD_MODE,
    activeScenarioButton,
    percentageBadgeCount: dom.grid.querySelectorAll(".component-heat-value").length,
    occupiedCellCount: dom.grid.querySelectorAll(".build-cell.occupied").length,
    previewCount: dom.grid.querySelectorAll(".build-preview, .engine-exhaust-preview, .engine-thrust-arrow, .maneuver-preview-plume, .maneuver-preview-force, .maneuver-preview-torque, .maneuver-preview-weak").length,
    heatFlowOverlayCount: (dom.heatFlowOverlayHost || dom.grid).querySelectorAll(".heat-flow-overlay").length,
    heatCacheSignature: cachedHeatAnalysis?.signature || null,
    heatCachePartReferencesMatch: cachedPartReferencesMatch(state.design),
    heatAnalysisMatchesCurrentDesign: heatAnalysisMatchesCurrentDesign(cachedHeatAnalysis?.result),
    heatUiErrorVisible: Boolean(dom.blueprintThermalHud?.querySelector(".heat-ui-error-message") || dom.grid?.classList.contains("heat-ui-error"))
  };
}

export function setBuildStatus(text, className) {
  if (!dom.buildStatus) return;
  dom.buildStatus.textContent = text;
  dom.buildStatus.className = `build-status ${className || ""}`.trim();
}

export function getShipStatus(stats) {
  const mine = state.mine;
  const blockers = [];
  const money = currentMatchMoney(mine);
  const isActiveBuild = state.phase === "active";
  const blueprintValidation = validateBlueprint(state.design, { requireThrust: true, stats });

  blockers.push(...blueprintValidation.errors);
  if (money < stats.unitCost) blockers.push(`${isActiveBuild ? "Cannot afford ship" : "Cannot ready design"}. Need $${Math.ceil(stats.unitCost - money)} more.`);

  const warnings = [...stats.warnings];
  if (money > 0 && stats.unitCost > money * 0.75) warnings.push("High cost for current money.");
  if (stats.maxShield < 35 && stats.maxHp < 210) warnings.push("Weak defence: low combined hull and shield.");

  return { blockers, warnings };
}

// Client-side severity mapper: the validation system exposes blocking issues
// (red) and warnings; we further split warnings into yellow warnings and green
// suggestions for display only. This does not change what blocks Ready/Build.
const SUGGESTION_PATTERNS = [
  /no weapons/i,
  /speed capped by mass/i,
  /large hull/i,
  /^add /i,
  /^consider /i
];

function classifyStatus(status) {
  const errors = [...status.blockers];
  const warnings = [];
  const suggestions = [];
  for (const message of status.warnings) {
    if (SUGGESTION_PATTERNS.some((pattern) => pattern.test(message))) {
      suggestions.push(message);
    } else {
      warnings.push(message);
    }
  }
  return { errors, warnings, suggestions };
}

export function renderShipStatus(status) {
  if (!dom.shipStatusChip) return;
  const groups = classifyStatus(status);
  const severity = groups.errors.length
    ? "error"
    : groups.warnings.length
      ? "warning"
      : groups.suggestions.length
        ? "suggestion"
        : "ready";

  dom.shipStatusChip.className = `ship-status-chip ${severity}`;
  if (dom.shipStatusText) dom.shipStatusText.textContent = chipSummaryText(severity, groups);

  const total = groups.errors.length + groups.warnings.length + groups.suggestions.length;
  dom.shipStatusChip.setAttribute("aria-label", `Ship status: ${chipSummaryText(severity, groups)}. ${total ? "Click for details." : ""}`.trim());

  // Keep the popover in sync if it is currently open.
  if (dom.shipStatusDetails && !dom.shipStatusDetails.hidden) {
    renderShipStatusDetails(groups);
  }
}

function chipSummaryText(severity, groups) {
  if (severity === "error") {
    return `${groups.errors.length} Blocking Error${groups.errors.length === 1 ? "" : "s"}`;
  }
  if (severity === "warning") {
    return `Ready with ${groups.warnings.length} warning${groups.warnings.length === 1 ? "" : "s"}`;
  }
  if (severity === "suggestion") {
    return `${groups.suggestions.length} Suggestion${groups.suggestions.length === 1 ? "" : "s"}`;
  }
  return "Ready";
}

function renderShipStatusDetails(groups) {
  if (!dom.shipStatusDetails) return;
  const total = groups.errors.length + groups.warnings.length + groups.suggestions.length;
  const body = total
    ? [
        statusGroupMarkup("error", "Blocking Errors", groups.errors),
        statusGroupMarkup("warning", "Warnings", groups.warnings),
        statusGroupMarkup("suggestion", "Suggestions", groups.suggestions)
      ].join("")
    : `<div class="status-group ready"><p>No issues — this ship is ready.</p></div>`;
  dom.shipStatusDetails.innerHTML = body;
}

function statusGroupMarkup(severity, title, issues) {
  if (!issues.length) return "";
  return `
    <div class="status-group ${severity}">
      <span>${title}</span>
      <ul>${issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("")}</ul>
    </div>
  `;
}

function toggleShipStatusDetails(forceOpen) {
  if (!dom.shipStatusDetails || !dom.shipStatusChip) return;
  const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : dom.shipStatusDetails.hidden;
  if (shouldOpen) {
    const status = getShipStatus(computeStats(state.design));
    renderShipStatusDetails(classifyStatus(status));
    dom.shipStatusDetails.hidden = false;
    dom.shipStatusChip.setAttribute("aria-expanded", "true");
    positionShipStatusDetails();
  } else {
    dom.shipStatusDetails.hidden = true;
    dom.shipStatusChip.setAttribute("aria-expanded", "false");
  }
}

// Position the fixed popover just above the chip (desktop). Narrow screens use a
// CSS bottom-sheet layout instead, so we skip JS placement there.
function positionShipStatusDetails() {
  const details = dom.shipStatusDetails;
  const chip = dom.shipStatusChip;
  if (!details || !chip || typeof chip.getBoundingClientRect !== "function") return;
  if (typeof window !== "undefined" && window.innerWidth <= 900) return;

  const margin = 12;
  const chipRect = chip.getBoundingClientRect();
  const detailsRect = details.getBoundingClientRect();
  const viewportW = (typeof window !== "undefined" && window.innerWidth) || 1024;

  let left = chipRect.left + chipRect.width / 2 - detailsRect.width / 2;
  left = Math.max(margin, Math.min(left, viewportW - detailsRect.width - margin));
  const top = Math.max(margin, chipRect.top - detailsRect.height - 8);

  details.style.left = `${left}px`;
  details.style.top = `${top}px`;
}

if (dom.shipStatusChip) {
  dom.shipStatusChip.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleShipStatusDetails();
  });
}

if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("click", (event) => {
    if (dom.shipStatusDetails && !dom.shipStatusDetails.hidden) {
      if (!event.target.closest("#shipStatusDetails") && !event.target.closest("#shipStatusChip")) {
        toggleShipStatusDetails(false);
      }
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dom.shipStatusDetails && !dom.shipStatusDetails.hidden) {
      toggleShipStatusDetails(false);
      dom.shipStatusChip?.focus();
    }
  });
}

function currentMatchMoney(mine) {
  return mine ? Number(mine.money) || 0 : state.rules.startingMoney;
}

// Toggle/Show tooltip on click
if (dom.stats) {
  dom.stats.addEventListener("click", (e) => {
    const card = e.target.closest(".stat");
    if (card) {
      e.stopPropagation();
      const key = card.dataset.statKey;
      if (!dom.statTooltip.hidden && dom.statTooltip.dataset.activeKey === key) {
        hideStatTooltip();
      } else {
        showStatTooltip(card, e);
        dom.statTooltip.dataset.activeKey = key;
      }
    }
  });

  dom.stats.addEventListener("keydown", (e) => {
    const card = e.target.closest(".stat");
    if (card && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      card.click();
    }
  });
}

// Close tooltip when clicking outside
if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("click", (e) => {
    if (dom.statTooltip && !dom.statTooltip.hidden) {
      if (!e.target.closest(".stat") && !e.target.closest("#statTooltip")) {
        hideStatTooltip();
      }
    }
  });
}

function showStatTooltip(card, event) {
  if (!dom.statTooltip) return;
  const key = card.dataset.statKey;
  const stats = computeStats(state.design);
  const markup = buildStatTooltipMarkup(key, stats);
  if (!markup) {
    dom.statTooltip.hidden = true;
    return;
  }
  dom.statTooltip.innerHTML = markup;
  dom.statTooltip.hidden = false;
  positionStatTooltip(event);
}

function positionStatTooltip(event) {
  if (!dom.statTooltip || dom.statTooltip.hidden) return;
  const margin = 14;
  const rect = dom.statTooltip.getBoundingClientRect();
  const sourceRect = event.currentTarget?.getBoundingClientRect?.();
  const pointerX = event.clientX || sourceRect?.left || window.innerWidth / 2;
  const pointerY = event.clientY || sourceRect?.top || window.innerHeight / 2;
  
  const left = Math.min(pointerX + 14, window.innerWidth - rect.width - margin);
  const top = Math.min(pointerY - rect.height - 12, window.innerHeight - rect.height - margin);
  
  dom.statTooltip.style.left = `${Math.max(margin, left)}px`;
  dom.statTooltip.style.top = `${Math.max(margin, top)}px`;
}

function hideStatTooltip() {
  if (dom.statTooltip) dom.statTooltip.hidden = true;
}

function formatTooltipText(text) {
  if (!text) return "";
  let html = escapeHtml(text);
  html = html.replace(/\bHP\b/g, '<span class="stat-unit hp">HP</span>');
  html = html.replace(/\bSP\b/g, '<span class="stat-unit sp">SP</span>');
  html = html.replace(/\bm\/s\b/g, '<span class="stat-unit speed">m/s</span>');
  html = html.replace(/\brad\/s\b/g, '<span class="stat-unit turn">rad/s</span>');
  html = html.replace(/\bdeg\/s\b/g, '<span class="stat-unit turn">deg/s</span>');
  html = html.replace(/\bMW\b/g, '<span class="stat-unit power">MW</span>');
  html = html.replace(/\bMJ\b/g, '<span class="stat-unit power">MJ</span>');
  html = html.replace(/\bkN\b/g, '<span class="stat-unit thrust">kN</span>');
  html = html.replace(/\bT\b/g, '<span class="stat-unit mass">T</span>');
  html = html.replace(/\b\$\b/g, '<span class="stat-unit money">$</span>');
  html = html.replace(/\bDPS\b/g, '<span class="stat-unit hp">DPS</span>');
  return html;
}

function buildStatTooltipMarkup(key, stats) {
  const data = buildStatTooltipData(key, stats);
  if (!data.label) return "";

  let html = `<div class="stat-tooltip-head"><strong>${escapeHtml(data.label)}</strong></div>`;
  html += `<div class="stat-tooltip-desc">${formatTooltipText(data.desc)}</div>`;

  if (data.formula) {
    html += `<div class="stat-tooltip-formula">${formatTooltipText(data.formula)}</div>`;
  }

  if (data.breakdown) {
    html += `<div class="stat-tooltip-breakdown">${formatTooltipText(data.breakdown)}</div>`;
  }

  return html;
}

function buildStatTooltipData(key, stats) {
  switch (key) {
    case "fleet":
      return {
        label: "Fleet Squadron Size",
        desc: "Number of ships spawned by this blueprint in matches. Cheaper designs with smaller mass allow you to control larger fleets in combat.",
        formula: "Squadron Size = Clamp(Floor(260 / (UnitCost * 0.72 + Mass * 0.45)), 1, 5)",
        breakdown: `Unit Cost: $${stats.unitCost}\nMass: ${stats.mass} T\nFinal Squad Size: ${stats.fleetCount} ship(s)`
      };
    
    case "class":
      return {
        label: "Ship Weight Class",
        desc: "Weight class category of this design based on mass. Heavier weight classes feature higher base hull HP and defense buffers, but restrict top speed limits and hull rotation rates.",
        formula: "Light (<55 T) | Medium (55-124 T) | Heavy (125-229 T) | Capital (230+ T)",
        breakdown: `Mass: ${stats.mass} T\nWeight Class: ${stats.massClass}`
      };

    case "hull": {
      let coreHp = 0, armorHp = 0, frameHp = 0, weaponHp = 0, otherHp = 0;
      for (const m of state.design) {
        const part = PART_STATS[m.type] || PART_STATS.frame;
        if (m.type === "core") coreHp += part.hp;
        else if (m.type === "armor" || m.type === "compositeArmor") armorHp += part.hp;
        else if (m.type === "frame") frameHp += part.hp;
        else if (part.weapon) weaponHp += part.hp;
        else otherHp += part.hp;
      }
      return {
        label: "Hull Hit Points",
        desc: "Total structural health of the ship, tracked per component along the impact path. The core keeps its own separate pool (45% of hull, minimum 320) outside this total and is only damaged by shots that penetrate to it. The ship dies at 0 hull or when the core is destroyed.",
        formula: "MaxHp = Max(140, Round(RawHP * 1.15))",
        breakdown: `Core: ${coreHp} HP
Armor: +${armorHp} HP
Frames: +${frameHp} HP
Weapons: +${weaponHp} HP
Other Systems: +${otherHp} HP
Raw HP Sum: ${coreHp + armorHp + frameHp + weaponHp + otherHp} HP
Final Hull HP: ${stats.maxHp} HP`
      };
    }

    case "shield":
      return {
        label: "Shield Buffers",
        desc: "Shield barrier capacity. Shields absorb 95% of incoming blocked damage, leaking 5% to the hull. Shield generators and batteries increase this. Blocked damage also heats the shield generators, and recharging generates heat — hot shield modules recharge slower.",
        formula: "MaxShield = Round(RawShield * PowerEfficiency)",
        breakdown: `Raw Shield: ${Math.round(stats.maxShield / Math.max(0.01, stats.efficiency))} SP
Power Efficiency: ${Math.round(stats.efficiency * 100)}%
Final Shield SP: ${stats.maxShield} SP
Shield Recharge: +${stats.shieldRegen}/s`
      };

    case "speed":
      return {
        label: "Top Speed",
        desc: "Maximum speed the ship can achieve when engines are fully engaged. Mass smoothly scales down engine efficiency without hard class walls.",
        formula: "FinalSpeed = RawSpeed\nRawSpeed = (120 + (Thrust/Mass) * 32) * MassSpeedPenalty * PowerMult * 1.3",
        breakdown: `Engine Thrust: ${stats.effectiveThrust} kN
Mass: ${stats.mass} T
Thrust/Mass Ratio: ${stats.thrustRatio.toFixed(2)} kN/T
Mass Speed Penalty Factor: ${stats.mass > 0 ? (1 / Math.pow(1 + stats.mass / 100, 0.65)).toFixed(3) : "1.000"}
Power Efficiency Mult: ${Math.round(stats.powerEfficiency * 100)}%
Final Speed: ${Math.round(stats.maxSpeed)} m/s`
      };

    case "turn":
      return {
        label: "Hull Turn Rate",
        desc: "Directional hull turn rates. Uneven values indicate manoeuvre thrusters favour one turn direction; neither direction is automatically better.",
        formula: "TurnRate = SoftCap(RawTurn, TurnCap, 0.2)",
        breakdown: `Reliable Turn: ${stats.turnRate.toFixed(2)} rad/s (${Math.round(stats.turnRate * (180 / Math.PI))} deg/s)\nLeft Turn: ${(stats.turnRateLeft ?? stats.turnRate).toFixed(2)} rad/s\nRight Turn: ${(stats.turnRateRight ?? stats.turnRate).toFixed(2)} rad/s
Mass Turn Cap Limit: ${stats.turnCap.toFixed(2)} rad/s`
      };

    case "power": {
      const surplus = stats.powerGeneration - stats.powerUse;
      return {
        label: "Reactor Power Balance",
        desc: "Generated energy compared to power consumed by active thrusters, shields, and weapons. Reactors also produce heat in proportion to their load — an overheated reactor stops generating and melts down (explodes) if it stays pinned at overheat, so give reactors a heat-transfer path to a radiator or Heat Sink. Check the Heat tab for the full thermal analysis.",
        formula: "PowerBalance = PowerGeneration - PowerUse",
        breakdown: `Reactor Generation: +${stats.powerGeneration.toFixed(1)} MW
Subsystem Consumed: -${stats.powerUse.toFixed(1)} MW
Grid Surplus: ${surplus >= 0 ? "+" : ""}${surplus.toFixed(1)} MW`
      };
    }

    case "thrust":
      return {
        label: "Effective Engine Thrust",
        desc: "Total usable thrust generated by propulsion systems. Stacks with soft caps to prevent excessive acceleration.",
        formula: "Diminishing Returns (99% stack factor)",
        breakdown: `Raw Engine Sum: ${stats.thrust} kN
Effective Stacked Thrust: ${stats.effectiveThrust} kN`
      };

    case "engineEfficiency":
      return {
        label: "Engine Stacking Efficiency",
        desc: "Proportion of raw thrust converted into effective stacked thrust. Excessive engine modules reduce efficiency.",
        formula: "Efficiency = EffectiveThrust / RawThrust",
        breakdown: `Raw Engine Sum: ${stats.thrust} kN
Effective Thrust: ${stats.effectiveThrust} kN
Efficiency: ${Math.round(stats.engineEfficiency * 100)}%`
      };

    case "powerEfficiency":
      return {
        label: "Subsystem Power Efficiency",
        desc: "Energy grid output performance ratio. Low power capacity limits defense recharge rates.",
        formula: "Efficiency = Clamp(PowerGeneration / PowerUse, 0, 1.1)",
        breakdown: `Reactor Generation: +${stats.powerGeneration.toFixed(1)} MW
Subsystem Consumed: -${stats.powerUse.toFixed(1)} MW
Efficiency: ${Math.round(stats.powerEfficiency * 100)}%`
      };

    case "powerDebuff": {
      const eff = Math.min(1, Number(stats.efficiency) || 1);
      const sysPenalty = Math.round((1 - eff) * 100);
      const movePenalty = Math.round((Number(stats.powerDebuff) || 0) * 100);
      const deficit = stats.powerUse > stats.powerGeneration;
      return {
        label: "Power Penalty",
        desc: deficit
          ? "Reactor output is below demand, so power-hungry systems run under-powered and lose effectiveness. Add reactors/batteries or cut power use to clear it."
          : "Power supply meets demand — no systems are being throttled.",
        formula: "Under-power scales each system down toward the generation / demand ratio.",
        breakdown: deficit
          ? `Generation +${stats.powerGeneration.toFixed(1)} MW vs Demand -${stats.powerUse.toFixed(1)} MW
Weapon damage: -${sysPenalty}%
Shield capacity & regen: -${sysPenalty}%
Repair rate: -${sysPenalty}%
Engine thrust / speed / accel / turn: -${movePenalty}%
Fire rate: unaffected by power (only reduced by overheating)`
          : "All systems at full effectiveness."
      };
    }

    case "speedCap":
      return {
        label: "Mass Drag Limit",
        desc: "Mass reduces engine efficiency smoothly. Heavier ships need more thrust to reach high speed. Ship class is descriptive, not a hard speed wall.",
        formula: "Drag Factor = 1 / (1 + Mass / 100)^0.65",
        breakdown: `Ship Mass: ${stats.mass} T
Weight Class: ${stats.massClass}
Mass Drag Factor: ${stats.mass > 0 ? (1 / Math.pow(1 + stats.mass / 100, 0.65)).toFixed(3) : "1.000"}`
      };

    case "thrustRatio":
      return {
        label: "Thrust-to-Mass ratio",
        desc: "Acceleration potential index. Higher numbers allow you to change directions and escape hazards faster.",
        formula: "ThrustRatio = EffectiveThrust / Mass",
        breakdown: `Effective Thrust: ${stats.effectiveThrust} kN
Mass: ${stats.mass} T
Acceleration index: ${stats.thrustRatio.toFixed(2)} kN/T`
      };

    case "weapons": {
      const weaponsCount = stats.blaster + stats.missile + stats.railgun + (stats.beam || 0);
      const desc = `${stats.blaster} Blaster(s) / ${stats.missile} Missile(s) / ${stats.railgun} Railgun(s)` + (stats.beam ? ` / ${stats.beam} Beam(s)` : "");
      return {
        label: "Weapons loadout",
        desc: "Ship offensive weapon summary. More active weapons increase direct combat DPS but add mass, cost, and power use.",
        formula: "DPS = Base Weapon DPS Sum",
        breakdown: `Active Guns: ${weaponsCount}
Summary: ${desc}
Total DPS: ${stats.weaponDps} DPS`
      };
    }

    case "capture":
      return {
        label: "Lobby Capture Pressure",
        desc: "objective control zone capture rate speedup.",
        formula: "Capture rate = Base + Sum of Capture modules",
        breakdown: `Zone Capture rate: +${Math.round(stats.captureBonus * 100)}%`
      };

    case "repair":
      return {
        label: "Hull Repair Rate",
        desc: "Active repair rate of hull integrity per second. Does not restore shield capacity.",
        formula: "Diminishing Returns (62% stack factor)",
        breakdown: `Repair Rate: ${stats.repairRate.toFixed(1)} HP/s`
      };

    case "mass": {
      let structMass = 0, weaponMass = 0, engineMass = 0, powerMass = 0, otherMass = 0;
      for (const m of state.design) {
        const part = PART_STATS[m.type] || PART_STATS.frame;
        if (part.category === "Structure") structMass += part.mass;
        else if (part.category === "Weapons") weaponMass += part.mass;
        else if (part.category === "Engines") engineMass += part.mass;
        else if (part.category === "Power" || part.category === "Defence") powerMass += part.mass;
        else otherMass += part.mass;
      }
      return {
        label: "Blueprint Ship Mass",
        desc: "Total mass weight in tonnes. Heavier ships survive longer but turn and accelerate slower.",
        formula: "Mass = Sum of module masses",
        breakdown: `Structure: ${structMass} T
Weapons: ${weaponMass} T
Engines: ${engineMass} T
Systems / Defence: ${powerMass} T
Other modules: ${otherMass} T
Total Mass: ${stats.mass} T`
      };
    }

    default:
      return { label: "", desc: "", formula: "", breakdown: "" };
  }
}

function costBreakdownInnerMarkup(breakdown) {
  if (!breakdown) return "";
  const rows = [
    ["Base", breakdown.base],
    ["Parts", breakdown.parts],
    ["Mass", breakdown.mass],
    ["Hull", breakdown.hull],
    ["Shield", breakdown.shield],
    ["Repair", breakdown.repair],
    ["Weapons", breakdown.weaponPremium],
    ["Size tax", breakdown.sizeTax]
  ];
  return `
    <div class="cost-breakdown-grid">
      ${rows.map(([label, value]) => `
        <div>
          <span>${label}</span>
          <strong>$${value}</strong>
        </div>
      `).join("")}
    </div>
  `;
}

const DIAGNOSTIC_LEVELS = new Set(["neutral", "good", "warning", "bad"]);

function directionalTurnText(stats) {
  const left = Number(stats.turnRateLeft ?? stats.turnRate ?? 0);
  const right = Number(stats.turnRateRight ?? stats.turnRate ?? 0);
  if (Math.abs(left - right) < 0.01) return `Turn rate ${left.toFixed(2)} rad/s`;
  return `Left ${left.toFixed(2)} / Right ${right.toFixed(2)} rad/s`;
}

function buildStatDiagnostics(stats) {
  return {
    power: classifyPower(stats),
    engineEfficiency: classifyEfficiency(stats.engineEfficiency, { good: 0.95, warning: 0.75, zeroIsBad: true }),
    powerEfficiency: classifyEfficiency(stats.powerEfficiency, { good: 1, warning: 0.8 }),
    thrust: classifyThrust(stats),
    thrustRatio: classifyThrustRatio(stats.thrustRatio),
    speed: classifySpeed(stats.maxSpeed),
    turn: classifyTurn(stats.turnRate),
    speedCap: classifyMassDrag(stats)
  };
}

function diagnostic(status = "neutral") {
  return DIAGNOSTIC_LEVELS.has(status) ? status : "neutral";
}

function classifyPower(stats) {
  const powerUse = Number(stats.powerUse) || 0;
  const powerGeneration = Number(stats.powerGeneration) || 0;
  if (powerUse <= 0) return powerGeneration > 0 ? "good" : "neutral";
  if (powerGeneration <= 0) return "bad";

  const useRatio = powerUse / powerGeneration;
  if (useRatio > 1) return "bad";
  if (useRatio >= 0.8) return "warning";
  return "good";
}

function classifyEfficiency(value, thresholds) {
  const amount = Number(value) || 0;
  if (thresholds.zeroIsBad && amount <= 0) return "bad";
  if (amount >= thresholds.good) return "good";
  if (amount >= thresholds.warning) return "warning";
  return "bad";
}

function classifyThrust(stats) {
  const thrust = Number(stats.effectiveThrust) || 0;
  const ratio = Number(stats.thrustRatio) || 0;
  if (thrust <= 0 || ratio < 1.5) return "bad";
  if (ratio < 2.7) return "warning";
  if (thrust >= 220 && ratio >= 3.5) return "good";
  return "neutral";
}

function classifyThrustRatio(value) {
  const ratio = Number(value) || 0;
  if (ratio <= 0 || ratio < 1.5) return "bad";
  if (ratio < 2.7) return "warning";
  if (ratio >= 4.5) return "good";
  return "neutral";
}

function classifySpeed(value) {
  const speed = Number(value) || 0;
  if (speed <= 0 || speed < 130) return "bad";
  if (speed < 190) return "warning";
  if (speed >= 275) return "good";
  return "neutral";
}

function classifyTurn(value) {
  const turn = Number(value) || 0;
  if (turn <= 0.35) return "bad";
  if (turn < 0.75) return "warning";
  if (turn >= 1.8) return "good";
  return "neutral";
}

function classifyMassDrag(stats) {
  const mass = Number(stats.mass) || 0;
  if (mass <= 0) return "neutral";
  const dragFactor = 1 / Math.pow(1 + mass / 100, 0.65);
  const speed = Number(stats.maxSpeed) || 0;
  const speedCap = Number(stats.speedCap) || 0;
  const capRatio = speedCap > 0 ? speed / speedCap : 0;
  if (dragFactor < 0.48) return "bad";
  if (dragFactor < 0.62 || stats.speedCapped || capRatio >= 0.95) return "warning";
  return "neutral";
}

function statMarkup(key, label, value, diagnosticStatus = "neutral") {
  const status = diagnostic(diagnosticStatus);
  const diagnosticText = status === "neutral" ? "" : ` ${status}`;
  return `
    <div class="stat stat-${status}" tabindex="0" data-stat-key="${escapeHtml(key)}" data-stat-label="${escapeHtml(label)}" data-stat-value="${escapeHtml(value)}" data-stat-diagnostic="${escapeHtml(status)}" aria-label="${escapeHtml(`${label}: ${value}${diagnosticText}`)}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
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

globalThis.recordBlueprintDesignerGridSize = recordBlueprintDesignerGridSize;
