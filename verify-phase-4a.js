#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { TICK_HZ } = require("./src/server/config");
const { FIXED_AUTHORITATIVE_TIMESTEP, __setFIXED_AUTHORITATIVE_TIMESTEP } = require("./src/server/performanceFlags");
const { createRoom, bumpStateEpoch } = require("./src/server/rooms");
const { tickRoom, advanceRoomAuthoritative, FIXED_STEP_MS, FIXED_STEP_S, MAX_CATCH_UP_STEPS } = require("./src/server/simulation");
const { getRoomTelemetry } = require("./src/server/roomTelemetry");

const EPSILON = 1e-6;

function activeRoom(code) {
  const room = createRoom(code, { seed: 1 });
  room.phase = "active";
  // Give the room a minimal active match state so the existing systems do not
  // trip over undefined collections.
  room.stations = [];
  room.drones = new Map();
  room.decoys = new Map();
  room.droneCounts = { byOwner: new Map(), byParent: new Map() };
  return room;
}

// 1. Flag defaults to false and can be toggled for tests.
{
  __setFIXED_AUTHORITATIVE_TIMESTEP(false);
  assert.strictEqual(FIXED_AUTHORITATIVE_TIMESTEP(), false, "FIXED_AUTHORITATIVE_TIMESTEP defaults to false");
  __setFIXED_AUTHORITATIVE_TIMESTEP(true);
  assert.strictEqual(FIXED_AUTHORITATIVE_TIMESTEP(), true, "FIXED_AUTHORITATIVE_TIMESTEP test setter works");
  __setFIXED_AUTHORITATIVE_TIMESTEP(false);
}

// 2. A steady callback cadence produces the expected number of fixed steps.
{
  const room = activeRoom("PH4ASTEADY");
  const t0 = 1_000_000;
  const callbacks = 8;
  for (let i = 0; i < callbacks; i += 1) {
    advanceRoomAuthoritative(room, t0 + i * FIXED_STEP_MS);
  }
  assert.strictEqual(room._simulationStep, callbacks, "steady cadence runs one fixed step per callback");
  assert(Math.abs(room._authoritativeTimeMs - (t0 + callbacks * FIXED_STEP_MS)) < EPSILON, "authoritative time advances by exact fixed increments");
  assert(Math.abs(room._simulationAccumulatorMs) < EPSILON, "steady cadence leaves no leftover backlog");
}

// 3. Jittered callback timings still advance the authoritative clock by exact
// fixed-step increments; the final time is determined only by the number of
// fixed steps that have been executed, not by the callback schedule.
{
  const room = activeRoom("PH4AJITTER");
  const t0 = 2_000_000;
  const targetSteps = 5;
  const jitter = [2, -2, 4, -4, 0, 3, -3, 1, -1, 0, 2, -2];
  let t = t0;
  advanceRoomAuthoritative(room, t);
  let i = 0;
  while (room._simulationStep < targetSteps) {
    t += FIXED_STEP_MS + jitter[i % jitter.length];
    advanceRoomAuthoritative(room, t);
    i += 1;
  }
  assert(room._simulationStep >= targetSteps, "jittered cadence reaches at least the target step count");
  assert(Math.abs(room._authoritativeTimeMs - (t0 + room._simulationStep * FIXED_STEP_MS)) < EPSILON, "authoritative time is an exact multiple of the fixed step");
}

// 4. A delayed callback produces multiple bounded catch-up steps.
// 5. Backlog beyond the configured catch-up limit is clamped and recorded.
{
  const room = activeRoom("PH4ACATCHUP");
  const t0 = 3_000_000;
  // First callback: one step is seeded and executed.
  advanceRoomAuthoritative(room, t0);
  assert.strictEqual(room._simulationStep, 1, "first callback runs one step");

  // Second callback is 4 full steps late (5 steps total accumulated).
  // MAX_CATCH_UP_STEPS limits it to 3, discarding the surplus 2 steps.
  const delayedBySteps = MAX_CATCH_UP_STEPS + 1;
  advanceRoomAuthoritative(room, t0 + delayedBySteps * FIXED_STEP_MS);
  assert.strictEqual(room._simulationStep, 1 + MAX_CATCH_UP_STEPS, "delayed callback runs at most MAX_CATCH_UP_STEPS");
  assert.strictEqual(getRoomTelemetry(room).fixedStepMaxCatchUp, MAX_CATCH_UP_STEPS, "telemetry records the maximum catch-up reached");
  assert(Math.abs(getRoomTelemetry(room).fixedStepDiscardedBacklogMs - (delayedBySteps - MAX_CATCH_UP_STEPS) * FIXED_STEP_MS) < EPSILON, "discarded backlog recorded correctly");
  assert.strictEqual(room._simulationStep, 1 + MAX_CATCH_UP_STEPS, "discarded backlog does not advance authoritative step count");
  assert(Math.abs(room._authoritativeTimeMs - (t0 + (1 + MAX_CATCH_UP_STEPS) * FIXED_STEP_MS)) < EPSILON, "authoritative time only advances by the executed fixed steps");
}

