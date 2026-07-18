// Calculations for ship statistics, speed cap scales, mass classes, power efficiency, cost breakdown, and builder warnings.

import { clamp } from "../shared/math.js";
import { PART_STATS } from "./parts.js";
import { SHIP_ECONOMY } from "../constants.js";
import { isConnected, isOverlapping, isOutOfBounds } from "./blueprintValidation.js";
import { getOccupiedCells } from "./footprint.js";
import ShieldRules from "../shared/shieldRules.js";
import { calculateMovementStats,
  calculateCenterOfMass,
  calculateDirectionalTurnInputs, calculateSystemEfficiency, effectiveStackedValue } from "../shared/movementStats.js";

const WiringRules = globalThis.WiringRules;
if (!WiringRules) {
  throw new Error("WiringRules must load before componentStats.js");
}

export function computeStats(modules, options = {}) {
  const exhaustAnalysis = globalThis.EngineExhaustRules.analyze(modules, PART_STATS);
  let cost = 0;
  let mass = 0;
  let maxHp = 0;
  let maxShield = 0;
  let powerGeneration = 0;
  let powerUse = 0;
  let thrust = 0;
  let turnBonus = 0;
  const engineThrustValues = [];
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

  const weaponTotals = {
    blaster: weaponAccumulator(),
    missile: weaponAccumulator(),
    railgun: weaponAccumulator(),
    beam: weaponAccumulator(),
    pointDefense: weaponAccumulator()
  };

  const centerOfMass = calculateCenterOfMass(modules, PART_STATS);

  for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex += 1) {
    const module = modules[moduleIndex];
    const part = PART_STATS[module.type] || PART_STATS.frame;
    const blockedEngine = (part.thrust > 0 || module.type === "maneuverThruster") && !exhaustAnalysis.validEngineIndices.has(moduleIndex);

    cost += part.cost;
    mass += part.mass;
    maxHp += part.hp;
    maxShield += part.shield;
    powerGeneration += part.powerGeneration || 0;
    powerUse += part.powerUse || 0;
    thrust += blockedEngine ? 0 : part.thrust;
    if (module.type !== "maneuverThruster" && module.type !== "gyroscope") turnBonus += blockedEngine ? 0 : part.turn;

    if (part.thrust > 0 && !blockedEngine) {
      engineThrustValues.push(part.thrust);
      engineMassValues.push(part.mass || 0);
    }

    energyStorage += part.energyStorage || 0;
    blaster += part.blaster || 0;
    missile += part.missile || 0;
    railgun += part.railgun || 0;
    beam += part.beam || 0;
    pointDefense += part.pointDefense || 0;
    repair += part.repair || 0;
    repairRate += part.repairRate || 0;

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
      addWeaponStats(weaponTotals[part.weapon.type], part.weapon);
    }
  }

  repairRate = effectiveStackedValue(repairRateValues, 0.62);
  const baseShieldStats = ShieldRules.calculateShieldStats(modules, PART_STATS);
  const effectiveShieldStats = calculateBlueprintEffectiveShieldStats(modules, options.wiring);
  const shieldStats = options.wiring ? effectiveShieldStats : baseShieldStats;

  applyWeaponUtilityBonuses(weaponTotals, {
    rangeBonus,
    accuracyBonus,
    fireRateBonus,
    coolingBonus
  });

  const power = powerGeneration - powerUse;
  const efficiency = calculateSystemEfficiency(powerGeneration, powerUse);

  const directionalTurnInputs = calculateDirectionalTurnInputs(modules, PART_STATS, {
    centerOfMass,
    isBlockedEngine: (index, module, part) => (part.thrust > 0 || module.type === "maneuverThruster") && !exhaustAnalysis.validEngineIndices.has(index)
  });
  const movement = calculateMovementStats({
    mass,
    thrust,
    turnBonus,
    powerGeneration,
    powerUse,
    engineThrustValues,
    engineMassValues,
    turnModuleValues,
    directionalTurnInputs
  });

  ecmStrength = Math.min(ecmStrength, 0.55);
  frontDamageReduction = Math.min(frontDamageReduction, 0.35);

  const costBreakdown = calculateCostBreakdown({
    cost,
    mass,
    maxHp,
    maxShield,
    repairRate,
    blaster,
    missile,
    railgun,
    beam
  });

  const unitCost = costBreakdown.total;
  const fleetCount = clamp(Math.floor(260 / Math.max(58, unitCost * 0.72 + mass * 0.45)), 1, 5);

  const warnings = shipWarnings({
    powerGeneration,
    powerUse,
    thrust,
    effectiveThrust: movement.effectiveThrust,
    thrustRatio: movement.thrustRatio,
    blaster,
    missile,
    railgun,
    beam,
    pointDefense,
    mass,
    turnRate: movement.turnRate,
    turnRateLeft: movement.turnRateLeft,
    turnRateRight: movement.turnRateRight,
    repair,
    shield: maxShield,
    modules,
    speedCapped: movement.speedCapped,
    speed: movement.maxSpeed,
    powerEfficiency: movement.powerEfficiency,
    powerDebuff: movement.powerDebuff
  });
  if (exhaustAnalysis.blockedEngineIndices.size) warnings.push(`${exhaustAnalysis.blockedEngineIndices.size} blocked engine${exhaustAnalysis.blockedEngineIndices.size === 1 ? "" : "s"}: blocked exhaust provides no thrust.`);

  return {
    cost,
    unitCost,
    mass: Math.round(mass),
    maxHp: Math.max(140, Math.round(maxHp * 1.15)),
    maxShield: Math.round(shieldStats.capacity),
    shieldRegen: Number(shieldStats.recharge.toFixed(2)),
    baseMaxShield: Math.round(baseShieldStats.capacity),
    baseShieldRegen: Number(baseShieldStats.recharge.toFixed(2)),
    powerGeneration,
    powerUse,
    power,
    efficiency: Number(efficiency.toFixed(2)),
    thrust,
    effectiveThrust: Math.round(movement.effectiveThrust),
    engineEfficiency: thrust > 0 ? movement.effectiveThrust / thrust : 0,
    powerEfficiency: Number(movement.powerEfficiency.toFixed(2)),
    powerDebuff: Number(movement.powerDebuff.toFixed(2)),
    energyStorage,
    accel: Math.round(movement.accel),
    maxSpeed: movement.maxSpeed,
    turnRate: movement.turnRate,
    turnRateLeft: movement.turnRateLeft,
    turnRateRight: movement.turnRateRight,
    massClass: movement.massClass,
    speedCap: movement.speedCap,
    turnCap: movement.turnCap,
    thrustRatio: Number(movement.thrustRatio.toFixed(2)),
    blaster,
    missile,
    railgun,
    beam,
    pointDefense,
    repair,
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
        weaponTotals.beam.dps
      ).toFixed(1)
    ),
    weapons: summarizeWeaponTotals(weaponTotals),
    blockedEngines: exhaustAnalysis.blockedEngineIndices.size,
    warnings,
    costBreakdown,
    fleetCount
  };
}

