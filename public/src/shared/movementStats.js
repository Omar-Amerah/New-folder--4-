// Shared movement calculations for frontend component stats and backend ship stats.

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

// Marginal efficiency of each additional engine (biggest engine counts fully,
// each subsequent one contributes a little less). Diminishing but never zero.
const ENGINE_FALLOFF = 0.9;
// Base cruise speed of a hull with no thrust (raised 10% from the previous 120).
const BASE_SPEED = 132;
const SPEED_PER_THRUST = 1.05;
const MASS_SPEED_DIV = 100;
// Mass-drag exponent lowered from 0.65 so heavy ships are not double-punished
// (mass no longer divides thrust *and* scales a steep penalty curve).
const MASS_DRAG_EXP = 0.5;
const MASS_TURN_DIV = 82;
const MASS_TURN_EXP = 0.85;
// Turn value granted per point of main-engine thrust (an engine's 189 thrust
// yields ~0.19 turn — roughly a third of one maneuver thruster's 0.52).
const ENGINE_TURN_PER_THRUST = 0.001;

export function calculateMovementStats({ mass, thrust, turnBonus, powerGeneration, powerUse, engineThrustValues, turnModuleValues, engineMassValues }) {
  const safeMass = Math.max(mass, 1);
  const movementPowerMultiplier = calculateMovementPowerMultiplier(powerGeneration, powerUse);
  const powerRatio = powerUse > 0 ? powerGeneration / powerUse : 1.1;
  const powerEfficiency = clamp(powerRatio, 0, 1.1);

  // Pair each engine's thrust with the mass it adds, then evaluate the ship one
  // engine at a time in descending-thrust order. Each engine contributes
  // diminishing marginal thrust but its full mass. We take a running maximum of
  // the resulting speed so that adding a (sufficiently powered) engine can never
  // reduce speed: its marginal thrust is clamped to at least offset its own mass.
  const engines = (engineThrustValues || [])
    .map((value, index) => ({ thrust: value, mass: (engineMassValues && engineMassValues[index]) || 0 }))
    .sort((a, b) => b.thrust - a.thrust);
  const engineMassTotal = engines.reduce((sum, engine) => sum + engine.mass, 0);
  const nonEngineMass = Math.max(1, safeMass - engineMassTotal);

  let effectiveThrust = 0;
  let cumulativeThrust = 0;
  let runningSpeed = 0;
  let runningMass = nonEngineMass;
  for (let i = 0; i < engines.length; i += 1) {
    cumulativeThrust += engines[i].thrust * Math.pow(ENGINE_FALLOFF, i);
    runningMass += engines[i].mass;
    const massDrag = 1 / Math.pow(1 + runningMass / MASS_SPEED_DIV, MASS_DRAG_EXP);
    const stepSpeed = (BASE_SPEED + cumulativeThrust * SPEED_PER_THRUST) * massDrag * movementPowerMultiplier;
    runningSpeed = Math.max(runningSpeed, stepSpeed);
    // effectiveThrust is monotonic by construction: every marginal term is > 0.
    effectiveThrust = cumulativeThrust;
  }

  const hasEngineThrust = effectiveThrust > 0;
  const thrustRatio = effectiveThrust / safeMass;
  // Speed cap is set by the hull class (non-engine mass) so that adding engines
  // never downgrades a ship into a lower cap band and slows it down.
  const speedCap = speedCapForMass(nonEngineMass) * 1.3;
  const speedCapped = hasEngineThrust && runningSpeed > speedCap;
  const maxSpeed = hasEngineThrust ? Math.max(35, softCap(runningSpeed, speedCap, 0.35)) : 0;
  // Acceleration tracks achievable speed, so it inherits the same monotonicity.
  const accel = hasEngineThrust ? Math.max(18, maxSpeed * 0.26) : 0;

  // Turning comes from two sources: dedicated maneuvering thrusters / gyros
  // (turnModuleValues, weighted by lever arm upstream) and the main engines,
  // which vector a small fraction of their thrust for differential turning.
  // Thrusters stay far stronger per module — engines alone give a functional
  // but sluggish turn rate. A ship with no functioning thrust cannot rotate.
  const engineTurnValues = engines.map((engine) => engine.thrust * ENGINE_TURN_PER_THRUST);
  const positiveTurn = effectiveStackedValue(turnModuleValues || [], 0.92)
    + effectiveStackedValue(engineTurnValues, 0.85);
  const negativeTurnDrag = Math.min(0, turnBonus);
  const effectiveTurnBonus = positiveTurn + negativeTurnDrag;
  const massTurnPenalty = 1 / Math.pow(1 + safeMass / MASS_TURN_DIV, MASS_TURN_EXP);
  const turnCap = turnCapForMass(safeMass);
  const rawTurn = (0.18 + effectiveTurnBonus * 2.6) * massTurnPenalty * movementPowerMultiplier;
  const canTurn = hasEngineThrust && positiveTurn > 0;
  const turnRate = canTurn ? softCap(Math.max(0, rawTurn), turnCap, 0.2) : 0;

  return {
    maxSpeed,
    accel,
    turnRate,
    thrustRatio,
    effectiveThrust,
    engineEfficiency: thrust > 0 ? effectiveThrust / thrust : 0,
    powerEfficiency,
    powerDebuff: Math.max(0, 1 - movementPowerMultiplier),
    speedCap,
    turnCap,
    massClass: massClassForMass(safeMass),
    speedCapped
  };
}

export function calculateSystemEfficiency(powerGeneration, powerUse) {
  if (powerUse <= 0) return 1.08;
  const ratio = powerGeneration / Math.max(powerUse, 1);
  if (ratio >= 1) return clamp(1 + Math.min((ratio - 1) * 0.25, 0.12), 1, 1.12);
  return clamp(Math.pow(Math.max(ratio, 0), 1.35), 0.25, 1);
}

export function calculateMovementPowerMultiplier(powerGeneration, powerUse) {
  if (powerUse <= 0) return 1.04;
  const ratio = powerGeneration / Math.max(powerUse, 1);
  if (ratio >= 1) return clamp(Math.sqrt(ratio), 1, 1.08);
  return clamp(Math.pow(Math.max(ratio, 0), 1.8), 0.18, 1);
}

export function effectiveStackedValue(values, falloff) {
  return [...values].sort((a, b) => b - a).reduce((total, value, index) => total + value * Math.pow(falloff, index), 0);
}

export function softCap(value, cap, softness = 0.35) {
  if (value <= cap) return value;
  return cap + (value - cap) * softness;
}

export function massClassForMass(mass) {
  if (mass < 55) return "Light";
  if (mass < 125) return "Medium";
  if (mass < 230) return "Heavy";
  return "Capital";
}

export function speedCapForMass(mass) {
  if (mass < 55) return 340;
  if (mass < 125) return 285;
  if (mass < 230) return 215;
  return 165;
}

export function turnCapForMass(mass) {
  if (mass < 55) return 2.85;
  if (mass < 125) return 2.05;
  if (mass < 230) return 1.12;
  return 0.72;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    calculateMovementStats,
    calculateSystemEfficiency,
    calculateMovementPowerMultiplier,
    effectiveStackedValue,
    softCap,
    massClassForMass,
    speedCapForMass,
    turnCapForMass
  };
}
