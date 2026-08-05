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
  HOLD_COVERAGE_STANDOFF_STEP,
  HOLD_RANGE_RATIO,
  HOLD_RESUME_RATIO,
  LATERAL_DAMPING,
  MAX_MOVEMENT_DT,
  ORBIT_AVOIDANCE_MARGIN,
  ORBIT_AVOIDANCE_MAX_STEPS,
  ORBIT_AVOIDANCE_MIN_STEPS,
  ORBIT_AVOIDANCE_REACTION_TIME,
  ORBIT_AVOIDANCE_REPLAN_MS,
  ORBIT_AVOIDANCE_RETRY_MS,
  ORBIT_AVOIDANCE_SCAN_MS,
  ORBIT_AVOIDANCE_ROUTE_PAD,
  ORBIT_AVOIDANCE_STEP_LENGTH,
  ORBIT_AVOIDANCE_TARGET_MOVE,
  ORBIT_BRAKING_PROBE_STEPS,
  ORBIT_CONTACT_PADDING,
  ORBIT_CORRECTION_BAND,
  ORBIT_LOOKAHEAD_DISTANCE,
  ORBIT_PINCH_ESCAPE_SPEED,
  ORBIT_PINCH_HULL_MARGIN,
  ORBIT_RADIAL_GAIN,
  ORBIT_RANGE_RATIO,
  ORBIT_REJOIN_ARCS,
  ORBIT_REJOIN_HEADING_TOLERANCE,
  ORBIT_REJOIN_RADIAL_TOLERANCE,
  ORBIT_REVERSAL_HEADING_TOLERANCE,
  ORBIT_REVERSAL_SPEED,
  ORBIT_TURN_MARGIN,
  REPAIR_STANDOFF_PAD,
  REST_SPEED,
  TRAVEL_DAMPING,
  UNPOWERED_DAMPING
} = require("./movementTuning");
const { getMaxEffectiveWeaponRange, shipHasArmedProximityCharge } = require("./componentData");
const {
  MOVEMENT_TOGGLE_DEFAULTS,
  ORBIT_DIRECTION,
  sanitizeCombatStyle,
  sanitizeMovementToggles,
  sanitizeOrbitDirection
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
const { planFormation } = require("./movementFormations");

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
// How much of a lane's firing range may be spent on sideways offset. The rest
// is depth, so even the outermost ship in a very wide fleet still closes on the
// target rather than sliding along beside it.
const LANE_LATERAL_LIMIT = 0.9;

// combat.js requires movement, so movement cannot require it at load time. The
// resolution is memoised rather than repeated per call: these are per-ship,
// per-tick paths, and a require() on each one is string work for a cache hit.
let combatModule = null;
function combat() {
  if (!combatModule) combatModule = require("./combat");
  return combatModule;
}

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
    contact,
    enter,
    resume: Math.max(contact, reach * HOLD_RESUME_RATIO)
  };
}

function canEngageFromHere(room, ship, target, type, distance, enter) {
  if (distance > enter) return false;
  return type !== "attack" || currentFiringLineClear(room, ship, target);
}

