// Manages the builder grid, tile placement, connectivity rules, stats previews, and validation indicators.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { PART_DEFS, PART_STATS, isRotatablePart, partIconMarkup, shouldShowRotationMarker } from "../design/parts.js";
import { normalizeRotation } from "../design/rotation.js";
import { isConnected, explainConnectionProblem, isOutOfBounds, isOverlapping } from "../design/blueprintValidation.js";
import { getOccupiedCells, getFootprintBounds, footprintIncludes } from "../design/footprint.js";
import { computeStats } from "../design/componentStats.js";
import { defaultDesign, persistDesign, makeDesignPart } from "../design/blueprintStorage.js";
import { showToast } from "./toastUi.js";
import { renderSavedDesigns, saveCurrentDesign, weaponAbbrevText } from "./savedBlueprintsUi.js";
import { updateEconomyUi } from "./purchaseUi.js";
import { formatHull, formatShield, formatThrust, formatRepair, formatMass, formatSpeed, formatPercent, round2 } from "../design/statFormatting.js";
import { escapeHtml } from "../shared/formatting.js";

const GRID_SIZE = 15;
const thermalAnalysisCache = new Map();

export function renderBuildGrid() {
  dom.grid.textContent = "";
  const heatAnalysis = analyzeDesignHeat(state.design, state.thermalLoadMode || "full");
  const exhaustAnalysis = globalThis.EngineExhaustRules.analyze(state.design, PART_STATS);
  const heatView = state.blueprintView === "heat";
  dom.grid.classList.toggle("heat-overlay-active", heatView);
  dom.blueprintBuildTab?.classList.toggle("active", !heatView);
  dom.blueprintHeatTab?.classList.toggle("active", heatView);
  dom.blueprintBuildTab?.setAttribute("aria-selected", String(!heatView));
  dom.blueprintHeatTab?.setAttribute("aria-selected", String(heatView));
  if (dom.blueprintHeatLegend) dom.blueprintHeatLegend.hidden = !heatView;
  if (dom.thermalLoadModes) {
    dom.thermalLoadModes.hidden = !heatView;
    for (const button of dom.thermalLoadModes.querySelectorAll("[data-thermal-load]")) button.classList.toggle("active", button.dataset.thermalLoad === (state.thermalLoadMode || "full"));
  }
  renderFullLoadThermalPanel(heatView ? analyzeDesignHeat(state.design, "full") : null);

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
      const heatClass = part && heatView ? heatAnalysis.componentClasses.get(part) || "" : "";
      cell.className = `build-cell${part ? ` occupied ${part.type} ${heatClass}` : ""}`;

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

      cell.title = part
        ? `${PART_DEFS[part.type].name}${heatView ? thermalHoverText(heatAnalysis.predictions.get(part)) : ""}${isRotatablePart(part.type) ? ` | ${normalizeRotation(part.rotation)} deg | Select ${PART_DEFS[part.type].name} and click again, or hover and press R to rotate` : ""}`
        : "Empty";
      if (part) {
        const partIndex = state.design.indexOf(part);
        const blockedExhaust = !heatView && exhaustAnalysis.blockedEngineIndices.has(partIndex);
        const rotation = normalizeRotation(part.rotation);
        const rotationMarker = shouldShowRotationMarker(part.type) ? `<span class="rotation-marker rot-${rotation}">&#9650;</span>` : "";
        const prediction = heatAnalysis.predictions.get(part);
        const displayedHeat = Math.max(0, Math.min(100, heatAnalysis.componentHeat.get(part) || 0));
        const overheated = displayedHeat >= 100;
        const heatValue = heatView
          ? `<span class="component-heat-value" aria-label="Heat load ${displayedHeat} percent"><small class="heat-badge-icon" aria-hidden="true">♨</small>${displayedHeat}<small>%</small></span>${overheated ? `<span class="component-overheat-warning" title="Overheated" aria-label="Overheated">▲</span>` : ""}`
          : "";
        const exhaustWarning = blockedExhaust ? `<span class="blocked-exhaust-warning" title="Blocked exhaust — engine provides no thrust." aria-label="Blocked exhaust — engine provides no thrust.">!</span>` : "";
        cell.innerHTML = `${partIconMarkup(part.type, "build-glyph", rotation)}${rotationMarker}${heatValue}${exhaustWarning}`;
        if (blockedExhaust) cell.title = "Blocked exhaust — engine provides no thrust.";
      }
      cell.dataset.x = String(x);
      cell.dataset.y = String(y);
      cell.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        removeCell(x, y);
      });
      dom.grid.appendChild(cell);
    }
  }

  if (heatView && heatAnalysis.flows.length) renderHeatFlows(heatAnalysis);

  if (!dom.grid.dataset.hasDelegatedClick) {
    dom.grid.addEventListener("click", (event) => {
      const cell = event.target.closest(".build-cell");
      if (!cell || !dom.grid.contains(cell)) return;
      editCell(Number(cell.dataset.x), Number(cell.dataset.y));
    });
    // Hover preview is delegated so cells are never rebuilt mid-click:
    // rebuilding on hover destroyed the mousedown target, so no click event fired.
    dom.grid.addEventListener("mouseover", (event) => {
      const cell = event.target.closest(".build-cell");
      if (!cell || !dom.grid.contains(cell)) return;
      const x = Number(cell.dataset.x);
      const y = Number(cell.dataset.y);
      if (state.hoveredCell?.x === x && state.hoveredCell?.y === y) return;
      state.hoveredCell = { x, y };
      renderHoverPreview();
    });
    dom.grid.addEventListener("mouseleave", () => {
      state.hoveredCell = null;
      renderHoverPreview();
    });
    dom.grid.dataset.hasDelegatedClick = "true";
  }

  if (!dom.grid.dataset.hasHeatTabs) {
    dom.blueprintBuildTab?.addEventListener("click", () => {
      state.blueprintView = "build";
      renderBuildGrid();
      renderLocalStats();
    });
    dom.blueprintHeatTab?.addEventListener("click", () => {
      state.blueprintView = "heat";
      renderBuildGrid();
      renderLocalStats();
    });
    dom.thermalLoadModes?.addEventListener("click", event => {
      const button = event.target.closest("[data-thermal-load]");
      if (!button) return;
      state.thermalLoadMode = button.dataset.thermalLoad;
      renderBuildGrid();
      renderLocalStats();
    });
    dom.grid.dataset.hasHeatTabs = "true";
  }

  renderHoverPreview();
}

