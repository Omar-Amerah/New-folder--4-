"use strict";

const { clampNumber, fastHypot, hashString } = require("./utils");
const {
  areEnemies,
  nearestDemolitionTargetPoint,
  shipHasOperationalDemolitionCharge
} = require("./combat");
const { getEffectiveWeaponRanges } = require("./componentData");
const { sanitizeCombatStyle } = require("./validation");
const {
  ARRIVE_DISTANCE,
  ARRIVE_SPEED,
  HOLD_RANGE_RATIO,
  KITE_RANGE_RATIO,
  NAV_STUCK_TIME_MS,
  ORBIT_LEAD_ANGLE,
  ORBIT_RANGE_RATIO,
  REPAIR_STANDOFF_PAD
} = require("./movementTuning");
const { ensureMovementRuntime } = require("./movementRuntime");

const SUPPORTED_MOVEMENT_TYPES = Object.freeze([
  "move",
  "hold",
  "kite",
  "orbit",
  "charge",
  "repair",
  "stop"
]);

function point(x, y) {
  return { x: Number(x) || 0, y: Number(y) || 0 };
}

function movementIntent(type, values = {}) {
  return {
    type,
    destination: values.destination || null,
    desiredVelocity: values.desiredVelocity || null,
    facingMode: values.facingMode || "current",
    facingTargetId: values.facingTargetId || null,
    finalFacing: Number.isFinite(values.finalFacing) ? values.finalFacing : null,
    desiredRange: Number.isFinite(values.desiredRange) ? values.desiredRange : null,
    arrivalRequired: Boolean(values.arrivalRequired),
    persistent: Boolean(values.persistent),
    debugReason: String(values.debugReason || type),
    maxSpeedFactor: Number.isFinite(values.maxSpeedFactor) ? values.maxSpeedFactor : 1,
    styleMemory: values.styleMemory || null
  };
}

function stopIntent(reason = "no-command") {
  return movementIntent("stop", {
    desiredVelocity: { x: 0, y: 0 },
    facingMode: "current",
    arrivalRequired: true,
    persistent: false,
    debugReason: reason
  });
}

function livingTarget(room, targetId) {
  const target = targetId && room.ships?.get(String(targetId));
  return target?.alive ? target : null;
}

function firstLivingTarget(room, targetIds) {
  for (const targetId of targetIds) {
    const target = livingTarget(room, targetId);
    if (target) return target;
  }
  return null;
}

function firstLivingEnemyTarget(room, ship, targetIds) {
  for (const targetId of targetIds) {
    const target = livingTarget(room, targetId);
    if (target && !target.removed
      && areEnemies(room, ship.ownerId, target.ownerId)) return target;
  }
  return null;
}

function activeRepairTarget(room, ship, runtime) {
  return firstLivingTarget(room, [
    ship.repairTargetId,
    runtime.command?.type === "repair" ? runtime.command.targetId : null
  ]);
}

function activeCombatTarget(room, ship, runtime) {
  return firstLivingEnemyTarget(room, ship, [
    ship.focusTargetId,
    ship.combatTargetId,
    runtime.command?.type === "attack" ? runtime.command.targetId : null
  ]);
}

function maximumWeaponRange(ship) {
  const ranges = getEffectiveWeaponRanges(ship);
  return Math.max(
    0,
    Number(ranges.blaster) || 0,
    Number(ranges.missile) || 0,
    Number(ranges.railgun) || 0,
    Number(ranges.beam) || 0
  );
}

function relativeRangeState(ship, target, desiredRange) {
  const dx = (ship.x || 0) - (target.x || 0);
  const dy = (ship.y || 0) - (target.y || 0);
  const distance = fastHypot(dx, dy) || 1;
  const unitX = dx / distance;
  const unitY = dy / distance;
  const relativeVx = (ship.vx || 0) - (target.vx || 0);
  const relativeVy = (ship.vy || 0) - (target.vy || 0);
  return {
    distance,
    unitX,
    unitY,
    rangeError: distance - desiredRange,
    radialVelocity: relativeVx * unitX + relativeVy * unitY,
    destination: {
      x: (target.x || 0) + unitX * desiredRange,
      y: (target.y || 0) + unitY * desiredRange
    }
  };
}

