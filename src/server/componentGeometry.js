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
const { BALANCE } = require("./balanceConfig");

const MODULE_SCALE = 13;

// Half-extent used when treating each occupied cell as a collision circle. Kept
// identical for beams and projectiles so the two systems agree cell-for-cell.
const COMPONENT_CELL_COLLISION_RADIUS = 8.5;
const SHIP_HULL_CELL_COLLISION_RADIUS = MODULE_SCALE * Math.SQRT2 / 2;
const SHIELD_COLLISION = BALANCE.projectiles?.shieldCollision || {};

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

function computeDesignCollisionRadius(design, fallback = 18) {
  let radius = Math.max(18, Number(fallback?.radius ?? fallback) * 0.56 || 18);
  for (const module of design || []) {
    for (const cell of componentCellLocalCoords(module)) {
      radius = Math.max(radius, Math.hypot(cell.x, cell.y) + SHIP_HULL_CELL_COLLISION_RADIUS);
    }
  }
  return radius;
}

function computeDesignFootprintRadius(design) {
  let radius = 0;
  const halfCell = MODULE_SCALE / 2;
  for (const module of design || []) {
    for (const cell of componentCellLocalCoords(module)) {
      radius = Math.max(
        radius,
        Math.hypot(Math.abs(cell.x) + halfCell, Math.abs(cell.y) + halfCell)
      );
    }
  }
  return radius;
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
function shieldRadiusForShip(ship) {
  const footprintRadius = computeDesignFootprintRadius(ship?.design);
  const physicalRadius = Number(ship?.physicalRadius) || 0;
  const gameplayRadius = Number(ship?.radius) || 0;
  const radius = footprintRadius > 0
    ? Math.max(18, footprintRadius)
    : Math.max(18, physicalRadius || gameplayRadius);
  return Math.max(
    Number(SHIELD_COLLISION.minimumRadius) || 0,
    radius + Math.max(Number(SHIELD_COLLISION.flatPadding) || 0, radius * (Number(SHIELD_COLLISION.radiusMultiplier) || 0))
  );
}

function invalidateShipCollisionGeometry(ship) {
  if (!ship) return;
  ship._collisionGeometry = null;
  ship._componentCellWorldCoords = null;
}

function ensureLocalGeometry(cache, ship, design) {
  const revision = Number(ship.designRevision) || 1;
  if (cache.designSource === design && cache.designRevision === revision && cache.localCells.length === design.length) return;
  cache.designSource = design;
  cache.designRevision = revision;
  cache.localCells = design.map(componentCellLocalCoords);
  cache.worldCells = cache.localCells.map((cells) => cells.map(() => ({ x: 0, y: 0 })));
  cache.x = NaN;
  cache.y = NaN;
  cache.angle = NaN;
  // Both derived radii are functions of the design, so a design change has to
  // drop them as well.
  cache.radius = NaN;
}

function getShipCollisionGeometry(ship) {
  const design = ship.design || [];
  const cache = ship._collisionGeometry || (ship._collisionGeometry = {
    designSource: null,
    designRevision: 0,
    localCells: [],
    worldCells: [],
    liveComponentIndices: [],
    healthRevision: -1,
    x: NaN,
    y: NaN,
    angle: NaN,
    radius: NaN,
    shieldRadius: 0,
    designCollisionRadius: 0,
    physicalRadius: 0,
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  });
  ensureLocalGeometry(cache, ship, design);

  const angle = Number(ship.angle) || 0;
  const x = Number(ship.x) || 0;
  const y = Number(ship.y) || 0;
  if (cache.angle !== angle || cache.x !== x || cache.y !== y) {
    const cos = Math.cos(ship.angle || 0);
    const sin = Math.sin(ship.angle || 0);
    for (let i = 0; i < cache.localCells.length; i += 1) {
      const localCells = cache.localCells[i];
      const worldCells = cache.worldCells[i];
      for (let c = 0; c < localCells.length; c += 1) {
        const local = localCells[c];
        const world = worldCells[c];
        world.x = x + local.x * cos - local.y * sin;
        world.y = y + local.x * sin + local.y * cos;
      }
    }
    cache.angle = angle;
    cache.x = x;
    cache.y = y;
  }

  const radius = Number.isFinite(Number(ship.radius))
    ? Number(ship.radius)
    : (Number(ship.stats?.radius) || 0);
  // Both of these walk every occupied cell of every module. They depend on the
  // design and the ship's stat radius, never on where the ship is, so they are
  // cached alongside the local cell layout. The collision radius used to be
  // recomputed on every call — and this function runs for both hulls of every
  // separation candidate pair, and for every beam and projectile hit test.
  if (cache.radius !== radius) {
    cache.radius = radius;
    cache.shieldRadius = shieldRadiusForShip(ship);
    cache.designCollisionRadius = computeDesignCollisionRadius(design, radius);
  }
  const coarseRadius = Math.max(radius, cache.shieldRadius);
  cache.physicalRadius = Math.max(
    Number(ship.physicalRadius) || 0,
    cache.designCollisionRadius
  );
  cache.bounds.minX = x - coarseRadius;
  cache.bounds.minY = y - coarseRadius;
  cache.bounds.maxX = x + coarseRadius;
  cache.bounds.maxY = y + coarseRadius;

  // Fractional HP changes update repairCacheRevision, but cannot change which
  // component cells participate in collision. Track only zero/alive
  // transitions so bullet swarms do not rescan the whole design after every hit.
  const aliveRevision = Number(ship.componentAliveRevision);
  const healthRevision = Number.isFinite(aliveRevision)
    ? aliveRevision
    : (Number(ship.repairCacheRevision) || 0);
  if (cache.healthRevision !== healthRevision || cache.liveComponentIndices.length > design.length) {
    cache.liveComponentIndices.length = 0;
    for (let i = 0; i < design.length; i += 1) {
      if (!ship.componentHp || ship.componentHp[i] > 0) cache.liveComponentIndices.push(i);
    }
    cache.healthRevision = healthRevision;
  }

  // Compatibility aliases for older diagnostics.
  ship._componentCellWorldCoords = cache.worldCells;
  ship._componentCellCoordsAngle = cache.angle;
  ship._componentCellCoordsX = cache.x;
  ship._componentCellCoordsY = cache.y;
  return cache;
}

function shipHullCircles(ship) {
  const geometry = getShipCollisionGeometry(ship);
  const circles = ship._shipHullCircleScratch || (ship._shipHullCircleScratch = []);
  circles.length = 0;
  for (const componentIndex of geometry.liveComponentIndices) {
    const cells = geometry.worldCells[componentIndex] || [];
    for (let i = 0; i < cells.length; i += 1) {
      circles.push({ x: cells[i].x, y: cells[i].y, radius: SHIP_HULL_CELL_COLLISION_RADIUS });
    }
  }
  if (circles.length === 0) circles.push({ x: ship.x, y: ship.y, radius: Math.max(18, Number(ship.physicalRadius) || 18) });
  return circles;
}

function findShipHullOverlap(a, b) {
  const circlesA = shipHullCircles(a);
  const circlesB = shipHullCircles(b);
  let best = null;
  for (let i = 0; i < circlesA.length; i += 1) {
    const ca = circlesA[i];
    for (let j = 0; j < circlesB.length; j += 1) {
      const cb = circlesB[j];
      const dx = cb.x - ca.x;
      const dy = cb.y - ca.y;
      const minimum = ca.radius + cb.radius;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared >= minimum * minimum) continue;
      const distance = Math.sqrt(distanceSquared);
      const penetration = minimum - distance;
      if (!best || penetration > best.penetration) best = { dx, dy, distance, penetration };
    }
  }
  return best;
}

function getShipComponentCellWorldCoords(ship) {
  return getShipCollisionGeometry(ship).worldCells;
}

module.exports = {
  MODULE_SCALE,
  COMPONENT_CELL_COLLISION_RADIUS,
  SHIP_HULL_CELL_COLLISION_RADIUS,
  componentCellLocalCoords,
  computeDesignCollisionRadius,
  computeDesignFootprintRadius,
  getShipComponentCellWorldCoords,
  getShipCollisionGeometry,
  shipHullCircles,
  findShipHullOverlap,
  invalidateShipCollisionGeometry,
  shieldRadiusForShip
};
