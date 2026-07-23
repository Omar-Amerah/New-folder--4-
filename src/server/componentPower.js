// Damage-aware, event-driven runtime Power/Data wiring state. ship.wiring is
// always the immutable normalized blueprint; all battle damage lives here.

const { PARTS } = require("./components");
const WiringRules = require("../../public/src/shared/wiringRules");
const WiringInfrastructureRules = require("../../public/src/shared/wiringInfrastructureRules.js");
const PowerFlowRules = require("../../public/src/shared/powerFlowRules");
const PowerAllocationRules = require("../../public/src/shared/powerAllocationRules");
const PowerPolicyRules = require("../../public/src/shared/powerPolicyRules");
const PowerCableThermalRules = require("../../public/src/shared/powerCableThermalRules");
const PowerDemandRules = require("../../public/src/shared/powerDemandRules");
const SwitchgearRules = require("../../public/src/shared/switchgearRules");
const PowerProtectionRules = require("../../public/src/shared/powerProtectionRules");
const { BALANCE } = require("./balanceConfig");
const { clampNumber } = require("./utils");
const ShieldRules = require("../../public/src/shared/shieldRules");

const SOURCE_TYPES = new Set(WiringRules.POWER_SOURCE_TYPES);
function isPowerSource(module) {
  return SOURCE_TYPES.has(module?.type) || (Number(PARTS[module?.type]?.powerGeneration) || 0) > 0;
}
const perf = () => global.__mfaDataSupportPerf || null;
function bump(name) { const p = perf(); if (p) p[name] = (p[name] || 0) + 1; }

// Section 7G: the central runtime Power-protection balance, normalised once
// from the authoritative component-balance.json block. No tuning constants
// live anywhere else on the server or in the UI.
let _powerProtectionConfig = null;
let _powerProtectionConfigOverride = null;
function powerProtectionConfig() {
  if (_powerProtectionConfigOverride) return _powerProtectionConfigOverride;
  if (!_powerProtectionConfig) _powerProtectionConfig = PowerProtectionRules.normalizeConfig(BALANCE.powerProtection);
  return _powerProtectionConfig;
}
// Verifier-only hook: overlays the authoritative balance block (pass null to
// restore). Never used by runtime code paths.
function __setPowerProtectionConfigForTests(partial) {
  _powerProtectionConfigOverride = partial
    ? PowerProtectionRules.normalizeConfig({ ...(BALANCE.powerProtection || {}), ...partial })
    : null;
}
function bumpHostedRefreshes() { bump("hostedWiringRebuildCount"); bump("hostedPowerRefreshCount"); bump("hostedDataRefreshCount"); }

// The static hosted-cell mapping (which physical cells/components host each
// section) depends only on the immutable Blueprint design + wiring, never on
// runtime health. It is computed once via the shared authority and cached on
// the ship so repeated component-damage events reuse it instead of rebuilding.
function shipHostMaps(ship) {
  if (!ship._infrastructureHostMaps) {
    ship._infrastructureHostMaps = WiringInfrastructureRules.mapHostedCells(
      Array.isArray(ship.design) ? ship.design : [], ship.wiring || {}, PARTS
    );
  }
  return ship._infrastructureHostMaps;
}

function addDisabledCell(disabledByCell, kind, section, host) {
  const key = `${kind}:${host.x},${host.y}`;
  let entry = disabledByCell.get(key);
  const tier = kind === "power" ? (section.tier || "standard") : undefined;
  if (!entry) {
    entry = {
      routeType: kind === "power" ? "Power" : "Data",
      x: host.x,
      y: host.y,
      hostComponentIndex: host.componentIndex == null ? null : host.componentIndex,
      sectionIds: [],
      ownerConnectionIds: [],
      tiers: kind === "power" ? [] : undefined,
      tier: kind === "power" ? tier : undefined,
      sectionId: section.id
    };
    disabledByCell.set(key, entry);
  }
  entry.sectionIds.push(section.id);
  if (kind === "power") {
    entry.tiers.push(tier);
    entry.tier = WiringRules.higherPowerTier(entry.tier, tier);
  }
}

