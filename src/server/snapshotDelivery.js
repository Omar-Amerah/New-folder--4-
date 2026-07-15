const { encodeMessage } = require("./wsCodec");
const { performanceNow } = require("./utils");
const { sendRaw } = require("./outbound");
const { snapshotRoom, buildSharedSnapshot, markShipDesignsSent } = require("./snapshots");

function ensureSnapshotBaseline(client, room) {
  if (!client.snapshotBaseline) client.snapshotBaseline = {};
  const b = client.snapshotBaseline;
  if (b.stateEpoch !== (room.stateEpoch || 1)) {
    b.stateEpoch = room.stateEpoch || 1;
    b.lastSentSeq = 0;
    b.lastFullSeq = 0;
    b.fullRequired = true;
    b.staticRevisionKnown = 0;
  }
  if (b.fullRequired === undefined) b.fullRequired = true;
  return b;
}

function sendFullSnapshot(client, now = performanceNow(), reason = 'resync') {
  if (!client.room) return;
  const room = client.room;
  const b = ensureSnapshotBaseline(client, room);
  const seq = (room.snapshotSeq = Math.max(0, room.snapshotSeq || 0) + 1);
  room._buildingSnapshotSeq = seq;
  const shared = buildSharedSnapshot(room, now, true);
  const payload = encodeMessage(snapshotRoom(room, now, client.player, true, shared));
  delete room._buildingSnapshotSeq;
  b.lastSentSeq = seq; b.lastFullSeq = seq; b.fullRequired = false; b.staticRevisionKnown = room.staticRevision || 1; b.queuedSnapshotKind = 'full';
  sendRaw(client, payload, { kind: 'snapshot-full' });
}

function broadcastSnapshot(room, now, forceStatic = false) {
  if (room.clients.size === 0) return;
  const seq = (room.snapshotSeq = Math.max(0, room.snapshotSeq || 0) + 1);
  room._buildingSnapshotSeq = seq;
  const fullShared = forceStatic ? buildSharedSnapshot(room, now, true) : null;
  const compactShared = forceStatic ? null : buildSharedSnapshot(room, now, false);
  const byVariant = new Map();
  for (const client of room.clients) {
    const b = ensureSnapshotBaseline(client, room);
    const full = forceStatic || b.fullRequired || b.staticRevisionKnown !== (room.staticRevision || 1) || b.lastSentSeq !== seq - 1;
    const shared = full ? (fullShared || buildSharedSnapshot(room, now, true)) : compactShared;
    const key = `${client.player ? `t:${client.player.team}` : 'spectator'}|e:${room.stateEpoch}|rev:${room.staticRevision}|kind:${full ? 'full':'compact'}|base:${full ? 0 : b.lastSentSeq}`;
    let payload = byVariant.get(key);
    if (payload === undefined) {
      payload = encodeMessage(snapshotRoom(room, now, client.player, full, shared));
      byVariant.set(key, payload);
    }
    b.lastSentSeq = seq; b.queuedSnapshotKind = full ? 'full' : 'compact';
    if (full) { b.lastFullSeq = seq; b.fullRequired = false; b.staticRevisionKnown = room.staticRevision || 1; }
    sendRaw(client, payload, { kind: full ? 'snapshot-full' : 'snapshot-compact' });
  }
  delete room._buildingSnapshotSeq;
  markShipDesignsSent(room);
}


module.exports = { ensureSnapshotBaseline, sendFullSnapshot, broadcastSnapshot };
