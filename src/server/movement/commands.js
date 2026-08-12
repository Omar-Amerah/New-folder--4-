"use strict";

const { fastHypot } = require("../utils");
const { gameplayNow } = require("../gameplayTime");
const { areEntityAllies, areEntityEnemies } = require("../relationships");
const { selectOwnedLivingShips } = require("../selection");
const { canTeamTargetEntity } = require("../visibility");
const { ARRIVE_DISTANCE } = require("../movementTuning");
const { physicalCollisionRadius } = require("../movementCollision");
const {
  ensureMovementRuntime,
  nextMovementCommandId,
  setManualRotation,
  setMovementCommand,
  syncMovementTarget
} = require("../movementRuntimeV2");
const {
  sanitizeMovementToggles,
  sanitizeOrbitDirection
} = require("../validation");
const {
  FORMATION_TYPES,
  SUPPORTED_MOVEMENT_TYPES,
  sanitizeFormationType
} = require("../movementFlags");
const { planFormation } = require("../movementFormations");
const {
  currentFiringLineClear,
  engagementGeometry,
  engagementRanges
} = require("./engagement");
const {
  clearTargetReferences,
  combatStance,
  trackedEntity
} = require("./intent");
const { waypointCaptureRadius } = require("./navigation");
const { clearOrbitSteering } = require("./orbit");
const { clearKiteSteering } = require("./kite");

const BEARING_MIN_DISTANCE = 1;
// How many move orders may be stacked behind the one a single ship is flying.
// A cap rather than a design limit: the queue costs nothing to hold, but it is
// player input arriving over the wire and it does not get to grow without end.
const MAX_QUEUED_WAYPOINTS = 16;

function sharedArrivalRadius(ships) {
  const living = (ships || []).filter((ship) => ship?.alive !== false);
  if (living.length <= 1) return ARRIVE_DISTANCE;
  let largest = 0;
  let sumSquares = 0;
  for (const ship of living) {
    const radius = physicalCollisionRadius(ship);
    largest = Math.max(largest, radius);
    sumSquares += radius * radius;
  }
  return Math.max(largest * 1.5, Math.sqrt(sumSquares) * 1.2);
}

function issueMove(ship, commandId, destination, options = {}) {
  clearTargetReferences(ship);
  ship.commandMode = "move";
  setMovementCommand(ship, {
    id: `${commandId}:${ship.id}`,
    type: "move",
    destination: { x: destination.x, y: destination.y },
    formation: options.formation,
    arrivalRadius: options.arrivalRadius,
    finalFacing: options.finalFacing,
    manual: options.manual
  });
  syncMovementTarget(ship);
}

// Hand a single ship the next leg of the course it was given, as soon as it is
// done with the one it is flying.
//
// "Done" for a mid-course leg is REACHING the point, not stopping on it. A ship
// that had to settle at every waypoint before being told about the next one
// would brake, park, turn and accelerate at each corner, which is a course flown
// as a series of separate journeys. So the leg is handed over on capture -- the
// same radius the route planner treats its own waypoints as reached at -- and
// planMovement declines to brake for a point it knows is a corner. The hull
// carries its speed through and turns onto the next leg.
//
// The other two ways a leg finishes are still honoured: the ordinary arrival
// latch, for a ship that did come to rest on the point, and a leg whose route
// could not reach it -- but only once the ship has flown out the partial route
// and stopped on its end, which is what `arrived` distinguishes. Advancing on
// `blocked` alone would drain the whole course in one tick every time a route
// was momentarily unroutable.
function advanceQueuedWaypoint(room, ship, runtime) {
  const queue = runtime.queuedWaypoints;
  if (!Array.isArray(queue) || queue.length === 0) return false;
  // Anything that is not the move this queue was built behind has taken the
  // helm -- an attack order, a stop, a rally. The course is not resumed after it.
  if (runtime.command?.type !== "move") {
    runtime.queuedWaypoints = [];
    return false;
  }
  const destination = runtime.destination;
  const captured = destination
    && fastHypot(destination.x - ship.x, destination.y - ship.y)
      <= Math.max(waypointCaptureRadius(ship), Number(runtime.arrivalRadius) || ARRIVE_DISTANCE);
  if (!captured && !runtime.orderComplete && !(runtime.blocked && runtime.arrived)) return false;
  const next = queue[0];
  // setMovementCommand clears the queue, as it must for every other caller, so
  // the remainder is carried across the call by hand.
  const remaining = queue.slice(1);
  issueMove(ship, nextMovementCommandId(room, "m"), next, {
    arrivalRadius: ARRIVE_DISTANCE,
    manual: true
  });
  runtime.queuedWaypoints = remaining;
  return true;
}

