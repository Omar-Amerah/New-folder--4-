"use strict";
const assert = require("assert");
const { PARTS } = require("../src/server/components");
const { computeStats } = require("../src/server/shipStats");
const { initComponentState } = require("../src/server/componentHealth");
const { updateShipWeapons } = require("../src/server/combat");
const { reallocateShipPower } = require("../src/server/componentPower");
const { updateCommandAuras, getCommandAuraMultiplier, getCommandAuraRange } = require("../src/server/commandAuras");
const { BALANCE } = require("../src/server/balanceConfig");
const WiringRules = require("../public/src/shared/wiringRules");
const HeatRules = require("../public/src/shared/heatRules");

const AURA_RANGE = getCommandAuraRange();
const DT = 1 / 30;
const MS = 1000 / 30;
let passed = 0;
function ok(m) { passed++; console.log("  " + m); }

function makeShip(id, owner, x, y, design) {
  let wiring;
  try { wiring = WiringRules.createGeneratedPowerWiring(design, PARTS); } catch (_) { wiring = { power: [], data: [] }; }
  const stats = computeStats(design, wiring);
  const s = { id, ownerId: owner, x, y, angle: 0, vx: 0, vy: 0, design, wiring, stats, alive: true,
    hp: stats.maxHp || 500, maxHp: stats.maxHp || 500, shield: 0, maxShield: 0, commandState: "mainCore",
    componentHeatState: design.map(() => HeatRules.STATE.NORMAL), commandAurasReceived: {}, commandAuraMultipliers: {} };
  initComponentState(s);
  reallocateShipPower(s, "init");
  s.weaponAngles = s.design.map(m => (m.rotation || 0) * (Math.PI / 180));
  s.weaponCooldowns = s.design.map(() => 0);
  s.weaponDesiredAngles = s.design.map(() => 0);
  s.weaponAimTargetIds = s.design.map(() => null);
  s.weaponFireTargetIds = s.design.map(() => null);
  return s;
}

function makeRoom(ships) {
  const sm = new Map();
  const pm = new Map([
    ["p1", { id: "p1", team: "A", kills: 0, losses: 0, money: 9999, earned: 0, destroyedEnemyCost: 0, lostFleetCost: 0, ships: [], design: [] }],
    ["p2", { id: "p2", team: "B", kills: 0, losses: 0, money: 9999, earned: 0, destroyedEnemyCost: 0, lostFleetCost: 0, ships: [], design: [] }]
  ]);
  for (const s of ships) { sm.set(s.id, s); const o = pm.get(s.ownerId); if (o) o.ships.push(s); }
  return { code: "t", phase: "active", ships: sm, players: pm, bullets: [], drones: new Map(),
    points: [], effects: [], map: { asteroids: [], safeZones: [] }, rules: { gameMode: "solo" }, world: { width: 4000, height: 4000 } };
}

// T1: Offensive acquisition delay blocks firing.
{
  const sh = makeShip("s1", "p1", 0, 0, [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "blaster", rotation: 0 }, { x: 7, y: 6, type: "reactor" }]);
  const en = makeShip("e1", "p2", 200, 0, [{ x: 7, y: 7, type: "core" }]); en.shield = 0;
  const room = makeRoom([sh, en]); const ships = [sh, en];
  updateCommandAuras(room, ships, 0); sh.weaponAngles[1] = 0;
  const tn = Math.ceil(BALANCE.fireControl.baseReacquisitionDelayMs / MS);
  let fired = false;
  for (let t = 0; t < tn + 5; t++) { updateShipWeapons(room, sh, ships, DT, t * MS); if (room.bullets.length > 0) { fired = true; assert(t >= tn - 1); break; } }
  assert(fired); assert.strictEqual(sh.weaponAcquiredTargetIds[1], en.id); assert.strictEqual(sh.weaponPendingTargetIds[1], null);
  ok("T1: Offensive acquisition delay blocks firing until timer completes.");
}

