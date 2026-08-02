import "./shared/snapshotEntityDelta.js";
import { COMPONENT_HEAT_DELTA_STRIDE, componentHeatTupleFromDelta, normalizeComponentHeatTuple } from "./shared/componentHeatSnapshot.js";
import { applySnapshotToProjectiles, getProjectilesForRender } from "./shared/projectileStore.js";

const ENTITY_DELTA = globalThis.MfaSnapshotEntityDelta || {};
const SHIP_MOTION_STRIDE = ENTITY_DELTA.SHIP_MOTION_STRIDE || 9;
const GENERIC_MOTION_FIELDS = ENTITY_DELTA.GENERIC_MOTION_FIELDS || {
  drones: ["x", "y", "vx", "vy", "angle", "stateProgress", "fuelRemainingSeconds"],
  decoys: ["x", "y", "vx", "vy", "remainingSeconds"],
  effects: ["age"]
};
const SHIP_CLEARABLE_STATE_FIELDS = ENTITY_DELTA.SHIP_CLEARABLE_STATE_FIELDS || [
  "destructProgress", "droneBays", "decoyLaunchers", "engBlocked"
];
const GENERIC_STATE_FIELDS = ENTITY_DELTA.GENERIC_STATE_FIELDS || {
  drones: ["ownerId", "parentShipId", "bayComponentId", "type", "state", "radius", "hull", "maxHull", "targetId", "fuelCapacitySeconds"],
  decoys: ["ownerId", "parentShipId", "radius"],
  effects: ["type", "subtype", "ownerId", "x", "y", "x2", "y2", "nx", "ny", "radius", "text", "reason"],
  players: [
    "name", "color", "colour", "team", "teamName", "isBot", "isAdmin", "connected", "ready", "money", "income",
    "earned", "spent", "shipCap", "activeFleetCost", "deployedFleetCost", "destroyedEnemyCost", "lastReward",
    "activeShips", "kills", "losses", "captures", "rallyPoint", "rallyPointCustom", "shipsBuilt", "lostFleetCost"
  ],
  points: ["x", "y", "radius", "ownerId", "ownerTeam", "contested", "progress", "stationId"]
};
const GENERIC_REMAINING_FIELDS = ENTITY_DELTA.GENERIC_REMAINING_FIELDS || {
  drones: [], decoys: [], effects: ["at", "charge", "amount", "isShield"], players: [], points: []
};
const STATION_STATE_FIELDS = ENTITY_DELTA.STATION_STATE_FIELDS || [
  "hp", "shield", "team", "ownerId", "state", "sensorRange", "weaponRange", "revision", "healthRevision",
  "componentDamageRevision", "stateRevision", "productionRevision", "captureRevision", "captureProgress", "captureContested", "captureTeam",
  "weaponAngles", "weaponAnglePairs", "conditionKnown", "productionQueue", "launches"
];
const EMPTY_FIELD_SET = new Set();
const CLEAR_STATE_FIELDS_BY_SECTION = Object.freeze({
  ships: new Set(SHIP_CLEARABLE_STATE_FIELDS),
  drones: new Set([...(GENERIC_STATE_FIELDS.drones || []), ...(GENERIC_REMAINING_FIELDS.drones || [])]),
  decoys: new Set([...(GENERIC_STATE_FIELDS.decoys || []), ...(GENERIC_REMAINING_FIELDS.decoys || [])]),
  effects: new Set([...(GENERIC_STATE_FIELDS.effects || []), ...(GENERIC_REMAINING_FIELDS.effects || [])]),
  players: new Set([...(GENERIC_STATE_FIELDS.players || []), ...(GENERIC_REMAINING_FIELDS.players || [])]),
  points: new Set([...(GENERIC_STATE_FIELDS.points || []), ...(GENERIC_REMAINING_FIELDS.points || [])]),
  stations: new Set(STATION_STATE_FIELDS)
});

export const SNAPSHOT_REJECTION = Object.freeze({
  STALE_EPOCH: "stale-epoch",
  STALE_SEQUENCE: "stale-sequence",
  DUPLICATE_SEQUENCE: "duplicate-sequence",
  MISSING_BASELINE: "missing-baseline",
  SEQUENCE_GAP: "sequence-gap",
  PROJECTILE_SEQUENCE_GAP: "projectile-sequence-gap",
  WRONG_BASE: "wrong-base",
  STATIC_REVISION_MISMATCH: "static-revision-mismatch",
  MALFORMED_DELTA: "malformed-delta",
  UNKNOWN_ENTITY_REFERENCE: "unknown-entity-reference",
  INVALID_PATCH_STRIDE: "invalid-patch-stride",
  DUPLICATE_PATCH_ENTRY: "duplicate-patch-entry",
  PATCH_FOR_REMOVED_ENTITY: "patch-for-removed-entity",
  PATCH_OPERATION_CONFLICT: "patch-operation-conflict",
  INVALID_CLEAR_FIELD: "invalid-clear-field",
  INVALID_DETAIL_TRANSITION: "invalid-detail-transition",
  INCOMPATIBLE_SNAPSHOT: "incompatible-snapshot"
});

function isNullish(value) { return value === undefined || value === null; }

// Private per-ship fields that may only ever reach an owner/ally viewer. When a
// ship arrives marked `detail: "public"` (an enemy ship), these are stripped and
// never inherited from an earlier cached snapshot, so redacted enemy data can
// never survive a full->compact merge or a visibility change.
const PRIVATE_SHIP_FIELDS = Object.freeze(ENTITY_DELTA.PRIVATE_SHIP_FIELDS || [
  "componentPower", "powerStatus", "powerThermal", "powerRevision", "wiringRevision",
  "powerRuntimeRevision", "wiringStatus", "switchgear", "powerProtection", "powerProtectionRevision",
  "powerWiring", "powerWiringRevision", "powerWiringRuntime", "chp", "chpD", "componentHeat",
  "componentHeatD", "storageCharge", "componentHeatRevision", "heatTelemetryRevision"
]);

