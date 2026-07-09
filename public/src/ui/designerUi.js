// Manages the builder grid, tile placement, connectivity rules, stats previews, and validation indicators.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { PART_DEFS, PART_STATS, isRotatablePart, partIconMarkup } from "../design/parts.js";
import { normalizeRotation } from "../design/rotation.js";
import { isConnected, explainConnectionProblem, isOutOfBounds, isOverlapping } from "../design/blueprintValidation.js";
import { getOccupiedCells, footprintIncludes } from "../design/footprint.js";
import { computeStats } from "../design/componentStats.js";
import { defaultDesign, persistDesign, makeDesignPart } from "../design/blueprintStorage.js";
import { showToast } from "./toastUi.js";
import { renderSavedDesigns, saveCurrentDesign, weaponAbbrevText } from "./savedBlueprintsUi.js";
import { updateEconomyUi } from "./purchaseUi.js";
import { formatHull, formatShield, formatThrust, formatRepair, formatMass, formatSpeed, formatPercent, round2 } from "../design/statFormatting.js";
import { escapeHtml } from "../shared/formatting.js";


export function renderBuildGrid() {
  dom.grid.textContent = "";

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

  for (let y = 0; y < 15; y += 1) {
    for (let x = 0; x < 15; x += 1) {
      const isCovered = coveredCells.has(`${x},${y}`);
      if (isCovered) continue; // Skip rendering separate cell for extensions

      const part = byCell.get(`${x},${y}`);
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = `build-cell${part ? ` occupied ${part.type}` : ""}`;

      let width = 1;
      let height = 1;

      if (part) {
        const stat = PART_STATS[part.type] || PART_STATS.frame;
        const footprint = stat.footprint || { width: 1, height: 1 };
        const rotation = normalizeRotation(part.rotation || 0);
        const isRotated = rotation === 90 || rotation === 270;
        width = isRotated ? footprint.height : footprint.width;
        height = isRotated ? footprint.width : footprint.height;
      }

      // We position using 1-based indexing for CSS grid lines
      cell.style.gridColumn = `${x + 1} / span ${width}`;
      cell.style.gridRow = `${y + 1} / span ${height}`;

      cell.title = part
        ? `${PART_DEFS[part.type].name}${isRotatablePart(part.type) ? ` | ${normalizeRotation(part.rotation)} deg | Select ${PART_DEFS[part.type].name} and click again, or hover and press R to rotate` : ""}`
        : "Empty";
      if (part) {
        cell.innerHTML = `${partIconMarkup(part.type, "build-glyph")}${isRotatablePart(part.type) ? `<span class="rotation-marker rot-${normalizeRotation(part.rotation)}">&#9650;</span>` : ""}`;
      }
      cell.addEventListener("mouseenter", () => {
        state.hoveredCell = { x, y };
        renderBuildGrid(); // Re-render to show hover preview
      });
      cell.addEventListener("mouseleave", () => {
        if (state.hoveredCell?.x === x && state.hoveredCell?.y === y) {
          state.hoveredCell = null;
          renderBuildGrid(); // Re-render to remove hover preview
        }
      });
      cell.addEventListener("click", () => editCell(x, y));
      cell.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        removeCell(x, y);
      });
      dom.grid.appendChild(cell);
    }
  }

  // Draw hover preview
  if (state.hoveredCell && state.selectedPart) {
    const existing = findPartAt(state.hoveredCell.x, state.hoveredCell.y);
    let targetX = existing ? existing.x : state.hoveredCell.x;
    let targetY = existing ? existing.y : state.hoveredCell.y;
    let rotation = existing ? existing.rotation : (state.previewRotation || 0);

    // If we're hovering over a part of the same type and it's rotatable, preview the next rotation
    if (existing && existing.type === state.selectedPart && isRotatablePart(existing.type)) {
      rotation = (normalizeRotation(rotation) + 90) % 360;
    }

    const stat = PART_STATS[state.selectedPart] || PART_STATS.frame;
    const footprint = stat.footprint || { width: 1, height: 1 };
    const isRotated = rotation === 90 || rotation === 270;
    const width = isRotated ? footprint.height : footprint.width;
    const height = isRotated ? footprint.width : footprint.height;

    // Determine validity
    let isValid = true;
    const candidatePart = makeDesignPart(targetX, targetY, state.selectedPart, rotation);
    const nextDesign = existing
      ? state.design.map(p => p === existing ? candidatePart : p)
      : [...state.design, candidatePart];

    if (isOutOfBounds(nextDesign) || isOverlapping(nextDesign)) {
      isValid = false;
    } else if (!isConnected(nextDesign)) {
      isValid = false;
    }

    const preview = document.createElement("div");
    preview.className = `build-preview ${isValid ? "valid" : "invalid"}`;
    preview.style.gridColumn = `${targetX + 1} / span ${width}`;
    preview.style.gridRow = `${targetY + 1} / span ${height}`;
    dom.grid.appendChild(preview);
  }
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
    const newPart = makeDesignPart(targetX, targetY, state.selectedPart, isRotatablePart(state.selectedPart) ? (state.previewRotation || 0) : existing.rotation);
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
  persistDesign(state.design, state.combatStyle);
  renderBuildGrid();
  renderLocalStats();
  renderSavedDesigns();
  return true;
}

