"use strict";

// Phase 6C incremental visibility runtime.
//
// This module deliberately owns the optimized path rather than folding its
// caches into visibility.js.  visibility.js remains the parity reference and
// dispatches here only when OPTIMIZED_VISIBILITY_RUNTIME is enabled.  The
// runtime therefore has one authoritative result per team, but can reuse
// source capability and coverage records between those results.

const { BALANCE } = require("./balanceConfig");
const { PARTS } = require("./components");
const { effectiveSensorProfile } = require("./sensorCapability");
const { angleDifference, compareNaturalIds, performanceNow } = require("./utils");
const {
  bump,
  recordDuration,
  setCounter
} = require("./roomTelemetry");

const VISIBILITY_BALANCE = BALANCE.visibility || {};
const DETECTION_LINGER_MS = Math.max(0, Number(VISIBILITY_BALANCE.detectionLingerSeconds) || 0.25) * 1000;
const REMEMBERED_CONTACT_MS = Math.max(0, Number(VISIBILITY_BALANCE.rememberedContactSeconds) || 12) * 1000;
const RECONCILE_INTERVAL_GENERATIONS = 60;

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

function entityTypeFor(entity, fallback = null) {
  if (fallback) return fallback;
  if (entity?.stationType) return "station";
  if (entity?.type === "drone" || entity?.entityType === "drone") return "drone";
  return "ship";
}

function sourceKey(entity, entityType) {
  const id = entity?.id;
  return entityType === "relay" ? `relay:${String(id ?? "")}` : id;
}

function isLiveEntity(entity, entityType) {
  if (!entity) return false;
  if (entityType === "ship") return entity.alive === true && !entity.removed;
  if (entityType === "station") return entity.alive !== false && entity.state !== "destroyed";
  if (entityType === "drone") return !entity.destroyed && !entity.removed;
  if (entityType === "relay") return entity.removed !== true;
  return entity.alive !== false && !entity.removed;
}

function isLiveSource(entity, entityType) {
  if (!isLiveEntity(entity, entityType)) return false;
  if (entityType === "relay") return true;
  return entityType === "ship" || entityType === "station";
}

function targetRadius(entity) {
  return Math.max(0, Number(entity?.radius) || Number(entity?.physicalRadius) || 0);
}

function contactClassForEntity(entity) {
  if (entity?.stationType === "home") return "Home Station";
  if (entity?.stationType === "relay") return "Relay Station";
  if (entity?.type === "drone" || entity?.entityType === "drone") return "Drone Contact";
  const mass = String(entity?.stats?.massClass || "medium").toLowerCase();
  return CONTACT_CLASS_BY_MASS[mass] || "Unknown Contact";
}