function issueStop(ship, commandId, manual = true) {
  setMovementCommand(ship, { id: `${commandId}:${ship.id}`, type: "stop", manual });
  syncMovementTarget(ship);
}

function issueAttack(room, ship, commandId, targetId, now, lane = null) {
  const target = trackedEntity(room, targetId);
  const viewerTeam = room?.players?.get?.(ship.ownerId)?.team ?? ship.team ?? ship.ownerId;
  clearTargetReferences(ship);
  if (target && room && !canTeamTargetEntity(room, viewerTeam, target, now)) return false;
  ship.combatTargetId = targetId;
  ship.focusTargetId = targetId;
  const id = `${commandId}:${ship.id}`;
  setMovementCommand(ship, {
    id,
    type: "attack",
    targetId,
    manual: true
  });
  const runtime = ensureMovementRuntime(ship);
  runtime.arrivalRadius = ARRIVE_DISTANCE;
  if (lane) {
    runtime.attackLane = {
      targetId: String(targetId),
      commandId: id,
      forwardX: lane.forwardX,
      forwardY: lane.forwardY,
      lateralOffset: lane.lateralOffset
    };
  }
  // A ship that can already shoot stops here and does it. This is the first
  // thing the order does, before anything about where it might have gone.
  // The travelling stances are excluded with Charge: none of them has a position
  // to latch, and none may ever acquire holdEngaged, which is what would park
  // it. A Kite ship in particular is often given the order while already inside
  // the range it is about to run out of.
  const stance = combatStance(ship);
  if (target && stance !== "charge" && stance !== "orbit" && stance !== "kite") {
    const distance = engagementGeometry(ship, target).distance;
    if (distance <= engagementRanges(ship, target, "attack").enter
      && currentFiringLineClear(room, ship, target)) {
      runtime.holdEngaged = true;
      runtime.attackLane = null;
    }
  }
  syncMovementTarget(ship);
  return true;
}

// The whole of what a Hold attack order plans: which way the fleet is closing,
// and how far off that line each ship already sits. No shape, no slots, no
// distance worked out from anyone's weapon range -- every ship stops at the
// first place IT can fire from, which is a per-ship question answered per tick.
//
// Only Hold takes a lane. Charge is pursuing contact and Static/Sentry never
// leave where they are.
function planAttackLanes(ships, target) {
  const lanes = new Map();
  const holders = (ships || []).filter((ship) => combatStance(ship) === "hold");
  if (!holders.length || !target) return lanes;
  let sumX = 0;
  let sumY = 0;
  for (const ship of holders) {
    sumX += Number(ship.x) || 0;
    sumY += Number(ship.y) || 0;
  }
  const centreX = sumX / holders.length;
  const centreY = sumY / holders.length;
  const forwardX = (Number(target.x) || 0) - centreX;
  const forwardY = (Number(target.y) || 0) - centreY;
  const length = fastHypot(forwardX, forwardY);
  // The fleet is standing on its target. There is no advance to spread out, and
  // everyone is inside their own range anyway.
  if (!(length > BEARING_MIN_DISTANCE)) return lanes;
  const unitX = forwardX / length;
  const unitY = forwardY / length;
  const lateralX = -unitY;
  const lateralY = unitX;
  for (const ship of holders) {
    lanes.set(ship.id, {
      forwardX: unitX,
      forwardY: unitY,
      lateralOffset: ((Number(ship.x) || 0) - centreX) * lateralX
        + ((Number(ship.y) || 0) - centreY) * lateralY
    });
  }
  return lanes;
}

function issueRepair(ship, commandId, targetId) {
  clearTargetReferences(ship);
  ship.repairTargetId = targetId;
  setMovementCommand(ship, { id: `${commandId}:${ship.id}`, type: "repair", targetId, manual: true });
  syncMovementTarget(ship);
}

// Where a lone ship is actually sent for a click at (x, y). The formation
// planner is reused for one ship deliberately: with a single slot it is exactly
// "clamp to the world, then walk off anything solid", and borrowing it is what
// keeps a solo move and a one-ship-wide fleet move landing on the same point.
// The plan comes back with the point because commandShips returns it either way
// -- the planned bearing is part of what a caller is told about a move order.
function soloMovePlan(room, ship, x, y) {
  const plan = planFormation(room, [ship], { x, y });
  const slot = plan.slots[0];
  return { plan, point: slot ? { x: slot.x, y: slot.y } : { x, y } };
}

