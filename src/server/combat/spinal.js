"use strict";

const { clampNumber } = require("../utils");


function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function spinalChargeProgress(ship, index, config) {
  const seconds = Math.max(0.05, finiteOr(config?.chargeSeconds, 10));
  return clampNumber((ship.weaponCharge?.[index] || 0) / seconds, 0, 1);
}

// Run once per tick for every spinal mount, before the firing branch decides
// whether it may add to the charge. Keeping the decay unconditional here means
// every early return in the weapon loop (out of arc, out of range, reloading,
// no target, blocked line of fire) bleeds the charge without each one having to
// remember to.
function decaySpinalCharge(ship, index, config, dt) {
  const idle = (ship.weaponChargeIdle[index] || 0) + dt;
  ship.weaponChargeIdle[index] = idle;
  const hold = Math.max(0, finiteOr(config.chargeHoldSeconds, 0));
  if (idle > hold && (ship.weaponCharge[index] || 0) > 0) {
    ship.weaponCharge[index] = Math.max(0, ship.weaponCharge[index] - dt * Math.max(0, finiteOr(config.chargeDecayMultiplier, 1)));
  }
  return spinalChargeProgress(ship, index, config);
}

function clearSpinalCharge(ship, index) {
  if (ship.weaponCharge) ship.weaponCharge[index] = 0;
  if (ship.weaponChargeIdle) ship.weaponChargeIdle[index] = 0;
}

// Traverse authority falls away as the charge nears full: past
// committedAimStartProgress the mount slows toward committedAimTraverseFloor, so
// the shot has to be aimed where the target will be rather than where it is.
function spinalTraverseScale(config, progress) {
  const start = clampNumber(finiteOr(config.committedAimStartProgress, 0.5), 0, 1);
  const floor = clampNumber(finiteOr(config.committedAimTraverseFloor, 0.05), 0, 1);
  if (progress <= start) return 1;
  const t = clampNumber((progress - start) / Math.max(1e-6, 1 - start), 0, 1);
  return 1 + (floor - 1) * t;
}

// In the final stage the hull itself is part of the aim and turns sluggishly.
function spinalHullTurnScale(config, progress) {
  const start = clampNumber(finiteOr(config.hullTurnPenaltyStartProgress, 0.8), 0, 1);
  if (progress < start) return 1;
  return clampNumber(finiteOr(config.hullTurnPenaltyMultiplier, 1), 0.05, 1);
}

module.exports = {
  finiteOr,
  spinalChargeProgress,
  decaySpinalCharge,
  clearSpinalCharge,
  spinalTraverseScale,
  spinalHullTurnScale
};
