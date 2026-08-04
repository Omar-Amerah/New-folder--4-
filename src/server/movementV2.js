"use strict";

// Authoritative ship movement.
//
// A command gives a ship one destination (or one target id). Ships do their own
// route planning and steering. Friendlies are resolved only after every ship
// has integrated, so the movement controller never assigns positions to a
// group and never asks A* to predict another ship.

const {
  angleDifference,
  clampNumber,
  fastHypot
} = require("./utils");
const { WORLD } = require("./config");
const { gameplayNow } = require("./gameplayTime");
const { areEntityAllies, areEntityEnemies } = require("./relationships");
const { selectOwnedLivingShips } = require("./selection");
const { canTeamTargetEntity } = require("./visibility");
const {
  APPROACH_DAMPING,
  APPROACH_DAMPING_DISTANCE,
  ARRIVED_DAMPING,
  ARRIVE_DISTANCE,
  ARRIVE_LATCH_RATIO,
  DAMPING_REFERENCE_HZ,
  DESTINATION_ARRIVE_SPEED,
  FINAL_FACING_TOLERANCE,
  FULL_THRUST_HEADING_ERROR,
  HOLD_RANGE_RATIO,
  HOLD_RESUME_RATIO,
  LATERAL_DAMPING,
  MAX_MOVEMENT_DT,
  REPAIR_STANDOFF_PAD,
  REST_SPEED,
  TRAVEL_DAMPING,
  UNPOWERED_DAMPING
} = require("./movementTuning");
const {
  getMaxEffectiveWeaponRange,
  shipHasArmedProximityCharge,
  shipHasOffensiveWeapon
} = require("./componentData");
const {
  MOVEMENT_TOGGLE_DEFAULTS,
  sanitizeCombatStyle,
  sanitizeMovementToggles
} = require("./validation");
const {
  applyEngineHeat,
  applyTurnHeat,
  directionalTurnRate,
  driveAcceleration,
  hasDrive,
  heatAdjustedMovementStats,
  signedTurnRate
} = require("./movementCapability");
const {
  maxFriendlyCorrectionPerTick,
  navigationClearanceRadius,
  physicalCollisionRadius,
  resolveFleetMapCollisions,
  resolveMapCollision,
  resolveSeparationPair,
  separationRadius,
  updateShipSeparation: resolveShipSeparation
} = require("./movementCollision");
const {
  ensureRoomNavigation,
  isSegmentClear,
  isStaticObstacleLineClear,
  nearestClearPoint,
  searchPathWorld,
  segmentCircleClearance
} = require("./movementNavigation");
const { stationAttackPoint } = require("./stationCollision");
const {
  createMovementRuntime,
  ensureMovementRuntime,
  nextMovementCommandId,
  setManualRotation,
  setMovementCommand,
  syncMovementTarget
} = require("./movementRuntimeV2");
const { bumpMovementMetric } = require("./movementMetrics");
const { FORMATION_TYPES, SUPPORTED_MOVEMENT_TYPES, sanitizeFormationType } = require("./movementFlags");
const { attackSlotPoint, planAttackFormation, planFormation } = require("./movementFormations");

const MOVEMENT_SUBSTEP = 1 / 60;
const BEARING_MIN_DISTANCE = 1;
const TURN_TIME_CONSTANT_S = 0.04;
const BRAKE_ACCEL_RATIO = 5;
const MOMENTUM_HOLD_ANGLE = Math.PI / 2;
const WAYPOINT_CAPTURE_RATIO = 0.75;
const ROUTE_REPLAN_DISTANCE = 48;
const ROUTE_STUCK_MS = 500;
const ROUTE_UNREACHABLE_RETRY_MS = 2000;
const ROUTE_PROGRESS_EPSILON = 8;
const ROUTE_LOOKAHEAD_SPEED_FACTOR = 0.7;
const ROUTE_LOOKAHEAD_MIN_MULTIPLIER = 2;
const ROUTE_LOOKAHEAD_MAX_MULTIPLIER = 6;
const ROUTE_TURN_PAUSE_HEADING_ERROR = 0.7;
// How close the route's first point has to be to the ship before it counts as
// "where the ship already is" rather than a leg it has to fly.
const ROUTE_START_SNAP = 1;
const CHARGE_CLING_SLACK = 24;
const CHARGE_SETTLE_RADIAL_SPEED = 24;
const CHARGE_PURSUE_SPEED = 8;
const CHARGE_CONTACT_PADDING = 8;
const FRIENDLY_REST_SPEED = 4;
const HOLD_FACING_TARGET_REPLAN_DISTANCE = 96;
const HOLD_FACING_REEVALUATE_MS = 250;
const HOLD_FACING_IMPROVEMENT_RATIO = 0.12;
// How far a ship standing on its slot steps straight in when it still cannot
// reach the target. Bounded below by the contact distance the plan was built
// with, so this converges rather than walking the hull onto the enemy.
const ATTACK_SLOT_CLOSE_STEP = 48;
// How far behind a ship its own slot may sit before the slot is treated as a
// reversal rather than an approach. A clump is planned at an absolute distance
// from the target, so a ship that is already further forward than the shape
// would otherwise be told to turn round and back into it.
const ATTACK_NO_RETREAT_TOLERANCE = 24;
// A slot whose firing line is blocked by static geometry is walked around its
// own position, on its own side of the clump, in bounded steps. Nothing else
// in the shape moves.
const ATTACK_SLOT_NUDGE_STEP = 48;
const ATTACK_SLOT_NUDGE_ATTEMPTS = 4;
const ATTACK_SLOT_NUDGE_ROUNDS = 2;

function normalizeHullAngle(angle) {
  let normalized = Number(angle) % (Math.PI * 2);
  if (normalized <= -Math.PI) normalized += Math.PI * 2;
  if (normalized > Math.PI) normalized -= Math.PI * 2;
  return normalized;
}

function brakingAcceleration(stats) {
  return driveAcceleration(stats) * BRAKE_ACCEL_RATIO;
}

function momentumRetention(headingError) {
  const beyond = Math.abs(headingError) - MOMENTUM_HOLD_ANGLE;
  if (beyond <= 0) return 1;
  return clampNumber(1 - beyond / (Math.PI - MOMENTUM_HOLD_ANGLE), 0, 1);
}

function turnTowardHeading(ship, desiredHeading, stats, dt) {
  if (!Number.isFinite(desiredHeading)) {
    ship.turnActivity = 0;
    return;
  }
  const before = Number(ship.angle) || 0;
  const difference = angleDifference(before, desiredHeading);
  const rate = directionalTurnRate(stats, before, desiredHeading, ship);
  const maxDelta = rate * dt;
  if (!(maxDelta > 0)) {
    ship.turnActivity = 0;
    return;
  }
  const blend = 1 - Math.exp(-dt / TURN_TIME_CONSTANT_S);
  const step = clampNumber(difference * blend, -maxDelta, maxDelta);
  ship.angle = normalizeHullAngle(before + step);
  ship.turnActivity = Math.abs(difference) < FINAL_FACING_TOLERANCE
    ? 0
    : clampNumber(step / maxDelta, -1, 1);
  applyTurnHeat(ship, ship.turnActivity, dt);
}

function applyManualRotation(ship, stats, dt) {
  const direction = ship.manualRotation === 1 ? 1 : -1;
  const rate = signedTurnRate(stats, direction, ship);
  if (!(rate > 0)) {
    ship.turnActivity = 0;
    return;
  }
  ship.angle = normalizeHullAngle((ship.angle || 0) + direction * rate * dt);
  ship.turnActivity = direction;
  applyTurnHeat(ship, ship.turnActivity, dt);
}

// Full thrust while the nose is roughly on the bearing, tapering to nothing at
// 90 degrees and never applied beyond it. Past a right angle the only useful
// thing an engine can do is stop, so the helm brakes and turns instead.
function alignmentThrottle(headingError) {
  // Tested on the angle rather than the sign of its cosine: cos(PI/2) is not
  // exactly zero in floating point, and "a right angle" has to mean nothing.
  if (!(Math.abs(headingError) < MOMENTUM_HOLD_ANGLE)) return 0;
  return clampNumber(
    Math.cos(headingError) / Math.cos(FULL_THRUST_HEADING_ERROR),
    0,
    1
  );
}

function dampingStep(retention, dt) {
  return Math.pow(retention, dt * DAMPING_REFERENCE_HZ);
}

function forwardDamping(plan) {
  if (!(plan.desiredSpeed > 0)) return ARRIVED_DAMPING;
  return plan.approaching ? APPROACH_DAMPING : TRAVEL_DAMPING;
}

