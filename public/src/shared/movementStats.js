// Shared movement calculations for frontend component stats and backend ship stats.
//
// Ships fly on retained momentum: thrust is added to the velocity a hull already
// carries, along its nose, so it arcs through a turn rather than snapping onto a
// new heading. `accel` is the single authority figure. There are deliberately no
// separate lateral/braking/reverse accelerations -- the only component that ever
// supplied them (a "vector thruster") does not exist, so they resolved to a flat
// per-hull constant that made every ship accelerate ~16x harder than it could
// stop. Braking and the sideways decay that settles a turn are derived from
// `accel` by the controller; see movementTuning.js.

function clamp(value, min, max) { return Math.min(max, Math.max(min, Number(value) || 0)); }
const BASE_SPEED = 60;
const THRUST_SPEED_SQRT_SCALE = 28.8;
const MASS_SPEED_DIV = 150;
const MASS_DRAG_EXP = 0.45;
const MASS_TURN_DIV = 100;
const MASS_TURN_EXP = 0.70;
const ENGINE_TURN_PER_THRUST = 0.001;
const TURN_GENERIC_SCALE = 3.12;
const TURN_SOFTNESS = 0.2;
export const BRAKE_ACCEL_RATIO = 5;
const MOVEMENT_POWER_NO_DEMAND = 1;
const MOVEMENT_POWER_MAX = 1;
const MOVEMENT_POWER_MIN = 0;
// Thrust-to-mass into px/s^2. Set so a light hull reaches cruise in about a
// second and a half and a heavy one in three and a half, measured against the
// hull's own maximum speed: slow enough that mass still reads as mass, quick
// enough that a move order is answered rather than waited out. Braking is a
// fixed multiple of this figure (see BRAKE_ACCEL_RATIO), so stopping distance
// scales with it.
const ACCEL_SCALE = 18.0;
const DEFAULT_LEVER_SETTINGS = Object.freeze({ minimumLever: 0.35, leverPerCell: 0.35, maximumLever: 1.75 });
const MASS_CLASSES = Object.freeze([
  Object.freeze({ name: "Light", minMass: 0, maxMass: 55, turnCap: 3.42 }),
  Object.freeze({ name: "Medium", minMass: 55, maxMass: 125, turnCap: 2.46 }),
  Object.freeze({ name: "Heavy", minMass: 125, maxMass: 230, turnCap: 1.34 }),
  Object.freeze({ name: "Capital", minMass: 230, maxMass: Number.POSITIVE_INFINITY, turnCap: 0.86 })
]);

// Numerical movement authority shared by the Blueprint preview and server
// runtime. Keep player-facing descriptions out of this object; callers can
// format these values without creating a second balance sheet.
export const MOVEMENT_CONFIG = Object.freeze({
  speed: Object.freeze({
    base: BASE_SPEED,
    thrustSqrtScale: THRUST_SPEED_SQRT_SCALE,
    massDivisor: MASS_SPEED_DIV,
    massExponent: MASS_DRAG_EXP,
    accelerationScale: ACCEL_SCALE
  }),
  turn: Object.freeze({
    enginePerThrust: ENGINE_TURN_PER_THRUST,
    genericScale: TURN_GENERIC_SCALE,
    massDivisor: MASS_TURN_DIV,
    massExponent: MASS_TURN_EXP,
    capSoftness: TURN_SOFTNESS
  }),
  power: Object.freeze({
    noDemandMultiplier: MOVEMENT_POWER_NO_DEMAND,
    maximumMultiplier: MOVEMENT_POWER_MAX,
    minimumMultiplier: MOVEMENT_POWER_MIN
  }),
  maneuverThrusterLever: DEFAULT_LEVER_SETTINGS,
  massClasses: MASS_CLASSES
});

