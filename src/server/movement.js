// Handles ship velocities, turning, path alignment, separation forces, map collision avoidance, and movement commands.

const { clampNumber, rotateToward, angleDifference } = require("./utils");
const { PARTS } = require("./components");
const { findShipById } = require("./ships");
const { areEnemies, areAllies, moduleRotationToRadians, moduleLocalPosition } = require("./combat");
const { normalizeRotation } = require("./shipDesign");
const { addComponentHeat, componentPerformance } = require("./heat");

const WORLD_MARGIN = 42;
const EDGE_BOUNCE_MARGIN = 43;
const ARRIVE_DISTANCE = 16;
const MAX_COMMAND_SHIP_IDS = 64;
const MAX_MOVEMENT_DT = 0.25;
const MOVEMENT_SUBSTEP = 1 / 30;

function heatWeightedMovementFactors(ship) {
  let thrustWeighted = 0, thrustTotal = 0, turnWeighted = 0, turnTotal = 0;
  for (let i = 0; i < (ship.design || []).length; i += 1) {
    const part = PARTS[ship.design[i].type];
    if (!part || (ship.componentHp?.[i] ?? 1) <= 0) continue;
    const perf = componentPerformance(ship, i);
    if ((part.thrust || 0) > 0 && (!ship.validEngineIndices || ship.validEngineIndices.has(i))) {
      thrustWeighted += part.thrust * perf;
      thrustTotal += part.thrust;
    }
    const turn = Math.max(0, part.turn || 0);
    if (turn > 0 && (!part.thrust || !ship.validEngineIndices || ship.validEngineIndices.has(i))) {
      turnWeighted += turn * perf;
      turnTotal += turn;
    }
  }
  const power = ship.thermalPowerFactor ?? 1;
  return {
    thrust: thrustTotal ? thrustWeighted / thrustTotal : 0,
    turn: turnTotal ? turnWeighted / turnTotal : (thrustTotal ? thrustWeighted / thrustTotal : 0),
    power
  };
}

function heatAdjustedMovementStats(ship, stats) {
  const factors = heatWeightedMovementFactors(ship);
  return {
    ...stats,
    accel: (stats.accel || 0) * factors.thrust * factors.power,
    maxSpeed: (stats.maxSpeed || 0) * factors.thrust * factors.power,
    turnRate: (stats.turnRate || 0) * factors.turn * factors.power,
    thrustHeatFactor: factors.thrust,
    turnHeatFactor: factors.turn
  };
}

const HOLD_RANGE_RATIO = 0.9;
const CHARGE_RANGE_RATIO = 0.3;
const CIRCLE_RANGE_RATIO = 0.8;

function shipCollisionRadius(ship) {
  return clampNumber((ship.radius || 0) * 0.56, 18, 48);
}

function commandShips(room, player, x, y, options = {}) {
  const command = normalizeCommandSelection(options.shipIds);
  if (!command.ok) return { ok: false, code: command.code, commanded: 0 };

  let ships = player.ships.filter((ship) => ship.alive);

  // Omitted shipIds preserve the long-standing "all owned live ships" order.
  // An explicitly supplied empty array commands no ships, and malformed arrays
  // never fall back to every ship.
  if (command.explicit) {
    if (command.ids.size === 0) return { ok: true, code: "empty-selection", commanded: 0 };
    ships = ships.filter((ship) => command.ids.has(ship.id));
  }

  ships = ships.slice().sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  if (ships.length === 0) return { ok: true, code: "no-authorized-ships", commanded: 0 };

  const target = findShipById(room, options.targetId);
  const focusTargetId = target && target.alive && areEnemies(room, player.id, target.ownerId)
    ? target.id
    : null;
  // Clicking an allied ship directs repair-beam ships to prioritise it. Any
  // other command clears a previously assigned repair target. Ships without a
  // repair beam never take an allied target.
  const repairTargetId = target && target.alive && !focusTargetId && areAllies(room, player.id, target.ownerId)
    ? target.id
    : null;
  const hasRepairBeam = (ship) => (ship.design || []).some((module) => module.type === "repairBeam");

  const destination = nearestClearPoint(room, x, y, Math.max(42, Math.max(...ships.map((ship) => ship.radius || 0)) * 0.72));
  const plan = planFormation(room, ships, {
    x: destination.x,
    y: destination.y,
    formation: options.formation || "line",
    direction: Number.isFinite(options.direction) ? options.direction : null
  });

  for (const slot of plan.slots) {
    const ship = slot.ship;
    ship.targetX = slot.x;
    ship.targetY = slot.y;
    ship.formationX = slot.offsetX;
    ship.formationY = slot.offsetY;

    ship.focusTargetId = focusTargetId;
    ship.repairTargetId = repairTargetId && hasRepairBeam(ship) ? repairTargetId : null;
    ship.isManualMove = !focusTargetId;
    ship.arrived = false;

    if (focusTargetId && ship.lastOrbitTargetId !== focusTargetId) {
      ship.orbitDir = undefined;
      ship.lastOrbitTargetId = null;
    }
  }
  return { ok: true, code: "commanded", commanded: plan.slots.length, plan };
}

