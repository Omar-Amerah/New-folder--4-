"use strict";

const { BALANCE } = require("./balanceConfig");
const { fastHypot } = require("./utils");
const { PARTS } = require("./components");
const DroneBayRules = require("../../public/src/shared/droneBayRules");
const HeatRules = require("../../public/src/shared/heatRules");
const { getShipRepairCache } = require("./repairCache");
const { ensureProjectileLookup, removeProjectileRuntime, segmentCircleHit } = require("./projectiles");
const { droneBroadPhaseRadius } = require("./spatialIndex");
const { areEnemies, damageShip, shipRepairNeed, areAllies } = require("./combat");
const { getComponentPowerMultiplier } = require("./componentPower");
const { repairShipComponents } = require("./componentHealth");
const { addComponentHeat } = require("./heat");

const CONFIG = BALANCE.drones;
const MODULE_SCALE = 13;
const GRID_CENTER = 7;
// A drone bay only needs meaningful power to launch and command drones — not a
// near-perfect supply. Below this floor it is treated as effectively unpowered
// (drones fall back / stop launching); above it, partial power just means a
// slower launch cadence rather than a hard stop.
const MIN_BAY_OPERATING_POWER = 0.05;
const DRONE_DECISION_INTERVAL_MS = 120;
const BACKUP_CORE_CONFIGS = Object.freeze(Object.fromEntries(
  Object.entries(CONFIG.types || {}).map(([type, config]) => [type, Object.freeze({
    ...config,
    commandRange: (Number(config.commandRange) || 0) * 0.80
  })])
));

function ensureDroneRuntime(room) {
  if (!room.drones) room.drones = new Map();
  if (room._droneCountSource !== room.drones || !room.droneCounts) {
    const byOwner = new Map();
    const byParent = new Map();
    for (const drone of room.drones.values()) {
      if (!drone || drone.destroyed) continue;
      byOwner.set(drone.ownerId, (byOwner.get(drone.ownerId) || 0) + 1);
      byParent.set(drone.parentShipId, (byParent.get(drone.parentShipId) || 0) + 1);
    }
    room.droneCounts = { byOwner, byParent };
    room._droneCountSource = room.drones;
  }
  return room.droneCounts;
}

function resetDroneRuntime(room) {
  room.drones = new Map();
  room.droneCounts = { byOwner: new Map(), byParent: new Map() };
  room._droneCountSource = room.drones;
}

function adjustDroneCount(room, drone, delta) {
  const counts = ensureDroneRuntime(room);
  for (const [map, key] of [[counts.byOwner, drone.ownerId], [counts.byParent, drone.parentShipId]]) {
    const next = Math.max(0, (map.get(key) || 0) + delta);
    if (next > 0) map.set(key, next);
    else map.delete(key);
  }
}

function removeActiveDrone(room, drone) {
  if (!drone || room.drones?.get?.(drone.id) !== drone) return false;
  ensureDroneRuntime(room);
  room.drones.delete(drone.id);
  room.spatialIndex?.remove?.("drones", drone);
  adjustDroneCount(room, drone, -1);
  drone.removed = true;
  // Clean up drone ordering records to prevent stale references
  drone._separationOrder = undefined;
  return true;
}

function indexDroneBays(ship) {
  if (!ship) return;
  const bays = ship.droneBays || [];
  if (ship._droneBayIndexSource === bays && ship.droneBayByComponentId && ship.droneBayByComponentIndex) return;
  ship.droneBayByComponentId = new Map();
  ship.droneBayByComponentIndex = new Map();
  for (const bay of bays) {
    ship.droneBayByComponentId.set(bay.componentId, bay);
    ship.droneBayByComponentIndex.set(bay.componentIndex, bay);
  }
  ship._droneBayIndexSource = bays;
}

function droneBayById(ship, componentId) {
  indexDroneBays(ship);
  return ship?.droneBayByComponentId?.get(componentId) || null;
}

function droneBayByIndex(ship, componentIndex) {
  indexDroneBays(ship);
  return ship?.droneBayByComponentIndex?.get(componentIndex) || null;
}

function initializeDroneBays(room, ship, now) {
  const validation = DroneBayRules.validateDroneBays(ship.design || [], PARTS, { maximum: CONFIG.maxBaysPerShip });
  ship.droneBays = validation.bays.map((source) => {
    const squadSize = CONFIG.types[source.droneType]?.squadSize || CONFIG.squadSize;
    return {
      ...source,
      mode: "deployed",
      launchBlockedBySpawn: false,
      nextLaunchAt: now,
      slots: Array.from({ length: squadSize }, (_, slot) => ({
        slot,
        state: "ready",
        droneId: null,
        productionProgress: 1,
        pauseReason: null
      }))
    };
  });
  indexDroneBays(ship);
  ensureDroneRuntime(room);
  return ship.droneBays;
}

function bayPowerRequest(ship, componentIndex) {
  const bay = droneBayByIndex(ship, componentIndex);
  if (!bay || (ship.componentHp?.[componentIndex] ?? 0) <= 0) return 0;
  if (bay.slots.some((slot) => slot.state === "producing" || slot.state === "destroyed")) return CONFIG.productionPowerMw;
  if (bay.slots.some((slot) => ["launching", "active", "returning", "docking", "refueling"].includes(slot.state))) return CONFIG.activePowerMw;
  // A deployed Ready slot is an imminent launch request. Reserve the active
  // load before spawning so a bay cannot launch on standby-only allocation.
  if (bay.mode === "deployed" && bay.slots.some((slot) => slot.state === "ready")) return CONFIG.activePowerMw;
  return CONFIG.standbyPowerMw;
}

function bayWorldPose(ship, bay) {
  const edge = bay.launchEdge;
  const gx = edge?.centerX ?? ship.design[bay.componentIndex].x + 1;
  const gy = edge?.centerY ?? ship.design[bay.componentIndex].y + 1;
  const gridDx = edge?.dx || 0;
  const gridDy = edge?.dy || -1;
  const lx = (GRID_CENTER - gy) * MODULE_SCALE;
  const ly = (gx - GRID_CENTER) * MODULE_SCALE;
  const localVx = -gridDy;
  const localVy = gridDx;
  const cos = Math.cos(ship.angle);
  const sin = Math.sin(ship.angle);
  return {
    x: ship.x + lx * cos - ly * sin,
    y: ship.y + lx * sin + ly * cos,
    nx: localVx * cos - localVy * sin,
    ny: localVx * sin + localVy * cos
  };
}

function ownerActiveCount(room, ownerId) {
  return ensureDroneRuntime(room).byOwner.get(ownerId) || 0;
}

function shipActiveCount(room, shipId) {
  return ensureDroneRuntime(room).byParent.get(shipId) || 0;
}

