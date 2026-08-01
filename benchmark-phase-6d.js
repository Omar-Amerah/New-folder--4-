"use strict";

// Deterministic Phase 6D benchmark. It runs equivalent legacy and optimized
// rooms, compares a checksum after every aura boundary, and reports bootstrap,
// steady, movement, capability and lifecycle samples separately.

const crypto = require("crypto");
const { performance } = require("perf_hooks");
const { RoomSpatialIndex, buildRoomSpatialIndex, shipBroadPhaseRadius } = require("./src/server/spatialIndex");
const { resetRoomTelemetry, getRoomTelemetry } = require("./src/server/roomTelemetry");
const {
  updateCommandAuras,
  invalidateCommandAuraMovement,
  invalidateCommandAuraSource
} = require("./src/server/commandAuras");
const {
  __setOPTIMIZED_COMMAND_AURA_RUNTIME
} = require("./src/server/performanceFlags");
const { getCommandAuraRange } = require("./src/server/commandAuraRules");

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
    if (config.sourceMovement || config.mixedMovement) {
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
    if (config.lifecycleChurn && round % 4 === 0) {
      for (const ship of ships) {
        if (!ship._benchmarkSource || Number(ship.id.slice(1)) % 7 !== 0) continue;
        ship.alive = !ship.alive;
        ship.removed = !ship.alive;
        invalidateCommandAuraSource(room, ship, "benchmark-lifecycle");
      }
    }
  }
  if (changedIds.length) for (const room of rooms) invalidateCommandAuraMovement(room, changedIds);
}

function runMode(room, config, optimized, now) {
  refreshIndex(room, config);
  resetRoomTelemetry(room);
  __setOPTIMIZED_COMMAND_AURA_RUNTIME(optimized);
  const startedAt = performance.now();
  updateCommandAuras(room, liveShips(room), now);
  const elapsed = performance.now() - startedAt;
  const telemetry = getRoomTelemetry(room);
  if (!optimized) telemetry.commandAuraRuntimeMs = elapsed;
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
    { name: "capability-churn", count: size(100, 300), sourceRatio: 0.2, capabilityChurn: true, rounds: size(14, 22) },
    { name: "lifecycle-churn", count: size(100, 300), sourceRatio: 0.2, lifecycleChurn: true, rounds: size(14, 22) },
    { name: "dense-overlap", count: size(150, 300), sourceRatio: 0.35, dense: true, rounds: size(12, 20) },
    { name: "sparse-formation", count: size(100, 300), sourceRatio: 0.12, sparse: true, rounds: size(12, 20) },
    { name: "no-spatial-index", count: size(50, 100), sourceRatio: 0.2, noSpatialIndex: true, rounds: size(8, 12) }
  ];
}

