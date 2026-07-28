"use strict";

// Flight-assisted steering. One model for every intent -- click-to-move, stop,
// and all combat styles:
//
//   desired velocity -> velocity decays toward it -> integrate
//
// Two properties make this predictable, and both are deliberate:
//
//   * Thrust is omnidirectional. A ship's drives push it toward the commanded
//     velocity whatever direction that is. There is no hull-local decomposition
//     into forward/reverse/lateral axes, so no ship ever has to swing its nose
//     around to slow down.
//   * Ships point where they are going. Heading follows the commanded velocity
//     (or the combat target), never the acceleration vector. It changes smoothly
//     and only when the ship's course changes.
//
// What this replaces: a Newtonian model where the only real thrust was the main
// engine, so stopping meant a 180-degree flip-and-burn. On hulls that accelerate
// ~16x harder than they brake that flip was mandatory, constantly re-decided,
// and read to the player as ships spinning on the spot.
//
// The loop is also free of bang-bang branches. Every discontinuity here -- "brake
// to zero the moment we're inside stopping distance", "cut thrust the moment
// we're at speed", "switch which way we face at a speed threshold" -- limit
// cycles at 30 Hz and shows up as jitter.

const {
  angleDifference,
  clampNumber,
  fastHypot,
  rotateToward
} = require("./utils");
const { PARTS } = require("./components");
const { addComponentHeat, componentPerformance } = require("./heat");
const { getCommandAuraMultiplier } = require("./commandAuras");
const {
  calculateDirectionalTurnInputs,
  calculateMovementPowerMultiplier,
  calculateMovementStats,
  maneuverThrusterTorqueSign
} = require("../../public/src/shared/movementStats.js");
const { getComponentPowerMultiplier } = require("./componentPower");
const { getShipComponentIndexes } = require("./componentIndexes");
const { BALANCE } = require("./balanceConfig");
const {
  ARRIVE_DISTANCE,
  ARRIVE_LATCH_RATIO,
  ARRIVE_SPEED,
  BACKUP_CORE_TURN_SCALE,
  DESTINATION_ARRIVE_SPEED,
  EDGE_BOUNCE_MARGIN,
  EDGE_RESTITUTION,
  ENGINE_HEAT_BASE,
  ENGINE_HEAT_PER_THRUST,
  FACING_MIN_SPEED,
  FINAL_FACING_TOLERANCE,
  MANEUVER_HEAT_PER_THRUST,
  REST_SPEED,
  VELOCITY_TIME_CONSTANT_S
} = require("./movementTuning");
const { ensureMovementRuntime } = require("./movementRuntime");
const { bumpMovementMetric } = require("./movementMetrics");

// ---------------------------------------------------------------------------
// Derived stats
// ---------------------------------------------------------------------------

function heatAdjustedMovementStats(ship, baseStats) {
  const design = ship.design || [];
  const multiplier = (index) => (ship.componentHp?.[index] ?? 1) > 0
    ? componentPerformance(ship, index) * getComponentPowerMultiplier(ship, index)
    : 0;
  const engineThrustValues = [];
  const engineMassValues = [];
  for (const index of getShipComponentIndexes(ship).thrustIndices) {
    const module = design[index];
    const part = PARTS[module.type] || {};
    const output = multiplier(index);
    if (output > 0 && (!ship.validEngineIndices || ship.validEngineIndices.has(index))) {
      engineThrustValues.push((part.thrust || 0) * output);
      engineMassValues.push(part.mass || 0);
    }
  }
  const isBlockedEngine = (index, module, part) => {
    if ((ship.componentHp?.[index] ?? 1) <= 0) return true;
    return (part.thrust || 0) > 0
      && ship.validEngineIndices
      && !ship.validEngineIndices.has(index);
  };
  const directionalTurnInputs = calculateDirectionalTurnInputs(design, PARTS, {
    componentMultiplier: multiplier,
    isBlockedEngine
  });
  const movement = calculateMovementStats({
    mass: baseStats.mass,
    thrust: baseStats.thrust,
    turnBonus: 0,
    powerGeneration: baseStats.powerGeneration,
    powerUse: baseStats.powerUse,
    engineThrustValues,
    engineMassValues,
    directionalTurnInputs,
    hullControlThrust: BALANCE.movement?.hullControlThrust,
    movementPowerMultiplier: Math.max(
      1,
      calculateMovementPowerMultiplier(
        baseStats.powerGeneration || 0,
        baseStats.powerUse || 0
      )
    )
  });
  const accelerationMultiplier = getCommandAuraMultiplier(ship, "accelerationMultiplier");
  const turnMultiplier = getCommandAuraMultiplier(ship, "turnRateMultiplier");
  if (Number.isFinite(movement.accel)
    && Number.isFinite(accelerationMultiplier)
    && accelerationMultiplier !== 1) {
    movement.accel *= accelerationMultiplier;
  }
  if (Number.isFinite(movement.turnRate)
    && Number.isFinite(turnMultiplier)
    && turnMultiplier !== 1) {
    movement.turnRate *= turnMultiplier;
    movement.turnRateLeft *= turnMultiplier;
    movement.turnRateRight *= turnMultiplier;
  }
  return { ...baseStats, ...movement };
}