function isInOwnSpawnZone(room, ship) {
  const player = room.players?.get?.(ship?.ownerId);
  for (const zone of room.map?.safeZones || []) {
    const dx = ship.x - zone.x;
    const dy = ship.y - zone.y;
    if (!zone?.isSpawn || dx * dx + dy * dy > zone.radius * zone.radius) continue;
    if (zone.ownerId) return Boolean(player && player.id === zone.ownerId);
    if (zone.team) return Boolean(player && player.team === zone.team);
    if (Array.isArray(zone.spawnPlayerIds)) return zone.spawnPlayerIds.includes(player?.id);
    return true;
  }
  return false;
}

function spawnDrone(room, ship, bay, slot, now) {
  if (shipActiveCount(room, ship.id) >= CONFIG.maxActivePerShip) return null;
  if (ownerActiveCount(room, ship.ownerId) >= CONFIG.maxActivePerPlayer) return null;
  const typeConfig = CONFIG.types[bay.droneType];
  if (!typeConfig) return null;
  const pose = bayWorldPose(ship, bay);
  // Assign stable numeric sequence for deterministic drone ordering without per-tick sorting
  const authoritativeSequence = room._nextDroneSequence || (room._nextDroneSequence = 0);
  room._nextDroneSequence = authoritativeSequence + 1;
  const drone = {
    id: `d${room.nextEntityId++}`,
    ownerId: ship.ownerId,
    ownerPlayerId: ship.ownerId,
    teamId: ship.team || room.players?.get?.(ship.ownerId)?.team || null,
    parentShipId: ship.id,
    bayComponentId: bay.componentId,
    bayComponentIndex: bay.componentIndex,
    slot: slot.slot,
    squadIndex: slot.slot,
    type: bay.droneType,
    droneType: bay.droneType,
    x: pose.x,
    y: pose.y,
    vx: pose.nx * typeConfig.speed * 0.35,
    vy: pose.ny * typeConfig.speed * 0.35,
    angle: Math.atan2(pose.ny, pose.nx),
    radius: 10,
    hull: typeConfig.hull,
    maxHull: typeConfig.hull,
    state: "launching",
    launchedAt: now,
    stateUntil: now + CONFIG.launchDurationSeconds * 1000,
    commandState: bay.mode,
    nextThinkAt: now + ((slot.slot * 37) % DRONE_DECISION_INTERVAL_MS),
    nextDecisionAt: now + ((slot.slot * 37) % DRONE_DECISION_INTERVAL_MS),
    nextActionAt: now + 350,
    targetId: null,
    fuelRemainingSeconds: (CONFIG.types[bay.droneType]?.fuelSeconds || CONFIG.fuelSeconds),
    returnReason: null,
    refuelStartedAt: null,
    refuelUntil: null,
    orphanedAt: null,
    removed: false,
    authoritativeSequence
  };
  room.drones.set(drone.id, drone);
  if (room.spatialIndex?.dynamicValid && typeof room.spatialIndex.append === "function") {
    room.spatialIndex.append("drones", drone, droneBroadPhaseRadius(drone));
  }
  adjustDroneCount(room, drone, 1);
  slot.droneId = drone.id;
  slot.state = "launching";
  slot.productionProgress = 1;
  slot.pauseReason = null;
  room.effects.push({ type: "dronelaunch", subtype: drone.type, ownerId: drone.ownerId, x: drone.x, y: drone.y, at: now });
  return drone;
}

function setDroneDestroyed(room, drone, now, reason = "destroyed") {
  if (!drone || drone.destroyed) return false;
  removeActiveDrone(room, drone);
  drone.destroyed = true;
  drone.destroyedAt = now;
  const parent = room.ships.get(drone.parentShipId);
  const bay = droneBayById(parent, drone.bayComponentId);
  const slot = bay?.slots?.[drone.slot];
  if (slot && slot.droneId === drone.id) {
    slot.droneId = null;
    slot.state = "destroyed";
    slot.productionProgress = 0;
    slot.pauseReason = null;
  }
  room.effects.push({ type: "droneburst", subtype: drone.type, reason, x: drone.x, y: drone.y, at: now });
  return true;
}

function damageDrone(room, drone, amount, attackerId, now) {
  if (!drone || drone.destroyed || !(amount > 0)) return 0;
  const applied = Math.min(drone.hull, amount);
  drone.hull -= applied;
  drone.lastDamagedAt = now;
  drone.lastDamagedBy = attackerId || null;
  if (drone.hull <= 0.001) setDroneDestroyed(room, drone, now);
  return applied;
}

function decisionScratch(drone, kind) {
  const scratch = drone._decisionScratch || (drone._decisionScratch = {
    ships: [], drones: [], projectiles: [], interceptableProjectiles: []
  });
  return scratch[kind];
}

function nearbyCandidates(room, drone, kind, x, y, range, fallback, unordered = false) {
  if (!room.spatialIndex) return fallback;
  const movementPadding = kind === "drones" ? (Number(room.droneSpatialPadding) || 0) : 0;
  const query = unordered ? "queryRangeUnordered" : "queryRange";
  return room.spatialIndex[query](kind, x, y, range + movementPadding, decisionScratch(drone, kind));
}

function resolveDroneTarget(room, targetId) {
  if (!targetId) return null;
  return room.drones?.get?.(targetId)
    || room.ships?.get?.(targetId)
    || ensureProjectileLookup(room).get(targetId)
    || null;
}

function nearestEnemyDrone(room, drone, maximumRange) {
  let best = null;
  let bestDistanceSq = maximumRange * maximumRange;
  const candidates = nearbyCandidates(room, drone, "drones", drone.x, drone.y, maximumRange, room.drones.values(), true);
  for (const other of candidates) {
    if (other.id === drone.id || other.destroyed || other.removed || room.drones.get(other.id) !== other || !areEnemies(room, drone.ownerId, other.ownerId)) continue;
    const dx = other.x - drone.x;
    const dy = other.y - drone.y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq < bestDistanceSq || (distanceSq === bestDistanceSq && String(other.id) < String(best?.id))) {
      best = other;
      bestDistanceSq = distanceSq;
    }
  }
  return best;
}

function nearestHostileMissile(room, drone, maximumRange) {
  let best = null;
  let bestDistanceSq = maximumRange * maximumRange;
  const candidates = nearbyCandidates(room, drone, "interceptableProjectiles", drone.x, drone.y, maximumRange, room.bullets || [], true);
  for (const projectile of candidates) {
    if (!projectile.interceptable || projectile.life <= 0 || !areEnemies(room, drone.ownerId, projectile.ownerId)) continue;
    const dx = projectile.x - drone.x;
    const dy = projectile.y - drone.y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq < bestDistanceSq || (distanceSq === bestDistanceSq && String(projectile.id) < String(best?.id))) {
      best = projectile;
      bestDistanceSq = distanceSq;
    }
  }
  return best;
}

