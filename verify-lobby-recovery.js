"use strict";
// Lobby lifecycle regressions over the real WebSocket protocol:
//   1. Creating a game with a pilot name that matches another room's admin
//      must NOT close that other room (names are not identity).
//   2. A stale resume token is rejected with code "credential-expired" so the
//      client clears its stored credential instead of looping on it forever.
//   3. When the last not-ready player's reconnect grace expires during the
//      design phase, the match starts for the remaining ready players.
//   4. A kicked player's name stays banned from the room.
const assert = require("assert");
const { spawn } = require("child_process");
const { encode, decode } = require("@msgpack/msgpack");
const { DEFAULT_DESIGN } = require("./src/server/config");

const PORT = Number(process.env.TEST_PORT || 5698);
const URL = `ws://127.0.0.1:${PORT}/socket`;
const GRACE_MS = 400;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.binaryType = "arraybuffer";
    const inbox = [];
    const waiters = [];
    ws.onmessage = (event) => {
      const msg = decode(new Uint8Array(event.data));
      const waiter = waiters.find((w) => !w.done && w.match(msg));
      if (waiter) { waiter.done = true; clearTimeout(waiter.timer); waiter.resolve(msg); }
      else { inbox.push(msg); if (inbox.length > 200) inbox.shift(); }
    };
    ws.onopen = () => resolve({
      ws,
      send: (m) => ws.send(encode({ protocolVersion: 4, minProtocolVersion: 4, maxProtocolVersion: 4, capabilities: ["messagepack", "resume-v1"], ...m })),
      wait: (match, ms = 5000) => {
        const hit = inbox.findIndex((m) => match(m));
        if (hit >= 0) return Promise.resolve(inbox.splice(hit, 1)[0]);
        return new Promise((res, rej) => {
          const waiter = { match, resolve: res, done: false };
          waiter.timer = setTimeout(() => { waiter.done = true; rej(new Error(`timeout waiting for message`)); }, ms);
          waiters.push(waiter);
        });
      },
      close: () => { try { ws.close(); } catch { /* gone */ } }
    });
    ws.onerror = () => reject(new Error("ws connect error"));
  });
}

(async () => {
  const server = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), RECONNECT_GRACE_MS: String(GRACE_MS) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const started = Date.now();
  for (;;) {
    try { const probe = await connect(); probe.close(); break; }
    catch { if (Date.now() - started > 15000) throw new Error("server did not start"); await sleep(200); }
  }

  // ---- 1. Same-name create must not close a stranger's room ----
  {
    const victim = await connect();
    victim.send({ type: "join", name: "CommonName", room: "" });
    const victimJoined = await victim.wait((m) => m.type === "joined");
    const attacker = await connect();
    attacker.send({ type: "join", name: "CommonName", room: "" });
    const attackerJoined = await attacker.wait((m) => m.type === "joined");
    assert.notStrictEqual(attackerJoined.room, victimJoined.room, "same-name creator lands in a different room");
    const closed = await victim.wait((m) => m.type === "closed", 800).catch(() => null);
    assert.strictEqual(closed, null, "victim's room must not be closed by a same-name create");
    victim.send({ type: "ping", at: 1 });
    await victim.wait((m) => m.type === "pong");
    victim.close(); attacker.close();
  }

  // ---- 2. Stale resume token rejection carries credential-expired ----
  {
    const first = await connect();
    first.send({ type: "join", name: "LockoutPilot", room: "" });
    const joined = await first.wait((m) => m.type === "joined");
    assert.ok(joined.resumeToken, "join grants a resume token");
    first.close();
    await sleep(GRACE_MS + 400); // grace expires, token invalidated server-side
    const second = await connect();
    second.send({ type: "join", name: "LockoutPilot", room: joined.room, resumeToken: joined.resumeToken });
    const rejection = await second.wait((m) => m.type === "error");
    assert.strictEqual(rejection.code, "credential-expired", "stale token rejection must carry credential-expired so the client clears it");
    second.close();
  }

  // ---- 3. Grace expiry of the last not-ready player starts the match ----
  {
    const admin = await connect();
    admin.send({ type: "join", name: "ReadyHost", room: "" });
    const adminJoined = await admin.wait((m) => m.type === "joined");
    const guest = await connect();
    guest.send({ type: "join", name: "SilentGuest", room: adminJoined.room });
    await guest.wait((m) => m.type === "joined");
    admin.send({ type: "startDesign" });
    await admin.wait((m) => m.type === "state" && m.phase === "design");
    admin.send({ type: "deploy", design: DEFAULT_DESIGN.map((part) => ({ ...part })) });
    await admin.wait((m) => m.type === "notice" && /you are ready/i.test(m.message || ""));
    guest.ws.close(); // vanish without leaving; grace timer owns the cleanup
    const startNotice = await admin.wait((m) => m.type === "notice" && /Match started/.test(m.message || ""), GRACE_MS + 4000);
    assert.ok(startNotice, "match starts once the not-ready player's grace expires");
    admin.close();
  }

  // ---- 4. Kicked names stay banned ----
  {
    const host = await connect();
    host.send({ type: "join", name: "BanHost", room: "" });
    const hostJoined = await host.wait((m) => m.type === "joined");
    const target = await connect();
    target.send({ type: "join", name: "Kickme", room: hostJoined.room });
    await target.wait((m) => m.type === "joined");
    const roster = await host.wait((m) => m.type === "state" && (m.players || []).some((p) => p.name === "Kickme"));
    const targetId = roster.players.find((p) => p.name === "Kickme").id;
    host.send({ type: "kick", targetId });
    await target.wait((m) => m.type === "kicked");
    const again = await connect();
    again.send({ type: "join", name: "Kickme", room: hostJoined.room });
    const banned = await again.wait((m) => m.type === "error");
    assert.match(banned.message || "", /kicked/i, "kicked name is refused on rejoin");
    host.close(); target.close(); again.close();
  }

  server.kill();
  console.log("Lobby recovery verification passed");
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
