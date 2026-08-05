#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const {
  RoomSpatialIndex,
  shipBroadPhaseRadius,
  droneBroadPhaseRadius
} = require("../src/server/spatialIndex");

const ARTIFACT = path.join("test-artifacts", "performance", "benchmark-phase-4b.json");

function idNumber(id) {
  return Number.parseInt(String(id).slice(1), 10) || 0;
}

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
  return { ships, drones, bullets, nextShipId: shipCount, nextDroneId: droneCount, nextBulletId: bulletCount, mode };
}

function cloneFixture(fixture) {
  return {
    ships: fixture.ships.map((s) => ({ ...s })),
    drones: new Map([...fixture.drones.entries()].map(([k, d]) => [k, { ...d }])),
    bullets: fixture.bullets.map((b) => ({ ...b })),
    nextShipId: fixture.nextShipId,
    nextDroneId: fixture.nextDroneId,
    nextBulletId: fixture.nextBulletId,
    mode: fixture.mode
  };
}

function applyStep(fixture, step, mode) {
  const stationary = mode === "stationary";
  const churn = mode === "churn";
  for (const ship of fixture.ships) {
    if (ship.alive !== true || ship.removed) continue;
    const idNum = idNumber(ship.id);
    const move = stationary ? 0 : 4;
    ship.x += Math.cos(step + idNum) * move;
    ship.y += Math.sin(step + idNum) * move;
    if (churn && step > 0 && (idNum + step * 7) % 23 === 0) {
      ship.alive = false;
      ship.removed = true;
    }
  }
  for (const drone of fixture.drones.values()) {
    if (drone.destroyed || drone.removed) continue;
    const idNum = idNumber(drone.id);
    const move = stationary ? 0 : (step % 2 ? 3 : -3);
    drone.x += move;
    drone.y += (step % 3 ? 2 : -2) * (stationary ? 0 : 1);
    if (churn && step > 0 && (idNum + step * 3) % 47 === 0) {
      drone.destroyed = true;
    }
  }
  for (const bullet of fixture.bullets) {
    if (bullet.life <= 0) continue;
    const idNum = idNumber(bullet.id);
    const move = stationary ? 0 : (1 / 60);
    bullet.x += bullet.vx * move;
    bullet.y += bullet.vy * move;
    bullet.life -= 1 / 30;
    if (churn && step > 0 && (idNum + step * 5) % 37 === 0) {
      bullet.life = 0;
    }
  }
  if (churn && step > 0) {
    const spread = 30000;
    for (let i = 0; i < 3; i += 1) {
      const newId = fixture.nextShipId++;
      fixture.ships.push(makeShip(newId, (newId * 127) % spread + 100, (newId * 293) % spread + 100));
    }
    for (let i = 0; i < 2; i += 1) {
      const newId = fixture.nextDroneId++;
      const d = makeDrone(newId, (newId * 401) % spread + 100, (newId * 809) % spread + 100);
      fixture.drones.set(d.id, d);
    }
    for (let i = 0; i < 10; i += 1) {
      const newId = fixture.nextBulletId++;
      fixture.bullets.push(makeBullet(newId, (newId * 211) % spread + 100, (newId * 523) % spread + 100));
    }
  }
}

function buildRoomStub(fixture) {
  return {
    spatialCellSize: 320,
    stations: [],
    drones: fixture.drones,
    bullets: fixture.bullets
  };
}

function measure(baseFixture, steps) {
  const fixture = cloneFixture(baseFixture);
  const index = new RoomSpatialIndex(320);
  let spatialMs = 0;
  let updateMs = 0;
  const start = performance.now();
  for (let step = 0; step < steps; step += 1) {
    applyStep(fixture, step, baseFixture.mode);
    const roomStub = buildRoomStub(fixture);
    const liveShips = fixture.ships.filter((s) => s.alive === true && !s.removed);
    const liveBullets = fixture.bullets.filter((b) => b.life > 0);
    const liveInterceptable = liveBullets.filter((b) => b.interceptable);
    const liveDrones = [...fixture.drones.values()].filter((d) => !d.destroyed && !d.removed);
    const spatialStart = performance.now();
    if (step === 0) index.rebuild(roomStub, liveShips, step);
    spatialMs += performance.now() - spatialStart;
    const updateStart = performance.now();
    index.updateLiveEntities("ships", liveShips, shipBroadPhaseRadius);
    index.updateLiveEntities("drones", liveDrones, droneBroadPhaseRadius);
    index.updateLiveEntities("projectiles", liveBullets, () => 0);
    index.updateLiveEntities("interceptableProjectiles", liveInterceptable, () => 0);
    updateMs += performance.now() - updateStart;
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
  const baseFixture = makeFixture(shipCount, mode);
  baseFixture.mode = mode;
  const steps = 60;
  const runs = 5;
  const canonicalTimes = [];
  let canonicalMetrics = null;
  for (let i = 0; i < runs; i += 1) {
    canonicalMetrics = measure(baseFixture, steps);
    canonicalTimes.push(canonicalMetrics.totalMs);
  }
  return {
    shipCount,
    mode,
    canonical: { ...summary(canonicalTimes), ...canonicalMetrics, runs }
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