export function maneuverThrusterForceX(rotation) { return Number(rotation) === 270 ? -1 : 1; }
export function maneuverThrusterTorqueSign(module, centerOfMass) {
  const localY = Number(module?.y || 0) - Number(centerOfMass?.y || 0);
  const signedTorque = -localY * maneuverThrusterForceX(module?.rotation);
  if (Math.abs(signedTorque) < 1e-9) return 0;
  return signedTorque > 0 ? 1 : -1;
}
export function calculateCenterOfMass(modules = [], parts = {}) {
  let x = 0, y = 0, mass = 0;
  for (const module of modules || []) {
    const part = parts[module.type] || parts.frame || {};
    const mm = Math.max(0, Number(part.mass) || 0);
    x += (Number(module.x) || 0) * mm; y += (Number(module.y) || 0) * mm; mass += mm;
  }
  return { x: mass ? x / mass : 0, y: mass ? y / mass : 0, mass };
}
export function calculateDirectionalTurnInputs(modules = [], parts = {}, options = {}) {
  const centerOfMass = options.centerOfMass || calculateCenterOfMass(modules, parts);
  const leverSettings = { ...DEFAULT_LEVER_SETTINGS, ...(options.leverSettings || {}) };
  const mainEngineValues = [], gyroscopeValues = [], clockwiseThrusterValues = [], anticlockwiseThrusterValues = [], maneuverThrusters = [];
  for (let i = 0; i < (modules || []).length; i += 1) {
    const module = modules[i]; const part = parts[module.type] || parts.frame || {};
    const blocked = options.isBlockedEngine?.(i, module, part) || false;
    const multiplier = clamp(options.componentMultiplier?.(i, module, part) ?? 1, 0, 1);
    if ((part.thrust || 0) > 0 && !blocked && multiplier > 0) mainEngineValues.push((part.thrust || 0) * MOVEMENT_CONFIG.turn.enginePerThrust * multiplier);
    if (module.type === 'gyroscope' && (part.turn || 0) > 0 && multiplier > 0) gyroscopeValues.push((part.turn || 0) * multiplier);
    if (module.type === 'maneuverThruster' && (part.turn || 0) > 0 && !blocked) {
      const localY = (Number(module.y) || 0) - centerOfMass.y;
      const lever = clamp(leverSettings.minimumLever + Math.abs(localY) * leverSettings.leverPerCell, leverSettings.minimumLever, leverSettings.maximumLever);
      const value = (part.turn || 0) * lever * multiplier;
      const sign = maneuverThrusterTorqueSign(module, centerOfMass);
      const record = { index: i, value, lever, sign, localY, rotation: Number(module.rotation) === 270 ? 270 : 90 };
      maneuverThrusters.push(record);
      if (sign > 0) clockwiseThrusterValues.push(value); else if (sign < 0) anticlockwiseThrusterValues.push(value);
    }
  }
  return {
    centerOfMass,
    mainEngineVectorTurn: sumValues(mainEngineValues),
    gyroscopeTurn: sumValues(gyroscopeValues),
    clockwiseManeuverTurn: sumValues(clockwiseThrusterValues),
    anticlockwiseManeuverTurn: sumValues(anticlockwiseThrusterValues),
    maneuverThrusters
  };
}

// A component's generic `turn` field is a passive modifier to the ship's
// symmetric turn calculation. Gyroscopes and Maneuver Thrusters are excluded
// because their `turn` values are resolved above as directional actuators.
// This helper deliberately has no Heat or Power side effects: runtime callers
// may provide a live multiplier to remove dead/derated contributions, while
// actuator activity remains the responsibility of movementCapability.js.
export function calculateGenericTurnModifier(modules = [], parts = {}, options = {}) {
  let total = 0;
  for (let i = 0; i < (modules || []).length; i += 1) {
    const module = modules[i];
    if (module?.type === "gyroscope" || module?.type === "maneuverThruster") continue;
    const part = parts[module?.type] || parts.frame || {};
    if (options.isBlockedEngine?.(i, module, part)) continue;
    const multiplier = clamp(options.componentMultiplier?.(i, module, part) ?? 1, 0, 1);
    total += (Number(part.turn) || 0) * multiplier;
  }
  return total;
}

export function calculateBrakingAcceleration(acceleration) {
  return Math.max(0, Number(acceleration) || 0) * BRAKE_ACCEL_RATIO;
}

export function calculateBrakingDistance(speed, acceleration) {
  return calculateBrakingDistanceFromDeceleration(speed, calculateBrakingAcceleration(acceleration));
}

export function calculateBrakingDistanceFromDeceleration(speed, deceleration) {
  const safeSpeed = Math.max(0, Number(speed) || 0);
  const safeDeceleration = Math.max(0, Number(deceleration) || 0);
  return safeDeceleration > 0 ? (safeSpeed * safeSpeed) / (2 * safeDeceleration) : 0;
}

