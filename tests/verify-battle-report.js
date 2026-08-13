"use strict";

const assert = require("node:assert/strict");
const { computeStats } = require("../src/server/shipStats");
const { initComponentState } = require("../src/server/componentHealth");
const heat = require("../src/server/heat");
const { effectiveShieldStats, initializeComponentPower } = require("../src/server/componentPower");
const combat = require("../src/server/combat");
const { updateBullets } = require("../src/server/projectiles");
const { updateRuntimeShield } = require("../src/server/runtimeShield");

function makePlayer(id, team) {
  return {
    id,
    name: id,
    team,
    color: "#fff",
    ships: [],
    kills: 0,
    losses: 0,
    captures: 0,
    damageDealt: 0,
    shieldDamageDealt: 0,
    componentsDestroyed: 0,
    missilesIntercepted: 0,
    hullRepaired: 0,
    shieldRestored: 0,
    destroyedEnemyCost: 0,
    lostFleetCost: 0,
    money: 0,
    maxMoney: 99999,
    earned: 0,
    spent: 0,
    deployedFleetCost: 0,
    shipCap: 5,
    design: [{ type: "core" }],
    stats: {}
  };
}

function makeRoom() {
  const players = [makePlayer("attacker", "blue"), makePlayer("victim", "red")];
  return {
    players: new Map(players.map((player) => [player.id, player])),
    ships: new Map(),
    bullets: [],
    effects: [],
    drones: new Map(),
    decoys: new Map(),
    stations: [],
    nextEntityId: 1,
    disableSpatialIndex: true,
    spatialIndex: { remove() {}, updateLiveEntities() {} },
    map: { asteroids: [], safeZones: [] },
    world: { width: 2000, height: 2000 },
    rules: { gameMode: "teams" },
    combatRandom: () => 0.5,
    _roomTelemetry: null
  };
}

function makeShip(id, ownerId, design, overrides = {}) {
  const stats = { ...computeStats(design), ...(overrides.stats || {}) };
  const ship = {
    id,
    ownerId,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    radius: stats.radius || 35,
    alive: true,
    design,
    stats,
    shield: 0,
    maxShield: stats.maxShield || 0,
    dataLinks: [],
    dirtyComponents: new Set(),
    ...overrides
  };
  initComponentState(ship);
  heat.initShipHeat(ship);
  return ship;
}

function assertOwnerOnly(room, field, expectedOwner, expectedDelta, message) {
  const owner = room.players.get(expectedOwner);
  const other = room.players.get(expectedOwner === "attacker" ? "victim" : "attacker");
  assert.ok(Math.abs(owner[field] - expectedDelta) <= 1e-9, `${message}: owner delta`);
  assert.equal(other[field], 0, `${message}: other player must not receive credit`);
}

// Hull damage and Shield damage are separate counters. A single shielded hit
// must record the blocked amount once and the actual hull bleed-through once.
{
  const room = makeRoom();
  const target = makeShip("damage-target", "victim", [
    { type: "core", x: 7, y: 7 },
    { type: "frame", x: 7, y: 6 },
    { type: "frame", x: 7, y: 8 }
  ]);
  room.ships.set(target.id, target);
  const attacker = room.players.get("attacker");
  const beforeHull = target.hp;
  combat.damageShip(room, target, 10, "attacker", 1000, target.x + 13, target.y);
  const hullDamage = beforeHull - target.hp;
  assert.equal(hullDamage, 10, "one unshielded hit applies ten hull damage");
  assertOwnerOnly(room, "damageDealt", "attacker", hullDamage, "unshielded damage");
  assert.equal(attacker.shieldDamageDealt, 0, "unshielded damage does not create Shield damage credit");
}

{
  const room = makeRoom();
  const target = makeShip("shield-target", "victim", [
    { type: "core", x: 7, y: 7 },
    { type: "frame", x: 7, y: 6 },
    { type: "frame", x: 7, y: 8 }
  ], { shield: 100, maxShield: 100 });
  room.ships.set(target.id, target);
  const beforeHull = target.hp;
  combat.damageShip(room, target, 20, "attacker", 1100, target.x + 13, target.y);
  const hullDamage = beforeHull - target.hp;
  assert.equal(target.shield, 80, "one shielded hit removes twenty Shield points");
  assert.equal(hullDamage, 1, "Shield bleed-through applies one hull damage");
  assertOwnerOnly(room, "shieldDamageDealt", "attacker", 20, "blocked Shield damage");
  assertOwnerOnly(room, "damageDealt", "attacker", hullDamage, "shield bleed-through damage");
}

// Component destruction is credited to the last hostile attacker once, while
// Core destruction remains a ship kill rather than a component statistic.
{
  const room = makeRoom();
  const target = makeShip("component-target", "victim", [
    { type: "core", x: 7, y: 7 },
    { type: "repair", x: 7, y: 6 },
    { type: "frame", x: 7, y: 8 }
  ]);
  room.ships.set(target.id, target);
  const componentMaxHp = target.componentMaxHp[1];
  const dealt = combat.applyDirectComponentDamage(room, target, 1, componentMaxHp + 1, "attacker", 1200);
  assert.equal(dealt, componentMaxHp, "direct component damage reports the destroyed component HP");
  assert.equal(target.componentHp[1], 0, "the targeted non-Core component reaches zero");
  assertOwnerOnly(room, "componentsDestroyed", "attacker", 1, "component destruction");
  assert.equal(room.players.get("attacker").damageDealt, componentMaxHp, "component damage is counted once as hull damage");
  assert.equal(target.alive, true, "destroying one component does not destroy the remaining ship");
}

