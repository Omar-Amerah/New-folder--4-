"use strict";

// Per-room reusable tick telemetry. All counters are plain numbers on a single
// room-scoped object that is reset deterministically at the start of every tick.
// No per-entity, per-candidate or per-projectile allocations are made for
// telemetry; callers bump counters and record stage durations using the helpers
// below.

const { performanceNow } = require("./utils");

const DURATION_FIELDS = Object.freeze([
  "movementControllerMs",
  "movementMapCollisionMs",
  "shieldRuntimeMs",
  "projectileIntegrationMs",
  "missileGuidanceMs",
  "projectileMapQueryMs",
  "projectileShipBroadPhaseMs",
  "projectileShipNarrowPhaseMs",
  "projectileStationCollisionMs",
  "projectileDroneCollisionMs",
  "projectileDroneBroadPhaseMs",
  "projectileDroneNarrowPhaseMs",
  "projectileDroneRecoveryMs",
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

  // Phase 6A authoritative Heat runtime timing
  "heatRuntimeMs",
  "heatStableCheckMs",
  "heatGenerationMs",
  "heatTransferMs",
  "heatCoolingMs",
  "heatFinalizationMs",

  // Phase 6B authoritative drone runtime timing
  "droneRuntimeMs",
  "droneBayFrameStateMs",
  "droneDecisionMs",
  "droneContextBuildMs",
  "droneTargetValidationMs",
  "droneTargetScoringMs",
  "droneEvasionMs",
  "droneMovementMs",
  "droneMapCollisionMs",
  "droneSeparationMs",
  "droneSpatialPublicationMs",

  // Phase 6C incremental visibility runtime timing
  "visibilityRuntimeMs",
  "visibilitySourceMaintenanceMs",
  "visibilityCapabilityRefreshMs",
  "visibilityCoverageUpdateMs",
  "visibilityShipQueriesMs",
  "visibilityDroneQueriesMs",
  "visibilityStationQueriesMs",
  "visibilityRememberedMs",
  "visibilitySnapshotFilterMs",
  "visibilityAuditMs",

  // Phase 6D incremental Command Aura runtime timing
  "commandAuraRuntimeMs",
  "commandAuraSourceMaintenanceMs",
  "commandAuraMembershipMs",
  "commandAuraWinnerResolutionMs",
  "commandAuraRecipientPublishMs",
  "commandAuraReconciliationMs",
  "commandAuraFallbackMs",
  // Phase 6F station/objective profiling. These fields are room-scoped so
  // instrumentation never needs to attach a telemetry object to a station,
  // weapon, ship candidate or queue item.
  "stationRuntimeMs",
  "stationWeaponRuntimeMs",
  "stationObjectiveRuntimeMs",
  "stationHangarRuntimeMs",
  "stationRepairRuntimeMs",
  "stationControlVictoryMs",
  "classicCaptureRuntimeMs",
  "stationWeaponTargetPreparationMs",
  "stationWeaponProfileLookupMs",
  "stationWeaponValidationMs",
  "stationWeaponOrdinaryAcquisitionMs",
  "stationWeaponPointDefenceMs",
  "stationWeaponAimMs",
  "stationWeaponFireMs",
  "stationCaptureCandidateCollectionMs",
  "stationCaptureAggregationMs",
  "stationCaptureStateTransitionMs",
  "stationProductionQueueMs",
  "stationSpawnAttemptMs",
  "stationLaunchControlMs",
  "stationLaunchReleaseMs",
  "stationCorridorQueryMs"
]);

