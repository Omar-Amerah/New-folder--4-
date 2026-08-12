// Projectile creation, velocity updates, tracking missile adjustments, obstacle collisions, and damage delivery.

const { clampNumber, rotateToward, fastHypot, compareIdStrings, performanceNow, round } = require("./utils");
const { gameplayNow } = require("./gameplayTime");
const { bump, recordDuration, setCounter } = require("./roomTelemetry");
const {
  recordProjectileSpawn,
  recordProjectileRemove,
  recordProjectileReason,
  resetProjectileReplication
} = require("./projectileReplication");
const { getShipCollisionGeometry, COMPONENT_CELL_COLLISION_RADIUS, MODULE_SCALE, ensureProjectileCollisionGrid } = require("./componentGeometry");
const { getLiveShips } = require("./ships");
const { buildRoomSpatialIndex } = require("./spatialIndex");
const Relationships = require("./relationships");
const {
  segmentStationHullHit,
  nearestStationHullPoint,
  stationShieldCollisionRadius,
  stationAttackPoint
} = require("./stationCollision");
const { BALANCE } = require("./balanceConfig");
const PROJECTILES = BALANCE.projectiles;
const MISSILE_GUIDANCE = BALANCE.missileGuidance;
const MAXIMUM_DRONE_SPEED = Math.max(
  0,
  ...Object.values(BALANCE.drones?.types || {}).map((entry) => Number(entry?.speed) || 0)
);

function projectileDroneStepToken(room, now) {
  return room?._currentAuthoritativeStepTimeMs
    ?? room?._simulationStep
    ?? now;
}

function liveDroneCount(room) {
  let count = 0;
  for (const drone of room?.drones?.values?.() || []) {
    if (drone && !drone.destroyed && !drone.removed) count += 1;
  }
  return count;
}

function fullScanDroneCandidates(room, out = []) {
  out.length = 0;
  for (const drone of room?.drones?.values?.() || []) out.push(drone);
  return out;
}

function ensureProjectileDroneSpatialIndex(room, liveShips, now) {
  if (!room || room.disableSpatialIndex) return null;
  let index = room.spatialIndex;
  const expectedDrones = liveDroneCount(room);
  const categoryValid = index?.dynamicValid && typeof index.count === "function"
    ? index.count("drones") === expectedDrones
    : Boolean(index?.dynamicValid && expectedDrones === 0);
  if (categoryValid) return index;

  const stepToken = projectileDroneStepToken(room, now);
  if (room._droneSpatialRecoveryStep === stepToken) {
    // A recovered drone category remains authoritative for the remainder of
    // this step, so reuse it without a second rebuild.
    return index && typeof index.count === "function" && index.count("drones") === expectedDrones
      ? index
      : null;
  }
  room._droneSpatialRecoveryStep = stepToken;
  const startedAt = performanceNow();
  if (index && typeof index.recoverFull === "function") {
    index.recoverFull(room, liveShips, now);
  } else {
    index = buildRoomSpatialIndex(room, liveShips, now);
  }
  bump(room, "projectileDroneIndexRecoveryBuilds");
  recordDuration(room, "projectileDroneRecoveryMs", startedAt);
  return room.spatialIndex?.dynamicValid ? room.spatialIndex : null;
}

function ensureProjectileLookup(room) {
  if (!room.projectileById) {
    room.projectileById = new Map();
  }
  if (!room._projectileLookupInitialized) {
    room.projectileById.clear();
    for (const projectile of room.bullets || []) {
      if (projectile?.id && projectile.life > 0) room.projectileById.set(projectile.id, projectile);
    }
    room._projectileLookupInitialized = true;
  }
  return room.projectileById;
}

function rebuildProjectileLookup(room) {
  const lookup = room.projectileById || new Map();
  lookup.clear();
  for (const projectile of room.bullets || []) if (projectile?.id) lookup.set(projectile.id, projectile);
  room.projectileById = lookup;
  room._projectileLookupInitialized = true;
  return lookup;
}

function resetProjectileRuntime(room) {
  if (Array.isArray(room.bullets)) room.bullets.length = 0;
  else room.bullets = [];
  room._projectileSpare?.splice?.(0);
  room._projectileLiveShipScratch?.splice?.(0);
  room._effectSpare?.splice?.(0);
  if (room.projectileById instanceof Map) room.projectileById.clear();
  else room.projectileById = new Map();
  room._projectileLookupInitialized = true;
  room._droneSpatialRecoveryStep = null;
  resetProjectileReplication(room, room.stateEpoch || 1);
}

function removeProjectilesByOwner(room, ownerId) {
  const source = room.bullets || [];
  const kept = room._projectileSpare && room._projectileSpare !== source ? room._projectileSpare : [];
  kept.length = 0;
  for (const projectile of source) {
    if (projectile.ownerId === ownerId) {
      removeProjectileRuntime(room, projectile, "ownerRemoved", projectile.x, projectile.y);
    } else {
      kept.push(projectile);
    }
  }
  source.length = 0;
  room.bullets = kept;
  room._projectileSpare = source;
}

function addBullet(room, bullet) {
  bullet.id = `b${room.nextEntityId++}`;
  room.bullets.push(bullet);
  bump(room, "projectilesCreated");
  bullet.bornAt = bullet.bornAt == null ? gameplayNow(room, performanceNow()) : bullet.bornAt;
  bullet.lastCorrectionAt = bullet.bornAt;
  recordProjectileSpawn(room, bullet, bullet.bornAt);
  ensureProjectileLookup(room).set(bullet.id, bullet);
  const spatialIndex = room.spatialIndex;
  if (spatialIndex?.dynamicValid && typeof spatialIndex.append === "function" && bullet.life > 0) {
    spatialIndex.append("projectiles", bullet, 0);
    if (bullet.interceptable) spatialIndex.append("interceptableProjectiles", bullet, 0);
    const vx = Number(bullet.vx);
    const vy = Number(bullet.vy);
    const speed = fastHypot(Number.isFinite(vx) ? vx : 0, Number.isFinite(vy) ? vy : 0);
    if (speed > spatialIndex.maxProjectileSpeed) spatialIndex.maxProjectileSpeed = speed;
  }
}

function discardBullet(room, lookup, bullet) {
  if (bullet?.id) lookup.delete(bullet.id);
  bump(room, "projectilesRemoved");
  if (bullet && bullet.id && !bullet._removeEventEmitted) {
    bullet._removeEventEmitted = true;
    const reason = bullet._removeReason || "despawn";
    const x = Number.isFinite(bullet._removeX) ? bullet._removeX : bullet.x;
    const y = Number.isFinite(bullet._removeY) ? bullet._removeY : bullet.y;
    recordProjectileRemove(room, bullet, reason, performanceNow(), x, y);
  }
  room.spatialIndex?.remove?.("projectiles", bullet);
  if (bullet?.interceptable) room.spatialIndex?.remove?.("interceptableProjectiles", bullet);
}

function removeProjectileRuntime(room, projectile, reason = "despawn", finalX, finalY) {
  if (!room || !projectile) return false;
  recordProjectileReason(projectile, reason, finalX, finalY);
  projectile.life = 0;
  discardBullet(room, ensureProjectileLookup(room), projectile);
  return true;
}

function assertProjectileLookupConsistency(room) {
  const lookup = ensureProjectileLookup(room);
  const live = new Map();
  for (const projectile of room.bullets || []) {
    if (projectile?.id && projectile.life > 0) live.set(projectile.id, projectile);
  }
  if (lookup.size !== live.size) {
    throw new Error(`projectileById size mismatch: lookup=${lookup.size}, live=${live.size}`);
  }
  for (const [id, projectile] of live) {
    if (lookup.get(id) !== projectile) throw new Error(`projectileById stale or missing record: ${id}`);
  }
  return true;
}

