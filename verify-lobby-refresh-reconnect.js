"use strict";

const assert = require("assert");
const { rooms } = require("./src/server/rooms");
const { joinRoom } = require("./src/server/players");

function makeSocket() {
  return {
    destroyed: false,
    write() {},
    destroy() {
      this.destroyed = true;
    }
  };
}

function makeClient(id) {
  return {
    id,
    socket: makeSocket(),
    room: null,
    player: null,
    isClosed: false
  };
}

const roomCode = "REFRESH1";
rooms.delete(roomCode);

const originalClient = makeClient("p100");
joinRoom(originalClient, { type: "join", room: roomCode, name: "Pilot-259", team: "blue" });

const originalRoom = originalClient.room;
const originalPlayer = originalClient.player;
assert(originalRoom, "the original client should join the lobby");
assert.strictEqual(originalRoom.phase, "lobby", "the test must exercise the lobby phase");
assert.strictEqual(originalRoom.players.size, 1, "the lobby should initially contain one player");

// Simulate the refresh race: the replacement socket joins before the browser's
// old socket has emitted its close event, so the old player still says connected.
const refreshedClient = makeClient("p101");
joinRoom(refreshedClient, { type: "join", room: roomCode, name: "Pilot-259", team: "blue" });

assert.strictEqual(originalRoom.players.size, 1, "refreshing must not add a duplicate lobby player");
assert.strictEqual(originalRoom.clients.size, 1, "only the refreshed socket should remain attached");
assert.strictEqual(refreshedClient.player, originalPlayer, "the refreshed client should reclaim the existing player state");
assert.strictEqual(refreshedClient.player.id, "p101", "the reclaimed player should use the new socket id");
assert.strictEqual(originalRoom.adminId, "p101", "admin ownership should follow the refreshed socket");
assert.strictEqual(originalClient.room, null, "the stale client must be detached before its close event");
assert.strictEqual(originalClient.player, null, "the stale client must no longer own the player slot");
assert.strictEqual(originalClient.socket.destroyed, true, "the stale socket should be closed");

rooms.delete(roomCode);
console.log("Lobby refresh reconnect verification passed");
