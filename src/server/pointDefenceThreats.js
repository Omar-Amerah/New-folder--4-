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
const StationTemplates = require("./stationTemplates");
const TargetingTelemetry = require("./targetingTelemetry");

const PD_REFRESH_MS = 1000 / 12; // 12 Hz
const MOTION_PADDING = 150; // metres of motion covered between 12 Hz refreshes
const SHIP_MODULE_SCALE = 13;
const STATION_MODULE_SCALE = StationTemplates.STATION_MODULE_SCALE;
const GRID_CENTER = 7;

function _viewerTeam(room, ownerId, team) {
  if (!ownerId) return team || null;
  const player = room?.players?.get?.(ownerId);
  return player?.team || team || null;
}

function _moduleCentreToLocal(module, scale) {
  const part = PARTS[module.type] || PARTS.frame;
  const footprint = part.footprint || { width: 1, height: 1 };
  const width = Number(footprint.width) || 1;
  const height = Number(footprint.height) || 1;
  const cx = (Number(module.x) || 0) + (width - 1) / 2;
  const cy = (Number(module.y) || 0) + (height - 1) / 2;
  return {
    x: (GRID_CENTER - cy) * scale,
    y: (cx - GRID_CENTER) * scale
  };
}

function _entityModuleScale(entity) {
  // Stations use the station module scale; everything else uses ship scale.
  return entity?.type === "station" ? STATION_MODULE_SCALE : SHIP_MODULE_SCALE;
}

function _getPointDefenceMetadata(entity) {
  const scale = _entityModuleScale(entity);
  const indexes = getShipComponentIndexes(entity).weaponIndices;
  const pdIndices = [];
  let maxRange = 0;
  let maxOffset = 0;
  for (const i of indexes) {
    const module = entity?.design?.[i];
    if (!module) continue;
    const part = PARTS[module.type] || PARTS.frame;
    if ((part.weapon?.type || "") !== "pointDefense") continue;
    if (!isComponentAlive(entity, i)) continue;
    pdIndices.push(i);
    const effective = getEffectiveWeaponStatsInternal(entity, i);
    const range = effective?.range || part.weapon?.range || 0;
    if (range > maxRange) maxRange = range;
    const local = _moduleCentreToLocal(module, scale);
    const offset = fastHypot(local.x, local.y);
    if (offset > maxOffset) maxOffset = offset;
  }
  return {
    pdIndices,
    maxRange: Math.max(1, maxRange),
    maxOffset,
    queryRadius: Math.max(1, maxRange) + maxOffset + MOTION_PADDING
  };
}

function _buildCandidateList(room, entity, identity, queryRadius, now) {
  const candidates = [];
  const x = entity.x || 0;
  const y = entity.y || 0;
  const viewerTeam = _viewerTeam(room, identity, entity.team);

  const spatial = room?.spatialIndex;
  const scratch = room?._pdThreatScratch || { projectiles: [], drones: [], ships: [] };

  const projectiles = spatial && spatial.dynamicValid
    ? spatial.queryRangeUnordered("interceptableProjectiles", x, y, queryRadius, scratch.projectiles)
    : (room?.bullets || []);

  for (const bullet of projectiles) {
    if (!bullet.interceptable || bullet.life <= 0) continue;
    if (!Relationships.areEnemies(room, identity, bullet.ownerId)) continue;
    candidates.push({ type: "projectile", entity: bullet });
  }

  const dronePadding = Number(room?.droneSpatialPadding) || 0;
  const drones = spatial && spatial.dynamicValid
    ? spatial.queryRangeUnordered("drones", x, y, queryRadius + dronePadding, scratch.drones)
    : (room?.drones ? [...room.drones.values()] : []);

  for (const drone of drones) {
    if (drone.destroyed || drone.removed || room?.drones?.get?.(drone.id) !== drone) continue;
    if (!Relationships.areEnemies(room, identity, drone.ownerId)) continue;
    if (Visibility.usesSensorVisibility(room) && viewerTeam && !Visibility.canTeamTargetEntity(room, viewerTeam, drone, now)) continue;
    candidates.push({ type: "drone", entity: drone });
  }

  const ships = spatial && spatial.dynamicValid
    ? spatial.queryRangeUnordered("ships", x, y, queryRadius, scratch.ships)
    : (room?.ships ? [...room.ships.values()] : []);

  for (const ship of ships) {
    if (ship.id === entity.id) continue;
    if (!ship.alive || !Relationships.areEntityEnemies(room, identity, ship)) continue;
    if (Visibility.usesSensorVisibility(room) && viewerTeam && !Visibility.canTeamTargetEntity(room, viewerTeam, ship, now)) continue;
    candidates.push({ type: "ship", entity: ship });
  }

  const decoys = room?.decoys ? [...room.decoys.values()] : [];
  for (const decoy of decoys) {
    if (now >= decoy.expiresAt) continue;
    if (!Relationships.areEnemies(room, identity, decoy.ownerId)) continue;
    candidates.push({ type: "decoy", entity: decoy });
  }

  return candidates;
}

function _entityRelevantRevisions(entity) {
  return {
    designRevision: entity?.designRevision || 1,
    componentAliveRevision: entity?.componentAliveRevision || 1,
    heatStateRevision: entity?.heatStateRevision || 0,
    powerRevision: entity?.powerRevision || 0,
    dataSupportTopology: entity?.runtimeDataSupport?.topologyRevision || 0,
    dataSupportAllocation: entity?.runtimeDataSupport?.allocationRevision || 0
  };
}

