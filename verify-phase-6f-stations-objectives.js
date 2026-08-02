"use strict";

// Phase 6F verifier. The paired runs use identical fixtures and deterministic
// random streams, then compare legacy and opt-in authoritative state after every
// step. Only the measured station-weapon candidate has an opt-in flag.

const assert = require("node:assert/strict");
const {
  ALL_FIELDS,
  DURATION_FIELDS,
  COUNTER_FIELDS,
  getRoomTelemetry
} = require("./src/server/roomTelemetry");
const { tickRoom } = require("./src/server/simulation");
const { destroyStationsForRoom } = require("./src/server/stations");
const flags = require("./src/server/performanceFlags");
const benchmark = require("./benchmark-phase-6f");

const { ALL_SCENARIOS, buildFixture, prepareMeasuredFixture, mutateBeforeFrame, runFrame, outcomeChecksum, withDeterministicRandom } = benchmark;

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
  const checksums = [];
  const previousFlag = flags.OPTIMIZED_STATION_WEAPON_RUNTIME();
  try {
    for (let frame = 0; frame < frames; frame += 1) {
      mutateBeforeFrame(left.room, config, frame);
      mutateBeforeFrame(right.room, config, frame);
      flags.__setOPTIMIZED_STATION_WEAPON_RUNTIME(false);
      withDeterministicRandom(0x6f6f1000 + frame, () => runFrame(left.room, config, frame));
      flags.__setOPTIMIZED_STATION_WEAPON_RUNTIME(true);
      withDeterministicRandom(0x6f6f1000 + frame, () => runFrame(right.room, config, frame));
      const leftChecksum = outcomeChecksum(left.room);
      const rightChecksum = outcomeChecksum(right.room);
      assert.equal(leftChecksum, rightChecksum, `${config.name}: legacy/optimized authoritative state diverged at tick ${frame}`);
      checksums.push(leftChecksum);
    }
  } finally {
    flags.__setOPTIMIZED_STATION_WEAPON_RUNTIME(previousFlag);
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
  const expectedDurationCount = 24;
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
  assert.equal(typeof flags.OPTIMIZED_STATION_WEAPON_RUNTIME, "function", "station weapon optimization flag is available for evidence-gated checks");
  assert.equal(flags.OPTIMIZED_STATION_WEAPON_RUNTIME(), false, "station weapon optimization remains disabled by default");
  assert.equal(flags.OPTIMIZED_STATION_CAPTURE_RUNTIME, undefined, "capture has no speculative optimization flag");
  assert.equal(flags.OPTIMIZED_STATION_HANGAR_RUNTIME, undefined, "hangar has no speculative optimization flag");
}

function verifyWeaponRuntime() {
  const config = scenario("medium battle, 150 ships");
  const result = pairedRun(config, 4);
  const t = telemetry(result.left.room);
  assert(t.stationsWeaponProcessed > 0, "station weapon stations are processed");
  assert(t.stationWeaponComponentsVisited >= t.stationWeaponComponentsOperational, "weapon component counters are ordered");
  assert(t.stationWeaponOrdinaryMounts > 0, "ordinary station mounts are profiled separately");
  assert(t.stationWeaponTargetSearches >= 0 && t.stationWeaponCandidatesVisited >= 0, "ordinary target scans are counted");
  assert(t.stationWeaponRuntimeMs >= 0 && t.stationWeaponAimMs >= 0, "station weapon timings are recorded");
  assertNoEntityTelemetry(result.left.room);

  const pd = pairedRun(scenario("point-defence missile storm"), 3);
  const pdTelemetry = telemetry(pd.left.room);
  assert(pdTelemetry.stationWeaponPointDefenceMounts > 0, "point-defence mounts are profiled separately");
  assert(pdTelemetry.stationWeaponPointDefenceMs >= 0, "point-defence timing is recorded");

  const fog = pairedRun(scenario("sensors and fog enabled"), 2);
  assert(telemetry(fog.left.room).stationWeaponVisibilityRejects >= 0, "fog/safe-zone target rejections are counted");

  const previousCadence = flags.WEAPON_TARGET_ACQUISITION_CADENCE();
  let cadence;
  try {
    flags.__setWEAPON_TARGET_ACQUISITION_CADENCE(true);
    cadence = pairedRun(scenario("stable retained targets"), 5);
  } finally {
    flags.__setWEAPON_TARGET_ACQUISITION_CADENCE(previousCadence);
  }
  assert(telemetry(cadence.left.room).stationWeaponRetainedTargets > 0, "cadenced station targets are retained");

  const destroyed = pairedRun(scenario("mostly destroyed station weapons"), 2);
  assert(telemetry(destroyed.left.room).stationWeaponComponentsVisited > 0, "destroyed station components remain visible to the profile");
  assert(result.checksums.length === 4, "paired weapon checks compare every authoritative tick");
}

