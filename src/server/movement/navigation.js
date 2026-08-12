"use strict";

const { angleDifference, clampNumber, fastHypot } = require("../utils");
const {
  ARRIVE_DISTANCE,
  FINAL_FACING_TOLERANCE,
  KITE_ROUTE_PAD,
  ORBIT_AVOIDANCE_ROUTE_PAD
} = require("../movementTuning");
const { navigationClearanceRadius } = require("../movementCollision");
const {
  ensureRoomNavigation,
  isSegmentClear,
  searchPathWorld
} = require("../movementNavigation");
const { bumpMovementMetric } = require("../movementMetrics");
const {
  MOMENTUM_HOLD_ANGLE,
  brakingAcceleration
} = require("./propulsion");

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

function clearRoute(runtime) {
  runtime.destination = null;
  runtime.path = [];
  runtime.waypointIndex = 0;
  runtime.route = null;
}

function bearingTo(ship, point) {
  return Math.atan2(point.y - (ship.y || 0), point.x - (ship.x || 0));
}

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

// The next point the ship will be sent to after the one it is flying to, or null
// when this is the end of the course. A queued leg is a corner in the ship's
// path just as much as a routed waypoint is, and everything that reads ahead of
// the current goal has to see it -- otherwise the hull treats a mid-course point
// as somewhere to stop and only discovers the rest of the course once it has.
function nextQueuedWaypoint(runtime) {
  const queue = runtime?.queuedWaypoints;
  return Array.isArray(queue) && queue.length > 0 ? queue[0] : null;
}

// This leg has another behind it, so its end is a corner and not a destination.
function flowingThroughLeg(runtime) {
  return runtime?.command?.type === "move" && Boolean(nextQueuedWaypoint(runtime));
}

function cornerSpeedLimit(ship, runtime, stats, lookaheadDistance) {
  const path = runtime.path;
  if (!path?.length) return Infinity;
  const index = routeWaypointIndex(runtime);
  const goal = path[index];
  // Past the last routed waypoint the corner is the queued leg itself: the ship
  // is closing on the point it was sent to and the turn it has to make there is
  // the one onto the next order.
  const next = path[index + 1] || nextQueuedWaypoint(runtime);
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

module.exports = {
  bearingTo,
  clearRoute,
  flowingThroughLeg,
  maxTurnRate,
  resolveRoute,
  routeClearance,
  routeView,
  waypointCaptureRadius
};

