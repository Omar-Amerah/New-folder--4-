import { WIRING_ENABLED } from "../featureFlags.js";

function dataRules() { return globalThis.DataSupportRules; }
function wiringRules() { return globalThis.WiringRules; }
function heatRules() { return globalThis.HeatRules; }
const modulesOf = (design) => Array.isArray(design) ? design : Array.isArray(design?.components) ? design.components : [];
const partFor = (catalogue, type) => catalogue?.[type] || {};
const scenarioName = (mode) => ({ idle: "Idle", combat: "Typical Combat", full: "Maximum Sustained Load" }[mode] || mode || "Maximum Sustained Load");

function powerMultiplier(index, power) {
  const network = power?.networkByComponent?.get?.(index) || power?.networks?.find?.((n) => n.componentIndices?.includes(index));
  if (!network || !network.sourceIndices?.length) return 0;
  if (!network.consumerIndices?.includes(index)) return 0;
  const value = Number(network.availableEfficiency);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
function thermalAnalysisFor(design, wiring, mode, injected) {
  if (injected) return injected;
  const analyze = globalThis.DesignThermalAnalysis?.analyzeDesignHeat || globalThis.analyzeDesignHeat;
  if (typeof analyze !== "function") return null;
  return analyze(design, wiring, mode || "full");
}
function thermalMultiplier(index, design, thermalAnalysis) {
  try {
    if (!thermalAnalysis) return 1;
    const prediction = thermalAnalysis.predictions?.get?.(modulesOf(design)[index]) || (thermalAnalysis.predictions ? [...thermalAnalysis.predictions.values()][index] : null);
    if (!prediction) return 1;
    return heatRules().activeOutputForState(prediction.state ?? heatRules().STATE.NORMAL);
  } catch (_error) { return 0; }
}
function bonusLoss(before, after, weaponIndex) {
  const a = getDesignWeaponSupport(before, weaponIndex), b = getDesignWeaponSupport(after, weaponIndex);
  return { lostRangeBonus: Math.max(0, (a.rangeBonus || 0) - (b.rangeBonus || 0)), lostAccuracyBonus: Math.max(0, (a.accuracyBonus || 0) - (b.accuracyBonus || 0)), lostFireRateBonus: Math.max(0, (a.fireRateBonus || 0) - (b.fireRateBonus || 0)) };
}
function changedLoss(l) { return (l.lostRangeBonus || 0) > 1e-9 || (l.lostAccuracyBonus || 0) > 1e-9 || (l.lostFireRateBonus || 0) > 1e-9; }
function severityFor(losses, disconnected) {
  const affected = losses.filter(changedLoss).length;
  const allLost = losses.filter((l) => l.allSupportLost).length;
  if (!disconnected.length && !affected) return "redundant";
  if (disconnected.length >= 2 || allLost >= 2) return "critical";
  if (disconnected.length === 1 || allLost === 1 || affected >= 3) return "high";
  if (affected) return "medium";
  return "low";
}
function topologySignature(analysis) {
  return (analysis.networks || []).map((n) => [`sec:${[...(n.sectionIds||[])].sort().join(",")}`,`src:${[...(n.sourceIndices||[])].sort((a,b)=>a-b).join(",")}`,`wpn:${[...(n.weaponIndices||[])].sort((a,b)=>a-b).join(",")}`].join("|")).sort().join(";") + "#" + (analysis.weapons || []).map((w)=>`${w.weaponIndex}<${[...(w.sourceIndices||[])].sort((a,b)=>a-b).join(",")}`).sort().join(";");
}
export function analyzeDesignDataSupport(design, wiring, catalogue, options = {}) {
  const modules = modulesOf(design); const mode = options.thermalLoadMode || options.scenario || "full";
  const automatic = !WIRING_ENABLED;
  const useDirectLinks = automatic || options.topologyMode === "direct-links" || Array.isArray(options.dataLinks);
  const directDataLinks = dataRules().normalizeDataLinks(modules, options.dataLinks, catalogue);
  const physical = useDirectLinks
    ? { wiring: wiringRules().emptyWiring(), power: { networks: [], networkByComponent: new Map() }, data: { networks: [], networkByComponent: new Map() } }
    : wiringRules().analyzeWiring(modules, wiring, catalogue);
  const thermalAnalysis = thermalAnalysisFor(modules, physical.wiring, mode, options.thermalAnalysis);
  const sourcePrediction = new Map();
  modules.forEach((module, index) => {
    if (!dataRules().isDataSupportSource(module?.type)) return;
    const pred = thermalAnalysis?.predictions?.get?.(module) || (thermalAnalysis?.predictions ? [...thermalAnalysis.predictions.values()][index] : null);
    const predictedPowerMultiplier = typeof options.sourcePowerMultiplier === "function" ? Number(options.sourcePowerMultiplier(index, module)) || 0 : options.sourcePowerMultiplier != null ? Number(options.sourcePowerMultiplier) || 0 : useDirectLinks ? 1 : pred && typeof pred.powerMultiplier === "number" ? pred.powerMultiplier : powerMultiplier(index, physical.power);
    const predictedThermalMultiplier = typeof options.sourceThermalMultiplier === "function" ? Number(options.sourceThermalMultiplier(index, module)) || 0 : options.sourceThermalMultiplier != null ? Number(options.sourceThermalMultiplier) || 0 : thermalMultiplier(index, modules, thermalAnalysis);
    const op = options.sourceOperationalMultiplier ?? options.operationalMultiplier;
    const predictedOperationalMultiplier = typeof op === "function" ? Number(op(index, module)) || 0 : op == null ? 1 : Number(op) || 0;
    sourcePrediction.set(index, { predictedPowerMultiplier, predictedThermalMultiplier, predictedOperationalMultiplier, predictedSourceMultiplier: predictedPowerMultiplier * predictedThermalMultiplier * predictedOperationalMultiplier });
  });
  const support = useDirectLinks
    ? dataRules().analyzeDirectDataSupport(modules, directDataLinks, catalogue, { powerMultiplier: (index, module, part) => sourcePrediction.get(index)?.predictedPowerMultiplier ?? 1, thermalMultiplier: (index) => sourcePrediction.get(index)?.predictedThermalMultiplier ?? 1, operationalMultiplier: (index) => sourcePrediction.get(index)?.predictedOperationalMultiplier ?? 1, sourceMultiplier: (index) => sourcePrediction.get(index)?.predictedSourceMultiplier ?? 0, isSourceEligible: options.isSourceEligible, isWeaponEligible: options.isWeaponEligible })
    : dataRules().analyzeDataSupport(modules, physical.data.networks, catalogue, { sourceMultiplier: (index) => sourcePrediction.get(index)?.predictedSourceMultiplier ?? 0, isSourceEligible: options.isSourceEligible, isWeaponEligible: options.isWeaponEligible });
  const sources = support.sourceAllocations.map((source) => {
    const pred = sourcePrediction.get(source.sourceIndex) || { predictedPowerMultiplier: 0, predictedThermalMultiplier: 0, predictedOperationalMultiplier: 1, predictedSourceMultiplier: 0 };
    const status = pred.predictedPowerMultiplier <= 0 ? "unpowered" : pred.predictedThermalMultiplier <= 0 ? "overheated" : pred.predictedThermalMultiplier < 1 ? "thermally-reduced" : pred.predictedPowerMultiplier < 1 ? "underpowered" : source.status;
    const statusReason = status === "unpowered" ? "No operational Power supplies this Data source." : status === "underpowered" ? "Component Power demand exceeds generation." : status === "thermally-reduced" ? "Predicted heat reduces active output." : status === "overheated" ? "Predicted heat disables active output." : source.recipientCount ? `Predicted output is divided across ${useDirectLinks ? "directly linked" : "connected"} eligible weapons.` : "No eligible weapon recipients are linked.";
    return { ...source, ...pred, status, statusReason };
  });
  const sourceByIndex = Array(modules.length).fill(null); sources.forEach((s) => { sourceByIndex[s.sourceIndex] = s; });
  const weapons = support.weaponBonuses.map((weapon) => ({ ...weapon, baseProfile: { ...(partFor(catalogue, weapon.weaponType).weapon || {}) }, effectiveProfile: dataRules().effectiveWeaponProfile(partFor(catalogue, weapon.weaponType).weapon || {}, weapon), contributions: weapon.contributions.map((c) => ({ ...c, effect: sourceByIndex[c.sourceIndex]?.effect, nominalBudget: sourceByIndex[c.sourceIndex]?.nominalBudget || 0, sourceMultiplier: sourceByIndex[c.sourceIndex]?.sourceMultiplier || 0, effectiveBudget: sourceByIndex[c.sourceIndex]?.effectiveBudget || 0, recipientCount: sourceByIndex[c.sourceIndex]?.recipientCount || 0 })), statusReason: weapon.status === "supported" ? "Predicted Data support is applied to this weapon." : weapon.status === "connected-unsupported" ? "Operating at base stats; no active source contributes." : "Operating at base stats." }));
  const weaponByIndex = Array(modules.length).fill(null); weapons.forEach((w) => { weaponByIndex[w.weaponIndex] = w; });
  const label = useDirectLinks ? "direct-links" : (automatic ? "automatic" : "wired");
  return Object.freeze({ version: 1, mode: label, scenario: mode, scenarioLabel: scenarioName(mode), physical, thermalAnalysis, support, networks: support.networks || [], links: support.links || [], sources, weapons, sourceAllocationByIndex: sourceByIndex, weaponBonusByIndex: weaponByIndex, warnings: support.warnings || [], cableSectionCount: 0 });
}
export function getDesignSourceAllocation(analysis, sourceIndex) { return analysis?.sourceAllocationByIndex?.[sourceIndex] || null; }
export function getDesignWeaponSupport(analysis, weaponIndex) { return analysis?.weaponBonusByIndex?.[weaponIndex] || dataRules().weaponSupportForIndex(analysis?.support || {}, weaponIndex); }
export function getDesignEffectiveWeaponProfile(analysis, weaponIndex, catalogue) { const weapon = getDesignWeaponSupport(analysis, weaponIndex); return dataRules().effectiveWeaponProfile(partFor(catalogue, weapon.weaponType).weapon || {}, weapon); }

// Build the canonical cell/terminal graph once for the whole failure matrix.
// Each candidate then runs a small union pass over integer node ids instead of
// cloning, normalizing and sorting the entire Blueprint wiring graph again.
function buildDataFailureTopology(modules, wiring, catalogue) {
  const nodeByKey = new Map();
  const node = (key) => {
    if (!nodeByKey.has(key)) nodeByKey.set(key, nodeByKey.size);
    return nodeByKey.get(key);
  };
  const cellNode = (cell) => node(`c:${wiringRules().cellKey(cell.x, cell.y)}`);
  const sectionEdges = wiring.data.sections.map((section) => {
    const cells = wiringRules().sectionCells(section);
    return { section, a: cellNode(cells[0]), b: cellNode(cells[1]) };
  });
  const terminalLinks = [];
  const terminals = [];
  modules.forEach((module, index) => {
    const source = wiringRules().isDataSourceType(module?.type);
    const weapon = wiringRules().isDataTarget(module?.type, catalogue);
    if (!source && !weapon) return;
    const bus = node(`t:${index}`);
    wiringRules().moduleCells(module, catalogue).forEach((cell) => terminalLinks.push([bus, cellNode(cell)]));
    terminals.push({ index, bus, source, weapon });
  });
  return {
    without(removedSectionIds = []) {
      const removed = removedSectionIds instanceof Set ? removedSectionIds : new Set(removedSectionIds);
      const parent = Int16Array.from({ length: nodeByKey.size }, (_, index) => index);
      const find = (index) => {
        let root = index;
        while (parent[root] !== root) root = parent[root];
        while (parent[index] !== index) { const next = parent[index]; parent[index] = root; index = next; }
        return root;
      };
      const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
      terminalLinks.forEach(([a, b]) => union(a, b));
      sectionEdges.forEach((edge) => { if (!removed.has(edge.section.id)) union(edge.a, edge.b); });
      const groups = new Map();
      sectionEdges.forEach((edge) => {
        if (removed.has(edge.section.id)) return;
        const root = find(edge.a);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(edge.section);
      });
      const terminalGroups = new Map();
      terminals.forEach((terminal) => {
        const root = find(terminal.bus);
        if (!terminalGroups.has(root)) terminalGroups.set(root, []);
        terminalGroups.get(root).push(terminal);
      });
      return [...groups].map(([root, sections]) => {
        const connected = terminalGroups.get(find(root)) || [];
        const sectionIds = sections.map((section) => section.id).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        const sourceIndices = connected.filter((terminal) => terminal.source).map((terminal) => terminal.index).sort((a, b) => a - b);
        const weaponIndices = connected.filter((terminal) => terminal.weapon).map((terminal) => terminal.index).sort((a, b) => a - b);
        return {
          id: `data-${sectionIds[0]}`,
          label: `Data Network ${sectionIds[0]}`,
          sections,
          sectionIds,
          sourceIndices,
          weaponIndices,
          componentIndices: [...new Set([...sourceIndices, ...weaponIndices])].sort((a, b) => a - b)
        };
      }).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    }
  };
}

function analyzeFailureDataSupport(modules, networks, analysis, options = {}) {
  const operational = options.sourceOperationalMultiplier;
  const weapons = analysis.weapons.map((weapon) => ({
    weaponIndex: weapon.weaponIndex,
    weaponType: weapon.weaponType,
    rangeBonus: 0,
    accuracyBonus: 0,
    fireRateBonus: 0,
    sourceIndices: [],
    contributions: []
  }));
  const weaponBonusByIndex = Array(modules.length).fill(null);
  weapons.forEach((weapon) => { weaponBonusByIndex[weapon.weaponIndex] = weapon; });
  networks.forEach((network) => {
    network.sourceIndices.forEach((sourceIndex) => {
      const source = analysis.sourceAllocationByIndex?.[sourceIndex];
      if (!source) return;
      const eligible = new Set(source.eligibleWeaponIndices || source.connectedWeaponIndices || []);
      const recipients = network.weaponIndices.filter((weaponIndex) => eligible.has(weaponIndex));
      if (!recipients.length) return;
      let multiplier = source.predictedSourceMultiplier ?? source.sourceMultiplier ?? 0;
      if (typeof operational === "function") {
        const power = Number(source.predictedPowerMultiplier) || 0;
        const thermal = Number(source.predictedThermalMultiplier) || 0;
        multiplier = power * thermal * (Number(operational(sourceIndex, modules[sourceIndex])) || 0);
      }
      const amount = (Number(source.nominalBudget) || 0) * multiplier / recipients.length;
      recipients.forEach((weaponIndex) => {
        const weapon = weaponBonusByIndex[weaponIndex];
        if (!weapon) return;
        weapon.sourceIndices.push(sourceIndex);
        weapon.contributions.push({ sourceIndex, sourceType: source.sourceType, bonusField: source.bonusField, amount });
        weapon[source.bonusField] += amount;
      });
    });
  });
  return { networks, weapons, weaponBonusByIndex };
}
export function analyzeDataVulnerabilities(design, wiring, catalogue, analysis = analyzeDesignDataSupport(design, wiring, catalogue)) {
  const modules = modulesOf(design); const out = []; const beforeSig = topologySignature(analysis); const canonicalWiring = analysis.physical.wiring;
  const topology = buildDataFailureTopology(modules, canonicalWiring, catalogue);
  const compare = (kind, id, componentIndex, removedSectionIds = [], affectedSourceIndices = [], options = {}) => {
    // A Data cable/source failure does not change the design, Power network or
    // thermal prediction. Reuse those authoritative source multipliers and
    // recalculate only the filtered Data topology/allocation.
    const after = analyzeFailureDataSupport(modules, topology.without(removedSectionIds), analysis, options);
    const disconnectedWeaponIndices = analysis.weapons.filter((w) => (w.sourceIndices?.length || 0) && !(getDesignWeaponSupport(after, w.weaponIndex).sourceIndices || []).length).map((w) => w.weaponIndex);
    const losses = analysis.weapons.map((w) => { const l = bonusLoss(analysis, after, w.weaponIndex); const before = getDesignWeaponSupport(analysis, w.weaponIndex); l.weaponIndex = w.weaponIndex; l.allSupportLost = Boolean((before.sourceIndices||[]).length && !(getDesignWeaponSupport(after, w.weaponIndex).sourceIndices||[]).length); return l; });
    const total = losses.reduce((a, l) => ({ lostRangeBonus: a.lostRangeBonus + l.lostRangeBonus, lostAccuracyBonus: a.lostAccuracyBonus + l.lostAccuracyBonus, lostFireRateBonus: a.lostFireRateBonus + l.lostFireRateBonus }), { lostRangeBonus: 0, lostAccuracyBonus: 0, lostFireRateBonus: 0 });
    const severity = severityFor(losses, disconnectedWeaponIndices);
    out.push({ kind, id, componentIndex, topologyChanged: topologySignature(after) !== beforeSig, disconnectedWeaponIndices, affectedSourceIndices, losses: losses.filter(changedLoss), lostByWeapon: losses.filter(changedLoss), ...total, severity, summary: severity === "redundant" ? "Redundant route preserves predicted Data support." : `Loss affects ${losses.filter(changedLoss).length} weapon(s).` });
  };
  for (const section of canonicalWiring.data.sections) compare("section", section.id, null, [section.id]);
  const ownerByCell = new Map();
  modules.forEach((module, index) => wiringRules().moduleCells(module, catalogue).forEach((cell) => ownerByCell.set(wiringRules().cellKey(cell.x, cell.y), index)));
  const byHost = new Map();
  for (const section of canonicalWiring.data.sections) for (const cell of wiringRules().sectionCells(section)) { const idx = ownerByCell.get(wiringRules().cellKey(cell.x, cell.y)); if (idx !== undefined) { if (!byHost.has(idx)) byHost.set(idx, new Set()); byHost.get(idx).add(section.id); } }
  byHost.forEach((ids, idx) => compare("host", `host-${idx}`, idx, [...ids]));
  analysis.sources.forEach((s) => compare("source", `source-${s.sourceIndex}`, s.sourceIndex, [], [s.sourceIndex], { sourceOperationalMultiplier: (sourceIndex) => sourceIndex === s.sourceIndex ? 0 : 1 }));
  return out.sort((a, b) => String(a.kind).localeCompare(b.kind) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
}

const cacheCounters = { baseRuns: 0, vulnerabilityRuns: 0 };
let baseCache = null, vulnCache = null;
export function dataSupportDesignSignature(design, wiring, thermalLoadMode = "full", catalogueRevision = "", dataLinks = []) { return JSON.stringify({ design: modulesOf(design).map((m)=>m&&{type:m.type,x:m.x,y:m.y,rotation:m.rotation||0}), wiring, dataLinks, thermalLoadMode, catalogueRevision }); }
export function getCachedDesignDataSupport(design, wiring, catalogue, options = {}) { const sig = dataSupportDesignSignature(design, wiring, options.thermalLoadMode || options.scenario || "full", options.catalogueRevision || Object.keys(catalogue||{}).length, options.dataLinks); if (baseCache?.sig === sig) return baseCache.value; cacheCounters.baseRuns += 1; const value = analyzeDesignDataSupport(design, wiring, catalogue, options); baseCache = { sig, value }; return value; }
export function getCachedDataVulnerabilities(design, wiring, catalogue, analysis, options = {}) { const sig = dataSupportDesignSignature(design, wiring, analysis?.scenario || options.thermalLoadMode || "full", options.catalogueRevision || Object.keys(catalogue||{}).length, analysis?.links || options.dataLinks); if (vulnCache?.sig === sig) return vulnCache.value; cacheCounters.vulnerabilityRuns += 1; const value = analyzeDataVulnerabilities(design, wiring, catalogue, analysis); vulnCache = { sig, value }; return value; }
export function resetDataSupportAnalysisCaches() { baseCache = null; vulnCache = null; cacheCounters.baseRuns = 0; cacheCounters.vulnerabilityRuns = 0; }
export function getDataSupportAnalysisCacheCounters() { return { ...cacheCounters }; }
globalThis.DesignDataSupportAnalysis = { analyzeDesignDataSupport, getDesignSourceAllocation, getDesignWeaponSupport, getDesignEffectiveWeaponProfile, analyzeDataVulnerabilities, dataSupportDesignSignature, getCachedDesignDataSupport, getCachedDataVulnerabilities, resetDataSupportAnalysisCaches, getDataSupportAnalysisCacheCounters };
