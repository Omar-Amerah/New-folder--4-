"use strict";

const { MAP_CLEARANCES, WORLD } = require("./config");

// A medium ship is deliberately represented by a single conservative circle.
// Generation must stay bounded and deterministic; it must not run the live
// movement controller or station collision system for every candidate.
const REPRESENTATIVE_MEDIUM_SHIP_RADIUS = 110;
const DEFAULT_NAVIGATION_CELL_SIZE = 160;
const MIN_NAVIGATION_CELL_SIZE = 80;
const MAX_NAVIGATION_CELLS = 12000;
const NAVIGATION_NEIGHBOURS = Object.freeze([
  { dx: 1, dy: 0, cost: 1 },
  { dx: -1, dy: 0, cost: 1 },
  { dx: 0, dy: 1, cost: 1 },
  { dx: 0, dy: -1, cost: 1 },
  { dx: 1, dy: 1, cost: Math.SQRT2 },
  { dx: -1, dy: 1, cost: Math.SQRT2 },
  { dx: 1, dy: -1, cost: Math.SQRT2 },
  { dx: -1, dy: -1, cost: Math.SQRT2 }
]);

function finite(value) {
  return Number.isFinite(Number(value));
}

function worldCentre(world = WORLD) {
  return { x: Number(world.width) * 0.5, y: Number(world.height) * 0.5 };
}

function spawnZones(safeZones) {
  return (Array.isArray(safeZones) ? safeZones : []).filter((zone) => (
    zone && finite(zone.x) && finite(zone.y) && finite(zone.radius) && Number(zone.radius) > 0
  ));
}

function zoneLabel(zone, index) {
  return String(zone?.id || zone?.ownerId || zone?.team || `spawn-${index}`);
}

function inwardDirection(zone, world = WORLD) {
  const centre = worldCentre(world);
  const dx = centre.x - Number(zone.x);
  const dy = centre.y - Number(zone.y);
  const length = Math.hypot(dx, dy);
  if (!(length > 1e-9)) return { x: 0, y: 0, length: 0 };
  return { x: dx / length, y: dy / length, length };
}

function relaySpawnGeometry(relay, zone, world = WORLD, clearances = MAP_CLEARANCES) {
  const dx = Number(relay.x) - Number(zone.x);
  const dy = Number(relay.y) - Number(zone.y);
  const distance = Math.hypot(dx, dy);
  const inward = inwardDirection(zone, world);
  const forwardProjection = dx * inward.x + dy * inward.y;
  const radiusSum = Number(relay.radius) + Number(zone.radius);
  const relayToSafeZone = finite(clearances?.relayToSafeZone)
    ? Number(clearances.relayToSafeZone)
    : MAP_CLEARANCES.relayToSafeZone;
  const relayForwardMargin = finite(clearances?.relayForwardMargin)
    ? Number(clearances.relayForwardMargin)
    : MAP_CLEARANCES.relayForwardMargin;
  return {
    distance,
    edgeClearance: distance - radiusSum,
    requiredEdgeClearance: relayToSafeZone,
    forwardProjection,
    requiredForwardProjection: Number(zone.radius) + Number(relay.radius) + relayForwardMargin,
    inward
  };
}

function validateRelaySpawnGeometry(relays, safeZones, world = WORLD, clearances = MAP_CLEARANCES) {
  const reasons = [];
  const zones = spawnZones(safeZones);
  for (let relayIndex = 0; relayIndex < (Array.isArray(relays) ? relays.length : 0); relayIndex += 1) {
    const relay = relays[relayIndex];
    if (!relay || !finite(relay.x) || !finite(relay.y) || !(Number(relay.radius) > 0)) continue;
    for (let zoneIndex = 0; zoneIndex < zones.length; zoneIndex += 1) {
      const zone = zones[zoneIndex];
      const geometry = relaySpawnGeometry(relay, zone, world, clearances);
      const relayLabel = relay.id || `relay-${relayIndex}`;
      const zoneName = zoneLabel(zone, zoneIndex);
      if (geometry.edgeClearance + 1e-9 < geometry.requiredEdgeClearance) {
        reasons.push({
          code: "relay-safe-zone-clearance",
          message: `${relayLabel} is only ${roundMetric(geometry.edgeClearance)}u from ${zoneName}; requires ${geometry.requiredEdgeClearance}u`,
          relayId: relayLabel,
          zoneId: zoneName,
          actual: geometry.edgeClearance,
          required: geometry.requiredEdgeClearance
        });
      }
      if (geometry.forwardProjection + 1e-9 < geometry.requiredForwardProjection) {
        reasons.push({
          code: "relay-behind-spawn",
          message: `${relayLabel} is behind ${zoneName}: forward projection ${roundMetric(geometry.forwardProjection)}u; requires ${roundMetric(geometry.requiredForwardProjection)}u`,
          relayId: relayLabel,
          zoneId: zoneName,
          actual: geometry.forwardProjection,
          required: geometry.requiredForwardProjection
        });
      }
    }
  }
  return reasons;
}