export function renderHoverPreview() {
  for (const stale of dom.grid.querySelectorAll(".build-preview, .engine-exhaust-preview, .engine-thrust-arrow")) {
    stale.remove();
  }

  if (state.hoveredCell && state.selectedPart) {
    const selectedType = state.selectedPart;
    const existing = findPartAt(state.hoveredCell.x, state.hoveredCell.y);
    let targetX = existing ? existing.x : state.hoveredCell.x;
    let targetY = existing ? existing.y : state.hoveredCell.y;
    let rotation = placementRotation(selectedType, state.previewRotation || 0);

    const stat = PART_STATS[selectedType] || PART_STATS.frame;
    const footprint = stat.footprint || { width: 1, height: 1 };

    // Determine validity
    let isValid = true;
    const candidatePart = makeDesignPart(targetX, targetY, selectedType, rotation);
    rotation = candidatePart.rotation;
    const nextDesign = existing
      ? state.design.map(p => p === existing ? candidatePart : p)
      : [...state.design, candidatePart];

    if (isOutOfBounds(nextDesign) || isOverlapping(nextDesign)) {
      isValid = false;
    } else if (!isConnected(nextDesign)) {
      isValid = false;
    }

    // Draw the preview box from the rotated footprint's top-left bound so it
    // aligns exactly with where the placed part will render.
    const bounds = getFootprintBounds(targetX, targetY, footprint, rotation);

    const preview = document.createElement("div");
    preview.className = `build-preview ${isValid ? "valid" : "invalid"}`;
    preview.innerHTML = partIconMarkup(selectedType, "preview-glyph", rotation);
    positionPreviewOverlay(preview, bounds.minX, bounds.minY, bounds.width, bounds.height);
    dom.grid.appendChild(preview);
    const candidateIndex = nextDesign.indexOf(candidatePart);
    const candidateStat = PART_STATS[selectedType] || {};
    if (candidateStat.thrust > 0) renderEngineExhaustPreview(nextDesign, candidateIndex, isValid);
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
  return isRotatablePart(type) ? normalizeRotation(rotation) : 0;
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

function findPartAt(x, y) {
  for (const part of state.design) {
    const stat = PART_STATS[part.type] || PART_STATS.frame;
    const footprint = stat.footprint || { width: 1, height: 1 };
    if (footprintIncludes(part.x, part.y, footprint, part.rotation || 0, x, y)) {
      return part;
    }
  }
  return null;
}

export function editCell(x, y) {
  const existing = findPartAt(x, y);
  if (existing?.type === "core") return;

  // if clicked on an empty extension cell, target the clicked cell as origin for new part
  let targetX = existing ? existing.x : x;
  let targetY = existing ? existing.y : y;

  state.selectedCell = { x: targetX, y: targetY };

  if (existing) {
    if (existing.type === state.selectedPart) {
      if (isRotatablePart(existing.type)) {
        rotateCell(existing.x, existing.y);
      }
      return;
    }
    const newPart = makeDesignPart(targetX, targetY, state.selectedPart, placementRotation(state.selectedPart, state.previewRotation || 0));
    const next = state.design.map((part) => part === existing ? newPart : part);

    if (isOutOfBounds(next)) {
      setBuildStatus("Outside build grid", "error");
      showToast("Outside build grid", "error");
      return;
    }
    if (isOverlapping(next)) {
      setBuildStatus("Overlaps another component", "error");
      showToast("Overlaps another component", "error");
      return;
    }
    if (!isConnected(next)) {
      const message = explainConnectionProblem(state.design.filter(p => p !== existing), state.selectedPart, targetX, targetY, newPart.rotation);
      setBuildStatus(message, "warning");
      showToast(message, "warning");
      return;
    }
    state.design = next;
  } else {
    const newPart = makeDesignPart(targetX, targetY, state.selectedPart, state.previewRotation || 0);
    const next = [...state.design, newPart];

    if (isOutOfBounds(next)) {
      setBuildStatus("Outside build grid", "error");
      showToast("Outside build grid", "error");
      return;
    }
    if (isOverlapping(next)) {
      setBuildStatus("Overlaps another component", "error");
      showToast("Overlaps another component", "error");
      return;
    }
    if (isConnected(next)) {
      state.design = next;
    } else {
      const message = explainConnectionProblem(state.design, state.selectedPart, targetX, targetY, newPart.rotation);
      setBuildStatus(message, "warning");
      showToast(message, "warning");
      return;
    }
  }

  persistDesign(state.design, state.combatStyle);
  renderBuildGrid();
  renderLocalStats();
  renderSavedDesigns();
}

export function rotateCell(x, y) {
  const part = state.design.find((candidate) => candidate.x === x && candidate.y === y);
  if (!part || !isRotatablePart(part.type)) return false;

  const newRotation = (normalizeRotation(part.rotation) + 90) % 360;
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
    state.previewRotation = (normalizeRotation(state.previewRotation || 0) + 90) % 360;
    renderHoverPreview();
  }
}

export function removeCell(x, y) {
  const existing = findPartAt(x, y);
  if (!existing || existing.type === "core") return;
  const next = state.design.filter((part) => part !== existing);
  if (isConnected(next)) {
    state.design = next;
    persistDesign(state.design, state.combatStyle);
    renderBuildGrid();
    renderLocalStats();
    renderSavedDesigns();
  } else {
    const message = "Removing that part would disconnect modules from the core";
    setBuildStatus(message, "warning");
    showToast(message, "warning");
  }
}

export function resetDesign() {
  state.design = defaultDesign();
  state.loadedEditorBlueprintId = null;
  persistDesign(state.design, state.combatStyle);
  renderBuildGrid();
  renderLocalStats();
  renderSavedDesigns();
}

export function clearDesign() {
  state.design = [];
  state.loadedEditorBlueprintId = null;
  persistDesign(state.design, state.combatStyle);
  renderBuildGrid();
  renderLocalStats();
  renderSavedDesigns();
}

export function renderLocalStats() {
  const stats = computeStats(state.design);
  const heat = analyzeDesignHeat(state.design, state.thermalLoadMode || "full");
  const status = getShipStatus(stats);
  const mine = state.mine;
  const money = currentMatchMoney(mine);
  const canAfford = money >= stats.unitCost;
  
  if (dom.combatStyleSelect) {
    dom.combatStyleSelect.value = state.combatStyle || "charge";
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
    state.blueprintView === "heat" ? `<div class="heat-design-summary"><strong>Thermal layout</strong><span>Cooling: ${heat.cooling}</span><span>Sustained heat: ${heat.sustained}</span><span>Likely hotspot: ${escapeHtml(heat.hotspot)}</span><span>Radiator exposure: ${heat.exposure}</span><span>Est. sustained cooling: ${heat.coolingRate}/s</span><span>Networks: ${heat.networks.length}</span><span>${escapeHtml(heat.routeWarning)}</span><span>${escapeHtml(heat.networkWarning)}</span><span>${escapeHtml(heat.severWarning)}</span></div>` : "",
    statCard("fleet", "Fleet", stats.fleetCount),
    statCard("class", "Class", stats.massClass),
    statCard("hull", "Hull", formatHull(stats.maxHp)),
    statCard("shield", "Shield", formatShield(stats.maxShield)),
    statCard("speed", "Speed", formatSpeed(Math.round(stats.maxSpeed))),
    statCard("turn", "Turn", `${stats.turnRate.toFixed(2)} rad/s`),
    statCard("power", "Power Use/Gen", `${round2(stats.powerUse)}/${round2(stats.powerGeneration)} MW`),
    statCard("thrust", "Effective Thrust", formatThrust(stats.effectiveThrust)),
    statCard("engineEfficiency", "Engine Efficiency", formatPercent(stats.engineEfficiency)),
    statCard("powerEfficiency", "Power Efficiency", formatPercent(stats.powerEfficiency)),
    statCard("powerDebuff", "Power Debuff", stats.powerDebuff > 0 ? `-${formatPercent(stats.powerDebuff)}` : "None"),
    statCard("speedCap", "Mass Drag Limit", formatSpeed(stats.speedCap)),
    statCard("thrustRatio", "Thrust/Mass", `${round2(stats.thrustRatio)} kN/T`),
    statCard("weapons", "Weapons", `${stats.weaponDps} DPS`),
    stats.coolingBonus > 0 ? statCard("cooling", "Cooling", `${formatPercent(stats.coolingBonus)} reload`) : "",
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

function thermalHoverText(prediction) {
  if (!prediction) return "";
  const labels = globalThis.HeatRules.STATE_LABELS;
  const overheat = prediction.timeToOverheat === null ? "stable" : `${prediction.timeToOverheat.toFixed(1)}s to overheat`;
  return `\nHeat: ${Math.min(100, Math.round(prediction.ratio * 100))}% (${prediction.heat.toFixed(1)} / ${prediction.capacity} H)\nState: ${labels[prediction.state]}\nGenerated: +${prediction.generation.toFixed(1)} H/s\nReceived: +${prediction.received.toFixed(1)} H/s\nSent through frame: -${prediction.transferredOut.toFixed(1)} H/s\nCooling: -${prediction.cooling.toFixed(1)} H/s\n${overheat}`;
}

function renderFullLoadThermalPanel(fullLoadResult) {
  const panel = dom.fullLoadThermalPanel;
  if (!panel) return;
  panel.hidden = !fullLoadResult;
  if (!fullLoadResult) return;
  const analysis = fullLoadResult.analysis;
  const tone = analysis.balance.toLowerCase();
  const row = (label, value) => `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
  const seconds = value => value === null ? "Never" : `${value.toFixed(1)} seconds`;
  const equilibrium = analysis.equilibriumTime === null ? "No equilibrium" : `${analysis.equilibriumTime.toFixed(1)} seconds`;
  const reserve = analysis.reserve >= 0 ? `+${analysis.reserve.toFixed(1)} H/s spare cooling` : `${analysis.reserve.toFixed(1)} H/s deficit`;
  panel.innerHTML = `
    <h3>Full Load Thermal Analysis</h3>
    <p>Predicted performance with all major systems operating continuously.</p>
    <div class="thermal-analysis-status ${tone}">${escapeHtml(analysis.balance)}</div>
    <div class="thermal-analysis-rows">
      ${row("Total heat generated", `${analysis.generation.toFixed(1)} H/s`)}
      ${row("Total cooling", `${analysis.cooling.toFixed(1)} H/s`)}
      ${row("Net heat", `${analysis.net >= 0 ? "+" : ""}${analysis.net.toFixed(1)} H/s`)}
      ${row("Thermal balance", analysis.balance)}
      ${row("First overheat", seconds(analysis.firstOverheatTime))}
      ${row("First component", analysis.firstOverheatIndex < 0 ? "None" : describeComponentAt(analysis.firstOverheatIndex, state.design))}
      ${row("Expected to overheat", String(analysis.overheatedCount))}
      ${row("Thermal equilibrium", equilibrium)}
      ${row("Peak component heat", `${Math.round(analysis.peakPredictedHeat * 100)}%`)}
      ${row("Hottest network", analysis.hottestNetwork)}
      ${row("Cooling reserve", reserve)}
      ${row("Weapon uptime", `${Math.round(analysis.weaponUptime * 100)}%`)}
      ${row("Engine efficiency", `${Math.round(analysis.engineEfficiency * 100)}%`)}
      ${row("Shield recharge uptime", `${Math.round(analysis.shieldUptime * 100)}%`)}
      ${row("Radiator utilisation", `${Math.round(analysis.radiatorUtilisation * 100)}%`)}
      ${row("Heat-sink saturation", analysis.heatSinkSaturationTime === null ? "Never" : `${analysis.heatSinkSaturationTime.toFixed(1)} seconds`)}
    </div>`;
}

function renderHeatFlows(analysis) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 15 15");
  svg.classList.add("heat-flow-overlay");
  svg.innerHTML = `<defs><marker id="heat-flow-hot" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="3.5" markerHeight="3.5" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#ff9a3d"/></marker><marker id="heat-flow-cool" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="3.5" markerHeight="3.5" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#67d9ff"/></marker></defs>`;
  const owner = new Map();
  const occupiedByIndex = state.design.map((part, i) => {
    const stat = PART_STATS[part.type] || PART_STATS.frame;
    const occupied = getOccupiedCells(part.x, part.y, stat.footprint || { width:1, height:1 }, part.rotation || 0);
    for (const cell of occupied) owner.set(`${cell.x},${cell.y}`, i);
    return occupied;
  });
  for (const flow of analysis.flows) {
    const from = state.design[flow.from];
    const to = state.design[flow.to];
    if (!from || !to) continue;
    const isFrameFlow = /frame/i.test(from.type) || /frame/i.test(to.type);
    const coolingFlow = to.type === "radiator" || to.type === "heatSink" || (analysis.predictions.get(to)?.ratio || 0) < 0.35;
    for (const cell of occupiedByIndex[flow.from] || []) for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      if (owner.get(`${cell.x + dx},${cell.y + dy}`) !== flow.to) continue;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(cell.x + 0.5 - dx * 0.12)); line.setAttribute("y1", String(cell.y + 0.5 - dy * 0.12));
      line.setAttribute("x2", String(cell.x + 0.5 + dx * 0.72)); line.setAttribute("y2", String(cell.y + 0.5 + dy * 0.72));
      line.setAttribute("marker-end", `url(#${coolingFlow ? "heat-flow-cool" : "heat-flow-hot"})`);
      line.classList.add(isFrameFlow ? "frame-heat-flow" : "component-heat-flow", coolingFlow ? "cooling-heat-flow" : "hot-heat-flow");
      line.style.opacity = String(Math.min(0.9, 0.22 + flow.amount / 10));
      line.style.strokeWidth = String(Math.min(0.13, 0.025 + flow.amount / 100));
      svg.appendChild(line);
    }
  }
  dom.grid.appendChild(svg);
}

function analyzeDesignHeat(design, mode = "full") {
  const rules = globalThis.HeatRules;
  const types = [...new Set(design.map(module => module.type))];
  const thermalSignature = types.map(type => {
    const stat = PART_STATS[type] || {};
    return [type, stat.powerGeneration, stat.thrust, stat.shieldRegen, stat.repairRate, stat.weapon?.damage, stat.weapon?.fireRate].join(":");
  }).join("|");
  const cacheKey = `${mode}|${thermalSignature}|${JSON.stringify(design.map(module => [module.type,module.x,module.y,module.rotation || 0]))}`;
  const cached = thermalAnalysisCache.get(cacheKey);
  if (cached?.design === design) return cached.result;
  const owners = new Map();
  const cells = [];
  for (let i = 0; i < design.length; i += 1) {
    const module = design[i];
    const stat = PART_STATS[module.type] || PART_STATS.frame;
    const occupied = getOccupiedCells(module.x, module.y, stat.footprint || { width: 1, height: 1 }, module.rotation || 0);
    cells[i] = occupied;
    for (const cell of occupied) owners.set(`${cell.x},${cell.y}`, i);
  }
  const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
  const occupiedCoords = [...owners.keys()].map(key => key.split(",").map(Number));
  const exteriorEmpty = new Set();
  if (occupiedCoords.length) {
    const xs = occupiedCoords.map(cell => cell[0]), ys = occupiedCoords.map(cell => cell[1]);
    const minX = Math.min(...xs) - 1, maxX = Math.max(...xs) + 1, minY = Math.min(...ys) - 1, maxY = Math.max(...ys) + 1;
    const queue = [[minX, minY]]; exteriorEmpty.add(`${minX},${minY}`);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const [x,y] = queue[cursor];
      for (const [dx,dy] of dirs) {
        const nx=x+dx, ny=y+dy, key=`${nx},${ny}`;
        if (nx<minX||nx>maxX||ny<minY||ny>maxY||owners.has(key)||exteriorEmpty.has(key)) continue;
        exteriorEmpty.add(key); queue.push([nx,ny]);
      }
    }
  }
  const exposed = design.map(() => 0);
  const exteriorDirections = design.map(() => new Set());
  const edgeMaps = design.map(() => new Map());
  for (let i = 0; i < design.length; i += 1) for (const cell of cells[i]) for (const [dx,dy] of dirs) {
    const neighbour = owners.get(`${cell.x + dx},${cell.y + dy}`);
    if (neighbour === undefined && exteriorEmpty.has(`${cell.x + dx},${cell.y + dy}`)) {
      exposed[i] += 1;
      exteriorDirections[i].add(dx < 0 ? "left" : dx > 0 ? "right" : dy < 0 ? "top" : "bottom");
    }
    else if (neighbour !== undefined && neighbour !== i) edgeMaps[i].set(neighbour, (edgeMaps[i].get(neighbour) || 0) + 1);
  }
  const profiles = design.map((module, i) => {
    const value = { ...rules.profile(module.type, PART_STATS[module.type] || {}), exposedEdges: exposed[i] };
    value.capacity += [...edgeMaps[i].keys()].filter(j => design[j].type === "heatSink").length * 35;
    return value;
  });
  const edges = [];
  for (let i = 0; i < design.length; i += 1) for (const [j, sharedEdges] of edgeMaps[i]) if (j > i) {
    edges.push({ i, j, sharedEdges, conductivity: rules.edgeConductivity(profiles[i], profiles[j]) });
  }
  const loadMultiplier = (module, stat) => {
    if (mode === "idle") return (stat.powerGeneration || 0) > 0 ? 0.2 : (stat.shieldRegen || 0) > 0 ? 0.08 : 0;
    if (mode === "combat") {
      if (stat.weapon) return 0.72;
      if ((stat.thrust || 0) > 0) return 0.55;
      if ((stat.shieldRegen || 0) > 0) return 0.65;
      if ((stat.powerGeneration || 0) > 0) return 0.78;
      if ((stat.repairRate || 0) > 0) return 0.45;
      return 0.25;
    }
    return 1;
  };
  const designExhaust = globalThis.EngineExhaustRules.analyze(design, PART_STATS);
  const generationRates = design.map((module, index) => {
    const stat = PART_STATS[module.type] || {};
    if ((stat.thrust || 0) > 0 && !designExhaust.validEngineIndices.has(index)) return 0;
    return rules.activityHeat(module.type, stat) * loadMultiplier(module, stat);
  });
  const isFrame = type => /frame/i.test(String(type || ""));
  const frameCoolingDistance = design.map(() => Infinity);
  const coolingFrames = [];
  for (let i = 0; i < design.length; i += 1) {
    if (!isFrame(design[i].type)) continue;
    if ([...edgeMaps[i].keys()].some(j => design[j].type === "radiator" || design[j].type === "heatSink")) {
      frameCoolingDistance[i] = 0; coolingFrames.push(i);
    }
  }
  for (let cursor = 0; cursor < coolingFrames.length; cursor += 1) {
    const frame = coolingFrames[cursor];
    for (const neighbour of edgeMaps[frame].keys()) {
      if (!isFrame(design[neighbour].type) || frameCoolingDistance[neighbour] <= frameCoolingDistance[frame] + 1) continue;
      frameCoolingDistance[neighbour] = frameCoolingDistance[frame] + 1; coolingFrames.push(neighbour);
    }
  }
  const heat = design.map(() => 0);
  const states = design.map(() => rules.STATE.NORMAL);
  const received = design.map(() => 0);
  const transferredOut = design.map(() => 0);
  const cooling = design.map(() => 0);
  const timeToOverheat = design.map(() => null);
  const peakRatios = design.map(() => 0);
  const overheatedIndices = new Set();
  const uptimeTicks = { weapon: 0, engine: 0, shield: 0 };
  const uptimeTotals = { weapon: 0, engine: 0, shield: 0 };
  let firstOverheatTime = null;
  let firstOverheatIndex = -1;
  let equilibriumTime = null;
  let equilibriumTicks = 0;
  let previousTotalHeat = 0;
  let heatSinkSaturationTime = null;
  let radiatorRemovedTotal = 0;
  let simulatedSeconds = 0;
  let finalFlows = [];
  const dt = rules.TICK_SECONDS;
  for (let step = 0; step < 1500; step += 1) {
    simulatedSeconds = (step + 1) * dt;
    const delta = design.map(() => 0);
    received.fill(0); transferredOut.fill(0); cooling.fill(0);
    for (let i = 0; i < design.length; i += 1) {
      const performance = rules.performanceForState(states[i]);
      delta[i] += generationRates[i] * performance * dt;
      const stat = PART_STATS[design[i].type] || {};
      const category = stat.weapon ? "weapon" : (stat.thrust || 0) > 0 ? "engine" : (stat.shieldRegen || 0) > 0 ? "shield" : null;
      if (category) { uptimeTicks[category] += performance; uptimeTotals[category] += 1; }
    }
    const workingHeat = heat.map((value, i) => Math.max(0, value + delta[i]));
    finalFlows = [];
    for (const edge of edges) {
      const frameI = isFrame(design[edge.i].type), frameJ = isFrame(design[edge.j].type);
      const routedI = Number.isFinite(frameCoolingDistance[edge.i]), routedJ = Number.isFinite(frameCoolingDistance[edge.j]);
      let conductivity = edge.conductivity;
      if (frameI && frameJ && (routedI || routedJ)) conductivity *= rules.NETWORK_FRAME_BOOST;
      else if ((frameI && routedI) || (frameJ && routedJ)) conductivity *= rules.NETWORK_ATTACHMENT_BOOST;
      const amount = rules.edgeTransfer(workingHeat[edge.i], profiles[edge.i].capacity, workingHeat[edge.j], profiles[edge.j].capacity, conductivity, edge.sharedEdges, dt);
      delta[edge.i] -= amount; delta[edge.j] += amount;
      if (amount > 0) { transferredOut[edge.i] += amount; received[edge.j] += amount; }
      else { received[edge.i] -= amount; transferredOut[edge.j] -= amount; }
      if (Math.abs(amount) / dt >= 0.35) finalFlows.push({ from: amount > 0 ? edge.i : edge.j, to: amount > 0 ? edge.j : edge.i, amount: Math.abs(amount) / dt });
    }
    for (let i = 0; i < design.length; i += 1) {
      let coolingRate = profiles[i].cooling * profiles[i].retention;
      if (design[i].type === "radiator") coolingRate *= exposed[i] > 0 ? 1 : 0.25;
      else if (exposed[i] > 0) coolingRate *= 1.12;
      cooling[i] = Math.min(Math.max(0, heat[i] + delta[i]), coolingRate * dt);
      if (design[i].type === "radiator") radiatorRemovedTotal += cooling[i];
      delta[i] -= cooling[i];
    }
    for (let i = 0; i < design.length; i += 1) {
      heat[i] = Math.max(0, Math.min(profiles[i].capacity * 1.25, heat[i] + delta[i]));
      states[i] = rules.stateFor(heat[i] / profiles[i].capacity, states[i]);
      const ratio = heat[i] / profiles[i].capacity;
      peakRatios[i] = Math.max(peakRatios[i], ratio);
      if (states[i] === rules.STATE.OVERHEATED) {
        overheatedIndices.add(i);
        if (timeToOverheat[i] === null) timeToOverheat[i] = (step + 1) * dt;
        if (firstOverheatTime === null) { firstOverheatTime = (step + 1) * dt; firstOverheatIndex = i; }
      }
      if (design[i].type === "heatSink" && ratio >= .9 && heatSinkSaturationTime === null) heatSinkSaturationTime = (step + 1) * dt;
    }
    const totalHeatNow = heat.reduce((sum, value) => sum + value, 0);
    const changePerSecond = Math.abs(totalHeatNow - previousTotalHeat) / dt;
    equilibriumTicks = step > 20 && changePerSecond < 0.04 && !overheatedIndices.size ? equilibriumTicks + 1 : 0;
    if (equilibriumTime === null && equilibriumTicks >= 50) equilibriumTime = (step + 1) * dt;
    previousTotalHeat = totalHeatNow;
    if (equilibriumTime !== null && step * dt > equilibriumTime + 5) break;
  }

  const predictions = new Map();
  for (let i = 0; i < design.length; i += 1) predictions.set(design[i], {
    heat: peakRatios[i] * profiles[i].capacity, capacity: profiles[i].capacity, ratio: peakRatios[i],
    generation: generationRates[i], received: received[i] / dt, transferredOut: transferredOut[i] / dt,
    cooling: cooling[i] / dt, state: rules.stateFor(peakRatios[i], rules.STATE.NORMAL), timeToOverheat: timeToOverheat[i]
  });
  const hottestIndex = peakRatios.reduce((best, value, i) => value > peakRatios[best] ? i : best, 0);
  const frameSet = new Set(design.map((module, i) => isFrame(module.type) ? i : -1).filter(i => i >= 0));
  const frameVisited = new Set();
  const networks = [];
  const componentNetwork = design.map(() => []);
  for (const start of frameSet) {
    if (frameVisited.has(start)) continue;
    const frameIndices = [], attached = new Set(), queue = [start]; frameVisited.add(start);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor]; frameIndices.push(index);
      for (const neighbour of edgeMaps[index].keys()) {
        if (frameSet.has(neighbour)) { if (!frameVisited.has(neighbour)) { frameVisited.add(neighbour); queue.push(neighbour); } }
        else attached.add(neighbour);
      }
    }
    const generators = [...attached].filter(i => generationRates[i] > 0);
    const coolers = [...attached].filter(i => design[i].type === "heatSink" || design[i].type === "radiator");
    const id = networks.length;
    for (const index of [...frameIndices, ...attached]) componentNetwork[index].push(id);
    const networkGeneration = generators.reduce((sum, i) => sum + generationRates[i], 0);
    const networkCooling = coolers.reduce((sum, i) => sum + profiles[i].cooling * (design[i].type === "radiator" && !exposed[i] ? .25 : 1), 0);
    networks.push({ id, frameIndices, attached: [...attached], generators, coolers, generation: networkGeneration, cooling: networkCooling, overloaded: networkGeneration > networkCooling, isolated: generators.length > 0 && coolers.length === 0 });
  }
  function generatorHasCoolingRoute(generator, removedFrame = -1) {
    const starts = [...edgeMaps[generator].keys()].filter(i => frameSet.has(i) && i !== removedFrame);
    const seen = new Set(starts), queue = starts.slice();
    for (let cursor = 0; cursor < queue.length; cursor += 1) for (const neighbour of edgeMaps[queue[cursor]].keys()) {
      if (frameSet.has(neighbour) && neighbour !== removedFrame && !seen.has(neighbour)) { seen.add(neighbour); queue.push(neighbour); }
    }
    return [...seen].some(frame => [...edgeMaps[frame].keys()].some(i => i !== generator && (design[i].type === "heatSink" || design[i].type === "radiator")));
  }
  const routedGenerators = generationRates.map((rate, i) => rate > 0 && generatorHasCoolingRoute(i));
  const criticalFrames = new Set();
  for (const frame of frameSet) {
    if (generationRates.some((rate, i) => rate > 0 && routedGenerators[i] && !generatorHasCoolingRoute(i, frame))) criticalFrames.add(frame);
  }
  const unroutedHot = generationRates.map((rate, i) => rate > 0 && !routedGenerators[i] && peakRatios[i] >= rules.THRESHOLDS.hot ? i : -1).filter(i => i >= 0);
  const componentClasses = new Map(design.map((module, i) => {
    const percent = Math.max(0, Math.min(100, Math.round(peakRatios[i] * 100)));
    const stateClass = percent >= 100 ? "heat-ui-overheated" : percent >= 76 ? "heat-ui-critical" : percent >= 51 ? "heat-ui-hot" : percent >= 26 ? "heat-ui-warm" : "heat-ui-cool";
    const network = componentNetwork[i].length ? networks[componentNetwork[i][0]] : null;
    const networkClass = network ? `thermal-network-${network.id % 4}` : "";
    const frameLoad = isFrame(module.type) ? (peakRatios[i] >= .76 ? " thermal-frame-heavy" : peakRatios[i] >= .26 ? " thermal-frame-moderate" : " thermal-frame-cool") : "";
    const broken = isFrame(module.type) && (network?.isolated || criticalFrames.has(i)) ? " thermal-route-broken" : "";
    const coolingEffect = module.type === "heatSink" ? " heat-sink-absorption" : module.type === "radiator" && exposed[i] ? ` radiator-exposed radiator-exposed-${[...exteriorDirections[i]][0] || "right"}` : "";
    return [module, `${stateClass} ${networkClass}${frameLoad}${broken}${coolingEffect}`.trim()];
  }));
  const componentHeat = new Map(design.map((module, i) => [module, Math.round(peakRatios[i] * 100)]));
  const generation = generationRates.reduce((sum, value) => sum + value, 0);
  const coolingRate = profiles.reduce((sum, item, i) => sum + item.cooling * (design[i].type === "radiator" && !exposed[i] ? 0.25 : 1), 0);
  let radiators = 0;
  let exposedRadiators = 0;
  design.forEach((module, i) => { if (module.type === "radiator") { radiators += 1; if (exposed[i]) exposedRadiators += 1; } });
  const peakPredictedHeat = peakRatios.length ? Math.max(...peakRatios) : 0;
  const reserve = coolingRate - generation;
  const balance = overheatedIndices.size ? "Unsustainable" : equilibriumTime !== null && peakPredictedHeat < .76 ? "Stable" : "Marginal";
  const hottestNetwork = networks.length ? networks.reduce((best, network) => {
    const members = [...network.frameIndices, ...network.attached];
    const score = members.length ? Math.max(...members.map(i => peakRatios[i] || 0)) : 0;
    return !best || score > best.score ? { network, score } : best;
  }, null) : null;
  const radiatorCapacitySeconds = design.reduce((sum, module, i) => module.type === "radiator" ? sum + profiles[i].cooling * (exposed[i] ? 1 : .25) * simulatedSeconds : sum, 0);
  const result = {
    componentClasses, componentHeat, predictions, flows: finalFlows, networks, criticalFrames, exteriorDirections,
    cooling: coolingRate >= generation * .7 ? "Good" : coolingRate >= generation * .4 ? "Fair" : "Poor",
    sustained: generation > coolingRate * 1.8 ? "High" : generation > coolingRate ? "Moderate" : "Low",
    hotspot: design[hottestIndex] ? `${PART_DEFS[design[hottestIndex].type]?.name || design[hottestIndex].type} cluster` : "None",
    exposure: !radiators ? "None" : exposedRadiators === radiators ? "Good" : exposedRadiators ? "Fair" : "Poor",
    coolingRate: coolingRate.toFixed(1),
    routeWarning: unroutedHot.length ? `${unroutedHot.length} hot component${unroutedHot.length === 1 ? " has" : "s have"} no frame route to cooling` : "All hot systems have a cooling route",
    networkWarning: networks.some(network => network.overloaded) ? `${networks.filter(network => network.overloaded).length} thermal network overloaded` : "Thermal networks within capacity",
    severWarning: criticalFrames.size ? `${criticalFrames.size} frame block${criticalFrames.size === 1 ? "" : "s"} could sever cooling` : "No single-frame cooling bottleneck",
    analysis: {
      mode, generation, cooling: coolingRate, net: generation - coolingRate, balance,
      firstOverheatTime, firstOverheatIndex, overheatedCount: overheatedIndices.size,
      equilibriumTime, peakPredictedHeat, reserve,
      hottestNetwork: hottestNetwork ? describeThermalNetwork(hottestNetwork.network, design) : "No frame network",
      weaponUptime: uptimeTotals.weapon ? uptimeTicks.weapon / uptimeTotals.weapon : 1,
      engineEfficiency: uptimeTotals.engine ? uptimeTicks.engine / uptimeTotals.engine : 1,
      shieldUptime: uptimeTotals.shield ? uptimeTicks.shield / uptimeTotals.shield : 1,
      radiatorUtilisation: radiatorCapacitySeconds > 0 ? Math.min(1, radiatorRemovedTotal / radiatorCapacitySeconds) : 0,
      heatSinkSaturationTime
    }
  };
  if (thermalAnalysisCache.size > 24) thermalAnalysisCache.clear();
  thermalAnalysisCache.set(cacheKey, { design, result });
  return result;
}

