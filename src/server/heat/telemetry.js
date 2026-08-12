"use strict";

// Sparse component telemetry, network diagnostics, and the public Heat debug
// projection. These report the runtime solve without owning Heat mechanics.
const { PARTS } = require("../components");
const HeatRules = require("../../../public/src/shared/heatRules");
const {
  createComponentAdjacency,
  isThermalRouteType
} = require("../thermalTopology");
const { bump } = require("../roomTelemetry");

const {
  TICK_SECONDS,
  RADIATOR_EXPOSED_MULTIPLIER,
  RADIATOR_ENCLOSED_MULTIPLIER,
  HEAT_VENT_EXPOSED_MULTIPLIER,
  HEAT_VENT_ENCLOSED_MULTIPLIER,
  isCoolantTransportType
} = HeatRules;

const TELEMETRY_STRIDE = 6;
const compareNumbers = (a, b) => a - b;

function reportRuntimeWakeTelemetry(room, runtime) {
  if (!room || !runtime) return;
  if (runtime.pendingWakeups) {
    bump(room, "heatShipWakeups", runtime.pendingWakeups);
    runtime.pendingWakeups = 0;
  }
}

function markTelemetryCandidate(runtime, index, candidateList) {
  const token = runtime.telemetryCandidateToken;
  if (runtime.telemetryCandidateStamps[index] === token) return;
  runtime.telemetryCandidateStamps[index] = token;
  candidateList.push(index);
}

function beginSparseTelemetryStep(ship) {
  const runtime = ship._thermalRuntime;
  const previous = runtime.telemetryComponents;
  runtime.telemetryComponents = runtime.telemetrySpareComponents;
  runtime.telemetrySpareComponents = previous;
  runtime.telemetryComponents.length = 0;
  for (const index of previous) {
    ship.componentHeatGenerated[index] = 0;
    ship.componentHeatReceived[index] = 0;
    ship.componentHeatRemoved[index] = 0;
    ship.componentHeatTransferredOut[index] = 0;
    ship.componentHeatCooled[index] = 0;
    ship.componentHeatSentThroughFrame[index] = 0;
    ship.componentHeatRadiated[index] = 0;
  }
  return previous;
}

function finishSparseTelemetryStep(ship, previousTelemetry, candidateList) {
  const runtime = ship._thermalRuntime;
  runtime.telemetryCandidateToken = (runtime.telemetryCandidateToken + 1) >>> 0;
  if (runtime.telemetryCandidateToken === 0) {
    runtime.telemetryCandidateStamps.fill(0);
    runtime.telemetryCandidateToken = 1;
  }
  candidateList.length = 0;
  for (const index of previousTelemetry) markTelemetryCandidate(runtime, index, candidateList);
  for (const index of runtime.touchedComponents) markTelemetryCandidate(runtime, index, candidateList);
  let changed = false;
  for (const index of candidateList) {
    const offset = index * TELEMETRY_STRIDE;
    const value0 = ship.componentHeatGenerated[index] || 0;
    const value1 = ship.componentHeatReceived[index] || 0;
    const value2 = ship.componentHeatTransferredOut[index] || 0;
    const value3 = ship.componentHeatCooled[index] || 0;
    const value4 = ship.componentHeatSentThroughFrame[index] || 0;
    const value5 = ship.componentHeatRadiated[index] || 0;
    const values = runtime.telemetryValues;
    if (values[offset] !== value0) { values[offset] = value0; changed = true; }
    if (values[offset + 1] !== value1) { values[offset + 1] = value1; changed = true; }
    if (values[offset + 2] !== value2) { values[offset + 2] = value2; changed = true; }
    if (values[offset + 3] !== value3) { values[offset + 3] = value3; changed = true; }
    if (values[offset + 4] !== value4) { values[offset + 4] = value4; changed = true; }
    if (values[offset + 5] !== value5) { values[offset + 5] = value5; changed = true; }
    const nonZero = value0 !== 0 || value1 !== 0 || value2 !== 0 || value3 !== 0
      || value4 !== 0 || value5 !== 0;
    if (nonZero) {
      runtime.telemetryComponents.push(index);
    }
  }
  runtime.telemetryComponents.sort(compareNumbers);
  for (const index of previousTelemetry) {
    if (!runtime.telemetryComponents.includes(index)) runtime.telemetryCandidateStamps[index] = 0;
  }
  return changed;
}

