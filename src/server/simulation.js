"use strict";
const { updateBots, getLiveShips } = require("./ships");
const { updateEconomy } = require("./economy");
const { updateDestroyedShips, updateShipSupport, updateShipWeapons, updateSelfDestructingShips, updateProximityCharges } = require("./combat");
const { updateShipMovement, updateShipSeparation, resolveFleetMapCollisions, resolveMapCollision } = require("./movement");
const { updateBullets } = require("./projectiles");
const { updateStations } = require("./stations");
const { updateCapturePoints, updateControlVictory } = require("./objectives");
const { updateShipHeat } = require("./heat");
const { updateShipPowerDemand } = require("./componentPower");
const { updateShipPowerProtection } = require("./powerProtection");
const { assertComponentHpConsistency, isComponentAssertionEnabled } = require("./componentHealth");
const { updateDroneBays } = require("./drones");
const { updateDecoyLaunchers } = require("./decoys");
const { buildRoomSpatialIndex, shipBroadPhaseRadius } = require("./spatialIndex");
const { updateStationWeapons } = require("./stationCombat");
const { updateCommandAuras } = require("./commandAuras");
const { updateRuntimeShield } = require("./runtimeShield");
const { recordRoomTick, recordRoomTelemetry } = require("./performanceTelemetry");
const { resetRoomTelemetry, bump, setCounter, recordDuration } = require("./roomTelemetry");
const { performanceNow } = require("./utils");
const { WIRING_ENABLED } = require("../../public/src/shared/featureFlags");
const { redundantFleetMapCollisionPass, FIXED_AUTHORITATIVE_TIMESTEP } = require("./performanceFlags");
const { TICK_HZ } = require("./config");
const { invalidateVisibility } = require("./visibility");
const { dropHiddenTargetLocksForShips } = require("./targetLocks");

