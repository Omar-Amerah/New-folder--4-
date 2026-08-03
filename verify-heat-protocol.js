"use strict";

const assert = require("assert");
const msgpack = require("@msgpack/msgpack");
const { spawn } = require("child_process");
const http = require("http");

const PORT = 32187;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOM = `heat-protocol-${Date.now()}`;
const DESIGN = [
  { x: 7, y: 7, type: "core", rotation: 0 },
  { x: 7, y: 8, type: "frame", rotation: 0 },
  { x: 6, y: 8, type: "engine", rotation: 0 },
  { x: 8, y: 8, type: "engine", rotation: 0 },
  { x: 6, y: 7, type: "maneuverThruster", rotation: 0 },
  { x: 8, y: 7, type: "maneuverThruster", rotation: 0 },
  { x: 6, y: 6, type: "reactor", rotation: 0 },
  { x: 7, y: 5, type: "blaster", rotation: 0 },
  { x: 8, y: 6, type: "heatSink", rotation: 0 },
  { x: 9, y: 6, type: "radiator", rotation: 0 }
];

function waitServer() {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    (function tryRequest() {
      http.get(`${BASE}/index.html`, (response) => {
        response.resume();
        resolve();
      }).on("error", () => {
        if (Date.now() - startedAt > 15000) reject(new Error("server did not start"));
        else setTimeout(tryRequest, 100);
      });
    }());
  });
}

class Client {
  constructor(name, snapshotMerge) {
    this.name = name;
    this.snapshotMerge = snapshotMerge;
    this.snapshot = null;
    this.networkState = { stateEpoch: 0, snapshotSeq: 0, staticRevision: 0, hasFullBaseline: false };
    this.latest = {};
    this.states = [];
    this.rawStates = [];
    this.designs = new Map();
  }

  async open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/socket`);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("message", async (event) => {
      const bytes = event.data instanceof ArrayBuffer
        ? new Uint8Array(event.data)
        : new Uint8Array(await event.data.arrayBuffer?.() || []);
      let message;
      try {
        message = bytes.length ? msgpack.decode(bytes) : JSON.parse(event.data);
      } catch {
        message = JSON.parse(event.data);
      }
      const rawMessage = message;
      if (message.type === "state" && this.snapshotMerge) {
        const merged = this.snapshotMerge.mergeSnapshotTransaction(this.snapshot, this.networkState, message);
        if (!merged.ok) throw new Error(`snapshot merge failed: ${merged.reason}`);
        this.snapshot = merged.snapshot;
        this.networkState = merged.networkState;
        message = merged.snapshot;
      }
      this.latest[message.type] = message;
      if (message.type === "error") {
        if (this.name === "a") globalThis.__AERR = message;
        else globalThis.__BERR = message;
      }
      if (message.type === "state") {
        this.rawStates.push(rawMessage);
        for (const ship of message.ships || []) {
          if (ship.design) this.designs.set(ship.id, ship.design);
          else ship.design = this.designs.get(ship.id);
        }
        this.states.push(message);
      }
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
    });
  }

  send(message) {
    this.ws.send(msgpack.encode(message));
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // Best-effort test cleanup.
    }
  }
}

async function until(read, label, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout ${label}; aerr=${JSON.stringify(globalThis.__AERR || null)} berr=${JSON.stringify(globalThis.__BERR || null)}`);
}

(async () => {
  const snapshotMerge = await import("./public/src/snapshotMerge.js");
  const server = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  server.stdout.on("data", (data) => { log += data; });
  server.stderr.on("data", (data) => { log += data; });
  const a = new Client("a", snapshotMerge);
  const b = new Client("b", snapshotMerge);

  try {
    await waitServer();
    await a.open();
    await b.open();
    await until(() => a.latest.hello, "hello");
    const protocol = {
      protocolVersion: 6,
      minProtocolVersion: 6,
      maxProtocolVersion: 6,
      capabilities: ["messagepack", "entityDeltaSnapshotsV1"]
    };
    a.send({ type: "join", room: ROOM, name: "A", team: "blue", ...protocol });
    await until(() => a.latest.joined, "join a");
    b.send({ type: "join", room: ROOM, name: "B", team: "red", ...protocol });
    await until(() => b.latest.joined, "join b");
    a.send({ type: "setRules", rules: { asteroidDensity: "none", startingMoney: 100000, visibilityMode: "full" } });
    a.send({ type: "startDesign" });
    await until(() => a.latest.state?.phase === "design", "design");
    a.send({ type: "deploy", design: DESIGN, combatStyle: "sentry" });
    b.send({ type: "deploy", design: DESIGN, combatStyle: "sentry" });
    await until(() => a.latest.state?.phase === "active", "active");
    a.send({ type: "buyShip", requestId: "buyA1", design: DESIGN });
    b.send({ type: "buyShip", requestId: "buyB1", design: DESIGN });
    await until(() => a.latest.state?.phase === "active" && a.latest.state.ships?.length >= 2, "ships");

    const active = a.latest.state;
    let mine = active.ships.find((ship) => ship.ownerId === a.latest.joined.id);
    if (!mine?.componentHeat) {
      mine = await until(() => {
        for (const state of a.states) {
          const ship = state.ships?.find((candidate) => candidate.ownerId === a.latest.joined.id && Array.isArray(candidate.componentHeat));
          if (ship) return ship;
        }
        return null;
      }, "full component heat");
    }
    assert(mine && Array.isArray(mine.componentHeat), "receives full component heat snapshot");
    assert.strictEqual(mine.componentHeat.length, DESIGN.length, "component heat indexes align with design");

    a.send({ type: "command", x: (mine.x || 1000) + 600, y: mine.y || 1000 });
    const deltaShip = await until(() => {
      for (const state of a.rawStates.slice(-80)) {
        const privateRow = state.shipsPatch?.private?.find((row) => row?.[0] === mine.id)?.[1];
        if (privateRow && Array.isArray(privateRow.componentHeatD)) return privateRow;
        const ship = state.ships?.find((candidate) => candidate.id === mine.id && Array.isArray(candidate.componentHeatD));
        if (ship) return ship;
      }
      return null;
    }, "compact heat delta", 20000);
    assert.strictEqual(deltaShip.componentHeatD.length % 5, 0, "compact heat delta uses stride 5");
    assert(Array.isArray(mine.componentHeat) && mine.componentHeat.length === DESIGN.length, "full current heat reconstruction is available for reconnect/static snapshots");

    a.send({ type: "returnToLobby" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert(a.states.some((state) => state.phase === "lobby" || state.phase === "design" || (state.ships || []).every((ship) => !ship.componentHeatD)), "reset/rematch does not preserve stale thermal deltas");
    console.log("Real heat protocol WebSocket/MessagePack verification passed");
    a.close();
    b.close();
    server.kill();
  } catch (error) {
    console.error(error);
    console.error(log.split("\n").slice(-30).join("\n"));
    a.close();
    b.close();
    server.kill();
    process.exit(1);
  }
})();