// Point Defence interception and Flak interception use different projectile
// collision branches; each event must credit only the intercepting player.
{
  const room = makeRoom();
  const missile = { id: "missile-pd", type: "missile", ownerId: "victim", x: 100, y: 100, vx: 0, vy: 0, life: 1, damage: 99, hp: 6, interceptable: true };
  const pdShot = { id: "pd-shot", type: "pdShot", ownerId: "attacker", x: 100, y: 100, vx: 0, vy: 0, life: 1, damage: 6, pdTargetType: "projectile", pdTargetId: "missile-pd" };
  room.bullets = [missile, pdShot];
  updateBullets(room, 0.01, 2000);
  assert.equal(missile.life, 0, "Point Defence destroys the intercepted missile");
  assertOwnerOnly(room, "missilesIntercepted", "attacker", 1, "Point Defence interception");
}

{
  const room = makeRoom();
  const missile = { id: "missile-flak", type: "missile", ownerId: "victim", x: 0, y: 30, vx: 0, vy: 0, life: 10, damage: 20, hp: 5, interceptable: true };
  const flak = {
    id: "flak-shot",
    type: "flak",
    subtype: "flakCannon",
    ownerId: "attacker",
    x: 0,
    y: 0,
    vx: 0,
    vy: 900,
    life: 10,
    damage: 5,
    directDamage: 5,
    blastDamage: 20,
    blastRadius: 40,
    proximityFuseRadius: 10,
    innerFullDamageRadius: 40,
    falloffExponent: 1,
    maximumExplosionTargets: 1,
    shieldDamageMultiplier: 1,
    hullDamageMultiplier: 1
  };
  room.bullets = [missile, flak];
  updateBullets(room, 1 / 30, 2100);
  assert.equal(missile.life, 0, "Flak destroys the intercepted missile");
  assertOwnerOnly(room, "missilesIntercepted", "attacker", 1, "Flak interception");
}

function makeSupportShip(id, ownerId, moduleType, x, damaged, stats = {}) {
  const design = [
    { type: "core", x: 7, y: 7 },
    { type: moduleType, x: 7, y: 6 }
  ];
  return {
    id,
    ownerId,
    x,
    y: 0,
    angle: 0,
    alive: true,
    design,
    stats: { repair: 1, repairRange: 410, efficiency: 1, ...stats },
    hp: damaged ? 10 : 100,
    maxHp: 100,
    componentHp: [100, damaged ? 10 : 100],
    componentMaxHp: [100, 100],
    dirtyComponents: new Set()
  };
}

// Local Repair and Repair Beam both credit the player operating the repair
// source, not the player whose ship receives the restored hull.
{
  const room = makeRoom();
  const local = makeSupportShip("local-repair", "attacker", "repair", 0, true);
  room.ships.set(local.id, local);
  combat.updateShipSupport(room, [local], 1, 2200);
  const repaired = local.componentHp[1] - 10;
  assert(repaired > 0, "Local Repair restores damaged hull");
  assertOwnerOnly(room, "hullRepaired", "attacker", repaired, "Local Repair");
}

{
  const room = makeRoom();
  room.players.get("victim").team = "blue";
  const beam = makeSupportShip("repair-beam", "attacker", "repairBeam", 0, false);
  const ally = makeSupportShip("repair-target", "victim", "frame", 100, true, { repair: 0 });
  room.ships.set(beam.id, beam);
  room.ships.set(ally.id, ally);
  room.spatialIndex = null;
  combat.updateShipSupport(room, [beam, ally], 1, 2300);
  const repaired = ally.componentHp[1] - 10;
  assert(repaired > 0, "Repair Beam restores a damaged allied hull");
  assertOwnerOnly(room, "hullRepaired", "attacker", repaired, "Repair Beam");
}

// Shield regeneration is credited from the actual runtime restoration delta,
// once, to the owner of the regenerating ship.
{
  const room = makeRoom();
  const design = [
    { type: "core", x: 7, y: 7 },
    { type: "reactor", x: 7, y: 8 },
    { type: "shield", x: 7, y: 6 }
  ];
  const ship = makeShip("shield-runtime", "attacker", design, {
    commandAurasReceived: {},
    commandAuraMultipliers: {}
  });
  initializeComponentPower(ship);
  const capacity = effectiveShieldStats(ship).capacity;
  ship.shield = capacity / 2;
  const beforeShield = ship.shield;
  updateRuntimeShield(ship, 1, 0, room);
  const restored = ship.shield - beforeShield;
  assert(restored > 0, "Shield runtime restores a positive amount");
  assertOwnerOnly(room, "shieldRestored", "attacker", restored, "Shield regeneration");
}

console.log("Battle Report server statistics verification passed");
