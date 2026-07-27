// Handles ship velocities, turning, path alignment, separation forces, map collision avoidance, and movement commands.

const { clampNumber, rotateToward, angleDifference, fastHypot, performanceNow } = require("./utils");
const { PARTS } = require("./components");
const { findShipById } = require("./ships");
const { areEnemies, areAllies, moduleRotationToRadians, moduleLocalPosition, armedProximityChargeRanges, resolveDemolitionContacts, nearestDemolitionTargetPoint, shipHasOperationalDemolitionCharge } = require("./combat");
const { normalizeRotation } = require("./shipDesign");
const { addComponentHeat, componentPerformance } = require("./heat");
const { getCommandAuraMultiplier } = require("./commandAuras");
const { calculateDirectionalTurnInputs, calculateMovementPowerMultiplier, calculateMovementStats, maneuverThrusterTorqueSign } = require("../../public/src/shared/movementStats.js");
const { selectOwnedLivingShips } = require("./selection");
const { getComponentPowerMultiplier, effectiveShieldStats } = require("./componentPower");
const { getEffectiveWeaponStatsInternal, getEffectiveWeaponRanges } = require("./componentData");
const { getShipComponentIndexes } = require("./componentIndexes");

const WORLD_MARGIN = 42;
const EDGE_BOUNCE_MARGIN = 43;
const ARRIVE_DISTANCE = 16;
const MAX_MOVEMENT_DT = 0.25;
const MOVEMENT_SUBSTEP = 1 / 30;


function heatAdjustedMovementStats(ship, stats) {
  const design = ship.design || [];
  const multiplier = (i) => (ship.componentHp?.[i] ?? 1) > 0
    ? componentPerformance(ship, i) * getComponentPowerMultiplier(ship, i) : 0;
  const engineThrustValues = [], engineMassValues = [];
  for (const i of getShipComponentIndexes(ship).thrustIndices) {
    const module = design[i];
    const part = PARTS[module.type] || {};
    const output = multiplier(i);
    if (output > 0 && (!ship.validEngineIndices || ship.validEngineIndices.has(i))) {
      engineThrustValues.push(part.thrust * output);
      engineMassValues.push(part.mass || 0);
    }
  }
  const directionalTurnInputs = calculateDirectionalTurnInputs(design, PARTS, {
    componentMultiplier: multiplier,
    isBlockedEngine: (i, module, part) => (part.thrust > 0 || module.type === "maneuverThruster") && ship.validEngineIndices && !ship.validEngineIndices.has(i)
  });
  const movement = calculateMovementStats({ mass: stats.mass, thrust: stats.thrust, turnBonus: 0,
    powerGeneration: stats.powerGeneration, powerUse: stats.powerUse, engineThrustValues, engineMassValues,
    // Preserve the established surplus-Power bonus, but never reapply a
    // ship-wide deficit after consumers have been scaled individually.
    directionalTurnInputs, movementPowerMultiplier: Math.max(1,
      calculateMovementPowerMultiplier(stats.powerGeneration || 0, stats.powerUse || 0)) });
  const accelMult = getCommandAuraMultiplier(ship, "accelerationMultiplier");
  const turnMult = getCommandAuraMultiplier(ship, "turnRateMultiplier");
  if (Number.isFinite(movement.accel) && Number.isFinite(accelMult) && accelMult !== 1) movement.accel *= accelMult;
  if (Number.isFinite(movement.turnRate) && Number.isFinite(turnMult) && turnMult !== 1) movement.turnRate *= turnMult;
  if (Number.isFinite(movement.turnRateLeft) && Number.isFinite(turnMult) && turnMult !== 1) movement.turnRateLeft *= turnMult;
  if (Number.isFinite(movement.turnRateRight) && Number.isFinite(turnMult) && turnMult !== 1) movement.turnRateRight *= turnMult;
  return { ...stats, ...movement };
}

function directionalTurnRate(stats, current, desired, ship = null) {
  const diff = angleDifference(current, desired);
  if (Math.abs(diff) < 1e-9) return 0;
  const baseRate = diff > 0 ? (stats.turnRateRight ?? stats.turnRate ?? 0) : (stats.turnRateLeft ?? stats.turnRate ?? 0);
  if (ship?.commandState === "backupCore") return baseRate * 0.90;
  return baseRate;
}

function rotateShipToward(ship, desired, stats, dt) {
  const before = ship.angle || 0;
  const rate = directionalTurnRate(stats, before, desired, ship);
  const next = rotateToward(before, desired, rate * dt);
  const applied = Math.abs(angleDifference(before, next));
  ship.angle = next;
  const turnActivity = rate > 0 ? clampNumber((applied / Math.max(rate * dt, 1e-9)) * Math.sign(angleDifference(before, next)), -1, 1) : 0;
  preserveTurnActivity(ship, turnActivity);
  heatActiveManeuverThrusters(ship, turnActivity, dt);
  heatActiveGyroscopes(ship, turnActivity, dt);
}

function preserveTurnActivity(ship, turnActivity) {
  if (!Number.isFinite(turnActivity)) return;
  const activity = clampNumber(turnActivity, -1, 1);
  if (Math.abs(activity) < 0.01) return;
  const current = Number.isFinite(ship.turnActivity) ? clampNumber(ship.turnActivity, -1, 1) : 0;
  if (Math.abs(activity) >= Math.abs(current)) ship.turnActivity = activity;
}

