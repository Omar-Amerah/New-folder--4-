"use strict";

// Deterministic room-level broad phase. Exact range, line and component
// collision checks remain with their owning gameplay systems.
const { BALANCE } = require("./balanceConfig");
const { INCREMENTAL_SPATIAL_INDEX } = require("./performanceFlags");
const { setCounter } = require("./roomTelemetry");
const { performanceNow } = require("./utils");

const DEFAULT_CELL_SIZE = Math.max(64, Number(process.env.MFA_SPATIAL_CELL_SIZE) || 320);
const PROJECTILES = BALANCE.projectiles || {};
const MAX_PROJECTILE_HIT_RADIUS = Math.max(
  Number(PROJECTILES.hitRadius?.default) || 0,
  Number(PROJECTILES.hitRadius?.missile) || 0,
  Number(PROJECTILES.hitRadius?.rail) || 0
);
const KINDS = Object.freeze(["ships", "stations", "drones", "projectiles", "interceptableProjectiles", "asteroids"]);
const DYNAMIC_KINDS = Object.freeze(KINDS.filter((kind) => kind !== "asteroids"));
const MAX_RECORD_POOL = 8192;
const MAX_BUCKET_POOL = 4096;
const MAX_ROW_MAP_POOL = 4096;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function shipBroadPhaseRadius(ship) {
  const radius = Math.max(0, finite(ship?.radius), finite(ship?.physicalRadius));
  const shield = PROJECTILES.shieldCollision || {};
  const shieldRadius = Math.max(
    finite(shield.minimumRadius),
    radius + Math.max(finite(shield.flatPadding), radius * finite(shield.radiusMultiplier))
  );
  return Math.max(radius, shieldRadius) + MAX_PROJECTILE_HIT_RADIUS;
}

function droneBroadPhaseRadius(drone) {
  return Math.max(0, finite(drone?.radius, 10)) + MAX_PROJECTILE_HIT_RADIUS;
}

function stationBroadPhaseRadius(station) {
  const radius = Math.max(0, finite(station?.radius), finite(station?.physicalRadius));
  const shield = PROJECTILES.shieldCollision || {};
  const shieldRadius = Math.max(
    finite(shield.minimumRadius),
    radius + Math.max(finite(shield.flatPadding), radius * finite(shield.radiusMultiplier))
  );
  return Math.max(radius, shieldRadius) + MAX_PROJECTILE_HIT_RADIUS;
}

function isLiveForKind(kind, entity) {
  if (!entity) return false;
  if (kind === "ships") return entity.alive === true && !entity.removed;
  if (kind === "drones") return !entity.destroyed && !entity.removed;
  if (kind === "projectiles") return entity.life > 0;
  if (kind === "interceptableProjectiles") return entity.life > 0 && entity.interceptable;
  if (kind === "stations") return entity.alive !== false && entity.state !== "disabled";
  return true;
}

function createKindState() {
  return {
    // Collision-safe numeric representation: x -> y -> bucket.
    columns: new Map(),
    records: [],
    recordsByEntity: new Map(),
    recordsByEntityId: new Map(),
    recordPool: [],
    bucketPool: [],
    rowMapPool: [],
    nextOrder: 0
  };
}

function makeRecord() {
  return {
    entity: null,
    order: 0,
    queryMark: 0,
    inactive: false,
    x: 0,
    y: 0,
    radius: 0,
    minCellX: 0,
    maxCellX: 0,
    minCellY: 0,
    maxCellY: 0
  };
}

class RoomSpatialIndex {
  constructor(cellSize = DEFAULT_CELL_SIZE) {
    this.cellSize = Math.max(32, finite(cellSize, DEFAULT_CELL_SIZE));
    this.kindState = Object.fromEntries(KINDS.map((kind) => [kind, createKindState()]));
    // Compatibility views retained for diagnostics/tests.
    this.cells = Object.fromEntries(KINDS.map((kind) => [kind, this.kindState[kind].columns]));
    this.records = Object.fromEntries(KINDS.map((kind) => [kind, this.kindState[kind].records]));
    this.recordsByEntity = Object.fromEntries(KINDS.map((kind) => [kind, this.kindState[kind].recordsByEntity]));
    this.querySequence = 0;
    this.maxProjectileSpeed = 0;
    this.builtAt = 0;
    this.dynamicValid = false;
    this.asteroidBuildCount = 0;
    this.queryCount = 0;
    this.querySortCount = 0;
    this.recordAllocations = 0;
    this.bucketAllocations = 0;
    this.rowMapAllocations = 0;
    // Telemetry and diagnostics
    this.spatialFullRebuilds = 0;
    this.spatialPartialRebuilds = 0;
    this.spatialRecoveryRebuilds = 0;
    this.spatialIncrementalInserts = 0;
    this.spatialIncrementalUpdates = 0;
    this.spatialNoOpUpdates = 0;
    this.spatialCellMembershipChanges = 0;
    this.spatialRemovals = 0;
    this.spatialCategoryChanges = 0;
    this.spatialStaleDetections = 0;
    this.spatialUpdateDurationMs = 0;
    this._asteroidMap = null;
    this._asteroidSource = null;
    this._asteroidRevision = null;
  }

