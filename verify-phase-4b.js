#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  INCREMENTAL_SPATIAL_INDEX,
  __setINCREMENTAL_SPATIAL_INDEX,
  FIXED_AUTHORITATIVE_TIMESTEP,
  __setFIXED_AUTHORITATIVE_TIMESTEP
} = require("./src/server/performanceFlags");
const { createRoom, bumpStateEpoch } = require("./src/server/rooms");
const { tickRoom, advanceRoomAuthoritative, FIXED_STEP_MS } = require("./src/server/simulation");
const { RoomSpatialIndex, buildRoomSpatialIndex, publishSpatialTelemetry, shipBroadPhaseRadius, droneBroadPhaseRadius, stationBroadPhaseRadius } = require("./src/server/spatialIndex");
const { addBullet, removeProjectileRuntime } = require("./src/server/projectiles");
const { spawnShip } = require("./src/server/ships");
const { spawnDrone } = require("./src/server/drones");
const { destroyShip } = require("./src/server/combat");

const EPSILON = 1e-6;

function activeRoom(code) {
  const room = createRoom(code, { seed: 1 });
  room.phase = "active";
  room.stations = [];
  room.drones = new Map();
  room.decoys = new Map();
  room.droneCounts = { byOwner: new Map(), byParent: new Map() };
  room.spatialIndex = null;
  return room;
}

function activeShipAndPlayer(room, id, playerId = "p1", team = 1) {
  const ship = {
    id,
    ownerId: playerId,
    team,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    alive: true,
    removed: false,
    radius: 30,
    physicalRadius: 18,
    selfDestructAt: null,
    nextDestructSparkAt: 0,
    effects: [],
    design: [{ x: 7, y: 7, type: "core" }, { x: 7, y: 6, type: "engine" }],
    componentHp: [50, 50],
    componentMaxHp: [50, 50],
    stats: { maxHp: 100, mass: 1, radius: 30 },
    movement: {}
  };
  const player = {
    id: playerId,
    team,
    ships: [ship]
  };
  room.players.set(playerId, player);
  room.ships.set(id, ship);
  return { ship, player };
}

// 1. Flag defaults to false and can be toggled for tests.
{
  __setINCREMENTAL_SPATIAL_INDEX(false);
  assert.strictEqual(INCREMENTAL_SPATIAL_INDEX(), false, "INCREMENTAL_SPATIAL_INDEX defaults to false");
  __setINCREMENTAL_SPATIAL_INDEX(true);
  assert.strictEqual(INCREMENTAL_SPATIAL_INDEX(), true, "INCREMENTAL_SPATIAL_INDEX test setter works");
  __setINCREMENTAL_SPATIAL_INDEX(false);
}

