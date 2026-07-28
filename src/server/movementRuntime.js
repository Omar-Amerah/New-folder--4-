"use strict";

function finitePoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y)
    ? { x: Number(point.x), y: Number(point.y) }
    : null;
}

function emptyNavigation() {
  return {
    waypoints: [],
    waypointIndex: 0,
    plannedDestination: null,
    plannedAt: 0,
    commandId: null,
    clearance: null,
    finalFacing: null
  };
}

function emptyStyle() {
  return {
    orbit: null,
    evasive: null,
    sentryPosition: null,
    holdPosition: null,
    holdTargetId: null
  };
}

function createMovementRuntime() {
  return {
    command: null,
    navigation: emptyNavigation(),
    style: emptyStyle(),
    phase: "idle"
  };
}

function ensureMovementRuntime(ship) {
  if (!ship.movement || typeof ship.movement !== "object") {
    ship.movement = createMovementRuntime();
  }
  return ship.movement;
}

function resetNavigation(ship) {
  ensureMovementRuntime(ship).navigation = emptyNavigation();
}

function resetStyleMemory(ship, combatStyle = ship.combatStyle) {
  const runtime = ensureMovementRuntime(ship);
  runtime.style.orbit = null;
  runtime.style.evasive = null;
  runtime.style.holdPosition = null;
  runtime.style.holdTargetId = null;
  if (combatStyle === "sentry") {
    runtime.style.sentryPosition = {
      x: Number(ship.x) || 0,
      y: Number(ship.y) || 0
    };
  } else {
    runtime.style.sentryPosition = null;
  }
}

function setMovementCommand(ship, command) {
  const runtime = ensureMovementRuntime(ship);
  const previousTargetId = runtime.command?.targetId || null;
  runtime.command = command
    ? {
      id: String(command.id),
      type: String(command.type),
      destination: finitePoint(command.destination),
      targetId: command.targetId == null ? null : String(command.targetId),
      finalFacing: Number.isFinite(command.finalFacing) ? Number(command.finalFacing) : null
    }
    : null;
  runtime.navigation = emptyNavigation();
  ship.manualRotation = null;
  if (!command) {
    runtime.phase = "idle";
  } else if (command.type === "stop") {
    runtime.phase = "braking";
  } else {
    runtime.phase = "travelling";
  }
  if (previousTargetId !== runtime.command?.targetId || command?.type !== "attack") {
    runtime.style.orbit = null;
    runtime.style.evasive = null;
    runtime.style.holdPosition = null;
    runtime.style.holdTargetId = null;
  }
  return runtime.command;
}

function nextMovementCommandId(room, prefix = "m") {
  room._nextCommandId = (Number(room._nextCommandId) || 0) + 1;
  return `${prefix}${room._nextCommandId}`;
}

function setManualRotation(ship, direction) {
  const runtime = ensureMovementRuntime(ship);
  ship.manualRotation = direction === 1 || direction === -1 ? direction : null;
  if (ship.manualRotation) runtime.phase = "turning";
}

function syncMovementTarget(ship, intent = null) {
  const runtime = ensureMovementRuntime(ship);
  const command = runtime.command;
  const destination = finitePoint(intent?.destination) || finitePoint(command?.destination);
  ship.targetX = destination?.x ?? (Number(ship.x) || 0);
  ship.targetY = destination?.y ?? (Number(ship.y) || 0);
}

module.exports = {
  createMovementRuntime,
  ensureMovementRuntime,
  nextMovementCommandId,
  resetNavigation,
  resetStyleMemory,
  setManualRotation,
  setMovementCommand,
  syncMovementTarget
};
