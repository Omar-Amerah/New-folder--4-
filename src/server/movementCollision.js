"use strict";

const { clampNumber, fastHypot, hashString } = require("./utils");
const { findShipHullOverlap } = require("./componentGeometry");
const {
  ASTEROID_QUERY_PAD,
  ASTEROID_RESTITUTION,
  AVOIDANCE_BRAKE_TIME_S,
  AVOIDANCE_CLEARANCE_PAD,
  AVOIDANCE_CLEARANCE_PAD_SPAWN,
  AVOIDANCE_HORIZON_S,
  AVOIDANCE_HORIZON_SPAWN_S,
  AVOIDANCE_MIN_LATERAL,
  AVOIDANCE_QUERY_MIN_RANGE,
  AVOIDANCE_SIDESTEP_RATIO,
  AVOIDANCE_SIDE_COMMIT_MS,
  AVOIDANCE_STRENGTH_EQUAL,
  AVOIDANCE_STRENGTH_RIGHT_OF_WAY,
  AVOIDANCE_STRENGTH_YIELD,
  SEPARATION_BIAS_SCALE,
  SEPARATION_BROAD_PHASE_PAD,
  SEPARATION_CORRECTION,
  SEPARATION_IMPULSE_HEADROOM,
  SEPARATION_ITERATIONS,
  SEPARATION_MAX_BIAS_SPEED,
  SEPARATION_MIN_IMPULSE_CAP,
  SEPARATION_SLOP,
  SHIP_MASS_RIGHT_OF_WAY_RATIO,
  STOPPED_SPEED,
  WORLD_MARGIN
} = require("./movementTuning");
const { bumpMovementMetric } = require("./movementMetrics");

// combat.js pulls in most of the simulation, so resolve it on first use rather
// than at load time -- this module sits underneath it.
let cachedAreEnemies = null;
function areEnemies(room, a, b) {
  if (!cachedAreEnemies) cachedAreEnemies = require("./combat").areEnemies;
  return cachedAreEnemies(room, a, b);
}

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

function stableAvoidancePriority(ship, other) {
  const shipMass = Math.max(1, Number(ship.stats?.mass) || 1);
  const otherMass = Math.max(1, Number(other.stats?.mass) || 1);
  if (otherMass >= shipMass * SHIP_MASS_RIGHT_OF_WAY_RATIO) return 1;
  if (shipMass >= otherMass * SHIP_MASS_RIGHT_OF_WAY_RATIO) return -1;
  const otherStopped = shipIsStopped(other);
  const shipStopped = shipIsStopped(ship);
  if (otherStopped !== shipStopped) return otherStopped ? 1 : -1;
  const massDifference = otherMass - shipMass;
  if (Math.abs(massDifference) > 0.01) return massDifference > 0 ? 1 : -1;
  return String(other.id).localeCompare(String(ship.id), undefined, { numeric: true }) < 0 ? 1 : -1;
}

