"use strict";

const { clampNumber, fastHypot, hashString, compareNaturalIds } = require("./utils");
const { WORLD } = require("./config");
const { bump, recordDuration } = require("./roomTelemetry");
const { findShipHullOverlap } = require("./componentGeometry");
const {
  ASTEROID_QUERY_PAD,
  PACKED_FLEET_MAX_TICK_CORRECTION,
  SEPARATION_CORRECTION,
  SEPARATION_ITERATIONS,
  SEPARATION_SLOP,
  STATIC_COLLISION_MAX_TICK_CORRECTION,
  STOPPED_SPEED,
  WORLD_MARGIN
} = require("./movementTuning");
const { bumpMovementMetric } = require("./movementMetrics");
const { areEntityAllies } = require("./relationships");
const {
  trafficIsPositioned,
  trafficPriorityWinner,
  trafficPairKey
} = require("./movementTrafficPriority");

let cachedResolveStationCollision = null;
function resolveStationCollision(room, ship, shipRadius, onContact = null) {
  if (!cachedResolveStationCollision) cachedResolveStationCollision = require("./stations").resolveStationCollision;
  if (!cachedResolveStationCollision) return false;
  return cachedResolveStationCollision(room, ship, shipRadius, onContact);
}

const STATIC_SLIDE_CONTACT_MS = 500;
const STATIC_SLIDE_REPLAN_MS = 450;
const STATIC_SLIDE_BLOCK_MS = 1800;
const STATIC_SLIDE_PROGRESS_EPSILON = 8;
const STATIC_CONTACT_EPSILON = 0.5;

function recordStaticSlideContact(ship, contact) {
  const runtime = ship?.movement;
  if (!runtime || typeof runtime !== "object" || !contact) return;
  const nowValue = Number(ship._simNow);
  const now = Number.isFinite(nowValue) ? nowValue : 0;
  const obstacleId = String(contact.obstacleId);
  const previous = runtime.slide;
  const previousAt = Number(previous?.lastContactAt);
  const continuous = previous
    && previous.obstacleId === obstacleId
    && (!Number.isFinite(previousAt) || now - previousAt <= STATIC_SLIDE_CONTACT_MS);
  const startedAt = continuous && Number.isFinite(Number(previous.startedAt))
    ? Number(previous.startedAt)
    : now;
  const previousProgressX = continuous && Number.isFinite(Number(previous.lastProgressX))
    ? Number(previous.lastProgressX)
    : Number(ship.x) || 0;
  const previousProgressY = continuous && Number.isFinite(Number(previous.lastProgressY))
    ? Number(previous.lastProgressY)
    : Number(ship.y) || 0;
  const tangentX = -(Number(contact.normalY) || 0);
  const tangentY = Number(contact.normalX) || 0;
  const tangentLength = fastHypot(tangentX, tangentY);
  const movementAlongSurface = tangentLength > 0.001
    ? Math.abs((Number(ship.x) - previousProgressX) * tangentX / tangentLength
      + (Number(ship.y) - previousProgressY) * tangentY / tangentLength)
    : 0;
  const progressed = movementAlongSurface >= STATIC_SLIDE_PROGRESS_EPSILON;
  const lastProgressAt = progressed
    ? now
    : (continuous && Number.isFinite(Number(previous.lastProgressAt))
      ? Number(previous.lastProgressAt)
      : now);
  runtime.slide = {
    obstacleId,
    normalX: Number(contact.normalX) || 0,
    normalY: Number(contact.normalY) || 0,
    side: continuous && (previous.side === -1 || previous.side === 1) ? previous.side : 0,
    startedAt,
    expiresAt: now + STATIC_SLIDE_CONTACT_MS,
    replanAt: continuous && Number.isFinite(Number(previous.replanAt))
      ? Number(previous.replanAt)
      : startedAt + STATIC_SLIDE_REPLAN_MS,
    blockedAt: lastProgressAt + STATIC_SLIDE_BLOCK_MS,
    blocked: continuous && Boolean(previous.blocked),
    lastContactAt: now,
    lastProgressX: progressed ? Number(ship.x) || 0 : previousProgressX,
    lastProgressY: progressed ? Number(ship.y) || 0 : previousProgressY,
    lastProgressAt,
    replanCount: continuous ? (Number(previous.replanCount) || 0) : 0
  };
}

