"use strict";
const assert = require("assert");
const fs = require("fs");
const { PARTS } = require("../src/server/components");
const { computeStats } = require("../src/server/shipStats");
const { initComponentState } = require("../src/server/componentHealth");
const { updateShipWeapons, destroyShip } = require("../src/server/combat");
const { reallocateShipPower } = require("../src/server/componentPower");
const { updateCommandAuras, getCommandAuraMultiplier, getCommandAuraRange } = require("../src/server/commandAuras");
const HeatRules = require("../public/src/shared/heatRules");

const AURA_RANGE = getCommandAuraRange();
const DT = 1 / 30;
const MS = 1000 / 30;
let passed = 0;
function ok(message) { passed += 1; console.log("  " + message); }

function makeShip(id, owner, x, y, design) {
  const dataLinks = [];
  const stats = computeStats(design, { dataLinks });
  const ship = {
    id, ownerId: owner, x, y, angle: 0, vx: 0, vy: 0, design, dataLinks, stats, alive: true,
    hp: stats.maxHp || 500, maxHp: stats.maxHp || 500, shield: 0, maxShield: 0,
    commandState: "mainCore", componentHeatState: design.map(() => HeatRules.STATE.NORMAL),
    commandAurasReceived: {}, commandAuraMultipliers: {}
  };
  initComponentState(ship);
  reallocateShipPower(ship, "init");
  ship.weaponAngles = design.map((module) => (module.rotation || 0) * (Math.PI / 180));
  ship.weaponCooldowns = design.map(() => 0);
  ship.weaponDesiredAngles = design.map(() => 0);
  ship.weaponAimTargetIds = design.map(() => null);
  ship.weaponFireTargetIds = design.map(() => null);
  return ship;
}

function makeRoom(ships) {
  const shipMap = new Map();
  const players = new Map([
    ["p1", { id: "p1", team: "A", kills: 0, losses: 0, money: 9999, earned: 0, destroyedEnemyCost: 0, lostFleetCost: 0, ships: [], design: [] }],
    ["p2", { id: "p2", team: "B", kills: 0, losses: 0, money: 9999, earned: 0, destroyedEnemyCost: 0, lostFleetCost: 0, ships: [], design: [] }]
  ]);
  for (const ship of ships) {
    shipMap.set(ship.id, ship);
    players.get(ship.ownerId)?.ships.push(ship);
  }
  return {
    code: "t", phase: "active", ships: shipMap, players, bullets: [], drones: new Map(),
    points: [], effects: [], map: { asteroids: [], safeZones: [] }, rules: { gameMode: "solo" },
    world: { width: 4000, height: 4000 }
  };
}

function offensiveDesign(type = "blaster") {
  return [
    { x: 7, y: 7, type: "core" },
    { x: 8, y: 7, type, rotation: 0 },
    { x: 7, y: 6, type: "reactor" }
  ];
}

function pointDefenseDesign(type = "pointDefense") {
  return [
    { x: 7, y: 7, type: "core" },
    { x: 8, y: 7, type, rotation: 0 },
    { x: 7, y: 6, type: "reactor" },
    { x: 7, y: 8, type: "engine" }
  ];
}

function missile(id, parentId, x = 200, y = 100) {
  return { id, type: "missile", ownerId: "p2", targetId: parentId, x, y, vx: -100, vy: 0, life: 200, interceptable: true, hp: 100 };
}

function obsoleteLockState(ship) {
  return Object.keys(ship).filter((property) => /AcquiredTarget|PendingTarget|AcquireComplete|ReactionReady/.test(property));
}

