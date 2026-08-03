"use strict";

const { clampNumber, fastHypot, hashString, compareEntityIds, compareNaturalIds, performanceNow } = require("./utils");
const { WORLD } = require("./config");
const { bump, recordDuration } = require("./roomTelemetry");
const { INCREMENTAL_SPATIAL_INDEX } = require("./performanceFlags");
const { findShipHullOverlap } = require("./componentGeometry");
const {
  ASTEROID_QUERY_PAD,
  SEPARATION_BROAD_PHASE_PAD,
  SEPARATION_CORRECTION,
  SEPARATION_ITERATIONS,
  SEPARATION_SLOP,
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
const STATIC_SLIDE_REPLAN_MS = 1500;
const STATIC_SLIDE_RECOVERY_MS = 2500;

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
    recoveryAt: continuous && Number.isFinite(Number(previous.recoveryAt))
      ? Number(previous.recoveryAt)
      : startedAt + STATIC_SLIDE_RECOVERY_MS,
    lastContactAt: now,
    lastX: Number(ship.x) || 0,
    lastY: Number(ship.y) || 0,
    replanCount: continuous ? (Number(previous.replanCount) || 0) : 0,
    recoveryCount: continuous ? (Number(previous.recoveryCount) || 0) : 0
  };
}

function physicalCollisionRadius(ship) {
  return Math.max(18, Number(ship?.physicalRadius) || (Number(ship?.radius) || 0) * 0.56);
}

function navigationClearanceRadius(ship) {
  const physical = physicalCollisionRadius(ship);
  return physical + Math.max(8, (Number(ship?.radius) || 0) * 0.12);
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
const COLLISION_CONTACT_RETENTION_MS = 4000;

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
  for (let asteroidIndex = 0; asteroidIndex < asteroids.length; asteroidIndex += 1) {
    const asteroid = asteroids[asteroidIndex];
    if (!asteroid) continue;
    let dx = (ship.x || 0) - asteroid.x;
    let dy = (ship.y || 0) - asteroid.y;
    let distance = fastHypot(dx, dy);
    const minimum = (asteroid.radius || 0) + radius;
    if (distance >= minimum) continue;
    hit = true;
    if (distance <= 0.001) {
      const angle = ((hashString(String(ship.id)) >>> 0) / 0x100000000) * Math.PI * 2;
      dx = Math.cos(angle);
      dy = Math.sin(angle);
      distance = 1;
    }
    const penetration = minimum - distance;
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
    recordStaticSlideContact(ship, {
      obstacleId: `asteroid:${String(asteroid.id ?? asteroidIndex)}`,
      normalX,
      normalY,
      penetration
    });
  }
  if (!launchControlled && resolveStationCollision(room, ship, radius, (contact) => {
    recordStaticSlideContact(ship, contact);
  })) hit = true;
  const edge = WORLD_MARGIN + radius;
  const beforeX = ship.x;
  const beforeY = ship.y;
  ship.x = clampNumber(ship.x, edge, width - edge);
  ship.y = clampNumber(ship.y, edge, height - edge);
  ship._collisionCorrectionX = (ship._collisionCorrectionX || 0) + ship.x - beforeX;
  ship._collisionCorrectionY = (ship._collisionCorrectionY || 0) + ship.y - beforeY;
  if (hit) bumpMovementMetric("collisionCount");
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
  const softFriendlyContact = friendly && !friendlyChargePair(a, b)
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
  return { penetration: overlap.penetration };
}

function getLiveShips(room) {
  return Array.from(room.ships?.values() || []).filter((ship) => ship && ship.alive);
}

function pruneCollisionContacts(room, now) {
  const contacts = room?._shipCollisionContacts;
  const tick = Number(now) || 0;
  if (!contacts?.size || tick <= 0) return;
  if (tick < (Number(room._nextShipCollisionContactPruneAt) || 0)) return;
  for (const [pairKey, contact] of contacts) {
    if (tick - (Number(contact?.at) || 0) > COLLISION_CONTACT_RETENTION_MS) {
      contacts.delete(pairKey);
    }
  }
  room._nextShipCollisionContactPruneAt = tick + COLLISION_CONTACT_RETENTION_MS;
}

