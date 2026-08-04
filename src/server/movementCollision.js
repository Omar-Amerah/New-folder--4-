"use strict";

const { clampNumber, compareEntityIds, fastHypot, hashString } = require("./utils");
const { WORLD } = require("./config");
const { bump } = require("./roomTelemetry");
const { areEntityAllies } = require("./relationships");
const {
  ASTEROID_QUERY_PAD,
  STATIC_COLLISION_MAX_TICK_CORRECTION,
  WORLD_MARGIN
} = require("./movementTuning");

let cachedResolveStationCollision = null;

// Station geometry is compound and resolves its own contacts, but the ceiling
// on how far a hull may be translated in one tick is this module's to set. The
// wrapper forwards it: dropping the argument here left every station correction
// running at the default of "no limit", which is exactly the one-frame
// relocation the per-tick budget exists to prevent.
function resolveStationCollision(room, ship, shipRadius, onContact, maxCorrection) {
  if (!cachedResolveStationCollision) {
    cachedResolveStationCollision = require("./stations").resolveStationCollision;
  }
  return cachedResolveStationCollision
    ? cachedResolveStationCollision(room, ship, shipRadius, onContact, maxCorrection)
    : false;
}

function physicalCollisionRadius(ship) {
  return Math.max(18, Number(ship?.physicalRadius) || (Number(ship?.radius) || 0) * 0.56);
}

const NAVIGATION_SAFETY_MARGIN = 8;
const FRIENDLY_CONTACT_SLOP = 16;

function navigationClearanceRadius(ship) {
  return physicalCollisionRadius(ship) + NAVIGATION_SAFETY_MARGIN;
}

function separationRadius(ship) {
  return physicalCollisionRadius(ship);
}

function collisionCounters(room) {
  return room.spawnCollisionDiagnostics || (room.spawnCollisionDiagnostics = {});
}

function collisionBump(room, key, amount = 1) {
  const counters = collisionCounters(room);
  counters[key] = (counters[key] || 0) + amount;
}

function staticCorrectionBudget(ship) {
  const used = Math.max(0, Number(ship._staticCollisionCorrectionDistance) || 0);
  return Math.max(0, STATIC_COLLISION_MAX_TICK_CORRECTION - used);
}

function recordStaticCorrection(ship, dx, dy) {
  ship._collisionCorrectionX = (ship._collisionCorrectionX || 0) + dx;
  ship._collisionCorrectionY = (ship._collisionCorrectionY || 0) + dy;
  ship._staticCollisionCorrectionDistance = (
    Math.max(0, Number(ship._staticCollisionCorrectionDistance) || 0)
    + fastHypot(dx, dy)
  );
}

