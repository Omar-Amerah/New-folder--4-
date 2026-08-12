"use strict";

const { compareIdStrings } = require("../utils");
const { getShipRepairCache } = require("../repairCache");
const { ensureProjectileLookup } = require("../projectiles");
const Relationships = require("../relationships");
const { canTeamTargetEntity } = require("../visibility");
const { bump } = require("../roomTelemetry");
const DroneDecisionContext = require("../droneDecisionContext");

const { areEnemies, areAllies } = Relationships;

function shipRepairNeed(ship) {
  return getShipRepairCache(ship).need;
}

function ensureDroneTargetRuntime(drone) {
  if (!drone) return null;
  return drone._targetRuntime || (drone._targetRuntime = {
    id: null,
    kind: null,
    entity: null,
    roomEpoch: null
  });
}

function markDroneDecisionInvalidated(room, drone, reason = "unknown") {
  if (!drone) return;
  drone.decisionInvalidated = true;
  drone._decisionInvalidationReason = reason;
  // This counter represents decision invalidation churn, not only target
  // reference loss. Focus changes, Bay revisions, power transitions and
  // recall/deploy events all force the same immediate decision path.
  bump(room, "droneTargetsInvalidated");
}

function targetKind(room, target) {
  if (!target) return null;
  if (room.drones?.get?.(target.id) === target) return "drone";
  if (room.ships?.get?.(target.id) === target) return "ship";
  if (target.life !== undefined || target.interceptable) return "projectile";
  return null;
}

function rememberDroneTarget(room, drone, target) {
  const runtime = ensureDroneTargetRuntime(drone);
  if (!runtime) return null;
  if (!target) {
    runtime.id = null;
    runtime.kind = null;
    runtime.entity = null;
    runtime.roomEpoch = room?.stateEpoch ?? null;
    drone.targetId = null;
    return null;
  }
  const kind = targetKind(room, target);
  runtime.id = target.id ?? null;
  runtime.kind = kind;
  runtime.entity = target;
  runtime.roomEpoch = room?.stateEpoch ?? null;
  if (kind === "projectile" && target.id) ensureProjectileLookup(room).set(target.id, target);
  drone.targetId = target.id ?? null;
  return target;
}

function clearDroneTarget(room, drone, invalidate = true) {
  rememberDroneTarget(room, drone, null);
  if (invalidate) markDroneDecisionInvalidated(room, drone, "target");
}

function targetIsLiveInMap(room, kind, id, entity) {
  if (!entity || !id) return false;
  if (kind === "ship") return room.ships?.get?.(id) === entity && entity.alive !== false && !entity.destroyed;
  if (kind === "drone") return room.drones?.get?.(id) === entity && !entity.destroyed && !entity.removed;
  if (kind === "projectile") return ensureProjectileLookup(room).get(id) === entity && Number(entity.life) > 0;
  return false;
}

function droneTargetRelationshipValid(room, drone, target, kind, now) {
  if (!target || kind === "projectile") return kind === "projectile" && areEnemies(room, drone.ownerId, target.ownerId) && Number(target.life) > 0;
  if (!canTeamTargetEntity(room, drone.ownerId, target, now)) return false;
  return drone.type === "repair"
    ? areAllies(room, drone.ownerId, target.ownerId)
    : areEnemies(room, drone.ownerId, target.ownerId);
}

function resolveDroneTarget(room, targetId) {
  if (!targetId) return null;
  return room.drones?.get?.(targetId)
    || room.ships?.get?.(targetId)
    || ensureProjectileLookup(room).get(targetId)
    || null;
}

function resolveCachedDroneTarget(room, drone, now) {
  const runtime = ensureDroneTargetRuntime(drone);
  if (!drone?.targetId) return null;
  if (!runtime || runtime.id !== drone.targetId || runtime.roomEpoch !== (room.stateEpoch ?? null)) {
    const resolved = resolveDroneTarget(room, drone.targetId);
    if (!resolved) {
      bump(room, "droneTargetReferenceMisses");
      clearDroneTarget(room, drone, true);
      return null;
    }
    rememberDroneTarget(room, drone, resolved);
    bump(room, "droneTargetReferenceMisses");
  } else if (runtime.entity && targetIsLiveInMap(room, runtime.kind, runtime.id, runtime.entity)) {
    bump(room, "droneTargetReferenceHits");
  } else {
    bump(room, "droneTargetReferenceMisses");
    clearDroneTarget(room, drone, true);
    return null;
  }
  const current = ensureDroneTargetRuntime(drone)?.entity;
  const kind = ensureDroneTargetRuntime(drone)?.kind;
  if (!targetIsLiveInMap(room, kind, drone.targetId, current) || !droneTargetRelationshipValid(room, drone, current, kind, now)) {
    clearDroneTarget(room, drone, true);
    return null;
  }
  bump(room, "droneValidTargetsRetained");
  return current;
}

