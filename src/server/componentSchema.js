// Validates component-balance.json before normalization so malformed balance data
// cannot be silently repaired into a different authoritative catalogue.

const VALID_WEAPON_FAMILIES = new Set(["blaster", "missile", "railgun", "beam", "pointDefense", "flak", "emp"]);
// Weapon families for which Beam burn-through carry-over is meaningful.
const BURN_THROUGH_WEAPON_FAMILIES = new Set(["beam"]);
const VALID_TARGET_PRIORITIES = new Set(["ship", "missile", "torpedo", "swarmMissile", "projectile", "drone", "droneFighter", "droneOther", "decoy"]);
const VALID_POWER_CATEGORIES = new Set(["command", "propulsion", "shields", "pointDefence", "weapons", "coolingSupport"]);
const POWER_SOURCE_IDS = new Set(["core", "reactor", "nuclearReactor", "auxGenerator"]);
const VALID_SENSOR_ROLES = new Set(["omniSmall", "omniLarge", "directed"]);
const VALID_AURA_TYPES = new Set(["command", "fireControl", "fleetDefence", "shield", "engineering", "propulsion", "ewar"]);
const VALID_SHAPE_TYPES = new Set(["halfDiagonal", "wing", "bevel", "roundedCorner", "longWedge"]);
const NUMERIC_FIELDS = [
  "cost", "mass", "hp", "hull", "powerGeneration", "powerUse", "shield", "shieldRegen",
  "activityHeat", "heatPerShot",
  "thrust", "turn", "energy", "energyStorage", "energyCapacity", "maxChargeRate", "maxDischargeRate",
  "chargeEfficiency", "dischargeEfficiency", "dischargeHeatAtMax", "dischargeHeat", "repair", "repairRate",
  "rangeBonus", "accuracyBonus", "fireRateBonus", "captureBonus", "ecmStrength", "sensorRangeBonus", "sensorArc",
  "frontDamageReduction", "frontArc", "maxPerShip", "meltdownDamage", "meltdownRadius", "statScale"
];
const WEAPON_NUMERIC_FIELDS = [
  "damage", "fireRate", "range", "radius", "projectileSpeed", "projectileLifetime", "accuracy", "tracking",
  "trackTime", "trackingDelay", "aimSpeed", "arc", "missileHp", "shipDamageMultiplier", "projectileRadius", "shieldDisruptionFraction",
  "pelletCount", "pelletSpreadDegrees",
  "shieldDamageMultiplier", "hullDamageMultiplier", "directDamage",
  "blastDamage", "blastRadius", "proximityFuseRadius", "innerFullDamageRadius",
  "falloffExponent", "cooldown", "maximumExplosionTargets",
  "chargeRampSeconds", "maxChargeDamageBonus", "impactHeatPerDamage",
  "inductionHeatBasePerSecond", "inductionHeatMaxPerSecond", "inductionRampSeconds",
  "inductionShieldMultiplier", "inductionDirectFraction", "inductionAdjacentFraction", "inductionSecondHopFraction",
  "inductionContactGraceSeconds"
];
const VALID_BEAM_STYLES = new Set(["induction"]);
// Impact Heat is a projectile/beam delivery property, not a beam-only one: the
// Plasma Cannon dumps Heat into whatever its slug lands on. Families that never
// resolve a component impact (point defence, flak) are still rejected so the
// field cannot be set where nothing would read it.
const IMPACT_HEAT_WEAPON_FAMILIES = new Set(["beam", "blaster", "railgun", "missile"]);
// Multi-pellet fire is only wired into the unguided ballistic firing paths.
const PELLET_WEAPON_FAMILIES = new Set(["blaster", "railgun"]);
// Offensive impact bursts reuse Flak's blast maths on a ship-targeting shell.
const IMPACT_BLAST_WEAPON_FAMILIES = new Set(["blaster", "railgun", "flak"]);
// Charge-then-fire spinal mounts are built on the railgun firing path.
const SPINAL_CHARGE_WEAPON_FAMILIES = new Set(["railgun"]);
const EMP_WEAPON_FAMILIES = new Set(["emp"]);
const SPINAL_CHARGE_NUMERIC_FIELDS = [
  "chargeSeconds", "chargeHoldSeconds", "chargeDecayMultiplier",
  "committedAimStartProgress", "committedAimTraverseFloor"
];

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateBoolean(value, path, errors) {
  if (value !== undefined && typeof value !== "boolean") errors.push(`${path} must be a boolean when present.`);
}

