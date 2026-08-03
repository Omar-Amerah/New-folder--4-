"use strict";

// Phase 4D packed-fleet solver. This file consumes the Phase 4C pair array and
// never asks the spatial index for ship candidates. Static collision correction
// remains at the simulation boundary around this solver.

const {
  clampNumber,
  compareNaturalIds,
  compareEntityIds,
  fastHypot,
  performanceNow
} = require("./utils");
const { WORLD } = require("./config");
const { bump, setCounter, recordDuration } = require("./roomTelemetry");
const {
  SEPARATION_BROAD_PHASE_PAD,
  SEPARATION_CORRECTION,
  SEPARATION_ITERATIONS,
  SEPARATION_SLOP,
  STOPPED_SPEED,
  WORLD_MARGIN
} = require("./movementTuning");
const { findShipHullOverlap } = require("./componentGeometry");
const {
  cancelYieldingInwardMovement,
  friendlyChargePair,
  friendlyShipPair,
  friendlyTrafficSoftContact,
  friendlySoftCorrection,
  physicalCollisionRadius,
  recordShipContact,
  resolveSeparationPair
} = require("./movementCollision");
const { trafficIsPositioned, trafficPriorityWinner } = require("./movementTrafficPriority");
const {
  getMovementContactPairs,
  markMovementContactPairsUnsafe
} = require("./movementContactPairs");

const MAX_PACKED_CORRECTION = SEPARATION_BROAD_PHASE_PAD;
// The legacy solver already subtracts SEPARATION_SLOP from every correction.
// The small extra comparison tolerance prevents a final floating-point residue
// from consuming the entire bounded iteration budget for a touching pair.
const PACKED_CONVERGENCE_TOLERANCE = SEPARATION_SLOP + 0.1;
const PACKED_FINAL_RECOVERY_MIN_PENETRATION = 8;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function collisionCounters(room) {
  return room.spawnCollisionDiagnostics || (room.spawnCollisionDiagnostics = {});
}

function collisionBump(room, key, amount = 1) {
  const counters = collisionCounters(room);
  counters[key] = (counters[key] || 0) + amount;
}

function shipIsStopped(ship) {
  const phase = ship.movement?.phase;
  return fastHypot(ship.vx || 0, ship.vy || 0) < STOPPED_SPEED
    && (!ship.movement?.command
      || ship.movement.command.type === "stop"
      || phase === "positioned"
      || phase === "idle");
}

function liveShip(room, ship) {
  return Boolean(
    ship
      && ship.alive === true
      && ship.removed !== true
      && (!room?.ships || room.ships.get(ship.id) === ship)
  );
}

function pairSort(a, b) {
  return (Number(a?.orderA) || 0) - (Number(b?.orderA) || 0)
    || (Number(a?.orderB) || 0) - (Number(b?.orderB) || 0);
}

function correctionLimit(ship) {
  // A batch can collect several contacts. Limit the total displacement to a
  // deterministic, radius-scaled bound, capped by the existing broad-phase
  // safety budget. A single equal-radius deep overlap remains fully resolved;
  // only pathological many-neighbour sums are clipped.
  return Math.min(
    MAX_PACKED_CORRECTION,
    Math.max(64, physicalCollisionRadius(ship) * 3)
  );
}

function clampShipPosition(room, ship, x, y) {
  const width = finite(room?.world?.width, WORLD.width);
  const height = finite(room?.world?.height, WORLD.height);
  const edge = WORLD_MARGIN + physicalCollisionRadius(ship);
  const minX = Math.min(edge, width * 0.5);
  const maxX = Math.max(minX, width - edge);
  const minY = Math.min(edge, height * 0.5);
  const maxY = Math.max(minY, height - edge);
  return {
    x: clampNumber(x, minX, maxX),
    y: clampNumber(y, minY, maxY)
  };
}

function overlapForPair(a, b, options) {
  const broadDx = finite(b.x) - finite(a.x);
  const broadDy = finite(b.y) - finite(a.y);
  const minimum = physicalCollisionRadius(a) + physicalCollisionRadius(b);
  if (broadDx * broadDx + broadDy * broadDy >= minimum * minimum) return null;
  const overlap = options?.circular
    ? (() => {
      const distance = fastHypot(broadDx, broadDy);
      return { dx: broadDx, dy: broadDy, distance, penetration: minimum - distance };
    })()
    : findShipHullOverlap(a, b);
  if (!overlap || !Number.isFinite(overlap.penetration) || overlap.penetration <= 0) return null;
  return { overlap, broadDx, broadDy };
}