export function calculateBlueprintEffectiveShieldStats(modules, wiring) {
  if (!wiring) return ShieldRules.calculateShieldStats(modules, PART_STATS);
  let analysis;
  try { analysis = WiringRules.analyzePowerNetworks(modules, wiring, PART_STATS); }
  catch (_) { analysis = { networks: [], networkByComponent: new Map() }; }
  const networkByComponent = analysis.networkByComponent || new Map();
  return ShieldRules.calculateShieldStats(modules, PART_STATS, {
    powerMultiplier: (index, module, part) => {
      if (!((Number(part.shield) || 0) > 0 || (Number(part.shieldRegen) || 0) > 0)) return 1;
      const network = networkByComponent.get(index);
      if (!network || !(network.sourceIndices || []).length) return 0;
      return clamp(Number(network.availableEfficiency), 0, 1);
    },
    heatMultiplier: () => 1
  });
}

export function calculateCostBreakdown(stats) {
  const base = SHIP_ECONOMY.baseShipCost;
  const parts = stats.cost * SHIP_ECONOMY.partCostMultiplier;
  const mass = stats.mass * SHIP_ECONOMY.massCostMultiplier;
  const hull = stats.maxHp * SHIP_ECONOMY.hullCostMultiplier;
  const shield = stats.maxShield * SHIP_ECONOMY.shieldCostMultiplier;
  const repair = stats.repairRate * SHIP_ECONOMY.repairCostMultiplier;

  const weaponPremium =
    stats.blaster * SHIP_ECONOMY.weaponPremiums.blaster +
    stats.missile * SHIP_ECONOMY.weaponPremiums.missile +
    stats.railgun * SHIP_ECONOMY.weaponPremiums.railgun +
    (stats.beam || 0) * (SHIP_ECONOMY.weaponPremiums.beam || SHIP_ECONOMY.weaponPremiums.railgun);

  const preTaxTotal = base + parts + mass + hull + shield + repair + weaponPremium;
  const largeTax = Math.max(0, preTaxTotal - SHIP_ECONOMY.largeShipThreshold) * SHIP_ECONOMY.largeShipCostTax;
  const hugeTax = Math.max(0, preTaxTotal - SHIP_ECONOMY.hugeShipThreshold) * SHIP_ECONOMY.hugeShipCostTax;
  const sizeTax = largeTax + hugeTax;

  return {
    base: Math.round(base),
    parts: Math.round(parts),
    mass: Math.round(mass),
    hull: Math.round(hull),
    shield: Math.round(shield),
    repair: Math.round(repair),
    weaponPremium: Math.round(weaponPremium),
    sizeTax: Math.round(sizeTax),
    total: Math.round(preTaxTotal + sizeTax)
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
    dps: 0
  };
}

