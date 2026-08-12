"use strict";

const { clampNumber, fastHypot } = require("../utils");
const {
  ARRIVE_DISTANCE,
  HOLD_RANGE_RATIO,
  HOLD_RESUME_RATIO,
  REPAIR_STANDOFF_PAD
} = require("../movementTuning");
const { getMaxEffectiveWeaponRange } = require("../componentData");
const {
  navigationClearanceRadius,
  physicalCollisionRadius
} = require("../movementCollision");
const {
  ensureRoomNavigation,
  isSegmentClear,
  isStaticObstacleLineClear,
  nearestClearPoint,
  searchPathWorld
} = require("../movementNavigation");
const { stationAttackPoint } = require("../stationCollision");
const { combatStance } = require("./intent");
const { routeClearance } = require("./navigation");

const BEARING_MIN_DISTANCE = 1;
const ROUTE_REPLAN_DISTANCE = 48;
const CHARGE_CLING_SLACK = 24;
const CHARGE_CONTACT_PADDING = 8;
// How much of a lane's firing range may be spent on sideways offset. The rest
// is depth, so even the outermost ship in a very wide fleet still closes on the
// target rather than sliding along beside it.
const LANE_LATERAL_LIMIT = 0.9;

function targetIsStation(target) {
  return Array.isArray(target?.collisionPieces);
}

function targetSurfacePoint(target, bearing) {
  if (!targetIsStation(target)) return { x: target.x, y: target.y };
  const far = Math.max(
    Number(target.radius) || 0,
    Number(target.width) || 0,
    Number(target.height) || 0,
    1000
  ) * 4;
  return stationAttackPoint(
    target.x + Math.cos(bearing) * far,
    target.y + Math.sin(bearing) * far,
    target
  );
}

function targetAttackPointFrom(originX, originY, target) {
  if (targetIsStation(target)) return stationAttackPoint(originX, originY, target);
  return { x: target.x, y: target.y };
}

function targetDistanceFrom(originX, originY, target) {
  const point = targetAttackPointFrom(originX, originY, target);
  return fastHypot(point.x - originX, point.y - originY);
}

function engagementGeometry(ship, target) {
  if (targetIsStation(target)) {
    const surface = stationAttackPoint(ship.x || 0, ship.y || 0, target);
    return {
      distance: fastHypot(surface.x - (ship.x || 0), surface.y - (ship.y || 0)),
      contact: physicalCollisionRadius(ship),
      surface
    };
  }
  return {
    distance: fastHypot(target.x - (ship.x || 0), target.y - (ship.y || 0)),
    contact: physicalCollisionRadius(ship) + physicalCollisionRadius(target),
    surface: { x: target.x, y: target.y }
  };
}

function firingLineClearFrom(room, x, y, target, margin = 8) {
  const targetPoint = targetAttackPointFrom(x, y, target);
  const bearing = Math.atan2(y - targetPoint.y, x - targetPoint.x);
  const surface = targetSurfacePoint(target, bearing);
  return isStaticObstacleLineClear(room, x, y, surface.x, surface.y, margin, {
    ignoreStationContainingEndpoint: true
  });
}

function currentFiringLineClear(room, ship, target) {
  return firingLineClearFrom(room, ship.x || 0, ship.y || 0, target);
}

function radialSeparationSpeed(ship, target, distance) {
  const originX = ship.x || 0;
  const originY = ship.y || 0;
  const point = targetAttackPointFrom(originX, originY, target);
  const actualDistance = targetIsStation(target)
    ? fastHypot(point.x - originX, point.y - originY)
    : distance;
  if (!(actualDistance > BEARING_MIN_DISTANCE)) return 0;
  const unitX = (point.x - originX) / actualDistance;
  const unitY = (point.y - originY) / actualDistance;
  return ((target.vx || 0) - (ship.vx || 0)) * unitX
    + ((target.vy || 0) - (ship.vy || 0)) * unitY;
}

function engagementRanges(ship, target, type) {
  const hull = engagementGeometry(ship, target).contact;
  if (type !== "repair" && combatStance(ship) === "charge") {
    const enter = hull + CHARGE_CONTACT_PADDING;
    return {
      enter,
      resume: enter + CHARGE_CLING_SLACK
    };
  }
  const reach = type === "repair"
    ? (Number(ship.stats?.repairRange) || 0)
    : getMaxEffectiveWeaponRange(ship);
  const contact = hull + REPAIR_STANDOFF_PAD;
  const enter = Math.max(contact, reach * HOLD_RANGE_RATIO);
  return {
    contact,
    enter,
    resume: Math.max(contact, reach * HOLD_RESUME_RATIO)
  };
}

function canEngageFromHere(room, ship, target, type, distance, enter) {
  if (distance > enter) return false;
  return type !== "attack" || currentFiringLineClear(room, ship, target);
}

function firingPoint(target, bearing, radius) {
  const surface = targetSurfacePoint(target, bearing);
  return {
    x: surface.x + Math.cos(bearing) * radius,
    y: surface.y + Math.sin(bearing) * radius
  };
}

function preferredFiringBearing(ship, target, runtime) {
  const cached = runtime.engageApproach;
  const detouring = (runtime.path?.length || 0) > 1;
  if (cached && String(cached.targetId) === String(target.id) && detouring) return cached.bearing;
  const point = targetAttackPointFrom(ship.x || 0, ship.y || 0, target);
  const bearing = Math.atan2((ship.y || 0) - point.y, (ship.x || 0) - point.x);
  runtime.engageApproach = { targetId: String(target.id), bearing };
  return bearing;
}

