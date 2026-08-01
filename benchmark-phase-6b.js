#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const Flags = require("./src/server/performanceFlags");
const RoomTelemetry = require("./src/server/roomTelemetry");
const { updateDroneBays, CONFIG: DRONE_CONFIG } = require("./src/server/drones");
const { updateBullets } = require("./src/server/projectiles");
const { buildRoomSpatialIndex } = require("./src/server/spatialIndex");

const mode = process.argv.includes("--full") ? "full" : "quick";
const samples = mode === "full" ? 12 : 4;
const warmups = mode === "full" ? 3 : 1;
const DT = 1 / 30;
const ARTIFACT = path.join("test-artifacts", "performance", "phase-6b-drone-runtime.json");

const FIXTURES = mode === "full"
  ? [
    { name: "small-mixed", drones: 12, projectiles: 100, shape: "mixed" },
    { name: "medium-mixed", drones: 50, projectiles: 500, shape: "mixed" },
    { name: "large-mixed", drones: 150, projectiles: 1500, shape: "mixed" },
    { name: "defence-grouped", drones: 150, projectiles: 2500, shape: "defence-grouped", primary: true },
    { name: "defence-valid-dispersed", drones: 150, projectiles: 2500, shape: "defence-valid-dispersed", primary: true },
    { name: "defence-outside-command-range", drones: 150, projectiles: 2500, shape: "defence-outside-command-range", diagnostic: true },
    { name: "fighter-swarm", drones: 150, projectiles: 1000, shape: "fighter-valid", primary: true },
    { name: "repair-fleet", drones: 100, projectiles: 100, shape: "repair-valid", primary: true },
    { name: "extreme-swarm", drones: 300, projectiles: 3000, shape: "mixed" }
  ]
  : [
    { name: "small-mixed", drones: 12, projectiles: 100, shape: "mixed" },
    { name: "medium-mixed", drones: 50, projectiles: 500, shape: "mixed" },
    { name: "defence-grouped", drones: 150, projectiles: 1000, shape: "defence-grouped", primary: true },
    { name: "defence-valid-dispersed", drones: 150, projectiles: 1000, shape: "defence-valid-dispersed", primary: true },
    { name: "defence-outside-command-range", drones: 150, projectiles: 1000, shape: "defence-outside-command-range", diagnostic: true }
  ];

function roleForShape(shape) {
  if (String(shape).startsWith("defence")) return "defence";
  if (String(shape).startsWith("repair")) return "repair";
  return "fighter";
}

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

function ship(id, ownerId, team, x, y, bayId, droneType = "fighter") {
  return {
    id, ownerId, team, alive: true, x, y, angle: 0, focusTargetId: null,
    commandState: "deployed", hp: 1000, maxHp: 1000, shield: 0, maxShield: 0,
    stats: { frontDamageReduction: 0 }, componentHp: [100], componentMaxHp: [100],
    componentPower: { byComponentIndex: [{ operationalMultiplier: 1 }] },
    componentCellIndex: new Map(Array.from({ length: 15 * 15 }, (_, index) => [index, 0])),
    dirtyComponents: new Set(),
    componentHeatState: [0], design: [{ x: 5, y: 6, type: "droneBay", droneType }],
    droneBays: [{
      componentIndex: 0, componentId: bayId, droneType, mode: "deployed",
      nextLaunchAt: Infinity, launchBlockedBySpawn: false,
      launchEdge: { centerX: 5.5, centerY: 5.25, dx: 0, dy: -1 },
      slots: Array.from({ length: 4 }, (_, slot) => ({ slot, state: "active", droneId: null, productionProgress: 1, pauseReason: null }))
    }]
  };
}

