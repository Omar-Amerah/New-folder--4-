// Renders descriptions and detailed properties for the currently selected part.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { PART_DEFS, PART_STATS, partCategory, partDescription, partIconMarkup } from "../design/parts.js";
import { escapeHtml } from "../shared/formatting.js";
import { formatMass, formatHull, formatShield, formatThrust, formatEnergy, formatRepair, formatPowerUse, formatPowerGeneration, formatDistance, formatSpeed, formatDamage, formatPercent } from "../design/statFormatting.js";
import { estimatePartEffectiveCost } from "../design/componentStats.js";

export function renderPartInspector() {
  const type = state.selectedPart;
  const def = PART_DEFS[type] || PART_DEFS.frame;
  const stat = PART_STATS[type] || PART_STATS.frame;
  
  // Calculate effective cost preview based on design context
  const effectiveCost = `$${estimatePartEffectiveCost(type, state.design)}`;
  const details = partInspectorDetails(type, stat, effectiveCost);

  dom.partInspector.innerHTML = `
    <div class="part-inspector-title">
      ${partIconMarkup(type, "inspector-glyph")}
      <strong>${escapeHtml(def.name)}</strong>
    </div>
    <div class="part-category-label">${escapeHtml(partCategory(type))}</div>
    <p class="part-description">${escapeHtml(partDescription(type, stat))}</p>
    <div class="part-inspector-grid">
      ${inspectorStat("Cost", effectiveCost)}
      ${inspectorStat("Mass", formatMass(stat.mass))}
      ${inspectorStat("Hull", formatHull(stat.hp))}
      ${inspectorStat("Power", partPowerText(stat))}
      ${inspectorStat("Shield", formatShield(stat.shield))}
      ${inspectorStat("Thrust", formatThrust(stat.thrust))}
      ${inspectorStat("Storage", formatEnergy(stat.energyStorage))}
      ${inspectorStat("Repair", formatRepair(stat.repairRate))}
    </div>
    <div class="part-detail-list">
      ${details.map(([label, value]) => inspectorDetail(label, value)).join("")}
    </div>
  `;
}

function inspectorStat(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function inspectorDetail(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function partPowerText(stat) {
  const generation = stat.powerGeneration || 0;
  const use = stat.powerUse || 0;
  if (generation && use) return `+${generation} MW / -${use} MW`;
  if (generation) return `+${generation} MW`;
  if (use) return `-${use} MW`;
  return "0 MW";
}

function partInspectorDetails(type, stat, effectiveCost) {
  if (stat.weapon) {
    const weapon = stat.weapon;
    return [
      ["Damage", formatDamage(weapon.damage)],
      ["Range", formatDistance(weapon.range)],
      ["Fire rate", `${weapon.fireRate} shots/s`],
      ["Reload", `${weapon.reload}s`],
      ["DPS", weapon.dps.toFixed(1)],
      ["Projectile speed", formatSpeed(weapon.projectileSpeed)],
      ["Accuracy", `${Math.round(weapon.accuracy * 100)}%`],
      ["Tracking", weapon.tracking ? `${Math.round(weapon.tracking * 100)}%` : "None"],
      ["Arc", `${weapon.arc || 360} deg`],
      ["Default facing", "Forward / editor up"],
      ["Rotate", "Click a placed matching gun, or hover it and press R"],
      ["Power use", formatPowerUse(stat.powerUse)]
    ];
  }

  if (type === "engine") {
    return [
      ["Thrust", formatThrust(stat.thrust)],
      ["Mass", formatMass(stat.mass)],
      ["Speed contribution", "Total thrust / total mass"],
      ["Power use", formatPowerUse(stat.powerUse)]
    ];
  }

  if (type === "reactor") {
    return [
      ["Power generation", formatPowerGeneration(stat.powerGeneration)],
      ["Energy storage", formatEnergy(stat.energyStorage)],
      ["Explosion risk", stat.explosionRisk || "Not implemented"],
      ["Mass", formatMass(stat.mass)]
    ];
  }

  if (type === "battery") {
    return [
      ["Energy storage", formatEnergy(stat.energyStorage)],
      ["Shield", formatShield(stat.shield)],
      ["Recharge", `${stat.shieldRegen}/s`],
      ["Power generation", formatPowerGeneration(stat.powerGeneration)]
    ];
  }

  if (type === "shield") {
    return [
      ["Shield amount", formatShield(stat.shield)],
      ["Recharge rate", `${stat.shieldRegen}/s`],
      ["Power draw", formatPowerUse(stat.powerUse)],
      ["Mass", formatMass(stat.mass)]
    ];
  }

  if (type === "repair") {
    return [
      ["Repair rate", formatRepair(stat.repairRate)],
      ["Power use", formatPowerUse(stat.powerUse)],
      ["Shield", formatShield(stat.shield)],
      ["Mass", formatMass(stat.mass)]
    ];
  }

  if (stat.utilityEffect || stat.rangeBonus || stat.accuracyBonus || stat.fireRateBonus || stat.captureBonus || stat.heat) {
    return [
      ["Range bonus", stat.rangeBonus ? formatDistance(stat.rangeBonus) : "None"],
      ["Accuracy bonus", stat.accuracyBonus ? formatPercent(stat.accuracyBonus) : "None"],
      ["Fire rate bonus", stat.fireRateBonus ? formatPercent(stat.fireRateBonus) : "None"],
      ["Cooling bonus", stat.heat ? `${formatPercent(Math.max(0, -stat.heat) * 0.01)} faster reload` : "None"],
      ["Capture pressure", stat.captureBonus ? `+${formatPercent(stat.captureBonus)}` : "None"]
    ];
  }

  return [
    ["Hull", formatHull(stat.hp)],
    ["Mass", formatMass(stat.mass)],
    ["Cost", effectiveCost],
    ["Power", partPowerText(stat)]
  ];
}