function driveAcceleration(stats) {
  return Math.max(0.001, Number(stats.accel) || 0);
}

function computeStoppingDistance(ship, stats) {
  const speed = fastHypot(ship.vx || 0, ship.vy || 0);
  return speed * speed / (2 * driveAcceleration(stats));
}

// Fastest a ship may be going with `distance` still to run and still stop on the
// mark. Flight assist does not reverse thrust instantly -- it takes about
// VELOCITY_TIME_CONSTANT_S to spin the command around -- so the ship coasts for
// that long before it really starts shedding speed:
//
//     v*t + v^2/(2a) = d   =>   v = sqrt((a*t)^2 + 2*a*d) - a*t
//
// Ignoring the lag term leaves the ship a few pixels fast at the very end, which
// it works off by drifting past the point and turning back -- a small visible
// shimmy exactly when the player is watching the ship arrive.
function approachSpeedLimitForExit(stats, distance, exitSpeed = 0) {
  const remaining = Math.max(0, distance);
  const boundedExitSpeed = Math.max(0, Number(exitSpeed) || 0);
  if (remaining <= 0) return boundedExitSpeed;
  const accel = driveAcceleration(stats);
  const coast = accel * VELOCITY_TIME_CONSTANT_S;
  return Math.sqrt(
    (coast + boundedExitSpeed) * (coast + boundedExitSpeed)
      + 2 * accel * remaining
  ) - coast;
}

function approachSpeedLimit(stats, distance) {
  return approachSpeedLimitForExit(
    stats,
    Math.max(0, distance - ARRIVE_DISTANCE),
    0
  );
}

function waypointTurnSpeedLimit(ship, stats, navigation) {
  if (navigation.isFinal || !navigation.goal || !navigation.nextGoal) return Infinity;
  const incoming = Math.atan2(
    navigation.goal.y - (ship.y || 0),
    navigation.goal.x - (ship.x || 0)
  );
  const outgoing = Math.atan2(
    navigation.nextGoal.y - navigation.goal.y,
    navigation.nextGoal.x - navigation.goal.x
  );
  const turnAngle = Math.abs(angleDifference(incoming, outgoing));
  if (turnAngle < FINAL_FACING_TOLERANCE) return Infinity;
  const turnRate = directionalTurnRate(stats, incoming, outgoing, ship);
  const turningDistance = Math.max(1, Number(navigation.captureDistance) || 0);
  return Math.max(0, turnRate) * turningDistance / turnAngle;
}

// ---------------------------------------------------------------------------
// Decision: what velocity do we want
// ---------------------------------------------------------------------------

function clampVelocity(velocity, maximumSpeed) {
  const speed = fastHypot(velocity.x, velocity.y);
  if (speed <= maximumSpeed || speed <= 0) return velocity;
  const scale = maximumSpeed / speed;
  return { x: velocity.x * scale, y: velocity.y * scale };
}

