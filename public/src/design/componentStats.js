// Calculations for ship statistics, speed cap scales, mass classes, power efficiency, cost breakdown, and builder warnings.

import { clamp, softCap } from "../shared/math.js";
import { PART_STATS } from "./parts.js";
import { SHIP_ECONOMY } from "../constants.js";
import { formatPercent } from "./statFormatting.js";
import { isConnected } from "./blueprintValidation.js";

export function computeStats(modules) {
  let cost = 0;
  let mass = 0;
  let maxHp = 0;
  let maxShield = 0;
  let shieldRegen = 0;
  let powerGeneration = 0;
  let powerUse = 0;
  let thrust = 0;
  let turnBonus = 0;
  const engineThrustValues = [];
  const turnModuleValues = [];
  let energyStorage = 0;
  let blaster = 0;
  let missile = 0;
  let railgun = 0;
  let repair = 0;
  let repairRate = 0;
  let rangeBonus = 0;
  let accuracyBonus = 0;
  let fireRateBonus = 0;
  let coolingBonus = 0;
  let captureBonus = 0;
  const weaponTotals = {
    blaster: weaponAccumulator(),
    missile: weaponAccumulator(),
    railgun: weaponAccumulator()
  };

  for (const module of modules) {
    const part = PART_STATS[module.type] || PART_STATS.frame;
    cost += part.cost;
    mass += part.mass;
    maxHp += part.hp;
    maxShield += part.shield;
    shieldRegen += part.shieldRegen || 0;
    powerGeneration += part.powerGeneration || 0;
    powerUse += part.powerUse || 0;
    thrust += part.thrust;
    turnBonus += part.turn;
    if (part.thrust > 0) engineThrustValues.push(part.thrust);
    if (part.turn > 0) turnModuleValues.push(part.turn);
    energyStorage += part.energyStorage || 0;
    blaster += part.blaster || 0;
    missile += part.missile || 0;
    railgun += part.railgun || 0;
    repair += part.repair || 0;
    repairRate += part.repairRate || 0;
    rangeBonus += part.rangeBonus || 0;
    accuracyBonus += part.accuracyBonus || 0;
    fireRateBonus += part.fireRateBonus || 0;
    coolingBonus += Math.max(0, -(part.heat || 0)) * 0.01;
    captureBonus += part.captureBonus || 0;
    if (part.weapon) addWeaponStats(weaponTotals[part.weapon.type], part.weapon);
  }

  applyWeaponUtilityBonuses(weaponTotals, { rangeBonus, accuracyBonus, fireRateBonus, coolingBonus });
  const power = powerGeneration - powerUse;
  const efficiency = calculateSystemEfficiency(powerGeneration, powerUse);
  const movement = calculateMovementStats({ mass, thrust, turnBonus, powerGeneration, powerUse, engineThrustValues, turnModuleValues });
  const costBreakdown = calculateCostBreakdown({ cost, mass, maxHp, maxShield, repairRate, blaster, missile, railgun });
  const unitCost = costBreakdown.total;
  const fleetCount = clamp(Math.floor(260 / Math.max(58, unitCost * 0.72 + mass * 0.45)), 1, 5);
  const warnings = shipWarnings({ powerGeneration, powerUse, thrust, effectiveThrust: movement.effectiveThrust, thrustRatio: movement.thrustRatio, blaster, missile, railgun, mass, turnRate: movement.turnRate, repair, shield: maxShield, modules, speedCapped: movement.speedCapped, powerEfficiency: movement.powerEfficiency, powerDebuff: movement.powerDebuff });

  return {
    cost,
    unitCost,
    mass: Math.round(mass),
    maxHp: Math.max(140, Math.round(maxHp * 0.82)),
    maxShield: Math.round(maxShield * efficiency),
    shieldRegen: Number((shieldRegen * clamp(efficiency, 0.4, 1.12)).toFixed(2)),
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
    massClass: movement.massClass,
    speedCap: movement.speedCap,
    turnCap: movement.turnCap,
    thrustRatio: Number(movement.thrustRatio.toFixed(2)),
    blaster,
    missile,
    railgun,
    repair,
    repairRate,
    coolingBonus: Number(coolingBonus.toFixed(2)),
    captureBonus: Number(captureBonus.toFixed(2)),
    blasterRange: weaponRange(weaponTotals.blaster),
    missileRange: weaponRange(weaponTotals.missile),
    railgunRange: weaponRange(weaponTotals.railgun),
    weaponDps: Number((weaponTotals.blaster.dps + weaponTotals.missile.dps + weaponTotals.railgun.dps).toFixed(1)),
    weapons: summarizeWeaponTotals(weaponTotals),
    warnings,
    costBreakdown,
    fleetCount
  };
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
    stats.railgun * SHIP_ECONOMY.weaponPremiums.railgun;
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
  return { count: 0, damage: 0, range: 0, fireRate: 0, reload: 0, projectileSpeed: 0, accuracy: 0, tracking: 0, dps: 0 };
}

