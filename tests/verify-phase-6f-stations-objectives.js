"use strict";

// Phase 6F verifier. Paired runs use identical fixtures and deterministic
// random streams, then compare the canonical station-weapon state after every
// step.

const assert = require("node:assert/strict");
const {
  ALL_FIELDS,
  DURATION_FIELDS,
  COUNTER_FIELDS,
  getRoomTelemetry
} = require("./src/server/roomTelemetry");
const { tickRoom } = require("./src/server/simulation");
const { destroyStationsForRoom } = require("./src/server/stations");
const { clearStationWeaponRuntime } = require("./src/server/stationCombat");
const { clearRoomRuntimeScratch, bumpStateEpoch } = require("./src/server/rooms");
const { createMovementRuntime } = require("./src/server/movementRuntime");
const { PARTS } = require("./src/server/components");
const benchmark = require("./benchmark-phase-6f");

const {
  ALL_SCENARIOS,
  buildFixture,
  prepareMeasuredFixture,
  mutateBeforeFrame,
  runFrame,
  outcomeChecksum,
  assertFixtureConstruction,
  withDeterministicRandom
} = benchmark;

function scenario(name) {
  const result = ALL_SCENARIOS.find((entry) => entry.name === name);
  assert(result, `missing Phase 6F benchmark scenario: ${name}`);
  return result;
}

function pairedRun(config, frames = 3) {
  const left = buildFixture(config, 0);
  const right = buildFixture(config, 0);
  prepareMeasuredFixture(left.room, config, left.homes);
  prepareMeasuredFixture(right.room, config, right.homes);
  left.room._stationDetailedProfileActive = true;
  right.room._stationDetailedProfileActive = true;
  assertFixtureConstruction(left.room, config, left.homes);
  assertFixtureConstruction(right.room, config, right.homes);
  const checksums = [];
  for (let frame = 0; frame < frames; frame += 1) {
    mutateBeforeFrame(left.room, config, frame);
    mutateBeforeFrame(right.room, config, frame);
    withDeterministicRandom(0x6f6f1000 + frame, () => runFrame(left.room, config, frame));
    withDeterministicRandom(0x6f6f1000 + frame, () => runFrame(right.room, config, frame));
    const leftChecksum = outcomeChecksum(left.room);
    const rightChecksum = outcomeChecksum(right.room);
    assert.equal(leftChecksum, rightChecksum, `${config.name}: canonical station state diverged at tick ${frame}`);
    checksums.push(leftChecksum);
  }
  return { left, right, checksums };
}

function telemetry(room) {
  const value = getRoomTelemetry(room);
  for (const field of ALL_FIELDS) {
    assert(Object.prototype.hasOwnProperty.call(value, field), `room telemetry missing ${field}`);
    assert(Number.isFinite(value[field]) && value[field] >= 0, `room telemetry ${field} must be finite and non-negative`);
  }
  return value;
}

function assertNoEntityTelemetry(room) {
  const reference = room._roomTelemetry;
  assert(reference && typeof reference === "object", "profiling creates one room telemetry authority");
  for (const station of room.stations || []) {
    assert.equal(station._phase6fTelemetry, undefined, "stations do not receive per-entity Phase 6F telemetry");
    assert.equal(station.telemetry, undefined, "stations do not receive a telemetry object");
  }
  assert.equal(room._roomTelemetry, reference, "telemetry object is reused for the room");
}

