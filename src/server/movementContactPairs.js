"use strict";

// Phase 4C: one room-local, authoritative-step ship contact broad phase.
//
// The legacy separation loop asks the spatial index for every ship on every
// iteration.  This module owns the replacement candidate set.  It deliberately
// contains only ship references and deterministic ranks; narrow-phase geometry,
// mass weighting and recovery remain in movementCollision.js.

const { compareEntityIds, fastHypot, performanceNow } = require("./utils");
const { bump, setCounter, recordDuration } = require("./roomTelemetry");
const {
  SEPARATION_BROAD_PHASE_PAD,
  SEPARATION_CORRECTION,
  SEPARATION_SLOP
} = require("./movementTuning");
const { physicalCollisionRadius } = require("./movementCollision");
const { findShipHullOverlap } = require("./componentGeometry");

const MIN_CONTACT_PADDING = 8;
const CONTACT_STATIC_CORRECTION_SCALE = 0.5;
const MATERIAL_MOVEMENT_DELTA = 0.001;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isLiveShip(room, ship) {
  return Boolean(
    ship
      && ship.alive === true
      && ship.removed !== true
      && (!room?.ships || room.ships.get(ship.id) === ship)
  );
}

function compareShips(a, b) {
  return compareEntityIds(a, b);
}

function makePair() {
  return {
    a: null,
    b: null,
    aId: null,
    bId: null,
    orderA: 0,
    orderB: 0
  };
}

function ensureState(room) {
  if (!room) return null;
  if (!Array.isArray(room._movementContactPairs)) room._movementContactPairs = [];
  if (!Array.isArray(room._movementContactPairPool)) room._movementContactPairPool = [];
  if (!(room._movementContactPairKeys instanceof Set)) room._movementContactPairKeys = new Set();
  if (!(room._movementContactPairRankByShip instanceof Map)) room._movementContactPairRankByShip = new Map();
  if (!Array.isArray(room._movementContactPairQueryScratch)) room._movementContactPairQueryScratch = [];
  if (!Array.isArray(room._movementContactPairShipsScratch)) room._movementContactPairShipsScratch = [];
  if (!Array.isArray(room._movementContactPairSweepScratch)) room._movementContactPairSweepScratch = [];
  if (!Array.isArray(room._movementContactPairActiveScratch)) room._movementContactPairActiveScratch = [];
  if (!Array.isArray(room._movementContactPairPreviousShips)) room._movementContactPairPreviousShips = [];
  if (!Array.isArray(room._movementContactPairMovedShipsScratch)) room._movementContactPairMovedShipsScratch = [];
  if (!Array.isArray(room._movementContactPairMissingPairsScratch)) room._movementContactPairMissingPairsScratch = [];
  if (!Array.isArray(room._movementContactPairRecoveryPairsScratch)) room._movementContactPairRecoveryPairsScratch = [];
  if (!(room._movementContactPairMissingKeys instanceof Set)) room._movementContactPairMissingKeys = new Set();
  if (!(room._movementContactPairMovedKeys instanceof Set)) room._movementContactPairMovedKeys = new Set();
  if (!(room._movementContactPairRecoveryPairSet instanceof Set)) room._movementContactPairRecoveryPairSet = new Set();
  if (!Number.isFinite(Number(room._movementContactPairPoolCursor))) room._movementContactPairPoolCursor = 0;
  if (room._movementContactPairPoolNeedsHoleSearch !== true) room._movementContactPairPoolNeedsHoleSearch = false;
  if (!Number.isFinite(Number(room._movementContactStepSerial))) room._movementContactStepSerial = 0;
  return room;
}

function clearPairReferences(room) {
  const state = ensureState(room);
  if (!state) return;
  for (const pair of state._movementContactPairs) {
    pair.a = null;
    pair.b = null;
    pair.aId = null;
    pair.bId = null;
    pair.orderA = 0;
    pair.orderB = 0;
    pair._packedLastPenetration = 0;
  }
  state._movementContactPairs.length = 0;
  // The pool is room-local. Clearing it here matters on room reset: a pooled
  // pair must never keep a dead ship alive through a reset or match restart.
  for (const pair of state._movementContactPairPool) {
    pair.a = null;
    pair.b = null;
    pair.aId = null;
    pair.bId = null;
    pair.orderA = 0;
    pair.orderB = 0;
  }
  state._movementContactPairKeys.clear();
  state._movementContactPairRankByShip.clear();
  state._movementContactPairQueryScratch.length = 0;
  state._movementContactPairShipsScratch.length = 0;
  state._movementContactPairSweepScratch.length = 0;
  state._movementContactPairActiveScratch.length = 0;
  state._movementContactPairPreviousShips.length = 0;
  state._movementContactPairMovedShipsScratch.length = 0;
  state._movementContactPairMissingPairsScratch.length = 0;
  state._movementContactPairRecoveryPairsScratch.length = 0;
  state._movementContactPairMissingKeys.clear();
  state._movementContactPairMovedKeys.clear();
  state._movementContactPairRecoveryPairSet.clear();
  state._movementContactPairPoolCursor = 0;
  state._movementContactPairPoolNeedsHoleSearch = false;
  state._movementContactPairBuildStepId = null;
  state._movementContactPairStepId = null;
  state._movementContactPairUnsafe = false;
  state._movementContactPairPadding = null;
  state._movementContactPairRecoveryAttempted = false;
  state._movementContactPairRecoveryOperations = 0;
  state._movementContactPairPoolCursor = 0;
  state._movementContactPairPoolNeedsHoleSearch = false;
}