function physicalCollisionRadius(ship) {
  return Math.max(18, Number(ship?.physicalRadius) || (Number(ship?.radius) || 0) * 0.56);
}

const NAVIGATION_SAFETY_MARGIN = 8;

function navigationClearanceRadius(ship) {
  const physical = physicalCollisionRadius(ship);
  return physical + NAVIGATION_SAFETY_MARGIN;
}

function separationRadius(ship) {
  return physicalCollisionRadius(ship) + 4;
}

function collisionCounters(room) {
  return room.spawnCollisionDiagnostics || (room.spawnCollisionDiagnostics = {});
}

function collisionBump(room, key, amount = 1) {
  const counters = collisionCounters(room);
  counters[key] = (counters[key] || 0) + amount;
}

function shipIsStopped(ship) {
  const phase = ship.movement?.phase;
  return fastHypot(ship.vx || 0, ship.vy || 0) < STOPPED_SPEED
    && (!ship.movement?.command
      || ship.movement.command.type === "stop"
      || phase === "positioned"
      || phase === "blocked"
      || phase === "idle");
}

const COLLISION_CONTACT_CONTINUITY_MS = 250;

function recordShipContact(room, a, b, tick) {
  const contacts = room._shipCollisionContacts || (room._shipCollisionContacts = new Map());
  const key = trafficPairKey(a, b);
  const previous = contacts.get(key);
  const at = Number.isFinite(Number(tick)) ? Number(tick) : 0;
  const previousAt = Number(previous?.at);
  const continuous = previous
    && Number.isFinite(previousAt)
    && at - previousAt <= COLLISION_CONTACT_CONTINUITY_MS;
  const startedAt = continuous && Number.isFinite(Number(previous.startedAt))
    ? Number(previous.startedAt)
    : at;
  const contact = {
    at,
    startedAt,
    duration: Math.max(0, at - startedAt),
    consecutive: continuous ? (Number(previous.consecutive) || 0) + 1 : 1
  };
  contacts.set(key, contact);
  return contact;
}

function friendlyShipPair(room, a, b) {
  return areEntityAllies(room, a?.ownerId, b);
}

function friendlyChargePair(a, b) {
  const isCharge = (ship) => {
    const style = ship?.combatStyleRaw || ship?.combatStyle;
    return ship?.movement?.command?.type === "attack"
      && String(style || "").toLowerCase() === "charge";
  };
  return isCharge(a) && isCharge(b);
}

function holdApproachShip(ship) {
  const style = ship?.combatStyleRaw || ship?.combatStyle;
  return ship?.movement?.command?.type === "attack"
    && String(style || "").toLowerCase() === "hold"
    && Boolean(ship?.movement?.holdApproach);
}

function friendlyHoldApproachPair(a, b) {
  // Charge keeps its established contact behavior. Hold approach traffic gets
  // the hard circular separation path so a blocked fan member cannot enter the
  // timed soft-overlap release.
  return !friendlyChargePair(a, b) && (holdApproachShip(a) || holdApproachShip(b));
}

function friendlyTrafficSoftContact(room, a, b, now) {
  const stateFor = (ship, other) => {
    const traffic = ship?.movement?.traffic;
    return traffic?.mode === "soft"
      && traffic.blockerId !== null
      && traffic.blockerId !== undefined
      && String(traffic.blockerId) === String(other?.id);
  };
  if (stateFor(a, b) || stateFor(b, a)) return true;
  const remembered = room?._trafficBlockedPairs?.get?.(trafficPairKey(a, b));
  const blockedAt = Number(remembered?.blockedAt);
  const lastAt = Number(remembered?.lastAt);
  const tick = Number(now);
  return Number.isFinite(blockedAt)
    && Number.isFinite(lastAt)
    && Number.isFinite(tick)
    && tick - blockedAt >= 1500
    && tick - lastAt <= 4000;
}