function desiredVelocityFor(ship, stats, intent, navigation) {
  const runtime = ensureMovementRuntime(ship);
  const maximumSpeed = Math.max(
    0,
    (Number(stats.maxSpeed) || 0) * (Number(intent.maxSpeedFactor) || 1)
  );
  const goal = navigation.goal;
  let distance = 0;
  let baseVelocity = { x: 0, y: 0 };
  if (goal) {
    const dx = goal.x - (ship.x || 0);
    const dy = goal.y - (ship.y || 0);
    distance = fastHypot(dx, dy);
    const directionX = distance > 0.001 ? dx / distance : Math.cos(ship.angle || 0);
    const directionY = distance > 0.001 ? dy / distance : Math.sin(ship.angle || 0);
    const arrivalActive = intent.arrivalRequired && navigation.isFinal;
    // Once a ship has arrived it stays parked, even if a neighbour nudges it a
    // few pixels off the mark. Without this a ship standing on its destination
    // re-commands a crawl toward it after every shove, swings the hull round to
    // face it, and creeps -- which reads as the ship turning for no reason.
    // Sticky hysteresis on an already-settled state, not a threshold the
    // controller can oscillate across.
    const parkedLatch = (runtime.phase === "final-facing" || runtime.phase === "positioned")
      && navigation.isFinal
      && distance < ARRIVE_DISTANCE * ARRIVE_LATCH_RATIO
      && fastHypot(ship.vx || 0, ship.vy || 0) < ARRIVE_SPEED;
    // Braking profile. Reaches zero exactly at ARRIVE_DISTANCE, so there is no
    // "are we inside stopping distance yet" branch -- that test compared against
    // a stopping distance derived from current speed, so braking shrank it,
    // which un-tripped the test, which resumed full speed. That feedback loop
    // was the arrival jitter.
    let desiredSpeed = arrivalActive
      ? (parkedLatch ? 0 : Math.min(maximumSpeed, approachSpeedLimit(stats, distance)))
      : maximumSpeed;
    if (!navigation.isFinal && navigation.nextGoal) {
      const cornerSpeed = waypointTurnSpeedLimit(ship, stats, navigation);
      const brakingDistance = Math.max(
        0,
        distance - Math.max(0, Number(navigation.captureDistance) || 0)
      );
      desiredSpeed = Math.min(
        desiredSpeed,
        approachSpeedLimitForExit(stats, brakingDistance, cornerSpeed)
      );
    }
    // After a waypoint advances, keep the ship inside the same turn-radius
    // budget until its hull has actually acquired the new leg. Otherwise it
    // brakes for the corner, switches waypoints, immediately accelerates, and
    // draws a wide loop past the route before it has finished turning.
    const headingError = Math.abs(angleDifference(ship.angle || 0, Math.atan2(dy, dx)));
    if (headingError > FINAL_FACING_TOLERANCE) {
      const turnRate = directionalTurnRate(
        stats,
        ship.angle || 0,
        Math.atan2(dy, dx),
        ship
      );
      const turningDistance = Math.max(
        1,
        Number(navigation.captureDistance) || ARRIVE_DISTANCE
      );
      desiredSpeed = Math.min(
        desiredSpeed,
        Math.max(0, turnRate) * turningDistance / headingError
      );
    }
    baseVelocity = { x: directionX * desiredSpeed, y: directionY * desiredSpeed };
  }
  if (intent.desiredVelocity) {
    if (goal) {
      baseVelocity.x += intent.desiredVelocity.x;
      baseVelocity.y += intent.desiredVelocity.y;
    } else {
      baseVelocity = { x: intent.desiredVelocity.x, y: intent.desiredVelocity.y };
    }
  }
  return {
    desiredVelocity: clampVelocity(baseVelocity, maximumSpeed),
    distance,
    maximumSpeed
  };
}

