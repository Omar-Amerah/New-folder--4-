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
const { BALANCE } = require("./balanceConfig");
const { clampNumber } = require("./utils");
const ShieldRules = require("../../public/src/shared/shieldRules");

const SOURCE_TYPES = new Set(WiringRules.POWER_SOURCE_TYPES);
function isPowerSource(module) {
  return SOURCE_TYPES.has(module?.type) || (Number(PARTS[module?.type]?.powerGeneration) || 0) > 0;
}
const perf = () => global.__mfaDataSupportPerf || null;
function bump(name) { const p = perf(); if (p) p[name] = (p[name] || 0) + 1; }

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

function deriveRuntimeKind(ship, kind, hostMap) {
  const blueprint = ship.wiring?.[kind] || { sections: [], connections: [] };
  const operationalSectionIds = new Set();
  const disabledSectionIds = new Set();
  const sectionHosts = new Map();
  for (const section of blueprint.sections || []) {
    // Canonical host cells for this section come from the shared mapper; a null
    // host means the endpoint cell has no physical component (undefined here).
    const entry = hostMap.bySectionId.get(section.id);
    const hosts = [...new Set((entry ? entry.hostCells : WiringRules.sectionCells(section).map(() => ({ componentIndex: null })))
      .map((host) => (host.componentIndex == null ? undefined : host.componentIndex)))];
    sectionHosts.set(section.id, hosts);
    const operational = hosts.length > 0 && !hosts.includes(undefined)
      && hosts.every((index) => (ship.componentHp?.[index] ?? 1) > 0);
    (operational ? operationalSectionIds : disabledSectionIds).add(section.id);
  }

  const operationalConnectionIds = new Set();
  const brokenConnectionIds = new Set();
  const operationalConnections = [];
  for (const connection of blueprint.connections || []) {
    const id = WiringRules.connectionKey(connection);
    const sourceAlive = (ship.componentHp?.[connection.sourceIndex] ?? 0) > 0;
    const targetAlive = (ship.componentHp?.[connection.targetIndex] ?? 0) > 0;
    // The blueprint has already passed Wiring v2 role, terminal and chain
    // validation. Retaining its exact ordered section list preserves those
    // guarantees; health can only remove a section or endpoint.
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
  return { operationalSectionIds, disabledSectionIds, operationalConnectionIds, brokenConnectionIds, sectionHosts, operationalWiring };
}

function stateSignature(runtime) {
  const values = [];
  for (const kind of ["power", "data"]) {
    values.push(kind, ...[...runtime[kind].operationalSectionIds].sort(), "|", ...[...runtime[kind].operationalConnectionIds].sort(), ";");
  }
  return values.join(",");
}

function rebuildShipWiringState(ship, reason = "component-boundary", options = {}) {
  const design = Array.isArray(ship?.design) ? ship.design : [];
  bump("wiringNormalizationCount");
  const hostMaps = shipHostMaps(ship);
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
function applyShipPowerAllocation(ship, options = {}) {
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
  const componentDemandByIndex = ship._activityDemandByIndex || undefined;
  // The shared solver is the sole allocation authority. An unexpected exception
  // must propagate so tests and server diagnostics expose the underlying defect,
  // and a malformed result is rejected outright — never silently fail-open to a
  // full-Power fallback that would grant live consumers full effectiveness. The
  // performance counter records the attempted solve before the call so a throw
  // is still counted.
  bump("powerFlowSolveCount");
  const result = PowerFlowRules.solvePowerFlow({
    design,
    wiring: runtimePowerWiring,
    catalogue: PARTS,
    infrastructure: BALANCE.wiringInfrastructure,
    sourceGenerationByIndex,
    componentOperationalByIndex,
    componentDemandByIndex
  });
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
      generationUsedMw: entry.generationUsedMw
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
  const sectionFlows = ship.powerFlow && Array.isArray(ship.powerFlow.sectionFlows) ? ship.powerFlow.sectionFlows : [];
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

function initializeComponentPower(ship) { rebuildShipWiringState(ship, "initialization", { skipRuntimeStats: true }); return ship.componentPower; }
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

module.exports = { initializeComponentPower, rebuildShipWiringState, reallocateShipPower, applyShipPowerAllocation, ensureShipCableThermalAnalysis, updateShipPowerDemand, getComponentPowerMultiplier, effectiveLiveSourceGeneration, effectiveShieldStats, effectiveShieldCapacityContributions };