function clearMovementContactPairs(room) {
  clearPairReferences(room);
  if (room) {
    room._movementContactPairInvalidationReason = null;
    room._movementContactPairNeedsRecovery = false;
  }
}

function beginMovementContactStep(room, ships, now = 0) {
  const state = ensureState(room);
  if (!state) return null;

  // Release the previous step's active references before capturing the next
  // step. The pool itself survives so normal ticks do not allocate pair objects.
  for (const pair of state._movementContactPairs) {
    pair.a = null;
    pair.b = null;
    pair.aId = null;
    pair.bId = null;
    pair.orderA = 0;
    pair.orderB = 0;
  }
  state._movementContactPairs.length = 0;
  state._movementContactPairKeys.clear();
  state._movementContactPairRankByShip.clear();
  state._movementContactPairBuildStepId = null;
  state._movementContactPairUnsafe = false;
  state._movementContactPairInvalidatedAt = finite(now);
  state._movementContactPairStepId = ++state._movementContactStepSerial;
  state._movementContactPairNeedsRecovery = false;
  state._movementContactPairRecoveryAttempted = false;
  state._movementContactPairRecoveryOperations = 0;
  room._movementContactPairMaxObservedThisTick = 0;

  const previous = state._movementContactPairPreviousShips;
  previous.length = 0;
  for (const ship of ships || []) {
    if (!isLiveShip(room, ship)) continue;
    // Previous and current positions are authoritative movement positions. The
    // swept query uses these values, while the final point is still the solver's
    // source of truth.
    ship._movementContactPreviousX = finite(ship.x);
    ship._movementContactPreviousY = finite(ship.y);
    ship._movementContactPreviousStep = state._movementContactPairStepId;
    previous.push(ship);
  }
  return state._movementContactPairStepId;
}

function pairSort(a, b) {
  return a.orderA - b.orderA || a.orderB - b.orderB;
}

function liveShipsForStep(room, ships, state) {
  const output = state._movementContactPairShipsScratch;
  output.length = 0;
  const seen = new Set();
  for (const ship of ships || room?.ships?.values?.() || []) {
    if (!isLiveShip(room, ship) || seen.has(ship)) continue;
    seen.add(ship);
    output.push(ship);
  }
  output.sort(compareShips);
  return output;
}

function calculatePadding(maxPhysicalRadius, maximumObservedStaticCorrection) {
  // A pair is built for positions after movement/static pre-correction. The
  // extra radius is derived from two bounded contact corrections (one endpoint
  // can move away from its neighbour while the other endpoint is also moved),
  // rather than a world-sized query. A contact island carries subsequent
  // corrections through its already-connected graph; a genuinely new edge is
  // handled by the scoped recovery path. The existing broad-phase pad remains a
  // hard ceiling for pathological hull sizes. A quarter-radius static allowance
  // covers the normal final map/station correction after separation.
  const solverCorrectionBound = Math.min(
    SEPARATION_BROAD_PHASE_PAD,
    Math.max(
      MIN_CONTACT_PADDING,
      maxPhysicalRadius * SEPARATION_CORRECTION * 2
    )
  );
  const staticCorrectionBound = Math.min(
    SEPARATION_BROAD_PHASE_PAD,
    Math.max(
      MIN_CONTACT_PADDING,
      maxPhysicalRadius * CONTACT_STATIC_CORRECTION_SCALE * 0.5,
      finite(maximumObservedStaticCorrection)
    )
  );
  return {
    solverCorrectionBound,
    staticCorrectionBound,
    total: solverCorrectionBound + staticCorrectionBound + SEPARATION_SLOP
  };
}