function updateHeatNetworkDiagnostics(ship, elapsed) {
  // Coolant transport is attributed back to the structural thermal network that
  // contains the pipes, so the designer can report one figure per network.
  const transportByThermalNetwork = new Map();
  for (const coolant of ship.coolantNetworks || []) {
    const moved = Number(coolant.transportedHeat) || 0;
    if (!moved) continue;
    for (const id of ship.componentThermalNetworks?.[coolant.pipeIndices[0]] || []) {
      transportByThermalNetwork.set(id, (transportByThermalNetwork.get(id) || 0) + moved);
    }
  }
  for (const network of ship.thermalNetworks || []) {
    let totalStoredHeat = 0;
    let totalStorageCapacity = 0;
    for (const index of network.frameIndices) {
      totalStoredHeat += ship.componentHeat[index];
      totalStorageCapacity += ship.componentThermals[index].capacity;
    }
    for (const index of network.attachedComponents) {
      totalStoredHeat += ship.componentHeat[index];
      totalStorageCapacity += ship.componentThermals[index].capacity;
    }
    let totalCoolingCapacity = 0;
    for (const index of network.sinks) totalCoolingCapacity += ship.componentThermals[index].cooling;
    for (const index of network.radiators) {
      totalCoolingCapacity += ship.componentThermals[index].cooling * (ship.componentThermals[index].exposedEdges ? RADIATOR_EXPOSED_MULTIPLIER : RADIATOR_ENCLOSED_MULTIPLIER);
    }
    for (const index of network.heatVents || []) {
      totalCoolingCapacity += ship.componentThermals[index].cooling * (ship.componentThermals[index].exposedEdges ? HEAT_VENT_EXPOSED_MULTIPLIER : HEAT_VENT_ENCLOSED_MULTIPLIER);
    }
    for (const index of network.closedCycleCoolers || []) totalCoolingCapacity += ship.componentThermals[index].cooling;
    let totalCooling = 0;
    for (const index of network.radiators) totalCooling += ship.componentHeatRadiated[index];
    for (const index of network.heatVents || []) totalCooling += ship.componentHeatRadiated[index];
    for (const index of network.sinks) totalCooling += ship.componentHeatCooled[index];
    for (const index of network.closedCycleCoolers || []) totalCooling += ship.componentHeatCooled[index] || 0;
    const heatPipeTransfer = transportByThermalNetwork.get(network.id) || 0;
    let generation = 0;
    for (const index of network.generators) generation += HeatRules.activityHeat(ship.design[index].type, PARTS[ship.design[index].type] || {});
    network.totalStoredHeat = totalStoredHeat;
    network.totalStorageCapacity = totalStorageCapacity;
    network.totalCoolingCapacity = totalCoolingCapacity;
    network.totalCooling = totalCooling;
    network.heatPipeTransferPerSecond = heatPipeTransfer / elapsed;
    network.overloaded = generation > totalCoolingCapacity;
  }
  if (ship._thermalRuntime) ship._thermalRuntime.networkDiagnosticsDirty = false;
}

