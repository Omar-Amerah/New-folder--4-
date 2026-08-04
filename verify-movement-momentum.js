"use strict";

// Momentum-based propulsion.
//
// Thrust is added to the velocity a ship already has, along its nose. That is
// the whole of the change these tests are about: a hull turns through a curve
// instead of having its velocity rebuilt on the new heading, it never adds
// thrust that carries it further from where it was sent, and it still settles.

const assert = require("node:assert/strict");
const { movementTestTick } = require("./tools/movementTestTick");
const { alignmentThrottle, commandShips } = require("./src/server/movement");
const { ARRIVE_DISTANCE, FULL_THRUST_HEADING_ERROR } = require("./src/server/movementTuning");
const { angleDifference } = require("./src/server/utils");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { computeDesignCollisionRadius } = require("./src/server/componentGeometry");

const DT = 1 / 30;
const BASE = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" }
];

let sequence = 0;

function makeShip({ x, y, angle = 0, vx = 0, vy = 0, design = BASE }) {
  const stats = computeStats(design);
  const ship = {
    id: `momentum-${++sequence}`,
    ownerId: "p1",
    team: "A",
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

function makeRoom(ships) {
  return {
    phase: "active",
    world: { width: 8000, height: 6000 },
    map: { asteroids: [], relays: [], revision: 1 },
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

function speedOf(ship) {
  return Math.hypot(ship.vx, ship.vy);
}

// Angle between where the hull points and where it is actually going.
function slipAngle(ship) {
  if (speedOf(ship) < 1) return 0;
  return Math.abs(angleDifference(ship.angle, Math.atan2(ship.vy, ship.vx)));
}

function run() {
  // --- the alignment curve -------------------------------------------------
  {
    assert.equal(alignmentThrottle(0), 1, "dead ahead is full thrust");
    assert.equal(alignmentThrottle(FULL_THRUST_HEADING_ERROR), 1,
      "still full thrust at the top of the band");
    const half = alignmentThrottle(Math.PI / 3);
    assert(half > 0 && half < 1, `thrust tapers between the band and a right angle (${half})`);
    assert(alignmentThrottle(Math.PI / 3 + 0.2) < half, "...and keeps tapering");
    for (const beyond of [Math.PI / 2, Math.PI / 2 + 0.01, 2, Math.PI]) {
      assert.equal(alignmentThrottle(beyond), 0,
        `no forward thrust past a right angle (${beyond})`);
      assert.equal(alignmentThrottle(-beyond), 0, "...in either direction");
    }
  }

  // --- a turn is flown as a curve -----------------------------------------
  {
    // Running east at cruise, then sent north-east.
    const ship = makeShip({ x: 1000, y: 3000, angle: 0 });
    const room = makeRoom([ship]);
    commandShips(room, room.players.get("p1"), 5200, 3000, { shipIds: [ship.id] });
    tick(room, [ship], 200);
    const cruise = speedOf(ship);
    assert(cruise > 300, `sanity: the ship should be at cruise (${cruise.toFixed(0)} px/s)`);

    commandShips(room, room.players.get("p1"), 4000, 900, { shipIds: [ship.id] });
    let peakSlip = 0;
    let slowest = Infinity;
    let worstLateralStep = 0;
    const track = [];
    let previousLateral = 0;
    tick(room, [ship], 120, () => {
      peakSlip = Math.max(peakSlip, slipAngle(ship));
      slowest = Math.min(slowest, speedOf(ship));
      const lateral = ship.vx * -Math.sin(ship.angle) + ship.vy * Math.cos(ship.angle);
      worstLateralStep = Math.max(worstLateralStep, Math.abs(lateral - previousLateral));
      previousLateral = lateral;
      track.push({ x: ship.x, y: ship.y });
    });

    // Momentum: for a while the hull is pointing somewhere other than where it
    // is going. A controller that rebuilt velocity from the hull angle every
    // step could never show this.
    assert(peakSlip > 0.2,
      `the ship should carry momentum through the turn (peak slip ${peakSlip.toFixed(3)} rad)`);
    assert(slowest > 60,
      `it should not stop to turn (slowest ${slowest.toFixed(0)} px/s)`);
    assert(worstLateralStep < 40,
      `sideways momentum should change smoothly (worst step ${worstLateralStep.toFixed(1)} px/s)`);

    // A curve, not a corner: the path bends continuously rather than kinking.
    let worstBend = 0;
    for (let index = 2; index < track.length; index += 1) {
      const first = Math.atan2(track[index - 1].y - track[index - 2].y, track[index - 1].x - track[index - 2].x);
      const second = Math.atan2(track[index].y - track[index - 1].y, track[index].x - track[index - 1].x);
      worstBend = Math.max(worstBend, Math.abs(angleDifference(first, second)));
    }
    assert(worstBend < 0.2,
      `the path should bend, not kink (worst step ${worstBend.toFixed(3)} rad)`);
  }

  // --- a destination directly behind --------------------------------------
  {
    const ship = makeShip({ x: 3000, y: 3000, angle: 0, vx: 420 });
    const room = makeRoom([ship]);
    const destination = { x: 1200, y: 3000 };
    commandShips(room, room.players.get("p1"), destination.x, destination.y, { shipIds: [ship.id] });

    let previousAway = ship.vx;
    let previousDistance = Math.hypot(ship.x - destination.x, ship.y - destination.y);
    let maximumDistance = previousDistance;
    let sawWrongWay = false;
    tick(room, [ship], 90, () => {
      const bearing = Math.atan2(destination.y - ship.y, destination.x - ship.x);
      if (Math.abs(angleDifference(ship.angle, bearing)) > Math.PI / 2) {
        sawWrongWay = true;
        // While the nose is more than a right angle off the bearing, the only
        // thing propulsion may do is take speed off. Nothing here may add to
        // the speed that is carrying the ship away.
        assert(ship.vx <= previousAway + 1e-6,
          `no thrust may drive the ship further away (${ship.vx.toFixed(1)} after ${previousAway.toFixed(1)})`);
      }
      previousAway = ship.vx;
      maximumDistance = Math.max(maximumDistance, Math.hypot(ship.x - destination.x, ship.y - destination.y));
      previousDistance = Math.hypot(ship.x - destination.x, ship.y - destination.y);
    });
    assert(sawWrongWay, "sanity: the ship should spend some of the turn facing away");
    assert(maximumDistance < 2100,
      `the ship should brake through the reversal, not coast on (${maximumDistance.toFixed(0)} px out)`);

    tick(room, [ship], 700);
    assert(Math.hypot(ship.x - destination.x, ship.y - destination.y) <= ARRIVE_DISTANCE + 6,
      "the ship should turn around and arrive");
  }

  // --- arrival -------------------------------------------------------------
  {
    const ship = makeShip({ x: 1000, y: 1000, angle: 0 });
    const room = makeRoom([ship]);
    const destination = { x: 4000, y: 1000 };
    commandShips(room, room.players.get("p1"), destination.x, destination.y, { shipIds: [ship.id] });

    let reacquisitions = 0;
    let closest = Infinity;
    let previous = Infinity;
    tick(room, [ship], 600, () => {
      const distance = Math.hypot(ship.x - destination.x, ship.y - destination.y);
      closest = Math.min(closest, distance);
      // Overshoot-and-come-back: having been inside the arrival envelope, ending
      // up meaningfully outside it again.
      if (closest <= ARRIVE_DISTANCE && distance > ARRIVE_DISTANCE + 8 && previous <= ARRIVE_DISTANCE + 8) {
        reacquisitions += 1;
      }
      previous = distance;
    });

    assert.equal(reacquisitions, 0, "the ship should not overshoot and reacquire its destination");
    assert(Math.hypot(ship.x - destination.x, ship.y - destination.y) <= ARRIVE_DISTANCE,
      "the ship should settle inside the arrival tolerance");
    assert.equal(speedOf(ship), 0, "a settled ship should be genuinely stopped");

    const settled = { x: ship.x, y: ship.y };
    tick(room, [ship], 300);
    assert(Math.hypot(ship.x - settled.x, ship.y - settled.y) < 0.001,
      "a settled ship should not jitter");
  }

  console.log("verify-movement-momentum: OK");
}

run();
