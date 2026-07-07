// Manages the builder grid, tile placement, connectivity rules, stats previews, and validation indicators.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { PART_DEFS, PART_STATS, isRotatablePart, partIconMarkup } from "../design/parts.js";
import { normalizeRotation } from "../design/rotation.js";
import { isConnected, explainConnectionProblem } from "../design/blueprintValidation.js";
import { computeStats } from "../design/componentStats.js";
import { defaultDesign, persistDesign, makeDesignPart } from "../design/blueprintStorage.js";
import { showToast } from "./toastUi.js";
import { renderSavedDesigns, saveCurrentDesign, weaponAbbrevText } from "./savedBlueprintsUi.js";
import { updateEconomyUi } from "./purchaseUi.js";
import { formatHull, formatShield, formatThrust, formatRepair, formatMass, formatSpeed, formatPercent } from "../design/statFormatting.js";
import { escapeHtml } from "../shared/formatting.js";


export function renderBuildGrid() {
  dom.grid.textContent = "";
  const byCell = new Map(state.design.map((part) => [`${part.x},${part.y}`, part]));

  for (let y = 0; y < 7; y += 1) {
    for (let x = 0; x < 7; x += 1) {
      const part = byCell.get(`${x},${y}`);
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = `build-cell${part ? ` occupied ${part.type}` : ""}`;
      cell.title = part
        ? `${PART_DEFS[part.type].name}${isRotatablePart(part.type) ? ` | ${normalizeRotation(part.rotation)} deg | Select ${PART_DEFS[part.type].name} and click again, or hover and press R to rotate` : ""}`
        : "Empty";
      if (part) {
        cell.innerHTML = `${partIconMarkup(part.type, "build-glyph")}${isRotatablePart(part.type) ? `<span class="rotation-marker rot-${normalizeRotation(part.rotation)}">&#9650;</span>` : ""}`;
      }
      cell.addEventListener("mouseenter", () => {
        state.hoveredCell = { x, y };
      });
      cell.addEventListener("mouseleave", () => {
        if (state.hoveredCell?.x === x && state.hoveredCell?.y === y) state.hoveredCell = null;
      });
      cell.addEventListener("click", () => editCell(x, y));
      cell.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        removeCell(x, y);
      });
      dom.grid.appendChild(cell);
    }
  }
}

export function editCell(x, y) {
  const existing = state.design.find((part) => part.x === x && part.y === y);
  if (existing?.type === "core") return;
  state.selectedCell = { x, y };

  if (existing) {
    if (existing.type === state.selectedPart) {
      if (isRotatablePart(existing.type)) {
        rotateCell(x, y);
      }
      // Same type, not rotatable: nothing to do
      return;
    }
    // Replacing a part keeps the same grid position so connectivity is always preserved
    state.design = state.design.map((part) => part.x === x && part.y === y ? makeDesignPart(x, y, state.selectedPart, part.rotation) : part);
  } else {
    const next = [...state.design, makeDesignPart(x, y, state.selectedPart)];
    if (isConnected(next)) {
      state.design = next;
    } else {
      const message = explainConnectionProblem(state.design, x, y);
      setBuildStatus(message, "warning");
      showToast(message, "warning");
      return;
    }
  }

  persistDesign(state.design);
  renderBuildGrid();
  renderLocalStats();
  renderSavedDesigns();
}

export function rotateCell(x, y) {
  const part = state.design.find((candidate) => candidate.x === x && candidate.y === y);
  if (!part || !isRotatablePart(part.type)) return false;
  state.design = state.design.map((candidate) => candidate === part
    ? { ...candidate, rotation: (normalizeRotation(candidate.rotation) + 90) % 360 }
    : candidate);
  persistDesign(state.design);
  renderBuildGrid();
  renderLocalStats();
  renderSavedDesigns();
  return true;
}

export function rotateFocusedPart() {
  const cell = state.hoveredCell || state.selectedCell;
  if (!cell) return;
  rotateCell(cell.x, cell.y);
}

