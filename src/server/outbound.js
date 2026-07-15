// Handles WebSocket outbound payload framing, room-wide broadcasts, state snapshot multicasting, and inbound JSON message routing.

const { encodeMessage } = require("./wsCodec");
const { validateClientMessage } = require("./clientSchemas");
const { serverEnvelope } = require("./protocol");

const BINARY_OPCODE = 0x2;
const CONTROL_QUEUE_BYTE_LIMIT = 256 * 1024;
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
function configureOutbound(deps = {}) { writeFrame = deps.writeFrame || writeFrame; closeClient = deps.closeClient || closeClient; }
function safeClose(client, code, reason) { if (closeClient) closeClient(client, code, reason); else { client.isClosed = true; client.socket?.destroy?.(); } }
function emitLifecycle(client, outcome, item) { try { item?.onLifecycle?.(outcome, item.meta || null, client); } catch (err) { console.error("snapshot lifecycle callback failed", outcome, err); } }
function send(client, data) { sendRaw(client, encodeMessage(serverEnvelope(client, data))); }
function getOutbound(client) { if (!client.outbound) client.outbound = { control: [], snapshot: null, bytes: 0, controlBytes: 0, flushing: false, blocked: false, blockedSince: 0, drainListener: null, blockedCloseTimer: null, coalescedSnapshots: 0 }; return client.outbound; }
function frameBytes(payload) { return Buffer.isBuffer(payload) ? payload.length + 14 : 14; }
function clearBlockedTimer(out) { if (out.blockedCloseTimer) clearTimeout(out.blockedCloseTimer); out.blockedCloseTimer = null; }
function removeDrain(client, out) { if (out.drainListener && client.socket?.off) client.socket.off('drain', out.drainListener); out.drainListener = null; }
function resetOutbound(client) { const out = getOutbound(client); removeDrain(client, out); clearBlockedTimer(out); if (out.snapshot) emitLifecycle(client, 'reset', out.snapshot); for (const item of out.control) if (item.kind?.startsWith('snapshot-')) emitLifecycle(client, 'reset', item); out.control = []; out.snapshot = null; out.bytes = 0; out.controlBytes = 0; out.blocked = false; out.blockedSince = 0; }
function makeItem(payload, bytes, kind, options) { return { payload, bytes, kind, meta: options.snapshotMeta || null, onLifecycle: options.onSnapshotLifecycle || null }; }
function enqueueRaw(client, payload, options = {}) {
  if (client.isClosed || client.socket.destroyed) return;
  const out = getOutbound(client); const bytes = frameBytes(payload); const kind = options.kind || 'control'; const item = makeItem(payload, bytes, kind, options);
  if (kind === 'snapshot-compact' || kind === 'snapshot-full') {
    if (out.snapshot) { out.bytes = Math.max(0, out.bytes - out.snapshot.bytes); out.coalescedSnapshots += 1; emitLifecycle(client, 'replaced', out.snapshot); }
    out.snapshot = item; out.bytes += bytes; emitLifecycle(client, 'queued', item);
  } else { out.control.push(item); out.bytes += bytes; out.controlBytes += bytes; }
  if (out.controlBytes > CONTROL_QUEUE_BYTE_LIMIT || out.bytes > TOTAL_QUEUE_BYTE_LIMIT || out.control.length > 128) { if (out.snapshot) emitLifecycle(client, 'dropped', out.snapshot); safeClose(client, 1013, 'rate-limited: outbound-queue-limit'); return; }
  if (!out.blocked) flushOutbound(client);
}
function markBlocked(client, out) {
  if (out.blocked) return; out.blocked = true; out.blockedSince = Date.now();
  out.drainListener = () => { removeDrain(client, out); clearBlockedTimer(out); out.blocked = false; out.blockedSince = 0; flushOutbound(client); };
  client.socket.once?.('drain', out.drainListener);
  out.blockedCloseTimer = setTimeout(() => { if (!client.isClosed && out.blocked && Date.now() - out.blockedSince >= BLOCKED_CLOSE_MS) safeClose(client, 1013, 'rate-limited: outbound-backpressure'); }, BLOCKED_CLOSE_MS + 25); out.blockedCloseTimer.unref?.();
}
function flushOutbound(client) {
  const out = getOutbound(client); if (out.flushing || out.blocked || client.isClosed || client.socket.destroyed) return; out.flushing = true;
  try { while (!out.blocked && (out.control.length || out.snapshot)) { const item = out.control.length ? out.control.shift() : out.snapshot; if (!out.control.length && item === out.snapshot) out.snapshot = null; const ok = writeFrame(client.socket, item.payload, BINARY_OPCODE); emitLifecycle(client, 'written', item); out.bytes = Math.max(0, out.bytes - item.bytes); if (!item.kind?.startsWith('snapshot-')) out.controlBytes = Math.max(0, out.controlBytes - item.bytes); if (!ok) markBlocked(client, out); } }
  catch (err) { console.error('outbound write failed', err); safeClose(client, 1011, 'Send failed'); }
  finally { out.flushing = false; }
}
function sendRaw(client, payload, options = {}) { enqueueRaw(client, payload, options); }
function sendPlayer(room, player, data) { for (const client of room.clients) if (client.player?.id === player?.id) { send(client, data); return; } }
function broadcastRoom(room, data) { const payload = encodeMessage(data); for (const client of room.clients) sendRaw(client, payload); }
module.exports = { configureOutbound, send, sendPlayer, broadcastRoom, sendRaw, getOutbound, enqueueRaw, flushOutbound, resetOutbound, constants: { CONTROL_QUEUE_BYTE_LIMIT, TOTAL_QUEUE_BYTE_LIMIT, BLOCKED_CLOSE_MS } };