export function mergeStaticPlayerFields(previousPlayers, nextPlayers) {
  if (!Array.isArray(previousPlayers) || !Array.isArray(nextPlayers)) return nextPlayers;
  const oldPlayers = new Map(previousPlayers.map((p) => [p.id, p]));
  return nextPlayers.map((player) => {
    const oldPlayer = oldPlayers.get(player.id);
    if (!oldPlayer) return player;
    const merged = { ...oldPlayer, ...player };
    for (const key of ["design", "stats", "name", "team", "colour", "color"]) {
      if (isNullish(merged[key])) merged[key] = oldPlayer[key];
    }
    return merged;
  });
}

export function validateComponentHpDelta(previousHp, delta) {
  if (!Array.isArray(previousHp)) return { ok: false, reason: SNAPSHOT_REJECTION.MISSING_BASELINE };
  if (!Array.isArray(delta) || delta.length === 0) return { ok: true };
  if (delta.length % 2 !== 0) return { ok: false, reason: SNAPSHOT_REJECTION.MALFORMED_DELTA };
  let last = -1;
  const seen = new Set();
  for (let k = 0; k < delta.length; k += 2) {
    const index = Number(delta[k]);
    const hp = Number(delta[k + 1]);
    if (!Number.isInteger(index) || index < 0 || index >= previousHp.length || !Number.isFinite(hp)) return { ok: false, reason: SNAPSHOT_REJECTION.MALFORMED_DELTA };
    if (seen.has(index) || index <= last) return { ok: false, reason: SNAPSHOT_REJECTION.MALFORMED_DELTA };
    seen.add(index); last = index;
  }
  return { ok: true };
}

export function applyComponentHpDelta(previousHp, delta) {
  const valid = validateComponentHpDelta(previousHp, delta);
  if (!valid.ok) return undefined;
  if (!Array.isArray(delta) || delta.length === 0) return previousHp;
  const merged = previousHp.slice();
  for (let k = 0; k < delta.length; k += 2) merged[Number(delta[k])] = Number(delta[k + 1]);
  return merged;
}

export function normalizeComponentHeatSnapshot(componentHeat) {
  if (!Array.isArray(componentHeat)) return componentHeat;
  return componentHeat.map((entry) => normalizeComponentHeatTuple(entry) || [0, 0, 0, 0]);
}

export function validateComponentHeatDelta(previousHeat, delta) {
  if (!Array.isArray(previousHeat)) return { ok: false, reason: SNAPSHOT_REJECTION.MISSING_BASELINE };
  if (!Array.isArray(delta) || delta.length === 0) return { ok: true };
  if (delta.length % COMPONENT_HEAT_DELTA_STRIDE !== 0) return { ok: false, reason: SNAPSHOT_REJECTION.MALFORMED_DELTA };
  let last = -1;
  const seen = new Set();
  for (let k = 0; k < delta.length; k += COMPONENT_HEAT_DELTA_STRIDE) {
    const update = componentHeatTupleFromDelta(delta, k);
    if (!update || update.index >= previousHeat.length) return { ok: false, reason: SNAPSHOT_REJECTION.MALFORMED_DELTA };
    if (seen.has(update.index) || update.index <= last) return { ok: false, reason: SNAPSHOT_REJECTION.MALFORMED_DELTA };
    seen.add(update.index); last = update.index;
  }
  return { ok: true };
}

export function applyComponentHeatDelta(previousHeat, delta) {
  const valid = validateComponentHeatDelta(previousHeat, delta);
  if (!valid.ok) return undefined;
  if (!Array.isArray(delta) || delta.length === 0) return previousHeat;
  const merged = previousHeat.map((value) => Array.isArray(value) ? value.slice() : value);
  for (let k = 0; k < delta.length; k += COMPONENT_HEAT_DELTA_STRIDE) {
    const update = componentHeatTupleFromDelta(delta, k);
    merged[update.index] = update.tuple;
  }
  return merged;
}

export function mergeCachedShipFields(previousShips, nextShips) {
  if (!Array.isArray(previousShips) || !Array.isArray(nextShips)) return nextShips;
  const oldShips = new Map(previousShips.map((ship) => [ship.id, ship]));
  return nextShips.map((ship) => {
    const oldShip = oldShips.get(ship.id);
    if (ship.detail === "public") {
      // Enemy ship: only the public visual design may carry forward. Any private
      // runtime detail cached while the ship was visible is discarded here so it
      // can never leak after redaction.
      const merged = { ...ship };
      if (isNullish(merged.design)) merged.design = oldShip?.design;
      if (isNullish(merged.chpVisual)) merged.chpVisual = oldShip?.chpVisual;
      for (const key of PRIVATE_SHIP_FIELDS) delete merged[key];
      return merged;
    }
    if (!oldShip) return { ...ship, componentHeat: normalizeComponentHeatSnapshot(ship.componentHeat) };
    const merged = { ...ship };
    if (isNullish(merged.design)) merged.design = oldShip.design;
    // Carried fields are shared by reference: snapshots are treated as
    // immutable once merged, so cloning here would only produce GC churn.
    for (const key of ["componentPower", "powerStatus", "powerThermal", "powerRevision", "powerRuntimeRevision", "wiringRevision", "wiringStatus", "switchgear", "powerProtection", "powerProtectionRevision", "powerWiring", "powerWiringRevision", "powerWiringRuntime", "storageCharge", "chpVisual", "componentHeatRevision", "heatTelemetryRevision"]) {
      if (isNullish(merged[key])) merged[key] = oldShip[key];
    }
    if (isNullish(merged.chp)) {
      const hp = applyComponentHpDelta(oldShip.chp, merged.chpD);
      if (hp !== undefined) merged.chp = hp;
    }
    if (!isNullish(merged.componentHeat)) merged.componentHeat = normalizeComponentHeatSnapshot(merged.componentHeat);
    else {
      const heat = applyComponentHeatDelta(oldShip.componentHeat, merged.componentHeatD);
      if (heat !== undefined) merged.componentHeat = heat;
    }
    return merged;
  });
}

