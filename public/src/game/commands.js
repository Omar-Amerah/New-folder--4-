// Directs selected fleets to relocate or lock weapons onto hostile targets.

import { dom } from "../ui/dom.js";
import { state } from "../state.js";
import { send } from "../network.js";
import { minimapWorldAt, screenToWorld } from "./camera.js";
import { findShipAt, findStationAt, pruneSelection, ownLiveShips } from "./selection.js";
import { playerMap } from "../ui/matchStatusUi.js";
import { clearOrderQueues, recordOrderQueue } from "./orderQueue.js";
import { invalidatePresentation } from "../presentationInvalidation.js";

const latchedRotationShipIds = new Map();

export function commandTargetAt(world, shipIds) {
  // Allied ships are only valid click targets when the commanded fleet carries a
  // repair beam; otherwise a click on a friendly is a plain move order.
  const commandedSet = new Set(shipIds);
  const fleetHasRepairBeam = (state.snapshot?.ships || []).some((ship) =>
    commandedSet.has(ship.id) && (ship.design || []).some((module) => module.type === "repairBeam"));
  const players = playerMap();
  const myTeam = players.get(state.myId)?.team;
  const isAllied = (entity) => entity.ownerId === state.myId
    || Boolean(myTeam && (entity.team || players.get(entity.ownerId)?.team) === myTeam);
  const targetShip = findShipAt(world.x, world.y, (ship) => ship.alive && (!isAllied(ship) || fleetHasRepairBeam));
  if (targetShip) {
    const targetPlayer = players.get(targetShip.ownerId);
    return {
      entity: targetShip,
      kind: isAllied(targetShip) ? "friendly" : "hostile",
      name: targetPlayer?.name || null
    };
  }

  // Stations are inspection targets on left-click, but a hostile controlled
  // station is a combat target on right-click. Neutral relays and allied
  // stations remain ground-move destinations.
  const station = findStationAt(world.x, world.y);
  const controlled = station && station.state !== "neutral";
  const hostile = controlled && !isAllied(station) && Boolean(station.team || station.ownerId);
  return hostile
    ? { entity: station, kind: "hostile", name: station.stationType === "relay" ? "Relay Station" : "Home Station" }
    : { entity: null, kind: "move", name: null };
}

export function issueCommand(event) {
  if (event?.currentTarget && event.target !== event.currentTarget) return;
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  if (state.phase !== "active") return;
  const mini = minimapWorldAt(event.clientX, event.clientY);
  const world = mini || screenToWorld(event.clientX, event.clientY);
  const shipIds = selectedShipIdsForCommand();
  const target = commandTargetAt(world, shipIds);
  const targetEntity = target.entity;
  // A course belongs to one hull. With more than one ship commanded the click
  // is an ordinary fleet order and nothing is queued, exactly as before.
  const append = Boolean(event?.shiftKey) && shipIds.length === 1 && !targetEntity;
  if (shipIds.length === 1 && !targetEntity) {
    recordOrderQueue(shipIds[0], { x: world.x, y: world.y }, append);
  } else {
    clearOrderQueues(shipIds);
  }

  state.command = {
    x: targetEntity?.x || world.x,
    y: targetEntity?.y || world.y,
    targetName: target.name,
    targetKind: target.kind,
    at: performance.now()
  };
  invalidatePresentation("command");

  send({
    type: "command",
    x: targetEntity?.x || world.x,
    y: targetEntity?.y || world.y,
    targetId: targetEntity?.id || null,
    shipIds,
    append
  });
  showCommandMarker(event.clientX, event.clientY, target.kind);
}

// Scuttle the currently selected ships. Requires an explicit selection so a
// stray keypress can never destroy the whole fleet.
export function destructSelectedShips() {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false;
  if (state.phase !== "active") return false;
  pruneSelection();
  const shipIds = [...state.selectedShipIds];
  if (shipIds.length === 0) return false;
  if (!send({ type: "destruct", shipIds })) return false;
  clearOrderQueues(shipIds);
  return true;
}

export function stopSelectedShips() {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false;
  if (state.phase !== "active") return false;
  pruneSelection();
  const shipIds = [...state.selectedShipIds];
  if (shipIds.length === 0) return false;
  if (!send({ type: "stop", shipIds })) return false;
  clearOrderQueues(shipIds);
  return true;
}

export function selectedShipIdsForCommand() {
  pruneSelection();
  if (state.selectedShipIds.size > 0) return [...state.selectedShipIds];
  return ownLiveShips().map((ship) => ship.id);
}

export function rotateSelectedShips(direction, active = true) {
  if (direction !== 1 && direction !== -1) return false;
  if (!active) {
    const shipIds = [...(latchedRotationShipIds.get(direction) || [])];
    latchedRotationShipIds.delete(direction);
    if (shipIds.length === 0) return false;
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false;
    if (state.phase !== "active") return false;
    return send({ type: "rotate", direction, active: false, shipIds });
  }

  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false;
  if (state.phase !== "active") return false;
  pruneSelection();
  const shipIds = [...state.selectedShipIds];
  if (shipIds.length === 0) return false;

  const oppositeIds = [...(latchedRotationShipIds.get(-direction) || [])];
  if (oppositeIds.length > 0
    && !send({ type: "rotate", direction: -direction, active: false, shipIds: oppositeIds })) {
    return false;
  }
  latchedRotationShipIds.delete(-direction);
  if (!send({ type: "rotate", direction, active: true, shipIds })) return false;
  latchedRotationShipIds.set(direction, new Set(shipIds));
  return true;
}

export function releaseAllRotatingShips() {
  const releases = [...latchedRotationShipIds.entries()]
    .map(([direction, shipIds]) => ({ direction, shipIds: [...shipIds] }))
    .filter((release) => release.shipIds.length > 0);
  latchedRotationShipIds.clear();
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false;
  if (state.phase !== "active") return false;
  let released = false;
  for (const release of releases) {
    released = send({
      type: "rotate",
      direction: release.direction,
      active: false,
      shipIds: release.shipIds
    }) || released;
  }
  return released;
}

export function showCommandMarker(clientX, clientY, kind = "move") {
  const rect = dom.canvas.getBoundingClientRect();
  dom.marker.hidden = false;
  dom.marker.style.left = `${clientX - rect.left}px`;
  dom.marker.style.top = `${clientY - rect.top}px`;
  dom.marker.classList.remove("friendly", "hostile", "move");
  dom.marker.classList.add(kind);
  dom.marker.style.animation = "none";
  dom.marker.offsetHeight; // Trigger reflow
  dom.marker.style.animation = "";
}
