"use strict";

// Regression coverage for the server/client projectile clock contract.  The
// server snapshot is intentionally built with a later broadcast time than the
// latest completed simulation tick, while the client presentation helper is
// exercised at both sides of a newly spawned bolt's timestamp.

const assert = require("node:assert/strict");
const { snapshotRoom } = require("../src/server/snapshots");

function makeRoom() {
  const player = {
    id: "p1",
    name: "Pilot",
    team: "blue",
    ships: [],
    money: 0,
    income: 0,
    earned: 0,
    spent: 0,
    shipCap: 20,
    deployedFleetCost: 0,
    destroyedEnemyCost: 0,
    kills: 0,
    losses: 0,
    captures: 0,
    ready: true,
    connected: true,
    isBot: false,
    design: [],
    stats: { unitCost: 0 },
    shipsBuilt: 0,
    lostFleetCost: 0
  };
  const room = {
    code: "CLOCK",
    phase: "active",
    adminId: "p1",
    stateEpoch: 1,
    snapshotSeq: 1,
    staticRevision: 1,
    componentCatalogueRevision: 1,
    simulationTimeMs: 10000,
    world: { width: 10000, height: 6000 },
    map: { asteroids: [], relays: [] },
    mapSizeLabel: "small",
    rules: {},
    winner: null,
    matchStartedAt: 0,
    players: new Map([[player.id, player]]),
    ships: new Map(),
    clients: new Set(),
    bullets: [],
    projectileById: new Map(),
    effects: [],
    drones: [],
    decoys: [],
    stations: [],
    points: []
  };
  const client = {
    id: "c1",
    room,
    player,
    protocol: { capabilities: ["projectileEventsV1"] }
  };
  room.clients.add(client);
  return { room, player, client };
}

function makeBolt(id, x, y, vx, vy) {
  return {
    id,
    bornAt: 10000,
    type: "bolt",
    subtype: "autocannon",
    ownerId: "p1",
    x,
    y,
    vx,
    vy,
    life: 1.5,
    angle: Math.atan2(vy, vx)
  };
}

async function run() {
  const { projectBallisticProjectile } = await import("../public/src/game/projectileTimeline.js");
  const { room, player, client } = makeRoom();
  const bolt = makeBolt("bolt-1", 420, 800, 760, 0);
  room.bullets.push(bolt);
  room.projectileById.set(bolt.id, bolt);

  const full = snapshotRoom(room, 10600, player, true, null, client);
  assert.equal(full.simulationTimeMs, 10000, "ship state uses the latest completed tick");
  assert.equal(full.projectileSimulationTimeMs, 10000, "projectiles use the same authoritative tick");
  assert.equal(full.simulationTimeMs, full.projectileSimulationTimeMs);

  const compact = snapshotRoom(room, 10600, player, false);
  assert.equal(compact.simulationTimeMs, 10000, "compact ship state uses the latest completed tick");
  assert.equal(compact.projectileSimulationTimeMs, 10000, "compact projectiles use the same authoritative tick");
  assert.equal(compact.simulationTimeMs, compact.projectileSimulationTimeMs);

  const sample = { x: bolt.x, y: bolt.y, vx: bolt.vx, vy: bolt.vy, simulationTimeMs: 10000 };
  assert.equal(
    projectBallisticProjectile(sample, null, 9950),
    null,
    "a new bolt is hidden before its authoritative spawn timestamp"
  );
  const visible = projectBallisticProjectile(sample, null, 10050);
  assert.ok(visible, "the bolt appears once the render timeline reaches its spawn");
  assert.ok(Math.abs(visible.x - (bolt.x + bolt.vx * 0.05)) < 1e-9);
  assert.ok(Math.abs(visible.y - bolt.y) < 1e-9);
  assert.notEqual(visible.x, bolt.x + bolt.vx * 0.65, "the send-time clock is never used for extrapolation");

  // Hundreds of moving autocannon ships exercise the same newly-visible-bolt
  // boundary. A delayed timeline may advance a bolt by 50 ms, but it must stay
  // close to the firing ship's interpolated muzzle instead of jumping 650 ms.
  const shipCount = 512;
  for (let i = 0; i < shipCount; i += 1) {
    const shipX = 200 + i * 13;
    const shipY = 300 + (i % 29) * 170;
    const shipVx = 20 + (i % 7) * 11;
    const shipVy = (i % 5) * 7 - 14;
    const muzzle = { x: shipX + 18, y: shipY - 6 };
    const bulletVx = 700 + (i % 11) * 8;
    const bulletVy = (i % 9) * 4 - 16;
    const projected = projectBallisticProjectile(
      { ...muzzle, vx: bulletVx, vy: bulletVy, simulationTimeMs: 10000 },
      null,
      10050
    );
    const interpolatedMuzzle = {
      x: muzzle.x + shipVx * 0.05,
      y: muzzle.y + shipVy * 0.05
    };
    const distance = Math.hypot(
      projected.x - interpolatedMuzzle.x,
      projected.y - interpolatedMuzzle.y
    );
    assert.ok(distance < 100, `bolt ${i} should remain near its moving firing muzzle (got ${distance})`);
  }

  console.log(`verify-projectile-snapshot-clock: OK (${shipCount} moving autocannon bolts)`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