export function validateStationWeaponAnglePairs(previousAngles, pairs) {
  if (!Array.isArray(previousAngles)) return { ok: false, reason: SNAPSHOT_REJECTION.MISSING_BASELINE };
  if (!Array.isArray(pairs) || pairs.length === 0) return { ok: true };
  if (pairs.length % 2 !== 0) return { ok: false, reason: SNAPSHOT_REJECTION.MALFORMED_DELTA };
  let last = -1;
  for (let offset = 0; offset < pairs.length; offset += 2) {
    const index = Number(pairs[offset]);
    const angle = Number(pairs[offset + 1]);
    if (!Number.isInteger(index) || index < 0 || index >= previousAngles.length || index <= last || !Number.isFinite(angle)) {
      return { ok: false, reason: SNAPSHOT_REJECTION.MALFORMED_DELTA };
    }
    last = index;
  }
  return { ok: true };
}

export function applyStationWeaponAnglePairs(previousAngles, pairs) {
  const valid = validateStationWeaponAnglePairs(previousAngles, pairs);
  if (!valid.ok) return undefined;
  if (!Array.isArray(pairs) || pairs.length === 0) return previousAngles;
  const merged = previousAngles.slice();
  for (let offset = 0; offset < pairs.length; offset += 2) {
    merged[Number(pairs[offset])] = Number(pairs[offset + 1]);
  }
  return merged;
}