function resolveNavigationCellSize(world, requested) {
  const width = Math.max(1, Number(world?.width) || WORLD.width);
  const height = Math.max(1, Number(world?.height) || WORLD.height);
  let cellSize = Number.isFinite(Number(requested)) ? Math.max(MIN_NAVIGATION_CELL_SIZE, Number(requested)) : DEFAULT_NAVIGATION_CELL_SIZE;
  const estimatedCells = Math.ceil(width / cellSize) * Math.ceil(height / cellSize);
  if (estimatedCells > MAX_NAVIGATION_CELLS) cellSize = Math.max(cellSize, Math.sqrt((width * height) / MAX_NAVIGATION_CELLS));
  return cellSize;
}

function buildNavigationGrid(map, world = WORLD, options = {}) {
  const width = Math.max(1, Number(world?.width) || WORLD.width);
  const height = Math.max(1, Number(world?.height) || WORLD.height);
  const cellSize = resolveNavigationCellSize(world, options.cellSize);
  const cols = Math.max(1, Math.ceil(width / cellSize));
  const rows = Math.max(1, Math.ceil(height / cellSize));
  const blocked = new Uint8Array(cols * rows);
  let blockedCount = 0;
  const shipRadius = Number.isFinite(Number(options.shipRadius))
    ? Math.max(0, Number(options.shipRadius))
    : REPRESENTATIVE_MEDIUM_SHIP_RADIUS;

  for (const asteroid of map?.asteroids || []) {
    if (!asteroid || !finite(asteroid.x) || !finite(asteroid.y) || !(Number(asteroid.radius) > 0)) continue;
    const reach = Number(asteroid.radius) + shipRadius;
    const minX = Math.max(0, Math.floor((Number(asteroid.x) - reach) / cellSize));
    const maxX = Math.min(cols - 1, Math.floor((Number(asteroid.x) + reach) / cellSize));
    const minY = Math.max(0, Math.floor((Number(asteroid.y) - reach) / cellSize));
    const maxY = Math.min(rows - 1, Math.floor((Number(asteroid.y) + reach) / cellSize));
    for (let gy = minY; gy <= maxY; gy += 1) {
      for (let gx = minX; gx <= maxX; gx += 1) {
        const centre = cellCentre(gx, gy, cellSize, width, height);
        if (Math.hypot(centre.x - Number(asteroid.x), centre.y - Number(asteroid.y)) <= reach) {
          const index = gy * cols + gx;
          if (!blocked[index]) {
            blocked[index] = 1;
            blockedCount += 1;
          }
        }
      }
    }
  }
  return { width, height, cellSize, cols, rows, blocked, blockedCount };
}

function cellCentre(gx, gy, cellSize, width, height) {
  return {
    x: Math.min(width, (gx + 0.5) * cellSize),
    y: Math.min(height, (gy + 0.5) * cellSize)
  };
}

function pointCell(point, grid) {
  const gx = Math.max(0, Math.min(grid.cols - 1, Math.floor(Number(point.x) / grid.cellSize)));
  const gy = Math.max(0, Math.min(grid.rows - 1, Math.floor(Number(point.y) / grid.cellSize)));
  return gy * grid.cols + gx;
}

