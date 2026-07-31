"use strict";

// Short deterministic benchmark for Phase 3 targeting and Point Defence.
// Compares the legacy path (all flags false) against the new paths.

const { performance } = require("perf_hooks");
const { PARTS } = require("../src/server/components");
const { computeStats } = require("../src/server/shipStats");
const { initComponentState } = require("../src/server/componentHealth");
const { reallocateShipPower } = require("../src/server/componentPower");
const { findPointDefenseTarget } = require("../src/server/combat");
const PerformanceFlags = require("../src/server/performanceFlags");
const PointDefenceThreats = require("../src/server/pointDefenceThreats");
const WiringRules = require("../public/src/shared/wiringRules");

const WARMUP = 30;
const MEASURE = 300;

function makeShip(design, ownerId, id, x, y) {
  let wiring;
  try {
    wiring = WiringRules.createGeneratedPowerWiring(design, PARTS);
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
  ship.weaponAngles = design.map(() => 0);
  ship.weaponCooldowns = design.map(() => 0);
  return ship;
}

function makeRoom(ships, missiles) {
  const playerMap = new Map([
    ["p1", { id: "p1", team: "A" }],
    ["p2", { id: "p2", team: "B" }]
  ]);
  const shipMap = new Map();
  for (const ship of ships) shipMap.set(ship.id, ship);
  return {
    phase: "active",
    ships: shipMap,
    players: playerMap,
    drones: new Map(),
    bullets: missiles,
    points: [],
    effects: [],
    map: { asteroids: [], safeZones: [] },
    world: { width: 4000, height: 4000 }
  };
}

function buildScene(pdCount, missileCount) {
  const design = [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }];
  const pdShips = [];
  for (let i = 0; i < pdCount; i += 1) {
    const x = 100 + (i % 10) * 50;
    const y = 100 + Math.floor(i / 10) * 50;
    pdShips.push(makeShip(design, "p1", `pd-${i}`, x, y));
  }

  const missiles = [];
  for (let i = 0; i < missileCount; i += 1) {
    const x = 250 + (i % 20) * 30;
    const y = 100 + Math.floor(i / 20) * 60;
    missiles.push({
      id: `m-${i}`,
      type: "missile",
      ownerId: "p2",
      targetId: pdShips[i % pdShips.length].id,
      x,
      y,
      vx: -100,
      vy: 0,
      life: 10,
      interceptable: true,
      hp: 20
    });
  }

  const room = makeRoom(pdShips, missiles);
  return { room, pdShips };
}

function runScenario(pdCount, missileCount, shared) {
  PerformanceFlags.__setPOINT_DEFENCE_SHARED_THREATS(shared);
  const { room, pdShips } = buildScene(pdCount, missileCount);
  const weapon = PARTS.pointDefense.weapon;
  let now = 1000;

  for (let i = 0; i < WARMUP; i += 1) {
    for (const ship of pdShips) {
      findPointDefenseTarget(room, ship.x, ship.y, ship.ownerId, weapon, [], ship.id, now);
    }
    if (shared) PointDefenceThreats.invalidateAllPointDefenceThreatSets(room);
  }

  const start = performance.now();
  let searches = 0;
  for (let i = 0; i < MEASURE; i += 1) {
    now += 33.333;
    for (const ship of pdShips) {
      findPointDefenseTarget(room, ship.x, ship.y, ship.ownerId, weapon, [], ship.id, now);
      searches += 1;
    }
  }
  const totalMs = performance.now() - start;

  PerformanceFlags.__setPOINT_DEFENCE_SHARED_THREATS(false);
  return {
    pdCount,
    missileCount,
    shared,
    searches,
    totalMs: Number(totalMs.toFixed(3)),
    perSearchUs: Number(((totalMs / searches) * 1000).toFixed(3))
  };
}

function main() {
  const scenarios = [
    { pd: 5, missiles: 50 },
    { pd: 10, missiles: 100 },
    { pd: 25, missiles: 250 }
  ];

  const results = [];
  for (const s of scenarios) {
    results.push(runScenario(s.pd, s.missiles, false));
    results.push(runScenario(s.pd, s.missiles, true));
  }

  const report = {
    benchmark: "phase-3-point-defence",
    warmup: WARMUP,
    measure: MEASURE,
    timestamp: new Date().toISOString(),
    results
  };
  console.log(JSON.stringify(report, null, 2));
}

main();