// A Hold ship chooses its own reachable firing point. The point is recomputed
// per ship and per target; no other ship participates in this decision.
function reachableFiringPosition(room, ship, target, runtime, standoff, engageRange, now) {
  const navigation = ensureRoomNavigation(room);
  const targetId = String(target.id);
  const cached = runtime.firingSolution;
  const targetMoved = cached
    ? fastHypot((Number(target.x) || 0) - (Number(cached.targetX) || 0), (Number(target.y) || 0) - (Number(cached.targetY) || 0))
    : Infinity;
  const cacheMatches = cached
    && cached.targetId === targetId
    && cached.navigation === navigation
    && Math.abs((Number(cached.standoff) || 0) - standoff) < 0.5
    && targetMoved <= ROUTE_REPLAN_DISTANCE;

  const candidateForBearing = (bearing, verifyReachability = true) => {
    const candidate = firingPoint(target, bearing, standoff);
    const restingPoint = firingPoint(target, bearing, engageRange);
    if (!firingLineClearFrom(room, restingPoint.x, restingPoint.y, target)) return null;
    const clearance = routeClearance(ship);
    const probeRadius = targetIsStation(target)
      ? Math.max(standoff, clearance + ARRIVE_DISTANCE)
      : standoff;
    const probe = probeRadius === standoff ? candidate : firingPoint(target, bearing, probeRadius);
    const clear = nearestClearPoint(room, probe.x, probe.y, clearance);
    if (!clear.clear || fastHypot(clear.x - probe.x, clear.y - probe.y) > 2) return null;
    if (verifyReachability && !isSegmentClear(room, ship.x, ship.y, probe.x, probe.y, clearance)) {
      const search = searchPathWorld(room, ship.x, ship.y, probe.x, probe.y, clearance);
      if (!search.reachedGoal) return null;
    }
    return candidate;
  };

  if (cacheMatches && Number.isFinite(Number(cached.bearing))) {
    const cachedCandidate = candidateForBearing(Number(cached.bearing), false);
    if (cachedCandidate) return cachedCandidate;
  } else if (cacheMatches && now < Number(cached.retryAt)) {
    return null;
  }

  const preferred = preferredFiringBearing(ship, target, runtime);
  const offsets = [0];
  for (let step = 1; step <= 12; step += 1) {
    const offset = step * Math.PI / 12;
    offsets.push(offset, -offset);
  }
  for (const offset of offsets) {
    const bearing = preferred + offset;
    const candidate = candidateForBearing(bearing);
    if (!candidate) continue;
    runtime.firingSolution = {
      targetId,
      targetX: Number(target.x) || 0,
      targetY: Number(target.y) || 0,
      navigation,
      standoff,
      bearing,
      retryAt: 0
    };
    return candidate;
  }
  runtime.firingSolution = {
    targetId,
    targetX: Number(target.x) || 0,
    targetY: Number(target.y) || 0,
    navigation,
    standoff,
    bearing: null,
    retryAt: now + 500
  };
  return null;
}

function activeAttackLane(ship, runtime, target, type) {
  const lane = runtime.attackLane;
  if (!lane || type !== "attack") return null;
  if (combatStance(ship) !== "hold") return null;
  if (lane.targetId !== String(target.id)) return null;
  if (lane.commandId !== (runtime.command?.id || null)) return null;
  return lane;
}

// Where the lane says to advance to: straight at the target, stopping a firing
// range short of it, offset sideways by however far off the group's centre this
// ship already was.
//
// Returns null when there is no lane, or when the point it names is not ground
// the hull could occupy -- the ordinary per-ship firing-position search is a
// better answer than a lane that ends inside a rock.
function attackLaneDestination(room, ship, runtime, target, type, standoff) {
  const lane = activeAttackLane(ship, runtime, target, type);
  if (!lane) return null;
  const targetX = Number(target.x) || 0;
  const targetY = Number(target.y) || 0;
  const lateralX = -lane.forwardY;
  const lateralY = lane.forwardX;
  // The lane ends at firing range, and the sideways offset is part of that
  // distance -- pushing the ship straight out to `standoff` AND sideways would
  // leave the wings parked outside their own range with nothing left to do.
  // Solve for the depth that puts the point exactly one firing range out, and
  // pull an extreme offset in far enough to leave some approach in front of it.
  const lateral = clampNumber(
    lane.lateralOffset,
    -standoff * LANE_LATERAL_LIMIT,
    standoff * LANE_LATERAL_LIMIT
  );
  const depth = Math.sqrt(Math.max(0, standoff * standoff - lateral * lateral));
  let outX = -lane.forwardX * depth + lateralX * lateral;
  let outY = -lane.forwardY * depth + lateralY * lateral;

  // No retreat. A destination further from the target than the hull already is
  // would turn an attack order into a reversal -- which is what retargeting used
  // to do to whoever was out in front. Keep the ship's current radial depth and
  // let the lane carry it sideways instead; it closes from there.
  const reach = fastHypot(outX, outY);
  const ownDistance = fastHypot(targetX - (ship.x || 0), targetY - (ship.y || 0));
  if (reach > ownDistance && reach > 1e-6) {
    const scale = ownDistance / reach;
    outX *= scale;
    outY *= scale;
  }

  const x = targetX + outX;
  const y = targetY + outY;
  const clear = nearestClearPoint(room, x, y, navigationClearanceRadius(ship));
  if (!clear.clear || fastHypot(clear.x - x, clear.y - y) > ARRIVE_DISTANCE) return null;
  return { x: clear.x, y: clear.y };
}

module.exports = {
  attackLaneDestination,
  canEngageFromHere,
  currentFiringLineClear,
  engagementGeometry,
  engagementRanges,
  firingLineClearFrom,
  radialSeparationSpeed,
  reachableFiringPosition,
  targetAttackPointFrom,
  targetDistanceFrom,
  targetIsStation,
  targetSurfacePoint
};

