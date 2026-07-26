// Load component definitions, lookup parts by id, and validate known component types.

const { BALANCE: COMPONENT_BALANCE } = require("./balanceConfig");

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function calculateDps(weapon) {
  return (weapon.damage * weapon.fireRate);
}

function calculateReload(weapon) {
  return 1000 / weapon.fireRate;
}

function makeWeapon(type, stats) {
  const fireRate = Number(stats.fireRate) || 1;
  const damage = Number(stats.damage) || 0;
  
  let tracking = stats.tracking || 0;
  // aimSpeed is an optional traverse-rate override. Keep only real finite
  // values so a null (e.g. from a serialization round trip) can never become
  // Number(null) === 0 and freeze the turret traverse.
  let aimSpeed = stats.aimSpeed === null || stats.aimSpeed === undefined ? undefined : Number(stats.aimSpeed);
  if (!Number.isFinite(aimSpeed)) aimSpeed = undefined;
  if (type === "beam") {
    if (stats.tracking && aimSpeed === undefined) {
      aimSpeed = 1.65;
    }
    tracking = 0; // beam weapons do not have tracking
  }

  return {
    type,
    damage,
    fireRate,
    reload: calculateReload({ fireRate }),
    range: stats.range,
    radius: Number(stats.radius) || 0,
    projectileSpeed: stats.projectileSpeed,
    projectileLifetime: Number(stats.projectileLifetime) || 0,
    accuracy: stats.accuracy,
    tracking: tracking,
    trackTime: Number(stats.trackTime) || 0,
    trackingDelay: Number(stats.trackingDelay) || 0,
    aimSpeed: aimSpeed !== undefined ? Number(aimSpeed) : undefined,
    arc: Number(stats.arc) || 360,
    dps: calculateDps({ damage, fireRate }),
    missileHp: Number(stats.missileHp) || 0,
    antiMissile: Boolean(stats.antiMissile),
    shipDamageMultiplier: Number(stats.shipDamageMultiplier) || 1,
    targetPriority: stats.targetPriority || [],
    shieldDamageMultiplier: Number(stats.shieldDamageMultiplier ?? 1),
    hullDamageMultiplier: Number(stats.hullDamageMultiplier ?? 1),
    directDamage: Number(stats.directDamage ?? stats.damage ?? 0),
    directImpactBonus: Number(stats.directImpactBonus ?? 0),
    blastDamage: Number(stats.blastDamage ?? 0),
    blastRadius: Number(stats.blastRadius ?? 0),
    proximityFuseRadius: Number(stats.proximityFuseRadius ?? 0),
    innerFullDamageRadius: Number(stats.innerFullDamageRadius ?? 0),
    falloffExponent: Number(stats.falloffExponent ?? 1),
    armourPenetration: Number(stats.armourPenetration ?? 1),
    cooldown: Number(stats.cooldown) || 0,
    maximumExplosionTargets: Number(stats.maximumExplosionTargets) || 0,
    burnThroughCarryMultiplier: stats.burnThroughCarryMultiplier !== undefined ? Number(stats.burnThroughCarryMultiplier) : undefined,
    chargeRampSeconds: stats.chargeRampSeconds !== undefined ? Number(stats.chargeRampSeconds) : undefined,
    maxChargeDamageBonus: stats.maxChargeDamageBonus !== undefined ? Number(stats.maxChargeDamageBonus) : undefined,
    impactHeatPerDamage: stats.impactHeatPerDamage !== undefined ? Number(stats.impactHeatPerDamage) : undefined
  };
}

const FALLBACK_PARTS = Object.freeze({});

function buildPartsFromBalance(balance) {
  const components = Array.isArray(balance?.components) ? balance.components : [];
  if (!components.length) throw new Error("component-balance.json must define at least one component.");

  const parts = {};
  for (const component of components) {
    if (!component || typeof component.id !== "string") continue;
    parts[component.id] = normalizeBalanceComponent(component, balance);
  }
  if (!parts.core) throw new Error("component-balance.json must define core.");
  return Object.freeze(parts);
}

function normalizeAura(aura) {
  if (!aura || typeof aura !== "object" || Array.isArray(aura)) return null;
  const copy = { type: typeof aura.type === "string" ? aura.type : "" };
  for (const key of Object.keys(aura)) {
    if (key === "type") continue;
    const value = aura[key];
    copy[key] = typeof value === "number" && Number.isFinite(value) ? value : value;
  }
  return Object.freeze(copy);
}