function nearestEnemyShip(room, drone, maximumRange) {
  let best = null;
  let bestDistanceSq = maximumRange * maximumRange;
  const candidates = nearbyCandidates(room, drone, "ships", drone.x, drone.y, maximumRange, room.ships.values(), true);
  for (const ship of candidates) {
    if (!ship.alive || !areEnemies(room, drone.ownerId, ship.ownerId)) continue;
    const dx = ship.x - drone.x;
    const dy = ship.y - drone.y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq < bestDistanceSq || (distanceSq === bestDistanceSq && String(ship.id) < String(best?.id))) {
      best = ship;
      bestDistanceSq = distanceSq;
    }
  }
  return best;
}

// Fraction of "important" components (weapons + priority systems + core) that
// are below full health. Aggregate ship.hp misses Core-only or isolated
// component damage, so repair targeting must look at component health.
function importantComponentDamageFraction(ship) {
  return getShipRepairCache(ship).importantDamageFraction;
}

function repairTargetScore(ship, need, distance, config) {
  // Weight raw repairable damage, then boost ships whose important systems are
  // hurt, and prefer closer allies within command range.
  const range = Math.max(1, config.commandRange || 1);
  const distanceFactor = 1 - Math.min(1, distance / range);
  return need * (1 + importantComponentDamageFraction(ship)) + distanceFactor * 25;
}

function chooseTarget(room, drone, parent, config) {
  if (drone.type === "repair") {
    // Prefer the parent while it has ANY repairable damage (component or Core),
    // using the same shared repair-need helper as repair modules and beams so
    // Core-only and component-only damage are never missed.
    if (shipRepairNeed(parent) > 0) return parent;
    let best = null;
    let bestScore = -Infinity;
    const candidates = nearbyCandidates(room, drone, "ships", parent.x, parent.y, config.commandRange, room.ships.values());
    const rangeSq = config.commandRange * config.commandRange;
    for (const ship of candidates) {
      if (ship === parent || !ship?.alive) continue;
      if (!areAllies(room, drone.ownerId, ship.ownerId)) continue;
      const dx = ship.x - parent.x;
      const dy = ship.y - parent.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > rangeSq) continue;
      const cache = getShipRepairCache(ship);
      const need = cache.need;
      if (need <= 0) continue;
      const distance = Math.sqrt(distanceSq);
      const score = repairTargetScore(ship, need, distance, config);
      if (score > bestScore || (score === bestScore && (!best || String(ship.id).localeCompare(String(best.id)) < 0))) {
        best = ship;
        bestScore = score;
      }
    }
    return best || parent;
  }
  if (drone.type === "defence") {
    const missile = nearestHostileMissile(room, drone, config.commandRange);
    if (missile) return missile;
  }
  const hostileDrone = nearestEnemyDrone(room, drone, drone.type === "defence" ? config.commandRange : config.weaponRange);
  if (hostileDrone) return hostileDrone;
  if (drone.type === "fighter" && parent.focusTargetId) {
    const focused = room.ships.get(parent.focusTargetId);
    if (focused?.alive && areEnemies(room, drone.ownerId, focused.ownerId)) return focused;
  }
  return nearestEnemyShip(room, drone, config.commandRange);
}

function chooseFallbackTarget(room, drone, parent, config) {
  if (drone.type === "repair") return parent;
  return (drone.type === "defence" ? nearestHostileMissile(room, drone, config.weaponRange) : null)
    || nearestEnemyDrone(room, drone, config.weaponRange)
    || nearestEnemyShip(room, drone, config.weaponRange);
}