// T1: ordinary target selection does not add a hidden firing delay.
{
  const shooter = makeShip("s1", "p1", 0, 0, offensiveDesign());
  const enemy = makeShip("e1", "p2", 200, 0, [{ x: 7, y: 7, type: "core" }]);
  const room = makeRoom([shooter, enemy]);
  updateCommandAuras(room, [shooter, enemy], 0);
  updateShipWeapons(room, shooter, [shooter, enemy], DT, 0);
  assert(room.bullets.length > 0, "ordinary weapon fires on its first valid selection");
  assert.strictEqual(shooter.weaponFireTargetIds[1], enemy.id);
  assert.deepStrictEqual(obsoleteLockState(shooter), []);
  ok("T1: Ordinary weapons fire immediately after valid target selection.");
}

// T2: switching to a newly selected ordinary target does not restart a delay.
{
  const shooter = makeShip("s2", "p1", 0, 0, offensiveDesign());
  const first = makeShip("e2a", "p2", 200, 0, [{ x: 7, y: 7, type: "core" }]);
  const second = makeShip("e2b", "p2", 350, 0, [{ x: 7, y: 7, type: "core" }]);
  const room = makeRoom([shooter, first, second]);
  updateCommandAuras(room, [shooter, first, second], 0);
  updateShipWeapons(room, shooter, [shooter, first, second], DT, 0);
  room.bullets.length = 0;
  shooter.weaponCooldowns[1] = 0;
  first.alive = false;
  first.x = 9999;
  first.y = 9999;
  updateCommandAuras(room, [shooter, second], MS);
  updateShipWeapons(room, shooter, [shooter, second], DT, MS);
  assert(room.bullets.length > 0, "ordinary weapon fires after target switch");
  assert.strictEqual(shooter.weaponFireTargetIds[1], second.id);
  ok("T2: Ordinary target switches retain cadence without a firing delay.");
}

// T3: the normal search cadence remains authoritative.
{
  const shooter = makeShip("s3", "p1", 0, 0, offensiveDesign());
  const enemy = makeShip("e3", "p2", 200, 0, [{ x: 7, y: 7, type: "core" }]);
  const room = makeRoom([shooter, enemy]);
  updateCommandAuras(room, [shooter, enemy], 0);
  updateShipWeapons(room, shooter, [shooter, enemy], DT, 0);
  assert(shooter._targetAcquisitionSchedule, "target cadence state is retained");
  assert(Object.keys(shooter._targetAcquisitionSchedule).some((key) => key.startsWith("ordinaryShip:")));
  ok("T3: Ordinary target search cadence remains in place.");
}

// T4: defensive target switches are immediate once the normal search finds one.
{
  const pd = makeShip("pd4", "p1", 100, 100, pointDefenseDesign());
  const enemy = makeShip("e4", "p2", 300, 100, [{ x: 7, y: 7, type: "core" }]);
  const room = makeRoom([pd, enemy]);
  updateCommandAuras(room, [pd, enemy], 0);
  const first = missile("m4a", pd.id, 200, 100);
  const second = missile("m4b", pd.id, 260, 100);
  room.bullets.push(first, second);
  updateShipWeapons(room, pd, [pd, enemy], DT, 0);
  assert.strictEqual(pd.weaponFireTargetIds[1], first.id);
  room.bullets.length = 0;
  pd.weaponCooldowns[1] = 0;
  room.bullets.push(second);
  updateShipWeapons(room, pd, [pd, enemy], DT, 200);
  assert.strictEqual(pd.weaponFireTargetIds[1], second.id);
  assert(second.hp < 100, "PD fires at the replacement threat immediately");
  assert.deepStrictEqual(obsoleteLockState(pd), []);
  ok("T4: Point Defence switches targets immediately.");
}

// T5: no target still means no hidden acquisition state is created.
{
  const pd = makeShip("pd5", "p1", 100, 100, pointDefenseDesign());
  const enemy = makeShip("e5", "p2", 800, 800, [{ x: 7, y: 7, type: "core" }]);
  const room = makeRoom([pd, enemy]);
  updateCommandAuras(room, [pd, enemy], 0);
  for (let tick = 0; tick < 5; tick += 1) updateShipWeapons(room, pd, [pd, enemy], DT, tick * MS);
  assert.deepStrictEqual(obsoleteLockState(pd), []);
  ok("T5: Point Defence does not create obsolete reaction state.");
}