function sweptBounds(ship, padding, stepId) {
  const previousX = ship._movementContactPreviousStep === stepId
    ? finite(ship._movementContactPreviousX, ship.x)
    : finite(ship.x);
  const previousY = ship._movementContactPreviousStep === stepId
    ? finite(ship._movementContactPreviousY, ship.y)
    : finite(ship.y);
  const currentX = finite(ship.x);
  const currentY = finite(ship.y);
  const radius = physicalCollisionRadius(ship) + padding;
  return {
    minX: Math.min(previousX, currentX) - radius,
    maxX: Math.max(previousX, currentX) + radius,
    minY: Math.min(previousY, currentY) - radius,
    maxY: Math.max(previousY, currentY) + radius
  };
}

function pairWithinSweptBounds(a, b, padding, stepId) {
  const radius = physicalCollisionRadius(a) + physicalCollisionRadius(b) + padding;
  const aPreviousX = a._movementContactPreviousStep === stepId ? finite(a._movementContactPreviousX, a.x) : finite(a.x);
  const aPreviousY = a._movementContactPreviousStep === stepId ? finite(a._movementContactPreviousY, a.y) : finite(a.y);
  const bPreviousX = b._movementContactPreviousStep === stepId ? finite(b._movementContactPreviousX, b.x) : finite(b.x);
  const bPreviousY = b._movementContactPreviousStep === stepId ? finite(b._movementContactPreviousY, b.y) : finite(b.y);
  const aMinX = Math.min(aPreviousX, finite(a.x));
  const aMaxX = Math.max(aPreviousX, finite(a.x));
  const aMinY = Math.min(aPreviousY, finite(a.y));
  const aMaxY = Math.max(aPreviousY, finite(a.y));
  const bMinX = Math.min(bPreviousX, finite(b.x));
  const bMaxX = Math.max(bPreviousX, finite(b.x));
  const bMinY = Math.min(bPreviousY, finite(b.y));
  const bMaxY = Math.max(bPreviousY, finite(b.y));
  return aMaxX >= bMinX - radius
    && bMaxX >= aMinX - radius
    && aMaxY >= bMinY - radius
    && bMaxY >= aMinY - radius;
}

function pairKey(orderA, orderB) {
  return `${orderA}:${orderB}`;
}

function createOrReusePair(state, indexA, indexB, a, b) {
  // Active pairs can have been compacted after a destruction. The cursor uses
  // the normal append path without an O(pool-size) scan; only an exceptional
  // recovery that encounters holes before the cursor searches for one.
  let pair = null;
  const pool = state._movementContactPairPool;
  let cursor = Math.max(0, Number(state._movementContactPairPoolCursor) || 0);
  while (cursor < pool.length && (pool[cursor]?.a !== null || pool[cursor]?.b !== null)) cursor += 1;
  if (cursor < pool.length) {
    pair = pool[cursor];
    state._movementContactPairPoolCursor = cursor + 1;
  } else {
    if (state._movementContactPairPoolNeedsHoleSearch) {
      for (let index = 0; index < cursor; index += 1) {
        const candidate = pool[index];
        if (candidate?.a === null && candidate?.b === null) {
          pair = candidate;
          break;
        }
      }
    }
    if (!pair) {
      pair = makePair();
      pool.push(pair);
      state._movementContactPairPoolCursor = pool.length;
    }
  }
  pair.a = a;
  pair.b = b;
  pair.aId = a.id;
  pair.bId = b.id;
  pair.orderA = indexA;
  pair.orderB = indexB;
  pair._packedLastPenetration = 0;
  state._movementContactPairs.push(pair);
  return pair;
}

