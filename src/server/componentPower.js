// Damage-aware, event-driven runtime Power/Data wiring state. ship.wiring is
// always the immutable normalized blueprint; all battle damage lives here.

const { PARTS } = require("./components");
const { getCommandAuraMultiplier } = require("./commandAuras");
const WiringRules = require("../../public/src/shared/wiringRules");
const WiringInfrastructureRules = require("../../public/src/shared/wiringInfrastructureRules.js");
const PowerFlowRules = require("../../public/src/shared/powerFlowRules");
const PowerAllocationRules = require("../../public/src/shared/powerAllocationRules");
const PowerPolicyRules = require("../../public/src/shared/powerPolicyRules");
const PowerCableThermalRules = require("../../public/src/shared/powerCableThermalRules");
const PowerDemandRules = require("../../public/src/shared/powerDemandRules");
const PowerProtectionRules = require("../../public/src/shared/powerProtectionRules");
const { BALANCE } = require("./balanceConfig");
const { clampNumber, compareNaturalIds, compareIdStrings } = require("./utils");
const ShieldRules = require("../../public/src/shared/shieldRules");
const { WIRING_ENABLED } = require("../../public/src/shared/featureFlags");

const SOURCE_TYPES = new Set(WiringRules.POWER_SOURCE_TYPES);
// Continuous inputs such as turn effort and Heat pressure can change every
// simulation tick. Re-solving the complete Power graph for those tiny changes
// at 30 Hz dominated large-fleet CPU time, so ordinary changes are coalesced to
// 10 Hz. A consumer becoming active still solves immediately so controls and
// weapon activation do not gain an extra 100 ms of latency.
const POWER_DEMAND_SOLVE_INTERVAL_MS = 100;
// Resolved lazily to preserve the existing circular-import order, but memoised
// so the per-tick demand loop does not re-enter the module cache per Drone Bay.
let _drones = null;
function droneModule() { return _drones || (_drones = require("./drones")); }
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
    cell.sectionIds = [...new Set(cell.sectionIds)].sort(compareNaturalIds);
    cell.ownerConnectionIds = [...new Set(cell.ownerConnectionIds)].sort(compareNaturalIds);
    cell.sectionId = cell.sectionIds[0] || cell.sectionId || null;
    if (Array.isArray(cell.tiers)) cell.tiers = [...new Set(cell.tiers)].sort((a, b) => (WiringRules.POWER_TIER_PRECEDENCE[a] || 0) - (WiringRules.POWER_TIER_PRECEDENCE[b] || 0) || compareIdStrings(a, b));
  }
  return cells.sort((a, b) => compareNaturalIds(
    `${a.routeType}:${a.x},${a.y}:${a.hostComponentIndex ?? ""}`,
    `${b.routeType}:${b.x},${b.y}:${b.hostComponentIndex ?? ""}`
  ));
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

function emptyRuntimeKind() {
  return {
    operationalSectionIds: new Set(),
    disabledSectionIds: new Set(),
    disabledCells: [],
    operationalConnectionIds: new Set(),
    brokenConnectionIds: new Set(),
    sectionHosts: new Map(),
    operationalWiring: { sections: [], connections: [] }
  };
}

