"use strict";

// Heading stability and route honesty.
//
// Everything here is about a ship doing something the player can see and cannot
// explain: rotating on the spot, shimmying against a neighbour, grinding along a
// station, or reporting itself arrived somewhere it was never sent. None of it
// shows up in a test that only checks final positions, which is why the movement
// suite passed throughout the period these were live.
//
// The common measure is total hull rotation. A ship that is manoeuvring turns;
// a ship that is oscillating turns just as much but ends up where it started, so
// the assertions here pair a rotation budget with a direction-reversal count.

const assert = require("assert");
const { computeStats } = require("./src/server/shipStats");
const {
  applyCombatStyle,
  commandShips,
  navigationClearanceRadius,
  updateShipMovement,
  updateShipSeparation
} = require("./src/server/movement");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const {
  buildRoomSpatialIndex,
  shipBroadPhaseRadius
} = require("./src/server/spatialIndex");
const { createStationsForRoom } = require("./src/server/stations");
const { searchPathWorld } = require("./src/server/movementNavigation");

const DT = 1 / 30;
const ARMED = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" },
  { x: 6, y: 7, type: "engine" },
  { x: 8, y: 8, type: "blaster" }
];

function makeShip(id, x, y, ownerId = "p1", team = "A") {
  const stats = computeStats(ARMED);
  const ship = {
    id,
    ownerId,
    team,
    alive: true,
    x,
    y,
    vx: 0,
    vy: 0,
    angle: 0,
    targetX: x,
    targetY: y,
    radius: stats.radius,
    design: ARMED.map((module) => ({ ...module })),
    wiring: createGeneratedPowerWiring(ARMED),
    stats,
    combatStyle: "hold"
  };
  initComponentState(ship);
  initializeComponentPower(ship);
  initShipHeat(ship);
  return ship;
}

// Stations only exist in rooms configured for them, and they are the obstacle
// every one of the pathing cases below turns on.
function makeRoom(teams, stationPoints = []) {
  const room = {
    id: "stability",
    world: { width: 2000, height: 1600 },
    map: { asteroids: [], safeZones: [], relays: [] },
    rules: {
      gameMode: "team",
      infrastructureMode: stationPoints.length ? "stations" : "none"
    },
    ships: new Map(),
    players: new Map(),
    nextEntityId: 1,
    stations: [],
    stationsById: new Map()
  };
  for (const [ownerId, entry] of Object.entries(teams)) {
    room.players.set(ownerId, { id: ownerId, team: entry.team, ships: entry.ships });
    for (const ship of entry.ships) room.ships.set(ship.id, ship);
  }
  if (stationPoints.length) {
    room.map.safeZones = stationPoints.map((point, index) => ({
      x: point.x,
      y: point.y,
      team: `S${index}`,
      ownerId: `s${index}`
    }));
    createStationsForRoom(room, 0);
  }
  room.spatialIndex = buildRoomSpatialIndex(room);
  return room;
}

function allShips(room) {
  return Array.from(room.ships.values());
}

// Mirrors the production tick order in simulation.js: index, movement,
// separation. Avoidance is a no-op without a valid spatial index, so a harness
// that skips the rebuild silently tests a different mover than the game runs.
function run(room, seconds, options = {}) {
  const ships = allShips(room);
  const watched = options.watch || ships;
  const tracks = new Map(watched.map((ship) => [ship.id, {
    ship,
    previous: ship.angle,
    rotation: 0,
    reversals: 0,
    lastSign: 0,
    speeds: [],
    ranges: [],
    contactTicks: 0
  }]));
  const settleAfter = Number(options.settleAfter) || 0;
  for (let tick = 0; tick < Math.round(seconds / DT); tick += 1) {
    const now = tick * DT * 1000;
    room.spatialIndex.rebuildKind("ships", ships, shipBroadPhaseRadius, now);
    for (const ship of ships) updateShipMovement(room, ship, DT, now);
    updateShipSeparation(room, ships, DT, now);
    for (const track of tracks.values()) {
      let delta = track.ship.angle - track.previous;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      track.previous = track.ship.angle;
      if (Math.hypot(
        track.ship._collisionCorrectionX || 0,
        track.ship._collisionCorrectionY || 0
      ) > 0.1) track.contactTicks += 1;
      if (tick * DT < settleAfter) continue;
      track.rotation += Math.abs(delta) * 180 / Math.PI;
      const sign = Math.sign(Math.round(delta * 1000));
      if (sign !== 0) {
        if (track.lastSign && sign !== track.lastSign) track.reversals += 1;
        track.lastSign = sign;
      }
      track.speeds.push(Math.hypot(track.ship.vx, track.ship.vy));
      if (options.rangeTo) {
        track.ranges.push(Math.hypot(
          track.ship.x - options.rangeTo.x,
          track.ship.y - options.rangeTo.y
        ));
      }
    }
  }
  return tracks;
}