  _releaseKind(kind) {
    const state = this.kindState[kind];
    if (!state) return;
    for (const [cx, rows] of state.columns.entries()) {
      for (const [cy, bucket] of rows.entries()) {
        bucket.length = 0;
        if (state.bucketPool.length < MAX_BUCKET_POOL) state.bucketPool.push(bucket);
      }
      rows.clear();
      if (state.rowMapPool.length < MAX_ROW_MAP_POOL) state.rowMapPool.push(rows);
    }
    state.columns.clear();
    for (const record of state.records) {
      record.entity = null;
      record.order = 0;
      record.queryMark = 0;
      record.inactive = true;
      if (state.recordPool.length < MAX_RECORD_POOL) state.recordPool.push(record);
    }
    state.records.length = 0;
    state.recordsByEntity.clear();
    state.recordsByEntityId.clear();
    state.nextOrder = 0;
  }

  reset({ includeAsteroids = false } = {}) {
    for (const kind of DYNAMIC_KINDS) this._releaseKind(kind);
    if (includeAsteroids) {
      this._releaseKind("asteroids");
      this._asteroidMap = null;
      this._asteroidSource = null;
      this._asteroidRevision = null;
    }
    this.maxProjectileSpeed = 0;
    this.builtAt = 0;
    this.dynamicValid = false;
    return this;
  }

  resetTelemetry() {
    this.spatialFullRebuilds = 0;
    this.spatialPartialRebuilds = 0;
    this.spatialRecoveryRebuilds = 0;
    this.spatialIncrementalInserts = 0;
    this.spatialIncrementalUpdates = 0;
    this.spatialNoOpUpdates = 0;
    this.spatialCellMembershipChanges = 0;
    this.spatialRemovals = 0;
    this.spatialCategoryChanges = 0;
    this.spatialStaleDetections = 0;
    this.spatialUpdateDurationMs = 0;
    return this;
  }

  _computeCellBounds(x, y, radius) {
    const r = Math.max(0, finite(radius));
    const minCellX = Math.floor((x - r) / this.cellSize);
    const maxCellX = Math.floor((x + r) / this.cellSize);
    const minCellY = Math.floor((y - r) / this.cellSize);
    const maxCellY = Math.floor((y + r) / this.cellSize);
    return { minCellX, maxCellX, minCellY, maxCellY };
  }

  _ensureRow(state, cx) {
    let rows = state.columns.get(cx);
    if (!rows) {
      rows = state.rowMapPool.pop();
      if (!rows) {
        rows = new Map();
        this.rowMapAllocations += 1;
      }
      state.columns.set(cx, rows);
    }
    return rows;
  }

  _ensureBucket(state, rows, cy) {
    let bucket = rows.get(cy);
    if (!bucket) {
      bucket = state.bucketPool.pop();
      if (!bucket) {
        bucket = [];
        this.bucketAllocations += 1;
      }
      rows.set(cy, bucket);
    }
    return bucket;
  }

  _addRecordToCells(state, record) {
    for (let cx = record.minCellX; cx <= record.maxCellX; cx += 1) {
      const rows = this._ensureRow(state, cx);
      for (let cy = record.minCellY; cy <= record.maxCellY; cy += 1) {
        const bucket = this._ensureBucket(state, rows, cy);
        bucket.push(record);
      }
    }
  }

