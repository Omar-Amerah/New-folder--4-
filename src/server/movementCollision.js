"use strict";

const { clampNumber, compareEntityIds, fastHypot, hashString } = require("./utils");
const { WORLD } = require("./config");
const { bump } = require("./roomTelemetry");
const { findShipHullOverlap } = require("./componentGeometry");
const {
  ASTEROID_QUERY_PAD,
  POSITION_CORRECTION_RATIO,
  POSITION_SLOP,
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

// A hull the station is still launching has fixed authority: launch control owns
// its position outright, so it behaves as infinite mass here and takes none of
// the correction. Whatever it is touching -- friendly or hostile -- takes all of
// it. Two launching hulls cannot be in each other's way; their corridors do not
// intersect.
function immovableInContact(ship) {
  return Boolean(ship?.launchPhase);
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

// One impulse for the pair, on their RELATIVE closing speed.
//
// Deleting each ship's own inward velocity is the right answer against an
// asteroid, which really is immovable and really does absorb everything. It is
// the wrong answer for two moving ships: a hull doing 120 that catches one doing
// 80 loses its whole 120 and the fleet's momentum simply disappears. Only the 40
// they are closing at belongs to the collision; the 80 they share is travel.
//
// Restitution is zero, so nothing bounces -- the pair ends up moving together
// along the normal, sharing the momentum they had by mass. Tangential motion is
// untouched, so a glancing contact slides.
function resolvePairVelocity(a, b, normal, immovableA, immovableB) {
  const inverseMassA = immovableA ? 0 : 1 / massOf(a);
  const inverseMassB = immovableB ? 0 : 1 / massOf(b);
  const inverseMassSum = inverseMassA + inverseMassB;
  if (!(inverseMassSum > 0)) return false;

  const relativeX = (b.vx || 0) - (a.vx || 0);
  const relativeY = (b.vy || 0) - (a.vy || 0);
  const closingSpeed = relativeX * normal.x + relativeY * normal.y;
  // Already separating, or travelling together at the same speed. Two ships in
  // formation resting against each other are not a collision and must not be
  // charged for one.
  if (closingSpeed >= 0) return false;

  const impulse = -closingSpeed / inverseMassSum;
  const impulseX = impulse * normal.x;
  const impulseY = impulse * normal.y;
  if (!immovableA) {
    a.vx -= impulseX * inverseMassA;
    a.vy -= impulseY * inverseMassA;
  }
  if (!immovableB) {
    b.vx += impulseX * inverseMassB;
    b.vy += impulseY * inverseMassB;
  }
  return true;
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

// Ships are solid to each other regardless of team. What differs between an
// allied and a hostile contact is nothing at all here: both are pushed apart,
// both keep their tangential motion, and neither takes damage from touching.
// Ramming remains a proximity-charge effect and lives in combat.js.
//
// The bounding circles are the cheap rejection, not the collision. A circle
// drawn around a long hull covers a great deal of empty space, and stopping
// ships on it is what makes them halt with visible daylight between them. Pairs
// that pass it are resolved against the hull cells themselves.
function resolveSeparationPair(room, a, b) {
  if (!a || !b || a === b || a.alive === false || b.alive === false) return null;
  if (immovableInContact(a) && immovableInContact(b)) return null;
  bump(room, "separationPairsExamined");
  const centreDx = (b.x || 0) - (a.x || 0);
  const centreDy = (b.y || 0) - (a.y || 0);
  const bound = physicalCollisionRadius(a) + physicalCollisionRadius(b);
  if (centreDx * centreDx + centreDy * centreDy >= bound * bound) {
    bump(room, "separationBroadPhaseRejected");
    return null;
  }

  bump(room, "separationNarrowPhaseChecks");
  const overlap = findShipHullOverlap(a, b);
  if (!overlap) {
    bump(room, "separationHullPhaseRejected");
    return null;
  }

  const penetration = overlap.penetration;
  const normal = normalForPair(a, b, overlap.dx, overlap.dy, overlap.distance);
  const immovableA = immovableInContact(a);
  const immovableB = immovableInContact(b);
  resolvePairVelocity(a, b, normal, immovableA, immovableB);

  // Positional correction is a separate job from the impulse: it undoes overlap
  // the integrator has already produced. Ignore a sliver of it -- two hulls
  // resting against each other are always a hair inside one another, and
  // correcting that every tick is a permanent low-level shove for no visible
  // benefit -- and resolve the rest over a couple of ticks rather than exactly.
  const correctable = Math.max(0, penetration - POSITION_SLOP) * POSITION_CORRECTION_RATIO;
  let desiredA = 0;
  let desiredB = 0;
  if (immovableA) {
    desiredB = correctable;
  } else if (immovableB) {
    desiredA = correctable;
  } else {
    // By inverse mass, so the lighter hull gives way.
    const massA = massOf(a);
    const massB = massOf(b);
    const totalMass = massA + massB;
    desiredA = correctable * massB / totalMass;
    desiredB = correctable * massA / totalMass;
  }
  const availableA = Math.max(0, maxFriendlyCorrectionPerTick(a) - (Number(a._friendlyCorrectionDistance) || 0));
  const availableB = Math.max(0, maxFriendlyCorrectionPerTick(b) - (Number(b._friendlyCorrectionDistance) || 0));
  // A contact created by an earlier correction may find one endpoint at its
  // complete-tick budget already. Let the other endpoint still move within its
  // own budget; otherwise Pass 2 could observe an overlap and be unable to
  // settle it at all.
  const moveA = immovableA ? 0 : Math.min(desiredA, availableA);
  const moveB = immovableB ? 0 : Math.min(desiredB, availableB);
  const appliedA = moveA > 0 ? addFriendlyCorrection(room, a, -normal.x * moveA, -normal.y * moveA) : 0;
  const appliedB = moveB > 0 ? addFriendlyCorrection(room, b, normal.x * moveB, normal.y * moveB) : 0;
  const modified = room._shipSeparationModified || (room._shipSeparationModified = new Set());
  if (!immovableA) modified.add(a.id);
  if (!immovableB) modified.add(b.id);
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
