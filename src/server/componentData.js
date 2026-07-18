// Authoritative runtime Data-support integration for weapon components.
// State here is derived from the immutable ship design plus Wiring v2 blueprint;
// it is intentionally not persisted into saved blueprints.

const { PARTS } = require("./components");
const WiringRules = require("../../public/src/shared/wiringRules");
const DataSupportRules = require("../../public/src/shared/dataSupportRules");

const ZERO_SUPPORT = Object.freeze({
  rangeBonus: 0,
  accuracyBonus: 0,
  fireRateBonus: 0,
  sourceIndices: Object.freeze([]),
  contributions: Object.freeze([]),
  status: "disconnected"
});

function cloneSupport(record, weaponIndex) {
  if (!record || typeof record !== "object") return { weaponIndex, ...ZERO_SUPPORT, sourceIndices: [], contributions: [] };
  return {
    ...record,
    weaponIndex: Number.isInteger(record.weaponIndex) ? record.weaponIndex : weaponIndex,
    rangeBonus: Number.isFinite(Number(record.rangeBonus)) ? Number(record.rangeBonus) : 0,
    accuracyBonus: Number.isFinite(Number(record.accuracyBonus)) ? Number(record.accuracyBonus) : 0,
    fireRateBonus: Number.isFinite(Number(record.fireRateBonus)) ? Number(record.fireRateBonus) : 0,
    sourceIndices: Array.isArray(record.sourceIndices) ? [...record.sourceIndices] : [],
    contributions: Array.isArray(record.contributions) ? record.contributions.map((entry) => ({ ...entry })) : []
  };
}

function cloneAllocation(record, sourceIndex) {
  if (!record || typeof record !== "object") return null;
  return {
    ...record,
    sourceIndex: Number.isInteger(record.sourceIndex) ? record.sourceIndex : sourceIndex,
    connectedWeaponIndices: Array.isArray(record.connectedWeaponIndices) ? [...record.connectedWeaponIndices] : [],
    eligibleWeaponIndices: Array.isArray(record.eligibleWeaponIndices) ? [...record.eligibleWeaponIndices] : []
  };
}

function buildAnalysis(ship) {
  const design = Array.isArray(ship?.design) ? ship.design : [];
  const wiring = ship?.runtimeWiring
    ? { version: WiringRules.WIRING_VERSION, power: ship.runtimeWiring.power?.operationalWiring, data: ship.runtimeWiring.data?.operationalWiring }
    : ship?.wiring;
  if (!design.length) return DataSupportRules.analyzeDataSupport([], [], PARTS, { sourceMultiplier: () => 1 });
  const wiringAnalysis = WiringRules.analyzeWiring(design, wiring, PARTS);
  return wiringAnalysis?.data?.supportAnalysis
    || DataSupportRules.analyzeDataSupport(design, wiringAnalysis?.data?.networks || [], PARTS, { sourceMultiplier: () => 1 });
}

function normalizeRuntime(analysis) {
  const sourceAllocationByIndex = Array.isArray(analysis?.sourceAllocationByIndex) ? analysis.sourceAllocationByIndex.map((entry, index) => cloneAllocation(entry, index)) : [];
  const weaponBonusByIndex = Array.isArray(analysis?.weaponBonusByIndex) ? analysis.weaponBonusByIndex.map((entry, index) => cloneSupport(entry, index)) : [];
  return {
    revision: 1,
    networks: (analysis?.networks || []).map((network) => ({ ...network, sourceIndices: [...(network.sourceIndices || [])], weaponIndices: [...(network.weaponIndices || [])], componentIndices: [...(network.componentIndices || [])], sectionIds: [...(network.sectionIds || [])] })),
    sourceAllocations: (analysis?.sourceAllocations || []).map((entry) => cloneAllocation(entry, entry.sourceIndex)),
    weaponBonuses: (analysis?.weaponBonuses || []).map((entry) => cloneSupport(entry, entry.weaponIndex)),
    sourceAllocationByIndex,
    weaponBonusByIndex
  };
}

function rebuildShipDataSupport(ship) {
  if (!ship || typeof ship !== "object") return null;
  try { ship.runtimeDataSupport = normalizeRuntime(buildAnalysis(ship)); }
  catch (_) { ship.runtimeDataSupport = normalizeRuntime(DataSupportRules.analyzeDataSupport([], [], PARTS)); }
  return ship.runtimeDataSupport;
}

function refreshShipDataSupportAllocation(ship) { return rebuildShipDataSupport(ship); }

function validRuntime(ship) {
  const state = ship?.runtimeDataSupport;
  return state && Array.isArray(state.weaponBonusByIndex) && Array.isArray(state.sourceAllocationByIndex);
}

function ensureShipDataSupport(ship) {
  if (!validRuntime(ship)) return rebuildShipDataSupport(ship);
  return ship.runtimeDataSupport;
}

function getWeaponDataSupport(ship, weaponIndex) {
  if (!Number.isInteger(weaponIndex) || weaponIndex < 0) return cloneSupport(null, weaponIndex);
  const state = ensureShipDataSupport(ship);
  return cloneSupport(state?.weaponBonusByIndex?.[weaponIndex], weaponIndex);
}

function getEffectiveWeaponStats(ship, weaponIndex) {
  const module = Array.isArray(ship?.design) ? ship.design[weaponIndex] : null;
  const baseWeapon = module ? PARTS[module.type]?.weapon : null;
  if (!baseWeapon) return null;
  return DataSupportRules.effectiveWeaponProfile(baseWeapon, getWeaponDataSupport(ship, weaponIndex));
}

function getSourceDataAllocation(ship, sourceIndex) {
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0) return null;
  const state = ensureShipDataSupport(ship);
  return cloneAllocation(state?.sourceAllocationByIndex?.[sourceIndex], sourceIndex);
}

module.exports = { rebuildShipDataSupport, refreshShipDataSupportAllocation, ensureShipDataSupport, getWeaponDataSupport, getEffectiveWeaponStats, getSourceDataAllocation };
