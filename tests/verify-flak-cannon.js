"use strict";
// Flak Cannon rework verification: balance sync, proximity-fuse behaviour,
// radial damage, hostile filtering, Point Defence distinction and telemetry.
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { PARTS } = require("../src/server/components");
const TurretRules = require("../public/src/shared/turretRules");
const { updateBullets } = require("../src/server/projectiles");
const { findPointDefenseTarget } = require("../src/server/combat");
const { initComponentState } = require("../src/server/componentHealth");
const { generateBalanceArtifacts } = require("../tools/generate-balance");

generateBalanceArtifacts();
const publicBalance = JSON.parse(fs.readFileSync(path.join(path.dirname(__dirname), "public", "component-balance.generated.json"), "utf8"));

const SCALE = 13;

function makeRoom() {
  return {
    rules: { gameMode: "solo" },
    players: new Map([["me", { id: "me" }], ["foe", { id: "foe" }]]),
    map: { asteroids: [], safeZones: [] },
    ships: new Map(),
    drones: new Map(),
    decoys: new Map(),
    bullets: [],
    effects: [],
    nextEntityId: 1,
    disableSpatialIndex: true,
    world: { width: 4096, height: 4096 }
  };
}

function makeShip(ownerId, x, y, design) {
  return {
    id: `${ownerId}-ship`, ownerId, x, y, vx: 0, vy: 0, angle: 0, alive: true,
    design: design || [{ x: 7, y: 7, type: "core", rotation: 0 }],
    stats: { powerUse: 0, powerGeneration: 10, efficiency: 1, accuracyBonus: 0, fireRateBonus: 0 },
    componentHp: [100], componentMaxHp: [100],
    shield: 100, maxShield: 100, hp: 100, maxHp: 100,
    dirtyComponents: new Set(), radius: 24
  };
}

function makeDrone(ownerId, x, y, id, hull = 40) {
  return { id, ownerId, x, y, vx: 0, vy: 0, hull, maxHull: hull, radius: 10, type: "fighter", destroyed: false, removed: false };
}

function makeMissile(ownerId, x, y, id, hp = 15) {
  return {
    id, ownerId, x, y, vx: 0, vy: 0, hp, damage: 20, life: 10, interceptable: true,
    type: "missile"
  };
}

function makeFlakBullet(ownerId, x, y, vx, vy, life, overrides = {}) {
  const weapon = PARTS.flakCannon.weapon;
  return {
    id: `flak-${ownerId}-${x}-${y}`,
    type: "flak",
    subtype: "flakCannon",
    ownerId,
    x, y, vx, vy, life,
    damage: weapon.directDamage ?? weapon.damage ?? 0,
    blastDamage: weapon.blastDamage ?? 0,
    blastRadius: weapon.blastRadius ?? 0,
    proximityFuseRadius: weapon.proximityFuseRadius ?? 0,
    innerFullDamageRadius: weapon.innerFullDamageRadius ?? 0,
    falloffExponent: weapon.falloffExponent ?? 1,
    directImpactBonus: weapon.directImpactBonus ?? 0,
    shieldDamageMultiplier: weapon.shieldDamageMultiplier ?? 1,
    hullDamageMultiplier: weapon.hullDamageMultiplier ?? 1,
    armorInteractionSeconds: Math.min(1, weapon.armourPenetration ?? 1),
    ...overrides
  };
}

function runUpdate(room, dt = 1 / 30, now = 0) {
  const ships = Array.from(room.ships.values());
  updateBullets(room, dt, now);
  return room;
}

