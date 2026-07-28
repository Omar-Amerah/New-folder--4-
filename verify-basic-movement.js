"use strict";

const assert = require("assert");
const { computeStats } = require("./src/server/shipStats");
const {
  commandShips,
  updateShipMovement,
  updateShipSeparation
} = require("./src/server/movement");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");

const DT = 1 / 30;
const DESIGN = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" }
];

function makeShip(id, x, y) {
  const stats = computeStats(DESIGN);
  const ship = {
    id,
    ownerId: "p1",
    alive: true,
    x,
    y,
    vx: 0,
    vy: 0,
    angle: 0,
    targetX: x,
    targetY: y,
    radius: stats.radius,
    design: DESIGN.map((part) => ({ ...part })),
    wiring: createGeneratedPowerWiring(DESIGN),
    stats,
    combatStyle: "hold"
  };
  initComponentState(ship);
  initializeComponentPower(ship);
  initShipHeat(ship);
  return ship;
}

function makeScenario(ships, asteroids = []) {
  const player = { id: "p1", team: "A", ships };
  return {
    player,
    room: {
      world: { width: 2000, height: 1600 },
      map: { asteroids },
      ships: new Map(ships.map((ship) => [ship.id, ship])),
      players: new Map([["p1", player]])
    }
  };
}

function simulate(room, ships, seconds) {
  const ticks = Math.round(seconds / DT);
  for (let tick = 0; tick < ticks; tick += 1) {
    for (const ship of ships) {
      updateShipMovement(room, ship, DT, tick * DT * 1000);
    }
    updateShipSeparation(room);
  }
}

function distanceToTarget(ship) {
  return Math.hypot(ship.x - ship.targetX, ship.y - ship.targetY);
}

function run() {
  {
    const ship = makeShip("straight", 300, 400);
    const { room, player } = makeScenario([ship]);
    global.__mfaMovePerf = {};
    commandShips(room, player, 1500, 400, { shipIds: [ship.id] });
    let cruiseSpeed = 0;
    for (let tick = 0; tick < Math.round(40 / DT); tick += 1) {
      updateShipMovement(room, ship, DT, tick * DT * 1000);
      updateShipSeparation(room);
      // Peak speed over the leg. The ship used to be held to a crawl by a flat
      // exponential damping that stood in for brakes; without it a 1200 px leg
      // is flown at real thrust.
      cruiseSpeed = Math.max(cruiseSpeed, Math.hypot(ship.vx, ship.vy));
    }
    assert.strictEqual(ship.movement.phase, "positioned",
      "plain click-to-move should arrive");
    assert(distanceToTarget(ship) < 20, "plain move should stop at its assigned target");
    assert(cruiseSpeed > 150,
      `plain move should cross open space at real thrust (peak ${cruiseSpeed.toFixed(0)} px/s)`);
    assert(Math.hypot(ship.vx, ship.vy) < 1,
      `an arrived ship should be at rest, not drifting (got ${Math.hypot(ship.vx, ship.vy).toFixed(2)})`);
    // move/stop used to run through a second, separate mover (movementBasic.js)
    // with its own velocity damping and its own asteroid steering. There is now
    // one steering model for every intent, so a plain move must go through the
    // same controller a combat style does.
    assert((global.__mfaMovePerf.sharedControllerRuns || 0) > 0,
      "plain move should use the one shared controller");
    assert.strictEqual(global.__mfaMovePerf.basicMovementRuns, undefined,
      "the separate basic mover should no longer exist");
    delete global.__mfaMovePerf;
  }

  {
    const asteroid = { x: 1000, y: 300, radius: 150 };
    const ship = makeShip("obstacle", 400, 300);
    const { room, player } = makeScenario([ship], [asteroid]);
    commandShips(room, player, 1600, 300, { shipIds: [ship.id] });
    let minimumClearance = Infinity;
    for (let tick = 0; tick < Math.round(40 / DT); tick += 1) {
      updateShipMovement(room, ship, DT, tick * DT * 1000);
      minimumClearance = Math.min(
        minimumClearance,
        Math.hypot(ship.x - asteroid.x, ship.y - asteroid.y) - asteroid.radius
      );
      updateShipSeparation(room);
    }
    assert.strictEqual(ship.movement.phase, "positioned",
      "basic movement should route around an asteroid");
    assert(distanceToTarget(ship) < 20, "asteroid route should still reach the target");
    assert(minimumClearance > 20, "asteroid route should retain physical clearance");
  }

  {
    const first = makeShip("group-a", 300, 500);
    const second = makeShip("group-b", 300, 620);
    const { room, player } = makeScenario([first, second]);
    commandShips(room, player, 1400, 800, {
      shipIds: [first.id, second.id],
      formation: "wedge"
    });
    assert.notDeepStrictEqual(
      { x: first.targetX, y: first.targetY },
      { x: second.targetX, y: second.targetY },
      "group commands should assign distinct slots"
    );
    assert(!Object.hasOwn(first, "formationX") && !Object.hasOwn(second, "formationX"),
      "the mover should not require formation state");
    simulate(room, [first, second], 50);
    assert(first.movement.phase === "positioned"
      && second.movement.phase === "positioned",
    "all group ships should reach their own slots");
  }

  console.log("Basic movement verification passed");
  console.log("  straight, asteroid, braking, and independent group slots");
}

run();
