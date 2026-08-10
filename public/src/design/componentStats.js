// Calculations for ship statistics, mass classes, power efficiency, fleet count, and builder warnings.

import { clamp } from "../shared/math.js";
import { PART_STATS } from "./parts.js";
import { FLEET_COUNT_RULES } from "../constants.js";
import ShieldRules from "../shared/shieldRules.js";

import { angleDifference, directionalFootprintToShipRadians, normalizeRotation } from "./rotation.js";
import { calculateMovementStats,
  calculateCenterOfMass,
  calculateDirectionalTurnInputs,
  calculateGenericTurnModifier,
  MOVEMENT_CONFIG } from "../shared/movementStats.js";
import { calculateUniversalPower } from "../shared/universalPower.js";
import { getEffectiveRepairRate, installedRepairRate } from "../shared/repairRules.js";
import { nonCoreHullTotal } from "../shared/componentHullRules.js";
import "../shared/weaponPresentationRules.js";
import { GENERATED_BALANCE } from "../generatedBalance.js";

const DataSupportRules = globalThis.DataSupportRules || null;
const WeaponPresentationRules = globalThis.WeaponPresentationRules;

function blueprintSensorProfile(modules) {
  const visibility = GENERATED_BALANCE?.visibility || {};
  const baseRange = Number(visibility.baseSensorRange) || 460;
  const sensors = modules.map((module, index) => {
    const part = PART_STATS[module.type];
    const bonus = Number(part?.sensorRangeBonus) || 0;
    if (!(bonus > 0)) return null;
    const role = part.sensorRole === "directed"
      ? "directed"
      : part.sensorRole === "omniSmall" ? "omniSmall" : "omniLarge";
    const rotation = normalizeRotation(module.rotation, part.allowedRotations);
    return {
      index,
      type: module.type,
      bonus,
      role,
      arc: Math.max(0, Number(part.sensorArc) || 0) * Math.PI / 180,
      relativeAngle: role === "directed"
        ? directionalFootprintToShipRadians(rotation, part.footprint)
        : 0
    };
  }).filter(Boolean);
  const omni = sensors
    .filter((entry) => entry.role !== "directed")
    .sort((a, b) => b.bonus - a.bonus || a.index - b.index);
  const directed = sensors
    .filter((entry) => entry.role === "directed")
    .sort((a, b) => b.bonus - a.bonus || a.index - b.index);
  const stackedOmni = omni.map((entry, stackIndex) => {
    return {
      componentIndex: entry.index,
      type: entry.type,
      role: entry.role,
      stackIndex,
      nominalBonus: entry.bonus,
      effectiveBonus: entry.bonus
    };
  });
  const stackedDirected = directed.map((entry, stackIndex) => {
    const effectiveBonus = entry.bonus;
    return {
      componentIndex: entry.index,
      type: entry.type,
      role: entry.role,
      stackIndex,
      nominalBonus: entry.bonus,
      effectiveBonus,
      arc: entry.arc,
      relativeAngle: entry.relativeAngle
    };
  }).map((entry, _stackIndex, entries) => {
    const overlappingBonus = entries.reduce((total, candidate) => {
      const sameBearing = Math.abs(angleDifference(entry.relativeAngle, candidate.relativeAngle)) < 1e-9;
      return sameBearing && candidate.arc + 1e-9 >= entry.arc
        ? total + candidate.effectiveBonus
        : total;
    }, 0);
    return { ...entry, range: baseRange + overlappingBonus };
  });
  const omniBonus = stackedOmni.reduce((sum, entry) => sum + entry.effectiveBonus, 0);
  const strongestDirected = stackedDirected.reduce(
    (strongest, entry) => !strongest || entry.range > strongest.range ? entry : strongest,
    null
  );
  return {
    baseRange,
    omniRange: baseRange + omniBonus,
    directedRange: strongestDirected?.range || 0,
    directedArc: strongestDirected?.arc || 0,
    sensorComponentCount: sensors.length,
    directedSensorCount: directed.length,
    omniContributions: stackedOmni,
    directedContributions: stackedDirected
  };
}