function commandShips(room, player, x, y, options = {}) {
  const selected = selectOwnedLivingShips(player, options.shipIds);
  if (!selected.ok) return { ok: false, code: selected.code, commanded: 0 };
  const ships = selected.ships;
  if (ships.length === 0) return { ok: true, code: "none", commanded: 0 };

  const clicked = options.targetId == null
    ? null
    : (room.ships?.get(String(options.targetId)) || room.stationsById?.get(String(options.targetId)));
  const livingTarget = clicked?.alive ? clicked : null;
  const selectedIds = new Set(ships.map((ship) => ship.id));
  const enemy = livingTarget && areEntityEnemies(room, player?.id, livingTarget);
  const ally = livingTarget
    && !selectedIds.has(livingTarget.id)
    && areEntityAllies(room, player?.id, livingTarget);
  const commandId = nextMovementCommandId(room, enemy ? "a" : (ally ? "r" : "m"));

  if (enemy) {
    const now = gameplayNow(room);
    const lanes = planAttackLanes(ships, livingTarget);
    for (const ship of ships) {
      issueAttack(room, ship, commandId, livingTarget.id, now, lanes.get(ship.id) || null);
    }
    return { ok: true, code: "attack", commanded: ships.length };
  }
  if (ally) {
    for (const ship of ships) issueRepair(ship, commandId, livingTarget.id);
    return { ok: true, code: "repair", commanded: ships.length };
  }

  // One ship, on its own, is steered rather than arranged. It goes to the point
  // that was clicked -- walked clear of geometry, but with no formation slot and
  // no formation record on the order -- and it is the only case that may carry a
  // queue of further legs behind it. A course is drawn for a hull; there is
  // nothing a list of points means to a fleet that a fleet could fly.
  if (ships.length === 1) {
    const ship = ships[0];
    const { plan, point } = soloMovePlan(room, ship, x, y);
    const runtime = ensureMovementRuntime(ship);
    const queue = Array.isArray(runtime.queuedWaypoints) ? runtime.queuedWaypoints : [];
    // Appending only ever extends a move already in progress. With the ship
    // parked, fighting, or under any other order, the first shift-click is the
    // start of a new course rather than a leg added to a finished one.
    const extending = options.append === true
      && runtime.command?.type === "move"
      && runtime.command.manual
      && !runtime.orderComplete;
    if (extending) {
      if (queue.length >= MAX_QUEUED_WAYPOINTS) {
        return { ok: true, code: "queue-full", commanded: 0, queued: queue.length };
      }
      queue.push(point);
      runtime.queuedWaypoints = queue;
      return { ok: true, code: "queued", commanded: 1, queued: queue.length };
    }
    issueMove(ship, commandId, point, {
      arrivalRadius: ARRIVE_DISTANCE,
      finalFacing: Number.isFinite(options.finalFacing) ? options.finalFacing : null,
      manual: true
    });
    return { ok: true, code: "move", commanded: 1, queued: 0, formation: plan.formation, plan };
  }

  // An ordinary move order is the one place a formation is resolved. Each ship
  // leaves here with its own fixed destination and is on its own from then on:
  // combat orders below never see a slot, and nothing recomputes the shape while
  // the order runs.
  const plan = planFormation(room, ships, {
    x,
    y,
    formation: options.formation,
    direction: options.direction
  });
  for (const slot of plan.slots) {
    issueMove(slot.ship, commandId, { x: slot.x, y: slot.y }, {
      // Every ship has its own slot, so the shared crowding envelope that a
      // single stacked destination needed would only stop ships short of it.
      arrivalRadius: ARRIVE_DISTANCE,
      // Only a heading the player actually asked for. Defaulting this to the
      // formation's planned direction turned every ordinary move into a
      // move-and-then-face order, and the planned direction is the bearing from
      // where the fleet STARTED -- so a ship that detoured, was pushed off line,
      // or braked round a corner arrived and then rotated onto a course it was
      // no longer flying. With this null the hull keeps the heading it arrived
      // on, which for a formation travelling together is the shape's direction
      // anyway, without forcing it back when it isn't.
      finalFacing: Number.isFinite(options.finalFacing) ? options.finalFacing : null,
      manual: true,
      formation: {
        type: plan.formation,
        centreX: plan.x,
        centreY: plan.y,
        direction: plan.direction,
        offsetX: slot.offsetX,
        offsetY: slot.offsetY,
        adjusted: slot.adjusted
      }
    });
  }
  return {
    ok: true,
    code: "move",
    commanded: plan.slots.length,
    formation: plan.formation,
    plan
  };
}

function commandShipsToDestination(room, ships, destination, options = {}) {
  const commandId = nextMovementCommandId(room, options.prefix || "m");
  const living = (ships || []).filter((ship) => ship?.alive);
  if (!living.length || !destination) return 0;
  const arrivalRadius = sharedArrivalRadius(living);
  for (const ship of living) {
    issueMove(ship, commandId, destination, {
      arrivalRadius,
      finalFacing: options.finalFacing,
      manual: false
    });
  }
  return living.length;
}

