"use strict";

// Deterministic room-level broad phase. Exact range, line and component
// collision checks remain with their owning gameplay systems.
const { BALANCE } = require("./balanceConfig");

const DEFAULT_CELL_SIZE = Math.max(64, Number(process.env.MFA_SPATIAL_CELL_SIZE) || 320);
const PROJECTILES = BALANCE.projectiles || {};
const MAX_PROJECTILE_HIT_RADIUS = Math.max(
  Number(PROJECTILES.hitRadius?.default) || 0,
  Number(PROJECTILES.hitRadius?.missile) || 0,
  Number(PROJECTILES.hitRadius?.rail) || 0
);
const KINDS = Object.freeze(["ships", "drones", "projectiles", "interceptableProjectiles", "asteroids"]);
const DYNAMIC_KINDS = Object.freeze(KINDS.filter((kind) => kind !== "asteroids"));
const MAX_RECORD_POOL = 8192;
const MAX_BUCKET_POOL = 4096;
const MAX_ROW_MAP_POOL = 4096;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function shipBroadPhaseRadius(ship) {
  const radius = Math.max(0, finite(ship?.radius));
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

function createKindState() {
  return {
    // Collision-safe numeric representation: x -> y -> bucket.
    columns: new Map(),
    records: [],
    recordsByEntity: new Map(),
    recordPool: [],
    bucketPool: [],
    rowMapPool: [],
    nextOrder: 0
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
    this.queryBuffers = Object.fromEntries(KINDS.map((kind) => [kind, []]));
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
    this._asteroidMap = null;
    this._asteroidSource = null;
    this._asteroidRevision = null;
  }

  _releaseKind(kind) {
    const state = this.kindState[kind];
    if (!state) return;
    for (const rows of state.columns.values()) {
      for (const bucket of rows.values()) {
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
    state.nextOrder = 0;
    this.queryBuffers[kind].length = 0;
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

  rebuild(room, ships, now = 0) {
    const requestedCellSize = Math.max(32, finite(room?.spatialCellSize, DEFAULT_CELL_SIZE));
    if (requestedCellSize !== this.cellSize) {
      this.reset({ includeAsteroids: true });
      this.cellSize = requestedCellSize;
    } else {
      this.reset();
    }

    let order = 0;
    for (const ship of ships || []) {
      if (!ship?.alive) continue;
      this.add("ships", ship, shipBroadPhaseRadius(ship), order++);
    }
    order = 0;
    for (const drone of room?.drones?.values?.() || []) {
      if (drone?.destroyed || drone?.removed) continue;
      this.add("drones", drone, droneBroadPhaseRadius(drone), order++);
    }
    order = 0;
    for (const projectile of room?.bullets || []) {
      if (!projectile || projectile.life <= 0) continue;
      const projectileSpeed = Math.hypot(finite(projectile.vx), finite(projectile.vy));
      if (projectileSpeed > this.maxProjectileSpeed) this.maxProjectileSpeed = projectileSpeed;
      this.add("projectiles", projectile, 0, order);
      if (projectile.interceptable) this.add("interceptableProjectiles", projectile, 0, order);
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
      this.add("asteroids", asteroid, Math.max(0, finite(asteroid?.radius)), order++);
    }
    this._asteroidMap = map;
    this._asteroidSource = source;
    this._asteroidRevision = revision;
    this.asteroidBuildCount += 1;
    return true;
  }

  add(kind, entity, radius = 0, order = 0) {
    const state = this.kindState[kind];
    if (!state || !entity) return null;
    let record = state.recordPool.pop();
    if (!record) {
      record = { entity: null, order: 0, queryMark: 0, inactive: false };
      this.recordAllocations += 1;
    }
    record.entity = entity;
    record.order = order;
    record.queryMark = 0;
    record.inactive = false;
    state.records.push(record);
    state.recordsByEntity.set(entity, record);
    state.nextOrder = Math.max(state.nextOrder, (Number.isFinite(Number(order)) ? Number(order) : 0) + 1);

    const x = finite(entity.x);
    const y = finite(entity.y);
    const r = Math.max(0, finite(radius));
    const minCellX = Math.floor((x - r) / this.cellSize);
    const maxCellX = Math.floor((x + r) / this.cellSize);
    const minCellY = Math.floor((y - r) / this.cellSize);
    const maxCellY = Math.floor((y + r) / this.cellSize);
    for (let cx = minCellX; cx <= maxCellX; cx += 1) {
      let rows = state.columns.get(cx);
      if (!rows) {
        rows = state.rowMapPool.pop();
        if (!rows) {
          rows = new Map();
          this.rowMapAllocations += 1;
        }
        state.columns.set(cx, rows);
      }
      for (let cy = minCellY; cy <= maxCellY; cy += 1) {
        let bucket = rows.get(cy);
        if (!bucket) {
          bucket = state.bucketPool.pop();
          if (!bucket) {
            bucket = [];
            this.bucketAllocations += 1;
          }
          rows.set(cy, bucket);
        }
        bucket.push(record);
      }
    }
    return record;
  }

  append(kind, entity, radius = 0) {
    const state = this.kindState[kind];
    if (!state) return null;
    return this.add(kind, entity, radius, state.nextOrder);
  }

  remove(kind, entity) {
    const state = this.kindState[kind];
    const record = state?.recordsByEntity.get(entity);
    if (!record) return false;
    record.inactive = true;
    state.recordsByEntity.delete(entity);
    return true;
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

  _queryAabb(kind, minX, minY, maxX, maxY, out, ordered) {
    const target = out || this.queryBuffers[kind] || [];
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
}

function buildRoomSpatialIndex(room, ships, now = 0) {
  if (!room) return new RoomSpatialIndex(DEFAULT_CELL_SIZE).rebuild(null, ships, now);
  let index = room.spatialIndex;
  const requestedCellSize = Math.max(32, finite(room.spatialCellSize, DEFAULT_CELL_SIZE));
  if (!(index instanceof RoomSpatialIndex)) index = new RoomSpatialIndex(requestedCellSize);
  room.spatialIndex = index.rebuild(room, ships, now);
  return room.spatialIndex;
}

function clearRoomSpatialIndex(room) {
  if (!room) return null;
  if (room.spatialIndex instanceof RoomSpatialIndex) room.spatialIndex.reset({ includeAsteroids: true });
  else room.spatialIndex = new RoomSpatialIndex(room.spatialCellSize || DEFAULT_CELL_SIZE);
  return room.spatialIndex;
}

module.exports = {
  DEFAULT_CELL_SIZE,
  RoomSpatialIndex,
  buildRoomSpatialIndex,
  clearRoomSpatialIndex,
  shipBroadPhaseRadius,
  droneBroadPhaseRadius
};
