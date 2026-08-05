"use strict";

const {
  setMovementCommand,
  syncMovementTarget
} = require("./movementRuntime");
const {
  canTeamTargetEntity,
  usesSensorVisibility
} = require("./visibility");

const WEAPON_TARGET_ID_ARRAYS = Object.freeze([
  "weaponAimTargetIds",
  "weaponFireTargetIds",
  "weaponAcquiredTargetIds",
  "weaponPendingTargetIds",
  "weaponComponentTargetIds"
]);

function resolveTrackedEntity(room, targetId) {
  if (!targetId) return null;
  const id = String(targetId);
  return room.ships?.get?.(id)
    || room.drones?.get?.(id)
    || room.stationsById?.get?.(id)
    || room.stations?.find?.((station) => String(station?.id) === id)
    || null;
}

function collectTrackedEntityIds(ship) {
  const ids = ship._trackedTargetIdScratch || (ship._trackedTargetIdScratch = new Set());
  ids.clear();
  const add = (targetId) => {
    if (targetId !== null && targetId !== undefined && targetId !== "") {
      ids.add(String(targetId));
    }
  };

  add(ship.focusTargetId);
  add(ship.combatTargetId);
  if (ship.movement?.command?.type === "attack") add(ship.movement.command.targetId);
  for (const property of WEAPON_TARGET_ID_ARRAYS) {
    for (const targetId of ship[property] || []) add(targetId);
  }
  for (const contact of ship.weaponBeamContacts || []) add(contact?.targetShipId);
  for (const contact of ship.weaponInductionContacts || []) add(contact?.targetShipId);
  return ids;
}

function clearHiddenWeaponLocks(ship, hiddenIds) {
  let cleared = 0;
  const clearIdArray = (property, onClear = null) => {
    const values = ship[property];
    if (!Array.isArray(values)) return;
    for (let index = 0; index < values.length; index += 1) {
      if (!hiddenIds.has(String(values[index]))) continue;
      values[index] = null;
      if (onClear) onClear(index);
      cleared += 1;
    }
  };

  clearIdArray("weaponAimTargetIds");
  clearIdArray("weaponFireTargetIds");
  clearIdArray("weaponAcquiredTargetIds", (index) => {
    if (ship.weaponAcquireCompleteAt) ship.weaponAcquireCompleteAt[index] = 0;
  });
  clearIdArray("weaponPendingTargetIds", (index) => {
    if (ship.weaponAcquireCompleteAt) ship.weaponAcquireCompleteAt[index] = 0;
  });
  clearIdArray("weaponComponentTargetIds", (index) => {
    if (ship.weaponComponentTargetIndices) ship.weaponComponentTargetIndices[index] = -1;
    if (ship.weaponComponentRetargetAt) ship.weaponComponentRetargetAt[index] = 0;
  });

  if (Array.isArray(ship.weaponBeamContacts)) {
    for (let index = 0; index < ship.weaponBeamContacts.length; index += 1) {
      const contact = ship.weaponBeamContacts[index];
      if (!hiddenIds.has(String(contact?.targetShipId))) continue;
      ship.weaponBeamContacts[index] = null;
      cleared += 1;
    }
  }

  if (Array.isArray(ship.weaponInductionContacts)) {
    for (let index = 0; index < ship.weaponInductionContacts.length; index += 1) {
      const contact = ship.weaponInductionContacts[index];
      if (!hiddenIds.has(String(contact?.targetShipId))) continue;
      ship.weaponInductionContacts[index] = null;
      cleared += 1;
    }
  }
  return cleared;
}

function dropHiddenTargetLocks(room, ship, now) {
  if (!ship?.alive || !usesSensorVisibility(room)) return 0;

  const hiddenIds = ship._hiddenTargetIdScratch || (ship._hiddenTargetIdScratch = new Set());
  hiddenIds.clear();
  for (const targetId of collectTrackedEntityIds(ship)) {
    const target = resolveTrackedEntity(room, targetId);
    if (!target || target.alive === false || target.removed
      || !canTeamTargetEntity(room, ship.ownerId ?? ship.team, target, now)) {
      hiddenIds.add(targetId);
    }
  }
  if (hiddenIds.size === 0) return 0;

  let cleared = 0;
  if (hiddenIds.has(String(ship.focusTargetId))) {
    ship.focusTargetId = null;
    cleared += 1;
  }
  if (hiddenIds.has(String(ship.combatTargetId))) {
    ship.combatTargetId = null;
    cleared += 1;
  }

  const command = ship.movement?.command;
  if (command?.type === "attack" && hiddenIds.has(String(command.targetId))) {
    setMovementCommand(ship, null);
    syncMovementTarget(ship);
    cleared += 1;
  }

  return cleared + clearHiddenWeaponLocks(ship, hiddenIds);
}

function dropHiddenTargetLocksForShips(room, ships, now) {
  if (!usesSensorVisibility(room)) return 0;
  let cleared = 0;
  for (const ship of ships || []) cleared += dropHiddenTargetLocks(room, ship, now);
  return cleared;
}

module.exports = {
  dropHiddenTargetLocks,
  dropHiddenTargetLocksForShips
};