function nearestOpenCell(start, grid) {
  if (start >= 0 && !grid.blocked[start]) return start;
  if (start < 0 || start >= grid.blocked.length) return -1;
  const seen = new Uint8Array(grid.blocked.length);
  const queue = new Int32Array(grid.blocked.length);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  seen[start] = 1;
  while (head < tail) {
    const index = queue[head++];
    if (!grid.blocked[index]) return index;
    const gx = index % grid.cols;
    const gy = (index - gx) / grid.cols;
    for (const neighbour of NAVIGATION_NEIGHBOURS.slice(0, 4)) {
      const nx = gx + neighbour.dx;
      const ny = gy + neighbour.dy;
      if (nx < 0 || ny < 0 || nx >= grid.cols || ny >= grid.rows) continue;
      const next = ny * grid.cols + nx;
      if (seen[next]) continue;
      seen[next] = 1;
      queue[tail++] = next;
    }
  }
  return -1;
}

class MinHeap {
  constructor() {
    this.indices = [];
    this.values = [];
  }

  get size() { return this.indices.length; }

  push(index, value) {
    let position = this.indices.length;
    this.indices.push(index);
    this.values.push(value);
    while (position > 0) {
      const parent = (position - 1) >> 1;
      if (this.values[parent] <= value) break;
      this.indices[position] = this.indices[parent];
      this.values[position] = this.values[parent];
      position = parent;
    }
    this.indices[position] = index;
    this.values[position] = value;
  }

  pop() {
    if (!this.indices.length) return null;
    const result = { index: this.indices[0], value: this.values[0] };
    const lastIndex = this.indices.pop();
    const lastValue = this.values.pop();
    if (this.indices.length) {
      let position = 0;
      while (true) {
        const left = position * 2 + 1;
        if (left >= this.indices.length) break;
        const right = left + 1;
        const child = right < this.indices.length && this.values[right] < this.values[left] ? right : left;
        if (this.values[child] >= lastValue) break;
        this.indices[position] = this.indices[child];
        this.values[position] = this.values[child];
        position = child;
      }
      this.indices[position] = lastIndex;
      this.values[position] = lastValue;
    }
    return result;
  }
}

function routeDistancesFromPoint(point, targets, grid) {
  if (grid.blockedCount === 0) return targets.map((target) => Math.hypot(Number(target.x) - Number(point.x), Number(target.y) - Number(point.y)));
  const start = nearestOpenCell(pointCell(point, grid), grid);
  const wanted = new Map();
  for (let index = 0; index < targets.length; index += 1) {
    const cell = nearestOpenCell(pointCell(targets[index], grid), grid);
    wanted.set(cell, wanted.has(cell) ? wanted.get(cell).concat(index) : [index]);
  }
  const distances = new Array(targets.length).fill(Infinity);
  if (start < 0 || wanted.size === 0) return distances;
  const costs = new Float64Array(grid.blocked.length);
  costs.fill(Infinity);
  costs[start] = 0;
  const heap = new MinHeap();
  heap.push(start, 0);
  let resolved = 0;
  while (heap.size && resolved < wanted.size) {
    const item = heap.pop();
    if (!item || item.value !== costs[item.index]) continue;
    const targetIndexes = wanted.get(item.index);
    if (targetIndexes) {
      const centre = cellCentre(item.index % grid.cols, (item.index / grid.cols) | 0, grid.cellSize, grid.width, grid.height);
      for (const targetIndex of targetIndexes) {
        const target = targets[targetIndex];
        distances[targetIndex] = item.value * grid.cellSize + Math.hypot(Number(target.x) - centre.x, Number(target.y) - centre.y);
      }
      // The start offset is added once to every route. It is not a fairness
      // distortion because all routes from this spawn share the same origin.
      const startCentre = cellCentre(start % grid.cols, (start / grid.cols) | 0, grid.cellSize, grid.width, grid.height);
      const startOffset = Math.hypot(Number(point.x) - startCentre.x, Number(point.y) - startCentre.y);
       for (const targetIndex of targetIndexes) distances[targetIndex] += startOffset;
       resolved += 1;
    }
    const gx = item.index % grid.cols;
    const gy = (item.index - gx) / grid.cols;
    for (const neighbour of NAVIGATION_NEIGHBOURS) {
      const nx = gx + neighbour.dx;
      const ny = gy + neighbour.dy;
      if (nx < 0 || ny < 0 || nx >= grid.cols || ny >= grid.rows) continue;
      // Do not cut diagonally through the corner of an inflated asteroid.
      if (neighbour.dx !== 0 && neighbour.dy !== 0) {
        const sideA = gy * grid.cols + nx;
        const sideB = ny * grid.cols + gx;
        if (grid.blocked[sideA] || grid.blocked[sideB]) continue;
      }
      const next = ny * grid.cols + nx;
      if (grid.blocked[next]) continue;
      const nextCost = item.value + neighbour.cost;
      if (nextCost >= costs[next]) continue;
      costs[next] = nextCost;
      heap.push(next, nextCost);
    }
  }
  return distances;
}

