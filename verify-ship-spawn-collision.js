"use strict";

const assert = require("assert");
const {
  findClearShipSpawnPoint,
  planShipSpawns,
  createSpawnReservations,
  releaseSpawnReservations,
  authoritativePhysicalRadius
} = require("./src/server/spawnPlanner");
const {
  commandShipsToDestination,
  updateShipSeparation,
  resolveFleetMapCollisions
} = require("./src/server/movement");
const { buildRoomSpatialIndex } = require("./src/server/spatialIndex");
const { beginMovementContactStep, buildMovementContactPairs } = require("./src/server/movementContactPairs");
const { findShipHullOverlap, computeDesignCollisionRadius } = require("./src/server/componentGeometry");
const { executePurchase } = require("./src/server/economy");
const { computeStats } = require("./src/server/shipStats");

function room(overrides = {}) {
  return {
    world: { width: 1600, height: 1200 },
    map: { asteroids: [], relays: [] },
    ships: new Map(),
    effects: [],
    players: new Map(),
    mapSeed: 12345,
    spawnReservations: [],
    spawnCollisionDiagnostics: {},
    ...overrides
  };
}

function ship(id, x, y, radius = 36, mass = 100) {
  return {
    id, ownerId: id[0], x, y, vx: 0, vy: 0, radius,
    physicalRadius: radius, stats: { mass, maxSpeed: 100 },
    alive: true, arrived: true, commandMode: null, design: []
  };
}

function purchaseFixture(id = "p") {
  const r = room({ phase: "active", code: "SPAWN", rules: { gameMode: "solo" }, nextEntityId: 1 });
  const design = [
    { x: 7, y: 7, type: "core", rotation: 0 },
    { x: 7, y: 9, type: "engine", rotation: 0 },
    { x: 7, y: 5, type: "blaster", rotation: 0 }
  ];
  const wiring = {
    version: 1,
    power: { sections: [], connections: [] },
    data: { sections: [], connections: [] },
    powerPolicy: null
  };
  const stats = computeStats(design, wiring);
  const player = {
    id, name: id, team: id, ready: true, client: {}, removed: false,
    design, wiring, stats, ships: [], shipCap: 12, money: 100000,
    spent: 0, deployedFleetCost: 0, shipsBuilt: 0, combatStyle: "hold",
    purchaseRequests: new Map(), rallyPoint: null
  };
  r.players.set(id, player);
  return { r, player, design, wiring, stats };
}

function purchase(fixture, requestId, count = 1, now = 1000) {
  return executePurchase(fixture.r, fixture.player, {
    requestId, count, design: fixture.design, wiring: fixture.wiring,
    stats: fixture.stats, combatStyle: "hold"
  }, now);
}

function clear(a, b, margin = 0) {
  return Math.hypot(a.x - b.x, a.y - b.y) + 1e-6
    >= authoritativePhysicalRadius(a) + authoritativePhysicalRadius(b) + margin;
}

function test(name, fn) {
  fn();
  console.log(`PASS ${name}`);
}

// Mirrors applyFlightAssist: velocity decays toward the commanded velocity with
// the movement time constant, limited by what the engines can deliver this step.
// The acceleration limit matters here -- without it these fixtures let ships
// change course far faster than any hull could.
function flightAssist(ship, decision, accel, dt, timeConstant = 0.12) {
  let dx = decision.desiredVelocity.x - ship.vx;
  let dy = decision.desiredVelocity.y - ship.vy;
  const blend = 1 - Math.exp(-dt / timeConstant);
  dx *= blend;
  dy *= blend;
  const available = accel * dt;
  const requested = Math.hypot(dx, dy);
  if (requested > available && requested > 0) {
    dx *= available / requested;
    dy *= available / requested;
  }
  ship.vx += dx;
  ship.vy += dy;
}

test("A occupied spawn centre", () => {
  const fixture = purchaseFixture();
  const preferred = require("./src/server/spawnPlanner").getPlannedSpawn(fixture.r, fixture.player.id);
  const blocker = ship("existing", preferred.x, preferred.y, 70);
  const blockerTwo = ship("existing-2", preferred.x + 20, preferred.y, 44);
  fixture.r.ships.set(blocker.id, blocker);
  fixture.r.ships.set(blockerTwo.id, blockerTwo);
  const result = purchase(fixture, "A");
  assert(result.ok);
  const created = fixture.r.ships.get(result.shipIds[0]);
  assert.strictEqual(created.x, preferred.x);
  assert.strictEqual(created.y, preferred.y);
  assert(blocker.x !== preferred.x || blocker.y !== preferred.y);
  assert(clear(created, blocker, 4));
  assert(clear(created, blockerTwo, 4));
  assert(clear(blocker, blockerTwo, 4));
});