function describeComponentAt(index, design) {
  const module = design[index];
  if (!module) return "None";
  const sameType = design.filter(candidate => candidate.type === module.type);
  const name = PART_DEFS[module.type]?.name || module.type;
  if (sameType.length < 2) return name;
  const horizontal = module.x < 7 ? "Left" : module.x > 7 ? "Right" : "Centre";
  const vertical = module.y < 7 ? "Forward" : module.y > 7 ? "Aft" : "Midship";
  return `${horizontal === "Centre" ? vertical : horizontal} ${name}`;
}

function describeThermalNetwork(network, design) {
  const generators = network.generators.map(index => design[index]);
  if (!generators.length) return `Thermal network ${network.id + 1}`;
  const averageY = generators.reduce((sum, module) => sum + module.y, 0) / generators.length;
  const region = averageY < 6.5 ? "Forward" : averageY > 7.5 ? "Aft" : "Midship";
  const weaponCount = generators.filter(module => PART_STATS[module.type]?.weapon).length;
  const engineCount = generators.filter(module => (PART_STATS[module.type]?.thrust || 0) > 0).length;
  return `${region} ${weaponCount >= engineCount ? "weapon" : "engine"} cluster`;
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
  const hasCore = state.design.filter((part) => part.type === "core").length === 1;

  if (!state.design.length) blockers.push("Invalid design: blueprint is empty.");
  if (!hasCore) blockers.push("Invalid design: missing core.");
  if (!isConnected(state.design)) blockers.push("Invalid design: disconnected parts.");
  if (stats.thrust <= 0) blockers.push("Invalid design: add at least one engine.");
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
        desc: "Total structural health of the ship. Hull damage reduces this value. At 0 HP the ship is destroyed.",
        formula: "MaxHp = Max(140, Round(RawHP * 0.82))",
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
        desc: "Shield barrier capacity. Shields absorb 95% of incoming blocked damage, leaking 5% to the hull. Shield generators and batteries increase this.",
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
        desc: "Maximum turning and orientation rate. Faster turning ships lock onto and track quick targets better.",
        formula: "TurnRate = SoftCap(RawTurn, TurnCap, 0.2)",
        breakdown: `Effective Turn Modifier: ${stats.turnRate.toFixed(2)} rad/s (${Math.round(stats.turnRate * (180 / Math.PI))} deg/s)
Mass Turn Cap Limit: ${stats.turnCap.toFixed(2)} rad/s`
      };

    case "power": {
      const surplus = stats.powerGeneration - stats.powerUse;
      return {
        label: "Reactor Power Balance",
        desc: "Generated energy compared to power consumed by active thrusters, shields, and weapons.",
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

    case "powerDebuff":
      return {
        label: "Power Grid Brownout Penalty",
        desc: "Active penalty to ship movement when reactor power generation falls short of active power draw.",
        formula: "MovementPowerPenalty = Max(0, 1 - PowerMultiplier)",
        breakdown: `Power Penalty: ${stats.powerDebuff > 0 ? ("-" + Math.round(stats.powerDebuff * 100) + "%") : "None"}`
      };

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

    case "cooling":
      return {
        label: "Heat Sink Cooling Speedup",
        desc: "Active reload recovery rate for all equipped weapons.",
        formula: "Reload speedup = Sum of Heat Sink values",
        breakdown: `Reload recovery rate: ${Math.round(stats.coolingBonus * 100)}%`
      };

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
