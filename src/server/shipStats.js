// Computes authoritative ship stats and ship costs from validated blueprint parts.

const { PARTS } = require("./components");
const { ECONOMY } = require("./config");
const { BALANCE } = require("./balanceConfig");
const { clampNumber, round } = require("./utils");
const {
  calculateMovementStats,
  calculateCenterOfMass,
  calculateDirectionalTurnInputs,
  calculateSystemEfficiency,
  calculateMovementPowerMultiplier,
  effectiveStackedValue,
  massClassForMass,
  speedCapForMass,
  turnCapForMass,
  softCap
} = require("../../public/src/shared/movementStats.js");
const ShieldRules = require("../../public/src/shared/shieldRules");
const EngineExhaustRules = require("../../public/src/shared/engineExhaust.js");
const WiringInfrastructureRules = require("../../public/src/shared/wiringInfrastructureRules.js");

// Section 7A cost ordering: the component-derived ship price is computed
// normally, then raw Power/Data infrastructure cost is added on top (never
// multiplied by hull/mass/weapon premiums). Passing wiring is what turns the
// infrastructure surcharge on; callers without wiring get the component price.
function applyInfrastructureCost(costBreakdown, modules, wiring) {
  const componentsTotal = costBreakdown.total;
  let powerWiring = 0; let dataWiring = 0;
  if (wiring) {
    const infra = WiringInfrastructureRules.computeInfrastructureCost(modules, wiring, PARTS, BALANCE.wiringInfrastructure);
    powerWiring = infra.powerWiring; dataWiring = infra.dataWiring;
  }
  const presentation = WiringInfrastructureRules.infrastructureCostPresentation(componentsTotal, powerWiring, dataWiring);
  costBreakdown.preInfrastructureShipCost = componentsTotal;
  costBreakdown.powerWiring = presentation.powerWiring;
  costBreakdown.dataWiring = presentation.dataWiring;
  costBreakdown.totalInfrastructure = presentation.totalInfrastructure;
  costBreakdown.infrastructurePercentage = presentation.infrastructurePercentage;
  costBreakdown.total = Math.round(presentation.totalShipCost);
  return costBreakdown;
}

