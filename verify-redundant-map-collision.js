"use strict";

const assert = require("assert");
const { updateShipSeparation, resolveFleetMapCollisions } = require("./src/server/movement");
const { __setCircularShipSeparation, __setRedundantFleetMapCollisionPass } = require("./src/server/performanceFlags");
const { computeStats } = require("./src/server/shipStats");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { buildRoomSpatialIndex } = require("./src/server/spatialIndex");

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
