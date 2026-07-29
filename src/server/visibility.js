"use strict";

// Server-authoritative team visibility / fog-of-war.
//
// Visibility is cached by an explicit room generation, not by the timestamp a
// caller happened to pass. Combat has many target-acquisition call sites and
// some use performanceNow(); treating every fractional timestamp as a new frame
// made one team visibility scan run many times inside the same simulation tick.

const { BALANCE } = require("./balanceConfig");
const { effectiveSensorProfile, effectiveSensorRange } = require("./sensorCapability");
const { angleDifference } = require("./utils");

const VISIBILITY_BALANCE = BALANCE.visibility || {};
const DETECTION_LINGER_MS = Math.max(0, Number(VISIBILITY_BALANCE.detectionLingerSeconds) || 0.25) * 1000;
const REMEMBERED_CONTACT_MS = Math.max(0, Number(VISIBILITY_BALANCE.rememberedContactSeconds) || 12) * 1000;
const MAX_INVALIDATION_REASONS = 12;

const CONTACT_CLASS_BY_MASS = Object.freeze({
  light: "Light Contact",
  medium: "Medium Contact",
  heavy: "Heavy Contact",
  capital: "Capital Contact"
});

function usesSensorVisibility(room) {
  const mode = room?.rules?.visibilityMode;
  return mode === "sensors" || mode === "dark";
}

function normalizedTeamId(room, teamOrOwnerId) {
  if (teamOrOwnerId === null || teamOrOwnerId === undefined) return null;
  const player = room?.players?.get?.(teamOrOwnerId);
  return player?.team ?? teamOrOwnerId;
}

function teamOfEntity(room, entity) {
  if (!entity) return null;
  if (entity.team !== null && entity.team !== undefined) return entity.team;
  if (entity.teamId !== null && entity.teamId !== undefined) return entity.teamId;
  if (entity.ownerId) {
    const owner = room?.players?.get?.(entity.ownerId);
    if (owner?.team !== null && owner?.team !== undefined) return owner.team;
  }
  if (entity.parentShipId) {
    const parent = room?.ships?.get?.(entity.parentShipId);
    if (parent) return teamOfEntity(room, parent);
  }
  return null;
}

function roomVisibilityGeneration(room) {
  const generation = Number(room?._visibilityGeneration);
  return Number.isSafeInteger(generation) && generation > 0 ? generation : 1;
}

function getTeamVisibilityState(room, teamOrOwnerId) {
  const teamId = normalizedTeamId(room, teamOrOwnerId);
  if (!room.visibilityByTeam) room.visibilityByTeam = new Map();
  let state = room.visibilityByTeam.get(teamId);
  if (!state) {
    state = {
      visibleEntityIds: new Set(),
      nextVisibleEntityIds: new Set(),
      remembered: new Map(),
      coverage: [],
      revision: 1,
      computedAt: Number.NEGATIVE_INFINITY,
      computedGeneration: 0
    };
    room.visibilityByTeam.set(teamId, state);
  } else {
    // Tolerate rooms created by a hot-reloaded older implementation.
    if (!(state.visibleEntityIds instanceof Set)) state.visibleEntityIds = new Set();
    if (!(state.nextVisibleEntityIds instanceof Set)) state.nextVisibleEntityIds = new Set();
    if (!(state.remembered instanceof Map)) state.remembered = new Map();
    if (!Array.isArray(state.coverage)) state.coverage = [];
    if (!Number.isFinite(state.computedAt)) state.computedAt = Number.NEGATIVE_INFINITY;
    if (!Number.isSafeInteger(state.computedGeneration)) state.computedGeneration = 0;
  }
  return state;
}

function contactClassForEntity(entity) {
  if (entity.stationType === "home") return "Home Station";
  if (entity.stationType === "relay") return "Relay Station";
  if (entity.type === "drone" || entity.entityType === "drone") return "Drone Contact";
  const mass = String(entity.stats?.massClass || "medium").toLowerCase();
  return CONTACT_CLASS_BY_MASS[mass] || "Unknown Contact";
}

function buildRememberedContact(entity, now, room = null) {
  return {
    id: entity.id,
    entityType: "sensorContact",
    sourceEntityType: entity.stationType ? "station" : (entity.type || "ship"),
    contactClass: contactClassForEntity(entity),
    lastKnownX: entity.x,
    lastKnownY: entity.y,
    lastKnownAngle: entity.angle || 0,
    lastSeenAt: now,
    team: teamOfEntity(room, entity),
    ownerId: entity.ownerId || null
  };
}