function buildMovementContactPairs(room, ships, now = 0, options = {}) {
  const state = ensureState(room);
  if (!state) return [];
  const stepId = options.stepId ?? state._movementContactPairStepId ?? (++state._movementContactStepSerial);
  if (!options.recovery && state._movementContactPairBuildStepId === stepId) {
    return state._movementContactPairs;
  }

  const buildStart = performanceNow();
  const ordered = liveShipsForStep(room, ships, state);
  if (ordered.length === 0) {
    state._movementContactPairs.length = 0;
    state._movementContactPairKeys.clear();
    state._movementContactPairRankByShip.clear();
    state._movementContactPairPoolCursor = 0;
    state._movementContactPairBuildStepId = stepId;
    if (!options.recovery) state._movementContactPairStepId = stepId;
    return state._movementContactPairs;
  }

  // A recovery build is intentionally exceptional. The normal post-solver
  // recovery preserves the existing graph and adds only the affected ships'
  // current spatial neighbourhood. Explicit force-all recovery remains
  // available for diagnostics and invalidation paths where the current index
  // cannot be trusted.
  const scopedRecovery = Boolean(options.recovery && Array.isArray(options.scopeShips));
  const previousPairCount = state._movementContactPairs.length;
  if (!scopedRecovery) {
    for (const pair of state._movementContactPairs) {
      pair.a = null;
      pair.b = null;
      pair.aId = null;
      pair.bId = null;
      pair.orderA = 0;
      pair.orderB = 0;
      pair._packedLastPenetration = 0;
    }
    state._movementContactPairs.length = 0;
    state._movementContactPairPoolCursor = 0;
    state._movementContactPairPoolNeedsHoleSearch = false;
  }
  state._movementContactPairKeys.clear();
  state._movementContactPairRankByShip.clear();
  for (let index = 0; index < ordered.length; index += 1) {
    state._movementContactPairRankByShip.set(ordered[index], index);
  }
  if (scopedRecovery) {
    const retained = state._movementContactPairRecoveryPairsScratch;
    const retainedSet = state._movementContactPairRecoveryPairSet;
    retained.length = 0;
    retainedSet.clear();
    for (let index = 0; index < previousPairCount; index += 1) {
      const pair = state._movementContactPairs[index];
      if (!isLiveShip(room, pair?.a) || !isLiveShip(room, pair?.b) || pair.a === pair.b) continue;
      const rankA = state._movementContactPairRankByShip.get(pair.a);
      const rankB = state._movementContactPairRankByShip.get(pair.b);
      if (rankA === undefined || rankB === undefined) continue;
      const low = Math.min(rankA, rankB);
      const high = Math.max(rankA, rankB);
      const key = pairKey(low, high);
      if (state._movementContactPairKeys.has(key)) continue;
      pair.a = ordered[low];
      pair.b = ordered[high];
      pair.aId = pair.a.id;
      pair.bId = pair.b.id;
      pair.orderA = low;
      pair.orderB = high;
      pair._packedLastPenetration = 0;
      state._movementContactPairKeys.add(key);
      retained.push(pair);
      retainedSet.add(pair);
    }
    for (let index = 0; index < previousPairCount; index += 1) {
      const pair = state._movementContactPairs[index];
      if (!pair || retainedSet.has(pair)) continue;
      pair.a = null;
      pair.b = null;
      pair.aId = null;
      pair.bId = null;
      pair.orderA = 0;
      pair.orderB = 0;
      pair._packedLastPenetration = 0;
    }
    state._movementContactPairs.length = 0;
    for (const pair of retained) state._movementContactPairs.push(pair);
    if (retained.length < previousPairCount) state._movementContactPairPoolNeedsHoleSearch = true;
    retained.length = 0;
    retainedSet.clear();
  }

  let maxPhysicalRadius = 18;
  let maximumObservedStaticCorrection = 0;
  for (const ship of ordered) {
    const radius = physicalCollisionRadius(ship);
    maxPhysicalRadius = Math.max(maxPhysicalRadius, radius);
    maximumObservedStaticCorrection = Math.max(
      maximumObservedStaticCorrection,
      fastHypot(ship._collisionCorrectionX || 0, ship._collisionCorrectionY || 0)
    );
  }
  const padding = calculatePadding(maxPhysicalRadius, maximumObservedStaticCorrection);
  state._movementContactPairPadding = padding;

  let candidatesVisited = 0;
  let duplicatesRejected = 0;
  let recoveryQueries = 0;
  let recoveryCandidatesVisited = 0;
  const forceAllPairs = Boolean(options.forceAllPairs);
  const rankOf = state._movementContactPairRankByShip;

  const addCandidate = (a, index, candidate) => {
    const candidateRank = rankOf.get(candidate);
    if (!isLiveShip(room, candidate) || candidateRank === undefined || candidate === a) return;
    const low = Math.min(index, candidateRank);
    const high = Math.max(index, candidateRank);
    const key = pairKey(low, high);
    if (state._movementContactPairKeys.has(key)) {
      duplicatesRejected += 1;
      return;
    }
    state._movementContactPairKeys.add(key);
    createOrReusePair(state, low, high, ordered[low], ordered[high]);
  };

  if (forceAllPairs) {
    for (let index = 0; index < ordered.length; index += 1) {
      for (const candidate of ordered) {
        candidatesVisited += 1;
        addCandidate(ordered[index], index, candidate);
      }
    }
  } else if (scopedRecovery) {
    const scope = [];
    const scopedKeys = new Set();
    for (const ship of options.scopeShips) {
      const rank = rankOf.get(ship);
      if (rank === undefined || !isLiveShip(room, ship)) continue;
      const key = String(ship.id);
      if (scopedKeys.has(key)) continue;
      scopedKeys.add(key);
      scope.push(ship);
    }
    scope.sort(compareShips);
    let maximumRadius = 0;
    for (const ship of ordered) maximumRadius = Math.max(maximumRadius, physicalCollisionRadius(ship));
    const queryScratch = state._movementContactPairQueryScratch;
    const index = room?.spatialIndex;
    const recoveryQueryPadding = padding.total + SEPARATION_BROAD_PHASE_PAD;
    for (const a of scope) {
      const queryRadius = physicalCollisionRadius(a) + maximumRadius + recoveryQueryPadding;
      const usesSpatialQuery = Boolean(index?.queryRangeUnordered);
      if (usesSpatialQuery) recoveryQueries += 1;
      const candidates = usesSpatialQuery
        ? index.queryRangeUnordered("ships", finite(a.x), finite(a.y), queryRadius, queryScratch)
        : ordered;
      recoveryCandidatesVisited += candidates.length;
      if (candidates.length > 1 && candidates !== ordered) candidates.sort(compareShips);
      for (const candidate of candidates) {
        candidatesVisited += 1;
        const candidateRank = rankOf.get(candidate);
        if (candidateRank === undefined || !isLiveShip(room, candidate) || candidate === a) continue;
        addCandidate(a, rankOf.get(a), candidate);
      }
    }
    for (const pair of options.recoveryPairs || []) {
      const aRank = rankOf.get(pair?.a);
      const bRank = rankOf.get(pair?.b);
      if (aRank === undefined || bRank === undefined || aRank === bRank) continue;
      candidatesVisited += 1;
      recoveryCandidatesVisited += 1;
      addCandidate(ordered[Math.min(aRank, bRank)], Math.min(aRank, bRank), ordered[Math.max(aRank, bRank)]);
    }
  } else {
    // A deterministic swept-axis broad phase avoids depending on spatial bucket
    // insertion order and avoids repeatedly visiting every record in a large
    // cell. The spatial index is still refreshed before/after movement for all
    // other gameplay systems; this pass owns the one contact candidate build.
    const sweep = state._movementContactPairSweepScratch;
    const active = state._movementContactPairActiveScratch;
    sweep.length = 0;
    active.length = 0;
    for (const entity of ordered) {
      const bounds = sweptBounds(entity, maxPhysicalRadius + padding.total, stepId);
      entity._movementContactSweepMinX = bounds.minX;
      entity._movementContactSweepMaxX = bounds.maxX;
      entity._movementContactSweepMinY = bounds.minY;
      entity._movementContactSweepMaxY = bounds.maxY;
      sweep.push(entity);
    }
    sweep.sort((left, right) => left._movementContactSweepMinX - right._movementContactSweepMinX || rankOf.get(left) - rankOf.get(right));
    for (const a of sweep) {
      let write = 0;
      for (const candidate of active) {
        if (candidate._movementContactSweepMaxX >= a._movementContactSweepMinX) active[write++] = candidate;
      }
      active.length = write;
      const aRank = rankOf.get(a);
      for (const candidate of active) {
        candidatesVisited += 1;
        if (candidate._movementContactSweepMaxY < a._movementContactSweepMinY
          || a._movementContactSweepMaxY < candidate._movementContactSweepMinY) continue;
        const candidateRank = rankOf.get(candidate);
        const pairPadding = Math.min(
          SEPARATION_BROAD_PHASE_PAD,
          Math.max(MIN_CONTACT_PADDING, Math.max(physicalCollisionRadius(a), physicalCollisionRadius(candidate)) * SEPARATION_CORRECTION * 2)
        ) + padding.staticCorrectionBound + SEPARATION_SLOP;
        if (!pairWithinSweptBounds(a, candidate, pairPadding, stepId)) continue;
        addCandidate(a, aRank, candidate);
      }
      active.push(a);
    }
  }

  state._movementContactPairs.sort(pairSort);
  state._movementContactPairBuildStepId = stepId;
  state._movementContactPairStepId = stepId;
  state._movementContactPairUnsafe = false;
  state._movementContactPairNeedsRecovery = false;
  bump(room, "movementContactPairBuilds");
  if (options.recovery) bump(room, "movementContactPairRecoveryBuilds");
  bump(room, "movementContactPairCandidatesVisited", candidatesVisited);
  bump(room, "movementContactPairDuplicatesRejected", duplicatesRejected);
  bump(room, "movementContactRecoveryQueries", recoveryQueries);
  bump(room, "movementContactRecoveryCandidatesVisited", recoveryCandidatesVisited);
  setCounter(room, "movementContactPairsGenerated", state._movementContactPairs.length);
  setCounter(
    room,
    "movementContactPairMaxPerStep",
    Math.max(
      Number(room?._movementContactPairMaxObservedThisTick) || 0,
      state._movementContactPairs.length
    )
  );
  room._movementContactPairMaxObservedThisTick = Math.max(
    Number(room?._movementContactPairMaxObservedThisTick) || 0,
    state._movementContactPairs.length
  );
  state._movementContactPairSweepScratch.length = 0;
  state._movementContactPairActiveScratch.length = 0;
  state._movementContactPairPreviousShips.length = 0;
  state._movementContactPairMovedShipsScratch.length = 0;
  state._movementContactPairMissingPairsScratch.length = 0;
  state._movementContactPairMissingKeys.clear();
  state._movementContactPairMovedKeys.clear();
  state._movementContactPairRecoveryPairsScratch.length = 0;
  state._movementContactPairRecoveryPairSet.clear();
  recordDuration(room, "movementContactPairBuildMs", buildStart);
  return state._movementContactPairs;
}

