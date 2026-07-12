// Renders descriptions and detailed properties for the currently selected part.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { PART_DEFS, PART_STATS, isRotatablePart, partCategory, partDescription, partIconMarkup } from "../design/parts.js";
import { escapeHtml } from "../shared/formatting.js";
import { formatMass, formatHull, formatShield, formatThrust, formatEnergy, formatRepair, formatPowerUse, formatPowerGeneration, formatDistance, formatSpeed, formatDamage, formatPercent } from "../design/statFormatting.js";
import { estimatePartEffectiveCost } from "../design/componentStats.js";
import { analyzeDesignHeat } from "./designerUi.js";

export function renderPartInspector() {
  const type = state.selectedPart;
  const def = PART_DEFS[type] || PART_DEFS.frame;
  const stat = PART_STATS[type] || PART_STATS.frame;
  
  // Calculate effective cost preview based on design context
  const effectiveCost = `$${estimatePartEffectiveCost(type, state.design)}`;
  const details = partInspectorDetails(type, stat, effectiveCost);
  const thermal = partThermalDetails(type, stat);

  const baseDesc = partDescription(type, stat);
  const enrichedDesc = enrichDescription(type, baseDesc);

  let tipHtml = "";
  if (isRotatablePart(type)) {
    tipHtml = `<div class="part-inspector-tip">Tip: hover a placed matching part and press R to rotate.</div>`;
  }

  const footprint = stat.footprint || { width: 1, height: 1 };
  const footprintText = `${footprint.width}x${footprint.height}`;

  dom.partInspector.innerHTML = `
    <div class="part-inspector-title">
      ${partIconMarkup(type, "inspector-glyph")}
      <strong>${escapeHtml(def.name)}</strong>
    </div>
    <div class="part-category-label">${escapeHtml(partCategory(type))} | Size: ${footprintText}</div>
    <p class="part-description">${escapeHtml(enrichedDesc)}</p>
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
    ${thermalSectionMarkup(type, stat, thermal)}
    ${tipHtml}
  `;
  dom.partInspector.querySelector(".thermal-properties-details")?.addEventListener("toggle", event => {
    state.partThermalPropsOpen = event.target.open;
  });
}

// Design-specific thermal prediction for the selected part type, plus its static
// thermal properties in a collapsed section so the two are never conflated.
function thermalSectionMarkup(type, stat, thermal) {
  const rules = globalThis.HeatRules;
  const signed = (value, decimals = 1) => Math.abs(value) < 0.05 ? "0.0 H/s" : `${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(decimals)} H/s`;
  const placed = state.design.filter(part => part.type === type);
  let predictedRows = "";
  let explainer = "";
  if (placed.length) {
    const analysis = analyzeDesignHeat(state.design, state.thermalLoadMode || "full");
    const prediction = placed
      .map(part => analysis.predictions.get(part))
      .filter(Boolean)
      .reduce((hottest, candidate) => !hottest || candidate.ratio > hottest.ratio ? candidate : hottest, null);
    if (prediction) {
      const percent = Math.min(100, Math.round(prediction.ratio * 100));
      const coolingReceived = prediction.cooling + prediction.transferredOut - prediction.received;
      const net = prediction.generation - coolingReceived;
      predictedRows = `
        <div class="part-detail-heading">Predicted in this design</div>
        <div class="thermal-stat-rows">
          ${thermalRow("Predicted heat", `${percent}%`)}
          ${thermalRow("Thermal state", rules.STATE_LABELS[prediction.state])}
          ${thermalRow("Heat generation", signed(prediction.generation), "thermal-value-hot")}
          ${thermalRow("Cooling received", signed(-coolingReceived), coolingReceived >= 0 ? "thermal-value-cool" : "thermal-value-hot")}
          ${thermalRow("Net heat", signed(net), net > 0.05 ? "thermal-value-hot" : "thermal-value-cool")}
          ${thermalRow("Heat capacity", `${prediction.capacity} H`)}
          ${prediction.meltdownTime != null ? thermalRow("Meltdown predicted", `at ${prediction.meltdownTime.toFixed(1)}s sustained load`, "thermal-value-hot") : ""}
        </div>`;
      if (thermal.generation > 0.5 && prediction.ratio < 0.26) {
        explainer = `<p class="thermal-explainer">Generates +${thermal.generation.toFixed(1)} H/s ${escapeHtml(thermal.cadence.toLowerCase())}. Predicted peak in this design: ${percent}% — the cooling layout is managing it.</p>`;
      } else if (placed.length > 1) {
        explainer = `<p class="thermal-explainer">Showing the hottest of ${placed.length} placed ${escapeHtml(PART_DEFS[type]?.name || type)} components.</p>`;
      }
    }
  } else {
    predictedRows = `
      <div class="part-detail-heading">Predicted in this design</div>
      <p class="thermal-explainer">Not placed in this design yet${thermal.generation > 0 ? ` — generates +${thermal.generation.toFixed(1)} H/s ${escapeHtml(thermal.cadence.toLowerCase())}` : ""}.</p>`;
  }
  return `
    ${predictedRows}
    ${explainer}
    <details class="thermal-properties-details"${state.partThermalPropsOpen ? " open" : ""}>
      <summary>Thermal properties</summary>
      <div class="thermal-stat-rows">
        ${thermal.details.map(([label, value]) => thermalRow(label, value)).join("")}
      </div>
    </details>`;
}