// Remove only the yielding hull's component toward the right-of-way winner.
// Tangential motion is retained, and the winner is never touched here.
function cancelYieldingInwardMovement(yielding, normalTowardWinner) {
  const dot = (yielding.vx || 0) * normalTowardWinner.x
    + (yielding.vy || 0) * normalTowardWinner.y;
  if (!(dot > 0)) return false;
  yielding.vx -= dot * normalTowardWinner.x;
  yielding.vy -= dot * normalTowardWinner.y;
  return true;
}

// Soft contact must not turn a follower's forward progress into a backwards
// shove. A small correction still keeps the two hulls from becoming perfectly
// coincident, but it is capped below one frame of travel so a timed-out
// follower can press through a friendly blocker instead of meeting a second
// hard barrier at the old soft-gap boundary.
function friendlySoftCorrection(
  yielding,
  correction,
  penetration,
  minimum,
  normalTowardWinner = null,
  dt = 1 / 30
) {
  const residual = Math.max(0, Number(penetration) - Math.max(0, Number(minimum) * 0.25));
  if (!(residual > 0)) return 0;
  const inwardSpeed = normalTowardWinner
    ? (yielding?.vx || 0) * normalTowardWinner.x
      + (yielding?.vy || 0) * normalTowardWinner.y
    : 0;
  // Once the friendly timeout has elapsed, a follower that is still driving
  // into the blocker must be allowed to cross it. Side contact still receives
  // a small positional guard below, but a forward guard would recreate the
  // very soft-gap barrier this stage is meant to release.
  if (inwardSpeed > STOPPED_SPEED) return 0;
  const safeDt = Number.isFinite(Number(dt)) && Number(dt) > 0 ? Number(dt) : 1 / 30;
  const frameTravel = fastHypot(yielding?.vx || 0, yielding?.vy || 0) * safeDt;
  // The timed release is allowed to leave a small overlap. Once the follower
  // is in that stage, a fixed multi-pixel correction can exceed its entire
  // final approach travel and turn a soft pass into a stationary oscillation.
  // Keep only a small per-iteration guard; the earlier hard/sidestep stages
  // have already handled material separation.
  const softCap = Math.max(0.25, frameTravel)
    / Math.max(1, SEPARATION_ITERATIONS);
  return Math.min(correction, residual * 0.9, softCap);
}