// How much further the hull has to come before the guns -- not the hull centre
// -- are in range of the target.
//
// The range gate above is centre-to-centre against the longest weapon envelope,
// but a gun fires from its own mount. On a long hull the mounts on the far side
// of the target sit most of a hundred pixels behind the centre, so a ship that
// stops the moment its centre is inside the envelope leaves those guns short and
// fights with half its battery. Nothing in the hold logic noticed, because
// nothing in it ever asked a gun anything.
//
// Measured at the heading the ship intends to hold, since rotating the hull is
// what moves the mounts. Zero means every gun of the main battery reaches from
// where it is standing.
function holdCoverageShortfall(room, ship, runtime, target, now) {
  if (combatStance(ship) !== "hold") return 0;
  const heading = holdWeaponFacingHeading(room, ship, runtime, target);
  const coverage = combat().evaluateHoldWeaponCoverage(room, ship, target, heading, now);
  const shortfall = Number(coverage?.shortfall) || 0;
  return shortfall > 0 ? shortfall : 0;
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

// --- Hold attack lanes ------------------------------------------------------
//
// Clicking an enemy does not arrange anything. Every selected ship takes the
// target, starts shooting the moment a weapon bears, and stops at the first
// place it can fire from -- a ship already in range simply brakes where it
// stands. An attack order that first made the fleet assemble into a shape got
// ships killed while they were busy tidying up.
//
// The one thing that is planned is the DIRECTION of the advance. Sending every
// hull at the target's own position funnels the fleet into a queue behind
// whoever gets there first, so each ship keeps the lateral place in the group
// it already had and closes along its own lane, roughly parallel to its
// neighbours. That is a spread, not a formation: nothing waits for it, nothing
// holds a ship to it, and it is abandoned the moment the ship can shoot.

// This ship's lane, honoured only for the exact target and the exact command it
// was planned for -- an automatically acquired target never inherits one.
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

// --- Orbit ------------------------------------------------------------------
//
// Orbit is a travelling stance and shares nothing with Hold. It never latches,
// never stops, and is never given a position by anything above it: each ship
// orbits from the angular position it already has, which is what preserves
// whatever spacing the group already had without a formation controller ever
// being involved.
//
// The controller is a tangent plus a radial correction, turned into a virtual
// aim point a fixed distance ahead. That point is recomputed from the hull's
// own position every tick and is never reached, so the ship flies a continuous
// spiral onto the radius instead of a sequence of go-there-and-stop hops.

// The direction of travel at a point on the circle, given the outward radial
// unit vector from the target to the ship.
//
// Screen y increases DOWNWARD, so this is not the textbook rotation matrix and
// the check that it is right is geometric, not algebraic: on the right-hand
// side of the target the outward radial is (+1, 0), and clockwise there must
// send the ship down the screen, so the tangent must be (0, +1) -- which is
// (-radialY, radialX). Anticlockwise is its negation.
function orbitTangent(radialX, radialY, direction) {
  if (direction === ORBIT_DIRECTION.CLOCKWISE) return { x: -radialY, y: radialX };
  return { x: radialY, y: -radialX };
}

// The ship owns its direction; the runtime copy is a mirror the steering reads.
// Taking the ship's as authoritative here is what makes a hull that was given a
// direction before it had a movement runtime -- a fresh spawn, a reconnect --
// fly the direction it was actually given rather than the runtime's default.
function orbitDirectionOf(ship, runtime) {
  const direction = sanitizeOrbitDirection(ship.orbitDirection, runtime.orbitDirection);
  runtime.orbitDirection = direction;
  return direction;
}

// The standoff Orbit flies at, measured the same way engagementGeometry measures
// distance -- to the hull for a ship, to the surface for a station.
//
// It is the main battery's own reach with a margin taken off, not the longest
// envelope on the hull: a ship circling at the outer edge of its best gun drops
// every other gun out of the fight. The contact floor below it is the only thing
// that may raise it, and it exists so a short-ranged brawler orbits around its
// target rather than through it.
function orbitStandoff(ship, target) {
  const battery = Number(combat().mainBatteryOrbitRange(ship)) || 0;
  const reach = battery > 0 ? battery : getMaxEffectiveWeaponRange(ship);
  const contact = engagementGeometry(ship, target).contact + ORBIT_CONTACT_PADDING;
  return Math.max(contact, reach * ORBIT_RANGE_RATIO);
}

// How far from the target centre the orbit circle sits. Rebuilt through
// engagementGeometry's own measure so a station's surface offset is included,
// exactly as the radial error is; for a ship the skin term is zero.
function orbitCircleRadius(ship, target, standoff) {
  const skin = fastHypot((Number(target.x) || 0) - (ship.x || 0), (Number(target.y) || 0) - (ship.y || 0))
    - engagementGeometry(ship, target).distance;
  return Math.max(1, skin + standoff);
}

// A point on the orbit circle, `arc` radians around from where the ship is now
// in its own direction of travel.
function orbitCirclePoint(ship, target, radialX, radialY, standoff, direction, arc) {
  const angle = Math.atan2(radialY, radialX) + arc * direction;
  const radius = orbitCircleRadius(ship, target, standoff);
  return {
    x: (Number(target.x) || 0) + Math.cos(angle) * radius,
    y: (Number(target.y) || 0) + Math.sin(angle) * radius
  };
}

// --- Orbit obstacle avoidance -----------------------------------------------
//
// Three states, and the middle one is a commitment:
//
//   direct  -- live tangent + radial steering, watching far enough ahead to
//     |        still have somewhere to turn when something appears
//   detour  -- routed round the obstacle to a fixed point on the circle, held
//     |        until there is a clear run back to that point
//   rejoin  -- clear run in hand, flying back onto the radius and the tangent
//     |
//   direct
//
// The commitment is the whole of the fix. The first version re-tested only the
// short moving aim point and dropped its detour the moment that looked clear --
// which happened as soon as the hull had turned a few degrees. Live steering
// took over, pulled straight back toward the target, and drove the ship into
// the side of the obstacle it was halfway around; the hull ground along the
// rock for the whole lap while the collision resolver quietly pushed it out
// again. Nothing in `detour` consults the aim point at all.

// How far ahead the ship has to see.
//
// Braking distance plus a reaction allowance plus the navigation envelope is
// what it takes to STOP -- and a horizon of exactly that length means the ship
// only ever notices an obstacle at the moment it must begin an emergency stop.
// That is what the first version did, and it is why every encounter ended with
// the hull scraping the rock: it was always braking, never steering.
//
// The margin buys the distance to go around instead. An orbit is a closed path
// through static geometry, so an obstacle sitting on the circle will be reached
// sooner or later whatever happens; seeing it early costs nothing and turns a
// panic stop into a course change.
function orbitAvoidanceLookahead(ship, stats) {
  const speed = fastHypot(ship.vx || 0, ship.vy || 0);
  const deceleration = Math.max(1, brakingAcceleration(stats));
  const brakingDistance = speed * speed / (2 * deceleration);
  const stoppingDistance = brakingDistance
    + speed * ORBIT_AVOIDANCE_REACTION_TIME
    + routeClearance(ship) * 2;
  return Math.max(ORBIT_LOOKAHEAD_DISTANCE, stoppingDistance * ORBIT_AVOIDANCE_MARGIN);
}

// The path the ship is actually about to fly, as a short polyline.
//
// Sampled by stepping the same tangent-plus-correction field the steering uses,
// recomputed at each projected point, so the samples follow the curve -- both
// the circle itself and the spiral onto it. A single straight sweep along the
// current tangent would miss obstacles on the inside of the turn and invent
// ones on the outside, and either error costs a ship: the first a collision,
// the second a detour around nothing.
//
// Writes into a caller-owned array; this runs per orbiting ship per tick.
//
// The number of chords follows the length rather than being fixed, so a long
// horizon is not sampled so coarsely that the chords cut the corner off the arc
// and miss what is sitting on it.
function orbitPredictedPath(ship, target, standoff, direction, distance, out) {
  const points = out;
  points.length = 0;
  const centreX = Number(target.x) || 0;
  const centreY = Number(target.y) || 0;
  const radius = orbitCircleRadius(ship, target, standoff);
  const steps = clampNumber(
    Math.ceil(distance / ORBIT_AVOIDANCE_STEP_LENGTH),
    ORBIT_AVOIDANCE_MIN_STEPS,
    ORBIT_AVOIDANCE_MAX_STEPS
  );
  const step = Math.max(1, distance / steps);
  let x = ship.x || 0;
  let y = ship.y || 0;
  for (let index = 0; index < steps; index += 1) {
    let dx = x - centreX;
    let dy = y - centreY;
    let length = fastHypot(dx, dy);
    if (!(length > BEARING_MIN_DISTANCE)) {
      dx = Math.cos(ship.angle || 0);
      dy = Math.sin(ship.angle || 0);
      length = 1;
    }
    const radialX = dx / length;
    const radialY = dy / length;
    const tangent = orbitTangent(radialX, radialY, direction);
    const correction = clampNumber((length - radius) / ORBIT_CORRECTION_BAND, -1, 1);
    let desiredX = tangent.x - radialX * correction * ORBIT_RADIAL_GAIN;
    let desiredY = tangent.y - radialY * correction * ORBIT_RADIAL_GAIN;
    const desiredLength = fastHypot(desiredX, desiredY);
    if (desiredLength > 1e-6) {
      desiredX /= desiredLength;
      desiredY /= desiredLength;
    } else {
      desiredX = tangent.x;
      desiredY = tangent.y;
    }
    x += desiredX * step;
    y += desiredY * step;
    points.push({ x, y });
  }
  return points;
}

// Walk the predicted path and report how far along it the ship may fly before
// it stops being flyable. Infinity means the whole sweep is clear.
//
// Both asteroids and station collision pieces come out of isSegmentClear, which
// is the shared navigation authority: nothing here approximates a station as a
// circle or measures against its artwork.
function orbitPathClearDistance(room, ship, path) {
  const clearance = routeClearance(ship);
  let travelled = 0;
  let fromX = ship.x || 0;
  let fromY = ship.y || 0;
  for (const point of path) {
    if (!isSegmentClear(room, fromX, fromY, point.x, point.y, clearance)) return travelled;
    travelled += fastHypot(point.x - fromX, point.y - fromY);
    fromX = point.x;
    fromY = point.y;
  }
  return Infinity;
}

// The fastest this hull may travel and still be able to stop before the static
// geometry directly in front of it.
//
// Measured along the ship's actual velocity, not its intended heading: momentum
// is the thing that puts a hull into a rock its route went around. Infinity
// means nothing is in the way within stopping distance.
//
// The free distance is found by halving rather than by marching, so a long
// sweep costs a bounded handful of segment checks; each is exact geometry
// against asteroids and station pieces via the shared navigation authority.
function orbitBrakingCeiling(room, ship, stats) {
  const speed = fastHypot(ship.vx || 0, ship.vy || 0);
  if (!(speed > REST_SPEED)) return Infinity;
  const clearance = routeClearance(ship);
  const deceleration = Math.max(1, brakingAcceleration(stats));
  const reach = speed * speed / (2 * deceleration) + speed * ORBIT_AVOIDANCE_REACTION_TIME;
  if (!(reach > 1)) return Infinity;
  const unitX = (ship.vx || 0) / speed;
  const unitY = (ship.vy || 0) / speed;
  const clearFor = (distance, margin = clearance) => isSegmentClear(
    room,
    ship.x,
    ship.y,
    (ship.x || 0) + unitX * distance,
    (ship.y || 0) + unitY * distance,
    margin
  );
  // The hull has drifted inside its own clearance envelope, so "distance until
  // blocked" is zero by construction. Two very different situations produce
  // that reading and they need opposite answers:
  //
  //   still moving  -- the ship is arriving at the obstacle. Brake, hard. An
  //                    earlier version handed back a generous allowance here,
  //                    which released the brakes at the exact moment the ship
  //                    was a few pixels short of contact and drove it in.
  //   at a crawl    -- the ship is parked alongside and needs to leave. A
  //                    ceiling of zero is a trap: it cancels the very velocity
  //                    that would carry it out, so the hull sits against the
  //                    rock for the rest of the match. Allow a crawl and let
  //                    the route steer it back into open space.
  //
  // The crawl is also what would otherwise eat the margin: the planning
  // envelope is comfortably wider than the hull, so a ship that stopped at the
  // edge of it still had room to creep most of the way to the rock before
  // anything objected. So the crawl is offered only while the HULL itself --
  // not the padded envelope -- has somewhere to go. Refused, the ship brakes to
  // a standstill, the route turns its nose away, and the crawl is offered again
  // the moment it is pointing somewhere that is actually open.
  if (!clearFor(0)) {
    if (speed > ORBIT_PINCH_ESCAPE_SPEED) return 0;
    const crawlStop = ORBIT_PINCH_ESCAPE_SPEED * ORBIT_PINCH_ESCAPE_SPEED / (2 * deceleration);
    const hullMargin = physicalCollisionRadius(ship) + ORBIT_PINCH_HULL_MARGIN;
    return clearFor(crawlStop + ORBIT_PINCH_HULL_MARGIN, hullMargin)
      ? ORBIT_PINCH_ESCAPE_SPEED
      : 0;
  }
  if (clearFor(reach)) return Infinity;
  let low = 0;
  let high = reach;
  for (let step = 0; step < ORBIT_BRAKING_PROBE_STEPS; step += 1) {
    const middle = (low + high) / 2;
    if (clearFor(middle)) low = middle;
    else high = middle;
  }
  return Math.sqrt(2 * deceleration * Math.max(0, low));
}

// Where to come back onto the circle.
//
// Candidates are placed progressively further round in the ship's OWN direction
// of travel -- avoidance never reverses a player's C/AC choice to make its own
// life easier. Each has to be somewhere the hull could sit, and reachable at
// full navigation clearance either directly or through the shared static route
// search. The list is in ascending arc order and the first valid candidate
// wins, so the choice is deterministic and is the least deviation that actually
// works; a large station simply pushes it further round rather than needing a
// different rule.
function chooseOrbitRejoinPoint(room, ship, target, radialX, radialY, standoff, direction) {
  const clearance = routeClearance(ship);
  for (const arc of ORBIT_REJOIN_ARCS) {
    const candidate = orbitCirclePoint(ship, target, radialX, radialY, standoff, direction, arc);
    const clear = nearestClearPoint(room, candidate.x, candidate.y, clearance);
    // It has to be usable roughly where it was asked for. A "nearest clear
    // point" dragged far off the circle is not a rejoin point.
    if (!clear.clear || fastHypot(clear.x - candidate.x, clear.y - candidate.y) > clearance) continue;
    if (!isSegmentClear(room, ship.x, ship.y, clear.x, clear.y, clearance)) {
      const search = searchPathWorld(room, ship.x, ship.y, clear.x, clear.y, clearance, {
        minimumClearance: clearance,
        preferredClearance: clearance + 24
      });
      if (!search.reachedGoal) continue;
    }
    return { x: clear.x, y: clear.y, arc };
  }
  return null;
}

function orbitAvoidanceStale(avoidance, target, direction, now) {
  if (!avoidance) return true;
  if (avoidance.targetId !== String(target.id)) return true;
  if (avoidance.direction !== direction) return true;
  if (now >= (Number(avoidance.replanAt) || 0)) return true;
  return fastHypot(
    (Number(target.x) || 0) - avoidance.targetX,
    (Number(target.y) || 0) - avoidance.targetY
  ) > ORBIT_AVOIDANCE_TARGET_MOVE;
}

// Commit to a manoeuvre. Failing to find anywhere to rejoin does NOT drop back
// to live steering -- that is the state that flies into the obstacle. It keeps
// whatever manoeuvre is already running and retries at a bounded rate.
function planOrbitAvoidance(room, ship, runtime, target, radialX, radialY, standoff, direction, now) {
  const rejoin = chooseOrbitRejoinPoint(room, ship, target, radialX, radialY, standoff, direction);
  const existing = runtime.orbitAvoidance;
  if (!rejoin) {
    if (existing && existing.rejoin) {
      existing.replanAt = now + ORBIT_AVOIDANCE_RETRY_MS;
      return existing;
    }
    runtime.orbitAvoidance = {
      phase: "detour",
      targetId: String(target.id),
      targetX: Number(target.x) || 0,
      targetY: Number(target.y) || 0,
      direction,
      rejoin: null,
      plannedAt: now,
      replanAt: now + ORBIT_AVOIDANCE_RETRY_MS
    };
    return runtime.orbitAvoidance;
  }
  runtime.orbitAvoidance = {
    phase: "detour",
    targetId: String(target.id),
    targetX: Number(target.x) || 0,
    targetY: Number(target.y) || 0,
    direction,
    rejoin: { x: rejoin.x, y: rejoin.y },
    plannedAt: now,
    replanAt: now + ORBIT_AVOIDANCE_REPLAN_MS
  };
  return runtime.orbitAvoidance;
}

// One tick of orbit steering. Sets the aim point, the speed ceiling the radius
// and the hull's turn rate allow, and whether a reversal is still in progress.
// It deliberately touches no engagement latch: Orbit has none to touch.
function planOrbit(room, ship, runtime, target, stats, now) {
  const centreX = Number(target.x) || 0;
  const centreY = Number(target.y) || 0;
  let dx = (ship.x || 0) - centreX;
  let dy = (ship.y || 0) - centreY;
  let centreDistance = fastHypot(dx, dy);
  if (!(centreDistance > BEARING_MIN_DISTANCE)) {
    // Sitting on the target's own position: there is no radial to work from, so
    // pick one off the hull's nose and let the correction push it out.
    dx = Math.cos(ship.angle || 0);
    dy = Math.sin(ship.angle || 0);
    centreDistance = 1;
  }
  const radialX = dx / centreDistance;
  const radialY = dy / centreDistance;

  const direction = orbitDirectionOf(ship, runtime);
  const tangent = orbitTangent(radialX, radialY, direction);
  const standoff = orbitStandoff(ship, target);
  // Measured the way the stance was specified: to the hull for a ship, to the
  // surface for a station. For a ship this is just centreDistance.
  const radialError = engagementGeometry(ship, target).distance - standoff;
  const correction = clampNumber(radialError / ORBIT_CORRECTION_BAND, -1, 1);

  // Too far out, the radial term points inward; too close, outward; on the
  // radius it vanishes and the ship simply travels round.
  let desiredX = tangent.x - radialX * correction * ORBIT_RADIAL_GAIN;
  let desiredY = tangent.y - radialY * correction * ORBIT_RADIAL_GAIN;
  const length = fastHypot(desiredX, desiredY);
  if (length > 1e-6) {
    desiredX /= length;
    desiredY /= length;
  } else {
    desiredX = tangent.x;
    desiredY = tangent.y;
  }

  // A circle of this radius cannot be flown faster than the hull can turn
  // through it. Damage a gyroscope and the same ship orbits slower, which is
  // the behaviour a damaged ship should have -- not an ever-widening overshoot.
  const turnRate = maxTurnRate(stats);
  const turnLimited = turnRate > 0 ? turnRate * standoff * ORBIT_TURN_MARGIN : Infinity;
  const clearance = routeClearance(ship);
  let speedLimit = turnLimited;
  let blockedForRejoin = false;

  // --- Is a manoeuvre already running, and may it end? ---------------------
  let avoidance = runtime.orbitAvoidance;
  if (avoidance && (avoidance.targetId !== String(target.id) || avoidance.direction !== direction)) {
    // A different target, or the player reversed the orbit. The rejoin point
    // was chosen for the old one and means nothing now; re-detect below.
    avoidance = null;
    runtime.orbitAvoidance = null;
  }

  if (avoidance) {
    const rejoin = avoidance.rejoin;
    const rejoinClear = Boolean(rejoin)
      && isSegmentClear(room, ship.x, ship.y, rejoin.x, rejoin.y, clearance);
    if (avoidance.phase === "detour") {
      // The ONE test that ends a detour: a clear run at full hull clearance to
      // the point on the circle we committed to. That is what "the obstacle is
      // behind us" actually means. The short aim segment ahead is deliberately
      // not consulted -- it goes clear while the ship is still beside the rock.
      if (rejoinClear) avoidance.phase = "rejoin";
    } else if (!rejoinClear) {
      // Something came between the hull and the rejoin point after all. Go back
      // to routing rather than pressing on into it.
      avoidance.phase = "detour";
    }

  }

  // Rejoin flies on live orbit steering, not at the rejoin point.
  //
  // Steering AT the point would make it a destination, and a destination gets
  // arrival braking: the ship crept up to the waypoint, stopped on it, and sat
  // there -- if the heading it happened to stop on was not within tolerance of
  // the tangent, the release test could never pass and the manoeuvre never
  // ended. Flying the ordinary tangent-plus-correction field instead curves the
  // hull back onto the circle under power, which is also what it should look
  // like. The point has already done its job by proving the obstacle is behind
  // the ship; the phase now only withholds the all-clear until the ship really
  // is back on its orbit.
  const rejoining = avoidance?.phase === "rejoin";

  // --- Look ahead, and commit if something is in the way -------------------
  //
  // Detection sweeps the predicted path, which is a dozen segment checks, and
  // once a manoeuvre is committed it also has to choose a rejoin point, which
  // can run the path search several times. Neither belongs on every tick of
  // every orbiting ship: the geometry being swept is static, and a ship moves a
  // small fraction of the horizon between ticks. A committed manoeuvre is
  // reconsidered on the replan cadence; a clear sweep is simply not repeated
  // for a short while. The detection margin above is what pays for the delay.
  // Rejoin is flying the live field again, so its path has to be swept every
  // tick: a clear run to the rejoin point does not promise the whole curve back
  // onto the circle is clear.
  const dueToScan = rejoining
    || (!avoidance
      ? now >= (Number(runtime.orbitScanAt) || 0)
      : orbitAvoidanceStale(avoidance, target, direction, now));
  if (dueToScan) {
    const scratch = runtime._orbitPathScratch || (runtime._orbitPathScratch = []);
    const path = orbitPredictedPath(
      ship,
      target,
      standoff,
      direction,
      orbitAvoidanceLookahead(ship, stats),
      scratch
    );
    const pathBlocked = Number.isFinite(orbitPathClearDistance(room, ship, path));
    if (pathBlocked && rejoining && avoidance.rejoin
      && !orbitAvoidanceStale(avoidance, target, direction, now)) {
      // The curve back onto the circle is obstructed after all. Go back to
      // routing at the point already committed to rather than choosing a new
      // one: re-planning here would run the candidate search every tick for as
      // long as the ship hovered around the boundary.
      avoidance.phase = "detour";
    } else if (pathBlocked) {
      // Something is in the way of the path the ship intends to fly, and there
      // is no committed manoeuvre worth keeping. Commit to one.
      avoidance = planOrbitAvoidance(
        room, ship, runtime, target, radialX, radialY, standoff, direction, now
      );
      runtime.orbitScanAt = 0;
    } else if (rejoining) {
      // The way ahead is clear. Release the manoeuvre once the ship is actually
      // back on its radius and pointing round the circle -- not merely past the
      // obstacle -- so "avoiding" and "orbiting" never quietly overlap. Live
      // steering is already turning the hull onto the tangent, so this settles
      // within a second of the radius being recovered.
      const onRadius = Math.abs(radialError) <= ORBIT_REJOIN_RADIAL_TOLERANCE;
      const onTangent = Math.abs(angleDifference(ship.angle || 0, Math.atan2(tangent.y, tangent.x)))
        <= ORBIT_REJOIN_HEADING_TOLERANCE;
      if (onRadius && onTangent) {
        runtime.orbitAvoidance = null;
        avoidance = null;
        runtime.orbitScanAt = now + ORBIT_AVOIDANCE_SCAN_MS;
      }
    } else if (avoidance) {
      // Still detouring. A clear sweep from where the hull happens to be does
      // not end a detour: only the clear run to the committed rejoin point does.
      avoidance.replanAt = now + ORBIT_AVOIDANCE_REPLAN_MS;
    } else {
      runtime.orbitScanAt = now + ORBIT_AVOIDANCE_SCAN_MS;
    }
  }

  // --- Never carry more speed than the room in front of the hull allows ----
  //
  // Evaluated every tick, in every phase, against the direction the ship is
  // ACTUALLY travelling rather than the one it intends to. A route around the
  // obstacle is only as good as the ship's ability to follow it, and a hull
  // carrying its full orbit speed into a corner leaves the route on the outside
  // of the turn -- which is how the first version ended up grinding along the
  // rock it had correctly planned a way around. This is the guarantee that it
  // can always stop before whatever is directly ahead.
  speedLimit = Math.min(speedLimit, orbitBrakingCeiling(room, ship, stats));

  // --- Steer ---------------------------------------------------------------
  if (avoidance && avoidance.phase === "detour" && avoidance.rejoin) {
    // A real place, routed to through the shared static planner. This is the
    // committed part of the manoeuvre and it ignores the aim point entirely.
    runtime.destination = { x: avoidance.rejoin.x, y: avoidance.rejoin.y };
    runtime.orbitDirect = false;
  } else if (avoidance && !avoidance.rejoin) {
    // Committed, but with nowhere to rejoin yet. Hold position and keep
    // shooting while the bounded retry looks again; driving on would be driving
    // into the obstacle. A null destination is what stops the ship -- see
    // planMovement -- so no speed ceiling is needed to express it.
    runtime.destination = null;
    runtime.orbitDirect = false;
    runtime.blocked = true;
    blockedForRejoin = true;
  } else {
    // Live orbit -- and rejoin, which flies the same field. A virtual aim point
    // along the desired direction, regenerated from wherever the hull has got
    // to and never reached.
    runtime.destination = {
      x: (ship.x || 0) + desiredX * ORBIT_LOOKAHEAD_DISTANCE,
      y: (ship.y || 0) + desiredY * ORBIT_LOOKAHEAD_DISTANCE
    };
    runtime.orbitDirect = true;
  }
  if (!blockedForRejoin) runtime.blocked = false;
  // The orbit controller is flying this ship, so its speed ceiling applies.
  // Held separately from the ceiling itself because a legitimate ceiling of
  // zero and "no orbit ceiling at all" are different instructions.
  runtime.orbitSteering = true;

  // A reversal is a turnaround, not a sign flip. The desired direction above is
  // already the new tangent, so the hull is turning onto it; all this does is
  // take the throttle off until the momentum from the old one has gone.
  const tangentialSpeed = (ship.vx || 0) * tangent.x + (ship.vy || 0) * tangent.y;
  if (runtime.orbitReversing) {
    const headingError = Math.abs(angleDifference(ship.angle || 0, Math.atan2(desiredY, desiredX)));
    if (tangentialSpeed >= -ORBIT_REVERSAL_SPEED
      || headingError <= ORBIT_REVERSAL_HEADING_TOLERANCE) {
      runtime.orbitReversing = false;
    }
  }
  runtime.orbitSpeedLimit = runtime.orbitReversing
    ? Math.min(speedLimit, ORBIT_REVERSAL_SPEED)
    : speedLimit;
}

// Orbit steering is live only while the stance is actually flying a circle.
// Everything else -- no target, Static, a Hold latch, a Charge contact -- must
// leave it switched off, or a stale speed ceiling would throttle the next order.
function clearOrbitSteering(runtime) {
  runtime.orbitSteering = false;
  runtime.orbitSpeedLimit = 0;
  runtime.orbitDirect = false;
  runtime.orbitScanAt = 0;
  runtime.orbitAvoidance = null;
}

function refreshEngagement(room, ship, runtime, now, stats) {
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
    runtime.holdCoverageRange = 0;
    runtime.blocked = false;
    runtime.attackLane = null;
    clearOrbitSteering(runtime);
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
    runtime.holdCoverageRange = 0;
    runtime.blocked = false;
    runtime.attackLane = null;
    clearOrbitSteering(runtime);
    clearRoute(runtime);
    return;
  }

  // Orbit branches before any of the Hold geometry below. Everything the Hold
  // path does -- the range gate, the standoff, the firing-position search, the
  // holdEngaged latch -- is about arriving somewhere and stopping, and an
  // orbiting ship never arrives anywhere. It attacks from the first tick and
  // spirals onto its radius while it does.
  if (type === "attack" && combatStance(ship) === "orbit") {
    runtime.holdEngaged = false;
    runtime.chargeEngaged = false;
    runtime.ramming = false;
    runtime.holdCoverageRange = 0;
    runtime.attackLane = null;
    runtime.arrivalRadius = ARRIVE_DISTANCE;
    planOrbit(room, ship, runtime, target, stats, now);
    return;
  }
  clearOrbitSteering(runtime);

  const geometry = engagementGeometry(ship, target);
  const distance = geometry.distance;
  const ranges = engagementRanges(ship, target, type);
  const { contact, enter, resume } = ranges;

  if (type === "attack" && combatStance(ship) === "charge") {
    runtime.holdEngaged = false;
    runtime.holdCoverageRange = 0;
    // Charge never stops at a clump position. It is a contact-seeking stance
    // and the Hold standoff geometry has nothing to say to it.
    runtime.attackLane = null;
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

  if (runtime.holdEngaged) {
    const firingLineClear = type !== "attack" || currentFiringLineClear(room, ship, target);
    const chase = toggles.pursue && (distance > resume || !firingLineClear);
    if (!chase) {
      runtime.blocked = false;
      clearRoute(runtime);
      return;
    }
    runtime.holdEngaged = false;
    runtime.holdCoverageRange = 0;
  } else if (canEngageFromHere(room, ship, target, type, distance, enter)) {
    // The first position it can fire from is the position it stops at. No ship
    // moves anywhere tidier before it starts shooting -- but "can fire from" is
    // a question about the guns, and the gate that got us here only measured the
    // hull centre. Ask the battery before latching.
    const shortfall = type === "attack" ? holdCoverageShortfall(room, ship, runtime, target, now) : 0;
    const wanted = Math.max(
      contact,
      Math.floor((distance - shortfall) / HOLD_COVERAGE_STANDOFF_STEP) * HOLD_COVERAGE_STANDOFF_STEP
    );
    if (shortfall <= 0 || distance <= wanted) {
      // Either the whole main battery reaches, or the hull is already as close
      // as it is allowed to get and closing further would not buy the gun that
      // is still short anything.
      runtime.holdEngaged = true;
      runtime.holdCoverageRange = 0;
      runtime.blocked = false;
      runtime.attackLane = null;
      clearRoute(runtime);
      return;
    }
    // Keep closing, to the range the guns asked for rather than the one the
    // centre-to-centre gate would have settled for.
    runtime.holdCoverageRange = wanted;
  } else {
    runtime.holdCoverageRange = 0;
  }

  const coverageRange = Number(runtime.holdCoverageRange) || 0;
  const engageRange = coverageRange > 0 ? Math.min(enter, coverageRange) : enter;
  const standoff = Math.max(0, engageRange - ARRIVE_DISTANCE);
  // Out of range: close along this ship's own lane, so the fleet advances
  // abreast instead of queueing up behind whoever reaches the target first.
  const lane = attackLaneDestination(room, ship, runtime, target, type, standoff);
  if (lane) {
    runtime.destination = lane;
    runtime.blocked = false;
    return;
  }
  const destination = reachableFiringPosition(room, ship, target, runtime, standoff, engageRange, now);
  runtime.blocked = !destination;
  if (destination) runtime.destination = destination;
  else clearRoute(runtime);
}

// A route is planned to keep this much room around the hull.
//
// A ship actively dodging static geometry gets a wider envelope than one simply
// crossing open space. The ordinary margin is enough for a route the ship can
// follow accurately, but a detour is flown under momentum, at a hard-braked
// crawl, round the outside of a corner -- and a route drawn along the very edge
// of the ordinary envelope leaves a hull tracking it a few pixels wide of the
// line in contact with the obstacle. Planning the detour wider is what turns
// "went around it, touching" into "went around it".
function routeClearance(ship) {
  const base = navigationClearanceRadius(ship);
  return ship?.movement?.orbitAvoidance ? base + ORBIT_AVOIDANCE_ROUTE_PAD : base;
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
  const { getHoldWeaponFacingSignature, chooseHoldWeaponFacing } = combat();
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
  // An orbit aim point is a bearing, not a destination: it is regenerated ahead
  // of the hull every tick and is never arrived at. Braking for it, or limiting
  // speed by the turn needed to hit it, would have the ship slow down for a
  // point that is running away from it. The orbit's own ceiling below is what
  // governs how fast the circle may be flown.
  //
  // A detour rejoin point IS a real place, and while one is being routed to the
  // ordinary route limits stand with only the orbit ceiling added on top --
  // which is exactly what `orbitDirect` distinguishes.
  const aimingAtBearing = Boolean(runtime.orbitSteering) && Boolean(runtime.orbitDirect);
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
  // What the orbit controller will allow this tick: the speed whose turn radius
  // fits the circle being flown, the emergency ceiling for the room left before
  // an obstacle, or the brake during a direction reversal. `orbitSteering` is
  // what says a ceiling applies at all, because a legitimate ceiling of zero
  // and "this ship is not orbiting" are different instructions.
  const orbitSpeedLimit = runtime.orbitSteering
    ? Math.max(0, Number(runtime.orbitSpeedLimit) || 0)
    : Infinity;
  const permitted = Math.min(
    ownMaxSpeed,
    ramming || aimingAtBearing ? Infinity : safeArrivalSpeed,
    ramming || aimingAtBearing ? Infinity : turnLimit,
    route ? route.cornerLimit : Infinity,
    route ? route.orbitLimit : Infinity,
    blockedLimit,
    orbitSpeedLimit
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
    refreshEngagement(room, ship, runtime, ship._simNow, stats);
  } else if (authority === "stop") {
    runtime.holdEngaged = false;
    runtime.chargeEngaged = false;
    runtime.blocked = false;
    runtime.arrivalRadius = ARRIVE_DISTANCE;
    clearOrbitSteering(runtime);
    clearRoute(runtime);
  } else if (authority === "position") {
    runtime.holdEngaged = false;
    runtime.chargeEngaged = false;
    runtime.blocked = false;
    clearOrbitSteering(runtime);
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
  // Orbit steers at its aim point directly for the same reason Charge does, and
  // one more besides: the aim point moves with the hull every tick, so handing
  // it to the route planner would invalidate and rebuild the route continuously
  // for a leg that was already known to be clear. planOrbit has done that check.
  const directOrbit = Boolean(runtime.orbitDirect) && Boolean(runtime.destination);
  const direct = directCharge || directOrbit;
  const routed = runtime.destination && !direct
    ? resolveRoute(room, ship, runtime, ship._simNow)
    : false;
  if (direct && runtime.path?.length) {
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

function issueAttack(room, ship, commandId, targetId, now, lane = null) {
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
  if (lane) {
    runtime.attackLane = {
      targetId: String(targetId),
      commandId: id,
      forwardX: lane.forwardX,
      forwardY: lane.forwardY,
      lateralOffset: lane.lateralOffset
    };
  }
  // A ship that can already shoot stops here and does it. This is the first
  // thing the order does, before anything about where it might have gone.
  // Orbit is excluded with Charge: neither has a position to latch, and Orbit in
  // particular must never acquire holdEngaged, which is what would park it.
  if (target && combatStance(ship) !== "charge" && combatStance(ship) !== "orbit") {
    const distance = engagementGeometry(ship, target).distance;
    if (distance <= engagementRanges(ship, target, "attack").enter
      && currentFiringLineClear(room, ship, target)) {
      runtime.holdEngaged = true;
      runtime.attackLane = null;
    }
  }
  syncMovementTarget(ship);
  return true;
}

// The whole of what a Hold attack order plans: which way the fleet is closing,
// and how far off that line each ship already sits. No shape, no slots, no
// distance worked out from anyone's weapon range -- every ship stops at the
// first place IT can fire from, which is a per-ship question answered per tick.
//
// Only Hold takes a lane. Charge is pursuing contact and Static/Sentry never
// leave where they are.
function planAttackLanes(ships, target) {
  const lanes = new Map();
  const holders = (ships || []).filter((ship) => combatStance(ship) === "hold");
  if (!holders.length || !target) return lanes;
  let sumX = 0;
  let sumY = 0;
  for (const ship of holders) {
    sumX += Number(ship.x) || 0;
    sumY += Number(ship.y) || 0;
  }
  const centreX = sumX / holders.length;
  const centreY = sumY / holders.length;
  const forwardX = (Number(target.x) || 0) - centreX;
  const forwardY = (Number(target.y) || 0) - centreY;
  const length = fastHypot(forwardX, forwardY);
  // The fleet is standing on its target. There is no advance to spread out, and
  // everyone is inside their own range anyway.
  if (!(length > BEARING_MIN_DISTANCE)) return lanes;
  const unitX = forwardX / length;
  const unitY = forwardY / length;
  const lateralX = -unitY;
  const lateralY = unitX;
  for (const ship of holders) {
    lanes.set(ship.id, {
      forwardX: unitX,
      forwardY: unitY,
      lateralOffset: ((Number(ship.x) || 0) - centreX) * lateralX
        + ((Number(ship.y) || 0) - centreY) * lateralY
    });
  }
  return lanes;
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
    const lanes = planAttackLanes(ships, livingTarget);
    for (const ship of ships) {
      issueAttack(room, ship, commandId, livingTarget.id, now, lanes.get(ship.id) || null);
    }
    return { ok: true, code: "attack", commanded: ships.length };
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

function applyCombatStyle(ship, combatStyle, orbitDirection) {
  ship.combatStyle = combatStyle;
  ship.combatStyleRaw = combatStyle;
  const runtime = ensureMovementRuntime(ship);
  runtime.holdFacing = null;
  runtime.holdCoverageRange = 0;
  runtime.holdEngaged = false;
  runtime.chargeEngaged = false;
  runtime.ramming = false;
  clearOrbitSteering(runtime);
  runtime.orbitReversing = false;
  // The direction survives the stance. Switching to Hold and back to Orbit
  // restores the way round this ship was already going; an explicit direction on
  // the message is what changes it. A ship that has never orbited gets
  // clockwise, so selecting Orbit always has an answer.
  ship.orbitDirection = orbitDirection === undefined
    ? sanitizeOrbitDirection(ship.orbitDirection)
    : sanitizeOrbitDirection(orbitDirection, ship.orbitDirection);
  runtime.orbitDirection = ship.orbitDirection;
}

// Change which way round a ship orbits, and NOTHING else.
//
// This is deliberately not applyCombatStyle with a different argument. That one
// retires the Hold facing decision, drops the Hold and Charge latches and clears
// the ramming state, all of which are correct when the stance itself changes and
// all of which are wrong here: the ship is already fighting this target, and a
// direction toggle must not cost it its target, its firing solution, its weapon
// tracking or its place in the fight. The only things that stop being true are
// the way round and the steering that was following it.
function applyOrbitDirection(ship, orbitDirection) {
  const runtime = ensureMovementRuntime(ship);
  const next = sanitizeOrbitDirection(orbitDirection, ship.orbitDirection);
  if (sanitizeOrbitDirection(ship.orbitDirection) === next) {
    // Still worth writing through: a ship whose stored direction was absent or
    // malformed has just been given the canonical one.
    ship.orbitDirection = next;
    runtime.orbitDirection = next;
    return false;
  }
  ship.orbitDirection = next;
  runtime.orbitDirection = next;
  // Reverse under power rather than by flipping the velocity. planOrbit brakes
  // the old tangential motion and turns onto the new tangent while it does.
  runtime.orbitReversing = true;
  // Only the orbit steering is invalidated. A committed avoidance manoeuvre was
  // planned to rejoin the circle going the other way, so its rejoin point is no
  // longer on the path this ship will fly; planOrbit re-detects and re-commits
  // in the new direction on the next tick. The attack command, the target and
  // the ship's weapon state are all untouched.
  runtime.orbitAvoidance = null;
  // ...and the new direction is swept for immediately rather than at the next
  // scheduled scan, because the path ahead is a different path now.
  runtime.orbitScanAt = 0;
  runtime.orbitSpeedLimit = 0;
  return true;
}

function applyMovementToggles(ship, toggles) {
  ship.movementToggles = sanitizeMovementToggles(toggles, ship.movementToggles);
  return ship.movementToggles;
}

module.exports = {
  FORMATION_TYPES,
  SUPPORTED_MOVEMENT_TYPES,
  alignmentThrottle,
  applyCombatStyle,
  applyMovementToggles,
  applyOrbitDirection,
  applyPropulsion,
  commandShips,
  commandShipsToDestination,
  createMovementRuntime,
  integratePosition,
  maxFriendlyCorrectionPerTick,
  navigationClearanceRadius,
  nearestClearPoint: require("./movementNavigation").nearestClearPoint,
  orbitStandoff,
  orbitTangent,
  physicalCollisionRadius,
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