// Station geometry is immutable and only travels with a baseline. Compact
// snapshots inherit it, apply sparse turret bearings, and carry component HP
// only when the authoritative component-damage revision changes. Unknown enemy
// condition explicitly clears component HP so cached detail cannot leak.
export function mergeCachedStationFields(previousStations, nextStations) {
  if (!Array.isArray(nextStations)) return nextStations;
  if (!Array.isArray(previousStations)) return nextStations;
  const oldStations = new Map(previousStations.map((station) => [station.id, station]));
  return nextStations.map((station) => {
    const old = oldStations.get(station.id);
    if (!old) return station;
    const merged = { ...station };
    for (const key of [
      "stationType", "x", "y", "angle", "radius", "shieldRadius",
      "design", "hangar", "hardpoints", "moduleScale"
    ]) {
      if (isNullish(merged[key])) merged[key] = old[key];
    }
    if (isNullish(merged.weaponAngles)) {
      merged.weaponAngles = applyStationWeaponAnglePairs(old.weaponAngles, merged.weaponAnglePairs);
      if (isNullish(merged.weaponAngles)) merged.weaponAngles = old.weaponAngles;
    }
    delete merged.weaponAnglePairs;
    if (merged.conditionKnown === false) {
      for (const key of ["hp", "maxHp", "shield", "maxShield", "componentHp"]) delete merged[key];
    } else {
      for (const key of ["maxHp", "maxShield", "componentHp"]) {
        if (isNullish(merged[key])) merged[key] = old[key];
      }
    }
    return merged;
  });
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function finiteTree(value, depth = 0) {
  if (depth > 10) return false;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (Array.isArray(value)) return value.every((entry) => finiteTree(entry, depth + 1));
  if (isPlainObject(value)) return Object.values(value).every((entry) => finiteTree(entry, depth + 1));
  return true;
}

function validEntityId(id) {
  return (typeof id === "string" || typeof id === "number") && String(id).length > 0 && String(id).length <= 128;
}

function patchError(reason, message) {
  return { ok: false, reason, message };
}

function validatePatchSection(patch, previousEntries, spec) {
  if (!isPlainObject(patch)) return patchError(SNAPSHOT_REJECTION.MALFORMED_DELTA, `${spec.name} patch is not an object`);
  if (!finiteTree(patch)) return patchError(SNAPSHOT_REJECTION.MALFORMED_DELTA, `${spec.name} patch contains a non-finite value`);
  for (const key of ["upsert", "remove", "motion", "state", "private", "remaining", "dynamic", "clearPrivate", "clearStateFields", "clearPrivateFields"]) {
    if (patch[key] !== undefined && !Array.isArray(patch[key])) return patchError(SNAPSHOT_REJECTION.MALFORMED_DELTA, `${spec.name}.${key} is not an array`);
  }
  const previousIds = new Set((previousEntries || []).map((entry) => entry?.id));
  const upsertRows = Array.isArray(patch.upsert) ? patch.upsert : [];
  const upsertIds = new Set();
  for (const entry of upsertRows) {
    if (!isPlainObject(entry) || !validEntityId(entry.id) || upsertIds.has(entry.id)) return patchError(SNAPSHOT_REJECTION.DUPLICATE_PATCH_ENTRY, `${spec.name} contains a duplicate or invalid upsert`);
    if (spec.name === "ships" && entry.detail === "public" && PRIVATE_SHIP_FIELDS.some((field) => entry[field] !== undefined && entry[field] !== null)) return patchError(SNAPSHOT_REJECTION.INVALID_DETAIL_TRANSITION, "public ship baseline contains private fields");
    upsertIds.add(entry.id);
  }
  const remove = Array.isArray(patch.remove) ? patch.remove : [];
  const removedIds = new Set();
  for (const id of remove) {
    if (!validEntityId(id) || removedIds.has(id)) return patchError(SNAPSHOT_REJECTION.DUPLICATE_PATCH_ENTRY, `${spec.name} contains a duplicate removal`);
    removedIds.add(id);
  }
  const allowedIds = new Set([...previousIds, ...upsertIds]);
  const checkId = (id, operation) => {
    if (!validEntityId(id)) return patchError(SNAPSHOT_REJECTION.MALFORMED_DELTA, `${spec.name} has an invalid entity id`);
    if (removedIds.has(id)) return patchError(SNAPSHOT_REJECTION.PATCH_FOR_REMOVED_ENTITY, `${operation} targets a removed entity`);
    if (!allowedIds.has(id)) return patchError(SNAPSHOT_REJECTION.UNKNOWN_ENTITY_REFERENCE, `${operation} targets an unknown entity`);
    return null;
  };
  const checkRows = (rows, operation, stride = null) => {
    if (rows === undefined) return null;
    if (!Array.isArray(rows)) return patchError(SNAPSHOT_REJECTION.MALFORMED_DELTA, `${spec.name}.${operation} is not an array`);
    const seen = new Set();
    for (const row of rows) {
      if (!Array.isArray(row) || (stride !== null && row.length !== stride)) return patchError(stride === null ? SNAPSHOT_REJECTION.MALFORMED_DELTA : SNAPSHOT_REJECTION.INVALID_PATCH_STRIDE, `${spec.name}.${operation} has an invalid row`);
      const id = row[0];
      if (seen.has(id)) return patchError(SNAPSHOT_REJECTION.DUPLICATE_PATCH_ENTRY, `${spec.name}.${operation} repeats an entity`);
      seen.add(id);
      const error = checkId(id, operation);
      if (error) return error;
      if (operation === "state" || operation === "private") {
        if (row.length !== 2 || !isPlainObject(row[1])) return patchError(SNAPSHOT_REJECTION.MALFORMED_DELTA, `${spec.name}.${operation} has an invalid tuple`);
      }
    }
    return null;
  };
  const upsertError = checkRows(upsertRows.map((entry) => [entry.id, entry]), "upsert");
  if (upsertError) return upsertError;
  const stateError = checkRows(patch.state, "state", 2);
  if (stateError) return stateError;
  const privateError = checkRows(patch.private, "private", 2);
  if (privateError) return privateError;
  const motionError = checkRows(patch.motion, "motion", spec.motionStride);
  if (motionError) return motionError;
  if (patch.dynamic !== undefined) {
    const dynamicError = checkRows(Array.isArray(patch.dynamic) ? patch.dynamic.map((entry) => [entry?.id, entry]) : patch.dynamic, "dynamic");
    if (dynamicError) return dynamicError;
  }
  if (patch.clearPrivate !== undefined) {
    if (!Array.isArray(patch.clearPrivate)) return patchError(SNAPSHOT_REJECTION.MALFORMED_DELTA, `${spec.name}.clearPrivate is not an array`);
    const seen = new Set();
    for (const id of patch.clearPrivate) {
      if (seen.has(id)) return patchError(SNAPSHOT_REJECTION.DUPLICATE_PATCH_ENTRY, `${spec.name}.clearPrivate repeats an entity`);
      seen.add(id);
      const error = checkId(id, "clearPrivate");
      if (error) return error;
    }
  }
  const checkFieldClearRows = (rows, operation, allowedFields = EMPTY_FIELD_SET) => {
    if (rows === undefined) return null;
    if (!Array.isArray(rows)) return patchError(SNAPSHOT_REJECTION.MALFORMED_DELTA, `${spec.name}.${operation} is not an array`);
    const seen = new Set();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 2 || !Array.isArray(row[1])) return patchError(SNAPSHOT_REJECTION.MALFORMED_DELTA, `${spec.name}.${operation} has an invalid tuple`);
      const [id, fields] = row;
      if (seen.has(id)) return patchError(SNAPSHOT_REJECTION.DUPLICATE_PATCH_ENTRY, `${spec.name}.${operation} repeats an entity`);
      seen.add(id);
      const error = checkId(id, operation);
      if (error) return error;
      const fieldSet = new Set();
      for (const field of fields) {
        if (typeof field !== "string" || !field || fieldSet.has(field)) return patchError(SNAPSHOT_REJECTION.MALFORMED_DELTA, `${spec.name}.${operation} has invalid fields`);
        if (!allowedFields.has(field)) return patchError(SNAPSHOT_REJECTION.INVALID_CLEAR_FIELD, `${spec.name}.${operation} cannot clear ${field}`);
        fieldSet.add(field);
      }
    }
    return null;
  };
  const remainingError = checkRows(patch.remaining, "remaining", 2);
  if (remainingError) return remainingError;
  if (patch.remaining !== undefined) {
    for (const row of patch.remaining) if (!isPlainObject(row[1])) return patchError(SNAPSHOT_REJECTION.MALFORMED_DELTA, `${spec.name}.remaining has an invalid tuple`);
  }
  const clearStateError = checkFieldClearRows(
    patch.clearStateFields,
    "clearStateFields",
    spec.clearStateFields || EMPTY_FIELD_SET
  );
  if (clearStateError) return clearStateError;
  const clearPrivateFieldsError = checkFieldClearRows(
    patch.clearPrivateFields,
    "clearPrivateFields",
    spec.clearPrivateFields || EMPTY_FIELD_SET
  );
  if (clearPrivateFieldsError) return clearPrivateFieldsError;

  const idsFor = (rows) => new Set((rows || []).map((row) => Array.isArray(row) ? row[0] : row?.id ?? row));
  const operationIds = {
    upsert: new Set(upsertRows.map((entry) => entry.id)),
    remove: new Set(remove),
    motion: idsFor(patch.motion),
    state: idsFor(patch.state),
    private: idsFor(patch.private),
    remaining: idsFor(patch.remaining),
    dynamic: idsFor(patch.dynamic),
    clearStateFields: idsFor(patch.clearStateFields),
    clearPrivateFields: idsFor(patch.clearPrivateFields),
    clearPrivate: new Set(patch.clearPrivate || [])
  };
  const intersects = (left, right) => [...left].some((id) => right.has(id));
  const conflict = (message) => patchError(SNAPSHOT_REJECTION.PATCH_OPERATION_CONFLICT, `${spec.name} ${message}`);
  if (spec.name !== "ships" && operationIds.clearPrivate.size) return conflict("clearPrivate is only valid for ships");

  const fieldsById = (rows) => new Map((rows || []).map((row) => [row[0], new Set(Object.keys(row[1] || {}))]));
  const clearFieldsById = (rows) => new Map((rows || []).map(([id, fields]) => [id, new Set(fields)]));
  const rejectFieldOverlap = (setRows, clearRows, setOperation, clearOperation) => {
    const clearById = clearFieldsById(clearRows);
    for (const [id, fields] of fieldsById(setRows)) {
      const cleared = clearById.get(id);
      if (!cleared) continue;
      for (const field of fields) {
        if (cleared.has(field)) return conflict(`${setOperation} overlaps ${clearOperation} for ${String(id)}.${field}`);
      }
    }
    return null;
  };
  const stateClearOverlap = rejectFieldOverlap(patch.state, patch.clearStateFields, "state", "clearStateFields");
  if (stateClearOverlap) return stateClearOverlap;
  const remainingClearOverlap = rejectFieldOverlap(patch.remaining, patch.clearStateFields, "remaining", "clearStateFields");
  if (remainingClearOverlap) return remainingClearOverlap;
  const privateClearOverlap = rejectFieldOverlap(patch.private, patch.clearPrivateFields, "private", "clearPrivateFields");
  if (privateClearOverlap) return privateClearOverlap;

  const exclusiveOperations = ["motion", "state", "private", "remaining", "dynamic", "clearStateFields", "clearPrivateFields", "clearPrivate"];
  for (const id of operationIds.remove) {
    if (exclusiveOperations.some((operation) => operationIds[operation].has(id)) || operationIds.upsert.has(id)) return conflict(`remove conflicts for ${String(id)}`);
  }
  for (const id of operationIds.upsert) {
    const publicUpsert = upsertRows.find((entry) => entry.id === id)?.detail === "public";
    for (const operation of ["motion", "state", "private", "remaining", "dynamic", "clearStateFields", "clearPrivateFields"]) {
      if (operationIds[operation].has(id)) return conflict(`upsert conflicts with ${operation} for ${String(id)}`);
    }
    if (operationIds.clearPrivate.has(id) && !publicUpsert) return conflict(`clearPrivate requires a public upsert for ${String(id)}`);
  }
  if (intersects(operationIds.dynamic, operationIds.motion)
    || intersects(operationIds.dynamic, operationIds.state)
    || intersects(operationIds.dynamic, operationIds.private)
    || intersects(operationIds.dynamic, operationIds.remaining)
    || intersects(operationIds.dynamic, operationIds.clearStateFields)
    || intersects(operationIds.dynamic, operationIds.clearPrivateFields)) {
    return conflict("dynamic cannot be combined with another field operation");
  }
  for (const id of operationIds.private) {
    const upsert = upsertRows.find((entry) => entry.id === id);
    const old = (previousEntries || []).find((entry) => entry?.id === id);
    if (spec.name === "ships" && (upsert?.detail === "public" || (!upsert && old?.detail === "public"))) {
      return patchError(SNAPSHOT_REJECTION.INVALID_DETAIL_TRANSITION, "private patch targets a public ship");
    }
  }
  return { ok: true, previousIds, upsertIds, removedIds };
}

