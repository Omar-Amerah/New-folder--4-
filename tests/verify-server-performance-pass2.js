#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { RoomSpatialIndex, buildRoomSpatialIndex, clearRoomSpatialIndex } = require("../src/server/spatialIndex");
const {
  addBullet,
  ensureProjectileLookup,
  assertProjectileLookupConsistency,
  removeProjectilesByOwner,
  resetProjectileRuntime,
  updateBullets
} = require("../src/server/projectiles");
const { getShipCollisionGeometry } = require("../src/server/componentGeometry");
const { markShipRepairCacheDirty } = require("../src/server/repairCache");
const Relationships = require("../src/server/relationships");
const { findPointDefenseTarget } = require("../src/server/combat");
const {
  CONFIG: DRONE_CONFIG,
  bayWorldPose,
  _test: { spawnDrone, resolveDroneSeparation }
} = require("../src/server/drones");
const { createRoom } = require("../src/server/rooms");
const { broadcastSnapshot } = require("../src/server/snapshotDelivery");
const { configureOutbound } = require("../src/server/outbound");
const { decodeBinary } = require("../src/server/wsCodec");
const { BALANCE } = require("../src/server/balanceConfig");

function player(id, team) {
  return { id, name: id, team, ships: [], design: [], dataLinks: [], connected: true, money: 0, earned: 0, maxMoney: 1000, kills: 0, losses: 0, captures: 0 };
}

function runtimeRoom() {
  return {
    phase: "active",
    players: new Map([["blue", player("blue", "a")], ["red", player("red", "b")]]),
    ships: new Map(),
    drones: new Map(),
    decoys: new Map(),
    bullets: [],
    projectileById: new Map(),
    _projectileLookupInitialized: true,
    effects: [],
    nextEntityId: 1,
    world: { width: 4000, height: 4000 },
    map: { revision: 1, asteroidRevision: 1, asteroids: [], safeZones: [] },
    points: [],
    rules: { gameMode: "teams" },
    clients: new Set()
  };
}

function ship(id, ownerId, x, y, design = [{ x: 7, y: 7, type: "frame" }]) {
  return {
    id, ownerId, alive: true, x, y, angle: 0, radius: 25,
    vx: 0, vy: 0, hp: 100, maxHp: 100, shield: 0, maxShield: 0,
    design, designRevision: 1,
    componentHp: design.map(() => 100),
    componentMaxHp: design.map(() => 100),
    componentHeatState: design.map(() => 0),
    dirtyComponents: new Set(),
    stats: {}
  };
}

// One index object survives repeated rebuilds, while removed records and query
// marks never leak into later ticks.
{
  const room = runtimeRoom();
  const index = new RoomSpatialIndex(100);
  room.spatialIndex = index;
  let rowMapAllocationsAfterWarmup = 0;
  for (let tick = 0; tick < 250; tick += 1) {
    const a = ship(`a-${tick}`, "blue", 100 + tick, 100);
    const b = ship(`b-${tick}`, "red", 300, 100 + tick);
    room.ships = new Map([[a.id, a], [b.id, b]]);
    const rebuilt = buildRoomSpatialIndex(room, [a, b], tick);
    assert.equal(rebuilt, index);
    const ids = rebuilt.queryRange("ships", a.x, a.y, 2).map((item) => item.id);
    assert.equal(ids.includes(a.id), true);
    assert.equal(ids.some((id) => id.endsWith(`-${tick - 1}`)), false);
    rebuilt.remove("ships", a);
    assert.equal(rebuilt.queryRange("ships", a.x, a.y, 2).includes(a), false);
    if (tick === 0) rowMapAllocationsAfterWarmup = index.rowMapAllocations;
  }
  assert.ok(index.kindState.ships.recordPool.length <= 8192);
  assert.equal(index.rowMapAllocations, rowMapAllocationsAfterWarmup,
    "dynamic rebuilds reuse empty column row Maps after warm-up");
  clearRoomSpatialIndex(room);
  assert.equal(room.spatialIndex, index);
  assert.equal(index.count("ships"), 0);
  assert.deepEqual(index.queryRange("ships", 0, 0, 10000), []);
  assert.ok(index.kindState.ships.rowMapPool.length > 0);
  assert.ok(index.kindState.ships.rowMapPool.length <= 4096);
}

