"use strict";

// Deterministic local ship traffic. Static obstacles belong to navigation;
// moving ships belong here. The controller never rewrites a ship's velocity or
// asks the leading ship to make room. A follower either keeps its normal route,
// follows at the leader's projected speed, queues, or takes one committed
// bypass point and then returns to the route it was already flying.

const { compareEntityIds, fastHypot } = require("./utils");
const { areEntityEnemies } = require("./relationships");
const {
  navigationClearanceRadius,
  physicalCollisionRadius
} = require("./movementCollision");
const { isSegmentClear, nearestClearPoint } = require("./movementNavigation");
const { REST_SPEED } = require("./movementTuning");
const { bumpMovementMetric } = require("./movementMetrics");
const {
  trafficIsStationary: isStationary,
  trafficPairKey: pairKey,
  trafficPriorityWinner: priorityWinner
} = require("./movementTrafficPriority");

const TRAFFIC_LOOKAHEAD = 1300;
const TRAFFIC_FOLLOW_GAP = 36;
const TRAFFIC_SIDE_GAP = 12;
const TRAFFIC_PASS_PAD = 180;
const TRAFFIC_BYPASS_SPEED = 60;
const TRAFFIC_PASS_ADVANCE = 220;
const TRAFFIC_RELEASE_GAP = 96;
const TRAFFIC_MAX_QUERY_RANGE = 1800;
const TRAFFIC_PREDICTIVE_HORIZON = 3;
const TRAFFIC_PREDICTIVE_PAD = 80;

function finiteVector(ship) {
  return {
    x: Number(ship?.vx) || 0,
    y: Number(ship?.vy) || 0
  };
}

function routeGoal(runtime) {
  if (!runtime?.destination) return null;
  const path = runtime.path;
  const index = Math.max(0, Math.floor(Number(runtime.waypointIndex) || 0));
  return path?.[index] || runtime.destination;
}

function routeVector(ship, runtime) {
  const goal = routeGoal(runtime);
  if (!goal) return null;
  const dx = goal.x - (Number(ship.x) || 0);
  const dy = goal.y - (Number(ship.y) || 0);
  const length = fastHypot(dx, dy);
  if (!(length > 1)) return null;
  return {
    goal,
    x: dx / length,
    y: dy / length,
    length
  };
}

function routeProgress(ship) {
  const runtime = ship?.movement;
  const index = Math.max(0, Math.floor(Number(runtime?.waypointIndex) || 0));
  const goal = routeGoal(runtime);
  return {
    index,
    distance: goal ? fastHypot(goal.x - (ship.x || 0), goal.y - (ship.y || 0)) : Infinity
  };
}

function trafficState(runtime) {
  if (!runtime.traffic || typeof runtime.traffic !== "object") {
    runtime.traffic = {
      mode: "clear",
      blockerId: null,
      pairKey: null,
      side: 0,
      bypass: null,
      priorityId: null,
      crossing: false
    };
  }
  return runtime.traffic;
}

function clearTrafficState(runtime) {
  const state = trafficState(runtime);
  state.mode = "clear";
  state.blockerId = null;
  state.pairKey = null;
  state.side = 0;
  state.bypass = null;
  state.priorityId = null;
  state.crossing = false;
}

function setLegacyTrafficTelemetry(ship, state) {
  // Keep the old diagnostic surface readable for existing room telemetry while
  // the control state itself lives in runtime. No legacy speed multiplier or
  // heading offset is emitted.
  const diagnostic = ship._avoidance || (ship._avoidance = {});
  diagnostic.side = state.side || 0;
  diagnostic.mode = state.mode;
  diagnostic.blockerId = state.blockerId;
}

function explicitTarget(ship) {
  return ship?.movement?.command?.type === "attack"
    ? String(ship.movement.command.targetId || "")
    : "";
}

function acceptsTrafficEntity(room, ship, other) {
  if (!areEntityEnemies(room, ship.ownerId, other)) return true;
  return String(other.id) !== explicitTarget(ship);
}

function queryNearby(room, ship, range) {
  if (!room.spatialIndex?.dynamicValid || !room.spatialIndex.queryRangeUnordered) return [];
  return room.spatialIndex.queryRangeUnordered(
    "ships",
    ship.x,
    ship.y,
    range,
    ship._trafficScratch || (ship._trafficScratch = [])
  );
}