function resolveMapCollision(room, ship) {
  bump(room, "staticCollisionCalls");
  const radius = physicalCollisionRadius(ship);
  const launchControlled = Boolean(ship?.launchPhase);
  const width = room?.world?.width || WORLD.width;
  const height = room?.world?.height || WORLD.height;
  const scratch = room._mapCollisionScratch || (room._mapCollisionScratch = []);
  const beforeX = Number(ship.x) || 0;
  const beforeY = Number(ship.y) || 0;
  const beforeCorrectionX = Number(ship._collisionCorrectionX) || 0;
  const beforeCorrectionY = Number(ship._collisionCorrectionY) || 0;
  const hasStaticBudget = Number.isFinite(Number(ship._staticCollisionCorrectionDistance));
  const staticContacts = [];
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
  for (let asteroidIndex = 0; asteroidIndex < asteroids.length; asteroidIndex += 1) {
    const asteroid = asteroids[asteroidIndex];
    if (!asteroid) continue;
    let dx = (ship.x || 0) - asteroid.x;
    let dy = (ship.y || 0) - asteroid.y;
    let distance = fastHypot(dx, dy);
    const minimum = (asteroid.radius || 0) + radius;
    if (distance > minimum + STATIC_CONTACT_EPSILON) continue;
    hit = true;
    if (distance <= 0.001) {
      const angle = ((hashString(String(ship.id)) >>> 0) / 0x100000000) * Math.PI * 2;
      dx = Math.cos(angle);
      dy = Math.sin(angle);
      distance = 1;
    }
    const penetration = Math.max(0, minimum - distance);
    const normalX = dx / distance;
    const normalY = dy / distance;
    ship.x += normalX * penetration;
    ship.y += normalY * penetration;
    ship._collisionCorrectionX = (ship._collisionCorrectionX || 0) + normalX * penetration;
    ship._collisionCorrectionY = (ship._collisionCorrectionY || 0) + normalY * penetration;
    const inwardSpeed = (ship.vx || 0) * normalX + (ship.vy || 0) * normalY;
    if (inwardSpeed < 0) {
      // Static geometry is hard but frictionless: remove only the component
      // entering the surface. The tangent is deliberately left untouched.
      ship.vx -= inwardSpeed * normalX;
      ship.vy -= inwardSpeed * normalY;
    }
    staticContacts.push({
      obstacleId: `asteroid:${String(asteroid.id ?? asteroidIndex)}`,
      normalX,
      normalY,
      penetration
    });
  }
  if (!launchControlled && resolveStationCollision(room, ship, radius, (contact) => {
    staticContacts.push(contact);
  })) hit = true;
  const edge = WORLD_MARGIN + radius;
  const edgeBeforeX = ship.x;
  const edgeBeforeY = ship.y;
  ship.x = clampNumber(ship.x, edge, width - edge);
  ship.y = clampNumber(ship.y, edge, height - edge);
  ship._collisionCorrectionX = (ship._collisionCorrectionX || 0) + ship.x - edgeBeforeX;
  ship._collisionCorrectionY = (ship._collisionCorrectionY || 0) + ship.y - edgeBeforeY;

  // Several hull cells can contact one station piece during the same call,
  // and a deeply embedded spawn can produce a very large raw correction. Keep
  // the total static displacement for this authoritative tick bounded. Normal
  // surface contacts are untouched; only pathological penetration is allowed
  // to remain for the next substep/tick to resolve.
  const rawCorrectionX = ship.x - beforeX;
  const rawCorrectionY = ship.y - beforeY;
  const rawCorrectionDistance = fastHypot(rawCorrectionX, rawCorrectionY);
  const appliedBefore = hasStaticBudget
    ? Math.max(0, Number(ship._staticCollisionCorrectionDistance) || 0)
    : 0;
  const remainingBudget = hasStaticBudget
    ? Math.max(0, STATIC_COLLISION_MAX_TICK_CORRECTION - appliedBefore)
    : Infinity;
  const correctionScale = rawCorrectionDistance > remainingBudget && rawCorrectionDistance > 0
    ? remainingBudget / rawCorrectionDistance
    : 1;
  if (correctionScale < 1) {
    const appliedX = rawCorrectionX * correctionScale;
    const appliedY = rawCorrectionY * correctionScale;
    ship.x = beforeX + appliedX;
    ship.y = beforeY + appliedY;
    ship._collisionCorrectionX = beforeCorrectionX + appliedX;
    ship._collisionCorrectionY = beforeCorrectionY + appliedY;
  }
  const appliedCorrectionX = ship.x - beforeX;
  const appliedCorrectionY = ship.y - beforeY;
  if (hasStaticBudget) {
    ship._staticCollisionCorrectionDistance = appliedBefore
      + fastHypot(appliedCorrectionX, appliedCorrectionY);
  }
  bump(room, "staticCollisionCorrectionDistance", fastHypot(appliedCorrectionX, appliedCorrectionY));
  for (const contact of staticContacts) recordStaticSlideContact(ship, contact);
  if (hit) {
    bump(room, "staticCollisionHits");
    bumpMovementMetric("collisionCount");
  }
  return hit;
}

// Circle-on-circle overlap in the shape findShipHullOverlap returns, so the
// solver below does not care which one it was handed.
//
// This is what "physical collision stops positional overlap, not angular
// overlap" means in practice. Hull-cell collision is a function of both ships'
// angles, so a hull rotating on the spot can push itself into a neighbour and be
// pushed back -- a packed group becomes angularly locked and cannot turn at all.
// A circle has no orientation, so rotation is free by construction and only
// actual positional overlap is ever resolved.
function findShipCircleOverlap(a, b, dx, dy, minimum) {
  const distance = fastHypot(dx, dy);
  if (distance >= minimum) return null;
  return { dx, dy, distance, penetration: minimum - distance };
}

