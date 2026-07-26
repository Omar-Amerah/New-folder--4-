#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { RoomSpatialIndex, buildRoomSpatialIndex } = require("./src/server/spatialIndex");
const {
  CONFIG,
  ownerActiveCount,
  shipActiveCount,
  setDroneDestroyed,
  setDroneBayMode,
  _test: { spawnDrone, chooseTarget, updateDroneEntity }
} = require("./src/server/drones");
const { addBullet, ensureProjectileLookup, updateBullets } = require("./src/server/projectiles");
const { resetMatch } = require("./src/server/rooms");
const { repairShipComponents } = require("./src/server/componentHealth");
const { shipRepairNeed } = require("./src/server/combat");
const { markShipRepairCacheDirty } = require("./src/server/repairCache");
const {
  recordRoomTick,
  recordTick,
  recordSnapshot,
  performanceSnapshot
} = require("./src/server/performanceTelemetry");

function player(id, team) {
  return { id, team, ships: [], connected: true, purchaseRequests: new Map(), money: 0 };
}

function carrierRoom() {
  const bay = {
    componentIndex: 0,
    componentId: "bay:0",
    droneType: "fighter",
    mode: "deployed",
    nextLaunchAt: Infinity,
    launchEdge: { centerX: 7.5, centerY: 6.5, dx: 0, dy: -1 },
    slots: Array.from({ length: CONFIG.squadSize }, (_, slot) => ({
      slot, state: "ready", droneId: null, productionProgress: 1, pauseReason: null
    }))
  };
  const carrier = {
    id: "carrier", ownerId: "blue", team: "a", alive: true,
    x: 500, y: 500, vx: 0, vy: 0, angle: 0, radius: 30,
    hp: 100, maxHp: 100, shield: 0,
    design: [{ x: 7, y: 7, type: "droneBay", droneType: "fighter" }],
    componentHp: [100], componentMaxHp: [100],
    componentPower: { byComponentIndex: [{ operationalMultiplier: 1 }] },
    componentHeatState: [0],
    droneBays: [bay]
  };
  const room = {
    phase: "active",
    players: new Map([["blue", player("blue", "a")], ["red", player("red", "b")]]),
    ships: new Map([[carrier.id, carrier]]),
    drones: new Map(),
    bullets: [],
    effects: [],
    projectileById: new Map(),
    nextEntityId: 1,
    world: { width: 4000, height: 4000 },
    map: { asteroids: [], safeZones: [] },
    points: [],
    rules: { gameMode: "teams" },
    clients: new Set()
  };
  return { room, carrier, bay };
}

// Boundary coverage: an entity exactly on a cell edge must be returned from
// both a range query and a swept box touching that edge.
{
  const index = new RoomSpatialIndex(100);
  const edge = { id: "edge", x: 100, y: 100 };
  index.add("drones", edge, 0, 0);
  assert.deepEqual(index.queryRange("drones", 0, 100, 100).map((item) => item.id), ["edge"]);
  assert.deepEqual(index.querySweptAabb("drones", 0, 100, 100, 100).map((item) => item.id), ["edge"]);
}

// Equal-distance targeting retains ID tie-breaking with and without the index.
{
  const { room, carrier } = carrierRoom();
  const d2 = { id: "d2", ownerId: "red", parentShipId: "red-carrier", type: "fighter", x: 600, y: 500, hull: 20 };
  const d1 = { id: "d1", ownerId: "red", parentShipId: "red-carrier", type: "fighter", x: 400, y: 500, hull: 20 };
  room.drones.set(d2.id, d2);
  room.drones.set(d1.id, d1);
  const fighter = { id: "friendly", ownerId: "blue", parentShipId: carrier.id, type: "fighter", x: 500, y: 500 };
  const withoutIndex = chooseTarget(room, fighter, carrier, CONFIG.types.fighter);
  buildRoomSpatialIndex(room, [carrier], 0);
  const withIndex = chooseTarget(room, fighter, carrier, CONFIG.types.fighter);
  assert.equal(withoutIndex.id, "d1");
  assert.equal(withIndex.id, withoutIndex.id);
}

// Repair scoring uses the cache but selects the same valid ally.
{
  const { room, carrier } = carrierRoom();
  const near = {
    id: "ally-near", ownerId: "blue", alive: true, x: 590, y: 500,
    hp: 70, maxHp: 100, design: [{ type: "core" }], componentHp: [80], componentMaxHp: [100]
  };
  const far = {
    id: "ally-far", ownerId: "blue", alive: true, x: 700, y: 500,
    hp: 90, maxHp: 100, design: [{ type: "core" }], componentHp: [95], componentMaxHp: [100]
  };
  room.ships.set(near.id, near);
  room.ships.set(far.id, far);
  const repair = { id: "repair", ownerId: "blue", parentShipId: carrier.id, type: "repair", x: 500, y: 500 };
  const withoutIndex = chooseTarget(room, repair, carrier, CONFIG.types.repair);
  buildRoomSpatialIndex(room, [carrier, near, far], 0);
  const withIndex = chooseTarget(room, repair, carrier, CONFIG.types.repair);
  assert.equal(withoutIndex.id, "ally-near");
  assert.equal(withIndex.id, withoutIndex.id);
}

