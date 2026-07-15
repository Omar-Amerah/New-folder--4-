// Manages drag box overlays, own live ships, selection lists, and bounds overlap mathematics.

import { state } from "../state.js";
import { updateHud } from "../ui/hudUi.js";

export function shipVisualState(ship) {
  const vis = state.visualShips?.get?.(ship.id);
  return vis ? { ...ship, x: vis.x, y: vis.y, angle: vis.angle } : ship;
}
export function shipHitRadius(ship) { return Math.max(4, Number(ship?.radius) || 26) + 14; }
export function isSelectableOwnLiving(ship) { return !!ship && ship.ownerId === state.myId && ship.alive !== false; }
export function circleIntersectsBox(cx, cy, radius, minX, minY, maxX, maxY) {
  const px = Math.max(minX, Math.min(maxX, cx)); const py = Math.max(minY, Math.min(maxY, cy));
  return (cx - px) ** 2 + (cy - py) ** 2 <= radius ** 2;
}
export function selectAt(world, additive) {
  const ship = findShipAt(world.x, world.y, isSelectableOwnLiving);
  state.activeShipGroup = null;
  if (!additive) state.selectedShipIds.clear();
  if (ship) { if (state.selectedShipIds.has(ship.id) && additive) state.selectedShipIds.delete(ship.id); else state.selectedShipIds.add(ship.id); state.camera.follow = true; }
}
export function selectBox(a, b, additive) {
  state.activeShipGroup = null; if (!additive) state.selectedShipIds.clear();
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
  for (const ship of ownLiveShips()) { const v = shipVisualState(ship); if (circleIntersectsBox(v.x, v.y, shipHitRadius(ship), minX, minY, maxX, maxY)) state.selectedShipIds.add(ship.id); }
  if (state.selectedShipIds.size > 0) state.camera.follow = true;
}
export function selectAllOwnShips() { state.selectedShipIds = new Set(ownLiveShips().map((ship) => ship.id)); state.activeShipGroup = null; updateHud(); }
export function pruneSelection() { const live = new Set(ownLiveShips().map((ship) => ship.id)); for (const id of [...state.selectedShipIds]) if (!live.has(id)) state.selectedShipIds.delete(id); if (state.selectedShipIds.size === 0) state.activeShipGroup = null; }
export function ownLiveShips() { return state.snapshot?.ships?.filter((ship) => ship.ownerId === state.myId && ship.alive) || []; }
export function findShipAt(x, y, predicate = () => true) {
  let best = null, bestDistance = Infinity;
  for (const ship of state.snapshot?.ships || []) {
    if (!predicate(ship)) continue; const v = shipVisualState(ship); const distance = Math.hypot(v.x - x, v.y - y); const radius = shipHitRadius(ship);
    if (distance <= radius && distance < bestDistance) { best = ship; bestDistance = distance; }
  }
  return best;
}
export function resetSelectionForEpoch() { state.selectedShipIds.clear(); state.activeShipGroup = null; }
