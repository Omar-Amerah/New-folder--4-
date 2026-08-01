"use strict";

// Phase 5's server-side patch builder.  It consumes the already permissioned
// snapshot entries produced by snapshots.js; it never reads a viewer's room
// state directly and it never advances client knowledge.  The delivery
// lifecycle supplies the returned nextState only after a frame is written.

const {
  ENTITY_DELTA_FORMAT_VERSION,
  SHIP_STATE_FIELDS,
  SHIP_STATE_SIGNATURE_FIELDS,
  PRIVATE_SHIP_FIELDS,
  GENERIC_MOTION_FIELDS,
  packShipMotion,
  cleanNumber
} = require("../../public/src/shared/snapshotEntityDelta");

const GENERIC_STATE_FIELDS = Object.freeze({
  drones: ["ownerId", "parentShipId", "bayComponentId", "type", "state", "radius", "hull", "maxHull", "targetId", "fuelCapacitySeconds"],
  decoys: ["ownerId", "parentShipId", "radius"],
  effects: ["type", "subtype", "ownerId", "x", "y", "x2", "y2", "nx", "ny", "radius", "text", "reason"],
  players: [
    "name", "color", "colour", "team", "teamName", "isBot", "isAdmin", "connected", "ready", "money", "income",
    "earned", "spent", "shipCap", "activeFleetCost", "deployedFleetCost", "destroyedEnemyCost", "lastReward",
    "activeShips", "kills", "losses", "captures", "rallyPoint", "rallyPointCustom", "shipsBuilt", "lostFleetCost"
  ],
  points: ["x", "y", "radius", "ownerId", "ownerTeam", "contested", "progress", "stationId"]
});
const STATION_SIGNATURE_FIELDS = Object.freeze([
  "hp", "shield", "team", "ownerId", "state", "sensorRange", "weaponRange", "revision", "healthRevision",
  "componentDamageRevision", "stateRevision", "productionRevision", "captureProgress", "captureContested", "captureTeam",
  "weaponAngles", "weaponAnglePairs", "conditionKnown", "productionQueue"
]);
const GENERIC_KNOWN_FIELDS = Object.freeze(Object.fromEntries(
  Object.keys(GENERIC_STATE_FIELDS).map((kind) => [
    kind,
    new Set(["id", ...(GENERIC_MOTION_FIELDS[kind] || []), ...(GENERIC_STATE_FIELDS[kind] || [])])
  ])
));

function sortedIds(values) {
  return [...values].sort((a, b) => String(a).localeCompare(String(b)));
}

function idOf(entry) {
  return entry?.id;
}

function hasOwn(entry, key) {
  // Sparse v2 server rows may inherit viewer-independent fields from the
  // shared snapshot.  They are still real schema values even when they are
  // not own properties of the tiny viewer overlay.
  return entry != null && entry[key] !== undefined;
}

function copyFields(entry, fields) {
  const result = {};
  for (const field of fields || []) if (hasOwn(entry, field)) result[field] = entry[field];
  return result;
}

// Small direct structural signature.  It avoids JSON.stringify in the hot
// path and is used only for sparse state fields, never for a complete entity.
function signature(value, depth = 0) {
  if (depth > 8) return "#depth";
  if (value === null) return "#null";
  if (value === undefined) return "#undefined";
  if (typeof value === "number") {
    const n = cleanNumber(value, 0);
    return `#n${Object.is(n, -0) ? 0 : n}`;
  }
  if (typeof value === "boolean") return value ? "#true" : "#false";
  if (typeof value === "string") return `#s${value.length}:${value}`;
  if (Array.isArray(value)) return `#a${value.length}[${value.map((entry) => signature(entry, depth + 1)).join("|")}]`;
  if (typeof value === "object") {
    return `#o{${Object.keys(value).sort().map((key) => `${signature(key, depth + 1)}=${signature(value[key], depth + 1)}`).join("|")}}`;
  }
  return `#${typeof value}`;
}

function createSnapshotEntityState(stateEpoch = 0) {
  return {
    stateEpoch: Number(stateEpoch) || 0,
    ships: new Map(),
    drones: new Map(),
    decoys: new Map(),
    stations: new Map(),
    players: new Map(),
    points: new Map(),
    effects: new Map()
  };
}

function shipState(entry) {
  return copyFields(entry, SHIP_STATE_FIELDS);
}

