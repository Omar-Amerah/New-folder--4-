"use strict";

// Focused regression coverage for the EMP Cannon's authored anti-Shield contract.
const assert = require("assert");
const { PARTS } = require("../src/server/components");
const { initComponentState } = require("../src/server/componentHealth");
const { addBullet, updateBullets } = require("../src/server/projectiles");
const { applyEmpShieldDisruption } = require("../src/server/empCannon");
const { updateShipWeapons } = require("../src/server/combat");
const { initShipHeat } = require("../src/server/heat");

function makeRoom() {
  return {
    rules: { gameMode: "solo" },
    nextEntityId: 1,
    world: { width: 2000, height: 2000 },
    map: { safeZones: [], asteroids: [] },
    ships: new Map(),
    drones: new Map(),
    decoys: new Map(),
    stations: [],
    bullets: [],
    effects: [],
    disableSpatialIndex: true,
    players: new Map([
      ["attacker", { id: "attacker", team: "blue", ships: [] }],
      ["target-owner", { id: "target-owner", team: "red", ships: [] }]
    ])
  };
}

function makeTarget(shield) {
  const design = [{ type: "core", x: 7, y: 7, rotation: 0 }];
  const target = {
    id: "target",
    ownerId: "target-owner",
    x: 200,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    alive: true,
    removed: false,
    radius: 40,
    hp: 400,
    maxHp: 400,
    shield,
    maxShield: 200,
    design,
    stats: { unitCost: 100, maxHp: 400, radius: 40, powerGeneration: 100, powerUse: 0 },
    componentPower: { byComponentIndex: [{ operationalMultiplier: 1 }] },
    weaponCooldowns: [0],
    weaponAngles: [0],
    weaponDesiredAngles: [null],
    weaponAimTargetIds: [null],
    weaponFireTargetIds: [null]
  };
  initComponentState(target);
  target.hp = 400;
  target.maxHp = 400;
  target.shield = shield;
  target.maxShield = 200;
  return target;
}

function fireEmp(room) {
  addBullet(room, {
    type: "emp",
    subtype: "empCannon",
    ownerId: "attacker",
    targetId: "target",
    x: 0,
    y: 0,
    vx: 1000,
    vy: 0,
    damage: 0,
    radius: 9,
    projectileRadius: 9,
    projectileSpeed: 550,
    shieldDisruptionFraction: 0.5,
    life: 5,
    bornAt: 0
  });
  updateBullets(room, 0.2, 1000);
}

const WeaponPresentationRules = require("../public/src/shared/weaponPresentationRules.js");

const cannon = PARTS.empCannon;
assert(cannon, "EMP Cannon exists");
assert.strictEqual(cannon.maxPerShip, 2, "EMP Cannon is limited to two per ship");
assert.deepStrictEqual(cannon.footprint, { width: 2, height: 3 }, "EMP Cannon has the heavy 2x3 footprint");
assert.strictEqual(cannon.rotatable, true, "EMP Cannon is rotatable");
assert.strictEqual(cannon.weapon.type, "emp", "EMP Cannon uses the EMP weapon family");
assert.strictEqual(cannon.weapon.damage, 0, "EMP Cannon has no ordinary damage");
assert.strictEqual(cannon.weapon.shieldDisruptionFraction, 0.5, "EMP Cannon removes half of maximum Shield");
assert.strictEqual(cannon.weapon.projectileSpeed, 550, "EMP Cannon projectile speed is authored at 550 m/s");
assert.strictEqual(cannon.weapon.projectileRadius, 9, "EMP Cannon has the explicit wide collision radius");

const direct = { shield: 400, maxShield: 400 };
const directResult = applyEmpShieldDisruption(direct, 0.5, "attacker", 10);
assert.strictEqual(directResult.removed, 200, "disruption is based on maximum Shield");
assert.strictEqual(direct.shield, 200, "maximum-Shield disruption leaves the correct remainder");
const clamped = { shield: 25, maxShield: 400 };
const clampedResult = applyEmpShieldDisruption(clamped, 0.5, "attacker", 10);
assert.strictEqual(clampedResult.removed, 25, "disruption is clamped to current Shield");
assert.strictEqual(clamped.shield, 0, "a low Shield is fully removed without overflow");

{
  const room = makeRoom();
  const target = makeTarget(200);
  room.ships.set(target.id, target);
  room.players.get("target-owner").ships.push(target);
  fireEmp(room);
  assert.strictEqual(target.shield, 100, "a full-Shield EMP impact removes 50% of maximum Shield");
  assert.strictEqual(target.hp, 400, "a full-Shield EMP impact does not damage hull");
  assert.strictEqual(room.bullets.length, 0, "the EMP projectile is consumed on impact");
  assert(room.effects.some((effect) => effect.type === "empImpact" && effect.charged === true), "a charged EMP impact is emitted");
  assert(!room.effects.some((effect) => ["shieldhit", "spark", "burst", "rockhit"].includes(effect.type)), "EMP impact does not use ordinary damage effects");
}

