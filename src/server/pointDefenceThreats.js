"use strict";

// Shared Point Defence threat candidate set for Phase Three.
// One candidate superset is built per defending ship/station per refresh
// interval. Each live defensive mount then filters and selects from that
// superset without performing an independent full spatial search every tick.

const { PARTS } = require("./components");
const { getShipComponentIndexes } = require("./componentIndexes");
const { isComponentAlive } = require("./componentHealth");
const {
  ensureEffectiveWeaponProfileCache,
  getEffectiveWeaponStatsCached,
  getEffectiveWeaponStatsInternal
} = require("./componentData");
const { getCommandAuraMultiplier } = require("./commandAuras");
const { getOccupiedCells } = require("./footprint");
const { normalizeRotation } = require("./shipDesign");
const { fastHypot } = require("./utils");
const Relationships = require("./relationships");
const Visibility = require("./visibility");
const Targeting = require("./targetingEligibility");
const TargetingCadence = require("./targetingCadence");
const StationTemplates = require("./stationTemplates");
const TargetingTelemetry = require("./targetingTelemetry");

const PD_REFRESH_MS = 1000 / 12; // 12 Hz
const MOTION_PADDING = 150; // metres of relative motion covered between refreshes
const SHIP_MODULE_SCALE = 13;
const STATION_MODULE_SCALE = StationTemplates.STATION_MODULE_SCALE;
const GRID_CENTER = 7;
const DEFENSIVE_FAMILIES = new Set(["pointDefense", "flak"]);

function _viewerTeam(room, ownerId, team) {
  if (!ownerId) return team || null;
  const player = room?.players?.get?.(ownerId);
  return player?.team || team || null;
}

function _moduleCentreToLocal(module, scale) {
  const part = PARTS[module.type] || PARTS.frame;
  const cells = getOccupiedCells(
    module.x,
    module.y,
    part.footprint || { width: 1, height: 1 },
    normalizeRotation(module.rotation)
  );
  let x = 0;
  let y = 0;
  for (const cell of cells) {
    x += (GRID_CENTER - cell.y) * scale;
    y += (cell.x - GRID_CENTER) * scale;
  }
  const count = Math.max(1, cells.length);
  return { x: x / count, y: y / count };
}

function _entityModuleScale(entity) {
  if (entity?.moduleScale) return entity.moduleScale;
  return entity?.entityType === "station" || entity?.stationType ? STATION_MODULE_SCALE : SHIP_MODULE_SCALE;
}

function _mountWorldPosition(entity, index) {
  const hardpoint = entity?.hardpoints?.[index];
  const local = hardpoint || _moduleCentreToLocal(entity.design[index], _entityModuleScale(entity));
  const angle = Number(entity?.angle) || 0;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: (Number(entity?.x) || 0) + local.x * cos - local.y * sin,
    y: (Number(entity?.y) || 0) + local.x * sin + local.y * cos
  };
}

function _metadataSignature(entity, profileCache) {
  return [
    profileCache?.revision || 0,
    entity?.designRevision || 1,
    entity?.componentAliveRevision || 1,
    entity?.moduleScale || 0,
    entity?.hardpoints?.length || 0,
    entity?.commandState || "mainCore",
    getCommandAuraMultiplier(entity, "pointDefenceTrackingMultiplier"),
    getCommandAuraMultiplier(entity, "flakTrackingMultiplier"),
  ].join(":");
}

function _getPointDefenceMetadata(entity) {
  const profileCache = ensureEffectiveWeaponProfileCache(entity);
  const signature = _metadataSignature(entity, profileCache);
  if (entity?._pdThreatMetadataCache?.signature === signature) {
    return entity._pdThreatMetadataCache.meta;
  }

  const scale = _entityModuleScale(entity);
  const indexes = getShipComponentIndexes(entity).weaponIndices;
  const pdIndices = [];
  let maxRange = 0;
  let maxOffset = 0;
  for (const i of indexes) {
    const module = entity?.design?.[i];
    if (!module) continue;
    const part = PARTS[module.type] || PARTS.frame;
    const effective = getEffectiveWeaponStatsCached(entity, i)
      || getEffectiveWeaponStatsInternal(entity, i)
      || part.weapon;
    if (!DEFENSIVE_FAMILIES.has(effective?.type || part.weapon?.type || "")) continue;
    if (!isComponentAlive(entity, i)) continue;
    pdIndices.push(i);
    const range = Number(effective?.range || part.weapon?.range) || 0;
    if (range > maxRange) maxRange = range;
    const local = entity?.hardpoints?.[i] || _moduleCentreToLocal(module, scale);
    const offset = fastHypot(local.x, local.y);
    if (offset > maxOffset) maxOffset = offset;
  }

  const meta = {
    pdIndices,
    maxRange: Math.max(1, maxRange),
    maxOffset,
    queryRadius: Math.max(1, maxRange) + maxOffset + MOTION_PADDING
  };
  if (entity) entity._pdThreatMetadataCache = { signature, meta };
  return meta;
}

