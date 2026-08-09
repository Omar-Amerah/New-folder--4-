// Designer-side Data-support prediction for explicit Data Links.
//
// Data support has one authority here: normalized source -> weapon links. The
// physical routing is deliberately not consulted. Power and Heat remain
// component-state inputs, supplied by the caller as multipliers or predicted
// state; neither can create, remove, or reroute a Data Link.

function dataRules() { return globalThis.DataSupportRules; }
function heatRules() { return globalThis.HeatRules; }
const modulesOf = (design) => Array.isArray(design) ? design : Array.isArray(design?.components) ? design.components : [];
const partFor = (catalogue, type) => catalogue?.[type] || {};
const scenarioName = (mode) => ({ idle: "Idle", combat: "Typical Combat", full: "Maximum Sustained Load" }[mode] || mode || "Maximum Sustained Load");

function thermalAnalysisFor(design, mode, injected, dataLinks) {
  if (injected) return injected;
  const analyze = globalThis.DesignThermalAnalysis?.analyzeDesignHeat || globalThis.analyzeDesignHeat;
  if (typeof analyze !== "function") return null;
  try { return analyze(design, dataLinks || [], mode || "full"); }
  catch (_error) { return null; }
}

function thermalMultiplier(index, design, thermalAnalysis) {
  try {
    if (!thermalAnalysis) return 1;
    const prediction = thermalAnalysis.predictions?.get?.(modulesOf(design)[index])
      || (thermalAnalysis.predictions ? [...thermalAnalysis.predictions.values()][index] : null);
    if (!prediction) return 1;
    const rules = heatRules();
    return rules?.activeOutputForState
      ? rules.activeOutputForState(prediction.state ?? rules.STATE.NORMAL)
      : 1;
  } catch (_error) { return 1; }
}

function optionMultiplier(option, fallback, index, module, part) {
  const raw = typeof option === "function"
    ? option(index, module, part)
    : option == null ? fallback : option;
  return dataRules().normalizeSourceMultiplier(raw);
}

function bonusLoss(before, after, weaponIndex) {
  const a = getDesignWeaponSupport(before, weaponIndex);
  const b = getDesignWeaponSupport(after, weaponIndex);
  return {
    lostRangeBonus: Math.max(0, (a.rangeBonus || 0) - (b.rangeBonus || 0)),
    lostAccuracyBonus: Math.max(0, (a.accuracyBonus || 0) - (b.accuracyBonus || 0)),
    lostFireRateBonus: Math.max(0, (a.fireRateBonus || 0) - (b.fireRateBonus || 0))
  };
}

function changedLoss(loss) {
  return (loss.lostRangeBonus || 0) > 1e-9
    || (loss.lostAccuracyBonus || 0) > 1e-9
    || (loss.lostFireRateBonus || 0) > 1e-9;
}

function severityFor(losses, disconnected) {
  const affected = losses.filter(changedLoss).length;
  const allLost = losses.filter((loss) => loss.allSupportLost).length;
  if (!disconnected.length && !affected) return "redundant";
  if (disconnected.length >= 2 || allLost >= 2) return "critical";
  if (disconnected.length === 1 || allLost === 1 || affected >= 3) return "high";
  if (affected) return "medium";
  return "low";
}

function directLinkSignature(analysis) {
  const links = (analysis?.links || [])
    .map((link) => String(link.sourceIndex) + ":" + String(link.targetIndex))
    .sort();
  const weapons = (analysis?.weapons || [])
    .map((weapon) => String(weapon.weaponIndex) + "<" + (weapon.sourceIndices || []).join(","))
    .sort();
  return links.join(",") + "#" + weapons.join(";");
}

function hasActiveSupport(weapon) {
  return (weapon?.contributions || []).some((contribution) => Number(contribution.amount) !== 0);
}