function normalForOverlap(a, b, overlap, broadDx, broadDy) {
  if (overlap.distance > 0.001) {
    return { x: overlap.dx / overlap.distance, y: overlap.dy / overlap.distance };
  }
  const broadDistance = fastHypot(broadDx, broadDy);
  if (broadDistance > 0.001) {
    return { x: broadDx / broadDistance, y: broadDy / broadDistance };
  }
  // Pair order is canonical, so this fallback is deterministic even when ids
  // are not the usual s<number> shape.
  return compareNaturalIds(a.id, b.id) <= 0 ? { x: 1, y: 0 } : { x: -1, y: 0 };
}

function releaseScratchArrays(room) {
  const state = room._packedFleetSolverState || (room._packedFleetSolverState = {
    ranks: new Map(),
    parent: [],
    size: [],
    islands: [],
    islandPool: [],
    islandPairs: [],
    islandPairPool: [],
    rootToIsland: new Map(),
    connectedRanks: [],
    unresolved: [],
    resolvedShips: new Set()
  });
  for (const island of state.islands) {
    island.length = 0;
    state.islandPool.push(island);
  }
  state.islands.length = 0;
  for (const pairs of state.islandPairs) {
    pairs.length = 0;
    state.islandPairPool.push(pairs);
  }
  state.islandPairs.length = 0;
  state.unresolved.length = 0;
  state.resolvedShips.clear();
  state.rootToIsland.clear();
  state.connectedRanks.length = 0;
  return state;
}

function findRoot(parent, value) {
  let root = value;
  while (parent[root] !== root) root = parent[root];
  while (parent[value] !== value) {
    const next = parent[value];
    parent[value] = root;
    value = next;
  }
  return root;
}

function union(parent, size, left, right) {
  let a = findRoot(parent, left);
  let b = findRoot(parent, right);
  if (a === b) return a;
  if (size[a] < size[b] || (size[a] === size[b] && a > b)) {
    const swap = a;
    a = b;
    b = swap;
  }
  parent[b] = a;
  size[a] += size[b];
  return a;
}

function buildContactIslands(room, ships, pairs) {
  const state = releaseScratchArrays(room);
  state.ranks.clear();
  state.parent.length = ships.length;
  state.size.length = ships.length;
  state.connectedRanks.length = ships.length;
  state.connectedRanks.fill(0);
  for (let i = 0; i < ships.length; i += 1) {
    state.ranks.set(ships[i], i);
    state.parent[i] = i;
    state.size[i] = 1;
  }

  const validPairs = [];
  for (const pair of pairs) {
    const aRank = state.ranks.get(pair?.a);
    const bRank = state.ranks.get(pair?.b);
    if (aRank === undefined || bRank === undefined || aRank === bRank) continue;
    validPairs.push(pair);
    state.connectedRanks[aRank] = 1;
    state.connectedRanks[bRank] = 1;
    union(state.parent, state.size, aRank, bRank);
  }

  // Ships are already authoritative-order sorted. Creating islands only for
  // connected candidate components makes isolated ships cheap while keeping
  // island ordering independent of pair/bucket insertion history.
  for (let i = 0; i < ships.length; i += 1) {
    if (!state.connectedRanks[i]) continue;
    const root = findRoot(state.parent, i);
    let islandIndex = state.rootToIsland.get(root);
    if (islandIndex === undefined) {
      islandIndex = state.islands.length;
      state.rootToIsland.set(root, islandIndex);
      const island = state.islandPool.pop() || [];
      island.length = 0;
      state.islands.push(island);
      const islandPairs = state.islandPairPool.pop() || [];
      islandPairs.length = 0;
      state.islandPairs.push(islandPairs);
    }
    state.islands[islandIndex].push(ships[i]);
  }
  for (const pair of validPairs) {
    const root = findRoot(state.parent, state.ranks.get(pair.a));
    const islandIndex = state.rootToIsland.get(root);
    if (islandIndex !== undefined) state.islandPairs[islandIndex].push(pair);
  }
  return { state, validPairs };
}

