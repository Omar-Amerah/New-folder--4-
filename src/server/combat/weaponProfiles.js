"use strict";

const DataSupportRules = require("../../../public/src/shared/dataSupportRules");

function weaponSpreadRadians(weapon) {
  return DataSupportRules.accuracySpreadRadians(weapon);
}

// Projectiles per trigger pull. Anything below two is a single shot, so the
// ordinary firing path never has to know about multi-pellet weapons.
function pelletShotCount(weapon) {
  const count = Math.round(Number(weapon?.pelletCount) || 0);
  return Number.isFinite(count) && count >= 2 ? count : 1;
}

// Delivery properties a projectile carries beyond raw damage: Heat coupled into
// whatever it strikes (Plasma Cannon) and an impact burst around the hit point
// (Fragmentation Cannon). Returned as a spreadable payload so each firing branch
// stays a flat bullet literal.
function impactPayload(weapon) {
  const payload = {};
  const impactHeat = Number(weapon?.impactHeatPerDamage) || 0;
  if (impactHeat > 0) payload.impactHeatPerDamage = impactHeat;
  const blastRadius = Number(weapon?.blastRadius) || 0;
  const blastDamage = Number(weapon?.blastDamage) || 0;
  if (blastRadius > 0 && blastDamage > 0) {
    payload.blastDamage = blastDamage;
    payload.blastRadius = blastRadius;
    payload.innerFullDamageRadius = Number(weapon.innerFullDamageRadius) || 0;
    payload.falloffExponent = Number(weapon.falloffExponent) || 1;
    payload.maximumExplosionTargets = Number(weapon.maximumExplosionTargets) || 0;
  }
  return payload;
}

function weaponReloadSeconds(effectiveWeapon, activityMultiplier) {
  const fireRate = Math.max(
    0.0001,
    Number(effectiveWeapon.fireRate) || 0
  );

  return Math.max(
    0.05,
    (1 / fireRate)
      / Math.max(0.0001, activityMultiplier)
  );
}

module.exports = {
  weaponSpreadRadians,
  pelletShotCount,
  impactPayload,
  weaponReloadSeconds
};