export function analyzeDesignDataSupport(design, catalogue, options = {}) {
  const modules = modulesOf(design);
  const mode = options.thermalLoadMode || options.scenario || "full";
  const links = dataRules().normalizeDataLinks(modules, options.dataLinks, catalogue);
  const thermalAnalysis = thermalAnalysisFor(modules, mode, options.thermalAnalysis, links);
  const sourcePrediction = new Map();

  modules.forEach((module, index) => {
    if (!dataRules().isDataSupportSource(module?.type)) return;
    const part = partFor(catalogue, module.type);
    const prediction = thermalAnalysis?.predictions?.get?.(module)
      || (thermalAnalysis?.predictions ? [...thermalAnalysis.predictions.values()][index] : null);
    const predictedPowerMultiplier = optionMultiplier(
      options.sourcePowerMultiplier,
      1,
      index,
      module,
      part
    );
    const predictedThermalMultiplier = optionMultiplier(
      options.sourceThermalMultiplier,
      thermalMultiplier(index, modules, thermalAnalysis),
      index,
      module,
      part
    );
    const operational = options.sourceOperationalMultiplier ?? options.operationalMultiplier;
    const predictedOperationalMultiplier = optionMultiplier(operational, 1, index, module, part);
    sourcePrediction.set(index, {
      predictedPowerMultiplier,
      predictedThermalMultiplier,
      predictedOperationalMultiplier,
      predictedSourceMultiplier: predictedPowerMultiplier * predictedThermalMultiplier * predictedOperationalMultiplier,
      predictedState: prediction?.state
    });
  });

  const support = dataRules().analyzeDirectDataSupport(modules, links, catalogue, {
    powerMultiplier: (index) => sourcePrediction.get(index)?.predictedPowerMultiplier ?? 1,
    thermalMultiplier: (index) => sourcePrediction.get(index)?.predictedThermalMultiplier ?? 1,
    operationalMultiplier: (index) => sourcePrediction.get(index)?.predictedOperationalMultiplier ?? 1,
    sourceMultiplier: (index) => sourcePrediction.get(index)?.predictedSourceMultiplier ?? 0,
    isSourceEligible: options.isSourceEligible,
    isWeaponEligible: options.isWeaponEligible
  });

  const sources = support.sourceAllocations.map((source) => {
    const prediction = sourcePrediction.get(source.sourceIndex) || {
      predictedPowerMultiplier: 0,
      predictedThermalMultiplier: 0,
      predictedOperationalMultiplier: 0,
      predictedSourceMultiplier: 0
    };
    let status = source.status;
    if (prediction.predictedOperationalMultiplier <= 0) status = "destroyed";
    else if (prediction.predictedPowerMultiplier <= 0) status = "unpowered";
    else if (prediction.predictedThermalMultiplier <= 0) status = "overheated";
    else if (prediction.predictedThermalMultiplier < 1) status = "thermally-reduced";
    else if (prediction.predictedPowerMultiplier < 1) status = "underpowered";
    const statusReason = status === "destroyed"
      ? "Source component is destroyed."
      : status === "unpowered"
        ? "No operational Power supplies this Data source."
        : status === "underpowered"
          ? "Component Power demand exceeds generation."
          : status === "thermally-reduced"
            ? "Predicted heat reduces active output."
            : status === "overheated"
              ? "Predicted heat disables active output."
              : source.recipientCount
                ? "Output is divided across " + source.recipientCount + " directly linked eligible weapon" + (source.recipientCount === 1 ? "" : "s") + "."
                : "No eligible weapon recipients are linked.";
    return { ...source, ...prediction, status, statusReason };
  });
  const sourceByIndex = Array(modules.length).fill(null);
  sources.forEach((source) => { sourceByIndex[source.sourceIndex] = source; });

  const weapons = support.weaponBonuses.map((weapon) => ({
    ...weapon,
    baseProfile: { ...(partFor(catalogue, weapon.weaponType).weapon || {}) },
    effectiveProfile: dataRules().effectiveWeaponProfile(partFor(catalogue, weapon.weaponType).weapon || {}, weapon),
    contributions: weapon.contributions.map((contribution) => ({
      ...contribution,
      effect: sourceByIndex[contribution.sourceIndex]?.effect,
      nominalBudget: sourceByIndex[contribution.sourceIndex]?.nominalBudget || 0,
      sourceMultiplier: sourceByIndex[contribution.sourceIndex]?.sourceMultiplier || 0,
      effectiveBudget: sourceByIndex[contribution.sourceIndex]?.effectiveBudget || 0,
      recipientCount: sourceByIndex[contribution.sourceIndex]?.recipientCount || 0
    })),
    statusReason: weapon.status === "supported"
      ? "Predicted Data support is applied to this weapon."
      : weapon.status === "connected-unsupported"
        ? "Operating at base stats; no active source contributes."
        : "Operating at base stats."
  }));
  const weaponByIndex = Array(modules.length).fill(null);
  weapons.forEach((weapon) => { weaponByIndex[weapon.weaponIndex] = weapon; });

  return Object.freeze({
    version: 1,
    mode: "direct-links",
    scenario: mode,
    scenarioLabel: scenarioName(mode),
    thermalAnalysis,
    support,
    links: support.links || links,
    sources,
    weapons,
    sourceAllocationByIndex: sourceByIndex,
    weaponBonusByIndex: weaponByIndex,
    warnings: support.warnings || []
  });
}

