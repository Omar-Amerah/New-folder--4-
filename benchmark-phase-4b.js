#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const {
  INCREMENTAL_SPATIAL_INDEX,
  __setINCREMENTAL_SPATIAL_INDEX
} = require("./src/server/performanceFlags");
const {
  RoomSpatialIndex,
  shipBroadPhaseRadius,
  droneBroadPhaseRadius
} = require("./src/server/spatialIndex");

const ARTIFACT = path.join("test-artifacts", "performance", "benchmark-phase-4b.json");

function makeShip(i, x, y) {
  return {
    id: `s${i}`,
    x,
    y,
    vx: 0,
    vy: 0,
    angle: 0,
    alive: true,
    removed: false,
    radius: 20 + (i % 15),
    physicalRadius: 12 + (i % 8),
    stats: { maxHp: 100, mass: 1 + (i % 5) },
    hp: 100,
    shield: 0,
    design: [{ x: 7, y: 7, type: "core" }]
  };
}

function makeDrone(i, x, y) {
  return {
    id: `d${i}`,
    x,
    y,
    vx: 0,
    vy: 0,
    radius: 10,
    hull: 30,
    destroyed: false,
    removed: false,
    state: "active"
  };
}

function makeBullet(i, x, y) {
  return {
    id: `b${i}`,
    x,
    y,
    vx: (i % 5 ? 300 : -300),
    vy: (i % 3 ? 100 : -100),
    life: 5,
    damage: 1,
    interceptable: i % 4 === 0
  };
}

function makeFixture(shipCount, mode) {
  const ships = [];
  const drones = new Map();
  const bullets = [];
  const spread = mode === "dense" ? 6000 : 30000;
  for (let i = 0; i < shipCount; i += 1) {
    const x = (i * 307) % spread + 100;
    const y = (i * 619) % spread + 100;
    ships.push(makeShip(i, x, y));
  }
  const droneCount = mode === "projectile-heavy" ? Math.floor(shipCount * 0.5) : Math.floor(shipCount * 1.5);
  for (let i = 0; i < droneCount; i += 1) {
    const d = makeDrone(i, (i * 401) % spread + 100, (i * 809) % spread + 100);
    drones.set(d.id, d);
  }
  const bulletCount = mode === "projectile-heavy" ? shipCount * 10 : shipCount * 3;
  for (let i = 0; i < bulletCount; i += 1) {
    bullets.push(makeBullet(i, (i * 211) % spread + 100, (i * 523) % spread + 100));
  }
  return { ships, drones, bullets };
}

function measure(fixture, steps, incremental) {
  __setINCREMENTAL_SPATIAL_INDEX(incremental);
  const index = new RoomSpatialIndex(320);
  const roomStub = { spatialCellSize: 320, stations: [], drones: fixture.drones, bullets: fixture.bullets };
  let spatialMs = 0;
  let updateMs = 0;
  const start = performance.now();
  for (let step = 0; step < steps; step += 1) {
    const spatialStart = performance.now();
    if (incremental) {
      if (step === 0) {
        index.rebuild(roomStub, fixture.ships, step);
      }
    } else {
      index.rebuild(roomStub, fixture.ships, step);
    }
    spatialMs += performance.now() - spatialStart;

    if (incremental) {
      const updateStart = performance.now();
      // Simulate small movements and refresh all dynamic kinds.
      for (const ship of fixture.ships) {
        ship.x += Math.cos(step + ship.id) * 4;
        ship.y += Math.sin(step + ship.id) * 4;
      }
      index.updateLiveEntities("ships", fixture.ships, shipBroadPhaseRadius);
      for (const drone of fixture.drones.values()) {
        drone.x += (step % 2 ? 3 : -3);
        drone.y += (step % 3 ? 2 : -2);
      }
      index.updateLiveEntities("drones", fixture.drones.values(), droneBroadPhaseRadius);
      for (const bullet of fixture.bullets) {
        bullet.x += bullet.vx * (1 / 60);
        bullet.y += bullet.vy * (1 / 60);
      }
      index.updateLiveEntities("projectiles", fixture.bullets, () => 0);
      index.updateLiveEntities("interceptableProjectiles", fixture.bullets.filter((b) => b.interceptable), () => 0);
      updateMs += performance.now() - updateStart;
    }
  }
  return {
    totalMs: performance.now() - start,
    spatialMs,
    updateMs,
    fullRebuilds: index.spatialFullRebuilds,
    updates: index.spatialIncrementalUpdates,
    noOps: index.spatialNoOpUpdates,
    cellChanges: index.spatialCellMembershipChanges,
    recordCount: index.count("ships") + index.count("drones") + index.count("projectiles")
  };
}

function summary(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    p50: +(sorted[Math.floor((sorted.length - 1) * 0.5)] || 0).toFixed(3),
    p95: +(sorted[Math.floor((sorted.length - 1) * 0.95)] || 0).toFixed(3),
    max: +(sorted[sorted.length - 1] || 0).toFixed(3),
    mean: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(3)
  };
}

function runScenario(shipCount, mode) {
  const fixture = makeFixture(shipCount, mode);
  const steps = 60;
  const runs = 5;
  const fullTimes = [];
  const incTimes = [];
  let fullMetrics = null;
  let incMetrics = null;
  for (let i = 0; i < runs; i += 1) {
    fullMetrics = measure(fixture, steps, false);
    fullTimes.push(fullMetrics.totalMs);
    incMetrics = measure(fixture, steps, true);
    incTimes.push(incMetrics.totalMs);
  }
  return {
    shipCount,
    mode,
    full: { ...summary(fullTimes), ...fullMetrics, runs },
    incremental: { ...summary(incTimes), ...incMetrics, runs }
  };
}

const scenarios = [
  { ships: 100, mode: "sparse" },
  { ships: 250, mode: "sparse" },
  { ships: 500, mode: "sparse" },
  { ships: 250, mode: "dense" },
  { ships: 500, mode: "dense" },
  { ships: 250, mode: "stationary" },
  { ships: 250, mode: "projectile-heavy" },
  { ships: 250, mode: "churn" }
];

const results = scenarios.map((s) => runScenario(s.ships, s.mode));
console.log(JSON.stringify(results, null, 2));
fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
fs.writeFileSync(ARTIFACT, `${JSON.stringify(results, null, 2)}\n`);
console.log(`Benchmark written to ${ARTIFACT}`);
