"use strict";

// Route following under retained momentum.
//
// A ship that carries momentum misses things a ship whose velocity was rebuilt
// on its hull angle never missed: waypoint capture circles, the inside of a
// corner, the middle of a gap. These tests are about the follower coping with
// that without either cutting into obstacles or giving up.

const assert = require("node:assert/strict");
const { movementTestTick } = require("./tools/movementTestTick");
const { commandShips, physicalCollisionRadius } = require("./src/server/movement");
const { ARRIVE_DISTANCE } = require("./src/server/movementTuning");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { computeDesignCollisionRadius } = require("./src/server/componentGeometry");

const DT = 1 / 30;
const LIGHT = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" }
];
// Heavy and slow to turn: the hull that actually overshoots a corner.
const HEAVY = [
  ...LIGHT,
  { x: 6, y: 6, type: "frame" },
  { x: 9, y: 6, type: "frame" },
  { x: 6, y: 9, type: "frame" },
  { x: 9, y: 9, type: "frame" },
  { x: 6, y: 7, type: "frame" },
  { x: 9, y: 7, type: "frame" }
];

let sequence = 0;

function makeShip({ x, y, angle = 0, design = LIGHT }) {
  const stats = computeStats(design);
  const ship = {
    id: `nav-${++sequence}`,
    ownerId: "p1",
    team: "A",
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
  return {
    phase: "active",
    world: { width: 8000, height: 6000 },
    map: { asteroids, relays: [], revision: 1 },
    ships: new Map(ships.map((ship) => [ship.id, ship])),
    players: new Map([["p1", { id: "p1", team: "A", ships: [...ships] }]]),
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

function distanceTo(ship, x, y) {
  return Math.hypot(ship.x - x, ship.y - y);
}

function worstAsteroidClearance(ship, asteroids) {
  let worst = Infinity;
  for (const asteroid of asteroids) {
    worst = Math.min(
      worst,
      Math.hypot(ship.x - asteroid.x, ship.y - asteroid.y)
        - asteroid.radius
        - physicalCollisionRadius(ship)
    );
  }
  return worst;
}

function run() {
  // --- a missed capture circle still releases the waypoint -----------------
  {
    // A heavy hull at speed, on a route with several legs. It will not thread
    // every capture circle; what matters is that a waypoint it has flown past
    // is released rather than turned back for.
    const asteroids = [
      { id: "a", x: 1700, y: 1500, radius: 260 },
      { id: "b", x: 2400, y: 2150, radius: 300 },
      { id: "c", x: 3100, y: 1450, radius: 240 }
    ];
    const ship = makeShip({ x: 700, y: 1800, design: HEAVY });
    const room = makeRoom([ship], asteroids);
    const destination = { x: 4200, y: 1800 };
    commandShips(room, room.players.get("p1"), destination.x, destination.y, { shipIds: [ship.id] });
    tick(room, [ship], 1);
    assert(ship.movement.path.length >= 3,
      `the obstacles should force a multi-leg route (${ship.movement.path.length})`);

    const capture = Math.max(ARRIVE_DISTANCE, (physicalCollisionRadius(ship) + 8) * 0.75);
    let wideRelease = false;
    let retreated = false;
    let closest = Infinity;
    let routeKey = JSON.stringify(ship.movement.path);
    let index = ship.movement.waypointIndex;
    tick(room, [ship], 1200, () => {
      const key = JSON.stringify(ship.movement.path);
      const goal = ship.movement.path[ship.movement.waypointIndex];
      if (key !== routeKey) {
        routeKey = key;
        index = ship.movement.waypointIndex;
        closest = Infinity;
      } else if (ship.movement.waypointIndex > index) {
        // Released from outside its capture circle: the wide-miss path.
        if (closest > capture) wideRelease = true;
        index = ship.movement.waypointIndex;
        closest = Infinity;
      } else if (ship.movement.waypointIndex < index) {
        retreated = true;
      }
      if (goal) closest = Math.min(closest, Math.hypot(ship.x - goal.x, ship.y - goal.y));
    });

    assert(wideRelease,
      "sanity: a heavy hull at speed should miss at least one capture circle");
    assert.equal(retreated, false, "the follower must never step back to an earlier waypoint");
    assert(distanceTo(ship, destination.x, destination.y) <= ARRIVE_DISTANCE + 6,
      `the ship should still reach its destination (${distanceTo(ship, destination.x, destination.y).toFixed(0)} px away)`);
  }

  // --- ...but only when the next leg is actually clear ----------------------
  {
    const asteroid = { id: "corner", x: 2000, y: 1600, radius: 300 };
    const ship = makeShip({ x: 800, y: 2000, design: HEAVY });
    const room = makeRoom([ship], [asteroid]);
    commandShips(room, room.players.get("p1"), 3600, 1400, { shipIds: [ship.id] });
    tick(room, [ship], 1);
    const path = ship.movement.path.map((point) => ({ ...point }));
    assert(path.length > 1, "the asteroid should force a routed path");

    // Past the first waypoint, but on the wrong side of the rock: the leg to the
    // next waypoint is through the asteroid, so the waypoint stands.
    const first = path[0];
    ship.x = first.x + (first.x - asteroid.x) * -0.2;
    ship.y = first.y + (first.y - asteroid.y) * -0.2;
    ship.vx = 0;
    ship.vy = 0;
    const before = ship.movement.waypointIndex;
    tick(room, [ship], 1);
    assert(ship.movement.waypointIndex <= before + 1,
      "a blocked next leg must not let the follower skip ahead through the rock");
  }

  // --- a heavy hull rounds a corner without orbiting it ---------------------
  {
    const asteroid = { id: "orbit", x: 2200, y: 1500, radius: 340 };
    const ship = makeShip({ x: 700, y: 1500, design: HEAVY });
    const room = makeRoom([ship], [asteroid]);
    const destination = { x: 3900, y: 1500 };
    commandShips(room, room.players.get("p1"), destination.x, destination.y, { shipIds: [ship.id] });

    let worstClearance = Infinity;
    let sweptAroundAsteroid = 0;
    let previousBearing = Math.atan2(ship.y - asteroid.y, ship.x - asteroid.x);
    tick(room, [ship], 1400, () => {
      worstClearance = Math.min(worstClearance, worstAsteroidClearance(ship, [asteroid]));
      const bearing = Math.atan2(ship.y - asteroid.y, ship.x - asteroid.x);
      let step = bearing - previousBearing;
      while (step > Math.PI) step -= Math.PI * 2;
      while (step < -Math.PI) step += Math.PI * 2;
      sweptAroundAsteroid += step;
      previousBearing = bearing;
    });

    assert(distanceTo(ship, destination.x, destination.y) <= ARRIVE_DISTANCE + 6,
      `the heavy hull should round the corner and arrive (${distanceTo(ship, destination.x, destination.y).toFixed(0)} px away)`);
    assert(worstClearance > -0.5,
      `it must not be pushed inside the rock (worst ${worstClearance.toFixed(1)} px)`);
    // Going round one side of an obstacle is at most half a revolution. Anything
    // approaching a full turn is a ship circling a waypoint it keeps missing.
    assert(Math.abs(sweptAroundAsteroid) < Math.PI * 1.2,
      `the ship should pass the asteroid, not circle it (${(sweptAroundAsteroid / Math.PI).toFixed(2)} half-turns)`);
  }

  // --- several obstacles: A* stays the fallback, and does not thrash --------
  {
    const asteroids = [
      { id: "a", x: 1700, y: 1500, radius: 260 },
      { id: "b", x: 2400, y: 2150, radius: 300 },
      { id: "c", x: 3100, y: 1450, radius: 240 },
      { id: "d", x: 3800, y: 2100, radius: 220 }
    ];
    const ship = makeShip({ x: 700, y: 1800 });
    const room = makeRoom([ship], asteroids);
    const destination = { x: 4600, y: 1800 };
    commandShips(room, room.players.get("p1"), destination.x, destination.y, { shipIds: [ship.id] });
    tick(room, [ship], 1);
    assert(ship.movement.path.length > 1, "a blocked direct line should fall back to a route");

    let worstClearance = Infinity;
    let replans = 0;
    let plannedAt = ship.movement.route.plannedAt;
    tick(room, [ship], 1600, () => {
      worstClearance = Math.min(worstClearance, worstAsteroidClearance(ship, asteroids));
      const route = ship.movement.route;
      if (route && route.plannedAt !== plannedAt) {
        replans += 1;
        plannedAt = route.plannedAt;
      }
    });

    assert(distanceTo(ship, destination.x, destination.y) <= ARRIVE_DISTANCE + 6,
      `the ship should follow the route to the end (${distanceTo(ship, destination.x, destination.y).toFixed(0)} px away)`);
    assert(worstClearance > -0.5,
      `route following must not cut into an obstacle (worst ${worstClearance.toFixed(1)} px)`);
    // One committed route, replanned only when the world or the ship's own
    // progress says so -- not a fresh search every time the hull is mid-turn.
    assert(replans < 12, `the route should not be rebuilt on every turn (${replans} replans)`);
  }

  // --- a narrow but valid passage stays usable ------------------------------
  {
    const asteroids = [
      { id: "north", x: 2200, y: 1150, radius: 470 },
      { id: "south", x: 2200, y: 2350, radius: 470 }
    ];
    // The gap between the two surfaces is 260 px wide, and the hull needs 50 px
    // of navigation clearance either side of itself to be allowed through it.
    // The direct line is blocked, so the passage has to be found and flown.
    const ship = makeShip({ x: 700, y: 700 });
    const room = makeRoom([ship], asteroids);
    const destination = { x: 3900, y: 2800 };
    commandShips(room, room.players.get("p1"), destination.x, destination.y, { shipIds: [ship.id] });
    tick(room, [ship], 1);
    assert(ship.movement.path.length > 1, "the passage should be routed, not flown straight at");

    let worstClearance = Infinity;
    let slowestInGap = Infinity;
    let stoppedInGap = 0;
    tick(room, [ship], 1600, () => {
      worstClearance = Math.min(worstClearance, worstAsteroidClearance(ship, asteroids));
      if (Math.abs(ship.x - 2200) < 320) {
        const speed = Math.hypot(ship.vx, ship.vy);
        slowestInGap = Math.min(slowestInGap, speed);
        if (speed < 5) stoppedInGap += 1;
      }
    });

    assert(distanceTo(ship, destination.x, destination.y) <= ARRIVE_DISTANCE + 6,
      `a physically valid passage must remain usable (${distanceTo(ship, destination.x, destination.y).toFixed(0)} px away)`);
    assert(worstClearance > -0.5,
      `the hull must not clip the passage walls (worst ${worstClearance.toFixed(1)} px)`);
    assert.equal(stoppedInGap, 0,
      `the ship should not stop inside the gap (slowest ${slowestInGap.toFixed(1)} px/s)`);
  }

  console.log("verify-movement-navigation: OK");
}

run();