function applyLocalShipAvoidance(room, ship, decision, stats, now) {
  if (!decision.needsPropulsion
    || !room.spatialIndex?.dynamicValid
    || !room.spatialIndex.queryRangeUnordered) return;
  const ownRadius = physicalCollisionRadius(ship);
  const speed = fastHypot(ship.vx || 0, ship.vy || 0);
  const spawning = Boolean(ship.spawnState && now < ship.spawnState.expiresAt);
  const horizon = spawning ? AVOIDANCE_HORIZON_SPAWN_S : AVOIDANCE_HORIZON_S;
  const queryRadius = ownRadius * 2
    + Math.max(AVOIDANCE_QUERY_MIN_RANGE, speed * horizon);
  // A player who right-clicks past an enemy asked for that line, not for a
  // detour around it. Pathing already ignores ships entirely -- the swerve came
  // from here -- so dropping enemies from the avoidance set while a hand-issued
  // move is running gives the straight run. Enemy hulls stay solid: the ship
  // drives into them and shoves through rather than sliding round.
  const command = ship.movement?.command;
  const drivingThrough = Boolean(command?.manual && command.type === "move");
  const scratch = ship._shipAvoidanceScratch || (ship._shipAvoidanceScratch = []);
  const nearby = room.spatialIndex.queryRangeUnordered(
    "ships",
    ship.x,
    ship.y,
    queryRadius,
    scratch
  );
  let best = null;
  for (const other of nearby) {
    if (!other?.alive || other === ship) continue;
    if (drivingThrough && areEnemies(room, ship.ownerId, other.ownerId)) continue;
    const rx = other.x - ship.x;
    const ry = other.y - ship.y;
    const rvx = (other.vx || 0) - (ship.vx || 0);
    const rvy = (other.vy || 0) - (ship.vy || 0);
    const relativeSpeedSq = rvx * rvx + rvy * rvy;
    const time = relativeSpeedSq > 0.01
      ? clampNumber(-(rx * rvx + ry * rvy) / relativeSpeedSq, 0, horizon)
      : 0;
    const predictedX = rx + rvx * time;
    const predictedY = ry + rvy * time;
    const minimum = ownRadius + physicalCollisionRadius(other)
      + (spawning ? AVOIDANCE_CLEARANCE_PAD_SPAWN : AVOIDANCE_CLEARANCE_PAD);
    const predicted = fastHypot(predictedX, predictedY);
    if (predicted >= minimum
      || (!best && rx * rvx + ry * rvy >= 0 && fastHypot(rx, ry) > minimum * 1.15)) continue;
    const urgency = minimum - predicted + (horizon - time) * 0.1;
    if (!best
      || urgency > best.urgency
      || (urgency === best.urgency && String(other.id) < String(best.other.id))) {
      best = { other, rx, ry, time, urgency };
    }
  }
  if (!best) return;

  const state = ship._shipAvoidance || (ship._shipAvoidance = {});
  let side = state.otherShipId === best.other.id && now < (state.committedUntil || 0)
    ? state.side
    : 0;
  if (!side) {
    const travelX = Math.cos(decision.moveAngle || ship.angle || 0);
    const travelY = Math.sin(decision.moveAngle || ship.angle || 0);
    const cross = travelX * best.ry - travelY * best.rx;
    side = Math.abs(cross) > 0.01
      ? (cross > 0 ? -1 : 1)
      : (hashString(`${ship.id}:${best.other.id}`) & 1 ? 1 : -1);
    if (state.side && state.side !== side) collisionBump(room, "shipAvoidanceSideChanges");
    state.otherShipId = best.other.id;
    state.side = side;
    state.committedUntil = now + AVOIDANCE_SIDE_COMMIT_MS;
  }

  const priority = stableAvoidancePriority(ship, best.other);
  const shipMass = Math.max(1, Number(ship.stats?.mass) || 1);
  const otherMass = Math.max(1, Number(best.other.stats?.mass) || 1);
  const hasMassRightOfWay = priority < 0
    && shipMass >= otherMass * SHIP_MASS_RIGHT_OF_WAY_RATIO;
  const strength = priority > 0
    ? AVOIDANCE_STRENGTH_YIELD
    : (hasMassRightOfWay ? AVOIDANCE_STRENGTH_RIGHT_OF_WAY : AVOIDANCE_STRENGTH_EQUAL);
  // Avoidance steers by sidestepping the commanded velocity, not by pushing on
  // the hull. Under flight assist the ship simply flies the amended command, and
  // its heading follows from it -- so a dodge turns the ship as a consequence
  // rather than by overwriting the facing, which used to snap the heading ~24
  // degrees the instant a neighbour came into range and snap it back when they
  // parted.
  const sidestep = Math.max(
    AVOIDANCE_MIN_LATERAL,
    (Number(decision.maximumSpeed) || 0) * AVOIDANCE_SIDESTEP_RATIO
  ) * strength;
  // On the final approach the arrival controller has already reduced the
  // commanded speed to what the remaining distance can safely absorb. Do not
  // let avoidance restore cruise speed after that calculation: it may change
  // the course, but it must stay inside the same braking-speed budget.
  const arrivalSpeedCap = decision.arrivalRequired && decision.isFinal && decision.goal
    ? Math.max(0, Number(decision.desiredSpeed) || 0)
    : Infinity;
  const boundedSidestep = Math.min(sidestep, arrivalSpeedCap);
  const forwardX = Math.cos(decision.moveAngle || ship.angle || 0);
  const forwardY = Math.sin(decision.moveAngle || ship.angle || 0);
  const sidestepX = -forwardY * side * boundedSidestep;
  const sidestepY = forwardX * side * boundedSidestep;
  const yielding = priority > 0
    || (!hasMassRightOfWay && best.time < AVOIDANCE_BRAKE_TIME_S);
  if (yielding) {
    // Giving way means giving up the course, not merely easing off it: the
    // commanded velocity becomes the sidestep alone, so the ship stops closing
    // and slides clear instead of continuing to press into whatever is ahead.
    decision.desiredVelocity.x = sidestepX;
    decision.desiredVelocity.y = sidestepY;
  } else {
    decision.desiredVelocity.x += sidestepX;
    decision.desiredVelocity.y += sidestepY;
  }
  if (Number.isFinite(arrivalSpeedCap)) {
    const amendedSpeed = fastHypot(
      decision.desiredVelocity.x,
      decision.desiredVelocity.y
    );
    if (amendedSpeed > arrivalSpeedCap && amendedSpeed > 0) {
      const scale = arrivalSpeedCap / amendedSpeed;
      decision.desiredVelocity.x *= scale;
      decision.desiredVelocity.y *= scale;
    }
  }
  decision.needsPropulsion = true;
  collisionBump(room, "shipAvoidanceActivations");
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

function resolveSeparationPair(room, a, b) {
  const broadDx = (b.x || 0) - (a.x || 0);
  const broadDy = (b.y || 0) - (a.y || 0);
  const broadMinimum = physicalCollisionRadius(a) + physicalCollisionRadius(b);
  if (broadDx * broadDx + broadDy * broadDy >= broadMinimum * broadMinimum) return null;
  const overlap = findShipHullOverlap(a, b);
  if (!overlap) return null;

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
    normalX = String(a.id).localeCompare(String(b.id), undefined, { numeric: true }) <= 0 ? 1 : -1;
    normalY = 0;
  }

  const inverseMassA = 1 / Math.max(1, Number(a.stats?.mass) || 1);
  const inverseMassB = 1 / Math.max(1, Number(b.stats?.mass) || 1);
  const inverseMassSum = inverseMassA + inverseMassB;
  const correctedPenetration = Math.max(0, overlap.penetration - SEPARATION_SLOP);
  const correction = correctedPenetration * SEPARATION_CORRECTION;
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

function updateShipSeparation(room, shipList, dt, now = 0) {
  pruneCollisionContacts(room, now);
  const ships = (Array.isArray(shipList)
    ? shipList.filter((ship) => ship && ship.alive)
    : getLiveShips(room))
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  const modified = new Set();
  let unresolved = [];
  for (let iteration = 0; iteration < SEPARATION_ITERATIONS; iteration += 1) {
    let overlaps = 0;
    unresolved = [];
    collisionBump(room, "shipCollisionIterations");
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
      if (usingIndex && candidates.length > 1) {
        candidates.sort((x, y) =>
          String(x.id).localeCompare(String(y.id), undefined, { numeric: true }));
      }
      for (const b of candidates) {
        if (!b?.alive
          || b === a
          || String(b.id).localeCompare(String(a.id), undefined, { numeric: true }) <= 0) continue;
        const result = resolveSeparationPair(room, a, b);
        if (!result) continue;
        overlaps += 1;
        unresolved.push([a, b, result.penetration]);
        modified.add(a.id);
        modified.add(b.id);
      }
    }
    for (const ship of ships) resolveMapCollision(room, ship);
    if (overlaps === 0) break;
    if (room.spatialIndex?.rebuildKind) {
      const { shipBroadPhaseRadius } = require("./spatialIndex");
      room.spatialIndex.rebuildKind("ships", ships, shipBroadPhaseRadius, now);
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
  return Array.from(modified);
}

function resolveFleetMapCollisions(room) {
  let count = 0;
  for (const ship of getLiveShips(room)) {
    if (resolveMapCollision(room, ship)) count += 1;
  }
  return count;
}

module.exports = {
  applyLocalShipAvoidance,
  navigationClearanceRadius,
  physicalCollisionRadius,
  resolveFleetMapCollisions,
  resolveMapCollision,
  resolveSeparationPair,
  separationRadius,
  updateShipSeparation
};
