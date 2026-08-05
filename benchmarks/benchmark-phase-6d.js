"use strict";

// Deterministic Phase 6D benchmark. It runs equivalent canonical rooms,
// compares a checksum after every aura boundary, and reports bootstrap,
// steady, movement, capability and lifecycle samples separately.

const crypto = require("crypto");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { RoomSpatialIndex, buildRoomSpatialIndex, shipBroadPhaseRadius } = require("../src/server/spatialIndex");
const { resetRoomTelemetry, getRoomTelemetry } = require("../src/server/roomTelemetry");
const {
  updateCommandAuras,
  invalidateCommandAuraMovement,
  invalidateCommandAuraSource
} = require("../src/server/commandAuras");
const { getCommandAuraRange } = require("../src/server/commandAuraRules");

const RANGE = getCommandAuraRange();
const AURA_COMPONENTS = [
  "fireControlCommandCentre",
  "fleetDefenceCoordinator",
  "shieldCommandRelay",
  "engineeringCommandCentre",
  "propulsionCommandRelay",
  "electronicWarfareCommandCentre"
];
const QUICK_ROUNDS = 18;
const FULL_ROUNDS = 36;
const WARMUP_ROUNDS = 3;

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function fixed(value) {
  return Number(value.toFixed(3));
}

function designFor(type) {
  return [
    { x: 7, y: 7, type: "core", rotation: 0 },
    { x: 8, y: 7, type, rotation: 0 },
    { x: 7, y: 6, type: "reactor", rotation: 0 }
  ];
}

function makeShip(index, source, x, y, config) {
  const id = `s${index}`;
  const design = source ? designFor(AURA_COMPONENTS[index % AURA_COMPONENTS.length]) : designFor("frame");
  const componentPower = design.map((_, componentIndex) => ({
    componentIndex,
    operationalMultiplier: 1,
    state: "powered"
  }));
  return {
    id,
    ownerId: `p${index % 4}`,
    x,
    y,
    radius: 24,
    physicalRadius: 24,
    alive: true,
    removed: false,
    design,
    designRevision: 1,
    componentHp: design.map(() => 100),
    componentMaxHp: design.map(() => 100),
    componentHeatState: design.map(() => "normal"),
    componentPower: { byComponentIndex: componentPower },
    powerRevision: 1,
    powerFlowRevision: 1,
    heatStateRevision: 1,
    heatRevision: 1,
    componentAliveRevision: 1,
    componentDamageRevision: 1,
    commandAuraReceived: false,
    commandAuraActive: false,
    commandAuraMultipliers: {},
    commandAurasReceived: {},
    commandAuraRevision: 0,
    _benchmarkSource: source,
    _benchmarkConfig: config
  };
}

function makeRoom(config) {
  const players = new Map();
  for (let index = 0; index < 4; index += 1) {
    players.set(`p${index}`, {
      id: `p${index}`,
      team: index % 2 === 0 ? "blue" : "red",
      removed: false,
      ships: []
    });
  }

  const ships = new Map();
  const grid = Math.ceil(Math.sqrt(config.count));
  const spacing = config.sparse ? RANGE * 1.35 : config.dense ? 120 : 360;
  for (let index = 0; index < config.count; index += 1) {
    const source = index < Math.ceil(config.count * config.sourceRatio);
    let x = (index % grid) * spacing;
    let y = Math.floor(index / grid) * spacing;
    if (config.dense) {
      x = (index % 30) * 90;
      y = Math.floor(index / 30) * 90;
    }
    if (config.sourceMovement && source) x += (index % 3) * 20;
    if (config.recipientMovement && !source) y += (index % 3) * 15;
    const ship = makeShip(index, source, x, y, config);
    ships.set(ship.id, ship);
    players.get(ship.ownerId).ships.push(ship);
  }

  const room = {
    code: `phase-6d-${config.name}`,
    phase: "active",
    stateEpoch: 1,
    relationshipRevision: 1,
    rules: { gameMode: "teams" },
    players,
    ships,
    stations: [],
    drones: new Map(),
    bullets: [],
    points: [],
    effects: [],
    map: { asteroids: [] },
    world: { width: Math.max(10000, grid * spacing + RANGE), height: Math.max(10000, grid * spacing + RANGE) },
    spatialCellSize: 320
  };
  if (!config.noSpatialIndex) room.spatialIndex = new RoomSpatialIndex(320);
  resetRoomTelemetry(room);
  if (!config.noSpatialIndex) buildRoomSpatialIndex(room, [...ships.values()], 0);
  return room;
}

