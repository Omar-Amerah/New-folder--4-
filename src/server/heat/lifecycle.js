"use strict";

// Ship-local Heat state, sparse runtime caches, and lifecycle invalidation.
// Immutable design topology remains owned by ../thermalTopology.
const { PARTS } = require("../components");
const { getOccupiedCells } = require("../footprint");
const HeatRules = require("../../../public/src/shared/heatRules");
const {
  buildThermalTopology,
  isThermalRouteType
} = require("../thermalTopology");

const {
  STATE,
  profile,
  stateFor,
  activeOutputForState,
  isCoolantTransportType
} = HeatRules;

const TELEMETRY_STRIDE = 6;

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
    const power = require("../componentPower").getComponentPowerMultiplier(ship, index);
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

function powerSourceHeatSignature(ship) {
  return (ship.componentHeat || []).map((_, i) => {
    if ((PARTS[ship.design[i].type]?.powerGeneration || 0) <= 0) return null;
    const alive = (ship.componentHp?.[i] ?? 1) > 0;
    return `${i}:${alive ? 1 : 0}:${alive && ship.componentHeatState[i] === STATE.OVERHEATED ? 1 : 0}`;
  }).filter(Boolean).join(",");
}

function dataSourceHeatSignature(ship) {
  const dataRules = require("../../../public/src/shared/dataSupportRules");
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
    const generators = [...attached].filter((i) => {
      const part = PARTS[design[i].type] || {};
      return HeatRules.activityHeat(design[i].type, part) > 0
        || HeatRules.heatPerShot(design[i].type, part) > 0
        || Number(part.dischargeHeatAtMax) > 0;
    });
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
    // component. This is a diagnostic only - it never scales transfer or drains
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
// adjacency-derived - no rotation, ports or player-configured direction - and a
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
// to componentHeat instead of going through a lifecycle helper. Keep the
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

module.exports = {
  STATE,
  insertOrdered,
  createThermalRuntime,
  ensureThermalRuntime,
  wakeHeatRuntime,
  setHeatBearingMembership,
  setHotMembership,
  addPendingHeatInput,
  clearPendingHeatInputs,
  refreshLoadedGeneratorComponents,
  refreshHeatRuntimeLists,
  invalidateHeatRuntime,
  thermalStable,
  rebuildRuntimeExposure,
  initShipHeat,
  recalculateEffectiveThermalCapacities,
  rebuildThermalNetworks,
  rebuildCoolantNetworks,
  refreshHeatSourceSignatures,
  resetHeatScratch,
  touchHeatNeighbour,
  buildHeatWorkSet
};
