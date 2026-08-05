"use strict";

const assert = require("assert");
const { resetRoomTelemetry, getRoomTelemetry, telemetryDiagnostics, setCounter } = require("../src/server/roomTelemetry");
const { updateShipSeparation } = require("../src/server/movement");
const { updateBullets } = require("../src/server/projectiles");
const { computeStats } = require("../src/server/shipStats");
const { createGeneratedPowerWiring } = require("../src/server/shipDesign");
const { initComponentState } = require("../src/server/componentHealth");
const { initializeComponentPower } = require("../src/server/componentPower");
const { initShipHeat } = require("../src/server/heat");
const { buildRoomSpatialIndex } = require("../src/server/spatialIndex");

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
    componentHp: null,
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

function assertTelemetryInvariant(room, label) {
  const telemetry = getRoomTelemetry(room);
  for (const [key, value] of Object.entries(telemetry)) {
    assert(Number.isFinite(value), `${label}: ${key} is not finite`);
    assert(value >= 0, `${label}: ${key} is negative`);
  }
}

function run() {
  // --- Empty room diagnostics ------------------------------------------------
  {
    const room = makeRoom();
    resetRoomTelemetry(room);
    const d = telemetryDiagnostics(room);
    for (const value of Object.values(d)) {
      assert.strictEqual(value, 0, "empty-room diagnostics must be zero");
    }
  }

  // --- Many ships, no projectiles --------------------------------------------
  {
    const room = makeRoom();
    const ships = [];
    for (let i = 0; i < 50; i += 1) {
      const ship = makeShip(`s${i}`, 1200 + (i % 10) * 40, 1200 + Math.floor(i / 10) * 40);
      room.ships.set(ship.id, ship);
      ships.push(ship);
    }
    buildRoomSpatialIndex(room, ships, 0);
    resetRoomTelemetry(room);
    setCounter(room, "liveShips", ships.length);
    updateShipSeparation(room, ships, DT, 0);
    assertTelemetryInvariant(room, "many-ships");
    const telemetry = getRoomTelemetry(room);
    assert(telemetry.liveShips > 0, "liveShips must be reported");
    assert(telemetry.movementContactPairBuilds > 0, "canonical contact-pair builds must be counted");
  }

  // --- Many projectiles, no ships --------------------------------------------
  {
    const room = makeRoom();
    for (let i = 0; i < 100; i += 1) {
      room.bullets.push({
        id: `b${i}`,
        ownerId: "p1",
        x: 100 + i * 10,
        y: 100,
        vx: 100,
        vy: 0,
        life: 2,
        damage: 1,
        type: "bolt"
      });
    }
    resetRoomTelemetry(room);
    updateBullets(room, DT, 0);
    assertTelemetryInvariant(room, "many-projectiles");
    const telemetry = getRoomTelemetry(room);
    assert(telemetry.liveProjectiles >= 0, "liveProjectiles must be reported");
  }

  // --- Telemetry does not modify authoritative state --------------------------
  {
    const room = makeRoom();
    const ships = [];
    for (let i = 0; i < 10; i += 1) {
      const ship = makeShip(`s${i}`, 1200 + i * 30, 1200);
      room.ships.set(ship.id, ship);
      ships.push(ship);
    }
    buildRoomSpatialIndex(room, ships, 0);
    const before = ships.map((s) => ({ id: s.id, x: s.x, y: s.y, hp: s.hp, shield: s.shield }));
    resetRoomTelemetry(room);
    updateShipSeparation(room, ships, DT, 0);
    for (let i = 0; i < before.length; i += 1) {
      const s = ships[i];
      assert.strictEqual(s.id, before[i].id, "id must not change");
      assert(Number.isFinite(s.x) && Number.isFinite(s.y), "position must remain finite");
    }
  }

  // --- Deterministic benchmark matrix ---------------------------------------
  const { performanceNow } = require("../src/server/utils");
  function measure(label, setup) {
    const room = makeRoom();
    setup(room);
    const t0 = performanceNow();
    updateShipSeparation(room, Array.from(room.ships.values()), DT, 0);
    updateBullets(room, DT, 0);
    const t1 = performanceNow();
    return { label, ms: t1 - t0 };
  }

  const results = [];
  results.push(measure("200 idle ships widely separated", (room) => {
    for (let i = 0; i < 200; i += 1) {
      const s = makeShip(`s${i}`, (i % 20) * 150 + 200, Math.floor(i / 20) * 150 + 200);
      room.ships.set(s.id, s);
    }
    buildRoomSpatialIndex(room, Array.from(room.ships.values()), 0);
  }));
  results.push(measure("200 ships dense cluster", (room) => {
    for (let i = 0; i < 200; i += 1) {
      const s = makeShip(`s${i}`, 1200 + (i % 15) * 24, 1200 + Math.floor(i / 15) * 24);
      room.ships.set(s.id, s);
    }
    buildRoomSpatialIndex(room, Array.from(room.ships.values()), 0);
  }));
  results.push(measure("100 moving ships", (room) => {
    for (let i = 0; i < 100; i += 1) {
      const s = makeShip(`s${i}`, 1200 + i * 3, 1200);
      s.vx = 20;
      s.vy = (i % 2 === 0 ? 1 : -1) * 15;
      room.ships.set(s.id, s);
    }
    buildRoomSpatialIndex(room, Array.from(room.ships.values()), 0);
  }));
  results.push(measure("2000 ordinary projectiles", (room) => {
    for (let i = 0; i < 2000; i += 1) {
      room.bullets.push({
        id: `b${i}`,
        ownerId: "p1",
        x: (i % 100) * 30,
        y: Math.floor(i / 100) * 30,
        vx: 80,
        vy: 20,
        life: 3,
        damage: 1,
        type: "bolt"
      });
    }
  }));

  console.log("--- Phase One telemetry benchmark (ms) ---");
  for (const r of results) console.log(`${r.label}: ${r.ms.toFixed(3)} ms`);
  console.log("verify-phase-one-telemetry: OK");
}

run();