export function addWeaponStats(total, weapon) {
  total.count += 1;
  total.damage += weapon.damage;
  total.range = Math.max(total.range, weapon.range);
  total.radius = Math.max(total.radius, weapon.radius || 0);
  total.fireRate += weapon.fireRate;
  total.reload += calculateReload(weapon);
  total.projectileSpeed += weapon.projectileSpeed;
  total.accuracy += weapon.accuracy;
  total.tracking += weapon.tracking || 0;
  total.dps += calculateDps(weapon);
}

export function applyWeaponUtilityBonuses(totals, bonuses) {
  const hasWeapons = Object.values(totals).some((total) => total.count > 0);
  if (!hasWeapons) return;

  const rangeBonus = Number(bonuses.rangeBonus) || 0;
  const accuracyBonus = Number(bonuses.accuracyBonus) || 0;
  const fireRateMultiplier = 1 + (Number(bonuses.fireRateBonus) || 0);

  for (const total of Object.values(totals)) {
    if (total.count <= 0) continue;

    total.range += rangeBonus;
    total.accuracy = Math.min(total.count, total.accuracy + accuracyBonus * total.count);
    total.fireRate *= fireRateMultiplier;
    total.dps *= fireRateMultiplier;
    total.reload = fireRateMultiplier > 0 ? total.reload / fireRateMultiplier : total.reload;
  }
}

export function calculateDps(weapon) {
  return Number(((weapon.damage || 0) * (weapon.fireRate || 0)).toFixed(1));
}

export function calculateReload(weapon) {
  return Number((1 / Math.max(0.01, weapon.fireRate || 1)).toFixed(2));
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
      dps: Number(total.dps.toFixed(1))
    };
  }

  return result;
}

export function shipWarnings(stats) {
  const warnings = [];

  const powerUse = Number(stats.powerUse || 0);
  const powerGeneration = Number(stats.powerGeneration || 0);
  const effectiveThrust = Number(stats.effectiveThrust || 0);
  const thrustRatio = Number(stats.thrustRatio || 0);
  const powerDebuff = Number(stats.powerDebuff || 0);

  const weaponCount =
    Number(stats.blaster || 0) +
    Number(stats.missile || 0) +
    Number(stats.railgun || 0) +
    Number(stats.beam || 0) +
    Number(stats.pointDefense || 0);

  const modules = Array.isArray(stats.modules) ? stats.modules : [];
  const hasReactor = modules.some((module) => module.type === "reactor");

  const coreGeneration = Number(PART_STATS.core?.powerGeneration || 0);
  const isUnderpowered = powerUse > powerGeneration;
  const hasShield = Number(stats.shield || 0) > 0;
  const hasRepair = Number(stats.repair || 0) > 0;

  // Keep warnings for clear, actionable problems.
  // Softer trade-offs like "heavy", "slow", or "average mobility" should be handled by stat colour-coding.

  if (isUnderpowered) {
    warnings.push(
      `Power overdraw: uses ${formatStatNumber(powerUse)} MW / generates ${formatStatNumber(powerGeneration)} MW. Add reactors or remove high-power modules.`
    );
  }

  if (!hasReactor && powerUse > coreGeneration && !isUnderpowered) {
    warnings.push("No reactor installed: add a reactor for high-power systems.");
  }

  if (effectiveThrust <= 0) {
    warnings.push("No effective thrust: add engines or fix power supply.");
  }

  if (weaponCount === 0) {
    warnings.push("No weapons installed: this ship cannot attack.");
  }

  if (isUnderpowered && (hasShield || hasRepair || effectiveThrust > 0 || powerDebuff > 0)) {
    const affected = [];

    if (effectiveThrust > 0 || powerDebuff > 0) affected.push("engines");
    if (hasShield) affected.push("shields");
    if (hasRepair) affected.push("repair");

    if (affected.length > 0) {
      warnings.push(`Underpowered systems may reduce ${joinList(affected)} performance.`);
    }
  }

  // Only warn about mobility when it is genuinely severe.
  // Do not warn just because the ship is medium/heavy.
  if (effectiveThrust > 0 && thrustRatio > 0 && thrustRatio < 1.2) {
    warnings.push("Severe mobility issue: thrust is very low for this ship's mass.");
  }

  // Only show this if the movement system explicitly flags a cap.
  if (stats.speedCapped === true && Number(stats.speed || 0) > 0) {
    warnings.push("Mass drag is limiting top speed. Add thrust or reduce mass.");
  }

  return dedupeWarnings(warnings);
}

