#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const Flags = require("./src/server/performanceFlags");
const RoomTelemetry = require("./src/server/roomTelemetry");
const { updateDroneBays } = require("./src/server/drones");
const { updateBullets } = require("./src/server/projectiles");
const { buildRoomSpatialIndex } = require("./src/server/spatialIndex");

const mode = process.argv.includes("--full") ? "full" : "quick";
const samples = mode === "full" ? 12 : 4;
const warmups = mode === "full" ? 3 : 1;
const DT = 1 / 30;
const ARTIFACT = path.join("test-artifacts", "performance", "phase-6b-drone-runtime.json");

const FIXTURES = mode === "full"
  ? [
    ["small-mixed", 12, 100], ["medium-mixed", 50, 500], ["large-mixed", 150, 1500],
    ["defence-swarm", 150, 2500], ["fighter-swarm", 150, 1000], ["repair-fleet", 100, 100],
    ["extreme-swarm", 300, 3000]
  ]
  : [["small-mixed", 12, 100], ["medium-mixed", 50, 500], ["defence-swarm", 150, 1000]];

function percentile(values, ratio) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] || 0;
}

function summary(values) {
  return {
    p50: +percentile(values, 0.5).toFixed(3),
    p95: +percentile(values, 0.95).toFixed(3),
    max: +Math.max(...values, 0).toFixed(3)
  };
}

function ship(id, ownerId, team, x, y, bayId) {
  return {
    id, ownerId, team, alive: true, x, y, angle: 0, focusTargetId: null,
    commandState: "deployed", hp: 1000, maxHp: 1000, shield: 0, maxShield: 0,
    stats: { frontDamageReduction: 0 }, componentHp: [100], componentMaxHp: [100],
    componentPower: { byComponentIndex: [{ operationalMultiplier: 1 }] },
    componentHeatState: [0], design: [{ x: 5, y: 6, type: "droneBay", droneType: "fighter" }],
    droneBays: [{
      componentIndex: 0, componentId: bayId, droneType: "fighter", mode: "deployed",
      nextLaunchAt: Infinity, launchBlockedBySpawn: false,
      launchEdge: { centerX: 5.5, centerY: 5.25, dx: 0, dy: -1 },
      slots: Array.from({ length: 4 }, (_, slot) => ({ slot, state: "active", droneId: null, productionProgress: 1, pauseReason: null }))
    }]
  };
}

