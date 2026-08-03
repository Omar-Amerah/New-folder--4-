#!/usr/bin/env node
"use strict";

// Deterministic Phase 4C/4D movement-contact benchmark. Every mode receives a
// freshly cloned fixture generated from the same seed, movement inputs and
// scenario definition. The default is the focused movement/contact microbenchmark;
// --production-recovery also executes the post-solver safety boundary shared by
// tickRoom(), including moved-ship scans and scoped recovery solves.

const fs = require("fs");
const path = require("path");
const { RoomSpatialIndex, buildRoomSpatialIndex, shipBroadPhaseRadius } = require("./src/server/spatialIndex");
const { beginMovementContactStep, buildMovementContactPairs } = require("./src/server/movementContactPairs");
const { updateShipSeparation } = require("./src/server/movementCollision");
const { runMovementContactSafetyPass } = require("./src/server/movementContactSafety");
const { resetRoomTelemetry } = require("./src/server/roomTelemetry");
const { performanceNow } = require("./src/server/utils");

const COUNTS = [100, 250, 500, 1000];
const STEPS = Math.max(1, Number(process.env.MFA_PHASE4CD_STEPS) || 4);
const REPEATS = Math.max(1, Number(process.env.MFA_PHASE4CD_REPEATS) || 2);
const WORLD = { width: 12000, height: 8000 };
const PRODUCTION_RECOVERY = process.argv.includes("--production-recovery");

const MODES = [{ name: "canonical-packed-fleet", productionRecovery: PRODUCTION_RECOVERY }];

const SCENARIOS = [
  "sparse-no-contact",
  "small-contact-islands",
  "dense-packed-fleet",
  "multiple-dense-fleets",
  "stationary-packed-fleet",
  "moving-formation",
  "map-boundary-congestion",
  "station-launch-congestion"
];

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function positionFor(scenario, index, count, random) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const row = Math.floor(index / columns);
  const column = index % columns;
  const denseSpacing = 28;
  if (scenario === "sparse-no-contact") {
    return { x: 600 + (index % 20) * 540, y: 600 + row * 540 };
  }
  if (scenario === "small-contact-islands") {
    const island = Math.floor(index / 10);
    const local = index % 10;
    return {
      x: 700 + (island % 10) * 1100 + (local % 5) * 18,
      y: 700 + Math.floor(island / 10) * 900 + Math.floor(local / 5) * 18
    };
  }
  if (scenario === "multiple-dense-fleets") {
    const fleet = index % 4;
    const local = Math.floor(index / 4);
    const localColumns = Math.max(1, Math.ceil(Math.sqrt(Math.ceil(count / 4))));
    return {
      x: 1600 + fleet * 2500 + (local % localColumns) * denseSpacing,
      y: 1600 + Math.floor(local / localColumns) * denseSpacing
    };
  }
  if (scenario === "map-boundary-congestion") {
    return { x: 62 + (index % 5) * 18, y: 1200 + row * 18 };
  }
  if (scenario === "station-launch-congestion") {
    return { x: 1100 + (index % 8) * 20, y: 1100 + row * 20 };
  }
  if (scenario === "moving-formation" || scenario === "stationary-packed-fleet" || scenario === "dense-packed-fleet") {
    return {
      x: 5200 + (column - columns / 2) * denseSpacing,
      y: 3800 + (row - columns / 2) * denseSpacing
    };
  }
  return { x: 1000 + random() * 10000, y: 700 + random() * 6500 };
}

function fixtureDefinitions(count, scenario, seed) {
  const random = mulberry32(seed + count * 17 + scenario.length * 31);
  const definitions = [];
  for (let index = 0; index < count; index += 1) {
    const position = positionFor(scenario, index, count, random);
    const moving = scenario === "moving-formation" || scenario === "station-launch-congestion";
    const stationary = scenario === "stationary-packed-fleet";
    const speed = moving ? 18 + (index % 5) * 3 : 0;
    definitions.push({
      id: `s${index + 1}`,
      x: position.x,
      y: position.y,
      vx: stationary ? 0 : speed,
      vy: moving ? ((index % 3) - 1) * 4 : 0,
      physicalRadius: 18 + (index % 5 === 0 ? 8 : 0),
      radius: 46,
      mass: 1 + (index % 7) * 2,
      // A launch congestion fixture has a bounded batch of newcomers. Marking
      // every synthetic hull as freshly launched makes contact recovery invoke
      // the spawn planner once per unresolved contact and turns the benchmark
      // into a spawn-planner soak rather than a movement/contact comparison.
      spawnState: scenario === "station-launch-congestion" && index < 8
        ? { launchPoint: { x: position.x, y: position.y }, expiresAt: 100000 }
        : null
    });
  }
  return definitions;
}

