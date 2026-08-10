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

  return Object.freeze({ weaponCyclePresentation, dpsLabelForProfiles, isSpinalChargeWeapon });
}));
