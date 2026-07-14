// Validates component-balance.json before normalization so invalid balance data
// cannot be silently repaired into a different authoritative catalogue.

const VALID_WEAPON_FAMILIES = new Set(["blaster", "missile", "railgun", "beam", "pointDefense"]);
const VALID_TARGET_PRIORITIES = new Set(["ship", "missile", "torpedo", "projectile"]);
const NUMERIC_FIELDS = [
  "cost", "mass", "hp", "hull", "powerGeneration", "powerUse", "shield", "shieldRegen",
  "thrust", "turn", "energy", "energyStorage", "repair", "repairRate", "heat",
  "rangeBonus", "accuracyBonus", "fireRateBonus", "captureBonus", "ecmStrength",
  "decoyRange", "decoyCooldown", "decoyConfuseDuration", "decoyChance",
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

function validateComponentBalance(balance, { filePath = "component-balance.json" } = {}) {
  const errors = [];
  if (!balance || typeof balance !== "object" || Array.isArray(balance)) {
    return { ok: false, errors: [`${filePath} must contain a JSON object.`] };
  }
  if (!Array.isArray(balance.components)) {
    return { ok: false, errors: [`${filePath}.components must be an array.`] };
  }

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
    if (component.description !== undefined && typeof component.description !== "string") errors.push(`${path}.description must be a string when present.`);
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

module.exports = { validateComponentBalance, assertValidComponentBalance, VALID_WEAPON_FAMILIES };