export function rotateFocusedPart() {
  const cell = state.hoveredCell || state.selectedCell;
  if (!cell) return;
  const part = findPartAt(cell.x, cell.y);
  if (part) {
    rotateCell(part.x, part.y);
  } else if (state.hoveredCell && state.selectedPart) {
    state.previewRotation = (normalizeRotation(state.previewRotation || 0) + 90) % 360;
    renderBuildGrid();
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
  dom.stats.innerHTML = [
    statMarkup("fleet", "Fleet", stats.fleetCount),
    statMarkup("class", "Class", stats.massClass),
    statMarkup("hull", "Hull", formatHull(stats.maxHp)),
    statMarkup("shield", "Shield", formatShield(stats.maxShield)),
    statMarkup("speed", "Speed", formatSpeed(Math.round(stats.maxSpeed))),
    statMarkup("turn", "Turn", `${stats.turnRate.toFixed(2)} rad/s`),
    statMarkup("power", "Power Use/Gen", `${round2(stats.powerUse)}/${round2(stats.powerGeneration)} MW`),
    statMarkup("thrust", "Effective Thrust", formatThrust(stats.effectiveThrust)),
    statMarkup("engineEfficiency", "Engine Efficiency", formatPercent(stats.engineEfficiency)),
    statMarkup("powerEfficiency", "Power Efficiency", formatPercent(stats.powerEfficiency)),
    statMarkup("powerDebuff", "Power Debuff", stats.powerDebuff > 0 ? `-${formatPercent(stats.powerDebuff)}` : "None"),
    statMarkup("speedCap", "Mass Drag Limit", formatSpeed(stats.speedCap)),
    statMarkup("thrustRatio", "Thrust/Mass", `${round2(stats.thrustRatio)} kN/T`),
    statMarkup("weapons", "Weapons", `${stats.weaponDps} DPS`),
    stats.coolingBonus > 0 ? statMarkup("cooling", "Cooling", `${formatPercent(stats.coolingBonus)} reload`) : "",
    stats.captureBonus > 0 ? statMarkup("capture", "Capture", `+${formatPercent(stats.captureBonus)}`) : "",
    statMarkup("repair", "Repair", formatRepair(stats.repairRate)),
    statMarkup("mass", "Mass", formatMass(stats.mass))
  ].join("");

  if (dom.blueprintCostBreakdown) {
    dom.blueprintCostBreakdown.innerHTML = costBreakdownInnerMarkup(stats.costBreakdown);
  }

  renderShipIssues(status);
  setBuildStatus(status.blockers.length ? status.blockers[0] : stats.warnings.length ? stats.warnings[0] : "Blueprint ready", status.blockers.length ? "error" : stats.warnings.length ? "warning" : "good");
  updateEconomyUi();
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

function issueListMarkup(title, issues) {
  if (!issues.length) return `<div class="issue-group empty"><span>${title}</span><p>None</p></div>`;
  return `
    <div class="issue-group">
      <span>${title}</span>
      <ul>${issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("")}</ul>
    </div>
  `;
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

function statMarkup(key, label, value) {
  return `
    <div class="stat" tabindex="0" data-stat-key="${escapeHtml(key)}" data-stat-label="${escapeHtml(label)}" data-stat-value="${escapeHtml(value)}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}