function recordContact(room, a, b, now, penetration) {
  collisionBump(room, "shipCollisionPairs");
  collisionBump(room, "shipCollisionPenetrationCorrected", Math.max(0, penetration));
  const tick = Number(a._simNow || b._simNow || now) || 0;
  const contact = recordShipContact(room, a, b, tick);
  const stationary = [a, b].find((ship) =>
    shipIsStopped(ship)
    && fastHypot(ship._integratedMovementX || 0, ship._integratedMovementY || 0) < 0.5
  );
  if (stationary
    && contact.consecutive === 12
    && fastHypot(stationary._collisionCorrectionX || 0, stationary._collisionCorrectionY || 0) > 2) {
    collisionBump(room, "towingRegressionDetections");
  }
  return contact;
}

function applyBatchCorrections(room, ships, state) {
  let applications = 0;
  for (const ship of ships) {
    const correctionX = finite(ship._packedCorrectionX);
    const correctionY = finite(ship._packedCorrectionY);
    const magnitude = fastHypot(correctionX, correctionY);
    const limit = correctionLimit(ship);
    const scale = magnitude > limit && magnitude > 0 ? limit / magnitude : 1;
    const oldX = finite(ship.x);
    const oldY = finite(ship.y);
    const next = clampShipPosition(
      room,
      ship,
      oldX + correctionX * scale,
      oldY + correctionY * scale
    );
    ship.x = next.x;
    ship.y = next.y;
    const appliedX = ship.x - oldX;
    const appliedY = ship.y - oldY;
    ship._collisionCorrectionX = (ship._collisionCorrectionX || 0) + appliedX;
    ship._collisionCorrectionY = (ship._collisionCorrectionY || 0) + appliedY;
    if (fastHypot(appliedX, appliedY) > 0.000001) applications += 1;

    ship._packedCorrectionX = 0;
    ship._packedCorrectionY = 0;
  }
  return applications;
}

function scanRemainingOverlaps(room, islandPairs, options, pairsChecked) {
  let remaining = 0;
  let maximum = 0;
  for (const pairs of islandPairs) {
    for (const pair of pairs) {
      const a = pair?.a;
      const b = pair?.b;
      if (!liveShip(room, a) || !liveShip(room, b) || a === b) continue;
      pairsChecked.value += 1;
      const result = overlapForPair(a, b, options);
      if (!result) {
        pair._packedLastPenetration = 0;
        continue;
      }
      const penetration = result.overlap.penetration;
      maximum = Math.max(maximum, penetration);
      if (penetration > PACKED_CONVERGENCE_TOLERANCE) {
        remaining += 1;
        pair._packedLastPenetration = penetration;
      } else {
        pair._packedLastPenetration = 0;
      }
    }
  }
  return { remaining, maximum };
}

function recoverNewcomers(room, state, now) {
  if (!state.unresolved.length) return 0;
  const { findClearShipSpawnPoint } = require("./spawnPlanner");
  let operations = 0;
  state.resolvedShips.clear();
  for (const pair of state.unresolved) {
    const a = pair?.a;
    const b = pair?.b;
    if (!liveShip(room, a) || !liveShip(room, b)) continue;
    const penetration = finite(pair._packedLastPenetration);
    if (penetration < 2) continue;
    const newcomer = a.spawnState && now < a.spawnState.expiresAt
      ? a
      : (b.spawnState && now < b.spawnState.expiresAt ? b : null);
    if (!newcomer || state.resolvedShips.has(newcomer)) continue;
    const recovery = findClearShipSpawnPoint(room, {
      preferredX: newcomer.spawnState.launchPoint.x,
      preferredY: newcomer.spawnState.launchPoint.y,
      physicalRadius: physicalCollisionRadius(newcomer),
      ownerId: newcomer.ownerId,
      requestId: `recovery:${newcomer.id}`,
      shipIndex: 0,
      ignoredShips: new Set([newcomer])
    });
    if (!recovery.ok) continue;
    newcomer.x = recovery.x;
    newcomer.y = recovery.y;
    newcomer.vx = 0;
    newcomer.vy = 0;
    state.resolvedShips.add(newcomer);
    operations += 1;
  }
  if (operations) markMovementContactPairsUnsafe(room, "packed-newcomer-recovery");
  return operations;
}