function normalizeBalanceComponent(component, balance = COMPONENT_BALANCE) {
  const weapon = component.weapon
    ? makeWeapon(component.weapon.family || component.weapon.type || "blaster", component.weapon)
    : null;
  const repairRate = toNumber(component.repairRate ?? component.repair, 0);
  const part = {
    name: String(component.name || component.id),
    category: component.category === "Utility" || !component.category ? "Support" : component.category,
    powerCategory: typeof component.powerCategory === "string" ? component.powerCategory : null,
    cost: toNumber(component.cost, 0),
    mass: toNumber(component.mass, 0),
    hp: toNumber(component.hp ?? component.hull, 0),
    powerGeneration: toNumber(component.powerGeneration, 0),
    powerUse: toNumber(component.powerUse, 0),
    shield: toNumber(component.shield, 0),
    shieldRegen: toNumber(component.shieldRegen, 0),
    thrust: toNumber(component.thrust, 0),
    lateralThrust: toNumber(component.lateralThrust, 0),
    turn: toNumber(component.turn, 0),
    energyStorage: toNumber(component.energyStorage ?? component.energyCapacity ?? component.energy, 0),
    energyCapacity: toNumber(component.energyCapacity ?? component.energyStorage ?? component.energy, 0),
    maxChargeRate: toNumber(component.maxChargeRate, 0),
    maxDischargeRate: toNumber(component.maxDischargeRate, 0),
    chargeEfficiency: component.chargeEfficiency !== undefined ? toNumber(component.chargeEfficiency, 1) : 1,
    dischargeEfficiency: component.dischargeEfficiency !== undefined ? toNumber(component.dischargeEfficiency, 1) : 1,
    dischargeHeatAtMax: toNumber(component.dischargeHeatAtMax ?? component.dischargeHeat, 0),
    repairRate,
    repair: repairRate > 0 ? 1 : toNumber(component.repairCount, 0),
    weapon,
    description: component.description || "",
    utilityEffect: component.utilityEffect || component.utility || "",
    rangeBonus: toNumber(component.rangeBonus, 0),
    accuracyBonus: toNumber(component.accuracyBonus, 0),
    fireRateBonus: toNumber(component.fireRateBonus, 0),
    captureBonus: toNumber(component.captureBonus, 0),
    rotatable: Boolean(component.rotatable),
    rotationRequired: Boolean(component.rotationRequired || component.rotatable),
    allowedRotations: Array.isArray(component.allowedRotations) ? component.allowedRotations.map(Number).filter(Number.isFinite) : undefined,
    ecmStrength: toNumber(component.ecmStrength, 0),
    aura: normalizeAura(component.aura),
    frontDamageReduction: toNumber(component.frontDamageReduction, 0),
    frontArc: toNumber(component.frontArc, 0),
    // Directional armour: maximum damage removed from a single attack event.
    // Rapid or continuous sources with sub-second delivery intervals scale this
    // value by the interval, making it approximately sustained DPS absorbed per
    // weapon stream.
    armorFlatReduction: toNumber(component.armorFlatReduction, 0),
    decoyConfig: component.decoy && typeof component.decoy === "object"
      ? Object.freeze({ ...component.decoy })
      : null,
    proximityCharge: component.proximityCharge && typeof component.proximityCharge === "object"
      ? Object.freeze({
          triggerRadius: toNumber(component.proximityCharge.triggerRadius, 100),
          triggerConfirmationSeconds: toNumber(component.proximityCharge.triggerConfirmationSeconds, 0.2),
          blastRadius: toNumber(component.proximityCharge.blastRadius, 350),
          centreDamage: toNumber(component.proximityCharge.centreDamage, 1700),
          falloffExponent: toNumber(component.proximityCharge.falloffExponent, 1)
        })
      : null,
    footprint: component.footprint ? { width: toNumber(component.footprint.width, 1), height: toNumber(component.footprint.height, 1) } : { width: 1, height: 1 }
  };
  if (component.id === "droneBay" && balance?.drones) {
    part.activityHeat = toNumber(balance.drones.activeHeatPerSecond, 0);
    part.droneConfig = JSON.parse(JSON.stringify(balance.drones));
  }

  if (weapon) part[weapon.type] = 1;
  for (const family of ["blaster", "missile", "railgun", "beam", "pointDefense"]) {
    if (component[family]) part[family] = toNumber(component[family], part[family] || 0);
  }
  return Object.freeze(part);
}

const PARTS = buildPartsFromBalance(COMPONENT_BALANCE);

module.exports = {
  COMPONENT_BALANCE,
  PARTS
};