// Drag, split along and across the hull. Along the nose it is deliberately near
// nothing while cruising and strong once parked. Across it, it is what turns
// retained sideways momentum into a settling arc rather than a permanent skid.
// Neither ever zeroes a component outright: a collision slide decays, it is not
// deleted.
function applyMovementDamping(ship, plan, drive, dt) {
  if (!drive) {
    const coast = dampingStep(UNPOWERED_DAMPING, dt);
    ship.vx *= coast;
    ship.vy *= coast;
    return;
  }
  const forwardX = Math.cos(ship.angle || 0);
  const forwardY = Math.sin(ship.angle || 0);
  const lateralX = -forwardY;
  const lateralY = forwardX;
  const forward = ((ship.vx || 0) * forwardX + (ship.vy || 0) * forwardY)
    * dampingStep(forwardDamping(plan), dt);
  const lateral = ((ship.vx || 0) * lateralX + (ship.vy || 0) * lateralY)
    * dampingStep(LATERAL_DAMPING, dt);
  ship.vx = forwardX * forward + lateralX * lateral;
  ship.vy = forwardY * forward + lateralY * lateral;
}

// Momentum-based propulsion: acceleration is ADDED to the velocity the ship
// already carries, along the nose. It is never a velocity rebuilt from the hull
// angle, which is what made a turning ship snap onto its new heading. What comes
// out of a turn here is a curve, and whatever sideways component the turn, a
// shove or a collision left is still there afterwards.
function applyPropulsion(ship, plan, stats, dt) {
  const drive = hasDrive(stats);
  const desiredSpeed = Math.max(0, Number(plan.desiredSpeed) || 0);

  if (drive) {
    const forwardX = Math.cos(ship.angle || 0);
    const forwardY = Math.sin(ship.angle || 0);
    const headingError = Number.isFinite(plan.desiredHeading)
      ? angleDifference(ship.angle || 0, plan.desiredHeading)
      : 0;
    const throttle = alignmentThrottle(headingError);
    const forwardSpeed = (ship.vx || 0) * forwardX + (ship.vy || 0) * forwardY;
    if (throttle > 0 && forwardSpeed < desiredSpeed) {
      const step = Math.min(
        driveAcceleration(stats) * throttle * dt,
        desiredSpeed - forwardSpeed
      );
      ship.vx += forwardX * step;
      ship.vy += forwardY * step;
      applyEngineHeat(ship, throttle, dt);
    }
    // Deceleration acts against travel, not along the hull. A ship pointed away
    // from where it is going therefore sheds speed however it is facing, and no
    // braking case can ever read as thrust that carries it further away.
    const speed = fastHypot(ship.vx, ship.vy);
    if (speed > desiredSpeed && speed > 1e-9) {
      const step = Math.min(brakingAcceleration(stats) * dt, speed - desiredSpeed);
      ship.vx -= (ship.vx / speed) * step;
      ship.vy -= (ship.vy / speed) * step;
    }
  }

  applyMovementDamping(ship, plan, drive, dt);

  // Nothing here constrains the hull against another ship. A ship-to-ship
  // contact is resolved symmetrically, once, by the separation pass after every
  // hull has integrated. Carrying last tick's contact normal into this tick's
  // propulsion treated the other ship as a stationary wall and deleted the
  // velocity a second time -- which stopped two hulls travelling together dead,
  // for a contact that had no closing speed at all. Static geometry is
  // different: an asteroid really is immovable, and resolveMapCollision takes
  // velocity into it out on the spot, per substep.

  const totalSpeed = fastHypot(ship.vx, ship.vy);
  const maximumSpeed = Number(stats.maxSpeed);
  if (Number.isFinite(maximumSpeed) && maximumSpeed > 0 && totalSpeed > maximumSpeed) {
    ship.vx *= maximumSpeed / totalSpeed;
    ship.vy *= maximumSpeed / totalSpeed;
  } else if (!(desiredSpeed > 0) && totalSpeed < REST_SPEED) {
    // Converging on zero asymptotically never arrives, and a ship asked to hold
    // station must actually be still.
    ship.vx = 0;
    ship.vy = 0;
  }
}

function integratePosition(room, ship, dt) {
  const dx = (ship.vx || 0) * dt;
  const dy = (ship.vy || 0) * dt;
  ship.x = (ship.x || 0) + dx;
  ship.y = (ship.y || 0) + dy;
  ship._integratedMovementX = (ship._integratedMovementX || 0) + dx;
  ship._integratedMovementY = (ship._integratedMovementY || 0) + dy;
}

function initializeKinematics(ship) {
  if (!Number.isFinite(ship.x)) ship.x = 0;
  if (!Number.isFinite(ship.y)) ship.y = 0;
  if (!Number.isFinite(ship.vx)) ship.vx = 0;
  if (!Number.isFinite(ship.vy)) ship.vy = 0;
  if (!Number.isFinite(ship.angle)) ship.angle = 0;
  if (!Number.isFinite(ship.targetX)) ship.targetX = ship.x;
  if (!Number.isFinite(ship.targetY)) ship.targetY = ship.y;
}

function sanitizeMovementState(room, ship) {
  const width = room?.world?.width || WORLD.width;
  const height = room?.world?.height || WORLD.height;
  if (!Number.isFinite(ship.x)) ship.x = 0;
  if (!Number.isFinite(ship.y)) ship.y = 0;
  ship.vx = clampNumber(ship.vx, -10000, 10000);
  ship.vy = clampNumber(ship.vy, -10000, 10000);
  ship.angle = normalizeHullAngle(Number(ship.angle) || 0);
  ship.targetX = clampNumber(ship.targetX, 0, width);
  ship.targetY = clampNumber(ship.targetY, 0, height);
}

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

function movementAuthority(room, ship, runtime) {
  const command = runtime.command;
  if (command?.type === "stop") return "stop";
  if (command?.type === "move") {
    if (!runtime.orderComplete) return "move";
    if (engagementTarget(room, ship, runtime)) return "engage";
    const destination = command.destination;
    runtime.destination = destination;
    const displaced = destination
      && fastHypot(destination.x - (ship.x || 0), destination.y - (ship.y || 0))
        > Math.max(ARRIVE_DISTANCE * ARRIVE_LATCH_RATIO, runtime.arrivalRadius || ARRIVE_DISTANCE);
    if (displaced) {
      runtime.orderComplete = false;
      runtime.arrived = false;
      runtime.blocked = false;
      return "move";
    }
    return "position";
  }
  return "engage";
}

function trackedEntity(room, targetId) {
  if (!targetId) return null;
  const entity = room?.ships?.get?.(String(targetId))
    || room?.stationsById?.get?.(String(targetId))
    || null;
  return entity && entity.alive !== false ? entity : null;
}

function engagementTarget(room, ship, runtime) {
  const command = runtime.command;
  if (command?.type === "attack" || command?.type === "repair") {
    const explicit = trackedEntity(room, command.targetId);
    return explicit ? { target: explicit, type: command.type, explicit: true } : null;
  }
  const automatic = trackedEntity(room, ship.combatTargetId);
  return automatic ? { target: automatic, type: "attack", explicit: false } : null;
}

function combatStance(ship) {
  const raw = ship?.combatStyleRaw || ship?.combatStyle;
  if (raw === "sentry") return "sentry";
  return sanitizeCombatStyle(raw);
}

