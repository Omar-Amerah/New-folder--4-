// Manages camera panning, scroll zoom ratios, coordinate mappings, and edge bounding limits.

import { dom, ctx } from "../ui/dom.js";
import { state } from "../state.js";
import { clamp } from "../shared/math.js";
import { ownLiveShips } from "./selection.js";

export function updateCamera(dt) {
  const rect = dom.canvas.getBoundingClientRect();
  const fitZoom = clamp(Math.min(rect.width / 1300, rect.height / 820), 0.42, 0.82);
  if (state.camera.manualZoom == null) state.camera.zoom = fitZoom;

  const panSpeed = 760 * dt / state.camera.zoom;
  let moved = false;
  if (state.keys.has("arrowleft") || state.keys.has("a")) {
    state.camera.x -= panSpeed;
    moved = true;
  }
  if (state.keys.has("arrowright") || state.keys.has("d")) {
    state.camera.x += panSpeed;
    moved = true;
  }
  if (state.keys.has("arrowup") || state.keys.has("w")) {
    state.camera.y -= panSpeed;
    moved = true;
  }
  if (state.keys.has("arrowdown") || state.keys.has("s")) {
    state.camera.y += panSpeed;
    moved = true;
  }
  if (moved) state.camera.follow = false;

  if (state.camera.follow) {
    const focusShips = [...state.selectedShipIds].length
      ? (state.snapshot?.ships || []).filter((ship) => state.selectedShipIds.has(ship.id) && ship.alive)
      : ownLiveShips();
    if (focusShips.length) {
      const targetX = focusShips.reduce((sum, ship) => sum + ship.x, 0) / focusShips.length;
      const targetY = focusShips.reduce((sum, ship) => sum + ship.y, 0) / focusShips.length;
      state.camera.x += (targetX - state.camera.x) * 0.055;
      state.camera.y += (targetY - state.camera.y) * 0.055;
    }
  }

  state.camera.x = clamp(state.camera.x, 0, state.world.width);
  state.camera.y = clamp(state.camera.y, 0, state.world.height);
}

export function applyCamera(rect) {
  ctx.translate(rect.width / 2, rect.height / 2);
  ctx.scale(state.camera.zoom, state.camera.zoom);
  ctx.translate(-state.camera.x, -state.camera.y);
}

export function screenToWorld(clientX, clientY) {
  const rect = dom.canvas.getBoundingClientRect();
  return {
    x: state.camera.x + (clientX - rect.left - rect.width / 2) / state.camera.zoom,
    y: state.camera.y + (clientY - rect.top - rect.height / 2) / state.camera.zoom
  };
}

export function minimapWorldAt(clientX, clientY) {
  if (!state.minimap) return null;
  const rect = dom.canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const mini = state.minimap;
  if (x < mini.x || x > mini.x + mini.w || y < mini.y || y > mini.y + mini.h) return null;
  return {
    x: clamp((x - mini.x) / mini.w * state.world.width, 0, state.world.width),
    y: clamp((y - mini.y) / mini.h * state.world.height, 0, state.world.height)
  };
}
