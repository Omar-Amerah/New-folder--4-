"use strict";

// Per-room reusable tick telemetry. All counters are plain numbers on a single
// room-scoped object that is reset deterministically at the start of every tick.
// No per-entity, per-candidate or per-projectile allocations are made for
// telemetry; callers bump counters and record stage durations using the helpers
// below.

const { performanceNow } = require("./utils");

const DURATION_FIELDS = Object.freeze([
  "movementControllerMs",
  "movementContactPairBuildMs",
  "shipSeparationMs",
  "separationNarrowPhaseMs",
  "separationMapCollisionMs",
  "separationSpatialRebuildMs",
  "movementMapCollisionMs",
  "shieldRuntimeMs",
  "projectileIntegrationMs",
  "missileGuidanceMs",
  "projectileMapQueryMs",
  "projectileShipBroadPhaseMs",
  "projectileShipNarrowPhaseMs",
  "projectileStationCollisionMs",
  "projectileDroneCollisionMs",
  "projectileInterceptionMs",
  "flakEventSelectionMs",
  "flakExplosionMs",
  "projectileCleanupMs",
  "projectileSnapshotConstructionMs",
  "projectileSnapshotEncodingMs",

  // Phase Three targeting sampled timing
  "ordinaryTargetAcquisitionMs",
  "pointDefenceThreatSetMs",
  "pointDefenceMountSelectionMs",
  "stationTargetAcquisitionMs",
  "effectiveWeaponProfileMs",
  "targetLineOfSightMs",
  "targetVisibilityMs",
  "weaponAimMs",
  "weaponFiringMs",
  "beamProcessingMs",
  // Retained for compatibility with early Phase Three diagnostics.
  "weaponAimFiringMs",

  // Phase Four authoritative fixed-timestep telemetry
  "fixedStepJitterMs",
  "fixedStepDurationMs",
  "fixedStepDiscardedBacklogMs",
  "fixedStepAccumulatorRemainingMs",
  "packedFleetSolverMs"
]);

const COUNTER_FIELDS = Object.freeze([
  // Ship separation counters
  "liveShips",
  "separationIterations",
  "separationQueries",
  "separationCandidatesReturned",
  "separationPairsExamined",
  "separationBroadPhaseRejected",
  "separationNarrowPhaseChecks",
  "separationOverlapsResolved",
  "separationUnresolvedPairs",
  "separationShipIndexRebuilds",
  "separationMapCollisionCalls",

  // Phase 4C shared movement contact-pair telemetry
  "movementContactPairBuilds",
  "movementContactPairsGenerated",
  "movementContactPairDuplicatesRejected",
  "movementContactPairCandidatesVisited",
  "movementContactPairMaxPerStep",
  "movementContactPairRecoveryBuilds",
  "movementContactPairMissDetections",
  "movementLegacySeparationQueriesAvoided",

  // Phase 4D packed-fleet solver telemetry
  "packedFleetSolverSteps",
  "packedFleetIslands",
  "packedFleetLargestIsland",
  "packedFleetIterations",
  "packedFleetEarlyExits",
  "packedFleetPairsChecked",
  "packedFleetOverlapsResolved",
  "packedFleetRemainingOverlaps",
  "packedFleetMaximumPenetration",
  "packedFleetCorrectionApplications",
  "packedFleetRecoveryOperations",
  "packedFleetLegacyIterationsAvoided",

  // Projectile counters
  "liveProjectiles",
  "projectileSpatialQueries",
  "projectileCandidateShips",
  "projectileCandidateDrones",
  "projectileCandidateStations",
  "projectileCandidateAsteroids",
  "projectileComponentCellTests",
  "missileGuidanceUpdates",

  // Shield counters
  "shieldRuntimeUpdates",
  "shieldDerivedStatCalculations",
  "shieldDerivedStatCacheHits",
  "shieldDerivedStatCacheMisses",
  "shieldDerivedStatVerificationFailures",

  // Phase Two projectile counters and durations
  "projectilesVisited",
  "ballisticProjectilesVisited",
  "missilesVisited",
  "flakProjectilesVisited",
  "pointDefenceProjectilesVisited",
  "missileGuidanceDeferred",
  "asteroidQueries",
  "shipQueries",
  "stationQueries",
  "droneQueries",
  "interceptableProjectileQueries",
  "candidateShipsReturned",
  "candidateStationsReturned",
  "candidateDronesReturned",
  "candidateProjectilesReturned",
  "hullBroadPhaseHits",
  "shieldBubbleTests",
  "componentCellsTested",
  "componentGridCellsVisited",
  "componentGridOccupiedCells",
  "flakCandidatesTested",
  "flakEventsCompared",
  "flakSortOperations",
  "projectilesCreated",
  "projectilesRemoved",
  "projectileSpawnMessages",
  "projectileRemoveMessages",
  "projectileCorrectionMessages",
  "projectileFullBaselineEntries",
  "projectileCompactEntries",

  // Phase Three targeting telemetry counters
  "ordinaryTargetValidationAttempts",
  "ordinaryTargetValidationFailures",
  "ordinaryTargetSearches",
  "ordinaryTargetSearchCandidates",
  "ordinaryTargetSearchCacheHits",
  "ordinaryTargetSearchDeferred",
  "ordinaryTargetImmediateReacquisitions",
  "shipCombatTargetSearches",
  "shipCombatTargetCacheHits",
  "shipCombatTargetSearchDeferred",
  "shipCombatTargetInvalidations",
  "pointDefenceTargetSearches",
  "pointDefenceTargetSearchDeferred",
  "pointDefenceImmediateReacquisitions",
  "pointDefenceThreatSetBuilds",
  "pointDefenceThreatSetReuses",
  "pointDefenceThreatCandidates",
  "pointDefenceMountSelections",
  "pointDefenceSharedSetHits",
  "pointDefenceSharedSetMisses",
  "pointDefenceCandidatesRevalidated",
  "pointDefenceCandidatesRejectedStale",
  "pointDefenceLegacyScansAvoided",
  "pointDefenceSharedFallbacks",
  "pointDefenceSharedFallbackNoDefender",
  "stationTargetValidationAttempts",
  "stationTargetSearches",
  "stationTargetCandidates",
  "stationTargetSearchDeferred",
  "targetVisibilityChecks",
  "targetRelationshipChecks",
  "targetRangeChecks",
  "targetArcChecks",
  "targetTieBreaks",
  "targetInvalidations",
  "effectiveWeaponProfileBuilds",
  "effectiveWeaponProfileCacheHits",
  "effectiveWeaponProfileCacheMisses",
  "effectiveWeaponProfileInvalidations",

  // Phase Four fixed-timestep counters
  "fixedStepCallbacks",
  "fixedSteps",
  "fixedStepCatchUpCallbacks",
  "fixedStepMaxCatchUp",
  "fixedStepReentryAttempts",

  // Phase 4B incremental spatial-index counters
  "spatialFullRebuilds",
  "spatialPartialRebuilds",
  "spatialRecoveryRebuilds",
  "spatialIncrementalInserts",
  "spatialIncrementalUpdates",
  "spatialNoOpUpdates",
  "spatialCellMembershipChanges",
  "spatialRemovals",
  "spatialCategoryChanges",
  "spatialStaleDetections",
  "spatialUpdateDurationMs"
]);

