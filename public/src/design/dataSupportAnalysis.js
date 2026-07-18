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
    const prediction = thermalAnalysis.predictions?.get?.(modulesOf(design)[index]);
    if (!prediction) return 1;
    return heatRules().activeOutputForState(prediction.state ?? heatRules().STATE.NORMAL);
  } catch (_error) { return 0; }
}
function cloneWiringWithout(wiring, remove) {
  const next = wiringRules().cloneWiring(wiring);
  const ids = new Set(remove.sectionIds || []);
  if (remove.sourceIndex != null) {
    next.data.sections = next.data.sections.filter((section) => !ids.has(wiringRules().segmentKey(section)));
  } else {
    next.data.sections = next.data.sections.filter((section) => !ids.has(wiringRules().segmentKey(section)));
  }
  next.data.connections = next.data.connections.filter((connection) => !connection.sectionIds.some((id) => ids.has(id)) && connection.sourceIndex !== remove.sourceIndex);
  return wiringRules().normalizeWiring(next, modulesOf(remove.design), remove.catalogue).wiring;
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
  const physical = wiringRules().analyzeWiring(modules, wiring, catalogue);
  const thermalAnalysis = thermalAnalysisFor(modules, physical.wiring, mode, options.thermalAnalysis);
  const sourcePrediction = new Map();
  modules.forEach((module, index) => {
    if (!dataRules().isDataSupportSource(module?.type)) return;
    const predictedPowerMultiplier = powerMultiplier(index, physical.power);
    const predictedThermalMultiplier = thermalMultiplier(index, modules, thermalAnalysis);
    const op = options.sourceOperationalMultiplier ?? options.operationalMultiplier;
    const predictedOperationalMultiplier = typeof op === "function" ? Number(op(index, module)) || 0 : op == null ? 1 : Number(op) || 0;
    sourcePrediction.set(index, { predictedPowerMultiplier, predictedThermalMultiplier, predictedOperationalMultiplier, predictedSourceMultiplier: predictedPowerMultiplier * predictedThermalMultiplier * predictedOperationalMultiplier });
  });
  const support = dataRules().analyzeDataSupport(modules, physical.data.networks, catalogue, { sourceMultiplier: (index) => sourcePrediction.get(index)?.predictedSourceMultiplier ?? 0, isSourceEligible: options.isSourceEligible, isWeaponEligible: options.isWeaponEligible });
  const sources = support.sourceAllocations.map((source) => {
    const pred = sourcePrediction.get(source.sourceIndex) || { predictedPowerMultiplier: 0, predictedThermalMultiplier: 0, predictedOperationalMultiplier: 1, predictedSourceMultiplier: 0 };
    const status = pred.predictedPowerMultiplier <= 0 ? "unpowered" : pred.predictedThermalMultiplier <= 0 ? "overheated" : pred.predictedThermalMultiplier < 1 ? "thermally-reduced" : pred.predictedPowerMultiplier < 1 ? "underpowered" : source.status;
    const statusReason = status === "unpowered" ? "No intact physical Power network supplies this Data source." : status === "underpowered" ? "Power network demand exceeds generation." : status === "thermally-reduced" ? "Predicted heat reduces active output." : status === "overheated" ? "Predicted heat disables active output." : source.recipientCount ? "Predicted output is divided across connected eligible weapons." : "No eligible weapon recipients on this Data network.";
    return { ...source, ...pred, status, statusReason };
  });
  const sourceByIndex = Array(modules.length).fill(null); sources.forEach((s) => { sourceByIndex[s.sourceIndex] = s; });
  const weapons = support.weaponBonuses.map((weapon) => ({ ...weapon, baseProfile: { ...(partFor(catalogue, weapon.weaponType).weapon || {}) }, effectiveProfile: dataRules().effectiveWeaponProfile(partFor(catalogue, weapon.weaponType).weapon || {}, weapon), contributions: weapon.contributions.map((c) => ({ ...c, effect: sourceByIndex[c.sourceIndex]?.effect, nominalBudget: sourceByIndex[c.sourceIndex]?.nominalBudget || 0, sourceMultiplier: sourceByIndex[c.sourceIndex]?.sourceMultiplier || 0, effectiveBudget: sourceByIndex[c.sourceIndex]?.effectiveBudget || 0, recipientCount: sourceByIndex[c.sourceIndex]?.recipientCount || 0 })), statusReason: weapon.status === "supported" ? "Predicted Data support is applied to this weapon." : weapon.status === "connected-unsupported" ? "Operating at base stats; no active source contributes." : "Operating at base stats." }));
  const weaponByIndex = Array(modules.length).fill(null); weapons.forEach((w) => { weaponByIndex[w.weaponIndex] = w; });
  return Object.freeze({ version: 1, scenario: mode, scenarioLabel: scenarioName(mode), physical, thermalAnalysis, support, networks: support.networks, sources, weapons, sourceAllocationByIndex: sourceByIndex, weaponBonusByIndex: weaponByIndex, warnings: support.warnings, cableSectionCount: wiringRules().countUniqueSections(physical.wiring, "data") });
}
export function getDesignSourceAllocation(analysis, sourceIndex) { return analysis?.sourceAllocationByIndex?.[sourceIndex] || null; }
export function getDesignWeaponSupport(analysis, weaponIndex) { return analysis?.weaponBonusByIndex?.[weaponIndex] || dataRules().weaponSupportForIndex(analysis?.support || {}, weaponIndex); }
export function getDesignEffectiveWeaponProfile(analysis, weaponIndex, catalogue) { const weapon = getDesignWeaponSupport(analysis, weaponIndex); return dataRules().effectiveWeaponProfile(partFor(catalogue, weapon.weaponType).weapon || {}, weapon); }
export function analyzeDataVulnerabilities(design, wiring, catalogue, analysis = analyzeDesignDataSupport(design, wiring, catalogue)) {
  const modules = modulesOf(design); const out = []; const beforeSig = topologySignature(analysis);
  const compare = (kind, id, componentIndex, failedWiring, affectedSourceIndices = [], options = {}) => {
    const after = analyzeDesignDataSupport(modules, failedWiring, catalogue, { thermalLoadMode: analysis.scenario, sourceOperationalMultiplier: options.sourceOperationalMultiplier });
    const disconnectedWeaponIndices = analysis.weapons.filter((w) => (w.sourceIndices?.length || 0) && !(getDesignWeaponSupport(after, w.weaponIndex).sourceIndices || []).length).map((w) => w.weaponIndex);
    const losses = analysis.weapons.map((w) => { const l = bonusLoss(analysis, after, w.weaponIndex); const before = getDesignWeaponSupport(analysis, w.weaponIndex); l.weaponIndex = w.weaponIndex; l.allSupportLost = Boolean((before.sourceIndices||[]).length && !(getDesignWeaponSupport(after, w.weaponIndex).sourceIndices||[]).length); return l; });
    const total = losses.reduce((a, l) => ({ lostRangeBonus: a.lostRangeBonus + l.lostRangeBonus, lostAccuracyBonus: a.lostAccuracyBonus + l.lostAccuracyBonus, lostFireRateBonus: a.lostFireRateBonus + l.lostFireRateBonus }), { lostRangeBonus: 0, lostAccuracyBonus: 0, lostFireRateBonus: 0 });
    const severity = severityFor(losses, disconnectedWeaponIndices);
    out.push({ kind, id, componentIndex, topologyChanged: topologySignature(after) !== beforeSig, disconnectedWeaponIndices, affectedSourceIndices, losses: losses.filter(changedLoss), lostByWeapon: losses.filter(changedLoss), ...total, severity, summary: severity === "redundant" ? "Redundant route preserves predicted Data support." : `Loss affects ${losses.filter(changedLoss).length} weapon(s).` });
  };
  for (const section of analysis.physical.wiring.data.sections) compare("section", section.id, null, cloneWiringWithout(wiring, { design: modules, catalogue, sectionIds: [section.id] }));
  const byHost = new Map();
  for (const section of analysis.physical.wiring.data.sections) for (const cell of wiringRules().sectionCells(section)) { const idx = modules.findIndex((m, i) => wiringRules().moduleCells(m, catalogue).some((c) => c.x === cell.x && c.y === cell.y)); if (idx >= 0) { if (!byHost.has(idx)) byHost.set(idx, new Set()); byHost.get(idx).add(section.id); } }
  byHost.forEach((ids, idx) => compare("host", `host-${idx}`, idx, cloneWiringWithout(wiring, { design: modules, catalogue, sectionIds: [...ids] })));
  analysis.sources.forEach((s) => compare("source", `source-${s.sourceIndex}`, s.sourceIndex, wiring, [s.sourceIndex], { sourceOperationalMultiplier: (sourceIndex) => sourceIndex === s.sourceIndex ? 0 : 1 }));
  return out.sort((a, b) => String(a.kind).localeCompare(b.kind) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
}

const cacheCounters = { baseRuns: 0, vulnerabilityRuns: 0 };
let baseCache = null, vulnCache = null;
export function dataSupportDesignSignature(design, wiring, thermalLoadMode = "full", catalogueRevision = "") { return JSON.stringify({ design: modulesOf(design).map((m)=>m&&{type:m.type,x:m.x,y:m.y,rotation:m.rotation||0}), wiring, thermalLoadMode, catalogueRevision }); }
export function getCachedDesignDataSupport(design, wiring, catalogue, options = {}) { const sig = dataSupportDesignSignature(design, wiring, options.thermalLoadMode || options.scenario || "full", options.catalogueRevision || Object.keys(catalogue||{}).length); if (baseCache?.sig === sig) return baseCache.value; cacheCounters.baseRuns += 1; const value = analyzeDesignDataSupport(design, wiring, catalogue, options); baseCache = { sig, value }; return value; }
export function getCachedDataVulnerabilities(design, wiring, catalogue, analysis, options = {}) { const sig = dataSupportDesignSignature(design, wiring, analysis?.scenario || options.thermalLoadMode || "full", options.catalogueRevision || Object.keys(catalogue||{}).length); if (vulnCache?.sig === sig) return vulnCache.value; cacheCounters.vulnerabilityRuns += 1; const value = analyzeDataVulnerabilities(design, wiring, catalogue, analysis); vulnCache = { sig, value }; return value; }
export function resetDataSupportAnalysisCaches() { baseCache = null; vulnCache = null; cacheCounters.baseRuns = 0; cacheCounters.vulnerabilityRuns = 0; }
export function getDataSupportAnalysisCacheCounters() { return { ...cacheCounters }; }
globalThis.DesignDataSupportAnalysis = { analyzeDesignDataSupport, getDesignSourceAllocation, getDesignWeaponSupport, getDesignEffectiveWeaponProfile, analyzeDataVulnerabilities, dataSupportDesignSignature, getCachedDesignDataSupport, getCachedDataVulnerabilities, resetDataSupportAnalysisCaches, getDataSupportAnalysisCacheCounters };
