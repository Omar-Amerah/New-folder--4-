"use strict";

const { angleDifference, clampNumber, fastHypot } = require("../utils");
const {
  ORBIT_AVOIDANCE_MARGIN,
  ORBIT_AVOIDANCE_MAX_STEPS,
  ORBIT_AVOIDANCE_MIN_STEPS,
  ORBIT_AVOIDANCE_REACTION_TIME,
  ORBIT_AVOIDANCE_REPLAN_MS,
  ORBIT_AVOIDANCE_RETRY_MS,
  ORBIT_AVOIDANCE_SCAN_MS,
  ORBIT_AVOIDANCE_STEP_LENGTH,
  ORBIT_AVOIDANCE_TARGET_MOVE,
  ORBIT_CONTACT_PADDING,
  ORBIT_CORRECTION_BAND,
  ORBIT_LOOKAHEAD_DISTANCE,
  ORBIT_RADIAL_GAIN,
  ORBIT_RANGE_RATIO,
  ORBIT_REJOIN_ARCS,
  ORBIT_REJOIN_HEADING_TOLERANCE,
  ORBIT_REJOIN_RADIAL_TOLERANCE,
  ORBIT_REVERSAL_HEADING_TOLERANCE,
  ORBIT_REVERSAL_SPEED,
  ORBIT_TURN_MARGIN
} = require("../movementTuning");
const { getMaxEffectiveWeaponRange } = require("../componentData");
const { ORBIT_DIRECTION, sanitizeOrbitDirection } = require("../validation");
const { physicalCollisionRadius } = require("../movementCollision");
const {
  isSegmentClear,
  nearestClearPoint,
  searchPathWorld
} = require("../movementNavigation");
const { combat } = require("./combatAccess");
const { engagementGeometry } = require("./engagement");
const { maxTurnRate, routeClearance } = require("./navigation");
const { staticObstacleBrakingCeiling } = require("./obstacleAvoidance");
const { brakingAcceleration } = require("./propulsion");

const BEARING_MIN_DISTANCE = 1;

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

module.exports = {
  clearOrbitSteering,
  orbitStandoff,
  orbitTangent,
  planOrbit
};