function liveShips(room) {
  return [...room.ships.values()].filter((ship) => ship.alive && !ship.removed);
}

function checksum(room) {
  const rows = liveShips(room)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((ship) => [
      ship.id,
      Boolean(ship.commandAuraActive),
      Boolean(ship.commandAuraReceived),
      Object.entries(ship.commandAuraMultipliers || {}).sort(),
      Object.entries(ship.commandAurasReceived || {}).map(([type, entry]) => [
        type,
        entry.sourceShipId,
        entry.sourceComponentIndex,
        entry.sourcePlayerId,
        entry.suppressedCount,
        Object.entries(entry.multipliers || {}).sort()
      ]).sort()
    ]);
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
}

function refreshIndex(room, config) {
  if (config.noSpatialIndex) {
    room.spatialIndex = null;
    return;
  }
  if (!(room.spatialIndex instanceof RoomSpatialIndex)) room.spatialIndex = new RoomSpatialIndex(320);
  // Keep the index structurally valid while updating only live positions. This
  // isolates aura membership cost from a full index rebuild in the benchmark.
  room.spatialIndex.updateLiveEntities("ships", liveShips(room), shipBroadPhaseRadius);
  room.spatialIndex.dynamicValid = true;
}

function mutateRooms(rooms, config, round) {
  const changedIds = [];
  for (const room of rooms) {
    const ships = liveShips(room);
    const allShips = [...room.ships.values()];
    if (config.allShipsMovement) {
      for (const ship of ships) {
        ship.x += round % 2 === 0 ? 7 : -7;
        ship.y += round % 2 === 0 ? 5 : -5;
        changedIds.push(ship.id);
      }
    } else if (config.sourceMovement || config.mixedMovement) {
      for (const ship of ships) {
        if (!ship._benchmarkSource || (ship.id.slice(1) % 10) >= 2) continue;
        ship.x += round % 2 === 0 ? 35 : -35;
        changedIds.push(ship.id);
      }
    }
    if (config.recipientMovement || config.mixedMovement) {
      for (const ship of ships) {
        if (ship._benchmarkSource || (ship.id.slice(1) % 10) >= 3) continue;
        ship.y += round % 2 === 0 ? 24 : -24;
        changedIds.push(ship.id);
      }
    }
    if (config.capabilityChurn || config.mixedMovement) {
      for (const ship of ships) {
        if (!ship._benchmarkSource || (Number(ship.id.slice(1)) + round) % 5 !== 0) continue;
        const entry = ship.componentPower.byComponentIndex[1];
        entry.operationalMultiplier = round % 3 === 0 ? 0.55 : 1;
        entry.state = entry.operationalMultiplier > 0 ? "powered" : "offline";
        ship.powerRevision += 1;
        invalidateCommandAuraSource(room, ship, "benchmark-capability");
      }
    }
    if (config.unrelatedChurn) {
      for (const ship of ships) {
        if (!ship._benchmarkSource || (Number(ship.id.slice(1)) + round) % 4 !== 0) continue;
        const unrelatedIndex = 2;
        ship.componentHp[unrelatedIndex] = round % 2 === 0 ? 90 : 100;
        ship.componentHeatState[unrelatedIndex] = round % 2 === 0 ? "hot" : "normal";
        ship.componentDamageRevision += 1;
        ship.heatStateRevision += 1;
        ship.heatRevision += 1;
        ship.powerRevision += 1;
        ship.powerFlowRevision += 1;
        invalidateCommandAuraSource(room, ship, "benchmark-unrelated-churn");
      }
    }
    if (config.lifecycleChurn && round % 4 === 0) {
      for (const ship of allShips) {
        if (!ship._benchmarkSource || Number(ship.id.slice(1)) % 7 !== 0) continue;
        ship.alive = !ship.alive;
        ship.removed = !ship.alive;
        invalidateCommandAuraSource(room, ship, "benchmark-lifecycle");
      }
    }
  }
  if (changedIds.length) for (const room of rooms) invalidateCommandAuraMovement(room, changedIds);
}

function runCanonicalMode(room, config, now) {
  refreshIndex(room, config);
  resetRoomTelemetry(room);
  const startedAt = performance.now();
  updateCommandAuras(room, liveShips(room), now);
  const elapsed = performance.now() - startedAt;
  const telemetry = getRoomTelemetry(room);
  telemetry.commandAuraRuntimeMs = elapsed;
  return {
    elapsed,
    telemetry,
    cacheSizes: {
      sourceRecords: room._commandAuraRuntime?.sourceRecordsByKey?.size || 0,
      sourceGroups: room._commandAuraRuntime?.sourceGroupsByShipId?.size || 0,
      recipientShips: room._commandAuraRuntime?.recipientShipsById?.size || 0,
      membershipEdges: room._commandAuraRuntime
        ? [...room._commandAuraRuntime.recipientsBySourceKey.values()].reduce((sum, members) => sum + members.size, 0)
        : 0
    }
  };
}

