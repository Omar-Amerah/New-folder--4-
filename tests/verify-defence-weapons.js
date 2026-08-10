#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { PARTS } = require("../src/server/components");
const { updateBullets } = require("../src/server/projectiles");
const { collectStableThreats } = require("../src/server/decoys")._test;

// Static regression checks on the authoritative balance values that the
// defensive-weapon fixes depend on.
assert.equal(PARTS.flakCannon.weapon.directImpactBonus, undefined, "flak no longer uses directImpactBonus");
assert.ok(PARTS.flakCannon.weapon.directDamage > 0, "flak has a directDamage value for physical hits");
assert.equal(PARTS.flakCannon.weapon.directDamage, PARTS.flakCannon.weapon.damage, "flak directDamage defaults to base damage");
assert.ok(Number(PARTS.pointDefense.weapon.shipDamageMultiplier) < 1, "laser PD is weak against ships");
assert.ok(Number(PARTS.interceptorPod.weapon.shipDamageMultiplier) < 1, "interceptor pod is weak against ships");
assert.ok(PARTS.fleetDefenceCoordinator.aura.pointDefenceTrackingMultiplier > 1, "Fleet Defence Coordinator buffs PD tracking");
assert.ok(PARTS.fleetDefenceCoordinator.aura.flakTrackingMultiplier > 1, "Fleet Defence Coordinator buffs flak tracking");

function makeRoomWithThreats(ship, bullets) {
  return {
    rules: { gameMode: "teams" },
    players: new Map([
      ["blue", { id: "blue", team: "blue" }],
      ["red", { id: "red", team: "red" }]
    ]),
    ships: new Map([[ship.id, ship]]),
    bullets,
    decoys: new Map(),
    drones: new Map(),
    map: { asteroids: [], safeZones: [] }
  };
}

// 1. Decoy threat detection ignores missiles that are moving away.
{
  const ship = { id: "s", ownerId: "blue", x: 500, y: 500, vx: 0, vy: 0, angle: 0 };
  const incoming = { id: "in", type: "missile", ownerId: "red", targetId: "s", x: 600, y: 500, vx: -100, vy: 0, life: 10, tracking: 0.7, trackRemaining: 5, interceptable: true };
  const movingAway = { id: "out", type: "missile", ownerId: "red", targetId: "s", x: 600, y: 500, vx: 100, vy: 0, life: 10, tracking: 0.7, trackRemaining: 5, interceptable: true };
  const tangential = { id: "tan", type: "missile", ownerId: "red", targetId: "s", x: 600, y: 500, vx: 0, vy: 100, life: 10, tracking: 0.7, trackRemaining: 5, interceptable: true };
  const room = makeRoomWithThreats(ship, [incoming, movingAway, tangential]);
  const output = [];
  collectStableThreats(room, ship, 600, output);
  assert.deepEqual(output.map((p) => p.id), ["in"], "only incoming guided missiles are credible threats");
  console.log("✔ Decoy threat detection filters non-closing missiles.");
}

// 2. Flak balance has the values needed for the unified detonation model.
assert.ok(PARTS.flakCannon.weapon.blastDamage > 0, "flak has blast damage");
assert.ok(PARTS.flakCannon.weapon.proximityFuseRadius > 0, "flak has a proximity fuse radius");
assert.ok(PARTS.flakCannon.weapon.projectileLifetime > 0 || PARTS.flakCannon.weapon.range > 0, "flak has a finite lifetime");
console.log("✔ Flak balance supports direct/proximity/asteroid detonation model.");

// 3. Flak direct hit applies blast plus directDamage to the struck entity.
{
  const room = {
    rules: { gameMode: "teams" },
    players: new Map([["red", { id: "red", team: "red" }], ["blue", { id: "blue", team: "blue" }]]),
    world: { width: 2000, height: 2000 },
    disableSpatialIndex: true,
    ships: new Map(),
    drones: new Map([["d1", { id: "d1", type: "drone", droneType: "fighter", ownerId: "red", x: 0, y: 30, hull: 100, maxHull: 100, destroyed: false, removed: false }]]),
    decoys: new Map(),
    bullets: [],
    effects: [],
    map: { asteroids: [] }
  };
  const weapon = PARTS.flakCannon.weapon;
  const bullet = { id: "f1", type: "flak", subtype: "flakCannon", ownerId: "blue", x: 0, y: 0, vx: 0, vy: 900, life: 10, damage: weapon.directDamage, directDamage: weapon.directDamage, blastDamage: weapon.blastDamage, blastRadius: weapon.blastRadius, proximityFuseRadius: weapon.proximityFuseRadius, innerFullDamageRadius: weapon.innerFullDamageRadius, falloffExponent: weapon.falloffExponent, shieldDamageMultiplier: weapon.shieldDamageMultiplier ?? 1, hullDamageMultiplier: weapon.hullDamageMultiplier ?? 1, maximumExplosionTargets: 1 };
  room.bullets.push(bullet);
  updateBullets(room, 0.1, 0);
  const drone = room.drones.get("d1");
  const expected = 100 - (weapon.blastDamage + weapon.directDamage);
  assert.ok(Math.abs(drone.hull - expected) < 0.01, "Flak direct hit adds directDamage on top of blast");
  console.log("✔ Flak direct hit applies direct damage plus blast.");
}

console.log("Defence weapons regression verification passed.");
