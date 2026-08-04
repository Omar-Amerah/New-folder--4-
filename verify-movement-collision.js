"use strict";

// Collision under the movement controller.
//
// Every correction the movement pass applies is bounded: a hull is walked out
// of a bad overlap over successive ticks and never relocated in one frame.
// These tests hold that line for friendly contacts, asteroids and station
// solids alike, and check that launch-phase hulls stay the station's business.

const assert = require("node:assert/strict");
const { movementTestTick } = require("./tools/movementTestTick");
const {
  commandShips,
  maxFriendlyCorrectionPerTick,
  physicalCollisionRadius,
  resolveMapCollision,
  resolveSeparationPair,
  updateShipMovement
} = require("./src/server/movement");
const { STATIC_COLLISION_MAX_TICK_CORRECTION } = require("./src/server/movementTuning");
const { getMovementContactPairs } = require("./src/server/movementContactPairs");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { computeDesignCollisionRadius, findShipHullOverlap } = require("./src/server/componentGeometry");

const DT = 1 / 30;
const BASE = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" }
];

let sequence = 0;

function makeShip({ x, y, id = null, angle = 0, vx = 0, vy = 0, design = BASE, physicalRadius = null, ownerId = "p1" }) {
  const stats = computeStats(design);
  const ship = {
    id: id || `collision-${++sequence}`,
    ownerId,
    team: ownerId === "p1" ? "A" : "B",
    alive: true,
    removed: false,
    x,
    y,
    vx,
    vy,
    angle,
    targetX: x,
    targetY: y,
    radius: stats.radius,
    physicalRadius: physicalRadius ?? computeDesignCollisionRadius(design, stats),
    design: design.map((part) => ({ ...part })),
    wiring: createGeneratedPowerWiring(design),
    stats: { ...stats },
    combatStyle: "hold",
    combatStyleRaw: "hold",
    weaponAngles: [],
    weaponCooldowns: [],
    desiredAngles: [],
    aimTargetIds: [],
    componentTargetIds: [],
    beamContacts: []
  };
  initComponentState(ship);
  initializeComponentPower(ship);
  initShipHeat(ship);
  return ship;
}

function makeRoom(ships, asteroids = [], stations = []) {
  const players = new Map();
  for (const ship of ships) {
    if (!players.has(ship.ownerId)) {
      players.set(ship.ownerId, { id: ship.ownerId, team: ship.team, ships: [] });
    }
    players.get(ship.ownerId).ships.push(ship);
  }
  return {
    phase: "active",
    world: { width: 8000, height: 6000 },
    map: { asteroids, relays: [], revision: 1 },
    ships: new Map(ships.map((ship) => [ship.id, ship])),
    players,
    stations,
    stationsById: new Map(stations.map((station) => [station.id, station])),
    drones: new Map(),
    bullets: [],
    effects: [],
    spawnCollisionDiagnostics: {}
  };
}