function droneContextMembers(room, parent, bay, type) {
  const key = DroneDecisionContext.contextKey(
    parent?.id,
    bay?.componentId,
    type,
    parent?.ownerId,
    parent?.team || room.players?.get?.(parent?.ownerId)?.team || null
  );
  const lists = room._droneContextMemberScratch || (room._droneContextMemberScratch = new Map());
  let members = lists.get(key);
  if (!members) {
    members = [];
    lists.set(key, members);
  }
  return members;
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

function nearestEnemyDrone(room, drone, maximumRange, now, candidateSource = null) {
  let best = null;
  let bestDistanceSq = maximumRange * maximumRange;
  const candidates = candidateSource || nearbyCandidates(room, drone, "drones", drone.x, drone.y, maximumRange, room.drones.values(), true);
  for (const other of candidates) {
    if (other.id === drone.id || other.destroyed || other.removed || room.drones.get(other.id) !== other || !areEnemies(room, drone.ownerId, other.ownerId)) continue;
    if (!canTeamTargetEntity(room, drone.ownerId, other, now)) continue;
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

function nearestHostileMissile(room, drone, maximumRange, candidateSource = null) {
  let best = null;
  let bestDistanceSq = maximumRange * maximumRange;
  const candidates = candidateSource || nearbyCandidates(room, drone, "interceptableProjectiles", drone.x, drone.y, maximumRange, room.bullets || [], true);
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

function nearestEnemyShip(room, drone, maximumRange, now, candidateSource = null) {
  let best = null;
  let bestDistanceSq = maximumRange * maximumRange;
  const candidates = candidateSource || nearbyCandidates(room, drone, "ships", drone.x, drone.y, maximumRange, room.ships.values(), true);
  for (const ship of candidates) {
    if (!ship.alive || !areEnemies(room, drone.ownerId, ship.ownerId)) continue;
    if (!canTeamTargetEntity(room, drone.ownerId, ship, now)) continue;
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

function importantComponentDamageFraction(ship) {
  return getShipRepairCache(ship).importantDamageFraction;
}

function repairTargetScore(ship, need, distance, config) {
  const range = Math.max(1, config.commandRange || 1);
  const distanceFactor = 1 - Math.min(1, distance / range);
  return need * (1 + importantComponentDamageFraction(ship)) + distanceFactor * 25;
}

function chooseTarget(room, drone, parent, config, now, context = null) {
  if (drone.type === "repair") {
    if (shipRepairNeed(parent) > 0) return parent;
    let best = null;
    let bestScore = -Infinity;
    const candidates = context?.repairShips || nearbyCandidates(room, drone, "ships", parent.x, parent.y, config.commandRange, room.ships.values());
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
      if (score > bestScore || (score === bestScore && (!best || compareIdStrings(ship.id, best.id) < 0))) {
        best = ship;
        bestScore = score;
      }
    }
    return best || parent;
  }
  if (drone.type === "defence") {
    const missile = nearestHostileMissile(room, drone, config.commandRange, context?.hostileProjectiles);
    if (missile) return missile;
  }
  const hostileDrone = nearestEnemyDrone(room, drone, drone.type === "defence" ? config.commandRange : config.weaponRange, now, context?.hostileDrones);
  if (hostileDrone) return hostileDrone;
  if (drone.type === "fighter" && parent.focusTargetId) {
    const focused = room.ships.get(parent.focusTargetId);
    if (focused?.alive && areEnemies(room, drone.ownerId, focused.ownerId)
      && canTeamTargetEntity(room, drone.ownerId, focused, now)) return focused;
  }
  return nearestEnemyShip(room, drone, config.commandRange, now, context?.hostileShips);
}

function chooseFallbackTarget(room, drone, parent, config, now, context = null) {
  if (drone.type === "repair") return parent;
  return (drone.type === "defence" ? nearestHostileMissile(room, drone, config.weaponRange, context?.hostileProjectiles) : null)
    || nearestEnemyDrone(room, drone, config.weaponRange, now, context?.hostileDrones)
    || nearestEnemyShip(room, drone, config.weaponRange, now, context?.hostileShips);
}

module.exports = {
  markDroneDecisionInvalidated,
  rememberDroneTarget,
  clearDroneTarget,
  resolveCachedDroneTarget,
  droneContextMembers,
  nearbyCandidates,
  chooseTarget,
  chooseFallbackTarget,
  nearestHostileMissile
};