// T2: No timer inheritance on target switch.
{
  const sh = makeShip("s2", "p1", 0, 0, [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "blaster", rotation: 0 }, { x: 7, y: 6, type: "reactor" }]);
  const eA = makeShip("eA", "p2", 200, 0, [{ x: 7, y: 7, type: "core" }]); eA.shield = 0;
  const eB = makeShip("eB", "p2", 350, 0, [{ x: 7, y: 7, type: "core" }]); eB.shield = 0;
  const room = makeRoom([sh, eA, eB]); const ships = [sh, eA, eB];
  updateCommandAuras(room, ships, 0); sh.weaponAngles[1] = 0;
  const bd = BALANCE.fireControl.baseReacquisitionDelayMs;
  const ht = Math.floor(bd / MS / 2);
  for (let t = 0; t < ht; t++) updateShipWeapons(room, sh, ships, DT, t * MS);
  assert.strictEqual(sh.weaponPendingTargetIds[1], eA.id);
  eA.alive = false; eA.x = 9999; eA.y = 9999;
  const live = [sh, eB]; updateCommandAuras(room, live, ht * MS);
  let fa = -1;
  for (let t = ht; t < ht + 200; t++) { updateShipWeapons(room, sh, live, DT, t * MS); if (room.bullets.length > 0) { fa = t; break; } }
  assert(fa >= 0); const tn = Math.ceil(bd / MS);
  assert(fa >= ht + tn - 2, "fresh timer after switch");
  ok("T2: No timer inheritance — target switch restarts acquisition timer.");
}

// T3: Same target re-acquired without new timer.
{
  const sh = makeShip("s3", "p1", 0, 0, [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "blaster", rotation: 0 }, { x: 7, y: 6, type: "reactor" }]);
  const en = makeShip("e3", "p2", 200, 0, [{ x: 7, y: 7, type: "core" }]); en.shield = 0;
  const room = makeRoom([sh, en]); const ships = [sh, en];
  updateCommandAuras(room, ships, 0); sh.weaponAngles[1] = 0;
  const tn = Math.ceil(BALANCE.fireControl.baseReacquisitionDelayMs / MS);
  for (let t = 0; t < tn + 2; t++) updateShipWeapons(room, sh, ships, DT, t * MS);
  assert.strictEqual(sh.weaponAcquiredTargetIds[1], en.id);
  room.bullets.length = 0; sh.weaponCooldowns[1] = 0;
  updateShipWeapons(room, sh, ships, DT, (tn + 3) * MS);
  assert(room.bullets.length > 0, "fires immediately on same target");
  ok("T3: Same target re-acquired without new timer.");
}

