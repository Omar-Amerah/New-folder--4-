"use strict";

// Per-ship movement state for the rewritten controller.
//
// One order, one destination, one phase. Everything the autopilot needs to fly
// the ship this tick is here. Combat positioning is deliberately not shared
// between ships: each hull decides when it can fire or when it has made contact.
//
// `path`, `waypointIndex` and `route` are reserved for the obstacle-avoidance
// phase. A route is one committed A*/geometry/smoothing result, followed until
// the order or the static world genuinely invalidates it.

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
    route: null,
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
    // Charge has made a settled contact. It has its own latch because Hold's
    // wide range hysteresis is not a valid contact controller.
    chargeEngaged: false,
    // Move orders share one arrival envelope, while a lone ship keeps the normal
    // small arrival radius. This is a crowding tolerance, not a destination.
    arrivalRadius: 16,
    // The requested point cannot currently be reached. This is a stable state,
    // not travelling at zero speed; route/world changes clear it.
    blocked: false,
    // Per-ship Hold route cache. This is an individual firing solution, never
    // a shared group position.
    firingSolution: null,
    engageApproach: null,
    // On a ramming run: a Charge ship carrying a live demolition charge, closing
    // on the target it will detonate against. Recomputed every tick, never
    // latched -- see updateShipMovement.
    ramming: false,
    // Stable Hold facing. This is a hull orientation, never a translation slot;
    // cooldown is intentionally not part of the cached decision.
    holdFacing: null,
  };
}

function ensureMovementRuntime(ship) {
  const runtime = ship.movement;
  // A ship loaded without a movement runtime starts with the canonical state
  // shape rather than carrying a partially initialized object.
  if (!runtime || typeof runtime !== "object" || !Array.isArray(runtime.path)) {
    ship.movement = createMovementRuntime();
    return ship.movement;
  }
  if (!Object.prototype.hasOwnProperty.call(runtime, "arrivalRadius")) runtime.arrivalRadius = 16;
  if (!Object.prototype.hasOwnProperty.call(runtime, "route")) runtime.route = null;
  if (!Object.prototype.hasOwnProperty.call(runtime, "holdFacing")) runtime.holdFacing = null;
  return runtime;
}

// `manual` marks an order the player issued directly. Internal rally moves leave
// it false so a freshly built ship can still be re-tasked by its owner's next
// click without special-casing.
function setMovementCommand(ship, command) {
  const runtime = ensureMovementRuntime(ship);
  runtime.command = command && MOVEMENT_TYPES.has(String(command.type))
    ? {
      id: command.id == null ? null : String(command.id),
      type: String(command.type),
      destination: finitePoint(command.destination),
      targetId: command.targetId == null ? null : String(command.targetId),
      finalFacing: Number.isFinite(command.finalFacing) ? Number(command.finalFacing) : null,
      arrivalRadius: Number.isFinite(command.arrivalRadius)
        ? Math.max(16, Number(command.arrivalRadius))
        : 16,
      manual: Boolean(command.manual)
    }
    : null;
  runtime.destination = runtime.command?.type === "move"
    ? runtime.command.destination
    : null;
  runtime.arrivalRadius = runtime.command?.arrivalRadius || 16;
  runtime.path = [];
  runtime.waypointIndex = 0;
  runtime.route = null;
  runtime.desiredHeading = null;
  runtime.desiredSpeed = 0;
  runtime.arrived = false;
  runtime.orderComplete = false;
  runtime.holdEngaged = false;
  runtime.chargeEngaged = false;
  runtime.blocked = false;
  runtime.firingSolution = null;
  runtime.engageApproach = null;
  runtime.holdFacing = null;
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
// client for order markers and thrust visuals; launch placement may use it for
// diagnostics, but it does not assign movement destinations from it.
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
