"use strict";

// Component Heat-state transitions, source invalidation, aggregate publication,
// and reactor meltdown lifecycle.
const { PARTS } = require("../components");
const HeatRules = require("../../../public/src/shared/heatRules");
const { bump } = require("../roomTelemetry");
const {
  setHeatBearingMembership,
  setHotMembership,
  refreshLoadedGeneratorComponents
} = require("./lifecycle");
const {
  finishSparseTelemetryStep,
  updateHeatNetworkDiagnostics
} = require("./telemetry");

const {
  STATE,
  stateFor,
  REACTOR_MELTDOWN_SECONDS,
  REACTOR_EXPLOSION_RADIUS,
  REACTOR_EXPLOSION_DAMAGE
} = HeatRules;

function applyHeatStateTransitions(ship, heat, runtime, elapsed, overheatRecoveryMult, previousTelemetry, pendingInputCount, room, now) {
  let componentHeatChanged = false;
  let powerSourceStateChanged = false;
  let dataSourceStateChanged = false;
  let meltdowns = null;
  if (!ship.componentMeltdown) ship.componentMeltdown = heat.map(() => 0);
  for (const index of runtime.touchedComponents) {
    const alive = (ship.componentHp?.[index] ?? 1) > 0;
    const capacity = ship.componentThermals[index].capacity;
    const rawHeat = Number(heat[index]);
    const rawDelta = Number(runtime.delta[index]);
    const oldHeat = Number.isFinite(rawHeat) ? Math.max(0, rawHeat) : 0;
    const unclampedNext = oldHeat + (Number.isFinite(rawDelta) ? rawDelta : 0);
    const next = Number.isFinite(unclampedNext) ? Math.max(0, unclampedNext) : oldHeat;
    const oldState = ship.componentHeatState[index];
    const physicalState = stateFor(capacity > 0 ? next / capacity : (next > 0 ? Infinity : 0), oldState);
    const nextState = alive ? physicalState : STATE.NORMAL;
    if (nextState !== oldState) ship.heatStateRevision = (ship.heatStateRevision || 0) + 1;
    const visibleHeatChanged = Math.round(next * 10) !== Math.round(heat[index] * 10);
    if (nextState !== oldState || visibleHeatChanged) {
      ship.dirtyHeat.add(index);
      componentHeatChanged = true;
    }
    const oldHot = alive && oldState >= STATE.HOT;
    const nextHot = alive && nextState >= STATE.HOT;
    const oldOverheated = alive && oldState === STATE.OVERHEATED;
    const nextOverheated = alive && nextState === STATE.OVERHEATED;
    if (oldOverheated !== nextOverheated) runtime.overheatedComponentCount += nextOverheated ? 1 : -1;
    setHotMembership(ship, index, alive, nextState);
    if (oldHot !== nextHot && !runtime.hotMembership[index]) {
      // setHotMembership has already handled list membership; this branch is a
      // defensive no-op for malformed externally-mutated state.
      setHotMembership(ship, index, alive, nextState);
    }
    heat[index] = next;
    ship.componentHeatState[index] = nextState;
    runtime.lastHeatValues[index] = next;
    setHeatBearingMembership(ship, index, next);

    if (runtime.powerSourceMembership[index]) {
      const priorState = ship._heatPowerSourceStates?.[index] ?? oldState;
      const priorAlive = ship._heatPowerSourceAlive?.[index] ?? alive;
      if (priorAlive !== alive || (priorState === STATE.OVERHEATED) !== (nextState === STATE.OVERHEATED)) powerSourceStateChanged = true;
      if (ship._heatPowerSourceStates) ship._heatPowerSourceStates[index] = nextState;
      if (ship._heatPowerSourceAlive) ship._heatPowerSourceAlive[index] = alive ? 1 : 0;
    }
    if (runtime.dataSourceMembership[index]) {
      const priorState = ship._heatDataSourceStates?.[index] ?? oldState;
      const priorAlive = ship._heatDataSourceAlive?.[index] ?? alive;
      if (priorAlive !== alive || priorState !== nextState) dataSourceStateChanged = true;
      if (ship._heatDataSourceStates) ship._heatDataSourceStates[index] = nextState;
      if (ship._heatDataSourceAlive) ship._heatDataSourceAlive[index] = alive ? 1 : 0;
    }

    const output = PARTS[ship.design[index].type]?.powerGeneration || 0;
    if (alive && output > 0) {
      if (nextState === STATE.OVERHEATED) {
        ship.componentMeltdown[index] += elapsed;
        if (ship.componentMeltdown[index] >= REACTOR_MELTDOWN_SECONDS) (meltdowns || (meltdowns = [])).push(index);
      } else {
        ship.componentMeltdown[index] = Math.max(0, ship.componentMeltdown[index] - elapsed * 2 * overheatRecoveryMult);
      }
    } else if (output > 0) {
      ship.componentMeltdown[index] = 0;
    }
  }
  ship.currentHeat = 0;
  for (let index = 0; index < heat.length; index += 1) {
    if ((ship.componentHp?.[index] ?? 1) > 0) {
      const value = Number(heat[index]);
      ship.currentHeat += Number.isFinite(value) ? Math.max(0, value) : 0;
    }
  }
  const nextPressure = ship.maxHeat > 0 ? ship.currentHeat / ship.maxHeat : 0;
  const nextHotCount = runtime.hotComponents.length;
  const nextOverheatedCount = runtime.overheatedComponentCount;
  const previousHeatPresentation = ship._heatPresentationValues;
  const nextHeatPresentation = [
    Math.round(ship.currentHeat * 10),
    Math.round((ship.maxHeat || 0) * 10),
    Math.round(nextPressure * 1000),
    nextHotCount,
    nextOverheatedCount
  ];
  if (!previousHeatPresentation || nextHeatPresentation.some((value, index) => value !== previousHeatPresentation[index])) {
    ship.heatRevision = (ship.heatRevision || 0) + 1;
    ship._heatPresentationValues = nextHeatPresentation;
  }
  if (componentHeatChanged) ship.componentHeatRevision = (ship.componentHeatRevision || 0) + 1;
  ship.heatPressure = nextPressure;
  ship.hotComponentCount = nextHotCount;
  ship.overheatedComponentCount = nextOverheatedCount;

  // Preserve the established invalidation order and mutual exclusion exactly.
  if (powerSourceStateChanged) require("../componentPower").reallocateShipPower(ship, "thermal-source-state");
  else if (dataSourceStateChanged) require("../componentData").refreshShipDataAllocation(ship, "thermal-data-source-state");
  refreshLoadedGeneratorComponents(ship);
  runtime.lifecycleInvalidated = false;
  runtime.sourceStateDirty = false;
  for (const index of runtime.lifecycleComponents) runtime.lifecycleMembership[index] = 0;
  runtime.lifecycleComponents.length = 0;

  updateHeatNetworkDiagnostics(ship, elapsed);
  const telemetryChanged = finishSparseTelemetryStep(ship, previousTelemetry, runtime.telemetryCandidateComponents);
  if (telemetryChanged) ship.heatTelemetryRevision = (ship.heatTelemetryRevision || 0) + 1;
  bump(room, "heatComponentsVisited", runtime.touchedComponents.length);
  bump(room, "heatBearingComponents", runtime.heatBearingComponents.length);
  bump(room, "heatHotComponents", runtime.hotComponents.length);
  bump(room, "heatPendingInputComponents", pendingInputCount);
  bump(room, "heatLoadedGeneratorComponents", runtime.loadedGeneratorComponents.length);
  ship.hasActiveHeat = runtime.heatBearingComponents.length > 0 || ship.hasPassiveHeatSource;

  // Resolve reactor meltdowns only after all thermal state and telemetry are
  // settled, preserving the authoritative lifecycle boundary.
  if (meltdowns && room) {
    const { detonateComponent } = require("../componentHealth");
    for (const index of meltdowns) {
      if (ship.componentHp[index] <= 0) continue;
      ship.componentMeltdown[index] = 0;
      const part = PARTS[ship.design[index].type] || {};
      const radius = part.meltdownRadius ?? REACTOR_EXPLOSION_RADIUS;
      const damage = part.meltdownDamage ?? REACTOR_EXPLOSION_DAMAGE;
      detonateComponent(room, ship, index, radius, damage, now);
    }
    if (ship.alive && (ship.hp <= 0.001 || ship.coreDestroyed)) require("../combat").destroyShip(room, ship, ship.lastDamagedBy || null, now);
  }
}

module.exports = {
  applyHeatStateTransitions
};
