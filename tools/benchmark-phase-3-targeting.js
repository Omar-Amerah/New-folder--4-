"use strict";

// Deterministic short benchmark for Phase 3 targeting and Point Defence.
// Exercises the real ship and station weapon update loops with multiple mounts
// and an updated spatial index each tick.

const { performance } = require("perf_hooks");
const { PARTS } = require("../src/server/components");
const { computeStats } = require("../src/server/shipStats");
const { initComponentState } = require("../src/server/componentHealth");
const { reallocateShipPower } = require("../src/server/componentPower");
const { updateShipWeapons } = require("../src/server/combat");
const { updateStationWeapons } = require("../src/server/stationCombat");
const { buildRoomSpatialIndex } = require("../src/server/spatialIndex");
const { getShipComponentIndexes } = require("../src/server/componentIndexes");
const RoomTelemetry = require("../src/server/roomTelemetry");
const { stationModuleWorldPosition } = require("../src/server/stationTemplates");

const WARMUP = 60;
const MEASURE = 300;
const DT = 1 / 30;
const TICK_MS = DT * 1000;
const MISSILES_PER_SCENE = 200;

function makeShip(id, ownerId, x, y, pdCount = 4) {
  const design = [
    { x: 7, y: 7, type: "core" },
    { x: 7, y: 6, type: "reactor" },
    { x: 7, y: 8, type: "engine" }
  ];
  for (let i = 0; i < pdCount; i += 1) {
    design.push({ x: 8 + Math.floor(i / 5), y: 7 + (i % 5), type: "pointDefense" });
  }
  design.push({ x: 6, y: 7, type: "blaster" });
  let wiring;
  try {
    wiring = require("../public/src/shared/wiringRules").createGeneratedPowerWiring(design, PARTS);
  } catch (_) {
    wiring = { power: [], data: [] };
  }
  const stats = computeStats(design, wiring);
  const ship = {
    id,
    ownerId,
    team: ownerId === "p1" ? "A" : "B",
    x,
    y,
    angle: 0,
    vx: 0,
    vy: 0,
    targetX: x,
    targetY: y,
    design,
    wiring,
    stats,
    alive: true,
    hp: stats.maxHp,
    maxHp: stats.maxHp,
    shield: 0,
    maxShield: 0,
    commandState: "mainCore"
  };
  initComponentState(ship);
  reallocateShipPower(ship, "init");
  const n = design.length;
  ship.weaponAngles = new Array(n).fill(0);
  ship.weaponCooldowns = new Array(n).fill(0);
  ship.weaponDesiredAngles = new Array(n).fill(null);
  ship.weaponAimTargetIds = new Array(n).fill(null);
  ship.weaponFireTargetIds = new Array(n).fill(null);
  ship.weaponComponentTargetIds = new Array(n).fill(-1);
  ship.weaponComponentTargetIndices = new Array(n).fill(-1);
  ship.weaponComponentRetargetAt = new Array(n).fill(0);
  ship.weaponBeamContacts = new Array(n).fill(null);
  return ship;
}

function makeStation(id, ownerTeam, x, y, weaponCount = 8) {
  const design = [{ x: 7, y: 7, type: "core" }];
  for (let i = 0; i < weaponCount; i += 1) {
    design.push({ x: 7 + i % 5, y: 7 + Math.floor(i / 5), type: i % 3 === 0 ? "pointDefense" : "blaster" });
  }
  const station = {
    id,
    ownerId: null,
    team: ownerTeam,
    x,
    y,
    angle: 0,
    design,
    entityType: "station",
    moduleScale: 59,
    alive: true,
    state: "operational",
    hp: 1000,
    maxHp: 1000,
    componentHp: design.map(() => 1000),
    componentMaxHp: design.map(() => 1000),
    weaponCooldowns: new Array(design.length).fill(0),
    weaponAngles: design.map(() => 0),
    weaponAimTargetIds: new Array(design.length).fill(null),
    weaponFireTargetIds: new Array(design.length).fill(null),
    weaponDesiredAngles: new Array(design.length).fill(null)
  };
  getShipComponentIndexes(station);
  return station;
}

function makeRoom(ship, missiles, stations = []) {
  const playerMap = new Map([
    ["p1", { id: "p1", team: "A" }],
    ["p2", { id: "p2", team: "B" }]
  ]);
  const shipMap = new Map();
  if (ship) shipMap.set(ship.id, ship);
  const room = {
    phase: "active",
    ships: shipMap,
    players: playerMap,
    stations,
    drones: new Map(),
    bullets: missiles,
    points: [],
    effects: [],
    map: { asteroids: [], safeZones: [] },
    world: { width: 4000, height: 4000 }
  };
  return room;
}

