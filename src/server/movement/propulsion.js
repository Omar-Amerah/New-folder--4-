"use strict";

const { angleDifference, clampNumber, fastHypot } = require("../utils");
const { WORLD } = require("../config");
const { calculateBrakingAcceleration } = require("../../../public/src/shared/movementStats.js");
const {
  APPROACH_DAMPING,
  ARRIVED_DAMPING,
  DAMPING_REFERENCE_HZ,
  FINAL_FACING_TOLERANCE,
  FULL_THRUST_HEADING_ERROR,
  LATERAL_DAMPING,
  REST_SPEED,
  TRAVEL_DAMPING,
  UNPOWERED_DAMPING
} = require("../movementTuning");
const {
  applyEngineHeat,
  applyTurnHeat,
  driveAcceleration,
  hasDrive,
  signedTurnRate
} = require("../movementCapability");

const TURN_TIME_CONSTANT_S = 0.04;
const MOMENTUM_HOLD_ANGLE = Math.PI / 2;

function normalizeHullAngle(angle) {
  let normalized = Number(angle) % (Math.PI * 2);
  if (normalized <= -Math.PI) normalized += Math.PI * 2;
  if (normalized > Math.PI) normalized -= Math.PI * 2;
  return normalized;
}

function brakingAcceleration(stats) {
  return calculateBrakingAcceleration(driveAcceleration(stats));
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
      applyEngineHeat(ship, step / Math.max(1e-9, driveAcceleration(stats) * dt), dt);
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

module.exports = {
  MOMENTUM_HOLD_ANGLE,
  alignmentThrottle,
  applyManualRotation,
  applyPropulsion,
  brakingAcceleration,
  initializeKinematics,
  integratePosition,
  momentumRetention,
  normalizeHullAngle,
  sanitizeMovementState,
  turnTowardHeading
};