function tickRoom(room, dt, now) {
  if (room.phase !== "active") {
    const source = room.effects || [];
    if (source.length === 0) {
      if (room._effectSpare?.length) room._effectSpare.length = 0;
      return;
    }
    const kept = room._effectSpare && room._effectSpare !== source ? room._effectSpare : [];
    kept.length = 0;
    for (const effect of source) if (now - effect.at < 900) kept.push(effect);
    source.length = 0;
    room.effects = kept;
    room._effectSpare = source;
    return;
  }
  // The instant this tick's state is stamped with. Snapshots must publish THIS,
  // not the moment they happen to be broadcast: the two run on independent
  // timers, so a snapshot carries state that is anywhere from zero to a full
  // tick old. Labelling it with the broadcast time tells the client the ship
  // travelled a uniform snapshot interval when it really travelled one tick more
  // or less -- and the client, interpolating between those stamps, renders the
  // ship surging and stalling. Measured at 30 Hz ticks against 20 Hz snapshots:
  // a hull holding a true 510 px/s was rendered swinging between 340 and 680.
  room.simulationTimeMs = now;
  // Reset the per-room telemetry record deterministically at the start of the tick.
  resetRoomTelemetry(room);
  // Telemetry consumes these synchronously, so one mutable record per room can
  // be reused instead of allocating a fresh timing object every simulation tick.
  const durations = room._tickDurations || (room._tickDurations = {});
  let startedAt = performanceNow();
  updateBots(room, now); updateEconomy(room, dt); updateSelfDestructingShips(room, now); updateDestroyedShips(room, now);
  durations.botsEconomyLifecycle = performanceNow() - startedAt;
  const ships = getLiveShips(room, room._liveShipScratch || (room._liveShipScratch = []));
  setCounter(room, "liveShips", ships.length);
  // Section 7D-2: refresh activity-driven Power demand once per ship, before any
  // gameplay system consumes this cycle's operational multipliers / section flow.
  startedAt = performanceNow();
  if (WIRING_ENABLED) for (const ship of ships) updateShipPowerDemand(ship, room, now);
  // Section 7G: runtime Power overload protection reads the freshly solved
  // section flows; only trip/retry connectivity transitions re-solve Power.
  if (WIRING_ENABLED) for (const ship of ships) updateShipPowerProtection(ship, dt);
  durations.powerDemandProtection = performanceNow() - startedAt;
  // Build spatial index before movement and drone updates to ensure static asteroid data is available
  startedAt = performanceNow();
  buildRoomSpatialIndex(room, ships, now);
  durations.spatialIndex = performanceNow() - startedAt;
  // Command auras are authoritative and rely on the spatial index; update before
  // any gameplay system consumes the per-ship aura multipliers this tick.
  startedAt = performanceNow();
  updateCommandAuras(room, ships, now);
  durations.commandAuras = performanceNow() - startedAt;
  // Shield is an explicit runtime stage. It consumes the authoritative
  // Power/Heat/aura state and is independent of movement substeps.
  startedAt = performanceNow();
  for (const ship of ships) updateRuntimeShield(ship, dt, now, room);
  recordDuration(room, "shieldRuntimeMs", startedAt);
  setCounter(room, "shieldRuntimeUpdates", ships.length);
  durations.shields = performanceNow() - startedAt;
  startedAt = performanceNow();
  let movementStart = performanceNow();
  for (const ship of ships) updateShipMovement(room, ship, dt, now);
  recordDuration(room, "movementControllerMs", movementStart);
  // After movement, refresh only ship records. Drones and projectiles are
  // updated by their own systems before consumers that need their positions.
  if (room.spatialIndex && typeof room.spatialIndex.rebuildKind === "function") {
    room.spatialIndex.rebuildKind("ships", ships, shipBroadPhaseRadius, now);
  } else {
    buildRoomSpatialIndex(room, ships, now);
  }
  const modifiedShipIds = updateShipSeparation(room, ships, dt, now);
  const mapCollisionStart = performanceNow();
  if (redundantFleetMapCollisionPass()) {
    resolveFleetMapCollisions(room, ships);
  } else {
    for (const id of modifiedShipIds) {
      const ship = room.ships.get(id);
      if (ship) resolveMapCollision(room, ship);
    }
  }
  recordDuration(room, "movementMapCollisionMs", mapCollisionStart);
  // Separation and map recovery mutate positions after the pre-collision
  // movement refresh. Publish the corrected coordinates without rebuilding
  // unrelated dynamic kinds.
  if (room.spatialIndex && typeof room.spatialIndex.rebuildKind === "function") {
    room.spatialIndex.rebuildKind("ships", ships, shipBroadPhaseRadius, now);
  }
  durations.movementSeparationMap = performanceNow() - startedAt;
  // Everything below this point sees one cached visibility generation. Combat
  // may ask about hundreds of targets with slightly different performanceNow()
  // values; those calls must not rebuild team visibility independently.
  invalidateVisibility(room, "post-movement");
  // A remembered contact is useful map information, but it is not a live
  // target. Clear retained focus, pursuit and weapon-acquisition state at the
  // same authoritative visibility boundary combat uses. This shares the cached
  // team scan below instead of adding another fog pass earlier in the tick.
  startedAt = performanceNow();
  dropHiddenTargetLocksForShips(room, ships, now);
  durations.visibility = performanceNow() - startedAt;
  startedAt = performanceNow();
  updateProximityCharges(room, ships, dt, now);
  durations.proximityCharges = performanceNow() - startedAt;
  startedAt = performanceNow();
  updateShipSupport(room, ships, dt, now);
  updateDecoyLaunchers(room, ships, dt, now);
  durations.support = performanceNow() - startedAt;
  startedAt = performanceNow();
  updateDroneBays(room, ships, dt, now);
  durations.drones = performanceNow() - startedAt;
  let weaponsMs = 0;
  let heatMs = 0;
  const detailedTiming = now >= (Number(room._nextDetailedShipTimingAt) || 0);
  if (detailedTiming) {
    room._nextDetailedShipTimingAt = now + 1000;
    for (const ship of ships) {
      startedAt = performanceNow();
      updateShipWeapons(room, ship, ships, dt, now);
      weaponsMs += performanceNow() - startedAt;
      startedAt = performanceNow();
      updateShipHeat(ship, dt, room, now);
      heatMs += performanceNow() - startedAt;
    }
    const total = weaponsMs + heatMs;
    if (total > 0) room._weaponTimingShare = weaponsMs / total;
  } else {
    startedAt = performanceNow();
    // Preserve the historical per-ship weapons -> Heat interleave exactly.
    for (const ship of ships) {
      updateShipWeapons(room, ship, ships, dt, now);
      updateShipHeat(ship, dt, room, now);
    }
    const combined = performanceNow() - startedAt;
    const weaponShare = Math.max(0, Math.min(1, Number(room._weaponTimingShare) || 0.7));
    weaponsMs = combined * weaponShare;
    heatMs = combined - weaponsMs;
  }
  durations.weapons = weaponsMs;
  durations.heat = heatMs;
  startedAt = performanceNow();
  updateStationWeapons(room, room.stations || [], ships, dt, now);
  durations.stationWeapons = performanceNow() - startedAt;
  startedAt = performanceNow();
  updateBullets(room, dt, now);
  setCounter(room, "liveProjectiles", (room.bullets || []).length);
  durations.projectiles = performanceNow() - startedAt;
  startedAt = performanceNow();
  updateStations(room, dt, now);
  updateCapturePoints(room, ships, dt); updateControlVictory(room, now);
  // Weapons, projectile damage, drone movement, ship destruction and station
  // capture can all change final visibility after combat started using the
  // post-movement generation. Publish one final generation for snapshots.
  invalidateVisibility(room, "post-combat");
  room._visibilityFinalizedAt = now;
  durations.objectives = performanceNow() - startedAt;
  recordRoomTick(durations);
  if (!room._suppressRoomTelemetry) recordRoomTelemetry(room);
  const componentAssertionsEnabled = isComponentAssertionEnabled();
  if (componentAssertionsEnabled) {
    const sampleAll = now >= (Number(room._lastComponentAssertionSampleAt) || 0) + 1000;
    for (const ship of room.ships.values()) {
      if (!ship?.componentHp || !ship?.design) continue;
      if (sampleAll || (ship.dirtyComponents?.size || 0) > 0) {
        assertComponentHpConsistency(ship);
      }
    }
    if (sampleAll) room._lastComponentAssertionSampleAt = now;
  }
}