function validateNumberObject(object, fields, path, errors) {
  for (const field of fields) {
    if (object[field] !== undefined && !isFiniteNumber(object[field])) errors.push(`${path}.${field} must be a finite number when present.`);
  }
}


function validateRequiredSection(balance, key, errors) {
  if (!balance[key] || typeof balance[key] !== "object" || Array.isArray(balance[key])) errors.push(`component-balance.json.${key} must be an object.`);
}
function validateFiniteMap(object, path, errors) {
  if (!object || typeof object !== "object") return;
  for (const [key, value] of Object.entries(object)) {
    if (value && typeof value === "object" && !Array.isArray(value)) validateFiniteMap(value, `${path}.${key}`, errors);
    else if (typeof value === "number" && !Number.isFinite(value)) errors.push(`${path}.${key} must be finite.`);
  }
}

function isFiniteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const THERMAL_NUMERIC_FIELDS = [
  "heatCapacity", "heatCooling", "heatPassiveCooling", "heatConductivity", "heatRetention"
];
function validateThermalProfile(component, path, errors) {
  for (const field of THERMAL_NUMERIC_FIELDS) {
    if (component[field] === undefined) continue;
    if (!isFiniteNonNegative(component[field])) {
      errors.push(`${path}.${field} must be a finite non-negative number.`);
    }
  }
}

const AURA_STAT_KEYS = [
  "weaponAccuracyMultiplier", "weaponTrackingMultiplier", "turretAimSpeedMultiplier",
  "pointDefenceTrackingMultiplier", "flakTrackingMultiplier",
  "shieldRegenMultiplier", "shieldRestartDelayMultiplier",
  "repairRateMultiplier", "heatDissipationMultiplier", "overheatRecoveryMultiplier",
  "accelerationMultiplier", "turnRateMultiplier",
  "sensorRangeMultiplier", "missileTrackingResistanceMultiplier", "componentAimRetentionMultiplier"
];

