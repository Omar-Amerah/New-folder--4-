// RFC 6455 WebSocket framing parser/serializer, raw TCP socket upgrading, connection heartbeat, and close frame handling.

const { WORLD, ECONOMY, DEFAULT_DESIGN, MAX_MESSAGE_BYTES } = require("./config");
const MAX_UNREAD_BUFFER_BYTES = MAX_MESSAGE_BYTES * 4;
const MAX_CONTROL_PAYLOAD_BYTES = 125;
const { PARTS } = require("./components");
const { leaveRoom } = require("./players");
const { SERVER_BUILD_SHA, PROTOCOL_VERSION } = require("./buildInfo");
const { protocolInfo } = require("./protocol");

const sockets = new Set();
let nextClientId = 1;

function createClient(socket) {
  const client = {
    id: `c${nextClientId++}`,
    socket,
    buffer: Buffer.alloc(0),
    room: null,
    player: null,
    joinedAt: Date.now(),
    lastMessageAt: Date.now(),
    isClosed: false
  };

  sockets.add(client);

  socket.setNoDelay(true);
  socket.on("data", (chunk) => handleSocketData(client, chunk));
  socket.on("close", () => finalizeClient(client));
  socket.on("error", () => finalizeClient(client));

  const { send } = require("./messages");
  send(client, {
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
    defaultDesign: DEFAULT_DESIGN
  });

  return client;
}

function handleSocketData(client, chunk) {
  if (client.isClosed) return;
  client.buffer = Buffer.concat([client.buffer, chunk]);

  if (client.buffer.length > MAX_UNREAD_BUFFER_BYTES) {
    closeClient(client, 1009, "Connection buffer too large");
    return;
  }

  const { send, handleMessage } = require("./messages");

  while (client.buffer.length >= 2) {
    const frame = readFrame(client.buffer);
    if (!frame) return;
    if (frame.error) {
      closeClient(client, frame.closeCode || 1002, frame.reason || "Protocol error");
      return;
    }
    client.buffer = client.buffer.subarray(frame.bytesRead);

    if (frame.opcode === 0x8) {
      closeClient(client, 1000, "Bye");
      return;
    }

    if (frame.opcode === 0xA) continue;

    if (frame.opcode === 0x9) {
      writeFrame(client.socket, frame.payload, 0xA);
      continue;
    }

    // Production client traffic is MessagePack binary only. Text JSON is rejected.
    if (frame.opcode !== 0x2) { closeClient(client, 1003, "MessagePack binary frames required"); return; }

    try {
      const { decodeBinary } = require("./wsCodec");
      const message = decodeBinary(frame.payload);
      client.lastMessageAt = Date.now();
      handleMessage(client, message);
    } catch {
      send(client, { type: "error", code: "bad-message", message: "Bad MessagePack message" });
    }
  }
}

function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const fin = (first & 0x80) !== 0;
  const rsv = first & 0x70;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  const control = opcode >= 0x8;
  const known = opcode === 0x1 || opcode === 0x2 || opcode === 0x8 || opcode === 0x9 || opcode === 0xA;

  if (rsv !== 0) return { error: true, closeCode: 1002, reason: 'RSV bits unsupported' };
  if (!known || opcode === 0x0 || (opcode >= 0x3 && opcode <= 0x7) || opcode >= 0xB) return { error: true, closeCode: 1002, reason: 'Unsupported opcode' };
  if (!fin) return { error: true, closeCode: 1002, reason: 'Fragmentation unsupported' };
  if (!masked) return { error: true, closeCode: 1002, reason: 'Client frames must be masked' };

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    if (length < 126) return { error: true, closeCode: 1002, reason: 'Non-minimal extended length' };
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    if (high !== 0 || low > MAX_MESSAGE_BYTES) return { error: true, closeCode: 1009, reason: 'Frame too large' };
    if (low <= 65535) return { error: true, closeCode: 1002, reason: 'Non-minimal extended length' };
    length = low;
    offset += 8;
  }

  if (control && length > MAX_CONTROL_PAYLOAD_BYTES) return { error: true, closeCode: 1002, reason: 'Control frame too large' };
  if (!control && length > MAX_MESSAGE_BYTES) return { error: true, closeCode: 1009, reason: 'Frame too large' };
  if (buffer.length < offset + 4) return null;
  if (buffer.length < offset + 4 + length) return null;

  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) payload[i] = buffer[offset + i] ^ mask[i % 4];
  if (opcode === 0x8) {
    if (length === 1) return { error: true, closeCode: 1002, reason: 'Malformed close payload' };
    if (length >= 2) {
      const code = payload.readUInt16BE(0);
      if (code < 1000 || [1004,1005,1006,1015].includes(code) || code >= 5000) return { error: true, closeCode: 1002, reason: 'Invalid close code' };
    }
  }
  return { opcode, payload, bytesRead: offset + length };
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

  socket.write(Buffer.concat([header, payload]));
}

function closeClient(client, code, reason) {
  if (client.isClosed) return;
  finalizeClient(client);

  const reasonBuffer = Buffer.from(reason || "");
  const payload = Buffer.alloc(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  try {
    writeFrame(client.socket, payload, 0x8);
  } catch {
    // The socket may already be gone.
  }
  client.socket.destroy();
}

function finalizeClient(client) {
  if (client.isClosed) return;
  client.isClosed = true;
  sockets.delete(client);
  leaveRoom(client);
}

module.exports = {
  sockets,
  createClient,
  handleSocketData,
  readFrame,
  writeFrame,
  closeClient,
  finalizeClient
};
