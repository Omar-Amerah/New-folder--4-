(function initWeaponPresentationRules(root, factory) {
  const rules = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = rules;
  root.WeaponPresentationRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeWeaponPresentationRules() {
  "use strict";

  function finiteOr(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function isSpinalChargeWeapon(weapon) {
    return Boolean(weapon?.spinalCharge && typeof weapon.spinalCharge === "object" && !Array.isArray(weapon.spinalCharge));
  }

  // Weapons whose art is authored as a function of charge, but which do NOT have
  // a spinal charge cycle: they fire the instant their reload ends, and the
  // artwork simply shows the mount recovering toward that moment. The EMP Cannon
  // is one : its emitter fork is dead right after a discharge and crackling
  // again by the time the next pulse is ready. This is presentation only and
  // must never gate firing; combat owns that.
  const RELOAD_TELEGRAPH_FAMILIES = new Set(["emp"]);

  function hasReloadTelegraph(weapon) {
    if (!weapon || isSpinalChargeWeapon(weapon)) return false;
    // Authored data spells the family as `family`, the runtime weapon objects as
    // `type`; both reach this rule, so both are checked.
    return RELOAD_TELEGRAPH_FAMILIES.has(weapon.family) || RELOAD_TELEGRAPH_FAMILIES.has(weapon.type);
  }

  // 0 immediately after the shot, 1 when the mount is ready again. Measured
  // against the authored reload, so a mount reloading more slowly than authored
  // (an under-powered one) simply sits at full a little early rather than
  // reporting a charge that outruns its own weapon.
  function reloadTelegraphProgress(weapon, cooldownSeconds) {
    const reload = Math.max(0, finiteOr(weapon?.fireRate, 0)) > 0 ? 1 / weapon.fireRate : 0;
    if (!(reload > 0)) return 1;
    const remaining = Math.max(0, finiteOr(cooldownSeconds, 0));
    const progress = 1 - remaining / reload;
    return progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
  }

  /**
   * Resolve the cadence facts that may be shown for one weapon.
   *
   * Ordinary weapons retain the catalogue's theoretical damage * fire rate.
   * A spinal weapon must spend chargeSeconds before its shot, so its ideal
   * uninterrupted cycle is chargeSeconds + one ordinary reload interval.
   * This is presentation/stat arithmetic only; combat still owns firing.
   */
  function weaponCyclePresentation(weapon = {}) {
    const damagePerShot = Math.max(0, finiteOr(weapon.damage, 0));
    const fireRate = Math.max(0, finiteOr(weapon.fireRate, 0));
    const reloadSeconds = fireRate > 0 ? 1 / fireRate : 0;

    if (!isSpinalChargeWeapon(weapon)) {
      return Object.freeze({
        kind: "normal",
        isChargeWeapon: false,
        damagePerShot,
        chargeSeconds: 0,
        reloadSeconds,
        cycleSeconds: reloadSeconds,
        dps: damagePerShot * fireRate,
        idealCycleDps: null,
        dpsLabel: "DPS"
      });
    }

    const chargeSeconds = Math.max(0.05, finiteOr(weapon.spinalCharge.chargeSeconds, 10));
    const cycleSeconds = chargeSeconds + reloadSeconds;
    const idealCycleDps = cycleSeconds > 0 ? damagePerShot / cycleSeconds : 0;
    return Object.freeze({
      kind: "spinalCharge",
      isChargeWeapon: true,
      damagePerShot,
      chargeSeconds,
      reloadSeconds,
      cycleSeconds,
      dps: idealCycleDps,
      idealCycleDps,
      dpsLabel: "Ideal cycle DPS"
    });
  }

  function dpsLabelForProfiles(profiles) {
    const list = Array.isArray(profiles) ? profiles : [];
    const chargeCount = list.filter(isSpinalChargeWeapon).length;
    if (chargeCount === 0) return "DPS";
    if (chargeCount === list.length) return "Ideal cycle DPS";
    return "DPS (charge-aware)";
  }

  return Object.freeze({
    weaponCyclePresentation,
    dpsLabelForProfiles,
    isSpinalChargeWeapon,
    hasReloadTelegraph,
    reloadTelegraphProgress
  });
}));
