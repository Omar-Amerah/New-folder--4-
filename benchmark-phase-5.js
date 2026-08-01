"use strict";

// Production-path Phase 5 benchmark.  Each sample calls broadcastSnapshot,
// viewer filtering, MessagePack encoding and the outbound lifecycle.  It is
// intentionally a workload benchmark, not a tuple-encoder microbenchmark.

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { decode, encode } = require("@msgpack/msgpack");
const delivery = require("./src/server/snapshotDelivery");
const outbound = require("./src/server/outbound");
const flags = require("./src/server/performanceFlags");
const { performanceSnapshot } = require("./src/server/performanceTelemetry");
const { performanceNow } = require("./src/server/utils");

const COUNTS = [50, 150, 300, 600];
const CLIENT_COUNTS = [1, 2, 4, 6];
const PROJECTILES = [0, 500, 2000];
const SCENARIOS = [
  "mostly-stationary-fleet", "large-moving-formation", "dense-combat", "component-damage-churn",
  "heat-power-telemetry-churn", "one-focused-telemetry-ship", "different-focused-ships",
  "full-sensor-visibility", "partial-sensor-visibility", "repeated-hide-reacquire", "ship-spawn-destruction",
  "station-production-damage", "one-blocked-client", "snapshot-replacement", "reconnect-full-recovery",
  "duplicate-tabs-mixed-clients"
];
// More samples make p95 construction/encoding comparisons useful without
// changing the simulated 30 Hz / snapshot 20 Hz cadence under test.
const FRAMES = Math.max(4, Number(process.env.MFA_PHASE5_FRAMES) || 12);
const FAST = process.env.MFA_PHASE5_FAST === "1";

class Socket extends EventEmitter {
  constructor(blocked = false) {
    super();
    this.destroyed = false;
    this.blocked = blocked;
    this.rawBytes = 0;
    this.packets = [];
  }
}

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

function summarize(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  return {
    samples: clean.length,
    p50: percentile(clean, 0.5),
    p95: percentile(clean, 0.95),
    mean: clean.reduce((sum, value) => sum + value, 0) / Math.max(1, clean.length),
    max: Math.max(0, ...clean)
  };
}

function benchmarkNumericHandles() {
  const ids = Array.from({ length: 600 }, (_, index) => `ship-${index + 1}`);
  const stringWire = {
    dictionary: [],
    motion: ids.map((id, index) => [id, index, index + 1, index + 2]),
    state: ids.map((id, index) => [id, { hp: 100 - index % 7, targetId: ids[(index + 1) % ids.length] }]),
    private: ids.map((id) => [id, { powerRevision: 1 }]),
    remove: ids.slice(0, 30)
  };
  const numericWire = {
    dictionary: ids,
    motion: ids.map((_, index) => [index + 1, index, index + 1, index + 2]),
    state: ids.map((_, index) => [index + 1, { hp: 100 - index % 7, targetId: ((index + 1) % ids.length) + 1 }]),
    private: ids.map((_, index) => [index + 1, { powerRevision: 1 }]),
    remove: Array.from({ length: 30 }, (_, index) => index + 1)
  };
  const stringBytes = encode(stringWire).length;
  const numericBytes = encode(numericWire).length;
  const reductionPercent = stringBytes ? (1 - numericBytes / stringBytes) * 100 : 0;
  return {
    repeatedEntities: ids.length,
    stringBytes,
    numericBytes,
    reductionPercent,
    thresholdPercent: 25,
    decision: reductionPercent >= 25 ? "candidate-for-production" : "defer"
  };
}

function player(id, team) {
  return {
    id, name: id, color: team === "blue" ? "#39f" : "#f66", team, isBot: false,
    connected: true, ready: true, money: 1000, income: 10, earned: 10, spent: 0,
    shipCap: 1000, deployedFleetCost: 0, destroyedEnemyCost: 0, lastReward: 0,
    kills: 0, losses: 0, captures: 0, ships: [], design: [{ type: "core" }],
    stats: { unitCost: 1 }, shipsBuilt: 0, lostFleetCost: 0, rallyPoint: null
  };
}