// Below this shield charge the shield is treated as "down" for hit visuals only:
// bullets flash on the hull instead of the shield bubble. This is purely cosmetic
// (a trickle of shield regen otherwise keeps a depleted shield fractionally above
// zero); damageShip's shield/hull damage split is unaffected.
const SHIELD_HIT_MIN = PROJECTILES.shieldHitMinimum;

function isEmpProjectile(bullet) {
  return bullet?.type === "emp";
}

function projectileHitRadius(bullet) {
  if (Number.isFinite(bullet?.radius) && bullet.radius > 0) return bullet.radius;
  return bullet?.type === "missile" ? PROJECTILES.hitRadius.missile : bullet?.type === "rail" ? PROJECTILES.hitRadius.rail : PROJECTILES.hitRadius.default;
}

function projectileHullBroadPhaseRadius(ship) {
  return Math.max(
    0,
    Number(ship?.radius) || 0,
    Number(ship?.physicalRadius) || 0
  );
}

// Shield bubble radius used for projectile collision — must match the client's
// rendered shield ring (renderer.js shieldRingRadius) so bullets visually stop
// exactly at the ring the player sees.
function shieldCollisionRadius(ship) {
  if (ship?.entityType === "station") return stationShieldCollisionRadius(ship);
  return getShipCollisionGeometry(ship).shieldRadius;
}

function projectileMapImpact(room, x1, y1, bullet, spatialIndex = room.spatialIndex, scratch = []) {
  const margin = isEmpProjectile(bullet) ? projectileHitRadius(bullet) : bullet.type === "missile" ? PROJECTILES.mapImpactMargins.missile : bullet.type === "rail" ? PROJECTILES.mapImpactMargins.rail : PROJECTILES.mapImpactMargins.default;
  let hit = null;
  if (spatialIndex) {
    bump(room, "projectileSpatialQueries");
    bump(room, "asteroidQueries");
  }
  const asteroids = spatialIndex
    ? spatialIndex.querySweptAabbUnordered("asteroids", x1, y1, bullet.x, bullet.y, margin, scratch)
    : (room.map?.asteroids || []);
  bump(room, "projectileCandidateAsteroids", asteroids.length);
  for (const asteroid of asteroids) {
    const impact = segmentCircleHit(x1, y1, bullet.x, bullet.y, asteroid.x, asteroid.y, asteroid.radius + margin);
    if (!impact) continue;
    if (!hit || impact.t < hit.t) hit = impact;
  }
  return hit;
}

const GRID_SIZE = 15;
const GRID_CENTER = 7;

function worldToLocal(ship, wx, wy) {
  const dx = wx - ship.x;
  const dy = wy - ship.y;
  const c = Math.cos(ship.angle || 0);
  const s = Math.sin(ship.angle || 0);
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

function findGridComponentHit(ship, x1, y1, x2, y2, hitRadius) {
  const grid = ensureProjectileCollisionGrid(ship);
  if (!grid) return { hit: null, componentCellTests: 0, gridCellsVisited: 0, gridOccupiedCells: 0 };
  const a = worldToLocal(ship, x1, y1);
  const b = worldToLocal(ship, x2, y2);

  const ax = a.y / MODULE_SCALE + GRID_CENTER;
  const ay = GRID_CENTER - a.x / MODULE_SCALE;
  const bx = b.y / MODULE_SCALE + GRID_CENTER;
  const by = GRID_CENTER - b.x / MODULE_SCALE;
  const dgx = bx - ax;
  const dgy = by - ay;

  const geometry = getShipCollisionGeometry(ship);
  const componentHp = ship.componentHp;
  const cellCoords = geometry.worldCells;

  const scratch = grid.candidateScratch;
  const token = ++scratch.epoch;
  if (token >= 0x7FFFFFFF) {
    scratch.epoch = 1;
    scratch.seen.fill(0);
  }
  const seen = scratch.seen;
  const candidates = scratch.candidates;
  candidates.length = 0;

  const cellSeen = grid.cellVisitEpoch;
  let cellToken = grid.cellVisitToken + 1;
  if (cellToken >= 0x7FFFFFFF) {
    cellToken = 1;
    cellSeen.fill(0);
  }
  grid.cellVisitToken = cellToken;

  let gridCellsVisited = 0;
  let gridOccupiedCells = 0;
  const componentCount = grid.componentCount;

  function addCell(gx, gy) {
    if (gx < 0 || gx >= GRID_SIZE || gy < 0 || gy >= GRID_SIZE) return;
    const cellKey = gy * GRID_SIZE + gx;
    const firstVisit = cellSeen[cellKey] !== cellToken;
    if (firstVisit) {
      cellSeen[cellKey] = cellToken;
      gridCellsVisited += 1;
    }
    const occupants = grid.cellOccupants[cellKey];
    if (!occupants || occupants.length === 0) return;
    if (firstVisit) gridOccupiedCells += 1;
    for (let k = 0; k < occupants.length; k += 1) {
      const componentIndex = occupants[k].componentIndex;
      if (componentIndex >= componentCount) continue;
      if (seen[componentIndex] !== token) {
        seen[componentIndex] = token;
        candidates.push(componentIndex);
      }
    }
  }

  const startX = Math.round(ax);
  const startY = Math.round(ay);
  const endX = Math.round(bx);
  const endY = Math.round(by);
  const padCells = Math.min(GRID_SIZE, Math.ceil((COMPONENT_CELL_COLLISION_RADIUS + hitRadius) / MODULE_SCALE));

  if (Math.abs(dgx) < 1e-9 && Math.abs(dgy) < 1e-9) {
    for (let dy = -padCells; dy <= padCells; dy += 1) {
      for (let dx = -padCells; dx <= padCells; dx += 1) {
        addCell(startX + dx, startY + dy);
      }
    }
  } else {
    const stepX = dgx >= 0 ? 1 : -1;
    const stepY = dgy >= 0 ? 1 : -1;
    const tDeltaX = dgx === 0 ? Infinity : 1 / Math.abs(dgx);
    const tDeltaY = dgy === 0 ? Infinity : 1 / Math.abs(dgy);
    const fracX = ax - (startX - 0.5);
    const fracY = ay - (startY - 0.5);
    let tMaxX = dgx === 0 ? Infinity : (stepX > 0 ? (1 - fracX) : fracX) / Math.abs(dgx);
    let tMaxY = dgy === 0 ? Infinity : (stepY > 0 ? (1 - fracY) : fracY) / Math.abs(dgy);
    let ix = startX;
    let iy = startY;
    const maxSteps = Math.abs(endX - startX) + Math.abs(endY - startY) + 4;
    let steps = 0;
    while (steps < maxSteps) {
      for (let dy = -padCells; dy <= padCells; dy += 1) {
        for (let dx = -padCells; dx <= padCells; dx += 1) {
          addCell(ix + dx, iy + dy);
        }
      }
      if (ix === endX && iy === endY) break;
      if (tMaxX < tMaxY) {
        ix += stepX;
        tMaxX += tDeltaX;
      } else if (tMaxY < tMaxX) {
        iy += stepY;
        tMaxY += tDeltaY;
      } else {
        ix += stepX;
        iy += stepY;
        tMaxX += tDeltaX;
        tMaxY += tDeltaY;
      }
      steps += 1;
    }
  }

  let moduleHit = null;
  let componentCellTests = 0;
  for (let cIndex = 0; cIndex < candidates.length; cIndex += 1) {
    const i = candidates[cIndex];
    if (componentHp && componentHp[i] <= 0) continue;
    const cells = cellCoords[i];
    componentCellTests += cells.length;
    for (let c = 0; c < cells.length; c += 1) {
      const cell = cells[c];
      const hit = segmentCircleHit(x1, y1, x2, y2, cell.x, cell.y, COMPONENT_CELL_COLLISION_RADIUS + hitRadius);
      if (hit && (!moduleHit || hit.t < moduleHit.t || (hit.t === moduleHit.t && i < moduleHit.index))) {
        moduleHit = { ...hit, index: i };
      }
    }
  }
  return { hit: moduleHit, componentCellTests, gridCellsVisited, gridOccupiedCells };
}

function segmentCircleHit(x1, y1, x2, y2, cx, cy, radius) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 0.0001) {
    const ox = x1 - cx;
    const oy = y1 - cy;
    return ox * ox + oy * oy <= radius * radius ? { x: x1, y: y1, t: 0 } : null;
  }

  const t = clampNumber(((cx - x1) * dx + (cy - y1) * dy) / lengthSq, 0, 1);
  const px = x1 + dx * t;
  const py = y1 + dy * t;
  const ox = px - cx;
  const oy = py - cy;
  if (ox * ox + oy * oy > radius * radius) return null;
  return { x: px, y: py, t };
}

