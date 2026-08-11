// Computes authoritative ship stats and ship costs from validated blueprint parts.

const { PARTS } = require("./components");
const { BALANCE } = require("./balanceConfig");
const { clampNumber, round } = require("./utils");
const { designSensorProfile } = require("./sensorCapability");
const {
  calculateMovementStats,
  calculateCenterOfMass,
  calculateDirectionalTurnInputs,
  calculateGenericTurnModifier,
  calculateMovementPowerMultiplier,
  MOVEMENT_CONFIG,
  massClassForMass,
  turnCapForMass
} = require("../../public/src/shared/movementStats.js");
const ShieldRules = require("../../public/src/shared/shieldRules");
const EngineExhaustRules = require("../../public/src/shared/engineExhaust.js");
const UniversalPower = require("../../public/src/shared/universalPower.js");
const RepairRules = require("../../public/src/shared/repairRules.js");
const WeaponPresentationRules = require("../../public/src/shared/weaponPresentationRules.js");
const { nonCoreHullTotal } = require("../../public/src/shared/componentHullRules.js");

function computeStats(modules) {
  const exhaustAnalysis = EngineExhaustRules.analyze(modules, PARTS);
  let cost = 0;
  let mass = 0;
  const maxHp = nonCoreHullTotal(modules, PARTS);
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
  const selfRepairRateValues = [];
  const repairBeamRateValues = [];
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
  const isBlockedEngine = (index, module, part) => (part.thrust > 0 || module.type === "maneuverThruster") && !exhaustAnalysis.validEngineIndices.has(index);

  for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex += 1) {
    const module = modules[moduleIndex];
    const part = PARTS[module.type] || PARTS.frame;
    const blockedEngine = (part.thrust > 0 || module.type === "maneuverThruster") && !exhaustAnalysis.validEngineIndices.has(moduleIndex);
    cost += part.cost;
    mass += part.mass;
    powerGeneration += part.powerGeneration || 0;
    powerUse += part.powerUse || 0;
    thrust += blockedEngine ? 0 : part.thrust;
    if (part.thrust > 0 && !blockedEngine) {
      engineThrustValues.push(part.thrust);
      engineComponentIndices.push(moduleIndex);
      engineMassValues.push(part.mass || 0);
    }
    // Power sources are not stored-energy modules; only explicit storage
    // capacity on non-generating components contributes to ship Energy Storage.
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
    const repairRate = Number(part.repairRate) || 0;
    if (repairRate > 0) {
      if (RepairRules.isLocalRepairSource(module.type, part)) selfRepairRateValues.push(repairRate);
      else repairBeamRateValues.push(repairRate);
    }
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

  const selfRepairRateInstalled = RepairRules.installedRepairRate(selfRepairRateValues);
  const selfRepairRate = RepairRules.getEffectiveRepairRate(selfRepairRateValues, BALANCE);
  const repairBeamOutput = RepairRules.installedRepairRate(repairBeamRateValues);
  const shieldStats = ShieldRules.calculateShieldStats(modules, PARTS);
  const powerFlow = UniversalPower.calculateUniversalPower(modules, PARTS);
  const availablePower = powerFlow.summary.availableGenerationMw;
  const powerRatio = powerFlow.summary.powerRatio;
  const power = availablePower - powerUse;
  const efficiency = powerRatio;
  const componentPowerMultiplier = (index) => powerFlow.byComponentIndex[index]?.operationalMultiplier ?? 1;
  const turnBonus = calculateGenericTurnModifier(modules, PARTS, {
    isBlockedEngine,
    componentMultiplier: componentPowerMultiplier
  });
  const directionalTurnInputs = calculateDirectionalTurnInputs(modules, PARTS, {
    centerOfMass,
    leverSettings: MOVEMENT_CONFIG.maneuverThrusterLever,
    isBlockedEngine,
    componentMultiplier: componentPowerMultiplier
  });
  const poweredEngineThrustValues = engineThrustValues.map((value, index) => value * componentPowerMultiplier(engineComponentIndices[index]));
  const movement = calculateMovementStats({ mass, thrust, turnBonus, powerGeneration: availablePower, powerUse, engineThrustValues: poweredEngineThrustValues, engineMassValues, turnModuleValues, directionalTurnInputs });
  const radius = clampNumber(24 + Math.max(maxX - minX, maxY - minY) * 9 + Math.sqrt(mass) * 1.6, 28, 76);
  // Data support is applied per weapon at runtime by componentData/combat.
  // Keep catalogue weapon-family totals base-only so support is not applied twice.
  ecmStrength = Math.min(ecmStrength, 0.55);
  frontDamageReduction = Math.min(frontDamageReduction, 0.35);
  const sensorProfile = designSensorProfile(modules);
  const unitCost = cost;
  const weapons = summarizeWeaponTotals(weaponTotals);
  const warnings = shipWarnings({ powerGeneration, powerUse, availablePower, thrust, effectiveThrust: movement.effectiveThrust, thrustRatio: movement.thrustRatio, blaster, missile, railgun, beam, mass, turnRate: movement.turnRate,
    turnRateLeft: movement.turnRateLeft,
    turnRateRight: movement.turnRateRight, repair, modules, powerEfficiency: movement.powerEfficiency, powerDebuff: movement.powerDebuff });
  if (exhaustAnalysis.blockedEngineIndices.size) warnings.push(`${exhaustAnalysis.blockedEngineIndices.size} blocked engine${exhaustAnalysis.blockedEngineIndices.size === 1 ? "" : "s"}: blocked exhaust provides no thrust.`);

  return {
    cost,
    unitCost,
    radius: round(radius),
    mass: round(mass),
    maxHp,
    maxShield: Math.round(shieldStats.capacity),
    shieldRegen: round(shieldStats.recharge),
    baseMaxShield: Math.round(shieldStats.capacity),
    baseShieldRegen: round(shieldStats.recharge),
    powerGeneration,
    powerUse,
    power,
    availablePower: round(availablePower),
    powerRatio: round(powerRatio),
    powerStorageDischarge: round(powerFlow.summary.storageDischargeMw),
    efficiency: round(efficiency),
    thrust: round(thrust),
    effectiveThrust: round(movement.effectiveThrust),
    engineEfficiency: round(movement.engineEfficiency),
    thrustRatio: round(movement.thrustRatio),
    energyStorage,
    accel: round(movement.accel),
    brakingAcceleration: round(movement.brakingAcceleration),
    maxSpeed: round(movement.maxSpeed),
    turnRate: round(movement.turnRate),
    turnRateLeft: round(movement.turnRateLeft),
    turnRateRight: round(movement.turnRateRight),
    directionalTurn: movement.directionalTurn,
    massClass: movement.massClass,
    turnCap: movement.turnCap,
    powerEfficiency: round(movement.powerEfficiency),
    powerDebuff: round(movement.powerDebuff),
    blaster,
    missile,
    railgun,
    beam,
    repair,
    selfRepairRateInstalled,
    selfRepairSourceCount: selfRepairRateValues.length,
    selfRepairRate,
    repairBeamOutput,
    repairBeamRate: repairBeamOutput,
    // Legacy names remain aliases for self-repair so runtime consumers do not
    // accidentally treat a projected beam as local ship maintenance.
    repairRateInstalled: selfRepairRateInstalled,
    repairRateSourceCount: selfRepairRateValues.length,
    repairRate: selfRepairRate,
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
    weaponDps: round(weapons.blaster.dps + weapons.missile.dps + weapons.railgun.dps + weapons.beam.dps + (weapons.pointDefense.dps * (PARTS.pointDefense.weapon.shipDamageMultiplier || 0.04))),
    weaponDpsLabel: weaponDpsLabel(weaponTotals),
    blockedEngines: exhaustAnalysis.blockedEngineIndices.size,
    weapons,
    warnings,
    repairRange: repair > 0 ? BALANCE.repair.repairRange : 0,
    radius: round(radius),
    baseSensorRange: sensorProfile.baseRange,
    sensorRange: round(sensorProfile.omniRange),
    directedSensorRange: round(sensorProfile.directedRange),
    directedSensorArc: round(sensorProfile.directedArc),
    sensorComponentCount: sensorProfile.sensorComponentCount,
    directedSensorCount: sensorProfile.directedSensorCount
  };
}