function computeStats(modules, wiring = null) {
  const exhaustAnalysis = EngineExhaustRules.analyze(modules, PARTS);
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

  let minX = 3;
  let maxX = 3;
  let minY = 3;
  let maxY = 3;

  const centerOfMass = calculateCenterOfMass(modules, PARTS);

  for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex += 1) {
    const module = modules[moduleIndex];
    const part = PARTS[module.type] || PARTS.frame;
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
    repairRate += part.repairRate || 0;
    if ((part.repairRate || 0) > 0) repairRateValues.push(part.repairRate);
    // Cooling is simulated locally per component; it is not a global reload buff.
    captureBonus += part.captureBonus || 0;
    if (part.ecmStrength) ecmStrength += part.ecmStrength;
    if (part.frontDamageReduction) {
      frontDamageReduction += part.frontDamageReduction;
      if (part.frontArc > frontArc) frontArc = part.frontArc;
    }
    if (part.weapon && weaponTotals[part.weapon.type]) addWeaponStats(weaponTotals[part.weapon.type], part.weapon);
    minX = Math.min(minX, module.x);
    maxX = Math.max(maxX, module.x);
    minY = Math.min(minY, module.y);
    maxY = Math.max(maxY, module.y);
  }

  repairRate = effectiveStackedValue(repairRateValues, BALANCE.repair.stackingMultiplier);
  const shieldStats = ShieldRules.calculateShieldStats(modules, PARTS);
  const power = powerGeneration - powerUse;
  const efficiency = calculateSystemEfficiency(powerGeneration, powerUse);
  const directionalTurnInputs = calculateDirectionalTurnInputs(modules, PARTS, {
    centerOfMass,
    leverSettings: BALANCE.movement?.maneuverThrusterLever,
    isBlockedEngine: (index, module, part) => ((part.thrust || 0) > 0 || module.type === "maneuverThruster") && !exhaustAnalysis.validEngineIndices.has(index)
  });
  const movement = calculateMovementStats({ mass, thrust, turnBonus, powerGeneration, powerUse, engineThrustValues, engineMassValues, turnModuleValues, directionalTurnInputs });
  const radius = clampNumber(24 + Math.max(maxX - minX, maxY - minY) * 9 + Math.sqrt(mass) * 1.6, 28, 76);
  // Data support is applied per weapon at runtime by componentData/combat.
  // Keep catalogue weapon-family totals base-only so support is not applied twice.
  ecmStrength = Math.min(ecmStrength, 0.55);
  frontDamageReduction = Math.min(frontDamageReduction, 0.35);
  const costBreakdown = applyInfrastructureCost(calculateCostBreakdown({ cost, mass, maxHp, maxShield, repairRate, blaster, missile, railgun, beam }), modules, wiring);
  const unitCost = costBreakdown.total;
  const f = BALANCE.shipPricing.fleetCountFormulaInputs;
  const fleetCount = clampNumber(Math.floor(f.base / Math.max(f.minimumDivisor, unitCost * f.unitCostMultiplier + mass * f.massMultiplier)), f.minimum, f.maximum);
  const weapons = summarizeWeaponTotals(weaponTotals);
  const warnings = shipWarnings({ powerGeneration, powerUse, thrust, effectiveThrust: movement.effectiveThrust, thrustRatio: movement.thrustRatio, blaster, missile, railgun, beam, mass, turnRate: movement.turnRate,
    turnRateLeft: movement.turnRateLeft,
    turnRateRight: movement.turnRateRight, repair, shield: maxShield, modules, speedCapped: movement.speedCapped, powerEfficiency: movement.powerEfficiency, powerDebuff: movement.powerDebuff });
  if (exhaustAnalysis.blockedEngineIndices.size) warnings.push(`${exhaustAnalysis.blockedEngineIndices.size} blocked engine${exhaustAnalysis.blockedEngineIndices.size === 1 ? "" : "s"}: blocked exhaust provides no thrust.`);

  return {
    cost,
    unitCost,
    mass: round(mass),
    maxHp: Math.max(140, Math.round(maxHp * 1.15)),
    maxShield: Math.round(shieldStats.capacity),
    shieldRegen: round(shieldStats.recharge),
    baseMaxShield: Math.round(shieldStats.capacity),
    baseShieldRegen: round(shieldStats.recharge),
    powerGeneration,
    powerUse,
    power,
    efficiency: round(efficiency),
    thrust: round(thrust),
    effectiveThrust: round(movement.effectiveThrust),
    engineEfficiency: round(movement.engineEfficiency),
    thrustRatio: round(movement.thrustRatio),
    energyStorage,
    accel: round(movement.accel),
    maxSpeed: round(movement.maxSpeed),
    turnRate: round(movement.turnRate),
    turnRateLeft: round(movement.turnRateLeft),
    turnRateRight: round(movement.turnRateRight),
    massClass: movement.massClass,
    speedCap: movement.speedCap,
    turnCap: movement.turnCap,
    powerEfficiency: round(movement.powerEfficiency),
    powerDebuff: round(movement.powerDebuff),
    blaster,
    missile,
    railgun,
    beam,
    repair,
    repairRate,
    coolingBonus: round(coolingBonus),
    captureBonus: round(captureBonus),
    pointDefense,
    droneBays,
    droneCapacity,
    droneSquads,
    dronesByType,
    ecmStrength: round(ecmStrength),
    frontDamageReduction: round(frontDamageReduction),
    frontArc,
    blasterRange: weaponRange(weaponTotals.blaster),
    missileRange: weaponRange(weaponTotals.missile),
    railgunRange: weaponRange(weaponTotals.railgun),
    beamRange: weaponRange(weaponTotals.beam),
    beamRadius: weapons.beam.radius,
    blasterDamage: weapons.blaster.damage,
    missileDamage: weapons.missile.damage,
    railgunDamage: weapons.railgun.damage,
    beamDamage: weapons.beam.damage,
    blasterReload: weapons.blaster.reload,
    missileReload: weapons.missile.reload,
    railgunReload: weapons.railgun.reload,
    beamReload: weapons.beam.reload,
    pointDefenseReload: weapons.pointDefense.reload,
    pointDefenseDamage: weapons.pointDefense.damage,
    pointDefenseRange: weapons.pointDefense.range,
    pointDefenseProjectileSpeed: weapons.pointDefense.projectileSpeed,
    pointDefenseAccuracy: weapons.pointDefense.accuracy,
    blasterProjectileSpeed: weapons.blaster.projectileSpeed,
    missileProjectileSpeed: weapons.missile.projectileSpeed,
    railgunProjectileSpeed: weapons.railgun.projectileSpeed,
    beamProjectileSpeed: weapons.beam.projectileSpeed,
    blasterAccuracy: weapons.blaster.accuracy,
    missileAccuracy: weapons.missile.accuracy,
    railgunAccuracy: weapons.railgun.accuracy,
    beamAccuracy: weapons.beam.accuracy,
    missileTracking: weapons.missile.tracking,
    beamTracking: weapons.beam.tracking,
    weaponDps: round(weapons.blaster.dps + weapons.missile.dps + weapons.railgun.dps + weapons.beam.dps + weapons.pointDefense.dps),
    blockedEngines: exhaustAnalysis.blockedEngineIndices.size,
    weapons,
    warnings,
    costBreakdown,
    repairRange: repair > 0 ? BALANCE.repair.repairRange : 0,
    radius: round(radius),
    fleetCount
  };
}

