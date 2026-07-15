// Handles WebSocket outbound payload framing, room-wide broadcasts, state snapshot multicasting, and inbound JSON message routing.

const { clampNumber, performanceNow } = require("./utils");
const { encodeMessage } = require("./wsCodec");
const { validateClientMessage } = require("./clientSchemas");
const { negotiate, ERROR_CODES, serverEnvelope } = require("./protocol");

// Binary WebSocket opcode (0x2) — outbound game data is MessagePack, not text.
const BINARY_OPCODE = 0x2;
const CONTROL_QUEUE_BYTE_LIMIT = 256 * 1024;
const SNAPSHOT_QUEUE_LIMIT = 2;
const TOTAL_QUEUE_BYTE_LIMIT = 768 * 1024;
const BLOCKED_CLOSE_MS = 15000;
let writeFrame = defaultWriteFrame;
let closeClient = null;
function defaultWriteFrame(socket, payload, opcode = 0x2) {
  if (typeof payload === "string") payload = Buffer.from(payload, "utf8");
  const length = payload.length;
  let header;
  if (length < 126) { header = Buffer.alloc(2); header[0] = 0x80 | opcode; header[1] = length; }
  else if (length <= 65535) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(length, 6); }
  return socket.write(Buffer.concat([header, payload]));
}
function configureOutbound(deps = {}) {
  writeFrame = deps.writeFrame || writeFrame;
  closeClient = deps.closeClient || closeClient;
}
function safeClose(client, code, reason) {
  if (closeClient) closeClient(client, code, reason);
  else { client.isClosed = true; client.socket?.destroy?.(); }
}

function send(client, data) {
  sendRaw(client, encodeMessage(serverEnvelope(client, data)));
}

// `payload` is a pre-encoded MessagePack Buffer (encode once, fan out to many).
function getOutbound(client) {
  if (!client.outbound) client.outbound = { control: [], snapshot: null, bytes: 0, controlBytes: 0, flushing: false, blocked: false, blockedSince: 0, drainListener: null, blockedCloseTimer: null, coalescedSnapshots: 0 };
  return client.outbound;
}

function frameBytes(payload) { return Buffer.isBuffer(payload) ? payload.length + 14 : 14; }
function clearBlockedTimer(out) { if (out.blockedCloseTimer) clearTimeout(out.blockedCloseTimer); out.blockedCloseTimer = null; }
function removeDrain(client, out) { if (out.drainListener && client.socket?.off) client.socket.off('drain', out.drainListener); out.drainListener = null; }
function notifySnapshot(item, event, client) { try { item?.snapshotCallbacks?.[event]?.(item.snapshotMeta || null, client, event); } catch {} }
function resetOutbound(client) { const out = getOutbound(client); removeDrain(client, out); clearBlockedTimer(out); if (out.snapshot) notifySnapshot(out.snapshot, 'reset', client); for (const item of out.control || []) notifySnapshot(item, 'reset', client); out.control = []; out.snapshot = null; out.bytes = 0; out.controlBytes = 0; out.blocked = false; out.blockedSince = 0; }

function enqueueRaw(client, payload, options = {}) {
  if (client.isClosed || client.socket.destroyed) return;
  const out = getOutbound(client);
  const bytes = frameBytes(payload);
  const kind = options.kind || 'control';
  if (kind === 'snapshot-compact') {
    if (out.snapshot) { out.bytes = Math.max(0, out.bytes - out.snapshot.bytes); out.coalescedSnapshots += 1; notifySnapshot(out.snapshot, 'replaced', client); }
    out.snapshot = { payload, bytes, kind, snapshotMeta: options.snapshotMeta || null, snapshotCallbacks: options.snapshotCallbacks || null };
    notifySnapshot(out.snapshot, 'queued', client);
    out.bytes += bytes;
  } else if (kind === 'snapshot-full') {
    if (out.snapshot?.kind === 'snapshot-compact') { out.bytes = Math.max(0, out.bytes - out.snapshot.bytes); notifySnapshot(out.snapshot, 'dropped', client); out.snapshot = null; }
    const item = { payload, bytes, kind, snapshotMeta: options.snapshotMeta || null, snapshotCallbacks: options.snapshotCallbacks || null };
    out.control.push(item);
    notifySnapshot(item, 'queued', client);
    out.bytes += bytes; out.controlBytes += bytes;
  } else {
    out.control.push({ payload, bytes, kind });
    out.bytes += bytes; out.controlBytes += bytes;
  }
  if (out.controlBytes > CONTROL_QUEUE_BYTE_LIMIT || out.bytes > TOTAL_QUEUE_BYTE_LIMIT || out.control.length > 128) {
    safeClose(client, 1013, 'rate-limited: outbound-queue-limit');
    return;
  }
  if (!out.blocked) flushOutbound(client);
}

function markBlocked(client, out) {
  if (out.blocked) return;
  out.blocked = true;
  out.blockedSince = Date.now();
  out.drainListener = () => {
    removeDrain(client, out);
    clearBlockedTimer(out);
    out.blocked = false;
    out.blockedSince = 0;
    flushOutbound(client);
  };
  client.socket.once?.('drain', out.drainListener);
  out.blockedCloseTimer = setTimeout(() => {
    if (!client.isClosed && out.blocked && Date.now() - out.blockedSince >= BLOCKED_CLOSE_MS) safeClose(client, 1013, 'rate-limited: outbound-backpressure');
  }, BLOCKED_CLOSE_MS + 25);
  out.blockedCloseTimer.unref?.();
}

function flushOutbound(client) {
  const out = getOutbound(client);
  if (out.flushing || out.blocked || client.isClosed || client.socket.destroyed) return;
  out.flushing = true;
  try {
    while (!out.blocked && (out.control.length || out.snapshot)) {
      const item = out.control.length ? out.control.shift() : out.snapshot;
      if (!out.control.length && item === out.snapshot) out.snapshot = null;
      const ok = writeFrame(client.socket, item.payload, BINARY_OPCODE);
      notifySnapshot(item, 'written', client);
      out.bytes = Math.max(0, out.bytes - item.bytes);
      if (item.kind !== 'snapshot-compact') out.controlBytes = Math.max(0, out.controlBytes - item.bytes);
      if (!ok) markBlocked(client, out);
    }
  } catch {
    safeClose(client, 1011, 'Send failed');
  } finally {
    out.flushing = false;
  }
}

// `payload` is a pre-encoded MessagePack Buffer (encode once, fan out to many).
function sendRaw(client, payload, options = {}) { enqueueRaw(client, payload, options); }

function sendPlayer(room, player, data) {
  for (const client of room.clients) {
    if (client.player?.id === player?.id) {
      send(client, data);
      return;
    }
  }
}

function broadcastRoom(room, data) {
  const payload = encodeMessage(data);
  for (const client of room.clients) sendRaw(client, payload);
}


module.exports = { configureOutbound, send, sendPlayer, broadcastRoom, sendRaw, getOutbound, enqueueRaw, flushOutbound, resetOutbound, constants: { CONTROL_QUEUE_BYTE_LIMIT, SNAPSHOT_QUEUE_LIMIT, TOTAL_QUEUE_BYTE_LIMIT, BLOCKED_CLOSE_MS } };
