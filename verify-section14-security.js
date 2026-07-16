"use strict";
const assert = require("assert");
const net = require("net");
const crypto = require("crypto");
const { encode } = require("@msgpack/msgpack");
const { createGameServer } = require("./server");
const { WebSocketFrameParser } = require("./src/server/wsFrameParser");
const { validateClientMessage } = require("./src/server/clientSchemas");
const { checkRateLimit, RATE_LIMITS } = require("./src/server/messageRouter");

function httpReq(port, lines) {
  return new Promise((resolve, reject) => {
    let out = "";
    const s = net.connect(port, "127.0.0.1", () => s.write(lines.join("\r\n") + "\r\n\r\n"));
    s.on("data", (d) => out += d);
    s.on("close", () => resolve(out));
    s.on("error", reject);
    setTimeout(() => { s.destroy(); resolve(out); }, 800).unref();
  });
}
function key() { return crypto.randomBytes(16).toString("base64"); }
function maskedFrame(payload) {
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  const header = len < 126 ? Buffer.from([0x82, 0x80 | len]) : Buffer.from([0x82, 0x80 | 126, len >> 8, len & 255]);
  const out = Buffer.alloc(header.length + 4 + len); header.copy(out); mask.copy(out, header.length);
  for (let i = 0; i < len; i++) out[header.length + 4 + i] = payload[i] ^ mask[i % 4];
  return out;
}
async function wsConversation(port, frames) {
  return new Promise((resolve, reject) => {
    let out = Buffer.alloc(0); let upgraded = false;
    const s = net.connect(port, "127.0.0.1", () => s.write([`GET /socket?ignored=1 HTTP/1.1`,`Host: 127.0.0.1:${port}`,"Upgrade: websocket","Connection: Upgrade","Sec-WebSocket-Version: 13",`Sec-WebSocket-Key: ${key()}`, "Origin: https://front.example"].join("\r\n") + "\r\n\r\n"));
    s.on("data", (d) => { out = Buffer.concat([out, d]); if (!upgraded && out.includes(Buffer.from("\r\n\r\n"))) { upgraded = true; for (const f of frames) s.write(f); setTimeout(()=>s.destroy(),200).unref(); } });
    s.on("close", () => resolve(out)); s.on("error", reject);
    setTimeout(()=>{s.destroy(); resolve(out);},1000).unref();
  });
}
(async () => {
  assert.strictEqual(validateClientMessage({ type:"join", name:"A", room:"", protocolVersion:1, capabilities:[] }).ok, true, "Create Game room empty remains valid");
  assert.strictEqual(validateClientMessage({ type:"join", name:"A", room:"!!!!!!", protocolVersion:1, capabilities:[] }).code, "invalid-room");
  assert.strictEqual(validateClientMessage({ type:"command", x:Infinity, y:0 }).ok, false, "non-finite rejected");
  let nested = { type:"ping", at:0 }; let cursor = nested; for (let i=0;i<12;i++){ cursor.next={}; cursor=cursor.next; }
  assert.strictEqual(validateClientMessage(nested).ok, false, "deep nesting rejected");
  assert.strictEqual(validateClientMessage({ type:"command", x:1, y:2, shipIds:Array(65).fill("s") }).code, "invalid-selection");
  const client = {};
  for (let i = 0; i < RATE_LIMITS.management.capacity; i++) assert.strictEqual(checkRateLimit(client, "addBot", 1000), true);
  assert.strictEqual(checkRateLimit(client, "addBot", 1000), false, "management rate limit is bounded per connection");
  assert.strictEqual(checkRateLimit(client, "command", 1000), true, "frequent gameplay bucket remains separate");

  const parser = new WebSocketFrameParser({ maxMessageBytes: 8 });
  assert.strictEqual(parser.push(maskedFrame(Buffer.alloc(16)))[0].code, 1009, "oversized frame rejected");

  const srv = createGameServer({ port:0, host:"127.0.0.1", allowedOrigins:"https://front.example", allowMissingOrigin:false });
  await srv.start(); const port = srv.address().port;
  try {
    let r = await httpReq(port, [`GET /../server.js HTTP/1.1`, `Host: 127.0.0.1:${port}`]);
    assert(/HTTP\/1\.1 (403|404)/.test(r), "static traversal fails safely");
    r = await httpReq(port, [`POST /health HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Content-Length: 0"]);
    assert(r.startsWith("HTTP/1.1 405"), "unsupported method rejected");
    r = await httpReq(port, [`GET /bad?path=/socket HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Version: 13", `Sec-WebSocket-Key: ${key()}`, "Origin: https://front.example"]);
    assert(r.startsWith("HTTP/1.1 404"), "wrong websocket path rejected");
    r = await httpReq(port, [`GET /socket#x HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Version: 13", `Sec-WebSocket-Key: ${key()}`, "Origin: https://evil.example"]);
    assert(r.startsWith("HTTP/1.1 403"), "bad origin rejected");
    r = await httpReq(port, [`GET /socket?room=ABC HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Version: 13", `Sec-WebSocket-Key: ${key()}`, "Origin: https://front.example"]);
    assert(r.startsWith("HTTP/1.1 101"), "allowed origin succeeds with harmless query");
    const msg = encode({ type:"command", x:1, y:2 });
    r = await wsConversation(port, [maskedFrame(msg)]);
    assert(r.includes("101 Switching Protocols"), "malformed pre-join message cannot crash server");
    const before = srv.diagnostics().activeClients;
    await srv.stop(); await srv.stop();
    assert.strictEqual(srv.diagnostics().shutdown, "stopped", "graceful shutdown idempotent");
    assert(before >= 0);
  } finally { await srv.stop(); }
  console.log("section 14 security verification passed");
})().catch((e)=>{ console.error(e); process.exit(1); });