  _removeRecordFromCells(state, record) {
    for (let cx = record.minCellX; cx <= record.maxCellX; cx += 1) {
      const rows = state.columns.get(cx);
      if (!rows) continue;
      for (let cy = record.minCellY; cy <= record.maxCellY; cy += 1) {
        const bucket = rows.get(cy);
        if (!bucket) continue;
        const i = bucket.indexOf(record);
        if (i >= 0) {
          bucket.splice(i, 1);
          if (bucket.length === 0) {
            rows.delete(cy);
            if (state.bucketPool.length < MAX_BUCKET_POOL) state.bucketPool.push(bucket);
          }
        }
      }
      if (rows.size === 0) {
        state.columns.delete(cx);
        if (state.rowMapPool.length < MAX_ROW_MAP_POOL) state.rowMapPool.push(rows);
      }
    }
  }

  _allocateRecord(state) {
    let record = state.recordPool.pop();
    if (!record) {
      record = makeRecord();
      this.recordAllocations += 1;
    } else {
      record.queryMark = 0;
      record.inactive = false;
    }
    return record;
  }

  _releaseRecord(state, record) {
    record.entity = null;
    record.order = 0;
    record.queryMark = 0;
    record.inactive = true;
    record.x = 0;
    record.y = 0;
    record.radius = 0;
    record.minCellX = 0;
    record.maxCellX = 0;
    record.minCellY = 0;
    record.maxCellY = 0;
    if (state.recordPool.length < MAX_RECORD_POOL) state.recordPool.push(record);
  }

  _removeRecord(state, record) {
    this._removeRecordFromCells(state, record);
    const records = state.records;
    const i = records.indexOf(record);
    if (i >= 0) {
      records[i] = records[records.length - 1];
      records.pop();
    }
    if (record.entity) {
      state.recordsByEntity.delete(record.entity);
      if (record.entity.id !== undefined && record.entity.id !== null) {
        const existing = state.recordsByEntityId.get(record.entity.id);
        if (existing === record) state.recordsByEntityId.delete(record.entity.id);
      }
    }
    this._releaseRecord(state, record);
    this.spatialRemovals += 1;
  }

  _putRecord(kind, entity, radius, order) {
    const state = this.kindState[kind];
    if (!state || !entity) return null;
    const x = finite(entity.x);
    const y = finite(entity.y);
    const r = Math.max(0, finite(radius));
    const bounds = this._computeCellBounds(x, y, r);
    let record = state.recordsByEntity.get(entity);
    if (!record) {
      record = this._allocateRecord(state);
      state.records.push(record);
      state.recordsByEntity.set(entity, record);
    }
    // Enforce one record per entity ID: remove any stale record with the same ID.
    if (entity.id !== undefined && entity.id !== null) {
      const byId = state.recordsByEntityId.get(entity.id);
      if (byId && byId !== record) this._removeRecord(state, byId);
      state.recordsByEntityId.set(entity.id, record);
    }
    record.entity = entity;
    record.order = order;
    record.x = x;
    record.y = y;
    record.radius = r;
    record.minCellX = bounds.minCellX;
    record.maxCellX = bounds.maxCellX;
    record.minCellY = bounds.minCellY;
    record.maxCellY = bounds.maxCellY;
    this._addRecordToCells(state, record);
    state.nextOrder = Math.max(state.nextOrder, (Number.isFinite(Number(order)) ? Number(order) : 0) + 1);
    return record;
  }

  // Authoritative low-level add with explicit order. Used by full rebuilds.
  add(kind, entity, radius = 0, order = 0) {
    const state = this.kindState[kind];
    if (!state || !entity) return null;
    if (state.recordsByEntity.has(entity)) {
      this.update(kind, entity, radius);
      return state.recordsByEntity.get(entity);
    }
    const record = this._putRecord(kind, entity, radius, order);
    if (record) this.spatialIncrementalInserts += 1;
    return record;
  }

  // Stable-order append (for live appends during a tick).
  append(kind, entity, radius = 0) {
    const state = this.kindState[kind];
    if (!state || !entity) return null;
    const existing = state.recordsByEntity.get(entity);
    if (existing) {
      this.update(kind, entity, radius);
      return existing;
    }
    const record = this._putRecord(kind, entity, radius, state.nextOrder++);
    if (record) this.spatialIncrementalInserts += 1;
    return record;
  }

  // Public insert with idempotency. Semantically identical to append.
  insert(kind, entity, radius = 0) {
    const state = this.kindState[kind];
    if (!state || !entity) return null;
    const existing = state.recordsByEntity.get(entity);
    if (existing) {
      this.update(kind, entity, radius);
      return existing;
    }
    const record = this._putRecord(kind, entity, radius, state.nextOrder++);
    if (record) this.spatialIncrementalInserts += 1;
    return record;
  }

