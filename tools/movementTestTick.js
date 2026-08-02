"use strict";

// Focused movement verifiers use the same authoritative boundary as
// simulation.js. Keeping this in one helper prevents optimized spatial/contact
// flags from silently turning a test into a different runtime.

const {
  INCREMENTAL_SPATIAL_INDEX,
  SHARED_MOVEMENT_CONTACT_PAIRS
} = require("../src/server/performanceFlags");
const {
  beginMovementContactStep,
  buildMovementContactPairs,
  clearMovementContactPairs
} = require("../src/server/movementContactPairs");
const { runMovementContactSafetyPass } = require("../src/server/movementContactSafety");
const {
  buildRoomSpatialIndex,
  shipBroadPhaseRadius
} = require("../src/server/spatialIndex");
const {
  updateShipMovement,
  updateShipSeparation
} = require("../src/server/movement");

function movementTestTick(room, ships, dt, now) {
  const live = (ships || []).filter((ship) => ship?.alive !== false);
  const shared = SHARED_MOVEMENT_CONTACT_PAIRS();
  const stepId = shared
    ? beginMovementContactStep(room, live, now)
    : (clearMovementContactPairs(room), null);

  buildRoomSpatialIndex(room, live, now);
  for (const ship of live) updateShipMovement(room, ship, dt, now);

  if (room.spatialIndex && typeof room.spatialIndex.updateLiveEntities === "function") {
    if (INCREMENTAL_SPATIAL_INDEX()) {
      room.spatialIndex.updateLiveEntities("ships", live, shipBroadPhaseRadius);
    } else {
      room.spatialIndex.rebuildKind("ships", live, shipBroadPhaseRadius, now);
    }
  } else {
    buildRoomSpatialIndex(room, live, now);
  }

  if (shared) buildMovementContactPairs(room, live, now, { stepId });
  const modifiedShipIds = updateShipSeparation(room, live, dt, now);
  return runMovementContactSafetyPass(room, live, modifiedShipIds, dt, now, {
    sharedMovementContactPairs: shared
  });
}

module.exports = { movementTestTick };