function validateEntityDeltaPatches(previous, message) {
  if (Number(message?.snapshotFormatVersion) !== 2) return patchError(SNAPSHOT_REJECTION.INCOMPATIBLE_SNAPSHOT, "unsupported entity-delta format");
  if (!isPlainObject(message.roomPatch)) return patchError(SNAPSHOT_REJECTION.MALFORMED_DELTA, "roomPatch is not an object");
  if (!finiteTree(message.roomPatch)) return patchError(SNAPSHOT_REJECTION.MALFORMED_DELTA, "roomPatch contains a non-finite value");
  const sections = [
    ["playersPatch", previous?.players, { name: "players", motionStride: null, clearStateFields: CLEAR_STATE_FIELDS_BY_SECTION.players, clearPrivateFields: EMPTY_FIELD_SET }],
    ["shipsPatch", previous?.ships, { name: "ships", motionStride: SHIP_MOTION_STRIDE, clearStateFields: CLEAR_STATE_FIELDS_BY_SECTION.ships, clearPrivateFields: new Set(PRIVATE_SHIP_FIELDS) }],
    ["dronesPatch", previous?.drones, { name: "drones", motionStride: 1 + GENERIC_MOTION_FIELDS.drones.length, clearStateFields: CLEAR_STATE_FIELDS_BY_SECTION.drones, clearPrivateFields: EMPTY_FIELD_SET }],
    ["decoysPatch", previous?.decoys, { name: "decoys", motionStride: 1 + GENERIC_MOTION_FIELDS.decoys.length, clearStateFields: CLEAR_STATE_FIELDS_BY_SECTION.decoys, clearPrivateFields: EMPTY_FIELD_SET }],
    ["stationsPatch", previous?.stations, { name: "stations", motionStride: null, clearStateFields: CLEAR_STATE_FIELDS_BY_SECTION.stations, clearPrivateFields: EMPTY_FIELD_SET }],
    ["pointsPatch", previous?.points, { name: "points", motionStride: null, clearStateFields: CLEAR_STATE_FIELDS_BY_SECTION.points, clearPrivateFields: EMPTY_FIELD_SET }],
    ["effectsPatch", previous?.effects, { name: "effects", motionStride: 1 + GENERIC_MOTION_FIELDS.effects.length, clearStateFields: CLEAR_STATE_FIELDS_BY_SECTION.effects, clearPrivateFields: EMPTY_FIELD_SET }]
  ];
  for (const [key, entries, spec] of sections) {
    const patch = message[key];
    if (!isPlainObject(patch)) return patchError(SNAPSHOT_REJECTION.MALFORMED_DELTA, `${key} is not an object`);
    const result = validatePatchSection(patch, entries, spec);
    if (!result.ok) return result;
  }
  if (message.contacts !== undefined && (!Array.isArray(message.contacts) || !finiteTree(message.contacts))) return patchError(SNAPSHOT_REJECTION.MALFORMED_DELTA, "invalid contacts patch");
  for (const key of ["simulationTimeMs", "serverTimeMs", "createdAtMs", "time"]) {
    if (message[key] !== undefined && (!Number.isFinite(Number(message[key])) || Object.is(Number(message[key]), -0))) return patchError(SNAPSHOT_REJECTION.MALFORMED_DELTA, `invalid ${key}`);
  }
  return { ok: true };
}

