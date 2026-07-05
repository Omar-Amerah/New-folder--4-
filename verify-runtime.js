"use strict";

const { spawn } = require("child_process");

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

  try {
    await waitFor(() => output.join("").includes(`http://localhost:${PORT}`), 4000, "server did not start");

    const alpha = await openClient("Alpha");
    const beta = await openClient("Beta");

    alpha.send({ type: "join", name: "Alpha", room: ROOM });
    beta.send({ type: "join", name: "Beta", room: ROOM });

    await Promise.all([
      alpha.waitFor((message) => message.type === "joined" && message.room === ROOM, "alpha did not join"),
      beta.waitFor((message) => message.type === "joined" && message.room === ROOM, "beta did not join")
    ]);

    alpha.send({ type: "deploy", design: alpha.defaultDesign });
    beta.send({ type: "deploy", design: beta.defaultDesign });
    alpha.send({ type: "addBot" });
    alpha.send({ type: "buyShip", count: 1 });
    alpha.send({ type: "command", x: 1600, y: 950 });
    beta.send({ type: "command", x: 1600, y: 950 });

    const state = await alpha.waitFor(
      (message) => message.type === "state" && message.players.length === 3 && message.ships.length >= 4 && message.points.length === 3,
      "state snapshot did not include players, bot, economy-built ships, and fleets"
    );

    if (!state.players.some((player) => player.name === "Alpha") || !state.players.some((player) => player.name === "Beta")) {
      throw new Error("players missing from snapshot");
    }
    if (!state.players.some((player) => player.isBot)) {
      throw new Error("bot missing from snapshot");
    }
    const alphaState = state.players.find((player) => player.name === "Alpha");
    if (typeof alphaState.money !== "number" || typeof alphaState.income !== "number" || !alphaState.stats.unitCost) {
      throw new Error("economy fields missing from snapshot");
    }

    alpha.close();
    beta.close();
    console.log("runtime verification passed");
  } finally {
    server.kill();
  }
}

function openClient(name) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const messages = [];
    const waiters = [];
    const timeout = setTimeout(() => reject(new Error(`${name} connection timeout`)), 2500);

    const client = {
      defaultDesign: null,
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
      const message = JSON.parse(event.data);
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
