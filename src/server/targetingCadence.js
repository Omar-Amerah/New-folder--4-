"use strict";

// Configurable, deterministic cadence for Phase Three target acquisition.
// All intervals live in one file; staggering is stable and keyed on entity and
// weapon identity.

const PerformanceFlags = require("./performanceFlags");

const ACQUISITION_INTERVALS = Object.freeze({
  ordinaryShip: 1000 / 8,        // 8 Hz
  pointDefence: 1000 / 12,       // 12 Hz
  stationOrdinary: 1000 / 8,     // 8 Hz
  stationPointDefence: 1000 / 12 // 12 Hz
});

const STAGGER_BUCKETS = 32;

function _hashId(entity) {
  const id = entity?.id;
  if (typeof id === "string") {
    return id.length ? id.charCodeAt(id.length - 1) : 0;
  }
  return (Number.isFinite(Number(id)) ? Math.abs(Number(id)) % STAGGER_BUCKETS : 0) || 0;
}

function _staggerOffsetMs(entity, weaponIndex, interval) {
  const bucket = (_hashId(entity) + (weaponIndex || 0)) % STAGGER_BUCKETS;
  return bucket * (interval / STAGGER_BUCKETS);
}

function _ensureSchedule(entity, kind, weaponIndex) {
  if (!entity) return null;
  if (!entity._targetAcquisitionSchedule) entity._targetAcquisitionSchedule = {};
  const key = `${kind}:${weaponIndex}`;
  return key;
}

function nextAcquisitionAt(entity, kind, weaponIndex, now) {
  const interval = ACQUISITION_INTERVALS[kind] || 1000 / 8;
  const schedule = _ensureSchedule(entity, kind, weaponIndex);
  if (schedule === null) return now;

  let start = entity._targetAcquisitionSchedule[`${schedule}_start`];
  if (start === undefined) {
    start = now;
    entity._targetAcquisitionSchedule[`${schedule}_start`] = start;
  }

  const offset = _staggerOffsetMs(entity, weaponIndex, interval);
  const elapsed = now - start;
  const phases = Math.floor((elapsed - offset) / interval);
  const nextDue = start + offset + (phases + 1) * interval;
  return nextDue;
}

function isAcquisitionDue(entity, kind, weaponIndex, now) {
  if (!PerformanceFlags.WEAPON_TARGET_ACQUISITION_CADENCE()) return true;
  const schedule = _ensureSchedule(entity, kind, weaponIndex);
  if (schedule === null) return true;

  const key = `${schedule}_at`;
  const dueAt = entity._targetAcquisitionSchedule[key] || 0;
  return now >= dueAt;
}

function markAcquisitionCompleted(entity, kind, weaponIndex, now) {
  const interval = ACQUISITION_INTERVALS[kind] || 1000 / 8;
  const schedule = _ensureSchedule(entity, kind, weaponIndex);
  if (schedule === null) return;

  const startKey = `${schedule}_start`;
  if (entity._targetAcquisitionSchedule[startKey] === undefined) {
    entity._targetAcquisitionSchedule[startKey] = now;
  }

  const offset = _staggerOffsetMs(entity, weaponIndex, interval);
  const start = entity._targetAcquisitionSchedule[startKey];
  const elapsed = now - start;
  const phases = Math.max(0, Math.floor((elapsed - offset) / interval));
  const nextDue = start + offset + (phases + 1) * interval;
  entity._targetAcquisitionSchedule[`${schedule}_at`] = nextDue;
}

function invalidateAcquisitionSchedule(entity, weaponIndex) {
  if (!entity?._targetAcquisitionSchedule) return;
  if (weaponIndex !== undefined) {
    for (const key of Object.keys(entity._targetAcquisitionSchedule)) {
      if (key.startsWith(`${weaponIndex}:`) || key.includes(`:${weaponIndex}_`)) {
        delete entity._targetAcquisitionSchedule[key];
      }
    }
  } else {
    entity._targetAcquisitionSchedule = {};
  }
}

module.exports = {
  ACQUISITION_INTERVALS,
  STAGGER_BUCKETS,
  nextAcquisitionAt,
  isAcquisitionDue,
  markAcquisitionCompleted,
  invalidateAcquisitionSchedule
};
