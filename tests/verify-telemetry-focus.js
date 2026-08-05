"use strict";

const assert = require("assert");
const { performanceNow } = require("../src/server/utils");
const {
  isTelemetryFocusEligible,
  revalidateTelemetryFocusForClient,
  revalidateTelemetryFocusForRoom
} = require("../src/server/relationships");
const { _test: { telemetryFocusForPayload } } = require("../src/server/snapshotDelivery");

function makeRoom(mode = "teams") {
  const players = new Map();
  const ships = new Map();
  const clients = new Set();
  return { players, ships, rules: { gameMode: mode }, clients };
}

function makePlayer(id, team) {
  return { id, team, removed: false };
}

function makeShip(id, ownerId) {
  return { id, ownerId, alive: true, removed: false };
}

function makeClient(player) {
  const client = {
    player,
    telemetryFocusShipId: null,
    telemetryLastWrittenFocusId: null,
    telemetryLastWrittenAt: 0
  };
  return client;
}

function run(message) {
  process.stdout.write(`${message}\n`);
}

// Eligibility: owner and allies only; enemy and solo enemies rejected.
(function testEligibility() {
  const room = makeRoom("teams");
  room.players.set("a", makePlayer("a", "blue"));
  room.players.set("b", makePlayer("b", "blue"));
  room.players.set("c", makePlayer("c", "red"));
  room.ships.set("s1", makeShip("s1", "a"));
  room.ships.set("s2", makeShip("s2", "b"));
  room.ships.set("s3", makeShip("s3", "c"));

  const aClient = makeClient(room.players.get("a"));
  const bClient = makeClient(room.players.get("b"));
  const cClient = makeClient(room.players.get("c"));

  assert.strictEqual(isTelemetryFocusEligible(aClient, "s1", room), true, "owner can focus");
  assert.strictEqual(isTelemetryFocusEligible(bClient, "s2", room), true, "ally can focus");
  assert.strictEqual(isTelemetryFocusEligible(aClient, "s3", room), false, "enemy cannot focus");
  assert.strictEqual(isTelemetryFocusEligible(aClient, "missing", room), false, "missing ship is safely rejected");
  assert.strictEqual(isTelemetryFocusEligible(aClient, null, room), false, "null focus is not eligible");

  const solo = makeRoom("solo");
  solo.players.set("a", makePlayer("a", "a"));
  solo.players.set("b", makePlayer("b", "b"));
  solo.ships.set("s1", makeShip("s1", "a"));
  solo.ships.set("s2", makeShip("s2", "b"));
  assert.strictEqual(isTelemetryFocusEligible(aClient, "s1", solo), true, "solo owner can focus");
  assert.strictEqual(isTelemetryFocusEligible(aClient, "s2", solo), false, "solo enemy cannot focus");

  run("  eligibility tests passed");
})();

// Stale focus is cleared for removed ships or team changes without errors.
(function testRevalidation() {
  const room = makeRoom("teams");
  room.players.set("a", makePlayer("a", "blue"));
  room.players.set("b", makePlayer("b", "blue"));
  room.ships.set("s1", makeShip("s1", "a"));
  room.ships.set("s2", makeShip("s2", "b"));

  const client = makeClient(room.players.get("a"));
  client.telemetryFocusShipId = "s2";
  revalidateTelemetryFocusForClient(client, room);
  assert.strictEqual(client.telemetryFocusShipId, "s2", "valid ally focus is preserved");

  room.ships.delete("s2");
  revalidateTelemetryFocusForClient(client, room);
  assert.strictEqual(client.telemetryFocusShipId, null, "removed ship focus is cleared");
  assert.strictEqual(client.telemetryLastWrittenFocusId, null, "last written focus is reset");

  const legacy = makeClient(room.players.get("a"));
  legacy.telemetryFocusShipId = undefined;
  revalidateTelemetryFocusForClient(legacy, room);
  assert.strictEqual(legacy.telemetryFocusShipId, undefined, "legacy undefined focus is preserved");

  const room2 = makeRoom("teams");
  room2.players.set("a", makePlayer("a", "blue"));
  room2.players.set("b", makePlayer("b", "red"));
  room2.ships.set("s1", makeShip("s1", "b"));
  const c2 = makeClient(room2.players.get("a"));
  c2.telemetryFocusShipId = "s1";
  room2.clients.add(c2);
  revalidateTelemetryFocusForRoom(room2);
  assert.strictEqual(c2.telemetryFocusShipId, null, "enemy focus cleared when team changes");

  run("  revalidation tests passed");
})();

// Payload focus scheduling: undefined is legacy compatibility; null skips; focus throttles and resends.
(function testPayloadFocus() {
  const now = performanceNow();
  const legacy = { telemetryFocusShipId: undefined, telemetryLastWrittenFocusId: undefined, telemetryLastWrittenAt: 0 };
  assert.strictEqual(telemetryFocusForPayload(legacy, now, false), undefined, "legacy client keeps undefined");

  const empty = { telemetryFocusShipId: null, telemetryLastWrittenFocusId: null, telemetryLastWrittenAt: 0 };
  assert.strictEqual(telemetryFocusForPayload(empty, now, false), null, "null focus returns null");

  const focused = { telemetryFocusShipId: "s1", telemetryLastWrittenFocusId: null, telemetryLastWrittenAt: 0 };
  assert.strictEqual(telemetryFocusForPayload(focused, now, false), "s1", "new focus is returned immediately");
  focused.telemetryLastWrittenFocusId = "s1";
  focused.telemetryLastWrittenAt = now;
  assert.strictEqual(telemetryFocusForPayload(focused, now, false), null, "unchanged focus is throttled");
  assert.strictEqual(telemetryFocusForPayload(focused, now, true), "s1", "full snapshot always includes focus");

  const later = now + 1000;
  assert.strictEqual(telemetryFocusForPayload(focused, later, false), "s1", "focus refreshes after interval");

  const changed = { telemetryFocusShipId: "s2", telemetryLastWrittenFocusId: "s1", telemetryLastWrittenAt: now };
  assert.strictEqual(telemetryFocusForPayload(changed, now, false), "s2", "changed focus is returned immediately");

  run("  payload focus scheduling tests passed");
})();

run("Telemetry focus unit tests passed");
