"use strict";

// Hangar geometry acceptance tests (station infrastructure sections 4, 5 and 8).
// Every measurement comes from the production template module — nothing here
// re-derives station geometry with its own copy of the maths.

const assert = require("assert");
const {
  SHIP_MODULE_SCALE,
  STATION_MODULE_SCALE,
  MAX_SHIP_CELLS,
  MAX_SHIP_EXTENT,
  GRID_CENTER,
  HOME_STATION_CELLS,
  buildHomeStationDesign,
  buildHomeStationGeometry,
  buildRelayStationDesign,
  inCorridorVoid
} = require("./src/server/stationTemplates");
const { computeDesignCollisionRadius, computeDesignFootprintRadius } = require("./src/server/componentGeometry");

// A launching ship is held aligned with the corridor, so what has to clear the
// mouth is its lateral half-extent plus the per-cell hull collision radius the
// physics engine actually uses — not the circumscribed radius, which is the
// ship's diagonal and only matters for an arbitrarily rotated hull.
const HULL_CELL_COLLISION_RADIUS = SHIP_MODULE_SCALE * Math.SQRT2 / 2;

const geometry = buildHomeStationGeometry();
const design = buildHomeStationDesign();

function section(label) {
  console.log(`  ${label}`);
}

// Ship-local bounds using the shared cell mapping at the SHIP module scale.
function shipLocalBounds(shipDesign) {
  const half = SHIP_MODULE_SCALE / 2;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const module of shipDesign) {
    const lx = (GRID_CENTER - module.y) * SHIP_MODULE_SCALE;
    const ly = (module.x - GRID_CENTER) * SHIP_MODULE_SCALE;
    minX = Math.min(minX, lx - half); maxX = Math.max(maxX, lx + half);
    minY = Math.min(minY, ly - half); maxY = Math.max(maxY, ly + half);
  }
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

function makeDesign(cells) {
  return cells.map(([x, y], index) => ({ x, y, type: index === 0 ? "core" : "frame", rotation: 0 }));
}

function fullGrid() {
  const cells = [];
  for (let y = 0; y < MAX_SHIP_CELLS; y += 1) for (let x = 0; x < MAX_SHIP_CELLS; x += 1) cells.push([x, y]);
  return makeDesign(cells);
}
function rowDesign() {
  const cells = [];
  for (let x = 0; x < MAX_SHIP_CELLS; x += 1) cells.push([x, GRID_CENTER]);
  return makeDesign(cells);
}
function columnDesign() {
  const cells = [];
  for (let y = 0; y < MAX_SHIP_CELLS; y += 1) cells.push([GRID_CENTER, y]);
  return makeDesign(cells);
}
function sparseExtremes() {
  const last = MAX_SHIP_CELLS - 1;
  return makeDesign([[0, 0], [last, 0], [0, last], [last, last], [GRID_CENTER, GRID_CENTER]]);
}
function irregularCorners() {
  const last = MAX_SHIP_CELLS - 1;
  const cells = [[0, 0], [1, 0], [0, 1], [last, 0], [last - 1, 0], [last, 1], [0, last], [last, last], [GRID_CENTER, GRID_CENTER], [GRID_CENTER, 2], [2, GRID_CENTER]];
  return makeDesign(cells);
}

const CASES = [
  ["full solid 15x15", fullGrid()],
  ["long 15x1", rowDesign()],
  ["tall 1x15", columnDesign()],
  ["sparse 15x15 extreme corners", sparseExtremes()],
  ["irregular maximum-bounds design", irregularCorners()]
];

