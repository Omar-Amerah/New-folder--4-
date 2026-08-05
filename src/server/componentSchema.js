// Validates component-balance.json before normalization so invalid balance data
// cannot be silently repaired into a different authoritative catalogue.

const VALID_WEAPON_FAMILIES = new Set(["blaster", "missile", "railgun", "beam", "pointDefense", "flak"]);
// Weapon families for which Beam burn-through carry-over is meaningful.
const BURN_THROUGH_WEAPON_FAMILIES = new Set(["beam"]);
const VALID_TARGET_PRIORITIES = new Set(["ship", "missile", "torpedo", "swarmMissile", "projectile", "drone", "droneFighter", "droneOther", "decoy"]);
const VALID_POWER_CATEGORIES = new Set(["command", "propulsion", "shields", "pointDefence", "weapons", "coolingSupport"]);
const POWER_SOURCE_IDS = new Set(["core", "reactor", "nuclearReactor", "auxGenerator"]);
const POWER_TIER_NAMES = ["light", "standard", "heavy"];
const POWER_TIER_NUMERIC_FIELDS = ["sustainedCapacityMw", "peakCapacityMw", "costPerHostedCell", "heatCapacityDisplacement", "renderedThickness"];
const VALID_SENSOR_ROLES = new Set(["omniSmall", "omniLarge", "directed"]);
const VALID_AURA_TYPES = new Set(["command", "fireControl", "fleetDefence", "shield", "engineering", "propulsion", "ewar"]);
const VALID_SHAPE_TYPES = new Set(["halfDiagonal", "wing", "bevel", "roundedCorner", "longWedge"]);
const NUMERIC_FIELDS = [
  "cost", "mass", "hp", "hull", "powerGeneration", "powerUse", "shield", "shieldRegen",
  "thrust", "turn", "lateralThrust", "brakingThrust", "reverseThrust", "energy", "energyStorage", "energyCapacity", "maxChargeRate", "maxDischargeRate",
  "chargeEfficiency", "dischargeEfficiency", "dischargeHeatAtMax", "dischargeHeat", "repair", "repairRate",
  "rangeBonus", "accuracyBonus", "fireRateBonus", "captureBonus", "ecmStrength", "sensorRangeBonus", "sensorArc",
  "frontDamageReduction", "frontArc", "maxPerShip", "meltdownDamage", "meltdownRadius", "statScale"
];
const WEAPON_NUMERIC_FIELDS = [
  "damage", "fireRate", "range", "radius", "projectileSpeed", "projectileLifetime", "accuracy", "tracking",
  "trackTime", "trackingDelay", "aimSpeed", "arc", "missileHp", "shipDamageMultiplier",
  "shieldDamageMultiplier", "hullDamageMultiplier", "directDamage",
  "blastDamage", "blastRadius", "proximityFuseRadius", "innerFullDamageRadius",
  "falloffExponent", "armourPenetration", "cooldown", "maximumExplosionTargets",
  "chargeRampSeconds", "maxChargeDamageBonus", "impactHeatPerDamage",
  "inductionHeatBasePerSecond", "inductionHeatMaxPerSecond", "inductionRampSeconds",
  "inductionShieldMultiplier", "inductionDirectFraction", "inductionAdjacentFraction", "inductionSecondHopFraction",
  "inductionContactGraceSeconds", "inductionSelfHeatMaxMultiplier"
];
const VALID_BEAM_STYLES = new Set(["induction"]);

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

