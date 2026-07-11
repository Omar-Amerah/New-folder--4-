// Handles ship velocities, turning, path alignment, separation forces, map collision avoidance, and movement commands.

const { clampNumber, rotateToward, angleDifference } = require("./utils");
const { PARTS } = require("./components");
const { findShipById } = require("./ships");
const { areEnemies, moduleRotationToRadians, moduleLocalPosition } = require("./combat");
const { normalizeRotation } = require("./shipDesign");

const WORLD_MARGIN = 42;
const EDGE_BOUNCE_MARGIN = 43;
const ARRIVE_DISTANCE = 16;

const HOLD_RANGE_RATIO = 0.9;
const CHARGE_RANGE_RATIO = 0.3;
const CIRCLE_RANGE_RATIO = 0.8;

function shipCollisionRadius(ship) {
  return clampNumber((ship.radius || 0) * 0.56, 18, 48);
}

function commandShips(room, player, x, y, options = {}) {
  const shipIdSet = Array.isArray(options.shipIds)
    ? new Set(options.shipIds.map((id) => String(id)).slice(0, 24))
    : null;

  let ships = player.ships.filter((ship) => ship.alive);

  if (shipIdSet && shipIdSet.size > 0) {
    ships = ships.filter((ship) => shipIdSet.has(ship.id));
  }

  if (ships.length === 0) return;

  const target = findShipById(room, options.targetId);
  const focusTargetId = target && target.alive && areEnemies(room, player.id, target.ownerId)
    ? target.id
    : null;

  const formation = options.formation || "line";
  const spacing = clampNumber(62 + ships[0].radius * 0.55, 58, 110);

  ships.forEach((ship, index) => {
    const offset = formationOffset(index, ships.length, spacing, formation);
    const targetPoint = nearestClearPoint(
      room,
      x + offset.x,
      y + offset.y,
      Math.max(42, ship.radius * 0.72)
    );

    ship.targetX = targetPoint.x;
    ship.targetY = targetPoint.y;

    ship.focusTargetId = focusTargetId;
    ship.isManualMove = !focusTargetId;
    ship.arrived = false;

    if (focusTargetId && ship.lastOrbitTargetId !== focusTargetId) {
      ship.orbitDir = undefined;
      ship.lastOrbitTargetId = null;
    }
  });
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
  ensureMoveTarget(ship);

  const stats = ship.stats || {};
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
  return "sentry";
}

function ensureMoveTarget(ship) {
  if (!Number.isFinite(ship.targetX)) ship.targetX = ship.x;
  if (!Number.isFinite(ship.targetY)) ship.targetY = ship.y;
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
  const thrust = (stats.accel || 0) * alignment;

  ship.vx += Math.cos(ship.angle) * thrust * dt;
  ship.vy += Math.sin(ship.angle) * thrust * dt;
}

function getDesiredMoveAngle(room, ship) {
  let desired = Math.atan2(ship.targetY - ship.y, ship.targetX - ship.x);

  const speed = Math.hypot(ship.vx || 0, ship.vy || 0);
  const lookahead = Math.max(120, speed * 0.8 + 60);

  const forwardX = Math.cos(ship.angle);
  const forwardY = Math.sin(ship.angle);

  let closestAsteroid = null;
  let closestDist = Infinity;

  for (const asteroid of room.map?.asteroids || []) {
    const ax = asteroid.x - ship.x;
    const ay = asteroid.y - ship.y;
    const forwardDistance = ax * forwardX + ay * forwardY;

    if (forwardDistance < 0 || forwardDistance > lookahead) continue;

    const lateralDistance = ax * (-forwardY) + ay * forwardX;
    const avoidRadius = asteroid.radius + ship.radius + 32;

    if (Math.abs(lateralDistance) < avoidRadius && forwardDistance < closestDist) {
      closestDist = forwardDistance;
      closestAsteroid = {
        asteroid,
        lateralDistance,
        avoidRadius
      };
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
  if (maxSpeed <= 0) return;

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
    ship.shield = Math.min(ship.maxShield, ship.shield + (stats.shieldRegen || 0) * dt);
  }
}

function updateShipSeparation(room, ships, dt) {
  for (let i = 0; i < ships.length; i += 1) {
    for (let j = i + 1; j < ships.length; j += 1) {
      const a = ships[i];
      const b = ships[j];

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distSq = dx * dx + dy * dy;

      const minimum = shipCollisionRadius(a) + shipCollisionRadius(b);
      if (distSq >= minimum * minimum) continue;

      const distance = Math.sqrt(distSq) || 1;
      const push = (minimum - distance) * 0.5;

      const nx = dx / distance;
      const ny = dy / distance;

      a.x = clampNumber(a.x - nx * push, WORLD_MARGIN, room.world.width - WORLD_MARGIN);
      a.y = clampNumber(a.y - ny * push, WORLD_MARGIN, room.world.height - WORLD_MARGIN);
      b.x = clampNumber(b.x + nx * push, WORLD_MARGIN, room.world.width - WORLD_MARGIN);
      b.y = clampNumber(b.y + ny * push, WORLD_MARGIN, room.world.height - WORLD_MARGIN);

      const impulse = push * dt * 9;

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
  let px = clampNumber(x, WORLD_MARGIN, room.world.width - WORLD_MARGIN);
  let py = clampNumber(y, WORLD_MARGIN, room.world.height - WORLD_MARGIN);

  const asteroids = room.map?.asteroids || [];

  for (let pass = 0; pass < 8; pass += 1) {
    let adjusted = false;

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
    }

    if (!adjusted) break;
  }

  return { x: px, y: py };
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
  updateShipMovement,
  updateShipSeparation,
  resolveFleetMapCollisions,
  resolveMapCollision,
  nearestClearPoint
};
