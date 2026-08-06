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
  KITE_BLOCKED_RETRY_MS,
  KITE_CLEAR_SCAN_MS,
  KITE_CLOSING_SPEED_BUFFER,
  KITE_CLOSING_TRIGGER_SPEED,
  KITE_CONTACT_PADDING,
  KITE_EDGE_BUFFER_MIN,
  KITE_EDGE_INWARD_BIAS,
  KITE_ESCAPE_LOOKAHEAD_MIN,
  KITE_ESCAPE_LOOKAHEAD_SECONDS,
  KITE_ESCAPE_REPLAN_MS,
  KITE_HEADING_IMPROVEMENT_RATIO,
  KITE_INNER_RANGE_RATIO,
  KITE_MIN_ESCAPE_PROJECTION,
  KITE_OUTER_RANGE_RATIO,
  KITE_PREFERRED_RANGE_RATIO,
  KITE_RANGE_GAIN,
  KITE_ROUTE_PAD,
  KITE_TARGET_MOVE_REPLAN,
  KITE_TARGET_PREDICTION_SECONDS,
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
  UNPOWERED_DAMPING,
  WORLD_MARGIN
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
  KITE_RUNTIME_DEFAULTS,
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
// How many move orders may be stacked behind the one a single ship is flying.
// A cap rather than a design limit: the queue costs nothing to hold, but it is
// player input arriving over the wire and it does not get to grow without end.
const MAX_QUEUED_WAYPOINTS = 16;

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

// A heading directly astern has no shorter side to turn through. Signed
// shortest-angle normalization has to break that tie somehow and breaks it at
// +PI, so every about-face goes right -- on a hull whose maneuver thrusters are
// uneven, or which has lost the ones on one side, that is reliably the slow way
// round and reads as the controller picking the wrong direction. Only inside
// this window is the choice genuinely ambiguous; outside it the shortest side is
// the answer and nothing here may second-guess it.
const TURN_TIE_WINDOW = 0.02;

// Which way round to turn: the shorter side, unless the two sides are within a
// hair of equal, in which case the faster side, then the way the hull is already
// rotating -- reversing a turn in progress costs more than finishing it -- then
// a fixed answer so the same situation always resolves the same way.
function resolveTurnDirection(ship, stats, difference) {
  if (Math.PI - Math.abs(difference) > TURN_TIE_WINDOW) return difference > 0 ? 1 : -1;
  const right = signedTurnRate(stats, 1, ship);
  const left = signedTurnRate(stats, -1, ship);
  if (Math.abs(right - left) > 1e-9) return right > left ? 1 : -1;
  if (ship._turnDirection === 1 || ship._turnDirection === -1) return ship._turnDirection;
  return difference >= 0 ? 1 : -1;
}

function turnTowardHeading(ship, desiredHeading, stats, dt) {
  if (!Number.isFinite(desiredHeading)) {
    ship.turnActivity = 0;
    return;
  }
  const before = Number(ship.angle) || 0;
  const difference = angleDifference(before, desiredHeading);
  const direction = resolveTurnDirection(ship, stats, difference);
  const rate = signedTurnRate(stats, direction, ship);
  const maxDelta = rate * dt;
  if (!(maxDelta > 0)) {
    ship.turnActivity = 0;
    return;
  }
  const blend = 1 - Math.exp(-dt / TURN_TIME_CONSTANT_S);
  // Size from the heading error, side from the resolved direction. They agree
  // everywhere except at the about-face tie, and there the resolved side has to
  // win or the ship turns the way the tie-break just rejected.
  const step = direction * Math.min(Math.abs(difference) * blend, maxDelta);
  ship.angle = normalizeHullAngle(before + step);
  if (Math.abs(step) > 0) ship._turnDirection = step > 0 ? 1 : -1;
  ship.turnActivity = Math.abs(difference) < FINAL_FACING_TOLERANCE
    ? 0
    : clampNumber(step / maxDelta, -1, 1);
  applyTurnHeat(ship, ship.turnActivity, dt);
}

