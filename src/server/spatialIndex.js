"use strict";

// One deterministic room-level broad phase. Exact range, line and component
// collision checks remain with their owning gameplay systems; this index only
// removes entities that cannot possibly participate.
const { BALANCE } = require("./balanceConfig");

const DEFAULT_CELL_SIZE = Math.max(64, Number(process.env.MFA_SPATIAL_CELL_SIZE) || 320);
const PROJECTILES = BALANCE.projectiles || {};
const MAX_PROJECTILE_HIT_RADIUS = Math.max(
  Number(PROJECTILES.hitRadius?.default) || 0,
  Number(PROJECTILES.hitRadius?.missile) || 0,
  Number(PROJECTILES.hitRadius?.rail) || 0
);
const KINDS = Object.freeze(["ships", "drones", "projectiles", "interceptableProjectiles", "asteroids"]);

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

function cellKey(x, y) {
  return `${x},${y}`;
}

class RoomSpatialIndex {
  constructor(cellSize = DEFAULT_CELL_SIZE) {
    this.cellSize = Math.max(32, finite(cellSize, DEFAULT_CELL_SIZE));
    this.cells = Object.fromEntries(KINDS.map((kind) => [kind, new Map()]));
    this.records = Object.fromEntries(KINDS.map((kind) => [kind, []]));
    this.recordsByEntity = Object.fromEntries(KINDS.map((kind) => [kind, new Map()]));
    this.querySequence = 0;
    this.maxProjectileSpeed = 0;
    this.builtAt = 0;
  }

  add(kind, entity, radius = 0, order = 0) {
    const grid = this.cells[kind];
    if (!grid || !entity) return;
    const x = finite(entity.x);
    const y = finite(entity.y);
    const r = Math.max(0, finite(radius));
    const record = { entity, order, queryMark: 0 };
    this.records[kind].push(record);
    this.recordsByEntity[kind].set(entity, record);
    const minCellX = Math.floor((x - r) / this.cellSize);
    const maxCellX = Math.floor((x + r) / this.cellSize);
    const minCellY = Math.floor((y - r) / this.cellSize);
    const maxCellY = Math.floor((y + r) / this.cellSize);
    for (let cy = minCellY; cy <= maxCellY; cy += 1) {
      for (let cx = minCellX; cx <= maxCellX; cx += 1) {
        const key = cellKey(cx, cy);
        let bucket = grid.get(key);
        if (!bucket) {
          bucket = [];
          grid.set(key, bucket);
        }
        bucket.push(record);
      }
    }
  }

  remove(kind, entity) {
    const record = this.recordsByEntity[kind]?.get(entity);
    if (!record) return false;
    record.inactive = true;
    this.recordsByEntity[kind].delete(entity);
    return true;
  }

  queryAabb(kind, minX, minY, maxX, maxY, out = []) {
    out.length = 0;
    const grid = this.cells[kind];
    if (!grid) return out;
    let sequence = this.querySequence + 1;
    if (sequence >= Number.MAX_SAFE_INTEGER) {
      sequence = 1;
      for (const records of Object.values(this.records)) {
        for (const record of records) record.queryMark = 0;
      }
    }
    this.querySequence = sequence;
    const lowX = Math.min(finite(minX), finite(maxX));
    const highX = Math.max(finite(minX), finite(maxX));
    const lowY = Math.min(finite(minY), finite(maxY));
    const highY = Math.max(finite(minY), finite(maxY));
    const minCellX = Math.floor(lowX / this.cellSize);
    const maxCellX = Math.floor(highX / this.cellSize);
    const minCellY = Math.floor(lowY / this.cellSize);
    const maxCellY = Math.floor(highY / this.cellSize);
    for (let cy = minCellY; cy <= maxCellY; cy += 1) {
      for (let cx = minCellX; cx <= maxCellX; cx += 1) {
        const bucket = grid.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (const record of bucket) {
          if (record.inactive || record.queryMark === sequence) continue;
          record.queryMark = sequence;
          out.push(record);
        }
      }
    }
    // Cell traversal is coordinate ordered, not insertion ordered. Restore the
    // authoritative collection order so callers without an explicit tie-break
    // retain their old deterministic first-match behaviour.
    out.sort((a, b) => a.order - b.order);
    for (let i = 0; i < out.length; i += 1) out[i] = out[i].entity;
    return out;
  }

  queryRange(kind, x, y, radius, out = []) {
    const r = Math.max(0, finite(radius));
    return this.queryAabb(kind, x - r, y - r, x + r, y + r, out);
  }

  querySweptAabb(kind, x1, y1, x2, y2, padding = 0, out = []) {
    const p = Math.max(0, finite(padding));
    return this.queryAabb(
      kind,
      Math.min(x1, x2) - p,
      Math.min(y1, y2) - p,
      Math.max(x1, x2) + p,
      Math.max(y1, y2) + p,
      out
    );
  }

  count(kind) {
    return this.records[kind]?.length || 0;
  }
}

function buildRoomSpatialIndex(room, ships, now = 0) {
  const index = new RoomSpatialIndex(room?.spatialCellSize || DEFAULT_CELL_SIZE);
  let order = 0;
  for (const ship of ships || []) {
    if (!ship?.alive) continue;
    index.add("ships", ship, shipBroadPhaseRadius(ship), order++);
  }
  order = 0;
  for (const drone of room?.drones?.values?.() || []) {
    if (drone?.destroyed) continue;
    index.add("drones", drone, droneBroadPhaseRadius(drone), order++);
  }
  order = 0;
  const projectileById = room.projectileById || new Map();
  projectileById.clear();
  for (const projectile of room?.bullets || []) {
    if (!projectile || projectile.life <= 0) continue;
    if (projectile.id) projectileById.set(projectile.id, projectile);
    const projectileSpeed = Math.sqrt(finite(projectile.vx) ** 2 + finite(projectile.vy) ** 2);
    if (projectileSpeed > index.maxProjectileSpeed) index.maxProjectileSpeed = projectileSpeed;
    index.add("projectiles", projectile, 0, order);
    if (projectile.interceptable) index.add("interceptableProjectiles", projectile, 0, order);
    order += 1;
  }
  room.projectileById = projectileById;
  order = 0;
  for (const asteroid of room?.map?.asteroids || []) {
    index.add("asteroids", asteroid, Math.max(0, finite(asteroid?.radius)), order++);
  }
  index.builtAt = now;
  room.spatialIndex = index;
  return index;
}

function clearRoomSpatialIndex(room) {
  if (room) room.spatialIndex = null;
}

module.exports = {
  DEFAULT_CELL_SIZE,
  RoomSpatialIndex,
  buildRoomSpatialIndex,
  clearRoomSpatialIndex,
  shipBroadPhaseRadius,
  droneBroadPhaseRadius
};