function buildHeatDebug(ship) {
  const dt = Math.max(0.001, ship.lastHeatTickDelta || TICK_SECONDS);
  const adjacency = ship.thermalTopology ? createComponentAdjacency(ship.thermalTopology) : [];
  const coolantNetworkByComponent = new Map();
  for (const network of ship.coolantNetworks || []) {
    for (const index of network.pipeIndices) coolantNetworkByComponent.set(index, network.id);
    for (const attachment of network.attachments) {
      if (!coolantNetworkByComponent.has(attachment.index)) coolantNetworkByComponent.set(attachment.index, network.id);
    }
  }
  return {
    shipId: ship.id,
    currentHeat: ship.currentHeat,
    maxHeat: ship.maxHeat,
    components: (ship.design || []).map((module, index) => ({
      index,
      type: module.type,
      currentHeat: ship.componentHeat?.[index] || 0,
      generatedPerSecond: (ship.componentHeatGenerated?.[index] || 0) / dt,
      receivedFromNetworkPerSecond: (ship.componentHeatReceived?.[index] || 0) / dt,
      transferredOutPerSecond: (ship.componentHeatTransferredOut?.[index] || 0) / dt,
      cooledPerSecond: (ship.componentHeatCooled?.[index] || 0) / dt,
      sentThroughFramePerSecond: (ship.componentHeatSentThroughFrame?.[index] || 0) / dt,
      removedByRadiatorPerSecond: module.type === "radiator" ? (ship.componentHeatRadiated?.[index] || 0) / dt : 0,
      removedByHeatVentPerSecond: module.type === "heatVent" ? (ship.componentHeatRadiated?.[index] || 0) / dt : 0,
      removedByClosedCycleCoolerPerSecond: module.type === "closedCycleCooler" ? (ship.componentHeatCooled?.[index] || 0) / dt : 0,
      thermalNetworkIds: (ship.componentThermalNetworks?.[index] || []).slice(),
      coolantNetworkId: coolantNetworkByComponent.has(index) ? coolantNetworkByComponent.get(index) : null,
      exposedEdges: ship.componentThermals?.[index]?.exposedEdges || 0,
      routeType: isCoolantTransportType(module.type) ? "heatPipe" : isThermalRouteType(module.type) ? "frame" : "attached",
      adjacentHeatPipeEdges: (adjacency[index] || []).filter(e => isCoolantTransportType(ship.design?.[e.index]?.type)).reduce((sum, e) => sum + e.sharedEdges, 0)
    })),
    coolantNetworks: (ship.coolantNetworks || []).map(network => ({
      id: network.id,
      pipeIndices: network.pipeIndices.slice(),
      attachedComponents: network.attachments.map(attachment => attachment.index),
      attachmentSharedEdges: network.attachments.map(attachment => attachment.sharedEdges),
      transportedHeatPerSecond: (network.transportedHeat || 0) / dt
    })),
    networks: (ship.thermalNetworks || []).map(network => ({
      id: network.id,
      frameIndices: network.frameOnlyIndices ? network.frameOnlyIndices.slice() : network.frameIndices.slice(),
      heatPipeIndices: (network.heatPipeIndices || []).slice(),
      attachedComponents: network.attachedComponents.slice(),
      sinkIndices: network.sinks.slice(),
      radiatorIndices: network.radiators.slice(),
      heatVentIndices: (network.heatVents || []).slice(),
      closedCycleCoolerIndices: (network.closedCycleCoolers || []).slice(),
      totalHeat: network.totalStoredHeat,
      totalStorageCapacity: network.totalStorageCapacity,
      totalCoolingCapacity: network.totalCoolingCapacity,
      totalCoolingPerSecond: (network.totalCooling || 0) / dt,
      removedByClosedCycleCoolerPerSecond: (network.closedCycleCoolers || []).reduce((sum, i) => sum + (ship.componentHeatCooled?.[i] || 0), 0) / dt,
      heatPipeTransferPerSecond: network.heatPipeTransferPerSecond || 0,
      attachedRadiators: network.radiators.slice(),
      attachedHeatSources: network.generators.slice(),
      overloaded: network.overloaded
    }))
  };
}

module.exports = {
  reportRuntimeWakeTelemetry,
  beginSparseTelemetryStep,
  finishSparseTelemetryStep,
  updateHeatNetworkDiagnostics,
  buildHeatDebug
};
