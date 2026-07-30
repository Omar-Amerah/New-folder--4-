"use strict";

const { clampNumber } = require("./utils");
const { effectiveShieldStats } = require("./componentPower");

const SHIELD_RESTART_DELAY_MS = 3000;

function diagnostics() {
  return global.__mfaRuntimeDiagnostics || null;
}

function bump(name) {
  const counters = diagnostics();
  if (counters) counters[name] = (counters[name] || 0) + 1;
}

function reportInvalidShieldState(ship, value) {
  bump("invalidShieldStateCount");
  if (process.env.NODE_ENV !== "production") {
    console.error(`[mfa] invalid Shield state on ${ship?.id || "unknown"}:`, value);
  }
}

function assertFiniteShieldState(ship) {
  const valid = Number.isFinite(ship?.shield)
    && Number.isFinite(ship?.maxShield)
    && ship.shield >= 0
    && ship.shield <= ship.maxShield;
  if (!valid && process.env.NODE_ENV !== "production") {
    throw new Error(`Invalid runtime Shield state for ${ship?.id || "unknown"}`);
  }
  return valid;
}

function updateRuntimeShield(ship, dt, now, room) {
  if (!ship || ship.alive === false) return;
  bump("shieldRuntimeUpdateCount");

  const effective = effectiveShieldStats(ship, room);
  const capacity = Math.max(0, Number(effective?.capacity) || 0);
  const recharge = Math.max(0, Number(effective?.recharge) || 0);
  ship.maxShield = capacity;

  if (!Number.isFinite(ship.shield)) {
    reportInvalidShieldState(ship, ship.shield);
    ship.shield = 0;
  }
  ship.shield = clampNumber(ship.shield, 0, capacity);

  if (ship.shield <= 0) {
    if (!Number.isFinite(ship._shieldDepletedAt)) ship._shieldDepletedAt = Number(now) || 0;
  } else {
    ship._shieldDepletedAt = null;
  }

  const safeDt = Math.max(0, Number(dt) || 0);
  const safeNow = Number(now) || 0;
  if (capacity > 0 && recharge > 0 && ship.shield < capacity) {
    const resumeAt = Number.isFinite(ship._shieldDepletedAt)
      ? ship._shieldDepletedAt + SHIELD_RESTART_DELAY_MS
      : 0;
    if (safeNow >= resumeAt) {
      ship.shield = clampNumber(ship.shield + recharge * safeDt, 0, capacity);
    }
  }

  assertFiniteShieldState(ship);
}

module.exports = {
  SHIELD_RESTART_DELAY_MS,
  updateRuntimeShield,
  reportInvalidShieldState,
  assertFiniteShieldState
};