function buildRememberedContact(room, entity, now) {
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

function compareSourceRecords(a, b) {
  return compareNaturalIds(a?.entityId, b?.entityId)
    || compareNaturalIds(a?.entityType, b?.entityType);
}

function ensureTeamEntitySets(runtime, teamId) {
  let sets = runtime.teamEntityIds.get(teamId);
  if (!sets) {
    sets = { ships: new Set(), stations: new Set(), drones: new Set() };
    runtime.teamEntityIds.set(teamId, sets);
  }
  return sets;
}

function removeTeamIfEmpty(runtime, room, teamId) {
  if (teamId === null || teamId === undefined) return;
  const sets = runtime.teamEntityIds.get(teamId);
  const sources = runtime.sourcesByTeam.get(teamId);
  const state = runtime.teamStates.get(teamId);
  if (sets && !sets.ships.size && !sets.stations.size && !sets.drones.size) runtime.teamEntityIds.delete(teamId);
  if (sources && !sources.length) runtime.sourcesByTeam.delete(teamId);
  if ((!sets || (!sets.ships.size && !sets.stations.size && !sets.drones.size))
    && (!sources || !sources.length)
    && (!state || !(state.remembered instanceof Map) || !state.remembered.size)) {
    runtime.teamStates.delete(teamId);
    runtime.dirtyTeams.delete(teamId);
    room?.visibilityByTeam?.delete?.(teamId);
  }
}

function pruneEmptyTeamContainers(room, runtime) {
  const teamIds = new Set([
    ...runtime.teamEntityIds.keys(),
    ...runtime.sourcesByTeam.keys(),
    ...runtime.teamStates.keys()
  ]);
  for (const teamId of teamIds) removeTeamIfEmpty(runtime, room, teamId);
}

function createRuntime(room) {
  return {
    epoch: Number(room?.stateEpoch) || 1,
    visibilityMode: room?.rules?.visibilityMode,
    infrastructureMode: room?.rules?.infrastructureMode,
    sourceRevision: 0,
    entityRevision: 0,
    sourceByEntityId: new Map(),
    sourcesByTeam: new Map(),
    dirtySourceIds: new Set(),
    removedSourceIds: [],
    teamEntityIds: new Map(),
    teamStates: new Map(),
    entityTeamCache: new Map(),
    generation: roomVisibilityGeneration(room),
    dirtyTeams: new Set(),
    allTeamsDirty: true,
    fullInvalidationGeneration: roomVisibilityGeneration(room),
    shipQueryScratch: [],
    droneQueryScratch: [],
    stationQueryScratch: [],
    collectionStamp: null,
    bootstrapped: false,
    lastMaintenanceAt: 0,
    lastMaintenanceGeneration: 0,
    lastReconciledGeneration: 0,
    reconcileRequested: false
  };
}

function collectionStamp(room) {
  return {
    ships: room?.ships,
    shipsSize: room?.ships?.size || 0,
    stations: room?.stations,
    stationsSize: room?.stations?.length || 0,
    stationRevision: room?.stationRevision || 0,
    points: room?.points,
    pointsSize: room?.points?.length || 0,
    drones: room?.drones,
    dronesSize: room?.drones?.size || 0
  };
}

function collectionStampChanged(previous, next) {
  if (!previous) return true;
  return previous.ships !== next.ships
    || previous.shipsSize !== next.shipsSize
    || previous.stations !== next.stations
    || previous.stationsSize !== next.stationsSize
    || previous.stationRevision !== next.stationRevision
    || previous.points !== next.points
    || previous.pointsSize !== next.pointsSize
    || previous.drones !== next.drones
    || previous.dronesSize !== next.dronesSize;
}

function sourceStillInRoom(room, record) {
  const entity = record?.entity;
  if (!entity) return false;
  if (record.entityType === "relay") return (room?.points || []).includes(entity);
  if (record.entityType === "station") return (room?.stations || []).includes(entity);
  return room?.ships?.get?.(entity.id) === entity;
}

function sensorComponentSignature(entity) {
  const design = Array.isArray(entity?.design) ? entity.design : [];
  const values = [];
  for (let index = 0; index < design.length; index += 1) {
    const module = design[index];
    const part = PARTS[module?.type];
    if (!(Number(part?.sensorRangeBonus) > 0)) continue;
    const power = entity?.componentPower?.byComponentIndex?.[index];
    values.push([
      index,
      module?.type || "",
      module?.x ?? "",
      module?.y ?? "",
      module?.rotation ?? "",
      entity?.componentHp?.[index] ?? "",
      entity?.componentMaxHp?.[index] ?? "",
      power?.operationalMultiplier ?? "",
      power?.state ?? "",
      entity?.componentHeatState?.[index] ?? ""
    ].join(":"));
  }
  return values.join("|");
}

function auraSignature(entity) {
  const multipliers = entity?.commandAuraMultipliers || {};
  const received = entity?.commandAurasReceived?.sensorRangeMultiplier;
  const sourceId = received?.sourceShipId || "";
  const multiplier = Number(multipliers.sensorRangeMultiplier);
  return `${Number.isFinite(multiplier) ? multiplier : 1}:${sourceId}:${Boolean(entity?.commandAuraReceived)}`;
}

function capabilityKey(record, room) {
  const entity = record.entity;
  if (record.entityType === "relay") {
    return [record.entityType, entity?.state || "operational", entity?.ownerTeam ?? ""].join("|");
  }
  if (record.entityType === "station") {
    return [
      record.entityType,
      entity?.stationType || "",
      entity?.state || "",
      entity?.alive === false ? 0 : 1,
      entity?.componentAliveRevision || 0,
      entity?.componentDamageRevision || 0,
      entity?.componentRevision || 0,
      entity?.healthRevision || 0,
      entity?.powerRevision || 0,
      entity?.heatStateRevision || 0
    ].join("|");
  }
  return [
    record.entityType,
    entity?.designRevision || 0,
    entity?.componentAliveRevision || 0,
    entity?.componentDamageRevision || 0,
    entity?.powerRevision || 0,
    entity?.powerFlowRevision || 0,
    entity?.heatStateRevision || 0,
    sensorComponentSignature(entity),
    auraSignature(entity),
    room?.rules?.visibilityMode || ""
  ].join("|");
}

function sourceTeam(record, room) {
  return record.entityType === "relay"
    ? record.entity?.ownerTeam ?? null
    : teamOfEntity(room, record.entity);
}

function transformValues(entity) {
  return {
    x: Number(entity?.x) || 0,
    y: Number(entity?.y) || 0,
    angle: Number(entity?.angle) || 0
  };
}

function markTeamDirty(runtime, teamId) {
  if (teamId !== null && teamId !== undefined) runtime.dirtyTeams.add(teamId);
}

function removeSourceFromTeam(runtime, record, teamId) {
  const list = runtime.sourcesByTeam.get(teamId);
  if (!list) return;
  const index = list.indexOf(record);
  if (index >= 0) list.splice(index, 1);
  if (!list.length) runtime.sourcesByTeam.delete(teamId);
}

function addSourceToTeam(runtime, record, teamId) {
  if (teamId === null || teamId === undefined) return;
  const list = runtime.sourcesByTeam.get(teamId) || [];
  if (!list.includes(record)) list.push(record);
  list.sort(compareSourceRecords);
  runtime.sourcesByTeam.set(teamId, list);
}

function removeEntityMembership(runtime, entityId, entry = null) {
  const cached = entry || runtime.entityTeamCache.get(entityId);
  if (!cached) return;
  const sets = runtime.teamEntityIds.get(cached.teamId);
  if (sets) {
    sets[cached.entityType === "station" ? "stations" : cached.entityType === "drone" ? "drones" : "ships"]?.delete(entityId);
  }
  markTeamDirty(runtime, cached.teamId);
  runtime.entityTeamCache.delete(entityId);
}

function registerEntityMembership(room, runtime, entity, entityType = null) {
  if (!entity || entity.id === undefined || entity.id === null) return null;
  const type = entityTypeFor(entity, entityType);
  const id = entity.id;
  if (type === "relay") return null;
  const teamId = teamOfEntity(room, entity);
  const previous = runtime.entityTeamCache.get(id);
  const previousLive = previous?.live;
  const membershipChanged = !previous
    || previous.entity !== entity
    || previous.entityType !== type
    || previous.teamId !== teamId
    || previousLive !== isLiveEntity(entity, type);
  if (previous && (previous.entity !== entity || previous.entityType !== type || previous.teamId !== teamId)) {
    removeEntityMembership(runtime, id, previous);
    markTeamDirty(runtime, previous.teamId);
    runtime.entityRevision += 1;
  }
  const live = isLiveEntity(entity, type);
  if (live && teamId !== null && teamId !== undefined) {
    const sets = ensureTeamEntitySets(runtime, teamId);
    const setName = type === "station" ? "stations" : type === "drone" ? "drones" : "ships";
    sets[setName].add(id);
  } else if (!live && previous && previous.teamId !== null && previous.teamId !== undefined) {
    const sets = runtime.teamEntityIds.get(previous.teamId);
    const setName = type === "station" ? "stations" : type === "drone" ? "drones" : "ships";
    sets?.[setName]?.delete(id);
  }
  runtime.entityTeamCache.set(id, { entity, entityType: type, teamId, live });
  if (membershipChanged) markTeamDirty(runtime, teamId);
  return teamId;
}

function updateSourceCoverage(record) {
  const desired = [];
  if (record.omniRange > 0) desired.push({ range: record.omniRange, shape: "circle", angle: 0, halfAngle: Math.PI });
  for (const directed of record.directed || []) {
    if (!(directed.range > 0) || !(directed.halfAngle > 0)) continue;
    desired.push({
      range: directed.range,
      shape: "cone",
      angle: (Number(record.entity?.angle) || 0) + (Number(directed.relativeAngle) || 0),
      halfAngle: directed.halfAngle
    });
  }
  const coverage = record.coverageRecords || (record.coverageRecords = []);
  for (let index = 0; index < desired.length; index += 1) {
    const wanted = desired[index];
    const entry = coverage[index] || (coverage[index] = {});
    entry.sourceId = record.entityId;
    entry.x = Number(record.entity?.x) || 0;
    entry.y = Number(record.entity?.y) || 0;
    entry.range = Math.max(0, Number(wanted.range) || 0);
    entry.rangeSquared = entry.range * entry.range;
    entry.shape = wanted.shape;
    entry.angle = Number(wanted.angle) || 0;
    entry.halfAngle = Math.max(0, Number(wanted.halfAngle) || 0);
    entry.cosHalfAngle = Math.cos(entry.halfAngle);
    entry.targetPaddingAllowance = 0;
  }
  coverage.length = desired.length;
  record.coverageCapabilityRevision = record.capabilityRevision;
  record.coverageTransformRevision = record.transformRevision;
  return coverage;
}

function refreshSourceRecord(room, runtime, record) {
  const entity = record.entity;
  const active = isLiveSource(entity, record.entityType);
  if (!active) {
    const oldTeam = record.teamId;
    removeSourceFromTeam(runtime, record, oldTeam);
    runtime.sourceByEntityId.delete(record.key);
    runtime.dirtySourceIds.delete(record.key);
    runtime.removedSourceIds.push(record.entityId);
    if (runtime.removedSourceIds.length > 64) runtime.removedSourceIds.splice(0, runtime.removedSourceIds.length - 64);
    for (const state of runtime.teamStates.values()) state.sourceCoverage?.delete?.(record.key);
    markTeamDirty(runtime, oldTeam);
    runtime.sourceRevision += 1;
    bump(room, "visibilitySourcesRemoved");
    registerEntityMembership(room, runtime, entity, record.entityType);
    removeTeamIfEmpty(runtime, room, oldTeam);
    return null;
  }

  registerEntityMembership(room, runtime, entity, record.entityType);
  const nextTeam = sourceTeam(record, room);
  if (record.teamId !== nextTeam) {
    const oldTeam = record.teamId;
    removeSourceFromTeam(runtime, record, oldTeam);
    record.teamId = nextTeam;
    record.teamRevision += 1;
    addSourceToTeam(runtime, record, nextTeam);
    for (const state of runtime.teamStates.values()) state.sourceCoverage?.delete?.(record.key);
    markTeamDirty(runtime, oldTeam);
    markTeamDirty(runtime, nextTeam);
    runtime.sourceRevision += 1;
    bump(room, "visibilitySourcesUpdated");
  }

  const nextCapabilityKey = capabilityKey(record, room);
  if (record.capabilityKey !== nextCapabilityKey) {
    const startedAt = performanceNow();
    // sensorCapability's legacy cache is generation keyed.  The optimized
    // registry owns the stronger revision key, so clear the legacy cache only
    // when capability inputs actually changed; movement never reaches here.
    delete entity._sensorProfileCacheGeneration;
    delete entity._sensorProfileCacheValue;
    const profileEntity = record.entityType === "relay"
      ? { ...entity, stationType: "relay", state: entity.state || "operational", alive: true }
      : entity;
    const profile = effectiveSensorProfile(profileEntity, room);
    record.omniRange = Math.max(0, Number(profile?.omniRange) || 0);
    record.directed = (profile?.directed || []).map((entry) => ({
      relativeAngle: Number(entry.relativeAngle) || 0,
      range: Math.max(0, Number(entry.range) || 0),
      halfAngle: Math.max(0, Number(entry.halfAngle) || 0),
      arcRadians: Number(entry.arcRadians) || 0,
      componentIndex: entry.componentIndex
    }));
    record.capabilityKey = nextCapabilityKey;
    record.capabilityRevision += 1;
    runtime.sourceRevision += 1;
    runtime.dirtySourceIds.add(record.key);
    markTeamDirty(runtime, record.teamId);
    bump(room, "visibilitySourcesUpdated");
    recordDuration(room, "visibilityCapabilityRefreshMs", startedAt);
  } else {
    bump(room, "visibilityCapabilityCacheHits");
  }

  const nextTransform = transformValues(entity);
  if (record.x !== nextTransform.x || record.y !== nextTransform.y || record.angle !== nextTransform.angle) {
    record.x = nextTransform.x;
    record.y = nextTransform.y;
    record.angle = nextTransform.angle;
    record.transformRevision += 1;
    runtime.sourceRevision += 1;
    runtime.dirtySourceIds.add(record.key);
    markTeamDirty(runtime, record.teamId);
    bump(room, "visibilitySourcesUpdated");
    bump(room, "visibilityTransformOnlyUpdates");
  } else {
    bump(room, "visibilitySourceCacheHits");
  }

  if (record.aliveKey !== `${entity.alive !== false ? 1 : 0}:${entity.state || ""}`) {
    record.aliveKey = `${entity.alive !== false ? 1 : 0}:${entity.state || ""}`;
    record.aliveRevision += 1;
    runtime.sourceRevision += 1;
    runtime.dirtySourceIds.add(record.key);
    markTeamDirty(runtime, record.teamId);
  }
  return record;
}

function registerSensorSource(room, entity, entityType = null) {
  const runtime = room?._visibilityRuntime;
  if (!runtime || !entity || entity.id === undefined || entity.id === null) return null;
  const type = entityTypeFor(entity, entityType);
  const key = sourceKey(entity, type);
  let record = runtime.sourceByEntityId.get(key);
  if (!record) {
    record = {
      key,
      entityId: entity.id,
      entity,
      entityType: type,
      teamId: null,
      omniRange: 0,
      directed: [],
      capabilityKey: null,
      capabilityRevision: 0,
      transformRevision: 0,
      aliveRevision: 0,
      teamRevision: 0,
      x: Number(entity.x) || 0,
      y: Number(entity.y) || 0,
      angle: Number(entity.angle) || 0,
      coverageRecords: [],
      coverageCapabilityRevision: 0,
      coverageTransformRevision: 0,
      aliveKey: ""
    };
    runtime.sourceByEntityId.set(key, record);
    runtime.sourceRevision += 1;
    bump(room, "visibilitySourcesAdded");
  } else {
    record.entity = entity;
  }
  refreshSourceRecord(room, runtime, record);
  setCounter(room, "visibilitySourcesTotal", runtime.sourceByEntityId.size);
  return runtime.sourceByEntityId.get(key) || null;
}

function unregisterEntity(room, entity, entityType = null) {
  const runtime = room?._visibilityRuntime;
  if (!runtime || !entity) return false;
  const type = entityTypeFor(entity, entityType);
  const key = sourceKey(entity, type);
  const record = runtime.sourceByEntityId.get(key);
  if (record) {
    removeSourceFromTeam(runtime, record, record.teamId);
    runtime.sourceByEntityId.delete(key);
    runtime.dirtySourceIds.delete(key);
    for (const state of runtime.teamStates.values()) state.sourceCoverage?.delete?.(key);
    markTeamDirty(runtime, record.teamId);
    runtime.sourceRevision += 1;
    runtime.removedSourceIds.push(record.entityId);
    bump(room, "visibilitySourcesRemoved");
  }
  removeEntityMembership(runtime, entity.id);
  pruneEmptyTeamContainers(room, runtime);
  runtime.entityRevision += 1;
  setCounter(room, "visibilitySourcesTotal", runtime.sourceByEntityId.size);
  return Boolean(record);
}

function registerRoomEntities(room, runtime) {
  for (const ship of room?.ships?.values?.() || []) {
    registerEntityMembership(room, runtime, ship, "ship");
    if (isLiveSource(ship, "ship")) registerSensorSource(room, ship, "ship");
  }
  if (room?.rules?.infrastructureMode === "stations") {
    for (const station of room?.stations || []) {
      registerEntityMembership(room, runtime, station, "station");
      if (isLiveSource(station, "station")) registerSensorSource(room, station, "station");
    }
  }
  if (room?.rules?.infrastructureMode !== "stations") {
    for (const point of room?.points || []) {
      if (point?.id === undefined || point?.id === null) continue;
      registerSensorSource(room, point, "relay");
    }
  }
  for (const drone of room?.drones?.values?.() || []) {
    registerEntityMembership(room, runtime, drone, "drone");
  }
}

function removeMissingEntities(room, runtime) {
  for (const [key, record] of Array.from(runtime.sourceByEntityId.entries())) {
    const exists = sourceStillInRoom(room, record);
    if (!exists) {
      removeSourceFromTeam(runtime, record, record.teamId);
      runtime.sourceByEntityId.delete(key);
      runtime.dirtySourceIds.delete(key);
      for (const state of runtime.teamStates.values()) state.sourceCoverage?.delete?.(key);
      markTeamDirty(runtime, record.teamId);
      runtime.sourceRevision += 1;
      runtime.removedSourceIds.push(record.entityId);
      if (runtime.removedSourceIds.length > 64) runtime.removedSourceIds.splice(0, runtime.removedSourceIds.length - 64);
      bump(room, "visibilitySourcesRemoved");
    }
  }
  for (const [id, entry] of Array.from(runtime.entityTeamCache.entries())) {
    const exists = entry.entityType === "ship"
      ? room?.ships?.get?.(id) === entry.entity
      : entry.entityType === "station"
        ? (room?.stations || []).includes(entry.entity)
        : room?.drones?.get?.(id) === entry.entity;
    if (!exists) removeEntityMembership(runtime, id, entry);
  }
}

function bootstrapRuntime(room, runtime) {
  runtime.sourceByEntityId.clear();
  runtime.sourcesByTeam.clear();
  runtime.teamEntityIds.clear();
  runtime.entityTeamCache.clear();
  runtime.dirtySourceIds.clear();
  runtime.removedSourceIds.length = 0;
  runtime.sourceRevision += 1;
  registerRoomEntities(room, runtime);
  runtime.collectionStamp = collectionStamp(room);
  runtime.bootstrapped = true;
  runtime.lastReconciledGeneration = runtime.generation;
  runtime.reconcileRequested = false;
  runtime.allTeamsDirty = true;
  runtime.fullInvalidationGeneration = runtime.generation;
  runtime.dirtyTeams.clear();
  setCounter(room, "visibilitySourcesTotal", runtime.sourceByEntityId.size);
}

function synchronizeCollections(room, runtime) {
  const nextStamp = collectionStamp(room);
  if (!runtime.bootstrapped) {
    bootstrapRuntime(room, runtime);
    return;
  }
  if (!collectionStampChanged(runtime.collectionStamp, nextStamp)) return;
  const startedAt = performanceNow();
  registerRoomEntities(room, runtime);
  removeMissingEntities(room, runtime);
  runtime.collectionStamp = nextStamp;
  runtime.entityRevision += 1;
  runtime.allTeamsDirty = true;
  runtime.fullInvalidationGeneration = runtime.generation;
  for (const teamId of runtime.teamStates.keys()) runtime.dirtyTeams.add(teamId);
  for (const state of runtime.teamStates.values()) state.computedGeneration = 0;
  pruneEmptyTeamContainers(room, runtime);
  bump(room, "visibilityFullInvalidations");
  recordDuration(room, "visibilitySourceMaintenanceMs", startedAt);
}

// Collection identity/size stamps catch normal lifecycle mutations cheaply.
// A bounded periodic reconciliation also catches uncommon direct map/array
// replacement paths (including same-size replacement) without making every
// team computation rediscover every entity.
function reconcileVisibilityRuntime(room) {
  const runtime = ensureVisibilityRuntime(room);
  if (!runtime || !usesSensorVisibility(room)) return runtime;
  runtime.generation = roomVisibilityGeneration(room);
  const startedAt = performanceNow();
  const beforeSourceRevision = runtime.sourceRevision;
  const beforeEntityRevision = runtime.entityRevision;
  const beforeSourceCount = runtime.sourceByEntityId.size;
  const beforeEntityCount = runtime.entityTeamCache.size;
  registerRoomEntities(room, runtime);
  removeMissingEntities(room, runtime);
  runtime.collectionStamp = collectionStamp(room);
  runtime.lastReconciledGeneration = runtime.generation;
  runtime.reconcileRequested = false;
  const changed = beforeSourceRevision !== runtime.sourceRevision
    || beforeEntityRevision !== runtime.entityRevision
    || beforeSourceCount !== runtime.sourceByEntityId.size
    || beforeEntityCount !== runtime.entityTeamCache.size;
  if (changed) {
    runtime.entityRevision += 1;
    runtime.allTeamsDirty = true;
    runtime.fullInvalidationGeneration = runtime.generation;
    for (const teamId of runtime.teamStates.keys()) runtime.dirtyTeams.add(teamId);
    for (const state of runtime.teamStates.values()) state.computedGeneration = 0;
    bump(room, "visibilityFullInvalidations");
  }
  bump(room, "visibilityReconciliations");
  recordDuration(room, "visibilitySourceMaintenanceMs", startedAt);
  return runtime;
}

function maintainVisibilityRuntime(room) {
  const runtime = ensureVisibilityRuntime(room);
  if (!runtime || !usesSensorVisibility(room)) return runtime;
  runtime.generation = roomVisibilityGeneration(room);
  if (runtime.lastMaintenanceGeneration === runtime.generation && !runtime.reconcileRequested) {
    setCounter(room, "visibilitySourcesTotal", runtime.sourceByEntityId.size);
    return runtime;
  }
  const startedAt = performanceNow();
  synchronizeCollections(room, runtime);
  if (runtime.reconcileRequested
    || runtime.lastReconciledGeneration <= 0
    || runtime.generation - runtime.lastReconciledGeneration >= RECONCILE_INTERVAL_GENERATIONS) {
    reconcileVisibilityRuntime(room);
  }
  for (const record of Array.from(runtime.sourceByEntityId.values())) {
    if (!sourceStillInRoom(room, record)) {
      const oldTeam = record.teamId;
      removeSourceFromTeam(runtime, record, oldTeam);
      runtime.sourceByEntityId.delete(record.key);
      runtime.dirtySourceIds.delete(record.key);
      for (const state of runtime.teamStates.values()) state.sourceCoverage?.delete?.(record.key);
      removeEntityMembership(runtime, record.entity.id);
      markTeamDirty(runtime, oldTeam);
      runtime.sourceRevision += 1;
      runtime.removedSourceIds.push(record.entityId);
      if (runtime.removedSourceIds.length > 64) runtime.removedSourceIds.splice(0, runtime.removedSourceIds.length - 64);
      bump(room, "visibilitySourcesRemoved");
      continue;
    }
    refreshSourceRecord(room, runtime, record);
  }
  for (const [id, entry] of Array.from(runtime.entityTeamCache.entries())) {
    if (entry.entityType !== "drone") continue;
    const drone = room?.drones?.get?.(id);
    if (!drone || !isLiveEntity(drone, "drone")) {
      removeEntityMembership(runtime, id, entry);
      continue;
    }
    registerEntityMembership(room, runtime, drone, "drone");
  }
  pruneEmptyTeamContainers(room, runtime);
  runtime.lastMaintenanceGeneration = runtime.generation;
  runtime.lastMaintenanceAt = performanceNow();
  setCounter(room, "visibilitySourcesTotal", runtime.sourceByEntityId.size);
  recordDuration(room, "visibilitySourceMaintenanceMs", startedAt);
  return runtime;
}

function ensureVisibilityRuntime(room) {
  if (!room) return null;
  const epoch = Number(room.stateEpoch) || 1;
  let runtime = room._visibilityRuntime;
  if (!runtime || runtime.epoch !== epoch) {
    if (runtime && runtime.epoch !== epoch) {
      // A new state epoch cannot inherit remembered contacts or visible IDs
      // from the previous match, even if the caller changed the epoch before
      // invoking the normal room reset helper.
      for (const state of room.visibilityByTeam?.values?.() || []) {
        state.visibleEntityIds?.clear?.();
        state.nextVisibleEntityIds?.clear?.();
        state.remembered?.clear?.();
        state.coverage?.splice?.(0);
        state.sourceCoverage?.clear?.();
        state.snapshotFilterCache = null;
      }
      room.visibilityByTeam?.clear?.();
    }
    runtime = createRuntime(room);
    room._visibilityRuntime = runtime;
    if (!room.visibilityByTeam) room.visibilityByTeam = new Map();
  }
  const modeChanged = runtime.visibilityMode !== room?.rules?.visibilityMode
    || runtime.infrastructureMode !== room?.rules?.infrastructureMode;
  if (modeChanged) {
    for (const state of room.visibilityByTeam?.values?.() || []) {
      state.visibleEntityIds?.clear?.();
      state.nextVisibleEntityIds?.clear?.();
      state.remembered?.clear?.();
      state.coverage?.splice?.(0);
      state.sourceCoverage?.clear?.();
      state.snapshotFilterCache = null;
    }
    room.visibilityByTeam?.clear?.();
    runtime.teamStates.clear();
    runtime.visibilityMode = room?.rules?.visibilityMode;
    runtime.infrastructureMode = room?.rules?.infrastructureMode;
    runtime.bootstrapped = false;
    runtime.allTeamsDirty = true;
  }
  synchronizeCollections(room, runtime);
  return runtime;
}

function ensureStateShape(room, runtime, teamId) {
  if (!room.visibilityByTeam) room.visibilityByTeam = new Map();
  let state = runtime.teamStates.get(teamId) || room.visibilityByTeam.get(teamId);
  if (!state) {
    state = {
      visibleEntityIds: new Set(),
      nextVisibleEntityIds: new Set(),
      remembered: new Map(),
      coverage: [],
      sourceCoverage: new Map(),
      sourceCoverageRevision: 0,
      resultRevision: 1,
      revision: 1,
      computedAt: Number.NEGATIVE_INFINITY,
      computedGeneration: 0,
      visibleShips: [],
      visibleDrones: [],
      visibleStations: [],
      snapshotFilterCache: null
    };
  }
  if (!(state.visibleEntityIds instanceof Set)) state.visibleEntityIds = new Set();
  if (!(state.nextVisibleEntityIds instanceof Set)) state.nextVisibleEntityIds = new Set();
  if (!(state.remembered instanceof Map)) state.remembered = new Map();
  if (!Array.isArray(state.coverage)) state.coverage = [];
  if (!(state.sourceCoverage instanceof Map)) state.sourceCoverage = new Map();
  if (state._visibilityRuntimeInitialized !== true) {
    // A room may have a legacy state from an earlier flag setting. Keep its
    // visible/remembered sets for contact continuity, but force one optimized
    // coverage rebuild before serving the result.
    state.sourceCoverage.clear();
    state.coverage.length = 0;
    state.computedGeneration = 0;
    state.snapshotFilterCache = null;
    state._visibilityRuntimeInitialized = true;
  }
  if (!Number.isSafeInteger(state.resultRevision)) state.resultRevision = Number(state.revision) || 1;
  if (!Number.isSafeInteger(state.revision)) state.revision = state.resultRevision;
  if (!Array.isArray(state.visibleShips)) state.visibleShips = [];
  if (!Array.isArray(state.visibleDrones)) state.visibleDrones = [];
  if (!Array.isArray(state.visibleStations)) state.visibleStations = [];
  if (!Number.isFinite(state.computedAt)) state.computedAt = Number.NEGATIVE_INFINITY;
  if (!Number.isSafeInteger(state.computedGeneration)) state.computedGeneration = 0;
  runtime.teamStates.set(teamId, state);
  room.visibilityByTeam.set(teamId, state);
  return state;
}

function sourceCoverageForTeam(room, runtime, state, teamId) {
  const startedAt = performanceNow();
  const sources = runtime.sourcesByTeam.get(teamId) || [];
  const sourceMap = state.sourceCoverage;
  const activeKeys = new Set();
  for (const record of sources) {
    activeKeys.add(record.key);
    if (record.coverageCapabilityRevision !== record.capabilityRevision
      || record.coverageTransformRevision !== record.transformRevision
      || runtime.dirtySourceIds.has(record.key)) {
      updateSourceCoverage(record);
      runtime.dirtySourceIds.delete(record.key);
    }
    sourceMap.set(record.key, record.coverageRecords);
  }
  for (const key of Array.from(sourceMap.keys())) if (!activeKeys.has(key)) sourceMap.delete(key);

  // Reuse the same flat array object.  The entries inside it are also reused by
  // the source record; only a changed capability layout allocates a new entry.
  state.coverage.length = 0;
  for (const record of sources) {
    const coverage = sourceMap.get(record.key) || [];
    for (const entry of coverage) state.coverage.push(entry);
  }
  state.sourceCoverageRevision = runtime.sourceRevision;
  recordDuration(room, "visibilityCoverageUpdateMs", startedAt);
  return sources;
}

function isPointInCoverage(coverage, x, y, padding = 0) {
  const dx = (Number(x) || 0) - (Number(coverage?.x) || 0);
  const dy = (Number(y) || 0) - (Number(coverage?.y) || 0);
  const extra = Math.max(0, Number(padding) || 0);
  const reach = (Number(coverage?.range) || 0) + extra;
  const distanceSq = dx * dx + dy * dy;
  const reachSquared = extra === 0 && Number.isFinite(Number(coverage?.rangeSquared))
    ? Number(coverage.rangeSquared)
    : reach * reach;
  if (distanceSq > reachSquared) return false;
  if (coverage?.shape !== "cone") return true;
  if (distanceSq <= extra * extra) return true;
  const distance = Math.sqrt(distanceSq);
  const angularPadding = extra > 0 ? Math.asin(Math.min(1, extra / distance)) : 0;
  // Keep the legacy angular method as the rollout reference.  The precomputed
  // cosine is retained on the hot record for a future proven dot-product path.
  return Math.abs(angleDifference(Number(coverage.angle) || 0, Math.atan2(dy, dx)))
    <= (Number(coverage.halfAngle) || 0) + angularPadding;
}

function coverageSeesPoint(coverageRecords, x, y, padding = 0) {
  for (const coverage of coverageRecords || []) {
    if (isPointInCoverage(coverage, x, y, padding)) return true;
  }
  return false;
}

function cachedEntityTeam(room, runtime, entity) {
  if (!entity) return null;
  const cached = runtime.entityTeamCache.get(entity.id);
  if (cached?.entity === entity) return cached.teamId;
  const type = entityTypeFor(entity);
  registerEntityMembership(room, runtime, entity, type);
  return runtime.entityTeamCache.get(entity.id)?.teamId ?? teamOfEntity(room, entity);
}

function collectionForKind(room, kind) {
  if (kind === "ships") return room?.ships?.values?.() || [];
  if (kind === "drones") return room?.drones?.values?.() || [];
  if (kind === "stations") return room?.stations || [];
  return [];
}

function collectionLength(room, kind) {
  if (kind === "ships" || kind === "drones") return room?.[kind]?.size || 0;
  return room?.stations?.length || 0;
}

function hasSpatialCategory(room, kind) {
  const index = room?.spatialIndex;
  if (!index || index.dynamicValid === false || typeof index.queryRangeUnordered !== "function") return false;
  if (typeof index.count !== "function") return true;
  return (index.count(kind) || 0) > 0 || collectionLength(room, kind) === 0;
}

function queryCandidates(room, runtime, kind, record, range) {
  const index = room?.spatialIndex;
  const available = hasSpatialCategory(room, kind);
  if (available) {
    const scratch = kind === "ships"
      ? runtime.shipQueryScratch
      : kind === "drones" ? runtime.droneQueryScratch : runtime.stationQueryScratch;
    const startedAt = performanceNow();
    scratch.length = 0;
    const result = index.queryRangeUnordered(kind, record.x, record.y, range, scratch);
    recordDuration(room, kind === "ships" ? "visibilityShipQueriesMs" : kind === "drones" ? "visibilityDroneQueriesMs" : "visibilityStationQueriesMs", startedAt);
    bump(room, kind === "ships" ? "visibilityShipQueries" : kind === "drones" ? "visibilityDroneQueries" : "visibilityStationQueries");
    return result || scratch;
  }
  bump(room, "visibilityFullCollectionFallbacks");
  return collectionForKind(room, kind);
}

function maxSourceRange(record) {
  let range = Math.max(0, Number(record.omniRange) || 0);
  for (const directed of record.directed || []) range = Math.max(range, Number(directed.range) || 0);
  return range;
}

function addDetectedTargets(room, runtime, teamId, record, state, current) {
  const coverage = record.coverageRecords || [];
  const range = maxSourceRange(record);
  if (!(range > 0) || coverage.length === 0) return;

  const ships = queryCandidates(room, runtime, "ships", record, range);
  for (const target of ships) {
    if (!target?.id) continue;
    if (current.has(target.id)) {
      bump(room, "visibilityCandidatesAlreadyVisible");
      continue;
    }
    bump(room, "visibilityShipCandidates");
    if (!isLiveEntity(target, "ship")) continue;
    if (cachedEntityTeam(room, runtime, target) === teamId) continue;
    if (coverageSeesPoint(coverage, target.x, target.y, targetRadius(target))) {
      current.add(target.id);
      bump(room, "visibilityEntitiesDetected");
    }
  }

  const drones = queryCandidates(room, runtime, "drones", record, range);
  for (const target of drones) {
    if (!target?.id) continue;
    if (current.has(target.id)) {
      bump(room, "visibilityCandidatesAlreadyVisible");
      continue;
    }
    bump(room, "visibilityDroneCandidates");
    if (!isLiveEntity(target, "drone")) continue;
    if (cachedEntityTeam(room, runtime, target) === teamId) continue;
    if (coverageSeesPoint(coverage, target.x, target.y, targetRadius(target))) {
      current.add(target.id);
      bump(room, "visibilityEntitiesDetected");
    }
  }

  const stations = queryCandidates(room, runtime, "stations", record, range);
  for (const target of stations) {
    if (!target?.id) continue;
    if (current.has(target.id)) {
      bump(room, "visibilityCandidatesAlreadyVisible");
      continue;
    }
    bump(room, "visibilityStationCandidates");
    if (!isLiveEntity(target, "station")) continue;
    if (cachedEntityTeam(room, runtime, target) === teamId) continue;
    if (coverageSeesPoint(coverage, target.x, target.y, targetRadius(target))) {
      current.add(target.id);
      bump(room, "visibilityEntitiesDetected");
    }
  }
}

function addAlliedEntities(room, runtime, teamId, current) {
  const sets = runtime.teamEntityIds.get(teamId);
  if (!sets) return;
  for (const [setName, entityType] of [["ships", "ship"], ["stations", "station"], ["drones", "drone"]]) {
    for (const id of Array.from(sets[setName])) {
      const entry = runtime.entityTeamCache.get(id);
      if (!entry || !isLiveEntity(entry.entity, entityType) || cachedEntityTeam(room, runtime, entry.entity) !== teamId) {
        sets[setName].delete(id);
        continue;
      }
      current.add(id);
    }
  }
}

function classifyVisibleEntities(runtime, state) {
  state.visibleShips.length = 0;
  state.visibleDrones.length = 0;
  state.visibleStations.length = 0;
  for (const id of state.visibleEntityIds) {
    const entry = runtime.entityTeamCache.get(id);
    if (entry?.entityType === "drone") state.visibleDrones.push(id);
    else if (entry?.entityType === "station") state.visibleStations.push(id);
    else state.visibleShips.push(id);
  }
  state.visibleShips.sort(compareNaturalIds);
  state.visibleDrones.sort(compareNaturalIds);
  state.visibleStations.sort(compareNaturalIds);
}

function updateRememberedContacts(room, state, previouslyVisible, current, computedAt, teamId) {
  const startedAt = performanceNow();
  let newlyLost = 0;
  for (const id of previouslyVisible) {
    if (current.has(id) || state.remembered.has(id)) continue;
    const entity = room?.ships?.get?.(id);
    if (!entity || teamOfEntity(room, entity) === teamId) continue;
    const contact = buildRememberedContact(room, entity, computedAt);
    contact.firstLostAt = computedAt;
    contact.expiresAt = computedAt + DETECTION_LINGER_MS + REMEMBERED_CONTACT_MS;
    state.remembered.set(id, contact);
    newlyLost += 1;
    bump(room, "visibilityContactsRemembered");
  }
  for (const [id, contact] of state.remembered) {
    if (current.has(id)) {
      state.remembered.delete(id);
      continue;
    }
    if (computedAt >= (contact.expiresAt || 0)) {
      state.remembered.delete(id);
      bump(room, "visibilityContactsExpired");
      continue;
    }
    if (computedAt < (contact.firstLostAt || 0) + DETECTION_LINGER_MS) {
      current.add(id);
      bump(room, "visibilityLingeredEntities");
    }
  }
  if (newlyLost) bump(room, "visibilityEntitiesLost", newlyLost);
  recordDuration(room, "visibilityRememberedMs", startedAt);
}

function computeTeamVisibilityInternal(room, teamOrOwnerId, now, force = false) {
  const runtime = maintainVisibilityRuntime(room);
  const computedAt = Number.isFinite(Number(now)) ? Number(now) : 0;
  const teamId = normalizedTeamId(room, teamOrOwnerId);
  const state = ensureStateShape(room, runtime, teamId);
  const generation = roomVisibilityGeneration(room);
  const fullDirty = runtime.allTeamsDirty
    && runtime.fullInvalidationGeneration === generation
    && state.computedGeneration !== generation;
  // Remembered contacts have time-based linger/expiry semantics even when no
  // source or target geometry changed. Revisit those teams as simulation time
  // advances so a scoped source invalidation cannot leave stale contacts alive.
  const generationChanged = state.computedGeneration !== generation;
  const rememberedTimeChanged = generationChanged
    && state.remembered.size > 0
    && computedAt > (Number(state.computedAt) || Number.NEGATIVE_INFINITY);
  const dirty = force || runtime.dirtyTeams.has(teamId) || fullDirty || rememberedTimeChanged;
  bump(room, "visibilityTeamsConsidered");
  if (!dirty) {
    // A scoped invalidation can advance the room generation without touching
    // this team's dependencies. Carry the exact result forward rather than
    // rebuilding it merely because the global epoch moved.
    state.computedGeneration = generation;
    bump(room, "visibilityTeamCacheHits");
    return state;
  }
  bump(room, "visibilityTeamsDirty");
  const runtimeStartedAt = performanceNow();
  const previouslyVisible = state.visibleEntityIds;
  const current = state.nextVisibleEntityIds;
  current.clear();
  const sources = sourceCoverageForTeam(room, runtime, state, teamId);
  addAlliedEntities(room, runtime, teamId, current);
  for (const record of sources) addDetectedTargets(room, runtime, teamId, record, state, current);
  updateRememberedContacts(room, state, previouslyVisible, current, computedAt, teamId);

  state.visibleEntityIds = current;
  state.nextVisibleEntityIds = previouslyVisible;
  state.computedAt = computedAt;
  state.computedGeneration = generation;
  state.resultRevision = (Number(state.resultRevision) || 0) + 1;
  state.revision = state.resultRevision;
  state.snapshotFilterCache = null;
  classifyVisibleEntities(runtime, state);
  runtime.teamStates.set(teamId, state);
  runtime.dirtyTeams.delete(teamId);
  room._lastVisibilityComputeAt = computedAt;
  room._visibilityComputeCount = (Number(room._visibilityComputeCount) || 0) + 1;
  if (room._visibilityFinalizationInvalidated) {
    bump(room, "visibilityComputesAfterFinalization");
    room._visibilityFinalizationInvalidated = false;
  }
  bump(room, "visibilityTeamsComputed");
  recordDuration(room, "visibilityRuntimeMs", runtimeStartedAt);
  return state;
}

function ensureTeamVisibility(room, teamOrOwnerId, now) {
  if (!usesSensorVisibility(room)) return null;
  const runtime = maintainVisibilityRuntime(room);
  const teamId = normalizedTeamId(room, teamOrOwnerId);
  const state = ensureStateShape(room, runtime, teamId);
  const generation = roomVisibilityGeneration(room);
  const fullDirty = runtime.allTeamsDirty
    && runtime.fullInvalidationGeneration === generation
    && state.computedGeneration !== generation;
  const computedAt = Number.isFinite(Number(now)) ? Number(now) : 0;
  const generationChanged = state.computedGeneration !== generation;
  const rememberedTimeChanged = generationChanged
    && state.remembered.size > 0
    && computedAt > (Number(state.computedAt) || Number.NEGATIVE_INFINITY);
  if (runtime.dirtyTeams.has(teamId) || fullDirty || state.computedGeneration === 0 || rememberedTimeChanged) {
    return computeTeamVisibilityInternal(room, teamId, now, false);
  }
  if (state.computedGeneration !== generation) state.computedGeneration = generation;
  bump(room, "visibilityTeamCacheHits");
  return state;
}

function computeTeamVisibility(room, teamOrOwnerId, now) {
  if (!usesSensorVisibility(room)) {
    return {
      visibleEntityIds: new Set(),
      nextVisibleEntityIds: new Set(),
      remembered: new Map(),
      coverage: [],
      sourceCoverage: new Map(),
      revision: 0,
      resultRevision: 0,
      computedAt: Number.isFinite(Number(now)) ? Number(now) : 0,
      computedGeneration: roomVisibilityGeneration(room),
      visibleShips: [],
      visibleDrones: [],
      visibleStations: []
    };
  }
  return computeTeamVisibilityInternal(room, teamOrOwnerId, now, true);
}

function getCachedEntityTeam(room, entity) {
  const runtime = ensureVisibilityRuntime(room);
  const cached = runtime.entityTeamCache.get(entity?.id);
  if (cached?.entity === entity) return cached.teamId;
  // Snapshot-only tactical rows (bullets, effects and decoys) are not allied
  // entity members.  Resolve their public owner relationship without adding
  // them to the maintained ship/station/drone membership sets.
  return teamOfEntity(room, entity);
}

function isPointVisibleInState(state, x, y, padding = 0) {
  if (!state) return false;
  return coverageSeesPoint(state.coverage || [], x, y, padding);
}

function invalidateVisibility(room, options = {}) {
  const runtime = ensureVisibilityRuntime(room);
  if (!runtime) return;
  const input = typeof options === "string" ? { reason: options } : (options || {});
  runtime.generation = roomVisibilityGeneration(room);
  const sourceTeams = input.sourceTeams instanceof Set ? input.sourceTeams : input.sourceTeams ? new Set(input.sourceTeams) : null;
  const targetTeams = input.targetTeams instanceof Set ? input.targetTeams : input.targetTeams ? new Set(input.targetTeams) : null;
  if (sourceTeams || targetTeams || input.sourceIds || input.entityIds) {
    if (sourceTeams) for (const teamId of sourceTeams) markTeamDirty(runtime, teamId);
    if (targetTeams) for (const teamId of targetTeams) markTeamDirty(runtime, teamId);
    for (const sourceId of input.sourceIds || []) {
      const record = runtime.sourceByEntityId.get(sourceId) || runtime.sourceByEntityId.get(`relay:${String(sourceId)}`);
      if (record) markTeamDirty(runtime, record.teamId);
    }
    if (input.entityIds && !targetTeams && !sourceTeams) {
      runtime.allTeamsDirty = true;
      runtime.fullInvalidationGeneration = runtime.generation;
    }
    if (input.geometryChanged || input.allegianceChanged) {
      runtime.allTeamsDirty = true;
      runtime.fullInvalidationGeneration = runtime.generation;
    }
    bump(room, "visibilityTeamScopedInvalidations");
  } else {
    runtime.allTeamsDirty = true;
    runtime.fullInvalidationGeneration = runtime.generation;
    bump(room, "visibilityFullInvalidations");
  }
  if (input.geometryChanged || input.allegianceChanged) runtime.allTeamsDirty = true;
  for (const state of runtime.teamStates.values()) state.snapshotFilterCache = null;
}

function clearVisibilityForRoom(room) {
  if (!room) return;
  const runtime = room._visibilityRuntime;
  if (runtime) {
    runtime.sourceByEntityId.clear();
    runtime.sourcesByTeam.clear();
    runtime.teamEntityIds.clear();
    runtime.teamStates.clear();
    runtime.entityTeamCache.clear();
    runtime.dirtySourceIds.clear();
    runtime.removedSourceIds.length = 0;
    runtime.shipQueryScratch.length = 0;
    runtime.droneQueryScratch.length = 0;
    runtime.stationQueryScratch.length = 0;
  }
  for (const state of room.visibilityByTeam?.values?.() || []) {
    state.visibleEntityIds?.clear?.();
    state.nextVisibleEntityIds?.clear?.();
    state.remembered?.clear?.();
    state.coverage?.splice?.(0);
    state.sourceCoverage?.clear?.();
    state.snapshotFilterCache = null;
  }
  room.visibilityByTeam?.clear?.();
  room._visibilityRuntime = null;
}

function getTeamState(room, teamId) {
  const runtime = ensureVisibilityRuntime(room);
  return ensureStateShape(room, runtime, normalizedTeamId(room, teamId));
}

module.exports = {
  usesSensorVisibility,
  normalizedTeamId,
  teamOfEntity,
  ensureVisibilityRuntime,
  maintainVisibilityRuntime,
  reconcileVisibilityRuntime,
  registerSensorSource,
  registerEntityMembership,
  unregisterEntity,
  computeTeamVisibility,
  ensureTeamVisibility,
  getTeamState,
  getCachedEntityTeam,
  isPointInCoverage,
  isPointVisibleInState,
  invalidateVisibility,
  clearVisibilityForRoom,
  DETECTION_LINGER_MS,
  REMEMBERED_CONTACT_MS
};