function heatActiveManeuverThrusters(ship, turnActivity, dt) {
  if (!turnActivity || !Number.isFinite(turnActivity)) return;
  const desiredSign = Math.sign(turnActivity);
  const exhaustAnalysis = ship.engineExhaustAnalysis;
  if (!exhaustAnalysis) return;
  const centerOfMass = exhaustAnalysis.centerOfMass;
  for (const i of getShipComponentIndexes(ship).maneuverThrusterIndices) {
    const module = ship.design[i];
    const part = PARTS[module.type];
    if (!part || (ship.componentHp?.[i] ?? 1) <= 0) continue;
    if (!exhaustAnalysis.validEngineIndices.has(i)) continue;
    if (maneuverThrusterTorqueSign(module, centerOfMass) !== desiredSign) continue;
    const perf = componentPerformance(ship, i) * getComponentPowerMultiplier(ship, i);
    if (perf > 0) addComponentHeat(ship, i, (2 + (part.lateralThrust || 0) * 0.018) * Math.abs(turnActivity) * perf * dt);
  }
}

function heatActiveGyroscopes(ship, turnActivity, dt) {
  if (!turnActivity || !Number.isFinite(turnActivity)) return;
  for (const i of getShipComponentIndexes(ship).gyroscopeIndices) {
    const part = PARTS[ship.design[i].type] || {};
    if ((ship.componentHp?.[i] ?? 1) <= 0) continue;
    const activityMultiplier = componentPerformance(ship, i) * getComponentPowerMultiplier(ship, i);
    const rate = activityHeatRate("gyroscope", part);
    if (activityMultiplier > 0 && rate > 0) {
      addComponentHeat(ship, i, rate * Math.abs(turnActivity) * activityMultiplier * dt);
    }
  }
}

// Memoised: this is called per gyroscope and per shield-regen part every tick,
// and re-entering the module cache on each call is pure overhead. Resolved
// lazily to keep the existing import order.
let _heatRules = null;
function heatRules() { return _heatRules || (_heatRules = require("../../public/src/shared/heatRules.js")); }
function activityHeatRate(type, part) {
  return Math.max(0, Number(heatRules().activityHeat(type, part)) || 0);
}

const HOLD_RANGE_RATIO = 0.9;
const CHARGE_RANGE_RATIO = 0.3;
const CIRCLE_RANGE_RATIO = 0.8;

function shipCollisionRadius(ship) {
  return clampNumber((ship.radius || 0) * 0.56, 18, 48);
}

function commandShips(room, player, x, y, options = {}) {
  const command = selectOwnedLivingShips(player, options.shipIds);
  if (!command.ok) return { ok: false, code: command.code, commanded: 0 };

  const ships = command.ships;
  if (command.explicit && command.ids.size === 0) return { ok: true, code: 'empty-selection', commanded: 0 };
  if (ships.length === 0) return { ok: true, code: 'no-authorized-ships', commanded: 0 };

  const target = findShipById(room, options.targetId);
  const isEnemy = target && target.alive && areEnemies(room, player.id, target.ownerId);
  const isAlly = target && target.alive && !isEnemy && areAllies(room, player.id, target.ownerId);
  const hasRepairBeam = (ship) => (ship.design || []).some((module) => module.type === 'repairBeam');

  const center = computeFleetCenter(ships);

  for (const ship of ships) {
    if (isEnemy) {
      ship.focusTargetId = target.id;
      ship.repairTargetId = null;
      ship.commandMode = 'attack';
      ship.isManualMove = false;
      ship.arrived = false;
      if (ship.focusTargetId !== ship.lastOrbitTargetId) {
        ship.orbitDir = undefined;
        ship.lastOrbitTargetId = null;
      }
      continue;
    }

    if (isAlly && hasRepairBeam(ship)) {
      ship.repairTargetId = target.id;
      ship.focusTargetId = null;
      ship.commandMode = 'repair';
      ship.isManualMove = false;
      ship.arrived = false;
      continue;
    }

    const ox = ship.x - center.x;
    const oy = ship.y - center.y;
    let tx = x + ox;
    let ty = y + oy;

    if (Math.hypot(ox, oy) < 0.001 && ships.length > 1) {
      const sorted = ships.slice().sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
      const idx = sorted.indexOf(ship);
      const fallbackRadius = shipCollisionRadius(ship) * 2;
      const turn = (idx % 6) * (Math.PI / 3);
      const ring = 1 + Math.floor(idx / 6);
      tx = x + Math.cos(turn) * fallbackRadius * ring;
      ty = y + Math.sin(turn) * fallbackRadius * ring;
    }

    setGroundMoveTarget(room, ship, tx, ty);
  }

  return { ok: true, code: 'commanded', commanded: ships.length };
}

function computeFleetCenter(ships) {
  let x = 0, y = 0;
  for (const ship of ships) { x += ship.x; y += ship.y; }
  return { x: x / ships.length, y: y / ships.length };
}

function setGroundMoveTarget(room, ship, tx, ty) {
  const clearance = shipCollisionRadius(ship);
  const cleared = nearestClearPoint(room, tx, ty, clearance);
  ship.targetX = cleared.x;
  ship.targetY = cleared.y;
  ship.isManualMove = true;
  ship.commandMode = 'move';
  ship.focusTargetId = null;
  ship.repairTargetId = null;
  ship.arrived = false;
  ship.sentryX = null;
  ship.sentryY = null;
}

