(function initWiringRules(root, factory) {
  const rules = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = rules;
  root.WiringRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeWiringRules() {
  "use strict";

  const GRID_SIZE = 15;
  const POINT_MAX = GRID_SIZE - 1;
  const WIRING_VERSION = 2;
  const STANDARD_TIER = "standard";
  const ACCEPTED_TIERS = Object.freeze([STANDARD_TIER]);
  const MAX_SECTIONS_PER_KIND = 480;
  const MAX_CONNECTIONS_PER_KIND = 240;
  const MAX_SEGMENTS_PER_KIND = MAX_CONNECTIONS_PER_KIND;
  const MAX_PATH_CELLS = GRID_SIZE * GRID_SIZE;
  const NETWORK_KINDS = Object.freeze(["power", "data"]);
  const POWER_SOURCE_TYPES = Object.freeze(["core", "reactor", "auxGenerator"]);
  const DATA_SOURCE_INFO = Object.freeze({
    fireControl: Object.freeze({ bonusField: "fireRateBonus", effect: "fire rate", unit: "percent" }),
    sensorArray: Object.freeze({ bonusField: "rangeBonus", effect: "range", unit: "m" }),
    signalAmplifier: Object.freeze({ bonusField: "rangeBonus", effect: "range", unit: "m" }),
    targetingComputer: Object.freeze({ bonusField: "accuracyBonus", effect: "accuracy", unit: "percent" }),
    stabilizerNode: Object.freeze({ bonusField: "accuracyBonus", effect: "accuracy", unit: "percent" })
  });
  const DATA_SOURCE_TYPES = Object.freeze(Object.keys(DATA_SOURCE_INFO));

  function partStat(catalogue, type) { return (catalogue && (catalogue[type] || catalogue.frame)) || {}; }
  function isPowerSourceType(type) { return POWER_SOURCE_TYPES.includes(type); }
  function isPowerConsumer(type, catalogue) { return !isPowerSourceType(type) && (Number(partStat(catalogue, type).powerUse) || 0) > 0; }
  function isDataSourceType(type) { return Object.prototype.hasOwnProperty.call(DATA_SOURCE_INFO, type); }
  function isDataTarget(type, catalogue) { return Boolean(partStat(catalogue, type).weapon); }
  function isCompatibleWeapon(sourceType, weaponType, catalogue) { return isDataSourceType(sourceType) && isDataTarget(weaponType, catalogue); }
  function sourceBonusAmount(type, catalogue) { const info = DATA_SOURCE_INFO[type]; return info ? Number(partStat(catalogue, type)[info.bonusField]) || 0 : 0; }

  function getOccupiedCells(x, y, footprint, rotation = 0) {
    const cells = [];
    const width = footprint?.width || 1;
    const height = footprint?.height || 1;
    const r = (rotation % 360 + 360) % 360;
    for (let dy = 0; dy < height; dy += 1) for (let dx = 0; dx < width; dx += 1) {
      let ox = dx; let oy = dy;
      if (r === 90) { ox = -dy; oy = dx; }
      else if (r === 180) { ox = -dx; oy = -dy; }
      else if (r === 270) { ox = dy; oy = -dx; }
      cells.push({ x: x + ox, y: y + oy });
    }
    return cells;
  }
  function moduleCells(module, catalogue) { return getOccupiedCells(module.x, module.y, partStat(catalogue, module.type).footprint || { width: 1, height: 1 }, module.rotation || 0); }
  function cellKey(x, y) { return `${x},${y}`; }
  function componentPorts(module, catalogue) { return moduleCells(module, catalogue).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 })); }
  function componentCenter(module, catalogue) {
    const cells = moduleCells(module, catalogue);
    return { x: cells.reduce((n, p) => n + p.x + 0.5, 0) / cells.length, y: cells.reduce((n, p) => n + p.y + 0.5, 0) / cells.length };
  }
  function occupancy(modules, catalogue) {
    const map = new Map();
    (Array.isArray(modules) ? modules : []).forEach((module, index) => moduleCells(module, catalogue).forEach((cell) => map.set(cellKey(cell.x, cell.y), index)));
    return map;
  }
  function normalizeTier(tier) { return ACCEPTED_TIERS.includes(tier) ? tier : STANDARD_TIER; }
  function normalizedCell(raw, prefix = "") {
    const x = Number(raw?.[`x${prefix}`]); const y = Number(raw?.[`y${prefix}`]);
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE ? { x, y } : null;
  }
  function canonicalSectionCoordinates(a, b) {
    if (a.y < b.y || (a.y === b.y && a.x <= b.x)) return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    return { x1: b.x, y1: b.y, x2: a.x, y2: a.y };
  }
  function sectionIdFromCells(a, b) { const s = canonicalSectionCoordinates(a, b); return `${s.x1},${s.y1}:${s.x2},${s.y2}`; }
  function normalizeSection(raw, occupied) {
    const a = normalizedCell(raw, "1"); const b = normalizedCell(raw, "2");
    if (!a || !b || Math.abs(a.x - b.x) + Math.abs(a.y - b.y) !== 1) return null;
    if (!occupied.has(cellKey(a.x, a.y)) || !occupied.has(cellKey(b.x, b.y))) return null;
    const coords = canonicalSectionCoordinates(a, b);
    return { id: sectionIdFromCells(a, b), ...coords, tier: normalizeTier(raw?.tier) };
  }
  function sectionCells(section) { return [{ x: section.x1, y: section.y1 }, { x: section.x2, y: section.y2 }]; }
  function connectionKey(connection) { return `${connection.sourceIndex}>${connection.targetIndex}:${connection.sectionIds.join(";")}`; }
  function kindShape(kind) { return kind && typeof kind === "object" && !Array.isArray(kind) ? kind : {}; }

  function orderedConnectionCells(sectionIds, sectionMap, sourceCells) {
    if (!sectionIds.length) return null;
    const first = sectionMap.get(sectionIds[0]);
    if (!first) return null;
    const starts = sectionCells(first).filter((cell) => sourceCells.has(cellKey(cell.x, cell.y)));
    for (const start of starts) {
      const cells = [start]; let cursor = start; let valid = true;
      for (const id of sectionIds) {
        const section = sectionMap.get(id); if (!section) { valid = false; break; }
        const ends = sectionCells(section); let next = null;
        if (cellKey(ends[0].x, ends[0].y) === cellKey(cursor.x, cursor.y)) next = ends[1];
        else if (cellKey(ends[1].x, ends[1].y) === cellKey(cursor.x, cursor.y)) next = ends[0];
        if (!next || cells.some((cell) => cellKey(cell.x, cell.y) === cellKey(next.x, next.y))) { valid = false; break; }
        cells.push(next); cursor = next;
      }
      if (valid) return cells;
    }
    return null;
  }

  function normalizeKind(rawKind, modules, catalogue, kind, occupied) {
    const raw = kindShape(rawKind); const sectionMap = new Map(); let dropped = 0;
    for (const value of Array.isArray(raw.sections) ? raw.sections.slice(0, MAX_SECTIONS_PER_KIND) : []) {
      const section = normalizeSection(value, occupied);
      if (!section) { dropped += 1; continue; }
      if (!sectionMap.has(section.id)) sectionMap.set(section.id, section);
    }
    const connections = []; const connectionKeys = new Set();
    for (const value of Array.isArray(raw.connections) ? raw.connections.slice(0, MAX_CONNECTIONS_PER_KIND) : []) {
      const sourceIndex = Number(value?.sourceIndex); const targetIndex = Number(value?.targetIndex);
      if (!Number.isInteger(sourceIndex) || !Number.isInteger(targetIndex) || sourceIndex === targetIndex || !modules[sourceIndex] || !modules[targetIndex]) { dropped += 1; continue; }
      if (kind === "power" && (!isPowerSourceType(modules[sourceIndex].type) || !isPowerConsumer(modules[targetIndex].type, catalogue))) { dropped += 1; continue; }
      if (kind === "data" && (!isDataSourceType(modules[sourceIndex].type) || !isCompatibleWeapon(modules[sourceIndex].type, modules[targetIndex].type, catalogue))) { dropped += 1; continue; }
      const sectionIds = Array.isArray(value?.sectionIds) ? value.sectionIds.filter((id) => typeof id === "string").slice(0, MAX_PATH_CELLS - 1) : [];
      const sourceCells = new Set(moduleCells(modules[sourceIndex], catalogue).map((cell) => cellKey(cell.x, cell.y)));
      const orderedCells = orderedConnectionCells(sectionIds, sectionMap, sourceCells);
      const targetCells = new Set(moduleCells(modules[targetIndex], catalogue).map((cell) => cellKey(cell.x, cell.y)));
      if (!orderedCells || !targetCells.has(cellKey(orderedCells.at(-1).x, orderedCells.at(-1).y))) { dropped += 1; continue; }
      const connection = { sourceIndex, targetIndex, sectionIds };
      const key = connectionKey(connection); if (connectionKeys.has(key)) continue;
      connectionKeys.add(key); connections.push(connection);
    }
    const used = new Set(connections.flatMap((connection) => connection.sectionIds));
    return { value: { sections: [...sectionMap.values()].filter((section) => used.has(section.id)), connections }, dropped };
  }

  function normalizeWiring(wiring, modules, catalogue) {
    const list = Array.isArray(modules) ? modules : [];
    const source = wiring && wiring.version === WIRING_VERSION ? wiring : {};
    const occupiedMap = occupancy(list, catalogue); const occupied = new Set(occupiedMap.keys());
    const power = normalizeKind(source.power, list, catalogue, "power", occupied);
    const data = normalizeKind(source.data, list, catalogue, "data", occupied);
    return { wiring: { version: WIRING_VERSION, power: power.value, data: data.value }, droppedRoutes: power.dropped + data.dropped, droppedSegments: power.dropped + data.dropped };
  }
  function emptyKind() { return { sections: [], connections: [] }; }
  function emptyWiring() { return { version: WIRING_VERSION, power: emptyKind(), data: emptyKind() }; }
  function cloneKind(kind) { return { sections: (kind?.sections || []).map((section) => ({ ...section })), connections: (kind?.connections || []).map((connection) => ({ ...connection, sectionIds: [...connection.sectionIds] })) }; }
  function cloneWiring(wiring) { return { version: WIRING_VERSION, power: cloneKind(wiring?.power), data: cloneKind(wiring?.data) }; }
  function sectionLine(section) { return { x1: section.x1 + 0.5, y1: section.y1 + 0.5, x2: section.x2 + 0.5, y2: section.y2 + 0.5 }; }
  function segmentKey(section) { return section.id || sectionIdFromCells({ x: section.x1, y: section.y1 }, { x: section.x2, y: section.y2 }); }

  function buildNetworks(modules, kindValue, catalogue, kind) {
    // Canonical connection order makes derived IDs stable without persisting
    // them in Wiring v2.
    const connections = kindValue.connections.slice().sort((a, b) => connectionKey(a).localeCompare(connectionKey(b), undefined, { numeric: true })); const parent = connections.map((_, index) => index);
    const find = (index) => parent[index] === index ? index : (parent[index] = find(parent[index]));
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
    const sectionMap = new Map(kindValue.sections.map((section) => [section.id, section]));
    const owner = new Map(); const cellOwner = new Map(); const sourceOwner = new Map(); const targetOwner = new Map();
    connections.forEach((connection, index) => {
      connection.sectionIds.forEach((id) => {
        if (owner.has(id)) union(index, owner.get(id)); else owner.set(id, index);
        // Physical branches and section endpoints meeting at one cell are a
        // single conductor. Merely crossing the same component footprint is
        // insufficient because only actual section cells participate.
        for (const cell of sectionCells(sectionMap.get(id))) {
          const key = cellKey(cell.x, cell.y);
          if (cellOwner.has(key)) union(index, cellOwner.get(key)); else cellOwner.set(key, index);
        }
      });
      if (kind === "data") {
        if (sourceOwner.has(connection.sourceIndex)) union(index, sourceOwner.get(connection.sourceIndex)); else sourceOwner.set(connection.sourceIndex, index);
        if (targetOwner.has(connection.targetIndex)) union(index, targetOwner.get(connection.targetIndex)); else targetOwner.set(connection.targetIndex, index);
      }
    });
    const groups = new Map(); connections.forEach((connection, index) => { const root = find(index); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(connection); });
    const networks = [...groups.values()].map((group, index) => {
      const sectionIds = [...new Set(group.flatMap((connection) => connection.sectionIds))];
      const componentIndices = [...new Set(group.flatMap((connection) => [connection.sourceIndex, connection.targetIndex]))];
      const network = { kind, index, id: `${kind}-${index + 1}`, label: kind === "data" ? `Weapon Network ${String.fromCharCode(65 + index)}` : `Power Network ${index + 1}`, connections: group, routes: group, sectionIds, sections: sectionIds.map((id) => sectionMap.get(id)), segments: sectionIds.map((id) => sectionLine(sectionMap.get(id))), componentIndices };
      network.sourceIndices = componentIndices.filter((i) => kind === "power" ? isPowerSourceType(modules[i].type) : isDataSourceType(modules[i].type));
      network.consumerIndices = kind === "power" ? componentIndices.filter((i) => isPowerConsumer(modules[i].type, catalogue)) : [];
      network.weaponIndices = kind === "data" ? componentIndices.filter((i) => isDataTarget(modules[i].type, catalogue)) : [];
      if (kind === "power") {
        network.generation = network.sourceIndices.reduce((value, i) => value + (Number(partStat(catalogue, modules[i].type).powerGeneration) || 0), 0);
        network.demand = network.consumerIndices.reduce((value, i) => value + (Number(partStat(catalogue, modules[i].type).powerUse) || 0), 0);
        network.powered = network.sourceIndices.length > 0;
      }
      return network;
    });
    return networks;
  }

  // Power is derived, never persisted.  Logical endpoints determine functional
  // membership; route cells only determine electrical continuity.
  function analyzePowerNetworks(design, wiring, componentCatalog) {
    const modules = Array.isArray(design) ? design : [];
    const rawConnections = Array.isArray(wiring?.power?.connections) ? wiring.power.connections.slice(0, MAX_CONNECTIONS_PER_KIND) : [];
    const normalized = normalizeWiring(wiring, modules, componentCatalog);
    const power = normalized.wiring.power;
    const sectionMap = new Map(power.sections.map((section) => [section.id, section]));
    const validKeys = new Set(power.connections.map(connectionKey));
    const invalidConnections = rawConnections.filter((connection) => {
      const ids = Array.isArray(connection?.sectionIds) ? connection.sectionIds.filter((id) => typeof id === "string").slice(0, MAX_PATH_CELLS - 1) : [];
      return !validKeys.has(connectionKey({ sourceIndex: Number(connection?.sourceIndex), targetIndex: Number(connection?.targetIndex), sectionIds: ids }));
    }).map((connection, index) => ({
      id: `invalid-power-${index + 1}`,
      sourceIndex: Number.isInteger(Number(connection?.sourceIndex)) ? Number(connection.sourceIndex) : null,
      targetIndex: Number.isInteger(Number(connection?.targetIndex)) ? Number(connection.targetIndex) : null,
      reason: "invalid-or-incomplete"
    }));

    const connections = power.connections.map((connection) => ({ ...connection, id: connectionKey(connection), sectionIds: [...connection.sectionIds] }));
    const parent = connections.map((_, index) => index);
    const find = (index) => parent[index] === index ? index : (parent[index] = find(parent[index]));
    const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };
    const cellOwner = new Map(); const terminalOwner = new Map();
    connections.forEach((connection, index) => {
      for (const sectionId of connection.sectionIds) for (const cell of sectionCells(sectionMap.get(sectionId))) {
        const key = cellKey(cell.x, cell.y); if (cellOwner.has(key)) union(index, cellOwner.get(key)); else cellOwner.set(key, index);
      }
      for (const terminal of [`s:${connection.sourceIndex}`, `c:${connection.targetIndex}`]) {
        if (terminalOwner.has(terminal)) union(index, terminalOwner.get(terminal)); else terminalOwner.set(terminal, index);
      }
    });
    const groups = new Map();
    connections.forEach((connection, index) => { const root = find(index); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(connection); });
    const canonicalPosition = (group) => {
      const ids = [...new Set(group.flatMap((connection) => connection.sectionIds))].sort();
      const cells = ids.flatMap((id) => sectionCells(sectionMap.get(id)));
      cells.sort((a, b) => a.y - b.y || a.x - b.x);
      return { y: cells[0]?.y ?? POINT_MAX + 1, x: cells[0]?.x ?? POINT_MAX + 1, ids };
    };
    const grouped = [...groups.values()].map((group) => ({ group, position: canonicalPosition(group) }));
    grouped.sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x
      || Math.min(...a.group.flatMap((c) => [c.sourceIndex, c.targetIndex])) - Math.min(...b.group.flatMap((c) => [c.sourceIndex, c.targetIndex]))
      || a.position.ids.join(";").localeCompare(b.position.ids.join(";")));
    const networks = grouped.map(({ group, position }, index) => {
      const sourceIndices = [...new Set(group.map((connection) => connection.sourceIndex))].sort((a, b) => a - b);
      const consumerIndices = [...new Set(group.map((connection) => connection.targetIndex))].sort((a, b) => a - b);
      const sectionIds = position.ids;
      const generationMw = sourceIndices.reduce((sum, i) => sum + (Number(partStat(componentCatalog, modules[i].type).powerGeneration) || 0), 0);
      const demandMw = consumerIndices.reduce((sum, i) => sum + (Number(partStat(componentCatalog, modules[i].type).powerUse) || 0), 0);
      const surplusMw = generationMw - demandMw;
      const availableEfficiency = demandMw <= 0 ? 1 : Math.max(0, Math.min(1, generationMw / demandMw));
      const status = consumerIndices.length ? (generationMw <= 0 ? "unpowered" : generationMw < demandMw ? "underpowered" : "online") : sourceIndices.length ? "idle" : "empty";
      return {
        id: `power-${position.y}-${position.x}-${sectionIds[0] || "terminal"}`,
        label: `Power Network ${String.fromCharCode(65 + index)}`,
        status, sourceIndices, consumerIndices,
        componentIndices: [...new Set([...sourceIndices, ...consumerIndices])].sort((a, b) => a - b),
        connectionIds: group.map((connection) => connection.id).sort(), connections: group,
        sectionIds, sections: sectionIds.map((id) => ({ ...sectionMap.get(id) })),
        generationMw, demandMw, surplusMw, deficitMw: Math.max(0, -surplusMw),
        generation: generationMw, demand: demandMw,
        loadRatio: generationMw > 0 ? demandMw / generationMw : demandMw > 0 ? null : 0,
        availableEfficiency, powered: generationMw > 0
      };
    });
    const consumerIndices = []; const sourceIndices = [];
    modules.forEach((module, index) => { if (isPowerSourceType(module.type)) sourceIndices.push(index); if (isPowerConsumer(module.type, componentCatalog)) consumerIndices.push(index); });
    const networkByComponent = new Map(); networks.forEach((network) => network.componentIndices.forEach((index) => networkByComponent.set(index, network)));
    const rawTargets = new Set(rawConnections.map((connection) => Number(connection?.targetIndex)).filter(Number.isInteger));
    const invalidTargets = new Set(invalidConnections.map((connection) => connection.targetIndex).filter(Number.isInteger));
    const disconnectedConsumers = consumerIndices.filter((index) => !networkByComponent.get(index)?.sourceIndices.length);
    const disconnectedConsumerDetails = disconnectedConsumers.map((index) => ({ index, reason: invalidTargets.has(index) ? "invalid-or-incomplete-connection" : rawTargets.has(index) ? "network-has-no-source" : "no-completed-connection" }));
    const underpoweredConsumerIndices = [...new Set(networks.filter((network) => network.status === "underpowered").flatMap((network) => network.consumerIndices))].sort((a, b) => a - b);
    const usedSources = new Set(networks.filter((network) => network.consumerIndices.length).flatMap((network) => network.sourceIndices));
    const unusedSourceIndices = sourceIndices.filter((index) => !usedSources.has(index));
    const totalGenerationMw = networks.reduce((sum, network) => sum + network.generationMw, 0);
    const totalDemandMw = networks.reduce((sum, network) => sum + network.demandMw, 0);
    return {
      version: WIRING_VERSION, networkCount: networks.length,
      onlineNetworkCount: networks.filter((n) => n.status === "online").length,
      underpoweredNetworkCount: networks.filter((n) => n.status === "underpowered").length,
      unpoweredNetworkCount: networks.filter((n) => n.status === "unpowered").length,
      totalConnectedGenerationMw: totalGenerationMw, totalConnectedDemandMw: totalDemandMw,
      totalSurplusMw: totalGenerationMw - totalDemandMw,
      sourceIndices, consumerIndices, connectedConsumerIndices: consumerIndices.filter((i) => !disconnectedConsumers.includes(i)),
      disconnectedConsumerIndices: disconnectedConsumers, disconnectedConsumerDetails, underpoweredConsumerIndices,
      unusedSourceIndices, invalidConnectionCount: invalidConnections.length, invalidConnections, networks, networkByComponent
    };
  }

  function analyzeWiring(modules, wiring, catalogue) {
    const list = Array.isArray(modules) ? modules : []; const normalized = normalizeWiring(wiring, list, catalogue); const clean = normalized.wiring;
    const powerAnalysis = analyzePowerNetworks(list, wiring, catalogue); const powerNetworks = powerAnalysis.networks; const dataNetworks = buildNetworks(list, clean.data, catalogue, "data");
    const powerMap = new Map(); const dataMap = new Map();
    powerNetworks.forEach((network) => network.componentIndices.forEach((index) => powerMap.set(index, network)));
    dataNetworks.forEach((network) => network.componentIndices.forEach((index) => dataMap.set(index, network)));
    const powerSources = []; const consumers = []; const dataSources = []; const weapons = [];
    list.forEach((module, index) => { if (isPowerSourceType(module.type)) powerSources.push(index); else if (isPowerConsumer(module.type, catalogue)) consumers.push(index); if (isDataSourceType(module.type)) dataSources.push(index); if (isDataTarget(module.type, catalogue)) weapons.push(index); });
    const connected = consumers.filter((index) => powerMap.get(index)?.powered); const disconnected = consumers.filter((index) => !powerMap.get(index)?.powered); const warnings = [];
    const supports = dataSources.map((index) => {
      const module = list[index]; const info = DATA_SOURCE_INFO[module.type]; const network = dataMap.get(index) || null;
      const targets = [...new Set(clean.data.connections.filter((connection) => connection.sourceIndex === index).map((connection) => connection.targetIndex))]; const bonusTotal = sourceBonusAmount(module.type, catalogue);
      return { index, type: module.type, networkId: network?.id || null, networkLabel: network?.label || null, bonusField: info.bonusField, effect: info.effect, unit: info.unit, bonusTotal, connectedWeaponIndices: targets, incompatibleWeaponIndices: [], bonusPerWeapon: targets.length ? bonusTotal / targets.length : 0 };
    });
    const weaponInfo = weapons.map((index) => { const network = dataMap.get(index) || null; return { index, type: list[index].type, networkId: network?.id || null, networkLabel: network?.label || null, supportIndices: supports.filter((support) => support.connectedWeaponIndices.includes(index)).map((support) => support.index) }; });
    return { version: WIRING_VERSION, wiring: clean, droppedRoutes: normalized.droppedRoutes, droppedSegments: normalized.droppedSegments, power: powerAnalysis, data: { networks: dataNetworks, networkByComponent: dataMap, sourceIndices: dataSources, weaponIndices: weapons, supports, weapons: weaponInfo }, warnings };
  }
  function networkSummaries(analysis) { return { power: analysis.power.networks.map((network) => ({ ...network, sourceCount: network.sourceIndices.length, consumerCount: network.consumerIndices.length })), data: analysis.data.networks }; }
  function networkForComponent(analysis, kind, index) { return (kind === "data" ? analysis.data.networkByComponent : analysis.power.networkByComponent).get(index) || null; }
  function networkForSection(analysis, kind, id) { return (kind === "data" ? analysis.data.networks : analysis.power.networks).find((network) => network.sectionIds.includes(id)) || null; }
  function componentReachesPowerSource(analysis, index) { return Boolean(analysis.power.networkByComponent.get(index)?.powered); }
  function connectionCells(connection, kindValue, modules, catalogue) { const map = new Map(kindValue.sections.map((section) => [section.id, section])); const starts = new Set(moduleCells(modules[connection.sourceIndex], catalogue).map((cell) => cellKey(cell.x, cell.y))); return orderedConnectionCells(connection.sectionIds, map, starts) || []; }
  function addConnection(wiring, kind, sourceIndex, targetIndex, cells, modules, catalogue) {
    const next = cloneWiring(wiring); const bucket = next[kind]; const sectionIds = [];
    for (let i = 1; i < cells.length; i += 1) {
      const id = sectionIdFromCells(cells[i - 1], cells[i]); sectionIds.push(id);
      if (!bucket.sections.some((section) => section.id === id)) bucket.sections.push({ id, ...canonicalSectionCoordinates(cells[i - 1], cells[i]), tier: STANDARD_TIER });
    }
    bucket.connections.push({ sourceIndex, targetIndex, sectionIds }); return normalizeWiring(next, modules, catalogue).wiring;
  }
  function removeConnection(wiring, kind, key, modules, catalogue) { const next = cloneWiring(wiring); next[kind].connections = next[kind].connections.filter((connection) => connectionKey(connection) !== key); return normalizeWiring(next, modules, catalogue).wiring; }
  function removeNetwork(wiring, kind, network, modules, catalogue) { const keys = new Set(network.connections.map(connectionKey)); const next = cloneWiring(wiring); next[kind].connections = next[kind].connections.filter((connection) => !keys.has(connectionKey(connection))); return normalizeWiring(next, modules, catalogue).wiring; }

  return { GRID_SIZE, POINT_MAX, WIRING_VERSION, STANDARD_TIER, ACCEPTED_TIERS, MAX_SECTIONS_PER_KIND, MAX_CONNECTIONS_PER_KIND, MAX_SEGMENTS_PER_KIND, MAX_PATH_CELLS, NETWORK_KINDS, POWER_SOURCE_TYPES, DATA_SOURCE_INFO, DATA_SOURCE_TYPES, getOccupiedCells, moduleCells, componentPorts, componentCenter, cellKey, sectionIdFromCells, normalizeTier, normalizeSection, sectionCells, sectionLine, segmentKey, connectionKey, connectionCells, normalizeWiring, emptyWiring, cloneWiring, analyzePowerNetworks, analyzeWiring, networkSummaries, networkForComponent, networkForSection, componentReachesPowerSource, isPowerSourceType, isPowerConsumer, isDataSourceType, isDataTarget, isCompatibleWeapon, sourceBonusAmount, addConnection, removeConnection, removeNetwork };
}));
