// Renders descriptions and detailed properties for the currently selected part.

import { dom } from "./dom.js";
import { state, DEFAULT_THERMAL_LOAD_MODE } from "../state.js";
import { PART_DEFS, PART_STATS, isRotatablePart, partCategory, partDescription, partIconMarkup } from "../design/parts.js";
import { escapeHtml } from "../shared/formatting.js";
import { formatMass, formatHull, formatShield, formatThrust, formatEnergy, formatRepair, formatPowerUse, formatPowerGeneration, formatDistance, formatSpeed, formatDamage, formatPercent } from "../design/statFormatting.js";
import { estimatePartEffectiveCost } from "../design/componentStats.js";
import { analyzeDesignHeat } from "../design/thermalAnalysis.js";

export function renderPartInspector() {
  const type = state.selectedPart;
  if (!type) {
    dom.partInspector.innerHTML = `<p class="part-description">Select a component to view its details</p>`;
    return;
  }
  const def = PART_DEFS[type] || PART_DEFS.frame;
  const stat = PART_STATS[type] || PART_STATS.frame;
  const effectiveCost = `$${estimatePartEffectiveCost(type, state.design).toLocaleString()}`;
  const details = partInspectorDetails(type, stat, effectiveCost);
  const thermal = partThermalDetails(type, stat);
  const baseDesc = partDescription(type, stat);
  const enrichedDesc = enrichDescription(type, baseDesc);
  const footprint = stat.footprint || { width: 1, height: 1 };
  const footprintText = `${footprint.width}x${footprint.height}`;
  const keyStats = keyInspectorStats(type, stat, effectiveCost);
  const combatDetails = details.filter(([label]) => /damage|dps|shield dps|hull dps|range|projectile|accuracy|turret|arc|tracking|track|lock|missile|beam|behavior|anti-missile|target|ship damage|frontal|front arc/i.test(label));
  const supportDetails = details.filter(([label]) => !combatDetails.some(([combatLabel]) => combatLabel === label));

  let tipHtml = "";
  if (isRotatablePart(type)) {
    tipHtml = `<div class="part-inspector-tip">Tip: hover a placed matching part and press R to rotate.</div>`;
  }

  dom.partInspector.innerHTML = `
    <section class="part-inspector-section part-identity-section">
      <div class="part-inspector-title">
        ${partIconMarkup(type, "inspector-glyph")}
        <strong>${escapeHtml(def.name)}</strong>
      </div>
      <div class="part-category-label">${escapeHtml(partCategory(type))} | Footprint: ${footprintText}</div>
      <p class="part-description">${escapeHtml(enrichedDesc)}</p>
    </section>
    <section class="part-inspector-section">
      <div class="part-detail-heading">Key stats</div>
      <div class="part-inspector-grid">
        ${keyStats.map(([label, value]) => inspectorStat(label, value)).join("")}
      </div>
    </section>
    ${thermalSectionMarkup(type, stat, thermal)}
    ${collapsibleDetails("combat", "Combat details", combatDetails)}
    ${collapsibleDetails("support", "Power and support details", supportDetails)}
    ${tipHtml}
  `;
  dom.partInspector.querySelectorAll("details[data-inspector-section]").forEach((detailsEl) => {
    detailsEl.addEventListener("toggle", event => {
      state.partInspectorOpen = state.partInspectorOpen || {};
      state.partInspectorOpen[event.target.dataset.inspectorSection] = event.target.open;
      if (event.target.classList.contains("thermal-properties-details")) state.partThermalPropsOpen = event.target.open;
    });
  });
}

