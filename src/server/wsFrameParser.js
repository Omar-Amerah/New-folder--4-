"use strict";

const { TextDecoder } = require("util");
const { MAX_MESSAGE_BYTES } = require("./config");

const MAX_CONTROL_PAYLOAD_BYTES = 125;
const DEFAULT_MAX_UNREAD_BUFFER_BYTES = MAX_MESSAGE_BYTES * 4;
const CLOSE_RESERVED = new Set([1004, 1005, 1006, 1015]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function isValidCloseCode(code) {
  if (code < 1000 || code >= 5000) return false;
  if (CLOSE_RESERVED.has(code)) return false;
  if (code >= 1016 && code <= 2999) return false;
  return true;
}

class WebSocketFrameParser {
  constructor(options = {}) {
    this.maxMessageBytes = options.maxMessageBytes || MAX_MESSAGE_BYTES;
    this.maxFrameBytes = options.maxFrameBytes || this.maxMessageBytes;
    this.maxUnreadBytes = options.maxUnreadBytes || DEFAULT_MAX_UNREAD_BUFFER_BYTES;
    this.reset();
  }

  reset() {
    this.chunks = [];
    this.bufferedBytes = 0;
    this.peakBufferedBytes = 0;
    this.fragmentOpcode = 0;
    this.fragmentBytes = 0;
    this.peakFragmentBytes = 0;
    this.fragments = [];
    this.closed = false;
  }

  diagnostics() {
    return {
      bufferedBytes: this.bufferedBytes,
      peakBufferedBytes: this.peakBufferedBytes,
      fragmentBytes: this.fragmentBytes,
      peakFragmentBytes: this.peakFragmentBytes,
      fragmentCount: this.fragments.length,
      fragmented: this.fragmentOpcode !== 0
    };
  }

  push(chunk) {
    if (this.closed) return [];
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    if (chunk.length) {
      this.chunks.push(chunk);
      this.bufferedBytes += chunk.length;
      this.peakBufferedBytes = Math.max(this.peakBufferedBytes, this.bufferedBytes);
    }
    if (this.bufferedBytes > this.maxUnreadBytes) return [this.protocolError(1009, "Unread buffer too large")];
    const events = [];
    while (!this.closed) {
      const event = this.readOne();
      if (!event) break;
      events.push(event);
      if (event.type === "protocolError") break;
    }
    return events;
  }

  protocolError(code, reason) {
    this.closed = true;
    return { type: "protocolError", code, reason };
  }

  peek(n) {
    if (this.bufferedBytes < n) return null;
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    for (const c of this.chunks) {
      const take = Math.min(c.length, n - offset);
      c.copy(out, offset, 0, take);
      offset += take;
      if (offset === n) break;
    }
    return out;
  }

  consume(n) {
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (n > 0) {
      const c = this.chunks[0];
      const take = Math.min(c.length, n);
      c.copy(out, offset, 0, take);
      offset += take;
      n -= take;
      this.bufferedBytes -= take;
      if (take === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(take);
    }
    return out;
  }

  readOne() {
    const h2 = this.peek(2);
    if (!h2) return null;
    const first = h2[0], second = h2[1];
    const fin = (first & 0x80) !== 0;
    const rsv = first & 0x70;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let header = 2;
    const control = opcode >= 0x8;
    if (rsv) return this.protocolError(1002, "RSV bits unsupported");
    if (![0x0,0x1,0x2,0x8,0x9,0xA].includes(opcode)) return this.protocolError(1002, "Unsupported opcode");
    if (!masked) return this.protocolError(1002, "Client frames must be masked");
    if (control && !fin) return this.protocolError(1002, "Control frames must not be fragmented");
    if (length === 126) {
      const b = this.peek(4); if (!b) return null;
      length = b.readUInt16BE(2); header = 4;
      if (length < 126) return this.protocolError(1002, "Non-minimal extended length");
    } else if (length === 127) {
      const b = this.peek(10); if (!b) return null;
      const high = b.readUInt32BE(2), low = b.readUInt32BE(6); header = 10;
      if (high & 0x80000000) return this.protocolError(1002, "Invalid 64-bit length");
      if (high !== 0 || low > Number.MAX_SAFE_INTEGER) return this.protocolError(1009, "Frame too large");
      length = low;
      if (length <= 65535) return this.protocolError(1002, "Non-minimal extended length");
    }
    if (control && length > MAX_CONTROL_PAYLOAD_BYTES) return this.protocolError(1002, "Control frame too large");
    if (!control && length > this.maxFrameBytes) return this.protocolError(1009, "Frame too large");
    if (this.bufferedBytes < header + 4 + length) return null;
    this.consume(header);
    const mask = this.consume(4);
    const payload = this.consume(length);
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    if (opcode === 0x8) return this.validateClose(payload);
    if (opcode === 0x9) return { type: "ping", payload };
    if (opcode === 0xA) return { type: "pong", payload };
    if (opcode === 0x1) return this.protocolError(1003, "MessagePack binary frames required");
    return this.handleData(opcode, fin, payload);
  }

  handleData(opcode, fin, payload) {
    if (opcode === 0x0) {
      if (!this.fragmentOpcode) return this.protocolError(1002, "Continuation without fragmented message");
    } else if (!fin) {
      if (this.fragmentOpcode) return this.protocolError(1002, "New data frame during fragmentation");
      this.fragmentOpcode = opcode;
    } else if (this.fragmentOpcode) return this.protocolError(1002, "New data frame during fragmentation");

    if (this.fragmentOpcode || opcode === 0x0) {
      if (this.fragmentBytes + payload.length > this.maxMessageBytes) return this.protocolError(1009, "Message too large");
      this.fragments.push(payload); this.fragmentBytes += payload.length; this.peakFragmentBytes = Math.max(this.peakFragmentBytes, this.fragmentBytes);
      if (!fin) return { type: "fragment", opcode, bytes: payload.length, final: false };
      const message = Buffer.concat(this.fragments, this.fragmentBytes);
      this.fragments = []; this.fragmentBytes = 0; this.fragmentOpcode = 0;
      return { type: "message", opcode: 0x2, payload: message, fragmented: true };
    }
    if (payload.length > this.maxMessageBytes) return this.protocolError(1009, "Message too large");
    return { type: "message", opcode: 0x2, payload, fragmented: false };
  }

  validateClose(payload) {
    if (payload.length === 1) return this.protocolError(1002, "Malformed close payload");
    let code = 1005, reason = "";
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!isValidCloseCode(code)) return this.protocolError(1002, "Invalid close code");
      try { reason = utf8Decoder.decode(payload.subarray(2)); } catch { return this.protocolError(1007, "Invalid close reason UTF-8"); }
    }
    return { type: "close", code, reason };
  }
}

