// Authoritative low-frequency, per-component thermal simulation.
const { PARTS } = require("./components");
const { getCommandAuraMultiplier } = require("./commandAuras");
const { getOccupiedCells } = require("./footprint");
const HeatRules = require("../../public/src/shared/heatRules");
const {
  buildThermalTopology,
  createComponentAdjacency,
  isThermalRouteType
} = require("./thermalTopology");
const { performanceNow } = require("./utils");
const { bump, recordDuration } = require("./roomTelemetry");

const { TICK_SECONDS, STATE, profile, stateFor, activeOutputForState, activeCoolingForState, edgeTransfer, RADIATOR_EXPOSED_MULTIPLIER, RADIATOR_ENCLOSED_MULTIPLIER, RADIATOR_PASSIVE_COOLING_FRACTION, HEAT_VENT_EXPOSED_MULTIPLIER, HEAT_VENT_ENCLOSED_MULTIPLIER, isCoolantTransportType, coolantEdgeConductance, coolantEdgeBandwidth, solveCoolantNetwork } = HeatRules;

const TELEMETRY_STRIDE = 7;
const TELEMETRY_FIELDS = Object.freeze([
  "componentHeatGenerated",
  "componentHeatReceived",
  "componentHeatTransferredOut",
  "componentHeatCooled",
  "componentHeatSentThroughFrame",
  "componentHeatRadiated",
  "componentVentedOverflowHeatThisTick"
]);
const compareNumbers = (a, b) => a - b;

function filledInt32(length, value = -1) {
  const result = new Int32Array(length);
  result.fill(value);
  return result;
}

function insertOrdered(list, membership, index, positions = null) {
  if (membership[index]) return false;
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (list[middle] < index) low = middle + 1;
    else high = middle;
  }
  list.splice(low, 0, index);
  membership[index] = 1;
  if (positions) for (let i = low; i < list.length; i += 1) positions[list[i]] = i;
  return true;
}

function removeOrdered(list, membership, index, positions = null) {
  if (!membership[index]) return false;
  const position = positions ? positions[index] : list.indexOf(index);
  if (position < 0) {
    membership[index] = 0;
    if (positions) positions[index] = -1;
    return false;
  }
  list.splice(position, 1);
  membership[index] = 0;
  if (positions) {
    positions[index] = -1;
    for (let i = position; i < list.length; i += 1) positions[list[i]] = i;
  }
  return true;
}

function createThermalRuntime(ship, topology) {
  const componentCount = topology.componentCount;
  const edgeCount = topology.edgeA.length;
  const runtime = {
    topology,
    heatBearingComponents: [],
    heatBearingMembership: new Uint8Array(componentCount),
    heatBearingPositions: filledInt32(componentCount),
    hotComponents: [],
    hotMembership: new Uint8Array(componentCount),
    hotPositions: filledInt32(componentCount),
    pendingInputComponents: [],
    pendingInputMembership: new Uint8Array(componentCount),
    loadedGeneratorComponents: [],
    loadedGeneratorMembership: new Uint8Array(componentCount),
    powerSourceMembership: new Uint8Array(componentCount),
    dataSourceMembership: new Uint8Array(componentCount),
    lifecycleComponents: [],
    lifecycleMembership: new Uint8Array(componentCount),
    workComponents: [],
    workMembership: new Uint8Array(componentCount),
    touchedComponents: [],
    touchedMembership: new Uint8Array(componentCount),
    candidateEdgeIds: [],
    edgeVisitStamps: new Uint32Array(edgeCount),
    edgeVisitToken: 0,
    transferEdgeIds: new Int32Array(Math.max(1, edgeCount)),
    transferAmounts: new Float64Array(Math.max(1, edgeCount)),
    transferCount: 0,
    delta: new Float64Array(componentCount),
    workingHeat: new Float64Array(componentCount),
    outflow: new Float64Array(componentCount),
    lastHeatValues: new Float64Array(componentCount),
    scratchComponents: [],
    telemetryComponents: [],
    telemetrySpareComponents: [],
    telemetryCandidateComponents: [],
    telemetryCandidateStamps: new Uint32Array(componentCount),
    telemetryCandidateToken: 0,
    telemetryValues: new Float64Array(componentCount * TELEMETRY_STRIDE),
    stable: false,
    pendingWakeups: 0,
    pendingSleepReport: false,
    lifecycleInvalidated: false,
    sourceStateDirty: false,
    networkDiagnosticsDirty: true,
    overheatedComponentCount: 0,
    topologyShared: false,
    topologyBuilds: 0,
    topologyCacheHits: 0,
    topologyTelemetryReported: false
  };
  for (const index of topology.powerSourceIndices) runtime.powerSourceMembership[index] = 1;
  for (const index of topology.dataSourceIndices) runtime.dataSourceMembership[index] = 1;
  runtime.heatBearingPositions.fill(-1);
  runtime.hotPositions.fill(-1);
  return runtime;
}

function ensureThermalRuntime(ship) {
  const hadTopology = Boolean(ship.thermalTopology);
  const topology = ship.thermalTopology || buildThermalTopology(ship.design || []);
  if (!hadTopology) {
    ship.thermalTopology = topology;
    ship.thermalTopologyBuilds = (ship.thermalTopologyBuilds || 0) + 1;
  }
  if (!ship._thermalRuntime || ship._thermalRuntime.topology !== topology || ship._thermalRuntime.topology.componentCount !== topology.componentCount) {
    ship._thermalRuntime = createThermalRuntime(ship, topology);
    ship._thermalRuntime.topologyBuilds = hadTopology ? 0 : (ship.thermalTopologyBuilds || 1);
    ship._thermalRuntime.topologyCacheHits = hadTopology ? 1 : 0;
    ship._thermalRuntime.topologyShared = Boolean(ship._thermalTopologyShared);
  }
  const runtime = ship._thermalRuntime;
  return runtime;
}

function wakeHeatRuntime(ship) {
  const runtime = ship?._thermalRuntime;
  if (!runtime) return;
  if (runtime.stable) {
    runtime.stable = false;
    runtime.pendingWakeups += 1;
  }
}

function addLifecycleComponent(runtime, index) {
  if (!Number.isInteger(index) || index < 0 || index >= runtime.topology.componentCount) return;
  insertOrdered(runtime.lifecycleComponents, runtime.lifecycleMembership, index);
}

function setHeatBearingMembership(ship, index, value) {
  const runtime = ship?._thermalRuntime;
  if (!runtime) return;
  if (Number.isFinite(value) && value > 0) insertOrdered(runtime.heatBearingComponents, runtime.heatBearingMembership, index, runtime.heatBearingPositions);
  else removeOrdered(runtime.heatBearingComponents, runtime.heatBearingMembership, index, runtime.heatBearingPositions);
}

function setHotMembership(ship, index, alive, state) {
  const runtime = ship?._thermalRuntime;
  if (!runtime) return;
  if (alive && state >= STATE.HOT) insertOrdered(runtime.hotComponents, runtime.hotMembership, index, runtime.hotPositions);
  else removeOrdered(runtime.hotComponents, runtime.hotMembership, index, runtime.hotPositions);
}

function addPendingHeatInput(ship, index) {
  const runtime = ship?._thermalRuntime;
  if (!runtime) return;
  insertOrdered(runtime.pendingInputComponents, runtime.pendingInputMembership, index);
  wakeHeatRuntime(ship);
}

function clearPendingHeatInputs(runtime) {
  for (const index of runtime.pendingInputComponents) runtime.pendingInputMembership[index] = 0;
  runtime.pendingInputComponents.length = 0;
}

