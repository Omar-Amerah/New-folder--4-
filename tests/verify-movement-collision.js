"use strict";

// Collision under the movement controller.
//
// Every correction the movement pass applies is bounded: a hull is walked out
// of a bad overlap over successive ticks and never relocated in one frame.
// These tests hold that line for friendly contacts, asteroids and station
// solids alike, and check that launch-phase hulls stay the station's business.

const assert = require("node:assert/strict");
const { movementTestTick } = require("../tools/movementTestTick");
const {
  commandShips,
  commandShipsToDestination,
  maxFriendlyCorrectionPerTick,
  physicalCollisionRadius,
  resolveMapCollision,
  resolveSeparationPair,
  updateShipMovement
} = require("../src/server/movement");
const {
  FRIENDLY_COMPRESSION_SPEED,
  FRIENDLY_PUSH_ABSOLUTE_CAP,
  FRIENDLY_PUSH_ACCELERATION,
  FRIENDLY_PUSH_MASS_FACTOR_MAX,
  FRIENDLY_PUSH_SPEED_RATIO,
  STATIC_COLLISION_MAX_TICK_CORRECTION
} = require("../src/server/movementTuning");
const { getMovementContactPairs } = require("../src/server/movementContactPairs");
const { computeStats } = require("../src/server/shipStats");
const { validateDesign } = require("../src/server/shipDesign");
const { initComponentState } = require("../src/server/componentHealth");
const { initializeComponentPower } = require("../src/server/componentPower");
const { initShipHeat } = require("../src/server/heat");
const { computeDesignCollisionRadius, findShipHullOverlap } = require("../src/server/componentGeometry");