function holdStationIntent(station, target, desiredRange, reason, memory = null) {
  return movementIntent("hold", {
    destination: { ...station },
    facingMode: "target",
    facingTargetId: target.id,
    desiredRange,
    arrivalRequired: true,
    persistent: true,
    debugReason: reason,
    styleMemory: memory
  });
}

// Hold picks one firing position and works from it. It closes to weapon range
// once, commits, and everything after that is a question of whether the target
// is still shootable from where the ship already stands -- not of maintaining a
// preferred separation. A target that closes in is a target that got easier to
// hit, so it never causes a withdrawal.
function holdIntent(ship, target, maximumRange, runtime) {
  const desiredRange = Math.max(80, maximumRange * HOLD_RANGE_RATIO);
  const range = relativeRangeState(ship, target, desiredRange);
  // A committed station outlives the target that prompted it. Hold retargets
  // deliberately (see findTarget), and re-approaching the range ring of every
  // new contact would have it wandering the battle instead of holding a line.
  // The station stands while anything it is shooting at is reachable from it.
  const station = runtime.style.holdPosition;
  if (station) {
    const stationRange = fastHypot(
      (target.x || 0) - station.x,
      (target.y || 0) - station.y
    );
    if (stationRange <= maximumRange) {
      return holdStationIntent(
        station,
        target,
        desiredRange,
        runtime.style.holdTargetId === target.id
          ? "hold:established-position"
          : "hold:station-retained-new-target",
        { holdPosition: station, holdTargetId: target.id }
      );
    }
  }
  // Arrival braking parks a ship ARRIVE_DISTANCE short of its destination, and
  // the approach destination sits exactly on the desiredRange ring -- so
  // "distance <= desiredRange" is a condition the controller can never satisfy,
  // and the ship chases the ring forever instead of committing. Commit on a
  // band the size of that shortfall instead.
  const tolerance = Math.max(ARRIVE_DISTANCE, (Number(ship.radius) || 0) * 0.5);
  if (range.rangeError <= tolerance) {
    // Inside the band but still carrying speed: park where we are rather than
    // fall through to the approach branch, whose destination sits behind us and
    // would read on screen as backing away from a target that just closed.
    if (fastHypot(ship.vx || 0, ship.vy || 0) >= ARRIVE_SPEED) {
      return holdStationIntent(
        point(ship.x, ship.y),
        target,
        desiredRange,
        "hold:settling"
      );
    }
    const holdPosition = point(ship.x, ship.y);
    return holdStationIntent(
      holdPosition,
      target,
      desiredRange,
      "hold:position-committed",
      { holdPosition, holdTargetId: target.id }
    );
  }
  return movementIntent("hold", {
    destination: range.destination,
    facingMode: "target",
    facingTargetId: target.id,
    desiredRange,
    arrivalRequired: true,
    persistent: true,
    debugReason: "hold:approach-outside-range",
    styleMemory: { holdPosition: null, holdTargetId: target.id }
  });
}

function kiteIntent(ship, target, maximumRange) {
  const safeRange = Math.max(80, maximumRange * KITE_RANGE_RATIO);
  const range = relativeRangeState(ship, target, safeRange);
  if (range.distance < safeRange) {
    return movementIntent("kite", {
      destination: range.destination,
      facingMode: "target",
      facingTargetId: target.id,
      desiredRange: safeRange,
      arrivalRequired: true,
      persistent: true,
      debugReason: "kite:retreat-too-close"
    });
  }
  if (range.distance > maximumRange) {
    const outside = relativeRangeState(ship, target, maximumRange);
    return movementIntent("kite", {
      destination: outside.destination,
      facingMode: "target",
      facingTargetId: target.id,
      desiredRange: safeRange,
      arrivalRequired: true,
      persistent: true,
      debugReason: "kite:approach-outside-weapon-range"
    });
  }
  return movementIntent("kite", {
    desiredVelocity: point(target.vx, target.vy),
    facingMode: "target",
    facingTargetId: target.id,
    desiredRange: safeRange,
    arrivalRequired: true,
    persistent: true,
    debugReason: "kite:safe-range-restored"
  });
}

