// Authoritative low-frequency, per-component thermal simulation.
const { PARTS } = require("./components");
const { getCommandAuraMultiplier } = require("./commandAuras");
const { getOccupiedCells } = require("./footprint");
const HeatRules = require("../../public/src/shared/heatRules");
const WiringInfrastructureRules = require("../../public/src/shared/wiringInfrastructureRules.js");
const { BALANCE } = require("./balanceConfig");
const { WIRING_ENABLED } = require("../../public/src/shared/featureFlags");
const { OPTIMIZED_HEAT_RUNTIME } = require("./performanceFlags");
const { buildThermalTopology, createComponentAdjacency, isThermalRouteType } = require("./thermalTopology");
const { performanceNow } = require("./utils");
const { bump, recordDuration } = require("./roomTelemetry");

const { TICK_SECONDS, STATE, profile, stateFor, activeOutputForState, activeCoolingForState, edgeTransfer, RADIATOR_EXPOSED_MULTIPLIER, RADIATOR_ENCLOSED_MULTIPLIER, RADIATOR_PASSIVE_COOLING_FRACTION } = HeatRules;

const TELEMETRY_STRIDE = 8;
const TELEMETRY_FIELDS = Object.freeze([
  "componentHeatGenerated",
  "componentHeatReceived",
  "componentHeatTransferredOut",
  "componentHeatCooled",
  "componentHeatSentThroughFrame",
  "componentHeatRadiated",
  "componentVentedOverflowHeatThisTick",
  "componentPowerCableHeatGenerated"
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
    cableComponents: [],
    cableMembership: new Uint8Array(componentCount),
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
    ship.componentAdjacency = createComponentAdjacency(topology);
    ship.thermalTopologyBuilds = (ship.thermalTopologyBuilds || 0) + 1;
  }
  if (!ship._thermalRuntime || ship._thermalRuntime.topology !== topology || ship._thermalRuntime.topology.componentCount !== topology.componentCount) {
    ship._thermalRuntime = createThermalRuntime(ship, topology);
    ship._thermalRuntime.topologyBuilds = hadTopology ? 0 : (ship.thermalTopologyBuilds || 1);
    ship._thermalRuntime.topologyCacheHits = hadTopology ? 1 : 0;
    ship._thermalRuntime.topologyShared = Boolean(ship._thermalTopologyShared);
  }
  const runtime = ship._thermalRuntime;
  if (!ship._heatScratch || ship._heatScratch.delta !== runtime.delta) {
    ship._heatScratch = {
      delta: runtime.delta,
      workingHeat: runtime.workingHeat,
      outflow: runtime.outflow,
      pendingTransfers: [],
      telemetryValues: runtime.telemetryValues
    };
  }
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

function refreshCableHeatComponents(ship, rates, totalRate = null, previousTotalRate = null) {
  const runtime = ship?._thermalRuntime;
  const previousTotal = previousTotalRate === null ? (Number(ship.powerCableHeatRate) || 0) : (Number(previousTotalRate) || 0);
  const list = runtime?.cableComponents;
  if (list) {
    for (const index of list) runtime.cableMembership[index] = 0;
    list.length = 0;
    for (let index = 0; index < rates.length; index += 1) {
      if ((Number(rates[index]) || 0) > 0) insertOrdered(list, runtime.cableMembership, index);
    }
  }
  if (totalRate !== null) ship.powerCableHeatRate = Number(totalRate) || 0;
  if (previousTotal <= 0 && (Number(ship.powerCableHeatRate) || 0) > 0) wakeHeatRuntime(ship);
}

function refreshLoadedGeneratorComponents(ship) {
  const runtime = ship?._thermalRuntime;
  if (!runtime) return;
  const previousLoaded = runtime.loadedGeneratorComponents.length > 0;
  for (const index of runtime.loadedGeneratorComponents) runtime.loadedGeneratorMembership[index] = 0;
  runtime.loadedGeneratorComponents.length = 0;
  const networkBySource = powerNetworkBySourceIndex(ship);
  for (const index of runtime.topology.powerSourceIndices) {
    const part = PARTS[ship.design[index]?.type] || {};
    const alive = (ship.componentHp?.[index] ?? 1) > 0;
    const state = ship.componentHeatState?.[index] || STATE.NORMAL;
    const network = networkBySource?.get(index);
    const generation = Number(network?.availableGenerationMw) || 0;
    const demand = Number(network?.liveDemandMw ?? network?.demandMw ?? network?.demand) || 0;
    if (alive && part.powerGeneration > 0 && activeOutputForState(state) > 0 && generation > 0 && demand > 0) {
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
  const indices = flags.wiringComponentIndices instanceof Set ? flags.wiringComponentIndices : null;
  if (indices) for (const index of indices) addLifecycleComponent(runtime, index);
  if (flags.exposure) for (const index of runtime.topology.radiatorIndices) addLifecycleComponent(runtime, index);
  if (flags.thermalRoutes) for (const index of runtime.topology.thermalRouteIndices) addLifecycleComponent(runtime, index);
  if (flags.thermalCapacity && !indices) for (const index of runtime.topology.heatSinkIndices) addLifecycleComponent(runtime, index);
}

function thermalStable(ship) {
  const runtime = ship._thermalRuntime;
  if (!runtime || runtime.heatBearingComponents.length || runtime.pendingInputComponents.length || runtime.cableComponents.length || runtime.loadedGeneratorComponents.length || runtime.lifecycleInvalidated) return false;
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
    ship.componentPowerCableHeatGenerated[index] = 0;
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
    const value7 = ship.componentPowerCableHeatGenerated[index] || 0;
    const values = runtime.telemetryValues;
    if (values[offset] !== value0) { values[offset] = value0; changed = true; }
    if (values[offset + 1] !== value1) { values[offset + 1] = value1; changed = true; }
    if (values[offset + 2] !== value2) { values[offset + 2] = value2; changed = true; }
    if (values[offset + 3] !== value3) { values[offset + 3] = value3; changed = true; }
    if (values[offset + 4] !== value4) { values[offset + 4] = value4; changed = true; }
    if (values[offset + 5] !== value5) { values[offset + 5] = value5; changed = true; }
    if (values[offset + 6] !== value6) { values[offset + 6] = value6; changed = true; }
    if (values[offset + 7] !== value7) { values[offset + 7] = value7; changed = true; }
    const nonZero = value0 !== 0 || value1 !== 0 || value2 !== 0 || value3 !== 0
      || value4 !== 0 || value5 !== 0 || value6 !== 0 || value7 !== 0;
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
  ship.componentAdjacency = createComponentAdjacency(topology);
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
  // Static Heat-capacity displacement from installed wiring. Displacement is a
  // static per-component amount computed once from the immutable Blueprint
  // wiring; recalculateEffectiveThermalCapacities subtracts it AFTER legitimate
  // static bonuses (heat-sink adjacency) and clamps to the configured minimum,
  // so order is: base + static bonuses - Power/Data displacement -> clamp.
  const infrastructure = BALANCE.wiringInfrastructure;
  ship.wiringMinimumHeatCapacity = WiringInfrastructureRules.minimumCapacity(infrastructure);
  if (WIRING_ENABLED) {
    const wiringAccounting = WiringInfrastructureRules.accountInfrastructure(design, ship.wiring, PARTS, infrastructure);
    ship.componentWiringDisplacement = wiringAccounting.byComponentIndex.map(entry => entry.powerDisplacement + entry.dataDisplacement);
    ship.componentWiringHeatDiagnostics = WiringInfrastructureRules.componentThermalDiagnostics(design, ship.wiring, PARTS, infrastructure, ship.componentBaseHeatCapacity);
  } else {
    ship.componentWiringDisplacement = design.map(() => 0);
    ship.componentWiringHeatDiagnostics = null;
  }
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
  // Section 7D-1: dynamic Power-cable Heat, tracked separately from component
  // Heat. Rates are populated by the shared analysis when Power flow is solved.
  ship.componentPowerCableHeatRate = design.map(() => 0);
  ship.componentPowerCableHeatGenerated = design.map(() => 0);
  ship.powerCableHeatRate = 0;
  ship.powerCableHeatGenerated = 0;
  ship.powerCableThermalAnalysis = null;
  ship._powerCableThermalFlowRevision = -1;
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
  ship._heatScratch = {
    delta: runtime.delta,
    workingHeat: runtime.workingHeat,
    outflow: runtime.outflow,
    pendingTransfers: [],
    telemetryValues: runtime.telemetryValues
  };
  refreshHeatRuntimeLists(ship);
  ship.currentHeat = 0;
  ship.hotComponentCount = 0;
  ship.overheatedComponentCount = 0;
  rebuildThermalNetworks(ship);
}

function recalculateEffectiveThermalCapacities(ship, changedSinkIndex = null) {
  if (!ship.componentThermals) return;
  const design = ship.design || [];
  if (!ship.componentBaseHeatCapacity || ship.componentBaseHeatCapacity.length !== design.length) {
    ship.componentBaseHeatCapacity = ship.componentThermals.map((thermal, index) => profile(design[index]?.type, PARTS[design[index]?.type] || {}).capacity || thermal.capacity || 0);
  }
  const affected = changedSinkIndex === null ? design.map((_, i) => i)
    : [changedSinkIndex, ...(ship.componentAdjacency?.[changedSinkIndex] || []).map(edge => edge.index)];
  for (const i of new Set(affected)) {
    let adjacencyBonus = 0;
    for (const edge of ship.componentAdjacency?.[i] || []) {
      const index = edge.index;
      if (design[index]?.type === "heatSink") {
        const max = Math.max(0, ship.componentMaxHp?.[index] || 0);
        adjacencyBonus += 35 * HeatRules.clamp(max > 0 ? ship.componentHp[index] / max : ((ship.componentHp?.[index] ?? 1) > 0 ? 1 : 0), 0, 1);
      }
    }
    const max = Math.max(0, ship.componentMaxHp?.[i] || 0);
    const health = HeatRules.clamp(max > 0 ? ship.componentHp[i] / max : ((ship.componentHp?.[i] ?? 1) > 0 ? 1 : 0), 0, 1);
    const ownCapacity = design[i].type === "heatSink" ? ship.componentBaseHeatCapacity[i] * health : ship.componentBaseHeatCapacity[i];
    // Wiring displacement is applied AFTER legitimate static bonuses (heat-sink
    // adjacency), then clamped to the configured minimum so cabling can never
    // drive a component to zero, negative, NaN or infinite capacity.
    const displacement = ship.componentWiringDisplacement?.[i] || 0;
    const minimum = ship.wiringMinimumHeatCapacity || 1;
    const capacity = Math.max(minimum, ownCapacity + adjacencyBonus - displacement);
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
  if (!ship.componentAdjacency) return;
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
      for (const edge of ship.componentAdjacency[index]) {
        const neighbour = edge.index;
        if (aliveFrames.has(neighbour)) {
          if (!visited.has(neighbour)) { visited.add(neighbour); queue.push(neighbour); }
        } else if ((ship.componentHp?.[neighbour] ?? 1) > 0) attached.add(neighbour);
      }
    }
    const members = new Set([...frames, ...attached]);
    const generators = [...attached].filter(i => HeatRules.activityHeat(design[i].type, PARTS[design[i].type] || {}) > 0);
    const sinks = [...attached].filter(i => design[i].type === "heatSink");
    const radiators = [...attached].filter(i => design[i].type === "radiator");
    const heatPipeIndices = frames.filter(i => design[i].type === "heatPipe");
    const frameOnlyIndices = frames.filter(i => design[i].type !== "heatPipe");
    const id = networks.length;
    for (const index of members) ship.componentThermalNetworks[index].push(id);
    const connectedFrameCells = frames.map(index => ({ index, x: design[index].x, y: design[index].y }));
    networks.push({ id, frameIndices: frames, heatPipeIndices, frameOnlyIndices, connectedFrameCells, attachedComponents: [...attached], generators, sinks, radiators, totalStoredHeat: 0, totalStorageCapacity: 0, totalCoolingCapacity: 0, overloaded: false });

    // Cached distance-to-cooling field: used only as a mild conductivity boost,
    // never as an instant/global heat drain.
    const coolers = new Set([...sinks, ...radiators]);
    const distanceQueue = [];
    for (const frame of frames) {
      const touchesCooling = ship.componentAdjacency[frame].some(edge => coolers.has(edge.index));
      if (touchesCooling) { ship.frameCoolingDistance[frame] = 0; distanceQueue.push(frame); }
    }
    for (let cursor = 0; cursor < distanceQueue.length; cursor += 1) {
      const frame = distanceQueue[cursor];
      const nextDistance = ship.frameCoolingDistance[frame] + 1;
      for (const edge of ship.componentAdjacency[frame]) {
        const neighbour = edge.index;
        if (!frames.includes(neighbour) || nextDistance >= ship.frameCoolingDistance[neighbour]) continue;
        ship.frameCoolingDistance[neighbour] = nextDistance;
        distanceQueue.push(neighbour);
      }
    }
  }
  ship.thermalNetworks = networks;
  ship.thermalNetworkBuilds = (ship.thermalNetworkBuilds || 0) + 1;
  if (ship._thermalRuntime) {
    ship._thermalRuntime.networkDiagnosticsDirty = true;
    if (ship.componentHeat && ship.componentHeatState) refreshHeatRuntimeLists(ship);
  }
  wakeHeatRuntime(ship);
}

// Maps a Power-source component index to the network it feeds. The thermal tick
// needs this for every component, and resolving it with
// `powerNetworks.find(n => n.sourceIndices.includes(i))` made the per-component
// loop O(components x networks x sources). `powerNetworks` is reassigned
// wholesale whenever Power is re-solved, so caching against the array identity
// needs no extra revision plumbing. First match wins, matching `.find`.
function powerNetworkBySourceIndex(ship) {
  const networks = ship.runtimeWiring?.powerNetworks;
  if (!Array.isArray(networks) || networks.length === 0) return null;
  let cache = ship._powerNetworkBySource;
  if (!cache || cache.source !== networks) {
    const byIndex = new Map();
    for (const network of networks) {
      for (const sourceIndex of network.sourceIndices || []) {
        if (!byIndex.has(sourceIndex)) byIndex.set(sourceIndex, network);
      }
    }
    cache = { source: networks, byIndex };
    ship._powerNetworkBySource = cache;
  }
  return cache.byIndex;
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

function updateShipHeatLegacy(ship, dt, room, now) {
  if (!ship.alive || !ship.componentHeat) return;
  const pending = ship.hasPendingHeatInput;
  if (!ship.hasActiveHeat && !ship.hasPassiveHeatSource && !pending && !(ship.powerCableHeatRate > 0)) return;
  ship.hasPendingHeatInput = false;
  const MAX_THERMAL_STEPS = 8;
  const MAX_THERMAL_BACKLOG_SECONDS = TICK_SECONDS * MAX_THERMAL_STEPS;
  ship.heatAccumulator = Math.min((ship.heatAccumulator || 0) + Math.max(0, dt || 0), MAX_THERMAL_BACKLOG_SECONDS);
  if (ship.heatAccumulator < TICK_SECONDS) return;
  const steps = Math.min(MAX_THERMAL_STEPS, Math.floor(ship.heatAccumulator / TICK_SECONDS));
  const elapsed = steps * TICK_SECONDS;
  ship.heatAccumulator = Math.max(0, ship.heatAccumulator - elapsed);
  ship.lastHeatTickDelta = elapsed;

  const heat = ship.componentHeat;
  bump(room, "heatComponentsVisited", heat.length);
  bump(room, "heatEdgesVisited", ship.thermalTopology?.edgeA?.length || 0);
  if (!ship._heatScratch || ship._heatScratch.delta.length !== heat.length) {
    ship._heatScratch = {
      delta: new Array(heat.length).fill(0),
      workingHeat: new Array(heat.length).fill(0),
      outflow: new Array(heat.length).fill(0),
      pendingTransfers: [],
      telemetryValues: new Float64Array(heat.length * 8)
    };
  }
  const scratch = ship._heatScratch;
  const delta = scratch.delta;
  const workingHeat = scratch.workingHeat;
  const outflow = scratch.outflow;
  const pendingTransfers = scratch.pendingTransfers;
  for (let i = 0; i < heat.length; i += 1) {
    delta[i] = 0;
    workingHeat[i] = 0;
    outflow[i] = 0;
  }
  pendingTransfers.length = 0;
  ship.componentHeatGenerated.fill(0);
  ship.componentHeatReceived.fill(0);
  ship.componentHeatRemoved.fill(0);
  if (!ship.componentHeatTransferredOut) ship.componentHeatTransferredOut = heat.map(() => 0);
  if (!ship.componentHeatCooled) ship.componentHeatCooled = heat.map(() => 0);
  if (!ship.componentVentedOverflowHeatThisTick) ship.componentVentedOverflowHeatThisTick = heat.map(() => 0);
  if (!ship.componentVentedOverflowHeat) ship.componentVentedOverflowHeat = ship.componentVentedOverflowHeatThisTick;
  if (!ship.componentTotalVentedOverflowHeat) ship.componentTotalVentedOverflowHeat = heat.map(() => 0);
  ship.componentHeatTransferredOut.fill(0);
  ship.componentHeatCooled.fill(0);
  ship.componentHeatSentThroughFrame.fill(0);
  ship.componentHeatRadiated.fill(0);
  ship.componentVentedOverflowHeatThisTick.fill(0);
  ship.componentVentedOverflowHeat = ship.componentVentedOverflowHeatThisTick;
  ship.ventedOverflowHeatThisTick = 0;
  ship.ventedOverflowHeat = ship.ventedOverflowHeatThisTick;
  let remainsActive = false;

  // Local generation only. Cooling is applied after transfers so a radiator can
  // remove heat arriving through its frame route in the same thermal tick.
  const networkBySource = powerNetworkBySourceIndex(ship);
  for (let i = 0; i < heat.length; i += 1) {
    const alive = (ship.componentHp?.[i] ?? 1) > 0;
    const part = PARTS[ship.design[i].type] || {};
    const thermal = ship.componentThermals[i];
    const damagedMultiplier = alive && ship.componentMaxHp?.[i] ? 1 + 0.15 * (1 - ship.componentHp[i] / ship.componentMaxHp[i]) : 1;
    const powerNetwork = part.powerGeneration > 0 ? networkBySource?.get(i) : undefined;
    const networkGeneration = Number(powerNetwork?.availableGenerationMw) || 0;
    const networkDemand = Number(powerNetwork?.liveDemandMw ?? powerNetwork?.demandMw ?? powerNetwork?.demand) || 0;
    const load = alive && activeOutputForState(ship.componentHeatState?.[i] || STATE.NORMAL) > 0 && networkGeneration > 0
      ? Math.min(1, Math.max(0, networkDemand / networkGeneration)) : 0;
    const steady = alive && part.powerGeneration > 0 ? (2 + part.powerGeneration * 0.42) * load * elapsed * damagedMultiplier : 0;
    const generated = alive ? ship.componentHeatInput[i] * damagedMultiplier + steady : 0;
    ship.componentHeatInput[i] = 0;
    ship.componentHeatGenerated[i] = generated;
    delta[i] += generated;

  }

  // Section 7D-1: dynamic Power-cable Heat from solved section flow. The cached
  // analysis is refreshed only when Power flow changed (revision-guarded, so
  // repeated ticks with unchanged flow do not rebuild it). Cable Heat is added
  // to the shared thermal delta — so it conducts, cools, drives state changes,
  // throttling, source overheating and meltdown like any other Heat — but is
  // recorded separately and never enters componentHeatGenerated/Input/Received/
  // TransferredOut.
  require("./componentPower").ensureShipCableThermalAnalysis(ship);
  if (!ship.componentPowerCableHeatGenerated || ship.componentPowerCableHeatGenerated.length !== heat.length) {
    ship.componentPowerCableHeatGenerated = heat.map(() => 0);
  }
  ship.componentPowerCableHeatGenerated.fill(0);
  const cableRates = ship.componentPowerCableHeatRate;
  let shipCableHeat = 0;
  if (Array.isArray(cableRates)) {
    for (let i = 0; i < heat.length; i += 1) {
      const alive = (ship.componentHp?.[i] ?? 1) > 0;
      const rate = alive ? (Number(cableRates[i]) || 0) : 0;
      if (rate <= 0) continue;
      const cableHeatAmount = rate * elapsed;
      delta[i] += cableHeatAmount;
      ship.componentPowerCableHeatGenerated[i] = cableHeatAmount;
      shipCableHeat += cableHeatAmount;
    }
  }
  bump(room, "heatCableSourceComponents", Array.isArray(cableRates)
    ? cableRates.reduce((count, rate, index) => count + (((ship.componentHp?.[index] ?? 1) > 0 && (Number(rate) || 0) > 0) ? 1 : 0), 0)
    : 0);
  ship.powerCableHeatGenerated = shipCableHeat;
  ship.powerCableHeatTotal = (ship.powerCableHeatTotal || 0) + shipCableHeat;

  // Cached edges only; normalized-ratio transfers are calculated against the
  // same pre-transfer snapshot, then each component's total outflow is scaled
  // down so it never sends more heat than it holds (per-edge clamps alone let a
  // component with several colder neighbours overdraw, minting heat from the
  // final max(0, ...) clamp). Scaling keeps transfers order independent.
  for (let i = 0; i < heat.length; i += 1) {
    workingHeat[i] = Math.max(0, heat[i] + delta[i]);
  }
  for (let i = 0; i < heat.length; i += 1) {
    for (const edge of ship.componentAdjacency[i]) {
      const j = edge.index;
      if (j <= i) continue;
      const aliveI = (ship.componentHp?.[i] ?? 1) > 0;
      const aliveJ = (ship.componentHp?.[j] ?? 1) > 0;
      if ((!aliveI && isThermalRouteType(ship.design[i].type)) || (!aliveJ && isThermalRouteType(ship.design[j].type))) continue;
      const typeI = ship.design[i].type;
      const typeJ = ship.design[j].type;
      const frameI = isThermalRouteType(typeI);
      const frameJ = isThermalRouteType(typeJ);
      const routedI = Number.isFinite(ship.frameCoolingDistance?.[i]);
      const routedJ = Number.isFinite(ship.frameCoolingDistance?.[j]);
      let conductivity = (!aliveI || !aliveJ) ? HeatRules.CONDUCTIVITY.destroyed : edge.conductivity;
      // Edge-type transfer multiplier: a single factor per edge based on the
      // pair of component types. Heat Pipe edges get a substantial boost over
      // Frame edges. Only applies to living, routed edges.
      if (aliveI && aliveJ && (routedI || routedJ)) {
        conductivity *= HeatRules.routeTypeMultiplier(typeI, typeJ);
      }
      const transfer = edgeTransfer(workingHeat[i], ship.componentThermals[i].capacity, workingHeat[j], ship.componentThermals[j].capacity, conductivity, edge.sharedEdges, elapsed);
      if (transfer === 0) continue;
      pendingTransfers.push({ i, j, transfer, throughFrame: frameI || frameJ });
      bump(room, "heatTransferObjectsAllocated");
      outflow[transfer > 0 ? i : j] += Math.abs(transfer);
    }
  }
  for (const pending of pendingTransfers) {
    const { i, j, throughFrame } = pending;
    const source = pending.transfer > 0 ? i : j;
    const scale = outflow[source] > workingHeat[source] ? workingHeat[source] / outflow[source] : 1;
    const transfer = pending.transfer * scale;
    delta[i] -= transfer;
    delta[j] += transfer;
    if (transfer > 0) {
      ship.componentHeatTransferredOut[i] += transfer;
      ship.componentHeatReceived[j] += transfer;
      if (throughFrame) ship.componentHeatSentThroughFrame[i] += transfer;
    } else if (transfer < 0) {
      ship.componentHeatReceived[i] -= transfer;
      ship.componentHeatTransferredOut[j] -= transfer;
      if (throughFrame) ship.componentHeatSentThroughFrame[j] -= transfer;
    }
  }
  bump(room, "heatTransfersApplied", pendingTransfers.length);

  // Natural/radiator cooling consumes post-transfer heat, allowing connected
  // radiators to create a persistent temperature gradient through the frames.
  const heatDissipationMult = getCommandAuraMultiplier(ship, "heatDissipationMultiplier");
  const overheatRecoveryMult = getCommandAuraMultiplier(ship, "overheatRecoveryMultiplier");
  for (let i = 0; i < heat.length; i += 1) {
    const thermal = ship.componentThermals[i];
    let coolingRate = thermal.cooling * thermal.retention * heatDissipationMult;
    if (ship.design[i].type === "radiator") {
      const alive = (ship.componentHp?.[i] ?? 1) > 0;
      const exposure = thermal.exposedEdges > 0 ? RADIATOR_EXPOSED_MULTIPLIER : RADIATOR_ENCLOSED_MULTIPLIER;
      // Passive radiative loss floor — a destroyed radiator still radiates
      // heat passively but provides no active cooling.
      const power = require("./componentPower").getComponentPowerMultiplier(ship, i);
      const active = alive ? thermal.cooling * activeCoolingForState(ship.componentHeatState?.[i] || STATE.NORMAL) * power : 0;
      const passiveFloor = thermal.cooling * RADIATOR_PASSIVE_COOLING_FRACTION;
      coolingRate = Math.max(passiveFloor, active) * exposure * thermal.retention * heatDissipationMult;
    }
    else if (thermal.exposedEdges > 0) coolingRate *= 1.12;
    // Thermodynamics: a hotter body sheds heat faster. Passive dissipation scales
    // with the component's fill ratio — hotspots bleed off quickly — but the floor
    // stays high enough that cool/normal components still dissipate properly
    // (a low floor here starves normal cooling and makes everything creep hot).
    const ratio = Math.max(0, (heat[i] + delta[i]) / Math.max(1, thermal.capacity));
    const tempFactor = 0.7 + 0.9 * ratio * ratio;
    coolingRate *= tempFactor;
    // Overheat recovery: components in CRITICAL or OVERHEATED state get
    // additional cooling proportional to overheatRecoveryMultiplier so they
    // shed heat faster and return to operational temperature sooner.
    const currentState = ship.componentHeatState?.[i];
    if (currentState >= STATE.CRITICAL && overheatRecoveryMult > 1) {
      coolingRate *= overheatRecoveryMult;
    }
    const removed = Math.min(Math.max(0, heat[i] + delta[i]), coolingRate * elapsed);
    ship.componentHeatRemoved[i] += removed;
    ship.componentHeatCooled[i] += removed;
    if (ship.design[i].type === "radiator") ship.componentHeatRadiated[i] = removed;
    delta[i] -= removed;
  }

  let totalHeat = 0;
  let totalCapacity = 0;
  let hotCount = 0;
  let overheatedCount = 0;
  let componentHeatChanged = false;
  let meltdowns = null;
  if (!ship.componentMeltdown) ship.componentMeltdown = heat.map(() => 0);
  for (let i = 0; i < heat.length; i += 1) {
    const alive = (ship.componentHp?.[i] ?? 1) > 0;
    const capacity = ship.componentThermals[i].capacity;
    // Retained heat ceiling is 125% of current capacity. Heat already retained
    // above a newly reduced capacity is not deleted; only newly added heat beyond
    // that retained ceiling is vented as emergency heat removal (not radiator
    // cooling).
    const retainedCeiling = Math.max(capacity * 1.25, heat[i]);
    const unclampedNext = Math.max(0, heat[i] + delta[i]);
    const next = Math.min(retainedCeiling, unclampedNext);
    const overflow = Math.max(0, unclampedNext - next);
    if (overflow > 0) {
      ship.componentVentedOverflowHeatThisTick[i] += overflow;
      ship.componentVentedOverflowHeat = ship.componentVentedOverflowHeatThisTick;
      ship.componentTotalVentedOverflowHeat[i] = (ship.componentTotalVentedOverflowHeat[i] || 0) + overflow;
      ship.ventedOverflowHeatThisTick += overflow;
      ship.ventedOverflowHeat = ship.ventedOverflowHeatThisTick;
      ship.totalVentedOverflowHeat = (ship.totalVentedOverflowHeat || 0) + overflow;
      ship.componentHeatRemoved[i] += overflow;
    }
    const oldState = ship.componentHeatState[i];
    const physicalState = stateFor(capacity > 0 ? next / capacity : (next > 0 ? Infinity : 0), oldState);
    const nextState = alive ? physicalState : STATE.NORMAL;
    if (nextState !== oldState) ship.heatStateRevision = (ship.heatStateRevision || 0) + 1;
    const visibleHeatChanged = Math.round(next * 10) !== Math.round(heat[i] * 10);
    if (nextState !== oldState || visibleHeatChanged) {
      ship.dirtyHeat.add(i);
      componentHeatChanged = true;
    }
    heat[i] = next;
    ship.componentHeatState[i] = nextState;
    if (alive) {
      totalHeat += next;
      totalCapacity += capacity;
      if (nextState >= STATE.HOT) hotCount += 1;
      if (nextState === STATE.OVERHEATED) overheatedCount += 1;
      const output = PARTS[ship.design[i].type]?.powerGeneration || 0;
      // Reactors (power sources) that stay at overheat failure melt down.
      if (output > 0) {
        if (nextState === STATE.OVERHEATED) {
          ship.componentMeltdown[i] += elapsed;
          if (ship.componentMeltdown[i] >= REACTOR_MELTDOWN_SECONDS) (meltdowns || (meltdowns = [])).push(i);
        } else {
          ship.componentMeltdown[i] = Math.max(0, ship.componentMeltdown[i] - elapsed * 2 * overheatRecoveryMult);
        }
      }
    } else if ((PARTS[ship.design[i].type]?.powerGeneration || 0) > 0) {
      // Destruction resets the lifecycle; repair never revives old progress.
      ship.componentMeltdown[i] = 0;
    }
    if (next > 0.05) remainsActive = true;
  }
  if (ship._thermalRuntime?.lastHeatValues) {
    for (let i = 0; i < heat.length; i += 1) ship._thermalRuntime.lastHeatValues[i] = Math.max(0, Number(heat[i]) || 0);
  }
  const nextPressure = totalCapacity > 0 ? totalHeat / totalCapacity : 0;
  const previousHeatPresentation = ship._heatPresentationValues;
  const nextHeatPresentation = [
    Math.round(totalHeat * 10),
    Math.round(totalCapacity * 10),
    Math.round(nextPressure * 1000),
    hotCount,
    overheatedCount
  ];
  if (!previousHeatPresentation || nextHeatPresentation.some((value, index) => value !== previousHeatPresentation[index])) {
    ship.heatRevision = (ship.heatRevision || 0) + 1;
    ship._heatPresentationValues = nextHeatPresentation;
  }
  if (componentHeatChanged) ship.componentHeatRevision = (ship.componentHeatRevision || 0) + 1;
  ship.currentHeat = totalHeat;
  ship.maxHeat = totalCapacity;
  ship.heatPressure = nextPressure;
  ship.hotComponentCount = hotCount;
  ship.overheatedComponentCount = overheatedCount;
  bump(room, "heatHotComponents", hotCount);
  bump(room, "heatBearingComponents", heat.reduce((count, value) => count + (Number.isFinite(value) && value > 0 ? 1 : 0), 0));
  // Source state tiers alter only their own network allocation. Batch all
  // changes from this thermal step into one cheap reanalysis of cached Wiring.
  const powerSourceSignature = powerSourceHeatSignature(ship);
  const dataSourceSignature = dataSourceHeatSignature(ship);
  const powerSourceTierChanged = ship._heatPowerSourceSignature !== undefined && ship._heatPowerSourceSignature !== powerSourceSignature;
  const dataSourceTierChanged = ship._heatDataSourceSignature !== undefined && ship._heatDataSourceSignature !== dataSourceSignature;
  ship._heatPowerSourceSignature = powerSourceSignature;
  ship._heatDataSourceSignature = dataSourceSignature;
  ship._heatPowerSourceStates = ship.componentHeatState.slice();
  ship._heatDataSourceStates = ship.componentHeatState.slice();
  if (powerSourceTierChanged) require("./componentPower").reallocateShipPower(ship, "thermal-source-state");
  else if (dataSourceTierChanged) require("./componentData").refreshShipDataAllocation(ship, "thermal-data-source-state");
  ship.hasActiveHeat = remainsActive || ship.hasPassiveHeatSource;
  for (const network of ship.thermalNetworks || []) {
    const members = [...network.frameIndices, ...network.attachedComponents];
    network.totalStoredHeat = members.reduce((sum, index) => sum + heat[index], 0);
    network.totalStorageCapacity = members.reduce((sum, index) => sum + ship.componentThermals[index].capacity, 0);
    network.totalCoolingCapacity = network.sinks.reduce((sum, index) => sum + ship.componentThermals[index].cooling, 0)
      + network.radiators.reduce((sum, index) => sum + ship.componentThermals[index].cooling * (ship.componentThermals[index].exposedEdges ? 1 : 0.25), 0);
    network.totalCooling = network.radiators.reduce((sum, index) => sum + ship.componentHeatRadiated[index], 0)
      + network.sinks.reduce((sum, index) => sum + ship.componentHeatCooled[index], 0);
    network.heatPipeTransferPerSecond = (network.heatPipeIndices || []).reduce((sum, index) => sum + (ship.componentHeatTransferredOut[index] || 0), 0) / elapsed;
    const generation = network.generators.reduce((sum, index) => sum + HeatRules.activityHeat(ship.design[index].type, PARTS[ship.design[index].type] || {}), 0);
    network.overloaded = generation > network.totalCoolingCapacity;
  }
  const telemetryValues = scratch.telemetryValues?.length === heat.length * 8
    ? scratch.telemetryValues
    : (scratch.telemetryValues = new Float64Array(heat.length * 8));
  let telemetryChanged = false;
  for (let i = 0; i < heat.length; i += 1) {
    const offset = i * 8;
    const values = [
      ship.componentHeatGenerated[i] || 0,
      ship.componentHeatReceived[i] || 0,
      ship.componentHeatTransferredOut[i] || 0,
      ship.componentHeatCooled[i] || 0,
      ship.componentHeatSentThroughFrame[i] || 0,
      ship.componentHeatRadiated[i] || 0,
      ship.componentVentedOverflowHeatThisTick[i] || 0,
      ship.componentPowerCableHeatGenerated[i] || 0
    ];
    for (let field = 0; field < values.length; field += 1) {
      if (telemetryValues[offset + field] !== values[field]) {
        telemetryValues[offset + field] = values[field];
        telemetryChanged = true;
      }
    }
  }
  if (telemetryChanged) ship.heatTelemetryRevision = (ship.heatTelemetryRevision || 0) + 1;

  // Resolve any reactor meltdowns after the thermal state is settled. Detonation
  // deals hp damage to neighbours (not heat), so it cannot instantly cascade; a
  // ship reduced to 0 hull or a destroyed core is finished off here.
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
    if (ship.alive && (ship.hp <= 0.001 || ship.coreDestroyed)) {
      require("./combat").destroyShip(room, ship, ship.lastDamagedBy || null, now);
    }
  }
}

function resetOptimizedScratch(runtime) {
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

function addOptimizedWorkComponent(ship, index) {
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

function touchOptimizedNeighbour(ship, index) {
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

function buildOptimizedWorkSet(ship) {
  const runtime = ship._thermalRuntime;
  for (const index of runtime.heatBearingComponents) addOptimizedWorkComponent(ship, index);
  for (const index of runtime.pendingInputComponents) addOptimizedWorkComponent(ship, index);
  for (const index of runtime.cableComponents) addOptimizedWorkComponent(ship, index);
  for (const index of runtime.loadedGeneratorComponents) addOptimizedWorkComponent(ship, index);
  for (const index of runtime.lifecycleComponents) addOptimizedWorkComponent(ship, index);
  for (const index of runtime.topology.powerSourceIndices) {
    if ((Number(ship.componentMeltdown?.[index]) || 0) > 0) addOptimizedWorkComponent(ship, index);
  }
}

function updateOptimizedNetworkDiagnostics(ship, elapsed) {
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
      totalCoolingCapacity += ship.componentThermals[index].cooling * (ship.componentThermals[index].exposedEdges ? 1 : 0.25);
    }
    let totalCooling = 0;
    for (const index of network.radiators) totalCooling += ship.componentHeatRadiated[index];
    for (const index of network.sinks) totalCooling += ship.componentHeatCooled[index];
    let heatPipeTransfer = 0;
    for (const index of network.heatPipeIndices || []) heatPipeTransfer += ship.componentHeatTransferredOut[index] || 0;
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

function updateShipHeatOptimized(ship, dt, room, now) {
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
  if (!ship.hasActiveHeat && !ship.hasPassiveHeatSource && !pending && !hasRetainedHeat
      && !(ship.powerCableHeatRate > 0)) return;
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
  // The cable analysis is still the sole authority for the rates.  It is
  // refreshed before the stable decision so a newly positive flow wakes this
  // ship at the same thermal boundary as the legacy path.
  require("./componentPower").ensureShipCableThermalAnalysis(ship);
  refreshLoadedGeneratorComponents(ship);
  // Public test/debug callers historically set hasActiveHeat and a component
  // Heat value directly.  Reconcile that compatibility hint once when the
  // persistent lists are otherwise empty; normal gameplay producers maintain
  // membership incrementally through addComponentHeat/lifecycle hooks.
  if (ship.hasActiveHeat && !runtime.stable
      && runtime.heatBearingComponents.length === 0
      && runtime.pendingInputComponents.length === 0
      && runtime.cableComponents.length === 0
      && runtime.lifecycleComponents.length === 0) {
    refreshHeatRuntimeLists(ship);
    // Preserve the old public-array compatibility used by a few diagnostics:
    // direct writes to componentHeatInput were historically picked up by the
    // full scan even though normal producers call addComponentHeat.
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
    resetOptimizedScratch(runtime);
    const previousTelemetry = beginSparseTelemetryStep(ship);
    ship.ventedOverflowHeatThisTick = 0;
    ship.ventedOverflowHeat = ship.ventedOverflowHeatThisTick;
    ship.powerCableHeatGenerated = 0;
    const telemetryChanged = finishSparseTelemetryStep(ship, previousTelemetry, runtime.telemetryCandidateComponents);
    if (telemetryChanged) ship.heatTelemetryRevision = (ship.heatTelemetryRevision || 0) + 1;
    if (runtime.networkDiagnosticsDirty) updateOptimizedNetworkDiagnostics(ship, elapsed);
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

  resetOptimizedScratch(runtime);
  const previousTelemetry = beginSparseTelemetryStep(ship);
  ship.ventedOverflowHeatThisTick = 0;
  ship.ventedOverflowHeat = ship.ventedOverflowHeatThisTick;
  const heat = ship.componentHeat;
  const networkBySource = powerNetworkBySourceIndex(ship);
  buildOptimizedWorkSet(ship);
  const pendingInputCount = runtime.pendingInputComponents.length;

  let generationStart = performanceNow();
  for (const index of runtime.workComponents) {
    const alive = (ship.componentHp?.[index] ?? 1) > 0;
    const part = PARTS[ship.design[index].type] || {};
    const thermal = ship.componentThermals[index];
    const damagedMultiplier = alive && ship.componentMaxHp?.[index]
      ? 1 + 0.15 * (1 - ship.componentHp[index] / ship.componentMaxHp[index])
      : 1;
    const powerNetwork = part.powerGeneration > 0 ? networkBySource?.get(index) : undefined;
    const networkGeneration = Number(powerNetwork?.availableGenerationMw) || 0;
    const networkDemand = Number(powerNetwork?.liveDemandMw ?? powerNetwork?.demandMw ?? powerNetwork?.demand) || 0;
    const load = alive && activeOutputForState(ship.componentHeatState?.[index] || STATE.NORMAL) > 0 && networkGeneration > 0
      ? Math.min(1, Math.max(0, networkDemand / networkGeneration)) : 0;
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

  let shipCableHeat = 0;
  const cableRates = ship.componentPowerCableHeatRate;
  for (const index of runtime.cableComponents) {
    const alive = (ship.componentHp?.[index] ?? 1) > 0;
    const rate = alive ? (Number(cableRates?.[index]) || 0) : 0;
    if (rate <= 0) continue;
    const cableHeatAmount = rate * elapsed;
    runtime.delta[index] += cableHeatAmount;
    ship.componentPowerCableHeatGenerated[index] = cableHeatAmount;
    shipCableHeat += cableHeatAmount;
  }
  ship.powerCableHeatGenerated = shipCableHeat;
  ship.powerCableHeatTotal = (ship.powerCableHeatTotal || 0) + shipCableHeat;
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
  runtime.candidateEdgeIds.sort(compareNumbers);

  let transferStart = performanceNow();
  let transferCount = 0;
  for (const edgeId of runtime.candidateEdgeIds) {
    const i = topology.edgeA[edgeId];
    const j = topology.edgeB[edgeId];
    touchOptimizedNeighbour(ship, i);
    touchOptimizedNeighbour(ship, j);
    const aliveI = (ship.componentHp?.[i] ?? 1) > 0;
    const aliveJ = (ship.componentHp?.[j] ?? 1) > 0;
    if ((!aliveI && isThermalRouteType(ship.design[i].type)) || (!aliveJ && isThermalRouteType(ship.design[j].type))) continue;
    const routedI = Number.isFinite(ship.frameCoolingDistance?.[i]);
    const routedJ = Number.isFinite(ship.frameCoolingDistance?.[j]);
    let conductivity = (!aliveI || !aliveJ) ? HeatRules.CONDUCTIVITY.destroyed : topology.edgeBaseConductivity[edgeId];
    // componentAdjacency remains a mutable compatibility/debug view used by a
    // few server-side diagnostics.  Honour an explicit per-ship override while
    // retaining the immutable topology as the normal source of truth.
    if (aliveI && aliveJ) {
      const compatibilityEdges = ship.componentAdjacency?.[i] || [];
      for (let edgeIndex = 0; edgeIndex < compatibilityEdges.length; edgeIndex += 1) {
        if (compatibilityEdges[edgeIndex].edgeId === edgeId) {
          conductivity = compatibilityEdges[edgeIndex].conductivity;
          break;
        }
      }
    }
    if (aliveI && aliveJ && (routedI || routedJ)) conductivity *= topology.edgeRouteMultiplier[edgeId];
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
  bump(room, "heatTransferObjectsAllocated", 0);
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
    } else if (thermal.exposedEdges > 0) coolingRate *= 1.12;
    const ratio = Math.max(0, (heat[index] + runtime.delta[index]) / Math.max(1, thermal.capacity));
    const tempFactor = 0.7 + 0.9 * ratio * ratio;
    coolingRate *= tempFactor;
    const currentState = ship.componentHeatState?.[index];
    if (currentState >= STATE.CRITICAL && overheatRecoveryMult > 1) coolingRate *= overheatRecoveryMult;
    const removed = Math.min(Math.max(0, heat[index] + runtime.delta[index]), coolingRate * elapsed);
    ship.componentHeatRemoved[index] += removed;
    ship.componentHeatCooled[index] += removed;
    if (ship.design[index].type === "radiator") ship.componentHeatRadiated[index] = removed;
    runtime.delta[index] -= removed;
  }
  recordDuration(room, "heatCoolingMs", coolingStart);

  let finalizationStart = performanceNow();
  let componentHeatChanged = false;
  let powerSourceTierChanged = false;
  let dataSourceTierChanged = false;
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
      if (priorAlive !== alive || (priorState === STATE.OVERHEATED) !== (nextState === STATE.OVERHEATED)) powerSourceTierChanged = true;
      if (ship._heatPowerSourceStates) ship._heatPowerSourceStates[index] = nextState;
      if (ship._heatPowerSourceAlive) ship._heatPowerSourceAlive[index] = alive ? 1 : 0;
    }
    if (runtime.dataSourceMembership[index]) {
      const priorState = ship._heatDataSourceStates?.[index] ?? oldState;
      const priorAlive = ship._heatDataSourceAlive?.[index] ?? alive;
      if (priorAlive !== alive || priorState !== nextState) dataSourceTierChanged = true;
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
  if (powerSourceTierChanged) require("./componentPower").reallocateShipPower(ship, "thermal-source-state");
  else if (dataSourceTierChanged) require("./componentData").refreshShipDataAllocation(ship, "thermal-data-source-state");
  refreshLoadedGeneratorComponents(ship);
  runtime.lifecycleInvalidated = false;
  runtime.sourceStateDirty = false;
  for (const index of runtime.lifecycleComponents) runtime.lifecycleMembership[index] = 0;
  runtime.lifecycleComponents.length = 0;

  updateOptimizedNetworkDiagnostics(ship, elapsed);
  const telemetryChanged = finishSparseTelemetryStep(ship, previousTelemetry, runtime.telemetryCandidateComponents);
  if (telemetryChanged) ship.heatTelemetryRevision = (ship.heatTelemetryRevision || 0) + 1;
  recordDuration(room, "heatFinalizationMs", finalizationStart);
  bump(room, "heatComponentsVisited", runtime.touchedComponents.length);
  bump(room, "heatBearingComponents", runtime.heatBearingComponents.length);
  bump(room, "heatHotComponents", runtime.hotComponents.length);
  bump(room, "heatPendingInputComponents", pendingInputCount);
  bump(room, "heatCableSourceComponents", runtime.cableComponents.length);
  bump(room, "heatLoadedGeneratorComponents", runtime.loadedGeneratorComponents.length);
  ship.hasActiveHeat = runtime.heatBearingComponents.length > 0 || ship.hasPassiveHeatSource || runtime.cableComponents.length > 0;

  // Resolve reactor meltdowns only after all thermal state and telemetry are
  // settled, matching the legacy lifecycle boundary.
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
  if (OPTIMIZED_HEAT_RUNTIME()) return updateShipHeatOptimized(ship, dt, room, now);
  const runtime = ship?._thermalRuntime;
  if (runtime) {
    bump(room, "heatShipsConsidered");
    bump(room, "heatComponentsTotal", ship.componentHeat?.length || 0);
    bump(room, "heatEdgesTotal", runtime.topology.edgeA.length);
    if (!runtime.topologyTelemetryReported) {
      bump(room, "heatTopologyBuilds", runtime.topologyBuilds);
      runtime.topologyTelemetryReported = true;
    }
  }
  bump(room, "heatShipsLegacyProcessed");
  return updateShipHeatLegacy(ship, dt, room, now);
}

function buildHeatDebug(ship) {
  const dt = Math.max(0.001, ship.lastHeatTickDelta || TICK_SECONDS);
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
      removedByRadiatorPerSecond: (ship.componentHeatRadiated?.[index] || 0) / dt,
      ventedOverflowHeatPerSecond: (ship.componentVentedOverflowHeatThisTick?.[index] || 0) / dt,
      totalVentedOverflowHeat: ship.componentTotalVentedOverflowHeat?.[index] || 0,
      thermalNetworkIds: (ship.componentThermalNetworks?.[index] || []).slice(),
      exposedEdges: ship.componentThermals?.[index]?.exposedEdges || 0,
      routeType: isThermalRouteType(module.type) ? (module.type === "heatPipe" ? "heatPipe" : "frame") : "attached",
      adjacentHeatPipeEdges: (ship.componentAdjacency?.[index] || []).filter(e => ship.design?.[e.index]?.type === "heatPipe").reduce((sum, e) => sum + e.sharedEdges, 0)
    })),
    networks: (ship.thermalNetworks || []).map(network => ({
      id: network.id,
      frameIndices: network.frameOnlyIndices ? network.frameOnlyIndices.slice() : network.frameIndices.slice(),
      heatPipeIndices: (network.heatPipeIndices || []).slice(),
      attachedComponents: network.attachedComponents.slice(),
      sinkIndices: network.sinks.slice(),
      radiatorIndices: network.radiators.slice(),
      totalHeat: network.totalStoredHeat,
      totalStorageCapacity: network.totalStorageCapacity,
      totalCoolingCapacity: network.totalCoolingCapacity,
      totalCoolingPerSecond: (network.totalCooling || 0) / dt,
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
  rebuildRuntimeExposure,
  rebuildThermalNetworks,
  recalculateEffectiveThermalCapacities,
  refreshHeatSourceSignatures,
  refreshHeatRuntimeLists,
  refreshLoadedGeneratorComponents,
  invalidateHeatRuntime,
  refreshHeatRuntimeCableComponents: refreshCableHeatComponents,
  isThermalRouteType,
  updateShipHeat,
  updateShipHeatLegacy,
  buildHeatDebug,
  addComponentHeat,
  distributeComponentHeatByWeight,
  componentPerformance,
  effectiveComponentBonus
};
