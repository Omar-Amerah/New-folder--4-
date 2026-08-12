"use strict";

const { performanceNow } = require("../utils");
const { PARTS } = require("../components");
const DroneBayRules = require("../../../public/src/shared/droneBayRules");
const HeatRules = require("../../../public/src/shared/heatRules");
const { getComponentPowerMultiplier } = require("../componentPower");
const { bump, recordDuration } = require("../roomTelemetry");
const { CONFIG, droneConfigForCommandState } = require("./settings");
const { ensureDroneRuntime } = require("./limits");

const MODULE_SCALE = 13;
const GRID_CENTER = 7;

function indexDroneBays(ship) {
  if (!ship) return;
  const bays = ship.droneBays || [];
  if (ship._droneBayIndexSource === bays && ship.droneBayByComponentId && ship.droneBayByComponentIndex) return;
  ship.droneBayByComponentId = new Map();
  ship.droneBayByComponentIndex = new Map();
  for (const bay of bays) {
    ship.droneBayByComponentId.set(bay.componentId, bay);
    ship.droneBayByComponentIndex.set(bay.componentIndex, bay);
  }
  ship._droneBayIndexSource = bays;
}

function droneBayById(ship, componentId) {
  indexDroneBays(ship);
  return ship?.droneBayByComponentId?.get(componentId) || null;
}

function droneBayByIndex(ship, componentIndex) {
  indexDroneBays(ship);
  return ship?.droneBayByComponentIndex?.get(componentIndex) || null;
}

function initializeDroneBays(room, ship, now) {
  const validation = DroneBayRules.validateDroneBays(ship.design || [], PARTS, { maximum: CONFIG.maxBaysPerShip });
  ship.droneBays = validation.bays.map((source) => {
    const squadSize = CONFIG.types[source.droneType]?.squadSize || CONFIG.squadSize;
    return {
      ...source,
      mode: "deployed",
      _modeRevision: 0,
      launchBlockedBySpawn: false,
      nextLaunchAt: now,
      slots: Array.from({ length: squadSize }, (_, slot) => ({
        slot,
        state: "ready",
        droneId: null,
        productionProgress: 1,
        pauseReason: null
      }))
    };
  });
  indexDroneBays(ship);
  ensureDroneRuntime(room);
  return ship.droneBays;
}

function bayPowerRequest(ship, componentIndex) {
  const bay = droneBayByIndex(ship, componentIndex);
  if (!bay || (ship.componentHp?.[componentIndex] ?? 0) <= 0) return 0;
  if (bay.slots.some((slot) => slot.state === "producing" || slot.state === "destroyed")) return CONFIG.productionPowerMw;
  if (bay.slots.some((slot) => ["launching", "active", "returning", "docking", "refueling"].includes(slot.state))) return CONFIG.activePowerMw;
  // A deployed Ready slot is an imminent launch request. Reserve the active
  // load before spawning so a bay cannot launch on standby-only allocation.
  if (bay.mode === "deployed" && bay.slots.some((slot) => slot.state === "ready")) return CONFIG.activePowerMw;
  return CONFIG.standbyPowerMw;
}

function bayWorldPose(ship, bay) {
  const edge = bay.launchEdge;
  const gx = edge?.centerX ?? ship.design[bay.componentIndex].x + 1;
  const gy = edge?.centerY ?? ship.design[bay.componentIndex].y + 1;
  const gridDx = edge?.dx || 0;
  const gridDy = edge?.dy || -1;
  const lx = (GRID_CENTER - gy) * MODULE_SCALE;
  const ly = (gx - GRID_CENTER) * MODULE_SCALE;
  const localVx = -gridDy;
  const localVy = gridDx;
  const cos = Math.cos(ship.angle);
  const sin = Math.sin(ship.angle);
  return {
    x: ship.x + lx * cos - ly * sin,
    y: ship.y + lx * sin + ly * cos,
    nx: localVx * cos - localVy * sin,
    ny: localVx * sin + localVy * cos
  };
}

function bayRevisionSignature(room, ship, bay, inSpawnZone) {
  const componentAliveRevision = Number(ship?.componentAliveRevision) || Number(ship?.componentDamageRevision) || 0;
  const powerRevision = Number(ship?.powerRevision) || Number(ship?.powerFlowRevision) || Number(ship?.componentPowerRevision) || 0;
  const heatRevision = Number(ship?.heatStateRevision) || Number(ship?.componentHeatRevision) || 0;
  const mapRevision = Number(room?.mapRevision) || Number(room?.staticRevision) || Number(room?.map?.revision) || 0;
  const componentHp = Number(ship?.componentHp?.[bay?.componentIndex]) || 0;
  const heatState = Number(ship?.componentHeatState?.[bay?.componentIndex]) || 0;
  const powerValue = Number(ship?.componentPower?.byComponentIndex?.[bay?.componentIndex]?.operationalMultiplier) || 0;
  return [
    room?.stateEpoch ?? 0,
    componentAliveRevision,
    powerRevision,
    heatRevision,
    componentHp,
    heatState,
    powerValue,
    ship?.alive === false ? 0 : 1,
    Number(bay?._modeRevision) || 0,
    ship?.commandState === "backupCore" ? 1 : 0,
    inSpawnZone ? 1 : 0,
    mapRevision
  ].join(":");
}

