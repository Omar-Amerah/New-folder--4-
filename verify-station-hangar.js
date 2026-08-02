"use strict";

// Single home-station geometry acceptance tests. All dimensions are read from
// the production template and the same collision/placement helpers used by the
// server; this file intentionally does not maintain a second station model.

const assert = require("assert");
const {
  SHIP_MODULE_SCALE,
  STATION_MODULE_SCALE,
  MAX_SHIP_CELLS,
  MAX_SHIP_EXTENT,
  GRID_CENTER,
  HULL_CELL_PADDING,
  HOME_STATION_CELLS,
  buildHomeStationDesign,
  buildHomeStationGeometry,
  buildRelayStationDesign,
  buildRelayStationGeometry,
  inCorridorVoid
} = require("./src/server/stationTemplates");
const { computeDesignCollisionRadius, computeDesignFootprintRadius } = require("./src/server/componentGeometry");
const { computeStationShieldCollisionRadius, segmentStationHullHit, isSegmentStationClear } = require("./src/server/stationCollision");
const { stationBroadPhaseRadius } = require("./src/server/spatialIndex");
const { createRoom } = require("./src/server/rooms");
const { createStationsForRoom } = require("./src/server/stations");
const { planSpawnRegions } = require("./src/server/spawnPlanner");

const HULL_CELL_COLLISION_RADIUS = SHIP_MODULE_SCALE * Math.SQRT2 / 2;
const geometry = buildHomeStationGeometry();
const design = buildHomeStationDesign();

function section(label) {
  console.log(`  ${label}`);
}

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
  for (let y = 0; y < MAX_SHIP_CELLS; y += 1) {
    for (let x = 0; x < MAX_SHIP_CELLS; x += 1) cells.push([x, y]);
  }
  return makeDesign(cells);
}

function assertConnected(value) {
  if (value.length <= 1) return;
  const cells = new Map(value.map((module) => [`${module.x},${module.y}`, module]));
  const start = value[0];
  const visited = new Set([`${start.x},${start.y}`]);
  const queue = [start];
  while (queue.length) {
    const module = queue.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const key = `${module.x + dx},${module.y + dy}`;
      if (cells.has(key) && !visited.has(key)) {
        visited.add(key);
        queue.push(cells.get(key));
      }
    }
  }
  assert.strictEqual(visited.size, cells.size, "home station components stay connected around the corridor");
}

function makeStationRoom(playerCount = 3) {
  const room = createRoom(`station-hangar-${playerCount}`, { seed: 0x51a7 });
  room.rules.infrastructureMode = "stations";
  room.rules.gameMode = "team";
  room.map = { ...room.map, asteroids: [], relays: [], safeZones: [] };
  for (let i = 0; i < playerCount; i += 1) {
    room.players.set(`p${i + 1}`, {
      id: `p${i + 1}`,
      name: `P${i + 1}`,
      team: "blue",
      removed: false,
      ready: true,
      isBot: false,
      ships: [],
      shipCap: 10
    });
  }
  return room;
}