function pointClearOfShips(room, ship, point, ignored, nearby) {
  const ownRadius = physicalCollisionRadius(ship);
  for (const other of nearby) {
    if (!other?.alive || other === ship || other === ignored) continue;
    const minimum = ownRadius + physicalCollisionRadius(other) + TRAFFIC_SIDE_GAP;
    if (fastHypot(point.x - other.x, point.y - other.y) < minimum) return false;
  }
  return true;
}

function chooseBypass(room, ship, other, vector, nearby) {
  const ownRadius = physicalCollisionRadius(ship);
  const otherRadius = physicalCollisionRadius(other);
  const offset = ownRadius + otherRadius + TRAFFIC_PASS_PAD;
  const perpendicular = { x: -vector.y, y: vector.x };
  const clearance = navigationClearanceRadius(ship);
  const candidates = [-1, 1].map((side) => {
    // First move abeam of the encounter, then continue past the blocker on the
    // committed side. The two-point route gives a vehicle enough room to turn
    // before it reaches the crossing line; a single diagonal point makes a
    // head-on pass cut the corner into the other hull.
    const entryRaw = {
      x: ship.x + perpendicular.x * side * offset,
      y: ship.y + perpendicular.y * side * offset
    };
    const exitRaw = {
      x: other.x + vector.x * TRAFFIC_PASS_ADVANCE + perpendicular.x * side * offset,
      y: other.y + vector.y * TRAFFIC_PASS_ADVANCE + perpendicular.y * side * offset
    };
    const entry = nearestClearPoint(room, entryRaw.x, entryRaw.y, clearance);
    const exit = nearestClearPoint(room, exitRaw.x, exitRaw.y, clearance);
    if (!entry?.clear || !exit?.clear) return null;
    if (fastHypot(entry.x - entryRaw.x, entry.y - entryRaw.y) > TRAFFIC_PASS_PAD
      || fastHypot(exit.x - exitRaw.x, exit.y - exitRaw.y) > TRAFFIC_PASS_PAD) return null;
    if (!isSegmentClear(room, ship.x, ship.y, entry.x, entry.y, clearance)) return null;
    if (!isSegmentClear(room, entry.x, entry.y, exit.x, exit.y, clearance)) return null;
    if (!isSegmentClear(room, exit.x, exit.y, vector.goal.x, vector.goal.y, clearance)) return null;
    if (!pointClearOfShips(room, ship, entry, other, nearby)
      || !pointClearOfShips(room, ship, exit, other, nearby)) return null;
    return {
      side,
      entry: { x: entry.x, y: entry.y },
      exit: { x: exit.x, y: exit.y },
      stage: "entry"
    };
  }).filter(Boolean);
  if (!candidates.length) return null;
  const preferred = compareEntityIds(ship, other) <= 0 ? -1 : 1;
  return candidates.find((candidate) => candidate.side === preferred) || candidates[0];
}

function encounterFor(ship, other, vector) {
  const rx = (other.x || 0) - (ship.x || 0);
  const ry = (other.y || 0) - (ship.y || 0);
  const along = rx * vector.x + ry * vector.y;
  const lateral = rx * -vector.y + ry * vector.x;
  const distance = fastHypot(rx, ry);
  const physicalGap = distance - physicalCollisionRadius(ship) - physicalCollisionRadius(other);
  const sideLimit = physicalCollisionRadius(ship) + physicalCollisionRadius(other) + TRAFFIC_SIDE_GAP;
  const speed = finiteVector(ship);
  const otherSpeed = finiteVector(other);
  const ownAlong = speed.x * vector.x + speed.y * vector.y;
  const otherAlong = otherSpeed.x * vector.x + otherSpeed.y * vector.y;
  const closing = ownAlong - otherAlong;
  const safeGap = TRAFFIC_FOLLOW_GAP + Math.max(0, ownAlong) * 0.45;
  const relativeX = (other.vx || 0) - (ship.vx || 0);
  const relativeY = (other.vy || 0) - (ship.vy || 0);
  const relativeSpeedSq = relativeX * relativeX + relativeY * relativeY;
  const closingRate = rx * relativeX + ry * relativeY;
  let predicted = false;
  if (relativeSpeedSq > 1 && closingRate < 0) {
     const time = Math.min(
       TRAFFIC_PREDICTIVE_HORIZON,
       Math.max(0, -closingRate / relativeSpeedSq)
     );
     const closestX = rx + relativeX * time;
     const closestY = ry + relativeY * time;
     const closestLateral = closestX * -vector.y + closestY * vector.x;
     predicted = Math.abs(closestLateral) <= sideLimit
       && fastHypot(closestX, closestY)
         < physicalCollisionRadius(ship) + physicalCollisionRadius(other) + TRAFFIC_PREDICTIVE_PAD;
  }
  const inRouteCorridor = along > 0
    && along <= Math.max(TRAFFIC_LOOKAHEAD, vector.length)
    && Math.abs(lateral) <= sideLimit;
  if (!inRouteCorridor && !predicted) return null;
  if (!predicted && physicalGap > safeGap && closing <= 0) return null;
  if (!predicted && physicalGap > safeGap && closing < 2) return null;
  return {
    distance,
    physicalGap,
    otherAlong,
    closing,
    safeGap,
    rx,
    ry,
    predicted,
    crossing: fastHypot(other.vx || 0, other.vy || 0) > REST_SPEED
      && Math.abs(otherAlong) <= REST_SPEED
  };
}