function refreshLoadedGeneratorComponents(ship) {
  const runtime = ship?._thermalRuntime;
  if (!runtime) return;
  const previousLoaded = runtime.loadedGeneratorComponents.length > 0;
  for (const index of runtime.loadedGeneratorComponents) runtime.loadedGeneratorMembership[index] = 0;
  runtime.loadedGeneratorComponents.length = 0;
  for (const index of runtime.topology.powerSourceIndices) {
    const part = PARTS[ship.design[index]?.type] || {};
    const alive = (ship.componentHp?.[index] ?? 1) > 0;
    const state = ship.componentHeatState?.[index] || STATE.NORMAL;
    const power = require("./componentPower").getComponentPowerMultiplier(ship, index);
    if (alive && part.powerGeneration > 0 && activeOutputForState(state) > 0 && power > 0) {
      insertOrdered(runtime.loadedGeneratorComponents, runtime.loadedGeneratorMembership, index);
    }
  }
  if (!previousLoaded && runtime.loadedGeneratorComponents.length > 0) wakeHeatRuntime(ship);
}

function refreshHeatRuntimeLists(ship) {
  const runtime = ensureThermalRuntime(ship);
  for (const index of runtime.heatBearingComponents) runtime.heatBearingMembership[index] = 0;
  for (const index of runtime.hotComponents) runtime.hotMembership[index] = 0;
  runtime.heatBearingComponents.length = 0;
  runtime.hotComponents.length = 0;
  runtime.heatBearingPositions.fill(-1);
  runtime.hotPositions.fill(-1);
  for (let index = 0; index < runtime.topology.componentCount; index += 1) {
    const value = Number(ship.componentHeat?.[index]);
    const alive = (ship.componentHp?.[index] ?? 1) > 0;
    setHeatBearingMembership(ship, index, value);
    setHotMembership(ship, index, alive, ship.componentHeatState?.[index] || STATE.NORMAL);
    runtime.lastHeatValues[index] = Number.isFinite(value) && value > 0 ? value : 0;
  }
  ship.hotComponentCount = runtime.hotComponents.length;
  runtime.overheatedComponentCount = runtime.hotComponents.reduce((count, index) => count + (ship.componentHeatState?.[index] === STATE.OVERHEATED ? 1 : 0), 0);
  ship.overheatedComponentCount = runtime.overheatedComponentCount;
  let totalHeat = 0;
  let totalCapacity = 0;
  for (let index = 0; index < runtime.topology.componentCount; index += 1) {
    if ((ship.componentHp?.[index] ?? 1) <= 0) continue;
    totalHeat += Math.max(0, Number(ship.componentHeat?.[index]) || 0);
    totalCapacity += Number(ship.componentThermals?.[index]?.capacity) || 0;
  }
  ship.currentHeat = totalHeat;
  ship.maxHeat = totalCapacity;
  ship.heatPressure = totalCapacity > 0 ? totalHeat / totalCapacity : 0;
  refreshLoadedGeneratorComponents(ship);
  return runtime;
}

function invalidateHeatRuntime(ship, flags = {}) {
  const runtime = ensureThermalRuntime(ship);
  runtime.lifecycleInvalidated = true;
  runtime.sourceStateDirty = true;
  runtime.networkDiagnosticsDirty = true;
  wakeHeatRuntime(ship);
  const indices = flags.componentIndices instanceof Set ? flags.componentIndices : null;
  if (indices) for (const index of indices) addLifecycleComponent(runtime, index);
  if (flags.exposure) {
    for (const index of runtime.topology.radiatorIndices) addLifecycleComponent(runtime, index);
    for (const index of runtime.topology.heatVentIndices) addLifecycleComponent(runtime, index);
  }
  if (flags.thermalRoutes) for (const index of runtime.topology.thermalRouteIndices) addLifecycleComponent(runtime, index);
  if (flags.activeCoolers) for (const index of runtime.topology.closedCycleCoolerIndices) addLifecycleComponent(runtime, index);
  if (flags.thermalCapacity && !indices) for (const index of runtime.topology.heatSinkIndices) addLifecycleComponent(runtime, index);
}

function thermalStable(ship) {
  const runtime = ship._thermalRuntime;
  if (!runtime || runtime.heatBearingComponents.length || runtime.pendingInputComponents.length || runtime.loadedGeneratorComponents.length || runtime.lifecycleInvalidated) return false;
  for (const index of runtime.topology.powerSourceIndices) {
    if ((Number(ship.componentMeltdown?.[index]) || 0) > 0) return false;
  }
  return true;
}

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
    ship.componentVentedOverflowHeatThisTick[index] = 0;
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
    const value6 = ship.componentVentedOverflowHeatThisTick[index] || 0;
    const values = runtime.telemetryValues;
    if (values[offset] !== value0) { values[offset] = value0; changed = true; }
    if (values[offset + 1] !== value1) { values[offset + 1] = value1; changed = true; }
    if (values[offset + 2] !== value2) { values[offset + 2] = value2; changed = true; }
    if (values[offset + 3] !== value3) { values[offset + 3] = value3; changed = true; }
    if (values[offset + 4] !== value4) { values[offset + 4] = value4; changed = true; }
    if (values[offset + 5] !== value5) { values[offset + 5] = value5; changed = true; }
    if (values[offset + 6] !== value6) { values[offset + 6] = value6; changed = true; }
    const nonZero = value0 !== 0 || value1 !== 0 || value2 !== 0 || value3 !== 0
      || value4 !== 0 || value5 !== 0 || value6 !== 0;
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

function findExteriorEmptyCells(cellOwners) {
  const occupied = [...cellOwners.keys()].map(key => key.split(",").map(Number));
  if (!occupied.length) return new Set();
  const xs = occupied.map(cell => cell[0]);
  const ys = occupied.map(cell => cell[1]);
  const minX = Math.min(...xs) - 1, maxX = Math.max(...xs) + 1;
  const minY = Math.min(...ys) - 1, maxY = Math.max(...ys) + 1;
  const exterior = new Set([`${minX},${minY}`]);
  const queue = [[minX, minY]];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const [x, y] = queue[cursor];
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy, key = `${nx},${ny}`;
      if (nx < minX || nx > maxX || ny < minY || ny > maxY || exterior.has(key) || cellOwners.has(key)) continue;
      exterior.add(key); queue.push([nx, ny]);
    }
  }
  return exterior;
}

// Exposure is runtime hull state: destroyed footprints are openings, while the
// immutable design/cell arrays remain untouched for stable protocol indexes.
function rebuildRuntimeExposure(ship) {
  if (!ship.componentThermals) return;
  const owners = new Map();
  const cellsByComponent = [];
  for (let i = 0; i < (ship.design || []).length; i += 1) {
    const module = ship.design[i];
    const cells = getOccupiedCells(module.x, module.y, PARTS[module.type]?.footprint || { width: 1, height: 1 }, module.rotation || 0);
    cellsByComponent[i] = cells;
    if ((ship.componentHp?.[i] ?? 1) > 0) for (const cell of cells) owners.set(`${cell.x},${cell.y}`, i);
  }
  const exterior = findExteriorEmptyCells(owners);
  for (let i = 0; i < cellsByComponent.length; i += 1) {
    let exposedEdges = 0;
    if ((ship.componentHp?.[i] ?? 1) > 0) for (const cell of cellsByComponent[i]) for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      if (owners.get(`${cell.x + dx},${cell.y + dy}`) === undefined && exterior.has(`${cell.x + dx},${cell.y + dy}`)) exposedEdges += 1;
    }
    if (ship.componentThermals[i].exposedEdges !== exposedEdges) ship.dirtyHeat?.add?.(i);
    ship.componentThermals[i].exposedEdges = exposedEdges;
  }
  ship.heatExposureBuilds = (ship.heatExposureBuilds || 0) + 1;
  wakeHeatRuntime(ship);
}

