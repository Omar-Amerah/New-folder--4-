"use strict";

// Phase 2 -- manual rotation (I / O) and Stop (B).
//
// Acceptance criteria:
//
//   * I and O turn selected ships predictably, and every ship in a selection
//     turns the same way
//   * manual rotation does not jitter against the autopilot
//   * releasing I/O hands facing back to the active movement command
//   * B stops a moving ship, works mid-turn, works mid-route, and never flips
//     the hull through 180 degrees

const assert = require("assert");
const { movementTestTick } = require("./tools/movementTestTick");
const { computeStats } = require("./src/server/shipStats");
const {
  commandShips,
  rotateShips,
  stopShips,
  updateShipMovement,
  updateShipSeparation
} = require("./src/server/movement");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { heatAdjustedMovementStats } = require("./src/server/movementCapability");
const { REST_SPEED } = require("./src/server/movementTuning");

const DT = 1 / 30;
const DESIGN = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" }
];

let shipSeq = 0;

function makeShip(x, y, angle = 0) {
  const stats = computeStats(DESIGN);
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
    physicalRadius: Math.max(18, stats.radius * 0.56),
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

function makeScenario(ships) {
  const player = { id: "p1", team: "A", ships };
  return {
    player,
    room: {
      world: { width: 4000, height: 3000 },
      map: { asteroids: [] },
      ships: new Map(ships.map((ship) => [ship.id, ship])),
      players: new Map([["p1", player]]),
      stations: [],
      effects: []
    }
  };
}

function simulate(room, ships, seconds, onTick = null) {
  const ticks = Math.round(seconds / DT);
  for (let tick = 0; tick < ticks; tick += 1) {
    movementTestTick(room, ships, DT, tick * DT * 1000);
    if (onTick) onTick(tick);
  }
}

function speedOf(ship) {
  return Math.hypot(ship.vx, ship.vy);
}

function unwrap(angle, previous) {
  let value = angle;
  while (value - previous > Math.PI) value -= Math.PI * 2;
  while (previous - value > Math.PI) value += Math.PI * 2;
  return value;
}

// Total signed rotation over a run, so a hull that spins past PI is measured
// honestly rather than wrapping back to nearly zero.
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

function run() {
  // --- I and O turn predictably -------------------------------------------
  {
    const ship = makeShip(1200, 1200, 0);
    const { room, player } = makeScenario([ship]);

    rotateShips(room, player, { direction: 1, active: true, shipIds: [ship.id] });
    assert.strictEqual(ship.manualRotation, 1, "O should latch clockwise rotation");
    const clockwise = trackRotation(ship);
    simulate(room, [ship], 1, () => clockwise.sample());
    assert(clockwise.total > 0, `O should turn clockwise (turned ${clockwise.total.toFixed(3)} rad)`);
    // Predictably: at the hull's live turn rate, not some fraction of it. The
    // live rate is what damage, heat, Power and command auras have left of the
    // paper stat, so that -- not ship.stats -- is what the helm should deliver.
    const expected = heatAdjustedMovementStats(ship, ship.stats).turnRateRight;
    assert(Math.abs(clockwise.total - expected) < expected * 0.02,
      `O should turn at the live rated rate (${clockwise.total.toFixed(3)} rad/s vs rated ${expected.toFixed(3)})`);

    rotateShips(room, player, { direction: -1, active: true, shipIds: [ship.id] });
    assert.strictEqual(ship.manualRotation, -1, "I should latch anticlockwise rotation");
    const anticlockwise = trackRotation(ship);
    simulate(room, [ship], 1, () => anticlockwise.sample());
    assert(anticlockwise.total < 0,
      `I should turn anticlockwise (turned ${anticlockwise.total.toFixed(3)} rad)`);

    rotateShips(room, player, { direction: -1, active: false, shipIds: [ship.id] });
    assert.strictEqual(ship.manualRotation, null, "releasing the key should clear manual rotation");
    const released = trackRotation(ship);
    simulate(room, [ship], 1, () => released.sample());
    assert(Math.abs(released.total) < 1e-9,
      "an idle ship should hold its heading once the key is released");
  }

  // --- Every ship in a selection turns the same way ------------------------
  {
    const ships = [makeShip(1000, 1000, 0), makeShip(1200, 1000, 1.2), makeShip(1400, 1000, -2.4)];
    const { room, player } = makeScenario(ships);
    rotateShips(room, player, { direction: 1, active: true, shipIds: ships.map((s) => s.id) });
    const trackers = ships.map(trackRotation);
    simulate(room, ships, 1, () => trackers.forEach((tracker) => tracker.sample()));
    for (let index = 0; index < ships.length; index += 1) {
      assert(trackers[index].total > 0,
        `every selected ship should turn the same way (ship ${index} turned ${trackers[index].total.toFixed(3)} rad)`);
    }
    const spread = Math.max(...trackers.map((t) => t.total)) - Math.min(...trackers.map((t) => t.total));
    assert(spread < 1e-9, `identical hulls should turn identically (spread ${spread.toExponential(2)} rad)`);
  }

  // --- Manual rotation overrides the autopilot without fighting it ----------
  {
    const ship = makeShip(1200, 1200, 0);
    const { room, player } = makeScenario([ship]);
    commandShips(room, player, 3000, 1200, { shipIds: [ship.id] });
    simulate(room, [ship], 2);
    const travelAngle = ship.angle;
    assert(Math.abs(travelAngle) < 0.05, "ship should be flying its course before the key is pressed");

    rotateShips(room, player, { direction: 1, active: true, shipIds: [ship.id] });
    // The autopilot still wants the original course; manual rotation must win
    // outright, and it must not stutter as the two disagree. A monotonically
    // increasing heading is the check: any tick where the autopilot got a word
    // in would show up as a step backwards.
    let previous = ship.angle;
    let reversals = 0;
    const held = trackRotation(ship);
    simulate(room, [ship], 1.5, () => {
      held.sample();
      const delta = unwrap(ship.angle, previous) - previous;
      if (delta < -1e-9) reversals += 1;
      previous = unwrap(ship.angle, previous);
    });
    assert.strictEqual(reversals, 0,
      `manual rotation should not jitter against the autopilot (${reversals} reversals)`);
    assert(held.total > 1, `manual rotation should have turned the hull (${held.total.toFixed(3)} rad)`);

    // The destination is untouched by rotating.
    assert.strictEqual(ship.movement.command.type, "move", "rotating should not cancel the move order");
    assert(Math.abs(ship.movement.destination.x - 3000) < 1,
      "rotating should not move the destination");

    // Releasing hands facing straight back to the movement command: the ship
    // comes about and completes the order it was given.
    rotateShips(room, player, { direction: 1, active: false, shipIds: [ship.id] });
    simulate(room, [ship], 45);
    assert(Math.hypot(ship.x - 3000, ship.y - 1200) < 20,
      `releasing the key should restore automatic facing and finish the order (${Math.hypot(ship.x - 3000, ship.y - 1200).toFixed(1)} px away)`);
  }

  // --- B stops a moving ship ------------------------------------------------
  {
    const ship = makeShip(1200, 1200, 0);
    const { room, player } = makeScenario([ship]);
    commandShips(room, player, 3600, 1200, { shipIds: [ship.id] });
    simulate(room, [ship], 4);
    assert(speedOf(ship) > 100, "ship should be under way before Stop");
    const headingAtStop = ship.angle;
    const positionAtStop = { x: ship.x, y: ship.y };

    stopShips(room, player, [ship.id]);
    assert.strictEqual(ship.movement.command.type, "stop", "B should issue a stop order");
    assert.strictEqual(ship.movement.destination, null, "stop should clear the destination");
    assert.deepStrictEqual(ship.movement.path, [], "stop should clear the path");

    simulate(room, [ship], 20);
    assert(speedOf(ship) === 0, `B should bring the ship to rest (speed ${speedOf(ship).toFixed(3)})`);
    assert.strictEqual(ship.movement.phase, "positioned", "a stopped ship should report positioned");
    assert(Math.abs(ship.angle - headingAtStop) < 1e-9,
      `B should preserve the hull heading (${headingAtStop.toFixed(4)} -> ${ship.angle.toFixed(4)})`);
    // It coasted forward while braking; it must not have been dragged back
    // toward where it came from.
    assert(ship.x > positionAtStop.x, "a braking ship should coast forward, not reverse");
  }

  // --- B during a turn ------------------------------------------------------
  {
    const ship = makeShip(1200, 1200, 0);
    const { room, player } = makeScenario([ship]);
    commandShips(room, player, 1200, 3000, { shipIds: [ship.id] }); // 90 degrees abeam
    simulate(room, [ship], 0.5);
    assert(Math.abs(ship.angle) > 0.2 && Math.abs(ship.angle) < 1.4,
      `ship should be mid-turn before Stop (angle ${ship.angle.toFixed(3)})`);
    const headingAtStop = ship.angle;
    stopShips(room, player, [ship.id]);
    const tracker = trackRotation(ship);
    simulate(room, [ship], 20, () => tracker.sample());
    assert(Math.abs(ship.angle - headingAtStop) < 1e-9,
      "B mid-turn should freeze the heading where it was");
    assert(Math.abs(tracker.total) < 1e-9,
      `B must not rotate the ship at all (${tracker.total.toFixed(4)} rad)`);
    assert(speedOf(ship) === 0, "B mid-turn should still come to rest");
  }

  // --- B mid-route, and no 180 degree flip ---------------------------------
  {
    // The case the old flip-and-burn model got wrong: a ship at speed, ordered
    // to stop, must shed speed on its current heading. Any implementation that
    // brakes by pointing the engines the other way shows up here as a rotation
    // of about PI.
    const ship = makeShip(400, 1500, 0);
    const { room, player } = makeScenario([ship]);
    commandShips(room, player, 3800, 1500, { shipIds: [ship.id] });
    simulate(room, [ship], 6);
    assert(speedOf(ship) > 200, "ship should be at cruise before Stop");
    const headingAtStop = ship.angle;

    stopShips(room, player, [ship.id]);
    const tracker = trackRotation(ship);
    let peakRotation = 0;
    simulate(room, [ship], 25, () => {
      tracker.sample();
      peakRotation = Math.max(peakRotation, Math.abs(tracker.total));
    });
    assert(peakRotation < 0.01,
      `B must never flip the hull to brake (rotated ${peakRotation.toFixed(3)} rad, a flip would be ~${Math.PI.toFixed(3)})`);
    assert(Math.abs(ship.angle - headingAtStop) < 1e-9, "B should hold the heading exactly");
    assert(speedOf(ship) === 0, "B should reach a complete stop");

    // ...and it stays stopped.
    const restX = ship.x;
    const restY = ship.y;
    simulate(room, [ship], 30);
    assert(Math.hypot(ship.x - restX, ship.y - restY) < 1e-9,
      "a stopped ship should stay exactly where it stopped");
    assert(speedOf(ship) < REST_SPEED, "a stopped ship should stay stopped");
  }

  // --- B while manually rotating -------------------------------------------
  {
    const ship = makeShip(1200, 1200, 0);
    const { room, player } = makeScenario([ship]);
    commandShips(room, player, 3000, 1200, { shipIds: [ship.id] });
    simulate(room, [ship], 3);
    rotateShips(room, player, { direction: -1, active: true, shipIds: [ship.id] });
    simulate(room, [ship], 0.5);
    stopShips(room, player, [ship.id]);
    // Stop cancels the order, not the key the player is still holding.
    assert.strictEqual(ship.manualRotation, -1, "Stop should not release a held rotation key");
    simulate(room, [ship], 5);
    assert(speedOf(ship) === 0, "the ship should still come to rest while being turned by hand");
    rotateShips(room, player, { direction: -1, active: false, shipIds: [ship.id] });
    const tracker = trackRotation(ship);
    simulate(room, [ship], 5, () => tracker.sample());
    assert(Math.abs(tracker.total) < 1e-9,
      "once the key is released a stopped ship holds its heading");
  }

  console.log("verify-movement-phase2: OK");
}

run();
