"use strict";

const HeatRules = require("../../../public/src/shared/heatRules");
const { getComponentPowerMultiplier } = require("../componentPower");
const { CONFIG, droneConfigForCommandState } = require("./settings");
const { bayPowerRequest, bayWorldPose } = require("./production");

function buildDroneSnapshots(room, now) {
  return [...(room.drones?.values?.() || [])].map((drone) => ({
    id: drone.id,
    ownerId: drone.ownerId,
    parentShipId: drone.parentShipId,
    bayComponentId: drone.bayComponentId,
    type: drone.type,
    state: drone.state,
    x: Math.round(drone.x * 100) / 100,
    y: Math.round(drone.y * 100) / 100,
    vx: Math.round(drone.vx * 100) / 100,
    vy: Math.round(drone.vy * 100) / 100,
    angle: Math.round(drone.angle * 1000) / 1000,
    radius: Number(drone.radius) || 10,
    hull: Math.max(0, Math.round(drone.hull * 10) / 10),
    maxHull: drone.maxHull,
    targetId: drone.targetId,
    fuelRemainingSeconds: Math.round(Math.max(0, Number(drone.fuelRemainingSeconds) || 0) * 100) / 100,
    fuelCapacitySeconds: (CONFIG.types[drone.type]?.fuelSeconds || CONFIG.fuelSeconds),
    stateProgress: drone.state === "launching"
      ? Math.max(0, Math.min(1, 1 - (drone.stateUntil - now) / (CONFIG.launchDurationSeconds * 1000)))
      : drone.state === "refueling"
        ? Math.max(0, Math.min(1, (now - drone.refuelStartedAt) / (CONFIG.refuelSeconds * 1000)))
        : 1
  }));
}

function buildBaySnapshots(ship) {
  return (ship.droneBays || []).map((bay) => {
    const pose = bayWorldPose(ship, bay);
    const producing = bay.slots.find((slot) => slot.state === "producing");
    const operational = ship.alive !== false && (ship.componentHp?.[bay.componentIndex] ?? 0) > 0;
    const powerFraction = operational ? getComponentPowerMultiplier(ship, bay.componentIndex) : 0;
    const overheated = operational && (ship.componentHeatState?.[bay.componentIndex] || HeatRules.STATE.NORMAL) >= HeatRules.STATE.OVERHEATED;
    return {
      componentId: bay.componentId,
      componentIndex: bay.componentIndex,
      droneType: bay.droneType,
      commandRange: Number(droneConfigForCommandState(ship, bay.droneType)?.commandRange) || 0,
      squadSize: CONFIG.squadSize,
      activeCount: bay.slots.filter((slot) => ["launching", "active", "returning", "docking", "refueling"].includes(slot.state)).length,
      refuelingCount: bay.slots.filter((slot) => slot.state === "refueling").length,
      storedCount: bay.slots.filter((slot) => ["stored", "ready"].includes(slot.state)).length,
      mode: bay.mode,
      launchBlockedBySpawn: Boolean(bay.launchBlockedBySpawn),
      operational,
      powerFraction: Math.round(Math.max(0, Number(powerFraction) || 0) * 1000) / 1000,
      overheated,
      runtimePowerMw: bayPowerRequest(ship, bay.componentIndex),
      producingSlot: producing?.slot ?? null,
      productionProgress: producing?.productionProgress ?? null,
      productionPausedReason: producing?.pauseReason ?? (ship.alive === false ? "parent-destroyed" : operational ? null : "bay-destroyed"),
      launchState: bay.slots.some((slot) => slot.state === "launching") ? "launching" : "idle",
      x: Math.round(pose.x * 10) / 10,
      y: Math.round(pose.y * 10) / 10,
      slots: bay.slots.map((slot) => ({
        state: slot.state,
        droneId: slot.droneId,
        progress: Math.round((slot.productionProgress || 0) * 1000) / 1000,
        pauseReason: slot.pauseReason
      }))
    };
  });
}

module.exports = { buildDroneSnapshots, buildBaySnapshots };
