(function initComponentHullRules(root, factory) {
  const rules = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = rules;
  root.ComponentHullRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeComponentHullRules() {
  "use strict";

  function listedHull(module, parts) {
    const part = parts?.[module?.type] || parts?.frame || {};
    const value = Number(part.hp ?? part.hull);
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  function isCore(module) {
    return module?.type === "core";
  }

  function nonCoreHullTotal(design, parts) {
    return (design || []).reduce(
      (total, module) => isCore(module) ? total : total + listedHull(module, parts),
      0
    );
  }

  function componentMaxHpForDesign(design, parts) {
    return (design || []).map((module) => listedHull(module, parts));
  }

  return Object.freeze({ listedHull, isCore, nonCoreHullTotal, componentMaxHpForDesign });
}));

export const listedHull = globalThis.ComponentHullRules.listedHull;
export const isCore = globalThis.ComponentHullRules.isCore;
export const nonCoreHullTotal = globalThis.ComponentHullRules.nonCoreHullTotal;
export const componentMaxHpForDesign = globalThis.ComponentHullRules.componentMaxHpForDesign;
export default globalThis.ComponentHullRules;
