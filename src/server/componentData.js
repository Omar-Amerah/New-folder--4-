// Authoritative runtime Data-support integration for weapon components.
// State here is derived from the immutable ship design plus Wiring v2 blueprint;
// it is intentionally not persisted into saved blueprints.

const { PARTS } = require("./components");
const WiringRules = require("../../public/src/shared/wiringRules");
const DataSupportRules = require("../../public/src/shared/dataSupportRules");
const HeatRules = require("../../public/src/shared/heatRules");

const ZERO_SUPPORT = Object.freeze({ rangeBonus: 0, accuracyBonus: 0, fireRateBonus: 0, sourceIndices: Object.freeze([]), contributions: Object.freeze([]), status: "disconnected" });
const numericSort = (a, b) => a - b;
const stable = (value) => JSON.stringify(value, (_key, item) => (item instanceof Set ? [...item].sort() : item));
const perf = () => global.__mfaDataSupportPerf || null;
function bump(name) { const p = perf(); if (p) p[name] = (p[name] || 0) + 1; }

function cloneSupport(record, weaponIndex) {
  if (!record || typeof record !== "object") return { weaponIndex, ...ZERO_SUPPORT, sourceIndices: [], contributions: [] };
  return { ...record, weaponIndex: Number.isInteger(record.weaponIndex) ? record.weaponIndex : weaponIndex,
    rangeBonus: Number.isFinite(Number(record.rangeBonus)) ? Number(record.rangeBonus) : 0,
    accuracyBonus: Number.isFinite(Number(record.accuracyBonus)) ? Number(record.accuracyBonus) : 0,
    fireRateBonus: Number.isFinite(Number(record.fireRateBonus)) ? Number(record.fireRateBonus) : 0,
    sourceIndices: Array.isArray(record.sourceIndices) ? [...record.sourceIndices] : [],
    contributions: Array.isArray(record.contributions) ? record.contributions.map((entry) => ({ ...entry })) : [] };
}
function cloneAllocation(record, sourceIndex) {
  if (!record || typeof record !== "object") return null;
  return { ...record, sourceIndex: Number.isInteger(record.sourceIndex) ? record.sourceIndex : sourceIndex,
    connectedWeaponIndices: Array.isArray(record.connectedWeaponIndices) ? [...record.connectedWeaponIndices] : [],
    eligibleWeaponIndices: Array.isArray(record.eligibleWeaponIndices) ? [...record.eligibleWeaponIndices] : [] };
}
function isAlive(ship, index) { return (ship?.componentHp?.[index] ?? 1) > 0; }
function sourcePowerMultiplier(ship, sourceIndex) {
  const record = ship?.componentPower?.byComponentIndex?.[sourceIndex];
  const value = record?.operationalMultiplier;
  // Section 6C must respect the authoritative per-component Power runtime.
  // Missing or invalid runtime Power state fails safely instead of inferring
  // implicit full output from blueprint shape or legacy/no-cable designs.
  return DataSupportRules.normalizeSourceMultiplier(Number.isFinite(value) ? value : 0);
}
function sourceThermalMultiplier(ship, sourceIndex) { return DataSupportRules.normalizeSourceMultiplier(HeatRules.activeOutputForState(ship?.componentHeatState?.[sourceIndex] ?? HeatRules.STATE.NORMAL)); }
function sourceOperationalMultiplier(ship, sourceIndex) { return isAlive(ship, sourceIndex) ? 1 : 0; }
function sourceMultiplier(ship, sourceIndex) { return DataSupportRules.normalizeSourceMultiplier(sourcePowerMultiplier(ship, sourceIndex) * sourceThermalMultiplier(ship, sourceIndex) * sourceOperationalMultiplier(ship, sourceIndex)); }
function isDataWeaponEligible(ship, weaponIndex) { return isAlive(ship, weaponIndex); }
function isDataSourceEligible(ship, sourceIndex) { return DataSupportRules.isDataSupportSource(ship?.design?.[sourceIndex]?.type); }