function normalForCoincidentShip(ship) {
  const angle = ((hashString(String(ship.id)) >>> 0) / 0x100000000) * Math.PI * 2;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

function resolveMapCollision(room, ship) {
  bump(room, "staticCollisionCalls");
  const radius = physicalCollisionRadius(ship);
  const launchControlled = Boolean(ship?.launchPhase);
  const width = room?.world?.width || WORLD.width;
  const height = room?.world?.height || WORLD.height;
  const scratch = room._mapCollisionScratch || (room._mapCollisionScratch = []);
  const asteroids = launchControlled
    ? []
    : (room.spatialIndex?.dynamicValid && room.spatialIndex.queryAabbUnordered
      ? room.spatialIndex.queryAabbUnordered(
        "asteroids",
        ship.x - radius - ASTEROID_QUERY_PAD,
        ship.y - radius - ASTEROID_QUERY_PAD,
        ship.x + radius + ASTEROID_QUERY_PAD,
        ship.y + radius + ASTEROID_QUERY_PAD,
        scratch
      )
      : (room.map?.asteroids || []));
  let hit = false;
  let correctionDistance = 0;

  for (let asteroidIndex = 0; asteroidIndex < asteroids.length; asteroidIndex += 1) {
    const asteroid = asteroids[asteroidIndex];
    if (!asteroid) continue;
    let dx = (ship.x || 0) - (asteroid.x || 0);
    let dy = (ship.y || 0) - (asteroid.y || 0);
    let distance = fastHypot(dx, dy);
    const minimum = (Number(asteroid.radius) || 0) + radius;
    if (distance > minimum + 0.5) continue;
    hit = true;
    let normal;
    if (distance > 0.001) {
      normal = { x: dx / distance, y: dy / distance };
    } else {
      normal = normalForCoincidentShip(ship);
      distance = 1;
    }
    const penetration = Math.max(0, minimum - distance);
    const inwardSpeed = (ship.vx || 0) * normal.x + (ship.vy || 0) * normal.y;
    if (inwardSpeed < 0) {
      ship.vx -= inwardSpeed * normal.x;
      ship.vy -= inwardSpeed * normal.y;
    }
    const amount = Math.min(penetration, staticCorrectionBudget(ship));
    if (amount > 0) {
      const correctionX = normal.x * amount;
      const correctionY = normal.y * amount;
      ship.x += correctionX;
      ship.y += correctionY;
      correctionDistance += amount;
      recordStaticCorrection(ship, correctionX, correctionY);
    }
  }

  if (!launchControlled) {
    const beforeStationX = ship.x;
    const beforeStationY = ship.y;
    // resolveStationCollision keeps its own running total on the ship. Take it
    // back before recording the move here, so the tick's correction is counted
    // once rather than by both sides of the call.
    const beforeCorrectionX = ship._collisionCorrectionX || 0;
    const beforeCorrectionY = ship._collisionCorrectionY || 0;
    const stationHit = resolveStationCollision(
      room,
      ship,
      radius,
      null,
      staticCorrectionBudget(ship)
    );
    ship._collisionCorrectionX = beforeCorrectionX;
    ship._collisionCorrectionY = beforeCorrectionY;
    const stationDx = ship.x - beforeStationX;
    const stationDy = ship.y - beforeStationY;
    if (stationDx || stationDy) {
      const applied = fastHypot(stationDx, stationDy);
      correctionDistance += applied;
      recordStaticCorrection(ship, stationDx, stationDy);
    }
    if (stationHit) hit = true;
  }

  // Station geometry is compound and resolves its own shallow contacts. Clamp
  // the net translation here so an embedded hull is recovered over ticks.
  const edge = WORLD_MARGIN + radius;
  const beforeEdgeX = ship.x;
  const beforeEdgeY = ship.y;
  const clampedX = clampNumber(ship.x, edge, width - edge);
  const clampedY = clampNumber(ship.y, edge, height - edge);
  const edgeDx = clampedX - beforeEdgeX;
  const edgeDy = clampedY - beforeEdgeY;
  if (edgeDx || edgeDy) {
    const normalX = edgeDx > 0 ? 1 : edgeDx < 0 ? -1 : 0;
    const normalY = edgeDy > 0 ? 1 : edgeDy < 0 ? -1 : 0;
    const inwardSpeed = (ship.vx || 0) * normalX + (ship.vy || 0) * normalY;
    if (inwardSpeed < 0) {
      ship.vx -= inwardSpeed * normalX;
      ship.vy -= inwardSpeed * normalY;
    }
    const length = fastHypot(edgeDx, edgeDy);
    const amount = Math.min(length, staticCorrectionBudget(ship));
    if (amount > 0 && length > 0) {
      ship.x = beforeEdgeX + edgeDx * amount / length;
      ship.y = beforeEdgeY + edgeDy * amount / length;
      recordStaticCorrection(ship, edgeDx * amount / length, edgeDy * amount / length);
    }
    hit = true;
  }

  if (hit) {
    ship._staticCollisionLastAt = Number(ship._simNow) || 0;
    bump(room, "staticCollisionHits");
  }
  if (correctionDistance > 0) bump(room, "staticCollisionCorrectionDistance", correctionDistance);
  return hit;
}

function maxFriendlyCorrectionPerTick(ship) {
  return Math.min(8, physicalCollisionRadius(ship) * 0.15);
}

function friendlyShipPair(room, a, b) {
  return areEntityAllies(room, a?.ownerId, b);
}

function massOf(ship) {
  const mass = Number(ship?.stats?.mass);
  return Number.isFinite(mass) && mass > 0 ? mass : 1;
}

function normalForPair(a, b, dx, dy, distance) {
  if (distance > 0.001) return { x: dx / distance, y: dy / distance };
  const broadDistance = fastHypot(dx, dy);
  if (broadDistance > 0.001) return { x: dx / broadDistance, y: dy / broadDistance };
  return compareEntityIds(a, b) <= 0 ? { x: 1, y: 0 } : { x: -1, y: 0 };
}

function removeInwardVelocity(ship, normal, sign) {
  const velocityAlongNormal = (ship.vx || 0) * normal.x + (ship.vy || 0) * normal.y;
  const inward = sign > 0 ? velocityAlongNormal > 0 : velocityAlongNormal < 0;
  if (!inward) return false;
  ship.vx -= velocityAlongNormal * normal.x;
  ship.vy -= velocityAlongNormal * normal.y;
  return true;
}

function rememberFriendlyContactNormal(ship, normalX, normalY) {
  const normals = ship._friendlyContactNormals || (ship._friendlyContactNormals = []);
  normals.push({ x: normalX, y: normalY });
}

function addFriendlyCorrection(room, ship, dx, dy) {
  const used = Math.max(0, Number(ship._friendlyCorrectionDistance) || 0);
  const available = Math.max(0, maxFriendlyCorrectionPerTick(ship) - used);
  const length = fastHypot(dx, dy);
  if (!(length > 0) || !(available > 0)) return 0;
  const amount = Math.min(length, available);
  const width = room?.world?.width || WORLD.width;
  const height = room?.world?.height || WORLD.height;
  const edge = WORLD_MARGIN + physicalCollisionRadius(ship);
  const oldX = ship.x;
  const oldY = ship.y;
  const nextX = clampNumber(ship.x + dx * amount / length, edge, width - edge);
  const nextY = clampNumber(ship.y + dy * amount / length, edge, height - edge);
  ship.x = nextX;
  ship.y = nextY;
  const applied = fastHypot(nextX - oldX, nextY - oldY);
  ship._friendlyCorrectionDistance = used + applied;
  ship._collisionCorrectionX = (ship._collisionCorrectionX || 0) + nextX - oldX;
  ship._collisionCorrectionY = (ship._collisionCorrectionY || 0) + nextY - oldY;
  return applied;
}

function resolveSeparationPair(room, a, b) {
  if (!a || !b || a === b || a.alive === false || b.alive === false) return null;
  if (!friendlyShipPair(room, a, b)) return null;
  if (a.launchPhase && b.launchPhase) return null;
  bump(room, "separationPairsExamined");
  const dx = (b.x || 0) - (a.x || 0);
  const dy = (b.y || 0) - (a.y || 0);
  const distance = fastHypot(dx, dy);
  const minimum = physicalCollisionRadius(a) + physicalCollisionRadius(b);
  if (distance >= minimum) {
    if (distance <= minimum + FRIENDLY_CONTACT_SLOP) {
      const normal = normalForPair(a, b, dx, dy, distance);
      removeInwardVelocity(a, normal, 1);
      removeInwardVelocity(b, normal, -1);
      rememberFriendlyContactNormal(a, normal.x, normal.y);
      rememberFriendlyContactNormal(b, -normal.x, -normal.y);
      const modified = room._shipSeparationModified || (room._shipSeparationModified = new Set());
      modified.add(a.id);
      modified.add(b.id);
    }
    bump(room, "separationBroadPhaseRejected");
    return distance <= minimum + FRIENDLY_CONTACT_SLOP
      ? { penetration: 0, correctionApplied: 0, modified: true }
      : null;
  }
  bump(room, "separationNarrowPhaseChecks");
  const penetration = minimum - distance;
  const normal = normalForPair(a, b, dx, dy, distance);
  const massA = massOf(a);
  const massB = massOf(b);
  const totalMass = massA + massB;
  const desiredA = penetration * massB / totalMass;
  const desiredB = penetration * massA / totalMass;
  const availableA = Math.max(0, maxFriendlyCorrectionPerTick(a) - (Number(a._friendlyCorrectionDistance) || 0));
  const availableB = Math.max(0, maxFriendlyCorrectionPerTick(b) - (Number(b._friendlyCorrectionDistance) || 0));
  // A contact created by an earlier correction may find one endpoint at its
  // complete-tick budget already. Let the other endpoint still move within its
  // own budget; otherwise Pass 2 could observe an overlap and be unable to
  // settle it at all.
  const moveA = Math.min(desiredA, availableA);
  const moveB = Math.min(desiredB, availableB);
  const appliedA = addFriendlyCorrection(room, a, -normal.x * moveA, -normal.y * moveA);
  const appliedB = addFriendlyCorrection(room, b, normal.x * moveB, normal.y * moveB);
  removeInwardVelocity(a, normal, 1);
  removeInwardVelocity(b, normal, -1);
  rememberFriendlyContactNormal(a, normal.x, normal.y);
  rememberFriendlyContactNormal(b, -normal.x, -normal.y);
  const modified = room._shipSeparationModified || (room._shipSeparationModified = new Set());
  modified.add(a.id);
  modified.add(b.id);
  bump(room, "separationOverlapsResolved");
  collisionBump(room, "shipCollisionPairs");
  collisionBump(room, "shipCollisionPenetrationCorrected", penetration);
  return {
    penetration,
    correctionApplied: Math.max(appliedA, appliedB),
    modified: true
  };
}

function liveShips(room, shipList) {
  return (Array.isArray(shipList) ? shipList : [...(room?.ships?.values?.() || [])])
    .filter((ship) => ship && ship.alive !== false && ship.removed !== true)
    .sort(compareEntityIds);
}

function updateShipSeparation(room, shipList, dt, now = 0) {
  const ships = liveShips(room, shipList);
  const modified = room._shipSeparationModified || (room._shipSeparationModified = new Set());
  modified.clear();
  for (const ship of ships) {
    if (!Number.isFinite(Number(ship._friendlyCorrectionDistance))) ship._friendlyCorrectionDistance = 0;
  }

  const contactPairs = require("./movementContactPairs");
  let stepId = room._movementContactPairStepId;
  if (stepId === null || stepId === undefined) stepId = contactPairs.beginMovementContactStep(room, ships, now);
  if (room._movementContactPairBuildStepId !== stepId) {
    contactPairs.buildMovementContactPairs(room, ships, now, { stepId });
  }
  const pairs = contactPairs.getMovementContactPairs(room, stepId).slice()
    .sort((left, right) => (left.orderA - right.orderA) || (left.orderB - right.orderB));
  for (let pass = 0; pass < 2; pass += 1) {
    bump(room, "separationIterations");
    let resolved = 0;
    for (const pair of pairs) {
      const result = resolveSeparationPair(room, pair.a, pair.b);
      if (result) resolved += 1;
    }
    if (!resolved) break;
  }
  return Array.from(modified);
}

function resolveFleetMapCollisions(room, ships = null) {
  let count = 0;
  for (const ship of liveShips(room, ships)) if (resolveMapCollision(room, ship)) count += 1;
  return count;
}

module.exports = {
  maxFriendlyCorrectionPerTick,
  navigationClearanceRadius,
  physicalCollisionRadius,
  resolveFleetMapCollisions,
  resolveMapCollision,
  resolveSeparationPair,
  separationRadius,
  updateShipSeparation
};