function thermalRow(label, value, valueClass = "") {
  return `<div><span>${escapeHtml(label)}</span><strong${valueClass ? ` class="${valueClass}"` : ""}>${escapeHtml(value)}</strong></div>`;
}

function partThermalDetails(type, stat) {
  const rules = globalThis.HeatRules;
  const thermalProfile = rules.profile(type, stat);
  const capacity = thermalProfile.capacity;
  const naturalCooling = thermalProfile.cooling;
  let generation = rules.activityHeat(type, stat);
  let cadence = "While active";
  if (stat.weapon) {
    cadence = stat.weapon.type === "beam" ? "while firing" : "at sustained fire";
  } else if ((stat.powerGeneration || 0) > 0) {
    generation = 2 + stat.powerGeneration * 0.42;
    cadence = "At power load";
  } else if ((stat.thrust || 0) > 0) {
    generation = 2 + stat.thrust * 0.018;
    cadence = "While thrusting";
  } else if ((stat.shieldRegen || 0) > 0) {
    generation = stat.shieldRegen * 0.7;
    cadence = "Recharging / hit";
  }

  let effect = "Loses heat naturally and exchanges heat with adjacent occupied components.";
  if (type === "heatSink") effect = "Adds 35 H capacity to every adjacent component and absorbs burst heat locally.";
  if (type === "radiator") effect = "Removes ~14 H/s with an exposed exterior edge (25% output when enclosed); dissipation scales up as it stores more heat.";
  if (type === "armor") effect = "Retains slightly more heat than frame.";

  const hotPenalty = Math.round((1 - rules.performanceForState(rules.STATE.HOT)) * 100);
  const criticalPenalty = Math.round((1 - rules.performanceForState(rules.STATE.CRITICAL)) * 100);
  const penaltyTarget = stat.weapon ? "fire rate" : (stat.thrust || 0) > 0 ? "thrust" : (stat.shieldRegen || 0) > 0 ? "recharge rate" : (stat.powerGeneration || 0) > 0 ? "power output" : "performance";
  const isGenerator = (stat.powerGeneration || 0) > 0;

  return {
    capacity,
    generation,
    cadence,
    details: [
      ["Heat generation", generation > 0 ? `+${generation.toFixed(1)} H/s — ${cadence}` : "None"],
      ["Natural cooling", `-${naturalCooling.toFixed(1)} H/s`],
      ["Base heat capacity", `${capacity} H`],
      ["Hot / Critical penalty", `-${hotPenalty}% / -${criticalPenalty}% ${penaltyTarget}`],
      ["Overheat shutdown", isGenerator ? `Output stops; melts down after ${rules.REACTOR_MELTDOWN_SECONDS}s pinned at overheat` : "Temporarily shuts down"],
      ["Recovery threshold", `Below ${Math.round(rules.THRESHOLDS.recover * 100)}% heat`],
      ["Conduction", effect]
    ]
  };
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

function formatMultiplierPercent(value) {
  return `${Math.round((value ?? 1) * 100)}%`;
}

function formatAimSpeed(value) {
  if (value === undefined) return "Instant";
  const degs = Math.round(value * (180 / Math.PI));
  return `${value.toFixed(2)} rad/s (${degs} deg/s)`;
}

function enrichDescription(type, baseDescription) {
  if (type === "railgun" || type === "lightRailgun" || type === "heavyRailgun") {
    return `${baseDescription} Long-range kinetic weapon. Weak into shields, strong against exposed hull. Narrow arc and slow fire rate.`;
  }
  if (type === "beamEmitter") {
    return `${baseDescription} Shield-stripping energy weapon. Strong against shields, weaker against hull.`;
  }
  if (type === "autocannon") {
    return `${baseDescription} Rapid kinetic weapon. Poor against shields, better against exposed hull and light ships.`;
  }
  if (type === "torpedo") {
    return `${baseDescription} Heavy explosive missile. Devastating to hull but vulnerable to point defence.`;
  }
  if (type === "swarmMissile") {
    return `${baseDescription} Fires many lighter missiles. Good at overwhelming defences but weaker per hit.`;
  }
  if (type === "pointDefense" || type === "flakCannon" || type === "interceptorPod") {
    return `${baseDescription} Defensive weapon that intercepts incoming missiles and torpedoes. Weak against ships.`;
  }
  return baseDescription;
}

function partInspectorDetails(type, stat, effectiveCost) {
  if (stat.weapon) {
    const weapon = stat.weapon;
    const details = [];

    // Basic Weapon Stats
    if (weapon.type === "beam") {
      details.push(["Damage", `${formatDamage(weapon.damage)}/s`]);
    } else {
      details.push(["Damage", formatDamage(weapon.damage)]);
      details.push(["Fire rate", `${weapon.fireRate} shots/s`]);
      details.push(["Reload", `${weapon.reload}s`]);
    }
    details.push(["DPS", weapon.dps.toFixed(1)]);

    // Damage Profile
    const shieldMult = weapon.shieldDamageMultiplier ?? 1;
    const hullMult = weapon.hullDamageMultiplier ?? 1;
    details.push(["Vs Shields", formatMultiplierPercent(shieldMult)]);
    details.push(["Vs Hull", formatMultiplierPercent(hullMult)]);
    details.push(["Shield DPS", (weapon.dps * shieldMult).toFixed(1)]);
    details.push(["Hull DPS", (weapon.dps * hullMult).toFixed(1)]);

    // Combat Behaviour
    details.push(["Range", formatDistance(weapon.range)]);
    if (weapon.type !== "beam") {
      details.push(["Projectile speed", formatSpeed(weapon.projectileSpeed)]);
      details.push(["Accuracy", `${Math.round(weapon.accuracy * 100)}%`]);
    }
    
    // Turret Turn
    const aimSpeed = weapon.aimSpeed ?? (weapon.type === "beam" ? 1.65 : undefined);
    if (aimSpeed !== undefined) {
      details.push(["Turret Turn", formatAimSpeed(aimSpeed)]);
    }
    
    details.push(["Arc", `${weapon.arc || 360} deg`]);

    // Special Conditionals
    if (weapon.type === "missile") {
      details.push(["Tracking", `${Math.round(weapon.tracking * 100)}%`]);
      details.push(["Track time", `${weapon.trackTime}s`]);
      details.push(["Lock delay", `${weapon.trackingDelay}s`]);
      details.push(["Missile HP", `${weapon.missileHp}`]);
    } else if (weapon.type === "beam") {
      details.push(["Beam radius", formatDistance(weapon.radius || 0)]);
      details.push(["Behavior", "Sustained line damage"]);
    } else if (weapon.antiMissile) {
      details.push(["Anti-Missile", "Yes"]);
      if (weapon.targetPriority && weapon.targetPriority.length > 0) {
        details.push(["Target Priority", weapon.targetPriority.join(", ")]);
      }
      const pdShipDamage = Math.round((weapon.shipDamageMultiplier || 0.1) * 100);
      details.push(["Ship Damage", `${pdShipDamage}%`]);
    }

    return details.filter(Boolean);
  }

  if (type === "engine") {
    return [
      ["Thrust", formatThrust(stat.thrust)],
      ["Speed contribution", "Total thrust / total mass"]
    ];
  }

  if ((stat.powerGeneration || 0) > 0 && type !== "core") {
    const rules = globalThis.HeatRules;
    return [
      ["Meltdown risk", `Explodes after ${rules.REACTOR_MELTDOWN_SECONDS}s pinned at overheat`],
      ["Meltdown blast", `${rules.REACTOR_EXPLOSION_DAMAGE} damage within ${rules.REACTOR_EXPLOSION_RADIUS} tiles`],
      ["Heat at full load", `+${(2 + stat.powerGeneration * 0.42).toFixed(1)} H/s`]
    ];
  }

  if (type === "battery") {
    return [
      ["Recharge", `${stat.shieldRegen}/s`]
    ];
  }

  if (type === "shield") {
    return [
      ["Recharge rate", `${stat.shieldRegen}/s`]
    ];
  }

  if (type === "repair") {
    return [];
  }

  if (type === "ecmModule") {
    return [
      ["ECM Strength", `-${Math.round((stat.ecmStrength || 0) * 100)}% missile tracking`]
    ];
  }

  if (type === "decoyLauncher") {
    return [
      ["Decoy range", formatDistance(stat.decoyRange)],
      ["Cooldown", `${stat.decoyCooldown || 0}s`],
      ["Confusion duration", `${stat.decoyConfuseDuration || 0}s`],
      ["Success chance", formatPercent(stat.decoyChance || 0)]
    ];
  }

  if (type === "forwardDeflector") {
    return [
      ["Frontal reduction", `${Math.round((stat.frontDamageReduction || 0) * 100)}%`],
      ["Front arc", `${stat.frontArc || 0} deg`],
      ["Recharge rate", `${stat.shieldRegen}/s`]
    ];
  }

  if (stat.utilityEffect || stat.rangeBonus || stat.accuracyBonus || stat.fireRateBonus || stat.captureBonus || stat.heat) {
    return [
      ["Range bonus", stat.rangeBonus ? formatDistance(stat.rangeBonus) : "None"],
      ["Accuracy bonus", stat.accuracyBonus ? formatPercent(stat.accuracyBonus) : "None"],
      ["Fire rate bonus", stat.fireRateBonus ? formatPercent(stat.fireRateBonus) : "None"],
      ["Capture pressure", stat.captureBonus ? `+${formatPercent(stat.captureBonus)}` : "None"]
    ];
  }

  return [];
}
