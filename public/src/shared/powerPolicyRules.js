(function initPowerPolicyRules(root, factory) {
  const rules = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = rules;
  root.PowerPolicyRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makePowerPolicyRules() {
  "use strict";

  // Authoritative Power categories every Power-consuming component belongs to.
  // Section 7A stores these on the Blueprint policy; allocation behaviour that
  // reads them is deliberately deferred to a later phase.
  const POWER_CATEGORIES = Object.freeze([
    "command",
    "propulsion",
    "shields",
    "pointDefence",
    "weapons",
    "coolingSupport"
  ]);
  const POWER_CATEGORY_SET = new Set(POWER_CATEGORIES);

  // The canonical Balanced ordering. Presets are stored as an explicit category
  // order so a future allocator can read a single deterministic list regardless
  // of the chosen preset.
  const BALANCED_ORDER = Object.freeze([...POWER_CATEGORIES]);
  const POWER_PRESETS = Object.freeze({
    balanced: BALANCED_ORDER,
    // Survival leans on defensive and control systems first.
    survival: Object.freeze(["command", "shields", "pointDefence", "propulsion", "coolingSupport", "weapons"]),
    // Offensive leans on weapons and their support first.
    offensive: Object.freeze(["command", "weapons", "pointDefence", "shields", "propulsion", "coolingSupport"])
  });
  const PRESET_NAMES = Object.freeze(Object.keys(POWER_PRESETS));
  const DEFAULT_PRESET = "balanced";

  function isPowerCategory(value) {
    return typeof value === "string" && POWER_CATEGORY_SET.has(value);
  }

  function isPresetName(value) {
    return typeof value === "string" && Object.prototype.hasOwnProperty.call(POWER_PRESETS, value);
  }

  // A valid custom order is a permutation of every category exactly once. Any
  // malformed input is repaired deterministically: recognised categories keep
  // their supplied order, and missing categories are appended in canonical
  // order so the result is always a complete, deterministic permutation.
  function normalizeCustomOrder(rawOrder) {
    const seen = new Set();
    const order = [];
    if (Array.isArray(rawOrder)) {
      for (const value of rawOrder) {
        if (isPowerCategory(value) && !seen.has(value)) {
          seen.add(value);
          order.push(value);
        }
      }
    }
    for (const category of BALANCED_ORDER) {
      if (!seen.has(category)) {
        seen.add(category);
        order.push(category);
      }
    }
    return order;
  }

  function isValidCustomOrder(rawOrder) {
    if (!Array.isArray(rawOrder) || rawOrder.length !== POWER_CATEGORIES.length) return false;
    const seen = new Set();
    for (const value of rawOrder) {
      if (!isPowerCategory(value) || seen.has(value)) return false;
      seen.add(value);
    }
    return seen.size === POWER_CATEGORIES.length;
  }

  // Deterministic default policy. Fresh objects every call so no two Blueprints
  // share a mutable default order array.
  function defaultPolicy() {
    return { preset: DEFAULT_PRESET, customOrder: [...BALANCED_ORDER] };
  }

  function normalizePolicy(rawPolicy) {
    const source = rawPolicy && typeof rawPolicy === "object" && !Array.isArray(rawPolicy) ? rawPolicy : {};
    const preset = isPresetName(source.preset) ? source.preset : DEFAULT_PRESET;
    // A supplied custom order is always honoured (after repair); otherwise the
    // preset order seeds the custom order so the two never silently disagree.
    const customOrder = source.customOrder !== undefined
      ? normalizeCustomOrder(source.customOrder)
      : [...POWER_PRESETS[preset]];
    return { preset, customOrder };
  }

  function clonePolicy(policy) {
    const normalized = normalizePolicy(policy);
    return { preset: normalized.preset, customOrder: [...normalized.customOrder] };
  }

  function presetOrder(preset) {
    return isPresetName(preset) ? [...POWER_PRESETS[preset]] : [...BALANCED_ORDER];
  }

  return {
    POWER_CATEGORIES,
    POWER_PRESETS,
    PRESET_NAMES,
    DEFAULT_PRESET,
    BALANCED_ORDER,
    isPowerCategory,
    isPresetName,
    normalizeCustomOrder,
    isValidCustomOrder,
    normalizePolicy,
    clonePolicy,
    defaultPolicy,
    presetOrder
  };
}));
