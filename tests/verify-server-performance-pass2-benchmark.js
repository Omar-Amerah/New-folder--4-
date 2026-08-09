#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const {
  RoomSpatialIndex,
  shipBroadPhaseRadius,
  droneBroadPhaseRadius
} = require("../src/server/spatialIndex");
const { createRoom } = require("../src/server/rooms");
const { broadcastSnapshot } = require("../src/server/snapshotDelivery");
const { configureOutbound } = require("../src/server/outbound");

const BEFORE_PATH = path.join("test-artifacts", "performance", "server-spatial-performance-before-second-pass.json");
const AFTER_PATH = path.join("test-artifacts", "performance", "server-spatial-performance.json");
const OUTPUT_PATH = path.join("test-artifacts", "performance", "server-performance-pass2.json");

function fixture() {
  const ships = [];
  const drones = new Map();
  const bullets = [];
  for (let i = 0; i < 80; i += 1) {
    ships.push({ id: `s${i}`, alive: true, x: 500 + (i % 10) * 400, y: 500 + Math.floor(i / 10) * 400, radius: 28 });
  }
  for (let i = 0; i < 240; i += 1) {
    const drone = { id: `d${i}`, x: 450 + (i % 20) * 210, y: 450 + Math.floor(i / 20) * 210, radius: 10 };
    drones.set(drone.id, drone);
  }
  for (let i = 0; i < 900; i += 1) {
    bullets.push({
      id: `b${i}`,
      x: 300 + ((i * 977) % 4400),
      y: 300 + ((i * 1597) % 4400),
      vx: 300 + (i % 8) * 90,
      vy: 100 - (i % 5) * 40,
      life: 5,
      interceptable: i % 3 === 0
    });
  }
  const asteroids = Array.from({ length: 80 }, (_, i) => ({ id: `a${i}`, x: 600 + (i % 10) * 420, y: 600 + Math.floor(i / 10) * 420, radius: 35 }));
  const room = { drones, bullets, map: { revision: 1, asteroidRevision: 1, asteroids } };
  return { room, ships };
}

class LegacyStringIndex {
  constructor(cellSize = 320) {
    this.cellSize = cellSize;
    this.cells = new Map();
    this.records = [];
    this.sequence = 0;
    this.sortCount = 0;
    this.recordAllocations = 0;
    this.keyInterpolations = 0;
  }
  key(x, y) {
    this.keyInterpolations += 1;
    return `${x},${y}`;
  }
  add(entity, radius, order) {
    const record = { entity, order, queryMark: 0 };
    this.recordAllocations += 1;
    this.records.push(record);
    const minX = Math.floor((entity.x - radius) / this.cellSize);
    const maxX = Math.floor((entity.x + radius) / this.cellSize);
    const minY = Math.floor((entity.y - radius) / this.cellSize);
    const maxY = Math.floor((entity.y + radius) / this.cellSize);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const key = this.key(x, y);
        let bucket = this.cells.get(key);
        if (!bucket) this.cells.set(key, (bucket = []));
        bucket.push(record);
      }
    }
  }
  query(minX, minY, maxX, maxY) {
    const out = [];
    const sequence = ++this.sequence;
    for (let y = Math.floor(minY / this.cellSize); y <= Math.floor(maxY / this.cellSize); y += 1) {
      for (let x = Math.floor(minX / this.cellSize); x <= Math.floor(maxX / this.cellSize); x += 1) {
        for (const record of this.cells.get(this.key(x, y)) || []) {
          if (record.queryMark === sequence) continue;
          record.queryMark = sequence;
          out.push(record);
        }
      }
    }
    if (out.length > 1) {
      out.sort((a, b) => a.order - b.order);
      this.sortCount += 1;
    }
    for (let i = 0; i < out.length; i += 1) out[i] = out[i].entity;
    return out;
  }
}

