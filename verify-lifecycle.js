"use strict";

const assert = require("assert");
const { rooms } = require("./src/server/rooms");
const { joinRoom, findReservedNameOwner } = require("./src/server/players");

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
console.log("Lifecycle verification passed");
