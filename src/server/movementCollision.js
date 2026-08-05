"use strict";

const { clampNumber, compareEntityIds, fastHypot, hashString } = require("./utils");
const { WORLD } = require("./config");
const { bump } = require("./roomTelemetry");
const { findShipHullOverlap } = require("./componentGeometry");
const {
  ASTEROID_QUERY_PAD,
  FRIENDLY_COMPRESSION_SPEED,
  FRIENDLY_PUSH_ABSOLUTE_CAP,
  FRIENDLY_PUSH_ACCELERATION,
  FRIENDLY_PUSH_MASS_FACTOR_MAX,
  FRIENDLY_PUSH_MASS_FACTOR_MIN,
  FRIENDLY_PUSH_SPEED_RATIO,
  FRIENDLY_TRANSFER_RATIO,
  POSITION_CORRECTION_RATIO,
  POSITION_SLOP,
  STATIC_COLLISION_MAX_TICK_CORRECTION,
  WORLD_MARGIN
} = require("./movementTuning");

// The separation pass runs once per authoritative tick with that tick's dt.
// Callers that resolve a single pair directly -- diagnostics and tests -- get a
// nominal tick so the push budget still means something.
const DEFAULT_SEPARATION_DT = 1 / 30;

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

function normalSpeed(ship, normal) {
  return (ship.vx || 0) * normal.x + (ship.vy || 0) * normal.y;
}

// Change only the component along the normal. Whatever the hull was doing
// across the contact is travel, not collision, so a glancing touch slides.
function setNormalSpeed(ship, normal, speed) {
  const delta = speed - normalSpeed(ship, normal);
  ship.vx = (ship.vx || 0) + normal.x * delta;
  ship.vy = (ship.vy || 0) + normal.y * delta;
}

// The most speed a contact may ever give this hull. A ship already travelling
// faster than this under its own power is not slowed to it -- the cap governs
// the speed the contact created, not the ship's own propulsion.
function friendlyPushSpeedCap(ship) {
  const maxSpeed = Number(ship?.stats?.maxSpeed);
  const share = Number.isFinite(maxSpeed) && maxSpeed > 0
    ? maxSpeed * FRIENDLY_PUSH_SPEED_RATIO
    : FRIENDLY_PUSH_ABSOLUTE_CAP;
  return Math.min(FRIENDLY_PUSH_ABSOLUTE_CAP, share);
}

// Velocity a hull may still be given by contact this tick.
//
// The separation pass runs up to twice per tick and a hull in a crowd has
// several contacts in each. Metering the acceleration per contact alone would
// let those multiply, so the budget is per ship per tick -- the same shape as
// the positional correction budget above. It is reset by updateShipMovement.
function remainingPushBudget(ship, dt) {
  const used = Math.max(0, Number(ship._friendlyPushVelocityAdded) || 0);
  return Math.max(0, FRIENDLY_PUSH_ACCELERATION * FRIENDLY_PUSH_MASS_FACTOR_MAX * dt - used);
}