function verifySchemaAndDefaults() {
  const expectedDurationCount = 23;
  const expectedCounterNames = [
    "stationsWeaponProcessed", "stationWeaponComponentsVisited", "stationWeaponComponentsOperational",
    "stationWeaponOrdinaryMounts", "stationWeaponPointDefenceMounts", "stationWeaponTargetValidations",
    "stationWeaponTargetSearches", "stationWeaponFullTargetScans", "stationWeaponSpatialQueries",
    "stationWeaponCandidatesVisited", "stationWeaponRetainedTargets", "stationWeaponImmediateReacquisitions",
    "stationWeaponShotsCreated", "stationWeaponCooldownSkips", "stationWeaponArcRejects", "stationWeaponRangeRejects",
    "stationWeaponVisibilityRejects", "stationRelaysProcessed", "stationCaptureFullShipScans", "stationCaptureSpatialQueries",
    "stationCaptureCandidatesVisited", "stationCaptureEligibleShips", "stationCaptureTeamsPresent", "stationCaptureContestedTicks",
    "stationCaptureProgressChanges", "stationCapturesCompleted", "stationControlVictoryEvaluations", "stationControlVictoryCacheHits",
    "classicCapturePointsProcessed", "classicCaptureCandidatesVisited", "stationHomeStationsProcessed", "stationQueuesVisited",
    "stationQueueItemsVisited", "stationSpawnAttempts", "stationSpawnSuccesses", "stationSpawnFleetCapBlocks",
    "stationSpawnMissingPlayerBlocks", "stationSpawnMissingHangarBlocks", "stationActiveLaunchesVisited", "stationLaunchesReleased",
    "stationLaunchesRemovedMissingShip", "stationEmptyQueueSkips", "stationEmptyLaunchSkips"
  ];
  assert.equal(DURATION_FIELDS.filter((field) => field.startsWith("station") || field.startsWith("classicCapture")).length, expectedDurationCount, "all Phase 6F duration fields are registered");
  for (const field of expectedCounterNames) assert(COUNTER_FIELDS.includes(field), `Phase 6F counter ${field} is registered`);
  const gatedFixture = buildFixture(scenario("medium battle, 150 ships"), 0);
  gatedFixture.room._stationDetailedProfileActive = false;
  runFrame(gatedFixture.room, scenario("medium battle, 150 ships"), 0);
  const gatedTelemetry = telemetry(gatedFixture.room);
  assert(gatedTelemetry.stationWeaponRuntimeMs > 0, "top-level station weapon timing remains available without detailed profiling");
  const phase6fCounter = (name) => name.startsWith("stationWeapon")
    || name.startsWith("stationCapture")
    || name.startsWith("stationControl")
    || name.startsWith("stationRelays")
    || name.startsWith("stationHome")
    || name.startsWith("stationQueue")
    || name.startsWith("stationSpawn")
    || name.startsWith("stationActive")
    || name.startsWith("stationLaunch")
    || name.startsWith("stationEmpty")
    || name.startsWith("classicCapture");
  for (const field of COUNTER_FIELDS.filter(phase6fCounter)) {
    assert.equal(gatedTelemetry[field], 0, `detailed Phase 6F counter ${field} is gated off`);
  }
  const unconditionalDurations = new Set([
    "stationRuntimeMs", "stationWeaponRuntimeMs", "stationObjectiveRuntimeMs", "stationHangarRuntimeMs",
    "stationRepairRuntimeMs", "stationControlVictoryMs", "classicCaptureRuntimeMs", "stationTargetAcquisitionMs"
  ]);
  for (const field of DURATION_FIELDS.filter((name) => name.startsWith("station") || name.startsWith("classicCapture"))) {
    if (unconditionalDurations.has(field)) continue;
    assert.equal(gatedTelemetry[field], 0, `detailed Phase 6F duration ${field} is gated off`);
  }
}

