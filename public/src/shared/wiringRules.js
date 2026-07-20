(function initWiringRules(root, factory) {
  const onNode = typeof module !== "undefined" && module.exports;
  const dependency = onNode ? require("./dataSupportRules") : root.DataSupportRules;
  const powerPolicy = onNode ? require("./powerPolicyRules") : root.PowerPolicyRules;
  const rules = factory(dependency, powerPolicy);
  if (onNode) module.exports = rules;
  root.WiringRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeWiringRules(DataSupportRules, PowerPolicyRules) {
  "use strict";

  const GRID_SIZE = 15;
  const POINT_MAX = GRID_SIZE - 1;
  // Wiring v3: canonical physical Power/Data sections, explicit Power cable
  // tiers, single-tier Data, and a Blueprint Power policy. Existing Wiring v2
  // saves are migrated up (never emptied) before validation.
  const WIRING_VERSION = 3;
  const STANDARD_TIER = "standard";
  // Power supports three tiers; Data remains functionally single-tier and always
  // normalises to the standard tier internally.
  const POWER_TIERS = Object.freeze(["light", "standard", "heavy"]);
  const POWER_TIER_PRECEDENCE = Object.freeze({ light: 1, standard: 2, heavy: 3 });
  const ACCEPTED_TIERS = POWER_TIERS;
  const MAX_SECTIONS_PER_KIND = 480;
  const MAX_CONNECTIONS_PER_KIND = 240;
  const MAX_SEGMENTS_PER_KIND = MAX_CONNECTIONS_PER_KIND;
  const MAX_PATH_CELLS = GRID_SIZE * GRID_SIZE;
  const NETWORK_KINDS = Object.freeze(["power", "data"]);
  // Null means unlimited.  Balance can opt in without teaching the editor a
  // second, hidden limit.
  const DEFAULT_CABLE_LIMITS = Object.freeze({ power: null, data: null });
  const POWER_SOURCE_TYPES = Object.freeze(["core", "reactor", "auxGenerator"]);
  if (!DataSupportRules) throw new Error("DataSupportRules must load before WiringRules");
  if (!PowerPolicyRules) throw new Error("PowerPolicyRules must load before WiringRules");
  const { DATA_SOURCE_INFO, DATA_SOURCE_TYPES } = DataSupportRules;

  // Highest installed Power tier wins when several sections meet at one cell.
  function higherPowerTier(a, b) {
    return (POWER_TIER_PRECEDENCE[b] || 0) > (POWER_TIER_PRECEDENCE[a] || 0) ? b : a;
  }

  function partStat(catalogue, type) { return (catalogue && (catalogue[type] || catalogue.frame)) || {}; }
  function isPowerSourceType(type) { return POWER_SOURCE_TYPES.includes(type); }
  function isPowerConsumer(type, catalogue) { return !isPowerSourceType(type) && (Number(partStat(catalogue, type).powerUse) || 0) > 0; }
  function isDataSourceType(type) { return DataSupportRules.isDataSupportSource(type); }
  function isDataTarget(type, catalogue) { return Boolean(partStat(catalogue, type).weapon); }
  function isCompatibleWeapon(sourceType, weaponType, catalogue) { return isDataSourceType(sourceType) && isDataTarget(weaponType, catalogue); }
  function sourceBonusAmount(type, catalogue) { return DataSupportRules.nominalSupportBudget(type, catalogue); }

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
  // Power accepts light/standard/heavy; anything else (and all Data) normalises
  // deterministically to standard so a malformed tier can never break a route.
  function normalizeTier(tier, kind = "power") { return kind === "power" && POWER_TIERS.includes(tier) ? tier : STANDARD_TIER; }
  function normalizedCell(raw, prefix = "") {
    const x = Number(raw?.[`x${prefix}`]); const y = Number(raw?.[`y${prefix}`]);
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE ? { x, y } : null;
  }
  function canonicalSectionCoordinates(a, b) {
    if (a.y < b.y || (a.y === b.y && a.x <= b.x)) return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    return { x1: b.x, y1: b.y, x2: a.x, y2: a.y };
  }
  function sectionIdFromCells(a, b) { const s = canonicalSectionCoordinates(a, b); return `${s.x1},${s.y1}:${s.x2},${s.y2}`; }
  function normalizeSection(raw, occupied, kind = "power") {
    const a = normalizedCell(raw, "1"); const b = normalizedCell(raw, "2");
    if (!a || !b || Math.abs(a.x - b.x) + Math.abs(a.y - b.y) !== 1) return null;
    if (!occupied.has(cellKey(a.x, a.y)) || !occupied.has(cellKey(b.x, b.y))) return null;
    const coords = canonicalSectionCoordinates(a, b);
    return { id: sectionIdFromCells(a, b), ...coords, tier: normalizeTier(raw?.tier, kind) };
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
      const section = normalizeSection(value, occupied, kind);
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
    // Sections are the Wiring v2 authority.  Connections are retained only as
    // migration metadata for old saves; an unreferenced section is still a
    // perfectly valid branch of a physical network.
    return { value: { sections: [...sectionMap.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })), connections }, dropped };
  }

  // Upgrades any older/malformed wiring shape to the current Wiring v3 schema
  // WITHOUT losing routes. Every Wiring v2 Power section becomes an explicit
  // tier (v2 only stored standard, so it stays standard); Data stays single
  // tier; a missing Power policy becomes the default Balanced policy. Sections
  // and connections are carried forward verbatim (re-validated later against the
  // live modules by normalizeKind). The function is idempotent.
  function migrateWiringToCurrentVersion(wiring) {
    const source = wiring && typeof wiring === "object" && !Array.isArray(wiring) ? wiring : {};
    const migrateKind = (rawKind, kind) => {
      const raw = kindShape(rawKind);
      return {
        sections: (Array.isArray(raw.sections) ? raw.sections : []).map((section) => (
          section && typeof section === "object" ? { ...section, tier: normalizeTier(section.tier, kind) } : section
        )),
        connections: (Array.isArray(raw.connections) ? raw.connections : []).map((connection) => (
          connection && typeof connection === "object"
            ? { ...connection, sectionIds: Array.isArray(connection.sectionIds) ? [...connection.sectionIds] : [] }
            : connection
        ))
      };
    };
    return {
      version: WIRING_VERSION,
      power: migrateKind(source.power, "power"),
      data: migrateKind(source.data, "data"),
      powerPolicy: PowerPolicyRules.normalizePolicy(source.powerPolicy)
    };
  }

  function normalizeWiring(wiring, modules, catalogue) {
    const list = Array.isArray(modules) ? modules : [];
    // Migrate first, then validate against the current version — never empty a
    // save just because it predates Wiring v3.
    const source = migrateWiringToCurrentVersion(wiring);
    const occupiedMap = occupancy(list, catalogue); const occupied = new Set(occupiedMap.keys());
    const power = normalizeKind(source.power, list, catalogue, "power", occupied);
    const data = normalizeKind(source.data, list, catalogue, "data", occupied);
    return { wiring: { version: WIRING_VERSION, power: power.value, data: data.value, powerPolicy: source.powerPolicy }, droppedRoutes: power.dropped + data.dropped, droppedSegments: power.dropped + data.dropped };
  }
  function emptyKind() { return { sections: [], connections: [] }; }
  function emptyWiring() { return { version: WIRING_VERSION, power: emptyKind(), data: emptyKind(), powerPolicy: PowerPolicyRules.defaultPolicy() }; }
  function cloneKind(kind) { return { sections: (kind?.sections || []).map((section) => ({ ...section })), connections: (kind?.connections || []).map((connection) => ({ ...connection, sectionIds: [...connection.sectionIds] })) }; }
  function cloneWiring(wiring) { return { version: WIRING_VERSION, power: cloneKind(wiring?.power), data: cloneKind(wiring?.data), powerPolicy: PowerPolicyRules.clonePolicy(wiring?.powerPolicy) }; }
  function sectionLine(section) { return { x1: section.x1 + 0.5, y1: section.y1 + 0.5, x2: section.x2 + 0.5, y2: section.y2 + 0.5 }; }
  function segmentKey(section) { return section.id || sectionIdFromCells({ x: section.x1, y: section.y1 }, { x: section.x2, y: section.y2 }); }

  function countUniqueSections(wiring, kind) { return new Set((wiring?.[kind]?.sections || []).map(segmentKey)).size; }
  function remainingCableLength(wiring, kind, limit) { return Number.isFinite(limit) ? Math.max(0, limit - countUniqueSections(wiring, kind)) : Infinity; }
  function additionalLengthForPath(wiring, kind, cells) {
    const existing = new Set((wiring?.[kind]?.sections || []).map(segmentKey)); let added = 0;
    for (let i = 1; i < (cells || []).length; i += 1) { const id = sectionIdFromCells(cells[i - 1], cells[i]); if (!existing.has(id)) { existing.add(id); added += 1; } }
    return added;
  }

  function buildSectionGraph(kindValue) {
    const sections = (kindValue?.sections || []).map((section) => ({ ...section, id: segmentKey(section) }))
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    const nodes = new Map();
    for (const section of sections) for (const cell of sectionCells(section)) {
      const key = cellKey(cell.x, cell.y);
      if (!nodes.has(key)) nodes.set(key, { key, x: cell.x, y: cell.y, sectionIds: [] });
      nodes.get(key).sectionIds.push(section.id);
    }
    nodes.forEach((node) => node.sectionIds.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
    return { sections, sectionById: new Map(sections.map((section) => [section.id, section])), nodes };
  }
  function sectionEndpointDegrees(kindValue) {
    const graph = buildSectionGraph(kindValue); const result = new Map();
    graph.sections.forEach((section) => result.set(section.id, sectionCells(section).map((cell) => graph.nodes.get(cellKey(cell.x, cell.y))?.sectionIds.length || 0)));
    return result;
  }
  function junctionCells(kindValue) {
    return [...buildSectionGraph(kindValue).nodes.values()].filter((node) => node.sectionIds.length > 2)
      .map(({ x, y, sectionIds }) => ({ x, y, degree: sectionIds.length, sectionIds: [...sectionIds] }));
  }
  // Returns the selected edge plus the leaf-side chain.  An endpoint is valid
  // only when walking away from the selected edge reaches a leaf before a
  // junction or loop.  Ambiguity is deliberately reported rather than guessed.
  function findLeafBranchSections(kindValue, selectedSectionId, preferredEndpoint) {
    const graph = buildSectionGraph(kindValue); const selected = graph.sectionById.get(selectedSectionId);
    if (!selected) return { sectionIds: [], reason: "missing-section", choices: [] };
    const candidates = [];
    for (const endpoint of sectionCells(selected)) {
      const ids = [selected.id]; let node = graph.nodes.get(cellKey(endpoint.x, endpoint.y)); let previous = selected.id; const visited = new Set([selected.id]);
      while (node && node.sectionIds.length === 2) {
        const nextId = node.sectionIds.find((id) => id !== previous); if (!nextId || visited.has(nextId)) { node = null; break; }
        ids.push(nextId); visited.add(nextId); const next = graph.sectionById.get(nextId);
        const other = sectionCells(next).find((cell) => cellKey(cell.x, cell.y) !== node.key);
        previous = nextId; node = graph.nodes.get(cellKey(other.x, other.y));
      }
      if (node?.sectionIds.length === 1) candidates.push({ endpoint: { ...endpoint }, sectionIds: ids });
    }
    const wanted = preferredEndpoint && candidates.find((item) => item.endpoint.x === preferredEndpoint.x && item.endpoint.y === preferredEndpoint.y);
    if (wanted) return { ...wanted, reason: "leaf-branch", choices: candidates };
    if (candidates.length === 1) return { ...candidates[0], reason: "leaf-branch", choices: candidates };
    return { sectionIds: [selected.id], reason: candidates.length ? "ambiguous" : "not-leaf-branch", choices: candidates };
  }

  // Connected components are derived solely from canonical sections meeting
  // at canonical cell endpoints.  Merely occupying adjacent cells is not a
  // connection; a component joins when one of its cells is an endpoint.
  function physicalGroups(modules, kindValue, catalogue, kind) {
    const sections = (kindValue?.sections || []).slice().sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    const byCell = new Map(); sections.forEach((section, i) => sectionCells(section).forEach((cell) => { const key = cellKey(cell.x, cell.y); if (!byCell.has(key)) byCell.set(key, []); byCell.get(key).push(i); }));
    const parent = sections.map((_, i) => i); const find = (i) => parent[i] === i ? i : (parent[i] = find(parent[i]));
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
    byCell.forEach((indices) => indices.slice(1).forEach((i) => union(indices[0], i)));
    const groups = new Map(); sections.forEach((section, i) => { const root = find(i); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(section); });
    const occupied = occupancy(modules, catalogue);
    return [...groups.values()].map((group) => {
      const touched = new Set(); group.forEach((section) => sectionCells(section).forEach((cell) => { const index = occupied.get(cellKey(cell.x, cell.y)); if (index !== undefined) touched.add(index); }));
      const sectionIds = group.map((s) => s.id).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const sourceIndices = [...touched].filter((i) => kind === "power" ? isPowerSourceType(modules[i].type) : isDataSourceType(modules[i].type)).sort((a, b) => a - b);
      const consumerIndices = kind === "power" ? [...touched].filter((i) => isPowerConsumer(modules[i].type, catalogue)).sort((a, b) => a - b) : [];
      const weaponIndices = kind === "data" ? [...touched].filter((i) => isDataTarget(modules[i].type, catalogue)).sort((a, b) => a - b) : [];
      const componentIndices = [...new Set([...sourceIndices, ...consumerIndices, ...weaponIndices])].sort((a, b) => a - b);
      const hostIndices = [...touched].sort((a, b) => a - b); const first = sectionIds[0];
      return { kind, id: `${kind}-${first}`, sectionIds, sections: group, segments: group.map(sectionLine), sourceIndices, consumerIndices, weaponIndices, componentIndices, hostIndices, connections: [], routes: [] };
    }).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  }

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

  function analyzePhysicalPower(design, wiring, catalogue) {
    const modules = Array.isArray(design) ? design : []; const normalized = normalizeWiring(wiring, modules, catalogue); const all = physicalGroups(modules, normalized.wiring.power, catalogue, "power");
    const networks = all.map((network, index) => {
      const generationMw = network.sourceIndices.reduce((sum, i) => sum + (Number(partStat(catalogue, modules[i].type).powerGeneration) || 0), 0);
      const demandMw = network.consumerIndices.reduce((sum, i) => sum + (Number(partStat(catalogue, modules[i].type).powerUse) || 0), 0); const surplusMw = generationMw - demandMw;
      const status = network.consumerIndices.length ? generationMw <= 0 ? "unpowered" : generationMw < demandMw ? "underpowered" : "online" : network.sourceIndices.length ? "idle" : "empty";
      return { ...network, label: `Power Network ${String.fromCharCode(65 + index)}`, status, generationMw, demandMw, surplusMw, deficitMw: Math.max(0, -surplusMw), generation: generationMw, demand: demandMw, loadRatio: generationMw > 0 ? demandMw / generationMw : demandMw ? null : 0, availableEfficiency: demandMw ? Math.max(0, Math.min(1, generationMw / demandMw)) : 1, powered: generationMw > 0 };
    });
    const sourceIndices = [], consumerIndices = []; modules.forEach((m, i) => { if (isPowerSourceType(m.type)) sourceIndices.push(i); if (isPowerConsumer(m.type, catalogue)) consumerIndices.push(i); });
    const networkByComponent = new Map(); networks.forEach((n) => n.componentIndices.forEach((i) => networkByComponent.set(i, n)));
    const disconnectedConsumerIndices = consumerIndices.filter((i) => !networkByComponent.get(i)?.sourceIndices.length); const underpoweredConsumerIndices = networks.filter((n) => n.status === "underpowered").flatMap((n) => n.consumerIndices);
    const totalGenerationMw = networks.reduce((s, n) => s + n.generationMw, 0), totalDemandMw = networks.reduce((s, n) => s + n.demandMw, 0);
    return { version: WIRING_VERSION, networkCount: networks.length, onlineNetworkCount: networks.filter((n) => n.status === "online").length, underpoweredNetworkCount: networks.filter((n) => n.status === "underpowered").length, unpoweredNetworkCount: networks.filter((n) => n.status === "unpowered").length, totalConnectedGenerationMw: totalGenerationMw, totalConnectedDemandMw: totalDemandMw, totalSurplusMw: totalGenerationMw - totalDemandMw, sourceIndices, consumerIndices, connectedConsumerIndices: consumerIndices.filter((i) => !disconnectedConsumerIndices.includes(i)), disconnectedConsumerIndices, disconnectedConsumerDetails: disconnectedConsumerIndices.map((index) => ({ index, reason: "no-source-in-physical-network" })), underpoweredConsumerIndices, unusedSourceIndices: sourceIndices.filter((i) => !networkByComponent.get(i)?.consumerIndices.length), invalidConnectionCount: 0, invalidConnections: [], networks, networkByComponent };
  }
  function analyzePhysicalWiring(modules, wiring, catalogue) {
    const list = Array.isArray(modules) ? modules : []; const normalized = normalizeWiring(wiring, list, catalogue); const power = analyzePhysicalPower(list, normalized.wiring, catalogue);
    const networks = physicalGroups(list, normalized.wiring.data, catalogue, "data").map((network, index) => ({ ...network, label: `Data Network ${String.fromCharCode(65 + index)}` })); const networkByComponent = new Map(); networks.forEach((n) => n.componentIndices.forEach((i) => networkByComponent.set(i, n)));
    const sourceIndices = [], weaponIndices = []; list.forEach((m, i) => { if (isDataSourceType(m.type)) sourceIndices.push(i); if (isDataTarget(m.type, catalogue)) weaponIndices.push(i); });
    const supportAnalysis = DataSupportRules.analyzeDataSupport(list, networks, catalogue);
    const supports = supportAnalysis.sourceAllocations.map((source) => ({ index: source.sourceIndex, type: source.sourceType, networkId: source.networkId, networkLabel: source.networkLabel, bonusField: source.bonusField, effect: source.effect, unit: source.unit, bonusTotal: source.nominalBudget, connectedWeaponIndices: [...source.connectedWeaponIndices], incompatibleWeaponIndices: [], bonusPerWeapon: source.bonusPerWeapon }));
    const weapons = supportAnalysis.weaponBonuses.map((weapon) => ({ index: weapon.weaponIndex, type: weapon.weaponType, networkId: weapon.networkId, networkLabel: weapon.networkLabel, supportIndices: [...weapon.sourceIndices] }));
    return { version: WIRING_VERSION, wiring: normalized.wiring, droppedRoutes: normalized.droppedRoutes, droppedSegments: normalized.droppedSegments, power, data: { networks, networkByComponent, sourceIndices, weaponIndices, supports, weapons, sourceAllocations: supportAnalysis.sourceAllocations, weaponBonuses: supportAnalysis.weaponBonuses, supportAnalysis }, warnings: [...supportAnalysis.warnings] };
  }

  function deterministicCellSort(a, b) { return a.y - b.y || a.x - b.x; }
  function routeBetweenCellSets(startCells, targetCells, occupiedKeys) {
    const starts = (startCells || []).map((cell) => ({ x: cell.x, y: cell.y })).sort(deterministicCellSort);
    const targets = new Set((targetCells || []).map((cell) => cellKey(cell.x, cell.y)));
    const queue = starts.map((cell) => [cell]);
    const seen = new Set(starts.map((cell) => cellKey(cell.x, cell.y)));
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const path = queue[cursor]; const cell = path.at(-1);
      if (targets.has(cellKey(cell.x, cell.y))) return path;
      for (const next of [{ x: cell.x, y: cell.y - 1 }, { x: cell.x - 1, y: cell.y }, { x: cell.x + 1, y: cell.y }, { x: cell.x, y: cell.y + 1 }]) {
        const key = cellKey(next.x, next.y);
        if (occupiedKeys.has(key) && !seen.has(key)) { seen.add(key); queue.push([...path, next]); }
      }
    }
    return null;
  }

  function createGeneratedPowerWiring(design, componentCatalog) {
    const modules = Array.isArray(design) ? design.map((module) => ({ ...module })) : [];
    const occupiedKeys = new Set();
    modules.forEach((module) => moduleCells(module, componentCatalog).forEach((cell) => occupiedKeys.add(cellKey(cell.x, cell.y))));
    const sourceIndices = modules.map((module, index) => ({ module, index })).filter(({ module }) => isPowerSourceType(module.type)).map(({ index }) => index);
    const consumerIndices = modules.map((module, index) => ({ module, index })).filter(({ module }) => isPowerConsumer(module.type, componentCatalog)).map(({ index }) => index);
    if (!sourceIndices.length) return emptyWiring();
    let wiring = emptyWiring();
    const networkCells = new Set(moduleCells(modules[sourceIndices[0]], componentCatalog).map((cell) => cellKey(cell.x, cell.y)));
    const terminals = [...sourceIndices.slice(1), ...consumerIndices].sort((a, b) => a - b);
    const unreachable = [];
    for (const targetIndex of terminals) {
      const targetCells = moduleCells(modules[targetIndex], componentCatalog).sort(deterministicCellSort);
      if (targetCells.some((cell) => networkCells.has(cellKey(cell.x, cell.y)))) continue;
      const starts = [...networkCells].map((key) => { const [x, y] = key.split(",").map(Number); return { x, y }; }).sort(deterministicCellSort);
      const route = routeBetweenCellSets(starts, targetCells, occupiedKeys);
      if (!route || route.length < 2) { unreachable.push({ index: targetIndex, type: modules[targetIndex]?.type, cells: targetCells }); continue; }
      wiring = addPath(wiring, "power", route, modules, componentCatalog);
      route.forEach((cell) => networkCells.add(cellKey(cell.x, cell.y)));
    }
    const normalized = normalizeWiring(wiring, modules, componentCatalog).wiring;
    const analysis = analyzePhysicalPower(modules, normalized, componentCatalog);
    const missing = consumerIndices.filter((index) => analysis.disconnectedConsumerIndices.includes(index));
    const unusedSources = sourceIndices.filter((index) => !analysis.networkByComponent.get(index));
    if (unreachable.length || missing.length || unusedSources.length || analysis.underpoweredConsumerIndices.length) {
      const details = [...unreachable, ...missing.map((index) => ({ index, type: modules[index]?.type, cells: moduleCells(modules[index], componentCatalog) })), ...unusedSources.map((index) => ({ index, type: modules[index]?.type, cells: moduleCells(modules[index], componentCatalog), reason: "source-not-connected" }))];
      throw new Error(`Generated default Power wiring is incomplete: ${JSON.stringify(details)}`);
    }
    return { version: WIRING_VERSION, power: cloneKind(normalized.power), data: emptyKind(), powerPolicy: PowerPolicyRules.defaultPolicy() };
  }

  function addPath(wiring, kind, cells, modules, catalogue) {
    const next = cloneWiring(wiring); const bucket = next[kind];
    for (let i = 1; i < (cells || []).length; i += 1) { const id = sectionIdFromCells(cells[i - 1], cells[i]); if (!bucket.sections.some((s) => segmentKey(s) === id)) bucket.sections.push({ id, ...canonicalSectionCoordinates(cells[i - 1], cells[i]), tier: STANDARD_TIER }); }
    return normalizeWiring(next, modules, catalogue).wiring;
  }
  function nearestSectionEndpoint(section, point) {
    const endpoints = sectionCells(section);
    if (!point || endpoints.length < 2) return endpoints[0] || null;
    const distanceSquared = (cell) => (cell.x + 0.5 - point.x) ** 2 + (cell.y + 0.5 - point.y) ** 2;
    return distanceSquared(endpoints[1]) < distanceSquared(endpoints[0]) ? endpoints[1] : endpoints[0];
  }
  function removeSection(wiring, kind, id, modules, catalogue) { const next = cloneWiring(wiring); next[kind].sections = next[kind].sections.filter((s) => segmentKey(s) !== id); next[kind].connections = next[kind].connections.filter((c) => !c.sectionIds.includes(id)); return normalizeWiring(next, modules, catalogue).wiring; }
  function removeBranch(wiring, kind, selectedSectionId, preferredEndpoint, modules, catalogue) {
    const found = findLeafBranchSections(wiring?.[kind], selectedSectionId, preferredEndpoint); const ids = new Set(found.sectionIds);
    const next = cloneWiring(wiring); next[kind].sections = next[kind].sections.filter((section) => !ids.has(segmentKey(section)));
    next[kind].connections = next[kind].connections.filter((connection) => !connection.sectionIds.some((id) => ids.has(id)));
    return { wiring: normalizeWiring(next, modules, catalogue).wiring, removedSectionIds: [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), reason: found.reason, choices: found.choices };
  }
  function removePhysicalNetwork(wiring, kind, network, modules, catalogue) { const ids = new Set(network.sectionIds); const next = cloneWiring(wiring); next[kind].sections = next[kind].sections.filter((s) => !ids.has(segmentKey(s))); next[kind].connections = next[kind].connections.filter((c) => !c.sectionIds.some((id) => ids.has(id))); return normalizeWiring(next, modules, catalogue).wiring; }

  return { GRID_SIZE, POINT_MAX, WIRING_VERSION, STANDARD_TIER, ACCEPTED_TIERS, POWER_TIERS, POWER_TIER_PRECEDENCE, higherPowerTier, migrateWiringToCurrentVersion, PowerPolicyRules, MAX_SECTIONS_PER_KIND, MAX_CONNECTIONS_PER_KIND, MAX_SEGMENTS_PER_KIND, MAX_PATH_CELLS, NETWORK_KINDS, DEFAULT_CABLE_LIMITS, POWER_SOURCE_TYPES, DATA_SOURCE_INFO, DATA_SOURCE_TYPES, getOccupiedCells, moduleCells, componentPorts, componentCenter, cellKey, sectionIdFromCells, normalizeTier, normalizeSection, sectionCells, sectionLine, segmentKey, connectionKey, connectionCells, normalizeWiring, emptyWiring, cloneWiring, analyzePowerNetworks: analyzePhysicalPower, analyzeWiring: analyzePhysicalWiring, networkSummaries, networkForComponent, networkForSection, componentReachesPowerSource, isPowerSourceType, isPowerConsumer, isDataSourceType, isDataTarget, isCompatibleWeapon, sourceBonusAmount, addConnection, addPath, removeConnection, removeNetwork: removePhysicalNetwork, removeSection, removeBranch, createGeneratedPowerWiring, createDefaultPowerWiring: createGeneratedPowerWiring, buildSectionGraph, sectionEndpointDegrees, junctionCells, findLeafBranchSections, nearestSectionEndpoint, countUniqueSections, remainingCableLength, additionalLengthForPath };
}));