function updateLegacyShipSeparation(room, shipList, dt, now = 0, options = null) {
  pruneCollisionContacts(room, now);
  const ships = (Array.isArray(shipList)
    ? shipList.filter((ship) => ship && ship.alive)
    : getLiveShips(room))
    .slice()
    .sort(compareEntityIds);
  const separationStart = performanceNow();
  // Pair resolution has to visit (a, b) in a stable order, and it used to
  // establish that order by comparing ids for every candidate of every ship on
  // every iteration. Stamping each ship's rank in the already-sorted list turns
  // those comparisons into integer arithmetic. Ships the spatial index returns
  // that are not part of this pass keep the id comparison, so the ordering is
  // identical either way.
  const orderEpoch = (room._separationOrderEpoch = (Number(room._separationOrderEpoch) || 0) + 1);
  for (let index = 0; index < ships.length; index += 1) {
    ships[index]._separationOrder = index;
    ships[index]._separationOrderEpoch = orderEpoch;
  }
  const rankOf = (ship) => (ship._separationOrderEpoch === orderEpoch ? ship._separationOrder : -1);
  const byRank = (x, y) => {
    const xRank = rankOf(x);
    const yRank = rankOf(y);
    return xRank >= 0 && yRank >= 0 ? xRank - yRank : compareEntityIds(x, y);
  };
  const modified = room._shipSeparationModified || (room._shipSeparationModified = new Set());
  modified.clear();
  let unresolved = [];
  for (let iteration = 0; iteration < SEPARATION_ITERATIONS; iteration += 1) {
    let overlaps = 0;
    unresolved = [];
    bump(room, "separationIterations");
    const narrowStart = performanceNow();
    for (const a of ships) {
      const usingIndex = room.spatialIndex?.dynamicValid
        && room.spatialIndex.queryRangeUnordered;
      const candidates = usingIndex
        ? room.spatialIndex.queryRangeUnordered(
          "ships",
          a.x,
          a.y,
          physicalCollisionRadius(a) * 2 + SEPARATION_BROAD_PHASE_PAD,
          a._shipCollisionCandidateScratch || (a._shipCollisionCandidateScratch = [])
        )
        : ships;
      if (usingIndex && candidates.length > 1) candidates.sort(byRank);
      const aRank = rankOf(a);
      bump(room, "separationQueries");
      bump(room, "separationCandidatesReturned", candidates.length);
      for (const b of candidates) {
        if (!b?.alive || b === a) continue;
        const bRank = rankOf(b);
        if (bRank >= 0 && aRank >= 0 ? bRank <= aRank : compareEntityIds(b, a) <= 0) continue;
        const result = resolveSeparationPair(room, a, b, options);
        if (!result) continue;
        overlaps += 1;
        unresolved.push([a, b, result.penetration]);
        modified.add(a.id);
        modified.add(b.id);
      }
    }
    recordDuration(room, "separationNarrowPhaseMs", narrowStart);
    const mapStart = performanceNow();
    for (const ship of ships) {
      resolveMapCollision(room, ship);
      bump(room, "separationMapCollisionCalls");
    }
    recordDuration(room, "separationMapCollisionMs", mapStart);
    if (overlaps === 0) break;
    if (room.spatialIndex?.updateLiveEntities) {
      const rebuildStart = performanceNow();
      const { shipBroadPhaseRadius } = require("./spatialIndex");
      if (INCREMENTAL_SPATIAL_INDEX()) {
        room.spatialIndex.updateLiveEntities("ships", ships, shipBroadPhaseRadius);
      } else {
        room.spatialIndex.rebuildKind("ships", ships, shipBroadPhaseRadius, now);
        bump(room, "separationShipIndexRebuilds");
        recordDuration(room, "separationSpatialRebuildMs", rebuildStart);
      }
    }
  }
  if (unresolved.length) {
    collisionBump(room, "shipCollisionUnresolvedPairs", unresolved.length);
    const { findClearShipSpawnPoint } = require("./spawnPlanner");
    for (const [a, b, penetration] of unresolved) {
      const newcomer = a.spawnState && now < a.spawnState.expiresAt
        ? a
        : (b.spawnState && now < b.spawnState.expiresAt ? b : null);
      if (!newcomer || penetration < 2) continue;
      const recovery = findClearShipSpawnPoint(room, {
        preferredX: newcomer.spawnState.launchPoint.x,
        preferredY: newcomer.spawnState.launchPoint.y,
        physicalRadius: physicalCollisionRadius(newcomer),
        ownerId: newcomer.ownerId,
        requestId: `recovery:${newcomer.id}`,
        shipIndex: 0,
        ignoredShips: new Set([newcomer])
      });
      if (recovery.ok) {
        newcomer.x = recovery.x;
        newcomer.y = recovery.y;
        newcomer.vx = 0;
        newcomer.vy = 0;
      }
    }
  }
  bump(room, "separationUnresolvedPairs", unresolved.length);
  recordDuration(room, "shipSeparationMs", separationStart);
  return Array.from(modified);
}

