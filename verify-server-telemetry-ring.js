#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  SUBSYSTEM_NAMES,
  recordRoomTick,
  performanceSnapshot
} = require("./src/server/performanceTelemetry");

for (let sample = 0; sample < 3000; sample += 1) {
  const durations = {};
  for (let index = 0; index < SUBSYSTEM_NAMES.length; index += 1) {
    durations[SUBSYSTEM_NAMES[index]] = sample + index / 100;
  }
  // Keep the public wrapper compatible while allowing the simulation to pass
  // its reusable duration object directly.
  recordRoomTick(sample % 2 === 0 ? durations : { durations });
}

const snapshot = performanceSnapshot(30);
for (let index = 0; index < SUBSYSTEM_NAMES.length; index += 1) {
  const name = SUBSYSTEM_NAMES[index];
  const summary = snapshot.subsystems[name];
  assert.equal(summary.samples, 2048, `${name} retains the fixed telemetry window after wraparound`);
  assert.equal(summary.latest, 2999 + index / 100, `${name} preserves the newest sample after wraparound`);
  assert.ok(summary.p95 >= summary.p50, `${name} percentile ordering remains valid`);
  assert.ok(summary.max >= summary.p95, `${name} maximum remains valid`);
}

console.log("Server telemetry fixed-ring compatibility verification passed");
