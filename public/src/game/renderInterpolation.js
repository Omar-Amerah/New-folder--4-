// Client-side ship interpolation: smooths each ship's rendered position/angle
// toward the latest authoritative snapshot. Pure state math — no Canvas, Pixi,
// or DOM. Consumed by the Pixi arena renderer each frame.

import { state } from "../state.js";
import { angleDifference } from "../shared/math.js";

export function interpolateShips(dt, now) {
  const snap = state.snapshot;
  if (!snap) return;

  if (snap.ships) {
    if (!state.visualShips) state.visualShips = new Map();
    const visibleIds = new Set(snap.ships.map((s) => s.id));
    for (const id of state.visualShips.keys()) {
      if (!visibleIds.has(id)) state.visualShips.delete(id);
    }

    for (const ship of snap.ships) {
      let vis = state.visualShips.get(ship.id);
      if (!vis) {
        vis = { x: ship.x, y: ship.y, angle: ship.angle };
        state.visualShips.set(ship.id, vis);
      } else {
        const t = 1 - Math.exp(-22 * dt);
        const distSq = (ship.x - vis.x) ** 2 + (ship.y - vis.y) ** 2;
        if (distSq > 300 * 300) {
          vis.x = ship.x;
          vis.y = ship.y;
          vis.angle = ship.angle;
        } else {
          vis.x += (ship.x - vis.x) * t;
          vis.y += (ship.y - vis.y) * t;
          vis.angle += angleDifference(vis.angle, ship.angle) * t;
        }
      }
    }
  }
}