// Holding I or O turns the hull directly. The angle it reaches is also latched
// as the ship's standing facing: without that, every heading the controller
// would otherwise have held -- the arrival heading, a combat facing -- is still
// sitting there waiting, and the hull snaps back to it the tick the key comes
// up, which reads as the keys not working at all.
function applyManualRotation(ship, runtime, stats, dt) {
  const direction = ship.manualRotation === 1 ? 1 : -1;
  const rate = signedTurnRate(stats, direction, ship);
  if (!(rate > 0)) {
    ship.turnActivity = 0;
    return;
  }
  ship.angle = normalizeHullAngle((ship.angle || 0) + direction * rate * dt);
  // Only a ship standing still keeps the angle. A hull still flying to a
  // destination points where the thrust has to go, so a mid-flight nudge is
  // transient by nature and must not become the heading it parks on.
  if (runtime && !(runtime.destination && !runtime.arrived)) {
    runtime.manualFacing = ship.angle;
    runtime.arrivalHeading = ship.angle;
    runtime.combatFacingHeld = false;
    // The order's own final facing is a heading from before the player took the
    // helm by hand, and leaving it set would reassert itself on the next order
    // tick. The command otherwise stands: the ship still flies where it was sent.
    if (runtime.command && Number.isFinite(runtime.command.finalFacing)) {
      runtime.command.finalFacing = null;
    }
  }
  ship.turnActivity = direction;
  ship._turnDirection = direction;
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
    runtime.destination = command.destination;
    // Deliberately no "it has drifted off the point, re-run the move" branch.
    // Collision correction and friendly separation shove a parked hull around by
    // more than the arrival envelope all the time in a crowded formation, and
    // reopening the order on that reinstates route steering for a tick, which
    // re-derives the nose direction from the path and then hands it back to the
    // resting heading -- the ship visibly hunts between the two. The order was
    // carried out; being nudged afterwards does not un-carry it out.
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
// against asteroids and station pieces -- and against the world boundary, which
// isSegmentClear applies the same clearance rule to -- via the shared
// navigation authority.
//
// Shared by every travelling stance. Orbit needs it because a circle is flown
// under momentum around the outside of a corner; Kite needs it for the same
// reason, running from something. Neither may have its own slightly different
// copy: this is the guarantee that a hull can always stop before whatever is
// directly ahead of it, and two of them would be two different guarantees.
//
// `options.escapeClearance` is the one thing a caller may vary, and only for
// the pinch case below: how much daylight the crawl OUT of a pinch insists on.
// It defaults to the same padded margin the forward probe uses, which is what
// Orbit has always had. Kite passes the bare hull, because its pinch is a
// different situation -- Orbit is pinched while flying a circle it can widen,
// Kite is pinched while trying to leave, and refusing the crawl at a gap
// narrower than the margin leaves it with no direction that reads as open at
// all. The forward-collision probe itself is identical for both.
function staticObstacleBrakingCeiling(room, ship, stats, options = null) {
  const speed = fastHypot(ship.vx || 0, ship.vy || 0);
  if (!(speed > REST_SPEED)) return Infinity;

  // The +24 route-planning envelope is for planning the detour, not for the
  // emergency forward-collision probe. The emergency probe uses the physical
  // hull margin so that being inside the padded envelope is not mistaken for
  // being in physical contact.
  const emergencyClearance = physicalCollisionRadius(ship) + ORBIT_PINCH_HULL_MARGIN;
  const escapeClearance = Number.isFinite(Number(options?.escapeClearance))
    ? Math.max(physicalCollisionRadius(ship), Number(options.escapeClearance))
    : emergencyClearance;
  const deceleration = Math.max(1, brakingAcceleration(stats));
  const reach = speed * speed / (2 * deceleration) + speed * ORBIT_AVOIDANCE_REACTION_TIME;
  if (!(reach > 1)) return Infinity;

  // Probe along the actual velocity. Momentum is what puts a hull into a rock;
  // a valid detour route is checked by orbitPathClearDistance before the ship
  // is committed to it.
  const unitX = (ship.vx || 0) / speed;
  const unitY = (ship.vy || 0) / speed;

  const clearFor = (distance, margin = emergencyClearance) => isSegmentClear(
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
    return clearFor(crawlStop + ORBIT_PINCH_HULL_MARGIN, escapeClearance)
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
  speedLimit = Math.min(speedLimit, staticObstacleBrakingCeiling(room, ship, stats));

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

// --- Kite --------------------------------------------------------------------
//
// Kite holds its target near the far edge of its own main battery: it runs when
// the range collapses, closes only when the target leaves that battery's reach,
// and shoots the whole time it can.
//
// The thing that makes it a stance rather than a reversal is that there is no
// reverse thrust in this movement model and none is added here. A Kite ship
// picks a HULL HEADING with an outward component and uses ordinary forward
// propulsion along it. Which heading that is depends on where the guns are
// mounted: a hull with a rear-facing railgun points away from what it is
// fighting, runs, and keeps firing over its shoulder; a hull with a nose gun
// loses coverage while it turns and runs, and gets it back once the range is
// safe again. Nothing here knows what a railgun is -- it only asks each gun of
// the main battery which hull heading would put its own mount and its own arc
// on the target.
//
// Like Orbit it never latches, never arrives, is planned per ship and is given
// nothing by anything above it. Unlike Orbit its aim point is not always
// virtual: while a detour round static geometry is committed the destination is
// a real routed place and the ordinary route limits apply to it, which is what
// `kiteDirect` distinguishes.

// Kite steering is live only while the stance is actually flying the band.
// Everything else -- no target, another stance, Static, an order -- must leave
// it switched off, or a stale speed ceiling would throttle the next order and a
// stale heading would be flown at a target this ship is no longer fighting.
function clearKiteSteering(runtime) {
  for (const key of Object.keys(KITE_RUNTIME_DEFAULTS)) runtime[key] = KITE_RUNTIME_DEFAULTS[key];
}

// The far-range band, measured the same way engagementGeometry measures
// distance -- to the hull for a ship, to the attackable surface for a station.
//
// `battery` is the main battery's all-heading reach, so the band is the reach of
// the guns the stance is actually being flown for. A short-ranged secondary does
// not appear in it and so cannot drag the hull into a knife fight. The contact
// floor is the only thing that may raise the band, and it exists so a
// short-ranged hull kites around its target rather than through it.
function kiteRanges(battery, contact) {
  const floor = contact + KITE_CONTACT_PADDING;
  const preferred = Math.max(floor, battery * KITE_PREFERRED_RANGE_RATIO);
  const inner = Math.max(floor, battery * KITE_INNER_RANGE_RATIO);
  return {
    preferred,
    // Never above preferred: with a short battery both collapse onto the
    // contact floor, and an inner band outside the preferred one would mean
    // retreating from the range the ship is trying to hold.
    inner: Math.min(inner, preferred),
    outer: Math.max(preferred + ARRIVE_DISTANCE, battery * KITE_OUTER_RANGE_RATIO)
  };
}

// Where the target will be in a moment, bounded hard. This is reaction time, not
// a forecast: half a second of the target's own velocity is enough to start
// running before a fast attacker actually closes the band, and long enough that
// a malformed velocity could put the answer anywhere is not.
//
// A station does not move, so it keeps the range already measured against its
// surface rather than having a velocity applied to a shape.
function kitePredictedDistance(ship, target, distance) {
  if (targetIsStation(target)) return distance;
  const vx = clampNumber(Number(target.vx) || 0, -10000, 10000);
  const vy = clampNumber(Number(target.vy) || 0, -10000, 10000);
  const x = (Number(target.x) || 0) + vx * KITE_TARGET_PREDICTION_SECONDS;
  const y = (Number(target.y) || 0) + vy * KITE_TARGET_PREDICTION_SECONDS;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return distance;
  return fastHypot(x - (ship.x || 0), y - (ship.y || 0));
}

// Is the ship being crowded? Three separate ways of being crowded, because a
// range that is about to collapse has to be treated as collapsed: a fast
// attacker crosses the band in the time it takes a heavy hull to turn around.
function kiteUnderPressure(ranges, distance, predicted, radial) {
  if (distance < ranges.inner) return true;
  if (predicted < ranges.inner) return true;
  const closing = -radial;
  if (!(closing > KITE_CLOSING_TRIGGER_SPEED)) return false;
  // Margin left, against the ground the target will make up while the ship
  // reacts, plus the buffer that stops this triggering on the exact tick the
  // band is breached.
  return (distance - ranges.inner)
    < closing * KITE_TARGET_PREDICTION_SECONDS + KITE_CLOSING_SPEED_BUFFER;
}

// The most this hull can actually do, which is not what its blueprint says: the
// heat- and damage-adjusted figure is the one every Kite speed is measured
// against, so a ship with a burnt engine kites slower rather than asking for a
// speed it cannot make.
function kiteAvailableSpeed(ship, stats) {
  const effective = Math.max(0, Number(stats.maxSpeed) || 0);
  const paper = Number(ship.stats?.maxSpeed);
  return Number.isFinite(paper) && paper > 0 ? Math.min(effective, paper) : effective;
}

// Range is controlled as a desired RATE, not as a stop point. A stop point makes
// a ship park; a rate lets it ease onto the band, run from something closing,
// and drift back in when the target is slower than it is.
//
// Positive opens the range, negative closes it. Nothing here is a ship speed
// yet: the chosen heading's outward projection is what turns it into one.
function kiteDesiredOpeningSpeed(mode, ranges, distance, radial, available, toggles) {
  const rangeError = ranges.preferred - distance;
  let opening = clampNumber(rangeError * KITE_RANGE_GAIN, -available, available);
  if (mode === "retreat") {
    // Matching the target's closing speed only holds the gap. The buffer is
    // what makes a retreat actually gain ground.
    opening = clampNumber(
      Math.max(opening, -radial + KITE_CLOSING_SPEED_BUFFER),
      0,
      available
    );
  }
  // Pursue off means never chasing a target that opens the range. It does not
  // mean standing still while one closes, so only the closing half is removed.
  if (!toggles.pursue) opening = Math.max(opening, 0);
  return Number.isFinite(opening) ? opening : 0;
}

// How much of the map Kite treats as unusable.
//
// Collision clamping at the boundary is a final safety net, not navigation: a
// ship that only notices the edge when it touches it accelerates into the wall,
// grinds along it and never opens the range. This inset is what keeps escape
// destinations off the wall in the first place, and it is wider than the
// navigation envelope by a deliberate buffer so the reaction happens with room
// left to turn.
function kiteEdgeInset(ship) {
  return WORLD_MARGIN + navigationClearanceRadius(ship) + KITE_EDGE_BUFFER_MIN;
}

function insideKiteInset(room, x, y, inset) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const width = room?.world?.width || WORLD.width;
  const height = room?.world?.height || WORLD.height;
  return x >= inset && x <= width - inset && y >= inset && y <= height - inset;
}

// How far along `heading` the hull may travel before it leaves the inset above.
// Zero for a ship already outside it pointing further out, which is exactly the
// reading that rejects "keep accelerating into the wall".
function kiteInsetRun(room, ship, heading, inset) {
  const width = room?.world?.width || WORLD.width;
  const height = room?.world?.height || WORLD.height;
  const dx = Math.cos(heading);
  const dy = Math.sin(heading);
  const axis = (position, direction, low, high) => {
    if (direction > 1e-9) return (high - position) / direction;
    if (direction < -1e-9) return (low - position) / direction;
    return Infinity;
  };
  return Math.max(0, Math.min(
    axis(ship.x || 0, dx, inset, width - inset),
    axis(ship.y || 0, dy, inset, height - inset)
  ));
}

// How pinned against the boundary the hull currently is, 0 well inside the inset
// to 1 on it or beyond. Scales the inward bias, so the edge costs nothing in
// open space and dominates against the wall.
function kiteEdgePressure(room, ship, inset) {
  const width = room?.world?.width || WORLD.width;
  const height = room?.world?.height || WORLD.height;
  const margin = Math.min(
    (ship.x || 0) - inset,
    width - inset - (ship.x || 0),
    (ship.y || 0) - inset,
    height - inset - (ship.y || 0)
  );
  if (!Number.isFinite(margin)) return 1;
  if (margin >= KITE_EDGE_BUFFER_MIN) return 0;
  return clampNumber(1 - margin / KITE_EDGE_BUFFER_MIN, 0, 1);
}

// The bearing from the hull toward the middle of the map. Only ever used as a
// bias, never as a destination: "inward" is a tie-breaker among escape
// headings, not somewhere Kite is trying to go.
function kiteInwardBearing(room, ship) {
  const width = room?.world?.width || WORLD.width;
  const height = room?.world?.height || WORLD.height;
  return Math.atan2(height / 2 - (ship.y || 0), width / 2 - (ship.x || 0));
}

// How far ahead a retreat aim point is placed. Enough that the hull always has
// somewhere to be going, and never less than it takes to stop from the speed it
// is carrying -- a point closer than the stopping distance is a point the ship
// is already committed past.
function kiteEscapeLookahead(ship, stats) {
  const speed = fastHypot(ship.vx || 0, ship.vy || 0);
  const deceleration = Math.max(1, brakingAcceleration(stats));
  const stopping = speed * speed / (2 * deceleration)
    + speed * ORBIT_AVOIDANCE_REACTION_TIME
    + routeClearance(ship) * 2;
  return Math.max(
    KITE_ESCAPE_LOOKAHEAD_MIN,
    speed * KITE_ESCAPE_LOOKAHEAD_SECONDS,
    stopping
  );
}

function kiteProjectedPoint(ship, heading, distance) {
  return {
    x: (ship.x || 0) + Math.cos(heading) * distance,
    y: (ship.y || 0) + Math.sin(heading) * distance
  };
}

// Offsets a candidate heading is generated at, around each base bearing. Fixed
// and ordered, so the candidate list -- and therefore the choice -- is the same
// every time the same geometry is presented.
const KITE_HEADING_OFFSETS = Object.freeze([
  0,
  Math.PI / 12,
  -Math.PI / 12,
  Math.PI / 6,
  -Math.PI / 6,
  Math.PI / 4,
  -Math.PI / 4,
  Math.PI / 3,
  -Math.PI / 3,
  Math.PI / 2,
  -Math.PI / 2
]);

// How many candidates are scored against the weapons. The geometric pass is
// cheap and the coverage pass is not, so the list is cut to the best geometry
// first; this is a cost bound, not a behaviour choice.
const KITE_HEADING_COVERAGE_LIMIT = 12;
// ...and how many of them are worth a path search when none of them has a clear
// straight run.
const KITE_ROUTED_CANDIDATE_LIMIT = 3;

// Every hull heading worth considering.
//
// The straight-away, tangent and straight-toward bearings are the geometry of
// the problem; the current hull heading and the one already committed to are
// what continuity is measured against; and each main-battery gun contributes
// the hull heading that would put its own mount on the target plus the two
// edges of its own arc. That last family is the whole point: it is what lets a
// rear-mounted gun's ideal heading -- straight away from the target -- be
// discovered as a heading that both escapes and shoots.
function kiteCandidateHeadings(ship, runtime, awayBearing, profile) {
  const headings = [];
  const add = (angle) => {
    const value = normalizeHullAngle(angle);
    if (!Number.isFinite(value)) return;
    for (const existing of headings) {
      if (Math.abs(angleDifference(existing, value)) < 1e-4) return;
    }
    headings.push(value);
  };

  const previous = Number(runtime.kiteHeading);
  const bases = [awayBearing];
  if (Number.isFinite(previous)) bases.push(previous);
  for (const base of bases) {
    for (const offset of KITE_HEADING_OFFSETS) add(base + offset);
  }
  add(ship.angle || 0);
  // Straight at the target: the heading a nose gun wants, and the one a drift
  // back toward the band is flown on.
  add(awayBearing + Math.PI);

  // idealHullHeading = (bearing from the mount to the target) - (the mount's own
  // blueprint-relative facing). Taken from the hull centre, because the mount's
  // world position is itself a function of the heading being solved for; over
  // the distances Kite fights at the difference is a fraction of a degree, and
  // the coverage pass below measures the real mount position anyway.
  const targetBearing = awayBearing + Math.PI;
  for (const weapon of profile.weapons) {
    const centre = targetBearing - weapon.mountAngle;
    add(centre);
    if (weapon.arcRadians < Math.PI * 2 - 1e-6) {
      add(centre - weapon.arcRadians / 2);
      add(centre + weapon.arcRadians / 2);
    } else if (weapon.mountOffset > 1e-6) {
      // A full-circle turret has no arc to generate candidates from, but its
      // coverage still moves with the heading: rotating the hull swings the
      // mount between the near and the far side of the target.
      add(targetBearing - weapon.mountOffsetAngle);
    }
  }
  return headings;
}

// Can this heading serve the requested change in range at all?
//
// In a retreat the answer has to be yes with room to spare: a heading that
// barely opens the range is not an escape. Elsewhere it only has to point the
// right way -- and when the controller is asking for no change at all, any
// heading will do and the weapons decide.
function kiteProjectionUsable(mode, need, projection) {
  if (mode === "retreat") return projection > KITE_MIN_ESCAPE_PROJECTION;
  if (need > REST_SPEED) return projection > KITE_MIN_ESCAPE_PROJECTION;
  if (need < -REST_SPEED) return projection < -KITE_MIN_ESCAPE_PROJECTION;
  return true;
}

// A desired opening speed becomes a ship speed by dividing out how much of this
// heading actually points along the radius. The floor is what keeps a nearly
// tangential heading from asking for infinite thrust; the result is always a
// non-negative FORWARD speed, because that is the only kind this model has.
function kiteForwardSpeed(need, projection, available) {
  const along = Math.max(Math.abs(projection), KITE_MIN_ESCAPE_PROJECTION);
  const speed = Math.abs(need) / along;
  return clampNumber(Number.isFinite(speed) ? speed : 0, 0, available);
}

// Rank two candidates. Deterministic to the last comparison: equal scores fall
// back to the smaller turn and then to the numerically smaller heading, so two
// mirror-image escape routes always resolve the same way rather than by
// whichever the loop happened to see first.
function kiteCandidateBetter(candidate, best) {
  if (!best) return true;
  if (candidate.score > best.score + 1e-6) return true;
  if (candidate.score < best.score - 1e-6) return false;
  if (candidate.turn < best.turn - 1e-6) return true;
  if (candidate.turn > best.turn + 1e-6) return false;
  return candidate.heading < best.heading;
}

// What a heading is worth before the weapons have been asked.
//
// Escaping, staying off the wall, having a clear run and not spending the next
// second turning. Coverage is added on top of this for the shortlist only,
// because it is the expensive question.
//
// `relaxed` is the cornered case, and it is scored on completely different
// terms. There, by construction, no heading opens the range at all -- every one
// that would leaves the map -- so ranking by outward projection ranks a set of
// equally useless options and picks a different one each time the geometry
// shifts by a pixel. What matters when pinned is getting back into open water:
// how far inward the heading points, and how much room it actually has. Ranking
// by those is what makes the choice stable long enough to act on.
function kiteGeometryScore(context, heading, projection, direct, options = null) {
  const turn = Math.abs(angleDifference(context.hullAngle, heading));
  const inward = Math.cos(angleDifference(context.inwardBearing, heading));
  const sided = context.escapeSide !== 0
    && Math.sign(angleDifference(context.awayBearing, heading)) === context.escapeSide;
  if (options?.relaxed) {
    const room = clampNumber((Number(options.run) || 0) / Math.max(1, Number(options.lookahead) || 1), 0, 1);
    return 1200 * inward
      + 400 * room
      + (sided ? 120 : 0)
      - 60 * (turn / Math.PI);
  }
  const alignment = context.mode === "retreat"
    ? projection
    : projection * Math.sign(Math.abs(context.need) > REST_SPEED ? context.need : 0);
  return (context.mode === "retreat" ? 1200 : 200) * alignment
    + (direct ? 300 : 0)
    + 600 * KITE_EDGE_INWARD_BIAS * context.edgePressure * inward
    + (sided ? 120 : 0)
    - 60 * (turn / Math.PI);
}

// Try to turn a heading into somewhere the hull could actually fly.
//
// A candidate has to end inside the navigable inset, on ground the hull could
// occupy, and be reachable -- directly if the run is clear, otherwise through
// the shared static route search, which is the same planner every other order
// uses. `relaxed` is the corner case: pinned into a boundary, the run is allowed
// to be cut short at the inset provided it still has somewhere to go, because
// getting back into open water outranks both range and firing.
function kiteDestinationFor(room, ship, heading, options) {
  const { lookahead, inset, clearance, relaxed, allowRouted, pinched } = options;
  const insetRun = kiteInsetRun(room, ship, heading, inset);
  let distance = Math.min(lookahead, insetRun);
  if (!relaxed && distance < lookahead - 1e-6) return null;
  if (relaxed) distance = Math.min(lookahead, Math.max(0, insetRun));
  if (!(distance >= clearance * 2)) return null;

  const point = kiteProjectedPoint(ship, heading, distance);
  if (!insideKiteInset(room, point.x, point.y, inset)) return null;
  if (isSegmentClear(room, ship.x, ship.y, point.x, point.y, clearance)) {
    return { x: point.x, y: point.y, direct: true, run: distance };
  }
  // The hull has drifted inside its own planning envelope -- parked against a
  // rock, shoved there, or spawned there. Every segment out of it is "blocked"
  // by construction, including the ones that lead to open water, so insisting on
  // the padded envelope here traps the ship permanently. Fall back to the
  // physical hull margin, which is the same allowance the braking ceiling makes
  // for the same situation, and let that ceiling hold it to a crawl until it is
  // out and an ordinary plan can be made.
  if (pinched && isSegmentClear(room, ship.x, ship.y, point.x, point.y, physicalCollisionRadius(ship))) {
    return { x: point.x, y: point.y, direct: true, run: distance };
  }
  if (!allowRouted) return null;
  // The straight run is obstructed. The point itself still has to be ground the
  // hull could sit on -- a destination inside an asteroid or a station is not a
  // destination -- and then the shared planner decides whether there is a way
  // round to it.
  const clear = nearestClearPoint(room, point.x, point.y, clearance);
  if (!clear.clear || fastHypot(clear.x - point.x, clear.y - point.y) > clearance) return null;
  if (!insideKiteInset(room, clear.x, clear.y, inset)) return null;
  const search = searchPathWorld(room, ship.x, ship.y, clear.x, clear.y, clearance, {
    minimumClearance: clearance,
    preferredClearance: clearance + KITE_ROUTE_PAD
  });
  if (!search.reachedGoal) return null;
  return { x: clear.x, y: clear.y, direct: false, run: distance };
}

// Choose the heading to fly and the place to fly it to.
//
// Two passes on purpose. The geometric pass is a handful of cheap tests and it
// is what decides feasibility; the coverage pass measures what the main battery
// could do from each surviving heading, and it is only ever run on a shortlist
// and on a cadence. A path search happens only when nothing has a clear run,
// which in open space is never.
function chooseKitePlan(room, ship, runtime, target, stats, mode, context, now) {
  const clearance = routeClearance(ship);
  const inset = kiteEdgeInset(ship);
  const lookahead = kiteEscapeLookahead(ship, stats);
  const headings = kiteCandidateHeadings(ship, runtime, context.awayBearing, context.profile);
  // Is the hull already inside its own planning envelope? Asked once, as a
  // zero-length segment at the ship's own position, because it changes what
  // "clear" has to mean for every candidate below.
  const pinched = !isSegmentClear(room, ship.x, ship.y, ship.x, ship.y, clearance);

  const collect = (relaxed) => {
    const found = [];
    for (const heading of headings) {
      const projection = Math.cos(angleDifference(context.awayBearing, heading));
      if (!relaxed && !kiteProjectionUsable(mode, context.need, projection)) continue;
      // Pinned, the only headings worth having are the ones that take the ship
      // back toward open space. Without this the relaxed pass considers the
      // whole circle, including the headings that put the hull further into the
      // corner it is trying to leave.
      if (relaxed
        && !(Math.cos(angleDifference(context.inwardBearing, heading)) > 0.1)) continue;
      const destination = kiteDestinationFor(room, ship, heading, {
        lookahead,
        inset,
        clearance,
        relaxed,
        pinched,
        allowRouted: false
      });
      if (!destination) continue;
      found.push({
        heading,
        projection,
        destination,
        turn: Math.abs(angleDifference(context.hullAngle, heading)),
        score: kiteGeometryScore(context, heading, projection, true, {
          relaxed,
          run: destination.run,
          lookahead
        })
      });
    }
    return found;
  };

  // Straight runs first. An obstructed one costs a path search, so it is only
  // worth having when there is no clear escape at all.
  let candidates = collect(false);
  let routed = false;
  if (!candidates.length) {
    const ranked = [];
    for (const heading of headings) {
      const projection = Math.cos(angleDifference(context.awayBearing, heading));
      if (!kiteProjectionUsable(mode, context.need, projection)) continue;
      ranked.push({
        heading,
        projection,
        turn: Math.abs(angleDifference(context.hullAngle, heading)),
        score: kiteGeometryScore(context, heading, projection, false)
      });
    }
    ranked.sort((a, b) => (kiteCandidateBetter(a, b) ? -1 : 1));
    for (const candidate of ranked.slice(0, KITE_ROUTED_CANDIDATE_LIMIT)) {
      const destination = kiteDestinationFor(room, ship, candidate.heading, {
        lookahead,
        inset,
        clearance,
        relaxed: false,
        pinched,
        allowRouted: true
      });
      if (!destination) continue;
      candidates.push({ ...candidate, destination });
      routed = true;
    }
  }
  if (!candidates.length) {
    // Boxed into a boundary or a corner. Every direction that opens the range
    // leaves the map, so the gate comes off and the best short inward run wins;
    // losing range for a moment is the correct trade against being pinned.
    candidates = collect(true);
  }
  if (!candidates.length) return null;

  candidates.sort((a, b) => (kiteCandidateBetter(a, b) ? -1 : 1));
  const shortlist = candidates.slice(0, KITE_HEADING_COVERAGE_LIMIT);
  const totalOutput = Math.max(1e-6, Number(context.profile.output) || 0);
  const previousHeading = Number(runtime.kiteHeading);
  let best = null;
  let incumbent = null;
  for (const candidate of shortlist) {
    const coverage = combat().evaluateMainBatteryFacing(room, ship, target, candidate.heading, now);
    const share = clampNumber((Number(coverage.output) || 0) / totalOutput, 0, 1);
    // Escaping outranks shooting inside the danger band, and shooting outranks
    // fine range control outside it. Both are the same two terms with the
    // weights the other way round -- there is no separate retreat controller.
    const weight = mode === "retreat" ? 250 : 1000;
    const scored = { ...candidate, score: candidate.score + weight * share, coverage: share };
    if (kiteCandidateBetter(scored, best)) best = scored;
    if (Number.isFinite(previousHeading)
      && Math.abs(angleDifference(previousHeading, scored.heading)) < 1e-4) incumbent = scored;
  }
  if (!best) return null;

  // Heading hysteresis, measured inside ONE scoring pass rather than against a
  // score kept from an earlier tick -- scores are relative to the geometry they
  // were computed in and mean nothing across ticks. The heading already being
  // flown stands unless the alternative is materially better by this much; two
  // mirror-image escape routes score within a hair of each other, and a ship
  // that takes whichever is ahead this tick spends the fight weaving.
  if (incumbent && best !== incumbent
    && best.score <= incumbent.score + KITE_HEADING_IMPROVEMENT_RATIO * Math.abs(incumbent.score)) {
    best = incumbent;
  }

  return {
    targetId: String(target.id),
    targetX: Number(target.x) || 0,
    targetY: Number(target.y) || 0,
    mode,
    heading: best.heading,
    destination: { x: best.destination.x, y: best.destination.y },
    direct: best.destination.direct,
    coverage: best.coverage,
    score: best.score,
    plannedAt: now,
    replanAt: now + KITE_ESCAPE_REPLAN_MS,
    escapeSide: Math.sign(angleDifference(context.awayBearing, best.heading)) || 0,
    preferredRange: context.ranges.preferred,
    innerRange: context.ranges.inner,
    outerRange: context.ranges.outer,
    routed
  };
}

// Is a plan still worth flying? Cheap enough to ask on a cadence, and never on
// a plan that has just been made.
//
// A committed detour is deliberately NOT re-tested against the straight line:
// that line goes clear while the hull is still beside the obstacle, and dropping
// the detour there is what walks a ship back into the rock it was halfway round.
// The route planner owns a routed plan until it is replanned.
function kitePlanFlyable(room, ship, plan, inset, clearance) {
  if (!plan?.destination) return false;
  if (!Number.isFinite(plan.destination.x) || !Number.isFinite(plan.destination.y)) return false;
  if (!insideKiteInset(room, plan.destination.x, plan.destination.y, inset)) return false;
  if (!plan.direct) return true;
  return isSegmentClear(room, ship.x, ship.y, plan.destination.x, plan.destination.y, clearance);
}

// Kite's forward-collision ceiling. Identical to Orbit's in every respect but
// one: the crawl out of a pinch is measured against the bare hull. A kiting ship
// that has ended up inside its own envelope is trying to LEAVE, and at a gap
// narrower than the padded margin no direction reads as open, so the padded test
// would answer "stop" whichever way it pointed and hold it there permanently.
function kiteBrakingCeiling(room, ship, stats) {
  return staticObstacleBrakingCeiling(room, ship, stats, {
    escapeClearance: physicalCollisionRadius(ship)
  });
}

// The band this ship would hold around this target. Pure: it reads no runtime
// state and changes none, which is what makes it safe to ask from outside the
// controller -- tests and diagnostics use it to check the band without having
// to fly a ship to find out what it is.
function kiteRangeBand(ship, target) {
  const profile = combat().mainBatteryProfile(ship);
  const band = kiteRanges(profile.standoffRange, engagementGeometry(ship, target).contact);
  return { ...band, battery: profile.standoffRange };
}

// One tick of Kite. Chooses the tactical mode, the heading, the aim point and
// the speed ceiling; it fires nothing and latches nothing.
function planKite(room, ship, runtime, target, stats, now) {
  const targetId = String(target.id);
  if (runtime.kiteTargetId !== targetId) {
    // A different target. The band, the heading, the escape side and the route
    // were all chosen for the old one and none of them means anything now --
    // inheriting them is what makes a ship reverse to get back onto a ring it
    // planned around something else.
    clearKiteSteering(runtime);
    runtime.kiteTargetId = targetId;
  }
  runtime.kiteSteering = true;

  const profile = combat().mainBatteryProfile(ship);
  const geometry = engagementGeometry(ship, target);
  const distance = geometry.distance;
  const ranges = kiteRanges(profile.standoffRange, geometry.contact);
  const toggles = movementToggles(ship);

  const attackPoint = targetAttackPointFrom(ship.x || 0, ship.y || 0, target);
  let awayX = (ship.x || 0) - attackPoint.x;
  let awayY = (ship.y || 0) - attackPoint.y;
  if (!(fastHypot(awayX, awayY) > BEARING_MIN_DISTANCE)) {
    // Standing on the target: there is no radial to work from, so take one off
    // the nose and let the band push the ship out along it.
    awayX = Math.cos(ship.angle || 0);
    awayY = Math.sin(ship.angle || 0);
  }
  const awayBearing = Math.atan2(awayY, awayX);

  const radial = radialSeparationSpeed(ship, target, distance);
  const predicted = kitePredictedDistance(ship, target, distance);
  const pressed = kiteUnderPressure(ranges, distance, predicted, radial);

  // --- Mode ---------------------------------------------------------------
  //
  // The hysteresis is in the two "keep doing what you were doing" clauses: a
  // retreat runs until the preferred range is back, not until the inner one is
  // scraped, and an approach closes to preferred rather than releasing the
  // moment the outer band is crossed. Without them a one-pixel range change at
  // a band edge flips the mode every tick.
  const previousMode = runtime.kiteMode;
  let mode;
  if (pressed) mode = "retreat";
  else if (previousMode === "retreat" && distance < ranges.preferred) mode = "retreat";
  else if (distance > ranges.outer) mode = toggles.pursue ? "approach" : "maintain";
  else if (previousMode === "approach" && toggles.pursue && distance > ranges.preferred) mode = "approach";
  else mode = "maintain";
  // Line of sight is a reason to move somewhere else, never a reason to close.
  // It is also only ever asked once the ship is not being pressed: running from
  // something at knife range matters more than being able to see it.
  if (mode === "maintain" && !currentFiringLineClear(room, ship, target)) mode = "reposition";

  // --- Approach and reposition -------------------------------------------
  //
  // Both are "go and stand somewhere useful", which is the problem the shared
  // firing-position search already solves: a reachable point at the band's
  // preferred range with a clear line to the target, chosen on the side of the
  // target this ship already occupies. The route planner flies the hull there
  // nose-first; the weapon-facing heading takes over once the band is reached.
  if (mode === "approach" || mode === "reposition") {
    runtime.kiteMode = mode;
    runtime.kiteDirect = false;
    runtime.kitePlan = null;
    runtime.kiteHeading = null;
    runtime.kiteSpeedLimit = kiteBrakingCeiling(room, ship, stats);
    const destination = reachableFiringPosition(
      room, ship, target, runtime, ranges.preferred, ranges.preferred, now
    );
    if (destination) {
      runtime.destination = destination;
      runtime.blocked = false;
      return;
    }
    runtime.kiteMode = "blocked";
    runtime.kiteSpeedLimit = 0;
    runtime.destination = null;
    runtime.blocked = true;
    clearRoute(runtime);
    return;
  }

  // --- Retreat and maintain ----------------------------------------------
  const available = kiteAvailableSpeed(ship, stats);
  const need = kiteDesiredOpeningSpeed(mode, ranges, distance, radial, available, toggles);
  const inset = kiteEdgeInset(ship);
  const clearance = routeClearance(ship);
  const context = {
    mode,
    need,
    ranges,
    profile,
    awayBearing,
    hullAngle: ship.angle || 0,
    inwardBearing: kiteInwardBearing(room, ship),
    edgePressure: kiteEdgePressure(room, ship, inset),
    escapeSide: Number(runtime.kiteEscapeSide) || 0
  };

  const existing = runtime.kitePlan;
  const targetMoved = existing
    ? fastHypot(
      (Number(target.x) || 0) - (Number(existing.targetX) || 0),
      (Number(target.y) || 0) - (Number(existing.targetY) || 0)
    )
    : Infinity;
  let plan = existing
    && existing.targetId === targetId
    && existing.mode === mode
    && now < (Number(existing.replanAt) || 0)
    && targetMoved <= KITE_TARGET_MOVE_REPLAN
    ? existing
    : null;

  // A committed plan is re-checked on a cadence, never per tick. What makes the
  // delay safe is the braking ceiling below, which is evaluated every tick
  // against the direction the hull is actually travelling.
  if (plan && now >= (Number(runtime.kiteScanAt) || 0)) {
    runtime.kiteScanAt = now + KITE_CLEAR_SCAN_MS;
    if (!kitePlanFlyable(room, ship, plan, inset, clearance)) plan = null;
  }

  if (!plan && now >= (Number(runtime.kiteReplanAt) || 0)) {
    // chooseKitePlan carries the heading hysteresis itself, against the heading
    // in the runtime, so a replan that finds nothing materially better returns
    // the heading already being flown rather than a new one.
    plan = chooseKitePlan(room, ship, runtime, target, stats, mode, context, now);
    if (plan) {
      runtime.kiteScanAt = now + KITE_CLEAR_SCAN_MS;
    } else {
      runtime.kiteReplanAt = now + KITE_BLOCKED_RETRY_MS;
      // Nothing new could be found, but a plan that is merely due for review and
      // is still flyable is better than stopping. Keep flying it and try again
      // on the retry cadence -- this is what stops a ship halfway round an
      // obstacle abandoning its detour because the moment was briefly awkward.
      if (existing
        && existing.targetId === targetId
        && existing.mode === mode
        && kitePlanFlyable(room, ship, existing, inset, clearance)) {
        existing.replanAt = now + KITE_BLOCKED_RETRY_MS;
        plan = existing;
      }
    }
  }

  // A clear Kite aim point is a moving tactical bearing, not a place: it is
  // regenerated ahead of the hull every tick and never reached, so arrival
  // braking must not apply to it. A committed detour is the opposite -- a real
  // routed destination with the ordinary corner and arrival limits in force.
  //
  // Regenerating it is not a free extension of the old one. The hull has moved
  // since the plan was made, so the same heading now runs out of map sooner;
  // pushing the point out blindly is exactly how an aim point ends up outside
  // the navigable inset and steers a ship at the wall. It is clipped to the run
  // the inset still allows, and a run too short to be worth flying retires the
  // plan on the spot rather than next time the cadence comes round.
  if (plan && plan.direct) {
    const run = Math.min(
      kiteEscapeLookahead(ship, stats),
      kiteInsetRun(room, ship, plan.heading, inset)
    );
    if (run >= clearance * 2) plan.destination = kiteProjectedPoint(ship, plan.heading, run);
    else plan = null;
  }

  if (!plan) {
    // Nowhere safe to go. Brake, keep whatever heading was last chosen so the
    // guns that still bear go on bearing, and look again on the retry cadence.
    // Driving on would be driving into the obstacle.
    runtime.kiteMode = "blocked";
    runtime.kitePlan = null;
    runtime.kiteDirect = false;
    runtime.kiteSpeedLimit = 0;
    runtime.destination = null;
    runtime.blocked = true;
    // Not a backoff: an aim point that ran out of map is a reason to choose a
    // new heading immediately, and the mode-and-target gate above already stops
    // that becoming a per-tick search.
    runtime.kiteReplanAt = 0;
    clearRoute(runtime);
    return;
  }

  runtime.kitePlan = plan;
  runtime.kiteMode = mode;
  runtime.kiteHeading = plan.heading;
  runtime.kiteEscapeSide = plan.escapeSide;
  runtime.blocked = false;
  runtime.kiteReplanAt = 0;
  runtime.destination = { x: plan.destination.x, y: plan.destination.y };
  runtime.kiteDirect = Boolean(plan.direct);

  const projection = Math.cos(angleDifference(awayBearing, plan.heading));
  const desired = kiteForwardSpeed(need, projection, available);
  if (!(desired > REST_SPEED)) {
    // The CONTROLLER is asking for no travel -- the range is where it wants it,
    // or Pursue is off and the target has simply left. Hold station on the
    // chosen heading: a null destination is what makes planMovement park the
    // hull and point it, and pointing it is still the whole job.
    //
    // Deliberately distinct from the braking ceiling below pulling the speed to
    // zero, which is an instruction to slow down, not to stop wanting to go
    // anywhere. Conflating the two makes a pinched ship alternate between
    // "accelerate" and "park", which cancels its own escape velocity every
    // other tick and holds it against the obstacle indefinitely.
    runtime.destination = null;
    runtime.kiteDirect = false;
    runtime.kiteSpeedLimit = 0;
    clearRoute(runtime);
    return;
  }
  runtime.kiteSpeedLimit = Math.min(desired, kiteBrakingCeiling(room, ship, stats));
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
    clearKiteSteering(runtime);
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
    clearKiteSteering(runtime);
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
    clearKiteSteering(runtime);
    planOrbit(room, ship, runtime, target, stats, now);
    return;
  }
  clearOrbitSteering(runtime);

  // Kite branches here for the same reason Orbit does, and with the same one
  // qualification: it needs a main battery to hold a band around. A hull with no
  // usable ranged weapon has nothing to kite at, so it falls through to Hold
  // rather than inventing a radius and fleeing forever.
  if (type === "attack" && combatStance(ship) === "kite"
    && combat().mainBatteryProfile(ship).standoffRange > 0) {
    runtime.holdEngaged = false;
    runtime.chargeEngaged = false;
    runtime.ramming = false;
    runtime.holdCoverageRange = 0;
    runtime.attackLane = null;
    runtime.arrivalRadius = ARRIVE_DISTANCE;
    planKite(room, ship, runtime, target, stats, now);
    return;
  }
  clearKiteSteering(runtime);

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
  if (ship?.movement?.orbitAvoidance) return base + ORBIT_AVOIDANCE_ROUTE_PAD;
  // A Kite detour is flown under exactly the same conditions -- momentum, hard
  // braking, round the outside of a corner -- so it gets the same wider
  // envelope. A Kite ship steering directly through open space does not: that
  // is ordinary travel and the ordinary margin is what it is for.
  if (ship?.movement?.kitePlan && ship.movement.kitePlan.direct === false) return base + KITE_ROUTE_PAD;
  return base;
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

// Where a parked ship points, in priority order: a facing the player explicitly
// asked for, then the heading the hull actually settled on, then whatever it is
// pointing at right now. The latched arrival heading is what stops a ship that
// detoured round an obstacle from swinging back onto the bearing its route was
// originally planned with, which reads as a spontaneous turn on the spot.
function restingHeading(ship, runtime, command) {
  // A hand aim first, ahead even of the order's own final facing: the player
  // turned this hull after the order was given, and that is the later word.
  if (Number.isFinite(runtime?.manualFacing)) return runtime.manualFacing;
  if (Number.isFinite(command?.finalFacing)) return command.finalFacing;
  if (Number.isFinite(runtime?.arrivalHeading)) return runtime.arrivalHeading;
  return ship.angle || 0;
}

// Called once, on the tick the hull settles. `ship.angle` here is the heading
// the turn integrator left it on, which is the real arrival heading -- not the
// route's planned direction, and not anything the stance has yet touched.
function latchArrivalHeading(ship, runtime) {
  if (!runtime || Number.isFinite(runtime.arrivalHeading)) return;
  runtime.arrivalHeading = normalizeHullAngle(Number(ship.angle) || 0);
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

// Where a ship that has stopped points. An engagement the player asked for --
// an Attack or Repair order, or a stance actively flying its own solution --
// outranks the resting heading, because refusing to look at the thing it was
// sent to fight is not what the order was for.
//
// An AUTOMATICALLY acquired target does not, once a plain Move has been carried
// out. A right-click on empty space says go there and stop; letting a target the
// player never picked take the helm on the arrival tick is what spins a ship
// through 180 degrees the instant it parks, for a reason nothing on screen
// explains. Either way this is orientation only -- it never moves a ship off the
// point it was sent to.
function stationaryHeading(room, ship, runtime, command) {
  // Aimed by hand with I/O. Nothing below may take it back, or the keys do
  // nothing on any ship that has an enemy in sight -- which is most of them.
  if (Number.isFinite(runtime?.manualFacing)) return runtime.manualFacing;
  const heading = movementToggles(ship).autoTurn
    ? combatFacingHeading(room, ship, runtime)
    : null;
  if (Number.isFinite(heading)) {
    // The fight owns the nose now. Drop the heading the ship arrived on: keeping
    // it would give the hull somewhere to snap back to the moment the target is
    // gone, which is the turn-out-and-turn-back nobody asked for.
    runtime.arrivalHeading = null;
    runtime.combatFacingHeld = true;
    return heading;
  }
  if (runtime?.combatFacingHeld) {
    // Whatever it was facing has been dealt with, or lost. Stand where the fight
    // left the hull pointing rather than unwinding to a pre-fight heading.
    runtime.combatFacingHeld = false;
    runtime.arrivalHeading = normalizeHullAngle(Number(ship.angle) || 0);
  }
  return restingHeading(ship, runtime, command);
}

// The heading an engagement wants a stopped ship to hold, or null when no
// engagement is asking for one.
function combatFacingHeading(room, ship, runtime) {
  if (combatStance(ship) === "sentry") return null;
  const engaged = engagementTarget(room, ship, runtime);
  if (!engaged || (engaged.explicit === false && completedPlainMove(runtime))) return null;
  if (engaged.type === "attack" && combatStance(ship) === "hold" && runtime.holdEngaged) {
    return holdWeaponFacingHeading(room, ship, runtime, engaged.target);
  }
  // A Kite ship holding its band, or braking because there is nowhere safe
  // to go, is still flying a stance. Facing the target here would undo the
  // whole point of the heading the controller chose -- a rear-mounted gun
  // would be swung off the target it is already covering.
  if (engaged.type === "attack" && runtime.kiteSteering
    && Number.isFinite(Number(runtime.kiteHeading))) {
    return Number(runtime.kiteHeading);
  }
  const point = targetAttackPointFrom(ship.x || 0, ship.y || 0, engaged.target);
  if (fastHypot(point.x - (ship.x || 0), point.y - (ship.y || 0)) > BEARING_MIN_DISTANCE) {
    return bearingTo(ship, point);
  }
  return null;
}

// A Move order the ship has already carried out. The distinction that matters
// for facing: this ship is standing where the player put it, under no order to
// fight anything.
function completedPlainMove(runtime) {
  return runtime?.command?.type === "move" && Boolean(runtime.orderComplete);
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
  const resting = { desiredHeading: restingHeading(ship, runtime, command), desiredSpeed: 0 };
  if (command?.type === "stop") {
    const engaged = movementToggles(ship).autoTurn && !Number.isFinite(runtime.manualFacing)
      ? engagementTarget(room, ship, runtime)
      : null;
    const point = engaged ? targetAttackPointFrom(ship.x, ship.y, engaged.target) : null;
    const distance = point ? fastHypot(point.x - ship.x, point.y - ship.y) : 0;
    return {
      desiredHeading: point && distance > BEARING_MIN_DISTANCE
        ? bearingTo(ship, point)
        : restingHeading(ship, runtime, null),
      desiredSpeed: 0,
      // Still braking while it is still moving, whichever way that is relative
      // to the nose: a hull sliding sideways has not stopped.
      phase: fastHypot(ship.vx || 0, ship.vy || 0) > REST_SPEED ? "braking" : "positioned"
    };
  }

  const destination = runtime.destination;
  if (!destination) {
    const engaged = combatStance(ship) !== "sentry"
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
    // Before stationaryHeading gets a say: this is the last tick on which
    // ship.angle is still purely the product of flying the route there.
    latchArrivalHeading(ship, runtime);
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
  // ...and a Kite aim point in open space is the same kind of thing: a tactical
  // bearing regenerated ahead of the hull, never reached. Braking for it would
  // have a running ship stop every few hundred pixels. A committed Kite detour
  // is a real routed place and deliberately does not qualify.
  const aimingAtBearing = (Boolean(runtime.orbitSteering) && Boolean(runtime.orbitDirect))
    || (Boolean(runtime.kiteSteering) && Boolean(runtime.kiteDirect));
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
  // What the Kite radial controller asked for this tick, already reduced by the
  // static braking ceiling. Gated on `kiteSteering` for the same reason Orbit's
  // is: a legitimate ceiling of zero and "this ship is not kiting" are different
  // instructions and must not share a sentinel.
  const kiteSpeedLimit = runtime.kiteSteering
    ? Math.max(0, Number(runtime.kiteSpeedLimit) || 0)
    : Infinity;
  const permitted = Math.min(
    ownMaxSpeed,
    ramming || aimingAtBearing ? Infinity : safeArrivalSpeed,
    ramming || aimingAtBearing ? Infinity : turnLimit,
    route ? route.cornerLimit : Infinity,
    route ? route.orbitLimit : Infinity,
    blockedLimit,
    orbitSpeedLimit,
    kiteSpeedLimit
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
  // A hand aim is a thing you do to a ship that is standing still. Once it is
  // flying somewhere -- the player's order or a stance's own solution -- the
  // nose belongs to the course, and holding the old angle in reserve would
  // spring it back on arrival for no reason the player could see.
  if (runtime.destination && !runtime.arrived && !ship.manualRotation) {
    runtime.manualFacing = null;
  }
  const route = routed ? routeView(room, ship, runtime, stats) : null;
  const plan = planMovement(room, ship, runtime, stats, route);
  runtime.desiredHeading = plan.desiredHeading;
  runtime.desiredSpeed = plan.desiredSpeed;
  if (ship.manualRotation) {
    applyManualRotation(ship, runtime, stats, dt);
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
    clearKiteSteering(runtime);
    clearRoute(runtime);
  } else if (authority === "position") {
    runtime.holdEngaged = false;
    runtime.chargeEngaged = false;
    runtime.blocked = false;
    clearOrbitSteering(runtime);
    clearKiteSteering(runtime);
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
  // Kite's open-space aim point is the same case: planKite has already checked
  // the run is clear, and the point moves with the hull, so handing it to the
  // route planner would invalidate and rebuild a route every tick for a leg
  // already known to be flyable. A Kite DETOUR is routed, exactly like any other
  // destination.
  const directKite = Boolean(runtime.kiteDirect) && Boolean(runtime.destination);
  const direct = directCharge || directOrbit || directKite;
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
  // After the step, so a leg that completed on this tick hands the next one over
  // on the same tick rather than parking the hull for a frame between waypoints.
  advanceQueuedWaypoint(room, ship, runtime);
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

// Hand a single ship the next leg of the course it was given, once it has
// finished the one it is flying.
//
// The queue is advanced here, on the ship, rather than by the command that
// filled it, because "finished" is a fact only the controller has: the order
// completes when the hull actually settles on the point, not when the route to
// it was planned. A leg the planner could not reach is also finished -- but only
// once the ship has flown out the partial route and stopped on its end, which is
// what `arrived` distinguishes. Advancing on `blocked` alone would drain the
// whole course in one tick every time a route was momentarily unroutable.
function advanceQueuedWaypoint(room, ship, runtime) {
  const queue = runtime.queuedWaypoints;
  if (!Array.isArray(queue) || queue.length === 0) return false;
  // Anything that is not the move this queue was built behind has taken the
  // helm -- an attack order, a stop, a rally. The course is not resumed after it.
  if (runtime.command?.type !== "move") {
    runtime.queuedWaypoints = [];
    return false;
  }
  if (!runtime.orderComplete && !(runtime.blocked && runtime.arrived)) return false;
  const next = queue[0];
  // setMovementCommand clears the queue, as it must for every other caller, so
  // the remainder is carried across the call by hand.
  const remaining = queue.slice(1);
  issueMove(ship, nextMovementCommandId(room, "m"), next, {
    arrivalRadius: ARRIVE_DISTANCE,
    manual: true
  });
  runtime.queuedWaypoints = remaining;
  return true;
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
  // The travelling stances are excluded with Charge: none of them has a position
  // to latch, and none may ever acquire holdEngaged, which is what would park
  // it. A Kite ship in particular is often given the order while already inside
  // the range it is about to run out of.
  const stance = combatStance(ship);
  if (target && stance !== "charge" && stance !== "orbit" && stance !== "kite") {
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

// Where a lone ship is actually sent for a click at (x, y). The formation
// planner is reused for one ship deliberately: with a single slot it is exactly
// "clamp to the world, then walk off anything solid", and borrowing it is what
// keeps a solo move and a one-ship-wide fleet move landing on the same point.
// The plan comes back with the point because commandShips returns it either way
// -- the planned bearing is part of what a caller is told about a move order.
function soloMovePlan(room, ship, x, y) {
  const plan = planFormation(room, [ship], { x, y });
  const slot = plan.slots[0];
  return { plan, point: slot ? { x: slot.x, y: slot.y } : { x, y } };
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

  // One ship, on its own, is steered rather than arranged. It goes to the point
  // that was clicked -- walked clear of geometry, but with no formation slot and
  // no formation record on the order -- and it is the only case that may carry a
  // queue of further legs behind it. A course is drawn for a hull; there is
  // nothing a list of points means to a fleet that a fleet could fly.
  if (ships.length === 1) {
    const ship = ships[0];
    const { plan, point } = soloMovePlan(room, ship, x, y);
    const runtime = ensureMovementRuntime(ship);
    const queue = Array.isArray(runtime.queuedWaypoints) ? runtime.queuedWaypoints : [];
    // Appending only ever extends a move already in progress. With the ship
    // parked, fighting, or under any other order, the first shift-click is the
    // start of a new course rather than a leg added to a finished one.
    const extending = options.append === true
      && runtime.command?.type === "move"
      && runtime.command.manual
      && !runtime.orderComplete;
    if (extending) {
      if (queue.length >= MAX_QUEUED_WAYPOINTS) {
        return { ok: true, code: "queue-full", commanded: 0, queued: queue.length };
      }
      queue.push(point);
      runtime.queuedWaypoints = queue;
      return { ok: true, code: "queued", commanded: 1, queued: queue.length };
    }
    issueMove(ship, commandId, point, {
      arrivalRadius: ARRIVE_DISTANCE,
      finalFacing: Number.isFinite(options.finalFacing) ? options.finalFacing : null,
      manual: true
    });
    return { ok: true, code: "move", commanded: 1, queued: 0, formation: plan.formation, plan };
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
      // Only a heading the player actually asked for. Defaulting this to the
      // formation's planned direction turned every ordinary move into a
      // move-and-then-face order, and the planned direction is the bearing from
      // where the fleet STARTED -- so a ship that detoured, was pushed off line,
      // or braked round a corner arrived and then rotated onto a course it was
      // no longer flying. With this null the hull keeps the heading it arrived
      // on, which for a formation travelling together is the shape's direction
      // anyway, without forcing it back when it isn't.
      finalFacing: Number.isFinite(options.finalFacing) ? options.finalFacing : null,
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
  // The stance itself has changed, so every route-specific tactical decision the
  // old one had made is retired: the Hold latch and facing above, the Charge
  // contact, the Orbit steering, and Kite's band, heading, escape side and speed
  // ceiling. The target and the attack order are deliberately untouched -- a
  // stance change must not cost a ship the fight it is in.
  clearKiteSteering(runtime);
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
  MAX_QUEUED_WAYPOINTS,
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
  kiteRangeBand,
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
  staticObstacleBrakingCeiling,
  stopShips,
  turnTowardHeading,
  updateShipMovement,
  updateShipSeparation
};
