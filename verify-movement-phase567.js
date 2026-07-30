"use strict";

// Phases 5, 6 and 7.
//
// Phase 5 -- ships turning inside groups. Turning is never blocked by nearby
// friendlies: collision for local movement is circular, so a hull has no
// orientation to be locked by.
//
// Phase 6 -- predictive local avoidance. One deterministic ship yields, by a
// bounded heading offset and a speed reduction, and both continue to their
// destinations.
//
// Phase 7 -- explicit enemy targeting, kept separate from the movement
// destination.

const assert = require("assert");
const { computeStats } = require("./src/server/shipStats");
const {
  commandShips,
  rotateShips,
  updateShipMovement,
  updateShipSeparation
} = require("./src/server/movement");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { computeDesignCollisionRadius } = require("./src/server/componentGeometry");
const { buildRoomSpatialIndex } = require("./src/server/spatialIndex");
const { physicalCollisionRadius } = require("./src/server/movementCollision");
const { ARRIVE_DISTANCE } = require("./src/server/movementTuning");

// Where the ship was ordered to. The runtime destination is cleared once the
// order has been carried out -- the durable record of the order is the command.
function orderedDestination(ship) {
  return ship.movement.command?.destination || ship.movement.destination;
}

const DT = 1 / 30;
const DESIGN = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" }
];

// A hull with weapons, for the targeting cases.
const ARMED_DESIGN = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" },
  { x: 6, y: 7, type: "blaster" }
];

let shipSeq = 0;

function makeShip(x, y, angle = 0, design = DESIGN, ownerId = "p1") {
  const stats = computeStats(design);
  const ship = {
    id: `s${String(++shipSeq).padStart(3, "0")}`,
    ownerId,
    alive: true,
    x,
    y,
    vx: 0,
    vy: 0,
    angle,
    targetX: x,
    targetY: y,
    radius: stats.radius,
    physicalRadius: computeDesignCollisionRadius(design, stats),
    design: design.map((part) => ({ ...part })),
    wiring: createGeneratedPowerWiring(design),
    stats,
    combatStyle: "hold"
  };
  initComponentState(ship);
  initializeComponentPower(ship);
  initShipHeat(ship);
  return ship;
}

function makeScenario(groups) {
  const players = new Map();
  const ships = [];
  for (const [id, list] of Object.entries(groups)) {
    players.set(id, { id, team: id === "p1" ? "A" : "B", ships: list });
    ships.push(...list);
  }
  const room = {
    world: { width: 6000, height: 4000 },
    map: { asteroids: [] },
    ships: new Map(ships.map((ship) => [ship.id, ship])),
    players,
    stations: [],
    stationsById: new Map(),
    effects: []
  };
  buildRoomSpatialIndex(room, ships, 0);
  return { room, ships, players };
}

function simulate(room, ships, seconds, onTick = null) {
  const ticks = Math.round(seconds / DT);
  for (let tick = 0; tick < ticks; tick += 1) {
    const now = tick * DT * 1000;
    buildRoomSpatialIndex(room, ships, now);
    for (const ship of ships) updateShipMovement(room, ship, DT, now);
    updateShipSeparation(room, ships, DT, now);
    if (onTick) onTick(tick, now);
  }
}

function unwrap(angle, previous) {
  let value = angle;
  while (value - previous > Math.PI) value -= Math.PI * 2;
  while (previous - value > Math.PI) value += Math.PI * 2;
  return value;
}

function trackRotation(ship) {
  let previous = ship.angle;
  let total = 0;
  return {
    sample() {
      const unwrapped = unwrap(ship.angle, previous);
      total += unwrapped - previous;
      previous = unwrapped;
    },
    get total() { return total; }
  };
}

function speedOf(ship) {
  return Math.hypot(ship.vx, ship.vy);
}

