"use strict";

const assert = require("assert");
const fs = require("fs");
const { PARTS } = require("./src/server/components");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState } = require("./src/server/componentHealth");
const { initShipHeat, STATE } = require("./src/server/heat");
const { updateShipSupport, updateShipWeapons, findPointDefenseTarget, PRIORITY_COMPONENT_TYPES } = require("./src/server/combat");
const { tickRoom } = require("./src/server/simulation");

function makeShip(id, ownerId, x, y, design) {
  const ship = { id, ownerId, x, y, vx: 0, vy: 0, angle: 0, alive: true, removed: false, shield: 0, radius: 35, focusTargetId: null, combatTargetId: null, repairTargetId: null, effects: [], cost: 100, design };
  ship.stats = computeStats(design);
  ship.maxHp = ship.stats.maxHp; ship.hp = ship.maxHp; ship.maxShield = ship.stats.maxShield || 0;
  initComponentState(ship); initShipHeat(ship);
  ship.componentPower = { byComponentIndex: design.map(() => ({ operationalMultiplier: 1, state: "powered" })) };
  return ship;
}
function damageHull(ship, amount) {
  const index = ship.design.findIndex((module) => module.type !== "core");
  ship.componentHp[index] = Math.max(0, ship.componentHp[index] - amount);
  ship.hp = ship.componentHp.reduce((sum, hp, i) => ship.design[i].type === "core" ? sum : sum + hp, 0);
}
function room(ships) {
  const players = new Map([["a", { id: "a", team: 1, ships: [], money: 0, maxMoney: 9999, earned: 0, score: 0 }], ["b", { id: "b", team: 2, ships: [], money: 0, maxMoney: 9999, earned: 0, score: 0 }], ["c", { id: "c", team: 1, ships: [], money: 0, maxMoney: 9999, earned: 0, score: 0 }]]);
  const r = { phase: "active", rules: { gameMode: "teams" }, players, ships: new Map(ships.map(s => [s.id, s])), bullets: [], effects: [], map: { asteroids: [], safeZones: [], relays: [] }, points: [], world: { width: 2000, height: 2000 }, combatRandom: () => 0 };
  for (const s of ships) players.get(s.ownerId)?.ships.push(s);
  return r;
}
const beamDesign = [{ x: 7, y: 7, type: "core" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 5, type: "repairBeam", rotation: 0 }];
const localDesign = [{ x: 7, y: 7, type: "core" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 5, type: "repair" }];

{
  const s = makeShip("s", "a", 0, 0, beamDesign); damageHull(s, 40);
  const r = room([s]); updateShipSupport(r, [s], 1, 1000);
  assert.strictEqual(s.hp, s.maxHp - 40, "repair-beam-only ship does not self heal");
  assert(!r.effects.some(e => e.type === "repairbeam"), "self repair beam effect is not emitted");
  s.repairTargetId = s.id; updateShipSupport(r, [s], 1, 1100);
  assert.strictEqual(s.repairTargetId, null, "self-assigned repair target is cleared");
}
{
  const s = makeShip("s", "a", 0, 0, beamDesign); const ally = makeShip("ally", "a", 90, 0, localDesign); damageHull(ally, 50); s.repairTargetId = s.id;
  const r = room([s, ally]); updateShipSupport(r, [s, ally], 1, 1000);
  assert.strictEqual(s.repairTargetId, null); assert(ally.hp > ally.maxHp - 50, "self assignment falls through to same-owner ally");
}
{
  const s = makeShip("s", "a", 0, 0, beamDesign); const mate = makeShip("mate", "c", 90, 0, localDesign); damageHull(mate, 50);
  const r = room([s, mate]); updateShipSupport(r, [s, mate], 1, 1000); assert(mate.hp > mate.maxHp - 50, "teammate ally receives repair beam");
}
{
  const s = makeShip("s", "a", 0, 0, localDesign); damageHull(s, 30); const r = room([s]); updateShipSupport(r, [s], 1, 1000); assert(s.hp > s.maxHp - 30, "local repair still self-repairs");
  const mixed = makeShip("mixed", "a", 0, 0, [...localDesign, { x: 8, y: 5, type: "repairBeam", rotation: 0 }]); const ally = makeShip("ally", "a", 90, 0, localDesign); damageHull(mixed, 30); damageHull(ally, 30); const rr = room([mixed, ally]); updateShipSupport(rr, [mixed, ally], 1, 1000); assert(mixed.hp > mixed.maxHp - 30 && ally.hp > ally.maxHp - 30, "mixed local/beam repair heals self and ally");
}

