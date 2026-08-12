"use strict";

const { performanceNow } = require("./utils");
const { PARTS } = require("./components");
const HeatRules = require("../../public/src/shared/heatRules");
const { addComponentHeat } = require("./heat");
const { bump, recordDuration } = require("./roomTelemetry");
const DroneDecisionContext = require("./droneDecisionContext");

const {
  CONFIG,
  DRONE_DECISION_INTERVALS_MS,
  MAX_CONFIGURED_DRONE_SPEED,
  buildDroneRuntimeConfig,
  ensureDroneRuntimeConfig,
  effectiveDroneConfig
} = require("./drones/settings");
const {
  ensureDroneRuntime,
  resetDroneRuntime,
  ownerActiveCount,
  shipActiveCount
} = require("./drones/limits");
const {
  initializeDroneBays,
  indexDroneBays,
  droneBayById,
  bayPowerRequest,
  bayWorldPose,
  buildBayFrameState,
  refreshBayFrameCounts,
  isInOwnSpawnZone,
  advanceBayProduction
} = require("./drones/production");
const { spawnDrone } = require("./drones/spawning");
const {
  damageDrone,
  setDroneDestroyed,
  setDroneBayMode
} = require("./drones/lifecycle");
const {
  rememberDroneTarget,
  resolveCachedDroneTarget,
  droneContextMembers,
  chooseTarget,
  chooseFallbackTarget,
  nearestHostileMissile
} = require("./drones/targeting");
const { fighterProjectileEvasion, steerFighterDrone } = require("./drones/evasion");
const {
  resolveDroneMapCollision,
  resolveDroneSeparation,
  publishDroneSpatialRecords
} = require("./drones/movement");
const { updateDroneEntity } = require("./drones/runtime");
const { buildDroneSnapshots, buildBaySnapshots } = require("./drones/snapshots");