// Heading and speed follow from the commanded velocity, so anything that edits
// that velocity -- ship avoidance, most notably -- must refresh them afterwards.
function refreshDecisionHeading(ship, decision) {
  const desired = decision.desiredVelocity;
  decision.desiredSpeed = fastHypot(desired.x, desired.y);
  // Below a real commanded speed there is no travel direction to point at, and
  // aiming at the destination instead would have a ship standing on its mark
  // chase the bearing to a point a few pixels away -- which swings wildly for
  // any small displacement. Hold the current heading instead.
  decision.moveAngle = decision.desiredSpeed > FACING_MIN_SPEED
    ? Math.atan2(desired.y, desired.x)
    : (ship.angle || 0);
  return decision;
}

function buildMovementDecision(room, ship, stats, intent, navigation) {
  const velocityPlan = desiredVelocityFor(ship, stats, intent, navigation);
  const currentSpeed = fastHypot(ship.vx || 0, ship.vy || 0);
  const destinationPositioned = intent.arrivalRequired
    && navigation.isFinal
    && Boolean(navigation.goal)
    && (velocityPlan.distance < ARRIVE_DISTANCE
      || (["final-facing", "positioned"].includes(ensureMovementRuntime(ship).phase)
        && velocityPlan.distance < ARRIVE_DISTANCE * ARRIVE_LATCH_RATIO))
    && currentSpeed < DESTINATION_ARRIVE_SPEED;
  const rangePositioned = intent.arrivalRequired
    && !navigation.goal
    && fastHypot(
      velocityPlan.desiredVelocity.x - (ship.vx || 0),
      velocityPlan.desiredVelocity.y - (ship.vy || 0)
    ) < ARRIVE_SPEED;
  const target = intent.facingTargetId
    ? room.ships?.get(String(intent.facingTargetId))
    : null;
  const decision = {
    desiredVelocity: velocityPlan.desiredVelocity,
    goal: navigation.goal,
    distance: velocityPlan.distance,
    desiredSpeed: 0,
    speed: currentSpeed,
    moveAngle: ship.angle || 0,
    maximumSpeed: velocityPlan.maximumSpeed,
    isFinal: navigation.isFinal,
    finalFacing: intent.facingMode === "final"
      ? (Number.isFinite(intent.finalFacing) ? intent.finalFacing : navigation.finalFacing)
      : null,
    target: target?.alive ? target : null,
    positioned: rangePositioned || destinationPositioned,
    needsPropulsion: !destinationPositioned || currentSpeed > REST_SPEED,
    arrivalRequired: intent.arrivalRequired,
    stoppingDistance: computeStoppingDistance(ship, stats)
  };
  return refreshDecisionHeading(ship, decision);
}

// ---------------------------------------------------------------------------
// Facing -- one ordered set of rules, no capability tests, no blending
// ---------------------------------------------------------------------------

// Ordered rules, no capability tests and no blending. A ship under way points
// where it is going, because that is the only direction it can travel; a ship
// standing still points at whatever it cares about.
function resolveDesiredFacing(ship, stats, intent, decision) {
  if (ship.manualRotation === 1 || ship.manualRotation === -1) {
    return (ship.angle || 0) + ship.manualRotation * (Math.PI - 1e-9);
  }
  if (intent.type === "stop") return ship.angle || 0;
  const targetAngle = decision.target
    ? Math.atan2(
      (decision.target.y || 0) - (ship.y || 0),
      (decision.target.x || 0) - (ship.x || 0)
    )
    : null;
  // Parked. Commit to one heading and hold it: a ship on station must not
  // re-aim every time it is jostled.
  if (decision.positioned) {
    if (Number.isFinite(decision.finalFacing)) return decision.finalFacing;
    if (targetAngle !== null) return targetAngle;
    return ship.angle || 0;
  }
  // Under way: the nose is the direction of travel.
  if (decision.desiredSpeed > FACING_MIN_SPEED) return decision.moveAngle;
  // A drifting hull can still have turn authority even when it has no working
  // forward drive. Keep an unfinished ground move pointed at its live
  // destination, but stop consulting that bearing once it is positioned.
  if (intent.type === "move" && decision.goal) {
    return Math.atan2(
      decision.goal.y - (ship.y || 0),
      decision.goal.x - (ship.x || 0)
    );
  }
  // Holding position without having formally arrived -- aim at the target if
  // there is one, otherwise stay put.
  if (targetAngle !== null) return targetAngle;
  if (Number.isFinite(decision.finalFacing)) return decision.finalFacing;
  return ship.angle || 0;
}