function cloneFixture(definitions, code) {
  const room = {
    code,
    phase: "active",
    world: { ...WORLD },
    map: { asteroids: [], relays: [] },
    stations: [],
    ships: new Map(),
    players: new Map(),
    drones: new Map(),
    decoys: new Map(),
    droneCounts: { byOwner: new Map(), byParent: new Map() },
    bullets: [],
    effects: [],
    spatialIndex: new RoomSpatialIndex(320),
    spawnCollisionDiagnostics: {}
  };
  const ships = definitions.map((definition) => ({
    id: definition.id,
    ownerId: "p1",
    team: 1,
    x: definition.x,
    y: definition.y,
    vx: definition.vx,
    vy: definition.vy,
    angle: 0,
    alive: true,
    removed: false,
    radius: definition.radius,
    physicalRadius: definition.physicalRadius,
    stats: { mass: definition.mass, radius: definition.radius, maxHp: 100 },
    design: [],
    componentHp: [],
    movement: {},
    spawnState: definition.spawnState
      ? {
        launchPoint: { ...definition.spawnState.launchPoint },
        expiresAt: definition.spawnState.expiresAt
      }
      : null
  }));
  for (const entity of ships) room.ships.set(entity.id, entity);
  buildRoomSpatialIndex(room, ships, 0);
  return { room, ships };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const ordered = values.slice().sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * p) - 1));
  return ordered[index];
}

function runStep(room, ships, step) {
  const dt = 1 / 30;
  const now = step * dt * 1000;
  resetRoomTelemetry(room);
  const contactStep = beginMovementContactStep(room, ships, now);
  // The production boundary captures previous positions before movement. Keep
  // that ordering here so swept previous/current bounds are actually exercised.
  for (const entity of ships) {
    entity.x += entity.vx * dt;
    entity.y += entity.vy * dt;
  }
  const stepStart = performanceNow();
  const spatialStart = performanceNow();
  if (room.spatialIndex.dynamicValid) {
    room.spatialIndex.updateLiveEntities("ships", ships, shipBroadPhaseRadius);
  } else {
    buildRoomSpatialIndex(room, ships, step);
  }
  const spatialIndexMs = performanceNow() - spatialStart;
  let pairBuildMs = 0;
  buildMovementContactPairs(room, ships, now, { stepId: contactStep });
  const modifiedShipIds = updateShipSeparation(room, ships, dt, now, { circular: true });
  let finalSpatialMs = 0;
  if (PRODUCTION_RECOVERY) {
    const safety = runMovementContactSafetyPass(
      room,
      ships,
      modifiedShipIds,
      dt,
      now,
      {
        circular: true,
        measureSpatialPublication: true
      }
    );
    finalSpatialMs = safety.spatialPublicationMs;
  } else {
    const finalSpatialStart = performanceNow();
    room.spatialIndex.updateLiveEntities("ships", ships, shipBroadPhaseRadius);
    finalSpatialMs = performanceNow() - finalSpatialStart;
  }
  const telemetry = room._roomTelemetry;
  pairBuildMs = finite(telemetry.movementContactPairBuildMs);
  return {
    stepMs: performanceNow() - stepStart,
    pairBuildMs,
    solverMs: finite(telemetry.packedFleetSolverMs || telemetry.shipSeparationMs),
    spatialIndexMs: spatialIndexMs + finalSpatialMs,
    candidatesVisited: finite(telemetry.movementContactPairCandidatesVisited),
    pairsGenerated: finite(telemetry.movementContactPairsGenerated),
    narrowPhaseChecks: finite(telemetry.separationNarrowPhaseChecks),
    iterations: finite(telemetry.separationIterations),
    largestIsland: finite(telemetry.packedFleetLargestIsland),
    remainingOverlaps: finite(telemetry.packedFleetRemainingOverlaps || telemetry.separationUnresolvedPairs),
    recoveryOperations: finite(telemetry.packedFleetRecoveryOperations),
    contactRecoveryBuilds: finite(telemetry.movementContactPairRecoveryBuilds),
    recoveryQueries: finite(telemetry.movementContactRecoveryQueries),
    recoveryCandidatesVisited: finite(telemetry.movementContactRecoveryCandidatesVisited),
    recoveryScanMs: finite(telemetry.movementContactRecoveryScanMs),
    movedShipsScanned: finite(telemetry.movementContactMovedShipsScanned),
    pairPoolSize: room._movementContactPairPool?.length || 0,
    spatialRecordAllocations: room.spatialIndex.recordAllocations || 0
  };
}