export function computeStats(modules, options = {}) {
  const exhaustAnalysis = globalThis.EngineExhaustRules.analyze(modules, PART_STATS);
  let cost = 0;
  let mass = 0;
  const maxHp = nonCoreHullTotal(modules, PART_STATS);
  let maxShield = 0;
  let powerGeneration = 0;
  let powerUse = 0;
  let thrust = 0;
  const engineThrustValues = [];
  const engineComponentIndices = [];
  const engineMassValues = [];
  const turnModuleValues = [];
  let energyStorage = 0;
  let blaster = 0;
  let missile = 0;
  let railgun = 0;
  let beam = 0;
  let repair = 0;
  let repairRate = 0;
  const repairRateValues = [];
  let rangeBonus = 0;
  let accuracyBonus = 0;
  let fireRateBonus = 0;
  let coolingBonus = 0;
  let captureBonus = 0;
  let ecmStrength = 0;
  let frontDamageReduction = 0;
  let frontArc = 0;
  let pointDefense = 0;
  let droneBays = 0;
  let droneCapacity = 0;
  const droneSquads = { fighter: 0, defence: 0, repair: 0 };
  const dronesByType = { fighter: 0, defence: 0, repair: 0 };

  const weaponTotals = {
    blaster: weaponAccumulator(),
    missile: weaponAccumulator(),
    railgun: weaponAccumulator(),
    beam: weaponAccumulator(),
    pointDefense: weaponAccumulator()
  };

  let weaponBonusByIndex = null;
  if (DataSupportRules) {
    try {
      weaponBonusByIndex = DataSupportRules.analyzeDirectDataSupport(modules, options.dataLinks || [], PART_STATS).weaponBonusByIndex || [];
    } catch (_) {
      weaponBonusByIndex = null;
    }
  }

  const centerOfMass = calculateCenterOfMass(modules, PART_STATS);
  const isBlockedEngine = (index, module, part) => (part.thrust > 0 || module.type === "maneuverThruster") && !exhaustAnalysis.validEngineIndices.has(index);

  for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex += 1) {
    const module = modules[moduleIndex];
    const part = PART_STATS[module.type] || PART_STATS.frame;
    const blockedEngine = (part.thrust > 0 || module.type === "maneuverThruster") && !exhaustAnalysis.validEngineIndices.has(moduleIndex);

    cost += part.cost;
    mass += part.mass;
    maxShield += part.shield;
    powerGeneration += part.powerGeneration || 0;
    powerUse += part.powerUse || 0;
    thrust += blockedEngine ? 0 : part.thrust;
    if (part.thrust > 0 && !blockedEngine) {
      engineThrustValues.push(part.thrust);
      engineComponentIndices.push(moduleIndex);
      engineMassValues.push(part.mass || 0);
    }

    // Power sources are separate from storage. Only explicit storage capacity
    // on non-generating components contributes to player-facing totals.
    if ((part.powerGeneration || 0) <= 0) energyStorage += part.energyStorage || 0;
    blaster += part.blaster || 0;
    missile += part.missile || 0;
    railgun += part.railgun || 0;
    beam += part.beam || 0;
    pointDefense += part.pointDefense || 0;
    if (module.type === "droneBay") {
      droneBays += 1;
      const squadSize = Math.max(0, Number(part.droneConfig?.squadSize) || 0);
      droneCapacity += squadSize;
      if (Object.prototype.hasOwnProperty.call(droneSquads, module.droneType)) {
        droneSquads[module.droneType] += 1;
        dronesByType[module.droneType] += squadSize;
      }
    }
    repair += part.repair || 0;
    if ((part.repairRate || 0) > 0) repairRateValues.push(part.repairRate);

    rangeBonus += part.rangeBonus || 0;
    accuracyBonus += part.accuracyBonus || 0;
    fireRateBonus += part.fireRateBonus || 0;
    // Cooling is placement-dependent and modeled by the thermal overlay.
    captureBonus += part.captureBonus || 0;

    if (part.ecmStrength) ecmStrength += part.ecmStrength;

    if (part.frontDamageReduction) {
      frontDamageReduction += part.frontDamageReduction;
      if (part.frontArc > frontArc) frontArc = part.frontArc;
    }

    if (part.weapon && weaponTotals[part.weapon.type]) {
      const support = weaponBonusByIndex ? weaponBonusByIndex[moduleIndex] : null;
      const fireRateMultiplier = support ? 1 + (Number(support.fireRateBonus) || 0) : 1;
      addWeaponStats(weaponTotals[part.weapon.type], part.weapon, fireRateMultiplier);
    }
  }

  const repairRateInstalled = installedRepairRate(repairRateValues);
  repairRate = getEffectiveRepairRate(repairRateValues, GENERATED_BALANCE);
  const baseShieldStats = ShieldRules.calculateShieldStats(modules, PART_STATS);
  const shieldStats = baseShieldStats;

  applyWeaponUtilityBonuses(weaponTotals, {
    rangeBonus,
    accuracyBonus,
    fireRateBonus: weaponBonusByIndex ? 0 : fireRateBonus,
    coolingBonus
  });

  const powerFlow = calculateUniversalPower(modules, PART_STATS);
  const availablePower = powerFlow.summary.availableGenerationMw;
  const powerRatio = powerFlow.summary.powerRatio;
  const power = availablePower - powerUse;
  const efficiency = powerRatio;
  const componentPowerMultiplier = (index) => powerFlow.byComponentIndex[index]?.operationalMultiplier ?? 1;

  const directionalTurnInputs = calculateDirectionalTurnInputs(modules, PART_STATS, {
    centerOfMass,
    isBlockedEngine,
    componentMultiplier: componentPowerMultiplier
  });
  const turnBonus = calculateGenericTurnModifier(modules, PART_STATS, {
    isBlockedEngine,
    componentMultiplier: componentPowerMultiplier
  });
  const poweredEngineThrustValues = engineThrustValues.map((value, index) => value * componentPowerMultiplier(engineComponentIndices[index]));
  const movement = calculateMovementStats({
    mass,
    thrust,
    turnBonus,
    powerGeneration: availablePower,
    powerUse,
    engineThrustValues: poweredEngineThrustValues,
    engineMassValues,
    turnModuleValues,
    directionalTurnInputs
  });
  const sensorProfile = blueprintSensorProfile(modules);

  ecmStrength = Math.min(ecmStrength, 0.55);
  frontDamageReduction = Math.min(frontDamageReduction, 0.35);

  const unitCost = cost;
  const fleetRules = FLEET_COUNT_RULES;
  const fleetCount = clamp(
    Math.floor(
      (Number(fleetRules.base) || 260) /
        Math.max(
          Number(fleetRules.minimumDivisor) || 58,
          unitCost * (Number(fleetRules.unitCostMultiplier) || 0.72) +
            mass * (Number(fleetRules.massMultiplier) || 0.45)
        )
    ),
    Number(fleetRules.minimum) || 1,
    Number(fleetRules.maximum) || 5
  );

  const warnings = shipWarnings({
    modules,
    powerGeneration,
    powerUse,
    availablePower,
    thrust,
    effectiveThrust: movement.effectiveThrust,
    thrustRatio: movement.thrustRatio,
    blaster,
    missile,
    railgun,
    beam,
    pointDefense,
    droneBays,
    droneCapacity,
    droneSquads,
    dronesByType,
    mass,
    turnRate: movement.turnRate,
    turnRateLeft: movement.turnRateLeft,
    turnRateRight: movement.turnRateRight,
    directionalTurn: movement.directionalTurn,
    repair,
    shield: maxShield,
    modules,
    powerEfficiency: movement.powerEfficiency,
    powerDebuff: movement.powerDebuff
  });
  if (exhaustAnalysis.blockedEngineIndices.size) warnings.push(`${exhaustAnalysis.blockedEngineIndices.size} blocked engine${exhaustAnalysis.blockedEngineIndices.size === 1 ? "" : "s"}: blocked exhaust provides no thrust.`);

  return {
    cost,
    unitCost,
    mass: Math.round(mass * 100) / 100,
    maxHp,
    maxShield: Math.round(shieldStats.capacity),
    shieldRegen: Number(shieldStats.recharge.toFixed(2)),
    baseMaxShield: Math.round(baseShieldStats.capacity),
    baseShieldRegen: Number(baseShieldStats.recharge.toFixed(2)),
    powerGeneration,
    powerUse,
    power,
    availablePower: Number(availablePower.toFixed(2)),
    powerRatio: Number(powerRatio.toFixed(2)),
    powerStorageDischarge: Number(powerFlow.summary.storageDischargeMw.toFixed(2)),
    efficiency: Number(efficiency.toFixed(2)),
    thrust,
    effectiveThrust: Math.round(movement.effectiveThrust),
    engineEfficiency: thrust > 0 ? movement.effectiveThrust / thrust : 0,
    powerEfficiency: Number(movement.powerEfficiency.toFixed(2)),
    powerDebuff: Number(movement.powerDebuff.toFixed(2)),
    energyStorage,
    accel: Math.round(movement.accel),
    brakingAcceleration: movement.brakingAcceleration,
    maxSpeed: movement.maxSpeed,
    turnRate: movement.turnRate,
    turnRateLeft: movement.turnRateLeft,
    turnRateRight: movement.turnRateRight,
    massClass: movement.massClass,
    turnCap: movement.turnCap,
    thrustRatio: Number(movement.thrustRatio.toFixed(2)),
    blaster,
    missile,
    railgun,
    beam,
    pointDefense,
    repair,
    repairRateInstalled,
    repairRateSourceCount: repairRateValues.length,
    repairRate,
    coolingBonus: Number(coolingBonus.toFixed(2)),
    captureBonus: Number(captureBonus.toFixed(2)),
    blasterRange: weaponRange(weaponTotals.blaster),
    missileRange: weaponRange(weaponTotals.missile),
    railgunRange: weaponRange(weaponTotals.railgun),
    beamRange: weaponRange(weaponTotals.beam),
    beamRadius: weaponTotals.beam.radius,
    weaponDps: Number(
      (
        weaponTotals.blaster.dps +
        weaponTotals.missile.dps +
        weaponTotals.railgun.dps +
        weaponTotals.beam.dps +
        (weaponTotals.pointDefense.dps * 0.04)
      ).toFixed(1)
    ),
    weaponDpsLabel: weaponDpsLabel(weaponTotals),
    weapons: summarizeWeaponTotals(weaponTotals),
    blockedEngines: exhaustAnalysis.blockedEngineIndices.size,
    warnings,
    fleetCount,
    baseSensorRange: sensorProfile.baseRange,
    sensorRange: Number(sensorProfile.omniRange.toFixed(1)),
    directedSensorRange: Number(sensorProfile.directedRange.toFixed(1)),
    directedSensorArc: sensorProfile.directedArc,
    sensorComponentCount: sensorProfile.sensorComponentCount,
    directedSensorCount: sensorProfile.directedSensorCount,
    sensorContributions: {
      baseRange: sensorProfile.baseRange,
      omni: sensorProfile.omniContributions,
      directed: sensorProfile.directedContributions
    }
  };
}

