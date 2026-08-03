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

  // Preserve the accepted transfer accumulation order as immutable topology
  // metadata. It is built once from the deterministic design-cell traversal;
  // the runtime solver consumes the packed order without rebuilding adjacency.
  const edgeIdByPair = new Map();
  for (let edgeId = 0; edgeId < edges.length; edgeId += 1) {
    const edge = edges[edgeId];
    edgeIdByPair.set(`${edge.a},${edge.b}`, edgeId);
  }
  const transferOrder = [];
  const transferRank = new Array(edges.length).fill(-1);
  for (let i = 0; i < componentCount; i += 1) {
    for (const [neighbour] of edgeCounts[i]) {
      const a = Math.min(i, neighbour);
      const b = Math.max(i, neighbour);
      const edgeId = edgeIdByPair.get(`${a},${b}`);
      if (neighbour <= i || !Number.isInteger(edgeId)) continue;
      transferRank[edgeId] = transferOrder.length;
      transferOrder.push(edgeId);
    }
  }

  const incidentEdgeOffsets = new Array(componentCount + 1).fill(0);
  for (let i = 0; i < componentCount; i += 1) incidentEdgeOffsets[i + 1] = incidentEdgeOffsets[i] + incident[i].length;
  const incidentEdgeIds = new Array(incidentEdgeOffsets[componentCount]);
  for (let i = 0; i < componentCount; i += 1) {
    // Edges are globally canonical, therefore this is deterministic without a
    // per-component sort.  Keep the explicit sort as a guard for future builders.
    incident[i].sort((a, b) => a - b);
    for (let offset = 0; offset < incident[i].length; offset += 1) {
      incidentEdgeIds[incidentEdgeOffsets[i] + offset] = incident[i][offset];
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
    transferOrder,
    transferRank,
    incidentEdgeOffsets,
    incidentEdgeIds,
    powerSourceIndices,
    dataSourceIndices,
    radiatorIndices,
    heatSinkIndices,
    thermalRouteIndices
  });
}

function topologyMetrics() {
  return { builds: topologyBuilds };
}

function createComponentAdjacency(topology) {
  const adjacency = Array.from({ length: topology.componentCount }, () => []);
  for (let index = 0; index < topology.componentCount; index += 1) {
    const start = topology.incidentEdgeOffsets[index];
    const end = topology.incidentEdgeOffsets[index + 1];
    for (let offset = start; offset < end; offset += 1) {
      const edgeId = topology.incidentEdgeIds[offset];
      const neighbour = topology.edgeA[edgeId] === index ? topology.edgeB[edgeId] : topology.edgeA[edgeId];
      adjacency[index].push({
        index: neighbour,
        sharedEdges: topology.edgeSharedEdges[edgeId],
        conductivity: topology.edgeBaseConductivity[edgeId],
        edgeId
      });
    }
    Object.freeze(adjacency[index]);
  }
  return adjacency;
}

module.exports = {
  buildThermalTopology,
  createComponentAdjacency,
  isThermalRouteType,
  topologyMetrics
};