function resolveSeparationPair(room, a, b, options = null) {
  // Simultaneous station launches occupy independently authored lanes. Their
  // positions are owned by launch control, so generic separation must not turn
  // a valid multi-bay launch into a lateral tug-of-war.
  if (a?.launchPhase && b?.launchPhase) return null;
  bump(room, "separationPairsExamined");
  const broadDx = (b.x || 0) - (a.x || 0);
  const broadDy = (b.y || 0) - (a.y || 0);
  const broadMinimum = physicalCollisionRadius(a) + physicalCollisionRadius(b);
  if (broadDx * broadDx + broadDy * broadDy >= broadMinimum * broadMinimum) {
    bump(room, "separationBroadPhaseRejected");
    return null;
  }
  bump(room, "separationNarrowPhaseChecks");
  const overlap = options?.circular
    ? findShipCircleOverlap(a, b, broadDx, broadDy, broadMinimum)
    : findShipHullOverlap(a, b);
  if (!overlap) return null;
  bump(room, "separationOverlapsResolved");

  let normalX;
  let normalY;
  if (overlap.distance > 0.001) {
    normalX = overlap.dx / overlap.distance;
    normalY = overlap.dy / overlap.distance;
  } else if (fastHypot(broadDx, broadDy) > 0.001) {
    const inverse = 1 / fastHypot(broadDx, broadDy);
    normalX = broadDx * inverse;
    normalY = broadDy * inverse;
  } else {
    normalX = compareNaturalIds(a.id, b.id) <= 0 ? 1 : -1;
    normalY = 0;
  }

  const tick = Number(a._simNow || b._simNow) || 0;
  const releaseDistance = broadMinimum + 96;
  const winnerId = trafficPriorityWinner(room, a, b, tick, releaseDistance);
  const yielding = trafficIsPositioned(a) !== trafficIsPositioned(b)
    ? (trafficIsPositioned(a) ? b : a)
    : (winnerId === a.id ? a : b);
  const contact = recordShipContact(room, a, b, tick);
  const friendly = friendlyShipPair(room, a, b);
  const hardFriendlyHold = friendly && friendlyHoldApproachPair(a, b);
  const softFriendlyContact = friendly && !friendlyChargePair(a, b) && !hardFriendlyHold
    && (contact.duration >= 1500 || friendlyTrafficSoftContact(room, a, b, tick));
  const sidestepContact = friendly && contact.duration >= 400;
  const normalTowardWinner = yielding === a
    ? { x: normalX, y: normalY }
    : { x: -normalX, y: -normalY };
  const correctedPenetration = Math.max(0, overlap.penetration - SEPARATION_SLOP);
  let correction = correctedPenetration
    * (Number.isFinite(options?.correction) ? options.correction : SEPARATION_CORRECTION)
    * (sidestepContact ? 0.8 : 1);
  if (softFriendlyContact) {
    correction = friendlySoftCorrection(
      yielding,
      correction,
      overlap.penetration,
      broadMinimum,
      normalTowardWinner,
      options?.dt
    );
  }
  if (options?.packedCorrectionBudget) {
    const used = Math.max(0, Number(yielding._packedCorrectionDistance) || 0);
    const configuredBudget = Number(yielding._packedCorrectionBudget);
    const budget = Number.isFinite(configuredBudget)
      ? Math.max(0, configuredBudget)
      : PACKED_FLEET_MAX_TICK_CORRECTION;
    correction = Math.min(
      correction,
      Math.max(0, budget - used)
    );
  }
  const moveA = yielding === a ? correction : 0;
  const moveB = yielding === b ? correction : 0;
  const width = room.world?.width || WORLD.width;
  const height = room.world?.height || WORLD.height;
  const edgeA = WORLD_MARGIN + physicalCollisionRadius(a);
  const edgeB = WORLD_MARGIN + physicalCollisionRadius(b);
  const oldAX = a.x;
  const oldAY = a.y;
  const oldBX = b.x;
  const oldBY = b.y;
  a.x = clampNumber(a.x - normalX * moveA, edgeA, width - edgeA);
  a.y = clampNumber(a.y - normalY * moveA, edgeA, height - edgeA);
  b.x = clampNumber(b.x + normalX * moveB, edgeB, width - edgeB);
  b.y = clampNumber(b.y + normalY * moveB, edgeB, height - edgeB);
  a._collisionCorrectionX = (a._collisionCorrectionX || 0) + a.x - oldAX;
  a._collisionCorrectionY = (a._collisionCorrectionY || 0) + a.y - oldAY;
  b._collisionCorrectionX = (b._collisionCorrectionX || 0) + b.x - oldBX;
  b._collisionCorrectionY = (b._collisionCorrectionY || 0) + b.y - oldBY;

  if (!softFriendlyContact) {
    cancelYieldingInwardMovement(
      yielding,
      normalTowardWinner
    );
  } else {
    bumpMovementMetric("friendlySoftContactCount");
  }
  collisionBump(room, "shipCollisionPairs");
  collisionBump(room, "shipCollisionPenetrationCorrected", correctedPenetration);
  const stationary = [a, b].find((ship) =>
    shipIsStopped(ship)
    && fastHypot(ship._integratedMovementX || 0, ship._integratedMovementY || 0) < 0.5);
  if (stationary
    && contact.consecutive === 12
    && fastHypot(
      stationary._collisionCorrectionX || 0,
      stationary._collisionCorrectionY || 0
    ) > 2) {
    collisionBump(room, "towingRegressionDetections");
  }
  if (options?.packedCorrectionBudget) {
    const applied = Math.hypot(
      yielding.x - (yielding === a ? oldAX : oldBX),
      yielding.y - (yielding === a ? oldAY : oldBY)
    );
    yielding._packedCorrectionDistance = (
      Math.max(0, Number(yielding._packedCorrectionDistance) || 0) + applied
    );
  }
  return { penetration: overlap.penetration, correctionApplied: correction };
}

