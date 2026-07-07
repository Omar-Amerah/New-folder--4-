// Handles ship velocities, turning, path alignment, separation forces, map collision avoidance, and movement commands.

const { clampNumber, rotateToward, angleDifference } = require("./utils");
const { PARTS } = require("./components");
const { findShipById } = require("./ships");
const { areEnemies, moduleRotationToRadians, moduleLocalPosition } = require("./combat");
const { normalizeRotation } = require("./shipDesign");

function commandShips(room, player, x, y, options = {}) {
  const shipIdSet = Array.isArray(options.shipIds)
    ? new Set(options.shipIds.map((id) => String(id)).slice(0, 24))
    : null;
  let ships = player.ships.filter((ship) => ship.alive && !ship.removed);

  if (shipIdSet && shipIdSet.size > 0) {
    ships = ships.filter((ship) => shipIdSet.has(ship.id));
  }

  if (ships.length === 0) return;

  const target = findShipById(room, options.targetId);
  const focusTargetId = target && areEnemies(room, player.id, target.ownerId) ? target.id : null;
  const formation = options.formation || "line";
  const spacing = clampNumber(62 + ships[0].radius * 0.55, 58, 110);

  ships.forEach((ship, index) => {
    const offset = formationOffset(index, ships.length, spacing, formation);
    const targetPoint = nearestClearPoint(room, x + offset.x, y + offset.y, Math.max(42, ship.radius * 0.72));
    ship.targetX = targetPoint.x;
    ship.targetY = targetPoint.y;
    ship.focusTargetId = focusTargetId;
    ship.arrived = false;
  });
}

function formationOffset(index, count, spacing, formation) {
  const center = index - (count - 1) / 2;
  if (formation === "wedge") {
    const side = index % 2 === 0 ? -1 : 1;
    const rank = Math.ceil(index / 2);
    return { x: -rank * spacing * 0.75, y: side * rank * spacing * 0.62 };
  }
  if (formation === "clump") {
    const ring = Math.ceil(Math.sqrt(index + 1));
    const angle = index * 2.399963;
    return { x: Math.cos(angle) * ring * spacing * 0.28, y: Math.sin(angle) * ring * spacing * 0.28 };
  }
  return { x: center * spacing, y: Math.sin(index * 1.7) * spacing * 0.28 };
}

function updateShipMovement(room, ship, dt) {
  const stats = ship.stats;

  // Chase and stop at weapon range if focused on an enemy target
  if (ship.focusTargetId) {
    const focusTarget = room.ships.get(ship.focusTargetId);
    if (focusTarget && focusTarget.alive && !focusTarget.removed) {
      // Keep destination target coordinates updated to focus target position
      ship.targetX = focusTarget.x;
      ship.targetY = focusTarget.y;

      const distToTarget = Math.hypot(focusTarget.x - ship.x, focusTarget.y - ship.y);
      const maxRange = Math.max(stats.blasterRange || 0, stats.missileRange || 0, stats.railgunRange || 0, stats.beamRange || 0);

      if (maxRange > 0) {
        if (distToTarget <= maxRange * 0.88) {
          ship.arrived = true;
        } else if (distToTarget > maxRange * 0.95) {
          ship.arrived = false;
        }
      }
    } else {
      ship.focusTargetId = null;
    }
  }

  const dx = ship.targetX - ship.x;
  const dy = ship.targetY - ship.y;
  const distance = Math.hypot(dx, dy);

  if (ship.arrived === undefined) {
    ship.arrived = distance <= 16;
  }

  if (!ship.arrived) {
    if (distance > 16) {
      const desired = Math.atan2(dy, dx);
      ship.angle = rotateToward(ship.angle, desired, stats.turnRate * dt);

      const alignment = Math.max(0.12, Math.cos(angleDifference(ship.angle, desired)));
      const thrust = stats.accel * alignment;
      ship.vx += Math.cos(ship.angle) * thrust * dt;
      ship.vy += Math.sin(ship.angle) * thrust * dt;
    } else {
      ship.arrived = true;
    }
  } else {
    const targetId = ship.combatTargetId || ship.focusTargetId;
    const target = targetId ? room.ships.get(targetId) : null;
    if (target && target.alive && !target.removed) {
      const desired = findOptimalHullAngle(ship, target);
      ship.angle = rotateToward(ship.angle, desired, stats.turnRate * dt);
    }
  }

  const damping = ship.arrived ? 0.8 : (distance < 85 ? 0.9 : 0.985);
  ship.vx *= Math.pow(damping, dt * 60);
  ship.vy *= Math.pow(damping, dt * 60);

  const speed = Math.hypot(ship.vx, ship.vy);
  if (speed > stats.maxSpeed) {
    const scale = stats.maxSpeed / speed;
    ship.vx *= scale;
    ship.vy *= scale;
  }

  ship.x = clampNumber(ship.x + ship.vx * dt, 42, room.world.width - 42);
  ship.y = clampNumber(ship.y + ship.vy * dt, 42, room.world.height - 42);
  resolveMapCollision(room, ship);

  if (ship.x <= 43 || ship.x >= room.world.width - 43) ship.vx *= -0.35;
  if (ship.y <= 43 || ship.y >= room.world.height - 43) ship.vy *= -0.35;

  if (ship.maxShield > 0) {
    ship.shield = Math.min(ship.maxShield, ship.shield + stats.shieldRegen * dt);
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
      const minimum = (a.radius + b.radius) * 0.72;
      if (distSq >= minimum * minimum) continue;
      const distance = Math.sqrt(distSq) || 1;

      const push = (minimum - distance) * 0.5;
      const nx = dx / distance;
      const ny = dy / distance;
      a.x = clampNumber(a.x - nx * push, 42, room.world.width - 42);
      a.y = clampNumber(a.y - ny * push, 42, room.world.height - 42);
      b.x = clampNumber(b.x + nx * push, 42, room.world.width - 42);
      b.y = clampNumber(b.y + ny * push, 42, room.world.height - 42);

      const impulse = push * dt * 9;
      a.vx -= nx * impulse;
      a.vy -= ny * impulse;
      b.vx += nx * impulse;
      b.vy += ny * impulse;
    }
  }
}