function solvePackedFleetSeparation(room, shipList, dt, now = 0, options = null, stepId = null) {
  const start = performanceNow();
  const ships = (Array.isArray(shipList) ? shipList : [...(room?.ships?.values?.() || [])])
    .filter((ship) => liveShip(room, ship))
    .slice()
    .sort(compareEntityIds);
  const pairs = getMovementContactPairs(room, stepId);
  pairs.sort(pairSort);
  const { state, validPairs } = buildContactIslands(room, ships, pairs);
  bump(room, "packedFleetIslands", state.islands.length);
  const largestIsland = state.islands.reduce((largest, island) => Math.max(largest, island.length), 0);
  setCounter(
    room,
    "packedFleetLargestIsland",
    Math.max(Number(room._roomTelemetry?.packedFleetLargestIsland) || 0, largestIsland)
  );
  bump(room, "packedFleetSolverSteps");
  let iterations = 0;
  let earlyExit = false;
  let pairsChecked = 0;
  let overlapsResolved = 0;
  let maximumPenetration = 0;
  let correctionApplications = 0;
  let remaining = 0;
  const checked = { value: 0 };

  for (; iterations < SEPARATION_ITERATIONS; iterations += 1) {
    bump(room, "separationIterations");
    bump(room, "movementLegacySeparationQueriesAvoided", ships.length);
    bump(room, "separationCandidatesReturned", validPairs.length);
    let meaningfulOverlaps = 0;
    state.unresolved.length = 0;
    const narrowStart = performanceNow();
    for (const islandPairs of state.islandPairs) {
      for (const pair of islandPairs) {
        const a = pair?.a;
        const b = pair?.b;
        if (!liveShip(room, a) || !liveShip(room, b) || a === b) continue;
        if (a.launchPhase && b.launchPhase) continue;
        pairsChecked += 1;
        bump(room, "separationPairsExamined");
        const result = overlapForPair(a, b, options);
        if (!result) {
          bump(room, "separationBroadPhaseRejected");
          continue;
        }
        bump(room, "separationNarrowPhaseChecks");
        const penetration = result.overlap.penetration;
        maximumPenetration = Math.max(maximumPenetration, penetration);
        pair._packedLastPenetration = penetration;
        if (penetration <= PACKED_CONVERGENCE_TOLERANCE) continue;
        meaningfulOverlaps += 1;
        overlapsResolved += 1;
        bump(room, "separationOverlapsResolved");
        const contact = recordContact(room, a, b, now, Math.max(0, penetration - SEPARATION_SLOP));

        const normal = normalForOverlap(a, b, result.overlap, result.broadDx, result.broadDy);
        const correctedPenetration = Math.max(0, penetration - SEPARATION_SLOP);
        const friendly = friendlyShipPair(room, a, b);
        const softFriendlyContact = friendly && !friendlyChargePair(a, b)
          && (contact.duration >= 1500 || friendlyTrafficSoftContact(room, a, b, now));
        const sidestepContact = friendly && contact.duration >= 400;
        const winnerId = trafficPriorityWinner(
          room,
          a,
          b,
          now,
          physicalCollisionRadius(a) + physicalCollisionRadius(b) + 96
        );
        const yielding = trafficIsPositioned(a) !== trafficIsPositioned(b)
          ? (trafficIsPositioned(a) ? b : a)
          : (winnerId === a.id ? a : b);
        const normalTowardWinner = yielding === a
          ? normal
          : { x: -normal.x, y: -normal.y };
        let correction = correctedPenetration
          * SEPARATION_CORRECTION
          * (sidestepContact ? 0.8 : 1);
        if (softFriendlyContact) {
          correction = friendlySoftCorrection(
            yielding,
            correction,
            penetration,
            physicalCollisionRadius(a) + physicalCollisionRadius(b),
            normalTowardWinner,
            dt
          );
        }
        const moveA = yielding === a ? correction : 0;
        const moveB = yielding === b ? correction : 0;
        a._packedCorrectionX = finite(a._packedCorrectionX) - normal.x * moveA;
        a._packedCorrectionY = finite(a._packedCorrectionY) - normal.y * moveA;
        b._packedCorrectionX = finite(b._packedCorrectionX) + normal.x * moveB;
        b._packedCorrectionY = finite(b._packedCorrectionY) + normal.y * moveB;

        if (!softFriendlyContact) {
          cancelYieldingInwardMovement(
            yielding,
            yielding === a ? normal : { x: -normal.x, y: -normal.y }
          );
        } else {
          collisionBump(room, "friendlySoftContactCount");
        }
        if (penetration > SEPARATION_SLOP) state.unresolved.push(pair);
      }
    }
    recordDuration(room, "separationNarrowPhaseMs", narrowStart);
    if (meaningfulOverlaps === 0) {
      earlyExit = true;
      break;
    }
    correctionApplications += applyBatchCorrections(room, ships, state);
  }

  // If the last iteration applied corrections, perform one final narrow-phase
  // scan over the same pair islands to report convergence accurately. This is
  // not a broad-phase build and does not consult the spatial index.
  const finalScan = scanRemainingOverlaps(room, state.islandPairs, options, checked);
  pairsChecked += checked.value;
  remaining = finalScan.remaining;
  maximumPenetration = Math.max(maximumPenetration, finalScan.maximum);
  state.unresolved.length = 0;
  for (const islandPairs of state.islandPairs) {
    for (const pair of islandPairs) {
      if (finite(pair?._packedLastPenetration) > PACKED_CONVERGENCE_TOLERANCE) state.unresolved.push(pair);
    }
  }

  // A batched island correction can move one hull deeply into a neighbouring
  // pair after that pair's own narrow phase has already run. The pair is still
  // in the island, so recover only these material residuals with the same
  // deterministic yielding rule. Small residuals remain in the existing soft
  // contact allowance instead of making a packed formation churn.
  if (remaining > 0) {
    let corrections = 0;
    for (const pair of state.unresolved) {
      if (finite(pair?._packedLastPenetration) < PACKED_FINAL_RECOVERY_MIN_PENETRATION) continue;
      const a = pair?.a;
      const b = pair?.b;
      if (!liveShip(room, a) || !liveShip(room, b) || a === b) continue;
      const contactKey = [String(a.id), String(b.id)].sort().join("|");
      const softFriendly = friendlyShipPair(room, a, b)
        && Number(room._shipCollisionContacts?.get(contactKey)?.duration) >= 1500;
      if (softFriendly) continue;
      if (resolveSeparationPair(room, a, b, { ...(options || {}), correction: 1 })) corrections += 1;
    }
    if (corrections > 0) {
      correctionApplications += corrections;
      const settled = scanRemainingOverlaps(room, state.islandPairs, options, checked);
      remaining = settled.remaining;
      maximumPenetration = Math.max(maximumPenetration, settled.maximum);
      state.unresolved.length = 0;
      for (const islandPairs of state.islandPairs) {
        for (const pair of islandPairs) {
          if (finite(pair?._packedLastPenetration) > PACKED_CONVERGENCE_TOLERANCE) state.unresolved.push(pair);
        }
      }
      bump(room, "packedFleetFinalRecoveryOperations", corrections);
    }
  }

  const recoveryOperations = recoverNewcomers(room, state, now);
  if (recoveryOperations) {
    const recoveredChecked = { value: 0 };
    const recoveredScan = scanRemainingOverlaps(room, state.islandPairs, options, recoveredChecked);
    pairsChecked += recoveredChecked.value;
    remaining = recoveredScan.remaining;
    maximumPenetration = Math.max(maximumPenetration, recoveredScan.maximum);
  }

  if (remaining > 0) {
    collisionBump(room, "shipCollisionUnresolvedPairs", remaining);
  }
  bump(room, "separationUnresolvedPairs", remaining);
  if (earlyExit) bump(room, "packedFleetEarlyExits");
  bump(room, "packedFleetIterations", iterations + (earlyExit ? 1 : 0));
  bump(room, "packedFleetPairsChecked", pairsChecked);
  bump(room, "packedFleetOverlapsResolved", overlapsResolved);
  setCounter(room, "packedFleetRemainingOverlaps", remaining);
  setCounter(
    room,
    "packedFleetMaximumPenetration",
    Math.max(Number(room._roomTelemetry?.packedFleetMaximumPenetration) || 0, maximumPenetration)
  );
  bump(room, "packedFleetCorrectionApplications", correctionApplications);
  bump(
    room,
    "packedFleetRecoveryOperations",
    (Number(room._movementContactPairRecoveryOperations) || 0) + recoveryOperations
  );
  bump(room, "packedFleetLegacyIterationsAvoided", Math.max(0, SEPARATION_ITERATIONS - (iterations + (earlyExit ? 1 : 0))));
  recordDuration(room, "shipSeparationMs", start);
  recordDuration(room, "packedFleetSolverMs", start);

  const modified = room._shipSeparationModified || (room._shipSeparationModified = new Set());
  modified.clear();
  for (const ship of ships) {
    if (fastHypot(ship._collisionCorrectionX || 0, ship._collisionCorrectionY || 0) > 0.000001) modified.add(ship.id);
  }
  return Array.from(modified);
}

module.exports = { solvePackedFleetSeparation };