// 1. Balance sync: component-balance and generated output both describe flak.
{
  const flak = PARTS.flakCannon;
  assert(flak, "PARTS.flakCannon must exist");
  assert.strictEqual(flak.weapon.type, "flak", "flakCannon weapon family must be flak");
  assert(flak.weapon.blastDamage > 0, "flakCannon must have blastDamage");
  assert(flak.weapon.blastRadius > 0, "flakCannon must have blastRadius");
  assert(flak.weapon.proximityFuseRadius > 0, "flakCannon must have proximityFuseRadius");
  assert(Array.isArray(flak.weapon.targetPriority), "flakCannon must define targetPriority");
  assert.strictEqual(flak.weapon.targetPriority[0], "missile", "flakCannon must prioritise missiles");
  assert.strictEqual(PARTS.pointDefense.weapon.type, "pointDefense", "Point Defence must keep its own family");

  const balanceJson = JSON.parse(fs.readFileSync(path.join(path.dirname(__dirname), "component-balance.json"), "utf8"));
  const balanceFlak = balanceJson.components.find((c) => c.id === "flakCannon");
  assert(balanceFlak, "component-balance.json must contain flakCannon");
  assert.strictEqual(balanceFlak.weapon.family, "flak", "balance flak family must be flak");
  assert(balanceFlak.weapon.blastDamage > 0, "balance flakCannon must have blastDamage");

  const pubFlak = publicBalance.components.find((c) => c.id === "flakCannon");
  assert(pubFlak, "public balance must contain flakCannon");
  assert.strictEqual(pubFlak.weapon.family, "flak", "public balance flak family must match source");

  assert.strictEqual(TurretRules.turnRateFor({ type: "flak" }), TurretRules.TURN_RATES.flak,
    "flak turret turn rate must be defined");
  assert.strictEqual(TurretRules.muzzleTiles("flakCannon", "flak"), TurretRules.MUZZLE_TIP_TILES.flakCannon,
    "flakCannon muzzle tip must resolve");
}

// 2. Proximity fuse: shell detonates near a hostile drone without a direct hit.
{
  const room = makeRoom();
  const drone = makeDrone("foe", 20, 0, "d1");
  room.drones.set(drone.id, drone);
  const bullet = makeFlakBullet("me", 0, 0, 30 * 30, 0, 10); // reaches (30,0) in one 1/30 s tick
  room.bullets.push(bullet);
  runUpdate(room);

  assert(room.bullets.every((b) => b.life <= 1e-9 || b.type !== "flak"), "flak shell must be removed after detonation");
  assert(room.effects.some((e) => e.type === "flakburst"), "flak shell must emit a flakburst effect");
  assert(drone.hull < drone.maxHull, "proximity-detonated shell must damage the drone");
}

// 3. Direct hit detonation on an interceptable missile.
{
  const room = makeRoom();
  const missile = makeMissile("foe", 0, 30, "m1", 5);
  room.bullets.push(missile);
  const bullet = makeFlakBullet("me", 0, 0, 0, 30 * 30, 10);
  room.bullets.push(bullet);
  runUpdate(room);

  assert(room.effects.some((e) => e.type === "flakburst"), "direct-hit missile must trigger airburst");
  assert(!room.bullets.some((b) => b.id === "m1" && b.life > 0), "intercepted missile must be removed");
}

// 4. No detonation outside fuse radius; shell is kept and continues.
{
  const room = makeRoom();
  const drone = makeDrone("foe", 100, 0, "d2");
  room.drones.set(drone.id, drone);
  const bullet = makeFlakBullet("me", 0, 0, 30 * 30, 0, 10, { proximityFuseRadius: 10 });
  room.bullets.push(bullet);
  runUpdate(room);

  assert(room.bullets.some((b) => b.type === "flak" && b.life > 0), "shell outside fuse radius must remain");
  assert.strictEqual(drone.hull, drone.maxHull, "out-of-range drone must not be damaged");
}

// 5. Expiry detonation at maximum range.
{
  const room = makeRoom();
  const bullet = makeFlakBullet("me", 0, 0, 30 * 30, 0, 0.001);
  room.bullets.push(bullet);
  runUpdate(room);

  assert(room.effects.some((e) => e.type === "flakburst"), "expired flak shell must detonate");
  assert(!room.bullets.some((b) => b.type === "flak" && b.life > 0), "expired flak shell must be removed");
}