function missileEcmModifier(room, target, cache) {
  if (room.drones?.get?.(target.id) === target) return 1;
  let mod = cache.get(target.id);
  if (mod === undefined) {
    const { effectiveComponentBonus } = require("./heat");
    const ecm = Math.max(0, 1 - Math.min(MISSILE_GUIDANCE.ecmCap, effectiveComponentBonus(target, "ecmStrength")));
    const { getCommandAuraMultiplier } = require("./commandAuras");
    const resistance = getCommandAuraMultiplier(target, "missileTrackingResistanceMultiplier");
    mod = Math.max(0, ecm / resistance);
    cache.set(target.id, mod);
  }
  return mod;
}

function updateBullets(room, dt, now) {
  const { areEnemies, damageShip } = require("./combat");
  const { damageStation } = require("./stationCombat");
  const { applyEmpShieldDisruption } = require("./empCannon");
  const { recordFlakMetrics } = require("./performanceTelemetry");

  const liveShips = getLiveShips(
    room,
    room._projectileLiveShipScratch || (room._projectileLiveShipScratch = [])
  );
  const spatialIndex = ensureProjectileDroneSpatialIndex(room, liveShips, now);
  const bulletsById = ensureProjectileLookup(room);
  const sourceBullets = room.bullets || [];
  const kept = room._projectileSpare && room._projectileSpare !== sourceBullets ? room._projectileSpare : [];
  kept.length = 0;
  const scratch = room._projectileSpatialScratch || (room._projectileSpatialScratch = {
    asteroids: [], ships: [], stations: [], drones: [], interceptableProjectiles: []
  });
  const asteroidCandidates = scratch.asteroids;
  const shipCandidates = scratch.ships;
  const droneCandidates = scratch.drones;
  const nominalDroneMovementPadding = MAXIMUM_DRONE_SPEED * Math.max(0, Number(dt) || 0) * 1.75 + 2;
  const measuredDroneMovementPadding = Number(room.droneSpatialPadding);
  const droneMovementPadding = Math.max(
    nominalDroneMovementPadding,
    Number.isFinite(measuredDroneMovementPadding) ? Math.max(0, measuredDroneMovementPadding) : 0
  );
  let interceptedPreviouslyKept = false;

  // Most projectile ticks contain no actively tracking missiles. Allocate the
  // per-target ECM cache only when guidance actually needs it.
  let ecmModCache = null;
  const flakMetrics = { active: 0, proximityCandidates: 0, detonations: 0, explosionEntities: 0, droneHits: 0, missileHits: 0, processingNs: 0n };
  const flakStart = process.hrtime.bigint();

  function flakRadiusFor(entity, kind) {
    if (kind === "ship") {
      return (entity && entity.shield >= SHIELD_HIT_MIN) ? shieldCollisionRadius(entity) : (entity?.radius || 0);
    }
    if (kind === "station") {
      return (entity && entity.shield >= SHIELD_HIT_MIN) ? shieldCollisionRadius(entity) : (entity?.radius || 0);
    }
    if (kind === "drone") return Number(entity.radius) || 10;
    return Number(entity.radius) || ((entity.type === "missile" || entity.type === "torpedo") ? PROJECTILES.hitRadius.missile : (entity.type === "rail" ? PROJECTILES.hitRadius.rail : PROJECTILES.hitRadius.default));
  }

  function findFlakEventSinglePass(bullet, previousX, previousY, spatial, scratch) {
    const fuseR = Math.max(0, Number(bullet.proximityFuseRadius) || 0);
    const best = room._flakBestEventScratch || (room._flakBestEventScratch = { t: 1, x: bullet.x, y: bullet.y, kind: null, entity: null, direct: false, entityId: "", candidates: 0 });
    best.t = 1;
    best.x = bullet.x;
    best.y = bullet.y;
    best.kind = null;
    best.entity = null;
    best.direct = false;
    best.entityId = "";
    best.candidates = 0;

    function considerEvent(t, x, y, kind, entity, direct) {
      if (t < 0 || t > 1 || !Number.isFinite(t)) return;
      if (!direct && kind) best.candidates += 1;
      const entityId = String(entity?.id || kind || "");
      if (t < best.t) {
        best.t = t;
        best.x = x;
        best.y = y;
        best.kind = kind;
        best.entity = entity;
        best.direct = direct;
        best.entityId = entityId;
      } else if (t === best.t) {
        if (direct && !best.direct) {
          best.direct = true;
          best.kind = kind;
          best.entity = entity;
          best.x = x;
          best.y = y;
          best.entityId = entityId;
        } else if (direct === best.direct && compareIdStrings(entityId, best.entityId) < 0) {
          best.kind = kind;
          best.entity = entity;
          best.x = x;
          best.y = y;
          best.entityId = entityId;
        }
      }
    }

    const asteroid = projectileMapImpact(room, previousX, previousY, bullet, spatial, scratch.asteroids);
    if (asteroid) considerEvent(asteroid.t, asteroid.x, asteroid.y, "asteroid", null, true);

    function testCandidates(list, kind, key) {
      for (const entity of list) {
        if (entity === bullet) continue;
        if (kind === "ship" && (!entity.alive || entity.destroyed)) continue;
        if (kind === "station" && (!entity || entity.alive === false || entity.state === "destroyed")) continue;
        if (kind === "drone" && (entity.destroyed || entity.removed || room.drones?.get?.(entity.id) !== entity)) continue;
        if (kind === "projectile" && (entity.life <= 0 || !entity.interceptable)) continue;
        if (kind === "station") {
          if (!Relationships.areEntityEnemies(room, bullet.ownerId, entity)) continue;
        } else if (kind !== "asteroid" && !areEnemies(room, bullet.ownerId, entity.ownerId)) {
          continue;
        }
        const radius = flakRadiusFor(entity, kind);
        const directHit = kind === "station" && entity.shield < SHIELD_HIT_MIN
          ? segmentStationHullHit(entity, previousX, previousY, bullet.x, bullet.y, 0)
          : segmentCircleHit(previousX, previousY, bullet.x, bullet.y, entity.x, entity.y, radius);
        if (directHit) considerEvent(directHit.t, directHit.x, directHit.y, kind, entity, true);
        const proxHit = kind === "station" && entity.shield < SHIELD_HIT_MIN
          ? segmentStationHullHit(entity, previousX, previousY, bullet.x, bullet.y, fuseR)
          : segmentCircleHit(previousX, previousY, bullet.x, bullet.y, entity.x, entity.y, radius + fuseR);
        if (proxHit) considerEvent(proxHit.t, proxHit.x, proxHit.y, kind, entity, false);
      }
    }

    const pList = spatial
      ? spatial.querySweptAabbUnordered("interceptableProjectiles", previousX, previousY, bullet.x, bullet.y, fuseR, scratch.interceptableProjectiles)
      : (room.bullets || []).filter((p) => p.interceptable && p.life > 0);
    testCandidates(pList, "projectile", "interceptableProjectiles");
    const dList = spatial
      ? spatial.querySweptAabbUnordered("drones", previousX, previousY, bullet.x, bullet.y, fuseR, scratch.drones)
      : (bump(room, "projectileDroneFullScanFallbacks"), room.drones?.values?.() || []);
    testCandidates(dList, "drone", "drones");
    const sList = spatial
      ? spatial.querySweptAabbUnordered("ships", previousX, previousY, bullet.x, bullet.y, fuseR, scratch.ships)
      : liveShips;
    testCandidates(sList, "ship", "ships");
    const stList = spatial
      ? spatial.querySweptAabbUnordered("stations", previousX, previousY, bullet.x, bullet.y, fuseR, scratch.stations)
      : (room.stations || []);
    testCandidates(stList, "station", "stations");
    bump(room, "flakCandidatesTested", best.candidates);
    return best;
  }

  function detonateFlakShell(bullet, detonateX, detonateY, triggerKind, triggerEntity, now, isDirect = false) {
    const blastR = Math.max(0, Number(bullet.blastRadius) || 0);
    if (blastR <= 0) return;
    room.effects.push({ type: "flakburst", x: detonateX, y: detonateY, at: now, radius: blastR });
    flakMetrics.detonations += 1;
    const blastDamage = Number(bullet.blastDamage) || 0;
    const innerR = Math.max(0, Number(bullet.innerFullDamageRadius) || 0);
    const exp = Math.max(0.1, Number(bullet.falloffExponent) || 1);
    const directDamage = isDirect && triggerEntity ? (Number(bullet.directDamage) || Number(bullet.damage) || 0) : 0;
    const maxTargets = Number(bullet.maximumExplosionTargets) || 0;
    let processed = 0;

    function damageFor(edgeDistance) {
      if (edgeDistance >= blastR) return 0;
      if (edgeDistance <= innerR) return blastDamage;
      const ratio = (edgeDistance - innerR) / (blastR - innerR);
      return blastDamage * Math.max(0, 1 - Math.pow(ratio, exp));
    }

    function damageEntity(entity, kind) {
      if (entity === bullet) return;
      if (!entity) return;
      if (kind === "station") {
        if (!Relationships.areEntityEnemies(room, bullet.ownerId, entity)) return;
      } else if (!areEnemies(room, bullet.ownerId, entity.ownerId)) {
        return;
      }
      if (kind === "ship" && (!entity.alive || entity.destroyed)) return;
      if (kind === "drone" && (entity.destroyed || entity.removed || room.drones?.get?.(entity.id) !== entity)) return;
      if (kind === "projectile" && (entity.life <= 0 || !entity.interceptable)) return;
      const radius = flakRadiusFor(entity, kind);
      const dx = entity.x - detonateX;
      const dy = entity.y - detonateY;
      const edge = kind === "station" && entity.shield < SHIELD_HIT_MIN
        ? nearestStationHullPoint(detonateX, detonateY, entity).distance
        : Math.max(0, fastHypot(dx, dy) - radius);
      if (edge > blastR) return;
      processed += 1;
      if (maxTargets > 0 && processed > maxTargets) return;
      let damage = damageFor(edge);
      if (isDirect && triggerEntity && entity === triggerEntity) damage += directDamage;
      if (damage <= 0.001) return;

      if (kind === "ship") {
        damageShip(room, entity, damage, bullet.ownerId, now, detonateX, detonateY, {
          shieldDamageMultiplier: bullet.shieldDamageMultiplier,
          hullDamageMultiplier: bullet.hullDamageMultiplier
        });
      } else if (kind === "drone") {
        require("./drones").damageDrone(room, entity, damage, bullet.ownerId, now);
        flakMetrics.droneHits += 1;
      } else if (kind === "projectile") {
        const hp = entity.hp !== undefined ? entity.hp : (entity.damage || 20);
        entity.hp = hp - damage;
        if (entity.hp <= 0.001) {
          removeProjectileRuntime(room, entity);
          room.effects.push({ type: "spark", x: entity.x, y: entity.y, at: now });
        }
        flakMetrics.missileHits += 1;
      } else if (kind === "station") {
        damageStation(room, entity, damage, bullet.ownerId, now, detonateX, detonateY, {
          shieldDamageMultiplier: bullet.shieldDamageMultiplier,
          hullDamageMultiplier: bullet.hullDamageMultiplier
        });
        flakMetrics.stationHits = (flakMetrics.stationHits || 0) + 1;
      }
    }

    const spatial = room.disableSpatialIndex ? null : (room.spatialIndex?.dynamicValid ? room.spatialIndex : null);
    const exScratch = room._flakExplosionScratch || (room._flakExplosionScratch = { interceptableProjectiles: [], drones: [], ships: [], stations: [] });
    if (spatial) {
      for (const kind of ["interceptableProjectiles", "drones", "ships", "stations"]) {
        const out = exScratch[kind] || (exScratch[kind] = []);
        const candidates = spatial.queryRangeUnordered(kind, detonateX, detonateY, blastR, out);
        const normalized = kind === "interceptableProjectiles" ? "projectile" : kind;
        for (const candidate of candidates) damageEntity(candidate, normalized);
      }
    } else {
      for (const p of room.bullets || []) damageEntity(p, "projectile");
      for (const d of room.drones?.values?.() || []) damageEntity(d, "drone");
      for (const s of room.ships?.values?.() || []) damageEntity(s, "ship");
    }
    flakMetrics.explosionEntities += processed;
  }

  // Offensive impact burst (Fragmentation Cannon). The direct hit has already
  // been resolved by the caller, so this only adds the surrounding blast and
  // deliberately reuses the Flak detonation maths rather than inventing a second
  // falloff model. `isDirect` stays false so the struck entity is not charged the
  // direct damage twice.
  function detonateImpactBurst(bullet, x, y, now) {
    if (!bullet || bullet.type === "flak") return;
    if (!((Number(bullet.blastRadius) || 0) > 0) || !((Number(bullet.blastDamage) || 0) > 0)) return;
    detonateFlakShell(bullet, x, y, null, null, now, false);
  }

  let ballisticCount = 0;
  let missileCount = 0;
  let flakCount = 0;
  let pdCount = 0;
  const sourceBulletsCount = sourceBullets.length;
  const updateStartedAt = performanceNow();
  const detailedTiming =
    process.env.MFA_DETAILED_PROJECTILE_TIMING === "1"
    && now >= (room._nextProjectileDetailedTimingAt || 0);
  if (detailedTiming) room._nextProjectileDetailedTimingAt = now + 1000;
  let timingSampleSlots = detailedTiming ? 64 : 0;

  for (const bullet of sourceBullets) {
    if (bullet.type === "missile") missileCount += 1;
    else if (bullet.type === "flak") flakCount += 1;
    else if (bullet.type === "pdShot") pdCount += 1;
    else if (bullet.type) ballisticCount += 1;
    if (!Number.isFinite(bullet.x) || !Number.isFinite(bullet.y)
      || !Number.isFinite(bullet.vx) || !Number.isFinite(bullet.vy)
      || !Number.isFinite(bullet.life) || !Number.isFinite(bullet.damage || 0)) {
      recordProjectileReason(bullet, "despawn");
      discardBullet(room, bulletsById, bullet);
      continue;
    }
    bullet.life -= dt;
    let flakExpired = false;
    if (bullet.life <= 0) {
      if (bullet.type === "missile" || bullet.type === "pdShot") {
        room.effects.push({ type: "despawn", subtype: bullet.subtype, x: bullet.x, y: bullet.y, at: now });
      }
      if (bullet.type === "flak") {
        flakExpired = true;
      } else {
        recordProjectileReason(bullet, "expired", bullet.x, bullet.y);
        discardBullet(room, bulletsById, bullet);
        continue;
      }
    }
    const previousX = bullet.x;
    const previousY = bullet.y;
    const timeThisBullet = detailedTiming && timingSampleSlots > 0;
    if (timeThisBullet) timingSampleSlots -= 1;

    if (bullet.type === "missile") {
      const guidanceStart = timeThisBullet ? performanceNow() : 0;
      bullet.age = (bullet.age || 0) + dt;
      if (bullet.trackingDisabledFor && bullet.trackingDisabledFor > 0) {
        bullet.trackingDisabledFor -= dt;
      }
      const target = room.ships.get(bullet.targetId)
        || room.drones?.get?.(bullet.targetId)
        || room.decoys?.get?.(bullet.targetId)
        || room.stationsById?.get?.(bullet.targetId)
        || (room.stations || []).find((station) => station?.id === bullet.targetId)
        || null;
      const canTrack = (Number(bullet.tracking) || 0) > 0
        && (bullet.trackRemaining === undefined || bullet.trackRemaining > 0)
        && (!bullet.trackingDisabledFor || bullet.trackingDisabledFor <= 0);
      const hostileTarget = target && (target.entityType === "station"
        ? Relationships.areEntityEnemies(room, bullet.ownerId, target)
        : areEnemies(room, bullet.ownerId, target.ownerId));
      if (target && canTrack && hostileTarget) {
        const updatesPerSecond = Math.max(0.001, Number(PROJECTILES.missileGuidanceUpdatesPerSecond) || 12);
        const intervalMs = 1000 / updatesPerSecond;
        let initialStagger = 0;
        if (!bullet._guidanceStaggerApplied) {
          const idNum = Number.parseInt(String(bullet.id).slice(1), 10) || 0;
          const staggerPartition = 100;
          initialStagger = (idNum % staggerPartition) * (intervalMs / staggerPartition);
        }
        const targetChanged = target.id !== bullet._guidanceTargetId;
        const componentDestroyed = bullet.targetComponentIndex >= 0 && (!target.componentHp || target.componentHp[bullet.targetComponentIndex] <= 0);
        const guidanceDue = bullet.nextGuidanceAt === undefined || now >= bullet.nextGuidanceAt || targetChanged || componentDestroyed;
        if (guidanceDue) {
          bump(room, "missileGuidanceUpdates");
          bullet._guidanceTargetId = target.id;
          if (bullet.targetComponentIndex === undefined) bullet.targetComponentIndex = -1;
          if (target.entityType === "station") {
            // Stations are compound structures, not ship component targets.
            // Keep the station id throughout guidance and aim at its live shield
            // circumference or nearest solid hull point.
            bullet.targetComponentIndex = -1;
          } else {
            const { selectComponentAimIndex } = require("./combat");
            if (bullet.targetComponentIndex >= 0 && (!target.componentHp || target.componentHp[bullet.targetComponentIndex] <= 0)) {
              bullet.targetComponentIndex = selectComponentAimIndex(room, target, bullet.targetComponentIndex);
            }
          }
          let targetPoint = null;
          if (target.entityType === "station") {
            targetPoint = stationAttackPoint(bullet.x, bullet.y, target);
          } else if (bullet.targetComponentIndex >= 0) {
            const { componentAimWorldPosition } = require("./combat");
            targetPoint = componentAimWorldPosition(target, bullet.targetComponentIndex);
          }
          const targetX = targetPoint?.x ?? target.x;
          const targetY = targetPoint?.y ?? target.y;
          let desired = Math.atan2(targetY - bullet.y, targetX - bullet.x);
          let turnRate = MISSILE_GUIDANCE.armingTurnRate; // Weak tracking during arming delay

          if (bullet.age >= (bullet.trackingDelay || 0)) {
            const tracking = clampNumber(bullet.tracking ?? MISSILE_GUIDANCE.defaultTracking, 0, 1);
            const baseTurnRate = bullet.baseTurnRate ?? MISSILE_GUIDANCE.baseTurnRate;
            const trackingTurnRate = bullet.maxTurnRate ?? (MISSILE_GUIDANCE.turnRateBase + tracking * tracking * MISSILE_GUIDANCE.turnRateTrackingSquaredMultiplier);
            turnRate = baseTurnRate + trackingTurnRate;

            // Add slight lead prediction only for high-tracking missiles
            const leadStrength = tracking * MISSILE_GUIDANCE.leadStrengthMultiplier;
            const predictedX = targetX + (target.vx || 0) * leadStrength;
            const predictedY = targetY + (target.vy || 0) * leadStrength;
            desired = Math.atan2(predictedY - bullet.y, predictedX - bullet.x);
          }

          turnRate *= missileEcmModifier(room, target, ecmModCache || (ecmModCache = new Map()));

          bullet.desiredGuidanceAngle = desired;
          bullet.guidanceTurnRate = turnRate;
          bullet.lastGuidanceAt = now;
          bullet.guidanceRevision = (bullet.guidanceRevision || 0) + 1;
          bullet.nextGuidanceAt = now + intervalMs + (bullet._guidanceStaggerApplied ? 0 : initialStagger);
          bullet._guidanceStaggerApplied = true;
        } else {
          bump(room, "missileGuidanceDeferred");
        }

        // Apply guidance every tick using the most recently computed desired
        // direction and turn rate; the cadence only controls how often those
        // steering targets are recomputed.
        const current = Math.atan2(bullet.vy, bullet.vx);
        const desired = bullet.desiredGuidanceAngle ?? current;
        const turnRate = bullet.guidanceTurnRate ?? MISSILE_GUIDANCE.armingTurnRate;
        const next = rotateToward(current, desired, turnRate * dt);
        const storedSpeed = Number(bullet.projectileSpeed);
        const speed = Number.isFinite(storedSpeed) && storedSpeed >= 0
          ? storedSpeed
          : fastHypot(bullet.vx, bullet.vy);
        if (!Number.isFinite(Number(bullet.projectileSpeed))) bullet.projectileSpeed = Number.isFinite(speed) ? speed : 0;
        bullet.vx = Math.cos(next) * speed;
        bullet.vy = Math.sin(next) * speed;
      } else if (target && !hostileTarget) {
        bullet._guidanceTargetId = target.id;
      }
      if (bullet.trackRemaining !== undefined) bullet.trackRemaining = Math.max(0, bullet.trackRemaining - dt);
      if (timeThisBullet) recordDuration(room, "missileGuidanceMs", guidanceStart);
    }

    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;

    if (bullet.type !== "flak" && (bullet.x < -PROJECTILES.worldPadding || bullet.x > room.world.width + PROJECTILES.worldPadding || bullet.y < -PROJECTILES.worldPadding || bullet.y > room.world.height + PROJECTILES.worldPadding)) {
      recordProjectileReason(bullet, "boundary", bullet.x, bullet.y);
      discardBullet(room, bulletsById, bullet);
      continue;
    }


    if (bullet.type === "flak") {
      flakMetrics.active += 1;
      const eventScratch = room._flakEventScratch || (room._flakEventScratch = { interceptableProjectiles: scratch.interceptableProjectiles, drones: scratch.drones, ships: scratch.ships, stations: scratch.stations, asteroids: asteroidCandidates });
      const flakSelectStart = timeThisBullet ? performanceNow() : 0;
      const event = findFlakEventSinglePass(bullet, previousX, previousY, spatialIndex, eventScratch);
      if (timeThisBullet) recordDuration(room, "flakEventSelectionMs", flakSelectStart);
      flakMetrics.proximityCandidates += event.candidates || 0;

      const dx = bullet.x - previousX;
      const dy = bullet.y - previousY;
      const expiryT = 1 + bullet.life / dt;
      let boundaryT = Infinity;
      const padding = PROJECTILES.worldPadding;
      if (dx > 0) boundaryT = Math.min(boundaryT, (room.world.width + padding - previousX) / dx);
      else if (dx < 0) boundaryT = Math.min(boundaryT, (-padding - previousX) / dx);
      if (dy > 0) boundaryT = Math.min(boundaryT, (room.world.height + padding - previousY) / dy);
      else if (dy < 0) boundaryT = Math.min(boundaryT, (-padding - previousY) / dy);

      let detonateT = event.t;
      let detonateX = event.x;
      let detonateY = event.y;
      let detonateKind = event.kind;
      let detonateEntity = event.entity || null;
      let detonateDirect = event.direct;

      if (expiryT < detonateT && expiryT < 1) {
        detonateT = expiryT;
        detonateX = previousX + dx * expiryT;
        detonateY = previousY + dy * expiryT;
        detonateKind = null;
        detonateEntity = null;
        detonateDirect = false;
      }
      if (boundaryT < detonateT && boundaryT < 1) {
        detonateT = boundaryT;
        detonateX = previousX + dx * boundaryT;
        detonateY = previousY + dy * boundaryT;
        detonateKind = "boundary";
        detonateEntity = null;
        detonateDirect = false;
      }

      if (detonateT < 1 || detonateKind) {
        const flakExplStart = timeThisBullet ? performanceNow() : 0;
        detonateFlakShell(bullet, detonateX, detonateY, detonateKind, detonateEntity || null, now, detonateDirect);
        if (timeThisBullet) recordDuration(room, "flakExplosionMs", flakExplStart);
        recordProjectileReason(bullet, detonateKind ? "impact" : "expired", detonateX, detonateY);
        discardBullet(room, bulletsById, bullet);
        continue;
      }
      kept.push(bullet);
      continue;
    }

    const mapStart = timeThisBullet ? performanceNow() : 0;
    const rockHit = projectileMapImpact(room, previousX, previousY, bullet, spatialIndex, asteroidCandidates);
    if (timeThisBullet) recordDuration(room, "projectileMapQueryMs", mapStart);

    let earliest = null;
    const recordHit = (candidate) => {
      if (!candidate) return;
      if (!earliest || candidate.t < earliest.t || (candidate.t === earliest.t && compareIdStrings(candidate.entityId || "", earliest.entityId || "") < 0)) {
        earliest = candidate;
      }
    };

    if (rockHit) {
      recordHit({ kind: "asteroid", t: rockHit.t, x: rockHit.x, y: rockHit.y, entityId: "asteroid" });
    }

    // pdShot: hostile interceptable projectiles along the swept segment.
    const interceptionStart = timeThisBullet ? performanceNow() : 0;
    if (bullet.type === "pdShot") {
      if (spatialIndex) {
        bump(room, "projectileSpatialQueries");
        bump(room, "interceptableProjectileQueries");
      }
      const pList = spatialIndex
        ? spatialIndex.querySweptAabbUnordered("interceptableProjectiles", previousX, previousY, bullet.x, bullet.y, PROJECTILES.interceptRadius, scratch.interceptableProjectiles)
        : (room.bullets || []).filter((p) => p.interceptable && p.life > 0);
      bump(room, "candidateProjectilesReturned", pList.length);
      for (const p of pList) {
        if (p === bullet) continue;
        if (!areEnemies(room, bullet.ownerId, p.ownerId)) continue;
        const hit = segmentCircleHit(previousX, previousY, bullet.x, bullet.y, p.x, p.y, PROJECTILES.interceptRadius);
        if (hit) recordHit({ kind: "projectile", t: hit.t, x: hit.x, y: hit.y, target: p, entityId: p.id });
      }
    }
    if (timeThisBullet) recordDuration(room, "projectileInterceptionMs", interceptionStart);

    // Decoys are false targets only for guided missiles. Unguided bolts, rails
    // and other projectiles neither acquire nor collide with them.
    if (bullet.type === "pdShot" || (bullet.type === "missile" && bullet.decoyTargetId && bullet.targetId === bullet.decoyTargetId)) {
      const decoyId = bullet.pdTargetType === "decoy" ? bullet.pdTargetId : bullet.decoyTargetId;
      const decoy = room.decoys?.get?.(decoyId);
      if (decoy) {
        const decoyHit = segmentCircleHit(previousX, previousY, bullet.x, bullet.y, decoy.x, decoy.y, (Number(decoy.radius) || 12) + PROJECTILES.hitRadius.missile);
        if (decoyHit) recordHit({ kind: "decoy", t: decoyHit.t, x: decoyHit.x, y: decoyHit.y, decoy, entityId: decoy.id });
      }
    }

    const shipBroadStart = timeThisBullet ? performanceNow() : 0;
    if (spatialIndex) {
      bump(room, "projectileSpatialQueries");
      bump(room, "shipQueries");
    }
    const possibleShips = spatialIndex
      ? spatialIndex.querySweptAabbUnordered("ships", previousX, previousY, bullet.x, bullet.y, 0, shipCandidates)
      : liveShips;
    bump(room, "projectileCandidateShips", possibleShips.length);
    bump(room, "candidateShipsReturned", possibleShips.length);
    if (timeThisBullet) recordDuration(room, "projectileShipBroadPhaseMs", shipBroadStart);
    const shipNarrowStart = timeThisBullet ? performanceNow() : 0;
    for (const ship of possibleShips) {
      if (!areEnemies(room, bullet.ownerId, ship.ownerId)) continue;
      const hitRadius = projectileHitRadius(bullet);

      // While the shield holds, it presents a clean swept bubble hitbox. The
      // earliest collision across asteroids and all valid enemy ships wins.
      if (ship.shield >= SHIELD_HIT_MIN) {
        bump(room, "shieldBubbleTests");
        const ringR = shieldCollisionRadius(ship) + hitRadius;
        const shieldHit = segmentCircleHit(previousX, previousY, bullet.x, bullet.y, ship.x, ship.y, ringR);
        if (!shieldHit) continue;
        recordHit({ kind: "ship", t: shieldHit.t, x: shieldHit.x, y: shieldHit.y, ship, entityId: ship.id, shield: true });
        continue;
      }

      const broadHullRadius = projectileHullBroadPhaseRadius(ship);
      if (isEmpProjectile(bullet)) {
        const empHullHit = segmentCircleHit(previousX, previousY, bullet.x, bullet.y, ship.x, ship.y, broadHullRadius + hitRadius);
        if (!empHullHit) continue;
        recordHit({ kind: "ship", t: empHullHit.t, x: empHullHit.x, y: empHullHit.y, ship, entityId: ship.id, shield: false, empLowShield: true });
        continue;
      }
      const hullHit = segmentCircleHit(previousX, previousY, bullet.x, bullet.y, ship.x, ship.y, broadHullRadius + hitRadius);
      if (!hullHit) continue;
      bump(room, "hullBroadPhaseHits");

      // Shield down: bullets must strike an actual hull module. Test the swept
      // segment against every occupied grid cell of each live component (shared
      // footprint-aware geometry, so a rotated or multi-cell component collides
      // on any of its cells), and choose the earliest component impact, with
      // component index as the deterministic tie-breaker. A multi-cell component
      // is recorded once (by index), so it takes a single damage event even when
      // several of its cells are crossed. Destroyed components are skipped via
      // componentHp and so no longer block later projectiles.
      const componentHitResult = findGridComponentHit(ship, previousX, previousY, bullet.x, bullet.y, hitRadius);
      const moduleHit = componentHitResult.hit;
      const componentCellTests = componentHitResult.componentCellTests;
      if (moduleHit) {
        recordHit({ kind: "ship", t: moduleHit.t, x: moduleHit.x, y: moduleHit.y, ship, entityId: ship.id, shield: false });
      }
      bump(room, "projectileComponentCellTests", componentCellTests);
      bump(room, "componentCellsTested", componentCellTests);
      bump(room, "componentGridCellsVisited", componentHitResult.gridCellsVisited || 0);
      bump(room, "componentGridOccupiedCells", componentHitResult.gridOccupiedCells || 0);
    }
    if (timeThisBullet) recordDuration(room, "projectileShipNarrowPhaseMs", shipNarrowStart);

    const stationStart = timeThisBullet ? performanceNow() : 0;
    if (spatialIndex) {
      bump(room, "projectileSpatialQueries");
      bump(room, "stationQueries");
    }
    const possibleStations = spatialIndex
      ? spatialIndex.querySweptAabbUnordered("stations", previousX, previousY, bullet.x, bullet.y, 0, scratch.stations)
      : (room.stations || []);
    bump(room, "candidateStationsReturned", possibleStations.length);
    for (const station of possibleStations) {
      if (station.alive === false || station.state === "destroyed") continue;
      if (!Relationships.areEntityEnemies(room, bullet.ownerId, station)) continue;
      const hitRadius = projectileHitRadius(bullet);
      if (station.shield >= SHIELD_HIT_MIN) {
        bump(room, "shieldBubbleTests");
        const ringR = shieldCollisionRadius(station) + hitRadius;
        const shieldHit = segmentCircleHit(previousX, previousY, bullet.x, bullet.y, station.x, station.y, ringR);
        if (shieldHit) recordHit({ kind: "station", t: shieldHit.t, x: shieldHit.x, y: shieldHit.y, station, entityId: station.id, shield: true });
        continue;
      }
      const hullHit = segmentStationHullHit(station, previousX, previousY, bullet.x, bullet.y, hitRadius);
      if (hullHit) recordHit({ kind: "station", t: hullHit.t, x: hullHit.x, y: hullHit.y, station, entityId: station.id, shield: false });
    }
    if (timeThisBullet) recordDuration(room, "projectileStationCollisionMs", stationStart);

    const droneStart = timeThisBullet ? performanceNow() : 0;
    let possibleDrones;
    if (spatialIndex) {
      bump(room, "droneQueries");
      bump(room, "projectileDroneQueries");
      const droneBroadPhaseStart = timeThisBullet ? performanceNow() : 0;
      possibleDrones = spatialIndex.querySweptAabbUnordered("drones", previousX, previousY, bullet.x, bullet.y, droneMovementPadding, droneCandidates);
      if (timeThisBullet) recordDuration(room, "projectileDroneBroadPhaseMs", droneBroadPhaseStart);
    } else {
      // This is intentionally retained only for the explicit no-index fixture.
      // Normal rooms recover the drone category before entering this branch.
      bump(room, "projectileDroneFullScanFallbacks");
      possibleDrones = fullScanDroneCandidates(room, droneCandidates);
    }
    bump(room, "projectileCandidateDrones", possibleDrones.length);
    bump(room, "candidateDronesReturned", possibleDrones.length);
    bump(room, "projectileDroneCandidates", possibleDrones.length);
    const droneNarrowPhaseStart = timeThisBullet ? performanceNow() : 0;
    for (const drone of possibleDrones) {
      if (drone.destroyed || drone.removed || room.drones?.get?.(drone.id) !== drone || !areEnemies(room, bullet.ownerId, drone.ownerId)) continue;
      const hitRadius = projectileHitRadius(bullet);
      const hit = segmentCircleHit(
        previousX,
        previousY,
        bullet.x,
        bullet.y,
        drone.x,
        drone.y,
        (Number(drone.radius) || 10) + hitRadius
      );
      if (hit) {
        bump(room, "projectileDroneHits");
        recordHit({ kind: "drone", t: hit.t, x: hit.x, y: hit.y, drone, entityId: drone.id });
      }
    }
    if (timeThisBullet) recordDuration(room, "projectileDroneNarrowPhaseMs", droneNarrowPhaseStart);
    if (timeThisBullet) recordDuration(room, "projectileDroneCollisionMs", droneStart);

    if (earliest?.kind === "asteroid") {
      if (isEmpProjectile(bullet)) {
        room.effects.push({ type: "empImpact", radius: 22, subtype: bullet.subtype, x: earliest.x, y: earliest.y, nx: 0, ny: 0, charged: false, shieldRemoved: 0, at: now });
        recordProjectileReason(bullet, "impact", earliest.x, earliest.y);
        discardBullet(room, bulletsById, bullet);
        continue;
      }
      room.effects.push({ type: "rockhit", x: earliest.x, y: earliest.y, at: now });
      detonateImpactBurst(bullet, earliest.x, earliest.y, now);
      recordProjectileReason(bullet, "impact", earliest.x, earliest.y);
      discardBullet(room, bulletsById, bullet);
      continue;
    }

    if (earliest?.kind === "decoy") {
      require("./decoys").removeDecoy(room, earliest.decoy, now, "hit");
      room.effects.push({ type: "burst", subtype: "decoy", x: earliest.x, y: earliest.y, at: now });
      recordProjectileReason(bullet, "impact", earliest.x, earliest.y);
      discardBullet(room, bulletsById, bullet);
      continue;
    }

    if (earliest?.kind === "projectile") {
      const target = earliest.target;
      const targetHp = target.hp !== undefined ? target.hp : (target.damage || 20);
      target.hp = targetHp - bullet.damage;
      bullet.life = 0;
      room.effects.push({ type: "spark", x: earliest.x, y: earliest.y, at: now });
      if (target.hp <= 0.001) {
        target.life = 0;
        recordProjectileReason(target, "intercepted", earliest.x, earliest.y);
        discardBullet(room, bulletsById, target);
        interceptedPreviouslyKept = true;
        room.effects.push({ type: "burst", x: earliest.x, y: earliest.y, at: now });
        room.effects.push({ type: "text", text: "INTERCEPTED", x: earliest.x, y: earliest.y, at: now });
      }
      recordProjectileReason(bullet, "intercepted", earliest.x, earliest.y);
      discardBullet(room, bulletsById, bullet);
      continue;
    }

    if (earliest?.kind === "ship") {
      recordProjectileReason(bullet, "impact", earliest.x, earliest.y);
      const ship = earliest.ship;
      if (isEmpProjectile(bullet)) {
        const disruption = applyEmpShieldDisruption(ship, bullet.shieldDisruptionFraction, bullet.ownerId, now);
        const angle = Math.atan2(earliest.y - ship.y, earliest.x - ship.x);
        room.effects.push({ type: "empImpact", radius: 22, subtype: bullet.subtype, x: earliest.x, y: earliest.y, nx: Math.cos(angle), ny: Math.sin(angle), charged: disruption.shieldAfter > 0, shieldRemoved: disruption.removed, at: now });
        discardBullet(room, bulletsById, bullet);
        continue;
      }
      const shipDamage = Number.isFinite(bullet.shipDamageMultiplier) ? bullet.damage * bullet.shipDamageMultiplier : bullet.damage;
      damageShip(room, ship, shipDamage, bullet.ownerId, now, earliest.x, earliest.y, {
        shieldDamageMultiplier: bullet.shieldDamageMultiplier,
        hullDamageMultiplier: bullet.hullDamageMultiplier,
        impactHeatPerDamage: bullet.impactHeatPerDamage,
        penetrationProfile: bullet.penetrationProfile
      });
      detonateImpactBurst(bullet, earliest.x, earliest.y, now);
      if (earliest.shield) {
        const ang = Math.atan2(earliest.y - ship.y, earliest.x - ship.x);
        const surfaceR = shieldCollisionRadius(ship);
        room.effects.push({
          type: "shieldhit",
          subtype: bullet.type,
          x: ship.x + Math.cos(ang) * surfaceR,
          y: ship.y + Math.sin(ang) * surfaceR,
          nx: Math.cos(ang),
          ny: Math.sin(ang),
          at: now
        });
      } else {
        room.effects.push({ type: (bullet.type === "missile" || bullet.type === "torpedo") ? "burst" : bullet.type === "rail" ? "railhit" : "spark", x: earliest.x, y: earliest.y, at: now });
      }
      discardBullet(room, bulletsById, bullet);
      continue;
    }

    if (earliest?.kind === "drone") {
      recordProjectileReason(bullet, "impact", earliest.x, earliest.y);
      if (isEmpProjectile(bullet)) {
        room.effects.push({ type: "empImpact", radius: 22, subtype: bullet.subtype, x: earliest.x, y: earliest.y, nx: 0, ny: 0, charged: false, shieldRemoved: 0, at: now });
        discardBullet(room, bulletsById, bullet);
        continue;
      }
      require("./drones").damageDrone(room, earliest.drone, bullet.damage, bullet.ownerId, now);
      detonateImpactBurst(bullet, earliest.x, earliest.y, now);
      room.effects.push({
        type: (bullet.type === "missile" || bullet.type === "torpedo") ? "burst" : bullet.type === "rail" ? "railhit" : "spark",
        x: earliest.x,
        y: earliest.y,
        at: now
      });
      discardBullet(room, bulletsById, bullet);
      continue;
    }

    if (earliest?.kind === "station") {
      recordProjectileReason(bullet, "impact", earliest.x, earliest.y);
      const station = earliest.station;
      if (isEmpProjectile(bullet)) {
        const disruption = applyEmpShieldDisruption(station, bullet.shieldDisruptionFraction, bullet.ownerId, now);
        const angle = Math.atan2(earliest.y - station.y, earliest.x - station.x);
        room.effects.push({ type: "empImpact", radius: 22, subtype: bullet.subtype, x: earliest.x, y: earliest.y, nx: Math.cos(angle), ny: Math.sin(angle), charged: disruption.shieldAfter > 0, shieldRemoved: disruption.removed, at: now });
        discardBullet(room, bulletsById, bullet);
        continue;
      }
      damageStation(room, station, bullet.damage, bullet.ownerId, now, earliest.x, earliest.y, {
        shieldDamageMultiplier: bullet.shieldDamageMultiplier,
        hullDamageMultiplier: bullet.hullDamageMultiplier
      });
      detonateImpactBurst(bullet, earliest.x, earliest.y, now);
      if (earliest.shield) {
        const ang = Math.atan2(earliest.y - station.y, earliest.x - station.x);
        const surfaceR = shieldCollisionRadius(station);
        room.effects.push({
          type: "shieldhit",
          subtype: bullet.type,
          x: station.x + Math.cos(ang) * surfaceR,
          y: station.y + Math.sin(ang) * surfaceR,
          nx: Math.cos(ang),
          ny: Math.sin(ang),
          at: now
        });
      } else {
        room.effects.push({ type: (bullet.type === "missile" || bullet.type === "torpedo") ? "burst" : bullet.type === "rail" ? "railhit" : "spark", x: earliest.x, y: earliest.y, at: now });
      }
      discardBullet(room, bulletsById, bullet);
      continue;
    }

    kept.push(bullet);
  }

  if (interceptedPreviouslyKept) {
    let write = 0;
    for (let read = 0; read < kept.length; read += 1) {
      if (kept[read]?.life > 0) kept[write++] = kept[read];
    }
    kept.length = write;
  }
  sourceBullets.length = 0;
  room.bullets = kept;
  room._projectileSpare = sourceBullets;

  setCounter(room, "projectilesVisited", sourceBulletsCount);
  setCounter(room, "ballisticProjectilesVisited", ballisticCount);
  setCounter(room, "missilesVisited", missileCount);
  setCounter(room, "flakProjectilesVisited", flakCount);
  setCounter(room, "pointDefenceProjectilesVisited", pdCount);

  const cleanupStart = performanceNow();
  const sourceEffects = room.effects || [];
  const keptEffects = room._effectSpare && room._effectSpare !== sourceEffects ? room._effectSpare : [];
  keptEffects.length = 0;
  for (const effect of sourceEffects) {
    const life = effect.type === "empImpact" ? 480 : effect.type === "beam" ? 140 : effect.type === "shieldhit" ? 340 : 900;
    if (now - effect.at < life) keptEffects.push(effect);
  }
  sourceEffects.length = 0;
  room.effects = keptEffects;
  room._effectSpare = sourceEffects;
  recordDuration(room, "projectileCleanupMs", cleanupStart);

  if (flakMetrics.active > 0) {
    flakMetrics.processingNs = process.hrtime.bigint() - flakStart;
    recordFlakMetrics({
      active: flakMetrics.active,
      proximityCandidates: flakMetrics.proximityCandidates,
      detonations: flakMetrics.detonations,
      explosionEntities: flakMetrics.explosionEntities,
      droneHits: flakMetrics.droneHits,
      missileHits: flakMetrics.missileHits,
      processingUs: Number(flakMetrics.processingNs) / 1000
    });
  }

  // Publish final projectile positions for the next authoritative tick.
  if (room.spatialIndex) {
    const liveProjectiles = [];
    const liveInterceptable = [];
    for (const bullet of room.bullets) {
      liveProjectiles.push(bullet);
      if (bullet.interceptable) liveInterceptable.push(bullet);
    }
    room.spatialIndex.updateLiveEntities("projectiles", liveProjectiles, () => 0);
    room.spatialIndex.updateLiveEntities("interceptableProjectiles", liveInterceptable, () => 0);
  }
  if (room.assertProjectileLookup || process.env.MFA_ASSERT_RUNTIME_CACHES === "1" || process.env.NODE_ENV === "test") {
    assertProjectileLookupConsistency(room);
  }
  recordDuration(room, "projectileIntegrationMs", updateStartedAt);
}

module.exports = {
  addBullet,
  ensureProjectileLookup,
  rebuildProjectileLookup,
  assertProjectileLookupConsistency,
  resetProjectileRuntime,
  removeProjectilesByOwner,
  removeProjectileRuntime,
  projectileMapImpact,
  segmentCircleHit,
  isEmpProjectile,
  projectileHitRadius,
  updateBullets,
  shieldCollisionRadius,
  SHIELD_HIT_MIN
};
