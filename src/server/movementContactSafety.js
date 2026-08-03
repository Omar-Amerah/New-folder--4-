"use strict";

// The post-solver movement safety boundary is shared by tickRoom() and the
// Phase 4CD production-path benchmark. Keeping it here prevents the benchmark
// from silently stopping before the moved-ship scan and scoped recovery solve.

const { getLiveShips } = require("./ships");
const {
  updateShipSeparation,
  resolveFleetMapCollisions,
  resolveMapCollision
} = require("./movement");
const { shipBroadPhaseRadius } = require("./spatialIndex");
const {
  circularShipSeparation,
  redundantFleetMapCollisionPass
} = require("./performanceFlags");
const {
  collectMovementContactMovedShips,
  findMissingMovementContactPairs,
  markMovementContactPairsUnsafe,
  rebuildMovementContactPairsForRecovery
} = require("./movementContactPairs");
const { bump } = require("./roomTelemetry");
const { performanceNow } = require("./utils");

function runMovementContactSafetyPass(room, ships, modifiedShipIds, dt, now = 0, options = {}) {
  const circular = options.circular === undefined
    ? circularShipSeparation()
    : Boolean(options.circular);
  const activeShips = Array.isArray(ships)
    ? ships
    : getLiveShips(room, room._liveShipScratch || (room._liveShipScratch = []));
  let activeModifiedShipIds = Array.isArray(modifiedShipIds) ? modifiedShipIds : [];
  let spatialPublicationMs = 0;

  const applyFinalMapCorrection = (currentShips, currentModifiedShipIds) => {
    if (redundantFleetMapCollisionPass()) {
      bump(
        room,
        "separationMapCollisionCalls",
        Array.from(room?.ships?.values?.() || []).filter((ship) => ship?.alive).length
      );
      resolveFleetMapCollisions(room, currentShips);
    } else {
      for (const id of currentModifiedShipIds || []) {
        const ship = room?.ships?.get?.(id);
        if (ship) {
          bump(room, "separationMapCollisionCalls");
          resolveMapCollision(room, ship);
        }
      }
    }
  };

  const publishShipSpatial = (currentShips) => {
    const startedAt = options.measureSpatialPublication ? performanceNow() : 0;
    if (room.spatialIndex && typeof room.spatialIndex.updateLiveEntities === "function") {
      room.spatialIndex.updateLiveEntities("ships", currentShips, shipBroadPhaseRadius);
    }
    if (options.measureSpatialPublication) spatialPublicationMs += performanceNow() - startedAt;
  };

  applyFinalMapCorrection(activeShips, activeModifiedShipIds);
  const movedShips = collectMovementContactMovedShips(room, activeShips, activeModifiedShipIds);
  publishShipSpatial(activeShips);

  let missingCount = 0;
  let recoveredMissingCount = 0;
  if (movedShips.length > 0) {
    const missing = findMissingMovementContactPairs(room, movedShips, { circular });
    missingCount = missing.missingCount;
    if (missing.missingCount > 0) {
      bumpMisses(room, missing.missingCount, "post-solver-missing-edge", missing.pairs);
      // One bounded exceptional rebuild per authoritative step. It is outside
      // the packed iterations and uses the current live roster, so a launch or
      // a newly created edge cannot remain absent from the recovery graph.
      if (!room._movementContactPairRecoveryAttempted) {
        const recoveryShips = getLiveShips(room, room._liveShipScratch || (room._liveShipScratch = []));
        rebuildMovementContactPairsForRecovery(room, recoveryShips, now, {
          scopeShips: movedShips,
          recoveryPairs: missing.pairs
        });
        activeModifiedShipIds = updateShipSeparation(room, recoveryShips, dt, now);
        applyFinalMapCorrection(recoveryShips, activeModifiedShipIds);
        const recoveryMovedShips = collectMovementContactMovedShips(room, recoveryShips, activeModifiedShipIds);
        publishShipSpatial(recoveryShips);
        const recoveredMissing = findMissingMovementContactPairs(room, recoveryMovedShips, { circular });
        recoveredMissingCount = recoveredMissing.missingCount;
        if (recoveredMissing.missingCount > 0) {
          bumpMisses(room, recoveredMissing.missingCount, "post-recovery-missing-edge", recoveredMissing.pairs);
        }
      }
    }
  }

  return {
    modifiedShipIds: activeModifiedShipIds,
    movedShips,
    missingCount,
    recoveredMissingCount,
    spatialPublicationMs
  };
}

function bumpMisses(room, count, reason, pairs) {
  bump(room, "movementContactPairMissDetections", count);
  markMovementContactPairsUnsafe(room, reason);
  room._movementContactPairLastMisses = (pairs || []).map((pair) => `${pair.aId}:${pair.bId}`);
}

module.exports = { runMovementContactSafetyPass };