function keyInspectorStats(type, stat, effectiveCost) {
  const rows = [
    ["Build cost", effectiveCost],
    ["Mass", formatMass(stat.mass)],
    ["Hull", formatHull(stat.hp)],
    ["Power", partPowerText(stat)]
  ];
  if (stat.weapon) {
    rows.push(["Damage", stat.weapon.type === "beam" ? `${formatDamage(stat.weapon.damage)}/s` : formatDamage(stat.weapon.damage)]);
    rows.push(["Fire rate", stat.weapon.type === "beam" ? "Continuous beam" : `${stat.weapon.fireRate} shots/s`]);
  } else if ((stat.thrust || 0) > 0 || (stat.lateralThrust || 0) > 0) {
    rows.push([type === "maneuverThruster" ? "Lateral thrust" : "Thrust", formatThrust(type === "maneuverThruster" ? stat.lateralThrust : stat.thrust)]);
  } else if ((stat.shield || 0) > 0 || (stat.shieldRegen || 0) > 0) {
    rows.push(["Shield", formatShield(stat.shield)]);
    rows.push(["Recharge", `${stat.shieldRegen || 0}/s`]);
  } else if ((stat.repairRate || 0) > 0) {
    rows.push(["Repair", formatRepair(stat.repairRate)]);
  } else if ((stat.energyStorage || 0) > 0) {
    rows.push(["Storage", formatEnergy(stat.energyStorage)]);
  } else if ((stat.heat || 0) > 0 || type === "radiator" || type === "heatSink" || type === "heatPipe") {
    rows.push(["Thermal role", thermalRoleText(type, stat)]);
  }
  return rows;
}

function thermalRoleText(type, stat) {
  if (type === "radiator") return "Active cooling";
  if (type === "heatSink") return "Heat storage";
  if (type === "heatPipe") return "Heat transfer";
  return stat.heat ? "Heat support" : "Thermal support";
}

