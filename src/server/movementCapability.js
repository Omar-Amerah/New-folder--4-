"use strict";

// What a hull can actually do right now, and what doing it costs in heat.
//
// This is the boundary between "the ship's paper statistics" and "the autopilot
// flying it". The movement controller asks this module the same two questions:
//
//   * heatAdjustedMovementStats: given live component damage, heat derating,
//     Power allocation and command auras, what are maxSpeed / accel / turnRate
//     this tick? Paper stats come from public/src/shared/movementStats.js; this
//     re-derives them from the components that are still working.
//   * applyEngineHeat / applyTurnHeat: burning thrust and torque is not free.
//     Heat is charged to the specific components that produced the force.
//
// Keeping this here rather than inside the steering module keeps the ship's
// physics envelope and thermal behaviour in one authoritative boundary.

const { PARTS } = require("./components");
const { addComponentHeat, componentPerformance } = require("./heat");
const { getCommandAuraMultiplier } = require("./commandAuras");
const {
  calculateDirectionalTurnInputs,
  calculateGenericTurnModifier,
  calculateMovementStats,
  calculateBrakingAcceleration,
  maneuverThrusterTorqueSign
} = require("../../public/src/shared/movementStats.js");
const { getComponentPowerMultiplier } = require("./componentPower");
const { getShipComponentIndexes } = require("./componentIndexes");
const BackupCoreRules = require("../../public/src/shared/backupCoreRules");

function heatAdjustedMovementStats(ship, baseStats) {
  const design = ship.design || [];
  const multiplier = (index) => (ship.componentHp?.[index] ?? 1) > 0
    ? componentPerformance(ship, index) * getComponentPowerMultiplier(ship, index)
    : 0;
  const engineThrustValues = [];
  const engineMassValues = [];
  for (const index of getShipComponentIndexes(ship).thrustIndices) {
    const module = design[index];
    const part = PARTS[module.type] || {};
    const output = multiplier(index);
    if (output > 0 && (!ship.validEngineIndices || ship.validEngineIndices.has(index))) {
      engineThrustValues.push((part.thrust || 0) * output);
      engineMassValues.push(part.mass || 0);
    }
  }
  const isBlockedEngine = (index, module, part) => {
    if ((ship.componentHp?.[index] ?? 1) <= 0) return true;
    return ((part.thrust || 0) > 0 || module.type === "maneuverThruster")
      && ship.validEngineIndices
      && !ship.validEngineIndices.has(index);
  };
  const directionalTurnInputs = calculateDirectionalTurnInputs(design, PARTS, {
    componentMultiplier: multiplier,
    isBlockedEngine
  });
  // Generic turn is a live passive stat contribution. It follows the same
  // health/Heat/Power multiplier as other live component effects, but it is
  // not an actuator and therefore never creates turning Heat or Power demand.
  const turnBonus = calculateGenericTurnModifier(design, PARTS, {
    componentMultiplier: multiplier,
    isBlockedEngine
  });
  const powerSummary = ship.powerAnalysis?.summary || {};
  const livePowerGeneration = Number(powerSummary.availableGenerationMw);
  const livePowerUse = Number(powerSummary.demandMw);
  const powerGeneration = Number.isFinite(livePowerGeneration)
    ? livePowerGeneration
    : Number(baseStats.availablePower ?? baseStats.powerGeneration) || 0;
  const powerUse = Number.isFinite(livePowerUse)
    ? livePowerUse
    : Number(baseStats.powerUse) || 0;
  const movement = calculateMovementStats({
    mass: baseStats.mass,
    thrust: baseStats.thrust,
    turnBonus,
    powerGeneration,
    powerUse,
    engineThrustValues,
    engineMassValues,
    directionalTurnInputs
  });
  const accelerationMultiplier = getCommandAuraMultiplier(ship, "accelerationMultiplier");
  const turnMultiplier = getCommandAuraMultiplier(ship, "turnRateMultiplier");
  if (Number.isFinite(movement.accel)
    && Number.isFinite(accelerationMultiplier)
    && accelerationMultiplier !== 1) {
    movement.accel *= accelerationMultiplier;
  }
  movement.brakingAcceleration = calculateBrakingAcceleration(movement.accel);
  if (Number.isFinite(movement.turnRate)
    && Number.isFinite(turnMultiplier)
    && turnMultiplier !== 1) {
    movement.turnRate *= turnMultiplier;
    movement.turnRateLeft *= turnMultiplier;
    movement.turnRateRight *= turnMultiplier;
  }
  return { ...baseStats, ...movement };
}

