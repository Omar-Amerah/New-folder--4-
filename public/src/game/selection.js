// Manages drag box overlays, own live ships, selection lists, and bounds overlap mathematics.

import { state } from "../state.js";
import { synchronizeTelemetryFocus } from "../telemetryFocus.js";
import { invalidatePresentation } from "../presentationInvalidation.js";

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
  // A click that hit one of your own ships always means the ship. Only an
  // otherwise-empty click can land on a station, and stations are inspection
  // targets only — they never join the commandable selection.
  selectStationAt(ship ? null : world, additive);
  synchronizeTelemetryFocus();
  invalidatePresentation("selection");
}

export function stations() {
  return state.snapshot?.stations || [];
}
export function stationHitRadius(station) { return Math.max(24, Number(station?.radius) || 60); }
// The station's real half-extents in structure-local space. `station.radius` is
// the broad-phase circle around a SQUARE structure, so on a home station it
// reaches ~40% past the corners — clicking well clear of the hull used to
// select it, and clicks meant for a ship parked alongside were swallowed.
function stationHalfExtent(station) {
  const design = station?.design;
  const scale = Number(station?.moduleScale);
  if (!Array.isArray(design) || design.length === 0 || !(scale > 0)) return null;
  let maxCell = 0;
  for (const module of design) {
    maxCell = Math.max(maxCell, Math.abs((Number(module.x) || 0) - 7), Math.abs((Number(module.y) || 0) - 7));
  }
  return (maxCell + 0.5) * scale;
}
export function findStationAt(x, y) {
  let best = null, bestDistance = Infinity;
  for (const station of stations()) {
    const distance = Math.hypot(station.x - x, station.y - y);
    const half = stationHalfExtent(station);
    let inside;
    if (half === null) {
      inside = distance <= stationHitRadius(station);
    } else {
      // Into structure-local space, where the footprint is axis aligned.
      const angle = Number(station.angle) || 0;
      const cos = Math.cos(-angle), sin = Math.sin(-angle);
      const dx = x - station.x, dy = y - station.y;
      const localX = dx * cos - dy * sin;
      const localY = dx * sin + dy * cos;
      inside = Math.abs(localX) <= half && Math.abs(localY) <= half;
    }
    if (inside && distance < bestDistance) { best = station; bestDistance = distance; }
  }
  return best;
}
// Sets (or with a null world, clears) the inspected station. Returns whether the
// selection changed, so callers can skip a needless presentation invalidation.
export function selectStationAt(world, additive = false) {
  const previous = state.selectedStationId;
  const station = world ? findStationAt(world.x, world.y) : null;
  if (station && additive && previous === station.id) state.selectedStationId = null;
  else state.selectedStationId = station ? station.id : null;
  return state.selectedStationId !== previous;
}
export function selectedStation() {
  if (!state.selectedStationId) return null;
  return stations().find((station) => station.id === state.selectedStationId) || null;
}
// Drops a station selection whose station no longer exists (mode change, return
// to lobby, or a full resync that no longer carries stations).
export function pruneStationSelection() {
  if (!state.selectedStationId) return false;
  if (selectedStation()) return false;
  state.selectedStationId = null;
  return true;
}
export function selectBox(a, b, additive) {
  state.activeShipGroup = null; if (!additive) { state.selectedShipIds.clear(); state.selectedStationId = null; }
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
  for (const ship of ownLiveShips()) { const v = shipVisualState(ship); if (circleIntersectsBox(v.x, v.y, shipHitRadius(ship), minX, minY, maxX, maxY)) state.selectedShipIds.add(ship.id); }
  if (state.selectedShipIds.size > 0) state.camera.follow = true;
  synchronizeTelemetryFocus();
  invalidatePresentation("selection");
}
export function selectAllOwnShips() {
  state.selectedShipIds = new Set(ownLiveShips().map((ship) => ship.id));
  state.activeShipGroup = null;
  synchronizeTelemetryFocus();
  invalidatePresentation("selection");
}
export function pruneSelection({ invalidate = true } = {}) {
  const live = new Set(ownLiveShips().map((ship) => ship.id));
  let changed = false;
  for (const id of [...state.selectedShipIds]) {
    if (!live.has(id)) {
      state.selectedShipIds.delete(id);
      changed = true;
    }
  }
  if (state.selectedShipIds.size === 0 && state.activeShipGroup !== null) {
    state.activeShipGroup = null;
    changed = true;
  }
  if (pruneStationSelection()) changed = true;
  if (changed && invalidate) invalidatePresentation("selection");
  return changed;
}
export function ownLiveShips() {
  if (state.snapshotIndex?.ownLivingShips) return state.snapshotIndex.ownLivingShips;
  return state.snapshot?.ships?.filter((ship) => ship.ownerId === state.myId && ship.alive) || [];
}
export function findShipAt(x, y, predicate = () => true) {
  let best = null, bestDistance = Infinity;
  for (const ship of state.snapshot?.ships || []) {
    if (!predicate(ship)) continue; const v = shipVisualState(ship); const distance = Math.hypot(v.x - x, v.y - y); const radius = shipHitRadius(ship);
    if (distance <= radius && distance < bestDistance) { best = ship; bestDistance = distance; }
  }
  return best;
}
export function resetSelectionForEpoch() {
  state.selectedShipIds.clear();
  state.selectedStationId = null;
  state.activeShipGroup = null;
  synchronizeTelemetryFocus();
  invalidatePresentation("selection");
}