function runtimeWiringFor(ship) {
  if (ship?.runtimeWiring) return { version: WiringRules.WIRING_VERSION, power: ship.runtimeWiring.power?.operationalWiring, data: ship.runtimeWiring.data?.operationalWiring };
  return ship?.wiring;
}
function analyzeTopology(ship, precomputedDataNetworks = null) {
  const design = Array.isArray(ship?.design) ? ship.design : [];
  if (!design.length) return { networks: [] };
  if (Array.isArray(precomputedDataNetworks)) return { networks: precomputedDataNetworks };
  bump("wiringAnalysisCount");
  return WiringRules.analyzeWiring(design, runtimeWiringFor(ship), PARTS).data || { networks: [] };
}
function topologySignatureFrom(networks, ship) {
  const design = Array.isArray(ship?.design) ? ship.design : [];
  const sourceAlive = design.map((m, i) => DataSupportRules.isDataSupportSource(m?.type) && isAlive(ship, i) ? i : -1).filter(i => i >= 0);
  const weaponAlive = design.map((m, i) => PARTS[m?.type]?.weapon && isAlive(ship, i) ? i : -1).filter(i => i >= 0);
  return stable({ networks: (networks || []).map(n => ({ id: n.id, sectionIds: [...(n.sectionIds || [])].sort(), sourceIndices: [...(n.sourceIndices || [])].sort(numericSort), weaponIndices: [...(n.weaponIndices || [])].sort(numericSort) })), sourceAlive, weaponAlive });
}
function normalizeNetworks(networks) { return (networks || []).map((n) => ({ ...n, sourceIndices: [...(n.sourceIndices || [])], weaponIndices: [...(n.weaponIndices || [])], componentIndices: [...(n.componentIndices || [])], sectionIds: [...(n.sectionIds || [])] })); }
function statusForSource(ship, record) {
  if (!record || !DataSupportRules.isDataSupportSource(record.sourceType)) return ["invalid-source", "Component is not a Data-support source."];
  if (!isAlive(ship, record.sourceIndex)) return ["destroyed", "Source component is destroyed."];
  if (!record.networkId) return ["disconnected", "Source is not connected to a surviving Data network."];
  if (record.powerMultiplier <= 0) return ["unpowered", "Source has no operational component Power."];
  if (record.thermalMultiplier <= 0) return ["overheated", "Source is overheated."];
  if (!record.eligibleWeaponIndices.length) return ["idle-no-weapons", "No living eligible weapons are connected."];
  if (record.powerMultiplier < 1) return ["underpowered", "Source Power is below nominal."];
  if (record.thermalMultiplier < 1) return ["thermally-reduced", "Source thermal state reduces output."];
  return ["active", "Source is allocating its effective support budget."];
}
function statusForWeapon(ship, record) {
  if (!record) return ["ineligible", "Component is not a weapon."];
  if (!isAlive(ship, record.weaponIndex)) return ["destroyed", "Weapon component is destroyed."];
  if (!record.networkId) return ["disconnected", "Weapon is not connected to a surviving Data network."];
  return [record.contributions.some((c) => c.amount !== 0) ? "supported" : "connected-unsupported", record.contributions.some((c) => c.amount !== 0) ? "Weapon receives active Data support." : "Weapon is connected but receives no active bonus."];
}
function buildAllocation(ship, networks) {
  bump("allocationRefreshCount");
  const analysis = DataSupportRules.analyzeDataSupport(ship?.design || [], networks || [], PARTS, {
    isSourceEligible: (index) => isDataSourceEligible(ship, index),
    isWeaponEligible: (index) => isDataWeaponEligible(ship, index),
    sourceMultiplier: (index) => sourceMultiplier(ship, index)
  });
  for (const record of analysis.sourceAllocations || []) {
    record.powerMultiplier = sourcePowerMultiplier(ship, record.sourceIndex);
    record.thermalMultiplier = sourceThermalMultiplier(ship, record.sourceIndex);
    record.operationalMultiplier = sourceOperationalMultiplier(ship, record.sourceIndex);
    record.sourceMultiplier = sourceMultiplier(ship, record.sourceIndex);
    record.effectiveBudget = record.nominalBudget * record.sourceMultiplier;
    const [status, statusReason] = statusForSource(ship, record); record.status = status; record.statusReason = statusReason;
  }
  for (const record of analysis.weaponBonuses || []) {
    record.alive = isAlive(ship, record.weaponIndex); record.eligible = isDataWeaponEligible(ship, record.weaponIndex);
    if (!record.alive) { record.rangeBonus = 0; record.accuracyBonus = 0; record.fireRateBonus = 0; record.sourceIndices = []; record.contributions = []; }
    const [status, statusReason] = statusForWeapon(ship, record); record.status = status; record.statusReason = statusReason;
  }
  analysis.sourceAllocationByIndex = Array((ship?.design || []).length).fill(null); analysis.sourceAllocations.forEach(r => { analysis.sourceAllocationByIndex[r.sourceIndex] = cloneAllocation(r, r.sourceIndex); });
  analysis.weaponBonusByIndex = Array((ship?.design || []).length).fill(null); analysis.weaponBonuses.forEach(r => { analysis.weaponBonusByIndex[r.weaponIndex] = cloneSupport(r, r.weaponIndex); });
  return analysis;
}
function allocationSignatureFrom(analysis) { return stable({ sources: (analysis.sourceAllocations || []).map(r => ({ i: r.sourceIndex, m: r.sourceMultiplier, e: r.effectiveBudget, b: r.bonusPerWeapon, w: r.eligibleWeaponIndices, s: r.status })), weapons: (analysis.weaponBonuses || []).map(r => ({ i: r.weaponIndex, r: r.rangeBonus, a: r.accuracyBonus, f: r.fireRateBonus, s: r.status, c: r.contributions })) }); }
function installState(ship, networks, analysis, topologySignature, allocationSignature, reason) {
  const previous = ship.runtimeDataSupport || {}; const topologyChanged = previous.topologySignature !== topologySignature; const allocationChanged = previous.allocationSignature !== allocationSignature;
  if (topologyChanged) bump("dataTopologyRebuildCount");
  ship.runtimeDataSupport = { version: 1, topologyRevision: (previous.topologyRevision || 0) + (topologyChanged ? 1 : 0), allocationRevision: (previous.allocationRevision || 0) + (allocationChanged ? 1 : 0), topologySignature, allocationSignature, lastReason: (topologyChanged || allocationChanged) ? reason : previous.lastReason,
    networks: normalizeNetworks(analysis.networks || networks), sourceAllocations: analysis.sourceAllocations.map(r => cloneAllocation(r, r.sourceIndex)), weaponBonuses: analysis.weaponBonuses.map(r => cloneSupport(r, r.weaponIndex)),
    sourceAllocationByIndex: analysis.sourceAllocationByIndex.map((r, i) => cloneAllocation(r, i)), weaponBonusByIndex: analysis.weaponBonusByIndex.map((r, i) => cloneSupport(r, i)) };
  return ship.runtimeDataSupport;
}
function rebuildShipDataTopology(ship, reason = "topology", precomputedDataNetworks = null) { const topology = analyzeTopology(ship, precomputedDataNetworks); const sig = topologySignatureFrom(topology.networks, ship); const analysis = buildAllocation(ship, topology.networks); return installState(ship, topology.networks, analysis, sig, allocationSignatureFrom(analysis), reason); }
function refreshShipDataAllocation(ship, reason = "allocation") { if (!ship?.runtimeDataSupport?.networks) return rebuildShipDataTopology(ship, reason); const sig = ship.runtimeDataSupport.topologySignature || topologySignatureFrom(ship.runtimeDataSupport.networks, ship); const analysis = buildAllocation(ship, ship.runtimeDataSupport.networks); return installState(ship, ship.runtimeDataSupport.networks, analysis, sig, allocationSignatureFrom(analysis), reason); }
function rebuildShipDataSupport(ship) { return ship && typeof ship === "object" ? rebuildShipDataTopology(ship, "rebuild") : null; }
function refreshShipDataSupportAllocation(ship) { return refreshShipDataAllocation(ship, "refresh"); }
function ensureShipDataSupport(ship) { return ship?.runtimeDataSupport?.weaponBonusByIndex ? ship.runtimeDataSupport : rebuildShipDataSupport(ship); }
function markShipDataTopologyDirty(ship, reason = "topology-dirty") { if (ship) { ship.dataTopologyDirty = reason; } }
function markShipDataAllocationDirty(ship, reason = "allocation-dirty") { if (ship) { ship.dataAllocationDirty = reason; } }