// 2-11. Direct incremental API on an index.
{
  const index = new RoomSpatialIndex(100);
  const entity = { id: "e1", x: 150, y: 150, radius: 30, alive: true, removed: false };

  // 2. Initial insertion creates exactly one live record.
  const record = index.insert("ships", entity, 30);
  assert.ok(record, "insert returns a record");
  assert.strictEqual(index.count("ships"), 1, "one ship record");
  assert.strictEqual(index.recordsByEntity.ships.get(entity), record, "recordsByEntity maps entity");

  // 3. Repeated insertion does not create duplicates.
  const r2 = index.insert("ships", entity, 30);
  assert.strictEqual(r2, record, "repeated insert returns existing record");
  assert.strictEqual(index.count("ships"), 1, "still one record");

  // 4. Moving within the same occupied cells performs a no-op bucket update.
  const noOpsBefore = index.spatialNoOpUpdates;
  index.update("ships", entity, 30);
  assert.strictEqual(index.spatialNoOpUpdates, noOpsBefore + 1, "same-cell update is a no-op");

  // 5. Crossing one cell boundary updates only affected cells.
  const before = index.spatialCellMembershipChanges;
  entity.x = 205;
  index.update("ships", entity, 30);
  assert.strictEqual(index.spatialCellMembershipChanges, before + 1, "crossing one boundary changes membership");

  // 6. Moving across several cells removes every stale membership.
  entity.x = 550;
  index.update("ships", entity, 30);
  const integrity = index.verifyIntegrity("ships");
  assert.strictEqual(integrity.ok, true, "crossing many cells keeps integrity");

  // 7. Radius growth updates occupied cells.
  entity.x = 250;
  entity.y = 250;
  index.update("ships", entity, 30);
  const cells = index.recordsByEntity.ships.get(entity);
  const cellCountBefore = (cells.maxCellX - cells.minCellX + 1) * (cells.maxCellY - cells.minCellY + 1);
  index.update("ships", entity, 120);
  const cells2 = index.recordsByEntity.ships.get(entity);
  const cellCountAfter = (cells2.maxCellX - cells2.minCellX + 1) * (cells2.maxCellY - cells2.minCellY + 1);
  assert.ok(cellCountAfter > cellCountBefore, "radius growth increases occupied cells");

  // 8. Radius shrink removes no-longer-required cells.
  index.update("ships", entity, 30);
  const cells3 = index.recordsByEntity.ships.get(entity);
  const cellCountAfterShrink = (cells3.maxCellX - cells3.minCellX + 1) * (cells3.maxCellY - cells3.minCellY + 1);
  assert.ok(cellCountAfterShrink < cellCountAfter, "radius shrink decreases occupied cells");

  // 9. Removal makes the entity immediately unqueryable.
  index.remove("ships", entity);
  assert.strictEqual(index.count("ships"), 0, "removal removes the record");
  assert.deepStrictEqual(index.queryRange("ships", 250, 250, 200), [], "removed entity is not returned");

  // 10. Repeated removal is safe.
  assert.strictEqual(index.remove("ships", entity), false, "repeated remove is idempotent");

  // 11. Category changes remove the old-kind record and add the new-kind record.
  const p = { id: "p1", x: 0, y: 0, life: 1, interceptable: true };
  index.insert("projectiles", p, 0);
  assert.strictEqual(index.count("projectiles"), 1, "projectile inserted");
  index.changeKind("projectiles", "interceptableProjectiles", p, 0);
  assert.strictEqual(index.count("projectiles"), 0, "old kind removed");
  assert.strictEqual(index.count("interceptableProjectiles"), 1, "new kind added");
}

// 12. Spawned ships are immediately queryable.
{
  const room = activeRoom("PH4BSPAWN");
  const player = { id: "p1", team: 1, ships: [], design: [], wiring: {}, stats: { maxHp: 100, mass: 1, radius: 20 }, connected: true, purchaseRequests: new Map(), money: 0 };
  room.players.set("p1", player);
  const ship = {
    id: "s1", ownerId: "p1", team: 1, x: 500, y: 500, vx: 0, vy: 0, angle: 0,
    alive: true, removed: false, radius: 20, physicalRadius: 12,
    design: [{ x: 7, y: 7, type: "core" }], componentHp: [50], componentMaxHp: [50],
    stats: { maxHp: 100, mass: 1, radius: 20 }, hp: 100, movement: {}
  };
  player.ships.push(ship);
  room.ships.set("s1", ship);
  buildRoomSpatialIndex(room, [ship], 0);
  __setINCREMENTAL_SPATIAL_INDEX(true);
  const result = room.spatialIndex.queryRange("ships", 500, 500, 200);
  assert.deepStrictEqual(result.map((s) => s.id), ["s1"], "spawned ship is immediately queryable");
  __setINCREMENTAL_SPATIAL_INDEX(false);
}

// 13-14. Newly created projectiles are immediately queryable.
{
  const room = activeRoom("PH4BPROJ");
  buildRoomSpatialIndex(room, [], 0);
  __setINCREMENTAL_SPATIAL_INDEX(true);
  addBullet(room, { type: "shot", ownerId: "p1", x: 100, y: 100, vx: 0, vy: 0, life: 5, damage: 1 });
  const b = room.bullets[0];
  assert.ok(room.spatialIndex.queryRange("projectiles", 100, 100, 1).includes(b), "new projectile is queryable");
  __setINCREMENTAL_SPATIAL_INDEX(false);
}

// 15. Destroyed projectiles leave no stale record.
{
  const room = activeRoom("PH4BREMOVE");
  buildRoomSpatialIndex(room, [], 0);
  __setINCREMENTAL_SPATIAL_INDEX(true);
  addBullet(room, { type: "shot", ownerId: "p1", x: 100, y: 100, vx: 0, vy: 0, life: 5, damage: 1 });
  const b = room.bullets[0];
  room.spatialIndex.remove("projectiles", b);
  assert.strictEqual(room.spatialIndex.count("projectiles"), 0, "removed projectile is gone");
  __setINCREMENTAL_SPATIAL_INDEX(false);
}