function passedBlocker(ship, other, vector) {
  const rx = (other.x || 0) - (ship.x || 0);
  const ry = (other.y || 0) - (ship.y || 0);
  return rx * vector.x + ry * vector.y < -TRAFFIC_RELEASE_GAP;
}

function bypassReleased(ship, other, vector, bypass) {
  if (passedBlocker(ship, other, vector)) return true;
  if (bypass?.stage !== "exit") return false;
  const nearExit = fastHypot(ship.x - bypass.exit.x, ship.y - bypass.exit.y)
    <= TRAFFIC_FOLLOW_GAP;
  if (!nearExit) return false;
  const physicalGap = fastHypot(ship.x - other.x, ship.y - other.y)
    - physicalCollisionRadius(ship) - physicalCollisionRadius(other);
  return physicalGap >= TRAFFIC_SIDE_GAP;
}

function crossingReleased(ship, other, vector) {
  const rx = (other.x || 0) - (ship.x || 0);
  const ry = (other.y || 0) - (ship.y || 0);
  const lateral = rx * -vector.y + ry * vector.x;
  return Math.abs(lateral) > physicalCollisionRadius(ship)
    + physicalCollisionRadius(other)
    + TRAFFIC_RELEASE_GAP
    && fastHypot(other.vx || 0, other.vy || 0) > REST_SPEED;
}

