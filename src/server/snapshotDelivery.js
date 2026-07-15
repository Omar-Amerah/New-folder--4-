const { encodeMessage } = require("./wsCodec");
const { performanceNow } = require("./utils");
const { sendRaw, getOutbound } = require("./outbound");
const { snapshotRoom, buildSharedSnapshot, markShipDesignsSent } = require("./snapshots");

function resetQueued(b) { b.lastQueuedSeq = 0; b.queuedSnapshotKind = null; b.queuedBaseSeq = null; }

function ensureSnapshotBaseline(client, room) {
  if (!client.snapshotBaseline) client.snapshotBaseline = {};
  const b = client.snapshotBaseline;
  if (b.stateEpoch !== (room.stateEpoch || 1)) {
    b.stateEpoch = room.stateEpoch || 1;
    b.lastWrittenSeq = 0;
    b.lastSentSeq = 0; // Legacy diagnostic alias for the last packet actually written.
    b.lastFullSeq = 0;
    b.fullRequired = true;
    b.staticRevisionKnown = 0;
    resetQueued(b);
  }
  if (b.fullRequired === undefined) b.fullRequired = true;
  if (b.lastWrittenSeq === undefined) b.lastWrittenSeq = b.lastSentSeq || 0;
  if (b.lastSentSeq !== b.lastWrittenSeq) b.lastSentSeq = b.lastWrittenSeq;
  if (b.lastQueuedSeq === undefined) resetQueued(b);
  return b;
}

function snapshotCallbacksFor(client) {
  return {
    queued(meta) {
      const b = client.snapshotBaseline; if (!b || !meta) return;
      b.lastQueuedSeq = meta.snapshotSeq; b.queuedSnapshotKind = meta.snapshotKind; b.queuedBaseSeq = meta.baseSnapshotSeq ?? null;
    },
    written(meta) {
      const b = client.snapshotBaseline; if (!b || !meta) return;
      b.lastWrittenSeq = meta.snapshotSeq; b.lastSentSeq = meta.snapshotSeq;
      if (meta.snapshotKind === 'full') { b.lastFullSeq = meta.snapshotSeq; b.fullRequired = false; b.staticRevisionKnown = meta.staticRevision || 1; }
      resetQueued(b);
    },
    replaced() { const b = client.snapshotBaseline; if (b) resetQueued(b); },
    dropped() { const b = client.snapshotBaseline; if (b) resetQueued(b); },
    reset() { const b = client.snapshotBaseline; if (b) { resetQueued(b); b.fullRequired = true; } }
  };
}

function sendSnapshotPacket(client, room, payload, meta) {
  sendRaw(client, payload, { kind: meta.snapshotKind === 'full' ? 'snapshot-full' : 'snapshot-compact', snapshotMeta: meta, snapshotCallbacks: snapshotCallbacksFor(client) });
}

function buildSnapshotPayload(room, now, client, full, shared, seq, baseSeq = null) {
  room._buildingSnapshotSeq = seq;
  room._buildingBaseSnapshotSeq = baseSeq;
  const payload = encodeMessage(snapshotRoom(room, now, client.player, full, shared));
  delete room._buildingBaseSnapshotSeq;
  delete room._buildingSnapshotSeq;
  return payload;
}

function sendFullSnapshot(client, now = performanceNow(), reason = 'resync') {
  if (!client.room) return;
  const room = client.room;
  const b = ensureSnapshotBaseline(client, room);
  const seq = (room.snapshotSeq = Math.max(0, room.snapshotSeq || 0) + 1);
  const shared = buildSharedSnapshot(room, now, true);
  const payload = buildSnapshotPayload(room, now, client, true, shared, seq, null);
  sendSnapshotPacket(client, room, payload, { stateEpoch: room.stateEpoch || 1, snapshotSeq: seq, baseSnapshotSeq: null, snapshotKind: 'full', staticRevision: room.staticRevision || 1, completeStatic: true, reason });
  b.fullRequired = false;
}

function broadcastSnapshot(room, now, forceStatic = false) {
  if (room.clients.size === 0) return;
  const seq = (room.snapshotSeq = Math.max(0, room.snapshotSeq || 0) + 1);
  const fullShared = buildSharedSnapshot(room, now, true);
  const compactShared = forceStatic ? null : buildSharedSnapshot(room, now, false);
  const byVariant = new Map();
  for (const client of room.clients) {
    const b = ensureSnapshotBaseline(client, room);
    const hasQueuedCompact = Boolean(getOutbound(client).snapshot);
    const baseSeq = b.lastWrittenSeq || 0;
    const full = forceStatic || hasQueuedCompact || b.fullRequired || b.staticRevisionKnown !== (room.staticRevision || 1) || baseSeq !== seq - 1;
    const shared = full ? fullShared : compactShared;
    const key = `${client.player ? `t:${client.player.team}` : 'spectator'}|e:${room.stateEpoch}|rev:${room.staticRevision}|kind:${full ? 'full':'compact'}|base:${full ? 0 : baseSeq}`;
    let payload = byVariant.get(key);
    if (payload === undefined) {
      payload = buildSnapshotPayload(room, now, client, full, shared, seq, full ? null : baseSeq);
      byVariant.set(key, payload);
    }
    sendSnapshotPacket(client, room, payload, { stateEpoch: room.stateEpoch || 1, snapshotSeq: seq, baseSnapshotSeq: full ? null : baseSeq, snapshotKind: full ? 'full' : 'compact', staticRevision: room.staticRevision || 1, completeStatic: full });
  }
  markShipDesignsSent(room);
}

module.exports = { ensureSnapshotBaseline, sendFullSnapshot, broadcastSnapshot };
