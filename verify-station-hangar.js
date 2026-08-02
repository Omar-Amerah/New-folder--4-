"use strict";

// Acceptance checks for the restored pre-multi-hangar home station. Geometry
// comes directly from stationTemplates and runtime placement comes from the
// station entity; this verifier maintains no second layout.

const assert = require("assert");
const {
  SHIP_MODULE_SCALE,
  STATION_MODULE_SCALE,
  MAX_SHIP_CELLS,
  MAX_SHIP_EXTENT,
  HULL_CELL_PADDING,
  HOME_STATION_CELLS,
  buildHomeStationDesign,
  buildHomeStationGeometry,
  buildRelayStationDesign,
  buildRelayStationGeometry,
  inCorridorVoid
} = require("./src/server/stationTemplates");
const { PARTS } = require("./src/server/components");
const { computeDesignCollisionRadius, computeDesignFootprintRadius } = require("./src/server/componentGeometry");
const { computeStationShieldCollisionRadius, segmentStationHullHit, isSegmentStationClear, stationAttackPoint } = require("./src/server/stationCollision");
const { stationBroadPhaseRadius } = require("./src/server/spatialIndex");
const { createRoom } = require("./src/server/rooms");
const {
  createStationsForRoom,
  enqueueStationProduction,
  updateStations,
  resolveStationCollision
} = require("./src/server/stations");
const { pickWeaponFireTarget, targetCoreAimWorldPosition } = require("./src/server/combat");
const { buildSharedSnapshot } = require("./src/server/snapshots");
const { computeStats } = require("./src/server/shipStats");
const { canonicalBlueprintSignature, getOrCreateTemplate } = require("./src/server/shipTemplates");
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
  assert.strictEqual(visited.size, cells.size, "home station components stay connected around the hangar");
}