function runScenario(config) {
  const rooms = [makeRoom(config), makeRoom(config)];
  const modes = [false, true];
  const samples = { legacy: [], optimized: [] };
  const substageFields = [
    ["sourceMaintenance", "commandAuraSourceMaintenanceMs"],
    ["membership", "commandAuraMembershipMs"],
    ["winnerResolution", "commandAuraWinnerResolutionMs"],
    ["recipientPublish", "commandAuraRecipientPublishMs"],
    ["reconciliation", "commandAuraReconciliationMs"],
    ["fallback", "commandAuraFallbackMs"]
  ];
  const substages = {
    legacy: Object.fromEntries(substageFields.map(([name]) => [name, []])),
    optimized: Object.fromEntries(substageFields.map(([name]) => [name, []]))
  };
  const phases = {
    legacy: { bootstrap: [], steady: [], movement: [], capability: [], lifecycle: [] },
    optimized: { bootstrap: [], steady: [], movement: [], capability: [], lifecycle: [] }
  };
  let parityChecksum = "";
  const startHeap = process.memoryUsage().heapUsed;
  let peakHeap = process.memoryUsage().heapUsed;

  for (let round = 0; round < config.rounds; round += 1) {
    mutateRooms(rooms, config, round);
    const phase = round === 0 ? "bootstrap"
      : config.lifecycleChurn && round % 4 === 0 ? "lifecycle"
        : config.capabilityChurn && round % 5 === 0 ? "capability"
          : (config.sourceMovement || config.recipientMovement || config.mixedMovement) ? "movement" : "steady";
    const results = modes.map((optimized, index) => runMode(rooms[index], config, optimized, round * 200));
    const legacyChecksum = checksum(rooms[0]);
    const optimizedChecksum = checksum(rooms[1]);
    if (legacyChecksum !== optimizedChecksum) {
      throw new Error(`${config.name}: parity checksum mismatch at round ${round}: ${legacyChecksum} != ${optimizedChecksum}`);
    }
    parityChecksum = optimizedChecksum;
    for (let index = 0; index < results.length; index += 1) {
      const label = index === 0 ? "legacy" : "optimized";
      samples[label].push(results[index].elapsed);
      phases[label][phase].push(results[index].elapsed);
      for (const [name, field] of substageFields) substages[label][name].push(results[index].telemetry[field] || 0);
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    }
  }

  const optimizedRoom = rooms[1];
  const optimizedTelemetry = getRoomTelemetry(optimizedRoom);
  const legacyRoom = rooms[0];
  return {
    name: config.name,
    count: config.count,
    rounds: config.rounds,
    legacy: {
      p50: fixed(percentile(samples.legacy, 0.5)),
      p95: fixed(percentile(samples.legacy, 0.95)),
      phases: Object.fromEntries(Object.entries(phases.legacy).map(([key, values]) => [key, { p50: fixed(percentile(values, 0.5)), p95: fixed(percentile(values, 0.95)) }]))
    },
    optimized: {
      p50: fixed(percentile(samples.optimized, 0.5)),
      p95: fixed(percentile(samples.optimized, 0.95)),
      phases: Object.fromEntries(Object.entries(phases.optimized).map(([key, values]) => [key, { p50: fixed(percentile(values, 0.5)), p95: fixed(percentile(values, 0.95)) }]))
    },
    substages: Object.fromEntries(Object.entries(substages).map(([mode, fields]) => [
      mode,
      Object.fromEntries(Object.entries(fields).map(([key, values]) => [key, {
        p50: fixed(percentile(values, 0.5)),
        p95: fixed(percentile(values, 0.95))
      }]))
    ])),
    commandAuraReductionPercent: fixed((1 - percentile(samples.optimized, 0.5) / Math.max(0.0001, percentile(samples.legacy, 0.5))) * 100),
    telemetry: {
      sourceMaintenanceMs: fixed(optimizedTelemetry.commandAuraSourceMaintenanceMs),
      membershipMs: fixed(optimizedTelemetry.commandAuraMembershipMs),
      winnerResolutionMs: fixed(optimizedTelemetry.commandAuraWinnerResolutionMs),
      recipientPublishMs: fixed(optimizedTelemetry.commandAuraRecipientPublishMs),
      reconciliationMs: fixed(optimizedTelemetry.commandAuraReconciliationMs),
      fallbackMs: fixed(optimizedTelemetry.commandAuraFallbackMs),
      membershipQueries: optimizedTelemetry.commandAuraMembershipQueries,
      membershipCacheHits: optimizedTelemetry.commandAuraMembershipCacheHits,
      candidatesVisited: optimizedTelemetry.commandAuraCandidatesVisited,
      spatialQueries: optimizedRoom.spatialIndex?.queryCount || 0,
      sourcesRebuilt: optimizedTelemetry.commandAuraSourceRebuilds,
      recipientsDirty: optimizedTelemetry.commandAuraRecipientsDirty,
      recipientsPublished: optimizedTelemetry.commandAuraRecipientsPublished,
      priorityComparisons: optimizedTelemetry.commandAuraPriorityComparisons,
      winnerRescans: optimizedTelemetry.commandAuraWinnerRescans,
      sortCount: optimizedTelemetry.commandAuraSortsPerformed,
      fullScanFallbacks: optimizedTelemetry.commandAuraFullScanFallbacks,
      reconciliations: optimizedTelemetry.commandAuraReconciliations
    },
    cacheSizes: optimizedRoom._commandAuraLastMetrics || {},
    peakHeapMb: fixed(peakHeap / (1024 * 1024)),
    heapGrowthMb: fixed((process.memoryUsage().heapUsed - startHeap) / (1024 * 1024)),
    parityChecksum,
    fallback: Boolean(config.noSpatialIndex),
    legacyCacheSizes: legacyRoom._commandAuraLastMetrics || {}
  };
}

function main() {
  const full = process.argv.includes("--full");
  const quick = process.argv.includes("--quick") || !full;
  const definitions = scenarioDefinitions(full);
  const startedAt = performance.now();
  const results = [];
  console.log(`Phase 6D Command Aura benchmark (${quick ? "quick" : "full"})`);
  console.log(`Range=${RANGE} cadence=150ms scenarios=${definitions.length}`);
  try {
    for (const definition of definitions) {
      const result = runScenario(definition);
      results.push(result);
      console.log(`${result.name.padEnd(20)} ${String(result.count).padStart(4)} ships  legacy p50/p95=${result.legacy.p50}/${result.legacy.p95}ms  optimized p50/p95=${result.optimized.p50}/${result.optimized.p95}ms  reduction=${result.commandAuraReductionPercent}%`);
    }
  } finally {
    __setOPTIMIZED_COMMAND_AURA_RUNTIME(false);
  }
  console.log(`Completed in ${fixed(performance.now() - startedAt)}ms`);
  console.log(JSON.stringify({ mode: quick ? "quick" : "full", results }, null, 2));
}

main();
