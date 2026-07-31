#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { TICK_HZ } = require("./src/server/config");
const { FIXED_AUTHORITATIVE_TIMESTEP, __setFIXED_AUTHORITATIVE_TIMESTEP } = require("./src/server/performanceFlags");
const { createRoom, bumpStateEpoch } = require("./src/server/rooms");
const { tickRoom, advanceRoomAuthoritative, FIXED_STEP_MS, FIXED_STEP_S, MAX_CATCH_UP_STEPS } = require("./src/server/simulation");
const { getRoomTelemetry } = require("./src/server/roomTelemetry");
const { gameplayNow } = require("./src/server/gameplayTime");
const { requestSelfDestruct } = require("./src/server/combat");
const { addBullet } = require("./src/server/projectiles");

const EPSILON = 1e-6;

__setFIXED_AUTHORITATIVE_TIMESTEP(true);

function activeRoom(code) {
  const room = createRoom(code, { seed: 1 });
  room.phase = "active";
  room.stations = [];
  room.drones = new Map();
  room.decoys = new Map();
  room.droneCounts = { byOwner: new Map(), byParent: new Map() };
  room.spatialIndex = null;
  return room;
}

function activeShipAndPlayer(room, id, playerId = "p1", team = 1) {
  const ship = {
    id,
    ownerId: playerId,
    team,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    alive: true,
    removed: false,
    radius: 30,
    selfDestructAt: null,
    nextDestructSparkAt: 0,
    effects: [],
    design: [{ x: 7, y: 7, type: "core" }, { x: 7, y: 6, type: "engine" }],
    componentHp: [50, 50],
    componentMaxHp: [50, 50]
  };
  const player = {
    id: playerId,
    team,
    ships: [ship]
  };
  room.players.set(playerId, player);
  room.ships.set(id, ship);
  return { ship, player };
}

// 1. Flag defaults to false and can be toggled for tests.
{
  __setFIXED_AUTHORITATIVE_TIMESTEP(false);
  assert.strictEqual(FIXED_AUTHORITATIVE_TIMESTEP(), false, "FIXED_AUTHORITATIVE_TIMESTEP defaults to false");
  __setFIXED_AUTHORITATIVE_TIMESTEP(true);
  assert.strictEqual(FIXED_AUTHORITATIVE_TIMESTEP(), true, "FIXED_AUTHORITATIVE_TIMESTEP test setter works");
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
  assert(Math.abs(room._authoritativeTimeMs - (t0 + (callbacks - 1) * FIXED_STEP_MS)) < EPSILON, "authoritative time advances by exact fixed increments");
  assert(Math.abs(room._simulationAccumulatorMs) < EPSILON, "steady cadence leaves no leftover backlog");
}

