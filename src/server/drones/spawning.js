"use strict";

const { droneBroadPhaseRadius } = require("../spatialIndex");
const {
  CONFIG,
  DRONE_DECISION_INTERVAL_MS,
  buildDroneRuntimeConfig
} = require("./settings");
const { bayWorldPose } = require("./production");
const { ownerActiveCount, shipActiveCount, adjustDroneCount } = require("./limits");

function spawnDrone(room, ship, bay, slot, now) {
  if (!ship || ship.alive === false || !bay || (ship.componentHp?.[bay.componentIndex] ?? 0) <= 0) return null;
  if (shipActiveCount(room, ship.id) >= CONFIG.maxActivePerShip) return null;
  if (ownerActiveCount(room, ship.ownerId) >= CONFIG.maxActivePerPlayer) return null;
  const typeConfig = CONFIG.types[bay.droneType];
  if (!typeConfig) return null;
  const pose = bayWorldPose(ship, bay);
  const authoritativeSequence = room._nextDroneSequence || (room._nextDroneSequence = 0);
  room._nextDroneSequence = authoritativeSequence + 1;
  const drone = {
    id: `d${room.nextEntityId++}`,
    ownerId: ship.ownerId,
    ownerPlayerId: ship.ownerId,
    teamId: ship.team || room.players?.get?.(ship.ownerId)?.team || null,
    parentShipId: ship.id,
    bayComponentId: bay.componentId,
    bayComponentIndex: bay.componentIndex,
    slot: slot.slot,
    squadIndex: slot.slot,
    type: bay.droneType,
    droneType: bay.droneType,
    x: pose.x,
    y: pose.y,
    vx: pose.nx * typeConfig.speed * 0.35,
    vy: pose.ny * typeConfig.speed * 0.35,
    angle: Math.atan2(pose.ny, pose.nx),
    radius: 10,
    hull: typeConfig.hull,
    maxHull: typeConfig.hull,
    state: "launching",
    launchedAt: now,
    stateUntil: now + CONFIG.launchDurationSeconds * 1000,
    commandState: bay.mode,
    nextThinkAt: now + ((slot.slot * 37) % DRONE_DECISION_INTERVAL_MS),
    nextDecisionAt: now + ((slot.slot * 37) % DRONE_DECISION_INTERVAL_MS),
    nextActionAt: now + 350,
    targetId: null,
    fuelRemainingSeconds: (CONFIG.types[bay.droneType]?.fuelSeconds || CONFIG.fuelSeconds),
    returnReason: null,
    refuelStartedAt: null,
    refuelUntil: null,
    orphanedAt: null,
    removed: false,
    authoritativeSequence
  };
  drone._runtimeConfig = buildDroneRuntimeConfig(drone, typeConfig, authoritativeSequence);
  drone._targetRuntime = { id: null, kind: null, entity: null, roomEpoch: room.stateEpoch ?? null };
  drone.decisionInvalidated = false;
  drone.nextDecisionAt = now + drone._runtimeConfig.decisionStaggerMs;
  drone.nextThinkAt = drone.nextDecisionAt;
  room.drones.set(drone.id, drone);
  if (room._visibilityRuntime) {
    const visibilityRuntime = require("../visibilityRuntime");
    visibilityRuntime.registerEntityMembership(room, room._visibilityRuntime, drone, "drone");
  }
  if (room.spatialIndex?.dynamicValid && typeof room.spatialIndex.append === "function") {
    room.spatialIndex.append("drones", drone, droneBroadPhaseRadius(drone));
  }
  adjustDroneCount(room, drone, 1);
  slot.droneId = drone.id;
  slot.state = "launching";
  slot.productionProgress = 1;
  slot.pauseReason = null;
  room.effects.push({ type: "dronelaunch", subtype: drone.type, ownerId: drone.ownerId, x: drone.x, y: drone.y, at: now });
  return drone;
}

module.exports = { spawnDrone };