function cacheSignature(ship) {
  const state = ship?.runtimeDataSupport;
  const power = ship?.powerRevision || 0;
  const heat = (ship?.componentHeatState || []).join(",");
  const hp = (ship?.componentHp || []).map((v) => v > 0 ? 1 : 0).join("");
  return `${state?.topologyRevision || 0}:${state?.allocationRevision || 0}:${power}:${heat}:${hp}:${ship?.designRevision || 1}`;
}
function rebuildEffectiveWeaponProfileCache(ship, reason = "profile-cache") {
  ensureShipDataSupport(ship);
  const design = Array.isArray(ship?.design) ? ship.design : [];
  const profiles = new Array(design.length).fill(null);
  let maxRange = 420;
  for (let i = 0; i < design.length; i += 1) {
    const baseWeapon = PARTS[design[i]?.type]?.weapon;
    if (!baseWeapon) continue;
    const support = ship.runtimeDataSupport?.weaponBonusByIndex?.[i] || ZERO_SUPPORT;
    profiles[i] = DataSupportRules.effectiveWeaponProfile(baseWeapon, support);
    if (isAlive(ship, i)) maxRange = Math.max(maxRange, Number(profiles[i].range) || 0);
  }
  bump("profileBuildCount");
  const prev = ship.effectiveWeaponProfileCache || {};
  ship.effectiveWeaponProfileCache = { version: 1, signature: cacheSignature(ship), revision: (prev.revision || 0) + 1, reason, profiles, maxRange };
  return ship.effectiveWeaponProfileCache;
}
function ensureEffectiveWeaponProfileCache(ship) {
  if (!ship || typeof ship !== "object") return null;
  const sig = cacheSignature(ship);
  if (!ship.effectiveWeaponProfileCache || ship.effectiveWeaponProfileCache.signature !== sig) return rebuildEffectiveWeaponProfileCache(ship);
  return ship.effectiveWeaponProfileCache;
}
function getEffectiveWeaponStatsInternal(ship, weaponIndex) {
  if (!Number.isInteger(weaponIndex) || weaponIndex < 0) return null;
  const cache = ensureEffectiveWeaponProfileCache(ship);
  const profile = cache?.profiles?.[weaponIndex] || null;
  if (profile) bump("profileCacheHitCount");
  return profile;
}
function getMaxEffectiveWeaponRange(ship) { return ensureEffectiveWeaponProfileCache(ship)?.maxRange || 420; }