test("B deterministic five-ship bulk", () => {
  const first = purchaseFixture();
  const second = purchaseFixture();
  const resultA = purchase(first, "B", 5);
  const resultB = purchase(second, "B", 5);
  assert(resultA.ok && resultB.ok);
  const a = resultA.shipIds.map((id) => first.r.ships.get(id));
  const b = resultB.shipIds.map((id) => second.r.ships.get(id));
  assert.deepStrictEqual(a.map(({ x, y }) => [x, y]), b.map(({ x, y }) => [x, y]));
  for (let i = 0; i < a.length; i += 1) for (let j = i + 1; j < a.length; j += 1) {
    assert(clear(a[i], a[j], 4));
  }
  assert.strictEqual(first.r.spawnReservations.length, 0);
});

test("C repeated individual purchases", () => {
  const fixture = purchaseFixture();
  for (let i = 0; i < 8; i += 1) {
    const result = purchase(fixture, `C${i}`, 1, 1000 + i);
    assert(result.ok);
    const created = fixture.r.ships.get(result.shipIds[0]);
    assert.strictEqual(created.movement.command, null,
      "a ship launched without a custom rally point should stay at its safe spawn");
    assert.strictEqual(created.targetX, created.x);
    assert.strictEqual(created.targetY, created.y);
    for (const previous of fixture.r.ships.values()) {
      if (previous !== created) assert(clear(created, previous, 4));
    }
  }
});

test("C2 custom rally still commands new ships", () => {
  const fixture = purchaseFixture();
  fixture.player.rallyPoint = { x: 1200, y: 900 };
  const result = purchase(fixture, "C2", 1, 1200);
  assert(result.ok);
  const created = fixture.r.ships.get(result.shipIds[0]);
  assert.strictEqual(created.movement.command?.type, "move",
    "an explicitly placed rally point should command a newly launched ship");
  assert(Math.hypot(created.targetX - created.x, created.targetY - created.y) > 48,
    "the custom rally order should lead away from the launch point");
});

test("D mixed-size spacing", () => {
  const r = room();
  const radii = [24, 46, 82];
  const planned = [];
  for (let i = 0; i < radii.length; i += 1) {
    const result = findClearShipSpawnPoint(r, { preferredX: 700, preferredY: 600, physicalRadius: radii[i], reservations: planned, ownerId: "p", requestId: "D", shipIndex: i });
    assert(result.ok);
    planned.push({ ...result, radius: radii[i], physicalRadius: radii[i] });
  }
  for (let i = 0; i < planned.length; i += 1) for (let j = i + 1; j < planned.length; j += 1) assert(clear(planned[i], planned[j], 4));
});

test("E occupied rally point keeps one shared destination", () => {
  const r = room();
  const occupied = ship("occupied", 800, 500, 55);
  r.ships.set(occupied.id, occupied);
  const arrivals = [ship("r1", 200, 400, 28), ship("r2", 200, 500, 42), ship("r3", 200, 600, 62)];
  for (const item of arrivals) r.ships.set(item.id, item);
  commandShipsToDestination(r, arrivals, { x: 800, y: 500 }, { prefix: "rally" });
  assert(arrivals.every((arrival) => arrival.movement.destination.x === 800
    && arrival.movement.destination.y === 500));
  assert(arrivals.every((arrival) => arrival.movement.combatSlot === undefined
    && arrival.movement.holdApproach === undefined));
});

