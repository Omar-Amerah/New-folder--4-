"use strict";

const { clampNumber } = require("./utils");
const { effectiveShieldStats } = require("./componentPower");
const { getCommandAuraMultiplier } = require("./commandAuras");
const { PARTS } = require("./components");
const ShieldRules = require("../../public/src/shared/shieldRules");
const HeatRules = require("../../public/src/shared/heatRules");
const { addComponentHeat } = require("./heat");

const SHIELD_RESTART_DELAY_MS = ShieldRules.SHIELD_RESTART_DELAY_MS;

function effectiveShieldRestartDelayMs(ship) {
  return ShieldRules.getShieldRestartDelayMs(
    getCommandAuraMultiplier(ship, "shieldRestartDelayMultiplier")
  );
}

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
  const restartDelayMs = effectiveShieldRestartDelayMs(ship);
  ship.shieldRestartDelayMs = restartDelayMs;

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

  const safeNow = Number(now) || 0;
  const safeDt = Math.max(0, Number(dt) || 0);
  const shieldBeforeRecharge = ship.shield;
  if (capacity > 0 && recharge > 0 && ship.shield < capacity) {
    const resumeAt = Number.isFinite(ship._shieldDepletedAt)
      ? ship._shieldDepletedAt + restartDelayMs
      : 0;
    if (safeNow >= resumeAt) {
      ship.shield = clampNumber(ship.shield + recharge * safeDt, 0, capacity);
    }
  }

  // Clear it after the successful regen, not only at the start of the next
  // tick, so an immediate later depletion starts a fresh restart delay.
  if (ship.shield > 0) ship._shieldDepletedAt = null;

  const restored = Math.max(0, ship.shield - shieldBeforeRecharge);
  const contributions = Array.isArray(effective?.regenerationContributions)
    ? effective.regenerationContributions
    : [];
  const totalContribution = contributions.reduce(
    (sum, contribution) => sum + Math.max(0, Number(contribution.effectiveRate) || 0),
    0
  );
  if (restored > 0 && totalContribution > 0) {
    for (const contribution of contributions) {
      const rate = Math.max(0, Number(contribution.effectiveRate) || 0);
      const baseRate = Math.max(0, Number(contribution.baseRate) || 0);
      if (!(rate > 0) || !(baseRate > 0)) continue;
      const module = ship.design?.[contribution.index];
      const part = PARTS[module?.type] || contribution.part || {};
      const componentRestored = restored * rate / totalContribution;
      addComponentHeat(
        ship,
        contribution.index,
        HeatRules.activityHeat(module?.type, part) * componentRestored / baseRate
      );
    }
  }

  assertFiniteShieldState(ship);
}

module.exports = {
  SHIELD_RESTART_DELAY_MS,
  updateRuntimeShield,
  effectiveShieldRestartDelayMs,
  reportInvalidShieldState,
  assertFiniteShieldState
};
