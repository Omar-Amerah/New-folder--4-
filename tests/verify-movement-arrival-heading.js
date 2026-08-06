"use strict";

// Which way a ship points once it has finished going somewhere.
//
// A right-click on empty space is one instruction: go there and stop. It used
// to be silently expanded into two -- go there, and finish pointing the way the
// fleet was originally facing -- and then a third source, automatic combat
// facing, was allowed to override that on the arrival tick. The result was a
// hull that flew a route, parked, and then rotated for no reason the player
// could see, sometimes through a full half-turn.
//
// These tests pin the hand-off: a plain move ends on the heading the ship
// actually arrived on, nothing that was not asked for turns it afterwards, and
// the orders that ARE about facing something still do.

const assert = require("node:assert/strict");
const { movementTestTick } = require("../tools/movementTestTick");
const { commandShips, updateShipMovement } = require("../src/server/movement");
const { computeStats } = require("../src/server/shipStats");
const { initComponentState } = require("../src/server/componentHealth");
const { initializeComponentPower } = require("../src/server/componentPower");
const { initShipHeat } = require("../src/server/heat");
const { createGeneratedPowerWiring } = require("../src/server/shipDesign");
const { computeDesignCollisionRadius } = require("../src/server/componentGeometry");
const { getMaxEffectiveWeaponRange } = require("../src/server/componentData");

const DT = 1 / 30;

const GUNSHIP = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" },
  { x: 6, y: 7, type: "blaster" }
];

// A maneuver thruster mounted below the centre of mass puts all its torque on
// one side, so this design turns left several times faster than it turns right.
// That asymmetry is the whole point of it: it is what makes "which way round"
// an answerable question rather than a coin toss.
const LEFT_HANDED = [...GUNSHIP, { x: 6, y: 9, rotation: 90, type: "maneuverThruster" }];

let sequence = 0;