// Ordered queries retain authoritative insertion order; unordered queries may
// traverse differently but contain the same candidates and resolve the same
// explicit distance/ID decision.
{
  const index = new RoomSpatialIndex(100);
  const entities = [
    { id: "z", x: 190, y: 10 },
    { id: "a", x: 10, y: 190 },
    { id: "m", x: 110, y: 110 }
  ];
  entities.forEach((entity, order) => index.add("drones", entity, 0, order));
  assert.deepEqual(index.queryRange("drones", 100, 100, 200, []).map((item) => item.id), ["z", "a", "m"]);
  const unordered = index.queryRangeUnordered("drones", 100, 100, 200, []);
  assert.deepEqual(unordered.map((item) => item.id).sort(), ["a", "m", "z"]);
  const choose = (items) => items.reduce((best, item) => {
    const distance = (item.x - 100) ** 2 + (item.y - 100) ** 2;
    if (!best || distance < best.distance || (distance === best.distance && item.id < best.item.id)) return { item, distance };
    return best;
  }, null).item.id;
  assert.equal(choose(index.queryRange("drones", 100, 100, 200, [])), choose(unordered));
  assert.ok(index.querySortCount >= 1);
  index.remove("drones", entities[0]);
  const appended = { id: "late", x: 100, y: 100 };
  index.append("drones", appended, 0);
  assert.deepEqual(
    index.queryRange("drones", 100, 100, 200, []).map((item) => item.id),
    ["a", "m", "late"],
    "an appended entity stays after surviving records even when an earlier record was removed"
  );
}

// Entities created after the tick index build are appended in authoritative
// collection order, so later same-tick consumers see them immediately.
{
  const room = runtimeRoom();
  room.spatialCellSize = 64;
  const index = buildRoomSpatialIndex(room, [], 0);
  const first = {
    ownerId: "red",
    type: "missile",
    interceptable: true,
    targetId: "blue-carrier",
    x: 400,
    y: 500,
    vx: -100,
    vy: 0,
    life: 3,
    hp: 20,
    damage: 10
  };
  const second = {
    ownerId: "red",
    type: "missile",
    interceptable: true,
    targetId: "blue-carrier",
    x: 700,
    y: 500,
    vx: -100,
    vy: 0,
    life: 3,
    hp: 20,
    damage: 10
  };
  addBullet(room, first);
  addBullet(room, second);
  assert.deepEqual(
    index.queryRange("interceptableProjectiles", 550, 500, 500, []).map((item) => item.id),
    room.bullets.map((item) => item.id),
    "same-tick projectile records retain authoritative bullet-array order"
  );
  const acquired = findPointDefenseTarget(
    room,
    100,
    500,
    "blue",
    { range: 1000, targetPriority: ["missile"] },
    [],
    "blue-carrier"
  );
  assert.equal(acquired?.entity, first,
    "point defence running after a launcher acquires its same-tick missile");
}

