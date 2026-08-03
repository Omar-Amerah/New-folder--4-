"use strict";

// Lightweight process-local telemetry for diagnosing live match lag. Samples
// are bounded and summarized only when /health or diagnostics is requested, so
// the profiler does not become part of the hot-path problem it is measuring.
const WINDOW_MS = 60_000;
const MAX_SAMPLES = 2048;
const SUBSYSTEM_NAMES = Object.freeze([
  "botsEconomyLifecycle",
  "powerDemandProtection",
  "movementSeparationMap",
  "spatialIndex",
  "commandAuras",
  "shields",
  "visibility",
  "support",
  "drones",
  "weapons",
  "stationWeapons",
  "projectiles",
  "heat",
  "objectives"
]);

const PURCHASE_STAGE_NAMES = Object.freeze([
  "requestValidation",
  "designValidation",
  "wiringNormalization",
  "statCalculation",
  "purchaseSignatureGeneration",
  "spawnPositionResolution",
  "componentHealthInitialization",
  "powerInitialization",
  "heatInitialization",
  "droneBayInitialization",
  "decoyLauncherInitialization",
  "perShipSpawnTime",
  "totalPurchaseTime",
  "purchaseResultSendTime",
  "postPurchaseSnapshotConstruction",
  "postPurchaseSnapshotEncoding"
]);
function createSampleRing() {
  return {
    times: new Float64Array(MAX_SAMPLES),
    values: new Float64Array(MAX_SAMPLES),
    cursor: 0,
    count: 0
  };
}

const FLAK_SERIES = [
  "flak:active",
  "flak:proximityCandidates",
  "flak:detonations",
  "flak:explosionEntities",
  "flak:droneHits",
  "flak:missileHits",
  "flak:processingUs"
];
const SNAPSHOT_PHASE5_SERIES = Object.freeze([
  "snapshotEntityDeltaBytes", "snapshotFullBytes", "snapshotMotionBytes",
  "snapshotSparseStateBytes", "snapshotPrivateBytes", "snapshotRemovalBytes", "snapshotDictionaryBytes",
  "snapshotConstructionSharedMs", "snapshotConstructionViewerMs", "snapshotEncodingMs", "snapshotRecipients",
  "snapshotPayloadGroups", "snapshotEntitiesConsidered", "snapshotEntitiesPatched", "snapshotEntitiesUnchanged",
  "snapshotVisibilityRemovals", "snapshotReacquisitionBaselines", "snapshotDetailDowngrades",
  "snapshotDetailUpgrades", "snapshotFullPromotions", "snapshotResyncRequests", "snapshotMalformedPatchRejects",
  "snapshotBuiltThenReplacedBytes", "snapshotBuiltThenReplacedCount", "clientSnapshotDecodeMs", "clientSnapshotMergeMs"
]);
const seriesNames = [
  "simulationMs",
  "cycleMs",
  "eventLoopLagMs",
  "snapshotBuildMs",
  "snapshotConstructionMs",
  "snapshotEncodingMs",
  "snapshotPayloadBytes",
  "snapshotMaxClientBytes",
  "entityShips",
  "entityDrones",
  "entityBullets",
  "entityEffects",
  ...SUBSYSTEM_NAMES.map((name) => `subsystem:${name}`),
  ...PURCHASE_STAGE_NAMES.map((name) => `purchase:${name}`),
  ...FLAK_SERIES,
  ...SNAPSHOT_PHASE5_SERIES
];
const series = Object.fromEntries(seriesNames.map((name) => [name, createSampleRing()]));
const totals = {
  ticks: 0,
  tickBudgetOverruns: 0,
  snapshots: 0,
  snapshotClients: 0,
  snapshotPayloadBytes: 0,
  outboundBytes: 0,
  outboundSnapshotBytes: 0,
  outboundControlBytes: 0,
  outboundBlockedEvents: 0,
  outboundDrainEvents: 0,
  outboundCoalescedSnapshots: 0,
  outboundQueueLimitCloses: 0,
  outboundBackpressureCloses: 0
};
const outboundBuckets = new Map();
let lastPrunedOutboundSecond = 0;
const phase5Totals = Object.fromEntries(SNAPSHOT_PHASE5_SERIES.map((name) => [name, 0]));

function ensureSeries(name) {
  if (!series[name]) series[name] = createSampleRing();
  return series[name];
}

function boundedSample(name, value, at = Date.now()) {
  if (!Number.isFinite(value)) return;
  const samples = ensureSeries(name);
  samples.times[samples.cursor] = at;
  samples.values[samples.cursor] = value;
  samples.cursor = (samples.cursor + 1) % MAX_SAMPLES;
  samples.count = Math.min(MAX_SAMPLES, samples.count + 1);
}