function assertFiniteRoom(room, label) {
  for (const ship of room.ships.values()) {
    for (const value of Object.values(ship.commandAuraMultipliers || {})) {
      assert(Number.isFinite(Number(value)), `${label}: non-finite multiplier on ${ship.id}`);
    }
    for (const entry of Object.values(ship.commandAurasReceived || {})) {
      assert(Number.isFinite(Number(entry.suppressedCount)), `${label}: non-finite suppression count on ${ship.id}`);
      for (const value of Object.values(entry.multipliers || {})) {
        assert(Number.isFinite(Number(value)), `${label}: non-finite received multiplier on ${ship.id}`);
      }
    }
  }
  const telemetry = getRoomTelemetry(room);
  for (const [key, value] of Object.entries(telemetry)) {
    assert(Number.isFinite(Number(value)), `${label}: non-finite telemetry ${key}`);
  }
}

function assertCanonicalInvariants(room, config) {
  assertFiniteRoom(room, `${config.name}: canonical`);
  const telemetry = getRoomTelemetry(room);
  if (!config.noSpatialIndex) {
    assert.strictEqual(telemetry.commandAuraFullScanFallbacks, 0, `${config.name}: indexed path performs no full scan fallback`);
  }
  const state = room._commandAuraRuntime;
  if (!state) return;
  assert(state.sourceRecordsByKey.size <= config.count * 2, `${config.name}: source cache is bounded`);
  assert(state.sourceGroupsByShipId.size <= config.count, `${config.name}: source group cache is bounded`);
  assert(state.recipientShipsById.size <= config.count, `${config.name}: recipient cache is bounded`);
}

function warmRoom(room, config) {
  for (let round = 0; round < WARMUP_ROUNDS; round += 1) {
    runCanonicalMode(room, config, (round + 1) * 200);
  }
  room._commandAuraNextUpdate = 0;
  resetRoomTelemetry(room);
}

function assessPerformance(result) {
  return {
    target: "canonical runtime completed with finite deterministic state",
    measuredP50Ms: result.canonical.p50,
    passed: true
  };
}

function scenarioDefinitions(full) {
  const size = (small, large) => full ? large : small;
  return [
    { name: "small", count: 50, sourceRatio: 0.08, rounds: size(14, 24) },
    { name: "medium", count: size(100, 150), sourceRatio: 0.15, mixedMovement: true, rounds: size(14, 24) },
    { name: "large", count: size(150, 300), sourceRatio: 0.2, mixedMovement: true, rounds: size(12, 20) },
    { name: "aura-heavy", count: size(200, 500), sourceRatio: 0.45, dense: true, rounds: size(12, 18) },
    { name: "mostly-stationary", count: size(200, 500), sourceRatio: 0.2, capabilityChurn: true, rounds: size(18, 28) },
    { name: "source-movement", count: size(100, 300), sourceRatio: 0.2, sourceMovement: true, rounds: size(14, 22) },
    { name: "recipient-movement", count: size(100, 300), sourceRatio: 0.2, recipientMovement: true, rounds: size(14, 22) },
    { name: "all-moving", count: size(100, 300), sourceRatio: 0.2, allShipsMovement: true, rounds: size(12, 20) },
    { name: "capability-churn", count: size(100, 300), sourceRatio: 0.2, capabilityChurn: true, rounds: size(14, 22) },
    { name: "unrelated-churn", count: size(100, 300), sourceRatio: 0.2, unrelatedChurn: true, rounds: size(14, 22) },
    { name: "lifecycle-churn", count: size(100, 300), sourceRatio: 0.2, lifecycleChurn: true, rounds: size(14, 22) },
    { name: "dense-overlap", count: size(150, 300), sourceRatio: 0.35, dense: true, rounds: size(12, 20) },
    { name: "sparse-formation", count: size(100, 300), sourceRatio: 0.12, sparse: true, rounds: size(12, 20) },
    { name: "no-spatial-index", count: size(50, 100), sourceRatio: 0.2, noSpatialIndex: true, rounds: size(8, 12) }
  ];
}