// 3. Jittered callback timings produce the same deterministic ship/projectile
// state as steady callbacks after the same number of fixed steps.
{
  const steady = activeRoom("PH4ASTEADY-DET");
  const jitter = activeRoom("PH4AJITTER-DET");
  const t0 = 2_000_000;
  const jitterPattern = [2, -2, 4, -4, 0, 3, -3, 1, -1, 0, 2, -2];

  addBullet(steady, { type: "shot", ownerId: "p1", x: 0, y: 0, vx: 300, vy: 0, life: 5, damage: 1 });
  addBullet(jitter, { type: "shot", ownerId: "p1", x: 0, y: 0, vx: 300, vy: 0, life: 5, damage: 1 });

  let jT = t0;
  advanceRoomAuthoritative(jitter, jT);

  let i = 0;
  while (jitter._simulationStep < 6) {
    jT += FIXED_STEP_MS + jitterPattern[i % jitterPattern.length];
    advanceRoomAuthoritative(jitter, jT);
    i += 1;
  }

  const targetStep = jitter._simulationStep;
  const jitterBullet = jitter.bullets[0];
  const jitterAuth = jitter._authoritativeTimeMs;

  let sT = t0;
  advanceRoomAuthoritative(steady, sT);
  while (steady._simulationStep < targetStep) {
    sT += FIXED_STEP_MS;
    advanceRoomAuthoritative(steady, sT);
  }

  const expectedAuth = t0 + (targetStep - 1) * FIXED_STEP_MS;
  assert.strictEqual(steady._simulationStep, targetStep, "steady and jittered rooms reach the same step count");
  assert(Math.abs(steady._authoritativeTimeMs - expectedAuth) < EPSILON, "steady authoritative time lands exactly on its final step");
  assert(Math.abs(jitter._authoritativeTimeMs - expectedAuth) < EPSILON, "jittered authoritative time lands exactly on its final step");
  assert(Math.abs(steady._authoritativeTimeMs - jitterAuth) < EPSILON, "steady and jittered rooms share the same authoritative time");
  assert.strictEqual(steady.bullets.length, jitter.bullets.length, "same number of bullets");
  for (let b = 0; b < steady.bullets.length; b += 1) {
    assert(Math.abs(steady.bullets[b].x - jitter.bullets[b].x) < EPSILON, `bullet ${b} x matches after jitter`);
    assert(Math.abs(steady.bullets[b].y - jitter.bullets[b].y) < EPSILON, `bullet ${b} y matches after jitter`);
  }
  assert(Math.abs(steady.bullets[0].x - jitterBullet.x) < EPSILON, "the deterministic projectile position matches");
}

// 4. A delayed callback produces multiple bounded catch-up steps.
// 5. Backlog beyond the configured catch-up limit is clamped and recorded.
{
  const room = activeRoom("PH4ACATCHUP");
  const t0 = 3_000_000;
  advanceRoomAuthoritative(room, t0);
  assert.strictEqual(room._simulationStep, 1, "first callback runs one step");

  const delayedBySteps = MAX_CATCH_UP_STEPS + 1;
  advanceRoomAuthoritative(room, t0 + delayedBySteps * FIXED_STEP_MS);
  assert.strictEqual(room._simulationStep, 1 + MAX_CATCH_UP_STEPS, "delayed callback runs at most MAX_CATCH_UP_STEPS");
  assert.strictEqual(getRoomTelemetry(room).fixedStepMaxCatchUp, MAX_CATCH_UP_STEPS, "telemetry records the maximum catch-up reached");
  assert(Math.abs(getRoomTelemetry(room).fixedStepDiscardedBacklogMs - (delayedBySteps - MAX_CATCH_UP_STEPS) * FIXED_STEP_MS) < EPSILON, "discarded backlog recorded correctly");
  assert(Math.abs(room._authoritativeTimeMs - (t0 + MAX_CATCH_UP_STEPS * FIXED_STEP_MS)) < EPSILON, "authoritative time only advances by the executed fixed steps");
}

// 6. Gameplay systems never receive a giant delayed dt.
// 9. Movement is not accidentally applied twice.
{
  const room = activeRoom("PH4ANOGIANT");
  addBullet(room, { type: "shot", ownerId: "p1", x: 0, y: 0, vx: 300, vy: 0, life: 5, damage: 1 });
  const t0 = 4_000_000;
  advanceRoomAuthoritative(room, t0);
  const beforeX = room.bullets[0].x;

  const delayedBySteps = 4;
  advanceRoomAuthoritative(room, t0 + delayedBySteps * FIXED_STEP_MS);
  const expectedDelta = MAX_CATCH_UP_STEPS * (300 * FIXED_STEP_S);
  const actualDelta = room.bullets[0].x - beforeX;
  assert(Math.abs(actualDelta - expectedDelta) < 1, "projectile advances by bounded catch-up steps, not one giant dt");
}

