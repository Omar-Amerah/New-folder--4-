// Load component definitions, lookup parts by id, and validate known component types.

const { BALANCE: COMPONENT_BALANCE } = require("./balanceConfig");
const WeaponPresentationRules = require("../../public/src/shared/weaponPresentationRules.js");

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeAffectedComponentLimit(primary, fallback, defaultValue) {
  const value = primary !== undefined ? primary : fallback;
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.round(number) : defaultValue;
}

function calculateReload(weapon) {
  return WeaponPresentationRules.weaponCyclePresentation(weapon).reloadSeconds * 1000;
}

function makeWeapon(type, stats) {
  const fireRate = Number(stats.fireRate) || 1;
  const damage = Number(stats.damage) || 0;
  const spinalCharge = normalizeSpinalCharge(stats.spinalCharge);
  const presentation = WeaponPresentationRules.weaponCyclePresentation({ damage, fireRate, spinalCharge });
  
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
    projectileRadius: Number(stats.projectileRadius ?? (type === "emp" ? stats.radius : 0)) || 0,
    projectileSpeed: stats.projectileSpeed,
    projectileLifetime: Number(stats.projectileLifetime) || 0,
    accuracy: stats.accuracy,
    tracking: tracking,
    trackTime: Number(stats.trackTime) || 0,
    trackingDelay: Number(stats.trackingDelay) || 0,
    aimSpeed: aimSpeed !== undefined ? Number(aimSpeed) : undefined,
    arc: Number(stats.arc) || 360,
    dps: presentation.dps,
    // Combat-facing heuristics retain their historical direct cadence. The
    // public dps field is presentation-only and includes Spinal charge time.
    combatDps: damage * fireRate,
    missileHp: Number(stats.missileHp) || 0,
    antiMissile: Boolean(stats.antiMissile),
    shipDamageMultiplier: Number(stats.shipDamageMultiplier) || 1,
    targetPriority: stats.targetPriority || [],
    shieldDamageMultiplier: Number(stats.shieldDamageMultiplier ?? 1),
    hullDamageMultiplier: Number(stats.hullDamageMultiplier ?? 1),
    directDamage: Number(stats.directDamage ?? stats.damage ?? 0),
    blastDamage: Number(stats.blastDamage ?? 0),
    blastRadius: Number(stats.blastRadius ?? 0),
    proximityFuseRadius: Number(stats.proximityFuseRadius ?? 0),
    innerFullDamageRadius: Number(stats.innerFullDamageRadius ?? 0),
    falloffExponent: Number(stats.falloffExponent ?? 1),
    cooldown: Number(stats.cooldown) || 0,
    maximumExplosionTargets: Number(stats.maximumExplosionTargets) || 0,
    burnThroughCarryMultiplier: stats.burnThroughCarryMultiplier !== undefined ? Number(stats.burnThroughCarryMultiplier) : undefined,
    chargeRampSeconds: stats.chargeRampSeconds !== undefined ? Number(stats.chargeRampSeconds) : undefined,
    maxChargeDamageBonus: stats.maxChargeDamageBonus !== undefined ? Number(stats.maxChargeDamageBonus) : undefined,
    impactHeatPerDamage: stats.impactHeatPerDamage !== undefined ? Number(stats.impactHeatPerDamage) : undefined,
    inductionHeatBasePerSecond: stats.inductionHeatBasePerSecond !== undefined ? Number(stats.inductionHeatBasePerSecond) : undefined,
    inductionHeatMaxPerSecond: stats.inductionHeatMaxPerSecond !== undefined ? Number(stats.inductionHeatMaxPerSecond) : undefined,
    inductionRampSeconds: stats.inductionRampSeconds !== undefined ? Number(stats.inductionRampSeconds) : undefined,
    inductionShieldMultiplier: stats.inductionShieldMultiplier !== undefined ? Number(stats.inductionShieldMultiplier) : undefined,
    inductionDirectFraction: stats.inductionDirectFraction !== undefined ? Number(stats.inductionDirectFraction) : undefined,
    inductionAdjacentFraction: stats.inductionAdjacentFraction !== undefined ? Number(stats.inductionAdjacentFraction) : undefined,
    inductionSecondHopFraction: stats.inductionSecondHopFraction !== undefined ? Number(stats.inductionSecondHopFraction) : undefined,
    inductionContactGraceSeconds: stats.inductionContactGraceSeconds !== undefined ? Number(stats.inductionContactGraceSeconds) : undefined,
    beamStyle: typeof stats.beamStyle === "string" ? stats.beamStyle : undefined,
    pelletCount: normalizePelletCount(stats.pelletCount),
    pelletSpreadDegrees: stats.pelletSpreadDegrees !== undefined ? Number(stats.pelletSpreadDegrees) : undefined,
    shieldDisruptionFraction: stats.shieldDisruptionFraction !== undefined ? Number(stats.shieldDisruptionFraction) : undefined,
    spinalCharge
  };
}

