"use strict";

// Final movement boundary: only ships moved by friendly separation are
// rechecked against static geometry. This is validation of the correction, not
// a second recovery or traffic solver.

const { getLiveShips } = require("./ships");
const { resolveMapCollision } = require("./movement");
const { shipBroadPhaseRadius } = require("./spatialIndex");
const { bump } = require("./roomTelemetry");

function runMovementContactSafetyPass(room, ships, modifiedShipIds) {
  const activeShips = Array.isArray(ships)
    ? ships
    : getLiveShips(room, room._liveShipScratch || (room._liveShipScratch = []));
  const modified = [];
  for (const id of modifiedShipIds || []) {
    const ship = room?.ships?.get?.(id);
    if (!ship || ship.alive === false || ship.removed === true) continue;
    bump(room, "separationMapCollisionCalls");
    resolveMapCollision(room, ship);
    modified.push(id);
  }
  if (room.spatialIndex && typeof room.spatialIndex.updateLiveEntities === "function") {
    room.spatialIndex.updateLiveEntities("ships", activeShips, shipBroadPhaseRadius);
  }
  return {
    modifiedShipIds: modified,
    movedShips: modified,
    missingCount: 0,
    recoveredMissingCount: 0,
    spatialPublicationMs: 0
  };
}

module.exports = { runMovementContactSafetyPass };