// 7. Authoritative simulation time advances by exact fixed increments.
// 11. Accumulator remains isolated per room.
{
  const roomA = activeRoom("PH4AROOMPAIR-A");
  const roomB = activeRoom("PH4AROOMPAIR-B");
  const t0 = 5_000_000;
  for (let i = 0; i < 3; i += 1) advanceRoomAuthoritative(roomA, t0 + i * FIXED_STEP_MS);
  advanceRoomAuthoritative(roomB, t0);
  advanceRoomAuthoritative(roomB, t0 + 6 * FIXED_STEP_MS);

  assert.strictEqual(roomA._simulationStep, 3, "room A accumulator independent of room B");
  assert.strictEqual(roomB._simulationStep, 1 + MAX_CATCH_UP_STEPS, "room B clamps its own catch-up");
  assert(roomA._authoritativeTimeMs !== roomB._authoritativeTimeMs || roomA._simulationStep !== roomB._simulationStep, "rooms do not share accumulator state");
}

// 8. Each fixed step invokes the authoritative step function exactly once.
{
  const room = activeRoom("PH4ASTEPCOUNT");
  let stepCalls = 0;
  room._advanceStepFn = (r, dt, now) => {
    stepCalls += 1;
    assert.strictEqual(gameplayNow(r), now, "gameplayNow returns the current step timestamp inside tick");
    tickRoom(r, dt, now);
  };

  const t0 = 6_000_000;
  advanceRoomAuthoritative(room, t0);
  assert.strictEqual(stepCalls, 1, "one step call for one fixed step");

  stepCalls = 0;
  advanceRoomAuthoritative(room, t0 + (MAX_CATCH_UP_STEPS + 1) * FIXED_STEP_MS);
  assert.strictEqual(stepCalls, MAX_CATCH_UP_STEPS, "catch-up calls the step function once per fixed step");
}

// 10. Callback re-entry is prevented and the room unlocks correctly.
{
  const room = activeRoom("PH4AREENTRY");
  const t0 = 7_000_000;
  advanceRoomAuthoritative(room, t0);
  const stepAfterFirst = room._simulationStep;

  room._simulationLocked = true;
  advanceRoomAuthoritative(room, t0 + FIXED_STEP_MS);
  assert.strictEqual(room._simulationStep, stepAfterFirst, "re-entrant callback does not advance the room");
  assert.strictEqual(room._simulationReentries, 1, "re-entrant callback is recorded");

  room._simulationLocked = false;
  advanceRoomAuthoritative(room, t0 + 2 * FIXED_STEP_MS);
  assert(room._simulationStep >= stepAfterFirst + 1, "room unlocks and continues stepping");
  assert.strictEqual(room._simulationReentries, 0, "re-entry counter resets after successful callback");
  assert.strictEqual(room._simulationLocked, false, "room is not left permanently locked");
  assert.strictEqual(getRoomTelemetry(room).fixedStepReentryAttempts, 1, "re-entry attempt is recorded in telemetry");
}

// 12. Existing flag-disabled behaviour still works.
{
  __setFIXED_AUTHORITATIVE_TIMESTEP(false);
  const room = activeRoom("PH4ADISABLED");
  const dt = 0.05;
  const now = 8_000_000;
  tickRoom(room, dt, now);
  assert.strictEqual(room.simulationTimeMs, now, "disabled path stamps simulation time with the callback wall time");
  assert.strictEqual(getRoomTelemetry(room).fixedStepCallbacks, 0, "disabled path does not emit fixed-step telemetry");
  __setFIXED_AUTHORITATIVE_TIMESTEP(true);
}

// 13. Room reset or recreation clears timing runtime correctly.
{
  const room = activeRoom("PH4ARESET");
  const t0 = 9_000_000;
  advanceRoomAuthoritative(room, t0);
  bumpStateEpoch(room, "test-reset");
  assert.strictEqual(room._authoritativeTimeMs, 0, "state reset clears authoritative time");
  assert.strictEqual(room._simulationAccumulatorMs, 0, "state reset clears accumulator");
  assert.strictEqual(room._simulationStep, 0, "state reset clears step counter");
  assert.strictEqual(room._simulationReentries, 0, "state reset clears re-entry counter");
}