// Phase 4C shared-pair path. It intentionally retains the established
// sequential narrow-phase correction and impulse rules so enabling the pair
// cache alone is a broad-phase change, not a gameplay/balance change. The
// difference is that every iteration consumes the one canonical pair array;
// there are no per-ship spatial queries or ship-index refreshes in this loop.
function updateSharedPairSeparation(room, shipList, dt, now = 0, options = null) {
  const contactPairs = require("./movementContactPairs");
  const inputShips = Array.isArray(shipList) ? shipList : getLiveShips(room);
  const liveShips = inputShips
    .filter((ship) => ship && ship.alive && !ship.removed)
    .slice()
    .sort(compareEntityIds);
  let stepId = room._movementContactPairStepId;
  if (stepId === null || stepId === undefined) {
    stepId = contactPairs.beginMovementContactStep(room, liveShips, now);
  }
  if (room._movementContactPairBuildStepId !== stepId) {
    contactPairs.buildMovementContactPairs(room, liveShips, now, { stepId });
  }
  const pairs = contactPairs.getMovementContactPairs(room, stepId);
  const separationStart = performanceNow();
  const modified = room._shipSeparationModified || (room._shipSeparationModified = new Set());
  modified.clear();
  let unresolved = [];
  let iterations = 0;
  for (; iterations < SEPARATION_ITERATIONS; iterations += 1) {
    let overlaps = 0;
    unresolved = [];
    bump(room, "separationIterations");
    // This is the broad-phase work the shared set replaces. Keep the diagnostic
    // visible without incrementing the legacy query counter.
    bump(room, "movementLegacySeparationQueriesAvoided", liveShips.length);
    const narrowStart = performanceNow();
    for (const pair of pairs) {
      const a = pair?.a;
      const b = pair?.b;
      if (!a?.alive || a.removed || !b?.alive || b.removed || a === b) continue;
      const result = resolveSeparationPair(room, a, b, options);
      if (!result) continue;
      overlaps += 1;
      unresolved.push([a, b, result.penetration]);
      modified.add(a.id);
      modified.add(b.id);
    }
    recordDuration(room, "separationNarrowPhaseMs", narrowStart);
    const mapStart = performanceNow();
    // Preserve the established static-collision interaction for the shared
    // legacy solver. This is not a ship broad phase and does not regenerate the
    // shared pair set.
    for (const ship of liveShips) {
      resolveMapCollision(room, ship);
      bump(room, "separationMapCollisionCalls");
    }
    recordDuration(room, "separationMapCollisionMs", mapStart);
    if (overlaps === 0) break;
  }
  if (unresolved.length) {
    collisionBump(room, "shipCollisionUnresolvedPairs", unresolved.length);
    const { findClearShipSpawnPoint } = require("./spawnPlanner");
    for (const [a, b, penetration] of unresolved) {
      const newcomer = a.spawnState && now < a.spawnState.expiresAt
        ? a
        : (b.spawnState && now < b.spawnState.expiresAt ? b : null);
      if (!newcomer || penetration < 2) continue;
      const recovery = findClearShipSpawnPoint(room, {
        preferredX: newcomer.spawnState.launchPoint.x,
        preferredY: newcomer.spawnState.launchPoint.y,
        physicalRadius: physicalCollisionRadius(newcomer),
        ownerId: newcomer.ownerId,
        requestId: `recovery:${newcomer.id}`,
        shipIndex: 0,
        ignoredShips: new Set([newcomer])
      });
      if (recovery.ok) {
        newcomer.x = recovery.x;
        newcomer.y = recovery.y;
        newcomer.vx = 0;
        newcomer.vy = 0;
      }
    }
  }
  bump(room, "separationUnresolvedPairs", unresolved.length);
  recordDuration(room, "shipSeparationMs", separationStart);
  return Array.from(modified);
}

function updateShipSeparation(room, shipList, dt, now = 0, options = null) {
  const { SHARED_MOVEMENT_CONTACT_PAIRS, PACKED_FLEET_SOLVER } = require("./performanceFlags");
  if (SHARED_MOVEMENT_CONTACT_PAIRS()) {
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
    let separationShips = shipList;
    if (room._movementContactPairNeedsRecovery) {
      // A launch can occur after the normal movement-boundary build. Include
      // the room's current live roster in one exceptional, deterministic
      // recovery build so the newcomer cannot be absent from the solver graph.
      separationShips = getLiveShips(room).filter((ship) => !ship.removed);
      contactPairs.rebuildMovementContactPairsForRecovery(room, separationShips, now);
    }
    if (PACKED_FLEET_SOLVER()) {
      return require("./packedFleetSolver").solvePackedFleetSeparation(
        room,
        separationShips,
        dt,
        now,
        options,
        stepId
      );
    }
    return updateSharedPairSeparation(room, separationShips, dt, now, options);
  }
  return updateLegacyShipSeparation(room, shipList, dt, now, options);
}

function resolveFleetMapCollisions(room) {
  let count = 0;
  for (const ship of getLiveShips(room)) {
    if (resolveMapCollision(room, ship)) count += 1;
  }
  return count;
}

module.exports = {
  navigationClearanceRadius,
  physicalCollisionRadius,
  cancelYieldingInwardMovement,
  friendlyTrafficSoftContact,
  friendlyChargePair,
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