// A drone launched after the index build participates in same-tick ordered
// queries and deterministic separation.
{
  const room = runtimeRoom();
  room.spatialCellSize = 64;
  const design = [{ x: 7, y: 7, type: "droneBay", droneType: "fighter" }];
  const carrier = ship("blue-carrier", "blue", 500, 500, design);
  carrier.team = "a";
  carrier.componentPower = { byComponentIndex: [{ operationalMultiplier: 1 }] };
  const bay = {
    componentIndex: 0,
    componentId: "bay:0",
    droneType: "fighter",
    mode: "deployed",
    nextLaunchAt: 0,
    launchEdge: { centerX: 7.5, centerY: 6.5, dx: 0, dy: -1 },
    slots: Array.from({ length: DRONE_CONFIG.squadSize }, (_, slot) => ({
      slot,
      state: "ready",
      droneId: null,
      productionProgress: 1,
      pauseReason: null
    }))
  };
  carrier.droneBays = [bay];
  room.ships.set(carrier.id, carrier);
  const pose = bayWorldPose(carrier, bay);
  const existing = {
    id: "d0",
    ownerId: "blue",
    parentShipId: carrier.id,
    bayComponentId: bay.componentId,
    slot: 1,
    type: "fighter",
    x: pose.x,
    y: pose.y,
    vx: 0,
    vy: 0,
    radius: 10,
    hull: 45,
    state: "active",
    destroyed: false,
    removed: false
  };
  room.drones.set(existing.id, existing);
  room.nextEntityId = 1;
  const index = buildRoomSpatialIndex(room, [carrier], 0);
  const launched = spawnDrone(room, carrier, bay, bay.slots[0], 1);
  assert.ok(launched);
  assert.deepEqual(
    index.queryRange("drones", pose.x, pose.y, 40, []).map((item) => item.id),
    [...room.drones.keys()],
    "same-tick drone records retain authoritative Map order"
  );
  resolveDroneSeparation(room.drones.values(), [], index, 0);
  assert.ok(Math.hypot(launched.x - existing.x, launched.y - existing.y) >= 21.999,
    "the newly launched drone participates in same-tick separation");
}

// Static asteroids survive dynamic rebuilds and rebuild only on a new map,
// asteroid array, or explicit revision.
{
  const room = runtimeRoom();
  const rock = { id: "rock-1", x: 500, y: 500, radius: 30 };
  room.map.asteroids = [rock];
  const index = buildRoomSpatialIndex(room, [], 1);
  const firstBuilds = index.asteroidBuildCount;
  for (let tick = 2; tick < 30; tick += 1) buildRoomSpatialIndex(room, [], tick);
  assert.equal(index.asteroidBuildCount, firstBuilds);
  assert.equal(index.queryRange("asteroids", 500, 500, 50).includes(rock), true);
  const replacement = { id: "rock-2", x: 900, y: 900, radius: 20 };
  room.map.asteroids = [replacement];
  room.map.asteroidRevision += 1;
  buildRoomSpatialIndex(room, [], 30);
  assert.equal(index.asteroidBuildCount, firstBuilds + 1);
  assert.equal(index.queryRange("asteroids", 500, 500, 50).includes(rock), false);
  assert.equal(index.queryRange("asteroids", 900, 900, 50).includes(replacement), true);
}

// Projectile lookup remains exact across creation, invalidation, expiry,
// owner cleanup, impact and room reset.
{
  const room = runtimeRoom();
  room.assertProjectileLookup = true;
  const expired = { ownerId: "blue", x: 100, y: 100, vx: 0, vy: 0, life: 0.01, damage: 1 };
  const invalid = { ownerId: "blue", x: NaN, y: 100, vx: 0, vy: 0, life: 2, damage: 1 };
  addBullet(room, expired);
  addBullet(room, invalid);
  updateBullets(room, 1, 1);
  assert.equal(room.bullets.length, 0);
  assertProjectileLookupConsistency(room);

  const owned = { ownerId: "blue", x: 200, y: 200, vx: 0, vy: 0, life: 2, damage: 1 };
  const other = { ownerId: "red", x: 300, y: 300, vx: 0, vy: 0, life: 2, damage: 1 };
  addBullet(room, owned);
  addBullet(room, other);
  removeProjectilesByOwner(room, "blue");
  assert.deepEqual(room.bullets, [other]);
  assert.equal(ensureProjectileLookup(room).has(owned.id), false);
  assertProjectileLookupConsistency(room);
  resetProjectileRuntime(room);
  assert.equal(room.bullets.length, 0);
  assert.equal(room.projectileById.size, 0);

  const targetShip = ship("impact-target", "red", 500, 500);
  targetShip.design = [];
  targetShip.componentHp = null;
  targetShip.componentMaxHp = null;
  targetShip.shield = 100;
  targetShip.maxShield = 100;
  room.ships.set(targetShip.id, targetShip);
  addBullet(room, { ownerId: "blue", type: "bolt", x: 300, y: 500, vx: 300, vy: 0, life: 2, damage: 5 });
  updateBullets(room, 1, 2);
  assert.equal(room.bullets.length, 0, "impact removes projectile from the live array");
  assert.equal(room.projectileById.size, 0, "impact removes projectile from lookup");

  const missile = { ownerId: "red", type: "missile", x: 1000, y: 1000, vx: 0, vy: 0, life: 2, damage: 8, hp: 2, interceptable: true };
  addBullet(room, missile);
  addBullet(room, {
    ownerId: "blue", type: "pdShot", pdTargetType: "projectile", pdTargetId: missile.id,
    x: 1000, y: 1000, vx: 0, vy: 0, life: 2, damage: 5
  });
  updateBullets(room, 1 / 30, 3);
  assert.equal(room.bullets.length, 0, "interception compacts a target already written to the kept buffer");
  assert.equal(room.projectileById.size, 0, "interception removes both projectile IDs immediately");
}