function rebuildMovementContactPairsForRecovery(room, ships, now = 0, options = {}) {
  const state = ensureState(room);
  if (!state) return [];
  let stepId = state._movementContactPairStepId;
  if (stepId === null || stepId === undefined) {
    stepId = beginMovementContactStep(room, ships, now);
  }
  state._movementContactPairRecoveryAttempted = true;
  state._movementContactPairRecoveryOperations += 1;
  const scopedRecovery = Array.isArray(options.scopeShips);
  return buildMovementContactPairs(room, ships, now, {
    stepId,
    recovery: true,
    scopeShips: scopedRecovery ? options.scopeShips : undefined,
    recoveryPairs: scopedRecovery ? options.recoveryPairs : undefined,
    forceAllPairs: options.forceAllPairs === undefined ? !scopedRecovery : Boolean(options.forceAllPairs)
  });
}

function getMovementContactPairs(room, stepId = null) {
  const state = ensureState(room);
  if (!state) return [];
  if (stepId !== null && state._movementContactPairBuildStepId !== stepId) return [];
  return state._movementContactPairs;
}

function movementContactPairEntityKey(a, b) {
  const first = compareEntityIds(a, b) <= 0 ? a : b;
  const second = first === a ? b : a;
  return `${String(first?.id)}|${String(second?.id)}`;
}