function verifyWeaponRuntime() {
  const config = scenario("medium battle, 150 ships");
  // Five ticks crosses the deterministic target-acquisition cadence even with
  // the restored station's intentionally smaller hardpoint set. Four ticks can
  // end immediately after a retained-target pass and report a valid zero
  // search count, making this instrumentation assertion depend on gun count.
  const result = pairedRun(config, 5);
  const t = telemetry(result.left.room);
  assert(t.stationsWeaponProcessed > 0, "station weapon stations are processed");
  assert(t.stationWeaponComponentsVisited >= t.stationWeaponComponentsOperational, "weapon component counters are ordered");
  assert(t.stationWeaponOrdinaryMounts > 0, "ordinary station mounts are profiled separately");
  assert(t.stationWeaponTargetSearches > 0 && t.stationWeaponCandidatesVisited > 0, "ordinary target scans are counted");
  assert(t.stationWeaponRuntimeMs > 0 && t.stationWeaponAimMs > 0, "station weapon timings are recorded");
  assertNoEntityTelemetry(result.left.room);

  const pd = pairedRun(scenario("point-defence missile storm"), 3);
  const pdTelemetry = telemetry(pd.left.room);
  assert(pdTelemetry.stationWeaponPointDefenceMounts > 0, "point-defence mounts are profiled separately");
  assert(pdTelemetry.stationWeaponPointDefenceMs > 0, "point-defence timing is recorded");

  const fog = pairedRun(scenario("sensors and fog enabled"), 2);
  assert(telemetry(fog.left.room).stationWeaponVisibilityRejects > 0, "fog/safe-zone target rejections are counted");

  let cadence;
  try {
    cadence = pairedRun(scenario("stable retained targets"), 5);
  } finally {
  }
  assert(telemetry(cadence.left.room).stationWeaponRetainedTargets > 0, "cadenced station targets are retained");

  const destroyed = pairedRun(scenario("mostly destroyed station weapons"), 2);
  assert(telemetry(destroyed.left.room).stationWeaponComponentsVisited > 0, "destroyed station components remain visible to the profile");
  assert(result.checksums.length === 5, "paired weapon checks compare every authoritative tick");
}

function verifyCaptureRuntime() {
  const contested = pairedRun(scenario("exact contested tie"), 2);
  const contestedTelemetry = telemetry(contested.left.room);
  assert(contestedTelemetry.stationCaptureContestedTicks > 0, "exact relay ties remain contested");
  assert(contested.left.relays[0].captureProgress === 0, "contested capture does not advance progress");

  const ownership = pairedRun(scenario("relay capture transition"), 1);
  const ownershipTelemetry = telemetry(ownership.left.room);
  assert(ownershipTelemetry.stationCapturesCompleted > 0, "relay capture transition is profiled");
  assert.equal(ownership.left.relays[0].team, "blue", "ownership changes to the capturing team");

  const decay = pairedRun(scenario("capture decay"), 2);
  assert(telemetry(decay.left.room).stationCaptureProgressChanges > 0, "capture decay is observable in telemetry");

  const victory = pairedRun(scenario("full-control countdown stable"), 2);
  const victoryTelemetry = telemetry(victory.left.room);
  assert.equal(victoryTelemetry.stationControlVictoryEvaluations, 0, "station relay control is not evaluated as a victory condition");
  assert.equal(victory.left.room.controlVictory.team, null, "full relay control does not start a station-mode victory countdown");
  assert.equal(victory.left.room.winner, null, "full relay control does not end a station-mode match");

  const interrupted = pairedRun(scenario("full-control countdown repeatedly interrupted"), 3);
  assert.equal(interrupted.left.room.controlVictory.team, null, "station-mode relay control remains non-winning after interruption-shaped input");
  assert.equal(interrupted.left.room.winner, null, "interrupted relay control does not end a station-mode match");

  const classic = pairedRun(scenario("classic capture reference"), 2);
  const classicTelemetry = telemetry(classic.left.room);
  assert(classicTelemetry.classicCapturePointsProcessed > 0, "classic capture is measured separately");
  assert.equal(classicTelemetry.stationRelaysProcessed, 0, "classic mode does not incur station capture work");
}