function movementToggles(ship) {
  return ship?.movementToggles || MOVEMENT_TOGGLE_DEFAULTS;
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

function clearRoute(runtime) {
  runtime.destination = null;
  runtime.path = [];
  runtime.waypointIndex = 0;
  runtime.route = null;
}

function clearTargetReferences(ship) {
  ship.focusTargetId = null;
  ship.combatTargetId = null;
  ship.repairTargetId = null;
}

// --- Hold attack clump ------------------------------------------------------
//
// A Hold attack order hands every selected ship one fixed place in a single
// clump anchored on the target (see planAttackFormation). What each hull
// carries is its own offset and the identity of the order that gave it out --
// there is no fleet controller, and no ship reads another ship's slot.

// The clump place this ship still owes the order it is flying. Honoured only
// for the exact target and the exact command it was planned for, so an
// automatically acquired target or a superseded order can never inherit one.
function activeAttackSlot(ship, runtime, target, type) {
  const slot = runtime.attackSlot;
  if (!slot || type !== "attack") return null;
  if (combatStance(ship) !== "hold") return null;
  if (slot.targetId !== String(target.id)) return null;
  if (slot.commandId !== (runtime.command?.id || null)) return null;
  return slot;
}

// A ship standing on its slot that still cannot reach closes the gap itself,
// straight in, keeping the lateral offset that put it on its own side of the
// group. Bounded below by the contact distance the plan was built with, so it
// converges instead of walking the hull onto the enemy.
//
// This is deliberately the ship's own slot and nothing else. Every hull carries
// its own copy of the plan, so "move the whole clump in" was never a thing this
// could do: ships arrive at different times, and each one stepping its private
// copy just deformed the shape by however much each had noticed so far.
function closeAttackSlot(slot) {
  const along = slot.centreDistance + slot.forwardOffset;
  const next = Math.max(Number(slot.minimumCentreDistance) || 0, along - ATTACK_SLOT_CLOSE_STEP);
  if (!(next < along - 1e-6)) return false;
  slot.forwardOffset -= along - next;
  return true;
}

// A Hold attack may take a ship sideways, or closer to its target. It may never
// send it radially backwards.
//
// The planner places one clump at an absolute distance from the enemy, worked
// out from the fleet's centre. Retargeting is where that bites: a ship out in
// front of the group is already past where the new shape is going to be, and
// its nearest free slot is still behind it -- so it would turn round and reverse
// into the formation while the enemy sat in front of it. The same thing happens
// on its own whenever the target closes on the fleet, because the whole clump
// walks backwards with it.
//
// So: if the slot is behind the ship and the ship can already fire from where
// it is, it has a Hold position -- it keeps it, and the slot is released. If it
// cannot fire, the slot keeps its lateral offset and its depth is pulled forward
// to where the hull already is, which turns the order into a sideways move.
//
// Returns false when the slot has been given up in favour of holding here.
function refuseAttackSlotRetreat(room, ship, runtime, slot, target, distance, enter) {
  const point = attackSlotPoint(slot, target);
  // awayX/awayY point from the target back toward the fleet, so a positive
  // projection means the slot lies behind the ship.
  const retreat = (point.x - (ship.x || 0)) * (Number(slot.awayX) || 0)
    + (point.y - (ship.y || 0)) * (Number(slot.awayY) || 0);
  if (retreat <= ATTACK_NO_RETREAT_TOLERANCE) return true;
  if (canEngageFromHere(room, ship, target, "attack", distance, enter)) {
    runtime.attackSlot = null;
    runtime.holdEngaged = true;
    runtime.blocked = false;
    clearRoute(runtime);
    return false;
  }
  slot.forwardOffset -= retreat;
  return true;
}

// On the slot, in range, and a rock is in the way. Walk this one slot around
// its own position -- sideways first, and always on the side of the clump it
// already belongs to -- until the firing line opens. Bounded in both step size
// and number of rounds; nobody else's slot is reconsidered and the shape is
// never rebuilt.
function nudgeAttackSlotIntoFiringLine(room, ship, slot, target, enter) {
  if ((Number(slot.nudges) || 0) >= ATTACK_SLOT_NUDGE_ROUNDS) return false;
  const side = slot.lateralOffset < 0 ? -1 : 1;
  const clearance = navigationClearanceRadius(ship);
  const awayX = Number(slot.awayX) || 0;
  const awayY = Number(slot.awayY) || 0;
  const lateralX = -awayY;
  const lateralY = awayX;
  for (let attempt = 1; attempt <= ATTACK_SLOT_NUDGE_ATTEMPTS; attempt += 1) {
    const shift = attempt * ATTACK_SLOT_NUDGE_STEP;
    for (const candidate of [
      { forward: 0, lateral: side * shift },
      { forward: -shift, lateral: side * shift * 0.5 },
      { forward: shift, lateral: side * shift * 0.5 }
    ]) {
      const forwardOffset = slot.forwardOffset + candidate.forward;
      const lateralOffset = slot.lateralOffset + candidate.lateral;
      const along = slot.centreDistance + forwardOffset;
      const x = (Number(target.x) || 0) + awayX * along + lateralX * lateralOffset;
      const y = (Number(target.y) || 0) + awayY * along + lateralY * lateralOffset;
      if (targetDistanceFrom(x, y, target) > enter) continue;
      const clear = nearestClearPoint(room, x, y, clearance);
      if (!clear.clear || fastHypot(clear.x - x, clear.y - y) > 2) continue;
      if (!firingLineClearFrom(room, x, y, target)) continue;
      slot.forwardOffset = forwardOffset;
      slot.lateralOffset = lateralOffset;
      slot.nudges = (Number(slot.nudges) || 0) + 1;
      return true;
    }
  }
  return false;
}

// Approach control for a ship that owes the order a clump place. Returns true
// while the slot is still in charge of where the ship goes.
//
// The rule that matters is the one at the top: crossing into weapon range is
// NOT arrival. A long-range hull that latched Hold the moment its reticle
// turned red stopped wherever it happened to be, and everything behind it then
// had to get past a parked ship. It keeps flying to its slot.
function followAttackSlot(room, ship, runtime, slot, target, distance, enter, type) {
  // Re-checked every tick, not just when the order was given: the target moves,
  // and the clump hangs off it, so a slot that was ahead of the ship at command
  // time can drift behind it afterwards.
  if (!refuseAttackSlotRetreat(room, ship, runtime, slot, target, distance, enter)) return true;
  runtime.destination = attackSlotPoint(slot, target);
  runtime.blocked = false;
  const reached = fastHypot(
    runtime.destination.x - (ship.x || 0),
    runtime.destination.y - (ship.y || 0)
  ) <= Math.max(ARRIVE_DISTANCE, Number(runtime.arrivalRadius) || ARRIVE_DISTANCE)
    && fastHypot(ship.vx || 0, ship.vy || 0) <= DESTINATION_ARRIVE_SPEED;
  if (!reached) return true;

  if (canEngageFromHere(room, ship, target, type, distance, enter)) {
    // The slot has done its job. From here the ordinary Hold rules own the
    // hull: it stays where it actually is, and weapon facing turns it.
    runtime.holdEngaged = true;
    runtime.attackSlot = null;
    clearRoute(runtime);
    return true;
  }

  // Standing on the slot and still unable to shoot. Either it is a little too
  // far out, or this hull's own line is blocked. Both get one bounded
  // adjustment to this ship's own slot, and neither reshuffles anybody.
  const adjusted = distance > enter
    ? closeAttackSlot(slot)
    : nudgeAttackSlotIntoFiringLine(room, ship, slot, target, enter);
  if (adjusted) {
    runtime.destination = attackSlotPoint(slot, target);
    return true;
  }

  // Nothing left to try from the clump. Release the slot and let the ordinary
  // per-ship Hold approach take it from here.
  runtime.attackSlot = null;
  return false;
}

function refreshEngagement(room, ship, runtime, now) {
  const command = runtime.command;
  const engagement = engagementTarget(room, ship, runtime);
  if (!engagement) {
    if (command?.type === "attack" || command?.type === "repair") {
      setMovementCommand(ship, null);
      clearTargetReferences(ship);
      syncMovementTarget(ship);
    }
    runtime.holdEngaged = false;
    runtime.chargeEngaged = false;
    runtime.blocked = false;
    runtime.attackSlot = null;
    clearRoute(runtime);
    return;
  }

  const { target, type, explicit } = engagement;
  if (explicit) {
    if (type === "attack") {
      ship.focusTargetId = command.targetId;
      ship.combatTargetId = command.targetId;
    } else {
      ship.repairTargetId = command.targetId;
    }
  }

  const toggles = movementToggles(ship);
  if (type !== "repair" && (combatStance(ship) === "static" || (!explicit && !toggles.autoEngage))) {
    runtime.holdEngaged = true;
    runtime.chargeEngaged = false;
    runtime.blocked = false;
    runtime.attackSlot = null;
    clearRoute(runtime);
    return;
  }

  const geometry = engagementGeometry(ship, target);
  const distance = geometry.distance;
  const ranges = engagementRanges(ship, target, type);
  const { enter, resume } = ranges;

  if (type === "attack" && combatStance(ship) === "charge") {
    runtime.holdEngaged = false;
    // Charge never stops at a clump position. It is a contact-seeking stance
    // and the Hold standoff geometry has nothing to say to it.
    runtime.attackSlot = null;
    runtime.arrivalRadius = enter;
    const armed = shipHasArmedProximityCharge(ship);
    if (runtime.chargeEngaged) {
      if (distance <= resume
        && radialSeparationSpeed(ship, target, targetDistanceFrom(ship.x || 0, ship.y || 0, target)) <= CHARGE_PURSUE_SPEED) {
        runtime.blocked = false;
        clearRoute(runtime);
        return;
      }
      runtime.chargeEngaged = false;
    } else if (distance <= enter
      && (armed || Math.abs(radialSeparationSpeed(ship, target, targetDistanceFrom(ship.x || 0, ship.y || 0, target))) <= CHARGE_SETTLE_RADIAL_SPEED)) {
      runtime.chargeEngaged = true;
      runtime.blocked = false;
      clearRoute(runtime);
      return;
    }
    runtime.ramming = armed;
    runtime.blocked = false;
    runtime.destination = { x: Number(target.x) || 0, y: Number(target.y) || 0 };
    return;
  }

  runtime.chargeEngaged = false;
  runtime.ramming = false;
  runtime.arrivalRadius = ARRIVE_DISTANCE;

  // A commanded Hold attack flies to its place in the clump first. Only once
  // the ship is actually standing on it does the ordinary "can I fire from
  // here" test get to latch Hold.
  const slot = activeAttackSlot(ship, runtime, target, type);
  if (slot && followAttackSlot(room, ship, runtime, slot, target, distance, enter, type)) return;

  if (runtime.holdEngaged) {
    const firingLineClear = type !== "attack" || currentFiringLineClear(room, ship, target);
    const chase = toggles.pursue && (distance > resume || !firingLineClear);
    if (!chase) {
      runtime.blocked = false;
      clearRoute(runtime);
      return;
    }
    runtime.holdEngaged = false;
  } else if (canEngageFromHere(room, ship, target, type, distance, enter)) {
    runtime.holdEngaged = true;
    runtime.blocked = false;
    clearRoute(runtime);
    return;
  }

  const standoff = Math.max(0, enter - ARRIVE_DISTANCE);
  const destination = reachableFiringPosition(room, ship, target, runtime, standoff, enter, now);
  runtime.blocked = !destination;
  if (destination) runtime.destination = destination;
  else clearRoute(runtime);
}

function routeClearance(ship) {
  return navigationClearanceRadius(ship);
}

function routeWaypointIndex(runtime) {
  if (!runtime.path?.length) return -1;
  return clampNumber(Math.floor(runtime.waypointIndex) || 0, 0, runtime.path.length - 1);
}

function waypointCaptureRadius(ship) {
  return Math.max(ARRIVE_DISTANCE, routeClearance(ship) * WAYPOINT_CAPTURE_RATIO);
}

function pathRemainingDistance(path, index, x, y) {
  if (!path?.length) return 0;
  const startIndex = clampNumber(Math.floor(Number(index) || 0), 0, Math.max(0, path.length - 1));
  let total = fastHypot(path[startIndex].x - x, path[startIndex].y - y);
  for (let pathIndex = startIndex; pathIndex < path.length - 1; pathIndex += 1) {
    total += fastHypot(
      path[pathIndex + 1].x - path[pathIndex].x,
      path[pathIndex + 1].y - path[pathIndex].y
    );
  }
  return total;
}

function updateRouteProgress(ship, runtime, now) {
  const route = runtime.route;
  if (!route || !runtime.path?.length) return 0;
  const remaining = pathRemainingDistance(runtime.path, routeWaypointIndex(runtime), ship.x, ship.y);
  const previous = Number(route.progressDistance);
  const heading = Math.atan2(
    (runtime.path[routeWaypointIndex(runtime)]?.y ?? ship.y) - ship.y,
    (runtime.path[routeWaypointIndex(runtime)]?.x ?? ship.x) - ship.x
  );
  if (Math.abs(angleDifference(ship.angle || 0, heading)) > ROUTE_TURN_PAUSE_HEADING_ERROR) {
    route.progressDistance = remaining;
    route.progressAt = now;
  } else if (!Number.isFinite(previous) || remaining < previous - ROUTE_PROGRESS_EPSILON) {
    route.progressDistance = remaining;
    route.progressAt = now;
  }
  route.progressAlongRoute = remaining;
  return remaining;
}

function planRoute(room, ship, runtime, destination, now) {
  const clearance = routeClearance(ship);
  let path;
  let reachable = true;
  if (isSegmentClear(room, ship.x, ship.y, destination.x, destination.y, clearance)) {
    path = [{ x: destination.x, y: destination.y }];
  } else {
    const search = searchPathWorld(
      room,
      ship.x,
      ship.y,
      destination.x,
      destination.y,
      clearance,
      { minimumClearance: clearance, preferredClearance: clearance + 24 }
    );
    path = search.waypoints.slice();
    reachable = search.reachedGoal;
    // The search returns its own start point first. Usually that is where the
    // ship already is and dropping it is right -- but when the hull begins
    // inside its navigation padding the search starts from the nearest point it
    // could legally occupy instead, and that point is an escape leg. Discarding
    // it aims the ship at the waypoint beyond, which is exactly the leg the
    // padding says it cannot fly, and it turns, brakes and replans instead.
    if (path.length > 1
      && fastHypot(path[0].x - ship.x, path[0].y - ship.y) <= ROUTE_START_SNAP) {
      path.shift();
    }
    if (!path.length) {
      path = [{ x: ship.x, y: ship.y }];
      reachable = false;
    }
  }
  runtime.path = path;
  runtime.waypointIndex = 0;
  runtime.route = {
    commandId: runtime.command?.id || null,
    destination: { x: destination.x, y: destination.y },
    // Where the first leg starts from. The passed-waypoint test needs the leg a
    // waypoint was approached along, and for the first one that is not another
    // waypoint.
    origin: { x: ship.x, y: ship.y },
    clearance,
    reachable,
    terminal: { ...path[path.length - 1] },
    navigation: ensureRoomNavigation(room),
    plannedAt: now,
    // A route that arrives is only rechecked on the stuck cadence. One that
    // could not reach the destination will be retried once it has been flown
    // out, and there is no point doing that twice a second for a ship parked
    // against a wall that is not going to move.
    replanAt: now + (reachable ? ROUTE_STUCK_MS : ROUTE_UNREACHABLE_RETRY_MS),
    progressDistance: pathRemainingDistance(path, 0, ship.x, ship.y),
    progressAlongRoute: pathRemainingDistance(path, 0, ship.x, ship.y),
    progressAt: now
  };
  runtime.blocked = !reachable;
  bumpMovementMetric("pathReplanCount");
  if (!reachable) bumpMovementMetric("pathUnreachableCount");
}

// Has the hull crossed the plane through this waypoint, perpendicular to the leg
// it was approached along? Under momentum a wide, fast corner can miss the
// capture circle entirely, and a waypoint left behind is reached, not pending.
function waypointPassed(ship, runtime, index) {
  const waypoint = runtime.path[index];
  const previous = index > 0 ? runtime.path[index - 1] : runtime.route?.origin;
  if (!waypoint || !previous) return false;
  const incomingX = waypoint.x - previous.x;
  const incomingY = waypoint.y - previous.y;
  if (fastHypot(incomingX, incomingY) < 1e-6) return false;
  return (ship.x - waypoint.x) * incomingX + (ship.y - waypoint.y) * incomingY > 0;
}

function advanceWaypoints(room, ship, runtime) {
  const path = runtime.path;
  if (!path?.length) return;
  const previousIndex = routeWaypointIndex(runtime);
  let index = previousIndex;
  const capture = waypointCaptureRadius(ship);
  const clearance = runtime.route?.clearance ?? routeClearance(ship);
  while (index < path.length - 1) {
    const captured = fastHypot(ship.x - path[index].x, ship.y - path[index].y) < capture;
    // Skipping a waypoint the ship has flown past is only safe if the leg from
    // where the hull actually is to the next one is clear -- the route was drawn
    // between waypoints, not from wherever the overshoot ended up. When it is
    // not, the waypoint stands and the ship goes back for it.
    const passed = !captured
      && waypointPassed(ship, runtime, index)
      && isSegmentClear(room, ship.x, ship.y, path[index + 1].x, path[index + 1].y, clearance);
    if (!captured && !passed) break;
    index += 1;
    bumpMovementMetric("waypointAdvanceCount");
  }
  runtime.waypointIndex = index;
  if (index !== previousIndex && runtime.route) {
    const remaining = pathRemainingDistance(path, index, ship.x, ship.y);
    runtime.route.progressDistance = remaining;
    runtime.route.progressAlongRoute = remaining;
    runtime.route.progressAt = Number(ship._simNow) || runtime.route.plannedAt;
  }
}

function shortcutWaypoint(room, ship, runtime) {
  const path = runtime.path;
  if (!path?.length) return;
  const index = routeWaypointIndex(runtime);
  if (index >= path.length - 1) return;
  const next = path[index + 1];
  const clearance = runtime.route?.clearance ?? routeClearance(ship);
  if (isSegmentClear(room, ship.x, ship.y, next.x, next.y, clearance)) runtime.waypointIndex = index + 1;
}

function routeRemainingDistance(ship, runtime, destination) {
  if (!runtime.path?.length) return fastHypot(destination.x - ship.x, destination.y - ship.y);
  return pathRemainingDistance(runtime.path, routeWaypointIndex(runtime), ship.x, ship.y);
}

function routeLookaheadDistance(ship) {
  const clearance = routeClearance(ship);
  const speed = fastHypot(ship.vx || 0, ship.vy || 0);
  return clampNumber(
    speed * ROUTE_LOOKAHEAD_SPEED_FACTOR,
    clearance * ROUTE_LOOKAHEAD_MIN_MULTIPLIER,
    clearance * ROUTE_LOOKAHEAD_MAX_MULTIPLIER
  );
}

// A point `distance` along the remaining route from where the ship is now.
function pointAlongRoute(ship, runtime, distance) {
  const path = runtime.path;
  let remaining = Math.max(0, Number(distance) || 0);
  let fromX = ship.x;
  let fromY = ship.y;
  for (let index = routeWaypointIndex(runtime); index < path.length; index += 1) {
    const target = path[index];
    const dx = target.x - fromX;
    const dy = target.y - fromY;
    const length = fastHypot(dx, dy);
    if (length > remaining && length > 1e-6) {
      const ratio = remaining / length;
      return { x: fromX + dx * ratio, y: fromY + dy * ratio };
    }
    remaining -= length;
    fromX = target.x;
    fromY = target.y;
  }
  return { x: fromX, y: fromY };
}

// Steering ahead of the route is what smooths a corner, but only ever toward
// somewhere the hull could actually fly to. Returning a candidate the clearance
// check has already rejected is the same as steering into the obstacle, which
// under retained momentum is a hull scraping the rock rather than a wide miss.
// When nothing along the route is reachable the caller gets null and brakes.
function routeLookaheadPoint(room, ship, runtime, distance) {
  const path = runtime.path;
  if (!path?.length) return null;
  const clearance = runtime.route?.clearance ?? routeClearance(ship);
  const reachable = (point) => point
    && isSegmentClear(room, ship.x, ship.y, point.x, point.y, clearance);
  const candidate = pointAlongRoute(ship, runtime, distance);
  if (reachable(candidate)) return candidate;
  const waypoint = path[routeWaypointIndex(runtime)];
  if (reachable(waypoint)) return { ...waypoint };
  for (const fraction of [0.5, 0.25]) {
    const shorter = pointAlongRoute(ship, runtime, distance * fraction);
    if (reachable(shorter)) return shorter;
  }
  return null;
}

function maxTurnRate(stats) {
  return Math.max(
    Number(stats.turnRateLeft) || 0,
    Number(stats.turnRateRight) || 0,
    Number(stats.turnRate) || 0
  );
}

function cornerSpeedLimit(ship, runtime, stats, lookaheadDistance) {
  const path = runtime.path;
  if (!path?.length) return Infinity;
  const index = routeWaypointIndex(runtime);
  const goal = path[index];
  const next = path[index + 1];
  if (!next) return Infinity;
  const capture = waypointCaptureRadius(ship);
  const distanceToCorner = fastHypot(goal.x - ship.x, goal.y - ship.y);
  if (distanceToCorner > Math.max(capture, Number(lookaheadDistance) || 0)) return Infinity;
  const incoming = Math.atan2(goal.y - ship.y, goal.x - ship.x);
  const outgoing = Math.atan2(next.y - goal.y, next.x - goal.x);
  const turn = Math.abs(angleDifference(incoming, outgoing));
  if (turn < FINAL_FACING_TOLERANCE) return Infinity;
  const rate = maxTurnRate(stats);
  if (!(rate > 0)) return Infinity;
  const atCorner = rate * Math.max(1, capture) / turn;
  const runway = Math.max(0, distanceToCorner - Math.max(1, capture));
  return Math.sqrt(atCorner * atCorner + 2 * brakingAcceleration(stats) * runway);
}

function routeNeedsReplan(room, ship, runtime, destination, now) {
  const route = runtime.route;
  if (!route || !runtime.path?.length) return true;
  if (route.commandId !== (runtime.command?.id || null)) return true;
  if (Math.abs(route.clearance - routeClearance(ship)) > 0.001) return true;
  if (route.navigation !== ensureRoomNavigation(room)) return true;
  if (fastHypot(destination.x - route.destination.x, destination.y - route.destination.y) > ROUTE_REPLAN_DISTANCE) return true;
  if (Number.isFinite(route.replanAt) && now < route.replanAt) {
    updateRouteProgress(ship, runtime, now);
    return false;
  }
  // A route that could not reach the destination is still a route, and a
  // partial one that is carrying the ship somewhere useful must be flown, not
  // reconsidered every half second -- that is what makes a ship dither between
  // two sides of an obstacle. Retry the destination only once the partial route
  // has nothing left to give: its terminal has been reached.
  //
  // The degenerate case is the one that has to be caught. When the search
  // returns nothing at all the fallback route is a single waypoint at the
  // ship's own position, so its terminal is always "reached" and no progress
  // test below could ever fail it. Without this the order would latch blocked
  // for as long as it stood.
  const terminal = route.terminal;
  const flownOut = terminal
    && fastHypot(terminal.x - ship.x, terminal.y - ship.y)
      <= Math.max(route.clearance, ARRIVE_DISTANCE);
  if (route.reachable === false) {
    if (!terminal) return true;
    if (flownOut) return true;
  }
  // The route has been flown out and it does not end where the ship is going.
  // That happens when the destination drifts under the replan threshold -- a
  // Hold clump slot tracking a moving enemy, say. The braking profile is
  // measured along the route, so without this the ship parks at the end of a
  // route that stops short and never closes the last few tens of pixels.
  if (flownOut
    && fastHypot(destination.x - terminal.x, destination.y - terminal.y) > ARRIVE_DISTANCE) return true;
  const index = routeWaypointIndex(runtime);
  const goal = runtime.path[index];
  if (goal && !isSegmentClear(room, ship.x, ship.y, goal.x, goal.y, route.clearance)) {
    const recentContact = Number(ship._staticCollisionLastAt);
    if (Number.isFinite(recentContact) && now - recentContact < ROUTE_STUCK_MS) return false;
    return true;
  }
  const remaining = updateRouteProgress(ship, runtime, now);
  return remaining > route.clearance && now - (route.progressAt ?? now) >= ROUTE_STUCK_MS;
}

function resolveRoute(room, ship, runtime, now) {
  const destination = runtime.destination;
  if (!destination) {
    runtime.path = [];
    runtime.waypointIndex = 0;
    runtime.route = null;
    return false;
  }
  if (routeNeedsReplan(room, ship, runtime, destination, now)) planRoute(room, ship, runtime, destination, now);
  else bumpMovementMetric("pathCacheHitCount");
  shortcutWaypoint(room, ship, runtime);
  return true;
}

function routeView(room, ship, runtime, stats) {
  const destination = runtime.destination;
  if (!destination) return null;
  advanceWaypoints(room, ship, runtime);
  const index = routeWaypointIndex(runtime);
  const goal = index >= 0 && runtime.path[index] ? runtime.path[index] : destination;
  const lookaheadDistance = routeLookaheadDistance(ship);
  const lookahead = routeLookaheadPoint(room, ship, runtime, lookaheadDistance);
  // An intermediate waypoint left more than a right angle behind, which the
  // passed-waypoint test above declined to skip. Carrying speed around it draws
  // a circle: the turn radius at cruise is wider than the capture circle, so the
  // ship sweeps past, comes round, and misses it again. Brake to a speed whose
  // turn radius fits inside that circle, keep steering at the route, and let the
  // throttle come back once the waypoint is ahead again.
  const orbitRisk = index >= 0
    && index < runtime.path.length - 1
    && Math.abs(angleDifference(ship.angle || 0, bearingTo(ship, goal))) > MOMENTUM_HOLD_ANGLE;
  return {
    goal,
    remaining: routeRemainingDistance(ship, runtime, destination),
    lookahead,
    // Nothing along the route can be flown to from here. Steer at the active
    // waypoint and come off the throttle rather than carrying speed toward a
    // point the clearance check has already refused.
    mustBrake: !lookahead,
    orbitLimit: orbitRisk ? maxTurnRate(stats) * waypointCaptureRadius(ship) : Infinity,
    cornerLimit: cornerSpeedLimit(ship, runtime, stats, lookaheadDistance),
    reachable: runtime.route?.reachable !== false,
    terminal: runtime.route?.terminal || destination
  };
}

function restingHeading(ship, command) {
  if (Number.isFinite(command?.finalFacing)) return command.finalFacing;
  return ship.angle || 0;
}

function bearingTo(ship, point) {
  return Math.atan2(point.y - (ship.y || 0), point.x - (ship.x || 0));
}

// How far off the bearing to point the nose so that thrust cancels the sideways
// speed the hull is carrying. atan2 bounds it: a ship sliding much faster than
// it is being asked to travel turns fully across its own drift to kill it, and
// one tracking straight gets no correction at all.
function crabAngle(ship, bearing, referenceSpeed) {
  const crossTrack = (ship.vx || 0) * -Math.sin(bearing) + (ship.vy || 0) * Math.cos(bearing);
  const forward = Math.max(Number(referenceSpeed) || 0, REST_SPEED);
  if (Math.abs(crossTrack) < REST_SPEED) return 0;
  return Math.atan2(-crossTrack, forward);
}

function holdWeaponFacingHeading(room, ship, runtime, target) {
  const now = Number(ship._simNow) || 0;
  const previous = runtime.holdFacing;
  const targetId = String(target.id);
  const targetMoved = previous && previous.targetId === targetId
    ? fastHypot(
      (Number(target.x) || 0) - (Number(previous.targetX) || 0),
      (Number(target.y) || 0) - (Number(previous.targetY) || 0)
    )
    : Infinity;
  const { getHoldWeaponFacingSignature, chooseHoldWeaponFacing } = require("./combat");
  const signature = getHoldWeaponFacingSignature(ship);
  const due = !previous
    || previous.targetId !== targetId
    || previous.signature !== signature
    || targetMoved >= HOLD_FACING_TARGET_REPLAN_DISTANCE
    || now >= (Number(previous.nextEvaluateAt) || 0);
  if (due) {
    const evaluation = chooseHoldWeaponFacing(room, ship, target, now, previous?.heading);
    const currentScore = Number(evaluation?.currentScore) || 0;
    const bestScore = Number(evaluation?.score) || 0;
    const targetChanged = !previous || previous.targetId !== targetId;
    const significantTargetMove = targetMoved >= HOLD_FACING_TARGET_REPLAN_DISTANCE;
    const currentInvalid = currentScore <= 0 && bestScore > 0;
    const materiallyBetter = bestScore > currentScore * (1 + HOLD_FACING_IMPROVEMENT_RATIO);
    if (!previous || targetChanged || significantTargetMove || currentInvalid || materiallyBetter) {
      runtime.holdFacing = {
        targetId,
        targetX: Number(target.x) || 0,
        targetY: Number(target.y) || 0,
        heading: Number.isFinite(Number(evaluation?.heading))
          ? Number(evaluation.heading)
          : bearingTo(ship, targetAttackPointFrom(ship.x || 0, ship.y || 0, target)),
        score: bestScore,
        signature,
        nextEvaluateAt: now + HOLD_FACING_REEVALUATE_MS
      };
    } else {
      previous.score = currentScore;
      previous.signature = signature;
      previous.nextEvaluateAt = now + HOLD_FACING_REEVALUATE_MS;
    }
  }
  return Number.isFinite(Number(runtime.holdFacing?.heading))
    ? runtime.holdFacing.heading
    : bearingTo(ship, targetAttackPointFrom(ship.x || 0, ship.y || 0, target));
}

// Where a ship that has stopped points. A commanded final facing is the resting
// default, not an override: it is what the hull settles on with nothing to
// shoot at. An engagement outranks it, because a formation arriving on its
// heading and then refusing to look at the enemy in front of it is not what the
// heading was for. Either way this is orientation only -- it never moves a ship
// off the point it was sent to.
function stationaryHeading(room, ship, runtime, command) {
  if (combatStance(ship) !== "sentry") {
    const engaged = movementToggles(ship).autoTurn ? engagementTarget(room, ship, runtime) : null;
    if (engaged) {
      if (engaged.type === "attack" && combatStance(ship) === "hold" && runtime.holdEngaged) {
        return holdWeaponFacingHeading(room, ship, runtime, engaged.target);
      }
      const point = targetAttackPointFrom(ship.x || 0, ship.y || 0, engaged.target);
      if (fastHypot(point.x - (ship.x || 0), point.y - (ship.y || 0)) > BEARING_MIN_DISTANCE) {
        return bearingTo(ship, point);
      }
    }
  }
  return restingHeading(ship, command);
}

function restingAgainstCloserFriendly(room, ship, destination) {
  const ownDistance = fastHypot(destination.x - ship.x, destination.y - ship.y);
  if (!Number.isFinite(ownDistance)) return false;
  const ownRadius = physicalCollisionRadius(ship);
  for (const other of room?.ships?.values?.() || []) {
    if (!other || other === ship || other.alive === false || !areEntityAllies(room, ship.ownerId, other)) continue;
    const otherDistance = fastHypot(destination.x - other.x, destination.y - other.y);
    const touching = fastHypot(other.x - ship.x, other.y - ship.y)
      <= ownRadius + physicalCollisionRadius(other) + 2;
    if (touching && otherDistance < ownDistance - 1 && fastHypot(ship.vx, ship.vy) <= FRIENDLY_REST_SPEED) return true;
  }
  return false;
}

function planMovement(room, ship, runtime, stats, route) {
  const command = runtime.command;
  const resting = { desiredHeading: restingHeading(ship, command), desiredSpeed: 0 };
  if (command?.type === "stop") {
    const engaged = movementToggles(ship).autoTurn ? engagementTarget(room, ship, runtime) : null;
    const point = engaged ? targetAttackPointFrom(ship.x, ship.y, engaged.target) : null;
    const distance = point ? fastHypot(point.x - ship.x, point.y - ship.y) : 0;
    return {
      desiredHeading: point && distance > BEARING_MIN_DISTANCE
        ? bearingTo(ship, point)
        : ship.angle || 0,
      desiredSpeed: 0,
      // Still braking while it is still moving, whichever way that is relative
      // to the nose: a hull sliding sideways has not stopped.
      phase: fastHypot(ship.vx || 0, ship.vy || 0) > REST_SPEED ? "braking" : "positioned"
    };
  }

  const destination = runtime.destination;
  if (!destination) {
    const engaged = combatStance(ship) !== "sentry" && movementToggles(ship).autoTurn
      ? engagementTarget(room, ship, runtime)
      : null;
    if (engaged) {
      return {
        desiredHeading: stationaryHeading(room, ship, runtime, command),
        desiredSpeed: 0,
        phase: runtime.blocked ? "blocked" : "positioned"
      };
    }
    return { ...resting, phase: command ? "positioned" : "idle" };
  }

  const arrivalRadius = Math.max(ARRIVE_DISTANCE, Number(runtime.arrivalRadius) || ARRIVE_DISTANCE);
  const arrivalPoint = route?.reachable === false ? route.terminal : destination;
  const distance = fastHypot(arrivalPoint.x - (ship.x || 0), arrivalPoint.y - (ship.y || 0));
  const isMove = command?.type === "move";
  const isCharge = command?.type === "attack" && combatStance(ship) === "charge";
  const canLatch = isMove || isCharge;
  const restingOnFriendly = isMove && distance <= arrivalRadius
    && restingAgainstCloserFriendly(room, ship, destination);

  if (runtime.arrived) {
    if (distance <= Math.max(arrivalRadius * ARRIVE_LATCH_RATIO, arrivalRadius + ARRIVE_DISTANCE)) {
      return {
        desiredHeading: stationaryHeading(room, ship, runtime, command),
        desiredSpeed: 0,
        phase: route?.reachable === false || runtime.blocked ? "blocked" : "positioned"
      };
    }
    runtime.arrived = false;
  }

  // Total speed, not the component along the nose. With retained momentum a
  // hull can be barely moving forwards while sliding hard across itself, and
  // calling that arrived parks the order while the ship coasts off its slot.
  const speed = fastHypot(ship.vx || 0, ship.vy || 0);
  if (canLatch && distance <= arrivalRadius
    && (speed <= DESTINATION_ARRIVE_SPEED || restingOnFriendly)) {
    runtime.arrived = true;
    if (isMove && route?.reachable !== false) runtime.orderComplete = true;
    if (route?.reachable === false) runtime.blocked = true;
    return {
      desiredHeading: stationaryHeading(room, ship, runtime, command),
      desiredSpeed: 0,
      phase: route?.reachable === false ? "blocked" : "positioned"
    };
  }

  const goal = route?.goal || destination;
  const steeringGoal = route?.lookahead || goal;
  const goalDistance = fastHypot(steeringGoal.x - (ship.x || 0), steeringGoal.y - (ship.y || 0));
  const bearing = goalDistance > BEARING_MIN_DISTANCE
    ? bearingTo(ship, steeringGoal)
    : (ship.angle || 0);
  const remainingToEnd = Math.max(0, (route ? route.remaining : distance) - arrivalRadius);
  const safeArrivalSpeed = Math.sqrt(2 * brakingAcceleration(stats) * remainingToEnd);
  const turnRate = maxTurnRate(stats);
  const turnLimit = turnRate > 0 ? turnRate * Math.max(route ? route.remaining : goalDistance, arrivalRadius) : Infinity;
  const ramming = Boolean(runtime.ramming && !runtime.chargeEngaged);
  const effectiveMaxSpeed = Number(stats.maxSpeed) || 0;
  const paperMaxSpeed = Number(ship.stats?.maxSpeed);
  const ownMaxSpeed = Number.isFinite(paperMaxSpeed) && paperMaxSpeed > 0
    ? Math.min(effectiveMaxSpeed, paperMaxSpeed)
    : effectiveMaxSpeed;
  // Nothing along the route can be flown to from here -- the hull has drifted
  // inside its own clearance envelope. Come off the throttle to a speed it can
  // cancel within one arrival distance and keep steering at the active
  // waypoint, which is the direction that opens the gap again. Stopping dead
  // would only park the ship in the pinch it is trying to leave.
  const blockedLimit = route?.mustBrake
    ? Math.sqrt(2 * brakingAcceleration(stats) * ARRIVE_DISTANCE)
    : Infinity;
  const permitted = Math.min(
    ownMaxSpeed,
    ramming ? Infinity : safeArrivalSpeed,
    ramming ? Infinity : turnLimit,
    route ? route.cornerLimit : Infinity,
    route ? route.orbitLimit : Infinity,
    blockedLimit
  );
  // Above a right angle of heading error the ship is asked to shed speed rather
  // than hold it, and the taper stops that becoming a cliff at exactly 90
  // degrees. Below it, momentum is kept: the alignment taper lives in the
  // throttle, so a slight misalignment costs thrust, not the speed already made.
  // The hull carries momentum, so where its nose points and where it is
  // actually going are two different things. Aim off into the ship's own slip:
  // the helm steers by how fast the ship is sliding across the bearing, which
  // is what holds a route through a corner instead of letting the drift carry
  // the hull into the obstacle the route was drawn around.
  const desiredHeading = bearing + crabAngle(ship, bearing, permitted);
  const headingError = angleDifference(ship.angle || 0, desiredHeading);
  const desiredSpeed = permitted * momentumRetention(headingError);
  return {
    desiredHeading,
    desiredSpeed,
    approaching: distance <= APPROACH_DAMPING_DISTANCE,
    phase: desiredSpeed < speed - REST_SPEED ? "braking" : "travelling"
  };
}

function movementStep(room, ship, runtime, stats, routed, dt) {
  const route = routed ? routeView(room, ship, runtime, stats) : null;
  const plan = planMovement(room, ship, runtime, stats, route);
  runtime.desiredHeading = plan.desiredHeading;
  runtime.desiredSpeed = plan.desiredSpeed;
  if (ship.manualRotation) {
    applyManualRotation(ship, stats, dt);
    runtime.phase = plan.phase === "idle" ? "turning" : plan.phase;
  } else {
    turnTowardHeading(ship, plan.desiredHeading, stats, dt);
    runtime.phase = plan.phase;
  }
  applyPropulsion(ship, plan, stats, dt);
  integratePosition(room, ship, dt);
  bumpMovementMetric("staticCollisionSubstepChecks");
  resolveMapCollision(room, ship);
  sanitizeMovementState(room, ship);
}

function updateShipMovement(room, ship, dt, now) {
  if (ship?.launchPhase) {
    ship._simNow = Number.isFinite(Number(now)) ? Number(now) : (ship._simNow || 0);
    ship._collisionCorrectionX = 0;
    ship._collisionCorrectionY = 0;
    ship._staticCollisionCorrectionDistance = 0;
    ship._friendlyCorrectionDistance = 0;
    ship._friendlyPushVelocityAdded = 0;
    ship._integratedMovementX = 0;
    ship._integratedMovementY = 0;
    ship.turnActivity = 0;
    return;
  }
  initializeKinematics(ship);
  const runtime = ensureMovementRuntime(ship);
  ship._collisionCorrectionX = 0;
  ship._collisionCorrectionY = 0;
  ship._staticCollisionCorrectionDistance = 0;
  ship._friendlyCorrectionDistance = 0;
  ship._friendlyPushVelocityAdded = 0;
  ship._integratedMovementX = 0;
  ship._integratedMovementY = 0;
  ship._staticCollisionLastAt = Number.isFinite(Number(ship._staticCollisionLastAt))
    ? ship._staticCollisionLastAt
    : -Infinity;
  ship.turnActivity = 0;
  runtime.ramming = false;

  let safeDt = Number(dt);
  if (!Number.isFinite(safeDt) || safeDt <= 0) return;
  safeDt = Math.min(safeDt, MAX_MOVEMENT_DT);
  ship._simNow = Number.isFinite(Number(now)) ? Number(now) : (ship._simNow || 0);
  const stats = heatAdjustedMovementStats(ship, ship.stats || {});
  bumpMovementMetric("movementCapabilityBuilds");

  const authority = movementAuthority(room, ship, runtime);
  if (authority === "engage") {
    refreshEngagement(room, ship, runtime, ship._simNow);
  } else if (authority === "stop") {
    runtime.holdEngaged = false;
    runtime.chargeEngaged = false;
    runtime.blocked = false;
    runtime.arrivalRadius = ARRIVE_DISTANCE;
    clearRoute(runtime);
  } else if (authority === "position") {
    runtime.holdEngaged = false;
    runtime.chargeEngaged = false;
    runtime.blocked = false;
  }

  // Charge runs straight at its target -- but only while there is a straight
  // run to make. With a rock or a station between the two, driving at the
  // bearing grinds the hull along the obstacle for as long as the order stands,
  // so it takes the ordinary static route instead and drops back to closing
  // directly the moment the last leg is clear.
  const charging = runtime.command?.type === "attack" && combatStance(ship) === "charge";
  const directCharge = charging
    && (!runtime.destination
      || isSegmentClear(
        room,
        ship.x,
        ship.y,
        runtime.destination.x,
        runtime.destination.y,
        routeClearance(ship)
      ));
  const routed = runtime.destination && !directCharge
    ? resolveRoute(room, ship, runtime, ship._simNow)
    : false;
  if (directCharge && runtime.path?.length) {
    runtime.path = [];
    runtime.waypointIndex = 0;
    runtime.route = null;
  }
  if (!routed && runtime.path?.length) {
    runtime.path = [];
    runtime.waypointIndex = 0;
    runtime.route = null;
  }
  const steps = Math.max(1, Math.ceil(safeDt / MOVEMENT_SUBSTEP - 1e-9));
  const stepDt = safeDt / steps;
  for (let index = 0; index < steps; index += 1) {
    bumpMovementMetric("sharedControllerRuns");
    movementStep(room, ship, runtime, stats, routed, stepDt);
  }
  syncMovementTarget(ship);
}

function updateShipSeparation(room, ships, dt, now = 0) {
  return resolveShipSeparation(room, ships, dt, now);
}

function sharedArrivalRadius(ships) {
  const living = (ships || []).filter((ship) => ship?.alive !== false);
  if (living.length <= 1) return ARRIVE_DISTANCE;
  let largest = 0;
  let sumSquares = 0;
  for (const ship of living) {
    const radius = physicalCollisionRadius(ship);
    largest = Math.max(largest, radius);
    sumSquares += radius * radius;
  }
  return Math.max(largest * 1.5, Math.sqrt(sumSquares) * 1.2);
}

function issueMove(ship, commandId, destination, options = {}) {
  clearTargetReferences(ship);
  ship.commandMode = "move";
  setMovementCommand(ship, {
    id: `${commandId}:${ship.id}`,
    type: "move",
    destination: { x: destination.x, y: destination.y },
    formation: options.formation,
    arrivalRadius: options.arrivalRadius,
    finalFacing: options.finalFacing,
    manual: options.manual
  });
  syncMovementTarget(ship);
}

function issueStop(ship, commandId, manual = true) {
  setMovementCommand(ship, { id: `${commandId}:${ship.id}`, type: "stop", manual });
  syncMovementTarget(ship);
}

function issueAttack(room, ship, commandId, targetId, now, slot = null) {
  const target = trackedEntity(room, targetId);
  const viewerTeam = room?.players?.get?.(ship.ownerId)?.team ?? ship.team ?? ship.ownerId;
  clearTargetReferences(ship);
  if (target && room && !canTeamTargetEntity(room, viewerTeam, target, now)) return false;
  ship.combatTargetId = targetId;
  ship.focusTargetId = targetId;
  const id = `${commandId}:${ship.id}`;
  setMovementCommand(ship, {
    id,
    type: "attack",
    targetId,
    manual: true
  });
  const runtime = ensureMovementRuntime(ship);
  runtime.arrivalRadius = ARRIVE_DISTANCE;
  if (slot && target) {
    // The ship owes the order a place in the clump. Deliberately no early Hold
    // latch on range alone: a hull that happens to already be in range must
    // still take up its position rather than parking in front of the ships
    // behind it.
    runtime.attackSlot = {
      targetId: String(targetId),
      assignedShipId: String(ship.id),
      commandId: id,
      forwardOffset: slot.forwardOffset,
      lateralOffset: slot.lateralOffset,
      awayX: slot.awayX,
      awayY: slot.awayY,
      centreDistance: slot.centreDistance,
      minimumCentreDistance: slot.minimumCentreDistance,
      nudges: 0
    };
    // The exception, and it is not about range: a ship already further forward
    // than its own slot is being asked to reverse, not to approach. Retargeting
    // is where that happens -- the new clump is planned around the fleet centre,
    // and whoever was out in front is past it before the order is even given.
    refuseAttackSlotRetreat(
      room,
      ship,
      runtime,
      runtime.attackSlot,
      target,
      engagementGeometry(ship, target).distance,
      engagementRanges(ship, target, "attack").enter
    );
  } else if (target && combatStance(ship) !== "charge") {
    const distance = engagementGeometry(ship, target).distance;
    if (distance <= engagementRanges(ship, target, "attack").enter
      && currentFiringLineClear(room, ship, target)) runtime.holdEngaged = true;
  }
  syncMovementTarget(ship);
  return true;
}

// Which selected ships take a place in the attack clump. Only the stances that
// actually stop at a firing position do: Charge is pursuing contact, and
// Static/Sentry never leave where they are.
function takesAttackSlot(ship) {
  return combatStance(ship) === "hold";
}

// One clump per Hold attack order, planned once, on the near side of the
// target. The whole shape is placed by the shortest usable weapon range in the
// selection measured against its own rear-most slot, so a short-ranged hull at
// the back is still able to fire when it gets there -- rather than being sent
// forward on its own through the ships in front of it.
function planHoldApproach(room, ships, target) {
  const holders = ships.filter(takesAttackSlot);
  if (!holders.length) return null;
  return planAttackFormation(room, holders, target, {
    holdRange: (ship) => ({
      range: engagementRanges(ship, target, "attack").enter,
      // An unarmed hull still gets a slot -- at the back, like any other ship
      // that started furthest away -- but its (nominal) range does not drag the
      // clump onto the target, and reaching its slot never claims it can fire.
      armed: shipHasOffensiveWeapon(ship)
    })
  });
}

function issueRepair(ship, commandId, targetId) {
  clearTargetReferences(ship);
  ship.repairTargetId = targetId;
  setMovementCommand(ship, { id: `${commandId}:${ship.id}`, type: "repair", targetId, manual: true });
  syncMovementTarget(ship);
}

function commandShips(room, player, x, y, options = {}) {
  const selected = selectOwnedLivingShips(player, options.shipIds);
  if (!selected.ok) return { ok: false, code: selected.code, commanded: 0 };
  const ships = selected.ships;
  if (ships.length === 0) return { ok: true, code: "none", commanded: 0 };

  const clicked = options.targetId == null
    ? null
    : (room.ships?.get(String(options.targetId)) || room.stationsById?.get(String(options.targetId)));
  const livingTarget = clicked?.alive ? clicked : null;
  const selectedIds = new Set(ships.map((ship) => ship.id));
  const enemy = livingTarget && areEntityEnemies(room, player?.id, livingTarget);
  const ally = livingTarget
    && !selectedIds.has(livingTarget.id)
    && areEntityAllies(room, player?.id, livingTarget);
  const commandId = nextMovementCommandId(room, enemy ? "a" : (ally ? "r" : "m"));

  if (enemy) {
    const now = gameplayNow(room);
    const plan = planHoldApproach(room, ships, livingTarget);
    const slotByShipId = new Map((plan?.slots || []).map((slot) => [slot.shipId, {
      forwardOffset: slot.forwardOffset,
      lateralOffset: slot.lateralOffset,
      awayX: plan.awayX,
      awayY: plan.awayY,
      centreDistance: plan.centreDistance,
      minimumCentreDistance: plan.minimumCentreDistance
    }]));
    for (const ship of ships) {
      issueAttack(room, ship, commandId, livingTarget.id, now, slotByShipId.get(ship.id) || null);
    }
    return { ok: true, code: "attack", commanded: ships.length, attackPlan: plan };
  }
  if (ally) {
    for (const ship of ships) issueRepair(ship, commandId, livingTarget.id);
    return { ok: true, code: "repair", commanded: ships.length };
  }

  // An ordinary move order is the one place a formation is resolved. Each ship
  // leaves here with its own fixed destination and is on its own from then on:
  // combat orders below never see a slot, and nothing recomputes the shape while
  // the order runs.
  const plan = planFormation(room, ships, {
    x,
    y,
    formation: options.formation,
    direction: options.direction
  });
  for (const slot of plan.slots) {
    issueMove(slot.ship, commandId, { x: slot.x, y: slot.y }, {
      // Every ship has its own slot, so the shared crowding envelope that a
      // single stacked destination needed would only stop ships short of it.
      arrivalRadius: ARRIVE_DISTANCE,
      // A formation that arrives pointing every which way is not a formation.
      // Absent an explicit heading, the shape's own direction of travel is the
      // one they all end on. Automatic combat facing may still turn a parked
      // hull afterwards; that changes orientation, never position.
      finalFacing: Number.isFinite(options.finalFacing) ? options.finalFacing : plan.direction,
      manual: true,
      formation: {
        type: plan.formation,
        centreX: plan.x,
        centreY: plan.y,
        direction: plan.direction,
        offsetX: slot.offsetX,
        offsetY: slot.offsetY,
        adjusted: slot.adjusted
      }
    });
  }
  return {
    ok: true,
    code: "move",
    commanded: plan.slots.length,
    formation: plan.formation,
    plan
  };
}

function commandShipsToDestination(room, ships, destination, options = {}) {
  const commandId = nextMovementCommandId(room, options.prefix || "m");
  const living = (ships || []).filter((ship) => ship?.alive);
  if (!living.length || !destination) return 0;
  const arrivalRadius = sharedArrivalRadius(living);
  for (const ship of living) {
    issueMove(ship, commandId, destination, {
      arrivalRadius,
      finalFacing: options.finalFacing,
      manual: false
    });
  }
  return living.length;
}

function stopShips(room, player, shipIds) {
  const selected = selectOwnedLivingShips(player, shipIds);
  if (!selected.ok) return { ok: false, code: selected.code, commanded: 0 };
  const commandId = nextMovementCommandId(room, "s");
  for (const ship of selected.ships) issueStop(ship, commandId);
  return { ok: true, code: "stop", commanded: selected.ships.length };
}

function rotateShips(room, player, options) {
  const selected = selectOwnedLivingShips(player, options?.shipIds);
  if (!selected.ok) return { ok: false, code: selected.code, commanded: 0 };
  const direction = options?.direction;
  const active = options?.active;
  for (const ship of selected.ships) setManualRotation(ship, active ? direction : null);
  return { ok: true, code: "rotate", commanded: selected.ships.length };
}

function applyCombatStyle(ship, combatStyle) {
  ship.combatStyle = combatStyle;
  ship.combatStyleRaw = combatStyle;
  const runtime = ensureMovementRuntime(ship);
  runtime.holdFacing = null;
  runtime.holdEngaged = false;
  runtime.chargeEngaged = false;
  runtime.ramming = false;
}

function applyMovementToggles(ship, toggles) {
  ship.movementToggles = sanitizeMovementToggles(toggles, ship.movementToggles);
  return ship.movementToggles;
}

module.exports = {
  ATTACK_NO_RETREAT_TOLERANCE,
  FORMATION_TYPES,
  SUPPORTED_MOVEMENT_TYPES,
  alignmentThrottle,
  applyCombatStyle,
  attackSlotPoint,
  applyMovementToggles,
  applyPropulsion,
  commandShips,
  commandShipsToDestination,
  createMovementRuntime,
  integratePosition,
  maxFriendlyCorrectionPerTick,
  navigationClearanceRadius,
  nearestClearPoint: require("./movementNavigation").nearestClearPoint,
  physicalCollisionRadius,
  planAttackFormation,
  planFormation,
  planMovement,
  resolveFleetMapCollisions,
  resolveMapCollision,
  resolveSeparationPair,
  rotateShips,
  sanitizeFormationType,
  segmentCircleClearance,
  separationRadius,
  sharedArrivalRadius,
  stopShips,
  turnTowardHeading,
  updateShipMovement,
  updateShipSeparation
};