function applyGenericMotion(entity, row, fields) {
  const next = { ...entity };
  for (let index = 0; index < fields.length; index += 1) next[fields[index]] = row[index + 1];
  return next;
}

function clearPrivateFields(entity) {
  const next = { ...entity };
  for (const key of PRIVATE_SHIP_FIELDS) delete next[key];
  return next;
}

function clearEntityFields(entity, fields) {
  const next = { ...entity };
  for (const field of fields || []) delete next[field];
  return next;
}

function applyShipPrivate(entity, privatePatch) {
  const next = { ...entity, ...privatePatch };
  if (privatePatch.chpD !== undefined && privatePatch.chp === undefined) {
    const hp = applyComponentHpDelta(entity.chp, privatePatch.chpD);
    if (hp !== undefined) next.chp = hp;
  }
  if (privatePatch.componentHeatD !== undefined && privatePatch.componentHeat === undefined) {
    const heat = applyComponentHeatDelta(entity.componentHeat, privatePatch.componentHeatD);
    if (heat !== undefined) next.componentHeat = heat;
  }
  if (next.componentHeat !== undefined) next.componentHeat = normalizeComponentHeatSnapshot(next.componentHeat);
  delete next.chpD;
  delete next.componentHeatD;
  return next;
}

function applyEntityPatch(previousEntries, patch, kind) {
  const map = new Map((previousEntries || []).map((entry) => [entry.id, entry]));
  for (const id of patch.remove || []) map.delete(id);
  for (const id of patch.clearPrivate || []) {
    const old = map.get(id);
    if (old) map.set(id, clearPrivateFields(old));
  }
  for (const entry of patch.upsert || []) {
    const next = { ...entry };
    if (kind === "ships" && next.detail === "public") {
      for (const key of PRIVATE_SHIP_FIELDS) delete next[key];
    }
    if (kind === "ships" && next.componentHeat !== undefined) next.componentHeat = normalizeComponentHeatSnapshot(next.componentHeat);
    map.set(entry.id, next);
  }
  for (const entry of patch.dynamic || []) {
    const old = map.get(entry.id);
    if (!old) continue;
    const merged = kind === "stations"
      ? mergeCachedStationFields([old], [entry])?.[0]
      : { ...old, ...entry };
    map.set(entry.id, merged || old);
  }
  for (const [id, value] of patch.remaining || []) {
    const old = map.get(id);
    if (old) map.set(id, { ...old, ...value });
  }
  for (const [id, fields] of patch.clearStateFields || []) {
    const old = map.get(id);
    if (old) map.set(id, clearEntityFields(old, fields));
  }
  for (const [id, fields] of patch.clearPrivateFields || []) {
    const old = map.get(id);
    if (old) map.set(id, clearEntityFields(old, fields));
  }
  for (const [id, value] of patch.state || []) {
    const old = map.get(id);
    if (old) map.set(id, { ...old, ...value });
  }
  for (const [id, value] of patch.private || []) {
    const old = map.get(id);
    if (old && kind === "ships") map.set(id, applyShipPrivate(old, value));
  }
  for (const row of patch.motion || []) {
    const id = row[0];
    const old = map.get(id);
    if (!old) continue;
    if (kind === "ships") {
      const motion = ENTITY_DELTA.unpackShipMotion ? ENTITY_DELTA.unpackShipMotion(row) : null;
      if (motion) map.set(id, { ...old, x: motion.x, y: motion.y, vx: motion.vx, vy: motion.vy, angle: motion.angle, turnActivity: motion.turnActivity, targetX: motion.targetX, targetY: motion.targetY });
    } else {
      map.set(id, applyGenericMotion(old, row, GENERIC_MOTION_FIELDS[kind] || []));
    }
  }
  return [...map.values()];
}

function applySimplePatch(previousEntries, patch) {
  const map = new Map((previousEntries || []).map((entry) => [entry.id, entry]));
  for (const id of patch.remove || []) map.delete(id);
  for (const entry of patch.upsert || []) map.set(entry.id, { ...(map.get(entry.id) || {}), ...entry });
  for (const [id, fields] of patch.clearStateFields || []) {
    const old = map.get(id);
    if (old) map.set(id, clearEntityFields(old, fields));
  }
  for (const [id, value] of patch.state || []) {
    const old = map.get(id);
    if (old) map.set(id, { ...old, ...value });
  }
  return [...map.values()];
}