function fixture(droneCount, projectileCount, shape, seed = 1) {
  const room = {
    stateEpoch: 1, _simulationStep: 1, phase: "active", nextEntityId: 100000,
    players: new Map([["blue", { id: "blue", team: "a" }], ["red", { id: "red", team: "b" }]]),
    ships: new Map(), drones: new Map(), bullets: [], projectileById: new Map(),
    _projectileLookupInitialized: true, effects: [], stations: [],
    map: { asteroids: [], safeZones: [] }, rules: { gameMode: "teams" },
    world: { width: 50000, height: 50000 }
  };
  const parentCount = shape === "one-per-parent" ? droneCount : Math.max(1, Math.ceil(droneCount / (shape === "several-bays" ? 8 : 4)));
  const parents = [];
  for (let i = 0; i < parentCount; i += 1) {
    const ownerId = i % 2 === 0 ? "blue" : "red";
    const team = ownerId === "blue" ? "a" : "b";
    const x = 1000 + (i % 20) * (shape === "dispersed" ? 1800 : 160);
    const y = 1000 + Math.floor(i / 20) * (shape === "dispersed" ? 1800 : 160);
    const parent = ship(`carrier-${i}`, ownerId, team, x, y, `bay-${i}`);
    room.ships.set(parent.id, parent);
    parents.push(parent);
  }
  const enemy = ship("benchmark-enemy", "red", "b", 25000, 25000, "enemy-bay");
  enemy.droneBays = [];
  room.ships.set(enemy.id, enemy);
  for (let i = 0; i < droneCount; i += 1) {
    const parent = parents[shape === "one-per-parent" ? i % parents.length : Math.floor(i / Math.max(1, Math.ceil(droneCount / parents.length))) % parents.length];
    const grouped = shape === "grouped" || shape === "several-per-bay" || shape === "several-bays";
    const x = parent.x + (grouped ? (i % 8) * 12 : ((i * 977 + seed * 13) % 1600));
    const y = parent.y + (grouped ? Math.floor(i % 8 / 2) * 12 : ((i * 1597 + seed * 7) % 1600));
    const ownerId = parent.ownerId;
    const drone = {
      id: `drone-${i}`, ownerId, ownerPlayerId: ownerId, teamId: parent.team,
      parentShipId: parent.id, bayComponentId: parent.droneBays[0].componentId,
      bayComponentIndex: 0, slot: i % 4, squadIndex: i % 4, type: shape === "defence-swarm" ? "defence" : shape === "repair-fleet" ? "repair" : "fighter", droneType: "fighter",
      x, y, vx: 0, vy: 0, angle: 0, radius: 10, hull: 45, maxHull: 45,
      state: "active", commandState: "deployed", fuelRemainingSeconds: 20,
      nextDecisionAt: 0, nextThinkAt: 0, nextActionAt: Infinity, targetId: null,
      authoritativeSequence: i, removed: false, destroyed: false
    };
    if (drone.type === "defence") drone.droneType = "defence";
    if (drone.type === "repair") drone.droneType = "repair";
    parent.droneBays[0].slots[i % 4].droneId = drone.id;
    room.drones.set(drone.id, drone);
  }
  for (let i = 0; i < projectileCount; i += 1) {
    const ownerId = i % 2 ? "blue" : "red";
    const angle = ((i * 37 + seed) % 360) * Math.PI / 180;
    const projectile = {
      id: `projectile-${i}`, type: i % 5 === 0 ? "missile" : "bolt", ownerId,
      x: 300 + ((i * 977 + seed * 17) % 49000), y: 300 + ((i * 1597 + seed * 11) % 49000),
      vx: Math.cos(angle) * (400 + (i % 7) * 60), vy: Math.sin(angle) * (400 + (i % 7) * 60),
      life: 5, damage: 0, hp: 10, interceptable: i % 3 === 0
    };
    room.bullets.push(projectile);
    room.projectileById.set(projectile.id, projectile);
  }
  const ships = [...room.ships.values()];
  for (const parent of parents) parent.focusTargetId = enemy.id;
  buildRoomSpatialIndex(room, ships, 0);
  return { room, ships };
}

function checksum(room) {
  let hash = 2166136261 >>> 0;
  const values = [...room.drones.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const drone of values) {
    for (const value of [drone.x, drone.y, drone.vx, drone.vy, drone.hull, drone.targetId ? String(drone.targetId).length : 0]) {
      const number = typeof value === "number" ? Math.round(value * 1000) : value;
      const text = String(number);
      for (const character of text) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
    }
  }
  return hash >>> 0;
}