// The direction a ship is already travelling decides which way round it goes:
// the tangent it is closer to facing is the one it can take without first
// throwing the hull through a half turn. A ship pointing straight at (or
// straight away from) its target has no preference, so it falls back to a
// stable per-pairing hash rather than picking a side that flips tick to tick.
function orbitDirectionFor(ship, target, range) {
  const forwardX = Math.cos(ship.angle || 0);
  const forwardY = Math.sin(ship.angle || 0);
  // Tangent for direction +1 is the radial unit rotated a quarter turn CCW.
  const alignment = forwardX * -range.unitY + forwardY * range.unitX;
  if (Math.abs(alignment) < 1e-6) {
    return (hashString(`${ship.id}:${target.id}:orbit`) & 1) ? 1 : -1;
  }
  return alignment >= 0 ? 1 : -1;
}

// Wedged against a rock the navigator cannot route past, going the other way
// round is the answer that always exists. Rate-limited so a ship that is merely
// slow does not sit there reversing.
function orbitProgressStalled(runtime, now, lastFlipAt) {
  const navigation = runtime.navigation;
  if (!navigation?.waypoints?.length || !Number.isFinite(now)) return false;
  const progressAt = Number(navigation.progressAt) || 0;
  if (!progressAt || now - progressAt <= NAV_STUCK_TIME_MS) return false;
  return now - lastFlipAt > NAV_STUCK_TIME_MS * 2;
}

// Orbit steers at a point on the circle a fixed angle ahead of the ship rather
// than at a blend of radial and tangential velocities. Two things fall out of
// that: the destination always sits on the ring, so a ship too wide or too tight
// closes on the correct radius with no separate controller, and the intent owns
// a destination -- which is what lets resolveNavigation plan a path, so the
// orbit routes around asteroids and rejoins the circle beyond them. Arrival is
// never required, so none of this passes through arrival braking.
function orbitIntent(ship, target, maximumRange, stats, runtime, now) {
  const desiredRange = Math.max(80, maximumRange * ORBIT_RANGE_RATIO);
  const range = relativeRangeState(ship, target, desiredRange);
  const existing = runtime.style.orbit?.targetId === target.id
    ? runtime.style.orbit
    : null;
  let direction = existing?.direction === 1 || existing?.direction === -1
    ? existing.direction
    : null;
  let stuckFlipAt = Number(existing?.stuckFlipAt) || 0;
  if (direction === null) {
    direction = orbitDirectionFor(ship, target, range);
  } else if (orbitProgressStalled(runtime, now, stuckFlipAt)) {
    direction = -direction;
    stuckFlipAt = now;
  }
  const bearing = Math.atan2(range.unitY, range.unitX) + direction * ORBIT_LEAD_ANGLE;
  // Steering at a point on the ring means flying its chords, and a chord runs
  // inside the circle it joins -- so aiming at exactly desiredRange orbits
  // measurably tighter than asked. Push the steering ring out by the chord's
  // sagitta so the circle actually flown is the one requested.
  const ringRadius = desiredRange / Math.cos(ORBIT_LEAD_ANGLE / 2);
  const maximumSpeed = Math.max(10, Number(stats.maxSpeed) || 0);
  // v = omega * r. A hull that cannot turn fast enough to stay on the circle at
  // full throttle would spiral out of it, so cap the throttle at what its
  // weakest turn direction can actually hold.
  const turnRate = Math.max(0, Math.min(
    Number(stats.turnRateLeft ?? stats.turnRate) || 0,
    Number(stats.turnRateRight ?? stats.turnRate) || 0
  ));
  return movementIntent("orbit", {
    destination: point(
      (target.x || 0) + Math.cos(bearing) * ringRadius,
      (target.y || 0) + Math.sin(bearing) * ringRadius
    ),
    // Feed-forward so a moving target is orbited rather than trailed.
    desiredVelocity: point(target.vx, target.vy),
    facingMode: "travel",
    facingTargetId: target.id,
    desiredRange,
    arrivalRequired: false,
    persistent: true,
    maxSpeedFactor: clampNumber(turnRate * desiredRange / maximumSpeed, 0.15, 1),
    debugReason: "orbit:lead-point",
    styleMemory: { orbit: { targetId: target.id, direction, stuckFlipAt } }
  });
}

