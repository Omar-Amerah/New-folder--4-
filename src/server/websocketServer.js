// RFC 6455 WebSocket framing parser/serializer, raw TCP socket upgrading, connection heartbeat, and close frame handling.

const { WORLD, ECONOMY, DEFAULT_DESIGN, DEFAULT_WIRING, MAX_MESSAGE_BYTES } = require("./config");
const { WebSocketFrameParser, readFrame } = require("./wsFrameParser");
const { PARTS } = require("./components");
const { leaveRoom } = require("./players");
const { SERVER_BUILD_SHA, PROTOCOL_VERSION } = require("./buildInfo");
const { protocolInfo } = require("./protocol");

const sockets = new Set();
let nextClientId = 1;

let messageHandler = null;
let helloSender = null;
let outboundReset = null;
const transportDiagnostics = { malformedMessages: [], handlerFailures: [] };
function boundedPush(key, value, limit = 25) {
  transportDiagnostics[key].push({ ...value, at: Date.now() });
  while (transportDiagnostics[key].length > limit) transportDiagnostics[key].shift();
}
function sanitizeStack(error) {
  return String(error?.stack || error?.message || error || "").split("\n").slice(0, 8).join("\n");
}
function sendTransportError(client, payload) {
  if (helloSender) helloSender(client, { type: "error", ...payload });
}

function configureTransport(deps = {}) {
  messageHandler = deps.handleMessage || messageHandler;
  helloSender = deps.send || helloSender;
  outboundReset = deps.resetOutbound || outboundReset;
}

function createClient(socket) {
  const client = {
    id: `c${nextClientId++}`,
    socket,
    parser: new WebSocketFrameParser(),
    state: "open",
    closeSent: false,
    room: null,
    player: null,
    joinedAt: Date.now(),
    lastMessageAt: Date.now(),
    isClosed: false,
    snapshotBaseline: { stateEpoch: 0, lastSentSeq: 0, lastFullSeq: 0, fullRequired: true, staticRevisionKnown: 0, queuedSnapshotKind: null, backpressure: "healthy" },
    heartbeat: { lastInboundAt: Date.now(), lastPongAt: Date.now(), pingIntervalMs: 10000, pongTimeoutMs: 30000, maxSilentMs: 45000, pingTimer: null }
  };

  sockets.add(client);

  socket.setNoDelay(true);
  socket.on("data", (chunk) => handleSocketData(client, chunk));
  socket.on("close", () => finalizeClient(client));
  socket.on("error", () => finalizeClient(client));
  startHeartbeat(client);

  if (helloSender) helloSender(client, {
    type: "hello",
    id: client.id,
    ...protocolInfo(),
    protocolVersion: PROTOCOL_VERSION,
    serverBuildSha: SERVER_BUILD_SHA,
    backendBuildSha: SERVER_BUILD_SHA,
    world: WORLD,
    parts: PARTS,
    economy: {
      startingMoney: ECONOMY.startingMoney,
      shipCap: ECONOMY.shipCap
    },
    defaultDesign: DEFAULT_DESIGN,
    defaultWiring: DEFAULT_WIRING
  });

  return client;
}