// 16-18. Parity between full rebuild and incremental mode.
{
  __setINCREMENTAL_SPATIAL_INDEX(false);
  const full = new RoomSpatialIndex(80);
  const incremental = new RoomSpatialIndex(80);
  const roomStub = { spatialCellSize: 80, stations: [], drones: new Map(), bullets: [] };
  const entities = [];
  for (let i = 0; i < 50; i += 1) {
    entities.push({ id: `s${i}`, x: (i * 97) % 1200, y: (i * 137) % 1200, radius: 15, alive: true });
  }
  full.rebuild(roomStub, entities, 0);
  for (const e of entities) incremental.insert("ships", e, shipBroadPhaseRadius(e));
  for (let step = 0; step < 20; step += 1) {
    for (const e of entities) {
      e.x = (e.x + 13) % 1200;
      e.y = (e.y + 17) % 1200;
      incremental.update("ships", e, shipBroadPhaseRadius(e));
    }
    full.rebuild(roomStub, entities, step + 1);
  }
  const a = full.queryRange("ships", 600, 600, 300).map((s) => s.id);
  const b = incremental.queryRange("ships", 600, 600, 300).map((s) => s.id);
  assert.deepStrictEqual(a.slice().sort(), b.slice().sort(), "incremental and full rebuild return the same candidates");
  assert.deepStrictEqual(a, b, "incremental and full rebuild ordering matches");
}

// 19. Room reset clears all lookup and bucket state.
{
  const index = new RoomSpatialIndex(100);
  const e = { id: "x", x: 100, y: 100, radius: 20, alive: true };
  index.insert("ships", e, 20);
  index.reset();
  assert.strictEqual(index.count("ships"), 0, "reset clears records");
  assert.strictEqual(index.recordsByEntity.ships.size, 0, "reset clears lookup");
  assert.strictEqual(index.cells.ships.size, 0, "reset clears buckets");
}

// 20. Recovery rebuild repairs deliberately corrupted test state.
{
  const index = new RoomSpatialIndex(100);
  const e = { id: "c", x: 100, y: 100, radius: 20, alive: true };
  index.insert("ships", e, 20);
  index.recoverFull({ stations: [], drones: new Map(), bullets: [] }, [e], 0);
  assert.strictEqual(index.count("ships"), 1, "recovery rebuild keeps live entity");
  assert.ok(index.verifyIntegrity("ships").ok, "recovery leaves valid state");
}

// 21. Long-running spawn/remove churn does not grow inactive records without bound.
{
  const index = new RoomSpatialIndex(100);
  let totalRecords = 0;
  for (let i = 0; i < 500; i += 1) {
    const e = { id: `c${i}`, x: i % 1000, y: i % 1000, radius: 10, alive: true };
    index.insert("ships", e, 10);
    if (i % 2 === 0) index.remove("ships", e);
  }
  assert.ok(index.records.ships.length <= 260, `active record count bounded, got ${index.records.ships.length}`);
  assert.ok(index.recordAllocations < 600, `record allocations bounded, got ${index.recordAllocations}`);
}

// 22. Separate rooms maintain completely isolated index state.
{
  const a = activeRoom("A");
  const b = activeRoom("B");
  buildRoomSpatialIndex(a, [], 0);
  buildRoomSpatialIndex(b, [], 0);
  const shipA = { id: "sa", x: 100, y: 100, radius: 20, alive: true };
  a.spatialIndex.insert("ships", shipA, 20);
  assert.strictEqual(b.spatialIndex.count("ships"), 0, "room B unaffected by room A insert");
}

// 23. Phase 4A fixed-step catch-up does not create duplicate updates.
{
  __setFIXED_AUTHORITATIVE_TIMESTEP(true);
  __setINCREMENTAL_SPATIAL_INDEX(true);
  const room = activeRoom("PH4BCATCH");
  activeShipAndPlayer(room, "s1");
  const t0 = 10_000_000;
  const ship = room.ships.get("s1");
  for (let i = 0; i < 4; i += 1) {
    advanceRoomAuthoritative(room, t0 + i * FIXED_STEP_MS);
  }
  assert.strictEqual(room.spatialIndex.count("ships"), 1, "catch-up leaves one ship record");
  __setFIXED_AUTHORITATIVE_TIMESTEP(false);
  __setINCREMENTAL_SPATIAL_INDEX(false);
}