export function inspectSnapshotEnvelope(networkState, message) {
  const diagnostic = {
    snapshotSeq: message?.snapshotSeq,
    baseSnapshotSeq: message?.baseSnapshotSeq,
    snapshotKind: message?.snapshotKind,
    shipId: null,
    designMissing: false,
    componentHpBaselineMissing: false,
    componentHeatBaselineMissing: false
  };
  if (!message || message.type !== "state") return { ok: false, reason: SNAPSHOT_REJECTION.INCOMPATIBLE_SNAPSHOT, ...diagnostic };
  const epoch = Number(message.stateEpoch), seq = Number(message.snapshotSeq);
  if (!Number.isInteger(epoch) || epoch < 1 || !Number.isInteger(seq) || seq < 1) return { ok: false, reason: SNAPSHOT_REJECTION.INCOMPATIBLE_SNAPSHOT, ...diagnostic };
  const currentEpoch = Number(networkState?.stateEpoch) || 0;
  const currentSeq = Number(networkState?.snapshotSeq) || 0;
  if (epoch < currentEpoch) return { ok: false, reason: SNAPSHOT_REJECTION.STALE_EPOCH, ...diagnostic };
  if (epoch === currentEpoch && seq < currentSeq) return { ok: false, reason: SNAPSHOT_REJECTION.STALE_SEQUENCE, ...diagnostic };
  if (epoch === currentEpoch && seq === currentSeq) return { ok: false, reason: SNAPSHOT_REJECTION.DUPLICATE_SEQUENCE, ...diagnostic };
  if (message.snapshotKind === "full") return { ok: true, kind: "full" };
  if (message.snapshotKind !== "compact") return { ok: false, reason: SNAPSHOT_REJECTION.INCOMPATIBLE_SNAPSHOT, ...diagnostic };
  if (epoch > currentEpoch || !networkState?.hasFullBaseline) return { ok: false, reason: SNAPSHOT_REJECTION.MISSING_BASELINE, ...diagnostic };
  if (seq !== currentSeq + 1) return { ok: false, reason: SNAPSHOT_REJECTION.SEQUENCE_GAP, ...diagnostic };
  if (Number(message.baseSnapshotSeq) !== currentSeq) return { ok: false, reason: SNAPSHOT_REJECTION.WRONG_BASE, ...diagnostic };
  if (message.staticRevision !== undefined && networkState.staticRevision !== undefined && Number(message.staticRevision) !== Number(networkState.staticRevision)) return { ok: false, reason: SNAPSHOT_REJECTION.STATIC_REVISION_MISMATCH, ...diagnostic };
  const formatVersion = message.snapshotFormatVersion === undefined || message.snapshotFormatVersion === null
    ? 1
    : Number(message.snapshotFormatVersion);
  if (formatVersion === 1) return { ok: true, kind: "compact" };
  if (formatVersion === 2) return { ok: true, kind: "entity-delta" };
  return { ok: false, reason: SNAPSHOT_REJECTION.INCOMPATIBLE_SNAPSHOT, ...diagnostic };
}

function validateShipDeltas(previous, message) {
  const oldShips = new Map((previous?.ships || []).map((ship) => [ship.id, ship]));
  for (const ship of message.ships || []) {
    const old = oldShips.get(ship.id);
    if (!old && (ship.chpD || ship.componentHeatD || isNullish(ship.design))) return { ok: false, reason: SNAPSHOT_REJECTION.MISSING_BASELINE, snapshotSeq: message.snapshotSeq, baseSnapshotSeq: message.baseSnapshotSeq, snapshotKind: message.snapshotKind, shipId: ship.id, designMissing: isNullish(ship.design), componentHpBaselineMissing: Boolean(ship.chpD), componentHeatBaselineMissing: Boolean(ship.componentHeatD) };
    if (ship.chpD) { const r = validateComponentHpDelta(old?.chp, ship.chpD); if (!r.ok) return { ...r, snapshotSeq: message.snapshotSeq, baseSnapshotSeq: message.baseSnapshotSeq, snapshotKind: message.snapshotKind, shipId: ship.id, designMissing: false, componentHpBaselineMissing: !Array.isArray(old?.chp), componentHeatBaselineMissing: false }; }
    if (ship.componentHeatD) { const r = validateComponentHeatDelta(old?.componentHeat, ship.componentHeatD); if (!r.ok) return { ...r, snapshotSeq: message.snapshotSeq, baseSnapshotSeq: message.baseSnapshotSeq, snapshotKind: message.snapshotKind, shipId: ship.id, designMissing: false, componentHpBaselineMissing: false, componentHeatBaselineMissing: !Array.isArray(old?.componentHeat) }; }
  }
  return { ok: true };
}

function validateStationDeltas(previous, message) {
  const oldStations = new Map((previous?.stations || []).map((station) => [station.id, station]));
  for (const station of message.stations || []) {
    const old = oldStations.get(station.id);
    if (!old && isNullish(station.design)) {
      return {
        ok: false,
        reason: SNAPSHOT_REJECTION.MISSING_BASELINE,
        snapshotSeq: message.snapshotSeq,
        baseSnapshotSeq: message.baseSnapshotSeq,
        snapshotKind: message.snapshotKind,
        stationId: station.id,
        stationDesignMissing: true
      };
    }
    if (station.weaponAnglePairs) {
      const result = validateStationWeaponAnglePairs(old?.weaponAngles, station.weaponAnglePairs);
      if (!result.ok) {
        return {
          ...result,
          snapshotSeq: message.snapshotSeq,
          baseSnapshotSeq: message.baseSnapshotSeq,
          snapshotKind: message.snapshotKind,
          stationId: station.id,
          stationDesignMissing: false
        };
      }
    }
  }
  return { ok: true };
}

