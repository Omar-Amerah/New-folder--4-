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
function thermalMultiplier(index, design, wiring, mode) {
  try {
    const analyze = globalThis.DesignThermalAnalysis?.analyzeDesignHeat || globalThis.analyzeDesignHeat;
    if (typeof analyze !== "function") return 1;
    const prediction = analyze(design, wiring, mode || "full")?.predictions?.get?.(modulesOf(design)[index]);
    return heatRules().activeOutputForState(prediction?.state ?? heatRules().STATE.NORMAL);
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
function severityFor(losses, disconnected) {
  const total = losses.reduce((s, l) => s + l.lostRangeBonus + l.lostAccuracyBonus + l.lostFireRateBonus, 0);
  if (!disconnected.length && total === 0) return "redundant";
  if (disconnected.length >= 2 || total >= 0.1) return "critical";
  if (disconnected.length || total >= 0.04) return "high";
  if (total > 0) return "medium";
  return "low";
}
export function analyzeDesignDataSupport(design, wiring, catalogue, options = {}) {
  const modules = modulesOf(design); const mode = options.thermalLoadMode || options.scenario || "full";
  const physical = wiringRules().analyzeWiring(modules, wiring, catalogue);
  const sourcePrediction = new Map();
  modules.forEach((module, index) => {
    if (!dataRules().isDataSupportSource(module?.type)) return;
    const predictedPowerMultiplier = powerMultiplier(index, physical.power);
    const predictedThermalMultiplier = thermalMultiplier(index, modules, physical.wiring, mode);
    const predictedOperationalMultiplier = options.operationalMultiplier == null ? 1 : Number(options.operationalMultiplier) || 0;
    sourcePrediction.set(index, { predictedPowerMultiplier, predictedThermalMultiplier, predictedOperationalMultiplier, predictedSourceMultiplier: predictedPowerMultiplier * predictedThermalMultiplier * predictedOperationalMultiplier });
  });
  const support = dataRules().analyzeDataSupport(modules, physical.data.networks, catalogue, { sourceMultiplier: (index) => sourcePrediction.get(index)?.predictedSourceMultiplier ?? 0 });
  const sources = support.sourceAllocations.map((source) => {
    const pred = sourcePrediction.get(source.sourceIndex) || { predictedPowerMultiplier: 0, predictedThermalMultiplier: 0, predictedOperationalMultiplier: 1, predictedSourceMultiplier: 0 };
    const status = pred.predictedPowerMultiplier <= 0 ? "unpowered" : pred.predictedThermalMultiplier <= 0 ? "overheated" : pred.predictedThermalMultiplier < 1 ? "thermally-reduced" : pred.predictedPowerMultiplier < 1 ? "underpowered" : source.status;
    const statusReason = status === "unpowered" ? "No intact physical Power network supplies this Data source." : status === "underpowered" ? "Power network demand exceeds generation." : status === "thermally-reduced" ? "Predicted heat reduces active output." : status === "overheated" ? "Predicted heat disables active output." : source.recipientCount ? "Predicted output is divided across connected eligible weapons." : "No eligible weapon recipients on this Data network.";
    return { ...source, ...pred, status, statusReason };
  });
  const sourceByIndex = Array(modules.length).fill(null); sources.forEach((s) => { sourceByIndex[s.sourceIndex] = s; });
  const weapons = support.weaponBonuses.map((weapon) => ({ ...weapon, baseProfile: { ...(partFor(catalogue, weapon.weaponType).weapon || {}) }, effectiveProfile: dataRules().effectiveWeaponProfile(partFor(catalogue, weapon.weaponType).weapon || {}, weapon), contributions: weapon.contributions.map((c) => ({ ...c, effect: sourceByIndex[c.sourceIndex]?.effect, nominalBudget: sourceByIndex[c.sourceIndex]?.nominalBudget || 0, sourceMultiplier: sourceByIndex[c.sourceIndex]?.sourceMultiplier || 0, effectiveBudget: sourceByIndex[c.sourceIndex]?.effectiveBudget || 0, recipientCount: sourceByIndex[c.sourceIndex]?.recipientCount || 0 })), statusReason: weapon.status === "supported" ? "Predicted Data support is applied to this weapon." : weapon.status === "connected-unsupported" ? "Operating at base stats; no active source contributes." : "Operating at base stats." }));
  const weaponByIndex = Array(modules.length).fill(null); weapons.forEach((w) => { weaponByIndex[w.weaponIndex] = w; });
  return { version: 1, scenario: mode, scenarioLabel: scenarioName(mode), physical, support, networks: support.networks, sources, weapons, sourceAllocationByIndex: sourceByIndex, weaponBonusByIndex: weaponByIndex, warnings: support.warnings, cableSectionCount: wiringRules().countUniqueSections(physical.wiring, "data") };
}
export function getDesignSourceAllocation(analysis, sourceIndex) { return analysis?.sourceAllocationByIndex?.[sourceIndex] || null; }
export function getDesignWeaponSupport(analysis, weaponIndex) { return analysis?.weaponBonusByIndex?.[weaponIndex] || dataRules().weaponSupportForIndex(analysis?.support || {}, weaponIndex); }
export function getDesignEffectiveWeaponProfile(analysis, weaponIndex, catalogue) { const weapon = getDesignWeaponSupport(analysis, weaponIndex); return dataRules().effectiveWeaponProfile(partFor(catalogue, weapon.weaponType).weapon || {}, weapon); }
export function analyzeDataVulnerabilities(design, wiring, catalogue, analysis = analyzeDesignDataSupport(design, wiring, catalogue)) {
  const modules = modulesOf(design); const out = [];
  const compare = (kind, id, componentIndex, failedWiring, affectedSourceIndices = []) => {
    const after = analyzeDesignDataSupport(modules, failedWiring, catalogue, { thermalLoadMode: analysis.scenario });
    const disconnectedWeaponIndices = analysis.weapons.filter((w) => (w.sourceIndices?.length || 0) && !(getDesignWeaponSupport(after, w.weaponIndex).sourceIndices || []).length).map((w) => w.weaponIndex);
    const losses = analysis.weapons.map((w) => bonusLoss(analysis, after, w.weaponIndex));
    const total = losses.reduce((a, l) => ({ lostRangeBonus: a.lostRangeBonus + l.lostRangeBonus, lostAccuracyBonus: a.lostAccuracyBonus + l.lostAccuracyBonus, lostFireRateBonus: a.lostFireRateBonus + l.lostFireRateBonus }), { lostRangeBonus: 0, lostAccuracyBonus: 0, lostFireRateBonus: 0 });
    const severity = severityFor(losses, disconnectedWeaponIndices);
    out.push({ kind, id, componentIndex, topologyChanged: after.networks.length !== analysis.networks.length, disconnectedWeaponIndices, affectedSourceIndices, ...total, severity, summary: severity === "redundant" ? "Redundant route preserves predicted Data support." : `Loss affects ${disconnectedWeaponIndices.length} weapon(s).` });
  };
  for (const section of analysis.physical.wiring.data.sections) compare("section", section.id, null, cloneWiringWithout(wiring, { design: modules, catalogue, sectionIds: [section.id] }));
  const byHost = new Map();
  for (const section of analysis.physical.wiring.data.sections) for (const cell of wiringRules().sectionCells(section)) { const idx = modules.findIndex((m, i) => wiringRules().moduleCells(m, catalogue).some((c) => c.x === cell.x && c.y === cell.y)); if (idx >= 0) { if (!byHost.has(idx)) byHost.set(idx, new Set()); byHost.get(idx).add(section.id); } }
  byHost.forEach((ids, idx) => compare("host", `host-${idx}`, idx, cloneWiringWithout(wiring, { design: modules, catalogue, sectionIds: [...ids] })));
  analysis.sources.forEach((s) => compare("source", `source-${s.sourceIndex}`, s.sourceIndex, cloneWiringWithout(wiring, { design: modules, catalogue, sectionIds: [], sourceIndex: s.sourceIndex }), [s.sourceIndex]));
  return out.sort((a, b) => String(a.kind).localeCompare(b.kind) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
}
globalThis.DesignDataSupportAnalysis = { analyzeDesignDataSupport, getDesignSourceAllocation, getDesignWeaponSupport, getDesignEffectiveWeaponProfile, analyzeDataVulnerabilities };