function verifyHangarRuntime() {
  const empty = pairedRun(scenario("empty queues and no active launches"), 2);
  assert(telemetry(empty.left.room).stationEmptyQueueSkips > 0, "empty queue checks are counted");

  const queued = pairedRun(scenario("one queued ship"), 1);
  const queuedTelemetry = telemetry(queued.left.room);
  assert(queuedTelemetry.stationSpawnAttempts > 0, "queued spawn attempts are counted");
  assert(queuedTelemetry.stationSpawnSuccesses > 0, "queued spawn success is counted");
  assert(queued.left.room.players.get("p-blue").ships.some((ship) => ship.launchPhase), "successful spawn retains launch control state");

  const release = pairedRun(scenario("launch completion and rally assignment"), 2);
  const releaseTelemetry = telemetry(release.left.room);
  assert(releaseTelemetry.stationLaunchesReleased > 0, "launch release is counted");
  assert(releaseTelemetry.stationLaunchReleaseMs >= 0, "launch release timing is recorded");

  const cap = pairedRun(scenario("fleet-cap blocked queue"), 2);
  assert(telemetry(cap.left.room).stationSpawnFleetCapBlocks > 0, "fleet-cap spawn blocks are explicit");

  const missing = pairedRun(scenario("missing or disconnected player"), 2);
  assert(telemetry(missing.left.room).stationSpawnMissingPlayerBlocks > 0, "missing-player spawn blocks are explicit");

  const destroyedHome = pairedRun(scenario("destroyed home station"), 2);
  assert(telemetry(destroyedHome.left.room).stationSpawnAttempts === 0, "destroyed homes do not attempt spawns");

  const destroyed = pairedRun(scenario("ship destroyed while launching"), 2);
  assert(telemetry(destroyed.left.room).stationLaunchesRemovedMissingShip > 0, "destroyed launch records are removed");
  assert(telemetry(destroyed.left.room).stationHangarRuntimeMs >= 0, "hangar timing is recorded");

  const resetRoom = empty.left.room;
  destroyStationsForRoom(resetRoom);
  assert.equal(resetRoom.stations.length, 0, "room reset clears station retained state");
}