function readFrame(buffer, options = {}) {
  const maxMessageBytes = options.maxMessageBytes || MAX_MESSAGE_BYTES;
  if (buffer.length < 2) return null;
  const first = buffer[0], second = buffer[1];
  const fin = (first & 0x80) !== 0, rsv = first & 0x70, opcode = first & 0x0f, masked = (second & 0x80) !== 0;
  let length = second & 0x7f, offset = 2;
  const control = opcode >= 0x8;
  if (rsv) return { error: true, closeCode: 1002, reason: 'RSV bits unsupported' };
  if (![0x1,0x2,0x8,0x9,0xA].includes(opcode)) return { error: true, closeCode: 1002, reason: 'Unsupported opcode' };
  if (!fin) return { error: true, closeCode: 1002, reason: 'Fragmentation unsupported in readFrame helper' };
  if (!masked) return { error: true, closeCode: 1002, reason: 'Client frames must be masked' };
  if (length === 126) { if (buffer.length < 4) return null; length = buffer.readUInt16BE(2); offset = 4; if (length < 126) return { error: true, closeCode: 1002, reason: 'Non-minimal extended length' }; }
  else if (length === 127) { if (buffer.length < 10) return null; const high=buffer.readUInt32BE(2), low=buffer.readUInt32BE(6); if (high & 0x80000000) return { error: true, closeCode: 1002, reason: 'Invalid 64-bit length' }; if (high !== 0) return { error: true, closeCode: 1009, reason: 'Frame too large' }; length=low; offset=10; if (length <= 65535) return { error: true, closeCode: 1002, reason: 'Non-minimal extended length' }; }
  if (control && length > MAX_CONTROL_PAYLOAD_BYTES) return { error: true, closeCode: 1002, reason: 'Control frame too large' };
  if (!control && length > maxMessageBytes) return { error: true, closeCode: 1009, reason: 'Frame too large' };
  if (buffer.length < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4); offset += 4;
  const payload = Buffer.alloc(length);
  for (let i=0;i<length;i++) payload[i] = buffer[offset+i] ^ mask[i%4];
  if (opcode === 0x8) {
    if (length === 1) return { error: true, closeCode: 1002, reason: 'Malformed close payload' };
    if (length >= 2) {
      const code = payload.readUInt16BE(0);
      if (!isValidCloseCode(code)) return { error: true, closeCode: 1002, reason: 'Invalid close code' };
      try { utf8Decoder.decode(payload.subarray(2)); } catch { return { error: true, closeCode: 1007, reason: 'Invalid close reason UTF-8' }; }
    }
  }
  return { opcode, payload, bytesRead: offset + length };
}

module.exports = { WebSocketFrameParser, readFrame, isValidCloseCode, MAX_CONTROL_PAYLOAD_BYTES };