// Separation resolves overlap; it must not tow. A light hull driving past a
// heavy one may shoulder it aside a little, but it must never end up dragging it
// along -- the heavy ship being carried the same distance as the ship pushing it
// is a solver leaking momentum, and in a crowd it moves whole formations.
//
// This used to drive the ships through applyLocalShipAvoidance, the world-space
// desired-velocity avoidance that the rewrite replaced with a bounded heading
// and speed offset. The towing property belongs to the separation solver and is
// tested directly here.
test("F separation does not tow a heavy ship", () => {
  const r = room();
  // Offset so the light ship grazes past rather than meeting the heavy one dead
  // on. A head-on stall measures nothing: neither ship travels, so "was it
  // towed" has no denominator. Steering around an obstruction is avoidance's
  // job, and avoidance is tested against the real controller elsewhere.
  const slow = ship("slow", 500, 552, 40, 220);
  const fast = ship("fast", 425, 500, 40, 80);
  fast.vx = 70;
  r.ships.set(slow.id, slow);
  r.ships.set(fast.id, fast);

  let fastTravel = 0;
  const slowStart = slow.x;
  for (let tick = 0; tick < 120; tick += 1) {
    buildRoomSpatialIndex(r, [fast, slow], tick * 50);
    const previousX = fast.x;
    const previousY = fast.y;
    fast.x += fast.vx / 20;
    fast.y += fast.vy / 20;
    slow.x += slow.vx / 20;
    slow.y += slow.vy / 20;
    fastTravel += Math.hypot(fast.x - previousX, fast.y - previousY);
    updateShipSeparation(r, [fast, slow], 0.05, tick * 50);
    // Hold the pusher at a steady speed and let the heavy ship shed whatever it
    // was given, so anything it retains is the solver's doing.
    const fastSpeed = Math.hypot(fast.vx, fast.vy);
    if (fastSpeed > 70) { fast.vx *= 70 / fastSpeed; fast.vy *= 70 / fastSpeed; }
    slow.vx *= 0.86;
    slow.vy *= 0.86;
  }
  assert(slow.x - slowStart < fastTravel * 0.35,
    `the heavy ship should not be towed (moved ${(slow.x - slowStart).toFixed(1)} px against ${fastTravel.toFixed(1)} px of pushing)`);
  assert(!findShipHullOverlap(fast, slow), "and they must not be left overlapping");
});

test("G exact-coordinate deterministic recovery", () => {
  const r = room();
  const a = ship("a", 600, 500, 34, 100);
  const b = ship("b", 600, 500, 34, 100);
  b.ownerId = a.ownerId;
  r.ships.set(a.id, a); r.ships.set(b.id, b);
  const beforeA = { x: a.x, y: a.y };
  const beforeB = { x: b.x, y: b.y };
  updateShipSeparation(r, [a, b], 0.05, 100);
  assert([a.x, a.y, b.x, b.y, a.vx, b.vx].every(Number.isFinite));
  assert(a.x !== b.x || a.y !== b.y);
  const { maxFriendlyCorrectionPerTick } = require("./src/server/movement");
  assert(Math.hypot(a.x - beforeA.x, a.y - beforeA.y) <= maxFriendlyCorrectionPerTick(a) + 1e-6);
  assert(Math.hypot(b.x - beforeB.x, b.y - beforeB.y) <= maxFriendlyCorrectionPerTick(b) + 1e-6);
});

test("H wall trapping stays in bounds", () => {
  const r = room();
  const a = ship("wa", 80, 500, 36, 100);
  const b = ship("wb", 92, 500, 36, 100);
  r.ships.set(a.id, a); r.ships.set(b.id, b);
  updateShipSeparation(r, [a, b], 0.05, 100);
  for (const item of [a, b]) assert(item.x >= 42 + item.physicalRadius && item.x <= r.world.width - 42 - item.physicalRadius);
});

test("I asteroid-side contact recovery", () => {
  const asteroid = { x: 500, y: 500, radius: 70 };
  const r = room({ map: { asteroids: [asteroid], relays: [] } });
  const a = ship("ia", 590, 500, 30, 100);
  const b = ship("ib", 610, 500, 30, 100);
  r.ships.set(a.id, a); r.ships.set(b.id, b);
  updateShipSeparation(r, [a, b], 0.05, 100);
  const before = new Map([a, b].map((item) => [item.id, { x: item.x, y: item.y }]));
  resolveFleetMapCollisions(r, [a, b]);
  for (const item of [a, b]) {
    assert(Math.hypot(item.x - before.get(item.id).x, item.y - before.get(item.id).y) <= 8 + 1e-6);
    assert(Math.hypot(item.x - asteroid.x, item.y - asteroid.y) + 8 + 1e-6
      >= asteroid.radius + item.physicalRadius);
  }
});

