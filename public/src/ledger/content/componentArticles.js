// Fleet Ledger component-reference generation from authoritative component data.

import { PART_STATS, PART_DEFS, partCategory, partDescription } from "../../design/parts.js";
import { GENERATED_BALANCE } from "../../generatedBalance.js";
import { formatMass, formatHull, formatShield, formatThrust, formatEnergy, formatRepair, formatDistance, formatSpeed, formatDamage, formatPercent } from "../../design/statFormatting.js";
import "../../shared/weaponPresentationRules.js";
import "../../shared/shieldRules.js";
import { getMechanics, getMechanicsSearchText } from "../componentMechanics.js";
import { DRONES, componentHeatInspection, shorterAuraPercent, signedAuraPercent } from "./resolvedContentValues.js";

const WeaponPresentationRules = globalThis.WeaponPresentationRules;
const ShieldRules = globalThis.ShieldRules;

function categoryForPart() {
  return "component-reference";
}

function titleCase(str) {
  return str.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase()).trim();
}

function statLabel(key) {
  const labels = {
    cost: "Cost",
    mass: "Mass",
    hull: "Hull HP",
    shield: "Shield HP",
    shieldRegen: "Shield Regen",
    thrust: "Thrust",
    turn: "Turn Rate",
    powerGeneration: "Power Generation",
    powerUse: "Power Use",
    energy: "Energy",
    repair: "Repair",
    damage: "Damage",
    fireRate: "Fire Rate",
    range: "Range",
    projectileSpeed: "Projectile Speed",
    tracking: "Tracking",
    splashRadius: "Splash Radius",
    maxPerShip: "Max Per Ship"
  };
  return labels[key] || titleCase(key);
}

function formatStat(key, value) {
  if (value == null || value === 0) return null;
  switch (key) {
    case "mass": return formatMass(value);
    case "hull": return formatHull(value);
    case "shield": return formatShield(value);
    case "thrust": return formatThrust(value);
    case "energy": return formatEnergy(value);
    case "repair": return formatRepair(value);
    case "range": return formatDistance(value);
    case "projectileSpeed": return formatSpeed(value);
    case "damage": return formatDamage(value);
    case "powerGeneration": return `+${value} MW`;
    case "powerUse": return `${value} MW`;
    case "cost": return `\u00a3${value}`;
    case "fireRate": return `${value}/s`;
    case "tracking": return formatPercent(value);
    default: return String(value);
  }
}

function relatedForPart(partId) {
  const stats = PART_STATS[partId] || {};
  const raw = partCategory(partId);
  const related = ["component-reference"];
  if (partId === "droneBay") related.push("drones", "weapons", "defence", "repair-mechanics");
  else if ((Number(stats.sensorRangeBonus) || 0) > 0) related.push("sensors-detection", "combat", "command");
  else if (["fireControl", "signalAmplifier", "targetingComputer", "stabilizerNode"].includes(partId)) related.push("support", "weapons", "heat");
  else if (raw === "Weapons") related.push("weapons", "combat", "heat", "projectile-mechanics", "missile-guidance");
  else if (raw === "Defence") related.push("defence", "weapons", "projectile-mechanics");
  else if (raw === "Support") related.push("support", "defence", "command", "repair-mechanics");
  else if (raw === "Command") related.push("command", "combat", "defence");
  else if (raw === "Engines") related.push("movement", "combat-styles", "power");
  else if (raw === "Power") related.push("power", "heat", "blueprint-designer");
  else if (raw === "Heat Components") related.push("heat", "power");
  else related.push("blueprint-designer", "power", "heat");
  return [...new Set(related.filter((r) => r !== partId))];
}