function shipPrivate(entry) {
  return copyFields(entry, PRIVATE_SHIP_FIELDS);
}

function shipPrivateSignature(entry) {
  // Revisions carry the expensive array changes.  Small status blocks and
  // explicit component deltas are included so fixtures that update a field
  // without bumping a revision still receive the change.
  return signature([
    entry?.powerRevision || 0,
    entry?.powerProtectionRevision || 0,
    entry?.wiringRevision || 0,
    entry?.powerWiringRevision || 0,
    entry?.componentHeatRevision || 0,
    entry?.heatTelemetryRevision || 0,
    entry?.chpD,
    entry?.componentHeatD,
    entry?.__entityDeltaClearPrivateFields || [],
    // Full baselines contain complete HP/Heat arrays while compact packets
    // intentionally omit them when unchanged.  Their revision/delta fields,
    // not presence of the carried baseline arrays, determine the signature.
  ]);
}

function makeShipRecord(entry) {
  const motion = packShipMotion(entry);
  const stateKeys = SHIP_STATE_FIELDS.filter((field) => hasOwn(entry, field));
  const privateKeys = PRIVATE_SHIP_FIELDS.filter((field) => hasOwn(entry, field));
  const sharedStateSignature = entry?.__entityDeltaStateSignature;
  return {
    detail: entry?.detail || "full",
    designRevision: Number(entry?.designRevision) || 0,
    motion,
    motionSignature: signature(motion),
    // Keep the field order fixed instead of allocating a complete state
    // object and sorting its keys for every ship on every compact frame.
    stateSignature: sharedStateSignature !== undefined
      ? sharedStateSignature
      : SHIP_STATE_SIGNATURE_FIELDS.map((field) => `${field}=${signature(entry?.[field])}`).join("|"),
    stateKeys,
    statePresentFields: stateKeys,
    privateKeys,
    privatePresentFields: privateKeys,
    clearStateFields: Array.isArray(entry?.__entityDeltaClearStateFields) ? entry.__entityDeltaClearStateFields.slice() : [],
    clearPrivateFields: Array.isArray(entry?.__entityDeltaClearPrivateFields) ? entry.__entityDeltaClearPrivateFields.slice() : [],
    privateSignature: shipPrivateSignature(entry)
  };
}

function genericMotion(entry, kind) {
  return [idOf(entry), ...(GENERIC_MOTION_FIELDS[kind] || []).map((field) => cleanNumber(entry?.[field]))];
}

function genericState(entry, kind) {
  return copyFields(entry, GENERIC_STATE_FIELDS[kind]);
}

function genericRemaining(entry, kind) {
  const known = GENERIC_KNOWN_FIELDS[kind] || new Set(["id"]);
  const result = {};
  for (const key of Object.keys(entry || {})) {
    if (!known.has(key)) result[key] = entry[key];
  }
  return result;
}

function genericRecord(entry, kind) {
  const state = genericState(entry, kind);
  const motion = genericMotion(entry, kind);
  const remaining = genericRemaining(entry, kind);
  const stateKeys = Object.keys(state);
  const remainingKeys = Object.keys(remaining);
  return {
    motion,
    motionSignature: signature(motion.slice(1)),
    stateSignature: signature(state),
    remainingSignature: signature(remaining),
    remaining,
    stateKeys,
    remainingKeys,
    publicFields: [...stateKeys, ...remainingKeys]
  };
}

function stationRecord(entry) {
  return { entrySignature: signature(copyFields(entry, STATION_SIGNATURE_FIELDS)) };
}

function pointRecord(entry) {
  return { entrySignature: signature(entry) };
}

function effectRecord(entry) {
  return genericRecord(entry, "effects");
}

function mapEntries(entries) {
  const result = new Map();
  for (const entry of entries || []) {
    const id = idOf(entry);
    if (id !== undefined && id !== null) result.set(id, entry);
  }
  return result;
}

function mapRecords(map) {
  const result = new Map();
  for (const [id, entry] of map) result.set(id, entry);
  return result;
}

function entityIdsForRemoval(previous, current) {
  const remove = [];
  for (const id of previous.keys()) if (!current.has(id)) remove.push(id);
  return sortedIds(remove);
}