export function removeCell(x, y) {
  const existing = state.design.find((part) => part.x === x && part.y === y);
  if (!existing || existing.type === "core") return;
  const next = state.design.filter((part) => part.x !== x || part.y !== y);
  if (isConnected(next)) {
    state.design = next;
    persistDesign(state.design);
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
  persistDesign(state.design);
  renderBuildGrid();
  renderLocalStats();
  renderSavedDesigns();
}

export function renderLocalStats() {
  const stats = computeStats(state.design);
  const status = getShipStatus(stats);
  const mine = state.snapshot?.players?.find((player) => player.id === state.myId);
  const money = currentMatchMoney(mine);
  const canAfford = money >= stats.unitCost;

  if (dom.saveDesignButton) {
    const existing = state.savedDesigns.find((design) => design.id === state.loadedEditorBlueprintId);
    dom.saveDesignButton.textContent = existing ? `Update "${existing.name}"` : "Save Blueprint";
  }
  if (dom.blueprintCostLabel) dom.blueprintCostLabel.textContent = `$${stats.unitCost}`;
  if (dom.blueprintCostStatus) {
    dom.blueprintCostStatus.textContent = canAfford
      ? `Remaining after first ship $${Math.floor(money - stats.unitCost)}`
      : `Need $${Math.ceil(stats.unitCost - money)} before first ship`;
    dom.blueprintCostStatus.className = canAfford ? "affordable" : "expensive";
  }
  dom.stats.innerHTML = [
    statMarkup("Fleet", stats.fleetCount),
    statMarkup("Class", stats.massClass),
    statMarkup("Hull", formatHull(stats.maxHp)),
    statMarkup("Shield", formatShield(stats.maxShield)),
    statMarkup("Speed", formatSpeed(Math.round(stats.maxSpeed))),
    statMarkup("Turn", `${stats.turnRate.toFixed(2)} rad/s`),
    statMarkup("Power Use/Gen", `${stats.powerUse}/${stats.powerGeneration} MW`),
    statMarkup("Effective Thrust", formatThrust(stats.effectiveThrust)),
    statMarkup("Engine Efficiency", formatPercent(stats.engineEfficiency)),
    statMarkup("Power Efficiency", formatPercent(stats.powerEfficiency)),
    statMarkup("Power Debuff", stats.powerDebuff > 0 ? `-${formatPercent(stats.powerDebuff)}` : "None"),
    statMarkup("Mass Speed Cap", formatSpeed(stats.speedCap)),
    statMarkup("Thrust/Mass", `${stats.thrustRatio} kN/T`),
    statMarkup("Weapons", weaponAbbrevText(stats)),
    stats.coolingBonus > 0 ? statMarkup("Cooling", `${formatPercent(stats.coolingBonus)} reload`) : "",
    stats.captureBonus > 0 ? statMarkup("Capture", `+${formatPercent(stats.captureBonus)}`) : "",
    statMarkup("Repair", formatRepair(stats.repairRate)),
    statMarkup("Mass", formatMass(stats.mass)),
    costBreakdownMarkup(stats.costBreakdown)
  ].join("");

  renderShipIssues(status);
  setBuildStatus(status.blockers.length ? status.blockers[0] : stats.warnings.length ? stats.warnings[0] : "Blueprint ready", status.blockers.length ? "error" : stats.warnings.length ? "warning" : "good");
  updateEconomyUi();
}

export function getShipStatus(stats) {
  const mine = state.snapshot?.players?.find((player) => player.id === state.myId);
  const blockers = [];
  const money = currentMatchMoney(mine);
  const isActiveBuild = state.phase === "active";
  const hasCore = state.design.filter((part) => part.type === "core").length === 1;

  if (!state.design.length) blockers.push("Invalid design: blueprint is empty.");
  if (!hasCore) blockers.push("Invalid design: missing core.");
  if (!isConnected(state.design)) blockers.push("Invalid design: disconnected parts.");
  if (money < stats.unitCost) blockers.push(`${isActiveBuild ? "Cannot afford ship" : "Cannot ready design"}. Need $${Math.ceil(stats.unitCost - money)} more.`);

  const warnings = [...stats.warnings];
  if (money > 0 && stats.unitCost > money * 0.75) warnings.push("High cost for current money.");
  if (stats.maxShield < 35 && stats.maxHp < 210) warnings.push("Weak defence: low combined hull and shield.");

  return { blockers, warnings };
}

export function renderShipIssues(status) {
  if (!dom.shipIssuesPanel) return;
  const isDesignStage = state.phase === "design";
  const stateText = status.blockers.length
    ? isDesignStage ? "Cannot Ready" : "Cannot Build"
    : status.warnings.length
      ? isDesignStage ? "Ready, with warnings" : "Ready to Build, with warnings"
      : isDesignStage ? "Ready" : "Ready to Build";
  dom.shipIssuesPanel.className = `ship-issues-panel ${status.blockers.length ? "blocked" : status.warnings.length ? "warning" : "ready"}`;
  dom.shipIssuesPanel.innerHTML = `
    <div class="ship-issues-title"><span>Ship Status</span><strong>${stateText}</strong></div>
    ${issueListMarkup("Blocking Issues", status.blockers)}
    ${issueListMarkup("Warnings", status.warnings)}
  `;
}

function currentMatchMoney(mine) {
  return mine ? Number(mine.money) || 0 : state.rules.startingMoney;
}

function issueListMarkup(title, issues) {
  if (!issues.length) return `<div class="issue-group empty"><span>${title}</span><p>None</p></div>`;
  return `
    <div class="issue-group">
      <span>${title}</span>
      <ul>${issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("")}</ul>
    </div>
  `;
}

export function setBuildStatus(text, className) {
  if (!dom.buildStatus) return;
  dom.buildStatus.textContent = text;
  dom.buildStatus.className = `build-status ${className || ""}`.trim();
}

function statMarkup(label, value) {
  return `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`;
}

function costBreakdownMarkup(breakdown) {
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
    <details class="stat cost-breakdown">
      <summary>
        <span>Cost Breakdown</span>
        <strong>$${breakdown.total}</strong>
      </summary>
      <div class="cost-breakdown-grid">
        ${rows.map(([label, value]) => `
          <div>
            <span>${label}</span>
            <strong>$${value}</strong>
          </div>
        `).join("")}
      </div>
    </details>
  `;
}
