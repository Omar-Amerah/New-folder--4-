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
const ROOM = "SMOKE";
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

    alpha.send({ type: "join", name: "Alpha", room: ROOM });
    beta.send({ type: "join", name: "Beta", room: ROOM });

    await Promise.all([
      alpha.waitFor((message) => message.type === "joined" && message.room === ROOM, "alpha did not join"),
      beta.waitFor((message) => message.type === "joined" && message.room === ROOM, "beta did not join")
    ]);

    alpha.send({ type: "addBot" });

    const lobbyState = await alpha.waitFor(
      (message) => message.type === "state" && message.phase === "lobby" && message.players.length === 3 && message.players.some((player) => player.isAdmin),
      "lobby did not include admin, bot, and players"
    );
    if (!lobbyState.players.find((player) => player.name === "Alpha")?.isAdmin) {
      throw new Error("first player was not room admin");
    }

    alpha.send({ type: "setRules", rules: { startingMoney: 1100 } });
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

    alpha.send({ type: "deploy", design: alpha.defaultDesign });
    beta.send({ type: "deploy", design: beta.defaultDesign });
    alpha.send({ type: "buyShip", count: 1 });
    alpha.send({ type: "command", x: 1600, y: 950 });
    beta.send({ type: "command", x: 1600, y: 950 });

    const state = await alpha.waitFor(
      (message) => message.type === "state" && message.phase === "active" && message.players.length === 3 && message.ships.length >= 3 && message.points.length >= 3 && message.map?.asteroids?.length,
      "state snapshot did not include players, bot, economy-built ships, and fleets"
    );

    if (!state.map.name || !Array.isArray(state.map.clouds) || state.map.clouds.length === 0) {
      throw new Error("generated map fields missing from snapshot");
    }
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
    const alphaState = state.players.find((player) => player.name === "Alpha");
    if (typeof alphaState.money !== "number" || typeof alphaState.income !== "number" || !alphaState.stats.unitCost) {
      throw new Error("economy fields missing from snapshot");
    }
    const moneyBefore = alphaState.money;
    const laterState = await alpha.waitFor(
      (message) => {
        if (message.type !== "state") return false;
        const player = message.players.find((candidate) => candidate.name === "Alpha");
        return player && player.money > moneyBefore;
      },
      "money did not increase after income tick"
    );
    const laterAlpha = laterState.players.find((player) => player.name === "Alpha");
    if (laterAlpha.income <= 0) {
      throw new Error("income was not positive");
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
        socket.send(JSON.stringify(data));
      },
      close() {
        socket.close();
      },
      waitFor(predicate, label) {
        const existing = messages.find(predicate);
        if (existing) return Promise.resolve(existing);
        return new Promise((innerResolve, innerReject) => {
          const waiter = { predicate, resolve: innerResolve, reject: innerReject };
          waiters.push(waiter);
          setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            innerReject(new Error(label));
          }, 5000).unref();
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

function makeExpensiveDesign() {
  const design = [];
  for (let y = 0; y <= 6; y += 1) {
    for (const x of [0, 3, 6, 9, 12]) {
      design.push({ x, y, type: "railgun" });
    }
  }
  design.push({ x: 6, y: 7, type: "core" });
  design.push({ x: 0, y: 7, type: "engine" });
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