function hasMovementContactPair(room, a, b) {
  const state = ensureState(room);
  if (!state || !a || !b || a === b) return false;
  const rankA = state._movementContactPairRankByShip.get(a);
  const rankB = state._movementContactPairRankByShip.get(b);
  return rankA !== undefined && rankB !== undefined && hasPairForRanks(state, rankA, rankB);
}

function collectMovementContactMovedShips(room, ships, modifiedShipIds = []) {
  const state = ensureState(room);
  if (!state) return [];
  const moved = state._movementContactPairMovedShipsScratch;
  const movedKeys = state._movementContactPairMovedKeys;
  moved.length = 0;
  movedKeys.clear();

  const source = Array.isArray(ships)
    ? ships
    : [...(room?.ships?.values?.() || [])];
  for (const id of modifiedShipIds || []) {
    const ship = room?.ships?.get?.(id);
    if (!isLiveShip(room, ship)) continue;
    const key = String(ship.id);
    if (movedKeys.has(key)) continue;
    movedKeys.add(key);
    moved.push(ship);
  }
  for (const ship of source) {
    if (!isLiveShip(room, ship)) continue;
    const record = room?.spatialIndex?.recordsByEntity?.ships?.get(ship);
    const movedFromRecord = !record
      || fastHypot(finite(ship.x) - finite(record.x), finite(ship.y) - finite(record.y)) > MATERIAL_MOVEMENT_DELTA;
    // The production tick republishes the ship index before this recovery
    // scan. That makes the record comparison intentionally blind to the
    // movement that just happened. Keep the controller's authoritative
    // movement/correction deltas, and the pre-step position captured by
    // beginMovementContactStep, as the recovery signal as well.
    const movedFromStep = ship._movementContactPreviousStep === room?._movementContactPairStepId
      && fastHypot(
        finite(ship.x) - finite(ship._movementContactPreviousX, ship.x),
        finite(ship.y) - finite(ship._movementContactPreviousY, ship.y)
      ) > MATERIAL_MOVEMENT_DELTA;
    const movedByController = fastHypot(
      finite(ship._integratedMovementX),
      finite(ship._integratedMovementY)
    ) > MATERIAL_MOVEMENT_DELTA;
    const movedByCorrection = fastHypot(
      finite(ship._collisionCorrectionX),
      finite(ship._collisionCorrectionY)
    ) > MATERIAL_MOVEMENT_DELTA;
    if (!movedFromRecord && !movedFromStep && !movedByController && !movedByCorrection) continue;
    const key = String(ship.id);
    if (movedKeys.has(key)) continue;
    movedKeys.add(key);
    moved.push(ship);
  }
  moved.sort(compareShips);
  return moved;
}

