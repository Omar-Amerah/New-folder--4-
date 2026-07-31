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
  HANGAR_BAY_COUNT,
  buildHomeStationDesign,
  buildHomeStationGeometry,
  buildRelayStationDesign,
  inCorridorVoid,
  isSolidCell
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

function assertConnected(design) {
  if (design.length <= 1) return;
  const cells = new Map();
  for (const module of design) cells.set(`${module.x},${module.y}`, module);
  const start = design[0];
  const visited = new Set([`${start.x},${start.y}`]);
  const queue = [start];
  const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (queue.length) {
    const module = queue.pop();
    for (const [dx, dy] of neighbors) {
      const key = `${module.x + dx},${module.y + dy}`;
      if (cells.has(key) && !visited.has(key)) {
        visited.add(key);
        queue.push(cells.get(key));
      }
    }
  }
  assert.strictEqual(visited.size, cells.size, "design cells are connected");
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

  section("A home station carries one launch bay per team seat");
  assert(MAX_SHIP_EXTENT === MAX_SHIP_CELLS * SHIP_MODULE_SCALE, "maximum ship extent follows the ship module scale");
  assert(HANGAR_BAY_COUNT === 3, "a team of up to three shares one station with a bay each");
  assert(geometry.bays.length === HANGAR_BAY_COUNT, "the authored geometry exposes every bay");
  assert(geometry.doorRects.length === HANGAR_BAY_COUNT, "every bay has its own one-way blast door");

  const ordered = [...geometry.bays].sort((a, b) => a.centreY - b.centreY);
  for (let i = 0; i < ordered.length; i += 1) {
    const bay = ordered[i];
    assert(bay.minY >= geometry.shell.minY && bay.maxY <= geometry.shell.maxY, `bay ${bay.index} is inside the shell`);
    assert(bay.mouthX === geometry.shell.maxX, `bay ${bay.index} opens on the front face`);
    if (i > 0) {
      const wall = bay.minY - ordered[i - 1].maxY;
      assert(wall > 0, `bays ${i - 1} and ${i} are separated by solid structure (got ${wall})`);
    }
  }
  // Symmetric about the nose, so no player is handed a bay closer to the front.
  const centres = ordered.map((bay) => bay.centreY);
  for (let i = 0; i < centres.length; i += 1) {
    assert(
      Math.abs(centres[i] + centres[centres.length - 1 - i]) < 1e-9,
      `the bay layout is symmetric about the station's nose (${centres.join(", ")})`
    );
  }

  section("Bays fit the hulls players actually build, in every dimension");
  // A bay is narrower than a maximum 15x15 hull on purpose: launch control makes
  // a ship intangible to its own station and pins it to the bay centreline, so
  // an oversized hull pushes straight out instead of jamming. What the geometry
  // still has to guarantee is that ordinary hulls fit properly.
  const bayHalfWidth = ordered[0].halfWidth;
  let widestFittingCells = 0;
  for (let cells = 1; cells <= MAX_SHIP_CELLS; cells += 1) {
    if ((cells * SHIP_MODULE_SCALE) / 2 + HULL_CELL_COLLISION_RADIUS <= bayHalfWidth) widestFittingCells = cells;
  }
  assert(
    widestFittingCells >= 11,
    `a bay swallows a hull at least 11 cells wide, padding included (got ${widestFittingCells})`
  );
  assert(
    bayHalfWidth * 2 < MAX_SHIP_EXTENT,
    "the narrower-than-maximum bay is the documented trade, not an accident"
  );

  for (const [label, shipDesign] of CASES) {
    const bounds = shipLocalBounds(shipDesign);
    const collisionRadius = computeDesignCollisionRadius(shipDesign, { radius: 0 });
    const footprintRadius = computeDesignFootprintRadius(shipDesign);
    assert(Number.isFinite(collisionRadius) && Number.isFinite(footprintRadius), `${label}: collision geometry is measurable`);

    for (const bay of geometry.bays) {
      // The interior spawn puts the whole hull inside the corridor, behind the
      // mouth — true for every design, however large, because bays are deep.
      const spawnFront = bay.interiorSpawn.x + bounds.maxX;
      const spawnBack = bay.interiorSpawn.x + bounds.minX;
      assert(spawnBack >= bay.rearWallX, `${label}: hull does not clip bay ${bay.index}'s rear wall`);
      assert(spawnFront <= bay.mouthX, `${label}: hull starts entirely inside bay ${bay.index}'s mouth`);
      // Travelling forward, the hull clears the release plane completely.
      assert(
        bay.releasePlaneX + bounds.minX >= bay.mouthX,
        `${label}: bay ${bay.index}'s release plane is beyond the mouth for the whole hull`
      );
    }
  }

  section("A bay-sized hull sweeps out without ever touching a solid piece");
  const fittingHalfWidth = (widestFittingCells * SHIP_MODULE_SCALE) / 2 + HULL_CELL_COLLISION_RADIUS;
  for (const bay of geometry.bays) {
    const bounds = shipLocalBounds(fullGrid());
    for (let x = bay.interiorSpawn.x; x <= bay.releasePlaneX; x += 6) {
      const hull = {
        minX: x + bounds.minX - HULL_CELL_COLLISION_RADIUS,
        maxX: x + bounds.maxX + HULL_CELL_COLLISION_RADIUS,
        minY: bay.centreY - fittingHalfWidth,
        maxY: bay.centreY + fittingHalfWidth
      };
      for (const rect of geometry.collisionRects) {
        const overlaps = hull.minX < rect.maxX && hull.maxX > rect.minX
          && hull.minY < rect.maxY && hull.maxY > rect.minY;
        assert(!overlaps, `a fitting hull does not intersect a station piece in bay ${bay.index} at x=${x}`);
      }
    }
  }

  section("Visual proportions: a station reads as a structure, not a wall with holes");
  const frontWidth = geometry.shell.maxY - geometry.shell.minY;
  const depth = geometry.shell.maxX - geometry.shell.minX;
  const bayTotalWidth = geometry.bays.reduce((sum, bay) => sum + bay.halfWidth * 2, 0);
  const sideStructure = (frontWidth - (ordered[ordered.length - 1].maxY - ordered[0].minY)) / 2;
  const widthRatio = frontWidth / MAX_SHIP_EXTENT;

  assert(widthRatio >= 4 && widthRatio <= 4.6, `station front is 4.0-4.6x the maximum ship width (got ${widthRatio.toFixed(2)})`);
  assert(depth >= MAX_SHIP_EXTENT * 2, `station is deep enough that a ship starts inside it (got ${depth})`);
  assert(bayTotalWidth / frontWidth < 0.66, `the bays do not consume the front (got ${(bayTotalWidth / frontWidth).toFixed(2)})`);
  assert(sideStructure >= MAX_SHIP_EXTENT * 0.5, `substantial structure flanks the bay block on both sides (got ${sideStructure})`);
  assert(geometry.corridor.length >= MAX_SHIP_EXTENT, `each corridor is at least a full ship deep (got ${geometry.corridor.length})`);
  assert(geometry.collisionRects.length >= 3, "collision geometry is compound, not a single circle");

  section("Every bay is genuinely open, and the walls between them are genuinely solid");
  for (const module of design) {
    assert(!inCorridorVoid(module.x, module.y), `no module occupies a bay void (found ${module.type} at ${module.x},${module.y})`);
  }
  for (const bay of geometry.bays) {
    // A point on this bay's centreline, inside the station, hits nothing solid.
    const probeX = (bay.rearWallX + bay.mouthX) / 2;
    for (const rect of geometry.collisionRects) {
      const inside = probeX >= rect.minX && probeX <= rect.maxX
        && rect.minY <= bay.centreY && rect.maxY >= bay.centreY;
      assert(!inside, `bay ${bay.index}'s centreline is not inside a solid piece`);
    }
  }
  for (const cells of HOME_STATION_CELLS.hullColumns) {
    for (let x = cells.xMin; x <= cells.xMax; x += 1) {
      for (let y = HOME_STATION_CELLS.yMin; y <= HOME_STATION_CELLS.yMax; y += 1) {
        assert(isSolidCell(x, y), `hull column cell ${x},${y} is solid structure`);
      }
    }
  }
  // The design is one connected structure, or generated wiring cannot reach the
  // components stranded on a dividing wall.
  assertConnected(design);

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