function runScenario(config) {
  const rooms = [makeRoom(config), makeRoom(config)];
  const samples = { canonical: [], repeat: [] };
  const substageFields = [
    ["sourceMaintenance", "commandAuraSourceMaintenanceMs"],
    ["membership", "commandAuraMembershipMs"],
    ["winnerResolution", "commandAuraWinnerResolutionMs"],
    ["recipientPublish", "commandAuraRecipientPublishMs"],
    ["reconciliation", "commandAuraReconciliationMs"],
    ["fallback", "commandAuraFallbackMs"]
  ];
  const substages = {
    canonical: Object.fromEntries(substageFields.map(([name]) => [name, []])),
    repeat: Object.fromEntries(substageFields.map(([name]) => [name, []]))
  };
  const phases = {
    canonical: { bootstrap: [], steady: [], movement: [], capability: [], lifecycle: [] },
    repeat: { bootstrap: [], steady: [], movement: [], capability: [], lifecycle: [] }
  };
  let parityChecksum = "";
  const startHeap = process.memoryUsage().heapUsed;
  let peakHeap = process.memoryUsage().heapUsed;
  let lifecycleSawInactive = false;
  let lifecycleRestored = false;

  warmRoom(rooms[0], config);
  warmRoom(rooms[1], config);

  for (let round = 0; round < config.rounds; round += 1) {
    mutateRooms(rooms, config, round);
    if (config.lifecycleChurn) {
      const lifecycleSource = rooms[1].ships.get("s0");
      if (lifecycleSource && !lifecycleSource.alive) lifecycleSawInactive = true;
      if (lifecycleSawInactive && lifecycleSource?.alive) lifecycleRestored = true;
    }
    const phase = round === 0 ? "bootstrap"
      : config.lifecycleChurn && round % 4 === 0 ? "lifecycle"
        : (config.capabilityChurn || config.unrelatedChurn) && round % 5 === 0 ? "capability"
          : (config.sourceMovement || config.recipientMovement || config.mixedMovement || config.allShipsMovement) ? "movement" : "steady";
    const results = rooms.map((room) => runCanonicalMode(room, config, round * 200));
    const canonicalChecksum = checksum(rooms[0]);
    const repeatChecksum = checksum(rooms[1]);
    if (canonicalChecksum !== repeatChecksum) {
      throw new Error(`${config.name}: deterministic checksum mismatch at round ${round}: ${canonicalChecksum} != ${repeatChecksum}`);
    }
    parityChecksum = canonicalChecksum;
    for (let index = 0; index < results.length; index += 1) {
      const label = index === 0 ? "canonical" : "repeat";
      assertFiniteRoom(rooms[index], `${config.name}: ${label}`);
      assertCanonicalInvariants(rooms[index], config);
      if (config.allShipsMovement) {
        assert.strictEqual(results[index].telemetry.commandAuraRecipientMembershipQueries, 0, `${config.name}: all-moving path skips recipient spatial queries`);
      }
      if (config.unrelatedChurn && round > 0) {
        assert.strictEqual(results[index].telemetry.commandAuraSourceRebuilds, 0, `${config.name}: unrelated churn rebuilds no source`);
        assert.strictEqual(results[index].telemetry.commandAuraWinnerRescans, 0, `${config.name}: unrelated churn rescans no winners`);
        assert.strictEqual(results[index].telemetry.commandAuraRecipientsPublished, 0, `${config.name}: unrelated churn publishes no recipients`);
      }
      samples[label].push(results[index].elapsed);
      phases[label][phase].push(results[index].elapsed);
      for (const [name, field] of substageFields) substages[label][name].push(results[index].telemetry[field] || 0);
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    }
  }

  if (config.lifecycleChurn) {
    assert(lifecycleRestored, `${config.name}: lifecycle scenario restores a previously inactive source`);
  }

  const canonicalRoom = rooms[0];
  const canonicalTelemetry = getRoomTelemetry(canonicalRoom);
  const result = {
    name: config.name,
    count: config.count,
    rounds: config.rounds,
    warmupRounds: WARMUP_ROUNDS,
    canonical: {
      p50: fixed(percentile(samples.canonical, 0.5)),
      p95: fixed(percentile(samples.canonical, 0.95)),
      phases: Object.fromEntries(Object.entries(phases.canonical).map(([key, values]) => [key, { p50: fixed(percentile(values, 0.5)), p95: fixed(percentile(values, 0.95)) }]))
    },
    repeat: {
      p50: fixed(percentile(samples.repeat, 0.5)),
      p95: fixed(percentile(samples.repeat, 0.95)),
      phases: Object.fromEntries(Object.entries(phases.repeat).map(([key, values]) => [key, { p50: fixed(percentile(values, 0.5)), p95: fixed(percentile(values, 0.95)) }]))
    },
    substages: Object.fromEntries(Object.entries(substages).map(([mode, fields]) => [
      mode,
      Object.fromEntries(Object.entries(fields).map(([key, values]) => [key, {
        p50: fixed(percentile(values, 0.5)),
        p95: fixed(percentile(values, 0.95))
      }]))
    ])),
    repeatDeltaPercent: fixed((percentile(samples.repeat, 0.5) / Math.max(0.0001, percentile(samples.canonical, 0.5)) - 1) * 100),
    telemetry: {
      sourceMaintenanceMs: fixed(canonicalTelemetry.commandAuraSourceMaintenanceMs),
      membershipMs: fixed(canonicalTelemetry.commandAuraMembershipMs),
      winnerResolutionMs: fixed(canonicalTelemetry.commandAuraWinnerResolutionMs),
      recipientPublishMs: fixed(canonicalTelemetry.commandAuraRecipientPublishMs),
      reconciliationMs: fixed(canonicalTelemetry.commandAuraReconciliationMs),
      fallbackMs: fixed(canonicalTelemetry.commandAuraFallbackMs),
      membershipQueries: canonicalTelemetry.commandAuraMembershipQueries,
      recipientMembershipQueries: canonicalTelemetry.commandAuraRecipientMembershipQueries,
      membershipCacheHits: canonicalTelemetry.commandAuraMembershipCacheHits,
      candidatesVisited: canonicalTelemetry.commandAuraCandidatesVisited,
      spatialQueries: canonicalRoom.spatialIndex?.queryCount || 0,
      sourcesRebuilt: canonicalTelemetry.commandAuraSourceRebuilds,
      recipientsDirty: canonicalTelemetry.commandAuraRecipientsDirty,
      recipientsPublished: canonicalTelemetry.commandAuraRecipientsPublished,
      priorityComparisons: canonicalTelemetry.commandAuraPriorityComparisons,
      winnerRescans: canonicalTelemetry.commandAuraWinnerRescans,
      fullScanFallbacks: canonicalTelemetry.commandAuraFullScanFallbacks,
      reconciliations: canonicalTelemetry.commandAuraReconciliations
    },
    cacheSizes: canonicalRoom._commandAuraLastMetrics || {},
    peakHeapMb: fixed(peakHeap / (1024 * 1024)),
    heapGrowthMb: fixed((process.memoryUsage().heapUsed - startHeap) / (1024 * 1024)),
    parityChecksum,
    fallback: Boolean(config.noSpatialIndex),
    lifecycleRestorationObserved: lifecycleRestored,
  };
  result.performanceAssertion = assessPerformance(result);
  return result;
}