// T6: defensive target search cadence is still present.
{
  const pd = makeShip("pd6", "p1", 100, 100, pointDefenseDesign());
  const enemy = makeShip("e6", "p2", 300, 100, [{ x: 7, y: 7, type: "core" }]);
  const room = makeRoom([pd, enemy]);
  updateCommandAuras(room, [pd, enemy], 0);
  room.bullets.push(missile("m6", pd.id));
  updateShipWeapons(room, pd, [pd, enemy], DT, 0);
  assert(pd._targetAcquisitionSchedule, "PD cadence state is retained");
  assert(Object.keys(pd._targetAcquisitionSchedule).some((key) => key.includes("pointDefence")));
  ok("T6: Point Defence target search cadence remains in place.");
}

// T7: Fire-Control keeps accuracy, tracking, and traverse support only.
{
  const controller = makeShip("fc7", "p1", 0, 0, [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "fireControlCommandCentre" }, { x: 7, y: 6, type: "reactor" }]);
  const ally = makeShip("al7", "p1", AURA_RANGE * 0.3, 0, offensiveDesign());
  const room = makeRoom([controller, ally]);
  updateCommandAuras(room, [controller, ally], 0);
  assert(getCommandAuraMultiplier(ally, "weaponAccuracyMultiplier") > 1);
  assert(getCommandAuraMultiplier(ally, "weaponTrackingMultiplier") > 1);
  assert(getCommandAuraMultiplier(ally, "turretAimSpeedMultiplier") > 1);
  ok("T7: Fire-Control retains its live accuracy, tracking, and traverse effects.");
}

// T8: Fleet Defence keeps Point Defence and Flak tracking support only.
{
  const controller = makeShip("fd8", "p1", 0, 0, [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "fleetDefenceCoordinator" }, { x: 7, y: 6, type: "reactor" }]);
  const ally = makeShip("al8", "p1", AURA_RANGE * 0.3, 0, pointDefenseDesign());
  const room = makeRoom([controller, ally]);
  updateCommandAuras(room, [controller, ally], 0);
  assert(getCommandAuraMultiplier(ally, "pointDefenceTrackingMultiplier") > 1);
  assert(getCommandAuraMultiplier(ally, "flakTrackingMultiplier") > 1);
  ok("T8: Fleet Defence retains Point Defence and Flak tracking effects.");
}

// T9: target selection starts aiming immediately; physical turret traverse is
// the only delay before an off-axis shot.
{
  const shooter = makeShip("s9", "p1", 0, 0, offensiveDesign());
  const enemy = makeShip("e9", "p2", 200, 50, [{ x: 7, y: 7, type: "core" }]);
  const room = makeRoom([shooter, enemy]);
  updateCommandAuras(room, [shooter, enemy], 0);
  updateShipWeapons(room, shooter, [shooter, enemy], DT, 0);
  assert.strictEqual(shooter.weaponAimTargetIds[1], enemy.id);
  assert.strictEqual(room.bullets.length, 0, "off-axis weapon waits for physical turret alignment");
  for (let tick = 1; tick <= 10 && room.bullets.length === 0; tick += 1) {
    updateShipWeapons(room, shooter, [shooter, enemy], DT, tick * MS);
  }
  assert(room.bullets.length > 0, "weapon fires as soon as its turret reaches alignment");
  assert.deepStrictEqual(obsoleteLockState(shooter), []);
  ok("T9: Newly selected targets begin aiming immediately and fire when aligned.");
}

// T10: Shield depletion timestamp at simulation time zero.
{
  const source = fs.readFileSync("./src/server/runtimeShield.js", "utf8");
  assert(source.includes("!Number.isFinite(ship._shieldDepletedAt)"));
  assert(!source.includes("!ship._shieldDepletedAt"));
  const ship = { shield: 0, maxShield: 100, _shieldDepletedAt: 0 };
  const wouldReset = ship.shield <= 0 && (ship._shieldDepletedAt === undefined || ship._shieldDepletedAt === null);
  assert(!wouldReset);
  ok("T10: Shield depletion timestamp at simulation time zero is preserved.");
}

