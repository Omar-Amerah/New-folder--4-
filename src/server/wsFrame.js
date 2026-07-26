"use strict";

// Single RFC 6455 server-frame writer, shared by the transport and the
// outbound queue so the two cannot drift apart.
//
// Server-to-client frames are never masked, so the bytes prepended to a payload
// depend only on its length and the opcode. A broadcast hands the *same* payload
// buffer to every recipient, which previously meant allocating and memcpy-ing a
// full header+payload buffer once per client. Data frames are therefore framed
// once and reused: for a 30 KB snapshot going to 8 clients that removes 7 copies
// of 30 KB per broadcast.
//
// Only the binary data opcode is cached. Control frames (ping/pong/close) carry
// per-client payloads and are tiny, so caching them would only add bookkeeping.
const BINARY_OPCODE = 0x2;
const frameCache = new WeakMap();

function toBuffer(payload) {
  if (typeof payload === "string") return Buffer.from(payload, "utf8");
  if (Buffer.isBuffer(payload)) return payload;
  return Buffer.from(payload);
}

function buildFrame(payload, opcode) {
  const length = payload.length;
  const headerLength = length < 126 ? 2 : length <= 65535 ? 4 : 10;
  const frame = Buffer.allocUnsafe(headerLength + length);
  frame[0] = 0x80 | opcode;
  if (headerLength === 2) frame[1] = length;
  else if (headerLength === 4) { frame[1] = 126; frame.writeUInt16BE(length, 2); }
  else { frame[1] = 127; frame.writeUInt32BE(0, 2); frame.writeUInt32BE(length, 6); }
  payload.copy(frame, headerLength);
  return frame;
}

// Payload buffers produced by the codec are treated as immutable once handed to
// the outbound path, which is what makes reuse safe. The WeakMap entry dies with
// the payload, so nothing is retained beyond the send.
function frameMessage(payload, opcode = BINARY_OPCODE) {
  const buffer = toBuffer(payload);
  if (opcode !== BINARY_OPCODE) return buildFrame(buffer, opcode);
  const cached = frameCache.get(buffer);
  if (cached) return cached;
  const frame = buildFrame(buffer, opcode);
  frameCache.set(buffer, frame);
  return frame;
}

function writeFrameTo(socket, payload, opcode = BINARY_OPCODE) {
  return socket.write(frameMessage(payload, opcode));
}

module.exports = { BINARY_OPCODE, frameMessage, writeFrameTo };
