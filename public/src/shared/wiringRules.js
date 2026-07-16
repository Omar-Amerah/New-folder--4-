(function initWiringRules(root, factory) {
  const rules = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = rules;
  root.WiringRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeWiringRules() {
  "use strict";

  // Shared ship-wiring engine used by both the designer client and the server.
  // Wires are unit-length orthogonal segments between grid points (0..15) on
  // the 15x15 blueprint. Power and Data are independent networks that may share
  // grid edges. Networks are always derived from segments — network ids,
  // connectivity and bonuses are never stored or trusted from a payload.

  const GRID_SIZE = 15;          // blueprint cells per axis
  const POINT_MAX = GRID_SIZE;   // grid points run 0..15 inclusive
  const WIRING_VERSION = 1;
  const NETWORK_KINDS = Object.freeze(["power", "data"]);
  // Payload cap per network kind. The full 15x15 board only has 480 edges, so
  // 240 per kind is generous for real ships while bounding message size.
  const MAX_SEGMENTS_PER_KIND = 240;

  const POWER_SOURCE_TYPES = Object.freeze(["core", "reactor", "auxGenerator"]);

  // Data-support modules and the future per-weapon bonus they will grant. The
  // bonuses are preview-only in the designer for now: nothing here changes
  // combat stats. Fire-rate coordination cannot drive continuous beams, so
  // beam-family weapons are incompatible with Fire Control.
  const DATA_SOURCE_INFO = Object.freeze({
    fireControl: Object.freeze({ bonusField: "fireRateBonus", effect: "fire rate", unit: "percent", incompatibleFamilies: Object.freeze(["beam"]) }),
    sensorArray: Object.freeze({ bonusField: "rangeBonus", effect: "range", unit: "m", incompatibleFamilies: Object.freeze([]) }),
    signalAmplifier: Object.freeze({ bonusField: "rangeBonus", effect: "range", unit: "m", incompatibleFamilies: Object.freeze([]) }),
    targetingComputer: Object.freeze({ bonusField: "accuracyBonus", effect: "accuracy", unit: "percent", incompatibleFamilies: Object.freeze([]) }),
    stabilizerNode: Object.freeze({ bonusField: "accuracyBonus", effect: "accuracy", unit: "percent", incompatibleFamilies: Object.freeze([]) })
  });
  const DATA_SOURCE_TYPES = Object.freeze(Object.keys(DATA_SOURCE_INFO));

  function partStat(catalogue, type) {
    return (catalogue && (catalogue[type] || catalogue.frame)) || {};
  }

  function isPowerSourceType(type) { return POWER_SOURCE_TYPES.includes(type); }
  function isPowerConsumer(type, catalogue) {
    return !isPowerSourceType(type) && (Number(partStat(catalogue, type).powerUse) || 0) > 0;
  }
  function isDataSourceType(type) { return Object.prototype.hasOwnProperty.call(DATA_SOURCE_INFO, type); }
  function isDataTarget(type, catalogue) { return Boolean(partStat(catalogue, type).weapon); }
  function isCompatibleWeapon(sourceType, weaponType, catalogue) {
    const info = DATA_SOURCE_INFO[sourceType];
    if (!info || !isDataTarget(weaponType, catalogue)) return false;
    const family = partStat(catalogue, weaponType).weapon?.type || "";
    return !info.incompatibleFamilies.includes(family);
  }
  function sourceBonusAmount(sourceType, catalogue) {
    const info = DATA_SOURCE_INFO[sourceType];
    if (!info) return 0;
    return Number(partStat(catalogue, sourceType)[info.bonusField]) || 0;
  }

  // Rotates a component's footprint around its anchor tile. Kept in sync with
  // src/server/footprint.js and public/src/design/footprint.js.
  function getOccupiedCells(x, y, footprint, rotation = 0) {
    const cells = [];
    const width = (footprint && footprint.width) || 1;
    const height = (footprint && footprint.height) || 1;
    const normalizedRotation = (rotation % 360 + 360) % 360;
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        let ox;
        let oy;
        if (normalizedRotation === 90) { ox = -dy; oy = dx; }
        else if (normalizedRotation === 180) { ox = -dx; oy = -dy; }
        else if (normalizedRotation === 270) { ox = dy; oy = -dx; }
        else { ox = dx; oy = dy; }
        cells.push({ x: x + ox, y: y + oy });
      }
    }
    return cells;
  }

  function moduleCells(module, catalogue) {
    const stat = partStat(catalogue, module.type);
    return getOccupiedCells(module.x, module.y, stat.footprint || { width: 1, height: 1 }, module.rotation || 0);
  }

  function cellKey(x, y) { return `${x},${y}`; }
  function pointKey(x, y) { return `${x},${y}`; }

  function occupiedCellSet(modules, catalogue) {
    const occupied = new Set();
    for (const module of Array.isArray(modules) ? modules : []) {
      if (!module) continue;
      for (const cell of moduleCells(module, catalogue)) occupied.add(cellKey(cell.x, cell.y));
    }
    return occupied;
  }

  // Connection ports: every grid point on the outer corners/edges of the
  // component's rotated footprint. A wire endpoint landing on any port
  // connects to the whole component (multi-cell components are one
  // internally connected component).
  function componentPorts(module, catalogue) {
    const points = new Map();
    for (const cell of moduleCells(module, catalogue)) {
      for (const [px, py] of [[cell.x, cell.y], [cell.x + 1, cell.y], [cell.x, cell.y + 1], [cell.x + 1, cell.y + 1]]) {
        if (px < 0 || px > POINT_MAX || py < 0 || py > POINT_MAX) continue;
        points.set(pointKey(px, py), { x: px, y: py });
      }
    }
    return [...points.values()].sort(comparePoints);
  }

  function comparePoints(a, b) { return a.y - b.y || a.x - b.x; }

  function compareSegments(a, b) {
    return a.y1 - b.y1 || a.x1 - b.x1 || a.y2 - b.y2 || a.x2 - b.x2;
  }

  // Normalizes one raw segment: integer endpoints, unit length, orthogonal,
  // in bounds, with a canonical endpoint order. Returns null when malformed.
  function normalizeSegment(raw) {
    if (!raw || typeof raw !== "object") return null;
    const x1 = Math.trunc(Number(raw.x1));
    const y1 = Math.trunc(Number(raw.y1));
    const x2 = Math.trunc(Number(raw.x2));
    const y2 = Math.trunc(Number(raw.y2));
    for (const value of [x1, y1, x2, y2]) {
      if (!Number.isInteger(value) || value < 0 || value > POINT_MAX) return null;
    }
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    if (dx + dy !== 1) return null; // no diagonal or zero-length segments
    if (y1 < y2 || (y1 === y2 && x1 <= x2)) return { x1, y1, x2, y2 };
    return { x1: x2, y1: y2, x2: x1, y2: y1 };
  }

  function segmentKey(segment) {
    return `${segment.x1},${segment.y1}:${segment.x2},${segment.y2}`;
  }

  // Cells the segment is attached to or immediately beside: every cell that
  // touches either endpoint. A segment must border at least one occupied ship
  // cell so wiring can never float away from the hull.
  function segmentNeighbourCells(segment) {
    const cells = new Map();
    for (const point of [{ x: segment.x1, y: segment.y1 }, { x: segment.x2, y: segment.y2 }]) {
      for (const [cx, cy] of [[point.x - 1, point.y - 1], [point.x, point.y - 1], [point.x - 1, point.y], [point.x, point.y]]) {
        if (cx < 0 || cx >= GRID_SIZE || cy < 0 || cy >= GRID_SIZE) continue;
        cells.set(cellKey(cx, cy), { x: cx, y: cy });
      }
    }
    return [...cells.values()];
  }

  function isSegmentAttached(segment, occupied) {
    return segmentNeighbourCells(segment).some((cell) => occupied.has(cellKey(cell.x, cell.y)));
  }

  // Validates one already-normalized segment against the ship layout.
  function validateSegment(rawSegment, modules, catalogue, occupied = null) {
    const segment = normalizeSegment(rawSegment);
    if (!segment) return { ok: false, reason: "malformed" };
    const cells = occupied || occupiedCellSet(modules, catalogue);
    if (!isSegmentAttached(segment, cells)) return { ok: false, reason: "floating" };
    return { ok: true, segment };
  }

  function normalizeSegmentList(list, occupied) {
    const seen = new Set();
    const clean = [];
    let dropped = 0;
    for (const raw of Array.isArray(list) ? list : []) {
      const segment = normalizeSegment(raw);
      if (!segment || !isSegmentAttached(segment, occupied)) { dropped += 1; continue; }
      const key = segmentKey(segment);
      if (seen.has(key)) continue; // duplicate / reversed duplicate
      seen.add(key);
      clean.push(segment);
    }
    clean.sort(compareSegments);
    if (clean.length > MAX_SEGMENTS_PER_KIND) {
      dropped += clean.length - MAX_SEGMENTS_PER_KIND;
      clean.length = MAX_SEGMENTS_PER_KIND;
    }
    return { segments: clean, dropped };
  }

  // Canonical blueprint wiring: `{ version, power, data }` with normalized,
  // deduplicated, deterministically ordered segments limited to edges beside
  // occupied ship cells. Also reports how many raw segments were dropped.
  function normalizeWiring(wiring, modules, catalogue) {
    const occupied = occupiedCellSet(modules, catalogue);
    const source = wiring && typeof wiring === "object" && !Array.isArray(wiring) ? wiring : {};
    const power = normalizeSegmentList(source.power, occupied);
    const data = normalizeSegmentList(source.data, occupied);
    return {
      wiring: { version: WIRING_VERSION, power: power.segments, data: data.segments },
      droppedSegments: power.dropped + data.dropped
    };
  }

  function emptyWiring() {
    return { version: WIRING_VERSION, power: [], data: [] };
  }

  function cloneWiring(wiring) {
    return {
      version: WIRING_VERSION,
      power: (wiring?.power || []).map((segment) => ({ ...segment })),
      data: (wiring?.data || []).map((segment) => ({ ...segment }))
    };
  }

  // Union-find over grid-point keys. Component ports are unioned together so
  // wires that reach different ports of one component belong to one network.
  function buildNetworks(modules, segments, catalogue, kind) {
    const parent = new Map();
    const find = (key) => {
      let root = key;
      while (parent.get(root) !== root) root = parent.get(root);
      let cursor = key;
      while (parent.get(cursor) !== cursor) { const next = parent.get(cursor); parent.set(cursor, root); cursor = next; }
      return root;
    };
    const ensure = (key) => { if (!parent.has(key)) parent.set(key, key); return key; };
    const union = (a, b) => { const ra = find(ensure(a)); const rb = find(ensure(b)); if (ra !== rb) parent.set(rb, ra); };

    const pointsInUse = new Set();
    for (const segment of segments) {
      const a = pointKey(segment.x1, segment.y1);
      const b = pointKey(segment.x2, segment.y2);
      pointsInUse.add(a); pointsInUse.add(b);
      union(a, b);
    }

    const portsByModule = (Array.isArray(modules) ? modules : []).map((module) => componentPorts(module, catalogue));
    portsByModule.forEach((ports) => {
      const used = ports.filter((point) => pointsInUse.has(pointKey(point.x, point.y)));
      for (let i = 1; i < used.length; i += 1) union(pointKey(used[0].x, used[0].y), pointKey(used[i].x, used[i].y));
    });

    const byRoot = new Map();
    for (const segment of segments) {
      const root = find(pointKey(segment.x1, segment.y1));
      if (!byRoot.has(root)) byRoot.set(root, { segments: [], points: new Map() });
      const bucket = byRoot.get(root);
      bucket.segments.push(segment);
      bucket.points.set(pointKey(segment.x1, segment.y1), { x: segment.x1, y: segment.y1 });
      bucket.points.set(pointKey(segment.x2, segment.y2), { x: segment.x2, y: segment.y2 });
    }

    const networks = [...byRoot.values()].map((bucket) => {
      const points = [...bucket.points.values()].sort(comparePoints);
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      for (const point of points) {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
      }
      const componentIndices = [];
      portsByModule.forEach((ports, index) => {
        if (ports.some((point) => bucket.points.has(pointKey(point.x, point.y)))) componentIndices.push(index);
      });
      return {
        kind,
        segments: bucket.segments.slice().sort(compareSegments),
        points,
        bounds: { minX, minY, maxX, maxY },
        componentIndices
      };
    });

    // Stable, deterministic ordering and naming: upper-left network first.
    networks.sort((a, b) => a.bounds.minY - b.bounds.minY || a.bounds.minX - b.bounds.minX || compareSegments(a.segments[0], b.segments[0]));
    networks.forEach((network, index) => {
      network.index = index;
      network.id = `${kind}-${index + 1}`;
      network.label = kind === "data" ? `Weapon Network ${dataNetworkLetter(index)}` : `Power Network ${index + 1}`;
    });
    return networks;
  }

  function dataNetworkLetter(index) {
    if (index < 26) return String.fromCharCode(65 + index);
    return String(index + 1);
  }

  // Full deterministic analysis of a blueprint's wiring. All connectivity,
  // membership, reachability and preview-bonus results are derived here from
  // the segments alone.
  function analyzeWiring(modules, wiring, catalogue) {
    const moduleList = Array.isArray(modules) ? modules : [];
    const { wiring: clean, droppedSegments } = normalizeWiring(wiring, moduleList, catalogue);
    const powerNetworks = buildNetworks(moduleList, clean.power, catalogue, "power");
    const dataNetworks = buildNetworks(moduleList, clean.data, catalogue, "data");

    const powerNetworkByComponent = new Map();
    const dataNetworkByComponent = new Map();
    for (const network of powerNetworks) for (const index of network.componentIndices) powerNetworkByComponent.set(index, network);
    for (const network of dataNetworks) for (const index of network.componentIndices) dataNetworkByComponent.set(index, network);

    const warnings = [];
    const moduleName = (index) => {
      const module = moduleList[index];
      const stat = partStat(catalogue, module.type);
      return `${stat.name || module.type} (${module.x},${module.y})`;
    };

    // ---- Power ----
    const powerSourceIndices = [];
    const powerConsumerIndices = [];
    moduleList.forEach((module, index) => {
      if (isPowerSourceType(module.type)) powerSourceIndices.push(index);
      else if (isPowerConsumer(module.type, catalogue)) powerConsumerIndices.push(index);
    });

    for (const network of powerNetworks) {
      network.sourceIndices = network.componentIndices.filter((index) => isPowerSourceType(moduleList[index].type));
      network.consumerIndices = network.componentIndices.filter((index) => isPowerConsumer(moduleList[index].type, catalogue));
      network.generation = network.sourceIndices.reduce((total, index) => total + (Number(partStat(catalogue, moduleList[index].type).powerGeneration) || 0), 0);
      network.demand = network.consumerIndices.reduce((total, index) => total + (Number(partStat(catalogue, moduleList[index].type).powerUse) || 0), 0);
      network.powered = network.sourceIndices.length > 0;
      if (!network.sourceIndices.length && !network.consumerIndices.length) {
        warnings.push({ code: "empty-power-network", message: `${network.label} connects no power sources or consumers.` });
      } else if (!network.sourceIndices.length) {
        warnings.push({ code: "unpowered-network", message: `${network.label} has no Power source.` });
      }
    }

    const connectedPowerConsumers = [];
    const disconnectedPowerConsumers = [];
    for (const index of powerConsumerIndices) {
      const network = powerNetworkByComponent.get(index);
      if (network && network.powered) connectedPowerConsumers.push(index);
      else {
        disconnectedPowerConsumers.push(index);
        warnings.push({ code: "unpowered-consumer", componentIndex: index, message: `${moduleName(index)} is not connected to a Power source.` });
      }
    }

    // ---- Data ----
    const dataSourceIndices = [];
    const weaponIndices = [];
    moduleList.forEach((module, index) => {
      if (isDataSourceType(module.type)) dataSourceIndices.push(index);
      if (isDataTarget(module.type, catalogue)) weaponIndices.push(index);
    });

    for (const network of dataNetworks) {
      network.sourceIndices = network.componentIndices.filter((index) => isDataSourceType(moduleList[index].type));
      network.weaponIndices = network.componentIndices.filter((index) => isDataTarget(moduleList[index].type, catalogue));
    }

    const supports = dataSourceIndices.map((index) => {
      const module = moduleList[index];
      const info = DATA_SOURCE_INFO[module.type];
      const network = dataNetworkByComponent.get(index) || null;
      const connectedWeapons = network ? network.weaponIndices.filter((weaponIndex) => isCompatibleWeapon(module.type, moduleList[weaponIndex].type, catalogue)) : [];
      const incompatibleWeapons = network ? network.weaponIndices.filter((weaponIndex) => !isCompatibleWeapon(module.type, moduleList[weaponIndex].type, catalogue)) : [];
      const bonusTotal = sourceBonusAmount(module.type, catalogue);
      const support = {
        index,
        type: module.type,
        networkId: network ? network.id : null,
        networkLabel: network ? network.label : null,
        bonusField: info.bonusField,
        effect: info.effect,
        unit: info.unit,
        bonusTotal,
        connectedWeaponIndices: connectedWeapons,
        incompatibleWeaponIndices: incompatibleWeapons,
        bonusPerWeapon: connectedWeapons.length ? bonusTotal / connectedWeapons.length : 0
      };
      if (!connectedWeapons.length) {
        warnings.push({ code: "support-without-weapon", componentIndex: index, message: `${moduleName(index)} has no connected compatible weapon.` });
      }
      for (const weaponIndex of incompatibleWeapons) {
        warnings.push({ code: "incompatible-weapon", componentIndex: weaponIndex, message: `${moduleName(index)} is wired to ${moduleName(weaponIndex)}, which is not compatible with its ${info.effect} bonus.` });
      }
      return support;
    });

    const weapons = weaponIndices.map((index) => {
      const network = dataNetworkByComponent.get(index) || null;
      return {
        index,
        type: moduleList[index].type,
        networkId: network ? network.id : null,
        networkLabel: network ? network.label : null,
        supportIndices: supports.filter((support) => support.connectedWeaponIndices.includes(index) || support.incompatibleWeaponIndices.includes(index)).map((support) => support.index)
      };
    });

    if (droppedSegments > 0) {
      warnings.push({ code: "invalid-segments", message: `${droppedSegments} invalid or floating wire segment${droppedSegments === 1 ? "" : "s"} removed.` });
    }

    return {
      version: WIRING_VERSION,
      wiring: clean,
      droppedSegments,
      power: {
        networks: powerNetworks,
        networkByComponent: powerNetworkByComponent,
        sourceIndices: powerSourceIndices,
        consumerIndices: powerConsumerIndices,
        connectedConsumerIndices: connectedPowerConsumers,
        disconnectedConsumerIndices: disconnectedPowerConsumers
      },
      data: {
        networks: dataNetworks,
        networkByComponent: dataNetworkByComponent,
        sourceIndices: dataSourceIndices,
        weaponIndices,
        supports,
        weapons
      },
      warnings
    };
  }

  function networkForComponent(analysis, kind, componentIndex) {
    const map = kind === "data" ? analysis.data.networkByComponent : analysis.power.networkByComponent;
    return map.get(componentIndex) || null;
  }

  function componentReachesPowerSource(analysis, componentIndex) {
    const network = analysis.power.networkByComponent.get(componentIndex);
    return Boolean(network && network.powered);
  }

  // Deterministic shortest valid route between two components. BFS over grid
  // points using only edges attached to the ship; fixed neighbour order and
  // sorted start points make hover previews and final placement identical.
  function findRoute(modules, fromIndex, toIndex, catalogue) {
    const moduleList = Array.isArray(modules) ? modules : [];
    const from = moduleList[fromIndex];
    const to = moduleList[toIndex];
    if (!from || !to || fromIndex === toIndex) return { ok: false, reason: "invalid-endpoints", segments: [] };
    const occupied = occupiedCellSet(moduleList, catalogue);
    const starts = componentPorts(from, catalogue);
    const goals = new Set(componentPorts(to, catalogue).map((point) => pointKey(point.x, point.y)));
    if (!starts.length || !goals.size) return { ok: false, reason: "no-ports", segments: [] };

    const startKeys = new Set(starts.map((point) => pointKey(point.x, point.y)));
    const NEIGHBOUR_ORDER = [[0, -1], [-1, 0], [1, 0], [0, 1]];

    // Adjacent components share a perimeter port; networks are still derived
    // purely from segments, so lay one deterministic unit edge at the first
    // shared port to join them.
    for (const start of starts) {
      if (!goals.has(pointKey(start.x, start.y))) continue;
      for (const [dx, dy] of NEIGHBOUR_ORDER) {
        const segment = normalizeSegment({ x1: start.x, y1: start.y, x2: start.x + dx, y2: start.y + dy });
        if (segment && isSegmentAttached(segment, occupied)) return { ok: true, segments: [segment] };
      }
      return { ok: false, reason: "unreachable", segments: [] };
    }

    const cameFrom = new Map();
    const queue = [];
    for (const start of starts) {
      const key = pointKey(start.x, start.y);
      cameFrom.set(key, null);
      queue.push(start);
    }
    let goalKey = null;
    for (let head = 0; head < queue.length && !goalKey; head += 1) {
      const point = queue[head];
      for (const [dx, dy] of NEIGHBOUR_ORDER) {
        const nx = point.x + dx;
        const ny = point.y + dy;
        if (nx < 0 || nx > POINT_MAX || ny < 0 || ny > POINT_MAX) continue;
        const key = pointKey(nx, ny);
        if (cameFrom.has(key)) continue;
        const segment = normalizeSegment({ x1: point.x, y1: point.y, x2: nx, y2: ny });
        if (!segment || !isSegmentAttached(segment, occupied)) continue;
        cameFrom.set(key, pointKey(point.x, point.y));
        if (goals.has(key)) { goalKey = key; break; }
        queue.push({ x: nx, y: ny });
      }
    }

    if (!goalKey) return { ok: false, reason: "unreachable", segments: [] };

    const segments = [];
    let cursor = goalKey;
    while (cursor && !startKeys.has(cursor)) {
      const previous = cameFrom.get(cursor);
      if (!previous) break;
      const [cx, cy] = cursor.split(",").map(Number);
      const [px, py] = previous.split(",").map(Number);
      segments.push(normalizeSegment({ x1: px, y1: py, x2: cx, y2: cy }));
      cursor = previous;
    }
    segments.reverse();
    return { ok: true, segments };
  }

  // Adds a route's segments to one network kind, returning normalized wiring.
  function addRoute(wiring, kind, segments, modules, catalogue) {
    const next = cloneWiring(wiring);
    if (NETWORK_KINDS.includes(kind)) next[kind] = next[kind].concat(segments.map((segment) => ({ ...segment })));
    return normalizeWiring(next, modules, catalogue).wiring;
  }

  // Removes exact segments (by canonical key) from one network kind.
  function removeSegments(wiring, kind, segments, modules, catalogue) {
    const next = cloneWiring(wiring);
    if (NETWORK_KINDS.includes(kind)) {
      const removals = new Set(segments.map((segment) => segmentKey(normalizeSegment(segment) || segment)));
      next[kind] = next[kind].filter((segment) => !removals.has(segmentKey(segment)));
    }
    return normalizeWiring(next, modules, catalogue).wiring;
  }

  // Compact per-network summary used by designer status panels and tests.
  function networkSummaries(analysis) {
    const power = analysis.power.networks.map((network) => ({
      id: network.id,
      label: network.label,
      kind: "power",
      segmentCount: network.segments.length,
      componentCount: network.componentIndices.length,
      sourceCount: network.sourceIndices.length,
      consumerCount: network.consumerIndices.length,
      generation: network.generation,
      demand: network.demand,
      powered: network.powered
    }));
    const data = analysis.data.networks.map((network) => ({
      id: network.id,
      label: network.label,
      kind: "data",
      segmentCount: network.segments.length,
      componentCount: network.componentIndices.length,
      sourceCount: network.sourceIndices.length,
      weaponCount: network.weaponIndices.length
    }));
    return { power, data };
  }

  return Object.freeze({
    GRID_SIZE,
    POINT_MAX,
    WIRING_VERSION,
    NETWORK_KINDS,
    MAX_SEGMENTS_PER_KIND,
    POWER_SOURCE_TYPES,
    DATA_SOURCE_TYPES,
    DATA_SOURCE_INFO,
    isPowerSourceType,
    isPowerConsumer,
    isDataSourceType,
    isDataTarget,
    isCompatibleWeapon,
    sourceBonusAmount,
    getOccupiedCells,
    occupiedCellSet,
    componentPorts,
    normalizeSegment,
    segmentKey,
    validateSegment,
    normalizeWiring,
    emptyWiring,
    cloneWiring,
    buildNetworks,
    analyzeWiring,
    networkForComponent,
    componentReachesPowerSource,
    findRoute,
    addRoute,
    removeSegments,
    networkSummaries
  });
}));