  update(kind, entity, radius = 0) {
    const state = this.kindState[kind];
    if (!state || !entity) return false;
    const record = state.recordsByEntity.get(entity);
    if (!record) {
      this.insert(kind, entity, radius);
      return true;
    }
    const x = finite(entity.x);
    const y = finite(entity.y);
    const r = Math.max(0, finite(radius));
    const newBounds = this._computeCellBounds(x, y, r);
    const cellsUnchanged =
      newBounds.minCellX === record.minCellX &&
      newBounds.maxCellX === record.maxCellX &&
      newBounds.minCellY === record.minCellY &&
      newBounds.maxCellY === record.maxCellY;
    record.x = x;
    record.y = y;
    record.radius = r;
    if (cellsUnchanged) {
      this.spatialIncrementalUpdates += 1;
      this.spatialNoOpUpdates += 1;
      return false;
    }
    // Remove from cells that are no longer occupied and add to newly occupied cells.
    for (let cx = record.minCellX; cx <= record.maxCellX; cx += 1) {
      const rows = state.columns.get(cx);
      if (!rows) continue;
      for (let cy = record.minCellY; cy <= record.maxCellY; cy += 1) {
        if (cx >= newBounds.minCellX && cx <= newBounds.maxCellX && cy >= newBounds.minCellY && cy <= newBounds.maxCellY) continue;
        const bucket = rows.get(cy);
        if (!bucket) continue;
        const i = bucket.indexOf(record);
        if (i >= 0) {
          bucket.splice(i, 1);
          if (bucket.length === 0) {
            rows.delete(cy);
            if (state.bucketPool.length < MAX_BUCKET_POOL) state.bucketPool.push(bucket);
          }
        }
      }
      if (rows.size === 0) {
        state.columns.delete(cx);
        if (state.rowMapPool.length < MAX_ROW_MAP_POOL) state.rowMapPool.push(rows);
      }
    }
    for (let cx = newBounds.minCellX; cx <= newBounds.maxCellX; cx += 1) {
      const rows = this._ensureRow(state, cx);
      for (let cy = newBounds.minCellY; cy <= newBounds.maxCellY; cy += 1) {
        if (cx >= record.minCellX && cx <= record.maxCellX && cy >= record.minCellY && cy <= record.maxCellY) continue;
        const bucket = this._ensureBucket(state, rows, cy);
        bucket.push(record);
      }
    }
    record.minCellX = newBounds.minCellX;
    record.maxCellX = newBounds.maxCellX;
    record.minCellY = newBounds.minCellY;
    record.maxCellY = newBounds.maxCellY;
    this.spatialIncrementalUpdates += 1;
    this.spatialCellMembershipChanges += 1;
    return true;
  }

  remove(kind, entity) {
    const state = this.kindState[kind];
    if (!state || !entity) return false;
    const record = state.recordsByEntity.get(entity);
    if (!record) return false;
    this._removeRecord(state, record);
    return true;
  }

  changeKind(oldKind, newKind, entity, radius = 0) {
    if (oldKind === newKind) return this.update(newKind, entity, radius);
    const oldState = this.kindState[oldKind];
    const newState = this.kindState[newKind];
    if (!oldState || !newState || !entity) return false;
    const record = oldState.recordsByEntity.get(entity);
    if (record) this._removeRecord(oldState, record);
    this.insert(newKind, entity, radius);
    this.spatialCategoryChanges += 1;
    return true;
  }

  // Update the positions of a known live collection. Removes stale records
  // (dead, missing, or no longer provided) before refreshing the remainder.
  // Each live record is stamped with a canonical order taken from the
  // collection's iteration so query order is deterministic and matches a
  // full rebuild over the same collection.
  updateLiveEntities(kind, items, radiusFn) {
    const start = performanceNow();
    const state = this.kindState[kind];
    if (!state) return this;
    const live = new Set();
    let order = 0;
    for (const item of items || []) {
      if (!isLiveForKind(kind, item)) continue;
      live.add(item);
      const radius = radiusFn ? radiusFn(item) : 0;
      this.update(kind, item, radius);
      const record = state.recordsByEntity.get(item);
      if (record) record.order = order;
      order += 1;
    }
    for (const [entity, record] of Array.from(state.recordsByEntity.entries())) {
      if (!live.has(entity)) this._removeRecord(state, record);
    }
    state.nextOrder = Math.max(state.nextOrder, order);
    this.spatialUpdateDurationMs += performanceNow() - start;
    return this;
  }