function recordTick({ simulationMs = 0, cycleMs = 0, eventLoopLagMs = 0, budgetMs = 0, counts = {} } = {}) {
  const at = Date.now();
  boundedSample("simulationMs", simulationMs, at);
  boundedSample("cycleMs", cycleMs, at);
  boundedSample("eventLoopLagMs", Math.max(0, eventLoopLagMs), at);
  boundedSample("entityShips", Math.max(0, Number(counts.ships) || 0), at);
  boundedSample("entityDrones", Math.max(0, Number(counts.drones) || 0), at);
  boundedSample("entityBullets", Math.max(0, Number(counts.bullets) || 0), at);
  boundedSample("entityEffects", Math.max(0, Number(counts.effects) || 0), at);
  totals.ticks += 1;
  if (budgetMs > 0 && cycleMs > budgetMs) totals.tickBudgetOverruns += 1;
}

function recordRoomTick(input = {}) {
  // Accept the historical `{ durations }` wrapper as well as the duration
  // record itself. The simulation hot path uses the latter to avoid allocating
  // a one-property wrapper every room tick.
  const durations = input?.durations || input || {};
  const at = Date.now();
  for (const name of SUBSYSTEM_NAMES) boundedSample(`subsystem:${name}`, Math.max(0, Number(durations[name]) || 0), at);
}

function recordSnapshot({ durationMs = 0, constructionMs = 0, encodingMs = 0, payloadBytes = 0, maxClientBytes = 0, clients = 0, phase5 = null } = {}) {
  const at = Date.now();
  boundedSample("snapshotBuildMs", durationMs, at);
  boundedSample("snapshotConstructionMs", constructionMs, at);
  boundedSample("snapshotEncodingMs", encodingMs, at);
  boundedSample("snapshotPayloadBytes", payloadBytes, at);
  boundedSample("snapshotMaxClientBytes", maxClientBytes, at);
  totals.snapshots += 1;
  totals.snapshotClients += Math.max(0, Number(clients) || 0);
  totals.snapshotPayloadBytes += Math.max(0, Number(payloadBytes) || 0);
  if (phase5) recordSnapshotPhase5(phase5);
}

function recordSnapshotPhase5(metrics = {}) {
  const at = Date.now();
  for (const name of SNAPSHOT_PHASE5_SERIES) {
    const value = Math.max(0, Number(metrics[name]) || 0);
    if (value) phase5Totals[name] += value;
    boundedSample(name, value, at);
  }
}

function recordSnapshotWaste(bytes = 0, count = 1) {
  recordSnapshotPhase5({ snapshotBuiltThenReplacedBytes: bytes, snapshotBuiltThenReplacedCount: count });
}

function recordOutbound(bytes, kind = "control") {
  const amount = Math.max(0, Number(bytes) || 0);
  if (!amount) return;
  const isSnapshot = typeof kind === "string" && kind.startsWith("snapshot-");
  totals.outboundBytes += amount;
  if (isSnapshot) totals.outboundSnapshotBytes += amount;
  else totals.outboundControlBytes += amount;
  const second = Math.floor(Date.now() / 1000);
  const bucket = outboundBuckets.get(second) || { total: 0, snapshot: 0, control: 0 };
  bucket.total += amount;
  if (isSnapshot) bucket.snapshot += amount;
  else bucket.control += amount;
  outboundBuckets.set(second, bucket);
  if (second !== lastPrunedOutboundSecond) {
    lastPrunedOutboundSecond = second;
    for (const key of outboundBuckets.keys()) if (key < second - 120) outboundBuckets.delete(key);
  }
}

function recordOutboundEvent(event, count = 1) {
  const amount = Math.max(0, Number(count) || 0);
  if (!amount) return;
  if (event === "blocked") totals.outboundBlockedEvents += amount;
  else if (event === "drain") totals.outboundDrainEvents += amount;
  else if (event === "coalesced") totals.outboundCoalescedSnapshots += amount;
  else if (event === "queue-limit-close") totals.outboundQueueLimitCloses += amount;
  else if (event === "backpressure-close") totals.outboundBackpressureCloses += amount;
}

function recordPurchaseStage(stageName, durationMs) {
  if (!PURCHASE_STAGE_NAMES.includes(stageName)) return;
  boundedSample(`purchase:${stageName}`, durationMs, Date.now());
}

function recordFlakMetrics(metrics = {}) {
  const at = Date.now();
  boundedSample("flak:active", Math.max(0, Number(metrics.active) || 0), at);
  boundedSample("flak:proximityCandidates", Math.max(0, Number(metrics.proximityCandidates) || 0), at);
  boundedSample("flak:detonations", Math.max(0, Number(metrics.detonations) || 0), at);
  boundedSample("flak:explosionEntities", Math.max(0, Number(metrics.explosionEntities) || 0), at);
  boundedSample("flak:droneHits", Math.max(0, Number(metrics.droneHits) || 0), at);
  boundedSample("flak:missileHits", Math.max(0, Number(metrics.missileHits) || 0), at);
  boundedSample("flak:processingUs", Math.max(0, Number(metrics.processingUs) || 0), at);
}