function stopShips(room, player, shipIds) {
  const selection = selectOwnedLivingShips(player, shipIds);
  if (!selection.ok) return { ok: false, code: selection.code, stopped: 0 };
  if (selection.explicit && selection.ids.size === 0) return { ok: true, code: 'empty-selection', stopped: 0 };
  const ships = selection.ships;
  if (ships.length === 0) return { ok: true, code: 'no-authorized-ships', stopped: 0 };

  for (const ship of ships) {
    ensureMoveTarget(ship);
    ship.targetX = ship.x;
    ship.targetY = ship.y;
    ship.commandMode = 'stop';
    ship.arrived = true;
    ship.formationPlan = null;
    ship.formationSlotIndex = null;
    clearOrbitState(ship);
  }
  return { ok: true, code: 'stopped', stopped: ships.length };
}

function updateShipMovement(room, ship, dt) {
  const safeDt = Number(dt);
  if (!Number.isFinite(safeDt) || safeDt <= 0) return;
  ship._prevX = ship.x;
  ship._prevY = ship.y;
  ship._prevAngle = ship.angle;
  ship.turnActivity = 0;
  const total = Math.min(safeDt, MAX_MOVEMENT_DT);
  if (total > MOVEMENT_SUBSTEP * 1.01) {
    let remaining = total;
    while (remaining > 0) {
      const step = Math.min(MOVEMENT_SUBSTEP, remaining);
      updateShipMovementStep(room, ship, step);
      remaining -= step;
    }
    sanitizeMovementState(room, ship);
    return;
  }
  updateShipMovementStep(room, ship, total);
  sanitizeMovementState(room, ship);
}

function updateShipMovementStep(room, ship, dt) {
  ensureMoveTarget(ship);

  const stats = heatAdjustedMovementStats(ship, ship.stats || {});
  const style = getCombatStyle(ship);

  if (ship.commandMode === 'repair') {
    updateRepairMoveTarget(room, ship);
  }

  const target = getActiveCombatTarget(room, ship);

  if (target) {
    updateCombatMoveTarget(room, ship, target, style);
  } else {
    clearOrbitState(ship);
  }

  const dx = ship.targetX - ship.x;
  const dy = ship.targetY - ship.y;
  const distance = fastHypot(dx, dy);

  if (ship.arrived === undefined) {
    ship.arrived = distance <= ARRIVE_DISTANCE;
  }

  if (ship.commandMode === 'move' && distance <= ARRIVE_DISTANCE) {
    ship.isManualMove = false;
    ship.arrived = true;
    ship.commandMode = null;
    if (style === 'sentry' && (!Number.isFinite(ship.sentryX) || !Number.isFinite(ship.sentryY))) {
      ship.sentryX = ship.x;
      ship.sentryY = ship.y;
    }
  }

  const isCircleOrbit = Boolean(target && style === 'circle');

  if (!ship.arrived || isCircleOrbit) {
    driveTowardMoveTarget(room, ship, stats, distance, isCircleOrbit, dt);
  } else {
    rotateHullForCombat(room, ship, stats, target, dt);
  }

  applyDamping(ship, distance, isCircleOrbit, dt);
  applySpeedLimit(ship, stats);
  applyPosition(room, ship, dt);
  regenerateShield(ship, stats, dt);
}
function getCombatStyle(ship) {
  if (ship.combatStyle === "hold") return "hold";
  if (ship.combatStyle === "sentry") return "sentry";
  if (ship.combatStyle === "circle") return "circle";
  if (ship.combatStyle === "charge") return "charge";
  return "hold";
}

function ensureMoveTarget(ship) {
  if (!Number.isFinite(ship.x)) ship.x = 0;
  if (!Number.isFinite(ship.y)) ship.y = 0;
  if (!Number.isFinite(ship.vx)) ship.vx = 0;
  if (!Number.isFinite(ship.vy)) ship.vy = 0;
  if (!Number.isFinite(ship.angle)) ship.angle = 0;
  if (ship.commandMode === undefined) ship.commandMode = null;
  if (ship.sentryX === undefined) ship.sentryX = null;
  if (ship.sentryY === undefined) ship.sentryY = null;
  if (ship.isManualMove === undefined) ship.isManualMove = false;
  if (!Number.isFinite(ship.turnActivity)) ship.turnActivity = 0;
  else ship.turnActivity = clampNumber(ship.turnActivity, -1, 1);
  if (!Number.isFinite(ship.targetX)) ship.targetX = ship.x;
  if (!Number.isFinite(ship.targetY)) ship.targetY = ship.y;
}

function sanitizeMovementState(room, ship) {
  ensureMoveTarget(ship);
  ship.x = clampNumber(ship.x, WORLD_MARGIN, room.world.width - WORLD_MARGIN);
  ship.y = clampNumber(ship.y, WORLD_MARGIN, room.world.height - WORLD_MARGIN);
  ship.targetX = clampNumber(ship.targetX, WORLD_MARGIN, room.world.width - WORLD_MARGIN);
  ship.targetY = clampNumber(ship.targetY, WORLD_MARGIN, room.world.height - WORLD_MARGIN);
}

