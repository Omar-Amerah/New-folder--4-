"use strict";

const { getComponentPowerMultiplier } = require("../componentPower");
const { ensureDroneRuntime, adjustDroneCount } = require("./limits");
const { droneBayById } = require("./production");
const { clearDroneTarget, markDroneDecisionInvalidated } = require("./targeting");

function removeActiveDrone(room, drone) {
  if (!drone || room.drones?.get?.(drone.id) !== drone) return false;
  ensureDroneRuntime(room);
  room.drones.delete(drone.id);
  if (room._visibilityRuntime) require("../visibilityRuntime").unregisterEntity(room, drone, "drone");
  room.spatialIndex?.remove?.("drones", drone);
  adjustDroneCount(room, drone, -1);
  drone.removed = true;
  drone._separationOrder = undefined;
  return true;
}

function setDroneDestroyed(room, drone, now, reason = "destroyed") {
  if (!drone || drone.destroyed) return false;
  removeActiveDrone(room, drone);
  drone.destroyed = true;
  drone.destroyedAt = now;
  const parent = room.ships.get(drone.parentShipId);
  const bay = droneBayById(parent, drone.bayComponentId);
  const slot = bay?.slots?.[drone.slot];
  if (slot && slot.droneId === drone.id) {
    slot.droneId = null;
    slot.state = "destroyed";
    slot.productionProgress = 0;
    slot.pauseReason = null;
  }
  room.effects.push({ type: "droneburst", subtype: drone.type, reason, x: drone.x, y: drone.y, at: now });
  return true;
}

function damageDrone(room, drone, amount, attackerId, now) {
  if (!drone || drone.destroyed || !(amount > 0)) return 0;
  const applied = Math.min(drone.hull, amount);
  drone.hull -= applied;
  drone.lastDamagedAt = now;
  drone.lastDamagedBy = attackerId || null;
  if (drone.hull <= 0.001) setDroneDestroyed(room, drone, now);
  return applied;
}

function setDroneBayMode(room, player, shipId, componentId, mode, now = Date.now()) {
  const ship = room.ships.get(String(shipId || ""));
  if (!ship?.alive || ship.ownerId !== player?.id) return false;
  const bay = droneBayById(ship, componentId);
  if (!bay || !["deployed", "recalled"].includes(mode)) return false;
  if (bay.mode !== mode) bay._modeRevision = (Number(bay._modeRevision) || 0) + 1;
  bay.mode = mode;
  const operational = (ship.componentHp?.[bay.componentIndex] ?? 0) > 0;
  const powered = operational && getComponentPowerMultiplier(ship, bay.componentIndex) > 0;
  if (mode === "recalled") {
    for (const slot of bay.slots) if (slot.state === "ready") slot.state = "stored";
    for (const drone of room.drones?.values?.() || []) {
      if (drone.destroyed || drone.parentShipId !== ship.id || drone.bayComponentId !== bay.componentId) continue;
      drone.commandState = "recalled";
      clearDroneTarget(room, drone, true);
      drone.returnReason = "recall";
      if (operational) drone.state = "returning";
      const slot = bay.slots[drone.slot];
      if (slot && operational) slot.state = "returning";
    }
  } else {
    bay.nextLaunchAt = Math.min(Number(bay.nextLaunchAt) || now, now);
    for (const slot of bay.slots) if (slot.state === "stored") slot.state = "ready";
    for (const drone of room.drones?.values?.() || []) {
      if (drone.destroyed || drone.parentShipId !== ship.id || drone.bayComponentId !== bay.componentId) continue;
      drone.commandState = powered ? "deployed" : "fallback";
      clearDroneTarget(room, drone, true);
      if (["returning", "docking"].includes(drone.state) && drone.returnReason !== "fuel") {
        drone.state = powered ? "active" : "fallback";
        drone.returnReason = null;
      }
      const slot = bay.slots[drone.slot];
      if (slot && ["returning", "docking"].includes(slot.state)) slot.state = drone.state;
      drone.nextThinkAt = Math.min(Number(drone.nextThinkAt) || now, now);
      drone.nextDecisionAt = Math.min(Number(drone.nextDecisionAt) || now, now);
      markDroneDecisionInvalidated(room, drone, "deploy");
    }
  }
  return true;
}

module.exports = { removeActiveDrone, setDroneDestroyed, damageDrone, setDroneBayMode };
