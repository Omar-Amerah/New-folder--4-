"use strict";

// Immutable, design-only thermal topology.  Runtime Heat state (capacity,
// exposure, HP, routing and Power allocation) deliberately lives on the ship.

const { PARTS } = require("./components");
const { getOccupiedCells } = require("./footprint");
const HeatRules = require("../../public/src/shared/heatRules");
const DataSupportRules = require("../../public/src/shared/dataSupportRules");

const DIRECTIONS = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]]);
let topologyBuilds = 0;

function isThermalRouteType(type) {
  const normalized = String(type || "");
  return normalized === "heatPipe" || /frame/i.test(normalized);
}

function cellKey(x, y) {
  return `${x},${y}`;
}

function freezeTopology(value) {
  if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) return value;
  if (Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) freezeTopology(value[key]);
  return Object.freeze(value);
}

function buildThermalTopology(design = []) {
  const componentCount = Array.isArray(design) ? design.length : 0;
  const cellsByComponent = new Array(componentCount);
  const componentCellIndex = new Map();

  for (let i = 0; i < componentCount; i += 1) {
    const module = design[i] || {};
    const part = PARTS[module.type] || PARTS.frame;
    const cells = getOccupiedCells(module.x, module.y, part.footprint || { width: 1, height: 1 }, module.rotation || 0);
    cellsByComponent[i] = cells;
    for (const cell of cells) componentCellIndex.set(cellKey(cell.x, cell.y), i);
  }

  const edgeCounts = Array.from({ length: componentCount }, () => new Map());
  for (let i = 0; i < componentCount; i += 1) {
    for (const cell of cellsByComponent[i]) {
      for (const [dx, dy] of DIRECTIONS) {
        const owner = componentCellIndex.get(cellKey(cell.x + dx, cell.y + dy));
        if (owner === undefined || owner === i) continue;
        edgeCounts[i].set(owner, (edgeCounts[i].get(owner) || 0) + 1);
      }
    }
  }

  const edges = [];
  for (let a = 0; a < componentCount; a += 1) {
    const thermalA = HeatRules.profile(design[a]?.type, PARTS[design[a]?.type] || PARTS.frame);
    for (const [b, sharedEdges] of edgeCounts[a]) {
      if (a >= b) continue;
      const thermalB = HeatRules.profile(design[b]?.type, PARTS[design[b]?.type] || PARTS.frame);
      const typeA = design[a]?.type;
      const typeB = design[b]?.type;
      edges.push({
        a,
        b,
        sharedEdges,
        baseConductivity: HeatRules.edgeConductivity(thermalA, thermalB),
        routeMultiplier: HeatRules.routeTypeMultiplier(typeA, typeB),
        throughFrame: isThermalRouteType(typeA) || isThermalRouteType(typeB)
      });
    }
  }
  edges.sort((left, right) => left.a - right.a || left.b - right.b);

  const edgeA = [];
  const edgeB = [];
  const edgeSharedEdges = [];
  const edgeBaseConductivity = [];
  const edgeRouteMultiplier = [];
  const edgeThroughFrame = [];
  const incident = Array.from({ length: componentCount }, () => []);
  const componentAdjacency = Array.from({ length: componentCount }, () => []);

  for (let edgeId = 0; edgeId < edges.length; edgeId += 1) {
    const edge = edges[edgeId];
    edgeA.push(edge.a);
    edgeB.push(edge.b);
    edgeSharedEdges.push(edge.sharedEdges);
    edgeBaseConductivity.push(edge.baseConductivity);
    edgeRouteMultiplier.push(edge.routeMultiplier);
    edgeThroughFrame.push(edge.throughFrame ? 1 : 0);
    incident[edge.a].push(edgeId);
    incident[edge.b].push(edgeId);
  }

  // Keep the compatibility adjacency in the same per-component insertion
  // order as the former Heat initializer.  The packed incident-edge arrays
  // below remain canonical edge-ID order for Phase 6A; this view only exists
  // for legacy transfer ordering and established diagnostics.
  const edgeIdByPair = new Map();
  for (let edgeId = 0; edgeId < edges.length; edgeId += 1) {
    const edge = edges[edgeId];
    edgeIdByPair.set(`${edge.a},${edge.b}`, edgeId);
  }
  for (let i = 0; i < componentCount; i += 1) {
    for (const [neighbour] of edgeCounts[i]) {
      const a = Math.min(i, neighbour);
      const b = Math.max(i, neighbour);
      const edgeId = edgeIdByPair.get(`${a},${b}`);
      const edge = Number.isInteger(edgeId) ? edges[edgeId] : null;
      const fallbackA = HeatRules.profile(design[i]?.type, PARTS[design[i]?.type] || PARTS.frame);
      const fallbackB = HeatRules.profile(design[neighbour]?.type, PARTS[design[neighbour]?.type] || PARTS.frame);
      componentAdjacency[i].push({
        index: neighbour,
        sharedEdges: edge?.sharedEdges ?? edgeCounts[i].get(neighbour) ?? 0,
        conductivity: edge?.baseConductivity ?? HeatRules.edgeConductivity(fallbackA, fallbackB),
        edgeId: Number.isInteger(edgeId) ? edgeId : -1
      });
    }
  }

  const incidentEdgeOffsets = new Array(componentCount + 1).fill(0);
  const legacyTransferOrder = [];
  const legacyTransferRank = new Array(edges.length).fill(-1);
  for (let i = 0; i < componentCount; i += 1) incidentEdgeOffsets[i + 1] = incidentEdgeOffsets[i] + incident[i].length;
  const incidentEdgeIds = new Array(incidentEdgeOffsets[componentCount]);
  for (let i = 0; i < componentCount; i += 1) {
    // Edges are globally canonical, therefore this is deterministic without a
    // per-component sort.  Keep the explicit sort as a guard for future builders.
    incident[i].sort((a, b) => a - b);
    for (let offset = 0; offset < incident[i].length; offset += 1) {
      incidentEdgeIds[incidentEdgeOffsets[i] + offset] = incident[i][offset];
    }
    componentAdjacency[i] = componentAdjacency[i].map((edge) => Object.freeze(edge));
    Object.freeze(componentAdjacency[i]);

    // The legacy solver walks component indices in ascending order and then
    // walks this compatibility adjacency in its original insertion order.
    // Only the lower endpoint processes a unique edge (`j > i`).  Preserve
    // that exact edge sequence so the allocation-free solver has the same
    // floating-point accumulation order without scanning the whole graph.
    for (const edge of componentAdjacency[i]) {
      if (edge.index <= i || edge.edgeId < 0) continue;
      legacyTransferRank[edge.edgeId] = legacyTransferOrder.length;
      legacyTransferOrder.push(edge.edgeId);
    }
  }

  const powerSourceIndices = [];
  const dataSourceIndices = [];
  const radiatorIndices = [];
  const heatSinkIndices = [];
  const thermalRouteIndices = [];
  for (let i = 0; i < componentCount; i += 1) {
    const module = design[i] || {};
    const part = PARTS[module.type] || {};
    if (Number(part.powerGeneration) > 0) powerSourceIndices.push(i);
    if (DataSupportRules.isDataSupportSource(module.type)) dataSourceIndices.push(i);
    if (module.type === "radiator") radiatorIndices.push(i);
    if (module.type === "heatSink") heatSinkIndices.push(i);
    if (isThermalRouteType(module.type)) thermalRouteIndices.push(i);
  }

  topologyBuilds += 1;
  return freezeTopology({
    componentCount,
    edgeA,
    edgeB,
    edgeSharedEdges,
    edgeBaseConductivity,
    edgeRouteMultiplier,
    edgeThroughFrame,
    legacyTransferOrder,
    legacyTransferRank,
    incidentEdgeOffsets,
    incidentEdgeIds,
    powerSourceIndices,
    dataSourceIndices,
    radiatorIndices,
    heatSinkIndices,
    thermalRouteIndices,
    componentAdjacency
  });
}