// The wiring infrastructure block is authoritative for cable cost and static
// Heat displacement. Invalid values must fail loudly rather than being silently
// repaired into a different balance.
// Section 7D-2 activity-driven Power demand: standby fractions per demand role.
const POWER_DEMAND_ROLES = ["command", "propulsion", "shields", "weapons", "pointDefence", "repair", "coolingSupport"];
function validatePowerDemand(powerDemand, filePath, errors) {
  const path = `${filePath}.powerDemand`;
  if (!powerDemand || typeof powerDemand !== "object" || Array.isArray(powerDemand)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  const fractions = powerDemand.standbyFractions;
  if (!fractions || typeof fractions !== "object" || Array.isArray(fractions)) {
    errors.push(`${path}.standbyFractions must be an object.`);
    return;
  }
  for (const role of POWER_DEMAND_ROLES) {
    const value = fractions[role];
    if (!(Number.isFinite(value) && value >= 0 && value <= 1)) {
      errors.push(`${path}.standbyFractions.${role} must be a finite number from 0 to 1.`);
    }
  }
}

// Section 7G runtime Power overload protection: the central provisional
// protection balance. Every tuning constant lives here (never scattered
// through server or UI files) and must be finite, non-negative and safely
// ordered so runtime normalisation never has to repair a nonsensical value.
const POWER_PROTECTION_NUMERIC_FIELDS = [
  "overloadStartRatio", "recoveryStartRatio", "tripStressThreshold",
  "baseStressPerSecond", "additionalStressPerSecondAtPeak", "recoveryPerSecond",
  "criticalStressRatio", "tripCooldownSeconds", "retryIntervalSeconds",
  "safeRecloseSustainedRatio", "maxAutomaticRetrySubsets", "maximumProtectionDeltaSeconds"
];
function validatePowerProtection(protection, filePath, errors) {
  const path = `${filePath}.powerProtection`;
  if (!protection || typeof protection !== "object" || Array.isArray(protection)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  for (const field of POWER_PROTECTION_NUMERIC_FIELDS) {
    if (!isFiniteNonNegative(protection[field])) errors.push(`${path}.${field} must be a finite non-negative number.`);
  }
  if (isFiniteNonNegative(protection.recoveryStartRatio) && isFiniteNonNegative(protection.overloadStartRatio)
    && protection.recoveryStartRatio > protection.overloadStartRatio) {
    errors.push(`${path}.recoveryStartRatio must be <= overloadStartRatio.`);
  }
  if (protection.criticalStressRatio !== undefined && isFiniteNonNegative(protection.criticalStressRatio) && protection.criticalStressRatio > 1) {
    errors.push(`${path}.criticalStressRatio must be from 0 to 1.`);
  }
  if (protection.safeRecloseSustainedRatio !== undefined && isFiniteNonNegative(protection.safeRecloseSustainedRatio) && protection.safeRecloseSustainedRatio > 1) {
    errors.push(`${path}.safeRecloseSustainedRatio must be from 0 to 1.`);
  }
  if (!(Number.isInteger(protection.maxAutomaticRetrySubsets) && protection.maxAutomaticRetrySubsets >= 1)) {
    errors.push(`${path}.maxAutomaticRetrySubsets must be an integer >= 1.`);
  }
  if (!(typeof protection.maximumProtectionDeltaSeconds === "number" && Number.isFinite(protection.maximumProtectionDeltaSeconds) && protection.maximumProtectionDeltaSeconds > 0)) {
    errors.push(`${path}.maximumProtectionDeltaSeconds must be a finite number greater than zero.`);
  }
}

function validateWiringInfrastructure(infrastructure, filePath, errors) {
  const path = `${filePath}.wiringInfrastructure`;
  if (!infrastructure || typeof infrastructure !== "object" || Array.isArray(infrastructure)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  const tiers = infrastructure.powerTiers;
  if (!tiers || typeof tiers !== "object" || Array.isArray(tiers)) {
    errors.push(`${path}.powerTiers must be an object.`);
  } else {
    for (const name of POWER_TIER_NAMES) {
      const tier = tiers[name];
      const tierPath = `${path}.powerTiers.${name}`;
      if (!tier || typeof tier !== "object" || Array.isArray(tier)) {
        errors.push(`${tierPath} must be an object.`);
        continue;
      }
      for (const field of POWER_TIER_NUMERIC_FIELDS) {
        if (!isFiniteNonNegative(tier[field])) errors.push(`${tierPath}.${field} must be a finite non-negative number.`);
      }
      if (isFiniteNonNegative(tier.sustainedCapacityMw) && isFiniteNonNegative(tier.peakCapacityMw)
        && tier.peakCapacityMw < tier.sustainedCapacityMw) {
        errors.push(`${tierPath}.peakCapacityMw must be >= sustainedCapacityMw.`);
      }
      if (typeof tier.inspectionLabel !== "string" || !tier.inspectionLabel.trim()) {
        errors.push(`${tierPath}.inspectionLabel must be a non-empty string.`);
      }
      // Section 7D-1 dynamic cable Heat: coefficient is a finite Heat/second per
      // hosted cell at sustained flow (>= 0); the utilisation exponent must be a
      // finite number strictly greater than 1 so above-sustained flow is nonlinear.
      if (!isFiniteNonNegative(tier.cableHeatAtSustainedPerHostedCell)) {
        errors.push(`${tierPath}.cableHeatAtSustainedPerHostedCell must be a finite non-negative number.`);
      }
      if (!(Number.isFinite(tier.cableHeatUtilisationExponent) && tier.cableHeatUtilisationExponent > 1)) {
        errors.push(`${tierPath}.cableHeatUtilisationExponent must be a finite number greater than 1.`);
      }
    }
    const light = tiers.light; const standard = tiers.standard; const heavy = tiers.heavy;
    if (light && standard && heavy) {
      if (!(light.costPerHostedCell < standard.costPerHostedCell)) errors.push(`${path}.powerTiers light cost must be less than standard.`);
      if (!(standard.costPerHostedCell < heavy.costPerHostedCell)) errors.push(`${path}.powerTiers standard cost must be less than heavy.`);
      if (!(light.heatCapacityDisplacement < standard.heatCapacityDisplacement)) errors.push(`${path}.powerTiers light displacement must be less than standard.`);
      if (!(standard.heatCapacityDisplacement < heavy.heatCapacityDisplacement)) errors.push(`${path}.powerTiers standard displacement must be less than heavy.`);
    }
  }
  const data = infrastructure.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    errors.push(`${path}.data must be an object.`);
  } else {
    if (!isFiniteNonNegative(data.costPerHostedCell)) errors.push(`${path}.data.costPerHostedCell must be a finite non-negative number.`);
    if (!isFiniteNonNegative(data.heatCapacityDisplacement)) errors.push(`${path}.data.heatCapacityDisplacement must be a finite non-negative number.`);
    if (typeof data.inspectionLabel !== "string" || !data.inspectionLabel.trim()) errors.push(`${path}.data.inspectionLabel must be a non-empty string.`);
    if (tiers && tiers.light && isFiniteNonNegative(data.costPerHostedCell) && isFiniteNonNegative(tiers.light.costPerHostedCell)
      && !(data.costPerHostedCell < tiers.light.costPerHostedCell)) {
      errors.push(`${path}.data.costPerHostedCell must be significantly less than light Power cable cost.`);
    }
  }
  if (!(typeof infrastructure.minimumComponentHeatCapacity === "number" && Number.isFinite(infrastructure.minimumComponentHeatCapacity) && infrastructure.minimumComponentHeatCapacity > 0)) {
    errors.push(`${path}.minimumComponentHeatCapacity must be a positive finite number.`);
  }
}

const AURA_STAT_KEYS = [
  "weaponAccuracyMultiplier", "weaponTrackingMultiplier", "turretAimSpeedMultiplier", "targetAcquisitionMultiplier",
  "pointDefenceTrackingMultiplier", "flakTrackingMultiplier", "interceptionReactionMultiplier",
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
  "productionBaseSeconds", "productionCostSecondsMultiplier", "launchRetrySeconds",
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

function validateComponentBalance(balance, { filePath = "component-balance.json" } = {}) {
  const errors = [];
  if (!balance || typeof balance !== "object" || Array.isArray(balance)) {
    return { ok: false, errors: [`${filePath} must contain a JSON object.`] };
  }
  if (!Array.isArray(balance.components)) {
    return { ok: false, errors: [`${filePath}.components must be an array.`] };
  }
  for (const key of ["metadata","shipPricing","economy","rewards","movement","projectiles","missileGuidance","fleetLimits","capture","repair","drones"]) validateRequiredSection(balance, key, errors);
  if (balance.drones) {
    const required = ["squadSize", "maxBaysPerShip", "maxActivePerShip", "maxActivePerPlayer", "launchIntervalSeconds", "launchDurationSeconds", "fuelSeconds", "refuelSeconds", "orphanLifetimeSeconds", "standbyPowerMw", "activePowerMw", "productionPowerMw", "standbyHeatPerSecond", "activeHeatPerSecond", "productionHeatPerSecond"];
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
  if (balance.shipPricing) {
    if (balance.shipPricing.minimum > balance.shipPricing.maximum) errors.push(`${filePath}.shipPricing minimum must be <= maximum.`);
    for (const family of Object.keys(balance.shipPricing.weaponPremiums || {})) if (!VALID_WEAPON_FAMILIES.has(family)) errors.push(`${filePath}.shipPricing.weaponPremiums has unknown family ${family}.`);
  }
  if (balance.economy && balance.economy.shipCap < 0) errors.push(`${filePath}.economy.shipCap must be non-negative.`);
  validateWiringInfrastructure(balance.wiringInfrastructure, filePath, errors);
  validatePowerDemand(balance.powerDemand, filePath, errors);
  validatePowerProtection(balance.powerProtection, filePath, errors);
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
    validateThermalProfile(component, path, errors);
    validateComponentAura(component.aura, path, errors);
    validatePropulsionCapacitor(component.propulsionCapacitor, path, errors);
    validateBoolean(component.rotatable, `${path}.rotatable`, errors);
    validateBoolean(component.rotationRequired, `${path}.rotationRequired`, errors);
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
        for (const field of ["chargeRampSeconds", "maxChargeDamageBonus", "impactHeatPerDamage"]) {
          if (component.weapon[field] !== undefined && family !== "beam") {
            errors.push(`${path}.weapon.${field} is only supported for beam weapons.`);
          }
        }
        if (component.weapon.chargeRampSeconds !== undefined && component.weapon.chargeRampSeconds < 0) {
          errors.push(`${path}.weapon.chargeRampSeconds must be zero or greater.`);
        }
        if (component.weapon.maxChargeDamageBonus !== undefined && (component.weapon.maxChargeDamageBonus < 0 || component.weapon.maxChargeDamageBonus > 1)) {
          errors.push(`${path}.weapon.maxChargeDamageBonus must be between 0 and 1 (inclusive).`);
        }
        if (component.weapon.impactHeatPerDamage !== undefined && component.weapon.impactHeatPerDamage < 0) {
          errors.push(`${path}.weapon.impactHeatPerDamage must be zero or greater.`);
        }
        const inductionFields = ["inductionHeatBasePerSecond", "inductionHeatMaxPerSecond", "inductionRampSeconds", "inductionShieldMultiplier", "inductionDirectFraction", "inductionAdjacentFraction", "inductionSecondHopFraction", "inductionContactGraceSeconds", "inductionSelfHeatMaxMultiplier"];
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
          if (Number.isFinite(component.weapon.inductionSelfHeatMaxMultiplier) && component.weapon.inductionSelfHeatMaxMultiplier < 1) {
            errors.push(`${path}.weapon.inductionSelfHeatMaxMultiplier must be at least 1.`);
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

const PROPULSION_CAPACITOR_FIELDS = ["capacity", "maxDischargeRate", "maxChargeRate", "boostMultiplier", "activationThreshold", "deactivationThreshold", "minReserveFraction"];

function validatePropulsionCapacitor(config, path, errors) {
  if (config === undefined || config === null) return;
  if (typeof config !== "object" || Array.isArray(config)) {
    errors.push(`${path}.propulsionCapacitor must be an object when present.`);
    return;
  }
  for (const field of PROPULSION_CAPACITOR_FIELDS) {
    if (!isFiniteNonNegative(config[field])) errors.push(`${path}.propulsionCapacitor.${field} must be a finite non-negative number.`);
  }
  if (isFiniteNonNegative(config.activationThreshold) && isFiniteNonNegative(config.deactivationThreshold)
    && config.deactivationThreshold >= config.activationThreshold) {
    errors.push(`${path}.propulsionCapacitor.deactivationThreshold must be less than activationThreshold.`);
  }
  if (isFiniteNonNegative(config.minReserveFraction) && config.minReserveFraction > 1) {
    errors.push(`${path}.propulsionCapacitor.minReserveFraction must be from 0 to 1.`);
  }
}

module.exports = { validateComponentBalance, assertValidComponentBalance, validateWiringInfrastructure, validatePowerProtection, VALID_WEAPON_FAMILIES, VALID_POWER_CATEGORIES };
