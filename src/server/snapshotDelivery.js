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
  markSnapshotConditionStationsWritten,
  pruneClientKnownShips,
  pruneClientKnownStations,
  collectEntityDeltaBaselineIds
} = require("./snapshots");
const { recordSnapshot, recordSnapshotWaste } = require("./performanceTelemetry");
const { markProjectilesWritten, markProjectilesReplaced, getClientProjectileSignature, clientSupportsProjectileEvents } = require("./projectileReplication");
const { ENTITY_DELTA_SNAPSHOTS } = require("./performanceFlags");
const {
  ENTITY_DELTA_FORMAT_VERSION,
  createSnapshotEntityState,
  buildStateFromSnapshot,
  buildEntityDeltaSnapshot
} = require("./snapshotEntityDelta");

const TELEMETRY_INTERVAL_MS = 500;

function patchSectionBytes(value) {
  return encodeMessage(value || {}).length;
}
function patchRowCount(patch, key) {
  return Array.isArray(patch?.[key]) ? patch[key].length : 0;
}

function phase5MetricsForBuilt(wireSnapshot, payloadBytes, formatVersion, full, constructionMs, encodingMs) {
  const metrics = {
    snapshotFullBytes: full ? payloadBytes : 0,
    snapshotLegacyCompactBytes: !full && formatVersion === 1 ? payloadBytes : 0,
    snapshotEntityDeltaBytes: !full && formatVersion === ENTITY_DELTA_FORMAT_VERSION ? payloadBytes : 0,
    snapshotConstructionViewerMs: constructionMs,
    snapshotEncodingMs: encodingMs
  };
  if (!full && formatVersion === ENTITY_DELTA_FORMAT_VERSION) {
    if (process.env.MFA_PHASE5_SECTION_TELEMETRY === "1") {
      const motion = {
        ships: wireSnapshot.shipsPatch?.motion || [],
        drones: wireSnapshot.dronesPatch?.motion || [],
        decoys: wireSnapshot.decoysPatch?.motion || [],
        effects: wireSnapshot.effectsPatch?.motion || []
      };
      const sparse = {
        players: [
          ...(wireSnapshot.playersPatch?.upsert || []),
          ...(wireSnapshot.playersPatch?.state || [])
        ],
        ships: wireSnapshot.shipsPatch?.state || [],
        drones: wireSnapshot.dronesPatch?.state || [],
        decoys: wireSnapshot.decoysPatch?.state || [],
        stations: wireSnapshot.stationsPatch?.dynamic || [],
        points: [
          ...(wireSnapshot.pointsPatch?.upsert || []),
          ...(wireSnapshot.pointsPatch?.state || [])
        ],
        effects: wireSnapshot.effectsPatch?.state || [],
        supplementary: [
          ...(wireSnapshot.dronesPatch?.remaining || []),
          ...(wireSnapshot.decoysPatch?.remaining || []),
          ...(wireSnapshot.effectsPatch?.remaining || [])
        ]
      };
      const clears = {
        players: wireSnapshot.playersPatch?.clearStateFields || [],
        ships: wireSnapshot.shipsPatch?.clearStateFields || [],
        drones: wireSnapshot.dronesPatch?.clearStateFields || [],
        decoys: wireSnapshot.decoysPatch?.clearStateFields || [],
        effects: wireSnapshot.effectsPatch?.clearStateFields || []
      };
      const privatePart = { ships: wireSnapshot.shipsPatch?.private || [] };
      const privateClears = { ships: wireSnapshot.shipsPatch?.clearPrivateFields || [] };
      const removals = {
        ships: wireSnapshot.shipsPatch?.remove || [],
        drones: wireSnapshot.dronesPatch?.remove || [],
        decoys: wireSnapshot.decoysPatch?.remove || [],
        stations: wireSnapshot.stationsPatch?.remove || [],
        points: wireSnapshot.pointsPatch?.remove || [],
        effects: wireSnapshot.effectsPatch?.remove || []
      };
      const dictionary = {
        ships: wireSnapshot.shipsPatch?.upsert || [],
        drones: wireSnapshot.dronesPatch?.upsert || [],
        decoys: wireSnapshot.decoysPatch?.upsert || [],
        stations: wireSnapshot.stationsPatch?.upsert || [],
        effects: wireSnapshot.effectsPatch?.upsert || []
      };
      metrics.snapshotMotionBytes = patchSectionBytes(motion);
      metrics.snapshotSparseStateBytes = patchSectionBytes(sparse);
      metrics.snapshotStateClearBytes = patchSectionBytes(clears);
      metrics.snapshotPrivateBytes = patchSectionBytes(privatePart);
      metrics.snapshotPrivateClearBytes = patchSectionBytes(privateClears);
      metrics.snapshotRemovalBytes = patchSectionBytes(removals);
      metrics.snapshotDictionaryBytes = patchSectionBytes(dictionary);
    } else {
      // The production path keeps section accounting allocation-free.  The
      // payload is MessagePack, so this bounded count-weighted estimate is
      // sufficient for process telemetry; set MFA_PHASE5_SECTION_TELEMETRY=1
      // when exact section micro-accounting is required for a benchmark.
      const motionCount = patchRowCount(wireSnapshot.shipsPatch, "motion")
        + patchRowCount(wireSnapshot.dronesPatch, "motion")
        + patchRowCount(wireSnapshot.decoysPatch, "motion")
        + patchRowCount(wireSnapshot.effectsPatch, "motion");
      const sparseCount = patchRowCount(wireSnapshot.playersPatch, "upsert")
        + patchRowCount(wireSnapshot.playersPatch, "state")
        + patchRowCount(wireSnapshot.shipsPatch, "state")
        + patchRowCount(wireSnapshot.dronesPatch, "state")
        + patchRowCount(wireSnapshot.decoysPatch, "state")
        + patchRowCount(wireSnapshot.stationsPatch, "dynamic")
        + patchRowCount(wireSnapshot.pointsPatch, "upsert")
        + patchRowCount(wireSnapshot.pointsPatch, "state")
        + patchRowCount(wireSnapshot.effectsPatch, "state")
        + patchRowCount(wireSnapshot.dronesPatch, "remaining")
        + patchRowCount(wireSnapshot.decoysPatch, "remaining")
        + patchRowCount(wireSnapshot.effectsPatch, "remaining");
      const stateClearCount = patchRowCount(wireSnapshot.playersPatch, "clearStateFields")
        + patchRowCount(wireSnapshot.shipsPatch, "clearStateFields")
        + patchRowCount(wireSnapshot.dronesPatch, "clearStateFields")
        + patchRowCount(wireSnapshot.decoysPatch, "clearStateFields")
        + patchRowCount(wireSnapshot.effectsPatch, "clearStateFields");
      const privateCount = patchRowCount(wireSnapshot.shipsPatch, "private");
      const privateClearCount = patchRowCount(wireSnapshot.shipsPatch, "clearPrivateFields");
      const removalCount = patchRowCount(wireSnapshot.shipsPatch, "remove")
        + patchRowCount(wireSnapshot.dronesPatch, "remove")
        + patchRowCount(wireSnapshot.decoysPatch, "remove")
        + patchRowCount(wireSnapshot.stationsPatch, "remove")
        + patchRowCount(wireSnapshot.pointsPatch, "remove")
        + patchRowCount(wireSnapshot.effectsPatch, "remove");
      const dictionaryCount = patchRowCount(wireSnapshot.shipsPatch, "upsert")
        + patchRowCount(wireSnapshot.dronesPatch, "upsert")
        + patchRowCount(wireSnapshot.decoysPatch, "upsert")
        + patchRowCount(wireSnapshot.stationsPatch, "upsert")
        + patchRowCount(wireSnapshot.effectsPatch, "upsert");
      const total = Math.max(1, motionCount + sparseCount + stateClearCount + privateCount + privateClearCount + removalCount + dictionaryCount);
      metrics.snapshotMotionBytes = Math.round(payloadBytes * motionCount / total);
      metrics.snapshotSparseStateBytes = Math.round(payloadBytes * sparseCount / total);
      metrics.snapshotStateClearBytes = Math.round(payloadBytes * stateClearCount / total);
      metrics.snapshotPrivateBytes = Math.round(payloadBytes * privateCount / total);
      metrics.snapshotPrivateClearBytes = Math.round(payloadBytes * privateClearCount / total);
      metrics.snapshotRemovalBytes = Math.round(payloadBytes * removalCount / total);
      metrics.snapshotDictionaryBytes = Math.round(payloadBytes * dictionaryCount / total);
    }
  }
  return metrics;
}