function topologyMetrics() {
  return { builds: topologyBuilds };
}

function createComponentAdjacency(topology) {
  return topology.componentAdjacency.map((edges) => edges.map((edge) => ({
    index: edge.index,
    sharedEdges: edge.sharedEdges,
    conductivity: edge.conductivity,
    edgeId: edge.edgeId
  })));
}

// The old Heat implementation exposed a mutable per-ship adjacency view and a
// few diagnostics/tests still use that contract.  Keep the view available, but
// do not pay for a clone on every optimized ship.  The accessor materializes a
// compatibility copy only when a legacy loop or an explicit diagnostic asks
// for it.  The immutable topology remains the normal optimized source.
function installLazyComponentAdjacency(ship, topology) {
  if (!ship || !topology) return ship;
  const existingDescriptor = Object.getOwnPropertyDescriptor(ship, "componentAdjacency");
  if (existingDescriptor?.get?.__thermalLazyAdjacency && ship._componentAdjacencyTopology === topology) return ship;

  let materialized = ship._componentAdjacencyTopology === topology
    ? (ship._componentAdjacencyValue || null)
    : null;
  if (!materialized && existingDescriptor && !existingDescriptor.get && Array.isArray(existingDescriptor.value)) {
    materialized = existingDescriptor.value;
  }

  Object.defineProperty(ship, "_componentAdjacencyValue", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: materialized
  });
  Object.defineProperty(ship, "_componentAdjacencyTopology", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: topology
  });

  const getter = function getComponentAdjacency() {
    if (!materialized) materialized = createComponentAdjacency(topology);
    ship._componentAdjacencyValue = materialized;
    return materialized;
  };
  getter.__thermalLazyAdjacency = true;
  Object.defineProperty(ship, "componentAdjacency", {
    configurable: true,
    enumerable: true,
    get: getter,
    set(value) {
      materialized = value;
      ship._componentAdjacencyValue = value;
    }
  });
  return ship;
}

function ensureComponentAdjacency(ship) {
  if (!ship) return null;
  const topology = ship.thermalTopology || buildThermalTopology(ship.design || []);
  ship.thermalTopology = topology;
  installLazyComponentAdjacency(ship, topology);
  return ship.componentAdjacency;
}

function getMaterializedComponentAdjacency(ship) {
  return ship?._componentAdjacencyValue || null;
}

module.exports = {
  buildThermalTopology,
  createComponentAdjacency,
  ensureComponentAdjacency,
  getMaterializedComponentAdjacency,
  installLazyComponentAdjacency,
  isThermalRouteType,
  topologyMetrics
};
