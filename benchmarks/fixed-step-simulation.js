#!/usr/bin/env node
"use strict";

const { createRoom } = require("../src/server/rooms");
const { advanceRoomAuthoritative, FIXED_STEP_MS } = require("../src/server/simulation");
const { getRoomTelemetry } = require("../src/server/roomTelemetry");

function activeRoom(code) {
  const room = createRoom(code, { seed: 1 });
  room.phase = "active";
  room.stations = [];
  room.drones = new Map();
  room.decoys = new Map();
  room.droneCounts = { byOwner: new Map(), byParent: new Map() };
  return room;
}

function benchmark(label, deltas) {
  const room = activeRoom(`FIXED-STEP-BENCH-${label}`);
  let t = 1_000_000;
  const durations = [];
  const samples = [];

  for (const delta of deltas) {
    t += delta;
    const callbackStart = process.hrtime.bigint();
    advanceRoomAuthoritative(room, t);
    const callbackEnd = process.hrtime.bigint();
    const callbackUs = Number(callbackEnd - callbackStart) / 1_000;
    const tel = getRoomTelemetry(room);
    samples.push({
      steps: tel.fixedSteps,
      catchUp: tel.fixedStepCatchUpCallbacks,
      maxCatchUp: tel.fixedStepMaxCatchUp,
      discarded: tel.fixedStepDiscardedBacklogMs,
      jitter: tel.fixedStepJitterMs,
      stepDuration: tel.fixedStepDurationMs,
      callbackUs
    });
    durations.push(callbackUs);
  }

  const totalSteps = samples.reduce((s, r) => s + r.steps, 0);
  const catchUpCallbacks = samples.reduce((s, r) => s + r.catchUp, 0);
  const maxCatchUp = samples.reduce((m, r) => Math.max(m, r.maxCatchUp), 0);
  const discardedTotal = samples.reduce((s, r) => s + r.discarded, 0);
  const maxDiscarded = samples.reduce((m, r) => Math.max(m, r.discarded), 0);
  const stepDurations = samples.filter((r) => r.steps > 0).map((r) => r.stepDuration);
  const meanStepDuration = stepDurations.length
    ? stepDurations.reduce((s, v) => s + v, 0) / stepDurations.length
    : 0;
  const maxStepDuration = stepDurations.length ? Math.max(...stepDurations) : 0;
  const meanCallbackUs = durations.reduce((s, v) => s + v, 0) / durations.length;
  const maxCallbackUs = Math.max(...durations);

  return {
    label,
    callbacks: deltas.length,
    fixedSteps: totalSteps,
    catchUpCallbacks,
    maxCatchUp,
    totalDiscardedMs: discardedTotal,
    maxDiscardedMs: maxDiscarded,
    meanStepDurationMs: meanStepDuration,
    maxStepDurationMs: maxStepDuration,
    meanCallbackUs,
    maxCallbackUs
  };
}

const callbacks = 60;
const jitter = Array.from({ length: callbacks }, (_, i) => i * 42 % 11 - 5);

function run() {
  // 1. Steady cadence.
  const steady = benchmark("steady", Array(callbacks).fill(FIXED_STEP_MS));

  // 2. Mild jitter around the nominal step.
  const jittered = benchmark("jitter", Array.from({ length: callbacks }, (_, i) => FIXED_STEP_MS + jitter[i]));

  // 3. A short simulated stall in the middle.
  const stall = Array(callbacks).fill(FIXED_STEP_MS);
  stall[Math.floor(callbacks / 2)] += 120; // add 120ms of backlog
  const stalled = benchmark("stall", stall);

  // 4. Multiple independent rooms.
  const rooms = [steady, jittered, stalled];

  console.log("Fixed-step simulation benchmark");
  for (const r of rooms) {
    console.log(`  ${r.label}: callbacks=${r.callbacks}, fixedSteps=${r.fixedSteps}, catchUpCallbacks=${r.catchUpCallbacks}, maxCatchUp=${r.maxCatchUp}, totalDiscardedMs=${r.totalDiscardedMs.toFixed(2)}, maxDiscardedMs=${r.maxDiscardedMs.toFixed(2)}, meanStepDurationMs=${r.meanStepDurationMs.toFixed(3)}, maxStepDurationMs=${r.maxStepDurationMs.toFixed(3)}, meanCallbackUs=${r.meanCallbackUs.toFixed(1)}, maxCallbackUs=${r.maxCallbackUs.toFixed(1)}`);
  }

  // 5. Independent-room overlap smoke check.
  const roomA = benchmark("roomA", Array(20).fill(FIXED_STEP_MS));
  const roomB = benchmark("roomB", Array(20).fill(FIXED_STEP_MS).map((d, i) => i % 5 === 0 ? d + 50 : d));
  const roomC = benchmark("roomC", Array(20).fill(FIXED_STEP_MS));
  console.log(`  roomA steps=${roomA.fixedSteps}, roomB steps=${roomB.fixedSteps}, roomC steps=${roomC.fixedSteps}`);
  console.log("Benchmark complete; canonical fixed-step runtime remains active");
}

run();
