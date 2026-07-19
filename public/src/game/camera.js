// Manages camera panning, zoom ratios, coordinate mappings, and viewport-aware bounds.

import { dom } from "../ui/dom.js";
import { state } from "../state.js";
import { clamp } from "../shared/math.js";
import { ownLiveShips } from "./selection.js";

export const CAMERA_MIN_ZOOM = 0.32;
export const CAMERA_MAX_ZOOM = 1.45;
export const CAMERA_FOLLOW_HALF_LIFE_MS = 260;

function finite(value, fallback = 0) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }

// getBoundingClientRect forces layout, and the render loop needs the canvas
// rect every frame — right after snapshot handlers may have dirtied the DOM.
// Cache the measurement per canvas element with a short TTL and explicit
// invalidation on resize, so steady-state frames never trigger a reflow.
const RECT_CACHE_TTL_MS = 250;
let rectCacheCanvas = null;
let rectCacheValue = null;
let rectCacheAt = 0;
export function invalidateCanvasRectCache() { rectCacheCanvas = null; rectCacheValue = null; }
function measureCanvasRect(canvas) {
  const rect = canvas?.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
  return { left: finite(rect.left), top: finite(rect.top), width: Math.max(0, finite(rect.width)), height: Math.max(0, finite(rect.height)) };
}
export function canvasCssRect(canvas = dom.canvas) {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (rectCacheValue && rectCacheCanvas === canvas && now - rectCacheAt < RECT_CACHE_TTL_MS) return rectCacheValue;
  rectCacheCanvas = canvas;
  rectCacheValue = measureCanvasRect(canvas);
  rectCacheAt = now;
  return rectCacheValue;
}
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("resize", invalidateCanvasRectCache);
  window.addEventListener("orientationchange", invalidateCanvasRectCache);
}
function cameraLike(camera = state.camera) { return { x: finite(camera?.x), y: finite(camera?.y), zoom: clamp(finite(camera?.zoom, 1), CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM) }; }
function worldLike(world = state.world) { return { width: Math.max(1, finite(world?.width, 1)), height: Math.max(1, finite(world?.height, 1)) }; }

export function worldToScreen(worldPoint, camera = state.camera, rect = canvasCssRect(), world = state.world) {
  const cam = cameraLike(camera); worldLike(world);
  return { x: rect.left + rect.width / 2 + (finite(worldPoint?.x) - cam.x) * cam.zoom, y: rect.top + rect.height / 2 + (finite(worldPoint?.y) - cam.y) * cam.zoom };
}
export function screenToWorldPoint(screenPoint, camera = state.camera, rect = canvasCssRect(), world = state.world) {
  const cam = cameraLike(camera); worldLike(world);
  const z = cam.zoom || 1;
  return { x: cam.x + (finite(screenPoint?.x) - rect.left - rect.width / 2) / z, y: cam.y + (finite(screenPoint?.y) - rect.top - rect.height / 2) / z };
}
export function screenToWorld(clientX, clientY) { return screenToWorldPoint({ x: clientX, y: clientY }); }

