"use strict";

// Per-ship movement state for the rewritten controller.
//
// One order, one destination, one phase. Everything the autopilot needs to fly
// the ship this tick is here, and nothing else is: there is no stance memory,
// no orbit anchor, no cached facing command. The controller recomputes its
// desire from the world every substep, so there is no second copy of the truth
// to drift out of step with the first.
//
// `path` and `waypointIndex` are reserved for the obstacle-avoidance phase and
// stay empty until then -- a ship flies straight at its destination today.

const { SUPPORTED_MOVEMENT_TYPES } = require("./movementFlags");

const MOVEMENT_TYPES = new Set(SUPPORTED_MOVEMENT_TYPES);

function finitePoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y)
    ? { x: Number(point.x), y: Number(point.y) }
    : null;
}

function createMovementRuntime() {
  return {
    command: null,
    destination: null,
    path: [],
    waypointIndex: 0,
    phase: "idle",
    desiredHeading: null,
    desiredSpeed: 0,
    arrived: false,
    // A Move that has been carried out. Latched, and cleared only by a new
    // order: once the ship has reached where it was sent, the combat stance
    // takes the helm, and it must not be able to hand it back by nudging the
    // ship far enough off the point to look un-arrived again.
    orderComplete: false,
    // Hold has reached its firing position. Also latched -- it is what makes the
    // ship ignore a target closing on it rather than backing away.
    holdEngaged: false,
    // On a ramming run: a Charge ship carrying a live demolition charge, closing
    // on the target it will detonate against. Recomputed every tick, never
    // latched -- see updateShipMovement.
    ramming: false
  };
}

function ensureMovementRuntime(ship) {
  const runtime = ship.movement;
  // A ship carried over from the fallback implementation has the old shape.
  // Recognise it by the fields this controller owns and start it fresh rather
  // than flying half-initialised state.
  if (!runtime || typeof runtime !== "object" || !Array.isArray(runtime.path)) {
    ship.movement = createMovementRuntime();
    return ship.movement;
  }
  return runtime;
}

// `manual` marks an order the player issued directly. Internal rally moves
// (station launch, formation assignment) leave it false so a freshly built ship
// can still be re-tasked by its owner's next click without special-casing.
//
// `formationHeading` is the direction the whole selection is travelling, set by
// commandShips. It is what stops the outer ships of a group from turning inward
// to stare at the exact pixel the player clicked.
function setMovementCommand(ship, command) {
  const runtime = ensureMovementRuntime(ship);
  runtime.command = command && MOVEMENT_TYPES.has(String(command.type))
    ? {
      id: command.id == null ? null : String(command.id),
      type: String(command.type),
      destination: finitePoint(command.destination),
      targetId: command.targetId == null ? null : String(command.targetId),
      formationHeading: Number.isFinite(command.formationHeading)
        ? Number(command.formationHeading)
        : null,
      // The pace of the slowest hull in the selection, so the group stays a
      // group in flight rather than only at the destination.
      formationSpeed: Number.isFinite(command.formationSpeed) && command.formationSpeed > 0
        ? Number(command.formationSpeed)
        : null,
      // This ship's place across a group's firing line, so a fleet attacking one
      // target forms a line rather than a ring around it.
      firingLateral: Number.isFinite(command.firingLateral) ? Number(command.firingLateral) : 0,
      // This ship's bearing around a target a group is charging, so a fleet
      // closing to contact shares the hull out between its sides instead of
      // every ship driving at the same point on it. Null for every other stance.
      chargeBearing: Number.isFinite(command.chargeBearing) ? Number(command.chargeBearing) : null,
      finalFacing: Number.isFinite(command.finalFacing) ? Number(command.finalFacing) : null,
      manual: Boolean(command.manual)
    }
    : null;
  runtime.destination = runtime.command?.type === "move"
    ? runtime.command.destination
    : null;
  runtime.path = [];
  runtime.waypointIndex = 0;
  runtime.desiredHeading = null;
  runtime.desiredSpeed = 0;
  runtime.arrived = false;
  runtime.orderComplete = false;
  runtime.holdEngaged = false;
  if (!runtime.command) runtime.phase = "idle";
  else if (runtime.command.type === "stop") runtime.phase = "braking";
  else if (runtime.command.type === "move") runtime.phase = "travelling";
  else runtime.phase = "positioned";
  return runtime.command;
}

function nextMovementCommandId(room, prefix = "m") {
  room._nextCommandId = (Number(room._nextCommandId) || 0) + 1;
  return `${prefix}${room._nextCommandId}`;
}

// Manual rotation is independent of the movement order on purpose: holding I or
// O turns the hull while whatever move command is running keeps flying it. It
// is cleared only by releasing the key (or by the owner leaving), never by
// issuing a new destination.
function setManualRotation(ship, direction) {
  ensureMovementRuntime(ship);
  ship.manualRotation = direction === 1 || direction === -1 ? direction : null;
}

// ship.targetX/targetY is the published destination: snapshots ship it to the
// client for order markers and thrust visuals, and the spawn planner reads it
// to avoid handing a slot to a hull already flying at it.
function syncMovementTarget(ship) {
  const runtime = ensureMovementRuntime(ship);
  const destination = runtime.destination;
  ship.targetX = destination ? destination.x : (Number(ship.x) || 0);
  ship.targetY = destination ? destination.y : (Number(ship.y) || 0);
}

module.exports = {
  createMovementRuntime,
  ensureMovementRuntime,
  nextMovementCommandId,
  setManualRotation,
  setMovementCommand,
  syncMovementTarget
};