function updateDroneBays(room, ships, dt, now) {
  const runtimeStart = performanceNow();
  ensureDroneRuntime(room);
  room.droneDecisionMaxCandidateSpeed = Math.max(
    Number(room.droneDecisionMaxCandidateSpeed) || 0,
    MAX_CONFIGURED_DRONE_SPEED
  );
  room._droneFrameId = (Number(room._droneFrameId) || 0) + 1;
  DroneDecisionContext.beginDroneDecisionFrame(room, room._droneFrameId, now);
  room.droneSpatialPadding = Math.max(
    0,
    ...Object.values(CONFIG.types || {}).map((entry) => Number(entry?.speed) || 0)
  ) * Math.max(0, Number(dt) || 0) * 1.75 + 2;

  for (const members of room._droneContextMemberScratch?.values?.() || []) members.length = 0;
  for (const ship of ships) {
    if (ship.launchPhase) continue;
    if (!ship.droneBays) initializeDroneBays(room, ship, now);
    else indexDroneBays(ship);
    const inSpawnZone = isInOwnSpawnZone(room, ship);
    for (const bay of ship.droneBays) {
      bay.launchBlockedBySpawn = inSpawnZone;
      const state = buildBayFrameState(room, ship, bay, room._droneFrameId, now, inSpawnZone);
      const operational = state.operational;
      if (!operational) {
        advanceBayProduction(bay, dt, 0, false, false);
        refreshBayFrameCounts(state, bay);
        continue;
      }
      const power = state.powerMultiplier;
      const overheated = state.heatState >= HeatRules.STATE.OVERHEATED;
      advanceBayProduction(bay, dt, power, overheated, true);
      refreshBayFrameCounts(state, bay);
      // Production or an active/launching/returning/docking/refuelling slot is
      // activity. A merely powered standby bay has no authored activity Heat.
      const activityMultiplier = !overheated && (state.producing || state.activeSlotCount > 0) ? 1 : 0;
      const heatPerSecond = HeatRules.activityHeat("droneBay", PARTS.droneBay);
      if (activityMultiplier > 0 && heatPerSecond > 0) {
        addComponentHeat(ship, bay.componentIndex, heatPerSecond * activityMultiplier * power * dt);
      }
      if (inSpawnZone || bay.mode !== "deployed" || now < bay.nextLaunchAt || power <= 0 || overheated) continue;
      const ready = bay.slots.find((slot) => slot.state === "ready" || slot.state === "stored");
      if (ready) {
        spawnDrone(room, ship, bay, ready, now);
        bay.nextLaunchAt = now + CONFIG.launchIntervalSeconds * 1000 / power;
      }
    }
  }

  for (const drone of room.drones.values()) {
    if (!drone || drone.destroyed || drone.removed) continue;
    const parent = room.ships.get(drone.parentShipId);
    const bay = parent ? droneBayById(parent, drone.bayComponentId) : null;
    const members = parent && bay ? droneContextMembers(room, parent, bay, drone.type) : [];
    if (!members.includes(drone)) members.push(drone);
  }
  for (const drone of room.drones.values()) {
    const previousX = drone.x;
    const previousY = drone.y;
    const parent = room.ships.get(drone.parentShipId);
    const bay = parent ? droneBayById(parent, drone.bayComponentId) : null;
    const members = parent && bay ? droneContextMembers(room, parent, bay, drone.type) : [];
    const bayState = bay?._runtimeFrameState || null;
    updateDroneEntity(room, drone, dt, now, bayState, members);
    const mapCollisionStart = performanceNow();
    resolveDroneMapCollision(room, drone, previousX, previousY);
    recordDuration(room, "droneMapCollisionMs", mapCollisionStart);
    const movement = room._droneMovementScratch || (room._droneMovementScratch = []);
    const record = movement[room._droneMovementCount || 0] || (movement[room._droneMovementCount || 0] = {});
    record.drone = drone;
    record.previousX = previousX;
    record.previousY = previousY;
    record.postSeparationX = drone.x;
    record.postSeparationY = drone.y;
    room._droneMovementCount = (room._droneMovementCount || 0) + 1;
    bump(room, "dronesVisited");
  }

  const movement = room._droneMovementScratch || (room._droneMovementScratch = []);
  const movementCount = room._droneMovementCount || 0;
  movement.length = movementCount;
  room._droneMovementCount = 0;
  publishDroneSpatialRecords(room, now);
  const separationStart = performanceNow();
  resolveDroneSeparation(
    room.drones.values(),
    room._droneSeparationScratch || (room._droneSeparationScratch = []),
    room.spatialIndex,
    room.droneSpatialPadding
  );
  recordDuration(room, "droneSeparationMs", separationStart);

  const displaced = room._droneDisplacedScratch || (room._droneDisplacedScratch = []);
  let displacedCount = 0;
  for (const record of movement) {
    const { drone, previousX, previousY, postSeparationX, postSeparationY } = record;
    if (room.drones.get(drone.id) !== drone) continue;
    const dx = drone.x - postSeparationX;
    const dy = drone.y - postSeparationY;
    if (Math.sqrt(dx * dx + dy * dy) > 0.001) displaced[displacedCount++] = drone;
    const totalDx = drone.x - previousX;
    const totalDy = drone.y - previousY;
    const totalDisplacement = Math.sqrt(totalDx * totalDx + totalDy * totalDy) + 2;
    if (totalDisplacement > room.droneSpatialPadding) room.droneSpatialPadding = totalDisplacement;
  }
  displaced.length = displacedCount;
  for (let index = 0; index < displacedCount; index += 1) {
    const drone = displaced[index];
    if (drone && room.drones.get(drone.id) === drone) {
      const mapCollisionStart = performanceNow();
      resolveDroneMapCollision(room, drone);
      recordDuration(room, "droneMapCollisionMs", mapCollisionStart);
    }
  }
  publishDroneSpatialRecords(room, now);
  recordDuration(room, "droneRuntimeMs", runtimeStart);
}

module.exports = {
  CONFIG,
  DRONE_DECISION_INTERVALS_MS,
  initializeDroneBays,
  ensureDroneRuntime,
  resetDroneRuntime,
  ownerActiveCount,
  shipActiveCount,
  bayPowerRequest,
  bayWorldPose,
  updateDroneBays,
  damageDrone,
  setDroneDestroyed,
  setDroneBayMode,
  buildDroneSnapshots,
  buildBaySnapshots,
  _test: {
    spawnDrone,
    buildDroneRuntimeConfig,
    ensureDroneRuntimeConfig,
    effectiveDroneConfig,
    buildBayFrameState,
    rememberDroneTarget,
    resolveCachedDroneTarget,
    updateDroneEntity,
    chooseTarget,
    chooseFallbackTarget,
    nearestHostileMissile,
    fighterProjectileEvasion,
    steerFighterDrone,
    advanceBayProduction,
    isInOwnSpawnZone,
    resolveDroneMapCollision,
    resolveDroneSeparation
  }
};