  invalidateDynamic() {
    this.dynamicValid = false;
  }

  _nextQuerySequence() {
    let sequence = this.querySequence + 1;
    if (sequence >= Number.MAX_SAFE_INTEGER) {
      sequence = 1;
      for (const state of Object.values(this.kindState)) {
        for (const record of state.records) record.queryMark = 0;
      }
    }
    this.querySequence = sequence;
    return sequence;
  }

  // Results are written into the caller-supplied `out` buffer so hot paths can
  // reuse scratch across ticks. Callers that omit `out` get a fresh array:
  // sharing one implicit buffer per kind silently clobbered any result still
  // held across a second query of the same kind, which is a trap rather than an
  // optimisation. Every hot call site passes its own scratch explicitly.
  _queryAabb(kind, minX, minY, maxX, maxY, out, ordered) {
    const target = out || [];
    target.length = 0;
    const state = this.kindState[kind];
    if (!state) return target;
    this.queryCount += 1;
    const sequence = this._nextQuerySequence();
    const lowX = Math.min(finite(minX), finite(maxX));
    const highX = Math.max(finite(minX), finite(maxX));
    const lowY = Math.min(finite(minY), finite(maxY));
    const highY = Math.max(finite(minY), finite(maxY));
    const minCellX = Math.floor(lowX / this.cellSize);
    const maxCellX = Math.floor(highX / this.cellSize);
    const minCellY = Math.floor(lowY / this.cellSize);
    const maxCellY = Math.floor(highY / this.cellSize);
    for (let cx = minCellX; cx <= maxCellX; cx += 1) {
      const rows = state.columns.get(cx);
      if (!rows) continue;
      for (let cy = minCellY; cy <= maxCellY; cy += 1) {
        const bucket = rows.get(cy);
        if (!bucket) continue;
        for (const record of bucket) {
          if (record.inactive || !record.entity || record.queryMark === sequence) continue;
          record.queryMark = sequence;
          target.push(record);
        }
      }
    }
    if (ordered && target.length > 1) {
      target.sort((a, b) => a.order - b.order);
      this.querySortCount += 1;
    }
    for (let i = 0; i < target.length; i += 1) target[i] = target[i].entity;
    return target;
  }

  queryAabb(kind, minX, minY, maxX, maxY, out) {
    return this._queryAabb(kind, minX, minY, maxX, maxY, out, true);
  }

  queryAabbUnordered(kind, minX, minY, maxX, maxY, out) {
    return this._queryAabb(kind, minX, minY, maxX, maxY, out, false);
  }

  queryRange(kind, x, y, radius, out) {
    const r = Math.max(0, finite(radius));
    return this.queryAabb(kind, x - r, y - r, x + r, y + r, out);
  }

  queryRangeUnordered(kind, x, y, radius, out) {
    const r = Math.max(0, finite(radius));
    return this.queryAabbUnordered(kind, x - r, y - r, x + r, y + r, out);
  }

  querySweptAabb(kind, x1, y1, x2, y2, padding = 0, out) {
    const p = Math.max(0, finite(padding));
    return this.queryAabb(kind, Math.min(x1, x2) - p, Math.min(y1, y2) - p, Math.max(x1, x2) + p, Math.max(y1, y2) + p, out);
  }

  querySweptAabbUnordered(kind, x1, y1, x2, y2, padding = 0, out) {
    const p = Math.max(0, finite(padding));
    return this.queryAabbUnordered(kind, Math.min(x1, x2) - p, Math.min(y1, y2) - p, Math.max(x1, x2) + p, Math.max(y1, y2) + p, out);
  }

  count(kind) {
    return this.kindState[kind]?.recordsByEntity.size || 0;
  }