function installUniversalPowerAllocation(ship, options = {}) {
  const design = Array.isArray(ship?.design) ? ship.design : [];
  const byComponentIndex = design.map((module, index) => {
    const part = PARTS[module?.type] || {};
    const alive = (ship.componentHp?.[index] ?? 1) > 0;
    const enabled = ship.componentPowerState?.[index] !== 0;
    const operational = alive && enabled;
    const requestedMw = Math.max(0, Number(ship._activityDemandByIndex?.[index] ?? part.powerUse) || 0);
    const ratedGenerationMw = Math.max(0, Number(part.powerGeneration) || 0);
    const storageCapacity = Math.max(0, Number(part.energyCapacity ?? part.energyStorage ?? part.energy) || 0);
    const role = ratedGenerationMw > 0 ? "source" : storageCapacity > 0 ? "storage" : requestedMw > 0 ? "consumer" : "passive";
    const state = role === "consumer"
      ? (operational ? "powered" : "unpowered")
      : role === "source" ? (alive ? "source" : "unpowered")
        : role === "storage" ? (alive ? "storage" : "unpowered") : "passive";
    return {
      state,
      networkId: operational ? "universal" : null,
      availableEfficiency: operational ? 1 : 0,
      operationalMultiplier: operational ? 1 : 0,
      role,
      powerCategory: part.powerCategory || null,
      priorityBand: null,
      networkIds: operational ? ["universal"] : [],
      requestedMw,
      allocatedMw: operational ? requestedMw : 0,
      unmetMw: operational ? 0 : requestedMw,
      generationAvailableMw: alive ? ratedGenerationMw : 0,
      generationUsedMw: 0,
      generationReductionReasons: [],
      storageDetails: undefined
    };
  });

  const powerSignature = byComponentIndex.map((entry) => [
    entry.state,
    entry.networkId || "",
    PowerAllocationRules.mwToPowerUnits(entry.allocatedMw),
    PowerAllocationRules.mwToPowerUnits(entry.requestedMw),
    entry.operationalMultiplier
  ].join(":")).join("|");
  if (ship._powerStateSignature !== powerSignature) {
    ship._powerStateSignature = powerSignature;
    ship.powerRevision = (ship.powerRevision || 0) + 1;
    ship.dirtyPower = true;
  }

  const demandMw = byComponentIndex.reduce((sum, entry) => sum + (entry.role === "consumer" ? entry.requestedMw : 0), 0);
  const allocatedMw = byComponentIndex.reduce((sum, entry) => sum + (entry.role === "consumer" ? entry.allocatedMw : 0), 0);
  const result = {
    byComponentIndex: byComponentIndex.map((entry, componentIndex) => ({ componentIndex, ...entry })),
    networks: [],
    sectionFlows: [],
    summary: {
      mode: "universal",
      availableGenerationMw: demandMw,
      demandMw,
      allocatedMw,
      unmetMw: Math.max(0, demandMw - allocatedMw),
      spareGenerationMw: 0
    }
  };
  ship.componentPower = { byComponentIndex };
  ship.powerFlow = result;
  ship.powerAnalysis = result;
  ship.powerStatus = summarizePower(byComponentIndex);
  ship._powerFlowSectionSignature = "";
  ensureShipCableThermalAnalysis(ship);
  if (!options.skipRuntimeStats && ship.alive !== false) require("./componentHealth").recalcEffectiveStats(ship);
  else if (ship.alive === false) { ship.maxShield = 0; ship.shield = 0; }
  if (!options.skipDataRefresh) require("./componentData").refreshShipDataAllocation(ship, "universal-power");
  return ship.componentPower;
}



function rebuildShipWiringState(ship, reason = "component-boundary", options = {}) {
  if (!WIRING_ENABLED) {
    const power = emptyRuntimeKind();
    const data = emptyRuntimeKind();
    const runtime = { power, data, powerNetworks: [], dataNetworks: [], reason: "wiring-disabled" };
    ship._runtimePowerWiring = {
      version: WiringRules.WIRING_VERSION,
      power: power.operationalWiring,
      data: data.operationalWiring,
      powerPolicy: PowerPolicyRules.clonePolicy(ship.wiring?.powerPolicy)
    };
    if (ship._wiringStateSignature !== "wiring-disabled") {
      ship._wiringStateSignature = "wiring-disabled";
      ship.wiringRevision = (ship.wiringRevision || 0) + 1;
    }
    ship.runtimeWiring = runtime;
    installUniversalPowerAllocation(ship, { ...options, skipDataRefresh: true });
    require("./componentData").rebuildShipDataTopology(ship, reason);
    return runtime;
  }
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
    power: power.operationalWiring,
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
  if (!ship.componentStorageCharge && Array.isArray(ship.design)) {
    ship.componentStorageCharge = ship.design.map((module) => {
      const part = PARTS[module?.type] || {};
      return Number(part.energyCapacity ?? part.energyStorage ?? part.energy) || 0;
    });
  }
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
    componentDemandByIndex: ship._activityDemandByIndex || undefined,
    componentStorageChargeByIndex: ship.componentStorageCharge || undefined,
    dt: ship.lastHeatTickDelta || 1.0
  };
}