function getActiveCombatTarget(room, ship) {
  if (ship.commandMode === 'stop') return null;
  if (ship.commandMode === 'move' && !ship.arrived) return null;
  if (ship.commandMode === 'repair') return null;
  const activeTargetId = ship.focusTargetId || ship.combatTargetId || null;
  if (!activeTargetId) return null;

  const target = room.ships.get(activeTargetId);

  if (!target || !target.alive) {
    if (ship.focusTargetId === activeTargetId) ship.focusTargetId = null;
    if (ship.combatTargetId === activeTargetId) ship.combatTargetId = null;
    if (ship.commandMode === 'attack') ship.commandMode = null;
    clearOrbitState(ship);
    return null;
  }

  return target;
}

function updateRepairMoveTarget(room, ship) {
  const target = room.ships.get(ship.repairTargetId);
  if (!target || !target.alive) {
    ship.repairTargetId = null;
    ship.commandMode = null;
    return;
  }
  const range = ship.stats && ship.stats.repairRange ? ship.stats.repairRange : 300;
  const dx = ship.x - target.x;
  const dy = ship.y - target.y;
  const dist = fastHypot(dx, dy);
  const approach = Math.max(24, range * 0.85);
  if (dist > approach) {
    ship.targetX = target.x;
    ship.targetY = target.y;
    ship.arrived = false;
  } else {
    ship.targetX = ship.x;
    ship.targetY = ship.y;
    ship.arrived = true;
  }
}
function updateCombatMoveTarget(room, ship, target, style) {
  const maxRange = getMaxWeaponRange(ship);
  const distanceToTarget = fastHypot(target.x - ship.x, target.y - ship.y);

  const chargeInfo = armedProximityChargeRanges(ship);
  if (chargeInfo.armed && style === 'charge') {
    clearOrbitState(ship);
    const nearest = nearestDemolitionTargetPoint(ship, target);
    ship.targetX = nearest.x;
    ship.targetY = nearest.y;
    ship.arrived = false;
    return;
  }

  if (style === 'sentry') {
    clearOrbitState(ship);
    if (!Number.isFinite(ship.sentryX) || !Number.isFinite(ship.sentryY)) {
      ship.sentryX = ship.x;
      ship.sentryY = ship.y;
    }
    ship.targetX = ship.sentryX;
    ship.targetY = ship.sentryY;
    const dist = fastHypot(ship.x - ship.sentryX, ship.y - ship.sentryY);
    ship.arrived = dist <= ARRIVE_DISTANCE;
    return;
  }

  if (maxRange <= 0) {
    clearOrbitState(ship);
    ship.targetX = ship.x;
    ship.targetY = ship.y;
    ship.arrived = true;
    return;
  }

  if (style === 'circle') {
    updateCircleMoveTarget(ship, target, maxRange);
    return;
  }

  clearOrbitState(ship);

  if (style === 'hold') {
    setStandoffTarget(ship, target, maxRange * HOLD_RANGE_RATIO);
    return;
  }

  if (style === 'charge') {
    const chargeRange = maxRange * CHARGE_RANGE_RATIO;
    const hysteresis = Math.max(18, ship.radius * 0.35);
    const dx = ship.x - target.x;
    const dy = ship.y - target.y;
    const dist = fastHypot(dx, dy);
    let dirX = 0, dirY = 0;
    if (dist > 0.001) { dirX = dx / dist; dirY = dy / dist; }
    else { dirX = Math.cos(ship.angle || 0); dirY = Math.sin(ship.angle || 0); }
    const desiredX = target.x + dirX * chargeRange;
    const desiredY = target.y + dirY * chargeRange;
    if (dist > chargeRange + hysteresis) {
      ship.targetX = desiredX;
      ship.targetY = desiredY;
      ship.arrived = false;
    } else {
      ship.targetX = ship.x;
      ship.targetY = ship.y;
      ship.arrived = true;
    }
    return;
  }
}

function setStandoffTarget(ship, target, desiredRange) {
  const dx = ship.x - target.x;
  const dy = ship.y - target.y;
  const dist = fastHypot(dx, dy);
  const hysteresis = Math.max(18, ship.radius * 0.35);
  let dirX = 0, dirY = 0;
  if (dist > 0.001) { dirX = dx / dist; dirY = dy / dist; }
  else { dirX = Math.cos(ship.angle || 0); dirY = Math.sin(ship.angle || 0); }
  const desiredX = target.x + dirX * desiredRange;
  const desiredY = target.y + dirY * desiredRange;
  if (Math.abs(dist - desiredRange) > hysteresis) {
    ship.targetX = desiredX;
    ship.targetY = desiredY;
    ship.arrived = false;
  } else {
    ship.targetX = ship.x;
    ship.targetY = ship.y;
    ship.arrived = true;
  }
}
function getMaxWeaponRange(ship) {
  const ranges = getEffectiveWeaponRanges(ship);
  const rawMaxRange = Math.max(ranges.blaster, ranges.missile, ranges.railgun, ranges.beam);
  return rawMaxRange > 0 ? Math.max(120, rawMaxRange) : 0;
}