function weaponAccumulator() {
  return { count: 0, damage: 0, range: 0, radius: 0, fireRate: 0, reload: 0, projectileSpeed: 0, accuracy: 0, tracking: 0, dps: 0, rateProfiles: [] };
}

function addWeaponStats(total, weapon) {
  const presentation = WeaponPresentationRules.weaponCyclePresentation(weapon);
  total.count += 1;
  total.damage += weapon.damage;
  total.range = Math.max(total.range, weapon.range);
  total.radius = Math.max(total.radius, weapon.radius || 0);
  total.fireRate += weapon.fireRate;
  total.reload += presentation.reloadSeconds * 1000;
  total.projectileSpeed += weapon.projectileSpeed;
  total.accuracy += weapon.accuracy;
  total.tracking += weapon.tracking || 0;
  total.dps += presentation.dps;
  total.rateProfiles.push({ ...weapon });
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
    total.reload += presentation.reloadSeconds * 1000;
    total.dps += presentation.dps;
  }
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
    recalculateRateDependentStats(total, fireRateMultiplier);
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
      dps: round(total.dps),
      dpsLabel: WeaponPresentationRules.dpsLabelForProfiles(total.rateProfiles),
      hasChargeWeapon: (Array.isArray(total.rateProfiles) ? total.rateProfiles : [])
        .some((weapon) => WeaponPresentationRules.isSpinalChargeWeapon(weapon))
    };
  }
  return result;
}

