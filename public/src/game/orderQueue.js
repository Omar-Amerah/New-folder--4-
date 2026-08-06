// Courses drawn for a single ship: the move order it is flying, plus the ones
// shift-clicked behind it.
//
// The queue itself is the server's -- it is what actually hands a ship its next
// leg. This is the client's record of what it asked for, kept so the course can
// be drawn without publishing every player's pending orders to everyone in the
// match. It is deliberately its own module, depending on nothing but `state`,
// because both the command path that fills it and the renderer that draws it
// need it, and those two sit on opposite sides of the module graph.

import { state } from "../state.js";

// The server's cap, restated so the client stops drawing points it knows will be
// refused rather than showing a course the ship will not fly.
export const MAX_QUEUED_WAYPOINTS = 16;

// How far a ship's published destination may sit from a recorded leg and still
// be that leg. The server walks a clicked point clear of geometry before it
// flies to it, so the two are near enough but rarely equal.
const ORDER_QUEUE_MATCH_DISTANCE = 96;

// Close enough to the last point, with nothing behind it, that the course is
// done and should stop being drawn. The destination stays published after
// arrival, so nothing else would ever retire it.
const ORDER_QUEUE_ARRIVED_DISTANCE = 40;

// Add a leg to the course drawn for a ship, or start a new one. The first entry
// is always the leg being flown now, so the whole list is the path from the ship
// onwards. `append` false replaces the course outright, which is what an
// unmodified click means.
export function recordOrderQueue(shipId, point, append) {
  const existing = append ? state.orderQueues.get(shipId) : null;
  if (!existing) {
    state.orderQueues.set(shipId, [point]);
    return;
  }
  if (existing.length >= MAX_QUEUED_WAYPOINTS + 1) return;
  existing.push(point);
}

// Any order that is not a queued move ends the course: an attack, a stop, a
// group move, a scuttle. The server drops its own queue on all of the same
// events -- setMovementCommand does it for every order that is not the queue
// advancing itself -- so this keeps the drawing honest rather than deciding
// anything.
export function clearOrderQueues(shipIds) {
  if (!shipIds) {
    state.orderQueues.clear();
    return;
  }
  for (const shipId of shipIds) state.orderQueues.delete(shipId);
}

// Drop courses belonging to ships that are gone, so the map cannot accumulate
// one entry per hull lost over a long match.
export function pruneOrderQueues(liveShipIds) {
  for (const shipId of state.orderQueues.keys()) {
    if (!liveShipIds.has(shipId)) state.orderQueues.delete(shipId);
  }
}

// The part of a ship's drawn course it has not flown yet: the leg it is on, then
// everything queued behind it. Null when this ship has no course, or when what
// it is doing no longer matches the one recorded -- a new order from another
// client, a rally move, an auto-engage.
export function orderQueuePath(ship) {
  const queue = ship ? state.orderQueues.get(ship.id) : null;
  if (!queue || queue.length === 0) return null;
  const targetX = Number(ship.targetX);
  const targetY = Number(ship.targetY);
  if (!ship.alive || !Number.isFinite(targetX) || !Number.isFinite(targetY)) {
    state.orderQueues.delete(ship.id);
    return null;
  }
  const flying = queue.findIndex((point) =>
    Math.hypot(point.x - targetX, point.y - targetY) <= ORDER_QUEUE_MATCH_DISTANCE);
  if (flying < 0) {
    state.orderQueues.delete(ship.id);
    return null;
  }
  // Everything before the leg being flown has been reached and is no longer part
  // of the path ahead.
  if (flying > 0) queue.splice(0, flying);
  if (queue.length === 1
    && Math.hypot(queue[0].x - ship.x, queue[0].y - ship.y) <= ORDER_QUEUE_ARRIVED_DISTANCE) {
    state.orderQueues.delete(ship.id);
    return null;
  }
  return queue;
}