{
  const room = makeRoom();
  const target = makeTarget(5);
  room.ships.set(target.id, target);
  room.players.get("target-owner").ships.push(target);
  fireEmp(room);
  assert.strictEqual(target.shield, 0, "a sub-10 Shield is fully removed");
  assert.strictEqual(target.hp, 400, "a low-Shield EMP impact still does not damage hull");
  assert(room.effects.some((effect) => effect.type === "empImpact" && effect.charged === false && effect.shieldRemoved === 5), "a depleted EMP impact records only the remaining Shield");
}

// The emitter art is drawn as a function of the mount's recovery toward its next
// pulse. That telegraph is presentation only: it must report progress, and it
// must never turn the EMP into a charge weapon that has to wind up before firing.
{
  const weapon = cannon.weapon;
  assert.strictEqual(WeaponPresentationRules.hasReloadTelegraph(weapon), true, "the EMP Cannon carries a reload telegraph");
  assert.strictEqual(WeaponPresentationRules.hasReloadTelegraph(PARTS.blaster.weapon), false, "ordinary weapons do not");
  assert.strictEqual(
    WeaponPresentationRules.hasReloadTelegraph(PARTS.spinalAccelerator.weapon),
    false,
    "a spinal mount reports its own accumulator instead of a reload telegraph"
  );
  assert.strictEqual(
    WeaponPresentationRules.weaponCyclePresentation(weapon).isChargeWeapon,
    false,
    "the telegraph does not make the EMP Cannon a charge weapon"
  );

  const reload = 1 / weapon.fireRate;
  assert.strictEqual(WeaponPresentationRules.reloadTelegraphProgress(weapon, reload), 0, "a just-fired mount reads as spent");
  assert.strictEqual(WeaponPresentationRules.reloadTelegraphProgress(weapon, 0), 1, "a mount off cooldown reads as ready");
  const half = WeaponPresentationRules.reloadTelegraphProgress(weapon, reload / 2);
  assert(Math.abs(half - 0.5) < 1e-9, "progress tracks the reload linearly");
  assert.strictEqual(
    WeaponPresentationRules.reloadTelegraphProgress(weapon, reload * 3),
    0,
    "a mount reloading more slowly than authored is clamped rather than reporting a negative charge"
  );
}

// End to end over a real firing cycle: the mount fires the moment it has a
// solution (no wind-up), and the telegraph the art reads runs from spent back to
// ready across the authored reload.
{
  const room = makeRoom();
  room.players.set("p1", { id: "p1", team: "blue", ships: [] });
  room.players.set("p2", { id: "p2", team: "red", ships: [] });
  const design = [
    { type: "core", x: 7, y: 10, rotation: 0 },
    { type: "empCannon", x: 6, y: 4, rotation: 0 }
  ];
  const attacker = {
    id: "emp-ship",
    ownerId: "p1",
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    alive: true,
    removed: false,
    radius: 40,
    shield: 0,
    maxShield: 0,
    design,
    stats: { unitCost: 100, powerUse: 0, powerGeneration: 100, efficiency: 1, accuracyBonus: 0, fireRateBonus: 0 },
    componentPower: { byComponentIndex: design.map(() => ({ operationalMultiplier: 1 })) },
    weaponCooldowns: design.map(() => 0),
    weaponAngles: design.map(() => 0),
    weaponDesiredAngles: design.map(() => null),
    weaponAimTargetIds: design.map(() => null),
    weaponFireTargetIds: design.map(() => null),
    dirtyComponents: new Set()
  };
  initComponentState(attacker);
  attacker.maxHp = attacker.hp;
  attacker.stats.maxHp = attacker.hp;
  const victim = makeTarget(200);
  victim.ownerId = "p2";
  victim.x = 500;
  victim.y = 0;
  initShipHeat(attacker);
  initShipHeat(victim);
  room.ships.set(attacker.id, attacker);
  room.ships.set(victim.id, victim);

  const dt = 0.25;
  let now = 1000;
  let fired = false;
  for (let step = 0; step < 60 && !fired; step += 1) {
    updateShipWeapons(room, attacker, [attacker, victim], dt, now);
    now += dt * 1000;
    fired = room.bullets.length > 0;
  }
  assert(fired, "the EMP Cannon fires as soon as it has a firing solution");

  const weapon = PARTS.empCannon.weapon;
  const reload = 1 / weapon.fireRate;
  assert(Math.abs(attacker.weaponCooldowns[1] - reload) < 1e-6, "and drops into its authored reload");
  assert.strictEqual(
    WeaponPresentationRules.reloadTelegraphProgress(weapon, attacker.weaponCooldowns[1]),
    0,
    "the emitter reads as spent the instant the pulse leaves it"
  );
  attacker.weaponCooldowns[1] = reload * 0.25;
  const recovered = WeaponPresentationRules.reloadTelegraphProgress(weapon, attacker.weaponCooldowns[1]);
  assert(recovered > 0.7 && recovered < 0.8, "and climbs back toward ready as the reload runs down");
}

console.log("EMP CANNON REGRESSION TESTS PASSED");
