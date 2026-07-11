// Manages drag box overlays, own live ships, selection lists, and bounds overlap mathematics.

import { ctx } from "../ui/dom.js";
import { state } from "../state.js";
import { updateHud } from "../ui/hudUi.js";

export function selectAt(world, additive) {
  const ship = findShipAt(world.x, world.y, (candidate) => candidate.ownerId === state.myId && candidate.alive);
  state.activeShipGroup = null;
  if (!additive) state.selectedShipIds.clear();
  if (ship) {
    if (state.selectedShipIds.has(ship.id) && additive) state.selectedShipIds.delete(ship.id);
    else state.selectedShipIds.add(ship.id);
    state.camera.follow = true;
  }
}

export function selectBox(a, b, additive) {
  state.activeShipGroup = null;
  if (!additive) state.selectedShipIds.clear();
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  for (const ship of ownLiveShips()) {
    if (ship.x >= minX && ship.x <= maxX && ship.y >= minY && ship.y <= maxY) {
      state.selectedShipIds.add(ship.id);
    }
  }
  if (state.selectedShipIds.size > 0) state.camera.follow = true;
}

export function selectAllOwnShips() {
  state.selectedShipIds = new Set(ownLiveShips().map((ship) => ship.id));
  state.activeShipGroup = null;
  updateHud();
}

export function pruneSelection() {
  const live = new Set(ownLiveShips().map((ship) => ship.id));
  for (const id of [...state.selectedShipIds]) {
    if (!live.has(id)) state.selectedShipIds.delete(id);
  }
  if (state.selectedShipIds.size === 0) state.activeShipGroup = null;
}

export function ownLiveShips() {
  return state.snapshot?.ships?.filter((ship) => ship.ownerId === state.myId && ship.alive) || [];
}

export function findShipAt(x, y, predicate) {
  const ships = state.snapshot?.ships || [];
  let best = null;
  let bestDistance = Infinity;
  for (const ship of ships) {
    if (!predicate(ship)) continue;
    const distance = Math.hypot(ship.x - x, ship.y - y);
    if (distance <= ship.radius + 14 && distance < bestDistance) {
      best = ship;
      bestDistance = distance;
    }
  }
  return best;
}

export function drawSelectionBox() {
  if (!state.drag) return;
  const a = state.drag.startWorld;
  const b = state.drag.currentWorld;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const width = Math.abs(a.x - b.x);
  const height = Math.abs(a.y - b.y);
  if (width < 12 && height < 12) return;
  ctx.save();
  ctx.fillStyle = "rgba(56,213,255,0.08)";
  ctx.strokeStyle = "rgba(56,213,255,0.82)";
  ctx.lineWidth = 2 / state.camera.zoom;
  ctx.fillRect(x, y, width, height);
  ctx.strokeRect(x, y, width, height);
  ctx.restore();
}