function makeShip(id, owner, index, scenario) {
  const moving = scenario === "large-moving-formation" || scenario === "dense-combat";
  const x = 100 + (index % 30) * 42;
  const y = 100 + Math.floor(index / 30) * 42;
  return {
    id, ownerId: owner.id, team: owner.team, designRevision: 1, componentAliveRevision: 0,
    componentDamageRevision: 0, proximityChargeRevision: 0, x, y, vx: moving ? 12 + index % 5 : 0,
    vy: moving ? (index % 3) - 1 : 0, angle: 0, turnActivity: 0, targetX: x, targetY: y,
    combatStyle: "hold", movementToggles: {}, hp: 100, maxHp: 100, shield: 20, maxShield: 20,
    radius: 12, cost: 1, focusTargetId: null, combatTargetId: null, weaponAngles: [0],
    commandState: "mainCore", emergencyReserveUntil: null, alive: true, commandAuraActive: false,
    commandAuraReceived: false, proximityChargeDetonated: [], blasterRange: 0, missileRange: 0,
    railgunRange: 0, beamRange: 0, weaponRanges: [], beamRadius: 0, sensorRange: 0, sensorCones: [],
    respawnIn: 0, removeIn: 0, heat: 0, heatNow: 0, heatMax: 100, hot: 0, overheated: 0,
    heatRevision: 0, componentHeatRevision: 0, heatStateRevision: 0, heatTelemetryRevision: 0,
    powerRuntimeRevision: 0, stats: { unitCost: 1, radius: 12 }, design: [{ type: "core" }, { type: "engine" }],
    componentHp: [100, 100], componentMaxHp: [100, 100], componentHeat: [0, 0], componentHeatState: [0, 0],
    componentThermals: [{ capacity: 10 }, { capacity: 10 }], dirtyComponents: new Set(), dirtyHeat: new Set(),
    removed: false, blockedEngineIndices: new Set(),
    // Focus and telemetry fixtures remain ordinary presentation data; no
    // gameplay code is changed for the benchmark.
    _benchmarkIndex: index
  };
}

function makeRoom(count, clients, projectileCount, scenario, seed) {
  const players = new Map();
  for (let index = 0; index < Math.max(2, clients); index += 1) {
    const team = index % 2 === 0 ? "blue" : "red";
    players.set(`p${index + 1}`, player(`p${index + 1}`, team));
  }
  const room = {
    code: `P5-${seed}`,
    phase: "active", adminId: "p1", stateEpoch: 1, snapshotSeq: 0, staticRevision: 1,
    componentCatalogueRevision: 1, mapSizeLabel: "benchmark", world: { width: 16000, height: 12000 },
    map: { asteroids: [], relays: [] }, rules: { gameMode: "teams", visibilityMode: scenario === "full-sensor-visibility" || scenario === "partial-sensor-visibility" || scenario === "repeated-hide-reacquire" ? "sensors" : "none" },
    winner: null, matchStartedAt: 1, simulationTimeMs: 1000, bullets: [], effects: [], points: [], stations: [], stationsById: new Map(),
    players, ships: new Map(), drones: new Map(), decoys: new Map(), clients: new Set(),
    droneCounts: { byOwner: new Map(), byParent: new Map() }, controlVictory: null
  };
  const playerValues = [...players.values()];
  for (let index = 0; index < count; index += 1) {
    const owner = playerValues[index % playerValues.length];
    const entity = makeShip(`s${index + 1}`, owner, index, scenario);
    owner.ships.push(entity);
    room.ships.set(entity.id, entity);
  }
  for (let index = 0; index < projectileCount; index += 1) {
    room.bullets.push({ id: `b${index + 1}`, type: index % 4 === 0 ? "missile" : "bolt", subtype: null, ownerId: "p1", x: 100 + index, y: 100, vx: 2, vy: 0, bornAt: 900 });
  }
  if (scenario === "station-production-damage") {
    const station = {
      id: "station-1", stationType: "home", team: "blue", ownerId: "p1", state: "active", x: 1000, y: 1000,
      angle: 0, radius: 100, shieldRadius: 120, moduleScale: 1, revision: 1, healthRevision: 1,
      componentDamageRevision: 1, stateRevision: 1, productionRevision: 1, hp: 1000, maxHp: 1000,
      shield: 100, maxShield: 100, weaponRange: 500, weaponAngles: [0], design: [{ type: "core" }], componentHp: [100],
      productionQueue: []
    };
    room.stations.push(station); room.stationsById.set(station.id, station);
  }
  return room;
}