export function calculateMovementStats({ mass, thrust, turnBonus, powerGeneration, powerUse, engineThrustValues, engineMassValues, turnModuleValues, directionalTurnInputs }) {
  const safeMass = Math.max(mass, 1);
  const powerRatio = calculateMovementPowerMultiplier(powerGeneration, powerUse);
  const powerEfficiency = powerRatio;
  const engines = (engineThrustValues || []).map((value,index)=>({thrust:value,mass:(engineMassValues&&engineMassValues[index])||0}));
  const effectiveThrust = sumValues(engines.map(e=>e.thrust));
  const hasEngineThrust = effectiveThrust > 0;
  const thrustRatio = effectiveThrust / safeMass;
  const massDrag = 1 / Math.pow(1 + safeMass / MOVEMENT_CONFIG.speed.massDivisor, MOVEMENT_CONFIG.speed.massExponent);
  const maxSpeed = hasEngineThrust
    ? Math.max(0, (MOVEMENT_CONFIG.speed.base + Math.sqrt(effectiveThrust) * MOVEMENT_CONFIG.speed.thrustSqrtScale) * massDrag)
    : 0;
  const accel = hasEngineThrust ? (thrustRatio * MOVEMENT_CONFIG.speed.accelerationScale) : 0;
  const directional = directionalTurnInputs || { mainEngineVectorTurn: sumValues(engines.map(e=>e.thrust*MOVEMENT_CONFIG.turn.enginePerThrust)), gyroscopeTurn: sumValues(turnModuleValues || []), clockwiseManeuverTurn:0, anticlockwiseManeuverTurn:0 };
  const mc = massClassForMass(safeMass);
  const hasTurnAuthority = (directional.mainEngineVectorTurn||0)
    + (directional.gyroscopeTurn||0)
    + (directional.clockwiseManeuverTurn||0)
    + (directional.anticlockwiseManeuverTurn||0) > 0;
  const genericTurnModifier = Number(turnBonus) || 0;
  const positiveTurnBonus = Math.max(0, genericTurnModifier);
  const negativeTurnDrag = Math.min(0, genericTurnModifier);
  const symmetricTurn = (directional.mainEngineVectorTurn||0)+(directional.gyroscopeTurn||0)+positiveTurnBonus;
  const massTurnPenalty = 1 / Math.pow(1 + safeMass / MOVEMENT_CONFIG.turn.massDivisor, MOVEMENT_CONFIG.turn.massExponent);
  const turnCap = turnCapForMass(safeMass);
  const toRate = positive => {
    const effectiveTurn = positive + negativeTurnDrag;
    return (hasTurnAuthority && effectiveTurn > 0)
      ? softCap(effectiveTurn * MOVEMENT_CONFIG.turn.genericScale * massTurnPenalty, turnCap, MOVEMENT_CONFIG.turn.capSoftness)
      : 0;
  };
  const turnRateRight = toRate(symmetricTurn + (directional.clockwiseManeuverTurn || 0));
  const turnRateLeft = toRate(symmetricTurn + (directional.anticlockwiseManeuverTurn || 0));
  const turnRate = Math.min(turnRateLeft, turnRateRight);
  return { maxSpeed, accel, brakingAcceleration: calculateBrakingAcceleration(accel), turnRate, turnRateLeft, turnRateRight, thrustRatio, effectiveThrust, engineEfficiency: thrust > 0 ? effectiveThrust / thrust : 0, powerEfficiency, powerDebuff: Math.max(0, 1 - powerRatio), turnCap, massClass: mc, directionalTurn: directional };
}
// Kept as a named compatibility helper for stat/report callers. It reports the
// same universal per-consumer allocation used by movement inputs: linear from
// 0 to 1, with surplus supply capped at 1.
export function calculateSystemEfficiency(powerGeneration,powerUse){ return calculateMovementPowerMultiplier(powerGeneration, powerUse); }
export function calculateMovementPowerMultiplier(powerGeneration,powerUse){ if(powerUse<=0)return MOVEMENT_CONFIG.power.noDemandMultiplier; return clamp(powerGeneration/Math.max(powerUse,1), MOVEMENT_CONFIG.power.minimumMultiplier, MOVEMENT_CONFIG.power.maximumMultiplier); }
export function sumValues(values = []) { return (values || []).reduce((total, value) => total + (Number(value) || 0), 0); }
export function softCap(value,cap,softness=0.35){ return value<=cap?value:cap+(value-cap)*softness; }
export function getMovementClassDefinition(mass){ const value = Math.max(0, Number(mass) || 0); return MOVEMENT_CONFIG.massClasses.find((entry) => value >= entry.minMass && value < entry.maxMass) || MOVEMENT_CONFIG.massClasses[MOVEMENT_CONFIG.massClasses.length - 1]; }
export function formatMassClassRange(definition){ const entry = typeof definition === "string" ? MOVEMENT_CONFIG.massClasses.find((candidate) => candidate.name === definition) : definition; if (!entry) return ""; if (!Number.isFinite(entry.maxMass)) return `${entry.minMass}+ T`; if (entry.minMass === 0) return `< ${entry.maxMass} T`; return `${entry.minMass}-${entry.maxMass - 1} T`; }
export function massClassForMass(mass){ return getMovementClassDefinition(mass).name; }
export function turnCapForMass(mass){ return getMovementClassDefinition(mass).turnCap; }
if (typeof module !== "undefined" && module.exports) { module.exports = { BRAKE_ACCEL_RATIO, MOVEMENT_CONFIG, calculateBrakingAcceleration, calculateBrakingDistance, calculateBrakingDistanceFromDeceleration, calculateMovementStats, calculateSystemEfficiency, calculateMovementPowerMultiplier, calculateGenericTurnModifier, getMovementClassDefinition, formatMassClassRange, sumValues, softCap, massClassForMass, turnCapForMass, calculateCenterOfMass, calculateDirectionalTurnInputs, maneuverThrusterTorqueSign, maneuverThrusterForceX }; }
