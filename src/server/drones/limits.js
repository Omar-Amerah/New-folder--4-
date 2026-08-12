"use strict";

const DroneDecisionContext = require("../droneDecisionContext");

// room.droneCounts is the sole active-count authority. It is rebuilt only when
// a room adopts a different drone Map; ordinary lifecycle changes update it
// incrementally through adjustDroneCount.
function ensureDroneRuntime(room) {
  if (!room.drones) room.drones = new Map();
  if (room._droneCountSource !== room.drones || !room.droneCounts) {
    const byOwner = new Map();
    const byParent = new Map();
    for (const drone of room.drones.values()) {
      if (!drone || drone.destroyed) continue;
      byOwner.set(drone.ownerId, (byOwner.get(drone.ownerId) || 0) + 1);
      byParent.set(drone.parentShipId, (byParent.get(drone.parentShipId) || 0) + 1);
    }
    room.droneCounts = { byOwner, byParent };
    room._droneCountSource = room.drones;
  }
  return room.droneCounts;
}

function resetDroneRuntime(room) {
  room.drones = new Map();
  room.droneCounts = { byOwner: new Map(), byParent: new Map() };
  room._droneCountSource = room.drones;
  DroneDecisionContext.resetDroneDecisionRuntime(room);
  room._droneSpatialRecoveryStep = null;
  room._droneFrameId = 0;
  room._droneMovementCount = 0;
  room.droneSpatialPadding = 0;
  room._droneMovementScratch?.splice?.(0);
  room._droneSeparationScratch?.splice?.(0);
  room._droneDisplacedScratch?.splice?.(0);
}

function adjustDroneCount(room, drone, delta) {
  const counts = ensureDroneRuntime(room);
  for (const [map, key] of [[counts.byOwner, drone.ownerId], [counts.byParent, drone.parentShipId]]) {
    const next = Math.max(0, (map.get(key) || 0) + delta);
    if (next > 0) map.set(key, next);
    else map.delete(key);
  }
}

function ownerActiveCount(room, ownerId) {
  return ensureDroneRuntime(room).byOwner.get(ownerId) || 0;
}

function shipActiveCount(room, shipId) {
  return ensureDroneRuntime(room).byParent.get(shipId) || 0;
}

module.exports = {
  ensureDroneRuntime,
  resetDroneRuntime,
  adjustDroneCount,
  ownerActiveCount,
  shipActiveCount
};
