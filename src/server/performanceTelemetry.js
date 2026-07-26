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
  "support",
  "drones",
  "weapons",
  "projectiles",
  "heat",
  "objectives"
]);
const series = {
  simulationMs: [],
  cycleMs: [],
  eventLoopLagMs: [],
  snapshotBuildMs: [],
  snapshotConstructionMs: [],
  snapshotEncodingMs: [],
  snapshotPayloadBytes: [],
  snapshotMaxClientBytes: [],
  entityShips: [],
  entityDrones: [],
  entityBullets: [],
  entityEffects: [],
  ...Object.fromEntries(SUBSYSTEM_NAMES.map((name) => [`subsystem:${name}`, []]))
};
const totals = {
  ticks: 0,
  tickBudgetOverruns: 0,
  snapshots: 0,
  snapshotClients: 0,
  snapshotPayloadBytes: 0,
  outboundBytes: 0,
  outboundSnapshotBytes: 0,
  outboundControlBytes: 0
};
const outboundBuckets = new Map();
let lastPrunedOutboundSecond = 0;

function boundedSample(name, value, at = Date.now()) {
  if (!Number.isFinite(value)) return;
  const values = series[name];
  if (!values) return;
  values.push({ at, value });
  if (values.length > MAX_SAMPLES) values.splice(0, Math.floor(MAX_SAMPLES / 4));
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

function recordRoomTick({ durations = {} } = {}) {
  const at = Date.now();
  for (const name of SUBSYSTEM_NAMES) boundedSample(`subsystem:${name}`, Math.max(0, Number(durations[name]) || 0), at);
}

function recordSnapshot({ durationMs = 0, constructionMs = 0, encodingMs = 0, payloadBytes = 0, maxClientBytes = 0, clients = 0 } = {}) {
  const at = Date.now();
  boundedSample("snapshotBuildMs", durationMs, at);
  boundedSample("snapshotConstructionMs", constructionMs, at);
  boundedSample("snapshotEncodingMs", encodingMs, at);
  boundedSample("snapshotPayloadBytes", payloadBytes, at);
  boundedSample("snapshotMaxClientBytes", maxClientBytes, at);
  totals.snapshots += 1;
  totals.snapshotClients += Math.max(0, Number(clients) || 0);
  totals.snapshotPayloadBytes += Math.max(0, Number(payloadBytes) || 0);
}

function recordOutbound(bytes, kind = "control") {
  const amount = Math.max(0, Number(bytes) || 0);
  if (!amount) return;
  totals.outboundBytes += amount;
  if (String(kind).startsWith("snapshot-")) totals.outboundSnapshotBytes += amount;
  else totals.outboundControlBytes += amount;
  const second = Math.floor(Date.now() / 1000);
  const bucket = outboundBuckets.get(second) || { total: 0, snapshot: 0, control: 0 };
  bucket.total += amount;
  if (String(kind).startsWith("snapshot-")) bucket.snapshot += amount;
  else bucket.control += amount;
  outboundBuckets.set(second, bucket);
  if (second !== lastPrunedOutboundSecond) {
    lastPrunedOutboundSecond = second;
    for (const key of outboundBuckets.keys()) if (key < second - 120) outboundBuckets.delete(key);
  }
}

function currentValues(name, now) {
  return (series[name] || []).filter((sample) => now - sample.at <= WINDOW_MS).map((sample) => sample.value);
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
      bytesBuilt: totals.snapshotPayloadBytes
    },
    outbound: {
      ...outboundWindow(now),
      totalBytes: totals.outboundBytes,
      totalSnapshotBytes: totals.outboundSnapshotBytes,
      totalControlBytes: totals.outboundControlBytes
    }
  };
}

module.exports = { SUBSYSTEM_NAMES, recordTick, recordRoomTick, recordSnapshot, recordOutbound, performanceSnapshot };