function initShipHeat(ship) {
  const design = ship.design || [];
  const hadTopology = Boolean(ship.thermalTopology);
  const topology = ship.thermalTopology || buildThermalTopology(design);
  ship.thermalTopology = topology;
  ship.thermalTopologyBuilds = (ship.thermalTopologyBuilds || 0) + (hadTopology ? 0 : 1);
  const runtime = createThermalRuntime(ship, topology);
  runtime.topologyBuilds = hadTopology ? 0 : (ship.thermalTopologyBuilds || 1);
  runtime.topologyCacheHits = hadTopology ? 1 : 0;
  runtime.topologyShared = Boolean(ship._thermalTopologyShared);
  ship._thermalRuntime = runtime;
  const cellOwners = new Map();
  const cellsByComponent = [];
  for (let i = 0; i < design.length; i += 1) {
    const module = design[i];
    const footprint = PARTS[module.type]?.footprint || { width: 1, height: 1 };
    const cells = getOccupiedCells(module.x, module.y, footprint, module.rotation || 0);
    cellsByComponent[i] = cells;
    for (const cell of cells) cellOwners.set(`${cell.x},${cell.y}`, i);
  }

  const exteriorEmpty = findExteriorEmptyCells(cellOwners);
  const exposedEdges = design.map(() => 0);
  for (let i = 0; i < cellsByComponent.length; i += 1) {
    for (const cell of cellsByComponent[i]) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const owner = cellOwners.get(`${cell.x + dx},${cell.y + dy}`);
        if (owner === undefined && exteriorEmpty.has(`${cell.x + dx},${cell.y + dy}`)) exposedEdges[i] += 1;
      }
    }
  }

  ship.componentThermals = design.map((module, i) => ({ ...profile(module.type, PARTS[module.type] || {}), exposedEdges: exposedEdges[i] }));
  ship.componentBaseHeatCapacity = ship.componentThermals.map(item => item.capacity);
  // Compact arrays indexed by immutable design index.
  ship.componentHeat = design.map(() => 0);
  ship.componentHeatCapacity = ship.componentThermals.map(item => item.capacity);
  ship.componentHeatState = design.map(() => STATE.NORMAL);
  ship.heatStateRevision = 1;
  ship.heatRevision = 1;
  ship.componentHeatRevision = 1;
  ship.heatTelemetryRevision = 1;
  ship._heatPowerSourceStates = ship.componentHeatState.slice();
  ship._heatDataSourceStates = ship.componentHeatState.slice();
  ship.componentHeatGenerated = design.map(() => 0);
  ship.componentHeatReceived = design.map(() => 0);
  ship.componentHeatRemoved = design.map(() => 0);
  ship.componentHeatTransferredOut = design.map(() => 0);
  ship.componentHeatCooled = design.map(() => 0);
  ship.componentHeatSentThroughFrame = design.map(() => 0);
  ship.componentHeatRadiated = design.map(() => 0);
  ship.componentVentedOverflowHeatThisTick = design.map(() => 0);
  ship.componentVentedOverflowHeat = ship.componentVentedOverflowHeatThisTick;
  ship.componentTotalVentedOverflowHeat = design.map(() => 0);
  ship.ventedOverflowHeatThisTick = 0;
  ship.ventedOverflowHeat = ship.ventedOverflowHeatThisTick;
  ship.totalVentedOverflowHeat = 0;
  ship.componentHeatInput = design.map(() => 0);
  ship.componentMeltdown = design.map(() => 0);
  ship.heatAccumulator = 0;
  ship.currentHeat = 0;
  recalculateEffectiveThermalCapacities(ship);
  refreshHeatSourceSignatures(ship);
  ship.heatPressure = 0;
  ship.hotComponentCount = 0;
  ship.overheatedComponentCount = 0;
  ship.hasPassiveHeatSource = design.some(module => (PARTS[module.type]?.powerGeneration || 0) > 0);
  ship.hasActiveHeat = ship.hasPassiveHeatSource;
  ship.hasPendingHeatInput = false;
  ship.heatAdjacencyBuilds = (ship.heatAdjacencyBuilds || 0) + 1;
  ship.dirtyHeat = new Set(design.map((_, i) => i));
  refreshHeatRuntimeLists(ship);
  ship.currentHeat = 0;
  ship.hotComponentCount = 0;
  ship.overheatedComponentCount = 0;
  rebuildThermalNetworks(ship);
}

function topologyNeighbourIndices(topology, index) {
  const neighbours = [];
  const start = topology?.incidentEdgeOffsets?.[index] ?? 0;
  const end = topology?.incidentEdgeOffsets?.[index + 1] ?? start;
  for (let offset = start; offset < end; offset += 1) {
    const edgeId = topology.incidentEdgeIds[offset];
    neighbours.push(topology.edgeA[edgeId] === index ? topology.edgeB[edgeId] : topology.edgeA[edgeId]);
  }
  return neighbours;
}

function recalculateEffectiveThermalCapacities(ship, changedSinkIndex = null) {
  if (!ship.componentThermals) return;
  const design = ship.design || [];
  const topology = ship.thermalTopology || buildThermalTopology(design);
  ship.thermalTopology = topology;
  if (!ship.componentBaseHeatCapacity || ship.componentBaseHeatCapacity.length !== design.length) {
    ship.componentBaseHeatCapacity = ship.componentThermals.map((thermal, index) => profile(design[index]?.type, PARTS[design[index]?.type] || {}).capacity || thermal.capacity || 0);
  }
  // A Heat Sink's thermal mass belongs to the Heat Sink. Neighbours no longer
  // inherit any of it: to use a sink's storage, heat has to actually reach it,
  // by direct conduction or through a Heat Pipe coolant network.
  const affected = changedSinkIndex === null ? design.map((_, i) => i)
    : [changedSinkIndex, ...topologyNeighbourIndices(topology, changedSinkIndex)];
  for (const i of new Set(affected)) {
    const max = Math.max(0, ship.componentMaxHp?.[i] || 0);
    const health = HeatRules.clamp(max > 0 ? ship.componentHp[i] / max : ((ship.componentHp?.[i] ?? 1) > 0 ? 1 : 0), 0, 1);
    const ownCapacity = design[i].type === "heatSink" ? ship.componentBaseHeatCapacity[i] * health : ship.componentBaseHeatCapacity[i];
    const capacity = Math.max(1, ownCapacity);
    ship.componentThermals[i].capacity = capacity;
    if (ship.componentHeatCapacity) ship.componentHeatCapacity[i] = capacity;
    // Capacity loss never deletes retained heat. Zero capacity with positive
    // heat is deterministically saturated rather than dividing by zero.
    // Destroyed components retain heat physically but do not broadcast an
    // operational warm/hot/critical/overheated state until repaired.
    if (ship.componentHeat && Number.isFinite(ship.componentHeat[i])) {
      const alive = (ship.componentHp?.[i] ?? 1) > 0;
      const physicalState = stateFor(capacity > 0 ? ship.componentHeat[i] / capacity : (ship.componentHeat[i] > 0 ? Infinity : 0), ship.componentHeatState[i]);
      const nextState = alive ? physicalState : STATE.NORMAL;
      if (nextState !== ship.componentHeatState[i]) ship.heatStateRevision = (ship.heatStateRevision || 0) + 1;
      ship.componentHeatState[i] = nextState;
    }
    ship.dirtyHeat?.add?.(i);
  }
  let totalHeat = 0;
  let totalCapacity = 0;
  for (let i = 0; i < design.length; i += 1) {
    if ((ship.componentHp?.[i] ?? 1) <= 0) continue;
    totalHeat += Math.max(0, Number(ship.componentHeat?.[i]) || 0);
    totalCapacity += ship.componentThermals[i].capacity;
  }
  ship.currentHeat = totalHeat;
  ship.maxHeat = totalCapacity;
  ship.heatPressure = totalCapacity > 0 ? totalHeat / totalCapacity : 0;
  if (ship._thermalRuntime) {
    refreshHeatRuntimeLists(ship);
    ship._thermalRuntime.networkDiagnosticsDirty = true;
    wakeHeatRuntime(ship);
  }
}