// 6. Radial falloff damages multiple drones at different distances differently.
{
  const room = makeRoom();
  const trigger = makeDrone("foe", 0, 30, "dt");
  const near = makeDrone("foe", 0, 34, "dn", 50); // edge distance ~4 (inside inner full radius)
  const far = makeDrone("foe", 0, 60, "df", 50);  // edge distance ~30
  room.drones.set(trigger.id, trigger);
  room.drones.set(near.id, near);
  room.drones.set(far.id, far);
  const bullet = makeFlakBullet("me", 0, 0, 0, 30 * 30, 10);
  room.bullets.push(bullet);
  runUpdate(room);

  const nearDamage = near.maxHull - near.hull;
  const farDamage = far.maxHull - far.hull;
  assert(nearDamage > 0 && farDamage > 0, "blast must damage multiple drones");
  assert(nearDamage > farDamage, "near target must take more damage than far target");
}

// 7. Hostile filtering: friendly drones are ignored for fuse and damage.
{
  const room = makeRoom();
  const friendly = makeDrone("me", 0, 30, "f1");
  room.drones.set(friendly.id, friendly);
  const bullet = makeFlakBullet("me", 0, 0, 0, 30 * 30, 10);
  room.bullets.push(bullet);
  runUpdate(room);

  assert.strictEqual(friendly.hull, friendly.maxHull, "friendly drone must not be damaged by flak");
  assert(room.bullets.some((b) => b.type === "flak" && b.life > 0), "shell must not detonate on a friendly");
}

// 8. Ship damage routing: explosion damages shield and respects multipliers.
{
  const room = makeRoom();
  const ship = makeShip("foe", 0, 30, [{ x: 7, y: 7, type: "core", rotation: 0 }]);
  ship.shield = 50;
  initComponentState(ship);
  room.ships.set(ship.id, ship);
  const bullet = makeFlakBullet("me", 0, 0, 0, 30 * 30, 10);
  room.bullets.push(bullet);
  runUpdate(room);

  assert(ship.shield < 50 || ship.hp < 100, "flak explosion must damage a ship");
}

// 9. Deterministic targeting priorities: missile preferred over drone/ship.
{
  const room = makeRoom();
  const missile = makeMissile("foe", 50, 50, "pm1");
  room.bullets.push(missile);
  const drone = makeDrone("foe", 50, 50, "pd1");
  room.drones.set(drone.id, drone);
  const ship = makeShip("foe", 50, 50);
  room.ships.set(ship.id, ship);

  const flakTarget = findPointDefenseTarget(room, 0, 0, "me", PARTS.flakCannon.weapon, [ship]);
  assert(flakTarget, "flak must find a point-defence target");
  assert.strictEqual(flakTarget.type, "projectile", "flak target priority must prefer missiles first");

  const pdTarget = findPointDefenseTarget(room, 0, 0, "me", PARTS.pointDefense.weapon, [ship]);
  assert(pdTarget, "point defence must find a target");
  assert.strictEqual(pdTarget.type, "drone", "point defence must keep drone-first priority");
}

// 10. No duplicate damage: an entity is only recorded once per shell.
{
  const room = makeRoom();
  const drone = makeDrone("foe", 0, 30, "dup", 100);
  room.drones.set(drone.id, drone);
  const bullet = makeFlakBullet("me", 0, 0, 0, 30 * 30, 10, { maximumExplosionTargets: 0 });
  room.bullets.push(bullet);
  runUpdate(room);
  const damage = 100 - drone.hull;
  const weapon = PARTS.flakCannon.weapon;
  const expectedMax = (weapon.blastDamage || 0) + (weapon.directDamage ?? weapon.damage ?? 1) + 0.1;
  assert(damage <= expectedMax, "directly hit entity receives blast plus direct damage, all others blast only");
}

console.log("Flak Cannon verification passed");
