// Validates component-balance.json before normalization so invalid balance data
// cannot be silently repaired into a different authoritative catalogue.

const VALID_WEAPON_FAMILIES = new Set(["blaster", "missile", "railgun", "beam", "pointDefense"]);
const VALID_TARGET_PRIORITIES = new Set(["ship", "missile", "torpedo", "projectile"]);
const VALID_POWER_CATEGORIES = new Set(["command", "propulsion", "shields", "pointDefence", "weapons", "coolingSupport"]);
const POWER_SOURCE_IDS = new Set(["core", "reactor", "auxGenerator"]);
const POWER_TIER_NAMES = ["light", "standard", "heavy"];
const POWER_TIER_NUMERIC_FIELDS = ["sustainedCapacityMw", "peakCapacityMw", "costPerHostedCell", "heatCapacityDisplacement", "renderedThickness"];
const NUMERIC_FIELDS = [
  "cost", "mass", "hp", "hull", "powerGeneration", "powerUse", "shield", "shieldRegen",
  "thrust", "turn", "energy", "energyStorage", "repair", "repairRate",
  "rangeBonus", "accuracyBonus", "fireRateBonus", "captureBonus", "ecmStrength",

  "frontDamageReduction", "frontArc"
];
const WEAPON_NUMERIC_FIELDS = [
  "damage", "fireRate", "range", "radius", "projectileSpeed", "accuracy", "tracking",
  "trackTime", "trackingDelay", "aimSpeed", "arc", "missileHp", "shipDamageMultiplier",
  "shieldDamageMultiplier", "hullDamageMultiplier"
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

// The wiring infrastructure block is authoritative for cable cost and static
// Heat displacement. Invalid values must fail loudly rather than being silently
// repaired into a different balance.
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

function validateComponentBalance(balance, { filePath = "component-balance.json" } = {}) {
  const errors = [];
  if (!balance || typeof balance !== "object" || Array.isArray(balance)) {
    return { ok: false, errors: [`${filePath} must contain a JSON object.`] };
  }
  if (!Array.isArray(balance.components)) {
    return { ok: false, errors: [`${filePath}.components must be an array.`] };
  }
  for (const key of ["metadata","shipPricing","economy","rewards","match","movement","projectiles","missileGuidance","fleetLimits","capture","repair"]) validateRequiredSection(balance, key, errors);
  validateFiniteMap(balance, filePath, errors);
  if (balance.shipPricing) {
    if (balance.shipPricing.minimum > balance.shipPricing.maximum) errors.push(`${filePath}.shipPricing minimum must be <= maximum.`);
    for (const family of Object.keys(balance.shipPricing.weaponPremiums || {})) if (!VALID_WEAPON_FAMILIES.has(family)) errors.push(`${filePath}.shipPricing.weaponPremiums has unknown family ${family}.`);
  }
  if (balance.economy && balance.economy.shipCap < 0) errors.push(`${filePath}.economy.shipCap must be non-negative.`);
  validateWiringInfrastructure(balance.wiringInfrastructure, filePath, errors);
  if (balance.match && balance.match.matchScore < 0) errors.push(`${filePath}.match.matchScore must be non-negative.`);

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
    validateBoolean(component.rotatable, `${path}.rotatable`, errors);
    validateBoolean(component.rotationRequired, `${path}.rotationRequired`, errors);
    if (component.footprint !== undefined) {
      if (!component.footprint || typeof component.footprint !== "object" || Array.isArray(component.footprint)) {
        errors.push(`${path}.footprint must be an object with positive finite width and height.`);
      } else {
        if (!isFiniteNumber(component.footprint.width) || component.footprint.width <= 0 || !Number.isInteger(component.footprint.width)) errors.push(`${path}.footprint.width must be a positive integer.`);
        if (!isFiniteNumber(component.footprint.height) || component.footprint.height <= 0 || !Number.isInteger(component.footprint.height)) errors.push(`${path}.footprint.height must be a positive integer.`);
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

module.exports = { validateComponentBalance, assertValidComponentBalance, validateWiringInfrastructure, VALID_WEAPON_FAMILIES, VALID_POWER_CATEGORIES };
