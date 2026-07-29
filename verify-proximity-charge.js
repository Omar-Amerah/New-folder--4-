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

function makeShip(id, ownerId, x, y, design, extra = {}) {
  const ship = {
    id, ownerId, alive: true, x, y, vx: 0, vy: 0, angle: 0,
    focusTargetId: null, combatTargetId: null, commandState: "mainCore",
    targetX: x, targetY: y, arrived: true,
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
  if (extra.maxHp > 0) {
    const per = Math.max(1, Math.ceil(extra.maxHp / design.length));
    ship.componentMaxHp = design.map(() => per);
    ship.componentHp = design.map(() => per);
    ship.maxHp = per * design.length;
    ship.hp = ship.maxHp;
    ship.stats.maxHp = ship.maxHp;
  }
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
  enemy.x = 50;
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
  assert.equal(armedProximityChargeRanges(carrier).minTrigger, 0, "Trigger radius from balance");
  const room = makeRoom();
  room.ships.set(carrier.id, carrier);
  detonateProximityCharge(room, carrier, 1, 0, true);
  assert.equal(armedProximityChargeRanges(carrier).armed, false, "Detonated charge no longer contributes ranges");
}

// --- One total damage budget per ship ---

function largeDesign() {
  const d = [{ x: 7, y: 7, type: "core" }];
  let row = 6;
  for (let i = 0; i < 12; i += 1) {
    d.push({ x: row, y: 7, type: "frame" });
    row -= 1;
  }
  return d;
}

{
  const room = makeRoom();
  const carrier = makeShip("carrier", "blue", 0, 0, chargeDesign());
  const enemy = makeShip("enemy", "red", 20, 0, largeDesign());
  room.ships.set(carrier.id, carrier);
  room.ships.set(enemy.id, enemy);

  const enemyHpBefore = enemy.hp;
  detonateProximityCharge(room, carrier, 1, 0, true);

  const enemyHpLost = enemyHpBefore - enemy.hp;
  // With 8000 centre damage, quadratic falloff (exponent 2), distance ~20 from the blast,
  // the total damage to the enemy ship must not exceed the single blast value.
  // blastDamage = 8000 * (1 - 20/420)^2 ≈ 8000 * 0.907 ≈ 7256
  // The total hull damage to the enemy should be <= ~8100.
  assert.ok(enemyHpLost <= 8100, `Large ship total damage ${enemyHpLost} should not exceed single blast budget (~8000)`);
  assert.ok(enemyHpLost > 0, "Large ship takes some damage");
}

// --- Quadratic falloff ---

{
  const room = makeRoom();
  const carrier = makeShip("carrier", "blue", 0, 0, chargeDesign());
  const near = makeShip("near", "red", 20, 0, largeDesign(), { maxHp: 100000 });
  const mid = makeShip("mid", "red", 150, 0, largeDesign(), { maxHp: 100000 });
  room.ships.set(carrier.id, carrier);
  room.ships.set(near.id, near);
  room.ships.set(mid.id, mid);

  const nearHpBefore = near.hp;
  const midHpBefore = mid.hp;
  detonateProximityCharge(room, carrier, 1, 0, true);

  const nearLoss = nearHpBefore - near.hp;
  const midLoss = midHpBefore - mid.hp;

  // Near ship at ~20 distance should take much more damage than mid ship at ~150.
  assert.ok(nearLoss > midLoss * 2, `Near ship (${nearLoss}) should take significantly more than mid ship (${midLoss})`);
  assert.ok(midLoss > 0, "Mid-range ship takes damage");
}

// --- Diminishing returns for multiple charges ---

function multiChargeDesign() {
  return [
    { x: 7, y: 7, type: "core" },
    { x: 6, y: 7, type: "frame" },
    { x: 5, y: 7, type: "proximityDemolitionCharge" },
    { x: 3, y: 7, type: "proximityDemolitionCharge" }
  ];
}

{
  // Multi-charge: 2 charges deal more damage than 1 due to combined multiplier (1.0 + 0.5 = 1.5x)
  const room1 = makeRoom();
  const room2 = makeRoom();
  const one = makeShip("one", "blue", 0, 0, chargeDesign());
  const two = makeShip("two", "blue", 0, 0, multiChargeDesign());
  const enemy1 = makeShip("e1", "red", 20, 0, largeDesign(), { maxHp: 100000 });
  const enemy2 = makeShip("e2", "red", 20, 0, largeDesign(), { maxHp: 100000 });
  room1.ships.set("one", one);
  room1.ships.set("e1", enemy1);
  room2.ships.set("two", two);
  room2.ships.set("e2", enemy2);
  detonateProximityCharge(room1, one, 1, 0, true);
  detonateProximityCharge(room2, two, 2, 0, true);
  const loss1 = enemy1.maxHp - enemy1.hp;
  const loss2 = enemy2.maxHp - enemy2.hp;
  assert.ok(loss2 > loss1, `Two charges (${loss2}) should deal more damage than one (${loss1})`);
  assert.ok(loss2 < loss1 * 2, `Two charges (${loss2}) should deal less than 2x one charge (${loss1}) due to diminishing returns`);
}

// --- Heavy charge has no max affected-components limit ---

{
  const room = makeRoom();
  const carrier = makeShip("carrier", "blue", 0, 0, chargeDesign());
  // Create a ship with many components
  const manyDesign = [{ x: 7, y: 7, type: "core" }];
  for (let i = 0; i < 20; i += 1) {
    manyDesign.push({ x: 7 - i - 1, y: 7, type: "frame" });
  }
  const enemy = makeShip("enemy", "red", 20, 0, manyDesign, { maxHp: 100000 });
  room.ships.set(carrier.id, carrier);
  room.ships.set(enemy.id, enemy);

  const hpBefore = enemy.componentHp.slice();
  detonateProximityCharge(room, carrier, 1, 0, true);

  let damagedCount = 0;
  for (let i = 0; i < enemy.componentHp.length; i += 1) {
    if (enemy.componentHp[i] < hpBefore[i]) damagedCount += 1;
  }

  assert.equal(damagedCount, enemy.design.length, `Heavy charge should damage every component, got ${damagedCount}`);
}

console.log("Proximity charge verification passed");
