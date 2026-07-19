(function initShieldRules(root, factory) {
  const rules = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = rules;
  root.ShieldRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeShieldRules() {
  "use strict";

  const STACKING_FACTOR = 0.72;
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function number(value, fallback = 0) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }
  function stacked(values, falloff = STACKING_FACTOR) {
    return [...values].filter(v => v > 0).sort((a, b) => b - a).reduce((sum, value, index) => sum + value * Math.pow(falloff, index), 0);
  }
  function iterateLiveShieldComponents(modules, parts, options, visit) {
    const powerMultiplier = options.powerMultiplier || (() => 1);
    const isLive = options.isLive || (() => true);
    for (let i = 0; i < (modules || []).length; i += 1) {
      const module = modules[i] || {};
      const part = parts?.[module.type] || {};
      if (!isLive(i, module, part)) continue;
      const shield = Math.max(0, number(part.shield));
      if (shield <= 0) continue;
      const power = clamp(number(powerMultiplier(i, module, part), 1), 0, 1);
      const capacity = shield * power;
      if (!Number.isFinite(capacity) || capacity <= 0) continue;
      visit(i, module, part, power, capacity);
    }
  }
  function calculateShieldCapacityContributions(modules, parts, options = {}) {
    const contributions = [];
    iterateLiveShieldComponents(modules, parts, options, (index, module, part, power, capacity) => {
      contributions.push({ index, capacity });
    });
    return contributions;
  }
  function calculateShieldStats(modules, parts, options = {}) {
    const powerMultiplier = options.powerMultiplier || (() => 1);
    const heatMultiplier = options.heatMultiplier || (() => 1);
    const isLive = options.isLive || (() => true);
    const capacityContributions = calculateShieldCapacityContributions(modules, parts, { powerMultiplier, isLive });
    const capacity = capacityContributions.reduce((sum, contribution) => sum + contribution.capacity, 0);
    const regen = [];
    for (let i = 0; i < (modules || []).length; i += 1) {
      const module = modules[i] || {};
      const part = parts?.[module.type] || {};
      if (!isLive(i, module, part)) continue;
      const power = clamp(number(powerMultiplier(i, module, part), 1), 0, 1);
      const shieldRegen = Math.max(0, number(part.shieldRegen));
      if (shieldRegen > 0) regen.push(shieldRegen * power * clamp(number(heatMultiplier(i, module, part), 1), 0, 1));
    }
    return { capacity: Number.isFinite(capacity) ? capacity : 0, recharge: stacked(regen), regeneration: stacked(regen), capacityContributions };
  }
  return Object.freeze({ STACKING_FACTOR, calculateShieldStats, calculateShieldCapacityContributions, effectiveStackedValue: stacked });
}));
export const STACKING_FACTOR = globalThis.ShieldRules.STACKING_FACTOR;
export const calculateShieldStats = globalThis.ShieldRules.calculateShieldStats;
export const calculateShieldCapacityContributions = globalThis.ShieldRules.calculateShieldCapacityContributions;
export const effectiveStackedValue = globalThis.ShieldRules.effectiveStackedValue;
export default globalThis.ShieldRules;