function finalizeDisabledCells(disabledByCell) {
  const cells = [...disabledByCell.values()];
  for (const cell of cells) {
    cell.sectionIds = [...new Set(cell.sectionIds)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    cell.ownerConnectionIds = [...new Set(cell.ownerConnectionIds)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    cell.sectionId = cell.sectionIds[0] || cell.sectionId || null;
    if (Array.isArray(cell.tiers)) cell.tiers = [...new Set(cell.tiers)].sort((a, b) => (WiringRules.POWER_TIER_PRECEDENCE[a] || 0) - (WiringRules.POWER_TIER_PRECEDENCE[b] || 0) || a.localeCompare(b));
  }
  return cells.sort((a, b) => `${a.routeType}:${a.x},${a.y}:${a.hostComponentIndex ?? ""}`.localeCompare(`${b.routeType}:${b.x},${b.y}:${b.hostComponentIndex ?? ""}`, undefined, { numeric: true }));
}

function deriveRuntimeKind(ship, kind, hostMap) {
  const blueprint = ship.wiring?.[kind] || { sections: [], connections: [] };
  const operationalSectionIds = new Set();
  const disabledSectionIds = new Set();
  const disabledByCell = new Map();
  const sectionHosts = new Map();
  for (const section of blueprint.sections || []) {
    // Canonical host cells for this section come from the shared mapper. Each
    // endpoint cell is independently hosted by the component occupying that
    // Blueprint cell. Invalid/unhosted cells fail closed; destroyed hosts only
    // sever the incident physical section, so surviving upstream/downstream
    // cells can still form their own runtime islands.
    const entry = hostMap.bySectionId.get(section.id);
    const hostCells = entry ? entry.hostCells : WiringRules.sectionCells(section).map((cell) => ({ ...cell, componentIndex: null }));
    const hosts = [...new Set(hostCells.map((host) => (host.componentIndex == null ? undefined : host.componentIndex)))];
    sectionHosts.set(section.id, hosts);
    const disabledHosts = hostCells.filter((host) => host.componentIndex == null || (ship.componentHp?.[host.componentIndex] ?? 1) <= 0);
    const operational = hostCells.length > 0 && disabledHosts.length === 0;
    if (operational) operationalSectionIds.add(section.id);
    else {
      disabledSectionIds.add(section.id);
      for (const host of disabledHosts) addDisabledCell(disabledByCell, kind, section, host);
    }
  }

  const operationalConnectionIds = new Set();
  const brokenConnectionIds = new Set();
  const operationalConnections = [];
  for (const connection of blueprint.connections || []) {
    const id = WiringRules.connectionKey(connection);
    for (const sectionId of connection.sectionIds || []) {
      for (const cell of disabledByCell.values()) if (cell.sectionIds.includes(sectionId)) cell.ownerConnectionIds.push(id);
    }
    const sourceAlive = (ship.componentHp?.[connection.sourceIndex] ?? 0) > 0;
    const targetAlive = (ship.componentHp?.[connection.targetIndex] ?? 0) > 0;
    // Connection records are retained as diagnostics/migration metadata only.
    // Runtime Power and Data topology are derived from surviving physical
    // sections, so a broken saved route cannot invalidate a redundant conductor.
    const complete = sourceAlive && targetAlive && connection.sectionIds.length > 0
      && connection.sectionIds.every((sectionId) => operationalSectionIds.has(sectionId));
    (complete ? operationalConnectionIds : brokenConnectionIds).add(id);
    if (complete) operationalConnections.push({ ...connection, sectionIds: [...connection.sectionIds] });
  }
  const operationalWiring = {
    // Runtime topology is a projection of surviving physical hosts. Blueprint
    // sections remain persisted and repair can therefore restore them.
    sections: (blueprint.sections || []).filter((section) => operationalSectionIds.has(section.id)).map((section) => ({ ...section })),
    connections: operationalConnections
  };
  return { operationalSectionIds, disabledSectionIds, disabledCells: finalizeDisabledCells(disabledByCell), operationalConnectionIds, brokenConnectionIds, sectionHosts, operationalWiring };
}

function stateSignature(runtime) {
  const values = [];
  for (const kind of ["power", "data"]) {
    values.push(kind, ...[...runtime[kind].operationalSectionIds].sort(), "|", ...[...runtime[kind].operationalConnectionIds].sort(), ";");
  }
  return values.join(",");
}


function switchgearTerminalBypassKeys(design) {
  const keys = new Set();
  (Array.isArray(design) ? design : []).forEach((module) => {
    if (module?.type === "switchgear") keys.add(SwitchgearRules.terminalPairKey(module));
  });
  return keys;
}
function withoutSwitchgearBypassSections(sections, bypassKeys) {
  if (!bypassKeys || !bypassKeys.size) return Array.isArray(sections) ? sections : [];
  return (Array.isArray(sections) ? sections : []).filter((section) => !bypassKeys.has(SwitchgearRules.terminalPairKey({ type: "switchgear", x: section.x1, y: section.y1, rotation: section.x1 === section.x2 ? 90 : 0 }))
    || !bypassKeys.has([`${section.x1},${section.y1}`, `${section.x2},${section.y2}`].sort().join(":")));
}

function rebuildShipWiringState(ship, reason = "component-boundary", options = {}) {
  const design = Array.isArray(ship?.design) ? ship.design : [];
  bump("wiringNormalizationCount");
  const hostMaps = shipHostMaps(ship);
  if (reason === "component-lifecycle") bumpHostedRefreshes();
  const power = deriveRuntimeKind(ship, "power", hostMaps.power);
  const data = deriveRuntimeKind(ship, "data", hostMaps.data);
  // Runtime Power wiring for the shared solver: only surviving physical sections
  // plus the saved Blueprint Power policy (cloned so runtime never mutates the
  // immutable Blueprint). Persisted Power connections are never the flow
  // authority — the solver reads sections.
  const runtimePowerWiring = {
    version: WiringRules.WIRING_VERSION,
    power: { ...power.operationalWiring, sections: withoutSwitchgearBypassSections(power.operationalWiring.sections, switchgearTerminalBypassKeys(design)) },
    data: data.operationalWiring,
    powerPolicy: PowerPolicyRules.clonePolicy(ship.wiring?.powerPolicy)
  };
  ship._runtimePowerWiring = runtimePowerWiring;
  bump("powerAnalysisCount");
  let dataAnalysis;
  bump("wiringAnalysisCount");
  // Runtime Data connectivity is section-authoritative: analyzeWiring is the
  // shared physical wiring analysis export, so surviving Data sections form
  // conductors even when saved connection metadata for one route is broken.
  try { dataAnalysis = WiringRules.analyzeWiring(design, runtimePowerWiring, PARTS).data; } catch (_) { dataAnalysis = { networks: [] }; }
  const runtime = { power, data, powerNetworks: [], dataNetworks: dataAnalysis.networks || [], reason };
  const wiringSignature = stateSignature(runtime);
  if (ship._wiringStateSignature !== wiringSignature) {
    ship._wiringStateSignature = wiringSignature;
    ship.wiringRevision = (ship.wiringRevision || 0) + 1;
  }

  ship.runtimeWiring = runtime;
  applyShipPowerAllocation(ship, { ...options, skipDataRefresh: true });
  // Section 6C ordering: surviving Wiring topology is projected first, then
  // component Power is allocated by the shared solver, then Data-support source
  // multipliers read the fresh per-component Power state.
  require("./componentData").rebuildShipDataTopology(ship, reason, dataAnalysis.networks || []);
  return runtime;
}

// Reuses topology, membership and nominal demand. Thermal source changes only
// alter generation/allocation, so Data analysis and wiringRevision stay intact.
function sourceGenerationReductionReasons(ship, index, entry = null) {
  const design = Array.isArray(ship?.design) ? ship.design : [];
  const rated = Math.max(0, Number(PARTS[design[index]?.type]?.powerGeneration) || 0);
  if (!(rated > 0)) return [];
  const reasons = [];
  const hp = ship?.componentHp?.[index];
  if (Number.isFinite(Number(hp)) && Number(hp) <= 0) reasons.push("destroyed-component");
  const HeatRules = require("../../public/src/shared/heatRules");
  if ((ship?.componentHeatState?.[index] ?? HeatRules.STATE.NORMAL) === HeatRules.STATE.OVERHEATED) reasons.push("thermal-penalty");
  const available = Number(entry?.generationAvailableMw);
  const used = Number(entry?.generationUsedMw);
  if (Number.isFinite(available) && available > 0) {
    const hasNetwork = Array.isArray(entry?.networkIds) ? entry.networkIds.length > 0 : entry?.networkId !== null && entry?.networkId !== undefined;
    if (!hasNetwork) reasons.push("isolated-from-network");
    else if (Number.isFinite(used) && used <= 0) reasons.push("no-connected-demand");
    else if (Number.isFinite(used) && used < available) reasons.push("curtailed-by-demand");
  }
  if (Number.isFinite(available) && available < rated && !reasons.length) reasons.push("unknown-runtime-reduction");
  return [...new Set(reasons)];
}

function effectiveLiveSourceGeneration(ship, index) {
  const design = Array.isArray(ship?.design) ? ship.design : [];
  if ((ship?.componentHp?.[index] ?? 1) <= 0) return 0;
  const HeatRules = require("../../public/src/shared/heatRules");
  if ((ship?.componentHeatState?.[index] ?? HeatRules.STATE.NORMAL) === HeatRules.STATE.OVERHEATED) return 0;
  return Math.max(0, Number(PARTS[design[index]?.type]?.powerGeneration) || 0);
}


function liveSwitchgearRecords(ship, conductingOverride) {
  const design = Array.isArray(ship?.design) ? ship.design : [];
  const records = [];
  for (let index = 0; index < design.length; index += 1) {
    const module = design[index];
    if (module?.type !== "switchgear") continue;
    const mode = SwitchgearRules.normalizeMode(module.switchgearMode);
    const ratingTier = SwitchgearRules.normalizeRatingTier(module.switchgearRatingTier);
    const terminals = SwitchgearRules.terminalCells(module);
    const destroyed = (ship.componentHp?.[index] ?? 1) <= 0;
    const tripped = Boolean(ship._switchgearTrips?.[index]);
    let state = mode;
    if (destroyed) state = "destroyed"; else if (tripped) state = "tripped";
    const automaticClosed = mode === "automatic" && conductingOverride?.has(index) === true;
    const conducts = !destroyed && !tripped && (mode === "closed" || automaticClosed);
    const cap = SwitchgearRules.capacityForTier(BALANCE.wiringInfrastructure, ratingTier);
    records.push({ componentIndex: index, mode, ratingTier, state, automaticClosed, conducts, terminalA: terminals.A, terminalB: terminals.B, orientation: terminals.orientation, internalEdgeId: SwitchgearRules.internalSectionId(index), sustainedCapacityMw: cap.sustainedCapacityMw, peakCapacityMw: cap.peakCapacityMw, signedTransferMw: 0, utilisation: 0, classification: "isolator", sideANetworkId: null, sideBNetworkId: null, decisionReason: mode === "automatic" ? "automatic evaluated open first" : `${mode} saved mode`, trippedReason: tripped ? String(ship._switchgearTrips[index] || "manual test trip") : null, topologyRevision: ship.wiringRevision || 0 });
  }
  return records;
}
function switchgearInternalEdges(records) { return records.filter(r => r.conducts).map(r => ({ ...SwitchgearRules.internalSection(r.componentIndex, { x:r.terminalA.x, y:r.terminalA.y, rotation:0, switchgearRatingTier:r.ratingTier }), id:r.internalEdgeId, x1:r.terminalA.x, y1:r.terminalA.y, x2:r.terminalB.x, y2:r.terminalB.y })); }
function classifySwitchgearRecords(records, openResult, wiring) {
  const nets = openResult?.networks || [];
  const sectionById = new Map(((wiring?.power?.sections) || []).map((sec) => [String(sec.id), sec]));
  const touches = (sec, cell) => sec && ((sec.x1 === cell.x && sec.y1 === cell.y) || (sec.x2 === cell.x && sec.y2 === cell.y));
  const sideNet = (cell) => nets.find((net) => (net.sectionIds || []).some((id) => touches(sectionById.get(String(id)), cell))) || null;
  for (const rec of records) {
    const a = sideNet(rec.terminalA); const b = sideNet(rec.terminalB);
    rec.sideANetworkId = a?.id || null; rec.sideBNetworkId = b?.id || null;
    const aSourced = (a?.availableGenerationMw || 0) > 0;
    const bSourced = (b?.availableGenerationMw || 0) > 0;
    if (aSourced && bSourced && a.id !== b.id) rec.classification = "bus-tie";
    else if (a || b) rec.classification = "branch-breaker";
    else rec.classification = "isolator";
  }
}
function sideNetworksForRecord(record, result, wiring) {
  const sectionById = new Map(((wiring?.power?.sections) || []).map((sec) => [String(sec.id), sec]));
  const touches = (sec, cell) => sec && ((sec.x1 === cell.x && sec.y1 === cell.y) || (sec.x2 === cell.x && sec.y2 === cell.y));
  const sideNet = (cell) => (result?.networks || []).find((net) => (net.sectionIds || []).some((id) => touches(sectionById.get(String(id)), cell))) || null;
  return { a: sideNet(record.terminalA), b: sideNet(record.terminalB) };
}

function componentAllocationMap(result) {
  return new Map((result?.byComponentIndex || []).map((entry) => [entry.componentIndex, entry]));
}
function solveSwitchgearCandidate(baseInput, records, closedSet) {
  // Only a healthy Closed Switchgear conducts implicitly; a tripped or
  // destroyed one must be explicitly re-included via closedSet (Section 7G
  // retry evaluation) — otherwise candidate solves would silently bypass an
  // overload trip.
  const candidateRecords = records.map((record) => ({ ...record, conducts: (record.mode === "closed" && record.state === "closed") || closedSet.has(record.componentIndex) }));
  return PowerFlowRules.solvePowerFlow({ ...baseInput, internalPowerEdges: switchgearInternalEdges(candidateRecords) });
}
function tieStableKey(record) {
  const a = `${String(record.terminalA.x).padStart(2, "0")},${String(record.terminalA.y).padStart(2, "0")}`;
  const b = `${String(record.terminalB.x).padStart(2, "0")},${String(record.terminalB.y).padStart(2, "0")}`;
  return [a, b].sort().join("<->") + `|${record.orientation || "unknown"}`;
}
function finiteFlowResult(result) {
  if (!result || !Array.isArray(result.byComponentIndex) || !Array.isArray(result.sectionFlows) || !Array.isArray(result.networks)) return false;
  const numbers = [];
  for (const entry of result.byComponentIndex) numbers.push(entry.requestedMw, entry.allocatedMw, entry.unmetMw, entry.operationalMultiplier);
  for (const flow of result.sectionFlows) numbers.push(flow.signedFlowMw, flow.absoluteFlowMw, flow.sustainedCapacityMw, flow.peakCapacityMw, flow.peakUtilisation);
  return numbers.every((value) => Number.isFinite(Number(value)) && !Object.is(Number(value), -0));
}
function candidateScore(baseline, candidate, subset, recordsByIndex) {
  const before = componentAllocationMap(baseline);
  const after = componentAllocationMap(candidate);
  const priorityGain = Array.from({ length: 8 }, () => 0);
  let totalAllocated = 0;
  let remainingUnmet = 0;
  let gainedPreviouslyUnmet = false;
  for (const entry of candidate.byComponentIndex || []) {
    const prev = before.get(entry.componentIndex) || {};
    const allocated = Number(entry.allocatedMw) || 0;
    const prevAllocated = Number(prev.allocatedMw) || 0;
    const prevUnmet = Number(prev.unmetMw) || 0;
    const requested = Number(entry.requestedMw) || 0;
    if (allocated + 1e-6 < prevAllocated) return null;
    if (prevUnmet > 1e-6 && allocated > prevAllocated + 1e-6) {
      gainedPreviouslyUnmet = true;
      const band = Number.isInteger(entry.priorityBand) ? Math.max(0, Math.min(7, entry.priorityBand)) : 7;
      priorityGain[band] += Math.min(prevUnmet, allocated - prevAllocated);
    }
    totalAllocated += allocated;
    remainingUnmet += Math.max(0, requested - allocated);
  }
  const baselineTotal = (baseline.byComponentIndex || []).reduce((sum, entry) => sum + (Number(entry.allocatedMw) || 0), 0);
  if (!gainedPreviouslyUnmet || totalAllocated <= baselineTotal + 1e-6) return null;
  const flowById = new Map((candidate.sectionFlows || []).map((flow) => [flow.sectionId, flow]));
  for (const index of subset) {
    const record = recordsByIndex.get(index);
    const flow = flowById.get(record?.internalEdgeId);
    if (!flow || Math.abs(Number(flow.signedFlowMw) || 0) <= 1e-6) return null;
  }
  return { priorityGain, totalAllocated, remainingUnmet, tieCount: subset.size, tieKeys: [...subset].map((index) => tieStableKey(recordsByIndex.get(index))).sort() };
}
function compareScores(a, b) {
  if (!a && !b) return 0; if (!a) return -1; if (!b) return 1;
  for (let i = 0; i < Math.max(a.priorityGain.length, b.priorityGain.length); i += 1) {
    const delta = (a.priorityGain[i] || 0) - (b.priorityGain[i] || 0);
    if (Math.abs(delta) > 1e-6) return delta > 0 ? 1 : -1;
  }
  if (Math.abs(a.totalAllocated - b.totalAllocated) > 1e-6) return a.totalAllocated > b.totalAllocated ? 1 : -1;
  if (Math.abs(a.remainingUnmet - b.remainingUnmet) > 1e-6) return a.remainingUnmet < b.remainingUnmet ? 1 : -1;
  if (a.tieCount !== b.tieCount) return a.tieCount < b.tieCount ? 1 : -1;
  const ak = a.tieKeys.join("|"); const bk = b.tieKeys.join("|");
  return ak === bk ? 0 : ak < bk ? 1 : -1;
}
function automaticTieGroups(autoRecords) {
  const parent = new Map();
  const find = (key) => { while (parent.get(key) !== key) { parent.set(key, parent.get(parent.get(key))); key = parent.get(key); } return key; };
  const union = (a, b) => { if (!parent.has(a)) parent.set(a, a); if (!parent.has(b)) parent.set(b, b); const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(rb, ra < rb ? ra : rb); };
  for (const record of autoRecords) if (record.sideANetworkId && record.sideBNetworkId && record.sideANetworkId !== record.sideBNetworkId) union(record.sideANetworkId, record.sideBNetworkId);
  const grouped = new Map();
  for (const record of autoRecords) {
    if (!record.sideANetworkId || !record.sideBNetworkId || record.sideANetworkId === record.sideBNetworkId) { record.decisionReason = "open: terminals are not on two separate candidate grids"; continue; }
    const root = find(record.sideANetworkId);
    const list = grouped.get(root) || [];
    list.push(record); grouped.set(root, list);
  }
  return [...grouped.values()].map((list) => list.sort((a, b) => tieStableKey(a).localeCompare(tieStableKey(b)))).sort((a, b) => tieStableKey(a[0]).localeCompare(tieStableKey(b[0])));
}
function enumerateSubsets(records, maxSubsets) {
  const n = records.length;
  const count = 2 ** n;
  if (count > maxSubsets) return null;
  const subsets = [];
  for (let mask = 1; mask < count; mask += 1) {
    const set = new Set();
    for (let i = 0; i < n; i += 1) if (mask & (1 << i)) set.add(records[i].componentIndex);
    subsets.push(set);
  }
  return subsets;
}
function decideAutomaticSwitchgear(baseInput, baseRecords, baselineResult) {
  const manualClosed = new Set(baseRecords.filter((r) => r.mode === "closed" && r.state === "closed").map((r) => r.componentIndex));
  const selected = new Set(manualClosed);
  const auto = baseRecords.filter(r => r.mode === "automatic" && r.state === "automatic");
  const recordsByIndex = new Map(baseRecords.map((record) => [record.componentIndex, record]));
  const maxSubsets = powerProtectionConfig().maxAutomaticRetrySubsets;
  for (const group of automaticTieGroups(auto)) {
    const subsets = enumerateSubsets(group, maxSubsets);
    if (!subsets) { for (const record of group) record.decisionReason = `open: automatic tie group exceeds ${maxSubsets} candidate subsets`; continue; }
    let best = null;
    let bestSubset = null;
    for (const subset of subsets) {
      const candidateClosed = new Set([...manualClosed, ...subset]);
      const result = solveSwitchgearCandidate(baseInput, baseRecords, candidateClosed);
      if (!finiteFlowResult(result)) continue;
      const score = candidateScore(baselineResult, result, subset, recordsByIndex);
      if (compareScores(score, best) > 0) { best = score; bestSubset = subset; }
    }
    if (!bestSubset) { for (const record of group) record.decisionReason = "open: no jointly valid priority-safe subset"; continue; }
    for (const record of group) {
      if (bestSubset.has(record.componentIndex)) { selected.add(record.componentIndex); record.decisionReason = "closed: jointly selected priority-safe automatic subset"; }
      else record.decisionReason = "open: not part of best jointly valid automatic subset";
    }
  }
  return selected;
}
function solveWithSwitchgear(ship, baseInput) {
  const baseRecords = liveSwitchgearRecords(ship, new Set());
  const manualClosed = new Set(baseRecords.filter((r) => r.mode === "closed" && r.state === "closed").map((r) => r.componentIndex));
  const baselineResult = solveSwitchgearCandidate(baseInput, baseRecords, manualClosed);
  classifySwitchgearRecords(baseRecords, baselineResult, baseInput.wiring);
  const conducting = decideAutomaticSwitchgear(baseInput, baseRecords, baselineResult);
  for (const r of baseRecords) if (r.mode === "closed" && r.state === "closed") conducting.add(r.componentIndex);
  const records = liveSwitchgearRecords(ship, conducting);
  for (const r of records) {
    const base = baseRecords.find(x=>x.componentIndex===r.componentIndex); if (base) { r.classification=base.classification; r.sideANetworkId=base.sideANetworkId; r.sideBNetworkId=base.sideBNetworkId; r.decisionReason=base.decisionReason; }
  }
  const result = PowerFlowRules.solvePowerFlow({ ...baseInput, internalPowerEdges: switchgearInternalEdges(records) });
  const flows = new Map((result.sectionFlows||[]).map(f=>[f.sectionId,f]));
  for (const rec of records) { const f=flows.get(rec.internalEdgeId); rec.signedTransferMw = f ? Number(f.signedFlowMw)||0 : 0; rec.utilisation = f ? Number(f.peakUtilisation)||0 : 0; }
  ship.runtimeSwitchgear = records;
  return result;
}
function tripSwitchgear(ship, index, reason = "manual test trip") { if (!ship._switchgearTrips) ship._switchgearTrips = {}; ship._switchgearTrips[index] = reason; return rebuildShipWiringState(ship, "switchgear-trip"); }
function resetSwitchgearTrip(ship, index) { if (ship._switchgearTrips) delete ship._switchgearTrips[index]; return rebuildShipWiringState(ship, "switchgear-reset"); }

// The shared 7C-2 capacity-and-priority solver is the SOLE runtime allocator.
// It enforces cable peak capacity and the saved Power priorities, giving each
// component its own multiplier. No uniform generation/demand ratio and no second
// pass are applied.
function buildShipPowerSolveBaseInput(ship) {
  const design = Array.isArray(ship?.design) ? ship.design : [];
  const runtimePowerWiring = ship._runtimePowerWiring || {
    version: WiringRules.WIRING_VERSION, power: { sections: [], connections: [] }, data: { sections: [], connections: [] },
    powerPolicy: PowerPolicyRules.clonePolicy(ship.wiring?.powerPolicy)
  };
  // Live source generation (already zero for destroyed/overheated sources) and
  // current component operational state. Consumer demand is the Section 7D-2
  // activity-derived demand map when present (built by updateShipPowerDemand),
  // otherwise the solver falls back to static nominal powerUse.
  const sourceGenerationByIndex = {};
  const componentOperationalByIndex = design.map((module, index) => {
    if (isPowerSource(module)) sourceGenerationByIndex[index] = effectiveLiveSourceGeneration(ship, index);
    return (ship.componentHp?.[index] ?? 1) > 0;
  });
  return {
    design,
    wiring: runtimePowerWiring,
    catalogue: PARTS,
    infrastructure: BALANCE.wiringInfrastructure,
    sourceGenerationByIndex,
    componentOperationalByIndex,
    componentDemandByIndex: ship._activityDemandByIndex || undefined
  };
}

function applyShipPowerAllocation(ship, options = {}) {
  const design = Array.isArray(ship?.design) ? ship.design : [];
  // The shared solver is the sole allocation authority. An unexpected exception
  // must propagate so tests and server diagnostics expose the underlying defect,
  // and a malformed result is rejected outright — never silently fail-open to a
  // full-Power fallback that would grant live consumers full effectiveness. The
  // performance counter records the attempted solve before the call so a throw
  // is still counted.
  bump("powerFlowSolveCount");
  const result = solveWithSwitchgear(ship, buildShipPowerSolveBaseInput(ship));
  if (!result || !Array.isArray(result.byComponentIndex) || !Array.isArray(result.networks) || !Array.isArray(result.sectionFlows)) {
    throw new Error("Power-flow solver returned an invalid result");
  }

  const solved = new Map(result.byComponentIndex.map((entry) => [entry.componentIndex, entry]));
  const byComponentIndex = design.map((module, index) => {
    const entry = solved.get(index);
    // Every design component must appear in a valid solver result. A missing
    // entry is a solver defect, not a reason to grant full Power.
    if (!entry) throw new Error(`Power-flow solver omitted component ${index}`);
    // availableEfficiency == operationalMultiplier; the solver already produced
    // the per-component allocation ratio, so no second multiplier is derived.
    const multiplier = clampNumber(Number(entry.operationalMultiplier), 0, 1);
    const networkId = Array.isArray(entry.networkIds) && entry.networkIds.length ? entry.networkIds[0] : null;
    return {
      state: entry.state,
      networkId,
      availableEfficiency: multiplier,
      operationalMultiplier: multiplier,
      role: entry.role,
      powerCategory: entry.powerCategory,
      priorityBand: entry.priorityBand,
      networkIds: entry.networkIds,
      requestedMw: entry.requestedMw,
      allocatedMw: entry.allocatedMw,
      unmetMw: entry.unmetMw,
      generationAvailableMw: entry.generationAvailableMw,
      generationUsedMw: entry.generationUsedMw,
      generationReductionReasons: entry.role === "source" ? sourceGenerationReductionReasons(ship, index, entry) : []
    };
  });

  // Fixed-point Power-state signature: meaningful component state, canonical
  // network id and integer allocation units — never raw floating-point strings.
  const switchgearPowerSignature = (ship.runtimeSwitchgear || []).map((entry) => [entry.componentIndex, entry.state, entry.automaticClosed ? 1 : 0, entry.classification || "", entry.sideANetworkId || "", entry.sideBNetworkId || "", PowerAllocationRules.mwToPowerUnits(entry.signedTransferMw || 0), Math.round(clampNumber(entry.utilisation || 0, 0, 99) * PowerAllocationRules.POWER_FLOW_SCALE)].join(":")).join("|");
  const powerSignature = switchgearPowerSignature + "#" + byComponentIndex.map((entry) => [
    entry.state,
    entry.networkId ?? "",
    PowerAllocationRules.mwToPowerUnits(entry.allocatedMw),
    PowerAllocationRules.mwToPowerUnits(entry.requestedMw),
    Math.round(clampNumber(entry.operationalMultiplier, 0, 1) * PowerAllocationRules.POWER_FLOW_SCALE)
  ].join(":")).join("|");
  if (ship._powerStateSignature !== powerSignature) {
    ship._powerStateSignature = powerSignature;
    ship.powerRevision = (ship.powerRevision || 0) + 1;
    ship.dirtyPower = true;
  }

  // Section 7D-1: a separate physical section-flow signature so runtime cable
  // Heat refreshes when the solved section flow changes even if component
  // multipliers stay the same. Fixed-point Power units (sign preserved), never
  // raw float strings. Built after the 7C fail-closed validation above.
  const toFlowUnits = (mw) => { const n = Number(mw); return Number.isFinite(n) ? Math.round(n * PowerAllocationRules.POWER_FLOW_SCALE) : 0; };
  const sectionFlowSignature = (result.sectionFlows || []).map((flow) => [
    flow.sectionId,
    flow.tier ?? "",
    toFlowUnits(flow.signedFlowMw),
    toFlowUnits(flow.sustainedCapacityMw),
    toFlowUnits(flow.peakCapacityMw),
    flow.operational === false ? 0 : 1
  ].join(":")).join("|");
  if (ship._powerFlowSectionSignature !== sectionFlowSignature) {
    ship._powerFlowSectionSignature = sectionFlowSignature;
    ship.powerFlowRevision = (ship.powerFlowRevision || 0) + 1;
  }

  ship.componentPower = { byComponentIndex };
  // Complete authoritative solver result kept server-local for diagnostics.
  ship.powerFlow = result;
  ship.powerAnalysis = result;
  if (ship.runtimeWiring) ship.runtimeWiring.powerNetworks = result.networks || [];
  ship.powerStatus = summarizePower(byComponentIndex);
  // Section 7D-1: refresh the cached Power-cable Heat analysis whenever the
  // solved section flow changed (revision-guarded, so an unchanged solve is a
  // no-op). This keeps the ship-level cable-Heat rate current for the thermal
  // tick without recomputing topology.
  ensureShipCableThermalAnalysis(ship);

  if (!options.skipRuntimeStats && ship.alive !== false) require("./componentHealth").recalcEffectiveStats(ship);
  else if (ship.alive === false) { ship.maxShield = 0; ship.shield = 0; }
  if (!options.skipDataRefresh) require("./componentData").refreshShipDataAllocation(ship, "power-allocation");
  return ship.componentPower;
}

// Section 7D-1: cache the shared Power-cable Heat analysis on the ship and
// recompute it only when the physical section flow changes (powerFlowRevision).
// Reuses the cached infrastructure host map — no second host-mapping system and
// no topology rebuild. Sets the per-component cable-Heat rate and ship totals
// consumed by the thermal tick.
function ensureShipCableThermalAnalysis(ship) {
  if (!ship) return null;
  const flowRevision = ship.powerFlowRevision || 0;
  if (ship.powerCableThermalAnalysis && ship._powerCableThermalFlowRevision === flowRevision) return ship.powerCableThermalAnalysis;
  const sectionFlows = ship.powerFlow && Array.isArray(ship.powerFlow.sectionFlows) ? ship.powerFlow.sectionFlows.filter((flow) => !String(flow.sectionId || "").startsWith("switchgear:")) : [];
  const hostMap = shipHostMaps(ship).power;
  const analysis = PowerCableThermalRules.analyzePowerCableHeat({
    sectionFlows,
    powerTiers: BALANCE.wiringInfrastructure.powerTiers,
    hostMap
  });
  bump("powerCableThermalAnalysisCount");
  const design = Array.isArray(ship.design) ? ship.design : [];
  const rates = design.map(() => 0);
  for (const component of analysis.components) {
    if (component.componentIndex >= 0 && component.componentIndex < rates.length) rates[component.componentIndex] = component.powerCableHeatPerSecond;
  }
  ship.powerCableThermalAnalysis = analysis;
  ship._powerCableThermalFlowRevision = flowRevision;
  ship.powerCableThermalRevision = (ship.powerCableThermalRevision || 0) + 1;
  ship.componentPowerCableHeatRate = rates;
  ship.powerCableHeatRate = PowerCableThermalRules.totalPowerCableHeatRate(analysis);
  return analysis;
}

// Section 7D-2 — activity-driven Power demand.
//
// A per-component activity level (0..1) represents REQUESTED activity (intent),
// never merely successful output, so demand can rise before power is delivered
// (no feedback deadlock). All signals read existing authoritative server state
// and are deterministic — simulation-time holds only, never wall-clock or
// randomness.
const WEAPON_INTENT_HOLD_MS = 500;
function clamp01(value) { const n = Number(value); return Number.isFinite(n) ? (n <= 0 ? 0 : (n >= 1 ? 1 : n)) : 0; }

function weaponActivity(ship, index, now) {
  if (!Array.isArray(ship._weaponIntentAt) || ship._weaponIntentAt.length !== ship.design.length) {
    ship._weaponIntentAt = ship.design.map(() => -Infinity);
  }
  // "Attempting/ready to fire at a valid target": the combat system records a
  // fire target on this weapon. A short simulation-time hold prevents demand
  // flicker between target-acquisition frames.
  if (Array.isArray(ship.weaponFireTargetIds) && ship.weaponFireTargetIds[index] != null) ship._weaponIntentAt[index] = now;
  const last = ship._weaponIntentAt[index];
  return Number.isFinite(last) && (now - last) < WEAPON_INTENT_HOLD_MS ? 1 : 0;
}
function propulsionActivity(ship) {
  // Requested effort from current controls: linear drive toward a move target
  // and/or the recorded turn effort.
  const turn = clamp01(Math.abs(Number(ship.turnActivity) || 0));
  const moving = ship.arrived === false ? 1 : 0;
  return Math.max(turn, moving);
}
function shieldActivity(ship) {
  const maxShield = Number(ship.maxShield) || 0;
  const current = Number(ship.shield) || 0;
  return maxShield > 0 && current < maxShield - 1e-6 ? 1 : 0;
}
function repairActivity(ship, now) {
  const last = ship._repairIntentAt;
  return Number.isFinite(last) && (now - last) < WEAPON_INTENT_HOLD_MS ? 1 : 0;
}
function coolingActivity(ship) { return clamp01(Number(ship.heatPressure) || 0); }

function componentActivityLevel(ship, index, module, part, now) {
  if (part.weapon) return weaponActivity(ship, index, now);
  switch (part.powerCategory) {
    case "propulsion": return propulsionActivity(ship);
    case "shields": return shieldActivity(ship);
    case "coolingSupport":
      if (Number(part.repair) > 0) return repairActivity(ship, now);
      if (module.type === "radiator") return coolingActivity(ship);
      return 1; // always-on Data-support / sensing / command support
    case "command": return 1;
    default: return 1;
  }
}

// The single authoritative demand-update path. Collects per-consumer activity,
// converts it to requested MW via the shared PowerDemandRules, builds a
// deterministic fixed-point demand signature, and reallocates Power at most once
// — only when the signature actually changed. Called once per ship per cycle,
// before gameplay systems consume the new operational multipliers.
function updateShipPowerDemand(ship, room, now) {
  if (!ship || ship.alive === false || !Array.isArray(ship.design) || !ship.design.length) return;
  bump("powerDemandRefreshCount");
  const design = ship.design;
  const standby = BALANCE.powerDemand;
  const activity = design.map(() => 0);
  const demandByIndex = {};
  const signatureParts = [];
  for (let i = 0; i < design.length; i += 1) {
    const module = design[i];
    const part = PARTS[module && module.type];
    if (!part || !(Number(part.powerUse) > 0)) continue; // demand is per Power consumer
    const alive = (ship.componentHp?.[i] ?? 1) > 0;
    const level = alive ? clamp01(componentActivityLevel(ship, i, module, part, now)) : 0;
    activity[i] = level;
    const requested = PowerDemandRules.requestedMwForComponent(part, level, standby);
    demandByIndex[i] = requested;
    signatureParts.push(`${i}:${PowerAllocationRules.mwToPowerUnits(requested)}`);
  }
  ship.componentPowerActivity = activity;
  const signature = signatureParts.join("|");
  if (ship._powerDemandSignature === signature) { ship.powerDemandDirty = false; return; }
  ship._powerDemandSignature = signature;
  ship.powerDemandRevision = (ship.powerDemandRevision || 0) + 1;
  ship.powerDemandDirty = true;
  ship._activityDemandByIndex = demandByIndex;
  bump("powerDemandSolveCount");
  reallocateShipPower(ship, "activity-demand");
}

function initializeComponentPower(ship) {
  // Section 7G: spawned/replaced designs always begin from deterministic
  // zero overload stress. Runtime protection state is never persisted in
  // Blueprints, saved designs or loadouts, so it is rebuilt from nothing here.
  require("./powerProtection").resetShipPowerProtection(ship);
  rebuildShipWiringState(ship, "initialization", { skipRuntimeStats: true });
  require("./powerProtection").refreshShipPowerProtectionDiagnostics(ship);
  return ship.componentPower;
}
function reallocateShipPower(ship, reason = "source-availability") {
  // Source generation changed (destruction/overheat/recovery) but topology did
  // not — re-solve on the cached runtime wiring without re-deriving sections.
  if (!ship._runtimePowerWiring) return rebuildShipWiringState(ship, reason);
  return applyShipPowerAllocation(ship);
}

function getComponentPowerMultiplier(ship, componentIndex) {
  if ((ship?.componentHp?.[componentIndex] ?? 1) <= 0) return 0;
  const value = ship?.componentPower?.byComponentIndex?.[componentIndex]?.operationalMultiplier;
  return clampNumber(Number.isFinite(value) ? value : 1, 0, 1);
}

function summarizePower(entries) {
  const consumers = entries.filter((entry) => ["disconnected", "unpowered", "underpowered", "powered"].includes(entry.state));
  if (!consumers.length) return "powered";
  if (consumers.some((entry) => entry.state === "unpowered")) return "unpowered";
  if (consumers.some((entry) => entry.state === "underpowered")) return "underpowered";
  if (consumers.some((entry) => entry.state === "disconnected")) return "disconnected";
  return "powered";
}

function effectiveShieldCapacityContributions(ship) {
  return ShieldRules.calculateShieldCapacityContributions(ship.design || [], PARTS, {
    isLive: (index) => (ship.componentHp?.[index] ?? 1) > 0,
    powerMultiplier: (index) => getComponentPowerMultiplier(ship, index)
  });
}

function effectiveShieldStats(ship) {
  const HeatRules = require("../../public/src/shared/heatRules");
  return ShieldRules.calculateShieldStats(ship.design || [], PARTS, {
    isLive: (index) => (ship.componentHp?.[index] ?? 1) > 0,
    powerMultiplier: (index) => getComponentPowerMultiplier(ship, index),
    heatMultiplier: (index, module, part) => (Number(part.shieldRegen) || 0) > 0 ? HeatRules.activeOutputForState(ship.componentHeatState?.[index] || HeatRules.STATE.NORMAL) : 1
  });
}

function componentHostsWiring(ship, index) {
  if (!Number.isInteger(index) || !ship) return false;
  const maps = shipHostMaps(ship);
  return (maps.power.byComponentIndex.get(index)?.length || 0) > 0 || (maps.data.byComponentIndex.get(index)?.length || 0) > 0;
}

module.exports = { initializeComponentPower, rebuildShipWiringState, reallocateShipPower, applyShipPowerAllocation, ensureShipCableThermalAnalysis, updateShipPowerDemand, getComponentPowerMultiplier, effectiveLiveSourceGeneration, effectiveShieldStats, effectiveShieldCapacityContributions, componentHostsWiring, tripSwitchgear, resetSwitchgearTrip, powerProtectionConfig, __setPowerProtectionConfigForTests, buildShipPowerSolveBaseInput, liveSwitchgearRecords, solveSwitchgearCandidate, tieStableKey, finiteFlowResult };