function buildShipPatch(entries, previous, options = {}) {
  const current = mapEntries(entries);
  const upsert = [];
  const motion = [];
  const state = [];
  const privatePatch = [];
  const clearPrivate = [];
  const clearStateFields = [];
  const clearPrivateFields = [];
  const next = new Map();
  const baselineIds = options.baselineIds instanceof Set ? options.baselineIds : new Set();

  for (const id of sortedIds(current.keys())) {
    const entry = current.get(id);
    const old = previous.get(id);
    const record = makeShipRecord(entry);
    const baseline = !old || baselineIds.has(id) || old.detail !== record.detail || old.designRevision !== record.designRevision;
    if (baseline) {
      if (old?.detail === "full" && record.detail === "public") clearPrivate.push(id);
      record.statePresentFields = record.stateKeys.slice();
      record.privatePresentFields = record.privateKeys.slice();
      upsert.push(entry);
      next.set(id, record);
      continue;
    }
    if (old.motionSignature !== record.motionSignature) motion.push(record.motion);
    const oldStateFields = new Set(old.statePresentFields || old.stateKeys || []);
    const stateClears = record.clearStateFields.filter((field) => oldStateFields.has(field));
    if (stateClears.length) clearStateFields.push([id, stateClears]);
    const stateValue = shipState(entry);
    if (old.stateSignature !== record.stateSignature && Object.keys(stateValue).length) state.push([id, stateValue]);
    const focusedRefresh = options.telemetryFocusShipId === id && hasOwn(entry, "powerThermal");
    const oldPrivateFields = new Set(old.privatePresentFields || old.privateKeys || []);
    const privateClears = record.clearPrivateFields.filter((field) => oldPrivateFields.has(field));
    if (privateClears.length) clearPrivateFields.push([id, privateClears]);
    const privateValue = shipPrivate(entry);
    if ((focusedRefresh || old.privateSignature !== record.privateSignature) && Object.keys(privateValue).length) privatePatch.push([id, privateValue]);
    const statePresent = new Set(oldStateFields);
    for (const field of record.stateKeys) statePresent.add(field);
    for (const field of stateClears) statePresent.delete(field);
    record.statePresentFields = [...statePresent];
    const privatePresent = new Set(oldPrivateFields);
    for (const field of record.privateKeys) privatePresent.add(field);
    for (const field of privateClears) privatePresent.delete(field);
    record.privatePresentFields = [...privatePresent];
    next.set(id, record);
  }

  return {
    patch: {
      motion,
      state,
      private: privatePatch,
      upsert,
      remove: entityIdsForRemoval(previous, current),
      clearPrivate: sortedIds(clearPrivate),
      clearStateFields,
      clearPrivateFields
    },
    next
  };
}

function buildGenericPatch(entries, previous, kind, options = {}) {
  const current = mapEntries(entries);
  const upsert = [];
  const motion = [];
  const state = [];
  const remaining = [];
  const clearStateFields = [];
  const next = new Map();
  const baselineIds = options.baselineIds instanceof Set ? options.baselineIds : new Set();
  for (const id of sortedIds(current.keys())) {
    const entry = current.get(id);
    const old = previous.get(id);
    const record = kind === "effects" ? effectRecord(entry) : genericRecord(entry, kind);
    if (!old || baselineIds.has(id)) {
      upsert.push(entry);
      record.publicFields = record.publicFields || [];
      next.set(id, record);
      continue;
    }
    if (old.motionSignature !== record.motionSignature) motion.push(record.motion);
    const currentState = genericState(entry, kind);
    if (old.stateSignature !== record.stateSignature && Object.keys(currentState).length) state.push([id, currentState]);
    const oldPublicFields = new Set(old.publicFields || [...(old.stateKeys || []), ...(old.remainingKeys || [])]);
    const currentPublicFields = new Set(record.publicFields || []);
    const missingFields = [...oldPublicFields].filter((field) => !currentPublicFields.has(field));
    if (missingFields.length) clearStateFields.push([id, missingFields]);
    if (old.remainingSignature !== record.remainingSignature && Object.keys(record.remaining).length) {
      // Unknown public fields are a supplementary sparse operation.  It can
      // safely accompany motion/state changes without reintroducing a full
      // upsert conflict.
      remaining.push([id, record.remaining]);
    }
    record.publicFields = [...currentPublicFields];
    next.set(id, record);
  }
  const patch = {
    motion,
    state,
    remaining,
    upsert,
    remove: entityIdsForRemoval(previous, current),
    clearStateFields
  };
  return { patch, next };
}

