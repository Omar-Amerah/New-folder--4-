// Shared movement calculations for frontend component stats and backend ship stats.

function clamp(value, min, max) { return Math.min(max, Math.max(min, Number(value) || 0)); }
const ENGINE_FALLOFF = 0.9;
const BASE_SPEED = 132;
const SPEED_PER_THRUST = 1.05;
const THRUST_SPEED_SQRT_SCALE = 16;
const MASS_SPEED_DIV = 100;
const MASS_DRAG_EXP = 0.5;
const MASS_TURN_DIV = 82;
const MASS_TURN_EXP = 0.85;
const ENGINE_TURN_PER_THRUST = 0.001;
const LATERAL_ACCEL_RATIO = 0.26;
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
  const vectorThrusterTurnValues = [], vectorLateralValues = [], vectorBrakingValues = [], vectorReverseValues = [];
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
    if (module.type === 'vectorThruster' && !blocked && multiplier > 0) {
      if ((part.turn || 0) > 0) vectorThrusterTurnValues.push((part.turn || 0) * multiplier);
      if ((part.lateralThrust || 0) > 0) vectorLateralValues.push((part.lateralThrust || 0) * multiplier);
      if ((part.brakingThrust || 0) > 0) vectorBrakingValues.push((part.brakingThrust || 0) * multiplier);
      if ((part.reverseThrust || 0) > 0) vectorReverseValues.push((part.reverseThrust || 0) * multiplier);
    }
  }
  return {
    centerOfMass,
    mainEngineVectorTurn: effectiveStackedValue(mainEngineValues, 0.85),
    gyroscopeTurn: effectiveStackedValue(gyroscopeValues, 0.92),
    clockwiseManeuverTurn: effectiveStackedValue(clockwiseThrusterValues, 0.92),
    anticlockwiseManeuverTurn: effectiveStackedValue(anticlockwiseThrusterValues, 0.92),
    maneuverThrusters,
    vectorThrusterTurn: effectiveStackedValue(vectorThrusterTurnValues, 0.92),
    vectorLateralThrust: effectiveStackedValue(vectorLateralValues, 0.92),
    vectorBrakingThrust: effectiveStackedValue(vectorBrakingValues, 0.92),
    vectorReverseThrust: effectiveStackedValue(vectorReverseValues, 0.92)
  };
}

function computeDirectionalAccel(thrustTotal, mass, massDrag, powerMultiplier) {
  if (thrustTotal <= 0) return 0;
  const speed = Math.sqrt(thrustTotal) * THRUST_SPEED_SQRT_SCALE * massDrag * powerMultiplier;
  return Math.max(8, speed * LATERAL_ACCEL_RATIO);
}