export function weaponAccumulator() {
  return {
    count: 0,
    damage: 0,
    range: 0,
    radius: 0,
    fireRate: 0,
    reload: 0,
    projectileSpeed: 0,
    accuracy: 0,
    tracking: 0,
    dps: 0,
    rateProfiles: []
  };
}

export function addWeaponStats(total, weapon, fireRateMultiplier = 1) {
  const effectiveFireRate = Math.max(0, (Number(weapon.fireRate) || 0) * (Number(fireRateMultiplier) || 0));
  const effectiveWeapon = { ...weapon, fireRate: effectiveFireRate };
  const presentation = WeaponPresentationRules.weaponCyclePresentation(effectiveWeapon);
  total.count += 1;
  total.damage += weapon.damage;
  total.range = Math.max(total.range, weapon.range);
  total.radius = Math.max(total.radius, weapon.radius || 0);
  total.fireRate += effectiveFireRate;
  total.reload += presentation.reloadSeconds;
  total.projectileSpeed += weapon.projectileSpeed;
  total.accuracy += weapon.accuracy;
  total.tracking += weapon.tracking || 0;
  total.dps += presentation.dps;
  total.rateProfiles.push(effectiveWeapon);
}

function recalculateRateDependentStats(total, fireRateMultiplier) {
  if (!Array.isArray(total.rateProfiles)) return;
  const multiplier = Number.isFinite(Number(fireRateMultiplier)) ? Number(fireRateMultiplier) : 1;
  total.fireRate = 0;
  total.reload = 0;
  total.dps = 0;
  for (const weapon of total.rateProfiles) {
    const effectiveWeapon = { ...weapon, fireRate: Math.max(0, (Number(weapon.fireRate) || 0) * multiplier) };
    const presentation = WeaponPresentationRules.weaponCyclePresentation(effectiveWeapon);
    total.fireRate += effectiveWeapon.fireRate;
    total.reload += presentation.reloadSeconds;
    total.dps += presentation.dps;
  }
}