function refreshBayFrameCounts(state, bay) {
  const slots = bay?.slots || [];
  const producingSlot = slots.find((slot) => slot.state === "producing");
  state.producing = Boolean(producingSlot);
  state.activeSlotCount = slots.filter((slot) => ["launching", "active", "returning", "docking", "refueling"].includes(slot.state)).length;
  state.returningSlotCount = slots.filter((slot) => ["returning", "docking", "refueling"].includes(slot.state)).length;
}

function buildBayFrameState(room, ship, bay, frameId, now, inSpawnZone) {
  const signature = bayRevisionSignature(room, ship, bay, inSpawnZone);
  const existing = bay._runtimeFrameState;
  if (existing && existing.frameId === frameId && existing.revision === signature) {
    bump(room, "droneBayFrameHits");
    return existing;
  }
  const startedAt = performanceNow();
  const pose = bayWorldPose(ship, bay);
  const parentAlive = ship?.alive !== false;
  const bayAlive = (ship?.componentHp?.[bay.componentIndex] ?? 0) > 0;
  const powerMultiplier = parentAlive && bayAlive
    ? Math.max(0, Number(getComponentPowerMultiplier(ship, bay.componentIndex)) || 0)
    : 0;
  const heatState = ship?.componentHeatState?.[bay.componentIndex] || HeatRules.STATE.NORMAL;
  const effectiveConfig = droneConfigForCommandState(ship, bay.droneType);
  const state = existing || (bay._runtimeFrameState = {});
  state.frameId = frameId;
  state.revision = signature;
  state.parentAlive = parentAlive;
  state.bayAlive = bayAlive;
  state.operational = parentAlive && bayAlive;
  state.powerMultiplier = powerMultiplier;
  state.heatState = heatState;
  state.mode = bay.mode;
  state.worldX = pose.x;
  state.worldY = pose.y;
  state.normalX = pose.nx;
  state.normalY = pose.ny;
  state.inSpawnZone = Boolean(inSpawnZone);
  state.backupCoreActive = ship?.commandState === "backupCore";
  state.effectiveConfig = effectiveConfig;
  state.validUntil = now;
  refreshBayFrameCounts(state, bay);
  bump(room, "droneBayFrameBuilds");
  recordDuration(room, "droneBayFrameStateMs", startedAt);
  return state;
}

function bayPoseFromFrame(state, parent) {
  return state
    ? { x: state.worldX, y: state.worldY, nx: state.normalX, ny: state.normalY }
    : { x: parent?.x || 0, y: parent?.y || 0, nx: 1, ny: 0 };
}

function isInOwnSpawnZone(room, ship) {
  const player = room.players?.get?.(ship?.ownerId);
  for (const zone of room.map?.safeZones || []) {
    const dx = ship.x - zone.x;
    const dy = ship.y - zone.y;
    if (!zone?.isSpawn || dx * dx + dy * dy > zone.radius * zone.radius) continue;
    if (zone.ownerId) return Boolean(player && player.id === zone.ownerId);
    if (zone.team) return Boolean(player && player.team === zone.team);
    if (Array.isArray(zone.spawnPlayerIds)) return zone.spawnPlayerIds.includes(player?.id);
    return true;
  }
  return false;
}

function advanceBayProduction(bay, dt, power, overheated, operational = true) {
  let producing = bay.slots.find((slot) => slot.state === "producing");
  if (!producing && operational) {
    producing = bay.slots.find((slot) => slot.state === "destroyed");
    if (producing) producing.state = "producing";
  }
  if (!producing) return null;
  if (!operational) {
    producing.pauseReason = "bay-destroyed";
    return producing;
  }
  if (overheated) {
    producing.pauseReason = "bay-overheated";
    return producing;
  }
  const duration = CONFIG.types[bay.droneType]?.productionSeconds;
  if (!(duration > 0)) {
    producing.pauseReason = "invalid-configuration";
    return producing;
  }
  // Production scales with the delivered power fraction. Exact zero is the
  // unpowered state; any positive allocation continues production more slowly.
  if (power <= 0) {
    producing.pauseReason = "insufficient-power";
    return producing;
  }
  producing.pauseReason = power < 0.98 ? "low-power" : null;
  producing.productionProgress = Math.min(1, producing.productionProgress + dt * power / duration);
  if (producing.productionProgress >= 1) producing.state = bay.mode === "deployed" ? "ready" : "stored";
  return producing;
}

module.exports = {
  initializeDroneBays,
  indexDroneBays,
  droneBayById,
  droneBayByIndex,
  bayPowerRequest,
  bayWorldPose,
  buildBayFrameState,
  refreshBayFrameCounts,
  bayPoseFromFrame,
  isInOwnSpawnZone,
  advanceBayProduction
};
