"use strict";

const {
  MOVEMENT_TOGGLE_DEFAULTS,
  sanitizeCombatStyle
} = require("../validation");

function movementAuthority(room, ship, runtime) {
  const command = runtime.command;
  if (command?.type === "stop") return "stop";
  if (command?.type === "move") {
    if (!runtime.orderComplete) return "move";
    if (engagementTarget(room, ship, runtime)) return "engage";
    runtime.destination = command.destination;
    // Deliberately no "it has drifted off the point, re-run the move" branch.
    // Collision correction and friendly separation shove a parked hull around by
    // more than the arrival envelope all the time in a crowded formation, and
    // reopening the order on that reinstates route steering for a tick, which
    // re-derives the nose direction from the path and then hands it back to the
    // resting heading -- the ship visibly hunts between the two. The order was
    // carried out; being nudged afterwards does not un-carry it out.
    return "position";
  }
  return "engage";
}

function trackedEntity(room, targetId) {
  if (!targetId) return null;
  const entity = room?.ships?.get?.(String(targetId))
    || room?.stationsById?.get?.(String(targetId))
    || null;
  return entity && entity.alive !== false ? entity : null;
}

function engagementTarget(room, ship, runtime) {
  const command = runtime.command;
  if (command?.type === "attack" || command?.type === "repair") {
    const explicit = trackedEntity(room, command.targetId);
    return explicit ? { target: explicit, type: command.type, explicit: true } : null;
  }
  const automatic = trackedEntity(room, ship.combatTargetId);
  return automatic ? { target: automatic, type: "attack", explicit: false } : null;
}

function combatStance(ship) {
  const raw = ship?.combatStyleRaw || ship?.combatStyle;
  if (raw === "sentry") return "sentry";
  return sanitizeCombatStyle(raw);
}

function movementToggles(ship) {
  return ship?.movementToggles || MOVEMENT_TOGGLE_DEFAULTS;
}

function clearTargetReferences(ship) {
  ship.focusTargetId = null;
  ship.combatTargetId = null;
  ship.repairTargetId = null;
}

module.exports = {
  clearTargetReferences,
  combatStance,
  engagementTarget,
  movementAuthority,
  movementToggles,
  trackedEntity
};

