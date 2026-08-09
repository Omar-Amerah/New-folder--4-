"use strict";

// Queued move orders for a single ship.
//
// A shift-click behind a move already in progress adds a leg rather than
// replacing the order: the ship flies the points in the order they were given,
// one real move command at a time, with the full route planner behind each one.
//
// The rule that shapes all of this is that a course belongs to ONE hull. With a
// group selected there is no queue and nothing changes -- the click is the same
// formation move it has always been -- because a list of points is not something
// a formation can fly without deciding, per ship, what "the shape" means at each
// stop. That decision does not exist, so the queue is refused rather than
// guessed at.

const assert = require("node:assert/strict");
const { movementTestTick } = require("../tools/movementTestTick");
const { commandShips, stopShips, MAX_QUEUED_WAYPOINTS } = require("../src/server/movement");
const { computeStats } = require("../src/server/shipStats");
const { initComponentState } = require("../src/server/componentHealth");
const { initializeComponentPower } = require("../src/server/componentPower");
const { initShipHeat } = require("../src/server/heat");
const { computeDesignCollisionRadius } = require("../src/server/componentGeometry");
const { validateClientMessage } = require("../src/server/clientSchemas");

const DT = 1 / 30;

const GUNSHIP = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" },
  { x: 6, y: 7, type: "blaster" }
];

let sequence = 0;

