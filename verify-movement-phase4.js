"use strict";

// Phase 4 -- pathfinding around static obstacles.
//
// Acceptance criteria:
//
//   * direct unobstructed paths remain direct
//   * routes around one asteroid, several asteroids, and a station
//   * different ship sizes receive valid clearance
//   * the ship does not scrape along obstacle edges
//   * pathfinding does not rerun every physics substep
//   * B immediately cancels the path
//   * a new Move replaces the old path

const assert = require("assert");
const { computeStats } = require("./src/server/shipStats");
const {
  commandShips,
  stopShips,
  updateShipMovement,
  updateShipSeparation
} = require("./src/server/movement");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { buildRoomSpatialIndex } = require("./src/server/spatialIndex");
const { ARRIVE_DISTANCE } = require("./src/server/movementTuning");

const DT = 1 / 30;

const LIGHT_DESIGN = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" }
];

const WIDE_DESIGN = (() => {
  const modules = [{ x: 8, y: 6, type: "core" }];
  const taken = new Set(["8,6"]);
  const claim = (x, y, width, height) => {
    for (let i = 0; i < width; i += 1) {
      for (let j = 0; j < height; j += 1) if (taken.has(`${x + i},${y + j}`)) return false;
    }
    for (let i = 0; i < width; i += 1) {
      for (let j = 0; j < height; j += 1) taken.add(`${x + i},${y + j}`);
    }
    return true;
  };
  for (const [x, y] of [[4, 11], [6, 11], [8, 11], [10, 11]]) {
    if (claim(x, y, 1, 2)) modules.push({ x, y, type: "engine" });
  }
  for (const [x, y] of [[6, 3], [9, 3], [6, 9], [9, 9]]) {
    if (claim(x, y, 2, 1)) modules.push({ x, y, type: "reactor" });
  }
  for (let x = 4; x <= 12; x += 1) {
    for (let y = 3; y <= 10; y += 1) if (claim(x, y, 1, 1)) modules.push({ x, y, type: "frame" });
  }
  return modules;
})();

let shipSeq = 0;

// Where the ship was ordered to. The runtime destination is cleared once the
// order has been carried out -- the durable record of the order is the command.
function orderedDestination(ship) {
  return ship.movement.command?.destination || ship.movement.destination;
}

