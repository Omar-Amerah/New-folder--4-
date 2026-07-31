"use strict";

const { spawn } = require("child_process");
const msgpack = require("@msgpack/msgpack");

// The server now replies with MessagePack over binary frames; decode accordingly
// (still tolerate JSON text frames for robustness).
function decodeServerMessage(data) {
  if (data instanceof ArrayBuffer) return msgpack.decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return msgpack.decode(data);
  return JSON.parse(data);
}

const PORT = 3107;
const url = `ws://127.0.0.1:${PORT}/socket`;

if (typeof WebSocket === "undefined") {
  throw new Error("This verification needs the WebSocket global from Node 22+.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const server = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const output = [];
  server.stdout.on("data", (chunk) => output.push(chunk.toString()));
  server.stderr.on("data", (chunk) => output.push(chunk.toString()));

  let alpha = null;
  let beta = null;
  try {
    await waitFor(() => output.join("").includes(`http://localhost:${PORT}`), 4000, "server did not start");

    alpha = await openClient("Alpha");
    beta = await openClient("Beta");

    // Alpha uses the Create Game path: an empty room requests a generated room
    // code, then the server must confirm the join and deliver a full snapshot.
    // Alpha must complete this first (and become room admin) before Beta joins;
    // sending both concurrently races the server's processing order and can
    // make Beta the admin, failing the addBot step below.
    const createGameJoin = { type: "join", name: "Alpha", room: "", protocolVersion:5, minProtocolVersion:5, maxProtocolVersion:5, capabilities:["messagepack"] };
    if (createGameJoin.room !== "") throw new Error("Create Game join payload must send room: empty string");
    alpha.send(createGameJoin);
    const alphaJoined = await alpha.waitFor(
      (message) => message.type === "joined" && typeof message.room === "string" && /^[A-Z0-9]+$/.test(message.room),
      "alpha did not create and join a generated room"
    );
    const room = alphaJoined.room;
    await alpha.waitFor(
      (message) => message.type === "state" && message.snapshotKind === "full" && message.room === room,
      "alpha did not receive first full snapshot after Create Game"
    );
    beta.send({ type: "join", name: "Beta", room, protocolVersion:5, minProtocolVersion:5, maxProtocolVersion:5, capabilities:["messagepack"] });
    await beta.waitFor((message) => message.type === "joined" && message.room === room, "beta did not join");

    alpha.send({ type: "addBot" });

    const lobbyState = await alpha.waitFor(
      (message) => message.type === "state" && message.phase === "lobby" && message.players.length === 3 && message.players.some((player) => player.isAdmin),
      "lobby did not include admin, bot, and players"
    );
    if (!lobbyState.players.find((player) => player.name === "Alpha")?.isAdmin) {
      throw new Error("first player was not room admin");
    }

    alpha.send({ type: "setRules", rules: { startingMoney: 1100, visibilityMode: "full" } });
    await alpha.waitFor(
      (message) => message.type === "state" && message.phase === "lobby" && message.rules?.startingMoney === 1100,
      "starting money rule was not applied"
    );

    alpha.send({ type: "startDesign" });
    await alpha.waitFor(
      (message) => message.type === "state" && message.phase === "design" && message.map?.asteroids?.length,
      "room did not enter ship design with a generated map"
    );

    alpha.send({ type: "restartLobby" });
    await alpha.waitFor(
      (message) => message.type === "state" && message.phase === "lobby",
      "restart lobby did not return room to lobby"
    );

    alpha.send({ type: "startDesign" });
    await alpha.waitFor(
      (message) => message.type === "state" && message.phase === "design" && message.map?.asteroids?.length,
      "room did not re-enter ship design after lobby restart"
    );

    alpha.send({ type: "returnToLobby" });
    await alpha.waitFor(
      (message) => message.type === "state" && message.phase === "lobby",
      "return to lobby did not return room to lobby"
    );

    alpha.send({ type: "startDesign" });
    await alpha.waitFor(
      (message) => message.type === "state" && message.phase === "design" && message.map?.asteroids?.length,
      "room did not re-enter ship design after return to lobby"
    );

    alpha.send({ type: "deploy", design: makeNoEngineDesign() });
    await alpha.waitFor(
      (message) => message.type === "error" && /engine/i.test(message.message || ""),
      "engineless starting ship was not rejected"
    );

    alpha.send({ type: "deploy", design: makeExpensiveDesign() });
    await alpha.waitFor(
      (message) => message.type === "error" && /Need \$/i.test(message.message || ""),
      "unaffordable starting ship was not rejected"
    );

    alpha.send({ type: "deploy", design: makeCheapDesign() });
    beta.send({ type: "deploy", design: makeCheapDesign() });
    await alpha.waitFor(
      (message) => message.type === "state" && message.phase === "active" && message.players.length === 3,
      "match did not start"
    );
    const state = await alpha.waitFor(
      (message) => message.type === "state" && message.phase === "active" && message.players.length === 3 && message.ships.length >= 2 && message.points.length >= 3,
      "state snapshot did not include players, bot, and fleets",
      20000
    );
    const activeMap = state.map || alpha.messages.find((message) => message.type === "state" && message.map && message.room === state.room && message.stateEpoch === state.stateEpoch)?.map;
    if (!activeMap?.name || !Array.isArray(activeMap.clouds) || activeMap.clouds.length === 0) {
      throw new Error("generated map fields missing from snapshot");
    }
    alpha.send({ type: "buyShip", requestId: "buy1", design: makeCheapDesign(), count: 1 });
    await alpha.waitFor(
      (message) => message.type === "purchaseResult" && message.ok === true && message.requestId === "buy1",
      "buy ship did not succeed"
    );
    const postBuyState = await alpha.waitFor(
      (message) => message.type === "state" && message.phase === "active" && message.time > state.time && message.ships.length >= 3,
      "bought ship did not appear in active snapshot",
      20000
    );
    alpha.send({ type: "command", x: 1600, y: 950 });
    beta.send({ type: "command", x: 1600, y: 950 });
    if (!state.players.some((player) => player.name === "Alpha") || !state.players.some((player) => player.name === "Beta")) {
      throw new Error("players missing from snapshot");
    }
    const betaState = state.players.find((player) => player.name === "Beta");
    if (!betaState?.id) {
      throw new Error("beta player id missing from active snapshot");
    }
    alpha.send({ type: "kick", targetId: betaState.id });
    await alpha.waitFor(
      (message) => message.type === "error" && /before the match starts/i.test(message.message || ""),
      "active match kick was not rejected"
    );
    const postKickState = await alpha.waitFor(
      (message) => message.type === "state" && message.phase === "active" && message.time > state.time && message.players.some((player) => player.name === "Beta"),
      "non-admin was removed by an active-match kick"
    );
    if (beta.messages.some((message) => message.type === "kicked")) {
      throw new Error("beta received a kicked message during active match");
    }
    if (!postKickState.players.some((player) => player.name === "Beta")) {
      throw new Error("beta missing after rejected kick");
    }
    if (!state.players.some((player) => player.isBot)) {
      throw new Error("bot missing from snapshot");
    }
    const fullActiveState = alpha.messages.find((message) => message.type === "state" && message.phase === "active" && message.snapshotKind === "full" && message.players.some((player) => player.name === "Alpha"));
    const alphaState = fullActiveState && fullActiveState.players.find((player) => player.name === "Alpha");
    const postBuyAlpha = postBuyState.players.find((player) => player.name === "Alpha");
    if (!alphaState || typeof alphaState.money !== "number" || typeof alphaState.income !== "number" || !alphaState.stats?.unitCost) {
      throw new Error("economy fields missing from snapshot");
    }
    if (typeof postBuyAlpha.money !== "number") {
      throw new Error("post-buy economy fields missing from snapshot");
    }
    const moneyBefore = postBuyAlpha.money;
    // Wait for a snapshot after the purchase where Alpha's money has grown.
    const laterState = await alpha.waitFor(
      (message) => {
        if (message.type !== "state" || message.phase !== "active" || !(message.time > postBuyState.time)) return false;
        const player = message.players.find((candidate) => candidate.name === "Alpha");
        return player && player.money > moneyBefore;
      },
      "money did not increase after income tick",
      20000
    );
    const laterAlpha = laterState.players.find((player) => player.name === "Alpha");
    if (laterAlpha.income <= 0) {
      throw new Error("income was not positive");
    }

    // Baseline smoke: after movement commands and further simulation ticks, a
    // later snapshot must still carry valid finite ship state (no NaN/Infinity
    // leaking out of the movement/combat simulation).
    if (!Array.isArray(laterState.ships) || laterState.ships.length === 0) {
      throw new Error("later snapshot lost its ships");
    }
    for (const ship of laterState.ships) {
      for (const field of ["x", "y", "vx", "vy", "angle", "hp"]) {
        if (!Number.isFinite(ship[field])) {
          throw new Error(`ship ${ship.id} field ${field} is not finite after movement command`);
        }
      }
    }

    alpha.close();
    beta.close();
    console.log("runtime verification passed");
  } catch (error) {
    console.error("Alpha messages:", alpha ? alpha.messages : "none");
    console.error("Beta messages:", beta ? beta.messages : "none");
    console.error("Server output before crash:");
    console.error(output.join(""));
    throw error;
  } finally {
    server.kill();
  }
}

function openClient(name) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const messages = [];
    const waiters = [];
    const timeout = setTimeout(() => reject(new Error(`${name} connection timeout`)), 2500);

    const client = {
      defaultDesign: null,
      messages,
      send(data) {
        socket.send(msgpack.encode(data));
      },
      close() {
        socket.close();
      },
      waitFor(predicate, label, timeoutMs = 5000) {
        const existing = messages.find(predicate);
        if (existing) return Promise.resolve(existing);
        return new Promise((innerResolve, innerReject) => {
          const waiter = { predicate, resolve: innerResolve, reject: innerReject };
          waiters.push(waiter);
          setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            innerReject(new Error(label));
          }, timeoutMs).unref();
        });
      }
    };

    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve(client);
    });

    socket.addEventListener("message", (event) => {
      const message = decodeServerMessage(event.data);
      if (message.type === "hello") client.defaultDesign = message.defaultDesign;
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    });

    socket.addEventListener("error", () => reject(new Error(`${name} websocket error`)));
  });
}

function makeNoEngineDesign() {
  return [
    { x: 3, y: 3, type: "core" },
    { x: 3, y: 4, type: "armor" }
  ];
}

function makeCheapDesign() {
  return [
    { x: 7, y: 7, type: "core" },
    { x: 7, y: 8, type: "engine" }
  ];
}

function makeExpensiveDesign() {
  // A structurally VALID design (single core, engine, connected 1x1 blasters)
  // whose cost far exceeds the 1100 starting money, so the rejection exercises
  // the affordability check rather than blueprint validation.
  const design = [{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }];
  for (let y = 3; y <= 7; y += 1) {
    for (let x = 3; x <= 11; x += 1) {
      if (x === 7 && (y === 7 || y === 6)) continue;
      design.push({ x, y, type: "blaster" });
    }
  }
  design.push({ x: 7, y: 6, type: "blaster" });
  return design;
}

function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(label));
      }
    }, 50);
  });
}
