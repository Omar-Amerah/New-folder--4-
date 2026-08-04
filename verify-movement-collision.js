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
  commandShipsToDestination,
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
    assert.equal(a.vx, 0, "and no impulse is applied");
  }

  // --- the pair impulse ----------------------------------------------------
  //
  // A ship-to-ship contact is not a wall. Only the speed the two are CLOSING at
  // belongs to the collision; whatever they have in common is travel and has to
  // survive. These cases pin that down.
  {
    const contact = (options = {}) => {
      const a = makeShip({
        id: `impulse-a-${++sequence}`,
        x: 1000,
        y: 1000,
        vx: options.ax || 0,
        vy: options.ay || 0,
        design: options.designA || BASE
      });
      const b = makeShip({
        id: `impulse-b-${++sequence}`,
        x: 1000 + (options.gap ?? 30),
        y: 1000 + (options.offsetY || 0),
        vx: options.bx || 0,
        vy: options.by || 0,
        ownerId: options.ownerB || "p1",
        design: options.designB || BASE
      });
      if (options.massA) a.stats.mass = options.massA;
      if (options.massB) b.stats.mass = options.massB;
      const room = makeRoom([a, b]);
      const overlap = findShipHullOverlap(a, b);
      assert(overlap, "sanity: the hulls overlap");
      const normal = { x: overlap.dx, y: overlap.dy };
      const tangent = { x: -normal.y, y: normal.x };
      const project = (ship, axis) => ship.vx * axis.x + ship.vy * axis.y;
      const before = {
        normalA: project(a, normal),
        normalB: project(b, normal),
        tangentA: project(a, tangent),
        tangentB: project(b, tangent),
        positionA: { x: a.x, y: a.y },
        positionB: { x: b.x, y: b.y }
      };
      const result = resolveSeparationPair(room, a, b);
      return { a, b, room, normal, tangent, project, before, result };
    };

    // Rear-end, equal mass: the speed they share is travel, only the speed they
    // are closing at is the collision. Both come out at the average of the two,
    // and neither is stopped. Measured along the contact normal, which the hull
    // geometry decides -- the point is the relationship, not the axis.
    for (const [label, ownerB] of [["friendly", "p1"], ["hostile", "p2"]]) {
      const { a, b, project, normal, before, result } = contact({ ax: 120, bx: 80, ownerB });
      assert(result, `an overlapping ${label} pair should resolve`);
      const average = (before.normalA + before.normalB) / 2;
      assert(before.normalA > before.normalB, "sanity: A is catching B");
      assert(Math.abs(project(a, normal) - average) < 1e-9,
        `${label} rear-end: the faster ship keeps the shared momentum`
          + ` (${project(a, normal).toFixed(2)} against an average of ${average.toFixed(2)})`);
      assert(Math.abs(project(b, normal) - average) < 1e-9,
        `${label} rear-end: the slower ship is carried up to it`
          + ` (${project(b, normal).toFixed(2)})`);
      // The whole point: what was 120 did not become 0.
      assert(project(a, normal) > before.normalB - 1e-9,
        `${label} rear-end: the catching ship must not be stopped by the contact`);
    }

    // Two ships travelling together at the same speed are not colliding, however
    // deeply their hulls happen to overlap. This is the case the remembered
    // contact normal used to stop dead.
    {
      const { a, b, project, normal, before } = contact({ ax: 100, bx: 100 });
      assert(Math.abs(project(a, normal) - before.normalA) < 1e-9,
        `same-speed contact must not brake A (${project(a, normal).toFixed(2)})`);
      assert(Math.abs(project(b, normal) - before.normalB) < 1e-9,
        `same-speed contact must not brake B (${project(b, normal).toFixed(2)})`);
      assert(Math.abs(a.vx - 100) < 1e-9 && Math.abs(b.vx - 100) < 1e-9,
        "and neither loses any of its actual velocity");
    }

    // Momentum along the normal is conserved when the masses differ, and the
    // lighter hull is the one that changes most.
    {
      const { a, b, project, normal, before } = contact({ ax: 150, bx: 0, massA: 20, massB: 100 });
      const momentumBefore = before.normalA * 20 + before.normalB * 100;
      const momentumAfter = project(a, normal) * 20 + project(b, normal) * 100;
      assert(Math.abs(momentumAfter - momentumBefore) < 1e-6,
        `normal momentum is conserved (${momentumBefore.toFixed(1)} -> ${momentumAfter.toFixed(1)})`);
      const changeA = Math.abs(project(a, normal) - before.normalA);
      const changeB = Math.abs(project(b, normal) - before.normalB);
      assert(changeA > changeB * 4,
        `the light hull gives way to the heavy one (${changeA.toFixed(1)} against ${changeB.toFixed(1)})`);
    }

    // Glancing: tangential motion is untouched, so hulls slide past rather than
    // sticking to each other.
    {
      const { a, b, project, tangent, before } = contact({ ax: 120, ay: 60, bx: -120, by: 60 });
      assert(Math.abs(project(a, tangent) - before.tangentA) < 1e-9, "tangential velocity survives on A");
      assert(Math.abs(project(b, tangent) - before.tangentB) < 1e-9, "tangential velocity survives on B");
    }

    // Already separating: nothing to resolve, so nothing is taken.
    {
      const { a, b, project, normal, before } = contact({ ax: -60, bx: 90 });
      assert(Math.abs(project(a, normal) - before.normalA) < 1e-9, "a separating pair keeps A's velocity");
      assert(Math.abs(project(b, normal) - before.normalB) < 1e-9, "a separating pair keeps B's velocity");
    }

    // Correction stays bounded and gradual whatever the impulse did.
    {
      const { a, b, before, result } = contact({ ax: 120, bx: -120 });
      assert(result, "a head-on pair resolves");
      assert(Math.hypot(a.x - before.positionA.x, a.y - before.positionA.y)
        <= maxFriendlyCorrectionPerTick(a) + 1e-9, "A stays inside its per-tick correction budget");
      assert(Math.hypot(b.x - before.positionB.x, b.y - before.positionB.y)
        <= maxFriendlyCorrectionPerTick(b) + 1e-9, "B stays inside its per-tick correction budget");
      assert(findShipHullOverlap(a, b), "one pass does not fully resolve a deep overlap");
    }

    // Resting contact: a sliver of overlap is left alone rather than producing a
    // standing shove every tick.
    {
      const a = makeShip({ id: "rest-a", x: 1000, y: 1000 });
      const b = makeShip({ id: "rest-b", x: 1000, y: 1000 });
      // Back off until the hulls barely touch.
      let gap = 0;
      while (findShipHullOverlap(a, b)?.penetration > 0.2 && gap < 200) {
        gap += 0.1;
        b.x = 1000 + gap;
      }
      const room = makeRoom([a, b]);
      const before = { x: a.x, y: a.y };
      resolveSeparationPair(room, a, b);
      assert(Math.hypot(a.x - before.x, a.y - before.y) < 1e-9,
        "a resting contact inside the slop is not corrected");
    }
  }

  // --- a crowd travelling in sustained contact -----------------------------
  {
    // One shared destination, so these hulls stay pressed against each other for
    // the whole journey. Contact that repeats every tick must not bleed the
    // group's speed away, and no ship may be brought to a sudden stop by a
    // neighbour it is travelling alongside.
    const ships = Array.from({ length: 6 }, (_, index) => makeShip({
      id: `convoy-${index}`,
      x: 900 + (index % 3) * 34,
      y: 1500 + Math.floor(index / 3) * 34
    }));
    const room = makeRoom(ships);
    commandShipsToDestination(room, ships, { x: 7000, y: 1500 }, { prefix: "convoy" });

    const speedOf = (ship) => Math.hypot(ship.vx, ship.vy);
    let worstDrop = 0;
    let slowestUnderWay = Infinity;
    let contactTicks = 0;
    let previous = ships.map(speedOf);
    for (let index = 0; index < 500; index += 1) {
      movementTestTick(room, ships, DT, index * DT * 1000);
      let touching = false;
      for (let i = 0; i < ships.length && !touching; i += 1) {
        for (let j = i + 1; j < ships.length && !touching; j += 1) {
          if (findShipHullOverlap(ships[i], ships[j])) touching = true;
        }
      }
      if (touching) contactTicks += 1;
      ships.forEach((ship, shipIndex) => {
        const speed = speedOf(ship);
        // Only judge ships that are still a long way from the destination, so
        // ordinary arrival braking is not counted as a collision stall.
        if (Math.hypot(ship.x - 7000, ship.y - 1500) > 1500 && index > 60) {
          slowestUnderWay = Math.min(slowestUnderWay, speed);
          worstDrop = Math.max(worstDrop, previous[shipIndex] - speed);
        }
        previous[shipIndex] = speed;
      });
    }

    assert(contactTicks > 100,
      `sanity: these hulls should actually be in contact while travelling (${contactTicks} ticks)`);
    assert(slowestUnderWay > 150,
      `a crowd in contact should keep travelling (slowest ${slowestUnderWay.toFixed(0)} px/s)`);
    // Braking authority is five times acceleration, so one tick can legitimately
    // take off a good chunk of speed. What must not happen is a contact deleting
    // a ship's whole velocity in a single step.
    assert(worstDrop < 60,
      `no contact may stop a ship dead (worst single-tick loss ${worstDrop.toFixed(1)} px/s)`);
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
