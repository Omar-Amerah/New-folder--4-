(function initPowerFlowRules(root, factory) {
  const onNode = typeof module !== "undefined" && module.exports;
  const wiring = onNode ? require("./wiringRules") : root.WiringRules;
  const policy = onNode ? require("./powerPolicyRules") : root.PowerPolicyRules;
  const allocation = onNode ? require("./powerAllocationRules") : root.PowerAllocationRules;
  const rules = factory(wiring, policy, allocation);
  if (onNode) module.exports = rules;
  root.PowerFlowRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makePowerFlowRules(WiringRules, PowerPolicyRules, PowerAllocationRules) {
  "use strict";

  if (!WiringRules) throw new Error("WiringRules must load before PowerFlowRules");
  if (!PowerPolicyRules) throw new Error("PowerPolicyRules must load before PowerFlowRules");
  if (!PowerAllocationRules) throw new Error("PowerAllocationRules must load before PowerFlowRules");

  const { mwToPowerUnits, powerUnitsToMw, compareCanonicalIds } = PowerAllocationRules;
  const { moduleCells, sectionCells, cellKey, isPowerSourceType, isPowerConsumer, normalizeWiring, POWER_TIERS } = WiringRules;

  const RATIO_ONE = 1000000; // fixed-point resolution for the per-band fill ratio
  const POWER_TIER_SET = new Set(POWER_TIERS);

  function partFor(catalogue, type) { return (catalogue && (catalogue[type] || catalogue.frame)) || {}; }
  function numberOr(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
  function compareNumberThen(aNum, bNum, aId, bId) { return aNum !== bNum ? aNum - bNum : compareCanonicalIds(aId, bId); }
  function pad2(value) { const n = Math.trunc(numberOr(value, 0)); return (n < 0 ? "-" : "") + String(Math.abs(n)).padStart(2, "0"); }

  // Stable key derived from physical identity only (never the design-array
  // index), so fairness and routing tie-breaks are independent of component
  // order: min occupied y, min occupied x, the full sorted occupied-cell
  // signature, type, then normalised rotation. Zero-padded so canonical string
  // ordering matches coordinate ordering. Example: "07,06|06,07;07,07|reactor|0".
  function stableComponentKey(moduleValue, catalogue) {
    const cells = moduleCells(moduleValue, catalogue).map((cell) => ({ x: cell.x, y: cell.y }))
      .sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const first = cells[0] || { x: 0, y: 0 };
    const signature = cells.map((cell) => `${pad2(cell.y)},${pad2(cell.x)}`).join(";");
    const type = String((moduleValue && moduleValue.type) || "");
    const rotation = ((Math.trunc(numberOr(moduleValue && moduleValue.rotation, 0)) % 360) + 360) % 360;
    return `${pad2(first.y)},${pad2(first.x)}|${signature}|${type}|${rotation}`;
  }

  // ------------------------------------------------------------------
  // Deterministic integer max-flow (Edmonds-Karp; BFS shortest augmenting
  // path). Section edges are undirected (reverse residual = capacity), so a
  // section's signed flow is bounded to [-peak, +peak]. Source/consumer edges
  // are directed so a component can never act as a hidden bridge between
  // otherwise disconnected cable islands.
  // ------------------------------------------------------------------
  function createFlowNetwork(nodeCount) {
    const edges = [];
    const graph = Array.from({ length: nodeCount }, () => []);
    function addEdge(u, v, cap, undirected) {
      const forward = edges.length;
      graph[u].push(forward); edges.push({ to: v, cap, flow: 0 });
      graph[v].push(edges.length); edges.push({ to: u, cap: undirected ? cap : 0, flow: 0 });
      return forward;
    }
    function residual(edgeIndex) { return edges[edgeIndex].cap - edges[edgeIndex].flow; }
    function push(edgeIndex, amount) { edges[edgeIndex].flow += amount; edges[edgeIndex ^ 1].flow -= amount; }
    function maxflow(source, sink) {
      let total = 0;
      for (;;) {
        const parentEdge = new Array(nodeCount).fill(-1);
        parentEdge[source] = -2;
        const queue = [source];
        for (let head = 0; head < queue.length && parentEdge[sink] === -1; head += 1) {
          const u = queue[head];
          for (const edgeIndex of graph[u]) {
            const v = edges[edgeIndex].to;
            if (parentEdge[v] === -1 && residual(edgeIndex) > 0) { parentEdge[v] = edgeIndex; queue.push(v); }
          }
        }
        if (parentEdge[sink] === -1) break;
        let bottleneck = Infinity;
        for (let v = sink; v !== source; v = edges[parentEdge[v] ^ 1].to) bottleneck = Math.min(bottleneck, residual(parentEdge[v]));
        for (let v = sink; v !== source; v = edges[parentEdge[v] ^ 1].to) push(parentEdge[v], bottleneck);
        total += bottleneck;
      }
      return total;
    }
    return {
      addEdge, maxflow,
      snapshot() { return edges.map((e) => e.flow); },
      restore(snap) { for (let i = 0; i < edges.length; i += 1) edges[i].flow = snap[i]; },
      edgeFlow(edgeIndex) { return edges[edgeIndex].flow; },
      setCap(edgeIndex, cap) { edges[edgeIndex].cap = cap; }
    };
  }

  // ------------------------------------------------------------------
  // Topology extraction from physical Wiring v3 sections. Sections are the
  // authority; persisted connection metadata is ignored. Data wiring is
  // ignored. Section-array order never affects results.
  // ------------------------------------------------------------------
  function buildTopology(design, wiring, catalogue, infrastructure, sectionOperationalById, options = {}) {
    const modules = Array.isArray(design) ? design : [];
    const normalized = normalizeWiring(wiring, modules, catalogue).wiring;
    const rawSections = (normalized.power.sections || []).concat(Array.isArray(options.internalPowerEdges) ? options.internalPowerEdges : []).slice()
      .sort((a, b) => compareCanonicalIds(a.id, b.id));

    // Operational section list (canonical id order).
    const sections = rawSections.filter((section) => {
      const flag = sectionOperationalById ? sectionOperationalById[section.id] : undefined;
      return flag === undefined ? true : Boolean(flag);
    });

    // Cable-cell nodes: only cells that are endpoints of an operational section.
    const cellNode = new Map();
    const orderedCellKeys = [];
    for (const section of sections) for (const cell of sectionCells(section)) {
      const key = cellKey(cell.x, cell.y);
      if (!cellNode.has(key)) { cellNode.set(key, null); orderedCellKeys.push(key); }
    }
    orderedCellKeys.sort(compareCanonicalIds);

    // Occupancy: which component occupies each cell (for terminal attachment).
    const occupant = new Map();
    modules.forEach((moduleValue, index) => moduleCells(moduleValue, catalogue).forEach((cell) => occupant.set(cellKey(cell.x, cell.y), index)));

    return { modules, normalized, sections, cellNode, orderedCellKeys, occupant };
  }

  function tierConfig(infrastructure, tier) {
    const normalizedTier = POWER_TIER_SET.has(tier) ? tier : "standard";
    return (infrastructure && infrastructure.powerTiers && infrastructure.powerTiers[normalizedTier]) || {};
  }

  // ------------------------------------------------------------------
  // Main solver.
  //
  // solvePowerFlow({ design, wiring, catalogue, infrastructure,
  //   sourceGenerationByIndex?, consumerDemandByIndex?,
  //   componentOperationalByIndex?, sectionOperationalById?, policy? })
  //
  // The priority policy defaults to the normalised policy saved on the
  // Blueprint (wiring.powerPolicy). options.policy is only an explicit
  // test/diagnostic override. All runtime-state inputs default to an intact
  // Blueprint; inputs are never mutated.
  // ------------------------------------------------------------------
  function solvePowerFlow(input) {
    const options = input && typeof input === "object" ? input : {};
    const catalogue = options.catalogue || {};
    const infrastructure = options.infrastructure || {};
    const topo = buildTopology(options.design, options.wiring, catalogue, infrastructure, options.sectionOperationalById, options);
    const { modules, sections, cellNode, orderedCellKeys, occupant } = topo;

    // Section-connectivity islands (union-find over section endpoints), computed
    // up front and by canonical root order so grouping never depends on section
    // order. Used both for network attribution and — Section 7D-2 — to attach a
    // component to exactly one terminal cell per island, so a multi-cell source
    // or consumer can no longer bypass its own first/last cable section while
    // still reaching genuinely separate islands.
    const cellParent = new Map();
    const find = (key) => { while (cellParent.get(key) !== key) { cellParent.set(key, cellParent.get(cellParent.get(key))); key = cellParent.get(key); } return key; };
    orderedCellKeys.forEach((key) => cellParent.set(key, key));
    const union = (x, y) => { const rx = find(x); const ry = find(y); if (rx === ry) return; if (compareCanonicalIds(rx, ry) < 0) cellParent.set(ry, rx); else cellParent.set(rx, ry); };
    for (const section of sections) { const [a, b] = sectionCells(section); union(cellKey(a.x, a.y), cellKey(b.x, b.y)); }
    const networkRootOfCell = new Map(orderedCellKeys.map((key) => [key, find(key)]));
    const networkKeys = [...new Set([...networkRootOfCell.values()])].sort(compareCanonicalIds);
    const networkIndexByRoot = new Map(networkKeys.map((root, i) => [root, i]));
    const networkIndexOfCell = (key) => networkRootOfCell.has(key) ? networkIndexByRoot.get(networkRootOfCell.get(key)) : -1;
    const networkOfComponentIndex = (terminals) => {
      const set = new Set();
      for (const key of terminals) if (networkRootOfCell.has(key)) set.add(networkIndexByRoot.get(networkRootOfCell.get(key)));
      // Network indices follow canonical root order, so sorting ascending yields
      // the canonically lowest attached network first.
      return [...set].sort((a, b) => a - b);
    };
    // Exactly one deterministic terminal per island: the canonically lowest cell.
    const selectIslandTerminals = (terminals) => {
      const byRoot = new Map();
      for (const key of terminals) {
        if (!networkRootOfCell.has(key)) continue;
        const root = networkRootOfCell.get(key);
        const current = byRoot.get(root);
        if (current === undefined || compareCanonicalIds(key, current) < 0) byRoot.set(root, key);
      }
      return [...byRoot.values()].sort(compareCanonicalIds);
    };

    const operationalOf = (index) => {
      const flag = options.componentOperationalByIndex ? options.componentOperationalByIndex[index] : undefined;
      return flag === undefined ? true : Boolean(flag);
    };
    const sourceGenMw = (index, type) => {
      const supplied = options.sourceGenerationByIndex ? options.sourceGenerationByIndex[index] : undefined;
      return supplied === undefined ? numberOr(partFor(catalogue, type).powerGeneration, 0) : numberOr(supplied, 0);
    };
    // Demand override: componentDemandByIndex (Section 7D-2 activity-driven
    // demand) takes precedence; consumerDemandByIndex is kept for existing tests.
    // Absent -> nominal catalogue powerUse (compatibility default).
    const demandOverride = options.componentDemandByIndex || options.consumerDemandByIndex;
    const consumerDemandMw = (index, type) => {
      const supplied = demandOverride ? demandOverride[index] : undefined;
      return supplied === undefined ? numberOr(partFor(catalogue, type).powerUse, 0) : numberOr(supplied, 0);
    };

    // Classify components and gather their live cable terminal cells.
    const sources = []; const consumers = [];
    const cellKeysSet = new Set(orderedCellKeys);
    modules.forEach((moduleValue, index) => {
      const type = moduleValue && moduleValue.type;
      const alive = operationalOf(index);
      const terminals = moduleCells(moduleValue, catalogue).map((cell) => cellKey(cell.x, cell.y)).filter((key) => cellKeysSet.has(key));
      const uniqueTerminals = [...new Set(terminals)].sort(compareCanonicalIds);
      // One terminal per island so a multi-cell component injects/draws at a
      // single cell per network and cannot bypass its own cable sections.
      const islandTerminals = selectIslandTerminals(uniqueTerminals);
      if (isPowerSourceType(type)) {
        sources.push({ index, type, terminals: islandTerminals, alive, generationMw: alive ? sourceGenMw(index, type) : 0, stableKey: stableComponentKey(moduleValue, catalogue) });
      } else if (isPowerConsumer(type, catalogue)) {
        consumers.push({ index, type, terminals: islandTerminals, alive, demandMw: alive ? consumerDemandMw(index, type) : 0, powerCategory: partFor(catalogue, type).powerCategory || null, stableKey: stableComponentKey(moduleValue, catalogue) });
      }
    });
    // Order sources and consumers by stable physical identity (design-array
    // index is only an impossible final tie-break) so graph construction,
    // routing and fairness never depend on component ordering.
    const byStableKey = (a, b) => compareCanonicalIds(a.stableKey, b.stableKey) || (a.index - b.index);
    sources.sort(byStableKey);
    consumers.sort(byStableKey);

    // ---- Build the flow network (nodes: S, T, one per cable cell, one per
    // source, one per consumer). ----
    const S = 0; const T = 1;
    const cellBase = 2;
    orderedCellKeys.forEach((key, i) => cellNode.set(key, cellBase + i));
    const sourceBase = cellBase + orderedCellKeys.length;
    const consumerBase = sourceBase + sources.length;
    const nodeCount = consumerBase + consumers.length;
    const net = createFlowNetwork(nodeCount);

    // Section edges (undirected, capacity = peak units). Sorted by id already.
    const sectionFwdEdge = new Map();
    const sectionInfo = [];
    for (const section of sections) {
      const [a, b] = sectionCells(section);
      const tier = section.tier;
      const config = tierConfig(infrastructure, tier);
      const peakUnits = mwToPowerUnits(config.peakCapacityMw);
      const fwd = net.addEdge(cellNode.get(cellKey(a.x, a.y)), cellNode.get(cellKey(b.x, b.y)), peakUnits, true);
      sectionFwdEdge.set(section.id, fwd);
      sectionInfo.push({ section, tier, config, peakUnits, sustainedUnits: mwToPowerUnits(config.sustainedCapacityMw) });
    }

    // Source terminals: S -> sourceNode (cap = generation), sourceNode -> each
    // terminal cell (cap = generation). Generation counted once via the S edge.
    const sourceGenUnits = sources.map((source) => mwToPowerUnits(source.generationMw));
    const sourceSupplyEdge = [];
    const sourceTerminalEdges = []; // per source: [{ key, edge }] for sourceNode -> cell
    sources.forEach((source, s) => {
      const node = sourceBase + s;
      sourceSupplyEdge[s] = net.addEdge(S, node, sourceGenUnits[s], false);
      sourceTerminalEdges[s] = source.terminals.map((key) => ({ key, edge: net.addEdge(node, cellNode.get(key), sourceGenUnits[s], false) }));
    });

    // Consumer terminals: each terminal cell -> consumerNode (cap = demand),
    // consumerNode -> T (cap starts at 0; raised per priority band). Demand
    // drawn once via the single consumerNode.
    const consumerDemandUnits = consumers.map((consumer) => mwToPowerUnits(consumer.demandMw));
    const consumerSinkEdge = [];
    const consumerTerminalEdges = []; // per consumer: [{ key, edge }] for cell -> consumerNode
    consumers.forEach((consumer, c) => {
      const node = consumerBase + c;
      consumerTerminalEdges[c] = consumer.terminals.map((key) => ({ key, edge: net.addEdge(cellNode.get(key), node, consumerDemandUnits[c], false) }));
      consumerSinkEdge[c] = net.addEdge(node, T, 0, false);
    });

    const grantedUnits = consumers.map(() => 0);
    const consumerByIndex = new Map(consumers.map((consumer, c) => [consumer.index, c]));

    // ---- Priority-band allocation over one shared pool. Higher bands are
    // fully processed before lower bands; the residual carries committed flow
    // so lower bands only use remaining generation and cable capacity. ----
    // The authoritative policy is the one saved on the Blueprint wiring
    // (already normalised by buildTopology). options.policy is only an explicit
    // test/diagnostic override.
    const resolvedPolicy = options.policy !== undefined ? options.policy : topo.normalized.powerPolicy;
    const bands = PowerPolicyRules.resolvePriorityBands(resolvedPolicy);
    const categoryBand = new Map();
    bands.forEach((band, bandIndex) => band.forEach((category) => categoryBand.set(category, bandIndex)));
    const bandOfConsumer = (c) => {
      const category = consumers[c].powerCategory;
      return categoryBand.has(category) ? categoryBand.get(category) : bands.length; // uncategorised last
    };

    const flowInto = (c) => net.edgeFlow(consumerSinkEdge[c]);
    function feasibleAtRatio(activeSet, ratio, committedSnapshot) {
      // Set target caps: active consumers up to floor(demand*ratio); everyone
      // else locked at granted. Returns true if every active consumer reaches
      // its target, restoring the committed flow afterwards.
      for (let c = 0; c < consumers.length; c += 1) {
        if (activeSet.has(c)) net.setCap(consumerSinkEdge[c], Math.floor(consumerDemandUnits[c] * ratio / RATIO_ONE));
        else net.setCap(consumerSinkEdge[c], grantedUnits[c]);
      }
      net.restore(committedSnapshot);
      net.maxflow(S, T);
      let ok = true;
      for (const c of activeSet) if (flowInto(c) < Math.floor(consumerDemandUnits[c] * ratio / RATIO_ONE)) { ok = false; break; }
      net.restore(committedSnapshot);
      return ok;
    }
    function canReceiveMore(c, committedSnapshot) {
      for (let k = 0; k < consumers.length; k += 1) net.setCap(consumerSinkEdge[k], k === c ? grantedUnits[c] + 1 : grantedUnits[k]);
      net.restore(committedSnapshot);
      const gained = net.maxflow(S, T) > 0 && flowInto(c) > grantedUnits[c];
      net.restore(committedSnapshot);
      return gained;
    }

    const orderedBandIndices = [...new Set(consumers.map((_, c) => bandOfConsumer(c)))].sort((a, b) => a - b);
    for (const bandIndex of orderedBandIndices) {
      let active = consumers.map((_, c) => c).filter((c) => bandOfConsumer(c) === bandIndex && consumerDemandUnits[c] > 0);
      // Max-min fair fill: raise a uniform ratio for the active set until a
      // bottleneck freezes a consumer, then repeat for the rest.
      for (let guard = 0; guard < consumers.length + 2 && active.length; guard += 1) {
        const committed = net.snapshot();
        active = active.filter((c) => grantedUnits[c] < consumerDemandUnits[c] && canReceiveMore(c, committed));
        if (!active.length) break;
        const activeSet = new Set(active);
        let lo = 0; let hi = RATIO_ONE; let best = 0;
        while (lo <= hi) {
          const mid = Math.floor((lo + hi) / 2);
          if (feasibleAtRatio(activeSet, mid, committed)) { best = mid; lo = mid + 1; } else hi = mid - 1;
        }
        // Commit the best feasible ratio.
        for (let c = 0; c < consumers.length; c += 1) {
          if (activeSet.has(c)) net.setCap(consumerSinkEdge[c], Math.floor(consumerDemandUnits[c] * best / RATIO_ONE));
          else net.setCap(consumerSinkEdge[c], grantedUnits[c]);
        }
        net.restore(committed);
        net.maxflow(S, T);
        let progressed = false;
        for (const c of activeSet) { const got = flowInto(c); if (got > grantedUnits[c]) progressed = true; grantedUnits[c] = got; }
        // Lock caps at granted so committed flow survives later bands.
        for (let c = 0; c < consumers.length; c += 1) net.setCap(consumerSinkEdge[c], grantedUnits[c]);
        if (!progressed) break;
      }

      // Residual fixed-point distribution: the uniform-ratio fill can leave a
      // few reachable units unallocated when the active consumers cannot all
      // advance to the next common ratio. Hand those units out one at a time,
      // the consumer furthest UNDER its proportional fair share first (stable
      // physical key as the deterministic tie-break), preserving every already
      // committed allocation, peak limits and conservation. The leftover is
      // bounded by the number of band consumers (Hamilton rounding remainder).
      const bandConsumers = consumers.map((_, c) => c).filter((c) => bandOfConsumer(c) === bandIndex && consumerDemandUnits[c] > 0);
      for (let guard = 0; guard < bandConsumers.length + 4; guard += 1) {
        const committed = net.snapshot();
        const totalGrant = bandConsumers.reduce((sum, c) => sum + grantedUnits[c], 0);
        const totalDemand = bandConsumers.reduce((sum, c) => sum + consumerDemandUnits[c], 0);
        const candidates = bandConsumers.filter((c) => grantedUnits[c] < consumerDemandUnits[c] && canReceiveMore(c, committed));
        if (!candidates.length) break;
        candidates.sort((a, b) => {
          // deficit = granted*totalDemand - totalGrant*demand; a smaller value is
          // further under the proportional fair share, so it is served first.
          const da = grantedUnits[a] * totalDemand - totalGrant * consumerDemandUnits[a];
          const db = grantedUnits[b] * totalDemand - totalGrant * consumerDemandUnits[b];
          return (da - db) || compareCanonicalIds(consumers[a].stableKey, consumers[b].stableKey);
        });
        const c = candidates[0];
        for (let k = 0; k < consumers.length; k += 1) net.setCap(consumerSinkEdge[k], k === c ? grantedUnits[c] + 1 : grantedUnits[k]);
        net.restore(committed);
        net.maxflow(S, T);
        if (flowInto(c) <= grantedUnits[c]) break;
        grantedUnits[c] = flowInto(c);
        for (let k = 0; k < consumers.length; k += 1) net.setCap(consumerSinkEdge[k], grantedUnits[k]);
      }
    }

    // ---- Read committed flow into serialisable results. ----
    const usedGenUnits = sources.map((_, s) => net.edgeFlow(sourceSupplyEdge[s]));
    const totalUsedGenUnits = usedGenUnits.reduce((sum, value) => sum + value, 0);

    // Networks: connected components of the section graph, from the union-find
    // computed up front (see above).
    const networks = networkKeys.map((root, i) => ({
      id: `power-net-${i}`, root, sectionIds: [], sourceIndices: [], consumerIndices: [],
      availableGenUnits: 0, usedGenUnits: 0, demandUnits: 0, allocatedUnits: 0
    }));
    for (const section of sections) {
      const [a] = sectionCells(section);
      networks[networkIndexByRoot.get(networkRootOfCell.get(cellKey(a.x, a.y)))].sectionIds.push(section.id);
    }
    // Per-network totals attribute ACTUAL flow to the network the flow physically
    // crossed (via terminal-edge flow), never the full aggregate to every attached
    // network. Nominal spare capacity / unmet demand for a multi-network component
    // is deterministically assigned to its canonically lowest attached network, so
    // sums stay counted once and usedGen <= availableGen, allocated <= demand.
    sources.forEach((source, s) => {
      const attachedNets = networkOfComponentIndex(source.terminals);
      for (const netId of attachedNets) networks[netId].sourceIndices.push(source.index);
      let used = 0;
      for (const { key, edge } of sourceTerminalEdges[s]) {
        const flow = Math.max(0, net.edgeFlow(edge));
        if (flow <= 0) continue;
        const netId = networkIndexOfCell(key);
        if (netId < 0) continue;
        networks[netId].usedGenUnits += flow;
        networks[netId].availableGenUnits += flow;
        used += flow;
      }
      if (attachedNets.length) networks[attachedNets[0]].availableGenUnits += Math.max(0, sourceGenUnits[s] - used);
    });
    consumers.forEach((consumer, c) => {
      const attachedNets = networkOfComponentIndex(consumer.terminals);
      for (const netId of attachedNets) networks[netId].consumerIndices.push(consumer.index);
      let allocated = 0;
      for (const { key, edge } of consumerTerminalEdges[c]) {
        const flow = Math.max(0, net.edgeFlow(edge));
        if (flow <= 0) continue;
        const netId = networkIndexOfCell(key);
        if (netId < 0) continue;
        networks[netId].allocatedUnits += flow;
        networks[netId].demandUnits += flow;
        allocated += flow;
      }
      if (attachedNets.length) networks[attachedNets[0]].demandUnits += Math.max(0, consumerDemandUnits[c] - allocated);
    });

    const sectionFlows = sectionInfo.map(({ section, tier, config, peakUnits, sustainedUnits }) => {
      const signedUnits = net.edgeFlow(sectionFwdEdge.get(section.id));
      const absUnits = Math.abs(signedUnits);
      // Canonical direction: positive = x1,y1 -> x2,y2.
      const signedFlowMw = signedUnits >= 0 ? powerUnitsToMw(signedUnits) : -powerUnitsToMw(absUnits);
      return {
        sectionId: section.id, tier,
        signedFlowMw,
        absoluteFlowMw: powerUnitsToMw(absUnits),
        sustainedCapacityMw: numberOr(config.sustainedCapacityMw, 0),
        peakCapacityMw: numberOr(config.peakCapacityMw, 0),
        sustainedUtilisation: sustainedUnits > 0 ? absUnits / sustainedUnits : 0,
        peakUtilisation: peakUnits > 0 ? absUnits / peakUnits : 0,
        aboveSustained: sustainedUnits > 0 && absUnits > sustainedUnits,
        atPeak: peakUnits > 0 && absUnits === peakUnits,
        operational: true
      };
    }).sort((a, b) => compareCanonicalIds(a.sectionId, b.sectionId));

    // Per-component output for sources, consumers and passive hosts.
    const powerCategoryOf = (index, type) => partFor(catalogue, type).powerCategory || null;
    const byComponentIndex = [];
    const sourceByIndex = new Map(sources.map((source, s) => [source.index, s]));
    modules.forEach((moduleValue, index) => {
      const type = moduleValue && moduleValue.type;
      const alive = operationalOf(index);
      const terminals = moduleCells(moduleValue, catalogue).map((cell) => cellKey(cell.x, cell.y)).filter((key) => cellKeysSet.has(key));
      const uniqueTerminals = [...new Set(terminals)].sort(compareCanonicalIds);
      const networkIds = networkOfComponentIndex(uniqueTerminals).map((i) => networks[i].id);
      if (sourceByIndex.has(index)) {
        const s = sourceByIndex.get(index);
        byComponentIndex.push({
          componentIndex: index, role: "source", powerCategory: powerCategoryOf(index, type),
          requestedMw: 0, allocatedMw: 0, unmetMw: 0,
          generationAvailableMw: powerUnitsToMw(sourceGenUnits[s]), generationUsedMw: powerUnitsToMw(usedGenUnits[s]),
          operationalMultiplier: 1, priorityBand: null, networkIds, state: alive ? "source" : "destroyed"
        });
      } else if (consumerByIndex.has(index)) {
        const c = consumerByIndex.get(index);
        const requested = consumerDemandUnits[c]; const allocated = grantedUnits[c]; const unmet = Math.max(0, requested - allocated);
        let state;
        if (!alive) state = "destroyed";
        else if (uniqueTerminals.length === 0) state = "disconnected";
        else if (allocated <= 0) state = "unpowered";
        else if (allocated >= requested) state = "powered";
        else state = "underpowered";
        byComponentIndex.push({
          componentIndex: index, role: "consumer", powerCategory: consumers[c].powerCategory,
          requestedMw: powerUnitsToMw(requested), allocatedMw: powerUnitsToMw(allocated), unmetMw: powerUnitsToMw(unmet),
          generationAvailableMw: 0, generationUsedMw: 0,
          operationalMultiplier: requested > 0 ? allocated / requested : 1,
          priorityBand: alive ? bandOfConsumer(c) : null, networkIds, state
        });
      } else {
        byComponentIndex.push({
          componentIndex: index, role: "passive", powerCategory: powerCategoryOf(index, type),
          requestedMw: 0, allocatedMw: 0, unmetMw: 0, generationAvailableMw: 0, generationUsedMw: 0,
          operationalMultiplier: 1, priorityBand: null, networkIds, state: alive ? "passive" : "destroyed"
        });
      }
    });
    byComponentIndex.sort((a, b) => a.componentIndex - b.componentIndex);

    const totalDemandUnits = consumerDemandUnits.reduce((sum, value) => sum + value, 0);
    const totalAllocatedUnits = grantedUnits.reduce((sum, value) => sum + value, 0);
    const totalAvailableGenUnits = sourceGenUnits.reduce((sum, value) => sum + value, 0);

    const networkOut = networks.map((networkValue) => ({
      id: networkValue.id,
      sectionIds: networkValue.sectionIds.slice().sort(compareCanonicalIds),
      sourceIndices: [...new Set(networkValue.sourceIndices)].sort((a, b) => a - b),
      consumerIndices: [...new Set(networkValue.consumerIndices)].sort((a, b) => a - b),
      availableGenerationMw: powerUnitsToMw(networkValue.availableGenUnits),
      usedGenerationMw: powerUnitsToMw(networkValue.usedGenUnits),
      demandMw: powerUnitsToMw(networkValue.demandUnits),
      allocatedMw: powerUnitsToMw(networkValue.allocatedUnits),
      unmetMw: powerUnitsToMw(Math.max(0, networkValue.demandUnits - networkValue.allocatedUnits)),
      strandedGenerationMw: powerUnitsToMw(Math.max(0, networkValue.availableGenUnits - networkValue.usedGenUnits))
    })).sort((a, b) => compareCanonicalIds(a.id, b.id));

    // Per-category demand/allocation diagnostics. Shields and Point Defence are
    // aggregated separately even when a named preset ties them in one band. The
    // band index is the first band a category appears in (its priority). Sums are
    // accumulated in fixed-point units to avoid floating-point drift.
    const bandIndexByCategory = new Map();
    bands.forEach((band, bandIndex) => band.forEach((cat) => { if (!bandIndexByCategory.has(cat)) bandIndexByCategory.set(cat, bandIndex); }));
    const categoryUnits = new Map();
    consumers.forEach((consumer, c) => {
      const cat = consumer.powerCategory || "uncategorised";
      const agg = categoryUnits.get(cat) || { requestedUnits: 0, allocatedUnits: 0 };
      agg.requestedUnits += consumerDemandUnits[c];
      agg.allocatedUnits += grantedUnits[c];
      categoryUnits.set(cat, agg);
    });
    // Every authoritative category is reported (0 MW when the ship has no such
    // consumer) so diagnostics render a stable six-row table; any non-canonical
    // category that somehow appears is appended after the canonical six.
    const categoryList = [...PowerPolicyRules.POWER_CATEGORIES];
    for (const cat of categoryUnits.keys()) if (!categoryList.includes(cat)) categoryList.push(cat);
    const byCategory = {};
    const loadShedCategories = [];
    for (const cat of categoryList) {
      const agg = categoryUnits.get(cat) || { requestedUnits: 0, allocatedUnits: 0 };
      const unmetUnits = Math.max(0, agg.requestedUnits - agg.allocatedUnits);
      byCategory[cat] = {
        demandMw: powerUnitsToMw(agg.requestedUnits),
        allocatedMw: powerUnitsToMw(agg.allocatedUnits),
        unmetMw: powerUnitsToMw(unmetUnits),
        priorityBand: bandIndexByCategory.has(cat) ? bandIndexByCategory.get(cat) : null
      };
      if (unmetUnits > 0) loadShedCategories.push(cat);
    }

    // Spare usable generation: surplus left on networks that fully powered their
    // own real demand — headroom that could serve more load. Isolated generation
    // with no reachable demand is not "spare"; it stays in strandedGenerationMw.
    let spareGenUnits = 0;
    networks.forEach((networkValue) => {
      const unmetUnits = Math.max(0, networkValue.demandUnits - networkValue.allocatedUnits);
      if (networkValue.demandUnits > 0 && unmetUnits === 0) {
        spareGenUnits += Math.max(0, networkValue.availableGenUnits - networkValue.usedGenUnits);
      }
    });

    return {
      byComponentIndex,
      sectionFlows,
      networks: networkOut,
      summary: {
        preset: PowerPolicyRules.normalizePolicy(resolvedPolicy).preset,
        availableGenerationMw: powerUnitsToMw(totalAvailableGenUnits),
        usedGenerationMw: powerUnitsToMw(totalUsedGenUnits),
        strandedGenerationMw: powerUnitsToMw(Math.max(0, totalAvailableGenUnits - totalUsedGenUnits)),
        spareGenerationMw: powerUnitsToMw(spareGenUnits),
        demandMw: powerUnitsToMw(totalDemandUnits),
        allocatedMw: powerUnitsToMw(totalAllocatedUnits),
        unmetMw: powerUnitsToMw(Math.max(0, totalDemandUnits - totalAllocatedUnits)),
        aboveSustainedSections: sectionFlows.filter((flow) => flow.aboveSustained).length,
        atPeakSections: sectionFlows.filter((flow) => flow.atPeak).length,
        byCategory,
        loadShedCategories
      }
    };
  }

  return { solvePowerFlow, RATIO_ONE };
}));