function run() {
  // =======================================================================
  // Phase 5 -- turning inside a packed group
  // =======================================================================

  // Ships packed shoulder to shoulder, well inside each other's collision
  // circles' comfort zone, all told to rotate. Every one of them must turn.
  {
    const ships = [];
    for (let i = 0; i < 9; i += 1) {
      const column = i % 3;
      const row = Math.floor(i / 3);
      // Spacing below the sum of two collision radii, so every neighbour pair is
      // genuinely overlapping and the separation solver is active throughout.
      ships.push(makeShip(2000 + column * 70, 2000 + row * 70));
    }
    const { room, players } = makeScenario({ p1: ships });
    const player = players.get("p1");
    const contact = physicalCollisionRadius(ships[0]) * 2;
    assert(70 < contact, `the fixture should actually be packed (${contact.toFixed(0)} px of contact radius)`);

    rotateShips(room, player, { direction: 1, active: true, shipIds: ships.map((s) => s.id) });
    const trackers = ships.map(trackRotation);
    const startPositions = ships.map((ship) => ({ x: ship.x, y: ship.y }));
    simulate(room, ships, 2, () => trackers.forEach((tracker) => tracker.sample()));

    for (let i = 0; i < ships.length; i += 1) {
      assert(trackers[i].total > 1.5,
        `a packed group must still rotate: ${ships[i].id} turned only ${trackers[i].total.toFixed(2)} rad in 2 s`);
    }
    // Not angularly locked, and not violently flung apart either.
    const worstDrift = ships.reduce((worst, ship, index) => Math.max(worst,
      Math.hypot(ship.x - startPositions[index].x, ship.y - startPositions[index].y)), 0);
    assert(worstDrift < contact,
      `rotation should not produce violent separation (worst ship moved ${worstDrift.toFixed(1)} px)`);
  }

  // Turning one ship does not force the group to scatter, and a stopped
  // formation stays put.
  {
    const ships = [];
    for (let i = 0; i < 6; i += 1) {
      const column = i % 3;
      const row = Math.floor(i / 3);
      ships.push(makeShip(2000 + column * 120, 2000 + row * 120));
    }
    const { room, players } = makeScenario({ p1: ships });
    const player = players.get("p1");

    // Settle first.
    simulate(room, ships, 2);
    const settled = ships.map((ship) => ({ x: ship.x, y: ship.y }));

    rotateShips(room, player, { direction: -1, active: true, shipIds: [ships[4].id] });
    const tracker = trackRotation(ships[4]);
    simulate(room, ships, 3, () => tracker.sample());

    assert(Math.abs(tracker.total) > 2,
      `the single ship should have turned freely (${tracker.total.toFixed(2)} rad)`);
    for (let i = 0; i < ships.length; i += 1) {
      if (i === 4) continue;
      const moved = Math.hypot(ships[i].x - settled[i].x, ships[i].y - settled[i].y);
      assert(moved < 2,
        `turning one ship must not scatter the group: ${ships[i].id} moved ${moved.toFixed(2)} px`);
    }
  }

  // Ships do not spin continuously once the key is released, and small overlaps
  // resolve gradually rather than exploding.
  {
    const a = makeShip(2000, 2000);
    const b = makeShip(2000 + physicalCollisionRadius(makeShip(0, 0)) * 2 - 12, 2000);
    const { room } = makeScenario({ p1: [a, b] });
    const overlapBefore = physicalCollisionRadius(a) + physicalCollisionRadius(b)
      - Math.hypot(b.x - a.x, b.y - a.y);
    assert(overlapBefore > 0, "the fixture should start overlapping");

    let worstStep = 0;
    let previous = { ax: a.x, bx: b.x };
    simulate(room, [a, b], 5, () => {
      worstStep = Math.max(worstStep, Math.abs(a.x - previous.ax), Math.abs(b.x - previous.bx));
      previous = { ax: a.x, bx: b.x };
    });
    const gap = Math.hypot(b.x - a.x, b.y - a.y);
    assert(gap >= physicalCollisionRadius(a) + physicalCollisionRadius(b) - 1,
      `a small overlap should resolve (${gap.toFixed(1)} px apart)`);
    assert(worstStep < overlapBefore,
      `it should resolve gradually, not in one shove (worst single-tick move ${worstStep.toFixed(1)} px for a ${overlapBefore.toFixed(1)} px overlap)`);
    const rotation = Math.abs(a.angle) + Math.abs(b.angle);
    assert(rotation < 0.05, `separation must not spin ships (${rotation.toFixed(3)} rad of rotation)`);
  }

  // =======================================================================
  // Phase 6 -- predictive avoidance
  // =======================================================================

  // Head-on. Exactly one ship yields, both get through, and neither weaves.
  {
    const a = makeShip(1500, 2000, 0);
    const b = makeShip(3500, 2000, Math.PI);
    const { room, players } = makeScenario({ p1: [a], p2: [b] });
    commandShips(room, players.get("p1"), 3800, 2000, { shipIds: [a.id] });
    commandShips(room, players.get("p2"), 1200, 2000, { shipIds: [b.id] });

    let closest = Infinity;
    const sideChanges = { a: 0, b: 0 };
    let previousSide = { a: 0, b: 0 };
    simulate(room, [a, b], 40, () => {
      closest = Math.min(closest, Math.hypot(a.x - b.x, a.y - b.y));
      for (const [key, ship] of [["a", a], ["b", b]]) {
        const side = Math.sign(ship._avoidance?.side || 0);
        if (side !== 0 && previousSide[key] !== 0 && side !== previousSide[key]) sideChanges[key] += 1;
        if (side !== 0) previousSide[key] = side;
      }
    });

    const contact = physicalCollisionRadius(a) + physicalCollisionRadius(b);
    assert(closest > contact,
      `head-on ships should pass without touching (closest ${closest.toFixed(1)} px vs ${contact.toFixed(1)} px of hull)`);
    assert(Math.hypot(a.x - 3800, a.y - 2000) <= ARRIVE_DISTANCE + 8,
      `ship A should still reach its destination (${Math.hypot(a.x - 3800, a.y - 2000).toFixed(1)} px away)`);
    assert(Math.hypot(b.x - 1200, b.y - 2000) <= ARRIVE_DISTANCE + 8,
      `ship B should still reach its destination (${Math.hypot(b.x - 1200, b.y - 2000).toFixed(1)} px away)`);
    assert(sideChanges.a + sideChanges.b <= 2,
      `avoidance must not flip sides repeatedly (${sideChanges.a + sideChanges.b} changes)`);
  }

  // Crossing at 90 degrees. One deterministic ship yields -- and the same one
  // every time, from the same setup.
  {
    const runCrossing = () => {
      shipSeq = 0;
      const a = makeShip(1500, 2000, 0);
      const b = makeShip(2600, 900, Math.PI / 2);
      const { room, players } = makeScenario({ p1: [a], p2: [b] });
      commandShips(room, players.get("p1"), 3700, 2000, { shipIds: [a.id] });
      commandShips(room, players.get("p2"), 2600, 3100, { shipIds: [b.id] });
      let closest = Infinity;
      const yielded = { a: false, b: false };
      simulate(room, [a, b], 40, () => {
        closest = Math.min(closest, Math.hypot(a.x - b.x, a.y - b.y));
        if (a._avoidance?.side) yielded.a = true;
        if (b._avoidance?.side) yielded.b = true;
      });
      return { a, b, closest, yielded };
    };

    const first = runCrossing();
    const contact = physicalCollisionRadius(first.a) + physicalCollisionRadius(first.b);
    assert(first.closest > contact,
      `crossing ships should not collide (closest ${first.closest.toFixed(1)} px)`);
    assert(first.yielded.a !== first.yielded.b,
      "exactly one ship of a crossing pair should give way");
    assert(Math.hypot(first.a.x - 3700, first.a.y - 2000) <= ARRIVE_DISTANCE + 8,
      "the crossing ship A should still arrive");
    assert(Math.hypot(first.b.x - 2600, first.b.y - 3100) <= ARRIVE_DISTANCE + 8,
      "the crossing ship B should still arrive");

    const second = runCrossing();
    assert.strictEqual(second.yielded.a, first.yielded.a,
      "which ship yields must be deterministic");
  }

  // Avoidance never speeds a ship up, and a group does not mill about.
  {
    const ships = [];
    for (let i = 0; i < 6; i += 1) ships.push(makeShip(1200, 1400 + i * 150, 0));
    const { room, players } = makeScenario({ p1: ships });
    commandShips(room, players.get("p1"), 3600, 2000, { shipIds: ships.map((s) => s.id) });
    let peak = 0;
    simulate(room, ships, 60, () => {
      for (const ship of ships) peak = Math.max(peak, speedOf(ship));
    });
    const cap = Math.max(...ships.map((ship) => ship.stats.maxSpeed));
    assert(peak <= cap + 1, `avoidance must never raise speed above the hull cap (${peak.toFixed(1)} vs ${cap.toFixed(1)})`);
    for (const ship of ships) {
      const off = Math.hypot(ship.x - orderedDestination(ship).x, ship.y - orderedDestination(ship).y);
      assert(off <= ARRIVE_DISTANCE + 10,
        `a group should settle rather than mill: ${ship.id} is ${off.toFixed(1)} px off station`);
    }
  }

  // A rotating ship surrounded by stopped friendlies must not panic.
  {
    const centre = makeShip(2000, 2000, 0);
    const neighbours = [
      makeShip(2000 + 110, 2000), makeShip(2000 - 110, 2000),
      makeShip(2000, 2000 + 110), makeShip(2000, 2000 - 110)
    ];
    const ships = [centre, ...neighbours];
    const { room, players } = makeScenario({ p1: ships });
    rotateShips(room, players.get("p1"), { direction: 1, active: true, shipIds: [centre.id] });
    const tracker = trackRotation(centre);
    simulate(room, ships, 3, () => tracker.sample());
    assert(Math.abs(tracker.total) > 2,
      `a surrounded ship should still rotate (${tracker.total.toFixed(2)} rad)`);
    assert(!centre._avoidance?.side,
      "stopped friendlies must not trigger avoidance on a ship turning in place");
  }

  // =======================================================================
  // Phase 7 -- explicit targeting
  // =======================================================================

  // Right-clicking an enemy names a target; it does not become a move order to
  // the point underneath it.
  {
    const attacker = makeShip(1500, 2000, 0, ARMED_DESIGN, "p1");
    const enemy = makeShip(3200, 2000, Math.PI, DESIGN, "p2");
    const { room, players } = makeScenario({ p1: [attacker], p2: [enemy] });

    const result = commandShips(room, players.get("p1"), enemy.x, enemy.y, {
      shipIds: [attacker.id],
      targetId: enemy.id
    });
    assert.strictEqual(result.code, "attack", "clicking an enemy should issue an attack order");
    assert.strictEqual(attacker.movement.command.type, "attack");
    assert.strictEqual(attacker.movement.command.targetId, enemy.id);
    assert.strictEqual(attacker.movement.command.destination, null,
      "an attack order must not carry the clicked point as a destination");
    assert.strictEqual(attacker.focusTargetId, enemy.id,
      "the named target should become the explicit focus, which outranks automatic acquisition");

    // Under Hold it closes only far enough to shoot, and stops there.
    simulate(room, [attacker, enemy], 40);
    const range = Math.hypot(attacker.x - enemy.x, attacker.y - enemy.y);
    const contact = physicalCollisionRadius(attacker) + physicalCollisionRadius(enemy);
    assert(range > contact + 20,
      `it should stand off, not ram (${range.toFixed(1)} px from a ${contact.toFixed(1)} px contact)`);
    assert(speedOf(attacker) < 2,
      `it should settle at firing range (still doing ${speedOf(attacker).toFixed(1)} px/s)`);
    // ...and it points at what it is shooting.
    const bearing = Math.atan2(enemy.y - attacker.y, enemy.x - attacker.x);
    let facing = attacker.angle - bearing;
    while (facing > Math.PI) facing -= Math.PI * 2;
    while (facing < -Math.PI) facing += Math.PI * 2;
    assert(Math.abs(facing) < 0.1,
      `a firing ship should face its target (${(facing * 180 / Math.PI).toFixed(1)} deg off)`);
  }

  // A target that is out of reach is closed on; the destination is derived from
  // the target, and follows it.
  {
    const attacker = makeShip(600, 2000, 0, ARMED_DESIGN, "p1");
    const enemy = makeShip(4200, 2000, Math.PI, DESIGN, "p2");
    const { room, players } = makeScenario({ p1: [attacker], p2: [enemy] });
    commandShips(room, players.get("p1"), enemy.x, enemy.y, {
      shipIds: [attacker.id],
      targetId: enemy.id
    });
    simulate(room, [attacker, enemy], 1);
    assert(orderedDestination(attacker),
      "an out-of-range attacker should be given somewhere to close to");
    const firstApproach = { ...orderedDestination(attacker) };
    assert(Math.hypot(firstApproach.x - enemy.x, firstApproach.y - enemy.y) > 100,
      "the approach point should stand off the target, not sit on it");

    // Move the target; the approach point must follow it.
    enemy.y = 2600;
    simulate(room, [attacker, enemy], 1);
    assert(Math.abs(orderedDestination(attacker).y - firstApproach.y) > 20,
      "the approach point should track the target as it moves");
  }

  // Losing the target clears the explicit target and the order with it.
  {
    const attacker = makeShip(1500, 2000, 0, ARMED_DESIGN, "p1");
    const enemy = makeShip(3200, 2000, Math.PI, DESIGN, "p2");
    const { room, players } = makeScenario({ p1: [attacker], p2: [enemy] });
    commandShips(room, players.get("p1"), enemy.x, enemy.y, {
      shipIds: [attacker.id],
      targetId: enemy.id
    });
    simulate(room, [attacker, enemy], 2);
    assert.strictEqual(attacker.movement.command.type, "attack", "should be engaging");

    enemy.alive = false;
    simulate(room, [attacker], 1);
    assert.strictEqual(attacker.movement.command, null,
      "destroying the target should clear the order");
    assert.strictEqual(attacker.focusTargetId, null,
      "destroying the target should clear the explicit focus");
    simulate(room, [attacker], 10);
    assert(speedOf(attacker) < 2, "a ship whose target died should come to rest, not keep driving");
  }

  // An ordinary move click near an enemy is still a move, not an attack.
  {
    const mover = makeShip(1500, 2000, 0, ARMED_DESIGN, "p1");
    const enemy = makeShip(3200, 2000, Math.PI, DESIGN, "p2");
    const { room, players } = makeScenario({ p1: [mover], p2: [enemy] });
    const result = commandShips(room, players.get("p1"), 3200, 2400, { shipIds: [mover.id] });
    assert.strictEqual(result.code, "move", "a click on empty space is a move order");
    assert.strictEqual(mover.movement.command.type, "move");
    assert.strictEqual(mover.focusTargetId, null,
      "a move order must not name a target");
  }

  console.log("verify-movement-phase567: OK");
}

run();
