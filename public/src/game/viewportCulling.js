// Viewport / culling math for the arena renderer. Pure geometry over the camera state.

import { state } from "../state.js";
import { cameraViewportWorldBounds } from "./camera.js";

export function getViewportWorldBounds(rect, padding = 160) { return cameraViewportWorldBounds(state.camera, { left: 0, top: 0, width: rect.width, height: rect.height }, state.world, padding); }
export function isCircleVisible(x, y, radius, bounds) { return x + radius >= bounds.left && x - radius <= bounds.right && y + radius >= bounds.top && y - radius <= bounds.bottom; }