export function applyWeaponUtilityBonuses(totals, bonuses) {
  const hasWeapons = Object.values(totals).some((total) => total.count > 0);
  if (!hasWeapons) return;

  const rangeBonus = Number(bonuses.rangeBonus) || 0;
  const accuracyBonus = Number(bonuses.accuracyBonus) || 0;
  const totalWeaponCount = Object.values(totals).reduce((sum, t) => sum + t.count, 0);
  const fireRateMultiplier = 1 + (totalWeaponCount > 0 ? (Number(bonuses.fireRateBonus) || 0) / totalWeaponCount : 0);

  for (const total of Object.values(totals)) {
    if (total.count <= 0) continue;

    total.range += rangeBonus;
    total.accuracy = Math.min(total.count, total.accuracy + accuracyBonus * total.count);
    recalculateRateDependentStats(total, fireRateMultiplier);
  }
}

export function calculateDps(weapon) {
  return Number(WeaponPresentationRules.weaponCyclePresentation(weapon).dps.toFixed(1));
}

export function calculateReload(weapon) {
  return Number(WeaponPresentationRules.weaponCyclePresentation(weapon).reloadSeconds.toFixed(2));
}

export function weaponRange(total) {
  return total.count > 0 ? total.range : 0;
}

export function summarizeWeaponTotals(totals) {
  const result = {};

  for (const [type, total] of Object.entries(totals)) {
    result[type] = {
      count: total.count,
      damage: total.damage,
      range: total.range,
      radius: total.radius,
      fireRate: Number(total.fireRate.toFixed(2)),
      reload: total.count ? Number((total.reload / total.count).toFixed(2)) : 0,
      projectileSpeed: total.count ? Math.round(total.projectileSpeed / total.count) : 0,
      accuracy: total.count ? Number((total.accuracy / total.count).toFixed(2)) : 0,
      tracking: total.count ? Number((total.tracking / total.count).toFixed(2)) : 0,
      dps: Number(total.dps.toFixed(1)),
      dpsLabel: WeaponPresentationRules.dpsLabelForProfiles(total.rateProfiles),
      hasChargeWeapon: (Array.isArray(total.rateProfiles) ? total.rateProfiles : [])
        .some((weapon) => WeaponPresentationRules.isSpinalChargeWeapon(weapon))
    };
  }

  return result;
}