  rebuildKind(kind, items, radiusFn, now = 0) {
    if (!KINDS.includes(kind) || kind === "asteroids") return this;
    this._releaseKind(kind);
    if (kind === "ships") this.spatialPartialRebuilds += 1;
    let order = 0;
    const inserted = this.spatialRecordsInsertedByKind || (this.spatialRecordsInsertedByKind = {});
    let count = 0;
    for (const item of items || []) {
      if (!item) continue;
      if (kind === "ships" && !item.alive) continue;
      if (kind === "drones" && (item.destroyed || item.removed)) continue;
      if (kind === "projectiles" && item.life <= 0) continue;
      const radius = radiusFn ? radiusFn(item) : 0;
      this._putRecord(kind, item, radius, order++);
      count += 1;
    }
    inserted[kind] = (inserted[kind] || 0) + count;
    this.builtAt = now;
    this.dynamicValid = true;
    return this;
  }

  rebuild(room, ships, now = 0) {
    const requestedCellSize = Math.max(32, finite(room?.spatialCellSize, DEFAULT_CELL_SIZE));
    if (requestedCellSize !== this.cellSize) {
      this.reset({ includeAsteroids: true });
      this.cellSize = requestedCellSize;
    } else {
      this.reset();
    }

    this.spatialFullRebuilds += 1;
    this.spatialRecordsInsertedByKind = this.spatialRecordsInsertedByKind || {};

    let order = 0;
    const inserted = this.spatialRecordsInsertedByKind;
    inserted.ships = 0;
    inserted.stations = 0;
    inserted.drones = 0;
    inserted.projectiles = 0;
    inserted.interceptableProjectiles = 0;
    for (const ship of ships || []) {
      if (!ship?.alive) continue;
      this._putRecord("ships", ship, shipBroadPhaseRadius(ship), order++);
      inserted.ships += 1;
    }
    let stationOrder = 0;
    for (const station of room?.stations || []) {
      if (!station || station.alive === false || station.state === "disabled") continue;
      this._putRecord("stations", station, stationBroadPhaseRadius(station), stationOrder++);
      inserted.stations += 1;
    }
    order = 0;
    for (const drone of room?.drones?.values?.() || []) {
      if (drone?.destroyed || drone?.removed) continue;
      this._putRecord("drones", drone, droneBroadPhaseRadius(drone), order++);
      inserted.drones += 1;
    }
    order = 0;
    for (const projectile of room?.bullets || []) {
      if (!projectile || projectile.life <= 0) continue;
      const projectileSpeed = Math.hypot(finite(projectile.vx), finite(projectile.vy));
      if (projectileSpeed > this.maxProjectileSpeed) this.maxProjectileSpeed = projectileSpeed;
      this._putRecord("projectiles", projectile, 0, order);
      inserted.projectiles += 1;
      if (projectile.interceptable) {
        this._putRecord("interceptableProjectiles", projectile, 0, order);
        inserted.interceptableProjectiles += 1;
      }
      order += 1;
    }
    this._rebuildAsteroidsIfNeeded(room);
    this.builtAt = now;
    this.dynamicValid = true;
    return this;
  }

  _rebuildAsteroidsIfNeeded(room) {
    const map = room?.map || null;
    const source = map?.asteroids || [];
    const revision = room?.asteroidRevision ?? map?.asteroidRevision ?? map?.revision ?? room?.mapRevision ?? 0;
    if (this._asteroidMap === map && this._asteroidSource === source && this._asteroidRevision === revision) return false;
    this._releaseKind("asteroids");
    let order = 0;
    for (const asteroid of source) {
      this._putRecord("asteroids", asteroid, Math.max(0, finite(asteroid?.radius)), order++);
    }
    this._asteroidMap = map;
    this._asteroidSource = source;
    this._asteroidRevision = revision;
    this.asteroidBuildCount += 1;
    return true;
  }

  recoverFull(room, ships, now = 0) {
    this.spatialRecoveryRebuilds += 1;
    this.spatialStaleDetections += 1;
    return this.rebuild(room, ships, now);
  }