function collapsibleDetails(key, label, rows) {
  if (!rows.length) return "";
  const open = state.partInspectorOpen?.[key] ? " open" : "";
  return `<details class="part-inspector-details" data-inspector-section="${escapeHtml(key)}"${open}>
    <summary>${escapeHtml(label)}</summary>
    <div class="part-detail-list">${rows.map(([detailLabel, value]) => inspectorDetail(detailLabel, value)).join("")}</div>
  </details>`;
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
    const analysis = analyzeDesignHeat(state.design, state.wiring || null, state.thermalLoadMode || DEFAULT_THERMAL_LOAD_MODE);
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
    <details class="thermal-properties-details" data-inspector-section="thermal"${state.partThermalPropsOpen ? " open" : ""}>
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
  if (type === "heatPipe") effect = "High-conductivity route that transfers heat to connected sinks/radiators; removes no heat by itself, stores little heat, and provides no structural support.";
  if (type === "heatSink") effect = "Adds 35 H capacity to every adjacent component and absorbs burst heat locally.";
  if (type === "radiator") effect = "Removes ~14 H/s with an exposed exterior edge (25% output when enclosed); dissipation scales up as it stores more heat.";
  if (type === "armor") effect = "Retains slightly more heat than frame.";

  const pct = (value) => `${Math.round(value * 100)}%`;
  const active = rules.activeOutputForState || rules.performanceForState;
  const passive = rules.passiveProtectionForState;
  const cooling = rules.activeCoolingForState;
  const rows = [
    ["Heat generation", generation > 0 ? `+${generation.toFixed(1)} H/s — ${cadence}` : "None"],
    ["Natural cooling", `-${naturalCooling.toFixed(1)} H/s`],
    ["Base heat capacity", `${capacity} H`]
  ];
  const activeLabel = stat.weapon ? (stat.weapon.type === "beam" ? "beam output" : "fire rate")
    : (stat.thrust || 0) > 0 ? "thrust"
    : (stat.shieldRegen || 0) > 0 ? "recharge rate"
    : (stat.repairRate || 0) > 0 ? "repair output"
    : (stat.powerGeneration || 0) > 0 ? "power output"
    : (stat.rangeBonus || stat.accuracyBonus || stat.fireRateBonus || stat.captureBonus || stat.ecmStrength) ? "bonus effectiveness" : null;
  const passiveStructure = /frame/i.test(type) || ["armor", "compositeArmor", "bulkhead", "weaponMount"].includes(type);
  if (activeLabel) {
    rows.push(["Hot", `${pct(active(rules.STATE.HOT))} ${activeLabel}`]);
    rows.push(["Critical", `${pct(active(rules.STATE.CRITICAL))} ${activeLabel}`]);
    rows.push(["Overheated", `${activeLabel.replace(/^./, c => c.toUpperCase())} offline${(stat.powerGeneration || 0) > 0 ? `; meltdown after ${rules.REACTOR_MELTDOWN_SECONDS}s pinned at overheat` : ""}`]);
  } else if (type === "heatPipe") {
    rows.push(["Heat penalty", "Transfer unaffected"]);
  } else if (type === "heatSink") {
    rows.push(["Storage", "Unaffected"]);
    rows.push(["Cooling output", `${pct(cooling(rules.STATE.HOT))} Hot / ${pct(cooling(rules.STATE.CRITICAL))} Critical`]);
  } else if (type === "radiator") {
    rows.push(["Cooling output", `${pct(cooling(rules.STATE.HOT))} Hot / ${pct(cooling(rules.STATE.CRITICAL))} Critical / passive floor when overheated`]);
  } else if (passiveStructure) {
    if (type === "armor" || type === "compositeArmor") {
      rows.push(["Hot", `${pct(passive(rules.STATE.HOT))} protection`]);
      rows.push(["Critical", `${pct(passive(rules.STATE.CRITICAL))} protection`]);
      rows.push(["Overheated", `${pct(passive(rules.STATE.OVERHEATED))} protection`]);
    } else {
      rows.push(["Hot", `Takes ×${rules.structuralDamageMultiplierForState(rules.STATE.HOT).toFixed(2)} damage`]);
      rows.push(["Critical", `Takes ×${rules.structuralDamageMultiplierForState(rules.STATE.CRITICAL).toFixed(2)} damage`]);
      rows.push(["Overheated", `Takes ×${rules.structuralDamageMultiplierForState(rules.STATE.OVERHEATED).toFixed(2)} damage`]);
    }
  }
  rows.push(["Recovery threshold", `Below ${Math.round(rules.THRESHOLDS.recover * 100)}% heat`], ["Conduction", effect]);

  return { capacity, generation, cadence, details: rows };
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
  return "No Power requirement";
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
    
    // Turret traverse rate comes from the shared TurretRules table, the same
    // one the server aims with — no weapon snaps instantly any more.
    details.push(["Turret Turn", formatAimSpeed(globalThis.TurretRules.turnRateFor(weapon))]);
    
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

  if (type === "switchgear") {
    return [
      ["Default mode", "Closed (Open / Closed / Automatic saved per component)"],
      ["Rating", "Standard by default; Light, Standard, and Heavy match Power cable sustained/peak limits"],
      ["Terminal orientation", "Rotation sets opposite terminal A and B cells: horizontal at 0°/180°, vertical at 90°/270°"],
      ["Power behaviour", "Open isolates sides; Closed conducts through the rated internal Power edge; Automatic only uses deterministic spare Power"],
      ["Data wiring", "No Data connection passes through Switchgear"]
    ];
  }

  if (type === "maneuverThruster") {
    const rotation = state.previewRotation === 270 ? 270 : 90;
    return [
      ["Lateral thrust", formatThrust(stat.lateralThrust || 0)],
      ["Turn contribution", `${stat.turn || 0} base, scaled by front/rear lever arm`],
      ["Allowed facing", "Left or right only"],
      ["Current exhaust", rotation === 90 ? "Left nozzle" : "Right nozzle"],
      ["Current force", rotation === 90 ? "Pushes right" : "Pushes left"],
      ["Forward speed", "Does not increase forward speed"],
      ["Placement note", "Distance ahead/behind the centre of mass affects turning strength"]
    ];
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