export function weaponDpsLabel(totals) {
  const profiles = Object.values(totals || {}).flatMap((total) => Array.isArray(total.rateProfiles) ? total.rateProfiles : []);
  return profiles.some((weapon) => WeaponPresentationRules.isSpinalChargeWeapon(weapon))
    ? "Weapon DPS (ideal charge cycle)"
    : "Weapon DPS";
}

export function shipWarnings(stats) {
  const warnings = [];

  const effectiveThrust = Number(stats.effectiveThrust || 0);
  const thrustRatio = Number(stats.thrustRatio || 0);
  const powerUse = Number(stats.powerUse || 0);
  const availablePower = Number(stats.availablePower ?? stats.powerGeneration ?? 0);

  const weaponCount =
    Number(stats.blaster || 0) +
    Number(stats.missile || 0) +
    Number(stats.railgun || 0) +
    Number(stats.beam || 0) +
    Number(stats.pointDefense || 0);

  // Keep warnings for clear, actionable problems.
  // Softer trade-offs like "heavy", "slow", or "average mobility" should be handled by stat colour-coding.

  if (powerUse > availablePower + 0.0005) {
    warnings.push(`Power shortage: ${availablePower.toFixed(1)} MW available for ${powerUse.toFixed(1)} MW demand.`);
  }

  if (effectiveThrust <= 0) {
    warnings.push("No effective thrust: add engines.");
  }

  if (weaponCount === 0) {
    warnings.push("No weapons installed: this ship cannot attack.");
  }

  const hasBackupCore = (stats.modules || []).some((module) => module.type === "backupCore");
  if (hasBackupCore) {
    warnings.push("Backup available: ship can survive main Core loss");
  } else {
    warnings.push("Main Core only: destruction disables ship");
  }

  // Only warn about mobility when it is genuinely severe.
  // Do not warn just because the ship is medium/heavy.
  if (effectiveThrust > 0 && thrustRatio > 0 && thrustRatio < 1.2) {
    warnings.push("Severe mobility issue: thrust is very low for this ship's mass.");
  }

  return dedupeWarnings(warnings);
}

function dedupeWarnings(warnings) {
  return [...new Set(warnings.filter(Boolean))];
}


