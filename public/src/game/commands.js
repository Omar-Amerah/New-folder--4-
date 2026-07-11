// Directs selected fleets to relocate or lock weapons onto hostile targets.

import { dom } from "../ui/dom.js";
import { state } from "../state.js";
import { send } from "../network.js";
import { minimapWorldAt, screenToWorld } from "./camera.js";
import { findShipAt, pruneSelection, ownLiveShips } from "./selection.js";
import { playerMap } from "../ui/scoreboardUi.js";
import { formationForCommand } from "../ui/sidePanelUi.js";

export function issueCommand(event) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  if (state.phase !== "active") return;
  const mini = minimapWorldAt(event.clientX, event.clientY);
  const world = mini || screenToWorld(event.clientX, event.clientY);
  const targetShip = findShipAt(world.x, world.y, (ship) => ship.ownerId !== state.myId && ship.alive);
  const targetPlayer = targetShip ? playerMap().get(targetShip.ownerId) : null;
  const shipIds = selectedShipIdsForCommand();

  state.command = {
    x: targetShip?.x || world.x,
    y: targetShip?.y || world.y,
    targetName: targetPlayer?.name || null,
    at: performance.now()
  };

  send({
    type: "command",
    x: targetShip?.x || world.x,
    y: targetShip?.y || world.y,
    targetId: targetShip?.id || null,
    shipIds,
    formation: formationForCommand()
  });
  showCommandMarker(event.clientX, event.clientY);
}

// Scuttle the currently selected ships. Requires an explicit selection so a
// stray keypress can never destroy the whole fleet.
export function destructSelectedShips() {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  if (state.phase !== "active") return;
  pruneSelection();
  const shipIds = [...state.selectedShipIds];
  if (shipIds.length === 0) return;
  send({ type: "destruct", shipIds });
}

export function selectedShipIdsForCommand() {
  pruneSelection();
  if (state.selectedShipIds.size > 0) return [...state.selectedShipIds];
  return ownLiveShips().map((ship) => ship.id);
}

export function showCommandMarker(clientX, clientY) {
  const rect = dom.canvas.getBoundingClientRect();
  dom.marker.hidden = false;
  dom.marker.style.left = `${clientX - rect.left}px`;
  dom.marker.style.top = `${clientY - rect.top}px`;
  dom.marker.style.animation = "none";
  dom.marker.offsetHeight; // Trigger reflow
  dom.marker.style.animation = "";
}