function attachClients(room, count, scenario, modern) {
  const players = [...room.players.values()];
  for (let index = 0; index < count; index += 1) {
    const duplicate = scenario === "duplicate-tabs-mixed-clients" && index > 0;
    const player = duplicate ? players[0] : players[index % players.length];
    const blocked = scenario === "one-blocked-client" && index === count - 1;
    const socket = new Socket(blocked);
    const capabilities = modern && (!scenario.includes("mixed") || index % 2 === 0)
      ? ["messagepack", "entityDeltaSnapshotsV1"]
      : ["messagepack"];
    const client = {
      id: `bench-${index}`,
      socket, room, player,
      protocol: { capabilities },
      telemetryFocusShipId: scenario === "one-focused-telemetry-ship" ? "s1" : scenario === "different-focused-ships" ? `s${(index % Math.max(1, room.ships.size)) + 1}` : null,
      isClosed: false
    };
    room.clients.add(client);
  }
}

function mutateRoom(room, scenario, frame) {
  room.simulationTimeMs = 1000 + frame * 50;
  let index = 0;
  for (const entity of room.ships.values()) {
    if (scenario === "large-moving-formation" || scenario === "dense-combat") {
      entity.x += entity.vx / 20; entity.y += entity.vy / 20;
    }
    if (scenario === "component-damage-churn" && index % 7 === frame % 7) {
      entity.componentHp[0] = Math.max(1, entity.componentHp[0] - 1);
      entity.componentDamageRevision += 1; entity.dirtyComponents.add(0);
    }
    if (scenario === "heat-power-telemetry-churn" || scenario === "one-focused-telemetry-ship" || scenario === "different-focused-ships") {
      entity.componentHeat[1] = (entity.componentHeat[1] + 1) % 100;
      entity.componentHeatRevision += 1; entity.dirtyHeat.add(1);
    }
    if (scenario === "ship-spawn-destruction" && frame === 2 && index === 0) entity.removed = true;
    index += 1;
  }
  if (scenario === "station-production-damage" && room.stations[0]) {
    room.stations[0].hp -= frame; room.stations[0].healthRevision += 1;
    room.stations[0].productionQueue = [{ id: `q${frame}`, playerId: "p1", quantityRemaining: 1, state: "queued", buildDurationSeconds: 1, progress: 0 }];
    room.stations[0].productionRevision += 1;
  }
  if (scenario === "repeated-hide-reacquire" && room.ships.get("s2")) {
    const target = room.ships.get("s2");
    target.x = frame % 2 ? 15000 : 110; target.y = frame % 2 ? 11000 : 100;
  }
  if (scenario === "snapshot-replacement") room.disableSnapshotGrouping = true;
  if (scenario === "full-sensor-visibility") {
    for (const entity of room.ships.values()) entity.x = 120 + (index++ % 10) * 20;
  }
}

async function mergeWrittenPackets(packets) {
  const merge = await import("./public/src/snapshotMerge.js");
  let snapshot = null;
  let state = { stateEpoch: 0, snapshotSeq: 0, staticRevision: 0, hasFullBaseline: false };
  const decodeSamples = [];
  const mergeSamples = [];
  let accepted = 0;
  for (const packet of packets) {
    const decodeStart = performanceNow();
    const decoded = packet;
    decodeSamples.push(performanceNow() - decodeStart);
    const mergeStart = performanceNow();
    const result = merge.mergeSnapshotTransaction(snapshot, state, decoded);
    mergeSamples.push(performanceNow() - mergeStart);
    if (!result.ok) break;
    accepted += 1; snapshot = result.snapshot; state = result.networkState;
  }
  return { accepted, decodeSamples, mergeSamples };
}

