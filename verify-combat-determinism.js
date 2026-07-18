"use strict";
const assert = require("assert");
const { seededRandom } = require("./src/server/utils");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState } = require("./src/server/componentHealth");
const { areAllies, areEnemies, findTarget, pickWeaponFireTarget, findPointDefenseTarget, damageShip, destroyShip } = require("./src/server/combat");
const { updateBullets } = require("./src/server/projectiles");

function makeShip(id, ownerId, x, y, design = [{ x: 7, y: 7, type: "core" }, { x: 7, y: 6, type: "frame" }]) {
  const ship = { id, ownerId, design, x, y, vx: 0, vy: 0, angle: 0, alive: true, shield: 0, radius: 28 };
  ship.stats = computeStats(design);
  initComponentState(ship);
  ship.maxShield = ship.stats.maxShield || 0;
  return ship;
}

{
  const teams = { rules: { gameMode: "teams" }, players: new Map([["a", { id: "a", team: "blue" }], ["b", { id: "b", team: "blue" }], ["c", { id: "c", team: "red" }]]) };
  assert(areAllies(teams, "a", "b"));
  assert(!areEnemies(teams, "a", "b"));
  assert(areEnemies(teams, "a", "c"));
  const solo = { rules: { gameMode: "solo" }, players: teams.players };
  assert(!areAllies(solo, "a", "b"));
  assert(areEnemies(solo, "a", "b"));
  assert(!areEnemies(solo, "a", "missing"));
}

{
  const room = { rules: { gameMode: "teams" }, players: new Map([["p1", { id: "p1", team: 1 }], ["p2", { id: "p2", team: 2 }]]), map: { asteroids: [] } };
  const shooter = makeShip("s", "p1", 0, 0);
  shooter.stats.blasterRange = 500; shooter.stats.missileRange = 0; shooter.stats.railgunRange = 0; shooter.stats.beamRange = 0;
  const b = makeShip("b", "p2", 200, 0);
  const a = makeShip("a", "p2", 200, 0);
  assert.strictEqual(findTarget(room, shooter, [shooter, b, a]).id, "a", "equal-distance ship target ties by stable ship id");
  assert.strictEqual(pickWeaponFireTarget(room, shooter, [b, a], 0, 0, null, 500).id, "a", "equal-distance weapon fallback ties by stable ship id");
}

{
  const room = { rules: { gameMode: "teams" }, players: new Map([["p1", { id: "p1", team: 1 }], ["p2", { id: "p2", team: 2 }]]), map: { asteroids: [] }, bullets: [], combatRandom: seededRandom(1234) };
  const ally = makeShip("ally", "p1", 0, 0);
  const enemyMissileA = { id: "m-a", type: "missile", interceptable: true, ownerId: "p2", targetId: "ally", x: 100, y: 0, life: 1 };
  const enemyMissileB = { id: "m-b", type: "missile", interceptable: true, ownerId: "p2", targetId: "other", x: 100, y: 0, life: 1 };
  const friendlyMissile = { id: "m-friendly", type: "missile", interceptable: true, ownerId: "p1", targetId: "enemy", x: 10, y: 0, life: 1 };
  room.bullets.push(enemyMissileB, friendlyMissile, enemyMissileA);
  const target = findPointDefenseTarget(room, 0, 0, "p1", { range: 200, targetPriority: ["missile", "projectile"] }, [ally], "ally");
  assert.strictEqual(target.entity.id, "m-a", "PD prioritizes enemy projectile threatening the protected ship, not friendly projectiles");
}

{
  const victim = makeShip("v", "p2", 0, 0);
  const room = { players: new Map([["p1", { id: "p1", team: 1, kills: 0, destroyedEnemyCost: 0, money: 0, maxMoney: 9999, earned: 0, score: 0 }], ["p2", { id: "p2", team: 2, losses: 0, lostFleetCost: 0 }]]), effects: [] };
  assert.strictEqual(destroyShip(room, victim, "p1", 1), true);
  assert.strictEqual(destroyShip(room, victim, "p1", 2), false);
  assert.strictEqual(room.players.get("p2").losses, 1, "destruction is idempotent for losses");
  assert.strictEqual(room.players.get("p1").kills, 1, "destruction is idempotent for kills");
}

{
  const room = { rules: { gameMode: "teams" }, players: new Map([["p1", { id: "p1", team: 1 }], ["p2", { id: "p2", team: 2 }]]), map: { asteroids: [{ x: 50, y: 0, radius: 10 }] }, world: { width: 1000, height: 1000 }, effects: [], bullets: [], ships: new Map() };
  const target = makeShip("target", "p2", 100, 0);
  target.shield = 0;
  room.ships.set(target.id, target);
  room.bullets.push({ id: "shot", type: "rail", ownerId: "p1", x: 0, y: 0, vx: 1000, vy: 0, damage: 100, life: 1 });
  const hpBefore = target.hp;
  updateBullets(room, 0.1, 100);
  assert.strictEqual(room.bullets.length, 0, "projectile consumed by earliest asteroid impact");
  assert.strictEqual(target.hp, hpBefore, "asteroid-first collision prevents later ship hit on same segment");
}

console.log("Combat determinism verification passed (seed 1234)");