function updateCircleMoveTarget(ship, target, maxRange) {
  if (ship.lastOrbitTargetId !== target.id) {
    ship.orbitDir = undefined;
    ship.lastOrbitTargetId = null;
  }

  const orbitRadius = Math.max(80, maxRange * CIRCLE_RANGE_RATIO);
  const angleToShip = Math.atan2(ship.y - target.y, ship.x - target.x);

  if (ship.orbitDir === undefined) {
    const forwardX = Math.cos(ship.angle);
    const forwardY = Math.sin(ship.angle);
    const dx = ship.x - target.x;
    const dy = ship.y - target.y;
    const tangentAlignment = -dy * forwardX + dx * forwardY;
    ship.orbitDir = tangentAlignment >= 0 ? 1 : -1;
  }

  const orbitAngle = angleToShip + 0.42 * ship.orbitDir;
  const targetX = target.x + Math.cos(orbitAngle) * orbitRadius;
  const targetY = target.y + Math.sin(orbitAngle) * orbitRadius;

  if (Number.isFinite(targetX) && Number.isFinite(targetY)) {
    ship.targetX = targetX;
    ship.targetY = targetY;
  }

  ship.arrived = false;
  ship.lastOrbitTargetId = target.id;
}
function clearOrbitState(ship) {
  ship.orbitDir = undefined;
  ship.lastOrbitTargetId = null;
}

function driveTowardMoveTarget(room, ship, stats, distance, isCircleOrbit, dt) {
  if (distance <= ARRIVE_DISTANCE && !isCircleOrbit && !shipHasOperationalDemolitionCharge(ship)) {
    ship.arrived = true;
    return;
  }

  const desired = getDesiredMoveAngle(room, ship);
  rotateShipToward(ship, desired, stats, dt);

  const alignment = Math.max(0.12, Math.cos(angleDifference(ship.angle, desired)));
  for (const i of getShipComponentIndexes(ship).thrustIndices) {
    const part = PARTS[ship.design[i].type];
    if (!part?.thrust || (ship.componentHp?.[i] ?? 1) <= 0) continue;
    if (ship.validEngineIndices && !ship.validEngineIndices.has(i)) continue;
    const activity = componentPerformance(ship, i) * getComponentPowerMultiplier(ship, i);
    if (activity > 0) addComponentHeat(ship, i, (2 + part.thrust * 0.018) * activity * dt);
  }
  const thrust = (stats.accel || 0) * alignment;

  ship.vx += Math.cos(ship.angle) * thrust * dt;
  ship.vy += Math.sin(ship.angle) * thrust * dt;
}

function getDesiredMoveAngle(room, ship) {
  let desired = Math.atan2(ship.targetY - ship.y, ship.targetX - ship.x);

  const dx = ship.targetX - ship.x;
  const dy = ship.targetY - ship.y;
  const targetDistance = fastHypot(dx, dy);
  const pathX = targetDistance > 0.001 ? dx / targetDistance : Math.cos(ship.angle);
  const pathY = targetDistance > 0.001 ? dy / targetDistance : Math.sin(ship.angle);

  let closestAsteroid = null;
  let closestDist = Infinity;

  // Use spatial index for asteroid queries instead of full array scan
  const asteroidCandidates = room.spatialIndex
    ? room.spatialIndex.querySweptAabbUnordered(
        "asteroids",
        ship.x,
        ship.y,
        ship.targetX,
        ship.targetY,
        ship.radius + 38,
        ship._asteroidAvoidanceScratch || (ship._asteroidAvoidanceScratch = [])
      )
    : (room.map?.asteroids || []);

  for (const asteroid of asteroidCandidates) {
    if (!asteroid) continue;
    const avoidRadius = asteroid.radius + ship.radius + 38;
    const hit = segmentCircleClearance(ship.x, ship.y, ship.targetX, ship.targetY, asteroid.x, asteroid.y, avoidRadius);
    if (!hit.blocked || hit.along < 0 || hit.along > targetDistance || hit.along >= closestDist) continue;

    closestDist = hit.along;
    closestAsteroid = { asteroid, lateralDistance: hit.lateral, avoidRadius };
  }

  if (closestAsteroid) {
    const { asteroid, lateralDistance, avoidRadius } = closestAsteroid;
    const steerDir = lateralDistance >= 0 ? -1 : 1;
    const sideX = asteroid.x + (-pathY) * avoidRadius * steerDir;
    const sideY = asteroid.y + pathX * avoidRadius * steerDir;
    return Math.atan2(sideY - ship.y, sideX - ship.x);
  }

  const speed = fastHypot(ship.vx || 0, ship.vy || 0);
  const lookahead = Math.max(120, speed * 0.8 + 60);
  const forwardX = Math.cos(ship.angle);
  const forwardY = Math.sin(ship.angle);

  // Use spatial index for local forward avoidance query instead of full asteroid loop
  const localCandidates = room.spatialIndex
    ? room.spatialIndex.queryRangeUnordered(
        "asteroids",
        ship.x,
        ship.y,
        lookahead + ship.radius + 32,
        ship._asteroidAvoidanceScratch || (ship._asteroidAvoidanceScratch = [])
      )
    : (room.map?.asteroids || []);

  for (const asteroid of localCandidates) {
    if (!asteroid) continue;
    const ax = asteroid.x - ship.x;
    const ay = asteroid.y - ship.y;
    const forwardDistance = ax * forwardX + ay * forwardY;

    if (forwardDistance < 0 || forwardDistance > lookahead) continue;

    const lateralDistance = ax * (-forwardY) + ay * forwardX;
    const avoidRadius = asteroid.radius + ship.radius + 32;

    if (Math.abs(lateralDistance) < avoidRadius && forwardDistance < closestDist) {
      closestDist = forwardDistance;
      closestAsteroid = { asteroid, lateralDistance, avoidRadius };
    }
  }

  if (closestAsteroid) {
    const { asteroid, lateralDistance, avoidRadius } = closestAsteroid;
    const steerDir = lateralDistance >= 0 ? -1 : 1;
    const sideX = asteroid.x + (-forwardY) * avoidRadius * steerDir;
    const sideY = asteroid.y + forwardX * avoidRadius * steerDir;
    desired = Math.atan2(sideY - ship.y, sideX - ship.x);
  }

  return desired;
}

