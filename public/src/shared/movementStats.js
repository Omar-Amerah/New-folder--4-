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
const ENGINE_FALLOFF = 0.96;
const BASE_SPEED = 60;
const SPEED_PER_THRUST = 1.05; // legacy, unused
const THRUST_SPEED_SQRT_SCALE = 28.8;
const MASS_SPEED_DIV = 150;
const MASS_DRAG_EXP = 0.45;
const MASS_TURN_DIV = 100;
const MASS_TURN_EXP = 0.70;
const ENGINE_TURN_PER_THRUST = 0.001;
// Thrust-to-mass into px/s^2. Set so a light hull reaches cruise in about a
// second and a half and a heavy one in three and a half, measured against the
// hull's own maximum speed: slow enough that mass still reads as mass, quick
// enough that a move order is answered rather than waited out. Braking is a
// fixed multiple of this figure (see BRAKE_ACCEL_RATIO), so stopping distance
// scales with it.
const ACCEL_SCALE = 18.0;
const SOFT_CAP_MASS_SLOPE = 0.7;
const SOFT_CAP_MIN = 840;
const SOFT_CAP_BASE = 1440;
const SOFT_CAP_EFFICIENCY = 0.25;
const DEFAULT_LEVER_SETTINGS = Object.freeze({ minimumLever: 0.35, leverPerCell: 0.35, maximumLever: 1.75 });
const DEFAULT_HULL_CONTROL = Object.freeze({ Light: { turn: 0.15, lateral: 20, braking: 15 }, Medium: { turn: 0.10, lateral: 15, braking: 12 }, Heavy: { turn: 0.06, lateral: 10, braking: 8 }, Capital: { turn: 0.03, lateral: 5, braking: 5 } });

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
    const mm = (Number(part.mass) || 0) + 0.5;
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
    if ((part.thrust || 0) > 0 && !blocked && multiplier > 0) mainEngineValues.push((part.thrust || 0) * ENGINE_TURN_PER_THRUST * multiplier);
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
    mainEngineVectorTurn: effectiveStackedValue(mainEngineValues, 0.85),
    gyroscopeTurn: effectiveStackedValue(gyroscopeValues, 0.92),
    clockwiseManeuverTurn: effectiveStackedValue(clockwiseThrusterValues, 0.92),
    anticlockwiseManeuverTurn: effectiveStackedValue(anticlockwiseThrusterValues, 0.92),
    maneuverThrusters
  };
}

