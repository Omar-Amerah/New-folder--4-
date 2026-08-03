"use strict";

// Shared broad-phase state for the canonical drone decision layer. This module
// deliberately owns only conservative candidate sets. Target selection,
// visibility, relationship checks and scoring remain per-drone in drones.js.

const { performanceNow } = require("./utils");
const { bump, recordDuration } = require("./roomTelemetry");

function contextKey(parentShipId, bayComponentId, droneType, ownerId, teamId) {
  return [parentShipId, bayComponentId, droneType, ownerId, teamId].map((value) => String(value ?? "")).join("|");
}

function clearArray(array) {
  if (Array.isArray(array)) array.length = 0;
  return array;
}

function ensureDroneDecisionRuntime(room) {
  if (!room) return null;
  let runtime = room._droneDecisionRuntime;
  const epoch = room.stateEpoch ?? 0;
  if (!runtime) {
    runtime = {
      frameId: -1,
      generation: 0,
      roomEpoch: epoch,
      contexts: new Map(),
      recoveryGeneration: -1
    };
    room._droneDecisionRuntime = runtime;
  } else if (runtime.roomEpoch !== epoch) {
    runtime.frameId = -1;
    runtime.generation = 0;
    runtime.roomEpoch = epoch;
    runtime.recoveryGeneration = -1;
    runtime.contexts.clear();
    room._droneContextSpeedCache = null;
  }
  return runtime;
}

function resetDroneDecisionRuntime(room) {
  const runtime = room?._droneDecisionRuntime;
  if (runtime) {
    runtime.frameId = -1;
    runtime.generation = 0;
    runtime.roomEpoch = room?.stateEpoch ?? 0;
    runtime.recoveryGeneration = -1;
    runtime.contexts.clear();
  }
  if (room) {
    const memberScratch = room._droneContextMemberScratch;
    memberScratch?.forEach?.((members) => clearArray(members));
    memberScratch?.clear?.();
    room._droneContextSpeedCache = null;
    room._droneFrameId = 0;
  }
  return runtime || null;
}

function beginDroneDecisionFrame(room, frameId, now = 0) {
  const runtime = ensureDroneDecisionRuntime(room);
  if (!runtime) return null;
  if (runtime.frameId !== frameId) {
    runtime.frameId = frameId;
    runtime.generation += 1;
    runtime.recoveryGeneration = -1;
  }
  runtime.now = now;
  return runtime;
}

function createContext() {
  return {
    frameId: -1,
    generation: 0,
    parentShipId: null,
    bayComponentId: null,
    droneType: null,
    ownerId: null,
    teamId: null,
    roomEpoch: null,
    bayRevision: null,
    spatialIndex: null,
    spatialGeneration: null,
    sourceCounts: null,
    centreX: 0,
    centreY: 0,
    maximumDroneDisplacement: 0,
    queryRadius: 0,
    largestRelevantRange: 0,
    movementAllowance: 0,
    candidateMovementAllowance: 0,
    hostileShips: [],
    hostileDrones: [],
    hostileProjectiles: [],
    repairShips: [],
    builtAt: 0,
    lastUsedAt: 0,
    validUntil: 0,
    memberCount: 0,
    fallbackCount: 0
  };
}

function contextFor(runtime, parent, bay, droneType, ownerId, teamId) {
  const key = contextKey(parent?.id, bay?.componentId, droneType, ownerId, teamId);
  let context = runtime.contexts.get(key);
  if (!context) {
    context = createContext();
    runtime.contexts.set(key, context);
  }
  return context;
}