function segmentCircleClearance(x1, y1, x2, y2, cx, cy, radius) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = fastHypot(dx, dy);
  if (len < 0.001) {
    return { blocked: fastHypot(cx - x1, cy - y1) < radius, along: 0, lateral: 0 };
  }
  const ux = dx / len;
  const uy = dy / len;
  const relX = cx - x1;
  const relY = cy - y1;
  const along = relX * ux + relY * uy;
  const clampedAlong = clampNumber(along, 0, len);
  const closestX = x1 + ux * clampedAlong;
  const closestY = y1 + uy * clampedAlong;
  const lateral = relX * (-uy) + relY * ux;
  return { blocked: fastHypot(cx - closestX, cy - closestY) < radius, along, lateral };
}

function rotateHullForCombat(room, ship, stats, target, dt) {
  let combatTarget = target;

  if (!combatTarget) {
    const targetId = ship.focusTargetId || ship.combatTargetId;
    combatTarget = targetId ? room.ships.get(targetId) : null;
  }

  if (!combatTarget || !combatTarget.alive) return;

  const desired = findOptimalHullAngle(ship, combatTarget);
  rotateShipToward(ship, desired, stats, dt);
}

function applyDamping(ship, distance, isCircleOrbit, dt) {
  let damping = 0.985;

  if (ship.arrived && !isCircleOrbit) {
    damping = 0.78;
  } else if (distance < 85 && !isCircleOrbit) {
    damping = 0.9;
  }

  ship.vx *= Math.pow(damping, dt * 60);
  ship.vy *= Math.pow(damping, dt * 60);
}

function applySpeedLimit(ship, stats) {
  const maxSpeed = stats.maxSpeed || 0;
  // A powered speed cap governs active propulsion, not momentum. With no
  // operational engine, damping/collisions/boundaries remain the only brakes.
  if (maxSpeed <= 0) return;

  const speed = fastHypot(ship.vx, ship.vy);
  if (speed <= maxSpeed) return;

  const scale = maxSpeed / speed;
  ship.vx *= scale;
  ship.vy *= scale;
}

function applyPosition(room, ship, dt) {
  ship.x = clampNumber(ship.x + ship.vx * dt, WORLD_MARGIN, room.world.width - WORLD_MARGIN);
  ship.y = clampNumber(ship.y + ship.vy * dt, WORLD_MARGIN, room.world.height - WORLD_MARGIN);

  resolveMapCollision(room, ship);

  if (ship.x <= EDGE_BOUNCE_MARGIN || ship.x >= room.world.width - EDGE_BOUNCE_MARGIN) {
    ship.vx *= -0.35;
  }

  if (ship.y <= EDGE_BOUNCE_MARGIN || ship.y >= room.world.height - EDGE_BOUNCE_MARGIN) {
    ship.vy *= -0.35;
  }
}

const SHIELD_RESTART_DELAY_MS = 3000;

function regenerateShield(ship, stats, dt) {
  const effective = effectiveShieldStats(ship);
  ship.maxShield = Math.max(0, effective.capacity);
  ship.shield = Math.max(0, Math.min(Number(ship.shield) || 0, ship.maxShield));
  if (ship.maxShield > 0) {
    const missingShield = Math.max(0, ship.maxShield - ship.shield);
    const recharge = effective.recharge;
    const heatEntries = [];
    for (const i of getShipComponentIndexes(ship).shieldRegenIndices) {
      const part = PARTS[ship.design[i].type];
      // Only parts the shared heat rules classify as heat-producing (excludes
      // battery/capacitor and any future zero-heat regen part) emit regen heat.
      if (!part?.shieldRegen || activityHeatRate(ship.design[i].type, part) <= 0 || (ship.componentHp?.[i] ?? 1) <= 0) continue;
      const local = componentPerformance(ship, i) * getComponentPowerMultiplier(ship, i);
      const contribution = part.shieldRegen * local;
      if (contribution > 0) heatEntries.push({ index: i, contribution, baseRegen: part.shieldRegen });
    }
    const totalHeatWeight = heatEntries.reduce((sum, entry) => sum + entry.contribution, 0);

    // Shield restart delay: when the shield is fully depleted, regen is paused
    // for a base delay. The command-aura shieldRestartDelayMultiplier (a value
    // below 1) shortens this delay.
    if (ship.shield <= 0 && !ship._shieldRestartAt) {
      const restartMult = getCommandAuraMultiplier(ship, "shieldRestartDelayMultiplier");
      ship._shieldRestartAt = performanceNow() + Math.round(SHIELD_RESTART_DELAY_MS * restartMult);
    }
    if (ship._shieldRestartAt && performanceNow() < ship._shieldRestartAt) {
      return;
    }
    ship._shieldRestartAt = null;

    const actualRecharge = Math.min(missingShield, recharge * dt);
    if (actualRecharge > 0 && totalHeatWeight > 0) {
      for (const entry of heatEntries) {
        const componentActual = actualRecharge * (entry.contribution / totalHeatWeight);
        addComponentHeat(ship, entry.index, componentActual * 0.7);
      }
    }
    ship.shield = Math.min(ship.maxShield, ship.shield + actualRecharge);
  }
}

