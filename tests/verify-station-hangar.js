"use strict";

// Acceptance checks for the restored three-corridor home station. Geometry
// comes directly from stationTemplates and runtime placement comes from the
// station entity; this verifier maintains no second layout.

const assert = require("assert");
const {
  SHIP_MODULE_SCALE,
  STATION_MODULE_SCALE,
  MAX_SHIP_CELLS,
  MAX_SHIP_EXTENT,
  HULL_CELL_PADDING,
  HANGAR_APERTURE_WIDTH,
  HOME_STATION_CELLS,
  buildHomeStationDesign,
  buildHomeStationGeometry,
  buildRelayStationDesign,
  buildRelayStationGeometry,
  inCorridorVoid
} = require("../src/server/stationTemplates");
const { PARTS } = require("../src/server/components");
const { computeDesignCollisionRadius, computeDesignFootprintRadius } = require("../src/server/componentGeometry");
const { computeStationShieldCollisionRadius, segmentStationHullHit, isSegmentStationClear, stationAttackPoint } = require("../src/server/stationCollision");
const { stationBroadPhaseRadius } = require("../src/server/spatialIndex");
const { createRoom } = require("../src/server/rooms");
const {
  createStationsForRoom,
  destroyStationsForRoom,
  enqueueStationProduction,
  resolveStationCollision
} = require("../src/server/stations");
const { pickWeaponFireTarget, targetCoreAimWorldPosition } = require("../src/server/combat");
const { buildSharedSnapshot } = require("../src/server/snapshots");
const { computeStats } = require("../src/server/shipStats");
const { canonicalBlueprintSignature, getOrCreateTemplate } = require("../src/server/shipTemplates");
const { planSpawnRegions } = require("../src/server/spawnPlanner");
const { tickRoom } = require("../src/server/simulation");
const { stopShips } = require("../src/server/movement");
const { spawnShip } = require("../src/server/ships");

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
  const hangars = geometry.hangars;

  section("The home station uses the historical three-corridor shell");
  assert.strictEqual(SHIP_MODULE_SCALE, 13, "ship module scale remains 13");
  assert.strictEqual(STATION_MODULE_SCALE, 56, "home station module scale is exactly 56");
  assert.strictEqual(geometry.moduleScale, 56, "home station geometry uses scale 56");
  assert.strictEqual(HOME_STATION_CELLS.gridCells, 15, "home station stays on the 15x15 grid");
  assert.strictEqual(HOME_STATION_CELLS.hangarCount, 3, "home station has exactly three hangars");
  assert.strictEqual(HOME_STATION_CELLS.apertureCells, 3, "each aperture is three cells wide");
  assert.strictEqual(hangars.length, 3, "geometry contains three authored hangar records");
  assert.deepStrictEqual(hangars.map((hangar) => hangar.id), ["left", "central", "right"], "hangars have stable lateral identities");
  assert.deepStrictEqual(hangars.map((hangar) => hangar.centreY), [-224, 0, 224], "hangars are evenly spaced and centred as a group");
  assert.strictEqual(geometry.collisionRects.length, 5, "outer hulls, divider walls and rear body form the shell");
  assert.strictEqual(geometry.doorRects.length, 3, "each corridor has one launch door geometry record");
  for (const hangar of hangars) {
    assert.strictEqual(hangar.apertureWidth, HANGAR_APERTURE_WIDTH, "each aperture is 216 world units");
    assert(
      hangar.apertureWidth >= MAX_SHIP_EXTENT + HULL_CELL_PADDING * 2,
      "each aperture physically fits the maximum padded hull"
    );
    assert.strictEqual(hangar.corridorLength, 7 * STATION_MODULE_SCALE, "each corridor is seven station cells deep");
    assert.strictEqual(hangar.localCentre.y, hangar.centreY, "hangar geometry carries its launch centreline");
    assert.strictEqual(geometry.collisionRects[4].maxX, hangar.corridor.rearWallX, "rear hull begins directly behind every corridor wall");
  }
  assert(geometry.collisionRects[4].maxX - geometry.collisionRects[4].minX >= STATION_MODULE_SCALE, "one complete rear structural tile closes the corridors");

  const shellWidth = geometry.shell.maxX - geometry.shell.minX;
  const shellHeight = geometry.shell.maxY - geometry.shell.minY;
  assert.strictEqual(shellWidth, 840, "home station shell is 840 world units wide");
  assert.strictEqual(shellHeight, 840, "home station shell is 840 world units high");
  assert(hangars.every((hangar) => hangar.releaseDistance > hangar.mouth.x), "every release plane is outside its station mouth");

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

  section("Maximum-size hulls release through every corridor");
  const maximumShip = fullGrid();
  assert(hangars.every((hangar) => hangar.apertureHalfWidth > 0), "every corridor has a genuine open aperture");
  assert(hangars.every((hangar) => hangar.corridorLength > MAX_SHIP_EXTENT + HULL_CELL_PADDING), "maximum padded hull fits in corridor depth");
  assert(hangars.every((hangar) => hangar.clearance >= 0), "maximum padded hull has non-negative aperture clearance");
  assert(computeDesignCollisionRadius(maximumShip, { radius: 0 }) > 0, "maximum ship collision radius is measurable");

  section("Station entity, shield and broad phase use the same geometry");
  const room = makeStationRoom({ blue: 3, red: 2 });
  createStationsForRoom(room, 0);
  const station = room.stations.find((entry) => entry.stationType === "home" && entry.team === "blue");
  assert(station, "team has a home station");
  assert.strictEqual(station.moduleScale, 56, "home station entity reports module scale 56");
  assert.strictEqual(station.hangars.length, 3, "station exposes three launch hangars");
  assert.strictEqual(station.hangar, undefined, "station has no singular compatibility hangar field");
  assert.deepStrictEqual(station.hangars.map((hangar) => hangar.centreY), [-224, 0, 224], "station preserves the three launch centrelines");
  const exactDurability = 8000 * 2;
  assert.strictEqual(station.maxShield, exactDurability, "home shield is 8,000 per opposing player");
  assert.strictEqual(station.maxHp, exactDurability, "home hull is 8,000 per opposing player");
  assert.strictEqual(station.collisionPieces.filter((piece) => !piece.door).length, 5, "solid collision remains compound");
  assert.strictEqual(station.collisionPieces.filter((piece) => piece.door).length, 3, "each launch mouth has one door");
  assert(Math.abs(station.shieldRadius - computeStationShieldCollisionRadius(station)) < 1e-9, "shield radius is derived from solid pieces");
  assert(station.shieldRadius > 500 && station.shieldRadius < 700, "shield radius encloses the restored three-bay station");
  assert(stationBroadPhaseRadius(station) >= station.radius, "broad phase encloses every solid piece");
  const stationBroadPhase = stationBroadPhaseRadius(station);
  assert(stationBroadPhase > 700 && stationBroadPhase < 900, "station broad phase matches the 840-unit shell");

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

  for (const hangar of station.hangars) {
    const start = localToWorld(station, { x: hangar.innerWall.x + 4, y: hangar.innerWall.y });
    const end = localToWorld(station, { x: hangar.releasePlane.x + 4, y: hangar.releasePlane.y });
    assert.strictEqual(segmentStationHullHit(station, start.x, start.y, end.x, end.y), null, `${hangar.id} launch path is open through the shell`);
    assert(isSegmentStationClear(room, start.x, start.y, end.x, end.y, 0, { ignoreDoors: true }), `${hangar.id} launch path is open to navigation`);
  }
  const sideStart = localToWorld(station, { x: 1000, y: -200 });
  const sideEnd = localToWorld(station, { x: -1000, y: -200 });
  assert(segmentStationHullHit(station, sideStart.x, sideStart.y, sideEnd.x, sideEnd.y), "solid side hull remains collidable");

  section("Three players use three deterministic launch corridors");
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
    player.dataLinks = [];
    player.stats = computeStats(player.design);
    const template = getOrCreateTemplate(
      player.id,
      player.design,
      player.dataLinks,
      player.stats,
      canonicalBlueprintSignature(player.design, player.dataLinks)
    );
    const result = enqueueStationProduction(launchRoom, player, {
      template,
      request: { requestId: `launch-${player.id}`, combatStyle: "hold" },
      validation: { count: 1, totalCost: player.stats.unitCost }
    }, 0);
    assert(result.ok, `${player.id} can queue through the shared production path`);
  }
  const launchStation = launchRoom.stations.find((entry) => entry.stationType === "home" && entry.team === "blue");
  tickRoom(launchRoom, 1 / 30, 33);
  assert.strictEqual(launchStation.activeLaunches.length, 3, "three players can launch through separate corridors concurrently");
  assert.deepStrictEqual(launchStation.activeLaunches.map((launch) => launch.bayIndex).sort(), [0, 1, 2], "launch state keeps one stable bay per player");
  assert.strictEqual(launchStation.productionQueue.length, 0, "all three players leave the production queue when their bays are free");
  for (const ship of launchRoom.ships.values()) {
    assert(Math.abs(ship.launchPhase.normal.y - Math.sin(launchStation.angle)) < 1e-12, "launch phase uses the station centreline");
    assert(Math.abs(ship.launchPhase.normal.x - Math.cos(launchStation.angle)) < 1e-12, "launch phase uses the station heading");
    const dx = ship.x - launchStation.x;
    const dy = ship.y - launchStation.y;
    const lateral = -dx * Math.sin(launchStation.angle) + dy * Math.cos(launchStation.angle);
    const hangar = launchStation.hangars[ship.launchPhase.bayIndex];
    assert(Math.abs(lateral - hangar.centreY) < 1e-9, "each player begins on its assigned straight launch centreline");
    assert(!resolveStationCollision(launchRoom, ship, ship.physicalRadius || 26), "launching ship is not trapped by its own station");
  }

  section("A missing active-launch record is repaired before movement");
  const orphanCandidate = [...launchRoom.ships.values()].find((ship) => ship.launchPhase);
  assert(orphanCandidate, "an active launch is available for orphan recovery");
  const orphanStartAlong = orphanCandidate.launchPhase.along;
  launchStation.activeLaunches = launchStation.activeLaunches.filter((launch) => launch.shipId !== orphanCandidate.id);
  assert(!launchStation.activeLaunches.some((launch) => launch.shipId === orphanCandidate.id), "the launch index is actually missing for the regression case");
  tickRoom(launchRoom, 1 / 30, 66);
  assert(orphanCandidate.launchPhase, "a live launch phase survives a missing index entry");
  assert(orphanCandidate.launchPhase.along > orphanStartAlong, "the repaired launch advances on the authoritative tick");
  assert(launchStation.activeLaunches.some((launch) => launch.shipId === orphanCandidate.id), "the station launch index is rebuilt from the live phase");

  const frontBlockerOwner = launchRoom.players.get("blue-1");
  const centralHangar = launchStation.hangars[1];
  const launchNormal = { x: Math.cos(launchStation.angle), y: Math.sin(launchStation.angle) };
  const frontBlocker = spawnShip(launchRoom, frontBlockerOwner, 33, 1, {
    design: frontBlockerOwner.design,
    dataLinks: frontBlockerOwner.dataLinks,
    stats: frontBlockerOwner.stats,
    spawnPoint: {
      x: centralHangar.mouth.x + launchNormal.x * 40,
      y: centralHangar.mouth.y + launchNormal.y * 40,
      ok: true,
      angle: launchStation.angle
    },
    requestId: "launch-front-blocker"
  });
  assert(frontBlocker, "a real hull can be placed ahead of an active launch");
  stopShips(launchRoom, frontBlockerOwner, [frontBlocker.id]);
  const blockerStartAlong = (frontBlocker.x - launchStation.x) * launchNormal.x
    + (frontBlocker.y - launchStation.y) * launchNormal.y;
  const launchAlong = new Map();
  for (const ship of launchRoom.ships.values()) {
    if (ship.launchPhase) launchAlong.set(ship.id, ship.launchPhase.along);
  }
  for (let tick = 0; tick < 500 && (launchStation.activeLaunches.length || launchStation.productionQueue.length); tick += 1) {
    tickRoom(launchRoom, 1 / 30, 66 + tick * 33);
    for (const ship of launchRoom.ships.values()) {
      if (!ship.launchPhase) continue;
      const previous = launchAlong.get(ship.id);
      assert(ship.launchPhase.along >= previous - 1e-9, "launch progress never moves backward under traffic");
      launchAlong.set(ship.id, ship.launchPhase.along);
    }
  }
  assert.strictEqual(launchStation.activeLaunches.length, 0, "all central launches release deterministically");
  assert.strictEqual(launchStation.productionQueue.length, 0, "all queued players eventually launch through the three hangars");
  const blockerEndAlong = (frontBlocker.x - launchStation.x) * launchNormal.x
    + (frontBlocker.y - launchStation.y) * launchNormal.y;
  assert(blockerEndAlong > blockerStartAlong, "a hull in front of the mouth is moved outward for a launch");
  assert(launchRoom.ships.size === 4 && [...launchRoom.ships.values()].every((ship) => !ship.launchPhase), "released ships remain in the room with launch control cleared");

  section("Ships in front of a mouth cannot blockade the next spawn");
  const blocker = [...launchRoom.ships.values()].find((ship) => ship.alive);
  assert(blocker, "a released ship is available as a deterministic front blocker");
  const blockerPlayer = launchRoom.players.get(blocker.ownerId);
  stopShips(launchRoom, blockerPlayer, [blocker.id]);
  const blockerSeat = ["blue-1", "blue-2", "blue-3"].indexOf(blockerPlayer.id);
  const blockerHangar = launchStation.hangars[Math.max(0, blockerSeat)];
  const blockerNormal = { x: Math.cos(launchStation.angle), y: Math.sin(launchStation.angle) };
  blocker.x = blockerHangar.mouth.x + blockerNormal.x * 40;
  blocker.y = blockerHangar.mouth.y + blockerNormal.y * 40;
  const blockerTemplate = getOrCreateTemplate(
    blockerPlayer.id,
    blockerPlayer.design,
    blockerPlayer.dataLinks,
    blockerPlayer.stats,
    canonicalBlueprintSignature(blockerPlayer.design, blockerPlayer.dataLinks)
  );
  const blockedByFront = enqueueStationProduction(launchRoom, blockerPlayer, {
    template: blockerTemplate,
    request: { requestId: "front-blocker-follow-up", combatStyle: "hold" },
    validation: { count: 1, totalCost: blockerPlayer.stats.unitCost }
  }, 17000);
  assert(blockedByFront.ok, "a follow-up production request is accepted with a hull in front of the mouth");
  tickRoom(launchRoom, 1 / 30, 17033);
  assert(
    [...launchRoom.ships.values()].some((ship) => ship.id !== blocker.id && ship.launchPhase),
    "a hull parked in front of the mouth cannot block the next spawn"
  );

  section("Full and compact snapshots reconstruct three hangars");
  const full = buildSharedSnapshot(launchRoom, 17000, true).stations.find((entry) => entry.id === launchStation.id);
  const compact = buildSharedSnapshot(launchRoom, 17000, false).stations.find((entry) => entry.id === launchStation.id);
  assert.strictEqual(full.hangars?.length, 3, "full snapshot carries all three hangars");
  assert.strictEqual(full.hangar, undefined, "full snapshot emits no singular hangar compatibility field");
  assert.strictEqual(compact.hangars, undefined, "compact snapshot omits cached hangar geometry");
  assert.strictEqual(compact.hangar, undefined, "compact snapshot emits no singular hangar field");

  section("Rebuilding station objects cannot leave a hull launch-locked");
  const rebuildingShip = [...launchRoom.ships.values()].find((ship) => ship.launchPhase);
  assert(rebuildingShip, "an active launch is available for station recreation");
  destroyStationsForRoom(launchRoom);
  assert(!rebuildingShip.launchPhase, "station teardown clears the launch phase and releases the hull");
  assert(launchRoom.stations.length === 0, "station teardown removes the old authority");
  createStationsForRoom(launchRoom, 18000);
  assert(launchRoom.stations.length > 0, "station recreation restores the station authority");
  assert([...launchRoom.ships.values()].every((ship) => !ship.launchPhase), "station recreation leaves no launch orphan behind");

  section("Spawn regions fit the restored footprint");
  const regionPlan = planSpawnRegions(makeStationRoom({ blue: 3, red: 2, id: "station-spawn" }));
  const blueRegion = regionPlan.safeZones.find((zone) => zone.team === "blue");
  assert(blueRegion, "team spawn region exists");
  assert(blueRegion.radius >= Math.hypot(shellWidth, shellHeight) / 2 + 40, "team region contains the restored station");
  assert(blueRegion.radius < 800, "team region reserves the restored three-hangar footprint without extra clearance");

  section("Relay geometry and current component systems remain intact");
  const relay = buildRelayStationDesign();
  assert(relay.some((module) => module.type === "pointDefense"), "relay keeps point defence");
  assert(!relay.some((module) => module.type === "missile"), "relay keeps its light weapon layout");
  const relayGeometry = buildRelayStationGeometry();
  assert.strictEqual(relayGeometry.moduleScale, 20, "relay module scale remains unchanged");
  assert(relayGeometry.shell.maxX - relayGeometry.shell.minX < shellWidth, "relay stations remain physically smaller");
  assert(Number.isFinite(computeDesignCollisionRadius(design, { radius: 0 })), "station collision geometry remains measurable");
  assert(Number.isFinite(computeDesignFootprintRadius(design)), "station footprint geometry remains measurable");

  console.log("  all three-hangar geometry, launch and snapshot checks passed");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