function chargeIntent(ship, target) {
  const demolition = shipHasOperationalDemolitionCharge(ship);
  const contactRange = Math.max(
    1,
    (Number(ship.physicalRadius) || (Number(ship.radius) || 0) * 0.56)
      + (Number(target.physicalRadius) || (Number(target.radius) || 0) * 0.56)
      + 2
  );
  const destination = demolition
    ? nearestDemolitionTargetPoint(ship, target)
    : relativeRangeState(ship, target, contactRange).destination;
  return movementIntent("charge", {
    destination: point(destination.x, destination.y),
    facingMode: "travel",
    facingTargetId: target.id,
    desiredRange: demolition ? 0 : contactRange,
    arrivalRequired: true,
    persistent: true,
    maxSpeedFactor: 1,
    debugReason: demolition
      ? "charge:demolition-contact"
      : "charge:pursue-to-contact"
  });
}

function repairIntent(ship, target) {
  const desiredRange = (Number(ship.radius) || 0)
    + (Number(target.radius) || 0)
    + REPAIR_STANDOFF_PAD;
  const range = relativeRangeState(ship, target, desiredRange);
  return movementIntent("repair", {
    destination: range.destination,
    facingMode: "target",
    facingTargetId: target.id,
    desiredRange,
    arrivalRequired: true,
    persistent: true,
    debugReason: "repair:standoff"
  });
}

function moveIntent(runtime) {
  const command = runtime.command;
  if (!command?.destination) return stopIntent("move:missing-destination");
  const hasExplicitFinalFacing = Number.isFinite(command.finalFacing);
  return movementIntent("move", {
    destination: { ...command.destination },
    // A plain ground move owns a destination, not a hidden final rotation.
    // While travelling the hull still follows its course; once parked it keeps
    // the heading it arrived with unless the player explicitly supplied one.
    facingMode: hasExplicitFinalFacing ? "final" : "current",
    finalFacing: command.finalFacing,
    arrivalRequired: true,
    persistent: false,
    debugReason: hasExplicitFinalFacing
      ? "move:explicit-final-facing"
      : "move:course-facing"
  });
}

function createMovementIntent(room, ship, stats = ship.stats || {}, now = 0) {
  const runtime = ensureMovementRuntime(ship);
  const commandType = runtime.command?.type || null;
  if (commandType === "repair") {
    const repairTarget = activeRepairTarget(room, ship, runtime);
    return repairTarget
      ? repairIntent(ship, repairTarget)
      : stopIntent("repair:target-lost");
  }

  // A living enemy target owns movement while it exists. Rally, Move, and Stop
  // commands remain stored so they can resume if the target becomes invalid,
  // but they must not suppress the selected combat stance after acquisition.
  const combatTarget = activeCombatTarget(room, ship, runtime);
  if (combatTarget) {
    const maximumRange = maximumWeaponRange(ship);
    if (maximumRange <= 0) return stopIntent("attack:no-operational-weapons");
    const style = sanitizeCombatStyle(ship.combatStyle);
    switch (style) {
      case "orbit":
        return orbitIntent(ship, combatTarget, maximumRange, stats, runtime, now);
      case "kite":
        return kiteIntent(ship, combatTarget, maximumRange);
      case "charge":
        return chargeIntent(ship, combatTarget);
      case "hold":
      default:
        return holdIntent(ship, combatTarget, maximumRange, runtime);
    }
  }

  if (commandType === "move") return moveIntent(runtime);
  if (commandType === "stop") return stopIntent("stop:brake");
  return stopIntent(commandType === "attack" ? "attack:target-lost" : "idle");
}

function commitIntentStyleMemory(ship, intent) {
  const patch = intent?.styleMemory;
  if (!patch) return;
  const style = ensureMovementRuntime(ship).style;
  for (const key of [
    "orbit",
    "holdPosition",
    "holdTargetId"
  ]) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) style[key] = patch[key];
  }
}

module.exports = {
  SUPPORTED_MOVEMENT_TYPES,
  commitIntentStyleMemory,
  createMovementIntent,
  movementIntent
};
