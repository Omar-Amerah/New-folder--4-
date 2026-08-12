"use strict";

const { usesStationInfrastructure } = require("./rooms");
const { resolveStationCollision } = require("./stations/collision");
const { stationBroadPhaseRadius } = require("./spatialIndex");
const { performanceNow } = require("./utils");
const { bump, recordDuration, detailedProfileActive } = require("./roomTelemetry");
const {
  homeStationTemplate,
  relayStationTemplate,
  isStation,
  isOperationalStation,
  isDamageableEntity,
  isCombatEntity,
  isHostileEntity,
  createStationsForRoom,
  destroyStationsForRoom
} = require("./stations/lifecycle");
const {
  enqueueStationProduction,
  enqueueBotProduction,
  queuedShipCount,
  findTeamHomeStation
} = require("./stations/hangars");
const {
  processStationLaunchQueue,
  reconcileStationLaunchState,
  updateStationLaunches,
  updateStationLaunchControl
} = require("./stations/launching");
const { updateStationCapture } = require("./stations/relayControl");
const {
  updateStationRepair,
  updateStationRepairBeams,
  updateStationSelfRepair
} = require("./stations/repair");

// These stage helpers deliberately accept one station. updateStations keeps the
// historical per-station ordering (capture -> self repair -> launch
// control -> repair -> launch queue) while exposing independent timing buckets.
// Splitting into room-wide loops here would make a later station's state visible
// to an earlier station in a different order than the starting runtime.
function updateStationCaptureSystems(room, station, dt, now) {
  const startedAt = performanceNow();
  try {
    updateStationCapture(room, station, dt, now);
  } finally {
    recordDuration(room, "stationObjectiveRuntimeMs", startedAt);
  }
}

function updateStationRepairSystems(room, station, dt, now, phase = "all") {
  const startedAt = performanceNow();
  try {
    if (phase === "self" || phase === "all") updateStationSelfRepair(room, station, dt);
    if (phase === "active" || phase === "all") {
      updateStationRepair(room, station, dt, now);
      updateStationRepairBeams(room, station, dt, now);
    }
  } finally {
    recordDuration(room, "stationRepairRuntimeMs", startedAt);
  }
}

function updateStationHangarSystems(room, station, dt, now, phase = "all") {
  const startedAt = performanceNow();
  try {
    if (detailedProfileActive(room) && station.stationType === "home" && (phase === "launches" || phase === "all")) {
      bump(room, "stationHomeStationsProcessed");
    }
    if (phase === "launches" || phase === "all") updateStationLaunches(room, station, dt, now);
    if (phase === "queue" || phase === "all") processStationLaunchQueue(room, station, dt, now);
  } finally {
    recordDuration(room, "stationHangarRuntimeMs", startedAt);
  }
}

function updateStations(room, dt, now, options = null) {
  if (!usesStationInfrastructure(room) || !room.stations) return;
  const skipLaunchControl = options?.skipLaunchControl === true;
  const startedAt = performanceNow();
  try {
    if (!skipLaunchControl) reconcileStationLaunchState(room, now);
    for (const station of room.stations) {
      updateStationCaptureSystems(room, station, dt, now);
      updateStationRepairSystems(room, station, dt, now, "self");
      if (!skipLaunchControl) updateStationHangarSystems(room, station, dt, now, "launches");
      updateStationRepairSystems(room, station, dt, now, "active");
      updateStationHangarSystems(room, station, dt, now, "queue");
    }
    if (room.spatialIndex?.updateLiveEntities) {
      room.spatialIndex.updateLiveEntities("stations", room.stations, stationBroadPhaseRadius);
    }
  } finally {
    recordDuration(room, "stationRuntimeMs", startedAt);
  }
}

module.exports = {
  homeStationTemplate,
  relayStationTemplate,
  isStation,
  isOperationalStation,
  isDamageableEntity,
  isCombatEntity,
  isHostileEntity,
  createStationsForRoom,
  destroyStationsForRoom,
  updateStations,
  updateStationCaptureSystems,
  updateStationRepairSystems,
  updateStationHangarSystems,
  updateStationLaunchControl,
  enqueueStationProduction,
  enqueueBotProduction,
  queuedShipCount,
  findTeamHomeStation,
  usesStationInfrastructure,
  resolveStationCollision
};