function dronePosition(parent, index, shape, seed) {
  if (shape === "defence-grouped") {
    const angle = (index % 8) * Math.PI / 4;
    const radius = 50 + (index % 4) * 55;
    return { x: parent.x + Math.cos(angle) * radius, y: parent.y + Math.sin(angle) * radius };
  }
  if (shape === "defence-valid-dispersed") {
    const angle = ((index * 47 + seed * 11) % 360) * Math.PI / 180;
    const radius = 80 + (index % 8) * 22;
    return { x: parent.x + Math.cos(angle) * radius, y: parent.y + Math.sin(angle) * radius };
  }
  if (shape === "defence-outside-command-range") {
    const angle = ((index * 47 + seed * 11) % 360) * Math.PI / 180;
    const radius = 800 + (index % 8) * 100;
    return { x: parent.x + Math.cos(angle) * radius, y: parent.y + Math.sin(angle) * radius };
  }
  if (shape === "fighter-valid") {
    const angle = ((index * 37 + seed * 7) % 360) * Math.PI / 180;
    const radius = 120 + (index % 8) * 95;
    return { x: parent.x + Math.cos(angle) * radius, y: parent.y + Math.sin(angle) * radius };
  }
  if (shape === "repair-valid") {
    const angle = ((index * 29 + seed * 5) % 360) * Math.PI / 180;
    const radius = 60 + (index % 6) * 45;
    return { x: parent.x + Math.cos(angle) * radius, y: parent.y + Math.sin(angle) * radius };
  }
  const grouped = shape === "grouped" || shape === "several-per-bay" || shape === "several-bays";
  return {
    x: parent.x + (grouped ? (index % 8) * 12 : ((index * 977 + seed * 13) % 1600)),
    y: parent.y + (grouped ? Math.floor(index % 8 / 2) * 12 : ((index * 1597 + seed * 7) % 1600))
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
  const droneType = roleForShape(shape);
  const parents = [];
  for (let i = 0; i < parentCount; i += 1) {
    const ownerId = i % 2 === 0 ? "blue" : "red";
    const team = ownerId === "blue" ? "a" : "b";
    const spacing = String(shape).startsWith("defence") ? 700 : shape === "dispersed" ? 1800 : 160;
    const x = 1000 + (i % 20) * spacing;
    const y = 1000 + Math.floor(i / 20) * spacing;
    const parent = ship(`carrier-${i}`, ownerId, team, x, y, `bay-${i}`, droneType);
    room.ships.set(parent.id, parent);
    parents.push(parent);
  }
  const enemy = ship("benchmark-enemy", "red", "b", 25000, 25000, "enemy-bay", "fighter");
  enemy.droneBays = [];
  room.ships.set(enemy.id, enemy);
  for (let i = 0; i < droneCount; i += 1) {
    const parent = parents[shape === "one-per-parent" ? i % parents.length : Math.floor(i / Math.max(1, Math.ceil(droneCount / parents.length))) % parents.length];
    const position = dronePosition(parent, i, shape, seed);
    const typeConfig = DRONE_CONFIG.types[droneType] || DRONE_CONFIG.types.fighter;
    const ownerId = parent.ownerId;
    const drone = {
      id: `drone-${i}`, ownerId, ownerPlayerId: ownerId, teamId: parent.team,
      parentShipId: parent.id, bayComponentId: parent.droneBays[0].componentId,
      bayComponentIndex: 0, slot: i % 4, squadIndex: i % 4, type: droneType, droneType,
      x: position.x, y: position.y, vx: 0, vy: 0, angle: 0, radius: 10, hull: typeConfig.hull, maxHull: typeConfig.hull,
      state: "active", commandState: "deployed", fuelRemainingSeconds: typeConfig.fuelSeconds,
      nextDecisionAt: 0, nextThinkAt: 0, nextActionAt: Infinity, targetId: null,
      authoritativeSequence: i, removed: false, destroyed: false
    };
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

function semanticTargetKind(room, drone) {
  const target = drone.targetId
    ? room.drones.get(drone.targetId) || room.ships.get(drone.targetId) || room.projectileById.get(drone.targetId)
    : null;
  if (!target) return null;
  if (room.drones.get(target.id) === target) return "drone";
  if (room.ships.get(target.id) === target) return "ship";
  if (room.projectileById.get(target.id) === target) return "projectile";
  return null;
}

function semanticTargetPermitted(room, drone) {
  const target = drone.targetId
    ? room.drones.get(drone.targetId) || room.ships.get(drone.targetId) || room.projectileById.get(drone.targetId)
    : null;
  if (!target) return true;
  if (target.life !== undefined) return target.life > 0 && target.ownerId !== drone.ownerId;
  if (drone.type === "repair") return target.ownerId === drone.ownerId && target.alive !== false;
  return target.ownerId !== drone.ownerId && target.alive !== false && !target.destroyed && !target.removed;
}

function semanticFixture(type, seed = 19) {
  const shape = type === "defence" ? "defence-grouped" : type === "repair" ? "repair-valid" : "fighter-valid";
  const roomData = fixture(3, 0, shape, seed);
  const { room, ships } = roomData;
  const parent = room.ships.get("carrier-0");
  const enemy = room.ships.get("benchmark-enemy");
  enemy.x = parent.x + 180;
  enemy.y = parent.y;
  enemy.hp = type === "destruction" ? 10 : 1000;
  enemy.maxHp = enemy.hp;
  if (type === "destruction") {
    enemy.componentHp[0] = 10;
    enemy.componentMaxHp[0] = 10;
  }
  parent.focusTargetId = ["fighter", "destruction"].includes(type) ? enemy.id : null;
  for (const drone of room.drones.values()) {
    drone.nextDecisionAt = 0;
    drone.nextThinkAt = 0;
    drone.nextActionAt = 1000;
  }
  if (type === "repair") {
    parent.componentHp[0] = 50;
    parent.componentMaxHp[0] = 100;
    parent.hp = 950;
    parent.maxHp = 1000;
  }
  if (type === "defence") {
    const missile = {
      id: "semantic-missile",
      type: "missile",
      ownerId: "red",
      x: parent.x + 120,
      y: parent.y,
      vx: 0,
      vy: 0,
      life: 5,
      damage: 0,
      hp: 100,
      interceptable: true
    };
    room.bullets.push(missile);
    room.projectileById.set(missile.id, missile);
  }
  buildRoomSpatialIndex(room, ships, 1000);
  return roomData;
}

function runSemanticMode(type, optimized) {
  Flags.__setOPTIMIZED_DRONE_RUNTIME(optimized);
  Flags.__setINCREMENTAL_SPATIAL_INDEX(true);
  const { room, ships } = semanticFixture(type);
  let now = 1000;
  for (let step = 0; step < 12; step += 1) {
    room._simulationStep = 200 + step;
    updateDroneBays(room, ships, DT, now);
    updateBullets(room, DT, now);
    now += DT * 1000;
  }
  const drones = [...room.drones.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const finite = drones.every((drone) => [drone.x, drone.y, drone.vx, drone.vy, drone.fuelRemainingSeconds, drone.hull].every(Number.isFinite));
  const targetKinds = drones.map((drone) => semanticTargetKind(room, drone));
  const targetIds = drones.map((drone) => drone.targetId || null);
  const destroyedIds = [
    ...[...room.ships.values()].filter((ship) => ship.alive === false || ship.destroyed).map((ship) => ship.id),
    ...[...room.drones.values()].filter((drone) => drone.destroyed).map((drone) => drone.id)
  ].sort();
  return {
    targetKinds,
    targetIds,
    shots: room.effects.filter((effect) => effect.type === "droneshot").length,
    repairs: room.effects.filter((effect) => effect.type === "dronerepair").length,
    fuel: drones.map((drone) => +Number(drone.fuelRemainingSeconds).toFixed(6)),
    states: drones.map((drone) => `${drone.state}:${drone.returnReason || ""}`),
    destroyedIds,
    collisionHits: room._roomTelemetry.projectileDroneHits || 0,
    hulls: drones.map((drone) => +Number(drone.hull).toFixed(6)),
    finite,
    targetsPermitted: drones.every((drone) => semanticTargetPermitted(room, drone))
  };
}

function runSemanticAcceptance() {
  const checks = [];
  for (const type of ["fighter", "destruction", "defence", "repair"]) {
    const legacy = runSemanticMode(type, false);
    const optimized = runSemanticMode(type, true);
    const parity = {
      targetKinds: legacy.targetKinds,
      targetIds: legacy.targetIds,
      shots: legacy.shots,
      repairs: legacy.repairs,
      fuel: legacy.fuel,
      states: legacy.states,
      destroyedIds: legacy.destroyedIds,
      collisionHits: legacy.collisionHits,
      hulls: legacy.hulls
    };
    const optimizedParity = {
      targetKinds: optimized.targetKinds,
      targetIds: optimized.targetIds,
      shots: optimized.shots,
      repairs: optimized.repairs,
      fuel: optimized.fuel,
      states: optimized.states,
      destroyedIds: optimized.destroyedIds,
      collisionHits: optimized.collisionHits,
      hulls: optimized.hulls
    };
    assert.deepEqual(optimizedParity, parity, `${type} semantic parity`);
    assert.equal(legacy.finite && optimized.finite, true, `${type} has no non-finite state`);
    assert.equal(legacy.targetsPermitted && optimized.targetsPermitted, true, `${type} targets remain permitted`);
    if (type === "fighter") assert.ok(optimized.shots > 0, "fighter semantic fixture exercises attacks");
    if (type === "destruction") {
      assert.ok(optimized.shots > 0, "destruction semantic fixture exercises attacks");
      assert.ok(optimized.destroyedIds.includes("benchmark-enemy"), "destruction semantic fixture exercises destruction");
    }
    if (type === "defence") assert.ok(optimized.targetKinds.includes("projectile"), "defence semantic fixture exercises missile-first targeting");
    if (type === "repair") assert.ok(optimized.repairs > 0, "repair semantic fixture exercises repairs");
    checks.push({ type, legacy, optimized, parity: true });
  }
  return checks;
}

const fixtures = [];
for (const fixtureDefinition of FIXTURES) {
  const { name, drones, projectiles, shape, diagnostic = false, primary = false } = fixtureDefinition;
  const legacy = runMode(drones, projectiles, shape, false, 7);
  const optimized = runMode(drones, projectiles, shape, true, 7);
  const legacyRepeat = runMode(drones, projectiles, shape, false, 7);
  const optimizedRepeat = runMode(drones, projectiles, shape, true, 7);
  fixtures.push({
    scenario: name,
    drones,
    projectiles,
    shape,
    diagnostic,
    primary,
    legacy,
    optimized,
    deterministicChecksum: legacy.outcomeChecksum === legacyRepeat.outcomeChecksum
      && optimized.outcomeChecksum === optimizedRepeat.outcomeChecksum,
    legacyOptimizedChecksumEqual: legacy.outcomeChecksum === optimized.outcomeChecksum,
    legacyOptimizedChecksumExplanation: legacy.outcomeChecksum === optimized.outcomeChecksum
      ? "Legacy and optimized positions matched for this fixture."
      : "Informational difference: optimized role-specific decision cadence can change exact intermediate positions; semantic parity is enforced separately."
  });
}

const semanticChecks = runSemanticAcceptance();

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
    note: "This benchmark invokes updateDroneBays and updateBullets with the production spatial boundary; it is a subsystem benchmark, not a whole-server simulation benchmark.",
    legacyOptimizedChecksumPolicy: "Exact legacy/optimized position checksums are informational because role-specific optimized cadences intentionally differ; deterministic repeat checksums and semantic parity are mandatory."
  },
  fixtures,
  allIndexedFallbacksZero: fixtures.every((fixture) => fixture.optimized.fullScanFallbacks === 0),
  allChecksummed: fixtures.every((fixture) => fixture.deterministicChecksum),
  legacyOptimizedChecksumsEqual: fixtures.every((fixture) => fixture.legacyOptimizedChecksumEqual),
  semanticChecks,
  allSemanticContracts: semanticChecks.every((check) => check.parity),
  primaryDefenceScenarios: fixtures
    .filter((fixture) => fixture.primary && fixture.shape.startsWith("defence"))
    .map((fixture) => fixture.scenario),
  diagnosticScenarios: fixtures.filter((fixture) => fixture.diagnostic).map((fixture) => fixture.scenario)
};
assert.equal(output.allIndexedFallbacksZero, true, "Phase 6B benchmark encountered an indexed projectile full-scan fallback");
assert.equal(output.allChecksummed, true, "Phase 6B benchmark is not deterministic across repeated runs");
assert.equal(output.allSemanticContracts, true, "Phase 6B semantic contract parity failed");
assert.ok(output.primaryDefenceScenarios.includes("defence-grouped"), "Grouped Defence fixture is required in the primary benchmark set");
assert.ok(output.primaryDefenceScenarios.includes("defence-valid-dispersed"), "Valid dispersed Defence fixture is required in the primary benchmark set");
assert.ok(!output.primaryDefenceScenarios.includes("defence-outside-command-range"), "Outside-command-range Defence fixture must remain diagnostic");
fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
fs.writeFileSync(ARTIFACT, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({
  outputPath: ARTIFACT,
  mode,
  fixtures: fixtures.length,
  primaryDefenceScenarios: output.primaryDefenceScenarios,
  diagnosticScenarios: output.diagnosticScenarios,
  allIndexedFallbacksZero: output.allIndexedFallbacksZero,
  allChecksummed: output.allChecksummed,
  allSemanticContracts: output.allSemanticContracts,
  legacyOptimizedChecksumsEqual: output.legacyOptimizedChecksumsEqual
}, null, 2));