function writeSensorSource(sources, index, entity, range, shape = "circle", angle = 0, halfAngle = Math.PI) {
  let record = sources[index];
  if (!record) {
    record = {};
    sources[index] = record;
  }
  record.entity = entity;
  record.range = range;
  record.shape = shape;
  record.angle = angle;
  record.halfAngle = halfAngle;
  return index + 1;
}

function getSensorSourcesForTeam(room, teamOrOwnerId, output = null) {
  const teamId = normalizedTeamId(room, teamOrOwnerId);
  const sources = output || [];
  let sourceCount = 0;

  for (const ship of room.ships?.values?.() || []) {
    if (!ship?.alive || ship.removed || teamOfEntity(room, ship) !== teamId) continue;
    const profile = effectiveSensorProfile(ship, room);
    if (profile.omniRange > 0) {
      sourceCount = writeSensorSource(sources, sourceCount, ship, profile.omniRange);
    }
    for (const directed of profile.directed || []) {
      if (!(directed.range > 0) || !(directed.halfAngle > 0)) continue;
      sourceCount = writeSensorSource(
        sources,
        sourceCount,
        ship,
        directed.range,
        "cone",
        (Number(ship.angle) || 0) + directed.relativeAngle,
        directed.halfAngle
      );
    }
  }

  for (const station of room.stations || []) {
    if (!station || teamOfEntity(room, station) !== teamId) continue;
    const range = effectiveSensorRange(station, room);
    if (range > 0) sourceCount = writeSensorSource(sources, sourceCount, station, range);
  }

  // Classic relays are map points rather than station entities.
  if (room?.rules?.infrastructureMode !== "stations") {
    for (const point of room.points || []) {
      if (!point || point.ownerTeam !== teamId) continue;
      const range = effectiveSensorRange({
        stationType: "relay",
        x: point.x,
        y: point.y,
        state: "operational",
        alive: true
      }, room);
      if (range > 0) sourceCount = writeSensorSource(sources, sourceCount, point, range);
    }
  }
  sources.length = sourceCount;
  return sources;
}

function targetRadius(entity) {
  return Math.max(0, Number(entity?.radius) || Number(entity?.physicalRadius) || 0);
}

function isPointInCoverage(source, x, y, padding = 0) {
  const anchor = source?.entity || source;
  const dx = (Number(x) || 0) - (Number(anchor?.x) || 0);
  const dy = (Number(y) || 0) - (Number(anchor?.y) || 0);
  const extra = Math.max(0, Number(padding) || 0);
  const reach = (Number(source?.range) || 0) + extra;
  const distanceSq = dx * dx + dy * dy;
  if (distanceSq > reach * reach) return false;
  if (source?.shape !== "cone") return true;
  if (distanceSq <= extra * extra) return true;
  const distance = Math.sqrt(distanceSq);
  const angularPadding = extra > 0 ? Math.asin(Math.min(1, extra / distance)) : 0;
  const targetAngle = Math.atan2(dy, dx);
  return Math.abs(angleDifference(Number(source.angle) || 0, targetAngle))
    <= (Number(source.halfAngle) || 0) + angularPadding;
}

function inSensorRange(sourceRecord, target) {
  return isPointInCoverage(sourceRecord, target?.x, target?.y, targetRadius(target));
}

function addDetectedTargets(room, teamId, sourceRecord, current, shipScratch) {
  const source = sourceRecord.entity;
  const range = sourceRecord.range;
  const spatial = room.spatialIndex?.dynamicValid === false ? null : room.spatialIndex;
  const ships = spatial?.queryRangeUnordered
    ? spatial.queryRangeUnordered("ships", source.x, source.y, range, shipScratch)
    : (room.ships?.values?.() || []);

  for (const target of ships) {
    if (!target?.alive || target.removed || teamOfEntity(room, target) === teamId) continue;
    if (inSensorRange(sourceRecord, target)) current.add(target.id);
  }

  // Stations and drones are small bounded collections. Iterating them directly
  // avoids stale broad-phase buckets after drone movement and fixes the previous
  // implementation, which never made either kind visible at all.
  for (const station of room.stations || []) {
    if (!station || station.alive === false || station.state === "destroyed") continue;
    if (teamOfEntity(room, station) === teamId) continue;
    if (inSensorRange(sourceRecord, station)) current.add(station.id);
  }
  for (const drone of room.drones?.values?.() || []) {
    if (!drone || drone.destroyed || drone.removed || teamOfEntity(room, drone) === teamId) continue;
    if (inSensorRange(sourceRecord, drone)) current.add(drone.id);
  }
}