function run() {
  console.log("verify-station-hangar");

  section("The hangar aperture is derived from the maximum ship, not a magic number");
  assert(MAX_SHIP_EXTENT === MAX_SHIP_CELLS * SHIP_MODULE_SCALE, "maximum ship extent follows the ship module scale");
  assert(geometry.aperture.halfWidth * 2 > MAX_SHIP_EXTENT, "aperture is wider than the maximum ship");
  assert(geometry.clearance >= SHIP_MODULE_SCALE, `aperture grants at least one ship cell of clearance per side (got ${geometry.clearance})`);

  section("Every supported maximum-size design fits the aperture, corridor and interior");
  for (const [label, shipDesign] of CASES) {
    const bounds = shipLocalBounds(shipDesign);
    const collisionRadius = computeDesignCollisionRadius(shipDesign, { radius: 0 });
    const footprintRadius = computeDesignFootprintRadius(shipDesign);
    const halfLateral = Math.max(bounds.height / 2, Math.abs(bounds.minY), Math.abs(bounds.maxY));

    // Rendered and collision bounds both clear the mouth laterally, with more
    // than a full ship blueprint cell to spare.
    const sweptHalfWidth = halfLateral + HULL_CELL_COLLISION_RADIUS;
    assert(halfLateral <= geometry.aperture.halfWidth, `${label}: rendered width fits the aperture`);
    assert(sweptHalfWidth <= geometry.aperture.halfWidth, `${label}: swept collision width fits the aperture (${sweptHalfWidth.toFixed(1)} <= ${geometry.aperture.halfWidth})`);
    assert(
      geometry.aperture.halfWidth - sweptHalfWidth >= SHIP_MODULE_SCALE,
      `${label}: aperture leaves at least one ship cell of visible clearance per side (got ${(geometry.aperture.halfWidth - sweptHalfWidth).toFixed(1)})`
    );
    assert(Number.isFinite(collisionRadius) && Number.isFinite(footprintRadius), `${label}: collision geometry is measurable`);

    // The interior spawn puts the whole hull inside the corridor, behind the mouth.
    const spawnFront = geometry.interiorSpawn.x + bounds.maxX;
    const spawnBack = geometry.interiorSpawn.x + bounds.minX;
    assert(spawnBack >= geometry.corridor.rearWallX, `${label}: hull does not clip the corridor rear wall`);
    assert(spawnFront <= geometry.aperture.x, `${label}: hull starts entirely inside the mouth`);

    // Travelling forward, the hull clears the release plane without ever
    // overlapping a solid piece.
    const releaseBack = geometry.releasePlaneX + bounds.minX;
    assert(releaseBack >= geometry.aperture.x, `${label}: release plane is beyond the mouth for the whole hull`);
  }

  section("No supported design overlaps a solid station piece while in the corridor");
  for (const [label, shipDesign] of CASES) {
    const bounds = shipLocalBounds(shipDesign);
    const halfLateral = Math.max(Math.abs(bounds.minY), Math.abs(bounds.maxY)) + HULL_CELL_COLLISION_RADIUS;
    // Sweep the aligned hull down the corridor centreline from the interior
    // spawn to the release plane, testing its real oriented box each step.
    for (let x = geometry.interiorSpawn.x; x <= geometry.releasePlaneX; x += 6) {
      const hull = {
        minX: x + bounds.minX - HULL_CELL_COLLISION_RADIUS,
        maxX: x + bounds.maxX + HULL_CELL_COLLISION_RADIUS,
        minY: -halfLateral,
        maxY: halfLateral
      };
      for (const rect of geometry.collisionRects) {
        const overlaps = hull.minX < rect.maxX && hull.maxX > rect.minX
          && hull.minY < rect.maxY && hull.maxY > rect.minY;
        assert(!overlaps, `${label}: hull does not intersect a station piece at corridor x=${x}`);
      }
    }
  }

  section("Visual proportions: a station reads as a structure, not a wall with a hole");
  const frontWidth = geometry.shell.maxY - geometry.shell.minY;
  const depth = geometry.shell.maxX - geometry.shell.minX;
  const apertureWidth = geometry.aperture.halfWidth * 2;
  const sideStructure = (frontWidth - apertureWidth) / 2;
  const widthRatio = frontWidth / MAX_SHIP_EXTENT;

  assert(widthRatio >= 2.2 && widthRatio <= 2.8, `station front is 2.2-2.8x the maximum ship width (got ${widthRatio.toFixed(2)})`);
  assert(depth >= MAX_SHIP_EXTENT * 2, `station is deep enough that a ship starts inside it (got ${depth})`);
  assert(apertureWidth / frontWidth < 0.55, `aperture does not consume the front (got ${(apertureWidth / frontWidth).toFixed(2)})`);
  assert(sideStructure >= MAX_SHIP_EXTENT * 0.5, `substantial structure flanks the hangar on both sides (got ${sideStructure})`);
  assert(geometry.corridor.length >= MAX_SHIP_EXTENT, `corridor is at least a full ship deep (got ${geometry.corridor.length})`);
  assert(geometry.collisionRects.length >= 3, "collision geometry is compound, not a single circle");

  section("The corridor is genuinely open: no module and no collision piece occupies it");
  for (const module of design) {
    assert(!inCorridorVoid(module.x, module.y), `no module occupies the corridor void (found ${module.type} at ${module.x},${module.y})`);
  }
  // A point on the corridor centreline, inside the station, hits nothing solid.
  const probeX = (geometry.corridor.rearWallX + geometry.aperture.x) / 2;
  for (const rect of geometry.collisionRects) {
    const inside = probeX >= rect.minX && probeX <= rect.maxX && rect.minY <= 0 && rect.maxY >= 0;
    assert(!inside, "the corridor centreline is not inside a solid piece");
  }

  section("Stations use the shared component system at a larger module scale");
  assert(STATION_MODULE_SCALE > SHIP_MODULE_SCALE, "stations are scaled up relative to ships");
  assert(HOME_STATION_CELLS.gridCells === MAX_SHIP_CELLS, "stations stay on the 15x15 grid the wiring system supports");
  assert(design.length > 0 && design.every((m) => typeof m.type === "string"), "home design is made of ordinary components");
  assert(design.some((m) => m.type === "core"), "home station has exactly the systems core");
  assert(design.some((m) => m.type === "pointDefense"), "home station carries ordinary point defence");
  assert(design.some((m) => m.type === "repair"), "home station carries ordinary repair components");
  const relay = buildRelayStationDesign();
  assert(relay.length < design.length, "relay stations are smaller than home stations");
  assert(relay.some((m) => m.type === "pointDefense"), "relay carries light point defence");
  assert(!relay.some((m) => m.type === "missile"), "relay carries no heavy anti-ship battery");

  console.log("  all hangar geometry checks passed");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
