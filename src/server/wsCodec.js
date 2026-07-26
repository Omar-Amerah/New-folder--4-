// WebSocket payload codec. Outbound game data (snapshots, lobby state, notices)
// is serialized with MessagePack — a compact binary format that is markedly
// smaller and faster to (de)serialize than JSON for the numeric-heavy snapshot
// arrays broadcast many times per second. Inbound frames are decoded by opcode:
// binary (0x2) as MessagePack, text (0x1) as JSON, so older/JSON clients still work.

const msgpack = require("@msgpack/msgpack");

// Returns a Node Buffer so it slots straight into the frame writer.
// `msgpack.encode` hands back a Uint8Array that it does not retain, so the
// Buffer is created as a view over the same memory rather than with
// `Buffer.from(uint8array)`, which would copy the whole payload on every
// encode — snapshots are the largest and most frequent messages on the wire.
function encodeMessage(obj) {
  const encoded = msgpack.encode(obj);
  return Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
}

function decodeBinary(buffer) {
  return msgpack.decode(buffer);
}

function decodeText(buffer) {
  return JSON.parse(buffer.toString("utf8"));
}

module.exports = { encodeMessage, decodeBinary, decodeText };
