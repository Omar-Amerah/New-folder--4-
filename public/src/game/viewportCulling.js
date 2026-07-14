// Viewport / culling math for the arena renderer. Pure geometry over the camera
// state — no Canvas, Pixi, or DOM. Used to skip off-screen world objects.

import { state } from "../state.js";

// World-space bounds of the current viewport, expanded by `padding` world units
// so objects just off-screen still draw while panning.
export function getViewportWorldBounds(rect, padding = 160) {
  const w = rect.width / state.camera.zoom;
  const h = rect.height / state.camera.zoom;
  return {
    left: state.camera.x - w / 2 - padding,
    right: state.camera.x + w / 2 + padding,
    top: state.camera.y - h / 2 - padding,
    bottom: state.camera.y + h / 2 + padding
  };
}

export function isCircleVisible(x, y, radius, bounds) {
  return x + radius >= bounds.left &&
         x - radius <= bounds.right &&
         y + radius >= bounds.top &&
         y - radius <= bounds.bottom;
}