function getLiveShips(room) {
  return Array.from(room.ships?.values() || []).filter((ship) => ship && ship.alive);
}

function updateShipSeparation(room, shipList, dt, now = 0, options = null) {
  const contactPairs = require("./movementContactPairs");
  const liveShips = (Array.isArray(shipList) ? shipList : getLiveShips(room))
    .filter((ship) => ship && ship.alive && !ship.removed);
  let stepId = room._movementContactPairStepId;
  if (stepId === null || stepId === undefined) {
    stepId = contactPairs.beginMovementContactStep(room, liveShips, now);
  }
  if (room._movementContactPairBuildStepId !== stepId) {
    contactPairs.buildMovementContactPairs(room, liveShips, now, { stepId });
  }
  let separationShips = Array.isArray(shipList) ? shipList : liveShips;
  if (room._movementContactPairNeedsRecovery) {
    // A launch can occur after the normal movement-boundary build. Include
    // the room's current live roster in one exceptional, deterministic
    // recovery build so the newcomer cannot be absent from the solver graph.
    separationShips = getLiveShips(room).filter((ship) => !ship.removed);
    contactPairs.rebuildMovementContactPairsForRecovery(room, separationShips, now);
  }
  return require("./packedFleetSolver").solvePackedFleetSeparation(
    room,
    separationShips,
    dt,
    now,
    options,
    stepId
  );
}

function resolveFleetMapCollisions(room) {
  let count = 0;
  for (const ship of getLiveShips(room)) {
    if (resolveMapCollision(room, ship)) count += 1;
  }
  return count;
}

module.exports = {
  STATIC_SLIDE_BLOCK_MS,
  STATIC_SLIDE_REPLAN_MS,
  navigationClearanceRadius,
  physicalCollisionRadius,
  cancelYieldingInwardMovement,
  friendlyTrafficSoftContact,
  friendlyChargePair,
  friendlyHoldApproachPair,
  friendlyShipPair,
  friendlySoftCorrection,
  recordShipContact,
  recordStaticSlideContact,
  resolveFleetMapCollisions,
  resolveMapCollision,
  resolveSeparationPair,
  separationRadius,
  updateShipSeparation
};
