// Shared player-facing Heat effects.
//
// This module is presentation-only. It classifies a catalogue component using
// the same runtime capabilities that consume HeatRules, then asks HeatRules for
// every multiplier. It must never become a second balance table.

const ACTIVE_COOLING_TYPES = new Set(["radiator", "closedCycleCooler"]);
const OVERHEAT_ONLY_TYPES = new Set(["droneBay", "decoyLauncher"]);
const EPSILON = 1e-9;

function rulesOrDefault(rules) {
  return rules || (typeof globalThis !== "undefined" ? globalThis.HeatRules : null);
}

function clampState(state, rules) {
  const normal = Number(rules?.STATE?.NORMAL) || 0;
  const overheated = Number(rules?.STATE?.OVERHEATED) || normal;
  const value = Number.isFinite(Number(state)) ? Math.round(Number(state)) : normal;
  return Math.max(normal, Math.min(overheated, value));
}

function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function isDataSupportSource(type, part) {
  const dataRules = typeof globalThis !== "undefined" ? globalThis.DataSupportRules : null;
  if (typeof dataRules?.isDataSupportSource === "function") {
    return dataRules.isDataSupportSource(type);
  }
  // The fallback is only for isolated Designer/unit imports where the shared
  // Data rules script has not been loaded yet. These fields are the catalogue's
  // support outputs, not Heat values.
  return number(part?.rangeBonus) > 0
    || number(part?.accuracyBonus) > 0
    || number(part?.fireRateBonus) > 0;
}

function isPassiveStructure(type, part, rules) {
  if (typeof rules?.isPassiveStructure === "function" && rules.isPassiveStructure(type, part)) return true;
  return typeof rules?.structuralThermalMaterial === "function"
    && Boolean(rules.structuralThermalMaterial(type));
}

function activeOutputDescriptor(type, part) {
  if (part?.weapon) return { label: "Weapon output" };
  if (number(part?.sensorRangeBonus) > 0) return { label: "Sensor output" };
  if (isDataSupportSource(type, part)) return { label: "Data support output" };
  if (part?.aura) return { label: "Command aura output" };
  // Command aura metadata is intentionally kept out of some normalized client
  // stat records. The category still comes from the authoritative catalogue;
  // Core is excluded because its Heat-scaled active effect is Power output.
  if (part?.category === "Command" && type !== "core" && type !== "droneBay") return { label: "Command aura output" };
  if (number(part?.powerGeneration) > 0) return { label: "Power output" };
  if (number(part?.thrust) > 0) return { label: "Thrust output" };
  if (number(part?.shieldRegen) > 0) return { label: "Shield regeneration" };
  if (number(part?.repairRate ?? part?.repair) > 0) return { label: "Repair output" };
  if (type === "gyroscope" || type === "maneuverThruster") return { label: "Turn output" };
  if (number(part?.activityHeat) > 0 && !OVERHEAT_ONLY_TYPES.has(type)) return { label: "Active output" };
  return null;
}

function recoveryThresholdFor(rules) {
  const overheated = number(rules?.THRESHOLDS?.overheated, 1);
  const hysteresis = number(rules?.HYSTERESIS?.overheated, 0);
  return Math.max(0, overheated - hysteresis);
}

function stateLabelFor(state, rules) {
  return rules?.STATE_LABELS?.[state] || String(state);
}

function percentageText(value) {
  return `${Math.round(number(value) * 100)}%`;
}

function decimalText(value) {
  return number(value).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

/**
 * Format one effect for a compact player-facing row.
 * @param {object} effect Output item from getHeatEffectsForComponent().
 * @returns {string}
 */
export function formatHeatEffectValue(effect) {
  if (!effect) return "";
  if (effect.key === "structuralDamageTaken") return `${number(effect.multiplier).toFixed(2)}x`;
  if (effect.key === "armorDamageReduction") return `${decimalText(effect.value)} / ${decimalText(effect.baseValue)}`;
  if (effect.key === "overheatLockout") {
    return `shut down; Restarts below ${percentageText(effect.recoveryThreshold)} Heat`;
  }
  return percentageText(effect.multiplier);
}

/**
 * Format one complete effect line. Overheat lockout includes the derived
 * recovery boundary because the boundary is part of the explanation.
 * @param {object} effect Output item from getHeatEffectsForComponent().
 * @returns {string}
 */
export function formatHeatEffect(effect) {
  if (!effect) return "";
  return `${effect.label}: ${formatHeatEffectValue(effect)}`;
}

/**
 * Return the direct gameplay effects of a component's Heat state.
 *
 * @param {string} type Catalogue component id.
 * @param {object} part Catalogue component stats.
 * @param {number} heatState HeatRules.STATE value.
 * @param {object} [rules] Shared HeatRules authority, useful in tests.
 * @returns {{state:string,stateIndex:number,effects:Array,hasPenalty:boolean,recoveryThreshold:number}}
 */
export function getHeatEffectsForComponent(type, part = {}, heatState, rules = null) {
  const authority = rulesOrDefault(rules);
  if (!authority) {
    return { state: "Cool", stateIndex: 0, effects: [], hasPenalty: false, recoveryThreshold: 0 };
  }

  const stateIndex = clampState(heatState, authority);
  const state = stateLabelFor(stateIndex, authority);
  const effects = [];
  const push = (effect) => effects.push({ ...effect, isPenalty: Boolean(effect.isPenalty) });

  const structural = isPassiveStructure(type, part, authority);
  if (structural) {
    const protection = authority.passiveProtectionForState(stateIndex);
    push({
      key: "structuralDamageTaken",
      label: "Damage taken",
      multiplier: authority.structuralDamageMultiplierForState(stateIndex),
      valueType: "multiplier",
      isPenalty: authority.structuralDamageMultiplierForState(stateIndex) > 1 + EPSILON
    });

    const baseReduction = number(part?.armorFlatReduction);
    if (baseReduction > 0) {
      push({
        key: "armorProtection",
        label: "Armor effectiveness",
        multiplier: protection,
        valueType: "percent",
        isPenalty: protection < 1 - EPSILON
      });
      push({
        key: "armorDamageReduction",
        label: "Damage Reduction",
        multiplier: protection,
        value: baseReduction * protection,
        baseValue: baseReduction,
        valueType: "armorReduction",
        isPenalty: protection < 1 - EPSILON
      });
    }
  }

  if (ACTIVE_COOLING_TYPES.has(type)) {
    const multiplier = authority.activeCoolingForState(stateIndex);
    push({
      key: "activeCooling",
      label: "Cooling output",
      multiplier,
      valueType: "percent",
      isPenalty: multiplier < 1 - EPSILON
    });
  }

  const active = activeOutputDescriptor(type, part);
  if (active) {
    const multiplier = authority.activeOutputForState(stateIndex);
    push({
      key: "activeOutput",
      label: active.label || "Active output",
      multiplier,
      valueType: "percent",
      isPenalty: multiplier < 1 - EPSILON
    });
  }

  const overheatLockout = stateIndex >= (Number(authority.STATE?.OVERHEATED) || 4)
    && (Boolean(active) || ACTIVE_COOLING_TYPES.has(type) || OVERHEAT_ONLY_TYPES.has(type));
  if (overheatLockout) {
    push({
      key: "overheatLockout",
      label: "Overheated",
      value: "shut down",
      recoveryThreshold: recoveryThresholdFor(authority),
      valueType: "status",
      isPenalty: true
    });
  }

  return {
    state,
    stateIndex,
    effects,
    hasPenalty: effects.some((effect) => effect.isPenalty),
    recoveryThreshold: recoveryThresholdFor(authority)
  };
}
