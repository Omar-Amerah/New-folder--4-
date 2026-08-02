"use strict";

// Authoritative acceptance checks for the three-side home launch-bay revision.
// Geometry comes directly from stationTemplates and runtime placement comes
// from the station entity; this verifier does not maintain a second layout.

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
  inLaunchBayVoid
} = require("./src/server/stationTemplates");
const { computeDesignCollisionRadius, computeDesignFootprintRadius } = require("./src/server/componentGeometry");
const { computeStationShieldCollisionRadius, segmentStationHullHit, isSegmentStationClear } = require("./src/server/stationCollision");
const { stationBroadPhaseRadius } = require("./src/server/spatialIndex");
const { createRoom } = require("./src/server/rooms");
const { createStationsForRoom } = require("./src/server/stations");
const { planSpawnRegions } = require("./src/server/spawnPlanner");

function section(label) {
  console.log(`  ${label}`);
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

function assertConnected(design) {
  const cells = new Map(design.map((module) => [`${module.x},${module.y}`, module]));
  const start = design[0];
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
  assert.strictEqual(visited.size, cells.size, "home station components stay connected around the launch voids");
}

function makeStationRoom({ blue = 3, red = 1, id = "station-bays" } = {}) {
  const room = createRoom(id, { seed: 0x51a7 });
  room.rules.infrastructureMode = "stations";
  room.rules.gameMode = "teams";
  room.map = {
    ...room.map,
    asteroids: [],
    relays: [],
    safeZones: [
      { id: "blue-home", x: 1100, y: 1000, radius: 360, team: "blue" },
      { id: "red-home", x: room.world.width - 1100, y: room.world.height - 1000, radius: 360, team: "red" }
    ]
  };
  for (let i = 0; i < blue; i += 1) {
    const idValue = `blue-${i + 1}`;
    room.players.set(idValue, {
      id: idValue,
      name: idValue,
      team: "blue",
      removed: false,
      ready: true,
      isBot: false,
      ships: [],
      shipCap: 10
    });
  }
  for (let i = 0; i < red; i += 1) {
    const idValue = `red-${i + 1}`;
    room.players.set(idValue, {
      id: idValue,
      name: idValue,
      team: "red",
      removed: false,
      ready: true,
      isBot: false,
      ships: [],
      shipCap: 10
    });
  }
  return room;
}

function localToWorld(station, point) {
  const cos = Math.cos(station.angle);
  const sin = Math.sin(station.angle);
  return {
    x: station.x + point.x * cos - point.y * sin,
    y: station.y + point.x * sin + point.y * cos
  };
}

function run() {
  console.log("verify-station-hangar");
  const geometry = buildHomeStationGeometry();
  const design = buildHomeStationDesign();

  section("The home station uses the compact three-side authored shell");
  assert.strictEqual(STATION_MODULE_SCALE, 36, "home station module scale is exactly 36");
  assert.strictEqual(geometry.moduleScale, 36, "home station geometry uses scale 36");
  assert.strictEqual(HOME_STATION_CELLS.gridCells, 15, "home station stays on the 15x15 grid");
  assert.strictEqual(HOME_STATION_CELLS.launchBayCount, 3, "home station has exactly three launch bays");
  assert.deepStrictEqual(HOME_STATION_CELLS.launchBayIds, ["forward", "upper", "lower"], "launch-bay ids are stable");
  assert.strictEqual(HOME_STATION_CELLS.apertureCells, 7, "each aperture is seven cells wide");
  assert.strictEqual(HOME_STATION_CELLS.apertureXMin, 4, "forward aperture starts at cell 4");
  assert.strictEqual(HOME_STATION_CELLS.apertureXMax, 10, "forward aperture ends at cell 10");
  assert.strictEqual(geometry.collisionRects.length, 4, "connected shell is four solid hull pieces around three voids");
  assert.strictEqual(geometry.launchBays.length, 3, "geometry contains one static record per authored launch bay");
  assert.deepStrictEqual(geometry.launchBays.map((bay) => bay.id), ["forward", "upper", "lower"], "geometry order is deterministic");

  const shellWidth = geometry.shell.maxX - geometry.shell.minX;
  const shellHeight = geometry.shell.maxY - geometry.shell.minY;
  assert.strictEqual(shellWidth, 540, "home station shell is 540 world units wide");
  assert.strictEqual(shellHeight, 540, "home station shell is 540 world units high");
  for (const bay of geometry.launchBays) {
    assert.strictEqual(bay.apertureWidth, 7 * STATION_MODULE_SCALE, `${bay.id} aperture is seven station cells wide`);
    assert(bay.corridorDepth >= 7 * STATION_MODULE_SCALE, `${bay.id} corridor is seven cells deep`);
    assert(bay.clearance > 0, `${bay.id} clears the maximum legal ship envelope`);
    assert(bay.releaseDistance > 0, `${bay.id} has an outward release plane`);
  }
  assert.deepStrictEqual(geometry.launchBays.map((bay) => bay.localNormal), [
    { x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 }
  ], "forward, upper and lower bays point out of their respective faces");

  for (let i = 0; i < geometry.launchBays.length; i += 1) {
    for (let j = i + 1; j < geometry.launchBays.length; j += 1) {
      const a = geometry.launchBays[i].collisionOpening;
      const b = geometry.launchBays[j].collisionOpening;
      const overlaps = a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
      assert(!overlaps, `launch openings ${geometry.launchBays[i].id} and ${geometry.launchBays[j].id} do not overlap`);
    }
  }

  section("Authored components avoid all launch voids and remain connected");
  for (const module of design) {
    assert(!inLaunchBayVoid(module.x, module.y), `no component occupies a launch void at ${module.x},${module.y}`);
  }
  assertConnected(design);

  section("Maximum-size hulls clear every launch aperture");
  const maximumShip = fullGrid();
  const maximumHalfExtent = MAX_SHIP_EXTENT / 2 + HULL_CELL_PADDING;
  for (const bay of geometry.launchBays) {
    assert(bay.apertureHalfWidth > maximumHalfExtent, `${bay.id} lateral clearance fits the maximum padded hull`);
    assert(bay.corridorLength > MAX_SHIP_EXTENT + HULL_CELL_PADDING, `${bay.id} depth fits the maximum padded hull`);
    assert(computeDesignCollisionRadius(maximumShip, { radius: 0 }) > 0, "maximum ship collision radius is measurable");
  }

  section("Station entity, assignments, shield and broad phase use the same geometry");
  const room = makeStationRoom({ blue: 3, red: 2 });
  createStationsForRoom(room, 0);
  const station = room.stations.find((entry) => entry.stationType === "home" && entry.team === "blue");
  assert(station, "team has a home station");
  assert.strictEqual(station.moduleScale, 36, "home station entity reports module scale 36");
  assert(Array.isArray(station.launchBays) && station.launchBays.length === 3, "station exposes exactly three authoritative launch bays");
  assert.strictEqual(station.hangar, undefined, "station has no singular compatibility hangar field");
  assert.strictEqual(station.hangars, undefined, "station has no plural compatibility hangar field");
  assert(station.launchBayAssignments instanceof Map, "bay assignments are runtime-only match state");
  assert.deepStrictEqual(
    ["blue-1", "blue-2", "blue-3"].map((id) => station.launchBayAssignments.get(id)),
    ["upper", "forward", "lower"],
    "three active players receive stable upper/forward/lower assignments"
  );
  const exactDurability = 8000 * 2;
  assert.strictEqual(station.maxShield, exactDurability, "home shield is 8,000 per opposing player");
  assert.strictEqual(station.shield, exactDurability, "home shield starts at the exact match durability");
  assert.strictEqual(station.maxHp, exactDurability, "home hull is 8,000 per opposing player");
  assert.strictEqual(station.hp, exactDurability, "home hull starts at the exact match durability");
  assert.strictEqual(station.shieldScale, undefined, "home durability does not retain a scale multiplier");
  assert.strictEqual(station.hullScale, undefined, "home durability does not retain a scale multiplier");

  for (const bay of station.launchBays) {
    const lateral = bay.worldNormal.x !== 0 ? { x: 0, y: 1 } : { x: 1, y: 0 };
    const centreOffset = { x: bay.worldCentre.x - station.x, y: bay.worldCentre.y - station.y };
    assert(Math.abs(centreOffset.x * lateral.x + centreOffset.y * lateral.y) < 1e-9, `${bay.id} remains centred on its face`);
    assert.strictEqual(bay.occupyingShipId, null, `${bay.id} starts unoccupied`);
  }
  assert.strictEqual(station.collisionPieces.filter((piece) => !piece.door).length, 4, "solid collision remains compound");
  assert.strictEqual(station.collisionPieces.filter((piece) => piece.door).length, 3, "each bay has one launch door piece");
  assert(Math.abs(station.shieldRadius - computeStationShieldCollisionRadius(station)) < 1e-9, "shield radius is derived from the solid pieces");
  assert(station.shieldRadius < 500, "shield radius is not from the former oversized station");
  assert(stationBroadPhaseRadius(station) >= station.radius, "broad phase encloses every solid piece");
  assert(station.radius < 500, "station broad phase matches the compact 540-unit shell");

  for (const bay of station.launchBays) {
    const start = localToWorld(station, {
      x: bay.innerWall.x + bay.localNormal.x * 4,
      y: bay.innerWall.y + bay.localNormal.y * 4
    });
    const end = localToWorld(station, {
      x: bay.releasePlane.x + bay.localNormal.x * 4,
      y: bay.releasePlane.y + bay.localNormal.y * 4
    });
    assert.strictEqual(segmentStationHullHit(station, start.x, start.y, end.x, end.y), null, `${bay.id} path is open through the shell`);
    assert(isSegmentStationClear(room, start.x, start.y, end.x, end.y, 0, { ignoreDoors: true }), `${bay.id} navigation path is open`);
  }
  const sideStart = localToWorld(station, { x: 1000, y: -200 });
  const sideEnd = localToWorld(station, { x: -1000, y: -200 });
  assert(segmentStationHullHit(station, sideStart.x, sideStart.y, sideEnd.x, sideEnd.y), "solid hull remains collidable beside a launch opening");

  section("Assignments stay deterministic for one and two active players");
  for (const [count, expected] of [[1, ["forward"]], [2, ["upper", "lower"]]]) {
    const smallRoom = makeStationRoom({ blue: count, red: 1, id: `station-bays-${count}` });
    createStationsForRoom(smallRoom, 0);
    const small = smallRoom.stations.find((entry) => entry.stationType === "home" && entry.team === "blue");
    assert.deepStrictEqual(
      Array.from({ length: count }, (_, index) => small.launchBayAssignments.get(`blue-${index + 1}`)),
      expected,
      `${count}-player team uses the documented stable bay assignment`
    );
  }

  section("Spawn regions fit the restored footprint");
  const regionPlan = planSpawnRegions(makeStationRoom({ blue: 3, red: 2, id: "station-spawn" }));
  const blueRegion = regionPlan.safeZones.find((zone) => zone.team === "blue");
  assert(blueRegion, "team spawn region exists");
  assert(blueRegion.radius >= Math.hypot(shellWidth, shellHeight) / 2 + 40, "team region contains the restored station");
  assert(blueRegion.radius < 500, "team region does not reserve the former oversized footprint");

  section("Relay geometry and current component systems remain intact");
  const relay = buildRelayStationDesign();
  assert(relay.length < design.length, "relay stations remain smaller");
  assert(relay.some((module) => module.type === "pointDefense"), "relay keeps point defence");
  assert(!relay.some((module) => module.type === "missile"), "relay keeps its light weapon layout");
  const relayGeometry = buildRelayStationGeometry();
  assert.strictEqual(relayGeometry.moduleScale, 20, "relay module scale remains unchanged");
  assert(Number.isFinite(computeDesignCollisionRadius(design, { radius: 0 })), "station collision geometry remains measurable");
  assert(Number.isFinite(computeDesignFootprintRadius(design)), "station footprint geometry remains measurable");

  console.log("  all launch-bay geometry checks passed");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