function run() {
  // --- contact is resolved against hulls, not bounding circles -------------
  {
    // Far enough apart that the bounding circles overlap but the hulls do not.
    // A circle-based solver would stop these two with visible daylight between
    // them; nothing should happen here at all.
    const near = physicalCollisionRadius(makeShip({ x: 0, y: 0 })) * 2 - 6;
    const a = makeShip({ id: "clear-a", x: 1000, y: 1000 });
    const b = makeShip({ id: "clear-b", x: 1000 + near, y: 1000 });
    const room = makeRoom([a, b]);
    assert(Math.hypot(b.x - a.x, b.y - a.y)
      < physicalCollisionRadius(a) + physicalCollisionRadius(b),
    "sanity: the bounding circles overlap");
    assert(!findShipHullOverlap(a, b), "sanity: the hulls do not");
    assert.equal(resolveSeparationPair(room, a, b), null,
      "overlapping bounding circles alone are not a contact");
    assert.equal(a.x, 1000, "no correction is applied");
    assert(!a._shipContactNormals, "and no contact normal is recorded");
  }

  // --- two moving hulls collide -------------------------------------------
  for (const [label, ownerB] of [["friendly", "p1"], ["hostile", "p2"]]) {
    const a = makeShip({ id: `${label}-a`, x: 1000, y: 1000, vx: 120, vy: 45 });
    const b = makeShip({ id: `${label}-b`, x: 1030, y: 1000, vx: -120, vy: 45, ownerId: ownerB });
    const room = makeRoom([a, b]);
    const overlap = findShipHullOverlap(a, b);
    assert(overlap, `sanity: the ${label} hulls overlap`);
    const length = Math.hypot(overlap.dx, overlap.dy);
    const normal = { x: overlap.dx / length, y: overlap.dy / length };
    const tangent = { x: -normal.y, y: normal.x };
    const beforeTangentA = a.vx * tangent.x + a.vy * tangent.y;
    const beforeTangentB = b.vx * tangent.x + b.vy * tangent.y;
    const before = [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];

    const result = resolveSeparationPair(room, a, b);
    assert(result, `an overlapping ${label} pair should resolve`);
    assert(Math.abs((a.vx * tangent.x + a.vy * tangent.y) - beforeTangentA) < 1e-9,
      `tangential velocity survives on ${label} A`);
    assert(Math.abs((b.vx * tangent.x + b.vy * tangent.y) - beforeTangentB) < 1e-9,
      `tangential velocity survives on ${label} B`);
    assert((a.vx * normal.x + a.vy * normal.y) <= 1e-9,
      `velocity into the ${label} contact is removed from A`);
    assert((b.vx * normal.x + b.vy * normal.y) >= -1e-9,
      `velocity into the ${label} contact is removed from B`);
    assert(Math.hypot(a.x - before[0].x, a.y - before[0].y) <= maxFriendlyCorrectionPerTick(a) + 1e-9,
      `${label} A stays inside its per-tick correction budget`);
    assert(Math.hypot(b.x - before[1].x, b.y - before[1].y) <= maxFriendlyCorrectionPerTick(b) + 1e-9,
      `${label} B stays inside its per-tick correction budget`);
    // Deeply overlapped hulls are separated gradually, never in one jump.
    assert(findShipHullOverlap(a, b), `one pass does not fully resolve a deep ${label} overlap`);
  }

  // --- a dense formation converging on one area ----------------------------
  {
    const ships = Array.from({ length: 12 }, (_, index) => makeShip({
      id: `dense-${index}`,
      x: 700 + (index % 4) * 130,
      y: 900 + Math.floor(index / 4) * 130
    }));
    const room = makeRoom(ships);
    commandShips(room, room.players.get("p1"), 3000, 2400, {
      shipIds: ships.map((ship) => ship.id),
      formation: "clump"
    });
    const slots = ships.map((ship) => ({ ...ship.movement.destination }));

    let worstOverlap = 0;
    let worstJump = 0;
    let sawBroadPhase = false;
    for (let index = 0; index < 900; index += 1) {
      const previous = ships.map((ship) => ({ x: ship.x, y: ship.y }));
      movementTestTick(room, ships, DT, index * DT * 1000);
      if (getMovementContactPairs(room).length > 0) sawBroadPhase = true;
      for (let shipIndex = 0; shipIndex < ships.length; shipIndex += 1) {
        const ship = ships[shipIndex];
        const integrated = Math.hypot(ship._integratedMovementX || 0, ship._integratedMovementY || 0);
        const budget = maxFriendlyCorrectionPerTick(ship) + STATIC_COLLISION_MAX_TICK_CORRECTION;
        worstJump = Math.max(
          worstJump,
          Math.hypot(ship.x - previous[shipIndex].x, ship.y - previous[shipIndex].y) - integrated - budget
        );
      }
      for (let i = 0; i < ships.length; i += 1) {
        for (let j = i + 1; j < ships.length; j += 1) {
          const overlap = findShipHullOverlap(ships[i], ships[j]);
          if (overlap) worstOverlap = Math.max(worstOverlap, overlap.penetration);
        }
      }
    }

    assert(sawBroadPhase, "friendly contacts should come from the swept broad phase");
    assert(worstOverlap < 8, `ships should not visibly overlap (worst ${worstOverlap.toFixed(1)} px)`);
    assert(worstJump <= 0.01, `no ship may move further than integration plus its budget (${worstJump.toFixed(3)} px)`);
    // Collision pressure is not allowed to rewrite where the order sent anyone.
    assert.deepEqual(ships.map((ship) => ({ ...ship.movement.destination })), slots,
      "friendly separation must not move the formation destinations");
  }

  // --- an asteroid contact -------------------------------------------------
  {
    const asteroid = { id: "rock", x: 1500, y: 1500, radius: 200 };
    const ship = makeShip({ x: 1500 + 200, y: 1500, vx: -140, vy: 90 });
    const room = makeRoom([ship], [asteroid]);
    const before = { x: ship.x, y: ship.y };

    assert(resolveMapCollision(room, ship), "the hull should register the contact");
    assert(Math.abs(ship.vy - 90) < 1e-9, "tangential velocity survives asteroid contact");
    assert(ship.vx >= -1e-9, "velocity into the rock is removed");
    assert(Math.hypot(ship.x - before.x, ship.y - before.y) <= STATIC_COLLISION_MAX_TICK_CORRECTION + 1e-9,
      "one static pass stays inside the per-tick correction budget");
  }

  // --- an embedded hull is walked out, never teleported --------------------
  {
    const asteroid = { id: "deep", x: 2000, y: 2000, radius: 260 };
    const ship = makeShip({ x: 2000, y: 2010 });
    const room = makeRoom([ship], [asteroid]);
    let ticks = 0;
    let worstStep = 0;
    while (Math.hypot(ship.x - asteroid.x, ship.y - asteroid.y)
      < asteroid.radius + physicalCollisionRadius(ship) - 0.5 && ticks < 400) {
      const before = { x: ship.x, y: ship.y };
      ship._staticCollisionCorrectionDistance = 0;
      resolveMapCollision(room, ship);
      worstStep = Math.max(worstStep, Math.hypot(ship.x - before.x, ship.y - before.y));
      ticks += 1;
    }
    assert(ticks < 400, "an embedded hull should still be recovered");
    assert(ticks > 1, "...over successive ticks, not in one");
    assert(worstStep <= STATIC_COLLISION_MAX_TICK_CORRECTION + 1e-9,
      `no single tick may teleport the hull (${worstStep.toFixed(2)} px)`);
  }

  // --- station solids honour the same ceiling ------------------------------
  {
    const station = {
      id: "wall",
      x: 3000,
      y: 2000,
      radius: 400,
      collisionPieces: [{ x: 3000, y: 2000, halfWidth: 240, halfHeight: 160, angle: 0 }]
    };
    const ship = makeShip({ x: 3000, y: 2000 });
    const room = makeRoom([ship], [], [station]);

    const before = { x: ship.x, y: ship.y };
    assert(resolveMapCollision(room, ship), "a hull inside a station solid should register the contact");
    const applied = Math.hypot(ship.x - before.x, ship.y - before.y);
    assert(applied > 0, "the hull should be moved toward the outside");
    // Without the ceiling being forwarded to the station solver, one pass would
    // relocate the hull by the entire penetration depth.
    assert(applied <= STATIC_COLLISION_MAX_TICK_CORRECTION + 1e-9,
      `one station pass may not exceed the tick budget (${applied.toFixed(2)} px)`);
    assert(Math.abs(ship._staticCollisionCorrectionDistance - applied) < 1e-9,
      "the station correction is counted once against the tick budget");

    // The budget is a tick budget, so a second pass in the same tick adds
    // nothing rather than doubling the translation.
    const afterFirst = { x: ship.x, y: ship.y };
    resolveMapCollision(room, ship);
    assert(Math.hypot(ship.x - afterFirst.x, ship.y - afterFirst.y) < 1e-9,
      "a spent tick budget yields no further correction");
  }

  // --- a launch-phase hull belongs to the station --------------------------
  {
    const station = {
      id: "hangar",
      x: 3000,
      y: 2000,
      radius: 400,
      collisionPieces: [{ x: 3000, y: 2000, halfWidth: 240, halfHeight: 160, angle: 0 }]
    };
    const launching = makeShip({ id: "launching", x: 3000, y: 2000 });
    launching.launchPhase = { stationId: "hangar", stage: "clearing" };
    const room = makeRoom([launching], [{ id: "rock", x: 3000, y: 2000, radius: 200 }], [station]);

    assert.equal(resolveMapCollision(room, launching), false,
      "static collision does not act on a hull the station owns");
    assert.equal(launching.x, 3000);
    assert.equal(launching.y, 2000);

    commandShips(room, room.players.get("p1"), 5000, 2000, { shipIds: [launching.id] });
    const before = { x: launching.x, y: launching.y, vx: launching.vx, vy: launching.vy };
    updateShipMovement(room, launching, DT, 0);
    assert.deepEqual(
      { x: launching.x, y: launching.y, vx: launching.vx, vy: launching.vy },
      before,
      "a formation move must not fly a hull the station has not released"
    );

    // Released: the same order takes effect from the next tick.
    delete launching.launchPhase;
    updateShipMovement(room, launching, DT, DT * 1000);
    assert(Math.hypot(launching.vx, launching.vy) > 0 || launching.angle !== 0,
      "once released the ship answers its order normally");
  }

  console.log("verify-movement-collision: OK");
}

run();
