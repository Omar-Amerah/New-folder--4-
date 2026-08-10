(function initLegacyComponentRules(root, factory) {
  const rules = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = rules;
  root.LegacyComponentRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeLegacyComponentRules() {
  "use strict";

  // These identifiers existed in saved blueprints, but are no longer catalogue
  // components. Their replacements are the current balanced variants.
  const COMPONENT_MIGRATIONS = Object.freeze({
    sensorArray: "largeSensor",
    directedSensor: "largeDirectedSensor"
  });

  function replacementType(type) {
    const value = String(type || "");
    return COMPONENT_MIGRATIONS[value] || value;
  }

  function isMigratedType(type) {
    return Object.prototype.hasOwnProperty.call(COMPONENT_MIGRATIONS, String(type || ""));
  }

  function migrateDesignTypes(design) {
    if (!Array.isArray(design)) return design;
    return design.map((part) => {
      if (!part || !isMigratedType(part.type)) return part;
      return { ...part, type: replacementType(part.type) };
    });
  }

  return Object.freeze({ COMPONENT_MIGRATIONS, replacementType, isMigratedType, migrateDesignTypes });
}));
