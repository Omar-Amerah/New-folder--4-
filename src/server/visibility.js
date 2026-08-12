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
const { bump } = require("./roomTelemetry");

const VISIBILITY_BALANCE = BALANCE.visibility || {};
const DETECTION_LINGER_MS = Math.max(0, Number(VISIBILITY_BALANCE.detectionLingerSeconds) || 0.25) * 1000;
const REMEMBERED_CONTACT_MS = Math.max(0, Number(VISIBILITY_BALANCE.rememberedContactSeconds) || 12) * 1000;
const MAX_INVALIDATION_REASONS = 12;

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

// teamOfEntity walks ownership (and, for drones, the parent ship) through the
// player map. A single team scan asks for the same entity's team once per
// sensor source, which at fleet scale is tens of thousands of Map lookups per
// tick. Allegiance cannot change inside one visibility generation — capture and
// destruction both publish a new one — so memoize it for the length of a scan.
function cachedTeamOfEntity(room, entity, generation) {
  if (!entity) return null;
  if (entity._visibilityTeamGeneration === generation) return entity._visibilityTeamValue;
  const team = teamOfEntity(room, entity);
  entity._visibilityTeamGeneration = generation;
  entity._visibilityTeamValue = team;
  return team;
}

function getTeamVisibilityState(room, teamOrOwnerId) {
  return require("./visibilityRuntime").getTeamState(room, teamOrOwnerId);
}

