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

const { FORMATION_TYPES, SUPPORTED_MOVEMENT_TYPES } = require("./movementFlags");

const MOVEMENT_TYPES = new Set(SUPPORTED_MOVEMENT_TYPES);
const FORMATION_TYPE_SET = new Set(FORMATION_TYPES);

function finitePoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y)
    ? { x: Number(point.x), y: Number(point.y) }
    : null;
}

// What shape this ship's destination came out of, recorded on the order for
// debugging and for the client's order marker. It is a record of a decision
// already taken: the destination above is the whole of the instruction, and
// nothing reads these fields back to steer.
function finiteFormation(formation) {
  if (!formation || typeof formation !== "object") return null;
  const type = String(formation.type || "");
  if (!FORMATION_TYPE_SET.has(type)) return null;
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  return {
    type,
    centreX: number(formation.centreX),
    centreY: number(formation.centreY),
    direction: number(formation.direction),
    offsetX: number(formation.offsetX),
    offsetY: number(formation.offsetY),
    adjusted: Boolean(formation.adjusted)
  };
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
    // Which way this ship is closing on the target of a Hold attack order, and
    // how far to the side of the group it was when the order was given. It only
    // spreads the advance so the fleet does not funnel onto one point; nothing
    // waits for it, and it is dropped the moment the ship can fire.
    attackLane: null,
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
    // Range the guns asked to stop at, when that is closer than the hull-centre
    // range gate would have stopped at. Zero means the gate's own answer stands.
    holdCoverageRange: 0,
    // --- Orbit ---
    // Which way this ship is currently flying its circle. Mirrored from
    // ship.orbitDirection, which is the authoritative, persistent copy: this one
    // is what the steering reads, and what a reversal is measured against.
    orbitDirection: 1,
    // Shedding the old tangential speed after a direction toggle. A reversal is
    // a physical turnaround, not a sign flip on the velocity.
    orbitReversing: false,
    // Ceiling the orbit controller put on this tick's speed -- the turn-rate
    // limit for the radius being flown, or the reversal brake. Zero and below
    // mean "no orbit limit"; it is recomputed every tick and never latched.
    orbitSpeedLimit: 0,
    // Steering straight at the orbit aim point, with no obstacle in the way.
    // The aim point is a bearing rather than a place, so while this is set the
    // ordinary arrival and route limits do not apply to it.
    orbitDirect: false,
    // A static-obstacle detour around something sitting on the direct line to
    // the aim point. Anchored on the orbit circle and re-planned on a cadence,
    // because the aim point itself moves every tick.
    orbitDetour: null,
  };
}

function ensureMovementRuntime(ship) {
  const runtime = ship.movement;
  // A ship loaded without a movement runtime starts with the canonical state
  // shape rather than carrying a partially initialized object.
  if (!runtime || typeof runtime !== "object" || !Array.isArray(runtime.path)) {
    ship.movement = createMovementRuntime();
    // The ship may already have been told which way it orbits -- it is carried
    // on the hull, not here -- so the fresh runtime picks that up rather than
    // publishing the default over it.
    ship.movement.orbitDirection = Number(ship.orbitDirection) === -1 ? -1 : 1;
    return ship.movement;
  }
  if (!Object.prototype.hasOwnProperty.call(runtime, "arrivalRadius")) runtime.arrivalRadius = 16;
  if (!Object.prototype.hasOwnProperty.call(runtime, "route")) runtime.route = null;
  if (!Object.prototype.hasOwnProperty.call(runtime, "holdFacing")) runtime.holdFacing = null;
  if (!Object.prototype.hasOwnProperty.call(runtime, "holdCoverageRange")) runtime.holdCoverageRange = 0;
  if (!Object.prototype.hasOwnProperty.call(runtime, "attackLane")) runtime.attackLane = null;
  if (!Object.prototype.hasOwnProperty.call(runtime, "orbitDirection")) {
    runtime.orbitDirection = Number(ship.orbitDirection) === -1 ? -1 : 1;
  }
  if (!Object.prototype.hasOwnProperty.call(runtime, "orbitReversing")) runtime.orbitReversing = false;
  if (!Object.prototype.hasOwnProperty.call(runtime, "orbitSpeedLimit")) runtime.orbitSpeedLimit = 0;
  if (!Object.prototype.hasOwnProperty.call(runtime, "orbitDirect")) runtime.orbitDirect = false;
  if (!Object.prototype.hasOwnProperty.call(runtime, "orbitDetour")) runtime.orbitDetour = null;
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
      formation: command.type === "move" ? finiteFormation(command.formation) : null,
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
  runtime.holdCoverageRange = 0;
  // Orbit STEERING is retired with the order; the orbit DIRECTION is not. Which
  // way round a ship goes is a standing property of the ship, and re-targeting
  // must not silently put it back to clockwise.
  runtime.orbitReversing = false;
  runtime.orbitSpeedLimit = 0;
  runtime.orbitDirect = false;
  runtime.orbitDetour = null;
  // A new order always retires the previous order's approach lane. The command
  // that issued this one hands out a new one if it planned any.
  runtime.attackLane = null;
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
