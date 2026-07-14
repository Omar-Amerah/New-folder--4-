"use strict";
// Group 12: a brief disconnect (socket close / refresh) must NOT despawn a
// player's ships immediately — they are kept for a reconnect grace period and
// only removed on a deliberate leave or when the grace elapses.
const assert = require("assert");
const { leaveRoom } = require("./src/server/players");

function makeContext() {
  const ship = { id: "s1", ownerId: "p1", alive: true, removed: false };
  const player = { id: "p1", name: "Pilot", connected: true, isBot: false, ships: [ship], attachmentId: 1, resumeToken: "token" };
  const room = {
    phase: "battle",
    clients: new Set(),
    players: new Map(),
    ships: new Map(),
    bullets: [{ ownerId: "p1" }],
    world: { width: 4000, height: 4000 },
    adminId: "p1"
  };
  const client = { id: "c1", room, player, attachmentId: 1, socket: { destroy() {} } };
  player.client = client;
  room.clients.add(client);
  room.players.set("p1", player);
  room.ships.set("s1", ship);
  return { room, player, ship, client };
}

// 1. Non-explicit disconnect keeps the ships and player alive with a grace timer.
{
  const { room, player, ship, client } = makeContext();
  leaveRoom(client); // socket close / refresh
  assert.strictEqual(ship.alive, true, "ship should stay alive during the reconnect grace period");
  assert(room.ships.has("s1"), "ship should remain in the room during the grace period");
  assert.strictEqual(player.ships.length, 1, "player should retain its ships during the grace period");
  assert.strictEqual(player.connected, false, "player should be marked disconnected");
  assert(room.players.has("p1"), "player should remain in the room during the grace period");
  assert(player.disconnectTimeout, "a reconnect grace timer should be scheduled");
  clearTimeout(player.disconnectTimeout); // don't leak the 10s timer into the test run
}

// 2. Explicit leave removes ships and the player immediately.
{
  const { room, player, ship, client } = makeContext();
  leaveRoom(client, true);
  assert.strictEqual(ship.alive, false, "explicit leave should kill the ship");
  assert(!room.ships.has("s1"), "explicit leave should remove the ship from the room");
  assert(!room.players.has("p1"), "explicit leave should remove the player");
  assert.strictEqual(player.ships.length, 0, "explicit leave should clear the player's ships");
  assert.strictEqual(room.bullets.length, 0, "explicit leave should remove the player's bullets");
}

console.log("Reconnect verification passed");