// Projectile broad-phase queries cover the authoritative displacement measured
// after drone steering and separation, even when it exceeds nominal speed.
{
  const room = runtimeRoom();
  room.spatialCellSize = 32;
  const drone = {
    id: "displaced-drone",
    ownerId: "red",
    parentShipId: "red-carrier",
    type: "fighter",
    x: 80,
    y: 500,
    vx: 0,
    vy: 0,
    radius: 10,
    hull: 50,
    maxHull: 50,
    state: "active",
    destroyed: false,
    removed: false
  };
  room.drones.set(drone.id, drone);
  addBullet(room, {
    ownerId: "blue",
    type: "bolt",
    x: 200,
    y: 500,
    vx: 600,
    vy: 0,
    life: 2,
    damage: 10
  });
  const index = buildRoomSpatialIndex(room, [], 0);

  drone.x = 220;
  room.droneSpatialPadding = 142;
  const maximumDroneSpeed = Math.max(
    0,
    ...Object.values(BALANCE.drones?.types || {}).map((entry) => Number(entry?.speed) || 0)
  );
  const nominalPadding = maximumDroneSpeed * (1 / 30) * 1.75 + 2;
  assert.equal(
    index.querySweptAabbUnordered("drones", 200, 500, 220, 500, nominalPadding, []).includes(drone),
    false,
    "nominal speed padding alone cannot see the drone at its post-separation position"
  );
  assert.equal(
    index.querySweptAabbUnordered("drones", 200, 500, 220, 500, room.droneSpatialPadding, []).includes(drone),
    true
  );

  updateBullets(room, 1 / 30, 33);
  assert.equal(drone.hull, 40, "the swept projectile still hits the displaced drone");
  assert.equal(room.bullets.length, 0);
}

// World geometry reuses objects within a ship but invalidates computed values
// after movement, rotation, health revision and design replacement.
{
  const target = ship("geometry", "red", 500, 500, [
    { x: 7, y: 7, type: "frame" },
    { x: 8, y: 7, type: "frame" }
  ]);
  let geometry = getShipCollisionGeometry(target);
  const cache = geometry;
  const point = geometry.worldCells[1][0];
  const original = { x: point.x, y: point.y };
  target.x += 20;
  geometry = getShipCollisionGeometry(target);
  assert.equal(geometry, cache);
  assert.equal(geometry.worldCells[1][0], point);
  assert.notEqual(point.x, original.x);
  target.angle = Math.PI / 2;
  const beforeRotationY = point.y;
  getShipCollisionGeometry(target);
  assert.notEqual(point.y, beforeRotationY);
  target.componentHp[1] = 0;
  markShipRepairCacheDirty(target);
  assert.deepEqual(getShipCollisionGeometry(target).liveComponentIndices, [0]);
  target.design = [{ x: 6, y: 7, type: "frame" }];
  target.componentHp = [100];
  target.componentMaxHp = [100];
  target.designRevision += 1;
  assert.equal(getShipCollisionGeometry(target).worldCells.length, 1);
}