// 14. Invalid callback history: a backwards or NaN callback is ignored and does
// not leave artificial backlog for the next valid callback.
{
  const room = activeRoom("PH4ABADDELTA");
  const t0 = 10_000_000;
  advanceRoomAuthoritative(room, t0);
  const afterValid = room._simulationStep;
  const lastMs = room._lastSimulationCallbackMs;

  assert.doesNotThrow(() => advanceRoomAuthoritative(room, t0 - 1), "backwards wall time does not throw");
  assert.strictEqual(room._lastSimulationCallbackMs, lastMs, "backwards callback does not corrupt history");
  assert.strictEqual(room._simulationStep, afterValid + 1, "backwards callback runs one fallback step");

  assert.doesNotThrow(() => advanceRoomAuthoritative(room, NaN), "NaN wall time does not throw");
  assert.strictEqual(room._lastSimulationCallbackMs, lastMs, "NaN callback does not corrupt history");

  // A normal callback after the bad ones should not see an artificially huge
  // delta; it only consumes the real wall time since the last valid callback.
  advanceRoomAuthoritative(room, t0 + 3 * FIXED_STEP_MS);
  assert.strictEqual(getRoomTelemetry(room).fixedStepDiscardedBacklogMs, 0, "no artificial discarded backlog");
  assert.strictEqual(room._simulationStep, afterValid + 5, "normal callback continues cleanly from the last valid time");
}

// 15. Exception recovery: a failing step preserves the remaining accumulator.
{
  const room = activeRoom("PH4AEXCEPTION");
  const t0 = 11_000_000;
  advanceRoomAuthoritative(room, t0);

  let calls = 0;
  room._advanceStepFn = (r, dt, now) => {
    calls += 1;
    if (calls === 2) throw new Error("injected step failure");
    tickRoom(r, dt, now);
  };

  let threw = false;
  try {
    advanceRoomAuthoritative(room, t0 + 4 * FIXED_STEP_MS);
  } catch (err) {
    threw = true;
    assert.strictEqual(calls, 2, "failure happened during the second planned step");
    assert(Math.abs(room._simulationAccumulatorMs - 2 * FIXED_STEP_MS) < EPSILON, "remaining catch-up steps stay in the accumulator");
    assert(Math.abs(room._authoritativeTimeMs - (t0 + FIXED_STEP_MS)) < EPSILON, "authoritative time does not advance past the failing step");
  }
  assert(threw, "injected step failure is propagated");

  room._advanceStepFn = null;
  advanceRoomAuthoritative(room, t0 + 5 * FIXED_STEP_MS);
  assert.strictEqual(room._simulationStep, 5, "room recovers and runs the missing catch-up plus the new step");
  assert(Math.abs(room._authoritativeTimeMs - (t0 + 4 * FIXED_STEP_MS)) < EPSILON, "authoritative time recovers to the final executed step");
}

// 16. gameplayNow returns authoritative time for gameplay input handlers.
{
  const room = activeRoom("PH4AGAMEPLAYTIME");
  const t0 = 12_000_000;
  advanceRoomAuthoritative(room, t0);
  advanceRoomAuthoritative(room, t0 + FIXED_STEP_MS);
  const authNow = room._authoritativeTimeMs;
  const gameplay = gameplayNow(room, authNow + 100_000);
  assert.strictEqual(gameplay, authNow, "gameplayNow ignores far-future wall time and returns authoritative time");

  const { ship } = activeShipAndPlayer(room, "ss1");
  requestSelfDestruct(room, { id: "p1", ships: [ship] }, ["ss1"], authNow + 100_000);
  assert.strictEqual(ship.selfDestructAt, authNow + 1400, "self-destruct timer uses authoritative gameplay time, not the handler wall time");
}

console.log("Phase 4A fixed authoritative timestep verification passed");

__setFIXED_AUTHORITATIVE_TIMESTEP(false);
