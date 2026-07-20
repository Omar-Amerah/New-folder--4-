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
  // of the chosen preset. These names are persisted in saved Blueprints and are
  // locked — renaming one later would require another migration.
  const BALANCED_ORDER = Object.freeze([...POWER_CATEGORIES]);
  const POWER_PRESETS = Object.freeze({
    balanced: BALANCED_ORDER,
    // Defensive leans on shields, point defence and support survival first.
    defensive: Object.freeze(["command", "shields", "pointDefence", "propulsion", "coolingSupport", "weapons"]),
    // Offensive leans on weapons and their support first.
    offensive: Object.freeze(["command", "weapons", "pointDefence", "shields", "propulsion", "coolingSupport"]),
    // Mobility keeps propulsion powered before offensive/defensive systems.
    mobility: Object.freeze(["command", "propulsion", "weapons", "pointDefence", "shields", "coolingSupport"])
  });
  // "custom" has no fixed order — it honours the Blueprint's own customOrder.
  const CUSTOM_PRESET = "custom";
  const ACCEPTED_PRESETS = Object.freeze([...Object.keys(POWER_PRESETS), CUSTOM_PRESET]);
  const PRESET_NAMES = ACCEPTED_PRESETS;
  const DEFAULT_PRESET = "balanced";

  function isPowerCategory(value) {
    return typeof value === "string" && POWER_CATEGORY_SET.has(value);
  }

  // Accepts every locked preset name, including the explicit "custom" preset.
  function isPresetName(value) {
    return typeof value === "string" && ACCEPTED_PRESETS.includes(value);
  }
  function isNamedPresetOrder(value) {
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
    // A supplied custom order is always honoured (after repair); otherwise a
    // named preset seeds its order and "custom" without an order falls back to
    // Balanced so the two never silently disagree.
    const customOrder = source.customOrder !== undefined
      ? normalizeCustomOrder(source.customOrder)
      : isNamedPresetOrder(preset) ? [...POWER_PRESETS[preset]] : [...BALANCED_ORDER];
    return { preset, customOrder };
  }

  function clonePolicy(policy) {
    const normalized = normalizePolicy(policy);
    return { preset: normalized.preset, customOrder: [...normalized.customOrder] };
  }

  function presetOrder(preset) {
    return isNamedPresetOrder(preset) ? [...POWER_PRESETS[preset]] : [...BALANCED_ORDER];
  }

  // Authoritative human-readable category labels. Single source of truth so UI
  // and diagnostics never keep a second copy.
  const POWER_CATEGORY_LABELS = Object.freeze({
    command: "Command",
    propulsion: "Propulsion",
    shields: "Shields",
    pointDefence: "Point Defence",
    weapons: "Weapons",
    coolingSupport: "Cooling & Support"
  });

  // Authoritative priority bands per named preset. Each band is a set of tied
  // categories; earlier bands outrank later ones. Every category appears exactly
  // once. "custom" is resolved from the normalised customOrder (one band per
  // category). These are the foundation a later capacity-aware allocator reads;
  // no gameplay consumes them yet.
  const PRESET_BANDS = Object.freeze({
    balanced: Object.freeze([Object.freeze(["command", "propulsion", "shields", "pointDefence", "weapons", "coolingSupport"])]),
    defensive: Object.freeze([Object.freeze(["command"]), Object.freeze(["shields", "pointDefence"]), Object.freeze(["propulsion", "coolingSupport"]), Object.freeze(["weapons"])]),
    offensive: Object.freeze([Object.freeze(["command"]), Object.freeze(["weapons", "pointDefence"]), Object.freeze(["shields"]), Object.freeze(["propulsion", "coolingSupport"])]),
    mobility: Object.freeze([Object.freeze(["command"]), Object.freeze(["propulsion"]), Object.freeze(["pointDefence", "weapons"]), Object.freeze(["shields", "coolingSupport"])])
  });

  // Resolve a saved policy into priority bands. Normalises first (repairing
  // malformed input), never mutates the input, and returns fresh arrays of fresh
  // category arrays so callers cannot corrupt the authoritative templates.
  function resolvePriorityBands(policy) {
    const normalized = normalizePolicy(policy);
    if (normalized.preset === CUSTOM_PRESET) return normalized.customOrder.map((category) => [category]);
    const template = PRESET_BANDS[normalized.preset] || PRESET_BANDS[DEFAULT_PRESET];
    return template.map((band) => [...band]);
  }

  return {
    POWER_CATEGORIES,
    POWER_PRESETS,
    PRESET_NAMES,
    ACCEPTED_PRESETS,
    CUSTOM_PRESET,
    DEFAULT_PRESET,
    BALANCED_ORDER,
    isPowerCategory,
    isPresetName,
    isNamedPresetOrder,
    normalizeCustomOrder,
    isValidCustomOrder,
    normalizePolicy,
    clonePolicy,
    defaultPolicy,
    presetOrder,
    resolvePriorityBands,
    POWER_CATEGORY_LABELS
  };
}));