function applyShipPowerAllocation(ship, options = {}) {
  if (!WIRING_ENABLED) return installUniversalPowerAllocation(ship, options);
  const design = Array.isArray(ship?.design) ? ship.design : [];
  // The shared solver is the sole allocation authority. An unexpected exception
  // must propagate so tests and server diagnostics expose the underlying defect,
  // and a malformed result is rejected outright — never silently fail-open to a
  // full-Power fallback that would grant live consumers full effectiveness. The
  // performance counter records the attempted solve before the call so a throw
  // is still counted.
  bump("powerFlowSolveCount");
  const result = PowerFlowRules.solvePowerFlow(buildShipPowerSolveBaseInput(ship));
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
      generationReductionReasons: entry.role === "source" ? sourceGenerationReductionReasons(ship, index, entry) : [],
      storageDetails: entry.storageDetails || undefined
    };
  });

  // Fixed-point Power-state signature: meaningful component state, canonical
  // network id and integer allocation units — never raw floating-point strings.
  const powerSignature = byComponentIndex.map((entry) => [
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

  // Update storage charge state & apply discharge heat
  if (Array.isArray(ship.design) && Array.isArray(result.byComponentIndex)) {
    if (!ship.componentStorageCharge) {
      ship.componentStorageCharge = ship.design.map((module) => {
        const part = PARTS[module?.type] || {};
        return Number(part.energyCapacity ?? part.energyStorage ?? part.energy) || 0;
      });
    }
    result.byComponentIndex.forEach((entry) => {
      if (entry.role === "storage" && entry.storageDetails) {
        const idx = entry.componentIndex;
        ship.componentStorageCharge[idx] = entry.storageDetails.currentChargeMj;
        if (entry.storageDetails.dischargeHeat > 0) {
          require("./heat").addComponentHeat(ship, idx, entry.storageDetails.dischargeHeat);
        }
      }
    });
  }

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
  if (!WIRING_ENABLED) {
    const design = Array.isArray(ship.design) ? ship.design : [];
    if (!ship.powerCableThermalAnalysis || ship.powerCableThermalAnalysis.mode !== "disabled") {
      ship.powerCableThermalAnalysis = {
        mode: "disabled",
        sections: [],
        components: [],
        summary: { totalPowerCableHeatPerSecond: 0, hottestSectionId: null }
      };
      ship.componentPowerCableHeatRate = design.map(() => 0);
      ship.powerCableHeatRate = 0;
      ship.powerCableThermalRevision = (ship.powerCableThermalRevision || 0) + 1;
    }
    return ship.powerCableThermalAnalysis;
  }
  const flowRevision = ship.powerFlowRevision || 0;
  if (ship.powerCableThermalAnalysis && ship._powerCableThermalFlowRevision === flowRevision) return ship.powerCableThermalAnalysis;
  const sectionFlows = ship.powerFlow && Array.isArray(ship.powerFlow.sectionFlows) ? ship.powerFlow.sectionFlows : [];
  const baseHostMap = shipHostMaps(ship).power;
  const bySectionId = new Map(baseHostMap.bySectionId);
  const occupant = new Map();
  (Array.isArray(ship.design) ? ship.design : []).forEach((moduleValue, index) => {
    WiringRules.moduleCells(moduleValue, PARTS).forEach((cell) => occupant.set(WiringRules.cellKey(cell.x, cell.y), index));
  });
  for (const flow of sectionFlows) {
    if (!flow.internal || bySectionId.has(flow.sectionId)) continue;
    const [a, b] = String(flow.sectionId).split(":");
    if (!a || !b) continue;
    const [x1, y1] = a.split(",").map(Number);
    const [x2, y2] = b.split(",").map(Number);
    const cells = [{ x: x1, y: y1 }, { x: x2, y: y2 }];
    const hostCells = cells.map((cell) => ({ x: cell.x, y: cell.y, componentIndex: occupant.get(WiringRules.cellKey(cell.x, cell.y)) ?? null }));
    if (hostCells.some((c) => c.componentIndex == null)) continue;
    bySectionId.set(flow.sectionId, {
      sectionId: flow.sectionId, kind: "power", tier: flow.tier,
      hostCells, uniqueComponentIndices: [...new Set(hostCells.map((c) => c.componentIndex))].sort((u, v) => u - v), valid: true
    });
  }
  const hostMap = { ...baseHostMap, bySectionId };
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
function decoyLauncherActivity(ship, index, now) {
  const launchers = ship.decoyLaunchers || [];
  const launcherMap = ship._decoyLauncherByComponentIndex;
  const launcher = launcherMap && launcherMap.has(index)
    ? launcherMap.get(index)
    : launchers.find((l) => l.componentIndex === index);
  if (!launcher) return 1; // pre-initialisation: request power so production can start
  if (launcher.pendingLaunch) return 1; // launch intent: need full nominal power
  if (launcher.stock < launcher.capacity) return 1; // producing
  if (ship._decoyThreatActive) return 0.3; // monitoring
  return 0; // idle standby
}
function propulsionActivity(ship, part, index, module) {
  const turn = clamp01(Math.abs(Number(ship.turnActivity) || 0));
  const movementPhase = ship.movement?.phase || "idle";
  const moving = movementPhase !== "idle" && movementPhase !== "positioned" ? 1 : 0;
  if (!(Number(part?.thrust) > 0)) return turn;
  return Math.max(turn, moving);
}
function shieldRechargeTarget(ship) {
  // Recharge intent must not use the current Power-dependent maxShield. Doing
  // so creates a feedback loop: active demand lowers the allocation ratio and
  // cap, the clamped shield then appears full, demand returns to standby, and
  // the cap rises again. Target the surviving, physically wired shield hardware
  // instead. A starved generator keeps requesting Power until the deficit is
  // genuinely gone.
  return ShieldRules.calculateShieldCapacityContributions(ship.design || [], PARTS, {
    isLive: (index) => {
      if ((ship.componentHp?.[index] ?? 1) <= 0) return false;
      if (ship.componentPowerState?.[index] === 0) return false;
      const entry = ship.componentPower?.byComponentIndex?.[index];
      return !entry || entry.state !== "disconnected";
    }
  }).reduce((sum, contribution) => sum + contribution.capacity, 0);
}
function shieldActivity(ship) {
  const maxShield = Number(ship.maxShield) || shieldRechargeTarget(ship);
  const current = Number(ship.shield) || 0;
  const tolerance = Math.max(0.01, maxShield * 0.0001);
  return maxShield > 0 && current < maxShield - tolerance ? 1 : 0;
}
function repairActivity(ship, now) {
  const last = ship._repairIntentAt;
  return Number.isFinite(last) && (now - last) < WEAPON_INTENT_HOLD_MS ? 1 : 0;
}
function coolingActivity(ship) { return clamp01(Number(ship.heatPressure) || 0); }

// `cache` memoises ship-wide activity terms for the duration of one demand
// pass. `shieldActivity` walks the whole design through
// `calculateShieldCapacityContributions`, so resolving it per shield component
// made a ship with N shield generators do N full design scans every tick.
// Nothing in the demand loop mutates the state it reads, so one evaluation per
// pass is equivalent.
function componentActivityLevel(ship, index, module, part, now, cache = null) {
  if (part.weapon) return weaponActivity(ship, index, now);
  if (module.type === "decoyLauncher") return decoyLauncherActivity(ship, index, now);
  switch (part.powerCategory) {
    case "propulsion": return propulsionActivity(ship, part, index, module);
    case "shields": {
      if (!cache) return shieldActivity(ship);
      if (cache.shieldActivity === undefined) cache.shieldActivity = shieldActivity(ship);
      return cache.shieldActivity;
    }
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
  if (!WIRING_ENABLED) return;
  bump("powerDemandTickCalls");
  const design = ship.design;
  const standby = BALANCE.powerDemand;
  // Consumer metadata is built once per design and reused, so large Blueprints
  // only scan components on creation/lifecycle changes, not every tick.
  if (!Array.isArray(ship._powerConsumerIndices)) {
    buildShipPowerConsumerMetadata(ship);
  }
  const consumerIndices = ship._powerConsumerIndices || [];
  const nominalByIndex = ship._powerDemandNominalByIndex || new Map();
  const demandByIndex = {};
  const activityCache = {};
  // Reuse per-ship scratch arrays to avoid allocating a new activity array
  // and demand object when nothing changed.
  if (!ship._powerDemandActivity || ship._powerDemandActivity.length !== design.length) {
    ship._powerDemandActivity = new Float64Array(design.length);
  }
  const activity = ship._powerDemandActivity;
  let units = ship._powerDemandUnits;
  if (!(units instanceof Float64Array) || units.length !== design.length) {
    units = ship._powerDemandUnits = new Float64Array(design.length);
  }
  units.fill(-1);
  activity.fill(0);
  for (let k = 0; k < consumerIndices.length; k += 1) {
    const i = consumerIndices[k];
    const module = design[i];
    const part = PARTS[module && module.type];
    if (!part) continue;
    bump("powerDemandComponentsVisited");
    const alive = (ship.componentHp?.[i] ?? 1) > 0;
    const level = alive ? clamp01(componentActivityLevel(ship, i, module, part, now, activityCache)) : 0;
    activity[i] = level;
    const requested = module.type === "droneBay"
      ? droneModule().bayPowerRequest(ship, i)
      : PowerDemandRules.requestedMwForComponent(part, level, standby);
    demandByIndex[i] = requested;
    units[i] = PowerAllocationRules.mwToPowerUnits(requested);
  }
  ship.componentPowerActivity = activity;
  const applied = ship._powerDemandAppliedUnits;
  if (applied instanceof Float64Array && applied.length === units.length) {
    let identical = true;
    for (let i = 0; i < units.length; i += 1) {
      if (units[i] !== applied[i]) { identical = false; break; }
    }
    if (identical) { ship.powerDemandDirty = false; bump("powerDemandSkippedClean"); return; }
  }

  const appliedActivity = ship._powerDemandAppliedActivity;
  const appliedDemand = ship._powerDemandAppliedByIndex || {};
  const validAppliedActivity = appliedActivity instanceof Float64Array
    && appliedActivity.length === design.length;
  let activatesConsumer = !validAppliedActivity;
  if (!activatesConsumer) {
    for (let k = 0; k < consumerIndices.length; k += 1) {
      const i = consumerIndices[k];
      const module = design[i];
      const part = PARTS[module && module.type];
      if (!part) continue;
      const previousLevel = Number(appliedActivity[i]) || 0;
      if (activity[i] > 0 && previousLevel <= 0) {
        activatesConsumer = true;
        break;
      }
      // Drone Bay demand also follows production/deployment state rather than
      // its generic activity level, so a rise in its requested MW is urgent.
      if (module.type === "droneBay"
        && PowerAllocationRules.mwToPowerUnits(demandByIndex[i]) > PowerAllocationRules.mwToPowerUnits(appliedDemand[i])) {
        activatesConsumer = true;
        break;
      }
    }
  }

  const lastSolvedAt = Number(ship._powerDemandLastSolvedAt);
  const elapsed = Number(now) - lastSolvedAt;
  const solveDue = !Number.isFinite(lastSolvedAt)
    || !Number.isFinite(elapsed)
    || elapsed < 0
    || elapsed + 1e-6 >= POWER_DEMAND_SOLVE_INTERVAL_MS;
  ship.powerDemandDirty = true;
  ship._activityDemandByIndex = demandByIndex;
  if (!activatesConsumer && !solveDue) {
    bump("powerDemandDeferredCount");
    return;
  }

  let appliedUnits = ship._powerDemandAppliedUnits;
  if (!(appliedUnits instanceof Float64Array) || appliedUnits.length !== units.length) {
    appliedUnits = ship._powerDemandAppliedUnits = new Float64Array(units.length);
  }
  appliedUnits.set(units);
  ship._powerDemandAppliedActivity = activity.slice();
  ship._powerDemandAppliedByIndex = { ...demandByIndex };
  ship._powerDemandLastSolvedAt = Number(now);
  ship.powerDemandRevision = (ship.powerDemandRevision || 0) + 1;
  bump("powerDemandSolveCount");
  reallocateShipPower(ship, "activity-demand", { skipRuntimeStats: true });
}

function buildShipPowerConsumerMetadata(ship) {
  const design = ship.design || [];
  const consumerIndices = [];
  const nominalByIndex = new Map();
  const categoryByIndex = new Map();
  const decoyLauncherMap = new Map();
  const launchers = ship.decoyLaunchers || [];
  if (Array.isArray(launchers)) {
    for (const launcher of launchers) {
      if (Number.isInteger(launcher?.componentIndex)) decoyLauncherMap.set(launcher.componentIndex, launcher);
    }
  }
  for (let i = 0; i < design.length; i += 1) {
    const module = design[i];
    const part = PARTS[module && module.type];
    if (!part || !(Number(part.powerUse) > 0)) continue;
    consumerIndices.push(i);
    nominalByIndex.set(i, PowerDemandRules.requestedMwForComponent(part, 0, BALANCE.powerDemand));
    if (part.powerCategory) categoryByIndex.set(i, part.powerCategory);
  }
  ship._powerConsumerIndices = consumerIndices;
  ship._powerDemandNominalByIndex = nominalByIndex;
  ship._powerDemandCategoryByIndex = categoryByIndex;
  ship._decoyLauncherByComponentIndex = decoyLauncherMap;
}

function initializeComponentPower(ship) {
  // Section 7G: spawned/replaced designs always begin from deterministic
  // zero overload stress. Runtime protection state is never persisted in
  // Blueprints, saved designs or loadouts, so it is rebuilt from nothing here.
  ship.componentStorageCharge = (ship.design || []).map((module) => {
    const part = PARTS[module?.type] || {};
    return Number(part.energyCapacity ?? part.energyStorage ?? part.energy) || 0;
  });
  buildShipPowerConsumerMetadata(ship);
  rebuildShipWiringState(ship, "initialization", { skipRuntimeStats: true });
  if (WIRING_ENABLED) {
    require("./powerProtection").resetShipPowerProtection(ship);
    require("./powerProtection").refreshShipPowerProtectionDiagnostics(ship);
  }
  return ship.componentPower;
}
function reallocateShipPower(ship, reason = "source-availability", options = {}) {
  // Source generation changed (destruction/overheat/recovery) but topology did
  // not — re-solve on the cached runtime wiring without re-deriving sections.
  if (!ship._runtimePowerWiring) return rebuildShipWiringState(ship, reason, options);
  return applyShipPowerAllocation(ship, options);
}

function getComponentPowerMultiplier(ship, componentIndex) {
  if ((ship?.componentHp?.[componentIndex] ?? 1) <= 0) return 0;
  if (ship?.componentPowerState?.[componentIndex] === 0) return 0;
  const value = ship?.componentPower?.byComponentIndex?.[componentIndex]?.operationalMultiplier;
  return clampNumber(Number.isFinite(value) ? value : 1, 0, 1);
}

function getShieldCapacityPowerMultiplier(ship, componentIndex) {
  if ((ship?.componentHp?.[componentIndex] ?? 1) <= 0) return 0;
  if (ship?.componentPowerState?.[componentIndex] === 0) return 0;
  if (!WIRING_ENABLED) return 1;
  const module = ship?.design?.[componentIndex];
  const part = PARTS[module?.type] || {};
  const entry = ship?.componentPower?.byComponentIndex?.[componentIndex];
  if (!entry) return getComponentPowerMultiplier(ship, componentIndex);
  if (entry.state === "disconnected") return 0;

  // Standby Power holds the field at its current capacity. Extra active Power
  // controls recharge speed, not the size of the field, so changing from
  // standby to recharge demand cannot make maxShield alternate every solve.
  const maintenanceMw = PowerDemandRules.requestedMwForComponent(part, 0, BALANCE.powerDemand);
  if (!(maintenanceMw > 0)) return 1;
  return clampNumber((Number(entry.allocatedMw) || 0) / maintenanceMw, 0, 1);
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
    powerMultiplier: (index) => getShieldCapacityPowerMultiplier(ship, index)
  });
}

function shieldStatsSignature(ship) {
  return [
    ship.powerRevision || 0,
    ship.wiringRevision || 0,
    ship.componentAliveRevision || 0,
    ship.heatStateRevision || 0,
    ship.designRevision || 1,
    getCommandAuraMultiplier(ship, "shieldRegenMultiplier")
  ].join(":");
}

function effectiveShieldStats(ship, room = null) {
  const signature = shieldStatsSignature(ship);
  const cache = ship?._shieldStatsCache;
  if (cache && cache.signature === signature) {
    if (room) {
      const { bump } = require("./roomTelemetry");
      bump(room, "shieldDerivedStatCacheHits");
    }
    return { ...cache.stats };
  }
  if (room) {
    const { bump } = require("./roomTelemetry");
    bump(room, "shieldDerivedStatCacheMisses");
    bump(room, "shieldDerivedStatCalculations");
  }
  const HeatRules = require("../../public/src/shared/heatRules");
  const stats = ShieldRules.calculateShieldStats(ship.design || [], PARTS, {
    isLive: (index) => (ship.componentHp?.[index] ?? 1) > 0,
    powerMultiplier: (index) => getComponentPowerMultiplier(ship, index),
    capacityPowerMultiplier: (index) => getShieldCapacityPowerMultiplier(ship, index),
    heatMultiplier: (index, module, part) => (Number(part.shieldRegen) || 0) > 0 ? HeatRules.activeOutputForState(ship.componentHeatState?.[index] || HeatRules.STATE.NORMAL) : 1
  });
  stats.recharge *= getCommandAuraMultiplier(ship, "shieldRegenMultiplier");
  if (ship) ship._shieldStatsCache = { signature, stats };
  return { ...stats };
}

function componentHostsWiring(ship, index) {
  if (!WIRING_ENABLED) return false;
  if (!Number.isInteger(index) || !ship) return false;
  const maps = shipHostMaps(ship);
  return (maps.power.byComponentIndex.get(index)?.length || 0) > 0 || (maps.data.byComponentIndex.get(index)?.length || 0) > 0;
}

module.exports = { initializeComponentPower, rebuildShipWiringState, reallocateShipPower, applyShipPowerAllocation, ensureShipCableThermalAnalysis, updateShipPowerDemand, getComponentPowerMultiplier, getShieldCapacityPowerMultiplier, effectiveLiveSourceGeneration, effectiveShieldStats, effectiveShieldCapacityContributions, componentHostsWiring, powerProtectionConfig, __setPowerProtectionConfigForTests, buildShipPowerSolveBaseInput };
