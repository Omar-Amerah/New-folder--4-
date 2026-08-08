// Thin client wrapper around the shared component-transform rules, so browser
// placement and server validation can never disagree about which cells a
// rotated/mirrored part occupies. Transform order is defined once, in
// public/src/shared/componentTransform.js: mirror first, then rotation.
import "../shared/componentTransform.js";

const ComponentTransform = globalThis.ComponentTransform;

export function getOccupiedCells(x, y, footprint, rotation = 0, flipped = false) {
  return ComponentTransform.getOccupiedCells(x, y, footprint, rotation, flipped);
}

export function getFootprintBounds(x, y, footprint, rotation = 0, flipped = false) {
  return ComponentTransform.getFootprintBounds(x, y, footprint, rotation, flipped);
}

export function footprintIncludes(x, y, footprint, rotation, targetX, targetY, flipped = false) {
  return ComponentTransform.footprintIncludes(x, y, footprint, rotation, targetX, targetY, flipped);
}
