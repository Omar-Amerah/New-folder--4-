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

const MIN_CONTACT_PADDING = 8;
const CONTACT_STATIC_CORRECTION_SCALE = 0.5;

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
  state._movementContactPairBuildStepId = null;
  state._movementContactPairStepId = null;
  state._movementContactPairUnsafe = false;
  state._movementContactPairPadding = null;
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
  let pair = state._movementContactPairPool[state._movementContactPairs.length];
  if (!pair) {
    pair = makePair();
    state._movementContactPairPool.push(pair);
  }
  pair.a = a;
  pair.b = b;
  pair.aId = a.id;
  pair.bId = b.id;
  pair.orderA = indexA;
  pair.orderB = indexB;
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
    state._movementContactPairBuildStepId = stepId;
    if (!options.recovery) state._movementContactPairStepId = stepId;
    return state._movementContactPairs;
  }

  // A recovery build is intentionally exceptional. It is deterministic and
  // scoped to this room/step, but it may fall back to all live pairs so a stale
  // spatial record cannot hide the overlap that caused recovery.
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
  for (let index = 0; index < ordered.length; index += 1) {
    state._movementContactPairRankByShip.set(ordered[index], index);
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
  const forceAllPairs = Boolean(options.forceAllPairs || options.recovery);
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
  recordDuration(room, "movementContactPairBuildMs", buildStart);
  return state._movementContactPairs;
}

function rebuildMovementContactPairsForRecovery(room, ships, now = 0) {
  const state = ensureState(room);
  if (!state) return [];
  let stepId = state._movementContactPairStepId;
  if (stepId === null || stepId === undefined) {
    stepId = beginMovementContactStep(room, ships, now);
  }
  return buildMovementContactPairs(room, ships, now, {
    stepId,
    recovery: true,
    forceAllPairs: true
  });
}

function getMovementContactPairs(room, stepId = null) {
  const state = ensureState(room);
  if (!state) return [];
  if (stepId !== null && state._movementContactPairBuildStepId !== stepId) return [];
  return state._movementContactPairs;
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
  getMovementContactPairs,
  markMovementContactPairsUnsafe,
  noteShipSpawnedDuringMovementContactStep,
  rebuildMovementContactPairsForRecovery,
  removeShipFromMovementContactPairs,
  shouldRunMovementContactDiagnostics,
  validateMovementContactPairs
};