function resolveTraffic(room, ship, runtime, now) {
  const state = trafficState(runtime);
  if (!runtime.destination || !runtime.command || runtime.command.type === "stop") {
    clearTrafficState(runtime);
    setLegacyTrafficTelemetry(ship, state);
    return { mode: "clear", speedCap: null, heading: null };
  }
  const vector = routeVector(ship, runtime);
  if (!vector) {
    clearTrafficState(runtime);
    setLegacyTrafficTelemetry(ship, state);
    return { mode: "clear", speedCap: null, heading: null };
  }
  const ownSpeed = fastHypot(ship.vx || 0, ship.vy || 0);
  const range = Math.min(
    TRAFFIC_MAX_QUERY_RANGE,
    Math.max(TRAFFIC_LOOKAHEAD, physicalCollisionRadius(ship) * 2 + ownSpeed * 2)
  );
  const nearby = queryNearby(room, ship, range);
  let best = null;
  for (const other of nearby) {
    if (!other?.alive || other === ship || !acceptsTrafficEntity(room, ship, other)) continue;
    const encounter = encounterFor(ship, other, vector);
    if (!encounter) continue;
    const release = physicalCollisionRadius(ship) + physicalCollisionRadius(other) + TRAFFIC_RELEASE_GAP;
    const winnerId = priorityWinner(room, ship, other, now, release);
    if (winnerId === ship.id) continue;
    if (!best || encounter.physicalGap < best.encounter.physicalGap) {
      best = { other, encounter, winnerId, pair: pairKey(ship, other), release, vector };
    }
  }

  if (!best) {
    const blocker = state.blockerId ? room.ships?.get?.(String(state.blockerId)) : null;
    if (blocker?.alive && !passedBlocker(ship, blocker, vector)) {
      if (state.mode === "bypass" && state.bypass) {
        if (bypassReleased(ship, blocker, vector, state.bypass)) {
          clearTrafficState(runtime);
          setLegacyTrafficTelemetry(ship, state);
          return { mode: "clear", speedCap: null, heading: null };
        }
        if (state.bypass.stage === "entry"
          && fastHypot(ship.x - state.bypass.entry.x, ship.y - state.bypass.entry.y) <= TRAFFIC_FOLLOW_GAP) {
          state.bypass.stage = "exit";
        }
        const point = state.bypass.stage === "entry"
          ? state.bypass.entry
          : state.bypass.exit;
        setLegacyTrafficTelemetry(ship, state);
        return {
          mode: "bypass",
          speedCap: TRAFFIC_BYPASS_SPEED,
          heading: Math.atan2(point.y - ship.y, point.x - ship.x)
        };
      }
      if (state.mode === "queue" && state.crossing
        && !crossingReleased(ship, blocker, vector)) {
        setLegacyTrafficTelemetry(ship, state);
        return { mode: "queue", speedCap: 0, heading: null };
      }
    }
    clearTrafficState(runtime);
    setLegacyTrafficTelemetry(ship, state);
    return { mode: "clear", speedCap: null, heading: null };
  }

  const { other, encounter, pair, vector: activeVector } = best;
  if (state.pairKey !== pair || state.blockerId !== other.id) {
    state.mode = "clear";
    state.blockerId = other.id;
    state.pairKey = pair;
    state.side = 0;
    state.bypass = null;
    state.priorityId = best.winnerId;
    state.crossing = false;
  }

  // A crossing queue is a committed decision too. Do not turn it into a pass
  // merely because the moving ship has changed its projection while crossing
  // the stopped follower; release it only after the pair has separated laterally.
  if (state.mode === "queue" && state.crossing) {
    if (!crossingReleased(ship, other, activeVector)) {
      setLegacyTrafficTelemetry(ship, state);
      return { mode: "queue", speedCap: 0, heading: null };
    }
    state.mode = "clear";
    state.crossing = false;
  }

  if (state.mode === "bypass" && state.bypass) {
    if (bypassReleased(ship, other, activeVector, state.bypass)) {
      clearTrafficState(runtime);
      setLegacyTrafficTelemetry(ship, state);
      return { mode: "clear", speedCap: null, heading: null };
    }
    if (state.bypass.stage === "entry"
      && fastHypot(ship.x - state.bypass.entry.x, ship.y - state.bypass.entry.y) <= TRAFFIC_FOLLOW_GAP) {
      state.bypass.stage = "exit";
    }
    const point = state.bypass.stage === "entry"
      ? state.bypass.entry
      : state.bypass.exit;
    setLegacyTrafficTelemetry(ship, state);
    return {
      mode: "bypass",
      speedCap: TRAFFIC_BYPASS_SPEED,
      heading: Math.atan2(point.y - ship.y, point.x - ship.x)
    };
  }

  if (encounter.crossing) {
    state.mode = "queue";
    state.side = 0;
    state.bypass = null;
    state.crossing = true;
    bumpMovementMetric("trafficQueueActivations");
    setLegacyTrafficTelemetry(ship, state);
    return { mode: "queue", speedCap: 0, heading: null };
  }

  const bypass = chooseBypass(room, ship, other, activeVector, nearby);
  // Commit the pass before the safe gap is exhausted. Head-on traffic has a
  // negative leader speed along this route, so waiting until the following
  // gap is already small leaves no turning room for a vehicle-sized bypass.
  const passTrigger = Math.max(encounter.safeGap + TRAFFIC_PASS_PAD, 1100);
  if (bypass && encounter.physicalGap <= passTrigger) {
    state.mode = "bypass";
    state.side = bypass.side;
    state.bypass = bypass;
    bumpMovementMetric("trafficBypassActivations");
    setLegacyTrafficTelemetry(ship, state);
    return {
      mode: "bypass",
      speedCap: TRAFFIC_BYPASS_SPEED,
      heading: Math.atan2(bypass.entry.y - ship.y, bypass.entry.x - ship.x)
    };
  }

  state.mode = isStationary(other) ? "queue" : "follow";
  state.side = 0;
  state.bypass = null;
  state.crossing = false;
  bumpMovementMetric(state.mode === "queue" ? "trafficQueueActivations" : "trafficFollowActivations");
  setLegacyTrafficTelemetry(ship, state);
  return {
    mode: state.mode,
    speedCap: state.mode === "follow" ? Math.max(0, encounter.otherAlong) : 0,
    heading: null
  };
}

module.exports = { resolveTraffic, trafficState };
