"use strict";

// Shared Point Defence threat candidate set for Phase Three.
// One candidate superset is built per defending ship/station per refresh
// interval. Each live PD mount then filters and selects from that superset
// without performing an independent full spatial search.

const { PARTS } = require("./components");
const { getShipComponentIndexes } = require("./componentIndexes");
const { isComponentAlive } = require("./componentHealth");
const { getEffectiveWeaponStatsInternal } = require("./componentData");
const { fastHypot } = require("./utils");
const Relationships = require("./relationships");
const Visibility = require("./visibility");
const Targeting = require("./targetingEligibility");

const PD_REFRESH_MS = 1000 / 12; // 12 Hz
const POSITION_STALE_SQ = 0.5 * 0.5; // half-metre movement rebuilds the set

function _viewerTeam(room, ownerId, team) {
  if (!ownerId) return team || null;
  const player = room?.players?.get?.(ownerId);
  return player?.team || team || null;
}

function _getPointDefenceIndices(entity) {
  const indexes = getShipComponentIndexes(entity).weaponIndices.filter((i) => {
    const module = entity?.design?.[i];
    if (!module) return false;
    const part = PARTS[module.type] || PARTS.frame;
    return (part.weapon?.type || "") === "pointDefense" && isComponentAlive(entity, i);
  });
  return indexes;
}

function _maxPointDefenceRange(entity) {
  const pdIndices = _getPointDefenceIndices(entity);
  let maxRange = 0;
  for (const i of pdIndices) {
    const effective = getEffectiveWeaponStatsInternal(entity, i);
    const range = effective?.range || PARTS[entity.design[i].type]?.weapon?.range || 0;
    if (range > maxRange) maxRange = range;
  }
  return Math.max(1, maxRange);
}

function _buildCandidateList(room, entity, identity, maxRange, now) {
  const candidates = [];
  const x = entity.x || 0;
  const y = entity.y || 0;
  const rangeSq = maxRange * maxRange;
  const viewerTeam = _viewerTeam(room, identity, entity.team);

  const spatial = room?.spatialIndex;
  const scratch = room?._pdThreatScratch || { projectiles: [], drones: [], ships: [] };

  const projectiles = spatial && spatial.dynamicValid
    ? spatial.queryRangeUnordered("interceptableProjectiles", x, y, maxRange, scratch.projectiles)
    : (room?.bullets || []);

  for (const bullet of projectiles) {
    if (!bullet.interceptable || bullet.life <= 0) continue;
    if (!Relationships.areEnemies(room, identity, bullet.ownerId)) continue;
    const dx = bullet.x - x;
    const dy = bullet.y - y;
    if (dx * dx + dy * dy > rangeSq) continue;
    candidates.push({ type: "projectile", entity: bullet });
  }

  const dronePadding = Number(room?.droneSpatialPadding) || 0;
  const drones = spatial && spatial.dynamicValid
    ? spatial.queryRangeUnordered("drones", x, y, maxRange + dronePadding, scratch.drones)
    : (room?.drones ? [...room.drones.values()] : []);

  for (const drone of drones) {
    if (drone.destroyed || drone.removed || room?.drones?.get?.(drone.id) !== drone) continue;
    if (!Relationships.areEnemies(room, identity, drone.ownerId)) continue;
    if (Visibility.usesSensorVisibility(room) && viewerTeam && !Visibility.canTeamTargetEntity(room, viewerTeam, drone, now)) continue;
    const dx = drone.x - x;
    const dy = drone.y - y;
    if (dx * dx + dy * dy > rangeSq) continue;
    candidates.push({ type: "drone", entity: drone });
  }

  const ships = spatial && spatial.dynamicValid
    ? spatial.queryRangeUnordered("ships", x, y, maxRange, scratch.ships)
    : (room?.ships || []);

  for (const ship of ships) {
    if (ship.id === entity.id) continue;
    if (!ship.alive || !Relationships.areEntityEnemies(room, identity, ship)) continue;
    if (Visibility.usesSensorVisibility(room) && viewerTeam && !Visibility.canTeamTargetEntity(room, viewerTeam, ship, now)) continue;
    const dx = ship.x - x;
    const dy = ship.y - y;
    if (dx * dx + dy * dy > rangeSq) continue;
    candidates.push({ type: "ship", entity: ship });
  }

  const decoys = room?.decoys ? [...room.decoys.values()] : [];
  for (const decoy of decoys) {
    if (now >= decoy.expiresAt) continue;
    if (!Relationships.areEnemies(room, identity, decoy.ownerId)) continue;
    const dx = decoy.x - x;
    const dy = decoy.y - y;
    if (dx * dx + dy * dy > rangeSq) continue;
    candidates.push({ type: "decoy", entity: decoy });
  }

  return candidates;
}