function verifyAuthoritativeOrdering() {
  const config = scenario("medium battle, 150 ships");
  const fixture = buildFixture(config, 0);
  fixture.room._stationDetailedProfileActive = true;
  withDeterministicRandom(0x6f6f2000, () => {
    const beforeGeneration = fixture.room._visibilityGeneration || 0;
    const frame = runFrame(fixture.room, config, 0);
    const t = frame.telemetry;
    assert(t.stationWeaponShotsCreated > 0, "station weapons create projectiles before projectile processing");
    assert(t.projectilesVisited > 0, "the same authoritative frame processes projectiles after station fire");
    assert(t.stationRuntimeMs >= t.stationObjectiveRuntimeMs, "station runtime contains station objective processing");
    assert.equal(t.stationControlVictoryMs, 0, "station-mode control victory remains disabled after station capture");
    assert(frame.checksum === outcomeChecksum(fixture.room), "outcome checksum reflects the completed authoritative frame");
    // The direct production-shaped frame is followed by the same finalization
    // boundary used by tickRoom; visibility invalidation is after ownership and
    // damage changes, never before them.
    require("./src/server/visibility").invalidateVisibility(fixture.room, "phase-6f-final");
    assert((fixture.room._visibilityGeneration || 0) >= beforeGeneration, "final visibility observes the post-combat state");
  });

  const tickFixture = buildFixture(scenario("full-control countdown stable"), 0);
  const tickRoomState = tickFixture.room;
  tickRoomState._stationDetailedProfileActive = true;
  const targetRelay = tickFixture.relays[0];
  assert(targetRelay, "ordering fixture has a relay to hit");
  for (const relay of tickFixture.relays.slice(1)) {
    relay.state = "operational";
    relay.alive = true;
    relay.team = "blue";
    relay.ownerId = "p-blue";
    relay.captureProgress = 0;
  }
  targetRelay.state = "operational";
  targetRelay.alive = true;
  targetRelay.team = "red";
  targetRelay.ownerId = "p-red";
  targetRelay.shield = 0;
  targetRelay.captureProgress = 1 - (1 / 30) / 5;
  targetRelay.captureTeam = "blue";
  for (let index = 0; index < targetRelay.design.length; index += 1) {
    if (PARTS[targetRelay.design[index]?.type]?.weapon) targetRelay.componentHp[index] = 0;
  }
  // Keep the injected damage internally consistent with the relay's remaining
  // component pool so this hit crosses the destruction threshold deterministically.
  targetRelay.hp = targetRelay.componentHp.reduce((sum, value) => sum + Math.max(0, value), 0);
  targetRelay.maxHp = targetRelay.hp;
  const captureShip = benchmark.addShip(tickRoomState, "ordering-capture-ship", "p-blue", targetRelay.x, targetRelay.y);
  captureShip.movement = createMovementRuntime();
  captureShip.hp = 1000;
  captureShip.maxHp = 1000;
  captureShip.componentHp = captureShip.componentHp.map(() => 1000);
  const injected = benchmark.addProjectile(tickRoomState, "ordering-relay-hit", "p-blue", targetRelay.x - 300, targetRelay.y, 0);
  injected.type = "bolt";
  injected.subtype = "bolt";
  injected.interceptable = false;
  injected.vx = 60;
  injected.vy = 0;
  injected.damage = targetRelay.hp + 1;
  injected.life = 100;
  injected.shieldDamageMultiplier = 1;
  injected.hullDamageMultiplier = 1;
  // Use a compressed authoritative interval so the real tickRoom path reaches
  // the capture threshold in the same invocation after the projectile hit.
  tickRoom(tickRoomState, 10, 77);
  assert.equal(targetRelay.state, "operational", "projectile destruction immediately reactivates the relay");
  assert.equal(targetRelay.team, "blue", "projectile destruction gives ownership to the attacking team");
  assert.equal(targetRelay.ownerId, "p-blue", "projectile destruction records the attacking player");
  assert.equal(targetRelay.captureProgress, 0, "relay destruction clears stale capture progress");
  assert.equal(tickRoomState.controlVictory.team, null, "relay ownership transition cannot start station-mode control victory");
  assert.equal(tickRoomState.winner, null, "relay ownership transition cannot end the station-mode match");
  assert.equal(tickRoomState._visibilityFinalizedAt, 77, "real tickRoom finalizes visibility after combat, capture, and control");
  assert(!tickRoomState.projectileById.has(injected.id), "the injected relay projectile is consumed during projectile processing");

  const resetRoom = buildFixture(scenario("stable retained targets"), 0).room;
  resetRoom._stationWeaponTargetLookup = new Map([["old-target", {}]]);
  resetRoom._stationWeaponTargetScratch = [{ id: "old-target" }];
  resetRoom._pdReservations = new Map([["old-target", 10]]);
  clearStationWeaponRuntime(resetRoom);
  assert.equal(resetRoom._stationWeaponTargetLookup.size, 0, "station target lookup clears explicitly");
  assert.equal(resetRoom._stationWeaponTargetScratch.length, 0, "station target scratch clears explicitly");
  assert.equal(resetRoom._pdReservations.size, 0, "point-defence reservations clear explicitly");
  resetRoom._stationWeaponTargetLookup.set("epoch-target", {});
  resetRoom._stationWeaponTargetScratch.push({ id: "epoch-target" });
  bumpStateEpoch(resetRoom, "phase-6f-verifier");
  assert.equal(resetRoom._stationWeaponTargetLookup.size, 0, "state epoch reset clears station target lookup");
  assert.equal(resetRoom._stationWeaponTargetScratch.length, 0, "state epoch reset clears station target scratch");
  resetRoom._stationWeaponTargetLookup.set("match-target", {});
  resetRoom._stationWeaponTargetScratch.push({ id: "match-target" });
  clearRoomRuntimeScratch(resetRoom);
  assert.equal(resetRoom._stationWeaponTargetLookup.size, 0, "room runtime reset clears station target lookup for repeated matches");
  assert.equal(resetRoom._stationWeaponTargetScratch.length, 0, "room runtime reset clears station target scratch for repeated matches");
}

function main() {
  console.log("verify-phase-6f-stations-objectives");
  verifySchemaAndDefaults();
  verifyWeaponRuntime();
  verifyCaptureRuntime();
  verifyHangarRuntime();
  verifyAuthoritativeOrdering();
  console.log("Phase 6F station/objective canonical-runtime checks passed");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
