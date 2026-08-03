"use strict";

// Deterministic local ship traffic. Static obstacles belong to navigation;
// moving ships belong here. The controller never rewrites a ship's velocity or
// asks the leading ship to make room. A follower either keeps its normal route,
// follows at the leader's projected speed, queues, or takes one committed
// bypass point and then returns to the route it was already flying.

const { compareEntityIds, fastHypot } = require("./utils");
const { areEntityAllies, areEntityEnemies } = require("./relationships");
const {
  navigationClearanceRadius,
  physicalCollisionRadius
} = require("./movementCollision");
const { isSegmentClear, nearestClearPoint } = require("./movementNavigation");
const { REST_SPEED } = require("./movementTuning");
const { bumpMovementMetric } = require("./movementMetrics");
const {
  trafficIsStationary: isStationary,
  trafficIsPositioned: isPositioned,
  trafficPairKey: pairKey,
  trafficPriorityWinner: priorityWinner
} = require("./movementTrafficPriority");

const TRAFFIC_LOOKAHEAD = 1300;
const TRAFFIC_FOLLOW_GAP = 36;
const TRAFFIC_SIDE_GAP = 20;
const TRAFFIC_PASS_PAD = 80;
const TRAFFIC_BYPASS_SPEED = 180;
const TRAFFIC_PASS_ADVANCE = 220;
const TRAFFIC_RELEASE_GAP = 96;
const TRAFFIC_MAX_QUERY_RANGE = 1800;
const TRAFFIC_PREDICTIVE_HORIZON = 3;
const TRAFFIC_PREDICTIVE_PAD = 80;
const TRAFFIC_BLOCKED_RETENTION_MS = 4000;
const HOLD_SIDESTEP_GAP = 12;
const HOLD_SIDESTEP_DELAY_MS = 150;

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

function routeGoalAlong(ship, origin, vector) {
  const destination = ship?.movement?.destination
    || ship?.movement?.command?.destination;
  if (!destination) return null;
  return (destination.x - origin.x) * vector.x
    + (destination.y - origin.y) * vector.y;
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
      crossing: false,
      blockedAt: null
    };
  }
  if (!Object.prototype.hasOwnProperty.call(runtime.traffic, "blockedAt")) {
    runtime.traffic.blockedAt = null;
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
  state.blockedAt = null;
}

function trafficBlockedPairs(room) {
  return room._trafficBlockedPairs || (room._trafficBlockedPairs = new Map());
}

function rememberedBlockedAt(room, pair, now) {
  const entries = trafficBlockedPairs(room);
  for (const [key, entry] of entries) {
    if (Number(now) - Number(entry?.lastAt) > TRAFFIC_BLOCKED_RETENTION_MS) entries.delete(key);
  }
  const entry = entries.get(pair);
  if (!entry || Number(now) - Number(entry.lastAt) > TRAFFIC_BLOCKED_RETENTION_MS) return null;
  return entry.blockedAt !== null && entry.blockedAt !== undefined
    && Number.isFinite(Number(entry.blockedAt))
    ? Number(entry.blockedAt)
    : null;
}

function rememberBlockedAt(room, pair, blockedAt, now) {
  if (!pair || blockedAt === null || blockedAt === undefined
    || !Number.isFinite(Number(blockedAt))) return;
  trafficBlockedPairs(room).set(pair, {
    blockedAt: Number(blockedAt),
    lastAt: Number(now) || 0
  });
}