function rebuildThermalNetworks(ship) {
  const topology = ship.thermalTopology;
  if (!topology) return;
  const design = ship.design || [];
  const aliveFrames = new Set();
  for (let i = 0; i < design.length; i += 1) if (isThermalRouteType(design[i].type) && (ship.componentHp?.[i] ?? 1) > 0) aliveFrames.add(i);
  const visited = new Set();
  const networks = [];
  ship.componentThermalNetworks = design.map(() => []);
  ship.frameCoolingDistance = design.map(() => Infinity);
  for (const start of aliveFrames) {
    if (visited.has(start)) continue;
    const frames = [];
    const attached = new Set();
    const queue = [start]; visited.add(start);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor]; frames.push(index);
      for (const neighbour of topologyNeighbourIndices(topology, index)) {
        if (aliveFrames.has(neighbour)) {
          if (!visited.has(neighbour)) { visited.add(neighbour); queue.push(neighbour); }
        } else if ((ship.componentHp?.[neighbour] ?? 1) > 0) attached.add(neighbour);
      }
    }
    const members = new Set([...frames, ...attached]);
    const generators = [...attached].filter(i => HeatRules.activityHeat(design[i].type, PARTS[design[i].type] || {}) > 0);
    const sinks = [...attached].filter(i => design[i].type === "heatSink");
    const radiators = [...attached].filter(i => design[i].type === "radiator");
    const heatVents = [...attached].filter(i => design[i].type === "heatVent");
    const closedCycleCoolers = [...attached].filter(i => design[i].type === "closedCycleCooler");
    const heatPipeIndices = frames.filter(i => isCoolantTransportType(design[i].type));
    const frameOnlyIndices = frames.filter(i => !isCoolantTransportType(design[i].type));
    const id = networks.length;
    for (const index of members) ship.componentThermalNetworks[index].push(id);
    const connectedFrameCells = frames.map(index => ({ index, x: design[index].x, y: design[index].y }));
    networks.push({ id, frameIndices: frames, heatPipeIndices, frameOnlyIndices, connectedFrameCells, attachedComponents: [...attached], generators, sinks, radiators, heatVents, closedCycleCoolers, totalStoredHeat: 0, totalStorageCapacity: 0, totalCoolingCapacity: 0, totalCooling: 0, overloaded: false });

    // Cached hop distance from each transfer tile to the nearest cooling
    // component. This is a diagnostic only — it never scales transfer or drains
    // heat, and since the redesign no route type earns a conductivity boost from
    // it. A Burst Cooler counts here even though it removes almost nothing
    // continuously: a run has to reach it for the accumulator to have anything
    // to vent.
    const burstCoolers = [...attached].filter(i => PARTS[design[i].type]?.burstCooler);
    const coolers = new Set([...sinks, ...radiators, ...heatVents, ...closedCycleCoolers, ...burstCoolers]);
    const distanceQueue = [];
    for (const frame of frames) {
      const touchesCooling = topologyNeighbourIndices(topology, frame).some((neighbour) => coolers.has(neighbour));
      if (touchesCooling) { ship.frameCoolingDistance[frame] = 0; distanceQueue.push(frame); }
    }
    for (let cursor = 0; cursor < distanceQueue.length; cursor += 1) {
      const frame = distanceQueue[cursor];
      const nextDistance = ship.frameCoolingDistance[frame] + 1;
      for (const neighbour of topologyNeighbourIndices(topology, frame)) {
        if (!frames.includes(neighbour) || nextDistance >= ship.frameCoolingDistance[neighbour]) continue;
        ship.frameCoolingDistance[neighbour] = nextDistance;
        distanceQueue.push(neighbour);
      }
    }
  }
  ship.thermalNetworks = networks;
  ship.thermalNetworkBuilds = (ship.thermalNetworkBuilds || 0) + 1;
  rebuildCoolantNetworks(ship);
  if (ship._thermalRuntime) {
    ship._thermalRuntime.networkDiagnosticsDirty = true;
    if (ship.componentHeat && ship.componentHeatState) refreshHeatRuntimeLists(ship);
  }
  wakeHeatRuntime(ship);
}

function findAttachmentSharedEdges(topology, pipeIndex, attachmentIndex) {
  const start = topology.incidentEdgeOffsets[pipeIndex];
  const end = topology.incidentEdgeOffsets[pipeIndex + 1];
  for (let offset = start; offset < end; offset += 1) {
    const edgeId = topology.incidentEdgeIds[offset];
    const other = topology.edgeA[edgeId] === pipeIndex ? topology.edgeB[edgeId] : topology.edgeA[edgeId];
    if (other === attachmentIndex) return topology.edgeSharedEdges[edgeId];
  }
  return 1;
}

// Coolant networks are the ship's dedicated thermal transport: one network per
// connected group of living Heat Pipes, plus every living component touching
// one of those pipes on an orthogonal tile edge. Membership is purely
// adjacency-derived — no rotation, ports or player-configured direction — and a
// destroyed pipe simply drops out, splitting the network it used to join.
function rebuildCoolantNetworks(ship) {
  const topology = ship.thermalTopology;
  if (!topology) {
    ship.coolantNetworks = [];
    return;
  }
  const design = ship.design || [];
  const alivePipes = new Set();
  for (let i = 0; i < design.length; i += 1) {
    if (isCoolantTransportType(design[i].type) && (ship.componentHp?.[i] ?? 1) > 0) alivePipes.add(i);
  }
  const visited = new Set();
  const networks = [];
  for (const start of alivePipes) {
    if (visited.has(start)) continue;
    const pipes = [];
    const queue = [start]; visited.add(start);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor]; pipes.push(index);
      for (const neighbour of topologyNeighbourIndices(topology, index)) {
        if (alivePipes.has(neighbour) && !visited.has(neighbour)) { visited.add(neighbour); queue.push(neighbour); }
      }
    }
    // A component touching several pipes of the same network attaches once, with
    // its shared-edge count summed: more contact means more throughput, but the
    // component is still a single participant in the solve.
    const attached = [];
    const attachedPosition = new Map();
    for (const pipeIndex of pipes) {
      for (const neighbour of topologyNeighbourIndices(topology, pipeIndex)) {
        if (alivePipes.has(neighbour)) continue;
        if ((ship.componentHp?.[neighbour] ?? 1) <= 0) continue;
        const sharedEdges = findAttachmentSharedEdges(topology, pipeIndex, neighbour);
        const existing = attachedPosition.get(neighbour);
        if (existing === undefined) {
          attachedPosition.set(neighbour, attached.length);
          attached.push({ index: neighbour, pipeIndex, sharedEdges });
        } else {
          attached[existing].sharedEdges += sharedEdges;
        }
      }
    }
    networks.push({ id: networks.length, pipeIndices: pipes, attachments: attached });
  }
  ship.coolantNetworks = networks;
  ship.coolantNetworkBuilds = (ship.coolantNetworkBuilds || 0) + 1;
}