function normalizeCommandSelection(shipIds) {
  if (shipIds === undefined || shipIds === null) return { ok: true, explicit: false, ids: null };
  if (!Array.isArray(shipIds)) return { ok: false, explicit: true, code: "malformed-ship-ids" };
  if (shipIds.length > MAX_COMMAND_SHIP_IDS) return { ok: false, explicit: true, code: "too-many-ship-ids" };
  const ids = new Set();
  for (const raw of shipIds) {
    if (typeof raw !== "string" && typeof raw !== "number") return { ok: false, explicit: true, code: "malformed-ship-id" };
    const id = String(raw).trim();
    if (!id || id.length > 48) return { ok: false, explicit: true, code: "malformed-ship-id" };
    ids.add(id);
  }
  return { ok: true, explicit: true, ids };
}

function planFormation(room, ships, options = {}) {
  const formation = options.formation || "line";
  const orderedShips = ships.slice().sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  const maxRadius = Math.max(0, ...orderedShips.map((ship) => ship.radius || 0));
  const spacing = clampNumber(62 + maxRadius * 0.75, 58, 132);
  const destination = nearestClearPoint(room, options.x, options.y, Math.max(42, maxRadius * 0.72));
  const direction = Number.isFinite(options.direction) ? options.direction : 0;
  const cos = Math.cos(direction);
  const sin = Math.sin(direction);
  const slots = orderedShips.map((ship, index) => {
    const offset = formationOffset(index, orderedShips.length, Math.max(spacing, (ship.radius || 0) * 1.5), formation);
    const worldX = destination.x + offset.x * cos - offset.y * sin;
    const worldY = destination.y + offset.x * sin + offset.y * cos;
    const clearance = Math.max(42, (ship.radius || 0) * 0.72);
    const clear = nearestClearPoint(room, worldX, worldY, clearance);
    return {
      ship,
      shipId: ship.id,
      x: clear.x,
      y: clear.y,
      offsetX: offset.x,
      offsetY: offset.y,
      clearance,
      adjusted: clear.adjusted
    };
  });
  return { x: destination.x, y: destination.y, formation, direction, slots, adjustedDestination: destination.adjusted };
}

function formationOffset(index, count, spacing, formation) {
  const center = index - (count - 1) / 2;

  if (formation === "wedge") {
    const side = index % 2 === 0 ? -1 : 1;
    const rank = Math.ceil(index / 2);
    return {
      x: -rank * spacing * 0.75,
      y: side * rank * spacing * 0.62
    };
  }

  if (formation === "clump") {
    const ring = Math.ceil(Math.sqrt(index + 1));
    const angle = index * 2.399963;
    return {
      x: Math.cos(angle) * ring * spacing * 0.28,
      y: Math.sin(angle) * ring * spacing * 0.28
    };
  }

  return {
    x: center * spacing,
    y: Math.sin(index * 1.7) * spacing * 0.28
  };
}

function updateShipMovement(room, ship, dt) {
  const safeDt = Number(dt);
  if (!Number.isFinite(safeDt) || safeDt <= 0) return;
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
  const target = getActiveCombatTarget(room, ship);

  if (target) {
    updateCombatMoveTarget(room, ship, target, style);
  } else {
    clearOrbitState(ship);
  }

  const dx = ship.targetX - ship.x;
  const dy = ship.targetY - ship.y;
  const distance = Math.hypot(dx, dy);

  if (ship.arrived === undefined) {
    ship.arrived = distance <= ARRIVE_DISTANCE;
  }

  if (ship.isManualMove && !target && distance <= ARRIVE_DISTANCE) {
    ship.isManualMove = false;
    ship.arrived = true;
  }

  const isCircleOrbit = Boolean(target && style === "circle");

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
  return "sentry";
}

function ensureMoveTarget(ship) {
  if (!Number.isFinite(ship.x)) ship.x = 0;
  if (!Number.isFinite(ship.y)) ship.y = 0;
  if (!Number.isFinite(ship.vx)) ship.vx = 0;
  if (!Number.isFinite(ship.vy)) ship.vy = 0;
  if (!Number.isFinite(ship.angle)) ship.angle = 0;
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
  const activeTargetId = ship.focusTargetId || (!ship.isManualMove ? ship.combatTargetId : null);
  if (!activeTargetId) return null;

  const target = room.ships.get(activeTargetId);

  if (!target || !target.alive) {
    if (ship.focusTargetId === activeTargetId) ship.focusTargetId = null;
    if (ship.combatTargetId === activeTargetId) ship.combatTargetId = null;
    clearOrbitState(ship);
    return null;
  }

  return target;
}

