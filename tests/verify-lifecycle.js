"use strict";

const assert = require("assert");
const { rooms } = require("../src/server/rooms");
const { joinRoom, findReservedNameOwner, maybeStartMatch, returnToLobbyPhase } = require("../src/server/players");
const { damageStation } = require("../src/server/stationCombat");

function makeSocket() { return { destroyed: false, write() {}, destroy() { this.destroyed = true; } }; }
function makeClient(id) { return { id, socket: makeSocket(), room: null, player: null, isClosed: false }; }

const roomCode = "LIFE1";
rooms.delete(roomCode);

const a = makeClient("c1");
joinRoom(a, { type: "join", room: roomCode, name: "Ace", team: "blue" });
assert(a.player, "first player joins");
assert(/^pl\d+$/.test(a.player.id), "server assigns stable player id");
assert(a.player.resumeToken && a.player.resumeToken.length >= 32, "server issues opaque resume credential");
const stableId = a.player.id;
const token = a.player.resumeToken;

const dup = makeClient("c2");
joinRoom(dup, { type: "join", room: roomCode, name: " ace ", team: "red" });
assert.strictEqual(dup.player, null, "same normalized name cannot take over without credential");
assert.strictEqual(a.room.players.size, 1, "duplicate name does not create a second slot");
assert(findReservedNameOwner(a.room, "ACE"), "normalized name helper finds owner");

const bad = makeClient("c3");
joinRoom(bad, { type: "join", room: roomCode, name: "Ace", team: "red", resumeToken: "wrong" });
assert.strictEqual(bad.player, null, "wrong credential cannot reclaim slot");

const race = makeClient("c4");
joinRoom(race, { type: "join", room: roomCode, name: "Ace", team: "blue", resumeToken: token });
assert.strictEqual(race.player.id, stableId, "valid credential reclaims stable slot");
assert.strictEqual(race.player.resumeToken, token, "resume credential stays scoped to same slot");
assert.strictEqual(a.socket.destroyed, true, "old socket is closed during replacement");
assert.strictEqual(a.room, null, "old client detached");
assert.strictEqual(a.player, null, "old client no longer controls slot");
assert.strictEqual(race.room.clients.size, 1, "one active attachment remains");

rooms.delete(roomCode);

// A rejected join must not create the room as a side effect. A ghost empty
// room would be idle-cleaned and remembered as a closed code, poisoning a
// pre-agreed room code for the whole closed-code TTL.
const ghostCode = "GHOST1";
rooms.delete(ghostCode);
const staleJoiner = makeClient("c5");
joinRoom(staleJoiner, { type: "join", room: ghostCode, name: "Ghost", resumeToken: "stale-token" });
assert.strictEqual(staleJoiner.player, null, "stale credential join is rejected");
assert.strictEqual(rooms.has(ghostCode), false, "rejected join leaves no ghost room behind");
const freshJoiner = makeClient("c6");
joinRoom(freshJoiner, { type: "join", room: ghostCode, name: "Ghost" });
assert(freshJoiner.player, "the same code stays joinable for a fresh join");
assert.strictEqual(freshJoiner.room.code, ghostCode, "fresh join creates the room on demand");
rooms.delete(ghostCode);

// Everyone becoming ready starts the match, but readiness must not spend the
// starting budget or automatically deploy the editor design.
const readyCode = "READY1";
rooms.delete(readyCode);
const readyA = makeClient("c7");
const readyB = makeClient("c8");
const readyC = makeClient("c9");
joinRoom(readyA, { type: "join", room: readyCode, name: "Ready Ace", team: "blue" });
joinRoom(readyB, { type: "join", room: readyCode, name: "Ready Bee", team: "red" });
joinRoom(readyC, { type: "join", room: readyCode, name: "Ready Sea", team: "red" });
const readyRoom = readyA.room;
readyRoom.phase = "design";
readyA.player.ready = true;
readyB.player.ready = true;
readyC.player.ready = true;
const startingMoney = readyRoom.rules.startingMoney;
maybeStartMatch(readyRoom, 1000);
assert.strictEqual(readyRoom.phase, "active", "all ready players still start the match");
assert.strictEqual(readyRoom.ships.size, 0, "match start does not auto-deploy current designs");
for (const player of readyRoom.players.values()) {
  assert.strictEqual(player.ships.length, 0, "ready player starts without a deployed ship");
  assert.strictEqual(player.money, startingMoney, "ready player keeps the full starting budget");
  assert.strictEqual(player.spent, 0, "readiness does not count as a purchase");
  assert.strictEqual(player.shipsBuilt || 0, 0, "readiness does not increment ships built");
}

const blueHome = readyRoom.stations.find((station) => station.stationType === "home" && station.team === "blue");
const redHome = readyRoom.stations.find((station) => station.stationType === "home" && station.team === "red");
assert(blueHome && redHome, "each team receives a home station");
assert.strictEqual(blueHome.enemyPlayerCount, 2, "blue home station scales for two enemy players");
assert.strictEqual(redHome.enemyPlayerCount, 1, "red home station scales for one enemy player");
assert(Math.abs(blueHome.maxHp - redHome.maxHp * 2) < 0.001, "home station hull scales linearly with enemy player count");
assert(Math.abs(blueHome.maxShield - redHome.maxShield * 2) < 0.001, "home station shields scale linearly with enemy player count");

redHome.shield = 0;
damageStation(readyRoom, redHome, redHome.hp * 2, readyA.player.id, 2000, redHome.x, redHome.y);
assert.strictEqual(redHome.state, "destroyed", "a depleted home station is permanently destroyed");
assert.strictEqual(readyRoom.phase, "ended", "home station destruction ends the match");
assert.strictEqual(readyRoom.winner?.team, "blue", "the opposing team wins after destroying the enemy home station");
assert.strictEqual(readyRoom.winner?.reason, "home-base-destroyed", "winner snapshot identifies the home-base victory");

returnToLobbyPhase(readyRoom, readyA.player);
assert.strictEqual(readyRoom.phase, "lobby", "the admin can return to the existing lobby after a base-destruction victory");
assert.strictEqual(readyRoom.winner, null, "returning to lobby clears the completed match winner");
assert.strictEqual(rooms.get(readyCode), readyRoom, "base-destruction victory keeps the lobby joinable");
rooms.delete(readyCode);

console.log("Lifecycle verification passed");