function weaponDpsLabel(totals) {
  const profiles = Object.values(totals || {}).flatMap((total) => Array.isArray(total.rateProfiles) ? total.rateProfiles : []);
  return profiles.some((weapon) => WeaponPresentationRules.isSpinalChargeWeapon(weapon))
    ? "Weapon DPS (ideal charge cycle)"
    : "Weapon DPS";
}

function shipWarnings(stats) {
  const warnings = [];
  const weaponCount = stats.blaster + stats.missile + stats.railgun + (stats.beam || 0) + (stats.pointDefense || 0);
  const availablePower = Number(stats.availablePower ?? stats.powerGeneration ?? 0);
  const powerUse = Number(stats.powerUse || 0);
  if (powerUse > availablePower + 0.0005) warnings.push(`Power shortage: ${availablePower.toFixed(1)} MW available for ${powerUse.toFixed(1)} MW demand.`);
  if (stats.effectiveThrust <= 0) warnings.push("No engines: this ship cannot move");
  if (stats.thrustRatio < 3.2 && stats.mass > 18) warnings.push("Low mobility: heavy for its engine power");
  if (stats.effectiveThrust > 0 && (stats.mass > 85 || stats.turnRate < 0.85)) warnings.push("Heavy ship: turning will be slow");
  if (stats.effectiveThrust > 0 && (stats.turnRateLeft || 0) < 0.15) warnings.push("No meaningful left-turn capability");
  if (stats.effectiveThrust > 0 && (stats.turnRateRight || 0) < 0.15) warnings.push("No meaningful right-turn capability");
  if (stats.modules.some((module) => module.type === "maneuverThruster" && Math.abs((module.y || 0) - 7) < 0.75)) warnings.push("Manoeuvre thrusters near the centre provide weak torque");
  if (weaponCount === 0) warnings.push("No weapons: this ship cannot attack.");
  const hasBackupCore = stats.modules.some((module) => module.type === "backupCore");
  if (hasBackupCore) warnings.push("Backup available: ship can survive main Core loss");
  else warnings.push("Main Core only: destruction disables ship");
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
    availablePower: stats.availablePower,
    powerRatio: stats.powerRatio,
    powerStorageDischarge: stats.powerStorageDischarge,
    thrust: stats.thrust,
    effectiveThrust: stats.effectiveThrust,
    engineEfficiency: stats.engineEfficiency,
    thrustRatio: stats.thrustRatio,
    speed: stats.maxSpeed,
    massClass: stats.massClass,
    turnCap: stats.turnCap,
    powerEfficiency: stats.powerEfficiency,
    powerDebuff: stats.powerDebuff,
    unitCost: stats.unitCost,
    blaster: stats.blaster,
    missile: stats.missile,
    railgun: stats.railgun,
    beam: stats.beam,
    repair: stats.repair,
    selfRepairRateInstalled: stats.selfRepairRateInstalled,
    selfRepairSourceCount: stats.selfRepairSourceCount,
    selfRepairRate: stats.selfRepairRate,
    repairBeamOutput: stats.repairBeamOutput,
    repairBeamRate: stats.repairBeamRate,
    repairRateInstalled: stats.repairRateInstalled,
    repairRateSourceCount: stats.repairRateSourceCount,
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
    weaponDpsLabel: stats.weaponDpsLabel,
    warnings: stats.warnings,
    efficiency: stats.efficiency,
    baseSensorRange: stats.baseSensorRange,
    sensorRange: stats.sensorRange,
    directedSensorRange: stats.directedSensorRange,
    directedSensorArc: stats.directedSensorArc,
    sensorComponentCount: stats.sensorComponentCount,
    directedSensorCount: stats.directedSensorCount
  };
}

module.exports = {
  computeStats,
  weaponAccumulator,
  addWeaponStats,
  applyWeaponUtilityBonuses,
  weaponRange,
  summarizeWeaponTotals,
  calculateMovementStats,
  calculateCenterOfMass,
  calculateDirectionalTurnInputs,
  calculateMovementPowerMultiplier,
  massClassForMass,
  turnCapForMass,
  shipWarnings,
  summarizeStats
};