function updateCombatMoveTarget(room, ship, target, style) {
  const maxRange = getMaxWeaponRange(ship);
  const distanceToTarget = Math.hypot(target.x - ship.x, target.y - ship.y);

  if (style === "sentry") {
    clearOrbitState(ship);
    ship.targetX = ship.x;
    ship.targetY = ship.y;
    ship.arrived = true;
    return;
  }

  if (maxRange <= 0) {
    clearOrbitState(ship);
    ship.targetX = target.x;
    ship.targetY = target.y;
    ship.arrived = distanceToTarget <= ARRIVE_DISTANCE;
    return;
  }

  if (style === "circle") {
    updateCircleMoveTarget(ship, target, maxRange);
    return;
  }

  clearOrbitState(ship);

  if (style === "hold") {
    const holdRange = maxRange * HOLD_RANGE_RATIO;
    const hysteresis = Math.max(18, ship.radius * 0.35);

    if (distanceToTarget > holdRange + hysteresis) {
      ship.targetX = target.x;
      ship.targetY = target.y;
      ship.arrived = false;
    } else {
      ship.targetX = ship.x;
      ship.targetY = ship.y;
      ship.arrived = true;
    }
    return;
  }

  if (style === "charge") {
    const chargeRange = maxRange * CHARGE_RANGE_RATIO;
    const hysteresis = Math.max(18, ship.radius * 0.35);

    if (distanceToTarget > chargeRange + hysteresis) {
      ship.targetX = target.x;
      ship.targetY = target.y;
      ship.arrived = false;
    } else {
      ship.targetX = ship.x;
      ship.targetY = ship.y;
      ship.arrived = true;
    }
  }
}

function getMaxWeaponRange(ship) {
  const stats = ship.stats || {};

  const rawMaxRange = Math.max(
    stats.blasterRange || 0,
    stats.missileRange || 0,
    stats.railgunRange || 0,
    stats.beamRange || 0
  );

  return rawMaxRange > 0 ? Math.max(120, rawMaxRange) : 0;
}

