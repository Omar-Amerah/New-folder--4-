// Read-only browser-test diagnostics for production visual ship targeting.

import { state } from "../state.js";
import { canvasCssRect, worldToScreen } from "./camera.js";
import { shipHitRadius, shipVisualState } from "./selection.js";

export function shipVisualClientTarget(shipOrId) {
  const ship = typeof shipOrId === "string" ? state.snapshot?.ships?.find((s) => s.id === shipOrId) : shipOrId;
  if (!ship) return null;
  const visual = shipVisualState(ship);
  const rect = canvasCssRect();
  const center = worldToScreen({ x: visual.x, y: visual.y }, state.camera, rect, state.world);
  const zoom = Number(state.camera?.zoom) || 1;
  return {
    id: ship.id,
    ownerId: ship.ownerId,
    alive: ship.alive !== false,
    clientX: center.x,
    clientY: center.y,
    radius: shipHitRadius(ship) * zoom,
    authoritative: { x: Number(ship.x), y: Number(ship.y), angle: Number(ship.angle) || 0 },
    interpolated: { x: Number(visual.x), y: Number(visual.y), angle: Number(visual.angle) || 0 },
    camera: { x: Number(state.camera?.x) || 0, y: Number(state.camera?.y) || 0, zoom },
    zoom,
    canvasRect: rect
  };
}