function _buildCandidateList(room, entity, identity, queryRadius, now) {
  const candidates = [];
  const x = entity.x || 0;
  const y = entity.y || 0;
  const viewerTeam = _viewerTeam(room, identity, entity.team);

  const spatial = room?.spatialIndex;
  if (!room._pdThreatScratch) room._pdThreatScratch = { projectiles: [], drones: [], ships: [] };
  const scratch = room._pdThreatScratch;

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
    : (room?.drones?.values?.() || []);

  for (const drone of drones) {
    if (drone.destroyed || drone.removed || room?.drones?.get?.(drone.id) !== drone) continue;
    if (!Relationships.areEnemies(room, identity, drone.ownerId)) continue;
    if (Visibility.usesSensorVisibility(room) && viewerTeam && !Visibility.canTeamTargetEntity(room, viewerTeam, drone, now)) continue;
    candidates.push({ type: "drone", entity: drone });
  }

  const ships = spatial && spatial.dynamicValid
    ? spatial.queryRangeUnordered("ships", x, y, queryRadius, scratch.ships)
    : (room?.ships?.values?.() || []);

  for (const ship of ships) {
    if (ship.id === entity.id) continue;
    if (!ship.alive || !Relationships.areEntityEnemies(room, identity, ship)) continue;
    if (Visibility.usesSensorVisibility(room) && viewerTeam && !Visibility.canTeamTargetEntity(room, viewerTeam, ship, now)) continue;
    candidates.push({ type: "ship", entity: ship });
  }

  const decoys = room?.decoys?.values?.() || [];
  for (const decoy of decoys) {
    if (now >= decoy.expiresAt) continue;
    if (!Relationships.areEnemies(room, identity, decoy.ownerId)) continue;
    candidates.push({ type: "decoy", entity: decoy });
  }

  return candidates;
}

function _sortCandidates(candidates, entity, protectedShipId, shipOwnerId, priorityList) {
  const cx = entity.x || 0;
  const cy = entity.y || 0;
  const ranks = new WeakMap();
  const distSqs = new WeakMap();
  const protectedFlags = new WeakMap();
  for (const c of candidates) {
    ranks.set(c, Targeting.getCandidatePriorityIndex(c, priorityList));
    const dx = (c.entity?.x || 0) - cx;
    const dy = (c.entity?.y || 0) - cy;
    distSqs.set(c, dx * dx + dy * dy);
    protectedFlags.set(c, Targeting.isCandidateTargetingProtected(c, protectedShipId, null, shipOwnerId));
  }
  return candidates.slice().sort((a, b) => {
    const rA = ranks.get(a) ?? -1;
    const rB = ranks.get(b) ?? -1;
    if (rA !== rB) {
      if (rA === -1) return 1;
      if (rB === -1) return -1;
      return rA - rB;
    }
    const pA = protectedFlags.get(a) ? 1 : 0;
    const pB = protectedFlags.get(b) ? 1 : 0;
    if (pA !== pB) return pB - pA;
    const dA = distSqs.get(a) ?? Infinity;
    const dB = distSqs.get(b) ?? Infinity;
    if (dA !== dB) return dA - dB;
    return Targeting.isStableIdBefore?.(a.entity, b.entity) ? -1 : 1;
  });
}

function _entityRelevantRevisions(entity) {
  return {
    designRevision: entity?.designRevision || 1,
    componentAliveRevision: entity?.componentAliveRevision || 1,
    heatStateRevision: entity?.heatStateRevision || 0,
    powerRevision: entity?.powerRevision || 0,
    dataSupportLinks: entity?.runtimeDataSupport?.linkRevision || 0,
    dataSupportAllocation: entity?.runtimeDataSupport?.allocationRevision || 0,
    weaponProfileRevision: entity?.effectiveWeaponProfileCache?.revision || 0
  };
}