export function getDesignSourceAllocation(analysis, sourceIndex) {
  return analysis?.sourceAllocationByIndex?.[sourceIndex] || null;
}

export function getDesignWeaponSupport(analysis, weaponIndex) {
  return analysis?.weaponBonusByIndex?.[weaponIndex]
    || dataRules().weaponSupportForIndex(analysis?.support || {}, weaponIndex);
}

export function getDesignEffectiveWeaponProfile(analysis, weaponIndex, catalogue) {
  const weapon = getDesignWeaponSupport(analysis, weaponIndex);
  return dataRules().effectiveWeaponProfile(partFor(catalogue, weapon.weaponType).weapon || {}, weapon);
}

function failureAnalysisOptions(analysis, failedSourceIndex) {
  const sourceByIndex = new Map((analysis?.sources || []).map((source) => [source.sourceIndex, source]));
  return {
    dataLinks: analysis?.links || [],
    thermalAnalysis: analysis?.thermalAnalysis,
    sourcePowerMultiplier: (index) => index === failedSourceIndex ? 0 : sourceByIndex.get(index)?.predictedPowerMultiplier ?? 1,
    sourceThermalMultiplier: (index) => sourceByIndex.get(index)?.predictedThermalMultiplier ?? 1,
    sourceOperationalMultiplier: (index) => index === failedSourceIndex ? 0 : sourceByIndex.get(index)?.predictedOperationalMultiplier ?? 1
  };
}

