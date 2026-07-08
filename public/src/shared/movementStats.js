// Shared movement calculations for frontend component stats and backend ship stats.

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function calculateMovementStats({ mass, thrust, turnBonus, powerGeneration, powerUse, engineThrustValues, turnModuleValues }) {
  const safeMass = Math.max(mass, 1);
  const effectiveThrust = effectiveStackedValue(engineThrustValues, 0.99);
  const positiveTurn = effectiveStackedValue(turnModuleValues, 0.92);
  const negativeTurnDrag = Math.min(0, turnBonus);
  const effectiveTurnBonus = positiveTurn + negativeTurnDrag;
  const thrustRatio = effectiveThrust / safeMass;
  const hasEngineThrust = effectiveThrust > 0;
  const powerRatio = powerUse > 0 ? powerGeneration / powerUse : 1.1;
  const movementPowerMultiplier = calculateMovementPowerMultiplier(powerGeneration, powerUse);
  const powerEfficiency = clamp(powerRatio, 0, 1.1);
  const massSpeedPenalty = 1 / Math.pow(1 + safeMass / 100, 0.65);
  const massAccelPenalty = 1 / Math.pow(1 + safeMass / 76, 0.65);
  const massTurnPenalty = 1 / Math.pow(1 + safeMass / 82, 0.85);
  const rawSpeed = (120 + thrustRatio * 32) * massSpeedPenalty * movementPowerMultiplier * 1.3;
  const rawAccel = (50 + Math.sqrt(effectiveThrust) * 10) * massAccelPenalty * movementPowerMultiplier * 1.3;
  const rawTurn = Math.max(0.15, (0.85 + effectiveTurnBonus * 1.5) * massTurnPenalty * movementPowerMultiplier);
  const speedCap = speedCapForMass(safeMass) * 1.3;
  const turnCap = turnCapForMass(safeMass);
  const cappedSpeed = hasEngineThrust ? rawSpeed : 0;
  const cappedTurn = softCap(rawTurn, turnCap, 0.2);
  const maxSpeed = hasEngineThrust ? Math.max(35, cappedSpeed) : 0;
  const accel = hasEngineThrust ? Math.max(18, maxSpeed * 0.24) : 0;

  return {
    maxSpeed,
    accel,
    turnRate: cappedTurn,
    thrustRatio,
    effectiveThrust,
    engineEfficiency: thrust > 0 ? effectiveThrust / thrust : 0,
    powerEfficiency,
    powerDebuff: Math.max(0, 1 - movementPowerMultiplier),
    speedCap,
    turnCap,
    massClass: massClassForMass(safeMass),
    speedCapped: false
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