function stopShips(room, player, shipIds) {
  const selected = selectOwnedLivingShips(player, shipIds);
  if (!selected.ok) return { ok: false, code: selected.code, commanded: 0 };
  const commandId = nextMovementCommandId(room, "s");
  for (const ship of selected.ships) issueStop(ship, commandId);
  return { ok: true, code: "stop", commanded: selected.ships.length };
}

function rotateShips(room, player, options) {
  const selected = selectOwnedLivingShips(player, options?.shipIds);
  if (!selected.ok) return { ok: false, code: selected.code, commanded: 0 };
  const direction = options?.direction;
  const active = options?.active;
  for (const ship of selected.ships) setManualRotation(ship, active ? direction : null);
  return { ok: true, code: "rotate", commanded: selected.ships.length };
}

function applyCombatStyle(ship, combatStyle, orbitDirection) {
  ship.combatStyle = combatStyle;
  ship.combatStyleRaw = combatStyle;
  const runtime = ensureMovementRuntime(ship);
  runtime.holdFacing = null;
  runtime.holdCoverageRange = 0;
  runtime.holdEngaged = false;
  runtime.chargeEngaged = false;
  runtime.ramming = false;
  clearOrbitSteering(runtime);
  // The stance itself has changed, so every route-specific tactical decision the
  // old one had made is retired: the Hold latch and facing above, the Charge
  // contact, the Orbit steering, and Kite's band, heading, escape side and speed
  // ceiling. The target and the attack order are deliberately untouched -- a
  // stance change must not cost a ship the fight it is in.
  clearKiteSteering(runtime);
  runtime.orbitReversing = false;
  // The direction survives the stance. Switching to Hold and back to Orbit
  // restores the way round this ship was already going; an explicit direction on
  // the message is what changes it. A ship that has never orbited gets
  // clockwise, so selecting Orbit always has an answer.
  ship.orbitDirection = orbitDirection === undefined
    ? sanitizeOrbitDirection(ship.orbitDirection)
    : sanitizeOrbitDirection(orbitDirection, ship.orbitDirection);
  runtime.orbitDirection = ship.orbitDirection;
}

// Change which way round a ship orbits, and NOTHING else.
//
// This is deliberately not applyCombatStyle with a different argument. That one
// retires the Hold facing decision, drops the Hold and Charge latches and clears
// the ramming state, all of which are correct when the stance itself changes and
// all of which are wrong here: the ship is already fighting this target, and a
// direction toggle must not cost it its target, its firing solution, its weapon
// tracking or its place in the fight. The only things that stop being true are
// the way round and the steering that was following it.
function applyOrbitDirection(ship, orbitDirection) {
  const runtime = ensureMovementRuntime(ship);
  const next = sanitizeOrbitDirection(orbitDirection, ship.orbitDirection);
  if (sanitizeOrbitDirection(ship.orbitDirection) === next) {
    // Still worth writing through: a ship whose stored direction was absent or
    // malformed has just been given the canonical one.
    ship.orbitDirection = next;
    runtime.orbitDirection = next;
    return false;
  }
  ship.orbitDirection = next;
  runtime.orbitDirection = next;
  // Reverse under power rather than by flipping the velocity. planOrbit brakes
  // the old tangential motion and turns onto the new tangent while it does.
  runtime.orbitReversing = true;
  // Only the orbit steering is invalidated. A committed avoidance manoeuvre was
  // planned to rejoin the circle going the other way, so its rejoin point is no
  // longer on the path this ship will fly; planOrbit re-detects and re-commits
  // in the new direction on the next tick. The attack command, the target and
  // the ship's weapon state are all untouched.
  runtime.orbitAvoidance = null;
  // ...and the new direction is swept for immediately rather than at the next
  // scheduled scan, because the path ahead is a different path now.
  runtime.orbitScanAt = 0;
  runtime.orbitSpeedLimit = 0;
  return true;
}

function applyMovementToggles(ship, toggles) {
  ship.movementToggles = sanitizeMovementToggles(toggles, ship.movementToggles);
  return ship.movementToggles;
}

module.exports = {
  FORMATION_TYPES,
  MAX_QUEUED_WAYPOINTS,
  SUPPORTED_MOVEMENT_TYPES,
  advanceQueuedWaypoint,
  applyCombatStyle,
  applyMovementToggles,
  applyOrbitDirection,
  commandShips,
  commandShipsToDestination,
  planFormation,
  rotateShips,
  sanitizeFormationType,
  sharedArrivalRadius,
  stopShips
};

