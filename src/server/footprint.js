// Server wrapper around the shared component-transform rules (the same module
// public/src/design/footprint.js wraps), so client placement and server
// validation agree on which cells a rotated/mirrored part occupies.
const ComponentTransform = require("../../public/src/shared/componentTransform");

function getOccupiedCells(x, y, footprint, rotation = 0, flipped = false) {
  return ComponentTransform.getOccupiedCells(x, y, footprint, rotation, flipped);
}

function getFootprintBounds(x, y, footprint, rotation = 0, flipped = false) {
  return ComponentTransform.getFootprintBounds(x, y, footprint, rotation, flipped);
}

function footprintIncludes(x, y, footprint, rotation, targetX, targetY, flipped = false) {
  return ComponentTransform.footprintIncludes(x, y, footprint, rotation, targetX, targetY, flipped);
}

module.exports = {
  getOccupiedCells,
  getFootprintBounds,
  footprintIncludes
};