function shipsActuallyOverlap(a, b, options = null) {
  const dx = finite(b.x) - finite(a.x);
  const dy = finite(b.y) - finite(a.y);
  const minimum = physicalCollisionRadius(a) + physicalCollisionRadius(b);
  if (dx * dx + dy * dy >= minimum * minimum) return false;
  if (options?.circular) return true;
  return Boolean(findShipHullOverlap(a, b));
}

// This is deliberately a post-solver recovery query, never an iteration query.
// The normal pair build remains the only ordinary broad phase. Only ships whose
// position changed since the last spatial publication are queried, and the
// exact narrow phase filters false AABB candidates before recovery is requested.
function findMissingMovementContactPairs(room, movedShips, options = null) {
  const state = ensureState(room);
  if (!state) return { missingCount: 0, pairs: [] };
  const scanStart = performanceNow();
  const missing = state._movementContactPairMissingPairsScratch;
  const missingKeys = state._movementContactPairMissingKeys;
  const queryScratch = state._movementContactPairQueryScratch;
  missing.length = 0;
  missingKeys.clear();

  let recoveryQueries = 0;
  let recoveryCandidatesVisited = 0;
  let movedShipsScanned = 0;
  const finish = () => {
    bump(room, "movementContactRecoveryQueries", recoveryQueries);
    bump(room, "movementContactRecoveryCandidatesVisited", recoveryCandidatesVisited);
    bump(room, "movementContactMovedShipsScanned", movedShipsScanned);
    recordDuration(room, "movementContactRecoveryScanMs", scanStart);
    return { missingCount: missing.length, pairs: missing };
  };

  const live = liveShipsForStep(room, null, state);
  if (live.length < 2 || !movedShips?.length) return finish();
  let maximumRadius = 0;
  for (const ship of live) maximumRadius = Math.max(maximumRadius, physicalCollisionRadius(ship));

  const index = room?.spatialIndex;
  for (const moved of movedShips) {
    if (!isLiveShip(room, moved)) continue;
    movedShipsScanned += 1;
    const queryRadius = physicalCollisionRadius(moved) + maximumRadius + SEPARATION_SLOP;
    const usesSpatialQuery = Boolean(index?.queryRangeUnordered);
    if (usesSpatialQuery) recoveryQueries += 1;
    const candidates = usesSpatialQuery
      ? index.queryRangeUnordered("ships", finite(moved.x), finite(moved.y), queryRadius, queryScratch)
      : live;
    recoveryCandidatesVisited += candidates.length;
    if (candidates.length > 1 && candidates !== live) candidates.sort(compareShips);
    for (const candidate of candidates) {
      if (!isLiveShip(room, candidate) || candidate === moved) continue;
      if (hasMovementContactPair(room, moved, candidate)) continue;
      const key = movementContactPairEntityKey(moved, candidate);
      if (missingKeys.has(key) || !shipsActuallyOverlap(moved, candidate, options)) continue;
      missingKeys.add(key);
      const first = compareEntityIds(moved, candidate) <= 0 ? moved : candidate;
      const second = first === moved ? candidate : moved;
      missing.push({
        a: first,
        b: second,
        aId: first.id,
        bId: second.id
      });
    }
  }
  return finish();
}

function removeShipFromMovementContactPairs(room, ship) {
  const state = ensureState(room);
  if (!state || !ship) return 0;
  let write = 0;
  let removed = 0;
  for (const pair of state._movementContactPairs) {
    if (pair.a === ship || pair.b === ship) {
      pair.a = null;
      pair.b = null;
      pair.aId = null;
      pair.bId = null;
      pair.orderA = 0;
      pair.orderB = 0;
      removed += 1;
      continue;
    }
    state._movementContactPairs[write++] = pair;
  }
  state._movementContactPairs.length = write;
  if (removed) {
    state._movementContactPairs.sort(pairSort);
    state._movementContactPairKeys.clear();
    for (const pair of state._movementContactPairs) state._movementContactPairKeys.add(pairKey(pair.orderA, pair.orderB));
  }
  state._movementContactPairRankByShip.delete(ship);
  if (removed) state._movementContactPairPoolNeedsHoleSearch = true;
  return removed;
}

