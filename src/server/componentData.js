// Authoritative runtime Data-support integration for weapon components.
// State here is derived from the immutable ship design plus Wiring v2 blueprint;
// it is intentionally not persisted into saved blueprints.

const { PARTS } = require("./components");
const { getShipComponentIndexes } = require("./componentIndexes");
const { getCommandAuraMultiplier } = require("./commandAuras");
const WiringRules = require("../../public/src/shared/wiringRules");
const DataSupportRules = require("../../public/src/shared/dataSupportRules");
const HeatRules = require("../../public/src/shared/heatRules");
const TurretRules = require("../../public/src/shared/turretRules");
const { WIRING_ENABLED } = require("../../public/src/shared/featureFlags");

const ZERO_SUPPORT = Object.freeze({ rangeBonus: 0, accuracyBonus: 0, fireRateBonus: 0, sourceIndices: Object.freeze([]), contributions: Object.freeze([]), status: "disconnected" });
const WEAPON_AURA_KEYS = Object.freeze([
  "weaponAccuracyMultiplier",
  "weaponTrackingMultiplier",
  "turretAimSpeedMultiplier",
  "targetAcquisitionMultiplier",
  "pointDefenceTrackingMultiplier",
  "flakTrackingMultiplier",
  "interceptionReactionMultiplier"
]);
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
  const module = ship?.design?.[sourceIndex];
  const part = module ? PARTS[module.type] : null;
  const powerUse = Number(part?.powerUse) || 0;
  const byComp = ship?.componentPower?.byComponentIndex;
  const record = Array.isArray(byComp) ? byComp[sourceIndex] : null;
  if (!record) return powerUse > 0 ? 0 : 1;
  const value = record?.operationalMultiplier;
  return DataSupportRules.normalizeSourceMultiplier(Number.isFinite(value) ? value : 0);
}
function sourceThermalMultiplier(ship, sourceIndex) {
  if (!isAlive(ship, sourceIndex)) return 1;
  return DataSupportRules.normalizeSourceMultiplier(HeatRules.activeOutputForState(ship?.componentHeatState?.[sourceIndex] ?? HeatRules.STATE.NORMAL));
}
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
  const dataLinks = DataSupportRules.normalizeDataLinks(design, ship?.dataLinks, PARTS);
  return { networks: [{ id: "direct-data-links", label: "Data Links", mode: "direct-links", sourceIndices: [], weaponIndices: [], componentIndices: [], sectionIds: [] }], dataLinks };
}
function dataLinksSignature(dataLinks) {
  const links = (dataLinks || []).map((l) => `${l.sourceIndex}:${l.targetIndex}`).sort();
  return `dl:${links.join(",")}`;
}
function topologySignatureFrom(networks, ship) {
  const design = Array.isArray(ship?.design) ? ship.design : [];
  const sourceAlive = design.map((m, i) => DataSupportRules.isDataSupportSource(m?.type) && isAlive(ship, i) ? i : -1).filter(i => i >= 0);
  const weaponAlive = design.map((m, i) => PARTS[m?.type]?.weapon && isAlive(ship, i) ? i : -1).filter(i => i >= 0);
  return dataLinksSignature(ship?.dataLinks) + "#" + stable({ networks: (networks || []).map(n => ({ id: n.id, sectionIds: [...(n.sectionIds || [])].sort(), sourceIndices: [...(n.sourceIndices || [])].sort(numericSort), weaponIndices: [...(n.weaponIndices || [])].sort(numericSort) })), sourceAlive, weaponAlive });
}
function normalizeNetworks(networks) { return (networks || []).map((n) => ({ ...n, sourceIndices: [...(n.sourceIndices || [])], weaponIndices: [...(n.weaponIndices || [])], componentIndices: [...(n.componentIndices || [])], sectionIds: [...(n.sectionIds || [])] })); }
function statusForSource(ship, record) {
  if (!record || !DataSupportRules.isDataSupportSource(record.sourceType)) return ["invalid-source", "Component is not a Data-support source."];
  if (!isAlive(ship, record.sourceIndex)) return ["destroyed", "Source component is destroyed."];
  if (!record.directWeaponIndices?.length) return ["idle-no-weapons", "No weapons are directly linked to this source."];
  if (record.powerMultiplier <= 0) return ["unpowered", "Source has no operational component Power."];
  if (record.thermalMultiplier <= 0) return ["overheated", "Source is overheated."];
  if (!record.eligibleWeaponIndices?.length) return ["idle-no-weapons", "No living eligible weapons are connected."];
  if (record.powerMultiplier < 1) return ["underpowered", "Source Power is below nominal."];
  if (record.thermalMultiplier < 1) return ["thermally-reduced", "Source thermal state reduces output."];
  return ["active", "Source is allocating its effective support budget."];
}
function statusForWeapon(ship, record) {
  if (!record) return ["ineligible", "Component is not a weapon."];
  if (!isAlive(ship, record.weaponIndex)) return ["destroyed", "Weapon component is destroyed."];
  return [record.contributions.some((c) => c.amount !== 0) ? "supported" : record.sourceIndices?.length ? "connected-unsupported" : "unsupported", record.contributions.some((c) => c.amount !== 0) ? "Weapon receives active Data support." : record.sourceIndices?.length ? "Weapon is linked but receives no active bonus." : "No Data sources are linked to this weapon."];
}
function buildAllocation(ship, dataLinks) {
  bump("allocationRefreshCount");
  const analysis = DataSupportRules.analyzeDirectDataSupport(ship?.design || [], dataLinks || [], PARTS, {
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
    record.connectedWeaponIndices = record.directWeaponIndices || [];
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
function disableShipDataSupport(ship, reason = "wiring-disabled") {
  if (!ship || typeof ship !== "object") return null;
  const design = Array.isArray(ship.design) ? ship.design : [];
  const previous = ship.runtimeDataSupport || {};
  const weaponBonusByIndex = design.map((module, index) => (
    PARTS[module?.type]?.weapon ? cloneSupport(ZERO_SUPPORT, index) : null
  ));
  ship.runtimeDataSupport = {
    version: 1,
    disabled: true,
    topologyRevision: previous.disabled ? (previous.topologyRevision || 1) : (previous.topologyRevision || 0) + 1,
    allocationRevision: previous.disabled ? (previous.allocationRevision || 1) : (previous.allocationRevision || 0) + 1,
    topologySignature: "wiring-disabled",
    allocationSignature: "wiring-disabled",
    lastReason: reason,
    networks: [],
    sourceAllocations: [],
    weaponBonuses: weaponBonusByIndex.filter(Boolean),
    sourceAllocationByIndex: design.map(() => null),
    weaponBonusByIndex
  };
  return ship.runtimeDataSupport;
}
function rebuildShipDataTopology(ship, reason = "topology", precomputedDataNetworks = null, precomputedDataLinks = null) { const topology = analyzeTopology(ship, precomputedDataNetworks); if (precomputedDataLinks) topology.dataLinks = precomputedDataLinks; ship.dataLinks = topology.dataLinks; const sig = topologySignatureFrom(topology.networks, ship); const analysis = buildAllocation(ship, topology.dataLinks); return installState(ship, topology.networks, analysis, sig, allocationSignatureFrom(analysis), reason); }
function refreshShipDataAllocation(ship, reason = "allocation") { if (!ship?.runtimeDataSupport?.networks) return rebuildShipDataTopology(ship, reason); const sig = ship.runtimeDataSupport.topologySignature || topologySignatureFrom(ship.runtimeDataSupport.networks, ship); const analysis = buildAllocation(ship, ship.dataLinks); return installState(ship, ship.runtimeDataSupport.networks, analysis, sig, allocationSignatureFrom(analysis), reason); }
function rebuildShipDataSupport(ship) { return ship && typeof ship === "object" ? rebuildShipDataTopology(ship, "rebuild", ship?.runtimeDataSupport?.networks, ship?.dataLinks) : null; }
function ensureShipDataSupport(ship) { return ship?.runtimeDataSupport?.weaponBonusByIndex ? ship.runtimeDataSupport : rebuildShipDataSupport(ship); }

function dataRelevantHeatSignature(ship) {
  const design = Array.isArray(ship?.design) ? ship.design : [];
  const states = ship?.componentHeatState || [];
  return design.map((module, index) => {
    if (DataSupportRules.isDataSupportSource(module?.type)) {
      const alive = isAlive(ship, index);
      return `s${index}:${alive ? 1 : 0}:${alive ? (states[index] ?? HeatRules.STATE.NORMAL) : HeatRules.STATE.NORMAL}:${alive ? sourceThermalMultiplier(ship, index) : 0}:${sourcePowerMultiplier(ship, index)}`;
    }
    // Weapon Data eligibility is currently HP-only; add weapon-local Heat here
    // only if a future rule makes Heat affect support eligibility/profile.
    return null;
  }).filter(Boolean).join(",");
}
function weaponAuraSignature(ship) {
  const values = WEAPON_AURA_KEYS.map((key) => getCommandAuraMultiplier(ship, key));
  return `${ship?.commandState || "mainCore"}:${values.join(":")}`;
}
function cacheSignature(ship) {
  const state = ship?.runtimeDataSupport;
  const power = ship?.powerRevision || 0;
  const heatRevision = ship?.heatStateRevision || 0;
  const hpRevision = ship?.componentAliveRevision || 1;
  return `${state?.topologyRevision || 0}:${state?.allocationRevision || 0}:${power}:${heatRevision}:${hpRevision}:${ship?.designRevision || 1}:${weaponAuraSignature(ship)}`;
}
function applyEffectiveWeaponCommandAuras(profile, ship) {
  const modified = { ...profile };
  if (!Number.isFinite(modified.aimSpeed)) {
    modified.aimSpeed = TurretRules.turnRateFor({ type: modified.type });
  }
  if (ship?.commandState === "backupCore") {
    modified.accuracy = Number.isFinite(profile.accuracy) ? profile.accuracy * 0.85 : 0.85;
  }
  const accMult = getCommandAuraMultiplier(ship, "weaponAccuracyMultiplier");
  const trackMult = getCommandAuraMultiplier(ship, "weaponTrackingMultiplier");
  const aimMult = getCommandAuraMultiplier(ship, "turretAimSpeedMultiplier");
  const acqMult = getCommandAuraMultiplier(ship, "targetAcquisitionMultiplier");
  if (accMult !== 1 && Number.isFinite(modified.accuracy)) modified.accuracy = Math.min(0.999, modified.accuracy * accMult);
  if (trackMult !== 1 && Number.isFinite(modified.tracking)) modified.tracking = modified.tracking * trackMult;
  if (aimMult !== 1 && Number.isFinite(modified.aimSpeed)) modified.aimSpeed = modified.aimSpeed * aimMult;
  if (acqMult !== 1 && Number.isFinite(modified.trackingDelay) && modified.trackingDelay > 0) modified.trackingDelay = modified.trackingDelay / acqMult;
  const family = modified.type;
  if (family === "pointDefense") {
    const pdTrack = getCommandAuraMultiplier(ship, "pointDefenceTrackingMultiplier");
    const react = getCommandAuraMultiplier(ship, "interceptionReactionMultiplier");
    if (pdTrack !== 1 && Number.isFinite(modified.tracking)) modified.tracking = modified.tracking * pdTrack;
    if (pdTrack !== 1 && Number.isFinite(modified.aimSpeed) && modified.aimSpeed > 0) modified.aimSpeed = modified.aimSpeed * pdTrack;
    if (react !== 1 && Number.isFinite(modified.trackingDelay) && modified.trackingDelay > 0) modified.trackingDelay = modified.trackingDelay / react;
  }
  if (family === "flak") {
    const flakTrack = getCommandAuraMultiplier(ship, "flakTrackingMultiplier");
    const react = getCommandAuraMultiplier(ship, "interceptionReactionMultiplier");
    if (flakTrack !== 1 && Number.isFinite(modified.tracking)) modified.tracking = modified.tracking * flakTrack;
    if (flakTrack !== 1 && Number.isFinite(modified.aimSpeed) && modified.aimSpeed > 0) modified.aimSpeed = modified.aimSpeed * flakTrack;
    if (react !== 1 && Number.isFinite(modified.trackingDelay) && modified.trackingDelay > 0) modified.trackingDelay = modified.trackingDelay / react;
  }
  return modified;
}
function rebuildEffectiveWeaponProfileCache(ship, reason = "profile-cache") {
  ensureShipDataSupport(ship);
  const design = Array.isArray(ship?.design) ? ship.design : [];
  const baseProfiles = new Array(design.length).fill(null);
  const profiles = new Array(design.length).fill(null);
  const familyRanges = { blaster: 0, missile: 0, railgun: 0, beam: 0 };
  let maxRange = 420;
  for (let i = 0; i < design.length; i += 1) {
    const baseWeapon = PARTS[design[i]?.type]?.weapon;
    if (!baseWeapon) continue;
    const support = ship.runtimeDataSupport?.weaponBonusByIndex?.[i] || ZERO_SUPPORT;
    const baseProfile = DataSupportRules.effectiveWeaponProfile(baseWeapon, support);
    baseProfiles[i] = baseProfile;
    profiles[i] = Object.freeze(applyEffectiveWeaponCommandAuras(baseProfile, ship));
    if (isAlive(ship, i)) {
      const range = Number(baseProfile.range) || 0;
      maxRange = Math.max(maxRange, range);
      if (Object.hasOwn(familyRanges, baseWeapon.type)) {
        familyRanges[baseWeapon.type] = Math.max(familyRanges[baseWeapon.type], range);
      }
    }
  }
  for (let i = 0; i < design.length; i += 1) {
    if (!PARTS[design[i]?.type]?.proximityCharge) continue;
    const charge = { type: "charge", range: 0, dps: 0, accuracy: 1, arc: 360 };
    baseProfiles[i] = charge;
    profiles[i] = Object.freeze({ ...charge });
  }
  bump("profileBuildCount");
  const prev = ship.effectiveWeaponProfileCache || {};
  ship.effectiveWeaponProfileCache = {
    version: 2,
    signature: cacheSignature(ship),
    revision: (prev.revision || 0) + 1,
    reason,
    baseProfiles,
    profiles,
    familyRanges,
    maxRange
  };
  return ship.effectiveWeaponProfileCache;
}
function ensureEffectiveWeaponProfileCache(ship) {
  if (!ship || typeof ship !== "object") return null;
  bump("effectiveWeaponSignatureCalculations");
  const sig = cacheSignature(ship);
  if (!ship.effectiveWeaponProfileCache || ship.effectiveWeaponProfileCache.signature !== sig) return rebuildEffectiveWeaponProfileCache(ship);
  return ship.effectiveWeaponProfileCache;
}

function getEffectiveWeaponStatsInternal(ship, weaponIndex) {
  if (!Number.isInteger(weaponIndex) || weaponIndex < 0) return null;
  const cache = ensureEffectiveWeaponProfileCache(ship);
  const profile = cache?.baseProfiles?.[weaponIndex] || cache?.profiles?.[weaponIndex] || null;
  if (!profile) return null;
  bump("profileCacheHitCount");
  return applyEffectiveWeaponCommandAuras(profile, ship);
}

function getEffectiveWeaponStatsCached(ship, weaponIndex) {
  if (!Number.isInteger(weaponIndex) || weaponIndex < 0) return null;
  const profile = ship?.effectiveWeaponProfileCache?.profiles?.[weaponIndex] || null;
  if (!profile) return null;
  bump("profileCacheHitCount");
  return profile;
}
function getMaxEffectiveWeaponRange(ship) { return ensureEffectiveWeaponProfileCache(ship)?.maxRange || 420; }
function getEffectiveWeaponRanges(ship) {
  const ranges = ensureEffectiveWeaponProfileCache(ship)?.familyRanges;
  return {
    blaster: Number(ranges?.blaster) || 0,
    missile: Number(ranges?.missile) || 0,
    railgun: Number(ranges?.railgun) || 0,
    beam: Number(ranges?.beam) || 0
  };
}

// Does this hull carry anything that can actually shoot another ship at range?
//
// Deliberately narrower than getMaxEffectiveWeaponRange, which reports a floor
// for every hull whether or not it is armed. Point defence and flak are
// interception systems, a repair beam is not a weapon, and a demolition charge
// has no reach -- none of them give a ship a Hold engagement range, so none of
// them may be used to decide how close a Hold formation has to be placed.
function shipHasOffensiveWeapon(ship) {
  for (const index of getShipComponentIndexes(ship).weaponIndices) {
    const module = ship?.design?.[index];
    const weapon = PARTS[module?.type]?.weapon;
    if (!weapon || module.type === "repairBeam") continue;
    if (!isAlive(ship, index)) continue;
    const profile = getEffectiveWeaponStatsInternal(ship, index) || weapon;
    const family = profile.type || weapon.type;
    if (family === "pointDefense" || family === "flak" || family === "charge") continue;
    if ((Number(profile.range) || 0) > 0) return true;
  }
  return false;
}

// Does this hull carry a demolition charge that could still go off?
//
// True for either size -- the 1x1 Demolition Charge and the 2x3 Proximity
// Demolition Charge both carry a `proximityCharge` block, and both are armed
// from the moment they are built. A destroyed or already detonated one does not
// count.
//
// This lives here rather than in combat.js because the movement controller needs
// it: a charging ship with a live charge is trying to touch its target, and one
// without is trying to get alongside it. combat.js's
// shipHasOperationalDemolitionCharge is the same question and defers to this.
function shipHasArmedProximityCharge(ship) {
  for (const index of getShipComponentIndexes(ship).proximityChargeIndices) {
    if (!isAlive(ship, index)) continue;
    if (ship.proximityChargeDetonated?.[index]) continue;
    if (!PARTS[ship.design?.[index]?.type]?.proximityCharge) continue;
    return true;
  }
  return false;
}

function getWeaponDataSupport(ship, weaponIndex) { if (!Number.isInteger(weaponIndex) || weaponIndex < 0) return cloneSupport(null, weaponIndex); const state = ensureShipDataSupport(ship); return cloneSupport(state?.weaponBonusByIndex?.[weaponIndex], weaponIndex); }
function getEffectiveWeaponStats(ship, weaponIndex) { const profile = getEffectiveWeaponStatsInternal(ship, weaponIndex); return profile ? { ...profile } : null; }
function getSourceDataAllocation(ship, sourceIndex) { if (!Number.isInteger(sourceIndex) || sourceIndex < 0) return null; const state = ensureShipDataSupport(ship); return cloneAllocation(state?.sourceAllocationByIndex?.[sourceIndex], sourceIndex); }
module.exports = { shipHasArmedProximityCharge, shipHasOffensiveWeapon, rebuildShipDataSupport, ensureShipDataSupport, getWeaponDataSupport, getEffectiveWeaponStats, getEffectiveWeaponStatsInternal, getEffectiveWeaponStatsCached, getMaxEffectiveWeaponRange, getEffectiveWeaponRanges, rebuildEffectiveWeaponProfileCache, ensureEffectiveWeaponProfileCache, getSourceDataAllocation, rebuildShipDataTopology, refreshShipDataAllocation, disableShipDataSupport, sourceOperationalMultiplier, sourcePowerMultiplier, sourceThermalMultiplier, sourceMultiplier, isDataWeaponEligible, isDataSourceEligible };