// Turning left and turning right are not the same manoeuvre: maneuver thrusters
// sit on one side of the centre of mass or the other, so losing one costs the
// hull rotation in that direction only. Callers pick the side -- see
// resolveTurnDirection in movementV2, which is where a heading error is turned
// into one -- because at an exact about-face the shorter side does not exist and
// the choice has to be made on the rates this function reports.
function signedTurnRate(stats, direction, ship) {
  const base = direction > 0
    ? (stats.turnRateRight ?? stats.turnRate ?? 0)
    : (stats.turnRateLeft ?? stats.turnRate ?? 0);
  const rate = Number.isFinite(base) ? base : 0;
  return BackupCoreRules.applyActiveSystemEffectiveness(rate, ship);
}

// The floor keeps the braking-profile maths from dividing by zero. It reports a
// trickle of thrust for a ship whose engines are all destroyed, which is right
// for stopping distance and wrong for propulsion -- see hasDrive.
function driveAcceleration(stats) {
  return Math.max(0.001, Number(stats?.accel) || 0);
}

function hasDrive(stats) {
  return (Number(stats?.effectiveThrust) || 0) > 0 && (Number(stats?.maxSpeed) || 0) > 0;
}

let cachedHeatRules = null;
function activityHeatRate(type, part) {
  if (!cachedHeatRules) cachedHeatRules = require("../../public/src/shared/heatRules.js");
  return Math.max(0, Number(cachedHeatRules.activityHeat(type, part)) || 0);
}

function heatActiveManeuverThrusters(ship, turnActivity, dt) {
  if (!turnActivity || !Number.isFinite(turnActivity)) return;
  const desiredSign = Math.sign(turnActivity);
  const exhaust = ship.engineExhaustAnalysis;
  if (!exhaust) return;
  for (const index of getShipComponentIndexes(ship).maneuverThrusterIndices) {
    const module = ship.design[index];
    const part = PARTS[module.type];
    if (!part || (ship.componentHp?.[index] ?? 1) <= 0) continue;
    if (!exhaust.validEngineIndices.has(index)) continue;
    if (maneuverThrusterTorqueSign(module, exhaust.centerOfMass) !== desiredSign) continue;
    const performance = componentPerformance(ship, index)
      * getComponentPowerMultiplier(ship, index);
    if (performance > 0) {
      const rate = activityHeatRate(module.type, part);
      if (!(rate > 0)) continue;
      addComponentHeat(
        ship,
        index,
        rate
          * Math.abs(turnActivity)
          * performance
          * dt
      );
    }
  }
}

function heatActiveGyroscopes(ship, turnActivity, dt) {
  if (!turnActivity || !Number.isFinite(turnActivity)) return;
  for (const index of getShipComponentIndexes(ship).gyroscopeIndices) {
    const part = PARTS[ship.design[index].type] || {};
    if ((ship.componentHp?.[index] ?? 1) <= 0) continue;
    const performance = componentPerformance(ship, index)
      * getComponentPowerMultiplier(ship, index);
    const rate = activityHeatRate("gyroscope", part);
    if (performance > 0 && rate > 0) {
      addComponentHeat(ship, index, rate * Math.abs(turnActivity) * performance * dt);
    }
  }
}

// Signed activity in [-1, 1]: the sign selects which maneuver thrusters are
// firing, the magnitude is how hard.
function applyTurnHeat(ship, turnActivity, dt) {
  heatActiveManeuverThrusters(ship, turnActivity, dt);
  heatActiveGyroscopes(ship, turnActivity, dt);
}

// Activity in [0, 1]: the fraction of available thrust the helm asked for this
// step. Coasting at speed is free -- there is no drag out here, so holding a
// cruise costs nothing and only changes of speed burn fuel.
function applyEngineHeat(ship, activity, dt) {
  if (!(activity > 0)) return;
  for (const index of getShipComponentIndexes(ship).thrustIndices) {
    const part = PARTS[ship.design[index].type];
    if (!part || (ship.componentHp?.[index] ?? 1) <= 0) continue;
    if (ship.validEngineIndices && !ship.validEngineIndices.has(index)) continue;
    const performance = componentPerformance(ship, index)
      * getComponentPowerMultiplier(ship, index);
    if (performance > 0) {
      const rate = activityHeatRate(ship.design[index].type, part);
      if (!(rate > 0)) continue;
      addComponentHeat(
        ship,
        index,
        rate
          * activity * performance * dt
      );
    }
  }
}

module.exports = {
  applyEngineHeat,
  applyTurnHeat,
  driveAcceleration,
  hasDrive,
  heatActiveGyroscopes,
  heatActiveManeuverThrusters,
  heatAdjustedMovementStats,
  signedTurnRate
};