export function calculateMovementStats({ mass, thrust, turnBonus, powerGeneration, powerUse, engineThrustValues, engineMassValues, turnModuleValues, directionalTurnInputs, movementPowerMultiplier: suppliedPowerMultiplier, hullControlThrust }) {
  const safeMass = Math.max(mass, 1);
  const movementPowerMultiplier = suppliedPowerMultiplier === undefined ? calculateMovementPowerMultiplier(powerGeneration, powerUse) : clamp(suppliedPowerMultiplier, 0, 1.08);
  const powerRatio = powerUse > 0 ? powerGeneration / powerUse : 1.1;
  const powerEfficiency = clamp(powerRatio, 0, 1.1);
  const engines = (engineThrustValues || []).map((value,index)=>({thrust:value,mass:(engineMassValues&&engineMassValues[index])||0})).sort((a,b)=>b.thrust-a.thrust);
  const effectiveThrust = effectiveStackedValue(engines.map(e=>e.thrust), ENGINE_FALLOFF);
  const hasEngineThrust = effectiveThrust > 0;
  const thrustRatio = effectiveThrust / safeMass;
  const massDrag = 1 / Math.pow(1 + safeMass / MASS_SPEED_DIV, MASS_DRAG_EXP);
  const unrestrictedThrustSpeed = hasEngineThrust ? ((BASE_SPEED + Math.sqrt(effectiveThrust) * THRUST_SPEED_SQRT_SCALE) * massDrag * movementPowerMultiplier) : 0;
  const speedCap = Math.max(SOFT_CAP_MIN, SOFT_CAP_BASE - safeMass * SOFT_CAP_MASS_SLOPE);
  const speedCapped = hasEngineThrust && unrestrictedThrustSpeed > speedCap;
  const maxSpeed = hasEngineThrust ? Math.max(0, softCap(unrestrictedThrustSpeed, speedCap, SOFT_CAP_EFFICIENCY)) : 0;
  const accel = hasEngineThrust ? (thrustRatio * ACCEL_SCALE * movementPowerMultiplier) : 0;
  const directional = directionalTurnInputs || { mainEngineVectorTurn: effectiveStackedValue(engines.map(e=>e.thrust*ENGINE_TURN_PER_THRUST),0.85), gyroscopeTurn: effectiveStackedValue(turnModuleValues||[],0.92), clockwiseManeuverTurn:0, anticlockwiseManeuverTurn:0 };
  const mc = massClassForMass(safeMass);
  const hullControlRaw = hullControlThrust || DEFAULT_HULL_CONTROL;
  const hullControl = (hullControlRaw && hullControlRaw[mc]) || DEFAULT_HULL_CONTROL[mc] || { turn: 0 };
  // Hull control is trim assistance for a ship that still has working attitude
  // control -- it is not a free always-on gyroscope. With every gyroscope,
  // maneuver thruster and vectoring engine dead there is nothing left to push
  // against, so the hull turn allowance and the base rate go with them.
  const hasTurnAuthority = (directional.mainEngineVectorTurn||0)
    + (directional.gyroscopeTurn||0)
    + (directional.clockwiseManeuverTurn||0)
    + (directional.anticlockwiseManeuverTurn||0) > 0;
  const hullTurn = hasTurnAuthority ? (Number(hullControl.turn) || 0) : 0;
  const symmetricTurn = (directional.mainEngineVectorTurn||0)+(directional.gyroscopeTurn||0)+hullTurn;
  const negativeTurnDrag = Math.min(0, turnBonus||0);
  const massTurnPenalty = 1 / Math.pow(1 + safeMass / MASS_TURN_DIV, MASS_TURN_EXP);
  const turnCap = turnCapForMass(safeMass);
  const toRate = positive => (hasTurnAuthority && positive > 0) ? softCap(Math.max(0, (0.216 + (positive + negativeTurnDrag) * 3.12) * massTurnPenalty * movementPowerMultiplier), turnCap, 0.2) : 0;
  const turnRateRight = toRate(symmetricTurn + (directional.clockwiseManeuverTurn || 0));
  const turnRateLeft = toRate(symmetricTurn + (directional.anticlockwiseManeuverTurn || 0));
  const turnRate = Math.min(turnRateLeft, turnRateRight);
  return { maxSpeed, accel, turnRate, turnRateLeft, turnRateRight, thrustRatio, effectiveThrust, engineEfficiency: thrust > 0 ? effectiveThrust / thrust : 0, powerEfficiency, powerDebuff: Math.max(0, 1 - movementPowerMultiplier), speedCap, turnCap, massClass: mc, speedCapped, directionalTurn: directional, hullControlTurn: hullTurn };
}
export function calculateSystemEfficiency(powerGeneration,powerUse){ if(powerUse<=0)return 1.08; const ratio=powerGeneration/Math.max(powerUse,1); if(ratio>=1)return clamp(1+Math.min((ratio-1)*0.25,0.12),1,1.12); return clamp(Math.pow(Math.max(ratio,0),1.35),0.25,1); }
export function calculateMovementPowerMultiplier(powerGeneration,powerUse){ if(powerUse<=0)return 1.04; const ratio=powerGeneration/Math.max(powerUse,1); if(ratio>=1)return clamp(Math.sqrt(ratio),1,1.08); return clamp(Math.pow(Math.max(ratio,0),1.8),0.18,1); }
export function effectiveStackedValue(values,falloff){ return [...values].sort((a,b)=>b-a).reduce((t,v,i)=>t+v*Math.pow(falloff,i),0); }
export function softCap(value,cap,softness=0.35){ return value<=cap?value:cap+(value-cap)*softness; }
export function massClassForMass(mass){ if(mass<55)return 'Light'; if(mass<125)return 'Medium'; if(mass<230)return 'Heavy'; return 'Capital'; }
export function speedCapForMass(mass){ return Math.max(SOFT_CAP_MIN, SOFT_CAP_BASE - Number(mass || 0) * SOFT_CAP_MASS_SLOPE); }
export function turnCapForMass(mass){ if(mass<55)return 3.42; if(mass<125)return 2.46; if(mass<230)return 1.34; return 0.86; }
if (typeof module !== "undefined" && module.exports) { module.exports = { calculateMovementStats, calculateSystemEfficiency, calculateMovementPowerMultiplier, effectiveStackedValue, softCap, massClassForMass, speedCapForMass, turnCapForMass, calculateCenterOfMass, calculateDirectionalTurnInputs, maneuverThrusterTorqueSign, maneuverThrusterForceX }; }