function _signature(room, entity, now) {
  const pdIndices = _getPointDefenceIndices(entity);
  const maxRange = _maxPointDefenceRange(entity);
  return {
    now,
    x: entity.x || 0,
    y: entity.y || 0,
    pdIndices,
    maxRange,
    identity: Relationships.entityRelationshipOwnerId(room, entity) || entity.ownerId
  };
}

function _signatureChanged(threatSet, room, entity, now) {
  if (!threatSet) return true;
  if (now >= threatSet.nextRefreshAt) return true;

  const sig = _signature(room, entity, now);
  if (sig.maxRange !== threatSet.maxRange) return true;
  if (sig.pdIndices.length !== threatSet.pdIndices.length) return true;
  for (let i = 0; i < sig.pdIndices.length; i += 1) {
    if (sig.pdIndices[i] !== threatSet.pdIndices[i]) return true;
  }
  if (Relationships.entityRelationshipOwnerId(room, entity) !== threatSet.identity) return true;

  const dx = sig.x - threatSet.x;
  const dy = sig.y - threatSet.y;
  return dx * dx + dy * dy > POSITION_STALE_SQ;
}

function ensurePointDefenceThreatSet(room, entity, identity, now) {
  const force = !entity._pdThreatSet || _signatureChanged(entity._pdThreatSet, room, entity, now);

  if (!force) return entity._pdThreatSet;

  const maxRange = _maxPointDefenceRange(entity);
  const pdIndices = _getPointDefenceIndices(entity);
  const candidates = _buildCandidateList(room, entity, identity, maxRange, now);

  // Reuse the old candidate array objects when possible to avoid churn.
  if (!entity._pdThreatSet) {
    entity._pdThreatSet = { candidates: [], maxRange: 0, x: 0, y: 0, nextRefreshAt: 0 };
  }

  const old = entity._pdThreatSet.candidates;
  const updated = entity._pdThreatSet.candidates = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const cand = candidates[i];
    let entry = old[i];
    if (!entry) {
      entry = {};
    }
    entry.type = cand.type;
    entry.entity = cand.entity;
    updated.push(entry);
  }

  entity._pdThreatSet.maxRange = maxRange;
  entity._pdThreatSet.pdIndices = pdIndices;
  entity._pdThreatSet.x = entity.x || 0;
  entity._pdThreatSet.y = entity.y || 0;
  entity._pdThreatSet.identity = identity;
  entity._pdThreatSet.nextRefreshAt = now + PD_REFRESH_MS;

  return entity._pdThreatSet;
}

function invalidatePointDefenceThreatSet(entity) {
  if (entity?._pdThreatSet) entity._pdThreatSet = null;
}

function invalidateAllPointDefenceThreatSets(room) {
  if (!room) return;
  for (const ship of room.ships || []) invalidatePointDefenceThreatSet(ship);
  for (const station of room.stations || []) invalidatePointDefenceThreatSet(station);
}

// Select a single PD target from the shared threat set for one mount.
// `canSee(x, y, entity)` is the mount's line-of-sight predicate.
// `reservations` is a Map for overkill tracking.
function selectPointDefenceTarget(room, originX, originY, shipOwnerId, weapon, protectedShipId, now, threatSet, canSee, reservations = null) {
  if (!threatSet || !threatSet.candidates.length) return null;

  const rangeSq = (weapon.range || 0) * (weapon.range || 0);
  const priorityList = weapon.targetPriority || ["missile", "torpedo", "projectile", "droneFighter", "droneOther", "drone", "ship"];

  let best = null;
  let bestDistSq = Infinity;

  for (const cand of threatSet.candidates) {
    const ent = cand.entity;
    if (!ent) continue;

    const dx = ent.x - originX;
    const dy = ent.y - originY;
    const distSq = dx * dx + dy * dy;
    if (distSq > rangeSq) continue;

    if (canSee && !canSee(cand)) continue;

    if (!Targeting.isPointDefenceTargetValid(room, shipOwnerId, cand, Math.sqrt(rangeSq), now, {
      originX,
      originY,
      team: _viewerTeam(room, shipOwnerId, null),
      reservations
    })) continue;

    if (Targeting.isCandidateBetter(cand, distSq, best, bestDistSq, priorityList, protectedShipId, room, shipOwnerId)) {
      best = cand;
      bestDistSq = distSq;
    }
  }

  return best;
}

module.exports = {
  ensurePointDefenceThreatSet,
  selectPointDefenceTarget,
  invalidatePointDefenceThreatSet,
  invalidateAllPointDefenceThreatSets,
  _maxPointDefenceRange
};