function relativeDifference(a, b) {
  if (!finite(a) || !finite(b)) return Infinity;
  const denominator = Math.max(Math.abs(Number(a)), Math.abs(Number(b)), 1e-9);
  return Math.abs(Number(a) - Number(b)) / denominator;
}

function ratioOfExtremes(values) {
  const finiteValues = values.filter((value) => finite(value) && Number(value) >= 0);
  if (!finiteValues.length) return Infinity;
  const minimum = Math.min(...finiteValues);
  const maximum = Math.max(...finiteValues);
  if (!(minimum > 0) || !finite(maximum)) return Infinity;
  return maximum / minimum;
}

function mean(values) {
  if (!values.length || values.some((value) => !finite(value))) return Infinity;
  return values.reduce((sum, value) => sum + Number(value), 0) / values.length;
}

function inferMode(map, safeZones, options) {
  if (options?.mode === "solo" || options?.gameMode === "solo") return "solo";
  if (options?.mode === "teams" || options?.gameMode === "teams") return "teams";
  const zones = spawnZones(safeZones);
  return zones.some((zone) => zone.team != null) ? "teams" : "solo";
}

function groupKey(zone, index, mode) {
  if (mode === "solo") return zone.ownerId != null ? `player:${zone.ownerId}` : `spawn:${zoneLabel(zone, index)}`;
  return zone.team != null ? `team:${zone.team}` : `team:${zoneLabel(zone, index)}`;
}

