"use strict";

// Per-ship movement state for the rewritten controller.
//
// One order, one destination, one phase. Everything the autopilot needs to fly
// the ship this tick is here. Charge positioning adds one deliberate exception:
// a target-relative contact slot is cached until the target/group/route genuinely
// changes. Hold only caches its stable weapon-facing decision while stationary.
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
    // The requested point cannot currently be reached. This is a stable state,
    // not travelling at zero speed; route/world changes clear it.
    blocked: false,
    // Cached LOS-valid combat destination (or a short-lived failed search), so
    // an occluded target does not run a ring of path searches every tick.
    firingSolution: null,
    // On a ramming run: a Charge ship carrying a live demolition charge, closing
    // on the target it will detonate against. Recomputed every tick, never
    // latched -- see updateShipMovement.
    ramming: false,
    // Stable target-relative combat positioning. Slot assignment is replaced
    // only when the target/group changes or the static route proves it blocked.
    combatSlot: null,
    // Stable Hold facing. This is a hull orientation, never a translation slot;
    // cooldown is intentionally not part of the cached decision.
    holdFacing: null,
    // Stable pre-engagement Hold lane. It is an approach hint only; once Hold
    // latches, the ship keeps its world position instead of returning to this
    // lane point.
    holdApproach: null,
    // A short-lived static-obstacle contact decision. Collision resolution owns
    // the normal and lifetime; steering owns the committed tangent side.
    slide: null,
    // One deterministic local-traffic decision for the current encounter.
    // This is route control, not a second movement command.
    traffic: {
      mode: "clear",
      blockerId: null,
      pairKey: null,
      side: 0,
      bypass: null,
      priorityId: null,
      crossing: false,
      blockedAt: null
    }
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
  if (!Object.prototype.hasOwnProperty.call(runtime, "slide")) runtime.slide = null;
  if (!Object.prototype.hasOwnProperty.call(runtime, "route")) runtime.route = null;
  if (!Object.prototype.hasOwnProperty.call(runtime, "combatSlot")) runtime.combatSlot = null;
  if (!Object.prototype.hasOwnProperty.call(runtime, "holdFacing")) runtime.holdFacing = null;
  if (!Object.prototype.hasOwnProperty.call(runtime, "holdApproach")) runtime.holdApproach = null;
  return runtime;
}

// `manual` marks an order the player issued directly. Internal rally moves
// (station launch, formation assignment) leave it false so a freshly built ship
// can still be re-tasked by its owner's next click without special-casing.
//
// `formationHeading` is retained only as a final resting-facing preference for
// multi-ship move orders. Travelling ships steer from their own route waypoint.
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
      finalFacing: Number.isFinite(command.finalFacing) ? Number(command.finalFacing) : null,
      manual: Boolean(command.manual)
    }
    : null;
  runtime.destination = runtime.command?.type === "move"
    ? runtime.command.destination
    : null;
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
  runtime.combatSlot = null;
  runtime.holdFacing = null;
  runtime.holdApproach = null;
  runtime.slide = null;
  runtime.traffic = {
    mode: "clear",
    blockerId: null,
    pairKey: null,
    side: 0,
    bypass: null,
    priorityId: null,
    crossing: false,
    blockedAt: null
  };
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
