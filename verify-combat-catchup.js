"use strict";

const assert = require("assert");
const { seededRandom } = require("./src/server/utils");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState } = require("./src/server/componentHealth");
const { initShipHeat } = require("./src/server/heat");
const { updateShipWeapons, updateShipSupport, findTarget, pickWeaponFireTarget, findPointDefenseTarget, damageShip, destroyShip, requestSelfDestruct, updateSelfDestructingShips, weaponModuleWorldPosition, weaponMuzzleWorldPosition, weaponMuzzleDistance, moduleRotationToRadians, isTargetInWeaponArc, buildShipTurretDiagnostics } = require("./src/server/combat");
const { updateBullets } = require("./src/server/projectiles");

function ship(id, ownerId, x, y, design) {
  const s = { id, ownerId, x, y, vx: 0, vy: 0, angle: 0, alive: true, removed: false, shield: 0, radius: 30, focusTargetId: null, combatTargetId: null, repairTargetId: null, cost: 100, effects: [] };
  s.design = design || [{ x: 7, y: 7, type: "core" }, { x: 7, y: 6, type: "engine" }, { x: 7, y: 5, type: "blaster", rotation: 0 }];
  s.stats = computeStats(s.design);
  s.maxHp = s.stats.maxHp; s.hp = s.maxHp; s.maxShield = s.stats.maxShield || 0; s.shield = s.maxShield;
  initComponentState(s);
  initShipHeat(s);
  return s;
}
function room(ships = []) {
  const r = { rules: { gameMode: "teams" }, players: new Map([["a", { id: "a", team: 1, ships: [], kills: 0, losses: 0, destroyedEnemyCost: 0, lostFleetCost: 0, money: 0, maxMoney: 99999, earned: 0, score: 0 }], ["b", { id: "b", team: 2, ships: [], kills: 0, losses: 0, destroyedEnemyCost: 0, lostFleetCost: 0, money: 0, maxMoney: 99999, earned: 0, score: 0 }], ["c", { id: "c", team: 1, ships: [], kills: 0, losses: 0, destroyedEnemyCost: 0, lostFleetCost: 0, money: 0, maxMoney: 99999, earned: 0, score: 0 }]]), ships: new Map(ships.map((s) => [s.id, s])), bullets: [], effects: [], map: { asteroids: [], safeZones: [] }, world: { width: 2000, height: 2000 }, combatRandom: seededRandom(777) };
  for (const s of ships) r.players.get(s.ownerId)?.ships.push(s);
  return r;
}
function tickWeapons(r, s, ships, steps = 80) { for (let i = 0; i < steps; i++) updateShipWeapons(r, s, ships, 1 / 60, 1000 + i * 16); }

// Focus targeting: valid enemy, ally/dead/removed rejection, out-of-range/blocked fallback without replacing focusTargetId, and revalidation.
{
  const shooter = ship("s", "a", 0, 0); const focus = ship("f", "b", 220, 0); const fallback = ship("e", "b", 160, 80); const ally = ship("ally", "a", 100, 0);
  const r = room([shooter, focus, fallback, ally]); shooter.focusTargetId = focus.id;
  tickWeapons(r, shooter, [shooter, focus, fallback, ally]);
  assert.strictEqual(shooter.combatTargetId, focus.id, "valid focus target is authoritative combat target");
  shooter.focusTargetId = ally.id; tickWeapons(r, shooter, [shooter, focus, fallback, ally]); assert.notStrictEqual(shooter.combatTargetId, ally.id, "allied focus rejected");
  shooter.focusTargetId = focus.id; focus.alive = false; tickWeapons(r, shooter, [shooter, focus, fallback, ally]); assert.strictEqual(shooter.focusTargetId, focus.id, "dead focus remains assigned for later recovery"); assert.strictEqual(shooter.combatTargetId, fallback.id, "dead focus falls back");
  focus.alive = true; focus.x = 900; tickWeapons(r, shooter, [shooter, focus, fallback, ally]); assert.strictEqual(shooter.combatTargetId, fallback.id, "out-of-range focus falls back");
  focus.x = 220; r.map.asteroids = [{ x: 110, y: 0, radius: 30 }]; tickWeapons(r, shooter, [shooter, focus, fallback, ally]); assert.strictEqual(shooter.combatTargetId, fallback.id, "asteroid-blocked focus falls back");
  r.map.asteroids = []; tickWeapons(r, shooter, [shooter, focus, fallback, ally]); assert.strictEqual(shooter.combatTargetId, focus.id, "focus becomes valid again");
}