function _signature(room, entity, meta) {
  const rev = _entityRelevantRevisions(entity);
  return {
    stateEpoch: room?.stateEpoch || 1,
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
  for (const key of Object.keys(next)) {
    if (Array.isArray(next[key])) {
      const a = next[key];
      const b = prev[key] || [];
      if (a.length !== b.length) return true;
      for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return true;
    } else if (next[key] !== prev[key]) {
      return true;
    }
  }
  return false;
}

function _reuseCandidateArray(threatSet, candidates) {
  if (!threatSet) return candidates;
  const reused = threatSet.candidates;
  for (let i = 0; i < candidates.length; i += 1) {
    const source = candidates[i];
    const entry = reused[i] || (reused[i] = {});
    entry.type = source.type;
    entry.entity = source.entity;
  }
  reused.length = candidates.length;
  return reused;
}

function ensurePointDefenceThreatSet(room, entity, identity, now) {
  const meta = _getPointDefenceMetadata(entity);
  const force = _signatureChanged(entity._pdThreatSet, room, entity, now, meta);

  if (force) {
    const candidates = TargetingTelemetry.withSampledDuration(room, now, entity, 0, "sampledPDSetBuildDuration", () =>
      _buildCandidateList(room, entity, identity, meta.queryRadius, now)
    );

    if (!entity._pdThreatSet) {
      entity._pdThreatSet = { candidates: [], maxRange: 0, x: 0, y: 0, nextRefreshAt: 0 };
    }

    _reuseCandidateArray(entity._pdThreatSet, candidates);
    entity._pdThreatSet.entity = entity;
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
    entity._pdThreatSet.sortedByPriority = {};

    TargetingTelemetry.bump(room, "pointDefenceThreatSetBuilds");
    TargetingTelemetry.bump(room, "pointDefenceThreatCandidates", candidates.length);
    return entity._pdThreatSet;
  }

  TargetingTelemetry.bump(room, "pointDefenceThreatSetReuses");
  return entity._pdThreatSet;
}

function invalidatePointDefenceThreatSet(entity) {
  if (!entity) return;
  entity._pdThreatSet = null;
  entity._pdThreatMetadataCache = null;
  entity._pdSelectionState = null;
}

function invalidateAllPointDefenceThreatSets(room) {
  if (!room) return;
  for (const ship of room?.ships?.values?.() || []) invalidatePointDefenceThreatSet(ship);
  for (const station of room?.stations || []) invalidatePointDefenceThreatSet(station);
}

function _mountIndexForOrigin(entity, threatSet, originX, originY) {
  let bestIndex = -1;
  let bestDistanceSq = Infinity;
  for (const index of threatSet.pdIndices || []) {
    const position = _mountWorldPosition(entity, index);
    const dx = position.x - originX;
    const dy = position.y - originY;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq < bestDistanceSq || (distanceSq === bestDistanceSq && index < bestIndex)) {
      bestIndex = index;
      bestDistanceSq = distanceSq;
    }
  }
  return bestIndex;
}

function _selectionState(entity, mountIndex) {
  if (!entity._pdSelectionState) entity._pdSelectionState = {};
  const key = String(mountIndex);
  if (!entity._pdSelectionState[key]) {
    entity._pdSelectionState[key] = { initialized: false, type: null, id: null, entity: null };
  }
  return entity._pdSelectionState[key];
}

function _findCachedCandidate(threatSet, state) {
  if (!state?.entity) return null;
  for (const candidate of threatSet.candidates) {
    if (candidate.type !== state.type) continue;
    if (candidate.entity === state.entity) return candidate;
    if (candidate.entity?.id != null && candidate.entity.id === state.id) return candidate;
  }
  return null;
}

