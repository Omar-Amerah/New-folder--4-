(function initRepairRules(root, factory) {
  const rules = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = rules;
  root.RepairRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeRepairRules() {
  "use strict";

  const DEFAULT_STACKING_MULTIPLIER = 0.8;

  function numberOr(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function getRepairStackingMultiplier(source) {
    const configured = typeof source === "object" && source !== null
      ? source.repair?.stackingMultiplier ?? source.stackingMultiplier
      : source;
    const multiplier = Number(configured);
    return Number.isFinite(multiplier) && multiplier >= 0 && multiplier <= 1
      ? multiplier
      : DEFAULT_STACKING_MULTIPLIER;
  }

  function valueFor(item, getValue) {
    if (typeof getValue === "function") return Math.max(0, numberOr(getValue(item)));
    if (typeof item === "object" && item !== null) {
      return Math.max(0, numberOr(item.output ?? item.repairRate ?? item.value));
    }
    return Math.max(0, numberOr(item));
  }

  // Repair contributions are sorted strongest-first before the shared falloff
  // is applied. `getValue` lets the live runtime stack powered/thermal output,
  // while catalogue and designer calculations stack authored repair rates.
  function effectiveRepairContributions(values, source, getValue) {
    const multiplier = getRepairStackingMultiplier(source);
    return (Array.isArray(values) ? values : [])
      .map((item, index) => ({ item, index, value: valueFor(item, getValue) }))
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value || a.index - b.index)
      .map((entry, stackIndex) => ({
        ...entry,
        stackIndex,
        multiplier: Math.pow(multiplier, stackIndex),
        effectiveRate: entry.value * Math.pow(multiplier, stackIndex)
      }));
  }

  function getEffectiveRepairRate(values, source, getValue) {
    return effectiveRepairContributions(values, source, getValue)
      .reduce((total, contribution) => total + contribution.effectiveRate, 0);
  }

  function installedRepairRate(values, getValue) {
    return (Array.isArray(values) ? values : [])
      .reduce((total, item) => total + valueFor(item, getValue), 0);
  }

  function stackingProgression(count, source) {
    const safeCount = Math.max(0, Math.floor(numberOr(count)));
    const multiplier = getRepairStackingMultiplier(source);
    return Array.from({ length: safeCount }, (_, index) => {
      const percent = Math.round(Math.pow(multiplier, index) * 10000) / 100;
      return `${index + 1}${index === 0 ? "st" : index === 1 ? "nd" : index === 2 ? "rd" : "th"}: ${percent}%`;
    });
  }

  function isLocalRepairSource(type, stat) {
    return type !== "repairBeam" && Number(stat?.repairRate || 0) > 0;
  }

  function sumRepairRates(values) {
    return installedRepairRate(values);
  }

  return Object.freeze({
    DEFAULT_STACKING_MULTIPLIER,
    STACKING_MULTIPLIER: DEFAULT_STACKING_MULTIPLIER,
    getRepairStackingMultiplier,
    effectiveRepairContributions,
    getEffectiveRepairRate,
    installedRepairRate,
    stackingProgression,
    isLocalRepairSource,
    sumRepairRates
  });
}));

export const DEFAULT_STACKING_MULTIPLIER = globalThis.RepairRules.DEFAULT_STACKING_MULTIPLIER;
export const STACKING_MULTIPLIER = globalThis.RepairRules.STACKING_MULTIPLIER;
export const getRepairStackingMultiplier = globalThis.RepairRules.getRepairStackingMultiplier;
export const effectiveRepairContributions = globalThis.RepairRules.effectiveRepairContributions;
export const getEffectiveRepairRate = globalThis.RepairRules.getEffectiveRepairRate;
export const installedRepairRate = globalThis.RepairRules.installedRepairRate;
export const stackingProgression = globalThis.RepairRules.stackingProgression;
export const isLocalRepairSource = globalThis.RepairRules.isLocalRepairSource;
export const sumRepairRates = globalThis.RepairRules.sumRepairRates;
export default globalThis.RepairRules;