const ALL_FIELDS = Object.freeze([...DURATION_FIELDS, ...COUNTER_FIELDS]);

function ensureTelemetry(room) {
  if (room?._roomTelemetry) return room._roomTelemetry;
  if (!room) return {};
  const telemetry = {};
  for (const field of ALL_FIELDS) telemetry[field] = 0;
  room._roomTelemetry = telemetry;
  return telemetry;
}

function resetRoomTelemetry(room) {
  const telemetry = ensureTelemetry(room);
  for (const field of ALL_FIELDS) telemetry[field] = 0;
  return telemetry;
}

function bump(room, name, amount = 1) {
  if (!room) return 0;
  const telemetry = ensureTelemetry(room);
  if (!(name in telemetry)) return 0;
  const delta = Number(amount) || 0;
  telemetry[name] = Math.max(0, telemetry[name] + delta);
  return telemetry[name];
}

function recordDuration(room, name, startMs) {
  if (!room || !Number.isFinite(startMs)) return 0;
  const telemetry = ensureTelemetry(room);
  if (!(name in telemetry)) return 0;
  const elapsed = Math.max(0, performanceNow() - startMs);
  telemetry[name] = Math.max(0, telemetry[name] + elapsed);
  return elapsed;
}

function setCounter(room, name, value) {
  if (!room) return 0;
  const telemetry = ensureTelemetry(room);
  if (!(name in telemetry)) return 0;
  const n = Number(value) || 0;
  telemetry[name] = Math.max(0, n);
  return telemetry[name];
}

function getRoomTelemetry(room) {
  const telemetry = ensureTelemetry(room);
  return Object.fromEntries(ALL_FIELDS.map((field) => [field, telemetry[field]]));
}

function telemetryDiagnostics(room) {
  if (!room) return Object.fromEntries(ALL_FIELDS.map((field) => [field, 0]));
  return getRoomTelemetry(room);
}

module.exports = {
  ALL_FIELDS,
  DURATION_FIELDS,
  COUNTER_FIELDS,
  ensureTelemetry,
  resetRoomTelemetry,
  bump,
  recordDuration,
  setCounter,
  getRoomTelemetry,
  telemetryDiagnostics
};