function addAlliedEntities(room, teamId, current) {
  for (const ship of room.ships?.values?.() || []) {
    if (ship?.alive && !ship.removed && teamOfEntity(room, ship) === teamId) current.add(ship.id);
  }
  for (const station of room.stations || []) {
    if (station && station.alive !== false && teamOfEntity(room, station) === teamId) current.add(station.id);
  }
  for (const drone of room.drones?.values?.() || []) {
    if (drone && !drone.destroyed && !drone.removed && teamOfEntity(room, drone) === teamId) current.add(drone.id);
  }
}

function rememberedEntity(room, id) {
  // Ships leave a last-known tactical contact. Station locations are permanent
  // map knowledge and short-lived drones disappear without a stale hull marker.
  return room.ships?.get?.(id) || null;
}

function computeTeamVisibility(room, teamOrOwnerId, now) {
  const computedAt = Number.isFinite(Number(now)) ? Number(now) : 0;
  if (!usesSensorVisibility(room)) {
    return {
      visibleEntityIds: new Set(),
      remembered: new Map(),
      coverage: [],
      revision: 0,
      computedAt,
      computedGeneration: roomVisibilityGeneration(room)
    };
  }

  const teamId = normalizedTeamId(room, teamOrOwnerId);
  const state = getTeamVisibilityState(room, teamId);
  const previouslyVisible = state.visibleEntityIds;
  const current = state.nextVisibleEntityIds;
  current.clear();
  const sourceScratch = room._visibilitySourceScratch || (room._visibilitySourceScratch = []);
  const shipScratch = room._visibilityQueryScratch || (room._visibilityQueryScratch = []);
  const sources = getSensorSourcesForTeam(room, teamId, sourceScratch);

  let coverageCount = 0;
  for (const sourceRecord of sources) {
    const source = sourceRecord.entity;
    const range = sourceRecord.range;
    let coverage = state.coverage[coverageCount];
    if (!coverage) {
      coverage = {};
      state.coverage[coverageCount] = coverage;
    }
    coverage.id = source.id;
    coverage.x = source.x;
    coverage.y = source.y;
    coverage.range = range;
    coverage.shape = sourceRecord.shape;
    coverage.angle = sourceRecord.angle;
    coverage.halfAngle = sourceRecord.halfAngle;
    coverageCount += 1;
    addDetectedTargets(room, teamId, sourceRecord, current, shipScratch);
  }
  state.coverage.length = coverageCount;
  addAlliedEntities(room, teamId, current);

  for (const id of previouslyVisible) {
    if (current.has(id) || state.remembered.has(id)) continue;
    const entity = rememberedEntity(room, id);
    if (!entity || teamOfEntity(room, entity) === teamId) continue;
    const contact = buildRememberedContact(entity, computedAt, room);
    contact.firstLostAt = computedAt;
    contact.expiresAt = computedAt + DETECTION_LINGER_MS + REMEMBERED_CONTACT_MS;
    state.remembered.set(id, contact);
  }

  for (const [id, contact] of state.remembered) {
    if (current.has(id)) {
      state.remembered.delete(id);
      continue;
    }
    if (computedAt >= (contact.expiresAt || 0)) {
      state.remembered.delete(id);
      continue;
    }
    // Detection linger keeps the real entity visible and targetable briefly.
    // Only after the linger expires does the snapshot switch to a stale contact.
    if (computedAt < (contact.firstLostAt || 0) + DETECTION_LINGER_MS) current.add(id);
  }

  state.visibleEntityIds = current;
  state.nextVisibleEntityIds = previouslyVisible;
  state.computedAt = computedAt;
  state.computedGeneration = roomVisibilityGeneration(room);
  state.revision += 1;
  room._lastVisibilityComputeAt = computedAt;
  room._visibilityComputeCount = (Number(room._visibilityComputeCount) || 0) + 1;
  return state;
}

function ensureTeamVisibility(room, teamOrOwnerId, now) {
  if (!usesSensorVisibility(room)) return null;
  const state = getTeamVisibilityState(room, teamOrOwnerId);
  if (state.computedGeneration !== roomVisibilityGeneration(room)) {
    return computeTeamVisibility(room, teamOrOwnerId, now);
  }
  return state;
}

function getVisibleEntityIdsForTeam(room, teamOrOwnerId, now) {
  return ensureTeamVisibility(room, teamOrOwnerId, now)?.visibleEntityIds || null;
}

function getVisibilityState(room, teamOrOwnerId, entityId, now) {
  if (!usesSensorVisibility(room)) return "visible";
  const state = ensureTeamVisibility(room, teamOrOwnerId, now);
  if (state.visibleEntityIds.has(entityId)) return "visible";
  if (state.remembered.has(entityId)) return "remembered";
  return "hidden";
}