function resolveFleetMapCollisions(room, ships) {
  for (const ship of ships) resolveMapCollision(room, ship);
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
    ship.x = clampNumber(ship.x + nx * push, 42, room.world.width - 42);
    ship.y = clampNumber(ship.y + ny * push, 42, room.world.height - 42);

    const towardRock = ship.vx * nx + ship.vy * ny;
    if (towardRock < 0) {
      ship.vx -= towardRock * nx * 1.25;
      ship.vy -= towardRock * ny * 1.25;
    }
    ship.vx *= 0.82;
    ship.vy *= 0.82;
  }
}

function nearestClearPoint(room, x, y, clearance) {
  let px = clampNumber(x, 42, room.world.width - 42);
  let py = clampNumber(y, 42, room.world.height - 42);
  const asteroids = room.map?.asteroids || [];

  for (let pass = 0; pass < 8; pass += 1) {
    let adjusted = false;
    for (const asteroid of asteroids) {
      const dx = px - asteroid.x;
      const dy = py - asteroid.y;
      const distance = Math.hypot(dx, dy);
      const minimum = asteroid.radius + clearance;
      if (distance >= minimum) continue;

      const angle = distance > 0.001 ? Math.atan2(dy, dx) : Math.atan2(py - room.world.height * 0.5, px - room.world.width * 0.5);
      px = asteroid.x + Math.cos(angle) * minimum;
      py = asteroid.y + Math.sin(angle) * minimum;
      px = clampNumber(px, 42, room.world.width - 42);
      py = clampNumber(py, 42, room.world.height - 42);
      adjusted = true;
    }
    if (!adjusted) break;
  }

  return { x: px, y: py };
}


function findOptimalHullAngle(ship, target) {
  const angleToTarget = Math.atan2(target.y - ship.y, target.x - ship.x);
  const design = ship.design || [];
  
  // Pre-calculate weapon properties to avoid redundant lookups in the loop
  const weapons = [];
  for (const module of design) {
    const part = PARTS[module.type];
    if (part?.weapon) {
      weapons.push({
        local: moduleLocalPosition(module),
        range: ship.stats[part.weapon.type + "Range"] || part.weapon.range,
        arcRadians: (part.weapon.arc || 360) * Math.PI / 180,
        rotationOffset: moduleRotationToRadians(normalizeRotation(module.rotation))
      });
    }
  }

  // If no weapons, just point directly at target
  if (weapons.length === 0) return angleToTarget;

  let bestAngle = angleToTarget;
  let bestScore = -Infinity;

  // Sample 24 angles around the circle to find the one maximizing active weapons
  for (let i = 0; i < 24; i += 1) {
    const phi = (i * Math.PI) / 12 - Math.PI;
    let activeWeaponsCount = 0;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);

    for (const weapon of weapons) {
      const worldX = ship.x + weapon.local.x * cos - weapon.local.y * sin;
      const worldY = ship.y + weapon.local.x * sin + weapon.local.y * cos;

      const dx = target.x - worldX;
      const dy = target.y - worldY;
      const distance = Math.hypot(dx, dy);

      if (distance <= weapon.range) {
        const targetAngle = Math.atan2(dy, dx);
        const defaultFacing = phi + weapon.rotationOffset;

        const diff = angleDifference(defaultFacing, targetAngle);
        if (Math.abs(diff) <= weapon.arcRadians / 2) {
          activeWeaponsCount += 1;
        }
      }
    }

    // Score: prioritize weapon coverage, then minimize rotation, then face target
    const currentDiff = Math.abs(angleDifference(phi, ship.angle));
    const targetDiff = Math.abs(angleDifference(phi, angleToTarget));
    const score = activeWeaponsCount - currentDiff * 0.06 - targetDiff * 0.01;

    if (score > bestScore) {
      bestScore = score;
      bestAngle = phi;
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
