"use strict";

const assert = require("assert");
const { updateShipSeparation, resolveMapCollision } = require("./src/server/movement");
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

function makeShip(id, x, y, angle = 0) {
  const stats = computeStats(LIGHT_DESIGN);
  const ship = {
    id,
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

function setUp() {
  __setCircularShipSeparation(false);
  __setRedundantFleetMapCollisionPass(true);
}

function run() {
  setUp();

  // --- Two overlapping ships separate under circular separation ----------------
  {
    __setCircularShipSeparation(true);
    const room = makeRoom();
    const a = makeShip("a", 1200, 1200);
    const b = makeShip("b", 1200, 1200);
    room.ships.set(a.id, a);
    room.ships.set(b.id, b);
    const ships = [a, b];
    buildRoomSpatialIndex(room, ships, 0);
    updateShipSeparation(room, ships, DT, 0);
    assert(a.x !== b.x || a.y !== b.y, "overlapping ships must separate");
  }

  // --- Two non-overlapping ships are not moved -------------------------------
  {
    __setCircularShipSeparation(true);
    const room = makeRoom();
    const a = makeShip("a", 1000, 1000);
    const b = makeShip("b", 1500, 1000);
    room.ships.set(a.id, a);
    room.ships.set(b.id, b);
    const ships = [a, b];
    buildRoomSpatialIndex(room, ships, 0);
    const ax = a.x, ay = a.y, bx = b.x, by = b.y;
    updateShipSeparation(room, ships, DT, 0);
    assert.strictEqual(a.x, ax, "non-overlapping ship a must not be moved");
    assert.strictEqual(a.y, ay, "non-overlapping ship a must not be moved");
    assert.strictEqual(b.x, bx, "non-overlapping ship b must not be moved");
    assert.strictEqual(b.y, by, "non-overlapping ship b must not be moved");
  }

  // --- World boundary keeps ships inside ------------------------------------
  {
    __setCircularShipSeparation(true);
    const room = makeRoom();
    room.world = { width: 200, height: 200 };
    const a = makeShip("a", 20, 20);
    room.ships.set(a.id, a);
    buildRoomSpatialIndex(room, [a], 0);
    resolveMapCollision(room, a);
    assert(a.x > 0 && a.x < room.world.width, "ship must remain inside world");
    assert(a.y > 0 && a.y < room.world.height, "ship must remain inside world");
  }

  // --- Mass-based distribution remains non-negative -------------------------
  {
    __setCircularShipSeparation(true);
    const room = makeRoom();
    const a = makeShip("a", 1200, 1200);
    const b = makeShip("b", 1200, 1200);
    a.stats.mass = 50;
    b.stats.mass = 150;
    room.ships.set(a.id, a);
    room.ships.set(b.id, b);
    buildRoomSpatialIndex(room, [a, b], 0);
    updateShipSeparation(room, [a, b], DT, 0);
    assert(Number.isFinite(a.x) && Number.isFinite(a.y), "ships must remain finite");
    assert(Number.isFinite(b.x) && Number.isFinite(b.y), "ships must remain finite");
  }

  // --- Deterministic for fixed ordering -------------------------------------
  {
    __setCircularShipSeparation(true);
    const runOnce = () => {
      const room = makeRoom();
      const a = makeShip("a", 1200, 1200);
      const b = makeShip("b", 1200, 1200);
      room.ships.set(a.id, a);
      room.ships.set(b.id, b);
      buildRoomSpatialIndex(room, [a, b], 0);
      updateShipSeparation(room, [a, b], DT, 0);
      return { ax: a.x, ay: a.y, bx: b.x, by: b.y };
    };
    const first = runOnce();
    const second = runOnce();
    assert.strictEqual(first.ax, second.ax, "circular separation must be deterministic");
    assert.strictEqual(first.ay, second.ay, "circular separation must be deterministic");
    assert.strictEqual(first.bx, second.bx, "circular separation must be deterministic");
    assert.strictEqual(first.by, second.by, "circular separation must be deterministic");
  }

  // --- Fallback hull path still available -----------------------------------
  {
    __setCircularShipSeparation(false);
    const room = makeRoom();
    const a = makeShip("a", 1200, 1200);
    const b = makeShip("b", 1200, 1200);
    room.ships.set(a.id, a);
    room.ships.set(b.id, b);
    buildRoomSpatialIndex(room, [a, b], 0);
    const before = { ax: a.x, ay: a.y, bx: b.x, by: b.y };
    updateShipSeparation(room, [a, b], DT, 0);
    assert(a.x !== before.ax || a.y !== before.ay || b.x !== before.bx || b.y !== before.by, "hull fallback must still resolve overlaps");
  }

  setUp();
  console.log("verify-circular-separation: OK");
}

run();