function noteShipSpawnedDuringMovementContactStep(room, ship) {
  const state = ensureState(room);
  if (!state || !ship || state._movementContactPairBuildStepId === null) return;
  state._movementContactPairUnsafe = true;
  state._movementContactPairNeedsRecovery = true;
  room._movementContactPairInvalidationReason = "ship-spawned-after-build";
}

function markMovementContactPairsUnsafe(room, reason = "unknown") {
  const state = ensureState(room);
  if (!state) return;
  state._movementContactPairUnsafe = true;
  state._movementContactPairNeedsRecovery = true;
  room._movementContactPairInvalidationReason = reason;
}

function hasPairForRanks(state, orderA, orderB) {
  const low = Math.min(orderA, orderB);
  const high = Math.max(orderA, orderB);
  return state._movementContactPairKeys.has(pairKey(low, high));
}

function validateMovementContactPairs(room, ships, options = {}) {
  const state = ensureState(room);
  const pairs = state?._movementContactPairs || [];
  const live = liveShipsForStep(room, ships, state || ensureState(room));
  const rank = new Map(live.map((ship, index) => [ship, index]));
  const issues = [];
  const seen = new Set();
  const pairLookup = new Set();
  for (const pair of pairs) {
    if (!pair?.a || !pair?.b) {
      issues.push("empty-pair-reference");
      continue;
    }
    if (pair.a === pair.b) issues.push(`self-pair:${pair.aId}`);
    if (!isLiveShip(room, pair.a) || !isLiveShip(room, pair.b)) issues.push(`dead-pair:${pair.aId}:${pair.bId}`);
    const aRank = rank.get(pair.a);
    const bRank = rank.get(pair.b);
    if (aRank === undefined || bRank === undefined) issues.push(`pair-outside-live-set:${pair.aId}:${pair.bId}`);
    if (aRank !== undefined && bRank !== undefined && aRank >= bRank) issues.push(`non-canonical:${pair.aId}:${pair.bId}`);
    const key = aRank === undefined || bRank === undefined ? `${pair.aId}:${pair.bId}` : pairKey(Math.min(aRank, bRank), Math.max(aRank, bRank));
    if (seen.has(key)) issues.push(`duplicate:${key}`);
    seen.add(key);
    pairLookup.add(key);
    if (pair.aId !== pair.a.id || pair.bId !== pair.b.id) issues.push(`stale-id:${pair.aId}:${pair.bId}`);
  }

  let actualOverlaps = 0;
  let missingOverlaps = 0;
  const { findShipHullOverlap } = require("./componentGeometry");
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const a = live[i];
      const b = live[j];
      const dx = finite(b.x) - finite(a.x);
      const dy = finite(b.y) - finite(a.y);
      const minimum = physicalCollisionRadius(a) + physicalCollisionRadius(b);
      if (dx * dx + dy * dy >= minimum * minimum) continue;
      const overlap = findShipHullOverlap(a, b);
      if (!overlap) continue;
      actualOverlaps += 1;
      const key = pairKey(i, j);
      if (!pairLookup.has(key)) {
        missingOverlaps += 1;
        issues.push(`missing-overlap:${a.id}:${b.id}`);
      }
    }
  }
  if (state?._movementContactPairBuildStepId !== null && options.stepId !== undefined
    && state._movementContactPairBuildStepId !== options.stepId) {
    issues.push("previous-step-pair-reference");
  }
  return {
    ok: issues.length === 0,
    issues,
    actualOverlaps,
    missingOverlaps,
    pairCount: pairs.length,
    liveShipCount: live.length,
    candidatesPadding: state?._movementContactPairPadding || null
  };
}

function shouldRunMovementContactDiagnostics(room) {
  return Boolean(
    room?._movementContactPairDiagnostics
      || process.env.MFA_MOVEMENT_CONTACT_DIAGNOSTICS === "1"
  );
}

module.exports = {
  beginMovementContactStep,
  buildMovementContactPairs,
  clearMovementContactPairs,
  collectMovementContactMovedShips,
  findMissingMovementContactPairs,
  getMovementContactPairs,
  hasMovementContactPair,
  markMovementContactPairsUnsafe,
  noteShipSpawnedDuringMovementContactStep,
  rebuildMovementContactPairsForRecovery,
  removeShipFromMovementContactPairs,
  shouldRunMovementContactDiagnostics,
  validateMovementContactPairs
};
