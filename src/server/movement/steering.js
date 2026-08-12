"use strict";

const { angleDifference, fastHypot } = require("../utils");
const { areEntityAllies } = require("../relationships");
const {
  APPROACH_DAMPING_DISTANCE,
  ARRIVE_DISTANCE,
  ARRIVE_LATCH_RATIO,
  DESTINATION_ARRIVE_SPEED,
  REST_SPEED
} = require("../movementTuning");
const { physicalCollisionRadius } = require("../movementCollision");
const { combat } = require("./combatAccess");
const { targetAttackPointFrom } = require("./engagement");
const {
  combatStance,
  engagementTarget,
  movementToggles
} = require("./intent");
const {
  bearingTo,
  flowingThroughLeg,
  maxTurnRate
} = require("./navigation");
const {
  brakingAcceleration,
  momentumRetention,
  normalizeHullAngle
} = require("./propulsion");

const BEARING_MIN_DISTANCE = 1;
const FRIENDLY_REST_SPEED = 4;
const HOLD_FACING_TARGET_REPLAN_DISTANCE = 96;
const HOLD_FACING_REEVALUATE_MS = 250;
const HOLD_FACING_IMPROVEMENT_RATIO = 0.12;

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
  // A leg with another queued behind it is never arrived at. Latching would park
  // the hull, latch an arrival heading and hand the order to the combat stance
  // for the tick it takes the queue to hand over the next leg -- which is the
  // stop-at-every-point crawl a course is supposed to replace. The queue advances
  // on capture instead: see advanceQueuedWaypoint.
  const flowThrough = flowingThroughLeg(runtime);
  const canLatch = (isMove && !flowThrough) || isCharge;
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
  // Braking to a standstill, and slowing enough to be pointed at the goal on
  // reaching it, are both about ARRIVING. A leg the ship is flying through gets
  // neither: what governs its speed there is the turn it has to make onto the
  // next leg, which cornerLimit below has already measured.
  const permitted = Math.min(
    ownMaxSpeed,
    ramming || aimingAtBearing || flowThrough ? Infinity : safeArrivalSpeed,
    ramming || aimingAtBearing || flowThrough ? Infinity : turnLimit,
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

module.exports = {
  holdWeaponFacingHeading,
  planMovement
};