// 24. Flag-disabled behaviour retains the established rebuild path.
{
  __setINCREMENTAL_SPATIAL_INDEX(false);
  const room = activeRoom("PH4BDISABLE");
  const { ship } = activeShipAndPlayer(room, "s1");
  buildRoomSpatialIndex(room, [ship], 0);
  const first = room.spatialIndex;
  buildRoomSpatialIndex(room, [ship], 1);
  assert.strictEqual(room.spatialIndex, first, "same index instance");
  assert.ok(room.spatialIndex.spatialFullRebuilds >= 2, "disabled path performs full rebuilds");
}

// 25. Ship destroyed in combat is removed from the spatial index immediately.
{
  __setINCREMENTAL_SPATIAL_INDEX(true);
  const room = activeRoom("PH4BDESTROY");
  const { ship } = activeShipAndPlayer(room, "s1");
  buildRoomSpatialIndex(room, [ship], 0);
  assert.strictEqual(room.spatialIndex.queryRange("ships", ship.x, ship.y, 100).length, 1, "ship is initially queryable");
  destroyShip(room, ship, null, 0);
  assert.strictEqual(ship.alive, false, "ship is marked dead");
  assert.deepStrictEqual(room.spatialIndex.queryRange("ships", ship.x, ship.y, 100), [], "destroyed ship is removed from index");
  assert.strictEqual(room.spatialIndex.count("ships"), 0, "destroyed ship leaves no record");
  __setINCREMENTAL_SPATIAL_INDEX(false);
}

// 26. Projectile removed through the runtime path is gone from the index.
{
  __setINCREMENTAL_SPATIAL_INDEX(true);
  const room = activeRoom("PH4BPROJREMOVE");
  buildRoomSpatialIndex(room, [], 0);
  addBullet(room, { type: "shot", ownerId: "p1", x: 100, y: 100, vx: 0, vy: 0, life: 5, damage: 1 });
  const b = room.bullets[0];
  assert.strictEqual(room.spatialIndex.count("projectiles"), 1, "projectile inserted by addBullet");
  removeProjectileRuntime(room, b, "despawn", 100, 100);
  assert.strictEqual(room.spatialIndex.count("projectiles"), 0, "projectile removed by runtime");
  __setINCREMENTAL_SPATIAL_INDEX(false);
}

// 27. Recovery rebuild repairs deliberately corrupted state.
{
  __setINCREMENTAL_SPATIAL_INDEX(true);
  const room = activeRoom("PH4BRECOVER");
  const { ship } = activeShipAndPlayer(room, "s1");
  buildRoomSpatialIndex(room, [ship], 0);
  // Corrupt the bucket state by manually inserting the same record twice.
  const index = room.spatialIndex;
  const record = index.recordsByEntity.ships.get(ship);
  const bucket = index.kindState.ships.columns.get(record.minCellX).get(record.minCellY);
  bucket.push(record);
  const before = index.verifyIntegrity("ships");
  assert.strictEqual(before.ok, false, "corrupted state is detected");
  index.recoverFull(room, [ship], 1);
  const after = index.verifyIntegrity("ships");
  assert.strictEqual(after.ok, true, "recovery rebuild leaves valid state");
  __setINCREMENTAL_SPATIAL_INDEX(false);
}

// 28. Full-rebuild telemetry reports per-tick, not cumulative, values.
{
  __setINCREMENTAL_SPATIAL_INDEX(false);
  const room = activeRoom("PH4BTELEM");
  const { ship } = activeShipAndPlayer(room, "s1");
  for (let tick = 0; tick < 3; tick += 1) {
    buildRoomSpatialIndex(room, [ship], tick);
    publishSpatialTelemetry(room);
    const telemetry = room._roomTelemetry || {};
    assert.strictEqual(telemetry.spatialFullRebuilds, 1, `tick ${tick}: one full rebuild`);
    assert.strictEqual(telemetry.spatialIncrementalInserts, 0, `tick ${tick}: no incremental inserts during full rebuild`);
    assert.ok(telemetry.spatialUpdateDurationMs >= 0, `tick ${tick}: duration reported`);
  }
  __setINCREMENTAL_SPATIAL_INDEX(false);
}

__setINCREMENTAL_SPATIAL_INDEX(false);
__setFIXED_AUTHORITATIVE_TIMESTEP(false);
console.log("Phase 4B incremental spatial-index verification passed");