function resolveSeparationPair(room, a, b, safeDt) {
  if (!a.alive || !b.alive) return;
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  const distSq = dx * dx + dy * dy;

  const minimum = shipCollisionRadius(a) + shipCollisionRadius(b);
  if (distSq >= minimum * minimum) return;

  let distance = Math.sqrt(distSq);
  if (distance < 0.001) {
    const hash = String(a.id).localeCompare(String(b.id), undefined, { numeric: true }) <= 0 ? 1 : -1;
    const angle = hash > 0 ? 0 : Math.PI;
    dx = Math.cos(angle);
    dy = Math.sin(angle);
    distance = 1;
  }
  const push = (minimum - distance) * 0.5;

  const nx = dx / distance;
  const ny = dy / distance;

  a.x = clampNumber(a.x - nx * push, WORLD_MARGIN, room.world.width - WORLD_MARGIN);
  a.y = clampNumber(a.y - ny * push, WORLD_MARGIN, room.world.height - WORLD_MARGIN);
  b.x = clampNumber(b.x + nx * push, WORLD_MARGIN, room.world.width - WORLD_MARGIN);
  b.y = clampNumber(b.y + ny * push, WORLD_MARGIN, room.world.height - WORLD_MARGIN);

  const impulse = push * safeDt * 9;

  a.vx -= nx * impulse;
  a.vy -= ny * impulse;
  b.vx += nx * impulse;
  b.vy += ny * impulse;
}

function updateShipSeparation(room, ships, dt, now = 0) {
  resolveDemolitionContacts(room, ships, now);
  const safeDt = Number.isFinite(Number(dt)) && Number(dt) > 0 ? Math.min(Number(dt), MAX_MOVEMENT_DT) : 0;
  const ordered = ships.filter((ship) => ship.alive).slice().sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  const index = room.spatialIndex;
  const useIndex = index?.dynamicValid && typeof index.queryRangeUnordered === "function";
  const orderedIds = useIndex ? ordered.map((ship) => String(ship.id)) : null;
  const scratch = room._separationScratch || (room._separationScratch = []);
  const maxShipRadius = 48;

  for (let i = 0; i < ordered.length; i += 1) {
    const a = ordered[i];
    if (useIndex) {
      const aId = orderedIds[i];
      const candidates = index.queryRangeUnordered("ships", a.x, a.y, shipCollisionRadius(a) + maxShipRadius, scratch);
      for (const b of candidates) {
        if (!b || !b.alive || b === a) continue;
        const bId = String(b.id);
        if (bId.localeCompare(aId, undefined, { numeric: true }) <= 0) continue;
        resolveSeparationPair(room, a, b, safeDt);
      }
    } else {
      for (let j = i + 1; j < ordered.length; j += 1) {
        resolveSeparationPair(room, a, ordered[j], safeDt);
      }
    }
  }
}

function resolveFleetMapCollisions(room, ships) {
  for (const ship of ships) {
    resolveMapCollision(room, ship);
  }
}

function roomMaxAsteroidRadius(room) {
  const map = room?.map || null;
  const source = map?.asteroids || [];
  const revision = room?.asteroidRevision ?? map?.asteroidRevision ?? map?.revision ?? room?.mapRevision ?? 0;
  const cache = room?._maxAsteroidCache;
  if (cache && cache.source === source && cache.revision === revision) return cache.radius;
  let radius = 0;
  for (const asteroid of source) {
    const r = Number(asteroid?.radius) || 0;
    if (r > radius) radius = r;
  }
  room._maxAsteroidCache = { source, revision, radius };
  return radius;
}

function resolveMapCollision(room, ship) {
  const index = room.spatialIndex;
  let asteroids;
  if (index?.dynamicValid && typeof index.queryRangeUnordered === "function") {
    const maxAsteroidRadius = roomMaxAsteroidRadius(room);
    const searchRadius = maxAsteroidRadius + Math.max(24, ship.radius * 0.62);
    const scratch = ship._mapCollisionScratch || (ship._mapCollisionScratch = []);
    asteroids = index.queryRangeUnordered("asteroids", ship.x, ship.y, searchRadius, scratch);
  } else {
    asteroids = room.map?.asteroids || [];
  }

  for (const asteroid of asteroids) {
    if (!asteroid) continue;
    let dx = ship.x - asteroid.x;
    let dy = ship.y - asteroid.y;
    let distance = fastHypot(dx, dy);

    if (distance < 0.001) {
      dx = Math.cos(ship.angle || 0);
      dy = Math.sin(ship.angle || 0);
      distance = 1;
    }

    const minimum = asteroid.radius + Math.max(24, ship.radius * 0.62);
    if (distance >= minimum) continue;

    const nx = dx / distance;
    const ny = dy / distance;
    const push = minimum - distance;

    ship.x = clampNumber(ship.x + nx * push, WORLD_MARGIN, room.world.width - WORLD_MARGIN);
    ship.y = clampNumber(ship.y + ny * push, WORLD_MARGIN, room.world.height - WORLD_MARGIN);

    const velocityIntoRock = ship.vx * nx + ship.vy * ny;

    if (velocityIntoRock < 0) {
      ship.vx -= velocityIntoRock * nx * 1.25;
      ship.vy -= velocityIntoRock * ny * 1.25;
    }

    ship.vx *= 0.82;
    ship.vy *= 0.82;
  }
}

