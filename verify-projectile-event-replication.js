"use strict";

// Focused deterministic coverage for the Phase 2E projectile event-replication
// contract.  This is a Node-only, browser-free test.

const assert = require("assert");
const {
  ensureReplication,
  resetProjectileReplication,
  recordProjectileSpawn,
  recordProjectileRemove,
  recordProjectileReason,
  buildClientBatch,
  applyClientProjectiles,
  markProjectilesWritten,
  clientSupportsProjectileEvents,
  getLogSize,
  getProjectileReplicationDiagnostics
} = require("./src/server/projectileReplication");

let failed = false;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed = true;
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}

function makeRoom() {
  return {
    stateEpoch: 1,
    bullets: [],
    projectileById: new Map(),
    clients: new Set(),
    players: new Map([["p1", { id: "p1", team: "t1" }]]),
    rules: {},
    world: { width: 2000, height: 2000 }
  };
}

function makeClient(caps = ["projectileEventsV1"]) {
  return {
    id: "c1",
    protocol: { capabilities: caps },
    player: { id: "p1", team: "t1" }
  };
}

function makeBullet(id, x = 100, y = 100, type = "bolt") {
  return {
    id,
    bornAt: 0,
    type,
    subtype: "light",
    ownerId: "p1",
    x,
    y,
    vx: 10,
    vy: 0,
    life: 2,
    angle: 0,
    _replicationSpawned: false,
    _replicationRemoveSeq: null
  };
}

test("lifecycle log is not cleared on snapshot build", () => {
  const room = makeRoom();
  const b = makeBullet("b1");
  recordProjectileSpawn(room, b, 0);
  assert.strictEqual(getLogSize(room), 1);
  recordProjectileRemove(room, b, "expired", 100, 100, 100);
  assert.strictEqual(getLogSize(room), 2);
});

test("record always creates a lifecycle log", () => {
  const room = makeRoom();
  const b = makeBullet("b2");
  recordProjectileSpawn(room, b, 0);
  assert.strictEqual(getLogSize(room), 1);
});

test("full baseline replaces the visible set", () => {
  const room = makeRoom();
  const b1 = makeBullet("b1");
  const b2 = makeBullet("b2", 5000, 5000);
  room.bullets.push(b1, b2);
  room.projectileById.set(b1.id, b1);
  room.projectileById.set(b2.id, b2);
  const client = makeClient();
  room.clients.add(client);
  recordProjectileSpawn(room, b1, 0);
  recordProjectileSpawn(room, b2, 0);
  const batch = buildClientBatch(room, client, 0, true);
  assert.ok(batch.bullets.length > 0);
  assert.strictEqual(batch.delivery.eventSeq, room.projectileReplication.nextEventSeq);
});

test("event batch delivers spawn then remove", () => {
  const room = makeRoom();
  const client = makeClient();
  room.clients.add(client);
  const b = makeBullet("b1");
  room.bullets.push(b);
  room.projectileById.set(b.id, b);
  recordProjectileSpawn(room, b, 0);
  const baseline = buildClientBatch(room, client, 0, true);
  assert.strictEqual(baseline.bullets.length, 1);
  markProjectilesWritten(client, room, baseline.delivery);
  recordProjectileReason(b, "expired", 100, 100);
  recordProjectileRemove(room, b, "expired", 100, 100, 100);
  const compact = buildClientBatch(room, client, 100, false);
  assert.strictEqual(compact.events.length, 1);
  assert.strictEqual(compact.events[0].type, "projectileRemove");
  assert.strictEqual(compact.events[0].projectileId, "b1");
});

test("duplicate spawn and duplicate removal are harmless", () => {
  const room = makeRoom();
  const client = makeClient();
  room.clients.add(client);
  const b = makeBullet("b1");
  room.bullets.push(b);
  room.projectileById.set(b.id, b);
  recordProjectileSpawn(room, b, 0);
  recordProjectileSpawn(room, b, 0);
  recordProjectileRemove(room, b, "expired", 100, 100, 100);
  recordProjectileRemove(room, b, "expired", 100, 100, 100);
  assert.strictEqual(getLogSize(room), 2);
});

test("state-epoch change resets log and client state", () => {
  const room = makeRoom();
  const client = makeClient();
  room.clients.add(client);
  const b = makeBullet("b1");
  room.bullets.push(b);
  room.projectileById.set(b.id, b);
  recordProjectileSpawn(room, b, 0);
  resetProjectileReplication(room, 2);
  assert.strictEqual(getLogSize(room), 0);
  assert.strictEqual(room.projectileReplication.stateEpoch, 2);
  assert.strictEqual(room.projectileReplication.nextEventSeq, 0);
});

test("client capability follows the server feature flag", () => {
  const clientNoCaps = makeClient([]);
  const clientWithCaps = makeClient(["projectileEventsV1"]);
  assert.strictEqual(clientSupportsProjectileEvents(clientNoCaps), false);
  assert.strictEqual(clientSupportsProjectileEvents(clientWithCaps), true);
});

test("applyClientProjectiles overrides snapshot bullets for event clients", () => {
  const room = makeRoom();
  const b = makeBullet("b1");
  room.bullets.push(b);
  room.projectileById.set(b.id, b);
  const client = makeClient();
  room.clients.add(client);
  const snap = { bullets: [{ id: "old" }] };
  const delivery = applyClientProjectiles(room, client, 0, true, snap);
  assert.ok(delivery);
  assert.strictEqual(snap.bullets[0].id, "b1");
  assert.strictEqual(snap.projectileStateEpoch, room.projectileReplication.stateEpoch);
});

test("fallback client keeps the original bullets", () => {
  const room = makeRoom();
  const b = makeBullet("b1");
  room.bullets.push(b);
  room.projectileById.set(b.id, b);
  const client = makeClient([]);
  room.clients.add(client);
  const snap = { bullets: [{ id: "fallback" }] };
  const delivery = applyClientProjectiles(room, client, 0, true, snap);
  assert.strictEqual(delivery, null);
  assert.strictEqual(snap.bullets[0].id, "fallback");
});

test("feature flags for phase 2B-D remain unchanged", () => {
  const {
    PROJECTILE_FLAK_SINGLE_PASS,
    PROJECTILE_GUIDANCE_CADENCE,
    PROJECTILE_GRID_COLLISION
  } = require("./src/server/performanceFlags");
  assert.strictEqual(PROJECTILE_FLAK_SINGLE_PASS(), false);
  assert.strictEqual(PROJECTILE_GUIDANCE_CADENCE(), false);
  assert.strictEqual(PROJECTILE_GRID_COLLISION(), false);
});

if (failed) {
  process.exit(1);
}
console.log("projectile event replication checks passed");