const DT = 1 / 30;
const BASE = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" }
];
// A valid, deliberately fast edge-on hull. At its real top speed two opposing
// copies travel farther than one hull-cell diameter relative to one another in
// a 30 Hz tick, which is the case a final-overlap-only solver can tunnel.
const FAST_THIN = [
  { x: 2, y: 6, type: "core" },
  { x: 0, y: 6, type: "reactor" },
  ...Array.from({ length: 15 }, (_, x) => ({ x, y: 7, type: "engine", rotation: 0 }))
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
    dataLinks: [],
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

  // --- fast hulls cannot cross completely between ticks -------------------
  {
    const a = makeShip({ id: "swept-a", x: 1000, y: 1000, design: FAST_THIN, angle: 0 });
    const b = makeShip({
      id: "swept-b",
      x: 1050,
      y: 1000,
      design: FAST_THIN,
      angle: Math.PI,
      ownerId: "p2"
    });
    const room = makeRoom([a, b]);
    commandShipsToDestination(room, [a], { x: 7000, y: 1000 }, { prefix: "swept-a" });
    commandShipsToDestination(room, [b], { x: 100, y: 1000 }, { prefix: "swept-b" });
    a.vx = a.stats.maxSpeed;
    b.vx = -b.stats.maxSpeed;
    assert.equal(validateDesign(FAST_THIN).ok, true, "sanity: this speed is reachable by a legal blueprint");
    assert(a.stats.maxSpeed * DT * 2 > 2 * 13 * Math.SQRT2,
      "sanity: relative travel can clear an entire hull cell in one tick");
    assert.equal(findShipHullOverlap(a, b), null, "sanity: the fast hulls begin clear");

    const safety = movementTestTick(room, [a, b], DT, 0);
    assert(getMovementContactPairs(room).some((pair) => pair.a === a && pair.b === b),
      "the swept broad phase must retain the crossing pair");
    assert(a.x < b.x,
      `continuous hull contact must preserve ship order (${a.x.toFixed(2)} < ${b.x.toFixed(2)})`);
    const afterOverlap = findShipHullOverlap(a, b);
    assert(!afterOverlap || afterOverlap.penetration < 2,
      `the clipped hulls finish with at most the solver's resting sliver (${afterOverlap?.penetration || 0})`);
    assert(Math.abs(a.vx) < a.stats.maxSpeed * 0.1 && Math.abs(b.vx) < b.stats.maxSpeed * 0.1,
      "a head-on swept contact removes the closing velocity without a bounce");
    assert.equal(room.spawnCollisionDiagnostics.shipSweptCollisionPairs, 1,
      "one crossing is resolved once even though separation has two passes");
    assert.deepEqual(new Set(safety.modifiedShipIds), new Set([a.id, b.id]),
      "both clipped hulls cross the final static-safety boundary");
    assert(Math.abs((a.x - 1000) - a._integratedMovementX - (a._collisionCorrectionX || 0)) < 1e-6,
      "clipping updates A's authoritative integration accounting");
    assert(Math.abs((b.x - 1050) - b._integratedMovementX - (b._collisionCorrectionX || 0)) < 1e-6,
      "clipping updates B's authoritative integration accounting");
    for (let index = 1; index <= 90; index += 1) {
      movementTestTick(room, [a, b], DT, index * DT * 1000);
      assert(a.x < b.x, `sustained opposing thrust cannot cross the hulls at tick ${index}`);
      const overlap = findShipHullOverlap(a, b);
      assert(!overlap || overlap.penetration < 8,
        `sustained contact remains physically bounded at tick ${index} (${overlap?.penetration || 0})`);
    }
  }

  // The same crossing can end the frame in an overlap after the centres have
  // already swapped sides. Resolving only that final overlap would push both
  // hulls farther through; the recorded sweep must win in this branch too.
  {
    const a = makeShip({ id: "swept-reversed-a", x: 1000, y: 1500, design: FAST_THIN, angle: 0 });
    const b = makeShip({
      id: "swept-reversed-b",
      x: 1080,
      y: 1500,
      design: FAST_THIN,
      angle: Math.PI,
      ownerId: "p2"
    });
    const room = makeRoom([a, b]);
    commandShipsToDestination(room, [a], { x: 7000, y: a.y }, { prefix: "swept-reversed-a" });
    commandShipsToDestination(room, [b], { x: 100, y: b.y }, { prefix: "swept-reversed-b" });
    a.vx = a.stats.maxSpeed;
    b.vx = -b.stats.maxSpeed;

    movementTestTick(room, [a, b], DT, 0);
    assert(a.x < b.x, "an end-overlap cannot make crossed centres authoritative");
    const overlap = findShipHullOverlap(a, b);
    assert(!overlap || overlap.penetration < 2,
      `the reversed-centre contact settles to the ordinary resting sliver (${overlap?.penetration || 0})`);
    assert.equal(room.spawnCollisionDiagnostics.shipSweptCollisionPairs, 1,
      "the reversed-centre branch resolves at its earlier swept contact");
  }

  // The continuous pass is still hull-exact. Two fast, parallel thin hulls may
  // cross inside their bounding circles when the live cells themselves miss.
  {
    const a = makeShip({ id: "swept-miss-a", x: 1000, y: 1000, design: FAST_THIN, angle: 0 });
    const b = makeShip({
      id: "swept-miss-b",
      x: 1050,
      y: 1201,
      design: FAST_THIN,
      angle: Math.PI,
      ownerId: "p2"
    });
    const room = makeRoom([a, b]);
    commandShipsToDestination(room, [a], { x: 7000, y: a.y }, { prefix: "swept-miss-a" });
    commandShipsToDestination(room, [b], { x: 100, y: b.y }, { prefix: "swept-miss-b" });
    a.vx = a.stats.maxSpeed;
    b.vx = -b.stats.maxSpeed;
    assert.equal(findShipHullOverlap(a, b), null, "sanity: the near-miss hulls begin clear");

    movementTestTick(room, [a, b], DT, 0);
    assert(getMovementContactPairs(room).some((pair) => pair.a === a && pair.b === b),
      "sanity: bounding geometry retains the near-miss pair");
    assert(a.x > b.x, "empty space inside the swept bounding circles must remain traversable");
    assert.equal(findShipHullOverlap(a, b), null, "the fast near miss finishes clear as well");
    assert.equal(room.spawnCollisionDiagnostics.shipSweptCollisionPairs, undefined,
      "a hull-cell near miss must not produce a collision response");
  }

  // --- the friendly shove --------------------------------------------------
  //
  // A ship-to-ship contact is a shove, not a transfer of momentum. Sharing the
  // pair's normal speed by mass launched the stationary hull at half of the
  // other's cruising speed just for being touched. Instead the hull in front is
  // accelerated gradually and only up to a small contact speed, while the hull
  // behind is slowed to just under it and leans on it.
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
      const result = resolveSeparationPair(room, a, b, options.dt ?? DT);
      return { a, b, room, normal, tangent, project, before, result };
    };

    const pushCap = (ship) => Math.min(
      FRIENDLY_PUSH_ABSOLUTE_CAP,
      (Number(ship.stats.maxSpeed) || 0) * FRIENDLY_PUSH_SPEED_RATIO
    );

    // Rear-end onto a ship that is already moving well above contact speed:
    // it is not slowed to the contact cap merely because something touched it,
    // and it is not dramatically accelerated either. The cap governs the speed
    // the contact creates, never the ship's own propulsion.
    for (const [label, ownerB] of [["friendly", "p1"], ["hostile", "p2"]]) {
      const { a, b, project, normal, before, result } = contact({ ax: 120, bx: 80, ownerB });
      assert(result, `an overlapping ${label} pair should resolve`);
      assert(before.normalA > before.normalB, "sanity: A is catching B");
      assert(pushCap(b) < before.normalB, "sanity: B is already faster than contact speed");
      assert(Math.abs(project(b, normal) - before.normalB) < 1e-9,
        `${label} rear-end: a ship under its own power is not dragged to contact speed`
          + ` (${project(b, normal).toFixed(2)} from ${before.normalB.toFixed(2)})`);
      assert(Math.abs(project(a, normal) - (before.normalB + FRIENDLY_COMPRESSION_SPEED)) < 1e-9,
        `${label} rear-end: the ship behind settles just behind it and leans`
          + ` (${project(a, normal).toFixed(2)})`);
    }

    // The case the old impulse got wrong: 120 into a standing ship. The
    // stationary hull creeps forward -- it is not launched at half of 120 -- and
    // the acceleration it is given is metered per tick.
    {
      const { a, b, project, normal, before } = contact({ ax: 120, bx: 0 });
      const gained = project(b, normal) - before.normalB;
      assert(gained > 0, "the standing ship is pushed");
      assert(gained <= FRIENDLY_PUSH_ACCELERATION * DT + 1e-9,
        `one tick of contact may not exceed the push acceleration (${gained.toFixed(2)} px/s)`);
      assert(gained < before.normalA * 0.05,
        `a touched ship must not inherit a large share of cruising speed (${gained.toFixed(2)})`);
      assert(project(a, normal) <= project(b, normal) + FRIENDLY_COMPRESSION_SPEED + 1e-9,
        "the ship behind stops driving through the one in front");
      assert(project(a, normal) >= project(b, normal) - 1e-9,
        "...but is never reversed or dragged below a standstill by the contact");
    }

    // Sustained contact: the shove develops over time and settles at the cap,
    // not at a fraction of the pusher's speed. The engine behind keeps working,
    // which is what a ship bulldozing another actually looks like.
    {
      const a = makeShip({ id: "shove-a", x: 1000, y: 1000, vx: 120 });
      const b = makeShip({ id: "shove-b", x: 1030, y: 1000 });
      const room = makeRoom([a, b]);
      const cap = pushCap(b);
      let worstGain = 0;
      for (let index = 0; index < 200; index += 1) {
        a._friendlyCorrectionDistance = 0;
        b._friendlyCorrectionDistance = 0;
        a._friendlyPushVelocityAdded = 0;
        b._friendlyPushVelocityAdded = 0;
        // The hull behind holds full thrust straight at the one in front, and
        // stays pressed against it. All of B's speed is therefore contact.
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = Math.hypot(dx, dy) || 1;
        a.vx = dx / length * 120;
        a.vy = dy / length * 120;
        const beforeSpeed = Math.hypot(b.vx, b.vy);
        assert(findShipHullOverlap(a, b), `sanity: the shove stays in contact (tick ${index})`);
        resolveSeparationPair(room, a, b, DT);
        worstGain = Math.max(worstGain, Math.hypot(b.vx, b.vy) - beforeSpeed);
        b.x += b.vx * DT;
        b.y += b.vy * DT;
        a.x = b.x - dx / length * 30;
        a.y = b.y - dy / length * 30;
      }
      const settled = Math.hypot(b.vx, b.vy);
      assert(settled > cap * 0.8, `a sustained shove should get the front hull moving (${settled.toFixed(1)} px/s)`);
      // The hull normal is not exactly the line between two asymmetric hulls, so
      // the cap binds on the normal component rather than on the total.
      assert(settled <= cap * 1.05,
        `...but never much above the contact speed cap (${settled.toFixed(1)} against ${cap.toFixed(1)})`);
      assert(settled < 120 * 0.3,
        `...and nowhere near a share of the pusher's own speed (${settled.toFixed(1)} px/s)`);
      assert(worstGain <= FRIENDLY_PUSH_ACCELERATION * FRIENDLY_PUSH_MASS_FACTOR_MAX * DT + 1e-9,
        `no single tick may exceed the push budget (${worstGain.toFixed(2)} px/s)`);
    }

    // Two passes over the same contact in one tick share one acceleration
    // budget, so a crowded hull cannot be accelerated several times over.
    {
      const { a, b, room, project, normal, before } = contact({ ax: 120, bx: 0 });
      const afterOnePass = project(b, normal);
      for (let pass = 0; pass < 4; pass += 1) resolveSeparationPair(room, a, b, DT);
      const total = project(b, normal) - before.normalB;
      assert(total <= FRIENDLY_PUSH_ACCELERATION * FRIENDLY_PUSH_MASS_FACTOR_MAX * DT + 1e-9,
        `repeated passes share one per-tick budget (${total.toFixed(2)} px/s)`);
      assert(project(b, normal) >= afterOnePass - 1e-9, "and never take speed back");
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

    // Mass still matters: it scales how hard the shove pushes. A heavy hull
    // shifts a light one easily, a light one barely moves a heavy one, and
    // neither is launched.
    {
      const heavyOntoLight = contact({ ax: 150, bx: 0, massA: 100, massB: 20 });
      const lightOntoHeavy = contact({ ax: 150, bx: 0, massA: 20, massB: 100 });
      const gainOf = ({ b, project, normal, before }) => project(b, normal) - before.normalB;
      const shifted = gainOf(heavyOntoLight);
      const barely = gainOf(lightOntoHeavy);
      assert(shifted > barely * 3,
        `a heavy hull shifts a light one more easily (${shifted.toFixed(2)} against ${barely.toFixed(2)})`);
      assert(barely > 0, "...but a light hull still shifts a heavy one a little");
      assert(shifted <= FRIENDLY_PUSH_ACCELERATION * FRIENDLY_PUSH_MASS_FACTOR_MAX * DT + 1e-9,
        `and neither is launched (${shifted.toFixed(2)} px/s in one tick)`);
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

    // Head-on: both slow heavily and neither bounces. Speed a hull is driving
    // into the contact with is removed outright -- that is not the launch the
    // caps exist to prevent -- so only what is left is the metered shove.
    {
      const { a, b, project, normal, before } = contact({ ax: 120, bx: -120 });
      const afterA = project(a, normal);
      const afterB = project(b, normal);
      assert(Math.abs(afterA) < Math.abs(before.normalA) * 0.1,
        `head-on: A slows heavily (${afterA.toFixed(1)} from ${before.normalA.toFixed(1)})`);
      assert(Math.abs(afterB) < Math.abs(before.normalB) * 0.1,
        `head-on: B slows heavily (${afterB.toFixed(1)} from ${before.normalB.toFixed(1)})`);
      assert(afterA >= -1e-9 && afterA <= before.normalA + 1e-9,
        "head-on: A is not bounced back the way it came");
      assert(afterB >= before.normalB,
        "head-on: B is not bounced back the way it came");
      assert(afterA - afterB <= FRIENDLY_COMPRESSION_SPEED + 1e-9,
        "head-on: the pair is no longer closing beyond the compression sliver");
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

  // Exact asteroid centres use a stable fallback normal rather than producing
  // NaN or choosing a fresh random escape direction on every tick.
  {
    const recover = () => {
      const asteroid = { id: "centred-rock", x: 2400, y: 2100, radius: 220 };
      const ship = makeShip({ id: "centred-hull", x: asteroid.x, y: asteroid.y });
      const room = makeRoom([ship], [asteroid]);
      let ticks = 0;
      let worstStep = 0;
      while (Math.hypot(ship.x - asteroid.x, ship.y - asteroid.y)
        < asteroid.radius + physicalCollisionRadius(ship) - 0.5 && ticks < 400) {
        const before = { x: ship.x, y: ship.y };
        ship._staticCollisionCorrectionDistance = 0;
        resolveMapCollision(room, ship);
        const step = Math.hypot(ship.x - before.x, ship.y - before.y);
        worstStep = Math.max(worstStep, step);
        assert(Number.isFinite(ship.x) && Number.isFinite(ship.y), "centre recovery stays finite");
        ticks += 1;
      }
      assert(ticks > 1 && ticks < 400, "a hull at the exact centre is recovered gradually");
      assert(worstStep <= STATIC_COLLISION_MAX_TICK_CORRECTION + 1e-9,
        "exact-centre recovery obeys the static correction budget");
      return { x: ship.x, y: ship.y, ticks };
    };
    assert.deepEqual(recover(), recover(), "exact-centre recovery is deterministic for a stable ship id");
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

  // A shallow contact with a rotated station face removes only inward normal
  // speed and preserves the tangent, using the same bounded recovery as rocks.
  {
    const angle = Math.PI / 4;
    const normal = { x: Math.cos(angle), y: Math.sin(angle) };
    const tangent = { x: -normal.y, y: normal.x };
    const station = {
      id: "rotated-wall",
      x: 3200,
      y: 2400,
      radius: 400,
      collisionPieces: [{ x: 3200, y: 2400, halfWidth: 240, halfHeight: 90, angle }]
    };
    const radius = 30;
    const offset = 240 + radius - 4;
    const ship = makeShip({
      id: "rotated-contact",
      x: station.x + normal.x * offset,
      y: station.y + normal.y * offset,
      vx: -normal.x * 100 + tangent.x * 35,
      vy: -normal.y * 100 + tangent.y * 35,
      design: [],
      physicalRadius: radius
    });
    const room = makeRoom([ship], [], [station]);
    const before = { x: ship.x, y: ship.y };

    assert(resolveMapCollision(room, ship), "the rotated station face registers the shallow contact");
    const applied = Math.hypot(ship.x - before.x, ship.y - before.y);
    const normalSpeed = ship.vx * normal.x + ship.vy * normal.y;
    const tangentSpeed = ship.vx * tangent.x + ship.vy * tangent.y;
    assert(applied > 0 && applied <= STATIC_COLLISION_MAX_TICK_CORRECTION + 1e-9,
      `rotated station recovery stays bounded (${applied.toFixed(2)} px)`);
    assert(Math.abs(normalSpeed) < 1e-9, "velocity into a rotated station face is removed");
    assert(Math.abs(tangentSpeed - 35) < 1e-9, "velocity along a rotated station face survives");
  }

  // --- world edges and corners are independent collision planes -----------
  {
    const corner = makeShip({ id: "world-corner", x: 0, y: 0, vx: -120, vy: -90 });
    const room = makeRoom([corner]);
    const before = { x: corner.x, y: corner.y };
    assert(resolveMapCollision(room, corner), "an out-of-bounds corner registers a contact");
    const applied = Math.hypot(corner.x - before.x, corner.y - before.y);
    assert.equal(corner.vx, 0, "the left face removes leftward velocity");
    assert.equal(corner.vy, 0, "the top face removes upward velocity");
    assert(applied <= STATIC_COLLISION_MAX_TICK_CORRECTION + 1e-9,
      "corner recovery shares one bounded correction budget");
    assert(Math.abs(corner._staticCollisionCorrectionDistance - applied) < 1e-9,
      "world-edge correction is included in the tick budget");
    assert(Math.abs(room._roomTelemetry.staticCollisionCorrectionDistance - applied) < 1e-9,
      "world-edge correction is included in room telemetry");

    const glancing = makeShip({ id: "world-glance", x: 0, y: 0, vx: -120, vy: 45 });
    const glancingRoom = makeRoom([glancing]);
    resolveMapCollision(glancingRoom, glancing);
    assert.equal(glancing.vx, 0, "the active left face removes only its inward component");
    assert.equal(glancing.vy, 45, "motion back into the world survives a corner contact");

    const opposite = makeShip({
      id: "world-opposite-corner",
      x: room.world.width,
      y: room.world.height,
      vx: 120,
      vy: 90
    });
    const oppositeRoom = makeRoom([opposite]);
    resolveMapCollision(oppositeRoom, opposite);
    assert.equal(opposite.vx, 0, "the right face removes rightward velocity");
    assert.equal(opposite.vy, 0, "the bottom face removes downward velocity");

    for (const [label, x, y, vx, vy] of [
      ["top-right", room.world.width, 0, 120, -90],
      ["bottom-left", 0, room.world.height, -120, 90]
    ]) {
      const ship = makeShip({ id: `world-${label}`, x, y, vx, vy });
      resolveMapCollision(makeRoom([ship]), ship);
      assert.equal(ship.vx, 0, `${label} removes velocity through its vertical face`);
      assert.equal(ship.vy, 0, `${label} removes velocity through its horizontal face`);
    }
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

  // --- pusher selection is independent of argument order ---------------------
  //
  // A stationary hull with a moving one overlapping it should produce the same
  // world velocities regardless of which ship is passed as the first argument.
  // The contact normal flips, so the pusher must be chosen from the motion into
  // the contact rather than from argument order.
  {
    const radius = physicalCollisionRadius(makeShip({ x: 0, y: 0 }));
    const gap = radius * 2 - 6;
    const a1 = makeShip({ id: "order-a1", x: 1000, y: 1000 });
    const b1 = makeShip({ id: "order-b1", x: 1000 + gap, y: 1000, vx: -100 });
    const room1 = makeRoom([a1, b1]);
    resolveSeparationPair(room1, a1, b1, DT);

    const a2 = makeShip({ id: "order-a2", x: 1000, y: 1000 });
    const b2 = makeShip({ id: "order-b2", x: 1000 + gap, y: 1000, vx: -100 });
    const room2 = makeRoom([a2, b2]);
    resolveSeparationPair(room2, b2, a2, DT);

    assert(Math.abs(a1.vx - a2.vx) < 1e-9 && Math.abs(a1.vy - a2.vy) < 1e-9,
      "argument order must not change the stationary ship's velocity");
    assert(Math.abs(b1.vx - b2.vx) < 1e-9 && Math.abs(b1.vy - b2.vy) < 1e-9,
      "argument order must not change the moving ship's velocity");
    assert(b1.vx < a1.vx - 1e-9,
      "the moving ship settles just behind the one it pushed");
  }

  console.log("verify-movement-collision: OK");
}

run();