// Repair cache revisions follow damage and repair mutations without rescanning
// unchanged component arrays on subsequent reads.
{
  const { room } = carrierRoom();
  const ship = {
    id: "repair-cache", ownerId: "blue", alive: true, x: 700, y: 500,
    hp: 80, maxHp: 100, shield: 0, stats: {},
    design: [{ x: 7, y: 7, type: "frame" }],
    componentHp: [80], componentMaxHp: [100], componentHeatState: [0],
    dirtyComponents: new Set()
  };
  room.ships.set(ship.id, ship);
  assert.equal(shipRepairNeed(ship), 40);
  const firstCache = ship.repairTargetCache;
  assert.equal(shipRepairNeed(ship), 40);
  assert.equal(ship.repairTargetCache, firstCache, "unchanged repair need reuses the cached object");
  repairShipComponents(room, ship, 10, 1);
  assert.equal(shipRepairNeed(ship), 20);
  ship.componentHp[0] -= 5;
  ship.hp -= 5;
  markShipRepairCacheDirty(ship);
  assert.equal(shipRepairNeed(ship), 30);
}

// O(1) counters remain exact across spawn, destruction, docking and rematch.
{
  const { room, carrier, bay } = carrierRoom();
  const first = spawnDrone(room, carrier, bay, bay.slots[0], 0);
  const second = spawnDrone(room, carrier, bay, bay.slots[1], 0);
  assert.equal(ownerActiveCount(room, "blue"), 2);
  assert.equal(shipActiveCount(room, carrier.id), 2);
  setDroneDestroyed(room, first, 10);
  assert.equal(ownerActiveCount(room, "blue"), 1);
  assert.equal(shipActiveCount(room, carrier.id), 1);

  bay.mode = "recalled";
  second.state = "returning";
  second.returnReason = "recall";
  const pose = require("./src/server/drones").bayWorldPose(carrier, bay);
  second.x = pose.x;
  second.y = pose.y;
  updateDroneEntity(room, second, 0, 20);
  assert.equal(room.drones.has(second.id), false);
  assert.equal(ownerActiveCount(room, "blue"), 0);
  assert.equal(shipActiveCount(room, carrier.id), 0);

  const third = spawnDrone(room, carrier, bay, bay.slots[2], 30);
  assert.ok(third);
  buildRoomSpatialIndex(room, [carrier], 30);
  const reusedIndex = room.spatialIndex;
  setDroneDestroyed(room, third, 31);
  assert.equal(room.spatialIndex.queryRange("drones", third.x, third.y, 20).includes(third), false,
    "removal invalidates the current spatial record immediately");
  resetMatch(room, 40);
  assert.equal(room.drones.size, 0);
  assert.equal(ownerActiveCount(room, "blue"), 0);
  assert.equal(shipActiveCount(room, carrier.id), 0);
  assert.equal(room.spatialIndex, reusedIndex, "room reset retains the reusable index instance");
  assert.equal(room.spatialIndex.count("drones"), 0);
  assert.equal(room.spatialIndex.count("ships"), 0);
}

// Recall and power-loss fallback are immediate, not delayed to decision cadence.
{
  const { room, carrier, bay } = carrierRoom();
  const active = spawnDrone(room, carrier, bay, bay.slots[0], 0);
  active.state = "active";
  active.targetId = "old-target";
  assert.equal(setDroneBayMode(room, room.players.get("blue"), carrier.id, bay.componentId, "recalled", 5), true);
  assert.equal(active.state, "returning");
  assert.equal(active.targetId, null);

  setDroneBayMode(room, room.players.get("blue"), carrier.id, bay.componentId, "deployed", 6);
  carrier.componentPower.byComponentIndex[0].operationalMultiplier = 0;
  updateDroneEntity(room, active, 1 / 30, 7);
  assert.equal(active.commandState, "fallback");
}