function run_() {
  {
    // Six ships onto one rally point. Every ship gets its own slot, so once they
    // are parked there is nothing left to decide and nothing should move.
    //
    // What this catches: avoidance used to hand a yielding ship a commanded
    // velocity perpendicular to its goal, and both ships of a similar-mass pair
    // counted as yielding -- so the group never resolved. Facing follows the
    // commanded velocity, and the dodge side was re-picked whenever a different
    // neighbour became the most urgent, so the whole crowd sat on its slots
    // spinning. Measured 5913 degrees of rotation and 698 side flips.
    const ships = [];
    for (let index = 0; index < 6; index += 1) {
      ships.push(makeShip(`crowd-${index}`, 300 + index * 70, 400));
    }
    const room = makeRoom({ p1: { team: "A", ships } });
    room.spatialIndex.rebuildKind("ships", ships, shipBroadPhaseRadius, 0);
    commandShips(room, room.players.get("p1"), 1000, 800, {
      shipIds: ships.map((ship) => ship.id)
    });
    const tracks = run(room, 30, { settleAfter: 14 });
    let totalRotation = 0;
    for (const track of tracks.values()) {
      totalRotation += track.rotation;
      assert(Math.hypot(
        track.ship.x - track.ship.targetX,
        track.ship.y - track.ship.targetY
      ) < 32, `${track.ship.id} should end on the slot it was given`);
    }
    assert(totalRotation < 600,
      `a settled crowd should not keep turning (${totalRotation.toFixed(0)} deg over six ships)`);
    const sideFlips = room.spawnCollisionDiagnostics?.shipAvoidanceSideChanges || 0;
    assert(sideFlips < 60,
      `dodge side should stay committed rather than flip per neighbour (${sideFlips} flips)`);
    console.log(`  crowd arrival: ${totalRotation.toFixed(0)} deg residual rotation, ${sideFlips} side flips`);
  }

  {
    // Two similar hulls converging head-on. Priority is antisymmetric, so
    // exactly one of them gives way -- if both do, neither closes and they slide
    // sideways past each other forever.
    const west = makeShip("pass-west", 500, 800);
    const east = makeShip("pass-east", 1500, 800);
    const room = makeRoom({ p1: { team: "A", ships: [west, east] } });
    room.spatialIndex.rebuildKind("ships", [west, east], shipBroadPhaseRadius, 0);
    commandShips(room, room.players.get("p1"), 1500, 800, { shipIds: [west.id] });
    commandShips(room, room.players.get("p1"), 500, 800, { shipIds: [east.id] });
    run(room, 25);
    for (const ship of [west, east]) {
      assert.strictEqual(ship.movement.phase, "positioned",
        `${ship.id} should get past an oncoming hull, not stall against it`);
      assert(Math.hypot(ship.x - ship.targetX, ship.y - ship.targetY) < 32,
        `${ship.id} should reach the far side`);
    }
    console.log("  head-on passing: both ships completed the crossing");
  }

  {
    // A charge ends with the ship pressed against its target's hull, where the
    // goal is a couple of pixels away. The bearing to a point that close is
    // noise; steering by it spun the ship a full turn every few seconds while it
    // sat still. It should hold its nose on the target instead.
    const charger = makeShip("charger", 500, 800);
    const wingman = makeShip("charger-wing", 500, 880);
    const enemy = makeShip("charge-target", 1200, 800, "p2", "B");
    const room = makeRoom({
      p1: { team: "A", ships: [charger, wingman] },
      p2: { team: "B", ships: [enemy] }
    });
    for (const ship of [charger, wingman]) {
      applyCombatStyle(ship, "charge");
      ship.combatTargetId = enemy.id;
      ship.focusTargetId = enemy.id;
    }
    const tracks = run(room, 30, { watch: [charger], settleAfter: 10 });
    const track = tracks.get(charger.id);
    const averageSpeed = track.speeds.reduce((sum, value) => sum + value, 0)
      / track.speeds.length;
    assert(averageSpeed < 40,
      `a charger at contact should be settled (${averageSpeed.toFixed(1)} px/s)`);
    assert(track.rotation < 900,
      `a settled charger should not spin on the spot (${track.rotation.toFixed(0)} deg in 20 s)`);
    const bearing = Math.atan2(enemy.y - charger.y, enemy.x - charger.x);
    let error = Math.abs(charger.angle - bearing);
    while (error > Math.PI) error = Math.abs(error - Math.PI * 2);
    assert(error < 0.6,
      `a settled charger should point at its target (${(error * 180 / Math.PI).toFixed(0)} deg off)`);
    console.log(`  charge at contact: ${track.rotation.toFixed(0)} deg over 20 s, ${(error * 180 / Math.PI).toFixed(0)} deg off target`);
  }

  {
    // A station sitting on the orbit ring. Not a fixed bug -- a standing
    // invariant, and one that is easy to break while tuning how far the aim
    // point may slide round the circle: a ship steered at a point most of the
    // way round flies the chord to it, and that chord runs through the middle of
    // the orbit. Both of the obvious "fixes" for that (capping the slide, which
    // sends the route through the obstacle instead; forcing an early reversal,
    // whose hairpin cuts in further still) measured worse here than leaving it
    // alone, so this guards the outcome rather than the mechanism.
    const orbiter = makeShip("orbiter", 500, 800);
    const enemy = makeShip("orbit-target", 1200, 800, "p2", "B");
    const room = makeRoom({
      p1: { team: "A", ships: [orbiter] },
      p2: { team: "B", ships: [enemy] }
    }, [{ x: 1200, y: 500 }]);
    applyCombatStyle(orbiter, "orbit");
    orbiter.combatTargetId = enemy.id;
    orbiter.focusTargetId = enemy.id;
    const tracks = run(room, 30, {
      watch: [orbiter],
      settleAfter: 10,
      rangeTo: enemy
    });
    const ranges = tracks.get(orbiter.id).ranges;
    const closest = Math.min(...ranges);
    assert(closest > 300,
      `an orbit past a station should stay off its target (closed to ${closest.toFixed(0)} px)`);
    console.log(`  orbit past a station: held ${closest.toFixed(0)}-${Math.max(...ranges).toFixed(0)} px`);
  }

  {
    // A destination the hull is too wide to reach. The old planner answered a
    // failed search with a straight line to the destination -- through the
    // structure the search had just proved impassable -- so the ship drove into
    // a station and stayed there being pushed out, 95% of ticks in contact, for
    // as long as the order stood.
    const wide = makeShip("wide-hull", 300, 800);
    wide.radius = 240;
    const room = makeRoom({ p1: { team: "A", ships: [wide] } },
      [{ x: 1000, y: 500 }, { x: 1000, y: 1100 }]);
    room.spatialIndex.rebuildKind("ships", [wide], shipBroadPhaseRadius, 0);
    const clearance = navigationClearanceRadius(wide);
    const search = searchPathWorld(room, wide.x, wide.y, 1700, 800, clearance);
    assert.strictEqual(search.reachedGoal, false,
      "the gap between the two stations should be too narrow for this hull");
    assert(search.waypoints.length > 0,
      "an unreachable destination should still yield the best route available");
    commandShips(room, room.players.get("p1"), 1700, 800, { shipIds: [wide.id] });
    const tracks = run(room, 40, { watch: [wide] });
    const track = tracks.get(wide.id);
    assert(track.contactTicks < 30,
      `an unreachable order must not grind the hull along a station (${track.contactTicks} ticks in contact)`);
    assert.strictEqual(wide.movement.phase, "positioned",
      "a ship that has gone as far as it can should settle, not keep pressing");
    console.log(`  unreachable destination: settled with ${track.contactTicks} contact ticks`);
  }

  {
    // The order marker and the place the ship stops have to be the same place.
    // Slots were chosen against the hull clearance while the planner demands
    // half a grid cell more, so near a station the planner quietly relocated the
    // goal and the ship parked hundreds of pixels from where the player clicked
    // while reporting itself arrived.
    const wide = makeShip("marker-hull", 300, 800);
    wide.radius = 160;
    const room = makeRoom({ p1: { team: "A", ships: [wide] } }, [{ x: 1000, y: 300 }]);
    room.spatialIndex.rebuildKind("ships", [wide], shipBroadPhaseRadius, 0);
    commandShips(room, room.players.get("p1"), 1000, 120, { shipIds: [wide.id] });
    run(room, 40, { watch: [wide] });
    const drift = Math.hypot(wide.x - wide.targetX, wide.y - wide.targetY);
    assert.strictEqual(wide.movement.phase, "positioned", "the move should complete");
    assert(drift < 40,
      `a ship reporting itself arrived must be at its order marker (${drift.toFixed(0)} px away)`);
    console.log(`  order marker: ship parked ${drift.toFixed(0)} px from its marker`);
  }

  console.log("Movement stability verification passed");
}

run_();