function calculateCostBreakdown(stats) {
  const base = ECONOMY.baseShipCost;
  const parts = stats.cost * ECONOMY.partCostMultiplier;
  const mass = stats.mass * ECONOMY.massCostMultiplier;
  const hull = stats.maxHp * ECONOMY.hullCostMultiplier;
  const shield = stats.maxShield * ECONOMY.shieldCostMultiplier;
  const repair = stats.repairRate * ECONOMY.repairCostMultiplier;
  const weaponPremium =
    stats.blaster * ECONOMY.weaponPremiums.blaster +
    stats.missile * ECONOMY.weaponPremiums.missile +
    stats.railgun * ECONOMY.weaponPremiums.railgun +
    (stats.beam || 0) * (ECONOMY.weaponPremiums.beam || ECONOMY.weaponPremiums.railgun);
  const preTaxTotal = base + parts + mass + hull + shield + repair + weaponPremium;
  const largeTax = Math.max(0, preTaxTotal - ECONOMY.largeShipThreshold) * ECONOMY.largeShipCostTax;
  const hugeTax = Math.max(0, preTaxTotal - ECONOMY.hugeShipThreshold) * ECONOMY.hugeShipCostTax;
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

function weaponAccumulator() {
  return { count: 0, damage: 0, range: 0, radius: 0, fireRate: 0, reload: 0, projectileSpeed: 0, accuracy: 0, tracking: 0, dps: 0 };
}

function addWeaponStats(total, weapon) {
  total.count += 1;
  total.damage += weapon.damage;
  total.range = Math.max(total.range, weapon.range);
  total.radius = Math.max(total.radius, weapon.radius || 0);
  total.fireRate += weapon.fireRate;
  total.reload += 1000 / weapon.fireRate;
  total.projectileSpeed += weapon.projectileSpeed;
  total.accuracy += weapon.accuracy;
  total.tracking += weapon.tracking || 0;
  total.dps += (weapon.damage * weapon.fireRate);
}

function applyWeaponUtilityBonuses(totals, bonuses) {
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

function weaponRange(total) {
  return total.count > 0 ? total.range : 0;
}

function summarizeWeaponTotals(totals) {
  const result = {};
  for (const [type, total] of Object.entries(totals)) {
    result[type] = {
      count: total.count,
      damage: total.damage,
      range: total.range,
      radius: total.radius,
      fireRate: round(total.fireRate),
      reload: total.count ? round(total.reload / total.count) : 0,
      projectileSpeed: total.count ? Math.round(total.projectileSpeed / total.count) : 0,
      accuracy: total.count ? round(total.accuracy / total.count) : 0,
      tracking: total.count ? round(total.tracking / total.count) : 0,
      dps: round(total.dps)
    };
  }
  return result;
}

function shipWarnings(stats) {
  const warnings = [];
  const weaponCount = stats.blaster + stats.missile + stats.railgun + (stats.beam || 0) + (stats.pointDefense || 0);
  const hasReactor = stats.modules.some((module) => module.type === "reactor");
  if (stats.powerGeneration < stats.powerUse) warnings.push(`Power deficit: uses ${stats.powerUse} but generates ${stats.powerGeneration}`);
  if (!hasReactor && stats.powerUse > PARTS.core.powerGeneration) warnings.push("No reactor: high-power systems need stronger generation");
  if (stats.effectiveThrust <= 0) warnings.push("No engines: this ship cannot move");
  if (stats.thrustRatio < 3.2 && stats.mass > 18) warnings.push("Low mobility: heavy for its engine power");
  if (stats.speedCapped) warnings.push("Large hull: speed capped by mass");
  if (stats.powerDebuff > 0.08 && stats.thrust > 0) warnings.push(`Underpowered systems: movement reduced ${Math.round(stats.powerDebuff * 100)}%. Add reactors.`);
  if (stats.effectiveThrust > 0 && (stats.mass > 85 || stats.turnRate < 0.85)) warnings.push("Heavy ship: turning will be slow");
  if (stats.effectiveThrust > 0 && (stats.turnRateLeft || 0) < 0.15) warnings.push("No meaningful left-turn capability");
  if (stats.effectiveThrust > 0 && (stats.turnRateRight || 0) < 0.15) warnings.push("No meaningful right-turn capability");
  if (stats.modules.some((module) => module.type === "maneuverThruster" && Math.abs((module.y || 0) - 7) < 0.75)) warnings.push("Manoeuvre thrusters near the centre provide weak torque");
  if (stats.repair > 0 && stats.powerGeneration < stats.powerUse) warnings.push("Repair installed but power is insufficient");
  if (stats.shield > 0 && stats.powerGeneration < stats.powerUse) warnings.push("Shields installed but power is insufficient");
  if (weaponCount === 0) warnings.push("No weapons: this ship cannot attack");
  return warnings;
}

function summarizeStats(stats) {
  return {
    cost: stats.cost,
    mass: stats.mass,
    hp: stats.maxHp,
    shield: stats.maxShield,
    power: stats.power,
    powerGeneration: stats.powerGeneration,
    powerUse: stats.powerUse,
    thrust: stats.thrust,
    effectiveThrust: stats.effectiveThrust,
    engineEfficiency: stats.engineEfficiency,
    thrustRatio: stats.thrustRatio,
    speed: stats.maxSpeed,
    massClass: stats.massClass,
    speedCap: stats.speedCap,
    turnCap: stats.turnCap,
    powerEfficiency: stats.powerEfficiency,
    powerDebuff: stats.powerDebuff,
    fleet: stats.fleetCount,
    unitCost: stats.unitCost,
    blaster: stats.blaster,
    missile: stats.missile,
    railgun: stats.railgun,
    beam: stats.beam,
    repair: stats.repair,
    repairRate: stats.repairRate,
    coolingBonus: stats.coolingBonus,
    captureBonus: stats.captureBonus,
    pointDefense: stats.pointDefense,
    droneBays: stats.droneBays,
    droneCapacity: stats.droneCapacity,
    droneSquads: stats.droneSquads,
    dronesByType: stats.dronesByType,
    ecmStrength: stats.ecmStrength,
    frontDamageReduction: stats.frontDamageReduction,
    frontArc: stats.frontArc,
    weaponDps: stats.weaponDps,
    warnings: stats.warnings,
    costBreakdown: stats.costBreakdown,
    efficiency: stats.efficiency
  };
}

module.exports = {
  computeStats,
  calculateCostBreakdown,
  weaponAccumulator,
  addWeaponStats,
  applyWeaponUtilityBonuses,
  weaponRange,
  summarizeWeaponTotals,
  calculateMovementStats,
  calculateCenterOfMass,
  calculateDirectionalTurnInputs,
  calculateSystemEfficiency,
  calculateMovementPowerMultiplier,
  effectiveStackedValue,
  softCap,
  massClassForMass,
  speedCapForMass,
  turnCapForMass,
  shipWarnings,
  summarizeStats
};
