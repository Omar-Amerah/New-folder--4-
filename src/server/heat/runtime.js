"use strict";

// Authoritative low-frequency Heat orchestration. Stage order is deliberately
// explicit: inputs -> transfers/conduction -> cooling -> state/invalidation ->
// telemetry (the latter two are finalized together to preserve legacy order).
const HeatRules = require("../../../public/src/shared/heatRules");
const { performanceNow } = require("../utils");
const { bump, recordDuration } = require("../roomTelemetry");
const {
  ensureThermalRuntime,
  addPendingHeatInput,
  refreshLoadedGeneratorComponents,
  refreshHeatRuntimeLists,
  thermalStable,
  resetHeatScratch,
  buildHeatWorkSet
} = require("./lifecycle");
const { applyHeatInputs } = require("./inputs");
const { applyHeatTransfers } = require("./transfer");
const { applyHeatCooling } = require("./cooling");
const { applyHeatStateTransitions } = require("./stateTransitions");
const {
  reportRuntimeWakeTelemetry,
  beginSparseTelemetryStep,
  finishSparseTelemetryStep,
  updateHeatNetworkDiagnostics
} = require("./telemetry");

const { TICK_SECONDS } = HeatRules;

function updateShipHeatCore(ship, dt, room, now) {
  const runtimeStart = performanceNow();
  if (!ship.alive || !ship.componentHeat) return;
  const runtime = ensureThermalRuntime(ship);
  reportRuntimeWakeTelemetry(room, runtime);
  bump(room, "heatShipsConsidered");
  bump(room, "heatComponentsTotal", ship.componentHeat.length);
  bump(room, "heatEdgesTotal", runtime.topology.edgeA.length);
  if (!runtime.topologyTelemetryReported) {
    bump(room, "heatTopologyBuilds", runtime.topologyBuilds);
    bump(room, "heatTopologyCacheHits", runtime.topologyCacheHits);
    runtime.topologyTelemetryReported = true;
  }
  if (runtime.topologyShared) bump(room, "heatTopologySharedShips");

  const pending = Boolean(ship.hasPendingHeatInput || runtime.pendingInputComponents.length);
  const hasRetainedHeat = runtime.heatBearingComponents.length > 0;
  if (!ship.hasActiveHeat && !ship.hasPassiveHeatSource && !pending && !hasRetainedHeat) return;
  ship.hasPendingHeatInput = false;
  const maxThermalSteps = 8;
  const maxThermalBacklogSeconds = TICK_SECONDS * maxThermalSteps;
  ship.heatAccumulator = Math.min((ship.heatAccumulator || 0) + Math.max(0, dt || 0), maxThermalBacklogSeconds);
  if (ship.heatAccumulator < TICK_SECONDS) return;
  const steps = Math.min(maxThermalSteps, Math.floor(ship.heatAccumulator / TICK_SECONDS));
  const elapsed = steps * TICK_SECONDS;
  ship.heatAccumulator = Math.max(0, ship.heatAccumulator - elapsed);
  ship.lastHeatTickDelta = elapsed;

  const stableCheckStart = performanceNow();
  refreshLoadedGeneratorComponents(ship);
  // Public test/debug callers historically set hasActiveHeat and a component
  // Heat value directly. Reconcile that compatibility hint once when the
  // persistent lists are otherwise empty; normal gameplay producers maintain
  // membership incrementally through addComponentHeat/lifecycle hooks.
  if (ship.hasActiveHeat && !runtime.stable
      && runtime.heatBearingComponents.length === 0
      && runtime.pendingInputComponents.length === 0
      && runtime.lifecycleComponents.length === 0) {
    refreshHeatRuntimeLists(ship);
    // Preserve the public-array diagnostic contract: direct writes to
    // componentHeatInput are picked up once when no sparse producer list exists.
    for (let index = 0; index < ship.componentHeatInput.length; index += 1) {
      if ((Number(ship.componentHeatInput[index]) || 0) > 0) {
        addPendingHeatInput(ship, index);
        ship.hasPendingHeatInput = true;
      }
    }
  }
  const stable = thermalStable(ship);
  recordDuration(room, "heatStableCheckMs", stableCheckStart);
  if (stable) {
    resetHeatScratch(runtime);
    const previousTelemetry = beginSparseTelemetryStep(ship);
    const telemetryChanged = finishSparseTelemetryStep(ship, previousTelemetry, runtime.telemetryCandidateComponents);
    if (telemetryChanged) ship.heatTelemetryRevision = (ship.heatTelemetryRevision || 0) + 1;
    for (const network of ship.coolantNetworks || []) network.transportedHeat = 0;
    if (runtime.networkDiagnosticsDirty) updateHeatNetworkDiagnostics(ship, elapsed);
    else for (const network of ship.thermalNetworks || []) {
      network.totalStoredHeat = 0;
      network.totalCooling = 0;
      network.heatPipeTransferPerSecond = 0;
    }
    const stablePressure = ship.maxHeat > 0 ? ship.currentHeat / ship.maxHeat : 0;
    const stablePresentation = [
      Math.round((ship.currentHeat || 0) * 10),
      Math.round((ship.maxHeat || 0) * 10),
      Math.round(stablePressure * 1000),
      runtime.hotComponents.length,
      runtime.overheatedComponentCount
    ];
    if (!ship._heatPresentationValues || stablePresentation.some((value, index) => value !== ship._heatPresentationValues[index])) {
      ship.heatRevision = (ship.heatRevision || 0) + 1;
      ship._heatPresentationValues = stablePresentation;
    }
    if (!runtime.stable) {
      runtime.stable = true;
      bump(room, "heatShipSleeps");
    }
    bump(room, "heatShipsStableSkipped", steps);
    recordDuration(room, "heatRuntimeMs", runtimeStart);
    return;
  }
  runtime.stable = false;
  bump(room, "heatShipsSolved");

  resetHeatScratch(runtime);
  const previousTelemetry = beginSparseTelemetryStep(ship);
  const heat = ship.componentHeat;
  buildHeatWorkSet(ship);
  const pendingInputCount = runtime.pendingInputComponents.length;

  let generationStart = performanceNow();
  applyHeatInputs(ship, runtime, elapsed);
  recordDuration(room, "heatGenerationMs", generationStart);

  applyHeatTransfers(ship, heat, runtime, elapsed, room);

  let coolingStart = performanceNow();
  const overheatRecoveryMult = applyHeatCooling(ship, heat, runtime, elapsed);
  recordDuration(room, "heatCoolingMs", coolingStart);

  let finalizationStart = performanceNow();
  applyHeatStateTransitions(
    ship,
    heat,
    runtime,
    elapsed,
    overheatRecoveryMult,
    previousTelemetry,
    pendingInputCount,
    room,
    now
  );
  recordDuration(room, "heatFinalizationMs", finalizationStart);
  recordDuration(room, "heatRuntimeMs", runtimeStart);
}

function updateShipHeat(ship, dt, room, now) {
  const previousHeatStateRevision = Number(ship?.heatStateRevision) || 0;
  const previousHeatRevision = Number(ship?.heatRevision) || 0;
  const result = updateShipHeatCore(ship, dt, room, now);
  if (room && (previousHeatStateRevision !== (Number(ship?.heatStateRevision) || 0)
    || previousHeatRevision !== (Number(ship?.heatRevision) || 0))) {
    require("../commandAuras").invalidateCommandAuraSource(room, ship, "heat-state");
  }
  return result;
}

module.exports = {
  updateShipHeat
};
