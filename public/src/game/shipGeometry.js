// Renderer-neutral ship-local geometry: where each blueprint part sits on a
// ship, footprint centres/dimensions, component pivots, and engine nozzle
// placement. Pure math over the design data — no Canvas, no Pixi, no DOM —
// so the Pixi arena renderer and the blueprint/UI bakers share one source of truth.

import { PART_STATS } from "../design/parts.js";
import { moduleRotationToRadians, normalizeRotation, directionalFootprintToShipRadians } from "../design/rotation.js";
import { getOccupiedCells } from "../design/footprint.js";

// Grid center for the 15x15 build grid (core sits here), so modules render
// centered on the ship's origin instead of offset toward one corner.
export const GRID_CENTER = 7;
const designBoundsCache = new WeakMap();

export function moduleLocalPosition(part, scale) {
  return {
    x: (GRID_CENTER - part.y) * scale,
    y: (part.x - GRID_CENTER) * scale
  };
}

// Axis-aligned bounds and the furthest occupied hull corner in ship-local
// space. Unlike ship.radius (a capped gameplay stat), these measurements follow
// the rendered component footprint, so very small and very large designs do not
// inherit the same visual envelope.
export function shipLocalBounds(design, scale = 13) {
  if (!Array.isArray(design) || design.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, radius: 0 };
  }

  let byScale = designBoundsCache.get(design);
  if (!byScale) {
    byScale = new Map();
    designBoundsCache.set(design, byScale);
  }
  const cached = byScale.get(scale);
  if (cached) return cached;

  const halfCell = scale / 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let radius = 0;

  for (const part of design) {
    const footprint = PART_STATS[part.type]?.footprint || { width: 1, height: 1 };
    const cells = getOccupiedCells(part.x, part.y, footprint, part.rotation || 0);
    for (const cell of cells) {
      const center = moduleLocalPosition(cell, scale);
      const left = center.x - halfCell;
      const right = center.x + halfCell;
      const top = center.y - halfCell;
      const bottom = center.y + halfCell;
      minX = Math.min(minX, left);
      minY = Math.min(minY, top);
      maxX = Math.max(maxX, right);
      maxY = Math.max(maxY, bottom);
      radius = Math.max(
        radius,
        Math.hypot(left, top),
        Math.hypot(right, top),
        Math.hypot(right, bottom),
        Math.hypot(left, bottom)
      );
    }
  }

  const bounds = { minX, minY, maxX, maxY, radius };
  byScale.set(scale, bounds);
  return bounds;
}

// Where and how a (possibly multi-tile) part should be drawn on a ship, in the
// ship's local space: the footprint's centre (the component's pivot), its tile
// dimensions, and the angle that aligns a canonical +x-forward component with
// the footprint's long axis. Used by the arena renderer and the blueprint/UI
// bakers so blueprint and in-game visuals stay consistent.
export function footprintLocalPlacement(part, scale) {
  const stat = PART_STATS[part.type] || {};
  const footprint = stat.footprint || { width: 1, height: 1 };
  const cells = getOccupiedCells(part.x, part.y, footprint, part.rotation || 0);
  let sx = 0, sy = 0, minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const cell of cells) {
    const p = moduleLocalPosition(cell, scale);
    sx += p.x; sy += p.y;
    if (p.x < minx) minx = p.x;
    if (p.x > maxx) maxx = p.x;
    if (p.y < miny) miny = p.y;
    if (p.y > maxy) maxy = p.y;
  }
  const rot = normalizeRotation(part.rotation || 0);
  const swap = rot === 90 || rot === 270;
  const w = swap ? footprint.height : footprint.width;
  const h = swap ? footprint.width : footprint.height;
  // A rotatable cut-away shape (the long wedge) carries its direction in its
  // own silhouette, so it has to follow the full placement rotation. The bare
  // long-axis rule below only distinguishes the axis, which would render a prow
  // placed at 180 deg still pointing forward.
  const directionalShape = Boolean(stat.shapeType) && Boolean(stat.rotatable);
  return {
    cx: sx / cells.length,
    cy: sy / cells.length,
    tilesLong: Math.max(w, h),
    tilesCross: Math.min(w, h),
    // Long axis runs along local x when its x-span is the larger one, else local y.
    longAxisAngle: directionalShape
      ? directionalFootprintToShipRadians(rot, footprint)
      : ((maxx - minx) >= (maxy - miny) ? 0 : Math.PI / 2),
    multi: cells.length > 1
  };
}

// Corner positions of a (possibly rotated) footprint rect in ship-local space.
// Returns the four corners plus the local->ship point transform used to build
// them, so callers can project additional detail points cheaply.
export function footprintCorners(place, halfW, halfH) {
  const ang = place.multi ? place.longAxisAngle : 0;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const pt = (x, y) => ({ x: place.cx + x * cos - y * sin, y: place.cy + x * sin + y * cos });
  return [pt(-halfW, -halfH), pt(halfW, -halfH), pt(halfW, halfH), pt(-halfW, halfH), pt];
}

function isMainEngineType(type) {
  const stat = PART_STATS[type] || {};
  return (stat.thrust || 0) > 0 && type !== "maneuverThruster";
}

// Ship-local exhaust nozzle placements for every main engine in a design.
export function shipEngineNozzles(design, scale = 13) {
  const nozzles = [];
  if (!Array.isArray(design)) return nozzles;
  for (let i = 0; i < design.length; i += 1) {
    const part = design[i];
    if (!isMainEngineType(part.type)) continue;
    const place = footprintLocalPlacement(part, scale);
    const angle = moduleRotationToRadians(normalizeRotation(part.rotation));
    const c = Math.cos(angle), s = Math.sin(angle);
    const extent = place.tilesLong * scale * 0.5;
    const spanY = place.tilesCross * scale;
    nozzles.push({
      index: i,
      x: place.cx - c * extent + c * 1.5,
      y: place.cy - s * extent + s * 1.5,
      halfW: Math.max(2.4, spanY * 0.33),
      angle
    });
  }
  return nozzles;
}