function updateCircleMoveTarget(ship, target, maxRange) {
  if (ship.lastOrbitTargetId !== target.id) {
    ship.orbitDir = undefined;
    ship.lastOrbitTargetId = target.id;
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
}

function clearOrbitState(ship) {
  ship.orbitDir = undefined;
  ship.lastOrbitTargetId = null;
}

function driveTowardMoveTarget(room, ship, stats, distance, isCircleOrbit, dt) {
  if (distance <= ARRIVE_DISTANCE && !isCircleOrbit) {
    ship.arrived = true;
    return;
  }

  const desired = getDesiredMoveAngle(room, ship);
  ship.angle = rotateToward(ship.angle, desired, (stats.turnRate || 0) * dt);

  const alignment = Math.max(0.12, Math.cos(angleDifference(ship.angle, desired)));
  for (let i = 0; i < (ship.design || []).length; i += 1) {
    const part = PARTS[ship.design[i].type];
    if (!part?.thrust || (ship.componentHp?.[i] ?? 1) <= 0) continue;
    if (ship.validEngineIndices && !ship.validEngineIndices.has(i)) continue;
    if (componentPerformance(ship, i) > 0) addComponentHeat(ship, i, (2 + part.thrust * 0.018) * dt);
  }
  const thrust = (stats.accel || 0) * alignment;

  ship.vx += Math.cos(ship.angle) * thrust * dt;
  ship.vy += Math.sin(ship.angle) * thrust * dt;
}

function getDesiredMoveAngle(room, ship) {
  let desired = Math.atan2(ship.targetY - ship.y, ship.targetX - ship.x);

  const dx = ship.targetX - ship.x;
  const dy = ship.targetY - ship.y;
  const targetDistance = Math.hypot(dx, dy);
  const pathX = targetDistance > 0.001 ? dx / targetDistance : Math.cos(ship.angle);
  const pathY = targetDistance > 0.001 ? dy / targetDistance : Math.sin(ship.angle);

  let closestAsteroid = null;
  let closestDist = Infinity;

  for (const asteroid of room.map?.asteroids || []) {
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

  const speed = Math.hypot(ship.vx || 0, ship.vy || 0);
  const lookahead = Math.max(120, speed * 0.8 + 60);
  const forwardX = Math.cos(ship.angle);
  const forwardY = Math.sin(ship.angle);

  for (const asteroid of room.map?.asteroids || []) {
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
  const len = Math.hypot(dx, dy);
  if (len < 0.001) {
    return { blocked: Math.hypot(cx - x1, cy - y1) < radius, along: 0, lateral: 0 };
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
  return { blocked: Math.hypot(cx - closestX, cy - closestY) < radius, along, lateral };
}

function rotateHullForCombat(room, ship, stats, target, dt) {
  let combatTarget = target;

  if (!combatTarget) {
    const targetId = ship.focusTargetId || ship.combatTargetId;
    combatTarget = targetId ? room.ships.get(targetId) : null;
  }

  if (!combatTarget || !combatTarget.alive) return;

  const desired = findOptimalHullAngle(ship, combatTarget);
  ship.angle = rotateToward(ship.angle, desired, (stats.turnRate || 0) * dt);
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
  if (maxSpeed <= 0) {
    ship.vx = 0;
    ship.vy = 0;
    return;
  }

  const speed = Math.hypot(ship.vx, ship.vy);
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

function regenerateShield(ship, stats, dt) {
  if (ship.maxShield > 0) {
    let recharge = 0;
    for (let i = 0; i < (ship.design || []).length; i += 1) {
      const part = PARTS[ship.design[i].type];
      if (!part?.shieldRegen || (ship.componentHp?.[i] ?? 1) <= 0) continue;
      const local = componentPerformance(ship, i);
      recharge += part.shieldRegen * local;
      if (ship.shield < ship.maxShield && local > 0) addComponentHeat(ship, i, part.shieldRegen * 0.7 * dt);
    }
    ship.shield = Math.min(ship.maxShield, ship.shield + recharge * (ship.thermalPowerFactor ?? 1) * dt);
  }
}

function updateShipSeparation(room, ships, dt) {
  const safeDt = Number.isFinite(Number(dt)) && Number(dt) > 0 ? Math.min(Number(dt), MAX_MOVEMENT_DT) : 0;
  const ordered = ships.filter((ship) => ship.alive).slice().sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const a = ordered[i];
      const b = ordered[j];

      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const distSq = dx * dx + dy * dy;

      const minimum = shipCollisionRadius(a) + shipCollisionRadius(b);
      if (distSq >= minimum * minimum) continue;

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
  }
}

function resolveFleetMapCollisions(room, ships) {
  for (const ship of ships) {
    resolveMapCollision(room, ship);
  }
}

function resolveMapCollision(room, ship) {
  const asteroids = room.map?.asteroids || [];

  for (const asteroid of asteroids) {
    let dx = ship.x - asteroid.x;
    let dy = ship.y - asteroid.y;
    let distance = Math.hypot(dx, dy);

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
      const distance = Math.hypot(dx, dy);
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
    if (Math.hypot(px - asteroid.x, py - asteroid.y) < asteroid.radius + clearance - 0.001) {
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
    for (const module of ship.design || []) {
      const part = PARTS[module.type];
      if (!part?.weapon) continue;

      weapons.push({
        local: moduleLocalPosition(module),
        range: ship.stats[part.weapon.type + "Range"] || part.weapon.range,
        arcRadians: (part.weapon.arc || 360) * Math.PI / 180,
        rotationOffset: moduleRotationToRadians(normalizeRotation(module.rotation))
      });
    }
    ship.hullAngleWeapons = weapons;
  }

  if (weapons.length === 0) {
    return angleToTarget;
  }

  let bestAngle = angleToTarget;
  let bestScore = -Infinity;

  for (let i = 0; i < 24; i += 1) {
    const candidateAngle = (i * Math.PI) / 12 - Math.PI;

    let activeWeapons = 0;
    const cos = Math.cos(candidateAngle);
    const sin = Math.sin(candidateAngle);

    for (const weapon of weapons) {
      const worldX = ship.x + weapon.local.x * cos - weapon.local.y * sin;
      const worldY = ship.y + weapon.local.x * sin + weapon.local.y * cos;

      const dx = target.x - worldX;
      const dy = target.y - worldY;
      const distance = Math.hypot(dx, dy);

      if (distance > weapon.range) continue;

      const targetAngle = Math.atan2(dy, dx);
      const weaponFacing = candidateAngle + weapon.rotationOffset;
      const diff = angleDifference(weaponFacing, targetAngle);

      if (Math.abs(diff) <= weapon.arcRadians / 2) {
        activeWeapons += 1;
      }
    }

    const rotationPenalty = Math.abs(angleDifference(candidateAngle, ship.angle)) * 0.06;
    const facingPenalty = Math.abs(angleDifference(candidateAngle, angleToTarget)) * 0.01;
    const score = activeWeapons - rotationPenalty - facingPenalty;

    if (score > bestScore) {
      bestScore = score;
      bestAngle = candidateAngle;
    }
     }

  return bestAngle;
}

module.exports = {
  commandShips,
  formationOffset,
  planFormation,
  updateShipMovement,
  updateShipSeparation,
  resolveFleetMapCollisions,
  resolveMapCollision,
  nearestClearPoint,
  segmentCircleClearance
};