function _signature(room, entity, meta) {
  const rev = _entityRelevantRevisions(entity);
  return {
    stateEpoch: room?.stateEpoch || 1,
    spatialBuiltAt: room?.spatialIndex?.builtAt || 0,
    pdIndices: meta.pdIndices,
    maxRange: meta.maxRange,
    maxOffset: meta.maxOffset,
    queryRadius: meta.queryRadius,
    identity: Relationships.entityRelationshipOwnerId(room, entity) || entity.ownerId,
    ...rev
  };
}

function _signatureChanged(threatSet, room, entity, now, meta) {
  if (!threatSet) return true;
  if (now >= threatSet.nextRefreshAt) return true;

  const prev = threatSet._signature;
  if (!prev) return true;

  const next = _signature(room, entity, meta);
  const keys = Object.keys(next);
  for (const k of keys) {
    if (Array.isArray(next[k])) {
      const a = next[k];
      const b = prev[k] || [];
      if (a.length !== b.length) return true;
      for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return true;
    } else if (next[k] !== prev[k]) {
      return true;
    }
  }
  return false;
}

function _reuseCandidateArray(threatSet, candidates) {
  if (!threatSet) return candidates;
  const old = threatSet.candidates;
  const updated = threatSet.candidates = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const cand = candidates[i];
    let entry = old[i];
    if (!entry) entry = {};
    entry.type = cand.type;
    entry.entity = cand.entity;
    updated.push(entry);
  }
  // Trim any extra old entries so the array length matches.
  old.length = candidates.length;
  updated.length = candidates.length;
  return updated;
}

function ensurePointDefenceThreatSet(room, entity, identity, now) {
  const meta = _getPointDefenceMetadata(entity);
  const force = _signatureChanged(entity._pdThreatSet, room, entity, now, meta);

  if (force) {
    const candidates = _buildCandidateList(room, entity, identity, meta.queryRadius, now);

    if (!entity._pdThreatSet) {
      entity._pdThreatSet = { candidates: [], maxRange: 0, x: 0, y: 0, nextRefreshAt: 0 };
    }

    _reuseCandidateArray(entity._pdThreatSet, candidates);
    entity._pdThreatSet.maxRange = meta.maxRange;
    entity._pdThreatSet.queryRadius = meta.queryRadius;
    entity._pdThreatSet.maxOffset = meta.maxOffset;
    entity._pdThreatSet.pdIndices = meta.pdIndices;
    entity._pdThreatSet.x = entity.x || 0;
    entity._pdThreatSet.y = entity.y || 0;
    entity._pdThreatSet.identity = identity;
    entity._pdThreatSet.nextRefreshAt = now + PD_REFRESH_MS;
    entity._pdThreatSet._signature = _signature(room, entity, meta);
    entity._pdThreatSet._candidatesLength = candidates.length;

    TargetingTelemetry.bump(room, "pointDefenceThreatSetBuilds");
    TargetingTelemetry.setCounter(room, "pointDefenceThreatCandidates", candidates.length);
    TargetingTelemetry.bump(room, "pointDefenceThreatCandidates", candidates.length);
    return entity._pdThreatSet;
  }

  TargetingTelemetry.bump(room, "pointDefenceThreatSetReuses");
  return entity._pdThreatSet;
}

function invalidatePointDefenceThreatSet(entity) {
  if (entity?._pdThreatSet) {
    entity._pdThreatSet = null;
  }
}

function invalidateAllPointDefenceThreatSets(room) {
  if (!room) return;
  for (const ship of room?.ships ? [...room.ships.values()] : []) invalidatePointDefenceThreatSet(ship);
  for (const station of room?.stations || []) invalidatePointDefenceThreatSet(station);
}

// Select a single PD target from the shared threat set for one mount.
// `canSee(cand)` is the mount's line-of-sight predicate.
// `reservations` is a Map for overkill tracking.
function selectPointDefenceTarget(room, originX, originY, shipOwnerId, weapon, protectedShipId, now, threatSet, canSee, reservations = null) {
  if (!threatSet || !threatSet.candidates.length) return null;

  const rangeSq = (weapon.range || 0) * (weapon.range || 0);
  const priorityList = weapon.targetPriority || ["missile", "torpedo", "projectile", "droneFighter", "droneOther", "drone", "ship"];

  let best = null;
  let bestDistSq = Infinity;

  TargetingTelemetry.bump(room, "pointDefenceMountSelections");

  for (const cand of threatSet.candidates) {
    const ent = cand.entity;
    if (!ent) continue;

    TargetingTelemetry.bump(room, "pointDefenceCandidatesRevalidated");

    const dx = ent.x - originX;
    const dy = ent.y - originY;
    const distSq = dx * dx + dy * dy;
    if (distSq > rangeSq) {
      TargetingTelemetry.bump(room, "pointDefenceCandidatesRejectedStale");
      continue;
    }

    if (canSee && !canSee(cand)) continue;

    if (!Targeting.isPointDefenceTargetValid(room, shipOwnerId, cand, Math.sqrt(rangeSq), now, {
      originX,
      originY,
      team: _viewerTeam(room, shipOwnerId, null),
      reservations,
      priorityList
    })) {
      continue;
    }

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
  _getPointDefenceMetadata
};