function directionalTurnRate(stats, current, desired, ship) {
  const difference = angleDifference(current, desired);
  if (Math.abs(difference) < 1e-9) return 0;
  const base = difference > 0
    ? (stats.turnRateRight ?? stats.turnRate ?? 0)
    : (stats.turnRateLeft ?? stats.turnRate ?? 0);
  const rate = Number.isFinite(base) ? base : 0;
  return ship?.commandState === "backupCore" ? rate * BACKUP_CORE_TURN_SCALE : rate;
}

let cachedHeatRules = null;
function activityHeatRate(type, part) {
  if (!cachedHeatRules) cachedHeatRules = require("../../public/src/shared/heatRules.js");
  return Math.max(0, Number(cachedHeatRules.activityHeat(type, part)) || 0);
}

function heatActiveManeuverThrusters(ship, turnActivity, dt) {
  if (!turnActivity || !Number.isFinite(turnActivity)) return;
  const desiredSign = Math.sign(turnActivity);
  const exhaust = ship.engineExhaustAnalysis;
  if (!exhaust) return;
  for (const index of getShipComponentIndexes(ship).maneuverThrusterIndices) {
    const module = ship.design[index];
    const part = PARTS[module.type];
    if (!part || (ship.componentHp?.[index] ?? 1) <= 0) continue;
    if (!exhaust.validEngineIndices.has(index)) continue;
    if (maneuverThrusterTorqueSign(module, exhaust.centerOfMass) !== desiredSign) continue;
    const performance = componentPerformance(ship, index)
      * getComponentPowerMultiplier(ship, index);
    if (performance > 0) {
      addComponentHeat(
        ship,
        index,
        (ENGINE_HEAT_BASE + (part.lateralThrust || 0) * MANEUVER_HEAT_PER_THRUST)
          * Math.abs(turnActivity)
          * performance
          * dt
      );
    }
  }
}

function heatActiveGyroscopes(ship, turnActivity, dt) {
  if (!turnActivity || !Number.isFinite(turnActivity)) return;
  for (const index of getShipComponentIndexes(ship).gyroscopeIndices) {
    const part = PARTS[ship.design[index].type] || {};
    if ((ship.componentHp?.[index] ?? 1) <= 0) continue;
    const performance = componentPerformance(ship, index)
      * getComponentPowerMultiplier(ship, index);
    const rate = activityHeatRate("gyroscope", part);
    if (performance > 0 && rate > 0) {
      addComponentHeat(ship, index, rate * Math.abs(turnActivity) * performance * dt);
    }
  }
}

function turnHullToward(ship, desiredFacing, stats, dt) {
  const before = ship.angle || 0;
  const difference = angleDifference(before, desiredFacing);
  if (Math.abs(difference) < FINAL_FACING_TOLERANCE) {
    ship.turnActivity = 0;
    return;
  }
  const rate = directionalTurnRate(stats, before, desiredFacing, ship);
  const next = rotateToward(before, desiredFacing, rate * dt);
  ship.angle = next;
  const applied = Math.abs(angleDifference(before, next));
  const signed = Math.sign(angleDifference(before, next));
  ship.turnActivity = rate > 0
    ? clampNumber(applied / Math.max(rate * dt, 1e-9) * signed, -1, 1)
    : 0;
  heatActiveManeuverThrusters(ship, ship.turnActivity, dt);
  heatActiveGyroscopes(ship, ship.turnActivity, dt);
}

// ---------------------------------------------------------------------------
// Propulsion
// ---------------------------------------------------------------------------