function weaponShip() { return makeShip("gun", "a", 0, 0, [{ x: 7, y: 7, type: "core" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 5, type: "blaster", rotation: 0 }]); }
{
  const s = weaponShip(); const e = makeShip("enemy", "b", 180, 0, localDesign); const r = room([s, e]); s.componentPower.byComponentIndex[2].operationalMultiplier = 0; const before = s.weaponAngles?.[2]; updateShipWeapons(r, s, [s, e], 1 / 10, 1000); assert.strictEqual(s.weaponAimTargetIds[2], null); assert.strictEqual(s.weaponFireTargetIds[2], null); assert.strictEqual(r.bullets.length, 0); assert.strictEqual(s.weaponCooldowns[2], 0); assert.strictEqual(s.weaponAngles[2], before ?? 0, "unpowered weapon does not newly traverse"); s.componentPower.byComponentIndex[2].operationalMultiplier = 1; updateShipWeapons(r, s, [s, e], 1 / 10, 1100); assert.strictEqual(s.weaponAimTargetIds[2], e.id, "restored Power reacquires");
}
{
  const s = weaponShip(); const e = makeShip("enemy", "b", 180, 90, localDesign); const r = room([s, e]); s.componentHeatState[2] = STATE.OVERHEATED; s.weaponCooldowns = [0,0,0]; updateShipWeapons(r, s, [s, e], 0.25, 1000); assert.strictEqual(s.weaponAimTargetIds[2], e.id); assert.notStrictEqual(s.weaponAngles[2], 0, "overheated powered weapon tracks"); assert.strictEqual(r.bullets.length, 0); assert.strictEqual(s.weaponCooldowns[2], 0); s.componentHeatState[2] = STATE.NORMAL; for (let i=0;i<20 && r.bullets.length===0;i++) updateShipWeapons(r, s, [s,e], 0.1, 1100+i); assert(r.bullets.length > 0, "restored thermal activity permits firing"); s.componentHp[2] = 0; updateShipWeapons(r, s, [s,e], 0.1, 2000); assert.strictEqual(s.weaponAimTargetIds[2], null, "destroyed weapon cannot aim");
}
{
  assert.strictEqual(require("./src/server/combat").updateDecoys, undefined, "updateDecoys is not exported");
  assert(!fs.readFileSync("src/server/componentHealth.js", "utf8").includes("decoyRange"), "effective stat keys have no decoy fields");
  assert(!Object.values(PARTS).some(p => p.decoyRange || p.decoyCooldown || p.decoyConfuseDuration || p.decoyChance), "no live balance component exposes decoy stats");
  assert(fs.readFileSync("src/server/projectiles.js", "utf8").includes("trackingDisabledFor")); assert(fs.readFileSync("src/server/projectiles.js", "utf8").includes("ecmStrength"));
}
{
  for (const type of PRIORITY_COMPONENT_TYPES) { assert.ok(PARTS[type], `priority component type exists: ${type}`); assert.ok(!PARTS[type].weapon, `weapon priority is derived from PARTS[type].weapon: ${type}`); }
  assert(PRIORITY_COMPONENT_TYPES.has("maneuverThruster")); for (const stale of ["missileLauncher","torpedoLauncher","thruster","beam","ecm","decoy"]) assert(!PRIORITY_COMPONENT_TYPES.has(stale));
}
{
  const pd = makeShip("pd", "a", 0, 0, [{ x:7,y:7,type:"core" }, { x:7,y:6,type:"reactor" }, { x:7,y:5,type:"pointDefense", rotation:0 }]); const enemy = makeShip("enemy", "b", 120, 0, localDesign); const r = room([pd, enemy]); r.bullets.push({ id:"missile-1", type:"missile", interceptable:true, ownerId:"b", targetId:pd.id, x:60, y:0, life:5, hp:10 }); updateShipWeapons(r, pd, [pd,enemy], 0.1, 1000); assert.strictEqual(r.bullets.at(-1).targetId, "missile-1", "projectile PD shot targets projectile id"); r.bullets = []; pd.weaponCooldowns[2] = 0; updateShipWeapons(r, pd, [pd,enemy], 0.1, 1100); assert.strictEqual(r.bullets.at(-1).targetId, enemy.id, "ship fallback PD shot targets ship id"); assert.strictEqual(findPointDefenseTarget(r, 0, 0, "a", PARTS.pointDefense.weapon, [pd, enemy], pd.id).entity.id, enemy.id);
}
{
  const oldEnv = process.env.NODE_ENV; const oldWarn = console.warn; const warnings = []; console.warn = (m) => warnings.push(String(m));
  try { const s = makeShip("hp", "a", 0, 0, localDesign); const r = room([s]); const nonCore = s.componentHp.reduce((sum,h,i)=>s.design[i].type === "core" ? sum : sum + h, 0); s.hp = nonCore - 25; process.env.NODE_ENV = "development"; tickRoom(r, 0.001, 1000); assert(warnings.some(w => w.includes("hp drift"))); assert.strictEqual(s.hp, nonCore); assert.strictEqual(s.componentHp[0], s.componentMaxHp[0], "core HP remains excluded"); warnings.length = 0; s.hp = nonCore - 25; process.env.NODE_ENV = "production"; tickRoom(r, 0.001, 1010); assert.strictEqual(s.hp, nonCore - 25); assert.strictEqual(warnings.length, 0); } finally { process.env.NODE_ENV = oldEnv; console.warn = oldWarn; }
}
console.log("Support and weapon semantics verification passed");
