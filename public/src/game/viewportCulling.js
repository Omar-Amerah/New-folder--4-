// Viewport / culling math for the arena renderer. Pure geometry over the camera state.

import { state } from "../state.js";
import { cameraViewportWorldBounds } from "./camera.js";

export const CULLING_MARGINS = Object.freeze({ ship:96, shield:64, selection:48, weapon:40, projectile:32, trail:96, explosion:160, floatingText:48, objective:128, asteroid:96, cloud:192 });

export function expandBounds(bounds, margin = 0) { return { left: bounds.left - margin, right: bounds.right + margin, top: bounds.top - margin, bottom: bounds.bottom + margin }; }
export function validBounds(bounds) { return Number.isFinite(bounds?.left) && Number.isFinite(bounds?.right) && Number.isFinite(bounds?.top) && Number.isFinite(bounds?.bottom) && bounds.left <= bounds.right && bounds.top <= bounds.bottom; }
export function getViewportWorldBounds(rect, padding = 160) { return cameraViewportWorldBounds(state.camera, { left: 0, top: 0, width: rect.width, height: rect.height }, state.world, padding); }
export function isCircleVisible(x, y, radius, bounds) { return circleIntersectsViewport({ x, y, radius }, bounds); }
export function circleIntersectsViewport(circle, bounds, margin = 0) { if (!validBounds(bounds)) return true; const x = Number(circle?.x), y = Number(circle?.y), r = Math.max(0, Number(circle?.radius) || 0) + margin; if (!Number.isFinite(x) || !Number.isFinite(y)) return true; return x + r >= bounds.left && x - r <= bounds.right && y + r >= bounds.top && y - r <= bounds.bottom; }
export function rectIntersectsViewport(rect, bounds, margin = 0) { if (!validBounds(bounds)) return true; const x = Number(rect?.x), y = Number(rect?.y), w = Math.max(0, Number(rect?.width) || 0), h = Math.max(0, Number(rect?.height) || 0); if (![x,y,w,h].every(Number.isFinite)) return true; return x + w/2 + margin >= bounds.left && x - w/2 - margin <= bounds.right && y + h/2 + margin >= bounds.top && y - h/2 - margin <= bounds.bottom; }
export function lineIntersectsViewport(line, bounds, margin = 0) { if (!validBounds(bounds)) return true; const x1=Number(line?.x1), y1=Number(line?.y1), x2=Number(line?.x2), y2=Number(line?.y2); if (![x1,y1,x2,y2].every(Number.isFinite)) return true; const expanded = expandBounds(bounds, margin); if (circleIntersectsViewport({x:x1,y:y1,radius:0}, expanded) || circleIntersectsViewport({x:x2,y:y2,radius:0}, expanded)) return true; const minX=Math.min(x1,x2), maxX=Math.max(x1,x2), minY=Math.min(y1,y2), maxY=Math.max(y1,y2); return maxX >= expanded.left && minX <= expanded.right && maxY >= expanded.top && minY <= expanded.bottom; }
export function cullVisual(kind, visual, bounds) { const margin = CULLING_MARGINS[kind] || 0; if (visual?.type === "rect") return rectIntersectsViewport(visual, bounds, margin); if (visual?.type === "line") return lineIntersectsViewport(visual, bounds, margin); return circleIntersectsViewport(visual, bounds, margin); }
