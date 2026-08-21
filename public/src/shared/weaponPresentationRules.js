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

  function projectileCountPerShot(weapon) {
    const count = Math.round(finiteOr(weapon?.pelletCount, 1));
    return count >= 2 ? count : 1;
  }

  // Weapons whose art is authored as a function of charge, but which do NOT have
  // a spinal charge cycle: they fire the instant their reload ends, and the
  // artwork simply shows the mount recovering toward that moment. The EMP Cannon
  // rebuilds its emitter arc, an ordinary Railgun fills its illuminated channels,
  // and the Torpedo carries a charge pulse toward its warhead. This is
  // presentation only and must never gate firing; combat owns that.
  const RELOAD_TELEGRAPH_FAMILIES = new Set(["emp", "railgun"]);
  const RELOAD_TELEGRAPH_COMPONENT_TYPES = new Set(["torpedo"]);

  function hasReloadTelegraph(weapon, componentType = null) {
    if (!weapon || isSpinalChargeWeapon(weapon)) return false;
    // Authored data spells the family as `family`, the runtime weapon objects as
    // `type`; both reach this rule, so both are checked. Component identity is
    // also accepted for one member of a shared family, such as the Torpedo among
    // missile-family weapons.
    return RELOAD_TELEGRAPH_FAMILIES.has(weapon.family)
      || RELOAD_TELEGRAPH_FAMILIES.has(weapon.type)
      || RELOAD_TELEGRAPH_COMPONENT_TYPES.has(componentType);
  }

  // 0 immediately after the shot, 1 when the mount is ready again. The server
  // may provide the actual cooldown that was committed when the shot fired, so
  // an under-powered mount still fills steadily across its longer real reload.
  // Callers without runtime state fall back to the authored cycle.
  function reloadTelegraphProgress(weapon, cooldownSeconds, committedReloadSeconds = 0) {
    const authoredReload = Math.max(0, finiteOr(weapon?.fireRate, 0)) > 0 ? 1 / weapon.fireRate : 0;
    const reload = Math.max(0, finiteOr(committedReloadSeconds, 0)) || authoredReload;
    if (!(reload > 0)) return 1;
    const remaining = Math.max(0, finiteOr(cooldownSeconds, 0));
    const progress = 1 - remaining / reload;
    return progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
  }

  /**
   * Resolve the cadence facts that may be shown for one weapon.
   *
   * Ordinary weapons use the full trigger-pull damage * fire rate. Most trigger
   * pulls create one projectile; multi-pellet weapons create pelletCount
   * independent projectiles, each carrying the authored damage.
   * A spinal weapon must spend chargeSeconds before its shot, so its ideal
   * uninterrupted cycle is chargeSeconds + one ordinary reload interval.
   * This is presentation/stat arithmetic only; combat still owns firing.
   */
  function weaponCyclePresentation(weapon = {}) {
    const damagePerImpact = Math.max(0, finiteOr(weapon.damage, 0));
    const projectileCount = projectileCountPerShot(weapon);
    const damagePerShot = damagePerImpact * projectileCount;
    const fireRate = Math.max(0, finiteOr(weapon.fireRate, 0));
    const reloadSeconds = fireRate > 0 ? 1 / fireRate : 0;

    if (!isSpinalChargeWeapon(weapon)) {
      return Object.freeze({
        kind: "normal",
        isChargeWeapon: false,
        damagePerImpact,
        projectileCount,
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
      damagePerImpact,
      projectileCount,
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
