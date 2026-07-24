// Authoritative footprint-aware component collision geometry.
//
// Both beam collision (combat.js) and projectile collision (projectiles.js)
// resolve hits against the world position of every grid cell a component
// occupies — not just its anchor tile. Sharing one helper here keeps the two
// collision paths from drifting apart (rotation handling, cell-to-world
// transform, and collision radius are defined exactly once).
//
// The transform matches the renderer / shipDesign convention:
//   local.x = (7 - cell.y) * MODULE_SCALE   (grid centre is tile 7,7)
//   local.y = (cell.x - 7) * MODULE_SCALE
// then rotated by the ship angle and offset by the ship position.

const { PARTS } = require("./components");
const { normalizeRotation } = require("./shipDesign");
const { getOccupiedCells } = require("./footprint");

const MODULE_SCALE = 13;

// Half-extent used when treating each occupied cell as a collision circle. Kept
// identical for beams and projectiles so the two systems agree cell-for-cell.
const COMPONENT_CELL_COLLISION_RADIUS = 8.5;

// Local (ship-space, unrotated) coordinates of every cell a module occupies.
function componentCellLocalCoords(module) {
  const part = PARTS[module.type] || PARTS.frame;
  const cells = getOccupiedCells(
    module.x,
    module.y,
    part.footprint || { width: 1, height: 1 },
    normalizeRotation(module.rotation)
  );
  return cells.map((cell) => ({
    x: (7 - cell.y) * MODULE_SCALE,
    y: (cell.x - 7) * MODULE_SCALE
  }));
}

// World coordinates of every occupied cell of every component, grouped per
// component index: return[i] is an array of { x, y } world points for the cells
// component i occupies.
//
// The result is cached on the ship and rebuilt only when the ship moves,
// rotates, or its design length changes. Destroyed components are NOT removed
// from the cache — callers must skip them via componentHp so that a repaired
// component reuses the same geometry and a destroyed component's cells stop
// blocking without invalidating the whole cache.
function getShipComponentCellWorldCoords(ship) {
  const design = ship.design || [];
  if (
    !ship._componentCellWorldCoords ||
    ship._componentCellCoordsAngle !== ship.angle ||
    ship._componentCellCoordsX !== ship.x ||
    ship._componentCellCoordsY !== ship.y ||
    ship._componentCellWorldCoords.length !== design.length
  ) {
    const cos = Math.cos(ship.angle || 0);
    const sin = Math.sin(ship.angle || 0);
    const x = ship.x || 0;
    const y = ship.y || 0;
    ship._componentCellWorldCoords = design.map((module) =>
      componentCellLocalCoords(module).map((local) => ({
        x: x + local.x * cos - local.y * sin,
        y: y + local.x * sin + local.y * cos
      }))
    );
    ship._componentCellCoordsAngle = ship.angle;
    ship._componentCellCoordsX = ship.x;
    ship._componentCellCoordsY = ship.y;
  }
  return ship._componentCellWorldCoords;
}

module.exports = {
  MODULE_SCALE,
  COMPONENT_CELL_COLLISION_RADIUS,
  componentCellLocalCoords,
  getShipComponentCellWorldCoords
};
