"use strict";

const assert = require("assert");
const http = require("http");
const { createGameServer } = require("./server");
const { createRoom, rooms } = require("./src/server/rooms");

(async () => {
  const game = createGameServer({ port: 0, host: "127.0.0.1" });
  assert(game.diagnostics().stopped);
  await game.start();
  assert(game.address().port > 0);
  assert(game.diagnostics().activeTimers.includes("simulation"));
  await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${game.address().port}/`, (response) => {
      response.resume();
      resolve();
    }).on("error", reject);
  });
  assert.throws(() => game.start(), /already started/);

  const room = createRoom("STOPC", { seed: 42 });
  room._liveShipScratch = [{ id: "retained-until-stop" }];
  rooms.set(room.code, room);
  await game.stop();

  assert(game.diagnostics().stopped);
  assert.equal(game.diagnostics().activeRooms, 0, "server shutdown disposes the global room registry");
  assert.equal(room._liveShipScratch.length, 0, "server shutdown releases room-owned runtime scratch");
  await game.stop();
  console.log("server lifecycle ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
