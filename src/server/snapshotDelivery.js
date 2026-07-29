const { encodeMessage } = require("./wsCodec");
const { performanceNow, compareIdStrings } = require("./utils");
const { sendRaw, getOutbound } = require("./outbound");
const {
  snapshotRoom,
  buildSharedSnapshot,
  collectSnapshotDesignRevisions,
  collectSnapshotVisibleShipIds,
  collectSnapshotPowerRevisions,
  collectSnapshotPowerProtectionRevisions,
  collectSnapshotWiringLayoutRevisions,
  collectSnapshotHeatTelemetryRevisions,
  collectSnapshotStationStaticRevisions,
  collectSnapshotStationComponentRevisions,
  collectSnapshotConditionStationIds,
  markSnapshotDesignsWritten,
  markSnapshotVisibilityWritten,
  markSnapshotPowerWritten,
  markSnapshotPowerProtectionWritten,
  markSnapshotWiringLayoutWritten,
  markSnapshotHeatTelemetryWritten,
  markSnapshotStationStaticWritten,
  markSnapshotStationComponentWritten,
  markSnapshotConditionStationsWritten
} = require("./snapshots");
const { recordSnapshot } = require("./performanceTelemetry");

const TELEMETRY_INTERVAL_MS = 500;

function diag(client) { return client.snapshotDeliveryDiagnostics ||= { fullBuilt: 0, compactBuilt: 0, queued: 0, written: 0, replaced: 0, dropped: 0, reset: 0, promotions: 0, recoveryRequests: 0, completedRecoveries: 0 }; }
function ensureSnapshotBaseline(client, room) {
  if (!client.snapshotBaseline) client.snapshotBaseline = {};
  const b = client.snapshotBaseline; const epoch = room.stateEpoch || 1;
  if (b.stateEpoch !== epoch) Object.assign(b, { stateEpoch: epoch, lastWrittenSeq: 0, lastWrittenFullSeq: 0, lastQueuedSeq: 0, queuedSnapshotKind: null, queuedBaseSeq: null, queuedStaticRevision: 0, fullRequired: true, staticRevisionKnown: 0 });
  if (b.fullRequired === undefined) b.fullRequired = true;
  b.lastSentSeq = b.lastWrittenSeq || 0; // compatibility alias: written, not merely generated/queued.
  return b;
}
function onSnapshotLifecycle(client, outcome, meta) {
  const b = ensureSnapshotBaseline(client, client.room || { stateEpoch: meta?.stateEpoch || 1 }); const d = diag(client); d[outcome] = (d[outcome] || 0) + 1;
  if (outcome === 'queued') { b.lastQueuedSeq = meta.snapshotSeq; b.queuedSnapshotKind = meta.snapshotKind; b.queuedBaseSeq = meta.baseSnapshotSeq ?? null; b.queuedStaticRevision = meta.staticRevision || 0; }
  if (outcome === 'replaced' || outcome === 'dropped' || outcome === 'reset') { if (b.lastQueuedSeq === meta.snapshotSeq) { b.lastQueuedSeq = 0; b.queuedSnapshotKind = null; b.queuedBaseSeq = null; b.queuedStaticRevision = 0; } }
  if (outcome === 'written') {
    b.lastWrittenSeq = meta.snapshotSeq;
    b.lastSentSeq = b.lastWrittenSeq;
    b.lastQueuedSeq = 0;
    b.queuedSnapshotKind = null;
    b.queuedBaseSeq = null;
    b.queuedStaticRevision = 0;
    markSnapshotDesignsWritten(client, meta.shipDesignRevisions);
    markSnapshotVisibilityWritten(client, meta.visibleShipIds);
    markSnapshotPowerWritten(client, meta.shipPowerRevisions);
    markSnapshotPowerProtectionWritten(client, meta.shipPowerProtectionRevisions);
    markSnapshotWiringLayoutWritten(client, meta.shipWiringLayoutRevisions);
    markSnapshotHeatTelemetryWritten(client, meta.shipHeatTelemetryRevisions);
    markSnapshotStationStaticWritten(client, meta.stationStaticRevisions);
    markSnapshotStationComponentWritten(client, meta.stationComponentRevisions);
    markSnapshotConditionStationsWritten(client, meta.conditionStationIds);
    if (meta.telemetryFocusShipId) {
      client.telemetryLastWrittenFocusId = meta.telemetryFocusShipId;
      client.telemetryLastWrittenAt = meta.telemetryAt || performanceNow();
    }
    if (meta.snapshotKind === 'full') {
      b.lastWrittenFullSeq = meta.snapshotSeq;
      b.fullRequired = false;
      b.staticRevisionKnown = meta.staticRevision || 1;
      d.completedRecoveries += 1;
    }
  }
}
// The shared snapshot carries only viewer-independent dynamic fields
// (suppressed deltas, no baselines); buildClientShips layers per-client
// baselines or deltas onto copies, so one shared build serves both full and
// compact recipients.
function telemetryFocusForPayload(client, now, full) {
  const focus = client?.telemetryFocusShipId;
  // `undefined` is the compatibility mode for older clients and direct test
  // harnesses: preserve the historical all-detail snapshot contract.
  if (focus === undefined) return undefined;
  if (typeof focus !== "string" || !focus) return null;
  const focusedShip = client?.room?.ships?.get?.(focus);
  const knownHeatRevision = client?.knownShipHeatTelemetryRevisions?.get?.(focus);
  if (focusedShip && knownHeatRevision !== (focusedShip.heatTelemetryRevision || 0)) return focus;
  const elapsed = now - (Number(client.telemetryLastWrittenAt) || 0);
  if (full || client.telemetryLastWrittenFocusId !== focus || elapsed >= TELEMETRY_INTERVAL_MS) return focus;
  return null;
}
function buildPayload(room, client, now, full, seq, baseSeq, shared = null) {
  const constructionStartedAt = performanceNow();
  room._buildingSnapshotSeq = seq; room._buildingBaseSnapshotSeq = baseSeq;
  if (!shared) shared = buildSharedSnapshot(room, now, false, true);
  const telemetryFocusShipId = telemetryFocusForPayload(client, now, full);
  const snap = snapshotRoom(room, now, client.player, full, shared, client, { telemetryFocusShipId });
  delete room._buildingSnapshotSeq; delete room._buildingBaseSnapshotSeq;
  const constructionMs = performanceNow() - constructionStartedAt;
  const encodingStartedAt = performanceNow();
  const payload = encodeMessage(snap);
  const encodingMs = performanceNow() - encodingStartedAt;
  return {
    payload,
    constructionMs,
    encodingMs,
    telemetryFocusShipId,
    designRevisions: collectSnapshotDesignRevisions(snap),
    visibleShipIds: collectSnapshotVisibleShipIds(snap),
    powerRevisions: collectSnapshotPowerRevisions(snap),
    powerProtectionRevisions: collectSnapshotPowerProtectionRevisions(snap),
    wiringLayoutRevisions: collectSnapshotWiringLayoutRevisions(snap),
    heatTelemetryRevisions: collectSnapshotHeatTelemetryRevisions(snap),
    stationStaticRevisions: collectSnapshotStationStaticRevisions(snap),
    stationComponentRevisions: collectSnapshotStationComponentRevisions(snap),
    conditionStationIds: collectSnapshotConditionStationIds(snap)
  };
}
function enqueueSnapshot(client, payload, meta) { sendRaw(client, payload, { kind: meta.snapshotKind === 'full' ? 'snapshot-full' : 'snapshot-compact', snapshotMeta: meta, onSnapshotLifecycle: (outcome, itemMeta) => onSnapshotLifecycle(client, outcome, itemMeta) }); }
function nextSeq(room) { return (room.snapshotSeq = Math.max(0, room.snapshotSeq || 0) + 1); }
function sendFullSnapshot(client, now = performanceNow(), reason = 'client-request') {
  if (!client.room) return;
  const startedAt = performanceNow();
  const room = client.room;
  ensureSnapshotBaseline(client, room);
  const seq = nextSeq(room);
  const meta = { stateEpoch: room.stateEpoch || 1, snapshotSeq: seq, baseSnapshotSeq: null, snapshotKind: 'full', staticRevision: room.staticRevision || 1, completeStatic: true, reason };
  const built = buildPayload(room, client, now, true, seq, null);
  meta.telemetryFocusShipId = built.telemetryFocusShipId; meta.telemetryAt = now;
  meta.shipDesignRevisions = built.designRevisions; meta.visibleShipIds = built.visibleShipIds; meta.shipPowerRevisions = built.powerRevisions; meta.shipPowerProtectionRevisions = built.powerProtectionRevisions; meta.shipWiringLayoutRevisions = built.wiringLayoutRevisions; meta.shipHeatTelemetryRevisions = built.heatTelemetryRevisions;
  meta.stationStaticRevisions = built.stationStaticRevisions; meta.stationComponentRevisions = built.stationComponentRevisions; meta.conditionStationIds = built.conditionStationIds;
  diag(client).fullBuilt += 1;
  if (reason) diag(client).recoveryRequests += 1;
  enqueueSnapshot(client, built.payload, meta);
  recordSnapshot({ durationMs: performanceNow() - startedAt, constructionMs: built.constructionMs, encodingMs: built.encodingMs, payloadBytes: built.payload.length, maxClientBytes: built.payload.length, clients: 1 });
}
function canSendCompact(room, b, broadcastSeq, forceStatic) {
  const revision = room.staticRevision || 1;
  return !forceStatic
    && !b.fullRequired
    && b.stateEpoch === (room.stateEpoch || 1)
    && b.lastWrittenFullSeq > 0
    && b.lastWrittenSeq === broadcastSeq - 1
    && !b.queuedSnapshotKind
    && b.staticRevisionKnown === revision;
}
function stableRevisionMap(map) {
  if (!(map instanceof Map) || map.size === 0) return "";
  return [...map.entries()]
    .sort((a, b) => compareIdStrings(a[0], b[0]))
    .map(([id, revision]) => `${String(id)}:${Number(revision) || 0}`)
    .join(",");
}
function stableIdSet(set) {
  if (!(set instanceof Set) || set.size === 0) return "";
  return [...set].map(String).sort().join(",");
}
function snapshotGroupingKey(room, client, { full, base, seq, revision, epoch, telemetryFocusShipId }) {
  const player = client?.player;
  if (!player?.id) return null;
  // Deliberately strict. Player identity is included because own-ship/private
  // visibility and player-specific economy fields can differ even on one team.
  return JSON.stringify([
    player.id,
    player.team ?? null,
    room.rules?.gameMode || "teams",
    full ? "full" : "compact",
    base,
    seq,
    revision,
    epoch,
    telemetryFocusShipId,
    stableRevisionMap(client.knownShipDesignRevisions),
    stableRevisionMap(client.knownShipPowerRevisions),
    stableRevisionMap(client.knownShipPowerProtectionRevisions),
    stableRevisionMap(client.knownShipWiringLayoutRevisions),
    stableRevisionMap(client.knownShipHeatTelemetryRevisions),
    stableIdSet(client.knownVisibleShipIds),
    stableRevisionMap(client.knownStationStaticRevisions),
    stableRevisionMap(client.knownStationComponentRevisions),
    stableIdSet(client.knownConditionStationIds)
  ]);
}
function duplicateSnapshotPlayerIds(clients) {
  const seen = new Set();
  const duplicates = new Set();
  for (const client of clients || []) {
    const playerId = client?.player?.id;
    if (!playerId) continue;
    if (seen.has(playerId)) duplicates.add(playerId);
    else seen.add(playerId);
  }
  return duplicates;
}
function broadcastSnapshot(room, now, forceStatic = false) {
  if (room.clients.size === 0) return;
  // Any delivered snapshot satisfies a pending purchase snapshot and cancels
  // the fallback coalesce timer so the regular scheduler and the fallback
  // cannot both emit.
  if (room._snapshotCoalesceTimer) {
    clearTimeout(room._snapshotCoalesceTimer);
    room._snapshotCoalesceTimer = null;
  }
  room._pendingSnapshot = false;
  room._pendingSnapshotAt = 0;
  const startedAt = performanceNow();
  const seq = nextSeq(room);
  const revision = room.staticRevision || 1;
  const epoch = room.stateEpoch || 1;
  // Built once per broadcast and reused for every client — previously this
  // was rebuilt inside buildPayload per client, making broadcast cost scale
  // as O(clients x ships) on the viewer-independent work too.
  const sharedStartedAt = performanceNow();
  const shared = buildSharedSnapshot(room, now, false, true);
  let constructionMs = performanceNow() - sharedStartedAt;
  let encodingMs = 0;
  let payloadBytes = 0;
  let maxClientBytes = 0;
  const groups = new Map();
  const duplicatePlayerIds = room.disableSnapshotGrouping
    ? null
    : duplicateSnapshotPlayerIds(room.clients);
  for (const client of room.clients) {
    const b = ensureSnapshotBaseline(client, room);
    const existing = getOutbound(client).snapshot;
    const full = !canSendCompact(room, b, seq, forceStatic);
    if (existing?.meta?.snapshotKind && full) diag(client).promotions += 1;
    const base = full ? null : b.lastWrittenSeq;
    const meta = { stateEpoch: epoch, snapshotSeq: seq, baseSnapshotSeq: base, snapshotKind: full ? 'full' : 'compact', staticRevision: revision, completeStatic: full };
    const telemetryFocusShipId = telemetryFocusForPayload(client, now, full);
    const key = duplicatePlayerIds?.has(client?.player?.id)
      ? snapshotGroupingKey(room, client, { full, base, seq, revision, epoch, telemetryFocusShipId })
      : null;
    // A null key is intentionally unique: when identity/visibility cannot be
    // proven, fall back to per-client construction.
    const groupKey = key === null ? Symbol("per-client-snapshot") : key;
    let group = groups.get(groupKey);
    if (!group) {
      group = { client, full, base, meta, recipients: [] };
      groups.set(groupKey, group);
    }
    group.recipients.push({ client, meta });
  }
  for (const group of groups.values()) {
    const built = buildPayload(room, group.client, now, group.full, seq, group.base, shared);
    constructionMs += built.constructionMs;
    encodingMs += built.encodingMs;
    for (const recipient of group.recipients) {
      const { client, meta } = recipient;
      meta.telemetryFocusShipId = built.telemetryFocusShipId; meta.telemetryAt = now;
      meta.shipDesignRevisions = built.designRevisions; meta.visibleShipIds = built.visibleShipIds; meta.shipPowerRevisions = built.powerRevisions; meta.shipPowerProtectionRevisions = built.powerProtectionRevisions; meta.shipWiringLayoutRevisions = built.wiringLayoutRevisions; meta.shipHeatTelemetryRevisions = built.heatTelemetryRevisions;
      meta.stationStaticRevisions = built.stationStaticRevisions; meta.stationComponentRevisions = built.stationComponentRevisions; meta.conditionStationIds = built.conditionStationIds;
      diag(client)[group.full ? 'fullBuilt' : 'compactBuilt'] += 1;
      enqueueSnapshot(client, built.payload, meta);
      payloadBytes += built.payload.length;
    }
    maxClientBytes = Math.max(maxClientBytes, built.payload.length);
  }
  room._lastSnapshotDeliveryMetrics = {
    groups: groups.size,
    recipients: room.clients.size,
    constructionMs,
    encodingMs,
    aggregatePayloadBytes: payloadBytes,
    maxClientBytes
  };
  recordSnapshot({ durationMs: performanceNow() - startedAt, constructionMs, encodingMs, payloadBytes, maxClientBytes, clients: room.clients.size });
}
module.exports = {
  ensureSnapshotBaseline,
  sendFullSnapshot,
  broadcastSnapshot,
  onSnapshotLifecycle,
  _test: { stableRevisionMap, snapshotGroupingKey, duplicateSnapshotPlayerIds, telemetryFocusForPayload },
  constants: { TELEMETRY_INTERVAL_MS }
};