function nearestClearPoint(room, x, y, clearance) {
  const startX = Number.isFinite(Number(x)) ? Number(x) : room.world.width * 0.5;
  const startY = Number.isFinite(Number(y)) ? Number(y) : room.world.height * 0.5;
  let px = clampNumber(startX, WORLD_MARGIN, room.world.width - WORLD_MARGIN);
  let py = clampNumber(startY, WORLD_MARGIN, room.world.height - WORLD_MARGIN);
  let adjusted = px !== startX || py !== startY;
  let passes = 0;

  const asteroids = room.map?.asteroids || [];

  for (let pass = 0; pass < 8; pass += 1) {
    passes = pass + 1;
    let passAdjusted = false;

    for (const asteroid of asteroids) {
      const dx = px - asteroid.x;
      const dy = py - asteroid.y;
      const distance = fastHypot(dx, dy);
      const minimum = asteroid.radius + clearance;

      if (distance >= minimum) continue;

      const angle = distance > 0.001
        ? Math.atan2(dy, dx)
        : Math.atan2(py - room.world.height * 0.5, px - room.world.width * 0.5);

      px = asteroid.x + Math.cos(angle) * minimum;
      py = asteroid.y + Math.sin(angle) * minimum;

      px = clampNumber(px, WORLD_MARGIN, room.world.width - WORLD_MARGIN);
      py = clampNumber(py, WORLD_MARGIN, room.world.height - WORLD_MARGIN);

      adjusted = true;
      passAdjusted = true;
    }

    if (!passAdjusted) break;
  }

  let clear = true;
  for (const asteroid of asteroids) {
    if (fastHypot(px - asteroid.x, py - asteroid.y) < asteroid.radius + clearance - 0.001) {
      clear = false;
      break;
    }
  }

  return { x: px, y: py, adjusted, passes, clear, reason: clear ? (adjusted ? "adjusted" : "clear") : "blocked" };
}

function findOptimalHullAngle(ship, target) {
  const angleToTarget = Math.atan2(target.y - ship.y, target.x - ship.x);

  // Ship designs are immutable after spawn, so the weapon layout is computed once.
  let weapons = ship.hullAngleWeapons;
  if (!weapons) {
    weapons = [];
    for (let componentIndex = 0; componentIndex < (ship.design || []).length; componentIndex += 1) {
      const module = ship.design[componentIndex];
      const part = PARTS[module.type];
      if (!part?.weapon) continue;

      weapons.push({
        componentIndex,
        local: moduleLocalPosition(module),
        arcRadians: (part.weapon.arc || 360) * Math.PI / 180,
        rotationOffset: moduleRotationToRadians(normalizeRotation(module.rotation))
      });
    }
    ship.hullAngleWeapons = weapons;
  }

  if (weapons.length === 0) {
    return angleToTarget;
  }
  const operationalWeapons = weapons.map((weapon) => ({
    ...weapon,
    range: (ship.componentHp?.[weapon.componentIndex] ?? 1) > 0
      ? Number(getEffectiveWeaponStatsInternal(ship, weapon.componentIndex)?.range) || 0
      : 0
  })).filter((weapon) => weapon.range > 0);
  if (operationalWeapons.length === 0) return angleToTarget;

  let bestAngle = angleToTarget;
  let bestScore = -Infinity;

  for (let i = 0; i < 24; i += 1) {
    const candidateAngle = (i * Math.PI) / 12 - Math.PI;

    let activeWeaponCount = 0;
    const cos = Math.cos(candidateAngle);
    const sin = Math.sin(candidateAngle);

    for (const weapon of operationalWeapons) {
      const worldX = ship.x + weapon.local.x * cos - weapon.local.y * sin;
      const worldY = ship.y + weapon.local.x * sin + weapon.local.y * cos;

      const dx = target.x - worldX;
      const dy = target.y - worldY;
      const distance = fastHypot(dx, dy);

      if (distance > weapon.range) continue;

      const targetAngle = Math.atan2(dy, dx);
      const weaponFacing = candidateAngle + weapon.rotationOffset;
      const diff = angleDifference(weaponFacing, targetAngle);

      if (Math.abs(diff) <= weapon.arcRadians / 2) {
        activeWeaponCount += 1;
      }
    }

    const rotationPenalty = Math.abs(angleDifference(candidateAngle, ship.angle)) * 0.06;
    const facingPenalty = Math.abs(angleDifference(candidateAngle, angleToTarget)) * 0.01;
    const score = activeWeaponCount - rotationPenalty - facingPenalty;

    if (score > bestScore) {
      bestScore = score;
      bestAngle = candidateAngle;
    }
     }

  return bestAngle;
}

module.exports = {
  commandShips,
  stopShips,
  updateShipMovement,
  updateShipSeparation,
  resolveFleetMapCollisions,
  resolveMapCollision,
  nearestClearPoint,
  segmentCircleClearance
};