function aggregate(samples) {
  const fields = [
    "stepMs", "pairBuildMs", "solverMs", "spatialIndexMs", "candidatesVisited",
    "pairsGenerated", "narrowPhaseChecks", "iterations", "largestIsland",
    "remainingOverlaps", "recoveryOperations", "contactRecoveryBuilds",
    "recoveryQueries", "recoveryCandidatesVisited", "recoveryScanMs",
    "movedShipsScanned", "pairPoolSize", "spatialRecordAllocations"
  ];
  const result = { samples: samples.length, mean: {}, p50: {}, p95: {}, max: {} };
  for (const field of fields) {
    const values = samples.map((sample) => finite(sample[field]));
    result.mean[field] = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    result.p50[field] = percentile(values, 0.5);
    result.p95[field] = percentile(values, 0.95);
    result.max[field] = Math.max(0, ...values);
  }
  return result;
}

function shouldIncludeScenario(count, scenario) {
  if (count < 1000) return true;
  return new Set([
    "sparse-no-contact",
    "small-contact-islands",
    "dense-packed-fleet",
    "map-boundary-congestion"
  ]).has(scenario);
}

const startedAt = new Date().toISOString();
const results = [];
for (const count of COUNTS) {
    for (const scenario of SCENARIOS) {
      if (!shouldIncludeScenario(count, scenario)) continue;
      for (const mode of MODES) {
        const samples = [];
        for (let repeat = 0; repeat < REPEATS; repeat += 1) {
          const definitions = fixtureDefinitions(count, scenario, 12345 + repeat);
          const { room, ships } = cloneFixture(definitions, `${mode.name}:${count}:${scenario}:${repeat}`);
          for (let step = 0; step < STEPS; step += 1) samples.push(runStep(room, ships, step));
        }
        const summary = aggregate(samples);
        results.push({ count, scenario, mode: mode.name, aggregate: summary });
        console.log(`${count} ${scenario} ${mode.name}: p50=${summary.p50.stepMs.toFixed(3)}ms p95=${summary.p95.stepMs.toFixed(3)}ms pairs=${summary.mean.pairsGenerated.toFixed(1)} recoveryQueries=${summary.mean.recoveryQueries.toFixed(1)} recoveryScan=${summary.mean.recoveryScanMs.toFixed(3)}ms remaining=${summary.max.remainingOverlaps}`);
      }
    }
}

const artifact = {
  benchmark: "phase-4cd",
  benchmarkType: PRODUCTION_RECOVERY ? "movement-contact-production-recovery" : "movement-contact-microbenchmark",
  productionPath: PRODUCTION_RECOVERY,
  fullTickRoom: false,
  productionBoundary: PRODUCTION_RECOVERY,
  movementOrdering: PRODUCTION_RECOVERY
    ? "begin contact step -> deterministic movement integration -> pre-solver spatial publication -> pair build -> separation -> final static correction -> moved-ship collection -> final spatial publication -> recovery scan -> one scoped recovery build/solve when needed"
    : "begin contact step -> deterministic movement integration -> spatial publication -> pair build -> separation -> final spatial publication",
  productionRecoveryMode: PRODUCTION_RECOVERY,
  stationLaunchScenarioNote: "station-launch-congestion installs authoritative spawnState but does not invoke a station hangar; use production-path verifier for actual station launches",
  startedAt,
  finishedAt: new Date().toISOString(),
  deterministicSeed: 12345,
  stepsPerRepeat: STEPS,
  repeats: REPEATS,
  world: WORLD,
  modes: MODES,
  scenarios: SCENARIOS,
  results
};
const artifactPath = path.join("test-artifacts", "performance", "benchmark-phase-4cd.json");
fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`Phase 4C/4D ${PRODUCTION_RECOVERY ? "production-recovery benchmark" : "movement-contact microbenchmark"} complete: ${artifactPath}`);