function canTeamSeeEntity(room, teamOrOwnerId, entity, now) {
  if (!entity || !usesSensorVisibility(room)) return true;
  if (entity.alive === false || entity.removed) return true;
  const teamId = normalizedTeamId(room, teamOrOwnerId);
  if (teamOfEntity(room, entity) === teamId) return true;
  const state = ensureTeamVisibility(room, teamId, now);
  return state.visibleEntityIds.has(entity.id) || state.remembered.has(entity.id);
}

function canTeamTargetEntity(room, teamOrOwnerId, target, now) {
  if (!target || !usesSensorVisibility(room)) return true;
  const teamId = normalizedTeamId(room, teamOrOwnerId);
  if (teamOfEntity(room, target) === teamId) return true;
  return getVisibilityState(room, teamId, target.id, now) === "visible";
}

function isPointVisibleInState(state, x, y, padding = 0) {
  if (!state) return false;
  const extra = Math.max(0, Number(padding) || 0);
  const pointX = Number(x) || 0;
  const pointY = Number(y) || 0;
  for (const source of state.coverage) {
    const dx = pointX - source.x;
    const dy = pointY - source.y;
    const reach = source.range + extra;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq > reach * reach) continue;
    if (source.shape !== "cone") return true;
    if (distanceSq <= extra * extra) return true;
    const distance = Math.sqrt(distanceSq);
    const angularPadding = extra > 0 ? Math.asin(Math.min(1, extra / distance)) : 0;
    if (Math.abs(angleDifference(source.angle, Math.atan2(dy, dx))) <= source.halfAngle + angularPadding) {
      return true;
    }
  }
  return false;
}

function isPointVisibleToTeam(room, teamOrOwnerId, x, y, now, padding = 0) {
  if (!usesSensorVisibility(room)) return true;
  return isPointVisibleInState(ensureTeamVisibility(room, teamOrOwnerId, now), x, y, padding);
}

function clearVisibilityForRoom(room) {
  if (!room) return;
  for (const state of room.visibilityByTeam?.values?.() || []) {
    state.visibleEntityIds.clear();
    state.nextVisibleEntityIds?.clear?.();
    state.remembered.clear();
    state.coverage.length = 0;
  }
  room.visibilityByTeam?.clear?.();
  for (const ship of room.ships?.values?.() || []) {
    delete ship._sensorRangeCacheGeneration;
    delete ship._sensorRangeCacheValue;
    delete ship._sensorProfileCacheGeneration;
    delete ship._sensorProfileCacheValue;
  }
  room._visibilityGeneration = 1;
  room._visibilityFinalizedAt = null;
  room._lastVisibilityComputeAt = 0;
  room._visibilityComputeCount = 0;
  room._visibilitySnapshotFilterBuilds = 0;
  room._visibilitySnapshotFilterCacheHits = 0;
  room._visibilitySourceScratch = null;
  room._visibilityQueryScratch = null;
  if (room._visibilityInvalidations) room._visibilityInvalidations.length = 0;
}

function invalidateVisibility(room, reason = "unknown") {
  if (!room || !usesSensorVisibility(room)) return 0;
  let next = roomVisibilityGeneration(room) + 1;
  if (!Number.isSafeInteger(next) || next >= Number.MAX_SAFE_INTEGER) {
    next = 1;
    for (const state of room.visibilityByTeam?.values?.() || []) state.computedGeneration = 0;
  }
  room._visibilityGeneration = next;
  room._visibilityInvalidationCount = (Number(room._visibilityInvalidationCount) || 0) + 1;

  // Keep only a tiny diagnostic ring. The original unbounded array grew for
  // the life of a room if invalidation was ever wired into the simulation.
  const reasons = room._visibilityInvalidations || (room._visibilityInvalidations = []);
  reasons.push({ reason, generation: next });
  if (reasons.length > MAX_INVALIDATION_REASONS) reasons.splice(0, reasons.length - MAX_INVALIDATION_REASONS);
  return next;
}

module.exports = {
  usesSensorVisibility,
  computeTeamVisibility,
  ensureTeamVisibility,
  canTeamSeeEntity,
  canTeamTargetEntity,
  getVisibleEntityIdsForTeam,
  getVisibilityState,
  isPointInCoverage,
  isPointVisibleToTeam,
  isPointVisibleInState,
  buildRememberedContact,
  getTeamVisibilityState,
  getSensorSourcesForTeam,
  teamOfEntity,
  normalizedTeamId,
  clearVisibilityForRoom,
  invalidateVisibility,
  contactClassForEntity,
  DETECTION_LINGER_MS,
  REMEMBERED_CONTACT_MS
};