// Contact between two hulls is a shove, not a transfer of momentum.
//
// The ship behind leans on the one in front. The front hull is accelerated, but
// gradually (a per-tick acceleration budget, scaled by the mass ratio) and only
// up to a small fraction of what its own engines could do -- so being touched at
// cruising speed nudges it forward at walking pace instead of launching it. The
// ship behind is slowed to just under the one in front, leaving a sliver of
// closing speed so sustained thrust keeps the shove alive rather than the pair
// latching apart and re-colliding every other tick.
//
// The caps meter speed the contact ADDS. A hull that is itself driving into the
// contact loses that head-on closing speed outright: stopping a ship that ran
// into something is not the launch the caps exist to prevent. So a head-on pair
// both slow heavily and neither bounces.
function resolveFriendlyPush(a, b, normal, immovableA, immovableB, dt) {
  if (immovableA && immovableB) return false;
  const speedA = normalSpeed(a, normal);
  const speedB = normalSpeed(b, normal);

  // Normal points from a toward b. inwardA is how fast a is moving into the
  // contact; inwardB is how fast b is moving into the contact.
  const inwardA = Math.max(0, speedA);
  const inwardB = Math.max(0, -speedB);

  // No closing motion at all.
  if (inwardA <= 0 && inwardB <= 0) return false;

  // Both ships are driving into each other. Remove the closing normal component
  // from each while preserving any component that would carry it outward, so
  // they slow heavily rather than reversing.
  if (inwardA > 0 && inwardB > 0) {
    if (!immovableA) setNormalSpeed(a, normal, speedA - inwardA);
    if (!immovableB) setNormalSpeed(b, normal, speedB + inwardB);

    return true;
  }

  // Exactly one ship is pushing. Choose it from the motion into the contact,
  // not from argument order, and orient the contact frame so the pusher is
  // always the first argument of the one-way logic.
  const aIsPusher = inwardA >= inwardB;
  const pusher = aIsPusher ? a : b;
  const receiver = aIsPusher ? b : a;
  const pusherImmovable = aIsPusher ? immovableA : immovableB;
  const receiverImmovable = aIsPusher ? immovableB : immovableA;
  const pusherNormal = aIsPusher ? normal : { x: -normal.x, y: -normal.y };
  const pusherSpeed = aIsPusher ? speedA : -speedB;
  const receiverSpeed = aIsPusher ? speedB : -speedA;

  // A hull the station is still launching has fixed authority: it is not moved
  // by contact, but whatever runs into it still stops driving through it.
  let nextReceiverSpeed = receiverSpeed;
  if (!receiverImmovable) {
    const base = Math.max(receiverSpeed, 0);
    const closingSpeed = pusherSpeed - receiverSpeed;
    const cap = friendlyPushSpeedCap(receiver);
    const desired = Math.min(
      base + closingSpeed * FRIENDLY_TRANSFER_RATIO,
      Math.max(base, cap)
    );
    const massFactor = clampNumber(
      massOf(pusher) / massOf(receiver),
      FRIENDLY_PUSH_MASS_FACTOR_MIN,
      FRIENDLY_PUSH_MASS_FACTOR_MAX
    );
    const increase = Math.min(
      Math.max(0, desired - base),
      FRIENDLY_PUSH_ACCELERATION * massFactor * Math.max(0, dt),
      remainingPushBudget(receiver, Math.max(0, dt))
    );
    nextReceiverSpeed = base + increase;
    receiver._friendlyPushVelocityAdded = Math.max(0, Number(receiver._friendlyPushVelocityAdded) || 0)
      + increase;
    setNormalSpeed(receiver, pusherNormal, nextReceiverSpeed);
  }

  if (!pusherImmovable) {
    // Slowed to just behind the hull in front so it is no longer driving through
    // it -- but never reversed and never dragged below a standstill by the
    // contact. A shove takes closing speed away; it does not hand any back.
    const floor = Math.min(pusherSpeed, Math.max(nextReceiverSpeed, 0));
    setNormalSpeed(pusher, pusherNormal, Math.max(
      floor,
      Math.min(pusherSpeed, nextReceiverSpeed + FRIENDLY_COMPRESSION_SPEED)
    ));
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
function resolveSeparationPair(room, a, b, dt = DEFAULT_SEPARATION_DT) {
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
  resolveFriendlyPush(a, b, normal, immovableA, immovableB, dt);

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
  const stepDt = Number.isFinite(Number(dt)) && Number(dt) > 0 ? Number(dt) : DEFAULT_SEPARATION_DT;
  for (const ship of ships) {
    if (!Number.isFinite(Number(ship._friendlyCorrectionDistance))) ship._friendlyCorrectionDistance = 0;
    if (!Number.isFinite(Number(ship._friendlyPushVelocityAdded))) ship._friendlyPushVelocityAdded = 0;
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
      const result = resolveSeparationPair(room, pair.a, pair.b, stepDt);
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