const COUNTER_FIELDS = Object.freeze([
  // Ship separation counters
  "liveShips",
  "separationIterations",
  "separationPairsExamined",
  "separationBroadPhaseRejected",
  "separationNarrowPhaseChecks",
  "separationSweptPhaseChecks",
  "separationOverlapsResolved",
  "separationSweptContactsResolved",
  "separationMapCollisionCalls",
  "staticCollisionCalls",
  "staticCollisionHits",
  "staticCollisionCorrectionDistance",

  // Shared movement contact-pair telemetry
  "movementContactPairBuilds",
  "movementContactPairsGenerated",
  "movementContactPairDuplicatesRejected",
  "movementContactPairCandidatesVisited",
  "movementContactPairMaxPerStep",

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
  "pointDefenceThreatSetHits",
  "pointDefenceThreatSetMisses",
  "pointDefenceCandidatesRevalidated",
  "pointDefenceCandidatesRejectedStale",
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

  // Phase 6A authoritative Heat runtime counters
  "heatShipsConsidered",
  "heatShipsSolved",
  "heatShipsStableSkipped",
  "heatShipWakeups",
  "heatShipSleeps",
  "heatComponentsTotal",
  "heatComponentsVisited",
  "heatBearingComponents",
  "heatHotComponents",
  "heatPendingInputComponents",
  "heatLoadedGeneratorComponents",
  "heatEdgesTotal",
  "heatEdgesVisited",
  "heatTransfersApplied",
  "heatTopologyBuilds",
  "heatTopologyCacheHits",
  "heatTopologySharedShips",

  // Phase 6B authoritative drone runtime counters
  "dronesVisited",
  "dronePhysicalUpdates",
  "droneDecisionsRun",
  "droneDecisionsDeferred",
  "droneImmediateDecisions",
  "droneValidTargetsRetained",
  "droneTargetsInvalidated",
  "droneTargetReferenceHits",
  "droneTargetReferenceMisses",
  "droneContextsBuilt",
  "droneContextHits",
  "droneContextFallbacks",
  "droneContextMembers",
  "droneContextShipQueries",
  "droneContextDroneQueries",
  "droneContextProjectileQueries",
  "droneShipCandidatesVisited",
  "droneDroneCandidatesVisited",
  "droneProjectileCandidatesVisited",
  "droneRepairCandidatesVisited",
  "droneContextCandidateCount",
  "droneContextIndividualCandidateEstimate",
  "droneContextCandidatesAvoided",
  "droneContextIndividualQueriesAvoided",
  "droneBayFrameBuilds",
  "droneBayFrameHits",
  "projectileDroneQueries",
  "projectileDroneCandidates",
  "projectileDroneHits",
  "projectileDroneIndexRecoveryBuilds",
  "projectileDroneFullScanFallbacks",

  // Phase 6C incremental visibility runtime counters
  "visibilityTeamsConsidered",
  "visibilityTeamsComputed",
  "visibilityTeamCacheHits",
  "visibilityTeamsDirty",
  "visibilitySourcesTotal",
  "visibilitySourcesAdded",
  "visibilitySourcesRemoved",
  "visibilitySourcesUpdated",
  "visibilitySourceCacheHits",
  "visibilityCapabilityCacheHits",
  "visibilityTransformOnlyUpdates",
  "visibilityShipQueries",
  "visibilityDroneQueries",
  "visibilityStationQueries",
  "visibilityShipCandidates",
  "visibilityDroneCandidates",
  "visibilityStationCandidates",
  "visibilityCandidatesAlreadyVisible",
  "visibilityEntitiesDetected",
  "visibilityEntitiesLost",
  "visibilityContactsRemembered",
  "visibilityContactsExpired",
  "visibilityLingeredEntities",
  "visibilitySnapshotFilterBuilds",
  "visibilitySnapshotFilterCacheHits",
  "visibilitySnapshotShipsConsidered",
  "visibilitySnapshotDronesConsidered",
  "visibilitySnapshotBulletsConsidered",
  "visibilitySnapshotEffectsConsidered",
  "visibilityFullCollectionFallbacks",
  "visibilityFullInvalidations",
  "visibilityTeamScopedInvalidations",
  "visibilityGenerationAdvances",
  "visibilityInvalidations",
  "visibilityDuplicateInvalidations",
  "visibilityComputesAfterFinalization",
  "visibilityReconciliations",

  // Phase 6D incremental Command Aura runtime counters
  "commandAuraShipsConsidered",
  "commandAuraActiveSourceShips",
  "commandAuraActiveComponents",
  "commandAuraSourceCacheHits",
  "commandAuraSourceRebuilds",
  "commandAuraSourceActivations",
  "commandAuraSourceDeactivations",
  "commandAuraMembershipQueries",
  "commandAuraRecipientMembershipQueries",
  "commandAuraMembershipCacheHits",
  "commandAuraMembershipAdds",
  "commandAuraMembershipRemoves",
  "commandAuraCandidatesVisited",
  "commandAuraRecipientMovesProcessed",
  "commandAuraSourceMovesProcessed",
  "commandAuraRecipientsDirty",
  "commandAuraRecipientsPublished",
  "commandAuraRecipientsUnchanged",
  "commandAuraWinnerChanges",
  "commandAuraWinnerRescans",
  "commandAuraPriorityComparisons",
  "commandAuraFullScanFallbacks",
  "commandAuraReconciliations",
  "commandAuraReconciliationRepairs",
  "commandAuraStaleSourcesRemoved",
  "commandAuraStaleRecipientsRemoved",
  // Phase 6F station weapons.
  "stationsWeaponProcessed",
  "stationWeaponComponentsVisited",
  "stationWeaponComponentsOperational",
  "stationWeaponOrdinaryMounts",
  "stationWeaponPointDefenceMounts",
  "stationWeaponTargetValidations",
  "stationWeaponTargetSearches",
  "stationWeaponFullTargetScans",
  "stationWeaponSpatialQueries",
  "stationWeaponCandidatesVisited",
  "stationWeaponRetainedTargets",
  "stationWeaponImmediateReacquisitions",
  "stationWeaponShotsCreated",
  "stationWeaponCooldownSkips",
  "stationWeaponArcRejects",
  "stationWeaponRangeRejects",
  "stationWeaponVisibilityRejects",

  // Phase 6F station capture/objectives.
  "stationRelaysProcessed",
  "stationCaptureFullShipScans",
  "stationCaptureSpatialQueries",
  "stationCaptureCandidatesVisited",
  "stationCaptureEligibleShips",
  "stationCaptureTeamsPresent",
  "stationCaptureContestedTicks",
  "stationCaptureProgressChanges",
  "stationCapturesCompleted",
  "stationControlVictoryEvaluations",
  "stationControlVictoryCacheHits",
  "classicCapturePointsProcessed",
  "classicCaptureCandidatesVisited",

  // Phase 6F hangar/production.
  "stationHomeStationsProcessed",
  "stationQueuesVisited",
  "stationQueueItemsVisited",
  "stationSpawnAttempts",
  "stationSpawnSuccesses",
  "stationSpawnFleetCapBlocks",
  "stationSpawnMissingPlayerBlocks",
  "stationSpawnMissingHangarBlocks",
  "stationSpawnOccupiedHangarBlocks",
  "stationActiveLaunchesVisited",
  "stationLaunchesReleased",
  "stationLaunchesRemovedMissingShip",
  "stationEmptyQueueSkips",
  "stationEmptyLaunchSkips",

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

// Detailed Phase 6F counters and substage clocks are opt-in. Top-level runtime
// durations remain unconditional, while callers use this single room flag to
// keep candidate-level diagnostics out of the normal simulation hot path.
function detailedProfileActive(room) {
  return room?._stationDetailedProfileActive === true;
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
  detailedProfileActive,
  setCounter,
  getRoomTelemetry,
  telemetryDiagnostics
};