function addComponentHeat(ship, index, amount) {
  if (!ship.componentHeatInput || !Number.isFinite(amount) || amount <= 0) return;
  if (index < 0 || index >= ship.componentHeatInput.length) return;
  ship.componentHeatInput[index] += amount;
  addPendingHeatInput(ship, index);
  ship.hasPendingHeatInput = true;
  ship.hasActiveHeat = true;
}

function distributeComponentHeatByWeight(ship, contributions, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const heatInputLength = ship?.componentHeatInput?.length || 0;
  if (!heatInputLength || !Array.isArray(contributions)) return 0;

  const weightsByIndex = new Map();
  for (const contribution of contributions) {
    const index = contribution?.index;
    if (!Number.isInteger(index) || index < 0 || index >= heatInputLength) continue;
    if ((ship.componentHp?.[index] ?? 1) <= 0) continue;
    const rawWeight = contribution.weight ?? contribution.capacity;
    const weight = Number(rawWeight);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    weightsByIndex.set(index, (weightsByIndex.get(index) || 0) + weight);
  }

  const valid = [...weightsByIndex.entries()]
    .filter(([, weight]) => Number.isFinite(weight) && weight > 0)
    .map(([index, weight]) => ({ index, weight }));
  const totalWeight = valid.reduce((sum, contribution) => sum + contribution.weight, 0);
  if (!valid.length || !Number.isFinite(totalWeight) || totalWeight <= 0) return 0;

  let distributed = 0;
  for (let i = 0; i < valid.length; i += 1) {
    const share = i === valid.length - 1
      ? amount - distributed
      : amount * valid[i].weight / totalWeight;
    distributed += share;
    addComponentHeat(ship, valid[i].index, share);
  }
  return distributed;
}

function powerSourceHeatSignature(ship) {
  return (ship.componentHeat || []).map((_, i) => {
    if ((PARTS[ship.design[i].type]?.powerGeneration || 0) <= 0) return null;
    const alive = (ship.componentHp?.[i] ?? 1) > 0;
    return `${i}:${alive ? 1 : 0}:${alive && ship.componentHeatState[i] === STATE.OVERHEATED ? 1 : 0}`;
  }).filter(Boolean).join(",");
}

function dataSourceHeatSignature(ship) {
  const dataRules = require("../../public/src/shared/dataSupportRules");
  return (ship.componentHeat || []).map((_, i) => {
    if (!dataRules.isDataSupportSource(ship.design[i]?.type)) return null;
    const alive = (ship.componentHp?.[i] ?? 1) > 0;
    return `${i}:${alive ? 1 : 0}:${alive ? ship.componentHeatState[i] : STATE.NORMAL}:${alive ? activeOutputForState(ship.componentHeatState[i]) : 0}`;
  }).filter(Boolean).join(",");
}

function refreshHeatSourceSignatures(ship) {
  ship._heatPowerSourceSignature = powerSourceHeatSignature(ship);
  ship._heatDataSourceSignature = dataSourceHeatSignature(ship);
  ship._heatPowerSourceStates = ship.componentHeatState?.slice?.() || [];
  ship._heatDataSourceStates = ship.componentHeatState?.slice?.() || [];
  ship._heatPowerSourceAlive = (ship.componentHeatState || []).map((_, index) => ((ship.componentHp?.[index] ?? 1) > 0 ? 1 : 0));
  ship._heatDataSourceAlive = ship._heatPowerSourceAlive.slice();
}

function componentPerformance(ship, index) {
  return activeOutputForState(ship.componentHeatState?.[index] || STATE.NORMAL);
}


// A reactor pinned at the overheat failure state (heat >= capacity) for this long
// melts down and explodes. The delay telegraphs the failure and prevents a single
// spike from instantly chaining through a reactor bank. The constants live in the
// shared HeatRules so the designer's meltdown prediction uses the same values.
const { REACTOR_MELTDOWN_SECONDS, REACTOR_EXPLOSION_RADIUS, REACTOR_EXPLOSION_DAMAGE } = HeatRules;

function resetHeatScratch(runtime) {
  for (const index of runtime.touchedComponents) {
    runtime.delta[index] = 0;
    runtime.workingHeat[index] = 0;
    runtime.outflow[index] = 0;
    runtime.touchedMembership[index] = 0;
  }
  for (const index of runtime.workComponents) runtime.workMembership[index] = 0;
  runtime.touchedComponents.length = 0;
  runtime.workComponents.length = 0;
  runtime.candidateEdgeIds.length = 0;
  runtime.transferCount = 0;
}

function addHeatWorkComponent(ship, index) {
  const runtime = ship._thermalRuntime;
  syncExternalHeatAggregate(ship, index);
  if (!insertOrdered(runtime.workComponents, runtime.workMembership, index)) return;
  if (!runtime.touchedMembership[index]) {
    runtime.delta[index] = 0;
    runtime.workingHeat[index] = Math.max(0, Number(ship.componentHeat[index]) || 0);
    runtime.outflow[index] = 0;
  }
  insertOrdered(runtime.touchedComponents, runtime.touchedMembership, index);
}

function touchHeatNeighbour(ship, index) {
  const runtime = ship._thermalRuntime;
  syncExternalHeatAggregate(ship, index);
  if (!runtime.touchedMembership[index]) {
    runtime.delta[index] = 0;
    runtime.workingHeat[index] = Math.max(0, Number(ship.componentHeat[index]) || 0);
    runtime.outflow[index] = 0;
    insertOrdered(runtime.touchedComponents, runtime.touchedMembership, index);
  }
}

// Public/debug fixtures in the existing server suite sometimes write directly
// to componentHeat instead of going through a lifecycle helper.  Keep the
// incremental aggregate exact for those writes when the component is already
// in the sparse work set, without restoring a full design reduction each tick.
function syncExternalHeatAggregate(ship, index) {
  const runtime = ship._thermalRuntime;
  const current = Math.max(0, Number(ship.componentHeat?.[index]) || 0);
  const previous = runtime.lastHeatValues[index] || 0;
  if (current === previous) return;
  if ((ship.componentHp?.[index] ?? 1) > 0) ship.currentHeat = (ship.currentHeat || 0) + current - previous;
  runtime.lastHeatValues[index] = current;
}

function buildHeatWorkSet(ship) {
  const runtime = ship._thermalRuntime;
  for (const index of runtime.heatBearingComponents) addHeatWorkComponent(ship, index);
  for (const index of runtime.pendingInputComponents) addHeatWorkComponent(ship, index);
  for (const index of runtime.loadedGeneratorComponents) addHeatWorkComponent(ship, index);
  for (const index of runtime.lifecycleComponents) addHeatWorkComponent(ship, index);
  for (const index of runtime.topology.powerSourceIndices) {
    if ((Number(ship.componentMeltdown?.[index]) || 0) > 0) addHeatWorkComponent(ship, index);
  }
}

// Stored heat plus anything generated earlier this tick, for a component that
// may or may not already be in the sparse work set.
function pendingComponentHeat(ship, runtime, index) {
  const stored = Math.max(0, Number(ship.componentHeat?.[index]) || 0);
  return runtime.touchedMembership[index] ? Math.max(0, stored + runtime.delta[index]) : stored;
}

function coolantNetworkHasHeat(ship, runtime, network) {
  for (const pipeIndex of network.pipeIndices) {
    if ((ship.componentHp?.[pipeIndex] ?? 1) <= 0) continue;
    if (pendingComponentHeat(ship, runtime, pipeIndex) > 0) return true;
  }
  for (const attachment of network.attachments) {
    if ((ship.componentHp?.[attachment.index] ?? 1) <= 0) continue;
    if (pendingComponentHeat(ship, runtime, attachment.index) > 0) return true;
  }
  return false;
}