function generateComponentArticle(partId) {
  const stats = PART_STATS[partId];
  const def = PART_DEFS[partId];
  if (!stats || !def) return null;

  const cat = categoryForPart(partId);
  const name = def.name || partId;
  const desc = partDescription(partId, stats) || stats.description || "";

  const importantStats = [];
  for (const key of ["cost", "mass", "hull", "shield", "shieldRegen", "thrust", "turn", "powerGeneration", "powerUse", "energy", "repair", "damage", "fireRate", "range", "projectileSpeed", "tracking", "splashRadius", "maxPerShip"]) {
    const formatted = formatStat(key, stats[key]);
    if (formatted) importantStats.push({ label: statLabel(key), value: formatted });
  }

  importantStats.push({ label: "Heat effects", value: componentHeatInspection(partId, stats) });

  // Footprint
  if (stats.footprint) {
    importantStats.push({ label: "Footprint", value: `${stats.footprint.width}×${stats.footprint.height}` });
  }

  // Armor reduction
  if (stats.armorFlatReduction) {
    importantStats.push({ label: "Armor Reduction", value: `${stats.armorFlatReduction} Flat` });
  }

  // Rotatable
  if (stats.rotatable) {
    importantStats.push({ label: "Rotatable", value: "Yes" });
  }

  // Shape type
  if (stats.shapeType) {
    importantStats.push({ label: "Shape", value: titleCase(stats.shapeType) });
  }

  // Stat scale
  if (stats.statScale) {
    importantStats.push({ label: "Stat Scale", value: formatPercent(stats.statScale) });
  }

  // Weapon details
  const w = stats.weapon;
  if (w) {
    const presentation = WeaponPresentationRules.weaponCyclePresentation(w);
    const isEmp = w.type === "emp" || w.family === "emp";
    if (isEmp) {
      importantStats.push({ label: "Shield Disruption", value: `${Math.round((Number(w.shieldDisruptionFraction) || 0) * 100)}% Max Shield per hit` });
      importantStats.push({ label: "Hull Damage", value: "0" });
      importantStats.push({ label: "Reload", value: `${presentation.reloadSeconds.toFixed(1)} s` });
      importantStats.push({ label: "Projectile Radius", value: formatDistance(w.projectileRadius || w.radius || 0) });
      importantStats.push({ label: "Range", value: formatDistance(w.range) });
      importantStats.push({ label: "Projectile Speed", value: formatSpeed(w.projectileSpeed) });
      importantStats.push({ label: "Accuracy", value: formatPercent(w.accuracy) });
      importantStats.push({ label: "Firing Arc", value: `${w.arc} degrees` });
    }
    if (!isEmp) {
    if (w.family) importantStats.push({ label: "Weapon Family", value: titleCase(w.family) });
    if (w.damage) importantStats.push({ label: "Damage", value: formatDamage(w.damage) });
    if (presentation.isChargeWeapon) {
      importantStats.push({ label: "Charge", value: `${presentation.chargeSeconds.toFixed(1)} s` });
      importantStats.push({ label: "Reload", value: `${presentation.reloadSeconds.toFixed(1)} s` });
      importantStats.push({ label: "Ideal Cycle DPS", value: presentation.dps.toFixed(1) });
    } else if (w.fireRate) {
      importantStats.push({ label: "Fire Rate", value: `${w.fireRate}/s` });
    }
    if (w.range) importantStats.push({ label: "Range", value: formatDistance(w.range) });
    if (w.projectileSpeed != null) importantStats.push({ label: "Projectile Speed", value: w.projectileSpeed === 0 ? "Hitscan / Beam" : formatSpeed(w.projectileSpeed) });
    if (w.accuracy != null) importantStats.push({ label: "Accuracy", value: formatPercent(w.accuracy) });
    if (w.tracking != null && w.tracking !== 0) importantStats.push({ label: "Tracking", value: formatPercent(w.tracking) });
    if (w.arc) importantStats.push({ label: "Firing Arc", value: `${w.arc}°` });
    if (w.shieldDamageMultiplier != null) importantStats.push({ label: "Shield Damage Multiplier", value: `${w.shieldDamageMultiplier}×` });
    if (w.hullDamageMultiplier != null) importantStats.push({ label: "Hull Damage Multiplier", value: `${w.hullDamageMultiplier}×` });
    if (w.aimSpeed) importantStats.push({ label: "Aim Speed", value: `${w.aimSpeed} rad/s` });
    if (w.radius) importantStats.push({ label: "Beam Radius", value: formatDistance(w.radius) });
    if (w.chargeRampSeconds) importantStats.push({ label: "Charge Ramp", value: `${w.chargeRampSeconds}s` });
    if (w.maxChargeDamageBonus) importantStats.push({ label: "Max Charge Bonus", value: formatPercent(w.maxChargeDamageBonus) });
    if (w.burnThroughCarryMultiplier) importantStats.push({ label: "Burn-Through Carry", value: `${w.burnThroughCarryMultiplier}×` });
    if (w.impactHeatPerDamage) importantStats.push({ label: "Impact Heat Per Damage", value: `${w.impactHeatPerDamage}` });
    if (w.missileHp) importantStats.push({ label: "Missile HP", value: `${w.missileHp}` });
    if (w.trackTime) importantStats.push({ label: "Track Duration", value: `${w.trackTime}s` });
    if (w.trackingDelay) importantStats.push({ label: "Tracking Delay", value: `${w.trackingDelay}s` });
    if (w.antiMissile) importantStats.push({ label: "Anti-Missile", value: "Yes" });
    if (w.shipDamageMultiplier != null) importantStats.push({ label: "Ship Damage Multiplier", value: `${w.shipDamageMultiplier}×` });
    if (w.blastDamage) importantStats.push({ label: "Blast Damage", value: formatDamage(w.blastDamage) });
    if (w.blastRadius) importantStats.push({ label: "Blast Radius", value: formatDistance(w.blastRadius) });
    if (w.proximityFuseRadius) importantStats.push({ label: "Proximity Fuse Radius", value: formatDistance(w.proximityFuseRadius) });
    if (w.innerFullDamageRadius) importantStats.push({ label: "Full Damage Radius", value: formatDistance(w.innerFullDamageRadius) });
    if (w.falloffExponent) importantStats.push({ label: "Blast Falloff Exponent", value: `${w.falloffExponent}` });
    if (w.directImpactBonus != null) importantStats.push({ label: "Direct Impact Bonus", value: `${w.directImpactBonus}` });
    if (w.targetPriority && w.targetPriority.length) {
      importantStats.push({ label: "Target Priority", value: w.targetPriority.map((t) => titleCase(t)).join(" → ") });
    }
    if (presentation.isChargeWeapon && w.spinalCharge?.chargeHoldSeconds != null) {
      importantStats.push({ label: "Charge Retention", value: `${Number(w.spinalCharge.chargeHoldSeconds).toFixed(1)} s` });
    }
    if (presentation.isChargeWeapon && Array.isArray(w.spinalCharge?.penetrationProfile)) {
      importantStats.push({ label: "Penetration", value: w.spinalCharge.penetrationProfile.map((share) => `${Math.round(Number(share) * 100)}%`).join(" → ") });
    }
    }
  }

  // Aura details
  const aura = stats.aura;
  if (aura) {
    if (aura.type) importantStats.push({ label: "Aura Type", value: titleCase(aura.type) });
    if (aura.weaponAccuracyMultiplier) importantStats.push({ label: "Accuracy Aura", value: `${aura.weaponAccuracyMultiplier}×` });
    if (aura.weaponTrackingMultiplier) importantStats.push({ label: "Tracking Aura", value: `${aura.weaponTrackingMultiplier}×` });
    if (aura.turretAimSpeedMultiplier) importantStats.push({ label: "Aim Speed Aura", value: `${aura.turretAimSpeedMultiplier}×` });
    if (aura.pointDefenceTrackingMultiplier) importantStats.push({ label: "Point Defence Tracking Aura", value: `${aura.pointDefenceTrackingMultiplier}×` });
    if (aura.flakTrackingMultiplier) importantStats.push({ label: "Flak Tracking Aura", value: `${aura.flakTrackingMultiplier}×` });
    if (aura.shieldRegenMultiplier) importantStats.push({ label: "Shield Regeneration", value: signedAuraPercent(aura.shieldRegenMultiplier) });
    if (aura.shieldRestartDelayMultiplier) {
      importantStats.push({ label: "Shield Restart Delay", value: shorterAuraPercent(aura.shieldRestartDelayMultiplier) });
      importantStats.push({ label: "Fully Effective Restart Delay", value: `${(ShieldRules.getShieldRestartDelayMs(aura.shieldRestartDelayMultiplier) / 1000).toFixed(1)} seconds` });
    }
    if (aura.repairRateMultiplier) importantStats.push({ label: "Repair Aura", value: `${aura.repairRateMultiplier}×` });
    if (aura.heatDissipationMultiplier) importantStats.push({ label: "Heat Dissipation Aura", value: `${aura.heatDissipationMultiplier}×` });
    if (aura.overheatRecoveryMultiplier) importantStats.push({ label: "Overheat Recovery Aura", value: `${aura.overheatRecoveryMultiplier}×` });
    if (aura.accelerationMultiplier) importantStats.push({ label: "Acceleration Aura", value: `${aura.accelerationMultiplier}×` });
    if (aura.turnRateMultiplier) importantStats.push({ label: "Turn Rate Aura", value: `${aura.turnRateMultiplier}×` });
    if (aura.sensorRangeMultiplier) importantStats.push({ label: "Sensor Range Aura", value: `${aura.sensorRangeMultiplier}×` });
    if (aura.missileTrackingResistanceMultiplier) importantStats.push({ label: "Missile Tracking Resistance Aura", value: `${aura.missileTrackingResistanceMultiplier}×` });
    if (aura.componentAimRetentionMultiplier) importantStats.push({ label: "Aim Retention Aura", value: `${aura.componentAimRetentionMultiplier}×` });
  }

  // Battery / Capacitor details
  if (stats.energyCapacity) importantStats.push({ label: "Energy Capacity", value: formatEnergy(stats.energyCapacity) });
  if (stats.maxChargeRate) importantStats.push({ label: "Max Charge Rate", value: `${stats.maxChargeRate} MW` });
  if (stats.maxDischargeRate) importantStats.push({ label: "Max Discharge Rate", value: `${stats.maxDischargeRate} MW` });
  if (stats.chargeEfficiency) importantStats.push({ label: "Charge Efficiency", value: formatPercent(stats.chargeEfficiency) });
  if (stats.dischargeEfficiency) importantStats.push({ label: "Discharge Efficiency", value: formatPercent(stats.dischargeEfficiency) });
  if (stats.dischargeHeatAtMax) importantStats.push({ label: "Discharge Heat At Max", value: `${stats.dischargeHeatAtMax}` });

  // Reactor meltdown
  if (stats.meltdownDamage) importantStats.push({ label: "Meltdown Damage", value: formatDamage(stats.meltdownDamage) });
  if (stats.meltdownRadius) importantStats.push({ label: "Meltdown Radius", value: formatDistance(stats.meltdownRadius) });

  // Decoy details
  const decoy = stats.decoy;
  if (decoy) {
    if (decoy.capacity) importantStats.push({ label: "Decoy Capacity", value: `${decoy.capacity}` });
    if (decoy.initialStock != null) importantStats.push({ label: "Initial Stock", value: `${decoy.initialStock}` });
    if (decoy.productionSeconds) importantStats.push({ label: "Production Time", value: `${decoy.productionSeconds}s` });
    if (decoy.launchCooldownSeconds) importantStats.push({ label: "Launch Cooldown", value: `${decoy.launchCooldownSeconds}s` });
    if (decoy.lifetimeSeconds) importantStats.push({ label: "Decoy Lifetime", value: `${decoy.lifetimeSeconds}s` });
    if (decoy.triggerRange) importantStats.push({ label: "Trigger Range", value: formatDistance(decoy.triggerRange) });
    if (decoy.attractionRange) importantStats.push({ label: "Attraction Range", value: formatDistance(decoy.attractionRange) });
    if (decoy.attractionChance) importantStats.push({ label: "Attraction Chance", value: formatPercent(decoy.attractionChance) });
    if (decoy.driftSpeed) importantStats.push({ label: "Drift Speed", value: formatSpeed(decoy.driftSpeed) });
    if (decoy.collisionRadius) importantStats.push({ label: "Collision Radius", value: formatDistance(decoy.collisionRadius) });
  }

  // Proximity charge details
  const prox = stats.proximityCharge;
  if (prox) {
    if (prox.triggerRadius) importantStats.push({ label: "Trigger Radius", value: formatDistance(prox.triggerRadius) });
    if (prox.triggerConfirmationSeconds) importantStats.push({ label: "Trigger Confirmation", value: `${prox.triggerConfirmationSeconds}s` });
    if (prox.blastRadius) importantStats.push({ label: "Blast Radius", value: formatDistance(prox.blastRadius) });
    if (prox.centreDamage) importantStats.push({ label: "Centre Damage", value: formatDamage(prox.centreDamage) });
    if (prox.falloffExponent) importantStats.push({ label: "Blast Falloff", value: `${prox.falloffExponent}` });
    if (prox.maxAffectedComponents === null) importantStats.push({ label: "Max Affected Components", value: "Unlimited" });
    else if (prox.maxAffectedComponents) importantStats.push({ label: "Max Affected Components", value: `${prox.maxAffectedComponents}` });
    importantStats.push({ label: "Damages Friendly Ships", value: prox.damagesFriendlyShips === false ? "No" : "Yes" });
    if (prox.internalDamageReduction) importantStats.push({ label: "Internal Damage Reduction", value: formatPercent(prox.internalDamageReduction) });
  }

  // Maneuver thruster
  if (stats.allowedRotations) importantStats.push({ label: "Allowed Rotations", value: `${stats.allowedRotations.join("°, ")}°` });

  // Utility type
  if (stats.utility) importantStats.push({ label: "Utility Type", value: titleCase(stats.utility) });
  if (stats.fireRateBonus) importantStats.push({ label: "Fire Rate Bonus", value: formatPercent(stats.fireRateBonus) });
  if (stats.accuracyBonus) importantStats.push({ label: "Accuracy Bonus", value: formatPercent(stats.accuracyBonus) });
  if (stats.rangeBonus) importantStats.push({ label: "Range Bonus", value: formatDistance(stats.rangeBonus) });

  // Drone bay drone config reference
  if (partId === "droneBay") {
    const droneConfig = stats.droneConfig || DRONES;
    if (droneConfig.squadSize) importantStats.push({ label: "Squad Size", value: `${droneConfig.squadSize}` });
    if (droneConfig.maxBaysPerShip) importantStats.push({ label: "Max Bays Per Ship", value: `${droneConfig.maxBaysPerShip}` });
    if (droneConfig.maxActivePerShip) importantStats.push({ label: "Max Active Per Ship", value: `${droneConfig.maxActivePerShip}` });
    if (droneConfig.fuelSeconds) importantStats.push({ label: "Fuel Duration", value: `${droneConfig.fuelSeconds}s` });
    if (droneConfig.refuelSeconds) importantStats.push({ label: "Refuel Time", value: `${droneConfig.refuelSeconds}s` });
    if (droneConfig.launchIntervalSeconds) importantStats.push({ label: "Launch Interval", value: `${droneConfig.launchIntervalSeconds}s` });
    if (droneConfig.launchDurationSeconds) importantStats.push({ label: "Launch Duration", value: `${droneConfig.launchDurationSeconds}s` });
    if (droneConfig.standbyPowerMw) importantStats.push({ label: "Standby Power", value: `${droneConfig.standbyPowerMw} MW` });
    if (droneConfig.activePowerMw) importantStats.push({ label: "Active Power", value: `${droneConfig.activePowerMw} MW` });
    if (droneConfig.productionPowerMw) importantStats.push({ label: "Production Power", value: `${droneConfig.productionPowerMw} MW` });

    // Drone type details
    const types = droneConfig.types || {};
    for (const [typeId, typeData] of Object.entries(types)) {
      importantStats.push({ label: `${typeData.label || typeId} : Hull`, value: `${typeData.hull} HP` });
      importantStats.push({ label: `${typeData.label || typeId} : Speed`, value: formatSpeed(typeData.speed) });
      if (typeData.damage) importantStats.push({ label: `${typeData.label || typeId} : Damage`, value: formatDamage(typeData.damage) });
      if (typeData.fireRate) importantStats.push({ label: `${typeData.label || typeId} : Fire Rate`, value: `${typeData.fireRate}/s` });
      if (typeData.repairPerSecond) importantStats.push({ label: `${typeData.label || typeId} : Repair`, value: `${typeData.repairPerSecond} HP/s` });
      if (typeData.commandRange) importantStats.push({ label: `${typeData.label || typeId} : Command Range`, value: formatDistance(typeData.commandRange) });
      if (typeData.squadSize) importantStats.push({ label: `${typeData.label || typeId} : Squad Size`, value: `${typeData.squadSize}` });
      if (typeData.fuelSeconds) importantStats.push({ label: `${typeData.label || typeId} : Fuel`, value: `${typeData.fuelSeconds}s` });
      if (typeData.productionSeconds) importantStats.push({ label: `${typeData.label || typeId} : Rebuild Time`, value: `${typeData.productionSeconds}s` });
    }
  }

  // Power category
  if (stats.powerCategory) importantStats.push({ label: "Power Category", value: titleCase(stats.powerCategory) });

  const keywords = [name.toLowerCase(), partId.toLowerCase(), cat];
  if (def.category) keywords.push(def.category.toLowerCase());
  if (w) keywords.push(w.family || w.type, "weapon");
  if (aura) keywords.push("aura", aura.type);
  if (stats.utility) keywords.push(stats.utility);

  // Build practical use and common problems based on category
  let practicalUse = "";
  let commonProblems = [];

  if (w) {
    const presentation = WeaponPresentationRules.weaponCyclePresentation(w);
    const isEmp = w.type === "emp" || w.family === "emp";
    practicalUse = presentation.isChargeWeapon
      ? (isEmp ? `Removes ${Math.round((Number(w.shieldDisruptionFraction) || 0) * 100)}% of target maximum Shield per impact, clamped to current Shield. Deals no hull damage, creates no Shield Impact Heat, and has no overflow, splash, or status effect. ` : `Damage per shot: ${formatDamage(presentation.damagePerShot)}. Charge: ${presentation.chargeSeconds.toFixed(1)} s. Reload: ${presentation.reloadSeconds.toFixed(1)} s. Ideal cycle DPS: ${presentation.dps.toFixed(1)}. `)
      : (isEmp ? `Removes ${Math.round((Number(w.shieldDisruptionFraction) || 0) * 100)}% of target maximum Shield per impact, clamped to current Shield. Deals no hull damage, creates no Shield Impact Heat, and has no overflow, splash, or status effect. ` : `Theoretical DPS: ${presentation.dps.toFixed(1)}. `);
    if (w.family === "missile") practicalUse += "Vulnerable to point defence : overwhelm with numbers or mix with other weapons. ";
    if (w.family === "railgun") practicalUse += "Best at long range against slow or stationary targets. Narrow arc requires careful positioning. ";
    if (w.family === "beam") practicalUse += "Sustained shield-breaking : ramps up damage over 15s. Keep the beam on target. ";
    if (w.family === "blaster") practicalUse += "General-purpose weapon with good accuracy and moderate range. ";
    if (w.family === "pointDefense" || w.family === "flak") practicalUse += "Anti-missile and anti-drone defence; low base damage makes it weak against ships. ";
    commonProblems.push("Not firing? Check the weapon's power state and whether it is alive and enabled.");
    if (w.arc < 90) commonProblems.push("Narrow firing arc : position the ship to face the target.");
    if (w.tracking > 0) commonProblems.push("Missiles can be intercepted by enemy point defence.");
  }

  if (aura) {
    practicalUse += `Projects a ${aura.type} command aura affecting friendly ships within ${GENERATED_BALANCE.commandAura?.range ?? 800} m. `;
    commonProblems.push("Aura does not affect the ship itself : coordinate with fleet members.");
  }

  if (stats.armorFlatReduction) {
    practicalUse += `Reduces incoming damage by ${stats.armorFlatReduction} flat per hit. `;
  }

  if (stats.meltdownDamage) {
    commonProblems.push("Reactor will melt down if overheated : ensure adequate cooling.");
  }

  // Merge structured mechanics from the registry
  const mechanics = getMechanics(partId);
  const conditionalPerformance = mechanics?.conditionalPerformance || null;
  const requirementsLimitations = mechanics?.requirements || null;
  const specialMechanics = mechanics?.specialMechanics || null;
  const interactions = mechanics?.interactions || null;

  // Add mechanics text to keywords for search
  if (mechanics) {
    const mechText = getMechanicsSearchText(partId);
    if (mechText) keywords.push(mechText);
  }

  return {
    id: `component:${partId}`,
    category: cat,
    title: name,
    summary: desc,
    keywords,
    howItWorks: desc,
    importantStats,
    conditionalPerformance,
    requirementsLimitations,
    specialMechanics,
    interactions,
    practicalUse: practicalUse || "See the category overview article for general guidance.",
    commonProblems: commonProblems.length ? commonProblems : ["See the category overview article for common issues."],
    related: relatedForPart(partId),
    isComponent: true,
    partId
  };
}

export function generateAllComponentArticles() {
  const articles = [];
  for (const partId of Object.keys(PART_STATS)) {
    const article = generateComponentArticle(partId);
    if (article) articles.push(article);
  }
  return articles;
}