// Relationship entries are invalidated explicitly and also self-validate
// against direct team/player changes.
{
  const room = runtimeRoom();
  assert.equal(Relationships.areEnemies(room, "blue", "red"), true);
  room.players.get("red").team = "a";
  assert.equal(Relationships.areEnemies(room, "blue", "red"), false);
  assert.equal(Relationships.areAllies(room, "blue", "red"), true);
  Relationships.invalidateRelationshipCache(room);
  room.players.delete("red");
  assert.equal(Relationships.areAllies(room, "blue", "red"), false);
}

// Strict snapshot grouping reuses one encoded Buffer only for clients with
// identical identity/visibility/baseline/telemetry context.
{
  const room = createRoom("P2SNAP", { seed: 12345 });
  const p1 = player("p1", "blue");
  const p2 = player("p2", "red");
  room.players.set(p1.id, p1);
  room.players.set(p2.id, p2);
  const makeClient = (id, ownedPlayer) => ({
    id,
    player: ownedPlayer,
    room,
    socket: { destroyed: false, writes: [], write() { return true; } },
    telemetryFocusShipId: null
  });
  const c1 = makeClient("c1", p1);
  const c2 = makeClient("c2", p1);
  configureOutbound({ writeFrame(socket, payload) { socket.writes.push(payload); return true; } });
  room.clients = new Set([c1, c2]);
  broadcastSnapshot(room, 1000, true);
  assert.equal(c1.socket.writes.length, 1);
  assert.equal(c2.socket.writes.length, 1);
  assert.equal(c1.socket.writes[0], c2.socket.writes[0], "identical recipients share the encoded Buffer");
  assert.deepEqual(decodeBinary(c1.socket.writes[0]), decodeBinary(c2.socket.writes[0]));

  const encodedBeforeMutation = decodeBinary(c1.socket.writes[0]);
  room.points[0].progress = 0.75;
  assert.deepEqual(decodeBinary(c1.socket.writes[0]), encodedBeforeMutation, "encoded payload is detached from reused runtime arrays");

  const c3 = makeClient("c3", p2);
  c1.socket.writes.length = 0;
  c3.socket.writes.length = 0;
  class UnfingerprintableRevisionMap extends Map {
    entries() {
      throw new Error("unique-player revision maps must not be fingerprinted");
    }
  }
  for (const client of [c1, c3]) {
    client.knownShipDesignRevisions = new UnfingerprintableRevisionMap([["sentinel", 1]]);
    client.knownShipPowerRevisions = new UnfingerprintableRevisionMap([["sentinel", 1]]);
  }
  room.clients = new Set([c1, c3]);
  broadcastSnapshot(room, 1100, true);
  assert.notEqual(c1.socket.writes[0], c3.socket.writes[0], "different visibility identities are never grouped");
  assert.equal(room._lastSnapshotDeliveryMetrics.groups, 2, "unique players keep independent snapshot groups");
  for (const client of [c1, c3]) {
    client.knownShipDesignRevisions = new Map(client.knownShipDesignRevisions);
    client.knownShipPowerRevisions = new Map(client.knownShipPowerRevisions);
  }

  c1.socket.writes.length = 0;
  c2.socket.writes.length = 0;
  const currentSeq = room.snapshotSeq;
  c1.snapshotBaseline = {
    stateEpoch: room.stateEpoch,
    lastWrittenSeq: currentSeq,
    lastWrittenFullSeq: currentSeq,
    fullRequired: false,
    staticRevisionKnown: room.staticRevision
  };
  c2.snapshotBaseline = {
    stateEpoch: room.stateEpoch,
    lastWrittenSeq: 0,
    lastWrittenFullSeq: 0,
    fullRequired: true,
    staticRevisionKnown: 0
  };
  room.clients = new Set([c1, c2]);
  broadcastSnapshot(room, 1200, false);
  assert.notEqual(c1.socket.writes[0], c2.socket.writes[0], "different baselines are never grouped");
  assert.notEqual(decodeBinary(c1.socket.writes[0]).snapshotKind, decodeBinary(c2.socket.writes[0]).snapshotKind);
}

console.log("Second-pass server performance regressions passed");