function run() {
  console.log("verify-station-hangar");

  section("The home station is the authored single-corridor structure");
  assert.strictEqual(STATION_MODULE_SCALE, 36, "home station module scale is exactly 36");
  assert.strictEqual(geometry.moduleScale, 36, "home station geometry uses scale 36");
  assert.strictEqual(MAX_SHIP_EXTENT, MAX_SHIP_CELLS * SHIP_MODULE_SCALE, "maximum ship extent follows ship scale");
  assert.strictEqual(HOME_STATION_CELLS.gridCells, 15, "home station stays on the 15x15 grid");
  assert.strictEqual(HOME_STATION_CELLS.apertureCells, 7, "aperture is seven cells wide");
  assert.strictEqual(HOME_STATION_CELLS.apertureXMin, 4, "aperture starts at cell 4");
  assert.strictEqual(HOME_STATION_CELLS.apertureXMax, 10, "aperture ends at cell 10");
  assert.strictEqual(geometry.collisionRects.length, 3, "left, right and rear hull pieces form the shell");
  assert.strictEqual(geometry.collisionRects.some((rect) => rect.minY < 0 && rect.maxY > 0 && rect.minX > geometry.corridor.rearWallX), false, "no dividing wall seals the corridor");

  const shellWidth = geometry.shell.maxX - geometry.shell.minX;
  const shellHeight = geometry.shell.maxY - geometry.shell.minY;
  assert.strictEqual(shellWidth, 540, "home station shell is 540 world units wide");
  assert.strictEqual(shellHeight, 540, "home station shell is 540 world units high");
  assert.strictEqual(geometry.aperture.maxY - geometry.aperture.minY, 7 * STATION_MODULE_SCALE, "aperture width is seven station cells");
  assert.strictEqual(geometry.aperture.minY + geometry.aperture.maxY, 0, "aperture is centred laterally");
  assert.strictEqual(geometry.corridor.halfWidth, (7 * STATION_MODULE_SCALE) / 2, "corridor half-width follows the aperture");
  assert(geometry.corridor.length >= MAX_SHIP_EXTENT, "corridor is at least one maximum ship deep");
  assert(!Array.isArray(geometry.bays), "geometry has one authored hangar record, not a bay array");
  assert(!Array.isArray(geometry.doorRects), "geometry has one authored aperture door");
  assert(geometry.doorRect && geometry.aperture && geometry.corridor, "single aperture and corridor records are present");

  section("Every authored component stays out of the open corridor");
  for (const module of design) {
    assert(!inCorridorVoid(module.x, module.y), `no component occupies the corridor at ${module.x},${module.y}`);
  }
  assertConnected(design);

  section("Maximum-size hulls clear the central launch path");
  const maximumBounds = shipLocalBounds(fullGrid());
  const paddedHalfWidth = maximumBounds.width / 2 + HULL_CELL_PADDING;
  assert(geometry.clearance > 0, "the seven-cell aperture clears the maximum padded hull");
  const spawn = geometry.interiorSpawn.x;
  assert(spawn + maximumBounds.minX - HULL_CELL_COLLISION_RADIUS >= geometry.corridor.rearWallX, "maximum hull starts beyond the rear wall");
  assert(spawn + maximumBounds.maxX + HULL_CELL_COLLISION_RADIUS <= geometry.aperture.x, "maximum hull starts behind the aperture");
  for (let x = spawn; x <= geometry.releasePlaneX; x += 6) {
    const hull = {
      minX: x + maximumBounds.minX - HULL_CELL_COLLISION_RADIUS,
      maxX: x + maximumBounds.maxX + HULL_CELL_COLLISION_RADIUS,
      minY: -paddedHalfWidth,
      maxY: paddedHalfWidth
    };
    for (const rect of geometry.collisionRects) {
      const overlaps = hull.minX < rect.maxX && hull.maxX > rect.minX
        && hull.minY < rect.maxY && hull.maxY > rect.minY;
      assert(!overlaps, `maximum hull clears the solid shell at local x=${x}`);
    }
  }

  section("Station entity, shield and broad phase use the same geometry");
  const room = makeStationRoom(3);
  room.map.safeZones = [{ id: "blue-home", x: 1100, y: 1000, team: "blue", ownerId: "p1" }];
  createStationsForRoom(room, 0);
  const station = room.stations.find((entry) => entry.stationType === "home");
  assert(station, "team has a home station");
  assert(station.hangar && !Array.isArray(station.hangar), "station exposes one central hangar object");
  assert.strictEqual(station.hangars, undefined, "station does not retain a multi-hangar field");
  assert.strictEqual(station.bayPlayerSlots, undefined, "station does not retain per-player bay assignment");
  const lateralOffset = (point) => -(point.x - station.x) * Math.sin(station.angle) + (point.y - station.y) * Math.cos(station.angle);
  assert(Math.abs(lateralOffset(station.hangar.interiorSpawn)) < 1e-9, "hangar spawn is on the station centreline");
  assert(Math.abs(lateralOffset(station.hangar.mouth)) < 1e-9, "hangar mouth is on the station centreline");
  assert.strictEqual(station.collisionPieces.filter((piece) => !piece.door).length, 3, "solid collision remains compound");
  assert(Math.abs(station.shieldRadius - computeStationShieldCollisionRadius(station)) < 1e-9, "shield radius is derived from the solid pieces");
  assert(station.shieldRadius < 500, "shield radius is not from the former oversized station");
  assert(stationBroadPhaseRadius(station) >= station.radius, "broad phase encloses the station shell");
  assert(station.radius < 500, "station broad-phase source radius matches the 540-unit shell");

  const heading = station.angle;
  const along = (distance) => ({ x: station.x + Math.cos(heading) * distance, y: station.y + Math.sin(heading) * distance });
  const corridorStart = along(geometry.interiorSpawn.x + 20);
  const release = along(geometry.releasePlaneX + 20);
  assert(!segmentStationHullHit(station, corridorStart.x, corridorStart.y, release.x, release.y), "central aperture is open to hull travel");
  assert(isSegmentStationClear(room, corridorStart.x, corridorStart.y, release.x, release.y, 0, { ignoreDoors: true }), "central launch path is clear when the one-way door is ignored");
  const sideStart = { x: station.x - 320 * Math.cos(heading) + 200 * Math.sin(heading), y: station.y - 320 * Math.sin(heading) - 200 * Math.cos(heading) };
  const sideEnd = { x: station.x + 320 * Math.cos(heading) + 200 * Math.sin(heading), y: station.y + 320 * Math.sin(heading) - 200 * Math.cos(heading) };
  assert(segmentStationHullHit(station, sideStart.x, sideStart.y, sideEnd.x, sideEnd.y), "solid side hull remains collidable");

  section("Spawn regions fit the restored footprint for team rosters");
  const regionPlan = planSpawnRegions(makeStationRoom(3));
  assert(regionPlan.safeZones.length === 1, "three players on one team share one station region");
  const region = regionPlan.safeZones[0];
  assert(region.radius >= Math.hypot(shellWidth, shellHeight) / 2 + 40, "team region contains the restored station");
  assert(region.radius < 500, "team region does not reserve the former 840-unit footprint");

  section("Current component and relay systems remain intact");
  assert(design.length > 0 && design.every((module) => typeof module.type === "string"), "home design uses ordinary components");
  assert(design.some((module) => module.type === "core"), "home station has a systems core");
  assert(design.some((module) => module.type === "pointDefense"), "home station keeps point defence");
  assert(design.some((module) => module.type === "repair"), "home station keeps repair components");
  const relay = buildRelayStationDesign();
  assert(relay.length < design.length, "relay stations remain smaller");
  assert(relay.some((module) => module.type === "pointDefense"), "relay keeps point defence");
  assert(!relay.some((module) => module.type === "missile"), "relay keeps its light weapon layout");
  const relayGeometry = buildRelayStationGeometry();
  assert.strictEqual(relayGeometry.moduleScale, 20, "relay module scale remains unchanged");
  assert(Number.isFinite(computeDesignCollisionRadius(design, { radius: 0 })), "station collision geometry remains measurable");
  assert(Number.isFinite(computeDesignFootprintRadius(design)), "station footprint geometry remains measurable");

  console.log("  all single-hangar geometry checks passed");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