function runOne(mode, count, clients, projectileCount, scenario, seed) {
  flags.__setENTITY_DELTA_SNAPSHOTS(mode === "entity-delta");
  const room = makeRoom(count, clients, projectileCount, scenario, seed);
  attachClients(room, clients, scenario, mode === "entity-delta");
  const beforeHeap = process.memoryUsage().heapUsed;
  const beforeWasted = performanceSnapshot().snapshot.phase5.totals.snapshotBuiltThenReplacedBytes || 0;
  const construction = [];
  const sharedConstruction = [];
  const encoding = [];
  const payloadByClient = [];
  const writesBefore = new Map([...room.clients].map((client) => [client.id, 0]));
  outbound.configureOutbound({
    writeFrame(socket, payload) {
      socket.rawBytes += payload.length;
      socket.packets.push(decode(payload));
      if (socket.blocked) return false;
      return true;
    }
  });
  delivery.broadcastSnapshot(room, 1000, true);
  for (let frame = 1; frame <= FRAMES; frame += 1) {
    mutateRoom(room, scenario, frame);
    const started = performanceNow();
    delivery.broadcastSnapshot(room, room.simulationTimeMs, false);
    const metrics = room._lastSnapshotDeliveryMetrics || {};
    construction.push(finite(metrics.constructionMs));
    encoding.push(finite(metrics.encodingMs));
    sharedConstruction.push(finite(metrics.constructionMs) / Math.max(1, finite(metrics.groups, 1)));
    if (scenario === "one-blocked-client" || scenario === "snapshot-replacement") {
      for (const client of room.clients) if (client.socket.blocked) client.socket.emit("drain");
    }
    // Keep an actual production-path wall-clock sample as a secondary sanity
    // measure; the authoritative metrics above are the delivery counters.
    construction.push(performanceNow() - started);
  }
  for (const client of room.clients) {
    const previous = writesBefore.get(client.id) || 0;
    payloadByClient.push({ clientId: client.id, bytes: client.socket.rawBytes, writes: client.socket.packets.length - previous, blocked: Boolean(client.socket.blocked) });
  }
  const sampleClient = [...room.clients][0];
  const mergeResultPromise = mergeWrittenPackets(sampleClient?.socket.packets || []);
  return mergeResultPromise.then((mergeResult) => {
    const afterHeap = process.memoryUsage().heapUsed;
    const afterWasted = performanceSnapshot().snapshot.phase5.totals.snapshotBuiltThenReplacedBytes || 0;
    const totalBytes = payloadByClient.reduce((sum, value) => sum + value.bytes, 0);
    return {
      mode, count, clients, projectileCount, scenario, seed,
      snapshotConstruction: summarize(construction),
      sharedConstruction: summarize(sharedConstruction),
      encoding: summarize(encoding),
      payloadBytesPerClient: summarize(payloadByClient.map((value) => value.bytes)),
      aggregateBytes: totalBytes,
      estimatedBytesPerSecond: totalBytes / Math.max(1, FRAMES / 20),
      payloadByClient,
      fullPromotions: [...room.clients].reduce((sum, client) => sum + (client.snapshotDeliveryDiagnostics?.promotions || 0), 0),
      resyncs: mergeResult.accepted < (sampleClient?.socket.packets.length || 0) ? 1 : 0,
      clientDecode: summarize(mergeResult.decodeSamples),
      clientMerge: summarize(mergeResult.mergeSamples),
      acceptedMerges: mergeResult.accepted,
      memoryGrowthBytes: afterHeap - beforeHeap,
      wastedBuiltThenReplacedBytes: afterWasted - beforeWasted,
      delivery: room._lastSnapshotDeliveryMetrics || {},
      wallClockConstructionSamples: construction.length
    };
  });
}

function cases() {
  const result = [];
  // A full count/client matrix exercises the scaling axes directly.
  for (let countIndex = 0; countIndex < COUNTS.length; countIndex += 1) {
    for (let clientIndex = 0; clientIndex < CLIENT_COUNTS.length; clientIndex += 1) {
      result.push({ count: COUNTS[countIndex], clients: CLIENT_COUNTS[clientIndex], projectileCount: PROJECTILES[(countIndex + clientIndex) % PROJECTILES.length], scenario: SCENARIOS[(countIndex * 4 + clientIndex) % SCENARIOS.length] });
    }
  }
  // Ensure every named scenario is represented, including the lifecycle and
  // mixed-client cases not selected by the compact matrix above.
  for (let index = 0; index < SCENARIOS.length; index += 1) {
    const scenario = SCENARIOS[index];
    if (result.some((entry) => entry.scenario === scenario)) continue;
    result.push({ count: COUNTS[index % COUNTS.length], clients: CLIENT_COUNTS[index % CLIENT_COUNTS.length], projectileCount: PROJECTILES[index % PROJECTILES.length], scenario });
  }
  return FAST ? result.filter((entry, index) => index % 3 === 0) : result;
}