function publishTrafficTelemetry(ship, state) {
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

function sameAttackTarget(a, b) {
  const commandA = a?.movement?.command;
  const commandB = b?.movement?.command;
  return commandA?.type === "attack"
    && commandB?.type === "attack"
    && Boolean(commandA.targetId)
    && String(commandA.targetId) === String(commandB.targetId);
}

function combatSlotActive(runtime) {
  const command = runtime?.command;
  const slot = runtime?.combatSlot;
  return command?.type === "attack"
    && slot
    && String(command.targetId || "") === String(slot.targetId || "");
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

function holdApproachActive(ship, runtime) {
  const style = ship?.combatStyleRaw || ship?.combatStyle;
  return runtime?.command?.type === "attack"
    && String(style || "").toLowerCase() === "hold"
    && runtime?.holdEngaged !== true
    && runtime?.holdApproach
    && runtime?.destination;
}

function preferredHoldSidestepSide(ship, other, vector) {
  const ownLane = Number(ship?.movement?.holdApproach?.laneIndex);
  const otherLane = Number(other?.movement?.holdApproach?.laneIndex);
  if (Number.isFinite(ownLane) && Number.isFinite(otherLane)
    && Math.abs(ownLane - otherLane) > 1e-6) return ownLane < otherLane ? -1 : 1;
  const lateral = ((other.x || 0) - (ship.x || 0)) * -vector.y
    + ((other.y || 0) - (ship.y || 0)) * vector.x;
  if (Math.abs(lateral) > 1e-6) return lateral > 0 ? -1 : 1;
  return compareEntityIds(ship, other) <= 0 ? -1 : 1;
}

// Hold traffic uses a short two-point sidestep only while it is still trying to
// reach its own lane. This is deliberately smaller than the general vehicle
// bypass and does not alter either ship's route or lane assignment.
function chooseHoldSidestep(room, ship, other, vector, nearby) {
  const ownRadius = physicalCollisionRadius(ship);
  const otherRadius = physicalCollisionRadius(other);
  const offset = ownRadius + otherRadius + HOLD_SIDESTEP_GAP;
  const perpendicular = { x: -vector.y, y: vector.x };
  const preferred = preferredHoldSidestepSide(ship, other, vector);
  const sides = [preferred, -preferred];
  const clearance = navigationClearanceRadius(ship);
  for (const side of sides) {
    const entryRaw = {
      x: other.x - vector.x * offset + perpendicular.x * side * offset,
      y: other.y - vector.y * offset + perpendicular.y * side * offset
    };
    const exitRaw = {
      x: other.x + vector.x * offset + perpendicular.x * side * offset,
      y: other.y + vector.y * offset + perpendicular.y * side * offset
    };
    const entry = nearestClearPoint(room, entryRaw.x, entryRaw.y, clearance);
    const exit = nearestClearPoint(room, exitRaw.x, exitRaw.y, clearance);
    if (!entry?.clear || !exit?.clear) continue;
    if (fastHypot(entry.x - entryRaw.x, entry.y - entryRaw.y) > HOLD_SIDESTEP_GAP
      || fastHypot(exit.x - exitRaw.x, exit.y - exitRaw.y) > HOLD_SIDESTEP_GAP) continue;
    if (!isSegmentClear(room, ship.x, ship.y, entry.x, entry.y, clearance)
      || !isSegmentClear(room, entry.x, entry.y, exit.x, exit.y, clearance)) continue;
    if (!pointClearOfShips(room, ship, entry, other, nearby)
      || !pointClearOfShips(room, ship, exit, other, nearby)) continue;
    return {
      side,
      entry: { x: entry.x, y: entry.y },
      exit: { x: exit.x, y: exit.y },
      stage: "entry",
      local: true
    };
  }
  return null;
}

function sidestepTrafficResponse(ship, other, vector, state) {
  if (!state?.bypass) return null;
  if (state.bypass.local) {
    const lateral = Math.abs((other.x - ship.x) * -vector.y
      + (other.y - ship.y) * vector.x);
    const physicalGap = fastHypot(ship.x - other.x, ship.y - other.y)
      - physicalCollisionRadius(ship) - physicalCollisionRadius(other);
    if (lateral > physicalCollisionRadius(ship) + physicalCollisionRadius(other) + TRAFFIC_SIDE_GAP
      && physicalGap >= -2) return { released: true };
  }
  if (state.bypass.local && state.bypass.stage === "exit"
    && fastHypot(ship.x - state.bypass.exit.x, ship.y - state.bypass.exit.y) <= TRAFFIC_FOLLOW_GAP) {
    const physicalGap = fastHypot(ship.x - other.x, ship.y - other.y)
      - physicalCollisionRadius(ship) - physicalCollisionRadius(other);
    if (physicalGap >= -2) return { released: true };
  }
  if (bypassReleased(ship, other, vector, state.bypass)) return { released: true };
  if (state.bypass.stage === "entry"
    && fastHypot(ship.x - state.bypass.entry.x, ship.y - state.bypass.entry.y) <= TRAFFIC_FOLLOW_GAP) {
    state.bypass.stage = "exit";
  }
  const point = state.bypass.stage === "entry"
    ? state.bypass.entry
    : state.bypass.exit;
  return {
    released: false,
    mode: "sidestep",
    speedCap: TRAFFIC_BYPASS_SPEED,
    heading: Math.atan2(point.y - ship.y, point.x - ship.x),
    point
  };
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
     predicted = along > 0
       && Math.abs(closestLateral) <= sideLimit
       && fastHypot(closestX, closestY)
         < physicalCollisionRadius(ship) + physicalCollisionRadius(other) + TRAFFIC_PREDICTIVE_PAD;
  }
  const inRouteCorridor = along > 0
    && along <= Math.max(TRAFFIC_LOOKAHEAD, vector.length)
    && Math.abs(lateral) <= sideLimit;
  if (!inRouteCorridor && !predicted) return null;
  // A positive closing rate is not itself a conflict. Until the follower is
  // inside the safe gap, it is simply approaching normally; stopping a ship
  // hundreds of pixels early turns a line of independent attackers into an
  // accidental firing rank. Predictive contacts still qualify above when the
  // projected near point is genuinely within hull clearance.
  if (!predicted && physicalGap > safeGap) return null;
  const ownGoalAlong = routeGoalAlong(ship, ship, vector);
  const otherGoalAlong = routeGoalAlong(other, ship, vector);
  return {
    distance,
    physicalGap,
    otherAlong,
    closing,
    safeGap,
    rx,
    ry,
    predicted,
    followToOwnGoal: Number.isFinite(ownGoalAlong)
      && Number.isFinite(otherGoalAlong)
      && otherGoalAlong > ownGoalAlong + TRAFFIC_FOLLOW_GAP,
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
  const separated = Math.abs(lateral) > physicalCollisionRadius(ship)
      + physicalCollisionRadius(other)
      + TRAFFIC_RELEASE_GAP;
  // A queue must not remain latched to a blocker that has already stopped.
  // It is safe to reconsider the pair in that case; the normal priority and
  // passing-space checks will decide whether to follow, bypass, or queue again.
  return separated || isStationary(other);
}

function friendlyContactDuration(room, ship, other, now) {
  if (!areEntityAllies(room, ship?.ownerId, other)) return 0;
  const contact = room?._shipCollisionContacts?.get(pairKey(ship, other));
  if (!contact) return 0;
  const startedAt = Number(contact.startedAt);
  const lastAt = Number(contact.at);
  if (!Number.isFinite(startedAt) || !Number.isFinite(lastAt)
    || Number(now) - lastAt > 250) return 0;
  return Math.max(0, Number(now) - startedAt);
}

function resolveTraffic(room, ship, runtime, now) {
  const state = trafficState(runtime);
  if (!runtime.destination || !runtime.command || runtime.command.type === "stop") {
    clearTrafficState(runtime);
    publishTrafficTelemetry(ship, state);
    return { mode: "clear", speedCap: null, heading: null };
  }
  const vector = routeVector(ship, runtime);
  if (!vector) {
    clearTrafficState(runtime);
    publishTrafficTelemetry(ship, state);
    return { mode: "clear", speedCap: null, heading: null };
  }
  const targetRelativeCombat = combatSlotActive(runtime);
  const holdApproachTraffic = holdApproachActive(ship, runtime);
  if (targetRelativeCombat && state.mode === "bypass") {
    // Combat slots are target-relative. A sideways pass would turn a firing
    // sector into a second moving formation and can send the hull across the
    // target's other attackers. Keep only the vehicle-like follow/queue result.
    state.mode = "clear";
    state.side = 0;
    state.bypass = null;
    state.crossing = false;
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
      const combatQueue = areEntityAllies(room, ship?.ownerId, blocker)
        && sameAttackTarget(ship, blocker);
      const holdQueue = holdApproachTraffic && areEntityAllies(room, ship?.ownerId, blocker);
      if (state.mode === "sidestep" && state.bypass && holdQueue) {
        const response = sidestepTrafficResponse(ship, blocker, vector, state);
        if (response?.released) {
          clearTrafficState(runtime);
        } else {
          publishTrafficTelemetry(ship, state);
          return response;
        }
      }
      if (state.mode === "soft") {
        const physicalGap = fastHypot(ship.x - blocker.x, ship.y - blocker.y)
          - physicalCollisionRadius(ship) - physicalCollisionRadius(blocker);
        if (physicalGap < TRAFFIC_RELEASE_GAP) {
          publishTrafficTelemetry(ship, state);
          return { mode: "soft", speedCap: null, heading: null };
        }
      }
      if (state.mode === "bypass" && state.bypass && !combatQueue && !holdQueue && !targetRelativeCombat) {
        if (bypassReleased(ship, blocker, vector, state.bypass)) {
          clearTrafficState(runtime);
          publishTrafficTelemetry(ship, state);
          return { mode: "clear", speedCap: null, heading: null };
        }
        if (state.bypass.stage === "entry"
          && fastHypot(ship.x - state.bypass.entry.x, ship.y - state.bypass.entry.y) <= TRAFFIC_FOLLOW_GAP) {
          state.bypass.stage = "exit";
        }
        const point = state.bypass.stage === "entry"
          ? state.bypass.entry
          : state.bypass.exit;
        publishTrafficTelemetry(ship, state);
        return {
          mode: "bypass",
          speedCap: TRAFFIC_BYPASS_SPEED,
          heading: Math.atan2(point.y - ship.y, point.x - ship.x),
          point
        };
      }
      if ((combatQueue || holdQueue) && state.mode === "bypass") {
        state.mode = "clear";
        state.side = 0;
        state.bypass = null;
        state.crossing = false;
      }
      if (state.mode === "queue" && state.crossing
        && !crossingReleased(ship, blocker, vector)) {
        const blockerIsFriendly = areEntityAllies(room, ship?.ownerId, blocker);
        const hasBlockedAt = state.blockedAt !== null
          && state.blockedAt !== undefined
          && Number.isFinite(Number(state.blockedAt));
        const timedOut = blockerIsFriendly && Math.max(
          hasBlockedAt ? now - Number(state.blockedAt) : 0,
          friendlyContactDuration(room, ship, blocker, now)
        ) >= 1500;
        if (timedOut && !holdQueue) {
          state.mode = "soft";
          state.side = 0;
          state.bypass = null;
          state.crossing = false;
          publishTrafficTelemetry(ship, state);
          return { mode: "soft", speedCap: null, heading: null };
        }
        publishTrafficTelemetry(ship, state);
        return { mode: "queue", speedCap: 0, heading: null };
      }
    }
    clearTrafficState(runtime);
    publishTrafficTelemetry(ship, state);
    return { mode: "clear", speedCap: null, heading: null };
  }

  const { other, encounter, pair, vector: activeVector } = best;
  const committedBlocker = state.blockerId
    ? room.ships?.get?.(String(state.blockerId))
    : null;
  const committedCombatQueue = committedBlocker?.alive
    && areEntityAllies(room, ship?.ownerId, committedBlocker)
    && sameAttackTarget(ship, committedBlocker);
  const committedFriendly = committedBlocker?.alive
    && areEntityAllies(room, ship?.ownerId, committedBlocker);
  const committedHoldQueue = holdApproachTraffic && committedFriendly;
  // Once a vehicle has selected an entry and exit, a newly nearer hull must
  // not rebuild that bypass around a different pair. Keep the side and points
  // stable until this blocker has been passed; otherwise a crowded screen can
  // make the follower orbit between freshly generated bypass points.
  if (state.mode === "bypass"
    && state.bypass
    && committedBlocker?.alive
    && !committedCombatQueue
    && !committedHoldQueue
    && !targetRelativeCombat
    && !passedBlocker(ship, committedBlocker, activeVector)) {
    if (bypassReleased(ship, committedBlocker, activeVector, state.bypass)) {
      clearTrafficState(runtime);
    } else {
      if (state.bypass.stage === "entry"
        && fastHypot(ship.x - state.bypass.entry.x, ship.y - state.bypass.entry.y) <= TRAFFIC_FOLLOW_GAP) {
        state.bypass.stage = "exit";
      }
      const point = state.bypass.stage === "entry"
        ? state.bypass.entry
        : state.bypass.exit;
      publishTrafficTelemetry(ship, state);
      return {
        mode: "bypass",
        speedCap: TRAFFIC_BYPASS_SPEED,
        heading: Math.atan2(point.y - ship.y, point.x - ship.x),
        point
      };
    }
  }
  if (state.mode === "sidestep"
    && state.bypass
    && committedBlocker?.alive
    && committedHoldQueue
    && !passedBlocker(ship, committedBlocker, activeVector)) {
    const response = sidestepTrafficResponse(ship, committedBlocker, activeVector, state);
    if (response?.released) {
      clearTrafficState(runtime);
    } else {
      publishTrafficTelemetry(ship, state);
      return response;
    }
  }
  if (state.pairKey !== pair || state.blockerId !== other.id) {
    state.mode = "clear";
    state.blockerId = other.id;
    state.pairKey = pair;
    state.side = 0;
    state.bypass = null;
    state.priorityId = best.winnerId;
    state.crossing = false;
    state.blockedAt = rememberedBlockedAt(room, pair, now);
  }

  const friendlyEncounter = areEntityAllies(room, ship?.ownerId, other);
  // Ships sharing one explicit attack order approach independently. Hold may
  // take its short committed local sidestep; Charge and the older target-slot
  // path remain queue-only. The front ship may enter its positioned phase one
  // update after the rear ship is evaluated, so key this queue on the stable
  // order itself rather than on a phase that can lag by one sequential update.
  const combatQueue = friendlyEncounter && sameAttackTarget(ship, other);
  let hasBlockedAt = state.blockedAt !== null
    && state.blockedAt !== undefined
    && Number.isFinite(Number(state.blockedAt));
  const holdQueue = holdApproachTraffic && friendlyEncounter;
  if (holdQueue && !hasBlockedAt) {
    state.blockedAt = now;
    hasBlockedAt = true;
    rememberBlockedAt(room, pair, state.blockedAt, now);
  }
  if (friendlyEncounter && hasBlockedAt) {
    rememberBlockedAt(room, pair, state.blockedAt, now);
  }
  const friendlyTimedOut = friendlyEncounter && !holdQueue
    && Math.max(
      hasBlockedAt ? now - Number(state.blockedAt) : 0,
      friendlyContactDuration(room, ship, other, now)
    ) >= 1500;
  const holdSidestepReady = holdQueue
    && hasBlockedAt
    && Number(now) - Number(state.blockedAt) >= HOLD_SIDESTEP_DELAY_MS;

  // A stopped formation member can be beyond this ship's own assigned slot.
  // That is not a blocker: the follower's static route ends first, so it should
  // continue to its slot without trying to pass the member parked farther on.
  // If the leader is still moving, cap the follower at the leader's own speed
  // until the leader clears the lane.
  if (encounter.followToOwnGoal && !holdQueue) {
    state.mode = isStationary(other) ? "clear" : "follow";
    state.side = 0;
    state.bypass = null;
    state.crossing = false;
    if (state.mode === "clear") state.blockedAt = null;
    else if (state.blockedAt === null || state.blockedAt === undefined
      || !Number.isFinite(Number(state.blockedAt))) state.blockedAt = now;
    if (state.mode !== "clear") rememberBlockedAt(room, pair, state.blockedAt, now);
    if (state.mode === "clear") {
      publishTrafficTelemetry(ship, state);
      return { mode: "clear", speedCap: null, heading: null };
    }
    bumpMovementMetric("trafficFollowActivations");
    publishTrafficTelemetry(ship, state);
    return {
      mode: "follow",
      speedCap: Math.max(0, encounter.otherAlong),
      heading: null
    };
  }

  // A crossing queue is a committed decision too. Do not turn it into a pass
  // merely because the moving ship has changed its projection while crossing
  // the stopped follower; release it only after the pair has separated laterally.
  if (state.mode === "queue" && state.crossing) {
    if (!crossingReleased(ship, other, activeVector)) {
      if (holdSidestepReady) {
        state.mode = "clear";
        state.crossing = false;
      } else if (friendlyTimedOut) {
        state.mode = "soft";
        state.side = 0;
        state.bypass = null;
        state.crossing = false;
        publishTrafficTelemetry(ship, state);
        return { mode: "soft", speedCap: null, heading: null };
      } else {
        publishTrafficTelemetry(ship, state);
        return { mode: "queue", speedCap: 0, heading: null };
      }
    }
    if (state.mode === "queue") {
      state.mode = "clear";
      state.crossing = false;
    }
  }

  if (state.mode === "bypass" && state.bypass && !combatQueue && !holdQueue && !targetRelativeCombat) {
    if (bypassReleased(ship, other, activeVector, state.bypass)) {
      clearTrafficState(runtime);
      publishTrafficTelemetry(ship, state);
      return { mode: "clear", speedCap: null, heading: null };
    }
    if (state.bypass.stage === "entry"
      && fastHypot(ship.x - state.bypass.entry.x, ship.y - state.bypass.entry.y) <= TRAFFIC_FOLLOW_GAP) {
      state.bypass.stage = "exit";
    }
    const point = state.bypass.stage === "entry"
      ? state.bypass.entry
      : state.bypass.exit;
    publishTrafficTelemetry(ship, state);
    return {
      mode: "bypass",
      speedCap: TRAFFIC_BYPASS_SPEED,
      heading: Math.atan2(point.y - ship.y, point.x - ship.x),
      point
    };
  }

  if (encounter.crossing && !holdSidestepReady) {
    if (friendlyTimedOut) {
      state.mode = "soft";
      state.side = 0;
      state.bypass = null;
      state.crossing = false;
      publishTrafficTelemetry(ship, state);
      return { mode: "soft", speedCap: null, heading: null };
    }
    state.mode = "queue";
    state.side = 0;
    state.bypass = null;
    state.crossing = true;
    if (state.blockedAt === null || state.blockedAt === undefined
      || !Number.isFinite(Number(state.blockedAt))) state.blockedAt = now;
    if (friendlyEncounter) rememberBlockedAt(room, pair, state.blockedAt, now);
    bumpMovementMetric("trafficQueueActivations");
    publishTrafficTelemetry(ship, state);
    return { mode: "queue", speedCap: 0, heading: null };
  }

  const holdSidestep = holdSidestepReady
    ? chooseHoldSidestep(room, ship, other, activeVector, nearby)
    : null;
  const bypass = holdSidestep || (targetRelativeCombat || combatQueue || holdQueue
    ? null
    : chooseBypass(room, ship, other, activeVector, nearby));
  // Commit the pass before the safe gap is exhausted. Head-on traffic has a
  // negative leader speed along this route, so waiting until the following
  // gap is already small leaves no turning room for a vehicle-sized bypass.
  const passTrigger = holdSidestep
    ? Math.max(encounter.safeGap + HOLD_SIDESTEP_GAP, 180)
    : Math.max(encounter.safeGap + TRAFFIC_PASS_PAD, 1100);
  if (bypass && encounter.physicalGap <= passTrigger) {
    state.mode = holdSidestep ? "sidestep" : "bypass";
    state.side = bypass.side;
    state.bypass = bypass;
    if (friendlyEncounter && (state.blockedAt === null || state.blockedAt === undefined
      || !Number.isFinite(Number(state.blockedAt)))) state.blockedAt = now;
    if (friendlyEncounter) rememberBlockedAt(room, pair, state.blockedAt, now);
    bumpMovementMetric(holdSidestep ? "trafficSidestepActivations" : "trafficBypassActivations");
    publishTrafficTelemetry(ship, state);
    return {
      mode: holdSidestep ? "sidestep" : "bypass",
      speedCap: TRAFFIC_BYPASS_SPEED,
      heading: Math.atan2(bypass.entry.y - ship.y, bypass.entry.x - ship.x),
      point: bypass.entry
    };
  }

  // A friendly pair that has had no usable bypass for long enough is released
  // from the queue. This check deliberately follows bypass selection: a
  // committed pass remains a pass, while a blocked follower gets the timed
  // soft-overlap behavior instead of oscillating between queue and sidestep.
  if (friendlyTimedOut) {
    state.mode = "soft";
    state.side = 0;
    state.bypass = null;
    state.crossing = false;
    publishTrafficTelemetry(ship, state);
    return { mode: "soft", speedCap: null, heading: null };
  }

  state.mode = isStationary(other) ? "queue" : "follow";
  state.side = 0;
  state.bypass = null;
  state.crossing = false;
  if (state.mode === "queue" || state.mode === "follow") {
    if (state.blockedAt === null || state.blockedAt === undefined
      || !Number.isFinite(Number(state.blockedAt))) state.blockedAt = now;
  } else {
    state.blockedAt = null;
  }
  if (friendlyEncounter && state.blockedAt !== null && state.blockedAt !== undefined
    && Number.isFinite(Number(state.blockedAt))) {
    rememberBlockedAt(room, pair, state.blockedAt, now);
  }
  bumpMovementMetric(state.mode === "queue" ? "trafficQueueActivations" : "trafficFollowActivations");
  publishTrafficTelemetry(ship, state);
  return {
    mode: state.mode,
    speedCap: state.mode === "follow" ? Math.max(0, encounter.otherAlong) : 0,
    heading: null
  };
}

module.exports = { resolveTraffic, trafficState };