// One coolant-transport step per network. Heat Pipes remove no heat here: every
// unit that leaves one participant arrives at another in the same network, so
// the solve is exactly heat-conserving. Flow direction is derived from the
// participants' relative heat ratios, and is bounded by the shared throughput
// rules in HeatRules.solveCoolantNetwork.
function solveCoolantNetworks(ship, elapsed) {
  const networks = ship.coolantNetworks;
  if (!networks || networks.length === 0) return;
  const runtime = ship._thermalRuntime;
  if (!runtime) return;

  for (const network of networks) {
    network.transportedHeat = 0;
    // A network where nothing holds heat can only produce zero flows, so skip it
    // before touching anything: the sparse work set must not grow by one entry
    // per pipe tile on every solved tick of an idle ship.
    if (!coolantNetworkHasHeat(ship, runtime, network)) continue;
    const alivePipes = [];
    let pipeHeat = 0;
    let pipeCapacity = 0;
    for (const pipeIndex of network.pipeIndices) {
      if ((ship.componentHp?.[pipeIndex] ?? 1) <= 0) continue;
      touchHeatNeighbour(ship, pipeIndex);
      alivePipes.push(pipeIndex);
      pipeHeat += Math.max(0, runtime.workingHeat[pipeIndex]);
      pipeCapacity += Math.max(1, ship.componentThermals[pipeIndex].capacity);
    }
    if (alivePipes.length === 0) continue;

    // Participant 0..n-1 are the attachments; the pipe tiles follow as one node.
    const attachments = [];
    const participants = [];
    let pipeNodeConductance = 0;
    let pipeNodeBandwidth = 0;
    for (const attachment of network.attachments) {
      const index = attachment.index;
      if ((ship.componentHp?.[index] ?? 1) <= 0) continue;
      touchHeatNeighbour(ship, index);
      const conductance = coolantEdgeConductance(attachment.sharedEdges);
      const bandwidth = coolantEdgeBandwidth(attachment.sharedEdges);
      pipeNodeConductance += conductance;
      pipeNodeBandwidth += bandwidth;
      attachments.push(attachment);
      participants.push({
        heat: Math.max(0, runtime.workingHeat[index]),
        capacity: Math.max(1, ship.componentThermals[index].capacity),
        conductance,
        bandwidth
      });
    }
    if (attachments.length === 0) continue;
    // The coolant in the pipes is always fully coupled to the network it forms,
    // so the pipe node's conductance is the sum of its attachments'. Its tiny
    // capacity is what keeps pipes from acting as storage.
    participants.push({ heat: pipeHeat, capacity: pipeCapacity, conductance: pipeNodeConductance, bandwidth: pipeNodeBandwidth });

    const deltas = solveCoolantNetwork(participants, elapsed);
    for (let k = 0; k < attachments.length; k += 1) {
      const delta = deltas[k];
      if (delta === 0) continue;
      const index = attachments[k].index;
      runtime.delta[index] += delta;
      runtime.workingHeat[index] += delta;
      if (delta > 0) {
        ship.componentHeatReceived[index] += delta;
        network.transportedHeat += delta;
      } else {
        ship.componentHeatTransferredOut[index] += -delta;
      }
    }

    // The pipe node's own change is split across its tiles: heat arriving fills
    // them in proportion to capacity, heat leaving drains them in proportion to
    // what each one actually holds, so no tile can be driven negative.
    const pipeDelta = deltas[deltas.length - 1];
    const weightTotal = pipeDelta > 0 ? pipeCapacity : pipeHeat;
    if (pipeDelta !== 0 && weightTotal > 0) {
      let assigned = 0;
      for (let k = 0; k < alivePipes.length; k += 1) {
        const pipeIndex = alivePipes[k];
        const weight = pipeDelta > 0
          ? Math.max(1, ship.componentThermals[pipeIndex].capacity)
          : Math.max(0, runtime.workingHeat[pipeIndex]);
        const share = k === alivePipes.length - 1 ? pipeDelta - assigned : pipeDelta * (weight / weightTotal);
        assigned += share;
        runtime.delta[pipeIndex] += share;
        runtime.workingHeat[pipeIndex] += share;
        if (share > 0) ship.componentHeatReceived[pipeIndex] += share;
        else if (share < 0) ship.componentHeatTransferredOut[pipeIndex] += -share;
      }
    }
  }
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

// --- Burst cooling ------------------------------------------------------------
//
// Every other cooling component in the catalogue is either a sustained remover
// (Radiator, Closed-Cycle Cooler) or a passive buffer (Heat Sink). A Burst
// Cooler is neither: it charges from the Heat network like a buffer and then
// dumps its whole store in a single tick, after which it is nearly useless for
// several seconds. That gives a Blueprint an answer to alpha-strike Heat spikes
// without giving it more sustained cooling, which is the behaviour the existing
// parts could not express.
//
// The recharge window is counted in simulated seconds rather than against the
// wall clock so the behaviour is identical under a fixed timestep, a replay and
// a test harness that never supplies a timestamp.

function burstCoolerConfig(ship, index) {
  const config = PARTS[ship.design?.[index]?.type]?.burstCooler;
  return config && config.burstHeat > 0 ? config : null;
}

function updateBurstCooler(ship, index, thermal, heat, runtime, elapsed) {
  const config = burstCoolerConfig(ship, index);
  if (!config) return;
  if (!(ship.componentBurstCoolerRecharge instanceof Float64Array)
    || ship.componentBurstCoolerRecharge.length !== ship.design.length) {
    ship.componentBurstCoolerRecharge = new Float64Array(ship.design.length);
  }
  const recharge = ship.componentBurstCoolerRecharge;
  if (recharge[index] > 0) {
    recharge[index] = Math.max(0, recharge[index] - elapsed);
    return;
  }
  const alive = (ship.componentHp?.[index] ?? 1) > 0;
  if (!alive) return;
  const { getComponentPowerMultiplier } = require("./componentPower");
  const power = getComponentPowerMultiplier(ship, index);
  if (power <= 0) return;
  const stored = Math.max(0, heat[index] + runtime.delta[index]);
  const capacity = Math.max(1, thermal.capacity);
  if (stored / capacity < config.triggerHeatRatio) return;
  const vented = Math.min(stored, config.burstHeat * power);
  if (vented <= 0) return;
  runtime.delta[index] -= vented;
  ship.componentHeatRemoved[index] += vented;
  ship.componentHeatCooled[index] += vented;
  recharge[index] = config.rechargeSeconds;
}

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
  // Heat value directly.  Reconcile that compatibility hint once when the
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
    ship.ventedOverflowHeatThisTick = 0;
    ship.ventedOverflowHeat = ship.ventedOverflowHeatThisTick;
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
  ship.ventedOverflowHeatThisTick = 0;
  ship.ventedOverflowHeat = ship.ventedOverflowHeatThisTick;
  const heat = ship.componentHeat;
   buildHeatWorkSet(ship);
  const pendingInputCount = runtime.pendingInputComponents.length;

  let generationStart = performanceNow();
  for (const index of runtime.workComponents) {
    const alive = (ship.componentHp?.[index] ?? 1) > 0;
    const part = PARTS[ship.design[index].type] || {};
    const thermal = ship.componentThermals[index];
    const damagedMultiplier = alive && ship.componentMaxHp?.[index]
      ? 1 + 0.15 * (1 - ship.componentHp[index] / ship.componentMaxHp[index])
      : 1;
    const power = part.powerGeneration > 0 ? require("./componentPower").getComponentPowerMultiplier(ship, index) : 1;
    const load = alive && activeOutputForState(ship.componentHeatState?.[index] || STATE.NORMAL) > 0 ? power : 0;
    const steady = alive && part.powerGeneration > 0 ? (2 + part.powerGeneration * 0.42) * load * elapsed * damagedMultiplier : 0;
    const generated = alive ? ship.componentHeatInput[index] * damagedMultiplier + steady : 0;
    ship.componentHeatInput[index] = 0;
    ship.componentHeatGenerated[index] = generated;
    runtime.delta[index] += generated;
    // Keep the local thermal variable referenced in this phase so future
    // catalogue additions cannot accidentally make a missing profile silent.
    void thermal;
  }
  clearPendingHeatInputs(runtime);

  recordDuration(room, "heatGenerationMs", generationStart);

  for (const index of runtime.workComponents) runtime.workingHeat[index] = Math.max(0, heat[index] + runtime.delta[index]);

  const topology = runtime.topology;
  runtime.edgeVisitToken = (runtime.edgeVisitToken + 1) >>> 0;
  if (runtime.edgeVisitToken === 0) {
    runtime.edgeVisitStamps.fill(0);
    runtime.edgeVisitToken = 1;
  }
  const edgeToken = runtime.edgeVisitToken;
  for (const index of runtime.workComponents) {
    const start = topology.incidentEdgeOffsets[index];
    const end = topology.incidentEdgeOffsets[index + 1];
    for (let offset = start; offset < end; offset += 1) {
      const edgeId = topology.incidentEdgeIds[offset];
      if (runtime.edgeVisitStamps[edgeId] === edgeToken) continue;
      runtime.edgeVisitStamps[edgeId] = edgeToken;
      runtime.candidateEdgeIds.push(edgeId);
    }
  }
  const transferRank = topology.transferRank;
  runtime.candidateEdgeIds.sort((left, right) =>
    transferRank[left] - transferRank[right] || left - right
  );

  solveCoolantNetworks(ship, elapsed);

  let transferStart = performanceNow();
  let transferCount = 0;
  for (const edgeId of runtime.candidateEdgeIds) {
    const i = topology.edgeA[edgeId];
    const j = topology.edgeB[edgeId];
    const typeI = ship.design[i]?.type;
    const typeJ = ship.design[j]?.type;
    // Heat Pipes exchange heat only through their coolant network, solved above.
    if (isCoolantTransportType(typeI) || isCoolantTransportType(typeJ)) continue;
    touchHeatNeighbour(ship, i);
    touchHeatNeighbour(ship, j);
    const aliveI = (ship.componentHp?.[i] ?? 1) > 0;
    const aliveJ = (ship.componentHp?.[j] ?? 1) > 0;
    if ((!aliveI && isThermalRouteType(ship.design[i].type)) || (!aliveJ && isThermalRouteType(ship.design[j].type))) continue;
    // Local physical conduction only. Material differences already live in the
    // base edge conductivity, so a long frame chain conducts like metal — it is
    // no longer a boosted stand-in for a Heat Pipe run.
    const conductivity = (!aliveI || !aliveJ) ? HeatRules.CONDUCTIVITY.destroyed : topology.edgeBaseConductivity[edgeId];
    const transfer = edgeTransfer(
      runtime.workingHeat[i], ship.componentThermals[i].capacity,
      runtime.workingHeat[j], ship.componentThermals[j].capacity,
      conductivity, topology.edgeSharedEdges[edgeId], elapsed
    );
    if (transfer === 0) continue;
    runtime.transferEdgeIds[transferCount] = edgeId;
    runtime.transferAmounts[transferCount] = transfer;
    runtime.outflow[transfer > 0 ? i : j] += Math.abs(transfer);
    transferCount += 1;
  }
  runtime.transferCount = transferCount;
  bump(room, "heatEdgesVisited", runtime.candidateEdgeIds.length);

  let transfersApplied = 0;
  for (let transferIndex = 0; transferIndex < transferCount; transferIndex += 1) {
    const edgeId = runtime.transferEdgeIds[transferIndex];
    const i = topology.edgeA[edgeId];
    const j = topology.edgeB[edgeId];
    const pendingTransfer = runtime.transferAmounts[transferIndex];
    const source = pendingTransfer > 0 ? i : j;
    const scale = runtime.outflow[source] > runtime.workingHeat[source]
      ? runtime.workingHeat[source] / runtime.outflow[source] : 1;
    const transfer = pendingTransfer * scale;
    runtime.delta[i] -= transfer;
    runtime.delta[j] += transfer;
    if (transfer > 0) {
      ship.componentHeatTransferredOut[i] += transfer;
      ship.componentHeatReceived[j] += transfer;
      if (topology.edgeThroughFrame[edgeId]) ship.componentHeatSentThroughFrame[i] += transfer;
    } else if (transfer < 0) {
      ship.componentHeatReceived[i] -= transfer;
      ship.componentHeatTransferredOut[j] -= transfer;
      if (topology.edgeThroughFrame[edgeId]) ship.componentHeatSentThroughFrame[j] -= transfer;
    }
    transfersApplied += 1;
  }
  bump(room, "heatTransfersApplied", transfersApplied);
  recordDuration(room, "heatTransferMs", transferStart);

  let coolingStart = performanceNow();
  const heatDissipationMult = getCommandAuraMultiplier(ship, "heatDissipationMultiplier");
  const overheatRecoveryMult = getCommandAuraMultiplier(ship, "overheatRecoveryMultiplier");
  const { getComponentPowerMultiplier } = require("./componentPower");
  for (const index of runtime.touchedComponents) {
    const thermal = ship.componentThermals[index];
    let coolingRate = thermal.cooling * thermal.retention * heatDissipationMult;
    if (ship.design[index].type === "radiator") {
      const alive = (ship.componentHp?.[index] ?? 1) > 0;
      const exposure = thermal.exposedEdges > 0 ? RADIATOR_EXPOSED_MULTIPLIER : RADIATOR_ENCLOSED_MULTIPLIER;
      const power = getComponentPowerMultiplier(ship, index);
      const active = alive ? thermal.cooling * activeCoolingForState(ship.componentHeatState?.[index] || STATE.NORMAL) * power : 0;
      const passiveFloor = thermal.cooling * RADIATOR_PASSIVE_COOLING_FRACTION;
      coolingRate = Math.max(passiveFloor, active) * exposure * thermal.retention * heatDissipationMult;
    } else if (ship.design[index].type === "heatVent") {
      // Passive hull grille: no Power, no heat-state scaling, and almost nothing
      // at all unless at least one of its edges opens onto space.
      const exposure = thermal.exposedEdges > 0 ? HEAT_VENT_EXPOSED_MULTIPLIER : HEAT_VENT_ENCLOSED_MULTIPLIER;
      coolingRate = thermal.cooling * exposure * thermal.retention * heatDissipationMult;
    } else if (ship.design[index].type === "closedCycleCooler") {
      const power = getComponentPowerMultiplier(ship, index);
      const active = thermal.cooling * activeCoolingForState(ship.componentHeatState?.[index] || STATE.NORMAL) * power;
      const passiveFloor = thermal.passiveCooling;
      coolingRate = Math.max(passiveFloor, active) * thermal.retention * heatDissipationMult;
    } else if (burstCoolerConfig(ship, index)) {
      // A Burst Cooler removes almost nothing continuously; its whole output is
      // the vent below. While recharging it drops to a trickle of its rating.
      const config = burstCoolerConfig(ship, index);
      const recharging = (ship.componentBurstCoolerRecharge?.[index] || 0) > 0;
      coolingRate = thermal.cooling * (recharging ? config.rechargeCoolingFraction : 1) * thermal.retention * heatDissipationMult;
    } else if (thermal.exposedEdges > 0) coolingRate *= 1.12;
    const ratio = Math.max(0, (heat[index] + runtime.delta[index]) / Math.max(1, thermal.capacity));
    const tempFactor = 0.7 + 0.9 * ratio * ratio;
    coolingRate *= tempFactor;
    const currentState = ship.componentHeatState?.[index];
    if (currentState >= STATE.CRITICAL && overheatRecoveryMult > 1) coolingRate *= overheatRecoveryMult;
    const removed = Math.min(Math.max(0, heat[index] + runtime.delta[index]), coolingRate * elapsed);
    ship.componentHeatRemoved[index] += removed;
    ship.componentHeatCooled[index] += removed;
    // Radiators and Heat Vents are the two parts that reject heat outside the
    // hull, so both report through the radiated telemetry channel.
    if (ship.design[index].type === "radiator" || ship.design[index].type === "heatVent") ship.componentHeatRadiated[index] = removed;
    runtime.delta[index] -= removed;
    updateBurstCooler(ship, index, thermal, heat, runtime, elapsed);
  }
  recordDuration(room, "heatCoolingMs", coolingStart);

  let finalizationStart = performanceNow();
  let componentHeatChanged = false;
  let powerSourceStateChanged = false;
  let dataSourceStateChanged = false;
  let meltdowns = null;
  if (!ship.componentMeltdown) ship.componentMeltdown = heat.map(() => 0);
  for (const index of runtime.touchedComponents) {
    const alive = (ship.componentHp?.[index] ?? 1) > 0;
    const capacity = ship.componentThermals[index].capacity;
    const oldHeat = Math.max(0, Number(heat[index]) || 0);
    const retainedCeiling = Math.max(capacity * 1.25, heat[index]);
    const unclampedNext = Math.max(0, heat[index] + runtime.delta[index]);
    const next = Math.min(retainedCeiling, unclampedNext);
    const overflow = Math.max(0, unclampedNext - next);
    if (overflow > 0) {
      ship.componentVentedOverflowHeatThisTick[index] += overflow;
      ship.componentVentedOverflowHeat = ship.componentVentedOverflowHeatThisTick;
      ship.componentTotalVentedOverflowHeat[index] = (ship.componentTotalVentedOverflowHeat[index] || 0) + overflow;
      ship.ventedOverflowHeatThisTick += overflow;
      ship.ventedOverflowHeat = ship.ventedOverflowHeatThisTick;
      ship.totalVentedOverflowHeat = (ship.totalVentedOverflowHeat || 0) + overflow;
      ship.componentHeatRemoved[index] += overflow;
    }
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
    if (alive) ship.currentHeat += next - oldHeat;
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
  ship.currentHeat = Math.max(0, ship.currentHeat);
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
  if (powerSourceStateChanged) require("./componentPower").reallocateShipPower(ship, "thermal-source-state");
  else if (dataSourceStateChanged) require("./componentData").refreshShipDataAllocation(ship, "thermal-data-source-state");
  refreshLoadedGeneratorComponents(ship);
  runtime.lifecycleInvalidated = false;
  runtime.sourceStateDirty = false;
  for (const index of runtime.lifecycleComponents) runtime.lifecycleMembership[index] = 0;
  runtime.lifecycleComponents.length = 0;

  updateHeatNetworkDiagnostics(ship, elapsed);
  const telemetryChanged = finishSparseTelemetryStep(ship, previousTelemetry, runtime.telemetryCandidateComponents);
  if (telemetryChanged) ship.heatTelemetryRevision = (ship.heatTelemetryRevision || 0) + 1;
  recordDuration(room, "heatFinalizationMs", finalizationStart);
  bump(room, "heatComponentsVisited", runtime.touchedComponents.length);
  bump(room, "heatBearingComponents", runtime.heatBearingComponents.length);
  bump(room, "heatHotComponents", runtime.hotComponents.length);
  bump(room, "heatPendingInputComponents", pendingInputCount);
  bump(room, "heatLoadedGeneratorComponents", runtime.loadedGeneratorComponents.length);
  ship.hasActiveHeat = runtime.heatBearingComponents.length > 0 || ship.hasPassiveHeatSource;

  // Resolve reactor meltdowns only after all thermal state and telemetry are
  // settled, preserving the authoritative lifecycle boundary.
  if (meltdowns && room) {
    const { detonateComponent } = require("./componentHealth");
    for (const index of meltdowns) {
      if (ship.componentHp[index] <= 0) continue;
      ship.componentMeltdown[index] = 0;
      const part = PARTS[ship.design[index].type] || {};
      const radius = part.meltdownRadius ?? REACTOR_EXPLOSION_RADIUS;
      const damage = part.meltdownDamage ?? REACTOR_EXPLOSION_DAMAGE;
      detonateComponent(room, ship, index, radius, damage, now);
    }
    if (ship.alive && (ship.hp <= 0.001 || ship.coreDestroyed)) require("./combat").destroyShip(room, ship, ship.lastDamagedBy || null, now);
  }
  recordDuration(room, "heatRuntimeMs", runtimeStart);
}

function updateShipHeat(ship, dt, room, now) {
  const previousHeatStateRevision = Number(ship?.heatStateRevision) || 0;
  const previousHeatRevision = Number(ship?.heatRevision) || 0;
  const result = updateShipHeatCore(ship, dt, room, now);
  if (room && (previousHeatStateRevision !== (Number(ship?.heatStateRevision) || 0)
    || previousHeatRevision !== (Number(ship?.heatRevision) || 0))) {
    require("./commandAuras").invalidateCommandAuraSource(room, ship, "heat-state");
  }
  return result;
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
    ventedOverflowHeat: ship.ventedOverflowHeat || 0,
    ventedOverflowHeatThisTick: ship.ventedOverflowHeatThisTick || 0,
    totalVentedOverflowHeat: ship.totalVentedOverflowHeat || 0,
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
      ventedOverflowHeatPerSecond: (ship.componentVentedOverflowHeatThisTick?.[index] || 0) / dt,
      totalVentedOverflowHeat: ship.componentTotalVentedOverflowHeat?.[index] || 0,
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

function effectiveComponentBonus(ship, propertyName, predicate) {
  const { getComponentPowerMultiplier } = require("./componentPower");
  let total = 0;
  for (let i = 0; i < (ship.design || []).length; i += 1) {
    if ((ship.componentHp?.[i] ?? 1) <= 0) continue;
    const placed = ship.design[i];
    const part = PARTS[placed.type] || {};
    if (predicate && !predicate(part, placed, i)) continue;
    total += (part[propertyName] || 0) * componentPerformance(ship, i) * getComponentPowerMultiplier(ship, i);
  }
  return total;
}

module.exports = {
  STATE,
  initShipHeat,
  ensureThermalRuntime,
  wakeHeatRuntime,
  rebuildRuntimeExposure,
  rebuildThermalNetworks,
  recalculateEffectiveThermalCapacities,
  refreshHeatSourceSignatures,
  refreshHeatRuntimeLists,
  refreshLoadedGeneratorComponents,
  invalidateHeatRuntime,
  isThermalRouteType,
  isCoolantTransportType,
  rebuildCoolantNetworks,
  updateShipHeat,
  buildHeatDebug,
  addComponentHeat,
  distributeComponentHeatByWeight,
  componentPerformance,
  effectiveComponentBonus
};