function handleSocketData(client, chunk) {
  if (client.isClosed || client.state !== "open") return;
  const events = client.parser.push(chunk);
  for (const event of events) {
    if (event.type === "protocolError") { closeClient(client, event.code || 1002, event.reason || "Protocol error"); return; }
    if (event.type === "fragment") continue;
    if (event.type === "close") { closeClient(client, event.code === 1005 ? 1000 : event.code, event.reason || ""); return; }
    if (event.type === "pong") { client.heartbeat.lastPongAt = Date.now(); continue; }
    if (event.type === "ping") { client.heartbeat.lastInboundAt = Date.now(); writeFrame(client.socket, event.payload, 0xA); continue; }
    if (event.type === "message") {
      const { decodeBinary } = require("./wsCodec");
      let message;
      try {
        message = decodeBinary(event.payload);
      } catch (error) {
        client.badMessageCount = (client.badMessageCount || 0) + 1;
        boundedPush("malformedMessages", { clientId: client.id, roomCode: client.room?.code || null, stage: "messagepack-decode", bytes: event.payload?.length || 0, error: String(error?.message || error).slice(0, 160), strikes: client.badMessageCount });
        sendTransportError(client, { type: "error", code: "bad-message", message: "Bad MessagePack message", stage: "messagepack-decode" });
        if (client.badMessageCount >= 3) { closeClient(client, 1003, "bad-message"); return; }
        continue;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        client.badMessageCount = (client.badMessageCount || 0) + 1;
        boundedPush("malformedMessages", { clientId: client.id, roomCode: client.room?.code || null, stage: "decoded-shape", bytes: event.payload?.length || 0, type: typeof message, strikes: client.badMessageCount });
        sendTransportError(client, { type: "error", code: "bad-message", message: "Bad MessagePack message", stage: "decoded-shape" });
        if (client.badMessageCount >= 3) { closeClient(client, 1003, "bad-message"); return; }
        continue;
      }
      client.lastMessageAt = Date.now();
      client.heartbeat.lastInboundAt = client.lastMessageAt;
      try {
        if (messageHandler) messageHandler(client, message);
      } catch (error) {
        const diagnostic = { clientId: client.id, roomCode: client.room?.code || null, routeType: typeof message.type === "string" ? message.type : null, stage: "route-dispatch", error: String(error?.message || error).slice(0, 160), stack: sanitizeStack(error) };
        boundedPush("handlerFailures", diagnostic);
        console.error("[websocket handler failure]", JSON.stringify(diagnostic));
        sendTransportError(client, { type: "error", code: "internal-error", message: "Internal server error", retryable: true, requestId: message.requestId, stage: "route-dispatch", routeType: diagnostic.routeType });
      }
    }
  }
}

function writeFrame(socket, payload, opcode = 0x1) {
  if (typeof payload === "string") payload = Buffer.from(payload, "utf8");
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = length;
  } else if (length <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }

  return socket.write(Buffer.concat([header, payload]));
}

function startHeartbeat(client) {
  const tick = () => {
    if (client.isClosed) return;
    const now = Date.now();
    const hb = client.heartbeat;
    if (now - Math.max(hb.lastInboundAt, hb.lastPongAt) > hb.maxSilentMs) { closeClient(client, 1001, 'heartbeat-timeout'); return; }
    try { writeFrame(client.socket, Buffer.from(String(now)), 0x9); } catch { closeClient(client, 1011, 'heartbeat-failed'); return; }
    hb.pingTimer = setTimeout(tick, hb.pingIntervalMs); hb.pingTimer.unref?.();
  };
  client.heartbeat.pingTimer = setTimeout(tick, client.heartbeat.pingIntervalMs); client.heartbeat.pingTimer.unref?.();
}

function closeClient(client, code, reason) {
  if (client.isClosed || client.closeSent) return;
  client.state = "closing";
  client.closeSent = true;

  let reasonBuffer = Buffer.from(reason || "");
  if (reasonBuffer.length > 123) reasonBuffer = reasonBuffer.subarray(0, 123);
  const payload = Buffer.alloc(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  try {
    writeFrame(client.socket, payload, 0x8);
  } catch {
    // The socket may already be gone.
  }
  setTimeout(() => finalizeClient(client), 25).unref?.();
  try { client.socket.end(); } catch { client.socket.destroy(); }
}

function finalizeClient(client) {
  if (client.isClosed) return;
  client.isClosed = true;
  client.state = "closed";
  client.parser?.reset?.();
  sockets.delete(client);
  if (client.heartbeat?.pingTimer) clearTimeout(client.heartbeat.pingTimer);
  try { if (outboundReset) outboundReset(client); } catch {}
  leaveRoom(client);
}

module.exports = {
  sockets,
  configureTransport,
  createClient,
  handleSocketData,
  readFrame,
  writeFrame,
  closeClient,
  finalizeClient,
  startHeartbeat,
  transportDiagnostics
};