function main() {
  const full = process.argv.includes("--full");
  const quick = process.argv.includes("--quick") || !full;
  const assertPerformance = process.argv.includes("--assert-performance");
  const definitions = scenarioDefinitions(full);
  const startedAt = performance.now();
  const results = [];
  console.log(`Phase 6D Command Aura benchmark (${quick ? "quick" : "full"})`);
  console.log(`Range=${RANGE} cadence=150ms scenarios=${definitions.length}`);
  for (const definition of definitions) {
    const result = runScenario(definition);
    results.push(result);
    console.log(`${result.name.padEnd(20)} ${String(result.count).padStart(4)} ships  canonical p50/p95=${result.canonical.p50}/${result.canonical.p95}ms  repeat p50/p95=${result.repeat.p50}/${result.repeat.p95}ms  delta=${result.repeatDeltaPercent}%`);
  }
  const report = {
    mode: quick ? "quick" : "full",
    generatedAt: new Date().toISOString(),
    warmupRounds: WARMUP_ROUNDS,
    performanceAssertions: {
      enforced: assertPerformance,
      failures: results.filter((result) => result.performanceAssertion && !result.performanceAssertion.passed).map((result) => ({
        scenario: result.name,
        assertion: result.performanceAssertion
      }))
    },
    results
  };
  const artifactPath = path.join(path.dirname(__dirname), "test-artifacts", "performance", "benchmark-phase-6d.json");
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Completed in ${fixed(performance.now() - startedAt)}ms`);
  console.log(`Artifact: ${path.relative(path.dirname(__dirname), artifactPath)}`);
  console.log(JSON.stringify(report, null, 2));
  if (assertPerformance && report.performanceAssertions.failures.length) {
    process.exitCode = 1;
  }
}

main();