export function analyzeDataVulnerabilities(design, catalogue, analysis = analyzeDesignDataSupport(design, catalogue)) {
  const modules = modulesOf(design);
  const before = analysis || analyzeDesignDataSupport(modules, catalogue);
  const beforeSignature = directLinkSignature(before);
  const out = [];

  // Direct links have no route graph to fail. The useful
  // failure question is which source's fixed budget disappears when that
  // source is destroyed; Power and Heat reductions are already represented by
  // the source multipliers in the base analysis.
  for (const source of before.sources || []) {
    const after = analyzeDesignDataSupport(modules, catalogue, failureAnalysisOptions(before, source.sourceIndex));
    const disconnectedWeaponIndices = before.weapons
      .filter((weapon) => hasActiveSupport(weapon)
        && !hasActiveSupport(getDesignWeaponSupport(after, weapon.weaponIndex)))
      .map((weapon) => weapon.weaponIndex);
    const losses = before.weapons.map((weapon) => {
      const loss = bonusLoss(before, after, weapon.weaponIndex);
      const previous = getDesignWeaponSupport(before, weapon.weaponIndex);
      const next = getDesignWeaponSupport(after, weapon.weaponIndex);
      loss.weaponIndex = weapon.weaponIndex;
      loss.allSupportLost = Boolean(hasActiveSupport(previous) && !hasActiveSupport(next));
      return loss;
    });
    const total = losses.reduce((sum, loss) => ({
      lostRangeBonus: sum.lostRangeBonus + loss.lostRangeBonus,
      lostAccuracyBonus: sum.lostAccuracyBonus + loss.lostAccuracyBonus,
      lostFireRateBonus: sum.lostFireRateBonus + loss.lostFireRateBonus
    }), { lostRangeBonus: 0, lostAccuracyBonus: 0, lostFireRateBonus: 0 });
    const severity = severityFor(losses, disconnectedWeaponIndices);
    out.push({
      kind: "source",
      id: "source-" + source.sourceIndex,
      componentIndex: source.sourceIndex,
      linkChanged: directLinkSignature(after) !== beforeSignature,
      disconnectedWeaponIndices,
      affectedSourceIndices: [source.sourceIndex],
      losses: losses.filter(changedLoss),
      lostByWeapon: losses.filter(changedLoss),
      ...total,
      severity,
      summary: severity === "redundant"
        ? "Source failure does not reduce predicted Data support."
        : "Source failure affects " + losses.filter(changedLoss).length + " weapon" + (losses.filter(changedLoss).length === 1 ? "" : "s") + "."
    });
  }
  return out.sort((a, b) => a.componentIndex - b.componentIndex);
}

const cacheCounters = { baseRuns: 0, vulnerabilityRuns: 0 };
let baseCache = null;
let vulnCache = null;

export function dataSupportDesignSignature(design, thermalLoadMode = "full", catalogueRevision = "", dataLinks = []) {
  return JSON.stringify({
    design: modulesOf(design).map((module) => module && {
      type: module.type,
      x: module.x,
      y: module.y,
      rotation: module.rotation || 0
    }),
    dataLinks,
    thermalLoadMode,
    catalogueRevision
  });
}

export function getCachedDesignDataSupport(design, catalogue, options = {}) {
  const signature = dataSupportDesignSignature(
    design,
    options.thermalLoadMode || options.scenario || "full",
    options.catalogueRevision || Object.keys(catalogue || {}).length,
    options.dataLinks
  );
  if (baseCache?.signature === signature) return baseCache.value;
  cacheCounters.baseRuns += 1;
  const value = analyzeDesignDataSupport(design, catalogue, options);
  baseCache = { signature, value };
  return value;
}

export function getCachedDataVulnerabilities(design, catalogue, analysis, options = {}) {
  const links = analysis?.links ?? options.dataLinks ?? [];
  const signature = dataSupportDesignSignature(
    design,
    analysis?.scenario || options.thermalLoadMode || "full",
    options.catalogueRevision || Object.keys(catalogue || {}).length,
    links
  );
  if (vulnCache?.signature === signature) return vulnCache.value;
  cacheCounters.vulnerabilityRuns += 1;
  const value = analyzeDataVulnerabilities(design, catalogue, analysis);
  vulnCache = { signature, value };
  return value;
}

export function resetDataSupportAnalysisCaches() {
  baseCache = null;
  vulnCache = null;
  cacheCounters.baseRuns = 0;
  cacheCounters.vulnerabilityRuns = 0;
}

export function getDataSupportAnalysisCacheCounters() { return { ...cacheCounters }; }

globalThis.DesignDataSupportAnalysis = {
  analyzeDesignDataSupport,
  getDesignSourceAllocation,
  getDesignWeaponSupport,
  getDesignEffectiveWeaponProfile,
  analyzeDataVulnerabilities,
  dataSupportDesignSignature,
  getCachedDesignDataSupport,
  getCachedDataVulnerabilities,
  resetDataSupportAnalysisCaches,
  getDataSupportAnalysisCacheCounters
};
