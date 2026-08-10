"use strict";

const assert = require("assert");
const { PARTS } = require("../src/server/components");
const { weaponSpreadRadians } = require("../src/server/combat");
const { updateBullets } = require("../src/server/projectiles");

function approx(actual, expected, message) {
  assert(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} !== ${expected}`);
}

// Accuracy depends on the authored weapon value and explicit weapon modifiers,
// not on a target's current movement.
{
  const weapon = { accuracy: 0.72 };
  const stationary = weaponSpreadRadians(weapon, "blaster", 0);
  const lateral = weaponSpreadRadians(weapon, "blaster", 5000);
  approx(lateral, stationary, "target movement does not change weapon spread");
  assert(weaponSpreadRadians({ accuracy: 0.9 }, "blaster") < stationary, "authored accuracy still changes spread");
}

// Missile-family authored speeds have been migrated to the former in-flight
// maximum. Other projectile families keep their authored values.
{
  for (const [type, oldSpeed, migratedSpeed] of [
    ["missile", 300, 435],
    ["swarmMissile", 360, 522],
    ["torpedo", 220, 319]
  ]) {
    const speed = PARTS[type].weapon.projectileSpeed;
    assert.strictEqual(speed, migratedSpeed, `${type} uses the migrated authored speed`);
    assert.strictEqual(speed, oldSpeed * 1.45, `${type} migration matches the former maximum`);
  }
  assert.strictEqual(PARTS.blaster.weapon.projectileSpeed, 760, "blaster speed is not missile-multiplied");
  assert.strictEqual(PARTS.railgun.weapon.projectileSpeed, 2300, "railgun speed is not missile-multiplied");
  assert.strictEqual(PARTS.pointDefense.weapon.projectileSpeed, 0, "point-defense speed is not missile-multiplied");
}

// Guidance can rotate a missile, but every tick preserves its literal
// projectile speed.
{
  const target = {
    id: "target",
    ownerId: "b",
    x: 10000,
    y: 10000,
    vx: 0,
    vy: 300,
    radius: 30,
    physicalRadius: 30,
    alive: true,
    removed: false,
    shield: 0,
    hp: 100,
    maxHp: 100,
    componentHp: [],
    componentMaxHp: []
  };
  const room = {
    rules: { gameMode: "teams" },
    players: new Map([
      ["a", { id: "a", team: 1 }],
      ["b", { id: "b", team: 2 }]
    ]),
    ships: new Map([[target.id, target]]),
    bullets: [{
      id: "m1",
      type: "missile",
      ownerId: "a",
      targetId: target.id,
      x: 1000,
      y: 1000,
      vx: 435,
      vy: 0,
      projectileSpeed: 435,
      tracking: 1,
      trackingDelay: 0,
      trackRemaining: 100,
      age: 0,
      life: 100,
      damage: 1,
      hp: 10,
      interceptable: true
    }],
    effects: [],
    map: { asteroids: [], safeZones: [] },
    world: { width: 20000, height: 20000 },
    drones: new Map(),
    decoys: new Map(),
    stations: [],
    combatRandom: Math.random
  };

  updateBullets(room, 0.5, 500);
  assert.strictEqual(room.bullets.length, 1, "guided missile remains in flight");
  const missile = room.bullets[0];
  approx(Math.hypot(missile.vx, missile.vy), 435, "guidance preserves literal missile speed");
  assert(Math.abs(missile.vy) > 0, "guidance can rotate the missile direction");
  updateBullets(room, 0.5, 1000);
  approx(Math.hypot(room.bullets[0].vx, room.bullets[0].vy), 435, "missile speed remains constant after another tick");
}

console.log("Hidden mechanics verification passed");
