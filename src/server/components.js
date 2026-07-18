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
    hullDamageMultiplier: Number(stats.hullDamageMultiplier ?? 1)
  };
}

const FALLBACK_PARTS = Object.freeze({});

function buildPartsFromBalance(balance) {
  const components = Array.isArray(balance?.components) ? balance.components : [];
  if (!components.length) throw new Error("component-balance.json must define at least one component.");

  const parts = {};
  for (const component of components) {
    if (!component || typeof component.id !== "string") continue;
    parts[component.id] = normalizeBalanceComponent(component);
  }
  if (!parts.core) throw new Error("component-balance.json must define core.");
  return Object.freeze(parts);
}

function normalizeBalanceComponent(component) {
  const weapon = component.weapon
    ? makeWeapon(component.weapon.family || component.weapon.type || "blaster", component.weapon)
    : null;
  const repairRate = toNumber(component.repairRate ?? component.repair, 0);
  const part = {
    category: component.category || "Utility",
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
    energyStorage: toNumber(component.energyStorage ?? component.energy, 0),
    repairRate,
    repair: repairRate > 0 ? 1 : toNumber(component.repairCount, 0),
    weapon,
    description: component.description || "",
    utilityEffect: component.utilityEffect || component.utility || "",
    rangeBonus: toNumber(component.rangeBonus, 0),
    accuracyBonus: toNumber(component.accuracyBonus, 0),
    fireRateBonus: toNumber(component.fireRateBonus, 0),
    captureBonus: toNumber(component.captureBonus, 0),
    rotationRequired: Boolean(component.rotationRequired || component.rotatable),
    allowedRotations: Array.isArray(component.allowedRotations) ? component.allowedRotations.map(Number).filter(Number.isFinite) : undefined,
    ecmStrength: toNumber(component.ecmStrength, 0),
    decoyRange: toNumber(component.decoyRange, 0),
    decoyCooldown: toNumber(component.decoyCooldown, 0),
    decoyConfuseDuration: toNumber(component.decoyConfuseDuration, 0),
    decoyChance: toNumber(component.decoyChance, 0),
    frontDamageReduction: toNumber(component.frontDamageReduction, 0),
    frontArc: toNumber(component.frontArc, 0),
    // Directional armour: maximum damage removed from a single attack event.
    // Rapid or continuous sources with sub-second delivery intervals scale this
    // value by the interval, making it approximately sustained DPS absorbed per
    // weapon stream.
    armorFlatReduction: toNumber(component.armorFlatReduction, 0),
    footprint: component.footprint ? { width: toNumber(component.footprint.width, 1), height: toNumber(component.footprint.height, 1) } : { width: 1, height: 1 }
  };

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
