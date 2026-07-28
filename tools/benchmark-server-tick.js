"use strict";

// Deterministic server hot-path benchmark.
// Measures the key tick functions for representative ship counts and prints
// JSON results that can be compared before/after the performance refactor.

const { performance } = require("perf_hooks");
const fixtures = require("../test-fixtures/powerInfrastructureReferenceShips");
const harness = require("../test-fixtures/dataSupportRuntimeHarness");
const { updateShipPowerDemand, effectiveShieldStats } = require("../src/server/componentPower");
const { updateShipHeat } = require("../src/server/heat");
const { updateShipMovement } = require("../src/server/movement");
const { updateRuntimeShield } = require("../src/server/runtimeShield");
const { buildRoomSpatialIndex } = require("../src/server/spatialIndex");

const WARMUP_TICKS = 60;
const MEASURE_TICKS = 300;
const DT = 1 / 30;
const TICK_MS = DT * 1000;
const SHIP_COUNTS = [1, 5, 10, 25];

function makeShips(count) {
  const fixtureFn = typeof fixtures.standardFrigate === "function" ? fixtures.standardFrigate : fixtures.lightInterceptor;
  const base = fixtureFn ? fixtureFn() : null;
  if (!base) throw new Error("No reference ship fixture found");
  const ships = [];
  const cols = Math.ceil(Math.sqrt(count));
  for (let i = 0; i < count; i += 1) {
    const ship = harness.createRuntimeShip(base);
    ship.id = `bench-${i}`;
    ship.ownerId = `player-${i % 4}`;
    const row = Math.floor(i / cols);
    const col = i % cols;
    ship.x = 200 + col * 120;
    ship.y = 200 + row * 120;
    ship.vx = 0;
    ship.vy = 0;
    ship.angle = 0;
    ship.targetX = ship.x;
    ship.targetY = ship.y;
    ship.alive = true;
    ship.maxShield = Math.max(0, Number(effectiveShieldStats(ship)?.capacity) || 0);
    ship.shield = ship.maxShield;
    ships.push(ship);
  }
  return ships;
}

function makeRoom(ships) {
  const room = {
    phase: "active",
    world: { width: 2400, height: 1800 },
    map: { asteroids: [] },
    effects: [],
    ships: new Map(ships.map((s) => [s.id, s])),
    drones: new Map(),
    bullets: []
  };
  return room;
}

function timeCall(fn, ...args) {
  const start = performance.now();
  fn(...args);
  return performance.now() - start;
}

function runForCount(count) {
  const ships = makeShips(count);
  const room = makeRoom(ships);
  global.__mfaDataSupportPerf = {};
  global.__mfaMovePerf = {};

  const state = {
    powerMs: 0,
    heatMs: 0,
    movementMs: 0,
    spatialMs: 0,
    ticks: 0
  };

  let now = 0;
  for (let t = 0; t < WARMUP_TICKS; t += 1) {
    now += TICK_MS;
    for (const ship of ships) updateShipPowerDemand(ship, room, now);
    for (const ship of ships) updateShipHeat(ship, DT, room, now);
    for (const ship of ships) updateRuntimeShield(ship, DT, now);
    for (const ship of ships) updateShipMovement(room, ship, DT, now);
    buildRoomSpatialIndex(room, ships, now);
  }

  for (let t = 0; t < MEASURE_TICKS; t += 1) {
    now += TICK_MS;
    let t0 = performance.now();
    for (const ship of ships) updateShipPowerDemand(ship, room, now);
    state.powerMs += performance.now() - t0;

    t0 = performance.now();
    for (const ship of ships) updateShipHeat(ship, DT, room, now);
    state.heatMs += performance.now() - t0;

    t0 = performance.now();
    for (const ship of ships) updateRuntimeShield(ship, DT, now);
    state.movementMs += performance.now() - t0;

    t0 = performance.now();
    for (const ship of ships) updateShipMovement(room, ship, DT, now);
    state.movementMs += performance.now() - t0;

    t0 = performance.now();
    buildRoomSpatialIndex(room, ships, now);
    state.spatialMs += performance.now() - t0;
    state.ticks += 1;
  }

  const dataPerf = global.__mfaDataSupportPerf || {};
  const movePerf = global.__mfaMovePerf || {};
  return {
    shipCount: count,
    ticks: state.ticks,
    power: {
      totalMs: Number(state.powerMs.toFixed(3)),
      perTickUs: Number(((state.powerMs / state.ticks) * 1000).toFixed(2)),
      tickCalls: dataPerf.powerDemandTickCalls || 0,
      skippedClean: dataPerf.powerDemandSkippedClean || 0,
      componentsVisited: dataPerf.powerDemandComponentsVisited || 0,
      solves: dataPerf.powerDemandSolveCount || 0,
      deferred: dataPerf.powerDemandDeferredCount || 0
    },
    heat: {
      totalMs: Number(state.heatMs.toFixed(3)),
      perTickUs: Number(((state.heatMs / state.ticks) * 1000).toFixed(2))
    },
    movement: {
      totalMs: Number(state.movementMs.toFixed(3)),
      perTickUs: Number(((state.movementMs / state.ticks) * 1000).toFixed(2)),
      decisions: movePerf.movementDecisionCount || 0,
      capabilityBuilds: movePerf.movementCapabilityBuilds || 0,
      shieldBuilds: movePerf.shieldCapabilityBuilds || 0,
      substeps: movePerf.movementSubsteps || 0
    },
    spatial: {
      totalMs: Number(state.spatialMs.toFixed(3)),
      perTickUs: Number(((state.spatialMs / state.ticks) * 1000).toFixed(2))
    }
  };
}

function main() {
  const results = SHIP_COUNTS.map(runForCount);
  const report = {
    benchmark: "server-hot-path",
    warmupTicks: WARMUP_TICKS,
    measureTicks: MEASURE_TICKS,
    dt: DT,
    timestamp: new Date().toISOString(),
    results
  };
  console.log(JSON.stringify(report, null, 2));
}

main();