function contactClassForEntity(entity) {
  if (entity.stationType === "home") return "Home Station";
  if (entity.stationType === "relay") return "Relay Station";
  if (entity.type === "drone" || entity.entityType === "drone") return "Drone Contact";
  return "Ship Contact";
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
  const generation = roomVisibilityGeneration(room);
  const sources = output || [];
  let sourceCount = 0;

  for (const ship of room.ships?.values?.() || []) {
    if (!ship?.alive || ship.removed || cachedTeamOfEntity(room, ship, generation) !== teamId) continue;
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
    if (!station || cachedTeamOfEntity(room, station, generation) !== teamId) continue;
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

function addDetectedShips(room, teamId, generation, sourceRecord, current, shipScratch) {
  const source = sourceRecord.entity;
  const range = sourceRecord.range;
  const spatial = room.spatialIndex?.dynamicValid === false ? null : room.spatialIndex;
  bump(room, "visibilityShipQueries");
  const ships = spatial?.queryRangeUnordered
    ? spatial.queryRangeUnordered("ships", source.x, source.y, range, shipScratch)
    : (room.ships?.values?.() || []);

  for (const target of ships) {
    bump(room, "visibilityShipCandidates");
    if (!target?.alive || target.removed || cachedTeamOfEntity(room, target, generation) === teamId) continue;
    if (inSensorRange(sourceRecord, target)) {
      if (!current.has(target.id)) bump(room, "visibilityEntitiesDetected");
      current.add(target.id);
    }
  }
}

function coverageSeesPoint(coverage, count, x, y, padding) {
  for (let index = 0; index < count; index += 1) {
    if (isPointInCoverage(coverage[index], x, y, padding)) return true;
  }
  return false;
}

// Stations and drones are small bounded collections without a reliable
// broad-phase bucket (drones move after the index is built, and station
// visibility must survive a stale one). They are swept once against the
// finished coverage set rather than once per sensor source: the geometry test
// is the same, but each entity is filtered for team and liveness a single time
// and stops at the first source that sees it.
function addDetectedStructures(room, teamId, generation, coverage, coverageCount, current) {
  if (coverageCount === 0) return;
  bump(room, "visibilityStationQueries");
  for (const station of room.stations || []) {
    bump(room, "visibilityStationCandidates");
    if (!station || station.alive === false || station.state === "destroyed") continue;
    if (cachedTeamOfEntity(room, station, generation) === teamId) continue;
    if (coverageSeesPoint(coverage, coverageCount, station.x, station.y, targetRadius(station))) {
      if (!current.has(station.id)) bump(room, "visibilityEntitiesDetected");
      current.add(station.id);
    }
  }
  bump(room, "visibilityDroneQueries");
  for (const drone of room.drones?.values?.() || []) {
    bump(room, "visibilityDroneCandidates");
    if (!drone || drone.destroyed || drone.removed) continue;
    if (cachedTeamOfEntity(room, drone, generation) === teamId) continue;
    if (coverageSeesPoint(coverage, coverageCount, drone.x, drone.y, targetRadius(drone))) {
      if (!current.has(drone.id)) bump(room, "visibilityEntitiesDetected");
      current.add(drone.id);
    }
  }
}

function addAlliedEntities(room, teamId, generation, current) {
  for (const ship of room.ships?.values?.() || []) {
    if (ship?.alive && !ship.removed && cachedTeamOfEntity(room, ship, generation) === teamId) current.add(ship.id);
  }
  for (const station of room.stations || []) {
    if (station && station.alive !== false && cachedTeamOfEntity(room, station, generation) === teamId) current.add(station.id);
  }
  for (const drone of room.drones?.values?.() || []) {
    if (drone && !drone.destroyed && !drone.removed && cachedTeamOfEntity(room, drone, generation) === teamId) current.add(drone.id);
  }
}

function rememberedEntity(room, id) {
  // Ships leave a last-known tactical contact. Station locations are permanent
  // map knowledge and short-lived drones disappear without a stale hull marker.
  return room.ships?.get?.(id) || null;
}

function computeTeamVisibility(room, teamOrOwnerId, now) {
  return require("./visibilityRuntime").computeTeamVisibility(room, teamOrOwnerId, now);
}

function ensureTeamVisibility(room, teamOrOwnerId, now) {
  return require("./visibilityRuntime").ensureTeamVisibility(room, teamOrOwnerId, now);
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
  if (cachedTeamOfEntity(room, target, roomVisibilityGeneration(room)) === teamId) return true;
  // Stations are permanent, public map structures even when their live
  // condition is outside sensor coverage. Players can issue an attack order
  // against that known structure without revealing its hidden health state.
  if (target.entityType === "station" || target.stationType) return true;
  // Deliberately not routed through getVisibilityState: this is the single
  // hottest visibility query in the simulation, and only the "visible" verdict
  // matters, so it does not need the remembered-contact lookup or a second
  // team normalization.
  return ensureTeamVisibility(room, teamId, now).visibleEntityIds.has(target.id);
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
  require("./visibilityRuntime").clearVisibilityForRoom(room);
  for (const ship of room.ships?.values?.() || []) {
    delete ship._sensorRangeCacheGeneration;
    delete ship._sensorRangeCacheValue;
    delete ship._sensorProfileCacheGeneration;
    delete ship._sensorProfileCacheValue;
  }
  // The generation counter restarts here, so any entity still carrying a stamp
  // from the previous match would otherwise answer with its old allegiance.
  for (const entity of [
    ...(room.ships?.values?.() || []),
    ...(room.stations || []),
    ...(room.drones?.values?.() || [])
  ]) {
    delete entity._visibilityTeamGeneration;
    delete entity._visibilityTeamValue;
  }
  room._visibilityGeneration = 1;
  room._visibilityFinalizedAt = null;
  room._lastVisibilityComputeAt = 0;
  room._visibilityComputeCount = 0;
  room._visibilitySnapshotFilterBuilds = 0;
  room._visibilitySnapshotFilterCacheHits = 0;
  room._visibilityInvalidationCount = 0;
  room._visibilityFinalizationInvalidated = false;
  room._visibilityLastInvalidationStepKey = null;
  room._visibilityInvalidationCountsByReason = Object.create(null);
  if (room._visibilityInvalidations) room._visibilityInvalidations.length = 0;
}

function invalidateVisibility(room, reason = "unknown") {
  if (!room || !usesSensorVisibility(room)) return 0;
  const options = typeof reason === "string" ? { reason } : (reason || {});
  const reasonText = String(options.reason || "unknown");
  let next = roomVisibilityGeneration(room) + 1;
  if (!Number.isSafeInteger(next) || next >= Number.MAX_SAFE_INTEGER) {
    next = 1;
  }
  room._visibilityGeneration = next;
  room._visibilityInvalidationCount = (Number(room._visibilityInvalidationCount) || 0) + 1;
  bump(room, "visibilityInvalidations");
  bump(room, "visibilityGenerationAdvances");
  const stepKey = `${String(room.simulationTimeMs ?? "unknown")}:${reasonText}`;
  if (room._visibilityLastInvalidationStepKey === stepKey) bump(room, "visibilityDuplicateInvalidations");
  room._visibilityLastInvalidationStepKey = stepKey;
  const reasonCounts = room._visibilityInvalidationCountsByReason
    || (room._visibilityInvalidationCountsByReason = Object.create(null));
  reasonCounts[reasonText] = (Number(reasonCounts[reasonText]) || 0) + 1;
  if (room._visibilityFinalizedAt !== null
    && room._visibilityFinalizedAt !== undefined
    && Number(room._visibilityFinalizedAt) === Number(room.simulationTimeMs)) {
    room._visibilityFinalizationInvalidated = true;
  }
  require("./visibilityRuntime").invalidateVisibility(room, options);

  // Keep only a tiny diagnostic ring. The original unbounded array grew for
  // the life of a room if invalidation was ever wired into the simulation.
  const reasons = room._visibilityInvalidations || (room._visibilityInvalidations = []);
  reasons.push({ reason: reasonText, generation: next });
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
