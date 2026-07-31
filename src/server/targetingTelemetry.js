"use strict";

// Sampled targeting telemetry for Phase Three.
// Counters are always authoritative and cheap; detailed durations are sampled
// to avoid per-weapon high-resolution timer calls every tick.

const { performanceNow } = require("./utils");
const RoomTelemetry = require("./roomTelemetry");

const MAX_SAMPLES_PER_SECOND = 64;
const SAMPLE_WINDOW = 4;

function bump(room, name, amount = 1) {
  return RoomTelemetry.bump(room, name, amount);
}

function setCounter(room, name, value) {
  return RoomTelemetry.setCounter(room, name, value);
}

function recordDuration(room, name, startMs) {
  return RoomTelemetry.recordDuration(room, name, startMs);
}

function _shipIdHash(ship) {
  if (!ship) return 0;
  const id = ship.id;
  if (typeof id === "string") {
    return id.length ? id.charCodeAt(id.length - 1) : 0;
  }
  return (Number.isFinite(Number(id)) ? Math.abs(Number(id)) % 64 : 0) || 0;
}

function isTimingSample(room, now, ship, weaponIndex) {
  if (!room || !ship) return false;

  const window = Math.floor(now / 1000);
  if (!room._targetingTiming || room._targetingTiming.window !== window) {
    room._targetingTiming = {
      window,
      count: 0,
      base: window % 64
    };
  }

  if (room._targetingTiming.count >= MAX_SAMPLES_PER_SECOND) return false;

  const token = (_shipIdHash(ship) + (weaponIndex || 0)) % 64;
  const delta = (token - room._targetingTiming.base + 64) % 64;
  if (delta >= SAMPLE_WINDOW) return false;

  room._targetingTiming.count += 1;
  return true;
}

// Call `fn` and record the duration to the named field only when this
// ship/weapon is in the current sample window. Returns the value of `fn`.
function withSampledDuration(room, now, ship, weaponIndex, name, fn) {
  if (!isTimingSample(room, now, ship, weaponIndex)) {
    return fn();
  }

  const start = performanceNow();
  let threw = false;
  let result;
  try {
    result = fn();
  } catch (err) {
    threw = true;
    throw err;
  } finally {
    if (!threw) recordDuration(room, name, start);
  }
  return result;
}

// Record a duration unconditionally (callers already sampled externally).
function recordUnconditionalDuration(room, name, startMs) {
  return recordDuration(room, name, startMs);
}

module.exports = {
  bump,
  setCounter,
  recordDuration,
  isTimingSample,
  withSampledDuration,
  recordUnconditionalDuration
};
