"use strict";

const { clampNumber, fastHypot, hashString, compareEntityIds, compareNaturalIds, performanceNow } = require("./utils");
const { bump, recordDuration } = require("./roomTelemetry");
const { INCREMENTAL_SPATIAL_INDEX } = require("./performanceFlags");
const { findShipHullOverlap } = require("./componentGeometry");
const {
  ASTEROID_QUERY_PAD,
  ASTEROID_RESTITUTION,
  SEPARATION_BIAS_SCALE,
  SEPARATION_BROAD_PHASE_PAD,
  SEPARATION_CORRECTION,
  SEPARATION_IMPULSE_HEADROOM,
  SEPARATION_ITERATIONS,
  SEPARATION_MAX_BIAS_SPEED,
  SEPARATION_MIN_IMPULSE_CAP,
  SEPARATION_SLOP,
  STOPPED_SPEED,
  WORLD_MARGIN
} = require("./movementTuning");
const { bumpMovementMetric } = require("./movementMetrics");

let cachedResolveStationCollision = null;
function resolveStationCollision(room, ship, shipRadius) {
  if (!cachedResolveStationCollision) cachedResolveStationCollision = require("./stations").resolveStationCollision;
  if (!cachedResolveStationCollision) return false;
  return cachedResolveStationCollision(room, ship, shipRadius);
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
      || phase === "idle");
}


function resolveMapCollision(room, ship) {
  const radius = physicalCollisionRadius(ship);
  const width = room?.world?.width || 2000;
  const height = room?.world?.height || 1600;
  const scratch = room._mapCollisionScratch || (room._mapCollisionScratch = []);
  const asteroids = room.spatialIndex?.dynamicValid && room.spatialIndex.queryAabbUnordered
    ? room.spatialIndex.queryAabbUnordered(
      "asteroids",
      ship.x - radius - ASTEROID_QUERY_PAD,
      ship.y - radius - ASTEROID_QUERY_PAD,
      ship.x + radius + ASTEROID_QUERY_PAD,
      ship.y + radius + ASTEROID_QUERY_PAD,
      scratch
    )
    : (room.map?.asteroids || []);
  let hit = false;
  for (const asteroid of asteroids) {
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
      ship.vx -= inwardSpeed * normalX * ASTEROID_RESTITUTION;
      ship.vy -= inwardSpeed * normalY * ASTEROID_RESTITUTION;
    }
  }
  if (resolveStationCollision(room, ship, radius)) hit = true;
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

  const inverseMassA = 1 / Math.max(1, Number(a.stats?.mass) || 1);
  const inverseMassB = 1 / Math.max(1, Number(b.stats?.mass) || 1);
  const inverseMassSum = inverseMassA + inverseMassB;
  const correctedPenetration = Math.max(0, overlap.penetration - SEPARATION_SLOP);
  const correction = correctedPenetration
    * (Number.isFinite(options?.correction) ? options.correction : SEPARATION_CORRECTION);
  const moveA = correction * inverseMassA / inverseMassSum;
  const moveB = correction * inverseMassB / inverseMassSum;
  const width = room.world?.width || 2000;
  const height = room.world?.height || 1600;
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

  const relativeVx = (b.vx || 0) - (a.vx || 0);
  const relativeVy = (b.vy || 0) - (a.vy || 0);
  const closingSpeed = relativeVx * normalX + relativeVy * normalY;
  // Only ships actually driving into each other get an impulse. The positional
  // correction above already resolves overlap; adding a bias velocity to every
  // touching pair regardless -- including two that are stationary -- injected
  // energy the movers then had to fight, every tick.
  let impulseMagnitude = 0;
  if (closingSpeed < 0) {
    const biasSpeed = Math.min(
      SEPARATION_MAX_BIAS_SPEED,
      correctedPenetration * SEPARATION_BIAS_SCALE
    );
    const maxImpulse = Math.max(
      SEPARATION_MIN_IMPULSE_CAP,
      (Math.abs(closingSpeed) + SEPARATION_IMPULSE_HEADROOM) / inverseMassSum
    );
    impulseMagnitude = clampNumber(
      (-closingSpeed + biasSpeed) / inverseMassSum,
      0,
      maxImpulse
    );
  }
  if (impulseMagnitude > 0) {
    a.vx = (a.vx || 0) - impulseMagnitude * inverseMassA * normalX;
    a.vy = (a.vy || 0) - impulseMagnitude * inverseMassA * normalY;
    b.vx = (b.vx || 0) + impulseMagnitude * inverseMassB * normalX;
    b.vy = (b.vy || 0) + impulseMagnitude * inverseMassB * normalY;
    collisionBump(room, "shipCollisionImpulseApplied");
  }
  collisionBump(room, "shipCollisionPairs");
  collisionBump(room, "shipCollisionPenetrationCorrected", correctedPenetration);
  const pairKey = String(a.id) < String(b.id)
    ? `${a.id}|${b.id}`
    : `${b.id}|${a.id}`;
  const contacts = room._shipCollisionContacts || (room._shipCollisionContacts = new Map());
  const previous = contacts.get(pairKey);
  const tick = Number(a._simNow || b._simNow) || 0;
  const stationary = [a, b].find((ship) =>
    shipIsStopped(ship)
    && fastHypot(ship._integratedMovementX || 0, ship._integratedMovementY || 0) < 0.5);
  const consecutive = previous && tick - previous.at < 300
    ? previous.consecutive + 1
    : 1;
  contacts.set(pairKey, { at: tick, consecutive });
  if (stationary
    && consecutive === 12
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

const COLLISION_CONTACT_RETENTION_MS = 1000;

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
  resolveFleetMapCollisions,
  resolveMapCollision,
  resolveSeparationPair,
  separationRadius,
  updateShipSeparation
};