export function calculateMovementStats({ mass, thrust, turnBonus, powerGeneration, powerUse, engineThrustValues, engineMassValues, turnModuleValues, directionalTurnInputs, movementPowerMultiplier: suppliedPowerMultiplier, hullControlThrust }) {
  const safeMass = Math.max(mass, 1);
  const movementPowerMultiplier = suppliedPowerMultiplier === undefined ? calculateMovementPowerMultiplier(powerGeneration, powerUse) : clamp(suppliedPowerMultiplier, 0, 1.08);
  const powerRatio = powerUse > 0 ? powerGeneration / powerUse : 1.1;
  const powerEfficiency = clamp(powerRatio, 0, 1.1);
  const engines = (engineThrustValues || []).map((value,index)=>({thrust:value,mass:(engineMassValues&&engineMassValues[index])||0})).sort((a,b)=>b.thrust-a.thrust);
  const engineMassTotal = engines.reduce((s,e)=>s+e.mass,0);
  const nonEngineMass = Math.max(1, safeMass-engineMassTotal);
  let effectiveThrust=0, cumulativeThrust=0, runningSpeed=0, runningMass=nonEngineMass;
  for(let i=0;i<engines.length;i++){
    cumulativeThrust += engines[i].thrust*Math.pow(ENGINE_FALLOFF,i);
    runningMass += engines[i].mass;
    const massDrag=1/Math.pow(1+runningMass/MASS_SPEED_DIV,MASS_DRAG_EXP);
    const sqrtThrustComponent = Math.sqrt(Math.max(0, cumulativeThrust)) * THRUST_SPEED_SQRT_SCALE;
    const stepSpeed=(BASE_SPEED+sqrtThrustComponent)*massDrag*movementPowerMultiplier;
    runningSpeed=Math.max(runningSpeed,stepSpeed);
    effectiveThrust=cumulativeThrust;
  }
  const hasEngineThrust=effectiveThrust>0;
  const thrustRatio=effectiveThrust/safeMass;
  const speedCap=speedCapForMass(nonEngineMass)*1.3;
  const speedCapped=hasEngineThrust&&runningSpeed>speedCap;
  const maxSpeed=hasEngineThrust?Math.max(35,softCap(runningSpeed,speedCap,0.35)):0;
  const accel=hasEngineThrust?Math.max(18,maxSpeed*0.26):0;
  const directional = directionalTurnInputs || { mainEngineVectorTurn: effectiveStackedValue(engines.map(e=>e.thrust*ENGINE_TURN_PER_THRUST),0.85), gyroscopeTurn: effectiveStackedValue(turnModuleValues||[],0.92), clockwiseManeuverTurn:0, anticlockwiseManeuverTurn:0, vectorThrusterTurn:0, vectorLateralThrust:0, vectorBrakingThrust:0, vectorReverseThrust:0 };
  const mc = massClassForMass(safeMass);
  const hullControl = hullControlThrust || DEFAULT_HULL_CONTROL[mc] || { turn: 0, lateral: 0, braking: 0 };
  const hullTurn = Number(hullControl.turn) || 0;
  const hullLateral = Number(hullControl.lateral) || 0;
  const hullBraking = Number(hullControl.braking) || 0;
  const symmetricTurn = (directional.mainEngineVectorTurn||0)+(directional.gyroscopeTurn||0)+(directional.vectorThrusterTurn||0)+hullTurn;
  const negativeTurnDrag = Math.min(0, turnBonus||0);
  const massTurnPenalty=1/Math.pow(1+safeMass/MASS_TURN_DIV,MASS_TURN_EXP);
  const turnCap=turnCapForMass(safeMass);
  const toRate = positive => positive>0 ? softCap(Math.max(0,(0.18+(positive+negativeTurnDrag)*2.6)*massTurnPenalty*movementPowerMultiplier),turnCap,0.2) : 0;
  const turnRateRight = toRate(symmetricTurn+(directional.clockwiseManeuverTurn||0));
  const turnRateLeft = toRate(symmetricTurn+(directional.anticlockwiseManeuverTurn||0));
  const turnRate = Math.min(turnRateLeft, turnRateRight);
  const massDrag = 1/Math.pow(1+safeMass/MASS_SPEED_DIV,MASS_DRAG_EXP);
  const lateralThrustTotal = (directional.vectorLateralThrust||0) + hullLateral;
  const brakingThrustTotal = (directional.vectorBrakingThrust||0) + hullBraking;
  const reverseThrustTotal = (directional.vectorReverseThrust||0);
  const lateralAccel = computeDirectionalAccel(lateralThrustTotal, safeMass, massDrag, movementPowerMultiplier);
  const brakingAccel = computeDirectionalAccel(brakingThrustTotal, safeMass, massDrag, movementPowerMultiplier);
  const reverseAccel = computeDirectionalAccel(reverseThrustTotal, safeMass, massDrag, movementPowerMultiplier);
  return { maxSpeed, accel, turnRate, turnRateLeft, turnRateRight, thrustRatio, effectiveThrust, engineEfficiency: thrust>0?effectiveThrust/thrust:0, powerEfficiency, powerDebuff:Math.max(0,1-movementPowerMultiplier), speedCap, turnCap, massClass:mc, speedCapped, directionalTurn: directional, lateralAccel, brakingAccel, reverseAccel, hullControlTurn: hullTurn };
}
export function calculateSystemEfficiency(powerGeneration,powerUse){ if(powerUse<=0)return 1.08; const ratio=powerGeneration/Math.max(powerUse,1); if(ratio>=1)return clamp(1+Math.min((ratio-1)*0.25,0.12),1,1.12); return clamp(Math.pow(Math.max(ratio,0),1.35),0.25,1); }
export function calculateMovementPowerMultiplier(powerGeneration,powerUse){ if(powerUse<=0)return 1.04; const ratio=powerGeneration/Math.max(powerUse,1); if(ratio>=1)return clamp(Math.sqrt(ratio),1,1.08); return clamp(Math.pow(Math.max(ratio,0),1.8),0.18,1); }
export function effectiveStackedValue(values,falloff){ return [...values].sort((a,b)=>b-a).reduce((t,v,i)=>t+v*Math.pow(falloff,i),0); }
export function softCap(value,cap,softness=0.35){ return value<=cap?value:cap+(value-cap)*softness; }
export function massClassForMass(mass){ if(mass<55)return 'Light'; if(mass<125)return 'Medium'; if(mass<230)return 'Heavy'; return 'Capital'; }
export function speedCapForMass(mass){ if(mass<55)return 340; if(mass<125)return 285; if(mass<230)return 215; return 165; }
export function turnCapForMass(mass){ if(mass<55)return 2.85; if(mass<125)return 2.05; if(mass<230)return 1.12; return 0.72; }
if (typeof module !== "undefined" && module.exports) { module.exports = { calculateMovementStats, calculateSystemEfficiency, calculateMovementPowerMultiplier, effectiveStackedValue, softCap, massClassForMass, speedCapForMass, turnCapForMass, calculateCenterOfMass, calculateDirectionalTurnInputs, maneuverThrusterTorqueSign, maneuverThrusterForceX }; }