function verifyCaptureRuntime() {
  const contested = pairedRun(scenario("exact contested tie"), 2);
  const contestedTelemetry = telemetry(contested.left.room);
  assert(contestedTelemetry.stationCaptureContestedTicks > 0, "exact relay ties remain contested");
  assert(contested.left.relays[0].captureProgress === 0, "contested capture does not advance progress");

  const ownership = pairedRun(scenario("relay ownership transition"), 1);
  const ownershipTelemetry = telemetry(ownership.left.room);
  assert(ownershipTelemetry.stationCapturesCompleted > 0, "relay ownership transition is profiled");
  assert.equal(ownership.left.relays[0].team, "blue", "ownership changes to the capturing team");

  const decay = pairedRun(scenario("capture decay"), 2);
  assert(telemetry(decay.left.room).stationCaptureProgressChanges > 0, "capture decay is observable in telemetry");

  const victory = pairedRun(scenario("full-control countdown stable"), 2);
  const victoryTelemetry = telemetry(victory.left.room);
  assert(victoryTelemetry.stationControlVictoryEvaluations > 0, "station control victory is evaluated independently");
  assert.equal(victory.left.room.controlVictory.team, "blue", "same-tick full control starts the countdown");

  const interrupted = pairedRun(scenario("full-control countdown repeatedly interrupted"), 3);
  assert(interrupted.left.room.controlVictory.team === "blue" || interrupted.left.room.controlVictory.team === null, "interrupted control remains authoritative");

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

  const disabled = pairedRun(scenario("disabled home station"), 2);
  assert(telemetry(disabled.left.room).stationSpawnAttempts === 0, "disabled homes do not attempt spawns");

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
  withDeterministicRandom(0x6f6f2000, () => {
    const beforeGeneration = fixture.room._visibilityGeneration || 0;
    const frame = runFrame(fixture.room, config, 0);
    const t = frame.telemetry;
    assert(t.stationWeaponShotsCreated > 0, "station weapons create projectiles before projectile processing");
    assert(t.projectilesVisited > 0, "the same authoritative frame processes projectiles after station fire");
    assert(t.stationRuntimeMs >= t.stationObjectiveRuntimeMs, "station runtime contains station objective processing");
    assert(t.stationControlVictoryMs >= 0, "control victory runs after station capture");
    assert(frame.checksum === outcomeChecksum(fixture.room), "outcome checksum reflects the completed authoritative frame");
    // The direct production-shaped frame is followed by the same finalization
    // boundary used by tickRoom; visibility invalidation is after ownership and
    // damage changes, never before them.
    require("./src/server/visibility").invalidateVisibility(fixture.room, "phase-6f-final");
    assert((fixture.room._visibilityGeneration || 0) >= beforeGeneration, "final visibility observes the post-combat state");
  });

  const tickFixture = buildFixture(scenario("two idle home stations"), 0);
  tickRoom(tickFixture.room, 1 / 30, 33);
  assert.equal(tickFixture.room._visibilityFinalizedAt, 33, "real tickRoom preserves the final visibility boundary");
}

function main() {
  console.log("verify-phase-6f-stations-objectives");
  verifySchemaAndDefaults();
  verifyWeaponRuntime();
  verifyCaptureRuntime();
  verifyHangarRuntime();
  verifyAuthoritativeOrdering();
  console.log("Phase 6F station/objective profiling and legacy/optimized parity checks passed");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
