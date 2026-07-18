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
  const powerBlueprint = ship?.wiring?.power;
  const hasPowerBlueprint = (powerBlueprint?.sections?.length || 0) > 0 || (powerBlueprint?.connections?.length || 0) > 0;
  const value = ship?.componentPower?.byComponentIndex?.[sourceIndex]?.operationalMultiplier;
  if (!hasPowerBlueprint && value === 0 && ship?.componentPower?.byComponentIndex?.[sourceIndex]?.state === "disconnected") return 1;
  return DataSupportRules.normalizeSourceMultiplier(Number.isFinite(value) ? value : 1);
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
function analyzeTopology(ship) {
  const design = Array.isArray(ship?.design) ? ship.design : [];
  if (!design.length) return { networks: [] };
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
  ship.runtimeDataSupport = { version: 1, topologyRevision: (previous.topologyRevision || 0) + (topologyChanged ? 1 : 0), allocationRevision: (previous.allocationRevision || 0) + (allocationChanged ? 1 : 0), topologySignature, allocationSignature, lastReason: (topologyChanged || allocationChanged) ? reason : previous.lastReason,
    networks: normalizeNetworks(analysis.networks || networks), sourceAllocations: analysis.sourceAllocations.map(r => cloneAllocation(r, r.sourceIndex)), weaponBonuses: analysis.weaponBonuses.map(r => cloneSupport(r, r.weaponIndex)),
    sourceAllocationByIndex: analysis.sourceAllocationByIndex.map((r, i) => cloneAllocation(r, i)), weaponBonusByIndex: analysis.weaponBonusByIndex.map((r, i) => cloneSupport(r, i)) };
  return ship.runtimeDataSupport;
}
function rebuildShipDataTopology(ship, reason = "topology") { const topology = analyzeTopology(ship); const sig = topologySignatureFrom(topology.networks, ship); const analysis = buildAllocation(ship, topology.networks); return installState(ship, topology.networks, analysis, sig, allocationSignatureFrom(analysis), reason); }
function refreshShipDataAllocation(ship, reason = "allocation") { if (!ship?.runtimeDataSupport?.networks) return rebuildShipDataTopology(ship, reason); const sig = ship.runtimeDataSupport.topologySignature || topologySignatureFrom(ship.runtimeDataSupport.networks, ship); const analysis = buildAllocation(ship, ship.runtimeDataSupport.networks); return installState(ship, ship.runtimeDataSupport.networks, analysis, sig, allocationSignatureFrom(analysis), reason); }
function rebuildShipDataSupport(ship) { return ship && typeof ship === "object" ? rebuildShipDataTopology(ship, "rebuild") : null; }
function refreshShipDataSupportAllocation(ship) { return refreshShipDataAllocation(ship, "refresh"); }
function ensureShipDataSupport(ship) { return ship?.runtimeDataSupport?.weaponBonusByIndex ? ship.runtimeDataSupport : rebuildShipDataSupport(ship); }
function markShipDataTopologyDirty(ship, reason = "topology-dirty") { if (ship) { ship.dataTopologyDirty = reason; } }
function markShipDataAllocationDirty(ship, reason = "allocation-dirty") { if (ship) { ship.dataAllocationDirty = reason; } }
function getWeaponDataSupport(ship, weaponIndex) { if (!Number.isInteger(weaponIndex) || weaponIndex < 0) return cloneSupport(null, weaponIndex); const state = ensureShipDataSupport(ship); return cloneSupport(state?.weaponBonusByIndex?.[weaponIndex], weaponIndex); }
function getEffectiveWeaponStats(ship, weaponIndex) { const module = Array.isArray(ship?.design) ? ship.design[weaponIndex] : null; const baseWeapon = module ? PARTS[module.type]?.weapon : null; if (!baseWeapon) return null; return DataSupportRules.effectiveWeaponProfile(baseWeapon, getWeaponDataSupport(ship, weaponIndex)); }
function getSourceDataAllocation(ship, sourceIndex) { if (!Number.isInteger(sourceIndex) || sourceIndex < 0) return null; const state = ensureShipDataSupport(ship); return cloneAllocation(state?.sourceAllocationByIndex?.[sourceIndex], sourceIndex); }
module.exports = { rebuildShipDataSupport, refreshShipDataSupportAllocation, ensureShipDataSupport, getWeaponDataSupport, getEffectiveWeaponStats, getSourceDataAllocation, markShipDataTopologyDirty, markShipDataAllocationDirty, rebuildShipDataTopology, refreshShipDataAllocation, sourceOperationalMultiplier, sourcePowerMultiplier, sourceThermalMultiplier, sourceMultiplier, isDataWeaponEligible, isDataSourceEligible };