// Merged snapshots are built from shallow copies of the freshly decoded wire
// message plus reference-shared static data from the previous snapshot. Deep
// cloning here (formerly structuredClone) ran 15x/second over the full map and
// caused GC hitches; merged snapshots are immutable by contract, so sharing is
// safe — merges always produce new ship/player objects for changed entries.
export function mergeFullSnapshot(message, renderNow = null) {
  const full = { ...message };
  full.players = Array.isArray(full.players) ? full.players : [];
  full.ships = Array.isArray(full.ships) ? full.ships.map((s) => ({ ...s, componentHeat: normalizeComponentHeatSnapshot(s.componentHeat) })) : [];
  full.contacts = Array.isArray(full.contacts) ? full.contacts : [];
  const projectileResult = applySnapshotToProjectiles(full);
  if (!projectileResult?.ok) {
    return { ok: false, reason: SNAPSHOT_REJECTION.PROJECTILE_SEQUENCE_GAP, snapshotSeq: full.snapshotSeq, baseSnapshotSeq: full.baseSnapshotSeq, snapshotKind: full.snapshotKind };
  }
  const useRender = Number.isFinite(renderNow) ? renderNow : (Number(full.projectileSimulationTimeMs) || full.simulationTimeMs);
  full.bullets = getProjectilesForRender(useRender);
  return { ok: true, snapshot: full, networkState: { stateEpoch: full.stateEpoch, snapshotSeq: full.snapshotSeq, staticRevision: full.staticRevision, hasFullBaseline: true, snapshotFormatVersion: Number(full.snapshotFormatVersion) || 1, entityDeltaBaselineSeq: Number(full.snapshotSeq) || 0 } };
}

export function mergeCompactSnapshot(previous, message, renderNow = null) {
  const validation = validateShipDeltas(previous, message);
  if (!validation.ok) return validation;
  const stationValidation = validateStationDeltas(previous, message);
  if (!stationValidation.ok) return stationValidation;
  const next = { ...message };
  next.players = mergeStaticPlayerFields(previous.players, next.players || []);
  next.ships = mergeCachedShipFields(previous.ships, next.ships || []);
  // Contacts are a complete dynamic set. Carrying the previous array when a
  // packet omits it leaves stale contacts on screen after a mode/state change.
  next.contacts = Array.isArray(next.contacts) ? next.contacts : [];
  if (!isNullish(next.stations)) next.stations = mergeCachedStationFields(previous.stations, next.stations);
  const projectileResult = applySnapshotToProjectiles(next);
  if (!projectileResult?.ok) {
    return { ok: false, reason: SNAPSHOT_REJECTION.PROJECTILE_SEQUENCE_GAP, snapshotSeq: next.snapshotSeq, baseSnapshotSeq: next.baseSnapshotSeq, snapshotKind: next.snapshotKind };
  }
  const useRender = Number.isFinite(renderNow) ? renderNow : (Number(next.projectileSimulationTimeMs) || next.simulationTimeMs);
  next.bullets = getProjectilesForRender(useRender);
  for (const key of ["world", "map", "rules", "mapSizeLabel"]) if (isNullish(next[key])) next[key] = previous[key];
  return { ok: true, snapshot: next, networkState: { stateEpoch: next.stateEpoch, snapshotSeq: next.snapshotSeq, staticRevision: next.staticRevision, hasFullBaseline: true, snapshotFormatVersion: 1 } };
}

export function mergeEntityDeltaSnapshot(previous, message, renderNow = null) {
  const validation = validateEntityDeltaPatches(previous, message);
  if (!validation.ok) return { ...validation, snapshotSeq: message?.snapshotSeq, baseSnapshotSeq: message?.baseSnapshotSeq, snapshotKind: message?.snapshotKind };
  const next = { ...message };
  const roomPatch = message.roomPatch || {};
  for (const [key, value] of Object.entries(roomPatch)) next[key] = value;
  for (const key of ["room", "world", "map", "rules", "mapSizeLabel", "phase", "adminId", "winner", "matchStartedAt", "controlVictory", "objectiveControl", "protocolVersion", "serverBuildSha", "balanceRevision"]) {
    if (isNullish(next[key])) next[key] = previous?.[key];
  }
  next.players = applySimplePatch(previous?.players, message.playersPatch);
  next.ships = applyEntityPatch(previous?.ships, message.shipsPatch, "ships");
  next.drones = applyEntityPatch(previous?.drones, message.dronesPatch, "drones");
  next.decoys = applyEntityPatch(previous?.decoys, message.decoysPatch, "decoys");
  next.stations = applyEntityPatch(previous?.stations, message.stationsPatch, "stations");
  next.points = applySimplePatch(previous?.points, message.pointsPatch);
  next.effects = applyEntityPatch(previous?.effects, message.effectsPatch, "effects");
  next.contacts = Array.isArray(message.contacts) ? message.contacts : [];
  const projectileResult = applySnapshotToProjectiles(next);
  if (!projectileResult?.ok) {
    return { ok: false, reason: SNAPSHOT_REJECTION.PROJECTILE_SEQUENCE_GAP, snapshotSeq: next.snapshotSeq, baseSnapshotSeq: next.baseSnapshotSeq, snapshotKind: next.snapshotKind };
  }
  const useRender = Number.isFinite(renderNow) ? renderNow : (Number(next.projectileSimulationTimeMs) || next.simulationTimeMs);
  next.bullets = getProjectilesForRender(useRender);
  return {
    ok: true,
    snapshot: next,
    networkState: {
      stateEpoch: next.stateEpoch,
      snapshotSeq: next.snapshotSeq,
      staticRevision: next.staticRevision,
      hasFullBaseline: true,
      snapshotFormatVersion: 2,
      entityDeltaBaselineSeq: next.snapshotSeq
    }
  };
}

export function mergeSnapshotTransaction(previous, networkState, message, renderNow = null) {
  const envelope = inspectSnapshotEnvelope(networkState, message);
  if (!envelope.ok) return envelope;
  if (envelope.kind === "full") return mergeFullSnapshot(message, renderNow);
  if (envelope.kind === "entity-delta") return mergeEntityDeltaSnapshot(previous, message, renderNow);
  return mergeCompactSnapshot(previous, message, renderNow);
}