function copyFallback(target, source) {
  target.length = 0;
  for (const entity of source || []) if (entity) target.push(entity);
  return target;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sourceCounts(room) {
  return {
    ships: Number(room?.ships?.size) || 0,
    drones: Number(room?.drones?.size) || 0,
    projectiles: Array.isArray(room?.bullets) ? room.bullets.length : 0
  };
}

function sameSourceCounts(left, right) {
  return Boolean(left && right)
    && left.ships === right.ships
    && left.drones === right.drones
    && left.projectiles === right.projectiles;
}

function spatialGeneration(spatial) {
  if (!spatial) return null;
  // Older SpatialIndex instances do not expose a structural generation yet;
  // builtAt still changes on a full rebuild/recovery and is a safe fallback.
  return spatial.dynamicGeneration ?? spatial.builtAt ?? null;
}

function candidateMovementSpeed(room, spatial, fallback) {
  const generation = spatialGeneration(spatial);
  const cached = room?._droneContextSpeedCache;
  if (cached?.spatialIndex === spatial && cached.generation === generation) return cached.speed;
  let speed = Math.max(0, finite(fallback));
  const records = spatial?.kindState
    ? [
      ...(spatial.kindState.ships?.records || []),
      ...(spatial.kindState.drones?.records || []),
      ...(spatial.kindState.projectiles?.records || [])
    ]
    : [];
  const entities = records.length
    ? records.map((record) => record.entity)
    : [
      ...(room?.ships?.values?.() || []),
      ...(room?.drones?.values?.() || []),
      ...(room?.bullets || [])
    ];
  for (const entity of entities) {
    if (!entity) continue;
    speed = Math.max(
      speed,
      finite(entity.stats?.maxSpeed),
      finite(entity.maxSpeed),
      Math.hypot(finite(entity.vx), finite(entity.vy))
    );
  }
  if (room) room._droneContextSpeedCache = { spatialIndex: spatial, generation, speed };
  return speed;
}

function contextRange(config, room) {
  const commandRange = Math.max(0, finite(config?.commandRange));
  const weaponRange = Math.max(0, finite(config?.weaponRange));
  const lookahead = Math.max(0, finite(config?.evasionLookaheadSeconds));
  const clearance = Math.max(0, finite(config?.evasionClearance));
  const projectileSpeed = Math.max(0, finite(room?.spatialIndex?.maxProjectileSpeed));
  const evasionRange = lookahead > 0 && clearance > 0
    ? (projectileSpeed + Math.max(0, finite(config?.speed))) * lookahead + clearance
    : 0;
  return Math.max(commandRange, weaponRange, evasionRange);
}

function contextCoversPoint(context, x, y, range = 0) {
  if (!context || context.frameId < 0) return false;
  const dx = finite(x) - context.centreX;
  const dy = finite(y) - context.centreY;
  return Math.hypot(dx, dy) + Math.max(0, finite(range)) <= context.queryRadius + 0.001;
}

function buildDroneDecisionContext(room, parent, bay, droneType, config, members, now, frameId, bayRevision = null) {
  const runtime = beginDroneDecisionFrame(room, frameId, now);
  if (!runtime || !parent || !bay) return null;
  const balanceConfig = config?.config || config;
  const context = contextFor(runtime, parent, bay, droneType, parent.ownerId, parent.team || room.players?.get?.(parent.ownerId)?.team || null);
  const resolvedBayRevision = bayRevision
    ?? bay?._runtimeFrameState?.revision
    ?? (Number(bay?._modeRevision) || 0);
  const spatial = room.spatialIndex?.dynamicValid ? room.spatialIndex : null;
  const counts = sourceCounts(room);
  let memberCount = 0;
  for (const drone of members || []) {
    if (!drone || drone.destroyed || drone.removed) continue;
    memberCount += 1;
  }
  const reusable = context.frameId >= 0
    && context.validUntil >= now
    && context.roomEpoch === (room.stateEpoch ?? 0)
    && context.bayRevision === resolvedBayRevision
    && context.spatialIndex === spatial
    && context.spatialGeneration === spatialGeneration(spatial)
    && sameSourceCounts(context.sourceCounts, counts)
    && context.memberCount === memberCount;
  if (reusable) {
    // A context is a bounded-time decision cache, not a single-tick cache.
    // Keep the latest frame marker for diagnostics while retaining the broad
    // phase built during the earlier staggered decision.
    context.frameId = frameId;
    context.lastUsedAt = now;
    bump(room, "droneContextHits");
    return context;
  }

  const startedAt = performanceNow();
  const pose = bay._runtimeFrameState;
  const centreX = finite(pose?.worldX, finite(parent.x));
  const centreY = finite(pose?.worldY, finite(parent.y));
  let maximumDroneDisplacement = 0;
  for (const drone of members || []) {
    if (!drone || drone.destroyed || drone.removed) continue;
    maximumDroneDisplacement = Math.max(maximumDroneDisplacement, Math.hypot(finite(drone.x) - centreX, finite(drone.y) - centreY));
  }

  const largestRelevantRange = contextRange(balanceConfig, room);
  const intervalMs = Math.max(1, finite(config?.decisionIntervalMs, 120));
  const intervalSeconds = Math.max(0.05, intervalMs / 1000);
  const padding = Math.max(0, finite(room.droneSpatialPadding)) + 2;
  const droneMovementAllowance = Math.max(0, finite(balanceConfig?.speed)) * intervalSeconds + padding;
  const candidateSpeed = Math.max(
    Math.max(0, finite(balanceConfig?.speed)),
    Math.max(0, finite(room?.droneDecisionMaxCandidateSpeed)),
    Math.max(0, finite(room?.spatialIndex?.maxProjectileSpeed)),
    candidateMovementSpeed(room, spatial, balanceConfig?.speed)
  );
  // Candidates can move while a staggered context is reused. Include a
  // conservative candidate allowance in the original broad phase and let the
  // per-drone envelope check reject reuse after the window is exceeded.
  const candidateMovementAllowance = candidateSpeed * intervalSeconds + padding;
  const movementAllowance = Math.max(droneMovementAllowance, candidateMovementAllowance);
  const parentOffset = Math.hypot(finite(parent.x) - centreX, finite(parent.y) - centreY);
  const queryRadius = largestRelevantRange + maximumDroneDisplacement + movementAllowance + parentOffset;

  context.frameId = frameId;
  context.generation = runtime.generation;
  context.roomEpoch = room.stateEpoch ?? 0;
  context.bayRevision = resolvedBayRevision;
  context.spatialIndex = spatial;
  context.spatialGeneration = spatialGeneration(spatial);
  context.sourceCounts = counts;
  context.parentShipId = parent.id;
  context.bayComponentId = bay.componentId;
  context.droneType = droneType;
  context.ownerId = parent.ownerId;
  context.teamId = parent.team || room.players?.get?.(parent.ownerId)?.team || null;
  context.centreX = centreX;
  context.centreY = centreY;
  context.maximumDroneDisplacement = maximumDroneDisplacement;
  context.queryRadius = queryRadius;
  context.largestRelevantRange = largestRelevantRange;
  context.movementAllowance = movementAllowance;
  context.candidateMovementAllowance = candidateMovementAllowance;
  context.memberCount = memberCount;
  context.fallbackCount = 0;
  context.builtAt = now;
  context.lastUsedAt = now;
  context.validUntil = now + intervalMs;

  clearArray(context.hostileShips);
  clearArray(context.hostileDrones);
  clearArray(context.hostileProjectiles);

  if (spatial?.queryRangeUnordered) {
    spatial.queryRangeUnordered("ships", centreX, centreY, queryRadius, context.hostileShips);
    spatial.queryRangeUnordered("drones", centreX, centreY, queryRadius, context.hostileDrones);
    spatial.queryRangeUnordered("projectiles", centreX, centreY, queryRadius, context.hostileProjectiles);
    bump(room, "droneContextShipQueries");
    bump(room, "droneContextDroneQueries");
    bump(room, "droneContextProjectileQueries");
  } else {
    copyFallback(context.hostileShips, room.ships?.values?.() || []);
    copyFallback(context.hostileDrones, room.drones?.values?.() || []);
    copyFallback(context.hostileProjectiles, room.bullets || []);
    markContextFallback(room, context);
  }

  // Repair scoring uses the same conservative ship superset. Copying into a
  // context-owned reusable buffer avoids a second broad-phase query while
  // preserving the semantic distinction between repair and hostile consumers.
  clearArray(context.repairShips);
  for (const ship of context.hostileShips) context.repairShips.push(ship);
  // This is a deliberately conservative accounting proxy for benchmark
  // reporting: an individual decision would have inspected the shared
  // candidate superset once per active member. It is not a second query and
  // does not affect gameplay or the canonical path's work.
  const contextCandidateCount = context.hostileShips.length
    + context.hostileDrones.length
    + context.hostileProjectiles.length;
  const individualCandidateEstimate = contextCandidateCount * Math.max(1, memberCount);
  bump(room, "droneContextCandidateCount", contextCandidateCount);
  bump(room, "droneContextIndividualCandidateEstimate", individualCandidateEstimate);
  bump(room, "droneContextCandidatesAvoided", Math.max(0, individualCandidateEstimate - contextCandidateCount));
  bump(room, "droneContextIndividualQueriesAvoided", Math.max(0, memberCount - 1) * 3);
  bump(room, "droneContextsBuilt");
  bump(room, "droneContextMembers", memberCount);
  bump(room, "droneShipCandidatesVisited", context.hostileShips.length);
  bump(room, "droneDroneCandidatesVisited", context.hostileDrones.length);
  bump(room, "droneProjectileCandidatesVisited", context.hostileProjectiles.length);
  bump(room, "droneRepairCandidatesVisited", context.repairShips.length);
  recordDuration(room, "droneContextBuildMs", startedAt);
  return context;
}

function markContextFallback(room, context) {
  if (context) context.fallbackCount += 1;
  bump(room, "droneContextFallbacks");
}

module.exports = {
  contextKey,
  ensureDroneDecisionRuntime,
  resetDroneDecisionRuntime,
  beginDroneDecisionFrame,
  buildDroneDecisionContext,
  contextCoversPoint,
  markContextFallback
};