export function cameraViewportWorldBounds(camera = state.camera, rect = canvasCssRect(), world = state.world, padding = 0) {
  const cam = cameraLike(camera); const z = cam.zoom || 1;
  const halfW = (rect.width / z) / 2; const halfH = (rect.height / z) / 2;
  return { left: cam.x - halfW - padding, right: cam.x + halfW + padding, top: cam.y - halfH - padding, bottom: cam.y + halfH + padding, halfWidth: halfW, halfHeight: halfH };
}
export function clampCameraToWorld(camera = state.camera, rect = canvasCssRect(), world = state.world) {
  const cam = cameraLike(camera); const w = worldLike(world);
  const halfW = (rect.width / cam.zoom) / 2; const halfH = (rect.height / cam.zoom) / 2;
  const minX = halfW, maxX = w.width - halfW; const minY = halfH, maxY = w.height - halfH;
  return { ...camera, x: minX > maxX ? w.width / 2 : clamp(cam.x, minX, maxX), y: minY > maxY ? w.height / 2 : clamp(cam.y, minY, maxY), zoom: cam.zoom };
}
export function zoomCameraAtScreenPoint(camera, screenPoint, zoomIntent, rect = canvasCssRect(), world = state.world) {
  const cam = cameraLike(camera); const intent = clamp(finite(zoomIntent), -6, 6);
  const oldZoom = cam.zoom; const newZoom = clamp(oldZoom * Math.exp(intent * 0.13), CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM);
  const before = screenToWorldPoint(screenPoint, cam, rect, world);
  const next = { ...camera, zoom: newZoom, manualZoom: newZoom };
  const after = screenToWorldPoint(screenPoint, next, rect, world);
  next.x = cam.x + before.x - after.x; next.y = cam.y + before.y - after.y;
  return clampCameraToWorld(next, rect, world);
}
export function minimapToWorld(point, minimap = state.minimap, world = state.world) {
  if (!minimap) return null; const w = worldLike(world);
  return { x: clamp((finite(point?.x) - minimap.x) / Math.max(1, minimap.w) * w.width, 0, w.width), y: clamp((finite(point?.y) - minimap.y) / Math.max(1, minimap.h) * w.height, 0, w.height) };
}
export function worldToMinimap(point, minimap = state.minimap, world = state.world) {
  if (!minimap) return null; const w = worldLike(world);
  return { x: minimap.x + clamp(finite(point?.x), 0, w.width) / w.width * minimap.w, y: minimap.y + clamp(finite(point?.y), 0, w.height) / w.height * minimap.h };
}
export function minimapWorldAt(clientX, clientY) {
  if (!state.minimap) return null; const rect = canvasCssRect(); const local = { x: clientX - rect.left, y: clientY - rect.top }; const mini = state.minimap;
  if (local.x < mini.x || local.x > mini.x + mini.w || local.y < mini.y || local.y > mini.y + mini.h) return null;
  return minimapToWorld(local);
}
export function centerCameraOnShips(ships) {
  const live = (ships || []).filter((s) => s?.alive !== false); if (!live.length) return false;
  state.camera.x = live.reduce((sum, s) => sum + finite(s.x), 0) / live.length; state.camera.y = live.reduce((sum, s) => sum + finite(s.y), 0) / live.length;
  Object.assign(state.camera, clampCameraToWorld(state.camera)); return true;
}
export function resetCameraZoomToFit() { const rect = canvasCssRect(); const fitZoom = clamp(Math.min(rect.width / 1300 || 0, rect.height / 820 || 0), 0.42, 0.82); state.camera.manualZoom = null; state.camera.zoom = fitZoom; Object.assign(state.camera, clampCameraToWorld(state.camera)); }

export function updateCamera(dt) {
  const rect = canvasCssRect(); const fitZoom = clamp(Math.min(rect.width / 1300 || 0, rect.height / 820 || 0), 0.42, 0.82);
  if (state.camera.manualZoom == null) state.camera.zoom = fitZoom;
  const panSpeed = 760 * dt / Math.max(CAMERA_MIN_ZOOM, state.camera.zoom); let moved = false;
  if (state.keys.has("arrowleft") || state.keys.has("a")) { state.camera.x -= panSpeed; moved = true; }
  if (state.keys.has("arrowright") || state.keys.has("d")) { state.camera.x += panSpeed; moved = true; }
  if (state.keys.has("arrowup") || state.keys.has("w")) { state.camera.y -= panSpeed; moved = true; }
  if (state.keys.has("arrowdown") || state.keys.has("s")) { state.camera.y += panSpeed; moved = true; }
  if (moved) state.camera.follow = false;
  if (state.camera.follow) {
    const selected = [...state.selectedShipIds];
    const focusShips = selected.length ? (state.snapshot?.ships || []).filter((ship) => state.selectedShipIds.has(ship.id) && ship.alive) : ownLiveShips();
    if (focusShips.length) {
      const targetX = focusShips.reduce((sum, s) => sum + finite(s.x), 0) / focusShips.length; const targetY = focusShips.reduce((sum, s) => sum + finite(s.y), 0) / focusShips.length;
      const alpha = 1 - Math.pow(0.5, Math.min(250, dt * 1000) / CAMERA_FOLLOW_HALF_LIFE_MS);
      state.camera.x += (targetX - state.camera.x) * alpha; state.camera.y += (targetY - state.camera.y) * alpha;
    }
  }
  Object.assign(state.camera, clampCameraToWorld(state.camera, rect, state.world));
}