// Phase Four: fixed authoritative timestep accumulator.
const FIXED_STEP_MS = 1000 / TICK_HZ;
const FIXED_STEP_S = FIXED_STEP_MS / 1000;
const MAX_CATCH_UP_STEPS = 3;

function advanceRoomAuthoritative(room, wallNow) {
  // Non-active rooms do not need fixed-step advancement; preserve the existing
  // effect expiry behaviour with a single zero-length tick.
  if (room.phase !== "active") {
    tickRoom(room, 0, wallNow);
    return;
  }

  // Re-entry protection: a callback must never enter the same room tick while it
  // is already being advanced. Record the attempt and return cleanly.
  if (room._simulationLocked) {
    room._simulationReentries = (room._simulationReentries || 0) + 1;
    return;
  }

  room._simulationLocked = true;
  room._suppressRoomTelemetry = true;

  try {
    // A non-finite wall time is always replaced with the current hrtime so the
    // callback history stays monotonic and finite. Finite wall times pass through.
    const safeWallNow = Number.isFinite(wallNow) ? wallNow : performanceNow();

    // First callback: there is no previous callback to compare. Seed the clock
    // so the room begins at the current monotonic time and executes one step.
    if (!room._lastSimulationCallbackMs) {
      room._authoritativeTimeMs = safeWallNow;
      room._lastSimulationCallbackMs = safeWallNow;
      room._simulationAccumulatorMs = FIXED_STEP_MS;
      room._simulationStep = 0;
    }

    const callbackDeltaMs = wallNow - room._lastSimulationCallbackMs;
    room._lastSimulationCallbackMs = safeWallNow;

    // Defend against non-monotonic or non-finite callback deltas; never let one
    // corrupt the accumulator. Clamp to one step and continue from a valid state.
    const safeCallbackDeltaMs = Number.isFinite(callbackDeltaMs) && callbackDeltaMs >= 0
      ? callbackDeltaMs
      : FIXED_STEP_MS;

    room._simulationAccumulatorMs = (room._simulationAccumulatorMs || 0) + safeCallbackDeltaMs;

    const fullSteps = Math.floor(room._simulationAccumulatorMs / FIXED_STEP_MS);
    const steps = Math.min(fullSteps, MAX_CATCH_UP_STEPS);
    const consumedMs = steps * FIXED_STEP_MS;
    let discardedMs = 0;
    if (fullSteps > MAX_CATCH_UP_STEPS) {
      discardedMs = room._simulationAccumulatorMs - consumedMs;
      room._simulationAccumulatorMs = 0;
    } else {
      room._simulationAccumulatorMs -= consumedMs;
    }

    let totalStepDurationMs = 0;
    for (let i = 0; i < steps; i += 1) {
      room._authoritativeTimeMs += FIXED_STEP_MS;
      room._simulationStep += 1;
      const stepStart = performanceNow();
      tickRoom(room, FIXED_STEP_S, room._authoritativeTimeMs);
      totalStepDurationMs += performanceNow() - stepStart;
    }

    // If no fixed step was produced, the room still saw a callback. Record a
    // zero-step callback so telemetry does not silently drop the event.
    const metrics = {
      fixedStepCallbacks: 1,
      fixedSteps: steps,
      fixedStepCatchUpCallbacks: steps > 1 ? 1 : 0,
      fixedStepMaxCatchUp: steps,
      fixedStepDiscardedBacklogMs: discardedMs,
      fixedStepJitterMs: Math.max(0, safeCallbackDeltaMs - FIXED_STEP_MS),
      fixedStepDurationMs: steps > 0 ? totalStepDurationMs / steps : 0,
      fixedStepReentryAttempts: room._simulationReentries || 0,
      fixedStepAccumulatorRemainingMs: room._simulationAccumulatorMs || 0
    };

    room._simulationReentries = 0;
    room._suppressRoomTelemetry = false;
    if (steps === 0) resetRoomTelemetry(room);
    for (const [name, value] of Object.entries(metrics)) setCounter(room, name, value);
    recordRoomTelemetry(room);
  } finally {
    room._simulationLocked = false;
    room._suppressRoomTelemetry = false;
  }
}

module.exports = { tickRoom, advanceRoomAuthoritative, FIXED_STEP_MS, FIXED_STEP_S, MAX_CATCH_UP_STEPS };