function _validateCandidate(room, candidate, originX, originY, shipOwnerId, weapon, now, priorityList, canSee, reservations) {
  if (!candidate?.entity) return null;
  TargetingTelemetry.bump(room, "pointDefenceCandidatesRevalidated");

  const entity = candidate.entity;
  const live = candidate.type === "projectile"
    ? (room?.bullets || []).some((bullet) => bullet === entity || bullet?.id === entity.id)
    : candidate.type === "drone"
      ? Boolean(room?.drones?.get?.(entity.id))
      : candidate.type === "ship"
        ? Boolean(room?.ships?.get?.(entity.id))
        : candidate.type === "decoy"
          ? Boolean(room?.decoys?.get?.(entity.id))
          : (room?.stations || []).some((station) => station === entity || station?.id === entity.id);
  if (!live) {
    TargetingTelemetry.bump(room, "pointDefenceCandidatesRejectedStale");
    return null;
  }

  const dx = entity.x - originX;
  const dy = entity.y - originY;
  const distSq = dx * dx + dy * dy;
  const range = Number(weapon.range) || 0;
  if (distSq > range * range) {
    TargetingTelemetry.bump(room, "pointDefenceCandidatesRejectedStale");
    return null;
  }
  if (canSee && !canSee(candidate)) return null;
  if (!Targeting.isPointDefenceTargetValid(room, shipOwnerId, candidate, range, now, {
    originX,
    originY,
    team: _viewerTeam(room, shipOwnerId, null),
    reservations,
    priorityList
  })) return null;
  return distSq;
}

// Select a single defensive target from the shared threat set for one mount.
// Expensive ranking is cadenced at 12 Hz, but the selected target is revalidated
// every simulation tick so invalid targets trigger immediate reacquisition.
function selectPointDefenceTarget(room, originX, originY, shipOwnerId, weapon, protectedShipId, now, threatSet, canSee, reservations = null) {
  if (!threatSet) return null;

  const entity = threatSet.entity;
  const priorityList = weapon.targetPriority || ["missile", "torpedo", "projectile", "droneFighter", "droneOther", "drone", "ship"];
  const mountIndex = entity ? _mountIndexForOrigin(entity, threatSet, originX, originY) : -1;
  const state = entity ? _selectionState(entity, mountIndex) : null;
  const cadenceKind = entity?.entityType === "station" || entity?.stationType ? "stationPointDefence" : "pointDefence";

  const cached = state ? _findCachedCandidate(threatSet, state) : null;
  const cachedDistanceSq = cached
    ? _validateCandidate(room, cached, originX, originY, shipOwnerId, weapon, now, priorityList, canSee, reservations)
    : null;
  const cachedValid = cachedDistanceSq !== null;
  const hadCachedTarget = Boolean(state?.entity);
  const forceReacquire = hadCachedTarget && !cachedValid;
  const due = !entity || TargetingCadence.isAcquisitionDue(entity, cadenceKind, mountIndex, now);

  if (cachedValid && !due) {
    TargetingTelemetry.bump(room, "pointDefenceTargetSearchDeferred");
    return cached;
  }
  if (state?.initialized && !hadCachedTarget && !due) {
    TargetingTelemetry.bump(room, "pointDefenceTargetSearchDeferred");
    return null;
  }
  if (forceReacquire) {
    TargetingTelemetry.bump(room, "pointDefenceImmediateReacquisitions");
  }

  let best = null;
  TargetingTelemetry.bump(room, "pointDefenceMountSelections");

  const priorityKey = priorityList.join(",");
  if (!threatSet.sortedByPriority[priorityKey]) {
    threatSet.sortedByPriority[priorityKey] = _sortCandidates(threatSet.candidates, entity, protectedShipId, shipOwnerId, priorityList);
  }
  const sorted = threatSet.sortedByPriority[priorityKey];

  for (const candidate of sorted) {
    const distSq = _validateCandidate(room, candidate, originX, originY, shipOwnerId, weapon, now, priorityList, canSee, reservations);
    if (distSq === null) continue;
    best = candidate;
    break;
  }

  if (state) {
    state.initialized = true;
    state.type = best?.type || null;
    state.id = best?.entity?.id ?? null;
    state.entity = best?.entity || null;
  }
  if (entity) TargetingCadence.markAcquisitionCompleted(entity, cadenceKind, mountIndex, now);
  return best;
}

module.exports = {
  ensurePointDefenceThreatSet,
  selectPointDefenceTarget,
  invalidatePointDefenceThreatSet,
  invalidateAllPointDefenceThreatSets,
  _getPointDefenceMetadata
};