function buildStationPatch(entries, previous, options = {}) {
  const current = mapEntries(entries);
  const upsert = [];
  const dynamic = [];
  const next = new Map();
  const baselineIds = options.baselineIds instanceof Set ? options.baselineIds : new Set();
  for (const id of sortedIds(current.keys())) {
    const entry = current.get(id);
    const old = previous.get(id);
    const record = stationRecord(entry);
    next.set(id, record);
    if (!old || baselineIds.has(id)) upsert.push(entry);
    else if (old.entrySignature !== record.entrySignature) dynamic.push(entry);
  }
  return { patch: { upsert, dynamic, state: [], clearStateFields: [], remove: entityIdsForRemoval(previous, current) }, next };
}

function buildSimplePatch(entries, previous, kind, options = {}) {
  const current = mapEntries(entries);
  const upsert = [];
  const state = [];
  const clearStateFields = [];
  const next = new Map();
  const baselineIds = options.baselineIds instanceof Set ? options.baselineIds : new Set();
  for (const id of sortedIds(current.keys())) {
    const entry = current.get(id);
    const old = previous.get(id);
    const stateKind = kind === "players" ? "players" : "points";
    const stateValue = genericState(entry, stateKind);
    const stateKeys = Object.keys(stateValue);
    const record = { entrySignature: signature(stateValue), stateKeys };
    if (!old || baselineIds.has(id)) {
      upsert.push(entry);
      next.set(id, record);
      continue;
    }
    if (old.entrySignature !== record.entrySignature) {
      if (Object.keys(stateValue).length) state.push([id, stateValue]);
      const oldKeys = new Set(old.stateKeys || []);
      const missing = [...oldKeys].filter((field) => !stateKeys.includes(field));
      if (missing.length) clearStateFields.push([id, missing]);
    }
    next.set(id, record);
  }
  return { patch: { upsert, state, clearStateFields, remove: entityIdsForRemoval(previous, current) }, next };
}

function buildStateFromSnapshot(snapshot, stateEpoch) {
  const next = createSnapshotEntityState(stateEpoch);
  for (const entry of snapshot?.ships || []) next.ships.set(idOf(entry), makeShipRecord(entry));
  for (const entry of snapshot?.drones || []) next.drones.set(idOf(entry), genericRecord(entry, "drones"));
  for (const entry of snapshot?.decoys || []) next.decoys.set(idOf(entry), genericRecord(entry, "decoys"));
  for (const entry of snapshot?.stations || []) next.stations.set(idOf(entry), stationRecord(entry));
  // Player design/stats are static baseline fields; compact player changes are
  // compared against the same sparse public state used after the baseline.
  for (const entry of snapshot?.players || []) {
    const state = genericState(entry, "players");
    next.players.set(idOf(entry), { entrySignature: signature(state), stateKeys: Object.keys(state) });
  }
  for (const entry of snapshot?.points || []) {
    const state = genericState(entry, "points");
    next.points.set(idOf(entry), { entrySignature: signature(state), stateKeys: Object.keys(state) });
  }
  for (const entry of snapshot?.effects || []) next.effects.set(idOf(entry), effectRecord(entry));
  return next;
}

function roomPatch(snapshot) {
  const patch = {};
  for (const key of ["phase", "adminId", "winner", "matchStartedAt", "controlVictory", "objectiveControl"]) {
    if (hasOwn(snapshot, key)) patch[key] = snapshot[key];
  }
  return patch;
}

function copyProjectileFields(snapshot, target) {
  for (const key of [
    "projectileEvents", "projectileEventBaseSeq", "projectileEventSeq", "projectileCorrectionBaseSeq",
    "projectileCorrectionSeq", "projectileStateEpoch", "projectileSimulationTimeMs", "projectileBaseline"
  ]) if (hasOwn(snapshot, key)) target[key] = snapshot[key];
}

function patchStats(patches, currentCounts) {
  let patched = 0;
  let removals = 0;
  for (const section of Object.values(patches)) {
    for (const key of ["upsert", "dynamic", "motion", "state", "private", "remaining", "clearPrivate", "clearStateFields", "clearPrivateFields"]) patched += Array.isArray(section?.[key]) ? section[key].length : 0;
    removals += Array.isArray(section?.remove) ? section.remove.length : 0;
  }
  const considered = Object.values(currentCounts).reduce((sum, value) => sum + value, 0);
  return { entitiesConsidered: considered, entitiesPatched: patched, entitiesUnchanged: Math.max(0, considered - patched), visibilityRemovals: removals };
}

