#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { CONFIG, updateDroneBays } = require("./src/server/drones");
const { updateBullets } = require("./src/server/projectiles");
const { buildRoomSpatialIndex } = require("./src/server/spatialIndex");

const DT = 1 / 30;
const TICK_BUDGET_MS = 1000 / 30;
const SAMPLES = 18;
const WARMUPS = 4;
const ARTIFACT = path.join("test-artifacts", "performance", "server-spatial-performance.json");

function percentile(sorted, ratio) {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] || 0;
}

function summary(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    p50: +percentile(sorted, 0.5).toFixed(3),
    p95: +percentile(sorted, 0.95).toFixed(3),
    max: +sorted[sorted.length - 1].toFixed(3),
    latest: +values[values.length - 1].toFixed(3)
  };
}

function makeShip(id, ownerId, teamId, x, y) {
  const bay = {
    componentIndex: 0,
    componentId: `${id}:bay`,
    droneType: "fighter",
    mode: "deployed",
    nextLaunchAt: Infinity,
    launchBlockedBySpawn: false,
    launchEdge: { centerX: 7.5, centerY: 6.5, dx: 0, dy: -1 },
    slots: [{ slot: 0, state: "active", droneId: null, productionProgress: 1, pauseReason: null }]
  };
  return {
    id, ownerId, team: teamId, alive: true,
    x, y, vx: 0, vy: 0, angle: 0, radius: 28,
    hp: 300, maxHp: 300, shield: 100, maxShield: 100,
    stats: {},
    design: [{ x: 7, y: 7, type: "droneBay", droneType: "fighter" }],
    componentHp: [100], componentMaxHp: [100],
    componentPower: { byComponentIndex: [{ operationalMultiplier: 1 }] },
    componentHeatState: [0], componentHeatInput: [0],
    droneBays: [bay]
  };
}

function makeFixture(useSpatialIndex) {
  const players = new Map([
    ["blue", { id: "blue", team: "a" }],
    ["red", { id: "red", team: "b" }]
  ]);
  const room = {
    phase: "active",
    players,
    ships: new Map(),
    drones: new Map(),
    bullets: [],
    projectileById: new Map(),
    effects: [],
    world: { width: 50000, height: 50000 },
    map: { asteroids: [], safeZones: [] },
    rules: { gameMode: "teams" },
    nextEntityId: 100000,
    disableSpatialIndex: !useSpatialIndex
  };
  const ships = [];
  for (let i = 0; i < 80; i += 1) {
    const ownerId = i % 2 ? "red" : "blue";
    const ship = makeShip(`s${i}`, ownerId, i % 2 ? "b" : "a", 1000 + (i % 10) * 4200, 1000 + Math.floor(i / 10) * 4200);
    room.ships.set(ship.id, ship);
    ships.push(ship);
    for (let d = 0; d < 3; d += 1) {
      const drone = {
        id: `d${i}-${d}`, ownerId, parentShipId: ship.id, bayComponentId: ship.droneBays[0].componentId,
        slot: 0, type: d === 2 ? "defence" : "fighter",
        x: ship.x + 45 + d * 12, y: ship.y + d * 9, vx: 0, vy: 0, angle: 0,
        radius: 10, hull: 40, maxHull: 40, state: "active", commandState: "deployed",
        fuelRemainingSeconds: CONFIG.fuelSeconds, nextDecisionAt: 0, nextThinkAt: 0,
        nextActionAt: Infinity, targetId: null
      };
      room.drones.set(drone.id, drone);
    }
  }
  for (let i = 0; i < 900; i += 1) {
    const ownerId = i % 2 ? "blue" : "red";
    const x = 500 + ((i * 977) % 48000);
    const y = 500 + ((i * 1597) % 48000);
    const angle = ((i * 37) % 360) * Math.PI / 180;
    const speed = 420 + (i % 7) * 90;
    const bullet = {
      id: `b${i}`, type: i % 5 === 0 ? "missile" : "bolt", ownerId,
      x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      life: 5, damage: 8, hp: 10, interceptable: i % 3 === 0
    };
    room.bullets.push(bullet);
    room.projectileById.set(bullet.id, bullet);
  }
  return { room, ships };
}

function measure(useSpatialIndex) {
  const spatialMs = [];
  const droneMs = [];
  const projectileMs = [];
  const totalMs = [];
  let overruns = 0;
  for (let sample = 0; sample < SAMPLES + WARMUPS; sample += 1) {
    const { room, ships } = makeFixture(useSpatialIndex);
    const totalStartedAt = performance.now();
    let startedAt = performance.now();
    if (useSpatialIndex) buildRoomSpatialIndex(room, ships, 1000);
    const spatial = performance.now() - startedAt;
    startedAt = performance.now();
    updateDroneBays(room, ships, DT, 1000);
    const drones = performance.now() - startedAt;
    startedAt = performance.now();
    updateBullets(room, DT, 1000);
    const projectiles = performance.now() - startedAt;
    const total = performance.now() - totalStartedAt;
    if (sample < WARMUPS) continue;
    spatialMs.push(spatial);
    droneMs.push(drones);
    projectileMs.push(projectiles);
    totalMs.push(total);
    if (total > TICK_BUDGET_MS) overruns += 1;
  }
  return {
    spatialMs: summary(spatialMs),
    droneMs: summary(droneMs),
    projectileMs: summary(projectileMs),
    totalMs: summary(totalMs),
    overruns,
    samples: SAMPLES
  };
}

const baseline = measure(false);
const optimized = measure(true);
const report = {
  fixture: { ships: 80, drones: 240, bullets: 900, effects: 0, tickBudgetMs: +TICK_BUDGET_MS.toFixed(3) },
  baseline,
  optimized,
  reductions: {
    droneP50Percent: +((1 - optimized.droneMs.p50 / baseline.droneMs.p50) * 100).toFixed(1),
    projectileP50Percent: +((1 - optimized.projectileMs.p50 / baseline.projectileMs.p50) * 100).toFixed(1),
    totalP95Percent: +((1 - optimized.totalMs.p95 / baseline.totalMs.p95) * 100).toFixed(1)
  }
};

assert.ok(optimized.droneMs.p50 < baseline.droneMs.p50 * 0.85,
  `drone decision CPU should materially improve: ${JSON.stringify(report)}`);
assert.ok(optimized.projectileMs.p50 < baseline.projectileMs.p50 * 0.7,
  `projectile broad-phase CPU should materially improve: ${JSON.stringify(report)}`);
assert.ok(optimized.totalMs.p95 < baseline.totalMs.p95,
  `high-load p95 should improve after including index construction: ${JSON.stringify(report)}`);
assert.ok(optimized.overruns <= baseline.overruns,
  `tick overruns must not increase: ${JSON.stringify(report)}`);

fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
fs.writeFileSync(ARTIFACT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`Server spatial performance verification passed: ${ARTIFACT}`);
