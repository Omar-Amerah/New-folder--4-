(function initPowerDemandRules(root, factory) {
  const rules = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = rules;
  root.PowerDemandRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makePowerDemandRules() {
  "use strict";

  // Section 7D-2 — activity-driven Power demand.
  //
  // Pure, dependency-light rules that convert a component's nominal powerUse and
  // a per-component activity level (0..1) into authoritative requested MW:
  //
  //   requestedMw = nominalPowerUse * (standbyFraction + activity * (1 - standby))
  //
  // The standby fraction per demand role comes from authoritative balance
  // configuration (BALANCE.powerDemand.standbyFractions). No DOM, server or
  // gameplay dependencies; inputs are never mutated.

  const DEMAND_ROLES = Object.freeze(["command", "propulsion", "shields", "weapons", "pointDefence", "repair", "coolingSupport"]);
  const CATEGORY_ROLES = new Set(["command", "propulsion", "shields", "weapons", "pointDefence", "coolingSupport"]);

  function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    if (n <= 0) return 0;
    if (n >= 1) return 1;
    return n;
  }

  // The demand role for a Power consumer. Command is always-on; a repair
  // component (repair stat > 0) uses the repair role even though its category is
  // coolingSupport; otherwise the powerCategory is the role. Unknown -> null.
  function demandRoleForPart(part) {
    const category = part && part.powerCategory;
    if (category === "command") return "command";
    if (Number(part && part.repair) > 0) return "repair";
    if (CATEGORY_ROLES.has(category)) return category;
    return null;
  }

  // Resolve a part's standby fraction from the config. An unrecognised role or a
  // malformed value falls back to 1.0 (always-on) so demand is never silently
  // reduced toward zero for a component the rules do not understand.
  function standbyFractionForPart(part, standbyFractions) {
    const role = demandRoleForPart(part);
    const raw = role && standbyFractions ? standbyFractions[role] : undefined;
    return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 1;
  }

  // Core formula. Activity is clamped to 0..1 and the result to 0..nominal.
  function requestedMw(nominalPowerUse, activityLevel, standbyFraction) {
    const nominal = Math.max(0, Number(nominalPowerUse) || 0);
    if (nominal <= 0) return 0;
    const standby = clamp01(standbyFraction);
    const activity = clamp01(activityLevel);
    let requested = nominal * (standby + activity * (1 - standby));
    if (!Number.isFinite(requested) || requested < 0) requested = 0;
    if (requested > nominal) requested = nominal;
    return requested === 0 ? 0 : requested; // never -0
  }

  function standbyConfig(config) {
    if (!config) return {};
    if (config.standbyFractions && typeof config.standbyFractions === "object") return config.standbyFractions;
    return config;
  }

  // Convenience: requested MW for a catalogue part at an activity level.
  function requestedMwForComponent(part, activityLevel, config) {
    const fractions = standbyConfig(config);
    const nominal = Number(part && part.powerUse) || 0;
    return requestedMw(nominal, activityLevel, standbyFractionForPart(part, fractions));
  }

  return { DEMAND_ROLES, demandRoleForPart, standbyFractionForPart, requestedMw, requestedMwForComponent };
}));