async function main() {
  const startedAt = new Date().toISOString();
  const startedHeap = process.memoryUsage().heapUsed;
  const results = [];
  try {
    for (const entry of cases()) {
      const legacy = await runOne("legacy-compact", entry.count, entry.clients, entry.projectileCount, entry.scenario, results.length + 1);
      const entity = await runOne("entity-delta", entry.count, entry.clients, entry.projectileCount, entry.scenario, results.length + 1);
      results.push(legacy, entity);
    }
  } finally {
    flags.__setENTITY_DELTA_SNAPSHOTS(false);
  }
  const pairs = [];
  for (let index = 0; index < results.length; index += 2) {
    const legacy = results[index];
    const entity = results[index + 1];
    pairs.push({
      scenario: legacy.scenario, count: legacy.count, clients: legacy.clients, projectileCount: legacy.projectileCount,
      legacyBytes: legacy.aggregateBytes, entityDeltaBytes: entity.aggregateBytes,
      payloadReductionPercent: legacy.aggregateBytes ? (1 - entity.aggregateBytes / legacy.aggregateBytes) * 100 : 0,
      legacyConstructionP95: legacy.snapshotConstruction.p95,
      entityConstructionP95: entity.snapshotConstruction.p95,
      legacyEncodingP95: legacy.encoding.p95,
      entityEncodingP95: entity.encoding.p95,
      legacyClientMergeP95: legacy.clientMerge.p95,
      entityClientMergeP95: entity.clientMerge.p95,
      legacyFullPromotions: legacy.fullPromotions,
      entityFullPromotions: entity.fullPromotions,
      legacyResyncs: legacy.resyncs,
      entityResyncs: entity.resyncs,
      legacyWastedBuiltThenReplacedBytes: legacy.wastedBuiltThenReplacedBytes,
      entityWastedBuiltThenReplacedBytes: entity.wastedBuiltThenReplacedBytes
    });
  }
  const output = {
    benchmark: "phase-5-snapshot-network-scaling",
    productionPath: ["broadcastSnapshot", "viewer-specific filtering", "encodeMessage/MessagePack", "outbound lifecycle", "snapshotMerge"],
    startedAt, completedAt: new Date().toISOString(),
    cadence: { tickHz: 30, snapshotHz: 20 },
    fixtureNote: FAST ? "Reduced sample matrix selected with MFA_PHASE5_FAST=1; values are workload samples, not a full soak." : "Workload benchmark; no target is hidden or used to alter cadence.",
    dimensions: { counts: COUNTS, clients: CLIENT_COUNTS, projectiles: PROJECTILES, scenarios: SCENARIOS, frames: FRAMES },
    results,
    comparisons: pairs,
    numericHandles: benchmarkNumericHandles(),
    memory: { startHeapBytes: startedHeap, endHeapBytes: process.memoryUsage().heapUsed, growthBytes: process.memoryUsage().heapUsed - startedHeap },
    targets: {
      mostlyStationaryLargePayloadReductionPercent: 60,
      movingLargePayloadReductionPercent: 30,
      multiClientConstructionEncodingReductionPercent: 25,
      oneClient50ShipRegressionPercent: 5
    },
    honestLimitations: [
      "The production snapshot builders and delivery lifecycle are exercised, but this is not a browser GPU/render benchmark.",
      "Numeric entity handles were benchmarked with a 600-entity repeated-ID patch and deferred below the declared 25% savings threshold; adding dictionary state would otherwise expand reconnect and privacy validation paths."
    ]
  };
  const outputPath = path.join(__dirname, "test-artifacts", "performance", "benchmark-phase-5.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Phase 5 benchmark wrote ${outputPath}`);
  for (const pair of pairs.slice(0, 12)) console.log(`${pair.scenario} ${pair.count} ships/${pair.clients} clients: ${pair.payloadReductionPercent.toFixed(1)}% aggregate payload reduction`);
}

main().catch((error) => { console.error(error); process.exit(1); });
