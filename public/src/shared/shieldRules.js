(function initShieldRules(root, factory) {
  const rules = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = rules;
  root.ShieldRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeShieldRules() {
  "use strict";

  const IMPACT_HEAT_PER_BLOCKED_DAMAGE = 0.12;
  const SHIELD_RESTART_DELAY_MS = 3000;
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function number(value, fallback = 0) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }
  function getShieldRestartDelayMs(multiplier = 1) {
    const safeMultiplier = Number.isFinite(Number(multiplier))
      ? Math.max(0, Number(multiplier))
      : 1;
    return SHIELD_RESTART_DELAY_MS * safeMultiplier;
  }
  function linearEntries(values) {
    return [...values]
      .filter(entry => entry && entry.rate > 0)
      .sort((a, b) => b.rate - a.rate || a.index - b.index)
      .map((entry) => ({
        ...entry,
        effectiveRate: entry.rate
      }));
  }
  function iterateLiveShieldComponents(modules, parts, options, visit) {
    const isLive = options.isLive || (() => true);
    for (let i = 0; i < (modules || []).length; i += 1) {
      const module = modules[i] || {};
      const part = parts?.[module.type] || {};
      if (!isLive(i, module, part)) continue;
      const shield = Math.max(0, number(part.shield));
      if (shield <= 0) continue;
      if (!Number.isFinite(shield)) continue;
      visit(i, module, part, shield);
    }
  }
  function calculateShieldCapacityContributions(modules, parts, options = {}) {
    const contributions = [];
    iterateLiveShieldComponents(modules, parts, options, (index, module, part, capacity) => {
      contributions.push({ index, capacity });
    });
    return contributions;
  }
  function calculateShieldRegenerationContributions(modules, parts, options = {}) {
    const powerMultiplier = options.powerMultiplier || (() => 1);
    const heatMultiplier = options.heatMultiplier || (() => 1);
    const isLive = options.isLive || (() => true);
    const contributions = [];
    for (let i = 0; i < (modules || []).length; i += 1) {
      const module = modules[i] || {};
      const part = parts?.[module.type] || {};
      if (!isLive(i, module, part)) continue;
      const baseRate = Math.max(0, number(part.shieldRegen));
      if (!(baseRate > 0)) continue;
      const power = clamp(number(powerMultiplier(i, module, part), 1), 0, 1);
      const thermal = clamp(number(heatMultiplier(i, module, part), 1), 0, 1);
      const rate = baseRate * power * thermal;
      if (rate > 0) contributions.push({ index: i, module, part, baseRate, rate });
    }
    return linearEntries(contributions);
  }
  function calculateShieldStats(modules, parts, options = {}) {
    const isLive = options.isLive || (() => true);
    const capacityContributions = calculateShieldCapacityContributions(modules, parts, { isLive });
    const capacity = capacityContributions.reduce((sum, contribution) => sum + contribution.capacity, 0);
    const regenerationContributions = calculateShieldRegenerationContributions(modules, parts, options);
    const recharge = regenerationContributions.reduce((sum, contribution) => sum + contribution.effectiveRate, 0);
    return { capacity: Number.isFinite(capacity) ? capacity : 0, recharge, regeneration: recharge, capacityContributions, regenerationContributions };
  }
  function getShieldImpactHeatPerDamage() { return IMPACT_HEAT_PER_BLOCKED_DAMAGE; }
  return Object.freeze({ IMPACT_HEAT_PER_BLOCKED_DAMAGE, SHIELD_RESTART_DELAY_MS, getShieldRestartDelayMs, getShieldImpactHeatPerDamage, calculateShieldStats, calculateShieldCapacityContributions, calculateShieldRegenerationContributions });
}));
export const SHIELD_RESTART_DELAY_MS = globalThis.ShieldRules.SHIELD_RESTART_DELAY_MS;
export const getShieldRestartDelayMs = globalThis.ShieldRules.getShieldRestartDelayMs;
export const IMPACT_HEAT_PER_BLOCKED_DAMAGE = globalThis.ShieldRules.IMPACT_HEAT_PER_BLOCKED_DAMAGE;
export const getShieldImpactHeatPerDamage = globalThis.ShieldRules.getShieldImpactHeatPerDamage;
export const calculateShieldStats = globalThis.ShieldRules.calculateShieldStats;
export const calculateShieldCapacityContributions = globalThis.ShieldRules.calculateShieldCapacityContributions;
export const calculateShieldRegenerationContributions = globalThis.ShieldRules.calculateShieldRegenerationContributions;
export default globalThis.ShieldRules;