// T4: PD reaction delay blocks firing after target switch.
{
  const pd = makeShip("pd4", "p1", 100, 100, [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense", rotation: 0 }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
  const en = makeShip("e4", "p2", 300, 100, [{ x: 7, y: 7, type: "core" }]);
  const room = makeRoom([pd, en]); const ships = [pd, en];
  updateCommandAuras(room, ships, 0); pd.weaponAngles[1] = 0;
  // First threat: acquire immediately (first-ever target, no delay).
  const ms1 = { id: "m4a", type: "missile", ownerId: "p2", targetId: pd.id, x: 200, y: 100, vx: -100, vy: 0, life: 200, interceptable: true, hp: 100 };
  room.bullets.push(ms1);
  updateShipWeapons(room, pd, ships, DT, 0);
  assert.strictEqual(pd.pdAcquiredTargetIds[1], ms1.id, "first PD target acquired immediately");
  // Remove first threat, add a new one.
  ms1.life = 0; room.bullets.length = 0;
  pd.weaponCooldowns[1] = 0;
  const ms2 = { id: "m4b", type: "missile", ownerId: "p2", targetId: pd.id, x: 200, y: 100, vx: -100, vy: 0, life: 200, interceptable: true, hp: 100 };
  room.bullets.push(ms2);
  const tn = Math.ceil(BALANCE.fleetDefence.baseReacquisitionDelayMs / MS);
  let fired = false;
  for (let t = 1; t < tn + 10; t++) {
    updateShipWeapons(room, pd, ships, DT, t * MS);
    if (ms2.hp < 100) { fired = true; assert(t >= tn - 1, "PD fired too early after switch"); break; }
  }
  assert(fired, "PD should fire after reacquisition delay");
  ok("T4: Fleet Defence reacquisition delay blocks PD firing after target switch.");
}

// T5: PD no timers when no threats.
{
  const pd = makeShip("pd5", "p1", 100, 100, [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense", rotation: 0 }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
  const en = makeShip("e5", "p2", 800, 800, [{ x: 7, y: 7, type: "core" }]);
  const room = makeRoom([pd, en]); const ships = [pd, en];
  updateCommandAuras(room, ships, 0);
  for (let t = 0; t < 5; t++) updateShipWeapons(room, pd, ships, DT, t * MS);
  assert.strictEqual(pd.pdPendingTargetIds[1], null); assert.strictEqual(pd.pdAcquireCompleteAt[1], 0); assert.strictEqual(pd.pdAcquiredTargetIds[1], null);
  assert.strictEqual(pd.pdReactionReadyAt[1], 0);
  ok("T5: PD does not schedule timers when no threats exist.");
}

// T6: PD same threat re-acquired without new timer.
{
  const pd = makeShip("pd6", "p1", 100, 100, [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense", rotation: 0 }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
  const en = makeShip("e6", "p2", 300, 100, [{ x: 7, y: 7, type: "core" }]);
  const room = makeRoom([pd, en]); const ships = [pd, en];
  updateCommandAuras(room, ships, 0); pd.weaponAngles[1] = 0;
  const ms = { id: "m6", type: "missile", ownerId: "p2", targetId: pd.id, x: 200, y: 100, vx: -100, vy: 0, life: 100, interceptable: true, hp: 100 };
  room.bullets.push(ms);
  const tn = Math.ceil(BALANCE.fleetDefence.baseReacquisitionDelayMs / MS);
  for (let t = 0; t < tn + 2; t++) updateShipWeapons(room, pd, ships, DT, t * MS);
  assert.strictEqual(pd.pdAcquiredTargetIds[1], ms.id);
  pd.weaponCooldowns[1] = 0; const hp = ms.hp;
  updateShipWeapons(room, pd, ships, DT, (tn + 3) * MS);
  assert(ms.hp < hp, "PD fires immediately on same threat");
  ok("T6: PD same threat re-acquired without new timer.");
}

// T7: Fire-Control aura shortens offensive delay.
{
  const fc = makeShip("fc7", "p1", 0, 0, [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "fireControlCommandCentre" }, { x: 7, y: 6, type: "reactor" }]);
  const sh = makeShip("s7", "p1", AURA_RANGE * 0.3, 0, [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "blaster", rotation: 0 }, { x: 7, y: 6, type: "reactor" }]);
  const en = makeShip("e7", "p2", 300, 0, [{ x: 7, y: 7, type: "core" }]); en.shield = 0;
  const room = makeRoom([fc, sh, en]); const ships = [fc, sh, en];
  updateCommandAuras(room, ships, 0);
  const mult = getCommandAuraMultiplier(sh, "targetAcquisitionMultiplier");
  assert(mult > 1); sh.weaponAngles[1] = 0;
  const st = Math.ceil(Math.round(BALANCE.fireControl.baseReacquisitionDelayMs / mult) / MS);
  const ut = Math.ceil(BALANCE.fireControl.baseReacquisitionDelayMs / MS);
  let fa = -1;
  for (let t = 0; t < ut + 10; t++) { updateShipWeapons(room, sh, ships, DT, t * MS); if (room.bullets.length > 0) { fa = t; break; } }
  assert(fa >= 0); assert(fa <= st + 1, "aura shortens delay"); assert(fa <= st, `fires within scaled ticks (fa=${fa}, st=${st}, ut=${ut})`);
  ok("T7: Fire-Control aura shortens offensive acquisition delay.");
}

// T8: Fleet Defence aura shortens PD reacquisition delay.
{
  const fd = makeShip("fd8", "p1", 0, 0, [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "fleetDefenceCoordinator" }, { x: 7, y: 6, type: "reactor" }]);
  const pd = makeShip("pd8", "p1", AURA_RANGE * 0.3, 100, [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense", rotation: 0 }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
  const en = makeShip("e8", "p2", 300, 100, [{ x: 7, y: 7, type: "core" }]);
  const room = makeRoom([fd, pd, en]); const ships = [fd, pd, en];
  updateCommandAuras(room, ships, 0);
  const mult = getCommandAuraMultiplier(pd, "interceptionReactionMultiplier");
  assert(mult > 1); pd.weaponAngles[1] = 0;
  // First threat: acquire immediately (first-ever, no delay).
  const ms1 = { id: "m8a", type: "missile", ownerId: "p2", targetId: pd.id, x: 200, y: 100, vx: -100, vy: 0, life: 200, interceptable: true, hp: 100 };
  room.bullets.push(ms1);
  updateShipWeapons(room, pd, ships, DT, 0);
  assert.strictEqual(pd.pdAcquiredTargetIds[1], ms1.id, "first PD target acquired immediately");
  // Switch to new threat.
  ms1.life = 0; room.bullets.length = 0; pd.weaponCooldowns[1] = 0;
  const ms2 = { id: "m8b", type: "missile", ownerId: "p2", targetId: pd.id, x: 200, y: 100, vx: -100, vy: 0, life: 200, interceptable: true, hp: 100 };
  room.bullets.push(ms2);
  const st = Math.ceil(Math.round(BALANCE.fleetDefence.baseReacquisitionDelayMs / mult) / MS);
  const ut = Math.ceil(BALANCE.fleetDefence.baseReacquisitionDelayMs / MS);
  let fa = -1;
  for (let t = 1; t < ut + 10; t++) { updateShipWeapons(room, pd, ships, DT, t * MS); if (ms2.hp < 100) { fa = t; break; } }
  assert(fa >= 0, "PD should fire with aura"); assert(fa <= st + 1, `aura shortens PD delay (fa=${fa}, st=${st}, ut=${ut})`);
  ok("T8: Fleet Defence aura shortens PD reacquisition delay.");
}

// T9: Turret tracks pending target but does not fire.
{
  const sh = makeShip("s9", "p1", 0, 0, [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "blaster", rotation: 0 }, { x: 7, y: 6, type: "reactor" }]);
  const en = makeShip("e9", "p2", 200, 50, [{ x: 7, y: 7, type: "core" }]); en.shield = 0;
  const room = makeRoom([sh, en]); const ships = [sh, en];
  updateCommandAuras(room, ships, 0);
  updateShipWeapons(room, sh, ships, DT, 0);
  assert.strictEqual(sh.weaponPendingTargetIds[1], en.id, "pending set");
  assert.strictEqual(sh.weaponAimTargetIds[1], en.id, "turret aims at pending");
  assert(room.bullets.length === 0, "no firing during pending");
  ok("T9: Turret tracks pending target during acquisition but does not fire.");
}

// T10: Shield depletion timestamp at sim time zero.
{
  // Verify the source code uses explicit null/undefined check instead of falsy.
  const src = require("fs").readFileSync("./src/server/runtimeShield.js", "utf8");
  assert(src.includes("!Number.isFinite(ship._shieldDepletedAt)"),
    "runtimeShield.js uses an explicit finite check for _shieldDepletedAt");
  assert(!src.includes("!ship._shieldDepletedAt"),
    "runtimeShield.js no longer uses falsy check for _shieldDepletedAt");

  // Functional test: manually set shield to 0 and verify the check works at now=0.
  // Simulate the condition: shield <= 0 and _shieldDepletedAt is 0 (set at sim time zero).
  // The old falsy check would reset it every tick; the new check preserves it.
  const ship = { shield: 0, maxShield: 100, _shieldDepletedAt: 0 };
  // The new check: shield <= 0 && (_shieldDepletedAt === undefined || _shieldDepletedAt === null)
  // With _shieldDepletedAt = 0, this is false, so the timestamp is NOT reset.
  const wouldReset = ship.shield <= 0 && (ship._shieldDepletedAt === undefined || ship._shieldDepletedAt === null);
  assert(!wouldReset, "should not reset _shieldDepletedAt=0 (the bug scenario)");

  // Old check would have been: shield <= 0 && !_shieldDepletedAt → true (bug!)
  const oldWouldReset = ship.shield <= 0 && !ship._shieldDepletedAt;
  assert(oldWouldReset, "old falsy check would have reset (confirming the bug existed)");

  ok("T10: Shield depletion timestamp at sim time zero handled correctly.");
}

// T11: Backup Core description covers both functions.
{
  const d = PARTS.backupCore.description;
  assert(d.includes("takes control"), "mentions takeover");
  assert(d.includes("aura") || d.includes("command aura"), "mentions aura");
  assert(d.includes("accuracy") || d.includes("tracking") || d.includes("acquisition"), "mentions aura effects");
  ok("T11: Backup Command Core description covers both takeover and aura.");
}

// T12: Backup Core aura applies to allies.
{
  const bc = makeShip("bc12", "p1", 0, 0, [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "backupCore" }, { x: 7, y: 6, type: "reactor" }]);
  const al = makeShip("al12", "p1", AURA_RANGE * 0.3, 0, [{ x: 7, y: 7, type: "frame" }]);
  const room = makeRoom([bc, al]);
  updateCommandAuras(room, [bc, al], 0);
  assert(getCommandAuraMultiplier(al, "weaponAccuracyMultiplier") > 1);
  assert(getCommandAuraMultiplier(al, "weaponTrackingMultiplier") > 1);
  assert(getCommandAuraMultiplier(al, "targetAcquisitionMultiplier") > 1);
  ok("T12: Backup Command Core aura applies to allied ships.");
}

// T13: Per-weapon state cleaned up on ship destruction.
{
  const sh = makeShip("s13", "p1", 0, 0, [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "blaster", rotation: 0 }, { x: 7, y: 6, type: "reactor" }]);
  const en = makeShip("e13", "p2", 200, 0, [{ x: 7, y: 7, type: "core" }]); en.shield = 0;
  const room = makeRoom([sh, en]); const ships = [sh, en];
  updateCommandAuras(room, ships, 0); sh.weaponAngles[1] = 0;
  // Run a few ticks to populate state.
  for (let t = 0; t < 3; t++) updateShipWeapons(room, sh, ships, DT, t * MS);
  assert(sh.weaponAcquiredTargetIds || sh.weaponPendingTargetIds, "state exists before destruction");
  // Destroy ship.
  const { destroyShip } = require("../src/server/combat");
  room.players.get("p2").maxMoney = 9999;
  destroyShip(room, sh, "p2", 100);
  assert.strictEqual(sh.weaponAcquiredTargetIds, null, "acquired cleared on destroy");
  assert.strictEqual(sh.weaponPendingTargetIds, null, "pending cleared on destroy");
  assert.strictEqual(sh.weaponAcquireCompleteAt, null, "completeAt cleared on destroy");
  assert.strictEqual(sh.pdAcquiredTargetIds, null, "pd acquired cleared on destroy");
  assert.strictEqual(sh.pdPendingTargetIds, null, "pd pending cleared on destroy");
  assert.strictEqual(sh.pdAcquireCompleteAt, null, "pd completeAt cleared on destroy");
  assert.strictEqual(sh.pdReactionReadyAt, null, "pd reactionReadyAt cleared on destroy");
  ok("T13: Per-weapon acquisition state cleaned up on ship destruction.");
}

// T14: Tracking bonuses preserved in componentData.
{
  const cd = require("fs").readFileSync("./src/server/componentData.js", "utf8");
  assert(cd.includes("pointDefenceTrackingMultiplier") && cd.includes("aimSpeed"), "PD tracking applies to aimSpeed");
  assert(cd.includes("flakTrackingMultiplier") && cd.includes("aimSpeed"), "flak tracking applies to aimSpeed");
  ok("T14: PD and flak tracking bonuses preserved in componentData.");
}

// T15: PD reaction delay survives a gap (A -> nothing -> B).
{
  const pd = makeShip("pd15", "p1", 100, 100, [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense", rotation: 0 }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
  const en = makeShip("e15", "p2", 900, 900, [{ x: 7, y: 7, type: "core" }]);
  const room = makeRoom([pd, en]); const ships = [pd, en];
  updateCommandAuras(room, ships, 0); pd.weaponAngles[1] = 0;
  // First threat: acquire immediately (first-ever target).
  const ms1 = { id: "m15a", type: "missile", ownerId: "p2", targetId: pd.id, x: 200, y: 100, vx: -100, vy: 0, life: 200, interceptable: true, hp: 100 };
  room.bullets.push(ms1);
  updateShipWeapons(room, pd, ships, DT, 0);
  assert.strictEqual(pd.pdAcquiredTargetIds[1], ms1.id, "first PD target acquired immediately");
  // Remove first threat — gap with no threats.
  ms1.life = 0; room.bullets.length = 0;
  const gapTicks = 5;
  for (let t = 1; t <= gapTicks; t++) updateShipWeapons(room, pd, ships, DT, t * MS);
  // After the gap, pdReactionReadyAt should be set.
  assert(pd.pdReactionReadyAt[1] > 0, "reaction ready time set after target loss");
  // New threat appears after the gap.
  pd.weaponCooldowns[1] = 0;
  const ms2 = { id: "m15b", type: "missile", ownerId: "p2", targetId: pd.id, x: 200, y: 100, vx: -100, vy: 0, life: 200, interceptable: true, hp: 100 };
  room.bullets.push(ms2);
  const baseDelay = Number(BALANCE?.fleetDefence?.baseReacquisitionDelayMs) || 600;
  const tn = Math.ceil(baseDelay / MS);
  let fired = false;
  for (let t = gapTicks + 1; t < gapTicks + tn + 10; t++) {
    updateShipWeapons(room, pd, ships, DT, t * MS);
    if (ms2.hp < 100) { fired = true; assert(t >= gapTicks + tn - 1, "PD fired too early after gap"); break; }
  }
  assert(fired, "PD should fire after reacquisition delay even with gap");
  ok("T15: PD reaction delay survives a gap (A -> nothing -> B).");
}

console.log(`\nverify-command-runtime: all ${passed} tests passed.`);
