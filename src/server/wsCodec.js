// WebSocket payload codec. Outbound game data (snapshots, lobby state, notices)
// is serialized with MessagePack — a compact binary format that is markedly
// smaller and faster to (de)serialize than JSON for the numeric-heavy snapshot
// arrays broadcast many times per second. Inbound frames are decoded by opcode:
// binary (0x2) as MessagePack, text (0x1) as JSON, so older/JSON clients still work.

const msgpack = require("@msgpack/msgpack");

// Returns a Node Buffer so it slots straight into the frame writer.
function encodeMessage(obj) {
  return Buffer.from(msgpack.encode(obj));
}

function decodeBinary(buffer) {
  return msgpack.decode(buffer);
}

function decodeText(buffer) {
  return JSON.parse(buffer.toString("utf8"));
}

module.exports = { encodeMessage, decodeBinary, decodeText };