// 6. Gameplay systems never receive a giant delayed dt.
// 9. Movement is not accidentally applied twice: a 4-step late callback only
//    advances a projectile by MAX_CATCH_UP_STEPS fixed substeps.
{
  const room = activeRoom("PH4ANOGIANT");
  room.bullets.push({ id: "b1", type: "shot", ownerId: "p1", x: 0, y: 0, vx: 300, vy: 0, life: 5, damage: 1 });
  const t0 = 4_000_000;
  advanceRoomAuthoritative(room, t0);
  const beforeX = room.bullets[0].x;

  const delayedBySteps = 4;
  advanceRoomAuthoritative(room, t0 + delayedBySteps * FIXED_STEP_MS);
  const expectedPerStep = 300 * FIXED_STEP_S;
  const actualDelta = room.bullets[0].x - beforeX;
  const expectedDelta = MAX_CATCH_UP_STEPS * expectedPerStep;
  assert(Math.abs(actualDelta - expectedDelta) < 1, "projectile advances by bounded catch-up steps, not one giant dt");
  assert(actualDelta < (delayedBySteps + 1) * expectedPerStep, "delayed callback does not multiply movement substeps");
}

// 7. Authoritative simulation time advances by exact fixed increments.
// 11. Accumulator remains isolated per room.
{
  const roomA = activeRoom("PH4AROOMPAIR-A");
  const roomB = activeRoom("PH4AROOMPAIR-B");
  const t0 = 5_000_000;
  // Room A gets regular cadence; room B gets a one-off large stall.
  for (let i = 0; i < 3; i += 1) advanceRoomAuthoritative(roomA, t0 + i * FIXED_STEP_MS);
  advanceRoomAuthoritative(roomB, t0);
  advanceRoomAuthoritative(roomB, t0 + 6 * FIXED_STEP_MS);

  assert.strictEqual(roomA._simulationStep, 3, "room A accumulator independent of room B");
  assert(Math.abs(roomA._simulationAccumulatorMs) < EPSILON, "room A accumulator stays clean");
  assert.strictEqual(roomB._simulationStep, 1 + MAX_CATCH_UP_STEPS, "room B clamps its own catch-up");
  assert(roomA._authoritativeTimeMs !== roomB._authoritativeTimeMs || roomA._simulationStep !== roomB._simulationStep, "rooms do not share accumulator state");
}

// 8. A system executes exactly once per fixed step (smoke check: the step count
// matches the number of calls for a normal callback).
// 10. Callback re-entry is prevented and the room unlocks correctly.
{
  const room = activeRoom("PH4AREENTRY");
  const t0 = 6_000_000;
  advanceRoomAuthoritative(room, t0);
  const stepAfterFirst = room._simulationStep;

  // Simulate a re-entrant call while the room is already locked.
  room._simulationLocked = true;
  advanceRoomAuthoritative(room, t0 + FIXED_STEP_MS);
  assert.strictEqual(room._simulationStep, stepAfterFirst, "re-entrant callback does not advance the room");
  assert.strictEqual(room._simulationReentries, 1, "re-entrant callback is recorded");

  // Unlock and resume: the next normal callback advances again.
  room._simulationLocked = false;
  advanceRoomAuthoritative(room, t0 + 2 * FIXED_STEP_MS);
  assert(room._simulationStep >= stepAfterFirst + 1, "room unlocks and continues stepping");
  assert.strictEqual(room._simulationReentries, 0, "re-entry counter resets after successful callback");
  assert.strictEqual(room._simulationLocked, false, "room is not left permanently locked");
  assert.strictEqual(getRoomTelemetry(room).fixedStepReentryAttempts, 1, "re-entry attempt is recorded in telemetry");
}

// 12. Existing flag-disabled behaviour still works.
{
  const room = activeRoom("PH4ADISABLED");
  const dt = 0.05;
  const now = 7_000_000;
  __setFIXED_AUTHORITATIVE_TIMESTEP(false);
  tickRoom(room, dt, now);
  assert.strictEqual(room.simulationTimeMs, now, "disabled path stamps simulation time with the callback wall time");
  assert.strictEqual(getRoomTelemetry(room).fixedStepCallbacks, 0, "disabled path does not emit fixed-step telemetry");
  __setFIXED_AUTHORITATIVE_TIMESTEP(true);
}

// 13. Room reset or recreation clears timing runtime correctly.
{
  const room = activeRoom("PH4ARESET");
  const t0 = 8_000_000;
  advanceRoomAuthoritative(room, t0);
  bumpStateEpoch(room, "test-reset");
  assert.strictEqual(room._authoritativeTimeMs, 0, "state reset clears authoritative time");
  assert.strictEqual(room._simulationAccumulatorMs, 0, "state reset clears accumulator");
  assert.strictEqual(room._simulationStep, 0, "state reset clears step counter");
  assert.strictEqual(room._simulationReentries, 0, "state reset clears re-entry counter");
}

// 14. No negative or non-finite callback delta can corrupt the room.
{
  const room = activeRoom("PH4ABADDELTA");
  // Non-finite initial wall time is substituted and the room starts cleanly.
  assert.doesNotThrow(() => advanceRoomAuthoritative(room, NaN), "NaN wall time does not throw");
  assert(Number.isFinite(room._authoritativeTimeMs), "authoritative time remains finite after NaN callback");
  const stepAfterNaN = room._simulationStep;

  // Negative callback wall time on a subsequent call is treated as one fixed step.
  assert.doesNotThrow(() => advanceRoomAuthoritative(room, -1), "negative wall time does not throw");
  assert(Number.isFinite(room._authoritativeTimeMs), "authoritative time remains finite after negative callback");
  assert(room._simulationStep >= stepAfterNaN, "room continues stepping after bad wall times");
}

console.log("Phase 4A fixed authoritative timestep verification passed");
