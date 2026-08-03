"use strict";

const assert = require("assert");
const { updateShipSeparation, resolveFleetMapCollisions } = require("./src/server/movement");
const {
  __setCircularShipSeparation,
  __setRedundantFleetMapCollisionPass,
  redundantFleetMapCollisionPass
} = require("./src/server/performanceFlags");
const { computeStats } = require("./src/server/shipStats");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { buildRoomSpatialIndex } = require("./src/server/spatialIndex");
const { movementTestTick } = require("./tools/movementTestTick");
const {
  STATIC_COLLISION_MAX_TICK_CORRECTION,
  PACKED_FLEET_LARGE_ISLAND_MAX_TICK_CORRECTION,
  PACKED_FLEET_MAX_TICK_CORRECTION
} = require("./src/server/movementTuning");

const DT = 1 / 30;

const LIGHT_DESIGN = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" }
];

function makeShip(id, x, y) {
  const stats = computeStats(LIGHT_DESIGN);
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
    physicalRadius: Math.max(18, stats.radius * 0.56),
    design: LIGHT_DESIGN.map((p) => ({ ...p })),
    wiring: createGeneratedPowerWiring(LIGHT_DESIGN),
    stats,
    commandState: "mainCore"
  };
  initComponentState(ship);
  initializeComponentPower(ship);
  initShipHeat(ship);
  ship.shield = ship.maxShield;
  ship.weaponAngles = [];
  ship.weaponCooldowns = [];
  ship.desiredAngles = [];
  ship.aimTargetIds = [];
  ship.componentTargetIds = [];
  ship.beamContacts = [];
  return ship;
}

function makeRoom() {
  return {
    phase: "active",
    world: { width: 4000, height: 3000 },
    map: { asteroids: [] },
    ships: new Map(),
    players: new Map([["p1", { id: "p1", team: "A" }]]),
    stations: [],
    bullets: [],
    drones: new Map(),
    effects: [],
    points: [],
    spatialIndex: null,
    nextEntityId: 1
  };
}

function positions(ships) {
  return ships.map((s) => `${s.id}:${s.x.toFixed(6)}:${s.y.toFixed(6)}`);
}

function run() {
  __setRedundantFleetMapCollisionPass(false);
  assert.strictEqual(redundantFleetMapCollisionPass(), false, "the production collision safety path must be targeted by default");

  // --- Movement substeps do not receive a second fleet-wide map pass --------
  {
    const room = makeRoom();
    const ships = [makeShip("step-a", 700, 700), makeShip("step-b", 1100, 700), makeShip("step-c", 1500, 700)];
    for (const ship of ships) room.ships.set(ship.id, ship);
    movementTestTick(room, ships, DT, 0);
    assert.strictEqual(room._roomTelemetry.staticCollisionCalls, ships.length * 2,
      "a 30 Hz tick should perform exactly one static check per 60 Hz substep");
    assert.strictEqual(room._roomTelemetry.separationMapCollisionCalls, 0,
      "an empty tick should not run a fleet-wide final map pass");
  }

  // --- Deep static contact is recovered without a one-frame relocation ------
  {
    const room = makeRoom();
    const ship = makeShip("deep-static", 2000, 1500);
    ship._staticCollisionCorrectionDistance = 0;
    room.ships.set(ship.id, ship);
    room.stations = [{
      id: "solid-test-station",
      x: 2000,
      y: 1500,
      radius: 500,
      collisionPieces: [{
        id: "solid-piece",
        x: 2000,
        y: 1500,
        angle: 0,
        halfWidth: 160,
        halfHeight: 160
      }]
    }];
    const before = { x: ship.x, y: ship.y };
    require("./src/server/movement").resolveMapCollision(room, ship);
    const displacement = Math.hypot(ship.x - before.x, ship.y - before.y);
    assert(displacement <= STATIC_COLLISION_MAX_TICK_CORRECTION + 1e-6,
      `deep station contact must be capped (${displacement.toFixed(3)} px)`);
    assert(room._roomTelemetry.staticCollisionCorrectionDistance <= STATIC_COLLISION_MAX_TICK_CORRECTION + 1e-6,
      "static correction telemetry must report the bounded applied displacement");
  }

  // --- Dense ship overlap is bounded across all packed-solver iterations -----
  {
    const room = makeRoom();
    const ships = [];
    for (let i = 0; i < 20; i += 1) {
      const ship = makeShip(`packed-${i}`, 2000, 1500);
      room.ships.set(ship.id, ship);
      ships.push(ship);
    }
    buildRoomSpatialIndex(room, ships, 0);
    const before = ships.map((ship) => ({ x: ship.x, y: ship.y }));
    updateShipSeparation(room, ships, DT, 0);
    const largest = ships.reduce((max, ship, index) => Math.max(
      max,
      Math.hypot(ship.x - before[index].x, ship.y - before[index].y)
    ), 0);
    assert(largest <= PACKED_FLEET_LARGE_ISLAND_MAX_TICK_CORRECTION + 1e-6,
      `large-island packed correction must use the lower bound (${largest.toFixed(3)} px)`);
    assert(PACKED_FLEET_LARGE_ISLAND_MAX_TICK_CORRECTION < PACKED_FLEET_MAX_TICK_CORRECTION,
      "large packed islands must have a stricter correction budget");
  }

  __setCircularShipSeparation(true);
  __setRedundantFleetMapCollisionPass(true);

  // --- The fleet-wide map-collision pass after separation is redundant --------
  {
    const room = makeRoom();
    const ships = [];
    for (let i = 0; i < 30; i += 1) {
      const s = makeShip(`s${i}`, 1500 + (i % 6) * 20, 1500 + Math.floor(i / 6) * 20);
      room.ships.set(s.id, s);
      ships.push(s);
    }
    buildRoomSpatialIndex(room, ships, 0);
    updateShipSeparation(room, ships, DT, 0);
    const afterSeparation = positions(ships);
    resolveFleetMapCollisions(room, ships);
    const afterFinalPass = positions(ships);
    assert.deepStrictEqual(afterFinalPass, afterSeparation, "fleet map-collision pass must not move ships after separation");
  }

  // --- Targeted final pass matches full pass for ships that moved ------------
  {
    const room = makeRoom();
    const ships = [];
    for (let i = 0; i < 20; i += 1) {
      const s = makeShip(`s${i}`, 1200 + (i % 5) * 25, 1200 + Math.floor(i / 5) * 25);
      room.ships.set(s.id, s);
      ships.push(s);
    }
    buildRoomSpatialIndex(room, ships, 0);
    const modified = new Set(updateShipSeparation(room, ships, DT, 0));
    resolveFleetMapCollisions(room, ships);
    const fullPassPositions = positions(ships);

    const room2 = makeRoom();
    const ships2 = [];
    for (let i = 0; i < 20; i += 1) {
      const s = makeShip(`s${i}`, 1200 + (i % 5) * 25, 1200 + Math.floor(i / 5) * 25);
      room2.ships.set(s.id, s);
      ships2.push(s);
    }
    buildRoomSpatialIndex(room2, ships2, 0);
    updateShipSeparation(room2, ships2, DT, 0);
    // Targeted pass: only ships modified by separation.
    for (const id of modified) {
      const ship = room2.ships.get(id);
      if (ship) require("./src/server/movement").resolveMapCollision(room2, ship);
    }
    const targetedPositions = positions(ships2);
    assert.deepStrictEqual(targetedPositions, fullPassPositions, "targeted final map-collision pass must match the full pass");
  }

  console.log("verify-redundant-map-collision: OK");
}

run();