function buildEntityDeltaSnapshot(snapshot, previousState, options = {}) {
  const previous = previousState?.stateEpoch === snapshot.stateEpoch
    ? previousState
    : createSnapshotEntityState(snapshot.stateEpoch);
  const ships = buildShipPatch(snapshot.ships, previous.ships, {
    baselineIds: options.baselineShipIds,
    telemetryFocusShipId: options.telemetryFocusShipId
  });
  const drones = buildGenericPatch(snapshot.drones, previous.drones, "drones", { baselineIds: options.baselineDroneIds });
  const decoys = buildGenericPatch(snapshot.decoys, previous.decoys, "decoys", { baselineIds: options.baselineDecoyIds });
  const stations = buildStationPatch(snapshot.stations, previous.stations, { baselineIds: options.baselineStationIds });
  const players = buildSimplePatch(snapshot.players, previous.players, "players", { baselineIds: options.baselinePlayerIds });
  const points = buildSimplePatch(snapshot.points, previous.points, "points", { baselineIds: options.baselinePointIds });
  const effects = buildGenericPatch(snapshot.effects, previous.effects, "effects", { baselineIds: options.baselineEffectIds });
  const patches = {
    playersPatch: players.patch,
    shipsPatch: ships.patch,
    dronesPatch: drones.patch,
    decoysPatch: decoys.patch,
    stationsPatch: stations.patch,
    pointsPatch: points.patch,
    effectsPatch: effects.patch
  };
  const next = {
    type: "state",
    room: snapshot.room,
    protocolVersion: snapshot.protocolVersion,
    serverBuildSha: snapshot.serverBuildSha,
    balanceRevision: snapshot.balanceRevision,
    stateEpoch: snapshot.stateEpoch,
    snapshotSeq: snapshot.snapshotSeq,
    snapshotKind: "compact",
    snapshotFormatVersion: ENTITY_DELTA_FORMAT_VERSION,
    baseSnapshotSeq: snapshot.baseSnapshotSeq,
    staticRevision: snapshot.staticRevision,
    staticRevisions: snapshot.staticRevisions,
    simulationTimeMs: snapshot.simulationTimeMs,
    serverTimeMs: snapshot.serverTimeMs,
    createdAtMs: snapshot.createdAtMs,
    time: snapshot.time,
    roomPatch: roomPatch(snapshot),
    playersPatch: patches.playersPatch,
    shipsPatch: patches.shipsPatch,
    dronesPatch: patches.dronesPatch,
    decoysPatch: patches.decoysPatch,
    stationsPatch: patches.stationsPatch,
    pointsPatch: patches.pointsPatch,
    effectsPatch: patches.effectsPatch,
    // Remembered contacts are already permission-filtered and are a complete
    // current set, so carrying this small list preserves hide/reacquire rules.
    contacts: Array.isArray(snapshot.contacts) ? snapshot.contacts : []
  };
  copyProjectileFields(snapshot, next);
  if (snapshot.projectileEvents === undefined && snapshot.bullets !== undefined) next.bullets = snapshot.bullets;
  const nextState = createSnapshotEntityState(snapshot.stateEpoch);
  nextState.ships = ships.next;
  nextState.drones = drones.next;
  nextState.decoys = decoys.next;
  nextState.stations = stations.next;
  nextState.players = players.next;
  nextState.points = points.next;
  nextState.effects = effects.next;
  const stats = patchStats(patches, {
    ships: (snapshot.ships || []).length,
    drones: (snapshot.drones || []).length,
    decoys: (snapshot.decoys || []).length,
    stations: (snapshot.stations || []).length,
    players: (snapshot.players || []).length,
    points: (snapshot.points || []).length,
    effects: (snapshot.effects || []).length
  });
  return { snapshot: next, nextState, stats };
}

module.exports = {
  ENTITY_DELTA_FORMAT_VERSION,
  SHIP_STATE_FIELDS,
  PRIVATE_SHIP_FIELDS,
  GENERIC_MOTION_FIELDS,
  createSnapshotEntityState,
  buildStateFromSnapshot,
  buildEntityDeltaSnapshot,
  signature,
  shipState,
  shipPrivate,
  genericState,
  genericMotion
};