function formatStatNumber(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function joinList(items) {
  if (items.length <= 1) return items[0] || "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function dedupeWarnings(warnings) {
  return [...new Set(warnings.filter(Boolean))];
}

export function estimatePartEffectiveCost(type, design) {
  const baseDesign = Array.isArray(design) ? design.map((part) => ({ ...part })) : [];
  const current = computeStats(baseDesign);
  const occupied = new Set();

  for (let i = 0; i < baseDesign.length; i += 1) {
    const part = baseDesign[i];
    const stat = PART_STATS[part.type] || PART_STATS.frame;
    const footprint = stat.footprint || { width: 1, height: 1 };
    const cells = getOccupiedCells(part.x, part.y, footprint, part.rotation || 0);

    for (const cell of cells) {
      occupied.add(`${cell.x},${cell.y}`);
    }
  }

  const dx = [1, -1, 0, 0];
  const dy = [0, 0, 1, -1];

  for (let i = 0; i < baseDesign.length; i += 1) {
    const part = baseDesign[i];
    const stat = PART_STATS[part.type] || PART_STATS.frame;
    const footprint = stat.footprint || { width: 1, height: 1 };
    const cells = getOccupiedCells(part.x, part.y, footprint, part.rotation || 0);

    for (const cell of cells) {
      for (let d = 0; d < 4; d += 1) {
        const cx = cell.x + dx[d];
        const cy = cell.y + dy[d];

        if (cx < 0 || cx > 14 || cy < 0 || cy > 14) continue;
        if (occupied.has(`${cx},${cy}`)) continue;

        const candidate = [...baseDesign, { x: cx, y: cy, type }];

        if (!isOutOfBounds(candidate) && !isOverlapping(candidate) && isConnected(candidate)) {
          const updated = computeStats(candidate);
          return Math.max(0, updated.unitCost - current.unitCost);
        }
      }
    }
  }

  return estimateFormulaPartCost(type);
}

export function estimateFormulaPartCost(type) {
  const stat = PART_STATS[type] || PART_STATS.frame;

  const weaponPremium =
    (stat.blaster || 0) * SHIP_ECONOMY.weaponPremiums.blaster +
    (stat.missile || 0) * SHIP_ECONOMY.weaponPremiums.missile +
    (stat.railgun || 0) * SHIP_ECONOMY.weaponPremiums.railgun +
    (stat.beam || 0) * (SHIP_ECONOMY.weaponPremiums.beam || SHIP_ECONOMY.weaponPremiums.railgun);

  return Math.max(
    1,
    Math.round(
      stat.cost * SHIP_ECONOMY.partCostMultiplier +
        stat.mass * SHIP_ECONOMY.massCostMultiplier +
        stat.hp * SHIP_ECONOMY.hullCostMultiplier +
        stat.shield * SHIP_ECONOMY.shieldCostMultiplier +
        (stat.repairRate || 0) * SHIP_ECONOMY.repairCostMultiplier +
        weaponPremium
    )
  );
}
