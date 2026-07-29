"use strict";

const { clampNumber, fastHypot, hashString } = require("./utils");
const {
  nearestDemolitionTargetPoint,
  shipHasOperationalDemolitionCharge
} = require("./combat");
const { areEntityEnemies } = require("./relationships");
const { getEffectiveWeaponRanges } = require("./componentData");
const { sanitizeCombatStyle } = require("./validation");
const {
  ARRIVE_DISTANCE,
  ARRIVE_SPEED,
  CHARGE_LEAD_MAX_S,
  CHARGE_MIN_SPEED_FACTOR,
  CHARGE_SETTLE_TIME_S,
  HOLD_RANGE_RATIO,
  KITE_RANGE_RATIO,
  NAV_STUCK_TIME_MS,
  ORBIT_LEAD_ANGLE,
  ORBIT_LEAD_STEPS,
  ORBIT_RANGE_RATIO,
  REPAIR_STANDOFF_PAD,
  WORLD_MARGIN
} = require("./movementTuning");
const {
  navigationClearanceRadius,
  physicalCollisionRadius,
  separationRadius
} = require("./movementCollision");
const { ensureMovementRuntime } = require("./movementRuntime");
const { nearestClearPoint } = require("./movementNavigation");

const SUPPORTED_MOVEMENT_TYPES = Object.freeze([
  "move",
  "hold",
  "kite",
  "orbit",
  "charge",
  "station",
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
  if (!targetId) return null;
  const str = String(targetId);
  const target = room.ships?.get(str) || room.stationsById?.get(str);
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
      && areEntityEnemies(room, ship.ownerId, target)) return target;
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

// The legal interior a ship can actually be routed to. WORLD_MARGIN alone is not
// enough: the nav grid additionally requires the ship's clearance radius, so a
// destination inside that band is unreachable and nearestClearPoint relocates it
// -- by BFS ring order, which is to say sideways, in whatever direction it
// happens to visit first. Combat intents used to emit raw points and rely on
// that, which is why a ship backed against a wall shuffled instead of moving.
function playableBounds(room, ship) {
  const width = room?.world?.width || 2000;
  const height = room?.world?.height || 1600;
  const inset = WORLD_MARGIN + navigationClearanceRadius(ship);
  return {
    minX: inset,
    minY: inset,
    maxX: Math.max(inset, width - inset),
    maxY: Math.max(inset, height - inset)
  };
}

function clampToPlayableArea(room, ship, candidate) {
  const bounds = playableBounds(room, ship);
  const x = clampNumber(candidate.x, bounds.minX, bounds.maxX);
  const y = clampNumber(candidate.y, bounds.minY, bounds.maxY);
  return { x, y, clamped: x !== candidate.x || y !== candidate.y };
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

// Angles off the straight-back bearing to try when a straight retreat would run
// the ship into the edge of the world. Each still sits on the safe-range ring,
// so separation is preserved while the ship travels along the wall rather than
// into it.
const KITE_WALL_SLIDE_ANGLES = Object.freeze([0.6, 1.2, 1.8]);

function ringPoint(target, bearing, radius) {
  return point(
    (target.x || 0) + Math.cos(bearing) * radius,
    (target.y || 0) + Math.sin(bearing) * radius
  );
}

// Straight back if that is available. Backed against the world edge it is not,
// and a clamped point sits inside the ring the ship is trying to hold, so the
// ship re-issues the same retreat every tick and grinds along the boundary
// without ever satisfying it. Give up on the radial line in that case and take
// the ring point nearest to it that is actually reachable, committing to one
// side so the choice does not flip tick to tick.
function kiteRetreatDestination(room, ship, target, range, safeRange, preferredSide) {
  const straight = clampToPlayableArea(room, ship, range.destination);
  if (!straight.clamped) return { destination: point(straight.x, straight.y), side: preferredSide };
  const bearing = Math.atan2(range.unitY, range.unitX);
  const sides = preferredSide === -1 ? [-1, 1] : [1, -1];
  for (const offset of KITE_WALL_SLIDE_ANGLES) {
    for (const side of sides) {
      const candidate = ringPoint(target, bearing + side * offset, safeRange);
      const clamped = clampToPlayableArea(room, ship, candidate);
      if (!clamped.clamped) return { destination: candidate, side };
    }
  }
  return { destination: point(straight.x, straight.y), side: preferredSide };
}

function kiteIntent(room, ship, target, maximumRange, runtime, now) {
  const safeRange = Math.max(80, maximumRange * KITE_RANGE_RATIO);
  const range = relativeRangeState(ship, target, safeRange);
  // Arrival braking parks a ship ARRIVE_DISTANCE short of its destination and
  // the retreat destination sits exactly on the ring, so "distance >= safeRange"
  // is a condition the controller can never reach: kite re-issued a retreat it
  // had already completed, forever. Same shortfall, same band, as holdIntent.
  const tolerance = Math.max(ARRIVE_DISTANCE, (Number(ship.radius) || 0) * 0.5);
  const existing = runtime.style.kite?.targetId === target.id ? runtime.style.kite : null;
  let side = existing?.side === 1 || existing?.side === -1 ? existing.side : null;
  let stuckFlipAt = Number(existing?.stuckFlipAt) || 0;
  if (side === null) {
    side = orbitDirectionFor(ship, target, range);
  } else if (orbitProgressStalled(runtime, now, stuckFlipAt)) {
    side = -side;
    stuckFlipAt = now;
  }

  if (range.distance < safeRange - tolerance) {
    const retreat = kiteRetreatDestination(room, ship, target, range, safeRange, side);
    return movementIntent("kite", {
      destination: retreat.destination,
      facingMode: "target",
      facingTargetId: target.id,
      desiredRange: safeRange,
      arrivalRequired: true,
      persistent: true,
      debugReason: "kite:retreat-too-close",
      styleMemory: { kite: { targetId: target.id, side: retreat.side, stuckFlipAt } }
    });
  }
  if (range.distance > maximumRange) {
    const outside = relativeRangeState(ship, target, maximumRange);
    const approach = clampToPlayableArea(room, ship, outside.destination);
    return movementIntent("kite", {
      destination: point(approach.x, approach.y),
      facingMode: "target",
      facingTargetId: target.id,
      desiredRange: safeRange,
      arrivalRequired: true,
      persistent: true,
      debugReason: "kite:approach-outside-weapon-range",
      styleMemory: { kite: { targetId: target.id, side, stuckFlipAt } }
    });
  }
  return movementIntent("kite", {
    desiredVelocity: point(target.vx, target.vy),
    facingMode: "target",
    facingTargetId: target.id,
    desiredRange: safeRange,
    arrivalRequired: true,
    persistent: true,
    debugReason: "kite:safe-range-restored",
    styleMemory: { kite: { targetId: target.id, side, stuckFlipAt } }
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
// The aim point that keeps the ship ON the circle. Steering at a blocked lead
// point does not stop the ship going there -- the navigator simply routes around
// the obstacle, and "around" for anything sitting on the ring means outside it.
// That is the fling: a ship orbiting at 508 px was dragged out past 880, well
// beyond its own weapon range, before it could rejoin. Slide the aim point
// further around the circle instead, so the detour is taken along the orbit
// rather than away from it, and the guns stay on the target throughout.
function orbitAimPoint(room, ship, target, ringRadius, baseBearing, direction) {
  const clearance = navigationClearanceRadius(ship);
  for (let step = 1; step <= ORBIT_LEAD_STEPS; step += 1) {
    const candidate = ringPoint(
      target,
      baseBearing + direction * ORBIT_LEAD_ANGLE * step,
      ringRadius
    );
    if (clampToPlayableArea(room, ship, candidate).clamped) continue;
    const clear = nearestClearPoint(room, candidate.x, candidate.y, clearance);
    // `adjusted` means the navigator had to move the point to make it legal, so
    // the point asked for is inside something. Only an unmodified answer is a
    // spot on the ring the ship can actually occupy.
    if (clear.clear && !clear.adjusted) return candidate;
  }
  return null;
}

function orbitIntent(room, ship, target, maximumRange, stats, runtime, now) {
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
  const baseBearing = Math.atan2(range.unitY, range.unitX);
  // Steering at a point on the ring means flying its chords, and a chord runs
  // inside the circle it joins -- so aiming at exactly desiredRange orbits
  // measurably tighter than asked. Push the steering ring out by the chord's
  // sagitta so the circle actually flown is the one requested.
  const ringRadius = desiredRange / Math.cos(ORBIT_LEAD_ANGLE / 2);
  let aim = orbitAimPoint(room, ship, target, ringRadius, baseBearing, direction);
  let reason = "orbit:lead-point";
  if (!aim) {
    // The whole arc ahead is blocked -- a station or a large rock is sitting on
    // it. Going the other way round is the answer that always exists, and it
    // keeps the ship on the circle and in range. The reversal is committed to
    // style memory, so the ship sweeps the clear arc rather than re-deciding
    // into a stutter at the obstacle's edge every tick.
    const reversed = orbitAimPoint(room, ship, target, ringRadius, baseBearing, -direction);
    if (reversed) {
      direction = -direction;
      aim = reversed;
      reason = "orbit:reversed-around-obstacle";
    } else {
      aim = ringPoint(target, baseBearing + direction * ORBIT_LEAD_ANGLE, ringRadius);
      reason = "orbit:ring-blocked";
    }
  }
  const maximumSpeed = Math.max(10, Number(stats.maxSpeed) || 0);
  // v = omega * r. A hull that cannot turn fast enough to stay on the circle at
  // full throttle would spiral out of it, so cap the throttle at what its
  // weakest turn direction can actually hold.
  const turnRate = Math.max(0, Math.min(
    Number(stats.turnRateLeft ?? stats.turnRate) || 0,
    Number(stats.turnRateRight ?? stats.turnRate) || 0
  ));
  return movementIntent("orbit", {
    destination: point(aim.x, aim.y),
    // Feed-forward so a moving target is orbited rather than trailed.
    desiredVelocity: point(target.vx, target.vy),
    facingMode: "travel",
    facingTargetId: target.id,
    desiredRange,
    arrivalRequired: false,
    persistent: true,
    maxSpeedFactor: clampNumber(turnRate * desiredRange / maximumSpeed, 0.15, 1),
    debugReason: reason,
    styleMemory: { orbit: { targetId: target.id, direction, stuckFlipAt } }
  });
}

// Where the target will be by the time the charger gets there. Steering at
// where it is now trails a moving target instead of intercepting it.
function chargeInterceptPoint(ship, target, stats, distance) {
  const closingSpeed = Math.max(10, Number(stats.maxSpeed) || 0);
  const lead = Math.min(CHARGE_LEAD_MAX_S, distance / closingSpeed);
  return {
    x: (target.x || 0) + (Number(target.vx) || 0) * lead,
    y: (target.y || 0) + (Number(target.vy) || 0) * lead
  };
}

function chargeIntent(room, ship, target, stats) {
  const demolition = shipHasOperationalDemolitionCharge(ship);
  // Separation actively holds the pair separationRadius + physicalCollisionRadius
  // apart. A contact goal computed any tighter than that -- as this did, missing
  // both the 18 px floor and the 4 px pad movementCollision applies -- sits
  // inside the distance the solver is pushing the charger back out of, so flight
  // assist and separation shove against each other and the charge never settles.
  const contactRange = Math.max(1, separationRadius(ship) + physicalCollisionRadius(target));
  let destination;
  if (demolition) {
    destination = nearestDemolitionTargetPoint(ship, target);
  } else {
    const lead = chargeInterceptPoint(
      ship,
      target,
      stats,
      relativeRangeState(ship, target, contactRange).distance
    );
    destination = relativeRangeState(ship, { ...target, ...lead }, contactRange).destination;
  }
  const clamped = clampToPlayableArea(room, ship, destination);
  // Skipping arrival braking is not the same as closing at full throttle.
  // Separation holds the pair contactRange apart, so a charger that arrives at
  // maxSpeed is shoved straight back out, re-accelerates, and orbits the contact
  // point forever -- never "positioned", speed bouncing between nothing and half
  // its cruise. Taper the throttle over the last stretch instead: the ship still
  // has no braking phase and never parks short of the hull, it just arrives
  // slowly enough to stay there.
  const closing = relativeRangeState(ship, target, contactRange);
  const taperDistance = Math.max(
    contactRange,
    (Number(stats.maxSpeed) || 0) * CHARGE_SETTLE_TIME_S
  );
  return movementIntent("charge", {
    destination: point(clamped.x, clamped.y),
    facingMode: "travel",
    facingTargetId: target.id,
    desiredRange: demolition ? 0 : contactRange,
    // A charge does not brake. Arrival braking zeroes commanded speed
    // ARRIVE_DISTANCE short of the goal, which for the stance whose whole
    // purpose is contact -- and for the demolition charge that needs it -- is
    // exactly the wrong place to stop. Separation stops the ship on the hull.
    arrivalRequired: false,
    persistent: true,
    maxSpeedFactor: clampNumber(
      closing.rangeError / taperDistance,
      CHARGE_MIN_SPEED_FACTOR,
      1
    ),
    debugReason: demolition
      ? "charge:demolition-contact"
      : "charge:pursue-to-contact"
  });
}

// Static: the ship fights from wherever it already stands. It never yields a
// destination, so nothing routes it anywhere; with no goal, rangePositioned
// settles as soon as it is still, and the positioned branch of
// resolveDesiredFacing turns it onto its target. Deliberately not a "stop"
// intent -- that type short-circuits facing to the current angle, which would
// leave it staring wherever it happened to be pointed.
function stationIntent(target) {
  return movementIntent("station", {
    desiredVelocity: { x: 0, y: 0 },
    facingMode: "target",
    facingTargetId: target.id,
    arrivalRequired: true,
    persistent: true,
    debugReason: "static:hold-ground"
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

  const combatTarget = activeCombatTarget(room, ship, runtime);

  // An order the player gave by hand outranks the combat stance. findTarget
  // re-assigns ship.combatTargetId every combat tick, so without this a stance
  // reclaimed the helm on the tick after a right click and walked the ship back
  // to its station. Weapons are untouched -- the ship still shoots whatever it
  // has acquired, it just goes where it was told. The lock stands until another
  // command replaces it; right-clicking an enemy issues one.
  if (runtime.command?.manual && (commandType === "move" || commandType === "stop")) {
    if (commandType === "stop") return stopIntent("stop:brake");
    // Once the move is done, hold the ground it was sent to and turn onto the
    // target rather than keeping the heading it happened to arrive with.
    if (combatTarget && runtime.phase === "positioned") return stationIntent(combatTarget);
    return moveIntent(runtime);
  }

  // Otherwise a living enemy target owns movement while it exists. Rally moves
  // and stored Stop commands remain so they can resume if the target becomes
  // invalid, but they must not suppress the stance after acquisition.
  if (combatTarget) {
    const style = sanitizeCombatStyle(ship.combatStyle);
    const maximumRange = maximumWeaponRange(ship);
    const demolitionCharge = style === "charge" && shipHasOperationalDemolitionCharge(ship);
    if (maximumRange <= 0 && !demolitionCharge) {
      return stopIntent("attack:no-operational-weapons");
    }
    switch (style) {
      case "orbit":
        return orbitIntent(room, ship, combatTarget, maximumRange, stats, runtime, now);
      case "kite":
        return kiteIntent(room, ship, combatTarget, maximumRange, runtime, now);
      case "charge":
        return chargeIntent(room, ship, combatTarget, stats);
      case "static":
        return stationIntent(combatTarget);
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
    "holdTargetId",
    "kite"
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