function makeStationRoom({ blue = 3, red = 1, id = "station-single-hangar" } = {}) {
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
  for (const [team, count] of [["blue", blue], ["red", red]]) {
    for (let i = 0; i < count; i += 1) {
      const idValue = `${team}-${i + 1}`;
      room.players.set(idValue, {
        id: idValue,
        name: idValue,
        team,
        removed: false,
        ready: true,
        isBot: false,
        ships: [],
        shipCap: 10
      });
    }
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

function homeWeaponCount(design) {
  return design.filter((module) => PARTS[module.type]?.weapon && module.type !== "repairBeam").length;
}

function run() {
  console.log("verify-station-hangar");
  const geometry = buildHomeStationGeometry();
  const design = buildHomeStationDesign();
  const hangar = geometry.hangar;

  section("The home station uses the compact single-hangar shell");
  assert.strictEqual(SHIP_MODULE_SCALE, 13, "ship module scale remains 13");
  assert.strictEqual(STATION_MODULE_SCALE, 36, "home station module scale is exactly 36");
  assert.strictEqual(geometry.moduleScale, 36, "home station geometry uses scale 36");
  assert.strictEqual(HOME_STATION_CELLS.gridCells, 15, "home station stays on the 15x15 grid");
  assert.strictEqual(HOME_STATION_CELLS.hangarCount, 1, "home station has exactly one hangar");
  assert.strictEqual(HOME_STATION_CELLS.apertureCells, 7, "aperture is seven cells wide");
  assert.strictEqual(HOME_STATION_CELLS.apertureXMin, 4, "aperture starts at cell 4");
  assert.strictEqual(HOME_STATION_CELLS.apertureXMax, 10, "aperture ends at cell 10");
  assert.strictEqual(geometry.collisionRects.length, 3, "left, right and rear hull pieces form the shell");
  assert(hangar && hangar.id === "central", "geometry contains one authored central hangar record");
  assert.strictEqual(geometry.launchBays, undefined, "geometry has no authored multi-hangar array");
  assert.strictEqual(hangar.apertureWidth, 7 * STATION_MODULE_SCALE, "aperture is exactly 252 world units");
  assert.strictEqual(hangar.corridorLength, 7 * STATION_MODULE_SCALE, "corridor is seven station cells deep");
  assert.strictEqual(hangar.localCentre.y, 0, "hangar is centred laterally");
  assert.strictEqual(geometry.collisionRects[2].maxX, hangar.corridor.rearWallX, "rear hull begins directly behind the corridor wall");
  assert(geometry.collisionRects[2].maxX - geometry.collisionRects[2].minX >= STATION_MODULE_SCALE, "one complete rear structural tile closes the corridor");

  const shellWidth = geometry.shell.maxX - geometry.shell.minX;
  const shellHeight = geometry.shell.maxY - geometry.shell.minY;
  assert.strictEqual(shellWidth, 540, "home station shell is 540 world units wide");
  assert.strictEqual(shellHeight, 540, "home station shell is 540 world units high");
  assert(hangar.clearance > 0, "maximum-size padded hull clears the aperture");
  assert(hangar.releaseDistance > hangar.mouth.x, "release plane is outside the station mouth");

  section("Authored components avoid the central void and keep the hull connected");
  for (const module of design) {
    assert(!inCorridorVoid(module.x, module.y), `no component occupies the hangar at ${module.x},${module.y}`);
  }
  assertConnected(design);
  assert.strictEqual(homeWeaponCount(design), 10, "home station has ten deliberate outer-wall guns");
  for (const module of design) {
    if (!PARTS[module.type]?.weapon || module.type === "repairBeam") continue;
    assert(
      module.x === 0 || module.x === 14 || module.y === 0 || module.y === 14,
      `home gun ${module.type} stays on an outer wall`
    );
    assert(!inCorridorVoid(module.x, module.y), "home gun never occupies the launch corridor");
  }

  section("Maximum-size hull clears the one aperture");
  const maximumShip = fullGrid();
  const maximumHalfExtent = MAX_SHIP_EXTENT / 2 + HULL_CELL_PADDING;
  assert(hangar.apertureHalfWidth > maximumHalfExtent, "maximum padded hull fits laterally");
  assert(hangar.corridorLength > MAX_SHIP_EXTENT + HULL_CELL_PADDING, "maximum padded hull fits in depth");
  assert(computeDesignCollisionRadius(maximumShip, { radius: 0 }) > 0, "maximum ship collision radius is measurable");

  section("Station entity, shield and broad phase use the same geometry");
  const room = makeStationRoom({ blue: 3, red: 2 });
  createStationsForRoom(room, 0);
  const station = room.stations.find((entry) => entry.stationType === "home" && entry.team === "blue");
  assert(station, "team has a home station");
  assert.strictEqual(station.moduleScale, 36, "home station entity reports module scale 36");
  assert(station.hangar && station.hangar.id === "central", "station exposes one central hangar");
  assert.strictEqual(station.launchBays, undefined, "station has no plural launch-bay field");
  assert.strictEqual(station.launchBayAssignments, undefined, "station has no player-to-bay assignments");
  assert.strictEqual(station.hangars, undefined, "station has no plural compatibility hangar field");
  assert.strictEqual(station.hangar.localCentre.y, 0, "all players share the same centreline");
  const exactDurability = 8000 * 2;
  assert.strictEqual(station.maxShield, exactDurability, "home shield is 8,000 per opposing player");
  assert.strictEqual(station.maxHp, exactDurability, "home hull is 8,000 per opposing player");
  assert.strictEqual(station.collisionPieces.filter((piece) => !piece.door).length, 3, "solid collision remains compound");
  assert.strictEqual(station.collisionPieces.filter((piece) => piece.door).length, 1, "one launch door protects the central mouth");
  assert(Math.abs(station.shieldRadius - computeStationShieldCollisionRadius(station)) < 1e-9, "shield radius is derived from solid pieces");
  assert(station.shieldRadius < 500, "shield radius is not from an oversized station");
  assert(stationBroadPhaseRadius(station) >= station.radius, "broad phase encloses every solid piece");
  assert(station.radius < 500, "station broad phase matches the 540-unit shell");

  section("Station attacks and compound collision preserve the open mouth");
  const attackOrigin = { x: station.x + 900, y: station.y };
  station.shield = station.maxShield;
  const shieldPoint = stationAttackPoint(attackOrigin.x, attackOrigin.y, station);
  assert.strictEqual(shieldPoint.kind, "shield", "live stations expose the shield circumference");
  station.shield = 0;
  const hullPoint = stationAttackPoint(attackOrigin.x, attackOrigin.y, station);
  assert.strictEqual(hullPoint.kind, "hull", "shield-down stations expose solid hull geometry");
  assert(hullPoint.piece && !hullPoint.piece.door, "shield-down attack point never selects the hangar door");
  assert.deepStrictEqual(targetCoreAimWorldPosition(station, attackOrigin.x, attackOrigin.y), hullPoint, "core aim uses shared station collision geometry");
  const hostileStation = room.stations.find((entry) => entry.stationType === "home" && entry.team === "red");
  const focusedShip = { id: "focus-ship", ownerId: "blue-1", team: "blue", alive: true, x: attackOrigin.x, y: attackOrigin.y, focusTargetId: hostileStation.id };
  assert.strictEqual(
    pickWeaponFireTarget(room, focusedShip, [], focusedShip.x, focusedShip.y, hostileStation, 1, { weapon: { type: "missile" } }),
    hostileStation,
    "manual hostile station focus remains exclusive"
  );
  station.shield = station.maxShield;

  const start = localToWorld(station, { x: station.hangar.innerWall.x + 4, y: station.hangar.innerWall.y });
  const end = localToWorld(station, { x: station.hangar.releasePlane.x + 4, y: station.hangar.releasePlane.y });
  assert.strictEqual(segmentStationHullHit(station, start.x, start.y, end.x, end.y), null, "central launch path is open through the shell");
  assert(isSegmentStationClear(room, start.x, start.y, end.x, end.y, 0, { ignoreDoors: true }), "navigation sees the central launch path as open");
  const sideStart = localToWorld(station, { x: 1000, y: -200 });
  const sideEnd = localToWorld(station, { x: -1000, y: -200 });
  assert(segmentStationHullHit(station, sideStart.x, sideStart.y, sideEnd.x, sideEnd.y), "solid side hull remains collidable");

  section("Three players use one deterministic launch centreline");
  const launchRoom = makeStationRoom({ blue: 3, red: 2, id: "station-central-launch" });
  launchRoom.phase = "active";
  createStationsForRoom(launchRoom, 0);
  for (const player of ["blue-1", "blue-2", "blue-3"].map((id) => launchRoom.players.get(id))) {
    player.money = 100000;
    player.spent = 0;
    player.deployedFleetCost = 0;
    player.design = [
      { x: 7, y: 7, type: "core", rotation: 0 },
      { x: 7, y: 6, type: "engine", rotation: 0 }
    ];
    player.wiring = null;
    player.stats = computeStats(player.design, player.wiring);
    const template = getOrCreateTemplate(
      player.id,
      player.design,
      player.wiring,
      player.stats,
      canonicalBlueprintSignature(player.design, player.wiring)
    );
    const result = enqueueStationProduction(launchRoom, player, {
      template,
      request: { requestId: `launch-${player.id}`, combatStyle: "hold" },
      validation: { count: 1, totalCost: player.stats.unitCost }
    }, 0);
    assert(result.ok, `${player.id} can queue through the shared production path`);
  }
  const launchStation = launchRoom.stations.find((entry) => entry.stationType === "home" && entry.team === "blue");
  updateStations(launchRoom, 1 / 30, 33);
  assert.strictEqual(launchStation.activeLaunches.length, 1, "one central launch is active at a time");
  assert.strictEqual(launchStation.activeLaunches[0].bayId, undefined, "launch state has no selected bay");
  assert.strictEqual(launchStation.productionQueue.length, 2, "remaining players retain their queue entries");
  for (const ship of launchRoom.ships.values()) {
    assert(Math.abs(ship.launchPhase.normal.y - Math.sin(launchStation.angle)) < 1e-12, "launch phase uses the station centreline");
    assert(Math.abs(ship.launchPhase.normal.x - Math.cos(launchStation.angle)) < 1e-12, "launch phase uses the station heading");
    const dx = ship.x - launchStation.x;
    const dy = ship.y - launchStation.y;
    const lateral = -dx * Math.sin(launchStation.angle) + dy * Math.cos(launchStation.angle);
    assert(Math.abs(lateral) < 1e-9, "all players begin on the same launch centreline");
    assert(!resolveStationCollision(launchRoom, ship, ship.physicalRadius || 26), "launching ship is not trapped by its own station");
  }
  for (let tick = 0; tick < 500 && (launchStation.activeLaunches.length || launchStation.productionQueue.length); tick += 1) {
    for (const ship of launchRoom.ships.values()) {
      if (ship.launchPhase) {
        ship.x += (ship.vx || 0) / 30;
        ship.y += (ship.vy || 0) / 30;
      }
    }
    updateStations(launchRoom, 1 / 30, 66 + tick * 33);
  }
  assert.strictEqual(launchStation.activeLaunches.length, 0, "all central launches release deterministically");
  assert.strictEqual(launchStation.productionQueue.length, 0, "all queued players eventually launch through one hangar");
  assert(launchRoom.ships.size === 3 && [...launchRoom.ships.values()].every((ship) => !ship.launchPhase), "released ships remain in the room with launch control cleared");

  section("Full and compact snapshots reconstruct one hangar");
  const full = buildSharedSnapshot(launchRoom, 17000, true).stations.find((entry) => entry.id === launchStation.id);
  const compact = buildSharedSnapshot(launchRoom, 17000, false).stations.find((entry) => entry.id === launchStation.id);
  assert(full.hangar && full.hangar.id === "central", "full snapshot carries one hangar");
  assert.strictEqual(full.launchBays, undefined, "full snapshot emits no launch-bay array");
  assert.strictEqual(full.hangars, undefined, "full snapshot emits no plural hangar field");
  assert.strictEqual(compact.hangar, undefined, "compact snapshot omits cached hangar geometry");
  assert.strictEqual(compact.launchBays, undefined, "compact snapshot emits no launch-bay array");
  assert.strictEqual(compact.hangars, undefined, "compact snapshot emits no plural hangar field");

  section("Spawn regions fit the restored footprint");
  const regionPlan = planSpawnRegions(makeStationRoom({ blue: 3, red: 2, id: "station-spawn" }));
  const blueRegion = regionPlan.safeZones.find((zone) => zone.team === "blue");
  assert(blueRegion, "team spawn region exists");
  assert(blueRegion.radius >= Math.hypot(shellWidth, shellHeight) / 2 + 40, "team region contains the restored station");
  assert(blueRegion.radius < 500, "team region does not reserve the former oversized footprint");

  section("Relay geometry and current component systems remain intact");
  const relay = buildRelayStationDesign();
  assert(relay.some((module) => module.type === "pointDefense"), "relay keeps point defence");
  assert(!relay.some((module) => module.type === "missile"), "relay keeps its light weapon layout");
  const relayGeometry = buildRelayStationGeometry();
  assert.strictEqual(relayGeometry.moduleScale, 20, "relay module scale remains unchanged");
  assert(relayGeometry.shell.maxX - relayGeometry.shell.minX < shellWidth, "relay stations remain physically smaller");
  assert(Number.isFinite(computeDesignCollisionRadius(design, { radius: 0 })), "station collision geometry remains measurable");
  assert(Number.isFinite(computeDesignFootprintRadius(design)), "station footprint geometry remains measurable");

  console.log("  all single-hangar geometry, launch and snapshot checks passed");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