  // Lightweight integrity check suitable for tests and development.
  // `radiusFn` is the authoritative radius helper used to verify stored radii.
  // `expectedSet` is an iterable of live entities that must be present.
  // Returns { ok: boolean, issues: string[], stats: {} }.
  verifyIntegrity(kind = null, radiusFn = null, expectedSet = null) {
    const kinds = kind && KINDS.includes(kind) ? [kind] : KINDS;
    const issues = [];
    const stats = {};
    const expected = expectedSet ? new Set(expectedSet) : null;
    for (const k of kinds) {
      const state = this.kindState[k];
      if (!state) continue;
      const seenEntities = new Set();
      const seenIds = new Set();
      const seenInBuckets = new Set();
      let liveRecords = 0;
      let bucketRecordCount = 0;
      for (const record of state.records) {
        liveRecords += 1;
        if (!record.entity) {
          issues.push(`${k}: record with null entity`);
          continue;
        }
        if (seenEntities.has(record.entity)) {
          issues.push(`${k}: duplicate record object for entity ${record.entity.id}`);
        }
        seenEntities.add(record.entity);
        if (state.recordsByEntity.get(record.entity) !== record) {
          issues.push(`${k}: record for ${record.entity.id} not found in recordsByEntity`);
        }
        if (record.entity.id !== undefined && record.entity.id !== null) {
          if (state.recordsByEntityId.get(record.entity.id) !== record) {
            issues.push(`${k}: record for ${record.entity.id} not found in recordsByEntityId`);
          }
          if (seenIds.has(record.entity.id)) {
            issues.push(`${k}: duplicate entity ID ${record.entity.id}`);
          }
          seenIds.add(record.entity.id);
        }
        if (record.inactive) {
          issues.push(`${k}: inactive record in active list for ${record.entity.id}`);
        }
        if (!isLiveForKind(k, record.entity)) {
          issues.push(`${k}: non-live entity ${record.entity.id} still recorded`);
        }
        const authoritativeRadius = radiusFn ? radiusFn(record.entity) : record.radius;
        if (Math.abs(record.radius - authoritativeRadius) > 1e-9) {
          issues.push(`${k}: stored radius does not match authoritative radius for ${record.entity.id}`);
        }
        const expected = this._computeCellBounds(record.entity.x, record.entity.y, record.radius);
        if (
          record.minCellX !== expected.minCellX ||
          record.maxCellX !== expected.maxCellX ||
          record.minCellY !== expected.minCellY ||
          record.maxCellY !== expected.maxCellY
        ) {
          issues.push(`${k}: cell bounds mismatch for ${record.entity.id}`);
        }
      }
      if (state.records.length !== state.recordsByEntity.size) {
        issues.push(`${k}: active record count ${state.records.length} != recordsByEntity size ${state.recordsByEntity.size}`);
      }
      if (state.recordsByEntity.size !== state.recordsByEntityId.size) {
        issues.push(`${k}: recordsByEntity size ${state.recordsByEntity.size} != recordsByEntityId size ${state.recordsByEntityId.size}`);
      }
      for (const [cx, rows] of state.columns.entries()) {
        for (const [cy, bucket] of rows.entries()) {
          const bucketSeen = new Set();
          for (const record of bucket) {
            bucketRecordCount += 1;
            if (record.inactive || !record.entity) {
              issues.push(`${k}: inactive record in bucket ${cx},${cy}`);
            }
            if (
              cx < record.minCellX || cx > record.maxCellX ||
              cy < record.minCellY || cy > record.maxCellY
            ) {
              issues.push(`${k}: record ${record.entity?.id} in wrong bucket ${cx},${cy}`);
            }
            if (bucketSeen.has(record)) {
              issues.push(`${k}: duplicate bucket entry for ${record.entity?.id} in ${cx},${cy}`);
            }
            bucketSeen.add(record);
            seenInBuckets.add(record);
            // Ensure this bucket membership is in the record's expected cells.
            if (record && (cx < record.minCellX || cx > record.maxCellX || cy < record.minCellY || cy > record.maxCellY)) {
              issues.push(`${k}: bucket ${cx},${cy} not in expected cells for ${record.entity?.id}`);
            }
          }
        }
      }
      // Verify every active record is present in each bucket it should occupy.
      for (const record of state.records) {
        if (!record.entity) continue;
        for (let cx = record.minCellX; cx <= record.maxCellX; cx += 1) {
          const rows = state.columns.get(cx);
          for (let cy = record.minCellY; cy <= record.maxCellY; cy += 1) {
            const bucket = rows?.get(cy);
            if (!bucket || !bucket.includes(record)) {
              issues.push(`${k}: record ${record.entity.id} missing from bucket ${cx},${cy}`);
            }
          }
        }
      }
      for (const entity of state.recordsByEntity.keys()) {
        if (!seenEntities.has(entity)) {
          issues.push(`${k}: recordsByEntity entry without matching active record ${entity.id}`);
        }
      }
      if (expected) {
        for (const entity of expected) {
          if (!state.recordsByEntity.has(entity)) {
            issues.push(`${k}: expected entity ${entity.id} not found in recordsByEntity`);
          }
        }
        for (const record of state.records) {
          if (record.entity && !expected.has(record.entity)) {
            issues.push(`${k}: unexpected record for ${record.entity.id}`);
          }
        }
      }
      stats[k] = {
        liveRecords,
        recordsByEntity: state.recordsByEntity.size,
        recordsByEntityId: state.recordsByEntityId.size,
        buckets: bucketRecordCount,
        columns: state.columns.size
      };
    }
    return { ok: issues.length === 0, issues, stats };
  }
}