function diag(client) { return client.snapshotDeliveryDiagnostics ||= { fullBuilt: 0, compactBuilt: 0, queued: 0, written: 0, replaced: 0, dropped: 0, reset: 0, promotions: 0, recoveryRequests: 0, completedRecoveries: 0 }; }
function clientSupportsEntityDeltaSnapshots(client) {
  return ENTITY_DELTA_SNAPSHOTS()
    && Array.isArray(client?.protocol?.capabilities)
    && client.protocol.capabilities.includes("entityDeltaSnapshotsV1");
}
function ensureSnapshotEntityState(client, room) {
  const epoch = Number(room?.stateEpoch) || 1;
  if (!client.snapshotEntityState || client.snapshotEntityState.stateEpoch !== epoch) {
    client.snapshotEntityState = createSnapshotEntityState(epoch);
  }
  return client.snapshotEntityState;
}
function ensureSnapshotBaseline(client, room) {
  if (!client.snapshotBaseline) client.snapshotBaseline = {};
  const b = client.snapshotBaseline; const epoch = room.stateEpoch || 1;
  if (b.stateEpoch !== epoch) {
    Object.assign(b, { stateEpoch: epoch, lastWrittenSeq: 0, lastWrittenFullSeq: 0, lastQueuedSeq: 0, queuedSnapshotKind: null, queuedBaseSeq: null, queuedStaticRevision: 0, fullRequired: true, staticRevisionKnown: 0, lastWrittenFormatVersion: 0 });
    client.snapshotEntityState = createSnapshotEntityState(epoch);
  }
  if (b.fullRequired === undefined) b.fullRequired = true;
  if (b.lastWrittenFormatVersion === undefined) b.lastWrittenFormatVersion = 0;
  b.lastSentSeq = b.lastWrittenSeq || 0; // compatibility alias: written, not merely generated/queued.
  return b;
}
function resetSnapshotClientState(client) {
  if (!client) return;
  client.snapshotEntityState = null;
  client.snapshotBaseline = {
    stateEpoch: 0,
    lastWrittenSeq: 0,
    lastWrittenFullSeq: 0,
    lastQueuedSeq: 0,
    queuedSnapshotKind: null,
    queuedBaseSeq: null,
    queuedStaticRevision: 0,
    fullRequired: true,
    staticRevisionKnown: 0,
    lastWrittenFormatVersion: 0
  };
  client._knownSignature = null;
  for (const key of [
    "knownShipDesignRevisions", "knownShipPowerRevisions", "knownShipPowerProtectionRevisions",
    "knownShipWiringLayoutRevisions", "knownShipHeatTelemetryRevisions", "knownStationStaticRevisions",
    "knownStationComponentRevisions"
  ]) client[key]?.clear?.();
  client.knownVisibleShipIds = new Set();
  client.knownConditionStationIds = new Set();
}
function onSnapshotLifecycle(client, outcome, meta) {
  const b = ensureSnapshotBaseline(client, client.room || { stateEpoch: meta?.stateEpoch || 1 }); const d = diag(client); d[outcome] = (d[outcome] || 0) + 1;
  if (outcome === 'queued') { b.lastQueuedSeq = meta.snapshotSeq; b.queuedSnapshotKind = meta.snapshotKind; b.queuedBaseSeq = meta.baseSnapshotSeq ?? null; b.queuedStaticRevision = meta.staticRevision || 0; }
  if (outcome === 'replaced' || outcome === 'dropped' || outcome === 'reset') {
    if (b.lastQueuedSeq === meta?.snapshotSeq) { b.lastQueuedSeq = 0; b.queuedSnapshotKind = null; b.queuedBaseSeq = null; b.queuedStaticRevision = 0; }
    markProjectilesReplaced(client);
    if (outcome === 'replaced') recordSnapshotWaste(meta?.payloadBytes || 0, 1);
    // A queued compact packet can no longer be the next written baseline.
    // Keep last-written entity knowledge intact, but force the next packet to
    // recover with a full baseline after coalescing or queue reset.
    if (outcome !== 'reset') b.fullRequired = true;
    if (outcome === 'reset') {
      client.snapshotEntityState = createSnapshotEntityState(b.stateEpoch);
      b.lastWrittenFormatVersion = 0;
      b.fullRequired = true;
    }
  }
  if (outcome === 'written') {
    b.lastWrittenSeq = meta.snapshotSeq;
    b.lastSentSeq = b.lastWrittenSeq;
    b.lastQueuedSeq = 0;
    b.queuedSnapshotKind = null;
    b.queuedBaseSeq = null;
    b.queuedStaticRevision = 0;
    if (meta.projectileDelivery) markProjectilesWritten(client, client.room, meta.projectileDelivery);
    markSnapshotDesignsWritten(client, meta.shipDesignRevisions);
    markSnapshotVisibilityWritten(client, meta.visibleShipIds);
    markSnapshotPowerWritten(client, meta.shipPowerRevisions);
    markSnapshotPowerProtectionWritten(client, meta.shipPowerProtectionRevisions);
    markSnapshotWiringLayoutWritten(client, meta.shipWiringLayoutRevisions);
    markSnapshotHeatTelemetryWritten(client, meta.shipHeatTelemetryRevisions);
    markSnapshotStationStaticWritten(client, meta.stationStaticRevisions);
    markSnapshotStationComponentWritten(client, meta.stationComponentRevisions);
    markSnapshotConditionStationsWritten(client, meta.conditionStationIds);
    pruneClientKnownShips(client, meta.visibleShipIds);
    pruneClientKnownStations(client, meta.conditionStationIds);
    if (meta.snapshotKind === 'full') {
      b.lastWrittenFullSeq = meta.snapshotSeq;
      b.fullRequired = false;
      b.staticRevisionKnown = meta.staticRevision || 1;
      b.lastWrittenFormatVersion = meta.snapshotFormatVersion || 1;
      client.snapshotEntityState = meta.entityState || createSnapshotEntityState(b.stateEpoch);
      d.completedRecoveries += 1;
    } else if (meta.snapshotFormatVersion === ENTITY_DELTA_FORMAT_VERSION && meta.entityState) {
      b.lastWrittenFormatVersion = ENTITY_DELTA_FORMAT_VERSION;
      client.snapshotEntityState = meta.entityState;
    } else if (meta.snapshotFormatVersion && meta.snapshotFormatVersion !== ENTITY_DELTA_FORMAT_VERSION) {
      client.snapshotEntityState = createSnapshotEntityState(b.stateEpoch);
    }
    client._knownSignature = buildClientKnownSignature(client);
    if (meta.telemetryFocusShipId) {
      client.telemetryLastWrittenFocusId = meta.telemetryFocusShipId;
      client.telemetryLastWrittenAt = meta.telemetryAt || performanceNow();
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
function buildPayload(room, client, now, full, seq, baseSeq, shared = null, formatVersion = 1) {
  const constructionStartedAt = performanceNow();
  room._buildingSnapshotSeq = seq; room._buildingBaseSnapshotSeq = baseSeq;
  if (!shared) shared = buildSharedSnapshot(room, now, false, true, !clientSupportsProjectileEvents(client), formatVersion === ENTITY_DELTA_FORMAT_VERSION);
  const telemetryFocusShipId = telemetryFocusForPayload(client, now, full);
  const previousEntityState = ensureSnapshotEntityState(client, room);
  const baselineIds = !full && formatVersion === ENTITY_DELTA_FORMAT_VERSION
    ? collectEntityDeltaBaselineIds(room, client, shared, previousEntityState, now)
    : { ships: new Set(), stations: new Set(), players: new Set() };
  const snap = snapshotRoom(room, now, client.player, full, shared, client, {
    telemetryFocusShipId,
    entityDeltaSparse: !full && formatVersion === ENTITY_DELTA_FORMAT_VERSION,
    baselineShipIds: baselineIds.ships,
    baselineStationIds: baselineIds.stations,
    baselinePlayerIds: baselineIds.players
  });
  delete room._buildingSnapshotSeq; delete room._buildingBaseSnapshotSeq;
  snap.snapshotFormatVersion = formatVersion;
  let entityState = null;
  let entityDeltaStats = null;
  let wireSnapshot = snap;
  if (full && formatVersion === ENTITY_DELTA_FORMAT_VERSION) {
    entityState = buildStateFromSnapshot(snap, snap.stateEpoch);
  }
  if (!full && formatVersion === ENTITY_DELTA_FORMAT_VERSION) {
    const delta = buildEntityDeltaSnapshot(snap, previousEntityState, {
      baselineShipIds: baselineIds.ships,
      baselineStationIds: baselineIds.stations,
      baselinePlayerIds: baselineIds.players,
      telemetryFocusShipId
    });
    wireSnapshot = delta.snapshot;
    entityState = delta.nextState;
    entityDeltaStats = delta.stats;
  }
  const constructionMs = performanceNow() - constructionStartedAt;
  const encodingStartedAt = performanceNow();
  const payload = encodeMessage(wireSnapshot);
  const encodingMs = performanceNow() - encodingStartedAt;
  const projectileDelivery = client?._projectile?.pendingDelivery ?? null;
  return {
    payload,
    snapshot: wireSnapshot,
    constructionMs,
    encodingMs,
    phase5Metrics: phase5MetricsForBuilt(wireSnapshot, payload.length, formatVersion, full, constructionMs, encodingMs),
    snapshotFormatVersion: formatVersion,
    entityState,
    entityDeltaStats,
    telemetryFocusShipId,
    projectileDelivery,
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
  const formatVersion = clientSupportsEntityDeltaSnapshots(client) ? ENTITY_DELTA_FORMAT_VERSION : 1;
  const meta = { stateEpoch: room.stateEpoch || 1, snapshotSeq: seq, baseSnapshotSeq: null, snapshotKind: 'full', staticRevision: room.staticRevision || 1, completeStatic: true, reason };
  const built = buildPayload(room, client, now, true, seq, null, null, formatVersion);
  meta.snapshotFormatVersion = formatVersion;
  meta.entityState = built.entityState;
  meta.entityDeltaStats = built.entityDeltaStats;
  meta.payloadBytes = built.payload.length;
  meta.telemetryFocusShipId = built.telemetryFocusShipId; meta.telemetryAt = now;
  meta.projectileDelivery = built.projectileDelivery;
  meta.shipDesignRevisions = built.designRevisions; meta.visibleShipIds = built.visibleShipIds; meta.shipPowerRevisions = built.powerRevisions; meta.shipPowerProtectionRevisions = built.powerProtectionRevisions; meta.shipWiringLayoutRevisions = built.wiringLayoutRevisions; meta.shipHeatTelemetryRevisions = built.heatTelemetryRevisions;
  meta.stationStaticRevisions = built.stationStaticRevisions; meta.stationComponentRevisions = built.stationComponentRevisions; meta.conditionStationIds = built.conditionStationIds;
  diag(client).fullBuilt += 1;
  if (reason) diag(client).recoveryRequests += 1;
  enqueueSnapshot(client, built.payload, meta);
  recordSnapshot({ durationMs: performanceNow() - startedAt, constructionMs: built.constructionMs, encodingMs: built.encodingMs, payloadBytes: built.payload.length, maxClientBytes: built.payload.length, clients: 1, phase5: {
    ...built.phase5Metrics,
    snapshotRecipients: 1,
    snapshotPayloadGroups: 1,
    snapshotResyncRequests: reason ? 1 : 0,
    snapshotEntitiesConsidered: built.entityDeltaStats?.entitiesConsidered || 0,
    snapshotEntitiesPatched: built.entityDeltaStats?.entitiesPatched || 0,
    snapshotEntitiesUnchanged: built.entityDeltaStats?.entitiesUnchanged || 0,
    snapshotVisibilityRemovals: built.entityDeltaStats?.visibilityRemovals || 0
  } });
}
function canSendCompact(room, b, broadcastSeq, forceStatic, formatVersion = 1) {
  const revision = room.staticRevision || 1;
  return !forceStatic
    && !b.fullRequired
    && b.stateEpoch === (room.stateEpoch || 1)
    && b.lastWrittenFullSeq > 0
    && b.lastWrittenSeq === broadcastSeq - 1
    && !b.queuedSnapshotKind
    && b.staticRevisionKnown === revision
    && (b.lastWrittenFormatVersion || 1) === formatVersion;
}
function stableRevisionMap(map) {
  if (!(map instanceof Map) || map.size === 0) return "";
  const entries = [];
  for (const [id, revision] of map) entries.push([id, revision]);
  entries.sort((a, b) => compareIdStrings(a[0], b[0]));
  return entries.map(([id, revision]) => `${String(id)}:${Number(revision) || 0}`).join(",");
}
function stableIdSet(set) {
  if (!(set instanceof Set) || set.size === 0) return "";
  return [...set].map(String).sort().join(",");
}
function stableEntityStateSignature(state) {
  if (!state) return "";
  const parts = [];
  for (const kind of ["ships", "drones", "decoys", "stations", "players", "points", "effects"]) {
    const map = state[kind];
    if (!(map instanceof Map)) continue;
    const rows = [];
    for (const [id, record] of map) rows.push([
      String(id),
      record?.detail || "",
      record?.designRevision || 0,
      record?.motionSignature || "",
      record?.stateSignature || "",
      record?.privateSignature || "",
      record?.remainingSignature || "",
      record?.entrySignature || ""
    ]);
    rows.sort((a, b) => a[0].localeCompare(b[0]));
    parts.push(`${kind}:${rows.map((row) => row.join(":")).join(",")}`);
  }
  return parts.join("|");
}
function buildClientKnownSignature(client) {
  if (!client) return "";
  return [
    stableRevisionMap(client.knownShipDesignRevisions),
    stableRevisionMap(client.knownShipPowerRevisions),
    stableRevisionMap(client.knownShipPowerProtectionRevisions),
    stableRevisionMap(client.knownShipWiringLayoutRevisions),
    stableRevisionMap(client.knownShipHeatTelemetryRevisions),
    stableIdSet(client.knownVisibleShipIds),
    stableRevisionMap(client.knownStationStaticRevisions),
    stableRevisionMap(client.knownStationComponentRevisions),
    stableIdSet(client.knownConditionStationIds),
    stableEntityStateSignature(client.snapshotEntityState)
  ].join("\0");
}
function getClientKnownSignature(client) {
  return client?._knownSignature ?? (client._knownSignature = buildClientKnownSignature(client));
}
function snapshotGroupingKey(room, client, { full, base, seq, revision, epoch, telemetryFocusShipId, formatVersion }) {
  const player = client?.player;
  if (!player?.id) return null;
  // Deliberately strict. Player identity is included because own-ship/private
  // visibility and player-specific economy fields can differ even on one team.
  return getClientKnownSignature(client) + "\0" + getClientProjectileSignature(client) + "\0" + JSON.stringify([
    player.id,
    player.team ?? null,
    room.rules?.gameMode || "teams",
    full ? "full" : "compact",
    formatVersion,
    base,
    seq,
    revision,
    epoch,
    telemetryFocusShipId
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
  const needsFallback = [...(room.clients || [])].some((c) => !clientSupportsProjectileEvents(c));
  const needsEntityDeltaKeys = [...(room.clients || [])].some((c) => clientSupportsEntityDeltaSnapshots(c));
  const shared = buildSharedSnapshot(room, now, false, true, needsFallback, needsEntityDeltaKeys);
  let constructionMs = performanceNow() - sharedStartedAt;
  const sharedConstructionMs = constructionMs;
  let encodingMs = 0;
  let payloadBytes = 0;
  let maxClientBytes = 0;
  const phase5 = {};
  const addPhase5 = (name, value) => { phase5[name] = (phase5[name] || 0) + (Number(value) || 0); };
  let fullPromotions = 0;
  const groups = new Map();
  const duplicatePlayerIds = room.disableSnapshotGrouping
    ? null
    : duplicateSnapshotPlayerIds(room.clients);
  for (const client of room.clients) {
    const b = ensureSnapshotBaseline(client, room);
    const existing = getOutbound(client).snapshot;
    const formatVersion = clientSupportsEntityDeltaSnapshots(client) ? ENTITY_DELTA_FORMAT_VERSION : 1;
    const full = !canSendCompact(room, b, seq, forceStatic, formatVersion);
    if (existing?.meta?.snapshotKind && full) { diag(client).promotions += 1; fullPromotions += 1; }
    const base = full ? null : b.lastWrittenSeq;
    const meta = { stateEpoch: epoch, snapshotSeq: seq, baseSnapshotSeq: base, snapshotKind: full ? 'full' : 'compact', snapshotFormatVersion: formatVersion, staticRevision: revision, completeStatic: full };
    const telemetryFocusShipId = telemetryFocusForPayload(client, now, full);
    const key = duplicatePlayerIds?.has(client?.player?.id)
      ? snapshotGroupingKey(room, client, { full, base, seq, revision, epoch, telemetryFocusShipId, formatVersion })
      : null;
    // A null key is intentionally unique: when identity/visibility cannot be
    // proven, fall back to per-client construction.
    const groupKey = key === null ? Symbol("per-client-snapshot") : key;
    let group = groups.get(groupKey);
    if (!group) {
      group = { client, full, base, formatVersion, meta, recipients: [] };
      groups.set(groupKey, group);
    }
    group.recipients.push({ client, meta });
  }
  for (const group of groups.values()) {
    const built = buildPayload(room, group.client, now, group.full, seq, group.base, shared, group.formatVersion);
    constructionMs += built.constructionMs;
    encodingMs += built.encodingMs;
    for (const [name, value] of Object.entries(built.phase5Metrics || {})) {
      const multiplier = name.endsWith("Ms") ? 1 : group.recipients.length;
      addPhase5(name, Number(value) * multiplier);
    }
    if (built.entityDeltaStats) {
      addPhase5("snapshotEntitiesConsidered", built.entityDeltaStats.entitiesConsidered * group.recipients.length);
      addPhase5("snapshotEntitiesPatched", built.entityDeltaStats.entitiesPatched * group.recipients.length);
      addPhase5("snapshotEntitiesUnchanged", built.entityDeltaStats.entitiesUnchanged * group.recipients.length);
      addPhase5("snapshotVisibilityRemovals", built.entityDeltaStats.visibilityRemovals * group.recipients.length);
    }
    for (const recipient of group.recipients) {
      const { client, meta } = recipient;
      meta.telemetryFocusShipId = built.telemetryFocusShipId; meta.telemetryAt = now;
      meta.snapshotFormatVersion = built.snapshotFormatVersion;
      meta.entityState = built.entityState;
      meta.entityDeltaStats = built.entityDeltaStats;
      meta.payloadBytes = built.payload.length;
      meta.projectileDelivery = built.projectileDelivery;
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
    sharedConstructionMs,
    viewerConstructionMs: Math.max(0, constructionMs - sharedConstructionMs),
    encodingMs,
    aggregatePayloadBytes: payloadBytes,
    maxClientBytes,
    totalBroadcastMs: performanceNow() - startedAt
  };
  addPhase5("snapshotConstructionSharedMs", sharedConstructionMs);
  addPhase5("snapshotRecipients", room.clients.size);
  addPhase5("snapshotPayloadGroups", groups.size);
  addPhase5("snapshotFullPromotions", fullPromotions);
  recordSnapshot({ durationMs: performanceNow() - startedAt, constructionMs, encodingMs, payloadBytes, maxClientBytes, clients: room.clients.size, phase5 });
}
module.exports = {
  ensureSnapshotBaseline,
  resetSnapshotClientState,
  sendFullSnapshot,
  broadcastSnapshot,
  onSnapshotLifecycle,
  _test: { stableRevisionMap, snapshotGroupingKey, duplicateSnapshotPlayerIds, telemetryFocusForPayload, clientSupportsEntityDeltaSnapshots, stableEntityStateSignature },
  constants: { TELEMETRY_INTERVAL_MS }
};