function evaluateMapFairness(map, world = WORLD, safeZones = map?.safeZones || [], options = {}) {
  const zones = spawnZones(safeZones);
  const relays = Array.isArray(map?.relays) ? map.relays.filter((relay) => relay && finite(relay.x) && finite(relay.y) && Number(relay.radius) > 0) : [];
  const reasons = [];
  const mode = inferMode(map, zones, options);
  const clearances = options.clearances || MAP_CLEARANCES;
  if (!zones.length) reasons.push({ code: "no-safe-zones", message: "No authoritative spawn safe zones were supplied" });
  if (!relays.length) reasons.push({ code: "no-relays", message: "No relays were supplied" });

  if (!options.skipGeometry) {
    for (const reason of validateRelaySpawnGeometry(relays, zones, world, clearances)) reasons.push(reason);
  }

  const grid = buildNavigationGrid(map, world, options);
  const perSpawn = zones.map((zone, spawnIndex) => {
    const routeDistances = routeDistancesFromPoint(zone, relays, grid);
    const surfaceDistances = relays.map((relay) => Math.max(0, Math.hypot(Number(relay.x) - Number(zone.x), Number(relay.y) - Number(zone.y)) - Number(zone.radius) - Number(relay.radius)));
    const sortedRoutes = [...routeDistances].sort((a, b) => a - b);
    const nearest = sortedRoutes[0] ?? Infinity;
    const twoNearest = sortedRoutes.slice(0, 2);
    const entry = {
      id: zoneLabel(zone, spawnIndex),
      index: spawnIndex,
      team: zone.team ?? null,
      ownerId: zone.ownerId ?? null,
      nearestRelayRouteDistance: nearest,
      meanTwoNearestRouteDistance: mean(twoNearest),
      meanAllRelayRouteDistance: mean(routeDistances),
      routeDistances,
      surfaceDistances,
      reachableRelayCount: routeDistances.filter((distance) => finite(distance)).length,
      totalRelayCount: relays.length
    };
    if (routeDistances.some((distance) => !finite(distance))) {
      reasons.push({ code: "unreachable-relay", message: `${entry.id} cannot reach every relay`, spawnId: entry.id });
    }
    if (![entry.nearestRelayRouteDistance, entry.meanTwoNearestRouteDistance, entry.meanAllRelayRouteDistance].every((value) => finite(value) && Number(value) > 0)) {
      reasons.push({ code: "non-finite-fairness-metric", message: `${entry.id} has a non-finite or zero route metric`, spawnId: entry.id });
    }
    return entry;
  });

  const perRelay = relays.map((relay, relayIndex) => {
    const routeDistances = perSpawn.map((spawn) => spawn.routeDistances[relayIndex] ?? Infinity);
    let fastestSpawn = -1;
    let slowestSpawn = -1;
    for (let index = 0; index < routeDistances.length; index += 1) {
      if (fastestSpawn < 0 || routeDistances[index] < routeDistances[fastestSpawn]) fastestSpawn = index;
      if (slowestSpawn < 0 || routeDistances[index] > routeDistances[slowestSpawn]) slowestSpawn = index;
    }
    return {
      id: relay.id || `relay-${relayIndex}`,
      routeDistances,
      fastestSpawn: fastestSpawn >= 0 ? perSpawn[fastestSpawn]?.id || null : null,
      slowestSpawn: slowestSpawn >= 0 ? perSpawn[slowestSpawn]?.id || null : null,
      meaningfulAdvantage: fastestSpawn >= 0 && slowestSpawn >= 0 && routeDistances[fastestSpawn] <= routeDistances[slowestSpawn] * 0.9
    };
  });

  const metrics = {
    mode,
    gridCellSize: grid.cellSize,
    spawnCount: zones.length,
    relayCount: relays.length,
    unreachableRoutes: perSpawn.reduce((count, spawn) => count + (spawn.routeDistances.filter((distance) => !finite(distance)).length), 0),
    team: null,
    solo: null
  };
  let score = 0;

  if (mode === "teams" && perSpawn.length >= 2) {
    const groups = new Map();
    for (let index = 0; index < zones.length; index += 1) {
      const key = groupKey(zones[index], index, mode);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(perSpawn[index]);
    }
    const teamEntries = [...groups.entries()].map(([key, members]) => {
      const nearestValues = members.map((entry) => entry.nearestRelayRouteDistance);
      const twoNearestValues = members.map((entry) => entry.meanTwoNearestRouteDistance);
      const allValues = members.map((entry) => entry.meanAllRelayRouteDistance);
      const routeDistances = relays.map((_, relayIndex) => mean(members.map((entry) => entry.routeDistances[relayIndex])));
      return {
        id: key,
        nearestRelayRouteDistance: Math.min(...nearestValues),
        meanTwoNearestRouteDistance: mean(twoNearestValues),
        meanAllRelayRouteDistance: mean(allValues),
        routeDistances,
        meaningfulAdvantageCount: 0
      };
    });
    if (teamEntries.length === 2) {
      for (let relayIndex = 0; relayIndex < relays.length; relayIndex += 1) {
        const first = teamEntries[0].routeDistances[relayIndex];
        const second = teamEntries[1].routeDistances[relayIndex];
        if (first <= second * 0.9) teamEntries[0].meaningfulAdvantageCount += 1;
        else if (second <= first * 0.9) teamEntries[1].meaningfulAdvantageCount += 1;
      }
      const nearestDifference = relativeDifference(teamEntries[0].nearestRelayRouteDistance, teamEntries[1].nearestRelayRouteDistance);
      const twoNearestDifference = relativeDifference(teamEntries[0].meanTwoNearestRouteDistance, teamEntries[1].meanTwoNearestRouteDistance);
      const allDifference = relativeDifference(teamEntries[0].meanAllRelayRouteDistance, teamEntries[1].meanAllRelayRouteDistance);
      const advantageDifference = Math.abs(teamEntries[0].meaningfulAdvantageCount - teamEntries[1].meaningfulAdvantageCount);
      metrics.team = { teams: teamEntries, nearestDifference, twoNearestDifference, allDifference, advantageDifference };
      score += nearestDifference / 0.12 + twoNearestDifference / 0.10 + allDifference / 0.08 + advantageDifference / Math.max(1, relays.length);
      if (nearestDifference > 0.12) reasons.push({ code: "team-nearest-imbalance", message: `Nearest relay routes differ by ${roundMetric(nearestDifference * 100)}%`, actual: nearestDifference, limit: 0.12 });
      if (twoNearestDifference > 0.10) reasons.push({ code: "team-two-nearest-imbalance", message: `Mean two-nearest routes differ by ${roundMetric(twoNearestDifference * 100)}%`, actual: twoNearestDifference, limit: 0.10 });
      if (allDifference > 0.08) reasons.push({ code: "team-all-relay-imbalance", message: `Mean all-relay routes differ by ${roundMetric(allDifference * 100)}%`, actual: allDifference, limit: 0.08 });
      if (advantageDifference > 1) reasons.push({ code: "team-advantage-count-imbalance", message: `Meaningful relay advantages differ by ${advantageDifference}`, actual: advantageDifference, limit: 1 });
    } else {
      reasons.push({ code: "team-grouping", message: "Team fairness requires exactly two authoritative team spawn groups" });
    }
  } else if (mode === "solo") {
    const nearestRatio = ratioOfExtremes(perSpawn.map((entry) => entry.nearestRelayRouteDistance));
    const twoNearestRatio = ratioOfExtremes(perSpawn.map((entry) => entry.meanTwoNearestRouteDistance));
    const allRatio = ratioOfExtremes(perSpawn.map((entry) => entry.meanAllRelayRouteDistance));
    metrics.solo = { nearestRatio, twoNearestRatio, allRatio };
    score += nearestRatio / 1.15 + twoNearestRatio / 1.12 + allRatio / 1.10;
    if (nearestRatio > 1.15) reasons.push({ code: "solo-nearest-imbalance", message: `Solo nearest relay ratio is ${roundMetric(nearestRatio)}; limit is 1.15`, actual: nearestRatio, limit: 1.15 });
    if (twoNearestRatio > 1.12) reasons.push({ code: "solo-two-nearest-imbalance", message: `Solo two-nearest route ratio is ${roundMetric(twoNearestRatio)}; limit is 1.12`, actual: twoNearestRatio, limit: 1.12 });
    if (allRatio > 1.10) reasons.push({ code: "solo-all-relay-imbalance", message: `Solo all-relay route ratio is ${roundMetric(allRatio)}; limit is 1.10`, actual: allRatio, limit: 1.10 });
  }

  return {
    valid: reasons.length === 0,
    score: finite(score) ? roundMetric(score) : Infinity,
    reasons,
    perSpawn,
    perRelay,
    metrics
  };
}