function spatialMicroBenchmark() {
  const ITERATIONS = 120;
  const QUERIES = 1000;
  const { room, ships } = fixture();

  let legacyBuildMs = 0;
  let legacyAllocations = 0;
  let legacyKeyInterpolations = 0;
  let legacy = null;
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const started = performance.now();
    legacy = {
      ships: new LegacyStringIndex(),
      drones: new LegacyStringIndex(),
      projectiles: new LegacyStringIndex(),
      interceptableProjectiles: new LegacyStringIndex(),
      asteroids: new LegacyStringIndex()
    };
    ships.forEach((entity, order) => legacy.ships.add(entity, shipBroadPhaseRadius(entity), order));
    [...room.drones.values()].forEach((entity, order) => legacy.drones.add(entity, droneBroadPhaseRadius(entity), order));
    room.bullets.forEach((entity, order) => {
      legacy.projectiles.add(entity, 0, order);
      if (entity.interceptable) legacy.interceptableProjectiles.add(entity, 0, order);
    });
    room.map.asteroids.forEach((entity, order) => legacy.asteroids.add(entity, entity.radius, order));
    legacyBuildMs += performance.now() - started;
    legacyAllocations += Object.values(legacy).reduce((sum, index) => sum + index.recordAllocations, 0);
    legacyKeyInterpolations += Object.values(legacy).reduce((sum, index) => sum + index.keyInterpolations, 0);
  }

  const index = new RoomSpatialIndex(320);
  index.rebuild(room, ships, 0);
  const allocationsAfterWarmup = index.recordAllocations;
  const bucketsAfterWarmup = index.bucketAllocations;
  const asteroidBuildsAfterWarmup = index.asteroidBuildCount;
  const currentStarted = performance.now();
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) index.rebuild(room, ships, iteration + 1);
  const currentBuildMs = performance.now() - currentStarted;

  let checksumLegacy = 0;
  let queryStarted = performance.now();
  for (let i = 0; i < QUERIES; i += 1) {
    const x = 200 + (i * 137) % 4400;
    const y = 200 + (i * 251) % 4400;
    checksumLegacy += legacy.projectiles.query(x - 280, y - 280, x + 280, y + 280).length
      + legacy.ships.query(x - 280, y - 280, x + 280, y + 280).length
      + legacy.drones.query(x - 280, y - 280, x + 280, y + 280).length;
  }
  const legacyQueryMs = performance.now() - queryStarted;

  let checksumCurrent = 0;
  const sortsBefore = index.querySortCount;
  queryStarted = performance.now();
  for (let i = 0; i < QUERIES; i += 1) {
    const x = 200 + (i * 137) % 4400;
    const y = 200 + (i * 251) % 4400;
    checksumCurrent += index.queryRangeUnordered("projectiles", x, y, 280).length
      + index.queryRangeUnordered("ships", x, y, 280).length
      + index.queryRangeUnordered("drones", x, y, 280).length;
  }
  const currentQueryMs = performance.now() - queryStarted;
  assert.ok(checksumLegacy > 0 && checksumCurrent > 0);

  return {
    iterations: ITERATIONS,
    queries: QUERIES,
    before: {
      buildTotalMs: +legacyBuildMs.toFixed(3),
      buildAverageMs: +(legacyBuildMs / ITERATIONS).toFixed(3),
      queryTotalMs: +legacyQueryMs.toFixed(3),
      sortCount: legacy.projectiles.sortCount + legacy.ships.sortCount + legacy.drones.sortCount,
      recordAllocations: legacyAllocations,
      stringKeyInterpolations: legacyKeyInterpolations,
      asteroidRebuilds: ITERATIONS
    },
    after: {
      buildTotalMs: +currentBuildMs.toFixed(3),
      buildAverageMs: +(currentBuildMs / ITERATIONS).toFixed(3),
      queryTotalMs: +currentQueryMs.toFixed(3),
      sortCount: index.querySortCount - sortsBefore,
      recordAllocationsAfterWarmup: index.recordAllocations - allocationsAfterWarmup,
      bucketAllocationsAfterWarmup: index.bucketAllocations - bucketsAfterWarmup,
      asteroidRebuilds: index.asteroidBuildCount - asteroidBuildsAfterWarmup
    }
  };
}

function snapshotFixture(disableGrouping) {
  const room = createRoom("P2BENCH", { seed: 9988 });
  room.disableSnapshotGrouping = disableGrouping;
  const player = {
    id: "p1", name: "Benchmark", team: "blue", ships: [], design: [],
    dataLinks: [],
    connected: true, money: 1000, bank: 1000, earned: 1000, maxMoney: 1000,
    kills: 0, losses: 0, captures: 0
  };
  room.players.set(player.id, player);
  room.clients = new Set();
  for (let i = 0; i < 32; i += 1) {
    room.clients.add({
      id: `c${i}`,
      player,
      room,
      telemetryFocusShipId: null,
      socket: { destroyed: false, write() { return true; } }
    });
  }
  return room;
}

function snapshotBenchmark(disableGrouping) {
  const room = snapshotFixture(disableGrouping);
  const started = performance.now();
  broadcastSnapshot(room, 1000, true);
  const elapsedMs = performance.now() - started;
  return { elapsedMs: +elapsedMs.toFixed(3), ...room._lastSnapshotDeliveryMetrics };
}

configureOutbound({ writeFrame() { return true; } });
const before = JSON.parse(fs.readFileSync(BEFORE_PATH, "utf8"));
const after = JSON.parse(fs.readFileSync(AFTER_PATH, "utf8"));
const spatial = spatialMicroBenchmark();
const snapshotPerClient = snapshotBenchmark(true);
const snapshotGrouped = snapshotBenchmark(false);

let heapDeltaBytes = null;
if (typeof global.gc === "function") {
  global.gc();
  const beforeHeap = process.memoryUsage().heapUsed;
  spatialMicroBenchmark();
  global.gc();
  heapDeltaBytes = process.memoryUsage().heapUsed - beforeHeap;
}

const report = {
  fixture: after.fixture,
  tick: {
    before: before.optimized.totalMs,
    after: after.optimized.totalMs,
    overrunsBefore: before.optimized.overruns,
    overrunsAfter: after.optimized.overruns
  },
  spatialBuild: {
    before: before.optimized.spatialMs,
    after: after.optimized.spatialMs
  },
  projectileUpdate: {
    before: before.optimized.projectileMs,
    after: after.optimized.projectileMs
  },
  spatialMicro: spatial,
  snapshot: {
    beforePerClient: snapshotPerClient,
    afterGrouped: snapshotGrouped
  },
  allocationProxy: {
    retainedHeapDeltaBytesAfterGc: heapDeltaBytes,
    recordAllocationsAfterWarmup: spatial.after.recordAllocationsAfterWarmup,
    bucketAllocationsAfterWarmup: spatial.after.bucketAllocationsAfterWarmup,
    avoidedStringKeyInterpolations: spatial.before.stringKeyInterpolations
  }
};

assert.ok(report.tick.after.p95 < report.tick.before.p95);
assert.ok(report.spatialBuild.after.p50 < report.spatialBuild.before.p50);
assert.equal(spatial.after.recordAllocationsAfterWarmup, 0);
assert.equal(spatial.after.bucketAllocationsAfterWarmup, 0);
assert.equal(spatial.after.asteroidRebuilds, 0);
assert.equal(snapshotGrouped.groups, 1);
assert.equal(snapshotPerClient.groups, 32);
assert.ok(snapshotGrouped.encodingMs < snapshotPerClient.encodingMs);

fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`Second-pass performance benchmark passed: ${OUTPUT_PATH}`);