function validateCommandAura(commandAura, filePath, errors) {
  const path = `${filePath}.commandAura`;
  if (!commandAura || typeof commandAura !== "object" || Array.isArray(commandAura)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  if (!isFiniteNonNegative(commandAura.range)) errors.push(`${path}.range must be a finite non-negative number.`);
  if (commandAura.selfAura !== undefined && typeof commandAura.selfAura !== "boolean") errors.push(`${path}.selfAura must be a boolean when present.`);
  if (commandAura.notes !== undefined && typeof commandAura.notes !== "string" && !Array.isArray(commandAura.notes)) errors.push(`${path}.notes must be a string or array when present.`);
}

const INFRASTRUCTURE_NUMERIC_FIELDS = [
  "maximumShipGridWidth", "maximumShipGridHeight", "hangarClearanceCells", "hangarCorridorLength",
  "launchSpeed", "releaseDistance", "repairRadius", "repairRatePerSecond", "repairDelaySeconds",
  "launchRetrySeconds",
  "captureRadius", "captureRestoreHpRatio", "hullScale", "shieldScale"
];

function validateInfrastructure(infrastructure, filePath, errors) {
  if (infrastructure === undefined) return;
  const path = `${filePath}.infrastructure`;
  if (!infrastructure || typeof infrastructure !== "object" || Array.isArray(infrastructure)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  for (const section of ["homeStation", "relayStation"]) {
    const sectionConfig = infrastructure[section];
    if (!sectionConfig || typeof sectionConfig !== "object" || Array.isArray(sectionConfig)) {
      errors.push(`${path}.${section} must be an object.`);
      continue;
    }
    for (const field of INFRASTRUCTURE_NUMERIC_FIELDS) {
      if (sectionConfig[field] !== undefined && !isFiniteNonNegative(sectionConfig[field])) {
        errors.push(`${path}.${section}.${field} must be a finite non-negative number.`);
      }
    }
  }
}

function validateComponentAura(aura, path, errors) {
  if (aura === undefined || aura === null) return;
  if (typeof aura !== "object" || Array.isArray(aura)) {
    errors.push(`${path}.aura must be an object when present.`);
    return;
  }
  if (!VALID_AURA_TYPES.has(aura.type)) errors.push(`${path}.aura.type must be one of ${[...VALID_AURA_TYPES].join(", ")}.`);
  validateNumberObject(aura, AURA_STAT_KEYS, `${path}.aura`, errors);
  for (const key of Object.keys(aura)) {
    if (key === "type" || AURA_STAT_KEYS.includes(key)) continue;
    errors.push(`${path}.aura.${key} is not a recognised aura field.`);
  }
}

// Multi-pellet fire. `pelletCount` is the number of independent projectiles one
// trigger pull produces; `pelletSpreadDegrees` is the extra half-cone they are
// scattered across on top of the weapon's normal accuracy spread. Both are
// optional, but a spread without a count (or the reverse) is a data mistake that
// would silently do nothing, so it fails here.
function validatePelletFire(weapon, family, path, errors) {
  const count = weapon.pelletCount;
  const spread = weapon.pelletSpreadDegrees;
  if (count === undefined && spread === undefined) return;
  if (typeof family === "string" && !PELLET_WEAPON_FAMILIES.has(family)) {
    errors.push(`${path}.weapon.pelletCount is only supported for ${[...PELLET_WEAPON_FAMILIES].join(", ")} weapons.`);
  }
  if (!(Number.isInteger(count) && count >= 2)) {
    errors.push(`${path}.weapon.pelletCount must be an integer >= 2 when multi-pellet fire is configured.`);
  }
  if (!(Number.isFinite(spread) && spread > 0 && spread < 180)) {
    errors.push(`${path}.weapon.pelletSpreadDegrees must be a finite number greater than 0 and less than 180.`);
  }
}

// Offensive impact burst (Fragmentation Cannon). Flak already validates these
// fields implicitly through WEAPON_NUMERIC_FIELDS; this adds the ordering rules
// that make a burst meaningful so a blast radius inside the full-damage radius
// cannot ship silently.
function validateImpactBlast(weapon, family, path, errors) {
  const blastDamage = weapon.blastDamage;
  const blastRadius = weapon.blastRadius;
  if (blastDamage === undefined && blastRadius === undefined) return;
  if (typeof family === "string" && !IMPACT_BLAST_WEAPON_FAMILIES.has(family)) {
    errors.push(`${path}.weapon.blastDamage is only supported for ${[...IMPACT_BLAST_WEAPON_FAMILIES].join(", ")} weapons.`);
    return;
  }
  if (!isFiniteNonNegative(blastDamage)) errors.push(`${path}.weapon.blastDamage must be a finite non-negative number when a blast is configured.`);
  if (!(Number.isFinite(blastRadius) && blastRadius > 0)) errors.push(`${path}.weapon.blastRadius must be a finite number greater than zero when a blast is configured.`);
  const inner = weapon.innerFullDamageRadius;
  if (inner !== undefined && Number.isFinite(blastRadius) && Number.isFinite(inner) && inner > blastRadius) {
    errors.push(`${path}.weapon.innerFullDamageRadius must not exceed blastRadius.`);
  }
  if (weapon.falloffExponent !== undefined && !(Number.isFinite(weapon.falloffExponent) && weapon.falloffExponent > 0)) {
    errors.push(`${path}.weapon.falloffExponent must be a finite number greater than zero.`);
  }
}

// Spinal charge cycle. Every value is a balance constant the runtime reads
// directly, so a malformed block must fail at load rather than be repaired into
// a weapon that charges forever or never commits its aim.
function validateSpinalCharge(charge, family, path, errors) {
  if (charge === undefined || charge === null) return;
  const chargePath = `${path}.weapon.spinalCharge`;
  if (typeof charge !== "object" || Array.isArray(charge)) {
    errors.push(`${chargePath} must be an object when present.`);
    return;
  }
  if (typeof family === "string" && !SPINAL_CHARGE_WEAPON_FAMILIES.has(family)) {
    errors.push(`${chargePath} is only supported for ${[...SPINAL_CHARGE_WEAPON_FAMILIES].join(", ")} weapons.`);
  }
  for (const field of SPINAL_CHARGE_NUMERIC_FIELDS) {
    if (charge[field] !== undefined && !isFiniteNonNegative(charge[field])) {
      errors.push(`${chargePath}.${field} must be a finite non-negative number when present.`);
    }
  }
  for (const field of ["chargeHeatPerSecond", "fireHeat"]) {
    if (Object.prototype.hasOwnProperty.call(charge, field)) {
      errors.push(`${chargePath}.${field} is obsolete; use top-level activityHeat or heatPerShot.`);
    }
  }
  if (!(Number.isFinite(charge.chargeSeconds) && charge.chargeSeconds > 0)) {
    errors.push(`${chargePath}.chargeSeconds must be a finite number greater than zero.`);
  }
  for (const field of ["committedAimStartProgress", "committedAimTraverseFloor"]) {
    if (charge[field] !== undefined && isFiniteNonNegative(charge[field]) && charge[field] > 1) {
      errors.push(`${chargePath}.${field} must be from 0 to 1.`);
    }
  }
  if (charge.penetrationProfile !== undefined) {
    if (!Array.isArray(charge.penetrationProfile) || charge.penetrationProfile.length === 0) {
      errors.push(`${chargePath}.penetrationProfile must be a non-empty array when present.`);
    } else {
      let previous = Infinity;
      charge.penetrationProfile.forEach((value, index) => {
        if (!(Number.isFinite(value) && value > 0 && value <= 1)) {
          errors.push(`${chargePath}.penetrationProfile[${index}] must be a number greater than 0 and no more than 1.`);
          return;
        }
        if (value > previous) errors.push(`${chargePath}.penetrationProfile must not increase along the impact ray.`);
        previous = value;
      });
    }
  }
}

function validateEmpWeapon(weapon, family, path, errors) {
  const customFields = ["projectileRadius", "shieldDisruptionFraction"];
  for (const field of customFields) {
    if (weapon[field] !== undefined && (typeof family !== "string" || !EMP_WEAPON_FAMILIES.has(family))) {
      errors.push(`${path}.weapon.${field} is only supported for emp weapons.`);
    }
  }
  if (typeof family !== "string" || !EMP_WEAPON_FAMILIES.has(family)) return;
  if (!(Number.isFinite(weapon.damage) && weapon.damage === 0)) {
    errors.push(`${path}.weapon.damage must be exactly 0 for emp weapons.`);
  }
  if (!(Number.isFinite(weapon.shieldDisruptionFraction) && weapon.shieldDisruptionFraction > 0 && weapon.shieldDisruptionFraction <= 1)) {
    errors.push(`${path}.weapon.shieldDisruptionFraction must be greater than 0 and no more than 1 for emp weapons.`);
  }
  const projectileRadius = weapon.projectileRadius ?? weapon.radius;
  if (!(Number.isFinite(projectileRadius) && projectileRadius > 0)) {
    errors.push(`${path}.weapon.projectileRadius or radius must be greater than 0 for emp weapons.`);
  }
  if (weapon.tracking !== undefined && weapon.tracking !== 0) {
    errors.push(`${path}.weapon.tracking must be 0 for unguided emp weapons.`);
  }
  if (!(Number.isFinite(weapon.projectileSpeed) && weapon.projectileSpeed > 0)) {
    errors.push(`${path}.weapon.projectileSpeed must be greater than 0 for emp weapons.`);
  }
}

// Burst cooling (Burst Cooler). The component charges from the Heat network and
// vents its whole store at once, then runs at a fraction of its rating while it
// recharges.
const BURST_COOLER_NUMERIC_FIELDS = ["burstHeat", "triggerHeatRatio", "rechargeSeconds", "rechargeCoolingFraction"];
function validateBurstCooler(config, path, errors) {
  if (config === undefined || config === null) return;
  const coolerPath = `${path}.burstCooler`;
  if (typeof config !== "object" || Array.isArray(config)) {
    errors.push(`${coolerPath} must be an object when present.`);
    return;
  }
  for (const field of BURST_COOLER_NUMERIC_FIELDS) {
    if (!isFiniteNonNegative(config[field])) errors.push(`${coolerPath}.${field} must be a finite non-negative number.`);
  }
  if (isFiniteNonNegative(config.burstHeat) && config.burstHeat <= 0) errors.push(`${coolerPath}.burstHeat must be greater than zero.`);
  if (isFiniteNonNegative(config.rechargeSeconds) && config.rechargeSeconds <= 0) errors.push(`${coolerPath}.rechargeSeconds must be greater than zero.`);
  for (const field of ["triggerHeatRatio", "rechargeCoolingFraction"]) {
    if (isFiniteNonNegative(config[field]) && config[field] > 1) errors.push(`${coolerPath}.${field} must be from 0 to 1.`);
  }
}

function validateComponentBalance(balance, { filePath = "component-balance.json" } = {}) {
  const errors = [];
  if (!balance || typeof balance !== "object" || Array.isArray(balance)) {
    return { ok: false, errors: [`${filePath} must contain a JSON object.`] };
  }
  if (!Array.isArray(balance.components)) {
    return { ok: false, errors: [`${filePath}.components must be an array.`] };
  }
  for (const key of ["metadata","economy","movement","projectiles","missileGuidance","fleetLimits","capture","repair","drones"]) validateRequiredSection(balance, key, errors);
  if (balance.drones) {
    const required = ["squadSize", "maxBaysPerShip", "maxActivePerShip", "maxActivePerPlayer", "launchIntervalSeconds", "launchDurationSeconds", "fuelSeconds", "refuelSeconds", "orphanLifetimeSeconds", "standbyPowerMw", "activePowerMw", "productionPowerMw"];
    for (const field of required) if (!isFiniteNonNegative(balance.drones[field])) errors.push(`${filePath}.drones.${field} must be a finite non-negative number.`);
    if (!balance.drones.types || typeof balance.drones.types !== "object") errors.push(`${filePath}.drones.types must be an object.`);
    for (const type of ["fighter", "defence", "repair"]) {
      const config = balance.drones.types?.[type];
      if (!config || typeof config !== "object") errors.push(`${filePath}.drones.types.${type} must be an object.`);
      else if (!isFiniteNonNegative(config.productionSeconds) || !isFiniteNonNegative(config.hull) || !isFiniteNonNegative(config.speed)) {
        errors.push(`${filePath}.drones.types.${type} must define non-negative productionSeconds, hull, and speed.`);
      }
    }
  }
  validateFiniteMap(balance, filePath, errors);
  if (balance.economy && balance.economy.shipCap < 0) errors.push(`${filePath}.economy.shipCap must be non-negative.`);
  validateCommandAura(balance.commandAura, filePath, errors);
  validateInfrastructure(balance.infrastructure, filePath, errors);
  const seen = new Set();
  balance.components.forEach((component, index) => {
    const prefix = `${filePath}.components[${index}]`;
    if (!component || typeof component !== "object" || Array.isArray(component)) {
      errors.push(`${prefix} must be an object.`);
      return;
    }
    const id = component.id;
    const idLabel = typeof id === "string" && id ? ` component '${id}'` : "";
    const path = `${prefix}${idLabel}`;
    if (typeof id !== "string" || id.trim() !== id || id.length === 0) {
      errors.push(`${prefix}.id must be a unique non-empty string with no surrounding whitespace.`);
    } else if (seen.has(id)) {
      errors.push(`${path} duplicates an earlier component id.`);
    } else {
      seen.add(id);
    }
    if (component.category !== undefined && (typeof component.category !== "string" || !component.category.trim())) {
      errors.push(`${path}.category must be a non-empty string when present.`);
    }
    // Authoritative Power category. Every Power-consuming component must declare
    // one; array position is never used to infer it.
    const consumesPower = isFiniteNumber(component.powerUse) && component.powerUse > 0 && !POWER_SOURCE_IDS.has(id);
    if (component.powerCategory !== undefined) {
      if (typeof component.powerCategory !== "string") errors.push(`${path}.powerCategory must be a string when present.`);
      else if (!VALID_POWER_CATEGORIES.has(component.powerCategory)) errors.push(`${path}.powerCategory '${component.powerCategory}' is not a known Power category.`);
    } else if (consumesPower) {
      errors.push(`${path}.powerCategory is required for Power-consuming components.`);
    }
    if (component.description !== undefined && typeof component.description !== "string") errors.push(`${path}.description must be a string when present.`);
    if (Object.prototype.hasOwnProperty.call(component, "heat")) errors.push(`${path}.heat is unsupported; use explicit Heat profile rules instead.`);
    validateNumberObject(component, NUMERIC_FIELDS, path, errors);
    if (component.cost !== undefined && (!Number.isInteger(component.cost) || component.cost < 0)) {
      errors.push(`${path}.cost must be a non-negative integer.`);
    }
    for (const field of ["activityHeat", "heatPerShot"]) {
      if (component[field] !== undefined && !isFiniteNonNegative(component[field])) {
        errors.push(`${path}.${field} must be a finite non-negative number when present.`);
      }
    }
    validateThermalProfile(component, path, errors);
    validateComponentAura(component.aura, path, errors);
    validateBurstCooler(component.burstCooler, path, errors);
    validateBoolean(component.rotatable, `${path}.rotatable`, errors);
    validateBoolean(component.rotationRequired, `${path}.rotationRequired`, errors);
    // Mirroring capability. Only shaped structural silhouettes declare it; a
    // component that cannot be mirrored simply omits the field.
    validateBoolean(component.flippable, `${path}.flippable`, errors);
    if (component.flippable === true && component.shapeType === undefined) {
      errors.push(`${path}.flippable requires a shapeType: mirroring only applies to shaped silhouettes.`);
    }
    validateBoolean(component.heatBeamShield, `${path}.heatBeamShield`, errors);
    if (component.proximityCharge !== undefined) {
      const charge = component.proximityCharge;
      const chargePath = `${path}.proximityCharge`;
      if (!charge || typeof charge !== "object" || Array.isArray(charge)) {
        errors.push(`${chargePath} must be an object when present.`);
      } else {
        for (const field of ["triggerRadius", "triggerConfirmationSeconds", "blastRadius", "centreDamage", "falloffExponent", "internalDamageReduction", "directContactMultiplier"]) {
          if (charge[field] !== undefined && !isFiniteNumber(charge[field])) {
            errors.push(`${chargePath}.${field} must be a finite number when present.`);
          }
        }
        for (const field of ["maxAffectedComponents", "contactMaxAffectedComponents", "splashMaxAffectedComponents"]) {
          const value = charge[field];
          if (value !== undefined && value !== null && (!Number.isInteger(value) || value < 1)) {
            errors.push(`${chargePath}.${field} must be null or an integer >= 1 when present.`);
          }
        }
        validateBoolean(charge.damagesFriendlyShips, `${chargePath}.damagesFriendlyShips`, errors);
      }
    }
    if (component.sensorRole !== undefined && !VALID_SENSOR_ROLES.has(component.sensorRole)) {
      errors.push(`${path}.sensorRole must be one of omniSmall, omniLarge, or directed.`);
    }
    if (component.sensorRole !== undefined && !(isFiniteNumber(component.sensorRangeBonus) && component.sensorRangeBonus > 0)) {
      errors.push(`${path}.sensorRangeBonus must be a finite number greater than zero for a sensor component.`);
    }
    if (component.sensorRole === "directed" && !(isFiniteNumber(component.sensorArc) && component.sensorArc > 0 && component.sensorArc < 180)) {
      errors.push(`${path}.sensorArc must be a finite number between 0 and 180 for a directed sensor.`);
    }
    if (component.shapeType !== undefined && !VALID_SHAPE_TYPES.has(component.shapeType)) {
      errors.push(`${path}.shapeType must be one of ${[...VALID_SHAPE_TYPES].join(", ")}.`);
    }
    if (component.footprint !== undefined) {
      if (!component.footprint || typeof component.footprint !== "object" || Array.isArray(component.footprint)) {
        errors.push(`${path}.footprint must be an object with positive finite width and height.`);
      } else {
        if (!isFiniteNumber(component.footprint.width) || component.footprint.width <= 0 || !Number.isInteger(component.footprint.width)) errors.push(`${path}.footprint.width must be a positive integer.`);
        if (!isFiniteNumber(component.footprint.height) || component.footprint.height <= 0 || !Number.isInteger(component.footprint.height)) errors.push(`${path}.footprint.height must be a positive integer.`);
      }
    }
    if (component.decoy !== undefined) {
      const config = component.decoy;
      const fields = ["capacity", "initialStock", "productionSeconds", "launchCooldownSeconds", "lifetimeSeconds", "triggerRange", "attractionRange", "attractionChance", "driftSpeed", "collisionRadius"];
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        errors.push(`${path}.decoy must be an object when present.`);
      } else {
        for (const field of fields) {
          if (!isFiniteNonNegative(config[field])) errors.push(`${path}.decoy.${field} must be a finite non-negative number.`);
        }
        if (!Number.isInteger(config.capacity) || config.capacity < 1) errors.push(`${path}.decoy.capacity must be an integer >= 1.`);
        if (!Number.isInteger(config.initialStock) || config.initialStock > config.capacity) errors.push(`${path}.decoy.initialStock must be an integer no greater than capacity.`);
        if (isFiniteNonNegative(config.attractionChance) && config.attractionChance > 1) errors.push(`${path}.decoy.attractionChance must be from 0 to 1.`);
      }
    }
    if (component.weapon !== undefined && component.weapon !== null) {
      if (typeof component.weapon !== "object" || Array.isArray(component.weapon)) {
        errors.push(`${path}.weapon must be null or an object.`);
      } else {
        const family = component.weapon.family || component.weapon.type;
        if (typeof family !== "string" || !VALID_WEAPON_FAMILIES.has(family)) errors.push(`${path}.weapon.family must be one of ${[...VALID_WEAPON_FAMILIES].join(", ")}.`);
        validateNumberObject(component.weapon, WEAPON_NUMERIC_FIELDS, `${path}.weapon`, errors);
        if (component.weapon.fireRate !== undefined && component.weapon.fireRate <= 0) errors.push(`${path}.weapon.fireRate must be greater than zero.`);
        // Beam burn-through carry multiplier: optional, but when present must be
        // a finite number in [0, 1] and only on a supported (beam) weapon. Invalid
        // source data fails loudly rather than being silently clamped/zeroed.
        if (component.weapon.burnThroughCarryMultiplier !== undefined) {
          const btc = component.weapon.burnThroughCarryMultiplier;
          if (!isFiniteNumber(btc)) {
            errors.push(`${path}.weapon.burnThroughCarryMultiplier must be a finite number when present.`);
          } else if (btc < 0 || btc > 1) {
            errors.push(`${path}.weapon.burnThroughCarryMultiplier must be between 0 and 1 (inclusive).`);
          } else if (typeof family === "string" && !BURN_THROUGH_WEAPON_FAMILIES.has(family)) {
            errors.push(`${path}.weapon.burnThroughCarryMultiplier is only supported for ${[...BURN_THROUGH_WEAPON_FAMILIES].join(", ")} weapons.`);
          }
        }
        for (const field of ["chargeRampSeconds", "maxChargeDamageBonus"]) {
          if (component.weapon[field] !== undefined && family !== "beam") {
            errors.push(`${path}.weapon.${field} is only supported for beam weapons.`);
          }
        }
        if (component.weapon.impactHeatPerDamage !== undefined && typeof family === "string"
          && !IMPACT_HEAT_WEAPON_FAMILIES.has(family)) {
          errors.push(`${path}.weapon.impactHeatPerDamage is only supported for ${[...IMPACT_HEAT_WEAPON_FAMILIES].join(", ")} weapons.`);
        }
        validateEmpWeapon(component.weapon, family, path, errors);
        validatePelletFire(component.weapon, family, path, errors);
        validateImpactBlast(component.weapon, family, path, errors);
        validateSpinalCharge(component.weapon.spinalCharge, family, path, errors);
        if (component.weapon.chargeRampSeconds !== undefined && component.weapon.chargeRampSeconds < 0) {
          errors.push(`${path}.weapon.chargeRampSeconds must be zero or greater.`);
        }
        if (component.weapon.maxChargeDamageBonus !== undefined && (component.weapon.maxChargeDamageBonus < 0 || component.weapon.maxChargeDamageBonus > 1)) {
          errors.push(`${path}.weapon.maxChargeDamageBonus must be between 0 and 1 (inclusive).`);
        }
        if (component.weapon.impactHeatPerDamage !== undefined && component.weapon.impactHeatPerDamage < 0) {
          errors.push(`${path}.weapon.impactHeatPerDamage must be zero or greater.`);
        }
        const inductionFields = ["inductionHeatBasePerSecond", "inductionHeatMaxPerSecond", "inductionRampSeconds", "inductionShieldMultiplier", "inductionDirectFraction", "inductionAdjacentFraction", "inductionSecondHopFraction", "inductionContactGraceSeconds"];
        for (const field of inductionFields) {
          if (component.weapon[field] !== undefined && family !== "beam") {
            errors.push(`${path}.weapon.${field} is only supported for beam weapons.`);
          }
        }
        if (Number.isFinite(component.weapon.inductionHeatBasePerSecond) || Number.isFinite(component.weapon.inductionHeatMaxPerSecond)) {
          const base = component.weapon.inductionHeatBasePerSecond ?? 0;
          const max = component.weapon.inductionHeatMaxPerSecond ?? 0;
          if (base < 0 || max < base) {
            errors.push(`${path}.weapon.induction ramp values must be non-negative and max must not be below base.`);
          }
          if (Number.isFinite(component.weapon.inductionRampSeconds) && component.weapon.inductionRampSeconds < 0) {
            errors.push(`${path}.weapon.inductionRampSeconds must be zero or greater.`);
          }
          if (Number.isFinite(component.weapon.inductionShieldMultiplier) && (component.weapon.inductionShieldMultiplier < 0 || component.weapon.inductionShieldMultiplier > 1)) {
            errors.push(`${path}.weapon.inductionShieldMultiplier must be between 0 and 1.`);
          }
          const fracA = component.weapon.inductionDirectFraction ?? 0;
          const fracB = component.weapon.inductionAdjacentFraction ?? 0;
          const fracC = component.weapon.inductionSecondHopFraction ?? 0;
          if (fracA < 0 || fracB < 0 || fracC < 0) {
            errors.push(`${path}.weapon.induction distribution fractions must be non-negative.`);
          }
          const sum = fracA + fracB + fracC;
          if (Math.abs(sum - 1) > 1e-6) {
            errors.push(`${path}.weapon.induction distribution fractions must sum to 1 (got ${sum}).`);
          }
          if (Number.isFinite(component.weapon.inductionContactGraceSeconds) && component.weapon.inductionContactGraceSeconds < 0) {
            errors.push(`${path}.weapon.inductionContactGraceSeconds must be zero or greater.`);
          }
        }
        if (component.weapon.beamStyle !== undefined) {
          if (typeof component.weapon.beamStyle !== "string" || !VALID_BEAM_STYLES.has(component.weapon.beamStyle)) {
            errors.push(`${path}.weapon.beamStyle must be one of ${[...VALID_BEAM_STYLES].join(", ")}.`);
          }
        }
        if (component.weapon.targetPriority !== undefined) {
          if (!Array.isArray(component.weapon.targetPriority)) errors.push(`${path}.weapon.targetPriority must be an array when present.`);
          else for (const target of component.weapon.targetPriority) if (typeof target !== "string" || !VALID_TARGET_PRIORITIES.has(target)) errors.push(`${path}.weapon.targetPriority contains invalid target '${target}'.`);
        }
      }
    }
  });
  return { ok: errors.length === 0, errors };
}

function assertValidComponentBalance(balance, options = {}) {
  const result = validateComponentBalance(balance, options);
  if (!result.ok) throw new Error(`Invalid component balance data:\n${result.errors.map(e => ` - ${e}`).join("\n")}`);
  return balance;
}

module.exports = { validateComponentBalance, assertValidComponentBalance, VALID_WEAPON_FAMILIES, VALID_TARGET_PRIORITIES, VALID_POWER_CATEGORIES };
