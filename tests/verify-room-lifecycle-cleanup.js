#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  rooms,
  closedRoomCodes,
  createRoom,
  deleteRoomIfCurrent
} = require("../src/server/rooms");
const {
  joinRoom,
  leaveLobby,
  closeLobby,
  returnToLobbyPhase
} = require("../src/server/players");

function makeSocket() {
  return {
    destroyed: false,
    write() { return true; },
    destroy() { this.destroyed = true; }
  };
}

function makeClient(id) {
  return { id, socket: makeSocket(), room: null, player: null, isClosed: false };
}

function seedRuntimeScratch(room) {
  const ship = { id: "stale-ship" };
  const drone = { id: "stale-drone" };
  const projectile = { id: "stale-projectile" };
  room._liveShipScratch = [ship];
  room._projectileLiveShipScratch = [ship];
  room._supportSpatialScratch = [ship];
  room._weaponSupportSpatialScratch = [ship];
  room._droneMovementScratch = [{ drone }];
  room._droneSeparationScratch = [drone];
  room._projectileSpare = [projectile];
  room._effectSpare = [{ type: "stale-effect" }];
  room._pointDefenseSpatialScratch = {
    ships: [ship],
    drones: [drone],
    projectiles: [projectile]
  };
  room._projectileSpatialScratch = {
    asteroids: [{ id: "stale-asteroid" }],
    ships: [ship],
    drones: [drone]
  };
}

function assertRuntimeScratchCleared(room) {
  for (const field of [
    "_liveShipScratch",
    "_projectileLiveShipScratch",
    "_supportSpatialScratch",
    "_weaponSupportSpatialScratch",
    "_droneMovementScratch",
    "_droneSeparationScratch",
    "_projectileSpare",
    "_effectSpare"
  ]) {
    assert.equal(room[field].length, 0, `${field} releases stale entities`);
  }
  for (const field of ["_pointDefenseSpatialScratch", "_projectileSpatialScratch"]) {
    for (const value of Object.values(room[field])) {
      assert.equal(value.length, 0, `${field} releases stale query candidates`);
    }
  }
}

// Leaving the last occupied lobby used to remove the room directly while
// leaving its empty-lobby timeout alive. Dispose it synchronously instead.
{
  const code = "LRACE";
  rooms.delete(code);
  closedRoomCodes.delete(code);
  const client = makeClient("c-leave");
  joinRoom(client, { room: code, name: "Leaver" });
  const oldRoom = client.room;
  seedRuntimeScratch(oldRoom);
  leaveLobby(client);
  assert.equal(rooms.has(code), false, "last explicit leave removes the room");
  assert.equal(oldRoom.emptyLobbyTimeout, null, "last explicit leave cancels the pending empty-lobby timer");
  assert.equal(oldRoom.ships.size, 0);
  assert.equal(oldRoom.drones.size, 0);
  assert.equal(oldRoom.bullets.length, 0);
  assertRuntimeScratchCleared(oldRoom);
  closedRoomCodes.delete(code);
}

// Even if an already-scheduled callback reaches an obsolete room instance, it
// must never remove or reserve the code belonging to a newer room.
{
  const code = "RREUS";
  rooms.delete(code);
  closedRoomCodes.delete(code);
  const obsolete = createRoom(code, { seed: 1 });
  const replacement = createRoom(code, { seed: 2 });
  seedRuntimeScratch(obsolete);
  rooms.set(code, replacement);
  closeLobby(obsolete, null);
  assert.equal(rooms.get(code), replacement, "obsolete cleanup preserves the replacement room");
  assert.equal(closedRoomCodes.has(code), false, "obsolete cleanup does not poison the replacement code");
  assertRuntimeScratchCleared(obsolete);
  assert.equal(deleteRoomIfCurrent(replacement), true);
}

// Match-to-lobby transitions clear the same reusable buffers while preserving
// the current player roster.
{
  const room = createRoom("RLOBB", { seed: 3 });
  const admin = {
    id: "p-admin",
    name: "Admin",
    team: "blue",
    isBot: false,
    connected: true,
    removed: false,
    ships: []
  };
  room.players.set(admin.id, admin);
  room.adminId = admin.id;
  room.phase = "active";
  seedRuntimeScratch(room);
  returnToLobbyPhase(room, admin);
  assert.equal(room.phase, "lobby");
  assert.equal(room.players.get(admin.id), admin);
  assertRuntimeScratchCleared(room);
}

console.log("Room lifecycle cleanup verification passed");
