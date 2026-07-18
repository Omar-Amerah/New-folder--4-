const { encodeMessage } = require("./wsCodec");
const { performanceNow } = require("./utils");
const { sendRaw, getOutbound } = require("./outbound");
const { snapshotRoom, buildSharedSnapshot, collectSnapshotDesignRevisions, collectSnapshotPowerRevisions, markSnapshotDesignsWritten, markSnapshotPowerWritten } = require("./snapshots");

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
  if (outcome === 'written') { b.lastWrittenSeq = meta.snapshotSeq; b.lastSentSeq = b.lastWrittenSeq; b.lastQueuedSeq = 0; b.queuedSnapshotKind = null; b.queuedBaseSeq = null; b.queuedStaticRevision = 0; markSnapshotDesignsWritten(client, meta.shipDesignRevisions); markSnapshotPowerWritten(client, meta.shipPowerRevisions); if (meta.snapshotKind === 'full') { b.lastWrittenFullSeq = meta.snapshotSeq; b.fullRequired = false; b.staticRevisionKnown = meta.staticRevision || 1; d.completedRecoveries += 1; } }
}
function buildPayload(room, client, now, full, seq, baseSeq) {
  room._buildingSnapshotSeq = seq; room._buildingBaseSnapshotSeq = baseSeq;
  const shared = buildSharedSnapshot(room, now, full, true);
  const snap = snapshotRoom(room, now, client.player, full, shared, client);
  delete room._buildingSnapshotSeq; delete room._buildingBaseSnapshotSeq;
  return { payload: encodeMessage(snap), designRevisions: collectSnapshotDesignRevisions(snap), powerRevisions: collectSnapshotPowerRevisions(snap) };
}
function enqueueSnapshot(client, payload, meta) { sendRaw(client, payload, { kind: meta.snapshotKind === 'full' ? 'snapshot-full' : 'snapshot-compact', snapshotMeta: meta, onSnapshotLifecycle: (outcome, itemMeta) => onSnapshotLifecycle(client, outcome, itemMeta) }); }
function nextSeq(room) { return (room.snapshotSeq = Math.max(0, room.snapshotSeq || 0) + 1); }
function sendFullSnapshot(client, now = performanceNow(), reason = 'client-request') {
  if (!client.room) return;
  const room = client.room;
  ensureSnapshotBaseline(client, room);
  const seq = nextSeq(room);
  const meta = { stateEpoch: room.stateEpoch || 1, snapshotSeq: seq, baseSnapshotSeq: null, snapshotKind: 'full', staticRevision: room.staticRevision || 1, completeStatic: true, reason };
  const built = buildPayload(room, client, now, true, seq, null);
  meta.shipDesignRevisions = built.designRevisions; meta.shipPowerRevisions = built.powerRevisions;
  diag(client).fullBuilt += 1;
  if (reason) diag(client).recoveryRequests += 1;
  enqueueSnapshot(client, built.payload, meta);
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
function broadcastSnapshot(room, now, forceStatic = false) {
  if (room.clients.size === 0) return;
  const seq = nextSeq(room);
  const revision = room.staticRevision || 1;
  const epoch = room.stateEpoch || 1;
  for (const client of room.clients) {
    const b = ensureSnapshotBaseline(client, room);
    const existing = getOutbound(client).snapshot;
    const full = !canSendCompact(room, b, seq, forceStatic);
    if (existing?.meta?.snapshotKind && full) diag(client).promotions += 1;
    const base = full ? null : b.lastWrittenSeq;
    const meta = { stateEpoch: epoch, snapshotSeq: seq, baseSnapshotSeq: base, snapshotKind: full ? 'full' : 'compact', staticRevision: revision, completeStatic: full };
    const built = buildPayload(room, client, now, full, seq, base);
    meta.shipDesignRevisions = built.designRevisions; meta.shipPowerRevisions = built.powerRevisions;
    diag(client)[full ? 'fullBuilt' : 'compactBuilt'] += 1;
    enqueueSnapshot(client, built.payload, meta);
  }
}
module.exports = { ensureSnapshotBaseline, sendFullSnapshot, broadcastSnapshot, onSnapshotLifecycle };
