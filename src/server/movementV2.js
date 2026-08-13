"use strict";

// Authoritative ship movement.
//
// movement.js remains the sole external seam. This module composes the internal
// movement responsibilities without changing their authoritative tick order.
// Shared braking remains sourced through calculateBrakingAcceleration in
// movement/propulsion.js.

const {
  ARRIVE_DISTANCE,
  HOLD_COVERAGE_STANDOFF_STEP,
  MAX_MOVEMENT_DT
} = require("./movementTuning");
const { shipHasArmedProximityCharge } = require("./componentData");
const { heatAdjustedMovementStats } = require("./movementCapability");
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
  isSegmentClear,
  nearestClearPoint,
  segmentCircleClearance
} = require("./movementNavigation");
const {
  createMovementRuntime,
  ensureMovementRuntime,
  setMovementCommand,
  syncMovementTarget
} = require("./movementRuntimeV2");
const { bumpMovementMetric } = require("./movementMetrics");
const { mainBatteryProfile, evaluateHoldWeaponCoverage } = require("./mainBattery");
const {
  alignmentThrottle,
  applyManualRotation,
  applyPropulsion,
  brakingAcceleration,
  initializeKinematics,
  integratePosition,
  sanitizeMovementState,
  turnTowardHeading
} = require("./movement/propulsion");
const {
  clearTargetReferences,
  combatStance,
  engagementTarget,
  movementAuthority,
  movementToggles
} = require("./movement/intent");
const {
  attackLaneDestination,
  canEngageFromHere,
  currentFiringLineClear,
  engagementGeometry,
  engagementRanges,
  radialSeparationSpeed,
  reachableFiringPosition,
  targetDistanceFrom
} = require("./movement/engagement");
const {
  clearRoute,
  resolveRoute,
  routeClearance,
  routeView
} = require("./movement/navigation");
const { staticObstacleBrakingCeiling } = require("./movement/obstacleAvoidance");
const {
  clearOrbitSteering,
  orbitStandoff,
  orbitTangent,
  planOrbit
} = require("./movement/orbit");
const {
  clearKiteSteering,
  kiteRangeBand,
  planKite
} = require("./movement/kite");
const {
  holdWeaponFacingHeading,
  planMovement
} = require("./movement/steering");
const {
  FORMATION_TYPES,
  MAX_QUEUED_WAYPOINTS,
  SUPPORTED_MOVEMENT_TYPES,
  advanceQueuedWaypoint,
  applyCombatStyle,
  applyMovementToggles,
  applyOrbitDirection,
  commandShips,
  commandShipsToDestination,
  planFormation,
  rotateShips,
  sanitizeFormationType,
  sharedArrivalRadius,
  stopShips
} = require("./movement/commands");

const MOVEMENT_SUBSTEP = 1 / 60;
const CHARGE_SETTLE_RADIAL_SPEED = 24;
const CHARGE_PURSUE_SPEED = 8;

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
  const coverage = evaluateHoldWeaponCoverage(room, ship, target, heading, now);
  const shortfall = Number(coverage?.shortfall) || 0;
  return shortfall > 0 ? shortfall : 0;
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
    && mainBatteryProfile(ship).standoffRange > 0) {
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

module.exports = {
  FORMATION_TYPES,
  MAX_QUEUED_WAYPOINTS,
  SUPPORTED_MOVEMENT_TYPES,
  alignmentThrottle,
  applyCombatStyle,
  applyMovementToggles,
  applyOrbitDirection,
  applyPropulsion,
  brakingAcceleration,
  commandShips,
  commandShipsToDestination,
  createMovementRuntime,
  integratePosition,
  kiteRangeBand,
  maxFriendlyCorrectionPerTick,
  navigationClearanceRadius,
  nearestClearPoint,
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