function recordRoomTelemetry(room) {
  const at = Date.now();
  const RoomTelemetry = require("./roomTelemetry");
  const telemetry = room?._roomTelemetry || RoomTelemetry.ensureTelemetry(room);
  for (const name of RoomTelemetry.ALL_FIELDS) {
    boundedSample(`room:${name}`, Math.max(0, Number(telemetry[name]) || 0), at);
  }
}

function currentValues(name, now) {
  const samples = series[name];
  if (!samples?.count) return [];
  const values = [];
  const start = (samples.cursor - samples.count + MAX_SAMPLES) % MAX_SAMPLES;
  for (let offset = 0; offset < samples.count; offset += 1) {
    const index = (start + offset) % MAX_SAMPLES;
    if (now - samples.times[index] <= WINDOW_MS) values.push(samples.values[index]);
  }
  return values;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function summarize(name, now) {
  const values = currentValues(name, now);
  if (!values.length) return { samples: 0, average: 0, p50: 0, p95: 0, p99: 0, max: 0, latest: 0 };
  const sorted = values.slice().sort((a, b) => a - b);
  const round = (value) => Math.round(value * 1000) / 1000;
  return {
    samples: values.length,
    average: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    max: round(sorted[sorted.length - 1]),
    latest: round(values[values.length - 1])
  };
}

function outboundWindow(now) {
  const nowSecond = Math.floor(now / 1000);
  let total = 0, snapshot = 0, control = 0, oldest = nowSecond;
  for (const [second, bucket] of outboundBuckets) {
    if (second < nowSecond - 59) continue;
    oldest = Math.min(oldest, second);
    total += bucket.total;
    snapshot += bucket.snapshot;
    control += bucket.control;
  }
  const seconds = Math.max(1, Math.min(60, nowSecond - oldest + 1));
  return {
    bytes: total,
    snapshotBytes: snapshot,
    controlBytes: control,
    bytesPerSecond: Math.round(total / seconds),
    snapshotBytesPerSecond: Math.round(snapshot / seconds)
  };
}

function performanceSnapshot(tickHz = 30) {
  const now = Date.now();
  const budgetMs = 1000 / Math.max(1, Number(tickHz) || 30);
  return {
    windowSeconds: WINDOW_MS / 1000,
    tickBudgetMs: Math.round(budgetMs * 1000) / 1000,
    tick: {
      simulationMs: summarize("simulationMs", now),
      cycleMs: summarize("cycleMs", now),
      eventLoopLagMs: summarize("eventLoopLagMs", now),
      total: totals.ticks,
      budgetOverruns: totals.tickBudgetOverruns
    },
    subsystems: Object.fromEntries(SUBSYSTEM_NAMES.map((name) => [name, summarize(`subsystem:${name}`, now)])),
    entities: {
      ships: summarize("entityShips", now),
      drones: summarize("entityDrones", now),
      bullets: summarize("entityBullets", now),
      effects: summarize("entityEffects", now)
    },
    snapshot: {
      buildMs: summarize("snapshotBuildMs", now),
      constructionMs: summarize("snapshotConstructionMs", now),
      encodingMs: summarize("snapshotEncodingMs", now),
      aggregatePayloadBytes: summarize("snapshotPayloadBytes", now),
      maxClientPayloadBytes: summarize("snapshotMaxClientBytes", now),
      total: totals.snapshots,
      clientsBuilt: totals.snapshotClients,
      bytesBuilt: totals.snapshotPayloadBytes,
      phase5: {
        totals: { ...phase5Totals },
        series: Object.fromEntries(SNAPSHOT_PHASE5_SERIES.map((name) => [name, summarize(name, now)]))
      }
    },
    outbound: {
      ...outboundWindow(now),
      totalBytes: totals.outboundBytes,
      totalSnapshotBytes: totals.outboundSnapshotBytes,
      totalControlBytes: totals.outboundControlBytes,
      blockedEvents: totals.outboundBlockedEvents,
      drainEvents: totals.outboundDrainEvents,
      coalescedSnapshots: totals.outboundCoalescedSnapshots,
      queueLimitCloses: totals.outboundQueueLimitCloses,
      backpressureCloses: totals.outboundBackpressureCloses
    },
    purchase: Object.fromEntries(PURCHASE_STAGE_NAMES.map((name) => [name, summarize(`purchase:${name}`, now)])),
    room: Object.fromEntries(Object.keys(series).filter((k) => k.startsWith("room:")).map((k) => [k.slice(5), summarize(k, now)]))
  };
}

module.exports = { SUBSYSTEM_NAMES, PURCHASE_STAGE_NAMES, SNAPSHOT_PHASE5_SERIES, recordTick, recordRoomTick, recordRoomTelemetry, recordSnapshot, recordSnapshotPhase5, recordSnapshotWaste, recordOutbound, recordOutboundEvent, recordPurchaseStage, recordFlakMetrics, performanceSnapshot };
