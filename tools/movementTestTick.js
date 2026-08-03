"use strict";

// Focused movement verifiers use the same authoritative boundary as
// simulation.js. Keeping this in one helper prevents tests from drifting away
// from the authoritative movement/contact runtime.

const {
  beginMovementContactStep,
  buildMovementContactPairs
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
  const stepId = beginMovementContactStep(room, live, now);

  buildRoomSpatialIndex(room, live, now);
  for (const ship of live) updateShipMovement(room, ship, dt, now);

  if (room.spatialIndex && typeof room.spatialIndex.updateLiveEntities === "function") {
    room.spatialIndex.updateLiveEntities("ships", live, shipBroadPhaseRadius);
  } else {
    buildRoomSpatialIndex(room, live, now);
  }

  buildMovementContactPairs(room, live, now, { stepId });
  const modifiedShipIds = updateShipSeparation(room, live, dt, now);
  return runMovementContactSafetyPass(room, live, modifiedShipIds, dt, now);
}

module.exports = { movementTestTick };