function makeShip(design, x, y, angle = 0) {
  const stats = computeStats(design);
  const { computeDesignCollisionRadius } = require("./src/server/componentGeometry");
  const ship = {
    id: `s${++shipSeq}`,
    ownerId: "p1",
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

function makeScenario(ships, asteroids = [], stations = []) {
  const player = { id: "p1", team: "A", ships };
  const room = {
    world: { width: 6000, height: 4000 },
    map: { asteroids },
    ships: new Map(ships.map((ship) => [ship.id, ship])),
    players: new Map([["p1", player]]),
    stations,
    stationsById: new Map(stations.map((station) => [station.id, station])),
    effects: []
  };
  buildRoomSpatialIndex(room, ships, 0);
  return { player, room };
}

function simulate(room, ships, seconds, onTick = null) {
  const ticks = Math.round(seconds / DT);
  for (let tick = 0; tick < ticks; tick += 1) {
    const now = tick * DT * 1000;
    buildRoomSpatialIndex(room, ships, now);
    for (const ship of ships) updateShipMovement(room, ship, DT, now);
    updateShipSeparation(room, ships, DT, now);
    if (onTick) onTick(tick);
  }
}

function distanceTo(ship, x, y) {
  return Math.hypot(ship.x - x, ship.y - y);
}

// Closest a ship ever came to the surface of any obstacle. Negative means it
// was inside one.
function trackClearance(ship, asteroids, stations) {
  let worst = Infinity;
  return {
    sample() {
      for (const asteroid of asteroids) {
        worst = Math.min(worst,
          Math.hypot(ship.x - asteroid.x, ship.y - asteroid.y) - asteroid.radius - ship.physicalRadius);
      }
      for (const station of stations) {
        for (const piece of station.collisionPieces || []) {
          const dx = Math.abs(ship.x - piece.x) - piece.halfWidth;
          const dy = Math.abs(ship.y - piece.y) - piece.halfHeight;
          const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
          worst = Math.min(worst, outside - ship.physicalRadius);
        }
      }
    },
    get worst() { return worst; }
  };
}

function station(id, x, y, halfWidth, halfHeight) {
  return {
    id,
    x,
    y,
    alive: true,
    state: "operational",
    collisionPieces: [{ x, y, halfWidth, halfHeight, angle: 0 }]
  };
}

function run() {
  // --- Direct unobstructed paths remain direct -----------------------------
  {
    const ship = makeShip(LIGHT_DESIGN, 600, 2000);
    const { room, player } = makeScenario([ship]);
    commandShips(room, player, 4000, 2000, { shipIds: [ship.id] });
    simulate(room, [ship], 1);
    assert.strictEqual(ship.movement.path.length, 1,
      `an unobstructed order should be one leg, not a route (${ship.movement.path.length} waypoints)`);
    assert(Math.abs(ship.movement.path[0].x - 4000) < 1 && Math.abs(ship.movement.path[0].y - 2000) < 1,
      "the single leg should be the destination itself");
    simulate(room, [ship], 45);
    assert(distanceTo(ship, 4000, 2000) <= ARRIVE_DISTANCE + 4, "direct move should still arrive");
  }

  // --- Routes around one asteroid ------------------------------------------
  {
    const asteroids = [{ x: 2300, y: 2000, radius: 320 }];
    const ship = makeShip(LIGHT_DESIGN, 600, 2000);
    const { room, player } = makeScenario([ship], asteroids);
    commandShips(room, player, 4000, 2000, { shipIds: [ship.id] });
    // Routing is resolved on the tick, not when the order is issued, so the
    // route exists from the first update onward.
    simulate(room, [ship], DT);
    assert(ship.movement.path.length > 1,
      `a blocked order should produce a route with waypoints (${ship.movement.path.length})`);

    const clearance = trackClearance(ship, asteroids, []);
    simulate(room, [ship], 60, () => clearance.sample());
    assert(distanceTo(ship, 4000, 2000) <= ARRIVE_DISTANCE + 6,
      `should route around the asteroid and arrive (${distanceTo(ship, 4000, 2000).toFixed(1)} px away)`);
    // Not scraping: the hull keeps real daylight between itself and the rock,
    // rather than grinding along the surface being pushed off by the collision
    // solver.
    assert(clearance.worst > 8,
      `should not scrape the asteroid (closest approach ${clearance.worst.toFixed(1)} px of clearance)`);
  }

  // --- Routes around several asteroids -------------------------------------
  {
    const asteroids = [
      { x: 1800, y: 1750, radius: 260 },
      { x: 2500, y: 2350, radius: 300 },
      { x: 3200, y: 1700, radius: 240 }
    ];
    const ship = makeShip(LIGHT_DESIGN, 600, 2000);
    const { room, player } = makeScenario([ship], asteroids);
    commandShips(room, player, 4300, 2000, { shipIds: [ship.id] });
    const clearance = trackClearance(ship, asteroids, []);
    simulate(room, [ship], 80, () => clearance.sample());
    assert(distanceTo(ship, 4300, 2000) <= ARRIVE_DISTANCE + 6,
      `should thread several asteroids (${distanceTo(ship, 4300, 2000).toFixed(1)} px away)`);
    assert(clearance.worst > 5,
      `should not scrape any asteroid (closest ${clearance.worst.toFixed(1)} px)`);
  }

  // --- Routes around a station ---------------------------------------------
  {
    const stations = [station("st1", 2400, 2000, 300, 260)];
    const ship = makeShip(LIGHT_DESIGN, 600, 2000);
    const { room, player } = makeScenario([ship], [], stations);
    commandShips(room, player, 4200, 2000, { shipIds: [ship.id] });
    simulate(room, [ship], DT);
    assert(ship.movement.path.length > 1,
      `a station in the way should produce a route (${ship.movement.path.length})`);
    const clearance = trackClearance(ship, [], stations);
    simulate(room, [ship], 70, () => clearance.sample());
    assert(distanceTo(ship, 4200, 2000) <= ARRIVE_DISTANCE + 6,
      `should route around the station (${distanceTo(ship, 4200, 2000).toFixed(1)} px away)`);
    assert(clearance.worst > 5,
      `should not scrape the station (closest ${clearance.worst.toFixed(1)} px)`);
  }

  // --- Different ship sizes receive valid clearance ------------------------
  {
    // The same gap, flown by a corvette and by a capital. Both must clear it;
    // the capital's route must be the wider one, because its obstacles are
    // inflated by its own larger radius.
    const asteroids = [
      { x: 2400, y: 1500, radius: 380 },
      { x: 2400, y: 2500, radius: 380 }
    ];
    const results = [LIGHT_DESIGN, WIDE_DESIGN].map((design) => {
      const ship = makeShip(design, 700, 2000);
      const { room, player } = makeScenario([ship], asteroids);
      commandShips(room, player, 4100, 2000, { shipIds: [ship.id] });
      const clearance = trackClearance(ship, asteroids, []);
      simulate(room, [ship], 90, () => clearance.sample());
      return { ship, clearance: clearance.worst, arrived: distanceTo(ship, 4100, 2000) };
    });
    for (const result of results) {
      assert(result.arrived <= ARRIVE_DISTANCE + 8,
        `hull of radius ${result.ship.physicalRadius.toFixed(0)} should get through (${result.arrived.toFixed(1)} px away)`);
      assert(result.clearance > 0,
        `hull of radius ${result.ship.physicalRadius.toFixed(0)} should never enter an asteroid (${result.clearance.toFixed(1)} px)`);
    }
    assert(results[1].ship.physicalRadius > results[0].ship.physicalRadius,
      "the wide fixture should actually be wider");
  }

  // --- Pathfinding does not rerun every substep ----------------------------
  {
    global.__mfaMovePerf = {};
    const asteroids = [{ x: 2300, y: 2000, radius: 320 }];
    const ship = makeShip(LIGHT_DESIGN, 600, 2000);
    const { room, player } = makeScenario([ship], asteroids);
    commandShips(room, player, 4000, 2000, { shipIds: [ship.id] });
    const ticks = Math.round(30 / DT);
    simulate(room, [ship], 30);
    const replans = global.__mfaMovePerf.pathReplanCount || 0;
    const controllerRuns = global.__mfaMovePerf.sharedControllerRuns || 0;
    assert(controllerRuns >= ticks * 2, "the controller should have run at least once per substep");
    assert(replans < ticks / 10,
      `pathfinding should be rare, not per-substep (${replans} replans over ${ticks} ticks / ${controllerRuns} substeps)`);
    delete global.__mfaMovePerf;
  }

  // --- B immediately cancels the path --------------------------------------
  {
    const asteroids = [{ x: 2300, y: 2000, radius: 320 }];
    const ship = makeShip(LIGHT_DESIGN, 600, 2000);
    const { room, player } = makeScenario([ship], asteroids);
    commandShips(room, player, 4000, 2000, { shipIds: [ship.id] });
    simulate(room, [ship], 3);
    assert(ship.movement.path.length > 0, "ship should be following a route before Stop");

    stopShips(room, player, [ship.id]);
    assert.deepStrictEqual(ship.movement.path, [], "B should clear the path immediately");
    assert.strictEqual(ship.movement.waypointIndex, 0, "B should reset the waypoint index");
    assert.strictEqual(orderedDestination(ship), null, "B should clear the destination");
    simulate(room, [ship], 20);
    assert.deepStrictEqual(ship.movement.path, [], "a stopped ship should not acquire a new route");
    assert(Math.hypot(ship.vx, ship.vy) === 0, "B should still bring the ship to rest");
  }

  // --- A new Move replaces the old path ------------------------------------
  {
    const asteroids = [{ x: 2300, y: 2000, radius: 320 }];
    const ship = makeShip(LIGHT_DESIGN, 600, 2000);
    const { room, player } = makeScenario([ship], asteroids);
    commandShips(room, player, 4000, 2000, { shipIds: [ship.id] });
    simulate(room, [ship], 3);
    const firstPath = ship.movement.path.map((point) => ({ ...point }));
    assert(firstPath.length > 0, "ship should be on a route before the second order");

    commandShips(room, player, 900, 3600, { shipIds: [ship.id] });
    // The old route is dropped the instant the order is replaced -- it is never
    // flown for even one more tick.
    assert.deepStrictEqual(ship.movement.path, [], "a new Move should drop the old route immediately");
    assert.strictEqual(ship.movement.waypointIndex, 0, "a new Move should restart at the first waypoint");

    simulate(room, [ship], DT);
    const replaced = ship.movement.path;
    assert(replaced.length > 0, "a new Move should plan its own route");
    assert(replaced.length !== firstPath.length
      || replaced.some((point, index) => Math.abs(point.x - firstPath[index].x) > 1),
      "the replacement route should not be the old one");
    simulate(room, [ship], 60);
    assert(distanceTo(ship, 900, 3600) <= ARRIVE_DISTANCE + 6,
      `should fly the replacement order (${distanceTo(ship, 900, 3600).toFixed(1)} px away)`);
  }

  // --- Rounds intermediate waypoints without stopping ----------------------
  {
    const asteroids = [{ x: 2300, y: 2000, radius: 340 }];
    const ship = makeShip(LIGHT_DESIGN, 600, 2000);
    const { room, player } = makeScenario([ship], asteroids);
    commandShips(room, player, 4000, 2000, { shipIds: [ship.id] });
    let stalls = 0;
    let underWay = false;
    simulate(room, [ship], 60, () => {
      const speed = Math.hypot(ship.vx, ship.vy);
      if (speed > 120) underWay = true;
      // Once moving, and while still well short of the destination, the ship
      // should never come to a near halt at a corner.
      if (underWay && distanceTo(ship, 4000, 2000) > 300 && speed < 25) stalls += 1;
    });
    assert.strictEqual(stalls, 0,
      `a ship should round waypoints, not stop at them (${stalls} near-halts en route)`);
  }

  console.log("verify-movement-phase4: OK");
}

run();