test("J simultaneous reservation exclusion", () => {
  const r = room();
  const first = planShipSpawns(r, { count: 2, preferredX: 500, preferredY: 500, physicalRadius: 50, ownerId: "p1", requestId: "J1" });
  const reservations = createSpawnReservations(r, "p1", "J1", first.placements, 1000);
  const second = planShipSpawns(r, { count: 2, preferredX: 500, preferredY: 500, physicalRadius: 50, ownerId: "p2", requestId: "J2", now: 1000 });
  assert(second.ok);
  for (const a of first.placements) for (const b of second.placements) assert(clear(a, b, 4));
  releaseSpawnReservations(r, reservations);
  assert.strictEqual(r.spawnReservations.length, 0);
});

test("K blocked planning is mutation-free", () => {
  const r = room({ world: { width: 180, height: 180 } });
  const before = JSON.stringify({ ships: r.ships.size, effects: r.effects.length, reservations: r.spawnReservations.length });
  const result = planShipSpawns(r, { count: 5, preferredX: 90, preferredY: 90, physicalRadius: 60, ownerId: "p", requestId: "K" });
  assert(!result.ok);
  assert.strictEqual(JSON.stringify({ ships: r.ships.size, effects: r.effects.length, reservations: r.spawnReservations.length }), before);
});

test("L long-hull narrow phase", () => {
  const longDesign = [
    { x: 7, y: 3, type: "frame", rotation: 0 },
    { x: 7, y: 7, type: "frame", rotation: 0 },
    { x: 7, y: 11, type: "frame", rotation: 0 }
  ];
  const radius = computeDesignCollisionRadius(longDesign, 30);
  assert(radius > 55);
  const a = { ...ship("la", 500, 500, radius), design: longDesign, angle: 0 };
  const b = { ...ship("lb", 515, 500, radius), design: longDesign, angle: 0 };
  assert(findShipHullOverlap(a, b));
});

test("M capital ship pushes a light blocker aside", () => {
  const r = room();
  const capital = ship("capital", 360, 600, 78, 720);
  // Slightly off the capital's centreline, so this is a hull shouldering a light
  // ship aside as it passes rather than a dead-on stall. The capital does not
  // steer around it: by mass it has right of way, and what is being tested is
  // that the light ship gets moved out of the way instead of stopping the heavy
  // one dead.
  const blocker = ship("blocker", 485, 655, 30, 55);
  blocker.ownerId = capital.ownerId;
  capital.arrived = false;
  capital.commandMode = "move";
  capital.vx = 62;
  r.ships.set(capital.id, capital);
  r.ships.set(blocker.id, blocker);
  const capitalStart = capital.x;
  const blockerStart = { x: blocker.x, y: blocker.y };

  for (let tick = 0; tick < 100; tick += 1) {
    buildRoomSpatialIndex(r, [capital, blocker], tick * 50);
    // Drive the capital straight ahead under its own acceleration limit. It has
    // right of way by mass and does not swerve; the question this asks is what
    // the separation solver does about the light hull standing in its path.
    flightAssist(capital, { desiredVelocity: { x: 70, y: 0 } }, 30, 0.05);
    capital.x += capital.vx * 0.05;
    capital.y += capital.vy * 0.05;
    blocker.x += blocker.vx * 0.05;
    blocker.y += blocker.vy * 0.05;
    for (const item of [capital, blocker]) item._friendlyCorrectionDistance = 0;
    const stepId = beginMovementContactStep(r, [capital, blocker], tick * 50);
    buildMovementContactPairs(r, [capital, blocker], tick * 50, { stepId });
    updateShipSeparation(r, [capital, blocker], 0.05, tick * 50);
    const capitalSpeed = Math.hypot(capital.vx, capital.vy);
    if (capitalSpeed > 70) {
      capital.vx *= 70 / capitalSpeed;
      capital.vy *= 70 / capitalSpeed;
    }
    blocker.vx *= 0.88;
    blocker.vy *= 0.88;
  }

  assert(capital.x - capitalStart > 240, "capital ship should keep making forward progress");
  assert(Number.isFinite(blocker.x) && Number.isFinite(blocker.y), "friendly collision keeps blocker finite");
  assert(!findShipHullOverlap(capital, blocker));
});

const stress = planShipSpawns(room({ world: { width: 5120, height: 3040 } }), {
  count: 30, preferredX: 700, preferredY: 1520, physicalRadius: 82,
  ownerId: "stress", requestId: "stress"
});
assert(stress.ok);
console.log(`STRESS max spawn attempts ${Math.max(...stress.placements.map((placement) => placement.attempts))} (30 ships)`);
console.log("All ship spawn/collision regressions passed");