function makeMissiles(pdShip, count) {
  const missiles = [];
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2;
    const dist = 180 + (i % 60);
    missiles.push({
      id: `m-${i}`,
      type: "missile",
      ownerId: "p2",
      targetId: pdShip.id,
      x: pdShip.x + Math.cos(angle) * dist,
      y: pdShip.y + Math.sin(angle) * dist,
      vx: -100,
      vy: 0,
      life: 10,
      interceptable: true,
      hp: 20
    });
  }
  return missiles;
}

function runShipScenario(name, pdCount, missileCount) {
  const ship = makeShip("pd-bench-1", "p1", 2000, 2000, pdCount);
  const missiles = makeMissiles(ship, missileCount);
  const room = makeRoom(ship, missiles);
  const ships = [ship];

  let now = 0;
  for (let i = 0; i < WARMUP; i += 1) {
    now += TICK_MS;
    buildRoomSpatialIndex(room, ships, now);
    updateShipWeapons(room, ship, ships, DT, now);
  }

  RoomTelemetry.resetRoomTelemetry(room);
  const start = performance.now();
  for (let i = 0; i < MEASURE; i += 1) {
    now += TICK_MS;
    buildRoomSpatialIndex(room, ships, now);
    updateShipWeapons(room, ship, ships, DT, now);
  }
  const totalMs = performance.now() - start;

  const t = RoomTelemetry.getRoomTelemetry(room);
  const result = {
    name,
    pdCount,
    missileCount,
    runtime: "canonical",
    ticks: MEASURE,
    totalMs: Number(totalMs.toFixed(3)),
    perTickUs: Number(((totalMs / MEASURE) * 1000).toFixed(2)),
    pointDefenceThreatSetBuilds: t.pointDefenceThreatSetBuilds || 0,
    pointDefenceThreatSetReuses: t.pointDefenceThreatSetReuses || 0,
    pointDefenceMountSelections: t.pointDefenceMountSelections || 0,
    ordinaryTargetSearches: t.ordinaryTargetSearches || 0,
    ordinaryTargetSearchDeferred: t.ordinaryTargetSearchDeferred || 0,
    effectiveWeaponProfileBuilds: t.effectiveWeaponProfileBuilds || 0,
    effectiveWeaponProfileCacheHits: t.effectiveWeaponProfileCacheHits || 0,
    projectilesCreated: t.projectilesCreated || 0
  };

  return result;
}

function runStationScenario(name, weaponCount, enemyShipCount) {
  const station = makeStation("st-bench-1", "A", 2000, 2000, weaponCount);
  const enemies = [];
  for (let i = 0; i < enemyShipCount; i += 1) {
    const enemy = makeShip(`enemy-${i}`, "p2", 1900 + (i % 10) * 30, 1900 + Math.floor(i / 10) * 40, 0);
    enemies.push(enemy);
  }
  const missiles = makeMissiles(station, Math.min(50, enemyShipCount));
  const room = makeRoom(null, missiles, [station]);
  for (const enemy of enemies) room.ships.set(enemy.id, enemy);
  const ships = [...room.ships.values()];

  let now = 0;
  for (let i = 0; i < WARMUP; i += 1) {
    now += TICK_MS;
    buildRoomSpatialIndex(room, ships, now);
    updateStationWeapons(room, [station], ships, DT, now);
  }

  RoomTelemetry.resetRoomTelemetry(room);
  const start = performance.now();
  for (let i = 0; i < MEASURE; i += 1) {
    now += TICK_MS;
    buildRoomSpatialIndex(room, ships, now);
    updateStationWeapons(room, [station], ships, DT, now);
  }
  const totalMs = performance.now() - start;

  const t = RoomTelemetry.getRoomTelemetry(room);
  const result = {
    name,
    weaponCount,
    enemyShipCount,
    runtime: "canonical",
    ticks: MEASURE,
    totalMs: Number(totalMs.toFixed(3)),
    perTickUs: Number(((totalMs / MEASURE) * 1000).toFixed(2)),
    pointDefenceThreatSetBuilds: t.pointDefenceThreatSetBuilds || 0,
    pointDefenceThreatSetReuses: t.pointDefenceThreatSetReuses || 0,
    pointDefenceMountSelections: t.pointDefenceMountSelections || 0,
    stationTargetSearches: t.stationTargetSearches || 0,
    stationTargetSearchDeferred: t.stationTargetSearchDeferred || 0,
    projectilesCreated: t.projectilesCreated || 0
  };

  return result;
}

function main() {
  const results = [];

  results.push(runShipScenario("ship-4pd-200m-canonical", 4, MISSILES_PER_SCENE));
  results.push(runStationScenario("station-8weapons-50ships-canonical", 8, 50));

  const report = {
    benchmark: "phase-3-real-combat-loop",
    warmup: WARMUP,
    measure: MEASURE,
    dt: DT,
    timestamp: new Date().toISOString(),
    results
  };
  console.log(JSON.stringify(report, null, 2));
}

main();