function makeShip({ x, y, angle = 0, design = GUNSHIP, ownerId = "p1", team = "A" }) {
  const stats = computeStats(design);
  const ship = {
    id: `arr-${++sequence}`,
    ownerId,
    team,
    alive: true,
    removed: false,
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

function makeRoom(ships, asteroids = []) {
  const players = new Map();
  for (const ship of ships) {
    const existing = players.get(ship.ownerId);
    if (existing) existing.ships.push(ship);
    else players.set(ship.ownerId, { id: ship.ownerId, team: ship.team, ships: [ship] });
  }
  return {
    phase: "active",
    world: { width: 12000, height: 9000 },
    map: { asteroids, relays: [], revision: 1 },
    ships: new Map(ships.map((ship) => [ship.id, ship])),
    players,
    stations: [],
    stationsById: new Map(),
    drones: new Map(),
    bullets: [],
    effects: [],
    spawnCollisionDiagnostics: {}
  };
}

function tick(room, ships, count, onTick = null) {
  for (let index = 0; index < count; index += 1) {
    movementTestTick(room, ships, DT, index * DT * 1000);
    if (onTick) onTick(index);
  }
}

function angleDelta(a, b) {
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

const facingErrorTo = (ship, point) =>
  Math.abs(angleDelta(ship.angle, Math.atan2(point.y - ship.y, point.x - ship.x)));

function moveTo(room, ship, x, y, options = {}) {
  return commandShips(room, room.players.get(ship.ownerId), x, y, {
    shipIds: [ship.id],
    ...options
  });
}

function run() {
  // --- a plain move is a move, not a move-and-face ---------------------------
  {
    const ship = makeShip({ x: 1000, y: 1000 });
    const room = makeRoom([ship]);
    moveTo(room, ship, 3000, 1000);
    assert.equal(ship.movement.command.finalFacing, null,
      "an ordinary right-click must not smuggle a facing into the order");

    tick(room, [ship], 400);
    assert.ok(Math.hypot(ship.x - 3000, ship.y - 1000) < 60, "the ship arrives");
    assert.ok(ship.movement.orderComplete, "and the order is marked done");
    assert.ok(Number.isFinite(ship.movement.arrivalHeading),
      "arriving latches the heading it settled on");
    assert.ok(Math.abs(angleDelta(ship.angle, 0)) < 0.15,
      "a ship sent straight ahead ends up still pointing straight ahead");
  }

  // --- an enemy behind does not spin a parked ship round ---------------------
  {
    // The enemy sits behind the destination-bound ship and well inside weapon
    // range, so the stance has every reason to want the nose on it. Nobody
    // ordered that, and the ship was told to go somewhere and stop.
    const ship = makeShip({ x: 1000, y: 1000 });
    const range = getMaxEffectiveWeaponRange(ship);
    assert.ok(range > 200, "fixture sanity: the gunship has a usable weapon range");
    const destination = { x: 1000 + range * 4, y: 1000 };
    const enemy = makeShip({ x: destination.x - range * 0.5, y: 1000, ownerId: "p2", team: "B" });
    const room = makeRoom([ship, enemy]);
    // Enemy dead astern of where the ship will end up.
    enemy.x = destination.x + range * 0.5;
    enemy.vx = 0;
    moveTo(room, ship, destination.x, destination.y);
    // Auto-acquisition, not an order: this is exactly the target the player
    // never picked.
    ship.combatTargetId = enemy.id;

    tick(room, [ship], 600, () => { ship.combatTargetId = enemy.id; });
    assert.ok(ship.movement.orderComplete, "the move completed");
    // The enemy is ahead in this arrangement; flip it so it is behind and let
    // the ship sit there being provoked.
    enemy.x = ship.x - range * 0.5;
    const settled = ship.angle;
    tick(room, [ship], 300, () => { ship.combatTargetId = enemy.id; });
    assert.ok(Math.abs(angleDelta(settled, ship.angle)) < 0.1,
      "a target nobody ordered it to fight does not turn a ship that has finished its move");
  }

  // --- an explicit facing is still obeyed ------------------------------------
  {
    const ship = makeShip({ x: 2000, y: 2000 });
    const room = makeRoom([ship]);
    moveTo(room, ship, 2000, 2000, { finalFacing: Math.PI / 2 });
    assert.ok(Number.isFinite(ship.movement.command.finalFacing),
      "a facing the player asked for reaches the order");
    tick(room, [ship], 200);
    assert.ok(Math.abs(angleDelta(ship.angle, Math.PI / 2)) < 0.05,
      "and the ship turns to it");
  }

  // --- a detour does not snap back to the original route bearing -------------
  {
    // The straight line to the destination is blocked, so the ship arrives on
    // whatever heading the last leg of the detour left it on. The old default
    // would have rotated it onto the bearing the route was planned with, which
    // it stopped flying several waypoints ago.
    const ship = makeShip({ x: 1000, y: 3000 });
    const room = makeRoom([ship], [{ id: "rock", x: 2600, y: 3000, radius: 700 }]);
    const destination = { x: 4400, y: 2100 };
    const result = moveTo(room, ship, destination.x, destination.y);
    const plannedDirection = result.plan.direction;

    tick(room, [ship], 900);
    assert.ok(Math.hypot(ship.x - destination.x, ship.y - destination.y) < 80,
      "the ship gets round the rock and arrives");
    const arrival = ship.movement.arrivalHeading;
    assert.ok(Number.isFinite(arrival), "the arrival heading is latched");
    assert.ok(Math.abs(angleDelta(ship.angle, arrival)) < 0.05,
      "and is what the parked hull holds -- not the bearing the route was planned with");

    // The two only need to differ for the test to be about anything. If a
    // detour ever stops changing the arrival heading, this stops proving the
    // regression and should be rebuilt around a route that does.
    assert.ok(Math.abs(angleDelta(arrival, plannedDirection)) > 0.05,
      "fixture sanity: the detour really did leave the ship off the planned bearing");
  }

  // --- a completed move stays completed through a shove ----------------------
  {
    const ship = makeShip({ x: 5000, y: 5000 });
    const room = makeRoom([ship]);
    moveTo(room, ship, 5400, 5000);
    tick(room, [ship], 300);
    assert.ok(ship.movement.orderComplete, "the move completed");
    const settled = ship.angle;

    // Separation, collision correction and contact safety all move a parked
    // hull without changing its orders. Simulated here by displacing it well
    // outside the arrival envelope, which is what used to reopen the order.
    ship.x += 400;
    ship.y += 400;
    updateShipMovement(room, ship, DT, 0);
    assert.ok(ship.movement.orderComplete,
      "being pushed off the point does not un-carry-out the order");
    tick(room, [ship], 300);
    assert.ok(Math.abs(angleDelta(settled, ship.angle)) < 0.35,
      "and the ship does not re-derive its nose direction from the route on the way back");
  }

  // --- an about-face turns the way the hull turns faster ---------------------
  {
    // Dead astern: there is no shorter side. Signed shortest-angle maths breaks
    // that tie at +PI, so before this every about-face went right regardless of
    // which side the ship could actually turn on.
    const ship = makeShip({ x: 6000, y: 6000, angle: 0, design: LEFT_HANDED });
    assert.ok(ship.stats.turnRateLeft > ship.stats.turnRateRight * 1.5,
      "fixture sanity: this hull turns left much faster than right");
    const room = makeRoom([ship]);
    moveTo(room, ship, 6000, 6000, { finalFacing: Math.PI });

    tick(room, [ship], 5);
    assert.ok(ship.angle < 0,
      "the tie is resolved onto the side the ship can actually turn on");
    tick(room, [ship], 200);
    assert.ok(Math.abs(angleDelta(ship.angle, Math.PI)) < 0.05,
      "and it still gets all the way round");
  }

  // --- the heading does not hunt between sources ----------------------------
  {
    const ship = makeShip({ x: 8000, y: 4000 });
    const enemy = makeShip({ x: 8000, y: 4600, ownerId: "p2", team: "B" });
    const room = makeRoom([ship, enemy]);
    moveTo(room, ship, 9200, 4000);
    tick(room, [ship, enemy], 500, () => { ship.combatTargetId = enemy.id; });
    assert.ok(ship.movement.orderComplete, "the move completed");

    let worst = 0;
    let previous = ship.angle;
    tick(room, [ship, enemy], 300, () => {
      worst = Math.max(worst, Math.abs(angleDelta(previous, ship.angle)));
      previous = ship.angle;
    });
    assert.ok(worst < 0.01,
      "a parked ship holds one heading rather than alternating between route, arrival and combat answers");
  }

  // --- orders that ARE about facing something still face it -----------------
  {
    const ship = makeShip({ x: 3000, y: 8000 });
    const enemy = makeShip({ x: 2400, y: 8000, ownerId: "p2", team: "B" });
    const room = makeRoom([ship, enemy]);
    // Nose pointing away from the target, so obeying the order is a visible
    // turn rather than the state it started in.
    ship.angle = 0;
    const result = commandShips(room, room.players.get("p1"), enemy.x, enemy.y, {
      shipIds: [ship.id],
      targetId: enemy.id
    });
    assert.equal(result.code, "attack", "clicking an enemy issues an attack order");

    tick(room, [ship, enemy], 400);
    assert.ok(facingErrorTo(ship, enemy) < Math.PI / 2,
      "an attack order still brings the guns round onto the target");
  }

  console.log("movement arrival heading: OK");
}

run();
