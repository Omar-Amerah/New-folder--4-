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
  function calculateShieldStats(modules, parts, options = {}) {
    const powerMultiplier = options.powerMultiplier || (() => 1);
    const heatMultiplier = options.heatMultiplier || (() => 1);
    const isLive = options.isLive || (() => true);
    let capacity = 0;
    const regen = [];
    for (let i = 0; i < (modules || []).length; i += 1) {
      const module = modules[i] || {};
      const part = parts?.[module.type] || {};
      if (!isLive(i, module, part)) continue;
      const power = clamp(number(powerMultiplier(i, module, part), 1), 0, 1);
      const shield = Math.max(0, number(part.shield));
      const shieldRegen = Math.max(0, number(part.shieldRegen));
      if (shield > 0) capacity += shield * power;
      if (shieldRegen > 0) regen.push(shieldRegen * power * clamp(number(heatMultiplier(i, module, part), 1), 0, 1));
    }
    return { capacity: Number.isFinite(capacity) ? capacity : 0, recharge: stacked(regen), regeneration: stacked(regen) };
  }
  return Object.freeze({ STACKING_FACTOR, calculateShieldStats, effectiveStackedValue: stacked });
}));
export const STACKING_FACTOR = globalThis.ShieldRules.STACKING_FACTOR;
export const calculateShieldStats = globalThis.ShieldRules.calculateShieldStats;
export const effectiveStackedValue = globalThis.ShieldRules.effectiveStackedValue;
export default globalThis.ShieldRules;
