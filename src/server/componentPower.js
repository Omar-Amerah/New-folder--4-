// Damage-aware, event-driven runtime Power/Data wiring state. ship.wiring is
// always the immutable normalized blueprint; all battle damage lives here.

const { PARTS } = require("./components");
const { analyzeShipPower } = require("./shipDesign");
const WiringRules = require("../../public/src/shared/wiringRules");
const WiringInfrastructureRules = require("../../public/src/shared/wiringInfrastructureRules.js");
const { clampNumber } = require("./utils");
const ShieldRules = require("../../public/src/shared/shieldRules");

const SOURCE_TYPES = new Set(WiringRules.POWER_SOURCE_TYPES);
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
  const runtimeWiring = { version: WiringRules.WIRING_VERSION, power: power.operationalWiring, data: data.operationalWiring };
  let analysis;
  bump("powerAnalysisCount");
  try { analysis = analyzeShipPower(design, runtimeWiring); } catch (_) { analysis = { networks: [] }; }
  let dataAnalysis;
  bump("wiringAnalysisCount");
  try { dataAnalysis = WiringRules.analyzeWiring(design, runtimeWiring, PARTS).data; } catch (_) { dataAnalysis = { networks: [] }; }
  const runtimeNetworks = (analysis.networks || []).map(network => ({ ...network }));
  const runtime = { power, data, powerNetworks: runtimeNetworks, dataNetworks: dataAnalysis.networks || [], reason };
  const wiringSignature = stateSignature(runtime);
  if (ship._wiringStateSignature !== wiringSignature) {
    ship._wiringStateSignature = wiringSignature;
    ship.wiringRevision = (ship.wiringRevision || 0) + 1;
  }

  ship.runtimeWiring = runtime;
  ship.powerAnalysis = analysis;
  applyShipPowerAllocation(ship, { ...options, skipDataRefresh: true });
  // Section 6C ordering: surviving Wiring topology is projected first, then
  // component Power is allocated, then Data-support source multipliers read
  // the fresh per-component Power state during a topology rebuild/allocation.
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

function applyShipPowerAllocation(ship, options = {}) {
  const design = Array.isArray(ship?.design) ? ship.design : [];
  const runtimeNetworks = ship.runtimeWiring?.powerNetworks || [];
  const membership = new Map();
  for (const network of runtimeNetworks) {
    const generation = (network.sourceIndices || []).reduce((sum, index) => sum + effectiveLiveSourceGeneration(ship, index), 0);
    const demand = Math.max(0, Number(network.demandMw) || 0);
    const efficiency = demand <= 0 ? 1 : clampNumber(generation / demand, 0, 1);
    network.availableGenerationMw = generation;
    network.liveDemandMw = demand;
    network.runtimeLoadRatio = generation > 0 ? clampNumber(demand / generation, 0, 1) : 0;
    for (const index of [...(network.consumerIndices || []), ...(network.sourceIndices || [])])
      if (!membership.has(index)) membership.set(index, { network, generation, efficiency });
  }
  const byComponentIndex = design.map((module, index) => {
    const part = PARTS[module.type] || {};
    const alive = (ship.componentHp?.[index] ?? 1) > 0;
    const source = SOURCE_TYPES.has(module.type) || (Number(part.powerGeneration) || 0) > 0;
    const consumer = !source && (Number(part.powerUse) || 0) > 0;
    const member = membership.get(index);
    let state = "passive", multiplier = 1;
    if (!alive) { state = "destroyed"; multiplier = 0; }
    else if (source) state = "source";
    else if (consumer && !member) { state = "disconnected"; multiplier = 0; }
    else if (consumer && member.generation <= 0) { state = "unpowered"; multiplier = 0; }
    else if (consumer && member.efficiency < 1) { state = "underpowered"; multiplier = member.efficiency; }
    else if (consumer) state = "powered";
    return { state, networkId: member?.network?.id ?? null, availableEfficiency: clampNumber(member?.efficiency ?? (consumer ? 0 : 1), 0, 1), operationalMultiplier: clampNumber(multiplier, 0, 1) };
  });
  const powerSignature = byComponentIndex.map((entry) => `${entry.state}:${entry.networkId}:${entry.operationalMultiplier}`).join("|");
  if (ship._powerStateSignature !== powerSignature) {
    ship._powerStateSignature = powerSignature;
    ship.powerRevision = (ship.powerRevision || 0) + 1;
    ship.dirtyPower = true;
  }
  ship.componentPower = { byComponentIndex };
  ship.powerStatus = summarizePower(byComponentIndex);

  if (!options.skipRuntimeStats && ship.alive !== false) require("./componentHealth").recalcEffectiveStats(ship);
  else if (ship.alive === false) { ship.maxShield = 0; ship.shield = 0; }
  if (!options.skipDataRefresh) require("./componentData").refreshShipDataAllocation(ship, "power-allocation");
  return ship.componentPower;
}

function initializeComponentPower(ship) { rebuildShipWiringState(ship, "initialization", { skipRuntimeStats: true }); return ship.componentPower; }
function reallocateShipPower(ship, reason = "source-availability") {
  if (!ship.runtimeWiring?.powerNetworks) return rebuildShipWiringState(ship, reason);
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

module.exports = { initializeComponentPower, rebuildShipWiringState, reallocateShipPower, applyShipPowerAllocation, getComponentPowerMultiplier, effectiveLiveSourceGeneration, effectiveShieldStats, effectiveShieldCapacityContributions };