// One trigger pull can produce several pellets. A count below 2 is the same as
// no multi-pellet fire at all, so it normalizes away rather than making the
// firing path branch on a degenerate value.
function normalizePelletCount(value) {
  const count = Math.round(Number(value));
  return Number.isFinite(count) && count >= 2 ? count : undefined;
}

// Spinal charge cycle, defaulted so a partially specified balance block still
// produces a weapon that charges, commits its aim and penetrates.
function normalizeSpinalCharge(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
  const profile = Array.isArray(config.penetrationProfile)
    ? config.penetrationProfile.map(Number).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  return Object.freeze({
    chargeSeconds: Math.max(0.05, toNumber(config.chargeSeconds, 10)),
    chargeHoldSeconds: Math.max(0, toNumber(config.chargeHoldSeconds, 2)),
    chargeDecayMultiplier: Math.max(0, toNumber(config.chargeDecayMultiplier, 1.5)),
    committedAimStartProgress: clamp01(toNumber(config.committedAimStartProgress, 0.5)),
    committedAimTraverseFloor: clamp01(toNumber(config.committedAimTraverseFloor, 0.05)),
    penetrationProfile: Object.freeze(profile.length ? profile : [1])
  });
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

// Burst cooling profile. Defaults keep an under-specified block behaving like a
// small, slow burst rather than an instant infinite heat sink.
function normalizeBurstCooler(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  return Object.freeze({
    burstHeat: Math.max(0, toNumber(config.burstHeat, 150)),
    triggerHeatRatio: clamp01(toNumber(config.triggerHeatRatio, 0.5)),
    rechargeSeconds: Math.max(0.1, toNumber(config.rechargeSeconds, 8)),
    rechargeCoolingFraction: clamp01(toNumber(config.rechargeCoolingFraction, 0.15))
  });
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
    activityHeat: toNumber(component.activityHeat, 0),
    heatPerShot: toNumber(component.heatPerShot, 0),
    powerUse: toNumber(component.powerUse, 0),
    shield: toNumber(component.shield, 0),
    shieldRegen: toNumber(component.shieldRegen, 0),
    thrust: toNumber(component.thrust, 0),
    turn: toNumber(component.turn, 0),
    energyStorage: toNumber(component.energyStorage ?? component.energyCapacity, 0),
    energyCapacity: toNumber(component.energyCapacity ?? component.energyStorage, 0),
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
    sensorRangeBonus: toNumber(component.sensorRangeBonus, 0),
    sensorRole: typeof component.sensorRole === "string" ? component.sensorRole : null,
    sensorArc: toNumber(component.sensorArc, 0),
    rotatable: Boolean(component.rotatable),
    rotationRequired: Boolean(component.rotationRequired || component.rotatable),
    allowedRotations: Array.isArray(component.allowedRotations) ? component.allowedRotations.map(Number).filter(Number.isFinite) : undefined,
    // Whether a placed module of this type may carry flipped: true.
    flippable: Boolean(component.flippable),
    shapeType: typeof component.shapeType === "string" ? component.shapeType : null,
    statScale: toNumber(component.statScale, 1),
    ecmStrength: toNumber(component.ecmStrength, 0),
    aura: normalizeAura(component.aura),
    frontDamageReduction: toNumber(component.frontDamageReduction, 0),
    frontArc: toNumber(component.frontArc, 0),
    maxPerShip: Number.isFinite(Number(component.maxPerShip)) ? Number(component.maxPerShip) : null,
    meltdownDamage: Number.isFinite(Number(component.meltdownDamage)) ? Number(component.meltdownDamage) : null,
    meltdownRadius: Number.isFinite(Number(component.meltdownRadius)) ? Number(component.meltdownRadius) : null,
    // Directional armour: damage removed from each discrete hit. Continuous
    // beams apply their own per-second reduction at the beam damage boundary.
    armorFlatReduction: toNumber(component.armorFlatReduction, 0),
    heatCapacity: component.heatCapacity !== undefined ? toNumber(component.heatCapacity, 0) : undefined,
    heatCooling: component.heatCooling !== undefined ? toNumber(component.heatCooling, 0) : undefined,
    heatPassiveCooling: component.heatPassiveCooling !== undefined ? toNumber(component.heatPassiveCooling, 0) : undefined,
    heatConductivity: component.heatConductivity !== undefined ? toNumber(component.heatConductivity, 0) : undefined,
    heatRetention: component.heatRetention !== undefined ? toNumber(component.heatRetention, 0) : undefined,
    burstCooler: normalizeBurstCooler(component.burstCooler),
    // Structural material that induction Heat beams cannot couple through.
    heatBeamShield: Boolean(component.heatBeamShield),
    decoyConfig: component.decoy && typeof component.decoy === "object"
      ? Object.freeze({ ...component.decoy })
      : null,
    proximityCharge: component.proximityCharge && typeof component.proximityCharge === "object"
      ? Object.freeze({
          triggerRadius: toNumber(component.proximityCharge.triggerRadius, 50),
          triggerConfirmationSeconds: toNumber(component.proximityCharge.triggerConfirmationSeconds, 0.2),
          blastRadius: toNumber(component.proximityCharge.blastRadius, 280),
          splashCentreDamage: toNumber(component.proximityCharge.centreDamage ?? component.proximityCharge.splashCentreDamage, 1000),
          falloffExponent: toNumber(component.proximityCharge.falloffExponent, 2),
          directContactMultiplier: toNumber(component.proximityCharge.directContactMultiplier, 1.5),
          directContactHullDamage: Number.isFinite(Number(component.proximityCharge.directContactHullDamage))
            ? Number(component.proximityCharge.directContactHullDamage)
            : toNumber(component.proximityCharge.centreDamage ?? component.proximityCharge.splashCentreDamage, 1000)
              * toNumber(component.proximityCharge.directContactMultiplier, 1.5),
          maxAffectedComponents: component.proximityCharge.maxAffectedComponents === null
            ? null
            : normalizeAffectedComponentLimit(component.proximityCharge.maxAffectedComponents, null, 6),
          contactMaxAffectedComponents: normalizeAffectedComponentLimit(
            component.proximityCharge.contactMaxAffectedComponents,
            component.proximityCharge.maxAffectedComponents,
            10
          ),
          splashMaxAffectedComponents: normalizeAffectedComponentLimit(
            component.proximityCharge.splashMaxAffectedComponents,
            component.proximityCharge.maxAffectedComponents,
            6
          ),
          contactInternalDamageReduction: toNumber(component.proximityCharge.contactInternalDamageReduction ?? component.proximityCharge.internalDamageReduction, 0.35),
          splashInternalDamageReduction: toNumber(component.proximityCharge.splashInternalDamageReduction ?? component.proximityCharge.internalDamageReduction, 0.7),
          damagesFriendlyShips: component.proximityCharge.damagesFriendlyShips !== false
        })
      : null,
    footprint: component.footprint ? { width: toNumber(component.footprint.width, 1), height: toNumber(component.footprint.height, 1) } : { width: 1, height: 1 }
  };
  if (component.id === "droneBay" && balance?.drones) {
    part.droneConfig = JSON.parse(JSON.stringify(balance.drones));
  }

  if (weapon) part[weapon.type] = 1;
  for (const family of ["blaster", "missile", "railgun", "beam", "pointDefense", "emp"]) {
    if (component[family]) part[family] = toNumber(component[family], part[family] || 0);
  }
  return Object.freeze(part);
}

const PARTS = buildPartsFromBalance(COMPONENT_BALANCE);

function isInductionBeam(weapon) {
  return weapon && typeof weapon === "object" && Number.isFinite(weapon.inductionHeatBasePerSecond) && Number.isFinite(weapon.inductionHeatMaxPerSecond);
}

module.exports = {
  COMPONENT_BALANCE,
  PARTS,
  isInductionBeam
};