function makeShip({ x, y, ownerId = "p1", team = "A" }) {
  const stats = computeStats(GUNSHIP);
  const ship = {
    id: `wpq-${++sequence}`,
    ownerId,
    team,
    alive: true,
    removed: false,
    x,
    y,
    vx: 0,
    vy: 0,
    angle: 0,
    targetX: x,
    targetY: y,
    radius: stats.radius,
    physicalRadius: computeDesignCollisionRadius(GUNSHIP, stats),
    design: GUNSHIP.map((part) => ({ ...part })),
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

function tick(room, ships, count) {
  for (let index = 0; index < count; index += 1) {
    movementTestTick(room, ships, DT, index * DT * 1000);
  }
}

function command(room, ships, x, y, options = {}) {
  const owner = room.players.get(ships[0].ownerId);
  return commandShips(room, owner, x, y, { shipIds: ships.map((ship) => ship.id), ...options });
}

const near = (ship, x, y, tolerance = 80) => Math.hypot(ship.x - x, ship.y - y) <= tolerance;

function run() {
  // --- the wire carries the flag --------------------------------------------
  {
    assert.ok(validateClientMessage({ type: "command", x: 10, y: 10, append: true }).ok,
      "append is part of the command message");
    assert.ok(!validateClientMessage({ type: "command", x: 10, y: 10, append: "yes" }).ok,
      "...and only as a boolean");
  }

  // --- one ship, one course --------------------------------------------------
  {
    const ship = makeShip({ x: 1000, y: 1000 });
    const room = makeRoom([ship]);
    command(room, [ship], 3000, 1000);
    const queued = command(room, [ship], 3000, 3000, { append: true });
    assert.equal(queued.code, "queued", "a shift-click behind a live move is queued");
    assert.equal(ship.movement.queuedWaypoints.length, 1);
    // The order being flown is untouched: this added a leg, it did not replace one.
    assert.ok(near({ x: ship.movement.destination.x, y: ship.movement.destination.y }, 3000, 1000),
      "the leg in progress still runs to the first point");

    tick(room, [ship], 1200);
    assert.ok(near(ship, 3000, 3000),
      `the ship flies both legs and finishes on the last (${ship.x.toFixed(0)}, ${ship.y.toFixed(0)})`);
    assert.equal(ship.movement.queuedWaypoints.length, 0, "and the queue empties as it goes");
  }

  // --- the legs are flown in order, not as the crow flies --------------------
  {
    // A course whose corner is nowhere near the straight line between its ends.
    // If the queue were ignored -- or collapsed to its last point -- the ship
    // would never come anywhere near the corner.
    const ship = makeShip({ x: 1000, y: 5000 });
    const room = makeRoom([ship]);
    command(room, [ship], 1000, 1500);
    command(room, [ship], 4500, 1500, { append: true });
    let reachedCorner = false;
    for (let index = 0; index < 1600; index += 1) {
      movementTestTick(room, [ship], DT, index * DT * 1000);
      if (near(ship, 1000, 1500, 120)) reachedCorner = true;
    }
    assert.ok(reachedCorner, "the ship visits the corner it was sent through");
    assert.ok(near(ship, 4500, 1500), "and ends at the last point of the course");
  }

  // --- a mid-course point is flown through, not stopped at -------------------
  {
    // Three points in a straight line. There is nothing to slow down for, so a
    // ship that dips anywhere near a standstill at the middle one is treating it
    // as a destination and waiting to be told about the rest of the course --
    // which is a course flown as a series of separate journeys.
    const ship = makeShip({ x: 1000, y: 1000 });
    const room = makeRoom([ship]);
    command(room, [ship], 4000, 1000);
    command(room, [ship], 7000, 1000, { append: true });

    let cruise = 0;
    let slowestUnderway = Infinity;
    let handedOver = false;
    for (let index = 0; index < 2500; index += 1) {
      movementTestTick(room, [ship], DT, index * DT * 1000);
      const speed = Math.hypot(ship.vx, ship.vy);
      cruise = Math.max(cruise, speed);
      if (ship.movement.queuedWaypoints.length === 0) handedOver = true;
      // Measured across the hand-over only: the run up to speed at the start and
      // the braking onto the final point are both legitimate.
      const nearMiddle = Math.abs(ship.x - 4000) < 900;
      if (cruise > 50 && nearMiddle) slowestUnderway = Math.min(slowestUnderway, speed);
      if (handedOver && near(ship, 7000, 1000)) break;
    }
    assert.ok(near(ship, 7000, 1000), "the ship finishes the course");
    assert.ok(slowestUnderway > cruise * 0.7,
      `it keeps its speed through the middle point (${slowestUnderway.toFixed(0)} of ${cruise.toFixed(0)} px/s)`);
  }

  // --- and it turns a corner without parking on it ---------------------------
  {
    // A right-angle corner does cost speed -- the hull has to be able to make the
    // turn -- but it is a corner, not a stop.
    const ship = makeShip({ x: 1000, y: 1000 });
    const room = makeRoom([ship]);
    command(room, [ship], 5000, 1000);
    command(room, [ship], 5000, 5000, { append: true });
    let stopped = false;
    let cruise = 0;
    for (let index = 0; index < 2500; index += 1) {
      movementTestTick(room, [ship], DT, index * DT * 1000);
      const speed = Math.hypot(ship.vx, ship.vy);
      cruise = Math.max(cruise, speed);
      if (cruise > 50 && ship.movement.queuedWaypoints.length > 0 && speed < 4) stopped = true;
      if (ship.movement.queuedWaypoints.length === 0 && near(ship, 5000, 5000)) break;
    }
    assert.ok(!stopped, "the ship never comes to rest while it still has a leg queued");
    assert.ok(near(ship, 5000, 5000), "and it rounds the corner onto the last point");
  }

  // --- a plain click replaces the course -------------------------------------
  {
    const ship = makeShip({ x: 1000, y: 1000 });
    const room = makeRoom([ship]);
    command(room, [ship], 3000, 1000);
    command(room, [ship], 3000, 3000, { append: true });
    command(room, [ship], 1500, 4000);
    assert.equal(ship.movement.queuedWaypoints.length, 0,
      "an unmodified order is the player starting again, not adding to the old course");
    tick(room, [ship], 900);
    assert.ok(near(ship, 1500, 4000), "and the ship flies the new order only");
  }

  // --- a stop ends the course ------------------------------------------------
  {
    const ship = makeShip({ x: 1000, y: 1000 });
    const room = makeRoom([ship]);
    command(room, [ship], 5000, 1000);
    command(room, [ship], 5000, 4000, { append: true });
    tick(room, [ship], 30);
    stopShips(room, room.players.get("p1"), [ship.id]);
    assert.equal(ship.movement.queuedWaypoints.length, 0, "stopping drops what was queued");
    tick(room, [ship], 400);
    assert.ok(!near(ship, 5000, 4000, 400), "and the ship does not resume the course");
  }

  // --- a group keeps the behaviour it already had ----------------------------
  {
    const ships = [
      makeShip({ x: 1000, y: 1000 }),
      makeShip({ x: 1000, y: 1200 }),
      makeShip({ x: 1000, y: 1400 })
    ];
    const room = makeRoom(ships);
    const first = command(room, ships, 4000, 2000);
    assert.equal(first.code, "move");
    assert.equal(first.formation, "clump", "a fleet move is still a formation move");
    const second = command(room, ships, 4000, 4000, { append: true });
    assert.equal(second.code, "move", "shift changes nothing for a group");
    assert.ok(ships.every((ship) => ship.movement.queuedWaypoints.length === 0),
      "no ship in a group carries a queue");
    assert.ok(ships.every((ship) => ship.movement.command.formation?.type === "clump"),
      "and every one of them keeps its formation slot");
    tick(room, ships, 1400);
    assert.ok(ships.every((ship) => near(ship, 4000, 4000, 400)),
      "the group flies the latest order, as it always did");
  }

  // --- a solo move carries no formation --------------------------------------
  {
    const ship = makeShip({ x: 1000, y: 1000 });
    const room = makeRoom([ship]);
    const result = command(room, [ship], 4000, 4000);
    assert.equal(result.commanded, 1);
    assert.equal(ship.movement.command.formation, null,
      "one ship is steered, not arranged: there is no shape for it to hold");
  }

  // --- the queue is bounded --------------------------------------------------
  {
    const ship = makeShip({ x: 1000, y: 1000 });
    const room = makeRoom([ship]);
    command(room, [ship], 8000, 1000);
    let refused = null;
    for (let index = 0; index < MAX_QUEUED_WAYPOINTS + 4; index += 1) {
      const result = command(room, [ship], 8000, 1200 + index * 40, { append: true });
      if (result.code === "queue-full") refused = result;
    }
    assert.ok(refused, "the queue refuses to grow without end");
    assert.equal(ship.movement.queuedWaypoints.length, MAX_QUEUED_WAYPOINTS);
  }

  // --- appending to nothing starts a course ----------------------------------
  {
    const ship = makeShip({ x: 1000, y: 1000 });
    const room = makeRoom([ship]);
    const result = command(room, [ship], 3000, 1000, { append: true });
    assert.equal(result.code, "move",
      "a shift-click with no move running is an ordinary order, not a queued one");
    assert.equal(ship.movement.queuedWaypoints.length, 0);
  }

  console.log("movement waypoint queue: OK");
}

run();