function runMode(droneCount, projectileCount, shape, optimized, seed) {
  Flags.__setOPTIMIZED_DRONE_RUNTIME(optimized);
  Flags.__setINCREMENTAL_SPATIAL_INDEX(true);
  const roomData = fixture(droneCount, projectileCount, shape, seed);
  const { room, ships } = roomData;
  const stages = { runtime: [], decision: [], movement: [], separation: [], context: [], projectileBroadPhase: [], projectileNarrowPhase: [] };
  const counters = [];
  let now = 1000;
  for (let sample = 0; sample < warmups + samples; sample += 1) {
    room._simulationStep += 1;
    RoomTelemetry.resetRoomTelemetry(room);
    const started = performance.now();
    updateDroneBays(room, ships, DT, now);
    const droneStage = performance.now() - started;
    updateBullets(room, DT, now);
    if (sample >= warmups) {
      const telemetry = room._roomTelemetry;
      stages.runtime.push(droneStage);
      stages.decision.push(telemetry.droneDecisionMs || 0);
      stages.movement.push(telemetry.droneMovementMs || 0);
      stages.separation.push(telemetry.droneSeparationMs || 0);
      stages.context.push(telemetry.droneContextBuildMs || 0);
      stages.projectileBroadPhase.push(telemetry.projectileDroneBroadPhaseMs || 0);
      stages.projectileNarrowPhase.push(telemetry.projectileDroneNarrowPhaseMs || 0);
      counters.push({
        spatialQueries: telemetry.projectileDroneQueries || 0,
        candidates: telemetry.projectileDroneCandidates || 0,
        contextsBuilt: telemetry.droneContextsBuilt || 0,
        contextHits: telemetry.droneContextHits || 0,
        targetReferenceHits: telemetry.droneTargetReferenceHits || 0,
        targetReferenceMisses: telemetry.droneTargetReferenceMisses || 0,
        decisionsRun: telemetry.droneDecisionsRun || 0,
        decisionsDeferred: telemetry.droneDecisionsDeferred || 0,
        fullScanFallbacks: telemetry.projectileDroneFullScanFallbacks || 0
      });
    }
    now += DT * 1000;
  }
  const latest = counters[counters.length - 1] || {};
  return {
    mode: optimized ? "optimized" : "legacy",
    completeDroneStage: summary(stages.runtime),
    decisionStage: summary(stages.decision),
    physicalMovement: summary(stages.movement),
    separation: summary(stages.separation),
    contextConstruction: summary(stages.context),
    projectileDroneBroadPhase: summary(stages.projectileBroadPhase),
    projectileDroneNarrowPhase: summary(stages.projectileNarrowPhase),
    spatialQueryCount: latest.spatialQueries || 0,
    candidatesVisited: latest.candidates || 0,
    contextReuseRatio: (latest.contextsBuilt || 0) + (latest.contextHits || 0) > 0
      ? +((latest.contextHits || 0) / ((latest.contextsBuilt || 0) + (latest.contextHits || 0))).toFixed(3)
      : 0,
    targetReferenceHitRatio: (latest.targetReferenceHits || 0) + (latest.targetReferenceMisses || 0) > 0
      ? +((latest.targetReferenceHits || 0) / ((latest.targetReferenceHits || 0) + (latest.targetReferenceMisses || 0))).toFixed(3)
      : 0,
    decisionsRun: latest.decisionsRun || 0,
    decisionsDeferred: latest.decisionsDeferred || 0,
    fullScanFallbacks: latest.fullScanFallbacks || 0,
    outcomeChecksum: checksum(room),
    fullSimulationStepMeasured: false
  };
}

const fixtures = [];
for (const [name, drones, projectiles] of FIXTURES) {
  const legacy = runMode(drones, projectiles, name, false, 7);
  const optimized = runMode(drones, projectiles, name, true, 7);
  const legacyRepeat = runMode(drones, projectiles, name, false, 7);
  const optimizedRepeat = runMode(drones, projectiles, name, true, 7);
  fixtures.push({
    scenario: name,
    drones,
    projectiles,
    legacy,
    optimized,
    deterministicChecksum: legacy.outcomeChecksum === legacyRepeat.outcomeChecksum
      && optimized.outcomeChecksum === optimizedRepeat.outcomeChecksum,
    legacyOptimizedChecksumEqual: legacy.outcomeChecksum === optimized.outcomeChecksum
  });
}

Flags.__setOPTIMIZED_DRONE_RUNTIME(false);
Flags.__setINCREMENTAL_SPATIAL_INDEX(false);
const output = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  mode,
  methodology: {
    warmupSamples: warmups,
    measuredSamples: samples,
    timing: "performance.now wall-clock around the production drone and projectile stages",
    fullSimulationStepMeasured: false,
    note: "This benchmark invokes updateDroneBays and updateBullets with the production spatial boundary; it is a subsystem benchmark, not a whole-server simulation benchmark."
  },
  fixtures,
  allIndexedFallbacksZero: fixtures.every((fixture) => fixture.optimized.fullScanFallbacks === 0),
  allChecksummed: fixtures.every((fixture) => fixture.deterministicChecksum),
  legacyOptimizedChecksumsEqual: fixtures.every((fixture) => fixture.legacyOptimizedChecksumEqual)
};
fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
fs.writeFileSync(ARTIFACT, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ outputPath: ARTIFACT, mode, fixtures: fixtures.length, allIndexedFallbacksZero: output.allIndexedFallbacksZero, allChecksummed: output.allChecksummed, legacyOptimizedChecksumsEqual: output.legacyOptimizedChecksumsEqual }, null, 2));