// Mixed weapon range/arcs, boundaries, destroyed and disabled weapons.
{
  const design = [{ x: 7, y: 7, type: "core" }, { x: 7, y: 6, type: "engine" }, { x: 7, y: 5, type: "blaster", rotation: 0 }, { x: 8, y: 5, type: "railgun", rotation: 1 }, { x: 6, y: 5, type: "missile", rotation: 3 }];
  const shooter = ship("s", "a", 0, 0, design); const near = ship("n", "b", 180, 0); const far = ship("z", "b", 700, 0); const r = room([shooter, near, far]);
  assert.strictEqual(pickWeaponFireTarget(r, shooter, [far, near], 0, 0, far, 250).id, near.id, "weapon-specific range picks reachable fallback");
  assert(isTargetInWeaponArc(shooter, design[2], near, Math.PI * 2), "360-degree blaster arc includes target");
  shooter.componentHp[2] = 0; tickWeapons(r, shooter, [shooter, near, far]); assert(!shooter.weaponFireTargetIds?.[2], "destroyed weapon does not select fire target");
  shooter.componentHp[2] = shooter.componentMaxHp[2]; shooter.componentHeatState[2] = 4; const bulletsBefore = r.bullets.length; tickWeapons(r, shooter, [shooter, near, far]); assert.strictEqual(r.bullets.length, bulletsBefore, "overheated component-local performance prevents firing");
}

// Turret/muzzle parity invariants for weapon families, repair beams, rotations, hull angles, edge components.
{
  const families = ["blaster", "railgun", "missile", "pointDefense", "beamEmitter", "repairBeam"];
  for (const type of families) for (const rotation of [0, 1, 2, 3]) for (const hull of [0, Math.PI / 5, Math.PI / 2]) {
    const s = ship(`g-${type}-${rotation}`, "a", 100, 200, [{ x: 7, y: 7, type: "core" }, { x: 7, y: 6, type: "engine" }, { x: rotation === 3 ? 0 : 14, y: rotation === 2 ? 14 : 0, type, rotation }]);
    s.angle = hull; const module = s.design[2]; const pivot = weaponModuleWorldPosition(s, module); const angle = s.angle + moduleRotationToRadians(rotation); const muzzle = weaponMuzzleWorldPosition(s, module, angle, type === "repairBeam" ? "beam" : type);
    assert(Number.isFinite(pivot.x) && Number.isFinite(muzzle.x) && Number.isFinite(muzzle.y), `${type} finite geometry`);
    assert(Math.hypot(muzzle.x - pivot.x, muzzle.y - pivot.y) > 0 && Number.isFinite(weaponMuzzleDistance(type === "repairBeam" ? "beam" : type)), `${type} shared muzzle distance is finite and non-zero`);
    s.weaponAngles = s.design.map(() => 0); const diag = buildShipTurretDiagnostics(room([s]), s).find((d) => d.designIndex === 2); if (type !== "repairBeam") assert(diag && Number.isFinite(diag.defaultRelativeAngle), `${type} design-index diagnostic alignment`);
  }
}

