#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  updateProximityCharges,
  detonateProximityCharge,
  armedProximityChargeRanges,
  proximityChargeDestroyedShip
} = require("./src/server/combat");
const { initComponentState, initProximityChargeState, onComponentDestroyed } = require("./src/server/componentHealth");
const { PARTS } = require("./src/server/components");
const { buildRoomSpatialIndex } = require("./src/server/spatialIndex");

function makePlayers() {
  return new Map([
    ["blue", { id: "blue", team: "a" }],
    ["red", { id: "red", team: "b" }],
    ["ally", { id: "ally", team: "a" }]
  ]);
}

function makeShip(id, ownerId, x, y, design) {
  const ship = {
    id, ownerId, alive: true, x, y, vx: 0, vy: 0, angle: 0,
    focusTargetId: null, combatTargetId: null, commandState: "mainCore",
    targetX: x, targetY: y, arrived: true, isManualMove: false,
    stats: { maxHp: 0, unitCost: 100, radius: 20 },
    design, dirtyComponents: new Set(),
    componentPower: { byComponentIndex: design.map(() => ({ operationalMultiplier: 1 })) },
    dirtyPower: false, powerRevision: 1,
    dirtyComponentsVisual: false
  };
  initComponentState(ship);
  initProximityChargeState(ship);
  ship.componentPower = { byComponentIndex: design.map(() => ({ operationalMultiplier: 1 })) };
  ship.shield = 0;
  ship.maxShield = 0;
  ship.radius = 20;
  ship.stats.maxHp = ship.maxHp;
  return ship;
}

function makeRoom(extra = {}) {
  const room = {
    players: makePlayers(),
    ships: new Map(),
    drones: new Map(),
    bullets: [],
    effects: [],
    points: [],
    map: { asteroids: [] },
    rules: { gameMode: "teams" },
    world: { width: 2000, height: 2000 },
    disableSpatialIndex: true,
    ...extra
  };
  return room;
}

function chargeDesign() {
  return [
    { x: 7, y: 7, type: "core" },
    { x: 5, y: 7, type: "proximityDemolitionCharge" }
  ];
}

function basicDesign() {
  return [
    { x: 7, y: 7, type: "core" },
    { x: 6, y: 7, type: "frame" }
  ];
}

{
  const room = makeRoom();
  const carrier = makeShip("carrier", "blue", 0, 0, chargeDesign());
  const enemy = makeShip("enemy", "red", 95, 0, basicDesign());
  room.ships.set(carrier.id, carrier);
  room.ships.set(enemy.id, enemy);
  assert.equal(carrier.proximityChargeDetonated[1], 0, "Charge intact by default");
  let now = 0;
  updateProximityCharges(room, [carrier, enemy], 0.05, now);
  assert.equal(enemy.hp, enemy.maxHp, "Enemy just outside trigger takes no damage");
  enemy.x = 80;
  for (let i = 0; i < 10; i += 1) {
    now += 50;
    updateProximityCharges(room, [carrier, enemy], 0.05, now);
  }
  assert.ok(enemy.hp < enemy.maxHp || !carrier.alive, "Enemy inside trigger for confirmation period detonates charge");
  assert.equal(carrier.proximityChargeDetonated[1], 1, "Charge marked detonated");
}

{
  const room = makeRoom();
  const carrier = makeShip("carrier", "blue", 0, 0, chargeDesign());
  const ally = makeShip("ally", "ally", 50, 0, basicDesign());
  room.ships.set(carrier.id, carrier);
  room.ships.set(ally.id, ally);
  let now = 0;
  for (let i = 0; i < 10; i += 1) {
    now += 50;
    updateProximityCharges(room, [carrier, ally], 0.05, now);
  }
  assert.equal(carrier.proximityChargeDetonated[1], 0, "Friendly ship does not trigger charge");
  assert.equal(ally.hp, ally.maxHp, "Friendly ship takes no proximity damage");
}

{
  const room = makeRoom();
  const carrier = makeShip("carrier", "blue", 0, 0, chargeDesign());
  const enemy = makeShip("enemy", "red", 100, 0, basicDesign());
  room.ships.set(carrier.id, carrier);
  room.ships.set(enemy.id, enemy);
  detonateProximityCharge(room, carrier, 1, 0, true);
  assert.ok(carrier.proximityChargeDetonated[1] === 1, "Detonation marks charge");
  assert.ok(enemy.hp < enemy.maxHp, "Enemy takes blast damage");
  assert.ok(carrier.hp < carrier.maxHp, "Carrier takes blast damage");
}

{
  const room = makeRoom();
  const carrier = makeShip("carrier", "blue", 0, 0, chargeDesign());
  const missile = {
    id: "m", type: "missile", ownerId: "red", x: 50, y: 0, vx: 0, vy: 0,
    life: 2, interceptable: true, hp: 30, damage: 40
  };
  room.bullets.push(missile);
  room.ships.set(carrier.id, carrier);
  detonateProximityCharge(room, carrier, 1, 0, true);
  assert.ok(missile.hp < 30 || missile.life <= 0, "Interceptable projectile takes blast damage");
}

{
  const room = makeRoom();
  const carrier = makeShip("carrier", "blue", 0, 0, chargeDesign());
  const enemy = makeShip("enemy", "red", 100, 0, basicDesign());
  room.ships.set(carrier.id, carrier);
  room.ships.set(enemy.id, enemy);
  carrier.componentHp[1] = 0.1;
  onComponentDestroyed(room, carrier, 1, 0);
  assert.equal(carrier.proximityChargeDetonated[1], 1, "Charge destruction detonates immediately");
  assert.ok(enemy.hp < enemy.maxHp, "Charge destruction blast damages enemy");
  const before = enemy.hp;
  detonateProximityCharge(room, carrier, 1, 10, true);
  assert.equal(enemy.hp, before, "Double detonation cannot occur");
}

{
  const room = makeRoom();
  const carrier = makeShip("carrier", "blue", 0, 0, chargeDesign());
  const enemy = makeShip("enemy", "red", 100, 0, basicDesign());
  room.ships.set(carrier.id, carrier);
  room.ships.set(enemy.id, enemy);
  proximityChargeDestroyedShip(room, carrier, 0);
  assert.equal(carrier.proximityChargeDetonated[1], 1, "Carrier destruction triggers intact charge");
  assert.ok(enemy.hp < enemy.maxHp, "Carrier-destruction detonation damages enemy");
}

{
  const carrier = makeShip("carrier", "blue", 0, 0, chargeDesign());
  assert.equal(armedProximityChargeRanges(carrier).minTrigger, 100, "Trigger radius from balance");
  const room = makeRoom();
  room.ships.set(carrier.id, carrier);
  detonateProximityCharge(room, carrier, 1, 0, true);
  assert.equal(armedProximityChargeRanges(carrier).armed, false, "Detonated charge no longer contributes ranges");
}

console.log("Proximity charge verification passed");