function buildRoomSpatialIndex(room, ships, now = 0) {
  if (!room) return new RoomSpatialIndex(DEFAULT_CELL_SIZE).rebuild(null, ships, now);
  const requestedCellSize = Math.max(32, finite(room.spatialCellSize, DEFAULT_CELL_SIZE));
  const isNewIndex = !(room.spatialIndex instanceof RoomSpatialIndex);
  let index = room.spatialIndex;
  if (isNewIndex) {
    index = new RoomSpatialIndex(requestedCellSize);
    room.spatialIndex = index;
  }
  const cellSizeChanged = requestedCellSize !== index.cellSize;
  const incremental = INCREMENTAL_SPATIAL_INDEX();
  if (cellSizeChanged) {
    index.reset({ includeAsteroids: true });
    index.cellSize = requestedCellSize;
    index.resetTelemetry();
    room._spatialTelemetrySnapshot = {};
    room._spatialDurationSnapshot = 0;
    require("./movementContactPairs").clearMovementContactPairs(room);
  } else if (isNewIndex) {
    room._spatialTelemetrySnapshot = {};
    room._spatialDurationSnapshot = 0;
  }
  if (!incremental || !index.dynamicValid || cellSizeChanged) {
    const start = performanceNow();
    index.rebuild(room, ships, now);
    index.spatialUpdateDurationMs += performanceNow() - start;
  }
  return room.spatialIndex;
}

function clearRoomSpatialIndex(room) {
  if (!room) return null;
  require("./movementContactPairs").clearMovementContactPairs(room);
  if (room.spatialIndex instanceof RoomSpatialIndex) {
    room.spatialIndex.reset({ includeAsteroids: true });
    room.spatialIndex.resetTelemetry();
  } else {
    room.spatialIndex = new RoomSpatialIndex(room.spatialCellSize || DEFAULT_CELL_SIZE);
  }
  room._spatialTelemetrySnapshot = {};
  room._spatialDurationSnapshot = 0;
  return room.spatialIndex;
}

// Publish per-tick spatial-index telemetry deltas from the cumulative index
// counters into the room's per-tick telemetry record. Returns the spatial
// duration accumulated since the last call, which callers can fold into
// the main subsystem timing.
function publishSpatialTelemetry(room) {
  const index = room?.spatialIndex;
  if (!(index instanceof RoomSpatialIndex)) return 0;
  const snap = room._spatialTelemetrySnapshot || (room._spatialTelemetrySnapshot = {});
  const counters = [
    "spatialFullRebuilds",
    "spatialPartialRebuilds",
    "spatialRecoveryRebuilds",
    "spatialIncrementalInserts",
    "spatialIncrementalUpdates",
    "spatialNoOpUpdates",
    "spatialCellMembershipChanges",
    "spatialRemovals",
    "spatialCategoryChanges",
    "spatialStaleDetections"
  ];
  for (const c of counters) {
    const current = Number(index[c]) || 0;
    const prev = Number(snap[c]) || 0;
    setCounter(room, c, current - prev);
    snap[c] = current;
  }
  const durationNow = Number(index.spatialUpdateDurationMs) || 0;
  const durationPrev = Number(room._spatialDurationSnapshot) || 0;
  const durationDelta = Math.max(0, durationNow - durationPrev);
  setCounter(room, "spatialUpdateDurationMs", durationDelta);
  room._spatialDurationSnapshot = durationNow;
  return durationDelta;
}

module.exports = {
  DEFAULT_CELL_SIZE,
  RoomSpatialIndex,
  buildRoomSpatialIndex,
  clearRoomSpatialIndex,
  publishSpatialTelemetry,
  shipBroadPhaseRadius,
  stationBroadPhaseRadius,
  droneBroadPhaseRadius
};