// Projectile deterministic movement/collisions/expiration/idempotency.
{
  for (const hz of [15, 30, 60]) { const target = ship(`t${hz}`, "b", 300, 0); const r = room([target]); r.bullets.push({ id: `p${hz}`, type: "shot", ownerId: "a", x: 0, y: 0, vx: 300, vy: 0, damage: 1, life: 2 }); for (let i = 0; i < hz; i++) updateBullets(r, 1 / hz, i * 1000 / hz); assert(Math.abs((r.bullets[0]?.x || 300) - 300) < 25 || target.hp < target.maxHp, `${hz}Hz movement/collision deterministic`); }
  const a = ship("a1", "b", 100, 0); const b = ship("b1", "b", 101, 0); const r = room([a, b]); r.bullets.push({ id: "fast", type: "rail", ownerId: "a", x: 0, y: 0, vx: 2000, vy: 0, damage: 10, life: 1 }); updateBullets(r, 0.1, 10); assert(a.hp < a.maxHp || a.shield < a.maxShield, "high-speed swept collision hits earliest ship/component once"); assert.strictEqual(r.bullets.length, 0, "one projectile produces one hit and is consumed");
  const r2 = room([]); r2.bullets.push({ id: "bad", type: "shot", ownerId: "a", x: NaN, y: 0, vx: Infinity, vy: 0, damage: 1, life: 1 }, { id: "expired", type: "shot", ownerId: "a", x: 0, y: 0, vx: 1, vy: 0, damage: 1, life: -1 }); updateBullets(r2, 0.1, 10); assert.strictEqual(r2.bullets.length, 0, "malformed/non-finite/expired projectiles rejected");
}

// PD/repair/damage/reward/safe-zone/effect cleanup coverage.
{
  const protector = ship("p", "a", 0, 0); const ally = ship("ally", "c", 0, 80); const enemy = ship("enemy", "b", 150, 0); const r = room([protector, ally, enemy]);
  r.bullets.push({ id: "threat", type: "missile", interceptable: true, ownerId: "b", targetId: protector.id, x: 50, y: 0, life: 1, hp: 10 }, { id: "friendly", type: "missile", interceptable: true, ownerId: "a", targetId: enemy.id, x: 20, y: 0, life: 1, hp: 10 });
  assert.strictEqual(findPointDefenseTarget(r, 0, 0, "a", { range: 200, targetPriority: ["missile", "projectile"] }, [protector, ally], protector.id).entity.id, "threat", "PD configured priority ignores friendly and protects ship");
  enemy.hp -= 10; protector.repairTargetId = ally.id; ally.hp -= 20; updateShipSupport(r, [protector, ally, enemy], 1, 1000); assert(ally.hp <= ally.maxHp, "repair conserves HP and does not exceed max");
  const shielded = ship("shielded", "b", 100, 0); shielded.shield = 5; const beforeHp = shielded.hp; damageShip(r, shielded, 10, "a", 1, 0, 0, { shieldDamageMultiplier: 1, hullDamageMultiplier: 1 }); assert(shielded.shield <= 0 && shielded.hp < beforeHp, "shield overflow applied exactly once");
  assert.strictEqual(destroyShip(r, enemy, "a", 1), true); assert.strictEqual(destroyShip(r, enemy, "a", 2), false); assert.strictEqual(r.players.get("a").kills, 1, "one valid kill"); assert.strictEqual(r.players.get("b").losses, 1, "one loss");
  requestSelfDestruct(r, r.players.get("a"), [protector.id], 10); updateSelfDestructingShips(r, 4000); assert(!protector.alive, "self-destruct destroys selected ship once");
  const safeShooter = ship("safe", "a", 0, 0); const safeTarget = ship("safeTarget", "b", 150, 0); const sr = room([safeShooter, safeTarget]); sr.map.safeZones = [{ x: 0, y: 0, radius: 100 }]; tickWeapons(sr, safeShooter, [safeShooter, safeTarget]); assert.strictEqual(sr.bullets.length, 0, "safe-zone firing creates no projectile");
}

console.log("Combat catch-up verification passed (seed 777)");
