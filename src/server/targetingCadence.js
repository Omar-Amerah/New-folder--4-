"use strict";

// Configurable, deterministic cadence for Phase Three target acquisition.
// All intervals live in one file; staggering is stable and keyed on entity and
// weapon identity.

const ACQUISITION_INTERVALS = Object.freeze({
  ordinaryShip: 1000 / 8,        // 8 Hz
  shipCombat: 1000 / 5,          // 5 Hz ship-level primary target refresh
  pointDefence: 1000 / 12,       // 12 Hz
  stationOrdinary: 1000 / 8,     // 8 Hz
  stationPointDefence: 1000 / 12 // 12 Hz
});

const STAGGER_BUCKETS = 32;

function _hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) {
    h = ((h << 5) + h) + str.charCodeAt(i);
  }
  return Math.abs(h) % STAGGER_BUCKETS;
}

function _hashId(entity) {
  const id = entity?.id;
  if (typeof id === "string") {
    return _hashString(id);
  }
  return (Number.isFinite(Number(id)) ? Math.abs(Number(id)) % STAGGER_BUCKETS : 0) || 0;
}

function _cachedStaggerOffset(entity, weaponIndex, interval) {
  if (!entity._targetAcquisitionOffsets) entity._targetAcquisitionOffsets = {};
  const key = `${interval}:${weaponIndex}`;
  if (!(key in entity._targetAcquisitionOffsets)) {
    const bucket = (_hashId(entity) + (weaponIndex || 0)) % STAGGER_BUCKETS;
    entity._targetAcquisitionOffsets[key] = bucket * (interval / STAGGER_BUCKETS);
  }
  return entity._targetAcquisitionOffsets[key];
}

function _ensureSchedule(entity) {
  if (!entity) return null;
  if (!entity._targetAcquisitionSchedule) entity._targetAcquisitionSchedule = {};
  return entity._targetAcquisitionSchedule;
}

function _startKey(kind, weaponIndex) {
  return `${kind}:${weaponIndex}_start`;
}

function _atKey(kind, weaponIndex) {
  return `${kind}:${weaponIndex}_at`;
}

function nextAcquisitionAt(entity, kind, weaponIndex, now) {
  const interval = ACQUISITION_INTERVALS[kind] || 1000 / 8;
  const schedule = _ensureSchedule(entity);
  if (schedule === null) return now;

  const startKey = _startKey(kind, weaponIndex);
  let start = schedule[startKey];
  if (start === undefined) {
    start = now;
    schedule[startKey] = start;
  }

  const offset = _cachedStaggerOffset(entity, weaponIndex, interval);
  const elapsed = now - start;
  const phases = Math.floor((elapsed - offset) / interval);
  return start + offset + (phases + 1) * interval;
}

function isAcquisitionDue(entity, kind, weaponIndex, now) {
  const schedule = _ensureSchedule(entity);
  if (schedule === null) return true;

  const dueAt = schedule[_atKey(kind, weaponIndex)] || 0;
  return now >= dueAt;
}

function markAcquisitionCompleted(entity, kind, weaponIndex, now) {
  const interval = ACQUISITION_INTERVALS[kind] || 1000 / 8;
  const schedule = _ensureSchedule(entity);
  if (schedule === null) return;

  const startKey = _startKey(kind, weaponIndex);
  if (schedule[startKey] === undefined) schedule[startKey] = now;

  const offset = _cachedStaggerOffset(entity, weaponIndex, interval);
  const start = schedule[startKey];
  const elapsed = now - start;
  // Preserve the initial stagger. Clamping the phase to zero delayed mounts
  // with a non-zero offset by an extra complete interval after their first
  // search, producing an avoidable ~160 ms worst case for 12 Hz PD.
  const phases = Math.floor((elapsed - offset) / interval);
  schedule[_atKey(kind, weaponIndex)] = start + offset + (phases + 1) * interval;
}

function forceAcquisitionNow(entity, kind, weaponIndex) {
  const schedule = _ensureSchedule(entity);
  if (schedule === null) return;
  schedule[_atKey(kind, weaponIndex)] = 0;
}

function invalidateAcquisitionSchedule(entity, weaponIndex) {
  if (!entity?._targetAcquisitionSchedule) return;
  if (weaponIndex === undefined) {
    entity._targetAcquisitionSchedule = {};
    if (entity._targetAcquisitionOffsets) entity._targetAcquisitionOffsets = {};
    return;
  }
  const suffix = `:${weaponIndex}_`;
  for (const key of Object.keys(entity._targetAcquisitionSchedule)) {
    const separator = key.indexOf(":");
    if (separator >= 0 && key.slice(separator).startsWith(suffix)) {
      delete entity._targetAcquisitionSchedule[key];
    }
  }
}

function invalidateAllAcquisitionSchedules(room) {
  if (!room) return;
  for (const ship of room?.ships ? [...room.ships.values()] : []) {
    invalidateAcquisitionSchedule(ship);
  }
  for (const station of room?.stations || []) {
    invalidateAcquisitionSchedule(station);
  }
}

module.exports = {
  ACQUISITION_INTERVALS,
  STAGGER_BUCKETS,
  nextAcquisitionAt,
  isAcquisitionDue,
  markAcquisitionCompleted,
  forceAcquisitionNow,
  invalidateAcquisitionSchedule,
  invalidateAllAcquisitionSchedules
};