// T11: Backup Core description covers takeover and its surviving aura effects.
{
  const description = PARTS.backupCore.description;
  assert(description.includes("takes control"));
  assert(description.includes("aura") || description.includes("command aura"));
  assert(description.includes("accuracy") || description.includes("tracking"));
  assert(!description.includes("target acquisition"));
  ok("T11: Backup Command Core copy describes the retained aura effects.");
}

// T12: Backup Core aura applies to allies without either removed stat.
{
  const backup = makeShip("bc12", "p1", 0, 0, [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "backupCore" }, { x: 7, y: 6, type: "reactor" }]);
  const ally = makeShip("al12", "p1", AURA_RANGE * 0.3, 0, [{ x: 7, y: 7, type: "frame" }]);
  const room = makeRoom([backup, ally]);
  updateCommandAuras(room, [backup, ally], 0);
  assert(getCommandAuraMultiplier(ally, "weaponAccuracyMultiplier") > 1);
  assert(getCommandAuraMultiplier(ally, "weaponTrackingMultiplier") > 1);
  ok("T12: Backup Command Core preserves allied accuracy and tracking support.");
}

// T13: destroyed ships do not retain the removed per-weapon lock state.
{
  const shooter = makeShip("s13", "p1", 0, 0, offensiveDesign());
  const enemy = makeShip("e13", "p2", 200, 0, [{ x: 7, y: 7, type: "core" }]);
  const room = makeRoom([shooter, enemy]);
  updateCommandAuras(room, [shooter, enemy], 0);
  updateShipWeapons(room, shooter, [shooter, enemy], DT, 0);
  destroyShip(room, shooter, "p2", 100);
  const obsoleteLockState = Object.keys(shooter).filter((property) => /AcquiredTarget|PendingTarget|AcquireComplete|ReactionReady/.test(property));
  assert.deepStrictEqual(obsoleteLockState, [], "obsolete lock state is not recreated on destroy");
  ok("T13: Removed weapon and PD lock state is absent after destruction.");
}

// T14: tracking bonuses remain wired into effective weapon profiles.
{
  const source = fs.readFileSync("./src/server/componentData.js", "utf8");
  assert(source.includes("pointDefenceTrackingMultiplier") && source.includes("aimSpeed"));
  assert(source.includes("flakTrackingMultiplier") && source.includes("aimSpeed"));
  ok("T14: Point Defence and Flak tracking bonuses remain active.");
}

// T15: a gap does not create a reaction period before a new PD threat.
{
  const pd = makeShip("pd15", "p1", 100, 100, pointDefenseDesign());
  const enemy = makeShip("e15", "p2", 900, 900, [{ x: 7, y: 7, type: "core" }]);
  const room = makeRoom([pd, enemy]);
  updateCommandAuras(room, [pd, enemy], 0);
  const first = missile("m15a", pd.id);
  room.bullets.push(first);
  updateShipWeapons(room, pd, [pd, enemy], DT, 0);
  room.bullets.length = 0;
  for (let tick = 1; tick <= 5; tick += 1) updateShipWeapons(room, pd, [pd, enemy], DT, tick * MS);
  pd.weaponCooldowns[1] = 0;
  const second = missile("m15b", pd.id);
  room.bullets.push(second);
  updateShipWeapons(room, pd, [pd, enemy], DT, 300);
  assert.strictEqual(pd.weaponFireTargetIds[1], second.id);
  assert(second.hp < 100);
  assert.deepStrictEqual(obsoleteLockState(pd), []);
  ok("T15: A target gap does not add a defensive wait.");
}

console.log(`\nverify-command-runtime: all ${passed} tests passed.`);
