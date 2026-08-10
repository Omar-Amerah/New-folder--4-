(function initBackupCoreRules(root, factory) {
  const rules = factory();
  if (typeof module === "object" && module.exports) module.exports = rules;
  root.BackupCoreRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeBackupCoreRules() {
  "use strict";

  // A ship controlled by its Backup Command Core remains functional, but the
  // systems whose effectiveness depends on command operate at one common rate.
  // Keep the value and the command-state check here so every consumer follows
  // the same rule.
  const ACTIVE_SYSTEM_EFFECTIVENESS = 0.85;

  function isBackupCoreActive(shipOrCommandState) {
    const commandState = typeof shipOrCommandState === "string"
      ? shipOrCommandState
      : shipOrCommandState?.commandState;
    return commandState === "backupCore";
  }

  function activeSystemMultiplier(shipOrCommandState) {
    return isBackupCoreActive(shipOrCommandState) ? ACTIVE_SYSTEM_EFFECTIVENESS : 1;
  }

  function applyActiveSystemEffectiveness(value, shipOrCommandState) {
    const numeric = Number(value);
    return Number.isFinite(numeric)
      ? numeric * activeSystemMultiplier(shipOrCommandState)
      : 0;
  }

  return Object.freeze({
    ACTIVE_SYSTEM_EFFECTIVENESS,
    isBackupCoreActive,
    activeSystemMultiplier,
    applyActiveSystemEffectiveness
  });
}));