function heatMainEngines(ship, activity, dt, stats) {
  if (activity <= 0) return;
  for (const index of getShipComponentIndexes(ship).thrustIndices) {
    const part = PARTS[ship.design[index].type];
    if (!part || (ship.componentHp?.[index] ?? 1) <= 0) continue;
    if (ship.validEngineIndices && !ship.validEngineIndices.has(index)) continue;
    const performance = componentPerformance(ship, index)
      * getComponentPowerMultiplier(ship, index);
    if (performance > 0) {
      addComponentHeat(
        ship,
        index,
        (ENGINE_HEAT_BASE + (part.thrust || 0) * ENGINE_HEAT_PER_THRUST)
          * activity * performance * dt
      );
    }
  }
}

// Ships travel along their nose and nowhere else. The engines point backwards,
// so the only thing they can do is change how fast the ship is going; changing
// where it is going is the job of the turn rate. A ship therefore steers like a
// boat -- it swings onto its course and drives -- and it never slides sideways,
// because nothing aboard could produce that force.
//
// Speed itself decays toward the commanded speed with time constant
// VELOCITY_TIME_CONSTANT_S, limited by what the engines can deliver this step.
// Exponential approach cannot overshoot the command, so a ship never oscillates
// around its target speed however weak or strong its engines are.
function applyFlightAssist(ship, stats, decision, dt) {
  if (!decision.needsPropulsion) return;
  const forwardX = Math.cos(ship.angle || 0);
  const forwardY = Math.sin(ship.angle || 0);

  // Only the part of the commanded velocity that lies along the nose is
  // achievable. While the ship is still coming round onto its course this is
  // less than the full command, and if the course lies behind it the projection
  // goes negative -- the ship coasts to a stop and turns rather than reversing.
  const commanded = decision.desiredVelocity.x * forwardX
    + decision.desiredVelocity.y * forwardY;
  const targetSpeed = Math.max(0, commanded);
  const speed = (ship.vx || 0) * forwardX + (ship.vy || 0) * forwardY;

  const blend = 1 - Math.exp(-dt / VELOCITY_TIME_CONSTANT_S);
  const available = driveAcceleration(stats) * dt;
  const requested = (targetSpeed - speed) * blend;
  const delta = clampNumber(requested, -available, available);

  const next = speed + delta;
  ship.vx = forwardX * next;
  ship.vy = forwardY * next;
  heatMainEngines(
    ship,
    Math.min(1, Math.abs(requested) / Math.max(available, 1e-9)),
    dt,
    stats
  );
}

function applySpeedLimit(ship, stats, decision) {
  // A ship asked to hold still and already almost still is parked outright.
  // Without this it converges on zero asymptotically and never gets there, so it
  // creeps off station a pixel at a time -- there is no drag out here to finish
  // the job.
  if (decision && decision.desiredSpeed < REST_SPEED) {
    const speed = fastHypot(ship.vx || 0, ship.vy || 0);
    if (speed > 0 && speed < REST_SPEED) {
      ship.vx = 0;
      ship.vy = 0;
      return;
    }
  }
  const limit = Number(stats.maxSpeed) || 0;
  if (limit <= 0) return;
  const speed = fastHypot(ship.vx || 0, ship.vy || 0);
  if (speed <= limit || speed <= 0) return;
  const scale = limit / speed;
  ship.vx *= scale;
  ship.vy *= scale;
}

function integratePosition(room, ship, dt) {
  const dx = (ship.vx || 0) * dt;
  const dy = (ship.vy || 0) * dt;
  ship.x = (ship.x || 0) + dx;
  ship.y = (ship.y || 0) + dy;
  ship._integratedMovementX = (ship._integratedMovementX || 0) + dx;
  ship._integratedMovementY = (ship._integratedMovementY || 0) + dy;
  const width = room?.world?.width || 2000;
  const height = room?.world?.height || 1600;
  if (ship.x < EDGE_BOUNCE_MARGIN) {
    ship.x = EDGE_BOUNCE_MARGIN;
    ship.vx = Math.abs(ship.vx || 0) * EDGE_RESTITUTION;
  } else if (ship.x > width - EDGE_BOUNCE_MARGIN) {
    ship.x = width - EDGE_BOUNCE_MARGIN;
    ship.vx = -Math.abs(ship.vx || 0) * EDGE_RESTITUTION;
  }
  if (ship.y < EDGE_BOUNCE_MARGIN) {
    ship.y = EDGE_BOUNCE_MARGIN;
    ship.vy = Math.abs(ship.vy || 0) * EDGE_RESTITUTION;
  } else if (ship.y > height - EDGE_BOUNCE_MARGIN) {
    ship.y = height - EDGE_BOUNCE_MARGIN;
    ship.vy = -Math.abs(ship.vy || 0) * EDGE_RESTITUTION;
  }
}