function steerDrone(drone, targetX, targetY, speed, turnRate, dt) {
  const desired = Math.atan2(targetY - drone.y, targetX - drone.x);
  let delta = ((desired - drone.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  delta = Math.max(-turnRate * dt, Math.min(turnRate * dt, delta));
  drone.angle += delta;
  const desiredVx = Math.cos(drone.angle) * speed;
  const desiredVy = Math.sin(drone.angle) * speed;
  const blend = Math.min(1, dt * 4);
  drone.vx += (desiredVx - drone.vx) * blend;
  drone.vy += (desiredVy - drone.vy) * blend;
  drone.x += drone.vx * dt;
  drone.y += drone.vy * dt;
}

function resolveDroneMapCollision(room, drone, previousX = drone.x, previousY = drone.y) {
  if (!drone || drone.removed || drone.destroyed) return;
  const radius = Math.max(1, Number(drone.radius) || 10);
  const width = Number(room.world?.width);
  const height = Number(room.world?.height);
  if (Number.isFinite(width) && width > radius * 2) {
    const clampedX = Math.max(radius, Math.min(width - radius, drone.x));
    if (clampedX !== drone.x && ((clampedX === radius && drone.vx < 0) || (clampedX === width - radius && drone.vx > 0))) drone.vx = 0;
    drone.x = clampedX;
  }
  if (Number.isFinite(height) && height > radius * 2) {
    const clampedY = Math.max(radius, Math.min(height - radius, drone.y));
    if (clampedY !== drone.y && ((clampedY === radius && drone.vy < 0) || (clampedY === height - radius && drone.vy > 0))) drone.vy = 0;
    drone.y = clampedY;
  }

  // Use spatial index for asteroid queries instead of full array scan
  const asteroidCandidates = room.spatialIndex
    ? room.spatialIndex.querySweptAabbUnordered(
        "asteroids",
        previousX,
        previousY,
        drone.x,
        drone.y,
        radius + 2,
        drone._asteroidCollisionScratch || (drone._asteroidCollisionScratch = [])
      )
    : (room.map?.asteroids || []);

  let sweptHit = null;
  for (let candidateIndex = 0; candidateIndex < asteroidCandidates.length; candidateIndex += 1) {
    const asteroid = asteroidCandidates[candidateIndex];
    if (!asteroid) continue;
    const minimum = Math.max(0, Number(asteroid.radius) || 0) + radius + 2;
    const startDx = previousX - asteroid.x;
    const startDy = previousY - asteroid.y;
    if (startDx * startDx + startDy * startDy < minimum * minimum) continue;
    const hit = segmentCircleHit(previousX, previousY, drone.x, drone.y, asteroid.x, asteroid.y, minimum);
    if (!hit) continue;
    // Use asteroid's stable index from map for deterministic tie-breaking
    const asteroidIndex = room.map?.asteroids?.indexOf?.(asteroid) ?? candidateIndex;
    if (!sweptHit || hit.t < sweptHit.hit.t || (hit.t === sweptHit.hit.t && asteroidIndex < sweptHit.asteroidIndex)) {
      sweptHit = { asteroid, asteroidIndex, minimum, hit };
    }
  }
  if (sweptHit) {
    let nx = sweptHit.hit.x - sweptHit.asteroid.x;
    let ny = sweptHit.hit.y - sweptHit.asteroid.y;
    let distance = fastHypot(nx, ny);
    if (distance < 0.001) {
      nx = previousX - sweptHit.asteroid.x;
      ny = previousY - sweptHit.asteroid.y;
      distance = fastHypot(nx, ny);
    }
    if (distance < 0.001) {
      nx = stableDodgeSide(drone.id);
      ny = 0;
      distance = 1;
    }
    nx /= distance;
    ny /= distance;
    drone.x = sweptHit.asteroid.x + nx * sweptHit.minimum;
    drone.y = sweptHit.asteroid.y + ny * sweptHit.minimum;
    const velocityIntoRock = drone.vx * nx + drone.vy * ny;
    if (velocityIntoRock < 0) {
      drone.vx -= velocityIntoRock * nx;
      drone.vy -= velocityIntoRock * ny;
    }
  }

  // Separation or legacy positions can begin inside a rock. A few bounded
  // passes resolve compound overlaps without changing asteroid ordering.
  // Reuse the same candidate set from the swept collision query.
  for (let pass = 0; pass < 3; pass += 1) {
    let adjusted = false;
    for (const asteroid of asteroidCandidates) {
      if (!asteroid) continue;
      let dx = drone.x - asteroid.x;
      let dy = drone.y - asteroid.y;
      let distance = fastHypot(dx, dy);
      const minimum = Math.max(0, Number(asteroid.radius) || 0) + radius + 2;
      if (distance >= minimum) continue;
      if (distance < 0.001) {
        dx = stableDodgeSide(drone.id);
        dy = 0;
        distance = 1;
      }
      const nx = dx / distance;
      const ny = dy / distance;
      drone.x = asteroid.x + nx * minimum;
      drone.y = asteroid.y + ny * minimum;
      const velocityIntoRock = drone.vx * nx + drone.vy * ny;
      if (velocityIntoRock < 0) {
        drone.vx -= velocityIntoRock * nx;
        drone.vy -= velocityIntoRock * ny;
      }
      adjusted = true;
    }
    if (!adjusted) break;
  }

  if (Number.isFinite(width) && width > radius * 2) drone.x = Math.max(radius, Math.min(width - radius, drone.x));
  if (Number.isFinite(height) && height > radius * 2) drone.y = Math.max(radius, Math.min(height - radius, drone.y));
}

function resolveDroneSeparation(drones, ordered = [], spatialIndex = null, movementPadding = 0) {
  ordered.length = 0;
  for (const drone of drones || []) {
    if (drone && !drone.removed && !drone.destroyed && !["docking", "refueling"].includes(drone.state)) ordered.push(drone);
  }
  // Use stable numeric authoritative sequence instead of per-tick localeCompare sorting
  ordered.sort((a, b) => {
    const seqA = Number.isFinite(a.authoritativeSequence) ? a.authoritativeSequence : 0;
    const seqB = Number.isFinite(b.authoritativeSequence) ? b.authoritativeSequence : 0;
    return seqA - seqB || String(a.id).localeCompare(String(b.id));
  });
  let maximumRadius = 10;
  for (let index = 0; index < ordered.length; index += 1) {
    const drone = ordered[index];
    drone._separationOrder = index;
    maximumRadius = Math.max(maximumRadius, Math.max(1, Number(drone.radius) || 10));
  }
  for (let i = 0; i < ordered.length; i += 1) {
    const a = ordered[i];
    const candidates = spatialIndex
      ? spatialIndex.queryRangeUnordered(
        "drones",
        a.x,
        a.y,
        maximumRadius * 2 + Math.max(0, Number(movementPadding) || 0) * 2 + 2,
        a._separationScratch || (a._separationScratch = [])
      )
      : ordered;
    for (const b of candidates) {
      if (a === b || b.removed || b.destroyed || ["docking", "refueling"].includes(b.state)) continue;
      // Use authoritative sequence for deterministic pair ordering instead of _separationOrder
      const seqA = Number.isFinite(a.authoritativeSequence) ? a.authoritativeSequence : 0;
      const seqB = Number.isFinite(b.authoritativeSequence) ? b.authoritativeSequence : 0;
      if (seqB <= seqA) continue;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let distance = fastHypot(dx, dy);
      const minimum = Math.max(1, Number(a.radius) || 10) + Math.max(1, Number(b.radius) || 10) + 2;
      if (distance >= minimum) continue;
      let nx;
      let ny;
      if (distance < 0.001) {
        // Use numeric sequence for stable tie-breaking instead of string concatenation
        const hash = (seqA + seqB) & 1;
        nx = hash === 0 ? 1 : -1;
        ny = 0;
        distance = 0;
      } else {
        nx = dx / distance;
        ny = dy / distance;
      }
      const push = (minimum - distance) * 0.5;
      a.x -= nx * push;
      a.y -= ny * push;
      b.x += nx * push;
      b.y += ny * push;
      const relativeInto = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (relativeInto < 0) {
        const impulse = relativeInto * 0.25;
        a.vx += nx * impulse;
        a.vy += ny * impulse;
        b.vx -= nx * impulse;
        b.vy -= ny * impulse;
      }
    }
  }
}

function stableDodgeSide(id) {
  let hash = 0;
  for (const character of String(id || "fighter")) hash = ((hash * 31) + character.charCodeAt(0)) | 0;
  return (hash & 1) === 0 ? 1 : -1;
}

// Predictive projectile evasion for combat drones. Any drone type whose balance
// defines an evasion envelope (lookahead + clearance) uses it; Repair Drones,
// which define none, are naturally excluded.
function fighterProjectileEvasion(room, drone, config) {
  const lookahead = Math.max(0, Number(config.evasionLookaheadSeconds) || 0);
  const clearance = Math.max(0, Number(config.evasionClearance) || 0);
  if (lookahead <= 0 || clearance <= 0) return null;

  let dodgeX = 0;
  let dodgeY = 0;
  let totalWeight = 0;
  let mostUrgent = null;
  let mostUrgentWeight = 0;
  let mostUrgentDodgeX = 0;
  let mostUrgentDodgeY = 0;

  const maximumThreatRange = ((room.spatialIndex?.maxProjectileSpeed || 0) + (Number(config.speed) || 0)) * lookahead + clearance;
  const projectiles = nearbyCandidates(
    room,
    drone,
    "projectiles",
    drone.x,
    drone.y,
    maximumThreatRange,
    room.bullets || []
  );
  const clearanceSq = clearance * clearance;
  for (const projectile of projectiles) {
    if (!projectile || projectile.life <= 0 || !areEnemies(room, drone.ownerId, projectile.ownerId)) continue;
    if (![projectile.x, projectile.y, projectile.vx, projectile.vy].every(Number.isFinite)) continue;

    const rx = projectile.x - drone.x;
    const ry = projectile.y - drone.y;
    const rvx = projectile.vx - (drone.vx || 0);
    const rvy = projectile.vy - (drone.vy || 0);
    const relativeSpeedSq = rvx * rvx + rvy * rvy;
    if (relativeSpeedSq <= 0.0001) continue;

    const maximumTime = Math.min(lookahead, Math.max(0, Number(projectile.life) || 0));
    const rawClosestTime = -(rx * rvx + ry * rvy) / relativeSpeedSq;
    const closestTime = Math.max(0, Math.min(maximumTime, rawClosestTime));
    const closestX = rx + rvx * closestTime;
    const closestY = ry + rvy * closestTime;
    const closestDistanceSq = closestX * closestX + closestY * closestY;
    const currentDistanceSq = rx * rx + ry * ry;
    if (closestDistanceSq >= clearanceSq) continue;
    // A receding projectile only matters while it is already inside the
    // clearance envelope; otherwise drones should not weave needlessly.
    if (rawClosestTime < 0 && currentDistanceSq >= clearanceSq) continue;
    const closestDistance = Math.sqrt(closestDistanceSq);
    const currentDistance = Math.sqrt(currentDistanceSq);

    const relativeSpeed = Math.sqrt(relativeSpeedSq);
    const perpendicularX = -rvy / relativeSpeed;
    const perpendicularY = rvx / relativeSpeed;
    const sideProjection = closestX * perpendicularX + closestY * perpendicularY;
    const side = Math.abs(sideProjection) > 0.001
      ? (sideProjection > 0 ? -1 : 1)
      : stableDodgeSide(drone.id);
    // Primary manoeuvre: slip perpendicular to the projectile's approach line.
    let dirX = perpendicularX * side;
    let dirY = perpendicularY * side;
    // If it is already inside the clearance bubble, add a direct break-away push
    // so the drone opens distance instead of merely sliding along the line.
    if (currentDistance > 0.001 && currentDistance < clearance) {
      const breakaway = (clearance - currentDistance) / clearance;
      dirX += (-rx / currentDistance) * breakaway;
      dirY += (-ry / currentDistance) * breakaway;
    }
    const dirMagnitude = fastHypot(dirX, dirY) || 1;
    dirX /= dirMagnitude;
    dirY /= dirMagnitude;

    const clearanceUrgency = 1 - closestDistance / clearance;
    // Urgency ramps up sharply as impact nears, so an imminent aimed shot
    // dominates over a distant projectile that merely clips the envelope.
    const timeFactor = 1 - closestTime / lookahead;
    const timeUrgency = 0.2 + 0.8 * timeFactor * timeFactor;
    const projectileUrgency = projectile.targetId === drone.id
      ? 1.5
      : (projectile.type === "missile" || projectile.type === "torpedo")
        ? 1.25
        : projectile.type === "rail"
          ? 1.15
          : 1;
    const weight = clearanceUrgency * timeUrgency * projectileUrgency;
    dodgeX += dirX * weight;
    dodgeY += dirY * weight;
    totalWeight += weight;
    if (weight > mostUrgentWeight) {
      mostUrgentWeight = weight;
      mostUrgentDodgeX = dirX;
      mostUrgentDodgeY = dirY;
      mostUrgent = { projectileId: projectile.id, closestTime, closestDistance };
    }
  }

  if (!mostUrgent) return null;
  let magnitude = fastHypot(dodgeX, dodgeY);
  // Under crossfire the individual dodges can partly cancel and leave the drone
  // drifting into a threat. If the combined vector collapses, commit fully to
  // the single most dangerous projectile instead of splitting the difference.
  if (magnitude <= 0.35 * totalWeight) {
    dodgeX = mostUrgentDodgeX;
    dodgeY = mostUrgentDodgeY;
    magnitude = fastHypot(dodgeX, dodgeY);
  }
  if (magnitude <= 0.0001) return null;
  return {
    x: dodgeX / magnitude,
    y: dodgeY / magnitude,
    weight: Math.min(1, totalWeight),
    ...mostUrgent
  };
}

function steerFighterDrone(room, drone, targetX, targetY, config, dt, now, cachedEvasion = undefined) {
  const evasion = cachedEvasion === undefined ? fighterProjectileEvasion(room, drone, config) : cachedEvasion;
  if (!evasion) {
    drone.evasionProjectileId = null;
    steerDrone(drone, targetX, targetY, config.speed, config.turnRate, dt);
    return;
  }

  const targetDx = targetX - drone.x;
  const targetDy = targetY - drone.y;
  const targetDistance = Math.max(0.0001, fastHypot(targetDx, targetDy));
  const strength = Math.max(0, Number(config.evasionStrength) || 0) * evasion.weight;
  const desiredX = targetDx / targetDistance + evasion.x * strength;
  const desiredY = targetDy / targetDistance + evasion.y * strength;
  drone.evasionProjectileId = evasion.projectileId;
  drone.lastEvasionAt = now;
  // Briefly overdrive the engines while committing to a dodge so the drone
  // actually clears the projectile rather than being run down by it.
  const boost = strength > 0
    ? 1 + Math.min(0.6, Math.max(0, Number(config.evasionSpeedBoost) || 0) * evasion.weight)
    : 1;
  steerDrone(
    drone,
    drone.x + desiredX * Math.max(1, config.speed),
    drone.y + desiredY * Math.max(1, config.speed),
    config.speed * boost,
    config.turnRate,
    dt
  );
}

function updateDroneEntity(room, drone, dt, now) {
  const parent = room.ships.get(drone.parentShipId);
  const baseConfig = CONFIG.types[drone.type];
  const config = parent?.commandState === "backupCore"
    ? BACKUP_CORE_CONFIGS[drone.type]
    : baseConfig;
  if (!parent?.alive) {
    drone.orphanedAt ||= now;
    drone.state = "orphaned";
    drone.vx *= Math.max(0, 1 - dt * 0.8);
    drone.vy *= Math.max(0, 1 - dt * 0.8);
    drone.x += drone.vx * dt;
    drone.y += drone.vy * dt;
    if (now - drone.orphanedAt >= CONFIG.orphanLifetimeSeconds * 1000) setDroneDestroyed(room, drone, now, "orphaned");
    return;
  }
  if (isInOwnSpawnZone(room, parent)) {
    setDroneDestroyed(room, drone, now, "spawn-zone");
    return;
  }
  const bay = droneBayById(parent, drone.bayComponentId);
  const bayOperational = bay && (parent.componentHp?.[bay.componentIndex] ?? 0) > 0;
  const bayPowered = bayOperational && getComponentPowerMultiplier(parent, bay.componentIndex) > MIN_BAY_OPERATING_POWER;
  const fallback = !bayOperational || !bayPowered;
  const enteredFallback = fallback && drone.commandState !== "fallback";
  drone.commandState = fallback ? "fallback" : bay.mode;
  if (fallback) {
    drone.state = "fallback";
    if (enteredFallback) {
      drone.targetId = null;
      drone.nextDecisionAt = now;
      drone.nextThinkAt = now;
    }
  }
  else if (drone.state === "fallback") drone.state = "active";
  if (drone.state === "launching" && now >= drone.stateUntil) {
    drone.state = "active";
    const slot = bay?.slots?.[drone.slot];
    if (slot) slot.state = "active";
  }
  const pose = bay ? bayWorldPose(parent, bay) : { x: parent.x, y: parent.y };
  if (bayOperational && bay.mode === "recalled") {
    drone.state = "returning";
    drone.returnReason = "recall";
  } else if (bayOperational && bay.mode === "deployed" && ["returning", "docking"].includes(drone.state) && drone.returnReason !== "fuel") {
    // Deploy is also the authoritative cancellation path for an in-progress
    // recall. Previously these drones continued docking while the bay already
    // reported "deployed".
    drone.state = bayPowered ? "active" : "fallback";
    const returningSlot = bay.slots[drone.slot];
    if (returningSlot) returningSlot.state = drone.state;
  }
  if (drone.state === "refueling") {
    drone.x = pose.x;
    drone.y = pose.y;
    drone.vx = 0;
    drone.vy = 0;
    if (now >= drone.refuelUntil) {
      drone.state = "launching";
      drone.returnReason = null;
      drone.refuelStartedAt = null;
      drone.refuelUntil = null;
      const fuelCapacity = CONFIG.types[drone.type]?.fuelSeconds || CONFIG.fuelSeconds;
      drone.fuelRemainingSeconds = fuelCapacity;
      drone.launchedAt = now;
      drone.stateUntil = now + CONFIG.launchDurationSeconds * 1000;
      drone.vx = pose.nx * config.speed * 0.35;
      drone.vy = pose.ny * config.speed * 0.35;
      drone.angle = Math.atan2(pose.ny, pose.nx);
      const refueledSlot = bay.slots[drone.slot];
      if (refueledSlot) refueledSlot.state = "launching";
      room.effects.push({ type: "dronelaunch", subtype: drone.type, ownerId: drone.ownerId, x: drone.x, y: drone.y, at: now });
    }
    return;
  }
  if (!["returning", "docking"].includes(drone.state)) {
    const fuelCapacity = CONFIG.types[drone.type]?.fuelSeconds || CONFIG.fuelSeconds;
    if (!Number.isFinite(drone.fuelRemainingSeconds)) drone.fuelRemainingSeconds = fuelCapacity;
    drone.fuelRemainingSeconds = Math.max(0, drone.fuelRemainingSeconds - dt);
    if (drone.fuelRemainingSeconds <= 0) {
      drone.state = "returning";
      drone.returnReason = "fuel";
      drone.targetId = null;
      const fuelSlot = bay?.slots?.[drone.slot];
      if (fuelSlot) fuelSlot.state = "returning";
    }
  }
  if (drone.state === "returning" || drone.state === "docking") {
    steerDrone(drone, pose.x, pose.y, config.speed, config.turnRate, dt);
    const dockDx = drone.x - pose.x;
    const dockDy = drone.y - pose.y;
    const dockDistanceSq = dockDx * dockDx + dockDy * dockDy;
    if (dockDistanceSq < 30 * 30) {
      drone.state = "docking";
      const dockingSlot = bay.slots[drone.slot];
      if (dockingSlot) dockingSlot.state = "docking";
    }
    if (dockDistanceSq < 12 * 12) {
      const slot = bay.slots[drone.slot];
      if (drone.returnReason === "fuel" && bay.mode === "deployed") {
        drone.state = "refueling";
        drone.refuelStartedAt = now;
        drone.refuelUntil = now + CONFIG.refuelSeconds * 1000;
        drone.x = pose.x;
        drone.y = pose.y;
        drone.vx = 0;
        drone.vy = 0;
        slot.state = "refueling";
      } else {
        removeActiveDrone(room, drone);
        slot.droneId = null;
        slot.state = "stored";
      }
    }
    return;
  }
  let target = resolveDroneTarget(room, drone.targetId);
  const targetInvalid = !target
    || target.destroyed
    || target.alive === false
    || (target.life !== undefined && target.life <= 0);
  const parentDx = drone.x - parent.x;
  const parentDy = drone.y - parent.y;
  const outsideCommandRange = parentDx * parentDx + parentDy * parentDy > config.commandRange * config.commandRange;
  if (targetInvalid || outsideCommandRange) {
    drone.targetId = null;
    target = null;
    drone.nextDecisionAt = now;
    drone.nextThinkAt = now;
  }
  const nextDecisionAt = Number.isFinite(drone.nextDecisionAt)
    ? drone.nextDecisionAt
    : (Number.isFinite(drone.nextThinkAt) ? drone.nextThinkAt : now);
  if (now >= nextDecisionAt) {
    const selectedTarget = outsideCommandRange
      ? null
      : fallback
        ? chooseFallbackTarget(room, drone, parent, config)
        : chooseTarget(room, drone, parent, config);
    drone.targetId = selectedTarget?.id || null;
    drone.cachedEvasion = ((Number(config.evasionLookaheadSeconds) || 0) > 0 && (Number(config.evasionClearance) || 0) > 0)
      ? fighterProjectileEvasion(room, drone, config)
      : null;
    drone.nextDecisionAt = now + DRONE_DECISION_INTERVAL_MS;
    drone.nextThinkAt = drone.nextDecisionAt;
  }
  target = resolveDroneTarget(room, drone.targetId);
  const effectiveTarget = drone.targetId ? target : null;
  const anchor = effectiveTarget || parent;
  const orbit = config.orbitDistance || 80;
  const phase = ((Number.parseInt(String(drone.id).replace(/\D/g, ""), 10) || drone.slot) * 2.399) + now * 0.00055;
  const pathX = anchor.x + Math.cos(phase) * orbit;
  const pathY = anchor.y + Math.sin(phase) * orbit;
  // Evasion-capable drones (Fighter, Defence) use predictive projectile-dodging
  // steering; others (Repair) simply hold their orbit path.
  const canEvade = (Number(config.evasionLookaheadSeconds) || 0) > 0 && (Number(config.evasionClearance) || 0) > 0;
  if (canEvade && drone.cachedEvasion === undefined) {
    drone.cachedEvasion = fighterProjectileEvasion(room, drone, config);
  }
  if (canEvade) steerFighterDrone(room, drone, pathX, pathY, config, dt, now, drone.cachedEvasion || null);
  else steerDrone(drone, pathX, pathY, config.speed, config.turnRate, dt);
  const targetDx = effectiveTarget ? effectiveTarget.x - drone.x : Infinity;
  const targetDy = effectiveTarget ? effectiveTarget.y - drone.y : Infinity;
  const distanceSq = effectiveTarget ? targetDx * targetDx + targetDy * targetDy : Infinity;
  if (now < drone.nextActionAt) return;
  if (drone.type === "repair" && effectiveTarget?.componentHp && distanceSq <= config.repairRange * config.repairRange) {
    const amount = config.repairPerSecond / 5;
    repairShipComponents(room, effectiveTarget, amount, now);
    drone.nextActionAt = now + 200;
    room.effects.push({ type: "dronerepair", ownerId: drone.ownerId, x: drone.x, y: drone.y, x2: effectiveTarget.x, y2: effectiveTarget.y, at: now });
  } else if (drone.type !== "repair" && effectiveTarget && distanceSq <= config.weaponRange * config.weaponRange) {
    if (room.drones.get(effectiveTarget.id) === effectiveTarget) {
      damageDrone(room, effectiveTarget, config.damage, drone.ownerId, now);
    } else if (room.ships.get(effectiveTarget.id) === effectiveTarget) {
      damageShip(room, effectiveTarget, config.damage, drone.ownerId, now, drone.x, drone.y, { armorInteractionSeconds: 1 / config.fireRate });
    } else if (effectiveTarget.interceptable) {
      effectiveTarget.hp = Math.max(0, (Number(effectiveTarget.hp) || 0) - config.damage);
      if (effectiveTarget.hp <= 0) {
        removeProjectileRuntime(room, effectiveTarget);
        room.effects.push({ type: "burst", x: effectiveTarget.x, y: effectiveTarget.y, at: now });
      }
    }
    drone.nextActionAt = now + 1000 / config.fireRate;
    room.effects.push({ type: "droneshot", subtype: drone.type, ownerId: drone.ownerId, x: drone.x, y: drone.y, x2: effectiveTarget.x, y2: effectiveTarget.y, at: now });
  }
}

function advanceBayProduction(bay, dt, power, overheated, operational = true) {
  let producing = bay.slots.find((slot) => slot.state === "producing");
  if (!producing && operational) {
    producing = bay.slots.find((slot) => slot.state === "destroyed");
    if (producing) producing.state = "producing";
  }
  if (!producing) return null;
  if (!operational) {
    producing.pauseReason = "bay-destroyed";
    return producing;
  }
  if (overheated) {
    producing.pauseReason = "bay-overheated";
    return producing;
  }
  const duration = CONFIG.types[bay.droneType]?.productionSeconds;
  if (!(duration > 0)) {
    producing.pauseReason = "invalid-configuration";
    return producing;
  }
  // Underpowered bays build slowly rather than stalling: production progress
  // already scales with the delivered power fraction (dt * power / duration), so
  // partial power simply means a slower build. Only an essentially unpowered bay
  // (no meaningful allocation) makes no progress at all.
  if (power <= 0.02) {
    producing.pauseReason = "insufficient-power";
    return producing;
  }
  producing.pauseReason = power < 0.98 ? "low-power" : null;
  producing.productionProgress = Math.min(1, producing.productionProgress + dt * power / duration);
  if (producing.productionProgress >= 1) producing.state = bay.mode === "deployed" ? "ready" : "stored";
  return producing;
}

function updateDroneBays(room, ships, dt, now) {
  ensureDroneRuntime(room);
  room.droneSpatialPadding = Math.max(
    0,
    ...Object.values(CONFIG.types || {}).map((entry) => Number(entry?.speed) || 0)
  ) * Math.max(0, Number(dt) || 0) * 1.75 + 2;
  for (const ship of ships) {
    if (!ship.droneBays) initializeDroneBays(room, ship, now);
    else indexDroneBays(ship);
    const inSpawnZone = isInOwnSpawnZone(room, ship);
    for (const bay of ship.droneBays) {
      bay.launchBlockedBySpawn = inSpawnZone;
      const operational = (ship.componentHp?.[bay.componentIndex] ?? 0) > 0;
      if (!operational) {
        advanceBayProduction(bay, dt, 0, false, false);
        continue;
      }
      const power = getComponentPowerMultiplier(ship, bay.componentIndex);
      const overheated = (ship.componentHeatState?.[bay.componentIndex] || HeatRules.STATE.NORMAL) >= HeatRules.STATE.OVERHEATED;
      advanceBayProduction(bay, dt, power, overheated, true);
      const producing = bay.slots.some((slot) => slot.state === "producing");
      const active = bay.slots.some((slot) => ["launching", "active", "returning", "docking", "refueling"].includes(slot.state));
      const heatPerSecond = producing ? CONFIG.productionHeatPerSecond : active ? CONFIG.activeHeatPerSecond : CONFIG.standbyHeatPerSecond;
      addComponentHeat(ship, bay.componentIndex, heatPerSecond * power * dt);
      if (inSpawnZone || bay.mode !== "deployed" || now < bay.nextLaunchAt || power <= MIN_BAY_OPERATING_POWER || overheated) continue;
      const ready = bay.slots.find((slot) => slot.state === "ready" || slot.state === "stored");
      if (ready) {
        spawnDrone(room, ship, bay, ready, now);
        // Underpowered bays launch on a longer cadence rather than not at all;
        // the interval stretches as delivered power drops (clamped so a barely
        // powered bay is slow, not frozen).
        bay.nextLaunchAt = now + CONFIG.launchIntervalSeconds * 1000 / Math.max(0.35, power);
      }
    }
  }
  const movement = room._droneMovementScratch || (room._droneMovementScratch = []);
  let movementCount = 0;
  for (const drone of room.drones.values()) {
    const previousX = drone.x;
    const previousY = drone.y;
    updateDroneEntity(room, drone, dt, now);
    resolveDroneMapCollision(room, drone, previousX, previousY);
    const record = movement[movementCount] || (movement[movementCount] = {});
    record.drone = drone;
    record.previousX = previousX;
    record.previousY = previousY;
    record.postSeparationX = drone.x;
    record.postSeparationY = drone.y;
    movementCount += 1;
  }
  movement.length = movementCount;
  resolveDroneSeparation(
    room.drones.values(),
    room._droneSeparationScratch || (room._droneSeparationScratch = []),
    room.spatialIndex,
    room.droneSpatialPadding
  );
  // Track displaced drones without allocating a new Set every tick
  const displaced = room._droneDisplacedScratch || (room._droneDisplacedScratch = []);
  let displacedCount = 0;
  for (const record of movement) {
    const { drone, previousX, previousY, postSeparationX, postSeparationY } = record;
    if (room.drones.get(drone.id) !== drone) continue;
    const dx = drone.x - postSeparationX;
    const dy = drone.y - postSeparationY;
    const displacement = Math.sqrt(dx * dx + dy * dy);
    if (displacement > 0.001) {
      displaced[displacedCount] = drone;
      displacedCount += 1;
    }
    const totalDx = drone.x - previousX;
    const totalDy = drone.y - previousY;
    const totalDisplacement = Math.sqrt(totalDx * totalDx + totalDy * totalDy) + 2;
    if (totalDisplacement > room.droneSpatialPadding) room.droneSpatialPadding = totalDisplacement;
  }
  displaced.length = displacedCount;
  // Rerun collision resolution only for drones actually displaced by separation
  for (let i = 0; i < displacedCount; i += 1) {
    const drone = displaced[i];
    if (drone && room.drones.get(drone.id) === drone) {
      resolveDroneMapCollision(room, drone);
    }
  }
}

function setDroneBayMode(room, player, shipId, componentId, mode, now = Date.now()) {
  const ship = room.ships.get(String(shipId || ""));
  if (!ship?.alive || ship.ownerId !== player?.id) return false;
  const bay = droneBayById(ship, componentId);
  if (!bay || !["deployed", "recalled"].includes(mode)) return false;
  bay.mode = mode;
  const operational = (ship.componentHp?.[bay.componentIndex] ?? 0) > 0;
  const powered = operational && getComponentPowerMultiplier(ship, bay.componentIndex) > MIN_BAY_OPERATING_POWER;
  if (mode === "recalled") {
    for (const slot of bay.slots) if (slot.state === "ready") slot.state = "stored";
    for (const drone of room.drones?.values?.() || []) {
      if (drone.destroyed || drone.parentShipId !== ship.id || drone.bayComponentId !== bay.componentId) continue;
      drone.commandState = "recalled";
      drone.targetId = null;
      drone.returnReason = "recall";
      if (operational) drone.state = "returning";
      const slot = bay.slots[drone.slot];
      if (slot && operational) slot.state = "returning";
    }
  } else {
    // A Deploy command cancels an unfinished recall. Drones still in space
    // resume immediately; already stored drones enter the launch queue.
    bay.nextLaunchAt = Math.min(Number(bay.nextLaunchAt) || now, now);
    for (const slot of bay.slots) if (slot.state === "stored") slot.state = "ready";
    for (const drone of room.drones?.values?.() || []) {
      if (drone.destroyed || drone.parentShipId !== ship.id || drone.bayComponentId !== bay.componentId) continue;
      drone.commandState = powered ? "deployed" : "fallback";
      drone.targetId = null;
      if (["returning", "docking"].includes(drone.state) && drone.returnReason !== "fuel") {
        drone.state = powered ? "active" : "fallback";
        drone.returnReason = null;
      }
      const slot = bay.slots[drone.slot];
      if (slot && ["returning", "docking"].includes(slot.state)) slot.state = drone.state;
      drone.nextThinkAt = Math.min(Number(drone.nextThinkAt) || now, now);
      drone.nextDecisionAt = Math.min(Number(drone.nextDecisionAt) || now, now);
    }
  }
  return true;
}

function buildDroneSnapshots(room, now) {
  return [...(room.drones?.values?.() || [])].map((drone) => ({
    id: drone.id,
      ownerId: drone.ownerId,
      parentShipId: drone.parentShipId,
      bayComponentId: drone.bayComponentId,
    type: drone.type,
    state: drone.state,
    x: Math.round(drone.x * 100) / 100,
    y: Math.round(drone.y * 100) / 100,
    vx: Math.round(drone.vx * 100) / 100,
    vy: Math.round(drone.vy * 100) / 100,
    angle: Math.round(drone.angle * 1000) / 1000,
    radius: Number(drone.radius) || 10,
    hull: Math.max(0, Math.round(drone.hull * 10) / 10),
      maxHull: drone.maxHull,
      targetId: drone.targetId,
      fuelRemainingSeconds: Math.round(Math.max(0, Number(drone.fuelRemainingSeconds) || 0) * 100) / 100,
      fuelCapacitySeconds: (CONFIG.types[drone.type]?.fuelSeconds || CONFIG.fuelSeconds),
      stateProgress: drone.state === "launching"
        ? Math.max(0, Math.min(1, 1 - (drone.stateUntil - now) / (CONFIG.launchDurationSeconds * 1000)))
        : drone.state === "refueling"
          ? Math.max(0, Math.min(1, (now - drone.refuelStartedAt) / (CONFIG.refuelSeconds * 1000)))
          : 1
  }));
}

function buildBaySnapshots(ship) {
  return (ship.droneBays || []).map((bay) => {
    const pose = bayWorldPose(ship, bay);
    const producing = bay.slots.find((slot) => slot.state === "producing");
    const operational = ship.alive !== false && (ship.componentHp?.[bay.componentIndex] ?? 0) > 0;
    const powerFraction = operational ? getComponentPowerMultiplier(ship, bay.componentIndex) : 0;
    const overheated = operational && (ship.componentHeatState?.[bay.componentIndex] || HeatRules.STATE.NORMAL) >= HeatRules.STATE.OVERHEATED;
    return {
      componentId: bay.componentId,
      componentIndex: bay.componentIndex,
      droneType: bay.droneType,
      commandRange: Number(CONFIG.types[bay.droneType]?.commandRange) || 0,
      squadSize: CONFIG.squadSize,
      activeCount: bay.slots.filter((slot) => ["launching", "active", "returning", "docking", "refueling"].includes(slot.state)).length,
      refuelingCount: bay.slots.filter((slot) => slot.state === "refueling").length,
      storedCount: bay.slots.filter((slot) => ["stored", "ready"].includes(slot.state)).length,
      mode: bay.mode,
      launchBlockedBySpawn: Boolean(bay.launchBlockedBySpawn),
      operational,
      powerFraction: Math.round(Math.max(0, Number(powerFraction) || 0) * 1000) / 1000,
      overheated,
      runtimePowerMw: bayPowerRequest(ship, bay.componentIndex),
      producingSlot: producing?.slot ?? null,
      productionProgress: producing?.productionProgress ?? null,
      productionPausedReason: producing?.pauseReason ?? (ship.alive === false ? "parent-destroyed" : operational ? null : "bay-destroyed"),
      launchState: bay.slots.some((slot) => slot.state === "launching") ? "launching" : "idle",
      x: Math.round(pose.x * 10) / 10,
      y: Math.round(pose.y * 10) / 10,
      slots: bay.slots.map((slot) => ({
        state: slot.state,
        droneId: slot.droneId,
        progress: Math.round((slot.productionProgress || 0) * 1000) / 1000,
        pauseReason: slot.pauseReason
      }))
    };
  });
}

module.exports = {
  CONFIG,
  initializeDroneBays,
  ensureDroneRuntime,
  resetDroneRuntime,
  ownerActiveCount,
  shipActiveCount,
  bayPowerRequest,
  bayWorldPose,
  updateDroneBays,
  damageDrone,
  setDroneDestroyed,
  setDroneBayMode,
  buildDroneSnapshots,
  buildBaySnapshots,
  _test: {
    spawnDrone,
    chooseTarget,
    chooseFallbackTarget,
    nearestHostileMissile,
    fighterProjectileEvasion,
    steerFighterDrone,
    updateDroneEntity,
    advanceBayProduction,
    isInOwnSpawnZone,
    resolveDroneMapCollision,
    resolveDroneSeparation
  }
};