// Expensive targeting/evasion decisions run at ~8.3 Hz while steering continues
// every simulation tick and reuses the cached result in between.
{
  const { room, carrier, bay } = carrierRoom();
  const fighter = spawnDrone(room, carrier, bay, bay.slots[0], 0);
  fighter.state = "active";
  fighter.nextActionAt = Infinity;
  const firstTarget = { id: "enemy-a", ownerId: "red", parentShipId: "red", type: "fighter", x: 560, y: 500, hull: 20 };
  const secondTarget = { id: "enemy-b", ownerId: "red", parentShipId: "red", type: "fighter", x: 760, y: 500, hull: 20 };
  room.drones.set(firstTarget.id, firstTarget);
  room.drones.set(secondTarget.id, secondTarget);
  room.bullets = [{ id: "threat-a", ownerId: "red", type: "bolt", x: fighter.x + 120, y: fighter.y, vx: -500, vy: 0, life: 2 }];
  updateDroneEntity(room, fighter, 1 / 30, 0);
  assert.equal(fighter.targetId, firstTarget.id);
  assert.equal(fighter.evasionProjectileId, "threat-a");
  const decisionDeadline = fighter.nextDecisionAt;
  assert.ok(decisionDeadline >= 115 && decisionDeadline <= 125);

  firstTarget.x = 900;
  secondTarget.x = 530;
  room.bullets = [{ id: "threat-b", ownerId: "red", type: "bolt", x: fighter.x + 80, y: fighter.y, vx: -600, vy: 0, life: 2 }];
  updateDroneEntity(room, fighter, 1 / 30, 60);
  assert.equal(fighter.targetId, firstTarget.id, "target decision is cached between decision ticks");
  assert.equal(fighter.evasionProjectileId, "threat-a", "evasion decision is cached while per-tick steering continues");
  updateDroneEntity(room, fighter, 1 / 30, 121);
  assert.equal(fighter.targetId, secondTarget.id);
  assert.equal(fighter.evasionProjectileId, "threat-b");
  room.drones.delete(secondTarget.id);
  updateDroneEntity(room, fighter, 1 / 30, 130);
  assert.equal(fighter.targetId, null, "an invalid target is dropped immediately before the normal cadence");
}

// Projectile lookup follows add, expiry and removal without stale IDs.
{
  const { room } = carrierRoom();
  const projectile = { ownerId: "red", x: 2000, y: 2000, vx: 0, vy: 0, life: 0.01, damage: 1 };
  addBullet(room, projectile);
  assert.equal(ensureProjectileLookup(room).get(projectile.id), projectile);
  updateBullets(room, 1, 1000);
  assert.equal(room.bullets.length, 0);
  assert.equal(ensureProjectileLookup(room).has(projectile.id), false);
  assert.equal(room.spatialIndex.dynamicValid, false);
}

// Broad phase must preserve the earliest exact shield hit.
{
  const room = {
    players: new Map([["blue", player("blue", "a")], ["red", player("red", "b")]]),
    ships: new Map(),
    drones: new Map(),
    bullets: [],
    effects: [],
    nextEntityId: 1,
    world: { width: 2000, height: 1000 },
    map: { asteroids: [], safeZones: [] },
    rules: { gameMode: "teams" }
  };
  const makeShip = (id, x) => ({
    id, ownerId: "red", alive: true, x, y: 500, vx: 0, vy: 0, angle: 0, radius: 20,
    hp: 100, maxHp: 100, shield: 100, maxShield: 100,
    stats: {}, design: [], componentHp: null
  });
  const near = makeShip("near", 500);
  const far = makeShip("far", 800);
  room.ships.set(near.id, near);
  room.ships.set(far.id, far);
  addBullet(room, { ownerId: "blue", type: "bolt", x: 300, y: 500, vx: 700, vy: 0, life: 2, damage: 20 });
  buildRoomSpatialIndex(room, [near, far], 0);
  updateBullets(room, 1, 1000);
  assert.ok(near.shield < 100, "near shield receives the earliest hit");
  assert.equal(far.shield, 100, "far shield is untouched");
}

// Health telemetry exposes bounded rolling subsystem and entity summaries,
// including construction and encoding rather than only aggregate snapshot time.
{
  recordRoomTick({ durations: {
    botsEconomyLifecycle: 1, powerDemandProtection: 2, movementSeparationMap: 3,
    spatialIndex: 0.5, support: 0.25, drones: 4, weapons: 5,
    projectiles: 6, heat: 2.5, objectives: 0.1
  } });
  recordTick({ simulationMs: 24, cycleMs: 26, eventLoopLagMs: 1, budgetMs: 33.333,
    counts: { ships: 8, drones: 12, bullets: 40, effects: 16 } });
  recordSnapshot({ durationMs: 3, constructionMs: 2, encodingMs: 1, payloadBytes: 1024, maxClientBytes: 512, clients: 2 });
  const telemetry = performanceSnapshot(30);
  assert.equal(telemetry.subsystems.drones.latest, 4);
  assert.equal(telemetry.subsystems.projectiles.p95, 6);
  assert.equal(telemetry.entities.ships.latest, 8);
  assert.equal(telemetry.entities.drones.latest, 12);
  assert.equal(telemetry.entities.bullets.latest, 40);
  assert.equal(telemetry.entities.effects.latest, 16);
  assert.equal(telemetry.snapshot.constructionMs.latest, 2);
  assert.equal(telemetry.snapshot.encodingMs.latest, 1);
}

console.log("Server spatial, drone lifecycle and projectile regression verification passed");