function getWeaponDataSupport(ship, weaponIndex) { if (!Number.isInteger(weaponIndex) || weaponIndex < 0) return cloneSupport(null, weaponIndex); const state = ensureShipDataSupport(ship); return cloneSupport(state?.weaponBonusByIndex?.[weaponIndex], weaponIndex); }
function getEffectiveWeaponStats(ship, weaponIndex) { const profile = getEffectiveWeaponStatsInternal(ship, weaponIndex); return profile ? { ...profile } : null; }
function getSourceDataAllocation(ship, sourceIndex) { if (!Number.isInteger(sourceIndex) || sourceIndex < 0) return null; const state = ensureShipDataSupport(ship); return cloneAllocation(state?.sourceAllocationByIndex?.[sourceIndex], sourceIndex); }
module.exports = { rebuildShipDataSupport, refreshShipDataSupportAllocation, ensureShipDataSupport, getWeaponDataSupport, getEffectiveWeaponStats, getEffectiveWeaponStatsInternal, getMaxEffectiveWeaponRange, rebuildEffectiveWeaponProfileCache, ensureEffectiveWeaponProfileCache, getSourceDataAllocation, markShipDataTopologyDirty, markShipDataAllocationDirty, rebuildShipDataTopology, refreshShipDataAllocation, sourceOperationalMultiplier, sourcePowerMultiplier, sourceThermalMultiplier, sourceMultiplier, isDataWeaponEligible, isDataSourceEligible };