export function addWeaponStats(total, weapon) {
  total.count += 1;
  total.damage += weapon.damage;
  total.range = Math.max(total.range, weapon.range);
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
  const fireRateMultiplier = 1 + (Number(bonuses.fireRateBonus) || 0) + (Number(bonuses.coolingBonus) || 0);
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

export function calculateMovementStats({ mass, thrust, turnBonus, powerGeneration, powerUse, engineThrustValues, turnModuleValues }) {
  const safeMass = Math.max(mass, 1);
  const effectiveThrust = effectiveStackedValue(engineThrustValues, 0.88);
  const positiveTurn = effectiveStackedValue(turnModuleValues, 0.92);
  const negativeTurnDrag = Math.min(0, turnBonus);
  const effectiveTurnBonus = positiveTurn + negativeTurnDrag;
  const thrustRatio = effectiveThrust / safeMass;
  const hasEngineThrust = effectiveThrust > 0;
  const powerRatio = powerUse > 0 ? powerGeneration / powerUse : 1.1;
  const movementPowerMultiplier = calculateMovementPowerMultiplier(powerGeneration, powerUse);
  const powerEfficiency = clamp(powerRatio, 0, 1.1);
  const massSpeedPenalty = 1 / Math.pow(1 + safeMass / 95, 0.55);
  const massAccelPenalty = 1 / Math.pow(1 + safeMass / 76, 0.75);
  const massTurnPenalty = 1 / Math.pow(1 + safeMass / 82, 0.82);
  const rawSpeed = (90 + Math.sqrt(thrustRatio) * 52) * massSpeedPenalty * movementPowerMultiplier;
  const rawAccel = (45 + Math.sqrt(effectiveThrust) * 7) * massAccelPenalty * movementPowerMultiplier;
  const rawTurn = Math.max(0.22, (0.72 + effectiveTurnBonus * 1.34) * massTurnPenalty * movementPowerMultiplier);
  const speedCap = speedCapForMass(safeMass);
  const turnCap = turnCapForMass(safeMass);
  const cappedSpeed = hasEngineThrust ? softCap(rawSpeed, speedCap, 0.25) : 0;
  const cappedTurn = softCap(rawTurn, turnCap, 0.2);

  return {
    maxSpeed: hasEngineThrust ? Math.max(35, cappedSpeed) : 0,
    accel: hasEngineThrust ? Math.max(18, rawAccel) : 0,
    turnRate: cappedTurn,
    thrustRatio,
    effectiveThrust,
    engineEfficiency: thrust > 0 ? effectiveThrust / thrust : 0,
    powerEfficiency,
    powerDebuff: Math.max(0, 1 - movementPowerMultiplier),
    speedCap,
    turnCap,
    massClass: massClassForMass(safeMass),
    speedCapped: hasEngineThrust && rawSpeed > speedCap * 1.05
  };
}

export function calculateSystemEfficiency(powerGeneration, powerUse) {
  if (powerUse <= 0) return 1.08;
  const ratio = powerGeneration / Math.max(powerUse, 1);
  if (ratio >= 1) return clamp(1 + Math.min((ratio - 1) * 0.25, 0.12), 1, 1.12);
  return clamp(Math.pow(Math.max(ratio, 0), 1.35), 0.25, 1);
}

export function calculateMovementPowerMultiplier(powerGeneration, powerUse) {
  if (powerUse <= 0) return 1.04;
  const ratio = powerGeneration / Math.max(powerUse, 1);
  if (ratio >= 1) return clamp(Math.sqrt(ratio), 1, 1.08);
  return clamp(Math.pow(Math.max(ratio, 0), 1.8), 0.18, 1);
}

export function effectiveStackedValue(values, falloff) {
  return [...values].sort((a, b) => b - a).reduce((total, value, index) => total + value * Math.pow(falloff, index), 0);
}

export function massClassForMass(mass) {
  if (mass < 55) return "Light";
  if (mass < 125) return "Medium";
  if (mass < 230) return "Heavy";
  return "Capital";
}

export function speedCapForMass(mass) {
  if (mass < 55) return 340;
  if (mass < 125) return 285;
  if (mass < 230) return 215;
  return 165;
}

export function turnCapForMass(mass) {
  if (mass < 55) return 2.85;
  if (mass < 125) return 2.05;
  if (mass < 230) return 1.12;
  return 0.72;
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
  const weaponCount = stats.blaster + stats.missile + stats.railgun;
  const hasReactor = stats.modules.some((module) => module.type === "reactor");
  if (stats.powerGeneration < stats.powerUse) warnings.push(`Power deficit: uses ${stats.powerUse} but generates ${stats.powerGeneration}`);
  if (!hasReactor && stats.powerUse > PART_STATS.core.powerGeneration) warnings.push("No reactor: high-power systems need stronger generation");
  if (stats.effectiveThrust <= 0) warnings.push("No engines: this ship cannot move");
  if (stats.thrustRatio < 3.2 && stats.mass > 18) warnings.push("Low mobility: heavy for its engine power");
  if (stats.speedCapped) warnings.push("Large hull: speed capped by mass");
  if (stats.powerDebuff > 0.08 && stats.thrust > 0) warnings.push(`Underpowered systems: movement reduced ${formatPercent(stats.powerDebuff)}. Add reactors.`);
  if (stats.mass > 85 || stats.turnRate < 0.85) warnings.push("Heavy ship: turning will be slow");
  if (stats.repair > 0 && stats.powerGeneration < stats.powerUse) warnings.push("Repair installed but power is insufficient");
  if (stats.shadowColor || (stats.shield > 0 && stats.powerGeneration < stats.powerUse)) warnings.push("Shields installed but power is insufficient");
  if (weaponCount === 0) warnings.push("No weapons: this ship cannot attack");
  return warnings;
}

export function estimatePartEffectiveCost(type, design) {
  const current = computeStats(design);
  const occupied = new Set();
  for (let i = 0; i < design.length; i++) {
    occupied.add(`${design[i].x},${design[i].y}`);
  }

  const testPart = { x: 0, y: 0, type };
  design.push(testPart);

  for (let i = 0; i < design.length - 1; i++) {
    const part = design[i];

    const dx = [1, -1, 0, 0];
    const dy = [0, 0, 1, -1];

    for (let d = 0; d < 4; d++) {
      const cx = part.x + dx[d];
      const cy = part.y + dy[d];

      if (cx < 0 || cx > 6 || cy < 0 || cy > 6) continue;
      if (occupied.has(`${cx},${cy}`)) continue;

      testPart.x = cx;
      testPart.y = cy;

      if (!isConnected(design)) continue;

      const updated = computeStats(design);
      design.pop();
      return Math.max(0, updated.unitCost - current.unitCost);
    }
  }

  design.pop();
  return estimateFormulaPartCost(type);
}

export function estimateFormulaPartCost(type) {
  const stat = PART_STATS[type] || PART_STATS.frame;
  const weaponPremium =
    (stat.blaster || 0) * SHIP_ECONOMY.weaponPremiums.blaster +
    (stat.missile || 0) * SHIP_ECONOMY.weaponPremiums.missile +
    (stat.railgun || 0) * SHIP_ECONOMY.weaponPremiums.railgun;
  return Math.max(1, Math.round(
    stat.cost * SHIP_ECONOMY.partCostMultiplier +
    stat.mass * SHIP_ECONOMY.massCostMultiplier +
    stat.hp * SHIP_ECONOMY.hullCostMultiplier +
    stat.shield * SHIP_ECONOMY.shieldCostMultiplier +
    (stat.repairRate || 0) * SHIP_ECONOMY.repairCostMultiplier +
    weaponPremium
  ));
}