// ---------------------------------------------------------------------------
// Phase reporting
// ---------------------------------------------------------------------------

function postIntegrationPositioned(ship, intent, navigation) {
  if (!intent.arrivalRequired) return false;
  const speed = fastHypot(ship.vx || 0, ship.vy || 0);
  if (!navigation.goal) {
    const desired = intent.desiredVelocity || { x: 0, y: 0 };
    return fastHypot(
      (ship.vx || 0) - desired.x,
      (ship.vy || 0) - desired.y
    ) < ARRIVE_SPEED;
  }
  const distance = fastHypot(
    navigation.goal.x - (ship.x || 0),
    navigation.goal.y - (ship.y || 0)
  );
  const parked = ["final-facing", "positioned"].includes(ensureMovementRuntime(ship).phase)
    && distance < ARRIVE_DISTANCE * ARRIVE_LATCH_RATIO;
  return navigation.isFinal
    && (distance < ARRIVE_DISTANCE || parked)
    && speed < DESTINATION_ARRIVE_SPEED;
}

function updateMovementPhase(ship, stats, intent, navigation, decision) {
  const runtime = ensureMovementRuntime(ship);
  if (ship.manualRotation === 1 || ship.manualRotation === -1) {
    runtime.phase = "turning";
    return runtime.phase;
  }
  if (postIntegrationPositioned(ship, intent, navigation)) {
    const finalFacing = intent.facingMode === "final"
      ? (Number.isFinite(intent.finalFacing) ? intent.finalFacing : navigation.finalFacing)
      : null;
    if (Number.isFinite(finalFacing)
      && Math.abs(angleDifference(ship.angle || 0, finalFacing)) > FINAL_FACING_TOLERANCE) {
      runtime.phase = "final-facing";
    } else {
      // A ship parked with nothing to do is idle; a ship parked because it was
      // told to stop, or because its combat style has it holding station, is
      // positioned. "Nothing to do" covers both no target at all and a target it
      // can no longer act on (disarmed), which is why this keys off the intent
      // collapsing to a stop rather than off the reason string.
      runtime.phase = intent.type === "stop" && !runtime.command
        ? "idle"
        : "positioned";
    }
    return runtime.phase;
  }
  if (intent.type === "stop"
    || (intent.arrivalRequired
      && navigation.isFinal
      && decision.distance <= decision.stoppingDistance + ARRIVE_DISTANCE)) {
    runtime.phase = "braking";
  } else {
    runtime.phase = "travelling";
  }
  return runtime.phase;
}

function movementIntentIsFinite(intent) {
  if (!intent || typeof intent !== "object") return false;
  const pointIsFinite = (value) => value == null
    || (Number.isFinite(value.x) && Number.isFinite(value.y));
  return typeof intent.type === "string"
    && pointIsFinite(intent.destination)
    && pointIsFinite(intent.desiredVelocity)
    && (intent.finalFacing == null || Number.isFinite(intent.finalFacing))
    && (intent.desiredRange == null || Number.isFinite(intent.desiredRange));
}

module.exports = {
  applyFlightAssist,
  applySpeedLimit,
  buildMovementDecision,
  computeStoppingDistance,
  heatAdjustedMovementStats,
  integratePosition,
  movementIntentIsFinite,
  refreshDecisionHeading,
  resolveDesiredFacing,
  turnHullToward,
  updateMovementPhase
};