function allSafeZonesReachRelays(map, world = WORLD, safeZones = map?.safeZones || [], options = {}) {
  const zones = spawnZones(safeZones);
  const relays = Array.isArray(map?.relays) ? map.relays : [];
  if (!zones.length || !relays.length) return true;
  const grid = buildNavigationGrid(map, world, options);
  return zones.every((zone) => routeDistancesFromPoint(zone, relays, grid).every((distance) => finite(distance)));
}

function compactFairnessMetrics(fairness) {
  if (!fairness || typeof fairness !== "object") return null;
  const metrics = fairness.metrics || {};
  return {
    mode: metrics.mode || null,
    gridCellSize: roundMetric(metrics.gridCellSize),
    spawnCount: metrics.spawnCount || 0,
    relayCount: metrics.relayCount || 0,
    unreachableRoutes: metrics.unreachableRoutes || 0,
    team: metrics.team ? {
      nearestDifference: roundMetric(metrics.team.nearestDifference),
      twoNearestDifference: roundMetric(metrics.team.twoNearestDifference),
      allDifference: roundMetric(metrics.team.allDifference),
      advantageDifference: metrics.team.advantageDifference,
      teams: metrics.team.teams.map((team) => ({
        id: team.id,
        nearestRelayRouteDistance: roundMetric(team.nearestRelayRouteDistance),
        meanTwoNearestRouteDistance: roundMetric(team.meanTwoNearestRouteDistance),
        meanAllRelayRouteDistance: roundMetric(team.meanAllRelayRouteDistance),
        meaningfulAdvantageCount: team.meaningfulAdvantageCount
      }))
    } : null,
    solo: metrics.solo ? {
      nearestRatio: roundMetric(metrics.solo.nearestRatio),
      twoNearestRatio: roundMetric(metrics.solo.twoNearestRatio),
      allRatio: roundMetric(metrics.solo.allRatio)
    } : null
  };
}

function roundMetric(value) {
  if (!finite(value)) return value;
  return Math.round(Number(value) * 1000) / 1000;
}

module.exports = {
  REPRESENTATIVE_MEDIUM_SHIP_RADIUS,
  DEFAULT_NAVIGATION_CELL_SIZE,
  inwardDirection,
  relaySpawnGeometry,
  validateRelaySpawnGeometry,
  buildNavigationGrid,
  allSafeZonesReachRelays,
  evaluateMapFairness,
  compactFairnessMetrics,
  roundMetric
};
